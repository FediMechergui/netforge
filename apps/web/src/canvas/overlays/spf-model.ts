/**
 * canvas/overlays/spf-model.ts — [S3] the pure model behind the SPF stepper and the canvas `spf` layer
 * (ARCHITECTURE-P3 §6, D10, §3.1, §3.2; spec §9.7 "SPF animation").
 *
 * D10: the SPF is one pure function used three times — by the daemon, by the grader and here. This model never
 * computes a path itself: it runs `spfSteps` of `core/ospf-spf.ts` (from `@netforge/engine/pure`) over the chosen
 * router's own database, exactly as the daemon calls `runSpf` (protocols/ospf/routes.ts):
 *
 *   graph      = buildSpfGraph(the router's `ospf-lsdb` rows, area, now)       MaxAge copies left out
 *   root       = the router id in use (the `routerId` column of its `ospf-interfaces` rows)
 *   rootIfaces = its interfaces of the area that are up and addressed, in canonical port order
 *
 * so the stepper's last frame is the tree the router computes (`routing.spf-parity.test.ts`), and, once the router
 * has run SPF on the same database, the tree of its StateView (`OspfStateView.trees`, `matchesRouter`).
 *
 * - **Frames** (`spfFrame`): one per settled vertex — the vertex settled, the tree so far, the tentative list after
 *   its links were relaxed (cost and parent, with what changed this step: new, cheaper, equal-cost), and one sentence
 *   for the live region ("Step 3 of 6. R2 (2.2.2.2) settles at cost 2, reached through …. Next: …").
 * - **The canvas model** (`buildSpfOverlay`) for the frame the stepper shows: a ring per vertex where it sits on the
 *   canvas — routers on the device that uses their router id; a transit network on the switch its routers are cabled
 *   to, else at the centroid of its routers — with its status (root, settled, the one settled now, tentative) and a
 *   cost chip (`3`, tentative `3?`); and the tree underlay on the REAL cables: for each settled vertex the cable from
 *   its parent (the parent's port whose address is the link's data, or the child's on a transit network), and a thin
 *   underlay for the cable each tentative vertex is offered through.
 *
 * Every encoding keeps a non-colour channel (ring count and weight, chip text with `?` for tentative, underlay
 * thickness); nothing is a dash pattern (P2 D20). Pure: no Pixi, no React, no store; `now` is passed in. The run is
 * memoised per device object and area (and the set of LSAs at MaxAge at `now`, the only way `now` changes it).
 */
import type { DeviceId, DeviceSnapshot, Ipv4Address, LinkId, OspfAreaId, OspfStateView, PortId, PortRef, SimSnapshot, SimTime, SpfTree, SpfVertex } from '@netforge/engine';
import {
  buildSpfGraph,
  ipv4ToU32,
  maskToPrefixLen,
  spfSteps,
  u32ToIpv4,
  type SpfCandidate,
  type SpfGraph,
  type SpfRelaxOutcome,
  type SpfRootIface,
  type SpfStep,
} from '@netforge/engine/pure';
import { chooseArea, chooseRouter, isAtMaxAge, lsdbOf, lsdbRouters, routerDevices, routerName, type DeviceLsdb } from '../../routing/lsdb-model';

export type { DeviceLsdb } from '../../routing/lsdb-model';
export { deriveDeviceLsdb, lsdbOf } from '../../routing/lsdb-model';

// ── the run ──────────────────────────────────────────────────────────────────

/** One SPF run of the stepper: the chosen router's database for one area, as `spfSteps` frames. */
export interface SpfRun {
  readonly device: DeviceId;
  readonly name: string;
  readonly root: Ipv4Address;
  readonly area: OspfAreaId;
  readonly rootIfaces: readonly SpfRootIface[];
  readonly graph: SpfGraph;
  readonly steps: readonly SpfStep[];
  /** The stepper's final tree: the vertex each frame settles, in order. */
  readonly tree: SpfTree;
  /** The router's own last tree for this area (its StateView), when it has run SPF. */
  readonly routerTree?: SpfTree;
}

