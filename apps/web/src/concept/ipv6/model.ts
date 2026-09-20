/**
 * IPv6 explorer model (ARCHITECTURE-P1 §4.13, §8.2 W2 web-learn): pure, DOM-free functions behind the IPv6
 * concept view.
 *
 * - `ipv6CompressionSteps` walks from any valid spelling to the RFC 5952 canonical text: expand to 8 × 4 hex
 *   digits, drop leading zeros in each group, replace the longest run of two or more zero groups (the first
 *   one on a tie) with `::`. A lone zero group is never compressed (RFC 5952 §4.2.2).
 * - `ipv6ExpansionSteps` walks the other way, from a short spelling to the fully expanded form.
 * - `eui64Steps` derives a modified EUI-64 interface id from a MAC (RFC 4291 §2.5.1 and Appendix A: split the
 *   MAC, insert ff:fe, invert the universal/local bit) and joins it to a /64 prefix.
 * - `classifyIpv6` names the address type, its range and, for multicast, the flags, scope and well-known group.
 *
 * Every final value is cross-checked by construction against the engine helpers (`normalizeIpv6`, `expandIpv6`,
 * `eui64Address`, `ipv6Scope`), so the explorer never disagrees with the simulator. All wording is original (D13).
 */
import {
  bytesToIpv6,
  eui64InterfaceId,
  expandIpv6,
  ipv6NetworkOf,
  ipv6Scope,
  ipv6ToBytes,
  normalizeIpv6,
  normalizeMac,
  parseIpv4,
  parseIpv6,
} from '@netforge/engine/pure';
import type { Ipv6Address, Ipv6Scope, MacAddress } from '@netforge/engine/pure';

// ── compression and expansion ────────────────────────────────────────────────

/** Rules applied by the compression and expansion walks. */
export type Ipv6StepRule =
  | 'lowercase'
  | 'ipv4-tail'
  | 'expand'
  | 'drop-leading-zeros'
  | 'compress-zero-run'
  | 'restore-zero-run'
  | 'pad-groups';

/** One step of a walk: the text before and after one rule. */
export interface Ipv6Step {
  rule: Ipv6StepRule;
  /** Short original heading. */
  title: string;
  before: string;
  after: string;
  /** False when the rule had nothing to do (the step is still listed so the method stays visible). */
  changed: boolean;
  /** Original explanation of what the rule did to this address. */
  detail: string;
  /** Indexes (0..7) of the groups the rule touched, counted on the full 8-group layout. */
  groups: number[];
}

/** A run of consecutive all-zero groups. */
export interface ZeroRun {
  /** First group index (0..7). */
  start: number;
  /** Number of groups (≥ 1). */
  length: number;
}

/** Result of a compression walk. */
export type Ipv6CompressionResult =
  | {
      ok: true;
      input: string;
      /** 8 × 4 lowercase hex digits. */
      expanded: string;
      /** RFC 5952 text; always equal to the last step's `after`. */
      canonical: Ipv6Address;
      steps: Ipv6Step[];
      /** Every zero run of the address, in order. */
      zeroRuns: ZeroRun[];
      /** The run replaced by `::`, or null when no run has two or more groups. */
      compressed: ZeroRun | null;
    }
  | { ok: false; error: string };

/** Result of an expansion walk. */
export type Ipv6ExpansionResult =
  | { ok: true; input: string; expanded: string; canonical: Ipv6Address; steps: Ipv6Step[] }
  | { ok: false; error: string };

/**
 * Stepwise compression of `input` to RFC 5952 text. Steps: expand (with lowercase and dotted-tail conversion
 * folded in), drop leading zeros, compress the longest zero run.
 * Vector (§10.2): `2001:0db8:0000:0000:0000:ff00:0042:8329` → `2001:db8:0:0:0:ff00:42:8329` → `2001:db8::ff00:42:8329`.
 */
