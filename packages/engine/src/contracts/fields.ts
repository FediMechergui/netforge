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
    f('type', 'uint', 'Ethertype of the payload; a value up to 0x05dc is an 802.3 length (the payload is LLC).', u(16, REQ)),
    f('fcs', 'uint', 'CRC-32 frame check sequence.', u(32, DERDEC)),
    f('fcsValid', 'bool', 'FCS matched the frame.', DEC),
    f('padding', 'uint', 'Number of pad bytes added to reach 64 bytes.', DEC),
  ], 'Frames include the 4-byte FCS and are padded to 64 bytes. P2: `type` ≤ ETH_LENGTH_MAX means 802.3 length ' +
    'framing — decode makes the next layer `llc`, bounded by the length; encode writes the LLC payload length when the ' +
    'builder passes any value ≤ 0x05DC (builders pass 0; LINK_FIELDS fills 0 when the next proto is `llc`). The codec ' +
    'omits and expects no FCS inside a CAPWAP tunnel (`ctx.outer.at(-1)?.proto === \'capwap\'`).'),
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
    f('dsap', 'uint', 'Destination service access point (0xaa = SNAP; 0x42 = spanning tree).', u(8, { default: 0xaa })),
    f('ssap', 'uint', 'Source service access point (0xaa = SNAP).', u(8, { default: 0xaa })),
    f('control', 'uint', 'Control byte (0x03, unnumbered information).', u(8, { default: 0x03 })),
    f('oui', 'uint', 'SNAP only: organisation code (0, or the NF OUI for NF control protocols).', u(24, { default: 0 })),
    f('type', 'uint', 'SNAP only: ethertype of the payload when oui is 0, an NF protocol id when oui is the NF OUI.', u(16)),
  ], 'LLC after an 802.11 data header or an 802.3 length; transparent for topProto. SNAP (dsap = ssap = 0xaa) ' +
    'dispatches on `type` in the ethertype space (oui 0) or the nf.pid space (oui NF_OUI); non-SNAP frames (@since P2) ' +
    'have no oui/type and dispatch on `dsap` in the llc.sap space. The SNAP encode and decode paths are byte-identical ' +
    'to P1.'),
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

  // ── P2 (ARCHITECTURE-P2 §2.3). Codecs arrive in W1 (pdu) and W3 (lag, pagp); until then these names decode as payload. ──
  dot1q: table('dot1q', 'P2', [
    f('pcp', 'uint', 'Priority code point.', u(3, { default: 0 })),
    f('dei', 'bool', 'Drop eligible indicator.', { default: false }),
    f('vid', 'uint', 'VLAN identifier.', u(12, REQ)),
    f('type', 'uint', 'Ethertype of the payload, or an 802.3 length (up to 0x05dc) when the payload is LLC; filled from the next layer.', u(16)),
  ], '802.1Q tag. `type` follows the ethernet.type 802.3 rule exactly: when the next layer is llc the builder passes 0 ' +
    'and the codec writes the LLC payload length; on decode a value ≤ ETH_LENGTH_MAX makes the next layer llc, bounded ' +
    'by the length (a tagged per-VLAN BPDU is [ethernet 0x8100, dot1q {type = length}, llc, stp]). Transparent for ' +
    'topProto; trailer fix-up like llc.'),
  stp: table('stp', 'P2', [
    f('protocolId', 'uint', 'Protocol identifier (always 0).', u(16, { default: 0 })),
    f('version', 'uint', '0 STP, 2 RST, 3 MST.', u(8, REQ)),
    f('bpduType', 'uint', '0x00 configuration, 0x80 topology change notice, 0x02 RST/MST.', u(8, REQ)),
    f('flags', 'uint', 'Configuration/RST only: bit0 TC, bit1 proposal, bits2-3 role (0 unknown, 1 alternate/backup, 2 root, 3 designated), bit4 learning, bit5 forwarding, bit6 agreement, bit7 TC-ack.', u(8)),
    f('rootPriority', 'uint', 'Root bridge priority (includes the VLAN, extended system id).', u(16)),
    f('rootMac', 'mac', 'Root bridge address.'),
    f('rootPathCost', 'uint', 'Cost of the sender\'s path to the root.', u(32)),
    f('bridgePriority', 'uint', 'Sender bridge priority (includes the VLAN).', u(16)),
    f('bridgeMac', 'mac', 'Sender bridge address.'),
    f('portId', 'uint', 'Sender port identifier (priority and number).', u(16)),
    f('messageAge', 'uint', 'Message age, in 1/256 s.', u(16)),
    f('maxAge', 'uint', 'Maximum age, in 1/256 s.', u(16)),
    f('helloTime', 'uint', 'Hello time, in 1/256 s.', u(16)),
    f('forwardDelay', 'uint', 'Forward delay, in 1/256 s.', u(16)),
    f('v1Length', 'uint', 'RST only: version 1 length (always 0).', u(8, DER)),
    f('pvid', 'uint', 'NF per-VLAN TLV (00 00 00 02 <vid>) appended to trunk BPDUs; absent on access ports.', u(16)),
    f('flagsText', 'string', "The flags as letters, e.g. 'TC,P,D,L,F'.", DEC),
  ], 'IEEE BPDU after LLC SAP 0x42 to 01:80:c2:00:00:00, one per VLAN (D8, D9). Topology change notices are 4 bytes.'),
  lacp: table('lacp', 'P2', [
    f('subtype', 'uint', 'Slow protocol subtype (1 = LACP).', u(8, { default: 1 })),
    f('version', 'uint', 'LACP version.', u(8, { default: 1 })),
    f('actorSystemPriority', 'uint', 'Sender system priority.', u(16)),
    f('actorSystem', 'mac', 'Sender system address.'),
    f('actorKey', 'uint', 'Sender operational key.', u(16)),
    f('actorPortPriority', 'uint', 'Sender port priority.', u(16)),
    f('actorPort', 'uint', 'Sender port number.', u(16)),
    f('actorState', 'uint', 'Sender state bits: 0 activity, 1 timeout, 2 aggregation, 3 sync, 4 collecting, 5 distributing, 6 defaulted, 7 expired.', u(8)),
    f('partnerSystemPriority', 'uint', 'Partner system priority as the sender knows it.', u(16)),
    f('partnerSystem', 'mac', 'Partner system address as the sender knows it.'),
    f('partnerKey', 'uint', 'Partner operational key.', u(16)),
    f('partnerPortPriority', 'uint', 'Partner port priority.', u(16)),
    f('partnerPort', 'uint', 'Partner port number.', u(16)),
    f('partnerState', 'uint', 'Partner state bits (same layout as actorState).', u(8)),
    f('collectorMaxDelay', 'uint', 'Collector maximum delay.', u(16, { default: 0 })),
  ], 'Fixed 110-byte LACPDU on ethertype 0x8809 to 01:80:c2:00:00:02; TLV types, lengths and reserved bytes are derived. The codec errors on a subtype other than 1 and stops.'),
  dtp: table('dtp', 'P2', [
    f('version', 'uint', 'Message version.', u(8, { default: 1 })),
    f('domain', 'string', "Negotiation domain (up to 32 characters; '' = none).", { default: '' }),
    f('adminMode', 'uint', 'Sender admin mode: 1 access, 2 trunk, 3 desirable, 4 auto.', u(8, REQ)),
    f('operTrunk', 'bool', 'The sender is trunking.', REQ),
    f('trunkType', 'uint', 'Trunk encapsulation (1 = 802.1Q).', u(8, { default: 1 })),
    f('neighbor', 'mac', 'Sender port address.', REQ),
  ], 'Original NF format (D8): 802.3 + LLC/SNAP with the NF OUI and PID 1, to the NF L2 control group; TLVs are type u16, length u16, value.'),
  dhcpv6: table('dhcpv6', 'P2', [
    f('msgType', 'uint', '1 SOLICIT, 2 ADVERTISE, 3 REQUEST, 4 CONFIRM, 5 RENEW, 6 REBIND, 7 REPLY, 8 RELEASE, 9 DECLINE, 10 RECONFIGURE, 11 INFORMATION-REQUEST, 12 RELAY-FORW, 13 RELAY-REPL.', u(8, REQ)),
    f('transactionId', 'uint', 'Transaction id (not in relay messages).', u(24)),
    f('clientDuid', 'string', 'Client identifier, hex (link-layer DUID from the MAC).'),
    f('serverDuid', 'string', 'Server identifier, hex.'),
    f('iaid', 'uint', 'Identity association id.', u(32)),
    f('iaAddress', 'ipv6', 'Address offered or leased (stateful).'),
    f('preferredLifetimeS', 'uint', 'Preferred lifetime of the address.', u(32)),
    f('validLifetimeS', 'uint', 'Valid lifetime of the address.', u(32)),
    f('t1S', 'uint', 'Renew time.', u(32)),
    f('t2S', 'uint', 'Rebind time.', u(32)),
    f('dnsServers', 'string', 'DNS recursive name servers, comma-separated.'),
    f('domainList', 'string', 'Domain search list.'),
    f('statusCode', 'uint', 'Status code (0 success).', u(16)),
    f('rapidCommit', 'bool', 'Rapid commit option present.'),
    f('elapsedTimeCs', 'uint', 'Elapsed time, in hundredths of a second.', u(16)),
    f('oro', 'string', 'Option request option: requested option codes, comma-separated.'),
    f('hopCount', 'uint', 'Relay messages: hop count.', u(8)),
    f('linkAddress', 'ipv6', 'Relay messages: link address.'),
    f('peerAddress', 'ipv6', 'Relay messages: peer address.'),
  ], 'UDP 546 (client) / 547 (server). The relay-message option chains to an inner dhcpv6 layer.'),
  capwap: table('capwap', 'P2', [
    f('radioId', 'uint', 'Radio identifier.', u(8)),
    f('wbid', 'uint', 'Wireless binding (1 = IEEE 802.11).', u(8, { default: 1 })),
    f('tbit', 'bool', 'A native 802.11 frame follows (no FCS).'),
    f('messageType', 'uint', 'Control only: 1/2 discovery, 3/4 join, 5/6 configuration status, 9/10 WTP event, 11/12 change state event, 13/14 echo, 3398913/3398914 IEEE 802.11 WLAN configuration.', u(32)),
    f('seq', 'uint', 'Sequence number.', u(8)),
    f('wtpName', 'string', 'Access point name.'),
    f('acName', 'string', 'Controller name.'),
    f('resultCode', 'uint', 'Result code.', u(32)),
    f('wlans', 'string', "WLAN configuration: '<id>:<ssid>:<security>:<vlan>:<keyTag>' (never a passphrase)."),
    f('stations', 'string', "WTP event station reports: '<add|del>:<station mac>:<bssid>:<wlanId>' joined by ';' (NF vendor-specific element)."),
    // added by the W6 wireless item (ARCHITECTURE-P2 §9.2 item 22b): the minimal additive contract fix of the AP identity
    f('wtpMac', 'mac', "Discovery and Join Requests: the access point's base MAC (NF vendor-specific element 3, the role of RFC 5415's WTP Board Data); the controller knows an access point by it."),
    f('keepAlive', 'bool', 'Data channel keep-alive.'),
  ], 'UDP 5246 (control) / 5247 (data); control vs data by the outer udp port. Control messages after the simulated DTLS step carry meta.protected. Inspector labels are the RFC names.'),
  // [SHOULD S2]
  hsrp: table('hsrp', 'P2', [
    f('version', 'uint', 'HSRP version (1 or 2).', u(8, REQ)),
    f('opCode', 'uint', '0 hello, 1 coup, 2 resign.', u(8, { default: 0 })),
    f('state', 'uint', '0 initial, 1 learn, 2 listen, 4 speak, 8 standby, 16 active.', u(8, REQ)),
    f('helloMs', 'uint', 'Hello interval in ms (v1 carries seconds; the codec converts).', u(32, { default: 3000 })),
    f('holdMs', 'uint', 'Hold time in ms (v1 carries seconds; the codec converts).', u(32, { default: 10000 })),
    f('priority', 'uint', 'Router priority.', u(32, { default: 100 })),
    f('group', 'uint', 'Standby group (v1: up to 255).', u(16, REQ)),
    f('authData', 'bytes', 'v1 authentication data (eight zero bytes by default).'),
    f('virtualIp', 'ipv4', 'Virtual gateway address.'),
    f('identifier', 'mac', 'v2: sender identifier.'),
  ], 'UDP 1985 to 224.0.0.2 (v1) / 224.0.0.102 (v2); v2 is the group-state TLV.'),
  // [SHOULD S3]
  pagp: table('pagp', 'P2', [
    f('version', 'uint', 'Message version.', u(8)),
    f('mode', 'uint', '1 desirable, 2 auto.', u(8)),
    f('device', 'mac', 'Sender device address.'),
    f('port', 'uint', 'Sender port number.', u(16)),
    f('group', 'uint', 'Sender channel group.', u(16)),
    f('partnerDevice', 'mac', 'Partner device address as the sender knows it.'),
    f('partnerPort', 'uint', 'Partner port number as the sender knows it.', u(16)),
  ], 'Original NF format (D8): 802.3 + LLC/SNAP with the NF OUI and PID 3, to the NF L2 control group.'),
  // P3: the P3 protocols' tables are held in P3_PROTO_FIELDS below until their codecs land (W1 pdu).
});

