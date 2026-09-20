/**
 * Codec registry and the chain operations every PDU write path uses
 * (spec §4.5 "both representations are maintained; the byte buffer is authoritative").
 *
 *  • `CODECS` — name → Codec, insertion order ethernet, arp, ipv4, icmpv4, payload, hdlc, dot11,
 *    dot11-mgmt, llc, eapol.
 *  • `decodeChain(bytes, outer)` / `decodeLayers(bytes, outer)` — walks the chain from `outer`
 *    following each `DecodedLayer.next` until a codec stops (payload), the buffer ends, or
 *    `MAX_LAYERS` (32) layers were decoded. Unknown protocol names decode as `payload`. Each codec
 *    receives a `CodecContext` whose `outer` lists the layers decoded so far (outermost first).
 *    After the walk, every layer whose codec has `fixTrailer` is fixed up, innermost first (the
 *    ethernet padding fix: only the inner header knows how long it is). When the layer cap stops a
 *    chain that still had a next layer, `decodeChain` reports `truncated: true` and the last layer
 *    carries `LAYER_LIMIT_ERROR` (unless it already had an error).
 *  • `encodeLayers(specs)` / `encodeAround(specs, inner, innerProto)` — innermost-first: each codec
 *    receives the already-encoded bytes of the layer inside it and a `CodecContext` of the specs
 *    outside it (with filled link fields). When a spec omits its next-layer selector
 *    (`ethernet.type`, `ipv4.protocol`, `hdlc.protocol`, `llc.type`, `ipv6.nextHeader`, …) the value
 *    is filled from the NEXT proto's name through the dispatch tables (dispatch.ts). This is a
 *    convenience only — per the contract, processes MUST set those fields themselves.
 *  • `contextOf(layers, index)` — the `CodecContext` of an already-decoded layer (summary, mutate).
 *  • P1: the transport, IPv6 and application codecs (ipv6, its four extension headers, icmpv6, udp, tcp, dhcp,
 *    dns, http) follow the P0.5 link codecs in registry order. `decodeChain(bytes, outer, { fcsLen })` passes
 *    `fcsLen` to the OUTERMOST codec only (CodecContext.fcsLen), so a capture record whose FCS was stripped
 *    decodes without inventing one. `decodeStandalone` (contracts/pdu.ts StandaloneDecodeFn) decodes bytes with
 *    the registry alone — no PduIds — and adds the one-line summary and top protocol with the same rules as
 *    `PduView.summary()` / `topProto()` (`chainSummary` / `chainTopProto`).
 */
import type {
  Codec,
  CodecContext,
  FieldValue,
  LayerSpec,
  LayerView,
  ProtoName,
  StandaloneDecodeFn,
  StandaloneDecoded,
} from '../../contracts/pdu.js';
import { ethernetCodec } from './ethernet.js';
import { arpCodec } from './arp.js';
import { ipv4Codec } from './ipv4.js';
import { icmpv4Codec } from './icmpv4.js';
import { payloadCodec } from './payload.js';
import { hdlcCodec } from './hdlc.js';
import { dot11Codec } from './dot11.js';
import { dot11MgmtCodec } from './dot11-mgmt.js';
import { llcCodec } from './llc.js';
import { eapolCodec } from './eapol.js';
import { ipv6Codec } from './ipv6.js';
import { ipv6DstOptsCodec, ipv6FragCodec, ipv6HopOptsCodec, ipv6RouteCodec } from './ipv6-ext.js';
import { icmpv6Codec } from './icmpv6.js';
import { udpCodec } from './udp.js';
import { tcpCodec } from './tcp.js';
import { dhcpCodec } from './dhcp.js';
import { dnsCodec } from './dns.js';
import { httpCodec } from './http.js';
import { keyForProto, linkFieldFor } from './dispatch.js';

