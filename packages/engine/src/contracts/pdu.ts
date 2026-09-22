/**
 * PDU model (spec §4.5).
 *
 * A PDU is a byte buffer (authoritative wire image) plus a decoded layer tree
 * plus a provenance log. THE INVARIANT: nothing mutates a packet without
 * appending a `Mutation`. The `Pdu` class (pdu/pdu.ts) keeps bytes and layers
 * private; `mutate()`, `encapsulate()`, `rewrap()` (P0.5) and `corrupt()` are the ONLY write paths.
 *
 * Wire-image conventions (decided for P0, keep stable):
 *   • Ethernet frames INCLUDE the 4-byte FCS at the end of `bytes`.
 *     Preamble/SFD/IFG are NOT in `bytes`; the link model adds PHY overhead
 *     when computing serialization delay.
 *   • Minimum Ethernet frame is 64 bytes incl. FCS — the ethernet codec pads.
 *   • HDLC frames include address, control, protocol and the 2-byte CRC-16 FCS (no flags) — P0.5.
 *   • 802.11 frames include the 4-byte FCS; no padding — P0.5.
 *   • Multi-byte integers are big-endian (network order).
 *   • `layers` is ALWAYS the decoder's view of `bytes` (see PduFactory).
 */
import type { DeviceId, PduId } from './ids.js';
import type { SimTime } from './time.js';

/** Known protocol layer names (no '.' allowed: `get('proto.field')` splits on the first dot). Unknown names are allowed for plugins. */
export type ProtoName =
  | 'ethernet'
  | 'arp'
  | 'ipv4'
  | 'icmpv4'
  | 'udp'
  | 'tcp'
  | 'payload'
  // ── P0.5 ──
  | 'hdlc'
  | 'dot11'
  | 'dot11-mgmt'
  | 'llc'
  | 'eapol'
  // ── P1 ──
  | 'ipv6'
  | 'ipv6-hopopts'
  | 'ipv6-route'
  | 'ipv6-frag'
  | 'ipv6-dstopts'
  | 'icmpv6'
  | 'dhcp'
  | 'dns'
  | 'http'
  // ── P2 (ARCHITECTURE-P2 §2.3; field tables in contracts/fields.ts) ──
  /** @since P2 802.1Q tag (D4): transparent framing, pushed and popped by structural rewrap. */
  | 'dot1q'
  /** @since P2 STP/RSTP BPDU (IEEE format, per VLAN, D8/D9). */
  | 'stp'
  /** @since P2 LACPDU (slow protocols, subtype 1). */
  | 'lacp'
  /** @since P2 Trunk negotiation (original NF format under the NF OUI, D8). */
  | 'dtp'
  /** @since P2 DHCPv6 (UDP 546/547). */
  | 'dhcpv6'
  /** @since P2 CAPWAP control and data (UDP 5246/5247, RFC 5415 message types). */
  | 'capwap'
  /** @since P2 [SHOULD S2] HSRP v1/v2 (UDP 1985). */
  | 'hsrp'
  /** @since P2 [SHOULD S3] Port aggregation negotiation (original NF format under the NF OUI, D8). */
  | 'pagp'
  | (string & {});

export type FieldValue = number | string | boolean | Uint8Array | null;

/** A decoded layer. Field names are dotted-path leaves per contracts/fields.ts (PROTO_FIELDS). */
export interface LayerView {
  readonly proto: ProtoName;
  /** Byte offset of this layer's header inside `Pdu.bytes`. */
  readonly offset: number;
  /** Total bytes covered by this layer from `offset` (header + everything it carries + trailer). */
  readonly length: number;
  /** Header length only (bytes). */
  readonly headerLength: number;
  /**
   * Bytes at the END of this layer's range that are not part of the next layer
   * (ethernet: padding + 4-byte FCS). `undefined` means 0. The payload of this layer is
   * `[offset+headerLength, offset+length-(trailerLength??0))`.
   */
  readonly trailerLength?: number;
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** Byte range of each field inside `bytes`, for hex-view highlighting: `[offset, length]`. */
  readonly fieldRanges: Readonly<Record<string, readonly [number, number]>>;
  /** Set when the decoder found a problem (bad checksum, truncated, 'partial' application message) — the layer is still shown. */
  readonly error?: string;
}

