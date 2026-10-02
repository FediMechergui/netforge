/**
 * Wildcard visualizer model (ARCHITECTURE-P3 [S9], §6; W2 web-concept): pure, DOM-free functions behind the wildcard
 * concept tool (the tool itself is W3).
 *
 * - `wildcardView` lays an address and a wildcard out as three 32-bit rows — Address, Wildcard and Result — where a 0
 *   in the wildcard is a bit that must match (the Result shows the address bit, drawn solid) and a 1 is a bit that
 *   may be anything (the Result shows `*`, drawn hatched). It counts the addresses matched, gives the lowest and
 *   highest, says whether they form one contiguous block (a prefix) and describes the pattern octet by octet.
 * - `testWildcard` checks one address against the pair and names the must-match bits it gets wrong. The verdict is
 *   the engine's own `wildcardMatches` (`core/acl.ts`, the matcher every access list uses), so the tool can never
 *   disagree with a device.
 * - Three builders: from a prefix (`wildcardFromPrefix`), from a range (`wildcardsFromRange`, the engine's
 *   `rangeToAces`: the fewest address/wildcard pairs whose union is exactly the range) and from a bit pattern of
 *   `0`, `1` and `*` (`wildcardFromPattern`).
 * - `wildcardPractice` / `checkWildcardAnswer` form a seeded practice generator: a pure function of `(seed, index)`.
 *
 * Integer maths on unsigned 32-bit values only. All wording is original.
 */
import { parseIpv4, prefixLenToMaskU32, rangeToAces, u32ToIpv4, wildcardMatches } from '@netforge/engine/pure';
import type { AclAddress, Ipv4Address } from '@netforge/engine/pure';

// ── reading input ───────────────────────────────────────────────────────────

/** An address with its wildcard, both dotted. */
export interface WildcardPair {
  readonly address: Ipv4Address;
  readonly wildcard: Ipv4Address;
}

export type WildcardParseResult = { readonly ok: true; readonly value: WildcardPair } | { readonly ok: false; readonly error: string };

/** Reads an address and a wildcard typed by a learner (`any` and `host A` are the access-list shorthands). */
export function parseWildcardInput(text: string): WildcardParseResult {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t === '') return { ok: false, error: 'Enter an address and a wildcard, for example 192.168.1.0 0.0.0.255.' };
  if (t.toLowerCase() === 'any') return { ok: true, value: { address: '0.0.0.0', wildcard: '255.255.255.255' } };
  const host = /^host (\S+)$/i.exec(t);
  if (host !== null) {
    const a = parseIpv4(host[1]!);
    if (a === null) return { ok: false, error: `"${host[1]!}" is not a valid IPv4 address.` };
    return { ok: true, value: { address: u32ToIpv4(a), wildcard: '0.0.0.0' } };
  }
  const parts = t.split(' ');
  if (parts.length !== 2) return { ok: false, error: 'Write the address, a space, then the wildcard (or "any", or "host" and an address).' };
  const a = parseIpv4(parts[0]!);
  if (a === null) return { ok: false, error: `"${parts[0]!}" is not a valid IPv4 address.` };
  const w = parseIpv4(parts[1]!);
  if (w === null) return { ok: false, error: `"${parts[1]!}" is not a valid wildcard: write it like an address, four numbers from 0 to 255.` };
  return { ok: true, value: { address: u32ToIpv4(a), wildcard: u32ToIpv4(w) } };
}

// ── the bit view ────────────────────────────────────────────────────────────

/** One bit column of the view (bit 31 first). */
export interface WildcardBit {
  /** 0 for the leftmost (most significant) bit, 31 for the rightmost. */
  readonly index: number;
  readonly address: '0' | '1';
  readonly wildcard: '0' | '1';
  /** The Result row: the address bit where it must match, `*` where any value is allowed. */
  readonly result: '0' | '1' | '*';
  /** True for a must-match bit (wildcard 0): drawn solid; false for an any-bit: drawn hatched. */
  readonly mustMatch: boolean;
}

