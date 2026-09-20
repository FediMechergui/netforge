/**
 * core/addr6.ts — IPv6, dual-stack and IPv4-extra address helpers (P1, `AddrHelpersV6`).
 *
 * Pure functions with no engine state. Every export is typed as `AddrHelpersV6['name']` so the
 * signature is compile-checked against the contract.
 *
 * IPv6 text rules:
 *   - input (RFC 4291 §2.2): 1–4 hex digits per group, upper or lower case, at most one `::` (standing
 *     for one or more zero groups), an optional embedded dotted IPv4 tail counting as two groups.
 *     Zone ids (`%eth0`), whitespace inside the address and more than 8 groups are rejected.
 *   - output (RFC 5952 §4): lowercase, no leading zeros, the longest run of two or more zero groups
 *     compressed to `::` (the first run wins a tie), a single zero group written `0`, and never an
 *     embedded dotted IPv4 tail.
 */
import {
  normalizeMac,
  parseIpv4,
  prefixLenToMaskU32,
  u32ToIpv4,
  type AddrHelpersV6,
  type IpAddress,
  type IpFamily,
  type Ipv4Address,
  type Ipv6Address,
  type Ipv6Scope,
  type MacAddress,
} from '../contracts/addr.js';

const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;
const IPV6_CHARS_RE = /^[0-9a-f:.]+$/i;

/** Parses one colon-separated segment into 16-bit words; the last part may be a dotted IPv4 tail when allowed. */
function parseSegment(seg: string, allowIpv4Tail: boolean): number[] | null {
  if (seg === '') return [];
  const parts = seg.split(':');
  const words: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.includes('.')) {
      if (!allowIpv4Tail || i !== parts.length - 1) return null;
      const v4 = parseIpv4(p);
      if (v4 === null) return null;
      words.push(v4 >>> 16, v4 & 0xffff);
      continue;
    }
    if (!HEX_GROUP_RE.test(p)) return null;
    words.push(parseInt(p, 16));
  }
  return words;
}

/** Eight 16-bit words → 16 bytes. */
function wordsToBytes(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const w = words[i]!;
    out[i * 2] = (w >>> 8) & 0xff;
    out[i * 2 + 1] = w & 0xff;
  }
  return out;
}

/** 16 bytes starting at `offset` → eight 16-bit words. */
function bytesToWords(b: Uint8Array, offset: number): number[] {
  const words: number[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = b[offset + i * 2];
    const lo = b[offset + i * 2 + 1];
    if (hi === undefined || lo === undefined) throw new RangeError('bytesToIpv6: buffer too short');
    words.push((hi << 8) | lo);
  }
  return words;
}

/** RFC 5952 text of eight words. */
function formatWords(words: readonly number[]): Ipv6Address {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && words[i] === 0) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestStart = runStart;
        bestLen = len;
      }
      runStart = -1;
    }
  }
  const hex = (from: number, to: number): string =>
    words.slice(from, to).map((w) => w.toString(16)).join(':');
  if (bestLen < 2) return hex(0, 8);
  return `${hex(0, bestStart)}::${hex(bestStart + bestLen, 8)}`;
}

/** Validates an IPv6 prefix length. */
function checkPrefixLen6(prefixLen: number): void {
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) {
    throw new RangeError(`IPv6 prefix length ${prefixLen}`);
  }
}

/** Copy of `bytes` with every bit after the first `prefixLen` cleared. */
function maskBytes(bytes: Uint8Array, prefixLen: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const bits = prefixLen - i * 8;
    const m = bits >= 8 ? 0xff : bits <= 0 ? 0 : (0xff << (8 - bits)) & 0xff;
    out[i] = bytes[i]! & m;
  }
  return out;
}

/** Two lowercase hex digits. */
function hex2(v: number): string {
  return (v & 0xff).toString(16).padStart(2, '0');
}

/**
 * Parses IPv6 text into 16 bytes, or null. Accepts `::` forms, upper case and an embedded dotted IPv4
 * tail; rejects zone ids, whitespace, more than one `::` and more than 8 groups.
 */
