/**
 * Subnetting workbench model (ARCHITECTURE-P1 §4.13, §8.2 W2 web-learn): pure, DOM-free functions behind the
 * subnetting concept view.
 *
 * - `parseSubnetInput` reads `a.b.c.d/len`, `a.b.c.d/m.m.m.m` or `a.b.c.d m.m.m.m`.
 * - `subnetInfo` gives the bit view, the mask boundary (the interesting octet and its block size), network,
 *   broadcast, usable range, wildcard and classful context of one address.
 * - `carveVlsm` carves a parent block into variable-length subnets, largest requirement first.
 * - `practiceProblem` / `checkPracticeAnswer` form a practice generator that is a pure function of
 *   `(seed, index)`: the same seed always yields the same sequence of questions, on every machine.
 *
 * Address arithmetic comes from the engine address helpers (u32 dotted-quad maths and `usableHostRange`,
 * which follows RFC 3021 for /31 and gives one host for /32). All wording is original (D13).
 */
import {
  ipv4Class,
  isIpv4Private,
  maskToPrefixLen,
  parseIpv4,
  prefixLenToMaskU32,
  u32ToIpv4,
  usableHostRange,
} from '@netforge/engine/pure';
import type { Ipv4Address } from '@netforge/engine/pure';

// ── input ────────────────────────────────────────────────────────────────────

/** An IPv4 address with its prefix length (0..32). */
export interface SubnetInput {
  address: Ipv4Address;
  prefixLen: number;
}

/** Result of reading user text into an address and a prefix length. */
export type SubnetParseResult = { ok: true; value: SubnetInput } | { ok: false; error: string };

/**
 * Reads `192.168.1.130/26`, `192.168.1.130/255.255.255.192` or `192.168.1.130 255.255.255.192`.
 * The address is returned in canonical dotted form; masks must be contiguous.
 */
export function parseSubnetInput(text: string): SubnetParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'Enter an address with a prefix, for example 192.168.1.130/26.' };
  const m = /^(\S+?)\s*(?:\/\s*|\s+)(\S+)$/.exec(t);
  if (!m) return { ok: false, error: 'Add a prefix length (/26) or a dotted mask after the address.' };
  const addr = parseIpv4(m[1]!);
  if (addr === null) return { ok: false, error: `"${m[1]!}" is not a valid IPv4 address.` };
  const prefixLen = parsePrefixOrMask(m[2]!);
  if (prefixLen === null) {
    return { ok: false, error: `"${m[2]!}" is neither a prefix length from 0 to 32 nor a contiguous dotted mask.` };
  }
  return { ok: true, value: { address: u32ToIpv4(addr), prefixLen } };
}

/** `26`, `/26` or `255.255.255.192` → 26; null for anything else (including non-contiguous masks). */
export function parsePrefixOrMask(text: string): number | null {
  const t = text.trim().replace(/^\//, '');
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n <= 32 ? n : null;
  }
  if (parseIpv4(t) === null) return null;
  return maskToPrefixLen(t);
}

// ── bits ─────────────────────────────────────────────────────────────────────

/** The 32 bits of a u32, most significant first, as a string of '0'/'1'. */
export function u32ToBits(v: number): string {
  return (v >>> 0).toString(2).padStart(32, '0');
}

/** The 32 bits of a dotted IPv4 address. @throws on invalid input. */
export function ipv4ToBits(ip: Ipv4Address): string {
  const v = parseIpv4(ip);
  if (v === null) throw new Error(`invalid IPv4 address ${ip}`);
  return u32ToBits(v);
}

/**
 * Groups a 32-bit string into dotted octets (`11000000.10101000.00000001.10000010`). With `prefixLen`, a `|`
 * marks the mask boundary (on an octet edge it replaces the dot).
 */
export function formatBits(bits: string, prefixLen?: number): string {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    if (i > 0 && i % 8 === 0) out += i === prefixLen ? '|' : '.';
    else if (i > 0 && i === prefixLen) out += '|';
    out += bits[i];
  }
  return out;
}

