// [S7] The route-path overlay's pure model (ARCHITECTURE-P3C §6, §7 W1c web-canvas, §10.2; rulings R-11, R-12): every
// forwarding device's next hop towards one destination by the engine's own longest-prefix match (lpmRows / lpm6Rows),
// hosts from their default gateway, a layer-2 walk through switches, `↻` for a static loop, `∅` for a missing route or
// a next hop nobody owns, ECMP fan-out, a tunnel as one hop and `NAT` at an inside interface — from snapshot data only.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, PortSnapshot, Route6Row, RouteRow, SimSnapshot, TunnelRow } from '@netforge/engine';
import { lpmRows } from '@netforge/engine/pure';
import {
  ROUTE_BLACK_HOLE_GLYPH,
  ROUTE_DESTINATION_GLYPH,
  ROUTE_LOOP_GLYPH,
  buildRoutePathOverlay,
  canonicalAddress,
  deriveDeviceRoute,
  routeDestinationsOf,
  type RoutePathModel,
} from '../src/canvas/overlays/route-path-model';
import { ROUTE_PATH_OVERLAY, TOPO_OVERLAY_DEFAULTS, memoPerDevice } from '../src/canvas/overlays/registry';
import { routeChips, routePathDeviceFacts, routePathLinkFacts, routePathPortFacts } from '../src/canvas/route-path';
import { device, link, port, snapshot } from './canvas-fixtures';

const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const G2 = 'GigabitEthernet0/2';

function l3port(id: string, address: string | null, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return port(id, { role: 'routed', operUp: true, ...(address === null ? {} : { l3: { ipv4: { address, prefixLen: 24 } } }), ...extra });
}

function route(network: string, prefixLen: number, extra: Partial<RouteRow> = {}): RouteRow {
  return { key: `${network}/${prefixLen}`, updatedAt: 0, network, prefixLen, source: 'S', ad: 1, metric: 0, ...extra };
}

function connected(network: string, iface: string): RouteRow {
  return route(network, 24, { source: 'C', ad: 0, iface });
}

function router(id: string, ports: PortSnapshot[], rib: RouteRow[], extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return device(id, 0, 0, ports, { kind: 'router', capabilities: ['routing'], tables: { cam: [], arp: [], rib }, ...extra });
}

function host(id: string, address: string, gateway: string, net: string): DeviceSnapshot {
  return device(id, 0, 0, [l3port('eth0', address, { role: 'routed' })], {
    capabilities: ['host'],
    tables: { cam: [], arp: [], rib: [connected(net, 'eth0'), route('0.0.0.0', 0, { nextHop: gateway, iface: 'eth0', isDefault: true, owner: 'host' })] },
  });
}

function l2switch(id: string, ports: string[]): DeviceSnapshot {
  return device(
    id,
    0,
    0,
    ports.map((p) => port(p, { operUp: true })),
    { kind: 'switch', capabilities: ['switching'], tables: { cam: [], arp: [], rib: [] } },
  );
}

/**
 * h1 — sw1 — r1 — r2 — h2. h1 10.0.1.10 (gateway 10.0.1.1), r1 Gi0/0 10.0.1.1 / Gi0/1 10.0.12.1, r2 Gi0/0 10.0.12.2 /
 * Gi0/1 10.0.2.1, h2 10.0.2.10. `r1Rib` / `r2Rib` replace the routers' extra rows.
 */
