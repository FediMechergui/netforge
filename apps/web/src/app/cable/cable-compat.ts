/**
 * Cable picker model (ARCHITECTURE-P1 §7 "Cable picker", §8.1 W2 web-inspector).
 *
 * Pure helpers behind the media flyout and the cable tool:
 *  - the picker items (media vocabulary in MEDIA_PICKER_ORDER, filtered by the media table the worker sent);
 *  - per-port compatibility for the chosen media, so the canvas port picker can grey out ports a cable cannot
 *    reach. The verdict comes from the ENGINE's pure cable validator (`checkCable`), fed with per-port data
 *    from the snapshot (role, connector, wiring, auto-MDIX, transceiver) and the catalog, so the picker and
 *    `validateLink` never disagree;
 *  - the serial DCE-end hint (which clicked port receives the clock-supplying end);
 *  - the `AddLinkSpec` the tool sends and a cache key that includes the media (a media change while hovering
 *    must never reuse a stale verdict).
 *
 * The canvas and the flyout (CablePicker.tsx, W6) render these results; nothing here branches on device kind
 * (D2/D3). All wording is original (§1.6).
 */
import { MEDIA, ROLE_TRAITS, checkCable, linkKindOf, portKey } from '@netforge/engine';
import type {
  AddLinkSpec,
  CableProblem,
  CableValidation,
  DeviceModel,
  DeviceSnapshot,
  MediaSpec,
  MediaType,
  ModuleModel,
  PortKind,
  PortRef,
  PortSnapshot,
  PortSpec,
  SimSnapshot,
} from '@netforge/engine';
import { MEDIA_PICKER_ORDER, MEDIA_VOCAB } from '../../vocab/media.js';
import type { MediaStroke } from '../../vocab/media.js';
import { portKindLabel } from '../../vocab/categories.js';

/** Default cable length (metres) the engine applies when `AddLinkSpec.lengthM` is omitted. */
export const DEFAULT_CABLE_LENGTH_M = 3;

/** A concrete (non-auto) media type. */
export type ResolvedMedia = Exclude<MediaType, 'auto'>;

/** One cable end as the engine validator reads it. */
export type CableEnd = Parameters<typeof checkCable>[0];

// ── picker items ─────────────────────────────────────────────────────────────

/** One row of the media flyout. */
export interface CablePickerItem {
  readonly media: MediaType;
  readonly label: string;
  readonly badge: string;
  readonly description: string;
  /** Serial media: which clicked end becomes DCE. */
  readonly dceHint?: string;
  /** Line glyph drawn in the row (same channel as the canvas cable). */
  readonly stroke: MediaStroke;
  readonly dash: readonly number[];
  /** The engine's media table offers this media (false rows are shown disabled). */
  readonly available: boolean;
}

/**
 * Flyout rows in MEDIA_PICKER_ORDER ('auto' first). `table` is `InitResult.media` when the worker sent it; a
 * media missing from it is marked unavailable. Without a table, every picker media is available.
 */
export function cablePickerItems(table?: readonly Pick<MediaSpec, 'media'>[]): readonly CablePickerItem[] {
  const offered = table === undefined ? undefined : new Set(table.map((m) => m.media));
  return Object.freeze(
    MEDIA_PICKER_ORDER.map((media) => {
      const v = MEDIA_VOCAB[media];
      const base = {
        media,
        label: v.short,
        badge: v.badge,
        description: v.description,
        stroke: v.stroke,
        dash: v.dash,
        available: offered === undefined || offered.has(media),
      };
      return Object.freeze(v.dceHint === undefined ? base : { ...base, dceHint: v.dceHint });
    }),
  );
}

/** Media to use when the persisted choice is unknown or unavailable: the choice itself, else 'auto'. */
export function effectiveCableMedia(choice: string | undefined, table?: readonly Pick<MediaSpec, 'media'>[]): MediaType {
  const items = cablePickerItems(table);
  const hit = items.find((i) => i.media === choice && i.available);
  return hit !== undefined ? hit.media : 'auto';
}

/** Whether a media's port-kind rule admits a port kind ('auto' admits every kind a cable can take). */
export function mediaFitsPortKind(media: MediaType, kind: PortKind): boolean {
  if (media === 'auto') return kind !== 'wlan' && kind !== 'cellular' && kind !== 'virtual';
  return MEDIA[media].portKinds.includes(kind);
}

// ── catalog lookup ───────────────────────────────────────────────────────────

