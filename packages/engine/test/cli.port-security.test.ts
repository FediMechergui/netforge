/**
 * cli/grammar/{port-security,errdisable}.ts and their handlers (ARCHITECTURE-P2 §3.8, §5.1, §5.4, D12; §7 W3 cli):
 * the `switchport port-security …` lines (fixed mode first, canonical addresses, sticky forms), `show port-security
 * [interface <if> | address]` against a fake `port-security` table and secure CAM rows, and the err-disable recovery
 * lines with `show errdisable recovery`.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { PortSecurityRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_NO_ERR_DISABLED_PORT } from '../src/cli/handlers/errdisable.js';
import { MSG_NO_SECURE_ADDRESS, MSG_NO_SECURED_PORT, MSG_PORT_NOT_SECURED } from '../src/cli/handlers/port-security.js';
import { matchCommand } from '../src/cli/parser.js';
import { readPortSecurity } from '../src/protocols/l2/port-security.js';
import { commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const SW = p2Model('switch.nfc2960');
const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const MAC = '00:11:22:33:44:55';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function sw(opts: CommandCtxOptions = { iface: FA1 }): RecordingCtx {
  return commandCtxFor(SW, opts);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as Table<TableRow>);
  return t;
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('parsing', () => {
  it('parses every port-security and errdisable line, normalising the MAC forms', () => {
    const ifc = matchContextFor(SW, 'config-if', { iface: FA1 });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifPortSecurity } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security maximum 3')).toMatchObject({ ok: true, args: { count: '3' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security violation restrict')).toMatchObject({ ok: true, args: { mode: 'restrict' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security mac-address 0011.2233.4455')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifPortSecurityMacAddress }, args: { mac: MAC } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security mac-address sticky')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifPortSecuritySticky }, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'switchport port-security mac-address sticky 00:11:22:33:44:55')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifPortSecuritySticky }, args: { mac: MAC } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'no switchport port-security maximum')).toMatchObject({ ok: true, negated: true });
    const cfg = matchContextFor(SW, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'errdisable recovery cause psecure-violation')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configErrdisableRecoveryCause }, args: { cause: 'psecure-violation' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'errdisable recovery cause all')).toMatchObject({ ok: true, args: { cause: 'all' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'errdisable recovery interval 30')).toMatchObject({ ok: true, args: { seconds: '30' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'errdisable recovery interval 10').ok).toBe(false);
    const exec = matchContextFor(SW, 'user-exec');
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show port-security')).toMatchObject({ ok: true, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show port-security interface fa0/1')).toMatchObject({ ok: true, args: { form: 'interface', iface: FA1 } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show port-security address')).toMatchObject({ ok: true, args: { form: 'address' } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show errdisable recovery')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showErrdisableRecovery } });
    // [S5] is not built
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW, 'priv-exec'), 'clear errdisable interface fa0/1').ok).toBe(false);
  });
});

describe('switchport port-security lines', () => {
  it('needs a fixed mode to enable, then stores every setting as typed and removes them with no', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.ifPortSecurity).error).toBe(CLI_MESSAGES.securityNeedsStaticMode);
    expect(r.configCalls).toEqual([]);
    r.running.set([['interface', FA1]], ['switchport', 'mode', 'access']);
    expect(run(r, P2_HANDLERS.ifPortSecurity)).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecurityMaximum, { count: '2' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecurityViolation, { mode: 'restrict' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecurityMacAddress, { mac: MAC })).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecuritySticky)).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecuritySticky, { mac: '00:11:22:33:44:66' })).toEqual({});
    const cfg = readPortSecurity(r.running, FA1);
    expect(cfg).toEqual({ max: 2, violation: 'restrict', sticky: true, configured: [MAC], stickyMacs: ['00:11:22:33:44:66'] });
    expect(run(r, P2_HANDLERS.ifPortSecurityMaximum, { count: '0' }).error).toContain('at least 1');
    expect(run(r, P2_HANDLERS.ifPortSecurityViolation, { mode: 'ignore' }).error).toContain('violation mode');
    expect(run(r, P2_HANDLERS.ifPortSecurityMacAddress, { mac: MAC }, true)).toEqual({});
    expect(run(r, P2_HANDLERS.ifPortSecurityMaximum, {}, true)).toEqual({});
    expect(readPortSecurity(r.running, FA1)).toEqual({ max: 1, violation: 'restrict', sticky: true, configured: [], stickyMacs: ['00:11:22:33:44:66'] });
    // disabling keeps the settings for a later re-enable
    expect(run(r, P2_HANDLERS.ifPortSecurity, {}, true)).toEqual({});
    expect(readPortSecurity(r.running, FA1)).toBeUndefined();
    expect(r.running.render()).toContain(' switchport port-security violation restrict');
    expect(run(r, P2_HANDLERS.ifPortSecurity)).toEqual({});
    expect(readPortSecurity(r.running, FA1)?.violation).toBe('restrict');
  });

  it('accepts trunk mode, and refuses every line on a port that is not switched', () => {
    const trunk = sw();
    trunk.running.set([['interface', FA1]], ['switchport', 'mode', 'trunk']);
    expect(run(trunk, P2_HANDLERS.ifPortSecurity)).toEqual({});
    const ports = devicePortViews(SW, { patch: { [FA2]: { role: 'routed' } } });
    const r = commandCtxFor(SW, { iface: FA2, ports });
    const expected = CLI_MESSAGES.notSwitchport.replace('{port}', FA2);
    for (const id of [P2_HANDLERS.ifPortSecurity, P2_HANDLERS.ifPortSecurityMaximum, P2_HANDLERS.ifPortSecurityViolation, P2_HANDLERS.ifPortSecurityMacAddress, P2_HANDLERS.ifPortSecuritySticky]) {
      expect(run(r, id, { count: '1', mode: 'protect', mac: MAC }).error, id).toBe(expected);
    }
    expect(r.configCalls).toEqual([]);
  });
});

describe('show port-security', () => {
  function secured(): RecordingCtx {
    const ports = devicePortViews(SW, { patch: { [FA1]: { operUp: true }, [FA2]: { errDisabled: 'psecure-violation' } } });
    const r = commandCtxFor(SW, { ports });
    for (const p of [FA1, FA2]) {
      r.running.set([['interface', p]], ['switchport', 'mode', 'access']);
      r.running.set([['interface', p]], ['switchport', 'port-security']);
    }
    r.running.set([['interface', FA1]], ['switchport', 'port-security', 'maximum', '2']);
    r.running.set([['interface', FA1]], ['switchport', 'port-security', 'mac-address', 'sticky']);
    r.running.set([['interface', FA1]], ['switchport', 'port-security', 'mac-address', 'sticky', MAC]);
    return r;
  }

  it('lists the secured ports from the config alone, then from the rows the daemon writes', () => {
    expect(run(sw(), P2_HANDLERS.showPortSecurity)).toEqual({ output: MSG_NO_SECURED_PORT });
    const r = secured();
    const out = lines(run(r, P2_HANDLERS.showPortSecurity).output);
    expect(out[0]).toMatch(/^Port\s+Maximum\s+In use\s+Violation mode\s+Violations\s+Status$/);
    expect(out[1]).toMatch(/^FastEthernet0\/1\s+2\s+1\s+shutdown\s+0\s+secure-up$/);
    expect(out[2]).toMatch(/^FastEthernet0\/2\s+1\s+0\s+shutdown\s+0\s+secure-shutdown$/);
    expect(out[4]).toBe('Secure addresses in use: 1');
    const t = attach<PortSecurityRow>(r, 'port-security');
    t.set({ key: FA2, updatedAt: 0, port: FA2, max: 1, count: 1, violation: 'shutdown', sticky: false, violations: 3, status: 'secure-shutdown', lastViolationMac: '00:11:22:33:44:99' });
    const after = lines(run(r, P2_HANDLERS.showPortSecurity).output);
    expect(after[2]).toMatch(/^FastEthernet0\/2\s+1\s+1\s+shutdown\s+3\s+secure-shutdown$/);
    expect(after[4]).toBe('Secure addresses in use: 2');
    const block = lines(run(r, P2_HANDLERS.showPortSecurity, { form: 'interface', iface: 'fa0/2' }).output);
    expect(block).toEqual([
      FA2,
      '  Port security: enabled',
      '  Status: secure-shutdown',
      '  Violation mode: shutdown',
      '  Maximum addresses: 1',
      '  Secure addresses: 1',
      '  Sticky learning: off',
      '  Configured addresses: none',
      '  Sticky addresses: none',
      '  Violations: 3',
      '  Last violating address: 00:11:22:33:44:99',
    ]);
    expect(lines(run(r, P2_HANDLERS.showPortSecurity, { form: 'interface', iface: FA1 }).output)[8]).toBe(`  Sticky addresses: ${MAC}`);
    expect(run(r, P2_HANDLERS.showPortSecurity, { form: 'interface', iface: 'FastEthernet0/3' }).output).toBe(MSG_PORT_NOT_SECURED.replace('{port}', 'FastEthernet0/3'));
    expect(run(r, P2_HANDLERS.showPortSecurity, { form: 'interface', iface: 'nope' }).error).toContain('nope');
  });

  it('address lists the secure CAM rows only', () => {
    const r = secured();
    expect(run(r, P2_HANDLERS.showPortSecurity, { form: 'address' })).toEqual({ output: MSG_NO_SECURE_ADDRESS });
    r.ctx.tables.cam.set({ key: `1/${MAC}`, updatedAt: 0, mac: MAC, vlan: 1, port: FA1, type: 'static', secure: 'sticky' });
    r.ctx.tables.cam.set({ key: '1/00:11:22:33:44:77', updatedAt: 0, mac: '00:11:22:33:44:77', vlan: 1, port: FA2, type: 'dynamic' });
    r.ctx.tables.cam.set({ key: '10/00:11:22:33:44:88', updatedAt: 0, mac: '00:11:22:33:44:88', vlan: 10, port: FA2, type: 'static', secure: 'configured' });
    const out = lines(run(r, P2_HANDLERS.showPortSecurity, { form: 'address' }).output);
    expect(out[0]).toMatch(/^\s*VLAN\s+Address\s+Kind\s+Port$/);
    expect(out[1]).toMatch(new RegExp(`^\\s*1\\s+${MAC}\\s+sticky\\s+FastEthernet0/1$`));
    expect(out[2]).toMatch(/^\s*10\s+00:11:22:33:44:88\s+configured\s+FastEthernet0\/2$/);
    expect(out).toHaveLength(3);
  });
});

describe('errdisable recovery', () => {
  it('stores one cause line per cause and the interval, validates them, and renders show errdisable recovery', () => {
    const r = sw({});
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'psecure-violation' })).toEqual({});
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'bpduguard' })).toEqual({});
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'link-flap' }).error).toContain('cause');
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryInterval, { seconds: '30' })).toEqual({});
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryInterval, { seconds: '10' }).error).toContain('between 30 and 86400');
    const text = r.running.render();
    expect(text).toContain('errdisable recovery cause psecure-violation\nerrdisable recovery cause bpduguard\nerrdisable recovery interval 30');
    const out = lines(run(r, P2_HANDLERS.showErrdisableRecovery).output);
    expect(out[0]).toMatch(/^Cause\s+Automatic recovery$/);
    expect(out[1]).toMatch(/^psecure-violation\s+on$/);
    expect(out[2]).toMatch(/^bpduguard\s+on$/);
    expect(out[3]).toMatch(/^channel-misconfig\s+off$/);
    expect(out[5]).toBe('Recovery interval: 30 s');
    expect(out[7]).toBe(MSG_NO_ERR_DISABLED_PORT);
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryCause, { cause: 'bpduguard' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('cause bpduguard');
    expect(r.running.render()).toContain('cause psecure-violation');
    expect(run(r, P2_HANDLERS.configErrdisableRecoveryInterval, {}, true)).toEqual({});
    expect(lines(run(r, P2_HANDLERS.showErrdisableRecovery).output)[5]).toBe('Recovery interval: 300 s');
  });

  it('lists the error-disabled ports with their cause and whether they come back by themselves', () => {
    const ports = devicePortViews(SW, { patch: { [FA1]: { errDisabled: 'psecure-violation' }, [FA2]: { errDisabled: 'bpduguard' } } });
    const r = commandCtxFor(SW, { ports });
    r.running.set([], ['errdisable', 'recovery', 'cause', 'psecure-violation']);
    const out = lines(run(r, P2_HANDLERS.showErrdisableRecovery).output);
    expect(out[7]).toMatch(/^Port\s+Cause\s+Comes back$/);
    expect(out[8]).toMatch(/^FastEthernet0\/1\s+port security violation\s+by itself, within 300 s$/);
    expect(out[9]).toMatch(/^FastEthernet0\/2\s+BPDU guard\s+after shutdown \/ no shutdown$/);
    r.running.set([], ['errdisable', 'recovery', 'cause', 'all']);
    expect(lines(run(r, P2_HANDLERS.showErrdisableRecovery).output)[9]).toMatch(/by itself, within 300 s$/);
  });
});
