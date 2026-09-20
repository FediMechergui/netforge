/**
 * IEEE 802.11 management frame body codec (ARCHITECTURE-P1 §3.6; contracts/fields.ts `dot11-mgmt`).
 *
 * The layer follows a `dot11` management header; its fixed fields depend on the header's `subtype`, which
 * the codec reads from the CodecContext (the nearest enclosing `dot11` layer). Without that context (a
 * standalone decode) the body is read as information elements only.
 *
 * Fixed fields (little-endian, 802.11 order):
 *   beacon, probe-resp : timestamp(8)=0 beaconIntervalMs(2) capability(2)
 *   probe-req          : none
 *   auth               : authAlgorithm(2) authSeq(2) statusCode(2)
 *   deauth, disassoc   : reasonCode(2)
 *   assoc-req          : capability(2) listenInterval(2)=0
 *   reassoc-req        : capability(2) listenInterval(2)=0 currentAp(6) = `bssid`
 *   assoc-resp, reassoc-resp : capability(2) statusCode(2) aid(2) (the two top bits set on the wire)
 *   action / unnamed subtypes : opaque body, no fields
 * `beaconIntervalMs` travels in the interval field unscaled (simulated: one unit per millisecond).
 *
 * Information elements, written in element-id order:
 *   0 SSID (`ssid`, UTF-8, ≤ 32 bytes; written whenever the field is a string, '' = wildcard)
 *   1 Supported Rates (first 8 of `rates`, 500 kb/s units) and 50 Extended Supported Rates (the rest)
 *   3 DS Parameter Set (`channel`)
 *   48 RSN (`security` wpa2-ent / wpa2-psk / wpa3-sae: CCMP with AKM suite 1 / 2 / 8)
 *   221 simulation element (OUI 02-4e-46, type 1) with sub-elements band (1), security (2), rssiDbm (3, s16)
 * Decode reads `security` from the simulation element, else from the RSN AKM. Unknown elements are skipped
 * (and not re-encoded). `bssid` is not an element: on every subtype except reassoc-req it is the enclosing
 * header's `addr3` (decode copies it from the CodecContext; encode ignores the field).
 * `rssiDbm` is an annotation written by whoever sets it (the air medium records it with `Pdu.mutate`).
 *
 * The body carries no inner layer: `headerLength === length`, and encode refuses a non-empty payload.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes, MAC_ZERO } from '../../contracts/addr.js';
import { numField, readU16LE, strField, writeU16LE } from '../checksum.js';
import { dot11SubtypeText } from './dot11.js';

const EID_SSID = 0;
const EID_RATES = 1;
const EID_DS = 3;
const EID_RSN = 48;
const EID_EXT_RATES = 50;
const EID_VENDOR = 221;
const MAX_SSID_BYTES = 32;
const RATES_IN_FIRST = 8;

/** OUI and type of the NetForge simulation element (locally administered OUI). */
const SIM_OUI: readonly number[] = Object.freeze([0x02, 0x4e, 0x46]);
const SIM_TYPE = 1;
const SUB_BAND = 1;
const SUB_SECURITY = 2;
const SUB_RSSI = 3;

const BAND_CODES: Readonly<Record<string, number>> = Object.freeze({ '2.4': 1, '5': 2, '6': 3, '60': 4 });
const SECURITY_CODES: Readonly<Record<string, number>> = Object.freeze({ open: 0, 'wpa2-psk': 1, 'wpa3-sae': 2, 'wpa2-ent': 3 });
const RSN_AKM: Readonly<Record<string, number>> = Object.freeze({ 'wpa2-ent': 1, 'wpa2-psk': 2, 'wpa3-sae': 8 });
/** IEEE 802.11 cipher/AKM suite OUI. */
const IEEE_SUITE_OUI: readonly number[] = Object.freeze([0x00, 0x0f, 0xac]);
const CIPHER_CCMP = 4;

function nameOf(table: Readonly<Record<string, number>>, code: number): string | undefined {
  for (const k of Object.keys(table)) if (table[k] === code) return k;
  return undefined;
}

/** Fixed-field layout of a management subtype. */
type Fixed = 'beacon' | 'none' | 'auth' | 'reason' | 'assoc-req' | 'reassoc-req' | 'assoc-resp' | 'opaque';

function fixedOf(subtype: string | undefined): Fixed {
  switch (subtype) {
    case undefined:
    case 'probe-req':
      return 'none';
    case 'beacon':
    case 'probe-resp':
      return 'beacon';
    case 'auth':
      return 'auth';
    case 'deauth':
    case 'disassoc':
      return 'reason';
    case 'assoc-req':
      return 'assoc-req';
    case 'reassoc-req':
      return 'reassoc-req';
    case 'assoc-resp':
    case 'reassoc-resp':
      return 'assoc-resp';
    default:
      return 'opaque';
  }
}