/** One bit of the bit view. */
export interface BitCell {
  /** 0..31, most significant first. */
  index: number;
  bit: 0 | 1;
  /** Octet 0..3 this bit belongs to. */
  octet: number;
  /** Network bits lie before the prefix length, host bits after it. */
  part: 'network' | 'host';
}

/** The 32 bit cells of `ip` split at `prefixLen`. @throws on invalid input. */
export function bitCells(ip: Ipv4Address, prefixLen: number): BitCell[] {
  checkPrefixLen(prefixLen);
  const bits = ipv4ToBits(ip);
  const cells: BitCell[] = [];
  for (let i = 0; i < 32; i++) {
    cells.push({ index: i, bit: bits[i] === '1' ? 1 : 0, octet: i >> 3, part: i < prefixLen ? 'network' : 'host' });
  }
  return cells;
}

// ── mask boundary ────────────────────────────────────────────────────────────

/** Where the prefix ends, seen octet by octet (the "interesting octet" method). */
export interface MaskBoundary {
  prefixLen: number;
  /** Octet 0..3 holding the first host bit (octet 3 for /32). */
  octetIndex: number;
  /** Network bits inside that octet (0..8). */
  networkBitsInOctet: number;
  /** Mask value of that octet (0, 128, 192, …, 255). */
  maskOctet: number;
  /** Step between consecutive subnets in that octet: 256 − maskOctet (1 for /32). */
  blockSize: number;
  /** True when the prefix ends exactly on an octet edge. */
  onOctetEdge: boolean;
}

/** Mask boundary of a prefix length. @throws RangeError outside 0..32. */
export function maskBoundary(prefixLen: number): MaskBoundary {
  checkPrefixLen(prefixLen);
  const octetIndex = Math.min(3, prefixLen >> 3);
  const networkBitsInOctet = prefixLen - octetIndex * 8;
  const maskOctet = (0xff00 >> networkBitsInOctet) & 0xff;
  return {
    prefixLen,
    octetIndex,
    networkBitsInOctet,
    maskOctet,
    blockSize: 256 - maskOctet,
    onOctetEdge: prefixLen % 8 === 0,
  };
}

// ── subnet info ──────────────────────────────────────────────────────────────

/** Classful context of an address: default prefix, and how many bits the prefix borrows from it. */
export interface ClassfulContext {
  addressClass: 'A' | 'B' | 'C' | 'D' | 'E';
  /** 8, 16 or 24 for classes A–C; null for D and E. */
  defaultPrefixLen: number | null;
  /** prefixLen − defaultPrefixLen when positive; 0 when the prefix is not longer; null for D and E. */
  borrowedBits: number | null;
  /** 2^borrowedBits; null for D and E. */
  subnetCount: number | null;
}

/** Every figure the workbench shows for one address/prefix. */
export interface SubnetInfo {
  address: Ipv4Address;
  prefixLen: number;
  mask: Ipv4Address;
  wildcard: Ipv4Address;
  network: Ipv4Address;
  broadcast: Ipv4Address;
  firstUsable: Ipv4Address;
  lastUsable: Ipv4Address;
  /** Usable hosts (RFC 3021: 2 for /31; 1 for /32). */
  usableHosts: number;
  /** 2^(32 − prefixLen). */
  totalAddresses: number;
  /** Offset of the address inside its subnet (0 = the network address). */
  hostOffset: number;
  /** The address is the network or broadcast address of a /0–/30 subnet (not assignable to a host). */
  reserved: 'network' | 'broadcast' | null;
  isPrivate: boolean;
  classful: ClassfulContext;
  boundary: MaskBoundary;
  bits: { address: string; mask: string; wildcard: string; network: string; broadcast: string };
}

