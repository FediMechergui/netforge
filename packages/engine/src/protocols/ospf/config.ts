/**
 * protocols/ospf/config.ts — the OSPF configuration reader and the rules that derive from it (ARCHITECTURE-P3 D7,
 * §3.1, §5.1; §7 W1 ospf). Pure: reads a running-configuration tree, never changes it; no module state.
 *
 * Lines read (§5.1; storage belongs to the CLI's config rules, W1 cli):
 *   global     `router ospf <pid>` (one process per device, D7) with the children `router-id <a>`, `network <a>
 *              <wildcard> area <area>`, `passive-interface <if>`, `passive-interface default`, the stored negation
 *              `no passive-interface <if>`, `auto-cost reference-bandwidth <Mb/s>`, `default-information originate
 *              [always]`, `maximum-paths <n>`;
 *   interface  `ip ospf <pid> area <area>`, `ip ospf cost|priority|hello-interval|dead-interval <n>`, `ip ospf network
 *              point-to-point|broadcast`, `bandwidth <kb/s>`.
 * An area is typed as an integer (0–4294967295) or dotted; it is always returned dotted (`OspfAreaId`). Interface
 * lines may be stored as full-token nodes or under an `ip` group node: both are read.
 *
 * Derived rules (D7):
 *   • Enablement (`ospfEnabledInterfaces`): an `ip ospf <pid> area <a>` line wins for its interface (when `<pid>` is
 *     not the running process, the interface is in no process and no network line applies); otherwise the `network`
 *     line matching the interface's primary address with the most specific wildcard (fewest one bits), then the first
 *     in configuration order.
 *   • Passive: `passive-interface <if>`, or every interface under `passive-interface default` except those with a
 *     stored `no passive-interface <if>`.
 *   • Router id (`selectOspfRouterId`, at process start): `router-id` > the highest address of an up loopback > the
 *     highest address of any up interface.
 *   • Network type (`ospfNetworkType`): serial (`wan`) and [S18] tunnels point-to-point; routed ports,
 *     subinterfaces and SVIs broadcast; a loopback is a /32 host stub (`loopback`) unless `ip ospf network
 *     point-to-point`; `ip ospf network` overrides the others.
 *   • Timers: hello 10 s; without a dead line the dead interval is 4 × hello (§5.1).
 */
