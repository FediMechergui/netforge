/**
 * device/catalog/names.ts — port-name vocabulary and resolution (docs/CATALOG.md naming; ARCHITECTURE-P1 D2, D7,
 * §3.10, §3.13 "Interface arguments").
 *
 * Every canonical port name is `${family.long}${number}` and its CLI short form `${family.short}${number}`, with
 * the family taken from PORT_FAMILIES (contracts/catalog.ts). `number` is empty (`Console`, `Internet`) or digits
 * separated by `/` or `.` (`0`, `0/1`, `1/0/24`).
 *
 * Resolution of a typed name (case-insensitive, optional whitespace between family and number):
 *  1. The text must be `<letters><optional space><number part>` (the P0 rule), else unknown.
 *  2. Against the live ports (fixed, module, virtual — whatever the source map holds, in its canonical order):
 *     a port is a candidate when its number equals the typed number and the typed letters are a prefix of its
 *     long family or equal its short family. Candidates whose family matches EXACTLY (long or short) win over
 *     prefix-only candidates. One family left → that port; several families → ambiguous.
 *  3. Otherwise against the model's creatable virtual families (`DeviceModel.virtualFamilies`): the number must
 *     be a plain decimal inside [min, max]; the canonical name is `${family}${n}` (leading zeros dropped). If
 *     that canonical name already exists in the source it resolves as existing; otherwise as virtual.
 *
 * P2 (ARCHITECTURE-P2 §3.4, D10, D11; W1 catalog):
 *  - family letters may be hyphenated (`Port-channel1`, `port-channel 1`; the short form `po1` as before);
 *  - a subinterface `<parent>.<n>` (`g0/0.10`) resolves, when no live port matches, by resolving `<parent>` against
 *    the live non-virtual ports (step 2) on a model that declares `subinterfaces`, with n a plain decimal in
 *    [1, `subinterfaces.max`]: `{kind:'virtual', port:'GigabitEthernet0/0.10', family:'subinterface', parent}` (or
 *    existing when that canonical name is live). Whether the parent may carry subinterfaces (its role) is decided at
 *    creation (device/ports.ts `planSubinterface`).
 *
 * Pure and deterministic: iteration follows the source map and the model arrays.
 */
import type { PortNameSource, PortResolution, DeviceModel } from '../../contracts/device.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortSpec } from '../../contracts/port.js';
import { PORT_FAMILIES, type PortFamily, type SlotSpec, type VirtualFamilySpec } from '../../contracts/catalog.js';

/**
 * Shape of every accepted typed port name: letters (P2: hyphenated words, `port-channel`), optional whitespace,
 * optional number part (lowercase input).
 */
const TYPED_NAME_RE = /^([a-z]+(?:-[a-z]+)*)\s*([0-9][0-9/.]*)?$/;

/** Shape of a canonical port name: letters (P2: hyphenated words) then an optional number part (case preserved). */
const CANONICAL_NAME_RE = /^([A-Za-z]+(?:-[A-Za-z]+)*)([0-9][0-9/.]*)?$/;

/** @since P2 `PortResolution.family` of a subinterface (D11). */
export const SUBINTERFACE_FAMILY = 'subinterface';

/** Shape of a canonical subinterface name: a parent without a dot, a dot, a plain decimal (`GigabitEthernet0/0.10`). */
const SUBINTERFACE_NAME_RE = /^([^.]+)\.([0-9]+)$/;

/** A plain decimal without sign or fraction. */
const DECIMAL_RE = /^[0-9]+$/;

/** A typed port name split into its lowercase family letters and its number part. */
export interface TypedPortName {
  /** Lowercase letters as typed, e.g. 'gi'. */
  readonly family: string;
  /** Number part as typed ('' when absent), e.g. '0/1'. */
  readonly number: string;
}

/**
 * Split user input into family letters and number part (trimmed, lowercased). Undefined when the text does not
 * have the port-name shape (empty, starts with a digit, contains other characters).
 */
export function parseTypedPortName(text: string): TypedPortName | undefined {
  const m = TYPED_NAME_RE.exec(text.trim().toLowerCase());
  if (!m) return undefined;
  return { family: m[1] as string, number: m[2] ?? '' };
}

