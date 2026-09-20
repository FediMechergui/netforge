/**
 * Canonical layer field names — ALL codecs (P0, P0.5, P1) as machine-readable data.
 *
 * This file supersedes docs/FIELDS.md (folded in, with corrections) and extends the P0 comment table in
 * contracts/pdu.ts. Codecs decode/encode EXACTLY these keys; processes read/build EXACTLY these keys; the
 * NetScope field registry and codec tests are generated from it. Rules (unchanged from P0):
 *  • `derived` fields (lengths, checksums, FCS, padding) are ALWAYS recomputed by encode(); builder values are ignored.
 *  • `decodeOnly` fields exist only on decoded layers (validation flags, annotations).
 *  • `required` fields MUST be set by builders (encode cannot infer them).
 *  • Outer codecs pass `next.length` as an upper bound; inner codecs set their own length.
 *  • Every value is a FieldValue. List-valued data stays a SCALAR string (see per-field docs).
 *  • Addresses use canonical strings: MAC `aa:bb:cc:dd:ee:ff`, IPv4 dotted, IPv6 RFC 5952.
 *
 * Corrections to docs/FIELDS.md folded in here:
 *  1. icmpv6 gains explicit `mtu` (packet-too-big), `pointer` (param-problem) and `rdnss` (RA option 25,
 *     comma-separated, decoded only); RA `prefix`/`prefixLen` hold the FIRST prefix option only.
 *  2. IPv6 extension layers: `ipv6-hopopts`, `ipv6-route`, `ipv6-frag`, `ipv6-dstopts` (hdrExtLen derived).
 *  3. udp over IPv4: checksum 0 on decode ⇒ checksumValid undefined (not false); a computed 0 is sent as 0xffff.
 *  4. dns over TCP: the 2-byte length prefix decodes as `tcpLength` (derived).
 *  5. dhcp adds decode-only `sname` and `file`; relay hop count is `hops`.
 *  6. The cellular air carries ETHERNET frames between UE and tower (not raw IP); the tower bridges them.
 *  7. hdlc address default is 0x0f (unicast); keepalives use 0x8f (broadcast).
 *  8. dot11-mgmt band adds '60'; dot11 data frames that are not EAPOL never reach daemons (the medium rewraps them).
 *  9. tcp `flags` letters keep the fixed order F S R P A U E C (e.g. 'S', 'SA', 'A', 'PA', 'FA', 'R').
 */
import type { DispatchSpace, ProtoName } from './pdu.js';
import type { BuildStage } from './catalog.js';

export type FieldType = 'uint' | 'int' | 'bool' | 'mac' | 'ipv4' | 'ipv6' | 'string' | 'bytes';

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  /** Bit width for uint/int fields. */
  readonly bits?: number;
  readonly derived?: true;
  readonly decodeOnly?: true;
  readonly required?: true;
  /** Encode default when absent. */
  readonly default?: number | string | boolean;
  readonly doc: string;
}

export interface ProtoFieldTable {
  readonly proto: ProtoName;
  readonly since: BuildStage;
  readonly fields: readonly FieldSpec[];
  readonly notes?: string;
}

type FieldExtra = { bits?: number; derived?: true; decodeOnly?: true; required?: true; default?: number | string | boolean };

function f(name: string, type: FieldType, doc: string, extra: FieldExtra = {}): FieldSpec {
  return Object.freeze({ name, type, doc, ...extra });
}

function table(proto: ProtoName, since: BuildStage, fields: readonly FieldSpec[], notes?: string): ProtoFieldTable {
  return Object.freeze(notes === undefined ? { proto, since, fields: Object.freeze([...fields]) } : { proto, since, fields: Object.freeze([...fields]), notes });
}

const u = (bits: number, extra: FieldExtra = {}): FieldExtra => ({ bits, ...extra });
const REQ: FieldExtra = { required: true };
const DER: FieldExtra = { derived: true };
const DEC: FieldExtra = { decodeOnly: true };
const DERDEC: FieldExtra = { derived: true, decodeOnly: true };

