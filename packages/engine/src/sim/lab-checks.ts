/**
 * sim/lab-checks.ts — the lab grader (ARCHITECTURE-P1 §4.13; ARCHITECTURE-P2 §2.10, §3.8 step 7, §11.2;
 * contracts/scenario.ts `EvaluateLab`, `LabAssertion`).
 *
 * `evaluateLab(sim, lab)` scores every task of a `ScenarioInfo` against STRUCTURED state — never scraped console
 * text. One task passes when every one of its assertions passes; a task that passes earns its points, a task that
 * fails earns none.
 *
 * Assertion kinds and what they read:
 *   config       → `DeviceRuntime.running.query(path)` (dotted ConfigAst path), then `exists` / `equals` / `contains`;
 *   port         → the live `PortState` (operUp, adminUp, ipv4, ipv6, duplex, speedBps, role; P2 errDisabled);
 *   table        → `DeviceRuntime.tables.get(name)`, rows filtered by `where` (field-by-field, text-compared; P2: a
 *                  value of a column whose TABLE_DESCRIPTORS format is 'port' is first resolved through the device's
 *                  port-name resolver, so `Gi0/1` matches `GigabitEthernet0/1`);
 *   process      → `Process.stateSnapshot().state` addressed by a dotted path whose array step is an index
 *                  (`a.b.0.c`) or a `field=value` selector (`clients.iface=Wlan0.state`) picking the first matching
 *                  element — use the selector whenever list order depends on what the student did;
 *   link         → the link between two device NAMES, optionally its media and `up`;
 *   counter      → a `PortCounters` field compared with gt / eq / lt (an absent P0.5 counter reads 0);
 *   traceSeen    → `Simulation.traceQuery` over the retained ring with the assertion's TraceFilter;
 *   connectivity → a ping in a DISPOSABLE CLONE (see below).
 *
 * P2 kinds (§2.10; devices and ports by NAME, a port name resolves like the 'port' kind — long or short form):
 *   vlan         → existence: VLAN 1 and 1002–1005 always, else a `vlans` row or a `vlan <v>` section (the rule of
 *                  `show vlan`); `name`: the fixed name of an implicit VLAN, else the row's name, else the section's
 *                  `name` line, else `VLAN0010`; `accessPorts`: the ports `show vlan brief` lists for the VLAN (switched
 *                  ports and Port-channels operating as access whose access or voice VLAN is it), compared with
 *                  `match` 'includes' (default: every named port is listed) or 'exactly' (the same set).
 *                  `exists` defaults to true; `exists: false` passes when the VLAN does not exist and checks nothing else.
 *   switchport   → `readSwitchport` on the running config (mode, access/voice/native VLAN), `oper` = 'down' while the
 *                  port is not operationally up, else the operating mode (`operOf` / `channelOperOf` over the dtp
 *                  rows, as the snapshot's `PortL2View.oper`); `allowedVlans` is set equality with the ACTIVE list =
 *                  the allowed list ∩ the VLANs that exist (1, 1002–1005 and the `vlans` rows — the list `show
 *                  interfaces trunk` prints as allowed and existing, so a trunk that allows everything also carries
 *                  1002–1005), read whatever the oper mode. A port that is not a switch port (role other than
 *                  switched / channel) fails.
 *   stp          → the `stp-bridge` row of the VLAN (absent → fails: spanning tree does not run for it): `root` =
 *                  isRoot, `mode`, `rootBridge` = the device (by name) whose own bridge id for that VLAN is this
 *                  row's root id; `port` with `role` / `state` / `edge` reads that port's `stp` row (a port with no
 *                  row takes no part in that VLAN's tree and fails). role/state/edge without `port` fail.
 *   etherchannel → the `etherchannel` rows of the group (none → fails): `protocol` of every member, `up` = the oper
 *                  state of the group's Port-channel, `bundled` = each named member is in state 'bundled' (inclusion,
 *                  other members may be bundled too), `minBundled` = at least that many members bundled.
 *   portSecurity → `enabled`, `violation`, `max` and `stickyMac` from the running config (`readPortSecurity`, the
 *                  reader eth-switch uses); `status` and `minViolations` from the port's `port-security` row.
 *                  `stickyMac` is a MAC in any notation or the NAME of a device (any MAC of its ports matches), so a
 *                  lab never hard-codes a derived MAC. Any field but `enabled` fails while port security is off.
 *   route        → the longest-prefix winner for `destination` in `rib` (family 4, default) or `rib6` (family 6),
 *                  `core/lpm*.ts` order; `none: true` passes only when there is no winner, `none: false` only when
 *                  there is one. `network` is `a.b.c.d/len` (or the network address alone); `nextHop` and `iface`
 *                  also match any equal-cost path [S6]; `iface` (a port name) is the EXIT interface: the row's own,
 *                  else the one its next hop is reached through (the next hop's longest match, followed recursively
 *                  at most 8 deep, as forwarding does), so a next-hop static and an exit-interface static both
 *                  answer; `source`, `ad` compare the row. Addresses may be written in any valid form.
 *   nat          → the `nat` rows matching every given field (`kindOf` is the row's `kind`); `minCount` → at least
 *                  that many; otherwise `exists` (default true) → some row matches (or none, when false).
 *   fhrp [S2]    → the `hsrp` row of (iface, group): `state`, `virtualIp`, `priority`, `preempt`.
 *   port.errDisabled → `equals: true` any cause, `false` not err-disabled, a string = exactly that cause.
 *
 * The live simulation is never disturbed: nothing here advances its clock, emits trace or draws its rng. Reads are
 * plain property reads, pure readers and `traceQuery` (which only pages the ring).
 *
 * Scheduled faults (P2 §11.2, W5 fix). While a fault of `lab.faults` is still ahead of the live clock (`at > now`: the
 * worker's activation check at t = 0, an automatic check in the minute before a hidden change lands, a time-machine
 * seek back before it), the world is the healthy one the faults are about to break, and grading it would award marks
 * nobody earned. Every task then fails with the one detail LAB_PREPARING_DETAIL (on its first assertion; the others
 * fail without a detail, so a panel lists the reason once), and nothing is read or cloned.
 *
 * Connectivity clones. A clone is `createSimulation({seed: sim.seed, catalog: sim.catalog})` +
 * `loadTopology(sim.exportTopology())` with the live world's RUNTIME L1 state re-applied as faults at t = 0 — every
 * cut cable (`cable-cut`) and every err-disabled port (`err-disable` with the live cause, §3.8 step 7) — then settled
 * with `runToIdle`, which waits for boots, forward delay, TC windows, LACP and HSRP elections (§4.2). A port that
 * does not exist at t = 0 (a virtual port the boot creates) is err-disabled right after that first settle, and the
 * clone settles again. The clone takes the live world's catalog, so a world built on a test catalog is copied
 * faithfully; its journal is off (a clone is never replayed).
 *   • ONE clone per distinct `connectivity.after` fault set: the assertions without `after` share the base clone; an
 *     `after` set (faults resolved by name in the live world to link / device / port ids, deduplicated and sorted,
 *     with its `settleMs`) gets its own clone: settled, the faults applied at the settled instant (a `shutdown` as
 *     the `shutdown` line through the device's config path; a cut and a power-off as `cable-cut` / `power-loss`
 *     faults), then run for `settleMs` (default 60 000 ms) before the ping. `settleMs` only applies with faults.
 *   • `cut {a, b}` cuts every cable that joins the two devices; `powerOff` powers the device off; `shutdown` shuts
 *     the port. A fault that names nothing in the live world fails the assertion before any clone is built.
 *   • `then`: static assertions evaluated in the SAME clone right after the ping (for example the NAT rows the ping
 *     created), only when the ping met its expectation; the first failing one fails the connectivity assertion with
 *     its detail. A connectivity assertion inside `then` is refused.
 * Pings of one clone run one after another in assertion order, so a later ping starts where the earlier left it.
 * Job counts are sampled from the icmpv4 / icmpv6 StateView while the job runs AND reconciled afterwards with the
 * daemon's structured completion record, because the reply that completes a job arrives in the dispatch that deletes
 * it. `expect:'success'` needs at least one reply; `expect:'fail'` needs none. `byName` pings a DNS name, which the
 * icmpv4 job resolves through dns-client.
 *
 * The `to` of a connectivity check is matched by NAME in the live world but its address is read INSIDE the clone:
 * the clone replays DHCP from t=0, so a lease the live world gave one host can land on another there. In a fault
 * clone a target the faults left without an address (powered off) is pinged at the address it held just before
 * the faults. A target that turns out to be the pinging host's own address fails with an original detail instead of
 * counting its own reply.
 *
 * Devices, ports and tables are addressed by NAME. An unknown one never throws: the assertion fails with an original
 * detail saying what could not be found, and so does any error raised while reading state.
 *
 * ponytail: clones are built lazily and kept for the whole `evaluateLab` call (a lab rarely has more than two fault
 * sets); `byName` is IPv4 only, because the icmpv6 job takes an address — a name check with `family: 6` fails with an
 * original detail instead of pretending to resolve. `ScenarioInfo.customChecks` is not run here: no LabTask
 * references one and LabStatus has nowhere to report it.
 */
