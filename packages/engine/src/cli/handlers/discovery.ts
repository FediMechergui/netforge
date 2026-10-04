/**
 * cli/handlers/discovery.ts — CDP and LLDP lines (ARCHITECTURE-P3 §5.5, D2, D18; §7 W2 cli part 1).
 *
 * The lines are stored as the W1 config rules say: `cdp run` and `cdp enable` are `bothForms` slots (each form stored
 * as typed, so `no cdp run` survives export and reload in a P3 world where CDP runs by default, and `cdp run` typed in
 * a P2 world works, D2); `cdp advertise-v2`, `lldp transmit` and `lldp receive` are stored negations (only the `no`
 * form is stored); the timers are single slots whose `no` form restores the default. The daemons read them. Every
 * string is original wording (spec §1.6).
 *
 * W3 (cli part 2, §5.8) — the shows. Settings come from the configuration through the daemons' own pure readers
 * (`cdpRunning`, `cdpTimerS`, … in protocols/cdp.ts and protocols/lldp.ts), so a show says exactly what the daemon
 * applies; neighbours from the `cdp-neighbours` / `lldp-neighbours` rows (rule 20; the hold time left is `expiresAt` −
 * now); the counters of `show cdp|lldp traffic` from the daemon's StateView (`sent`, `received`, `errors`; display only,
 * zeros while the daemon does not run). `clear cdp|lldp table` empties the table through `device.clearTable` (reason
 * `cleared`); the neighbours come back with their next announcement. `clear cdp counters` (ruling R39) asks the cdp
 * daemon to zero its counters (`cdp.clearCounters`).
 */
import { PORT_FAMILIES } from '../../contracts/catalog.js';
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { CdpNeighbourRow, LldpNeighbourRow } from '../../contracts/tables.js';
import { SEC, type SimTime } from '../../contracts/time.js';
import { CDP_PROCESS, cdpAdvertisesV2, cdpHoldtimeS, cdpPortEnabled, cdpRunning, cdpTimerS, discoveryPortEligible } from '../../protocols/cdp.js';
import { lldpHoldtimeS, lldpPortReceives, lldpPortTransmits, lldpReinitS, lldpRunning, lldpTimerS } from '../../protocols/lldp.js';
import { table } from '../format.js';
import { DISCOVERY_DETAIL_ARG, DISCOVERY_ENTRY_ALL, DISCOVERY_FORM_ARG, DISCOVERY_HANDLERS } from '../grammar/discovery.js';
import { globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** @since P3 `show cdp …` while CDP is off on the device (the daemon's drop detail, protocols/cdp.ts `CDP_DETAIL_OFF`). */
export const MSG_CDP_OFF = 'CDP is off on this device.';
/** @since P3 `show lldp …` while LLDP is off on the device. */
export const MSG_LLDP_OFF = 'LLDP is off on this device.';
/** @since P3 The legend above `show cdp neighbors`. */
export const CDP_CAPABILITY_LEGEND = 'Capability codes: R router, S switch, I IGMP snooping, H host';
/** @since P3 The legend above `show lldp neighbors` (the IEEE capability letters). */
export const LLDP_CAPABILITY_LEGEND = 'Capability codes: R router, B bridge, T telephone, C cable device, W WLAN access point, P repeater, S station, O other';
/** @since P3 The line between two neighbour blocks of the detailed forms. */
export const DISCOVERY_ENTRY_SEPARATOR = '-------------------------';
/** @since P3 `show cdp|lldp entry <name>` naming no neighbour. */
export const MSG_NO_ENTRY = (proto: 'CDP' | 'LLDP', name: string): string => `No ${proto} neighbour is named "${name}".`;
/** @since P3 `show cdp|lldp neighbors|interface <if>` on a port that takes no part in discovery (D18). */
export const MSG_NOT_DISCOVERY_PORT = (port: string): string => `${port} takes no part in neighbour discovery (Ethernet ports only).`;

/** `[no] cdp run`, `cdp timer|holdtime <s>`, `[no] cdp advertise-v2`. */
const configCdp: CommandHandler = (ctx, args, negate) => {
  const form = args[DISCOVERY_FORM_ARG] ?? '';
  if (form === 'timer' || form === 'holdtime') {
    if (negate) return outcomeOf(ctx.config(['cdp', form], true, globalContext()));
    return outcomeOf(ctx.config(['cdp', form, args['seconds'] ?? ''], false, globalContext()));
  }
  return outcomeOf(ctx.config(['cdp', form], negate, globalContext()));
};

/** `cdp enable` / `no cdp enable` on an Ethernet interface. */
const ifCdpEnable: CommandHandler = (ctx, _args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['cdp', 'enable'], negate));
};

