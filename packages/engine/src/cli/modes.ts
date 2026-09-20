/**
 * CLI mode registry helpers (ARCHITECTURE-P1 §3.13, contracts/cli.ts `MODES`).
 *
 * The contract table `MODES` is the single description of every CLI mode: its class (exec, config,
 * auth), its parent (where `exit` goes), its prompt suffix and the head of the context entry it
 * pushes (`interface`, `line`, `ip dhcp pool`, ...). This module derives everything the parser,
 * the runtime, the handlers and the config rule table need from it, replacing the P0 hard-coding
 * (`EXEC_MODES` / `CONFIG_MODES` / `ALL_MODES`, `isConfigMode`, `isSubConfigMode`,
 * `DO_BLOCKED_HANDLERS`, the `(mode)#` prompt fallback).
 *
 * Unknown modes (a grammar fragment naming a mode that is not registered) keep the P0 behaviour:
 * they are treated as configuration sub-modes of `config` with a `(mode)#` prompt.
 *
 * Pure TypeScript, no state, no I/O.
 */
import { MODE_PROMPT, MODES } from '../contracts/cli.js';
import type { CliMode, CommandSpec, ModeClass, ModeClassSelector, ModeDef } from '../contracts/cli.js';
import type { CliGrammar } from '../contracts/catalog.js';

/** Class selectors accepted in `CommandSpec.mode`, in documentation order. */
export const MODE_CLASS_SELECTORS: readonly ModeClassSelector[] = ['@exec', '@config', '@auth', '@all'];

/** The registered definition of `mode`, or undefined for an unregistered mode. */
export function modeDef(mode: CliMode): ModeDef | undefined {
  return Object.prototype.hasOwnProperty.call(MODES, mode) ? MODES[mode] : undefined;
}

/** Every registered mode, in `MODES` declaration order. */
export function allModes(): readonly ModeDef[] {
  return Object.values(MODES);
}

/** Class of `mode`; unregistered modes count as configuration sub-modes (P0 semantics). */
export function modeClass(mode: CliMode): ModeClass {
  return modeDef(mode)?.class ?? 'config';
}

/** True for EXEC-class modes (`user-exec`, `priv-exec`). */
export function isExecMode(mode: CliMode): boolean {
  return modeClass(mode) === 'exec';
}

/** True for configuration-class modes (`config` and every sub-mode below it). `do` is offered only here. */
export function isConfigClassMode(mode: CliMode): boolean {
  return modeClass(mode) === 'config';
}

/** True for the authentication class (`login`). */
export function isAuthMode(mode: CliMode): boolean {
  return modeClass(mode) === 'auth';
}

/** True for configuration sub-modes: config class and not global configuration itself. */
export function isSubConfigMode(mode: CliMode): boolean {
  return isConfigClassMode(mode) && mode !== 'config';
}

/** Parent mode (`exit` target within the config class); unregistered modes return to `config`. */
export function parentMode(mode: CliMode): CliMode | undefined {
  const def = modeDef(mode);
  if (def === undefined) return 'config';
  return def.parent;
}

/** Prompt suffix appended to the hostname: registry first, then `MODE_PROMPT`, then `(mode)#`. */
export function modePromptSuffix(mode: CliMode): string {
  return modeDef(mode)?.prompt ?? MODE_PROMPT[mode] ?? `(${mode})#`;
}

/** Whether the registered mode exists in `grammar` (unregistered modes are allowed everywhere). */
export function modeInGrammar(mode: CliMode, grammar: CliGrammar): boolean {
  const def = modeDef(mode);
  return def === undefined || def.grammars.includes(grammar);
}

/** Whether one mode token of `CommandSpec.mode` (a mode name or a class selector) admits `mode`. */
export function modeTokenAllows(token: CliMode, mode: CliMode): boolean {
  switch (token) {
    case '@all':
      return true;
    case '@exec':
      return modeClass(mode) === 'exec';
    case '@config':
      return modeClass(mode) === 'config';
    case '@auth':
      return modeClass(mode) === 'auth';
    default:
      return token === mode;
  }
}

/** Whether `spec.mode` (single mode, list, or class selectors) admits `mode`. */
export function specModeAllows(specMode: CommandSpec['mode'], mode: CliMode): boolean {
  if (typeof specMode === 'string') return modeTokenAllows(specMode, mode);
  for (const token of specMode) if (modeTokenAllows(token, mode)) return true;
  return false;
}

