/**
 * link/media/air.ts — WirelessBss, the Wi-Fi air medium (ARCHITECTURE-P1 D5, §3.6; contracts/medium.ts, link.ts).
 *
 * One AP radio port (role wireless-bss, kind wlan) serves one BSS (index 0, id 'bss:<device>/<port>', BSSID
 * `bssidFor(radio MAC, 0)`); station radios (role wireless-client) associate with it. The medium never runs the
 * 802.11 state machine: the wlan-client daemon writes the station state (`sta-state`), the wlan-ap daemon writes the
 * grants (`assoc`, `authorize`), and the medium only tears an association down on physical loss (RF hold expiry, AP
 * radio down or reconfigured, power off) and notifies both sides.
 *
 * Radios are registered when the facade reports them (`onPortChanged`, `transmit`, `mediumOp`); every list the
 * medium builds is sorted explicitly (port keys and BSSIDs by ordinal string compare).
 *
 * Carrier and line protocol (the medium is the link-model writer of `operUp`/`phy` on wlan ports):
 *   AP port:      carrier = device up && adminUp && !errDisabled && SSID configured; line protocol = carrier.
 *   station port: carrier = device up && adminUp && !errDisabled; line protocol = associated && authorized
 *                 (reason 'not-associated' while carrier is up without authorization).
 * A carrier change notifies MediumEvent `carrier`; an operUp change emits `portState` (reason 'associated' /
 * 'disassociated', or the facade cause) and is returned as an OperChange.
 *
 * Transmit rules:
 *   • carrier down → drop `link-down`, ok:false. Frames other than 802.11 or Ethernet → `encapsulation-mismatch`.
 *   • station Ethernet data: needs an authorized association (else `not-associated`, ok:false); rewrapped to an
 *     802.11 to-DS data frame stamped with the station ('wireless client framing'); unicast to the AP.
 *   • AP Ethernet data: rewrapped from-DS stamped with the AP ('access point bridging'). Unicast → the authorized
 *     station with that MAC (else `not-associated`, ok:false). Group → every authorized station except the one whose
 *     MAC equals the Ethernet source (echo suppression), one clone per receiver when there are several.
 *   • management and EAPOL frames (never rewrapped) need only carrier plus range/band:
 *       station broadcast probe request → every up AP radio on a band the station supports, in range, any channel,
 *         no contention: start = now + DIFS + backoff from 'air:scan:<txKey>';
 *       station directed frame → the BSS whose BSSID equals addr1; AP group frame → every station radio in range on
 *         the BSS band; AP directed frame → the station radio with MAC addr1. No hearer → drop `out-of-range`
 *         (medium 'air'), ok:true (the frame went on the air).
 *
 * Timing (integer ns; `ser(n, rate)` = serializationNs):
 *   base  = max(now, busyUntil of the BSS and of every co-channel BSS sharing its airtime)
 *   start = base + DIFS + rng('air:<bss>:<txKey>').nextInt(0, CW) × SLOT            (one draw per attempt)
 *   end   = start + OFDM_PREAMBLE + ser(size, rate); one PER draw per attempt on rng('air:<bss>:<rxKey>'):
 *           lost iff nextInt(0, 999) < PER‰
 *   unicast: up to RETRY_LIMIT attempts; a failed attempt waits end + SIFS + OFDM_PREAMBLE + ser(ACK_BYTES, rate)
 *           and doubles CW (≤ CW_MAX); all lost → drop `link-loss` detail 'air retries exhausted', result lost.
 *   group:   one attempt, one PER draw per receiver in receiver order (group frames are not acknowledged).
 *   arrive = end + propagationNs(distance, 1.0). One `frameTx` per receiver (medium 'air', rateBps, rssiDbm,
 *   attempt when > 1, background) and one in-flight leg keyed (pdu, bss, to); data frames arrive with
 *   `rewrap: 'dot11-to-ethernet'`. The result carries `retries` when > 0.
 *   Rates: data uses the association's MCS rate; management, EAPOL and group data use the lowest MCS rate of the
 *   best generation shared on the band (20 MHz, one stream). Management PER uses that lowest MCS threshold.
 *   A radio's transmit backoff and receive PER draws use the stream labels of §5.1; when a label names the same
 *   radio for both uses the draws interleave on that one cached stream in event order (deterministic).
 *
 * admit: prunes the leg, records rx capture (802.11 bytes), re-checks authorization of data frames, rewraps them to
 * Ethernet stamped with the receiving device, and annotates `dot11-mgmt.rssiDbm` on probe responses and beacons
 * received by a station (reason 'Other', cause 'received signal annotation').
 *
 * RF (link/rf/*; integer milli-dB): distance = canvas distance × metresPerUnit (0.25 by default, `setScale`);
 * RSSI/SINR with co-channel and 2.4 GHz partial-overlap interference from the other up BSSs; MCS with the +2 dB
 * upgrade hysteresis; in range iff the station supports the BSS band and distance ≤ both radios' `maxRangeM`.
 * Mobility (`onDevicesMoved`, `setScale`, `onPortChanged`): every association is re-assessed (moved devices first,
 * then by BSS id and station port key); `rfState` only when bars or rate change; below the drop threshold with no
 * hold → mediumTimer 'hold:<stationKey>' at now + RF_HOLD_NS; back above the connect threshold → hold cancelled;
 * at expiry, still below the drop threshold → teardown with `beacon-loss` (station) and `station-lost
 * out-of-range` (AP). A BSS matching a scanning or failed(out-of-range | no-bss) station's SSID that crosses the
 * connect threshold notifies the station `bss-in-range`.
 *
 * Medium notifications are queued while the medium updates its state and delivered in order at the end of the
 * public call, so a daemon reacting synchronously always sees a consistent medium.
 */
import type { MacAddress } from '../../contracts/addr.js';
import { bssidFor } from '../../contracts/addr.js';
import type { DeviceId, LinkId, PortId, PortRef } from '../../contracts/ids.js';
import { portKey } from '../../contracts/ids.js';
import type { ArrivalVerdict, OperChanges, PortPhy, TransmitResult } from '../../contracts/link.js';
import type {
  AirLinkView,
  AirView,
  AssociationSnapshot,
  BssSnapshot,
  MediaSnapshot,
  MediumEvent,
  MediumId,
  MediumOp,
  VisibleBss,
  WifiAssocState,
} from '../../contracts/medium.js';
import type { Pdu } from '../../contracts/pdu.js';
import type { PortState } from '../../contracts/port.js';
import type { ChannelWidthMhz, RadioPortSpec, RadioPortView, RadioSettings, RfBand, WifiSecurity } from '../../contracts/rf.js';
import { MCS_TABLES, RF, radioModeOf } from '../../contracts/rf.js';
import type { SimTime } from '../../contracts/time.js';
import { propagationNs, serializationNs } from '../../contracts/time.js';
import type { TraceEvent } from '../../contracts/trace.js';
import { effectiveWidthMhz, interferersMdb, isValidChannel, resolveChannel } from '../rf/channels.js';
import type { ChannelNeighbour } from '../rf/channels.js';
import { BAND_GENERATIONS, assessRfLink, commonGeneration, mcsRateBps, perPermille } from '../rf/mcs.js';
import type { Bars, RfAssessment, RfLinkEnd } from '../rf/mcs.js';
import { canvasDistanceMm, pairRssi, rangeMetres } from '../rf/pathloss.js';
import {
  CAUSE_AP_BRIDGING,
  CAUSE_SIGNAL_ANNOTATION,
  CAUSE_STATION_FRAMING,
  annotate,
  applyRewrap,
  classifyAirFrame,
  dot11EthernetAddresses,
  dot11ToEthernetOp,
  ethernetToDot11Op,
  isGroupAddress,
  mgmtSubtype,
} from '../rewrap80211.js';
import { captureLinkTypeOf, summarizePdu } from './p2p.js';
import type { FrameArrivalBody, InflightLeg, MediumHost, MediumStrategy } from './types.js';
import { bssId, compareOrdinal } from './types.js';

