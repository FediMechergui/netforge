/**
 * [SHOULD S2] cli/grammar/hsrp.ts and cli/handlers/hsrp.ts (ARCHITECTURE-P2 §3.10, §5.2, §5.4; §7 W3 cli [S2]): the
 * `standby …` lines with the group-range and timer checks, and `show standby [brief]` against a fake `hsrp` table.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { HsrpRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { hsrpGroupsOf, hsrpTimersOf, hsrpVersionOf, MSG_HSRP_GROUP_RANGE, MSG_HSRP_TIMERS, MSG_HSRP_VERSION_DOWNGRADE, MSG_NO_STANDBY } from '../src/cli/handlers/hsrp.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const ROUTER = p2Model('router.nf2911');
const GI0 = 'GigabitEthernet0/0';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function router(opts: CommandCtxOptions = { iface: GI0 }): RecordingCtx {
  return commandCtxFor(ROUTER, opts);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as Table<TableRow>);
  return t;
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('parsing', () => {
  it('parses the grouped and group-less forms, and offers standby on an addressed interface of a routing device', () => {
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby version 2')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyVersion }, args: { version: '2' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 ip 192.168.1.1')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyIp }, args: { group: '1', address: '192.168.1.1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby ip 192.168.1.1')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyIp }, args: { address: '192.168.1.1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 ip')).toMatchObject({ ok: true, args: { group: '1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 priority 110')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyPriority }, args: { group: '1', priority: '110' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby priority 110')).toMatchObject({ ok: true, args: { priority: '110' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 preempt')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyPreempt }, args: { group: '1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 preempt delay minimum 30')).toMatchObject({ ok: true, args: { group: '1', seconds: '30' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby preempt')).toMatchObject({ ok: true, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 1 timers 1 4')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifStandbyTimers }, args: { group: '1', hello: '1', hold: '4' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'no standby 1 ip')).toMatchObject({ ok: true, negated: true, args: { group: '1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'standby 4096 ip 10.0.0.1').ok).toBe(false);
    expect(help(BUILTIN_GRAMMAR, ifc, 'standby ').items.map((i) => i.token)).toEqual(['ip', 'preempt', 'priority', 'timers', 'version', '<0-4095>']);
    const exec = matchContextFor(ROUTER, 'user-exec');
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show standby')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showStandby }, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show standby brief')).toMatchObject({ ok: true, args: { brief: 'brief' } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p2Model('switch.nfc2960'), 'config-if', { iface: 'FastEthernet0/1' }), 'standby 1 ip 10.0.0.1').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('pc.nfpc'), 'user-exec'), 'show standby').ok).toBe(false);
  });
});

describe('standby lines', () => {
  it('stores every line as typed, group-less lines as group 0, and removes them with no', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.ifStandbyVersion, { version: '2' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '1', address: '192.168.1.1' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyPriority, { group: '1', priority: '110' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyPreempt, { group: '1' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyTimers, { group: '1', hello: '1', hold: '4' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyIp, { address: '192.168.1.254' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyPreempt, { seconds: '30' })).toEqual({});
    expect(r.running.render()).toContain(
      `interface ${GI0}\n standby version 2\n standby 1 ip 192.168.1.1\n standby 1 priority 110\n standby 1 preempt\n standby 1 timers 1 4\n standby ip 192.168.1.254\n standby preempt delay minimum 30`,
    );
    expect(hsrpVersionOf(r.ctx, GI0)).toBe(2);
    expect(hsrpGroupsOf(r.ctx, GI0)).toEqual([0, 1]);
    expect(hsrpTimersOf(r.ctx, GI0, 1)).toEqual({ helloS: 1, holdS: 4 });
    expect(hsrpTimersOf(r.ctx, GI0, 0)).toEqual({ helloS: 3, holdS: 10 });
    expect(run(r, P2_HANDLERS.ifStandbyPreempt, { group: '1' }, true)).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyIp, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('standby 1 preempt');
    expect(r.running.render()).not.toContain('standby ip ');
    expect(r.running.render()).toContain('standby 1 ip 192.168.1.1');
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '1', address: 'x' }).error).toContain('virtual address');
    expect(run(commandCtxFor(ROUTER), P2_HANDLERS.ifStandbyIp, { group: '1', address: '10.0.0.1' }).error).toContain('interface');
  });

  it('checks the group range against the version, refuses a downgrade with a high group, and checks the timers', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '300', address: '10.0.0.1' }).error).toBe(MSG_HSRP_GROUP_RANGE.replace('{version}', '1').replace('{max}', '255'));
    expect(run(r, P2_HANDLERS.ifStandbyVersion, { version: '2' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '300', address: '10.0.0.1' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '4096', address: '10.0.0.1' }).error).toBe(MSG_HSRP_GROUP_RANGE.replace('{version}', '2').replace('{max}', '4095'));
    expect(run(r, P2_HANDLERS.ifStandbyVersion, { version: '1' }).error).toBe(MSG_HSRP_VERSION_DOWNGRADE.replace('{group}', '300'));
    expect(run(r, P2_HANDLERS.ifStandbyIp, { group: '300' }, true)).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyVersion, { version: '1' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyTimers, { group: '1', hello: '4', hold: '4' }).error).toBe(MSG_HSRP_TIMERS);
    expect(run(r, P2_HANDLERS.ifStandbyTimers, { group: '1', hello: '3', hold: '10' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStandbyPriority, { group: '1', priority: '256' }).error).toContain('0 and 255');
  });
});

describe('show standby', () => {
  function running(): RecordingCtx {
    const r = router({});
    r.running.set([['interface', GI0]], ['standby', '1', 'timers', '1', '4']);
    const t = attach<HsrpRow>(r, 'hsrp');
    t.set({ key: `${GI0}|1`, updatedAt: 0, iface: GI0, group: 1, version: 2, state: 'active', priority: 110, preempt: true, virtualIp: '192.168.1.1', virtualMac: '00:00:0c:9f:f0:01', active: 'local', standby: '192.168.1.3' });
    t.set({ key: `${GI0}|0`, updatedAt: 0, iface: GI0, group: 0, version: 1, state: 'listen', priority: 100, preempt: false, virtualMac: '00:00:0c:07:ac:00' });
    return r;
  }

  it('renders each group in full, sorted by interface and group, and one line per group in brief', () => {
    expect(run(router({}), P2_HANDLERS.showStandby)).toEqual({ output: MSG_NO_STANDBY });
    const r = running();
    expect(lines(run(r, P2_HANDLERS.showStandby).output)).toEqual([
      `${GI0} group 0 (version 1)`,
      '  State: listen',
      '  Virtual address: none yet   Virtual MAC: 00:00:0c:07:ac:00',
      '  Priority: 100   Preempt: no',
      '  Timers: hello 3 s, hold 10 s',
      '  Active router: unknown   Standby router: unknown',
      '',
      `${GI0} group 1 (version 2)`,
      '  State: active',
      '  Virtual address: 192.168.1.1   Virtual MAC: 00:00:0c:9f:f0:01',
      '  Priority: 110   Preempt: yes',
      '  Timers: hello 1 s, hold 4 s',
      '  Active router: this router   Standby router: 192.168.1.3',
    ]);
    const brief = lines(run(r, P2_HANDLERS.showStandby, { brief: 'brief' }).output);
    expect(brief[0]).toMatch(/^Interface\s+Group\s+Priority\s+Preempt\s+State\s+Active\s+Standby\s+Virtual address$/);
    expect(brief[1]).toMatch(/^GigabitEthernet0\/0\s+0\s+100\s+no\s+listen\s+unknown\s+unknown\s+-$/);
    expect(brief[2]).toMatch(/^GigabitEthernet0\/0\s+1\s+110\s+yes\s+active\s+this router\s+192\.168\.1\.3\s+192\.168\.1\.1$/);
  });
});