export function ipv6CompressionSteps(input: string): Ipv6CompressionResult {
  const text = input.trim();
  const bytes = parseIpv6(text);
  if (bytes === null) return { ok: false, error: invalidIpv6Message(text) };
  const words = toWords(bytes);
  const expanded = expandIpv6(text);
  const steps: Ipv6Step[] = [];

  steps.push({
    rule: 'expand',
    title: 'Write all eight groups in full',
    before: text,
    after: expanded,
    changed: text !== expanded,
    detail: expandDetail(text),
    groups: changedGroups(text, expanded),
  });

  const trimmed = words.map((w) => w.toString(16));
  const noLeading = trimmed.join(':');
  const padded = words.map((w) => w.toString(16).padStart(4, '0'));
  const touched = padded.flatMap((g, i) => (g !== trimmed[i] ? [i] : []));
  steps.push({
    rule: 'drop-leading-zeros',
    title: 'Drop leading zeros in every group',
    before: expanded,
    after: noLeading,
    changed: touched.length > 0,
    detail: touched.length > 0
      ? `Leading zeros carry no value, so ${touched.length} group${touched.length === 1 ? '' : 's'} got shorter; an all-zero group keeps a single 0.`
      : 'No group starts with a zero, so nothing gets shorter.',
    groups: touched,
  });

  const zeroRuns = findZeroRuns(words);
  const compressed = longestRun(zeroRuns);
  const canonical = normalizeIpv6(text)!;
  const afterRun = compressed === null ? noLeading : joinCompressed(trimmed, compressed);
  steps.push({
    rule: 'compress-zero-run',
    title: 'Replace the longest run of zero groups with ::',
    before: noLeading,
    after: afterRun,
    changed: compressed !== null,
    detail: compressDetail(zeroRuns, compressed),
    groups: compressed === null ? [] : range(compressed.start, compressed.length),
  });
  if (afterRun !== canonical) throw new Error(`compression walk disagrees with the canonical form of ${text}`);

  return { ok: true, input: text, expanded, canonical, steps, zeroRuns, compressed };
}

/**
 * Stepwise expansion of `input` to 8 × 4 hex digits: lowercase (when needed), convert a dotted IPv4 tail (when
 * present), restore the zero groups `::` stands for (when present), pad every group to four digits.
 */
export function ipv6ExpansionSteps(input: string): Ipv6ExpansionResult {
  const text = input.trim();
  const bytes = parseIpv6(text);
  if (bytes === null) return { ok: false, error: invalidIpv6Message(text) };
  const steps: Ipv6Step[] = [];
  let cur = text;

  const lower = cur.toLowerCase();
  if (lower !== cur) {
    steps.push({
      rule: 'lowercase',
      title: 'Use lowercase hex digits',
      before: cur,
      after: lower,
      changed: true,
      detail: 'Hex digits a–f mean the same in either case; the recommended text form uses lowercase.',
      groups: [],
    });
    cur = lower;
  }

  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(cur);
  if (tail) {
    const v = parseIpv4(tail[1]!)!;
    const hi = (v >>> 16).toString(16);
    const lo = (v & 0xffff).toString(16);
    const after = `${cur.slice(0, tail.index)}${hi}:${lo}`;
    steps.push({
      rule: 'ipv4-tail',
      title: 'Rewrite the dotted IPv4 tail as two hex groups',
      before: cur,
      after,
      changed: true,
      detail: `The last 32 bits were written as ${tail[1]!}; as hex they are the two groups ${hi}:${lo}.`,
      groups: [6, 7],
    });
    cur = after;
  }

  if (cur.includes('::')) {
    const [left, right] = cur.split('::') as [string, string];
    const l = left === '' ? [] : left.split(':');
    const r = right === '' ? [] : right.split(':');
    const missing = 8 - l.length - r.length;
    const after = [...l, ...Array.from({ length: missing }, () => '0'), ...r].join(':');
    steps.push({
      rule: 'restore-zero-run',
      title: 'Put back the zero groups that :: stands for',
      before: cur,
      after,
      changed: true,
      detail: `${l.length + r.length} group${l.length + r.length === 1 ? ' is' : 's are'} written, so :: stands for ${missing} zero group${missing === 1 ? '' : 's'}.`,
      groups: range(l.length, missing),
    });
    cur = after;
  }

  const groups = cur.split(':');
  const paddedGroups = groups.map((g) => g.padStart(4, '0'));
  const touched = paddedGroups.flatMap((g, i) => (g !== groups[i] ? [i] : []));
  const expanded = paddedGroups.join(':');
  steps.push({
    rule: 'pad-groups',
    title: 'Pad every group to four hex digits',
    before: cur,
    after: expanded,
    changed: touched.length > 0,
    detail: touched.length > 0
      ? `Leading zeros are added to ${touched.length} group${touched.length === 1 ? '' : 's'} so each holds exactly 16 bits as four digits.`
      : 'Every group already has four digits.',
    groups: touched,
  });
  if (expanded !== expandIpv6(text)) throw new Error(`expansion walk disagrees with the expanded form of ${text}`);

  return { ok: true, input: text, expanded, canonical: normalizeIpv6(text)!, steps };
}

