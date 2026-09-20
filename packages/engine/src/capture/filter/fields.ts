/**
 * capture/filter/fields.ts — the NetScope display-filter field registry (contracts/capture.ts `DisplayFieldDef`).
 *
 * Pure and DOM-free (also exported by the `pure` entry). The registry is generated from `PROTO_FIELDS`:
 *  • every protocol table gives a protocol entry (`tcp`, type 'protocol') and one entry per canonical field
 *    (`tcp.srcPort`, `ipv4.src`, …) typed from its FieldType (uint/int → number, bytes → string);
 *  • `frame.*` fields read the record metadata (number, lengths, relative time, interface, direction);
 *  • a familiar alias table (`ip.addr`, `eth.src`, `tcp.port`, `tcp.flags.syn`, `dns.qry.name`, …) maps short names
 *    onto canonical paths, some through a small derivation (flag letters, DNS question text, HTTP kind).
 *
 * Accessors return every value of a field in the frame, outermost layer first, so a quoted datagram inside an ICMP
 * error contributes its addresses too (multi-valued fields; `==` means any, `!=` means none).
 */
import type { DisplayFieldDef } from '../../contracts/capture.js';
import type { FieldType } from '../../contracts/fields.js';
import { PROTO_FIELDS } from '../../contracts/fields.js';
import type { FieldValue, LayerView } from '../../contracts/pdu.js';

/** The value type a display field compares as. */
export type DisplayFieldType = DisplayFieldDef['type'];

/** Frame metadata plus decoded layers that a display filter runs over (built by the capture store per record). */
export interface DisplayFilterFrame {
  /** frame.number: 1-based (record index + 1). */
  number: number;
  /** frame.len: original length on the wire. */
  len: number;
  /** Nanoseconds since the first record of the capture (frame.time_relative is shown in seconds). */
  timeRelativeNs: number;
  /** frame.interface: index of the capture interface. */
  iface: number;
  /** frame.interface_name: display name of the capture interface. */
  ifaceName?: string;
  /** frame.direction. */
  dir?: 'tx' | 'rx' | 'unknown';
  /** frame.corrupted. */
  corrupted?: boolean;
  /** Decoded layers, outermost first. */
  layers: readonly LayerView[];
  /** Captured bytes: frame.cap_len and `<protocol> contains "text"` read them. */
  bytes?: Uint8Array;
}

/** One extracted field value. Byte fields stay `Uint8Array`. */
export type DisplayScalar = number | string | boolean | Uint8Array;

/** A resolved field: its definition, a presence test and a value extractor. */
export interface DisplayFieldAccessor {
  readonly def: DisplayFieldDef;
  /** Every value of the field in the frame (empty when absent). Protocol fields return each layer's bytes. */
  values(frame: DisplayFilterFrame): DisplayScalar[];
  /** True when the field (or protocol) occurs in the frame. */
  present(frame: DisplayFilterFrame): boolean;
}

const PROTOCOL_HELP: Readonly<Record<string, string>> = Object.freeze({
  ethernet: 'Ethernet II frame.',
  arp: 'Address Resolution Protocol.',
  ipv4: 'Internet Protocol version 4.',
  icmpv4: 'ICMP for IPv4 (echo, unreachable, time exceeded).',
  payload: 'Bytes no decoder claimed.',
  hdlc: 'Serial HDLC framing.',
  dot11: 'IEEE 802.11 wireless frame.',
  'dot11-mgmt': 'IEEE 802.11 management body (beacons, probes, authentication, association).',
  llc: 'LLC/SNAP header after an 802.11 data header.',
  eapol: 'EAP over LAN key exchange.',
  ipv6: 'Internet Protocol version 6.',
  'ipv6-hopopts': 'IPv6 hop-by-hop options header.',
  'ipv6-route': 'IPv6 routing header.',
  'ipv6-frag': 'IPv6 fragment header.',
  'ipv6-dstopts': 'IPv6 destination options header.',
  icmpv6: 'ICMP for IPv6 (echo, neighbor discovery, router discovery, errors).',
  udp: 'User Datagram Protocol.',
  tcp: 'Transmission Control Protocol.',
  dhcp: 'Dynamic Host Configuration Protocol (IPv4).',
  dns: 'Domain Name System.',
  http: 'Hypertext Transfer Protocol.',
});