export type MutationReason =
  | 'TtlDecrement'
  | 'MacRewrite'
  | 'ChecksumRecompute'
  | 'FcsRecompute'
  | 'VlanTagPush'
  | 'VlanTagPop'
  | 'NatTranslate'
  | 'FragmentSplit'
  | 'Encrypt'
  | 'Decrypt'
  | 'Corruption'
  | 'Padding'
  /** An outer layer was pushed around the existing bytes (L3 packet → L2 frame). */
  | 'Encapsulate'
  | 'Other'
  /** @since P0.5 An outer layer (and its trailer) was stripped by `rewrap` (802.11 ↔ 802.3 at a radio, HDLC ↔ Ethernet at a router). */
  | 'Decapsulate';

/** One recorded field change (the backbone of the provenance visualizer §9.3). */
export interface Mutation {
  readonly at: SimTime;
  readonly device: DeviceId;
  readonly reason: MutationReason;
  /** `"<proto>.<field>"`, e.g. `"ipv4.ttl"`. For `Encapsulate`/`Decapsulate`: the proto name, e.g. `"ethernet"`. */
  readonly field: string;
  readonly before: FieldValue;
  readonly after: FieldValue;
  /** Human-readable cause: the config line, rule, or process responsible (e.g. `"ip route 0.0.0.0 0.0.0.0 10.0.0.2"`). */
  readonly cause?: string;
}

export interface PduMeta {
  /** SimTime the PDU was created. */
  readonly born: SimTime;
  /** Device that created it. */
  readonly origin: DeviceId;
  /** Id of the PDU this one was cloned from (switch flooding, segment/air fan-out). */
  readonly parent?: PduId;
  /**
   * The PDU whose existence caused this one: an ARP request triggered by a pending IPv4
   * packet, an echo reply answering a request, an ICMP error quoting an original. The
   * provenance panel uses `parent` + `triggeredBy` to assemble the "family" (ARP → ICMP chain).
   */
  readonly triggeredBy?: PduId;
  /** Flow key for "colour by conversation" (`AddrHelpersV6.flowKey` format): `"ipv4:10.0.0.1>10.0.0.2:icmp"`. */
  readonly flow?: string;
  /** Free-form tag chosen by the originating process (`"ping#3"`, `"arp-request"`, `"keepalive"`). */
  readonly tag?: string;
  /** @since P0.5 Maintenance traffic (HDLC keepalives, beacons, periodic RAs): frameTx.background; ignored by the clock clamp and sim-mode lists by default. */
  readonly background?: boolean;
  /**
   * @since P2 (optional by meaning) CAPWAP control messages after the simulated DTLS step (ARCHITECTURE-P2 §3.12): the
   * inspector labels the payload "protected (DTLS, simulated)" while still decoding it ("headers real, crypto
   * simulated", spec §4.9).
   */
  readonly protected?: true;
}

/** Read-only view handed to the UI, tables and assertions. */
export interface PduView {
  readonly id: PduId;
  /** Authoritative wire image (a copy or frozen view — callers must not write). */
  readonly bytes: Uint8Array;
  readonly layers: readonly LayerView[];
  readonly meta: PduMeta;
  readonly provenance: readonly Mutation[];
  /** Outermost-first lookup of a layer by protocol name (first match). */
  layer(proto: ProtoName): LayerView | undefined;
  /** `get("ipv4.ttl")` — first layer with that proto. */
  get(path: string): FieldValue | undefined;
  /** One-line human summary: `"ARP request who-has 10.0.0.2 tell 10.0.0.1"`, `"ICMP echo request 10.0.0.1 > 10.0.0.2 id=1 seq=1"`. */
  summary(): string;
  /** Innermost meaningful protocol, used for colouring: `'arp' | 'icmpv4' | ...` (skips transparent layers, stops at ICMP errors). */
  topProto(): ProtoName;
  /** Total bytes on the wire (bytes.length). */
  readonly size: number;
  /** Serializable snapshot for crossing the worker boundary (structured-clone safe). */
  toJSON(): PduJson;
}

