/**
 * cli/handlers/nat.ts — the NAT lines, `show ip nat translations|statistics` and `clear ip nat translation *`
 * (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli; [S9] port forwarding and timeouts).
 *
 * Every line is validated and stored as its canonical §5.2 line through `ctx.config`; the nat daemon is the consumer
 * (it derives rules, pools and static rows from the running config). Checks: a pool's addresses are ordered and
 * inside one network under the given mask or prefix length; a static translation maps two different addresses;
 * the access list of a `source list` rule is a standard number or a name; a port forward names a port on both sides.
 * The `no` forms remove the line by its identity (`no ip nat pool <name>`, `no ip nat inside source list <acl>`,
 * `no ip nat inside source static …` with the full line).
 *
 * Show commands read live state: the `nat` table (writer: nat) and the running config (interface sides, rules,
 * pools). `clear ip nat translation *` sends `nat.clear` (§2.4). Every string is original wording (spec §1.6).
 */
import { ipv4ToU32, maskToPrefixLen, networkOf, parseIpv4, prefixLenToMask, u32ToIpv4 } from '../../contracts/addr.js';
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { NatRow } from '../../contracts/tables.js';
import { isStandardAclNumber } from '../../core/acl.js';
import { NAT_POOL_FORM_ARG, NAT_SHOW_VERBOSE_ARG, NAT_SOURCE_FORM_ARG, NAT_TIMEOUT_KINDS, P2_HANDLERS } from '../grammar/index.js';
import { fmtDuration, table } from '../format.js';
import { fillTemplate, interfaceSection, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';
import { MSG_NO_SUCH_PORT } from './switchport.js';

/** Pool validation messages. */
export const MSG_POOL_RANGE_ORDER = '% The first address of a pool must not be above the last one.';
export const MSG_POOL_RANGE_NETWORK = '% Both ends of the pool must lie in the same network under that mask.';
export const MSG_POOL_INCOMPLETE = '% Give the pool a range and a mask: ip nat pool <name> <first> <last> netmask <mask>.';
/** `ip nat inside source list <acl>` without a target. */
export const MSG_SOURCE_LIST_INCOMPLETE = '% Say what to translate into: pool <name> [overload] or interface <if> overload.';
/** A static translation with equal addresses. */
export const MSG_STATIC_SAME = '% A static translation maps an inside address to a different public address.';
/** An access-list reference that is neither a standard number nor a name. */
export const MSG_BAD_ACL_REF = '% Name a standard access list: a number from 1-99 or 1300-1999, or a list name.';
/** `show ip nat translations` with no row. */
export const MSG_NO_TRANSLATION = 'No translation is active.';

/** Token lists of every line of an interface section, the folded `ip` / `ipv6` / `switchport` groups flattened. */
export function interfaceLinesOf(ctx: CommandCtx, port: PortId): string[][] {
  const node = interfaceSection(ctx.running.root, port);
  if (node === undefined) return [];
  return flattenLines(node.children);
}

/** Token lists of nodes, group nodes (`ip` with children and no args) flattened one level. */
export function flattenLines(nodes: readonly ConfigNode[]): string[][] {
  const out: string[][] = [];
  for (const c of nodes) {
    if (c.args.length === 0 && c.children.length > 0 && (c.key === 'ip' || c.key === 'ipv6' || c.key === 'switchport')) {
      for (const leaf of c.children) out.push([c.key, leaf.key, ...leaf.args]);
      continue;
    }
    out.push([c.key, ...c.args]);
  }
  return out;
}

/** The NAT side of a port from its `ip nat inside|outside` line, if any. */
export function natSideOf(ctx: CommandCtx, port: PortId): 'inside' | 'outside' | undefined {
  for (const t of interfaceLinesOf(ctx, port)) {
    if (t[0] === 'ip' && t[1] === 'nat' && (t[2] === 'inside' || t[2] === 'outside') && t.length === 3) return t[2];
  }
  return undefined;
}

/** The global `ip nat …` lines of the running config (token lists starting at `ip`). */
export function natGlobalLines(ctx: CommandCtx): string[][] {
  return flattenLines(ctx.running.root.children).filter((t) => t[0] === 'ip' && t[1] === 'nat');
}

/** A pool as `show ip nat statistics` lists it. */
export interface NatPoolView {
  name: string;
  start: string;
  end: string;
  mask: string;
  size: number;
}

/** Every `ip nat pool` line, in config order. */
export function natPools(ctx: CommandCtx): NatPoolView[] {
  const out: NatPoolView[] = [];
  for (const t of natGlobalLines(ctx)) {
    if (t[2] !== 'pool' || t.length < 7) continue;
    const [, , , name, start, end, form, value] = t as [string, string, string, string, string, string, string, string];
    const mask = form === 'prefix-length' ? prefixLenToMask(Number(value)) : value;
    const a = parseIpv4(start);
    const b = parseIpv4(end);
    out.push({ name, start, end, mask, size: a === null || b === null || b < a ? 0 : b - a + 1 });
  }
  return out;
}

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────

/** `ip nat inside|outside` / `no ip nat [inside|outside]`. */
const ifIpNat: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['ip', 'nat'], true));
  const side = args['side'];
  if (side !== 'inside' && side !== 'outside') return { error: '% Give the side: inside or outside.' };
  return outcomeOf(ctx.config(['ip', 'nat', side], false));
};

