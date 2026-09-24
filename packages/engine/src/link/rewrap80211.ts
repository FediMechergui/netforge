/**
 * link/rewrap80211.ts — 802.3 ↔ 802.11 framing at the radio boundary, plus the shared 802.11 frame builders and
 * the simulated key tags of the association daemons (ARCHITECTURE-P1 D5, §3.6; contracts/fields.ts dot11/llc).
 *
 * Rewrap rules (the air medium applies them; the Decapsulate/Encapsulate provenance is stamped with the
 * transmitting device on egress and with the receiving device on ingress):
 *   station → AP  (to DS):   strip ethernet, push [dot11 data toDs, addr1 = BSSID, addr2 = eth.src, addr3 = eth.dst, llc {type}]
 *   AP → station  (from DS): strip ethernet, push [dot11 data fromDs, addr1 = eth.dst, addr2 = BSSID, addr3 = eth.src, llc {type}]
 *   dot11 → ethernet:        strip dot11 + llc, push ethernet {dst: toDs ? addr3 : addr1, src: toDs ? addr2 : addr3, type: llc.type}
 * Management frames and EAPOL data frames (llc 0x888e) are never rewrapped: the wlan daemons build them as dot11.
 *
 * Simulated secrets (never the passphrase itself on the wire):
 *   • `passphraseTag(ssid, passphrase)` = FNV-1a 32 over the UTF-8 bytes of `ssid \0 passphrase`. EAPOL message 2
 *     carries it big-endian in `eapol.keyData` (4 bytes).
 *   • SAE commit frames carry the 16-bit fold of the tag (`saeCommitTag`) in the 802.11 `duration` field, the
 *     simulated commit element; a confirm has status 1 when the peer's commit tag differs from the local one.
 *
 * Everything here is pure (no engine state) except `applyRewrap` / `annotate`, which write through the PDU's
 * recorded write paths and mirror each new provenance entry as a `mutation` trace event.
 *
 * P2 central switching (ARCHITECTURE-P2 D17, §3.12 steps 6–8; W5 wireless). A BSS whose controller profile says
 * `switching: 'central'` is not bridged at the access point: the air hands the station's 802.11 to-DS data frame to
 * the AP unchanged (`frameArrival.central`), capwap-wtp carries it to the controller inside CAPWAP, and the controller
 * turns it into a tagged Ethernet frame of the WLAN's VLAN. The way back is a pre-built 802.11 from-DS data frame that
 * the AP puts on the air as it is. The helpers below describe those frames; the tunnel ops themselves live in the two
 * CAPWAP daemons (protocols/capwap-wtp.ts, protocols/capwap-ac.ts):
 *   • `dot11HeaderSpec(layer)`       the header of a received 802.11 data frame as a layer spec (no FCS: the codec
 *                                    derives it, and omits it inside a CAPWAP tunnel);
 *   • `fromDsDataHeaders(…)`         `[dot11 data fromDs {addr1 destination, addr2 BSSID, addr3 source}, llc {type}]`,
 *                                    the controller's downlink framing (§3.12 step 8);
 *   • causes `CAUSE_CAPWAP_TUNNEL` ('controller tunnel', the AP's encapsulation and decapsulation, step 6) and
 *     `CAUSE_CONTROLLER_BRIDGING` ('controller bridging', the controller's decapsulation plus VLAN tag and its downlink
 *     encapsulation, step 7).
 * Nothing here changes a local BSS: every P0.5/P1 helper keeps its behaviour and its bytes.
 */
import type { MacAddress } from '../contracts/addr.js';
import { MAC_BROADCAST, isMulticastMac } from '../contracts/addr.js';
import type { DeviceId } from '../contracts/ids.js';
import type { FieldValue, LayerSpec, MutationReason, Pdu, PduView, RewrapOp } from '../contracts/pdu.js';
import { ETHERTYPE_EAPOL } from '../contracts/pdu.js';
import type { SimTime } from '../contracts/time.js';
import type { TraceEvent } from '../contracts/trace.js';

