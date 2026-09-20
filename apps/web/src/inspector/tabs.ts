/**
 * Inspector derivations (ARCHITECTURE-P1 §7 "Inspector", D2, D7, §9.3): which tabs a device shows (from
 * `DeviceModel.gui` and the effective capabilities, clamped to 'overview'), which tables it owns, whether a port can
 * be shut from the GUI, module slot rules and wording, radio rate → MCS identification, and O(1) snapshot lookups
 * through `UiState.snapshotIndex`.
 *
 * Pure and React-free so tabs.test.ts can pin it. Nothing here branches on `DeviceSnapshot.kind` (icon family only).
 * All wording is original (§1.6).
 */
import {
  BAND_GENERATIONS,
  BRIDGING_CAPABILITIES,
  CAPABILITY_PROCESSES,
  CLI_MESSAGES,
  HARDWARE_MESSAGES,
  MCS_TABLES,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  mcsRateBps,
} from '@netforge/engine';
import type {
  AssociationSnapshot,
  BssSnapshot,
  Capability,
  CellAttachState,
  CellSnapshot,
  ChannelWidthMhz,
  DeviceId,
  DeviceModel,
  DeviceSnapshot,
  GuiPanelId,
  HardwareErrorCode,
  HardwareResult,
  LinkId,
  LinkSnapshot,
  ModuleFit,
  ModuleModel,
  PhyEndView,
  PortRef,
  PortRole,
  PortSnapshot,
  ProcessName,
  RadioGeneration,
  RadioMode,
  RfBand,
  SegmentSnapshot,
  SimSnapshot,
  SlotId,
  SlotSnapshot,
  SlotType,
  TransceiverSpec,
  WifiAssocState,
  WifiSecurity,
} from '@netforge/engine';
import type { InspectorTab, UiState } from '../store/types.js';
import { GUI_PANEL_VOCAB } from '../vocab/categories.js';

// ── tabs ─────────────────────────────────────────────────────────────────────

/** Every inspector tab in display order. */
export const INSPECTOR_TAB_ORDER: readonly InspectorTab[] = Object.freeze([
  'overview',
  'ports',
  'config',
  'tables',
  'processes',
  'physical',
  'desktop',
  'wireless',
  'services',
]);

/** Default tab labels ('wireless' is renamed after the device's settings panel, see `inspectorTabLabel`). */
export const INSPECTOR_TAB_LABELS: Readonly<Record<InspectorTab, string>> = Object.freeze({
  overview: 'Overview',
  ports: 'Ports',
  config: 'Config',
  tables: 'Tables',
  processes: 'Processes',
  physical: 'Physical',
  desktop: 'Desktop',
  wireless: 'Wireless',
  services: 'Services',
});

/** The inspector tab that hosts each GUI panel. Settings panels of network appliances share the 'wireless' tab. */
export const PANEL_TAB: Readonly<Record<GuiPanelId, InspectorTab>> = Object.freeze({
  physical: 'physical',
  'desktop.ip-config': 'desktop',
  'desktop.wifi': 'desktop',
  'desktop.cellular': 'desktop',
  'desktop.command-prompt': 'desktop',
  'desktop.web-browser': 'desktop',
  services: 'services',
  'wireless.ap': 'wireless',
  'home-router.setup': 'wireless',
  'radio.link': 'wireless',
  'cell.tower': 'wireless',
  'modem.status': 'wireless',
});

/** The P0 tab set, used for snapshots without catalog v2 fields (hand-built fixtures). */
export const LEGACY_INSPECTOR_TABS: readonly InspectorTab[] = Object.freeze(['overview', 'ports', 'config', 'tables', 'processes']);

/** What tab derivation reads from a device snapshot. */
export interface TabSource {
  readonly ports: readonly Pick<PortSnapshot, 'kind' | 'role' | 'configurable'>[];
  readonly gui?: readonly GuiPanelId[];
  readonly capabilities?: readonly Capability[];
  readonly cli?: DeviceSnapshot['cli'];
  readonly slots?: readonly unknown[];
  readonly processes?: readonly unknown[];
  readonly tables?: Pick<DeviceSnapshot['tables'], 'cam' | 'arp' | 'rib' | 'extra'>;
}

