/**
 * cli/grammar/ospf.ts and cli/handlers/ospf.ts (ARCHITECTURE-P3 §5.1, §5.8, D7, D11; §7 W2 cli part 1): every OSPF
 * configuration line with its storage and refusals (one process, `no ip routing`, a network in another area, the
 * passive default and its stored negations, the router-id note, another pid's area line), `bandwidth` widened to routed
 * Ethernet ports and subinterfaces, `show ip ospf [neighbor|interface [brief]]` against fake tables and the §2.6
 * StateView, the second `show ip route` legend line with the `O` codes, `clear ip ospf process` (interactive), the
 * `config-router` mode (no longer reserved, §9.2 W2 item 22), and one console session on a real P3-stage router.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { OspfInterfaceRow, OspfNeighborRow, OspfStateView, RouteRow, Table, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  MSG_CLEAR_OSPF_CANCELLED,
  MSG_NO_OSPF,
  MSG_NO_OSPF_NEIGHBOUR,
  MSG_NO_OSPF_SELECTED,
  MSG_OSPF_NOT_ON,
  MSG_REFERENCE_NOTE,
  MSG_ROUTER_ID_ZERO,
} from '../src/cli/handlers/ospf.js';
import { ROUTE_CODES_LEGEND, ROUTE_DHCP_DEFAULT_NOTE, renderRoute, routeCode } from '../src/cli/handlers/show.js';
import { modeForContext, modePromptSuffix, modesOfClass } from '../src/cli/modes.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const MLS = catalogModel('mlswitch.nfc3650-24');
const SWITCH = catalogModel('switch.nfc2960');
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const OSPF1 = [['router', 'ospf', '1']];

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

function router(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(ROUTER, { mode: 'config', ...opts });
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name as never, t as unknown as Table<TableRow>);
  return t;
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);
const tokens = (ctx: ReturnType<typeof matchContextFor>, partial: string): string[] => help(GRAMMAR, ctx, partial).items.map((i) => i.token);
const sectionLines = (rec: RecordingCtx): string[] => {
  const text = rec.running.render().split('\n');
  const at = text.indexOf('router ospf 1');
  if (at === -1) return [];
  const out = [text[at] as string];
  for (let i = at + 1; i < text.length && (text[i] as string).startsWith(' '); i++) out.push(text[i] as string);
  return out;
};

describe('parsing and scope', () => {
  it('parses every §5.1 line on a router and refuses them where they do not belong', () => {
    const cfg = matchContextFor(ROUTER, 'config');
    expect(ok(cfg, 'router ospf 1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configRouterOspf, entersMode: 'config-router' }, args: { pid: '1' } });
    expect(ok(cfg, 'router ospf 0')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(ok(cfg, 'no router ospf 7')).toMatchObject({ ok: true, negated: true, args: { pid: '7' } });
    const rtr = matchContextFor(ROUTER, 'config-router');
    expect(ok(rtr, 'router-id 1.1.1.1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ospfRouterId }, args: { id: '1.1.1.1' } });
    expect(ok(rtr, 'router ospf 1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configRouterOspf, hidden: true }, args: { pid: '1' } });
    expect(ok(rtr, 'router-i 1.1.1.1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ospfRouterId } });
    expect(ok(rtr, 'network 10.0.0.0 0.0.0.255 area 0')).toMatchObject({ ok: true, args: { address: '10.0.0.0', wildcard: '0.0.0.255', area: '0' } });
    expect(ok(rtr, 'network 10.0.0.0 0.0.0.255 area 0.0.0.10')).toMatchObject({ ok: true, args: { area: '0.0.0.10' } });
    expect(ok(rtr, 'passive-interface g0/1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ospfPassiveInterface }, args: { iface: GI1 } });
    expect(ok(rtr, 'passive-interface default')).toMatchObject({ ok: true, args: { default: 'default' } });
    expect(ok(rtr, 'auto-cost reference-bandwidth 1000')).toMatchObject({ ok: true, args: { mbps: '1000' } });
    expect(ok(rtr, 'default-information originate')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ospfDefaultInformation } });
    expect(ok(rtr, 'default-information originate always')).toMatchObject({ ok: true, args: { always: 'always' } });
    expect(ok(rtr, 'maximum-paths 2')).toMatchObject({ ok: true, args: { paths: '2' } });
    expect(ok(rtr, 'maximum-paths 5')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(ok(ifc, 'ip ospf 1 area 0')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifIpOspf }, args: { setting: 'area', pid: '1', area: '0' } });
    expect(ok(ifc, 'ip ospf cost 10')).toMatchObject({ ok: true, args: { setting: 'cost', cost: '10' } });
    expect(ok(ifc, 'ip ospf priority 0')).toMatchObject({ ok: true, args: { setting: 'priority', priority: '0' } });
    expect(ok(ifc, 'ip ospf hello-interval 5')).toMatchObject({ ok: true, args: { setting: 'hello-interval', seconds: '5' } });
    expect(ok(ifc, 'ip ospf dead-interval 20')).toMatchObject({ ok: true, args: { setting: 'dead-interval', seconds: '20' } });
    expect(ok(ifc, 'ip ospf network point-to-point')).toMatchObject({ ok: true, args: { setting: 'network', type: 'point-to-point' } });
    expect(ok(ifc, 'no ip ospf cost')).toMatchObject({ ok: true, negated: true });
    // the L2 switch runs no OSPF; the multilayer switch does, but not on a switched port
    expect(ok(matchContextFor(SWITCH, 'config'), 'router ospf 1').ok).toBe(false);
    expect(ok(matchContextFor(MLS, 'config'), 'router ospf 1').ok).toBe(true);
    const switched = matchContextFor(MLS, 'config-if', { iface: 'GigabitEthernet1/0/1' });
    expect(ok(switched, 'ip ospf cost 10')).toMatchObject({ ok: false, kind: 'port-unsupported' });
  });

  it('widens bandwidth to routed Ethernet ports and subinterfaces (§9.2 W2)', () => {
    const gig = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(ok(gig, 'bandwidth 10000')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifBandwidth }, args: { kbps: '10000' } });
    const serial = matchContextFor(ROUTER, 'config-if', { iface: 'Serial0/0/0' });
    expect(ok(serial, 'bandwidth 64')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifBandwidth } });
    const ports = devicePortViews(ROUTER);
    const parent = ports.get(GI0)!;
    const sub = { ...parent, id: 'GigabitEthernet0/0.10', role: 'subif' as const, spec: { ...parent.spec, name: 'GigabitEthernet0/0.10', kind: 'virtual' as const, role: 'subif' as const, allowedRoles: ['subif' as const] } };
    ports.set(sub.id, sub);
    const subCtx = matchContextFor(ROUTER, 'config-subif', { ports, ifaceView: sub });
    expect(ok(subCtx, 'bandwidth 5000')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifBandwidth } });
    // a switched port of the multilayer switch is refused
    expect(ok(matchContextFor(MLS, 'config-if', { iface: 'GigabitEthernet1/0/1' }), 'bandwidth 1000')).toMatchObject({ ok: false, kind: 'port-unsupported' });
    const r = router({ iface: GI0 });
    expect(run(r, HANDLERS.ifBandwidth, { kbps: '10000' })).toEqual({});
    expect(r.running.render()).toContain('interface GigabitEthernet0/0\n bandwidth 10000\n');
    expect(run(r, HANDLERS.ifBandwidth, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('bandwidth 10000');
  });

  it('lists the OSPF words in help', () => {
    expect(tokens(matchContextFor(ROUTER, 'config'), '')).toContain('router');
    expect(tokens(matchContextFor(ROUTER, 'config-router'), '')).toEqual([
      'auto-cost', 'default-information', 'do', 'end', 'exit', 'maximum-paths', 'network', 'no', 'passive-interface', 'router-id',
    ]);
    // ARCHITECTURE-P3 §9.2 W3 item 30e: `show ip ospf database` joins
    expect(tokens(matchContextFor(ROUTER, 'priv-exec'), 'show ip ospf ')).toEqual(['database', 'interface', 'neighbor', '|']);
    expect(tokens(matchContextFor(ROUTER, 'priv-exec'), 'show ip route ')).toContain('ospf');
  });

  it('enters config-router, which is no longer reserved (§9.2 W2 item 22)', () => {
    expect(modeForContext(OSPF1)).toBe('config-router');
    expect(modePromptSuffix('config-router')).toBe('(config-router)#');
    expect(modesOfClass('config')).toContain('config-router');
  });
});

describe('router ospf', () => {
  it('stores the section and enters config-router', () => {
    const r = router();
    expect(run(r, HANDLERS.configRouterOspf, { pid: '1' })).toEqual({});
    expect(r.configCalls).toEqual([{ line: ['router', 'ospf', '1'], negate: false, context: [] }]);
    expect(r.enterModeCalls).toEqual([{ mode: 'config-router', opts: { context: OSPF1 } }]);
    expect(r.running.render()).toContain('\nrouter ospf 1\n');
    // the same process again is just a re-entry
    expect(run(r, HANDLERS.configRouterOspf, { pid: '1' })).toEqual({});
  });

  it('refuses a second process and a process under no ip routing', () => {
    const r = router();
    run(r, HANDLERS.configRouterOspf, { pid: '1' });
    expect(run(r, HANDLERS.configRouterOspf, { pid: '2' })).toEqual({ error: CLI_MESSAGES.ospfOneProcess.replaceAll('{pid}', '1') });
    const s = commandCtxFor(MLS, { mode: 'config' });
    s.running.set([], ['no', 'ip', 'routing']);
    expect(run(s, HANDLERS.configRouterOspf, { pid: '1' })).toEqual({ error: CLI_MESSAGES.ospfNeedsIpRouting });
  });

  it('no router ospf removes the process; an absent one stores nothing', () => {
    const r = router();
    expect(run(r, HANDLERS.configRouterOspf, { pid: '3' }, true)).toEqual({});
    expect(r.configCalls).toEqual([]);
    run(r, HANDLERS.configRouterOspf, { pid: '1' });
    run(router({ context: OSPF1, running: r.running }), HANDLERS.ospfNetwork, { address: '10.0.0.0', wildcard: '0.0.0.255', area: '0' });
    expect(run(r, HANDLERS.configRouterOspf, { pid: '1' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('router ospf');
    expect(r.running.render()).not.toContain('network');
  });
});

describe('config-router lines', () => {
  function process(): { r: RecordingCtx; inside: RecordingCtx } {
    const r = router();
    run(r, HANDLERS.configRouterOspf, { pid: '1' });
    return { r, inside: router({ context: OSPF1, running: r.running }) };
  }

  it('need the OSPF section', () => {
    const r = router({ context: [['line', 'vty', '0', '4']] });
    expect(run(r, HANDLERS.ospfRouterId, { id: '1.1.1.1' })).toEqual({ error: MSG_NO_OSPF_SELECTED });
    expect(run(r, HANDLERS.ospfNetwork, { address: '10.0.0.0', wildcard: '0.0.0.255', area: '0' })).toEqual({ error: MSG_NO_OSPF_SELECTED });
  });

  it('render in the router child order', () => {
    const { r, inside } = process();
    run(inside, HANDLERS.ospfMaximumPaths, { paths: '2' });
    run(inside, HANDLERS.ospfNetwork, { address: '10.0.12.0', wildcard: '0.0.0.3', area: '0' });
    run(inside, HANDLERS.ospfDefaultInformation, { always: 'always' });
    run(inside, HANDLERS.ospfPassiveInterface, { iface: GI1 });
    expect(run(inside, HANDLERS.ospfAutoCost, { mbps: '1000' })).toEqual({ output: MSG_REFERENCE_NOTE });
    run(inside, HANDLERS.ospfRouterId, { id: '1.1.1.1' });
    expect(sectionLines(r)).toEqual([
      'router ospf 1',
      ' router-id 1.1.1.1',
      ' auto-cost reference-bandwidth 1000',
      ' passive-interface GigabitEthernet0/1',
      ' network 10.0.12.0 0.0.0.3 area 0',
      ' default-information originate always',
      ' maximum-paths 2',
    ]);
    // the no forms
    run(inside, HANDLERS.ospfDefaultInformation, {}, true);
    run(inside, HANDLERS.ospfMaximumPaths, {}, true);
    run(inside, HANDLERS.ospfAutoCost, {}, true);
    run(inside, HANDLERS.ospfRouterId, {}, true);
    expect(sectionLines(r)).toEqual(['router ospf 1', ' passive-interface GigabitEthernet0/1', ' network 10.0.12.0 0.0.0.3 area 0']);
  });

  it('router-id refuses 0.0.0.0 and notes a change while the process runs', () => {
    const { r } = process();
    expect(run(router({ context: OSPF1, running: r.running }), HANDLERS.ospfRouterId, { id: '0.0.0.0' })).toEqual({ error: MSG_ROUTER_ID_ZERO });
    const sv: OspfStateView = {
      process: { pid: 1, routerId: '10.0.12.1', startedAt: 0, referenceBandwidthMbps: 100, maximumPaths: 4 },
      spf: { runs: 0 }, interfaces: [], neighbors: [], trees: [],
    };
    const running = router({ context: OSPF1, running: r.running, processStates: { ospf: { process: 'ospf', state: sv as unknown as Record<string, unknown> } } });
    expect(run(running, HANDLERS.ospfRouterId, { id: '1.1.1.1' })).toEqual({ output: CLI_MESSAGES.ospfRouterIdLater });
    expect(run(running, HANDLERS.ospfRouterId, { id: '10.0.12.1' })).toEqual({});
  });

  it('network: stored masked, the same area another way is a no-op, another area is refused', () => {
    const { r, inside } = process();
    expect(run(inside, HANDLERS.ospfNetwork, { address: '10.0.12.1', wildcard: '0.0.0.255', area: '0' })).toEqual({});
    expect(sectionLines(r)).toContain(' network 10.0.12.0 0.0.0.255 area 0');
    expect(run(inside, HANDLERS.ospfNetwork, { address: '10.0.12.0', wildcard: '0.0.0.255', area: '0.0.0.0' })).toEqual({});
    expect(sectionLines(r).filter((l) => l.startsWith(' network'))).toEqual([' network 10.0.12.0 0.0.0.255 area 0']);
    expect(run(inside, HANDLERS.ospfNetwork, { address: '10.0.12.0', wildcard: '0.0.0.255', area: '1' })).toEqual({
      error: CLI_MESSAGES.ospfNetworkOtherArea.replace('{net}', '10.0.12.0').replace('{wildcard}', '0.0.0.255').replace('{area}', '0'),
    });
    // the no form removes the stored line whatever the typed host bits and area spelling
    expect(run(inside, HANDLERS.ospfNetwork, { address: '10.0.12.9', wildcard: '0.0.0.255', area: '0.0.0.0' }, true)).toEqual({});
    expect(sectionLines(r)).toEqual(['router ospf 1']);
  });

  it('passive-interface: the default keeps negations, and dropping it clears them; without it no negation is stored', () => {
    const { r, inside } = process();
    run(inside, HANDLERS.ospfPassiveInterface, { iface: GI1 });
    expect(run(inside, HANDLERS.ospfPassiveInterface, { iface: GI1 }, true)).toEqual({});
    expect(sectionLines(r)).toEqual(['router ospf 1']);
    run(inside, HANDLERS.ospfPassiveInterface, { default: 'default' });
    expect(run(inside, HANDLERS.ospfPassiveInterface, { iface: GI0 }, true)).toEqual({});
    expect(sectionLines(r)).toEqual(['router ospf 1', ' passive-interface default', ' no passive-interface GigabitEthernet0/0']);
    // a positive line under the default cancels the stored negation
    run(inside, HANDLERS.ospfPassiveInterface, { iface: GI0 });
    expect(sectionLines(r)).not.toContain(' no passive-interface GigabitEthernet0/0');
    run(inside, HANDLERS.ospfPassiveInterface, { iface: GI1 }, true);
    expect(sectionLines(r)).toContain(' no passive-interface GigabitEthernet0/1');
    expect(run(inside, HANDLERS.ospfPassiveInterface, { default: 'default' }, true)).toEqual({});
    expect(sectionLines(r).filter((l) => l.includes('passive-interface') && l.includes('no '))).toEqual([]);
    expect(sectionLines(r)).not.toContain(' passive-interface default');
  });
});

describe('interface lines', () => {
  it('store the ip ospf lines; another pid replaces the area line; the no form removes it whatever its spelling', () => {
    const r = router({ iface: GI0 });
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'area', pid: '1', area: '0' })).toEqual({});
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'cost', cost: '10' })).toEqual({});
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'priority', priority: '0' })).toEqual({});
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'hello-interval', seconds: '5' })).toEqual({});
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'dead-interval', seconds: '20' })).toEqual({});
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'network', type: 'point-to-point' })).toEqual({});
    const text = r.running.render();
    for (const l of ['ip ospf 1 area 0', 'ip ospf cost 10', 'ip ospf priority 0', 'ip ospf hello-interval 5', 'ip ospf dead-interval 20', 'ip ospf network point-to-point']) {
      expect(text, l).toContain(` ${l}\n`);
    }
    run(r, HANDLERS.ifIpOspf, { setting: 'area', pid: '2', area: '1' });
    expect(r.running.render()).toContain(' ip ospf 2 area 1\n');
    expect(r.running.render()).not.toContain('ip ospf 1 area 0');
    expect(run(r, HANDLERS.ifIpOspf, { setting: 'area', pid: '2', area: '0.0.0.1' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('area');
    run(r, HANDLERS.ifIpOspf, { setting: 'cost' }, true);
    expect(r.running.render()).not.toContain('ip ospf cost');
  });
});

describe('shows', () => {
  const IF_ROW: OspfInterfaceRow = {
    key: GI0, updatedAt: 0, port: GI0, process: 1, routerId: '1.1.1.1', area: '0.0.0.0', networkType: 'broadcast', state: 'backup',
    address: '10.0.123.1', prefixLen: 24, cost: 1, costSource: 'bandwidth', priority: 1, helloS: 10, deadS: 40, passive: false,
    dr: '2.2.2.2', drAddress: '10.0.123.2', bdr: '1.1.1.1', bdrAddress: '10.0.123.1', neighbors: 2, adjacent: 2, stateSince: 0,
  };
  const LO_ROW: OspfInterfaceRow = {
    ...IF_ROW, key: 'Loopback0', port: 'Loopback0', networkType: 'loopback', state: 'loopback', address: '1.1.1.1', prefixLen: 32,
    dr: undefined, drAddress: undefined, bdr: undefined, bdrAddress: undefined, neighbors: 0, adjacent: 0,
  } as unknown as OspfInterfaceRow;
  const NBRS: OspfNeighborRow[] = [
    { key: `${GI0}|3.3.3.3`, updatedAt: 0, port: GI0, routerId: '3.3.3.3', address: '10.0.123.3', priority: 1, state: 'full', role: 'drother', dr: '2.2.2.2', bdr: '1.1.1.1', stateSince: 0 },
    { key: `${GI0}|2.2.2.2`, updatedAt: 0, port: GI0, routerId: '2.2.2.2', address: '10.0.123.2', priority: 1, state: 'full', role: 'dr', dr: '2.2.2.2', bdr: '1.1.1.1', stateSince: 0 },
  ];
  const NOW = 100 * SEC;
  const SV: OspfStateView = {
    process: { pid: 1, routerId: '1.1.1.1', startedAt: 40 * SEC, referenceBandwidthMbps: 100, maximumPaths: 4 },
    spf: { runs: 2, lastAt: 90 * SEC, lastReason: 'a neighbour became full' },
    interfaces: [{ port: GI0, helloDueAt: 104 * SEC }],
    neighbors: [
      { port: GI0, routerId: '2.2.2.2', deadAt: 134 * SEC, retransmitQueue: 0 },
      { port: GI0, routerId: '3.3.3.3', deadAt: 131 * SEC, retransmitQueue: 0 },
    ],
    trees: [],
  };

  function world(): RecordingCtx {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec', processStates: { ospf: { process: 'ospf', state: SV as unknown as Record<string, unknown> } } });
    (r.ctx as { now: number }).now = NOW;
    r.running.set([], ['router', 'ospf', '1']);
    r.running.set(OSPF1, ['network', '10.0.123.0', '0.0.0.255', 'area', '0']);
    const ifs = attach<OspfInterfaceRow>(r, 'ospf-interfaces');
    ifs.set(IF_ROW);
    ifs.set(LO_ROW);
    const nbrs = attach<OspfNeighborRow>(r, 'ospf-neighbors');
    for (const n of NBRS) nbrs.set(n);
    return r;
  }

  it('print nothing but a note without a process', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    expect(run(r, HANDLERS.showIpOspf)).toEqual({ output: MSG_NO_OSPF });
    expect(run(r, HANDLERS.showIpOspfNeighbor)).toEqual({ output: MSG_NO_OSPF });
    expect(run(r, HANDLERS.showIpOspfInterface)).toEqual({ output: MSG_NO_OSPF });
  });

  it('show ip ospf neighbor: one row per neighbour with the dead countdown (§5.8 shape)', () => {
    expect(run(world(), HANDLERS.showIpOspfNeighbor).output!.split('\n')).toEqual([
      'Neighbour ID     Pri  State            Dead in    Address        Interface',
      '2.2.2.2            1  FULL/DR          00:00:34   10.0.123.2     GigabitEthernet0/0',
      '3.3.3.3            1  FULL/DROTHER     00:00:31   10.0.123.3     GigabitEthernet0/0',
    ]);
    const empty = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    empty.running.set([], ['router', 'ospf', '1']);
    expect(run(empty, HANDLERS.showIpOspfNeighbor)).toEqual({ output: MSG_NO_OSPF_NEIGHBOUR });
  });

  it('show ip ospf interface brief (§5.8 shape) and the detailed block', () => {
    expect(run(world(), HANDLERS.showIpOspfInterface, { brief: 'brief' }).output!.split('\n')).toEqual([
      'Interface  Process  Area  Address/Mask     Cost  State  Neighbours full/total',
      'Gi0/0      1        0     10.0.123.1/24    1     BDR    2/2',
      'Lo0        1        0     1.1.1.1/32       1     LOOP   0/0',
    ].map((l) => l.replace(/\s+$/, '')));
    const block = run(world(), HANDLERS.showIpOspfInterface, { iface: GI0 }).output!.split('\n');
    expect(block[1]).toBe('  Address 10.0.123.1/24, area 0.0.0.0, process 1, router ID 1.1.1.1');
    expect(block[2]).toBe('  Network type BROADCAST, cost 1 (from the bandwidth)');
    expect(block[3]).toBe('  State BDR, priority 1');
    expect(block[4]).toBe('  Designated router 2.2.2.2 (10.0.123.2), backup 1.1.1.1 (10.0.123.1)');
    expect(block[5]).toBe('  Timers: hello 10 s, dead 40 s, next hello in 00:00:04');
    expect(run(world(), HANDLERS.showIpOspfInterface, { iface: GI1 })).toEqual({ output: MSG_OSPF_NOT_ON(GI1) });
  });

  it('show ip ospf: the process, its timers and areas', () => {
    const out = run(world(), HANDLERS.showIpOspf).output!.split('\n');
    expect(out[0]).toBe('OSPF process 1, router ID 1.1.1.1');
    expect(out[1]).toBe('  Running for 00:01:00');
    expect(out).toContain('  Shortest-path calculation: 2 runs, last run 00:00:10 ago (a neighbour became full); no run scheduled');
    expect(out).toContain('  Area 0.0.0.0 (backbone): 2 interfaces, 2 fully adjacent neighbours');
  });
});

describe('show ip route: the second legend line and the O codes (D11)', () => {
  const route = (r: Partial<RouteRow> & Pick<RouteRow, 'network' | 'prefixLen' | 'source'>): RouteRow =>
    ({ key: `${r.network}/${r.prefixLen}`, updatedAt: 0, ad: 110, metric: 3, ...r }) as RouteRow;

  it('keeps the P1 legend alone without a routing process', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.ctx.tables.rib.set(route({ network: '10.0.0.0', prefixLen: 24, source: 'C', iface: GI0, ad: 0, metric: 0 }));
    const out = run(r, HANDLERS.showIpRoute).output!.split('\n');
    expect(out.slice(0, 3)).toEqual([ROUTE_CODES_LEGEND, '', 'Default route: none configured']);
  });

  it('adds the OSPF codes with a router ospf section, and shows O, O E2 and O*E2', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.running.set([], ['router', 'ospf', '1']);
    r.ctx.tables.rib.set(route({ network: '10.3.0.0', prefixLen: 24, source: 'O', nextHop: '10.0.12.2', iface: GI0 }));
    r.ctx.tables.rib.set(route({ network: '0.0.0.0', prefixLen: 0, source: 'O', routeType: 'E2', isDefault: true, nextHop: '10.0.12.2', iface: GI0, metric: 1 }));
    const out = run(r, HANDLERS.showIpRoute).output!.split('\n');
    expect(out.slice(0, 4)).toEqual([
      ROUTE_CODES_LEGEND,
      'Dynamic sources: O - OSPF, IA - OSPF inter area, E1/E2 - OSPF external type 1/2',
      '',
      'Default route: via 10.0.12.2 (O*E2)',
    ]);
    expect(out).toContain('O*E2 0.0.0.0/0  via 10.0.12.2 [110/1] GigabitEthernet0/0');
    expect(out).toContain('O    10.3.0.0/24  via 10.0.12.2 [110/3] GigabitEthernet0/0');
    expect(renderRoute(route({ network: '10.9.0.0', prefixLen: 16, source: 'O', routeType: 'E2', nextHop: '10.0.12.2', iface: GI0 }))).toBe('O E2 10.9.0.0/16  via 10.0.12.2 [110/3] GigabitEthernet0/0');
    // show ip route ospf filters the O rows
    const only = run(r, HANDLERS.showIpRoute, { source: 'O' }).output!.split('\n');
    expect(only.filter((l) => l.startsWith('O'))).toHaveLength(2);
    const none = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    none.running.set([], ['router', 'ospf', '1']);
    expect(run(none, HANDLERS.showIpRoute, { source: 'O' }).output).toContain('The routing table holds no OSPF route.');
    expect(matchCommand(GRAMMAR, matchContextFor(ROUTER, 'user-exec'), 'show ip route ospf')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showIpRoute }, args: { source: 'O' } });
  });

  it('[C1] renders EIGRP as D and notes a DHCP default', () => {
    expect(routeCode(route({ network: '10.4.0.0', prefixLen: 24, source: 'EIGRP' }))).toBe('D');
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.running.set([], ['router', 'eigrp', '100']);
    r.ctx.tables.rib.set(route({ network: '0.0.0.0', prefixLen: 0, source: 'D', isDefault: true, nextHop: '10.0.0.1', iface: GI0, ad: 254, metric: 0 }));
    const out = run(r, HANDLERS.showIpRoute).output!.split('\n');
    expect(out.slice(0, 3)).toEqual([ROUTE_CODES_LEGEND, 'Dynamic sources: D - EIGRP', ROUTE_DHCP_DEFAULT_NOTE]);
  });
});

describe('clear ip ospf process', () => {
  it('asks, then sends ospf.clear on yes only; it is interactive (refused headless)', () => {
    const spec = GRAMMAR.find((s) => s.handler === HANDLERS.execClearIpOspf)!;
    expect(spec.interactive).toBe(true);
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    expect(run(r, HANDLERS.execClearIpOspf)).toEqual({ output: MSG_NO_OSPF });
    r.running.set([], ['router', 'ospf', '1']);
    const asked = run(r, HANDLERS.execClearIpOspf);
    expect(asked.ask?.request).toEqual({ kind: 'confirm', prompt: CLI_MESSAGES.clearOspfConfirm });
    expect(asked.ask!.resume(r.ctx, 'no', 1)).toEqual({ output: MSG_CLEAR_OSPF_CANCELLED });
    expect(r.requests).toEqual([]);
    expect(asked.ask!.resume(r.ctx, 'yes', 1)).toEqual({});
    expect(r.requests).toEqual([{ to: 'ospf', req: { kind: 'ospf.clear', session: 's_1' } }]);
  });
});

describe('a console session on a P3-stage router', () => {
  it('enters config-router, stores the lines and shows them in the running configuration', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(r1, 'console');
    for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(s, line).error).toBeUndefined();
    const entered = sim.cli.exec(s, 'router ospf 1');
    expect(entered.error).toBeUndefined();
    expect(entered.mode).toBe('config-router');
    expect(entered.prompt).toBe('R1(config-router)#');
    expect(sim.cli.exec(s, 'network 10.0.0.1 0.0.0.255 area 0').error).toBeUndefined();
    expect(sim.cli.exec(s, 'router-id 1.1.1.1').error).toBeUndefined();
    // typed inside config-router (a hidden spec: `router` alone would abbreviate `router-id` there)
    const second = sim.cli.exec(s, 'router ospf 2');
    expect(second.output).toContain(CLI_MESSAGES.ospfOneProcess.replaceAll('{pid}', '1'));
    sim.cli.exec(s, 'end');
    // re-entering the same process from inside its own section, and from config
    sim.cli.exec(s, 'configure terminal');
    sim.cli.exec(s, 'router ospf 1');
    expect(sim.cli.exec(s, 'router ospf 1').prompt).toBe('R1(config-router)#');
    expect(sim.cli.exec(s, 'router-id 1.1.1.1').error).toBeUndefined();
    sim.cli.exec(s, 'end');
    const run1 = sim.cli.exec(s, 'show running-config').output;
    expect(run1).toContain('router ospf 1\n router-id 1.1.1.1\n network 10.0.0.0 0.0.0.255 area 0\n');
  });
});