/**
 * All registered codecs, keyed by protocol name, in registry order: the five P0 codecs, then the P0.5
 * link-layer codecs (hdlc, dot11, dot11-mgmt, llc, eapol), then the P1 codecs in contracts/fields.ts order
 * (ipv6, ipv6-hopopts, ipv6-route, ipv6-frag, ipv6-dstopts, icmpv6, udp, tcp, dhcp, dns, http). Plugins may
 * `set` more.
 */
export const CODECS: Map<ProtoName, Codec> = new Map<ProtoName, Codec>([
  [ethernetCodec.proto, ethernetCodec],
  [arpCodec.proto, arpCodec],
  [ipv4Codec.proto, ipv4Codec],
  [icmpv4Codec.proto, icmpv4Codec],
  [payloadCodec.proto, payloadCodec],
  [hdlcCodec.proto, hdlcCodec],
  [dot11Codec.proto, dot11Codec],
  [dot11MgmtCodec.proto, dot11MgmtCodec],
  [llcCodec.proto, llcCodec],
  [eapolCodec.proto, eapolCodec],
  [ipv6Codec.proto, ipv6Codec],
  [ipv6HopOptsCodec.proto, ipv6HopOptsCodec],
  [ipv6RouteCodec.proto, ipv6RouteCodec],
  [ipv6FragCodec.proto, ipv6FragCodec],
  [ipv6DstOptsCodec.proto, ipv6DstOptsCodec],
  [icmpv6Codec.proto, icmpv6Codec],
  [udpCodec.proto, udpCodec],
  [tcpCodec.proto, tcpCodec],
  [dhcpCodec.proto, dhcpCodec],
  [dnsCodec.proto, dnsCodec],
  [httpCodec.proto, httpCodec],
]);

/** Codec for `proto`, or undefined when nothing is registered under that name. */
export function getCodec(proto: ProtoName): Codec | undefined {
  return CODECS.get(proto);
}

/** Codec for `proto`; throws a descriptive error when unknown (used by encode paths). */
export function requireCodec(proto: ProtoName): Codec {
  const c = CODECS.get(proto);
  if (!c) throw new Error(`no codec registered for protocol "${proto}"`);
  return c;
}

/** Hard cap on chain depth so a malicious/looping `next` can never spin forever. */
export const MAX_LAYERS = 32;

/** Error text set on the last decoded layer when the chain was cut at `MAX_LAYERS`. */
export const LAYER_LIMIT_ERROR = `layer limit of ${MAX_LAYERS} reached; inner layers were not decoded`;

/** Result of a chain walk. */
export interface DecodeChainResult {
  /** Outermost-first; `layers[0].offset === 0`. */
  layers: LayerView[];
  /** True when `MAX_LAYERS` stopped a chain that still named a next layer. */
  truncated: boolean;
}

type OuterEntry = CodecContext['outer'][number];

const EMPTY_CONTEXT: CodecContext = Object.freeze({ outer: Object.freeze([]) as readonly OuterEntry[] });

/** Options of a chain walk. */
export interface DecodeChainOptions {
  /**
   * Trailing FCS bytes present on the outermost link layer (capture records). Absent = the native convention
   * (ethernet/dot11 4, hdlc 2); 0 = stripped. Handed to the outermost codec only, as `CodecContext.fcsLen`.
   */
  fcsLen?: 0 | 2 | 4;
}

/**
 * Decode `bytes` starting with the `outer` codec and follow the chain, reporting truncation.
 * Layers are returned outermost-first; `layers[0].offset === 0`.
 */
