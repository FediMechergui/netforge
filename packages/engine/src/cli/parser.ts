/**
 * cli/parser.ts — tokenizer, prefix matcher, arg validation, `?` help and tab
 * completion for the command table (spec §7.1–§7.3, §7.6; ARCHITECTURE-P1 §3.13).
 *
 * The parser is pure: it takes the grammar, a `MatchContext` (mode, privilege, device
 * grammar, effective capabilities, selected interface, port resolver) and a line, and
 * returns either a matched `CommandSpec` with validated args or a `CliError` carrying the
 * 0-based column of the offending token for the caret line.
 *
 * Scope (cli/scope.ts): a spec takes part when its mode (names or class selectors
 * `@exec`/`@config`/`@auth`/`@all`), privilege, grammar and capability gates allow it. `portRequires` is checked against the selected interface: failing
 * specs are hidden from `?` and Tab, and a line typed in full that only such a spec matches
 * gets `portRequires.mismatch ?? CLI_MESSAGES.portUnsupported` at the column of its first
 * literal. `hidden` specs execute but never appear in `?` or Tab listings.
 *
 * Matching rules (conventional router-CLI behaviour, original wording throughout):
 *   • Keywords match by any unambiguous prefix (`conf t`, `sh ip int br`); an exact
 *     keyword always wins over longer keywords it is a prefix of.
 *   • A prefix matching several keywords at the same position is reported as
 *     ambiguous immediately, listing the candidates.
 *   • `no <cmd>` is accepted only for specs with `allowNo`; `do <cmd>` is accepted in
 *     configuration-class modes and is matched against the privileged-exec commands,
 *     excluding specs that change session state (`entersMode`, `sessionEffect`).
 *   • Missing tokens → incomplete (no column); extra or invalid tokens → column of
 *     the offending token.
 *   • Specs with `filterable` accept a trailing `| section|include|exclude|begin <pattern>`.
 *   • Interface args resolve through `MatchContext.resolvePort` (fixed, module and virtual
 *     ports) when present, else `resolveInterface`. A name split by a space after its family
 *     (`interface vlan 1`, `GigabitEthernet 0/0`) is joined into one token first. A `virtual`
 *     resolution (an interface that does not exist yet) is accepted only by specs that enter a
 *     mode (`interface Vlan10`).
 *
 * P1 arg types (ARCHITECTURE-P1 §4.10, §6; contracts/cli.ts `ArgType`):
 *   • `ipv6` → RFC 5952 canonical text; `ipv6-prefix` → canonical address + `/len` (0-128), host bits kept;
 *     `ip` → IPv4 dotted decimal or canonical IPv6.
 *   • `hostname` → RFC 1035/1123 name (labels of 1-63 letters, digits and inner hyphens, at most 253
 *     characters, an optional trailing dot, a last label that is not all digits); `host` → IPv4, IPv6 or such a
 *     name (addresses normalised, names kept as typed).
 *   • `url` → `scheme://host[:port][/path]` (RFC 3986 subset without user info); a URL typed without a scheme
 *     gets `http://`. Scheme and host are lower-cased, an IPv6 host is bracketed and canonical, an empty path
 *     becomes `/`.
 *   • `hex` → lower-case hex digits without a `0x` prefix; `min`/`max` bound the numeric value.
 *   • `int-range` → `1-4,7` lists of numbers and inclusive ranges within `min`/`max`, canonicalised sorted and
 *     merged (`7,1-3,4` → `1-4,7`).
 *   • `secret` → the last path element takes the rest of the line (passphrases may hold spaces); anywhere else it
 *     is one token. Control characters are refused. The columns of every secret value are reported in
 *     `MatchResult.secretSpans` so the runtime can mask them in history.
 *   • `quoted` → `"text with spaces"` (spanning tokens, read from the raw line, no escapes) or one token without
 *     quotation marks. An unclosed quote reports `MSG_UNCLOSED_QUOTE` at the opening mark.
 */
import type {
  ArgSpec,
  CliCompletion,
  CliCompletionItem,
  CliError,
  CliMode,
  CommandSpec,
  CompletionSource,
  PrivilegeLevel,
} from '../contracts/cli.js';
import type { CliGrammar } from '../contracts/catalog.js';
import { PORT_FAMILIES } from '../contracts/catalog.js';
import type { PortResolution } from '../contracts/device.js';
import type { PortId } from '../contracts/ids.js';
import type { PortView } from '../contracts/port.js';
import { maskToPrefixLen, normalizeMac, parseCidr, parseIpv4, u32ToIpv4 } from '../contracts/addr.js';
import { normalizeIpv6 } from '../core/addr6.js';
import { HANDLERS, LITERAL_HELP, PSEUDO_HELP } from './grammar.js';
import { isConfigClassMode, isDoBlocked } from './modes.js';
import {
  portMismatchMessage,
  portRequirementMet,
  scopedSpecs,
  specPortAllowed,
  type CapabilityInput,
  type ScopeCache,
  type ScopeInput,
} from './scope.js';

/** A whitespace-delimited token with its 0-based column in the original line. `|` is always its own token. */
export interface Token {
  readonly text: string;
  readonly column: number;
}

/** Output filter parsed from `| kind pattern`. */
export type FilterKind = 'section' | 'include' | 'exclude' | 'begin';

/** A parsed `| kind pattern` output filter. */
export interface OutputFilter {
  kind: FilterKind;
  pattern: string;
}

/** What the parser needs to know about the session and device. */
export interface MatchContext {
  mode: CliMode;
  privilege: PrivilegeLevel;
  /** Device grammar (`model.cli.grammar`). Undefined skips the grammar gate (P0 fixtures without a CliSpec). */
  grammar?: CliGrammar;
  /** Effective device capabilities (`DeviceRuntime.capabilities`). Undefined = none. */
  capabilities?: CapabilityInput;
  /** Selected interface of the session (interface-context modes), for `portRequires`. */
  iface?: PortView;
  /** `DeviceRuntime.portsVersion`, part of the scope cache key. */
  portsVersion?: number;
  /** Scope cache shared across calls (the runtime keeps one); without it the scope is computed per call. */
  scope?: ScopeCache;
  /** Resolve a short or long port name to its canonical id; undefined when unknown. Used when `resolvePort` is absent. */
  resolveInterface(name: string): PortId | undefined;
  /** Resolve a typed port name against the live device (fixed, module and virtual: `DeviceRuntime.resolvePortName`). */
  resolvePort?(name: string): PortResolution;
  /** Live port view by canonical id, for `ArgSpec.portFilter`. */
  portView?(id: PortId): PortView | undefined;
  /** Canonical port names, used to complete `interface` args. */
  listInterfaces?(): string[];
  /** Dynamic completion values for `ArgSpec.completion` sources (SSIDs, pools, …). */
  completions?(source: CompletionSource): readonly string[];
}

/** Why a line failed to match. `port-unsupported`: only specs whose `portRequires` the selected interface fails match. */
export type MatchFailureKind = 'unrecognized' | 'ambiguous' | 'incomplete' | 'invalid-arg' | 'port-unsupported';

/** A half-open character range `[column, end)` of the original line. */
export interface TextSpan {
  readonly column: number;
  readonly end: number;
}