export interface PduJson {
  id: PduId;
  bytes: Uint8Array;
  layers: LayerView[];
  meta: PduMeta;
  provenance: Mutation[];
  summary: string;
  topProto: ProtoName;
}

/** Spec for building a layer from fields. Unspecified fields take codec defaults (lengths, checksums are always computed). */
export interface LayerSpec {
  proto: ProtoName;
  fields: Record<string, FieldValue>;
}

/** Context passed to `Pdu.mutate` so the mutation is stamped with who/when. */
export interface MutationCtx {
  readonly now: SimTime;
  readonly device: DeviceId;
}

/** @since P0.5 Structural write: strip outer layers, push new ones. */
export interface RewrapOp {
  /** Number of outermost layers removed together with their trailers (padding/FCS). */
  strip: number;
  /** Header-only specs, OUTERMOST FIRST, encoded innermost-first around what remains. */
  push: readonly LayerSpec[];
  /**
   * @since P2 (optional by meaning) Dedicated 802.1Q provenance (D4). Without `as`, rewrap is unchanged.
   *  'vlan-push': op must be {strip:1, push:[ethernet, dot1q]}; records VlanTagPush {field:'dot1q.vid', before:null,
   *               after:vid} then FcsRecompute {field:'ethernet.fcs'} (no Decapsulate/Encapsulate triples).
   *  'vlan-pop':  op must be {strip:2, push:[ethernet]} on a frame whose layers[1] is dot1q; records VlanTagPop
   *               {field:'dot1q.vid', before:vid, after:null} then FcsRecompute.
   * Any other shape throws. Push then pop of a codec-built frame returns the original bytes; the PduId never changes.
   */
  as?: 'vlan-push' | 'vlan-pop';
}

/**
 * The mutable PDU handle used inside the engine. Only `mutate`, `encapsulate`, `rewrap`, `corrupt`
 * and `clone` change anything. Implemented by `pdu/pdu.ts`.
 */
export interface Pdu extends PduView {
  /**
   * Change one field. Appends a Mutation, re-encodes the affected layer and all
   * outer layers' derived fields (length, checksums, FCS). Derived-field updates
   * are recorded as their own `ChecksumRecompute`/`FcsRecompute` mutations so
   * the provenance panel can show them (collapsed by default).
   *
   * Re-encode contract: for layer i, the `payload` passed to `codec.encode(fields, payload)`
   * is the (already re-encoded) bytes of layer i+1, i.e. `bytes[layers[i+1].offset,
   * +layers[i+1].length)`, or an empty array for the innermost layer. NEVER the raw gap
   * `[offset+headerLength, offset+length)` of layer i — that range includes the old
   * padding and FCS, and re-encoding it would grow the frame by 4 bytes per hop.
   * After re-encoding, `offset`/`length`/`trailerLength`/`fieldRanges` of every layer
   * are recomputed by re-decoding the new bytes.
   * P1: when the mutated path is in an INNER layer's `Codec.outerInputs` (pseudo-header: ipv4.src/dst,
   * ipv6.src/dst), that inner layer is re-encoded first (recording its ChecksumRecompute). TTL/hopLimit are
   * not pseudo-header inputs, so `mutate('ipv4.ttl')` still records exactly ttl + ipv4.checksum + ethernet.fcs.
   *
   * @since P2 [SHOULD S9] Field path `'<proto>[<i>].<field>'` addresses the layer at index i (`layerAt(i)`); the plain
   * `'<proto>.<field>'` form keeps meaning "first layer of that proto". A layer inside an ICMP-error quote (any layer
   * after an icmpv4/icmpv6 layer whose codec `stopsMeaning`) is PATCHED IN PLACE, not re-encoded (the quote is the IP
   * header plus ICMP_QUOTE_PAYLOAD_BYTES):
   *  - the rewritten field's bytes are replaced; the quoted ipv4 header checksum is recomputed over its own header;
   *  - a rewritten quoted ICMP id adjusts the quoted ICMP checksum incrementally (RFC 1624);
   *  - a rewritten quoted udp port, OR a rewritten quoted ipv4 address (pseudo-header), adjusts a present non-zero
   *    quoted udp checksum incrementally;
   *  - a quoted tcp checksum (offset 16) is never inside the 8-byte quote and is never touched;
   *  - the enclosing layers re-encode as usual (icmp checksum, outer ipv4, FCS).
   * Each derived change is recorded as today (ChecksumRecompute / FcsRecompute).
   */
  mutate(ctx: MutationCtx, field: string, after: FieldValue, reason: MutationReason, cause?: string): void;
  /**
   * Push `outer` (a header-only LayerSpec, e.g. `{proto:'ethernet', fields:{dst,src,type}}`)
   * around the CURRENT `bytes`: `bytes = codec(outer.proto).encode(outer.fields, bytes)` (the
   * codec fills padding/FCS), then `layers` is rebuilt by decoding the new bytes so it becomes
   * the full chain (e.g. `[ethernet, ipv4, icmpv4, payload]`). Keeps the same PduId. Appends
   * one Mutation `{reason:'Encapsulate', field: outer.proto, before: null, after: outer.proto, cause}`.
   */
  encapsulate(ctx: MutationCtx, outer: LayerSpec, cause?: string): void;
  /** Deep copy with a new id and `meta.parent = this.id`; provenance is copied. Obtain `newId` from the factory (`PduFactory.clone`). */
  clone(newId: PduId, at: SimTime): Pdu;
  /** Flip raw bits (link corruption). Recorded as a `Corruption` mutation on `"raw.bytes"`; FCS is NOT recomputed. */
  corrupt(ctx: MutationCtx, byteOffset: number, bitMask: number): void;
  /**
   * @since P0.5 Same PduId. Takes the bytes of `layers[strip]` (its full range, dropping the outer layers'
   * headers AND trailers), encodes `push` innermost-first around them (fill-link-field from the next proto),
   * re-decodes from `push[0].proto` (or `layers[strip].proto` when `push` is empty). Records one
   * `{reason:'Decapsulate', field:<proto>, before:<proto>, after:null}` per stripped layer (outermost first),
   * then one `Encapsulate` per pushed layer (innermost first, like encapsulate).
   * @throws when `strip >= layers.length` and `push` is empty (nothing would remain).
   */
  rewrap(ctx: MutationCtx, op: RewrapOp, cause?: string): void;
  /** @since P0.5 Layer by index (duplicated protos: ICMP quotes, tunnels). */
  layerAt(index: number): LayerView | undefined;
}