/** Split a canonical (or short) port name into its family letters (case preserved) and number part. */
export function splitPortName(name: string): { family: string; number: string } | undefined {
  const m = CANONICAL_NAME_RE.exec(name);
  if (!m) return undefined;
  return { family: m[1] as string, number: m[2] ?? '' };
}

/** The PORT_FAMILIES entry whose long family is exactly the letter part of a canonical port name. */
export function portFamilyOf(name: string): PortFamily | undefined {
  const parts = splitPortName(name);
  if (!parts) return undefined;
  return PORT_FAMILIES.find((f) => f.long === parts.family);
}

/** The PORT_FAMILIES entry with this long family name (e.g. 'Serial'). */
export function portFamilyByLong(long: string): PortFamily | undefined {
  return PORT_FAMILIES.find((f) => f.long === long);
}

/** CLI short form of a canonical port name (`GigabitEthernet0/1` → `Gi0/1`); undefined for an unknown family. */
export function shortPortName(name: string): string | undefined {
  const parts = splitPortName(name);
  if (!parts) return undefined;
  const fam = PORT_FAMILIES.find((f) => f.long === parts.family);
  return fam ? `${fam.short}${parts.number}` : undefined;
}

/**
 * Canonical name of a module-generated port (D7): `${family}${slot.numbering}/${index}`, or `${family}${index}`
 * for host-expansion templates with `absolute` naming (and for slots with an empty numbering).
 */
export function modulePortName(family: string, slot: Pick<SlotSpec, 'numbering'>, index: number, absolute: boolean): PortId {
  if (absolute || slot.numbering === '') return `${family}${index}`;
  return `${family}${slot.numbering}/${index}`;
}

/** Canonical name of instance `n` of a virtual interface family (`Vlan1`, `Loopback0`, P2 `Port-channel1`). */
export function virtualPortName(family: Pick<VirtualFamilySpec, 'family'>, n: number): PortId {
  return `${family.family}${n}`;
}

/** @since P2 Canonical name of subinterface `n` of `parent` (`GigabitEthernet0/0.10`). */
export function subinterfacePortName(parent: PortId, n: number): PortId {
  return `${parent}.${n}`;
}

/**
 * @since P2 Split a canonical subinterface name into its parent and number (`GigabitEthernet0/0.10` →
 * {parent 'GigabitEthernet0/0', number 10}). Undefined when the name has no single `.<decimal>` suffix after a
 * dot-free parent, or the number is not a safe integer.
 */
export function parseSubinterfaceName(name: PortId): { parent: PortId; number: number } | undefined {
  const m = SUBINTERFACE_NAME_RE.exec(name);
  if (!m) return undefined;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { parent: m[1] as PortId, number };
}

/**
 * Resolve typed text against a list of port specs (fixed, module or virtual; canonical order). Returns `existing`,
 * `ambiguous` (candidates = first matching port of each family, in list order) or `unknown`. Never `virtual`.
 */
export function matchPortName(ports: Iterable<Pick<PortSpec, 'name' | 'short'>>, text: string): PortResolution {
  const typed = parseTypedPortName(text);
  if (!typed) return { kind: 'unknown' };
  return matchTyped(ports, typed);
}

function matchTyped(ports: Iterable<Pick<PortSpec, 'name' | 'short'>>, typed: TypedPortName): PortResolution {
  const exact: { port: PortId; family: string }[] = [];
  const prefix: { port: PortId; family: string }[] = [];
  for (const spec of ports) {
    const canon = splitPortName(spec.name);
    if (!canon || canon.number !== typed.number) continue;
    const longFamily = canon.family.toLowerCase();
    const short = splitPortName(spec.short);
    const shortFamily = short ? short.family.toLowerCase() : '';
    if (longFamily === typed.family || shortFamily === typed.family) {
      exact.push({ port: spec.name, family: longFamily });
    } else if (longFamily.startsWith(typed.family)) {
      prefix.push({ port: spec.name, family: longFamily });
    }
  }
  const pool = exact.length > 0 ? exact : prefix;
  if (pool.length === 0) return { kind: 'unknown' };
  const families: string[] = [];
  const candidates: PortId[] = [];
  for (const c of pool) {
    if (families.includes(c.family)) continue;
    families.push(c.family);
    candidates.push(c.port);
  }
  if (candidates.length === 1) return { kind: 'existing', port: candidates[0] as PortId };
  return { kind: 'ambiguous', candidates };
}

