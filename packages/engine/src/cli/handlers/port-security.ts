/**
 * cli/handlers/port-security.ts — the `switchport port-security …` lines and `show port-security` (ARCHITECTURE-P2
 * §3.8, §5.1, §5.4, D12; §7 W3 cli).
 *
 * The enabling line needs a fixed port mode (`CLI_MESSAGES.securityNeedsStaticMode`); the other lines are stored as
 * typed with the MAC in canonical form (the parser's `mac-any` already normalised it). eth-switch is the consumer: it
 * derives the `port-security` row and the secure CAM rows from the lines (idempotently, D12). `no switchport
 * port-security` removes the enabling line only, so the settings survive a later re-enable.
 *
 * `show port-security [interface <if> | address]` reads the `port-security` table (rows exist only while the daemon
 * runs and the port is secured) and falls back to the running config for a secured port without a row, and lists the
 * secure CAM rows. Every string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler } from '../../contracts/cli.js';
import type { PortView } from '../../contracts/port.js';
import type { CamRow, PortSecurityRow } from '../../contracts/tables.js';
import { readPortSecurity, type PortSecurityConfig } from '../../protocols/l2/port-security.js';
import { readSwitchport } from '../../protocols/l2/switchport-config.js';
import { P2_HANDLERS, PSEC_SHOW_FORM_ARG, PSEC_VIOLATION_MODES } from '../grammar/index.js';
import { table } from '../format.js';
import { fillTemplate, outcomeOf } from './common.js';
import { portByName, selectedBridgedPort } from './spanning-tree.js';
import { MSG_NO_SUCH_PORT } from './switchport.js';
import { switchedPorts } from './vlan.js';

/** `show port-security` with no secured port. */
export const MSG_NO_SECURED_PORT = 'No port has port security enabled.';
/** `show port-security address` with no secure address. */
export const MSG_NO_SECURE_ADDRESS = 'No secure address has been learned or configured.';
/** `show port-security interface <if>` on a port without the enabling line. */
export const MSG_PORT_NOT_SECURED = 'Port security is not enabled on {port}.';

const PS = ['switchport', 'port-security'] as const;

/** `switchport port-security` / `no switchport port-security` (the enabling line; fixed modes only). */
const enable: CommandHandler = (ctx, _args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...PS], true));
  const mode = readSwitchport(ctx.running, sel.port.id, ctx.model).mode;
  if (mode !== 'access' && mode !== 'trunk') return { error: CLI_MESSAGES.securityNeedsStaticMode };
  return outcomeOf(ctx.config([...PS], false));
};

/** `switchport port-security maximum <n>` / its `no` form. */
const maximum: CommandHandler = (ctx, args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...PS, 'maximum'], true));
  const count = Number(args['count']);
  if (!Number.isInteger(count) || count < 1) return { error: '% Give the number of addresses the port may hold (at least 1).' };
  return outcomeOf(ctx.config([...PS, 'maximum', String(count)], false));
};

/** `switchport port-security violation protect|restrict|shutdown` / its `no` form. */
const violation: CommandHandler = (ctx, args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config([...PS, 'violation'], true));
  const mode = args['mode'] ?? '';
  if (!(PSEC_VIOLATION_MODES as readonly string[]).includes(mode)) return { error: `% Give the violation mode: ${PSEC_VIOLATION_MODES.join(', ')}.` };
  return outcomeOf(ctx.config([...PS, 'violation', mode], false));
};

/** `switchport port-security mac-address <mac>` / its `no` form (one line per address). */
const macAddress: CommandHandler = (ctx, args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  const mac = args['mac'] ?? '';
  if (mac === '') return { error: '% Give the address to allow.' };
  return outcomeOf(ctx.config([...PS, 'mac-address', mac], negate));
};

/** `switchport port-security mac-address sticky [<mac>]` / its `no` forms. */
const sticky: CommandHandler = (ctx, args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  const mac = args['mac'];
  const line = mac === undefined || mac === '' ? [...PS, 'mac-address', 'sticky'] : [...PS, 'mac-address', 'sticky', mac];
  return outcomeOf(ctx.config(line, negate));
};

// ── show port-security ──────────────────────────────────────────────────────────────────────────────────────────

