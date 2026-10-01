/**
 * protocols/eigrp/config.ts — the EIGRP configuration reader [C1] (ARCHITECTURE-P3 D26, §2.16, §5.1; §7 W1 eigrp).
 *
 * Reads the stored lines of §5.1 from a device's configuration tree (through `configTextLinesOf`, so group folding and
 * stored negations read the same way as for every other daemon):
 *
 *   router eigrp <1-65535>                         one process per device (a second is refused by the handler; the
 *                                                  first section in the tree is the process)
 *    network <a> [<wildcard>]                      multi; without a wildcard the address's classful network
 *                                                  (A /8, B /16, C /24), as real devices do; a subnet mask typed in
 *                                                  place of the wildcard is inverted
 *    eigrp router-id <a>
 *    passive-interface <if> | passive-interface default   (`no passive-interface <if>` exempts a port from default)
 *    metric weights 0 <k1> <k2> <k3> <k4> <k5>
 *    maximum-paths <1-4>                           default 4 (D8)
 *    no auto-summary                               accepted, ignored: automatic summarisation is off (D26)
 *   interface <if>
 *    delay <1-16777215>                            tens of µs
 *    bandwidth <kbps>
 *    ip hello-interval eigrp <as> <1-65535>        only for this process's AS
 *    ip hold-time eigrp <as> <1-65535>
 *
 * An interface runs EIGRP when its primary address matches a `network` line (address AND NOT wildcard equal on both
 * sides); it sends hellos unless it is passive, and its connected network is advertised either way. Interface names are
 * compared as stored (the CLI stores canonical port names).
 *
 * Router id (D26, as OSPF's rule D7): `eigrp router-id`, else the highest address of an up loopback, else the highest
 * address of an up interface; `eigrpRouterIdOf` picks it from the daemon's candidates.
 *
 * Pure: no module state, no I/O.
 */
