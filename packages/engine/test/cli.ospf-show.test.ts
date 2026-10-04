/**
 * cli/handlers/ospf.ts, the W3 shows (ARCHITECTURE-P3 §5.8, §7 W3 cli part 2; rule 20): `show ip ospf neighbor detail`
 * ("Dead in" from the StateView's `neighbors[].deadAt`, the retransmission queue, the exchange role), `show ip ospf
 * database [router|network|external] [self-originate]` over `ospf-lsdb` rows (the live age `lsaAgeAt`, the database
 * order, hex sequence and checksum, one block per LSA in the typed forms), and `show ip protocols` (the OSPF section
 * with the StateView's `spf` statistics and the LSDB's advertising routers; the [C1] EIGRP section from the
 * configuration, the eigrp StateView and the `eigrp-neighbors` rows). Against fake tables and the §2.6 StateView
 * shapes; one parse case per new path.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import {
  ospfLsaKey,
  type EigrpNeighborRow,
  type EigrpStateView,
  type OspfInterfaceRow,
  type OspfLsaRow,
  type OspfNeighborRow,
  type OspfStateView,
  type Table,
  type TableRow,
} from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { OSPF_DB_SELF_ARG, OSPF_DB_TYPE_ARG, OSPF_SHOW_DETAIL_ARG } from '../src/cli/grammar/ospf.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { lsaChecksumHex, lsaSeqHex, MSG_NO_OSPF, MSG_NO_ROUTING_PROCESS, MSG_OSPF_DB_EMPTY } from '../src/cli/handlers/ospf.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const OSPF1 = [['router', 'ospf', '1']];
const NOW = 100 * SEC;

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, false);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name as never, t as unknown as Table<TableRow>);
  return t;
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

// ── fixtures (§2.6 shapes) ─────────────────────────────────────────────────────────────────────────────────────

const IF_ROW: OspfInterfaceRow = {
  key: GI0, updatedAt: 0, port: GI0, process: 1, routerId: '1.1.1.1', area: '0.0.0.0', networkType: 'broadcast', state: 'backup',
  address: '10.0.123.1', prefixLen: 24, cost: 1, costSource: 'bandwidth', priority: 1, helloS: 10, deadS: 40, passive: false,
  dr: '2.2.2.2', drAddress: '10.0.123.2', bdr: '1.1.1.1', bdrAddress: '10.0.123.1', neighbors: 2, adjacent: 2, stateSince: 0,
};
const NBRS: OspfNeighborRow[] = [
  { key: `${GI0}|3.3.3.3`, updatedAt: 0, port: GI0, routerId: '3.3.3.3', address: '10.0.123.3', priority: 1, state: 'full', role: 'drother', dr: '10.0.123.2', bdr: '10.0.123.1', stateSince: 70 * SEC, master: false },
  { key: `${GI0}|2.2.2.2`, updatedAt: 0, port: GI0, routerId: '2.2.2.2', address: '10.0.123.2', priority: 1, state: 'full', role: 'dr', dr: '10.0.123.2', bdr: '10.0.123.1', stateSince: 40 * SEC, master: true },
  { key: `${GI1}|4.4.4.4`, updatedAt: 0, port: GI1, routerId: '4.4.4.4', address: '10.0.14.4', priority: 0, state: 'init', role: 'none', dr: '0.0.0.0', bdr: '0.0.0.0', stateSince: 95 * SEC },
];

/** The §2.6 ospf StateView (display only). */
function stateView(over: Partial<OspfStateView> = {}): OspfStateView {
  return {
    process: { pid: 1, routerId: '1.1.1.1', startedAt: 10 * SEC, referenceBandwidthMbps: 100, maximumPaths: 4 },
    spf: { runs: 3, lastAt: 95 * SEC, nextAt: 103 * SEC, holdUntil: 105 * SEC, lastReason: 'a neighbour became full' },
    interfaces: [{ port: GI0, helloDueAt: 104 * SEC }],
    neighbors: [
      { port: GI0, routerId: '2.2.2.2', deadAt: 134 * SEC, retransmitQueue: 0 },
      { port: GI0, routerId: '3.3.3.3', deadAt: 131 * SEC, retransmitQueue: 2 },
    ],
    trees: [],
    ...over,
  };
}

