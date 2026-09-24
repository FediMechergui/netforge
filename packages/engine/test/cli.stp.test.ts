/**
 * cli/grammar/spanning-tree.ts and cli/handlers/spanning-tree.ts (ARCHITECTURE-P2 §3.6, §5.1, §5.4, D9; §7 W3 cli):
 * the spanning-tree lines and their validation, the `root primary|secondary` macro (including the tie case, review
 * finding #34), `show spanning-tree` in every §5.4 form against fake `stp` / `stp-bridge` tables, `show dtp
 * interface`, `clear spanning-tree detected-protocols`, the W3 fragment registration beside the P1 table and the
 * P2 debug category registry.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { DtpRow, StpBridgeRow, StpPortRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import {
  BUILTIN_GRAMMAR,
  DEBUG_CATEGORIES,
  DEBUG_CATEGORY_DEFS,
  GRAMMAR,
  GRAMMAR_FRAGMENTS,
  HANDLERS,
  P2_DEBUG_CATEGORIES,
  P2_DEBUG_GRAMMAR,
  P2_GRAMMAR,
  P2_GRAMMAR_FRAGMENTS,
  P2_HANDLERS,
  STP_CLEAR_DETECTED_REQUEST,
} from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY, P2_HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  MSG_BAD_BRIDGE_PRIORITY,
  MSG_BAD_PORT_PRIORITY,
  MSG_BAD_VLAN_LIST,
  MSG_DTP_NOTHING_HEARD,
  MSG_STP_NO_PORT_INSTANCE,
  MSG_STP_NOT_RUNNING,
  rootMacroFor,
  stpPortNotes,
} from '../src/cli/handlers/spanning-tree.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p1SwitchModel, p2Model } from './cli.p2.fixture.js';

const SW = p2Model('switch.nfc2960');
const MLS = p2Model('mlswitch.nfc3650-24');
const ROUTER = p2Model('router.nf2911');
const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const GI1 = 'GigabitEthernet0/1';
const GI2 = 'GigabitEthernet0/2';

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

/** Attach a P2 table to the recording context (the tests write the rows a daemon would). */
function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as Table<TableRow>);
  return t;
}

const OWN_MAC = '02:00:00:00:00:02';
const ROOT_MAC = '02:00:00:00:00:01';

function bridge(vlan: number, patch: Partial<StpBridgeRow> = {}): StpBridgeRow {
  return {
    key: String(vlan), updatedAt: 0, vlan, mode: 'pvst',
    bridgeId: `${32768 + vlan}/${OWN_MAC}`, rootId: `${4096 + vlan}/${ROOT_MAC}`, isRoot: false,
    rootPort: GI1, rootCost: 4, helloS: 2, maxAgeS: 20, forwardDelayS: 15, topologyChanges: 0,
    ...patch,
  };
}

