/**
 * canvas/overlays/route-path-model.ts — [S7] the pure model behind the route-path overlay (ARCHITECTURE-P3C §6, §7 W1c
 * web-canvas, §10.2; rulings R-11 and R-12; spec §9.6 "Routing (any)": the path a packet to one destination takes).
 *
 * For ONE destination at a time (`topoOverlays.routeTo`, an IPv4 or an IPv6 address; null = nothing is drawn), from
 * snapshot data only (P3 D24): each device's `rib` or `rib6` rows, its port addresses, its `tunnels` rows and the
 * `ip nat inside` / `ip nat outside` lines of its rendered running config.
 *
 * - Every device that forwards by its own table (a router, a multilayer switch, a host; never a plain layer-2 switch)
 *   looks the destination up with the engine's own longest-prefix match (`lpmRows` for IPv4, `lpm6Rows` for IPv6,
 *   `@netforge/engine/pure`), so the overlay and the data plane agree on the winner. A host's winner is its default
 *   route, so a host's path starts at its default gateway (R-12).
 * - A hop runs from the device to the device that owns the next hop (the destination itself for a connected route),
 *   over the cables between them: a layer-2 walk through switches, hubs and access points from the egress port (a
 *   subinterface leaves by its parent; a switch virtual interface by any cabled port). The walk does not model VLANs.
 * - ECMP fans out: a route with two or more installed paths gives one hop per path, each tagged `i/n`.
 * - A tunnel is ONE hop: a route out of a tunnel interface goes straight to the tunnel's far router, whatever carries
 *   it underneath. A next hop no cable reaches (a wireless client, an unresolved layer-2 path) is a direct hop too.
 * - `↻` marks every device on a forwarding loop (a cycle of hops); `∅` a black hole: a device with no route to the
 *   destination, or whose next hop nobody in the world owns.
 * - `NAT` marks an inside interface where a path enters a NAT router and leaves by an outside interface.
 *
 * Every encoding keeps a non-colour channel (the glyphs, chips and the arrows' direction). Pure: no Pixi, no store.
 * `deriveDeviceRoute` depends on one device object only, so the registry memoises it per device object.
 */
import { ipFamily, lpm6Rows, lpmRows, normalizeIp } from '@netforge/engine/pure';
import { walkConfigText } from '@netforge/engine/web';
import type { DeviceId, DeviceSnapshot, LinkId, PortId, PortSnapshot, Route6Row, RouteRow, SimSnapshot, TunnelRow } from '@netforge/engine';

// ── glyphs ───────────────────────────────────────────────────────────────────

/** A device on a forwarding loop. */
export const ROUTE_LOOP_GLYPH = '↻';
/** A device that drops the packet: no route, or a next hop nobody owns. */
export const ROUTE_BLACK_HOLE_GLYPH = '∅';
/** The destination's owner. */
export const ROUTE_DESTINATION_GLYPH = '◎';
/** An inside interface where the path is translated. */
export const ROUTE_NAT_GLYPH = 'NAT';
/** The chip of a tunnel hop. */
export const ROUTE_TUNNEL_CHIP = 'tunnel';
/** How many cables a layer-2 walk crosses at most between two hops. */
export const ROUTE_L2_WALK_MAX = 32;
/** How many times a next hop without an interface is looked up again (a recursive static route). */
const RECURSION_MAX = 4;

// ── per device ───────────────────────────────────────────────────────────────

/** What the route-path overlay reads of one device. */
export interface DeviceRoute {
  /** The device looks destinations up in its own table (a router, a multilayer switch, a host). */
  readonly forwards: boolean;
  /** Frames cross the device at layer 2 (a switch, a hub, an access point). */
  readonly bridges: boolean;
  /** Powered and booted. */
  readonly up: boolean;
  readonly rib: readonly RouteRow[];
  readonly rib6: readonly Route6Row[];
  /** Every address the device answers for (IPv4 dotted, IPv6 canonical) → its port. */
  readonly addresses: ReadonlyMap<string, PortId>;
  readonly tunnels: ReadonlyMap<PortId, TunnelRow>;
  readonly natInside: ReadonlySet<PortId>;
  readonly natOutside: ReadonlySet<PortId>;
}

