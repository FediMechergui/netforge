/**
 * protocols/stp/guards.ts — the spanning-tree configuration readers and the guard rules (ARCHITECTURE-P2 §3.6
 * "Guards", §3.2 step 6, §5.1, §13 #24 and #33).
 *
 * Global lines (`readStpGlobalLines`):
 *   spanning-tree mode pvst|rapid-pvst          the mode; no line = spanning tree off (the P1 default, D3)
 *   spanning-tree vlan <v> priority <p>         configured bridge priority of one VLAN (the AST stores one line per VLAN)
 *   no spanning-tree vlan <v>                   the VLAN runs no instance (stored negation)
 *   spanning-tree portfast default              every operationally non-trunking port is edge unless `portfast disable`
 *   spanning-tree portfast bpduguard default    BPDU guard on every edge port
 * Interface lines (`readStpPortLines`):
 *   spanning-tree portfast [trunk|disable]      edge (non-trunking), edge on a trunk, or never edge
 *   spanning-tree bpduguard enable|disable
 *   spanning-tree guard root|loop|none          (loop guard is [S5], not built: the line is read and ignored)
 *   spanning-tree cost <n>, spanning-tree port-priority <p>, spanning-tree vlan <v> cost|port-priority <n>
 *
 * Guard rules (pure):
 *   - edge (PortFast): (`portfast` on the port, or `portfast default` globally and not `portfast disable`) AND the port
 *     is operationally non-trunking — which, with the D3 default of `dynamic auto`, includes host ports never set to
 *     `switchport mode access` — OR `portfast trunk` on an operational trunk (#33);
 *   - BPDU guard: `bpduguard enable`, or `portfast bpduguard default` on an edge port, and not `bpduguard disable`;
 *   - root guard: `guard root`;
 *   - native VLAN mismatch (`pvid`): an UNTAGGED BPDU on a trunk whose pvid TLV differs from the trunk's native VLAN
 *     — checked only on trunks, only for untagged BPDUs (#17, §3.2 step 6);
 *   - type inconsistency: an access (non-trunking) port that receives an UNTAGGED BPDU carrying the pvid TLV faces a
 *     trunk (#24; a tagged voice-VLAN BPDU is legitimate on an access port, S4).
 *
 * Every message is original wording (D22). Pure: no state, no clock.
 */
import type { ConfigAst, ConfigDelta, ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import { isBridgePriority, isPortPriority } from './ids.js';
import { isStpCost } from './cost.js';

/** The spanning-tree modes the daemon runs (`mst` is COULD C2 and is read as "off"). */
export type StpMode = 'pvst' | 'rapid-pvst';

/** The global `spanning-tree …` lines of a running config. */
export interface StpGlobalLines {
  /** Absent = no `spanning-tree mode` line = spanning tree off. */
  readonly mode?: StpMode;
  /** Configured bridge priority per VLAN (`spanning-tree vlan <v> priority <p>`), multiples of 4096. */
  readonly priorities: ReadonlyMap<number, number>;
  /** VLANs with `no spanning-tree vlan <v>`. */
  readonly disabled: ReadonlySet<number>;
  readonly portfastDefault: boolean;
  readonly bpduguardDefault: boolean;
}

/** The `spanning-tree …` lines of one interface section. */
export interface StpPortLines {
  readonly portfast?: 'on' | 'trunk' | 'disable';
  readonly bpduguard?: 'enable' | 'disable';
  readonly guard?: 'root' | 'loop' | 'none';
  readonly cost?: number;
  readonly portPriority?: number;
  readonly vlanCost: ReadonlyMap<number, number>;
  readonly vlanPortPriority: ReadonlyMap<number, number>;
}

/** The lines of a port without any `spanning-tree` line. */
export const DEFAULT_STP_PORT_LINES: StpPortLines = Object.freeze({
  vlanCost: new Map<number, number>(),
  vlanPortPriority: new Map<number, number>(),
});

const VLAN_LOW = 1;
const VLAN_HIGH = 4094;

/** A VLAN id token (1–4094), else undefined. */
export function vlanIdToken(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,4}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= VLAN_LOW && v <= VLAN_HIGH ? v : undefined;
}

/** The VLAN ids of a `<vlan-list>` token (`10`, `10,20`, `10-12`), ascending, or [] when malformed. */
export function vlanListTokens(token: string | undefined): number[] {
  if (token === undefined || !/^[0-9,-]+$/.test(token)) return [];
  const out = new Set<number>();
  for (const part of token.split(',')) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (m === null) return [];
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < VLAN_LOW || hi > VLAN_HIGH || hi < lo) return [];
    for (let v = lo; v <= hi; v++) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function intToken(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,9}$/.test(token)) return undefined;
  return Number(token);
}

