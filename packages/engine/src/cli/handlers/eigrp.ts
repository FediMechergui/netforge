/**
 * cli/handlers/eigrp.ts — [C1] EIGRP configuration handlers (ARCHITECTURE-P3 §2.16, §5.1, D26; §7 W2 cli).
 *
 *   config.router-eigrp            `router eigrp <as>`: one process per device (`eigrpOneProcess` names the existing AS),
 *                                  refused under `no ip routing` (`eigrpNeedsIpRouting`); enters `config-router-eigrp`
 *                                  with context `[['router', 'eigrp', <as>]]`; `no router eigrp <as>` removes the section
 *   eigrp.network                  `network <a> [<wildcard>]`: stored with the host bits cleared; without a wildcard
 *                                  the classful network of the address (`network 10.1.2.3` → `network 10.0.0.0`)
 *   eigrp.router-id                `eigrp router-id <a>` (0.0.0.0 and 255.255.255.255 refused) / its `no` form
 *   eigrp.passive-interface        `passive-interface <if>`: with `passive-interface default` set, the positive form
 *                                  removes the stored exception and the `no` form stores it (`no passive-interface X`);
 *                                  without the default, the positive form is stored and the `no` form removes it
 *   eigrp.passive-interface-default `passive-interface default`; its `no` form also drops every stored exception
 *   eigrp.metric-weights           `metric weights 0 k1 k2 k3 k4 k5` / `no metric weights` (the defaults 1 0 1 0 0)
 *   eigrp.maximum-paths            `maximum-paths <1-4>` / its `no` form
 *   eigrp.auto-summary             `auto-summary` refused (`eigrpAutoSummary`); `no auto-summary` accepted, not stored
 *   if.delay                       `delay <n>` / `no delay`
 *   if.ip-hello-interval-eigrp     `ip hello-interval eigrp <as> <s>` / `no ip hello-interval eigrp <as>`
 *   if.ip-hold-time-eigrp          `ip hold-time eigrp <as> <s>` / `no ip hold-time eigrp <as>`
 *
 * The lines are exactly the W1 rules' canonical forms (cli/config-rules.ts, the [C1] block); the eigrp daemon reads
 * them. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import { CLI_MESSAGES } from '../../contracts/cli.js';
import { parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import { EIGRP_HANDLERS, EIGRP_MODE } from '../grammar/eigrp.js';
import { enterMode, fillTemplate, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** @since P3 [C1] A process line typed outside `router eigrp`. */
export const MSG_NO_EIGRP_PROCESS = '% Enter "router eigrp <as>" first.';
/** @since P3 [C1] `eigrp router-id` with an address that cannot name a router. */
export const MSG_EIGRP_ROUTER_ID = '% A router ID cannot be 0.0.0.0 or 255.255.255.255.';
/** @since P3 [C1] `network` with a wildcard that is not a valid wildcard mask. */
export const MSG_EIGRP_WILDCARD = '% Expected a wildcard mask whose 1 bits are contiguous at the right, such as 0.0.0.255.';
/** @since P3 [C1] `no ip hello-interval eigrp` / `no ip hold-time eigrp` without the autonomous system. */
export const MSG_EIGRP_AS_NEEDED = '% Give the autonomous system number.';

/** The `router eigrp <as>` section of a running config, as its AS, or undefined. */
export function eigrpProcessAs(running: CommandCtx['running']): string | undefined {
  const node = running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp');
  return node?.args[1];
}

/** True when the running config stores `no ip routing` (the stored negation of the `ip routing` slot). */
export function ipRoutingOff(running: CommandCtx['running']): boolean {
  return running.root.children.some((c) => c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'routing');
}

/** The context entry of the session's `router eigrp` section, or undefined outside it. */
function eigrpEntry(ctx: CommandCtx): readonly string[] | undefined {
  const e = ctx.context[ctx.context.length - 1];
  return e !== undefined && e[0] === 'router' && e[1] === 'eigrp' ? e : undefined;
}