/** Outcome of `matchCommand`. */
export type MatchResult =
  | {
      ok: true;
      spec: CommandSpec;
      /** Validated, normalized args by name (plus the spec's `fixedArgs`). */
      args: Record<string, string>;
      negated: boolean;
      filter?: OutputFilter;
      /** The line started with `do` in a configuration mode; `spec` is a privileged-exec command. */
      doPrefix?: boolean;
      /** Columns of the values of `secret` args, in line order (present only when the line holds one). */
      secretSpans?: readonly TextSpan[];
    }
  | { ok: false; error: CliError; kind: MatchFailureKind };

const FILTER_KINDS: readonly FilterKind[] = ['begin', 'exclude', 'include', 'section'];

/** Message for a command that stops before all required tokens are present. */
export const MSG_INCOMPLETE = '% More input is required to complete this command.';
/** Message for an unknown keyword or unexpected extra text. */
export const MSG_UNRECOGNIZED = '% Unrecognized input at the marked position.';
/** Message for an interface name that matches nothing on the device. */
export const MSG_UNKNOWN_INTERFACE = '% Unknown interface name at the marked position.';
/** Message for a virtual interface that does not exist yet, typed where only existing interfaces are accepted. */
export const MSG_INTERFACE_NOT_CREATED = '% That interface has not been created on this device yet.';
/** Message for an interface that exists but is excluded by the arg's `portFilter`. */
export const MSG_INTERFACE_NOT_ALLOWED = '% That interface cannot be used with this command.';
/** Message for a token longer than `ArgSpec.maxLength`. */
export const MSG_TOO_LONG = (max: number): string => `% The value at the marked position is longer than ${max} characters.`;
/** Message for a token that does not match `ArgSpec.pattern`. */
export const MSG_BAD_FORM = '% The value at the marked position does not have the expected form.';
const MSG_NO_FORM = "% This command has no 'no' form.";
/** Message for a quoted value whose closing quotation mark is missing (caret at the opening mark). */
export const MSG_UNCLOSED_QUOTE = '% The quoted text starting at the marked position has no closing quotation mark.';
/** Message for a quotation mark inside a value instead of around it. */
export const MSG_STRAY_QUOTE = '% Quotation marks are allowed only around the whole value.';
/** Message for an `ipv6` arg. */
export const MSG_BAD_IPV6 = '% Expected an IPv6 address (X:X:X:X::X) at the marked position.';
/** Message for an `ipv6-prefix` arg. */
export const MSG_BAD_IPV6_PREFIX = '% Expected an IPv6 prefix in X:X:X:X::X/nn form, nn from 0 to 128, at the marked position.';
/** Message for an `ip` arg. */
export const MSG_BAD_IP = '% Expected an IPv4 or IPv6 address at the marked position.';
/** Message for a `host` arg. */
export const MSG_BAD_HOST = '% Expected an IP address or a host name at the marked position.';
/** Message for a `hostname` arg. */
export const MSG_BAD_HOSTNAME = '% Expected a host name made of letters, digits, hyphens and dots at the marked position.';
/** Message for a `url` arg. */
export const MSG_BAD_URL = '% Expected a web address such as http://www.lab.nf/ at the marked position.';
/** Message for a `secret` arg holding control characters. */
export const MSG_BAD_SECRET = '% A secret may contain only printable characters.';

const NO = 'no';
const DO = 'do';

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a line on spaces/tabs, keeping each token's column. The pipe character is
 * always emitted as its own token so `show run|sec int` works; `rest` args read the
 * raw line from their first token's column, so pipes in banner text survive.
 */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      i++;
      continue;
    }
    if (c === 124) {
      out.push({ text: '|', column: i });
      i++;
      continue;
    }
    const start = i;
    while (i < n) {
      const d = line.charCodeAt(i);
      if (d === 32 || d === 9 || d === 13 || d === 10 || d === 124) break;
      i++;
    }
    out.push({ text: line.slice(start, i), column: start });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True when `el` is an `<arg>` placeholder in a spec path. */
export function isArgToken(el: string): boolean {
  return el.length > 2 && el.charCodeAt(0) === 60 && el.charCodeAt(el.length - 1) === 62;
}

/** Arg name of a `<name>` path element. */
export function argName(el: string): string {
  return el.slice(1, -1);
}

const WORD_ARG: ArgSpec = { type: 'word', help: 'A word' };

function argSpecOf(spec: CommandSpec, el: string): ArgSpec {
  return spec.args?.[argName(el)] ?? WORD_ARG;
}

/** Index of the last literal token in a path (the one that shows `spec.help`). */
export function lastLiteralIndex(spec: CommandSpec): number {
  for (let i = spec.path.length - 1; i >= 0; i--) {
    const el = spec.path[i];
    if (el !== undefined && !isArgToken(el)) return i;
  }
  return -1;
}

/** The device-level scope input of a match context, evaluated in `mode` (default `ctx.mode`). */
export function scopeInputOf(ctx: MatchContext, mode: CliMode = ctx.mode): ScopeInput {
  return {
    grammar: ctx.grammar,
    mode,
    privilege: ctx.privilege,
    capabilities: ctx.capabilities,
    portsVersion: ctx.portsVersion,
  };
}

/**
 * Specs in scope for `ctx` in `mode` (default `ctx.mode`), in table order: mode and class selectors,
 * privilege, grammar and capability gates. Uses `ctx.scope` when present.
 * `portRequires` is not applied here (see `usableSpecs`).
 */
export function availableSpecs(specs: readonly CommandSpec[], ctx: MatchContext, mode: CliMode = ctx.mode): readonly CommandSpec[] {
  const input = scopeInputOf(ctx, mode);
  return ctx.scope !== undefined ? ctx.scope.scopedSpecs(specs, input) : scopedSpecs(specs, input);
}

/** `availableSpecs` minus the specs whose `portRequires` the selected interface fails. */
export function usableSpecs(specs: readonly CommandSpec[], ctx: MatchContext, mode: CliMode = ctx.mode): CommandSpec[] {
  const out: CommandSpec[] = [];
  for (const s of availableSpecs(specs, ctx, mode)) if (specPortAllowed(s, ctx.iface)) out.push(s);
  return out;
}