const BRIDGE_KINDS: ReadonlySet<string> = new Set(['switch', 'mlswitch', 'dcswitch', 'hub', 'repeater', 'bridge', 'ap', 'wlc']);

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows ?? [];
}

function isRouteRow(r: unknown): r is RouteRow {
  const o = r as Record<string, unknown>;
  return typeof o === 'object' && o !== null && typeof o.network === 'string' && typeof o.prefixLen === 'number' && typeof o.ad === 'number';
}

/** Canonical text of an address (IPv6 compressed lower case), or null when it is not an address. */
export function canonicalAddress(a: string): string | null {
  return typeof a === 'string' ? normalizeIp(a) : null;
}

/** The interface sections that hold `ip nat inside` / `ip nat outside` (the rendered running config). */
function natPorts(config: string): { inside: Set<PortId>; outside: Set<PortId> } {
  const inside = new Set<PortId>();
  const outside = new Set<PortId>();
  if (!config.includes('ip nat')) return { inside, outside };
  for (const l of walkConfigText(config)) {
    if (l.negate || l.context.length !== 1) continue;
    const head = l.context[0] as readonly string[];
    if (head[0] !== 'interface' || l.tokens[0] !== 'ip' || l.tokens[1] !== 'nat' || l.tokens.length !== 3) continue;
    const port = head.slice(1).join(' ');
    if (l.tokens[2] === 'inside') inside.add(port);
    else if (l.tokens[2] === 'outside') outside.add(port);
  }
  return { inside, outside };
}

/** Derive what the overlay reads of a device. Pure in the device object. */
export function deriveDeviceRoute(d: DeviceSnapshot): DeviceRoute {
  const caps = d.capabilities;
  const switchOnly = caps.includes('switching') && !caps.includes('routing');
  const rib = d.tables.rib.filter(isRouteRow);
  const rib6 = rowsOf(d, 'rib6').filter(isRouteRow) as unknown as Route6Row[];
  const addresses = new Map<string, PortId>();
  for (const p of d.ports) {
    const v4 = p.l3.ipv4?.address;
    if (v4 !== undefined && !addresses.has(v4)) addresses.set(v4, p.id);
    for (const v of p.l3.virtual4 ?? []) if (!addresses.has(v.address)) addresses.set(v.address, p.id);
    for (const a of p.l3.ipv6 ?? []) {
      if (a.state === 'duplicate' || a.state === 'tentative') continue;
      const c = canonicalAddress(a.address);
      if (c !== null && !addresses.has(c)) addresses.set(c, p.id);
    }
  }
  const tunnels = new Map<PortId, TunnelRow>();
  for (const r of rowsOf(d, 'tunnels')) if (typeof r.port === 'string' && typeof r.state === 'string') tunnels.set(r.port, r as unknown as TunnelRow);
  const nat = natPorts(d.runningConfig);
  return {
    forwards: !switchOnly && (rib.length > 0 || rib6.length > 0),
    bridges: BRIDGE_KINDS.has(d.kind) || caps.includes('switching') || caps.includes('wifi-ap'),
    up: d.power && d.booted,
    rib,
    rib6,
    addresses,
    tunnels,
    natInside: nat.inside,
    natOutside: nat.outside,
  };
}

/**
 * The destinations the View menu offers: every IPv4 address of a port, then every global or unique-local IPv6 address,
 * each once, in device and port order (link-local addresses are left out: they name a link, not a destination).
 */
export function routeDestinationsOf(snapshot: Pick<SimSnapshot, 'devices'>): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  const seen = new Set<string>();
  for (const d of snapshot.devices) {
    for (const p of d.ports) {
      const a = p.l3.ipv4?.address;
      if (a !== undefined && !seen.has(a)) {
        seen.add(a);
        v4.push(a);
      }
    }
  }
  for (const d of snapshot.devices) {
    for (const p of d.ports) {
      for (const a of p.l3.ipv6 ?? []) {
        if (a.scope === 'link-local') continue;
        const c = canonicalAddress(a.address);
        if (c !== null && !seen.has(c)) {
          seen.add(c);
          v6.push(c);
        }
      }
    }
  }
  return [...v4, ...v6];
}

// ── the overlay model ────────────────────────────────────────────────────────

