/**
 * The P2 switchport lines and switching show commands (ARCHITECTURE-P2 §3.1, §3.2, §5.1, §5.4, D3; §7 W2 cli):
 * mode, access VLAN with auto-creation, native VLAN, allowed-list resolution to the stored canonical list,
 * nonegotiate, `show interfaces trunk`, `show interfaces [<if>] switchport`, and the P2 forms of the P1 show commands
 * (`show interfaces status err-disabled`, `show mac address-table` filters and count).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { DtpRow, StpBridgeRow, StpPortRow, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, HANDLERS, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_NO_ERR_DISABLED } from '../src/cli/handlers/show.js';
import { MSG_DYNAMIC_WITH_NONEGOTIATE, MSG_NO_SUCH_PORT, MSG_NO_TRUNK, resolveAllowedVlans } from '../src/cli/handlers/switchport.js';
import { matchCommand } from '../src/cli/parser.js';
import { readSwitchport } from '../src/protocols/l2/switchport-config.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const SW = p2Model('switch.nfc2960');
const MLS = p2Model('mlswitch.nfc3650-24');
const FA1 = 'FastEthernet0/1';
const GI1 = 'GigabitEthernet0/1';

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

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('switchport mode', () => {
  it('stores the four modes and removes the line with no', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { mode: 'access' })).toEqual({});
    expect(readSwitchport(r.running, FA1).mode).toBe('access');
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { mode: 'trunk' })).toEqual({});
    expect(readSwitchport(r.running, FA1).mode).toBe('trunk');
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { wish: 'desirable' })).toEqual({});
    expect(readSwitchport(r.running, FA1).mode).toBe('dynamic-desirable');
    expect(r.running.render()).toContain(' switchport mode dynamic desirable');
    expect(run(r, P2_HANDLERS.ifSwitchportMode, {}, true)).toEqual({});
    expect(readSwitchport(r.running, FA1).mode).toBe('dynamic-auto');
    expect(r.configCalls.map((c) => c.line)).toEqual([
      ['switchport', 'mode', 'access'],
      ['switchport', 'mode', 'trunk'],
      ['switchport', 'mode', 'dynamic', 'desirable'],
      ['switchport', 'mode'],
    ]);
  });

  it('refuses every switchport line on a port that is not switched', () => {
    const ports = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const r = commandCtxFor(MLS, { iface: 'GigabitEthernet1/0/24', ports });
    const expected = CLI_MESSAGES.notSwitchport.replace('{port}', 'GigabitEthernet1/0/24');
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { mode: 'access' }).error).toBe(expected);
    expect(run(r, P2_HANDLERS.ifSwitchportAccessVlan, { vlan: '10' }).error).toBe(expected);
    expect(run(r, P2_HANDLERS.ifSwitchportTrunkNative, { vlan: '99' }).error).toBe(expected);
    expect(run(r, P2_HANDLERS.ifSwitchportTrunkAllowed, { vlans: '10' }).error).toBe(expected);
    expect(run(r, P2_HANDLERS.ifSwitchportNonegotiate).error).toBe(expected);
    expect(r.configCalls).toEqual([]);
  });
});

describe('switchport access vlan', () => {
  it('creates a missing VLAN first and says so; an existing VLAN is not created again', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.ifSwitchportAccessVlan, { vlan: '10' })).toEqual({ output: CLI_MESSAGES.vlanCreated.replace('{vlan}', '10') });
    expect(r.configCalls).toEqual([
      { line: ['vlan', '10'], negate: false, context: [] },
      { line: ['switchport', 'access', 'vlan', '10'], negate: false, context: undefined },
    ]);
    expect(r.running.render()).toContain('vlan 10\n');
    expect(run(r, P2_HANDLERS.ifSwitchportAccessVlan, { vlan: '10' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifSwitchportAccessVlan, { vlan: '1' })).toEqual({});
    expect(r.configCalls).toHaveLength(4);
    expect(readSwitchport(r.running, FA1).accessVlan).toBe(1);
    expect(run(r, P2_HANDLERS.ifSwitchportAccessVlan, {}, true)).toEqual({});
    expect(r.configCalls.at(-1)).toEqual({ line: ['switchport', 'access', 'vlan'], negate: true, context: undefined });
  });

  it('native vlan is stored as typed, never created', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.ifSwitchportTrunkNative, { vlan: '99' })).toEqual({});
    expect(r.configCalls).toEqual([{ line: ['switchport', 'trunk', 'native', 'vlan', '99'], negate: false, context: undefined }]);
    expect(readSwitchport(r.running, FA1).nativeVlan).toBe(99);
    expect(r.running.render()).not.toContain('\nvlan 99\n');
    expect(r.configCalls).toHaveLength(1);
  });
});

describe('switchport trunk allowed vlan', () => {
  it('resolves every form against the current list into the canonical text', () => {
    expect(resolveAllowedVlans('1-4094', undefined, '1,10,20,99')).toBe('1,10,20,99');
    expect(resolveAllowedVlans('1-4094', undefined, '30-35,10')).toBe('10,30-35');
    expect(resolveAllowedVlans('1,10,20,99', 'add', '30')).toBe('1,10,20,30,99');
    expect(resolveAllowedVlans('1,10,20,99', 'remove', '20')).toBe('1,10,99');
    expect(resolveAllowedVlans('1,10,20,99', 'except', '10,20')).toBe('1-9,11-19,21-4094');
    expect(resolveAllowedVlans('1,10,20,99', 'except', '10-20')).toBe('1-9,21-4094');
    expect(resolveAllowedVlans('1-4094', 'add', '10')).toBe('1-4094');
    expect(resolveAllowedVlans('', 'add', '10')).toBe('10');
    expect(resolveAllowedVlans('1,10', 'all', undefined)).toBe('1-4094');
    expect(resolveAllowedVlans('1,10', 'none', undefined)).toBe('');
    expect(resolveAllowedVlans('1,10', 'add', 'x')).toBeUndefined();
    expect(resolveAllowedVlans('1,10', undefined, '')).toBeUndefined();
  });

  it('stores the resolved list, removes the line for all and stores none for none (§5.1)', () => {
    const r = sw();
    const id = P2_HANDLERS.ifSwitchportTrunkAllowed;
    expect(run(r, id, { vlans: '99,1,10,20' })).toEqual({});
    expect(r.running.render()).toContain(' switchport trunk allowed vlan 1,10,20,99');
    expect(run(r, id, { form: 'add', vlans: '30' })).toEqual({});
    expect(readSwitchport(r.running, FA1).allowed).toBe('1,10,20,30,99');
    expect(run(r, id, { form: 'remove', vlans: '20' })).toEqual({});
    expect(readSwitchport(r.running, FA1).allowed).toBe('1,10,30,99');
    expect(run(r, id, { form: 'except', vlans: '10' })).toEqual({});
    expect(readSwitchport(r.running, FA1).allowed).toBe('1-9,11-4094');
    expect(run(r, id, { form: 'none' })).toEqual({});
    expect(r.running.render()).toContain(' switchport trunk allowed vlan none');
    expect(readSwitchport(r.running, FA1).allowed).toBe('');
    expect(run(r, id, { form: 'add', vlans: '10' })).toEqual({});
    expect(readSwitchport(r.running, FA1).allowed).toBe('10');
    expect(run(r, id, { form: 'all' })).toEqual({});
    expect(r.running.render()).not.toContain('allowed vlan');
    expect(readSwitchport(r.running, FA1).allowed).toBe('1-4094');
    // a list naming every VLAN is the default: no line
    run(r, id, { vlans: '10' });
    expect(run(r, id, { form: 'add', vlans: '1-4094' })).toEqual({});
    expect(r.running.render()).not.toContain('allowed vlan');
    expect(run(r, id, {}, true)).toEqual({});
    expect(r.configCalls.at(-1)).toEqual({ line: ['switchport', 'trunk', 'allowed', 'vlan'], negate: true, context: undefined });
  });
});

describe('switchport nonegotiate', () => {
  it('is refused in a dynamic mode, accepted in access or trunk, and blocks a later dynamic mode', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.ifSwitchportNonegotiate).error).toBe(CLI_MESSAGES.nonegotiateNeedsStaticMode);
    run(r, P2_HANDLERS.ifSwitchportMode, { mode: 'trunk' });
    expect(run(r, P2_HANDLERS.ifSwitchportNonegotiate)).toEqual({});
    expect(readSwitchport(r.running, FA1).negotiate).toBe(false);
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { wish: 'auto' }).error).toBe(MSG_DYNAMIC_WITH_NONEGOTIATE);
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { mode: 'access' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifSwitchportNonegotiate, {}, true)).toEqual({});
    expect(readSwitchport(r.running, FA1).negotiate).toBe(true);
    expect(run(r, P2_HANDLERS.ifSwitchportMode, { wish: 'auto' })).toEqual({});
  });
});

/** A switch with VLAN 10 (named), a static trunk on Gi0/1 (native 99, allowed 1,10,20,99) and two access ports. */
function trunked(): RecordingCtx {
  const r = sw({ mode: 'priv-exec' });
  r.running.set([], ['vlan', '10']);
  r.running.set([['vlan', '10']], ['name', 'SALES']);
  r.running.set([['interface', GI1]], ['switchport', 'mode', 'trunk']);
  r.running.set([['interface', GI1]], ['switchport', 'trunk', 'native', 'vlan', '99']);
  r.running.set([['interface', GI1]], ['switchport', 'trunk', 'allowed', 'vlan', '1,10,20,99']);
  r.running.set([['interface', FA1]], ['switchport', 'mode', 'access']);
  r.running.set([['interface', FA1]], ['switchport', 'access', 'vlan', '10']);
  return r;
}

