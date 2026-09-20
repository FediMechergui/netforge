/**
 * DHCPv4 codec (BOOTP layout RFC 951/1542, DHCP RFC 2131, options RFC 2132) — ARCHITECTURE-P1 §4.3,
 * contracts/fields.ts `dhcp`.
 *
 * Wire image: `op(1) htype(1) hlen(1) hops(1) xid(4) secs(2) flags(2) ciaddr(4) yiaddr(4) siaddr(4) giaddr(4)
 * chaddr(16) sname(64) file(128) magic(4 = 99.130.83.99) options... end(255)` — 240 bytes before the options.
 *  • `broadcastFlag` is bit 15 of `flags`. `chaddr` is the first 6 bytes of the 16-byte field (Ethernet); `sname`
 *    and `file` decode as NUL-terminated text (decode-only; encoded as zeros).
 *  • Options mapped to fields: 53 messageType (DISCOVER…INFORM), 50 requestedIp, 54 serverId, 51 leaseTimeS,
 *    58 renewalTimeS, 59 rebindingTimeS, 1 subnetMask, 3 router (the first address; encode writes one),
 *    6 dnsServers (comma-separated), 15 domainName, 12 hostname, 55 parameterRequestList (comma-separated
 *    codes), 61 clientId (hex). Other options are skipped on decode. Pad (0) is skipped; End (255) stops.
 *  • Encode writes the options in the fixed order 53, 54, 50, 51, 58, 59, 1, 3, 6, 15, 12, 61, 55, then End, and
 *    pads the message with zero bytes to the 300-byte BOOTP minimum (RFC 1542 §2.1).
 *  • Decode errors: fewer than 236 bytes (fixed header truncated); no magic cookie (plain BOOTP: header fields
 *    still decoded); an option running past the message. An unknown option 53 value decodes as `TYPE-<n>`.
 *  • The layer covers everything the UDP layer hands down; it never chains further.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToIpv4, bytesToMac, ipv4ToBytes, isIpv4, macToBytes } from '../../contracts/addr.js';
import type { DhcpMessageType } from '../../contracts/services.js';
import { numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** Fixed BOOTP header length (up to and including `file`). */
export const DHCP_FIXED_HEADER = 236;
/** The DHCP magic cookie 99.130.83.99. */
export const DHCP_MAGIC_COOKIE = 0x63825363;
/** Minimum BOOTP message size (RFC 1542 §2.1). */
export const BOOTP_MIN_MESSAGE = 300;

/** Option 53 values in code order (index + 1 = code). */
export const DHCP_MESSAGE_TYPES: readonly DhcpMessageType[] = Object.freeze([
  'DISCOVER',
  'OFFER',
  'REQUEST',
  'DECLINE',
  'ACK',
  'NAK',
  'RELEASE',
  'INFORM',
]);

/** Option 53 code for a message type name (1–8), or undefined. */
export function dhcpMessageTypeCode(name: string): number | undefined {
  const i = (DHCP_MESSAGE_TYPES as readonly string[]).indexOf(name.toUpperCase());
  return i < 0 ? undefined : i + 1;
}

/** Message type name for an option 53 code (`TYPE-<n>` when unknown). */
export function dhcpMessageTypeName(code: number): string {
  return code >= 1 && code <= DHCP_MESSAGE_TYPES.length ? DHCP_MESSAGE_TYPES[code - 1]! : `TYPE-${code}`;
}

const ASCII = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to; i++) {
    const c = b[i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

const TEXT_BYTES = (s: string, key: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7e || c < 0x20) throw new Error(`dhcp.${key} must be printable ASCII`);
    out.push(c);
  }
  return out;
};

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

