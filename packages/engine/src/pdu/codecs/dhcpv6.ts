/**
 * DHCPv6 codec (RFC 8415; DNS options RFC 3646) — ARCHITECTURE-P2 D16, §2.3, §3.11; contracts/fields.ts `dhcpv6`.
 * Reached through UDP 546 (client) / 547 (server, relay).
 *
 * Wire image (big-endian):
 *   client/server message: `msgType(1) transactionId(3) options…`
 *   relay message (12 RELAY-FORW, 13 RELAY-REPL): `msgType(1) hopCount(1) linkAddress(16) peerAddress(16) options…`
 *   option: `code(2) length(2) data(length)`
 * Options mapped to fields (anything else is skipped on decode):
 *    1 CLIENTID  → clientDuid (hex)        2 SERVERID → serverDuid (hex)
 *    3 IA_NA     → iaid, t1S, t2S; its IAADDR (5) → iaAddress, preferredLifetimeS, validLifetimeS
 *    6 ORO       → oro (comma-separated option codes)
 *    8 ELAPSED   → elapsedTimeCs            9 RELAY_MSG → the inner dhcpv6 layer (relay messages only)
 *   13 STATUS    → statusCode (top level; a status inside IA_NA / IAADDR decodes to it too when none is at top level)
 *   14 RAPID_COMMIT → rapidCommit           23 DNS_SERVERS → dnsServers (comma-separated, RFC 5952)
 *   24 DOMAIN_LIST → domainList (comma-separated names, DNS wire format on the wire)
 *  • Encode writes the options in code order 1, 2, 3 (IA_NA with IAADDR inside when `iaAddress` is set), 6, 8, 13,
 *    14, 23, 24 and, for a relay message, 9 last carrying the already-encoded inner message (the payload). A
 *    client/server message refuses an inner payload.
 *  • DUIDs are hex strings (separators ':' or '-' accepted on encode; decode writes plain lowercase hex).
 *    `duidLlFromMac` builds the DUID-LL (type 3, hardware type 1) of a MAC.
 *  • Decode errors: truncation of the fixed header, an option running past the message.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import type { MacAddress } from '../../contracts/addr.js';
import { macToBytes } from '../../contracts/addr.js';
import { bytesToIpv6, ipv6ToBytes, isIpv6 } from '../../core/addr6.js';
import { numField, readU16, readU32, strField, writeU16 } from '../checksum.js';

/** Message types (msgType), RFC 8415 §7.3. */
export const DHCPV6_SOLICIT = 1;
export const DHCPV6_ADVERTISE = 2;
export const DHCPV6_REQUEST = 3;
export const DHCPV6_CONFIRM = 4;
export const DHCPV6_RENEW = 5;
export const DHCPV6_REBIND = 6;
export const DHCPV6_REPLY = 7;
export const DHCPV6_RELEASE = 8;
export const DHCPV6_DECLINE = 9;
export const DHCPV6_RECONFIGURE = 10;
export const DHCPV6_INFORMATION_REQUEST = 11;
export const DHCPV6_RELAY_FORW = 12;
export const DHCPV6_RELAY_REPL = 13;

/** Option codes used by the codec (RFC 8415 §21, RFC 3646). */
export const DHCPV6_OPT = Object.freeze({
  clientId: 1,
  serverId: 2,
  iaNa: 3,
  iaAddr: 5,
  oro: 6,
  elapsedTime: 8,
  relayMsg: 9,
  statusCode: 13,
  rapidCommit: 14,
  dnsServers: 23,
  domainList: 24,
});

const NAMES: readonly string[] = Object.freeze([
  'SOLICIT', 'ADVERTISE', 'REQUEST', 'CONFIRM', 'RENEW', 'REBIND', 'REPLY', 'RELEASE', 'DECLINE', 'RECONFIGURE',
  'INFORMATION-REQUEST', 'RELAY-FORW', 'RELAY-REPL',
]);

/** Message name for a msgType (`SOLICIT` … `RELAY-REPL`, `TYPE-<n>` when unknown). */
export function dhcpv6MessageName(msgType: number): string {
  return msgType >= 1 && msgType <= NAMES.length ? NAMES[msgType - 1]! : `TYPE-${msgType}`;
}

/** True for RELAY-FORW (12) and RELAY-REPL (13). */
export function isDhcpv6Relay(msgType: number): boolean {
  return msgType === DHCPV6_RELAY_FORW || msgType === DHCPV6_RELAY_REPL;
}