function extraTable<R extends TableRow>(rec: RecordingCtx, name: 'dtp' | 'stp' | 'stp-bridge'): ReturnType<typeof createTable<R>> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as ReturnType<typeof createTable<TableRow>>);
  return t;
}

describe('show interfaces trunk', () => {
  it('lists trunking ports with their native VLAN, allowed, existing and forwarding lists', () => {
    const r = trunked();
    const out = lines(run(r, P2_HANDLERS.showInterfacesTrunk).output);
    expect(out[0]).toMatch(/^Port\s+Mode\s+Negotiation\s+Status\s+Native VLAN$/);
    expect(out[1]).toMatch(/^GigabitEthernet0\/1\s+trunk\s+on\s+trunking\s+99$/);
    expect(out).toContain('GigabitEthernet0/1  1,10,20,99');
    // VLAN 20 and 99 do not exist: only 1 and 10 are active, and with no spanning tree both forward
    expect(out.filter((l) => l === 'GigabitEthernet0/1  1,10')).toHaveLength(2);
    expect(out.some((l) => l.startsWith('FastEthernet0/1'))).toBe(false);
  });

  it('follows the dtp row of a dynamic port and the stp rows for the forwarding list', () => {
    const r = trunked();
    r.running.set([['interface', 'GigabitEthernet0/2']], ['switchport', 'mode', 'dynamic', 'desirable']);
    extraTable<DtpRow>(r, 'dtp').set({ key: 'GigabitEthernet0/2', port: 'GigabitEthernet0/2', admin: 'dynamic-desirable', oper: 'trunk', status: 'negotiated', updatedAt: 0 });
    const bridges = extraTable<StpBridgeRow>(r, 'stp-bridge');
    bridges.set({ key: '10', vlan: 10, mode: 'pvst', bridgeId: '32778/00:00:00:00:00:01', rootId: '32778/00:00:00:00:00:01', isRoot: true, rootCost: 0, helloS: 2, maxAgeS: 20, forwardDelayS: 15, topologyChanges: 0, updatedAt: 0 });
    const stp = extraTable<StpPortRow>(r, 'stp');
    stp.set({ key: `10|${GI1}`, vlan: 10, port: GI1, role: 'alternate', state: 'blocking', protocol: 'stp', cost: 4, portId: '128.25', designatedBridge: 'x', designatedPort: '128.1', edge: false, stateSince: 0, updatedAt: 0 });
    const out = lines(run(r, P2_HANDLERS.showInterfacesTrunk).output);
    expect(out[2]).toMatch(/^GigabitEthernet0\/2\s+dynamic desirable\s+on\s+trunking\s+1$/);
    // Gi0/1: VLAN 10 blocked by spanning tree, VLAN 1 has no instance so it forwards; Gi0/2 (allowed all) has no
    // stp row for VLAN 10 at all, so it is not forwarding there either (§3.0 step 6)
    expect(out.at(-2)).toBe('GigabitEthernet0/1  1');
    expect(out.at(-1)).toBe('GigabitEthernet0/2  1,1002-1005');
  });

  it('says so when nothing trunks', () => {
    expect(run(sw({ mode: 'priv-exec' }), P2_HANDLERS.showInterfacesTrunk).output).toBe(MSG_NO_TRUNK);
  });
});