/** Every run of consecutive all-zero 16-bit words, in order. */
export function findZeroRuns(words: readonly number[]): ZeroRun[] {
  const runs: ZeroRun[] = [];
  let i = 0;
  while (i < words.length) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    const start = i;
    while (i < words.length && words[i] === 0) i++;
    runs.push({ start, length: i - start });
  }
  return runs;
}

/** The run RFC 5952 §4.2 compresses: the longest with two or more groups, the first on a tie; null when none qualifies. */
export function longestRun(runs: readonly ZeroRun[]): ZeroRun | null {
  let best: ZeroRun | null = null;
  for (const r of runs) {
    if (r.length >= 2 && (best === null || r.length > best.length)) best = r;
  }
  return best;
}

/** Joins trimmed groups with `run` replaced by `::`. */
function joinCompressed(groups: readonly string[], run: ZeroRun): string {
  const left = groups.slice(0, run.start).join(':');
  const right = groups.slice(run.start + run.length).join(':');
  return `${left}::${right}`;
}

/** Explanation of the expand step for a given spelling. */
function expandDetail(text: string): string {
  const parts: string[] = [];
  if (text !== text.toLowerCase()) parts.push('hex digits are written in lowercase');
  if (/\d+\.\d+\.\d+\.\d+$/.test(text)) parts.push('the dotted IPv4 tail becomes two hex groups');
  if (text.includes('::')) {
    const [left, right] = text.replace(/\d+\.\d+\.\d+\.\d+$/, '0:0').split('::') as [string, string];
    const written = (left === '' ? 0 : left.split(':').length) + (right === '' ? 0 : right.split(':').length);
    const missing = 8 - written;
    parts.push(`:: is replaced by the ${missing} zero group${missing === 1 ? '' : 's'} it stands for`);
  }
  parts.push('every group is padded to four hex digits (16 bits)');
  return `Starting point: the full 128-bit address as eight groups. Here ${parts.join('; ')}.`;
}

/** Explanation of the compression step. */
function compressDetail(runs: readonly ZeroRun[], chosen: ZeroRun | null): string {
  if (chosen === null) {
    return runs.length === 0
      ? 'There are no zero groups, so nothing can be compressed.'
      : 'No run of two or more zero groups exists; a single zero group stays as 0 and is never replaced by ::.';
  }
  const others = runs.filter((r) => r !== chosen && r.length >= 2);
  const tie = others.some((r) => r.length === chosen.length);
  let text = `Groups ${chosen.start + 1}–${chosen.start + chosen.length} are ${chosen.length} zero groups in a row, so they become ::.`;
  if (tie) text += ' Another run is just as long; the first one wins.';
  else if (others.length > 0) text += ' It is the longest run; the others stay written as 0 because :: may appear only once.';
  return text;
}

/** Group indexes whose text differs between an input spelling and the expanded form (all 8 when `::` is used). */
function changedGroups(text: string, expanded: string): number[] {
  const a = text.toLowerCase().split(':');
  const b = expanded.split(':');
  if (a.length !== 8) return range(0, 8);
  return b.flatMap((g, i) => (g !== a[i] ? [i] : []));
}

