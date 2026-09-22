/**
 * Field vocabulary: formatters for decoded header fields, provenance mutation reasons and generic table
 * cells (ARCHITECTURE-P1 §7; replaces the P0 `PacketInspector.fmtValue` name tables and the
 * `Provenance.REASON_ICON` / `REASON_LABEL` tables with one registry shared by the packet inspector, the
 * provenance timeline, the generic tables view and NetScope).
 *
 * Field semantics come from the engine's `PROTO_FIELDS` (types, bit widths, docs) and number names from its
 * `DISPATCH_TABLE`; this file adds the human rendering. Every formatter is pure and total: unknown protocols,
 * fields and values fall back to a plain rendering instead of throwing. All wording is original (§1.6).
 */
import { DISPATCH_TABLE, ETH_LENGTH_MAX, NF_OUI, PROTO_FIELDS, formatSimTime } from '@netforge/engine';
import type { FieldSpec, FieldValue, MutationReason, SimTime, TableColumn } from '@netforge/engine';
import { protocolLabel } from './protocols.js';
import { CELL_ATTACH_STATE_VOCAB, WIFI_ASSOC_STATE_VOCAB } from './trace-kinds.js';

/** Decoded fields of one layer, used by formatters that depend on a sibling field (ICMP code by type). */
export type LayerFields = Readonly<Record<string, FieldValue>>;

/** Rendering used for a missing value. */
export const EMPTY_VALUE = '—';

// ── number names ─────────────────────────────────────────────────────────────

function dispatchNames(space: string, extra: readonly (readonly [number, string])[] = []): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  for (const e of DISPATCH_TABLE) {
    if (e.space === space && !out.has(e.key)) out.set(e.key, protocolLabel(e.proto));
  }
  for (const [k, v] of extra) if (!out.has(k)) out.set(k, v);
  return out;
}

/** EtherType names (ethernet.type, llc.type, hdlc.protocol). */
export const ETHERTYPE_NAMES: ReadonlyMap<number, string> = dispatchNames('ethertype', [
  [0x8100, '802.1Q VLAN tag'],
  [0x8035, 'serial keepalive'],
]);

/** IP protocol / next-header names. */
export const IP_PROTOCOL_NAMES: ReadonlyMap<number, string> = dispatchNames('ipproto', [[59, 'no next header']]);

/** Well-known UDP port names. */
export const UDP_PORT_NAMES: ReadonlyMap<number, string> = dispatchNames('udp.port');

/** Well-known TCP port names. */
export const TCP_PORT_NAMES: ReadonlyMap<number, string> = dispatchNames('tcp.port');

const ARP_OP_NAMES: ReadonlyMap<number, string> = new Map([[1, 'request'], [2, 'reply']]);
const ARP_HTYPE_NAMES: ReadonlyMap<number, string> = new Map([[1, 'Ethernet']]);

/** ICMPv4 message type names. */
export const ICMP_TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'echo reply'],
  [3, 'destination unreachable'],
  [5, 'redirect'],
  [8, 'echo request'],
  [11, 'time exceeded'],
  [12, 'parameter problem'],
]);

const ICMP_CODE_NAMES: ReadonlyMap<number, ReadonlyMap<number, string>> = new Map([
  [3, new Map([
    [0, 'network unreachable'],
    [1, 'host unreachable'],
    [2, 'protocol unreachable'],
    [3, 'port unreachable'],
    [4, 'fragmentation needed'],
    [13, 'administratively prohibited'],
  ])],
  [11, new Map([[0, 'TTL ran out in transit'], [1, 'reassembly time ran out']])],
]);

/** ICMPv6 message type names. */
export const ICMPV6_TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'destination unreachable'],
  [2, 'packet too big'],
  [3, 'time exceeded'],
  [4, 'parameter problem'],
  [128, 'echo request'],
  [129, 'echo reply'],
  [133, 'router solicitation'],
  [134, 'router advertisement'],
  [135, 'neighbour solicitation'],
  [136, 'neighbour advertisement'],
  [137, 'redirect'],
]);

const ICMPV6_CODE_NAMES: ReadonlyMap<number, ReadonlyMap<number, string>> = new Map([
  [1, new Map([
    [0, 'no route'],
    [1, 'administratively prohibited'],
    [3, 'address unreachable'],
    [4, 'port unreachable'],
  ])],
  [3, new Map([[0, 'hop limit ran out in transit'], [1, 'reassembly time ran out']])],
]);

