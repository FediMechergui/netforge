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
import {
  contextOf,
  decodeLayers,
  encodeAround,
  getCodec,
  requireCodec,
} from './codecs/registry.js';

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

/** Split `"ipv4.ttl"` into proto and field name (first dot only). */
function splitPath(path: string): { proto: ProtoName; field: string } | undefined {
  const dot = path.indexOf('.');
  if (dot <= 0 || dot === path.length - 1) return undefined;
  return { proto: path.slice(0, dot), field: path.slice(dot + 1) };
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

  /** `get("ipv4.ttl")` — field of the first layer with that proto. */
  get(path: string): FieldValue | undefined {
    const p = splitPath(path);
    if (!p) return undefined;
    return this.layer(p.proto)?.fields[p.field];
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
    if (!p) throw new Error(`mutate: field path must be "<proto>.<field>", got "${field}"`);
    const old = this.#layers;
    let idx = -1;
    for (let i = 0; i < old.length; i++) {
      if (old[i]!.proto === p.proto) {
        idx = i;
        break;
      }
    }
    if (idx < 0) throw new Error(`mutate: PDU ${this.id} has no ${p.proto} layer`);
    const target = old[idx]!;
    const before = target.fields[p.field] ?? null;
    const changed: Record<string, FieldValue> = { ...target.fields, [p.field]: after };

    // 1. Re-encode from the innermost layer that must change (the innermost outerInputs dependent, or
    //    the target itself) outward. Each layer's payload is the ALREADY-ENCODED bytes of the layer
    //    inside it (never the raw gap, which would include old padding/FCS). Each codec sees the layers
    //    outside it as its CodecContext, with the target layer's fields already carrying the new value.
    const innermost = Math.max(idx, this.#innermostDependent(idx, p.proto, field));
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
    this.#record(ctx, reason, field, before, after, cause);

    // 3. Derived-field mutations, innermost re-encoded layer outward, in each codec's `derived`
    //    declaration order.
    const fresh = this.#layers;
    for (let j = innermost; j >= 0; j--) {
      const o = old[j]!;
      const n = fresh[j];
      if (!n || n.proto !== o.proto) continue;
      const derived = getCodec(n.proto)?.derived;
      if (!derived) continue;
      for (const name of Object.keys(derived)) {
        const was = o.fields[name];
        const now = n.fields[name];
        if (was === undefined && now === undefined) continue;
        if (!sameValue(was, now)) this.#record(ctx, derived[name]!, `${n.proto}.${name}`, was ?? null, now ?? null, cause);
      }
    }
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