import type { Ipv4Address } from '../../contracts/addr.js';
import { ipv4ToU32, isIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import { EIGRP_HELLO_S, EIGRP_HOLD_S } from '../../contracts/pdu.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { EIGRP_DEFAULT_K_VALUES, type EigrpKValues } from './metric.js';

/** `maximum-paths` when the line is absent (D8: default 4). */
export const EIGRP_DEFAULT_MAXIMUM_PATHS = 4;
/** `maximum-paths` range. */
export const EIGRP_MAXIMUM_PATHS_MAX = 4;
/** Autonomous system range. */
export const EIGRP_AS_MIN = 1;
export const EIGRP_AS_MAX = 65535;

/** One `network` line, normalised: `address` has the wildcard bits cleared. */
export interface EigrpNetworkStatement {
  readonly address: Ipv4Address;
  readonly wildcard: Ipv4Address;
  /** The line gave no wildcard (the classful network was used). */
  readonly classful: boolean;
}

/** The `router eigrp` process as configured. */
export interface EigrpProcessConfig {
  readonly as: number;
  readonly routerId?: Ipv4Address;
  readonly networks: readonly EigrpNetworkStatement[];
  readonly passiveDefault: boolean;
  /** `passive-interface <if>` lines, in configuration order. */
  readonly passiveInterfaces: readonly string[];
  /** `no passive-interface <if>` lines (exemptions from `passive-interface default`). */
  readonly activeInterfaces: readonly string[];
  readonly kValues: EigrpKValues;
  readonly maximumPaths: number;
}

/** EIGRP-relevant lines of one interface. */
export interface EigrpInterfaceConfig {
  /** `delay` in tens of µs (absent: the port default, metric.ts). */
  readonly delayTens?: number;
  /** `bandwidth` in kb/s (absent: the routing-bandwidth default). */
  readonly bandwidthKbps?: number;
  /** Effective hello interval (s) for the process's AS. */
  readonly helloS: number;
  /** Effective hold time (s) for the process's AS; advertised in hellos. */
  readonly holdS: number;
}

const intIn = (tok: string | undefined, lo: number, hi: number): number | undefined => {
  if (tok === undefined || !/^\d+$/.test(tok)) return undefined;
  const v = Number(tok);
  return v >= lo && v <= hi ? v : undefined;
};

/** The classful wildcard of `address` (class A 0.255.255.255, B 0.0.255.255, C 0.0.0.255); undefined for D and E. */
export function eigrpClassfulWildcard(address: Ipv4Address): Ipv4Address | undefined {
  const first = ipv4ToU32(address) >>> 24;
  if (first < 128) return '0.255.255.255';
  if (first < 192) return '0.0.255.255';
  if (first < 224) return '0.0.0.255';
  return undefined;
}

/** A contiguous subnet mask other than all ones (typed where a wildcard belongs; real devices invert it). */
function isSubnetMaskNotWildcard(v: number): boolean {
  if (v === 0xffff_ffff || (v & 0x8000_0000) === 0) return false;
  const inv = ~v >>> 0;
  return (inv & (inv + 1)) === 0;
}

/** Parse the tokens after `network`; undefined when they are not a valid statement. */
export function eigrpNetworkOf(tokens: readonly string[]): EigrpNetworkStatement | undefined {
  const a = tokens[0];
  if (a === undefined || !isIpv4(a)) return undefined;
  let wildcard: Ipv4Address;
  let classful = false;
  const w = tokens[1];
  if (w === undefined) {
    const cw = eigrpClassfulWildcard(a);
    if (cw === undefined) return undefined;
    wildcard = cw;
    classful = true;
  } else {
    if (!isIpv4(w)) return undefined;
    const wv = ipv4ToU32(w);
    wildcard = isSubnetMaskNotWildcard(wv) ? u32ToIpv4(~wv >>> 0) : w;
  }
  const wv = ipv4ToU32(wildcard);
  return { address: u32ToIpv4((ipv4ToU32(a) & ~wv) >>> 0), wildcard, classful };
}

/** Whether `stmt` covers the interface address `address`. */
export function eigrpNetworkMatches(stmt: EigrpNetworkStatement, address: Ipv4Address): boolean {
  const wv = ipv4ToU32(stmt.wildcard);
  return ((ipv4ToU32(address) & ~wv) >>> 0) === ((ipv4ToU32(stmt.address) & ~wv) >>> 0);
}

/** Whether an interface whose primary address is `address` runs EIGRP (some `network` line covers it). */
export function eigrpInterfaceEnabled(cfg: Pick<EigrpProcessConfig, 'networks'>, address: Ipv4Address): boolean {
  return cfg.networks.some((n) => eigrpNetworkMatches(n, address));
}

/** Whether `port` is passive (no hellos, no neighbours; its network is still advertised). */
export function eigrpInterfacePassive(cfg: Pick<EigrpProcessConfig, 'passiveDefault' | 'passiveInterfaces' | 'activeInterfaces'>, port: PortId): boolean {
  if (cfg.passiveDefault) return !cfg.activeInterfaces.includes(port);
  return cfg.passiveInterfaces.includes(port);
}

/** The `router eigrp` process of `root`; undefined when none is configured. */
export function readEigrpProcess(root: ConfigNode): EigrpProcessConfig | undefined {
  let as: number | undefined;
  let routerId: Ipv4Address | undefined;
  const networks: EigrpNetworkStatement[] = [];
  let passiveDefault = false;
  const passiveInterfaces: string[] = [];
  const activeInterfaces: string[] = [];
  let kValues: EigrpKValues = EIGRP_DEFAULT_K_VALUES;
  let maximumPaths = EIGRP_DEFAULT_MAXIMUM_PATHS;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length === 0) {
      if (as === undefined && !l.negate && t[0] === 'router' && t[1] === 'eigrp') as = intIn(t[2], EIGRP_AS_MIN, EIGRP_AS_MAX);
      continue;
    }
    const head = l.context[0]!;
    if (l.context.length !== 1 || head[0] !== 'router' || head[1] !== 'eigrp' || as === undefined || intIn(head[2], EIGRP_AS_MIN, EIGRP_AS_MAX) !== as) continue;
    if (l.negate) {
      if (t[0] === 'passive-interface' && t[1] !== undefined && t[1] !== 'default' && !activeInterfaces.includes(t[1])) activeInterfaces.push(t[1]);
      continue;
    }
    switch (t[0]) {
      case 'network': {
        const n = eigrpNetworkOf(t.slice(1));
        if (n !== undefined && !networks.some((x) => x.address === n.address && x.wildcard === n.wildcard)) networks.push(n);
        break;
      }
      case 'eigrp':
        if (t[1] === 'router-id' && isIpv4(t[2] ?? '')) routerId = t[2]!;
        break;
      case 'passive-interface':
        if (t[1] === 'default') passiveDefault = true;
        else if (t[1] !== undefined && !passiveInterfaces.includes(t[1])) passiveInterfaces.push(t[1]);
        break;
      case 'metric': {
        if (t[1] !== 'weights' || t[2] !== '0') break;
        const k = t.slice(3, 8).map((x) => intIn(x, 0, 255));
        if (k.length === 5 && k.every((x) => x !== undefined)) kValues = Object.freeze(k as number[]) as unknown as EigrpKValues;
        break;
      }
      case 'maximum-paths': {
        const m = intIn(t[1], 1, EIGRP_MAXIMUM_PATHS_MAX);
        if (m !== undefined) maximumPaths = m;
        break;
      }
      default:
        break;
    }
  }
  if (as === undefined) return undefined;
  return { as, ...(routerId !== undefined ? { routerId } : {}), networks, passiveDefault, passiveInterfaces, activeInterfaces, kValues, maximumPaths };
}