/** Workbench figures for `address/prefixLen`. @throws on an invalid address or prefix length. */
export function subnetInfo(address: Ipv4Address, prefixLen: number): SubnetInfo {
  checkPrefixLen(prefixLen);
  const v = parseIpv4(address);
  if (v === null) throw new Error(`invalid IPv4 address ${address}`);
  const range = usableHostRange(address, prefixLen)!;
  const mask = prefixLenToMaskU32(prefixLen);
  const wildcard = ~mask >>> 0;
  const net = (v & mask) >>> 0;
  const bcast = (net | wildcard) >>> 0;
  let reserved: SubnetInfo['reserved'] = null;
  if (prefixLen <= 30 && v === net) reserved = 'network';
  else if (prefixLen <= 30 && v === bcast) reserved = 'broadcast';
  return {
    address: u32ToIpv4(v),
    prefixLen,
    mask: u32ToIpv4(mask),
    wildcard: u32ToIpv4(wildcard),
    network: range.network,
    broadcast: range.broadcast,
    firstUsable: range.first,
    lastUsable: range.last,
    usableHosts: range.count,
    totalAddresses: 2 ** (32 - prefixLen),
    hostOffset: (v - net) >>> 0,
    reserved,
    isPrivate: isIpv4Private(u32ToIpv4(v)),
    classful: classfulContext(u32ToIpv4(v), prefixLen),
    boundary: maskBoundary(prefixLen),
    bits: {
      address: u32ToBits(v),
      mask: u32ToBits(mask),
      wildcard: u32ToBits(wildcard),
      network: u32ToBits(net),
      broadcast: u32ToBits(bcast),
    },
  };
}

/** Classful class, default prefix and borrowed bits of `address/prefixLen`. @throws on invalid input. */
export function classfulContext(address: Ipv4Address, prefixLen: number): ClassfulContext {
  checkPrefixLen(prefixLen);
  const addressClass = ipv4Class(address);
  const defaultPrefixLen = addressClass === 'A' ? 8 : addressClass === 'B' ? 16 : addressClass === 'C' ? 24 : null;
  if (defaultPrefixLen === null) return { addressClass, defaultPrefixLen, borrowedBits: null, subnetCount: null };
  const borrowedBits = Math.max(0, prefixLen - defaultPrefixLen);
  return { addressClass, defaultPrefixLen, borrowedBits, subnetCount: 2 ** borrowedBits };
}

/** The subnet `offset` steps after (or, negative, before) the one holding `address`; null when it leaves 0.0.0.0–255.255.255.255. */
export function neighbourSubnet(address: Ipv4Address, prefixLen: number, offset: number): Ipv4Address | null {
  checkPrefixLen(prefixLen);
  const v = parseIpv4(address);
  if (v === null) throw new Error(`invalid IPv4 address ${address}`);
  const size = 2 ** (32 - prefixLen);
  const net = (v & prefixLenToMaskU32(prefixLen)) >>> 0;
  const target = net + offset * size;
  if (!Number.isInteger(target) || target < 0 || target > 0xffffffff) return null;
  return u32ToIpv4(target);
}

// ── VLSM ─────────────────────────────────────────────────────────────────────

/** One subnet to carve: a label and the number of hosts it must hold. */
export interface VlsmRequirement {
  name: string;
  hosts: number;
}

/** One carved subnet. */
export interface VlsmAllocation {
  name: string;
  /** Position of the requirement in the input list. */
  inputIndex: number;
  hostsRequested: number;
  prefixLen: number;
  cidr: string;
  network: Ipv4Address;
  mask: Ipv4Address;
  broadcast: Ipv4Address;
  firstUsable: Ipv4Address;
  lastUsable: Ipv4Address;
  usableHosts: number;
  /** usableHosts − hostsRequested. */
  spareHosts: number;
}

/** Outcome of a VLSM carve. On failure, `allocations` holds the subnets placed before the one that did not fit. */
export type VlsmResult =
  | {
      ok: true;
      parent: string;
      allocations: VlsmAllocation[];
      /** Unused space after the last allocation, as the fewest aligned CIDR blocks, in address order. */
      free: string[];
      usedAddresses: number;
      totalAddresses: number;
    }
  | { ok: false; error: string; allocations: VlsmAllocation[] };

/**
 * Smallest prefix whose subnet holds `hosts` usable addresses (network and broadcast excluded, so 2 hosts → /30).
 * Null when `hosts` is not a positive integer or does not fit even in a /1.
 */