/** Result of decoding one layer. */
export interface DecodedLayer {
  fields: Record<string, FieldValue>;
  fieldRanges: Record<string, readonly [number, number]>;
  headerLength: number;
  /**
   * Bytes covered by this layer including payload (and trailer); defaults to
   * `bytes.length - offset`. NOTE: because `bytes` ends with the Ethernet FCS, every
   * inner codec MUST set `length` explicitly from its own header (ipv4 totalLength,
   * arp = 28, icmp/payload = the `length` argument passed to `decode`); relying on the
   * default would swallow padding + FCS.
   */
  length?: number;
  /** Trailer bytes owned by this layer after its payload (ethernet: padding + FCS). Default 0. */
  trailerLength?: number;
  /** Next protocol to decode, or undefined to stop (payload). `length` is an UPPER BOUND for the inner layer. */
  next?: { proto: ProtoName; offset: number; length?: number };
  error?: string;
}

/** @since P1 Enclosing layers, outermost first, as seen by the codec of the layer being decoded/encoded/summarized. */
export interface CodecContext {
  readonly outer: readonly { readonly proto: ProtoName; readonly fields: Readonly<Record<string, FieldValue>> }[];
  /**
   * @since P1 Trailing FCS bytes present on the OUTERMOST link layer (`decodeStandalone` opts.fcsLen; set only for
   * the layer at offset 0). Absent = the codec's native FCS (ethernet/dot11 4, hdlc 2). 0 = no FCS in the bytes:
   * the link codec bounds its payload to the remaining bytes and leaves fcs/fcsValid undefined.
   */
  readonly fcsLen?: 0 | 2 | 4;
}