/** The EIGRP lines of every interface section of `root`, for the process's AS (hello and hold defaults filled). */
export function readEigrpInterfaces(root: ConfigNode, as: number): ReadonlyMap<PortId, EigrpInterfaceConfig> {
  const acc = new Map<PortId, { delayTens?: number; bandwidthKbps?: number; helloS: number; holdS: number }>();
  for (const l of configTextLinesOf(root)) {
    const head = l.context[0];
    if (l.context.length !== 1 || head?.[0] !== 'interface' || head[1] === undefined || l.negate) continue;
    const port = head[1];
    let cur = acc.get(port);
    if (cur === undefined) {
      cur = { helloS: EIGRP_HELLO_S, holdS: EIGRP_HOLD_S };
      acc.set(port, cur);
    }
    const t = l.tokens;
    if (t[0] === 'delay') {
      const d = intIn(t[1], 1, 16_777_215);
      if (d !== undefined) cur.delayTens = d;
    } else if (t[0] === 'bandwidth') {
      const b = intIn(t[1], 1, 10_000_000);
      if (b !== undefined) cur.bandwidthKbps = b;
    } else if (t[0] === 'ip' && t[2] === 'eigrp' && intIn(t[3], EIGRP_AS_MIN, EIGRP_AS_MAX) === as) {
      const s = intIn(t[4], 1, 65535);
      if (s === undefined) continue;
      if (t[1] === 'hello-interval') cur.helloS = s;
      else if (t[1] === 'hold-time') cur.holdS = s;
    }
  }
  const out = new Map<PortId, EigrpInterfaceConfig>();
  for (const [port, c] of acc) {
    out.set(port, Object.freeze({ ...(c.delayTens !== undefined ? { delayTens: c.delayTens } : {}), ...(c.bandwidthKbps !== undefined ? { bandwidthKbps: c.bandwidthKbps } : {}), helloS: c.helloS, holdS: c.holdS }));
  }
  return out;
}

/** The EIGRP lines of one interface (defaults when the interface has none). */
export function readEigrpInterface(root: ConfigNode, port: PortId, as: number): EigrpInterfaceConfig {
  return readEigrpInterfaces(root, as).get(port) ?? { helloS: EIGRP_HELLO_S, holdS: EIGRP_HOLD_S };
}

/** A router-id candidate: an interface address with its kind and state. */
export interface EigrpRouterIdCandidate {
  readonly address: Ipv4Address;
  readonly loopback: boolean;
  readonly up: boolean;
}

/** The router id: configured, else the highest up loopback address, else the highest up interface address. */
export function eigrpRouterIdOf(cfg: Pick<EigrpProcessConfig, 'routerId'>, candidates: readonly EigrpRouterIdCandidate[]): Ipv4Address | undefined {
  if (cfg.routerId !== undefined) return cfg.routerId;
  const highest = (list: readonly EigrpRouterIdCandidate[]): Ipv4Address | undefined =>
    list.reduce<Ipv4Address | undefined>((best, c) => (best === undefined || ipv4ToU32(c.address) > ipv4ToU32(best) ? c.address : best), undefined);
  const up = candidates.filter((c) => c.up);
  return highest(up.filter((c) => c.loopback)) ?? highest(up);
}
