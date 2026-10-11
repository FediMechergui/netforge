// The Tables tab's routing-table source (ARCHITECTURE-P3 D11, §9.2 ruling R52; W5 web-shell): the badge prints the code
// `show ip route` prints — `D` / `D*` for the machine source 'EIGRP', `D*` for the DHCP default, `O E2` / `O*E2` for an
// OSPF external route — and never the raw machine source 'EIGRP'; its title tells the two `D`s apart. The last case
// runs a real P3 world (EIGRP beside a DHCP-learned default, the D11 case of the W4 gate note) and compares the tab
// with the CLI's own table, row by row.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AD_CONNECTED, AD_DHCP, AD_EIGRP, AD_OSPF, AD_STATIC, SEC, createSimulation } from '@netforge/engine';
import type { DeviceSnapshot, RouteRow, Simulation } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, selection: null, tableFlashes: [], events: [] };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { TablesView, ribSourceCode, ribSourceTitle } from '../src/inspector/TablesView';

const AD: Readonly<Record<RouteRow['source'], number>> = { C: AD_CONNECTED, L: AD_CONNECTED, S: AD_STATIC, D: AD_DHCP, O: AD_OSPF, EIGRP: AD_EIGRP };

function route(network: string, prefixLen: number, source: RouteRow['source'], more: Partial<RouteRow> = {}): RouteRow {
  return { key: `${network}/${prefixLen}`, network, prefixLen, source, ad: AD[source], metric: 0, updatedAt: 0, ...(prefixLen === 0 ? { isDefault: true } : {}), ...more };
}

function router(rib: RouteRow[], more: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    id: 'r1', type: 'router.nf2911', model: 'NF-2911', kind: 'router', name: 'R1', position: { x: 0, y: 0 }, power: true, booted: true, uptimeNs: 0,
    ports: [], tables: { cam: [], arp: [], rib }, processes: [], runningConfig: '', hasStartupConfig: false,
    category: 'routers', family: 'NF-2911', variant: '', icon: 'router', capabilities: ['routing'], cli: { shell: 'nfos', grammar: 'nfos' }, gui: ['physical'],
    hostPorts: [], baseMac: '02:00:00:00:00:00', ...more,
  };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** The routing table's rendered rows as [destination, badge code, badge title], in the tab's order. */
function ribBadges(device: DeviceSnapshot): [string, string, string][] {
  const html = renderToStaticMarkup(createElement(TablesView, { device, now: 0 }));
  const section = html.split('<section class="tbl-section">').find((s) => s.includes('Routing table'));
  expect(section, 'the routing table section').toBeDefined();
  const body = section!.split('<tbody>')[1] ?? '';
  return body
    .split('<tr')
    .slice(1)
    .map((tr) => {
      const badge = /<span class="src-badge [^"]*" title="([^"]*)">([^<]*)<\/span>/.exec(tr);
      const cells = tr.split('<td').slice(1).map((td) => text(`<td${td}`));
      expect(badge, `a source badge in ${tr}`).not.toBeNull();
      return [(cells[1] ?? '').replace(/ /g, ''), badge![2]!, badge![1]!];
    });
}

describe('the routing-table source code (R52)', () => {
  it('is the code show ip route prints, never the machine source EIGRP', () => {
    const cases: [RouteRow, string][] = [
      [route('10.0.12.0', 24, 'C'), 'C'],
      [route('10.0.12.1', 32, 'L'), 'L'],
      [route('10.9.0.0', 16, 'S'), 'S'],
      [route('0.0.0.0', 0, 'S'), 'S*'],
      [route('0.0.0.0', 0, 'D'), 'D*'],
      [route('10.3.0.0', 24, 'O'), 'O'],
      [route('0.0.0.0', 0, 'O', { routeType: 'E2' }), 'O*E2'],
      [route('172.16.0.0', 16, 'O', { routeType: 'E2' }), 'O E2'],
      [route('10.4.0.0', 24, 'EIGRP'), 'D'],
      [route('0.0.0.0', 0, 'EIGRP'), 'D*'],
    ];
    for (const [row, code] of cases) expect(ribSourceCode(row), `${row.source} ${row.key}`).toBe(code);
    expect(ribSourceTitle(route('10.4.0.0', 24, 'EIGRP'))).toBe('D — route learned through EIGRP');
    expect(ribSourceTitle(route('0.0.0.0', 0, 'D'))).toBe('D — default route learned from a DHCP lease');
    expect(ribSourceTitle(route('172.16.0.0', 16, 'O', { routeType: 'E2' }))).toBe('O — route learned through OSPF (external, type 2)');
    expect(ribSourceTitle(route('10.3.0.0', 24, 'O'))).toBe('O — route learned through OSPF');
  });

  it('renders D for an EIGRP row and D* for the DHCP default in the Tables tab, the titles telling them apart', () => {
    const device = router([
      route('0.0.0.0', 0, 'D', { nextHop: '192.168.99.1', iface: 'GigabitEthernet0/1' }),
      route('10.0.12.0', 24, 'C', { iface: 'GigabitEthernet0/0' }),
      route('10.0.24.0', 24, 'EIGRP', { nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 3072 }),
      route('10.3.0.0', 24, 'O', { nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 2 }),
      route('172.16.0.0', 16, 'O', { routeType: 'E2', nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 20 }),
    ]);
    expect(ribBadges(device)).toEqual([
      ['0.0.0.0/0', 'D*', 'D — default route learned from a DHCP lease'],
      ['10.0.12.0/24', 'C', 'C — connected network'],
      ['10.0.24.0/24', 'D', 'D — route learned through EIGRP'],
      ['10.3.0.0/24', 'O', 'O — route learned through OSPF'],
      ['172.16.0.0/16', 'O E2', 'O — route learned through OSPF (external, type 2)'],
    ]);
    const html = renderToStaticMarkup(createElement(TablesView, { device, now: 0 }));
    expect(html).not.toMatch(/>EIGRP</);
    expect(html).toContain('<span class="src-badge EIGRP" title="D — route learned through EIGRP">D</span>');
  });

  it('leaves the P1/P2 sources as they were', () => {
    const device = router([
      route('0.0.0.0', 0, 'S', { nextHop: '10.0.0.1' }),
      route('10.0.0.0', 24, 'C', { iface: 'GigabitEthernet0/0' }),
      route('10.0.0.2', 32, 'L', { iface: 'GigabitEthernet0/0' }),
      route('10.9.0.0', 16, 'S', { nextHop: '10.0.0.1' }),
    ]);
    expect(ribBadges(device).map(([dest, code]) => [dest, code])).toEqual([
      ['0.0.0.0/0', 'S*'],
      ['10.0.0.0/24', 'C'],
      ['10.0.0.2/32', 'L'],
      ['10.9.0.0/16', 'S'],
    ]);
  });
});

// ── a real P3 world: the tab agrees with `show ip route` ──────────────────────────────────────────────────────────

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';

function typed(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => l.line), `lines refused on ${device}`).toEqual([]);
}