/** Default metres per canvas unit (Topology.canvas.metresPerUnit). */
export const DEFAULT_METRES_PER_UNIT = 0.25;

/** Original drop details of the air medium. */
export const AIR_DETAILS = Object.freeze({
  notRadio: 'This port is not a Wi-Fi radio.',
  powerOff: 'The radio is switched off.',
  adminDown: 'The radio is administratively down.',
  errDisabled: 'The radio is error-disabled.',
  noSsid: 'The access radio has no SSID, so it serves no network.',
  notAssociated: 'The station is not associated and authorized with an access point.',
  unknownStation: 'No authorized station of this network has that address.',
  outOfRange: 'No radio in range answers to that address.',
  bssDown: 'The access point of this association is not serving its network any more.',
  retriesExhausted: 'air retries exhausted',
  lostOnAir: 'lost on the air',
  notWifiFrame: 'Only 802.11 and Ethernet frames can be sent on a Wi-Fi radio.',
  malformedData: 'The 802.11 data frame has no usable distribution-system addresses.',
});

/** Mediumtimer key prefix of an RF hold. */
export const HOLD_KEY_PREFIX = 'hold:';

/** The air medium: a MediumStrategy with the association, mobility and RF-view hooks it always implements. */
export interface AirMedium extends MediumStrategy {
  readonly kind: 'air';
  onPortChanged(ref: PortRef, now: SimTime, cause?: string): OperChanges;
  mediumOp(from: PortRef, op: MediumOp, now: SimTime): OperChanges;
  onMediumTimer(medium: MediumId, key: string, now: SimTime): OperChanges;
  onDevicesMoved(devices: readonly DeviceId[], now: SimTime): OperChanges;
  setScale(metresPerUnit: number, now: SimTime): OperChanges;
  contribute(now: SimTime, into: MediaSnapshot): void;
  /** BSSs a station radio hears (AirView.visibleBss for a PortRef). */
  visibleBss(port: PortRef): readonly VisibleBss[];
  /** RF view for the daemons of `device` (`ProcessCtx.air`). */
  airView(device: DeviceId): AirView;
  /** Radio part of a port snapshot, or undefined for ports that are not Wi-Fi radios. */
  radioPortView(ref: PortRef): RadioPortView | undefined;
  /** Association snapshot of a station port, if it holds one. */
  associationOf(station: PortRef): AssociationSnapshot | undefined;
  /** Registered radio ports, sorted by port key. */
  radios(): readonly PortRef[];
  /** Drop every radio of a removed device (tears its associations down and notifies the peers). */
  forgetDevice(device: DeviceId, now: SimTime): OperChanges;
  /** Current metres per canvas unit. */
  metresPerUnit(): number;
}

// ── internal records ─────────────────────────────────────────────────────────

interface RadioView {
  readonly ref: PortRef;
  readonly key: string;
  readonly port: PortState;
  readonly mode: 'ap' | 'station';
  readonly spec: RadioPortSpec;
  readonly settings: RadioSettings;
  readonly powered: boolean;
}

interface BssRecord {
  readonly id: MediumId;
  readonly ap: PortRef;
  readonly key: string;
  bssid: MacAddress;
  up: boolean;
  ssid: string;
  security: WifiSecurity;
  band: RfBand;
  channel: number;
  widthMhz: ChannelWidthMhz;
  signature: string;
  busyUntil: SimTime;
  since: SimTime;
  /** Associations by station port key. */
  readonly stations: Map<string, AssocRecord>;
}

interface AssocRecord {
  readonly station: PortRef;
  readonly key: string;
  readonly mac: MacAddress;
  readonly bss: BssRecord;
  granted: 'authenticated' | 'associated';
  authorized: boolean;
  aid?: number;
  since: SimTime;
  mcs?: number;
  rssiDbm: number;
  snrDb: number;
  rateBps: number;
  bars: Bars;
  distanceMm: number;
  reported?: { bars: Bars; rateBps: number };
  holdUntil?: SimTime;
  holdSeq?: number;
}

interface StationRecord {
  readonly ref: PortRef;
  readonly key: string;
  state: WifiAssocState;
  ssid?: string;
  bssid?: MacAddress;
  reason?: string;
  /** Last connect verdict per AP port key (bss-in-range crossing detection). */
  readonly inRange: Map<string, boolean>;
}

interface PairAssessment extends RfAssessment {
  readonly distanceMm: number;
  readonly inRange: boolean;
  /** In range and RSSI at or above the drop threshold: management frames are heard. */
  readonly hearing: boolean;
  readonly band: RfBand;
}

interface AirReceiver {
  readonly ref: PortRef;
  readonly key: string;
  readonly medium: MediumId;
  pdu: Pdu;
  readonly rssiDbm: number;
  readonly per: number;
  readonly distanceMm: number;
}

interface AirSend {
  readonly from: PortRef;
  readonly pdu: Pdu;
  /** BSS whose airtime is used; undefined for a scan (no contention). */
  readonly bss?: BssRecord;
  readonly txLabel: string;
  readonly rateBps: number;
  readonly unicast: boolean;
  readonly rewrap: boolean;
  readonly receivers: AirReceiver[];
}

/** Settings of a radio when the facade supplies none (catalog defaults, open, no SSID). */
export function defaultRadioSettings(spec: RadioPortSpec): RadioSettings {
  return {
    band: spec.defaultBand,
    channel: spec.defaultChannel,
    widthMhz: spec.defaultBand === '60' ? 2160 : 20,
    txPowerDbm: spec.maxTxPowerDbm,
    security: 'open',
  };
}

const byKey = <T extends { key: string }>(a: T, b: T): number => compareOrdinal(a.key, b.key);

