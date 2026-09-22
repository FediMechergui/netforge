/**
 * `PduImpl` — the engine's PDU handle (spec §4.5 PDU model, §9.2 layer cards,
 * §9.3 header provenance).
 *
 * Bytes, layers and provenance are private class fields. The ONLY write paths are
 * `mutate`, `encapsulate`, `rewrap` and `corrupt`, and each appends at least one
 * `Mutation` — the provenance invariant is structural, not a convention. `clone`
 * produces a fresh handle with a copied history.
 *
 * `layers` is ALWAYS the decoder's view of `bytes`: every write re-encodes what
 * changed, then re-decodes the whole buffer (`decodeLayers`). Layer objects are
 * never mutated in place — the array is replaced — so a `LayerView` handed out
 * earlier stays a consistent (stale) snapshot.
 *
 * Codec-driven behaviour (P0.5): derived-field provenance comes from each codec's
 * `derived` map (in its declaration order), summary/topProto skip `transparent`
 * codecs and stop descending at `stopsMeaning`, and every codec call receives the
 * `CodecContext` of the layers outside it.
 *
 * Pseudo-header re-encode (P1): `mutate` of an outer path that an inner codec lists in
 * `outerInputs` (ipv4.src/dst, ipv6.src/dst) re-encodes from that inner layer outward, so
 * UDP/TCP/ICMPv6 checksums follow a NAT-style address rewrite and are recorded as their own
 * `ChecksumRecompute` mutations before the outer layers' derived fields.
 *
 * P2 (ARCHITECTURE-P2 D4, §2.3):
 *  • `RewrapOp.as` — 802.1Q push/pop with dedicated provenance. 'vlan-push' ({strip:1, push:[ethernet, dot1q]})
 *    records exactly `VlanTagPush {field 'dot1q.vid', before null, after vid}` then `FcsRecompute {field
 *    'ethernet.fcs'}`; 'vlan-pop' ({strip:2, push:[ethernet]} on a frame whose layers[1] is dot1q) records exactly
 *    `VlanTagPop {before vid, after null}` then `FcsRecompute`. Only the tag changes: the pushed ethernet header keeps
 *    the frame's dst/src (filled when the spec omits them; a different value throws, it would be an unrecorded MAC
 *    rewrite), the tag's type is the frame's old ethernet.type and a popped frame's ethernet.type is the tag's type,
 *    so push then pop returns the original bytes of any frame (padding re-encoded to the 64-byte minimum, FCS
 *    recomputed). Any other shape, or a push on a frame that is already tagged, throws before anything changes.
 *  • [SHOULD S9] Field paths `'<proto>[<i>].<field>'` address the layer at index i (`layerAt(i)`, which must be a
 *    `<proto>` layer); `'<proto>.<field>'` keeps meaning the first layer of that proto. `get` accepts both forms.
 *    Mutations are recorded under the CANONICAL path of the layer: the plain form for the first layer of its proto,
 *    the indexed form for any later one, and always the indexed form for a layer inside a quote (so a quoted
 *    `ipv4[3].src` or `udp[4].srcPort` is never read as the outer one, whichever form the caller used).
 *    A layer inside an ICMP-error quote (after an icmpv4/icmpv6 layer whose codec `stopsMeaning`) is PATCHED IN
 *    PLACE (`#patchQuoted`), never re-encoded: the field's bytes are replaced; a quoted ipv4 header's checksum is
 *    recomputed over its own header; a quoted ICMP id (any quoted icmpv4/icmpv6 field) adjusts that quoted ICMP
 *    checksum incrementally (RFC 1624); a quoted udp port, or a quoted IP address (pseudo-header), adjusts a
 *    present non-zero quoted udp checksum incrementally (and, for an IPv6 address, a quoted icmpv6 checksum); a
 *    quoted tcp checksum is never touched. The enclosing layers then re-encode as usual (error ICMP checksum, outer
 *    IP, FCS). Records: the primary mutation, the quoted derived checksums innermost first, then the enclosing
 *    layers' derived fields innermost first.
 *
 * Accessor notes:
 *  • `bytes` returns a fresh COPY on every access (callers may not write the wire
 *    image; a copy is the cheapest way to make that a hard guarantee). Hot paths
 *    should read `size` / `layers` / `get()` instead.
 *  • `layers` / `provenance` return the live readonly arrays (no copy).
 *
 * Only `pdu/factory.ts` constructs instances (contract rule 3: no module may
 * construct a Pdu except via `PduFactory`).
 */