/** What tab derivation reads from the catalog entry of the device's type (optional). */
export type TabModel = Pick<DeviceModel, 'processes'>;

/** True when some capability of `caps` runs `process` in a P0 or P0.5 build (used only without a catalog entry). */
export function capabilitiesRun(caps: readonly Capability[], process: ProcessName): boolean {
  return caps.some((c) => CAPABILITY_PROCESSES[c].some((p) => p.process === process && p.since !== 'P1'));
}

/** Tables a device owns: from the catalog entry's daemons when known, else from capabilities; rows always count. */
export interface DeviceTablePresence {
  readonly cam: boolean;
  readonly arp: boolean;
  readonly rib: boolean;
  /** Extra tables present in the snapshot (`tables.extra`). */
  readonly extra: number;
}

export function deviceTablePresence(device: Pick<TabSource, 'capabilities' | 'tables'>, model?: TabModel): DeviceTablePresence {
  const t = device.tables;
  const rows = { cam: (t?.cam.length ?? 0) > 0, arp: (t?.arp.length ?? 0) > 0, rib: (t?.rib.length ?? 0) > 0 };
  const extra = t?.extra?.length ?? 0;
  if (model !== undefined) {
    return {
      cam: model.processes.includes('eth-switch') || rows.cam,
      arp: model.processes.includes('arp') || rows.arp,
      rib: model.processes.includes('ipv4') || rows.rib,
      extra,
    };
  }
  const caps = device.capabilities;
  if (caps === undefined) return { cam: true, arp: true, rib: true, extra };
  const bridging = caps.some((c) => BRIDGING_CAPABILITIES.includes(c));
  return {
    cam: bridging || rows.cam,
    arp: capabilitiesRun(caps, 'arp') || rows.arp,
    rib: capabilitiesRun(caps, 'ipv4') || rows.rib,
    extra,
  };
}

/** One table section of the Tables tab. */
export type TableSectionRef =
  | { readonly kind: 'cam' | 'arp' | 'rib' }
  | { readonly kind: 'extra'; readonly name: string; readonly index: number };

/**
 * Table sections a device shows, in order: CAM, ARP and routing table when the device owns them (or holds rows),
 * then every extra table of the snapshot in engine order (TABLE_DESCRIPTORS order of `model.tables`).
 */
export function tableSectionsFor(device: Pick<TabSource, 'capabilities' | 'tables'>, model?: TabModel): readonly TableSectionRef[] {
  const p = deviceTablePresence(device, model);
  const out: TableSectionRef[] = [];
  if (p.cam) out.push({ kind: 'cam' });
  if (p.arp) out.push({ kind: 'arp' });
  if (p.rib) out.push({ kind: 'rib' });
  (device.tables?.extra ?? []).forEach((t, index) => out.push({ kind: 'extra', name: t.name, index }));
  return out;
}

function portConfigurable(p: Pick<PortSnapshot, 'kind' | 'role' | 'configurable'>): boolean {
  if (p.configurable !== undefined) return p.configurable;
  if (p.role !== undefined) return ROLE_TRAITS[p.role].configurable;
  return p.kind !== 'console' && p.kind !== 'usb';
}

/**
 * Tabs of a device in display order:
 *  - overview always; ports when the device has any port;
 *  - config when it has a console shell or a configurable port (hubs and coax taps have neither);
 *  - tables when it owns a CAM, ARP or routing table, or extra tables;
 *  - processes when its catalog entry (or, without one, its capabilities) runs daemons;
 *  - physical when `gui` lists it (hardware overview, plus module slots when the chassis has any);
 *  - desktop / wireless / services when `gui` lists a panel hosted by that tab.
 * A snapshot without capabilities (P0 fixture) gets the P0 set.
 */