const HDLC_ADDRESS_NAMES: ReadonlyMap<number, string> = new Map([[0x0f, 'unicast'], [0x8f, 'broadcast']]);
const DOT11_STATUS_NAMES: ReadonlyMap<number, string> = new Map([[0, 'success'], [1, 'failure'], [17, 'access point full']]);
const DOT11_REASON_NAMES: ReadonlyMap<number, string> = new Map([[8, 'station is leaving'], [15, 'key handshake failed']]);
const DOT11_AUTH_NAMES: ReadonlyMap<number, string> = new Map([[0, 'open'], [3, 'SAE']]);
const EAPOL_PACKET_NAMES: ReadonlyMap<number, string> = new Map([[3, 'key']]);
const DHCP_OP_NAMES: ReadonlyMap<number, string> = new Map([[1, 'request'], [2, 'reply']]);
const DNS_RCODE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'no error'],
  [1, 'format error'],
  [2, 'server failure'],
  [3, 'name does not exist'],
  [4, 'not implemented'],
  [5, 'refused'],
]);
const DNS_OPCODE_NAMES: ReadonlyMap<number, string> = new Map([[0, 'standard query']]);

/** TCP flag letters in wire order with their names. */
export const TCP_FLAG_NAMES: Readonly<Record<string, string>> = Object.freeze({
  F: 'FIN',
  S: 'SYN',
  R: 'RST',
  P: 'PSH',
  A: 'ACK',
  U: 'URG',
  E: 'ECE',
  C: 'CWR',
});

// ── primitive renderers ──────────────────────────────────────────────────────

/** `0x` followed by `digits` lower-case hex digits. */
export function hex(v: number, digits: number): string {
  const n = v < 0 || v > 0xffffffff ? v : v >>> 0;
  return `0x${n.toString(16).padStart(digits, '0')}`;
}

function named(shown: string, name: string | undefined): string {
  return name === undefined ? shown : `${shown} (${name})`;
}

function trimNumber(x: number): string {
  return x >= 100 ? String(Math.round(x)) : String(Number(x.toFixed(1)));
}

/** Duration in integer nanoseconds rendered with a readable unit ("250 ms", "4 min 5 s"). */
export function formatDurationNs(ns: number): string {
  if (!Number.isFinite(ns)) return EMPTY_VALUE;
  if (ns < 0) return `-${formatDurationNs(-ns)}`;
  if (ns < 1_000) return `${Math.round(ns)} ns`;
  if (ns < 1_000_000) return `${trimNumber(ns / 1_000)} µs`;
  if (ns < 1_000_000_000) return `${trimNumber(ns / 1_000_000)} ms`;
  if (ns < 60_000_000_000) return `${trimNumber(ns / 1_000_000_000)} s`;
  const totalS = Math.floor(ns / 1_000_000_000);
  if (totalS < 3_600) return `${Math.floor(totalS / 60)} min ${totalS % 60} s`;
  if (totalS < 86_400) return `${Math.floor(totalS / 3_600)} h ${Math.floor(totalS / 60) % 60} min`;
  return `${Math.floor(totalS / 86_400)} d ${Math.floor(totalS / 3_600) % 24} h`;
}

/** Whole seconds with a readable equivalent ("86400 s (1 d 0 h)"). */
export function formatSeconds(s: number): string {
  return s < 60 ? `${s} s` : `${s} s (${formatDurationNs(s * 1_000_000_000)})`;
}

/** Bit rate ("100 Mb/s"); EMPTY_VALUE when unknown. */
export function formatBps(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return EMPTY_VALUE;
  if (bps >= 1_000_000_000) return `${trimNumber(bps / 1_000_000_000)} Gb/s`;
  if (bps >= 1_000_000) return `${trimNumber(bps / 1_000_000)} Mb/s`;
  if (bps >= 1_000) return `${trimNumber(bps / 1_000)} kb/s`;
  return `${bps} b/s`;
}

/** Signal strength with a bar glyph as its non-colour channel ("▮▮▮▯ -67 dBm"). */
export function formatSignal(rssiDbm: number, bars: number): string {
  const b = Math.max(0, Math.min(4, Math.round(bars)));
  return `${'▮'.repeat(b)}${'▯'.repeat(4 - b)} ${rssiDbm} dBm`;
}