const FIXED_LENGTH: Readonly<Record<Fixed, number>> = Object.freeze({
  beacon: 12, none: 0, auth: 6, reason: 2, 'assoc-req': 4, 'reassoc-req': 10, 'assoc-resp': 6, opaque: 0,
});

/** The nearest enclosing dot11 header's fields, if any. */
function headerOf(ctx: CodecContext | undefined): Readonly<Record<string, FieldValue>> | undefined {
  if (!ctx) return undefined;
  for (let j = ctx.outer.length - 1; j >= 0; j--) {
    const o = ctx.outer[j]!;
    if (o.proto === 'dot11') return o.fields;
  }
  return undefined;
}

function subtypeOf(ctx: CodecContext | undefined): string | undefined {
  const s = headerOf(ctx)?.subtype;
  return typeof s === 'string' ? s : undefined;
}

// ── UTF-8 (SSID) ────────────────────────────────────────────────────────────

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

// ── rates ───────────────────────────────────────────────────────────────────

/** `'1,2,5.5,11'` → 500 kb/s units; throws on a value that is not a positive multiple of 0.5 Mb/s below 64. */
function parseRates(text: string): number[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed.split(',').map((token) => {
    const t = token.trim();
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`dot11-mgmt.rates: "${t}" is not a rate in Mb/s`);
    const units = Number(t) * 2;
    if (!Number.isInteger(units) || units < 1 || units > 127) {
      throw new Error(`dot11-mgmt.rates: ${t} Mb/s is not a multiple of 0.5 between 0.5 and 63.5`);
    }
    return units;
  });
}

function formatRate(units: number): string {
  const v = units & 0x7f;
  return v % 2 === 0 ? String(v / 2) : `${(v - 1) / 2}.5`;
}

// ── decode ──────────────────────────────────────────────────────────────────

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const subtype = subtypeOf(ctx);
  const fixed = fixedOf(subtype);
  const end = offset + avail;

  const addr3 = headerOf(ctx)?.addr3;
  if (fixed !== 'reassoc-req' && typeof addr3 === 'string') fields.bssid = addr3;
  if (fixed === 'opaque') return { fields, fieldRanges, headerLength: avail, length: avail };

  const fixedLen = FIXED_LENGTH[fixed];
  if (avail < fixedLen) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: '802.11 management fixed fields truncated' };
  }
  const u16 = (key: string, at: number, mask = 0xffff): void => {
    fields[key] = readU16LE(bytes, offset + at) & mask;
    fieldRanges[key] = [offset + at, 2];
  };
  switch (fixed) {
    case 'beacon':
      u16('beaconIntervalMs', 8);
      u16('capability', 10);
      break;
    case 'auth':
      u16('authAlgorithm', 0);
      u16('authSeq', 2);
      u16('statusCode', 4);
      break;
    case 'reason':
      u16('reasonCode', 0);
      break;
    case 'assoc-req':
      u16('capability', 0);
      break;
    case 'reassoc-req':
      u16('capability', 0);
      fields.bssid = bytesToMac(bytes, offset + 4);
      fieldRanges.bssid = [offset + 4, 6];
      break;
    case 'assoc-resp':
      u16('capability', 0);
      u16('statusCode', 2);
      u16('aid', 4, 0x3fff);
      break;
    case 'none':
      break;
  }

  let error: string | undefined;
  const rates: string[] = [];
  let rsnSecurity: string | undefined;
  let pos = offset + fixedLen;
  while (pos < end) {
    if (pos + 2 > end) {
      error = '802.11 information element truncated';
      break;
    }
    const id = bytes[pos]!;
    const len = bytes[pos + 1]!;
    const body = pos + 2;
    if (body + len > end) {
      error = `802.11 information element ${id} truncated`;
      break;
    }
    switch (id) {
      case EID_SSID:
        if (fields.ssid === undefined) {
          fields.ssid = UTF8_DECODER.decode(bytes.subarray(body, body + len));
          fieldRanges.ssid = [body, len];
        }
        break;
      case EID_RATES:
      case EID_EXT_RATES:
        for (let i = 0; i < len; i++) rates.push(formatRate(bytes[body + i]!));
        if (fieldRanges.rates === undefined) fieldRanges.rates = [body, len];
        break;
      case EID_DS:
        if (len >= 1 && fields.channel === undefined) {
          fields.channel = bytes[body]!;
          fieldRanges.channel = [body, 1];
        }
        break;
      case EID_RSN:
        if (len >= 20 && rsnSecurity === undefined) {
          const akmAt = body + 14; // version 2, group 4, pairwise count 2, pairwise 4, AKM count 2
          if (bytes[akmAt] === IEEE_SUITE_OUI[0] && bytes[akmAt + 1] === IEEE_SUITE_OUI[1] && bytes[akmAt + 2] === IEEE_SUITE_OUI[2]) {
            rsnSecurity = nameOf(RSN_AKM, bytes[akmAt + 3]!);
            if (rsnSecurity !== undefined && fieldRanges.security === undefined) fieldRanges.security = [body, len];
          }
        }
        break;
      case EID_VENDOR:
        if (len >= 4 && bytes[body] === SIM_OUI[0] && bytes[body + 1] === SIM_OUI[1] && bytes[body + 2] === SIM_OUI[2]
          && bytes[body + 3] === SIM_TYPE) {
          const subError = decodeSimElement(bytes, body + 4, body + len, fields, fieldRanges);
          if (subError !== undefined) error ??= subError;
        }
        break;
      default:
        break;
    }
    pos = body + len;
  }
  if (rates.length > 0) fields.rates = rates.join(',');
  if (fields.security === undefined && rsnSecurity !== undefined) fields.security = rsnSecurity;

  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (error !== undefined) out.error = error;
  return out;
}

