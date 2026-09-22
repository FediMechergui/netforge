/**
 * Mediums beside point-to-point cables (spec §4.6, §4.9; ARCHITECTURE-P1 D4, D5).
 *
 *  • segment — a collision domain DERIVED from repeater ports and half-duplex/mismatched cables
 *              (never persisted). CSMA/CD with jam, binary exponential backoff (rng `link:<id>:csma`),
 *              half duplex, late collisions, collision counters. Every receiver gets its own clone.
 *  • air     — one AP radio (BSS) ↔ many stations. Management frames reach every radio in range on
 *              the band; data needs an authorized association. The medium rewraps 802.3 ↔ 802.11
 *              (Decapsulate/Encapsulate provenance) at the radio boundary, so arp/ipv4/eth-switch only
 *              ever see Ethernet on wireless ports; management and EAPOL frames stay dot11.
 *  • radio   — a PtP radio link (a TopologyLink of kind 'radio'); the P2P pipeline with RF-derived rate,
 *              loss and distance-derived propagation.
 *  • cell    — a tower radio serving UEs in range; behavioural attach; Ethernet frames on the air.
 * All ids and orders are deterministic (ordinal string compare, device-creation then port order).
 */
import type { DeviceId, PduId, PortId, PortRef } from './ids.js';
import type { MacAddress } from './addr.js';
import type { SimTime } from './time.js';
import type { ChannelWidthMhz, RfBand, WifiSecurity } from './rf.js';

export type MediumKind = 'cable' | 'segment' | 'radio' | 'air' | 'cell';

/**
 * Medium id. Cables and PtP radio links use their LinkId; segments 'seg:<ordinal-smallest member LinkId>';
 * a BSS 'bss:<apDevice>/<port>'; a cell 'cell:<towerDevice>/<port>'.
 */
export type MediumId = string;

/** 802.11 station state machine (scan/probe → auth (open|SAE) → assoc → EAPOL 4-way (simulated) → data). */
export type WifiAssocState = 'idle' | 'scanning' | 'authenticating' | 'associating' | 'handshake' | 'associated' | 'failed';
export type CellAttachState = 'idle' | 'searching' | 'attaching' | 'attached' | 'detached';

/**
 * Daemon → medium requests, carried by `Action {type:'medium'; port; op}`.
 * Authority: the station's wlan-client is the only writer of station scan/auth state ('sta-state');
 * the AP's wlan-ap is the only writer of grants ('assoc', 'authorize'); the medium itself only tears
 * associations down on physical loss (hold expiry, radio down, power off) and notifies both sides.
 * A station port is operUp iff carrier && associated && authorized (so DHCP/ARP start from onLinkChange).
 * A station port's `phy.carrier` is up whenever its radio is powered and admin up (AP: radio powered, admin up
 * and BSS configured), so dot11 management and EAPOL frames flow before operUp (frame pipeline step 4 gates wlan
 * ports on carrier; `admit` re-checks authorization before any dot11→ethernet data rewrap).
 *
 * Serial line protocol (D6): `line-protocol` sets or clears a keepalive LATCH on the reporting port only. The link
 * model applies `keepalive-missed` to that end alone (`phy.lineProtocol=false`, `lineProtocolReason=
 * 'keepalive-missed'`, operUp=false); the peer keeps operUp = carrier && its own lineProtocol. Losing carrier
 * clears both latches.
 */
export type MediumOp =
  | { op: 'sta-state'; state: WifiAssocState; ssid?: string; bssid?: MacAddress; reason?: string }
  | { op: 'assoc'; station: MacAddress; state: 'none' | 'authenticated' | 'associated'; aid?: number; reason?: string }
  | { op: 'authorize'; station: MacAddress }
  /** hdlc keepalive daemon: line protocol result on a serial port (D6). */
  | { op: 'line-protocol'; up: boolean; reason?: string }
  | { op: 'cell-attach' }
  | { op: 'cell-detach'; reason?: string };

/** Medium → daemon notifications (`Process.onMediumEvent`). */
export type MediumEvent =
  | { kind: 'beacon-loss'; bssid: MacAddress }
  | { kind: 'station-lost'; station: MacAddress; reason: 'out-of-range' | 'power-off' | 'radio-down' }
  | { kind: 'bss-down'; bssid: MacAddress }
  | { kind: 'rate-changed'; peer: MacAddress; rateBps: number }
  | { kind: 'cell-attached'; tower: PortRef }
  | { kind: 'cell-detached'; reason: string }
  /**
   * @since P0.5 `phy.carrier` of this port changed (serial, radio, wlan). Emitted by the link model to the port's
   * processes whenever carrier changes; the hdlc daemon arms/cancels `ka:<port>` from this and its keepalive
   * config (never from onLinkChange) and reads `phy.carrier` at init.
   */
  | { kind: 'carrier'; up: boolean }
  /**
   * @since P0.5 A BSS matching the station's config crossed the connect threshold (from onDevicesMoved/setScale/
   * onPortChanged) while the station's wlan-client is `scanning` or `failed(out-of-range|no-bss)`. wlan-client starts
   * a scan at once (non-periodic `scan` timer), so runToIdle waits for the reassociation.
   */
  | { kind: 'bss-in-range'; bssid: MacAddress };

