/**
 * protocols/ospf/auth.ts — OSPFv2 authentication (ARCHITECTURE-P3C §3.2 steps 1–3; RFC 2328 Appendix D; §7 W2a ospf
 * [S5]). Pure: no module state; reads the configuration as protocols/ospf/config.ts returns it.
 *
 *   • Resolution (`ospfAuthOf`): the interface line `ip ospf authentication [message-digest|null]` wins over the area
 *     line `area <a> authentication [message-digest]` of the interface's area; `null` forces none; absent both, none.
 *   • Type 1 (simple): the `ip ospf authentication-key` travels in clear in the header, cut to 8 bytes (the CLI warns
 *     with `ospfAuthKeyTooLong`). A teaching point, like PAP.
 *   • Type 2 (keyed MD5, RFC 2328 D.4.3): the header carries `0 keyId 16 cryptoSeq`, the checksum is 0 and a 16-byte
 *     trailer holds MD5(packet ‖ key zero-padded to 16 bytes), computed by the codec's `ospfMd5Digest` with the
 *     YOUNGEST key (the last `ip ospf message-digest-key` line). A receiver locates the key by the packet's key id, so
 *     every configured key is accepted (a key roll-over). Without any key line the key is id 0 with an empty secret.
 *     `cryptoSeq` = ⌊sim now / 1 s⌋ (`ospfCryptoSeq`): the SIMULATION clock, never the time since the process
 *     started, so it does not decrease across `clear ip ospf process` or a reload within a world, draws no rng, and a
 *     restarted router is not refused (RFC 2328 D.5: the receiver keeps a neighbour's last sequence until the
 *     neighbour goes Down). A sequence lower than the neighbour's last is refused; an equal one is accepted.
 *   • No MD5 key byte is ever in a PDU: the key reaches only the digest.
 * Every refusal text is original wording.
 */
import type { PortId } from '../../contracts/ids.js';
import type { FieldValue, LayerSpec } from '../../contracts/pdu.js';
import type { OspfAreaId } from '../../contracts/tables.js';
import { SEC, type SimTime } from '../../contracts/time.js';
import { OSPF_AUTH, OSPF_MD5_KEY_BYTES, OSPF_SIMPLE_KEY_BYTES, ospfMd5Digest } from '../../pdu/codecs/ospf.js';
import { encodeLayers } from '../../pdu/codecs/registry.js';
import type { OspfConfig } from './config.js';

/** @since P3c [S5] The authentication of one OSPF interface. */
export type OspfAuth =
  | { readonly mode: 'none' }
  | { readonly mode: 'simple'; readonly key: string }
  | {
      readonly mode: 'md5';
      /** Every configured key by id (configuration order). */
      readonly keys: ReadonlyMap<number, string>;
      /** The key packets are signed with: the last line, or id 0 with an empty secret without any. */
      readonly youngest: { readonly id: number; readonly key: string };
    };

/** @since P3c [S5] No authentication (every P3a world). */
export const OSPF_AUTH_NONE: OspfAuth = Object.freeze({ mode: 'none' });

/** @since P3c [S5] The header's `auType` of an authentication mode. */
export function ospfAuthType(auth: OspfAuth): number {
  return auth.mode === 'simple' ? OSPF_AUTH.simple : auth.mode === 'md5' ? OSPF_AUTH.md5 : OSPF_AUTH.none;
}

const UTF8 = new TextEncoder();