/**
 * @since P3 The field tables of the P3 protocols (ARCHITECTURE-P3 §2.3, §2.16, §2.17), written in W0 and held OUTSIDE
 * `PROTO_FIELDS` so that W0 changes no behaviour (§0 rule 3): `PROTO_FIELDS` is a runtime list that NetScope's display
 * filter registry (`capture/filter/fields.ts` `buildRegistry`), the pdu field lookup and the web field formatters
 * iterate, so a table there would make the filter accept `ospf`, `ntp`, `ssh` … in P1/P2 worlds and match nothing.
 * Nothing reads this constant. Each W1 pdu codec item MOVES its protocol's table from here into `PROTO_FIELDS`, in the
 * same change as its codec, registry line and dispatch line (rule 18), and the W2 capture items build their display
 * fields on it; when the last codec has landed this constant is empty and is deleted.
 */
export const P3_PROTO_FIELDS: Readonly<Record<string, ProtoFieldTable>> = Object.freeze({
  ospf: table('ospf', 'P3', [
    f('version', 'uint', 'OSPF version (2).', u(8, { required: true, default: 2 })),
    f('type', 'uint', 'Packet type: 1 hello, 2 database description, 3 link-state request, 4 link-state update, 5 link-state acknowledgement.', u(8, REQ)),
    f('length', 'uint', 'Packet length in bytes.', u(16, DER)),
    f('routerId', 'ipv4', 'Router id of the sender.', REQ),
    f('area', 'ipv4', 'Area id (dotted, e.g. 0.0.0.0).', REQ),
    f('checksum', 'uint', 'IP one\'s-complement checksum over the packet minus the authentication field.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched.', DEC),
    f('auType', 'uint', 'Authentication type (0 = none).', u(16, { default: 0 })),
    f('mask', 'ipv4', 'Hello: the network mask of the sending interface.'),
    f('helloInterval', 'uint', 'Hello: seconds between hellos.', u(16, { default: 10 })),
    f('options', 'uint', 'Hello and database description: option bits (E = 0x02, external routes accepted).', u(8, { default: 0x02 })),
    f('priority', 'uint', 'Hello: router priority for the DR election (0 = never DR or BDR).', u(8, { default: 1 })),
    f('deadInterval', 'uint', 'Hello: seconds without a hello before a neighbour is declared down.', u(32, { default: 40 })),
    f('dr', 'ipv4', 'Hello: the designated router (interface address) as the sender sees it; 0.0.0.0 = none.'),
    f('bdr', 'ipv4', 'Hello: the backup designated router as the sender sees it; 0.0.0.0 = none.'),
    f('neighbors', 'string', "Hello: router ids of the neighbours heard on this interface, joined by ','."),
    f('mtu', 'uint', 'Database description: the interface MTU.', u(16)),
    f('flags', 'uint', 'Database description: I (initial) 4, M (more) 2, MS (master) 1.', u(8)),
    f('ddSeq', 'uint', 'Database description: sequence number.', u(32)),
    f('requests', 'string', "Link-state request: '<type>:<lsid>:<adv>' entries joined by ';'."),
    f('count', 'uint', 'Link-state update: number of LSAs that follow.', u(32, DER)),
  ], 'IP protocol 89, RFC 2328 layout. Each LSA (in an update) or LSA header (in a database description or an acknowledgement) is its own chained ospf-lsa layer. summary()/topProto() stop here.'),
  'ospf-lsa': table('ospf-lsa', 'P3', [
    f('age', 'uint', 'LSA age in seconds (MaxAge 3600 = being flushed).', u(16, { default: 0 })),
    f('options', 'uint', 'Option bits.', u(8, { default: 0x02 })),
    f('lsType', 'uint', 'LSA type: 1 router, 2 network, 5 external.', u(8, REQ)),
    f('lsid', 'ipv4', 'Link-state id.', REQ),
    f('advRouter', 'ipv4', 'Advertising router id.', REQ),
    f('seq', 'uint', 'Sequence number (starts at 0x80000001).', u(32, { default: 0x80000001 })),
    f('checksum', 'uint', 'Fletcher checksum over the LSA except its age: computed in an update; carried as the full LSA\'s value (required) when headerOnly.', u(16)),
    f('length', 'uint', 'LSA length in bytes: computed in an update; carried as the full LSA\'s value (required) when headerOnly.', u(16)),
    f('checksumValid', 'bool', 'Fletcher checksum matched (full LSAs only).', DEC),
    f('headerOnly', 'bool', 'This layer is an LSA header copy (database description, acknowledgement), from the enclosing ospf.type.', DEC),
    f('flags', 'uint', 'Router LSA: V 4, E 2, B 1.', u(8)),
    f('links', 'string', "Router LSA: '<kind>,<id>,<data>,<metric>' entries joined by ';' (kinds p2p, transit, stub)."),
    f('mask', 'ipv4', 'Network and external LSAs: the network mask.'),
    f('attached', 'string', "Network LSA: router ids of the attached routers, joined by ','."),
    f('e2', 'bool', 'External LSA: type 2 external metric.'),
    f('metric', 'uint', 'External LSA: the metric.', u(24)),
    f('forward', 'ipv4', 'External LSA: forwarding address.'),
    f('tag', 'uint', 'External LSA: route tag.', u(32)),
  ], 'The LSA header (20 bytes) and, in an update, its body. The encoder reads the enclosing ospf.type through ctx.outer.'),
  cdp: table('cdp', 'P3', [
    f('version', 'uint', 'Discovery message version.', u(8, { default: 2 })),
    f('ttl', 'uint', 'Holdtime in seconds.', u(8, { default: 180 })),
    f('deviceId', 'string', 'The sender\'s device name.', REQ),
    f('addresses', 'string', "Management addresses of the sender, joined by ','."),
    f('portId', 'string', 'The sending port\'s name.', REQ),
    f('capabilities', 'string', "Capability letters: R router, S switch, I IGMP-capable, joined by ' '."),
    f('platform', 'string', 'The sender\'s model name.'),
    f('software', 'string', 'The sender\'s software description (original text).'),
    f('nativeVlan', 'uint', 'Native VLAN of the sending port.', u(16)),
    f('duplex', 'string', "Duplex of the sending port: 'full' | 'half'."),
  ], 'Original NF discovery format ("CDP" is a name only; D18): 802.3 + LLC/SNAP with the NF OUI and PID 4 (NF_PID_CDP), to the NF L2 control group, always untagged; TLVs are type u16, length u16, value.'),
  lldp: table('lldp', 'P3', [
    f('chassisSubtype', 'uint', 'Chassis id subtype (4 = MAC address).', u(8, { default: 4 })),
    f('chassisId', 'string', 'Chassis id (the base MAC).', REQ),
    f('portSubtype', 'uint', 'Port id subtype (5 = interface name).', u(8, { default: 5 })),
    f('portId', 'string', 'Port id (the interface name).', REQ),
    f('ttl', 'uint', 'Time to live in seconds.', u(16, { default: 120 })),
    f('portDescription', 'string', 'Port description.'),
    f('systemName', 'string', 'System name.'),
    f('systemDescription', 'string', 'System description (original text).'),
    f('capabilities', 'uint', 'System capabilities bit map.', u(16)),
    f('enabledCapabilities', 'uint', 'Enabled capabilities bit map.', u(16)),
    f('mgmtAddress', 'ipv4', 'Management address.'),
  ], 'IEEE 802.1AB: ethertype 0x88cc to 01:80:c2:00:00:0e; the end-of-LLDPDU TLV is derived.'),
  ntp: table('ntp', 'P3', [
    f('leap', 'uint', 'Leap indicator (3 = alarm: the server is not synchronised).', u(2, { default: 0 })),
    f('version', 'uint', 'NTP version.', u(3, { default: 4 })),
    f('mode', 'uint', 'Mode: 3 client, 4 server.', u(3, REQ)),
    f('stratum', 'uint', 'Stratum (16 = not synchronised).', u(8)),
    f('poll', 'int', 'Poll interval, log2 seconds.', u(8, { default: 6 })),
    f('precision', 'int', 'Clock precision, log2 seconds.', u(8)),
    f('rootDelay', 'uint', 'Round-trip delay to the reference, 16.16 fixed point.', u(32)),
    f('rootDispersion', 'uint', 'Dispersion to the reference, 16.16 fixed point.', u(32)),
    f('refId', 'string', "Reference id: 'LOCL', 'INIT' or an address."),
    f('refTimestamp', 'string', "Reference timestamp, decimal 's.fffffffff' (64-bit on the wire)."),
    f('originTimestamp', 'string', "Origin timestamp, decimal 's.fffffffff' (64-bit on the wire)."),
    f('receiveTimestamp', 'string', "Receive timestamp, decimal 's.fffffffff' (64-bit on the wire)."),
    f('transmitTimestamp', 'string', "Transmit timestamp, decimal 's.fffffffff' (64-bit on the wire)."),
  ], 'NTPv4 over UDP 123 (RFC 5905); timestamps are decimal strings so no bigint enters a field.'),
  // [S13]
  telnet: table('telnet', 'P3', [
    f('data', 'string', 'The text carried (in the clear: a typed password is readable).'),
    f('iac', 'string', "Option commands, e.g. 'WILL ECHO', joined by ';'."),
  ], 'TCP 23. Nothing is protected.'),
  ssh: table('ssh', 'P3', [
    f('phase', 'string', "'version' (the clear version exchange) | 'protected' (everything after it)."),
    f('version', 'string', 'The version string of the clear exchange.'),
    f('length', 'uint', 'Protected packet length.', u(32, DER)),
    f('payload', 'bytes', 'The protected stream (simulated: XORed with a derived keystream; the inspector shows it decoded under the SSH banner).'),
  ], 'TCP 22. Protected packets carry meta.protected with protectedBy \'ssh\' (simulated crypto).'),
  // [S18]
  gre: table('gre', 'P3', [
    f('checksumPresent', 'bool', 'Checksum present bit.', { default: false }),
    f('keyPresent', 'bool', 'Key present bit.', { default: false }),
    f('seqPresent', 'bool', 'Sequence number present bit.', { default: false }),
    f('version', 'uint', 'GRE version (0).', u(3, { default: 0 })),
    f('protocolType', 'uint', 'Protocol of the carried packet (ethertype space), filled from the next layer.', u(16)),
  ], 'IP protocol 47; the inner packet follows (the tunnel owner rewraps once, so the PduId never changes).'),
  // [S19]
  ppp: table('ppp', 'P3', [
    f('address', 'uint', 'Address (all stations).', u(8, { default: 0xff })),
    f('control', 'uint', 'Control (unnumbered information).', u(8, { default: 0x03 })),
    f('protocol', 'uint', 'Protocol of the payload (PPP_PROTO: IPv4 0x0021, IPv6 0x0057, LCP 0xc021, PAP 0xc023, CHAP 0xc223, IPCP 0x8021, IPv6CP 0x8057), filled from the next layer.', u(16)),
    f('fcs', 'uint', 'CRC-16/X.25.', u(16, DERDEC)),
    f('fcsValid', 'bool', 'FCS matched.', DEC),
  ], 'RFC 1662 framing without flags in bytes; next layer by the ppp.proto space.'),
  lcp: table('lcp', 'P3', [
    f('code', 'uint', 'Code: 1 configure-request, 2 ack, 3 nak, 4 reject, 5 terminate-request, 6 terminate-ack, 9 echo-request, 10 echo-reply.', u(8, REQ)),
    f('id', 'uint', 'Identifier.', u(8, REQ)),
    f('length', 'uint', 'Length in bytes.', u(16, DER)),
    f('mru', 'uint', 'Maximum receive unit option.', u(16)),
    f('authProto', 'string', "Authentication protocol option: 'chap-md5' | 'pap'."),
    f('magic', 'uint', 'Magic number option.', u(32)),
    f('echoMagic', 'uint', 'Echo request / reply: the sender\'s magic number.', u(32)),
    f('reason', 'string', 'Terminate request: the reason text.'),
    f('rejected', 'string', 'Configure reject: the rejected options.'),
  ]),
  pap: table('pap', 'P3', [
    f('code', 'uint', 'Code: 1 authenticate-request, 2 ack, 3 nak.', u(8, REQ)),
    f('id', 'uint', 'Identifier.', u(8, REQ)),
    f('peerId', 'string', 'The peer\'s name.'),
    f('password', 'string', 'The password, in the clear on the wire by design.'),
    f('message', 'string', 'Ack / nak message.'),
  ]),
  chap: table('chap', 'P3', [
    f('code', 'uint', 'Code: 1 challenge, 2 response, 3 success, 4 failure.', u(8, REQ)),
    f('id', 'uint', 'Identifier.', u(8, REQ)),
    f('value', 'bytes', 'Challenge, or response = MD5(id, secret, challenge); 16 bytes. The secret never travels.'),
    f('name', 'string', 'The sender\'s name.'),
    f('message', 'string', 'Success / failure message.'),
  ]),
  ipcp: table('ipcp', 'P3', [
    f('code', 'uint', 'Code (as LCP).', u(8, REQ)),
    f('id', 'uint', 'Identifier.', u(8, REQ)),
    f('ipAddress', 'ipv4', 'IP address option.'),
  ]),
  ipv6cp: table('ipv6cp', 'P3', [
    f('code', 'uint', 'Code (as LCP).', u(8, REQ)),
    f('id', 'uint', 'Identifier.', u(8, REQ)),
    f('interfaceId', 'string', 'Interface identifier option (64 bits, hex).'),
  ]),
  // [S25]
  syslog: table('syslog', 'P3', [
    f('pri', 'uint', 'Priority: facility × 8 + severity.', u(8, REQ)),
    f('facility', 'uint', 'Facility (0–23), from the priority.', u(8, DERDEC)),
    f('severity', 'uint', 'Severity (0 emergencies … 7 debugging), from the priority.', u(8, DERDEC)),
    f('timestamp', 'string', 'The sender\'s timestamp text.'),
    f('hostname', 'string', 'The sender\'s name.'),
    f('message', 'string', 'The log message.'),
  ], 'UDP 514, RFC 3164 style: <PRI>TIMESTAMP HOSTNAME: message.'),
  // [C1]
  eigrp: table('eigrp', 'P3', [
    f('version', 'uint', 'EIGRP version (2).', u(8, { default: 2 })),
    f('opcode', 'uint', 'Opcode: 1 update, 3 query, 4 reply, 5 hello (an acknowledgement is a hello carrying ack), 10 SIA-query, 11 SIA-reply.', u(8, REQ)),
    f('checksum', 'uint', 'IP one\'s-complement checksum over the packet.', u(16, DER)),
    f('checksumValid', 'bool', 'Checksum matched.', DEC),
    f('flags', 'uint', 'Flags: init 1, conditional receive 2, restart 4, end of table 8.', u(32, { default: 0 })),
    f('seq', 'uint', 'Sequence number (reliable packets).', u(32, { default: 0 })),
    f('ack', 'uint', 'Acknowledged sequence number.', u(32, { default: 0 })),
    f('vrid', 'uint', 'Virtual router id (0).', u(16, { default: 0 })),
    f('as', 'uint', 'Autonomous system number.', u(16, REQ)),
    f('kValues', 'string', "Parameter TLV: 'k1,k2,k3,k4,k5'."),
    f('holdS', 'uint', 'Parameter TLV: hold time in seconds.', u(16)),
    f('routes', 'string', "IPv4 internal-route TLVs: 'prefix/len,delayUs,bwKbps,mtu,hops,rel,load,nextHop' joined by ';' ('inf' as the delay of an unreachable route; the wire uses the RFC's scaled units)."),
  ], 'IP protocol 88, RFC 7868 layout; hellos to 224.0.0.10. summary()/topProto() stop here.'),
  // [C13]
  esp: table('esp', 'P3', [
    f('spi', 'uint', 'Security parameter index.', u(32, REQ)),
    f('seq', 'uint', 'Sequence number.', u(32, REQ)),
    f('padLength', 'uint', 'Trailer: pad length (0–3).', u(8, DER)),
    f('nextHeader', 'uint', 'Trailer: protocol of the inner packet (4 = IPv4).', u(8, { required: true, default: 4 })),
    f('icv', 'bytes', 'Integrity check value, 12 bytes (a chained FNV-1a value over the SA key id, the SPI, the sequence number and the payload; never a key).', DER),
    f('icvValid', 'bool', 'ICV matched.', DEC),
  ], 'IP protocol 50. The inner packet follows in the clear under meta.protected with protectedBy \'esp\' (simulated crypto: headers real, D27).'),
  ikev2: table('ikev2', 'P3', [
    f('spiI', 'string', 'Initiator SPI, 16 hex digits.', REQ),
    f('spiR', 'string', 'Responder SPI, 16 hex digits (zeros in the first request).'),
    f('nextPayload', 'uint', 'First payload type.', u(8, DER)),
    f('version', 'uint', 'Version (0x20).', u(8, { default: 0x20 })),
    f('exchange', 'uint', 'Exchange type: 34 IKE_SA_INIT, 35 IKE_AUTH.', u(8, REQ)),
    f('flags', 'uint', 'Flags: I (initiator) 0x08, R (response) 0x20.', u(8, { default: 0 })),
    f('messageId', 'uint', 'Message id.', u(32, { default: 0 })),
    f('length', 'uint', 'Message length in bytes.', u(32, DER)),
    f('sa', 'string', "Security association proposal, e.g. 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14'."),
    f('ke', 'string', 'Key exchange value (simulated), 32 hex bytes.'),
    f('nonce', 'string', 'Nonce (simulated), 32 hex bytes.'),
    f('idi', 'string', 'Initiator identity (its address).'),
    f('idr', 'string', 'Responder identity (its address).'),
    f('auth', 'string', 'Authentication proof (simulated), 16 hex bytes; never the key.'),
    f('tsi', 'string', 'Initiator traffic selectors.'),
    f('tsr', 'string', 'Responder traffic selectors.'),
    f('notify', 'string', "Notification, e.g. 'AUTHENTICATION_FAILED', 'NO_PROPOSAL_CHOSEN'."),
  ], 'UDP 500, RFC 7296 header with original compact payload bodies. IKE_AUTH messages carry meta.protected with protectedBy \'ike\'.'),
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

/**
 * Ethertype (ethernet.type, llc.type, hdlc.protocol), IP protocol (ipv4.protocol, ipv6.nextHeader) and well-known port
 * dispatch. P2 adds the spaces 'llc.sap' (non-SNAP llc.dsap) and 'nf.pid' (llc.type when llc.oui is NF_OUI); a
 * P2 entry whose codec is not registered yet decodes as payload (dispatch.ts), so the entries are decode-neutral
 * until their codec lands.
 */
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
  // ── P2 ──
  d('ethertype', 0x8100, 'dot1q', 'P2'),
  d('ethertype', 0x8809, 'lacp', 'P2'), // slow protocols; the lacp codec errors on subtype ≠ 1 and stops
  d('llc.sap', 0x42, 'stp', 'P2'),
  d('nf.pid', 0x0001, 'dtp', 'P2'),
  d('udp.port', 546, 'dhcpv6', 'P2'),
  d('udp.port', 547, 'dhcpv6', 'P2'),
  d('udp.port', 5246, 'capwap', 'P2'),
  d('udp.port', 5247, 'capwap', 'P2'),
  d('udp.port', 1985, 'hsrp', 'P2'), // [SHOULD S2]
  d('nf.pid', 0x0003, 'pagp', 'P2'), // [SHOULD S3]
]);
