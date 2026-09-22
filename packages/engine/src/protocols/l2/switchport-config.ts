/**
 * protocols/l2/switchport-config.ts — the ONE reader of a port's switchport lines (ARCHITECTURE-P2 §2.2, D6, §5.1).
 *
 * Admin configuration is never copied into state (D6): eth-switch, dtp, stp, etherchannel, the runtime's SVI
 * autostate, the snapshot builder, `show` handlers and lab checks all call `readSwitchport(config, port)` on the
 * running configuration. A Port-channel is read from its own `interface Port-channelN` section (§3.0 `carries`).
 *
 * Lines read (context `interface <port>`, storage convention of cli/config-ast.ts: key `switchport`, args = the rest):
 *   switchport mode access | trunk | dynamic auto | dynamic desirable      → mode        (default dynamic-auto, D3)
 *   switchport nonegotiate                                                 → negotiate   (false only in access/trunk)
 *   switchport access vlan <v>                                             → accessVlan  (default 1)
 *   switchport trunk native vlan <v>                                       → nativeVlan  (default 1)
 *   switchport trunk allowed vlan <list> | all | none                     → allowed     (canonical list, default all)
 *   [S4] switchport voice vlan <v>                                         → voiceVlan   (absent = none)
 * A line whose value does not parse (VLAN outside 1–4094, unknown mode) is ignored and the default stands. The CLI
 * handler stores the allowed list already resolved and canonical (§5.1); `add`/`remove`/`except` forms found in a
 * hand-written file are resolved against the default (all VLANs), because a stored line has nothing before it.
 *
 * On a `wireless-controller` model every port reads `CONTROLLER_PORT_SWITCHPORT` (D17): its distribution ports are
 * intrinsic 802.1Q trunks and the grammar accepts no switchport line there.
 *
 * Canonical VLAN list text (SwitchportConfig.allowed) is exactly core/vlan-list.ts's form: ascending, no duplicates,
 * joined by `,`; a run of three or more consecutive ids is `a-b`, a run of two is two ids (`10,11`); `1-4094` = all,
 * `` = none. The helpers here are module-private copies of that rule (rule 1 forbids importing the same-wave
 * core/vlan-list.ts); `l2.switchport-config.test.ts` pins the same vectors.
 *
 * Pure: no state, no I/O, no clock, no randomness.
 */
import type { Capability } from '../../contracts/catalog.js';
import type { ConfigAst, ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import { CONTROLLER_PORT_SWITCHPORT, DEFAULT_SWITCHPORT } from '../../contracts/port.js';
import type { SwitchportConfig, SwitchportMode } from '../../contracts/port.js';

/** Lowest and highest configurable VLAN id. */
const VLAN_LOW = 1;
const VLAN_HIGH = 4094;
/** Canonical text of "every VLAN". */
const ALL_VLANS_TEXT = '1-4094';

/** First token of every switchport line. */
export const SWITCHPORT_KEY = 'switchport';

/**
 * Line prefixes (after `switchport`) whose change alters which VLANs a port carries and how (§3.0 CAM flush table,
 * first row): a change of one of these lines on port X flushes X's dynamic CAM rows. `switchport port-security …` is
 * deliberately absent (D12: secure rows are never flushed by config).
 */
export const SWITCHPORT_MEMBERSHIP_PREFIXES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['switchport', 'mode']),
  Object.freeze(['switchport', 'access', 'vlan']),
  Object.freeze(['switchport', 'trunk', 'native', 'vlan']),
  Object.freeze(['switchport', 'trunk', 'allowed', 'vlan']),
  Object.freeze(['switchport', 'voice', 'vlan']),
  Object.freeze(['switchport', 'nonegotiate']),
]);

/** True when `line` (tokens, without `no`) is one of the membership lines above (§3.0 onConfig flush trigger). */
export function isMembershipLine(line: readonly string[]): boolean {
  return SWITCHPORT_MEMBERSHIP_PREFIXES.some((p) => p.length <= line.length && p.every((t, i) => line[i] === t));
}

/** The port named by an `interface <port>` context (the innermost interface entry), else undefined. */
export function interfaceOfContext(context: readonly (readonly string[])[]): PortId | undefined {
  for (let i = context.length - 1; i >= 0; i--) {
    const e = context[i];
    if (e !== undefined && e[0] === 'interface' && e[1] !== undefined) return e[1];
  }
  return undefined;
}

/** True for a model whose ports are intrinsic controller trunks (D17). */
export function isControllerModel(model: { readonly capabilities?: readonly Capability[] } | undefined): boolean {
  return model?.capabilities?.includes('wireless-controller') === true;
}

/** CLI text of a mode: 'access', 'trunk', 'dynamic auto', 'dynamic desirable'. */
export function switchportModeText(mode: SwitchportMode): string {
  switch (mode) {
    case 'access':
      return 'access';
    case 'trunk':
      return 'trunk';
    case 'dynamic-auto':
      return 'dynamic auto';
    case 'dynamic-desirable':
      return 'dynamic desirable';
  }
}