function mapFieldType(t: FieldType): DisplayFieldType {
  switch (t) {
    case 'uint':
    case 'int':
      return 'number';
    case 'bool':
      return 'bool';
    case 'mac':
      return 'mac';
    case 'ipv4':
      return 'ipv4';
    case 'ipv6':
      return 'ipv6';
    case 'string':
    case 'bytes':
      return 'string';
  }
}

function def(name: string, reads: readonly string[], type: DisplayFieldType, help: string): DisplayFieldDef {
  return Object.freeze({ name, reads: Object.freeze([...reads]), type, help });
}

function scalar(v: FieldValue | undefined): DisplayScalar | undefined {
  if (v === undefined || v === null) return undefined;
  return v;
}

/** Values of canonical path `proto.field` over every layer of `proto`, outermost first. */
function canonicalValues(frame: DisplayFilterFrame, proto: string, field: string): DisplayScalar[] {
  const out: DisplayScalar[] = [];
  for (const layer of frame.layers) {
    if (layer.proto !== proto) continue;
    const v = scalar(layer.fields[field]);
    if (v !== undefined) out.push(v);
  }
  return out;
}

function splitPath(path: string): [string, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot), path.slice(dot + 1)];
}

function layerPresent(frame: DisplayFilterFrame, proto: string): boolean {
  for (const layer of frame.layers) if (layer.proto === proto) return true;
  return false;
}

function layerBytes(frame: DisplayFilterFrame, proto: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const bytes = frame.bytes;
  if (bytes === undefined) return out;
  for (const layer of frame.layers) {
    if (layer.proto !== proto) continue;
    const start = Math.min(Math.max(layer.offset, 0), bytes.length);
    const end = Math.min(start + Math.max(layer.length, 0), bytes.length);
    out.push(bytes.subarray(start, end));
  }
  return out;
}

function valuesAccessor(d: DisplayFieldDef, values: (frame: DisplayFilterFrame) => DisplayScalar[]): DisplayFieldAccessor {
  return Object.freeze({ def: d, values, present: (frame: DisplayFilterFrame) => values(frame).length > 0 });
}

function canonicalAccessor(d: DisplayFieldDef): DisplayFieldAccessor {
  const paths = d.reads.map(splitPath);
  return valuesAccessor(d, (frame) => {
    if (paths.length === 1) {
      const [p, f] = paths[0] as [string, string];
      return canonicalValues(frame, p, f);
    }
    const out: DisplayScalar[] = [];
    for (const [p, f] of paths) out.push(...canonicalValues(frame, p, f));
    return out;
  });
}

function protocolAccessor(d: DisplayFieldDef, proto: string): DisplayFieldAccessor {
  return Object.freeze({
    def: d,
    values: (frame: DisplayFilterFrame) => layerBytes(frame, proto),
    present: (frame: DisplayFilterFrame) => layerPresent(frame, proto),
  });
}

