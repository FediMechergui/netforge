/**
 * cli/handlers/common.ts — helpers shared by the command handlers (ARCHITECTURE-P1 D2, D3, §3.13).
 *
 * Handlers read the device only through `CommandCtx`. These helpers answer the questions every handler family
 * asks: the effective capabilities and port role (data, never the device kind), the port's effective
 * encapsulation, the selected interface of an interface-context mode, values stored under an `interface` section of
 * a config tree, and how to enter a mode on both the P0.5 runtime (`enterMode`) and the P0 one (`setMode`).
 *
 * Pure functions of their inputs; no state. Messages are original wording (spec §1.6).
 */
import type { CliMode, CommandCtx, CommandOutcome } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import { KIND_ENCAP, ROLE_TRAITS, type Capability, type PortEncap, type PortRole } from '../../contracts/catalog.js';
import { effectiveRole } from '../scope.js';
import { VIRTUAL_NAME_PATTERN } from '../grammar/index.js';

/** Error for interface commands run without a selected interface. */
export const MSG_NO_INTERFACE_SELECTED = '% Select an interface first (interface <name>).';

const VIRTUAL_NAME_RE = new RegExp(`^(?:${VIRTUAL_NAME_PATTERN})$`);

/** A fresh global (empty) context for `ctx.config`. */
export function globalContext(): string[][] {
  return [];
}

/** Turn a `ctx.config` failure into an outcome, or an empty outcome on success. */
export function outcomeOf(error: string | undefined): CommandOutcome {
  return error === undefined ? {} : { error };
}

/** A CLI error line: messages from other modules gain the conventional `% ` prefix when they lack it. */
export function cliError(message: string): string {
  return message.startsWith('%') ? message : `% ${message}`;
}

/** Fill `{name}` placeholders of an original message template. */
export function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** Effective device capabilities: the runtime's set, else the model's expanded list, else none. */
export function capabilitiesOf(ctx: CommandCtx): ReadonlySet<Capability> {
  return ctx.capabilities;
}

/** Effective role of a port view on this device (its live role). */
export function roleOf(_ctx: CommandCtx, port: PortView): PortRole {
  return effectiveRole(port);
}

/** Effective encapsulation of a port: live, then spec, then the default of its kind. */
export function encapOf(port: PortView): PortEncap {
  return port.encap ?? port.spec.encap ?? KIND_ENCAP[port.spec.kind];
}

/** Whether a port renders an `interface` section and accepts interface configuration (configurable role trait). */
export function isConfigurablePort(ctx: CommandCtx, port: PortView): boolean {
  return ROLE_TRAITS[roleOf(ctx, port)].configurable;
}

/** Whether a canonical interface name belongs to a creatable virtual family (`Vlan10`, `Loopback0`). */
export function isVirtualInterfaceName(name: string): boolean {
  return VIRTUAL_NAME_RE.test(name);
}

/** The session context stack, outermost first. */
export function sessionContext(ctx: CommandCtx): readonly (readonly string[])[] {
  return ctx.context;
}

/** The interface selected by the session (interface-context modes only), or undefined. */
export function selectedInterface(ctx: CommandCtx): PortId | undefined {
  if (ctx.iface !== undefined) return ctx.iface.id;
  const context = ctx.context;
  for (let i = context.length - 1; i >= 0; i--) {
    const entry = context[i];
    if (entry !== undefined && entry[0] === 'interface' && entry[1] !== undefined) return entry[1];
  }
  return undefined;
}

/** The selected interface's live view, or undefined outside interface modes. */
export function selectedPort(ctx: CommandCtx): PortView | undefined {
  if (ctx.iface !== undefined) return ctx.iface;
  const id = selectedInterface(ctx);
  return id === undefined ? undefined : ctx.ports.get(id);
}

/** The `interface <port>` section node under a config root, if present. */
export function interfaceSection(root: ConfigNode, port: PortId): ConfigNode | undefined {
  return root.children.find((c) => c.key === 'interface' && c.args[0] === port);
}

/** Tokens of a stored (non-group) node. */
function nodeTokens(node: ConfigNode): string[] {
  return [node.key, ...node.args];
}

/**
 * Value tokens of the first line under `section` whose tokens start with `tokens` (`['clock','rate']` →
 * `['64000']`; `['ssid']` → `['LAB']`). Stored `no …` nodes never match. Undefined when absent.
 */
export function sectionArgs(section: ConfigNode | undefined, tokens: readonly string[]): string[] | undefined {
  if (section === undefined) return undefined;
  for (const child of section.children) {
    if (child.key === 'no') continue;
    const t = nodeTokens(child);
    if (t.length < tokens.length) continue;
    if (tokens.every((tok, i) => t[i] === tok)) return t.slice(tokens.length);
  }
  return undefined;
}

/** Whether `section` stores the negation `no <tokens>` (`no keepalive`, `no switchport`). */
export function sectionHasNegation(section: ConfigNode | undefined, tokens: readonly string[]): boolean {
  if (section === undefined) return false;
  return section.children.some((c) => c.key === 'no' && c.args.length === tokens.length && tokens.every((t, i) => c.args[i] === t));
}

/** A stored interface line of the running-config for `port` (see `sectionArgs`). */
export function interfaceLine(ctx: CommandCtx, port: PortId, tokens: readonly string[]): string[] | undefined {
  return sectionArgs(interfaceSection(ctx.running.root, port), tokens);
}

/** Enter `mode` with `context` (outermost first); `iface` is the interface of the innermost `interface` entry. */
export function enterMode(ctx: CommandCtx, mode: CliMode, context: readonly (readonly string[])[]): void {
  let iface: PortId | undefined;
  for (const entry of context) if (entry[0] === 'interface' && entry[1] !== undefined) iface = entry[1];
  const copy = context.map((e) => e.slice());
  ctx.enterMode(mode, iface === undefined ? { context: copy } : { iface, context: copy });
}

/** Printable ASCII only (secrets and names typed at the CLI). */
export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}
