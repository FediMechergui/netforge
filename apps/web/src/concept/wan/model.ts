/**
 * [S22] WAN and VPN explorer model (ARCHITECTURE-P3C §7 W1b web-concept (a), §8.1 S22, §10.2): pure, DOM-free
 * functions behind the WAN and VPN concept tool. The canvas draws a provider's network as one cloud, so this is where a
 * learner sees what happens inside it: the WAN kinds compared, the VPN kinds and the bytes each one adds, and the label
 * stack a packet carries across a label-switched provider core.
 *
 * Four parts:
 *  - **WAN kinds** (`WAN_KINDS`, `compareWanKinds`): the private services and the internet access kinds of lesson 21,
 *    each with the same named properties, so any two compare row by row.
 *  - **VPN kinds** (`VPN_KINDS`, `encapsulate`, `maxInnerPacket`): who builds the tunnel, whether it encrypts, whether
 *    routing protocols cross it, and the exact layers (with their sizes) that wrap one inner packet. ESP padding follows
 *    the cipher's 16-byte block, so the overhead depends on the packet's length.
 *  - **Label stacks** (`applyLabelOp`, `applyLabelOps`, `walkLsp`, `encodeLabelEntry`): the 32-bit label entry
 *    (label 20 bits, traffic class 3, bottom-of-stack 1, TTL 8), push, swap and pop with the TTL rules, and a walk of a
 *    provider path hop by hop, with or without penultimate-hop popping.
 *  - **Quiz** (`wanQuiz`, `scoreWanQuiz`): a seeded multiple-choice quiz over all three; the same seed always asks the
 *    same questions in the same order, with the options in the same places.
 *
 * Every figure is computed here; the tool only draws it. Every result is also a sentence of text (no colour-only
 * meaning). All wording is original; no vendor or product is named.
 */

// ── WAN kinds ───────────────────────────────────────────────────────────────

/** The WAN kinds the explorer compares (lesson 21). */
export type WanKindId = 'leased-line' | 'mpls' | 'metro-ethernet' | 'dsl' | 'cable' | 'fibre' | 'cellular' | 'satellite';

/** A private service with promised performance, or internet access (usually with a VPN on top). */
export type WanFamily = 'private' | 'internet';

/** Three-step scale used by the comparison rows. */
export type WanLevel = 'low' | 'medium' | 'high';

export interface WanKind {
  readonly id: WanKindId;
  readonly label: string;
  readonly family: WanFamily;
  /** What the site plugs into. */
  readonly medium: string;
  /** Bandwidth promised in a contract (true) or a shared best-effort maximum (false). */
  readonly guaranteed: boolean;
  /** The same speed up and down. */
  readonly symmetric: boolean;
  readonly delay: WanLevel;
  readonly cost: WanLevel;
  /** How long a new site waits for it. */
  readonly install: string;
  readonly bestFor: string;
  readonly watchOut: string;
}

export const WAN_KINDS: readonly WanKind[] = Object.freeze([
  {
    id: 'leased-line',
    label: 'Leased line',
    family: 'private',
    medium: 'A dedicated circuit, handed over as a serial or Ethernet port',
    guaranteed: true,
    symmetric: true,
    delay: 'low',
    cost: 'high',
    install: 'weeks',
    bestFor: 'Two sites that need a fixed, predictable path between them',
    watchOut: 'It costs the same used or idle, and every new site needs a circuit of its own.',
  },
  {
    id: 'mpls',
    label: 'MPLS',
    family: 'private',
    medium: 'One connection into a provider core that forwards by short labels',
    guaranteed: true,
    symmetric: true,
    delay: 'low',
    cost: 'high',
    install: 'weeks',
    bestFor: 'Many sites that all reach each other, with voice given priority by class of service',
    watchOut: 'The provider runs the core; you see only your own sites, not how the labels are chosen.',
  },
  {
    id: 'metro-ethernet',
    label: 'Metro Ethernet',
    family: 'private',
    medium: 'An ordinary Ethernet port joined to sites across a city or region',
    guaranteed: true,
    symmetric: true,
    delay: 'low',
    cost: 'medium',
    install: 'weeks',
    bestFor: 'Sites in one region that should behave as if they shared one switch',
    watchOut: 'It reaches only as far as the provider\'s regional network.',
  },
  {
    id: 'dsl',
    label: 'DSL',
    family: 'internet',
    medium: 'Telephone copper to the local exchange',
    guaranteed: false,
    symmetric: false,
    delay: 'medium',
    cost: 'low',
    install: 'days',
    bestFor: 'A small branch with a site-to-site VPN',
    watchOut: 'Faster down than up, and slower the farther the site is from the exchange.',
  },
  {
    id: 'cable',
    label: 'Cable',
    family: 'internet',
    medium: 'The coax of the television network',
    guaranteed: false,
    symmetric: false,
    delay: 'medium',
    cost: 'low',
    install: 'days',
    bestFor: 'A small branch or home office with a VPN',
    watchOut: 'The neighbourhood shares the cable, so evenings can be slower.',
  },
  {
    id: 'fibre',
    label: 'Fibre to the premises',
    family: 'internet',
    medium: 'An optical line to an optical terminal on site',
    guaranteed: false,
    symmetric: true,
    delay: 'low',
    cost: 'medium',
    install: 'weeks',
    bestFor: 'A busy branch that wants the fastest, steadiest internet access',
    watchOut: 'Where no fibre is laid yet, the wait can be long.',
  },
  {
    id: 'cellular',
    label: 'Cellular (4G, 5G)',
    family: 'internet',
    medium: 'A radio modem on the mobile network',
    guaranteed: false,
    symmetric: false,
    delay: 'medium',
    cost: 'medium',
    install: 'hours',
    bestFor: 'A backup link, a vehicle or a temporary site',
    watchOut: 'Speed changes with signal and load, and data plans may cap the volume.',
  },
  {
    id: 'satellite',
    label: 'Satellite',
    family: 'internet',
    medium: 'A dish pointed at a satellite',
    guaranteed: false,
    symmetric: false,
    delay: 'high',
    cost: 'high',
    install: 'days',
    bestFor: 'A place nothing else reaches',
    watchOut: 'The long delay hurts voice and anything that waits for replies.',
  },
] satisfies WanKind[]);