/** What `show port-security` knows about one port: its row when the daemon wrote one, else its lines. */
export interface PortSecurityView {
  port: PortView;
  config: PortSecurityConfig;
  row?: PortSecurityRow;
}

/** Every secured port (the enabling line present), in canonical order. */
export function securedPorts(ctx: CommandCtx): PortSecurityView[] {
  const rows = ctx.tables.get?.<PortSecurityRow>('port-security');
  const out: PortSecurityView[] = [];
  for (const port of switchedPorts(ctx)) {
    const config = readPortSecurity(ctx.running, port.id);
    if (config === undefined) continue;
    out.push({ port, config, row: rows?.get(port.id) });
  }
  return out;
}

/** Secure address count of a view: the row's count, else the configured and sticky lines. */
function countOf(v: PortSecurityView): number {
  return v.row?.count ?? v.config.configured.length + v.config.stickyMacs.length;
}

/** Status word of a view: the row's status, else derived from the port. */
function statusOf(v: PortSecurityView): string {
  if (v.row !== undefined) return v.row.status;
  if (v.port.errDisabled !== undefined) return 'secure-shutdown';
  return v.port.operUp ? 'secure-up' : 'secure-down';
}

/** One `show port-security interface <if>` block. */
export function renderPortSecurity(v: PortSecurityView): string {
  const lines = [
    v.port.id,
    '  Port security: enabled',
    `  Status: ${statusOf(v)}`,
    `  Violation mode: ${v.config.violation}`,
    `  Maximum addresses: ${v.config.max}`,
    `  Secure addresses: ${countOf(v)}`,
    `  Sticky learning: ${v.config.sticky ? 'on' : 'off'}`,
    `  Configured addresses: ${v.config.configured.length === 0 ? 'none' : v.config.configured.join(', ')}`,
    `  Sticky addresses: ${v.config.stickyMacs.length === 0 ? 'none' : v.config.stickyMacs.join(', ')}`,
    `  Violations: ${v.row?.violations ?? 0}`,
    `  Last violating address: ${v.row?.lastViolationMac ?? 'none'}`,
  ];
  return lines.join('\n');
}

const showPortSecurity: CommandHandler = (ctx, args) => {
  const form = args[PSEC_SHOW_FORM_ARG];
  if (form === 'interface') {
    const name = args['iface'] ?? '';
    const port = portByName(ctx, name);
    if (port === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    const view = securedPorts(ctx).find((v) => v.port.id === port.id);
    if (view === undefined) return { output: fillTemplate(MSG_PORT_NOT_SECURED, { port: port.id }) };
    return { output: renderPortSecurity(view) };
  }
  if (form === 'address') {
    const rows: string[][] = [['VLAN', 'Address', 'Kind', 'Port']];
    for (const r of ctx.tables.cam.rows() as CamRow[]) {
      if (r.secure === undefined) continue;
      rows.push([String(r.vlan), r.mac, r.secure, r.port]);
    }
    return { output: rows.length === 1 ? MSG_NO_SECURE_ADDRESS : table(rows, { align: ['right'] }) };
  }
  const views = securedPorts(ctx);
  if (views.length === 0) return { output: MSG_NO_SECURED_PORT };
  const rows: string[][] = [['Port', 'Maximum', 'In use', 'Violation mode', 'Violations', 'Status']];
  let total = 0;
  for (const v of views) {
    total += countOf(v);
    rows.push([v.port.id, String(v.config.max), String(countOf(v)), v.config.violation, String(v.row?.violations ?? 0), statusOf(v)]);
  }
  return { output: `${table(rows)}\n\nSecure addresses in use: ${total}` };
};

/** @since P2 Registry fragment: the port-security lines and show command. */
export const portSecurityHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.ifPortSecurity]: enable,
  [P2_HANDLERS.ifPortSecurityMaximum]: maximum,
  [P2_HANDLERS.ifPortSecurityViolation]: violation,
  [P2_HANDLERS.ifPortSecurityMacAddress]: macAddress,
  [P2_HANDLERS.ifPortSecuritySticky]: sticky,
  [P2_HANDLERS.showPortSecurity]: showPortSecurity,
};
