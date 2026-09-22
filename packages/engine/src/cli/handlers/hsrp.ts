/**
 * cli/handlers/hsrp.ts — [SHOULD S2] the `standby …` lines and `show standby [brief]` (ARCHITECTURE-P2 §3.10, §5.2,
 * §5.4; §7 W3 cli [S2]).
 *
 * Lines are stored as typed on the selected L3 interface (`standby [<g>] ip [<a>]`, `priority`, `preempt [delay
 * minimum <s>]`, `timers <hello> <hold>`, `standby version 1|2`); a group-less line is group 0. Checks: the group
 * fits the interface's version (0-255 for version 1, 0-4095 for version 2; switching to version 1 with a higher
 * group configured is refused), the hold time is above the hello time. The hsrp daemon is the consumer.
 *
 * `show standby [brief]` reads the `hsrp` table (writer: hsrp) and the timers from the running config. Every string
 * is original wording (spec §1.6).
 */
import { parseIpv4 } from '../../contracts/addr.js';
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { HsrpRow } from '../../contracts/tables.js';
import { HSRP_SHOW_BRIEF_ARG, HSRP_V1_GROUP_MAX, HSRP_V2_GROUP_MAX, P2_HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';
import { interfaceLinesOf } from './nat.js';

/** A group above the version's limit. */
export const MSG_HSRP_GROUP_RANGE = '% Version {version} allows groups 0-{max} on this interface.';
/** `standby version 1` while a group above 255 is configured. */
export const MSG_HSRP_VERSION_DOWNGRADE = '% Group {group} is above 255; remove it before choosing version 1.';
/** A hold time not above the hello time. */
export const MSG_HSRP_TIMERS = '% The hold time must be longer than the hello time.';
/** `show standby` with no row. */
export const MSG_NO_STANDBY = 'No standby group is running on this device.';

/** Default timers (§3.10). */
export const HSRP_DEFAULT_HELLO_S = 3;
export const HSRP_DEFAULT_HOLD_S = 10;

/** The configured HSRP version of an interface (default 1). */
export function hsrpVersionOf(ctx: CommandCtx, port: PortId): 1 | 2 {
  for (const t of interfaceLinesOf(ctx, port)) if (t[0] === 'standby' && t[1] === 'version') return t[2] === '2' ? 2 : 1;
  return 1;
}

/** The group numbers configured on an interface (from every `standby [<g>] …` line; group-less lines are 0). */
export function hsrpGroupsOf(ctx: CommandCtx, port: PortId): number[] {
  const out = new Set<number>();
  for (const t of interfaceLinesOf(ctx, port)) {
    if (t[0] !== 'standby' || t[1] === 'version') continue;
    out.add(/^\d+$/.test(t[1] ?? '') ? Number(t[1]) : 0);
  }
  return [...out].sort((a, b) => a - b);
}

/** The configured timers of a group (defaults when absent). */
export function hsrpTimersOf(ctx: CommandCtx, port: PortId, group: number): { helloS: number; holdS: number } {
  for (const t of interfaceLinesOf(ctx, port)) {
    if (t[0] !== 'standby') continue;
    const rest = /^\d+$/.test(t[1] ?? '') ? t.slice(1) : ['0', ...t.slice(1)];
    if (Number(rest[0]) !== group || rest[1] !== 'timers') continue;
    return { helloS: Number(rest[2]), holdS: Number(rest[3]) };
  }
  return { helloS: HSRP_DEFAULT_HELLO_S, holdS: HSRP_DEFAULT_HOLD_S };
}

/** The selected interface with its group tokens, or the error outcome. */
function groupHead(ctx: CommandCtx, args: Record<string, string>): { port: PortId; head: string[]; group: number } | { error: string } {
  const port = selectedInterface(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const raw = args['group'];
  const group = raw === undefined || raw === '' ? 0 : Number(raw);
  const version = hsrpVersionOf(ctx, port);
  const max = version === 2 ? HSRP_V2_GROUP_MAX : HSRP_V1_GROUP_MAX;
  if (!Number.isInteger(group) || group < 0 || group > max) return { error: MSG_HSRP_GROUP_RANGE.replace('{version}', String(version)).replace('{max}', String(max)) };
  return { port, head: raw === undefined || raw === '' ? ['standby'] : ['standby', String(group)], group };
}

/** `standby version 1|2` / `no standby version`. */
const version: CommandHandler = (ctx, args, negate) => {
  const port = selectedInterface(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['standby', 'version'], true));
  const v = args['version'];
  if (v !== '1' && v !== '2') return { error: '% Give the version: 1 or 2.' };
  if (v === '1') {
    const high = hsrpGroupsOf(ctx, port).find((g) => g > HSRP_V1_GROUP_MAX);
    if (high !== undefined) return { error: MSG_HSRP_VERSION_DOWNGRADE.replace('{group}', String(high)) };
  }
  return outcomeOf(ctx.config(['standby', 'version', v], false));
};

/** `standby [<g>] ip [<a>]` / `no standby [<g>] ip`. */
const ip: CommandHandler = (ctx, args, negate) => {
  const sel = groupHead(ctx, args);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...sel.head, 'ip'], true));
  const address = args['address'];
  if (address !== undefined && address !== '' && parseIpv4(address) === null) return { error: '% Expected the virtual address (A.B.C.D).' };
  return outcomeOf(ctx.config(address === undefined || address === '' ? [...sel.head, 'ip'] : [...sel.head, 'ip', address], false));
};