/** Port specs of a live source in its map order. */
function sourceSpecs(source: PortNameSource): Pick<PortSpec, 'name' | 'short'>[] {
  const out: Pick<PortSpec, 'name' | 'short'>[] = [];
  for (const entry of source.ports.values()) out.push(entry.spec);
  return out;
}

/**
 * Resolve a typed port name against a live device (fixed + module + virtual ports in `source.ports`) and, when
 * nothing exists, against the model's creatable virtual families (see the file header for the exact rules).
 * Implements `DeviceCatalog.resolvePort` / `DeviceRuntime.resolvePortName`.
 */
export function resolvePortName(source: PortNameSource, text: string): PortResolution {
  const typed = parseTypedPortName(text);
  if (!typed) return { kind: 'unknown' };
  const specs = sourceSpecs(source);
  const existing = matchTyped(specs, typed);
  if (existing.kind !== 'unknown') return existing;
  if (typed.number.includes('.')) return resolveSubinterface(source, specs, typed);
  const families = source.model.virtualFamilies ?? [];
  if (families.length === 0 || !DECIMAL_RE.test(typed.number)) return { kind: 'unknown' };
  const n = Number(typed.number);
  if (!Number.isSafeInteger(n)) return { kind: 'unknown' };
  const exact: VirtualFamilySpec[] = [];
  const prefix: VirtualFamilySpec[] = [];
  for (const fam of families) {
    const long = fam.family.toLowerCase();
    const short = fam.short.toLowerCase();
    if (long === typed.family || short === typed.family) exact.push(fam);
    else if (long.startsWith(typed.family)) prefix.push(fam);
  }
  const pool = (exact.length > 0 ? exact : prefix).filter((f) => n >= f.min && n <= f.max);
  if (pool.length === 0) return { kind: 'unknown' };
  if (pool.length > 1) return { kind: 'ambiguous', candidates: pool.map((f) => virtualPortName(f, n)) };
  const fam = pool[0] as VirtualFamilySpec;
  const name = virtualPortName(fam, n);
  if (source.ports.has(name)) return { kind: 'existing', port: name };
  return { kind: 'virtual', port: name, family: fam.family };
}

/**
 * @since P2 Step 4 of `resolvePortName` (file header): a typed `<parent>.<n>` that names no live port. The number part
 * is split at its FIRST dot, so `<parent>` never contains one (no subinterface of a subinterface).
 */
function resolveSubinterface(source: PortNameSource, specs: readonly Pick<PortSpec, 'name' | 'short'>[], typed: TypedPortName): PortResolution {
  const spec = source.model.subinterfaces;
  if (spec === undefined) return { kind: 'unknown' };
  const dot = typed.number.indexOf('.');
  const parentNumber = typed.number.slice(0, dot);
  const sub = typed.number.slice(dot + 1);
  if (parentNumber === '' || !DECIMAL_RE.test(sub)) return { kind: 'unknown' };
  const n = Number(sub);
  if (!Number.isSafeInteger(n) || n < 1 || n > spec.max) return { kind: 'unknown' };
  // The parent is a live port that is not a virtual interface of the model (Vlan, Loopback, Port-channel, …).
  const virtualFamilies = (source.model.virtualFamilies ?? []).map((f) => f.family);
  const physical = specs.filter((s) => {
    const parts = splitPortName(s.name);
    return parts !== undefined && !virtualFamilies.includes(parts.family) && !s.name.includes('.');
  });
  const parent = matchTyped(physical, { family: typed.family, number: parentNumber });
  if (parent.kind === 'ambiguous') return { kind: 'ambiguous', candidates: parent.candidates.map((c) => subinterfacePortName(c, n)) };
  if (parent.kind !== 'existing') return { kind: 'unknown' };
  const port = subinterfacePortName(parent.port, n);
  if (source.ports.has(port)) return { kind: 'existing', port };
  return { kind: 'virtual', port, family: SUBINTERFACE_FAMILY, parent: parent.port };
}

/**
 * P0-compatible expansion against `model.ports` only (the deprecated `DeviceCatalog.canonicalPort`): the
 * canonical name of the one matching port, or undefined when unknown or ambiguous.
 */
export function canonicalPortName(model: Pick<DeviceModel, 'ports'>, text: string): PortId | undefined {
  const r = matchPortName(model.ports, text);
  return r.kind === 'existing' ? r.port : undefined;
}