function chain(r1Extra: RouteRow[] = [route('10.0.2.0', 24, { nextHop: '10.0.12.2', iface: G1 })], r2Extra: RouteRow[] = [], r1Device: Partial<DeviceSnapshot> = {}): SimSnapshot {
  const h1 = host('h1', '10.0.1.10', '10.0.1.1', '10.0.1.0');
  const sw1 = l2switch('sw1', ['Fa0/1', 'Fa0/2']);
  const r1 = router('r1', [l3port(G0, '10.0.1.1'), l3port(G1, '10.0.12.1')], [connected('10.0.1.0', G0), connected('10.0.12.0', G1), ...r1Extra], r1Device);
  const r2 = router('r2', [l3port(G0, '10.0.12.2'), l3port(G1, '10.0.2.1')], [connected('10.0.12.0', G0), connected('10.0.2.0', G1), ...r2Extra]);
  const h2 = host('h2', '10.0.2.10', '10.0.2.1', '10.0.2.0');
  return snapshot(
    [h1, sw1, r1, r2, h2],
    [
      link('la', ['h1', 'eth0'], ['sw1', 'Fa0/1']),
      link('lb', ['sw1', 'Fa0/2'], ['r1', G0]),
      link('lc', ['r1', G1], ['r2', G0]),
      link('ld', ['r2', G1], ['h2', 'eth0']),
    ],
  );
}

function mark(model: RoutePathModel, id: string) {
  const m = model.devices.find((d) => d.device === id);
  if (m === undefined) throw new Error(`no mark for ${id}`);
  return m;
}