/** Catalog data the compatibility check reads beside the snapshot. */
export interface CableLookup {
  model(type: string): DeviceModel | undefined;
  module(type: string): ModuleModel | undefined;
}

/** Lookup over `InitResult.catalog` / `InitResult.modules` (both optional; missing data only weakens checks). */
export function buildCableLookup(models: readonly DeviceModel[] = [], modules: readonly ModuleModel[] = []): CableLookup {
  const byType = new Map<string, DeviceModel>();
  for (const m of models) if (!byType.has(m.type)) byType.set(m.type, m);
  const byModule = new Map<string, ModuleModel>();
  for (const m of modules) if (!byModule.has(m.type)) byModule.set(m.type, m);
  return Object.freeze({
    model: (type: string) => byType.get(type),
    module: (type: string) => byModule.get(type),
  });
}

function templateFor(module: ModuleModel, port: string): ModuleModel['ports'][number] | undefined {
  return module.ports.find((t) => port.startsWith(t.family) && /^\d/.test(port.slice(t.family.length)));
}

/**
 * Static port data of a live port: the model's fixed `PortSpec`, else the spec part of the module template
 * that generated it. Undefined when neither is known (hand-built fixtures, virtual ports).
 */
export function portStaticSpec(lookup: CableLookup, device: Pick<DeviceSnapshot, 'type'>, port: Pick<PortSnapshot, 'id' | 'module'>): Partial<PortSpec> | undefined {
  const model = lookup.model(device.type);
  const fixed = model?.ports.find((p) => p.name === port.id);
  if (fixed !== undefined) return fixed;
  if (port.module !== undefined) {
    const mod = lookup.module(port.module.module);
    const template = mod === undefined ? undefined : templateFor(mod, port.id);
    if (template !== undefined) return template.spec;
  }
  return undefined;
}

/** Label of a cable end in explanations: `"SW1 FastEthernet0/1"`. */
export function cableEndLabel(device: Pick<DeviceSnapshot, 'name'>, port: Pick<PortSnapshot, 'id'>): string {
  return `${device.name} ${port.id}`;
}

/**
 * The validator's view of a live port. Snapshot fields win (effective role, installed transceiver); catalog
 * data fills what P0-shaped snapshots lack (role, wiring, connector, maximum speed).
 */
export function cableEndFor(lookup: CableLookup, device: DeviceSnapshot, port: PortSnapshot): CableEnd {
  const spec = portStaticSpec(lookup, device, port);
  const end: CableEnd = { kind: port.kind, label: cableEndLabel(device, port), device: device.id };
  // A computer (host shell) takes the terminal end of a console cable.
  const shell = device.cli?.shell ?? lookup.model(device.type)?.cli?.shell;
  if (shell === 'host') end.hostTerminal = true;
  const speed = spec?.speedBps ?? port.speedBps;
  if (speed !== undefined) end.speedBps = speed;
  const autoMdix = port.autoMdix ?? spec?.autoMdix;
  if (autoMdix !== undefined) end.autoMdix = autoMdix;
  const role = port.role ?? spec?.role;
  if (role !== undefined) end.role = role;
  const defaultRole = spec?.role ?? port.role;
  const wiring = port.wiring ?? spec?.wiring ?? (defaultRole !== undefined ? ROLE_TRAITS[defaultRole].wiring ?? undefined : undefined);
  if (wiring !== undefined) end.wiring = wiring;
  const connector = port.connector ?? spec?.connector;
  if (connector !== undefined) end.connector = connector;
  if (port.transceiver !== undefined) {
    const optics = lookup.module(port.transceiver)?.transceiver;
    if (optics !== undefined) end.transceiver = optics;
  }
  return end;
}

// ── compatibility ────────────────────────────────────────────────────────────

/**
 * How a port looks in the cable tool's port picker:
 *  'hidden'       never pickable (Wi-Fi/cellular radios, virtual interfaces, roles without the linkable trait);
 *  'occupied'     already holds a link;
 *  'source'       the first port clicked;
 *  'eligible'     no port clicked yet and the chosen media fits the port kind;
 *  'compatible'   the validator accepts a cable from the source to this port;
 *  'incompatible' the media does not fit the port kind, or the validator refuses the pairing (see `code`/`reason`).
 */
export type PortCompatStatus = 'hidden' | 'occupied' | 'source' | 'eligible' | 'compatible' | 'incompatible';

