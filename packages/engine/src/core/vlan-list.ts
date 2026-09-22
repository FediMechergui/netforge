/**
 * core/vlan-list.ts — canonical VLAN lists (ARCHITECTURE-P2 §2.2 `SwitchportConfig.allowed`, §3.2, §5.1).
 *
 * A VLAN list is TEXT wherever it is stored or shown: the running config (`switchport trunk allowed vlan …`), the
 * `SwitchportConfig.allowed` value read from it, `PortL2View.active` / `forwarding` in snapshots, `show` output and
 * the VLAN overlay chips. Every writer produces the ONE canonical form below, so two equal sets are always equal
 * strings (byte-stable snapshots and goldens).
 *
 * Canonical form:
 *   - VLAN ids 1..4094 (`VLAN_ID_MIN`..`VLAN_ID_MAX`), ascending, no duplicates, joined by ',' with no spaces;
 *   - a run of THREE or more consecutive ids is one range `a-b`; a run of two is written as two ids (`10,11`), as the
 *     device's own running configuration shows it;
 *   - every VLAN is `'1-4094'` (`VLAN_LIST_ALL`); no VLAN is `''` (`VLAN_LIST_NONE`).
 *
 * Accepted input (`parseVlanRanges`): items separated by ',', each an id `n` or a range `a-b` with a ≤ b, optional
 * blanks around items; ids outside 1..4094, an empty item, a reversed range or any other character make the whole
 * text invalid (undefined). The empty (or blank) text is the valid empty list. Keywords (`all`, `none`, `add`,
 * `remove`, `except`) are CLI forms resolved by the handler with the functions below; they are not list text.
 *
 * Set operations take list text in any accepted form and return canonical text. They throw a RangeError on text
 * that does not parse (callers validate user input first; stored values are canonical). `vlanListContains` is total:
 * it answers false for text that does not parse, so a per-frame check can never throw.
 *
 * Pure: no module state, no randomness; ranges are merged in ascending order.
 */

/** Lowest usable VLAN id. */
export const VLAN_ID_MIN = 1;
/** Highest usable VLAN id (802.1Q ids 0 and 4095 are reserved). */
export const VLAN_ID_MAX = 4094;
/** The canonical list of every VLAN. */
export const VLAN_LIST_ALL = '1-4094';
/** The canonical empty list. */
export const VLAN_LIST_NONE = '';

/** An inclusive run of VLAN ids `[lo, hi]`, lo ≤ hi. */
export type VlanRange = readonly [lo: number, hi: number];

/** True for an integer VLAN id in 1..4094. */
export function isVlanId(v: number): boolean {
  return Number.isInteger(v) && v >= VLAN_ID_MIN && v <= VLAN_ID_MAX;
}

const ITEM_RE = /^(\d{1,4})(?:-(\d{1,4}))?$/;