describe('the path to one destination', () => {
  it('follows each forwarding device to the destination: the host from its default gateway, through the switch', () => {
    const model = buildRoutePathOverlay(chain(), { to: '10.0.2.10' });
    expect(model.to).toBe('10.0.2.10');
    expect(model.family).toBe(4);
    expect(model.hops.map((h) => [h.from, h.iface, h.nextHop, h.to, h.ingress, h.via])).toEqual([
      ['h1', 'eth0', '10.0.1.1', 'r1', G0, 'cable'],
      ['r1', G1, '10.0.12.2', 'r2', G0, 'cable'],
      ['r2', G1, '10.0.2.10', 'h2', 'eth0', 'cable'],
    ]);
    // the host's hop crosses the switch: two cables, in order, the way the packet goes
    expect(model.hops[0]!.links).toEqual([
      { link: 'la', forward: true },
      { link: 'lb', forward: true },
    ]);
    expect(model.links).toEqual([
      { link: 'la', forward: true, backward: false, loop: false },
      { link: 'lb', forward: true, backward: false, loop: false },
      { link: 'lc', forward: true, backward: false, loop: false },
      { link: 'ld', forward: true, backward: false, loop: false },
    ]);
    // the switch forwards nothing itself; the destination is marked; everyone delivers
    expect(model.devices.map((d) => [d.device, d.state, d.glyph, d.fate])).toEqual([
      ['h1', 'forward', '', 'delivered'],
      ['r1', 'forward', '', 'delivered'],
      ['r2', 'forward', '', 'delivered'],
      ['h2', 'destination', ROUTE_DESTINATION_GLYPH, 'delivered'],
    ]);
    expect(mark(model, 'h1').route).toBe('default via 10.0.1.1');
    expect(mark(model, 'r1').route).toBe('10.0.2.0/24 via 10.0.12.2');
    expect(mark(model, 'r2').route).toBe('connected 10.0.2.0/24');
    expect(model.nat).toEqual([]);
  });

  it('agrees with the engine longest-prefix match: the longer prefix beats the default', () => {
    const extra = [route('0.0.0.0', 0, { nextHop: '10.0.12.9', iface: G1, isDefault: true }), route('10.0.2.0', 24, { nextHop: '10.0.12.2', iface: G1 })];
    const snap = chain(extra);
    const r1 = snap.devices.find((d) => d.id === 'r1')!;
    expect(lpmRows(r1.tables.rib, '10.0.2.10').winner?.network).toBe('10.0.2.0');
    const model = buildRoutePathOverlay(snap, { to: '10.0.2.10' });
    expect(model.hops.find((h) => h.from === 'r1')!.nextHop).toBe('10.0.12.2');
  });

  it('gives a static loop ↻ on both routers, and the cable is crossed both ways on the loop', () => {
    const model = buildRoutePathOverlay(
      chain([route('10.9.0.0', 16, { nextHop: '10.0.12.2', iface: G1 })], [route('10.9.0.0', 16, { nextHop: '10.0.12.1', iface: G0 })]),
      { to: '10.9.1.1' },
    );
    expect(mark(model, 'r1')).toMatchObject({ state: 'loop', glyph: ROUTE_LOOP_GLYPH, fate: 'loop' });
    expect(mark(model, 'r2')).toMatchObject({ state: 'loop', glyph: ROUTE_LOOP_GLYPH, fate: 'loop' });
    expect(model.hops.filter((h) => h.loop).map((h) => [h.from, h.to])).toEqual([
      ['r1', 'r2'],
      ['r2', 'r1'],
    ]);
    expect(model.links.find((l) => l.link === 'lc')).toEqual({ link: 'lc', forward: true, backward: true, loop: true });
    // the hosts are not on the loop, but their packets end in it; h1 has a default route, h2's default reaches r2
    expect(mark(model, 'h1')).toMatchObject({ state: 'forward', glyph: '', fate: 'loop' });
    expect(model.hops.find((h) => h.from === 'h1')!.loop).toBe(false);
  });

  it('gives ∅ to a router with no route, and its upstream learns where the packet dies', () => {
    const model = buildRoutePathOverlay(chain([route('0.0.0.0', 0, { nextHop: '10.0.12.2', iface: G1, isDefault: true })]), { to: '10.0.3.5' });
    expect(mark(model, 'r2')).toMatchObject({ state: 'black-hole', glyph: ROUTE_BLACK_HOLE_GLYPH, reason: 'no-route', route: '', fate: 'black-hole' });
    expect(mark(model, 'r1')).toMatchObject({ state: 'forward', fate: 'black-hole' });
    expect(model.hops.some((h) => h.from === 'r2')).toBe(false);
  });

  it('gives ∅ to a router whose next hop nobody owns', () => {
    const model = buildRoutePathOverlay(chain([route('10.0.2.0', 24, { nextHop: '10.0.12.9', iface: G1 })]), { to: '10.0.2.10' });
    expect(mark(model, 'r1')).toMatchObject({ state: 'black-hole', glyph: ROUTE_BLACK_HOLE_GLYPH, reason: 'no-next-hop', route: '10.0.2.0/24 via 10.0.12.9' });
    expect(model.hops.find((h) => h.from === 'r1')).toMatchObject({ to: null, nextHop: '10.0.12.9', links: [] });
    expect(mark(model, 'h1').fate).toBe('black-hole');
  });

  it('resolves a static route without an interface through the route to its next hop', () => {
    const model = buildRoutePathOverlay(chain([route('10.0.2.0', 24, { nextHop: '10.0.12.2' })]), { to: '10.0.2.10' });
    expect(model.hops.find((h) => h.from === 'r1')).toMatchObject({ iface: G1, to: 'r2', via: 'cable' });
  });

  it('fans out over ECMP paths, one hop per installed path, tagged i/n', () => {
    const r1 = router(
      'r1',
      [l3port(G0, '10.0.1.1'), l3port(G1, '10.0.12.1'), l3port(G2, '10.0.13.1')],
      [
        connected('10.0.12.0', G1),
        connected('10.0.13.0', G2),
        route('10.0.2.0', 24, {
          source: 'O',
          ad: 110,
          metric: 2,
          nextHop: '10.0.12.2',
          iface: G1,
          paths: [
            { nextHop: '10.0.12.2', iface: G1 },
            { nextHop: '10.0.13.3', iface: G2 },
          ],
        }),
      ],
    );
    const r2 = router('r2', [l3port(G0, '10.0.12.2'), l3port(G1, '10.0.2.1')], [connected('10.0.2.0', G1)]);
    const r3 = router('r3', [l3port(G0, '10.0.13.3'), l3port(G1, '10.0.2.3')], [connected('10.0.2.0', G1)]);
    const h2 = host('h2', '10.0.2.10', '10.0.2.1', '10.0.2.0');
    const sw = l2switch('sw2', ['Fa0/1', 'Fa0/2', 'Fa0/3']);
    const snap = snapshot(
      [r1, r2, r3, sw, h2],
      [
        link('l12', ['r1', G1], ['r2', G0]),
        link('l13', ['r1', G2], ['r3', G0]),
        link('s2', ['r2', G1], ['sw2', 'Fa0/1']),
        link('s3', ['r3', G1], ['sw2', 'Fa0/2']),
        link('sh', ['sw2', 'Fa0/3'], ['h2', 'eth0']),
      ],
    );
    const model = buildRoutePathOverlay(snap, { to: '10.0.2.10' });
    expect(model.hops.filter((h) => h.from === 'r1').map((h) => [h.iface, h.to, h.ecmp])).toEqual([
      [G1, 'r2', '1/2'],
      [G2, 'r3', '2/2'],
    ]);
    expect(mark(model, 'r1')).toMatchObject({ state: 'forward', route: '10.0.2.0/24 via 10.0.12.2, 10.0.13.3', fate: 'delivered' });
    expect([...routeChips(model)]).toEqual([
      [`r1/${G1}`, '1/2'],
      [`r1/${G2}`, '2/2'],
    ]);
  });

  it('draws a tunnel as one hop to the far router, whatever carries it', () => {
    const tun = { key: 'Tunnel0', updatedAt: 0, port: 'Tunnel0', mode: 'gre', source: '10.0.12.1', destination: '10.0.23.3', state: 'up', transportMtu: 1500, ipMtu: 1476, since: 0 } as TunnelRow;
    const r1 = router(
      'r1',
      [l3port(G1, '10.0.12.1'), l3port('Tunnel0', '172.16.0.1', { kind: 'virtual', virtual: true, linkable: false })],
      [],
      {
        tables: {
          cam: [],
          arp: [],
          rib: [connected('10.0.12.0', G1), route('10.0.3.0', 24, { nextHop: '172.16.0.2', iface: 'Tunnel0' })],
          extra: [{ name: 'tunnels', title: 'Tunnels', columns: [], rows: [tun as unknown as Record<string, unknown>] }],
        },
      },
    );
    const r2 = router('r2', [l3port(G0, '10.0.12.2'), l3port(G1, '10.0.23.2')], []);
    const r3 = router('r3', [l3port(G0, '10.0.23.3'), l3port('Tunnel0', '172.16.0.2', { kind: 'virtual', virtual: true }), l3port(G1, '10.0.3.1')], [connected('10.0.3.0', G1)]);
    const snap = snapshot([r1, r2, r3], [link('a', ['r1', G1], ['r2', G0]), link('b', ['r2', G1], ['r3', G0])]);
    const model = buildRoutePathOverlay(snap, { to: '10.0.3.1' });
    expect(model.hops).toEqual([{ from: 'r1', iface: 'Tunnel0', nextHop: '172.16.0.2', to: 'r3', ingress: 'Tunnel0', via: 'tunnel', links: [], ecmp: '', loop: false }]);
    expect(model.links).toEqual([]);
    expect(mark(model, 'r1').fate).toBe('delivered');
    expect(routeChips(model).get('r1/Tunnel0')).toBe('tunnel');
  });

  it('marks NAT at the inside interface where the path enters and leaves by an outside interface', () => {
    const config = ['hostname R1', `interface ${G0}`, ' ip address 10.0.1.1 255.255.255.0', ' ip nat inside', `interface ${G1}`, ' ip nat outside', '!'].join('\n');
    const model = buildRoutePathOverlay(chain(undefined, [], { runningConfig: config }), { to: '10.0.2.10' });
    expect(model.nat).toEqual([{ device: 'r1', port: G0 }]);
    // the reverse direction is not translated at an inside interface
    const back = buildRoutePathOverlay(chain([], [route('10.0.1.0', 24, { nextHop: '10.0.12.1', iface: G0 })], { runningConfig: config }), { to: '10.0.1.10' });
    expect(back.nat).toEqual([]);
    const facts = routePathPortFacts(model);
    expect(facts.get(`r1/${G0}`)?.short).toBe('NAT');
  });

  it('follows IPv6 by lpm6Rows: rib6 rows and IPv6 port addresses, the host by its default router', () => {
    const v6 = (id: string, address: string, extra: Partial<PortSnapshot> = {}): PortSnapshot =>
      port(id, { role: 'routed', operUp: true, l3: { ipv6: [{ address, prefixLen: 64, scope: 'global', origin: 'manual', state: 'preferred' }] }, ...extra });
    const r6 = (network: string, prefixLen: number, extra: Partial<Route6Row>): Route6Row => ({ key: `${network}/${prefixLen}`, updatedAt: 0, network, prefixLen, source: 'S', ad: 1, metric: 0, ...extra });
    const rib6 = (rows: Route6Row[]) => [{ name: 'rib6' as const, title: 'IPv6 routes', columns: [], rows: rows as unknown as Record<string, unknown>[] }];
    const h1 = device('h1', 0, 0, [v6('eth0', '2001:db8:1::10', { role: 'routed' })], {
      capabilities: ['host'],
      tables: { cam: [], arp: [], rib: [], extra: rib6([r6('::', 0, { source: 'ND', nextHop: '2001:db8:1::1', iface: 'eth0', isDefault: true })]) },
    });
    const r1 = device('r1', 0, 0, [v6(G0, '2001:db8:1::1'), v6(G1, '2001:db8:12::1')], {
      kind: 'router',
      capabilities: ['routing'],
      tables: { cam: [], arp: [], rib: [], extra: rib6([r6('2001:db8:2::', 64, { nextHop: '2001:DB8:12:0::2', iface: G1 })]) },
    });
    const r2 = device('r2', 0, 0, [v6(G0, '2001:db8:12::2'), v6(G1, '2001:db8:2::1')], {
      kind: 'router',
      capabilities: ['routing'],
      tables: { cam: [], arp: [], rib: [], extra: rib6([r6('2001:db8:2::', 64, { source: 'C', ad: 0, iface: G1 })]) },
    });
    const h2 = device('h2', 0, 0, [v6('eth0', '2001:db8:2::20', { role: 'routed' })], { capabilities: ['host'] });
    const snap = snapshot([h1, r1, r2, h2], [link('a', ['h1', 'eth0'], ['r1', G0]), link('b', ['r1', G1], ['r2', G0]), link('c', ['r2', G1], ['h2', 'eth0'])]);
    const model = buildRoutePathOverlay(snap, { to: '2001:DB8:2:0:0:0:0:20' });
    expect(model.to).toBe('2001:db8:2::20');
    expect(model.family).toBe(6);
    expect(model.hops.map((h) => [h.from, h.nextHop, h.to])).toEqual([
      ['h1', '2001:db8:1::1', 'r1'],
      ['r1', '2001:db8:12::2', 'r2'],
      ['r2', '2001:db8:2::20', 'h2'],
    ]);
    expect(mark(model, 'h1')).toMatchObject({ route: 'default via 2001:db8:1::1', fate: 'delivered' });
    expect(routeDestinationsOf(snap)).toEqual(['2001:db8:1::10', '2001:db8:1::1', '2001:db8:12::1', '2001:db8:12::2', '2001:db8:2::1', '2001:db8:2::20']);
  });
});