/** The figures of one address/wildcard pair. */
export interface WildcardView {
  readonly address: Ipv4Address;
  readonly wildcard: Ipv4Address;
  /** The address with every any-bit cleared (what an access list stores). */
  readonly base: Ipv4Address;
  /** True when the typed address had any-bits set (a device would store `base` instead). */
  readonly normalised: boolean;
  readonly bits: readonly WildcardBit[];
  /** The three rows as text, octets separated by dots (`11000000.10101000.00000001.********`). */
  readonly rows: { readonly address: string; readonly wildcard: string; readonly result: string };
  /** Number of any-bits, and of addresses matched (2^anyBits). */
  readonly anyBits: number;
  readonly count: number;
  /** Lowest and highest address matched. */
  readonly first: Ipv4Address;
  readonly last: Ipv4Address;
  /** True when every address from `first` to `last` matches (the wildcard is an inverted mask). */
  readonly contiguous: boolean;
  /** The prefix length when contiguous, else null. */
  readonly prefixLen: number | null;
  /** The access-list form: `any`, `host A`, or `A W`. */
  readonly aceText: string;
  /** One sentence per octet, then a summary sentence. */
  readonly octets: readonly string[];
  readonly sentence: string;
}

function u32(ip: Ipv4Address): number {
  const v = parseIpv4(ip);
  if (v === null) throw new RangeError(`invalid IPv4 address ${ip}`);
  return v;
}

function popcount(v: number): number {
  let n = 0;
  for (let x = v >>> 0; x !== 0; x = (x & (x - 1)) >>> 0) n++;
  return n;
}

/** The prefix length of a wildcard that is an inverted mask (0…01…1), else null. */
export function wildcardPrefixLen(wildcard: Ipv4Address): number | null {
  const w = u32(wildcard);
  const any = popcount(w);
  // an inverted mask has its ones at the bottom: w + 1 is a power of two (or w is all ones)
  return w === 0xffffffff || ((w + 1) & w) === 0 ? 32 - any : null;
}

function bitString(v: number): string {
  return (v >>> 0).toString(2).padStart(32, '0');
}

function dotted(bits: string): string {
  return `${bits.slice(0, 8)}.${bits.slice(8, 16)}.${bits.slice(16, 24)}.${bits.slice(24, 32)}`;
}

/** The access-list form of a pair: `any`, `host A` or `A W` (the address with its any-bits cleared). */
export function aceText(pair: WildcardPair): string {
  const w = u32(pair.wildcard);
  const base = u32ToIpv4((u32(pair.address) & ~w) >>> 0);
  if (w === 0xffffffff) return 'any';
  if (w === 0) return `host ${base}`;
  return `${base} ${pair.wildcard}`;
}

/** How one octet constrains the matched addresses. */
function octetSentence(n: number, base: number, wild: number): string {
  const name = `Octet ${n}`;
  if (wild === 0) return `${name} must be ${base}.`;
  if (wild === 255) return `${name} may be anything (0 to 255).`;
  const values = 2 ** popcount(wild);
  if (((wild + 1) & wild) === 0) return `${name} must be from ${base} to ${base + wild} (${values} values).`;
  if (wild === 254) return `${name} must be ${base === 0 ? 'even' : 'odd'} (${values} values).`;
  const free: number[] = [];
  for (let b = 7; b >= 0; b--) if (((wild >> b) & 1) === 1) free.push(b);
  return `${name} must match ${base} except in bit${free.length > 1 ? 's' : ''} ${free.join(', ')} (counting 0 from the right), which may be anything: ${values} values from ${base} to ${base + wild}.`;
}