export function inspectorTabsFor(device: TabSource, model?: TabModel): readonly InspectorTab[] {
  if (device.capabilities === undefined) return LEGACY_INSPECTOR_TABS;
  const caps = device.capabilities;
  const gui = device.gui ?? [];
  const on: Record<InspectorTab, boolean> = {
    overview: true,
    ports: device.ports.length > 0,
    config: device.cli === undefined || device.cli.shell !== 'none' || device.ports.some(portConfigurable),
    tables: (() => {
      const p = deviceTablePresence(device, model);
      return p.cam || p.arp || p.rib || p.extra > 0;
    })(),
    processes:
      (model !== undefined ? model.processes.length > 0 : caps.some((c) => CAPABILITY_PROCESSES[c].some((p) => p.since !== 'P1'))) ||
      (device.processes?.length ?? 0) > 0,
    physical: gui.includes('physical'),
    desktop: gui.some((g) => PANEL_TAB[g] === 'desktop'),
    wireless: gui.some((g) => PANEL_TAB[g] === 'wireless'),
    services: gui.some((g) => PANEL_TAB[g] === 'services'),
  };
  return INSPECTOR_TAB_ORDER.filter((t) => on[t]);
}

/** `tab` when the device offers it, otherwise 'overview'. */
export function clampInspectorTab(tab: InspectorTab | null | undefined, tabs: readonly InspectorTab[]): InspectorTab {
  return tab !== null && tab !== undefined && tabs.includes(tab) ? tab : 'overview';
}

/** GUI panels of the device hosted by `tab`, in engine display order. */
export function panelsForTab(device: Pick<TabSource, 'gui'>, tab: InspectorTab): readonly GuiPanelId[] {
  return (device.gui ?? []).filter((g) => PANEL_TAB[g] === tab);
}

/** Label of a tab for this device: the 'wireless' tab takes the name of its first settings panel. */
export function inspectorTabLabel(tab: InspectorTab, device: Pick<TabSource, 'gui'>): string {
  if (tab === 'wireless') {
    const first = panelsForTab(device, 'wireless')[0];
    if (first !== undefined) return GUI_PANEL_VOCAB[first].label;
  }
  return INSPECTOR_TAB_LABELS[tab];
}

/** Next tab for keyboard navigation of the tab list (wraps around). */
export function stepInspectorTab(tabs: readonly InspectorTab[], current: InspectorTab, key: 'next' | 'prev' | 'first' | 'last'): InspectorTab {
  if (tabs.length === 0) return 'overview';
  const i = Math.max(0, tabs.indexOf(current));
  const n = tabs.length;
  const idx = key === 'first' ? 0 : key === 'last' ? n - 1 : key === 'next' ? (i + 1) % n : (i - 1 + n) % n;
  return tabs[idx] ?? 'overview';
}

/** Whether the header may offer a console, with the reason when it may not (shell 'none' devices are GUI-only). */
export function consoleAvailability(device: Pick<DeviceSnapshot, 'cli' | 'gui'>): PortToggle {
  if (device.cli === undefined || device.cli.shell !== 'none') return { ok: true };
  const panel = (device.gui ?? []).find((g) => PANEL_TAB[g] === 'wireless');
  const where = panel !== undefined ? `the ${GUI_PANEL_VOCAB[panel].label} tab` : 'the Physical tab';
  return { ok: false, reason: `${CLI_MESSAGES.noShell} Its settings live in ${where}.` };
}

// ── snapshot lookups ─────────────────────────────────────────────────────────

type IndexedState = Pick<UiState, 'snapshot' | 'snapshotIndex'>;

/** Device by id through `snapshotIndex` (a stale or absent index falls back to a scan). */
export function deviceById(state: IndexedState, id: DeviceId | null | undefined): DeviceSnapshot | undefined {
  const snap = state.snapshot;
  if (snap === null || id === null || id === undefined) return undefined;
  const i = state.snapshotIndex?.devices[id];
  if (i !== undefined) {
    const d = snap.devices[i];
    if (d !== undefined && d.id === id) return d;
  }
  return snap.devices.find((d) => d.id === id);
}