/**
 * @since P0.5 Next-protocol dispatch number spaces shared by several codecs (pdu/codecs/dispatch.ts, data in
 * contracts/fields.ts DISPATCH_TABLE): 'ethertype' (ethernet.type, llc.type, hdlc.protocol), 'ipproto'
 * (ipv4.protocol, ipv6.nextHeader, extension nextHeader), 'udp.port' / 'tcp.port' (destination port first,
 * then source port, only when the transport payload is ≥ 1 byte).
 * @since P2 'llc.sap' (llc.dsap of a non-SNAP LLC header) and 'nf.pid' (llc.type when llc.oui is NF_OUI).
 */
export type DispatchSpace = 'ethertype' | 'ipproto' | 'udp.port' | 'tcp.port' | 'llc.sap' | 'nf.pid' | (string & {});

/** A protocol codec. Registered in `pdu/codecs/registry.ts`. Pure functions — no engine state. */
export interface Codec {
  readonly proto: ProtoName;
  /** Decode the layer starting at `offset`. `length` bounds the layer when known from the outer header. `ctx` @since P1. */
  decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer;
  /**
   * Encode the layer header for `fields` around an already-encoded `payload`.
   * Must fill defaults (version, header length, total length, checksum, FCS,
   * padding) and return header+payload(+trailer) bytes. `ctx` @since P1 (pseudo-header checksums).
   */
  encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array;
  /** Field defaults shown to builders and validators. */
  readonly defaults: Readonly<Record<string, FieldValue>>;
  /** Human summary of this layer for `PduView.summary()`. `ctx` @since P1 (addresses from enclosing IP). */
  summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string;
  /** @since P1 Derived fields → provenance reason (replaces the hard-coded DERIVED map in pdu/pdu.ts). Bare field names. */
  readonly derived?: Readonly<Record<string, MutationReason>>;
  /** @since P1 Outer field paths that feed this layer's encoding (pseudo-header): a mutate of one re-encodes this layer. */
  readonly outerInputs?: readonly string[];
  /** @since P1 summary()/topProto() stop descending at this layer (ICMP errors quoting a datagram). */
  stopsMeaning?(fields: Readonly<Record<string, FieldValue>>): boolean;
  /** @since P0.5 Framing glue skipped by topProto (llc). */
  readonly transparent?: boolean;
  /** @since P0.5 Trailer fix-up after the chain walk (generalises the ethernet padding fix; dot11/hdlc FCS). */
  fixTrailer?(self: LayerView, inner: LayerView | undefined): LayerView;
}

/**
 * Factory used by processes (via `ProcessCtx.newPdu` / `ProcessCtx.clone`) and by the
 * decoder on frame arrival. The ONLY source of `PduId`s: one monotonic counter per
 * simulation. The Simulation wraps the instance it hands to devices to maintain its
 * id → Pdu registry and `SimSnapshot.pduCount`.
 *
 * PINNED INVARIANT: `build` encodes innermost-first via each codec's `encode`, then
 * DECODES the resulting bytes; `layers` is ALWAYS the decoder's view of `bytes`, never
 * the LayerSpec list. The same holds after `mutate`, `encapsulate` and `rewrap`. (So a `payload`
 * layer whose `data` happens to be an encoded IPv4 packet is still shown as `payload` —
 * use `Pdu.encapsulate` to wrap.)
 */
export interface PduFactory {
  build(layers: readonly LayerSpec[], meta: PduMeta): Pdu;
  decode(bytes: Uint8Array, meta: PduMeta, outer?: ProtoName): Pdu;
  /** `pdu.clone(<next id>, at)` — fresh id from the factory counter, `meta.parent = pdu.id`, provenance copied. */
  clone(pdu: Pdu, at: SimTime): Pdu;
}

/** @since P1 Registry-only decode without allocating PduIds (NetScope rows, pcap import): pdu/codecs/registry.ts `decodeStandalone`. */
export interface StandaloneDecoded {
  layers: LayerView[];
  summary: string;
  topProto: ProtoName;
}
/**
 * `opts.fcsLen` defaults to the pdu.ts convention (ethernet/dot11 4, hdlc 2). With 0, the ethernet/dot11/hdlc
 * codecs bound the payload to the remaining bytes, leave fcs/fcsValid undefined, and still report padding.
 */
export type StandaloneDecodeFn = (bytes: Uint8Array, outer: ProtoName, opts?: { fcsLen?: 0 | 2 | 4 }) => StandaloneDecoded;