/** Read the global `spanning-tree …` lines (and stored `no spanning-tree vlan <v>` negations) of `config`. */
export function readStpGlobalLines(config: ConfigAst): StpGlobalLines {
  let mode: StpMode | undefined;
  const priorities = new Map<number, number>();
  const disabled = new Set<number>();
  let portfastDefault = false;
  let bpduguardDefault = false;
  for (const c of config.root.children) {
    if (c.key === 'no' && c.args[0] === 'spanning-tree' && c.args[1] === 'vlan' && c.args.length === 3) {
      for (const v of vlanListTokens(c.args[2])) disabled.add(v);
      continue;
    }
    if (c.key !== 'spanning-tree') continue;
    const a = c.args;
    if (a[0] === 'mode' && a.length === 2) {
      mode = a[1] === 'pvst' || a[1] === 'rapid-pvst' ? a[1] : undefined;
    } else if (a[0] === 'vlan' && a[2] === 'priority' && a.length === 4) {
      const p = intToken(a[3]);
      if (p !== undefined && isBridgePriority(p)) for (const v of vlanListTokens(a[1])) priorities.set(v, p);
    } else if (a[0] === 'portfast' && a[1] === 'default' && a.length === 2) {
      portfastDefault = true;
    } else if (a[0] === 'portfast' && a[1] === 'bpduguard' && a[2] === 'default' && a.length === 3) {
      bpduguardDefault = true;
    }
  }
  return mode === undefined
    ? { priorities, disabled, portfastDefault, bpduguardDefault }
    : { mode, priorities, disabled, portfastDefault, bpduguardDefault };
}

function parsePortSection(node: ConfigNode): StpPortLines {
  let portfast: StpPortLines['portfast'];
  let bpduguard: StpPortLines['bpduguard'];
  let guard: StpPortLines['guard'];
  let cost: number | undefined;
  let portPriority: number | undefined;
  const vlanCost = new Map<number, number>();
  const vlanPortPriority = new Map<number, number>();
  for (const child of node.children) {
    if (child.key !== 'spanning-tree') continue;
    const a = child.args;
    if (a[0] === 'portfast') {
      portfast = a.length === 1 ? 'on' : a[1] === 'trunk' ? 'trunk' : a[1] === 'disable' ? 'disable' : portfast;
    } else if (a[0] === 'bpduguard' && a.length === 2) {
      bpduguard = a[1] === 'enable' ? 'enable' : a[1] === 'disable' ? 'disable' : bpduguard;
    } else if (a[0] === 'guard' && a.length === 2) {
      guard = a[1] === 'root' || a[1] === 'loop' || a[1] === 'none' ? a[1] : guard;
    } else if (a[0] === 'cost' && a.length === 2) {
      const n = intToken(a[1]);
      if (n !== undefined && isStpCost(n)) cost = n;
    } else if (a[0] === 'port-priority' && a.length === 2) {
      const n = intToken(a[1]);
      if (n !== undefined && isPortPriority(n)) portPriority = n;
    } else if (a[0] === 'vlan' && a[2] === 'cost' && a.length === 4) {
      const n = intToken(a[3]);
      if (n !== undefined && isStpCost(n)) for (const v of vlanListTokens(a[1])) vlanCost.set(v, n);
    } else if (a[0] === 'vlan' && a[2] === 'port-priority' && a.length === 4) {
      const n = intToken(a[3]);
      if (n !== undefined && isPortPriority(n)) for (const v of vlanListTokens(a[1])) vlanPortPriority.set(v, n);
    }
  }
  const out: {
    portfast?: StpPortLines['portfast']; bpduguard?: StpPortLines['bpduguard']; guard?: StpPortLines['guard'];
    cost?: number; portPriority?: number; vlanCost: Map<number, number>; vlanPortPriority: Map<number, number>;
  } = { vlanCost, vlanPortPriority };
  if (portfast !== undefined) out.portfast = portfast;
  if (bpduguard !== undefined) out.bpduguard = bpduguard;
  if (guard !== undefined) out.guard = guard;
  if (cost !== undefined) out.cost = cost;
  if (portPriority !== undefined) out.portPriority = portPriority;
  return out;
}

/** The `spanning-tree …` lines of the interface section of `port` (`DEFAULT_STP_PORT_LINES` when there is none). */
export function readStpPortLines(config: ConfigAst, port: PortId): StpPortLines {
  for (const c of config.root.children) {
    if (c.key === 'interface' && c.args.length === 1 && c.args[0] === port) return parsePortSection(c);
  }
  return DEFAULT_STP_PORT_LINES;
}

/** `readStpPortLines` for every interface section of `config` in one pass (ports without a section are absent). */
export function readAllStpPortLines(config: ConfigAst): ReadonlyMap<PortId, StpPortLines> {
  const out = new Map<PortId, StpPortLines>();
  for (const c of config.root.children) {
    if (c.key !== 'interface' || c.args.length !== 1) continue;
    const port = c.args[0] as PortId;
    if (!out.has(port)) out.set(port, parsePortSection(c));
  }
  return out;
}