/** Registered modes of `cls` (optionally only those of `grammar`), in declaration order; reserved modes excluded unless asked. */
export function modesOfClass(cls: ModeClass, opts: { grammar?: CliGrammar; includeReserved?: boolean } = {}): CliMode[] {
  const out: CliMode[] = [];
  for (const def of allModes()) {
    if (def.class !== cls) continue;
    if (def.reserved === true && opts.includeReserved !== true) continue;
    if (opts.grammar !== undefined && !def.grammars.includes(opts.grammar)) continue;
    out.push(def.name);
  }
  return out;
}

/**
 * `do` refuses specs that change session state: any spec with `entersMode` or `sessionEffect`
 * (`do configure terminal`, `do exit`, `do disable`, ...).
 */
export function isDoBlocked(spec: Pick<CommandSpec, 'entersMode' | 'sessionEffect'>): boolean {
  return spec.entersMode !== undefined || spec.sessionEffect !== undefined;
}

/** Distinct context keys declared by the registry, longest (most tokens) first, then declaration order. */
export function contextKeys(): readonly string[] {
  const keys: string[] = [];
  for (const def of allModes()) {
    if (def.contextKey !== undefined && !keys.includes(def.contextKey)) keys.push(def.contextKey);
  }
  return keys
    .map((k, i) => ({ k, i, n: k.split(' ').length }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.k);
}

const CONTEXT_KEYS: readonly string[] = contextKeys();

/**
 * Context key of one context entry: the longest registered context key that prefixes the entry
 * (`['ip','dhcp','pool','LAN']` → `'ip dhcp pool'`), otherwise the entry's first token
 * (`['crypto','pki']` → `'crypto'`), or `''` for an empty entry.
 */
export function contextKeyOf(entry: readonly string[]): string {
  for (const key of CONTEXT_KEYS) {
    const parts = key.split(' ');
    if (parts.length > entry.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (entry[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return key;
  }
  return entry[0] ?? '';
}

/**
 * Mode entered by a context entry: the first non-reserved registered mode whose context key
 * matches, else the first reserved one, else undefined.
 */
export function modeForContextEntry(entry: readonly string[]): CliMode | undefined {
  const key = contextKeyOf(entry);
  let reserved: CliMode | undefined;
  for (const def of allModes()) {
    if (def.contextKey !== key) continue;
    if (def.reserved !== true) return def.name;
    if (reserved === undefined) reserved = def.name;
  }
  return reserved;
}

/** Mode for a whole context stack: `config` for an empty stack, else the mode of the innermost entry. */
export function modeForContext(context: readonly (readonly string[])[]): CliMode | undefined {
  const last = context[context.length - 1];
  return last === undefined ? 'config' : modeForContextEntry(last);
}

/** Number of context entries a mode carries: modes along its parent chain that declare a context key. */
export function contextDepth(mode: CliMode): number {
  let depth = 0;
  let cur: CliMode | undefined = mode;
  const seen = new Set<string>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const def = modeDef(cur);
    if (def === undefined) {
      // unregistered modes are sub-modes of config with one context entry
      depth++;
      cur = 'config';
      continue;
    }
    if (def.contextKey !== undefined) depth++;
    cur = def.parent;
  }
  return depth;
}

/** Result of `exit` from a mode. */
export type ExitTarget = { close: true } | { close: false; mode: CliMode; context: string[][] };

/**
 * Where `exit` leads: a config-class mode pops to its parent with the context truncated to the
 * parent's depth; exec and auth class modes close the session (P0: `exit` at user or privileged EXEC).
 */
export function exitTarget(mode: CliMode, context: readonly (readonly string[])[]): ExitTarget {
  if (!isConfigClassMode(mode)) return { close: true };
  const parent = parentMode(mode) ?? 'priv-exec';
  const depth = isConfigClassMode(parent) ? Math.min(contextDepth(parent), context.length) : 0;
  return { close: false, mode: parent, context: context.slice(0, depth).map((e) => e.slice()) };
}

/** Where `end` leads from any config-class mode: privileged EXEC with an empty context. */
export function endTarget(): { mode: CliMode; context: string[][] } {
  return { mode: 'priv-exec', context: [] };
}