export function decodeChain(bytes: Uint8Array, outer: ProtoName = 'ethernet', opts: DecodeChainOptions = {}): DecodeChainResult {
  const layers: LayerView[] = [];
  const outerCtx: OuterEntry[] = [];
  let proto: ProtoName = outer;
  let offset = 0;
  let bound = bytes.length;
  let truncated = false;

  while (offset <= bytes.length) {
    if (layers.length >= MAX_LAYERS) {
      truncated = true;
      break;
    }
    const known = CODECS.get(proto);
    const codec = known ?? payloadCodec;
    const layerProto: ProtoName = known ? proto : 'payload';
    const ctx: CodecContext =
      outerCtx.length === 0
        ? opts.fcsLen === undefined
          ? EMPTY_CONTEXT
          : { outer: EMPTY_CONTEXT.outer, fcsLen: opts.fcsLen }
        : { outer: outerCtx.slice() };
    const d = codec.decode(bytes, offset, bound, ctx);
    const length = d.length ?? bytes.length - offset;
    const view: LayerView = {
      proto: layerProto,
      offset,
      length,
      headerLength: d.headerLength,
      ...(d.trailerLength !== undefined ? { trailerLength: d.trailerLength } : {}),
      fields: d.fields,
      fieldRanges: d.fieldRanges,
      ...(d.error !== undefined ? { error: d.error } : {}),
    };
    layers.push(view);
    outerCtx.push({ proto: layerProto, fields: d.fields });
    if (!d.next) break;
    const nextOffset = d.next.offset;
    if (nextOffset <= offset || nextOffset > bytes.length) break; // must make progress and stay inside the buffer
    proto = d.next.proto;
    offset = nextOffset;
    bound = Math.max(0, Math.min(d.next.length ?? bytes.length - nextOffset, bytes.length - nextOffset));
  }

  fixTrailers(layers);
  if (truncated) {
    const last = layers[layers.length - 1]!;
    if (last.error === undefined) layers[layers.length - 1] = { ...last, error: LAYER_LIMIT_ERROR };
  }
  return { layers, truncated };
}

/**
 * Decode `bytes` starting with the `outer` codec and follow the chain.
 * Layers are returned outermost-first; `layers[0].offset === 0`. See `decodeChain` for truncation.
 */
export function decodeLayers(bytes: Uint8Array, outer: ProtoName = 'ethernet'): LayerView[] {
  return decodeChain(bytes, outer).layers;
}

/**
 * Index of the layer that describes a chain: the innermost layer that is neither `payload` nor a `transparent`
 * codec, never descending past a layer whose codec `stopsMeaning` (an ICMP error's quote). -1 when none.
 * Same rule as `PduView.topProto()`.
 */
export function meaningfulLayerIndex(layers: readonly LayerView[]): number {
  let best = -1;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    if (l.proto === 'payload') continue;
    const codec = CODECS.get(l.proto);
    if (codec?.transparent) continue;
    best = i;
    if (codec?.stopsMeaning?.(l.fields)) break;
  }
  return best;
}

/** Innermost meaningful protocol of a decoded chain (`payload` when none), as `PduView.topProto()`. */
export function chainTopProto(layers: readonly LayerView[]): ProtoName {
  const i = meaningfulLayerIndex(layers);
  return i < 0 ? 'payload' : layers[i]!.proto;
}

/**
 * One-line summary of a decoded chain from its meaningful layer's codec (with its CodecContext), as
 * `PduView.summary()`; `byteLength` is used when there are no layers at all.
 */
export function chainSummary(layers: readonly LayerView[], byteLength: number): string {
  const i = meaningfulLayerIndex(layers);
  if (i < 0) {
    const only = layers[0];
    if (!only) return `${byteLength} bytes`;
    return (CODECS.get(only.proto) ?? payloadCodec).summarize(only.fields, contextOf(layers, 0));
  }
  const l = layers[i]!;
  return (CODECS.get(l.proto) ?? payloadCodec).summarize(l.fields, contextOf(layers, i));
}

/**
 * Registry-only decode for NetScope rows and pcap import (contracts/pdu.ts `StandaloneDecodeFn`): no PduIds are
 * allocated and nothing is recorded. `opts.fcsLen` defaults to the native convention (ethernet/dot11 4, hdlc 2);
 * with 0 the outermost link codec bounds its payload to the remaining bytes and leaves fcs/fcsValid undefined.
 * Protocols without a codec decode as payload. Never throws for malformed bytes (codecs report `error`).
 */