describe('destinations, the empty model and the registry entry', () => {
  it('lists IPv4 addresses first, then the IPv6 ones, each once', () => {
    expect(routeDestinationsOf(chain())).toEqual(['10.0.1.10', '10.0.1.1', '10.0.12.1', '10.0.12.2', '10.0.2.1', '10.0.2.10']);
    expect(canonicalAddress('2001:DB8::1')).toBe('2001:db8::1');
    expect(canonicalAddress('nope')).toBeNull();
  });

  it('draws nothing without a destination, or for text that is not an address', () => {
    for (const to of [null, undefined, '', 'r2', '10.0.0.0/8', '300.1.1.1']) {
      const model = buildRoutePathOverlay(chain(), to === undefined ? {} : { to });
      expect(model, String(to)).toMatchObject({ to: null, family: null, devices: [], hops: [], links: [], nat: [] });
      expect(model.destinations.length).toBe(6);
    }
  });

  it('a device that is off is a black hole; a switch never forwards by its own table', () => {
    const snap = chain();
    const off = { ...snap, devices: snap.devices.map((d) => (d.id === 'r2' ? { ...d, power: false } : d)) };
    const model = buildRoutePathOverlay(off, { to: '10.0.2.10' });
    expect(mark(model, 'r2')).toMatchObject({ state: 'black-hole', reason: 'down' });
    expect(mark(model, 'r1').fate).toBe('black-hole');
    expect(deriveDeviceRoute(snap.devices[1]!).forwards).toBe(false);
    expect(deriveDeviceRoute(snap.devices[1]!).bridges).toBe(true);
  });

  it('is synced by the registry only while the overlay is on, with the slice destination', () => {
    const snap = chain();
    expect(ROUTE_PATH_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: 0 })).toBeNull();
    expect(ROUTE_PATH_OVERLAY.sync({ state: { ...TOPO_OVERLAY_DEFAULTS, routePath: true }, snapshot: null, now: 0 })).toBeNull();
    const on = ROUTE_PATH_OVERLAY.sync({ state: { ...TOPO_OVERLAY_DEFAULTS, routePath: true, routeTo: '10.0.2.10' }, snapshot: snap, now: 0 });
    expect(on).toEqual(buildRoutePathOverlay(snap, { to: '10.0.2.10' }));
    // memoised per device object
    const derive = memoPerDevice(deriveDeviceRoute);
    expect(derive(snap.devices[0]!)).toBe(derive(snap.devices[0]!));
    expect(ROUTE_PATH_OVERLAY.select(snap).get('r1')).toBe(ROUTE_PATH_OVERLAY.select(snap).get('r1'));
  });

  it('says every mark in text for the keyboard outline', () => {
    const loop = buildRoutePathOverlay(
      chain([route('10.9.0.0', 16, { nextHop: '10.0.12.2', iface: G1 })], [route('10.9.0.0', 16, { nextHop: '10.0.12.1', iface: G0 })]),
      { to: '10.9.1.1' },
    );
    const devices = routePathDeviceFacts(loop);
    expect(devices.get('r1')).toEqual({ short: '↻', text: 'path to 10.9.1.1: 10.9.0.0/16 via 10.0.12.2, on a forwarding loop (↻)' });
    expect(routePathLinkFacts(loop).get('lc')).toEqual({ short: '↻', text: 'path to 10.9.1.1 crosses this cable both ways, on a forwarding loop' });
    const hole = buildRoutePathOverlay(chain([route('0.0.0.0', 0, { nextHop: '10.0.12.2', iface: G1, isDefault: true })]), { to: '10.0.3.5' });
    expect(routePathDeviceFacts(hole).get('r2')).toEqual({ short: '∅', text: 'path to 10.0.3.5: black hole (∅): no route matches, the packet is dropped' });
    const ok = buildRoutePathOverlay(chain(), { to: '10.0.2.10' });
    expect(routePathDeviceFacts(ok).get('h2')?.text).toBe('path to 10.0.2.10: this device owns the destination');
    expect(routePathPortFacts(ok, (id) => id.toUpperCase()).get(`r1/${G1}`)).toEqual({ short: '→', text: 'towards 10.0.2.10: next hop 10.0.12.2 (R2)' });
    expect(routePathDeviceFacts(null).size).toBe(0);
  });
});
