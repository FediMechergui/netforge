/**
 * timeline/lanes.ts — which timeline lane a trace event belongs to (ARCHITECTURE-P2 §2.13, §3.13 step 1) [SHOULD S1].
 *
 * The worker's lane index (apps/web bridge/worker/lanes.ts, W4) calls `laneOf` on every drained event, before the
 * batch cap, and stores `(t, cursor, lane)` in typed arrays; `LANE_INDEX` gives each lane its small integer for those
 * arrays. The mapping is the binding one of §3.13:
 *
 * - `linkState`, `portState` → `link`;
 * - `debug` whose `event.fsm` is set (`ctx.transition`, D19) → the lane of its machine (`FSM_MACHINE_LANES`); a debug
 *   event without `fsm` is in no lane (P0/P1 daemons never set it, so their debug lines never reach a lane);
 * - `tableWrite` / `tableExpire` by table (`TABLE_LANES`): stp and stp-bridge → `stp`, etherchannel → `etherchannel`,
 *   vlans and dtp → `vlan`, hsrp → `fhrp`, rib and rib6 → `routing`, nat → `nat`, dhcp-bindings and dhcpv6-bindings →
 *   `dhcp`, capwap* and dot11-assoc → `wireless`, port-security → `security`; every other table (cam, arp, nd,
 *   sockets, dns-cache) is in no lane;
 * - `configChange` → `config`;
 * - `drop` → `drops` (a background drop too: the event carries `background: true`, and the caller decides whether a
 *   background drop is counted — the lane itself does not change);
 * - every other kind → `undefined`.
 *
 * Resolved ambiguity: `wlan-clients` (the controller's client rows, written by capwap-ac) is not literally a
 * `capwap*` name, but it is the controller-side twin of `dot11-assoc`, so it is in the `wireless` lane too.
 *
 * Pure: no state, no clock, no rng, no allocation. The tables are plain frozen literals (§0 rule 12: no module-scope
 * read of another module), and a `Record<…>` type makes a new machine or lane a compile error here.
 */
import type { FsmMachine } from '../contracts/process.js';
import type { ExtraTableName } from '../contracts/tables.js';
import type { LaneId } from '../contracts/timeline.js';
import type { TraceEvent } from '../contracts/trace.js';

/**
 * Every lane with a stable small integer (the worker's typed lane index). Canonical order = the order of the `LaneId`
 * union. Exhaustive: a new lane is a compile error until it has a number.
 */
export const LANE_INDEX: Readonly<Record<LaneId, number>> = Object.freeze({
  link: 0,
  stp: 1,
  etherchannel: 2,
  vlan: 3,
  fhrp: 4,
  routing: 5,
  nat: 6,
  dhcp: 7,
  wireless: 8,
  security: 9,
  config: 10,
  drops: 11,
});

/** Every lane in canonical order (`LANE_IDS[LANE_INDEX[l]] === l`). */
export const LANE_IDS: readonly LaneId[] = Object.freeze([
  'link',
  'stp',
  'etherchannel',
  'vlan',
  'fhrp',
  'routing',
  'nat',
  'dhcp',
  'wireless',
  'security',
  'config',
  'drops',
] as const);

/** The lane of every state machine that reports through `ctx.transition` (exhaustive over `FsmMachine`). */
export const FSM_MACHINE_LANES: Readonly<Record<FsmMachine, LaneId>> = Object.freeze({
  'stp-port': 'stp',
  'stp-bridge': 'stp',
  dtp: 'vlan',
  lacp: 'etherchannel',
  channel: 'etherchannel',
  'port-security': 'security',
  'err-disable': 'security',
  nat: 'nat',
  dhcpv6: 'dhcp',
  'capwap-wtp': 'wireless',
  'capwap-ac': 'wireless',
  hsrp: 'fhrp',
  pagp: 'etherchannel',
});

/** The lane of every table whose writes and expiries are timeline activity; tables not listed are in no lane. */
export const TABLE_LANES: Readonly<Partial<Record<'cam' | 'arp' | 'rib' | ExtraTableName, LaneId>>> = Object.freeze({
  rib: 'routing',
  rib6: 'routing',
  'dhcp-bindings': 'dhcp',
  'dot11-assoc': 'wireless',
  vlans: 'vlan',
  dtp: 'vlan',
  stp: 'stp',
  'stp-bridge': 'stp',
  etherchannel: 'etherchannel',
  'port-security': 'security',
  nat: 'nat',
  'dhcpv6-bindings': 'dhcp',
  capwap: 'wireless',
  'capwap-aps': 'wireless',
  'wlan-clients': 'wireless',
  hsrp: 'fhrp',
});

/** The lane of a table name (`undefined` for tables that are not timeline activity, and for unknown names). */
export function laneOfTable(table: string): LaneId | undefined {
  return Object.prototype.hasOwnProperty.call(TABLE_LANES, table)
    ? (TABLE_LANES as Readonly<Record<string, LaneId>>)[table]
    : undefined;
}

/** The lane of a state machine (`undefined` for a name outside `FsmMachine`). */
export function laneOfMachine(machine: string): LaneId | undefined {
  return Object.prototype.hasOwnProperty.call(FSM_MACHINE_LANES, machine)
    ? (FSM_MACHINE_LANES as Readonly<Record<string, LaneId>>)[machine]
    : undefined;
}

/** The timeline lane of one trace event, or `undefined` when the event is in no lane (§3.13 step 1). */
export function laneOf(ev: TraceEvent): LaneId | undefined {
  switch (ev.kind) {
    case 'linkState':
    case 'portState':
      return 'link';
    case 'debug': {
      const fsm = ev.event.fsm;
      return fsm === undefined ? undefined : laneOfMachine(fsm.machine);
    }
    case 'tableWrite':
    case 'tableExpire':
      return laneOfTable(ev.table);
    case 'configChange':
      return 'config';
    case 'drop':
      return 'drops';
    default:
      return undefined;
  }
}
