/**
 * canvas/overlays/stp-model.ts — the pure model behind the spanning-tree overlay (ARCHITECTURE-P2 §6, D20, spec §9.6).
 *
 * For ONE VLAN at a time (the per-VLAN selector, `topoOverlays.stpVlan`; null = the lowest VLAN that has an instance):
 *
 * - the root bridge wears a crown with `ROOT v10` (every bridge whose `stp-bridge` row says `isRoot`; after
 *   convergence that is exactly one);
 * - every linked port that is a spanning-tree port gets its role letter R/D/A/B and a state glyph: a cross on blocking
 *   or discarding, a hollow circle on listening, a half circle on learning, nothing on forwarding;
 * - the active tree is the set of links whose spanning-tree ends all forward (a thick underlay); a blocked link has a
 *   cross at its blocked end and no underlay (never a dash pattern, D20);
 * - a port in a timed phase (forward delay) carries a draining bar: the fraction of the phase still to run, from
 *   `stateSince` and `nextTransitionAt` (§10.2: 0.5 at `stateSince + 7.5 s` of a 15 s phase);
 * - each bridge's topology-change counter and last change port feed the change wave (`newTopologyChanges`), which the
 *   W3 layer plays as the markers.ts starburst.
 *
 * Bundles: bundled members have no `stp` row (§2.6); the Port-channel has it. A link on a bundled member therefore
 * shows the bundle's role and state (`viaBundle`), read through the member's `PortSnapshot.l2.channel`.
 *
 * Reads the `stp` / `stp-bridge` rows only (D20). Pure: no Pixi, no store; `now` is passed in. `deriveDeviceStp`
 * depends on one device object only, so the registry memoises it per device object.
 */
import type {
  DeviceId,
  DeviceSnapshot,
  LinkId,
  PortId,
  SimSnapshot,
  SimTime,
  StpBridgeRow,
  StpInconsistency,
  StpPortRow,
  StpRole,
  StpState,
} from '@netforge/engine';

// ── glyphs ───────────────────────────────────────────────────────────────────

/** Role letters of spec §9.6 (R/D/A/B); a disabled port shows a dash. */
export const STP_ROLE_LETTER: Readonly<Record<StpRole, string>> = Object.freeze({
  root: 'R',
  designated: 'D',
  alternate: 'A',
  backup: 'B',
  disabled: '–',
});

/** State glyphs: a cross where frames are held, open and half circles while the port starts, nothing when forwarding. */
export const STP_STATE_GLYPH: Readonly<Record<StpState, string>> = Object.freeze({
  blocking: '✕',
  discarding: '✕',
  listening: '○',
  learning: '◐',
  forwarding: '',
  disabled: '–',
});

/** Glyph of an inconsistent port (root guard, pvid, type), drawn beside the cross. */
export const STP_INCONSISTENT_GLYPH = '!';

/** Role letter of a role (the raw role when unknown). */
export function roleLetter(role: string): string {
  return Object.prototype.hasOwnProperty.call(STP_ROLE_LETTER, role) ? STP_ROLE_LETTER[role as StpRole] : role;
}

/** State glyph of a state ('' when unknown). */
export function stateGlyph(state: string): string {
  return Object.prototype.hasOwnProperty.call(STP_STATE_GLYPH, state) ? STP_STATE_GLYPH[state as StpState] : '';
}

/** True when a port in this state holds data frames (blocking or discarding: the cross). */
export function isBlockedState(state: string): boolean {
  return state === 'blocking' || state === 'discarding';
}

/** Crown label of a root bridge: `ROOT v10`. */
export function rootLabel(vlan: number): string {
  return `ROOT v${vlan}`;
}

/**
 * The draining bar: the fraction (1 → 0) of the current timed phase still to run, or undefined when no timed change is
 * pending (or the phase has no length). Clamped to [0, 1].
 */
export function drainFraction(row: Pick<StpPortRow, 'stateSince' | 'nextTransitionAt'>, now: SimTime): number | undefined {
  const next = row.nextTransitionAt;
  if (next === undefined) return undefined;
  const span = next - row.stateSince;
  if (!(span > 0)) return undefined;
  const left = (next - now) / span;
  return left <= 0 ? 0 : left >= 1 ? 1 : left;
}

// ── per device ───────────────────────────────────────────────────────────────

/** A device's spanning-tree rows, by VLAN. */
export interface DeviceStp {
  /** `stp-bridge` rows by VLAN. */
  readonly bridges: ReadonlyMap<number, StpBridgeRow>;
  /** `stp` rows by VLAN, then by port. */
  readonly ports: ReadonlyMap<number, ReadonlyMap<PortId, StpPortRow>>;
  /** Bundled member → its Port-channel (members have no `stp` row of their own). */
  readonly bundleOf: ReadonlyMap<PortId, PortId>;
}