/** DUID-LL (RFC 8415 §11.4: type 3, hardware type 1 Ethernet, then the MAC) as lowercase hex. */
export function duidLlFromMac(mac: MacAddress): string {
  return `00030001${hexOf(macToBytes(mac), 0, 6)}`;
}

const CLIENT_HEADER = 4;
const RELAY_HEADER = 34;
const OPTION_HEADER = 4;

function hexOf(b: Uint8Array, from: number, len: number): string {
  let s = '';
  for (let i = from; i < from + len; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Decode the options in [start, end) into `fields`; returns the relay-message option's data range, or an error. */
function decodeOptions(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
  nested: boolean,
): { relay?: readonly [number, number]; error?: string } {
  let i = start;
  let relay: readonly [number, number] | undefined;
  while (i < end) {
    if (i + OPTION_HEADER > end) return { error: 'DHCPv6 option header truncated' };
    const code = readU16(bytes, i);
    const len = readU16(bytes, i + 2);
    const v = i + OPTION_HEADER;
    if (v + len > end) return { error: `DHCPv6 option ${code} runs past the message` };
    const range: readonly [number, number] = [i, OPTION_HEADER + len];
    switch (code) {
      case DHCPV6_OPT.clientId:
        if (!nested) {
          fields.clientDuid = hexOf(bytes, v, len);
          fieldRanges.clientDuid = range;
        }
        break;
      case DHCPV6_OPT.serverId:
        if (!nested) {
          fields.serverDuid = hexOf(bytes, v, len);
          fieldRanges.serverDuid = range;
        }
        break;
      case DHCPV6_OPT.iaNa:
        if (!nested && len >= 12) {
          fields.iaid = readU32(bytes, v);
          fields.t1S = readU32(bytes, v + 4);
          fields.t2S = readU32(bytes, v + 8);
          fieldRanges.iaid = [v, 4];
          fieldRanges.t1S = [v + 4, 4];
          fieldRanges.t2S = [v + 8, 4];
          const inner = decodeOptions(bytes, v + 12, v + len, fields, fieldRanges, true);
          if (inner.error !== undefined) return inner;
        }
        break;
      case DHCPV6_OPT.iaAddr:
        if (nested && len >= 24) {
          fields.iaAddress = bytesToIpv6(bytes, v);
          fields.preferredLifetimeS = readU32(bytes, v + 16);
          fields.validLifetimeS = readU32(bytes, v + 20);
          fieldRanges.iaAddress = [v, 16];
          fieldRanges.preferredLifetimeS = [v + 16, 4];
          fieldRanges.validLifetimeS = [v + 20, 4];
          const inner = decodeOptions(bytes, v + 24, v + len, fields, fieldRanges, true);
          if (inner.error !== undefined) return inner;
        }
        break;
      case DHCPV6_OPT.oro:
        if (!nested) {
          const codes: number[] = [];
          for (let k = v; k + 2 <= v + len; k += 2) codes.push(readU16(bytes, k));
          fields.oro = codes.join(',');
          fieldRanges.oro = range;
        }
        break;
      case DHCPV6_OPT.elapsedTime:
        if (!nested && len >= 2) {
          fields.elapsedTimeCs = readU16(bytes, v);
          fieldRanges.elapsedTimeCs = range;
        }
        break;
      case DHCPV6_OPT.relayMsg:
        if (!nested) relay = [v, len];
        break;
      case DHCPV6_OPT.statusCode:
        if (len >= 2 && (!nested || fields.statusCode === undefined)) {
          fields.statusCode = readU16(bytes, v);
          fieldRanges.statusCode = range;
        }
        break;
      case DHCPV6_OPT.rapidCommit:
        if (!nested) {
          fields.rapidCommit = true;
          fieldRanges.rapidCommit = range;
        }
        break;
      case DHCPV6_OPT.dnsServers:
        if (!nested) {
          const list: string[] = [];
          for (let k = v; k + 16 <= v + len; k += 16) list.push(bytesToIpv6(bytes, k));
          fields.dnsServers = list.join(',');
          fieldRanges.dnsServers = range;
        }
        break;
      case DHCPV6_OPT.domainList:
        if (!nested) {
          fields.domainList = decodeDomainList(bytes, v, v + len);
          fieldRanges.domainList = range;
        }
        break;
      default:
        break;
    }
    i = v + len;
  }
  return relay !== undefined ? { relay } : {};
}

/** Uncompressed DNS names (RFC 1035 §3.1) in [start, end), joined by ','. Malformed labels end the list. */
function decodeDomainList(bytes: Uint8Array, start: number, end: number): string {
  const names: string[] = [];
  let labels: string[] = [];
  let i = start;
  while (i < end) {
    const n = bytes[i]!;
    if (n === 0) {
      if (labels.length > 0) names.push(labels.join('.'));
      labels = [];
      i++;
      continue;
    }
    if (n > 63 || i + 1 + n > end) break;
    let s = '';
    for (let k = i + 1; k <= i + n; k++) s += String.fromCharCode(bytes[k]!);
    labels.push(s);
    i += 1 + n;
  }
  if (labels.length > 0) names.push(labels.join('.'));
  return names.join(',');
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 1) return { fields, fieldRanges, headerLength: 0, length: 0, error: 'DHCPv6 message truncated' };
  const msgType = bytes[offset]!;
  fields.msgType = msgType;
  fieldRanges.msgType = [offset, 1];
  const relayMsg = isDhcpv6Relay(msgType);
  const header = relayMsg ? RELAY_HEADER : CLIENT_HEADER;
  if (avail < header) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'DHCPv6 header truncated' };
  if (relayMsg) {
    fields.hopCount = bytes[offset + 1]!;
    fields.linkAddress = bytesToIpv6(bytes, offset + 2);
    fields.peerAddress = bytesToIpv6(bytes, offset + 18);
    fieldRanges.hopCount = [offset + 1, 1];
    fieldRanges.linkAddress = [offset + 2, 16];
    fieldRanges.peerAddress = [offset + 18, 16];
  } else {
    fields.transactionId = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    fieldRanges.transactionId = [offset + 1, 3];
  }
  const res = decodeOptions(bytes, offset + header, offset + avail, fields, fieldRanges, false);
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (res.error !== undefined) out.error = res.error;
  else if (relayMsg && res.relay !== undefined && res.relay[1] > 0) {
    out.headerLength = res.relay[0] - offset;
    out.next = { proto: 'dhcpv6', offset: res.relay[0], length: res.relay[1] };
  }
  return out;
}