/** `show ip route`'s rows as [destination, code] (the code is the first five columns). */
function cliRoutes(sim: Simulation, device: string): [string, string][] {
  const s = sim.cli.open(device, 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, 'show ip route').output;
  sim.cli.close(s);
  return out
    .split('\n')
    .filter((line) => /^\S.{4}\d+\.\d+\.\d+\.\d+\/\d+ /.test(line))
    .map((line) => [line.slice(5).split(' ')[0]!, line.slice(0, 5).trim()]);
}

describe('the Tables tab and show ip route on a P3 world (R52, D11)', () => {
  it('print the same code for every route: D for EIGRP, D* for the DHCP default', () => {
    // R1 Gi0/0 — R2 Gi0/0 run EIGRP 100; R2 Gi0/1 holds PC2's LAN; R1 Gi0/1 leases its address and a default from ISP.
    const sim = createSimulation({ seed: 52, profile: 'P3' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
    sim.addDevice({ id: 'isp', type: 'router.nf2911', name: 'ISP' });
    sim.addDevice({
      id: 'pc2',
      type: 'pc.nfpc',
      name: 'PC2',
      startupConfig: ['hostname PC2', '!', 'interface GigabitEthernet0', ' ip address 10.0.24.10 255.255.255.0', '!', 'ip default-gateway 10.0.24.2', '!', 'end', ''].join('\n'),
    });
    sim.runFor(60 * SEC);
    const iface = (name: string, address: string): string[] => [`interface ${name}`, `ip address ${address} 255.255.255.0`, 'no shutdown', 'exit'];
    typed(sim, 'r1', ['hostname R1', ...iface(GI0, '10.0.12.1'), `interface ${GI1}`, 'ip address dhcp', 'no shutdown', 'exit', 'router eigrp 100', 'network 10.0.0.0', 'exit']);
    typed(sim, 'r2', ['hostname R2', ...iface(GI0, '10.0.12.2'), ...iface(GI1, '10.0.24.2'), 'router eigrp 100', 'network 10.0.0.0', 'exit']);
    typed(sim, 'isp', [
      'hostname ISP',
      'ip dhcp excluded-address 192.168.99.1',
      'ip dhcp pool UPLINK',
      'network 192.168.99.0 255.255.255.0',
      'default-router 192.168.99.1',
      'exit',
      ...iface(GI0, '192.168.99.1'),
    ]);
    sim.runFor(1 * SEC);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
    sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'isp', port: GI0 } });
    sim.runFor(30 * SEC);

    const r1 = sim.snapshot().devices.find((d) => d.id === 'r1')!;
    expect(r1.tables.rib.find((r) => r.key === '10.0.24.0/24')).toMatchObject({ source: 'EIGRP', ad: AD_EIGRP });
    expect(r1.tables.rib.find((r) => r.key === '0.0.0.0/0')).toMatchObject({ source: 'D', ad: AD_DHCP, isDefault: true });

    const tab = ribBadges(r1);
    const cli = cliRoutes(sim, 'r1');
    expect(new Map(tab.map(([dest, code]) => [dest, code]))).toEqual(new Map(cli));
    expect(tab.find(([dest]) => dest === '10.0.24.0/24')).toEqual(['10.0.24.0/24', 'D', 'D — route learned through EIGRP']);
    expect(tab.find(([dest]) => dest === '0.0.0.0/0')).toEqual(['0.0.0.0/0', 'D*', 'D — default route learned from a DHCP lease']);
    expect(tab.some(([, code]) => code === 'EIGRP')).toBe(false);
  }, 30_000); // a 92 s world of four devices: about 1.4 s alone, more on a loaded machine
});