/** Map every layer of `proto` through `pick` (undefined results are skipped). */
function derived(proto: string, pick: (layer: LayerView) => DisplayScalar | DisplayScalar[] | undefined): (frame: DisplayFilterFrame) => DisplayScalar[] {
  return (frame) => {
    const out: DisplayScalar[] = [];
    for (const layer of frame.layers) {
      if (layer.proto !== proto) continue;
      const v = pick(layer);
      if (v === undefined) continue;
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
    return out;
  };
}

function textField(layer: LayerView, field: string): string | undefined {
  const v = layer.fields[field];
  return typeof v === 'string' ? v : undefined;
}

/** TCP flag letter as a boolean for every tcp layer. */
function tcpFlag(letter: string): (layer: LayerView) => DisplayScalar | undefined {
  return (layer) => {
    const flags = layer.fields['flags'];
    if (typeof flags !== 'string') return undefined;
    return flags.includes(letter);
  };
}

/** Entries of a DNS record list ('name TYPE …' joined by ';'). */
function dnsEntries(layer: LayerView, field: string): string[][] {
  const text = textField(layer, field);
  if (text === undefined || text.length === 0) return [];
  const out: string[][] = [];
  for (const entry of text.split(';')) {
    const parts = entry.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 0) out.push(parts);
  }
  return out;
}

function dnsAnswerData(type: string): (layer: LayerView) => DisplayScalar[] {
  return (layer) => {
    const out: DisplayScalar[] = [];
    for (const field of ['answers', 'authorities', 'additionals']) {
      for (const parts of dnsEntries(layer, field)) {
        if ((parts[1] ?? '').toUpperCase() !== type) continue;
        const data = parts.slice(3).join(' ');
        if (data.length > 0) out.push(data);
      }
    }
    return out;
  };
}

function httpKind(kind: 'request' | 'response', field?: string): (layer: LayerView) => DisplayScalar | undefined {
  return (layer) => {
    if (layer.fields['kind'] !== kind) return undefined;
    if (field === undefined) return true;
    return scalar(layer.fields[field]);
  };
}

function httpHeader(name: string): (layer: LayerView) => DisplayScalar[] {
  const lower = name.toLowerCase();
  return (layer) => {
    const headers = textField(layer, 'headers');
    if (headers === undefined) return [];
    const out: DisplayScalar[] = [];
    for (const line of headers.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() === lower) out.push(line.slice(colon + 1).trim());
    }
    return out;
  };
}

/** Alias: short name → canonical path(s), with the same type as the canonical field. */
interface PlainAlias {
  name: string;
  reads: readonly string[];
  help: string;
}