/** Picker verdict for one port. */
export interface PortCompat {
  readonly ref: PortRef;
  readonly status: PortCompatStatus;
  /** Clickable in the picker: eligible, compatible or the source (clicking the source cancels). */
  readonly enabled: boolean;
  /** Validator problem code for 'incompatible' pairings. */
  readonly code?: CableProblem;
  /** Original explanation for 'incompatible' and 'occupied'. */
  readonly reason?: string;
  /** Cable the validator would create ('compatible' and 'incompatible' pairings). */
  readonly resolvedMedia?: ResolvedMedia;
}

/** Whether a port can ever appear in the cable picker (radios that associate over the air and virtual ports cannot). */
export function isPickablePort(port: Pick<PortSnapshot, 'kind' | 'role' | 'linkable' | 'virtual'>): boolean {
  if (port.kind === 'wlan' || port.kind === 'cellular' || port.kind === 'virtual') return false;
  if (port.virtual === true || port.linkable === false) return false;
  return port.role === undefined || ROLE_TRAITS[port.role].linkable;
}

/** Options of the compatibility check. */
export interface CableCompatOptions {
  /** Cable length used for the length limits (default DEFAULT_CABLE_LENGTH_M). */
  readonly lengthM?: number;
}

function verdict(ref: PortRef, status: PortCompatStatus, extra: { code?: CableProblem; reason?: string; resolvedMedia?: ResolvedMedia } = {}): PortCompat {
  const enabled = status === 'eligible' || status === 'compatible' || status === 'source';
  const out: { -readonly [K in keyof PortCompat]: PortCompat[K] } = { ref, status, enabled };
  if (extra.code !== undefined) out.code = extra.code;
  if (extra.reason !== undefined) out.reason = extra.reason;
  if (extra.resolvedMedia !== undefined) out.resolvedMedia = extra.resolvedMedia;
  return Object.freeze(out);
}

function findPort(snapshot: Pick<SimSnapshot, 'devices'>, ref: PortRef): { device: DeviceSnapshot; port: PortSnapshot } | undefined {
  const device = snapshot.devices.find((d) => d.id === ref.device);
  const port = device?.ports.find((p) => p.id === ref.port);
  return device !== undefined && port !== undefined ? { device, port } : undefined;
}

/**
 * Verdict for one candidate port. `from` is the first port clicked (null before the first click). The source
 * itself is 'source'; an occupied port is 'occupied' (a port holds one link); otherwise, with a source, the
 * engine validator decides.
 */
export function portCompat(
  snapshot: Pick<SimSnapshot, 'devices'>,
  lookup: CableLookup,
  from: PortRef | null,
  media: MediaType,
  device: DeviceSnapshot,
  port: PortSnapshot,
  opts: CableCompatOptions = {},
): PortCompat {
  const ref: PortRef = { device: device.id, port: port.id };
  if (!isPickablePort(port)) return verdict(ref, 'hidden');
  if (from !== null && from.device === ref.device && from.port === ref.port) return verdict(ref, 'source');
  if (port.link !== undefined) return verdict(ref, 'occupied', { reason: `${cableEndLabel(device, port)} already has a connection.` });
  if (from === null) {
    if (mediaFitsPortKind(media, port.kind)) return verdict(ref, 'eligible');
    return verdict(ref, 'incompatible', {
      code: 'media-mismatch',
      reason: `The ${MEDIA_VOCAB[media].name} does not fit ${cableEndLabel(device, port)}, which is ${article(portKindLabel(port.kind))} port.`,
    });
  }
  const source = findPort(snapshot, from);
  if (source === undefined) return verdict(ref, 'incompatible', { reason: 'The first port of this cable no longer exists.' });
  const a = cableEndFor(lookup, source.device, source.port);
  const b = cableEndFor(lookup, device, port);
  const check = checkCable(a, b, media, opts.lengthM ?? DEFAULT_CABLE_LENGTH_M, media === 'radio' ? { kind: 'radio' } : {});
  if (check.ok) return verdict(ref, 'compatible', check.resolvedMedia !== undefined ? { resolvedMedia: check.resolvedMedia } : {});
  const extra: { code?: CableProblem; reason?: string; resolvedMedia?: ResolvedMedia } = {};
  if (check.code !== undefined) extra.code = check.code;
  if (check.reason !== undefined) extra.reason = check.reason;
  if (check.resolvedMedia !== undefined) extra.resolvedMedia = check.resolvedMedia;
  return verdict(ref, 'incompatible', extra);
}

