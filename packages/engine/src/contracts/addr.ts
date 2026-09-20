/**
 * Address representation and helpers used by every module.
 *
 * Canonical string forms are used in tables, config, PDU field views and the UI:
 *   MAC  → lowercase, colon-separated hex: `"00:1a:2b:3c:4d:5e"`
 *   IPv4 → dotted decimal: `"10.0.0.1"`
 *   IPv6 → RFC 5952 canonical text (P1): lowercase hex, no leading zeros, the longest run (≥ 2 groups;
 *          first on ties) of zero groups compressed to `::`, never an embedded dotted IPv4 tail on output.
 * Codecs convert to/from bytes at the wire boundary. Numeric (u32) forms are
 * used for prefix arithmetic (longest-prefix match).
 */

export type MacAddress = string; // canonical lowercase "aa:bb:cc:dd:ee:ff"
export type Ipv4Address = string; // canonical dotted "10.0.0.1"

export const MAC_BROADCAST: MacAddress = 'ff:ff:ff:ff:ff:ff';
export const MAC_ZERO: MacAddress = '00:00:00:00:00:00';

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const MAC_CISCO_RE = /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;

/** Accepts `aa:bb:cc:dd:ee:ff`, `aa-bb-...`, or dotted-quad `aabb.ccdd.eeff`; returns canonical form or null. */
export function normalizeMac(s: string): MacAddress | null {
  const t = s.trim().toLowerCase();
  if (MAC_RE.test(t)) return t.replace(/-/g, ':');
  if (MAC_CISCO_RE.test(t)) {
    const hex = t.replace(/\./g, '');
    return hex.match(/.{2}/g)!.join(':');
  }
  return null;
}

export function macToBytes(mac: MacAddress): Uint8Array {
  const n = normalizeMac(mac);
  if (!n) throw new Error(`invalid MAC ${mac}`);
  return new Uint8Array(n.split(':').map((h) => parseInt(h, 16)));
}

export function bytesToMac(b: Uint8Array, offset = 0): MacAddress {
  let out = '';
  for (let i = 0; i < 6; i++) {
    const v = b[offset + i];
    if (v === undefined) throw new RangeError('bytesToMac: buffer too short');
    out += (i ? ':' : '') + v.toString(16).padStart(2, '0');
  }
  return out;
}