import type { PduId } from '../contracts/ids.js';
import type { SimTime } from '../contracts/time.js';
import type {
  FieldValue,
  LayerSpec,
  LayerView,
  Mutation,
  MutationCtx,
  MutationReason,
  Pdu,
  PduJson,
  PduMeta,
  ProtoName,
  RewrapOp,
} from '../contracts/pdu.js';
import { ETHERTYPE_VLAN } from '../contracts/pdu.js';
import { PROTO_FIELDS } from '../contracts/fields.js';
import { ipv4ToBytes, isIpv4, macToBytes, normalizeMac } from '../contracts/addr.js';
import { ipv6ToBytes, isIpv6 } from '../core/addr6.js';
import { foldOnes, internetChecksum, writeU16 } from './checksum.js';
import {
  contextOf,
  decodeLayers,
  encodeAround,
  getCodec,
  requireCodec,
} from './codecs/registry.js';
import { isLengthType } from './codecs/dispatch.js';

const EMPTY = new Uint8Array(0);

/** Two field values are equal (Uint8Array compared bytewise). */
function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

/** Copy a LayerView deeply enough that the result shares nothing mutable with the source. */
function copyLayer(l: LayerView): LayerView {
  const fields: Record<string, FieldValue> = {};
  for (const k of Object.keys(l.fields)) {
    const v = l.fields[k];
    fields[k] = v instanceof Uint8Array ? v.slice() : (v as FieldValue);
  }
  const fieldRanges: Record<string, readonly [number, number]> = {};
  for (const k of Object.keys(l.fieldRanges)) {
    const r = l.fieldRanges[k]!;
    fieldRanges[k] = [r[0], r[1]];
  }
  const out: LayerView = {
    proto: l.proto,
    offset: l.offset,
    length: l.length,
    headerLength: l.headerLength,
    ...(l.trailerLength !== undefined ? { trailerLength: l.trailerLength } : {}),
    fields,
    fieldRanges,
    ...(l.error !== undefined ? { error: l.error } : {}),
  };
  return out;
}

/** A parsed field path: `"ipv4.ttl"` or (P2 [S9]) `"ipv4[3].src"` (the layer at index 3). */
interface FieldPath {
  readonly proto: ProtoName;
  readonly field: string;
  /** Layer index of the indexed form; absent for the plain form (first layer of `proto`). */
  readonly index?: number;
}

const INDEXED_PROTO = /^(.+)\[(\d+)\]$/;

/** Split `"ipv4.ttl"` / `"ipv4[3].ttl"` into proto, optional layer index and field name (first dot only). */
function splitPath(path: string): FieldPath | undefined {
  const dot = path.indexOf('.');
  if (dot <= 0 || dot === path.length - 1) return undefined;
  const head = path.slice(0, dot);
  const field = path.slice(dot + 1);
  const m = INDEXED_PROTO.exec(head);
  if (m) return { proto: m[1]!, field, index: Number(m[2]) };
  return { proto: head, field };
}

/** True when `v` is absent or equal to `want` (MACs compared canonically). */
function absentOrMac(v: FieldValue | undefined, want: FieldValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string' || typeof want !== 'string') return false;
  return normalizeMac(v) === normalizeMac(want);
}

/** True when an ethertype-or-length value `v` (if given) selects the same thing as `want`. */
function absentOrSameType(v: FieldValue | undefined, want: FieldValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'number' || typeof want !== 'number') return false;
  return v === want || (isLengthType(v) && isLengthType(want));
}

/** One's-complement incremental update (RFC 1624 eqn 3) of checksum `hc` for the 16-bit words of [s, e). */
function adjustChecksum(hc: number, before: Uint8Array, after: Uint8Array, s: number, e: number): number {
  let sum = ~hc & 0xffff;
  for (let i = s; i < e; i += 2) {
    const m = ((before[i] ?? 0) << 8) | (before[i + 1] ?? 0);
    const m2 = ((after[i] ?? 0) << 8) | (after[i + 1] ?? 0);
    sum += (~m & 0xffff) + m2;
  }
  return ~foldOnes(sum) & 0xffff;
}