/** Byte array summary ("12 bytes: 00 01 …"). */
export function formatBytes(b: Uint8Array): string {
  const head = Array.from(b.subarray(0, 12), (x) => x.toString(16).padStart(2, '0')).join(' ');
  return `${b.length} bytes${b.length > 0 ? `: ${head}${b.length > 12 ? ' …' : ''}` : ''}`;
}

/** TCP flag letters with their names ("SA (SYN, ACK)"); "none" for an empty set. */
export function formatTcpFlags(flags: string): string {
  if (flags === '') return 'none';
  const names = flags.split('').map((c) => TCP_FLAG_NAMES[c] ?? c);
  return `${flags} (${names.join(', ')})`;
}

// ── field registry ───────────────────────────────────────────────────────────

type NumberFormatter = (v: number, layer: LayerFields | undefined) => string;

const hexOf = (digits: number): NumberFormatter => (v) => hex(v, digits);
const namedHex = (digits: number, names: ReadonlyMap<number, string>): NumberFormatter => (v) => named(hex(v, digits), names.get(v));
const namedDec = (names: ReadonlyMap<number, string>): NumberFormatter => (v) => named(String(v), names.get(v));
const unit = (suffix: string): NumberFormatter => (v) => `${v} ${suffix}`;
const seconds: NumberFormatter = (v) => formatSeconds(v);
const port = (names: ReadonlyMap<number, string>): NumberFormatter => (v) => named(String(v), names.get(v));

function codeBy(types: ReadonlyMap<number, ReadonlyMap<number, string>>): NumberFormatter {
  return (v, layer) => {
    const type = layer?.type;
    return named(String(v), typeof type === 'number' ? types.get(type)?.get(v) : undefined);
  };
}

const ipv4Flags: NumberFormatter = (v) => {
  const parts: string[] = [];
  if ((v & 0b010) !== 0) parts.push("don't fragment");
  if ((v & 0b001) !== 0) parts.push('more fragments');
  return named(String(v), parts.length > 0 ? parts.join(', ') : undefined);
};

const ethertype = namedHex(4, ETHERTYPE_NAMES);
const ipProto = namedDec(IP_PROTOCOL_NAMES);

// ── P2 fields (ARCHITECTURE-P2 §2.3; W1 web-inspector) ───────────────────────
// Engine constants (ETH_LENGTH_MAX, NF_OUI) and the dispatch spaces added in P2 are read at call time, never at
// module scope (§0 rule 12); the two dispatch-derived maps are built lazily on first use.

let llcSapNames: ReadonlyMap<number, string> | undefined;
let nfPidNames: ReadonlyMap<number, string> | undefined;

/** Names of LLC service access points (non-SNAP `llc.dsap` / `llc.ssap`). */
function llcSapName(v: number): string | undefined {
  llcSapNames ??= dispatchNames('llc.sap', [[0xaa, 'SNAP']]);
  return llcSapNames.get(v);
}

/** Names of NF control protocol ids (`llc.type` when `llc.oui` is the NF OUI). */
function nfPidName(v: number): string | undefined {
  nfPidNames ??= dispatchNames('nf.pid');
  return nfPidNames.get(v);
}

/** `ethernet.type` / `dot1q.type`: up to ETH_LENGTH_MAX the value is an 802.3 length (the payload is LLC). */
const typeOrLength: NumberFormatter = (v, layer) => (v <= ETH_LENGTH_MAX ? `${v} (802.3 length)` : ethertype(v, layer));

const llcSap: NumberFormatter = (v) => named(hex(v, 2), llcSapName(v));

const llcOui: NumberFormatter = (v) => named(hex(v, 6), v === 0 ? 'an ethertype follows' : v === NF_OUI ? 'NetForge control protocols' : undefined);

/** SNAP `llc.type`: an ethertype when the OUI is 0, an NF protocol id when the OUI is the NF OUI. */
const llcType: NumberFormatter = (v, layer) => (layer?.oui === NF_OUI ? named(hex(v, 4), nfPidName(v)) : ethertype(v, layer));

/** 802.1p priority classes of `dot1q.pcp`. */
const PCP_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'best effort'],
  [1, 'background'],
  [2, 'excellent effort'],
  [3, 'critical applications'],
  [4, 'video'],
  [5, 'voice'],
  [6, 'internetwork control'],
  [7, 'network control'],
]);
const VID_NAMES: ReadonlyMap<number, string> = new Map([[0, 'priority tag, no VLAN'], [4095, 'reserved']]);

