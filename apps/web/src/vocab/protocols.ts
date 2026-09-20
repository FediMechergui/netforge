/**
 * Protocol vocabulary: one typed source for protocol names, packet shapes, badge letters, colours and
 * layer classes (ARCHITECTURE-P1 §7 "Vocabulary"). The canvas packet layer, the packet inspector, the
 * provenance chips, the hex view legend and the sim-mode filter chips all read this table.
 *
 * Every protocol has a non-colour channel (§7): the pair (shape, letter) is unique, and letters are unique
 * on their own, so two protocols never look alike when colour is not perceived. P0 shapes are kept:
 * ARP diamond, ICMPv4 capsule, everything else of P0 a hexagon.
 *
 * `PROTOCOL_VOCAB` is keyed by every literal member of the engine's `ProtoName`, so adding a protocol to the
 * contract is a compile error here until it gets a vocabulary entry. All wording is original (§1.6).
 */
import type { BuildStage, ProtoName } from '@netforge/engine';
import type { ThemeColors } from '../canvas/scene.js';

/** Theme colour keys a vocabulary entry may name (resolved to numbers by the canvas theme). */
export type ColorToken = Extract<keyof ThemeColors, 'text' | 'textDim' | 'accent' | 'ok' | 'warn' | 'err' | 'purple' | 'yellow' | 'blueDeep'>;

type LiteralMember<T> = T extends string ? (string extends T ? never : T) : never;

/** The closed set of protocol names the engine knows (the literal members of `ProtoName`). */
export type KnownProto = LiteralMember<ProtoName>;

/** Packet glyph shapes the canvas can draw. */
export const PACKET_SHAPES = ['diamond', 'capsule', 'ring-capsule', 'hexagon', 'octagon', 'square', 'triangle', 'circle', 'pentagon'] as const;
/** One packet glyph shape. */
export type PacketShape = (typeof PACKET_SHAPES)[number];

/** Where a protocol sits in the stack (used to group filter chips and legend rows). */
export type ProtocolLayer = 'link' | 'framing' | 'network' | 'control' | 'transport' | 'application' | 'data';

/** Presentation data for one protocol. */
export interface ProtocolVocab {
  readonly proto: string;
  /** Display name. */
  readonly label: string;
  /** Badge letter(s) drawn on the packet glyph; unique across protocols. */
  readonly letter: string;
  readonly shape: PacketShape;
  readonly color: ColorToken;
  readonly layer: ProtocolLayer;
  readonly since: BuildStage;
  /** One-sentence explanation for tooltips. */
  readonly hint: string;
  /** CSS class carrying the layer tint in inspector views. */
  readonly className: string;
  /** Framing glue that is skipped when naming the meaningful protocol of a frame. */
  readonly transparent?: boolean;
}

function entry(
  proto: KnownProto,
  label: string,
  letter: string,
  shape: PacketShape,
  color: ColorToken,
  layer: ProtocolLayer,
  since: BuildStage,
  hint: string,
  transparent?: boolean,
): ProtocolVocab {
  const base = { proto, label, letter, shape, color, layer, since, hint, className: `p-${proto}` };
  return Object.freeze(transparent ? { ...base, transparent } : base);
}

/** Every known protocol, exhaustive over the literal members of `ProtoName`. */
export const PROTOCOL_VOCAB: Readonly<Record<KnownProto, ProtocolVocab>> = Object.freeze({
  ethernet: entry('ethernet', 'Ethernet', 'E', 'hexagon', 'textDim', 'link', 'P0', 'Wired LAN frame addressed from one MAC address to another.'),
  arp: entry('arp', 'ARP', 'A', 'diamond', 'yellow', 'control', 'P0', 'Asks which MAC address owns an IPv4 address on the local network.'),
  ipv4: entry('ipv4', 'IPv4', '4', 'hexagon', 'ok', 'network', 'P0', 'Carries data between networks using 32-bit addresses.'),
  icmpv4: entry('icmpv4', 'ICMP', 'I', 'capsule', 'accent', 'control', 'P0', 'Echo tests and error reports that travel alongside IPv4.'),
  udp: entry('udp', 'UDP', 'U', 'triangle', 'purple', 'transport', 'P0', 'Single datagrams between ports, with no delivery guarantee.'),
  tcp: entry('tcp', 'TCP', 'T', 'square', 'purple', 'transport', 'P0', 'A reliable, ordered byte stream between two ports.'),
  payload: entry('payload', 'Data', 'D', 'hexagon', 'text', 'data', 'P0', 'Bytes that no decoder interprets any further.'),
  hdlc: entry('hdlc', 'HDLC', 'H', 'hexagon', 'err', 'link', 'P0.5', 'Framing used on serial lines between routers; it carries no MAC addresses.'),
  dot11: entry('dot11', '802.11', 'W', 'circle', 'blueDeep', 'link', 'P0.5', 'Wireless LAN frame exchanged over the air between a station and an access point.'),
  'dot11-mgmt': entry('dot11-mgmt', '802.11 management', 'M', 'circle', 'blueDeep', 'control', 'P0.5', 'Scanning, authentication and association messages of a wireless network.'),
  llc: entry('llc', 'LLC/SNAP', 'L', 'hexagon', 'textDim', 'framing', 'P0.5', 'Short header naming the payload type inside a wireless data frame.', true),
  eapol: entry('eapol', 'EAPOL key', 'K', 'diamond', 'warn', 'control', 'P0.5', 'Key handshake that authorises a wireless station before it may send data.'),
  ipv6: entry('ipv6', 'IPv6', '6', 'octagon', 'ok', 'network', 'P1', 'Carries data between networks using 128-bit addresses.'),
  'ipv6-hopopts': entry('ipv6-hopopts', 'IPv6 hop-by-hop options', 'HB', 'octagon', 'textDim', 'network', 'P1', 'Options every router on the path is asked to examine.'),
  'ipv6-route': entry('ipv6-route', 'IPv6 routing header', 'RH', 'octagon', 'textDim', 'network', 'P1', 'Lists intermediate stops the sender requested.'),
  'ipv6-frag': entry('ipv6-frag', 'IPv6 fragment header', 'FH', 'octagon', 'textDim', 'network', 'P1', 'Marks one piece of a packet the sender split up.'),
  'ipv6-dstopts': entry('ipv6-dstopts', 'IPv6 destination options', 'DO', 'octagon', 'textDim', 'network', 'P1', 'Options meant only for the final receiver.'),
  icmpv6: entry('icmpv6', 'ICMPv6', 'I6', 'ring-capsule', 'accent', 'control', 'P1', 'Echo tests, error reports and neighbour discovery for IPv6.'),
  dhcp: entry('dhcp', 'DHCP', 'DH', 'capsule', 'yellow', 'application', 'P1', 'Hands out addresses, gateways and name servers to hosts that ask.'),
  dns: entry('dns', 'DNS', 'N', 'capsule', 'warn', 'application', 'P1', 'Turns host names into addresses.'),
  http: entry('http', 'HTTP', 'HT', 'pentagon', 'accent', 'application', 'P1', 'Requests and responses of web pages.'),
});