/** `ip nat pool <name> <start> <end> netmask <m> | prefix-length <n>` / `no ip nat pool <name>`. */
const pool: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the pool a name.' };
  if (negate) return outcomeOf(ctx.config(['ip', 'nat', 'pool', name], true, []));
  const start = args['start'];
  const end = args['end'];
  const form = args[NAT_POOL_FORM_ARG];
  if (start === undefined || end === undefined || form === undefined) return { error: MSG_POOL_INCOMPLETE };
  const a = parseIpv4(start);
  const b = parseIpv4(end);
  if (a === null || b === null) return { error: '% Expected two IPv4 addresses (A.B.C.D).' };
  if (a > b) return { error: MSG_POOL_RANGE_ORDER };
  let prefixLen: number | null;
  let tail: string[];
  if (form === 'prefix-length') {
    prefixLen = Number(args['length']);
    if (!Number.isInteger(prefixLen) || prefixLen < 1 || prefixLen > 30) return { error: '% Give a prefix length between 1 and 30.' };
    tail = ['prefix-length', String(prefixLen)];
  } else {
    const mask = args['mask'] ?? '';
    prefixLen = maskToPrefixLen(mask);
    if (prefixLen === null) return { error: '% Expected a contiguous subnet mask such as 255.255.255.0.' };
    tail = ['netmask', mask];
  }
  if (networkOf(u32ToIpv4(a), prefixLen) !== networkOf(u32ToIpv4(b), prefixLen)) return { error: MSG_POOL_RANGE_NETWORK };
  return outcomeOf(ctx.config(['ip', 'nat', 'pool', name, u32ToIpv4(a), u32ToIpv4(b), ...tail], false, []));
};

/** True for an accepted access-list reference: a standard number or a name that is not a number. */
export function isAclReference(text: string): boolean {
  if (text === '') return false;
  if (/^\d+$/.test(text)) return isStandardAclNumber(text);
  return /^[\x21-\x7e]+$/.test(text);
}

/** The canonical port id of a typed interface name, or undefined. */
function portIdOf(ctx: CommandCtx, name: string): PortId | undefined {
  return ctx.ports.has(name) ? name : ctx.resolvePort(name);
}

