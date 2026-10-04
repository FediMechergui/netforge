/**
 * cli/handlers/hardening.ts — DHCP snooping and dynamic ARP inspection lines (ARCHITECTURE-P3 §5.3, D13; §7 W2 cli
 * part 1).
 *
 * Every line is stored as the config rules say (cli/config-rules.ts, W1): `ip dhcp snooping vlan <list>` and `ip arp
 * inspection vlan <list>` one line per VLAN, `verify mac-address` and `information option` as stored negations (their
 * positive form is the default and stores nothing), the interface limits as single slots. eth-switch reads them
 * (protocols/l2/dhcp-snooping.ts, arp-inspection.ts). Every string is original wording (spec §1.6).
 *
 * W3 (cli part 2, §5.8) — the shows, from the configuration (the eth-switch readers `readDhcpSnooping` and
 * `readArpInspection`, so a show says exactly what step 7b/7c applies) and the `dhcp-snooping` / `arp-inspection` rows
 * (rule 20; absent tables read as empty):
 *   show.ip-dhcp-snooping   `show ip dhcp snooping`: on or off, the VLANs listed, the address check, the binding count
 *                           and the trusted or rate-limited ports; `… binding`: one row per binding (§5.8 shape; the
 *                           lease left in seconds from `expiresAt`, `infinite` for a static binding), then the count
 *   show.ip-arp-inspection  `show ip arp inspection [vlan <list>]`: one row per inspected VLAN or VLAN with counters
 *                           (§5.8 shape: inspection, forwarded, dropped, no binding, filter denied and the trusted ports
 *                           that carry the VLAN); `interfaces`: trust and limit of every switched port; `statistics`:
 *                           the counters alone
 */
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import { ROLE_TRAITS } from '../../contracts/catalog.js';
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { SEC } from '../../contracts/time.js';
import type { ArpInspectionRow, DhcpSnoopingRow, DtpRow } from '../../contracts/tables.js';
import { formatVlanRanges, parseVlanRanges, type VlanRange } from '../../core/vlan-list.js';
import { arpInspectionActive, arpInspectionLimit, arpInspectionPort, readArpInspection } from '../../protocols/l2/arp-inspection.js';
import { readDhcpSnooping, type SnoopingVlanLine } from '../../protocols/l2/dhcp-snooping.js';
import { operOf } from '../../protocols/l2/membership.js';
import { readSwitchport, trunkAllows } from '../../protocols/l2/switchport-config.js';
import { table } from '../format.js';
import { HARDENING_FORM_ARG, HARDENING_HANDLERS, HARDENING_SHOW_ARG } from '../grammar/hardening.js';
import { globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedInterface } from './common.js';

/** @since P3 `show ip arp inspection vlan <list>` naming no VLAN that is inspected or has counters. */
export const MSG_DAI_NO_VLAN = 'None of these VLANs is inspected, and none has counters.';
/** @since P3 `show ip arp inspection` with no VLAN inspected and no counters. */
export const MSG_DAI_NONE = 'ARP inspection runs on no VLAN ("ip arp inspection vlan <list>" turns it on).';

/** `ip dhcp snooping`, `… vlan <list>`, `[no] … verify mac-address`, `[no] … information option`. */
const dhcpSnooping: CommandHandler = (ctx, args, negate) => {
  const form = args[HARDENING_FORM_ARG];
  const head = ['ip', 'dhcp', 'snooping'];
  switch (form) {
    case 'vlan':
      return outcomeOf(ctx.config([...head, 'vlan', args['vlans'] ?? ''], negate, globalContext()));
    case 'verify':
      return outcomeOf(ctx.config([...head, 'verify', 'mac-address'], negate, globalContext()));
    case 'option':
      return outcomeOf(ctx.config([...head, 'information', 'option'], negate, globalContext()));
    default:
      return outcomeOf(ctx.config(head, negate, globalContext()));
  }
};