/** The figures of `address`/`wildcard` (file header). @throws RangeError on an invalid address or wildcard. */
export function wildcardView(address: Ipv4Address, wildcard: Ipv4Address): WildcardView {
  const a = u32(address);
  const w = u32(wildcard);
  const base = (a & ~w) >>> 0;
  const last = (base | w) >>> 0;
  const ab = bitString(a);
  const wb = bitString(w);
  const bits: WildcardBit[] = [];
  let result = '';
  for (let i = 0; i < 32; i++) {
    const mustMatch = wb[i] === '0';
    const r = mustMatch ? (ab[i] as '0' | '1') : '*';
    result += r;
    bits.push({ index: i, address: ab[i] as '0' | '1', wildcard: wb[i] as '0' | '1', result: r, mustMatch });
  }
  const anyBits = popcount(w);
  const count = 2 ** anyBits;
  const prefixLen = wildcardPrefixLen(u32ToIpv4(w));
  const pair = { address: u32ToIpv4(a), wildcard: u32ToIpv4(w) };
  const octets = [0, 1, 2, 3].map((k) => octetSentence(k + 1, (base >>> (24 - 8 * k)) & 0xff, (w >>> (24 - 8 * k)) & 0xff));
  const plural = count === 1 ? 'address' : 'addresses';
  const sentence =
    w === 0
      ? `Matches exactly one address, ${u32ToIpv4(base)} (the "host" form).`
      : prefixLen !== null
        ? `Matches ${count} ${plural}, the contiguous block ${u32ToIpv4(base)} to ${u32ToIpv4(last)} (the network ${u32ToIpv4(base)}/${prefixLen}).`
        : `Matches ${count} ${plural} that are not one block: the lowest is ${u32ToIpv4(base)}, the highest ${u32ToIpv4(last)}, with gaps between them.`;
  return {
    address: pair.address,
    wildcard: pair.wildcard,
    base: u32ToIpv4(base),
    normalised: base !== a,
    bits,
    rows: { address: dotted(ab), wildcard: dotted(wb), result: dotted(result) },
    anyBits,
    count,
    first: u32ToIpv4(base),
    last: u32ToIpv4(last),
    contiguous: prefixLen !== null,
    prefixLen,
    aceText: aceText(pair),
    octets,
    sentence,
  };
}

// ── testing an address ──────────────────────────────────────────────────────

/** Whether a candidate address matches a pair, and which must-match bits it gets wrong. */
export interface WildcardTest {
  readonly candidate: Ipv4Address;
  readonly matches: boolean;
  /** Bit columns (0 = leftmost) where a must-match bit differs. Empty when it matches. */
  readonly wrongBits: readonly number[];
  readonly text: string;
}

/** Test `candidate` against `pair` (the verdict is the engine's `wildcardMatches`). */
export function testWildcard(pair: WildcardPair, candidate: Ipv4Address): WildcardTest {
  const c = u32(candidate);
  const a = u32(pair.address);
  const w = u32(pair.wildcard);
  const matches = wildcardMatches(u32ToIpv4(c), pair.address, pair.wildcard);
  const diff = ((c ^ a) & ~w) >>> 0;
  const wrongBits: number[] = [];
  for (let i = 0; i < 32; i++) if (((diff >>> (31 - i)) & 1) === 1) wrongBits.push(i);
  const shown = u32ToIpv4(c);
  const octets = [...new Set(wrongBits.map((b) => (b >> 3) + 1))];
  const octetText = octets.length === 1 ? `octet ${octets[0]!}` : `octets ${octets.slice(0, -1).join(', ')} and ${octets[octets.length - 1]!}`;
  const text = matches
    ? `${shown} matches: every must-match bit agrees with ${aceText(pair)}.`
    : `${shown} does not match: ${wrongBits.length} must-match bit${wrongBits.length > 1 ? 's differ' : ' differs'}, in ${octetText}.`;
  return { candidate: shown, matches, wrongBits, text };
}

// ── builders ────────────────────────────────────────────────────────────────

/** The pair that matches the network of `address/prefixLen` (the wildcard is the inverted mask). */
export function wildcardFromPrefix(address: Ipv4Address, prefixLen: number): WildcardPair {
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) throw new RangeError(`prefix length ${prefixLen}`);
  const mask = prefixLenToMaskU32(prefixLen);
  return { address: u32ToIpv4((u32(address) & mask) >>> 0), wildcard: u32ToIpv4(~mask >>> 0) };
}

/** One entry of a range built from blocks: the pair, how many addresses it covers and its access-list form. */
export interface WildcardRangeEntry extends WildcardPair {
  readonly count: number;
  readonly aceText: string;
}

/**
 * The fewest pairs whose union is exactly `first`…`last` (the engine's `rangeToAces`), each with its count and
 * access-list form. Empty when the range is reversed or an end is not an address.
 */
export function wildcardsFromRange(first: Ipv4Address, last: Ipv4Address): WildcardRangeEntry[] {
  return rangeToAces(first, last).map((ace: AclAddress) => ({
    address: ace.address,
    wildcard: ace.wildcard,
    count: 2 ** popcount(u32(ace.wildcard)),
    aceText: aceText(ace),
  }));
}

export type WildcardPatternResult = { readonly ok: true; readonly value: WildcardPair } | { readonly ok: false; readonly error: string };

