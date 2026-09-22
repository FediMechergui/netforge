/**
 * cli/grammar/etherchannel.ts and cli/handlers/etherchannel.ts (ARCHITECTURE-P2 §3.7, §5.1, §5.4, D10; §7 W3 cli):
 * `channel-group` with the Port-channel creation and the switchport-line copy, `port-channel load-balance`,
 * `show etherchannel summary|port-channel` and [S3] `show lacp neighbor` against a fake `etherchannel` table.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { EtherchannelRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { channelMembers, channelProtocolOf, MSG_CHANNEL_ON_BUNDLE, MSG_NO_CHANNEL, MSG_NO_LACP_PARTNER } from '../src/cli/handlers/etherchannel.js';
import { matchCommand } from '../src/cli/parser.js';
import { DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import { SEC } from '../src/contracts/time.js';
import { readSwitchport } from '../src/protocols/l2/switchport-config.js';
import { commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';
import { lagWorld } from './lag.harness.js';

const SW = p2Model('switch.nfc2960');
const MLS = p2Model('mlswitch.nfc3650-24');
const GI1 = 'GigabitEthernet0/1';
const GI2 = 'GigabitEthernet0/2';
const PO1 = 'Port-channel1';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function sw(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(SW, opts);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as Table<TableRow>);
  return t;
}

function member(port: string, patch: Partial<EtherchannelRow> = {}): EtherchannelRow {
  return { key: port, updatedAt: 0, port, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'bundled', ...patch };
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('parsing', () => {
  it('parses the channel-group modes, the load-balance methods and the show commands on a managed switch', () => {
    const ifc = matchContextFor(SW, 'config-if', { iface: GI1 });
    for (const mode of ['on', 'active', 'passive', 'desirable', 'auto']) {
      expect(matchCommand(BUILTIN_GRAMMAR, ifc, `channel-group 1 mode ${mode}`), mode).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifChannelGroup }, args: { group: '1', mode } });
    }
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'channel-group 49 mode on').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'no channel-group')).toMatchObject({ ok: true, negated: true });
    const cfg = matchContextFor(SW, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'port-channel load-balance src-dst-ip')).toMatchObject({ ok: true, args: { method: 'src-dst-ip' } });
    const exec = matchContextFor(SW, 'user-exec');
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show etherchannel summary')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showEtherchannelSummary } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show etherchannel port-channel')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showEtherchannelPortChannel } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show lacp neighbor')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showLacpNeighbor } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p2Model('router.nf2911'), 'user-exec'), 'show etherchannel summary').ok).toBe(false);
  });
});

describe('channel-group', () => {
  it('creates the Port-channel once, copies the member switchport lines into it, and stores the member line', () => {
    let created = 0;
    const r = sw({ iface: GI1, ensureVirtualPort: (name) => ({ ok: true, port: name, created: created++ === 0 }) });
    r.running.set([['interface', GI1]], ['switchport', 'mode', 'trunk']);
    r.running.set([['interface', GI1]], ['switchport', 'trunk', 'allowed', 'vlan', '10,20']);
    r.running.set([['interface', GI1]], ['description', 'uplink']);
    expect(run(r, P2_HANDLERS.ifChannelGroup, { group: '1', mode: 'active' })).toEqual({ output: CLI_MESSAGES.channelCreated.replace('{group}', '1') });
    expect(r.deviceCalls).toEqual([`ensureVirtualPort ${PO1}`]);
    expect(r.configCalls).toEqual([
      { line: ['interface', PO1], negate: false, context: [] },
      { line: ['switchport', 'mode', 'trunk'], negate: false, context: [['interface', PO1]] },
      { line: ['switchport', 'trunk', 'allowed', 'vlan', '10,20'], negate: false, context: [['interface', PO1]] },
      { line: ['channel-group', '1', 'mode', 'active'], negate: false, context: undefined },
    ]);
    const text = r.running.render();
    expect(text).toContain(`interface ${PO1}\n switchport mode trunk\n switchport trunk allowed vlan 10,20`);
    expect(text).not.toContain(`interface ${PO1}\n description`);
    expect(text).toContain(`interface ${GI1}\n description uplink\n switchport mode trunk\n switchport trunk allowed vlan 10,20\n channel-group 1 mode active`);
    // the second member finds the bundle already created: no message, no copy
    const second = commandCtxFor(SW, { iface: GI2, running: r.running, ensureVirtualPort: (name) => ({ ok: true, port: name, created: false }) });
    expect(run(second, P2_HANDLERS.ifChannelGroup, { group: '1', mode: 'active' })).toEqual({});
    expect(second.configCalls).toEqual([
      { line: ['interface', PO1], negate: false, context: [] },
      { line: ['channel-group', '1', 'mode', 'active'], negate: false, context: undefined },
    ]);
    expect(run(second, P2_HANDLERS.ifChannelGroup, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain(`interface ${GI2}\n channel-group`);
    expect(r.running.render()).toContain(`interface ${GI1}\n description uplink\n switchport mode trunk\n switchport trunk allowed vlan 10,20\n channel-group 1 mode active`);
  });

  it('refuses a bundle as a member, a routed port, and a bad mode or group', () => {
    const ports = devicePortViews(SW, { patch: { [GI2]: { role: 'channel' } } });
    const onBundle = commandCtxFor(SW, { iface: GI2, ports });
    expect(run(onBundle, P2_HANDLERS.ifChannelGroup, { group: '1', mode: 'on' }).error).toBe(MSG_CHANNEL_ON_BUNDLE);
    const routedPorts = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const routed = commandCtxFor(MLS, { iface: 'GigabitEthernet1/0/24', ports: routedPorts });
    expect(run(routed, P2_HANDLERS.ifChannelGroup, { group: '1', mode: 'on' }).error).toBe(CLI_MESSAGES.notSwitchport.replace('{port}', 'GigabitEthernet1/0/24'));
    const r = sw({ iface: GI1 });
    expect(run(r, P2_HANDLERS.ifChannelGroup, { group: '0', mode: 'on' }).error).toContain('channel group');
    expect(run(r, P2_HANDLERS.ifChannelGroup, { group: '1', mode: 'maybe' }).error).toContain('mode');
    expect(r.configCalls).toEqual([]);
    expect(r.deviceCalls).toEqual([]);
  });

  it('stores and clears the load-balance method', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configPortChannelLoadBalance, { method: 'src-dst-ip' })).toEqual({});
    expect(r.running.render()).toContain('port-channel load-balance src-dst-ip');
    expect(run(r, P2_HANDLERS.configPortChannelLoadBalance, { method: 'round-robin' }).error).toContain('hash input');
    expect(run(r, P2_HANDLERS.configPortChannelLoadBalance, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('load-balance');
    expect(channelProtocolOf('on')).toBe('static');
    expect(channelProtocolOf('passive')).toBe('lacp');
    expect(channelProtocolOf('auto')).toBe('pagp');
  });
});

describe('show etherchannel', () => {
  function configured(): RecordingCtx {
    const ports = devicePortViews(SW);
    const r = commandCtxFor(SW, { ports });
    r.running.set([['interface', GI1]], ['channel-group', '1', 'mode', 'active']);
    r.running.set([['interface', GI2]], ['channel-group', '1', 'mode', 'active']);
    r.running.set([['interface', 'FastEthernet0/1']], ['channel-group', '2', 'mode', 'on']);
    return r;
  }

  it('says when nothing is configured, and lists members from the config before the daemon writes rows', () => {
    expect(run(sw(), P2_HANDLERS.showEtherchannelSummary)).toEqual({ output: MSG_NO_CHANNEL });
    expect(run(sw(), P2_HANDLERS.showEtherchannelPortChannel)).toEqual({ output: MSG_NO_CHANNEL });
    expect(run(sw(), P2_HANDLERS.showLacpNeighbor)).toEqual({ output: MSG_NO_LACP_PARTNER });
    const r = configured();
    const groups = channelMembers(r.ctx);
    expect([...groups.keys()]).toEqual([1, 2]);
    expect(groups.get(1)?.map((m) => [m.port, m.mode, m.protocol, m.state])).toEqual([[GI1, 'active', 'lacp', 'configured'], [GI2, 'active', 'lacp', 'configured']]);
    const out = lines(run(r, P2_HANDLERS.showEtherchannelSummary).output);
    expect(out[0]).toBe('Load balancing: src-mac');
    expect(out[2]).toMatch(/^Group\s+Bundle\s+Status\s+Protocol\s+Members \(state\)$/);
    expect(out[3]).toMatch(/^1\s+Port-channel1\s+not created\s+lacp\s+GigabitEthernet0\/1 \(configured\), GigabitEthernet0\/2 \(configured\)$/);
    expect(out[4]).toMatch(/^2\s+Port-channel2\s+not created\s+static\s+FastEthernet0\/1 \(configured\)$/);
  });

  it('overlays the etherchannel rows: states, partner details, the bundle status and the LACP neighbours', () => {
    const r = configured();
    const t = attach<EtherchannelRow>(r, 'etherchannel');
    t.set(member(GI1, { partnerSystem: '02:00:00:00:00:09', partnerKey: 1, partnerPort: 25 }));
    t.set(member(GI2, { state: 'individual', reason: 'no LACP partner' }));
    r.running.set([], ['port-channel', 'load-balance', 'src-dst-mac']);
    r.ports.set(PO1, { ...(r.ports.get(GI1) as NonNullable<ReturnType<typeof r.ports.get>>), id: PO1, role: 'channel', operUp: true });
    const out = lines(run(r, P2_HANDLERS.showEtherchannelSummary).output);
    expect(out[0]).toBe('Load balancing: src-dst-mac');
    expect(out[3]).toMatch(/^1\s+Port-channel1\s+in use\s+lacp\s+GigabitEthernet0\/1 \(bundled\), GigabitEthernet0\/2 \(individual\)$/);
    const full = lines(run(r, P2_HANDLERS.showEtherchannelPortChannel).output);
    expect(full[0]).toBe(PO1);
    expect(full[1]).toBe('  Status: in use   Members bundled: 1 of 2');
    expect(full[2]).toBe('  Protocol: lacp   Load balancing: src-dst-mac');
    expect(full[3]).toMatch(/^\s+Port\s+Mode\s+State\s+Reason\s+Partner system\s+Partner key\s+Partner port$/);
    expect(full[4]).toMatch(/^\s+GigabitEthernet0\/1\s+active\s+bundled\s+02:00:00:00:00:09\s+1\s+25$/);
    expect(full[5]).toMatch(/^\s+GigabitEthernet0\/2\s+active\s+individual\s+no LACP partner\s+-\s+-\s+-$/);
    expect(full[7]).toBe('Port-channel2');
    const lacp = lines(run(r, P2_HANDLERS.showLacpNeighbor).output);
    expect(lacp).toHaveLength(2);
    expect(lacp[1]).toMatch(/^GigabitEthernet0\/1\s+Port-channel1\s+02:00:00:00:00:09\s+1\s+25\s+bundled$/);
  });
});

describe('lines typed under interface Port-channelN reach every member (§3.7 step 1, real world)', () => {
  it('a trunk line under Port-channel1 lands in both member sections and the members stay bundled; `no` removes it from the members too', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] }, sw2: { hostname: 'SW2', members: [[GI1, 'passive'], [GI2, 'passive']] } });
    w.sim.runFor(40 * SEC);
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)!.state).toBe('bundled');
    const r = w.sim.configure('sw1', ['interface Port-channel1', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20']);
    expect(r.ok).toBe(true);
    w.sim.runFor(5 * SEC);
    const running = w.sim.device('sw1')!.running;
    for (const p of [PO1, GI1, GI2]) {
      expect(readSwitchport(running, p).mode, p).toBe('trunk');
      expect(readSwitchport(running, p).allowed, p).toBe('10,20');
    }
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)!.state).toBe('bundled');
    expect(w.sim.device('sw1')!.port(PO1)!.operUp).toBe(true);
    const back = w.sim.configure('sw1', ['interface Port-channel1', 'no switchport trunk allowed vlan']);
    expect(back.ok).toBe(true);
    w.sim.runFor(5 * SEC);
    for (const p of [PO1, GI1, GI2]) {
      expect(readSwitchport(w.sim.device('sw1')!.running, p).allowed, p).toBe(DEFAULT_SWITCHPORT.allowed);
      expect(readSwitchport(w.sim.device('sw1')!.running, p).mode, p).toBe('trunk');
    }
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)!.state).toBe('bundled');
  });
});