/** Provenance cause of the station-side framing (both directions). */
export const CAUSE_STATION_FRAMING = 'wireless client framing';
/** Provenance cause of the access-point-side framing (both directions). */
export const CAUSE_AP_BRIDGING = 'access point bridging';
/** Provenance cause of the received-signal annotation written on probe responses and beacons. */
export const CAUSE_SIGNAL_ANNOTATION = 'received signal annotation';
/** @since P2 (wireless) Provenance cause of the access point's CAPWAP tunnel encapsulation and decapsulation (§3.12 step 6). */
export const CAUSE_CAPWAP_TUNNEL = 'controller tunnel';
/** @since P2 (wireless) Provenance cause of the controller's bridging between its tunnel and a VLAN (§3.12 steps 7–8). */
export const CAUSE_CONTROLLER_BRIDGING = 'controller bridging';

/** @since P2 (wireless) The header fields of an 802.11 frame a layer spec carries (the FCS is derived by the codec). */
export const DOT11_HEADER_FIELDS: readonly string[] = Object.freeze([
  'frameType', 'subtype', 'toDs', 'fromDs', 'retry', 'protected', 'duration', 'addr1', 'addr2', 'addr3', 'seq',
]);

/** Direction of an 802.11 data frame relative to the distribution system. */
export type DsDirection = 'to-ds' | 'from-ds';

/** What an air frame is, as the medium and the daemons classify it. */
export type AirFrameClass = 'mgmt' | 'ctrl' | 'eapol' | 'dot11-data' | 'ethernet' | 'other';

/** Supported rates advertised on 2.4 GHz (Mb/s, comma-separated FIELDS form). */
export const RATES_24 = '1,2,5.5,11,6,9,12,18,24,36,48,54';
/** Supported rates advertised on 5/6/60 GHz. */
export const RATES_OFDM = '6,9,12,18,24,36,48,54';

/** True for group addresses (broadcast or multicast). */
export function isGroupAddress(mac: MacAddress): boolean {
  return isMulticastMac(mac);
}

function str(v: FieldValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Classify a frame by its outer layers (see `AirFrameClass`). */
export function classifyAirFrame(pdu: Pick<PduView, 'layers'>): AirFrameClass {
  const outer = pdu.layers[0];
  if (outer === undefined) return 'other';
  if (outer.proto === 'ethernet') return 'ethernet';
  if (outer.proto !== 'dot11') return 'other';
  const type = outer.fields.frameType;
  if (type === 'mgmt') return 'mgmt';
  if (type === 'ctrl') return 'ctrl';
  if (type !== 'data') return 'other';
  const llc = pdu.layers[1];
  if (llc !== undefined && llc.proto === 'llc' && llc.fields.type === ETHERTYPE_EAPOL) return 'eapol';
  return 'dot11-data';
}

/** Management subtype of a dot11 frame (`probe-req`, `auth`, …), undefined for other frames. */
export function mgmtSubtype(pdu: Pick<PduView, 'layers'>): string | undefined {
  const outer = pdu.layers[0];
  if (outer === undefined || outer.proto !== 'dot11' || outer.fields.frameType !== 'mgmt') return undefined;
  return str(outer.fields.subtype);
}

/**
 * Rewrap op turning an Ethernet frame into an 802.11 data frame (see the file header).
 * @throws Error when the outer layer is not ethernet or its addresses are missing
 */
export function ethernetToDot11Op(pdu: Pick<PduView, 'layers'>, direction: DsDirection, bssid: MacAddress): RewrapOp {
  const eth = pdu.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') throw new Error('802.11 framing needs an ethernet frame');
  const dst = str(eth.fields.dst);
  const src = str(eth.fields.src);
  const type = eth.fields.type;
  if (dst === undefined || src === undefined || typeof type !== 'number') throw new Error('802.11 framing needs ethernet dst, src and type');
  const dot11: LayerSpec = direction === 'to-ds'
    ? { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, fromDs: false, addr1: bssid, addr2: src, addr3: dst } }
    : { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: false, fromDs: true, addr1: dst, addr2: bssid, addr3: src } };
  return { strip: 1, push: [dot11, { proto: 'llc', fields: { type } }] };
}