export function prefixForHosts(hosts: number): number | null {
  if (!Number.isInteger(hosts) || hosts < 1) return null;
  for (let p = 30; p >= 1; p--) {
    if (2 ** (32 - p) - 2 >= hosts) return p;
  }
  return null;
}

/**
 * Carves `parent` (`a.b.c.d/len`) for `requirements`: largest host count first (ties keep input order), each
 * subnet the smallest block that fits, placed at the next free address. Placing blocks in decreasing size keeps
 * every block aligned on its own size.
 */
export function carveVlsm(parent: string, requirements: readonly VlsmRequirement[]): VlsmResult {
  const parsed = parseSubnetInput(parent);
  if (!parsed.ok) return { ok: false, error: parsed.error, allocations: [] };
  const parentLen = parsed.value.prefixLen;
  const parentMask = prefixLenToMaskU32(parentLen);
  const start = (parseIpv4(parsed.value.address)! & parentMask) >>> 0;
  const total = 2 ** (32 - parentLen);
  const end = start + total; // exclusive
  const parentCidr = `${u32ToIpv4(start)}/${parentLen}`;

  const order = requirements.map((r, i) => ({ r, i }));
  for (const { r, i } of order) {
    if (prefixForHosts(r.hosts) === null) {
      return { ok: false, error: `Requirement ${i + 1} (${label(r, i)}) needs a whole number of hosts of at least 1.`, allocations: [] };
    }
  }
  order.sort((a, b) => (b.r.hosts - a.r.hosts) || (a.i - b.i));

  const allocations: VlsmAllocation[] = [];
  let cursor = start;
  for (const { r, i } of order) {
    const prefixLen = prefixForHosts(r.hosts)!;
    const size = 2 ** (32 - prefixLen);
    if (prefixLen < parentLen || cursor + size > end) {
      const left = end - cursor;
      return {
        ok: false,
        error: `${label(r, i)} needs a /${prefixLen} block of ${size} addresses, but only ${left} address${left === 1 ? '' : 'es'} remain in ${parentCidr}.`,
        allocations,
      };
    }
    const network = u32ToIpv4(cursor);
    const info = subnetInfo(network, prefixLen);
    allocations.push({
      name: r.name,
      inputIndex: i,
      hostsRequested: r.hosts,
      prefixLen,
      cidr: `${network}/${prefixLen}`,
      network,
      mask: info.mask,
      broadcast: info.broadcast,
      firstUsable: info.firstUsable,
      lastUsable: info.lastUsable,
      usableHosts: info.usableHosts,
      spareHosts: info.usableHosts - r.hosts,
    });
    cursor += size;
  }
  return { ok: true, parent: parentCidr, allocations, free: freeBlocks(cursor, end), usedAddresses: cursor - start, totalAddresses: total };
}

/** Fewest aligned CIDR blocks covering [from, to) in address order. */
export function freeBlocks(from: number, to: number): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur < to) {
    let size = 1;
    let hostBits = 0;
    // grow while the doubled block keeps `cur` aligned and stays inside the range
    while (hostBits < 32 && cur % (size * 2) === 0 && cur + size * 2 <= to) {
      size *= 2;
      hostBits++;
    }
    out.push(`${u32ToIpv4(cur)}/${32 - hostBits}`);
    cur += size;
  }
  return out;
}

/** Display label of a requirement: its name, or its position when unnamed. */
function label(r: VlsmRequirement, i: number): string {
  const n = r.name.trim();
  return n === '' ? `Subnet ${i + 1}` : n;
}

// ── practice ─────────────────────────────────────────────────────────────────

/** Kinds of practice questions. */
export type PracticeKind =
  | 'network'
  | 'broadcast'
  | 'first-usable'
  | 'last-usable'
  | 'usable-hosts'
  | 'mask'
  | 'wildcard'
  | 'prefix-for-hosts';

/** Every practice kind, in the order the generator draws from. */
export const PRACTICE_KINDS: readonly PracticeKind[] = [
  'network',
  'broadcast',
  'first-usable',
  'last-usable',
  'usable-hosts',
  'mask',
  'wildcard',
  'prefix-for-hosts',
];