/** Link by id through `snapshotIndex` (a stale or absent index falls back to a scan). */
export function linkById(state: IndexedState, id: LinkId | null | undefined): LinkSnapshot | undefined {
  const snap = state.snapshot;
  if (snap === null || id === null || id === undefined) return undefined;
  const i = state.snapshotIndex?.links[id];
  if (i !== undefined) {
    const l = snap.links[i];
    if (l !== undefined && l.id === id) return l;
  }
  return snap.links.find((l) => l.id === id);
}

/** Port of a device snapshot by id. */
export function portOf(device: Pick<DeviceSnapshot, 'ports'> | undefined, port: string | null | undefined): PortSnapshot | undefined {
  if (device === undefined || port === null || port === undefined) return undefined;
  return device.ports.find((p) => p.id === port);
}

/** Wi-Fi association or cellular attachment by `AssociationSnapshot.id`. */
export function associationById(snapshot: Pick<SimSnapshot, 'media'> | null, id: string | null | undefined): AssociationSnapshot | undefined {
  if (snapshot === null || id === null || id === undefined) return undefined;
  return snapshot.media?.associations.find((a) => a.id === id);
}

/** Associations whose station or AP/tower end is on `device`, in snapshot order. */
export function associationsOfDevice(snapshot: Pick<SimSnapshot, 'media'> | null, device: DeviceId): readonly AssociationSnapshot[] {
  const list = snapshot?.media?.associations;
  if (list === undefined) return [];
  return list.filter((a) => a.station.device === device || a.ap?.device === device);
}

/** The association a station/UE port belongs to (undefined for AP radios and non-radio ports). */
export function associationOfStation(snapshot: Pick<SimSnapshot, 'media'> | null, ref: PortRef): AssociationSnapshot | undefined {
  return snapshot?.media?.associations.find((a) => a.station.device === ref.device && a.station.port === ref.port);
}

/** Collision domain by id. */
export function segmentById(snapshot: Pick<SimSnapshot, 'media'> | null, id: string | null | undefined): SegmentSnapshot | undefined {
  if (snapshot === null || id === null || id === undefined) return undefined;
  return snapshot.media?.segments.find((s) => s.id === id);
}

const modelIndexCache = new WeakMap<readonly DeviceModel[], ReadonlyMap<string, DeviceModel>>();

/** Catalog entry by type id; the per-catalog index is cached, so selectors may call this on every store change. */
export function catalogModel(catalog: readonly DeviceModel[], type: string): DeviceModel | undefined {
  let index = modelIndexCache.get(catalog);
  if (index === undefined) {
    index = new Map(catalog.map((m) => [m.type, m] as const));
    modelIndexCache.set(catalog, index);
  }
  return index.get(type);
}

const moduleIndexCache = new WeakMap<readonly ModuleModel[], ReadonlyMap<string, ModuleModel>>();

/** Module catalog entry by type id (cached per module list). */
export function moduleModel(modules: readonly ModuleModel[], type: string | undefined): ModuleModel | undefined {
  if (type === undefined) return undefined;
  let index = moduleIndexCache.get(modules);
  if (index === undefined) {
    index = new Map(modules.map((m) => [m.type, m] as const));
    moduleIndexCache.set(modules, index);
  }
  return index.get(type);
}

// ── ports ────────────────────────────────────────────────────────────────────

/** True for ports that carry traffic (everything except console-class management ports). */
export function isDataPort(p: Pick<PortSnapshot, 'kind' | 'role'>): boolean {
  if (p.role !== undefined) return p.role !== 'console';
  return p.kind !== 'console' && p.kind !== 'usb';
}

