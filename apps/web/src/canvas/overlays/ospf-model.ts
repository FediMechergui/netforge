/**
 * canvas/overlays/ospf-model.ts — [S1] the pure model behind the OSPF overlay (ARCHITECTURE-P3 §6, §3.1, §3.2; spec §9.6
 * "OSPF": areas as translucent zones, adjacency links weighted, state on the cables).
 *
 * From the `ospf-interfaces` and `ospf-neighbors` rows only (§2.6; D24):
 *
 * - an **adjacency underlay** per cable from both ends' rows: thick when FULL; thin with a `2W` chip at 2-Way (two
 *   DROthers on a LAN stay there); thin with a pulsing `IN` / `XS` / `XC` / `LD` chip while the adjacency is being built
 *   (Init, ExStart, Exchange, Loading), static under reduced motion; nothing when there is no neighbour. A cable between
 *   two OSPF interfaces takes the less advanced of the two ends' views of each other; a cable from a router to a switch
 *   (a LAN segment) takes the router's most advanced neighbour on that port;
 * - at each OSPF port anchor: `DR` / `BDR` letters on a multi-access segment, the cost chip `c64`, `P` for a passive
 *   interface, `!` with the refusal reason of the last refused hello, and the draining bar while the interface is
 *   Waiting (the fraction of the 40 s wait still to run, `stateSince` → `waitUntil`: 0.5 in the middle);
 * - **area zones**: the devices with an interface in each area, labelled `Area 0` (the W3 layer draws a translucent
 *   hull; a selected area — `topoOverlays.ospfArea` — keeps only its marks).
 *
 * Every encoding keeps a non-colour channel (chip text, letters, glyphs, underlay thickness); nothing is a dash pattern
 * (P2 D20). Pure: no Pixi, no store; `now` is passed in. `deriveDeviceOspf` depends on one device object only, so the W3
 * registry entry memoises it per device object.
 */
import type {
  DeviceId,
  DeviceSnapshot,
  Ipv4Address,
  LinkId,
  OspfAreaId,
  OspfInterfaceRow,
  OspfIsmState,
  OspfNeighborRow,
  OspfNetworkType,
  OspfNsmState,
  PortId,
  SimSnapshot,
  SimTime,
} from '@netforge/engine';

// ── glyphs and words ─────────────────────────────────────────────────────────

/** Chips of the neighbour states on the underlay; FULL has none (the thick underlay says it), Down draws nothing. */
export const OSPF_NBR_CHIP: Readonly<Record<OspfNsmState, string>> = Object.freeze({
  down: '',
  attempt: 'AT',
  init: 'IN',
  '2way': '2W',
  exstart: 'XS',
  exchange: 'XC',
  loading: 'LD',
  full: '',
});

/** Progress of a neighbour state (RFC 2328 order): the less advanced end decides a cable between two OSPF ports. */
export const OSPF_NBR_RANK: Readonly<Record<OspfNsmState, number>> = Object.freeze({
  down: 0,
  attempt: 1,
  init: 2,
  '2way': 3,
  exstart: 4,
  exchange: 5,
  loading: 6,
  full: 7,
});

/** Role letters at a multi-access port anchor: DR and BDR only (a DROther shows none). */
export const OSPF_ROLE_LETTER: Readonly<Record<OspfIsmState, string>> = Object.freeze({
  down: '',
  loopback: '',
  waiting: '',
  'point-to-point': '',
  drother: '',
  backup: 'BDR',
  dr: 'DR',
});

/** Glyph of a passive interface. */
export const OSPF_PASSIVE_GLYPH = 'P';
/** Glyph of an interface whose last hello from a neighbour was refused. */
export const OSPF_REFUSED_GLYPH = '!';

/** True for the states an adjacency passes through on its way to FULL (Init … Loading): their chips pulse. */
export function isTransientNbrState(state: OspfNsmState): boolean {
  const r = OSPF_NBR_RANK[state];
  return r > 0 && r < OSPF_NBR_RANK.full && state !== '2way';
}

/** The chip of a neighbour state ('' for Down and Full, the raw word when unknown). */
export function nbrChip(state: string): string {
  return Object.prototype.hasOwnProperty.call(OSPF_NBR_CHIP, state) ? OSPF_NBR_CHIP[state as OspfNsmState] : state;
}

/** Cost chip: `c64`. */
export function costChip(cost: number): string {
  return `c${cost}`;
}