/** Ethernet addresses an 802.11 data frame maps back to, or undefined when the frame is not a DS data frame. */
export function dot11EthernetAddresses(pdu: Pick<PduView, 'layers'>): { dst: MacAddress; src: MacAddress; type: number; direction: DsDirection } | undefined {
  const d = pdu.layers[0];
  const llc = pdu.layers[1];
  if (d === undefined || d.proto !== 'dot11' || d.fields.frameType !== 'data') return undefined;
  if (llc === undefined || llc.proto !== 'llc' || typeof llc.fields.type !== 'number') return undefined;
  const toDs = d.fields.toDs === true;
  const fromDs = d.fields.fromDs === true;
  if (toDs === fromDs) return undefined;
  const a1 = str(d.fields.addr1);
  const a2 = str(d.fields.addr2);
  const a3 = str(d.fields.addr3);
  if (a1 === undefined || a2 === undefined || a3 === undefined) return undefined;
  return toDs
    ? { dst: a3, src: a2, type: llc.fields.type, direction: 'to-ds' }
    : { dst: a1, src: a3, type: llc.fields.type, direction: 'from-ds' };
}

/**
 * Rewrap op turning an 802.11 DS data frame (dot11 + llc) back into Ethernet.
 * @throws Error when the frame is not a to-DS / from-DS data frame with an LLC header
 */
export function dot11ToEthernetOp(pdu: Pick<PduView, 'layers'>): RewrapOp {
  const a = dot11EthernetAddresses(pdu);
  if (a === undefined) throw new Error('802.3 framing needs an 802.11 data frame with an LLC/SNAP header');
  return { strip: 2, push: [{ proto: 'ethernet', fields: { dst: a.dst, src: a.src, type: a.type } }] };
}

/**
 * @since P2 (wireless) The header of an 802.11 layer as a layer spec: every field of `DOT11_HEADER_FIELDS` the layer
 * carries, copied as it is. Re-encoding the spec gives the same header; the FCS is derived by the codec (and left out
 * inside a CAPWAP tunnel).
 */
export function dot11HeaderSpec(layer: { readonly fields: Readonly<Record<string, FieldValue>> }): LayerSpec {
  const fields: Record<string, FieldValue> = {};
  for (const key of DOT11_HEADER_FIELDS) {
    const v = layer.fields[key];
    if (v !== undefined) fields[key] = v;
  }
  return { proto: 'dot11', fields };
}

/**
 * @since P2 (wireless) The controller's downlink framing of a frame for `destination` (§3.12 step 8): an 802.11
 * from-DS data frame `addr1 = destination, addr2 = bssid, addr3 = source` followed by the LLC/SNAP header of `type`.
 * The access point puts the frame on the air unchanged; the station's admit turns it back into Ethernet.
 */
export function fromDsDataHeaders(destination: MacAddress, bssid: MacAddress, source: MacAddress, type: number): LayerSpec[] {
  return [
    { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: false, fromDs: true, addr1: destination, addr2: bssid, addr3: source } },
    { proto: 'llc', fields: { type } },
  ];
}

/** Emit one `mutation` trace event per provenance entry recorded since `from`. */
function mirror(pdu: Pdu, from: number, emit: (ev: TraceEvent) => void, now: SimTime): void {
  const prov = pdu.provenance;
  for (let i = from; i < prov.length; i++) emit({ t: now, kind: 'mutation', pdu: pdu.id, mutation: prov[i]! });
}

/** Apply a rewrap stamped with `device` at `now` and mirror the recorded mutations into the trace. */
export function applyRewrap(pdu: Pdu, op: RewrapOp, device: DeviceId, now: SimTime, cause: string, emit: (ev: TraceEvent) => void): void {
  const from = pdu.provenance.length;
  pdu.rewrap({ now, device }, op, cause);
  mirror(pdu, from, emit, now);
}

/** Write one field through `Pdu.mutate` stamped with `device` and mirror the recorded mutations into the trace. */
export function annotate(
  pdu: Pdu,
  field: string,
  value: FieldValue,
  reason: MutationReason,
  device: DeviceId,
  now: SimTime,
  cause: string,
  emit: (ev: TraceEvent) => void,
): void {
  const from = pdu.provenance.length;
  pdu.mutate({ now, device }, field, value, reason, cause);
  mirror(pdu, from, emit, now);
}