/** Whether the GUI may shut or enable a port, with the reason when it may not. */
export type PortToggle = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Shut/enable gate: role traits decide (§9.3), not the device kind; the device must be running. */
export function portToggleState(
  device: Pick<DeviceSnapshot, 'power' | 'booted'>,
  port: Pick<PortSnapshot, 'kind' | 'role' | 'configurable'>,
): PortToggle {
  const role: PortRole | undefined = port.role;
  if (role === 'console' || (role === undefined && (port.kind === 'console' || port.kind === 'usb'))) {
    return { ok: false, reason: 'Console ports are always on; they carry management access, not traffic.' };
  }
  if (role === 'repeater') {
    return { ok: false, reason: 'Repeater ports have no settings: they pass every signal on to the other ports.' };
  }
  if (!portConfigurable(port)) return { ok: false, reason: 'This port has no settings that can switch it off.' };
  if (!device.power) return { ok: false, reason: 'Switch the device on first.' };
  if (!device.booted) return { ok: false, reason: 'Wait until the device has finished starting.' };
  return { ok: true };
}

/** Wording of how an end reached its negotiated speed and duplex. */
export const PHY_VIA_TEXT: Readonly<Record<PhyEndView['via'], string>> = Object.freeze({
  autoneg: 'agreed with the other end',
  'parallel-detect': 'guessed from a peer that does not negotiate',
  forced: 'set in the configuration',
  fixed: 'fixed by the hardware',
});

// ── radios ───────────────────────────────────────────────────────────────────

/** Display names of RF bands. */
export const RF_BAND_LABELS: Readonly<Record<RfBand, string>> = Object.freeze({
  '2.4': '2.4 GHz',
  '5': '5 GHz',
  '6': '6 GHz',
  '60': '60 GHz',
  cell: 'mobile band',
});

/** Display names of radio generations (standard names, no product names). */
export const RADIO_GENERATION_LABELS: Readonly<Record<RadioGeneration, string>> = Object.freeze({
  b: '802.11b',
  g: '802.11g',
  n: '802.11n',
  ac: '802.11ac',
  ax: '802.11ax',
  ad: '802.11ad',
  lte: 'LTE',
});

/** What a radio port does, in words. */
export const RADIO_MODE_LABELS: Readonly<Record<RadioMode, string>> = Object.freeze({
  ap: 'access point radio',
  station: 'wireless client',
  ptp: 'point-to-point radio',
  tower: 'mobile network tower',
  ue: 'mobile data adapter',
});