/** Numeric value of a dotted area id (0.0.0.1 → 1), or NaN when it is not dotted. */
function areaNumber(area: OspfAreaId): number {
  const parts = area.split('.');
  if (parts.length !== 4) return Number.NaN;
  let v = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return Number.NaN;
    v = v * 256 + o;
  }
  return v;
}

/**
 * Zone label of an area: `Area 0` for 0.0.0.0, `Area 1` for 0.0.0.1 — the decimal form whenever the first three
 * octets are 0 — and `Area 10.0.0.0` otherwise (the form a learner typed is not in the row, only the dotted id).
 */
export function areaLabel(area: OspfAreaId): string {
  const n = areaNumber(area);
  return Number.isNaN(n) || n > 255 ? `Area ${area}` : `Area ${n}`;
}

/** Sort key of areas: numeric, then text for anything that is not dotted. */
function compareAreas(a: OspfAreaId, b: OspfAreaId): number {
  const x = areaNumber(a);
  const y = areaNumber(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The draining bar of a Waiting interface: the fraction (1 → 0) of the wait still to run, from `stateSince` to
 * `waitUntil`; undefined when the interface is not Waiting or the row has no wait. Clamped to [0, 1].
 */
export function waitDrainFraction(row: Pick<OspfInterfaceRow, 'state' | 'stateSince' | 'waitUntil'>, now: SimTime): number | undefined {
  if (row.state !== 'waiting' || row.waitUntil === undefined) return undefined;
  const span = row.waitUntil - row.stateSince;
  if (!(span > 0)) return undefined;
  const left = (row.waitUntil - now) / span;
  return left <= 0 ? 0 : left >= 1 ? 1 : left;
}

// ── per device ───────────────────────────────────────────────────────────────

/** A device's OSPF rows. */
export interface DeviceOspf {
  /** `ospf-interfaces` rows by port, in row order. */
  readonly interfaces: ReadonlyMap<PortId, OspfInterfaceRow>;
  /** `ospf-neighbors` rows by port, in row order. */
  readonly neighbors: ReadonlyMap<PortId, readonly OspfNeighborRow[]>;
  /** The router id in use (from any interface row), when OSPF runs. */
  readonly routerId?: Ipv4Address;
}

const EMPTY_OSPF: DeviceOspf = Object.freeze({ interfaces: new Map(), neighbors: new Map() });

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows ?? [];
}

function isInterfaceRow(r: Record<string, unknown>): boolean {
  return typeof r.port === 'string' && typeof r.area === 'string' && typeof r.state === 'string' && typeof r.cost === 'number';
}

function isNeighborRow(r: Record<string, unknown>): boolean {
  return typeof r.port === 'string' && typeof r.routerId === 'string' && typeof r.state === 'string';
}

/** Derive a device's OSPF rows. Pure in the device object. */
export function deriveDeviceOspf(d: DeviceSnapshot): DeviceOspf {
  const ifRows = rowsOf(d, 'ospf-interfaces');
  if (ifRows.length === 0) return EMPTY_OSPF;
  const interfaces = new Map<PortId, OspfInterfaceRow>();
  let routerId: Ipv4Address | undefined;
  for (const r of ifRows) {
    if (!isInterfaceRow(r)) continue;
    const row = r as unknown as OspfInterfaceRow;
    interfaces.set(row.port, row);
    if (routerId === undefined && typeof row.routerId === 'string' && row.routerId !== '') routerId = row.routerId;
  }
  const neighbors = new Map<PortId, OspfNeighborRow[]>();
  for (const r of rowsOf(d, 'ospf-neighbors')) {
    if (!isNeighborRow(r)) continue;
    const row = r as unknown as OspfNeighborRow;
    let list = neighbors.get(row.port);
    if (list === undefined) neighbors.set(row.port, (list = []));
    list.push(row);
  }
  return routerId === undefined ? { interfaces, neighbors } : { interfaces, neighbors, routerId };
}

/** Every area with an OSPF interface on some device, in numeric order. */
export function ospfAreasOf(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceOspf = deriveDeviceOspf): OspfAreaId[] {
  const out = new Set<OspfAreaId>();
  for (const d of snapshot.devices) for (const row of perDevice(d).interfaces.values()) out.add(row.area);
  return [...out].sort(compareAreas);
}

/** The area the overlay keeps: the wanted one when some interface is in it, else null (every area). */
export function chooseOspfArea(areas: readonly OspfAreaId[], wanted: OspfAreaId | null | undefined): OspfAreaId | null {
  return wanted !== null && wanted !== undefined && areas.includes(wanted) ? wanted : null;
}

// ── the overlay model ────────────────────────────────────────────────────────

/** A refused hello at a port. */
export interface OspfRefusal {
  readonly glyph: string;
  readonly reason: string;
  readonly from: Ipv4Address;
  readonly routerId: Ipv4Address;
  readonly at: SimTime;
}

/** One OSPF interface (drawn at its port anchor when it is cabled). */
export interface OspfPortMark {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  readonly area: OspfAreaId;
  readonly state: OspfIsmState;
  readonly networkType: OspfNetworkType;
  /** `DR`, `BDR` or ''. */
  readonly role: string;
  readonly cost: number;
  /** `c64`. */
  readonly costChip: string;
  readonly passive: boolean;
  /** `P` or ''. */
  readonly passiveGlyph: string;
  /** Draining bar fraction (1 → 0) while Waiting. */
  readonly drain?: number;
  /** The last refused hello (`!` with the reason). */
  readonly refused?: OspfRefusal;
  readonly neighbors: number;
  readonly adjacent: number;
}

/** How a cable's adjacency is drawn. */
export type OspfLinkWeight = 'thick' | 'thin' | 'none';

/** One cable of the overlay. */
export interface OspfLinkMark {
  readonly link: LinkId;
  /** The adjacency state the cable shows ('none': the cable is down or has no OSPF end in the drawn area). */
  readonly state: OspfNsmState | 'none';
  /** thick: FULL; thin: 2-Way or being built; none: nothing to draw. */
  readonly weight: OspfLinkWeight;
  /** `2W`, `IN`, `XS`, `XC`, `LD` (or '' for FULL and nothing). */
  readonly chip: string;
  /** The chip pulses (Init … Loading), unless reduced motion is on: then it is static. */
  readonly pulse: boolean;
  /** The ends that are OSPF interfaces. */
  readonly ends: readonly ('a' | 'b')[];
}

/** One area zone. */
export interface OspfAreaZone {
  readonly area: OspfAreaId;
  /** `Area 0`. */
  readonly label: string;
  /** Devices with an interface in the area, in snapshot order. */
  readonly devices: readonly DeviceId[];
}

/** The OSPF overlay's full render model. */
export interface OspfOverlayModel {
  /** The area kept (null: every area). */
  readonly area: OspfAreaId | null;
  /** Areas the selector offers, in numeric order. */
  readonly areas: readonly OspfAreaId[];
  readonly zones: readonly OspfAreaZone[];
  readonly ports: readonly OspfPortMark[];
  readonly links: readonly OspfLinkMark[];
}

/** Options of `buildOspfOverlay`. */
export interface OspfOverlayOptions {
  /** `topoOverlays.ospfArea` (null = every area). */
  readonly area?: OspfAreaId | null;
  /** Current sim time (draining bars). */
  readonly now: SimTime;
  /** `prefers-reduced-motion`: chips never pulse. */
  readonly reducedMotion?: boolean;
}

function weightOf(state: OspfNsmState | 'none'): OspfLinkWeight {
  if (state === 'none' || state === 'down') return 'none';
  return state === 'full' ? 'thick' : 'thin';
}

/** The state an OSPF end shows toward its cable (see the header). */
function endState(own: DeviceOspf, port: PortId, far: { ospf: DeviceOspf; isOspfPort: boolean } | undefined): OspfNsmState {
  const rows = own.neighbors.get(port) ?? [];
  if (far !== undefined && far.isOspfPort && far.ospf.routerId !== undefined) {
    const toFar = rows.find((r) => r.routerId === far.ospf.routerId);
    return toFar === undefined ? 'down' : toFar.state;
  }
  let best: OspfNsmState = 'down';
  for (const r of rows) if ((OSPF_NBR_RANK[r.state] ?? 0) > OSPF_NBR_RANK[best]) best = r.state;
  return best;
}

/** Build the OSPF overlay from a snapshot. Devices in snapshot order; ports in row order; links in snapshot order. */
export function buildOspfOverlay(
  snapshot: SimSnapshot,
  opts: OspfOverlayOptions,
  derive: (d: DeviceSnapshot) => DeviceOspf = deriveDeviceOspf,
): OspfOverlayModel {
  const derived = new Map<DeviceSnapshot, DeviceOspf>();
  const perDevice = (d: DeviceSnapshot): DeviceOspf => {
    let v = derived.get(d);
    if (v === undefined) derived.set(d, (v = derive(d)));
    return v;
  };
  const areas = ospfAreasOf(snapshot, perDevice);
  const area = chooseOspfArea(areas, opts.area);
  if (areas.length === 0) return { area: null, areas, zones: [], ports: [], links: [] };
  const inArea = (row: OspfInterfaceRow): boolean => area === null || row.area === area;

  const byId = new Map<DeviceId, DeviceSnapshot>();
  for (const d of snapshot.devices) byId.set(d.id, d);
  const endOf = new Map<string, { link: LinkId; end: 'a' | 'b' }>();
  for (const l of snapshot.links) {
    endOf.set(`${l.a.device}|${l.a.port}`, { link: l.id, end: 'a' });
    endOf.set(`${l.b.device}|${l.b.port}`, { link: l.id, end: 'b' });
  }

  const zones: OspfAreaZone[] = [];
  for (const a of area === null ? areas : [area]) {
    const devices: DeviceId[] = [];
    for (const d of snapshot.devices) {
      for (const row of perDevice(d).interfaces.values()) {
        if (row.area === a) {
          devices.push(d.id);
          break;
        }
      }
    }
    zones.push({ area: a, label: areaLabel(a), devices });
  }

  const ports: OspfPortMark[] = [];
  for (const d of snapshot.devices) {
    for (const row of perDevice(d).interfaces.values()) {
      if (!inArea(row)) continue;
      const at = endOf.get(`${d.id}|${row.port}`);
      const drain = waitDrainFraction(row, opts.now);
      const refused: OspfRefusal | undefined =
        row.rejected === undefined
          ? undefined
          : { glyph: OSPF_REFUSED_GLYPH, reason: row.rejected.reason, from: row.rejected.from, routerId: row.rejected.routerId, at: row.rejected.at };
      ports.push({
        device: d.id,
        port: row.port,
        ...(at === undefined ? {} : { link: at.link, end: at.end }),
        area: row.area,
        state: row.state,
        networkType: row.networkType,
        role: OSPF_ROLE_LETTER[row.state] ?? '',
        cost: row.cost,
        costChip: costChip(row.cost),
        passive: row.passive === true,
        passiveGlyph: row.passive === true ? OSPF_PASSIVE_GLYPH : '',
        ...(drain === undefined ? {} : { drain }),
        ...(refused === undefined ? {} : { refused }),
        neighbors: typeof row.neighbors === 'number' ? row.neighbors : 0,
        adjacent: typeof row.adjacent === 'number' ? row.adjacent : 0,
      });
    }
  }

  const links: OspfLinkMark[] = [];
  for (const l of snapshot.links) {
    const sides = { a: l.a, b: l.b } as const;
    const info = (['a', 'b'] as const).map((side) => {
      const ref = sides[side];
      const d = byId.get(ref.device);
      const ospf = d === undefined ? EMPTY_OSPF : perDevice(d);
      const row = ospf.interfaces.get(ref.port);
      return { side, ref, ospf, row, isOspfPort: row !== undefined && inArea(row) };
    });
    const ospfEnds = info.filter((e) => e.isOspfPort);
    if (ospfEnds.length === 0) continue;
    let state: OspfNsmState | 'none' = 'none';
    if (l.up) {
      let lowest: OspfNsmState | undefined;
      for (const e of ospfEnds) {
        const far = info.find((o) => o.side !== e.side);
        const farView = far === undefined || far.ref.device === e.ref.device ? undefined : { ospf: far.ospf, isOspfPort: far.isOspfPort };
        const s = endState(e.ospf, e.ref.port, farView);
        if (lowest === undefined || OSPF_NBR_RANK[s] < OSPF_NBR_RANK[lowest]) lowest = s;
      }
      state = lowest ?? 'none';
    }
    const weight = weightOf(state);
    const chip = weight === 'none' || state === 'none' ? '' : nbrChip(state);
    links.push({
      link: l.id,
      state,
      weight,
      chip,
      pulse: state !== 'none' && isTransientNbrState(state) && opts.reducedMotion !== true,
      ends: ospfEnds.map((e) => e.side),
    });
  }
  return { area, areas, zones, ports, links };
}