/** The root interfaces the daemon gives `runSpf`: the area's interfaces that are up and addressed, canonical port order. */
export function rootIfacesOf(lsdb: DeviceLsdb, area: OspfAreaId): SpfRootIface[] {
  const out: SpfRootIface[] = [];
  for (const r of lsdb.interfaces) if (r.area === area && r.state !== 'down' && r.address !== undefined) out.push({ port: r.port, address: r.address });
  return out;
}

/** The tree of `area` in the device's OSPF StateView (its last SPF run), when present. */
export function stateViewTree(d: DeviceSnapshot, area: OspfAreaId): SpfTree | undefined {
  const view = d.processes.find((p) => p.process === 'ospf');
  if (view === undefined) return undefined;
  const trees = (view.state as Partial<OspfStateView>).trees;
  if (!Array.isArray(trees)) return undefined;
  return trees.find((t) => t.area === area)?.tree;
}

const runMemo = new WeakMap<DeviceSnapshot, Map<string, SpfRun | null>>();

/** The SPF run of one device and area at `now` (undefined when the device has no router id). Memoised. */
export function spfRunFor(d: DeviceSnapshot, area: OspfAreaId, now: SimTime, perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): SpfRun | undefined {
  const lsdb = perDevice(d);
  const aged = lsdb.lsas.filter((r) => r.maxAge !== true && isAtMaxAge(r, now)).length;
  const memoKey = `${area}|${aged}`;
  let byArea = runMemo.get(d);
  const hit = byArea?.get(memoKey);
  if (hit !== undefined) return hit ?? undefined;
  const rid = lsdb.routerId;
  let run: SpfRun | null = null;
  if (rid !== undefined) {
    const graph = buildSpfGraph(lsdb.lsas, area, now);
    const rootIfaces = rootIfacesOf(lsdb, area);
    const steps = spfSteps(graph, rid, rootIfaces);
    const tree: SpfTree = { root: rid, vertices: steps.map((s) => s.settled) };
    const routerTree = stateViewTree(d, area);
    const base = { device: d.id, name: d.name, root: rid, area, rootIfaces, graph, steps, tree };
    run = routerTree === undefined ? base : { ...base, routerTree };
  }
  if (byArea === undefined) runMemo.set(d, (byArea = new Map()));
  byArea.set(memoKey, run);
  return run ?? undefined;
}

/** The run the store's selection shows (the router and area the link-state browser chose), or undefined. */
export function spfRunOf(
  snapshot: SimSnapshot | null,
  sel: { readonly device: DeviceId | null; readonly area: OspfAreaId | null },
  now: SimTime,
  perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf,
): SpfRun | undefined {
  if (snapshot === null) return undefined;
  const router = chooseRouter(lsdbRouters(snapshot, perDevice), sel.device);
  if (router === undefined) return undefined;
  const area = chooseArea(router.areas, sel.area);
  if (area === undefined) return undefined;
  const d = snapshot.devices.find((x) => x.id === router.device);
  return d === undefined ? undefined : spfRunFor(d, area, now, perDevice);
}

/** Two trees are the same: root, and every vertex (key, cost, parent, next hops) in settle order. */
export function sameTree(a: SpfTree, b: SpfTree): boolean {
  if (a.root !== b.root || a.vertices.length !== b.vertices.length) return false;
  return a.vertices.every((v, i) => {
    const w = b.vertices[i]!;
    if (v.key !== w.key || v.kind !== w.kind || v.id !== w.id || v.cost !== w.cost || v.parent !== w.parent) return false;
    if (v.nextHops.length !== w.nextHops.length) return false;
    return v.nextHops.every((h, j) => h.iface === w.nextHops[j]!.iface && h.nextHop === w.nextHops[j]!.nextHop);
  });
}

/** Whether the stepper's final tree equals the router's last SPF tree (null when the router has not run SPF). */
export function matchesRouter(run: SpfRun): boolean | null {
  return run.routerTree === undefined ? null : sameTree(run.tree, run.routerTree);
}

// ── names and sentences ──────────────────────────────────────────────────────