/** One cable a hop crosses, and the way it crosses it. */
export interface RouteLinkStep {
  readonly link: LinkId;
  /** True when the hop runs from the cable's `a` end to its `b` end. */
  readonly forward: boolean;
}

/** One forwarding decision: a device sends the packet out of `iface` towards `nextHop`. */
export interface RouteHop {
  readonly from: DeviceId;
  readonly iface: PortId;
  /** The next hop (the destination itself for a connected route). */
  readonly nextHop: string;
  /** The device that owns the next hop; null when nobody in the world does (a black hole). */
  readonly to: DeviceId | null;
  /** The port of `to` the packet arrives on, when known. */
  readonly ingress?: PortId;
  /** `cable`: over the cables in `links`; `tunnel`: one hop through a tunnel; `direct`: no cable path is drawn. */
  readonly via: 'cable' | 'tunnel' | 'direct';
  readonly links: readonly RouteLinkStep[];
  /** `1/2`, `2/2` for an ECMP fan-out; '' for a single path. */
  readonly ecmp: string;
  /** Part of a forwarding loop. */
  readonly loop: boolean;
}

/** What a device does with the packet. */
export type RouteDeviceState = 'destination' | 'forward' | 'loop' | 'black-hole';

/** Why a device is a black hole. */
export type RouteBlackHoleReason = 'no-route' | 'no-next-hop' | 'down';

/** Where following a device's path ends. */
export type RouteFate = 'delivered' | 'loop' | 'black-hole';

/** One device's mark. */
export interface RouteDeviceMark {
  readonly device: DeviceId;
  readonly state: RouteDeviceState;
  /** `◎`, `↻`, `∅` or ''. */
  readonly glyph: string;
  /** The winning route, `10.0.0.0/8 via 10.0.12.2` or `connected 10.0.12.0/24` ('' for the destination or no route). */
  readonly route: string;
  readonly reason?: RouteBlackHoleReason;
  /** Where the packet ends when this device sends it. */
  readonly fate: RouteFate;
}

/** A `NAT` glyph at an inside interface on the path. */
export interface RouteNatMark {
  readonly device: DeviceId;
  readonly port: PortId;
}

/** One cable of the overlay, with the directions hops cross it in. */
export interface RouteLinkMark {
  readonly link: LinkId;
  /** A hop crosses it from `a` to `b`. */
  readonly forward: boolean;
  /** A hop crosses it from `b` to `a`. */
  readonly backward: boolean;
  /** A hop on a forwarding loop crosses it. */
  readonly loop: boolean;
}

/** The route-path overlay's full render model. */
export interface RoutePathModel {
  /** The destination drawn (canonical), or null: none chosen or not an address. */
  readonly to: string | null;
  readonly family: 4 | 6 | null;
  /** The destinations the View menu offers. */
  readonly destinations: readonly string[];
  /** Devices in snapshot order: the forwarding devices and the destination's owner. */
  readonly devices: readonly RouteDeviceMark[];
  /** Hops in device order, ECMP paths in route order. */
  readonly hops: readonly RouteHop[];
  /** Cables crossed by a hop, in snapshot order. */
  readonly links: readonly RouteLinkMark[];
  readonly nat: readonly RouteNatMark[];
}

/** Options of `buildRoutePathOverlay`. */
export interface RoutePathOptions {
  /** `topoOverlays.routeTo` (null = nothing drawn). */
  readonly to?: string | null;
}

interface PathChoice {
  readonly nextHop: string;
  readonly iface?: PortId;
}

/** The winning route of `dst` and its paths (an ECMP row gives each installed path), or null with no match. */
function lookUp(r: DeviceRoute, dst: string, family: 4 | 6): { row: RouteRow | Route6Row; paths: PathChoice[] } | null {
  const winner = family === 4 ? lpmRows(r.rib, dst).winner : lpm6Rows(r.rib6, dst).winner;
  if (winner === undefined) return null;
  const raw = winner.paths !== undefined && winner.paths.length >= 2 ? winner.paths : [{ nextHop: winner.nextHop, iface: winner.iface }];
  const paths: PathChoice[] = [];
  for (const p of raw) {
    let nh = p.nextHop === undefined ? dst : (canonicalAddress(p.nextHop) ?? p.nextHop);
    let iface = p.iface;
    // a next hop without an interface (a recursive static route): look the next hop itself up
    for (let i = 0; iface === undefined && p.nextHop !== undefined && i < RECURSION_MAX; i++) {
      const inner = family === 4 ? lpmRows(r.rib, nh).winner : lpm6Rows(r.rib6, nh).winner;
      if (inner === undefined) break;
      iface = inner.iface;
      if (iface === undefined && inner.nextHop !== undefined) nh = canonicalAddress(inner.nextHop) ?? inner.nextHop;
    }
    paths.push(iface === undefined ? { nextHop: nh } : { nextHop: nh, iface });
  }
  return { row: winner, paths };
}