/** `lldp run`, `lldp timer|holdtime|reinit <s>` and their `no` forms. */
const configLldp: CommandHandler = (ctx, args, negate) => {
  const form = args[DISCOVERY_FORM_ARG] ?? '';
  if (form === 'run') return outcomeOf(ctx.config(['lldp', 'run'], negate, globalContext()));
  if (negate) return outcomeOf(ctx.config(['lldp', form], true, globalContext()));
  return outcomeOf(ctx.config(['lldp', form, args['seconds'] ?? ''], false, globalContext()));
};

/** `[no] lldp transmit`, `[no] lldp receive` on an Ethernet interface. */
const ifLldp: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['lldp', args[DISCOVERY_FORM_ARG] ?? ''], negate));
};

// ── shows (W3) ───────────────────────────────────────────────────────────────────────────────────────────────

/** A daemon's counters from its StateView (display only; protocols/cdp.ts and protocols/lldp.ts `stateSnapshot`). */
function counters(ctx: CommandCtx, process: 'cdp' | 'lldp'): { sent: number; received: number; errors: number } {
  const state = ctx.processState(process)?.state ?? {};
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { sent: n(state['sent']), received: n(state['received']), errors: n(state['errors']) };
}

/** The short form of a port name (`Gi0/1`): the device's own spec, else the port family's letters, else the name. */
function shortPort(ctx: CommandCtx, port: string): string {
  const view = ctx.ports.get(port);
  if (view?.spec.short !== undefined) return view.spec.short;
  const m = /^([A-Za-z-]+)(\d.*)$/.exec(port);
  const family = m === null ? undefined : PORT_FAMILIES.find((f) => f.long === m[1]);
  return family === undefined || m === null ? port : `${family.short}${m[2] ?? ''}`;
}

/** Canonical port order of this device. */
function portOrder(ctx: CommandCtx): Map<PortId, number> {
  const out = new Map<PortId, number>();
  let i = 0;
  for (const id of ctx.ports.keys()) out.set(id, i++);
  return out;
}

/** Seconds left before a neighbour row ages out (its advertised hold time when the row has no expiry). */
function holdLeft(expiresAt: SimTime | undefined, fallbackS: number, now: SimTime): number {
  return expiresAt === undefined ? fallbackS : Math.max(0, Math.floor((expiresAt - now) / SEC));
}