const STP_VERSION_NAMES: ReadonlyMap<number, string> = new Map([[0, 'classic spanning tree'], [2, 'rapid spanning tree'], [3, 'multiple spanning tree']]);
const BPDU_TYPE_NAMES: ReadonlyMap<number, string> = new Map([[0x00, 'configuration'], [0x80, 'topology change notice'], [0x02, 'rapid or multiple']]);
const STP_ROLE_BITS: readonly (string | undefined)[] = [undefined, 'role alternate or backup', 'role root', 'role designated'];

/** `stp.flags`: TC, proposal, role, learning, forwarding, agreement, TC acknowledgement. */
const stpFlags: NumberFormatter = (v) => {
  const parts: string[] = [];
  if ((v & 0x01) !== 0) parts.push('topology change');
  if ((v & 0x02) !== 0) parts.push('proposal');
  const role = STP_ROLE_BITS[(v >> 2) & 0x03];
  if (role !== undefined) parts.push(role);
  if ((v & 0x10) !== 0) parts.push('learning');
  if ((v & 0x20) !== 0) parts.push('forwarding');
  if ((v & 0x40) !== 0) parts.push('agreement');
  if ((v & 0x80) !== 0) parts.push('topology change acknowledged');
  return named(hex(v, 2), parts.length > 0 ? parts.join(', ') : undefined);
};

/** Bridge priority with the extended system id: 32778 → "32778 (32768 + VLAN 10)". */
const bridgePriority: NumberFormatter = (v) => {
  const ext = v % 4096;
  return ext === 0 ? String(v) : `${v} (${v - ext} + VLAN ${ext})`;
};

/** 802.1t port id: priority in the top four bits (× 16), port number in the low twelve: 0x8001 → "0x8001 (128.1)". */
const stpPortId: NumberFormatter = (v) => `${hex(v, 4)} (${((v >>> 12) & 0x0f) * 16}.${v & 0x0fff})`;

/** BPDU times travel in 1/256 s: 3840 → "3840 (15 s)". */
const stpTime: NumberFormatter = (v) => `${v} (${trimNumber(v / 256)} s)`;

/** `lacp.actorState` / `lacp.partnerState` bits, in wire order. */
const lacpState: NumberFormatter = (v) => {
  const parts = [
    (v & 0x01) !== 0 ? 'active' : 'passive',
    (v & 0x02) !== 0 ? 'short timeout' : 'long timeout',
    (v & 0x04) !== 0 ? 'aggregatable' : 'individual',
  ];
  if ((v & 0x08) !== 0) parts.push('in sync');
  if ((v & 0x10) !== 0) parts.push('collecting');
  if ((v & 0x20) !== 0) parts.push('distributing');
  if ((v & 0x40) !== 0) parts.push('defaulted');
  if ((v & 0x80) !== 0) parts.push('expired');
  return `${hex(v, 2)} (${parts.join(', ')})`;
};

const DTP_MODE_NAMES: ReadonlyMap<number, string> = new Map([[1, 'access'], [2, 'trunk'], [3, 'dynamic desirable'], [4, 'dynamic auto']]);

const DHCPV6_MESSAGE_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'solicit'],
  [2, 'advertise'],
  [3, 'request'],
  [4, 'confirm'],
  [5, 'renew'],
  [6, 'rebind'],
  [7, 'reply'],
  [8, 'release'],
  [9, 'decline'],
  [10, 'reconfigure'],
  [11, 'information request'],
  [12, 'relay forward'],
  [13, 'relay reply'],
]);
const DHCPV6_STATUS_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'success'],
  [1, 'unspecified failure'],
  [2, 'no addresses available'],
  [3, 'no binding'],
  [4, 'not on link'],
  [5, 'use multicast'],
]);

/** RFC 5415 / RFC 5416 message names, as the inspector shows them (§2.3). */
const CAPWAP_MESSAGE_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'Discovery Request'],
  [2, 'Discovery Response'],
  [3, 'Join Request'],
  [4, 'Join Response'],
  [5, 'Configuration Status Request'],
  [6, 'Configuration Status Response'],
  [9, 'WTP Event Request'],
  [10, 'WTP Event Response'],
  [11, 'Change State Event Request'],
  [12, 'Change State Event Response'],
  [13, 'Echo Request'],
  [14, 'Echo Response'],
  [3398913, 'IEEE 802.11 WLAN Configuration Request'],
  [3398914, 'IEEE 802.11 WLAN Configuration Response'],
]);

