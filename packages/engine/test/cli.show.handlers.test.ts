/**
 * cli/handlers/show.ts — golden-ish assertions on every show handler against a
 * fake CommandCtx (hand-made PortViews, core tables, config ASTs).
 */
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/cli/grammar.js';
import { MSG_NO_STARTUP, ROUTE_CODES_LEGEND, renderRoute, showHandlers } from '../src/cli/handlers/show.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import type { PortView } from '../src/contracts/port.js';
import { fakeCtx, fakePort, MIN, ROUTER_MODEL, SEC, SWITCH_MODEL } from './cli.show.fixture.js';

const run = (id: string, f: ReturnType<typeof fakeCtx>, args: Record<string, string> = {}) => {
  const h = showHandlers[id];
  if (!h) throw new Error(`no handler ${id}`);
  return h(f.ctx, args, false);
};

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('show handlers registry', () => {
  it('every show.* id in HANDLERS has a handler; show.ts owns the shared ones', () => {
    // P1 W5: the feature fragments (IPv6, DHCP, DNS, transport) bring their own show handlers, so the registry —
    // not show.ts alone — is what must cover every id.
    const ids = Object.values(HANDLERS).filter((id) => id.startsWith('show.'));
    for (const id of ids) expect(HANDLER_REGISTRY[id], id).toBeDefined();
    for (const id of Object.keys(showHandlers)) expect(ids, id).toContain(id);
  });
});

