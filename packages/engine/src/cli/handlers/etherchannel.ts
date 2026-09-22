/**
 * cli/handlers/etherchannel.ts — `channel-group`, `port-channel load-balance` and the EtherChannel show commands
 * (ARCHITECTURE-P2 §3.7, §5.1, §5.4, D10; §7 W3 cli).
 *
 * `channel-group <n> mode <m>` on a switched port (§3.7 step 1): when `interface Port-channel<n>` does not exist the
 * handler creates it (`ensureVirtualPort`, `CLI_MESSAGES.channelCreated`), makes its section and copies the member's
 * `switchport …` lines into it, then stores the member's line; the etherchannel daemon does the rest. A Port-channel
 * cannot join a bundle, a routed port is told it is not switched. `no channel-group` removes the member's line.
 * The mirroring of lines typed later under `interface Port-channel<n>` onto every member is done by the switchport
 * line handlers (`configWithMembers` in handlers/switchport.ts), not here.
 *
 * Show commands read live state: the `etherchannel` table (writer: etherchannel), the running config (members with a
 * `channel-group` line but no row yet), the Port-channel port views and the load-balance line. Every string is
 * original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { EtherchannelRow } from '../../contracts/tables.js';
import { LOAD_BALANCE_METHODS, readLoadBalance } from '../../protocols/l2/lag-hash.js';
import { CHANNEL_GROUP_MAX, CHANNEL_GROUP_MIN, CHANNEL_MODES, P2_HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { fillTemplate, interfaceSection, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';

/** `channel-group` typed under `interface Port-channelN`. */
export const MSG_CHANNEL_ON_BUNDLE = '% A Port-channel cannot be a member of another bundle. Type channel-group on the physical ports.';
/** `show etherchannel …` / `show lacp neighbor` with nothing configured. */
export const MSG_NO_CHANNEL = 'No port is configured for a bundle (channel-group).';
export const MSG_NO_LACP_PARTNER = 'No LACP partner has been seen on any member.';

/** Protocol a channel mode negotiates with. */
export function channelProtocolOf(mode: string): EtherchannelRow['protocol'] {
  if (mode === 'active' || mode === 'passive') return 'lacp';
  if (mode === 'desirable' || mode === 'auto') return 'pagp';
  return 'static';
}

/** Canonical name of the bundle of channel group `n`. */
export function bundleName(group: number): PortId {
  return `Port-channel${group}`;
}

/** A member as the CLI sees it: its `channel-group` line overlaid with the daemon's row when one exists. */
export interface ChannelMemberView {
  port: PortId;
  group: number;
  bundle: PortId;
  mode: EtherchannelRow['mode'];
  protocol: EtherchannelRow['protocol'];
  state: EtherchannelRow['state'] | 'configured';
  row?: EtherchannelRow;
}

/** Every member with a `channel-group` line (canonical port order) or a row, grouped by channel group ascending. */
export function channelMembers(ctx: CommandCtx): Map<number, ChannelMemberView[]> {
  const rows = new Map<PortId, EtherchannelRow>();
  for (const r of ctx.tables.get?.<EtherchannelRow>('etherchannel')?.rows() ?? []) rows.set(r.port, r);
  const members: ChannelMemberView[] = [];
  const seen = new Set<PortId>();
  for (const port of ctx.ports.keys()) {
    const line = interfaceSection(ctx.running.root, port)?.children.find((c) => c.key === 'channel-group');
    const row = rows.get(port);
    if (line === undefined && row === undefined) continue;
    seen.add(port);
    const group = row?.group ?? Number(line?.args[0]);
    const mode = (row?.mode ?? line?.args[2] ?? 'on') as EtherchannelRow['mode'];
    if (!Number.isInteger(group)) continue;
    members.push({ port, group, bundle: row?.bundle ?? bundleName(group), mode, protocol: row?.protocol ?? channelProtocolOf(mode), state: row?.state ?? 'configured', row });
  }
  for (const r of rows.values()) {
    if (seen.has(r.port)) continue;
    members.push({ port: r.port, group: r.group, bundle: r.bundle, mode: r.mode, protocol: r.protocol, state: r.state, row: r });
  }
  const out = new Map<number, ChannelMemberView[]>();
  for (const m of members.sort((a, b) => a.group - b.group)) {
    const list = out.get(m.group) ?? [];
    list.push(m);
    out.set(m.group, list);
  }
  return out;
}

/** Status word of a bundle: in use when its port view is up, down when it exists, not created otherwise. */
export function bundleStatus(ctx: CommandCtx, bundle: PortId): string {
  const view = ctx.ports.get(bundle);
  if (view === undefined) return 'not created';
  return view.operUp ? 'in use' : 'down';
}

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────