/** Ethertypes and IP protocol numbers used across modules. */
export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const ETHERTYPE_VLAN = 0x8100;
export const ETHERTYPE_IPV6 = 0x86dd;
/** @since P0.5 */
export const ETHERTYPE_EAPOL = 0x888e;
export const IPPROTO_ICMP = 1;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
/** @since P1 IPv6 next-header values. */
export const IPPROTO_HOPOPTS = 0;
export const IPPROTO_ROUTING = 43;
export const IPPROTO_FRAGMENT = 44;
export const IPPROTO_ICMPV6 = 58;
export const IPPROTO_NONE = 59;
export const IPPROTO_DSTOPTS = 60;

export const ETH_MIN_FRAME = 64; // incl. FCS
export const ETH_MAX_FRAME = 1518; // incl. FCS, untagged
export const ETH_HEADER = 14;
export const ETH_FCS = 4;
export const ETH_PHY_OVERHEAD = 20; // preamble 7 + SFD 1 + IFG 12, added by the link model for timing only

/** @since P0.5 HDLC framing (no flags in `bytes`): address + control + protocol, CRC-16 FCS. */
export const HDLC_HEADER = 4;
export const HDLC_FCS = 2;
/** @since P0.5 Serial PHY overhead for timing (opening/closing flags). */
export const HDLC_PHY_OVERHEAD = 2;
export const HDLC_ADDRESS_UNICAST = 0x0f;
export const HDLC_ADDRESS_BROADCAST = 0x8f;
export const HDLC_PROTO_IPV4 = 0x0800;
export const HDLC_PROTO_IPV6 = 0x86dd;
/** Keepalive (SLARP-like) frames: 12-byte payload (myseq u32, yourseq u32, reliability u16, reserved u16). */
export const HDLC_PROTO_KEEPALIVE = 0x8035;
/** @since P0.5 802.11 MAC header (3-address data/mgmt) and FCS; max MPDU incl. FCS. */
export const DOT11_HEADER = 24;
export const DOT11_FCS = 4;
export const DOT11_MAX_FRAME = 2346;
export const LLC_SNAP_HEADER = 8;

/**
 * CANONICAL LAYER FIELD NAMES — the string contract between the `pdu` codecs and every
 * process that reads `pdu.get('<proto>.<field>')` or builds via `LayerSpec.fields`.
 * Codecs decode/encode EXACTLY these keys; processes use EXACTLY these keys. Do not alias.
 * The machine-readable table for EVERY proto (P0, P0.5, P1 — incl. the docs/FIELDS.md corrections)
 * is `PROTO_FIELDS` in contracts/fields.ts; the P0 entries below are kept verbatim for reference.
 *
 *  ethernet : dst (MacAddress), src (MacAddress), type (u16 ethertype),
 *             fcs (u32, decode-only), fcsValid (boolean, decode-only), padding (number of pad bytes, decode-only)
 *  arp      : htype (u16, default 1), ptype (u16, default 0x0800), hlen (u8, default 6), plen (u8, default 4),
 *             op (u16: ARP_OP_REQUEST | ARP_OP_REPLY), sha (MacAddress), spa (Ipv4Address),
 *             tha (MacAddress), tpa (Ipv4Address)
 *  ipv4     : version (4), ihl (derived), dscp (u6, default 0), ecn (u2, default 0), totalLength (derived),
 *             id (u16, default 0), flags (u3, default 0), fragOffset (u13, default 0),
 *             ttl (u8, default IPV4_DEFAULT_TTL_HOST), protocol (u8, REQUIRED from builder),
 *             checksum (derived), checksumValid (boolean, decode-only), src (Ipv4Address, REQUIRED), dst (Ipv4Address, REQUIRED)
 *  icmpv4   : type (u8), code (u8), checksum (derived), checksumValid (boolean, decode-only);
 *             echo request/reply (type 8/0): id (u16), seq (u16);
 *             dest-unreachable (3) / time-exceeded (11): unused (u32, default 0), and the codec chains
 *             `next → { proto: 'ipv4', offset: hdr+8, length: min(remaining, quoteLen) }` so the quoted
 *             original header (+8 bytes of its payload) appears as nested `ipv4` → `icmpv4` layers.
 *             `layer(proto)` is outermost-first, so the quoted inner layers are found by index
 *             (the layers after the error icmpv4 layer), not by `layer('ipv4')`.
 *  payload  : data (Uint8Array)
 *
 * Rules:
 *  • Derived fields (ihl, totalLength, checksum, fcs, padding) are ALWAYS recomputed by encode();
 *    any value passed for them in `LayerSpec.fields` is ignored.
 *  • Builders MUST set `ethernet.type` and `ipv4.protocol` explicitly (e.g. ETHERTYPE_IPV4, IPPROTO_ICMP).
 *    `Codec.encode` only sees payload bytes and cannot infer them; `PduFactory.build` MAY fill them from
 *    the next layer's `proto` when absent, but processes must not rely on that.
 *  • Outer codecs pass `next.length` as an UPPER BOUND (ethernet: bytes.length - offset - ETH_HEADER - ETH_FCS,
 *    which includes any padding). Inner codecs set their own `DecodedLayer.length` from their header when
 *    they have one — ipv4: `min(totalLength, bound)`; arp: `min(28, bound)` — so trailing Ethernet padding is
 *    never attributed to the inner layer and `mutate()` re-encoding never double-pads. Set `error` only when
 *    `bound < headerLength` (header itself truncated), not when a quoted header's totalLength exceeds the bound.
 *  • List-valued fields stay SCALAR strings (DNS records ';'-joined, DHCP dnsServers comma-separated, HTTP
 *    headers '\n'-joined). FieldValue never grows an array member.
 */