/** Placeholder shown for an arg in `?` listings. */
export function placeholderFor(arg: ArgSpec): string {
  switch (arg.type) {
    case 'ipv4':
    case 'ipv4-mask':
      return 'A.B.C.D';
    case 'ipv4-prefix':
      return 'A.B.C.D/nn';
    case 'int':
      return `<${arg.min ?? 0}-${arg.max ?? 4294967295}>`;
    case 'mac':
      return 'H.H.H';
    case 'interface':
      return 'INTERFACE';
    case 'rest':
      return 'LINE';
    case 'choice':
      return arg.choices?.join('|') ?? 'WORD';
    case 'word':
      return 'WORD';
    case 'ipv6':
      return 'X:X:X:X::X';
    case 'ipv6-prefix':
      return 'X:X:X:X::X/<0-128>';
    case 'ip':
      return 'A.B.C.D|X:X:X:X::X';
    case 'host':
      return 'HOST';
    case 'hostname':
      return 'NAME';
    case 'url':
      return 'URL';
    case 'hex':
      return arg.min !== undefined && arg.max !== undefined ? `<0x${arg.min.toString(16)}-0x${arg.max.toString(16)}>` : 'HEX';
    case 'secret':
      return 'SECRET';
    case 'int-range':
      return `<${arg.min ?? 0}-${arg.max ?? 4294967295}>[,-]`;
    case 'quoted':
      return '"TEXT"';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg validation
// ─────────────────────────────────────────────────────────────────────────────

type ArgCheck = { ok: true; value: string } | { ok: false; message: string };

/** Options of `validateArg` that depend on the spec being matched. */
export interface ArgValidationOptions {
  /** Accept a `virtual` port resolution (a creatable interface): only specs that enter a mode. */
  allowVirtual?: boolean;
}

/** Check `ArgSpec.maxLength` and `ArgSpec.pattern` on raw text. */
function checkConstraints(arg: ArgSpec, text: string): ArgCheck {
  if (arg.maxLength !== undefined && text.length > arg.maxLength) return { ok: false, message: MSG_TOO_LONG(arg.maxLength) };
  if (arg.pattern !== undefined && !new RegExp(`^(?:${arg.pattern})$`).test(text)) return { ok: false, message: MSG_BAD_FORM };
  return { ok: true, value: text };
}

function resolveInterfaceArg(arg: ArgSpec, text: string, ctx: MatchContext, opts: ArgValidationOptions): ArgCheck {
  let id: PortId | undefined;
  let virtual = false;
  if (ctx.resolvePort !== undefined) {
    const r = ctx.resolvePort(text);
    switch (r.kind) {
      case 'existing':
        id = r.port;
        break;
      case 'virtual':
        if (opts.allowVirtual !== true) return { ok: false, message: MSG_INTERFACE_NOT_CREATED };
        id = r.port;
        virtual = true;
        break;
      case 'ambiguous':
        return { ok: false, message: `% Ambiguous interface name "${text}": could be ${r.candidates.join(', ')}.` };
      case 'unknown':
        return { ok: false, message: MSG_UNKNOWN_INTERFACE };
    }
  } else {
    id = ctx.resolveInterface(text);
    if (id === undefined) return { ok: false, message: MSG_UNKNOWN_INTERFACE };
  }
  if (arg.portFilter !== undefined && !virtual && ctx.portView !== undefined) {
    const view = ctx.portView(id);
    if (!portRequirementMet(arg.portFilter, view)) {
      return { ok: false, message: arg.portFilter.mismatch ?? MSG_INTERFACE_NOT_ALLOWED };
    }
  }
  return { ok: true, value: id };
}

/** Validate and normalize one token against an `ArgSpec`. Exported for handler-side reuse. */
export function validateArg(arg: ArgSpec, text: string, ctx: MatchContext, opts: ArgValidationOptions = {}): ArgCheck {
  if (arg.type === 'quoted') {
    // Constraints apply to the text inside the quotation marks.
    const q = unquote(text);
    if (!q.ok) return q;
    return checkConstraints(arg, q.value);
  }
  const constraints = checkConstraints(arg, text);
  if (!constraints.ok) return constraints;
  switch (arg.type) {
    case 'word':
      return { ok: true, value: text };
    case 'rest':
      return { ok: true, value: text };
    case 'int': {
      if (!/^-?\d+$/.test(text)) return { ok: false, message: `% Expected a whole number ${intRange(arg)} at the marked position.` };
      const v = Number(text);
      if ((arg.min !== undefined && v < arg.min) || (arg.max !== undefined && v > arg.max)) {
        return { ok: false, message: `% Expected a whole number ${intRange(arg)} at the marked position.` };
      }
      return { ok: true, value: String(v) };
    }
    case 'ipv4': {
      const v = parseIpv4(text);
      if (v === null) return { ok: false, message: '% Expected an IPv4 address in dotted-decimal form (A.B.C.D) at the marked position.' };
      return { ok: true, value: u32ToIpv4(v) };
    }
    case 'ipv4-mask': {
      const len = maskToPrefixLen(text);
      if (len === null) return { ok: false, message: '% Expected a contiguous subnet mask such as 255.255.255.0 at the marked position.' };
      return { ok: true, value: u32ToIpv4(parseIpv4(text)!) };
    }
    case 'ipv4-prefix': {
      const p = parseCidr(text);
      if (p === null) return { ok: false, message: '% Expected a network prefix in A.B.C.D/nn form at the marked position.' };
      return { ok: true, value: `${p.network}/${p.prefixLen}` };
    }
    case 'mac': {
      const m = normalizeMac(text);
      if (m === null) return { ok: false, message: '% Expected a MAC address (H.H.H or HH:HH:HH:HH:HH:HH) at the marked position.' };
      return { ok: true, value: m };
    }
    case 'interface':
      return resolveInterfaceArg(arg, text, ctx, opts);
    case 'choice': {
      const choices = arg.choices ?? [];
      const lower = text.toLowerCase();
      const exact = choices.find((c) => c.toLowerCase() === lower);
      if (exact !== undefined) return { ok: true, value: exact };
      const prefixed = choices.filter((c) => c.toLowerCase().startsWith(lower));
      if (prefixed.length === 1) return { ok: true, value: prefixed[0]! };
      return { ok: false, message: `% Expected one of: ${choices.join(', ')} at the marked position.` };
    }
    case 'ipv6': {
      const v = text.includes('/') ? null : normalizeIpv6(text);
      return v === null ? { ok: false, message: MSG_BAD_IPV6 } : { ok: true, value: v };
    }
    case 'ipv6-prefix': {
      const v = normalizeIpv6Prefix(text);
      return v === null ? { ok: false, message: MSG_BAD_IPV6_PREFIX } : { ok: true, value: v };
    }
    case 'ip': {
      const v = normalizeIpLiteral(text);
      return v === null ? { ok: false, message: MSG_BAD_IP } : { ok: true, value: v };
    }
    case 'host': {
      const v = normalizeIpLiteral(text);
      if (v !== null) return { ok: true, value: v };
      return isHostName(text) ? { ok: true, value: text } : { ok: false, message: MSG_BAD_HOST };
    }
    case 'hostname':
      return isHostName(text) ? { ok: true, value: text } : { ok: false, message: MSG_BAD_HOSTNAME };
    case 'url': {
      const v = normalizeUrl(text);
      return v === null ? { ok: false, message: MSG_BAD_URL } : { ok: true, value: v };
    }
    case 'hex':
      return validateHex(arg, text);
    case 'secret':
      return isPrintable(text) ? { ok: true, value: text } : { ok: false, message: MSG_BAD_SECRET };
    case 'int-range':
      return validateIntRange(arg, text);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 value helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** IPv4 dotted decimal or RFC 5952 IPv6 text of `text`; null when it is neither (no prefix length allowed). */
export function normalizeIpLiteral(text: string): string | null {
  if (text.includes('/')) return null;
  const v4 = parseIpv4(text);
  if (v4 !== null) return u32ToIpv4(v4);
  return normalizeIpv6(text);
}

/** `X:X::X/len` with a canonical address and a length of 0-128 (host bits kept); null when malformed. */
export function normalizeIpv6Prefix(text: string): string | null {
  const slash = text.lastIndexOf('/');
  if (slash <= 0) return null;
  const lenText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(lenText)) return null;
  const len = Number(lenText);
  if (len > 128) return null;
  const addr = normalizeIpv6(text.slice(0, slash));
  return addr === null ? null : `${addr}/${len}`;
}

/** Maximum length of a host name without its trailing dot (RFC 1035 §2.3.4). */
export const HOSTNAME_MAX_LENGTH = 253;
/** Maximum length of one host-name label (RFC 1035 §2.3.4). */
export const HOSTNAME_LABEL_MAX_LENGTH = 63;

/**
 * RFC 1035 §2.3.1 / RFC 1123 §2.1 host name: dot-separated labels of 1-63 letters, digits and hyphens that neither
 * start nor end with a hyphen, at most 253 characters without an optional trailing dot, and a last label that is
 * not all digits (so `10.0.0.256` is not a name).
 */
export function isHostName(text: string): boolean {
  const name = text.endsWith('.') ? text.slice(0, -1) : text;
  if (name.length === 0 || name.length > HOSTNAME_MAX_LENGTH) return false;
  const labels = name.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > HOSTNAME_LABEL_MAX_LENGTH) return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false;
  }
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

/**
 * Normalise a web address: `scheme://host[:port][/path]` (RFC 3986 §3 without user info). Without `://` the text is
 * read as `http://` + text. Scheme and host are lower-cased (RFC 3986 §6.2.2.1), an IPv6 literal must be bracketed
 * and is made canonical, the port must be 1-65535 and loses leading zeros, and an empty path becomes `/`.
 * Returns null for anything else (spaces, `@`, bad host, bad port).
 */
export function normalizeUrl(text: string): string | null {
  if (text.length === 0 || /[\s"<>\\^`{|}]/.test(text)) return null;
  let scheme = 'http';
  let rest = text;
  const sep = text.indexOf('://');
  if (sep !== -1) {
    scheme = text.slice(0, sep);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return null;
    scheme = scheme.toLowerCase();
    rest = text.slice(sep + 3);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)/.test(text)) {
    // `name:x` references without an authority are refused; only `host:port` may omit the scheme.
    return null;
  }
  const pathAt = rest.search(/[/?#]/);
  const authority = pathAt === -1 ? rest : rest.slice(0, pathAt);
  let path = pathAt === -1 ? '/' : rest.slice(pathAt);
  if (!path.startsWith('/')) path = `/${path}`;
  if (authority.length === 0 || authority.includes('@')) return null;
  let hostText: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    const v6 = normalizeIpv6(authority.slice(1, close));
    if (v6 === null) return null;
    hostText = `[${v6}]`;
    const after = authority.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) return null;
      portText = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    const host = colon === -1 ? authority : authority.slice(0, colon);
    if (colon !== -1) portText = authority.slice(colon + 1);
    const v4 = parseIpv4(host);
    if (v4 !== null) hostText = u32ToIpv4(v4);
    else if (isHostName(host)) hostText = host.toLowerCase();
    else return null;
  }
  let port = '';
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    const n = Number(portText);
    if (n < 1 || n > 65535) return null;
    port = `:${n}`;
  }
  return `${scheme}://${hostText}${port}${path}`;
}

/** Hex digits with an optional `0x` prefix → lower-case digits; `min`/`max` bound the numeric value. */
function validateHex(arg: ArgSpec, text: string): ArgCheck {
  const digits = /^0[xX]/.test(text) ? text.slice(2) : text;
  const bounded = arg.min !== undefined || arg.max !== undefined;
  const message = bounded
    ? `% Expected a hexadecimal value ${hexRange(arg)} at the marked position.`
    : '% Expected a hexadecimal value at the marked position.';
  if (!/^[0-9A-Fa-f]+$/.test(digits)) return { ok: false, message };
  if (bounded) {
    const v = BigInt(`0x${digits}`);
    if ((arg.min !== undefined && v < BigInt(arg.min)) || (arg.max !== undefined && v > BigInt(arg.max))) return { ok: false, message };
  }
  return { ok: true, value: digits.toLowerCase() };
}

function hexRange(arg: ArgSpec): string {
  const hex = (n: number): string => `0x${n.toString(16)}`;
  if (arg.min !== undefined && arg.max !== undefined) return `between ${hex(arg.min)} and ${hex(arg.max)}`;
  if (arg.min !== undefined) return `of at least ${hex(arg.min)}`;
  return `of at most ${hex(arg.max ?? 0)}`;
}

/** Parse `1-4,7` into sorted, merged inclusive ranges (adjacent ranges join); null when malformed or reversed. */
export function parseIntRange(text: string): [number, number][] | null {
  const items: [number, number][] = [];
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) return null;
    items.push([lo, hi]);
  }
  items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of items) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/** Canonical text of merged ranges: `1-4,7`. */