/** Known protocol names in table order. */
export const KNOWN_PROTOS: readonly KnownProto[] = Object.freeze(Object.keys(PROTOCOL_VOCAB) as KnownProto[]);

/** Presentation of a reserved protocol: its port is registered but it decodes as raw data (D1). */
export interface ReservedProtocolVocab {
  readonly proto: string;
  readonly label: string;
  readonly hint: string;
}

const RESERVED_HINT = 'Reserved name: this release shows its traffic as raw data.';

function reserved(proto: string, label: string): ReservedProtocolVocab {
  return Object.freeze({ proto, label, hint: RESERVED_HINT });
}

/** Reserved protocols listed in the engine dispatch table. */
export const RESERVED_PROTOCOL_VOCAB: Readonly<Record<string, ReservedProtocolVocab>> = Object.freeze({
  tftp: reserved('tftp', 'TFTP'),
  ntp: reserved('ntp', 'NTP'),
  snmp: reserved('snmp', 'SNMP'),
  syslog: reserved('syslog', 'Syslog'),
  ftp: reserved('ftp', 'FTP'),
  ssh: reserved('ssh', 'SSH'),
  telnet: reserved('telnet', 'Telnet'),
  smtp: reserved('smtp', 'SMTP'),
  pop3: reserved('pop3', 'POP3'),
  imap: reserved('imap', 'IMAP'),
});

/** Human names of the protocol layers. */
export const PROTOCOL_LAYER_LABELS: Readonly<Record<ProtocolLayer, string>> = Object.freeze({
  link: 'Link',
  framing: 'Framing',
  network: 'Network',
  control: 'Control',
  transport: 'Transport',
  application: 'Application',
  data: 'Data',
});

/** Fallback used for protocol names outside the known set (plugins, unexpected input). */
export const GENERIC_PROTOCOL: ProtocolVocab = Object.freeze({
  proto: 'other',
  label: 'Other',
  letter: '?',
  shape: 'hexagon',
  color: 'warn',
  layer: 'data',
  since: 'P0',
  hint: 'A protocol this view has no description for.',
  className: 'p-other',
});

/** True when `proto` names a protocol of the known set. */
export function isKnownProto(proto: string): proto is KnownProto {
  return Object.prototype.hasOwnProperty.call(PROTOCOL_VOCAB, proto);
}

/** Vocabulary entry of a protocol, or `GENERIC_PROTOCOL` for unknown names. */
export function protocolVocab(proto: string): ProtocolVocab {
  return isKnownProto(proto) ? PROTOCOL_VOCAB[proto] : GENERIC_PROTOCOL;
}

/** Display name of any protocol name (known, reserved, or the raw name itself). */
export function protocolLabel(proto: string): string {
  if (isKnownProto(proto)) return PROTOCOL_VOCAB[proto].label;
  const r = RESERVED_PROTOCOL_VOCAB[proto];
  return r ? r.label : proto;
}

/** Packet glyph shape for a protocol. */
export function packetShapeFor(proto: string): PacketShape {
  return protocolVocab(proto).shape;
}

/** Badge letter(s) for a protocol. */
export function protocolLetter(proto: string): string {
  return protocolVocab(proto).letter;
}

/** CSS class for a protocol's tint (`p-other` when unknown). */
export function protocolClassName(proto: string): string {
  return protocolVocab(proto).className;
}