const PLAIN_ALIASES: readonly PlainAlias[] = [
  { name: 'eth.src', reads: ['ethernet.src'], help: 'Source MAC address (ethernet.src).' },
  { name: 'eth.dst', reads: ['ethernet.dst'], help: 'Destination MAC address (ethernet.dst).' },
  { name: 'eth.addr', reads: ['ethernet.src', 'ethernet.dst'], help: 'Either MAC address of the frame.' },
  { name: 'eth.type', reads: ['ethernet.type'], help: 'Ethertype of the payload (ethernet.type).' },
  { name: 'arp.opcode', reads: ['arp.op'], help: 'ARP operation: 1 request, 2 reply (arp.op).' },
  { name: 'arp.src.hw_mac', reads: ['arp.sha'], help: 'Sender MAC address (arp.sha).' },
  { name: 'arp.src.proto_ipv4', reads: ['arp.spa'], help: 'Sender IPv4 address (arp.spa).' },
  { name: 'arp.dst.hw_mac', reads: ['arp.tha'], help: 'Target MAC address (arp.tha).' },
  { name: 'arp.dst.proto_ipv4', reads: ['arp.tpa'], help: 'Target IPv4 address (arp.tpa).' },
  { name: 'ip.src', reads: ['ipv4.src'], help: 'IPv4 source address (ipv4.src).' },
  { name: 'ip.dst', reads: ['ipv4.dst'], help: 'IPv4 destination address (ipv4.dst).' },
  { name: 'ip.addr', reads: ['ipv4.src', 'ipv4.dst'], help: 'Either IPv4 address of the packet.' },
  { name: 'ip.ttl', reads: ['ipv4.ttl'], help: 'IPv4 time to live (ipv4.ttl).' },
  { name: 'ip.proto', reads: ['ipv4.protocol'], help: 'IPv4 upper-layer protocol number (ipv4.protocol).' },
  { name: 'ip.len', reads: ['ipv4.totalLength'], help: 'IPv4 total length (ipv4.totalLength).' },
  { name: 'ip.id', reads: ['ipv4.id'], help: 'IPv4 identification (ipv4.id).' },
  { name: 'ip.dsfield.dscp', reads: ['ipv4.dscp'], help: 'IPv4 DSCP value (ipv4.dscp).' },
  { name: 'ipv6.addr', reads: ['ipv6.src', 'ipv6.dst'], help: 'Either IPv6 address of the packet.' },
  { name: 'ipv6.hlim', reads: ['ipv6.hopLimit'], help: 'IPv6 hop limit (ipv6.hopLimit).' },
  { name: 'ipv6.nxt', reads: ['ipv6.nextHeader'], help: 'IPv6 next header (ipv6.nextHeader).' },
  { name: 'ipv6.plen', reads: ['ipv6.payloadLength'], help: 'IPv6 payload length (ipv6.payloadLength).' },
  { name: 'icmp.type', reads: ['icmpv4.type'], help: 'ICMP type (icmpv4.type).' },
  { name: 'icmp.code', reads: ['icmpv4.code'], help: 'ICMP code (icmpv4.code).' },
  { name: 'icmp.ident', reads: ['icmpv4.id'], help: 'ICMP echo identifier (icmpv4.id).' },
  { name: 'icmp.seq', reads: ['icmpv4.seq'], help: 'ICMP echo sequence number (icmpv4.seq).' },
  { name: 'icmpv6.nd.ns.target_address', reads: ['icmpv6.target'], help: 'Neighbor solicitation/advertisement target (icmpv6.target).' },
  { name: 'tcp.port', reads: ['tcp.srcPort', 'tcp.dstPort'], help: 'Either TCP port.' },
  { name: 'tcp.srcport', reads: ['tcp.srcPort'], help: 'TCP source port (tcp.srcPort).' },
  { name: 'tcp.dstport', reads: ['tcp.dstPort'], help: 'TCP destination port (tcp.dstPort).' },
  { name: 'tcp.window_size', reads: ['tcp.window'], help: 'TCP receive window (tcp.window).' },
  { name: 'udp.port', reads: ['udp.srcPort', 'udp.dstPort'], help: 'Either UDP port.' },
  { name: 'udp.srcport', reads: ['udp.srcPort'], help: 'UDP source port (udp.srcPort).' },
  { name: 'udp.dstport', reads: ['udp.dstPort'], help: 'UDP destination port (udp.dstPort).' },
  { name: 'dns.flags.response', reads: ['dns.qr'], help: 'The DNS message is a response (dns.qr).' },
  { name: 'dns.flags.rcode', reads: ['dns.rcode'], help: 'DNS response code: 0 no error, 2 server failure, 3 no such name (dns.rcode).' },
  { name: 'dhcp.type', reads: ['dhcp.messageType'], help: 'DHCP message type, e.g. "DISCOVER" (dhcp.messageType).' },
  { name: 'dhcp.ip.your', reads: ['dhcp.yiaddr'], help: 'Address offered to the client (dhcp.yiaddr).' },
  { name: 'dhcp.ip.client', reads: ['dhcp.ciaddr'], help: 'Client address (dhcp.ciaddr).' },
  { name: 'dhcp.ip.relay', reads: ['dhcp.giaddr'], help: 'Relay agent address (dhcp.giaddr).' },
  { name: 'dhcp.hw.mac_addr', reads: ['dhcp.chaddr'], help: 'Client hardware address (dhcp.chaddr).' },
  { name: 'wlan.ssid', reads: ['dot11-mgmt.ssid'], help: 'Wireless network name (dot11-mgmt.ssid).' },
  { name: 'wlan.bssid', reads: ['dot11-mgmt.bssid'], help: 'Wireless BSSID (dot11-mgmt.bssid).' },
  { name: 'wlan.ra', reads: ['dot11.addr1'], help: 'Wireless receiver address (dot11.addr1).' },
  { name: 'wlan.ta', reads: ['dot11.addr2'], help: 'Wireless transmitter address (dot11.addr2).' },
  { name: 'http.request.uri', reads: ['http.target'], help: 'Request target, e.g. "/index.html" (http.target).' },
  { name: 'http.response.phrase', reads: ['http.reason'], help: 'Response reason phrase (http.reason).' },
  { name: 'http.file_data', reads: ['http.body'], help: 'HTTP message body (http.body).' },
];