export const PROTO_FIELDS: Readonly<Record<string, ProtoFieldTable>> = Object.freeze({
  // ── P0 ──
  ethernet: table('ethernet', 'P0', [
    f('dst', 'mac', 'Destination MAC.', REQ),
    f('src', 'mac', 'Source MAC.', REQ),
    f('type', 'uint', 'Ethertype of the payload.', u(16, REQ)),
    f('fcs', 'uint', 'CRC-32 frame check sequence.', u(32, DERDEC)),
    f('fcsValid', 'bool', 'FCS matched the frame.', DEC),
    f('padding', 'uint', 'Number of pad bytes added to reach 64 bytes.', DEC),
  ], 'Frames include the 4-byte FCS and are padded to 64 bytes.'),
  arp: table('arp', 'P0', [
    f('htype', 'uint', 'Hardware type.', u(16, { default: 1 })),
    f('ptype', 'uint', 'Protocol type.', u(16, { default: 0x0800 })),
    f('hlen', 'uint', 'Hardware address length.', u(8, { default: 6 })),
    f('plen', 'uint', 'Protocol address length.', u(8, { default: 4 })),
    f('op', 'uint', 'ARP_OP_REQUEST or ARP_OP_REPLY.', u(16, REQ)),
    f('sha', 'mac', 'Sender hardware address.', REQ),
    f('spa', 'ipv4', 'Sender protocol address.', REQ),
    f('tha', 'mac', 'Target hardware address.', REQ),
    f('tpa', 'ipv4', 'Target protocol address.', REQ),
  ]),
  ipv4: table('ipv4', 'P0', [
    f('version', 'uint', 'Always 4.', u(4, { default: 4 })),
    f('ihl', 'uint', 'Header length in 32-bit words.', u(4, DER)),
    f('dscp', 'uint', 'Differentiated services code point.', u(6, { default: 0 })),
    f('ecn', 'uint', 'Explicit congestion notification.', u(2, { default: 0 })),
    f('totalLength', 'uint', 'Datagram length.', u(16, DER)),
    f('id', 'uint', 'Identification.', u(16, { default: 0 })),
    f('flags', 'uint', 'Fragment flags.', u(3, { default: 0 })),
    f('fragOffset', 'uint', 'Fragment offset.', u(13, { default: 0 })),
    f('ttl', 'uint', 'Time to live (ipDefaults.ttl when originated).', u(8, { default: 128 })),
    f('protocol', 'uint', 'Upper-layer protocol number.', u(8, REQ)),
    f('checksum', 'uint', 'Header checksum.', u(16, DER)),
    f('checksumValid', 'bool', 'Header checksum matched.', DEC),
    f('src', 'ipv4', 'Source address.', REQ),
    f('dst', 'ipv4', 'Destination address.', REQ),
  ]),
  icmpv4: table('icmpv4', 'P0', [
    f('type', 'uint', 'ICMP type.', u(8, REQ)),
    f('code', 'uint', 'ICMP code.', u(8, { default: 0 })),
    f('checksum', 'uint', 'ICMP checksum.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched.', DEC),
    f('id', 'uint', 'Echo identifier (types 0/8).', u(16)),
    f('seq', 'uint', 'Echo sequence (types 0/8).', u(16)),
    f('unused', 'uint', 'Unused field of error messages (types 3/11); the quoted datagram follows as nested layers.', u(32, { default: 0 })),
  ]),
  payload: table('payload', 'P0', [f('data', 'bytes', 'Raw bytes.')]),

  // ── P0.5 ──
  hdlc: table('hdlc', 'P0.5', [
    f('address', 'uint', '0x0f unicast, 0x8f broadcast (keepalives).', u(8, { default: 0x0f })),
    f('control', 'uint', 'Control byte.', u(8, { default: 0 })),
    f('protocol', 'uint', 'HDLC_PROTO_IPV4 | HDLC_PROTO_IPV6 | HDLC_PROTO_KEEPALIVE (ethertype space).', u(16, REQ)),
    f('fcs', 'uint', 'CRC-16/X.25.', u(16, DERDEC)),
    f('fcsValid', 'bool', 'FCS matched.', DEC),
  ], 'Serial frames carry no MAC addresses; no flags in bytes.'),
  dot11: table('dot11', 'P0.5', [
    f('frameType', 'string', "'mgmt' | 'ctrl' | 'data'.", REQ),
    f('subtype', 'string', "beacon, probe-req, probe-resp, auth, deauth, assoc-req, assoc-resp, reassoc-req, disassoc, ack, rts, cts, data, qos-data.", REQ),
    f('toDs', 'bool', 'To distribution system (station → AP data).', { default: false }),
    f('fromDs', 'bool', 'From distribution system (AP → station data).', { default: false }),
    f('retry', 'bool', 'Retransmission.', { default: false }),
    f('protected', 'bool', 'Payload protected (simulated).', { default: false }),
    f('duration', 'uint', 'Duration/ID.', u(16, { default: 0 })),
    f('addr1', 'mac', 'Receiver.', REQ),
    f('addr2', 'mac', 'Transmitter.', REQ),
    f('addr3', 'mac', 'BSSID (mgmt) / DA (fromDs) / SA-or-DA per DS bits.', REQ),
    f('seq', 'uint', 'Sequence number.', u(12, { default: 0 })),
    f('fcs', 'uint', 'CRC-32.', u(32, DERDEC)),
    f('fcsValid', 'bool', 'FCS matched.', DEC),
  ]),
  'dot11-mgmt': table('dot11-mgmt', 'P0.5', [
    f('ssid', 'string', 'SSID element.'),
    f('bssid', 'mac', 'BSSID.'),
    f('channel', 'uint', 'DS parameter channel.', u(8)),
    f('band', 'string', "'2.4' | '5' | '6' | '60'."),
    f('beaconIntervalMs', 'uint', 'Beacon interval.', u(16)),
    f('capability', 'uint', 'Capability information.', u(16)),
    f('rates', 'string', 'Supported rates, comma-separated Mb/s.'),
    f('security', 'string', "'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa2-ent' (reserved)."),
    f('authAlgorithm', 'uint', '0 open, 3 SAE.', u(16)),
    f('authSeq', 'uint', 'Authentication transaction sequence.', u(16)),
    f('statusCode', 'uint', '0 success, 1 failure, 17 too many stations.', u(16)),
    f('reasonCode', 'uint', 'Deauth/disassoc reason (8 leaving, 15 4-way handshake timeout/mismatch).', u(16)),
    f('aid', 'uint', 'Association id.', u(16)),
    f('rssiDbm', 'int', 'Simulated received signal annotation.', { bits: 16, decodeOnly: true }),
  ]),
  llc: table('llc', 'P0.5', [
    f('dsap', 'uint', 'Always 0xaa (SNAP).', u(8, { default: 0xaa })),
    f('ssap', 'uint', 'Always 0xaa (SNAP).', u(8, { default: 0xaa })),
    f('control', 'uint', 'Always 0x03.', u(8, { default: 0x03 })),
    f('oui', 'uint', 'Always 0.', u(24, { default: 0 })),
    f('type', 'uint', 'Ethertype of the payload.', u(16, REQ)),
  ], 'LLC/SNAP after an 802.11 data header; transparent for topProto.'),
  eapol: table('eapol', 'P0.5', [
    f('version', 'uint', 'EAPOL version.', u(8, { default: 2 })),
    f('packetType', 'uint', '3 = key.', u(8, { default: 3 })),
    f('keyType', 'string', "'pairwise' | 'group'.", { default: 'pairwise' }),
    f('handshakeStep', 'uint', '1..4 (simulated 4-way handshake).', u(8, REQ)),
    f('replayCounter', 'uint', 'Replay counter (number).', u(53)),
    f('mic', 'bool', 'MIC valid (simulated).'),
    f('keyData', 'bytes', 'Simulated key data: a hash tag only, never the passphrase.'),
  ], 'Headers are real; crypto is simulated (spec §4.5).'),

  // ── P1 ──
  ipv6: table('ipv6', 'P1', [
    f('version', 'uint', 'Always 6.', u(4, { default: 6 })),
    f('trafficClass', 'uint', 'Traffic class.', u(8, { default: 0 })),
    f('flowLabel', 'uint', 'Flow label.', u(20, { default: 0 })),
    f('payloadLength', 'uint', 'Payload length.', u(16, DER)),
    f('nextHeader', 'uint', 'Next header (ipproto space).', u(8, REQ)),
    f('hopLimit', 'uint', '64 hosts, 255 routers/ND (ipDefaults.hopLimit).', u(8, { default: 64 })),
    f('src', 'ipv6', 'Source.', REQ),
    f('dst', 'ipv6', 'Destination.', REQ),
  ]),
  'ipv6-hopopts': table('ipv6-hopopts', 'P1', [
    f('nextHeader', 'uint', 'Next header.', u(8, REQ)),
    f('hdrExtLen', 'uint', 'Header extension length.', u(8, DER)),
    f('options', 'bytes', 'Raw options (router alert ignored).'),
  ]),
  'ipv6-route': table('ipv6-route', 'P1', [
    f('nextHeader', 'uint', 'Next header.', u(8, REQ)),
    f('hdrExtLen', 'uint', 'Header extension length.', u(8, DER)),
    f('routingType', 'uint', 'Routing type (type 0 → param-problem).', u(8)),
    f('segmentsLeft', 'uint', 'Segments left.', u(8)),
    f('data', 'bytes', 'Type-specific data.'),
  ]),
  'ipv6-frag': table('ipv6-frag', 'P1', [
    f('nextHeader', 'uint', 'Next header.', u(8, REQ)),
    f('offset', 'uint', 'Fragment offset (reassembly not supported in P1).', u(13, { default: 0 })),
    f('more', 'bool', 'More fragments.', { default: false }),
    f('id', 'uint', 'Identification.', u(32, { default: 0 })),
  ]),
  'ipv6-dstopts': table('ipv6-dstopts', 'P1', [
    f('nextHeader', 'uint', 'Next header.', u(8, REQ)),
    f('hdrExtLen', 'uint', 'Header extension length.', u(8, DER)),
    f('options', 'bytes', 'Raw options.'),
  ]),
  icmpv6: table('icmpv6', 'P1', [
    f('type', 'uint', 'ICMPv6 type.', u(8, REQ)),
    f('code', 'uint', 'ICMPv6 code.', u(8, { default: 0 })),
    f('checksum', 'uint', 'Checksum over the IPv6 pseudo-header.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched.', DEC),
    f('id', 'uint', 'Echo identifier (128/129).', u(16)),
    f('seq', 'uint', 'Echo sequence (128/129).', u(16)),
    f('target', 'ipv6', 'NS/NA target.'),
    f('routerFlag', 'bool', 'NA router flag.'),
    f('solicitedFlag', 'bool', 'NA solicited flag.'),
    f('overrideFlag', 'bool', 'NA override flag.'),
    f('sourceLla', 'mac', 'Source link-layer address option (NS, RS, RA).'),
    f('targetLla', 'mac', 'Target link-layer address option (NA).'),
    f('managedFlag', 'bool', 'RA managed flag.'),
    f('otherFlag', 'bool', 'RA other-config flag.'),
    f('curHopLimit', 'uint', 'RA current hop limit advertised to hosts (0 = unspecified).', u(8, { default: 64 })),
    f('routerLifetimeS', 'uint', 'RA router lifetime in seconds (0 = not a default router).', u(16, { default: 1800 })),
    f('prefix', 'ipv6', 'RA first prefix option.'),
    f('prefixLen', 'uint', 'RA first prefix length.', u(8)),
    f('validLifetimeS', 'uint', 'RA prefix valid lifetime.', u(32)),
    f('preferredLifetimeS', 'uint', 'RA prefix preferred lifetime.', u(32)),
    f('mtu', 'uint', 'RA MTU option, or packet-too-big MTU (type 2).', u(32)),
    f('rdnss', 'string', 'RA option 25 servers, comma-separated (decoded, unused in P1).', DEC),
    f('pointer', 'uint', 'Parameter-problem pointer (type 4).', u(32)),
    f('unused', 'uint', 'Unused field of error messages (types 1/3); the quoted datagram follows as nested layers.', u(32, { default: 0 })),
  ]),
  udp: table('udp', 'P1', [
    f('srcPort', 'uint', 'Source port.', u(16, REQ)),
    f('dstPort', 'uint', 'Destination port.', u(16, REQ)),
    f('length', 'uint', 'Datagram length.', u(16, DER)),
    f('checksum', 'uint', 'Pseudo-header checksum; IPv4 decode 0 = none; encoded 0 is sent as 0xffff.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched (undefined when absent or quoted inside an ICMP error).', DEC),
  ], 'Next layer by DISPATCH_TABLE udp.port (destination first, then source).'),
  tcp: table('tcp', 'P1', [
    f('srcPort', 'uint', 'Source port.', u(16, REQ)),
    f('dstPort', 'uint', 'Destination port.', u(16, REQ)),
    f('seq', 'uint', 'Sequence number.', u(32, { default: 0 })),
    f('ack', 'uint', 'Acknowledgement number.', u(32, { default: 0 })),
    f('dataOffset', 'uint', 'Header length in words.', u(4, DER)),
    f('flags', 'string', "Letters in the fixed order FSRPAUEC, e.g. 'S', 'SA', 'A', 'PA', 'FA', 'R'.", { default: '' }),
    f('window', 'uint', 'Receive window.', u(16, { default: 65535 })),
    f('checksum', 'uint', 'Pseudo-header checksum.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched (undefined when quoted inside an ICMP error).', DEC),
    f('urgentPointer', 'uint', 'Urgent pointer.', u(16, { default: 0 })),
    f('mss', 'uint', 'MSS option.', u(16)),
    f('windowScale', 'uint', 'Window scale option.', u(8)),
    f('sackPermitted', 'bool', 'SACK-permitted option.'),
    f('sackBlocks', 'string', "SACK option blocks 'l1-r1,l2-r2'."),
    f('timestamp', 'uint', 'Timestamp option value.', u(32)),
    f('timestampEcho', 'uint', 'Timestamp option echo reply.', u(32)),
  ], 'An 8-byte header quoted in an ICMP error decodes without error. Next layer by DISPATCH_TABLE tcp.port (destination first, then source) whenever the segment payload is ≥ 1 byte; the application codec sets error \'partial\' when the message is incomplete.'),
  dhcp: table('dhcp', 'P1', [
    f('op', 'uint', '1 request, 2 reply.', u(8, REQ)),
    f('htype', 'uint', 'Hardware type.', u(8, { default: 1 })),
    f('hlen', 'uint', 'Hardware address length.', u(8, { default: 6 })),
    f('hops', 'uint', 'Relay hop count.', u(8, { default: 0 })),
    f('xid', 'uint', 'Transaction id.', u(32, REQ)),
    f('secs', 'uint', 'Seconds since start.', u(16, { default: 0 })),
    f('broadcastFlag', 'bool', 'BOOTP broadcast flag (NetForge clients set it).', { default: false }),
    f('ciaddr', 'ipv4', 'Client address.', { default: '0.0.0.0' }),
    f('yiaddr', 'ipv4', 'Your (offered) address.', { default: '0.0.0.0' }),
    f('siaddr', 'ipv4', 'Next server address.', { default: '0.0.0.0' }),
    f('giaddr', 'ipv4', 'Relay agent address.', { default: '0.0.0.0' }),
    f('chaddr', 'mac', 'Client hardware address.', REQ),
    f('sname', 'string', 'Server host name field.', DEC),
    f('file', 'string', 'Boot file field.', DEC),
    f('messageType', 'string', 'DISCOVER | OFFER | REQUEST | DECLINE | ACK | NAK | RELEASE | INFORM (option 53).', REQ),
    f('requestedIp', 'ipv4', 'Option 50.'),
    f('serverId', 'ipv4', 'Option 54.'),
    f('leaseTimeS', 'uint', 'Option 51.', u(32)),
    f('renewalTimeS', 'uint', 'Option 58.', u(32)),
    f('rebindingTimeS', 'uint', 'Option 59.', u(32)),
    f('subnetMask', 'ipv4', 'Option 1.'),
    f('router', 'ipv4', 'Option 3 (first router).'),
    f('dnsServers', 'string', 'Option 6, comma-separated.'),
    f('domainName', 'string', 'Option 15.'),
    f('hostname', 'string', 'Option 12.'),
    f('parameterRequestList', 'string', 'Option 55, comma-separated codes.'),
    f('clientId', 'string', 'Option 61, hex.'),
  ]),
  dns: table('dns', 'P1', [
    f('id', 'uint', 'Transaction id.', u(16, REQ)),
    f('qr', 'bool', 'Response.', { default: false }),
    f('opcode', 'uint', 'Opcode.', u(4, { default: 0 })),
    f('aa', 'bool', 'Authoritative answer.', { default: false }),
    f('tc', 'bool', 'Truncated (never set in P1).', { default: false }),
    f('rd', 'bool', 'Recursion desired.', { default: false }),
    f('ra', 'bool', 'Recursion available.', { default: false }),
    f('rcode', 'uint', '0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN.', u(4, { default: 0 })),
    f('questions', 'string', "'name TYPE' entries joined by ';' (e.g. 'www.lab.nf A').", { default: '' }),
    f('answers', 'string', "'name TYPE ttl data' entries joined by ';' (e.g. 'www.lab.nf A 300 10.0.0.80'; MX data 'pref host').", { default: '' }),
    f('authorities', 'string', 'Same form as answers.', { default: '' }),
    f('additionals', 'string', 'Same form as answers.', { default: '' }),
    f('tcpLength', 'uint', 'Two-byte length prefix over TCP.', u(16, DER)),
  ], 'Types A, AAAA, CNAME, MX, PTR, NS, SOA; names lowercase, no trailing dot; name compression decoded, never encoded.'),
  http: table('http', 'P1', [
    f('kind', 'string', "'request' | 'response'.", REQ),
    f('method', 'string', 'Request method.'),
    f('target', 'string', 'Request target.'),
    f('version', 'string', 'Always HTTP/1.1.', { default: 'HTTP/1.1' }),
    f('status', 'uint', 'Response status.', u(16)),
    f('reason', 'string', 'Response reason phrase (original wording).'),
    f('headers', 'string', "'Name: value' lines joined by '\\n'.", { default: '' }),
    f('body', 'string', 'UTF-8 body.', { default: '' }),
  ], "Real HTTP/1.1 text. A message split across TCP segments decodes with error 'partial'; reassembly belongs to the socket owner and NetScope follow-stream."),
});