/** Dotted-quad form used by `show mac address-table` style output: `aabb.ccdd.eeff`. */
export function macToDotted(mac: MacAddress): string {
  const hex = normalizeMac(mac)!.replace(/:/g, '');
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

export function isBroadcastMac(mac: MacAddress): boolean {
  return normalizeMac(mac) === MAC_BROADCAST;
}

/** Least-significant bit of the first octet set → group (multicast or broadcast). */
export function isMulticastMac(mac: MacAddress): boolean {
  const first = parseInt(normalizeMac(mac)!.slice(0, 2), 16);
  return (first & 1) === 1;
}

/** Second-least-significant bit of the first octet set → locally administered (every D8 NetForge MAC). */
export function isLocallyAdministeredMac(mac: MacAddress): boolean {
  const first = parseInt(normalizeMac(mac)!.slice(0, 2), 16);
  return (first & 2) === 2;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIpv4(s: string): number | null {
  const m = IPV4_RE.exec(s.trim());
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    v = (v << 8) | o;
  }
  return v >>> 0;
}

export function isIpv4(s: string): boolean {
  return parseIpv4(s) !== null;
}

export function ipv4ToU32(s: Ipv4Address): number {
  const v = parseIpv4(s);
  if (v === null) throw new Error(`invalid IPv4 address ${s}`);
  return v;
}

export function u32ToIpv4(v: number): Ipv4Address {
  v = v >>> 0;
  return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

export function ipv4ToBytes(s: Ipv4Address): Uint8Array {
  const v = ipv4ToU32(s);
  return new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

export function bytesToIpv4(b: Uint8Array, offset = 0): Ipv4Address {
  const a = b[offset], c = b[offset + 1], d = b[offset + 2], e = b[offset + 3];
  if (a === undefined || c === undefined || d === undefined || e === undefined) {
    throw new RangeError('bytesToIpv4: buffer too short');
  }
  return `${a}.${c}.${d}.${e}`;
}

/** Prefix length (0..32) for a contiguous dotted mask, or null if non-contiguous. */
export function maskToPrefixLen(mask: Ipv4Address): number | null {
  const v = parseIpv4(mask);
  if (v === null) return null;
  // contiguous ones followed by zeros
  const inv = ~v >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let n = 0;
  for (let i = 31; i >= 0; i--) {
    if ((v >>> i) & 1) n++;
    else break;
  }
  return n;
}

export function prefixLenToMaskU32(len: number): number {
  if (len < 0 || len > 32) throw new RangeError(`prefix length ${len}`);
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

export function prefixLenToMask(len: number): Ipv4Address {
  return u32ToIpv4(prefixLenToMaskU32(len));
}

/** Wildcard mask (inverse) for a prefix length. */
export function prefixLenToWildcard(len: number): Ipv4Address {
  return u32ToIpv4(~prefixLenToMaskU32(len) >>> 0);
}

export function networkOf(ip: Ipv4Address, prefixLen: number): Ipv4Address {
  return u32ToIpv4((ipv4ToU32(ip) & prefixLenToMaskU32(prefixLen)) >>> 0);
}

export function broadcastOf(ip: Ipv4Address, prefixLen: number): Ipv4Address {
  const m = prefixLenToMaskU32(prefixLen);
  return u32ToIpv4((ipv4ToU32(ip) | (~m >>> 0)) >>> 0);
}

export function inSubnet(ip: Ipv4Address, network: Ipv4Address, prefixLen: number): boolean {
  const m = prefixLenToMaskU32(prefixLen);
  return ((ipv4ToU32(ip) & m) >>> 0) === ((ipv4ToU32(network) & m) >>> 0);
}

/** `"10.0.0.0/24"` */
export function cidr(network: Ipv4Address, prefixLen: number): string {
  return `${networkOf(network, prefixLen)}/${prefixLen}`;
}

export function parseCidr(s: string): { network: Ipv4Address; prefixLen: number } | null {
  const m = /^(.+)\/(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const len = Number(m[2]);
  if (len > 32 || !isIpv4(m[1]!)) return null;
  return { network: networkOf(m[1]!, len), prefixLen: len };
}

export function isIpv4Broadcast(ip: Ipv4Address): boolean {
  return ip === '255.255.255.255';
}

export function isIpv4Multicast(ip: Ipv4Address): boolean {
  const v = ipv4ToU32(ip);
  return v >>> 28 === 0xe; // 224.0.0.0/4
}

export function isIpv4Loopback(ip: Ipv4Address): boolean {
  return ipv4ToU32(ip) >>> 24 === 127;
}

// ── IPv6 and dual stack (P1) ─────────────────────────────────────────────────

/** RFC 5952 canonical IPv6 text (see file header). The ONLY IPv6 form stored in tables, config, PortL3 and codec fields. */
export type Ipv6Address = string;
export type IpAddress = Ipv4Address | Ipv6Address;
export type IpFamily = 4 | 6;

export const IPV4_ANY: Ipv4Address = '0.0.0.0';
export const IPV4_BROADCAST: Ipv4Address = '255.255.255.255';
export const IPV6_ANY: Ipv6Address = '::';
export const IPV6_LOOPBACK: Ipv6Address = '::1';
export const IPV6_ALL_NODES: Ipv6Address = 'ff02::1';
export const IPV6_ALL_ROUTERS: Ipv6Address = 'ff02::2';

export type Ipv6Scope = 'unspecified' | 'loopback' | 'link-local' | 'unique-local' | 'global' | 'multicast' | 'ipv4-mapped' | 'documentation';

/**
 * @since P1 Signatures of the IPv6 / dual-stack / IPv4-extra helpers implemented (pure, no engine state) by
 * `core/addr6.ts` and re-exported from the engine entry and the `@netforge/engine/pure` entry. Each
 * export is declared `export const name: AddrHelpersV6['name'] = …` so the signature is compile-checked.
 * Consumers: codecs, ipv6/nd daemons, CLI arg validation, subnetting workbench and IPv6 explorer.
 */
export interface AddrHelpersV6 {
  /** 16 bytes, or null. Accepts `::` forms, upper case and an embedded dotted IPv4 tail; rejects zone ids and > 8 groups. */
  parseIpv6(s: string): Uint8Array | null;
  isIpv6(s: string): boolean;
  /** Canonical RFC 5952 text, or null when invalid. Every ingress (codec decode, CLI arg, config replay, GUI) normalises through it. */
  normalizeIpv6(s: string): Ipv6Address | null;
  /** @throws on invalid input */
  ipv6ToBytes(a: Ipv6Address): Uint8Array;
  bytesToIpv6(b: Uint8Array, offset?: number): Ipv6Address;
  /** Fully expanded 8 × 4-hex groups (IPv6 explorer). */
  expandIpv6(a: Ipv6Address): string;
  ipFamily(s: string): IpFamily | null;
  /** IPv4 dotted or canonical IPv6, or null. */
  normalizeIp(s: string): IpAddress | null;
  ipv6NetworkOf(a: Ipv6Address, prefixLen: number): Ipv6Address;
  inSubnet6(a: Ipv6Address, network: Ipv6Address, prefixLen: number): boolean;
  parseCidr6(s: string): { network: Ipv6Address; prefixLen: number } | null;
  cidr6(network: Ipv6Address, prefixLen: number): string;
  /** Number of leading equal bits (source selection). */
  commonPrefixLen6(a: Ipv6Address, b: Ipv6Address): number;
  ipv6Scope(a: Ipv6Address): Ipv6Scope;
  /** Modified EUI-64 interface id (insert ff:fe, flip the U/L bit): 8 bytes. */
  eui64InterfaceId(mac: MacAddress): Uint8Array;
  /** fe80::/64 + EUI-64. */
  linkLocalFromMac(mac: MacAddress): Ipv6Address;
  /** prefix (/64 only) + EUI-64; null when prefixLen !== 64. */
  eui64Address(prefix: Ipv6Address, prefixLen: number, mac: MacAddress): Ipv6Address | null;
  /** ff02::1:ffXX:XXXX from the low 24 bits. */
  solicitedNodeMulticast(a: Ipv6Address): Ipv6Address;
  /** 33:33 + low 32 bits. */
  ipv6MulticastMac(a: Ipv6Address): MacAddress;
  /** 01:00:5e + low 23 bits. */
  ipv4MulticastMac(a: Ipv4Address): MacAddress;
  isIpv4Unspecified(a: Ipv4Address): boolean;
  /** 169.254.0.0/16 (APIPA). */
  isIpv4LinkLocal(a: Ipv4Address): boolean;
  /** RFC 1918. */
  isIpv4Private(a: Ipv4Address): boolean;
  ipv4Class(a: Ipv4Address): 'A' | 'B' | 'C' | 'D' | 'E';
  usableHostRange(ip: Ipv4Address, prefixLen: number): { network: Ipv4Address; broadcast: Ipv4Address; first: Ipv4Address; last: Ipv4Address; count: number } | null;
  /** '10.0.0.1:80' or '[2001:db8::1]:80'; no port → bare address. */
  formatEndpoint(addr: IpAddress, port?: number): string;
  /**
   * Central flow-key format (colour by conversation):
   *   icmp : 'ipv4:10.0.0.1>10.0.0.2:icmp' (identical to P0), 'ipv6:[2001:db8::1]>[2001:db8::2]:icmpv6'
   *   ports: 'ipv4:10.0.0.1:49152>10.0.0.2:80:tcp', 'ipv6:[fe80::1]:546>[ff02::1:2]:547:udp'
   */
  flowKey(family: IpFamily, src: IpAddress, dst: IpAddress, proto: string, srcPort?: number, dstPort?: number): string;
}

// ── MAC derivation ───────────────────────────────────────────────────────────

/** @since P0.5 First octet of every D8 NetForge MAC: locally administered, unicast. */
export const NF_MAC_BYTE0 = 0x02;

/** @since P0.5 FNV-1a 32-bit over UTF-16 code units (low byte then high byte). Pure integer maths. */
export function macHash32(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193);
    h = Math.imul(h ^ ((c >>> 8) & 0xff), 0x01000193);
  }
  return h >>> 0;
}

/**
 * @since P0.5 (D8) Per-device 32-bit MAC base, independent of the simulation seed and of creation order.
 * `salt` > 0 only after a base collision inside one world (bumped in world-insertion order and persisted as
 * `hardware.macSalt`). Vectors: 'd_0001' → 0x4e59e8af; 'd_0002' → 0xdc527974; 'pc1' → 0x56459757;
 * 'sw1' → 0xe76329c8; ('d_0001', 1) → 0xd21db925.
 */
export function deviceMacBase(id: string, salt = 0): number {
  return macHash32(salt === 0 ? id : `${id}#${salt}`);
}

/**
 * @since P0.5 (D8) `02:b3:b2:b1:b0:ordinal`. Ordinal 0 = the device base MAC (SVIs, loopbacks); fixed ports 1..127;
 * module ports 128 + slotIndex×16 + i. Vector: portMac(deviceMacBase('d_0001'), 1) = '02:4e:59:e8:af:01'.
 */
export function portMac(base: number, ordinal: number): MacAddress {
  const hex = (v: number): string => (v & 0xff).toString(16).padStart(2, '0');
  const b = base >>> 0;
  return `${hex(NF_MAC_BYTE0)}:${hex(b >>> 24)}:${hex(b >>> 16)}:${hex(b >>> 8)}:${hex(b)}:${hex(ordinal)}`;
}

/** @since P0.5 BSSID of BSS `bssIndex` (0..15) on a radio: the high nibble of octet 0 carries the index (BSS 0 = the radio MAC). */
export function bssidFor(radioMac: MacAddress, bssIndex: number): MacAddress {
  const first = (NF_MAC_BYTE0 | ((bssIndex & 0x0f) << 4)).toString(16).padStart(2, '0');
  return `${first}${radioMac.slice(2)}`;
}