/** The 16-bit-aligned span (relative to `base`) covering the byte range [start, start + len). */
function wordSpan(base: number, start: number, len: number): [number, number] {
  const s = base + Math.floor((start - base) / 2) * 2;
  const e = base + Math.ceil((start + len - base) / 2) * 2;
  return [s, e];
}

/**
 * Write `value` into `bytes` at `range` as field `<proto>.<field>` (quoted-layer patching, [S9]). Supported: whole-byte
 * uint fields (big-endian), ipv4, ipv6 and mac fields. Throws for anything else (a sub-byte field shares its bytes).
 */
function writeFieldBytes(bytes: Uint8Array, range: readonly [number, number], proto: ProtoName, field: string, value: FieldValue): void {
  const spec = PROTO_FIELDS[proto]?.fields.find((f) => f.name === field);
  const path = `${proto}.${field}`;
  if (!spec) throw new Error(`mutate: ${path} is not a field of ${proto}`);
  const [off, len] = range;
  switch (spec.type) {
    case 'ipv4':
      if (typeof value !== 'string' || !isIpv4(value) || len !== 4) throw new Error(`mutate: ${path} needs an IPv4 address, got ${String(value)}`);
      bytes.set(ipv4ToBytes(value), off);
      return;
    case 'ipv6':
      if (typeof value !== 'string' || !isIpv6(value) || len !== 16) throw new Error(`mutate: ${path} needs an IPv6 address, got ${String(value)}`);
      bytes.set(ipv6ToBytes(value), off);
      return;
    case 'mac': {
      const mac = typeof value === 'string' ? normalizeMac(value) : null;
      if (mac === null || len !== 6) throw new Error(`mutate: ${path} needs a MAC address, got ${String(value)}`);
      bytes.set(macToBytes(mac), off);
      return;
    }
    case 'uint': {
      if (spec.bits !== len * 8 || len < 1 || len > 4) throw new Error(`mutate: ${path} shares its bytes with another field and cannot be patched in a quote`);
      const max = len === 4 ? 0xffffffff : (1 << (len * 8)) - 1;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`mutate: ${path} out of range: ${String(value)}`);
      }
      let v = value;
      for (let k = len - 1; k >= 0; k--) {
        bytes[off + k] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return;
    }
    default:
      throw new Error(`mutate: ${path} (${spec.type}) cannot be patched in a quote`);
  }
}

/** The engine PDU. See the file header for the invariants. */
export class PduImpl implements Pdu {
  readonly id: PduId;
  readonly meta: PduMeta;
  #bytes: Uint8Array;
  #layers: LayerView[];
  readonly #provenance: Mutation[];

  /**
   * @param id fresh id from the factory counter
   * @param bytes wire image — the instance takes OWNERSHIP (caller must not keep writing to it)
   * @param layers decoder's view of `bytes` (pass `decodeLayers(bytes, outer)`)
   * @param meta birth metadata
   * @param provenance mutation history to start from (clone) — copied
   */
  constructor(id: PduId, bytes: Uint8Array, layers: readonly LayerView[], meta: PduMeta, provenance: readonly Mutation[] = []) {
    this.id = id;
    this.meta = meta;
    this.#bytes = bytes;
    this.#layers = layers.slice();
    this.#provenance = provenance.slice();
  }

  /** Copy of the wire image (see file header). */
  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  /** Decoder's view of the bytes, outermost first (live readonly array). */
  get layers(): readonly LayerView[] {
    return this.#layers;
  }

  /** Recorded mutations in causal order (live readonly array). */
  get provenance(): readonly Mutation[] {
    return this.#provenance;
  }

  /** Total bytes on the wire. */
  get size(): number {
    return this.#bytes.length;
  }

  /** Outermost-first lookup of a layer by protocol name. */
  layer(proto: ProtoName): LayerView | undefined {
    const ls = this.#layers;
    for (let i = 0; i < ls.length; i++) if (ls[i]!.proto === proto) return ls[i];
    return undefined;
  }