/** Original message for text that is not an IPv6 address. */
function invalidIpv6Message(text: string): string {
  if (text === '') return 'Enter an IPv6 address, for example 2001:db8::1.';
  if (text.includes('%')) return 'Zone indexes (the % suffix) are not part of the address; remove them.';
  if ((text.match(/::/g) ?? []).length > 1) return ':: may appear only once, otherwise the number of hidden zero groups is ambiguous.';
  if (/[^0-9a-fA-F:.]/.test(text)) return 'An IPv6 address uses only hex digits 0–9 and a–f, colons, and an optional dotted IPv4 tail.';
  return `"${text}" is not a valid IPv6 address: it needs eight 16-bit groups (or fewer with one ::), each 1–4 hex digits.`;
}

// ── EUI-64 ───────────────────────────────────────────────────────────────────

/** Rules of the EUI-64 walk. */
export type Eui64StepRule = 'split-mac' | 'insert-fffe' | 'flip-ul-bit' | 'interface-id' | 'combine';

/** One step of the EUI-64 walk. */
export interface Eui64Step {
  rule: Eui64StepRule;
  title: string;
  /** Value after the step (colon-separated bytes, hex groups or an address). */
  value: string;
  detail: string;
}

/** Details of the universal/local bit inversion. */
export interface UlBitFlip {
  byteBefore: string;
  byteAfter: string;
  bitsBefore: string;
  bitsAfter: string;
  /** In the MAC, bit 1 of the first byte set means locally administered. */
  macLocallyAdministered: boolean;
}

/** Result of an EUI-64 walk. */
export type Eui64Result =
  | {
      ok: true;
      mac: MacAddress;
      prefix: Ipv6Address;
      prefixLen: 64;
      /** 64-bit interface id as four hex groups without leading zeros (e.g. `4e:59ff:fee8:af01`). */
      interfaceId: string;
      /** Same id as eight colon-separated bytes. */
      interfaceIdBytes: string;
      flip: UlBitFlip;
      /** prefix + interface id, RFC 5952 text. */
      address: Ipv6Address;
      steps: Eui64Step[];
    }
  | { ok: false; error: string };

/**
 * Modified EUI-64 walk for `mac` joined to `prefix`/`prefixLen` (default `fe80::/64`, the link-local prefix).
 * Only /64 prefixes form EUI-64 addresses. Vector: 02:4e:59:e8:af:01 → fe80::4e:59ff:fee8:af01.
 */
export function eui64Steps(mac: string, prefix = 'fe80::', prefixLen = 64): Eui64Result {
  const m = normalizeMac(mac);
  if (m === null) return { ok: false, error: `"${mac.trim()}" is not a MAC address; use six hex bytes such as 02:4e:59:e8:af:01.` };
  const pfx = parseIpv6(prefix);
  if (pfx === null) return { ok: false, error: invalidIpv6Message(prefix.trim()) };
  if (prefixLen !== 64) return { ok: false, error: `EUI-64 interface ids fill the low 64 bits, so the prefix must be /64 (got /${prefixLen}).` };

  const macBytes = m.split(':');
  const oui = macBytes.slice(0, 3).join(':');
  const nic = macBytes.slice(3).join(':');
  const inserted = [...macBytes.slice(0, 3), 'ff', 'fe', ...macBytes.slice(3)];
  const id = eui64InterfaceId(m);
  const idBytes = Array.from(id, (b) => b.toString(16).padStart(2, '0'));
  const first = parseInt(macBytes[0]!, 16);
  const flip: UlBitFlip = {
    byteBefore: macBytes[0]!,
    byteAfter: idBytes[0]!,
    bitsBefore: first.toString(2).padStart(8, '0'),
    bitsAfter: id[0]!.toString(2).padStart(8, '0'),
    macLocallyAdministered: (first & 0x02) !== 0,
  };
  const idGroups: string[] = [];
  for (let i = 0; i < 8; i += 2) idGroups.push(((id[i]! << 8) | id[i + 1]!).toString(16));
  const interfaceId = idGroups.join(':');

  const addrBytes = new Uint8Array(16);
  addrBytes.set(pfx.subarray(0, 8), 0);
  addrBytes.set(id, 8);
  const address = bytesToIpv6(addrBytes);
  const network = ipv6NetworkOf(bytesToIpv6(pfx), 64);

  const steps: Eui64Step[] = [
    {
      rule: 'split-mac',
      title: 'Split the MAC in half',
      value: `${oui} | ${nic}`,
      detail: `The 48-bit MAC ${m} splits into the first three bytes (${oui}) and the last three (${nic}).`,
    },
    {
      rule: 'insert-fffe',
      title: 'Insert ff:fe in the middle',
      value: inserted.join(':'),
      detail: 'Placing the two bytes ff:fe between the halves stretches 48 bits to the 64 bits an interface id needs.',
    },
    {
      rule: 'flip-ul-bit',
      title: 'Invert the universal/local bit',
      value: idBytes.join(':'),
      detail: `Bit 1 of the first byte (value 2) is inverted: ${flip.byteBefore} (${flip.bitsBefore}) becomes ${flip.byteAfter} (${flip.bitsAfter}). `
        + (flip.macLocallyAdministered
          ? 'The MAC is locally administered, so the bit goes from 1 to 0.'
          : 'The MAC is globally unique, so the bit goes from 0 to 1.'),
    },
    {
      rule: 'interface-id',
      title: 'Write the interface id as four groups',
      value: interfaceId,
      detail: `Pairing the eight bytes into 16-bit groups and dropping leading zeros gives the interface id ${interfaceId}.`,
    },
    {
      rule: 'combine',
      title: 'Join the prefix and the interface id',
      value: address,
      detail: `The /64 prefix ${network} supplies the high 64 bits and the interface id the low 64 bits: ${address}.`,
    },
  ];

  return {
    ok: true,
    mac: m,
    prefix: network,
    prefixLen: 64,
    interfaceId,
    interfaceIdBytes: idBytes.join(':'),
    flip,
    address,
    steps,
  };
}