/** `ip nat inside source list <acl> pool <name> [overload]` / `… interface <if> overload` / `no … list <acl>`. */
const sourceList: CommandHandler = (ctx, args, negate) => {
  const acl = args['acl'] ?? '';
  if (!isAclReference(acl)) return { error: MSG_BAD_ACL_REF };
  const head = ['ip', 'nat', 'inside', 'source', 'list', acl];
  if (negate) return outcomeOf(ctx.config(head, true, []));
  if (args[NAT_SOURCE_FORM_ARG] === undefined) return { error: MSG_SOURCE_LIST_INCOMPLETE };
  if (args[NAT_SOURCE_FORM_ARG] === 'interface') {
    const name = args['iface'] ?? '';
    const port = portIdOf(ctx, name);
    if (port === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    return outcomeOf(ctx.config([...head, 'interface', port, 'overload'], false, []));
  }
  const poolName = args['pool'] ?? '';
  if (poolName === '') return { error: '% Name the pool to translate into.' };
  const overload = args['overload'] === 'overload' ? ['overload'] : [];
  return outcomeOf(ctx.config([...head, 'pool', poolName, ...overload], false, []));
};

/** `ip nat inside source static <il> <ig>` / its `no` form (the full line). */
const staticLine: CommandHandler = (ctx, args, negate) => {
  const local = args['local'] ?? '';
  const global = args['global'] ?? '';
  if (parseIpv4(local) === null || parseIpv4(global) === null) return { error: '% Expected two IPv4 addresses: the inside local and the inside global one.' };
  if (local === global) return { error: MSG_STATIC_SAME };
  return outcomeOf(ctx.config(['ip', 'nat', 'inside', 'source', 'static', local, global], negate, []));
};

// [S9] ── port forwarding and timeouts ───────────────────────────────────────────────────────────────────────────
/** `ip nat inside source static tcp|udp <il> <lp> <ig>|interface <if> <gp>` / its `no` form. */
const staticPort: CommandHandler = (ctx, args, negate) => {
  const proto = args['proto'];
  if (proto !== 'tcp' && proto !== 'udp') return { error: '% Give the protocol: tcp or udp.' };
  const local = args['local'] ?? '';
  const lport = Number(args['lport']);
  const gport = Number(args['gport']);
  if (parseIpv4(local) === null) return { error: '% Expected the inside local address (A.B.C.D).' };
  if (!Number.isInteger(lport) || lport < 1 || lport > 65535 || !Number.isInteger(gport) || gport < 1 || gport > 65535) return { error: '% Ports are numbers between 1 and 65535.' };
  const head = ['ip', 'nat', 'inside', 'source', 'static', proto, local, String(lport)];
  if (args[NAT_SOURCE_FORM_ARG] === 'interface') {
    const name = args['iface'] ?? '';
    const port = portIdOf(ctx, name);
    if (port === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    return outcomeOf(ctx.config([...head, 'interface', port, String(gport)], negate, []));
  }
  const global = args['global'] ?? '';
  if (parseIpv4(global) === null) return { error: '% Expected the inside global address (A.B.C.D).' };
  if (local === global) return { error: MSG_STATIC_SAME };
  return outcomeOf(ctx.config([...head, global, String(gport)], negate, []));
};

/** `ip nat translation timeout|udp-timeout|tcp-timeout|icmp-timeout <s>` / its `no` form. */
const timeout: CommandHandler = (ctx, args, negate) => {
  const which = args['which'] ?? '';
  if (!(NAT_TIMEOUT_KINDS as readonly string[]).includes(which)) return { error: `% Give the timer: ${NAT_TIMEOUT_KINDS.join(', ')}.` };
  if (negate) return outcomeOf(ctx.config(['ip', 'nat', 'translation', which], true, []));
  const seconds = Number(args['seconds']);
  if (!Number.isInteger(seconds) || seconds < 1) return { error: '% Give the timeout in seconds (at least 1).' };
  return outcomeOf(ctx.config(['ip', 'nat', 'translation', which, String(seconds)], false, []));
};
// [S9] ── end ──────────────────────────────────────────────────────────────────────────────────────────────────

// ── show / clear ────────────────────────────────────────────────────────────────────────────────────────────────

/** `address:port` when a port is present, `address` otherwise, `---` when absent. */
function endpoint(address: string | undefined, port: number | undefined): string {
  if (address === undefined) return '---';
  return port === undefined ? address : `${address}:${port}`;
}

/** The `nat` rows in insertion order (the daemon's fixed order, §4.5). */
export function natRows(ctx: CommandCtx): NatRow[] {
  return ctx.tables.get?.<NatRow>('nat')?.rows() ?? [];
}

const showTranslations: CommandHandler = (ctx, args) => {
  const rows = natRows(ctx);
  if (rows.length === 0) return { output: MSG_NO_TRANSLATION };
  const verbose = args[NAT_SHOW_VERBOSE_ARG] === 'verbose';
  const out: string[][] = [['Proto', 'Inside global', 'Inside local', 'Outside local', 'Outside global']];
  if (verbose) out[0]!.push('Kind', 'Expires', 'Rule');
  for (const r of rows) {
    const line = [r.proto === 'any' ? '---' : r.proto, endpoint(r.insideGlobal, r.insideGlobalPort), endpoint(r.insideLocal, r.insideLocalPort), endpoint(r.outsideLocal, r.outsideLocalPort), endpoint(r.outsideGlobal, r.outsideGlobalPort)];
    if (verbose) line.push(r.kind, r.expiresAt === undefined ? 'never' : `in ${fmtDuration(r.expiresAt - ctx.now)}`, r.rule);
    out.push(line);
  }
  return { output: table(out) };
};

const showStatistics: CommandHandler = (ctx) => {
  const rows = natRows(ctx);
  const count = (kind: NatRow['kind']): number => rows.filter((r) => r.kind === kind).length;
  const inside: PortId[] = [];
  const outside: PortId[] = [];
  for (const p of ctx.ports.keys()) {
    const side = natSideOf(ctx, p);
    if (side === 'inside') inside.push(p);
    else if (side === 'outside') outside.push(p);
  }
  const lines = [
    `Translations: ${rows.length} (${count('static')} static, ${count('dynamic')} dynamic, ${count('overload')} shared by port)`,
    `Inside interfaces: ${inside.length === 0 ? 'none' : inside.join(', ')}`,
    `Outside interfaces: ${outside.length === 0 ? 'none' : outside.join(', ')}`,
  ];
  const rules = natGlobalLines(ctx).filter((t) => t[2] === 'inside' && t[3] === 'source').map((t) => t.join(' '));
  lines.push(rules.length === 0 ? 'Rules: none' : `Rules:\n${rules.map((r) => `  ${r}`).join('\n')}`);
  const pools = natPools(ctx);
  if (pools.length === 0) lines.push('Pools: none');
  else {
    lines.push('Pools:');
    for (const p of pools) {
      const used = rows.filter((r) => r.kind === 'dynamic' && ipv4ToU32(r.insideGlobal) >= ipv4ToU32(p.start) && ipv4ToU32(r.insideGlobal) <= ipv4ToU32(p.end)).length;
      lines.push(`  ${p.name}: ${p.start} - ${p.end} (mask ${p.mask}), ${p.size} address${p.size === 1 ? '' : 'es'}, ${used} in use`);
    }
  }
  const timeouts = natGlobalLines(ctx).filter((t) => t[2] === 'translation' && t.length === 5).map((t) => `${t[3]} ${t[4]} s`);
  if (timeouts.length > 0) lines.push(`Timeouts: ${timeouts.join(', ')}`);
  return { output: lines.join('\n') };
};

const clearTranslations: CommandHandler = (ctx) => {
  ctx.request('nat', { kind: 'nat.clear', session: ctx.session.id });
  return {};
};

/** @since P2 Registry fragment: the NAT lines, show commands and clear. */
export const natHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.ifIpNat]: ifIpNat,
  [P2_HANDLERS.configIpNatPool]: pool,
  [P2_HANDLERS.configIpNatSourceList]: sourceList,
  [P2_HANDLERS.configIpNatStatic]: staticLine,
  [P2_HANDLERS.configIpNatStaticPort]: staticPort, // [S9]
  [P2_HANDLERS.configIpNatTimeout]: timeout, // [S9]
  [P2_HANDLERS.showIpNatTranslations]: showTranslations,
  [P2_HANDLERS.showIpNatStatistics]: showStatistics,
  [P2_HANDLERS.execClearIpNat]: clearTranslations,
};