export function formatIntRange(ranges: readonly (readonly [number, number])[]): string {
  return ranges.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}-${hi}`)).join(',');
}

function validateIntRange(arg: ArgSpec, text: string): ArgCheck {
  const bounds = intRange(arg);
  const message = `% Expected numbers or ranges such as 1-4,7${bounds === '' ? '' : ` ${bounds}`} at the marked position.`;
  const ranges = parseIntRange(text);
  if (ranges === null) return { ok: false, message };
  for (const [lo, hi] of ranges) {
    if ((arg.min !== undefined && lo < arg.min) || (arg.max !== undefined && hi > arg.max)) return { ok: false, message };
  }
  return { ok: true, value: formatIntRange(ranges) };
}

/** No C0 control characters and no DEL. */
function isPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** `"text"` → text; an unquoted value must hold no quotation mark. */
function unquote(text: string): ArgCheck {
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return { ok: false, message: MSG_UNCLOSED_QUOTE };
    const inner = text.slice(1, -1);
    if (inner.includes('"')) return { ok: false, message: MSG_STRAY_QUOTE };
    return { ok: true, value: inner };
  }
  if (text.includes('"')) return { ok: false, message: MSG_STRAY_QUOTE };
  return { ok: true, value: text };
}

function intRange(arg: ArgSpec): string {
  if (arg.min !== undefined && arg.max !== undefined) return `between ${arg.min} and ${arg.max}`;
  if (arg.min !== undefined) return `of at least ${arg.min}`;
  if (arg.max !== undefined) return `of at most ${arg.max}`;
  return '';
}

/**
 * True when `text` is a port family word without a number (`vlan`, `gi`, `GigabitEthernet`): letters only, and
 * a prefix of a PORT_FAMILIES long name or equal to a short name (case-insensitive). Such a token may be joined
 * with the following number token (`interface vlan 1`).
 */
export function isPortFamilyWord(text: string): boolean {
  if (!/^[A-Za-z]+$/.test(text)) return false;
  const lower = text.toLowerCase();
  return PORT_FAMILIES.some((f) => f.long.toLowerCase().startsWith(lower) || f.short.toLowerCase() === lower);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate walk
// ─────────────────────────────────────────────────────────────────────────────

type Stage = 'path' | 'iface-number' | 'quoted' | 'rest' | 'done' | 'filter-kind' | 'filter-pattern' | 'filter-done';

interface Cand {
  spec: CommandSpec;
  pos: number;
  args: Record<string, string>;
  stage: Stage;
  literals: number;
  filterKind?: FilterKind;
  filterPattern?: string;
  /** Family word waiting for its number (stage 'iface-number'). */
  pendingFamily?: string;
  /** Column of the opening quotation mark of a quoted value spanning tokens (stage 'quoted'). */
  quoteColumn?: number;
  /** Columns of the secret values consumed so far. */
  secretSpans: TextSpan[];
}

interface Death {
  index: number;
  kind: 'unrecognized' | 'invalid-arg';
  message: string;
}

/** `back`: the offending token is that many tokens before the current one (a joined interface name). */
type Step = { dead: true; kind: Death['kind']; message: string; back?: number } | { dead: false; lit?: string; exact: boolean };

function makeCands(specs: readonly CommandSpec[]): Cand[] {
  const out: Cand[] = [];
  for (const spec of specs) {
    out.push({ spec, pos: 0, args: {}, stage: spec.path.length === 0 ? 'done' : 'path', literals: 0, secretSpans: [] });
  }
  return out;
}

function betterDeath(a: Death | undefined, b: Death): Death {
  if (a === undefined) return b;
  if (b.index > a.index) return b;
  if (b.index === a.index && b.kind === 'invalid-arg' && a.kind !== 'invalid-arg') return b;
  return a;
}

function advanceArg(c: Cand): void {
  c.pos++;
  c.stage = c.pos >= c.spec.path.length ? 'done' : 'path';
}

function stepCand(c: Cand, tok: Token, lower: string, line: string, ctx: MatchContext): Step {
  switch (c.stage) {
    case 'rest':
    case 'filter-done':
      return { dead: false, exact: false };
    case 'done': {
      if (tok.text === '|' && c.spec.filterable) {
        c.stage = 'filter-kind';
        return { dead: false, lit: '|', exact: true };
      }
      return { dead: true, kind: 'unrecognized', message: MSG_UNRECOGNIZED };
    }
    case 'filter-kind': {
      // No two filter kinds share a first letter, so a prefix is never ambiguous.
      const exact = FILTER_KINDS.find((k) => k === lower);
      const matches = exact !== undefined ? [exact] : FILTER_KINDS.filter((k) => k.startsWith(lower));
      if (matches.length !== 1) {
        return { dead: true, kind: 'invalid-arg', message: '% Expected a filter type (begin, exclude, include or section) at the marked position.' };
      }
      c.filterKind = matches[0]!;
      c.stage = 'filter-pattern';
      return { dead: false, lit: matches[0]!, exact: exact !== undefined };
    }
    case 'filter-pattern': {
      c.filterPattern = line.slice(tok.column).trimEnd();
      c.stage = 'filter-done';
      return { dead: false, exact: false };
    }
    case 'quoted': {
      const close = tok.text.indexOf('"');
      if (close === -1) return { dead: false, exact: false };
      if (close !== tok.text.length - 1) return { dead: true, kind: 'invalid-arg', message: MSG_STRAY_QUOTE };
      const el = c.spec.path[c.pos]!;
      const open = c.quoteColumn ?? tok.column;
      delete c.quoteColumn;
      const value = line.slice(open + 1, tok.column + tok.text.length - 1);
      const chk = checkConstraints(argSpecOf(c.spec, el), value);
      if (!chk.ok) return { dead: true, kind: 'invalid-arg', message: chk.message };
      c.args[argName(el)] = value;
      advanceArg(c);
      return { dead: false, exact: false };
    }
    case 'iface-number': {
      const el = c.spec.path[c.pos]!;
      const joined = `${c.pendingFamily ?? ''}${tok.text}`;
      delete c.pendingFamily;
      const r = validateArg(argSpecOf(c.spec, el), joined, ctx, { allowVirtual: c.spec.entersMode !== undefined });
      if (!r.ok) return { dead: true, kind: 'invalid-arg', message: r.message, back: 1 };
      c.args[argName(el)] = r.value;
      advanceArg(c);
      return { dead: false, exact: false };
    }
    case 'path': {
      const el = c.spec.path[c.pos];
      if (el === undefined) {
        c.stage = 'done';
        return stepCand(c, tok, lower, line, ctx);
      }
      if (isArgToken(el)) {
        if (tok.text === '|' && c.spec.filterable && remainingOptional(c, false)) {
          // `show interfaces | include …`: the optional args are skipped and the filter starts.
          c.pos = c.spec.path.length;
          c.stage = 'done';
          return stepCand(c, tok, lower, line, ctx);
        }
        const arg = argSpecOf(c.spec, el);
        const secretTail = arg.type === 'secret' && c.pos === c.spec.path.length - 1;
        if (arg.type === 'rest' || secretTail) {
          const value = line.slice(tok.column).trimEnd();
          // The span is recorded before the value is judged: a refused secret was still typed in the clear.
          if (secretTail) c.secretSpans.push({ column: tok.column, end: tok.column + value.length });
          const chk = secretTail ? validateArg(arg, value, ctx) : checkConstraints(arg, value);
          if (!chk.ok) return { dead: true, kind: 'invalid-arg', message: chk.message };
          c.args[argName(el)] = value;
          c.pos = c.spec.path.length;
          c.stage = 'rest';
          return { dead: false, exact: false };
        }
        if (arg.type === 'quoted' && tok.text.startsWith('"') && (tok.text.length === 1 || !tok.text.endsWith('"'))) {
          // An opening quotation mark: the value runs to the token that ends with the closing mark.
          if (tok.text.indexOf('"', 1) !== -1) return { dead: true, kind: 'invalid-arg', message: MSG_STRAY_QUOTE };
          c.quoteColumn = tok.column;
          c.stage = 'quoted';
          return { dead: false, exact: false };
        }
        const r = validateArg(arg, tok.text, ctx, { allowVirtual: c.spec.entersMode !== undefined });
        if (!r.ok) {
          if (arg.type === 'interface' && isPortFamilyWord(tok.text)) {
            // `interface vlan 1`: wait for the number token and validate the joined name.
            c.pendingFamily = tok.text;
            c.stage = 'iface-number';
            return { dead: false, exact: false };
          }
          if (arg.type === 'secret') c.secretSpans.push({ column: tok.column, end: tok.column + tok.text.length });
          return { dead: true, kind: 'invalid-arg', message: r.message };
        }
        c.args[argName(el)] = r.value;
        if (arg.type === 'secret') c.secretSpans.push({ column: tok.column, end: tok.column + tok.text.length });
        advanceArg(c);
        return { dead: false, exact: false };
      }
      if (el.startsWith(lower)) {
        c.pos++;
        c.literals++;
        if (c.pos >= c.spec.path.length) c.stage = 'done';
        return { dead: false, lit: el, exact: el === lower };
      }
      return { dead: true, kind: 'unrecognized', message: MSG_UNRECOGNIZED };
    }
  }
}

interface WalkResult {
  live: Cand[];
  ambiguous?: { index: number; literals: string[] };
  death?: Death;
}

/** Advance every candidate through `tokens[from..to)`. Candidates are mutated in place. */
function walk(cands: Cand[], tokens: readonly Token[], from: number, to: number, line: string, ctx: MatchContext): WalkResult {
  let live = cands;
  let death: Death | undefined;
  for (let t = from; t < to; t++) {
    const tok = tokens[t]!;
    const lower = tok.text.toLowerCase();
    const matched: { cand: Cand; lit?: string; exact: boolean }[] = [];
    for (const c of live) {
      const r = stepCand(c, tok, lower, line, ctx);
      if (r.dead) {
        death = betterDeath(death, { index: t - (r.back ?? 0), kind: r.kind, message: r.message });
        continue;
      }
      matched.push({ cand: c, lit: r.lit, exact: r.exact });
    }
    const anyExact = matched.some((m) => m.lit !== undefined && m.exact);
    const kept = anyExact ? matched.filter((m) => m.lit === undefined || m.exact) : matched;
    const lits = new Set<string>();
    for (const m of kept) if (m.lit !== undefined) lits.add(m.lit);
    if (lits.size > 1) return { live: [], ambiguous: { index: t, literals: [...lits].sort() } };
    if (kept.length === 0) return { live: [], death };
    live = kept.map((m) => m.cand);
  }
  return { live, death };
}

/** Is the candidate executable as-is (all remaining path elements optional)? */
function isComplete(c: Cand, negated: boolean): boolean {
  switch (c.stage) {
    case 'done':
    case 'rest':
    case 'filter-done':
      return true;
    case 'filter-kind':
    case 'filter-pattern':
    case 'iface-number':
    case 'quoted':
      return false;
    case 'path':
      return remainingOptional(c, negated);
  }
}

function remainingOptional(c: Cand, negated: boolean): boolean {
  const relaxed = negated && c.spec.noArgsOptional === true;
  for (let i = c.pos; i < c.spec.path.length; i++) {
    const el = c.spec.path[i]!;
    if (!isArgToken(el)) return false;
    if (relaxed) continue;
    if (!argSpecOf(c.spec, el).optional) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prefix words: `do` and `no`
// ─────────────────────────────────────────────────────────────────────────────

interface Prefix {
  /** Index of the first token of the command proper. */
  start: number;
  negated: boolean;
  doPrefix: boolean;
  /** Effective mode after `do`. */
  mode: CliMode;
  /** Specs the command proper is matched against. */
  available: CommandSpec[];
  /** Specs before the `no` restriction (for the "no 'no' form" diagnostic). */
  beforeNo: CommandSpec[];
  error?: { kind: MatchFailureKind; error: CliError };
}

function firstLiterals(specs: readonly CommandSpec[]): string[] {
  const set = new Set<string>();
  for (const s of specs) {
    const el = s.path[0];
    if (el !== undefined && !isArgToken(el)) set.add(el);
  }
  return [...set];
}

/** Pseudo-keywords valid at the start of the command proper in this state. */
function pseudoWords(p: { doPrefix: boolean; negated: boolean; mode: CliMode; available: readonly CommandSpec[] }): string[] {
  const out: string[] = [];
  if (p.negated) return out;
  if (!p.doPrefix && isConfigClassMode(p.mode)) out.push(DO);
  if (p.available.some((s) => s.allowNo)) out.push(NO);
  return out;
}

function ambiguousError(tok: Token, literals: readonly string[]): CliError {
  return { message: `% Ambiguous input "${tok.text}": could be ${literals.join(', ')}.`, column: tok.column };
}

/**
 * Exec handlers that change the session's mode or privilege but whose P0 grammar entries carry neither
 * `entersMode` nor `sessionEffect` (`exit`, `logout`). `isDoBlocked` covers every spec that declares them;
 * this set keeps the P0 table refused through `do` until its entries declare `sessionEffect`.
 */
const LEGACY_DO_BLOCKED_HANDLERS: ReadonlySet<string> = new Set([
  HANDLERS.execExit, HANDLERS.execLogout, HANDLERS.execDisable,
  HANDLERS.execEnable, HANDLERS.execEnd, HANDLERS.execConfigure,
]);

/** Whether `do` refuses a spec: it changes session state (`entersMode`, `sessionEffect`) or is a legacy session handler. */
export function refusedThroughDo(spec: CommandSpec): boolean {
  return isDoBlocked(spec) || LEGACY_DO_BLOCKED_HANDLERS.has(spec.handler);
}

/** Scoped specs, optionally restricted to those whose `portRequires` the selected interface satisfies. */
function specsFor(specs: readonly CommandSpec[], ctx: MatchContext, mode: CliMode, portFilter: boolean): CommandSpec[] {
  return portFilter ? usableSpecs(specs, ctx, mode) : availableSpecs(specs, ctx, mode).slice();
}

/** Consume leading `do` / `no` words from `tokens[0..count)`. */
function parsePrefix(specs: readonly CommandSpec[], ctx: MatchContext, tokens: readonly Token[], count: number, portFilter = true): Prefix {
  const p: Prefix = {
    start: 0,
    negated: false,
    doPrefix: false,
    mode: ctx.mode,
    available: specsFor(specs, ctx, ctx.mode, portFilter),
    beforeNo: [],
  };
  p.beforeNo = p.available;
  while (p.start < count) {
    const pseudo = pseudoWords(p);
    if (pseudo.length === 0) break;
    const tok = tokens[p.start]!;
    const lower = tok.text.toLowerCase();
    const pool = [...pseudo, ...firstLiterals(p.available)];
    let matches = pool.filter((w) => w.startsWith(lower));
    if (matches.length === 0) break;
    const exact = matches.filter((w) => w === lower);
    if (exact.length > 0) matches = exact;
    const uniq = [...new Set(matches)].sort();
    if (uniq.length > 1) {
      p.error = { kind: 'ambiguous', error: ambiguousError(tok, uniq) };
      return p;
    }
    const w = uniq[0]!;
    if (w === DO && pseudo.includes(DO)) {
      p.doPrefix = true;
      p.mode = 'priv-exec';
      p.available = specsFor(specs, ctx, 'priv-exec', portFilter).filter((sp) => !refusedThroughDo(sp));
      p.beforeNo = p.available;
      p.start++;
      continue;
    }
    if (w === NO && pseudo.includes(NO)) {
      p.negated = true;
      p.beforeNo = p.available;
      p.available = p.available.filter((s) => s.allowNo === true);
      p.start++;
      continue;
    }
    break;
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// matchCommand
// ─────────────────────────────────────────────────────────────────────────────

/** Pick the best complete candidate: most literal keywords wins; a tie between different specs is ambiguous. */
function chooseComplete(complete: readonly Cand[]): { cand?: Cand; tie?: Cand[] } {
  if (complete.length === 0) return {};
  let best = complete[0]!;
  for (let i = 1; i < complete.length; i++) {
    const c = complete[i]!;
    if (c.literals > best.literals) best = c;
  }
  const ties = complete.filter((c) => c.literals === best.literals && c.spec !== best.spec);
  if (ties.length > 0) return { tie: [best, ...ties] };
  return { cand: best };
}

/**
 * Parse a whole line against the grammar. Returns the matched spec with validated,
 * normalized args, or an error with the caret column.
 */
export function matchCommand(specs: readonly CommandSpec[], ctx: MatchContext, line: string): MatchResult {
  const tokens = tokenize(line);
  if (tokens.length === 0) return { ok: false, kind: 'incomplete', error: { message: MSG_INCOMPLETE } };

  const p = parsePrefix(specs, ctx, tokens, tokens.length);
  if (p.error) return { ok: false, kind: p.error.kind, error: p.error.error };

  const result = matchAgainst(p.available, p, tokens, line, ctx);
  if (result.ok) return result;

  if (result.kind !== 'ambiguous') {
    // Would a spec hidden by its port requirement have matched? Then report the selected interface.
    const all = parsePrefix(specs, ctx, tokens, tokens.length, false);
    if (!all.error) {
      const unfiltered = matchAgainst(all.available, all, tokens, line, ctx);
      if (unfiltered.ok && !specPortAllowed(unfiltered.spec, ctx.iface)) {
        const tok = tokens[all.start] ?? tokens[0]!;
        return { ok: false, kind: 'port-unsupported', error: { message: portMismatchMessage(unfiltered.spec), column: tok.column } };
      }
    }
  }

  if (p.negated && result.kind !== 'ambiguous') {
    // Would the positive form have matched? Then the problem is the `no` prefix itself.
    const positive = matchAgainst(p.beforeNo, { ...p, negated: false }, tokens, line, ctx);
    if (positive.ok && positive.spec.allowNo !== true) {
      const tok = tokens[p.start] ?? tokens[0]!;
      return { ok: false, kind: 'unrecognized', error: { message: MSG_NO_FORM, column: tok.column } };
    }
  }
  return result;
}

/**
 * Columns of the `secret` values typed on `line`, found WITHOUT mode, privilege or capability scoping (and with a
 * leading `no` / `do` skipped as well as kept). `MatchResult.secretSpans` exists only for a line that matched, but a
 * password typed in the wrong mode, or rejected as too long, was typed in the clear all the same, so the runtime
 * masks the history from this on every failed line.
 */
export function secretSpansOf(specs: readonly CommandSpec[], ctx: MatchContext, line: string): readonly TextSpan[] {
  const tokens = tokenize(line);
  if (tokens.length === 0) return [];
  const first = tokens[0]!.text.toLowerCase();
  let best: readonly TextSpan[] = [];
  for (const from of first === 'no' || first === 'do' ? [0, 1] : [0]) {
    const cands = makeCands(specs);
    walk(cands, tokens, from, tokens.length, line, ctx);
    for (const c of cands) if (c.secretSpans.length > best.length) best = c.secretSpans;
  }
  return best;
}

function matchAgainst(available: readonly CommandSpec[], p: Prefix, tokens: readonly Token[], line: string, ctx: MatchContext): MatchResult {
  const w = walk(makeCands(available), tokens, p.start, tokens.length, line, ctx);
  if (w.ambiguous) {
    return { ok: false, kind: 'ambiguous', error: ambiguousError(tokens[w.ambiguous.index]!, w.ambiguous.literals) };
  }
  if (w.live.length === 0) {
    if (w.death) {
      return { ok: false, kind: w.death.kind, error: { message: w.death.message, column: tokens[w.death.index]!.column } };
    }
    const tok = tokens[p.start] ?? tokens[0]!;
    return { ok: false, kind: 'unrecognized', error: { message: MSG_UNRECOGNIZED, column: tok.column } };
  }
  if (p.start >= tokens.length) {
    // Only `no` / `do` were typed.
    return { ok: false, kind: 'incomplete', error: { message: MSG_INCOMPLETE } };
  }
  const complete = w.live.filter((c) => isComplete(c, p.negated));
  const pick = chooseComplete(complete);
  if (pick.tie) {
    const lits = [...new Set(pick.tie.map((c) => c.spec.path.filter((e) => !isArgToken(e)).join(' ')))].sort();
    return { ok: false, kind: 'ambiguous', error: ambiguousError(tokens[p.start]!, lits) };
  }
  if (pick.cand) {
    const c = pick.cand;
    const args: Record<string, string> = { ...(c.spec.fixedArgs ?? {}), ...c.args };
    const out: MatchResult = { ok: true, spec: c.spec, args, negated: p.negated };
    if (c.stage === 'filter-done' && c.filterKind !== undefined && c.filterPattern !== undefined) {
      out.filter = { kind: c.filterKind, pattern: c.filterPattern };
    }
    if (p.doPrefix) out.doPrefix = true;
    if (c.secretSpans.length > 0) out.secretSpans = c.secretSpans.slice();
    return out;
  }
  const open = w.live.find((c) => c.stage === 'quoted' && c.quoteColumn !== undefined);
  if (open !== undefined) {
    return { ok: false, kind: 'invalid-arg', error: { message: MSG_UNCLOSED_QUOTE, column: open.quoteColumn! } };
  }
  // Candidates alive but none complete → more tokens needed.
  return { ok: false, kind: 'incomplete', error: { message: MSG_INCOMPLETE } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion and help
// ─────────────────────────────────────────────────────────────────────────────

interface ItemAcc {
  items: Map<string, { item: CliCompletionItem; fromSpec: boolean }>;
}

function addItem(acc: ItemAcc, token: string, help: string, fromSpec: boolean, isArg: boolean): void {
  const prev = acc.items.get(token);
  if (prev && (prev.fromSpec || !fromSpec)) return;
  const item: CliCompletionItem = { token, help };
  if (isArg) item.isArg = true;
  acc.items.set(token, { item, fromSpec });
}

function literalHelp(spec: CommandSpec, pos: number, lit: string): { help: string; fromSpec: boolean } {
  if (pos === lastLiteralIndex(spec)) return { help: spec.help + (spec.extension ? ' [non-standard]' : ''), fromSpec: true };
  const h = LITERAL_HELP[lit];
  if (h !== undefined) return { help: h, fromSpec: false };
  return { help: `${lit.charAt(0).toUpperCase()}${lit.slice(1)} commands`, fromSpec: false };
}

function matchesTyped(candidate: string, typed: string): boolean {
  return typed === '' || candidate.toLowerCase().startsWith(typed);
}

/** Interface names offered for an `interface` arg: the completion source (or the lister), narrowed by `portFilter`. */
function interfaceNames(arg: ArgSpec, ctx: MatchContext): readonly string[] | undefined {
  let names: readonly string[] | undefined;
  if (arg.completion !== undefined && ctx.completions !== undefined) names = ctx.completions(arg.completion);
  else if (ctx.listInterfaces !== undefined) names = ctx.listInterfaces();
  if (names === undefined) return undefined;
  const filter = arg.portFilter;
  const view = ctx.portView;
  if (filter === undefined || view === undefined) return names;
  return names.filter((n) => portRequirementMet(filter, view(n)));
}

/** Add the options a live candidate offers for the token being typed. Returns whether it accepts free text. */
function optionsFor(c: Cand, typed: string, ctx: MatchContext, acc: ItemAcc): { freeText: boolean; cr: boolean } {
  switch (c.stage) {
    case 'done':
      if (c.spec.filterable && matchesTyped('|', typed)) addItem(acc, '|', PSEUDO_HELP['|']!, false, false);
      return { freeText: false, cr: true };
    case 'rest':
    case 'filter-done':
      if (typed === '') addItem(acc, 'LINE', 'More text', false, true);
      return { freeText: true, cr: true };
    case 'filter-kind':
      for (const k of FILTER_KINDS) if (matchesTyped(k, typed)) addItem(acc, k, PSEUDO_HELP[k]!, false, false);
      return { freeText: false, cr: false };
    case 'filter-pattern':
      if (typed === '') addItem(acc, 'LINE', 'Pattern to match', false, true);
      return { freeText: true, cr: false };
    case 'quoted':
      if (typed === '') addItem(acc, 'TEXT"', 'More text, then a closing quotation mark', false, true);
      return { freeText: true, cr: false };
    case 'iface-number': {
      const arg = argSpecOf(c.spec, c.spec.path[c.pos]!);
      const family = (c.pendingFamily ?? '').toLowerCase();
      let offered = false;
      for (const name of interfaceNames(arg, ctx) ?? []) {
        const m = /^([A-Za-z]+)([0-9][0-9/.]*)$/.exec(name);
        if (m === null || !m[1]!.toLowerCase().startsWith(family)) continue;
        if (matchesTyped(m[2]!, typed)) {
          addItem(acc, m[2]!, arg.help, true, false);
          offered = true;
        }
      }
      if (!offered && typed === '') addItem(acc, 'NUMBER', arg.help, true, true);
      return { freeText: true, cr: false };
    }
    case 'path': {
      const el = c.spec.path[c.pos]!;
      if (!isArgToken(el)) {
        if (matchesTyped(el, typed)) {
          const h = literalHelp(c.spec, c.pos, el);
          addItem(acc, el, h.help, h.fromSpec, false);
        }
        return { freeText: false, cr: false };
      }
      const arg = argSpecOf(c.spec, el);
      const cr = remainingOptional(c, false);
      if (cr && c.spec.filterable && matchesTyped('|', typed)) addItem(acc, '|', PSEUDO_HELP['|']!, false, false);
      if (arg.type === 'choice') {
        for (const ch of arg.choices ?? []) if (matchesTyped(ch, typed)) addItem(acc, ch, arg.help, true, false);
        return { freeText: false, cr };
      }
      if (arg.type === 'interface') {
        const names = interfaceNames(arg, ctx);
        if (names !== undefined) {
          for (const name of names) if (matchesTyped(name, typed)) addItem(acc, name, arg.help, true, false);
          return { freeText: true, cr };
        }
      } else if (arg.completion !== undefined && ctx.completions !== undefined) {
        for (const v of ctx.completions(arg.completion)) if (matchesTyped(v, typed)) addItem(acc, v, arg.help, true, false);
        if (typed === '') addItem(acc, placeholderFor(arg), arg.help, true, true);
        return { freeText: true, cr };
      }
      if (typed === '') addItem(acc, placeholderFor(arg), arg.help, true, true);
      return { freeText: true, cr };
    }
  }
}

function sortedItems(acc: ItemAcc): CliCompletionItem[] {
  const lits: CliCompletionItem[] = [];
  const args: CliCompletionItem[] = [];
  for (const { item } of acc.items.values()) (item.isArg ? args : lits).push(item);
  const cmp = (a: CliCompletionItem, b: CliCompletionItem): number => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
  lits.sort(cmp);
  args.sort(cmp);
  return [...lits, ...args];
}

/** Longest common prefix, compared case-insensitively; the returned text keeps the first word's casing. */
function commonPrefix(words: readonly string[]): string {
  if (words.length === 0) return '';
  let cp = words[0]!;
  for (let i = 1; i < words.length && cp.length > 0; i++) {
    const w = words[i]!.toLowerCase();
    const lc = cp.toLowerCase();
    let k = 0;
    while (k < lc.length && k < w.length && lc.charCodeAt(k) === w.charCodeAt(k)) k++;
    cp = cp.slice(0, k);
  }
  return cp;
}

/** Whether the whole line (all tokens) is executable as-is. */
function lineIsComplete(specs: readonly CommandSpec[], ctx: MatchContext, tokens: readonly Token[], line: string): boolean {
  if (tokens.length === 0) return false;
  const p = parsePrefix(specs, ctx, tokens, tokens.length);
  if (p.error || p.start >= tokens.length) return false;
  const w = walk(makeCands(p.available), tokens, p.start, tokens.length, line, ctx);
  if (w.ambiguous || w.live.length === 0) return false;
  return w.live.some((c) => isComplete(c, p.negated));
}

function analyse(specs: readonly CommandSpec[], ctx: MatchContext, partial: string, withInsert: boolean): CliCompletion {
  const tokens = tokenize(partial);
  const inToken = tokens.length > 0 && !/[\s]$/.test(partial) && partial.length > 0;
  const prefixCount = inToken ? tokens.length - 1 : tokens.length;
  const typedTok = inToken ? tokens[tokens.length - 1]! : undefined;
  const typed = typedTok ? typedTok.text.toLowerCase() : '';

  const p = parsePrefix(specs, ctx, tokens, prefixCount);
  if (p.error) return { items: [], error: p.error.error };

  const acc: ItemAcc = { items: new Map() };
  let live: Cand[];
  if (p.start < prefixCount) {
    const w = walk(makeCands(p.available), tokens, p.start, prefixCount, partial, ctx);
    if (w.ambiguous) return { items: [], error: ambiguousError(tokens[w.ambiguous.index]!, w.ambiguous.literals) };
    if (w.live.length === 0) {
      const d = w.death ?? { index: p.start, kind: 'unrecognized' as const, message: MSG_UNRECOGNIZED };
      return { items: [], error: { message: d.message, column: tokens[d.index]!.column } };
    }
    live = w.live;
  } else {
    live = makeCands(p.available);
    for (const w of pseudoWords(p)) if (matchesTyped(w, typed)) addItem(acc, w, PSEUDO_HELP[w]!, false, false);
  }

  let freeText = false;
  for (const c of live) {
    if (c.spec.hidden === true) continue;
    const r = optionsFor(c, typed, ctx, acc);
    freeText = freeText || r.freeText;
  }

  const items = sortedItems(acc);
  if (inToken && items.length === 0 && !freeText) {
    return { items: [], error: { message: MSG_UNRECOGNIZED, column: typedTok!.column } };
  }

  const out: CliCompletion = { items };
  const cr = inToken ? lineIsComplete(specs, ctx, tokens, partial) : lineIsCompleteOrEmptyStart(live, p, prefixCount);
  if (cr) out.cr = true;

  if (withInsert) {
    const completable = items.filter((i) => !i.isArg).map((i) => i.token);
    if (completable.length === 1) {
      const rem = completable[0]!.slice(typed.length);
      out.insert = rem + ' ';
    } else if (completable.length > 1) {
      const cp = commonPrefix(completable);
      if (cp.length > typed.length) out.insert = cp.slice(typed.length);
    }
  }
  return out;
}

function lineIsCompleteOrEmptyStart(live: readonly Cand[], p: Prefix, prefixCount: number): boolean {
  if (prefixCount === 0 || p.start >= prefixCount) return false;
  return live.some((c) => isComplete(c, p.negated));
}

/**
 * Tab completion for `partial` (text before the cursor). Lists the keywords, choices
 * and interface names that can follow; `insert` is the text to append when the
 * candidates share a longer prefix (a single candidate also gets a trailing space).
 * Specs hidden by scope, `portRequires` or `hidden` are never offered.
 */
export function complete(specs: readonly CommandSpec[], ctx: MatchContext, partial: string): CliCompletion {
  return analyse(specs, ctx, partial, true);
}

/**
 * `?` help for `partial`. A trailing space lists the next tokens; otherwise lists the
 * keywords the current word could become. Arg positions show placeholders such as
 * `A.B.C.D`; `cr` is set when the line is executable as-is. Lists only the current mode.
 */
export function help(specs: readonly CommandSpec[], ctx: MatchContext, partial: string): CliCompletion {
  return analyse(specs, ctx, partial, false);
}
