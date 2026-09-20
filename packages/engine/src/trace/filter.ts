/**
 * trace/filter.ts — the one predicate behind `TraceFilter` (contracts/simulation.ts): run-control breakpoints
 * (`RunOptions.stopOn`, `stepToNext`), `traceQuery` pages and the worker's sim-mode list (ARCHITECTURE-P1 §4.11).
 *
 * Semantics:
 * - Every PRESENT key must match (AND). An array key matches when ANY member matches (OR); a present empty array
 *   therefore matches nothing. `undefined` keys are ignored.
 * - `kinds`: `event.kind`.
 * - `protos`: any of `PduSummary.layers`, or `[PduSummary.proto]` when `layers` is absent. Events without a
 *   PduSummary (`frameTx`, `frameRx`, `drop`, `pduCreated`, `pduConsumed`, `frameAbort` carry one) never match.
 * - `devices`: every device the event refers to — `device` fields, `debug.event.device`, `mutation.mutation.device`,
 *   the device of every PortRef
 *   (`frameTx`/`frameAbort` from/to, `assocState` station/ap, `rfState` port/peer, `collision` stations,
 *   `segmentChanged` members) and the subject of `topologyChanged` device/module events (module id
 *   `${deviceId}/${slotId}`).
 * - `links`: link or medium ids — `frameTx`/`frameAbort`/`linkState`/`phyNegotiated` `link`, `drop` `link` and
 *   `medium`, `collision`/`segmentChanged` `segment`, `assocState` `medium`, `topologyChanged` link events.
 * - `ports`: every (device, port) pair the event refers to — PortRef fields as above, plus `device`+`port` pairs
 *   (`frameRx`, `drop` when both are set, `portState`, `backoff`, `carrierDefer`).
 * - `tables`: `tableWrite`/`tableExpire` `table`.
 * - `tags`: `PduSummary.tag`, exact string equality.
 * - `includeBackground`: unless it is `true`, a `frameTx` flagged `background` never matches (keepalives, beacons),
 *   whatever the other keys say.
 *
 * Pure: no allocation beyond small per-call arrays, no state, no clock, no rng. The filter is structured-clone
 * data, so identical filters give identical results on both sides of the worker boundary.
 */
import type { DeviceId, PortRef } from '../contracts/ids.js';
import type { ProtoName } from '../contracts/pdu.js';
import type { TraceFilter } from '../contracts/simulation.js';
import type { PduSummary, TraceEvent } from '../contracts/trace.js';

/** The PduSummary an event carries, if any. */
function pduOf(ev: TraceEvent): PduSummary | undefined {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
    case 'frameAbort':
      return ev.pdu;
    default:
      return undefined;
  }
}

/** Every PortRef an event refers to, in field order. */
function portsOf(ev: TraceEvent): PortRef[] {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameAbort':
      return [ev.from, ev.to];
    case 'frameRx':
    case 'portState':
    case 'backoff':
    case 'carrierDefer':
      return [{ device: ev.device, port: ev.port }];
    case 'drop':
      return ev.device !== undefined && ev.port !== undefined ? [{ device: ev.device, port: ev.port }] : [];
    case 'assocState':
      return ev.ap !== undefined ? [ev.station, ev.ap] : [ev.station];
    case 'rfState':
      return [ev.port, ev.peer];
    case 'collision':
      return ev.stations;
    case 'segmentChanged':
      return ev.members;
    default:
      return [];
  }
}

/** Every link or medium id an event refers to. */
function linksOf(ev: TraceEvent): string[] {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameAbort':
    case 'linkState':
    case 'phyNegotiated':
      return [ev.link];
    case 'drop': {
      const out: string[] = [];
      if (ev.link !== undefined) out.push(ev.link);
      if (ev.medium !== undefined) out.push(ev.medium);
      return out;
    }
    case 'collision':
    case 'segmentChanged':
      return [ev.segment];
    case 'assocState':
      return [ev.medium];
    case 'topologyChanged':
      return ev.what === 'link' ? [ev.id] : [];
    default:
      return [];
  }
}

/** True when the event refers to `device` through a device field, the debug payload, a PortRef or a topology id. */
function refersToDevice(ev: TraceEvent, device: DeviceId): boolean {
  switch (ev.kind) {
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
    case 'tableWrite':
    case 'tableExpire':
    case 'log':
    case 'portState':
    case 'deviceState':
    case 'configChange':
    case 'backoff':
    case 'carrierDefer':
      if (ev.device === device) return true;
      break;
    case 'debug':
      return ev.event.device === device;
    case 'mutation':
      return ev.mutation.device === device;
    case 'topologyChanged':
      if (ev.what === 'device') return ev.id === device;
      if (ev.what === 'module') return ev.id.startsWith(`${device}/`);
      return false;
    default:
      break;
  }
  const refs = portsOf(ev);
  for (let i = 0; i < refs.length; i++) {
    if (refs[i]!.device === device) return true;
  }
  return false;
}

/** Protocol names a PduSummary exposes to `protos`: its layer stack, else its summary proto. */
function protosOf(pdu: PduSummary): readonly ProtoName[] {
  return pdu.layers !== undefined ? pdu.layers : [pdu.proto];
}

/**
 * Whether `ev` satisfies `filter` (see the module header for the per-key rules). Present keys AND together, array
 * members OR together, and a background `frameTx` is excluded unless `includeBackground` is `true`.
 */
export function matchesTraceFilter(filter: TraceFilter, ev: TraceEvent): boolean {
  if (ev.kind === 'frameTx' && ev.background === true && filter.includeBackground !== true) return false;

  if (filter.kinds !== undefined && !filter.kinds.includes(ev.kind)) return false;

  if (filter.tables !== undefined) {
    if (ev.kind !== 'tableWrite' && ev.kind !== 'tableExpire') return false;
    if (!filter.tables.includes(ev.table)) return false;
  }

  if (filter.protos !== undefined || filter.tags !== undefined) {
    const pdu = pduOf(ev);
    if (pdu === undefined) return false;
    if (filter.protos !== undefined) {
      const have = protosOf(pdu);
      const wanted = filter.protos;
      if (!have.some((p) => wanted.includes(p))) return false;
    }
    if (filter.tags !== undefined && (pdu.tag === undefined || !filter.tags.includes(pdu.tag))) return false;
  }

  if (filter.devices !== undefined) {
    const devices = filter.devices;
    if (!devices.some((d) => refersToDevice(ev, d))) return false;
  }

  if (filter.links !== undefined) {
    const wanted = filter.links;
    if (!linksOf(ev).some((l) => wanted.includes(l))) return false;
  }

  if (filter.ports !== undefined) {
    const wanted = filter.ports;
    const refs = portsOf(ev);
    if (!refs.some((r) => wanted.some((w) => w.device === r.device && w.port === r.port))) return false;
  }

  return true;
}