/** The name of a vertex: `R2 (2.2.2.2)`, or `network 10.0.123.0/24 (DR 10.0.123.2)`. */
export function vertexName(v: Pick<SpfVertex, 'kind' | 'id'>, graph: SpfGraph, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot>): string {
  if (v.kind === 'router') return routerName(v.id, devices);
  const mask = graph.networks.get(v.id)?.mask;
  const prefix = mask === undefined ? undefined : prefixOf(v.id, mask);
  return prefix === undefined ? `network of DR ${v.id}` : `network ${prefix} (DR ${v.id})`;
}

function u32(a: Ipv4Address): number {
  return ipv4ToU32(a);
}

function prefixOf(id: Ipv4Address, mask: Ipv4Address): string | undefined {
  const len = maskToPrefixLen(mask);
  return len === null ? undefined : `${u32ToIpv4((u32(id) & u32(mask)) >>> 0)}/${len}`;
}

/** What changed for a tentative vertex in this frame. */
export type SpfCandidateChange = 'new' | 'cheaper' | 'equal-cost';

/** A row of the tentative-list table. */
export interface SpfCandidateRow extends SpfCandidate {
  readonly name: string;
  readonly parentName?: string;
  readonly change?: SpfCandidateChange;
}

/** One frame of the stepper. */
export interface SpfFrame {
  /** 0-based frame index (clamped). */
  readonly index: number;
  /** Frames in the run. */
  readonly count: number;
  readonly settled: SpfVertex;
  readonly settledName: string;
  /** The tree so far: the vertices settled up to and including this frame, in order. */
  readonly tree: readonly SpfVertex[];
  /** The names of `tree`'s vertices, in the same order. */
  readonly treeNames: readonly string[];
  readonly candidates: readonly SpfCandidateRow[];
  readonly relaxed: SpfStep['relaxed'];
  /** The live-region sentence. */
  readonly sentence: string;
}

/** The step index clamped to the run's frames. */
export function clampStep(run: Pick<SpfRun, 'steps'>, step: number): number {
  const last = Math.max(0, run.steps.length - 1);
  if (!Number.isFinite(step)) return 0;
  return Math.min(last, Math.max(0, Math.trunc(step)));
}