export const parseIpv6: AddrHelpersV6['parseIpv6'] = (s) => {
  const t = s.trim();
  if (t === '' || !IPV6_CHARS_RE.test(t)) return null;
  const dbl = t.indexOf('::');
  if (dbl < 0) {
    const words = parseSegment(t, true);
    if (words === null || words.length !== 8) return null;
    return wordsToBytes(words);
  }
  if (t.indexOf('::', dbl + 1) >= 0) return null;
  const head = parseSegment(t.slice(0, dbl), false);
  const tail = parseSegment(t.slice(dbl + 2), true);
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  const words = [...head];
  for (let i = 0; i < fill; i++) words.push(0);
  words.push(...tail);
  return wordsToBytes(words);
};

/** True when `s` parses as an IPv6 address. */
export const isIpv6: AddrHelpersV6['isIpv6'] = (s) => parseIpv6(s) !== null;

/** Canonical RFC 5952 text of `s`, or null when it is not a valid IPv6 address. */
export const normalizeIpv6: AddrHelpersV6['normalizeIpv6'] = (s) => {
  const b = parseIpv6(s);
  return b === null ? null : formatWords(bytesToWords(b, 0));
};

/** 16 bytes of an IPv6 address. @throws on invalid input. */
export const ipv6ToBytes: AddrHelpersV6['ipv6ToBytes'] = (a) => {
  const b = parseIpv6(a);
  if (b === null) throw new Error(`invalid IPv6 address ${a}`);
  return b;
};

/** Canonical text of the 16 bytes at `offset`. @throws RangeError when the buffer is too short. */
export const bytesToIpv6: AddrHelpersV6['bytesToIpv6'] = (b, offset = 0) => formatWords(bytesToWords(b, offset));

/** Fully expanded form: 8 groups of 4 lowercase hex digits. @throws on invalid input. */
export const expandIpv6: AddrHelpersV6['expandIpv6'] = (a) =>
  bytesToWords(ipv6ToBytes(a), 0).map((w) => w.toString(16).padStart(4, '0')).join(':');

/** 4 for dotted IPv4, 6 for IPv6 text, null otherwise. */
export const ipFamily: AddrHelpersV6['ipFamily'] = (s): IpFamily | null => {
  if (parseIpv4(s) !== null) return 4;
  if (parseIpv6(s) !== null) return 6;
  return null;
};

/** Canonical dotted IPv4 or canonical RFC 5952 IPv6, or null. */
export const normalizeIp: AddrHelpersV6['normalizeIp'] = (s): IpAddress | null => {
  const v4 = parseIpv4(s);
  if (v4 !== null) return u32ToIpv4(v4);
  return normalizeIpv6(s);
};

/** Network address of `a` under `prefixLen` (0..128). @throws on an invalid address or prefix length. */
export const ipv6NetworkOf: AddrHelpersV6['ipv6NetworkOf'] = (a, prefixLen) => {
  checkPrefixLen6(prefixLen);
  return bytesToIpv6(maskBytes(ipv6ToBytes(a), prefixLen));
};

/** True when `a` and `network` agree on the first `prefixLen` bits. @throws on invalid input. */
export const inSubnet6: AddrHelpersV6['inSubnet6'] = (a, network, prefixLen) => {
  checkPrefixLen6(prefixLen);
  const x = maskBytes(ipv6ToBytes(a), prefixLen);
  const y = maskBytes(ipv6ToBytes(network), prefixLen);
  for (let i = 0; i < 16; i++) if (x[i] !== y[i]) return false;
  return true;
};