/** The kind with this id. */
export function wanKind(id: WanKindId): WanKind {
  const k = WAN_KINDS.find((w) => w.id === id);
  if (k === undefined) throw new Error(`unknown WAN kind ${id}`);
  return k;
}

/** One row of a side-by-side comparison. */
export interface WanCompareRow {
  readonly property: string;
  readonly values: readonly string[];
  /** True when the kinds compared do not all have the same value. */
  readonly differs: boolean;
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

/** The properties of `ids` side by side, one row per property, each marked when the kinds differ. */
export function compareWanKinds(ids: readonly WanKindId[]): WanCompareRow[] {
  const kinds = ids.map(wanKind);
  const row = (property: string, of: (k: WanKind) => string): WanCompareRow => {
    const values = kinds.map(of);
    return { property, values, differs: new Set(values).size > 1 };
  };
  return [
    row('Family', (k) => (k.family === 'private' ? 'private WAN service' : 'internet access')),
    row('What the site plugs into', (k) => k.medium),
    row('Bandwidth promised in a contract', (k) => yesNo(k.guaranteed)),
    row('Same speed both ways', (k) => yesNo(k.symmetric)),
    row('Delay', (k) => k.delay),
    row('Cost', (k) => k.cost),
    row('Time to install', (k) => k.install),
    row('Best for', (k) => k.bestFor),
    row('Watch out', (k) => k.watchOut),
  ];
}

// ── VPN kinds and their bytes ───────────────────────────────────────────────

/** The VPN kinds the explorer compares (lessons 21, 23, 24 and 25). */
export type VpnKindId = 'gre' | 'ipsec-site' | 'gre-over-ipsec' | 'remote-ipsec' | 'remote-tls' | 'mpls-l3vpn' | 'mpls-l2vpn';

export interface VpnKind {
  readonly id: VpnKindId;
  readonly label: string;
  readonly scope: 'site-to-site' | 'remote-access';
  /** Who builds and runs it. */
  readonly builtBy: 'customer' | 'provider';
  readonly encrypts: boolean;
  /** Whether a routing protocol's multicast hellos can cross it, as a sentence. */
  readonly routing: string;
  readonly summary: string;
}

export const VPN_KINDS: readonly VpnKind[] = Object.freeze([
  {
    id: 'gre',
    label: 'GRE tunnel',
    scope: 'site-to-site',
    builtBy: 'customer',
    encrypts: false,
    routing: 'Yes: the tunnel is one more link, so hellos cross it.',
    summary: 'A virtual link between two routers. It builds a path and hides nothing.',
  },
  {
    id: 'ipsec-site',
    label: 'Site-to-site IPsec',
    scope: 'site-to-site',
    builtBy: 'customer',
    encrypts: true,
    routing: 'With a tunnel interface, yes; with a policy that only lists traffic to protect, no.',
    summary: 'The edge routers agree keys with IKE and wrap every packet in ESP, tunnel mode.',
  },
  {
    id: 'gre-over-ipsec',
    label: 'GRE over IPsec',
    scope: 'site-to-site',
    builtBy: 'customer',
    encrypts: true,
    routing: 'Yes: GRE carries the hellos and IPsec protects the GRE packets.',
    summary: 'A GRE tunnel whose packets are protected by ESP in transport mode.',
  },
  {
    id: 'remote-ipsec',
    label: 'Remote access, IPsec client',
    scope: 'remote-access',
    builtBy: 'customer',
    encrypts: true,
    routing: 'No: one user\'s laptop, which receives a route or two from the edge.',
    summary: 'Client software on a laptop builds its own tunnel to the company edge, usually from behind address translation.',
  },
  {
    id: 'remote-tls',
    label: 'Remote access, TLS',
    scope: 'remote-access',
    builtBy: 'customer',
    encrypts: true,
    routing: 'No: one user\'s session.',
    summary: 'A laptop reaches the company edge over TLS, through a client or a web browser.',
  },
  {
    id: 'mpls-l3vpn',
    label: 'MPLS layer 3 VPN (provider)',
    scope: 'site-to-site',
    builtBy: 'provider',
    encrypts: false,
    routing: 'Yes, with the provider: each site exchanges routes with its provider edge router.',
    summary: 'The provider keeps each customer\'s routes apart and carries the packets across its core under two labels.',
  },
  {
    id: 'mpls-l2vpn',
    label: 'MPLS layer 2 VPN (provider)',
    scope: 'site-to-site',
    builtBy: 'provider',
    encrypts: false,
    routing: 'Yes: the sites see one Ethernet segment, so their routers peer directly.',
    summary: 'The provider carries whole Ethernet frames between sites, under two labels and a control word.',
  },
] satisfies VpnKind[]);

/** The kind with this id. */
export function vpnKind(id: VpnKindId): VpnKind {
  const k = VPN_KINDS.find((v) => v.id === id);
  if (k === undefined) throw new Error(`unknown VPN kind ${id}`);
  return k;
}

/** IPv4 header without options. */
export const IPV4_HEADER = 20;
/** The basic GRE header (no key, no checksum). */
export const GRE_HEADER = 4;
/** ESP's SPI and sequence number. */
export const ESP_HEADER = 8;
/** The example cipher's initialisation vector (AES in CBC mode). */
export const ESP_IV = 16;
/** Pad length and next header. */
export const ESP_TRAILER = 2;
/** The example integrity check value (a SHA-256 HMAC cut to 128 bits). */
export const ESP_ICV = 16;
/** The cipher's block: the encrypted part is a whole number of blocks. */
export const ESP_BLOCK = 16;
export const UDP_HEADER = 8;
export const TCP_HEADER = 20;
/** A TLS record's type, version and length. */
export const TLS_RECORD_HEADER = 5;
/** The example authenticated cipher's tag. */
export const TLS_TAG = 16;
/** One label stack entry. */
export const LABEL_ENTRY_BYTES = 4;
/** The pseudowire control word. */
export const CONTROL_WORD = 4;
/** An Ethernet header without a VLAN tag (the frame a layer 2 VPN carries). */
export const ETHERNET_HEADER = 14;

/** One layer of an encapsulated packet, outermost first. */
export interface EncapLayer {
  readonly name: string;
  readonly bytes: number;
  /** The customer's own packet (exactly one layer per encapsulation). */
  readonly inner?: boolean;
  /** Hidden from anyone on the path. */
  readonly encrypted?: boolean;
}

export interface Encapsulation {
  readonly kind: VpnKindId;
  readonly inner: number;
  readonly layers: readonly EncapLayer[];
  /** Bytes on the provider's link (the outer packet, without the link's own frame). */
  readonly total: number;
  /** `total - inner`. */
  readonly overhead: number;
}

/** ESP padding that makes `(protected + pad + trailer)` a whole number of cipher blocks. */
export function espPadding(protectedBytes: number): number {
  return (ESP_BLOCK - ((protectedBytes + ESP_TRAILER) % ESP_BLOCK)) % ESP_BLOCK;
}

/** ESP around `protectedLayers` (the encrypted part), padded to the block, outermost first. */
function esp(protectedLayers: readonly EncapLayer[]): EncapLayer[] {
  const size = protectedLayers.reduce((n, l) => n + l.bytes, 0);
  return [
    { name: 'ESP header', bytes: ESP_HEADER },
    { name: 'IV', bytes: ESP_IV },
    ...protectedLayers.map((l) => ({ ...l, encrypted: true })),
    { name: 'ESP padding', bytes: espPadding(size), encrypted: true },
    { name: 'ESP trailer', bytes: ESP_TRAILER, encrypted: true },
    { name: 'Integrity check', bytes: ESP_ICV },
  ];
}

/** The layers that carry one inner IPv4 packet of `inner` bytes through a VPN of kind `kind`. */
export function encapsulate(kind: VpnKindId, inner: number): Encapsulation {
  const packet: EncapLayer = { name: 'Inner IPv4 packet', bytes: inner, inner: true };
  let layers: EncapLayer[];
  switch (kind) {
    case 'gre':
      layers = [{ name: 'Outer IPv4 header', bytes: IPV4_HEADER }, { name: 'GRE header', bytes: GRE_HEADER }, packet];
      break;
    case 'ipsec-site':
      layers = [{ name: 'Outer IPv4 header', bytes: IPV4_HEADER }, ...esp([packet])];
      break;
    case 'gre-over-ipsec':
      layers = [{ name: 'Outer IPv4 header', bytes: IPV4_HEADER }, ...esp([{ name: 'GRE header', bytes: GRE_HEADER }, packet])];
      break;
    case 'remote-ipsec':
      layers = [{ name: 'Outer IPv4 header', bytes: IPV4_HEADER }, { name: 'UDP header (crosses address translation)', bytes: UDP_HEADER }, ...esp([packet])];
      break;
    case 'remote-tls':
      layers = [
        { name: 'Outer IPv4 header', bytes: IPV4_HEADER },
        { name: 'TCP header', bytes: TCP_HEADER },
        { name: 'TLS record header', bytes: TLS_RECORD_HEADER },
        { ...packet, encrypted: true },
        { name: 'TLS tag', bytes: TLS_TAG },
      ];
      break;
    case 'mpls-l3vpn':
      layers = [{ name: 'Transport label', bytes: LABEL_ENTRY_BYTES }, { name: 'VPN label', bytes: LABEL_ENTRY_BYTES }, packet];
      break;
    case 'mpls-l2vpn':
      layers = [
        { name: 'Transport label', bytes: LABEL_ENTRY_BYTES },
        { name: 'VPN label', bytes: LABEL_ENTRY_BYTES },
        { name: 'Control word', bytes: CONTROL_WORD },
        { name: 'Customer Ethernet header', bytes: ETHERNET_HEADER },
        packet,
      ];
      break;
  }
  const total = layers.reduce((n, l) => n + l.bytes, 0);
  return { kind, inner, layers: Object.freeze(layers), total, overhead: total - inner };
}

/** The largest inner packet that crosses a link of `mtu` bytes whole (0 when none fits). */
export function maxInnerPacket(kind: VpnKindId, mtu = 1500): number {
  for (let inner = mtu; inner > 0; inner--) if (encapsulate(kind, inner).total <= mtu) return inner;
  return 0;
}

// ── label stacks ────────────────────────────────────────────────────────────

/** Largest label value (20 bits). */
export const MAX_LABEL = 0xfffff;
/** Labels 0–15 are reserved for special meanings; a router never hands them out for a path. */
export const FIRST_UNRESERVED_LABEL = 16;

/** One label stack entry. */
export interface LabelEntry {
  /** 20 bits. */
  readonly label: number;
  /** Traffic class, 3 bits (used for class of service). */
  readonly tc: number;
  /** Bottom of stack: set on the last entry only. */
  readonly bottom: boolean;
  readonly ttl: number;
}

/** A label stack, top entry first. */
export type LabelStack = readonly LabelEntry[];

/** A packet's label state: its stack and the TTL of the IP header underneath. */
export interface LabelState {
  readonly stack: LabelStack;
  readonly ipTtl: number;
}

export type LabelOp =
  | { readonly op: 'push'; readonly label: number; readonly tc?: number }
  | { readonly op: 'swap'; readonly label: number }
  | { readonly op: 'pop' };

export type LabelResult = { readonly ok: true; readonly state: LabelState } | { readonly ok: false; readonly error: string };

/** Why `label` cannot be pushed or swapped in, or null when it can. */
export function labelError(label: number): string | null {
  if (!Number.isInteger(label) || label < 0 || label > MAX_LABEL) return `A label is a whole number from 0 to ${MAX_LABEL}.`;
  if (label < FIRST_UNRESERVED_LABEL) return 'Labels 0 to 15 are reserved for special meanings.';
  return null;
}

/** Re-marks the bottom-of-stack bit: set on the last entry only. */
function markBottom(stack: readonly LabelEntry[]): LabelStack {
  return Object.freeze(stack.map((e, i) => (e.bottom === (i === stack.length - 1) ? e : { ...e, bottom: i === stack.length - 1 })));
}

/**
 * Applies one operation:
 *  - **push** puts a new entry on top. Its TTL is copied from the entry below it, or from the IP header when the stack
 *    was empty; its traffic class from `tc`, else from the entry below, else 0.
 *  - **swap** replaces the top label, as a router in the core does. Forwarding is a hop, so the TTL drops by one; a
 *    TTL that would reach 0 means the packet expires there.
 *  - **pop** removes the top entry. The TTL it carried is copied down to the new top, or to the IP header, when it is
 *    lower, so the hops spent inside the core still count.
 */
export function applyLabelOp(state: LabelState, op: LabelOp): LabelResult {
  const top = state.stack[0];
  switch (op.op) {
    case 'push': {
      const err = labelError(op.label);
      if (err !== null) return { ok: false, error: err };
      const tc = op.tc ?? top?.tc ?? 0;
      if (!Number.isInteger(tc) || tc < 0 || tc > 7) return { ok: false, error: 'A traffic class runs from 0 to 7.' };
      const entry: LabelEntry = { label: op.label, tc, bottom: false, ttl: top?.ttl ?? state.ipTtl };
      return { ok: true, state: { stack: markBottom([entry, ...state.stack]), ipTtl: state.ipTtl } };
    }
    case 'swap': {
      if (top === undefined) return { ok: false, error: 'There is no label to swap: the stack is empty.' };
      const err = labelError(op.label);
      if (err !== null) return { ok: false, error: err };
      if (top.ttl <= 1) return { ok: false, error: 'The TTL runs out here, so the packet expires instead of being forwarded.' };
      const entry: LabelEntry = { ...top, label: op.label, ttl: top.ttl - 1 };
      return { ok: true, state: { stack: markBottom([entry, ...state.stack.slice(1)]), ipTtl: state.ipTtl } };
    }
    case 'pop': {
      if (top === undefined) return { ok: false, error: 'There is no label to pop: the stack is empty.' };
      const rest = state.stack.slice(1);
      const below = rest[0];
      if (below === undefined) return { ok: true, state: { stack: Object.freeze([]), ipTtl: Math.min(state.ipTtl, top.ttl) } };
      return { ok: true, state: { stack: markBottom([{ ...below, ttl: Math.min(below.ttl, top.ttl) }, ...rest.slice(1)]), ipTtl: state.ipTtl } };
    }
  }
}

/** Applies `ops` in order; stops at the first refusal, saying which step refused. */
export function applyLabelOps(state: LabelState, ops: readonly LabelOp[]): LabelResult {
  let s = state;
  for (let i = 0; i < ops.length; i++) {
    const r = applyLabelOp(s, ops[i]!);
    if (!r.ok) return { ok: false, error: `Step ${i + 1}: ${r.error}` };
    s = r.state;
  }
  return { ok: true, state: s };
}

/** The 32-bit word of one entry: label (20 bits), traffic class (3), bottom of stack (1), TTL (8). */
export function encodeLabelEntry(e: LabelEntry): number {
  return ((e.label & MAX_LABEL) * 4096 + (e.tc & 7) * 512 + (e.bottom ? 256 : 0) + (e.ttl & 0xff)) >>> 0;
}

/** The entry of a 32-bit word. */
export function decodeLabelEntry(word: number): LabelEntry {
  const w = word >>> 0;
  return { label: Math.floor(w / 4096), tc: (w >>> 9) & 7, bottom: ((w >>> 8) & 1) === 1, ttl: w & 0xff };
}

/** The stack as it crosses the wire: four bytes per entry, top first, in hex. */
export function stackHex(stack: LabelStack): string {
  return stack
    .map((e) => {
      const w = encodeLabelEntry(e);
      return [24, 16, 8, 0].map((s) => ((w >>> s) & 0xff).toString(16).padStart(2, '0')).join(' ');
    })
    .join(' | ');
}

/** The stack as text, top first: `[1001, 30]`, or `no labels`. */
export function stackText(stack: LabelStack): string {
  return stack.length === 0 ? 'no labels' : `[${stack.map((e) => e.label).join(', ')}]`;
}

/** The text of one operation. */
export function labelOpText(op: LabelOp): string {
  return op.op === 'pop' ? 'pop' : `${op.op} ${op.label}`;
}

/** A router on a walked path. */
export interface LspRouter {
  readonly name: string;
  readonly role: 'customer edge' | 'provider edge' | 'provider core';
  /** The operations this router applies to a packet heading for the far site. */
  readonly ops: readonly LabelOp[];
  /** Why it applies them. */
  readonly why: string;
}

/** One step of a walk: the packet as it leaves `router`. */
export interface LspHop {
  readonly router: string;
  readonly role: LspRouter['role'];
  readonly ops: readonly LabelOp[];
  readonly state: LabelState;
  readonly text: string;
}

export interface LspWalk {
  readonly hops: readonly LspHop[];
  /** Set when an operation was refused (the walk stops there). */
  readonly error?: string;
}

/** The paths the explorer walks. */
export type LspScenarioId = 'l3vpn' | 'transport';

/** Labels of the example paths (any unreserved values would do). */
export const VPN_LABEL = 30;
export const TRANSPORT_LABELS = Object.freeze([1001, 2002, 3003] as const);

/**
 * The routers of an example path from site A to site B: CE-A, PE-1, P-1, P-2, PE-2, CE-B. With `php` (penultimate-hop
 * popping, the usual default) P-2 pops the transport label so that PE-2 looks up only one; without it P-2 swaps to the
 * label PE-2 handed out and PE-2 pops both.
 */
export function lspRouters(scenario: LspScenarioId, php: boolean): LspRouter[] {
  const [t1, t2, t3] = TRANSPORT_LABELS;
  const vpn = scenario === 'l3vpn';
  return [
    { name: 'CE-A', role: 'customer edge', ops: [], why: 'Site A\'s router sends an ordinary IP packet to its provider.' },
    {
      name: 'PE-1',
      role: 'provider edge',
      ops: vpn ? [{ op: 'push', label: VPN_LABEL }, { op: 'push', label: t1 }] : [{ op: 'push', label: t1 }],
      why: vpn
        ? `The ingress edge finds the customer's route, pushes the VPN label ${VPN_LABEL} that names the customer at the far edge, then the transport label ${t1} that leads to PE-2.`
        : `The ingress edge pushes the transport label ${t1} that leads to PE-2.`,
    },
    { name: 'P-1', role: 'provider core', ops: [{ op: 'swap', label: t2 }], why: `A core router looks up only the top label and swaps ${t1} for ${t2}; it never reads the IP header.` },
    php
      ? { name: 'P-2', role: 'provider core', ops: [{ op: 'pop' }], why: 'The last core router before PE-2 pops the transport label (penultimate-hop popping), saving PE-2 a lookup.' }
      : { name: 'P-2', role: 'provider core', ops: [{ op: 'swap', label: t3 }], why: `Without penultimate-hop popping, P-2 swaps to ${t3}, the label PE-2 handed out.` },
    {
      name: 'PE-2',
      role: 'provider edge',
      ops: php ? (vpn ? [{ op: 'pop' }] : []) : vpn ? [{ op: 'pop' }, { op: 'pop' }] : [{ op: 'pop' }],
      why: vpn
        ? `The egress edge pops what is left; the VPN label ${VPN_LABEL} tells it which customer's routing table to use for the IP packet.`
        : 'The egress edge routes the IP packet as usual.',
    },
    { name: 'CE-B', role: 'customer edge', ops: [], why: 'Site B\'s router receives an ordinary IP packet; it never saw a label.' },
  ];
}

/** Walks a packet with IP TTL `ipTtl` along the routers of `scenario`, recording the stack as it leaves each one. */
export function walkLsp(scenario: LspScenarioId, php: boolean, ipTtl = 64): LspWalk {
  const hops: LspHop[] = [];
  let state: LabelState = { stack: Object.freeze([]), ipTtl };
  for (const r of lspRouters(scenario, php)) {
    const res = applyLabelOps(state, r.ops);
    if (!res.ok) return { hops, error: `${r.name}: ${res.error}` };
    state = res.state;
    const did = r.ops.length === 0 ? 'no label operation' : r.ops.map(labelOpText).join(', then ');
    hops.push({ router: r.name, role: r.role, ops: r.ops, state, text: `${r.name} (${r.role}): ${did}. Leaves with ${stackText(state.stack)}. ${r.why}` });
  }
  return { hops };
}

// ── quiz ────────────────────────────────────────────────────────────────────

export type WanQuizKind = 'wan-kind' | 'vpn-kind' | 'label' | 'overhead';

export interface QuizQuestion {
  readonly id: string;
  readonly kind: WanQuizKind;
  readonly prompt: string;
  readonly options: readonly string[];
  /** Index of the right option. */
  readonly answer: number;
  readonly explanation: string;
}

export interface QuizResult {
  readonly id: string;
  /** The option chosen, or null when the question was skipped. */
  readonly given: number | null;
  readonly expected: number;
  readonly correct: boolean;
  readonly text: string;
}

export interface QuizScore {
  readonly total: number;
  readonly answered: number;
  readonly correct: number;
  /** Whole percent of all questions (skipped ones count as wrong). */
  readonly percent: number;
  readonly results: readonly QuizResult[];
  readonly summary: string;
}

/** Sites whose best WAN kind the quiz asks for. */
const WAN_CASES: readonly { readonly id: string; readonly prompt: string; readonly answer: WanKindId; readonly why: string }[] = [
  { id: 'w1', prompt: 'Forty offices must all reach each other, and voice calls must go first. Which service fits?', answer: 'mpls', why: 'One connection per site reaches every other site, and classes of service can put voice first.' },
  { id: 'w2', prompt: 'A research hut in a desert, far from any cable or mobile mast, needs internet access. Which kind fits?', answer: 'satellite', why: 'Nothing else reaches it; the long delay is the price.' },
  { id: 'w3', prompt: 'A shop must keep taking card payments when its wired line fails. What should it add?', answer: 'cellular', why: 'A cellular link installs in hours and does not share the trench of the wired line.' },
  { id: 'w4', prompt: 'Exactly two sites need a fixed, predictable path between them with a constant delay. Which service fits?', answer: 'leased-line', why: 'A dedicated circuit gives fixed bandwidth and delay between two ends.' },
  { id: 'w5', prompt: 'Five offices in one city should behave as if they plugged into the same switch. Which service fits?', answer: 'metro-ethernet', why: 'Metro Ethernet joins sites in one region over ordinary Ethernet ports.' },
  { id: 'w6', prompt: 'A busy branch wants the fastest internet access, the same speed both ways. Which kind fits?', answer: 'fibre', why: 'Fibre to the premises is the fastest and steadiest internet access, and can be symmetric.' },
];

/** Needs whose best VPN kind the quiz asks for. */
const VPN_CASES: readonly { readonly id: string; readonly prompt: string; readonly answer: VpnKindId; readonly why: string }[] = [
  { id: 'v1', prompt: 'Two sites want OSPF across the internet, and nobody on the way may read the traffic. Which VPN kind?', answer: 'gre-over-ipsec', why: 'GRE carries the multicast hellos and IPsec encrypts the GRE packets.' },
  { id: 'v2', prompt: 'A salesperson in a hotel needs company files, with nothing to install, from a browser. Which VPN kind?', answer: 'remote-tls', why: 'A TLS VPN can run from a web browser for the length of a session.' },
  { id: 'v3', prompt: 'A company wants its provider to keep its sites\' routes apart from other customers, with no tunnels of its own. Which kind?', answer: 'mpls-l3vpn', why: 'In a provider layer 3 VPN the provider builds and runs it, keeping each customer\'s routes apart.' },
  { id: 'v4', prompt: 'Two lab sites need a virtual link quickly, and the traffic is not secret. Which is the simplest?', answer: 'gre', why: 'A GRE tunnel builds a path and nothing more; it encrypts nothing.' },
  { id: 'v5', prompt: 'Two sites should share one Ethernet segment across the provider, with their routers peering directly. Which kind?', answer: 'mpls-l2vpn', why: 'A provider layer 2 VPN carries whole Ethernet frames between the sites.' },
];

/** Inner sizes the overhead questions use. */
const OVERHEAD_KINDS: readonly VpnKindId[] = ['gre', 'ipsec-site', 'gre-over-ipsec', 'mpls-l3vpn', 'mpls-l2vpn'];

/** Deterministic draws: mulberry32 over a hash of `(seed, salt)`. */
class QuizRng {
  private s: number;
  constructor(seed: number, salt: number) {
    const v = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    let h = (v ^ Math.imul(salt + 1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    this.s = (h ^ (h >>> 16)) | 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(n: number): number {
    return n <= 0 ? 0 : this.next() % n;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** A multiple-choice question with `right` among `wrong` (distinct, at most three of them), shuffled. */
function choice(rng: QuizRng, base: Omit<QuizQuestion, 'options' | 'answer'>, right: string, wrong: readonly string[]): QuizQuestion {
  const distractors = rng.shuffle([...new Set(wrong)].filter((w) => w !== right)).slice(0, 3);
  const options = rng.shuffle([right, ...distractors]);
  return { ...base, options, answer: options.indexOf(right) };
}

function wanQuestion(rng: QuizRng, i: number): QuizQuestion {
  const c = WAN_CASES[rng.int(WAN_CASES.length)]!;
  const right = wanKind(c.answer).label;
  return choice(rng, { id: `q${i}-${c.id}`, kind: 'wan-kind', prompt: c.prompt, explanation: c.why }, right, WAN_KINDS.map((k) => k.label));
}

function vpnQuestion(rng: QuizRng, i: number): QuizQuestion {
  const c = VPN_CASES[rng.int(VPN_CASES.length)]!;
  const right = vpnKind(c.answer).label;
  return choice(rng, { id: `q${i}-${c.id}`, kind: 'vpn-kind', prompt: c.prompt, explanation: c.why }, right, VPN_KINDS.map((k) => k.label));
}

function labelQuestion(rng: QuizRng, i: number): QuizQuestion {
  const depth = 1 + rng.int(2);
  const labels = Array.from({ length: depth }, () => FIRST_UNRESERVED_LABEL + rng.int(984));
  let state: LabelState = { stack: Object.freeze([]), ipTtl: 64 };
  for (const l of [...labels].reverse()) {
    const r = applyLabelOp(state, { op: 'push', label: l });
    if (r.ok) state = r.state;
  }
  const fresh = 1000 + rng.int(9000);
  const ops: readonly LabelOp[] = [{ op: 'push', label: fresh }, { op: 'swap', label: fresh }, { op: 'pop' }];
  const op = ops[rng.int(ops.length)]!;
  const res = applyLabelOp(state, op);
  const after = res.ok ? stackText(res.state.stack) : 'the packet is dropped';
  const top = labels[0]!;
  const wrong = [
    stackText(labels.map((l) => ({ label: l, tc: 0, bottom: false, ttl: 0 }))), // unchanged
    `[${[fresh, ...labels].join(', ')}]`, // pushed
    `[${[fresh, ...labels.slice(1)].join(', ')}]`, // swapped
    labels.length > 1 ? `[${labels.slice(1).join(', ')}]` : 'no labels', // popped
    `[${[...labels, fresh].join(', ')}]`, // pushed at the bottom
    labels.length > 1 ? `[${[labels[0]!, fresh].join(', ')}]` : `[${top}, ${fresh}]`, // bottom swapped
  ];
  const how =
    op.op === 'push'
      ? `A push adds ${fresh} on top; the labels below stay as they were.`
      : op.op === 'swap'
        ? `A swap replaces only the top label, ${top}, with ${fresh}; the depth stays ${depth}.`
        : `A pop removes the top label, ${top}; what was below it is now on top${depth === 1 ? ' — here nothing is left, so the router reads the IP header' : ''}.`;
  return choice(
    rng,
    { id: `q${i}-label`, kind: 'label', prompt: `A packet arrives with the label stack ${stackText(state.stack)} (top first). The router does "${labelOpText(op)}". What stack leaves?`, explanation: how },
    after,
    wrong,
  );
}

function overheadQuestion(rng: QuizRng, i: number): QuizQuestion {
  const kind = OVERHEAD_KINDS[rng.int(OVERHEAD_KINDS.length)]!;
  const right = maxInnerPacket(kind, 1500);
  const others = VPN_KINDS.map((k) => maxInnerPacket(k.id, 1500)).filter((n) => n !== right);
  const near = [right - 4, right + 4, right - 8, right - 16, 1500];
  const enc = encapsulate(kind, right);
  return choice(
    rng,
    {
      id: `q${i}-overhead-${kind}`,
      kind: 'overhead',
      prompt: `On a link that carries 1500-byte packets, what is the largest inner IPv4 packet a ${vpnKind(kind).label} can carry without fragmenting it?`,
      explanation: `${right} bytes: ${enc.layers.filter((l) => l.inner !== true && l.bytes > 0).map((l) => `${l.name} ${l.bytes}`).join(', ')} add ${enc.overhead} bytes, making exactly ${enc.total}.`,
    },
    String(right),
    [...rng.shuffle(others).map(String), ...near.map(String)],
  );
}

const MAKERS: Record<WanQuizKind, (rng: QuizRng, i: number) => QuizQuestion> = {
  'wan-kind': wanQuestion,
  'vpn-kind': vpnQuestion,
  label: labelQuestion,
  overhead: overheadQuestion,
};

/** The quiz kinds, in the order a quiz cycles through them. */
export const WAN_QUIZ_KINDS: readonly WanQuizKind[] = Object.freeze(['wan-kind', 'vpn-kind', 'label', 'overhead']);

/**
 * A quiz of `count` questions for `seed`: the kinds cycle in `WAN_QUIZ_KINDS` order, and each question draws from its
 * own stream of `(seed, index)`, so the same seed always gives the same quiz and question `i` does not depend on `count`.
 */
export function wanQuiz(seed: number, count = 8): QuizQuestion[] {
  const n = Math.max(0, Math.min(40, Math.trunc(count)));
  return Array.from({ length: n }, (_, i) => MAKERS[WAN_QUIZ_KINDS[i % WAN_QUIZ_KINDS.length]!](new QuizRng(seed, i), i));
}

/**
 * Scores `answers` (one chosen option index per question, null for a skipped one; missing entries count as skipped).
 * An index outside the options is a wrong answer, never an error.
 */
export function scoreQuiz(quiz: readonly QuizQuestion[], answers: readonly (number | null | undefined)[]): QuizScore {
  const results: QuizResult[] = quiz.map((q, i) => {
    const raw = answers[i];
    const given = raw === undefined || raw === null || !Number.isInteger(raw) ? null : raw;
    const correct = given === q.answer;
    const right = q.options[q.answer]!;
    const text =
      given === null ? `Skipped. The answer is ${right}. ${q.explanation}` : correct ? `Right: ${right}. ${q.explanation}` : `Not this one: the answer is ${right}. ${q.explanation}`;
    return { id: q.id, given, expected: q.answer, correct, text };
  });
  const correct = results.filter((r) => r.correct).length;
  const answered = results.filter((r) => r.given !== null).length;
  const total = quiz.length;
  const percent = total === 0 ? 0 : Math.round((100 * correct) / total);
  const summary = total === 0 ? 'There are no questions.' : `${correct} of ${total} right (${percent} %)${answered < total ? `, ${total - answered} skipped` : ''}.`;
  return { total, answered, correct, percent, results, summary };
}

/** `scoreQuiz` for a WAN quiz. */
export const scoreWanQuiz = scoreQuiz;