/** The classful network of an IPv4 address (class A /8, B /16, C /24; D and E kept whole). */
export function classfulNetwork(address: string): string | undefined {
  const v = parseIpv4(address);
  if (v === null) return undefined;
  const first = v >>> 24;
  const mask = first < 128 ? 0xff000000 : first < 192 ? 0xffff0000 : first < 224 ? 0xffffff00 : 0xffffffff;
  return u32ToIpv4((v & mask) >>> 0);
}

/** A wildcard mask whose 1 bits are contiguous at the right (0.0.0.255), or undefined. */
function wildcardBits(wildcard: string): number | undefined {
  const w = parseIpv4(wildcard);
  if (w === null) return undefined;
  // contiguous low ones: w + 1 is a power of two (or w is all ones)
  const next = (w + 1) >>> 0;
  return w === 0xffffffff || (next & (next - 1)) === 0 ? w : undefined;
}

/** `router eigrp <as>` / `no router eigrp <as>`. */
const routerEigrp: CommandHandler = (ctx, args, negate) => {
  const as = args['as'] ?? '';
  if (as === '') return { error: '% Give the autonomous system number (1-65535).' };
  const line = ['router', 'eigrp', String(Number(as))];
  if (negate) return outcomeOf(ctx.config(line, true, []));
  if (ipRoutingOff(ctx.running)) return { error: CLI_MESSAGES.eigrpNeedsIpRouting };
  const existing = eigrpProcessAs(ctx.running);
  if (existing !== undefined && existing !== line[2]) return { error: fillTemplate(CLI_MESSAGES.eigrpOneProcess, { as: existing }) };
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, EIGRP_MODE, [line]);
  return {};
};

/** `network <a> [<wildcard>]` / its `no` form. */
const network: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  const address = args['address'] ?? '';
  const wildcard = args['wildcard'];
  let tokens: string[];
  if (wildcard === undefined || wildcard === '') {
    const net = classfulNetwork(address);
    if (net === undefined) return { error: '% Expected a network address (A.B.C.D).' };
    tokens = ['network', net];
  } else {
    const w = wildcardBits(wildcard);
    const a = parseIpv4(address);
    if (w === undefined) return { error: MSG_EIGRP_WILDCARD };
    if (a === null) return { error: '% Expected a network address (A.B.C.D).' };
    tokens = ['network', u32ToIpv4((a & ~w) >>> 0), wildcard];
  }
  return outcomeOf(ctx.config(tokens, negate));
};

/** `eigrp router-id <a>` / `no eigrp router-id`. */
const routerId: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['eigrp', 'router-id'], true));
  const address = args['address'] ?? '';
  if (address === '0.0.0.0' || address === '255.255.255.255') return { error: MSG_EIGRP_ROUTER_ID };
  return outcomeOf(ctx.config(['eigrp', 'router-id', address], false));
};

/** True when the session's `router eigrp` section stores `passive-interface default`. */
function passiveDefaultOn(ctx: CommandCtx): boolean {
  const entry = eigrpEntry(ctx);
  if (entry === undefined) return false;
  const section = ctx.running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp' && c.args[1] === entry[2]);
  return section?.children.some((c) => c.key === 'passive-interface' && c.args[0] === 'default') ?? false;
}

/** The stored exceptions (`no passive-interface X`) of the session's `router eigrp` section. */
function passiveExceptions(ctx: CommandCtx): string[] {
  const entry = eigrpEntry(ctx);
  if (entry === undefined) return [];
  const section = ctx.running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp' && c.args[1] === entry[2]);
  const out: string[] = [];
  for (const c of section?.children ?? []) {
    if (c.key === 'no' && c.args[0] === 'passive-interface' && c.args[1] !== undefined) out.push(c.args[1]);
  }
  return out;
}

/** Remove a stored `no passive-interface <port>` line (the `no <rest>` rule removes exactly that node). */
function dropException(ctx: CommandCtx, port: string): string | undefined {
  return ctx.config(['no', 'passive-interface', port], true);
}

