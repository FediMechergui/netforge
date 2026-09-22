/**
 * [SHOULD S9] cli/grammar/nat.ts and cli/handlers/nat.ts (ARCHITECTURE-P2 §3.9 step 5, §5.2; §7 W3 cli [S9]): the
 * static port-forward forms `ip nat inside source static tcp|udp <il> <lp> <ig>|interface <if> <gp>` and the
 * `ip nat translation timeout|udp-timeout|tcp-timeout|icmp-timeout <s>` lines, with their `no` forms and the
 * statistics line that shows them.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_STATIC_SAME } from '../src/cli/handlers/nat.js';
import { matchCommand } from '../src/cli/parser.js';
import { commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const ROUTER = p2Model('router.nf2911');
const GI1 = 'GigabitEthernet0/1';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('[S9] port forwarding', () => {
  it('parses both static port forms and the timeout lines', () => {
    const cfg = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static tcp 192.168.1.10 80 203.0.113.5 8080'))
      .toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpNatStaticPort }, args: { via: 'address', proto: 'tcp', local: '192.168.1.10', lport: '80', global: '203.0.113.5', gport: '8080' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static udp 192.168.1.10 53 interface gi0/1 5353'))
      .toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpNatStaticPort }, args: { via: 'interface', proto: 'udp', lport: '53', iface: GI1, gport: '5353' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static sctp 192.168.1.10 80 203.0.113.5 8080').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static tcp 192.168.1.10 0 203.0.113.5 8080').ok).toBe(false);
    for (const which of ['timeout', 'udp-timeout', 'tcp-timeout', 'icmp-timeout']) {
      expect(matchCommand(BUILTIN_GRAMMAR, cfg, `ip nat translation ${which} 120`), which).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpNatTimeout }, args: { which, seconds: '120' } });
    }
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'no ip nat translation udp-timeout')).toMatchObject({ ok: true, negated: true, args: { which: 'udp-timeout' } });
    // the plain static line still parses to its own handler
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static 192.168.1.10 203.0.113.5')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpNatStatic } });
  });

  it('stores the port forwards with the canonical interface name and removes them with the full no line', () => {
    const r = commandCtxFor(ROUTER);
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'address', proto: 'tcp', local: '192.168.1.10', lport: '80', global: '203.0.113.5', gport: '8080' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'interface', proto: 'udp', local: '192.168.1.10', lport: '53', iface: 'gi0/1', gport: '5353' })).toEqual({});
    expect(r.running.render()).toContain(`ip nat inside source static tcp 192.168.1.10 80 203.0.113.5 8080\nip nat inside source static udp 192.168.1.10 53 interface ${GI1} 5353`);
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'address', proto: 'tcp', local: '192.168.1.10', lport: '80', global: '192.168.1.10', gport: '80' }).error).toBe(MSG_STATIC_SAME);
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'address', proto: 'tcp', local: '192.168.1.10', lport: '70000', global: '203.0.113.5', gport: '80' }).error).toContain('65535');
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'interface', proto: 'udp', local: '192.168.1.10', lport: '53', iface: 'nope', gport: '5353' }).error).toContain('nope');
    expect(run(r, P2_HANDLERS.configIpNatStaticPort, { via: 'address', proto: 'tcp', local: '192.168.1.10', lport: '80', global: '203.0.113.5', gport: '8080' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('tcp 192.168.1.10 80');
    expect(r.running.render()).toContain(`udp 192.168.1.10 53 interface ${GI1} 5353`);
  });

  it('stores each timeout in its own slot, removes it with no, and statistics lists them', () => {
    const r = commandCtxFor(ROUTER);
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'timeout', seconds: '3600' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'icmp-timeout', seconds: '30' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'icmp-timeout', seconds: '45' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'sctp-timeout', seconds: '45' }).error).toContain('timer');
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'timeout', seconds: '0' }).error).toContain('at least 1');
    expect(r.running.render()).toContain('ip nat translation timeout 3600\nip nat translation icmp-timeout 45');
    expect(r.running.render()).not.toContain('icmp-timeout 30');
    expect(lines(run(r, P2_HANDLERS.showIpNatStatistics).output).at(-1)).toBe('Timeouts: timeout 3600 s, icmp-timeout 45 s');
    expect(run(r, P2_HANDLERS.configIpNatTimeout, { which: 'timeout' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('translation timeout');
    expect(r.running.render()).toContain('icmp-timeout 45');
  });
});