const PROTOCOL_ALIASES: readonly { name: string; proto: string }[] = [
  { name: 'eth', proto: 'ethernet' },
  { name: 'ip', proto: 'ipv4' },
  { name: 'icmp', proto: 'icmpv4' },
  { name: 'wlan', proto: 'dot11' },
  { name: 'data', proto: 'payload' },
];

function canonicalFieldType(path: string): DisplayFieldType {
  const [proto, field] = splitPath(path);
  const spec = PROTO_FIELDS[proto]?.fields.find((f) => f.name === field);
  if (spec === undefined) throw new Error(`display filter alias reads an unknown field ${path}`);
  return mapFieldType(spec.type);
}

function frameAccessors(): DisplayFieldAccessor[] {
  const out: DisplayFieldAccessor[] = [];
  const add = (name: string, type: DisplayFieldType, help: string, pick: (frame: DisplayFilterFrame) => DisplayScalar | undefined): void => {
    const d = def(name, [name], type, help);
    out.push(valuesAccessor(d, (frame) => {
      const v = pick(frame);
      return v === undefined ? [] : [v];
    }));
  };
  const frameDef = def('frame', ['frame'], 'protocol', 'Every captured frame.');
  out.push(Object.freeze({
    def: frameDef,
    values: (frame: DisplayFilterFrame) => (frame.bytes === undefined ? [] : [frame.bytes]),
    present: () => true,
  }));
  add('frame.number', 'number', 'Frame number in the capture, starting at 1.', (f) => f.number);
  add('frame.len', 'number', 'Frame length on the wire, in bytes.', (f) => f.len);
  add('frame.cap_len', 'number', 'Bytes captured for this frame.', (f) => (f.bytes === undefined ? f.len : f.bytes.length));
  add('frame.time_relative', 'number', 'Seconds since the first frame of the capture.', (f) => f.timeRelativeNs / 1_000_000_000);
  add('frame.interface', 'number', 'Index of the capture interface that saw the frame.', (f) => f.iface);
  add('frame.interface_name', 'string', 'Name of the capture interface, e.g. "PC1 Gi0".', (f) => f.ifaceName);
  add('frame.direction', 'string', 'Direction at the capture point: "tx", "rx" or "unknown".', (f) => f.dir ?? 'unknown');
  add('frame.corrupted', 'bool', 'The frame was damaged on the medium.', (f) => f.corrupted === true);
  return out;
}