/** Sub-elements of the simulation element; returns an error text when one is malformed. */
function decodeSimElement(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let pos = start;
  while (pos < end) {
    if (pos + 2 > end) return 'simulation element truncated';
    const sub = bytes[pos]!;
    const len = bytes[pos + 1]!;
    const body = pos + 2;
    if (body + len > end) return 'simulation element truncated';
    if (sub === SUB_BAND && len === 1) {
      const band = nameOf(BAND_CODES, bytes[body]!);
      if (band !== undefined) {
        fields.band = band;
        fieldRanges.band = [body, 1];
      }
    } else if (sub === SUB_SECURITY && len === 1) {
      const security = nameOf(SECURITY_CODES, bytes[body]!);
      if (security !== undefined) {
        fields.security = security;
        fieldRanges.security = [body, 1];
      }
    } else if (sub === SUB_RSSI && len === 2) {
      const raw = readU16LE(bytes, body);
      fields.rssiDbm = raw >= 0x8000 ? raw - 0x10000 : raw;
      fieldRanges.rssiDbm = [body, 2];
    }
    pos = body + len;
  }
  return undefined;
}

// ── encode ──────────────────────────────────────────────────────────────────

function u16In(p: string, fields: Readonly<Record<string, FieldValue>>, key: string, dflt: number, max = 0xffff): number {
  const v = numField(p, fields, key, dflt);
  if (v < 0 || v > max) throw new Error(`${p}.${key} out of range: ${v}`);
  return v;
}