/** The stored `ip source binding …` lines as tokens (under the `ip` group node, or full-token nodes). */
function storedBindings(ctx: CommandCtx): string[][] {
  const out: string[][] = [];
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0) {
      for (const leaf of c.children) if (leaf.key === 'source' && leaf.args[0] === 'binding') out.push(['ip', leaf.key, ...leaf.args]);
    } else if (c.args[0] === 'source' && c.args[1] === 'binding') {
      out.push(['ip', ...c.args]);
    }
  }
  return out;
}

/** `ip source binding <mac> vlan <v> <ip> interface <if>` / its `no` form. */
const ipSourceBinding: CommandHandler = (ctx, args, negate) => {
  const mac = args['mac'];
  const vlan = args['vlan'];
  const address = args['address'];
  const iface = args['iface'];
  if (mac === undefined || vlan === undefined || address === undefined || iface === undefined) {
    if (negate && mac !== undefined && vlan !== undefined) {
      // `no ip source binding <mac> vlan <v> …`: remove the binding of that host whatever its address and port
      const stored = storedBindings(ctx).find((t) => t[3] === mac && t[5] === vlan);
      return stored === undefined ? {} : outcomeOf(ctx.config(stored, true, globalContext()));
    }
    return { error: '% Expected ip source binding <mac> vlan <vlan> <address> interface <interface>.' };
  }
  return outcomeOf(ctx.config(['ip', 'source', 'binding', mac, 'vlan', vlan, address, 'interface', iface], negate, globalContext()));
};

/** `ip arp inspection vlan <list>` / its `no` form. */
const arpInspection: CommandHandler = (ctx, args, negate) =>
  outcomeOf(ctx.config(['ip', 'arp', 'inspection', 'vlan', args['vlans'] ?? ''], negate, globalContext()));

/** `ip dhcp snooping trust`, `ip dhcp snooping limit rate <pps>` and their `no` forms on a switched port. */
const ifDhcpSnooping: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (args[HARDENING_FORM_ARG] === 'trust') return outcomeOf(ctx.config(['ip', 'dhcp', 'snooping', 'trust'], negate));
  if (negate) return outcomeOf(ctx.config(['ip', 'dhcp', 'snooping', 'limit', 'rate'], true));
  return outcomeOf(ctx.config(['ip', 'dhcp', 'snooping', 'limit', 'rate', args['pps'] ?? ''], false));
};

/** `ip arp inspection trust`, `ip arp inspection limit rate <pps> [burst interval <s>] | none` and their `no` forms. */
const ifArpInspection: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const head = ['ip', 'arp', 'inspection'];
  const form = args[HARDENING_FORM_ARG];
  if (form === 'trust') return outcomeOf(ctx.config([...head, 'trust'], negate));
  if (negate) return outcomeOf(ctx.config([...head, 'limit'], true));
  if (form === 'limit-none') return outcomeOf(ctx.config([...head, 'limit', 'none'], false));
  const seconds = args['seconds'];
  const line = [...head, 'limit', 'rate', args['pps'] ?? ''];
  return outcomeOf(ctx.config(seconds === undefined ? line : [...line, 'burst', 'interval', seconds], false));
};

// ── shows (W3) ───────────────────────────────────────────────────────────────────────────────────────────────

/** Rows of a table this device may not declare (read as empty; the snooping tables are stage-filtered, §2.6). */
function rowsOf<R>(ctx: CommandCtx, name: 'dhcp-snooping' | 'arp-inspection' | 'dtp'): R[] {
  return (ctx.tables.get(name)?.rows() ?? []) as unknown as R[];
}

/** The VLANs named by a set of stored `… vlan <list>` lines, as canonical list text ('' for none). */
function vlanLinesText(lines: readonly SnoopingVlanLine[]): string {
  const ranges: VlanRange[] = [];
  for (const l of lines) ranges.push(...l.ranges);
  return ranges.length === 0 ? '' : formatVlanRanges(ranges);
}

/** Canonical port order of this device. */
function portOrder(ctx: CommandCtx): Map<PortId, number> {
  const out = new Map<PortId, number>();
  let i = 0;
  for (const id of ctx.ports.keys()) out.set(id, i++);
  return out;
}