/** One next-protocol dispatch entry (pdu/codecs/dispatch.ts builds its tables from these). */
export interface DispatchEntry {
  readonly space: DispatchSpace;
  readonly key: number;
  readonly proto: ProtoName;
  readonly since: BuildStage;
  /** Reserved protocol (D1): decodes as payload until implemented. */
  readonly reserved?: true;
}

const d = (space: DispatchSpace, key: number, proto: ProtoName, since: BuildStage, reserved?: true): DispatchEntry =>
  Object.freeze(reserved ? { space, key, proto, since, reserved } : { space, key, proto, since });

/** Ethertype (ethernet.type, llc.type, hdlc.protocol), IP protocol (ipv4.protocol, ipv6.nextHeader) and well-known port dispatch. */
export const DISPATCH_TABLE: readonly DispatchEntry[] = Object.freeze([
  d('ethertype', 0x0800, 'ipv4', 'P0'),
  d('ethertype', 0x0806, 'arp', 'P0'),
  d('ethertype', 0x888e, 'eapol', 'P0.5'),
  d('ethertype', 0x86dd, 'ipv6', 'P1'),
  d('ipproto', 1, 'icmpv4', 'P0'),
  d('ipproto', 6, 'tcp', 'P1'),
  d('ipproto', 17, 'udp', 'P1'),
  d('ipproto', 58, 'icmpv6', 'P1'),
  d('ipproto', 0, 'ipv6-hopopts', 'P1'),
  d('ipproto', 43, 'ipv6-route', 'P1'),
  d('ipproto', 44, 'ipv6-frag', 'P1'),
  d('ipproto', 60, 'ipv6-dstopts', 'P1'),
  d('udp.port', 53, 'dns', 'P1'),
  d('udp.port', 67, 'dhcp', 'P1'),
  d('udp.port', 68, 'dhcp', 'P1'),
  d('tcp.port', 53, 'dns', 'P1'),
  d('tcp.port', 80, 'http', 'P1'),
  d('tcp.port', 8080, 'http', 'P1'),
  d('udp.port', 69, 'tftp', 'P1', true),
  d('udp.port', 123, 'ntp', 'P1', true),
  d('udp.port', 161, 'snmp', 'P1', true),
  d('udp.port', 514, 'syslog', 'P1', true),
  d('tcp.port', 21, 'ftp', 'P1', true),
  d('tcp.port', 22, 'ssh', 'P1', true),
  d('tcp.port', 23, 'telnet', 'P1', true),
  d('tcp.port', 25, 'smtp', 'P1', true),
  d('tcp.port', 110, 'pop3', 'P1', true),
  d('tcp.port', 143, 'imap', 'P1', true),
]);