/** `an Ethernet`, `a Serial` (lower-cased first word keeps proper names readable). */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/**
 * Verdicts for every port of every device, keyed by `portKey`, in snapshot device order then port order
 * (the canvas port picker reads them by key).
 */
export function portCompatibility(
  snapshot: Pick<SimSnapshot, 'devices'>,
  lookup: CableLookup,
  from: PortRef | null,
  media: MediaType,
  opts: CableCompatOptions = {},
): ReadonlyMap<string, PortCompat> {
  const out = new Map<string, PortCompat>();
  for (const device of snapshot.devices) {
    for (const port of device.ports) {
      const v = portCompat(snapshot, lookup, from, media, device, port, opts);
      out.set(portKey(v.ref), v);
    }
  }
  return out;
}

/** Ports a cable from `from` can reach with `media`, in snapshot order (the keyboard cabling list). */
export function compatibleTargets(
  snapshot: Pick<SimSnapshot, 'devices'>,
  lookup: CableLookup,
  from: PortRef,
  media: MediaType,
  opts: CableCompatOptions = {},
): readonly PortCompat[] {
  return Object.freeze([...portCompatibility(snapshot, lookup, from, media, opts).values()].filter((v) => v.status === 'compatible'));
}

// ── serial DCE end ───────────────────────────────────────────────────────────

/** Which port receives the DCE (clock-supplying) end of a serial cable. */
export interface DceHint {
  readonly dceEnd: 'a' | 'b';
  /** The DCE port once both ends are known. */
  readonly dce?: PortRef;
  /** Original sentence for the tooltip. */
  readonly text: string;
}

/**
 * DCE-end hint for the chosen media. `serial-dce` puts the DCE end on end a (the first port clicked), `serial-dte`
 * on end b. Undefined for every other media, including legacy `serial`, whose DCE end is decided by the port.
 * `names` gives the tooltip labels of the clicked ports.
 */
export function serialDceHint(media: MediaType, from?: PortRef, to?: PortRef, names: { readonly from?: string; readonly to?: string } = {}): DceHint | undefined {
  if (media !== 'serial-dce' && media !== 'serial-dte') return undefined;
  const dceEnd = MEDIA[media].dceEnd ?? (media === 'serial-dce' ? 'a' : 'b');
  const dce = dceEnd === 'a' ? from : to;
  const label = dceEnd === 'a' ? names.from : names.to;
  if (dce !== undefined && label !== undefined) {
    return Object.freeze({ dceEnd, dce, text: `${label} gets the DCE end and needs "clock rate".` });
  }
  const fallback = MEDIA_VOCAB[media].dceHint ?? '';
  return Object.freeze(dce !== undefined ? { dceEnd, dce, text: fallback } : { dceEnd, text: fallback });
}

// ── link requests ────────────────────────────────────────────────────────────

/** The `AddLinkSpec` for a cable drawn from `from` to `to` (radio media creates a radio link). */
export function addLinkSpecFor(from: PortRef, to: PortRef, media: MediaType, lengthM?: number): AddLinkSpec {
  const spec: AddLinkSpec = { a: { ...from }, b: { ...to }, media };
  if (lengthM !== undefined) spec.lengthM = lengthM;
  if (media !== 'auto' && linkKindOf(media) === 'radio') spec.kind = 'radio';
  return spec;
}

/** Cache key of a validation request: both ends in click order plus the media and length. */
export function validationKey(spec: Pick<AddLinkSpec, 'a' | 'b' | 'media' | 'lengthM'>): string {
  return `${portKey(spec.a)}>${portKey(spec.b)}|${spec.media ?? 'auto'}|${spec.lengthM ?? DEFAULT_CABLE_LENGTH_M}`;
}

/** Tooltip wording of a validation verdict. */
export interface VerdictText {
  readonly ok: boolean;
  /** Glyph plus text, so the verdict never relies on colour. */
  readonly title: string;
  readonly detail: string;
}

/** Tooltip text for a `validateLink` result. */
export function verdictText(v: CableValidation, media: MediaType): VerdictText {
  const cable = v.resolvedMedia !== undefined ? MEDIA_VOCAB[v.resolvedMedia] : MEDIA_VOCAB[media];
  if (v.ok) {
    const detail = media === 'auto' && v.resolvedMedia !== undefined ? `Automatic choice: ${cable.name}.` : cable.description;
    return Object.freeze({ ok: true, title: `✓ ${cable.short}`, detail });
  }
  return Object.freeze({ ok: false, title: `✕ ${cable.short}`, detail: v.reason ?? 'This cable cannot join these ports.' });
}