// ── encode ─────────────────────────────────────────────────────────────────

function pushOption(out: number[], code: number, data: readonly number[]): void {
  if (data.length > 0xffff) throw new Error(`dhcpv6 option ${code} is too long`);
  out.push((code >>> 8) & 0xff, code & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff, ...data);
}

const u16b = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32b = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function present(fields: Record<string, FieldValue>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function u32Field(fields: Record<string, FieldValue>, key: string, dflt: number): number {
  const v = numField('dhcpv6', fields, key, dflt);
  if (v < 0 || v > 0xffffffff) throw new Error(`dhcpv6.${key} out of range: ${v}`);
  return v;
}

function u16Field(fields: Record<string, FieldValue>, key: string, dflt: number): number {
  const v = numField('dhcpv6', fields, key, dflt);
  if (v < 0 || v > 0xffff) throw new Error(`dhcpv6.${key} out of range: ${v}`);
  return v;
}

function duidBytes(fields: Record<string, FieldValue>, key: string): number[] {
  const raw = strField('dhcpv6', fields, key, null).replace(/[:-]/g, '');
  if (!/^([0-9a-fA-F]{2})+$/.test(raw)) throw new Error(`dhcpv6.${key} must be an even number of hex digits`);
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 2) out.push(parseInt(raw.slice(i, i + 2), 16));
  return out;
}

function ipv6Bytes(value: string, key: string): number[] {
  const t = value.trim();
  if (!isIpv6(t)) throw new Error(`dhcpv6.${key} is not a valid IPv6 address: "${t}"`);
  return Array.from(ipv6ToBytes(t));
}