// ── address-type classifier ──────────────────────────────────────────────────

/** Explorer address types (finer than the engine's `Ipv6Scope`: global splits into global unicast and reserved). */
export type Ipv6AddressType =
  | 'unspecified'
  | 'loopback'
  | 'multicast'
  | 'link-local'
  | 'unique-local'
  | 'ipv4-mapped'
  | 'documentation'
  | 'global-unicast'
  | 'reserved';

/** Multicast scope names by the 4-bit scope field (RFC 4291 §2.7, RFC 7346). */
export type Ipv6MulticastScope =
  | 'interface-local'
  | 'link-local'
  | 'realm-local'
  | 'admin-local'
  | 'site-local'
  | 'organization-local'
  | 'global'
  | 'reserved'
  | 'unassigned';

/** Multicast details of an ff00::/8 address. */
export interface Ipv6MulticastInfo {
  /** The 4-bit scope field. */
  scopeValue: number;
  scope: Ipv6MulticastScope;
  flags: {
    /** T: not a permanently assigned (well-known) group. */
    transient: boolean;
    /** P: the group address embeds a unicast prefix. */
    prefixBased: boolean;
    /** R: the group address embeds a rendezvous point. */
    rendezvous: boolean;
  };
  /** Original name of a well-known group, when it is one. */
  wellKnown: string | null;
  /** For a solicited-node group: the low 24 bits (6 hex digits) it matches. */
  solicitedNodeSuffix: string | null;
}

/** Classification of one IPv6 address. */
export interface Ipv6Classification {
  address: Ipv6Address;
  expanded: string;
  type: Ipv6AddressType;
  /** The engine's scope class (what source selection and the daemons use). */
  scope: Ipv6Scope;
  /** The block that defines the type, e.g. `fe80::/10`. */
  range: string;
  /** Original one-line description. */
  description: string;
  /** Low 64 bits as four hex groups, for unicast types that use a 64-bit interface id; otherwise null. */
  interfaceId: string | null;
  /** True when the interface id has the ff:fe marker of a modified EUI-64 id. */
  eui64Like: boolean;
  multicast: Ipv6MulticastInfo | null;
}

/** Result of classifying user text. */
export type Ipv6ClassifyResult = { ok: true; value: Ipv6Classification } | { ok: false; error: string };

