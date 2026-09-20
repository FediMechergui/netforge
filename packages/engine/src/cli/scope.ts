/**
 * cli/scope.ts — which command specs a session may use (ARCHITECTURE-P1 D2, §3.13; contracts/cli.ts SCOPING).
 *
 * A spec is IN SCOPE for a session when:
 *   • its `mode` (a mode name, a list, or the class selectors `@exec` / `@config` / `@auth` / `@all`) admits the
 *     session mode, and the session mode exists in the device grammar (`MODES[mode].grammars`);
 *   • `spec.privilege <= privilege`;
 *   • the device grammar is in `spec.grammars ?? DEFAULT_GRAMMARS`;
 *   • every `requires` capability and at least one `requiresAny` capability is in the device's EFFECTIVE
 *     capabilities (`DeviceRuntime.capabilities`);
 *
 * `portRequires` is NOT part of the cached scope: it is evaluated per call against the session's selected
 * interface (`portRequirementMet`). A spec failing it is hidden from `?` and Tab; a line typed in full gets
 * `portMismatchMessage(spec)` at the column of the spec's first literal (the parser does that).
 *
 * Scope results are cached per (spec table identity, grammar, mode, privilege, capability set, portsVersion,
 * legacy kind) by `createScopeCache`. Every iteration runs over the spec array in table order, so the result
 * keeps table order and is deterministic. Pure: no clocks, no randomness, no I/O.
 */
import { CAPABILITIES } from '../contracts/catalog.js';
import type { Capability, CliGrammar, PortRole } from '../contracts/catalog.js';
import { CLI_MESSAGES, DEFAULT_GRAMMARS } from '../contracts/cli.js';
import type { CliMode, CommandSpec, PortRequirement, PrivilegeLevel } from '../contracts/cli.js';
import type { PortView } from '../contracts/port.js';
import { modeInGrammar, specModeAllows } from './modes.js';

/** Capabilities as accepted by the scope functions: the expanded list or a set. */
export type CapabilityInput = readonly Capability[] | ReadonlySet<Capability>;

/** Everything the device-level scope depends on. */
export interface ScopeInput {
  /** Device grammar (`model.cli.grammar`). Undefined (P0 fixtures without a CliSpec) skips the grammar gate. */
  readonly grammar?: CliGrammar;
  readonly mode: CliMode;
  readonly privilege: PrivilegeLevel;
  /** Effective capabilities. Undefined = none (a P0 literal model has no capabilities). */
  readonly capabilities?: CapabilityInput;
  /** `DeviceRuntime.portsVersion`; part of the cache key. Undefined counts as 0. */
  readonly portsVersion?: number;
}

/** Default number of scope results a cache keeps per spec table before evicting the oldest. */
export const SCOPE_CACHE_LIMIT = 256;

function capabilitySet(caps: CapabilityInput | undefined): ReadonlySet<Capability> {
  if (caps === undefined) return new Set<Capability>();
  if (caps instanceof Set) return caps;
  return new Set(caps as readonly Capability[]);
}

function hasCap(caps: CapabilityInput | undefined, cap: Capability): boolean {
  if (caps === undefined) return false;
  if (caps instanceof Set) return caps.has(cap);
  return (caps as readonly Capability[]).includes(cap);
}

/** Canonical text of a capability set: CAPABILITIES order, comma separated (order of the input does not matter). */
export function capabilityKey(caps: CapabilityInput | undefined): string {
  const set = capabilitySet(caps);
  return CAPABILITIES.filter((c) => set.has(c)).join(',');
}

/** Cache key of a scope input (the spec table identity is handled by the cache itself). */
export function scopeKey(input: ScopeInput): string {
  return [
    input.grammar ?? '*',
    input.mode,
    String(input.privilege),
    capabilityKey(input.capabilities),
    String(input.portsVersion ?? 0),
  ].join('|');
}

/** Whether the device grammar admits the spec (`grammars ?? DEFAULT_GRAMMARS`); an undefined grammar always does. */
export function grammarAllows(spec: Pick<CommandSpec, 'grammars'>, grammar: CliGrammar | undefined): boolean {
  if (grammar === undefined) return true;
  return (spec.grammars ?? DEFAULT_GRAMMARS).includes(grammar);
}