import { ipv4ToU32, parseIpv4, u32ToIpv4, type Ipv4Address } from '../../contracts/addr.js';
import type { PortRole } from '../../contracts/catalog.js';
import type { ConfigAst, ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { OspfAreaId, OspfNetworkType } from '../../contracts/tables.js';
import { OSPF_COST_MAX, OSPF_REFERENCE_MBPS_DEFAULT, OSPF_REFERENCE_MBPS_MAX } from './cost.js';

/** @since P3 Default hello interval, seconds. */
export const OSPF_HELLO_S_DEFAULT = 10;
/** @since P3 Default router priority. */
export const OSPF_PRIORITY_DEFAULT = 1;
/** @since P3 Default `maximum-paths` (bounded by 1–4, §5.1). */
export const OSPF_MAXIMUM_PATHS_DEFAULT = 4;
/** @since P3 Largest `maximum-paths`. */
export const OSPF_MAXIMUM_PATHS_MAX = 4;

/** @since P3 One `network <a> <wildcard> area <area>` line. */
export interface OspfNetworkLine {
  readonly address: Ipv4Address;
  readonly wildcard: Ipv4Address;
  readonly area: OspfAreaId;
}

/** @since P3 The `router ospf <pid>` section. */
export interface OspfProcessConfig {
  readonly pid: number;
  /** The `router-id` line (the id in use is chosen at process start, `selectOspfRouterId`). */
  readonly routerId?: Ipv4Address;
  /** In configuration order. */
  readonly networks: readonly OspfNetworkLine[];
  readonly passiveDefault: boolean;
  /** `passive-interface <if>` lines, in configuration order. */
  readonly passive: readonly PortId[];
  /** Stored `no passive-interface <if>` lines (meaningful under `passive-interface default`). */
  readonly notPassive: readonly PortId[];
  readonly referenceBandwidthMbps: number;
  readonly defaultOriginate?: 'on' | 'always';
  readonly maximumPaths: number;
}

/** @since P3 The OSPF lines of one interface. */
export interface OspfInterfaceConfig {
  readonly port: PortId;
  readonly area?: { readonly pid: number; readonly area: OspfAreaId };
  readonly cost?: number;
  readonly priority?: number;
  readonly helloS?: number;
  readonly deadS?: number;
  readonly networkType?: 'point-to-point' | 'broadcast';
  /** The `bandwidth` line, kb/s. */
  readonly bandwidthKbps?: number;
}

/** @since P3 Everything OSPF reads from a running configuration. */
export interface OspfConfig {
  /** Absent without a `router ospf` section. */
  readonly process?: OspfProcessConfig;
  /** Interfaces with at least one of the lines above, in configuration order. */
  readonly interfaces: ReadonlyMap<PortId, OspfInterfaceConfig>;
}

/** @since P3 An area typed as an integer (0–4294967295) or dotted, as the dotted `OspfAreaId`; undefined if neither. */
export function parseOspfArea(token: string | undefined): OspfAreaId | undefined {
  if (token === undefined) return undefined;
  if (/^\d{1,10}$/.test(token)) {
    const v = Number(token);
    return v <= 0xffffffff ? u32ToIpv4(v) : undefined;
  }
  const a = parseIpv4(token);
  return a === null ? undefined : u32ToIpv4(a);
}

function int(token: string | undefined, min: number, max: number): number | undefined {
  if (token === undefined || !/^\d{1,10}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= min && v <= max ? v : undefined;
}

function address(token: string | undefined): Ipv4Address | undefined {
  const v = token === undefined ? null : parseIpv4(token);
  return v === null ? undefined : u32ToIpv4(v);
}

/** Token lists of a section's children, an `ip` group node flattened one level. */
function linesOf(node: ConfigNode): string[][] {
  const out: string[][] = [];
  for (const c of node.children) {
    if (c.key === 'ip' && c.args.length === 0 && c.children.length > 0) {
      for (const leaf of c.children) out.push(['ip', leaf.key, ...leaf.args]);
      continue;
    }
    out.push([c.key, ...c.args]);
  }
  return out;
}

function readProcess(node: ConfigNode, pid: number): OspfProcessConfig {
  let routerId: Ipv4Address | undefined;
  const networks: OspfNetworkLine[] = [];
  let passiveDefault = false;
  const passive: PortId[] = [];
  const notPassive: PortId[] = [];
  let referenceBandwidthMbps = OSPF_REFERENCE_MBPS_DEFAULT;
  let defaultOriginate: 'on' | 'always' | undefined;
  let maximumPaths = OSPF_MAXIMUM_PATHS_DEFAULT;
  for (const t of linesOf(node)) {
    const [k, a, b, c, d] = t;
    if (k === 'router-id' && t.length === 2) {
      const id = address(a);
      if (id !== undefined && id !== '0.0.0.0') routerId = id;
    } else if (k === 'network' && t.length === 5 && c === 'area') {
      const net = address(a);
      const wild = address(b);
      const area = parseOspfArea(d);
      if (net !== undefined && wild !== undefined && area !== undefined) {
        const w = ipv4ToU32(wild);
        networks.push({ address: u32ToIpv4((ipv4ToU32(net) & ~w) >>> 0), wildcard: wild, area });
      }
    } else if (k === 'passive-interface' && t.length === 2) {
      if (a === 'default') passiveDefault = true;
      else if (a !== undefined && !passive.includes(a)) passive.push(a);
    } else if (k === 'no' && a === 'passive-interface' && t.length === 3 && b !== undefined && b !== 'default') {
      if (!notPassive.includes(b)) notPassive.push(b);
    } else if (k === 'auto-cost' && a === 'reference-bandwidth' && t.length === 3) {
      const v = int(b, 1, OSPF_REFERENCE_MBPS_MAX);
      if (v !== undefined) referenceBandwidthMbps = v;
    } else if (k === 'default-information' && a === 'originate') {
      if (t.length === 2) defaultOriginate = 'on';
      else if (t.length === 3 && b === 'always') defaultOriginate = 'always';
    } else if (k === 'maximum-paths' && t.length === 2) {
      const v = int(a, 1, OSPF_MAXIMUM_PATHS_MAX);
      if (v !== undefined) maximumPaths = v;
    }
  }
  return {
    pid,
    ...(routerId === undefined ? {} : { routerId }),
    networks,
    passiveDefault,
    passive,
    notPassive,
    referenceBandwidthMbps,
    ...(defaultOriginate === undefined ? {} : { defaultOriginate }),
    maximumPaths,
  };
}

function readInterface(port: PortId, node: ConfigNode): OspfInterfaceConfig | undefined {
  const cfg: { -readonly [K in keyof OspfInterfaceConfig]: OspfInterfaceConfig[K] } = { port };
  let seen = false;
  for (const t of linesOf(node)) {
    if (t[0] === 'bandwidth' && t.length === 2) {
      const v = int(t[1], 1, 10_000_000_000);
      if (v !== undefined) {
        cfg.bandwidthKbps = v;
        seen = true;
      }
      continue;
    }
    if (t[0] !== 'ip' || t[1] !== 'ospf') continue;
    const [, , a, b, c] = t;
    if (t.length === 5 && b === 'area') {
      const pid = int(a, 1, 65535);
      const area = parseOspfArea(c);
      if (pid === undefined || area === undefined) continue;
      cfg.area = { pid, area };
    } else if (t.length === 4 && a === 'cost') {
      const v = int(b, 1, OSPF_COST_MAX);
      if (v === undefined) continue;
      cfg.cost = v;
    } else if (t.length === 4 && a === 'priority') {
      const v = int(b, 0, 255);
      if (v === undefined) continue;
      cfg.priority = v;
    } else if (t.length === 4 && a === 'hello-interval') {
      const v = int(b, 1, 65535);
      if (v === undefined) continue;
      cfg.helloS = v;
    } else if (t.length === 4 && a === 'dead-interval') {
      const v = int(b, 1, 65535);
      if (v === undefined) continue;
      cfg.deadS = v;
    } else if (t.length === 4 && a === 'network' && (b === 'point-to-point' || b === 'broadcast')) {
      cfg.networkType = b;
    } else {
      continue;
    }
    seen = true;
  }
  return seen ? cfg : undefined;
}

/** @since P3 Read the OSPF process and the OSPF interface lines of a running configuration (the first `router ospf` section). */
export function readOspfConfig(config: Pick<ConfigAst, 'root'>): OspfConfig {
  let process: OspfProcessConfig | undefined;
  const interfaces = new Map<PortId, OspfInterfaceConfig>();
  for (const node of config.root.children) {
    if (node.key === 'router' && node.args[0] === 'ospf' && process === undefined) {
      const pid = int(node.args[1], 1, 65535);
      if (pid !== undefined) process = readProcess(node, pid);
    } else if (node.key === 'interface' && node.args.length === 1 && !interfaces.has(node.args[0]!)) {
      const cfg = readInterface(node.args[0]!, node);
      if (cfg !== undefined) interfaces.set(cfg.port, cfg);
    }
  }
  return process === undefined ? { interfaces } : { process, interfaces };
}

/** @since P3 True when `port` is passive in `proc` (passive interfaces are advertised but send no hello). */
export function isOspfPassive(proc: Pick<OspfProcessConfig, 'passiveDefault' | 'passive' | 'notPassive'>, port: PortId): boolean {
  return proc.passiveDefault ? !proc.notPassive.includes(port) : proc.passive.includes(port);
}

/** @since P3 An interface the enablement rule looks at: its port and primary IPv4 address. */
export interface OspfIfaceCandidate {
  readonly port: PortId;
  readonly address?: Ipv4Address;
}

/** @since P3 An interface enabled for OSPF, its area and the line that enabled it. */
export interface OspfEnabledIface {
  readonly port: PortId;
  readonly area: OspfAreaId;
  readonly via: 'interface' | 'network';
  /** `via: 'network'`: the matching line. */
  readonly network?: OspfNetworkLine;
}

function onesOf(v: number): number {
  let n = 0;
  let x = v >>> 0;
  while (x !== 0) {
    x = (x & (x - 1)) >>> 0;
    n++;
  }
  return n;
}

/**
 * @since P3 The interfaces `cfg`'s process enables, in the order of `ports` (the caller's canonical port order): the
 * interface line first, else the most specific matching `network` line (see the module header). An interface
 * without an address is enabled only by its interface line (it still needs an address to run). Empty without a process.
 */
export function ospfEnabledInterfaces(cfg: OspfConfig, ports: readonly OspfIfaceCandidate[]): OspfEnabledIface[] {
  const proc = cfg.process;
  if (proc === undefined) return [];
  const out: OspfEnabledIface[] = [];
  for (const p of ports) {
    const line = cfg.interfaces.get(p.port)?.area;
    if (line !== undefined) {
      if (line.pid === proc.pid) out.push({ port: p.port, area: line.area, via: 'interface' });
      continue;
    }
    if (p.address === undefined) continue;
    const x = ipv4ToU32(p.address);
    let best: OspfNetworkLine | undefined;
    let bestOnes = 33;
    for (const n of proc.networks) {
      const w = ipv4ToU32(n.wildcard);
      if (((x ^ ipv4ToU32(n.address)) & ~w) >>> 0 !== 0) continue;
      const ones = onesOf(w);
      if (ones < bestOnes) {
        best = n;
        bestOnes = ones;
      }
    }
    if (best !== undefined) out.push({ port: p.port, area: best.area, via: 'network', network: best });
  }
  return out;
}

/** @since P3 A port the router-id rule looks at. */
export interface OspfRouterIdCandidate {
  readonly role: PortRole;
  readonly operUp: boolean;
  readonly address?: Ipv4Address;
}

/**
 * @since P3 The router id a process takes at start (D7): the `router-id` line, else the highest address of an up
 * loopback, else the highest address of any up interface; undefined when there is none (`ospfNoRouterId`).
 */
export function selectOspfRouterId(
  configured: Ipv4Address | undefined,
  ports: readonly OspfRouterIdCandidate[],
): { routerId: Ipv4Address; source: 'configured' | 'loopback' | 'interface' } | undefined {
  if (configured !== undefined && configured !== '0.0.0.0') return { routerId: configured, source: 'configured' };
  let loop: number | undefined;
  let any: number | undefined;
  for (const p of ports) {
    if (!p.operUp || p.address === undefined) continue;
    const v = ipv4ToU32(p.address);
    if (v === 0) continue;
    if (p.role === 'virtual' && (loop === undefined || v > loop)) loop = v;
    if (any === undefined || v > any) any = v;
  }
  if (loop !== undefined) return { routerId: u32ToIpv4(loop), source: 'loopback' };
  if (any !== undefined) return { routerId: u32ToIpv4(any), source: 'interface' };
  return undefined;
}

/** @since P3 The OSPF network type of an interface by its role and its `ip ospf network` line (D7). */
export function ospfNetworkType(role: PortRole, configured?: 'point-to-point' | 'broadcast'): OspfNetworkType {
  if (role === 'virtual') return configured === 'point-to-point' ? 'point-to-point' : 'loopback';
  if (configured !== undefined) return configured;
  return role === 'wan' || role === 'tunnel' ? 'point-to-point' : 'broadcast';
}

/** @since P3 An interface's hello and dead intervals, seconds (dead = 4 × hello without a dead line). */
export function ospfIfaceTimers(cfg: Pick<OspfInterfaceConfig, 'helloS' | 'deadS'> | undefined): { helloS: number; deadS: number } {
  const helloS = cfg?.helloS ?? OSPF_HELLO_S_DEFAULT;
  return { helloS, deadS: cfg?.deadS ?? 4 * helloS };
}

/** @since P3 An interface's router priority (1 by default; 0 = never DR or BDR). */
export function ospfIfacePriority(cfg: Pick<OspfInterfaceConfig, 'priority'> | undefined): number {
  return cfg?.priority ?? OSPF_PRIORITY_DEFAULT;
}
