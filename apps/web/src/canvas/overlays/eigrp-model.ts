/**
 * canvas/overlays/eigrp-model.ts — [C1] the pure model behind the EIGRP overlay (ARCHITECTURE-P3 §6, §2.16, §3.12; spec
 * §9.6 "EIGRP": successors bold, feasible successors marked, the feasibility condition as an inequality that evaluates
 * live).
 *
 * For ONE destination at a time (the prefix chosen in the View menu, `topoOverlays.eigrpPrefix`; null = the first
 * prefix any router knows, in address order), from the `eigrp-topology` rows only (§2.16; D24):
 *
 * - each **successor** path is a thick underlay on the cable of its interface with an `S` chip at the router's end;
 * - each **feasible successor** (reported distance < feasible distance, not a successor) is a medium underlay with `FS`;
 *   any other path draws nothing (it fails the feasibility condition);
 * - at the router, the live **inequality** of its best backup: `RD 3072 < FD 3328` for its first feasible successor, or,
 *   when it has none, `RD 28416 ≥ FD 3328` for the first path that fails the condition (the learner sees why there is
 *   no backup); a router whose route is **active** carries `A` (with the replies it still waits for).
 *
 * A cable carrying paths of several routers takes the heaviest weight any of them gives it. Every encoding keeps a
 * non-colour channel (chips, letters, the inequality text, underlay thickness); feasible successors are a medium line,
 * never a dash pattern (P2 D20). Pure: no Pixi, no store. `deriveDeviceEigrp` depends on one device object only, so
 * the W3 registry entry memoises it per device object.
 */
import { EIGRP_INFINITY } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, EigrpPath, EigrpTopologyRow, Ipv4Address, LinkId, PortId, SimSnapshot } from '@netforge/engine';

// ── chips and text ───────────────────────────────────────────────────────────

/** Chip of a successor path. */
export const EIGRP_SUCCESSOR_CHIP = 'S';
/** Chip of a feasible successor path. */
export const EIGRP_FEASIBLE_CHIP = 'FS';
/** Badge of a router whose route is active (querying its neighbours). */
export const EIGRP_ACTIVE_BADGE = 'A';

/** A metric as the inequality prints it: the integer, or `∞` for an unreachable distance. */
export function eigrpMetricText(metric: number): string {
  return metric >= EIGRP_INFINITY ? '∞' : String(metric);
}

/** The feasibility condition of one path (RFC 7868: RD < FD): `RD 3072 < FD 3328` or `RD 28416 ≥ FD 3328`. */
export function feasibilityText(rd: number, fd: number): string {
  return `RD ${eigrpMetricText(rd)} ${rd < fd ? '<' : '≥'} FD ${eigrpMetricText(fd)}`;
}

/** Compare two `a.b.c.d/len` prefixes: by address, then by length; text order for anything else. */
function comparePrefixes(a: string, b: string): number {
  const pa = prefixKey(a);
  const pb = prefixKey(b);
  if (pa !== null && pb !== null) return pa[0] - pb[0] || pa[1] - pb[1];
  if ((pa === null) !== (pb === null)) return pa === null ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function prefixKey(p: string): [number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(p);
  if (m === null) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    v = v * 256 + o;
  }
  return [v, Number(m[5])];
}

// ── per device ───────────────────────────────────────────────────────────────

/** A device's EIGRP topology rows by prefix. */
export interface DeviceEigrp {
  readonly topology: ReadonlyMap<string, EigrpTopologyRow>;
}

const EMPTY_EIGRP: DeviceEigrp = Object.freeze({ topology: new Map() });

function isTopologyRow(r: Record<string, unknown>): boolean {
  return typeof r.prefix === 'string' && typeof r.state === 'string' && typeof r.fd === 'number' && Array.isArray(r.successors) && Array.isArray(r.feasible);
}

/** Derive a device's EIGRP topology. Pure in the device object. */
export function deriveDeviceEigrp(d: DeviceSnapshot): DeviceEigrp {
  const rows = (d.tables.extra ?? []).find((t) => t.name === 'eigrp-topology')?.rows ?? [];
  if (rows.length === 0) return EMPTY_EIGRP;
  const topology = new Map<string, EigrpTopologyRow>();
  for (const r of rows) if (isTopologyRow(r)) topology.set(r.prefix as string, r as unknown as EigrpTopologyRow);
  return { topology };
}

/** Every prefix some router has in its topology table, in address order. */
export function eigrpPrefixesOf(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceEigrp = deriveDeviceEigrp): string[] {
  const out = new Set<string>();
  for (const d of snapshot.devices) for (const p of perDevice(d).topology.keys()) out.add(p);
  return [...out].sort(comparePrefixes);
}

/** The prefix the overlay draws: the wanted one when a router knows it, else the first; null when none is known. */
export function chooseEigrpPrefix(prefixes: readonly string[], wanted: string | null | undefined): string | null {
  if (wanted !== null && wanted !== undefined && prefixes.includes(wanted)) return wanted;
  return prefixes[0] ?? null;
}

// ── the overlay model ────────────────────────────────────────────────────────

/** What a path is to its router. */
export type EigrpPathRole = 'successor' | 'feasible' | 'other';

/** How a path (or a cable) is drawn. */
export type EigrpWeight = 'thick' | 'medium' | 'none';

/** One path of a router's topology entry for the drawn prefix. */
export interface EigrpPathMark {
  readonly device: DeviceId;
  readonly iface: PortId;
  readonly nextHop: Ipv4Address;
  /** The cable of `iface` and the router's end of it, when it is cabled. */
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  readonly role: EigrpPathRole;
  /** `S`, `FS` or ''. */
  readonly chip: string;
  readonly weight: EigrpWeight;
  /** The distance through this neighbour. */
  readonly metric: number;
  /** The neighbour's reported distance. */
  readonly rd: number;
  /** RD < FD. */
  readonly feasible: boolean;
  /** `RD 3072 < FD 3328`. */
  readonly inequality: string;
}