export const ARP_OP_REQUEST = 1;
export const ARP_OP_REPLY = 2;

export const ICMP_ECHO_REPLY = 0;
export const ICMP_DEST_UNREACHABLE = 3;
export const ICMP_ECHO_REQUEST = 8;
export const ICMP_TIME_EXCEEDED = 11;
export const ICMP_UNREACH_NET = 0;
export const ICMP_UNREACH_HOST = 1;
/** @since P1 */
export const ICMP_UNREACH_PROTOCOL = 2;
/** @since P1 Traceroute end: UDP to a closed port. */
export const ICMP_UNREACH_PORT = 3;
/** @since P1 */
export const ICMP_UNREACH_FRAG_NEEDED = 4;
/** @since P1 */
export const ICMP_UNREACH_ADMIN = 13;
export const ICMP_TTL_EXCEEDED_TRANSIT = 0;

/** @since P1 ICMPv6 types and codes. */
export const ICMPV6_DEST_UNREACHABLE = 1;
export const ICMPV6_PACKET_TOO_BIG = 2;
export const ICMPV6_TIME_EXCEEDED = 3;
export const ICMPV6_PARAM_PROBLEM = 4;
export const ICMPV6_ECHO_REQUEST = 128;
export const ICMPV6_ECHO_REPLY = 129;
export const ICMPV6_RS = 133;
export const ICMPV6_RA = 134;
export const ICMPV6_NS = 135;
export const ICMPV6_NA = 136;
export const ICMPV6_UNREACH_NO_ROUTE = 0;
export const ICMPV6_UNREACH_ADDRESS = 3;
export const ICMPV6_UNREACH_PORT = 4;

/** Host (NF-PC) default TTL; the pcRouterPc acceptance test expects `ipv4.ttl 128→127`. */
export const IPV4_DEFAULT_TTL_HOST = 128;
/** Router-originated packets (ICMP errors, router pings). */
export const IPV4_DEFAULT_TTL_ROUTER = 255;
/** @since P1 */
export const IPV6_DEFAULT_HOP_LIMIT = 64;
export const IPV6_ROUTER_HOP_LIMIT = 255;
/** ND messages always use 255. */
export const IPV6_ND_HOP_LIMIT = 255;
export const IPV6_MIN_MTU = 1280;
export const IPV6_HEADER = 40;
export const UDP_HEADER = 8;
export const TCP_MIN_HEADER = 20;

/** @since P1 Well-known ports (full dispatch table: contracts/fields.ts DISPATCH_TABLE). */
export const UDP_PORT_DNS = 53;
export const UDP_PORT_DHCP_SERVER = 67;
export const UDP_PORT_DHCP_CLIENT = 68;
export const TCP_PORT_DNS = 53;
export const TCP_PORT_HTTP = 80;
export const TCP_PORT_HTTP_ALT = 8080;
export const TRACEROUTE_BASE_PORT = 33434;