import { normalizeMac, parseIpv4, u32ToIpv4 } from '../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../contracts/config.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { FaultSpec } from '../contracts/events.js';
import type { DeviceId, LinkId, PortId } from '../contracts/ids.js';
import type { PortCounters, PortState } from '../contracts/port.js';
import type { EvaluateLab, LabAssertion, LabCheckResult, LabFault, LabStatus, ScenarioInfo } from '../contracts/scenario.js';
import type { Simulation } from '../contracts/simulation.js';
import {
  TABLE_DESCRIPTORS,
  type DtpRow,
  type EtherchannelRow,
  type HsrpRow,
  type NatRow,
  type PortSecurityRow,
  type Route6Row,
  type RouteRow,
  type StpBridgeRow,
  type StpPortRow,
  type TableDescriptor,
  type TableName,
  type TableRow,
  type VlanRow,
} from '../contracts/tables.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import type { Topology } from '../contracts/topology.js';
import { IMPLICIT_VLAN_NAMES, defaultVlanName } from '../cli/handlers/vlan.js';
import { normalizeIpv6 } from '../core/addr6.js';
import { lpm } from '../core/lpm.js';
import { lpm6Rows } from '../core/lpm6.js';
import { formatVlanList, vlanListIntersect } from '../core/vlan-list.js';
import { channelOperOf, isImplicitVlan, operOf, type L2OperMode } from '../protocols/l2/membership.js';
import { readPortSecurity } from '../protocols/l2/port-security.js';
import { readSwitchport, switchportModeText } from '../protocols/l2/switchport-config.js';
import { SIM_PROCESS_NAME, createSimulation } from './simulation.js';

/** Echo requests one connectivity check sends (two, so a single lost probe is not a verdict). */
export const LAB_PING_COUNT = 2;

/** Default per-echo timeout of a connectivity check in milliseconds (`LabAssertion.timeoutMs` overrides it). */
export const LAB_PING_TIMEOUT_MS = 2000;

/** Datagram size of a connectivity echo request, matching the CLI `ping`. */
export const LAB_PING_SIZE_BYTES = 100;

/** Events the disposable clone may dispatch while it boots and settles. */
export const LAB_CLONE_BOOT_EVENTS = 200_000;

/** Events one connectivity ping may dispatch in the clone. */
export const LAB_PING_MAX_EVENTS = 200_000;

/** Clone time a connectivity check allows on top of the ping's own timeouts (ARP, SLAAC, a name lookup). */
export const LAB_PING_SETTLE_NS: SimTime = 10 * SEC;

/** @since P2 Clone time after `connectivity.after` faults when the assertion gives no `settleMs` (§2.10). */
export const LAB_AFTER_SETTLE_MS = 60_000;

/** @since P2 Events a fault clone may dispatch while it runs `settleMs` after its faults. */
export const LAB_AFTER_SETTLE_EVENTS = 200_000;

/** @since P2 The detail of every task while a scheduled fault of the lab has not landed yet (file header). */
export const LAB_PREPARING_DETAIL = 'This lab is still being prepared; check again in a moment.';

/** Result of one assertion. */
interface Check {
  pass: boolean;
  detail?: string;
}

const PASS: Check = { pass: true };
const fail = (detail: string): Check => ({ pass: false, detail });

/** A device by topology name. */
function deviceNamed(sim: Simulation, name: string): DeviceRuntime | undefined {
  for (const d of sim.devices()) if (d.spec.name === name) return d;
  return undefined;
}

/** A port by long or short name. */
function portNamed(dev: DeviceRuntime, name: string): PortState | undefined {
  const direct = dev.port(name);
  if (direct !== undefined) return direct;
  const r = dev.resolvePortName(name);
  return r.kind === 'existing' ? dev.port(r.port) : undefined;
}

/** Compare two values the way a lab author writes them: identical, or the same text. */
function sameValue(actual: unknown, expected: unknown): boolean {
  return actual === expected || (actual !== undefined && actual !== null && String(actual) === String(expected));
}

/** `["10.0.0.1","255.255.255.0"]` rendered the way an author would type it. */
const nodeText = (n: ConfigNode): string => [n.key, ...n.args].join(' ');

const noDevice = (name: string): Check => fail(`There is no device called ${name} in this topology.`);
const noPort = (device: string, port: string): Check => fail(`${device} has no interface called ${port}.`);

/** Rows of an optional table, in insertion order (none when the device keeps no such table). */
function rowsOf<R extends TableRow>(dev: DeviceRuntime, table: TableName): R[] {
  return dev.tables.get<R>(table)?.rows() ?? [];
}

/** One failure detail from the problems found for `subject` (joined in the order they were found). */
function verdict(subject: string, problems: readonly string[]): Check {
  return problems.length === 0 ? PASS : fail(`${subject} ${problems.join('; ')}.`);
}

// ── static assertions ────────────────────────────────────────────────────────