/** One router's entry for the drawn prefix. */
export interface EigrpRouterMark {
  readonly device: DeviceId;
  readonly prefix: string;
  readonly state: EigrpTopologyRow['state'];
  /** `A` while active, ''. */
  readonly badge: string;
  readonly fd: number;
  /** The live inequality shown at the router ('' when it has no path besides its successors). */
  readonly text: string;
  /** The text's condition holds (a feasible successor exists). */
  readonly holds: boolean;
  readonly successors: number;
  readonly feasibleSuccessors: number;
  /** A network directly connected to this router (no chips: the router is the origin). */
  readonly connected?: PortId;
  /** Replies still awaited while active. */
  readonly pendingReplies?: number;
}

/** One cable of the overlay. */
export interface EigrpLinkMark {
  readonly link: LinkId;
  /** The heaviest weight any path gives the cable. */
  readonly weight: EigrpWeight;
}

/** The EIGRP overlay's full render model. */
export interface EigrpOverlayModel {
  /** The prefix drawn (null: no router knows any prefix). */
  readonly prefix: string | null;
  /** Prefixes the View menu offers, in address order. */
  readonly prefixes: readonly string[];
  readonly routers: readonly EigrpRouterMark[];
  readonly paths: readonly EigrpPathMark[];
  /** Cables with a successor or feasible-successor path, in snapshot order. */
  readonly links: readonly EigrpLinkMark[];
}

/** Options of `buildEigrpOverlay`. */
export interface EigrpOverlayOptions {
  /** `topoOverlays.eigrpPrefix` (null = the first prefix). */
  readonly prefix?: string | null;
}

const WEIGHT_RANK: Readonly<Record<EigrpWeight, number>> = Object.freeze({ none: 0, medium: 1, thick: 2 });

/** Build the EIGRP overlay from a snapshot. Devices in snapshot order; paths successors, feasible, then the others. */
export function buildEigrpOverlay(
  snapshot: SimSnapshot,
  opts: EigrpOverlayOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceEigrp = deriveDeviceEigrp,
): EigrpOverlayModel {
  const derived = new Map<DeviceSnapshot, DeviceEigrp>();
  const once = (d: DeviceSnapshot): DeviceEigrp => {
    let v = derived.get(d);
    if (v === undefined) derived.set(d, (v = perDevice(d)));
    return v;
  };
  const prefixes = eigrpPrefixesOf(snapshot, once);
  const prefix = chooseEigrpPrefix(prefixes, opts.prefix);
  if (prefix === null) return { prefix: null, prefixes, routers: [], paths: [], links: [] };

  const endOf = new Map<string, { link: LinkId; end: 'a' | 'b' }>();
  for (const l of snapshot.links) {
    endOf.set(`${l.a.device}|${l.a.port}`, { link: l.id, end: 'a' });
    endOf.set(`${l.b.device}|${l.b.port}`, { link: l.id, end: 'b' });
  }

  const routers: EigrpRouterMark[] = [];
  const paths: EigrpPathMark[] = [];
  const linkWeight = new Map<LinkId, EigrpWeight>();
  for (const d of snapshot.devices) {
    const row = once(d).topology.get(prefix);
    if (row === undefined) continue;
    const others = Array.isArray(row.others) ? row.others : [];
    const groups: readonly [EigrpPathRole, readonly EigrpPath[]][] = [
      ['successor', row.successors],
      ['feasible', row.feasible],
      ['other', others],
    ];
    const connected = row.connected !== undefined;
    for (const [role, list] of groups) {
      for (const p of list) {
        const at = endOf.get(`${d.id}|${p.iface}`);
        const feasible = p.rd < row.fd;
        const weight: EigrpWeight = connected ? 'none' : role === 'successor' ? 'thick' : role === 'feasible' ? 'medium' : 'none';
        paths.push({
          device: d.id,
          iface: p.iface,
          nextHop: p.nextHop,
          ...(at === undefined ? {} : { link: at.link, end: at.end }),
          role,
          chip: weight === 'none' ? '' : role === 'successor' ? EIGRP_SUCCESSOR_CHIP : EIGRP_FEASIBLE_CHIP,
          weight,
          metric: p.metric,
          rd: p.rd,
          feasible,
          inequality: feasibilityText(p.rd, row.fd),
        });
        if (at !== undefined && WEIGHT_RANK[weight] > WEIGHT_RANK[linkWeight.get(at.link) ?? 'none']) linkWeight.set(at.link, weight);
      }
    }
    const backup = row.feasible[0] ?? others[0];
    routers.push({
      device: d.id,
      prefix,
      state: row.state,
      badge: row.state === 'active' ? EIGRP_ACTIVE_BADGE : '',
      fd: row.fd,
      text: backup === undefined || connected ? '' : feasibilityText(backup.rd, row.fd),
      holds: !connected && row.feasible.length > 0,
      successors: row.successors.length,
      feasibleSuccessors: row.feasible.length,
      ...(row.connected === undefined ? {} : { connected: row.connected }),
      ...(row.state === 'active' && row.pendingReplies !== undefined ? { pendingReplies: row.pendingReplies } : {}),
    });
  }

  const links: EigrpLinkMark[] = [];
  for (const l of snapshot.links) {
    const weight = linkWeight.get(l.id);
    if (weight !== undefined && weight !== 'none') links.push({ link: l.id, weight });
  }
  return { prefix, prefixes, routers, paths, links };
}