function list(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function encodeDomainList(text: string): number[] {
  const out: number[] = [];
  for (const name of list(text)) {
    for (const label of name.replace(/\.$/, '').split('.')) {
      if (label.length < 1 || label.length > 63) throw new Error(`dhcpv6.domainList has a bad label in "${name}"`);
      out.push(label.length);
      for (let k = 0; k < label.length; k++) {
        const c = label.charCodeAt(k);
        if (c < 0x21 || c > 0x7e) throw new Error(`dhcpv6.domainList must be printable ASCII: "${name}"`);
        out.push(c);
      }
    }
    out.push(0);
  }
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'dhcpv6';
  const msgType = numField(p, fields, 'msgType', null);
  if (msgType < 1 || msgType > 0xff) throw new Error(`dhcpv6.msgType out of range: ${msgType}`);
  const relayMsg = isDhcpv6Relay(msgType);
  if (!relayMsg && payload.length > 0) throw new Error('dhcpv6: only a relay message carries an inner message');

  const out: number[] = [msgType];
  if (relayMsg) {
    const hop = numField(p, fields, 'hopCount', 0);
    if (hop < 0 || hop > 0xff) throw new Error(`dhcpv6.hopCount out of range: ${hop}`);
    out.push(hop, ...ipv6Bytes(strField(p, fields, 'linkAddress', '::'), 'linkAddress'), ...ipv6Bytes(strField(p, fields, 'peerAddress', '::'), 'peerAddress'));
  } else {
    const xid = numField(p, fields, 'transactionId', 0);
    if (xid < 0 || xid > 0xffffff) throw new Error(`dhcpv6.transactionId out of range: ${xid}`);
    out.push((xid >>> 16) & 0xff, (xid >>> 8) & 0xff, xid & 0xff);
  }

  if (present(fields, 'clientDuid')) pushOption(out, DHCPV6_OPT.clientId, duidBytes(fields, 'clientDuid'));
  if (present(fields, 'serverDuid')) pushOption(out, DHCPV6_OPT.serverId, duidBytes(fields, 'serverDuid'));
  if (present(fields, 'iaid')) {
    const ia: number[] = [...u32b(u32Field(fields, 'iaid', 0)), ...u32b(u32Field(fields, 't1S', 0)), ...u32b(u32Field(fields, 't2S', 0))];
    if (present(fields, 'iaAddress')) {
      const addr = [
        ...ipv6Bytes(strField(p, fields, 'iaAddress', null), 'iaAddress'),
        ...u32b(u32Field(fields, 'preferredLifetimeS', 0)),
        ...u32b(u32Field(fields, 'validLifetimeS', 0)),
      ];
      pushOption(ia, DHCPV6_OPT.iaAddr, addr);
    }
    pushOption(out, DHCPV6_OPT.iaNa, ia);
  }
  if (present(fields, 'oro')) {
    const codes: number[] = [];
    for (const t of list(strField(p, fields, 'oro', null))) {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`dhcpv6.oro entry out of range: "${t}"`);
      codes.push(...u16b(n));
    }
    pushOption(out, DHCPV6_OPT.oro, codes);
  }
  if (present(fields, 'elapsedTimeCs')) pushOption(out, DHCPV6_OPT.elapsedTime, u16b(u16Field(fields, 'elapsedTimeCs', 0)));
  if (present(fields, 'statusCode')) pushOption(out, DHCPV6_OPT.statusCode, u16b(u16Field(fields, 'statusCode', 0)));
  if (fields.rapidCommit === true) pushOption(out, DHCPV6_OPT.rapidCommit, []);
  if (present(fields, 'dnsServers')) {
    const addrs: number[] = [];
    for (const a of list(strField(p, fields, 'dnsServers', null))) addrs.push(...ipv6Bytes(a, 'dnsServers'));
    pushOption(out, DHCPV6_OPT.dnsServers, addrs);
  }
  if (present(fields, 'domainList')) pushOption(out, DHCPV6_OPT.domainList, encodeDomainList(strField(p, fields, 'domainList', null)));

  const head = new Uint8Array(out.length);
  head.set(out);
  if (!relayMsg) return head;
  if (payload.length > 0xffff) throw new Error('dhcpv6: a relayed message is too long');
  const full = new Uint8Array(head.length + OPTION_HEADER + payload.length);
  full.set(head, 0);
  writeU16(full, head.length, DHCPV6_OPT.relayMsg);
  writeU16(full, head.length + 2, payload.length);
  full.set(payload, head.length + OPTION_HEADER);
  return full;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.msgType === 'number' ? dhcpv6MessageName(fields.msgType) : '?';
  if (typeof fields.msgType === 'number' && isDhcpv6Relay(fields.msgType)) {
    return `DHCPv6 ${type} link ${String(fields.linkAddress ?? '?')} peer ${String(fields.peerAddress ?? '?')}`;
  }
  const xid = typeof fields.transactionId === 'number' ? ` xid=0x${fields.transactionId.toString(16).padStart(6, '0')}` : '';
  const addr = typeof fields.iaAddress === 'string' ? ` ${fields.iaAddress}` : '';
  return `DHCPv6 ${type}${addr}${xid}`;
}

/** DHCPv6 codec. Required on encode: `msgType`. */
export const dhcpv6Codec: Codec = {
  proto: 'dhcpv6',
  defaults: Object.freeze({ msgType: null, transactionId: 0, hopCount: 0 }),
  decode,
  encode,
  summarize,
};