describe('show ip interface brief', () => {
  it('lists network ports with address/status/protocol and skips the console', () => {
    const f = fakeCtx({
      model: ROUTER_MODEL,
      ports: [
        fakePort({ id: 'GigabitEthernet0/0', adminUp: true, operUp: true, ipv4: { address: '10.0.0.1', prefixLen: 24 } }),
        fakePort({ id: 'GigabitEthernet0/1', adminUp: false, operUp: false }),
        fakePort({ id: 'Serial0/0/0', kind: 'serial', adminUp: true, operUp: false }),
        { ...fakePort({ id: 'Serial0/0/1', kind: 'serial', adminUp: true, operUp: false }),
          phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock' } } as PortView,
        fakePort({ id: 'Console', kind: 'console' }),
      ],
    });
    const out = lines(run(HANDLERS.showIpIntBrief, f).output);
    expect(out[0]).toMatch(/^Interface\s+IP address\s+Status\s+Protocol$/);
    expect(out[1]).toMatch(/^GigabitEthernet0\/0\s+10\.0\.0\.1\s+up\s+up$/);
    expect(out[2]).toMatch(/^GigabitEthernet0\/1\s+unassigned\s+admin down\s+down$/);
    // Status is layer 1: no carrier reads down/down; carrier without line protocol (no clock) reads up/down.
    expect(out[3]).toMatch(/^Serial0\/0\/0\s+unassigned\s+down\s+down$/);
    expect(out[4]).toMatch(/^Serial0\/0\/1\s+unassigned\s+up\s+down$/);
    expect(out).toHaveLength(5);
    expect(run(HANDLERS.showIpIntBrief, f).output).not.toContain('Console');
  });

  it('shows err-disabled ports as such', () => {
    const f = fakeCtx({ ports: [fakePort({ id: 'GigabitEthernet0', errDisabled: 'security-violation' })] });
    expect(lines(run(HANDLERS.showIpIntBrief, f).output)[1]).toMatch(/err-disabled\s+down$/);
  });
});

describe('show interfaces', () => {
  const port = fakePort({
    id: 'GigabitEthernet0/0', mac: '00:1f:00:00:00:2a', adminUp: true, operUp: true,
    speedBps: 1_000_000_000, duplex: 'full', link: 'l_0001',
    ipv4: { address: '10.0.0.1', prefixLen: 24 },
    counters: { inPackets: 12, inBytes: 1234, inBroadcasts: 3, runts: 1, giants: 2, inErrors: 4, crcErrors: 4, inDrops: 5, outPackets: 10, outBytes: 999, outDrops: 6, collisions: 0 },
    lastInput: 7 * SEC, lastOutput: 9 * SEC, lastChange: 1 * SEC, txQueue: 1,
  });
  const down = fakePort({ id: 'GigabitEthernet0/1', adminUp: false, operUp: false, mac: '00:1f:00:00:00:2b' });

  it('renders status, hardware, address, bandwidth, duplex and real counters', () => {
    const f = fakeCtx({ model: ROUTER_MODEL, ports: [port, down, fakePort({ id: 'Console', kind: 'console' })], now: 10 * SEC });
    const out = run(HANDLERS.showInterfaces, f, { iface: 'GigabitEthernet0/0' }).output ?? '';
    const l = lines(out);
    expect(l[0]).toBe('GigabitEthernet0/0: admin up, link up');
    expect(l[1]).toBe('  Ethernet port, MAC 001f.0000.002a (00:1f:00:00:00:2a)');
    expect(l[2]).toBe('  IPv4 10.0.0.1/24');
    expect(l[3]).toBe('  MTU 1500 bytes, bandwidth 1 Gb/s');
    expect(l[4]).toBe('  full-duplex, 1 Gb/s, negotiated');
    expect(out).toContain('Last input 00:00:03, last output 00:00:01');
    expect(out).toContain('Last state change 00:00:09');
    expect(out).toContain('  RX: 12 frames, 1234 bytes, 3 broadcasts');
    expect(out).toContain('    errors: 1 runt, 2 oversize, 4 FCS, 4 total, 5 dropped');
    expect(out).toContain('  TX: 10 frames, 999 bytes');
    expect(out).toContain('    dropped: 6, collisions: 0');
    expect(out).toContain('Transmit queue: 1 frame waiting');
    expect(out).not.toContain('GigabitEthernet0/1');
  });

  it('renders an admin-down port with spec bandwidth, no negotiation and never', () => {
    const f = fakeCtx({ model: ROUTER_MODEL, ports: [port, down], now: 10 * SEC });
    const out = run(HANDLERS.showInterfaces, f, { iface: 'GigabitEthernet0/1' }).output ?? '';
    expect(lines(out)[0]).toBe('GigabitEthernet0/1: admin down, link down');
    expect(out).not.toContain('admin admin');
    expect(out).not.toContain('IPv4 ');
    expect(out).toContain('bandwidth 1 Gb/s');
    expect(out).toContain('Duplex and speed not negotiated (no link)');
    expect(out).toContain('Last input never, last output never');
  });

  it('without an argument lists every network port in order, and resolves short names', () => {
    const f = fakeCtx({ model: ROUTER_MODEL, ports: [port, down, fakePort({ id: 'Console', kind: 'console' })] });
    const out = run(HANDLERS.showInterfaces, f).output ?? '';
    const a = out.indexOf('GigabitEthernet0/0: admin up');
    const b = out.indexOf('GigabitEthernet0/1: admin down');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(out).not.toContain('Console:');
    expect(lines(run(HANDLERS.showInterfaces, f, { iface: 'gi0/1' }).output)[0]).toContain('GigabitEthernet0/1: admin down');
  });

  it('errors for an unknown interface', () => {
    const f = fakeCtx({ ports: [port] });
    const r = run(HANDLERS.showInterfaces, f, { iface: 'Loopback9' });
    expect(r.output).toBeUndefined();
    expect(r.error).toMatch(/^% No interface named "Loopback9"/);
  });
});

describe('show arp / show ip arp', () => {
  it('prints an empty-cache line', () => {
    expect(run(HANDLERS.showArp, fakeCtx()).output).toBe('The ARP cache is empty.');
  });

  it('lists entries sorted by IP with age in minutes, dotted MACs and Incomplete rows', () => {
    const f = fakeCtx({ now: 10 * MIN });
    f.arp.set({ key: '10.0.0.20', ip: '10.0.0.20', mac: '00:1f:00:00:00:14', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 7 * MIN + 30 * SEC });
    f.arp.set({ key: '10.0.0.3', ip: '10.0.0.3', mac: '00:1f:00:00:00:03', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 10 * MIN });
    f.arp.set({ key: '10.0.0.9', ip: '10.0.0.9', mac: '00:00:00:00:00:00', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: 10 * MIN, incomplete: true });
    f.arp.set({ key: '10.0.0.1', ip: '10.0.0.1', mac: '00:1f:00:00:00:01', iface: 'GigabitEthernet0', type: 'static', updatedAt: 0 });
    const out = lines(run(HANDLERS.showArp, f).output);
    expect(out[0]).toMatch(/^IPv4 address\s+MAC address\s+Age\s+Kind\s+Port$/);
    expect(out[1]).toMatch(/^10\.0\.0\.1\s+001f\.0000\.0001\s+-\s+static\s+GigabitEthernet0$/);
    expect(out[2]).toMatch(/^10\.0\.0\.3\s+001f\.0000\.0003\s+0\s+dynamic\s+GigabitEthernet0$/);
    expect(out[3]).toMatch(/^10\.0\.0\.9\s+Incomplete\s+0\s+dynamic\s+GigabitEthernet0$/);
    expect(out[4]).toMatch(/^10\.0\.0\.20\s+001f\.0000\.0014\s+2\s+dynamic\s+GigabitEthernet0$/);
    expect(out).toHaveLength(5);
    expect(showHandlers[HANDLERS.showIpArp]).toBe(showHandlers[HANDLERS.showArp]);
  });
});

describe('show mac address-table', () => {
  it('sorts by vlan then MAC, renders dotted MACs and a total line', () => {
    const f = fakeCtx({ model: SWITCH_MODEL });
    f.cam.set({ key: '1/00:1f:00:00:00:0b', mac: '00:1f:00:00:00:0b', vlan: 1, port: 'FastEthernet0/2', type: 'dynamic', updatedAt: 0 });
    f.cam.set({ key: '2/00:1f:00:00:00:01', mac: '00:1f:00:00:00:01', vlan: 2, port: 'GigabitEthernet0/1', type: 'static', updatedAt: 0 });
    f.cam.set({ key: '1/00:1f:00:00:00:0a', mac: '00:1f:00:00:00:0a', vlan: 1, port: 'FastEthernet0/1', type: 'dynamic', updatedAt: 0 });
    const out = run(HANDLERS.showMac, f).output ?? '';
    const l = lines(out);
    expect(l[0]).toMatch(/^\s*VLAN\s+MAC address\s+Kind\s+Port$/);
    expect(l[1]).toMatch(/^\s+1\s+001f\.0000\.000a\s+dynamic\s+FastEthernet0\/1$/);
    expect(l[2]).toMatch(/^\s+1\s+001f\.0000\.000b\s+dynamic\s+FastEthernet0\/2$/);
    expect(l[3]).toMatch(/^\s+2\s+001f\.0000\.0001\s+static\s+GigabitEthernet0\/1$/);
    expect(l[4]).toBe('Total entries: 3');
    expect(l).toHaveLength(5);
  });

  it('shows zero entries for an empty table', () => {
    const out = run(HANDLERS.showMac, fakeCtx({ model: SWITCH_MODEL })).output ?? '';
    expect(out).toContain('Total entries: 0');
  });
});

describe('show ip route', () => {
  it('prints the legend, default-route line and rows sorted numerically by network', () => {
    const f = fakeCtx({ model: ROUTER_MODEL });
    f.rib.set({ key: '192.168.1.0/24', network: '192.168.1.0', prefixLen: 24, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '10.0.0.1/32', network: '10.0.0.1', prefixLen: 32, source: 'L', iface: 'GigabitEthernet0/0', ad: 0, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '10.0.0.0/24', network: '10.0.0.0', prefixLen: 24, source: 'C', iface: 'GigabitEthernet0/0', ad: 0, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: '10.0.0.254', ad: 1, metric: 0, isDefault: true, updatedAt: 0 });
    f.rib.set({ key: '9.0.0.0/8', network: '9.0.0.0', prefixLen: 8, source: 'S', iface: 'GigabitEthernet0/1', ad: 1, metric: 0, updatedAt: 0 });
    const out = lines(run(HANDLERS.showIpRoute, f).output);
    expect(out[0]).toBe(ROUTE_CODES_LEGEND);
    expect(out[2]).toBe('Default route: via 10.0.0.254 (S*)');
    expect(out.slice(4)).toEqual([
      'S*   0.0.0.0/0  via 10.0.0.254 [1/0]',
      'S    9.0.0.0/8  [1/0] out GigabitEthernet0/1',
      'C    10.0.0.0/24  connected  GigabitEthernet0/0',
      'L    10.0.0.1/32  connected  GigabitEthernet0/0',
      'S    192.168.1.0/24  via 10.0.0.2 [1/0]',
    ]);
  });

  it('reports no default route and an empty table', () => {
    const f = fakeCtx({ model: ROUTER_MODEL });
    const out = lines(run(HANDLERS.showIpRoute, f).output);
    expect(out[2]).toBe('Default route: none configured');
    expect(out[4]).toBe('The routing table is empty.');
  });

  it('sorts 172.16.0.0 before 192.168.0.0 numerically, not lexically', () => {
    const f = fakeCtx({ model: ROUTER_MODEL });
    f.rib.set({ key: '192.168.0.0/16', network: '192.168.0.0', prefixLen: 16, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '172.16.0.0/12', network: '172.16.0.0', prefixLen: 12, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '100.64.0.0/10', network: '100.64.0.0', prefixLen: 10, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    const out = lines(run(HANDLERS.showIpRoute, f).output).slice(4);
    expect(out.map((l) => l.split(/\s+/)[1])).toEqual(['100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16']);
    expect(renderRoute({ key: 'x', network: '10.1.0.0', prefixLen: 24, source: 'S', nextHop: '10.0.0.2', iface: 'GigabitEthernet0/0', ad: 1, metric: 0, updatedAt: 0 }))
      .toBe('S    10.1.0.0/24  via 10.0.0.2 [1/0] GigabitEthernet0/0');
  });
});

describe('show version', () => {
  it('is short, original, and reads model/hostname/uptime/ports from ctx', () => {
    const f = fakeCtx({ model: ROUTER_MODEL, hostname: 'R1', uptime: (2 * 24 * 3600 + 3 * 3600 + 4 * 60) * SEC });
    const out = run(HANDLERS.showVersion, f).output ?? '';
    const l = lines(out);
    expect(l[0]).toBe('NetForge NFOS software, version 1.0');
    expect(l[1]).toBe('Model: NF-2911 (branch router)');
    expect(l[2]).toBe('Hostname: R1');
    expect(l[3]).toBe('Uptime: 2 days, 3 hours, 4 minutes');
    expect(l[4]).toBe('Ports: 2 GigabitEthernet, 2 Serial, 1 Console');
    expect(l[5]).toBe('Startup configuration: not saved');
    expect(out).not.toContain('Configuration register');
    expect(out).not.toMatch(/cisco/i);
    expect(out).not.toMatch(/\bIOS\b/);
    expect(l.length).toBeLessThanOrEqual(8);
  });
});

describe('show running-config / startup-config / history', () => {
  it('running renders the live config AST', () => {
    const running = createConfigAst();
    running.set([], ['hostname', 'PC1']);
    running.set([['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    running.set([], ['ip', 'default-gateway', '10.0.0.254']);
    const f = fakeCtx({ running });
    const out = run(HANDLERS.showRunning, f).output ?? '';
    expect(out).toBe(running.render());
    expect(out).toContain('hostname PC1');
    expect(out).toContain('interface GigabitEthernet0\n ip address 10.0.0.1 255.255.255.0');
    expect(out).toContain('ip default-gateway 10.0.0.254');
  });

  it('startup renders the saved AST or an original not-present line', () => {
    expect(run(HANDLERS.showStartup, fakeCtx()).output).toBe(MSG_NO_STARTUP);
    const startup = createConfigAst();
    startup.set([], ['hostname', 'Saved']);
    const f = fakeCtx({ startup });
    expect(run(HANDLERS.showStartup, f).output).toBe(startup.render());
    expect(run(HANDLERS.showVersion, f).output).toContain('Startup configuration: saved');
  });

  it('history numbers the session history in order', () => {
    const f = fakeCtx({ history: ['enable', 'show ip interface brief', 'ping 10.0.0.2'] });
    expect(lines(run(HANDLERS.showHistory, f).output)).toEqual([
      '  1  enable',
      '  2  show ip interface brief',
      '  3  ping 10.0.0.2',
    ]);
    expect(run(HANDLERS.showHistory, fakeCtx()).output).toBe('No commands have been entered in this session.');
  });
});

describe('show output wording is original (ARCHITECTURE rule 7)', () => {
  const VENDOR = /line protocol|is directly connected|Internet address is|Hardware is|Address Table|Hardware Addr|Age \(min\)|runts, .* giants|packets (input|output)/;

  it('show interfaces / arp / mac address-table / ip route avoid vendor sentences and layouts', () => {
    const f = fakeCtx({
      model: ROUTER_MODEL, now: 10 * MIN,
      ports: [
        fakePort({ id: 'GigabitEthernet0/0', adminUp: true, operUp: true, speedBps: 1_000_000_000, duplex: 'full', ipv4: { address: '10.0.0.1', prefixLen: 24 } }),
        fakePort({ id: 'GigabitEthernet0/1', adminUp: false, operUp: false }),
      ],
    });
    f.arp.set({ key: '10.0.0.2', ip: '10.0.0.2', mac: '00:1f:00:00:00:02', iface: 'GigabitEthernet0/0', type: 'dynamic', updatedAt: 9 * MIN });
    f.cam.set({ key: '1/00:1f:00:00:00:0a', mac: '00:1f:00:00:00:0a', vlan: 1, port: 'GigabitEthernet0/0', type: 'dynamic', updatedAt: 0 });
    f.rib.set({ key: '10.0.0.0/24', network: '10.0.0.0', prefixLen: 24, source: 'C', iface: 'GigabitEthernet0/0', ad: 0, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '10.0.0.1/32', network: '10.0.0.1', prefixLen: 32, source: 'L', iface: 'GigabitEthernet0/0', ad: 0, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '9.0.0.0/8', network: '9.0.0.0', prefixLen: 8, source: 'S', iface: 'GigabitEthernet0/1', ad: 1, metric: 0, updatedAt: 0 });
    f.rib.set({ key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: '10.0.0.254', ad: 1, metric: 0, isDefault: true, updatedAt: 0 });
    for (const id of [HANDLERS.showInterfaces, HANDLERS.showArp, HANDLERS.showMac, HANDLERS.showIpRoute]) {
      const out = run(id, f).output ?? '';
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(VENDOR);
      expect(out).not.toMatch(/^-{10,}$/m);
    }
    const routes = lines(run(HANDLERS.showIpRoute, f).output);
    expect(routes.filter((l) => /^C\s+\d/.test(l))).toHaveLength(1);
  });
});