/** `passive-interface <if>` / `no passive-interface <if>`. */
const passiveInterface: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  const port = args['iface'] ?? '';
  if (port === '') return { error: '% Give the interface.' };
  const isException = passiveExceptions(ctx).includes(port);
  if (passiveDefaultOn(ctx)) {
    // every interface is passive: the positive form removes the exception, the negation stores it
    if (!negate) return isException ? outcomeOf(dropException(ctx, port)) : {};
    return outcomeOf(ctx.config(['passive-interface', port], true));
  }
  if (!negate) return outcomeOf(ctx.config(['passive-interface', port], false));
  // without the default, `no passive-interface X` removes the line and leaves no exception behind
  const error = ctx.config(['passive-interface', port], true);
  if (error !== undefined) return { error };
  return passiveExceptions(ctx).includes(port) ? outcomeOf(dropException(ctx, port)) : {};
};

/** `passive-interface default` / `no passive-interface default` (which also drops every exception). */
const passiveDefault: CommandHandler = (ctx, _args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (!negate) return outcomeOf(ctx.config(['passive-interface', 'default'], false));
  const error = ctx.config(['passive-interface', 'default'], true);
  if (error !== undefined) return { error };
  // every exception (`no passive-interface X`) goes with the default it qualified
  const leftovers = [...passiveExceptions(ctx)];
  for (const port of leftovers) {
    const e = dropException(ctx, port);
    if (e !== undefined) return { error: e };
  }
  return {};
};

/** `metric weights 0 k1 k2 k3 k4 k5` / `no metric weights`. */
const metricWeights: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['metric', 'weights'], true));
  const ks = ['tos', 'k1', 'k2', 'k3', 'k4', 'k5'].map((k) => args[k] ?? '');
  if (ks.some((k) => k === '')) return { error: '% Give the type of service (0) and the five K values.' };
  return outcomeOf(ctx.config(['metric', 'weights', ...ks.map((k) => String(Number(k)))], false));
};

/** `maximum-paths <1-4>` / `no maximum-paths`. */
const maximumPaths: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['maximum-paths'], true));
  return outcomeOf(ctx.config(['maximum-paths', String(Number(args['paths'] ?? ''))], false));
};

/** `auto-summary` (refused) / `no auto-summary` (the default: accepted, nothing stored). */
const autoSummary: CommandHandler = (ctx, _args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  return negate ? {} : { error: CLI_MESSAGES.eigrpAutoSummary };
};

/** `delay <tens-of-us>` / `no delay`. */
const delay: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['delay'], true));
  return outcomeOf(ctx.config(['delay', String(Number(args['tens-of-us'] ?? ''))], false));
};

/** `ip hello-interval|hold-time eigrp <as> <s>` and their `no` forms. */
function eigrpTimer(keyword: 'hello-interval' | 'hold-time'): CommandHandler {
  return (ctx, args, negate): CommandOutcome => {
    if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
    const as = args['as'];
    if (as === undefined || as === '') return { error: MSG_EIGRP_AS_NEEDED };
    const head = ['ip', keyword, 'eigrp', String(Number(as))];
    if (negate) return outcomeOf(ctx.config(head, true));
    return outcomeOf(ctx.config([...head, String(Number(args['seconds'] ?? ''))], false));
  };
}

/** @since P3 [C1] Registry fragment: EIGRP handler id → handler. */
export const eigrpHandlers: Readonly<Record<string, CommandHandler>> = {
  [EIGRP_HANDLERS.configRouterEigrp]: routerEigrp,
  [EIGRP_HANDLERS.eigrpNetwork]: network,
  [EIGRP_HANDLERS.eigrpRouterId]: routerId,
  [EIGRP_HANDLERS.eigrpPassiveInterface]: passiveInterface,
  [EIGRP_HANDLERS.eigrpPassiveDefault]: passiveDefault,
  [EIGRP_HANDLERS.eigrpMetricWeights]: metricWeights,
  [EIGRP_HANDLERS.eigrpMaximumPaths]: maximumPaths,
  [EIGRP_HANDLERS.eigrpAutoSummary]: autoSummary,
  [EIGRP_HANDLERS.ifDelay]: delay,
  [EIGRP_HANDLERS.ifIpHelloEigrp]: eigrpTimer('hello-interval'),
  [EIGRP_HANDLERS.ifIpHoldEigrp]: eigrpTimer('hold-time'),
};