function derivedAccessors(): DisplayFieldAccessor[] {
  const out: DisplayFieldAccessor[] = [];
  const add = (name: string, reads: readonly string[], type: DisplayFieldType, help: string, values: (frame: DisplayFilterFrame) => DisplayScalar[]): void => {
    out.push(valuesAccessor(def(name, reads, type, help), values));
  };
  const flags: readonly [string, string, string][] = [
    ['fin', 'F', 'FIN: the sender has finished sending.'],
    ['syn', 'S', 'SYN: synchronise sequence numbers (connection open).'],
    ['reset', 'R', 'RST: reset the connection.'],
    ['rst', 'R', 'RST: reset the connection (same as tcp.flags.reset).'],
    ['push', 'P', 'PSH: push buffered data to the application.'],
    ['ack', 'A', 'ACK: the acknowledgement number is valid.'],
    ['urg', 'U', 'URG: the urgent pointer is valid.'],
    ['ece', 'E', 'ECE: ECN echo.'],
    ['cwr', 'C', 'CWR: congestion window reduced.'],
  ];
  for (const [name, letter, help] of flags) {
    add(`tcp.flags.${name}`, ['tcp.flags'], 'bool', `TCP flag ${help} Compare with 1 or 0.`, derived('tcp', tcpFlag(letter)));
  }
  add('tcp.len', ['tcp'], 'number', 'TCP segment payload length, in bytes.', derived('tcp', (layer) => Math.max(0, layer.length - layer.headerLength - (layer.trailerLength ?? 0))));
  add('udp.len', ['udp'], 'number', 'UDP payload length, in bytes.', derived('udp', (layer) => Math.max(0, layer.length - layer.headerLength - (layer.trailerLength ?? 0))));
  add('dns.qry.name', ['dns.questions'], 'string', 'Name asked for in a DNS question, e.g. "www.lab.nf".', derived('dns', (layer) => dnsEntries(layer, 'questions').map((p) => p[0] as string)));
  add('dns.qry.type', ['dns.questions'], 'string', 'Record type asked for in a DNS question, e.g. "A" or "AAAA".', derived('dns', (layer) => dnsEntries(layer, 'questions').filter((p) => p.length > 1).map((p) => (p[1] as string).toUpperCase())));
  add('dns.resp.name', ['dns.answers'], 'string', 'Owner name of a DNS answer record.', derived('dns', (layer) => dnsEntries(layer, 'answers').map((p) => p[0] as string)));
  add('dns.a', ['dns.answers', 'dns.authorities', 'dns.additionals'], 'ipv4', 'IPv4 address carried by a DNS A record.', derived('dns', dnsAnswerData('A')));
  add('dns.aaaa', ['dns.answers', 'dns.authorities', 'dns.additionals'], 'ipv6', 'IPv6 address carried by a DNS AAAA record.', derived('dns', dnsAnswerData('AAAA')));
  add('dns.cname', ['dns.answers', 'dns.authorities', 'dns.additionals'], 'string', 'Canonical name carried by a DNS CNAME record.', derived('dns', dnsAnswerData('CNAME')));
  add('http.request', ['http.kind'], 'bool', 'The HTTP message is a request.', derived('http', httpKind('request')));
  add('http.response', ['http.kind'], 'bool', 'The HTTP message is a response.', derived('http', httpKind('response')));
  add('http.request.method', ['http.method'], 'string', 'Request method, e.g. "GET".', derived('http', httpKind('request', 'method')));
  add('http.request.version', ['http.version'], 'string', 'Version of an HTTP request.', derived('http', httpKind('request', 'version')));
  add('http.response.code', ['http.status'], 'number', 'Response status code, e.g. 200 or 404.', derived('http', httpKind('response', 'status')));
  add('http.response.version', ['http.version'], 'string', 'Version of an HTTP response.', derived('http', httpKind('response', 'version')));
  add('http.host', ['http.headers'], 'string', 'Value of the Host header.', derived('http', httpHeader('host')));
  add('http.content_type', ['http.headers'], 'string', 'Value of the Content-Type header.', derived('http', httpHeader('content-type')));
  add('http.server', ['http.headers'], 'string', 'Value of the Server header.', derived('http', httpHeader('server')));
  add('http.user_agent', ['http.headers'], 'string', 'Value of the User-Agent header.', derived('http', httpHeader('user-agent')));
  return out;
}

