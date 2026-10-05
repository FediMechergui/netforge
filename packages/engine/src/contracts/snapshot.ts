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
import type { EgressQueueView, LinkState, PortPhy, PortPhySettings } from './link.js';
import type { PortCounters, PortKind, PortL3, SwitchportConfig } from './port.js';
import type { StateView } from './process.js';
import type { ArpRow, CamRow, ChannelMemberState, PortSecurityRow, RouteRow, TableColumn, TableName } from './tables.js';
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
import type { ClockSource } from './clock.js';
import type { DeviceStorageView } from './storage.js';

/** @since P2 L2 view of one bridged port of a VLAN-aware device, derived at snapshot time from config plus tables (D6). */
export interface PortL2View {
  config: SwitchportConfig;
  /** Effective operation: static modes as configured; dynamic modes from the dtp row (access until negotiated). */
  oper: 'access' | 'trunk';
  /** Trunk: VLANs allowed AND existing (canonical list). */
  active?: string;
  /** VLANs this port forwards in (canonical list); absent when spanning tree runs for none of its VLANs. */
  forwarding?: string;
  channel?: { group: number; bundle: PortId; state: ChannelMemberState };
  security?: { status: PortSecurityRow['status']; count: number; max: number; violations: number };
}

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

  // ── P2 (optional by meaning: absent keeps P1 snapshots stable) ──
  /**
   * @since P2 (optional by meaning) Present iff the device is VLAN-aware and the view differs from the default
   * (config ≠ DEFAULT_SWITCHPORT, oper 'trunk', channel or security present).
   */
  l2?: PortL2View;
  /** @since P2 (optional by meaning) Subinterfaces: the parent port. */
  parent?: PortId;
  /** @since P2 (optional by meaning) Subinterfaces: the 802.1Q encapsulation. */
  dot1q?: { vid: number; native: boolean };

  // ── P3 (optional by meaning: absent keeps P1/P2 snapshots stable; ARCHITECTURE-P3 §2.8) ──
  /**
   * @since P3 (optional by meaning) Present only on a port with a service policy: the M13 marking counters (runtime-owned
   * through DeviceRuntime.qosCounters, display only); [S20] widened with the queue view of a scheduler port.
   */
  qos?: PortQosView;
  /**
   * @since P3 (optional by meaning) The virtual FIFO of this egress port (D16): present only while the link model has
   * committed at least one frame here with txStart > now, absent otherwise, so an uncongested world never gains it.
   * Written in every profile by the snapshot cache (W2 sim); display only, never in the trace, and removed by the
   * digest normalisation (§4.6 item 2), so no golden sees it. The qos overlay's only queue source (D24). Named
   * `txBacklog` by the W0 ruling R6: the P0 frame count `txQueue` above stays as it is.
   */
  txBacklog?: PortTxQueueView;
}

/**
 * @since P3 The QoS view of a port with a service policy (ARCHITECTURE-P3 §2.8): the input and output policy names and
 * the per-class marking counters (M13). [S20] widens it with `queue`, the EgressQueueView of a port whose output policy
 * queues (the WAN map's `PortSnapshot.qos`).
 */
export interface PortQosView {
  input?: string;
  output?: string;
  /**
   * The classes of the input policy in policy order (class-default last), then those of the output policy (W3 device:
   * one list, so a consumer splits it by the policies' class lists; absent policy-map = no classes for it).
   */
  classes: readonly {
    name: string;
    matched: number;
    matchedBytes: number;
    marked: number;
    /**
     * @since P3 (optional by meaning) [S21] Ruling R26: the conform and exceed counts of the class's `police` action
     * when the runtime runs it (an input policer at step 10c; an output policer the link scheduler does not enforce).
     * Absent on a class without one (W3 device, the minimal additive member R26 needs to reach `qosCounters`).
     */
    police?: { conform: number; conformBytes: number; exceed: number; exceedBytes: number };
  }[];
  /** @since P3 (optional by meaning) [S20] The held class queues of a scheduler port. */
  queue?: EgressQueueView;
}

/**
 * @since P3 The frames the link model has committed on an egress port with txStart > now (the virtual FIFO, D16): the
 * depth and up to 8 of them, oldest first. The type of `PortSnapshot.txBacklog` (ARCHITECTURE-P3 §2.8, ruling R6): the
 * member is not called `txQueue`, so the required P0 frame count `PortSnapshot.txQueue: number` (snapshot-cache
 * `p.tx.queue`, pinned by goldens/accept.p05.p0-sequences.json and the P1 digests) is untouched.
 */
export interface PortTxQueueView {
  depth: number;
  frames: readonly {
    pdu: PduId;
    summary: PduSummary;
    txStart: SimTime;
    bytes: number;
    /**
     * @since P3 (optional by meaning; W1 contract fix, an additive member for the qos overlay's DSCP letters, D16, §6)
     * The frame's IPv4/IPv6 DSCP (0-63) when it carries an IP header; absent otherwise. `txBacklog` is display data
     * that the digest normalisation removes (§4.6), so no golden sees it.
     */
    dscp?: number;
  }[];
}

/**
 * @since P3 (optional by meaning) A device clock as the snapshot shows it (D19): present only in a P3 world, or when the
 * source is 'user', 'ntp' or 'master'; changes only on a set or a sync (the web extrapolates from `now`).
 */
export interface DeviceClockSnapshot {
  source: ClockSource;
  baseUnixMs: number;
  baseAt: SimTime;
  stratum?: number;
  reference?: string;
  tzOffsetMin: number;
  /**
   * @since P3 (optional by meaning; ruling R42, W4 web-shell, a minimal additive fix) The zone name of the device's
   * `clock timezone` line (`DeviceClockView.tz.name`, what `show clock` prints), so the device overview names the zone
   * exactly as the CLI does. Absent while the zone is the default UTC with offset 0 (no line), which keeps every
   * existing snapshot's bytes.
   */
  tzName?: string;
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

  // ── P3 (optional by meaning; ARCHITECTURE-P3 §2.8) ──
  /** @since P3 (optional by meaning) The device clock (D19); see DeviceClockSnapshot. */
  clock?: DeviceClockSnapshot;
  /**
   * @since P3 (optional by meaning) [S32] Present only on a host with user files in `files:` (the automation workspace's
   * file list; [S29], not approved, would add flash: and nvram:).
   */
  storage?: readonly DeviceStorageView[];
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
  /**
   * @since P2 (optional by meaning) The world's defaults profile when it is 'P2'; absent = 'P1' (D2).
   * 'P3' @since P3 (optional by meaning; ARCHITECTURE-P3 §2.8).
   */
  profile?: 'P2' | 'P3';
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