/** Distance in metres rendered readably ("40 m", "1.5 km"). */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${Number((m / 1000).toFixed(1))} km`;
}

/** An MCS entry that reproduces an observed PHY rate. */
export interface McsMatch {
  readonly generation: RadioGeneration;
  readonly mcs: number;
  readonly widthMhz: ChannelWidthMhz;
  readonly streams: number;
}

const WIFI_WIDTHS: readonly ChannelWidthMhz[] = [20, 40, 80, 160];
const MAX_STREAMS = 8;

/**
 * The MCS behind `rateBps` on `band`: the best generation valid on the band is tried first, then the fewest spatial
 * streams, each channel width (`widthMhz` when known) and each entry; the first exact rate match wins. Undefined when nothing matches
 * (for example a rate capped by the port speed).
 */
export function identifyMcs(band: RfBand, rateBps: number, widthMhz?: ChannelWidthMhz): McsMatch | undefined {
  if (!Number.isFinite(rateBps) || rateBps <= 0) return undefined;
  const generations = [...BAND_GENERATIONS[band]].reverse();
  for (const generation of generations) {
    const widths: readonly ChannelWidthMhz[] =
      generation === 'ad' ? [2160] : generation === 'lte' ? [20] : widthMhz !== undefined ? [widthMhz] : WIFI_WIDTHS;
    for (let streams = 1; streams <= MAX_STREAMS; streams++) {
      for (const w of widths) {
        for (const entry of MCS_TABLES[generation]) {
          if (mcsRateBps(entry, w, streams) === rateBps) return { generation, mcs: entry.mcs, widthMhz: w, streams };
        }
      }
    }
  }
  return undefined;
}

/** The phases a Wi-Fi station and a cellular UE walk through, in order (the settled end state last). */
export const WIFI_PHASES: readonly WifiAssocState[] = Object.freeze(['scanning', 'authenticating', 'associating', 'handshake', 'associated']);
export const CELL_PHASES: readonly CellAttachState[] = Object.freeze(['searching', 'attaching', 'attached']);

/** One step of the phase ladder in the association inspector. `mark` is the non-colour channel. */
export interface AssocPhaseStep {
  readonly state: WifiAssocState | CellAttachState;
  readonly status: 'done' | 'current' | 'todo';
  readonly mark: '✓' | '▶' | '·';
}

/**
 * Phase ladder of an association. States outside the ladder (idle, failed, detached) mark nothing as current; a
 * failure keeps the steps it reached unknown, so every step shows as pending.
 */
export function assocPhaseSteps(tech: AssociationSnapshot['tech'], state: AssociationSnapshot['state']): readonly AssocPhaseStep[] {
  const ladder: readonly (WifiAssocState | CellAttachState)[] = tech === 'wifi' ? WIFI_PHASES : CELL_PHASES;
  const at = ladder.indexOf(state);
  const last = ladder.length - 1;
  return ladder.map((s, i) => {
    if (at < 0 || i > at) return { state: s, status: 'todo', mark: '·' };
    if (i < at || at === last) return { state: s, status: 'done', mark: '✓' };
    return { state: s, status: 'current', mark: '▶' };
  });
}

/** Remaining RF hold time of an association below the drop threshold (undefined when no hold runs). */
export function holdRemainingNs(assoc: Pick<AssociationSnapshot, 'holdUntil'>, now: number): number | undefined {
  if (assoc.holdUntil === undefined) return undefined;
  return Math.max(0, assoc.holdUntil - now);
}

/** BSS (Wi-Fi) snapshot by medium id. */
export function bssById(snapshot: Pick<SimSnapshot, 'media'> | null, id: string | null | undefined): BssSnapshot | undefined {
  if (snapshot === null || id === null || id === undefined) return undefined;
  return snapshot.media?.bss.find((b) => b.id === id);
}

/** Cell (tower) snapshot by medium id. */
export function cellById(snapshot: Pick<SimSnapshot, 'media'> | null, id: string | null | undefined): CellSnapshot | undefined {
  if (snapshot === null || id === null || id === undefined) return undefined;
  return snapshot.media?.cells.find((c) => c.id === id);
}

/** Display names of Wi-Fi security modes. */
export const WIFI_SECURITY_TEXT: Readonly<Record<WifiSecurity, string>> = Object.freeze({
  open: 'open (no password)',
  'wpa2-psk': 'WPA2 personal (shared password)',
  'wpa3-sae': 'WPA3 personal (shared password)',
});

/** "MCS 7 · 802.11ac · 2 streams" */
export function formatMcs(m: McsMatch): string {
  return `MCS ${m.mcs} · ${RADIO_GENERATION_LABELS[m.generation]} · ${m.streams} stream${m.streams === 1 ? '' : 's'}`;
}

// ── modules and slots ────────────────────────────────────────────────────────

/** Display names of slot types. */
export const SLOT_TYPE_LABELS: Readonly<Record<SlotType, string>> = Object.freeze({
  ehwic: 'WAN card slot',
  nim: 'network module slot',
  sfp: 'small form-factor (SFP) cage',
  'sfp+': 'small form-factor (SFP+) cage',
  generic: 'module bay',
  'host-expansion': 'card bay',
});

/** Slot type names that fill the {slotType} placeholder of HARDWARE_MESSAGES ("… does not fit a {slotType} slot."). */
export const SLOT_TYPE_NAMES: Readonly<Record<SlotType, string>> = Object.freeze({
  ehwic: 'WAN card',
  nim: 'network module',
  sfp: 'small form-factor (SFP)',
  'sfp+': 'small form-factor (SFP+)',
  generic: 'general module',
  'host-expansion': 'card expansion',
});

/** Display names of module fits. */
export const MODULE_FIT_LABELS: Readonly<Record<ModuleFit, string>> = Object.freeze({
  ehwic: 'interface card',
  nim: 'network module',
  sfp: 'SFP transceiver',
  'sfp+': 'SFP+ transceiver',
  'host-expansion': 'expansion card',
});

/** Placeholders a HARDWARE_MESSAGES template may use. */
export interface HardwareMessageValues {
  readonly model?: string;
  readonly slot?: string;
  readonly module?: string;
  readonly slotType?: string;
  readonly device?: string;
}

/** A HARDWARE_MESSAGES template with its placeholders filled (unknown placeholders stay visible). */
export function hardwareMessage(code: HardwareErrorCode, values: HardwareMessageValues): string {
  const map = values as Readonly<Record<string, string | undefined>>;
  return HARDWARE_MESSAGES[code].replace(/\{(\w+)\}/g, (whole, key: string) => map[key] ?? whole);
}

/** The power-off gate shown while a device is on: modules are not hot-swappable (D7). */
export function modulePowerGate(device: Pick<DeviceSnapshot, 'name' | 'power'>): string | undefined {
  return device.power ? hardwareMessage('powered-on', { device: device.name }) : undefined;
}

/** Text of a failed HardwareResult (the engine's message, or the template when it sent none). */
export function hardwareResultText(result: HardwareResult, values: HardwareMessageValues): string | undefined {
  if (result.ok) return undefined;
  return result.error.trim() !== '' ? result.error : hardwareMessage(result.code, values);
}

/** Modules that fit a slot, in module catalog order. */
export function modulesForSlot(slot: Pick<SlotSnapshot, 'type'> & Partial<Pick<SlotSnapshot, 'accepts'>>, modules: readonly ModuleModel[]): readonly ModuleModel[] {
  const accepts = slot.accepts ?? SLOT_ACCEPTS[slot.type];
  return modules.filter((m) => accepts.includes(m.fits));
}

function transceiverText(t: TransceiverSpec): string {
  const speed = t.speedBps >= 1_000_000_000 ? `${t.speedBps / 1_000_000_000} Gb/s` : `${t.speedBps / 1_000_000} Mb/s`;
  return `${t.connector.toUpperCase()} ${t.mode === 'mm' ? 'multimode' : 'single-mode'} optic, ${speed}, up to ${formatDistance(t.maxLengthM)}`;
}

/** What a module adds: "2 × Serial", "1 × Wlan", or the optic of a transceiver. */
export function modulePortSummary(module: Pick<ModuleModel, 'ports' | 'transceiver'>): string {
  if (module.transceiver !== undefined) return transceiverText(module.transceiver);
  const parts = module.ports.filter((p) => p.count > 0).map((p) => `${p.count} × ${p.family}`);
  return parts.length > 0 ? parts.join(', ') : 'no ports';
}

/** Ports generated by the module in `slot`, plus the cage port of an SFP slot, in canonical port order. */
export function slotPorts(device: Pick<DeviceSnapshot, 'ports'>, slot: Pick<SlotSnapshot, 'id' | 'cage'>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.slot === slot.id || (slot.cage !== undefined && p.id === slot.cage));
}

/** Slot of a device by id. */
export function slotById(device: Pick<DeviceSnapshot, 'slots'> | undefined, slot: SlotId | null | undefined): SlotSnapshot | undefined {
  if (device === undefined || slot === null || slot === undefined) return undefined;
  return device.slots?.find((s) => s.id === slot);
}

/** Number of cables attached to the module ports of a slot (removing the module removes them first, §3.11). */
export function slotCableCount(device: Pick<DeviceSnapshot, 'ports'>, slot: Pick<SlotSnapshot, 'id' | 'cage' | 'module'>): number {
  if (slot.module === undefined) return 0;
  return slotPorts(device, slot).filter((p) => p.link !== undefined && (slot.cage === undefined || p.id !== slot.cage)).length;
}