/** Well-known multicast groups the explorer names, by canonical text. */
export const IPV6_WELL_KNOWN_MULTICAST: ReadonlyMap<Ipv6Address, string> = new Map([
  ['ff01::1', 'all nodes on this interface'],
  ['ff01::2', 'all routers on this interface'],
  ['ff02::1', 'all nodes on the link'],
  ['ff02::2', 'all routers on the link'],
  ['ff02::5', 'all OSPFv3 routers on the link'],
  ['ff02::6', 'OSPFv3 designated routers on the link'],
  ['ff02::9', 'all RIPng routers on the link'],
  ['ff02::16', 'all MLDv2-capable routers on the link'],
  ['ff02::fb', 'multicast DNS on the link'],
  ['ff02::1:2', 'all DHCPv6 relay agents and servers on the link'],
  ['ff05::2', 'all routers in the site'],
  ['ff05::1:3', 'all DHCPv6 servers in the site'],
]);

/** Classifies `text` as an IPv6 address. */
export function classifyIpv6(text: string): Ipv6ClassifyResult {
  const t = text.trim();
  const bytes = parseIpv6(t);
  if (bytes === null) return { ok: false, error: invalidIpv6Message(t) };
  const address = bytesToIpv6(bytes);
  const scope = ipv6Scope(address);
  const expanded = expandIpv6(address);
  const low64 = interfaceIdOf(bytes);
  const eui64Like = bytes[11] === 0xff && bytes[12] === 0xfe;
  const base = { address, expanded, scope };

  switch (scope) {
    case 'unspecified':
      return ok({ ...base, type: 'unspecified', range: '::/128', description: 'The unspecified address: "no address yet", used as a source during duplicate address detection. Never a destination.', interfaceId: null, eui64Like: false, multicast: null });
    case 'loopback':
      return ok({ ...base, type: 'loopback', range: '::1/128', description: 'The loopback address: packets sent to it never leave the node.', interfaceId: null, eui64Like: false, multicast: null });
    case 'multicast': {
      const multicast = multicastInfo(bytes, address);
      const name = multicast.wellKnown ?? (multicast.solicitedNodeSuffix !== null ? 'a solicited-node group, used by neighbor discovery to reach one address without a broadcast' : null);
      return ok({
        ...base,
        type: 'multicast',
        range: multicast.solicitedNodeSuffix !== null ? 'ff02::1:ff00:0/104' : 'ff00::/8',
        description: `A multicast group with ${multicast.scope} scope${name === null ? '' : `: ${name}`}. IPv6 has no broadcast; multicast replaces it.`,
        interfaceId: null,
        eui64Like: false,
        multicast,
      });
    }
    case 'link-local':
      return ok({ ...base, type: 'link-local', range: 'fe80::/10', description: 'A link-local unicast address: every IPv6 interface has one, and routers never forward it off the link.', interfaceId: low64, eui64Like, multicast: null });
    case 'unique-local':
      return ok({
        ...base,
        type: 'unique-local',
        range: 'fc00::/7',
        description: (bytes[0]! & 0x01) === 1
          ? 'A unique local address (fd00::/8, locally assigned): private addressing that is routable inside a site but not on the internet.'
          : 'A unique local address in fc00::/8, the half of the block without an assignment method yet.',
        interfaceId: low64,
        eui64Like,
        multicast: null,
      });
    case 'ipv4-mapped':
      return ok({ ...base, type: 'ipv4-mapped', range: '::ffff:0:0/96', description: `An IPv4-mapped address: the IPv4 address ${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]} as seen by an IPv6 socket.`, interfaceId: null, eui64Like: false, multicast: null });
    case 'documentation':
      return ok({ ...base, type: 'documentation', range: '2001:db8::/32', description: 'A documentation address: reserved for examples and labs, never routed on the internet.', interfaceId: low64, eui64Like, multicast: null });
    case 'global':
      if ((bytes[0]! & 0xe0) === 0x20) {
        return ok({ ...base, type: 'global-unicast', range: '2000::/3', description: 'A global unicast address: routable on the internet. The first 48 bits are usually the global routing prefix, the next 16 the subnet id.', interfaceId: low64, eui64Like, multicast: null });
      }
      return ok({ ...base, type: 'reserved', range: reservedRange(bytes), description: 'An address outside the blocks assigned for unicast and multicast use.', interfaceId: null, eui64Like: false, multicast: null });
  }
}