/** `standby [<g>] priority <n>` / its `no` form. */
const priority: CommandHandler = (ctx, args, negate) => {
  const sel = groupHead(ctx, args);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...sel.head, 'priority'], true));
  const p = Number(args['priority']);
  if (!Number.isInteger(p) || p < 0 || p > 255) return { error: '% Give a priority between 0 and 255.' };
  return outcomeOf(ctx.config([...sel.head, 'priority', String(p)], false));
};

/** `standby [<g>] preempt [delay minimum <s>]` / `no standby [<g>] preempt`. */
const preempt: CommandHandler = (ctx, args, negate) => {
  const sel = groupHead(ctx, args);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...sel.head, 'preempt'], true));
  const seconds = args['seconds'];
  if (seconds === undefined || seconds === '') return outcomeOf(ctx.config([...sel.head, 'preempt'], false));
  const s = Number(seconds);
  if (!Number.isInteger(s) || s < 0) return { error: '% Give the delay in seconds.' };
  return outcomeOf(ctx.config([...sel.head, 'preempt', 'delay', 'minimum', String(s)], false));
};

/** `standby [<g>] timers <hello> <hold>` / its `no` form. */
const timers: CommandHandler = (ctx, args, negate) => {
  const sel = groupHead(ctx, args);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...sel.head, 'timers'], true));
  const hello = Number(args['hello']);
  const hold = Number(args['hold']);
  if (!Number.isInteger(hello) || !Number.isInteger(hold) || hello < 1 || hold < 2) return { error: '% Give the hello and hold times in seconds.' };
  if (hold <= hello) return { error: MSG_HSRP_TIMERS };
  return outcomeOf(ctx.config([...sel.head, 'timers', String(hello), String(hold)], false));
};

// ── show standby ────────────────────────────────────────────────────────────────────────────────────────────────

/** Router text of a row's active/standby field. */
function routerText(value: HsrpRow['active']): string {
  if (value === undefined) return 'unknown';
  return value === 'local' ? 'this router' : value;
}

/** The `hsrp` rows sorted by interface (canonical order) then group. */
export function hsrpRows(ctx: CommandCtx): HsrpRow[] {
  const order = new Map<PortId, number>();
  let i = 0;
  for (const id of ctx.ports.keys()) order.set(id, i++);
  return (ctx.tables.get?.<HsrpRow>('hsrp')?.rows() ?? []).sort((a, b) => (order.get(a.iface) ?? 1e9) - (order.get(b.iface) ?? 1e9) || a.group - b.group);
}

/** One group block of `show standby`. */
export function renderStandby(ctx: CommandCtx, r: HsrpRow): string {
  const t = hsrpTimersOf(ctx, r.iface, r.group);
  return [
    `${r.iface} group ${r.group} (version ${r.version})`,
    `  State: ${r.state}`,
    `  Virtual address: ${r.virtualIp ?? 'none yet'}   Virtual MAC: ${r.virtualMac}`,
    `  Priority: ${r.priority}   Preempt: ${r.preempt ? 'yes' : 'no'}`,
    `  Timers: hello ${t.helloS} s, hold ${t.holdS} s`,
    `  Active router: ${routerText(r.active)}   Standby router: ${routerText(r.standby)}`,
  ].join('\n');
}

const showStandby: CommandHandler = (ctx, args) => {
  const rows = hsrpRows(ctx);
  if (rows.length === 0) return { output: MSG_NO_STANDBY };
  if (args[HSRP_SHOW_BRIEF_ARG] !== 'brief') return { output: rows.map((r) => renderStandby(ctx, r)).join('\n\n') };
  const out: string[][] = [['Interface', 'Group', 'Priority', 'Preempt', 'State', 'Active', 'Standby', 'Virtual address']];
  for (const r of rows) out.push([r.iface, String(r.group), String(r.priority), r.preempt ? 'yes' : 'no', r.state, routerText(r.active), routerText(r.standby), r.virtualIp ?? '-']);
  return { output: table(out) };
};

/** @since P2 [S2] Registry fragment: the HSRP lines and show command. */
export const hsrpHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.ifStandbyVersion]: version,
  [P2_HANDLERS.ifStandbyIp]: ip,
  [P2_HANDLERS.ifStandbyPriority]: priority,
  [P2_HANDLERS.ifStandbyPreempt]: preempt,
  [P2_HANDLERS.ifStandbyTimers]: timers,
  [P2_HANDLERS.showStandby]: showStandby,
};