function element(id: number, body: readonly number[] | Uint8Array): number[] {
  if (body.length > 255) throw new Error(`dot11-mgmt: information element ${id} longer than 255 bytes`);
  return [id, body.length, ...body];
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'dot11-mgmt';
  if (payload.length > 0) throw new Error('dot11-mgmt: a management body carries no inner layer');
  const fixed = fixedOf(subtypeOf(ctx));
  if (fixed === 'opaque') return new Uint8Array(0);

  const head: number[] = new Array<number>(FIXED_LENGTH[fixed]).fill(0);
  const put16 = (at: number, v: number): void => {
    head[at] = v & 0xff;
    head[at + 1] = (v >>> 8) & 0xff;
  };
  switch (fixed) {
    case 'beacon':
      put16(8, u16In(p, fields, 'beaconIntervalMs', 100));
      put16(10, u16In(p, fields, 'capability', 0));
      break;
    case 'auth':
      put16(0, u16In(p, fields, 'authAlgorithm', 0));
      put16(2, u16In(p, fields, 'authSeq', 1));
      put16(4, u16In(p, fields, 'statusCode', 0));
      break;
    case 'reason':
      put16(0, u16In(p, fields, 'reasonCode', 0));
      break;
    case 'assoc-req':
      put16(0, u16In(p, fields, 'capability', 0));
      break;
    case 'reassoc-req': {
      put16(0, u16In(p, fields, 'capability', 0));
      const addr3 = headerOf(ctx)?.addr3;
      const current = macToBytes(strField(p, fields, 'bssid', typeof addr3 === 'string' ? addr3 : MAC_ZERO));
      for (let i = 0; i < 6; i++) head[4 + i] = current[i]!;
      break;
    }
    case 'assoc-resp':
      put16(0, u16In(p, fields, 'capability', 0));
      put16(2, u16In(p, fields, 'statusCode', 0));
      put16(4, u16In(p, fields, 'aid', 0, 2007) | 0xc000);
      break;
    case 'none':
      break;
  }

  const ies: number[] = [];
  if (fields.ssid !== undefined && fields.ssid !== null) {
    const ssid = UTF8_ENCODER.encode(strField(p, fields, 'ssid', ''));
    if (ssid.length > MAX_SSID_BYTES) throw new Error(`dot11-mgmt.ssid longer than ${MAX_SSID_BYTES} bytes`);
    ies.push(...element(EID_SSID, ssid));
  }
  const rates = fields.rates !== undefined && fields.rates !== null ? parseRates(strField(p, fields, 'rates', '')) : [];
  if (rates.length > 0) ies.push(...element(EID_RATES, rates.slice(0, RATES_IN_FIRST)));
  if (fields.channel !== undefined && fields.channel !== null) ies.push(...element(EID_DS, [u16In(p, fields, 'channel', 0, 0xff)]));

  let securityCode: number | undefined;
  if (fields.security !== undefined && fields.security !== null) {
    const security = strField(p, fields, 'security', 'open');
    securityCode = SECURITY_CODES[security];
    if (securityCode === undefined) throw new Error(`dot11-mgmt.security unknown: "${security}"`);
    const akm = RSN_AKM[security];
    if (akm !== undefined) {
      ies.push(...element(EID_RSN, [
        0x01, 0x00, // version 1
        ...IEEE_SUITE_OUI, CIPHER_CCMP, // group cipher
        0x01, 0x00, ...IEEE_SUITE_OUI, CIPHER_CCMP, // one pairwise cipher
        0x01, 0x00, ...IEEE_SUITE_OUI, akm, // one AKM suite
        0x00, 0x00, // RSN capabilities
      ]));
    }
  }
  if (rates.length > RATES_IN_FIRST) ies.push(...element(EID_EXT_RATES, rates.slice(RATES_IN_FIRST)));

  const sim: number[] = [];
  if (fields.band !== undefined && fields.band !== null) {
    const band = strField(p, fields, 'band', '');
    const code = BAND_CODES[band];
    if (code === undefined) throw new Error(`dot11-mgmt.band unknown: "${band}"`);
    sim.push(SUB_BAND, 1, code);
  }
  if (securityCode !== undefined) sim.push(SUB_SECURITY, 1, securityCode);
  if (fields.rssiDbm !== undefined && fields.rssiDbm !== null) {
    const rssi = numField(p, fields, 'rssiDbm', 0);
    if (rssi < -0x8000 || rssi > 0x7fff) throw new Error(`dot11-mgmt.rssiDbm out of range: ${rssi}`);
    const raw = rssi < 0 ? rssi + 0x10000 : rssi;
    sim.push(SUB_RSSI, 2, raw & 0xff, (raw >>> 8) & 0xff);
  }
  if (sim.length > 0) ies.push(...element(EID_VENDOR, [...SIM_OUI, SIM_TYPE, ...sim]));

  const out = new Uint8Array(head.length + ies.length);
  out.set(head, 0);
  out.set(ies, head.length);
  return out;
}

// ── summary ─────────────────────────────────────────────────────────────────

function ssidText(fields: Readonly<Record<string, FieldValue>>): string {
  if (typeof fields.ssid !== 'string') return '';
  return fields.ssid === '' ? ' for any SSID' : ` SSID "${fields.ssid}"`;
}

function summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string {
  const subtype = subtypeOf(ctx);
  const what = subtype === undefined ? 'management frame' : dot11SubtypeText(subtype);
  const channel = typeof fields.channel === 'number' ? ` channel ${fields.channel}` : '';
  switch (fixedOf(subtype)) {
    case 'beacon':
      return `802.11 ${what}${ssidText(fields)}${channel}`;
    case 'auth': {
      const alg = fields.authAlgorithm === 3 ? 'SAE' : fields.authAlgorithm === 0 ? 'open' : `algorithm ${String(fields.authAlgorithm ?? '?')}`;
      return `802.11 ${what} (${alg}) seq ${String(fields.authSeq ?? '?')} status ${String(fields.statusCode ?? '?')}`;
    }
    case 'reason':
      return `802.11 ${what} reason ${String(fields.reasonCode ?? '?')}`;
    case 'assoc-req':
    case 'reassoc-req':
      return `802.11 ${what}${ssidText(fields)}`;
    case 'assoc-resp':
      return `802.11 ${what} status ${String(fields.statusCode ?? '?')} aid ${String(fields.aid ?? '?')}`;
    case 'none':
      return `802.11 ${what}${ssidText(fields)}${channel}`;
    case 'opaque':
      return `802.11 ${what}`;
  }
}

/** 802.11 management body codec (fixed fields by the enclosing header's subtype, then information elements). */
export const dot11MgmtCodec: Codec = {
  proto: 'dot11-mgmt',
  defaults: Object.freeze({ beaconIntervalMs: 100, capability: 0, authAlgorithm: 0, authSeq: 1, statusCode: 0, reasonCode: 0, aid: 0 }),
  decode,
  encode,
  summarize,
};
