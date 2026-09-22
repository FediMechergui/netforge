/**
 * W2 l2 (ARCHITECTURE-P2 D5, §2.1, §2.6 VlanRow, §3.1 step 1, §4.3 silence, §5.1): the `vlan` daemon — the config
 * reader, the idempotent reconciliation of the `vlans` table, the `l2Changed {what:'vlans'}` signal, its silence, and
 * the real runtime path (config lines applied on a device: rows, trace, the fan-out to eth-switch and the SVI
 * recompute) on a P2-stage NF-C2960.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson, createConfigAst } from '../src/cli/config-ast.js';
import type { ConfigNode } from '../src/contracts/config.js';
import type { Action } from '../src/contracts/process.js';
import { vlanKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { VlanRow } from '../src/contracts/tables.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { VLAN_DEBUG_CATEGORY, VLAN_PROCESS, createVlan, defaultVlanName, isVlanDelta, readConfiguredVlans } from '../src/protocols/vlan.js';
import { NF_C2960_INPUT } from './device.catalog.p0-inputs.js';
import { p2Harness } from './device.p2.harness.js';
import { p2SwitchHarness } from './l2.eth-switch.p2.harness.js';
import { defineP2Model, p2Registry } from './p2.world.js';

function ast(sections: readonly (readonly [string, readonly string[]])[]): ReturnType<typeof configAstFromJson> {
  const root: ConfigNode = { key: '', args: [], children: [] };
  for (const [header, lines] of sections) {
    const t = header.split(' ');
    root.children.push({ key: t[0] as string, args: t.slice(1), children: lines.map((l) => ({ key: l.split(' ')[0] as string, args: l.split(' ').slice(1), children: [] })) });
  }
  return configAstFromJson(root);
}

describe('readConfiguredVlans / defaultVlanName / isVlanDelta', () => {
  it('reads every vlan section ascending with its name or the default name; implicit and invalid ids are left out', () => {
    expect(defaultVlanName(10)).toBe('VLAN0010');
    expect(defaultVlanName(4094)).toBe('VLAN4094');
    const c = ast([
      ['vlan 30', []],
      ['vlan 10', ['name SALES']],
      ['vlan 1', ['name default']],
      ['vlan 1002', []],
      ['vlan 4095', []],
      ['vlan internal', []],
      ['vlan 20', ['name Guest Wifi']],
      ['interface FastEthernet0/1', ['switchport access vlan 10']],
    ]);
    expect(readConfiguredVlans(c)).toEqual([
      { vlan: 10, name: 'SALES' },
      { vlan: 20, name: 'Guest Wifi' },
      { vlan: 30, name: 'VLAN0030' },
    ]);
    expect(readConfiguredVlans(createConfigAst())).toEqual([]);
  });

  it('a delta touches the VLAN database only for a global vlan line or a line inside a vlan section', () => {
    expect(isVlanDelta({ context: [], line: ['vlan', '10'] })).toBe(true);
    expect(isVlanDelta({ context: [], line: ['vlan', '10,20'] })).toBe(true);
    expect(isVlanDelta({ context: [['vlan', '10']], line: ['name', 'SALES'] })).toBe(true);
    expect(isVlanDelta({ context: [], line: ['hostname', 'SW1'] })).toBe(false);
    expect(isVlanDelta({ context: [['interface', 'FastEthernet0/1']], line: ['switchport', 'access', 'vlan', '10'] })).toBe(false);
    expect(isVlanDelta({ context: [['wlc-interface', 'management']], line: ['vlan', '20'] })).toBe(false);
  });
});

describe('the vlan daemon on a fake ctx', () => {
  it('is silent without configuration: no row, no debug, no action, no timer', () => {
    const h = p2SwitchHarness();
    const d = createVlan();
    expect(d.name).toBe(VLAN_PROCESS);
    expect(d.handles).toBeUndefined();
    expect(d.init!(h.ctx)).toEqual([]);
    expect(d.onTimer(h.ctx, 'anything')).toEqual([]);
    expect(d.onConfig(h.ctx, { op: 'set', context: [], line: ['hostname', 'SW1'] })).toEqual([]);
    expect(h.tables.get<VlanRow>('vlans')!.size).toBe(0);
    expect(h.debug).toEqual([]);
    expect(h.trace).toEqual([]);
    expect(d.stateSnapshot()).toEqual({ process: 'vlan', state: { count: 0, vlans: [] } });
  });

  it('`vlan 10` / `name SALES` write the §3.1 row and signal once; a rename rewrites without a signal; `no vlan` deletes and signals', () => {
    const h = p2SwitchHarness();
    const d = createVlan();
    d.init!(h.ctx);
    const created = h.configure(d, [], ['vlan', '10']);
    expect(created).toEqual([{ type: 'l2Changed', what: 'vlans', vlan: 10 }]);
    expect(h.tables.get<VlanRow>('vlans')!.get(vlanKey(10))).toEqual({ key: '10', vlan: 10, name: 'VLAN0010', status: 'active', source: 'config', updatedAt: 0 });
    expect(h.debug.map((e) => [e.category, e.message])).toEqual([[VLAN_DEBUG_CATEGORY, 'VLAN 10 (VLAN0010) added']]);
    h.setNow(5);
    const named = h.configure(d, [['vlan', '10']], ['name', 'SALES']);
    expect(named).toEqual([]);
    expect(h.tables.get<VlanRow>('vlans')!.get(vlanKey(10))).toMatchObject({ name: 'SALES', updatedAt: 5 });
    expect(h.debug.at(-1)!.message).toBe('VLAN 10 renamed from VLAN0010 to SALES');
    // the same line again changes nothing
    const writes = h.kinds('tableWrite').length;
    expect(d.onConfig(h.ctx, { op: 'set', context: [['vlan', '10']], line: ['name', 'SALES'] })).toEqual([]);
    expect(h.kinds('tableWrite').length).toBe(writes);
    expect(d.stateSnapshot()).toEqual({ process: 'vlan', state: { count: 1, vlans: [10] } });
    const removed = h.configure(d, [], ['vlan', '10'], true);
    expect(removed).toEqual([{ type: 'l2Changed', what: 'vlans', vlan: 10 }]);
    expect(h.tables.get<VlanRow>('vlans')!.size).toBe(0);
    expect(h.kinds('tableExpire')).toEqual([expect.objectContaining({ table: 'vlans', key: '10', reason: 'cleared' })]);
    expect(d.stateSnapshot()).toEqual({ process: 'vlan', state: { count: 0, vlans: [] } });
  });

  it('`vlan 10,20` stores two sections and signals each VLAN ascending; VLAN 1 is never a row', () => {
    const h = p2SwitchHarness();
    const d = createVlan();
    d.init!(h.ctx);
    const actions: Action[] = h.configure(d, [], ['vlan', '30,10-11']);
    expect(actions).toEqual([
      { type: 'l2Changed', what: 'vlans', vlan: 10 },
      { type: 'l2Changed', what: 'vlans', vlan: 11 },
      { type: 'l2Changed', what: 'vlans', vlan: 30 },
    ]);
    expect(d.stateSnapshot().state).toEqual({ count: 3, vlans: [10, 11, 30] });
    expect(h.configure(d, [], ['vlan', '1'])).toEqual([]);
    expect(h.tables.get<VlanRow>('vlans')!.has(vlanKey(1))).toBe(false);
  });

  it('init reconciles a config that was replayed before the daemon existed (idempotent after the boot replay)', () => {
    const h = p2SwitchHarness();
    h.config.set([], ['vlan', '10']);
    h.config.set([['vlan', '10']], ['name', 'SALES']);
    const d = createVlan();
    expect(d.init!(h.ctx)).toEqual([{ type: 'l2Changed', what: 'vlans', vlan: 10 }]);
    expect(d.init!(h.ctx)).toEqual([]);
    expect(h.tables.get<VlanRow>('vlans')!.rows()).toEqual([expect.objectContaining({ vlan: 10, name: 'SALES' })]);
  });

  it('a stray frame is dropped, never bridged', () => {
    const h = p2SwitchHarness();
    const d = createVlan();
    const pdu = h.frame('00:1f:00:00:00:0a', 'ff:ff:ff:ff:ff:ff');
    expect(d.onPdu(h.ctx, pdu, 'FastEthernet0/1')).toEqual([expect.objectContaining({ type: 'drop', pdu, reason: 'unsupported-protocol' })]);
  });
});

describe('the vlan daemon on a real device runtime (P2-stage NF-C2960)', () => {
  const registry = { ...PROCESS_FACTORIES, vlan: createVlan };
  const MODEL = defineP2Model(NF_C2960_INPUT, p2Registry({ vlan: createVlan }));

  it('boots silent in the P1 profile: no vlans row, no vlan debug or log line', () => {
    const h = p2Harness({ model: MODEL, processes: registry, profile: 'P1' });
    h.run(60 * SEC);
    expect(h.device.tables.get<VlanRow>('vlans')!.size).toBe(0);
    expect(h.kinds('tableWrite').filter((e) => e.table === 'vlans')).toEqual([]);
    expect(h.kinds('debug').filter((e) => e.event.process === 'vlan')).toEqual([]);
    expect(h.kinds('log').some((e) => e.message.includes('vlan'))).toBe(false);
    expect(h.device.stateSnapshots().find((s) => s.process === 'vlan')).toEqual({ process: 'vlan', state: { count: 0, vlans: [] } });
  });

  it('a startup config with vlan sections restores the rows at boot; typed lines add, rename and delete with the signal', () => {
    const h = p2Harness({ model: MODEL, processes: registry, profile: 'P2', startupConfig: ['vlan 10', ' name SALES', 'vlan 20', '!'].join('\n') });
    h.run(60 * SEC);
    const vlans = h.device.tables.get<VlanRow>('vlans')!;
    expect(vlans.rows().map((r) => [r.vlan, r.name])).toEqual([[10, 'SALES'], [20, 'VLAN0020']]);
    expect(h.device.stateSnapshots().find((s) => s.process === 'vlan')!.state).toEqual({ count: 2, vlans: [10, 20] });

    const before = h.events.length;
    expect(h.device.applyConfigLine([], ['vlan', '30'], false)).toEqual({ ok: true });
    expect(vlans.get(vlanKey(30))).toMatchObject({ vlan: 30, name: 'VLAN0030', status: 'active', source: 'config' });
    const added = h.events.slice(before);
    expect(added.filter((e) => e.kind === 'configChange')).toEqual([expect.objectContaining({ line: 'vlan 30', negate: false })]);
    expect(added.filter((e) => e.kind === 'tableWrite')).toEqual([expect.objectContaining({ table: 'vlans', key: '30' })]);
    const vlanDebug = added.filter((e): e is Extract<typeof e, { kind: 'debug' }> => e.kind === 'debug').filter((e) => e.event.process === 'vlan');
    expect(vlanDebug.map((e) => e.event.message)).toEqual(['VLAN 30 (VLAN0030) added']);

    expect(h.device.applyConfigLine([['vlan', '30']], ['name', 'GUESTS'], false)).toEqual({ ok: true });
    expect(vlans.get(vlanKey(30))).toMatchObject({ name: 'GUESTS' });
    expect(h.device.running.render()).toContain(['vlan 30', ' name GUESTS'].join('\n'));

    // the eth-switch flush on delete: a dynamic row of VLAN 30 goes when the VLAN goes
    h.device.tables.cam.set({ key: '30/00:1f:00:00:00:0a', mac: '00:1f:00:00:00:0a', vlan: 30, port: 'FastEthernet0/1', type: 'dynamic', updatedAt: 0, expiresAt: 1e12 });
    h.device.tables.cam.set({ key: '10/00:1f:00:00:00:0b', mac: '00:1f:00:00:00:0b', vlan: 10, port: 'FastEthernet0/1', type: 'dynamic', updatedAt: 0, expiresAt: 1e12 });
    expect(h.device.applyConfigLine([], ['vlan', '30'], true)).toEqual({ ok: true });
    expect(vlans.has(vlanKey(30))).toBe(false);
    expect(h.device.tables.cam.rows().map((r) => r.key)).toEqual(['10/00:1f:00:00:00:0b']);
    expect(h.kinds('tableExpire').filter((e) => e.table === 'cam')).toEqual([expect.objectContaining({ key: '30/00:1f:00:00:00:0a', reason: 'cleared' })]);
    expect(h.device.running.render()).not.toContain('vlan 30');
  });
});