/** One practice question with its expected answer. */
export interface PracticeProblem {
  seed: number;
  index: number;
  kind: PracticeKind;
  /** The address the question is about (for `prefix-for-hosts`, the network being subnetted). */
  address: Ipv4Address;
  prefixLen: number;
  /** Required hosts (only for `prefix-for-hosts`). */
  hosts?: number;
  prompt: string;
  /** Canonical answer: a dotted address or mask, a decimal count, or `/len`. */
  answer: string;
}

/** Outcome of checking one answer. */
export interface PracticeCheck {
  correct: boolean;
  expected: string;
  /** The answer read into canonical form, or null when it could not be read at all. */
  given: string | null;
  /** Short original explanation of how the expected answer is found. */
  explanation: string;
}

/**
 * Question `index` (0, 1, 2, …) of the practice series for `seed`. A pure function of its inputs: the same
 * `(seed, index, kinds)` always gives the same question. `kinds` narrows the kinds drawn from (default: all).
 */
export function practiceProblem(seed: number, index: number, kinds: readonly PracticeKind[] = PRACTICE_KINDS): PracticeProblem {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`practice index ${index}`);
  if (kinds.length === 0) throw new RangeError('practiceProblem: no question kinds selected');
  const rng = new PracticeRng(seed, index);
  const kind = kinds[rng.below(kinds.length)]!;
  const address = randomUnicast(rng);

  if (kind === 'prefix-for-hosts') {
    const hostBits = 2 + rng.below(13); // 2..14 host bits
    const lo = 2 ** (hostBits - 1) - 2; // most hosts one host bit fewer could hold
    const hosts = lo + 1 + rng.below(2 ** hostBits - 2 - lo);
    const prefixLen = 32 - hostBits;
    const parentLen = Math.max(8, prefixLen - 1 - rng.below(Math.max(1, prefixLen - 8)));
    const network = u32ToIpv4((parseIpv4(address)! & prefixLenToMaskU32(parentLen)) >>> 0);
    return {
      seed,
      index,
      kind,
      address: network,
      prefixLen: parentLen,
      hosts,
      prompt: `Each subnet of ${network}/${parentLen} must hold ${hosts} hosts. Which prefix length wastes the fewest addresses?`,
      answer: `/${prefixLen}`,
    };
  }

  const prefixLen = 8 + rng.below(23); // 8..30
  const info = subnetInfo(address, prefixLen);
  const subject = `${address}/${prefixLen}`;
  switch (kind) {
    case 'network':
      return { seed, index, kind, address, prefixLen, prompt: `What is the network address of ${subject}?`, answer: info.network };
    case 'broadcast':
      return { seed, index, kind, address, prefixLen, prompt: `What is the broadcast address of ${subject}?`, answer: info.broadcast };
    case 'first-usable':
      return { seed, index, kind, address, prefixLen, prompt: `What is the first usable host address in the subnet of ${subject}?`, answer: info.firstUsable };
    case 'last-usable':
      return { seed, index, kind, address, prefixLen, prompt: `What is the last usable host address in the subnet of ${subject}?`, answer: info.lastUsable };
    case 'usable-hosts':
      return { seed, index, kind, address, prefixLen, prompt: `How many usable host addresses does the subnet of ${subject} have?`, answer: String(info.usableHosts) };
    case 'mask':
      return { seed, index, kind, address, prefixLen, prompt: `Write the prefix /${prefixLen} of ${subject} as a dotted subnet mask.`, answer: info.mask };
    case 'wildcard':
      return { seed, index, kind, address, prefixLen, prompt: `What wildcard mask matches the subnet of ${subject}?`, answer: info.wildcard };
  }
}

