/**
 * Trace stream (spec §4.4 `trace: TraceSink`, §9.1 animation, §9.4 tables, §9.7 timeline).
 *
 * Every observable thing the engine does is a TraceEvent. The UI consumes
 * batches of them; `debug` output, the packet list, the timeline lanes and
 * table flashes are all renderings of this one stream. Events are
 * structured-clone safe (no class instances, no functions) so they cross the
 * worker boundary untouched.
 *
 * Byte stability: optional fields added in P0.5/P1 are emitted only on non-P0 paths (or when they differ
 * from their default), so P0 scenario traces stay byte-identical apart from deliberate migrations.
 */
import type { DeviceId, LinkId, PduId, PortId, PortRef, ProcessName, SessionId } from './ids.js';
import type { MacAddress } from './addr.js';
import type { DropReason, PhyEndView } from './link.js';
import type { Mutation, ProtoName } from './pdu.js';
import type { DebugEvent, Severity } from './process.js';
import type { TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { CellAttachState, MediumId, MediumKind, WifiAssocState } from './medium.js';
import type { CliInputRequest } from './cli.js';

/** Compact PDU description embedded in events (full bytes fetched on demand via `Simulation.pdu(id)`). */
export interface PduSummary {
  id: PduId;
  parent?: PduId;
  proto: ProtoName;
  size: number;
  summary: string;
  flow?: string;
  tag?: string;
  /** @since P0.5 Full layer stack, outermost first (sim-mode protocol filters, NetScope). */
  layers?: ProtoName[];
  /** @since P2 (optional by meaning) Outermost 802.1Q VID, present only for tagged frames (packet colouring). */
  vlan?: number;
  /** @since P2 (optional by meaning; wireless) Present only while the frame is inside a CAPWAP tunnel. */
  tunnel?: 'capwap';
}

/** What a structural `topologyChanged` event is about. `module` @since P0.5 (id = `${deviceId}/${slotId}`). */
export type TopologyWhat = 'device' | 'link' | 'module';

export type TraceEvent =
  /** A frame started serialization on `from`; animation tuple. P0.5 media add one event per receiver leg. */
  | {
      t: SimTime;
      kind: 'frameTx';
      pdu: PduSummary;
      link: LinkId | MediumId;
      from: PortRef;
      to: PortRef;
      txStart: SimTime;
      txEnd: SimTime;
      arrive: SimTime;
      /** @since P0.5 Absent on P2P cables. */
      medium?: MediumKind;
      /** @since P0.5 Air/radio rate. */
      rateBps?: number;
      /** @since P0.5 Air/radio received signal. */
      rssiDbm?: number;
      /** @since P0.5 Maintenance traffic (PduMeta.background): the clock clamp and sim-mode list ignore it by default. */
      background?: boolean;
      /** @since P0.5 CSMA/CD or 802.11 attempt number (1-based) when > 1. */
      attempt?: number;
    }
  /** Frame fully received at `port` (before validation). */
  | { t: SimTime; kind: 'frameRx'; pdu: PduSummary; device: DeviceId; port: PortId }
  /** Dropped anywhere. `at` is where; `reason` is the floating tag; `detail` is the responsible rule/table entry. */
  | {
      t: SimTime; kind: 'drop'; pdu: PduSummary; device?: DeviceId; port?: PortId; link?: LinkId; reason: DropReason; detail?: string;
      /** @since P0.5 Non-cable medium where the drop happened (air, cell and segment paths only; P0 bytes unchanged). */
      medium?: string;
      /** @since P0.5 AssociationSnapshot.id when the drop concerns a station. */
      association?: string;
      /**
       * @since P2 (optional by meaning) Present only when the dropped PDU has meta.background (BPDUs on host ports, HSRP
       * hellos at hosts, HDLC keepalives, beacons). The trace filter, the canvas drop markers, the worker delta and the
       * sim-mode list skip them by default. P1 background PDUs that are dropped gain the key (a listed P1 digest change,
       * ARCHITECTURE-P2 §9.3 (b), made by W2 device — not before).
       */
      background?: true;
    }
  /** A PDU was created by a device process. */
  | { t: SimTime; kind: 'pduCreated'; pdu: PduSummary; device: DeviceId; process: ProcessName }
  /** A PDU was delivered to its final consumer (e.g. ICMP echo reply consumed by the ping job). */
  | { t: SimTime; kind: 'pduConsumed'; pdu: PduSummary; device: DeviceId; process: ProcessName }
  /** A field changed (mirror of Pdu.provenance so the timeline can show it live). */
  | { t: SimTime; kind: 'mutation'; pdu: PduId; mutation: Mutation }
  | { t: SimTime; kind: 'tableWrite'; device: DeviceId; table: TableName; key: string; row: Record<string, unknown>; previous?: Record<string, unknown> }
  | { t: SimTime; kind: 'tableExpire'; device: DeviceId; table: TableName; key: string; row: Record<string, unknown>; reason: string }
  | { t: SimTime; kind: 'debug'; event: DebugEvent }
  | { t: SimTime; kind: 'log'; device: DeviceId; severity: Severity; facility: string; message: string }
  | { t: SimTime; kind: 'linkState'; link: LinkId; up: boolean; reason?: string }
  /**
   * Port state change. `reason` values include P0 ones plus 'role-change', 'virtual-created', 'virtual-removed',
   * 'no-clock', 'keepalive-missed', 'associated', 'disassociated' (P0.5).
   */
  | {
      t: SimTime;
      kind: 'portState';
      device: DeviceId;
      port: PortId;
      adminUp: boolean;
      operUp: boolean;
      reason?: string;
      /** @since P0.5 Present ONLY when carrier !== operUp (serial "up, line protocol down"). */
      carrier?: boolean;
    }
  | { t: SimTime; kind: 'deviceState'; device: DeviceId; power: boolean; booted: boolean }
  | { t: SimTime; kind: 'cliOutput'; session: SessionId; text: string }
  | {
      t: SimTime;
      kind: 'cliPrompt';
      session: SessionId;
      prompt: string;
      busy: boolean;
      /** @since P1 Set when the next line answers an input request (the terminal masks 'secret' and skips history). */
      input?: CliInputRequest;
    }
  | { t: SimTime; kind: 'configChange'; device: DeviceId; line: string; negate: boolean; context: string[][] }
  /** Structural change. `add`/`remove` bump `topologyVersion` (UI refetches the snapshot); `move` does not. */
  | { t: SimTime; kind: 'topologyChanged'; what: TopologyWhat; id: string; op: 'add' | 'remove' | 'move' }

  // ── P0.5 media ──
  /** A frame leg was cut short (collision, radio loss, link down). The canvas truncates the capsule at `abortAt`. */
  | { t: SimTime; kind: 'frameAbort'; pdu: PduSummary; link: LinkId | MediumId; from: PortRef; to: PortRef; abortAt: SimTime; arrive: SimTime; reason: 'collision' | 'late-collision' | 'link-down' | 'out-of-range' | 'not-associated' }
  /** Collision on a segment: detected by `stations`, jam lasts until `jamUntil`. */
  | { t: SimTime; kind: 'collision'; segment: MediumId; stations: PortRef[]; pdus: PduId[]; detectAt: SimTime; jamUntil: SimTime; late: boolean }
  | { t: SimTime; kind: 'backoff'; device: DeviceId; port: PortId; pdu: PduId; attempt: number; slots: number; until: SimTime }
  | { t: SimTime; kind: 'carrierDefer'; device: DeviceId; port: PortId; pdu: PduId; until: SimTime }
  /** Speed/duplex negotiation result of a cable changed. */
  | { t: SimTime; kind: 'phyNegotiated'; link: LinkId; a: PhyEndView; b: PhyEndView; mismatch?: 'duplex' | 'speed' }
  /** Wi-Fi association or cellular attach state change. */
  | { t: SimTime; kind: 'assocState'; tech: 'wifi' | 'cellular'; medium: MediumId; station: PortRef; ap?: PortRef; bssid?: MacAddress; state: WifiAssocState | CellAttachState; prev: WifiAssocState | CellAttachState; reason?: string; rssiDbm?: number }
  /** RF link quality changed — emitted only when bars or rate change (not per milli-dB). */
  | { t: SimTime; kind: 'rfState'; port: PortRef; peer: PortRef; rssiDbm: number; snrDb: number; rateBps: number; bars: 0 | 1 | 2 | 3 | 4 }
  | { t: SimTime; kind: 'segmentChanged'; segment: MediumId; members: PortRef[]; op: 'formed' | 'changed' | 'dissolved' };

export type TraceKind = TraceEvent['kind'];

export interface TraceSink {
  emit(ev: TraceEvent): void;
}

/** Bounded ring of trace events with a monotonic cursor so consumers can drain incrementally. */
export interface TraceRing extends TraceSink {
  readonly capacity: number;
  /** Cursor of the next event to be emitted. */
  readonly head: number;
  /** Events with cursor >= `since` (clamped to what is still retained). */
  since(cursor: number): { events: TraceEvent[]; next: number; dropped: number };
  clear(): void;
}