const HSRP_STATE_NAMES: ReadonlyMap<number, string> = new Map([[0, 'initial'], [1, 'learn'], [2, 'listen'], [4, 'speak'], [8, 'standby'], [16, 'active']]);
const HSRP_OP_NAMES: ReadonlyMap<number, string> = new Map([[0, 'hello'], [1, 'coup'], [2, 'resign']]);
const PAGP_MODE_NAMES: ReadonlyMap<number, string> = new Map([[1, 'desirable'], [2, 'auto']]);

/** Number formatters keyed by `proto.field`; fields not listed use the generic rules of `formatField`. */
const NUMBER_FORMATTERS: Readonly<Record<string, NumberFormatter>> = Object.freeze({
  'ethernet.type': typeOrLength,
  'ethernet.fcs': hexOf(8),
  'ethernet.padding': unit('B'),
  'arp.htype': namedHex(4, ARP_HTYPE_NAMES),
  'arp.ptype': ethertype,
  'arp.op': namedDec(ARP_OP_NAMES),
  'ipv4.protocol': ipProto,
  'ipv4.id': (v) => `${v} (${hex(v, 4)})`,
  'ipv4.flags': ipv4Flags,
  'ipv4.totalLength': unit('B'),
  'ipv4.ihl': (v) => `${v} (${v * 4} B)`,
  'icmpv4.type': namedDec(ICMP_TYPE_NAMES),
  'icmpv4.code': codeBy(ICMP_CODE_NAMES),
  'hdlc.address': namedHex(2, HDLC_ADDRESS_NAMES),
  'hdlc.control': hexOf(2),
  'hdlc.protocol': ethertype,
  'dot11.fcs': hexOf(8),
  'dot11-mgmt.beaconIntervalMs': unit('ms'),
  'dot11-mgmt.capability': hexOf(4),
  'dot11-mgmt.authAlgorithm': namedDec(DOT11_AUTH_NAMES),
  'dot11-mgmt.statusCode': namedDec(DOT11_STATUS_NAMES),
  'dot11-mgmt.reasonCode': namedDec(DOT11_REASON_NAMES),
  'dot11-mgmt.rssiDbm': unit('dBm'),
  'llc.dsap': llcSap,
  'llc.ssap': llcSap,
  'llc.control': hexOf(2),
  'llc.oui': llcOui,
  'llc.type': llcType,
  'eapol.packetType': namedDec(EAPOL_PACKET_NAMES),
  'eapol.handshakeStep': (v) => `${v} of 4`,
  'ipv6.nextHeader': ipProto,
  'ipv6.payloadLength': unit('B'),
  'ipv6.flowLabel': hexOf(5),
  'ipv6-hopopts.nextHeader': ipProto,
  'ipv6-route.nextHeader': ipProto,
  'ipv6-frag.nextHeader': ipProto,
  'ipv6-frag.id': hexOf(8),
  'ipv6-dstopts.nextHeader': ipProto,
  'icmpv6.type': namedDec(ICMPV6_TYPE_NAMES),
  'icmpv6.code': codeBy(ICMPV6_CODE_NAMES),
  'icmpv6.mtu': unit('B'),
  'icmpv6.validLifetimeS': seconds,
  'icmpv6.preferredLifetimeS': seconds,
  'udp.srcPort': port(UDP_PORT_NAMES),
  'udp.dstPort': port(UDP_PORT_NAMES),
  'udp.length': unit('B'),
  'tcp.srcPort': port(TCP_PORT_NAMES),
  'tcp.dstPort': port(TCP_PORT_NAMES),
  'tcp.dataOffset': (v) => `${v} (${v * 4} B)`,
  'dhcp.op': namedDec(DHCP_OP_NAMES),
  'dhcp.xid': hexOf(8),
  'dhcp.secs': unit('s'),
  'dhcp.leaseTimeS': seconds,
  'dhcp.renewalTimeS': seconds,
  'dhcp.rebindingTimeS': seconds,
  'dns.id': hexOf(4),
  'dns.opcode': namedDec(DNS_OPCODE_NAMES),
  'dns.rcode': namedDec(DNS_RCODE_NAMES),
  'dns.tcpLength': unit('B'),
  // ── P2 ──
  'dot1q.pcp': namedDec(PCP_NAMES),
  'dot1q.vid': namedDec(VID_NAMES),
  'dot1q.type': typeOrLength,
  'stp.protocolId': hexOf(4),
  'stp.version': namedDec(STP_VERSION_NAMES),
  'stp.bpduType': namedHex(2, BPDU_TYPE_NAMES),
  'stp.flags': stpFlags,
  'stp.rootPriority': bridgePriority,
  'stp.bridgePriority': bridgePriority,
  'stp.portId': stpPortId,
  'stp.messageAge': stpTime,
  'stp.maxAge': stpTime,
  'stp.helloTime': stpTime,
  'stp.forwardDelay': stpTime,
  'stp.pvid': (v) => `${v} (native VLAN of the sender)`,
  'lacp.subtype': namedDec(new Map([[1, 'LACP']])),
  'lacp.actorState': lacpState,
  'lacp.partnerState': lacpState,
  'dtp.adminMode': namedDec(DTP_MODE_NAMES),
  'dtp.trunkType': namedDec(new Map([[1, '802.1Q']])),
  'dhcpv6.msgType': namedDec(DHCPV6_MESSAGE_NAMES),
  'dhcpv6.transactionId': hexOf(6),
  'dhcpv6.preferredLifetimeS': seconds,
  'dhcpv6.validLifetimeS': seconds,
  'dhcpv6.t1S': seconds,
  'dhcpv6.t2S': seconds,
  'dhcpv6.statusCode': namedDec(DHCPV6_STATUS_NAMES),
  'dhcpv6.elapsedTimeCs': (v) => `${v} (${trimNumber(v / 100)} s)`,
  'capwap.messageType': namedDec(CAPWAP_MESSAGE_NAMES),
  'capwap.wbid': namedDec(new Map([[1, 'IEEE 802.11']])),
  'capwap.resultCode': namedDec(new Map([[0, 'success']])),
  'hsrp.state': namedDec(HSRP_STATE_NAMES),
  'hsrp.opCode': namedDec(HSRP_OP_NAMES),
  'hsrp.helloMs': unit('ms'),
  'hsrp.holdMs': unit('ms'),
  'pagp.mode': namedDec(PAGP_MODE_NAMES),
  /** Corruption mutations record the flipped byte. */
  'raw.bytes': hexOf(2),
});

