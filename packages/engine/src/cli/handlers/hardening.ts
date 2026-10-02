/**
 * cli/handlers/hardening.ts — DHCP snooping and dynamic ARP inspection lines (ARCHITECTURE-P3 §5.3, D13; §7 W2 cli
 * part 1).
 *
 * Every line is stored as the config rules say (cli/config-rules.ts, W1): `ip dhcp snooping vlan <list>` and `ip arp
 * inspection vlan <list>` one line per VLAN, `verify mac-address` and `information option` as stored negations (their
 * positive form is the default and stores nothing), the interface limits as single slots. eth-switch reads them
 * (protocols/l2/dhcp-snooping.ts, arp-inspection.ts). Every string is original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { HARDENING_FORM_ARG, HARDENING_HANDLERS } from '../grammar/hardening.js';
import { globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

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

/** @since P3 Registry fragment: the access-layer hardening lines (`HARDENING_HANDLERS` ids). */
export const hardeningHandlers: Readonly<Record<string, CommandHandler>> = {
  [HARDENING_HANDLERS.configDhcpSnooping]: dhcpSnooping,
  [HARDENING_HANDLERS.configIpSourceBinding]: ipSourceBinding,
  [HARDENING_HANDLERS.configArpInspection]: arpInspection,
  [HARDENING_HANDLERS.ifDhcpSnooping]: ifDhcpSnooping,
  [HARDENING_HANDLERS.ifArpInspection]: ifArpInspection,
};