// ── frame builders ───────────────────────────────────────────────────────────

/** Header addresses of a management frame. */
export interface MgmtAddresses {
  /** Receiver. */
  readonly addr1: MacAddress;
  /** Transmitter. */
  readonly addr2: MacAddress;
  /** BSSID (broadcast for a wildcard probe request). */
  readonly addr3: MacAddress;
  /** 802.11 duration field (SAE commit frames carry the simulated commit tag here). */
  readonly duration?: number;
}

/** Layers of a management frame: `[dot11 mgmt <subtype>, dot11-mgmt <body>]`. */
export function mgmtFrame(subtype: string, addrs: MgmtAddresses, body: Record<string, FieldValue>): LayerSpec[] {
  const header: Record<string, FieldValue> = {
    frameType: 'mgmt', subtype, addr1: addrs.addr1, addr2: addrs.addr2, addr3: addrs.addr3,
  };
  if (addrs.duration !== undefined) header.duration = addrs.duration;
  return [{ proto: 'dot11', fields: header }, { proto: 'dot11-mgmt', fields: body }];
}

/** Layers of a wildcard or directed probe request from a station. */
export function probeRequestFrame(station: MacAddress, ssid: string): LayerSpec[] {
  return mgmtFrame('probe-req', { addr1: MAC_BROADCAST, addr2: station, addr3: MAC_BROADCAST }, { ssid });
}

/** Fields of one EAPOL-Key message. */
export interface EapolKeyFields {
  readonly step: number;
  readonly replayCounter: number;
  readonly keyData?: Uint8Array;
}

/**
 * Layers of an EAPOL-Key message carried as an 802.11 data frame: `[dot11 data, llc 0x888e, eapol]`.
 * `to-ds` (station → AP): addr1 = BSSID, addr2 = station, addr3 = BSSID; `from-ds` (AP → station): addr1 = station,
 * addr2 = BSSID, addr3 = BSSID.
 */
export function eapolFrame(direction: DsDirection, station: MacAddress, bssid: MacAddress, key: EapolKeyFields): LayerSpec[] {
  const header: Record<string, FieldValue> = direction === 'to-ds'
    ? { frameType: 'data', subtype: 'data', toDs: true, fromDs: false, addr1: bssid, addr2: station, addr3: bssid }
    : { frameType: 'data', subtype: 'data', toDs: false, fromDs: true, addr1: station, addr2: bssid, addr3: bssid };
  const eapol: Record<string, FieldValue> = {
    keyType: 'pairwise',
    handshakeStep: key.step,
    replayCounter: key.replayCounter,
    keyData: key.keyData ?? new Uint8Array(0),
  };
  if (key.step !== 1) eapol.mic = true;
  return [{ proto: 'dot11', fields: header }, { proto: 'llc', fields: { type: ETHERTYPE_EAPOL } }, { proto: 'eapol', fields: eapol }];
}

// ── simulated key tags ───────────────────────────────────────────────────────

const UTF8 = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of `ssid`, a NUL byte and `passphrase` (unsigned). */
export function passphraseTag(ssid: string, passphrase: string): number {
  const bytes = UTF8.encode(`${ssid} ${passphrase}`);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

/** 4-byte big-endian form of a tag (EAPOL message 2 key data). */
export function tagBytes(tag: number): Uint8Array {
  const t = tag >>> 0;
  return new Uint8Array([(t >>> 24) & 0xff, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff]);
}

/** Tag carried in 4-byte key data, or undefined when the bytes are not exactly a tag. */
export function tagFromBytes(bytes: FieldValue | undefined): number | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 4) return undefined;
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

/** 16-bit fold of a tag (high half XOR low half): the simulated SAE commit element. */
export function saeCommitTag(tag: number): number {
  const t = tag >>> 0;
  return ((t >>> 16) ^ (t & 0xffff)) & 0xffff;
}