function lsa(over: Partial<OspfLsaRow> & Pick<OspfLsaRow, 'scope' | 'type' | 'lsid' | 'advRouter'>): OspfLsaRow {
  return {
    key: ospfLsaKey(over.scope, over.type, over.lsid, over.advRouter),
    updatedAt: 0, seq: 0x80000001, ageAtInstall: 0, installedAt: 90 * SEC, checksum: 0x1a2b, length: 36, options: 2, self: false,
    ...over,
  };
}

/** The LSDB of R1 (1.1.1.1) on a LAN with 2.2.2.2 (DR) and 3.3.3.3, a serial link to 4.4.4.4, and a default route. */
const LSDB: OspfLsaRow[] = [
  lsa({ scope: 'as', type: 5, lsid: '0.0.0.0', advRouter: '1.1.1.1', self: true, seq: 0x80000002, checksum: 0x7a8b, mask: '0.0.0.0', metric: 1, external: { e2: true, forward: '0.0.0.0', tag: 1 }, installedAt: 80 * SEC }),
  lsa({ scope: '0.0.0.0', type: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000004, checksum: 0x00ef, length: 36, mask: '255.255.255.0', attached: ['2.2.2.2', '1.1.1.1', '3.3.3.3'], installedAt: 97 * SEC }),
  lsa({ scope: '0.0.0.0', type: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000003, length: 36, links: [{ kind: 'transit', id: '10.0.123.2', data: '10.0.123.2', metric: 1 }], installedAt: 96 * SEC, ageAtInstall: 2 }),
  lsa({
    scope: '0.0.0.0', type: 1, lsid: '1.1.1.1', advRouter: '1.1.1.1', self: true, seq: 0x80000005, checksum: 0x0c3d, length: 60, flags: { b: false, e: true, v: false },
    links: [
      { kind: 'transit', id: '10.0.123.2', data: '10.0.123.1', metric: 1 },
      { kind: 'p2p', id: '4.4.4.4', data: '10.0.14.1', metric: 64 },
      { kind: 'stub', id: '10.0.14.0', data: '255.255.255.252', metric: 64 },
    ],
  }),
  lsa({ scope: '0.0.0.0', type: 1, lsid: '3.3.3.3', advRouter: '3.3.3.3', maxAge: true, checksum: 0xffff }),
];

/** A router with the fixtures; `sv` null = no ospf StateView (the daemon does not run). */
function world(sv: OspfStateView | null = stateView()): RecordingCtx {
  const r = commandCtxFor(ROUTER, { mode: 'priv-exec', ...(sv === null ? {} : { processStates: { ospf: { process: 'ospf', state: sv as unknown as Record<string, unknown> } } }) });
  (r.ctx as { now: number }).now = NOW;
  r.running.set([], ['router', 'ospf', '1']);
  r.running.set(OSPF1, ['network', '10.0.123.0', '0.0.0.255', 'area', '0']);
  attach<OspfInterfaceRow>(r, 'ospf-interfaces').set(IF_ROW);
  const nbrs = attach<OspfNeighborRow>(r, 'ospf-neighbors');
  for (const n of NBRS) nbrs.set(n);
  const db = attach<OspfLsaRow>(r, 'ospf-lsdb');
  for (const row of LSDB) db.set(row);
  return r;
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('parsing and scope', () => {
  it('parses every new OSPF show on a router (any exec mode) and none on a layer-2 switch', () => {
    const user = matchContextFor(ROUTER, 'user-exec', { privilege: 1 });
    const cases: [string, string, Record<string, string>][] = [
      ['show ip ospf neighbor detail', HANDLERS.showIpOspfNeighbor, { [OSPF_SHOW_DETAIL_ARG]: 'detail' }],
      ['show ip ospf database', HANDLERS.showIpOspfDatabase, {}],
      ['show ip ospf database self-originate', HANDLERS.showIpOspfDatabase, { [OSPF_DB_SELF_ARG]: 'self-originate' }],
      ['show ip ospf database router', HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'router' }],
      ['show ip ospf database network self-originate', HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'network', [OSPF_DB_SELF_ARG]: 'self-originate' }],
      ['sh ip os da ext', HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'external' }],
      ['show ip protocols', HANDLERS.showIpProtocols, {}],
    ];
    for (const [line, handler, args] of cases) {
      const m = matchCommand(GRAMMAR, user, line);
      expect(m.ok, line).toBe(true);
      if (!m.ok) continue;
      expect(m.spec.handler, line).toBe(handler);
      expect({ ...m.args }, line).toEqual(args);
    }
    expect(matchCommand(GRAMMAR, matchContextFor(SWITCH, 'priv-exec'), 'show ip protocols').ok).toBe(false);
    const tokens = help(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), 'show ip ospf database ').items.map((i) => i.token);
    expect(tokens.filter((t) => /^[a-z]/.test(t))).toEqual(['external', 'network', 'router', 'self-originate']);
    const neighbor = help(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), 'show ip ospf neighbor ').items.map((i) => i.token);
    expect(neighbor.filter((t) => /^[a-z]/.test(t))).toEqual(['detail']);
  });
});