function decodeOptions(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let i = start;
  while (i < end) {
    const code = bytes[i]!;
    if (code === 0) {
      i++;
      continue;
    }
    if (code === 255) return undefined;
    if (i + 1 >= end) return `DHCP option ${code} truncated`;
    const len = bytes[i + 1]!;
    const v = i + 2;
    if (v + len > end) return `DHCP option ${code} truncated`;
    const range: readonly [number, number] = [i, len + 2];
    const ipList = (): string[] => {
      const out: string[] = [];
      for (let a = v; a + 4 <= v + len; a += 4) out.push(bytesToIpv4(bytes, a));
      return out;
    };
    switch (code) {
      case 53:
        if (len >= 1) {
          fields.messageType = dhcpMessageTypeName(bytes[v]!);
          fieldRanges.messageType = range;
        }
        break;
      case 50:
        if (len >= 4) {
          fields.requestedIp = bytesToIpv4(bytes, v);
          fieldRanges.requestedIp = range;
        }
        break;
      case 54:
        if (len >= 4) {
          fields.serverId = bytesToIpv4(bytes, v);
          fieldRanges.serverId = range;
        }
        break;
      case 51:
        if (len >= 4) {
          fields.leaseTimeS = readU32(bytes, v);
          fieldRanges.leaseTimeS = range;
        }
        break;
      case 58:
        if (len >= 4) {
          fields.renewalTimeS = readU32(bytes, v);
          fieldRanges.renewalTimeS = range;
        }
        break;
      case 59:
        if (len >= 4) {
          fields.rebindingTimeS = readU32(bytes, v);
          fieldRanges.rebindingTimeS = range;
        }
        break;
      case 1:
        if (len >= 4) {
          fields.subnetMask = bytesToIpv4(bytes, v);
          fieldRanges.subnetMask = range;
        }
        break;
      case 3: {
        const list = ipList();
        if (list.length > 0) {
          fields.router = list[0]!;
          fieldRanges.router = range;
        }
        break;
      }
      case 6:
        fields.dnsServers = ipList().join(',');
        fieldRanges.dnsServers = range;
        break;
      case 15:
        fields.domainName = ASCII(bytes, v, v + len);
        fieldRanges.domainName = range;
        break;
      case 12:
        fields.hostname = ASCII(bytes, v, v + len);
        fieldRanges.hostname = range;
        break;
      case 55: {
        const codes: number[] = [];
        for (let k = v; k < v + len; k++) codes.push(bytes[k]!);
        fields.parameterRequestList = codes.join(',');
        fieldRanges.parameterRequestList = range;
        break;
      }
      case 61: {
        let h = '';
        for (let k = v; k < v + len; k++) h += hex2(bytes[k]!);
        fields.clientId = h;
        fieldRanges.clientId = range;
        break;
      }
      default:
        break;
    }
    i = v + len;
  }
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < DHCP_FIXED_HEADER) {
    if (avail >= 1) {
      fields.op = bytes[offset]!;
      fieldRanges.op = [offset, 1];
    }
    if (avail >= 8) {
      fields.xid = readU32(bytes, offset + 4);
      fieldRanges.xid = [offset + 4, 4];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'DHCP message truncated' };
  }
  const o = offset;
  fields.op = bytes[o]!;
  fields.htype = bytes[o + 1]!;
  fields.hlen = bytes[o + 2]!;
  fields.hops = bytes[o + 3]!;
  fields.xid = readU32(bytes, o + 4);
  fields.secs = readU16(bytes, o + 8);
  fields.broadcastFlag = (readU16(bytes, o + 10) & 0x8000) !== 0;
  fields.ciaddr = bytesToIpv4(bytes, o + 12);
  fields.yiaddr = bytesToIpv4(bytes, o + 16);
  fields.siaddr = bytesToIpv4(bytes, o + 20);
  fields.giaddr = bytesToIpv4(bytes, o + 24);
  fields.chaddr = bytesToMac(bytes, o + 28);
  fields.sname = ASCII(bytes, o + 44, o + 108);
  fields.file = ASCII(bytes, o + 108, o + 236);
  fieldRanges.op = [o, 1];
  fieldRanges.htype = [o + 1, 1];
  fieldRanges.hlen = [o + 2, 1];
  fieldRanges.hops = [o + 3, 1];
  fieldRanges.xid = [o + 4, 4];
  fieldRanges.secs = [o + 8, 2];
  fieldRanges.broadcastFlag = [o + 10, 2];
  fieldRanges.ciaddr = [o + 12, 4];
  fieldRanges.yiaddr = [o + 16, 4];
  fieldRanges.siaddr = [o + 20, 4];
  fieldRanges.giaddr = [o + 24, 4];
  fieldRanges.chaddr = [o + 28, 16];
  fieldRanges.sname = [o + 44, 64];
  fieldRanges.file = [o + 108, 128];

  if (avail < DHCP_FIXED_HEADER + 4 || readU32(bytes, o + DHCP_FIXED_HEADER) !== DHCP_MAGIC_COOKIE) {
    return { fields, fieldRanges, headerLength: DHCP_FIXED_HEADER, length: avail, error: 'BOOTP message without the DHCP magic cookie' };
  }
  const err = decodeOptions(bytes, o + DHCP_FIXED_HEADER + 4, o + avail, fields, fieldRanges);
  const out: DecodedLayer = { fields, fieldRanges, headerLength: DHCP_FIXED_HEADER + 4, length: avail };
  if (err !== undefined) out.error = err;
  return out;
}