const EMPTY_STP: DeviceStp = Object.freeze({ bridges: new Map(), ports: new Map(), bundleOf: new Map() });

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows ?? [];
}

function isPortRow(r: Record<string, unknown>): boolean {
  return typeof r.vlan === 'number' && typeof r.port === 'string' && typeof r.role === 'string' && typeof r.state === 'string';
}

function isBridgeRow(r: Record<string, unknown>): boolean {
  return typeof r.vlan === 'number' && typeof r.isRoot === 'boolean';
}

/** Derive a device's spanning-tree rows. Pure in the device object. */
export function deriveDeviceStp(d: DeviceSnapshot): DeviceStp {
  const portRows = rowsOf(d, 'stp');
  const bridgeRows = rowsOf(d, 'stp-bridge');
  const bundleOf = new Map<PortId, PortId>();
  for (const p of d.ports) {
    const ch = p.l2?.channel;
    if (ch !== undefined && ch.state === 'bundled') bundleOf.set(p.id, ch.bundle);
  }
  if (portRows.length === 0 && bridgeRows.length === 0 && bundleOf.size === 0) return EMPTY_STP;
  const bridges = new Map<number, StpBridgeRow>();
  for (const r of bridgeRows) if (isBridgeRow(r)) bridges.set(r.vlan as number, r as unknown as StpBridgeRow);
  const ports = new Map<number, Map<PortId, StpPortRow>>();
  for (const r of portRows) {
    if (!isPortRow(r)) continue;
    const row = r as unknown as StpPortRow;
    let byPort = ports.get(row.vlan);
    if (byPort === undefined) ports.set(row.vlan, (byPort = new Map()));
    byPort.set(row.port, row);
  }
  return { bridges, ports, bundleOf };
}

/** The row of `port` in `vlan`, through its bundle when the port is a bundled member. */
export function stpRowFor(stp: DeviceStp, vlan: number, port: PortId): { row: StpPortRow; viaBundle?: PortId } | undefined {
  const byPort = stp.ports.get(vlan);
  if (byPort === undefined) return undefined;
  const own = byPort.get(port);
  if (own !== undefined) return { row: own };
  const bundle = stp.bundleOf.get(port);
  if (bundle === undefined) return undefined;
  const row = byPort.get(bundle);
  return row === undefined ? undefined : { row, viaBundle: bundle };
}

/** Every VLAN with a spanning-tree instance on some device, ascending. */
export function stpVlansOf(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceStp = deriveDeviceStp): number[] {
  const out = new Set<number>();
  for (const d of snapshot.devices) for (const v of perDevice(d).bridges.keys()) out.add(v);
  return [...out].sort((a, b) => a - b);
}

/** The VLAN the overlay draws: the wanted one when it has an instance, else the lowest; null when none has one. */
export function chooseStpVlan(vlans: readonly number[], wanted: number | null | undefined): number | null {
  if (wanted !== null && wanted !== undefined && vlans.includes(wanted)) return wanted;
  return vlans[0] ?? null;
}

// ── the overlay model ────────────────────────────────────────────────────────

/** A crowned root bridge. */
export interface StpRootMark {
  readonly device: DeviceId;
  readonly vlan: number;
  readonly label: string;
  readonly bridgeId: string;
}

/** One linked spanning-tree port. */
export interface StpPortMark {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link: LinkId;
  readonly end: 'a' | 'b';
  readonly vlan: number;
  readonly role: StpRole;
  readonly letter: string;
  readonly state: StpState;
  readonly glyph: string;
  /** Blocking or discarding: the cross. */
  readonly blocked: boolean;
  readonly edge: boolean;
  readonly protocol: StpPortRow['protocol'];
  readonly inconsistent?: StpInconsistency;
  /** Draining bar fraction still to run (1 → 0) while a forward-delay phase runs. */
  readonly drain?: number;
  /** The Port-channel whose row this member shows. */
  readonly viaBundle?: PortId;
}

/** How a link sits in the tree of the drawn VLAN. */
export type StpLinkStatus = 'active' | 'blocked' | 'converging' | 'none';

/** One link of the overlay. */
export interface StpLinkMark {
  readonly link: LinkId;
  /** active: every spanning-tree end forwards (thick underlay); blocked: some end holds frames (cross, no underlay);
   *  converging: some end is still listening or learning; none: the link is down, or no end is a spanning-tree port
   *  in this VLAN. */
  readonly status: StpLinkStatus;
  /** Ends that hold frames. */
  readonly blockedEnds: readonly ('a' | 'b')[];
}