/** `show ip dhcp snooping`: the state and the ports with snooping lines (canonical port order). */
function snoopingSummary(ctx: CommandCtx): string {
  const cfg = readDhcpSnooping(ctx.running);
  const vlans = vlanLinesText(cfg.vlanLines);
  const rows = rowsOf<DhcpSnoopingRow>(ctx, 'dhcp-snooping');
  const learned = rows.filter((r) => r.kind === 'learned').length;
  const lines = [`DHCP snooping: ${cfg.enabled ? 'on' : 'off'}`];
  lines.push(`  VLANs listed: ${vlans === '' ? 'none' : vlans}${!cfg.enabled && vlans !== '' ? ' (not checked until "ip dhcp snooping" is configured)' : ''}`);
  lines.push(`  Client hardware address check: ${cfg.verifyMac ? 'on' : 'off'}`);
  lines.push(`  Bindings: ${rows.length} (${learned} learned, ${rows.length - learned} static)`);
  const order = portOrder(ctx);
  const ports = [...cfg.ports].sort((a, b) => (order.get(a.port) ?? 1e9) - (order.get(b.port) ?? 1e9));
  if (ports.length === 0) {
    lines.push('  No port is trusted or rate-limited.');
    return lines.join('\n');
  }
  lines.push('');
  const out: string[][] = [['Interface', 'Trusted', 'Rate limit (pps)']];
  for (const port of ports) out.push([port.port, port.trusted ? 'yes' : 'no', port.limitPps === undefined ? 'none' : String(port.limitPps)]);
  lines.push(table(out, { gap: 2 }));
  return lines.join('\n');
}

/** The lease left on a binding, in whole seconds (`infinite` for a static binding). */
function leaseLeft(r: DhcpSnoopingRow, now: number): string {
  if (r.kind === 'static' || r.expiresAt === undefined) return r.leaseS === undefined ? 'infinite' : String(r.leaseS);
  return String(Math.max(0, Math.floor((r.expiresAt - now) / SEC)));
}