/** `s` cut to at most `max` UTF-8 bytes, never inside a character. */
export function cutToBytes(s: string, max: number): string {
  if (UTF8.encode(s).length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (UTF8.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/**
 * @since P3c [S5] The authentication of `port` in `area` (the module header): the interface line, else the area line
 * of `area` in the running process, else none. (The area is the interface's OSPF area, which the enablement rule
 * decides, so the caller passes it.)
 */
export function ospfAuthOf(cfg: OspfConfig | undefined, port: PortId, area: OspfAreaId): OspfAuth {
  if (cfg === undefined) return OSPF_AUTH_NONE;
  const icfg = cfg.interfaces.get(port);
  const mode = icfg?.authentication ?? cfg.process?.areaAuth?.find((l) => l.area === area)?.mode;
  if (mode === undefined || mode === 'null') return OSPF_AUTH_NONE;
  if (mode === 'simple') return { mode: 'simple', key: cutToBytes(icfg?.authKey ?? '', OSPF_SIMPLE_KEY_BYTES) };
  const keys = new Map<number, string>();
  for (const k of icfg?.md5Keys ?? []) keys.set(k.id, cutToBytes(k.key, OSPF_MD5_KEY_BYTES));
  const last = icfg?.md5Keys?.[icfg.md5Keys.length - 1];
  const youngest = last === undefined ? { id: 0, key: '' } : { id: last.id, key: keys.get(last.id)! };
  if (last === undefined) keys.set(0, '');
  return { mode: 'md5', keys, youngest };
}

/** @since P3c [S5] The cryptographic sequence number at `now`: whole seconds of the simulation clock (u32). */
export function ospfCryptoSeq(now: SimTime): number {
  return Math.floor(now / SEC) >>> 0;
}

/**
 * @since P3c [S5] `layers` (the outer IP layer, the `ospf` layer, then its inner LSA layers) authenticated with `auth`
 * at `now`: the same array when `auth` is none (so an unauthenticated packet is byte-identical to P3a's); otherwise a
 * copy whose `ospf` layer carries the type-1 key, or the type-2 fields and the digest over the encoded packet.
 */
export function ospfSealLayers(layers: readonly LayerSpec[], auth: OspfAuth, now: SimTime): readonly LayerSpec[] {
  if (auth.mode === 'none') return layers;
  const at = layers.findIndex((l) => l.proto === 'ospf');
  if (at < 0) return layers;
  const out = [...layers];
  const base = layers[at]!;
  if (auth.mode === 'simple') {
    out[at] = { proto: 'ospf', fields: { ...base.fields, auType: OSPF_AUTH.simple, authKey: auth.key } };
    return out;
  }
  const fields: Record<string, FieldValue> = { ...base.fields, auType: OSPF_AUTH.md5, keyId: auth.youngest.id, cryptoSeq: ospfCryptoSeq(now) };
  delete fields.digest;
  out[at] = { proto: 'ospf', fields };
  const unsigned = encodeLayers(out.slice(at));
  out[at] = { proto: 'ospf', fields: { ...fields, digest: ospfMd5Digest(unsigned, auth.youngest.key) } };
  return out;
}

/** @since P3c [S5] The outcome of `ospfAuthCheck`: `seq` is the accepted cryptographic sequence number (type 2). */
export type OspfAuthVerdict =
  | { readonly ok: true; readonly seq?: number }
  | { readonly ok: false; readonly reason: 'type' | 'key' | 'key-id' | 'digest' | 'sequence'; readonly text: string };

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, n) => v === b[n]);

/**
 * @since P3c [S5] Check a received packet against the receiving interface's `auth` (RFC 2328 D.5): the type, then the
 * simple key, or the key id, the digest over `packet` (the bytes from the OSPF header on, its trailer included) and
 * the sequence against `lastSeq` (the neighbour's last accepted one; undefined without a neighbour).
 */
export function ospfAuthCheck(
  auth: OspfAuth,
  fields: Readonly<Record<string, FieldValue>>,
  packet: Uint8Array,
  lastSeq: number | undefined,
): OspfAuthVerdict {
  const mine = ospfAuthType(auth);
  const got = typeof fields.auType === 'number' ? fields.auType : 0;
  if (got !== mine) return { ok: false, reason: 'type', text: `authentication type ${got} does not match this interface's type ${mine}` };
  if (auth.mode === 'none') return { ok: true };
  if (auth.mode === 'simple') {
    const key = typeof fields.authKey === 'string' ? fields.authKey : '';
    return key === auth.key ? { ok: true } : { ok: false, reason: 'key', text: 'the authentication key does not match this interface\'s key' };
  }
  const id = typeof fields.keyId === 'number' ? fields.keyId : -1;
  const key = auth.keys.get(id);
  if (key === undefined) return { ok: false, reason: 'key-id', text: `message-digest key ${id} is not configured on this interface` };
  const digest = fields.digest;
  let expected: Uint8Array | undefined;
  try {
    expected = ospfMd5Digest(packet, key);
  } catch {
    expected = undefined;
  }
  if (!(digest instanceof Uint8Array) || expected === undefined || !equalBytes(digest, expected)) {
    return { ok: false, reason: 'digest', text: `the message digest does not match key ${id}` };
  }
  const seq = typeof fields.cryptoSeq === 'number' ? fields.cryptoSeq >>> 0 : 0;
  if (lastSeq !== undefined && seq < lastSeq) {
    return { ok: false, reason: 'sequence', text: `cryptographic sequence number ${seq} is lower than the last one received (${lastSeq})` };
  }
  return { ok: true, seq };
}