/** A bridge's topology-change record in the drawn VLAN (the change wave's source). */
export interface StpChangeMark {
  readonly device: DeviceId;
  readonly vlan: number;
  readonly count: number;
  readonly at?: SimTime;
  readonly port?: PortId;
}

/** The spanning-tree overlay's full render model. */
export interface StpOverlayModel {
  /** The VLAN drawn, or null when no VLAN has an instance (empty overlay). */
  readonly vlan: number | null;
  /** VLANs the per-VLAN selector offers, ascending. */
  readonly vlans: readonly number[];
  readonly roots: readonly StpRootMark[];
  readonly ports: readonly StpPortMark[];
  readonly links: readonly StpLinkMark[];
  readonly changes: readonly StpChangeMark[];
}

/** Options of `buildStpOverlay`. */
export interface StpOverlayOptions {
  /** `topoOverlays.stpVlan` (null = the lowest VLAN with an instance). */
  readonly vlan?: number | null;
  /** Current sim time (draining bars). */
  readonly now: SimTime;
}

/**
 * Build the spanning-tree overlay from a snapshot. Devices in snapshot order, links in snapshot order, ends a then b.
 */
export function buildStpOverlay(
  snapshot: SimSnapshot,
  opts: StpOverlayOptions,
  perDevice: (d: DeviceSnapshot) => DeviceStp = deriveDeviceStp,
): StpOverlayModel {
  const vlans = stpVlansOf(snapshot, perDevice);
  const vlan = chooseStpVlan(vlans, opts.vlan);
  if (vlan === null) return { vlan: null, vlans, roots: [], ports: [], links: [], changes: [] };

  const byId = new Map<DeviceId, DeviceSnapshot>();
  for (const d of snapshot.devices) byId.set(d.id, d);

  const roots: StpRootMark[] = [];
  const changes: StpChangeMark[] = [];
  for (const d of snapshot.devices) {
    const bridge = perDevice(d).bridges.get(vlan);
    if (bridge === undefined) continue;
    if (bridge.isRoot) roots.push({ device: d.id, vlan, label: rootLabel(vlan), bridgeId: bridge.bridgeId });
    const change: StpChangeMark = {
      device: d.id,
      vlan,
      count: bridge.topologyChanges ?? 0,
      ...(bridge.lastChangeAt === undefined ? {} : { at: bridge.lastChangeAt }),
      ...(bridge.lastChangePort === undefined ? {} : { port: bridge.lastChangePort }),
    };
    changes.push(change);
  }

  const ports: StpPortMark[] = [];
  const links: StpLinkMark[] = [];
  for (const link of snapshot.links) {
    const ends: ('a' | 'b')[] = ['a', 'b'];
    const marks: StpPortMark[] = [];
    for (const side of ends) {
      const ref = link[side];
      const d = byId.get(ref.device);
      if (d === undefined) continue;
      const found = stpRowFor(perDevice(d), vlan, ref.port);
      if (found === undefined) continue;
      const { row, viaBundle } = found;
      const drain = drainFraction(row, opts.now);
      const mark: StpPortMark = {
        device: d.id,
        port: ref.port,
        link: link.id,
        end: side,
        vlan,
        role: row.role,
        letter: roleLetter(row.role),
        state: row.state,
        glyph: stateGlyph(row.state),
        blocked: isBlockedState(row.state),
        edge: row.edge === true,
        protocol: row.protocol,
        ...(row.inconsistent === undefined ? {} : { inconsistent: row.inconsistent }),
        ...(drain === undefined ? {} : { drain }),
        ...(viaBundle === undefined ? {} : { viaBundle }),
      };
      marks.push(mark);
      ports.push(mark);
    }
    const blockedEnds = marks.filter((m) => m.blocked).map((m) => m.end);
    let status: StpLinkStatus;
    if (marks.length === 0 || !link.up) status = 'none';
    else if (blockedEnds.length > 0) status = 'blocked';
    else if (marks.every((m) => m.state === 'forwarding')) status = 'active';
    else status = 'converging';
    links.push({ link: link.id, status, blockedEnds });
  }
  return { vlan, vlans, roots, ports, links, changes };
}

/**
 * Topology changes that happened between two models of the same VLAN: each bridge whose counter went up (or that is
 * new with a non-zero counter). The W3 layer spawns the change wave at the bridge's `port` (its last change port).
 * A VLAN switch in the selector is not a change: with different VLANs the result is empty.
 */
export function newTopologyChanges(prev: StpOverlayModel | null, next: StpOverlayModel): StpChangeMark[] {
  if (prev === null || prev.vlan !== next.vlan) return [];
  const before = new Map<DeviceId, number>();
  for (const c of prev.changes) before.set(c.device, c.count);
  return next.changes.filter((c) => c.count > (before.get(c.device) ?? 0));
}