/** `"2001:db8::1/64"` → `{ network: '2001:db8::', prefixLen: 64 }`, or null when invalid. */
export const parseCidr6: AddrHelpersV6['parseCidr6'] = (s) => {
  const m = /^(.+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const len = Number(m[2]);
  if (len > 128) return null;
  const b = parseIpv6(m[1]!);
  if (b === null) return null;
  return { network: bytesToIpv6(maskBytes(b, len)), prefixLen: len };
};

/** `"2001:db8::/64"`: the canonical network of `network` under `prefixLen`, slash, length. */
export const cidr6: AddrHelpersV6['cidr6'] = (network, prefixLen) => `${ipv6NetworkOf(network, prefixLen)}/${prefixLen}`;

/** Number of leading bits (0..128) on which `a` and `b` agree. @throws on invalid input. */
export const commonPrefixLen6: AddrHelpersV6['commonPrefixLen6'] = (a, b) => {
  const x = ipv6ToBytes(a);
  const y = ipv6ToBytes(b);
  for (let i = 0; i < 16; i++) {
    const d = x[i]! ^ y[i]!;
    if (d !== 0) return i * 8 + (Math.clz32(d) - 24);
  }
  return 128;
};

/**
 * Address scope class: `::` unspecified, `::1` loopback, ff00::/8 multicast, fe80::/10 link-local,
 * fc00::/7 unique-local, ::ffff:0:0/96 ipv4-mapped, 2001:db8::/32 documentation, anything else global.
 * @throws on invalid input.
 */
export const ipv6Scope: AddrHelpersV6['ipv6Scope'] = (a): Ipv6Scope => {
  const b = ipv6ToBytes(a);
  let zeroPrefix = 0;
  while (zeroPrefix < 16 && b[zeroPrefix] === 0) zeroPrefix++;
  if (zeroPrefix === 16) return 'unspecified';
  if (zeroPrefix === 15 && b[15] === 1) return 'loopback';
  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local';
  if ((b[0]! & 0xfe) === 0xfc) return 'unique-local';
  if (zeroPrefix >= 10 && b[10] === 0xff && b[11] === 0xff) return 'ipv4-mapped';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation';
  return 'global';
};

/** Modified EUI-64 interface id (RFC 4291 App. A): insert ff:fe in the middle and flip the U/L bit. @throws on an invalid MAC. */
export const eui64InterfaceId: AddrHelpersV6['eui64InterfaceId'] = (mac) => {
  const n = normalizeMac(mac);
  if (n === null) throw new Error(`invalid MAC ${mac}`);
  const m = n.split(':').map((h) => parseInt(h, 16));
  return new Uint8Array([m[0]! ^ 0x02, m[1]!, m[2]!, 0xff, 0xfe, m[3]!, m[4]!, m[5]!]);
};

/** fe80::/64 plus the modified EUI-64 interface id of `mac`. @throws on an invalid MAC. */
export const linkLocalFromMac: AddrHelpersV6['linkLocalFromMac'] = (mac) => {
  const b = new Uint8Array(16);
  b[0] = 0xfe;
  b[1] = 0x80;
  b.set(eui64InterfaceId(mac), 8);
  return bytesToIpv6(b);
};

/** The first 64 bits of `prefix` plus the EUI-64 id of `mac`; null when `prefixLen` is not 64. @throws on invalid input. */
export const eui64Address: AddrHelpersV6['eui64Address'] = (prefix, prefixLen, mac) => {
  if (prefixLen !== 64) return null;
  const b = new Uint8Array(16);
  b.set(ipv6ToBytes(prefix).subarray(0, 8), 0);
  b.set(eui64InterfaceId(mac), 8);
  return bytesToIpv6(b);
};

/** Solicited-node multicast group (RFC 4291 §2.7.1): ff02::1:ff00:0/104 plus the low 24 bits of `a`. @throws on invalid input. */
export const solicitedNodeMulticast: AddrHelpersV6['solicitedNodeMulticast'] = (a) => {
  const src = ipv6ToBytes(a);
  const b = new Uint8Array(16);
  b[0] = 0xff;
  b[1] = 0x02;
  b[11] = 0x01;
  b[12] = 0xff;
  b[13] = src[13]!;
  b[14] = src[14]!;
  b[15] = src[15]!;
  return bytesToIpv6(b);
};

/** Ethernet group address of an IPv6 multicast (RFC 2464 §7): 33:33 plus the low 32 bits. @throws on invalid input. */
export const ipv6MulticastMac: AddrHelpersV6['ipv6MulticastMac'] = (a): MacAddress => {
  const b = ipv6ToBytes(a);
  return `33:33:${hex2(b[12]!)}:${hex2(b[13]!)}:${hex2(b[14]!)}:${hex2(b[15]!)}`;
};

/** Ethernet group address of an IPv4 multicast (RFC 1112 §6.4): 01:00:5e plus the low 23 bits. @throws on invalid input. */
export const ipv4MulticastMac: AddrHelpersV6['ipv4MulticastMac'] = (a): MacAddress => {
  const v = parseIpv4(a);
  if (v === null) throw new Error(`invalid IPv4 address ${a}`);
  return `01:00:5e:${hex2((v >>> 16) & 0x7f)}:${hex2(v >>> 8)}:${hex2(v)}`;
};

/** True for 0.0.0.0 (in any valid dotted spelling); false for anything else, including invalid text. */
export const isIpv4Unspecified: AddrHelpersV6['isIpv4Unspecified'] = (a) => parseIpv4(a) === 0;

/** True inside 169.254.0.0/16 (APIPA, RFC 3927); false for invalid text. */
export const isIpv4LinkLocal: AddrHelpersV6['isIpv4LinkLocal'] = (a) => {
  const v = parseIpv4(a);
  return v !== null && v >>> 16 === 0xa9fe;
};

/** True inside an RFC 1918 block (10/8, 172.16/12, 192.168/16); false for invalid text. */
export const isIpv4Private: AddrHelpersV6['isIpv4Private'] = (a) => {
  const v = parseIpv4(a);
  if (v === null) return false;
  return v >>> 24 === 10 || v >>> 20 === 0xac1 || v >>> 16 === 0xc0a8;
};

/** Classful class from the leading bits of the first octet. @throws on invalid input. */
export const ipv4Class: AddrHelpersV6['ipv4Class'] = (a) => {
  const v = parseIpv4(a);
  if (v === null) throw new Error(`invalid IPv4 address ${a}`);
  const first = v >>> 24;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D';
  return 'E';
};

/**
 * Network, broadcast and usable host range of `ip/prefixLen`, or null for invalid input.
 * /0–/30: first = network + 1, last = broadcast − 1, count = 2^(32−len) − 2.
 * /31 (RFC 3021 point-to-point): both addresses usable, count 2. /32: the single host, count 1.
 */
export const usableHostRange: AddrHelpersV6['usableHostRange'] = (ip, prefixLen) => {
  const v = parseIpv4(ip);
  if (v === null || !Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;
  const mask = prefixLenToMaskU32(prefixLen);
  const net = (v & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  const network: Ipv4Address = u32ToIpv4(net);
  const broadcast: Ipv4Address = u32ToIpv4(bcast);
  if (prefixLen >= 31) {
    return { network, broadcast, first: network, last: broadcast, count: prefixLen === 32 ? 1 : 2 };
  }
  return {
    network,
    broadcast,
    first: u32ToIpv4(net + 1),
    last: u32ToIpv4(bcast - 1),
    count: 2 ** (32 - prefixLen) - 2,
  };
};

/** Text of an address in brackets when it is IPv6 (normalised when valid). */
function bracketed(addr: IpAddress): string {
  if (!addr.includes(':')) return addr;
  return `[${normalizeIpv6(addr) ?? addr}]`;
}

/** `'10.0.0.1:80'` or `'[2001:db8::1]:80'`; without a port, the bare address. */
export const formatEndpoint: AddrHelpersV6['formatEndpoint'] = (addr, port) => {
  if (port === undefined) return addr.includes(':') ? normalizeIpv6(addr) ?? addr : addr;
  return `${bracketed(addr)}:${port}`;
};

/**
 * Conversation key used to colour flows:
 *   `'ipv4:10.0.0.1>10.0.0.2:icmp'`, `'ipv6:[2001:db8::1]>[2001:db8::2]:icmpv6'`,
 *   `'ipv4:10.0.0.1:49152>10.0.0.2:80:tcp'`, `'ipv6:[fe80::1]:546>[ff02::1:2]:547:udp'`.
 * IPv6 addresses are always bracketed (and normalised when valid); a port is appended to its address when given.
 */
export const flowKey: AddrHelpersV6['flowKey'] = (family, src, dst, proto, srcPort, dstPort) => {
  const ep = (a: IpAddress, port: number | undefined): string => {
    const text = family === 6 ? `[${normalizeIpv6(a) ?? a}]` : a;
    return port === undefined ? text : `${text}:${port}`;
  };
  return `ipv${family}:${ep(src, srcPort)}>${ep(dst, dstPort)}:${proto}`;
};

/** Every helper as one object, compile-checked against the full `AddrHelpersV6` contract. */
export const addrHelpersV6: AddrHelpersV6 = {
  parseIpv6,
  isIpv6,
  normalizeIpv6,
  ipv6ToBytes,
  bytesToIpv6,
  expandIpv6,
  ipFamily,
  normalizeIp,
  ipv6NetworkOf,
  inSubnet6,
  parseCidr6,
  cidr6,
  commonPrefixLen6,
  ipv6Scope,
  eui64InterfaceId,
  linkLocalFromMac,
  eui64Address,
  solicitedNodeMulticast,
  ipv6MulticastMac,
  ipv4MulticastMac,
  isIpv4Unspecified,
  isIpv4LinkLocal,
  isIpv4Private,
  ipv4Class,
  usableHostRange,
  formatEndpoint,
  flowKey,
};