export const decodeStandalone: StandaloneDecodeFn = (bytes, outer, opts): StandaloneDecoded => {
  const chainOpts: DecodeChainOptions = opts?.fcsLen !== undefined ? { fcsLen: opts.fcsLen } : {};
  const layers = decodeChain(bytes, outer, chainOpts).layers;
  return { layers, summary: chainSummary(layers, bytes.length), topProto: chainTopProto(layers) };
};

/**
 * Apply every codec's `fixTrailer` hook, innermost layer first, so an outer layer sees the
 * already-fixed view of the layer it carries.
 */
function fixTrailers(layers: LayerView[]): void {
  for (let i = layers.length - 1; i >= 0; i--) {
    const self = layers[i]!;
    const codec = CODECS.get(self.proto);
    if (codec?.fixTrailer) layers[i] = codec.fixTrailer(self, layers[i + 1]);
  }
}

/** The `CodecContext` of `layers[index]`: every layer outside it, outermost first. */
export function contextOf(layers: readonly LayerView[], index: number): CodecContext {
  if (index <= 0) return EMPTY_CONTEXT;
  const outer: OuterEntry[] = [];
  const end = Math.min(index, layers.length);
  for (let j = 0; j < end; j++) {
    const l = layers[j]!;
    outer.push({ proto: l.proto, fields: l.fields });
  }
  return { outer };
}

/**
 * Fill the next-layer selector field of `proto` (ethernet.type, ipv4.protocol, hdlc.protocol, llc.type,
 * ipv6.nextHeader, …) from `innerProto` through the dispatch tables when the caller omitted it.
 * Returns the (possibly new) fields object. Exported for `Pdu.encapsulate` / `Pdu.rewrap`, which wrap an
 * already-decoded chain whose outermost proto is known.
 */
export function fillLinkField(
  proto: ProtoName,
  fields: Record<string, FieldValue>,
  innerProto: ProtoName | undefined,
): Record<string, FieldValue> {
  if (innerProto === undefined) return fields;
  const lf = linkFieldFor(proto);
  if (!lf) return fields;
  const current = fields[lf.field];
  if (current !== undefined && current !== null) return fields;
  const key = keyForProto(lf.space, innerProto);
  return key === undefined ? fields : { ...fields, [lf.field]: key };
}

/**
 * Encode `specs` (outermost-first header specs) innermost-first around the already-encoded `inner`
 * bytes. The innermost spec's link field is filled from `innerProto`; every other spec's from the spec
 * inside it. Returns `inner` itself when `specs` is empty. Throws on an unknown proto or a codec error
 * (nothing is mutated: the caller commits only the returned bytes).
 */
export function encodeAround(specs: readonly LayerSpec[], inner: Uint8Array, innerProto?: ProtoName): Uint8Array {
  const n = specs.length;
  if (n === 0) return inner;
  const outer: OuterEntry[] = new Array<OuterEntry>(n);
  for (let i = 0; i < n; i++) {
    const spec = specs[i]!;
    const nextName = i + 1 < n ? specs[i + 1]!.proto : innerProto;
    outer[i] = { proto: spec.proto, fields: fillLinkField(spec.proto, spec.fields, nextName) };
  }
  let payload = inner;
  for (let i = n - 1; i >= 0; i--) {
    const entry = outer[i]!;
    const codec = requireCodec(entry.proto);
    const ctx: CodecContext = i === 0 ? EMPTY_CONTEXT : { outer: outer.slice(0, i) };
    payload = codec.encode(entry.fields as Record<string, FieldValue>, payload, ctx);
  }
  return payload;
}

/**
 * Encode a layer list (outermost-first, as written by builders) into wire bytes by
 * running the codecs innermost-first. Throws on an empty list or an unknown proto.
 */
export function encodeLayers(specs: readonly LayerSpec[]): Uint8Array {
  if (specs.length === 0) throw new Error('encodeLayers: at least one layer is required');
  return encodeAround(specs, new Uint8Array(0));
}