/** Number of bytes of the original datagram's payload quoted in ICMP error messages (RFC 792). */
export const ICMP_QUOTE_PAYLOAD_BYTES = 8;

// ── P2 wire constants (ARCHITECTURE-P2 §2.3, D8) ─────────────────────────────

/** @since P2 Slow protocols ethertype (LACP subtype 1). */
export const ETHERTYPE_SLOW_PROTOCOLS = 0x8809;
/** @since P2 Size of an 802.1Q tag. */
export const DOT1Q_HEADER = 4;
/** @since P2 Largest tagged Ethernet frame incl. FCS at MTU 1500. */
export const ETH_MAX_FRAME_TAGGED = 1522;
/** @since P2 ethernet.type (and dot1q.type) values up to this are an 802.3 LENGTH, not an ethertype. */
export const ETH_LENGTH_MAX = 0x05dc;
/** @since P2 LLC SAP of spanning-tree BPDUs. */
export const LLC_SAP_STP = 0x42;
/** @since P2 Spanning-tree group address. */
export const STP_GROUP_MAC = '01:80:c2:00:00:00';
/** @since P2 Slow protocols group address (LACP). */
export const SLOW_PROTOCOLS_MAC = '01:80:c2:00:00:02';
/** @since P2 Locally administered NF OUI (D8), also used by the dot11 simulation element 221. */
export const NF_OUI = 0x024e46;
/** @since P2 NF L2 control group (DTP, VTP, PAgP in their NF formats). */
export const NF_L2_CONTROL_MAC = '03:4e:46:00:00:01';
/** @since P2 NF SNAP PID of trunk negotiation. */
export const NF_PID_DTP = 0x0001;
/** @since P2 [SHOULD S3] NF SNAP PID of port aggregation negotiation. */
export const NF_PID_PAGP = 0x0003;
/** @since P2 [SHOULD S2] HSRP UDP port (IANA). */
export const UDP_PORT_HSRP = 1985;
/** @since P2 [SHOULD S2] HSRP version 1 group (IANA all-routers). */
export const HSRP_V1_GROUP = '224.0.0.2';
/** @since P2 [SHOULD S2] HSRP version 2 group (IANA). */
export const HSRP_V2_GROUP = '224.0.0.102';
/** @since P2 [SHOULD S2] HSRP v1 virtual MAC prefix; v1 MAC = prefix + group as 2 hex digits (a protocol fact, D8). */
export const HSRP_V1_MAC_PREFIX = '00:00:0c:07:ac:';
/** @since P2 [SHOULD S2] HSRP v2 virtual MAC prefix; v2 MAC = prefix + group as 3 hex digits, 0-4095 (a protocol fact, D8). */
export const HSRP_V2_MAC_PREFIX = '00:00:0c:9f:f';
/** @since P2 DHCPv6 client port. */
export const UDP_PORT_DHCPV6_CLIENT = 546;
/** @since P2 DHCPv6 server/relay port. */
export const UDP_PORT_DHCPV6_SERVER = 547;
/** @since P2 All DHCPv6 relay agents and servers (link scope). */
export const DHCPV6_ALL_AGENTS = 'ff02::1:2';
/** @since P2 CAPWAP control channel. */
export const UDP_PORT_CAPWAP_CONTROL = 5246;
/** @since P2 CAPWAP data channel. */
export const UDP_PORT_CAPWAP_DATA = 5247;
/** @since P2 RFC 5415 §4.5.1 / RFC 5416 message types used (D8). */
export const CAPWAP_MSG = Object.freeze({
  discoveryReq: 1,
  discoveryResp: 2,
  joinReq: 3,
  joinResp: 4,
  configStatusReq: 5,
  configStatusResp: 6,
  wtpEventReq: 9,
  wtpEventResp: 10,
  changeStateReq: 11,
  changeStateResp: 12,
  echoReq: 13,
  echoResp: 14,
  wlanConfigReq: 3398913,
  wlanConfigResp: 3398914,
});