function routeText(row: RouteRow | Route6Row): string {
  const net = `${row.network}/${row.prefixLen}`;
  if (row.source === 'C') return `connected ${net}`;
  const label = row.isDefault === true || row.prefixLen === 0 ? 'default' : net;
  const hops = row.paths !== undefined && row.paths.length >= 2 ? row.paths : [{ nextHop: row.nextHop, iface: row.iface }];
  const via = hops.map((h) => h.nextHop ?? h.iface ?? '?').join(', ');
  return `${label} via ${via}`;
}

interface Ends {
  /** `${device}|${port}` → the cable and that end. */
  readonly endOf: ReadonlyMap<string, { link: LinkId; end: 'a' | 'b' }>;
  readonly byId: ReadonlyMap<LinkId, SimSnapshot['links'][number]>;
}

function endsOf(snapshot: SimSnapshot): Ends {
  const endOf = new Map<string, { link: LinkId; end: 'a' | 'b' }>();
  const byId = new Map<LinkId, SimSnapshot['links'][number]>();
  for (const l of snapshot.links) {
    endOf.set(`${l.a.device}|${l.a.port}`, { link: l.id, end: 'a' });
    endOf.set(`${l.b.device}|${l.b.port}`, { link: l.id, end: 'b' });
    byId.set(l.id, l);
  }
  return { endOf, byId };
}

/** The cabled ports a packet leaving `iface` can use: the port, its parent (a subinterface), or every cabled port (an SVI). */
function exitPorts(d: DeviceSnapshot, iface: PortId, ends: Ends): PortId[] {
  const port: PortSnapshot | undefined = d.ports.find((p) => p.id === iface);
  if (ends.endOf.has(`${d.id}|${iface}`)) return [iface];
  if (port?.parent !== undefined && ends.endOf.has(`${d.id}|${port.parent}`)) return [port.parent];
  if (port === undefined || port.virtual || port.kind === 'virtual') return d.ports.filter((p) => ends.endOf.has(`${d.id}|${p.id}`)).map((p) => p.id);
  return [];
}

/**
 * The layer-2 walk from `from`'s exit ports to the first device of `targets`, crossing only bridging devices.
 * Breadth first in port and snapshot order (deterministic); null when no cable path reaches a target.
 */
function walkL2(
  from: DeviceSnapshot,
  starts: readonly PortId[],
  targets: ReadonlySet<DeviceId>,
  devices: ReadonlyMap<DeviceId, DeviceSnapshot>,
  info: (d: DeviceSnapshot) => DeviceRoute,
  ends: Ends,
): { to: DeviceId; ingress: PortId; links: RouteLinkStep[] } | null {
  interface Node {
    readonly device: DeviceId;
    readonly port: PortId;
    readonly links: RouteLinkStep[];
  }
  const seen = new Set<LinkId>();
  const queue: Node[] = [];
  const push = (device: DeviceId, port: PortId, trail: RouteLinkStep[]): void => {
    const at = ends.endOf.get(`${device}|${port}`);
    if (at === undefined || seen.has(at.link) || trail.length >= ROUTE_L2_WALK_MAX) return;
    const l = ends.byId.get(at.link);
    if (l === undefined || !l.up) return;
    seen.add(at.link);
    const far = at.end === 'a' ? l.b : l.a;
    queue.push({ device: far.device, port: far.port, links: [...trail, { link: at.link, forward: at.end === 'a' }] });
  };
  for (const p of starts) push(from.id, p, []);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as Node;
    if (targets.has(n.device)) return { to: n.device, ingress: n.port, links: n.links };
    const d = devices.get(n.device);
    if (d === undefined || d.id === from.id || !info(d).bridges || !info(d).up) continue;
    for (const p of d.ports) if (p.id !== n.port) push(d.id, p.id, n.links);
  }
  return null;
}

