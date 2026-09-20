/**
 * Read-only snapshot of the whole simulation for the UI (spec §4.8 rule 1:
 * the UI only ever sees `state_snapshot()` data). Structured-clone safe.
 *
 * P0.5 additions are optional in the type during the transition (see contracts/port.ts); the sim wave
 * that fills them removes the `?`. New fields must round-trip `exportTopology → loadTopology` snapshot
 * equality (sim.facade test).
 */
import type { DeviceId, LinkId, PduId, PortId, PortRef, SessionId } from './ids.js';
import type { MacAddress } from './addr.js';
import type { DeviceKind } from './device.js';
import type { LinkState, PortPhy, PortPhySettings } from './link.js';
import type { PortCounters, PortKind, PortL3 } from './port.js';
import type { StateView } from './process.js';
import type { ArpRow, CamRow, RouteRow, TableColumn, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { PduSummary } from './trace.js';
import type { CliSessionView } from './cli.js';
import type {
  Capability,
  CliGrammar,
  CliShell,
  Connector,
  DeviceCategory,
  DeviceIconId,
  GuiPanelId,
  ModuleFit,
  ModuleInstall,
  ModuleType,
  PoeSpec,
  PortEncap,
  PortRole,
  SlotId,
  SlotType,
  Wiring,
} from './catalog.js';
import type { MediaSnapshot, MediumId, MediumKind } from './medium.js';
import type { RadioPortView } from './rf.js';
import type { TopologyDeviceUi } from './topology.js';

export interface PortSnapshot {
  id: PortId;
  short: string;
  kind: PortKind;
  mac: MacAddress;
  adminUp: boolean;
  operUp: boolean;
  speedBps?: number;
  duplex?: string;
  mtu: number;
  link?: LinkId;
  errDisabled?: string;
  counters: PortCounters;
  /** Full copy (ipv4 incl. origin/lease, ipv6 list, groups) from P1. */
  l3: PortL3;
  txQueue: number;

  // ── P0.5 ──
  /** @since P0.5 Effective role. */
  role: PortRole;
  /** @since P0.5 Roles config may switch to (length > 1 ⇒ the UI can show a mode toggle). */
  allowedRoles: readonly PortRole[];
  encap: PortEncap;
  ordinal: number;
  /** @since P0.5 ROLE_TRAITS[role].virtual (no cable, no picker dot). */
  virtual: boolean;
  /** @since P0.5 ROLE_TRAITS[role].linkable (port-picker eligibility). */
  linkable: boolean;
  /** @since P0.5 ROLE_TRAITS[role].configurable (shutdown toggle, config section). */
  configurable: boolean;
  connector: Connector;
  wiring?: Wiring;
  autoMdix?: boolean;
  group?: string;
  slot?: SlotId;
  module?: ModuleInstall;
  transceiver?: ModuleType;
  poe?: PoeSpec;
  /** @since P0.5 Link-model PHY detail; OMITTED for a plain full-duplex P2P cable with carrier === operUp (keeps P0 snapshots stable). */
  phy?: PortPhy;
  /** @since P0.5 Config-derived speed/duplex/clock rate (omitted when all defaults). */
  phySettings?: PortPhySettings;
  /** @since P0.5 Radio ports. */
  radio?: RadioPortView;
}

/** @since P0.5 A module slot of a chassis. */
export interface SlotSnapshot {
  id: SlotId;
  label: string;
  type: SlotType;
  /** Module fits accepted (SLOT_ACCEPTS). */
  accepts: readonly ModuleFit[];
  module?: ModuleType;
  cage?: PortId;
}

/** @since P0.5 Generic table rendering (extra tables beyond cam/arp/rib). */
export interface TableSnapshot {
  name: TableName;
  title: string;
  columns: readonly TableColumn[];
  /** Plain row copies, insertion order. */
  rows: Record<string, unknown>[];
}

export interface DeviceSnapshot {
  id: DeviceId;
  type: string;
  model: string;
  /** Icon family only. */
  kind: DeviceKind;
  name: string;
  position: { x: number; y: number };
  power: boolean;
  booted: boolean;
  uptimeNs: SimTime;
  ports: PortSnapshot[];
  tables: {
    cam: CamRow[];
    arp: ArpRow[];
    rib: RouteRow[];
    /** @since P0.5 Present iff the model declares extra tables (TABLE_DESCRIPTORS order of `model.tables`). */
    extra?: TableSnapshot[];
  };
  processes: StateView[];
  runningConfig: string;
  hasStartupConfig: boolean;
  /**
   * Rendered startup-config text (`startup.render()`), present iff `hasStartupConfig`.
   * The inspector Config tab derives its "diff vs startup" from this and `runningConfig`.
   */
  startupConfig?: string;

  // ── P0.5 ──
  category: DeviceCategory;
  family: string;
  variant: string;
  icon: DeviceIconId;
  /** @since P0.5 Effective capabilities (model + installed modules). */
  capabilities: readonly Capability[];
  cli: { shell: CliShell; grammar: CliGrammar };
  gui: readonly GuiPanelId[];
  slots?: SlotSnapshot[];
  hostPorts: readonly PortId[];
  /** @since P0.5 Ordinal-0 MAC (D8). */
  baseMac: MacAddress;
  /** @since P0.5 Opaque persisted GUI state. */
  ui?: TopologyDeviceUi;
}

export type LinkSnapshot = LinkState;

/**
 * A frame leg currently on a medium. Position at time t = (t - txStart) / (arrive - txStart), clamped;
 * when `abortAt` is set the tail stops there.
 * IDENTITY: `(pdu.id, link, to)` — a broadcast on a segment or BSS has one entry per receiver leg
 * (each receiver's leg carries that receiver's clone id; P2P cables: one entry per frame).
 */
export interface InflightFrame {
  pdu: PduSummary;
  link: LinkId | MediumId;
  from: PortRef;
  to: PortRef;
  txStart: SimTime;
  txEnd: SimTime;
  arrive: SimTime;
  /** @since P0.5 */
  medium?: MediumKind;
  /** @since P0.5 */
  abortAt?: SimTime;
  /** @since P0.5 */
  rateBps?: number;
  /** @since P0.5 */
  background?: boolean;
}

export interface SimSnapshot {
  now: SimTime;
  seed: number;
  /** Monotonic; bumps on device/link/module add/remove (NOT on move) so the UI can skip re-layout. */
  topologyVersion: number;
  devices: DeviceSnapshot[];
  links: LinkSnapshot[];
  inflight: InflightFrame[];
  sessions: CliSessionView[];
  /** Total PDUs created so far. */
  pduCount: number;
  /** Pending scheduler events. */
  pendingEvents: number;
  /** @since P0.5 Segments, BSSs, cells, associations; omitted when none exist and the scale is the default. */
  media?: MediaSnapshot;
}

export type Selection =
  | { kind: 'device'; id: DeviceId }
  | { kind: 'link'; id: LinkId }
  | { kind: 'pdu'; id: PduId }
  | { kind: 'port'; ref: PortRef }
  | { kind: 'session'; id: SessionId }
  /** @since P0.5 Wi-Fi association or cellular attachment (`AssociationSnapshot.id`). */
  | { kind: 'association'; id: string }
  /** @since P0.5 A module slot on a chassis. */
  | { kind: 'slot'; device: DeviceId; slot: SlotId };

/** Stable identity string of a selection (hover equality, React keys). */
export function selectionKey(s: Selection): string {
  switch (s.kind) {
    case 'port':
      return `port:${s.ref.device}/${s.ref.port}`;
    case 'slot':
      return `slot:${s.device}/${s.slot}`;
    case 'device':
      return `device:${s.id}`;
    case 'link':
      return `link:${s.id}`;
    case 'pdu':
      return `pdu:${s.id}`;
    case 'session':
      return `session:${s.id}`;
    case 'association':
      return `association:${s.id}`;
  }
}