export interface VisibleBss {
  bssid: MacAddress;
  ssid: string;
  band: RfBand;
  channel: number;
  security: WifiSecurity;
  rssiDbm: number;
  snrDb: number;
  /** RSSI and SINR meet the connect thresholds. */
  canAssociate: boolean;
}

export interface AirLinkView {
  rssiDbm: number;
  snrDb: number;
  rateBps: number;
  bars: 0 | 1 | 2 | 3 | 4;
}

/** Read-only RF view for daemons (`ProcessCtx.air`). Results are computed from current positions and settings. */
export interface AirView {
  /** BSSs whose AP radio is up on a band this radio supports, in range; sorted by rssi desc, then bssid ordinal. */
  visibleBss(port: PortId): readonly VisibleBss[];
  link(port: PortId, peer: MacAddress): AirLinkView | undefined;
}

/** CSMA/CD constants (802.3 half duplex, D4). Byte counts are serialized at the segment rate. */
export const CSMA = Object.freeze({
  PREAMBLE_BYTES: 8,
  IFG_BYTES: 12,
  SLOT_BYTES: 64,
  JAM_BYTES: 4,
  MAX_ATTEMPTS: 16,
  BACKOFF_LIMIT: 10,
  SEGMENT_TX_QUEUE_LIMIT: 64,
  /** Repeater latency per repeater hop, bytes. */
  REPEATER_DELAY_BYTES: 1,
  /** Rate of repeater ports (hubs are 10 Mb half duplex). */
  REPEATER_BPS: 10_000_000,
});

export interface SegmentMemberSnapshot {
  port: PortRef;
  role: 'station' | 'repeater';
  duplex: 'half' | 'full';
  tx: number;
  collisions: number;
  lateCollisions: number;
  deferred: number;
}

export interface SegmentSnapshot {
  id: MediumId;
  bps: number;
  /** Stations first, then repeater ports; each group in device-creation then port order. */
  members: SegmentMemberSnapshot[];
  links: string[];
  busy: boolean;
  /** Carrier currently on the wire. */
  active: { pdu: PduId; from: PortRef; txStart: SimTime; txEnd: SimTime; aborted?: boolean }[];
  collisions: number;
  warnings?: ('coax-segment-too-long' | 'repeater-rule-exceeded')[];
}

export interface BssSnapshot {
  id: MediumId;
  ap: PortRef;
  bssid: MacAddress;
  ssid: string;
  band: RfBand;
  channel: number;
  widthMhz: ChannelWidthMhz;
  security: WifiSecurity;
  up: boolean;
  /** At least one associated station (partial-overlap interference counts only while loaded). */
  loaded: boolean;
  /** Co-channel BSSs sharing airtime with this one. */
  contention: MediumId[];
  busyUntil: SimTime;
  // ── P2 (wireless; each optional by meaning: present only when not the default) ──
  /** @since P2 (optional by meaning) BSS index on its radio; absent = 0. */
  index?: number;
  /** @since P2 (optional by meaning) Controller WLAN id. */
  wlanId?: number;
  /** @since P2 (optional by meaning) VLAN the WLAN maps to. */
  vlan?: number;
  /** @since P2 (optional by meaning) Present only for a centrally switched BSS. */
  switching?: 'central';
}

export interface CellSnapshot {
  id: MediumId;
  tower: PortRef;
  up: boolean;
  ues: number;
  rangeM: number;
}

/** One Wi-Fi association or cellular attachment. Selection `{kind:'association', id}` addresses it. */
export interface AssociationSnapshot {
  /** `${medium}|${portKey(station)}`. */
  id: string;
  tech: 'wifi' | 'cellular';
  medium: MediumId;
  /** AP radio port (Wi-Fi) or tower port (cellular). */
  ap?: PortRef;
  station: PortRef;
  ssid?: string;
  bssid?: MacAddress;
  band: RfBand;
  channel: number;
  state: WifiAssocState | CellAttachState;
  authorized: boolean;
  aid?: number;
  rssiDbm: number;
  snrDb: number;
  rateBps: number;
  bars: 0 | 1 | 2 | 3 | 4;
  distanceM: number;
  since: SimTime;
  /** Set while the RF hold countdown runs (below the drop threshold). */
  holdUntil?: SimTime;
  reason?: string;
}

export interface NoiseSnapshot {
  key: string;
  band?: RfBand;
  channel?: number;
  center?: DeviceId;
  radiusM?: number;
  riseDb: number;
}

/** `SimSnapshot.media` — present when any segment/air/cell/radio medium exists or the scale is not the default. */
export interface MediaSnapshot {
  metresPerUnit: number;
  segments: SegmentSnapshot[];
  bss: BssSnapshot[];
  cells: CellSnapshot[];
  associations: AssociationSnapshot[];
  noise?: NoiseSnapshot[];
}