function checkConfig(sim: Simulation, a: Extract<LabAssertion, { kind: 'config' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const nodes = dev.running.query(a.path);
  if (a.exists !== undefined) {
    if (nodes.length > 0 === a.exists) return PASS;
    return fail(a.exists ? `${a.device} has no configuration line at ${a.path}.` : `${a.device} still has a configuration line at ${a.path}.`);
  }
  if (nodes.length === 0) return fail(`${a.device} has no configuration line at ${a.path}.`);
  if (a.equals !== undefined) {
    const want = typeof a.equals === 'string' ? a.equals : a.equals.join(' ');
    for (const n of nodes) if (n.args.join(' ') === want) return PASS;
    return fail(`${a.device} ${a.path} is "${nodes.map((n) => n.args.join(' ')).join('" / "')}", expected "${want}".`);
  }
  if (a.contains !== undefined) {
    for (const n of nodes) if (nodeText(n).includes(a.contains)) return PASS;
    return fail(`No line at ${a.device} ${a.path} contains "${a.contains}".`);
  }
  return PASS;
}

function checkPort(sim: Simulation, a: Extract<LabAssertion, { kind: 'port' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  switch (a.field) {
    case 'ipv4': {
      const v4 = port.l3.ipv4;
      if (v4 === undefined) return fail(`${a.device} ${a.port} has no IPv4 address.`);
      if (sameValue(v4.address, a.equals) || `${v4.address}/${v4.prefixLen}` === String(a.equals)) return PASS;
      return fail(`${a.device} ${a.port} has ${v4.address}/${v4.prefixLen}, expected ${String(a.equals)}.`);
    }
    case 'ipv6': {
      const list = port.l3.ipv6 ?? [];
      for (const v6 of list) if (sameValue(v6.address, a.equals) || `${v6.address}/${v6.prefixLen}` === String(a.equals)) return PASS;
      const have = list.length === 0 ? 'no IPv6 address' : list.map((v6) => `${v6.address}/${v6.prefixLen}`).join(', ');
      return fail(`${a.device} ${a.port} has ${have}, expected ${String(a.equals)}.`);
    }
    case 'errDisabled': {
      // P2: true = err-disabled for any cause, false = not err-disabled, a string = exactly that cause
      const cause = port.errDisabled;
      const pass = a.equals === true ? cause !== undefined : a.equals === false ? cause === undefined : cause !== undefined && String(cause) === String(a.equals);
      if (pass) return PASS;
      if (cause === undefined) {
        return fail(`${a.device} ${a.port} is not err-disabled, expected it to be${a.equals === true ? '' : ` (${String(a.equals)})`}.`);
      }
      return fail(`${a.device} ${a.port} is err-disabled (${cause}), expected ${a.equals === false ? 'it to be working' : String(a.equals)}.`);
    }
    default: {
      const actual = port[a.field];
      if (sameValue(actual, a.equals)) return PASS;
      return fail(`${a.device} ${a.port} ${a.field} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
    }
  }
}

/** Columns of `table` whose descriptor format is 'port' (P2 `where` normalisation). */
function portColumnsOf(table: TableName): ReadonlySet<string> {
  const descriptors = TABLE_DESCRIPTORS as Readonly<Record<string, TableDescriptor>>;
  const d = Object.prototype.hasOwnProperty.call(descriptors, table) ? descriptors[table] : undefined;
  return new Set((d?.columns ?? []).filter((c) => c.format === 'port').map((c) => c.key));
}

/** The canonical id a port name stands for on `dev` (an unknown name is kept as written, so it simply matches nothing). */
function canonicalPortName(dev: DeviceRuntime, name: string): string {
  if (dev.port(name) !== undefined) return name;
  const r = dev.resolvePortName(name);
  return r.kind === 'existing' || r.kind === 'virtual' ? r.port : name;
}

function checkTable(sim: Simulation, a: Extract<LabAssertion, { kind: 'table' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const table = dev.tables.get(a.table);
  if (table === undefined) return fail(`${a.device} keeps no ${a.table} table (it has ${dev.tables.names().join(', ')}).`);
  // P2 (§11.2): a value of a 'port' column is compared in its canonical form (Gi0/1 matches GigabitEthernet0/1)
  const ports = portColumnsOf(a.table);
  const where = Object.entries(a.where).map(([k, v]): [string, unknown] => [k, ports.has(k) && typeof v === 'string' ? canonicalPortName(dev, v) : v]);
  const matches = table.find((row: TableRow) => {
    const r = row as unknown as Record<string, unknown>;
    for (const [k, v] of where) if (!sameValue(r[k], v)) return false;
    return true;
  });
  const text = Object.entries(a.where).map(([k, v]) => `${k}=${String(v)}`).join(' ');
  if (matches.length > 0 === a.exists) return PASS;
  return fail(a.exists ? `The ${a.table} table of ${a.device} has no row with ${text}.` : `The ${a.table} table of ${a.device} still has a row with ${text}.`);
}

/**
 * Walk a dotted path through a StateView's `state`. An array step is either an index (`a.b.0.c`) or a
 * `field=value` selector (`clients.iface=Wlan0.state`) picking the FIRST element whose `field` text-compares equal —
 * which is how a lab addresses one entry of a list whose order depends on what the student did. The value may not
 * contain a dot, because the path is split on dots.
 */
function readPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const step of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const eq = step.indexOf('=');
      if (eq > 0) {
        const field = step.slice(0, eq);
        const want = step.slice(eq + 1);
        cur = (cur as unknown[]).find((e) => e !== null && typeof e === 'object' && sameValue((e as Record<string, unknown>)[field], want));
        continue;
      }
      const i = Number(step);
      cur = Number.isInteger(i) ? cur[i] : undefined;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

function checkProcess(sim: Simulation, a: Extract<LabAssertion, { kind: 'process' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const proc = dev.processes.get(a.process);
  if (proc === undefined) return fail(`${a.device} is not running its ${a.process} service.`);
  const actual = readPath(proc.stateSnapshot().state, a.path);
  if (sameValue(actual, a.equals)) return PASS;
  return fail(`${a.device} ${a.process} ${a.path} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
}

/** Ids of the links that join the devices `a` and `b` (topology order). */
function linksBetween(sim: Simulation, a: DeviceId, b: DeviceId): LinkId[] {
  const ids = new Set<DeviceId>([a, b]);
  return sim
    .exportTopology()
    .links.filter((l) => ids.has(l.a.device) && ids.has(l.b.device) && l.a.device !== l.b.device)
    .map((l) => l.id);
}

function checkLink(sim: Simulation, a: Extract<LabAssertion, { kind: 'link' }>): Check {
  const da = deviceNamed(sim, a.a);
  if (da === undefined) return noDevice(a.a);
  const db = deviceNamed(sim, a.b);
  if (db === undefined) return noDevice(a.b);
  const between = linksBetween(sim, da.id, db.id)
    .map((id) => sim.link(id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  if (between.length === 0) return fail(`${a.a} and ${a.b} are not connected.`);
  const matching = a.media === undefined ? between : between.filter((l) => l.media === a.media || l.resolvedMedia === a.media);
  if (matching.length === 0) {
    return fail(`The cable between ${a.a} and ${a.b} is ${between.map((l) => l.resolvedMedia).join('/')}, expected ${a.media ?? ''}.`);
  }
  if (a.up === undefined) return PASS;
  const up = matching.find((l) => l.up === a.up);
  if (up !== undefined) return PASS;
  const first = matching[0];
  return fail(`The link between ${a.a} and ${a.b} is ${a.up ? 'down' : 'up'}${first?.downReason === undefined ? '' : ` (${first.downReason})`}.`);
}

function checkCounter(sim: Simulation, a: Extract<LabAssertion, { kind: 'counter' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const actual = (port.counters as Record<keyof PortCounters, number | undefined>)[a.counter] ?? 0;
  const pass = a.op === 'gt' ? actual > a.value : a.op === 'lt' ? actual < a.value : actual === a.value;
  if (pass) return PASS;
  const word = a.op === 'gt' ? 'more than' : a.op === 'lt' ? 'fewer than' : 'exactly';
  return fail(`${a.device} ${a.port} ${String(a.counter)} is ${actual}, expected ${word} ${a.value}.`);
}

function checkTraceSeen(sim: Simulation, a: Extract<LabAssertion, { kind: 'traceSeen' }>): Check {
  const min = Math.max(1, Math.floor(a.min ?? 1));
  const found = sim.traceQuery({ from: 0, filter: a.filter, limit: min }).events.length;
  if (found >= min) return PASS;
  return fail(`The retained trace holds ${found} matching event${found === 1 ? '' : 's'}, expected at least ${min}.`);
}

// ── P2: switching (vlan, switchport, stp, etherchannel, portSecurity) ────────

/** The `vlan <v>` section of a running config, if any (`vlan 10,20` is stored as one section per VLAN). */
function vlanSectionOf(config: ConfigAst, vlan: number): ConfigNode | undefined {
  const text = String(vlan);
  return config.root.children.find((c) => c.key === 'vlan' && c.args.length === 1 && c.args[0] === text);
}

/** The `vlans` row of `vlan`, if the device keeps one. */
function vlanRowOf(dev: DeviceRuntime, vlan: number): VlanRow | undefined {
  return rowsOf<VlanRow>(dev, 'vlans').find((r) => r.vlan === vlan);
}

/** Does VLAN `vlan` exist on `dev`, by the rule `show vlan` uses (implicit, a `vlans` row, or a `vlan` section)? */
function vlanExistsOn(dev: DeviceRuntime, vlan: number): boolean {
  return isImplicitVlan(vlan) || vlanRowOf(dev, vlan) !== undefined || vlanSectionOf(dev.running, vlan) !== undefined;
}

/** The name `show vlan` gives `vlan`: fixed for the implicit VLANs, else the row's, the section's, or `VLAN0010`. */
function vlanNameOn(dev: DeviceRuntime, vlan: number): string {
  const fixed = IMPLICIT_VLAN_NAMES[vlan];
  if (fixed !== undefined) return fixed;
  const row = vlanRowOf(dev, vlan);
  if (row !== undefined && row.name !== '') return row.name;
  const named = vlanSectionOf(dev.running, vlan)?.children.find((c) => c.key === 'name')?.args[0];
  return named !== undefined && named !== '' ? named : defaultVlanName(vlan);
}

/** True for a port that carries switchport lines: a switched Ethernet port or a Port-channel. */
const isSwitchPort = (port: PortState): boolean => port.role === 'switched' || port.role === 'channel';

/** Operating mode of a switch port (as the snapshot's `PortL2View.oper` and `show vlan` derive it). */
function operModeOf(dev: DeviceRuntime, port: PortState): L2OperMode {
  const config = readSwitchport(dev.running, port.id, dev.model);
  const dtp = dev.tables.get<DtpRow>('dtp');
  if (port.role === 'channel') {
    const members = rowsOf<EtherchannelRow>(dev, 'etherchannel').filter((r) => r.bundle === port.id && r.state === 'bundled');
    return channelOperOf(config, members.map((m) => dtp?.get(m.port)));
  }
  return operOf(config, dtp?.get(port.id));
}

/** Canonical ids of the ports `show vlan brief` lists for `vlan`, in port order. */
function accessPortsOf(dev: DeviceRuntime, vlan: number): PortState[] {
  const out: PortState[] = [];
  for (const p of dev.ports.values()) {
    if (!isSwitchPort(p) || operModeOf(dev, p) !== 'access') continue;
    const config = readSwitchport(dev.running, p.id, dev.model);
    if (config.accessVlan === vlan || config.voiceVlan === vlan) out.push(p);
  }
  return out;
}

/** Short names of `ports` for a detail (`Fa0/1, Fa0/2`), or `no port`. */
const portList = (ports: readonly PortState[]): string => (ports.length === 0 ? 'no port' : ports.map((p) => p.spec.short).join(', '));

function checkVlan(sim: Simulation, a: Extract<LabAssertion, { kind: 'vlan' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const exists = vlanExistsOn(dev, a.vlan);
  if (a.exists === false) return exists ? fail(`VLAN ${a.vlan} still exists on ${a.device}.`) : PASS;
  if (!exists) return fail(`VLAN ${a.vlan} does not exist on ${a.device}.`);
  const problems: string[] = [];
  if (a.name !== undefined) {
    const name = vlanNameOn(dev, a.vlan);
    if (name !== a.name) problems.push(`is named ${name}, expected ${a.name}`);
  }
  if (a.accessPorts !== undefined) {
    const listed = accessPortsOf(dev, a.vlan);
    const listedIds = new Set(listed.map((p) => p.id));
    const wanted: PortState[] = [];
    for (const name of a.accessPorts) {
      const p = portNamed(dev, name);
      if (p === undefined) return noPort(a.device, name);
      if (!wanted.some((w) => w.id === p.id)) wanted.push(p);
    }
    const wantedIds = new Set(wanted.map((p) => p.id));
    const missing = wanted.filter((p) => !listedIds.has(p.id));
    const extra = a.match === 'exactly' ? listed.filter((p) => !wantedIds.has(p.id)) : [];
    if (missing.length > 0 || extra.length > 0) {
      problems.push(`lists ${portList(listed)}, expected ${a.match === 'exactly' ? 'exactly ' : ''}${portList(wanted)}`);
    }
  }
  return verdict(`VLAN ${a.vlan} on ${a.device}`, problems);
}

/** Canonical list of the VLANs that exist on `dev` for trunk purposes: 1, 1002–1005 and its `vlans` rows. */
function existingVlanList(dev: DeviceRuntime): string {
  const ids = [1, 1002, 1003, 1004, 1005];
  for (const r of rowsOf<VlanRow>(dev, 'vlans')) if (!ids.includes(r.vlan)) ids.push(r.vlan);
  return formatVlanList(ids);
}

/** `1,10,20` or `none`. */
const vlanText = (list: string): string => (list === '' ? 'none' : list);

function checkSwitchport(sim: Simulation, a: Extract<LabAssertion, { kind: 'switchport' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  if (!isSwitchPort(port)) return fail(`${a.device} ${a.port} is not a switch port (its role is ${port.role}).`);
  const config = readSwitchport(dev.running, port.id, dev.model);
  const problems: string[] = [];
  if (a.oper !== undefined) {
    const oper = port.operUp ? operModeOf(dev, port) : 'down';
    if (oper !== a.oper) problems.push(oper === 'down' ? `is down, expected it to operate as ${a.oper}` : `operates as ${oper}, expected ${a.oper}`);
  }
  if (a.mode !== undefined && config.mode !== a.mode) {
    problems.push(`is in mode ${switchportModeText(config.mode)}, expected ${switchportModeText(a.mode)}`);
  }
  if (a.accessVlan !== undefined && config.accessVlan !== a.accessVlan) problems.push(`has access VLAN ${config.accessVlan}, expected ${a.accessVlan}`);
  if (a.voiceVlan !== undefined && config.voiceVlan !== a.voiceVlan) {
    problems.push(`${config.voiceVlan === undefined ? 'has no voice VLAN' : `has voice VLAN ${config.voiceVlan}`}, expected ${a.voiceVlan}`);
  }
  if (a.nativeVlan !== undefined && config.nativeVlan !== a.nativeVlan) problems.push(`has native VLAN ${config.nativeVlan}, expected ${a.nativeVlan}`);
  if (a.allowedVlans !== undefined) {
    const active = vlanListIntersect(config.allowed, existingVlanList(dev));
    const want = formatVlanList(a.allowedVlans);
    if (active !== want) problems.push(`carries VLANs ${vlanText(active)} on its trunk (allowed and existing), expected ${vlanText(want)}`);
  }
  return verdict(`${a.device} ${a.port}`, problems);
}

/** The `stp-bridge` row of `vlan` on `dev`, if its tree runs. */
function stpBridgeOf(dev: DeviceRuntime, vlan: number): StpBridgeRow | undefined {
  return rowsOf<StpBridgeRow>(dev, 'stp-bridge').find((r) => r.vlan === vlan);
}

/** The name of the device whose own bridge id for `vlan` is `bridgeId`, if any. */
function bridgeOwner(sim: Simulation, vlan: number, bridgeId: string): string | undefined {
  for (const d of sim.devices()) if (stpBridgeOf(d, vlan)?.bridgeId === bridgeId) return d.spec.name;
  return undefined;
}

function checkStp(sim: Simulation, a: Extract<LabAssertion, { kind: 'stp' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const bridge = stpBridgeOf(dev, a.vlan);
  if (bridge === undefined) return fail(`Spanning tree is not running for VLAN ${a.vlan} on ${a.device}.`);
  const rootName = (): string => bridgeOwner(sim, a.vlan, bridge.rootId) ?? bridge.rootId;
  const problems: string[] = [];
  if (a.mode !== undefined && bridge.mode !== a.mode) problems.push(`runs ${bridge.mode}, expected ${a.mode}`);
  if (a.root !== undefined && bridge.isRoot !== a.root) {
    problems.push(a.root ? `is not the root bridge (the root is ${rootName()})` : 'is the root bridge');
  }
  if (a.rootBridge !== undefined) {
    const other = deviceNamed(sim, a.rootBridge);
    if (other === undefined) return noDevice(a.rootBridge);
    const theirs = stpBridgeOf(other, a.vlan);
    if (theirs === undefined) problems.push(`cannot have ${a.rootBridge} as its root: ${a.rootBridge} runs no spanning tree for VLAN ${a.vlan}`);
    else if (theirs.bridgeId !== bridge.rootId) problems.push(`sees ${rootName()} as the root, expected ${a.rootBridge}`);
  }
  if (a.port === undefined) {
    if (a.role !== undefined || a.state !== undefined || a.edge !== undefined) return fail('A spanning-tree role, state or edge check needs the port it is about.');
    return verdict(`${a.device} (VLAN ${a.vlan})`, problems);
  }
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const row = rowsOf<StpPortRow>(dev, 'stp').find((r) => r.vlan === a.vlan && r.port === port.id);
  if (row === undefined) {
    problems.push(`has no spanning-tree port ${a.port}`);
  } else {
    if (a.role !== undefined && row.role !== a.role) problems.push(`has ${a.port} in role ${row.role}, expected ${a.role}`);
    if (a.state !== undefined && row.state !== a.state) problems.push(`has ${a.port} ${row.state}, expected ${a.state}`);
    if (a.edge !== undefined && row.edge !== a.edge) problems.push(`has ${a.port} ${row.edge ? 'as' : 'not as'} an edge port, expected ${a.edge ? 'an edge port' : 'a non-edge port'}`);
  }
  return verdict(`${a.device} (VLAN ${a.vlan})`, problems);
}

function checkEtherchannel(sim: Simulation, a: Extract<LabAssertion, { kind: 'etherchannel' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const members = rowsOf<EtherchannelRow>(dev, 'etherchannel').filter((r) => r.group === a.group);
  const first = members[0];
  if (first === undefined) return fail(`${a.device} has no port in channel group ${a.group}.`);
  const problems: string[] = [];
  if (a.protocol !== undefined) {
    const other = members.find((m) => m.protocol !== a.protocol);
    if (other !== undefined) problems.push(`runs ${other.protocol} on ${other.port}, expected ${a.protocol}`);
  }
  if (a.up !== undefined) {
    const up = dev.port(first.bundle)?.operUp === true;
    if (up !== a.up) problems.push(`has ${first.bundle} ${up ? 'up' : 'down'}, expected ${a.up ? 'up' : 'down'}`);
  }
  for (const name of a.bundled ?? []) {
    const port = portNamed(dev, name);
    if (port === undefined) return noPort(a.device, name);
    const row = members.find((m) => m.port === port.id);
    if (row === undefined) problems.push(`has no member ${name}`);
    else if (row.state !== 'bundled') problems.push(`has ${name} ${row.state}${row.reason === undefined ? '' : ` (${row.reason})`}, expected bundled`);
  }
  if (a.minBundled !== undefined) {
    const n = members.filter((m) => m.state === 'bundled').length;
    if (n < a.minBundled) problems.push(`has ${n} bundled member${n === 1 ? '' : 's'}, expected at least ${a.minBundled}`);
  }
  return verdict(`Channel group ${a.group} of ${a.device}`, problems);
}

/** The MACs a `stickyMac` value stands for: one MAC in any notation, or every port MAC of the device so named. */
function macsNamed(sim: Simulation, text: string): readonly string[] | undefined {
  const mac = normalizeMac(text);
  if (mac !== null) return [mac];
  const dev = deviceNamed(sim, text);
  return dev === undefined ? undefined : [...dev.ports.values()].map((p) => p.mac);
}

function checkPortSecurity(sim: Simulation, a: Extract<LabAssertion, { kind: 'portSecurity' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const cfg = readPortSecurity(dev.running, port.id);
  const subject = `Port security on ${a.device} ${a.port}`;
  if (a.enabled !== undefined && (cfg !== undefined) !== a.enabled) return fail(`${subject} is ${a.enabled ? 'off' : 'still on'}.`);
  const more = a.status !== undefined || a.violation !== undefined || a.max !== undefined || a.stickyMac !== undefined || a.minViolations !== undefined;
  if (!more) return PASS;
  if (cfg === undefined) return fail(`${subject} is off.`);
  const problems: string[] = [];
  if (a.violation !== undefined && cfg.violation !== a.violation) problems.push(`acts by ${cfg.violation} on a violation, expected ${a.violation}`);
  if (a.max !== undefined && cfg.max !== a.max) problems.push(`allows ${cfg.max} address${cfg.max === 1 ? '' : 'es'}, expected ${a.max}`);
  if (a.stickyMac !== undefined) {
    const macs = macsNamed(sim, a.stickyMac);
    if (macs === undefined) return fail(`${a.stickyMac} is neither a MAC address nor a device of this topology.`);
    if (!macs.some((m) => cfg.stickyMacs.includes(m))) {
      problems.push(`pins ${cfg.stickyMacs.length === 0 ? 'no sticky address' : `only ${cfg.stickyMacs.join(', ')}`}, expected ${a.stickyMac}`);
    }
  }
  if (a.status !== undefined || a.minViolations !== undefined) {
    const row = rowsOf<PortSecurityRow>(dev, 'port-security').find((r) => r.port === port.id);
    if (row === undefined) {
      problems.push('has no port-security state yet');
    } else {
      if (a.status !== undefined && row.status !== a.status) problems.push(`is ${row.status}, expected ${a.status}`);
      if (a.minViolations !== undefined && row.violations < a.minViolations) {
        problems.push(`counted ${row.violations} violation${row.violations === 1 ? '' : 's'}, expected at least ${a.minViolations}`);
      }
    }
  }
  return verdict(subject, problems);
}

// ── P2: routing, translation, standby groups ─────────────────────────────────

/** Canonical text of an address or `address/len` of `family`, or undefined when it does not parse. */
function canonicalAddr(family: 4 | 6, text: string): string | undefined {
  const slash = text.indexOf('/');
  const addr = slash < 0 ? text.trim() : text.slice(0, slash).trim();
  let canon: string | undefined;
  if (family === 4) {
    const v = parseIpv4(addr);
    canon = v === null ? undefined : u32ToIpv4(v);
  } else {
    canon = normalizeIpv6(addr) ?? undefined;
  }
  if (canon === undefined) return undefined;
  if (slash < 0) return canon;
  const len = text.slice(slash + 1).trim();
  return /^\d{1,3}$/.test(len) ? `${canon}/${Number(len)}` : undefined;
}

/** An IPv4 address an author wrote, in canonical text (kept as written when it does not parse, so it matches nothing). */
function v4Text(text: string | undefined): string | undefined {
  return text === undefined ? undefined : (canonicalAddr(4, text) ?? text);
}

type AnyRoute = RouteRow | Route6Row;

/** Recursion bound of an exit-interface lookup through next hops (the D13 static-route bound). */
const ROUTE_RECURSION_LIMIT = 8;

/** The longest-prefix winner for `dst` on `dev` (`rib` or `rib6`). */
function lpmWinner(dev: DeviceRuntime, family: 4 | 6, dst: string): AnyRoute | undefined {
  if (family === 4) return lpm(dev.tables.rib, dst).winner;
  const rib6 = dev.tables.get<Route6Row>('rib6');
  return rib6 === undefined ? undefined : lpm6Rows(rib6.rows(), dst).winner;
}

/**
 * The exit interfaces of `route`: each path's own interface, else the one its next hop is reached through (the
 * next hop's own longest match, followed recursively as forwarding does, at most ROUTE_RECURSION_LIMIT deep).
 */
function exitInterfaces(dev: DeviceRuntime, family: 4 | 6, route: AnyRoute): PortId[] {
  const out: PortId[] = [];
  const paths = [{ nextHop: route.nextHop, iface: route.iface }, ...(route.paths ?? [])];
  for (const path of paths) {
    let iface = path.iface;
    let hop = path.nextHop;
    let via: AnyRoute = route;
    for (let depth = 0; iface === undefined && hop !== undefined && depth < ROUTE_RECURSION_LIMIT; depth++) {
      const next = lpmWinner(dev, family, hop);
      if (next === undefined || next === via) break;
      iface = next.iface;
      hop = next.nextHop;
      via = next;
    }
    if (iface !== undefined && !out.includes(iface)) out.push(iface);
  }
  return out;
}

/** `10.3.1.0/24 (S, distance 1, via 10.8.0.2, out GigabitEthernet0/1)` for a detail. */
function routeText(r: AnyRoute, exits: readonly PortId[]): string {
  const via = [r.nextHop === undefined ? '' : `via ${r.nextHop}`, exits.length === 0 ? '' : `out ${exits.join(', ')}`].filter((s) => s !== '').join(', ');
  return `${r.network}/${r.prefixLen} (${r.source}, distance ${r.ad}${via === '' ? '' : `, ${via}`})`;
}

function checkRoute(sim: Simulation, a: Extract<LabAssertion, { kind: 'route' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const family = a.family ?? 4;
  const dst = canonicalAddr(family, a.destination);
  if (dst === undefined || dst.includes('/')) return fail(`${a.destination} is not an IPv${family} address.`);
  if (family === 6 && dev.tables.get<Route6Row>('rib6') === undefined) return fail(`${a.device} keeps no IPv6 routing table.`);
  const winner = lpmWinner(dev, family, dst);
  if (a.none === true) return winner === undefined ? PASS : fail(`${a.device} still routes ${dst} through ${routeText(winner, exitInterfaces(dev, family, winner))}.`);
  if (winner === undefined) return fail(`${a.device} has no route to ${dst}.`);
  const exits = exitInterfaces(dev, family, winner);
  const problems: string[] = [];
  if (a.source !== undefined && winner.source !== a.source) problems.push(`source ${a.source}`);
  if (a.network !== undefined) {
    const want = canonicalAddr(family, a.network);
    const have = want !== undefined && want.includes('/') ? `${winner.network}/${winner.prefixLen}` : winner.network;
    if (want === undefined || have !== want) problems.push(`network ${a.network}`);
  }
  if (a.nextHop !== undefined) {
    const want = canonicalAddr(family, a.nextHop);
    const hops = [winner.nextHop, ...(winner.paths ?? []).map((p) => p.nextHop)];
    if (want === undefined || !hops.includes(want)) problems.push(`next hop ${a.nextHop}`);
  }
  if (a.iface !== undefined) {
    const port = portNamed(dev, a.iface);
    if (port === undefined) return noPort(a.device, a.iface);
    if (!exits.includes(port.id)) problems.push(`interface ${a.iface}`);
  }
  if (a.ad !== undefined && winner.ad !== a.ad) problems.push(`distance ${a.ad}`);
  if (problems.length === 0) return PASS;
  return fail(`${a.device} reaches ${dst} through ${routeText(winner, exits)}; expected ${problems.join(', ')}.`);
}

function checkNat(sim: Simulation, a: Extract<LabAssertion, { kind: 'nat' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const table = dev.tables.get<NatRow>('nat');
  if (table === undefined) return fail(`${a.device} does not translate addresses.`);
  const insideLocal = v4Text(a.insideLocal);
  const insideGlobal = v4Text(a.insideGlobal);
  const outsideGlobal = v4Text(a.outsideGlobal);
  const matching = table.find(
    (r) =>
      (insideLocal === undefined || r.insideLocal === insideLocal) &&
      (insideGlobal === undefined || r.insideGlobal === insideGlobal) &&
      (outsideGlobal === undefined || r.outsideGlobal === outsideGlobal) &&
      (a.proto === undefined || r.proto === a.proto) &&
      (a.kindOf === undefined || r.kind === a.kindOf),
  );
  const fields = [
    a.proto === undefined ? '' : `proto ${a.proto}`,
    a.kindOf === undefined ? '' : `kind ${a.kindOf}`,
    a.insideLocal === undefined ? '' : `inside local ${a.insideLocal}`,
    a.insideGlobal === undefined ? '' : `inside global ${a.insideGlobal}`,
    a.outsideGlobal === undefined ? '' : `outside global ${a.outsideGlobal}`,
  ].filter((s) => s !== '');
  const what = fields.length === 0 ? 'translations' : `translations with ${fields.join(', ')}`;
  const n = matching.length;
  if (a.minCount !== undefined) {
    return n >= a.minCount ? PASS : fail(`${a.device} holds ${n} ${what}, expected at least ${a.minCount}.`);
  }
  if (n > 0 === (a.exists ?? true)) return PASS;
  return fail(n > 0 ? `${a.device} still holds ${n} ${what}.` : `${a.device} holds no ${what} (${table.size} row${table.size === 1 ? '' : 's'} in all).`);
}

function checkFhrp(sim: Simulation, a: Extract<LabAssertion, { kind: 'fhrp' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.iface);
  if (port === undefined) return noPort(a.device, a.iface);
  const table = dev.tables.get<HsrpRow>('hsrp');
  if (table === undefined) return fail(`${a.device} runs no standby groups.`);
  const row = table.find((r) => r.iface === port.id && r.group === a.group)[0];
  if (row === undefined) return fail(`${a.device} ${a.iface} has no standby group ${a.group}.`);
  const problems: string[] = [];
  if (a.state !== undefined && row.state !== a.state) problems.push(`is ${row.state}, expected ${a.state}`);
  if (a.virtualIp !== undefined && row.virtualIp !== v4Text(a.virtualIp)) {
    problems.push(`${row.virtualIp === undefined ? 'has no virtual address' : `answers for ${row.virtualIp}`}, expected ${a.virtualIp}`);
  }
  if (a.priority !== undefined && row.priority !== a.priority) problems.push(`has priority ${row.priority}, expected ${a.priority}`);
  if (a.preempt !== undefined && row.preempt !== a.preempt) problems.push(a.preempt ? 'does not preempt' : 'preempts');
  return verdict(`Standby group ${a.group} on ${a.device} ${a.iface}`, problems);
}

// ── connectivity (disposable clones) ─────────────────────────────────────────

/** The sent/received counts of one ping job, read from the icmpv4 / icmpv6 StateView. */
function jobCounts(dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string): { sent: number; received: number } | undefined {
  const proc = dev.processes.get(process);
  if (proc === undefined) return undefined;
  const jobs = proc.stateSnapshot().state['jobs'];
  if (!Array.isArray(jobs)) return undefined;
  for (const entry of jobs as Record<string, unknown>[]) {
    if (entry['session'] !== session) continue;
    return { sent: Number(entry['sent'] ?? 0), received: Number(entry['received'] ?? 0) };
  }
  return undefined;
}

/**
 * The final counts of a FINISHED echo job, taken from the daemon's own completion record. icmpv4 / icmpv6 delete a
 * job inside the dispatch that receives its last reply, so that reply can never be sampled from the StateView —
 * `finish()` emits it as structured debug data (`{ session, target, sent, received, lost }`) instead.
 */
function finishedCounts(dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string): { sent: number; received: number } | undefined {
  const events = dev.processes.get(process)?.debugEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i]?.data;
    if (data === undefined) continue;
    const d = data as Record<string, unknown>;
    if (d['session'] !== session || d['received'] === undefined) continue;
    return { sent: Number(d['sent'] ?? 0), received: Number(d['received'] ?? 0) };
  }
  return undefined;
}

/** The address of `dev` a connectivity check pings (first port in port order that has one). */
function pingAddressOf(dev: DeviceRuntime, family: 4 | 6): string | undefined {
  if (family === 4) {
    for (const p of dev.ports.values()) if (p.l3.ipv4 !== undefined) return p.l3.ipv4.address;
    return undefined;
  }
  const preferred: string[] = [];
  const other: string[] = [];
  for (const p of dev.ports.values()) {
    for (const v6 of p.l3.ipv6 ?? []) {
      if (v6.scope === 'link-local') continue;
      (v6.state === 'preferred' ? preferred : other).push(v6.address);
    }
  }
  return preferred[0] ?? other[0];
}

/** Does `dev` hold `address` on any of its ports? (A device pinging itself always gets a reply.) */
function ownsAddress(dev: DeviceRuntime, family: 4 | 6, address: string): boolean {
  for (const p of dev.ports.values()) {
    if (family === 4) {
      if (p.l3.ipv4?.address === address) return true;
      continue;
    }
    for (const v6 of p.l3.ipv6 ?? []) if (v6.address === address) return true;
  }
  return false;
}

/**
 * Run one echo job in the clone and report its counts. The daemon forgets a finished job, so the StateView is
 * sampled before every step AND the daemon's completion record is read afterwards — the reply that completes a job
 * arrives in the same dispatch that deletes it, so sampling alone can never see the last reply.
 */
function runPing(
  clone: Simulation,
  device: DeviceId,
  family: 4 | 6,
  session: string,
  target: string,
  byName: boolean,
  timeoutNs: SimTime,
): { sent: number; received: number } {
  const dev = clone.device(device);
  const process = family === 4 ? 'icmpv4' : 'icmpv6';
  if (dev === undefined || !dev.processes.has(process)) return { sent: 0, received: 0 };
  const req =
    family === 4
      ? ({ kind: 'icmp.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES } as const)
      : ({ kind: 'icmp6.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES } as const);
  dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: process, req }], clone.now);

  let sent = 0;
  let received = 0;
  let seen = false;
  const deadline = clone.now + timeoutNs * (LAB_PING_COUNT + 2) + LAB_PING_SETTLE_NS;
  for (let i = 0; i < LAB_PING_MAX_EVENTS; i++) {
    const counts = jobCounts(dev, process, session);
    if (counts !== undefined) {
      seen = true;
      sent = Math.max(sent, counts.sent);
      received = Math.max(received, counts.received);
    } else if (seen) {
      break;
    } else if (i === 0 && !byName) {
      // A literal target creates its job inside the request; no job here means the device had no route at all.
      break;
    }
    const next = clone.nextEventTime();
    if (next === undefined || next > deadline) break;
    if (clone.step() === undefined) break;
  }
  const done = finishedCounts(dev, process, session);
  if (done !== undefined) {
    sent = Math.max(sent, done.sent);
    received = Math.max(received, done.received);
  }
  return { sent, received };
}

/** A `connectivity.after` fault resolved against the live world to ids (the clone keeps every id). */
type ResolvedFault =
  | { readonly kind: 'cut'; readonly link: LinkId }
  | { readonly kind: 'power'; readonly device: DeviceId }
  | { readonly kind: 'shutdown'; readonly device: DeviceId; readonly port: PortId };

/** Identity of a resolved fault (the fault set of a clone is the sorted set of these). */
function faultKey(f: ResolvedFault): string {
  switch (f.kind) {
    case 'cut':
      return `cut:${f.link}`;
    case 'power':
      return `power:${f.device}`;
    case 'shutdown':
      return `shutdown:${f.device}|${f.port}`;
  }
}

/** Resolve `faults` by name in the live world: deduplicated, sorted by identity; or the detail of what is missing. */
function resolveFaults(sim: Simulation, faults: readonly LabFault[]): { ok: true; faults: ResolvedFault[] } | { ok: false; detail: string } {
  const byKey = new Map<string, ResolvedFault>();
  const add = (f: ResolvedFault): void => {
    byKey.set(faultKey(f), f);
  };
  for (const f of faults) {
    if ('cut' in f) {
      const a = deviceNamed(sim, f.cut.a);
      if (a === undefined) return { ok: false, detail: `There is no device called ${f.cut.a} in this topology.` };
      const b = deviceNamed(sim, f.cut.b);
      if (b === undefined) return { ok: false, detail: `There is no device called ${f.cut.b} in this topology.` };
      const links = linksBetween(sim, a.id, b.id);
      if (links.length === 0) return { ok: false, detail: `${f.cut.a} and ${f.cut.b} are not connected, so there is no cable to cut.` };
      for (const link of links) add({ kind: 'cut', link });
    } else if ('powerOff' in f) {
      const d = deviceNamed(sim, f.powerOff);
      if (d === undefined) return { ok: false, detail: `There is no device called ${f.powerOff} in this topology.` };
      add({ kind: 'power', device: d.id });
    } else if ('shutdown' in f) {
      const d = deviceNamed(sim, f.shutdown.device);
      if (d === undefined) return { ok: false, detail: `There is no device called ${f.shutdown.device} in this topology.` };
      const p = portNamed(d, f.shutdown.port);
      if (p === undefined) return { ok: false, detail: `${f.shutdown.device} has no interface called ${f.shutdown.port}.` };
      add({ kind: 'shutdown', device: d.id, port: p.id });
    } else {
      return { ok: false, detail: 'A fault for a connectivity check is a cut, a powerOff or a shutdown.' };
    }
  }
  const keys = [...byKey.keys()].sort();
  return { ok: true, faults: keys.map((k) => byKey.get(k) as ResolvedFault) };
}

/** One clone of the graded world, or why it could not be built. */
interface CloneEntry {
  readonly clone?: Simulation;
  readonly error?: string;
  /** Fault clones: each device's ping address per family just before the faults (a powered-off target keeps one). */
  readonly before?: ReadonlyMap<DeviceId, Readonly<Partial<Record<4 | 6, string>>>>;
}

/** The disposable clones of a graded world, built on first use and kept for one `evaluateLab` call. */
interface CloneHost {
  /** The clone for `faults` (none = the base clone), which runs `settleNs` after its faults. */
  get(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry;
  nextSession(): string;
}

/** Every live port with an err-disable cause: [device, port, cause], in device then port order. */
function errDisabledPorts(sim: Simulation): [DeviceId, PortId, string][] {
  const out: [DeviceId, PortId, string][] = [];
  for (const d of sim.devices()) for (const p of d.ports.values()) if (p.errDisabled !== undefined) out.push([d.id, p.id, p.errDisabled]);
  return out;
}

/** An `err-disable` fault for the clone (§3.8 step 7). */
function errDisableFault(device: DeviceId, port: PortId, cause: string): FaultSpec {
  return { id: `lab-clone-errdisable:${device}:${port}`, kind: 'err-disable', target: { device, port }, params: { cause } };
}

/**
 * A settled copy of `sim` (file header): the export loaded with the live seed and catalog, the live cut cables and
 * err-disabled ports re-applied at t = 0, run to idle; a port the boot created is err-disabled after that settle.
 */
function settledClone(sim: Simulation, topo: Topology): Simulation {
  const fresh = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
  fresh.loadTopology(topo);
  // A cut cable is runtime state that TopologyLink cannot carry, so the copy would silently repair it and grade a
  // broken world as reachable. Re-cut those links before the clone settles.
  for (const l of topo.links) {
    if (sim.link(l.id)?.downReason === 'cut') {
      fresh.injectFault(0, { id: `lab-clone-cut:${l.id}`, kind: 'cable-cut', target: { link: l.id } });
    }
  }
  // An err-disabled port is runtime state too (P2 §3.8 step 7): re-apply it the same way, with the live cause.
  const disabled = errDisabledPorts(sim);
  for (const [device, port, cause] of disabled) fresh.injectFault(0, errDisableFault(device, port, cause));
  fresh.runToIdle(LAB_CLONE_BOOT_EVENTS);
  // A port that did not exist at t = 0 (a virtual port the boot creates) is err-disabled now, and the clone settles.
  const late = disabled.filter(([device, port]) => {
    const p = fresh.device(device)?.port(port);
    return p !== undefined && p.errDisabled === undefined;
  });
  if (late.length > 0) {
    for (const [device, port, cause] of late) fresh.injectFault(fresh.now, errDisableFault(device, port, cause));
    fresh.runToIdle(LAB_CLONE_BOOT_EVENTS);
  }
  return fresh;
}

/** Each device's ping address per family (fault clones record it just before their faults). */
function pingAddresses(clone: Simulation): Map<DeviceId, Partial<Record<4 | 6, string>>> {
  const out = new Map<DeviceId, Partial<Record<4 | 6, string>>>();
  for (const d of clone.devices()) {
    const v4 = pingAddressOf(d, 4);
    const v6 = pingAddressOf(d, 6);
    out.set(d.id, { ...(v4 === undefined ? {} : { 4: v4 }), ...(v6 === undefined ? {} : { 6: v6 }) });
  }
  return out;
}

/**
 * Apply `faults` to the settled `clone` at its current instant: shutdowns at once through the device's config path
 * (the `shutdown` line, as typed), cuts and power-offs as `cable-cut` / `power-loss` faults dispatched by the settle
 * run that follows. Returns why a shutdown was refused, if one was.
 */
function applyFaults(clone: Simulation, faults: readonly ResolvedFault[]): string | undefined {
  for (const f of faults) {
    switch (f.kind) {
      case 'cut':
        clone.injectFault(clone.now, { id: `lab-after-cut:${f.link}`, kind: 'cable-cut', target: { link: f.link } });
        break;
      case 'power':
        clone.injectFault(clone.now, { id: `lab-after-power:${f.device}`, kind: 'power-loss', target: { device: f.device } });
        break;
      case 'shutdown': {
        const dev = clone.device(f.device);
        if (dev === undefined || !dev.power || dev.bootedAt === undefined) break;
        dev.applyActions(SIM_PROCESS_NAME, [], clone.now);
        const r = dev.applyConfigLine([['interface', f.port]], ['shutdown'], false);
        if (!r.ok) return `${dev.spec.name} refused to shut ${f.port}${r.error === undefined ? '' : `: ${r.error}`}.`;
        break;
      }
    }
  }
  return undefined;
}

function createCloneHost(sim: Simulation): CloneHost {
  const entries = new Map<string, CloneEntry>();
  let topo: Topology | undefined;
  let sessions = 0;

  function build(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry {
    try {
      topo ??= sim.exportTopology();
      const clone = settledClone(sim, topo);
      if (faults.length === 0) return { clone };
      const before = pingAddresses(clone);
      const refused = applyFaults(clone, faults);
      if (refused !== undefined) return { error: refused };
      clone.runFor(settleNs, { maxEvents: LAB_AFTER_SETTLE_EVENTS });
      return { clone, before };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    get(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry {
      const key = faults.length === 0 ? '' : `${faults.map(faultKey).join(',')}@${settleNs}`;
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = build(faults, settleNs);
        entries.set(key, entry);
      }
      return entry;
    },
    nextSession(): string {
      sessions++;
      return `lab-check:${sessions}`;
    },
  };
}

/** `settleMs` in ns: the given whole milliseconds (≥ 0), else the default. */
function settleNsOf(settleMs: number | undefined): SimTime {
  const ms = settleMs !== undefined && Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs) : LAB_AFTER_SETTLE_MS;
  return ms * MS;
}

function checkConnectivity(sim: Simulation, host: CloneHost, a: Extract<LabAssertion, { kind: 'connectivity' }>): Check {
  const family: 4 | 6 = a.family ?? 4;
  const from = deviceNamed(sim, a.from);
  if (from === undefined) return noDevice(a.from);
  const to = a.byName === true ? undefined : deviceNamed(sim, a.to);
  if (a.byName === true) {
    if (family === 6) return fail('A connectivity check by name needs IPv4; give an address for an IPv6 check.');
  } else if (to === undefined) {
    return noDevice(a.to);
  }
  const resolved = resolveFaults(sim, a.after ?? []);
  if (!resolved.ok) return fail(resolved.detail);
  const entry = host.get(resolved.faults, settleNsOf(a.settleMs));
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a connectivity check.');
  // Devices are matched by NAME in the live world but addressed INSIDE the clone: the clone replays DHCP from t=0,
  // so an address the live world gave one host can belong to another there. Resolving the target in the clone keeps
  // the check about the device, not about a string.
  const cloneFrom = clone.device(from.id);
  if (cloneFrom === undefined) return fail(`${a.from} could not be copied for a connectivity check.`);
  let target: string;
  if (to === undefined) {
    target = a.to;
  } else {
    const cloneTo = clone.device(to.id);
    const address = (cloneTo === undefined ? undefined : pingAddressOf(cloneTo, family)) ?? entry.before?.get(to.id)?.[family];
    if (address === undefined) return fail(`${a.to} has no IPv${family} address to be reached at.`);
    // A host that pings its own address always gets a reply, which would score a task whose point is that some
    // OTHER device answers.
    if (from.id !== to.id && ownsAddress(cloneFrom, family, address)) {
      return fail(`${a.from} already holds ${address} itself, so a reply from it would not show that ${a.to} answers.`);
    }
    target = address;
  }
  const timeoutNs = Math.max(1, Math.round(a.timeoutMs ?? LAB_PING_TIMEOUT_MS)) * MS;
  const { sent, received } = runPing(clone, from.id, family, host.nextSession(), target, a.byName === true, timeoutNs);
  const reachable = received > 0;
  if (reachable !== (a.expect === 'success')) {
    return fail(
      a.expect === 'success'
        ? `${a.from} got no reply from ${target} (${sent} echo request${sent === 1 ? '' : 's'} sent).`
        : `${a.from} reached ${target} (${received} of ${sent} replied), which this task expects to fail.`,
    );
  }
  // P2 (§2.10): follow-up static checks in the same clone, after the ping (the rows the ping created)
  for (const next of a.then ?? []) {
    const r = next.kind === 'connectivity' ? fail('A follow-up check reads state; it cannot ping again.') : checkStatic(clone, next);
    if (!r.pass) return fail(`After the ping from ${a.from}: ${r.detail ?? 'a follow-up check failed.'}`);
  }
  return PASS;
}

// ── the grader ───────────────────────────────────────────────────────────────

/** Every kind but `connectivity`, against `sim` (the live world, or a clone for `connectivity.then`). */
function checkStatic(sim: Simulation, a: Exclude<LabAssertion, { kind: 'connectivity' }>): Check {
  try {
    switch (a.kind) {
      case 'config':
        return checkConfig(sim, a);
      case 'port':
        return checkPort(sim, a);
      case 'table':
        return checkTable(sim, a);
      case 'process':
        return checkProcess(sim, a);
      case 'link':
        return checkLink(sim, a);
      case 'counter':
        return checkCounter(sim, a);
      case 'traceSeen':
        return checkTraceSeen(sim, a);
      case 'vlan':
        return checkVlan(sim, a);
      case 'switchport':
        return checkSwitchport(sim, a);
      case 'stp':
        return checkStp(sim, a);
      case 'etherchannel':
        return checkEtherchannel(sim, a);
      case 'portSecurity':
        return checkPortSecurity(sim, a);
      case 'route':
        return checkRoute(sim, a);
      case 'nat':
        return checkNat(sim, a);
      case 'fhrp':
        return checkFhrp(sim, a);
      default:
        return fail(`"${String((a as { kind: string }).kind)}" is not a check this grader knows.`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function checkOne(sim: Simulation, host: CloneHost, a: LabAssertion): Check {
  if (a.kind !== 'connectivity') return checkStatic(sim, a);
  try {
    return checkConnectivity(sim, host, a);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Score every task of `lab` against `sim` (contracts/scenario.ts `EvaluateLab`). The live simulation's clock, trace
 * and rng are untouched; `connectivity` assertions run in disposable clones built on first use (one per fault set).
 */
export const evaluateLab: EvaluateLab = (sim: Simulation, lab: ScenarioInfo): LabStatus => {
  const host = createCloneHost(sim);
  const results: LabCheckResult[] = [];
  let score = 0;
  let total = 0;
  const preparing = (lab.faults ?? []).some((f) => f.at > sim.now);
  for (const task of lab.tasks ?? []) {
    if (preparing) {
      total += task.points;
      const assertions = task.assertions.map((_, index) => (index === 0 ? { index, pass: false, detail: LAB_PREPARING_DETAIL } : { index, pass: false }));
      results.push({ task: task.id, pass: false, points: 0, assertions });
      continue;
    }
    const assertions = task.assertions.map((a, index) => {
      const r = checkOne(sim, host, a);
      return r.detail === undefined ? { index, pass: r.pass } : { index, pass: r.pass, detail: r.detail };
    });
    const pass = assertions.every((r) => r.pass);
    total += task.points;
    if (pass) score += task.points;
    results.push({ task: task.id, pass, points: pass ? task.points : 0, assertions });
  }
  return { lab: lab.name, checkedAt: sim.now, score, total, results };
};