type StringFormatter = (v: string) => string;

const STRING_FORMATTERS: Readonly<Record<string, StringFormatter>> = Object.freeze({
  'tcp.flags': formatTcpFlags,
});

/** Canonical field description from the engine table, if the protocol and field are known. */
export function fieldSpec(proto: string, field: string): FieldSpec | undefined {
  return PROTO_FIELDS[proto]?.fields.find((f) => f.name === field);
}

/** Tooltip text of a field (empty when unknown). */
export function fieldHelp(proto: string, field: string): string {
  return fieldSpec(proto, field)?.doc ?? '';
}

/**
 * Human rendering of a decoded field value. `layer` (the decoded fields of the same layer) lets codes be named
 * by their type. Validity flags render as "✓ valid" / "✗ invalid" so the result is never colour-only.
 */
export function formatField(proto: string, field: string, v: FieldValue | undefined, layer?: LayerFields): string {
  if (v === null || v === undefined) return EMPTY_VALUE;
  if (v instanceof Uint8Array) return formatBytes(v);
  if (typeof v === 'boolean') {
    if (field.endsWith('Valid')) return v ? '✓ valid' : '✗ invalid';
    return v ? 'yes' : 'no';
  }
  const key = `${proto}.${field}`;
  if (typeof v === 'string') {
    const sf = STRING_FORMATTERS[key];
    if (sf) return sf(v);
    return v === '' ? EMPTY_VALUE : v;
  }
  if (!Number.isFinite(v)) return String(v);
  const nf = NUMBER_FORMATTERS[key];
  if (nf) return nf(v, layer);
  if (field === 'checksum' || field === 'fcs') {
    const bits = fieldSpec(proto, field)?.bits ?? 16;
    return hex(v, Math.ceil(bits / 4));
  }
  return String(v);
}

/**
 * Short rendering of a mutation value for provenance chips: `path` is the dotted field path (`ipv4.ttl`,
 * `ethernet`); the "(name)" annotation is dropped so chips stay compact.
 */
