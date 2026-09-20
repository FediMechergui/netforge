/**
 * protocols/host.ts — host-side glue for end devices and management-only devices (PCs, laptops, servers, APs,
 * L2 switches through their management SVI).
 *
 * Implements the ARCHITECTURE "Config flow" ownership rule for the global `ip default-gateway <gw>` line (spec §2.1
 * "ARP for default gateway", §4.8 process model) on top of the P1 RIB arbitration (ARCHITECTURE-P1 §4.2): the line
 * becomes a candidate static default route that ipv4 installs by administrative distance, so the ipv4 daemon's
 * longest-prefix match sends off-subnet traffic to the gateway and `arp.sendVia` then resolves the gateway's MAC
 * like any other next hop.
 *
 *  • `set`  `['ip','default-gateway',GW]` at context `[]` → request `ipv4.route {op:'offer', owner:'host'}` of
 *    `{ key:'0.0.0.0/0', network:'0.0.0.0', prefixLen:0, source:'S', nextHop:GW, ad:1, metric:0, isDefault:true,
 *    owner:'host' }`. `owner` lets ipv4 render the provenance cause `ip default-gateway GW` without looking at the
 *    device kind. With AD 1 it beats a DHCP-learned default (`D`, AD 254); withdrawing it restores that default.
 *  • `unset` → request `ipv4.route {op:'withdraw'}` for the same key; a default route offered by someone else
 *    (`ip route 0.0.0.0 0.0.0.0 …`, a DHCP lease) is left alone.
 *  • Only while the device does not route (`!model.ipForwarding`): a routing device keeps the line in its
 *    configuration but offers nothing (its default route comes from `ip route`).
 *
 * ipv4 answers each offer or withdrawal with the ProcessEvent `ext.ipv4.route` (protocols/ipv4.ts
 * `RouteDecisionEvent`); this daemon logs the outcome, after the RIB write.
 *
 * The daemon never receives frames, never emits `setPortL3` (that is ipv4's job) and keeps no state beyond the
 * configured gateway.
 *
 * StateView: `{ process: 'host', state: { defaultGateway: string | null } }`.
 * Debug category: `ip routing`.
 */
import { isIpv4 } from '../contracts/addr.js';
import type { Ipv4Address } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { routeKey } from '../contracts/tables.js';
import type { RouteRow } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { ROUTE_DECISION_EVENT, routeCause, type RouteDecisionEvent } from './ipv4.js';

const CATEGORY = 'ip routing';
const DEBUG_RING = 64;
/** Process name; also the `RouteRow.owner` of the default route this daemon offers. */
export const HOST_PROCESS = 'host';
/** RIB key of the default route offered by this daemon. */
export const DEFAULT_ROUTE_KEY = routeKey('0.0.0.0', 0);

/** The default-route candidate for gateway `gw`, stamped `now`. */
export function defaultGatewayRow(gw: Ipv4Address, now: number): RouteRow {
  return {
    key: DEFAULT_ROUTE_KEY,
    network: '0.0.0.0',
    prefixLen: 0,
    source: 'S',
    nextHop: gw,
    ad: 1,
    metric: 0,
    isDefault: true,
    updatedAt: now,
    owner: HOST_PROCESS,
  };
}

/** Narrow a ProcessEvent to an ipv4 route decision for this daemon's key. */
function isRouteDecision(ev: ProcessEvent): ev is ProcessEvent & RouteDecisionEvent {
  return ev.kind === ROUTE_DECISION_EVENT && (ev as { key?: unknown }).key === DEFAULT_ROUTE_KEY;
}

/** The host daemon (`Process` with name `'host'`), one instance per device. */
export function createHost(): Process {
  const debugRing: DebugEvent[] = [];
  let defaultGateway: Ipv4Address | null = null;
  /** The candidate currently offered to ipv4 (null when none). */
  let offered: Ipv4Address | null = null;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: 'host', category: CATEGORY, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: 'host', category: CATEGORY, message };
    debugRing.push(ev);
    if (debugRing.length > DEBUG_RING) debugRing.splice(0, debugRing.length - DEBUG_RING);
    ctx.debug(CATEGORY, message, data);
  }

  function isOurs(delta: ConfigDelta): boolean {
    return delta.context.length === 0 && delta.line[0] === 'ip' && delta.line[1] === 'default-gateway';
  }

  function setGateway(ctx: ProcessCtx, gw: Ipv4Address): Action[] {
    defaultGateway = gw;
    if (ctx.model.ipForwarding) {
      debug(ctx, `default gateway ${gw} stored; not used while this device routes`, { gateway: gw });
      return [];
    }
    offered = gw;
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.route', op: 'offer', row: defaultGatewayRow(gw, ctx.now), owner: HOST_PROCESS } }];
  }

  function clearGateway(ctx: ProcessCtx): Action[] {
    defaultGateway = null;
    if (offered === null) {
      debug(ctx, 'default gateway removed (no default route was installed)');
      return [];
    }
    const gw = offered;
    offered = null;
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.route', op: 'withdraw', row: defaultGatewayRow(gw, ctx.now), owner: HOST_PROCESS } }];
  }

  /** Log what ipv4 decided about our candidate (after the RIB write, so the trace reads write → reason). */
  function onDecision(ctx: ProcessCtx, ev: RouteDecisionEvent): void {
    const previous = ev.previous;
    const current = ev.current;
    if (ev.op === 'offer') {
      const gw = current?.owner === HOST_PROCESS ? current.nextHop : offered;
      if (!ev.installed) {
        debug(ctx, `default gateway ${gw ?? '?'} kept as a candidate: ${current !== undefined ? routeCause(current) : 'another route'} is preferred`, {
          gateway: gw ?? null,
          installed: current?.nextHop ?? null,
        });
      } else if (previous?.nextHop !== undefined && previous.nextHop !== gw) {
        debug(ctx, `default gateway changed from ${previous.nextHop} to ${gw ?? '?'}`, { gateway: gw, previous: previous.nextHop });
      } else {
        debug(ctx, `default gateway set to ${gw ?? '?'}: default route installed`, { gateway: gw });
      }
      return;
    }
    if (ev.wasInstalled) {
      debug(ctx, `default gateway removed: default route via ${previous?.nextHop ?? '?'} withdrawn`, { previous: previous?.nextHop ?? null });
      if (current !== undefined) {
        debug(ctx, `default route now ${routeCause(current)}`, { route: current.key, source: current.source, nextHop: current.nextHop ?? null });
      }
    } else {
      debug(ctx, 'default gateway removed (no default route was installed)');
    }
  }

  return {
    name: 'host',

    onPdu(_ctx: ProcessCtx, _pdu: Pdu, _port: PortId): Action[] {
      return [];
    },

    onTimer(_ctx: ProcessCtx, _key: string): Action[] {
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (!isOurs(delta)) return [];
      if (delta.op === 'unset') return clearGateway(ctx);
      const gw = delta.line[2];
      if (gw === undefined || !isIpv4(gw)) {
        debug(ctx, `ignoring default gateway "${gw ?? ''}": not a valid address`, { gateway: gw ?? null });
        return [];
      }
      return setGateway(ctx, gw);
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (isRouteDecision(ev)) onDecision(ctx, ev);
      return [];
    },

    stateSnapshot(): StateView {
      return { process: 'host', state: { defaultGateway } };
    },

    debugEvents(): readonly DebugEvent[] {
      return debugRing;
    },
  };
}