const CHANGE_OF: Partial<Record<SpfRelaxOutcome, SpfCandidateChange>> = { new: 'new', better: 'cheaper', equal: 'equal-cost' };

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/** The frame `step` of a run (clamped), with the names of the world's routers. */
export function spfFrame(run: SpfRun, step: number, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot> = new Map()): SpfFrame {
  const index = clampStep(run, step);
  const count = run.steps.length;
  const frame = run.steps[index]!;
  const nameOfKey = new Map<string, string>();
  const name = (v: Pick<SpfVertex, 'key' | 'kind' | 'id'>): string => {
    let n = nameOfKey.get(v.key);
    if (n === undefined) nameOfKey.set(v.key, (n = vertexName(v, run.graph, devices)));
    return n;
  };
  const tree = run.steps.slice(0, index + 1).map((s) => s.settled);
  const byKey = new Map<string, Pick<SpfVertex, 'key' | 'kind' | 'id'>>();
  for (const v of tree) byKey.set(v.key, v);
  for (const c of frame.candidates) byKey.set(c.key, c);
  const keyName = (key: string): string => {
    const v = byKey.get(key);
    if (v !== undefined) return name(v);
    const kind = key.startsWith('N:') ? 'network' : 'router';
    return name({ key, kind, id: key.slice(2) });
  };
  const changes = new Map<string, SpfCandidateChange>();
  for (const r of frame.relaxed) {
    const c = CHANGE_OF[r.outcome];
    if (c !== undefined) changes.set(r.to, c);
  }
  const candidates: SpfCandidateRow[] = frame.candidates.map((c) => {
    const row: { -readonly [K in keyof SpfCandidateRow]: SpfCandidateRow[K] } = { ...c, name: name(c) };
    if (c.parent !== undefined) row.parentName = keyName(c.parent);
    const change = changes.get(c.key);
    if (change !== undefined) row.change = change;
    return row;
  });
  const v = frame.settled;
  const parts: string[] = [`Step ${index + 1} of ${count}.`];
  if (index === 0) parts.push(`${name(v)} is the root: it starts at cost 0.`);
  else parts.push(`${name(v)} settles at cost ${v.cost}${v.parent === undefined ? '' : `, reached through ${keyName(v.parent)}`}.`);
  const grouped = (outcome: SpfRelaxOutcome): typeof frame.relaxed => frame.relaxed.filter((r) => r.outcome === outcome);
  const offers = grouped('new').map((r) => `${keyName(r.to)} at ${r.cost}`);
  const cheaper = grouped('better').map((r) => `${keyName(r.to)} now at ${r.cost}`);
  const equal = grouped('equal').map((r) => `${keyName(r.to)} at ${r.cost}`);
  const oneWay = grouped('one-way').map((r) => keyName(r.to));
  const missing = grouped('missing').map((r) => keyName(r.to));
  if (offers.length > 0) parts.push(`New on the tentative list: ${listText(offers)}.`);
  if (cheaper.length > 0) parts.push(`A cheaper path: ${listText(cheaper)}.`);
  if (equal.length > 0) parts.push(`An equal-cost path: ${listText(equal)}.`);
  if (oneWay.length > 0) parts.push(`Not used, listed one way only: ${listText(oneWay)}.`);
  if (missing.length > 0) parts.push(`Not used, no LSA for ${listText(missing)}.`);
  if (offers.length + cheaper.length + equal.length === 0 && oneWay.length + missing.length === 0) parts.push('Its links offer nothing new.');
  const next = candidates[0];
  if (next !== undefined) parts.push(`Next: ${next.name} at cost ${next.cost}.`);
  else parts.push(`The tentative list is empty: the tree is complete with ${count} ${count === 1 ? 'vertex' : 'vertices'}.`);
  return { index, count, settled: v, settledName: name(v), tree, treeNames: tree.map(name), candidates, relaxed: frame.relaxed, sentence: parts.join(' ') };
}

// ── the canvas model ─────────────────────────────────────────────────────────

/** Where a vertex is drawn: on a device, or at the centroid of several (a transit network with no segment device). */
export type SpfPlace = { readonly kind: 'device'; readonly device: DeviceId } | { readonly kind: 'centroid'; readonly devices: readonly DeviceId[] };

/** One SPF vertex as the canvas draws it at the shown frame. */
export interface SpfVertexMark {
  readonly key: string;
  readonly kind: 'router' | 'network';
  readonly id: Ipv4Address;
  readonly name: string;
  /** root: the first frame's vertex; current: the one the shown frame settles; settled: before it; tentative: on the list. */
  readonly status: 'root' | 'settled' | 'current' | 'tentative';
  readonly cost: number;
  /** `3`, or `3?` while tentative. */
  readonly chip: string;
  readonly at: SpfPlace;
  readonly parent?: string;
  readonly parentName?: string;
}

/** One cable of the shown frame: in the tree, or on the path a tentative vertex is offered through. */
export interface SpfLinkMark {
  readonly link: LinkId;
  readonly status: 'tree' | 'tentative';
  /** Vertex keys of the edge the cable carries (parent → child). */
  readonly from: string;
  readonly to: string;
  /** The router port the edge leaves or enters the cable at (the one whose address is the router link's data). */
  readonly ports: readonly PortRef[];
  /** `R1 (1.1.1.1) → R2 (2.2.2.2), cost 2`. */
  readonly text: string;
}

/** The render model of the canvas `spf` layer. */
export interface SpfOverlayModel {
  readonly device: DeviceId;
  /** The root's router id. */
  readonly root: Ipv4Address;
  readonly rootName: string;
  readonly area: OspfAreaId;
  /** The shown frame (clamped) and the last one. */
  readonly step: number;
  readonly last: number;
  readonly vertices: readonly SpfVertexMark[];
  readonly links: readonly SpfLinkMark[];
  readonly sentence: string;
}

/** The chip of a vertex: its cost, with `?` while it is only tentative. */
export function spfChip(status: SpfVertexMark['status'], cost: number): string {
  return status === 'tentative' ? `${cost}?` : String(cost);
}

