/**
 * cli/grammar/hardening.ts and cli/handlers/hardening.ts (ARCHITECTURE-P3 §5.3, D13; §7 W2 cli part 1, "every
 * §5.1–§5.6 configuration line"): DHCP snooping and dynamic ARP inspection on managed switches — the global lines (the
 * VLAN lists canonicalised, `no … verify mac-address` and `no … information option` as stored negations, static
 * bindings), the interface lines on switched ports only, and the two `errdisable recovery cause` choices appended
 * before `all` (§9.2 W2 item 24).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { ERRDISABLE_RECOVERY_CAUSES, GRAMMAR, HANDLERS, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const SWITCH = catalogModel('switch.nfc2960');
const ROUTER = catalogModel('router.nf2911');
const FA1 = 'FastEthernet0/1';

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);

function typed(rec: RecordingCtx, mode: Parameters<typeof matchContextFor>[1], line: string, iface?: string): CommandOutcome {
  const m = ok(matchContextFor(rec.ctx.model, mode, iface === undefined ? {} : { iface }), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

describe('parsing and scope', () => {
  it('parses every §5.3 line on a managed switch', () => {
    const cfg = matchContextFor(SWITCH, 'config');
    expect(ok(cfg, 'ip dhcp snooping')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configDhcpSnooping }, args: { form: 'on' } });
    expect(ok(cfg, 'ip dhcp snooping vlan 30-35,10,20')).toMatchObject({ ok: true, args: { form: 'vlan', vlans: '10,20,30-35' } });
    expect(ok(cfg, 'no ip dhcp snooping verify mac-address')).toMatchObject({ ok: true, negated: true, args: { form: 'verify' } });
    expect(ok(cfg, 'no ip dhcp snooping information option')).toMatchObject({ ok: true, negated: true, args: { form: 'option' } });
    expect(ok(cfg, 'ip source binding 0050.7966.6800 vlan 10 192.168.10.11 interface fa0/1')).toMatchObject({
      ok: true, spec: { handler: HANDLERS.configIpSourceBinding }, args: { mac: '00:50:79:66:68:00', vlan: '10', address: '192.168.10.11', iface: FA1 },
    });
    expect(ok(cfg, 'ip arp inspection vlan 10')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configArpInspection }, args: { vlans: '10' } });
    const ifc = matchContextFor(SWITCH, 'config-if', { iface: FA1 });
    expect(ok(ifc, 'ip dhcp snooping trust')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifDhcpSnooping }, args: { form: 'trust' } });
    expect(ok(ifc, 'ip dhcp snooping limit rate 15')).toMatchObject({ ok: true, args: { form: 'limit', pps: '15' } });
    expect(ok(ifc, 'ip arp inspection trust')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifArpInspection }, args: { form: 'trust' } });
    expect(ok(ifc, 'ip arp inspection limit rate 20')).toMatchObject({ ok: true, args: { form: 'limit', pps: '20' } });
    expect(ok(ifc, 'ip arp inspection limit rate 20 burst interval 2')).toMatchObject({ ok: true, args: { pps: '20', seconds: '2' } });
    expect(ok(ifc, 'ip arp inspection limit none')).toMatchObject({ ok: true, args: { form: 'limit-none' } });
    expect(ok(matchContextFor(SWITCH, 'config-if', { iface: 'Vlan1' }), 'ip dhcp snooping trust')).toMatchObject({ ok: false, kind: 'port-unsupported' });
    expect(ok(matchContextFor(ROUTER, 'config'), 'ip dhcp snooping').ok).toBe(false);
    expect(ok(matchContextFor(SWITCH, 'config'), 'errdisable recovery cause dhcp-rate-limit')).toMatchObject({ ok: true, args: { cause: 'dhcp-rate-limit' } });
    expect(ok(matchContextFor(SWITCH, 'config'), 'errdisable recovery cause arp-inspection')).toMatchObject({ ok: true, args: { cause: 'arp-inspection' } });
  });

  it('appends the two causes before all (§9.2 W2 item 24)', () => {
    expect(ERRDISABLE_RECOVERY_CAUSES).toEqual(['psecure-violation', 'bpduguard', 'channel-misconfig', 'dhcp-rate-limit', 'arp-inspection', 'all']);
    const r = commandCtxFor(SWITCH, { mode: 'config' });
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'arp-inspection' })).toEqual({});
    expect(r.running.render()).toContain('errdisable recovery cause arp-inspection\n');
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'storm' })).toEqual({
      error: '% Give the cause: psecure-violation, bpduguard, channel-misconfig, dhcp-rate-limit, arp-inspection, all.',
    });
  });
});

describe('storage', () => {
  it('global lines: snooping, its VLANs, the stored negations and static bindings', () => {
    const r = commandCtxFor(SWITCH, { mode: 'config' });
    for (const l of [
      'ip dhcp snooping',
      'ip dhcp snooping vlan 10,20',
      'no ip dhcp snooping verify mac-address',
      'no ip dhcp snooping information option',
      'ip source binding 0050.7966.6800 vlan 10 192.168.10.11 interface fa0/1',
      'ip arp inspection vlan 10',
    ]) expect(typed(r, 'config', l), l).toEqual({});
    const text = r.running.render();
    for (const l of [
      'ip dhcp snooping',
      // the VLAN list is stored one line per VLAN (the config rules' <vlan-list> element)
      'ip dhcp snooping vlan 10',
      'ip dhcp snooping vlan 20',
      'no ip dhcp snooping verify mac-address',
      'no ip dhcp snooping information option',
      `ip source binding 00:50:79:66:68:00 vlan 10 192.168.10.11 interface ${FA1}`,
      'ip arp inspection vlan 10',
    ]) expect(text, l).toContain(`\n${l}\n`);
    // the positive forms of the stored negations store nothing
    typed(r, 'config', 'ip dhcp snooping verify mac-address');
    typed(r, 'config', 'ip dhcp snooping information option');
    expect(r.running.render()).not.toMatch(/verify mac-address|information option/);
    // a binding is removed by its MAC and VLAN
    expect(run(r, HANDLERS.configIpSourceBinding, { mac: '00:50:79:66:68:00', vlan: '10' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('ip source binding');
    for (const l of ['no ip dhcp snooping vlan 10,20', 'no ip arp inspection vlan 10', 'no ip dhcp snooping']) expect(typed(r, 'config', l), l).toEqual({});
    expect(r.running.render()).not.toMatch(/snooping|inspection/);
  });

  it('interface lines on a switched port: trust and the limits (one slot each)', () => {
    const r = commandCtxFor(SWITCH, { iface: FA1 });
    for (const l of ['ip dhcp snooping trust', 'ip dhcp snooping limit rate 15', 'ip arp inspection trust', 'ip arp inspection limit rate 20 burst interval 2']) {
      expect(typed(r, 'config-if', l, FA1), l).toEqual({});
    }
    const block = (): string => r.running.render().split(`interface ${FA1}\n`)[1]!.split('!')[0]!;
    expect(block()).toContain(' ip dhcp snooping trust\n');
    expect(block()).toContain(' ip dhcp snooping limit rate 15\n');
    expect(block()).toContain(' ip arp inspection trust\n');
    expect(block()).toContain(' ip arp inspection limit rate 20 burst interval 2\n');
    typed(r, 'config-if', 'ip arp inspection limit none', FA1);
    expect(block()).toContain(' ip arp inspection limit none\n');
    expect(block()).not.toContain('burst');
    for (const l of ['no ip dhcp snooping trust', 'no ip dhcp snooping limit rate', 'no ip arp inspection trust', 'no ip arp inspection limit rate']) {
      expect(typed(r, 'config-if', l, FA1), l).toEqual({});
    }
    expect(r.running.render()).not.toMatch(/snooping|inspection/);
  });
});