/** `show ip dhcp snooping binding` (§5.8 shape). */
function snoopingBindings(ctx: CommandCtx): string {
  const rows = rowsOf<DhcpSnoopingRow>(ctx, 'dhcp-snooping').sort((a, b) => a.vlan - b.vlan || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
  const out: string[][] = [['MAC address', 'IP address', 'Lease (s)', 'Kind', 'VLAN', 'Interface']];
  for (const r of rows) out.push([r.mac, r.ip, leaseLeft(r, ctx.now), r.kind, String(r.vlan), r.port]);
  return `${table(out, { gap: 2, minWidths: [17, 15, 9, 7, 4] })}\n${rows.length} binding${rows.length === 1 ? '' : 's'}`;
}

/** `show ip dhcp snooping [binding]`. */
const showIpDhcpSnooping: CommandHandler = (ctx, args) => ({
  output: args[HARDENING_SHOW_ARG] === 'binding' ? snoopingBindings(ctx) : snoopingSummary(ctx),
});

/** The switched ports of this device (switched role or Port-channel), canonical order. */
function switchedPorts(ctx: CommandCtx): PortView[] {
  const out: PortView[] = [];
  for (const p of ctx.ports.values()) {
    const role = roleOf(ctx, p);
    if ((role === 'switched' || role === 'channel') && ROLE_TRAITS[role].configurable) out.push(p);
  }
  return out;
}

/** True when `port` carries `vlan`: its access VLAN, or a VLAN its trunk allows (the operational mode, as eth-switch). */
function carriesVlan(ctx: CommandCtx, port: PortId, vlan: number, dtp: ReadonlyMap<PortId, DtpRow>): boolean {
  const sp = readSwitchport(ctx.running, port, ctx.model);
  return operOf(sp, dtp.get(port)) === 'trunk' ? trunkAllows(sp, vlan) : sp.accessVlan === vlan;
}

/** `show ip arp inspection [vlan <list> | statistics]`: one row per VLAN. */
function daiVlanTable(ctx: CommandCtx, wanted: VlanRange[] | undefined, statisticsOnly: boolean): string {
  const cfg = readArpInspection(ctx.running);
  const counters = new Map<number, ArpInspectionRow>(rowsOf<ArpInspectionRow>(ctx, 'arp-inspection').map((r) => [r.vlan, r]));
  const vlans = new Set<number>(counters.keys());
  for (const l of cfg.vlanLines) for (const [lo, hi] of l.ranges) for (let v = lo; v <= hi; v++) vlans.add(v);
  const inWanted = (v: number): boolean => wanted === undefined || wanted.some(([lo, hi]) => v >= lo && v <= hi);
  const list = [...vlans].filter(inWanted).sort((a, b) => a - b);
  if (list.length === 0) return wanted === undefined ? MSG_DAI_NONE : MSG_DAI_NO_VLAN;
  const dtp = new Map<PortId, DtpRow>(rowsOf<DtpRow>(ctx, 'dtp').map((r) => [r.port, r]));
  const trusted = switchedPorts(ctx).filter((p) => arpInspectionPort(cfg, p.id).trusted);
  const out: string[][] = [
    statisticsOnly
      ? ['VLAN', 'Forwarded', 'Dropped', 'No binding', 'Filter denied']
      : ['VLAN', 'Inspection', 'Forwarded', 'Dropped', 'No binding', 'Filter denied', 'Trusted ports'],
  ];
  for (const v of list) {
    const c = counters.get(v);
    const nums = [String(c?.forwarded ?? 0), String(c?.dropped ?? 0), String(c?.droppedNoBinding ?? 0), String(c?.droppedAcl ?? 0)];
    if (statisticsOnly) {
      out.push([String(v), ...nums]);
      continue;
    }
    const ports = trusted.filter((p) => carriesVlan(ctx, p.id, v, dtp)).map((p) => p.id);
    out.push([String(v), arpInspectionActive(cfg, v) ? 'on' : 'off', ...nums, ports.length === 0 ? 'none' : ports.join(', ')]);
  }
  return table(out, { gap: 2 });
}

/** `show ip arp inspection interfaces`: trust and limit of every switched port. */
function daiInterfaces(ctx: CommandCtx): string {
  const cfg = readArpInspection(ctx.running);
  const ports = switchedPorts(ctx);
  if (ports.length === 0) return 'This device has no switched port.';
  const out: string[][] = [['Interface', 'Trust', 'Rate (pps)', 'Burst (s)']];
  for (const p of ports) {
    const limit = arpInspectionLimit(cfg, p.id);
    out.push([p.id, arpInspectionPort(cfg, p.id).trusted ? 'trusted' : 'untrusted', limit === undefined ? 'none' : String(limit.pps), limit === undefined ? '-' : String(limit.burstS)]);
  }
  return table(out, { gap: 2 });
}

/** `show ip arp inspection [vlan <list> | interfaces | statistics]`. */
const showIpArpInspection: CommandHandler = (ctx, args) => {
  const view = args[HARDENING_SHOW_ARG];
  if (view === 'interfaces') return { output: daiInterfaces(ctx) };
  if (view === 'vlan') {
    const ranges = parseVlanRanges(args['vlans'] ?? '');
    if (ranges === undefined || ranges.length === 0) return { error: '% Give the VLANs as a list such as 10,20,30-35.' };
    return { output: daiVlanTable(ctx, ranges, false) };
  }
  return { output: daiVlanTable(ctx, undefined, view === 'statistics') };
};

/** @since P3 Registry fragment: the access-layer hardening lines (`HARDENING_HANDLERS` ids). */
export const hardeningHandlers: Readonly<Record<string, CommandHandler>> = {
  [HARDENING_HANDLERS.configDhcpSnooping]: dhcpSnooping,
  [HARDENING_HANDLERS.configIpSourceBinding]: ipSourceBinding,
  [HARDENING_HANDLERS.configArpInspection]: arpInspection,
  [HARDENING_HANDLERS.ifDhcpSnooping]: ifDhcpSnooping,
  [HARDENING_HANDLERS.ifArpInspection]: ifArpInspection,
  // W3 cli part 2
  [HARDENING_HANDLERS.showIpDhcpSnooping]: showIpDhcpSnooping,
  [HARDENING_HANDLERS.showIpArpInspection]: showIpArpInspection,
};