/** Build the route-path overlay from a snapshot. */
export function buildRoutePathOverlay(
  snapshot: SimSnapshot,
  opts: RoutePathOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceRoute = deriveDeviceRoute,
): RoutePathModel {
  const derived = new Map<DeviceSnapshot, DeviceRoute>();
  const info = (d: DeviceSnapshot): DeviceRoute => {
    let v = derived.get(d);
    if (v === undefined) derived.set(d, (v = perDevice(d)));
    return v;
  };
  const destinations = routeDestinationsOf(snapshot);
  const wanted = opts.to ?? null;
  const to = wanted === null ? null : canonicalAddress(wanted);
  const fam = to === null ? null : ipFamily(to);
  if (to === null || (fam !== 4 && fam !== 6)) return { to: null, family: null, destinations, devices: [], hops: [], links: [], nat: [] };
  const family: 4 | 6 = fam;

  const devices = new Map(snapshot.devices.map((d) => [d.id, d] as const));
  const ends = endsOf(snapshot);
  /** address → the devices that own it, in snapshot order. */
  const owners = (addr: string, except: DeviceId): DeviceId[] => {
    const out: DeviceId[] = [];
    for (const d of snapshot.devices) if (d.id !== except && info(d).addresses.has(addr)) out.push(d.id);
    return out;
  };

  const hops: RouteHop[] = [];
  const decision = new Map<DeviceId, { state: 'destination' | 'forward' | 'black-hole'; route: string; reason?: RouteBlackHoleReason }>();
  for (const d of snapshot.devices) {
    const r = info(d);
    if (r.addresses.has(to)) {
      decision.set(d.id, { state: 'destination', route: '' });
      continue;
    }
    if (!r.forwards) continue;
    if (!r.up) {
      decision.set(d.id, { state: 'black-hole', route: '', reason: 'down' });
      continue;
    }
    const found = lookUp(r, to, family);
    if (found === null) {
      decision.set(d.id, { state: 'black-hole', route: '', reason: 'no-route' });
      continue;
    }
    const n = found.paths.length;
    let resolved = 0;
    found.paths.forEach((p, i) => {
      const ecmp = n >= 2 ? `${i + 1}/${n}` : '';
      const candidates = owners(p.nextHop, d.id);
      const iface = p.iface ?? '';
      const tunnel = p.iface !== undefined && (r.tunnels.has(p.iface) || /^tunnel/i.test(p.iface));
      let hop: Omit<RouteHop, 'loop'>;
      if (candidates.length === 0) {
        hop = { from: d.id, iface, nextHop: p.nextHop, to: null, via: tunnel ? 'tunnel' : 'direct', links: [], ecmp };
      } else if (tunnel) {
        const target = candidates[0] as DeviceId;
        const ingress = devices.get(target) === undefined ? undefined : info(devices.get(target) as DeviceSnapshot).addresses.get(p.nextHop);
        hop = { from: d.id, iface, nextHop: p.nextHop, to: target, ...(ingress === undefined ? {} : { ingress }), via: 'tunnel', links: [], ecmp };
      } else {
        const walk = p.iface === undefined ? null : walkL2(d, exitPorts(d, p.iface, ends), new Set(candidates), devices, info, ends);
        if (walk !== null) {
          // the port the packet arrives on: the port owning the next hop (an SVI or subinterface) or the cable's end
          const owned = info(devices.get(walk.to) as DeviceSnapshot).addresses.get(p.nextHop);
          hop = { from: d.id, iface, nextHop: p.nextHop, to: walk.to, ingress: owned ?? walk.ingress, via: 'cable', links: walk.links, ecmp };
        } else {
          const target = candidates[0] as DeviceId;
          const owned = info(devices.get(target) as DeviceSnapshot).addresses.get(p.nextHop);
          hop = { from: d.id, iface, nextHop: p.nextHop, to: target, ...(owned === undefined ? {} : { ingress: owned }), via: 'direct', links: [], ecmp };
        }
      }
      if (hop.to !== null) resolved++;
      hops.push({ ...hop, loop: false });
    });
    decision.set(d.id, resolved === 0 ? { state: 'black-hole', route: routeText(found.row), reason: 'no-next-hop' } : { state: 'forward', route: routeText(found.row) });
  }

  // the forwarding graph and its loops (a device that can reach itself)
  const next = new Map<DeviceId, DeviceId[]>();
  for (const h of hops) if (h.to !== null) next.set(h.from, [...(next.get(h.from) ?? []), h.to]);
  const reaches = (start: DeviceId): Set<DeviceId> => {
    const seen = new Set<DeviceId>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const v = stack.pop() as DeviceId;
      if (seen.has(v)) continue;
      seen.add(v);
      for (const w of next.get(v) ?? []) stack.push(w);
    }
    return seen;
  };
  const onLoop = new Set<DeviceId>();
  for (const id of next.keys()) if (reaches(id).has(id)) onLoop.add(id);
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i] as RouteHop;
    if (h.to !== null && onLoop.has(h.from) && onLoop.has(h.to) && reaches(h.to).has(h.from)) hops[i] = { ...h, loop: true };
  }

  // where each device's packet ends (ECMP: delivered when every path delivers, else the worst outcome)
  const fateMemo = new Map<DeviceId, RouteFate>();
  const fateOf = (id: DeviceId): RouteFate => {
    const memo = fateMemo.get(id);
    if (memo !== undefined) return memo;
    const dec = decision.get(id);
    let fate: RouteFate;
    if (dec === undefined) fate = 'black-hole';
    else if (dec.state === 'destination') fate = 'delivered';
    else if (onLoop.has(id)) fate = 'loop';
    else if (dec.state === 'black-hole') fate = 'black-hole';
    else {
      const outs = hops.filter((h) => h.from === id).map((h) => (h.to === null ? 'black-hole' : fateOf(h.to)));
      fate = outs.every((f) => f === 'delivered') ? 'delivered' : outs.includes('loop') ? 'loop' : 'black-hole';
    }
    fateMemo.set(id, fate);
    return fate;
  };

  const marks: RouteDeviceMark[] = [];
  for (const d of snapshot.devices) {
    const dec = decision.get(d.id);
    if (dec === undefined) continue;
    const state: RouteDeviceState = dec.state === 'forward' && onLoop.has(d.id) ? 'loop' : dec.state;
    const glyph = state === 'destination' ? ROUTE_DESTINATION_GLYPH : state === 'loop' ? ROUTE_LOOP_GLYPH : state === 'black-hole' ? ROUTE_BLACK_HOLE_GLYPH : '';
    marks.push({ device: d.id, state, glyph, route: dec.route, ...(dec.reason === undefined ? {} : { reason: dec.reason }), fate: fateOf(d.id) });
  }

  // NAT: a hop arrives on an inside interface of a router whose own hop leaves by an outside interface
  const nat: RouteNatMark[] = [];
  const natSeen = new Set<string>();
  for (const h of hops) {
    if (h.to === null || h.ingress === undefined) continue;
    const at = devices.get(h.to);
    if (at === undefined) continue;
    const r = info(at);
    if (!r.natInside.has(h.ingress)) continue;
    if (!hops.some((o) => o.from === h.to && r.natOutside.has(o.iface))) continue;
    const key = `${h.to}|${h.ingress}`;
    if (natSeen.has(key)) continue;
    natSeen.add(key);
    nat.push({ device: h.to, port: h.ingress });
  }

  const linkDir = new Map<LinkId, { forward: boolean; backward: boolean; loop: boolean }>();
  for (const h of hops) {
    for (const s of h.links) {
      const m = linkDir.get(s.link) ?? { forward: false, backward: false, loop: false };
      linkDir.set(s.link, { forward: m.forward || s.forward, backward: m.backward || !s.forward, loop: m.loop || h.loop });
    }
  }
  const links: RouteLinkMark[] = [];
  for (const l of snapshot.links) {
    const m = linkDir.get(l.id);
    if (m !== undefined) links.push({ link: l.id, ...m });
  }
  return { to, family, destinations, devices: marks, hops, links, nat };
}