/**
 * A pair from a 32-symbol bit pattern: `0` and `1` are must-match bits, `*` (or `x`) a bit that may be anything.
 * Dots and spaces between symbols are ignored, so the Result row of a view reads back as its pair.
 */
export function wildcardFromPattern(text: string): WildcardPatternResult {
  const t = text.replace(/[\s.]/g, '').toLowerCase();
  if (!/^[01*x]*$/.test(t)) return { ok: false, error: 'Use only 0, 1 and * (dots and spaces may separate the octets).' };
  if (t.length !== 32) return { ok: false, error: `A pattern has 32 symbols; this one has ${t.length}.` };
  let a = 0;
  let w = 0;
  for (let i = 0; i < 32; i++) {
    const s = t[i]!;
    a = a * 2 + (s === '1' ? 1 : 0);
    w = w * 2 + (s === '*' || s === 'x' ? 1 : 0);
  }
  return { ok: true, value: { address: u32ToIpv4(a), wildcard: u32ToIpv4(w) } };
}

// ── practice ────────────────────────────────────────────────────────────────

/** The kinds of practice question. */
export type WildcardPracticeKind = 'wildcard-for-prefix' | 'count' | 'last-address' | 'matches';

export const WILDCARD_PRACTICE_KINDS: readonly WildcardPracticeKind[] = Object.freeze(['wildcard-for-prefix', 'count', 'last-address', 'matches']);

/** One practice question with its expected answer. */
export interface WildcardProblem {
  readonly seed: number;
  readonly index: number;
  readonly kind: WildcardPracticeKind;
  readonly pair: WildcardPair;
  /** The address tested (`matches` only). */
  readonly candidate?: Ipv4Address;
  readonly prompt: string;
  /** Canonical answer: a dotted wildcard or address, a decimal count, or `yes` / `no`. */
  readonly answer: string;
}

/** The outcome of checking one answer. */
export interface WildcardCheck {
  readonly correct: boolean;
  readonly expected: string;
  /** The answer read into canonical form, or null when it could not be read. */
  readonly given: string | null;
  readonly explanation: string;
}

/**
 * Question `index` (0, 1, 2, …) of the practice series for `seed`: the same `(seed, index, kinds)` always gives the
 * same question, on every machine.
 */
export function wildcardPractice(seed: number, index: number, kinds: readonly WildcardPracticeKind[] = WILDCARD_PRACTICE_KINDS): WildcardProblem {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`practice index ${index}`);
  if (kinds.length === 0) throw new RangeError('wildcardPractice: no question kinds selected');
  const rng = new PracticeRng(seed, index);
  const kind = kinds[rng.below(kinds.length)]!;
  const address = randomUnicast(rng);
  const prefixLen = 8 + rng.below(23); // 8..30
  const block = wildcardFromPrefix(address, prefixLen);
  switch (kind) {
    case 'wildcard-for-prefix':
      return {
        seed,
        index,
        kind,
        pair: block,
        prompt: `Which wildcard makes an access-list entry match the network ${block.address}/${prefixLen}?`,
        answer: block.wildcard,
      };
    case 'count': {
      // sometimes a non-contiguous wildcard: one any-bit moved into a higher octet
      const pair = rng.below(2) === 0 ? block : withExtraAnyBit(block, rng);
      return { seed, index, kind, pair, prompt: `How many addresses does "${aceText(pair)}" match?`, answer: String(2 ** popcount(u32(pair.wildcard))) };
    }
    case 'last-address':
      return {
        seed,
        index,
        kind,
        pair: block,
        prompt: `What is the highest address "${aceText(block)}" matches?`,
        answer: u32ToIpv4((u32(block.address) | u32(block.wildcard)) >>> 0),
      };
    case 'matches': {
      const inside = rng.below(2) === 0;
      const w = u32(block.wildcard);
      const offset = rng.below(w === 0 ? 1 : Math.min(w + 1, 0x10000));
      let c = (u32(block.address) | (offset & w)) >>> 0;
      if (!inside) {
        // flip one must-match bit among the lowest 8 of them, so the miss is near the block
        const must: number[] = [];
        for (let b = 0; b < 32 && must.length < 8; b++) if (((w >>> b) & 1) === 0) must.push(b);
        c = (c ^ (1 << must[rng.below(must.length)]!)) >>> 0;
      }
      const candidate = u32ToIpv4(c);
      return {
        seed,
        index,
        kind,
        pair: block,
        candidate,
        prompt: `Does ${candidate} match "${aceText(block)}"? Answer yes or no.`,
        answer: wildcardMatches(candidate, block.address, block.wildcard) ? 'yes' : 'no',
      };
    }
  }
}