function ipField(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: string | null): Uint8Array {
  const v = strField('dhcp', fields, key, dflt);
  if (!isIpv4(v)) throw new Error(`dhcp.${key} is not a valid IPv4 address: "${v}"`);
  return ipv4ToBytes(v);
}

function optionalText(fields: Readonly<Record<string, FieldValue>>, key: string): string | undefined {
  const v = fields[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`dhcp.${key} must be a string`);
  return v;
}

function pushOption(o: number[], code: number, value: readonly number[]): void {
  if (value.length > 255) throw new Error(`dhcp option ${code} is longer than 255 bytes`);
  o.push(code, value.length, ...value);
}

function u32(fields: Readonly<Record<string, FieldValue>>, key: string): number[] | undefined {
  const v = fields[key];
  if (v === undefined || v === null) return undefined;
  const n = numField('dhcp', fields, key, null);
  if (n < 0 || n > 0xffffffff) throw new Error(`dhcp.${key} out of range: ${n}`);
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function ipOption(fields: Readonly<Record<string, FieldValue>>, key: string): number[] | undefined {
  if (optionalText(fields, key) === undefined) return undefined;
  return [...ipField(fields, key, null)];
}

function encodeOptions(fields: Readonly<Record<string, FieldValue>>): number[] {
  const o: number[] = [];
  const typeName = strField('dhcp', fields, 'messageType', null);
  const typeCode = dhcpMessageTypeCode(typeName);
  if (typeCode === undefined) throw new Error(`dhcp.messageType unknown: "${typeName}"`);
  pushOption(o, 53, [typeCode]);
  const serverId = ipOption(fields, 'serverId');
  if (serverId) pushOption(o, 54, serverId);
  const requested = ipOption(fields, 'requestedIp');
  if (requested) pushOption(o, 50, requested);
  const lease = u32(fields, 'leaseTimeS');
  if (lease) pushOption(o, 51, lease);
  const t1 = u32(fields, 'renewalTimeS');
  if (t1) pushOption(o, 58, t1);
  const t2 = u32(fields, 'rebindingTimeS');
  if (t2) pushOption(o, 59, t2);
  const mask = ipOption(fields, 'subnetMask');
  if (mask) pushOption(o, 1, mask);
  const router = ipOption(fields, 'router');
  if (router) pushOption(o, 3, router);
  const dns = optionalText(fields, 'dnsServers');
  if (dns !== undefined) {
    const list: number[] = [];
    for (const a of dns.split(',')) {
      const t = a.trim();
      if (t === '') continue;
      if (!isIpv4(t)) throw new Error(`dhcp.dnsServers entry is not a valid IPv4 address: "${t}"`);
      list.push(...ipv4ToBytes(t));
    }
    if (list.length > 0) pushOption(o, 6, list);
  }
  const domain = optionalText(fields, 'domainName');
  if (domain !== undefined) pushOption(o, 15, TEXT_BYTES(domain, 'domainName'));
  const host = optionalText(fields, 'hostname');
  if (host !== undefined) pushOption(o, 12, TEXT_BYTES(host, 'hostname'));
  const clientId = optionalText(fields, 'clientId');
  if (clientId !== undefined) {
    if (!/^([0-9a-fA-F]{2})+$/.test(clientId)) throw new Error('dhcp.clientId must be an even number of hex digits');
    const b: number[] = [];
    for (let i = 0; i < clientId.length; i += 2) b.push(parseInt(clientId.slice(i, i + 2), 16));
    pushOption(o, 61, b);
  }
  const prl = optionalText(fields, 'parameterRequestList');
  if (prl !== undefined) {
    const codes: number[] = [];
    for (const c of prl.split(',')) {
      const t = c.trim();
      if (t === '') continue;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > 254) throw new Error(`dhcp.parameterRequestList entry out of range: "${t}"`);
      codes.push(n);
    }
    if (codes.length > 0) pushOption(o, 55, codes);
  }
  o.push(255);
  return o;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'dhcp';
  const op = numField(p, fields, 'op', null);
  const htype = numField(p, fields, 'htype', 1);
  const hlen = numField(p, fields, 'hlen', 6);
  const hops = numField(p, fields, 'hops', 0);
  const xid = numField(p, fields, 'xid', null);
  const secs = numField(p, fields, 'secs', 0);
  if (op !== 1 && op !== 2) throw new Error(`dhcp.op must be 1 (request) or 2 (reply), got ${op}`);
  if (htype < 0 || htype > 0xff) throw new Error(`dhcp.htype out of range: ${htype}`);
  if (hlen < 0 || hlen > 16) throw new Error(`dhcp.hlen out of range: ${hlen}`);
  if (hops < 0 || hops > 0xff) throw new Error(`dhcp.hops out of range: ${hops}`);
  if (xid < 0 || xid > 0xffffffff) throw new Error(`dhcp.xid out of range: ${xid}`);
  if (secs < 0 || secs > 0xffff) throw new Error(`dhcp.secs out of range: ${secs}`);
  const bflag = fields.broadcastFlag === true || fields.broadcastFlag === 1;
  let chaddr: Uint8Array;
  try {
    chaddr = macToBytes(strField(p, fields, 'chaddr', null));
  } catch (e) {
    if (e instanceof Error && e.message.includes('required')) throw e;
    throw new Error(`dhcp.chaddr is not a valid MAC address: "${String(fields.chaddr)}"`);
  }
  const options = encodeOptions(fields);

  const body = DHCP_FIXED_HEADER + 4 + options.length + payload.length;
  const out = new Uint8Array(Math.max(BOOTP_MIN_MESSAGE, body));
  out[0] = op;
  out[1] = htype;
  out[2] = hlen;
  out[3] = hops;
  writeU32(out, 4, xid);
  writeU16(out, 8, secs);
  writeU16(out, 10, bflag ? 0x8000 : 0);
  out.set(ipField(fields, 'ciaddr', '0.0.0.0'), 12);
  out.set(ipField(fields, 'yiaddr', '0.0.0.0'), 16);
  out.set(ipField(fields, 'siaddr', '0.0.0.0'), 20);
  out.set(ipField(fields, 'giaddr', '0.0.0.0'), 24);
  out.set(chaddr, 28);
  writeU32(out, DHCP_FIXED_HEADER, DHCP_MAGIC_COOKIE);
  out.set(options, DHCP_FIXED_HEADER + 4);
  out.set(payload, DHCP_FIXED_HEADER + 4 + options.length);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.messageType === 'string' ? fields.messageType : fields.op === 2 ? 'BOOTP reply' : 'BOOTP request';
  const xid = typeof fields.xid === 'number' ? ` xid=0x${fields.xid.toString(16).padStart(8, '0')}` : '';
  let detail = '';
  if ((type === 'OFFER' || type === 'ACK') && typeof fields.yiaddr === 'string') detail = ` ${fields.yiaddr}`;
  else if (type === 'REQUEST' && typeof fields.requestedIp === 'string') detail = ` for ${fields.requestedIp}`;
  else if (type === 'REQUEST' && typeof fields.ciaddr === 'string' && fields.ciaddr !== '0.0.0.0') detail = ` from ${fields.ciaddr}`;
  else if (type === 'DISCOVER' || type === 'RELEASE' || type === 'INFORM' || type === 'DECLINE') {
    detail = typeof fields.chaddr === 'string' ? ` from ${fields.chaddr}` : '';
  }
  const relay = typeof fields.giaddr === 'string' && fields.giaddr !== '0.0.0.0' ? ` via relay ${fields.giaddr}` : '';
  return `DHCP ${type}${detail}${xid}${relay}`;
}

/** DHCPv4 codec. Required on encode: `op`, `xid`, `chaddr`, `messageType`. */
export const dhcpCodec: Codec = {
  proto: 'dhcp',
  defaults: Object.freeze({
    op: null,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: null,
    secs: 0,
    broadcastFlag: false,
    ciaddr: '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    chaddr: null,
    messageType: null,
  }),
  decode,
  encode,
  summarize,
};