/** What the placement needs from the whole world. */
interface World {
  readonly devices: ReadonlyMap<Ipv4Address, DeviceSnapshot>;
  readonly byId: ReadonlyMap<DeviceId, DeviceSnapshot>;
  readonly links: ReadonlyMap<LinkId, SimSnapshot['links'][number]>;
  readonly perDevice: (d: DeviceSnapshot) => DeviceLsdb;
}

/** The cable on `device`'s port whose OSPF address is `address`. */
function linkAt(world: World, device: DeviceSnapshot, address: Ipv4Address): { link: LinkId; port: PortId } | undefined {
  const lsdb = world.perDevice(device);
  const row = lsdb.interfaces.find((r) => r.address === address);
  if (row === undefined) return undefined;
  const link = lsdb.portLinks.get(row.port);
  return link === undefined ? undefined : { link, port: row.port };
}

/** The device at the far end of a cable from `device`. */
function peerOf(world: World, link: LinkId, device: DeviceId): DeviceId | undefined {
  const l = world.links.get(link);
  if (l === undefined) return undefined;
  if (l.a.device === device) return l.b.device;
  if (l.b.device === device) return l.a.device;
  return undefined;
}

/**
 * The cables of the edge parent → child at the child's `cost`, each with the router port at its end: from a router,
 * the parent's port whose address is the link's data (the cheapest parallel link, every one at an equal cost); from a
 * transit network to a router behind it, the child's own cable onto the network (its transit link).
 */
function edgeLinks(
  world: World,
  graph: SpfGraph,
  parent: Pick<SpfVertex, 'kind' | 'id' | 'cost'>,
  child: Pick<SpfVertex, 'kind' | 'id' | 'cost'>,
): { link: LinkId; port: PortRef }[] {
  const out: { link: LinkId; port: PortRef }[] = [];
  const add = (dev: DeviceSnapshot, address: Ipv4Address): void => {
    const at = linkAt(world, dev, address);
    if (at !== undefined && !out.some((o) => o.link === at.link)) out.push({ link: at.link, port: { device: dev.id, port: at.port } });
  };
  if (parent.kind === 'router') {
    const lsa = graph.routers.get(parent.id);
    const dev = world.devices.get(parent.id);
    if (lsa === undefined || dev === undefined) return out;
    const kind = child.kind === 'router' ? 'p2p' : 'transit';
    const all = (lsa.links ?? []).filter((l) => l.kind === kind && l.id === child.id);
    const exact = all.filter((l) => parent.cost + l.metric === child.cost);
    for (const l of exact.length > 0 ? exact : all) add(dev, l.data);
  } else if (child.kind === 'router') {
    const lsa = graph.routers.get(child.id);
    const dev = world.devices.get(child.id);
    if (lsa === undefined || dev === undefined) return out;
    for (const l of lsa.links ?? []) if (l.kind === 'transit' && l.id === parent.id) add(dev, l.data);
  }
  return out;
}

/** Where a vertex sits on the canvas (undefined when no device uses its router id, or a network has no router placed). */
function placeOf(world: World, graph: SpfGraph, v: Pick<SpfVertex, 'kind' | 'id'>): SpfPlace | undefined {
  if (v.kind === 'router') {
    const d = world.devices.get(v.id);
    return d === undefined ? undefined : { kind: 'device', device: d.id };
  }
  // a transit network: the routers on it (its LSA's attached list, else the routers whose transit links name it)
  const lsa = graph.networks.get(v.id);
  const members = new Set<Ipv4Address>(lsa?.attached ?? []);
  for (const r of graph.routers.values()) if ((r.links ?? []).some((l) => l.kind === 'transit' && l.id === v.id)) members.add(r.advRouter);
  const routerDevs: DeviceId[] = [];
  const peers = new Set<DeviceId>();
  let unknownPeer = false;
  for (const rid of [...members].sort((a, b) => u32(a) - u32(b))) {
    const d = world.devices.get(rid);
    if (d === undefined) continue;
    if (!routerDevs.includes(d.id)) routerDevs.push(d.id);
    const own = graph.routers.get(rid)?.links?.find((l) => l.kind === 'transit' && l.id === v.id)?.data;
    const at = own === undefined ? undefined : linkAt(world, d, own);
    const peer = at === undefined ? undefined : peerOf(world, at.link, d.id);
    if (peer === undefined) unknownPeer = true;
    else peers.add(peer);
  }
  if (routerDevs.length === 0) return undefined;
  if (!unknownPeer && peers.size === 1) {
    const seg = [...peers][0]!;
    if (!routerDevs.includes(seg) && world.byId.has(seg)) return { kind: 'device', device: seg };
  }
  return routerDevs.length === 1 ? { kind: 'device', device: routerDevs[0]! } : { kind: 'centroid', devices: routerDevs };
}