/** Sort and merge overlapping or adjacent ranges (input ranges must be valid). */
function normalize(ranges: readonly VlanRange[]): VlanRange[] {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

/**
 * Parse list text into ascending, merged ranges. Returns undefined when the text is not a valid VLAN list (see the
 * module header); `''` gives `[]`.
 */
export function parseVlanRanges(text: string): VlanRange[] | undefined {
  const t = text.trim();
  if (t === '') return [];
  const ranges: VlanRange[] = [];
  for (const raw of t.split(',')) {
    const m = ITEM_RE.exec(raw.trim());
    if (m === null) return undefined;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (!isVlanId(lo) || !isVlanId(hi) || lo > hi) return undefined;
    ranges.push([lo, hi]);
  }
  return normalize(ranges);
}

/** Parse list text into its ascending VLAN ids (undefined when the text is not a valid list). */
export function parseVlanList(text: string): number[] | undefined {
  const ranges = parseVlanRanges(text);
  if (ranges === undefined) return undefined;
  const out: number[] = [];
  for (const [lo, hi] of ranges) for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}

/** Canonical text of ranges (merged first, so any valid ranges are accepted). */
export function formatVlanRanges(ranges: readonly VlanRange[]): string {
  for (const [lo, hi] of ranges) {
    if (!isVlanId(lo) || !isVlanId(hi) || lo > hi) throw new RangeError(`invalid VLAN range ${lo}-${hi}`);
  }
  const parts: string[] = [];
  for (const [lo, hi] of normalize(ranges)) {
    if (hi - lo >= 2) parts.push(`${lo}-${hi}`);
    else if (hi === lo) parts.push(String(lo));
    else parts.push(String(lo), String(hi));
  }
  return parts.join(',');
}

/** Canonical text of a set of VLAN ids (any order, duplicates allowed). Throws a RangeError on a non-VLAN id. */
export function formatVlanList(vlans: Iterable<number>): string {
  const ranges: VlanRange[] = [];
  for (const v of vlans) {
    if (!isVlanId(v)) throw new RangeError(`invalid VLAN id ${v}`);
    ranges.push([v, v]);
  }
  return formatVlanRanges(ranges);
}

/** The canonical form of list text, or undefined when it does not parse. */
export function canonicalVlanList(text: string): string | undefined {
  const ranges = parseVlanRanges(text);
  return ranges === undefined ? undefined : formatVlanRanges(ranges);
}

function mustParse(text: string, what: string): VlanRange[] {
  const ranges = parseVlanRanges(text);
  if (ranges === undefined) throw new RangeError(`invalid VLAN list for ${what}: '${text}'`);
  return ranges;
}

/** Ranges of `a` minus the ranges of `b` (both normalized). */
function subtract(a: readonly VlanRange[], b: readonly VlanRange[]): VlanRange[] {
  const out: VlanRange[] = [];
  for (const [lo0, hi0] of a) {
    let lo = lo0;
    for (const [blo, bhi] of b) {
      if (bhi < lo || blo > hi0) continue;
      if (blo > lo) out.push([lo, blo - 1]);
      lo = bhi + 1;
      if (lo > hi0) break;
    }
    if (lo <= hi0) out.push([lo, hi0]);
  }
  return out;
}

/** True when `vlan` is in the list. Total: false for a non-VLAN id or for text that does not parse. */
export function vlanListContains(list: string, vlan: number): boolean {
  if (!isVlanId(vlan)) return false;
  const ranges = parseVlanRanges(list);
  if (ranges === undefined) return false;
  for (const [lo, hi] of ranges) {
    if (vlan < lo) return false;
    if (vlan <= hi) return true;
  }
  return false;
}

/** `list` ∪ `add` (the `… allowed vlan add <list>` form). */
export function vlanListAdd(list: string, add: string): string {
  return formatVlanRanges([...mustParse(list, 'add'), ...mustParse(add, 'add')]);
}

/** `list` minus `remove` (the `… allowed vlan remove <list>` form). */
export function vlanListRemove(list: string, remove: string): string {
  return formatVlanRanges(subtract(mustParse(list, 'remove'), mustParse(remove, 'remove')));
}

/** Every VLAN except `except` (the `… allowed vlan except <list>` form). */
export function vlanListExcept(except: string): string {
  return formatVlanRanges(subtract([[VLAN_ID_MIN, VLAN_ID_MAX]], mustParse(except, 'except')));
}

/** `a` ∩ `b` (e.g. a trunk's allowed list and the VLANs that exist: `PortL2View.active`). */
export function vlanListIntersect(a: string, b: string): string {
  const ra = mustParse(a, 'intersect');
  return formatVlanRanges(subtract(ra, subtract(ra, mustParse(b, 'intersect'))));
}

/** Number of VLANs in the list (throws a RangeError on text that does not parse). */
export function vlanListSize(list: string): number {
  let n = 0;
  for (const [lo, hi] of mustParse(list, 'size')) n += hi - lo + 1;
  return n;
}