function port(vlan: number, id: string, patch: Partial<StpPortRow> = {}): StpPortRow {
  return {
    key: `${vlan}|${id}`, updatedAt: 0, vlan, port: id, role: 'designated', state: 'forwarding', protocol: 'stp',
    cost: 19, portId: '128.1', designatedBridge: `${32768 + vlan}/${OWN_MAC}`, designatedPort: '128.1', edge: false, stateSince: 0,
    ...patch,
  };
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');
const ok = (m: ReturnType<typeof matchCommand>): string => (m.ok ? m.spec.handler : m.error.message);

describe('scope and parsing', () => {
  it('offers the spanning-tree lines on a managed switch only and parses every §5.4 show form', () => {
    const cfg = matchContextFor(SW, 'config');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree mode rapid-pvst'))).toBe(P2_HANDLERS.configStpMode);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, cfg, 'no spanning-tree mode'))).toBe(P2_HANDLERS.configStpMode);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree extend system-id'))).toBe(P2_HANDLERS.configStpExtend);
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree vlan 1,10 priority 4096')).toMatchObject({ ok: true, args: { vlans: '1,10', priority: '4096' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree vlan 1 root primary')).toMatchObject({ ok: true, args: { vlans: '1', which: 'primary' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'no spanning-tree vlan 20')).toMatchObject({ ok: true, negated: true, spec: { handler: P2_HANDLERS.configStpVlan } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree portfast default'))).toBe(P2_HANDLERS.configStpPortfastDefault);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, cfg, 'spanning-tree portfast bpduguard default'))).toBe(P2_HANDLERS.configStpBpduguardDefault);
    const ifc = matchContextFor(SW, 'config-if', { iface: FA1 });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree portfast'))).toBe(P2_HANDLERS.ifStpPortfast);
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree portfast trunk')).toMatchObject({ ok: true, args: { kind: 'trunk' } });
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree bpduguard enable'))).toBe(P2_HANDLERS.ifStpBpduguard);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree guard root'))).toBe(P2_HANDLERS.ifStpGuard);
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree guard loop').ok).toBe(false); // [S5] not built
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree cost 4'))).toBe(P2_HANDLERS.ifStpCost);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree port-priority 64'))).toBe(P2_HANDLERS.ifStpPortPriority);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree vlan 10 cost 4'))).toBe(P2_HANDLERS.ifStpVlanCost);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, ifc, 'spanning-tree vlan 10 port-priority 32'))).toBe(P2_HANDLERS.ifStpVlanPortPriority);
    const exec = matchContextFor(SW, 'user-exec');
    for (const [line, args] of [
      ['show spanning-tree', {}],
      ['show spanning-tree vlan 10', { vlan: '10' }],
      ['show spanning-tree summary', { form: 'summary' }],
      ['show spanning-tree vlan 10 summary', { form: 'summary', vlan: '10' }],
      ['show spanning-tree root', { form: 'root' }],
      ['show spanning-tree vlan 10 root', { form: 'root', vlan: '10' }],
      ['show spanning-tree interface fa0/1', { form: 'interface', iface: FA1 }],
      ['show spanning-tree interface fa0/1 detail', { form: 'interface', detail: 'detail', iface: FA1 }],
      ['show spanning-tree vlan 10 interface fa0/1', { form: 'interface', vlan: '10', iface: FA1 }],
      ['show spanning-tree vlan 10 interface fa0/1 detail', { form: 'interface', detail: 'detail', vlan: '10', iface: FA1 }],
    ] as const) {
      const m = matchCommand(BUILTIN_GRAMMAR, exec, line);
      expect(m.ok, line).toBe(true);
      if (m.ok) {
        expect(m.spec.handler, line).toBe(P2_HANDLERS.showSpanningTree);
        expect(m.args, line).toEqual(args);
      }
    }
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show dtp interface fa0/1')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showDtpInterface }, args: { iface: FA1 } });
    const priv = matchContextFor(SW, 'priv-exec');
    expect(ok(matchCommand(BUILTIN_GRAMMAR, priv, 'clear spanning-tree detected-protocols'))).toBe(P2_HANDLERS.execClearStpDetected);
    expect(matchCommand(BUILTIN_GRAMMAR, priv, 'clear spanning-tree detected-protocols interface gi0/1')).toMatchObject({ ok: true, args: { iface: GI1 } });
    // the P1 switch and the router are not VLAN-aware (D5)
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p1SwitchModel(), 'config'), 'spanning-tree mode pvst').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'user-exec'), 'show spanning-tree').ok).toBe(false);
  });
});