describe('show interfaces switchport', () => {
  it('describes one port, marks a missing VLAN inactive and names a routed port as not switched', () => {
    const r = trunked();
    r.running.set([['interface', 'FastEthernet0/2']], ['switchport', 'access', 'vlan', '30']);
    const fa1 = run(r, P2_HANDLERS.showInterfacesSwitchport, { iface: 'fa0/1' }).output ?? '';
    expect(lines(fa1)).toEqual([
      'Name: FastEthernet0/1',
      'Switched port: yes',
      'Administrative mode: access',
      'Operational mode: access',
      'Trunk negotiation: on',
      'Access VLAN: 10 (SALES)',
      'Voice VLAN: none',
      'Trunk native VLAN: 1 (default)',
      'Trunk allowed VLANs: all',
      'Trunk VLANs allowed and existing: 1,10,1002-1005',
    ]);
    const fa2 = run(r, P2_HANDLERS.showInterfacesSwitchport, { iface: 'FastEthernet0/2' }).output ?? '';
    expect(fa2).toContain('Access VLAN: 30 (inactive: VLAN 30 does not exist)');
    expect(fa2).toContain('Administrative mode: dynamic auto');
    const gi1 = run(r, P2_HANDLERS.showInterfacesSwitchport, { iface: GI1 }).output ?? '';
    expect(gi1).toContain('Operational mode: trunk');
    expect(gi1).toContain('Trunk native VLAN: 99 (inactive: VLAN 99 does not exist)');
    expect(gi1).toContain('Trunk allowed VLANs: 1,10,20,99');
    expect(run(r, P2_HANDLERS.showInterfacesSwitchport, { iface: 'nope' }).error).toBe(MSG_NO_SUCH_PORT.replace('{name}', 'nope'));
    const all = run(r, P2_HANDLERS.showInterfacesSwitchport).output ?? '';
    expect(all.split('\n\n')).toHaveLength(26);
    const ports = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const mls = commandCtxFor(MLS, { mode: 'priv-exec', ports });
    expect(run(mls, P2_HANDLERS.showInterfacesSwitchport, { iface: 'GigabitEthernet1/0/24' }).output).toBe('Name: GigabitEthernet1/0/24\nSwitched port: no (a routed interface)');
  });
});