/** Checks `input` against `problem`, accepting any reasonable spelling (spaces, `/26` or `26` or a dotted mask). */
export function checkPracticeAnswer(problem: PracticeProblem, input: string): PracticeCheck {
  const t = input.trim();
  let given: string | null = null;
  switch (problem.kind) {
    case 'network':
    case 'broadcast':
    case 'first-usable':
    case 'last-usable':
    case 'mask':
    case 'wildcard': {
      const v = parseIpv4(t);
      if (v !== null) given = u32ToIpv4(v);
      else if (problem.kind === 'mask') {
        const p = parsePrefixOrMask(t);
        if (p !== null && /^\/?\d{1,2}$/.test(t)) given = u32ToIpv4(prefixLenToMaskU32(p));
      }
      break;
    }
    case 'usable-hosts': {
      const digits = t.replace(/[\s,_]/g, '');
      if (/^\d+$/.test(digits)) given = String(Number(digits));
      break;
    }
    case 'prefix-for-hosts': {
      const p = parsePrefixOrMask(t);
      if (p !== null) given = `/${p}`;
      break;
    }
  }
  return { correct: given === problem.answer, expected: problem.answer, given, explanation: explainProblem(problem) };
}

/** Original one-line method for each kind of question. */
function explainProblem(p: PracticeProblem): string {
  if (p.kind === 'prefix-for-hosts') {
    const hostBits = 32 - Number(p.answer.slice(1));
    return `${p.hosts} hosts plus the network and broadcast addresses need ${hostBits} host bits (2^${hostBits} − 2 = ${2 ** hostBits - 2}), so the prefix is 32 − ${hostBits} = ${p.answer}.`;
  }
  const info = subnetInfo(p.address, p.prefixLen);
  const b = info.boundary;
  const where = b.onOctetEdge && b.networkBitsInOctet === 0
    ? `the prefix ends on an octet edge, so octet ${b.octetIndex + 1} onwards is all host bits`
    : `octet ${b.octetIndex + 1} is the interesting octet: mask ${b.maskOctet}, block size ${b.blockSize}`;
  switch (p.kind) {
    case 'network':
      return `Keep the network bits and zero the host bits; ${where}. Network: ${info.network}.`;
    case 'broadcast':
      return `Keep the network bits and set every host bit to 1; ${where}. Broadcast: ${info.broadcast}.`;
    case 'first-usable':
      return `The first usable host is the network address plus one: ${info.network} + 1 = ${info.firstUsable}.`;
    case 'last-usable':
      return `The last usable host is the broadcast address minus one: ${info.broadcast} − 1 = ${info.lastUsable}.`;
    case 'usable-hosts':
      return `${32 - p.prefixLen} host bits give 2^${32 - p.prefixLen} = ${info.totalAddresses} addresses, minus the network and broadcast: ${info.usableHosts}.`;
    case 'mask':
      return `/${p.prefixLen} is ${p.prefixLen} one-bits followed by ${32 - p.prefixLen} zero-bits: ${info.mask}.`;
    case 'wildcard':
      return `The wildcard is the mask inverted (255 minus each octet): 255.255.255.255 − ${info.mask} = ${info.wildcard}.`;
  }
}

/** A random unicast host address: first octet 1–223 except 127, other octets 0–255. */
function randomUnicast(rng: PracticeRng): Ipv4Address {
  let first = 1 + rng.below(222); // 1..222
  if (first >= 127) first++; // skip loopback: 128..223
  const v = ((first << 24) | (rng.below(256) << 16) | (rng.below(256) << 8) | rng.below(256)) >>> 0;
  return u32ToIpv4(v);
}

/**
 * Small deterministic generator for practice questions: the state is a 32-bit hash of `(seed, index)`
 * (murmur3 finaliser) and draws come from xorshift32. Integer maths only, so every platform agrees.
 */
class PracticeRng {
  #s: number;

  constructor(seed: number, index: number) {
    const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    let h = fmix32((s >>> 0) ^ 0x9e3779b9);
    h = fmix32(h ^ Math.imul(Math.floor(s / 4294967296) >>> 0, 0x85ebca6b));
    h = fmix32(h ^ Math.imul(index >>> 0, 0xc2b2ae35) ^ 0x27d4eb2f);
    this.#s = h === 0 ? 0x6d2b79f5 : h;
  }

  /** Next u32. */
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

/** murmur3 32-bit finaliser. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** @throws RangeError unless 0 ≤ prefixLen ≤ 32 and integral. */
function checkPrefixLen(prefixLen: number): void {
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) throw new RangeError(`prefix length ${prefixLen}`);
}