// ── show ip ospf neighbor detail ───────────────────────────────────────────────────────────────────────────────

describe('show ip ospf neighbor detail', () => {
  it('prints one block per neighbour in port then router-id order, "Dead in" from the StateView deadAt', () => {
    expect(lines(run(world(), HANDLERS.showIpOspfNeighbor, { [OSPF_SHOW_DETAIL_ARG]: 'detail' }))).toEqual([
      'Neighbour 2.2.2.2, interface address 10.0.123.2',
      `  On ${GI0}, area 0.0.0.0, priority 1`,
      '  State FULL for 00:01:00, role DR',
      '  It announces designated router 10.0.123.2, backup 10.0.123.1',
      '  Dead in 00:00:34; 0 LSAs waiting for an acknowledgement',
      '  Database exchange led by the neighbour (master)',
      '',
      'Neighbour 3.3.3.3, interface address 10.0.123.3',
      `  On ${GI0}, area 0.0.0.0, priority 1`,
      '  State FULL for 00:00:30, role DROTHER',
      '  It announces designated router 10.0.123.2, backup 10.0.123.1',
      '  Dead in 00:00:31; 2 LSAs waiting for an acknowledgement',
      '  Database exchange led by this router (master)',
      '',
      'Neighbour 4.4.4.4, interface address 10.0.14.4',
      `  On ${GI1}, priority 0`,
      '  State INIT for 00:00:05, role -',
      '  It announces designated router none, backup none',
      '  Dead in -',
    ]);
  });

  it('the table form is unchanged by the detail form (the W2 shape)', () => {
    expect(lines(run(world(), HANDLERS.showIpOspfNeighbor))[0]).toBe('Neighbour ID     Pri  State            Dead in    Address        Interface');
  });

  it('the countdown follows the StateView: the same rows a minute later read 00:00:00 once overdue', () => {
    const r = world(stateView({ neighbors: [{ port: GI0, routerId: '2.2.2.2', deadAt: 90 * SEC, retransmitQueue: 1 }] }));
    const out = lines(run(r, HANDLERS.showIpOspfNeighbor, { [OSPF_SHOW_DETAIL_ARG]: 'detail' }));
    expect(out[4]).toBe('  Dead in 00:00:00; 1 LSA waiting for an acknowledgement');
  });
});

// ── show ip ospf database ──────────────────────────────────────────────────────────────────────────────────────