/**
 * The canvas model for the store's selection `{device, area}` at frame `step` (clamped), or null when no router with a
 * router id is chosen (no snapshot, or no device runs OSPF).
 */
export function buildSpfOverlay(
  snapshot: SimSnapshot | null,
  sel: { readonly device: DeviceId | null; readonly area: OspfAreaId | null; readonly step: number },
  now: SimTime,
  perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf,
): SpfOverlayModel | null {
  if (snapshot === null) return null;
  const run = spfRunOf(snapshot, sel, now, perDevice);
  if (run === undefined) return null;
  const devices = routerDevices(snapshot, perDevice);
  const world: World = {
    devices,
    byId: new Map(snapshot.devices.map((d) => [d.id, d])),
    links: new Map(snapshot.links.map((l) => [l.id, l])),
    perDevice,
  };
  const frame = spfFrame(run, sel.step, devices);
  const vertices: SpfVertexMark[] = [];
  const links = new Map<LinkId, SpfLinkMark>();
  const settledByKey = new Map(frame.tree.map((v) => [v.key, v]));
  const nameOf = (key: string): string => {
    const v = settledByKey.get(key) ?? frame.candidates.find((c) => c.key === key);
    return v === undefined ? key.slice(2) : vertexName(v, run.graph, devices);
  };
  const mark = (v: Pick<SpfVertex, 'key' | 'kind' | 'id' | 'cost' | 'parent'>, status: SpfVertexMark['status']): void => {
    const at = placeOf(world, run.graph, v);
    if (at !== undefined) {
      const m: { -readonly [K in keyof SpfVertexMark]: SpfVertexMark[K] } = {
        key: v.key,
        kind: v.kind,
        id: v.id,
        name: vertexName(v, run.graph, devices),
        status,
        cost: v.cost,
        chip: spfChip(status, v.cost),
        at,
      };
      if (v.parent !== undefined) {
        m.parent = v.parent;
        m.parentName = nameOf(v.parent);
      }
      vertices.push(m);
    }
    if (v.parent === undefined) return;
    const parent = settledByKey.get(v.parent);
    if (parent === undefined) return;
    const linkStatus: SpfLinkMark['status'] = status === 'tentative' ? 'tentative' : 'tree';
    for (const { link, port } of edgeLinks(world, run.graph, parent, v)) {
      const prev = links.get(link);
      if (prev !== undefined && (prev.status === 'tree' || linkStatus === 'tentative')) continue;
      const text = `${nameOf(v.parent)} → ${vertexName(v, run.graph, devices)}, cost ${v.cost}${linkStatus === 'tentative' ? ' (tentative)' : ''}`;
      links.set(link, { link, status: linkStatus, from: v.parent, to: v.key, ports: [port], text });
    }
  };
  frame.tree.forEach((v, i) => mark(v, i === 0 ? 'root' : i === frame.index ? 'current' : 'settled'));
  for (const c of frame.candidates) mark(c, 'tentative');
  return {
    device: run.device,
    root: run.root,
    rootName: vertexName({ kind: 'router', id: run.root }, run.graph, devices),
    area: run.area,
    step: frame.index,
    last: Math.max(0, frame.count - 1),
    vertices,
    links: [...links.values()],
    sentence: frame.sentence,
  };
}