/** Rows of a neighbour table (absent table = none), by local port in canonical order, then by `name`. */
function neighbourRows<R extends { localPort: PortId }>(ctx: CommandCtx, name: 'cdp-neighbours' | 'lldp-neighbours', nameOf: (r: R) => string): R[] {
  const order = portOrder(ctx);
  const rows = (ctx.tables.get(name)?.rows() ?? []) as unknown as R[];
  return [...rows].sort((a, b) => (order.get(a.localPort) ?? 1e9) - (order.get(b.localPort) ?? 1e9) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
}

/** The port a typed interface names, or an error outcome (unknown name, or a port that takes no part, D18). */
function discoveryPortArg(ctx: CommandCtx, name: string | undefined): { port?: PortId; error?: string; output?: string } {
  if (name === undefined || name === '') return {};
  const port = ctx.ports.has(name) ? name : ctx.resolvePort(name);
  const view = port === undefined ? undefined : ctx.ports.get(port);
  if (port === undefined || view === undefined) return { error: `% No interface named "${name}" exists on this device.` };
  if (!discoveryPortEligible(ctx.model, view)) return { output: MSG_NOT_DISCOVERY_PORT(port) };
  return { port };
}

/** `<port> is up, line protocol is up` (original wording). */
function portStatus(view: PortView): string {
  const state = !view.adminUp ? 'administratively down' : view.operUp ? 'up' : 'down';
  return `${view.id} is ${state}, line protocol is ${view.operUp ? 'up' : 'down'}`;
}

/** The discovery ports of this device (canonical order), or only `port`. */
function discoveryViews(ctx: CommandCtx, port: PortId | undefined): PortView[] {
  const out: PortView[] = [];
  for (const v of ctx.ports.values()) if ((port === undefined || v.id === port) && discoveryPortEligible(ctx.model, v)) out.push(v);
  return out;
}

const cdpOn = (ctx: CommandCtx): boolean => cdpRunning(ctx.running, ctx.profile ?? 'P1', ctx.model);

/** `show cdp`. */
const showCdp: CommandHandler = (ctx) => {
  if (!cdpOn(ctx)) return { output: MSG_CDP_OFF };
  return {
    output: [
      'CDP is on',
      `  Announcements every ${cdpTimerS(ctx.running)} s, holdtime ${cdpHoldtimeS(ctx.running)} s`,
      `  Version 2 announcements: ${cdpAdvertisesV2(ctx.running) ? 'on' : 'off (version 1 is sent)'}`,
    ].join('\n'),
  };
};

/** One detailed CDP neighbour (`… neighbors detail`, `show cdp entry`). */
function cdpBlock(ctx: CommandCtx, r: CdpNeighbourRow): string {
  const lines = [
    DISCOVERY_ENTRY_SEPARATOR,
    `Device ID: ${r.deviceId}`,
    `  Addresses: ${r.addresses === '' ? 'none' : r.addresses}`,
    `  Platform: ${r.platform === '' ? 'unknown' : r.platform}, capabilities: ${r.capabilities === '' ? 'none' : r.capabilities}`,
    `  Interface: ${r.localPort}, port ID (its outgoing port): ${r.remotePort}`,
    `  Holdtime: ${holdLeft(r.expiresAt, r.holdtimeS, ctx.now)} s`,
    `  Software: ${r.version === '' ? 'unknown' : r.version}`,
    `  CDP version: ${r.cdpVersion}`,
  ];
  if (r.nativeVlan !== undefined) lines.push(`  Native VLAN: ${r.nativeVlan}`);
  if (r.duplex !== undefined) lines.push(`  Duplex: ${r.duplex}`);
  return lines.join('\n');
}

/** `show cdp neighbors [<if>] [detail]`. */
const showCdpNeighbors: CommandHandler = (ctx, args) => {
  if (!cdpOn(ctx)) return { output: MSG_CDP_OFF };
  const want = discoveryPortArg(ctx, args['iface']);
  if (want.error !== undefined) return { error: want.error };
  if (want.output !== undefined) return { output: want.output };
  const rows = neighbourRows<CdpNeighbourRow>(ctx, 'cdp-neighbours', (r) => r.deviceId).filter((r) => want.port === undefined || r.localPort === want.port);
  const total = `Total: ${rows.length} neighbour${rows.length === 1 ? '' : 's'}`;
  if (args[DISCOVERY_DETAIL_ARG] !== undefined) return { output: [...rows.map((r) => cdpBlock(ctx, r)), '', total].join('\n') };
  const out: string[][] = [['Device ID', 'Local interface', 'Holdtime (s)', 'Capability', 'Platform', 'Port ID']];
  for (const r of rows) {
    out.push([r.deviceId, shortPort(ctx, r.localPort), String(holdLeft(r.expiresAt, r.holdtimeS, ctx.now)), r.capabilities, r.platform, shortPort(ctx, r.remotePort)]);
  }
  return { output: [CDP_CAPABILITY_LEGEND, '', table(out, { gap: 2, minWidths: [15] }), '', total].join('\n') };
};

/** `show cdp entry <name|*>`. */
const showCdpEntry: CommandHandler = (ctx, args) => {
  if (!cdpOn(ctx)) return { output: MSG_CDP_OFF };
  const name = args['name'] ?? '';
  const rows = neighbourRows<CdpNeighbourRow>(ctx, 'cdp-neighbours', (r) => r.deviceId).filter((r) => name === DISCOVERY_ENTRY_ALL || r.deviceId === name);
  if (rows.length === 0) return { output: MSG_NO_ENTRY('CDP', name) };
  return { output: rows.map((r) => cdpBlock(ctx, r)).join('\n') };
};

/** `show cdp interface [<if>]`. */
const showCdpInterface: CommandHandler = (ctx, args) => {
  if (!cdpOn(ctx)) return { output: MSG_CDP_OFF };
  const want = discoveryPortArg(ctx, args['iface']);
  if (want.error !== undefined) return { error: want.error };
  if (want.output !== undefined) return { output: want.output };
  const views = discoveryViews(ctx, want.port);
  if (views.length === 0) return { output: 'No interface takes part in CDP.' };
  const timers = `announcements every ${cdpTimerS(ctx.running)} s, holdtime ${cdpHoldtimeS(ctx.running)} s`;
  const blocks = views.map((v) => `${portStatus(v)}\n  CDP: ${cdpPortEnabled(ctx.running, v.id) ? `on; ${timers}` : 'off on this interface (no cdp enable)'}`);
  return { output: blocks.join('\n') };
};

/** `show cdp traffic`. */
const showCdpTraffic: CommandHandler = (ctx) => {
  const c = counters(ctx, 'cdp');
  return { output: ['CDP counters', `  Announcements sent: ${c.sent}`, `  Announcements received: ${c.received}`, `  Errors: ${c.errors}`].join('\n') };
};

/** `clear cdp table`: every neighbour row goes (reason `cleared`); they come back with their next announcement. */
const clearCdpTable: CommandHandler = (ctx) => {
  ctx.device.clearTable('cdp-neighbours');
  return {};
};

/** `clear cdp counters` (ruling R39): the cdp daemon zeroes the counters `show cdp traffic` prints (`cdp.clearCounters`). */
const clearCdpCounters: CommandHandler = (ctx) => {
  if (ctx.model.processes.includes(CDP_PROCESS)) ctx.request(CDP_PROCESS, { kind: 'cdp.clearCounters' });
  return {};
};

/** `show lldp`. */
const showLldp: CommandHandler = (ctx) => {
  if (!lldpRunning(ctx.running)) return { output: MSG_LLDP_OFF };
  return {
    output: [
      'LLDP is on',
      `  Announcements every ${lldpTimerS(ctx.running)} s, holdtime ${lldpHoldtimeS(ctx.running)} s, restart delay ${lldpReinitS(ctx.running)} s`,
    ].join('\n'),
  };
};

/** The name an LLDP neighbour goes by: its system name, else its chassis id. */
const lldpName = (r: LldpNeighbourRow): string => r.systemName ?? r.chassisId;

/** One detailed LLDP neighbour (`… neighbors detail`, `show lldp entry`). */
function lldpBlock(ctx: CommandCtx, r: LldpNeighbourRow): string {
  const lines = [DISCOVERY_ENTRY_SEPARATOR, `Chassis ID: ${r.chassisId}`, `  Port ID: ${r.portId}`];
  if (r.portDescription !== undefined) lines.push(`  Port description: ${r.portDescription}`);
  lines.push(`  System name: ${r.systemName ?? 'not sent'}`);
  if (r.systemDescription !== undefined) lines.push(`  System description: ${r.systemDescription}`);
  lines.push(`  Capabilities: ${r.capabilities ?? 'not sent'}${r.enabled === undefined ? '' : `; enabled: ${r.enabled}`}`);
  lines.push(`  Management address: ${r.mgmtAddress ?? 'not sent'}`);
  lines.push(`  Local interface: ${r.localPort}, hold time left ${holdLeft(r.expiresAt, r.ttlS, ctx.now)} s`);
  return lines.join('\n');
}

/** `show lldp neighbors [<if>] [detail]`. */
const showLldpNeighbors: CommandHandler = (ctx, args) => {
  if (!lldpRunning(ctx.running)) return { output: MSG_LLDP_OFF };
  const want = discoveryPortArg(ctx, args['iface']);
  if (want.error !== undefined) return { error: want.error };
  if (want.output !== undefined) return { output: want.output };
  const rows = neighbourRows<LldpNeighbourRow>(ctx, 'lldp-neighbours', lldpName).filter((r) => want.port === undefined || r.localPort === want.port);
  const total = `Total: ${rows.length} neighbour${rows.length === 1 ? '' : 's'}`;
  if (args[DISCOVERY_DETAIL_ARG] !== undefined) return { output: [...rows.map((r) => lldpBlock(ctx, r)), '', total].join('\n') };
  const out: string[][] = [['Device ID', 'Local interface', 'Hold time (s)', 'Capability', 'Port ID']];
  for (const r of rows) {
    out.push([lldpName(r), shortPort(ctx, r.localPort), String(holdLeft(r.expiresAt, r.ttlS, ctx.now)), r.enabled ?? r.capabilities ?? '-', shortPort(ctx, r.portId)]);
  }
  return { output: [LLDP_CAPABILITY_LEGEND, '', table(out, { gap: 2, minWidths: [15] }), '', total].join('\n') };
};

/** `show lldp entry <name|*>`: by system name or chassis id. */
const showLldpEntry: CommandHandler = (ctx, args) => {
  if (!lldpRunning(ctx.running)) return { output: MSG_LLDP_OFF };
  const name = args['name'] ?? '';
  const rows = neighbourRows<LldpNeighbourRow>(ctx, 'lldp-neighbours', lldpName).filter(
    (r) => name === DISCOVERY_ENTRY_ALL || r.systemName === name || r.chassisId === name,
  );
  if (rows.length === 0) return { output: MSG_NO_ENTRY('LLDP', name) };
  return { output: rows.map((r) => lldpBlock(ctx, r)).join('\n') };
};

/** `show lldp interface [<if>]`. */
const showLldpInterface: CommandHandler = (ctx, args) => {
  if (!lldpRunning(ctx.running)) return { output: MSG_LLDP_OFF };
  const want = discoveryPortArg(ctx, args['iface']);
  if (want.error !== undefined) return { error: want.error };
  if (want.output !== undefined) return { output: want.output };
  const views = discoveryViews(ctx, want.port);
  if (views.length === 0) return { output: 'No interface takes part in LLDP.' };
  const onOff = (b: boolean): string => (b ? 'on' : 'off');
  const blocks = views.map((v) => `${portStatus(v)}\n  LLDP transmit: ${onOff(lldpPortTransmits(ctx.running, v.id))}, receive: ${onOff(lldpPortReceives(ctx.running, v.id))}`);
  return { output: blocks.join('\n') };
};

/** `show lldp traffic`. */
const showLldpTraffic: CommandHandler = (ctx) => {
  const c = counters(ctx, 'lldp');
  return { output: ['LLDP counters', `  Frames sent: ${c.sent}`, `  Frames received: ${c.received}`, `  Errors: ${c.errors}`].join('\n') };
};

/** `clear lldp table`. */
const clearLldpTable: CommandHandler = (ctx) => {
  ctx.device.clearTable('lldp-neighbours');
  return {};
};

/** @since P3 Registry fragment: the CDP and LLDP lines (`DISCOVERY_HANDLERS` ids). */
export const discoveryHandlers: Readonly<Record<string, CommandHandler>> = {
  [DISCOVERY_HANDLERS.configCdp]: configCdp,
  [DISCOVERY_HANDLERS.ifCdpEnable]: ifCdpEnable,
  [DISCOVERY_HANDLERS.configLldp]: configLldp,
  [DISCOVERY_HANDLERS.ifLldp]: ifLldp,
  // W3 cli part 2
  [DISCOVERY_HANDLERS.showCdp]: showCdp,
  [DISCOVERY_HANDLERS.showCdpNeighbors]: showCdpNeighbors,
  [DISCOVERY_HANDLERS.showCdpEntry]: showCdpEntry,
  [DISCOVERY_HANDLERS.showCdpInterface]: showCdpInterface,
  [DISCOVERY_HANDLERS.showCdpTraffic]: showCdpTraffic,
  [DISCOVERY_HANDLERS.execClearCdpTable]: clearCdpTable,
  [DISCOVERY_HANDLERS.execClearCdpCounters]: clearCdpCounters,
  [DISCOVERY_HANDLERS.showLldp]: showLldp,
  [DISCOVERY_HANDLERS.showLldpNeighbors]: showLldpNeighbors,
  [DISCOVERY_HANDLERS.showLldpEntry]: showLldpEntry,
  [DISCOVERY_HANDLERS.showLldpInterface]: showLldpInterface,
  [DISCOVERY_HANDLERS.showLldpTraffic]: showLldpTraffic,
  [DISCOVERY_HANDLERS.execClearLldpTable]: clearLldpTable,
};