/** Whether the capability gates pass: `requires` ⊆ capabilities and `requiresAny` ∩ capabilities ≠ ∅ (when present). */
export function capabilitiesAllow(spec: Pick<CommandSpec, 'requires' | 'requiresAny'>, caps: CapabilityInput | undefined): boolean {
  for (const c of spec.requires ?? []) if (!hasCap(caps, c)) return false;
  if (spec.requiresAny !== undefined) {
    let any = false;
    for (const c of spec.requiresAny) {
      if (hasCap(caps, c)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  return true;
}

/**
 * Device-level scope test for one spec (everything except `portRequires`): mode (names and class selectors),
 * mode-in-grammar, privilege, grammar and capabilities.
 */
export function specInScope(spec: CommandSpec, input: ScopeInput): boolean {
  if (!specModeAllows(spec.mode, input.mode)) return false;
  if (input.grammar !== undefined && !modeInGrammar(input.mode, input.grammar)) return false;
  if (spec.privilege > input.privilege) return false;
  if (!grammarAllows(spec, input.grammar)) return false;
  if (!capabilitiesAllow(spec, input.capabilities)) return false;
  return true;
}

/** Specs in scope for `input`, in table order (uncached). */
export function scopedSpecs(specs: readonly CommandSpec[], input: ScopeInput): readonly CommandSpec[] {
  const out: CommandSpec[] = [];
  for (const s of specs) if (specInScope(s, input)) out.push(s);
  return out;
}

/**
 * Effective role of a port view: the live, runtime-owned `role` (every port carries it since the P0.5 exit gate).
 */
export function effectiveRole(port: PortView): PortRole {
  return port.role;
}

/**
 * Whether `port` satisfies `req`: its effective role is in `roles`, its kind is in `kinds`, and for `dce` the
 * attached serial cable end is DCE (`phy.dce === true`) or DTE (`phy.dce === false`); a port with no DCE/DTE
 * information fails a `dce` requirement either way. No selected port (`undefined`) never satisfies a requirement.
 */
export function portRequirementMet(req: PortRequirement, port: PortView | undefined): boolean {
  if (port === undefined) return false;
  if (req.roles !== undefined && !req.roles.includes(effectiveRole(port))) return false;
  if (req.kinds !== undefined && !req.kinds.includes(port.spec.kind)) return false;
  if (req.dce !== undefined) {
    const dce = port.phy?.dce;
    if (dce === undefined || dce !== req.dce) return false;
  }
  return true;
}

/** Whether a spec's `portRequires` (if any) is satisfied by the selected interface. */
export function specPortAllowed(spec: Pick<CommandSpec, 'portRequires'>, iface: PortView | undefined): boolean {
  return spec.portRequires === undefined || portRequirementMet(spec.portRequires, iface);
}

/** Message for a spec typed in full on a selected interface that fails its `portRequires`. */
export function portMismatchMessage(spec: Pick<CommandSpec, 'portRequires'>): string {
  return spec.portRequires?.mismatch ?? CLI_MESSAGES.portUnsupported;
}

/** A memo of `scopedSpecs` results per spec table and `scopeKey`. */
export interface ScopeCache {
  /** Cached `scopedSpecs(specs, input)`; the returned array is frozen and shared between calls with the same key. */
  scopedSpecs(specs: readonly CommandSpec[], input: ScopeInput): readonly CommandSpec[];
  /** Number of results cached for one spec table. */
  size(specs: readonly CommandSpec[]): number;
  /** Drop every cached result. */
  clear(): void;
}

/**
 * Create a scope cache. Results are keyed by spec table identity (a WeakMap, so replaced grammars are
 * collected) and by `scopeKey(input)`. Each table keeps at most `limit` results; the oldest inserted key is
 * evicted first (Map insertion order, deterministic).
 */
export function createScopeCache(limit: number = SCOPE_CACHE_LIMIT): ScopeCache {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`scope cache limit must be a positive integer, got ${limit}`);
  let tables = new WeakMap<readonly CommandSpec[], Map<string, readonly CommandSpec[]>>();
  return {
    scopedSpecs(specs, input) {
      let byKey = tables.get(specs);
      if (byKey === undefined) {
        byKey = new Map();
        tables.set(specs, byKey);
      }
      const key = scopeKey(input);
      const hit = byKey.get(key);
      if (hit !== undefined) return hit;
      const result = Object.freeze(scopedSpecs(specs, input).slice());
      if (byKey.size >= limit) {
        const oldest = byKey.keys().next();
        if (oldest.done !== true) byKey.delete(oldest.value);
      }
      byKey.set(key, result);
      return result;
    },
    size(specs) {
      return tables.get(specs)?.size ?? 0;
    },
    clear() {
      tables = new WeakMap();
    },
  };
}