/** Create the Wi-Fi air medium over a facade host. */
export function createAirMedium(host: MediumHost): AirMedium {
  /** Registered radio ports by port key (insertion order; lists are sorted where order matters). */
  const radios = new Map<string, PortRef>();
  /** BSS per AP port key. */
  const bssByAp = new Map<string, BssRecord>();
  /** Association per station port key. */
  const assocByStation = new Map<string, AssocRecord>();
  /** Station state records per station port key. */
  const stations = new Map<string, StationRecord>();
  /** Arrival seqs of data legs (802.11 data rewrapped at the receiver); only these die with a single association. */
  const dataLegs = new Set<number>();
  let scale = host.deps.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;

  // ── notification outbox ──
  const outbox: { ref: PortRef; ev: MediumEvent; now: SimTime }[] = [];
  let flushing = false;
  const notify = (ref: PortRef, ev: MediumEvent, now: SimTime): void => {
    outbox.push({ ref: { device: ref.device, port: ref.port }, ev, now });
  };
  const flush = (): void => {
    if (flushing) return;
    flushing = true;
    try {
      while (outbox.length > 0) {
        const item = outbox.shift()!;
        host.notify(item.ref, item.ev, item.now);
      }
    } finally {
      flushing = false;
    }
  };

  // ── radio views ──
  const view = (ref: PortRef): RadioView | undefined => {
    const port = host.port(ref);
    if (port === undefined || port.spec.kind !== 'wlan') return undefined;
    const role = port.role ?? port.spec.role;
    if (role === undefined) return undefined;
    const mode = radioModeOf('wlan', role);
    if (mode !== 'ap' && mode !== 'station') return undefined;
    const spec = port.spec.radio;
    if (spec === undefined) return undefined;
    const settings = host.deps.radioSettings(ref) ?? defaultRadioSettings(spec);
    return { ref: { device: ref.device, port: ref.port }, key: portKey(ref), port, mode, spec, settings, powered: host.deviceUp(ref.device) };
  };

  const register = (ref: PortRef): RadioView | undefined => {
    const v = view(ref);
    if (v === undefined) return undefined;
    if (!radios.has(v.key)) radios.set(v.key, v.ref);
    if (v.mode === 'ap' && !bssByAp.has(v.key)) {
      bssByAp.set(v.key, {
        id: bssId(v.ref), ap: v.ref, key: v.key, bssid: bssidFor(v.port.mac, 0), up: false, ssid: '', security: 'open',
        band: v.spec.defaultBand, channel: v.spec.defaultChannel, widthMhz: 20, signature: '', busyUntil: 0, since: 0, stations: new Map(),
      });
    }
    return v;
  };

  const sortedRadios = (): PortRef[] => [...radios.entries()].sort((a, b) => compareOrdinal(a[0], b[0])).map((e) => e[1]);
  const sortedBss = (): BssRecord[] => [...bssByAp.values()].sort((a, b) => compareOrdinal(a.bssid, b.bssid) || compareOrdinal(a.key, b.key));

  const bandOf = (v: RadioView): RfBand => (v.spec.bands.includes(v.settings.band) ? v.settings.band : v.spec.defaultBand);

  const radioCarrier = (v: RadioView): boolean => {
    if (!v.powered || !v.port.adminUp || v.port.errDisabled !== undefined) return false;
    if (v.mode === 'ap') return typeof v.settings.ssid === 'string' && v.settings.ssid !== '';
    return true;
  };

  const downDetail = (v: RadioView): string => {
    if (!v.powered) return AIR_DETAILS.powerOff;
    if (!v.port.adminUp) return AIR_DETAILS.adminDown;
    if (v.port.errDisabled !== undefined) return AIR_DETAILS.errDisabled;
    return AIR_DETAILS.noSsid;
  };

  const endOf = (v: RadioView): RfLinkEnd => ({
    txPowerDbm: Math.min(v.settings.txPowerDbm, v.spec.maxTxPowerDbm),
    antennaGainDbi: v.spec.antennaGainDbi,
    generations: v.spec.generations,
    streams: v.spec.streams,
  });

  const distanceMm = (a: DeviceId, b: DeviceId): number => {
    if (a === b) return 0;
    const pa = host.deps.position(a);
    const pb = host.deps.position(b);
    if (pa === undefined || pb === undefined) return 0;
    return canvasDistanceMm(pb.x - pa.x, pb.y - pa.y, scale);
  };

  const widthFor = (bss: BssRecord, sta: RadioView): ChannelWidthMhz => {
    const w = Math.min(bss.widthMhz, sta.spec.maxWidthMhz) as ChannelWidthMhz;
    return effectiveWidthMhz(bss.band, w);
  };

  const loaded = (bss: BssRecord): boolean => {
    for (const rec of bss.stations.values()) if (rec.authorized) return true;
    return false;
  };

  /** Other up BSSs on `band`, as neighbours of a receiver radio. */
  const neighboursAt = (receiver: RadioView, band: RfBand, exclude: BssRecord | undefined): ChannelNeighbour[] => {
    const out: ChannelNeighbour[] = [];
    for (const other of sortedBss()) {
      if (other === exclude || !other.up || other.band !== band || other.key === receiver.key) continue;
      const ov = view(other.ap);
      if (ov === undefined) continue;
      const d = distanceMm(ov.ref.device, receiver.ref.device);
      out.push({ band, channel: other.channel, rssiMdb: pairRssi(endOf(ov), endOf(receiver), band, d, 'wifi').rssiMdb, loaded: loaded(other) });
    }
    return out;
  };

  const assess = (ap: RadioView, bss: BssRecord, sta: RadioView, currentMcs?: number): PairAssessment => {
    const d = distanceMm(ap.ref.device, sta.ref.device);
    const maxMm = Math.min(ap.spec.maxRangeM, sta.spec.maxRangeM) * 1000;
    const inRange = sta.spec.bands.includes(bss.band) && d <= maxMm;
    const input = {
      band: bss.band,
      cls: 'wifi' as const,
      widthMhz: widthFor(bss, sta),
      distanceMm: d,
      a: endOf(ap),
      b: endOf(sta),
      interferersMdb: interferersMdb(bss.band, bss.channel, neighboursAt(sta, bss.band, bss)),
      ...(currentMcs !== undefined ? { currentMcs } : {}),
    };
    const a = assessRfLink(input);
    return {
      ...a,
      distanceMm: d,
      inRange,
      canConnect: inRange && a.canConnect,
      belowDrop: !inRange || a.belowDrop,
      hearing: inRange && a.rssiMdb >= RF.WIFI_DROP_RSSI_MDB,
      band: bss.band,
    };
  };

  /** Lowest MCS rate (20 MHz, one stream) of the best generation two radios share on a band; 1 Mb/s without one. */
  const basicRate = (band: RfBand, a: readonly RfLinkEnd['generations'][number][], b?: readonly RfLinkEnd['generations'][number][]): number => {
    let gen = b === undefined ? undefined : commonGeneration(band, a, b);
    if (b === undefined) for (const g of BAND_GENERATIONS[band]) if (a.includes(g)) gen = g;
    const first = gen === undefined ? undefined : MCS_TABLES[gen][0];
    return first === undefined ? 1_000_000 : mcsRateBps(first, 20, 1);
  };

  /** PER of a management frame at the lowest MCS of the pair's generation. */
  const mgmtPer = (a: PairAssessment): number => {
    if (!a.inRange || a.generation === undefined) return 1000;
    return perPermille(MCS_TABLES[a.generation][0], a.sinrMdb);
  };

  // ── port writes ──
  const writePort = (
    v: RadioView,
    carrier: boolean,
    lineUp: boolean,
    downReason: string | undefined,
    cause: string | undefined,
    rateBps: number,
    now: SimTime,
    changes: OperChanges,
  ): void => {
    const port = v.port;
    const prevCarrier = port.phy?.carrier === true;
    const operUp = carrier && lineUp;
    const phy: PortPhy = { carrier, lineProtocol: carrier && lineUp, medium: 'air' };
    if (carrier && !lineUp && downReason !== undefined) phy.lineProtocolReason = downReason;
    port.phy = phy;
    const operChanged = port.operUp !== operUp;
    port.operUp = operUp;
    if (operUp) {
      port.speedBps = rateBps > 0 ? rateBps : port.spec.speedBps;
      port.duplex = 'full';
    } else {
      delete port.speedBps;
      delete port.duplex;
    }
    if (operChanged || prevCarrier !== carrier) {
      port.lastChange = now;
      const ev: TraceEvent = { t: now, kind: 'portState', device: v.ref.device, port: v.ref.port, adminUp: port.adminUp, operUp };
      if (cause !== undefined) ev.reason = cause;
      if (carrier !== operUp) ev.carrier = carrier;
      host.emit(ev);
    }
    if (operChanged) changes.push({ port: { device: v.ref.device, port: v.ref.port }, operUp });
    if (prevCarrier !== carrier) notify(v.ref, { kind: 'carrier', up: carrier }, now);
  };

  const stationRecord = (ref: PortRef): StationRecord => {
    const key = portKey(ref);
    let rec = stations.get(key);
    if (rec === undefined) {
      rec = { ref: { device: ref.device, port: ref.port }, key, state: 'idle', inRange: new Map() };
      stations.set(key, rec);
    }
    return rec;
  };

  const emitAssocState = (s: StationRecord, prev: WifiAssocState, now: SimTime): void => {
    const bss = s.bssid === undefined ? undefined : sortedBss().find((b) => b.bssid === s.bssid);
    const assoc = assocByStation.get(s.key);
    const ev: Extract<TraceEvent, { kind: 'assocState' }> = {
      t: now, kind: 'assocState', tech: 'wifi', medium: bss?.id ?? assoc?.bss.id ?? 'air', station: s.ref, state: s.state, prev,
    };
    const apRef = bss?.ap ?? assoc?.bss.ap;
    if (apRef !== undefined) ev.ap = apRef;
    if (s.bssid !== undefined) ev.bssid = s.bssid;
    if (s.reason !== undefined) ev.reason = s.reason;
    if (assoc !== undefined) ev.rssiDbm = assoc.rssiDbm;
    host.emit(ev);
  };

  /**
   * Abort legs of a BSS: every leg when `stationKey` is undefined (the BSS went away), otherwise only the DATA legs
   * to or from that station (management and EAPOL frames need no association and keep flying).
   */
  const abortLegs = (bss: BssRecord, stationKey: string | undefined, now: SimTime, reason: 'link-down' | 'out-of-range' | 'not-associated'): void => {
    for (const leg of host.inflight.on(bss.id)) {
      if (leg.arrivalSeq === undefined) continue;
      if (stationKey !== undefined && (!dataLegs.has(leg.arrivalSeq) || (portKey(leg.to) !== stationKey && portKey(leg.from) !== stationKey))) continue;
      host.cancel(leg.arrivalSeq);
      dataLegs.delete(leg.arrivalSeq);
      const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: leg.pdu, reason: reason === 'out-of-range' ? 'out-of-range' : reason === 'not-associated' ? 'not-associated' : 'link-down', medium: bss.id };
      if (stationKey !== undefined) drop.association = `${bss.id}|${stationKey}`;
      // P2 (§2.7): a dropped background leg (beacon) is marked so the trace filter and the canvas can hide it
      if (leg.background === true) drop.background = true;
      host.emit(drop);
      host.emit({ t: now, kind: 'frameAbort', pdu: leg.pdu, link: bss.id, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason });
      host.inflight.delete(leg.pdu.id, leg.link, leg.to);
    }
  };

  /**
   * Remove an association, abort its legs, recompute the station port and queue the notifications.
   * The station port keeps its carrier; only the line protocol drops.
   */
  const teardown = (
    rec: AssocRecord,
    now: SimTime,
    changes: OperChanges,
    stationEvent: MediumEvent | undefined,
    apEvent: MediumEvent | undefined,
    abortReason: 'link-down' | 'out-of-range' | 'not-associated',
  ): void => {
    rec.bss.stations.delete(rec.key);
    if (assocByStation.get(rec.key) === rec) assocByStation.delete(rec.key);
    if (rec.holdSeq !== undefined) host.cancel(rec.holdSeq);
    abortLegs(rec.bss, rec.key, now, abortReason);
    const sv = view(rec.station);
    if (sv !== undefined) writePort(sv, radioCarrier(sv), false, 'not-associated', 'disassociated', 0, now, changes);
    if (stationEvent !== undefined) notify(rec.station, stationEvent, now);
    if (apEvent !== undefined) notify(rec.bss.ap, apEvent, now);
  };

  // ── RF re-assessment ──
  const reassess = (rec: AssocRecord, now: SimTime): void => {
    const ap = view(rec.bss.ap);
    const sta = view(rec.station);
    if (ap === undefined || sta === undefined) return;
    const a = assess(ap, rec.bss, sta, rec.mcs);
    rec.rssiDbm = a.rssiDbm;
    rec.snrDb = a.snrDb;
    rec.rateBps = a.rateBps;
    rec.bars = a.bars;
    rec.distanceMm = a.distanceMm;
    if (a.mcs === undefined) delete rec.mcs;
    else rec.mcs = a.mcs.mcs;
    if (rec.authorized && sta.port.operUp) sta.port.speedBps = a.rateBps > 0 ? a.rateBps : sta.port.spec.speedBps;
    if (rec.authorized && (rec.reported === undefined || rec.reported.bars !== a.bars || rec.reported.rateBps !== a.rateBps)) {
      rec.reported = { bars: a.bars, rateBps: a.rateBps };
      host.emit({ t: now, kind: 'rfState', port: rec.station, peer: rec.bss.ap, rssiDbm: a.rssiDbm, snrDb: a.snrDb, rateBps: a.rateBps, bars: a.bars });
    }
    if (a.belowDrop && rec.holdSeq === undefined) {
      rec.holdUntil = now + RF.RF_HOLD_NS;
      rec.holdSeq = host.schedule(rec.holdUntil, { kind: 'mediumTimer', medium: rec.bss.id, key: `${HOLD_KEY_PREFIX}${rec.key}` });
    } else if (a.canConnect && rec.holdSeq !== undefined) {
      host.cancel(rec.holdSeq);
      delete rec.holdSeq;
      delete rec.holdUntil;
    }
  };

  const checksInRange = (s: StationRecord): boolean =>
    s.ssid !== undefined && (s.state === 'scanning' || (s.state === 'failed' && (s.reason === 'out-of-range' || s.reason === 'no-bss')));

  /** Refresh the connect verdicts of a station against every matching BSS; notify the first false → true crossing. */
  const scanInRange = (s: StationRecord, now: SimTime, notifyCrossing: boolean): void => {
    const sv = view(s.ref);
    if (sv === undefined || !radioCarrier(sv)) return;
    let notified = false;
    for (const bss of sortedBss()) {
      if (!bss.up || bss.ssid !== s.ssid) {
        s.inRange.set(bss.key, false);
        continue;
      }
      const ap = view(bss.ap);
      const can = ap !== undefined && assess(ap, bss, sv).canConnect;
      const prev = s.inRange.get(bss.key) === true;
      s.inRange.set(bss.key, can);
      if (notifyCrossing && can && !prev && !notified) {
        notified = true;
        notify(s.ref, { kind: 'bss-in-range', bssid: bss.bssid }, now);
      }
    }
  };

  /** Re-assess every association (records touching `first` devices first) and run the bss-in-range checks. */
  const recomputeAll = (now: SimTime, first: ReadonlySet<DeviceId> | undefined): void => {
    const recs = [...assocByStation.values()].sort((x, y) => compareOrdinal(x.bss.id, y.bss.id) || compareOrdinal(x.key, y.key));
    const touches = (r: AssocRecord): boolean => first !== undefined && (first.has(r.station.device) || first.has(r.bss.ap.device));
    for (const r of recs) if (touches(r)) reassess(r, now);
    for (const r of recs) if (!touches(r)) reassess(r, now);
    const sts = [...stations.values()].sort(byKey);
    const moved = (s: StationRecord): boolean => first !== undefined && first.has(s.ref.device);
    for (const s of sts) if (moved(s) && checksInRange(s)) scanInRange(s, now, true);
    for (const s of sts) if (!moved(s) && checksInRange(s)) scanInRange(s, now, true);
  };

  // ── port recompute ──
  const recomputeAp = (v: RadioView, now: SimTime, cause: string | undefined, changes: OperChanges): void => {
    const bss = bssByAp.get(v.key)!;
    const carrier = radioCarrier(v);
    const band = bandOf(v);
    const width = effectiveWidthMhz(band, Math.min(v.settings.widthMhz, v.spec.maxWidthMhz) as ChannelWidthMhz);
    const signature = [v.settings.ssid ?? '', v.settings.security, v.settings.passphrase ?? '', band, String(v.settings.channel), String(width)].join('|');
    bss.bssid = bssidFor(v.port.mac, 0);
    if (bss.up && (!carrier || signature !== bss.signature)) {
      for (const rec of [...bss.stations.values()].sort(byKey)) {
        teardown(rec, now, changes, { kind: 'bss-down', bssid: bss.bssid }, undefined, 'link-down');
      }
      abortLegs(bss, undefined, now, 'link-down');
    }
    if (carrier && (!bss.up || signature !== bss.signature)) {
      bss.ssid = v.settings.ssid ?? '';
      bss.security = v.settings.security;
      bss.band = band;
      bss.widthMhz = width;
      bss.channel = resolveChannel(band, v.settings.channel, v.spec.defaultChannel, neighboursAt(v, band, bss));
      bss.signature = signature;
      bss.since = now;
      bss.busyUntil = now;
    }
    if (!carrier) bss.signature = '';
    bss.up = carrier;
    writePort(v, carrier, true, undefined, cause, 0, now, changes);
  };

  const recomputeStation = (v: RadioView, now: SimTime, cause: string | undefined, changes: OperChanges): void => {
    const carrier = radioCarrier(v);
    const rec = assocByStation.get(v.key);
    if (!carrier && rec !== undefined) {
      const reason = v.powered ? 'radio-down' : 'power-off';
      teardown(rec, now, changes, undefined, { kind: 'station-lost', station: rec.mac, reason }, 'link-down');
    }
    const current = assocByStation.get(v.key);
    writePort(v, carrier, current?.authorized === true, 'not-associated', cause, current?.rateBps ?? 0, now, changes);
    if (!carrier) {
      const s = stations.get(v.key);
      if (s !== undefined && s.state !== 'idle') {
        const prev = s.state;
        s.state = 'idle';
        s.reason = v.powered ? 'radio-down' : 'power-off';
        delete s.bssid;
        emitAssocState(s, prev, now);
      }
    }
  };

  const recomputePort = (v: RadioView, now: SimTime, cause: string | undefined, changes: OperChanges): void => {
    if (v.mode === 'ap') recomputeAp(v, now, cause, changes);
    else recomputeStation(v, now, cause, changes);
  };

  // ── transmission ──
  const emitDrop = (pdu: Pdu, reason: 'link-down' | 'not-associated' | 'out-of-range' | 'encapsulation-mismatch' | 'link-loss', detail: string, now: SimTime, at?: PortRef, medium?: MediumId, association?: string): void => {
    const ev: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summarizePdu(pdu), reason, detail };
    if (at !== undefined) {
      ev.device = at.device;
      ev.port = at.port;
    }
    if (medium !== undefined) ev.medium = medium;
    if (association !== undefined) ev.association = association;
    if (pdu.meta.background === true) ev.background = true;
    host.emit(ev);
  };

  const contentionOf = (bss: BssRecord): BssRecord[] => {
    const out: BssRecord[] = [];
    const ap = view(bss.ap);
    if (ap === undefined) return out;
    for (const other of sortedBss()) {
      if (other === bss || !other.up || other.band !== bss.band || other.channel !== bss.channel) continue;
      const ov = view(other.ap);
      if (ov === undefined) continue;
      const d = distanceMm(ap.ref.device, ov.ref.device);
      if (pairRssi(endOf(ap), endOf(ov), bss.band, d, 'wifi').rssiMdb >= RF.CS_THRESHOLD_MDB) out.push(other);
    }
    return out;
  };

  const deliverLeg = (s: AirSend, rx: AirReceiver, start: SimTime, end: SimTime, attempt: number, now: SimTime): SimTime => {
    const arrive = end + propagationNs(rx.distanceMm / 1000, 1.0);
    const summary = summarizePdu(rx.pdu);
    const from: PortRef = { device: s.from.device, port: s.from.port };
    const to: PortRef = { device: rx.ref.device, port: rx.ref.port };
    const tx: Extract<TraceEvent, { kind: 'frameTx' }> = {
      t: now, kind: 'frameTx', pdu: summary, link: rx.medium, from, to, txStart: start, txEnd: end, arrive, medium: 'air', rateBps: s.rateBps, rssiDbm: rx.rssiDbm,
    };
    if (s.pdu.meta.background === true) tx.background = true;
    if (attempt > 1) tx.attempt = attempt;
    host.emit(tx);
    const body: FrameArrivalBody = { kind: 'frameArrival', device: to.device, port: to.port, pdu: rx.pdu, medium: rx.medium };
    if (s.rewrap) body.rewrap = 'dot11-to-ethernet';
    const seq = host.schedule(arrive, body);
    if (s.rewrap) dataLegs.add(seq);
    host.inflight.sweep(now);
    const leg: InflightLeg = { pdu: summary, link: rx.medium, from, to, txStart: start, txEnd: end, arrive, medium: 'air', rateBps: s.rateBps, arrivalSeq: seq };
    if (s.pdu.meta.background === true) leg.background = true;
    host.inflight.add(leg);
    return arrive;
  };

  const send = (s: AirSend, now: SimTime): TransmitResult => {
    const linkId: LinkId | MediumId = s.bss?.id ?? s.receivers[0]?.medium ?? 'air';
    if (s.receivers.length === 0) return { ok: true, link: linkId, txStart: now, txEnd: now, arrive: now };
    const dur = RF.OFDM_PREAMBLE_NS + serializationNs(s.pdu.size, s.rateBps);
    const txRng = host.stream(s.txLabel);
    let base = now;
    if (s.bss !== undefined) {
      base = Math.max(base, s.bss.busyUntil);
      for (const other of contentionOf(s.bss)) base = Math.max(base, other.busyUntil);
    }
    let firstStart: SimTime | undefined;
    let lastEnd = now;
    let arriveMax = now;
    let retries = 0;
    let delivered = false;

    if (s.unicast) {
      const rx = s.receivers[0]!;
      const rxRng = host.stream(`air:${rx.medium}:${rx.key}`);
      const ackNs = RF.SIFS_NS + RF.OFDM_PREAMBLE_NS + serializationNs(RF.ACK_BYTES, s.rateBps);
      let cw: number = RF.CW_MIN;
      for (let attempt = 1; attempt <= RF.RETRY_LIMIT; attempt++) {
        const start = base + RF.DIFS_NS + txRng.nextInt(0, cw) * RF.SLOT_NS;
        const end = start + dur;
        if (firstStart === undefined) {
          firstStart = start;
          host.capture({ t: start, dir: 'tx', port: s.from, pdu: s.pdu, linkType: captureLinkTypeOf(s.pdu) });
        }
        lastEnd = end;
        const lost = rxRng.nextInt(0, 999) < rx.per;
        if (!lost) {
          arriveMax = deliverLeg(s, rx, start, end, attempt, now);
          retries = attempt - 1;
          delivered = true;
          base = end + ackNs;
          break;
        }
        retries = attempt;
        base = end + ackNs;
        cw = Math.min(2 * cw + 1, RF.CW_MAX);
      }
      if (!delivered) {
        retries = RF.RETRY_LIMIT - 1;
        emitDrop(s.pdu, 'link-loss', AIR_DETAILS.retriesExhausted, now, undefined, rx.medium, `${rx.medium}|${rx.key}`);
      }
      if (s.bss !== undefined) s.bss.busyUntil = Math.max(s.bss.busyUntil, base);
    } else {
      const start = base + RF.DIFS_NS + txRng.nextInt(0, RF.CW_MIN) * RF.SLOT_NS;
      const end = start + dur;
      firstStart = start;
      lastEnd = end;
      host.capture({ t: start, dir: 'tx', port: s.from, pdu: s.pdu, linkType: captureLinkTypeOf(s.pdu) });
      for (const rx of s.receivers) {
        const lost = host.stream(`air:${rx.medium}:${rx.key}`).nextInt(0, 999) < rx.per;
        if (lost) {
          emitDrop(rx.pdu, 'link-loss', AIR_DETAILS.lostOnAir, now, undefined, rx.medium);
          continue;
        }
        arriveMax = Math.max(arriveMax, deliverLeg(s, rx, start, end, 1, now));
        delivered = true;
      }
      if (s.bss !== undefined) s.bss.busyUntil = Math.max(s.bss.busyUntil, end);
    }
    const result: Extract<TransmitResult, { ok: true }> = { ok: true, link: linkId, txStart: firstStart ?? now, txEnd: lastEnd, arrive: delivered ? arriveMax : lastEnd };
    if (retries > 0) result.retries = retries;
    if (!delivered) result.lost = true;
    return result;
  };

  /** Give each receiver its own copy when there are several (the original stays the sender's identity). */
  const fanOut = (pdu: Pdu, receivers: AirReceiver[], now: SimTime): void => {
    if (receivers.length < 2) return;
    const clone = host.deps.pdus?.clone;
    if (clone === undefined) throw new Error('the air medium needs LinkModelDeps.pdus to copy a frame for several receivers');
    for (const rx of receivers) rx.pdu = clone(pdu, now);
  };

  const apTransmit = (v: RadioView, pdu: Pdu, now: SimTime): TransmitResult => {
    const bss = bssByAp.get(v.key)!;
    const cls = classifyAirFrame(pdu);
    if (cls === 'ethernet') {
      const eth = pdu.layers[0]!;
      const dst = eth.fields.dst;
      const src = eth.fields.src;
      if (typeof dst !== 'string' || typeof src !== 'string') {
        emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.notWifiFrame, now, v.ref, bss.id);
        return { ok: false, reason: 'encapsulation-mismatch' };
      }
      const group = isGroupAddress(dst);
      const targets = [...bss.stations.values()].filter((r) => r.authorized && (group ? r.mac !== src : r.mac === dst)).sort(byKey);
      if (!group && targets.length === 0) {
        emitDrop(pdu, 'not-associated', AIR_DETAILS.unknownStation, now, v.ref, bss.id);
        return { ok: false, reason: 'not-associated' };
      }
      const receivers: AirReceiver[] = [];
      for (const rec of targets) {
        const sv = view(rec.station);
        if (sv === undefined) continue;
        const a = assess(v, bss, sv, rec.mcs);
        receivers.push({ ref: rec.station, key: rec.key, medium: bss.id, pdu, rssiDbm: a.rssiDbm, per: group ? mgmtPer(a) : a.perPermille, distanceMm: a.distanceMm });
      }
      if (receivers.length === 0) return { ok: true, link: bss.id, txStart: now, txEnd: now, arrive: now };
      applyRewrap(pdu, ethernetToDot11Op(pdu, 'from-ds', bss.bssid), v.ref.device, now, CAUSE_AP_BRIDGING, host.emit);
      fanOut(pdu, receivers, now);
      const unicastRec = group ? undefined : targets[0];
      const sv0 = unicastRec === undefined ? undefined : view(unicastRec.station);
      const rate = unicastRec !== undefined && unicastRec.rateBps > 0
        ? unicastRec.rateBps
        : basicRate(bss.band, v.spec.generations, sv0?.spec.generations);
      return send({ from: v.ref, pdu, bss, txLabel: `air:${bss.id}:${v.key}`, rateBps: rate, unicast: !group, rewrap: true, receivers }, now);
    }
    if (cls === 'mgmt' || cls === 'eapol' || cls === 'ctrl') {
      const addr1 = pdu.layers[0]!.fields.addr1;
      if (typeof addr1 !== 'string') {
        emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.notWifiFrame, now, v.ref, bss.id);
        return { ok: false, reason: 'encapsulation-mismatch' };
      }
      const group = isGroupAddress(addr1);
      const receivers: AirReceiver[] = [];
      let rateGen: readonly RfLinkEnd['generations'][number][] | undefined;
      for (const ref of sortedRadios()) {
        const sv = view(ref);
        if (sv === undefined || sv.mode !== 'station' || sv.ref.device === v.ref.device || !radioCarrier(sv)) continue;
        if (!group && sv.port.mac !== addr1) continue;
        const a = assess(v, bss, sv, assocByStation.get(sv.key)?.mcs);
        if (!a.hearing) continue;
        receivers.push({ ref: sv.ref, key: sv.key, medium: bss.id, pdu, rssiDbm: a.rssiDbm, per: mgmtPer(a), distanceMm: a.distanceMm });
        if (!group) rateGen = sv.spec.generations;
        if (!group) break;
      }
      if (receivers.length === 0) {
        if (!group) emitDrop(pdu, 'out-of-range', AIR_DETAILS.outOfRange, now, v.ref, bss.id);
        return { ok: true, link: bss.id, txStart: now, txEnd: now, arrive: now };
      }
      fanOut(pdu, receivers, now);
      const rate = basicRate(bss.band, v.spec.generations, rateGen);
      return send({ from: v.ref, pdu, bss, txLabel: `air:${bss.id}:${v.key}`, rateBps: rate, unicast: !group, rewrap: false, receivers }, now);
    }
    emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.notWifiFrame, now, v.ref, bss.id);
    return { ok: false, reason: 'encapsulation-mismatch' };
  };

  const stationTransmit = (v: RadioView, pdu: Pdu, now: SimTime): TransmitResult => {
    const cls = classifyAirFrame(pdu);
    if (cls === 'ethernet') {
      const rec = assocByStation.get(v.key);
      if (rec === undefined || !rec.authorized) {
        emitDrop(pdu, 'not-associated', AIR_DETAILS.notAssociated, now, v.ref, rec?.bss.id ?? 'air');
        return { ok: false, reason: 'not-associated' };
      }
      const ap = view(rec.bss.ap);
      if (ap === undefined || !rec.bss.up) {
        emitDrop(pdu, 'link-down', AIR_DETAILS.bssDown, now, v.ref, rec.bss.id);
        return { ok: false, reason: 'link-down' };
      }
      const a = assess(ap, rec.bss, v, rec.mcs);
      applyRewrap(pdu, ethernetToDot11Op(pdu, 'to-ds', rec.bss.bssid), v.ref.device, now, CAUSE_STATION_FRAMING, host.emit);
      const rate = rec.rateBps > 0 ? rec.rateBps : basicRate(rec.bss.band, v.spec.generations, ap.spec.generations);
      const rx: AirReceiver = { ref: rec.bss.ap, key: rec.bss.key, medium: rec.bss.id, pdu, rssiDbm: a.rssiDbm, per: a.perPermille, distanceMm: a.distanceMm };
      return send({ from: v.ref, pdu, bss: rec.bss, txLabel: `air:${rec.bss.id}:${v.key}`, rateBps: rate, unicast: true, rewrap: true, receivers: [rx] }, now);
    }
    if (cls === 'mgmt' || cls === 'eapol' || cls === 'ctrl') {
      const addr1 = pdu.layers[0]!.fields.addr1;
      if (typeof addr1 !== 'string') {
        emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.notWifiFrame, now, v.ref, 'air');
        return { ok: false, reason: 'encapsulation-mismatch' };
      }
      if (isGroupAddress(addr1)) {
        const receivers: AirReceiver[] = [];
        for (const bss of [...bssByAp.values()].sort(byKey)) {
          if (!bss.up || bss.ap.device === v.ref.device) continue;
          const ap = view(bss.ap);
          if (ap === undefined) continue;
          const a = assess(ap, bss, v);
          if (!a.hearing) continue;
          receivers.push({ ref: bss.ap, key: bss.key, medium: bss.id, pdu, rssiDbm: a.rssiDbm, per: mgmtPer(a), distanceMm: a.distanceMm });
        }
        fanOut(pdu, receivers, now);
        const rate = basicRate(bandOf(v), v.spec.generations);
        return send({ from: v.ref, pdu, txLabel: `air:scan:${v.key}`, rateBps: rate, unicast: false, rewrap: false, receivers }, now);
      }
      const bss = sortedBss().find((b) => b.up && b.bssid === addr1);
      const ap = bss === undefined ? undefined : view(bss.ap);
      const a = bss === undefined || ap === undefined ? undefined : assess(ap, bss, v, assocByStation.get(v.key)?.mcs);
      if (bss === undefined || ap === undefined || a === undefined || !a.hearing) {
        emitDrop(pdu, 'out-of-range', AIR_DETAILS.outOfRange, now, v.ref, bss?.id ?? 'air');
        return { ok: true, link: bss?.id ?? 'air', txStart: now, txEnd: now, arrive: now };
      }
      const rx: AirReceiver = { ref: bss.ap, key: bss.key, medium: bss.id, pdu, rssiDbm: a.rssiDbm, per: mgmtPer(a), distanceMm: a.distanceMm };
      const rate = basicRate(bss.band, v.spec.generations, ap.spec.generations);
      return send({ from: v.ref, pdu, bss, txLabel: `air:${bss.id}:${v.key}`, rateBps: rate, unicast: true, rewrap: false, receivers: [rx] }, now);
    }
    emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.notWifiFrame, now, v.ref, 'air');
    return { ok: false, reason: 'encapsulation-mismatch' };
  };

  // ── views for daemons and snapshots ──
  const visibleBss = (ref: PortRef): readonly VisibleBss[] => {
    const sv = view(ref);
    if (sv === undefined || sv.mode !== 'station') return [];
    const out: VisibleBss[] = [];
    for (const bss of sortedBss()) {
      if (!bss.up || bss.ap.device === sv.ref.device) continue;
      const ap = view(bss.ap);
      if (ap === undefined) continue;
      const a = assess(ap, bss, sv);
      if (!a.hearing) continue;
      out.push({ bssid: bss.bssid, ssid: bss.ssid, band: bss.band, channel: bss.channel, security: bss.security, rssiDbm: a.rssiDbm, snrDb: a.snrDb, canAssociate: a.canConnect });
    }
    return out.sort((x, y) => y.rssiDbm - x.rssiDbm || compareOrdinal(x.bssid, y.bssid));
  };

  const linkView = (rec: AssocRecord): AirLinkView => ({ rssiDbm: rec.rssiDbm, snrDb: rec.snrDb, rateBps: rec.rateBps, bars: rec.bars });

  const associationSnapshot = (rec: AssocRecord): AssociationSnapshot => {
    const s = stations.get(rec.key);
    const out: AssociationSnapshot = {
      id: `${rec.bss.id}|${rec.key}`,
      tech: 'wifi',
      medium: rec.bss.id,
      ap: rec.bss.ap,
      station: rec.station,
      ssid: rec.bss.ssid,
      bssid: rec.bss.bssid,
      band: rec.bss.band,
      channel: rec.bss.channel,
      state: s !== undefined && s.bssid === rec.bss.bssid ? s.state : rec.authorized ? 'associated' : 'associating',
      authorized: rec.authorized,
      rssiDbm: rec.rssiDbm,
      snrDb: rec.snrDb,
      rateBps: rec.rateBps,
      bars: rec.bars,
      distanceM: Math.round(rec.distanceMm / 1000),
      since: rec.since,
    };
    if (rec.aid !== undefined) out.aid = rec.aid;
    if (rec.holdUntil !== undefined) out.holdUntil = rec.holdUntil;
    if (s?.reason !== undefined) out.reason = s.reason;
    return out;
  };

  const findStationByMac = (mac: MacAddress): RadioView | undefined => {
    for (const ref of sortedRadios()) {
      const sv = view(ref);
      if (sv !== undefined && sv.mode === 'station' && sv.port.mac === mac) return sv;
    }
    return undefined;
  };

  const air: AirMedium = {
    kind: 'air',

    transmit(from, pdu, now): TransmitResult {
      try {
        const v = register(from);
        if (v === undefined) {
          emitDrop(pdu, 'link-down', AIR_DETAILS.notRadio, now, from, 'air');
          return { ok: false, reason: 'link-down' };
        }
        if (!radioCarrier(v)) {
          emitDrop(pdu, 'link-down', downDetail(v), now, from, v.mode === 'ap' ? bssByAp.get(v.key)!.id : assocByStation.get(v.key)?.bss.id ?? 'air');
          return { ok: false, reason: 'link-down' };
        }
        return v.mode === 'ap' ? apTransmit(v, pdu, now) : stationTransmit(v, pdu, now);
      } finally {
        flush();
      }
    },

    admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict {
      try {
        const to: PortRef = { device: ev.device, port: ev.port };
        const leg = host.inflight.remove(ev.pdu.id, to);
        if (leg?.arrivalSeq !== undefined) dataLegs.delete(leg.arrivalSeq);
        const pdu = ev.pdu;
        host.capture({ t: now, dir: 'rx', port: to, pdu, linkType: captureLinkTypeOf(pdu) });
        const rv = view(to);
        if (ev.rewrap === 'dot11-to-ethernet') {
          const addrs = dot11EthernetAddresses(pdu);
          if (addrs === undefined || rv === undefined) {
            emitDrop(pdu, 'encapsulation-mismatch', AIR_DETAILS.malformedData, now, to, ev.medium);
            return { deliver: false };
          }
          if (addrs.direction === 'to-ds') {
            const bss = bssByAp.get(rv.key);
            const d = pdu.layers[0]!.fields;
            const station = typeof d.addr2 === 'string' ? d.addr2 : '';
            const rec = bss === undefined ? undefined : [...bss.stations.values()].find((r) => r.mac === station && r.authorized);
            if (bss === undefined || rec === undefined) {
              emitDrop(pdu, 'not-associated', AIR_DETAILS.notAssociated, now, to, ev.medium ?? bss?.id);
              return { deliver: false };
            }
            applyRewrap(pdu, dot11ToEthernetOp(pdu), to.device, now, CAUSE_AP_BRIDGING, host.emit);
          } else {
            const rec = assocByStation.get(rv.key);
            const transmitter = pdu.layers[0]!.fields.addr2;
            if (rec === undefined || !rec.authorized || rec.bss.bssid !== transmitter) {
              emitDrop(pdu, 'not-associated', AIR_DETAILS.notAssociated, now, to, ev.medium ?? rec?.bss.id);
              return { deliver: false };
            }
            applyRewrap(pdu, dot11ToEthernetOp(pdu), to.device, now, CAUSE_STATION_FRAMING, host.emit);
          }
          return { deliver: true, pdu, rx: { medium: 'air' } };
        }
        const subtype = mgmtSubtype(pdu);
        if (rv !== undefined && rv.mode === 'station' && (subtype === 'probe-resp' || subtype === 'beacon')) {
          const body = pdu.layers[1];
          const transmitter = pdu.layers[0]!.fields.addr2;
          const bss = sortedBss().find((b) => b.bssid === transmitter);
          const ap = bss === undefined ? undefined : view(bss.ap);
          if (body !== undefined && body.proto === 'dot11-mgmt' && body.error === undefined && bss !== undefined && ap !== undefined) {
            const a = assess(ap, bss, rv);
            annotate(pdu, 'dot11-mgmt.rssiDbm', a.rssiDbm, 'Other', to.device, now, CAUSE_SIGNAL_ANNOTATION, host.emit);
          }
        }
        return { deliver: true, pdu, rx: { medium: 'air' } };
      } finally {
        flush();
      }
    },

    abort(scope, now, detail) {
      for (const leg of host.inflight.on(scope)) {
        if (leg.arrivalSeq === undefined) continue;
        host.cancel(leg.arrivalSeq);
        dataLegs.delete(leg.arrivalSeq);
        const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: leg.pdu, reason: 'link-down', medium: scope };
        if (detail !== undefined) drop.detail = detail;
        if (leg.background === true) drop.background = true;
        host.emit(drop);
        host.emit({ t: now, kind: 'frameAbort', pdu: leg.pdu, link: scope, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason: 'link-down' });
        host.inflight.delete(leg.pdu.id, leg.link, leg.to);
      }
    },

    onPortChanged(ref, now, cause) {
      const changes: OperChanges = [];
      try {
        const v = register(ref);
        if (v === undefined) return changes;
        recomputePort(v, now, cause, changes);
        recomputeAll(now, undefined);
        return changes;
      } finally {
        flush();
      }
    },

    mediumOp(from, op, now) {
      const changes: OperChanges = [];
      try {
        const v = register(from);
        if (v === undefined) return changes;
        if (op.op === 'sta-state' && v.mode === 'station') {
          const s = stationRecord(v.ref);
          const prev = s.state;
          const prevReason = s.reason;
          const prevBssid = s.bssid;
          s.state = op.state;
          if (op.ssid !== undefined) s.ssid = op.ssid;
          else if (op.state === 'idle') delete s.ssid;
          if (op.bssid !== undefined) s.bssid = op.bssid;
          else if (op.state === 'idle' || op.state === 'scanning' || op.state === 'failed') delete s.bssid;
          if (op.reason !== undefined) s.reason = op.reason;
          else delete s.reason;
          const rec = assocByStation.get(v.key);
          const leaving = op.state === 'idle' || op.state === 'scanning' || op.state === 'failed'
            || (op.state === 'authenticating' && rec !== undefined && op.bssid !== undefined && op.bssid !== rec.bss.bssid);
          if (rec !== undefined && leaving) {
            teardown(rec, now, changes, undefined, { kind: 'station-lost', station: rec.mac, reason: 'radio-down' }, 'not-associated');
          }
          if (checksInRange(s)) scanInRange(s, now, false);
          if (prev !== s.state || prevReason !== s.reason || prevBssid !== s.bssid) emitAssocState(s, prev, now);
          return changes;
        }
        if (op.op === 'assoc' && v.mode === 'ap') {
          const bss = bssByAp.get(v.key)!;
          const sv = findStationByMac(op.station);
          if (sv === undefined) return changes;
          const existing = assocByStation.get(sv.key);
          if (op.state === 'none') {
            if (existing !== undefined && existing.bss === bss) teardown(existing, now, changes, undefined, undefined, 'not-associated');
            return changes;
          }
          if (!bss.up) return changes;
          let rec = existing;
          if (rec !== undefined && rec.bss !== bss) {
            teardown(rec, now, changes, undefined, { kind: 'station-lost', station: rec.mac, reason: 'radio-down' }, 'not-associated');
            rec = undefined;
          }
          if (rec === undefined) {
            const a = assess(v, bss, sv);
            rec = {
              station: sv.ref, key: sv.key, mac: op.station, bss, granted: op.state, authorized: false, since: now,
              rssiDbm: a.rssiDbm, snrDb: a.snrDb, rateBps: a.rateBps, bars: a.bars, distanceMm: a.distanceMm,
            };
            if (a.mcs !== undefined) rec.mcs = a.mcs.mcs;
            bss.stations.set(sv.key, rec);
            assocByStation.set(sv.key, rec);
          }
          rec.granted = op.state;
          if (op.aid !== undefined) rec.aid = op.aid;
          reassess(rec, now);
          return changes;
        }
        if (op.op === 'authorize' && v.mode === 'ap') {
          const bss = bssByAp.get(v.key)!;
          const rec = [...bss.stations.values()].find((r) => r.mac === op.station);
          if (rec === undefined || rec.authorized) return changes;
          rec.authorized = true;
          rec.granted = 'associated';
          const sv = view(rec.station);
          if (sv !== undefined) writePort(sv, radioCarrier(sv), true, 'not-associated', 'associated', rec.rateBps, now, changes);
          reassess(rec, now);
          return changes;
        }
        return changes;
      } finally {
        flush();
      }
    },

    onMediumTimer(medium, key, now) {
      const changes: OperChanges = [];
      try {
        if (!key.startsWith(HOLD_KEY_PREFIX)) return changes;
        const rec = assocByStation.get(key.slice(HOLD_KEY_PREFIX.length));
        if (rec === undefined || rec.bss.id !== medium || rec.holdSeq === undefined) return changes;
        delete rec.holdSeq;
        delete rec.holdUntil;
        const ap = view(rec.bss.ap);
        const sta = view(rec.station);
        const below = ap === undefined || sta === undefined || assess(ap, rec.bss, sta, rec.mcs).belowDrop;
        if (below) {
          teardown(rec, now, changes, { kind: 'beacon-loss', bssid: rec.bss.bssid }, { kind: 'station-lost', station: rec.mac, reason: 'out-of-range' }, 'out-of-range');
        }
        return changes;
      } finally {
        flush();
      }
    },

    onDevicesMoved(devices, now) {
      try {
        recomputeAll(now, new Set(devices));
        return [];
      } finally {
        flush();
      }
    },

    setScale(metresPerUnit, now) {
      try {
        if (Number.isFinite(metresPerUnit) && metresPerUnit > 0) scale = metresPerUnit;
        recomputeAll(now, undefined);
        return [];
      } finally {
        flush();
      }
    },

    contribute(_now, into) {
      for (const bss of [...bssByAp.values()].sort((a, b) => compareOrdinal(a.id, b.id))) {
        if (!bss.up && bss.ssid === '') continue;
        const snap: BssSnapshot = {
          id: bss.id, ap: bss.ap, bssid: bss.bssid, ssid: bss.ssid, band: bss.band, channel: bss.channel, widthMhz: bss.widthMhz,
          security: bss.security, up: bss.up, loaded: loaded(bss), contention: bss.up ? contentionOf(bss).map((b) => b.id) : [], busyUntil: bss.busyUntil,
        };
        into.bss.push(snap);
      }
      const recs = [...assocByStation.values()].sort((x, y) => compareOrdinal(x.bss.id, y.bss.id) || compareOrdinal(x.key, y.key));
      for (const rec of recs) into.associations.push(associationSnapshot(rec));
    },

    visibleBss,

    airView(device) {
      return {
        visibleBss: (port: PortId) => visibleBss({ device, port }),
        link: (port: PortId, peer: MacAddress) => {
          const key = portKey({ device, port });
          const own = assocByStation.get(key);
          if (own !== undefined) return own.bss.bssid === peer ? linkView(own) : undefined;
          const bss = bssByAp.get(key);
          if (bss === undefined) return undefined;
          const rec = [...bss.stations.values()].find((r) => r.mac === peer);
          return rec === undefined ? undefined : linkView(rec);
        },
      };
    },

    radioPortView(ref) {
      const v = view(ref);
      if (v === undefined) return undefined;
      const band = bandOf(v);
      const out: RadioPortView = {
        mode: v.mode,
        band,
        channel: typeof v.settings.channel === 'number' && isValidChannel(band, v.settings.channel) ? v.settings.channel : v.spec.defaultChannel,
        widthMhz: effectiveWidthMhz(band, Math.min(v.settings.widthMhz, v.spec.maxWidthMhz) as ChannelWidthMhz),
        txPowerDbm: Math.min(v.settings.txPowerDbm, v.spec.maxTxPowerDbm),
        up: radioCarrier(v),
        rangeM: rangeMetres(endOf(v), endOf(v), band, 'wifi', RF.WIFI_CONNECT_RSSI_MDB, v.spec.maxRangeM),
      };
      if (v.mode === 'ap') {
        const bss = bssByAp.get(v.key);
        if (bss !== undefined) {
          if (bss.up) out.channel = bss.channel;
          out.bssid = bss.bssid;
          out.clients = [...bss.stations.values()].filter((r) => r.authorized).length;
        }
        if (v.settings.ssid !== undefined) out.ssid = v.settings.ssid;
        out.security = v.settings.security;
        return out;
      }
      const s = stations.get(v.key);
      const rec = assocByStation.get(v.key);
      out.state = s?.state ?? 'idle';
      if (s?.ssid !== undefined) out.ssid = s.ssid;
      if (rec !== undefined) {
        out.band = rec.bss.band;
        out.channel = rec.bss.channel;
        out.bssid = rec.bss.bssid;
        out.security = rec.bss.security;
        out.peer = rec.bss.ap;
        out.rssiDbm = rec.rssiDbm;
        out.snrDb = rec.snrDb;
        out.rateBps = rec.rateBps;
        out.bars = rec.bars;
      }
      return out;
    },

    associationOf(station) {
      const rec = assocByStation.get(portKey(station));
      return rec === undefined ? undefined : associationSnapshot(rec);
    },

    radios() {
      return sortedRadios();
    },

    forgetDevice(device, now) {
      const changes: OperChanges = [];
      try {
        for (const ref of sortedRadios()) {
          if (ref.device !== device) continue;
          const key = portKey(ref);
          const bss = bssByAp.get(key);
          if (bss !== undefined) {
            for (const rec of [...bss.stations.values()].sort(byKey)) teardown(rec, now, changes, { kind: 'bss-down', bssid: bss.bssid }, undefined, 'link-down');
            abortLegs(bss, undefined, now, 'link-down');
            bssByAp.delete(key);
          }
          const rec = assocByStation.get(key);
          if (rec !== undefined) teardown(rec, now, changes, undefined, { kind: 'station-lost', station: rec.mac, reason: 'power-off' }, 'link-down');
          stations.delete(key);
          radios.delete(key);
        }
        for (const s of stations.values()) {
          for (const k of [...s.inRange.keys()]) if (!bssByAp.has(k)) s.inRange.delete(k);
        }
        return changes.filter((c) => c.port.device !== device);
      } finally {
        flush();
      }
    },

    metresPerUnit() {
      return scale;
    },
  };
  return air;
}