/** `channel-group <n> mode <m>` / `no channel-group`. */
const channelGroup: CommandHandler = (ctx, args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const role = roleOf(ctx, port);
  if (role === 'channel') return { error: MSG_CHANNEL_ON_BUNDLE };
  if (role !== 'switched') return { error: fillTemplate(CLI_MESSAGES.notSwitchport, { port: port.id }) };
  if (negate) return outcomeOf(ctx.config(['channel-group'], true));
  const group = Number(args['group']);
  if (!Number.isInteger(group) || group < CHANNEL_GROUP_MIN || group > CHANNEL_GROUP_MAX) return { error: `% Give a channel group between ${CHANNEL_GROUP_MIN} and ${CHANNEL_GROUP_MAX}.` };
  const mode = args['mode'] ?? '';
  if (!(CHANNEL_MODES as readonly string[]).includes(mode)) return { error: `% Give the mode: ${CHANNEL_MODES.join(', ')}.` };
  const bundle = bundleName(group);
  let output: string | undefined;
  if (!ctx.ports.has(bundle)) {
    const created = ctx.device.ensureVirtualPort(bundle);
    if (!created.ok) return { error: created.error.startsWith('%') ? created.error : `% ${created.error}` };
    const sectionError = ctx.config(['interface', bundle], false, []);
    if (sectionError !== undefined) return { error: sectionError };
    if (created.created) {
      output = fillTemplate(CLI_MESSAGES.channelCreated, { group });
      // copy the member's switchport lines so bundle and member stay consistent (§3.7 step 1)
      for (const child of interfaceSection(ctx.running.root, port.id)?.children ?? []) {
        if (child.key !== 'switchport') continue;
        const lines = child.args.length === 0 && child.children.length > 0 ? child.children.map((leaf) => ['switchport', leaf.key, ...leaf.args]) : [['switchport', ...child.args]];
        for (const line of lines) {
          const error = ctx.config(line, false, [['interface', bundle]]);
          if (error !== undefined) return { error };
        }
      }
    }
  }
  const error = ctx.config(['channel-group', String(group), 'mode', mode], false);
  if (error !== undefined) return output === undefined ? { error } : { output, error };
  return output === undefined ? {} : { output };
};

/** `port-channel load-balance <method>` / its `no` form. */
const loadBalance: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['port-channel', 'load-balance'], true, []));
  const method = args['method'] ?? '';
  if (!(LOAD_BALANCE_METHODS as readonly string[]).includes(method)) return { error: `% Give the hash input: ${LOAD_BALANCE_METHODS.join(', ')}.` };
  return outcomeOf(ctx.config(['port-channel', 'load-balance', method], false, []));
};

// ── show ────────────────────────────────────────────────────────────────────────────────────────────────────────

const showSummary: CommandHandler = (ctx) => {
  const groups = channelMembers(ctx);
  if (groups.size === 0) return { output: MSG_NO_CHANNEL };
  const lines = [`Load balancing: ${readLoadBalance(ctx.running)}`, ''];
  const rows: string[][] = [['Group', 'Bundle', 'Status', 'Protocol', 'Members (state)']];
  for (const [group, members] of groups) {
    const bundle = members[0]?.bundle ?? bundleName(group);
    const protocols = [...new Set(members.map((m) => m.protocol))];
    rows.push([String(group), bundle, bundleStatus(ctx, bundle), protocols.join('/'), members.map((m) => `${m.port} (${m.state})`).join(', ')]);
  }
  lines.push(table(rows));
  return { output: lines.join('\n') };
};

const showPortChannel: CommandHandler = (ctx) => {
  const groups = channelMembers(ctx);
  if (groups.size === 0) return { output: MSG_NO_CHANNEL };
  const blocks: string[] = [];
  for (const [group, members] of groups) {
    const bundle = members[0]?.bundle ?? bundleName(group);
    const bundled = members.filter((m) => m.state === 'bundled').length;
    const lines = [
      bundle,
      `  Status: ${bundleStatus(ctx, bundle)}   Members bundled: ${bundled} of ${members.length}`,
      `  Protocol: ${[...new Set(members.map((m) => m.protocol))].join('/')}   Load balancing: ${readLoadBalance(ctx.running)}`,
    ];
    const rows: string[][] = [['Port', 'Mode', 'State', 'Reason', 'Partner system', 'Partner key', 'Partner port']];
    for (const m of members) {
      rows.push([m.port, m.mode, m.state, m.row?.reason ?? '', m.row?.partnerSystem ?? '-', m.row?.partnerKey === undefined ? '-' : String(m.row.partnerKey), m.row?.partnerPort === undefined ? '-' : String(m.row.partnerPort)]);
    }
    lines.push(table(rows, { indent: '  ' }));
    blocks.push(lines.join('\n'));
  }
  return { output: blocks.join('\n\n') };
};

// [S3] ── show lacp neighbor ─────────────────────────────────────────────────────────────────────────────────────
const showLacpNeighbor: CommandHandler = (ctx) => {
  const rows: string[][] = [['Port', 'Bundle', 'Partner system', 'Partner key', 'Partner port', 'State']];
  for (const members of channelMembers(ctx).values()) {
    for (const m of members) {
      if (m.protocol !== 'lacp' || m.row?.partnerSystem === undefined) continue;
      rows.push([m.port, m.bundle, m.row.partnerSystem, String(m.row.partnerKey ?? '-'), String(m.row.partnerPort ?? '-'), m.state]);
    }
  }
  return { output: rows.length === 1 ? MSG_NO_LACP_PARTNER : table(rows) };
};
// [S3] ── end ──────────────────────────────────────────────────────────────────────────────────────────────────

/** @since P2 Registry fragment: the EtherChannel lines and show commands. */
export const etherchannelHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.ifChannelGroup]: channelGroup,
  [P2_HANDLERS.configPortChannelLoadBalance]: loadBalance,
  [P2_HANDLERS.showEtherchannelSummary]: showSummary,
  [P2_HANDLERS.showEtherchannelPortChannel]: showPortChannel,
  [P2_HANDLERS.showLacpNeighbor]: showLacpNeighbor, // [S3]
};