describe('global lines', () => {
  it('stores the mode, clears it with no, and refuses no spanning-tree extend system-id', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configStpMode, { mode: 'rapid-pvst' })).toEqual({});
    expect(r.running.render()).toContain('spanning-tree mode rapid-pvst');
    expect(run(r, P2_HANDLERS.configStpMode, { mode: 'pvst' })).toEqual({});
    expect(r.running.render()).toContain('spanning-tree mode pvst');
    expect(r.running.render()).not.toContain('rapid-pvst');
    expect(run(r, P2_HANDLERS.configStpMode, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('spanning-tree mode');
    expect(run(r, P2_HANDLERS.configStpExtend)).toEqual({});
    expect(r.running.render()).toContain('spanning-tree extend system-id');
    expect(run(r, P2_HANDLERS.configStpExtend, {}, true).error).toBe(CLI_MESSAGES.extendSystemIdFixed);
    expect(r.running.render()).toContain('spanning-tree extend system-id');
    expect(r.configCalls.map((c) => c.context)).toEqual([[], [], [], []]);
  });

  it('stores one priority line per VLAN of the list, validates the multiple of 4096, and removes with no', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configStpVlanPriority, { vlans: '1,10', priority: '4096' })).toEqual({});
    expect(r.running.render()).toContain('spanning-tree vlan 1 priority 4096\nspanning-tree vlan 10 priority 4096');
    expect(run(r, P2_HANDLERS.configStpVlanPriority, { vlans: '1', priority: '4000' }).error).toBe(MSG_BAD_BRIDGE_PRIORITY);
    expect(run(r, P2_HANDLERS.configStpVlanPriority, { vlans: 'x', priority: '4096' }).error).toBe(MSG_BAD_VLAN_LIST);
    expect(run(r, P2_HANDLERS.configStpVlanPriority, { vlans: '10', priority: '8192' })).toEqual({});
    expect(r.running.render()).toContain('spanning-tree vlan 10 priority 8192');
    expect(r.running.render()).not.toContain('vlan 10 priority 4096');
    expect(run(r, P2_HANDLERS.configStpVlanPriority, { vlans: '1,10' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('priority');
  });

  it('no spanning-tree vlan stores one negation per VLAN and the positive line clears it', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configStpVlan, { vlans: '20,30' }, true)).toEqual({});
    expect(r.running.render()).toContain('no spanning-tree vlan 20');
    expect(r.running.render()).toContain('no spanning-tree vlan 30');
    expect(run(r, P2_HANDLERS.configStpVlan, { vlans: '20' })).toEqual({});
    expect(r.running.render()).not.toContain('no spanning-tree vlan 20');
    expect(r.running.render()).toContain('no spanning-tree vlan 30');
    expect(run(r, P2_HANDLERS.configStpPortfastDefault)).toEqual({});
    expect(run(r, P2_HANDLERS.configStpBpduguardDefault)).toEqual({});
    expect(r.running.render()).toContain('spanning-tree portfast default');
    expect(r.running.render()).toContain('spanning-tree portfast bpduguard default');
    expect(run(r, P2_HANDLERS.configStpPortfastDefault, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('spanning-tree portfast default');
    expect(r.running.render()).toContain('spanning-tree portfast bpduguard default');
  });
});