describe('the P2 forms of the P1 show commands', () => {
  it('show interfaces status err-disabled lists only error-disabled ports with the reason', () => {
    const model = catalogModel('switch.nfc2960');
    const none = commandCtxFor(model, { mode: 'priv-exec' });
    expect(run(none, HANDLERS.showInterfacesStatus, { filter: 'err-disabled' }).output).toBe(MSG_NO_ERR_DISABLED);
    const ports = devicePortViews(model, { patch: { 'FastEthernet0/3': { errDisabled: 'psecure-violation', operUp: false } } });
    const r = commandCtxFor(model, { mode: 'priv-exec', ports });
    const out = lines(run(r, HANDLERS.showInterfacesStatus, { filter: 'err-disabled' }).output);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^Port\s+Description\s+Status\s+Reason$/);
    expect(out[1]).toMatch(/^FastEthernet0\/3\s+err-disabled\s+port security violation$/);
    // the unfiltered table is unchanged in shape
    const full = lines(run(r, HANDLERS.showInterfacesStatus).output);
    expect(full[0]).toMatch(/^Port\s+Description\s+Status\s+Role\s+Duplex\s+Speed\s+Type$/);
    expect(full.find((l) => l.startsWith('FastEthernet0/3'))).toMatch(/err-disabled/);
  });

  it('show mac address-table filters by kind, VLAN and port, and counts', () => {
    const r = commandCtxFor(catalogModel('switch.nfc2960'), { mode: 'priv-exec' });
    r.ctx.tables.cam.set({ key: '1/00:1f:00:00:00:0a', mac: '00:1f:00:00:00:0a', vlan: 1, port: FA1, type: 'dynamic', updatedAt: 0 });
    r.ctx.tables.cam.set({ key: '10/00:1f:00:00:00:0b', mac: '00:1f:00:00:00:0b', vlan: 10, port: 'FastEthernet0/2', type: 'dynamic', updatedAt: 0 });
    r.ctx.tables.cam.set({ key: '10/00:1f:00:00:00:0c', mac: '00:1f:00:00:00:0c', vlan: 10, port: 'FastEthernet0/2', type: 'static', secure: 'sticky', updatedAt: 0 });
    const all = lines(run(r, HANDLERS.showMac).output);
    expect(all).toHaveLength(5);
    expect(all[3]).toMatch(/static \(sticky\)\s+FastEthernet0\/2$/);
    expect(lines(run(r, HANDLERS.showMac, { kind: 'dynamic' }).output).at(-1)).toBe('Total entries: 2');
    expect(lines(run(r, HANDLERS.showMac, { kind: 'static' }).output).at(-1)).toBe('Total entries: 1');
    expect(lines(run(r, HANDLERS.showMac, { vlan: '10' }).output).at(-1)).toBe('Total entries: 2');
    expect(lines(run(r, HANDLERS.showMac, { iface: 'fa0/1' }).output).at(-1)).toBe('Total entries: 1');
    expect(run(r, HANDLERS.showMac, { iface: 'nope' }).error).toContain('No interface named');
    expect(run(r, HANDLERS.showMac, { count: 'count' }).output).toBe('Dynamic entries: 2\nStatic entries: 1\nTotal entries: 3');
    expect(run(r, HANDLERS.showMac, { count: 'count', vlan: '10', kind: 'dynamic' }).output).toBe('Dynamic entries: 1\nStatic entries: 0\nTotal entries: 1');
  });
});