describe('show ip ospf database', () => {
  it('lists every LSA by area and type in the database order, with the live age, hex sequence and checksum', () => {
    expect(lines(run(world(), HANDLERS.showIpOspfDatabase))).toEqual([
      'OSPF router 1.1.1.1, process 1',
      '',
      'Router LSAs, area 0.0.0.0 (type 1)',
      'Link ID          Advertised by    Age   Sequence    Checksum  Links',
      '1.1.1.1          1.1.1.1          10    0x80000005  0x0c3d    3',
      '2.2.2.2          2.2.2.2          6     0x80000003  0x1a2b    1',
      '3.3.3.3          3.3.3.3          3600  0x80000001  0xffff    0',
      '',
      'Network LSAs, area 0.0.0.0 (type 2)',
      'Link ID          Advertised by    Age   Sequence    Checksum',
      '10.0.123.2       2.2.2.2          3     0x80000004  0x00ef',
      '',
      'External LSAs (type 5)',
      'Link ID          Advertised by    Age   Sequence    Checksum  Metric',
      '0.0.0.0          1.1.1.1          20    0x80000002  0x7a8b    E2 1',
    ]);
  });

  it('self-originate keeps only this router\'s LSAs', () => {
    const out = lines(run(world(), HANDLERS.showIpOspfDatabase, { [OSPF_DB_SELF_ARG]: 'self-originate' }));
    expect(out.filter((l) => /^\d/.test(l)).map((l) => l.split(/\s+/)[0])).toEqual(['1.1.1.1', '0.0.0.0']);
  });

  it('router: one block per router LSA with its flags and links in words; self-originate filters', () => {
    expect(lines(run(world(), HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'router', [OSPF_DB_SELF_ARG]: 'self-originate' }))).toEqual([
      'OSPF router 1.1.1.1, process 1',
      '',
      'Router LSAs, area 0.0.0.0 (type 1)',
      '',
      '  Link ID 1.1.1.1, advertised by 1.1.1.1 (this router)',
      '    Age 10 s, sequence 0x80000005, checksum 0x0c3d, length 60',
      '    Flags: AS boundary router',
      '    3 links:',
      '      Transit network: designated router address 10.0.123.2, own address 10.0.123.1, cost 1',
      '      Point-to-point: neighbour 4.4.4.4, own address 10.0.14.1, cost 64',
      '      Stub network: 10.0.14.0, mask 255.255.255.252 (/30), cost 64',
    ]);
    const all = lines(run(world(), HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'router' }));
    expect(all.filter((l) => l.startsWith('  Link ID'))).toEqual([
      '  Link ID 1.1.1.1, advertised by 1.1.1.1 (this router)',
      '  Link ID 2.2.2.2, advertised by 2.2.2.2',
      '  Link ID 3.3.3.3, advertised by 3.3.3.3',
    ]);
    // the flushed LSA says so, and has no link
    expect(all.slice(-4)).toEqual([
      '    Age 3600 s, sequence 0x80000001, checksum 0xffff, length 36',
      '    Being flushed: it reached the maximum age',
      '    Flags: none',
      '    0 links',
    ]);
  });

  it('network and external: the mask, the attached routers, the metric type and the forwarding address', () => {
    expect(lines(run(world(), HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'network' })).slice(2)).toEqual([
      'Network LSAs, area 0.0.0.0 (type 2)',
      '',
      "  Link ID 10.0.123.2 (the designated router's address), advertised by 2.2.2.2",
      '    Age 3 s, sequence 0x80000004, checksum 0x00ef, length 36',
      '    Mask 255.255.255.0 (/24)',
      '    Attached routers: 2.2.2.2, 1.1.1.1, 3.3.3.3',
    ]);
    expect(lines(run(world(), HANDLERS.showIpOspfDatabase, { [OSPF_DB_TYPE_ARG]: 'external' })).slice(2)).toEqual([
      'External LSAs (type 5)',
      '',
      '  Link ID 0.0.0.0, advertised by 1.1.1.1 (this router)',
      '    Age 20 s, sequence 0x80000002, checksum 0x7a8b, length 36',
      '    Mask 0.0.0.0 (/0), metric type 2, metric 1',
      '    Forwarding address 0.0.0.0, tag 1',
    ]);
  });

  it('an empty selection says so; without a process the W2 note; the router id falls back to the configuration', () => {
    const r = world();
    r.extra.delete('ospf-lsdb' as never);
    expect(run(r, HANDLERS.showIpOspfDatabase)).toEqual({ output: `OSPF router 1.1.1.1, process 1\n\n${MSG_OSPF_DB_EMPTY}` });
    expect(run(commandCtxFor(ROUTER, { mode: 'priv-exec' }), HANDLERS.showIpOspfDatabase)).toEqual({ output: MSG_NO_OSPF });
    const configured = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    configured.running.set([], ['router', 'ospf', '7']);
    configured.running.set([['router', 'ospf', '7']], ['router-id', '9.9.9.9']);
    expect(lines(run(configured, HANDLERS.showIpOspfDatabase))[0]).toBe('OSPF router 9.9.9.9, process 7');
  });

  it('formats sequence numbers and checksums as fixed-width hex', () => {
    expect(lsaSeqHex(0x80000001)).toBe('0x80000001');
    expect(lsaSeqHex(0x7fffffff)).toBe('0x7fffffff');
    expect(lsaSeqHex(5)).toBe('0x00000005');
    expect(lsaChecksumHex(0xef)).toBe('0x00ef');
  });
});

// ── show ip protocols ──────────────────────────────────────────────────────────────────────────────────────────