export function formatMutationValue(path: string, v: FieldValue | undefined): string {
  const dot = path.indexOf('.');
  const s = dot < 0 ? formatField(path, '', v) : formatField(path.slice(0, dot), path.slice(dot + 1), v);
  const paren = s.indexOf(' (');
  return paren > 0 && !s.startsWith('✓') && !s.startsWith('✗') ? s.slice(0, paren) : s;
}

// ── mutation reasons ─────────────────────────────────────────────────────────

/** Presentation of one provenance mutation reason. */
export interface MutationVocab {
  readonly reason: MutationReason;
  /** Glyph drawn in the chip (paired with the chip text, never alone). */
  readonly icon: string;
  readonly label: string;
  /** Checksum/FCS updates that follow another change; collapsed by default. */
  readonly derived: boolean;
}

function mutation(reason: MutationReason, icon: string, label: string, derived = false): MutationVocab {
  return Object.freeze({ reason, icon, label, derived });
}

/** Every mutation reason, exhaustive over `MutationReason`. */
export const MUTATION_VOCAB: Readonly<Record<MutationReason, MutationVocab>> = Object.freeze({
  TtlDecrement: mutation('TtlDecrement', 'T', 'TTL decremented while forwarding'),
  MacRewrite: mutation('MacRewrite', 'M', 'MAC addresses rewritten for the next hop'),
  ChecksumRecompute: mutation('ChecksumRecompute', 'Σ', 'Checksum recomputed after a change', true),
  FcsRecompute: mutation('FcsRecompute', 'Σ', 'Frame checksum recomputed after a change', true),
  VlanTagPush: mutation('VlanTagPush', 'V+', 'VLAN tag added'),
  VlanTagPop: mutation('VlanTagPop', 'V−', 'VLAN tag removed'),
  NatTranslate: mutation('NatTranslate', 'N', 'Address translated'),
  FragmentSplit: mutation('FragmentSplit', 'F', 'Packet fragmented'),
  Encrypt: mutation('Encrypt', 'E', 'Payload encrypted'),
  Decrypt: mutation('Decrypt', 'D', 'Payload decrypted'),
  Corruption: mutation('Corruption', '!', 'Bits flipped on the wire'),
  Padding: mutation('Padding', 'P', 'Padding adjusted'),
  Encapsulate: mutation('Encapsulate', '+', 'Header pushed around the packet'),
  Other: mutation('Other', '•', 'Field changed'),
  Decapsulate: mutation('Decapsulate', '−', 'Header removed from around the packet'),
});

/** Vocabulary entry of a mutation reason ('Other' for unknown strings). */
export function mutationVocab(reason: string): MutationVocab {
  return Object.prototype.hasOwnProperty.call(MUTATION_VOCAB, reason) ? MUTATION_VOCAB[reason as MutationReason] : MUTATION_VOCAB.Other;
}

// ── table cells ──────────────────────────────────────────────────────────────

/** Readable form of a state value from a table row (association phases by name, `SYN_SENT` → `SYN SENT`). */
export function formatStateValue(state: string): string {
  if (Object.prototype.hasOwnProperty.call(WIFI_ASSOC_STATE_VOCAB, state)) {
    return (WIFI_ASSOC_STATE_VOCAB as Readonly<Record<string, { label: string }>>)[state]?.label ?? state;
  }
  if (Object.prototype.hasOwnProperty.call(CELL_ATTACH_STATE_VOCAB, state)) {
    return (CELL_ATTACH_STATE_VOCAB as Readonly<Record<string, { label: string }>>)[state]?.label ?? state;
  }
  return state.replace(/_/g, ' ');
}

/**
 * Rendering of one generic table cell by its column format. `time` columns hold absolute SimTimes: with `now`
 * they render as a countdown ("in 4 min 59 s", "expired"), without it as a clock time.
 */
export function formatTableCell(format: TableColumn['format'], value: unknown, now?: SimTime): string {
  if (value === undefined || value === null || value === '') return EMPTY_VALUE;
  switch (format) {
    case 'time': {
      if (typeof value !== 'number') return String(value);
      if (now === undefined) return formatSimTime(value);
      const left = value - now;
      return left <= 0 ? 'expired' : `in ${formatDurationNs(left)}`;
    }
    case 'duration':
      return typeof value === 'number' ? formatDurationNs(value) : String(value);
    case 'bool':
      return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
    case 'state':
      return formatStateValue(String(value));
    case 'number':
    case 'text':
    case 'mac':
    case 'ipv4':
    case 'ipv6':
    case 'ip':
    case 'port':
      return String(value);
  }
}