describe('the root macro (§5.1, review finding #34)', () => {
  it('compares configured priorities: 24576 below a default root, 4096 below a lower root, a tie is broken', () => {
    const r = sw();
    const t = attach<StpBridgeRow>(r, 'stp-bridge');
    t.set(bridge(1, { rootId: `${32768 + 1}/${ROOT_MAC}` }));
    expect(rootMacroFor(r.ctx, 'primary', 1)).toEqual({ kind: 'store', priority: 24576 });
    // the root already uses 24576 with a lower MAC: primary must undercut it, not tie
    t.set(bridge(1, { rootId: `${24576 + 1}/${ROOT_MAC}` }));
    expect(rootMacroFor(r.ctx, 'primary', 1)).toEqual({ kind: 'store', priority: 20480 });
    t.set(bridge(1, { rootId: `${4096 + 1}/${ROOT_MAC}` }));
    expect(rootMacroFor(r.ctx, 'primary', 1)).toEqual({ kind: 'store', priority: 0 });
    expect(rootMacroFor(r.ctx, 'secondary', 1)).toEqual({ kind: 'store', priority: 28672 });
    // a VLAN without an instance gets the plain macro priorities
    expect(rootMacroFor(r.ctx, 'primary', 99)).toEqual({ kind: 'store', priority: 24576 });
    expect(rootMacroFor(r.ctx, 'secondary', 99)).toEqual({ kind: 'store', priority: 28672 });
  });

  it('stores the priority per VLAN, keeps a better own priority, and refuses when the root is at 0 storing nothing', () => {
    const r = sw();
    const t = attach<StpBridgeRow>(r, 'stp-bridge');
    t.set(bridge(1, { rootId: `${32768 + 1}/${ROOT_MAC}` }));
    t.set(bridge(10, { rootId: `${24576 + 10}/${ROOT_MAC}` }));
    expect(run(r, P2_HANDLERS.configStpVlanRoot, { vlans: '1,10', which: 'primary' })).toEqual({});
    expect(r.configCalls.map((c) => c.line)).toEqual([
      ['spanning-tree', 'vlan', '1', 'priority', '24576'],
      ['spanning-tree', 'vlan', '10', 'priority', '20480'],
    ]);
    // this switch is already the root of VLAN 20 with priority 4096: nothing stored
    t.set(bridge(20, { isRoot: true, bridgeId: `${4096 + 20}/${OWN_MAC}`, rootId: `${4096 + 20}/${OWN_MAC}` }));
    expect(run(r, P2_HANDLERS.configStpVlanRoot, { vlans: '20', which: 'primary' })).toEqual({});
    expect(r.configCalls).toHaveLength(2);
    // this switch is the root at the default: 24576
    t.set(bridge(30, { isRoot: true, bridgeId: `${32768 + 30}/${OWN_MAC}`, rootId: `${32768 + 30}/${OWN_MAC}` }));
    expect(run(r, P2_HANDLERS.configStpVlanRoot, { vlans: '30', which: 'primary' })).toEqual({});
    expect(r.configCalls.at(-1)?.line).toEqual(['spanning-tree', 'vlan', '30', 'priority', '24576']);
    // the root of VLAN 40 uses priority 0: the whole line is refused and VLAN 1 is not touched either
    t.set(bridge(40, { rootId: `${0 + 40}/${ROOT_MAC}` }));
    const calls = r.configCalls.length;
    expect(run(r, P2_HANDLERS.configStpVlanRoot, { vlans: '1,40', which: 'primary' }).error).toBe(CLI_MESSAGES.rootPriorityExhausted.replace('{vlan}', '40'));
    expect(r.configCalls).toHaveLength(calls);
    expect(run(r, P2_HANDLERS.configStpVlanRoot, { vlans: '40', which: 'secondary' })).toEqual({});
    expect(r.configCalls.at(-1)?.line).toEqual(['spanning-tree', 'vlan', '40', 'priority', '28672']);
  });
});