describe('show ip protocols', () => {
  it('the OSPF section: lines, passive interfaces, timers, the spf statistics and the routers heard from', () => {
    const r = world();
    r.running.set(OSPF1, ['passive-interface', 'Loopback0']);
    r.running.set([['interface', GI1]], ['ip', 'ospf', '1', 'area', '0']);
    expect(lines(run(r, HANDLERS.showIpProtocols))).toEqual([
      'Routing process "ospf 1"',
      '  Router ID 1.1.1.1',
      '  Network lines:',
      '    10.0.123.0 0.0.0.255 area 0',
      `  Interfaces enabled by their own "ip ospf … area" line: ${GI1} (area 0)`,
      '  Passive interfaces: Loopback0',
      '  Reference bandwidth 100 Mb/s; up to 4 equal-cost paths per destination',
      '  Default route: not advertised',
      '  Shortest-path calculation: 3 runs, last run 00:00:05 ago; next run in 00:00:03; no new run before 00:00:05 from now',
      '  Routing information sources:',
      '    Gateway          Distance  Last update',
      '    2.2.2.2          110       00:00:03',
      '    3.3.3.3          110       00:00:10',
      '  Distance: 110',
    ]);
  });

  it('passive-interface default names its exceptions; without a StateView there are no spf statistics', () => {
    const r = world(null);
    r.running.set(OSPF1, ['passive-interface', 'default']);
    r.running.set(OSPF1, ['no', 'passive-interface', GI0]);
    const out = lines(run(r, HANDLERS.showIpProtocols));
    expect(out).toContain(`  Passive interfaces: every interface (passive-interface default), except ${GI0}`);
    expect(out.some((l) => l.includes('Shortest-path'))).toBe(false);
    expect(out[1]).toBe('  Router ID 1.1.1.1');
  });

  it('[C1] adds the EIGRP section when router eigrp is configured, from the eigrp StateView and neighbour rows', () => {
    const sv: EigrpStateView = { process: { as: 100, routerId: '10.0.13.1', kValues: [1, 0, 1, 0, 0], maximumPaths: 4 }, neighbors: [], active: [] };
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec', processStates: { eigrp: { process: 'eigrp', state: sv as unknown as Record<string, unknown> } } });
    (r.ctx as { now: number }).now = NOW;
    r.running.set([], ['router', 'eigrp', '100']);
    r.running.set([['router', 'eigrp', '100']], ['network', '10.0.0.0']);
    r.running.set([['router', 'eigrp', '100']], ['network', '192.168.1.0', '0.0.0.255']);
    const nbrs = attach<EigrpNeighborRow>(r, 'eigrp-neighbors');
    const nbr = (address: string, state: 'up' | 'pending', upSince?: number): EigrpNeighborRow => ({
      key: `${GI0}|${address}`, updatedAt: 0, iface: GI0, address, as: 100, state, holdS: 15, srttMs: 0, rtoMs: 0, ...(upSince === undefined ? {} : { upSince }),
    });
    nbrs.set(nbr('10.0.13.3', 'up', 40 * SEC));
    nbrs.set(nbr('10.0.12.2', 'up', 70 * SEC));
    nbrs.set(nbr('10.0.12.9', 'pending'));
    expect(lines(run(r, HANDLERS.showIpProtocols))).toEqual([
      'Routing process "eigrp 100"',
      '  Router ID 10.0.13.1',
      '  Metric weights K1 1, K2 0, K3 1, K4 0, K5 0',
      '  Network lines:',
      '    10.0.0.0 (classful network)',
      '    192.168.1.0 0.0.0.255',
      '  Passive interfaces: none',
      '  Up to 4 equal-cost paths per destination',
      '  Routing information sources:',
      '    Gateway          Distance  Up for',
      '    10.0.12.2        90        00:00:30',
      '    10.0.13.3        90        00:01:00',
      '  Distance: internal 90',
    ]);
    // with OSPF too: the OSPF section first, a blank line, then EIGRP
    r.running.set([], ['router', 'ospf', '1']);
    const both = lines(run(r, HANDLERS.showIpProtocols));
    expect(both[0]).toBe('Routing process "ospf 1"');
    expect(both[both.indexOf('Routing process "eigrp 100"') - 1]).toBe('');
  });

  it('says so when no routing process is configured', () => {
    expect(run(commandCtxFor(ROUTER, { mode: 'priv-exec' }), HANDLERS.showIpProtocols)).toEqual({ output: MSG_NO_ROUTING_PROCESS });
  });
});