/** Mode named by the tokens after `switchport mode`, or undefined. */
export function parseSwitchportMode(tokens: readonly string[]): SwitchportMode | undefined {
  const [a, b] = tokens;
  if (a === 'access' && b === undefined) return 'access';
  if (a === 'trunk' && b === undefined) return 'trunk';
  if (a === 'dynamic' && b === 'auto') return 'dynamic-auto';
  if (a === 'dynamic' && b === 'desirable') return 'dynamic-desirable';
  return undefined;
}

// ─────────────────────────────── VLAN lists (private) ───────────────────────────────

/** A VLAN id token (1–4094), else undefined. */
function vlanId(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,4}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= VLAN_LOW && v <= VLAN_HIGH ? v : undefined;
}

/** Ranges of a list text (`10,20-30`), sorted and merged; `none`/`` = []; `all` = everything; undefined when invalid. */
function parseRanges(text: string): [number, number][] | undefined {
  const t = text.trim();
  if (t === '' || t === 'none') return [];
  if (t === 'all') return [[VLAN_LOW, VLAN_HIGH]];
  const raw: [number, number][] = [];
  for (const piece of t.split(',')) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(piece.trim());
    if (m === null) return undefined;
    const lo = vlanId(m[1]);
    const hi = m[2] === undefined ? lo : vlanId(m[2]);
    if (lo === undefined || hi === undefined || hi < lo) return undefined;
    raw.push([lo, hi]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Canonical text of sorted, merged ranges: a run of three or more ids is `a-b`, a run of two is two ids. */
function formatRanges(ranges: readonly (readonly [number, number])[]): string {
  const parts: string[] = [];
  for (const [lo, hi] of ranges) {
    if (hi - lo >= 2) parts.push(`${lo}-${hi}`);
    else if (hi === lo) parts.push(String(lo));
    else parts.push(String(lo), String(hi));
  }
  return parts.join(',');
}

/** Everything in `all` that is not in `minus` (both sorted and merged). */
function subtractRanges(all: readonly [number, number][], minus: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo0, hi] of all) {
    let lo = lo0;
    for (const [mlo, mhi] of minus) {
      if (mhi < lo || mlo > hi) continue;
      if (mlo > lo) out.push([lo, mlo - 1]);
      lo = mhi + 1;
      if (lo > hi) break;
    }
    if (lo <= hi) out.push([lo, hi]);
  }
  return out;
}

/** True when VLAN `v` is in the canonical (or any valid) list text. Invalid text contains nothing. */
function listHas(text: string, v: number): boolean {
  const ranges = parseRanges(text);
  if (ranges === undefined) return false;
  for (const [lo, hi] of ranges) {
    if (v < lo) return false;
    if (v <= hi) return true;
  }
  return false;
}

/**
 * Canonical allowed list of the tokens after `switchport trunk allowed vlan`, or undefined when they do not parse.
 * `add` and `all` keep everything, `remove`/`except` subtract from everything (a stored line has no earlier value).
 */
function allowedFromTokens(tokens: readonly string[]): string | undefined {
  const [first, second] = tokens;
  if (first === undefined) return undefined;
  if (first === 'add' || first === 'remove' || first === 'except') {
    const ranges = second === undefined ? undefined : parseRanges(second);
    if (ranges === undefined || second === 'all' || second === 'none') return undefined;
    if (first === 'add') return ALL_VLANS_TEXT;
    return formatRanges(subtractRanges([[VLAN_LOW, VLAN_HIGH]], ranges));
  }
  const ranges = parseRanges(first);
  return ranges === undefined ? undefined : formatRanges(ranges);
}

// ─────────────────────────────── the reader ───────────────────────────────

/** Token lists of every line of `node`'s section, a stored `switchport` group flattened (defensive). */
function linesOf(node: ConfigNode): string[][] {
  const out: string[][] = [];
  for (const c of node.children) {
    if (c.key === SWITCHPORT_KEY && c.args.length === 0 && c.children.length > 0) {
      for (const leaf of c.children) out.push([SWITCHPORT_KEY, leaf.key, ...leaf.args]);
      continue;
    }
    out.push([c.key, ...c.args]);
  }
  return out;
}

/** The `interface <port>` section node of `config`, if any. */
function interfaceNode(config: ConfigAst, port: PortId): ConfigNode | undefined {
  for (const c of config.root.children) {
    if (c.key === 'interface' && c.args[0] === port && c.args.length === 1) return c;
  }
  return undefined;
}