/** Wraps a classification in a success result. */
function ok(value: Ipv6Classification): Ipv6ClassifyResult {
  return { ok: true, value };
}

/** Multicast flags, scope, well-known name and solicited-node suffix of an ff00::/8 address. */
function multicastInfo(bytes: Uint8Array, address: Ipv6Address): Ipv6MulticastInfo {
  const flagsNibble = bytes[1]! >> 4;
  const scopeValue = bytes[1]! & 0x0f;
  const solicited = bytes[1] === 0x02 && bytes.subarray(2, 11).every((b) => b === 0) && bytes[11] === 0x01 && bytes[12] === 0xff;
  return {
    scopeValue,
    scope: multicastScopeName(scopeValue),
    flags: { transient: (flagsNibble & 0x1) !== 0, prefixBased: (flagsNibble & 0x2) !== 0, rendezvous: (flagsNibble & 0x4) !== 0 },
    wellKnown: IPV6_WELL_KNOWN_MULTICAST.get(address) ?? null,
    solicitedNodeSuffix: solicited
      ? Array.from(bytes.subarray(13, 16), (b) => b.toString(16).padStart(2, '0')).join('')
      : null,
  };
}

/** Name of a 4-bit multicast scope value. */
export function multicastScopeName(v: number): Ipv6MulticastScope {
  switch (v) {
    case 0x1: return 'interface-local';
    case 0x2: return 'link-local';
    case 0x3: return 'realm-local';
    case 0x4: return 'admin-local';
    case 0x5: return 'site-local';
    case 0x8: return 'organization-local';
    case 0xe: return 'global';
    case 0x0:
    case 0xf: return 'reserved';
    default: return 'unassigned';
  }
}

/** The /3 (or ::/8 for the low block) that holds a reserved address. */
function reservedRange(bytes: Uint8Array): string {
  if (bytes[0] === 0) return '::/8';
  const top3 = bytes[0]! & 0xe0;
  const b = new Uint8Array(16);
  b[0] = top3;
  return `${bytesToIpv6(b)}/3`;
}

/** Low 64 bits as four hex groups without leading zeros. */
function interfaceIdOf(bytes: Uint8Array): string {
  const g: string[] = [];
  for (let i = 8; i < 16; i += 2) g.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return g.join(':');
}

// ── prefix view ──────────────────────────────────────────────────────────────

/** How a prefix length divides an address. */
export interface Ipv6PrefixView {
  address: Ipv6Address;
  prefixLen: number;
  network: Ipv6Address;
  cidr: string;
  /** Expanded network (8 × 4 hex). */
  expandedNetwork: string;
  /** Number of whole hex digits covered by the prefix, and whether it ends inside a digit. */
  prefixNibbles: number;
  splitsNibble: boolean;
  /** Host (interface) bits: 128 − prefixLen. */
  hostBits: number;
}

/** Splits `address` at `prefixLen` (0..128). @throws on invalid input. */
export function ipv6PrefixView(address: string, prefixLen: number): Ipv6PrefixView {
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) throw new RangeError(`prefix length ${prefixLen}`);
  const a = bytesToIpv6(ipv6ToBytes(address));
  const network = ipv6NetworkOf(a, prefixLen);
  return {
    address: a,
    prefixLen,
    network,
    cidr: `${network}/${prefixLen}`,
    expandedNetwork: expandIpv6(network),
    prefixNibbles: prefixLen >> 2,
    splitsNibble: prefixLen % 4 !== 0,
    hostBits: 128 - prefixLen,
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

/** 16 bytes → 8 big-endian 16-bit words. */
function toWords(b: Uint8Array): number[] {
  const w: number[] = [];
  for (let i = 0; i < 16; i += 2) w.push((b[i]! << 8) | b[i + 1]!);
  return w;
}

/** [start, start + length) as an array. */
function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}