function buildRegistry(): DisplayFieldAccessor[] {
  const out: DisplayFieldAccessor[] = frameAccessors();
  for (const table of Object.values(PROTO_FIELDS)) {
    const proto = table.proto;
    out.push(protocolAccessor(def(proto, [proto], 'protocol', PROTOCOL_HELP[proto] ?? `The ${proto} protocol.`), proto));
    for (const spec of table.fields) {
      const path = `${proto}.${spec.name}`;
      out.push(canonicalAccessor(def(path, [path], mapFieldType(spec.type), spec.doc)));
    }
  }
  for (const a of PROTOCOL_ALIASES) {
    out.push(protocolAccessor(def(a.name, [a.proto], 'protocol', `${PROTOCOL_HELP[a.proto] ?? a.proto} Same as '${a.proto}'.`), a.proto));
  }
  for (const a of PLAIN_ALIASES) {
    const type = canonicalFieldType(a.reads[0] as string);
    out.push(canonicalAccessor(def(a.name, a.reads, type, a.help)));
  }
  out.push(...derivedAccessors());
  const seen = new Set<string>();
  for (const acc of out) {
    if (seen.has(acc.def.name)) throw new Error(`duplicate display filter field ${acc.def.name}`);
    seen.add(acc.def.name);
  }
  return out;
}

const REGISTRY: readonly DisplayFieldAccessor[] = Object.freeze(buildRegistry());
const BY_NAME: ReadonlyMap<string, DisplayFieldAccessor> = new Map(REGISTRY.map((a) => [a.def.name, a]));

/** Every display filter field, in registry order: frame.*, then each protocol with its canonical fields, then aliases. */
export const DISPLAY_FIELDS: readonly DisplayFieldDef[] = Object.freeze(REGISTRY.map((a) => a.def));

/** Definition of a display field by the name the user types, or undefined. Names are case-sensitive. */
export function lookupDisplayField(name: string): DisplayFieldDef | undefined {
  return BY_NAME.get(name)?.def;
}

/** Resolved accessor (definition + extractors) for a display field, or undefined. */
export function displayFieldAccessor(name: string): DisplayFieldAccessor | undefined {
  return BY_NAME.get(name);
}

// ── literal helpers shared by the parser and the evaluator ────────────────────

function parseHexGroup(g: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  return parseInt(g, 16);
}

/**
 * 16 bytes of an IPv6 address written in text (`::` compression, any case, dotted IPv4 tail), or null. Zone ids
 * and more than eight groups are rejected. Local to the filter so the pure entry needs no other module.
 */
export function parseFilterIpv6(text: string): Uint8Array | null {
  let s = text;
  if (s.length === 0 || s.includes('%')) return null;
  const words: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  if (s.slice(lastColon + 1).includes('.')) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.slice(lastColon + 1));
    if (!m) return null;
    const o = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
    if (o.some((x) => x > 255)) return null;
    const hi = (((o[0] as number) << 8) | (o[1] as number)).toString(16);
    const lo = (((o[2] as number) << 8) | (o[3] as number)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  const parseList = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      const v = parseHexGroup(g);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  if (dbl >= 0) {
    const head = parseList(s.slice(0, dbl));
    const rest = parseList(s.slice(dbl + 2));
    if (head === null || rest === null) return null;
    const used = head.length + rest.length;
    if (used > 7) return null;
    words.push(...head, ...new Array<number>(8 - used).fill(0), ...rest);
  } else {
    const all = parseList(s);
    if (all === null) return null;
    words.push(...all);
  }
  if (words.length !== 8) return null;
  const b = new Uint8Array(16);
  words.forEach((w, i) => {
    b[i * 2] = w >> 8;
    b[i * 2 + 1] = w & 0xff;
  });
  return b;
}

/** RFC 5952 text of 16 IPv6 bytes (lowercase, longest zero run of two or more groups compressed, first on ties). */
export function formatFilterIpv6(b: Uint8Array): string {
  const words: number[] = [];
  for (let i = 0; i < 8; i++) words.push(((b[i * 2] ?? 0) << 8) | (b[i * 2 + 1] ?? 0));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (ws: number[]): string => ws.map((w) => w.toString(16)).join(':');
  if (bestStart < 0) return hex(words);
  return `${hex(words.slice(0, bestStart))}::${hex(words.slice(bestStart + bestLen))}`;
}