/** Parse the switchport lines of one interface section (every line, in stored order; the last valid one wins). */
function parseSection(node: ConfigNode | undefined): SwitchportConfig {
  if (node === undefined) return DEFAULT_SWITCHPORT;
  let mode: SwitchportMode = DEFAULT_SWITCHPORT.mode;
  let nonegotiate = false;
  let accessVlan = DEFAULT_SWITCHPORT.accessVlan;
  let nativeVlan = DEFAULT_SWITCHPORT.nativeVlan;
  let allowed = DEFAULT_SWITCHPORT.allowed;
  let voiceVlan: number | undefined;
  let seen = false;
  for (const t of linesOf(node)) {
    if (t[0] !== SWITCHPORT_KEY) continue;
    const rest = t.slice(1);
    if (rest[0] === 'mode') {
      const m = parseSwitchportMode(rest.slice(1));
      if (m !== undefined) {
        mode = m;
        seen = true;
      }
    } else if (rest[0] === 'nonegotiate' && rest.length === 1) {
      nonegotiate = true;
      seen = true;
    } else if (rest[0] === 'access' && rest[1] === 'vlan' && rest.length === 3) {
      const v = vlanId(rest[2]);
      if (v !== undefined) {
        accessVlan = v;
        seen = true;
      }
    } else if (rest[0] === 'trunk' && rest[1] === 'native' && rest[2] === 'vlan' && rest.length === 4) {
      const v = vlanId(rest[3]);
      if (v !== undefined) {
        nativeVlan = v;
        seen = true;
      }
    } else if (rest[0] === 'trunk' && rest[1] === 'allowed' && rest[2] === 'vlan') {
      const list = allowedFromTokens(rest.slice(3));
      if (list !== undefined) {
        allowed = list;
        seen = true;
      }
    } else if (rest[0] === 'voice' && rest[1] === 'vlan') {
      // [S4] voice VLAN line
      const v = readVoiceVlanTokens(rest.slice(2));
      if (v !== undefined) {
        voiceVlan = v;
        seen = true;
      }
    }
  }
  if (!seen) return DEFAULT_SWITCHPORT;
  // `switchport nonegotiate` is accepted only in access or trunk mode (§5.1); a dynamic port always negotiates.
  const negotiate = !(nonegotiate && (mode === 'access' || mode === 'trunk'));
  const cfg: SwitchportConfig = voiceVlan === undefined
    ? { mode, negotiate, accessVlan, nativeVlan, allowed }
    : { mode, negotiate, accessVlan, voiceVlan, nativeVlan, allowed };
  return Object.freeze(cfg);
}

// [S4] ── voice VLAN (switchport voice vlan <v>) ──────────────────────────────────────────────────────────────
/** [S4] The voice VLAN named by the tokens after `switchport voice vlan` (one VLAN id, 1–4094), else undefined. */
export function readVoiceVlanTokens(tokens: readonly string[]): number | undefined {
  return tokens.length === 1 ? vlanId(tokens[0]) : undefined;
}
/**
 * [S4] The global `voice vlan <v>` line of a host with a built-in bridge (the IP phone, ARCHITECTURE-P2 §5.5): the
 * VLAN the phone tags its own frames with on its network port. Undefined without the line.
 */
export function readVoiceVlan(config: ConfigAst): number | undefined {
  for (const c of config.root.children) {
    if (c.key === 'voice' && c.args[0] === 'vlan') return readVoiceVlanTokens(c.args.slice(1));
  }
  return undefined;
}
// [S4] ── end ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The switchport configuration of `port` (a physical switched port or `Port-channelN`), read from the running
 * `config`. Returns the frozen `DEFAULT_SWITCHPORT` when the port has no switchport line, and
 * `CONTROLLER_PORT_SWITCHPORT` for every port of a `wireless-controller` model (pass the model to get that rule).
 */
export function readSwitchport(
  config: ConfigAst,
  port: PortId,
  model?: { readonly capabilities?: readonly Capability[] },
): SwitchportConfig {
  if (isControllerModel(model)) return CONTROLLER_PORT_SWITCHPORT;
  return parseSection(interfaceNode(config, port));
}

/**
 * `readSwitchport` for every interface section of `config` in one pass (a cache for per-frame consumers). Ports with
 * no section are absent: their configuration is `DEFAULT_SWITCHPORT` (or `CONTROLLER_PORT_SWITCHPORT` on a controller).
 */
export function readAllSwitchports(
  config: ConfigAst,
  model?: { readonly capabilities?: readonly Capability[] },
): ReadonlyMap<PortId, SwitchportConfig> {
  const out = new Map<PortId, SwitchportConfig>();
  const controller = isControllerModel(model);
  for (const c of config.root.children) {
    if (c.key !== 'interface' || c.args.length !== 1) continue;
    const port = c.args[0] as PortId;
    if (out.has(port)) continue;
    out.set(port, controller ? CONTROLLER_PORT_SWITCHPORT : parseSection(c));
  }
  return out;
}

/** True when the trunk allowed list of `config` contains `vlan` (the native VLAN is not special here). */
export function trunkAllows(config: SwitchportConfig, vlan: number): boolean {
  return listHas(config.allowed, vlan);
}

/** True when `config` is exactly the default (D3): no switchport line changes anything. */
export function isDefaultSwitchport(config: SwitchportConfig): boolean {
  return config.mode === DEFAULT_SWITCHPORT.mode
    && config.negotiate === DEFAULT_SWITCHPORT.negotiate
    && config.accessVlan === DEFAULT_SWITCHPORT.accessVlan
    && config.voiceVlan === undefined
    && config.nativeVlan === DEFAULT_SWITCHPORT.nativeVlan
    && config.allowed === DEFAULT_SWITCHPORT.allowed;
}