/** Moves the lowest any-bit of a block into a must-match position of a higher octet (a non-contiguous wildcard). */
function withExtraAnyBit(pair: WildcardPair, rng: PracticeRng): WildcardPair {
  const w = u32(pair.wildcard);
  if (w === 0 || w === 0xffffffff) return pair;
  const must: number[] = [];
  for (let b = 8; b < 32; b++) if (((w >>> b) & 1) === 0) must.push(b);
  if (must.length === 0) return pair;
  const bit = must[rng.below(must.length)]!;
  const lowest = w & -w;
  const nw = ((w & ~lowest) | (1 << bit)) >>> 0;
  return { address: u32ToIpv4((u32(pair.address) & ~nw) >>> 0), wildcard: u32ToIpv4(nw) };
}

/** Checks `input` against `problem`, accepting any reasonable spelling. */
export function checkWildcardAnswer(problem: WildcardProblem, input: string): WildcardCheck {
  const t = input.trim().toLowerCase();
  let given: string | null = null;
  switch (problem.kind) {
    case 'wildcard-for-prefix':
    case 'last-address': {
      const v = parseIpv4(t);
      if (v !== null) given = u32ToIpv4(v);
      break;
    }
    case 'count': {
      const digits = t.replace(/[\s,_]/g, '');
      if (/^\d+$/.test(digits)) given = String(Number(digits));
      break;
    }
    case 'matches':
      if (t === 'yes' || t === 'y' || t === 'true') given = 'yes';
      else if (t === 'no' || t === 'n' || t === 'false') given = 'no';
      break;
  }
  return { correct: given === problem.answer, expected: problem.answer, given, explanation: explainProblem(problem) };
}

function explainProblem(p: WildcardProblem): string {
  const view = wildcardView(p.pair.address, p.pair.wildcard);
  switch (p.kind) {
    case 'wildcard-for-prefix':
      return `The wildcard is the subnet mask inverted: 255 minus each octet of the /${view.prefixLen ?? 0} mask gives ${p.answer}.`;
    case 'count':
      return `${p.pair.wildcard} has ${view.anyBits} one-bit${view.anyBits === 1 ? '' : 's'} (bits that may be anything), so it matches 2^${view.anyBits} = ${p.answer} addresses${view.contiguous ? '' : ', even though they are not one block'}.`;
    case 'last-address':
      return `Keep the must-match bits of ${view.base} and set every any-bit to 1: ${p.answer}.`;
    case 'matches': {
      const test = testWildcard(p.pair, p.candidate ?? view.base);
      return test.text;
    }
  }
}

/** A random unicast host address: first octet 1–223 except 127, other octets 0–255. */
function randomUnicast(rng: PracticeRng): Ipv4Address {
  let first = 1 + rng.below(222); // 1..222
  if (first >= 127) first++; // skip loopback: 128..223
  return u32ToIpv4(((first << 24) | (rng.below(256) << 16) | (rng.below(256) << 8) | rng.below(256)) >>> 0);
}

/**
 * Deterministic draws for practice questions: the state is a 32-bit hash of `(seed, index)` (the murmur3
 * finaliser) and draws come from xorshift32. Integer maths only, so every platform agrees.
 */
class PracticeRng {
  #s: number;

  constructor(seed: number, index: number) {
    const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    let h = fmix32((s >>> 0) ^ 0x2545f491);
    h = fmix32(h ^ Math.imul(Math.floor(s / 4294967296) >>> 0, 0x85ebca6b));
    h = fmix32(h ^ Math.imul(index >>> 0, 0xc2b2ae35) ^ 0x165667b1);
    this.#s = h === 0 ? 0x6d2b79f5 : h;
  }

  next(): number {
    let x = this.#s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.#s = x;
    return x;
  }

  /** Uniform integer in [0, n) by rejection (no modulo bias). */
  below(n: number): number {
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