describe('scope and parsing', () => {
  const ok = (m: ReturnType<typeof matchCommand>) => (m.ok ? m.spec.handler : m.error.message);

  it('the switchport lines parse on a managed switch port and are hidden elsewhere', () => {
    const confIf = matchContextFor(SW, 'config-if', { iface: FA1 });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport mode access'))).toBe(P2_HANDLERS.ifSwitchportMode);
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport mode dynamic desirable')).toMatchObject({ ok: true, args: { wish: 'desirable' } });
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport access vlan 10')).toMatchObject({ ok: true, args: { vlan: '10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport trunk allowed vlan add 30-35,10')).toMatchObject({ ok: true, args: { form: 'add', vlans: '10,30-35' } });
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport trunk allowed vlan 1,10')).toMatchObject({ ok: true, args: { vlans: '1,10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport trunk allowed vlan all')).toMatchObject({ ok: true, args: { form: 'all' } });
    expect(matchCommand(BUILTIN_GRAMMAR, confIf, 'no switchport trunk allowed vlan')).toMatchObject({ ok: true, negated: true });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport nonegotiate'))).toBe(P2_HANDLERS.ifSwitchportNonegotiate);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, confIf, 'switchport'))).toBe(HANDLERS.ifSwitchport);
    // the P1 switch is not VLAN-aware; a routed MLS port reaches the handler (which names the problem)
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('switch.nfc2960'), 'config-if', { iface: FA1 }), 'switchport mode access').ok).toBe(false);
    const routed = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(MLS, 'config-if', { ports: routed, iface: 'GigabitEthernet1/0/24' }), 'switchport mode access').ok).toBe(true);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(MLS, 'config-if', { iface: 'Vlan1' }), 'switchport mode access').ok).toBe(false);
  });

  it('the show commands parse beside the P1 interface forms', () => {
    const exec = matchContextFor(SW, 'priv-exec');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces trunk'))).toBe(P2_HANDLERS.showInterfacesTrunk);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces fa0/1 switchport'))).toBe(P2_HANDLERS.showInterfacesSwitchport);
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces fa0/1 switchport')).toMatchObject({ ok: true, args: { iface: FA1 } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces switchport'))).toBe(P2_HANDLERS.showInterfacesSwitchport);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces fa0/1'))).toBe(HANDLERS.showInterfaces);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces status'))).toBe(HANDLERS.showInterfacesStatus);
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show interfaces status err-disabled')).toMatchObject({ ok: true, args: { filter: 'err-disabled' } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show mac address-table')).toMatchObject({ ok: true, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show mac address-table dynamic')).toMatchObject({ ok: true, args: { kind: 'dynamic' } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show mac address-table vlan 10')).toMatchObject({ ok: true, args: { vlan: '10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show mac address-table interface fa0/1')).toMatchObject({ ok: true, args: { iface: FA1 } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show mac address-table count')).toMatchObject({ ok: true, args: { count: 'count' } });
    // the P1 switch has the P1 forms and the mac/status filters (bridging), not the trunk view
    const p1 = matchContextFor(catalogModel('switch.nfc2960'), 'priv-exec');
    expect(matchCommand(BUILTIN_GRAMMAR, p1, 'show mac address-table count').ok).toBe(true);
    expect(matchCommand(BUILTIN_GRAMMAR, p1, 'show interfaces status err-disabled').ok).toBe(true);
    expect(matchCommand(BUILTIN_GRAMMAR, p1, 'show interfaces trunk').ok).toBe(false);
  });
});