  /** Layer by index (duplicated protos: ICMP quotes, tunnels); undefined outside `[0, layers.length)`. */
  layerAt(index: number): LayerView | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined;
    return this.#layers[index];
  }

  /** `get("ipv4.ttl")` — field of the first layer with that proto; `get("ipv4[3].src")` — of the layer at index 3 (P2 [S9]). */
  get(path: string): FieldValue | undefined {
    const p = splitPath(path);
    if (!p) return undefined;
    const i = this.#resolve(p);
    return i < 0 ? undefined : this.#layers[i]!.fields[p.field];
  }

  /** Index of the layer a path addresses: the indexed layer (when its proto matches) or the first of the proto; -1 when none. */
  #resolve(p: FieldPath): number {
    const ls = this.#layers;
    if (p.index !== undefined) return ls[p.index]?.proto === p.proto ? p.index : -1;
    for (let i = 0; i < ls.length; i++) if (ls[i]!.proto === p.proto) return i;
    return -1;
  }

  /**
   * Canonical path of field `field` of the layer at `index`: plain for the first layer of its proto, indexed
   * otherwise — and always indexed for a layer inside an ICMP-error quote, so a quoted field is never read as an
   * outer one (§3.9 writes them `ipv4[i].src`, `udp[j].srcPort`).
   */
  #canonical(index: number, field: string, layers: readonly LayerView[] = this.#layers, quotedAfter = -1): string {
    const proto = layers[index]!.proto;
    if (quotedAfter >= 0 && index > quotedAfter) return `${proto}[${index}].${field}`;
    for (let i = 0; i < index; i++) if (layers[i]!.proto === proto) return `${proto}[${index}].${field}`;
    return `${proto}.${field}`;
  }

  /** Index of the ICMP error layer whose quote contains the layer at `index` (the innermost one), or -1. */
  #quoteOwner(index: number): number {
    const ls = this.#layers;
    for (let j = index - 1; j >= 0; j--) {
      const l = ls[j]!;
      if (l.proto !== 'icmpv4' && l.proto !== 'icmpv6') continue;
      if (getCodec(l.proto)?.stopsMeaning?.(l.fields)) return j;
    }
    return -1;
  }

  /**
   * Index of the layer that describes this PDU: the innermost layer that is neither
   * `payload` nor a `transparent` codec, never descending past a layer whose codec
   * `stopsMeaning` (an ICMP error's quote). -1 when no such layer exists.
   */
  #meaningfulIndex(): number {
    const ls = this.#layers;
    let best = -1;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!;
      if (l.proto === 'payload') continue;
      const codec = getCodec(l.proto);
      if (codec?.transparent) continue;
      best = i;
      if (codec?.stopsMeaning?.(l.fields)) break;
    }
    return best;
  }

  /** One-line human summary from the meaningful layer's codec (with its CodecContext). */
  summary(): string {
    const i = this.#meaningfulIndex();
    if (i < 0) {
      const only = this.#layers[0];
      if (!only) return `${this.#bytes.length} bytes`;
      return (getCodec(only.proto) ?? requireCodec('payload')).summarize(only.fields, contextOf(this.#layers, 0));
    }
    const l = this.#layers[i]!;
    return requireCodec(l.proto).summarize(l.fields, contextOf(this.#layers, i));
  }

  /** Innermost meaningful protocol (see `#meaningfulIndex`), `payload` when none. */
  topProto(): ProtoName {
    const i = this.#meaningfulIndex();
    return i < 0 ? 'payload' : this.#layers[i]!.proto;
  }

  /** Structured-clone-safe snapshot sharing nothing with the PDU. */
  toJSON(): PduJson {
    return {
      id: this.id,
      bytes: this.#bytes.slice(),
      layers: this.#layers.map(copyLayer),
      meta: { ...this.meta },
      provenance: this.#provenance.map((m) => ({ ...m })),
      summary: this.summary(),
      topProto: this.topProto(),
    };
  }

  #record(ctx: MutationCtx, reason: MutationReason, field: string, before: FieldValue, after: FieldValue, cause?: string): void {
    const m: Mutation = cause !== undefined
      ? { at: ctx.now, device: ctx.device, reason, field, before, after, cause }
      : { at: ctx.now, device: ctx.device, reason, field, before, after };
    this.#provenance.push(m);
  }

  /** Bytes of layer `i` (`[offset, offset+length)`), or empty for an index past the end. */
  #layerBytes(i: number): Uint8Array {
    const l = this.#layers[i];
    if (!l) return EMPTY;
    return this.#bytes.subarray(l.offset, l.offset + l.length);
  }

  /**
   * Innermost index of a layer INSIDE `idx` whose codec lists `path` in `outerInputs` and whose nearest
   * enclosing `proto` layer is `idx` itself (a UDP header quoted inside an ICMP error depends on the
   * quoted IP header, not on the outer one). -1 when no inner layer depends on `path`.
   */
  #innermostDependent(idx: number, proto: ProtoName, path: string): number {
    const ls = this.#layers;
    let found = -1;
    let owner = idx;
    for (let k = idx + 1; k < ls.length; k++) {
      const l = ls[k]!;
      const inputs = getCodec(l.proto)?.outerInputs;
      if (owner === idx && inputs !== undefined && inputs.includes(path)) found = k;
      if (l.proto === proto) owner = k;
    }
    return found;
  }

  /**
   * Change one field; re-encodes the layer and its outers; records derived-field changes (see contract).
   *
   * P1 outerInputs rule: when an inner layer's codec lists the mutated path in `outerInputs`
   * (pseudo-header inputs such as `ipv4.src`), re-encoding starts at the innermost such layer, with a
   * `CodecContext` that already carries the new value, and walks outward. Derived-field changes are then
   * recorded innermost-first, so a NAT-style `mutate('ipv4.src')` records ipv4.src, the transport
   * checksum (`ChecksumRecompute`), ipv4.checksum, then the link FCS. Paths no codec lists (ttl, MACs)
   * keep the P0 behaviour and mutation counts exactly.
   */
  mutate(ctx: MutationCtx, field: string, after: FieldValue, reason: MutationReason, cause?: string): void {
    const p = splitPath(field);
    if (!p) throw new Error(`mutate: field path must be "<proto>.<field>" or "<proto>[<i>].<field>", got "${field}"`);
    const old = this.#layers;
    const idx = this.#resolve(p);
    if (idx < 0) {
      if (p.index !== undefined) throw new Error(`mutate: PDU ${this.id} has no ${p.proto} layer at index ${p.index}`);
      throw new Error(`mutate: PDU ${this.id} has no ${p.proto} layer`);
    }
    const quote = this.#quoteOwner(idx);
    if (quote >= 0) {
      this.#patchQuoted(ctx, idx, quote, p.field, after, reason, cause);
      return;
    }
    const target = old[idx]!;
    const before = target.fields[p.field] ?? null;
    const changed: Record<string, FieldValue> = { ...target.fields, [p.field]: after };

    // 1. Re-encode from the innermost layer that must change (the innermost outerInputs dependent, or
    //    the target itself) outward. Each layer's payload is the ALREADY-ENCODED bytes of the layer
    //    inside it (never the raw gap, which would include old padding/FCS). Each codec sees the layers
    //    outside it as its CodecContext, with the target layer's fields already carrying the new value.
    const innermost = Math.max(idx, this.#innermostDependent(idx, p.proto, `${p.proto}.${p.field}`));
    const view: LayerView[] = old.slice();
    view[idx] = { ...target, fields: changed };
    let encoded = this.#layerBytes(innermost + 1);
    for (let j = innermost; j >= 0; j--) {
      const layer = view[j]!;
      encoded = requireCodec(layer.proto).encode({ ...layer.fields }, encoded, contextOf(view, j));
    }

    // 2. Commit, then primary mutation first (provenance order = causal order).
    const outermost = old[0]!.proto;
    this.#bytes = encoded;
    this.#layers = decodeLayers(encoded, outermost);
    this.#record(ctx, reason, this.#canonical(idx, p.field, old), before, after, cause);

    // 3. Derived-field mutations, innermost re-encoded layer outward, in each codec's `derived`
    //    declaration order.
    this.#recordDerived(ctx, old, innermost, cause);
  }

  /**
   * Record the derived-field changes of layers `from` … 0 between `old` and the current layers, innermost first, in
   * each codec's `derived` declaration order, under canonical paths.
   */
  #recordDerived(ctx: MutationCtx, old: readonly LayerView[], from: number, cause: string | undefined): void {
    const fresh = this.#layers;
    for (let j = from; j >= 0; j--) {
      const o = old[j]!;
      const n = fresh[j];
      if (!n || n.proto !== o.proto) continue;
      const derived = getCodec(n.proto)?.derived;
      if (!derived) continue;
      for (const name of Object.keys(derived)) {
        const was = o.fields[name];
        const now = n.fields[name];
        if (was === undefined && now === undefined) continue;
        if (!sameValue(was, now)) this.#record(ctx, derived[name]!, this.#canonical(j, name, fresh), was ?? null, now ?? null, cause);
      }
    }
  }

  /**
   * [SHOULD S9] Patch field `field` of the layer at `idx`, which sits inside the quote of the ICMP error layer at
   * `errorAt`, IN PLACE (see the file header), then re-encode the error layer and everything outside it.
   */
  #patchQuoted(
    ctx: MutationCtx,
    idx: number,
    errorAt: number,
    field: string,
    after: FieldValue,
    reason: MutationReason,
    cause: string | undefined,
  ): void {
    const old = this.#layers;
    const target = old[idx]!;
    const proto = target.proto;
    const range = target.fieldRanges[field];
    if (range === undefined || target.fields[field] === undefined) {
      throw new Error(`mutate: the quoted ${proto} header of PDU ${this.id} carries no ${field}`);
    }
    const before = target.fields[field] ?? null;
    const prior = this.#bytes;
    const bytes = prior.slice();
    writeFieldBytes(bytes, range, proto, field, after);

    /** Layers whose own checksum this patch changes (recorded innermost first). */
    const touched: number[] = [];
    const adjust = (at: number, span: readonly [number, number], udp: boolean): void => {
      const l = old[at]!;
      const cr = l.fieldRanges.checksum;
      const hc = l.fields.checksum;
      if (cr === undefined || typeof hc !== 'number' || cr[0] + 2 > bytes.length) return;
      if (udp && hc === 0) return; // UDP over IPv4 without a checksum stays without one
      let c = adjustChecksum(hc, prior, bytes, span[0], span[1]);
      if (udp && c === 0) c = 0xffff;
      writeU16(bytes, cr[0], c);
      touched.push(at);
    };
    const own = wordSpan(target.offset, range[0], range[1]);
    if ((proto === 'udp' || proto === 'icmpv4' || proto === 'icmpv6') && field !== 'checksum') adjust(idx, own, proto === 'udp');
    if ((proto === 'ipv4' || proto === 'ipv6') && (field === 'src' || field === 'dst')) {
      const inner = old[idx + 1];
      if (inner?.proto === 'udp') adjust(idx + 1, own, true);
      else if (inner?.proto === 'icmpv6' && proto === 'ipv6') adjust(idx + 1, own, false);
    }
    if (proto === 'ipv4' && target.error === undefined && field !== 'checksum') {
      const cr = target.fieldRanges.checksum;
      const hdr = target.headerLength;
      if (cr !== undefined && target.offset + hdr <= bytes.length) {
        writeU16(bytes, cr[0], 0);
        writeU16(bytes, cr[0], internetChecksum(bytes, target.offset, hdr));
        touched.push(idx);
      }
    }

    // Re-encode the error layer around its (patched) quote, then everything outside it.
    const err = old[errorAt]!;
    let encoded: Uint8Array = bytes.slice(err.offset + err.headerLength, err.offset + err.length - (err.trailerLength ?? 0));
    for (let j = errorAt; j >= 0; j--) {
      const layer = old[j]!;
      encoded = requireCodec(layer.proto).encode({ ...layer.fields }, encoded, contextOf(old, j));
    }
    this.#bytes = encoded;
    this.#layers = decodeLayers(encoded, old[0]!.proto);
    this.#record(ctx, reason, this.#canonical(idx, field, old, errorAt), before, after, cause);
    const fresh = this.#layers;
    touched.sort((a, b) => b - a);
    for (const at of touched) {
      const was = old[at]!.fields.checksum;
      const now = fresh[at]?.fields.checksum;
      if (!sameValue(was, now)) this.#record(ctx, 'ChecksumRecompute', this.#canonical(at, 'checksum', old, errorAt), was ?? null, now ?? null, cause);
    }
    this.#recordDerived(ctx, old, errorAt, cause);
  }

  /** Push `outer` around the current bytes (same id); records one Encapsulate mutation. */
  encapsulate(ctx: MutationCtx, outer: LayerSpec, cause?: string): void {
    const encoded = encodeAround([outer], this.#bytes, this.#layers[0]?.proto);
    this.#bytes = encoded;
    this.#layers = decodeLayers(encoded, outer.proto);
    this.#record(ctx, 'Encapsulate', outer.proto, null, outer.proto, cause);
  }

  /**
   * Strip `op.strip` outer layers (with their trailers) and push `op.push` (outermost first) around
   * what remains. Same id. Records one Decapsulate per stripped layer (outermost first), then one
   * Encapsulate per pushed layer (innermost first). Atomic: an encode error leaves the PDU untouched.
   * `{strip: 0, push: []}` is a no-op.
   * @throws RangeError when `strip` is not a non-negative integer
   * @throws Error when every layer would be stripped and nothing pushed
   */
  rewrap(ctx: MutationCtx, op: RewrapOp, cause?: string): void {
    if (op.as !== undefined) {
      this.#rewrapVlan(ctx, op, cause);
      return;
    }
    const { strip, push } = op;
    if (!Number.isInteger(strip) || strip < 0) throw new RangeError(`rewrap: strip must be a non-negative integer, got ${strip}`);
    const old = this.#layers;
    if (strip >= old.length && push.length === 0) {
      throw new Error(`rewrap: stripping ${strip} of ${old.length} layers of PDU ${this.id} with nothing pushed leaves no layers`);
    }
    if (strip === 0 && push.length === 0) return;

    const kept = old[strip];
    const inner = kept ? this.#bytes.slice(kept.offset, kept.offset + kept.length) : EMPTY.slice();
    const encoded = encodeAround(push, inner, kept?.proto);
    const outermost: ProtoName = push.length > 0 ? push[0]!.proto : kept!.proto;
    const layers = decodeLayers(encoded, outermost);

    this.#bytes = encoded;
    this.#layers = layers;
    const stripped = Math.min(strip, old.length);
    for (let i = 0; i < stripped; i++) {
      const proto = old[i]!.proto;
      this.#record(ctx, 'Decapsulate', proto, proto, null, cause);
    }
    for (let k = push.length - 1; k >= 0; k--) {
      const proto = push[k]!.proto;
      this.#record(ctx, 'Encapsulate', proto, null, proto, cause);
    }
  }

  /**
   * P2 (D4): `rewrap` with `op.as` — push or pop an 802.1Q tag with dedicated provenance (see the file header).
   * Validates everything before changing anything, so a refused op leaves the PDU untouched.
   */
  #rewrapVlan(ctx: MutationCtx, op: RewrapOp, cause: string | undefined): void {
    const old = this.#layers;
    const eth = old[0];
    const what = `rewrap ${String(op.as)}`;
    if (eth?.proto !== 'ethernet') throw new Error(`${what}: PDU ${this.id} is not an Ethernet frame`);
    let specs: LayerSpec[];
    let kept: LayerView | undefined;
    let vid: number;
    if (op.as === 'vlan-push') {
      const [ethSpec, tagSpec] = op.push;
      if (op.strip !== 1 || op.push.length !== 2 || ethSpec?.proto !== 'ethernet' || tagSpec?.proto !== 'dot1q') {
        throw new Error(`${what}: the op must be {strip: 1, push: [ethernet, dot1q]}`);
      }
      if (old[1]?.proto === 'dot1q') throw new Error(`${what}: PDU ${this.id} is already tagged (VLAN ${String(old[1].fields.vid)})`);
      const raw = tagSpec.fields.vid;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 0x0fff) throw new Error(`${what}: dot1q.vid must be 0-4095, got ${String(raw)}`);
      vid = raw;
      this.#checkSameMacs(what, ethSpec.fields, eth);
      if (!absentOrSameType(ethSpec.fields.type, ETHERTYPE_VLAN)) throw new Error(`${what}: ethernet.type of a tagged frame is 0x8100`);
      if (!absentOrSameType(tagSpec.fields.type, eth.fields.type)) throw new Error(`${what}: dot1q.type must be the frame's ethernet.type`);
      specs = [
        { proto: 'ethernet', fields: { ...ethSpec.fields, dst: eth.fields.dst ?? null, src: eth.fields.src ?? null, type: ETHERTYPE_VLAN } },
        { proto: 'dot1q', fields: { ...tagSpec.fields, type: eth.fields.type ?? null } },
      ];
      kept = old[1];
    } else if (op.as === 'vlan-pop') {
      const [ethSpec] = op.push;
      if (op.strip !== 2 || op.push.length !== 1 || ethSpec?.proto !== 'ethernet') {
        throw new Error(`${what}: the op must be {strip: 2, push: [ethernet]}`);
      }
      const tag = old[1];
      if (tag?.proto !== 'dot1q' || typeof tag.fields.vid !== 'number') throw new Error(`${what}: PDU ${this.id} carries no 802.1Q tag`);
      vid = tag.fields.vid;
      this.#checkSameMacs(what, ethSpec.fields, eth);
      if (!absentOrSameType(ethSpec.fields.type, tag.fields.type)) throw new Error(`${what}: ethernet.type must be the tag's type`);
      specs = [{ proto: 'ethernet', fields: { ...ethSpec.fields, dst: eth.fields.dst ?? null, src: eth.fields.src ?? null, type: tag.fields.type ?? null } }];
      kept = old[2];
    } else {
      throw new Error(`${what}: unknown rewrap kind`);
    }

    const inner = kept ? this.#bytes.slice(kept.offset, kept.offset + kept.length) : EMPTY.slice();
    const encoded = encodeAround(specs, inner, kept?.proto);
    const layers = decodeLayers(encoded, 'ethernet');
    const fcsBefore = eth.fields.fcs ?? null;
    const fcsAfter = layers[0]?.fields.fcs ?? null;
    this.#bytes = encoded;
    this.#layers = layers;
    if (op.as === 'vlan-push') this.#record(ctx, 'VlanTagPush', 'dot1q.vid', null, vid, cause);
    else this.#record(ctx, 'VlanTagPop', 'dot1q.vid', vid, null, cause);
    this.#record(ctx, 'FcsRecompute', 'ethernet.fcs', fcsBefore, fcsAfter, cause);
  }

  /** A VLAN rewrap keeps the frame's addresses: an explicit dst/src must equal them (else it is an unrecorded rewrite). */
  #checkSameMacs(what: string, fields: Readonly<Record<string, FieldValue>>, eth: LayerView): void {
    if (!absentOrMac(fields.dst, eth.fields.dst) || !absentOrMac(fields.src, eth.fields.src)) {
      throw new Error(`${what}: ethernet dst/src must be the frame's own (a VLAN rewrap never rewrites MAC addresses)`);
    }
  }

  /** Deep copy with a new id and `meta.parent = this.id`; provenance is copied. */
  clone(newId: PduId, at: SimTime): Pdu {
    const meta: PduMeta = { ...this.meta, born: at, parent: this.id };
    const provenance = this.#provenance.map((m) => ({ ...m }));
    return new PduImpl(newId, this.#bytes.slice(), this.#layers.map(copyLayer), meta, provenance);
  }

  /** Flip raw bits (link corruption); recorded as a Corruption mutation; FCS is not recomputed. */
  corrupt(ctx: MutationCtx, byteOffset: number, bitMask: number): void {
    const n = this.#bytes.length;
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset >= n) {
      throw new RangeError(`corrupt: byte offset ${byteOffset} outside PDU of ${n} bytes`);
    }
    const mask = bitMask & 0xff;
    const before = this.#bytes[byteOffset]!;
    const after = before ^ mask;
    // The wire image is exclusively owned (factory/clone copy on the way in, `bytes`
    // copies on the way out), so flipping in place is safe. FCS is NOT recomputed.
    this.#bytes[byteOffset] = after;
    const outermost = this.#layers[0]?.proto ?? 'ethernet';
    this.#layers = decodeLayers(this.#bytes, outermost);
    this.#record(
      ctx,
      'Corruption',
      'raw.bytes',
      before,
      after,
      `bit flip at byte ${byteOffset} (mask 0x${mask.toString(16).padStart(2, '0')})`,
    );
  }
}

/** Type guard used by tests/tools. */
export function isPduImpl(x: unknown): x is PduImpl {
  return x instanceof PduImpl;
}