/** True when a config delta is one the daemon must react to (spanning-tree, switchport, vlan, errdisable, channel-group lines). */
export function isStpRelevantDelta(delta: Pick<ConfigDelta, 'context' | 'line'>): boolean {
  const first = delta.line[0];
  if (delta.context.length === 0) {
    if (first === 'spanning-tree' || first === 'vlan' || first === 'errdisable') return true;
    return first === 'no' && delta.line[1] === 'spanning-tree';
  }
  const head = delta.context[0];
  if (head === undefined || delta.context.length !== 1) return false;
  if (head[0] === 'vlan') return true;
  if (head[0] !== 'interface') return false;
  return first === 'spanning-tree' || first === 'switchport' || first === 'channel-group' || first === 'shutdown'
    || (first === 'no' && (delta.line[1] === 'switchport' || delta.line[1] === 'spanning-tree' || delta.line[1] === 'shutdown'));
}

// ── guard rules ────────────────────────────────────────────────────────────────

/** Is the port an edge (PortFast) port? `operTrunk` = the port is operationally trunking (§3.6 Guards, #33). */
export function isEdgePort(global: Pick<StpGlobalLines, 'portfastDefault'>, lines: StpPortLines, operTrunk: boolean): boolean {
  if (lines.portfast === 'disable') return false;
  if (lines.portfast === 'trunk') return true;
  const enabled = lines.portfast === 'on' || global.portfastDefault;
  return enabled && !operTrunk;
}

/** Is BPDU guard active on the port? `edge` = `isEdgePort(…)`. */
export function isBpduGuardOn(global: Pick<StpGlobalLines, 'bpduguardDefault'>, lines: StpPortLines, edge: boolean): boolean {
  if (lines.bpduguard === 'disable') return false;
  if (lines.bpduguard === 'enable') return true;
  return global.bpduguardDefault && edge;
}

/** Is root guard active on the port? */
export function isRootGuardOn(lines: StpPortLines): boolean {
  return lines.guard === 'root';
}

/**
 * The pvid check of a trunk (§3.2 step 6): an UNTAGGED BPDU carrying `pvid` on a trunk whose native VLAN is `native`
 * mismatches when the two differ. Returns the two VLANs concerned (ascending) or undefined when consistent, when the
 * BPDU was tagged, or when it carried no TLV.
 */
export function nativeVlanMismatch(tagged: boolean, pvid: number | undefined, native: number): readonly [number, number] | undefined {
  if (tagged || pvid === undefined || pvid === native) return undefined;
  return pvid < native ? [pvid, native] : [native, pvid];
}

/** The type check of an access port (#24): an UNTAGGED BPDU carrying the pvid TLV means the port faces a trunk. */
export function facesTrunk(tagged: boolean, pvid: number | undefined): boolean {
  return !tagged && pvid !== undefined;
}

// ── messages (original wording, D22) ──────────────────────────────────────────

/** Log facility of every spanning-tree log line. */
export const STP_LOG_FACILITY = 'SPANTREE';

/** §3.2 step 6, severity 2. `vlans` ascending. */
export function nativeMismatchMessage(port: PortId, own: number, received: number, vlans: readonly [number, number]): string {
  return `Native VLAN mismatch on ${port}: this switch sends VLAN ${own} untagged, the neighbour sends VLAN ${received}. VLANs ${vlans[0]} and ${vlans[1]} are blocked on this port.`;
}

export function nativeMismatchClearedMessage(port: PortId, vlan: number): string {
  return `Native VLAN mismatch on ${port} cleared for VLAN ${vlan}: the port takes part in spanning tree again.`;
}

export function typeInconsistentMessage(port: PortId, vlan: number): string {
  return `${port} is an access port in VLAN ${vlan} but receives trunk BPDUs: it is blocked until they stop.`;
}

export function typeInconsistentClearedMessage(port: PortId, vlan: number): string {
  return `${port} no longer receives trunk BPDUs in VLAN ${vlan}: the port takes part in spanning tree again.`;
}

export function rootGuardMessage(port: PortId, vlan: number): string {
  return `Root guard blocked ${port} in VLAN ${vlan}: a neighbour claimed a better root than this tree allows.`;
}

export function rootGuardClearedMessage(port: PortId, vlan: number): string {
  return `Root guard on ${port} in VLAN ${vlan} cleared: the superior BPDUs stopped.`;
}

export function bpduGuardMessage(port: PortId, vlan: number): string {
  return `BPDU guard shut ${port} down: a spanning-tree BPDU arrived in VLAN ${vlan} on a port meant for an end device.`;
}

/** Detail of the `errDisable` action (shown in the runtime's log line). */
export function bpduGuardDetail(port: PortId): string {
  return `BPDU received on ${port} with BPDU guard enabled`;
}

export function instanceCapMessage(cap: number, vlan: number): string {
  return `Spanning tree runs for at most ${cap} VLANs on this switch; VLAN ${vlan} and higher VLANs run none.`;
}