describe('interface lines', () => {
  it('portfast is stored and earns the note on an operational trunk; portfast trunk does not', () => {
    const r = sw({ iface: GI1 });
    r.running.set([['interface', GI1]], ['switchport', 'mode', 'trunk']);
    expect(run(r, P2_HANDLERS.ifStpPortfast)).toEqual({ output: CLI_MESSAGES.portfastOnTrunk.replace('{port}', GI1) });
    expect(r.running.render()).toContain(' spanning-tree portfast\n');
    expect(run(r, P2_HANDLERS.ifStpPortfast, { kind: 'trunk' })).toEqual({});
    expect(r.running.render()).toContain(' spanning-tree portfast trunk');
    expect(r.running.render()).not.toContain(' spanning-tree portfast\n');
    expect(run(r, P2_HANDLERS.ifStpPortfast, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('portfast');
    const access = sw({ iface: FA1 });
    expect(run(access, P2_HANDLERS.ifStpPortfast)).toEqual({});
    expect(run(access, P2_HANDLERS.ifStpPortfast, { kind: 'disable' })).toEqual({});
    expect(access.running.render()).toContain(' spanning-tree portfast disable');
  });

  it('stores bpduguard, guard, cost and port-priority lines (per VLAN too) and validates them', () => {
    const r = sw({ iface: FA1 });
    expect(run(r, P2_HANDLERS.ifStpBpduguard, { mode: 'enable' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpGuard, { mode: 'root' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpCost, { cost: '4' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpPortPriority, { priority: '64' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpPortPriority, { priority: '65' }).error).toBe(MSG_BAD_PORT_PRIORITY);
    expect(run(r, P2_HANDLERS.ifStpVlanCost, { vlans: '10,20', cost: '19' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpVlanPortPriority, { vlans: '10', priority: '32' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifStpVlanPortPriority, { vlans: '10', priority: '33' }).error).toBe(MSG_BAD_PORT_PRIORITY);
    const text = r.running.render();
    expect(text).toContain(' spanning-tree bpduguard enable');
    expect(text).toContain(' spanning-tree guard root');
    expect(text).toContain(' spanning-tree cost 4');
    expect(text).toContain(' spanning-tree port-priority 64');
    expect(text).toContain(' spanning-tree vlan 10 cost 19');
    expect(text).toContain(' spanning-tree vlan 20 cost 19');
    expect(text).toContain(' spanning-tree vlan 10 port-priority 32');
    expect(run(r, P2_HANDLERS.ifStpVlanCost, { vlans: '10' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('vlan 10 cost');
    expect(r.running.render()).toContain('vlan 20 cost 19');
    expect(run(r, P2_HANDLERS.ifStpGuard, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('guard root');
  });

  it('refuses every spanning-tree interface line on a routed port', () => {
    const ports = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const r = commandCtxFor(MLS, { iface: 'GigabitEthernet1/0/24', ports });
    const expected = CLI_MESSAGES.notSwitchport.replace('{port}', 'GigabitEthernet1/0/24');
    for (const id of [P2_HANDLERS.ifStpPortfast, P2_HANDLERS.ifStpBpduguard, P2_HANDLERS.ifStpGuard, P2_HANDLERS.ifStpCost, P2_HANDLERS.ifStpPortPriority, P2_HANDLERS.ifStpVlanCost, P2_HANDLERS.ifStpVlanPortPriority]) {
      expect(run(r, id, { mode: 'enable', kind: 'trunk', cost: '4', priority: '64', vlans: '1' }).error, id).toBe(expected);
    }
    expect(r.configCalls).toEqual([]);
  });
});

describe('show spanning-tree', () => {
  function running(): RecordingCtx {
    const r = sw();
    r.running.set([], ['spanning-tree', 'mode', 'rapid-pvst']);
    r.running.set([], ['spanning-tree', 'portfast', 'default']);
    const b = attach<StpBridgeRow>(r, 'stp-bridge');
    const p = attach<StpPortRow>(r, 'stp');
    b.set(bridge(1, { mode: 'rapid-pvst', topologyChanges: 2, lastChangeAt: 0, lastChangePort: GI2 }));
    b.set(bridge(10, { mode: 'rapid-pvst', isRoot: true, bridgeId: `${4096 + 10}/${OWN_MAC}`, rootId: `${4096 + 10}/${OWN_MAC}`, rootPort: undefined, rootCost: 0 }));
    p.set(port(1, GI1, { role: 'root', state: 'forwarding', cost: 4, portId: '128.25', protocol: 'rstp' }));
    p.set(port(1, GI2, { role: 'alternate', state: 'discarding', cost: 4, portId: '128.26', protocol: 'rstp' }));
    p.set(port(1, FA1, { role: 'designated', state: 'forwarding', edge: true, protocol: 'rstp', portId: '128.1' }));
    p.set(port(1, FA2, { role: 'designated', state: 'discarding', inconsistent: 'root', protocol: 'stp', bpduGuard: true, portId: '128.2', stateSince: 0, nextTransitionAt: 15_000_000_000 }));
    p.set(port(10, GI1, { role: 'designated', state: 'learning', cost: 4, portId: '128.25', protocol: 'rstp' }));
    return r;
  }

  it('says when no instance exists, and refuses a VLAN without one', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.showSpanningTree)).toEqual({ output: MSG_STP_NOT_RUNNING });
    const withTables = running();
    expect(run(withTables, P2_HANDLERS.showSpanningTree, { vlan: '20' }).error).toBe(CLI_MESSAGES.stpVlanMissing.replace('{vlan}', '20'));
  });

  it('renders every instance with root, bridge, timers, topology changes and the port table', () => {
    const r = running();
    const out = lines(run(r, P2_HANDLERS.showSpanningTree).output);
    expect(out[0]).toBe('VLAN0001  (rapid-pvst)');
    expect(out[1]).toBe(`  Root bridge    priority 4097  address ${ROOT_MAC}  reached through ${GI1} at cost 4`);
    expect(out[2]).toBe(`  This bridge    priority 32769  address ${OWN_MAC}  (32768 + VLAN 1)`);
    expect(out[3]).toBe('  Timers         hello 2 s, max age 20 s, forward delay 15 s');
    expect(out[4]).toBe(`  Topology changes  2 (last 00:00:00 ago through ${GI2})`);
    expect(out[6]).toMatch(/^\s+Port\s+Role\s+State\s+Cost\s+Port id\s+Notes$/);
    // canonical port order: Fa0/1, Fa0/2 before Gi0/1, Gi0/2
    expect(out[7]).toMatch(/^\s+FastEthernet0\/1\s+designated\s+forwarding\s+19\s+128\.1\s+edge$/);
    expect(out[8]).toMatch(/^\s+FastEthernet0\/2\s+designated\s+discarding\s+19\s+128\.2\s+root-inconsistent, bpdu guard, classic neighbour$/);
    expect(out[9]).toMatch(/^\s+GigabitEthernet0\/1\s+root\s+forwarding\s+4\s+128\.25\s*$/);
    expect(out[10]).toMatch(/^\s+GigabitEthernet0\/2\s+alternate\s+discarding\s+4\s+128\.26\s*$/);
    const vlan10 = lines(run(r, P2_HANDLERS.showSpanningTree, { vlan: '10' }).output);
    expect(vlan10[0]).toBe('VLAN0010  (rapid-pvst)');
    expect(vlan10[1]).toBe(`  Root bridge    priority 4106  address ${OWN_MAC}  (this switch is the root)`);
    expect(vlan10[4]).toBe('  Topology changes  0 (none yet)');
    expect(vlan10).toHaveLength(8);
    expect(stpPortNotes(port(1, GI1), undefined)).toBe('');
  });

  it('summary counts the ports of each VLAN by state and shows the global settings', () => {
    const out = lines(run(running(), P2_HANDLERS.showSpanningTree, { form: 'summary' }).output);
    expect(out[0]).toBe('Spanning-tree flavour: rapid-pvst');
    expect(out[1]).toBe('Bridge identifiers include the VLAN number: yes');
    expect(out[2]).toBe('PortFast on every non-trunking port by default: yes');
    expect(out[3]).toBe('BPDU guard on edge ports by default: no');
    expect(out[4]).toBe('Root bridge for: VLAN0010');
    expect(out[6]).toMatch(/^VLAN\s+Blocking\s+Listening\s+Learning\s+Forwarding\s+Total$/);
    expect(out[7]).toMatch(/^VLAN0001\s+2\s+0\s+0\s+2\s+4$/);
    expect(out[8]).toMatch(/^VLAN0010\s+0\s+0\s+1\s+0\s+1$/);
    expect(out[9]).toMatch(/^2 VLANs\s+2\s+0\s+1\s+2\s+5$/);
    const one = lines(run(running(), P2_HANDLERS.showSpanningTree, { form: 'summary', vlan: '10' }).output);
    expect(one.at(-1)).toMatch(/^1 VLAN\s+0\s+0\s+1\s+0\s+1$/);
  });

  it('root lists the root of every VLAN with its cost and root port', () => {
    const out = lines(run(running(), P2_HANDLERS.showSpanningTree, { form: 'root' }).output);
    expect(out[0]).toMatch(/^VLAN\s+Root priority\s+Root address\s+Cost\s+Hello\s+Max age\s+Fwd delay\s+Root port$/);
    expect(out[1]).toMatch(new RegExp(`^VLAN0001\\s+4097\\s+${ROOT_MAC}\\s+4\\s+2 s\\s+20 s\\s+15 s\\s+${GI1}$`));
    expect(out[2]).toMatch(new RegExp(`^VLAN0010\\s+4106\\s+${OWN_MAC}\\s+0\\s+2 s\\s+20 s\\s+15 s\\s+\\(this switch\\)$`));
  });

  it('interface lists one port across VLANs, in one VLAN, in detail, and names a port without an instance', () => {
    const r = running();
    const out = lines(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', iface: 'gi0/1' }).output);
    expect(out[0]).toMatch(/^VLAN\s+Role\s+State\s+Cost\s+Port id\s+Notes$/);
    expect(out[1]).toMatch(/^VLAN0001\s+root\s+forwarding\s+4\s+128\.25\s*$/);
    expect(out[2]).toMatch(/^VLAN0010\s+designated\s+learning\s+4\s+128\.25\s*$/);
    expect(out).toHaveLength(3);
    const one = lines(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', iface: GI1, vlan: '10' }).output);
    expect(one).toHaveLength(2);
    const detail = lines(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', detail: 'detail', iface: FA2, vlan: '1' }).output);
    expect(detail[0]).toBe(`${FA2} in VLAN0001`);
    expect(detail[1]).toBe('  Role: designated   State: discarding   Flavour: classic');
    expect(detail[2]).toBe('  Cost: 19   Port id: 128.2   Edge: no');
    expect(detail[3]).toBe(`  Designated bridge: priority 32769  address ${OWN_MAC}   Designated port: 128.1`);
    expect(detail[4]).toBe('  In this state for 00:00:00, next change in 00:00:15');
    expect(detail[5]).toBe('  Inconsistency: root');
    expect(detail[6]).toBe('  BPDU guard: on');
    expect(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', iface: 'FastEthernet0/3' }).output).toBe(MSG_STP_NO_PORT_INSTANCE.replace('{port}', 'FastEthernet0/3'));
    expect(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', iface: FA1, vlan: '10' }).output).toBe(MSG_STP_NO_PORT_INSTANCE.replace('{port}', `${FA1} in VLAN0010`));
    expect(run(r, P2_HANDLERS.showSpanningTree, { form: 'interface', iface: 'nope' }).error).toContain('nope');
  });
});

describe('show dtp interface', () => {
  it('reads the configured and operational modes, negotiation and the dtp row', () => {
    const r = sw();
    r.running.set([['interface', GI1]], ['switchport', 'mode', 'dynamic', 'desirable']);
    const out = lines(run(r, P2_HANDLERS.showDtpInterface, { iface: 'gi0/1' }).output);
    expect(out).toEqual([
      GI1,
      '  Configured mode: dynamic desirable',
      '  Operational mode: access',
      '  Negotiation: on',
      `  Status: waiting (${MSG_DTP_NOTHING_HEARD})`,
      '  Neighbour: none heard',
    ]);
    const t = attach<DtpRow>(r, 'dtp');
    t.set({ key: GI1, updatedAt: 0, port: GI1, admin: 'dynamic-desirable', oper: 'trunk', status: 'negotiated', neighbor: '02:00:00:00:00:09', neighborMode: 'dynamic-auto' });
    const after = lines(run(r, P2_HANDLERS.showDtpInterface, { iface: GI1 }).output);
    expect(after[2]).toBe('  Operational mode: trunk');
    expect(after[4]).toBe('  Status: negotiated with the neighbour');
    expect(after[5]).toBe('  Neighbour: 02:00:00:00:00:09 (dynamic auto)');
    r.running.set([['interface', FA1]], ['switchport', 'mode', 'access']);
    r.running.set([['interface', FA1]], ['switchport', 'nonegotiate']);
    expect(lines(run(r, P2_HANDLERS.showDtpInterface, { iface: FA1 }).output)[4]).toBe('  Status: static (negotiation switched off)');
    expect(run(r, P2_HANDLERS.showDtpInterface, { iface: 'nope' }).error).toContain('nope');
  });
});

describe('clear spanning-tree detected-protocols', () => {
  it('sends the request to stp for every port or for one port', () => {
    const r = sw({ mode: 'priv-exec' });
    expect(run(r, P2_HANDLERS.execClearStpDetected)).toEqual({});
    expect(run(r, P2_HANDLERS.execClearStpDetected, { iface: 'gi0/1' })).toEqual({});
    expect(r.requests).toEqual([
      { to: 'stp', req: { kind: STP_CLEAR_DETECTED_REQUEST, session: 's_1' } },
      { to: 'stp', req: { kind: STP_CLEAR_DETECTED_REQUEST, port: GI1, session: 's_1' } },
    ]);
    expect(run(r, P2_HANDLERS.execClearStpDetected, { iface: 'nope' }).error).toContain('nope');
    expect(r.requests).toHaveLength(2);
  });
});

describe('the W3 fragments, folded into the table by W4 (ARCHITECTURE-P2 §7 W3 cli; §9.2 W4 item 18)', () => {
  const W3 = ['spanning-tree', 'etherchannel', 'port-security', 'errdisable', 'nat', 'acl', 'dhcpv6', 'hsrp'];

  it('adds its fragments after the W2 ones (then the W5 `wlc` fragment closes the table) after the unchanged P1 fragment keys, and their handler ids are in HANDLERS', () => {
    // ARCHITECTURE-P2 §7 W5 cli: the `wlc` fragment is folded in after the W3 ones
    expect(Object.keys(P2_GRAMMAR_FRAGMENTS).slice(4)).toEqual([...W3, 'wlc']);
    expect(Object.keys(GRAMMAR_FRAGMENTS)).toEqual([
      'core-exec', 'show', 'config-global', 'config-if', 'svi', 'switchport', 'serial', 'wireless', 'modules',
      'ipv6', 'dhcp', 'dns', 'services', 'transport', 'traceroute', 'line-auth', 'host-shell',
      'vlan', 'switchport-p2', 'subif', 'routing', ...W3, 'wlc',
    ]);
    for (const id of Object.values(P2_HANDLERS)) expect(Object.values(HANDLERS), id).toContain(id);
    expect(GRAMMAR.slice(GRAMMAR.length - P2_GRAMMAR.length)).toEqual(P2_GRAMMAR);
    expect(BUILTIN_GRAMMAR).toBe(GRAMMAR);
    for (const name of W3) {
      for (const s of P2_GRAMMAR_FRAGMENTS[name] ?? []) {
        expect(P2_HANDLER_REGISTRY[s.handler], `${name}: ${s.path.join(' ')}`).toBeDefined();
        expect(HANDLER_REGISTRY[s.handler]).toBe(P2_HANDLER_REGISTRY[s.handler]);
        expect(s.since).toBe('P2');
      }
    }
  });

  it('registers the §5.4 debug categories through the registry, keyed on the daemons\' capability rows', () => {
    // ARCHITECTURE-P2 §5.4: W5 cli appends `capwap` (capwap-wtp and capwap-ac)
    expect(P2_DEBUG_CATEGORIES.map((d) => d.category)).toEqual(['sw-vlan', 'dtp', 'spanning-tree events', 'etherchannel', 'port-security', 'ip nat', 'standby', 'ipv6 dhcp', 'capwap']);
    for (const d of P2_DEBUG_CATEGORIES) {
      expect(DEBUG_CATEGORIES).toContain(d.category);
      expect(DEBUG_CATEGORY_DEFS).toContain(d);
      expect(d.since).toBe('P2');
      expect(findBannedWords(d.help), d.category).toEqual([]);
      const spec = GRAMMAR.find((s) => s.handler === HANDLERS.execDebug && s.fixedArgs?.category === d.category);
      expect(spec, d.category).toBeDefined();
      expect(P2_DEBUG_GRAMMAR).toContain(spec);
    }
    // the rows are filled by the W4 catalog (§2.1): since the flip a routing model offers the categories of its
    // routing row's daemons — `standby` (hsrp) and, under `debug ip`, `nat` (§9.2 W4 item 18)
    const router = help(GRAMMAR, matchContextFor(catalogModel('router.nf2911'), 'priv-exec'), 'debug ').items.map((i) => i.token);
    expect(router).toEqual(['all', 'arp', 'dhcp', 'dns', 'ethernet', 'ip', 'ipv6', 'standby', 'tcp', 'traceroute', 'udp']);
  });

  it('uses original wording in help, args and messages', () => {
    const texts: [string, string][] = [];
    for (const name of W3) {
      for (const s of P2_GRAMMAR_FRAGMENTS[name] ?? []) {
        texts.push([s.path.join(' '), s.help]);
        for (const [k, a] of Object.entries(s.args ?? {})) texts.push([`${s.path.join(' ')} <${k}>`, a.help]);
      }
    }
    for (const t of [MSG_BAD_BRIDGE_PRIORITY, MSG_BAD_PORT_PRIORITY, MSG_BAD_VLAN_LIST, MSG_STP_NOT_RUNNING, MSG_STP_NO_PORT_INSTANCE, MSG_DTP_NOTHING_HEARD]) texts.push(['stp message', t]);
    expect(texts.length).toBeGreaterThan(100);
    for (const [where, t] of texts) expect(findBannedWords(t), where).toEqual([]);
  });
});
