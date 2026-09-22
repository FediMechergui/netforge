/**
 * ip.static-routing — the P2 static routing rework of protocols/ipv4.ts (ARCHITECTURE-P2 D13, §3.5, §7 W2 l3):
 * one candidate per `ip route` line, administrative distance (floating statics), fully specified routes, the
 * "usable" rule with recursion ≤ 8, install time = when usable (not at configuration), the `ip routing` line in
 * both forms, and the same on a real world (`test/p2.world.ts`, §0 rule 13) with a floating static over a serial
 * backup link.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createHost } from '../src/protocols/host.js';
import {
  IP_ROUTING_OFF_DETAIL,
  STATIC_OWNER_PREFIX,
  STATIC_RECURSION_MAX,
  createIpv4,
  ipForwardingEnabled,
  ipRoutingSwitchedOff,
  parseStaticRoute,
  routeCause,
} from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { console as cliConsole, ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const MASK24 = '255.255.255.0';
const MASK16 = '255.255.0.0';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const setRoute = (...args: string[]): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'route', ...args] });
const unsetRoute = (...args: string[]): ConfigDelta => ({ op: 'unset', context: [], line: ['ip', 'route', ...args] });

/** A router with GI0 10.0.0.1/24 and GI1 10.0.1.1/24; `gi1Up` false leaves GI1 down. */
function router(gi1Up = true) {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1, operUp: gi1Up }] });
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  const icmp = makeSink('icmpv4');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(icmp);
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', MASK24)));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.1.1', MASK24)));
  arp.requests.length = 0;
  return { fake, ipv4, arp, icmp };
}

const rows = (fake: Fake): RouteRow[] => fake.tables.rib.rows();
const row = (fake: Fake, key: string): RouteRow | undefined => fake.tables.rib.get(key);
const writesOf = (fake: Fake, key: string) => fake.trace.filter((e) => e.kind === 'tableWrite' && e.table === 'rib' && e.key === key);
const expiresOf = (fake: Fake, key: string) => fake.trace.filter((e) => e.kind === 'tableExpire' && e.table === 'rib' && e.key === key);

describe('ip.static-routing lines and distances (D13)', () => {
  it('parses next hop, exit interface, fully specified, distance and permanent forms into one canonical line', () => {
    const { fake } = router();
    const ok = (args: string[]) => {
      const r = parseStaticRoute(fake.ctx, args);
      if (!r.ok) throw new Error(r.reason);
      return r.def;
    };
    expect(ok(['10.5.0.77', MASK24, '10.0.1.9'])).toMatchObject({ line: `ip route 10.5.0.0 ${MASK24} 10.0.1.9`, key: '10.5.0.0/24', nextHop: '10.0.1.9', ad: 1, permanent: false, isDefault: false });
    expect(ok(['10.5.0.0', MASK24, 'gigabitethernet0/1'])).toMatchObject({ line: `ip route 10.5.0.0 ${MASK24} ${GI1}`, iface: GI1, ad: 1 });
    expect(ok(['10.5.0.0', MASK24, GI1, '10.0.1.9'])).toMatchObject({ line: `ip route 10.5.0.0 ${MASK24} ${GI1} 10.0.1.9`, iface: GI1, nextHop: '10.0.1.9' });
    expect(ok(['10.5.0.0', MASK24, '10.0.1.9', '5'])).toMatchObject({ line: `ip route 10.5.0.0 ${MASK24} 10.0.1.9 5`, ad: 5 });
    expect(ok(['10.5.0.0', MASK24, GI1, '10.0.1.9', '200', 'permanent'])).toMatchObject({ line: `ip route 10.5.0.0 ${MASK24} ${GI1} 10.0.1.9 200 permanent`, ad: 200, permanent: true });
    expect(ok(['0.0.0.0', '0.0.0.0', '10.0.0.254'])).toMatchObject({ key: '0.0.0.0/0', isDefault: true });
    expect(parseStaticRoute(fake.ctx, ['10.5.0.0', '255.0.255.0', '10.0.1.9'])).toMatchObject({ ok: false });
    expect(parseStaticRoute(fake.ctx, ['10.5.0.0', MASK24, 'Serial9/9'])).toMatchObject({ ok: false, reason: 'unknown next hop or interface' });
    expect(parseStaticRoute(fake.ctx, ['10.5.0.0', MASK24, '10.0.1.9', '0'])).toMatchObject({ ok: false });
    expect(parseStaticRoute(fake.ctx, ['10.5.0.0', MASK24, '10.0.1.9', '256'])).toMatchObject({ ok: false });
    expect(parseStaticRoute(fake.ctx, ['10.5.0.0', MASK24, '10.0.1.9', 'tag'])).toMatchObject({ ok: false });
  });

  it('a floating static (higher distance) waits as a candidate and takes over when the primary becomes unusable', () => {
    const { fake, ipv4, arp } = router();
    expect(ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'))).toEqual([]);
    expect(ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9', '5'))).toEqual([]);
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ source: 'S', nextHop: '10.0.0.9', ad: 1, metric: 0 });
    expect(row(fake, '10.5.0.0/24')?.paths).toBeUndefined();
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
    expect(fake.debug.at(-1)!.message).toBe(`S 10.5.0.0/24 via 10.0.1.9 kept as a candidate: ip route 10.5.0.0 ${MASK24} 10.0.0.9 is installed`);
    expect(writesOf(fake, '10.5.0.0/24')).toHaveLength(1);

    // the primary's next hop goes away with its interface: the [5/0] route is installed in the same step
    fake.setNow(5 * SEC);
    fake.setOper(GI0, false);
    ipv4.onLinkChange!(fake.ctx, GI0, false);
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ source: 'S', nextHop: '10.0.1.9', ad: 5, updatedAt: 5 * SEC });
    const w = writesOf(fake, '10.5.0.0/24');
    expect(w).toHaveLength(2);
    expect(w[1]!.t).toBe(5 * SEC);
    expect(expiresOf(fake, '10.5.0.0/24')).toEqual([]);
    expect(fake.debug.some((d) => d.message === 'remove S 10.5.0.0/24 via 10.0.0.9 (next hop 10.0.0.9 is not reachable)')).toBe(true);
    // the floating line stayed a candidate all along: the arbiter re-installs it as the runner-up
    expect(fake.debug.some((d) => d.message === 'install S 10.5.0.0/24 via 10.0.1.9 (next best candidate, distance 5)')).toBe(true);
    // forwarding uses the floating route, with its line (distance included) as the cause
    const pdu = fake.build(framed(MAC_R1, MAC_PC, echoRequest('10.0.1.2', '10.5.0.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI1));
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '10.0.1.9', iface: GI1, cause: `ip route 10.5.0.0 ${MASK24} 10.0.1.9 5` }]);
    expect(pdu.provenance[0]).toMatchObject({ reason: 'TtlDecrement', cause: `ip route 10.5.0.0 ${MASK24} 10.0.1.9 5` });

    // the primary returns: distance 1 wins again
    fake.setNow(9 * SEC);
    fake.setOper(GI0, true);
    ipv4.onLinkChange!(fake.ctx, GI0, true);
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ nextHop: '10.0.0.9', ad: 1, updatedAt: 9 * SEC });
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
  });

  it('a fully specified route needs its interface up with the next hop on that subnet, and forwards out that interface', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.6.0.0', MASK24, GI1, '10.0.1.7'));
    const r = row(fake, '10.6.0.0/24');
    expect(r).toMatchObject({ source: 'S', iface: GI1, nextHop: '10.0.1.7', ad: 1 });
    expect(routeCause(r!)).toBe(`ip route 10.6.0.0 ${MASK24} ${GI1} 10.0.1.7`);
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.6.0.6', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(arp.requests[0]).toMatchObject({ kind: 'arp.sendVia', nextHop: '10.0.1.7', iface: GI1, cause: `ip route 10.6.0.0 ${MASK24} ${GI1} 10.0.1.7` });
    // a next hop that is not on the interface's subnet is never usable (and, §9.3 (a), waiting is silent)
    const before = fake.debug.length;
    ipv4.onConfig(fake.ctx, setRoute('10.7.0.0', MASK24, GI1, '10.0.0.7'));
    expect(row(fake, '10.7.0.0/24')).toBeUndefined();
    expect(fake.debug.length).toBe(before);
    // the interface goes down: withdrawn (no other candidate → the key expires)
    fake.setOper(GI1, false);
    ipv4.onLinkChange!(fake.ctx, GI1, false);
    expect(row(fake, '10.6.0.0/24')).toBeUndefined();
    expect(expiresOf(fake, '10.6.0.0/24')).toHaveLength(1);
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
  });

  it('resolves recursive statics through the RIB in any configuration order, never through the line itself, at most 8 deep', () => {
    const { fake, ipv4, arp } = router();
    // deepest line first: it waits until the lines below it are installed
    ipv4.onConfig(fake.ctx, setRoute('10.77.0.0', MASK16, '192.168.9.9'));
    expect(row(fake, '10.77.0.0/16')).toBeUndefined();
    ipv4.onConfig(fake.ctx, setRoute('192.168.9.0', MASK24, '172.16.1.1'));
    expect(row(fake, '192.168.9.0/24')).toBeUndefined();
    ipv4.onConfig(fake.ctx, setRoute('172.16.0.0', MASK16, '10.0.1.2'));
    expect(rows(fake).filter((r) => r.source === 'S').map((r) => r.key)).toEqual(['172.16.0.0/16', '192.168.9.0/24', '10.77.0.0/16']);
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.77.5.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(arp.requests[0]).toMatchObject({ nextHop: '10.0.1.2', iface: GI1, cause: `ip route 10.77.0.0 ${MASK16} 192.168.9.9` });
    // withdrawing the connected-side line takes the whole chain down, in the same step
    ipv4.onConfig(fake.ctx, unsetRoute('172.16.0.0', MASK16, '10.0.1.2'));
    expect(rows(fake).filter((r) => r.source === 'S')).toEqual([]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });

    // a route whose next hop resolves only through itself is never installed
    ipv4.onConfig(fake.ctx, setRoute('10.66.0.0', MASK16, '10.66.1.1'));
    expect(row(fake, '10.66.0.0/16')).toBeUndefined();
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.55.1.1'));
    expect(row(fake, '0.0.0.0/0')).toBeUndefined();

    // a chain of STATIC_RECURSION_MAX + 1 lines: the last one exceeds the depth and stays out
    const n = STATIC_RECURSION_MAX + 2;
    for (let k = 1; k <= n; k++) {
      const via = k === 1 ? '10.0.1.2' : `10.${100 + k - 1}.0.1`;
      ipv4.onConfig(fake.ctx, setRoute(`10.${100 + k}.0.0`, MASK16, via));
    }
    for (let k = 1; k < n; k++) expect(row(fake, `10.${100 + k}.0.0/16`)).toMatchObject({ source: 'S' });
    expect(row(fake, `10.${100 + n}.0.0/16`)).toBeUndefined();
  });

  it('a static whose next hop lies inside its own prefix, installed through a covering default, forwards out the default with its own line as cause', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.1.9'));
    ipv4.onConfig(fake.ctx, setRoute('172.16.0.0', MASK16, '172.16.9.1'));
    // D13 usable: the line's own candidate is ignored, the default resolves the next hop → installed
    expect(row(fake, '172.16.0.0/16')).toMatchObject({ source: 'S', nextHop: '172.16.9.1' });
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '172.16.5.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    // forwarding walks the same way: past the /16 itself to the default, whose next hop is on GI1
    expect(fake.trace.filter((e) => e.kind === 'drop')).toEqual([]);
    expect(arp.requests[0]).toMatchObject({ nextHop: '10.0.1.9', iface: GI1, cause: `ip route 172.16.0.0 ${MASK16} 172.16.9.1` });
    expect(pdu.provenance.find((m) => m.reason === 'TtlDecrement')).toMatchObject({ cause: `ip route 172.16.0.0 ${MASK16} 172.16.9.1` });
  });

  it('installs a static when its next hop becomes usable (link-up), not at configuration; withdraws it at link-down', () => {
    const { fake, ipv4 } = router(false);
    expect(rows(fake).map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32']);
    fake.setNow(2 * SEC);
    expect(ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9'))).toEqual([]);
    ipv4.onConfig(fake.ctx, setRoute('10.6.0.0', MASK24, GI1));
    expect(row(fake, '10.5.0.0/24')).toBeUndefined();
    expect(row(fake, '10.6.0.0/24')).toBeUndefined();
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
    // §9.3 (a): a waiting line adds no event; its one `add S` line comes with the install
    expect(fake.debug.filter((d) => d.message.includes('10.5.0.0/24') || d.message.includes('10.6.0.0/24'))).toEqual([]);
    fake.setNow(7 * SEC);
    fake.setOper(GI1, true);
    ipv4.onLinkChange!(fake.ctx, GI1, true);
    expect(rows(fake).map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32', '10.0.1.0/24', '10.0.1.1/32', '10.5.0.0/24', '10.6.0.0/24']);
    for (const key of ['10.5.0.0/24', '10.6.0.0/24']) {
      const w = writesOf(fake, key);
      expect(w).toHaveLength(1);
      expect(w[0]!.t).toBe(7 * SEC);
      expect(row(fake, key)?.updatedAt).toBe(7 * SEC);
    }
    expect(fake.debug.filter((d) => d.message.startsWith('add S')).map((d) => [d.at, d.message])).toEqual([
      [7 * SEC, 'add S 10.5.0.0/24 via 10.0.1.9'],
      [7 * SEC, `add S 10.6.0.0/24 via ${GI1}`],
    ]);
    fake.setNow(9 * SEC);
    fake.setOper(GI1, false);
    ipv4.onLinkChange!(fake.ctx, GI1, false);
    expect(rows(fake).map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32']);
    expect(expiresOf(fake, '10.5.0.0/24').map((e) => e.t)).toEqual([9 * SEC]);
    // a permanent route ignores the test
    ipv4.onConfig(fake.ctx, setRoute('10.8.0.0', MASK24, GI1, 'permanent'));
    expect(row(fake, '10.8.0.0/24')).toMatchObject({ source: 'S', iface: GI1 });
  });

  it('two lines for one prefix are two candidates: no ip route removes the exact line, and the bare form removes all', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9', '5'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9')); // same line again: no second candidate
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
    ipv4.onConfig(fake.ctx, unsetRoute('10.5.0.0', MASK24, '10.0.0.9'));
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ nextHop: '10.0.1.9', ad: 5 });
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 1 });
    // removing a line that is not configured changes nothing
    ipv4.onConfig(fake.ctx, unsetRoute('10.5.0.0', MASK24, '10.0.1.9'));
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ nextHop: '10.0.1.9', ad: 5 });
    ipv4.onConfig(fake.ctx, unsetRoute('10.5.0.0', MASK24, '10.0.1.9', '5'));
    expect(row(fake, '10.5.0.0/24')).toBeUndefined();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.9.0.0', MASK24, '10.0.0.9'));
    ipv4.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'route'] });
    expect(rows(fake).map((r) => r.source)).toEqual(['C', 'L', 'C', 'L']);
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 0 });
  });

  it('boot replay reads distance lines from the running config and installs them once usable', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1, operUp: false }] });
    fake.ctx.config.set([['interface', GI0]], ['ip', 'address', '10.0.0.1', MASK24]);
    fake.ctx.config.set([['interface', GI1]], ['ip', 'address', '10.0.1.1', MASK24]);
    fake.ctx.config.set([], ['ip', 'route', '10.5.0.0', MASK24, '10.0.0.9']);
    fake.ctx.config.set([], ['ip', 'route', '10.5.0.0', MASK24, '10.0.1.9', '5']);
    fake.ctx.config.set([], ['ip', 'route', '10.6.0.0', MASK24, '10.0.1.9']);
    const ipv4 = createIpv4();
    fake.register(ipv4);
    fake.register(makeSink('arp'));
    fake.run(ipv4.init!(fake.ctx));
    expect(rows(fake).map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32', '10.5.0.0/24']);
    expect(row(fake, '10.5.0.0/24')).toMatchObject({ nextHop: '10.0.0.9', ad: 1 });
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 3 });
    fake.setOper(GI1, true);
    ipv4.onLinkChange!(fake.ctx, GI1, true);
    expect(row(fake, '10.6.0.0/24')).toMatchObject({ nextHop: '10.0.1.9', ad: 1 });
    // idempotent: replayed deltas add no candidate
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9', '5'));
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 3 });
    // arbiter owners are per line
    expect(fake.tables.rib.get('10.5.0.0/24')?.owner).toBeUndefined();
    expect(STATIC_OWNER_PREFIX).toBe('static|');
  });
});

describe('ip.static-routing ip routing (both forms, §3.5)', () => {
  it('a stored no ip routing switches transit forwarding off with the no-route detail; ip routing restores it', () => {
    const { fake, ipv4, arp } = router();
    expect(ipRoutingSwitchedOff(fake.ctx)).toBe(false);
    expect(ipForwardingEnabled(fake.ctx)).toBe(true);
    const delta = fake.ctx.config.unset([], ['ip', 'routing'])!;
    expect(delta).toMatchObject({ op: 'unset', context: [], line: ['ip', 'routing'] });
    expect(ipv4.onConfig(fake.ctx, delta)).toEqual([]);
    expect(ipRoutingSwitchedOff(fake.ctx)).toBe(true);
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarding: false });
    expect(fake.debug.at(-1)!.message).toBe('IP routing off');
    const transit = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.1.2', 1, 1, 64)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, transit, GI0));
    expect(actions).toEqual([{ type: 'drop', pdu: transit, reason: 'no-route', detail: IP_ROUTING_OFF_DETAIL, port: GI0 }]);
    expect(IP_ROUTING_OFF_DETAIL).toContain('ip routing');
    expect(arp.requests).toEqual([]);
    // local delivery is unaffected
    const local = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.0.1', 1, 2, 64)));
    expect(fake.run(ipv4.onPdu(fake.ctx, local, GI0))[0]).toMatchObject({ type: 'deliver', to: 'icmpv4' });
    // `ip routing` replaces the negation in the same slot
    const on = fake.ctx.config.set([], ['ip', 'routing'])!;
    expect(ipv4.onConfig(fake.ctx, on)).toEqual([]);
    expect(ipRoutingSwitchedOff(fake.ctx)).toBe(false);
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarding: true });
    const again = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.1.2', 1, 3, 64)));
    fake.run(ipv4.onPdu(fake.ctx, again, GI0));
    expect(arp.requests).toHaveLength(1);
  });

  it('the host daemon offers ip default-gateway whenever forwarding is off by the line, and withdraws it when routing returns', () => {
    const { fake, ipv4 } = router();
    const host = createHost();
    fake.register(host);
    expect(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] })).toEqual([]);
    expect(row(fake, '0.0.0.0/0')).toBeUndefined();
    fake.run(host.onConfig(fake.ctx, fake.ctx.config.unset([], ['ip', 'routing'])!));
    expect(row(fake, '0.0.0.0/0')).toMatchObject({ source: 'S', nextHop: '10.0.0.254', owner: 'host' });
    expect(routeCause(row(fake, '0.0.0.0/0')!)).toBe('ip default-gateway 10.0.0.254');
    fake.run(host.onConfig(fake.ctx, fake.ctx.config.set([], ['ip', 'routing'])!));
    expect(row(fake, '0.0.0.0/0')).toBeUndefined();
    expect(host.stateSnapshot().state.defaultGateway).toBe('10.0.0.254');
    // configuring the gateway while routing is off offers it at once
    fake.run(host.onConfig(fake.ctx, fake.ctx.config.unset([], ['ip', 'routing'])!));
    expect(row(fake, '0.0.0.0/0')).toMatchObject({ nextHop: '10.0.0.254' });
    fake.run(host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'] }));
    expect(row(fake, '0.0.0.0/0')).toBeUndefined();
    void ipv4;
  });
});

// ── a real world (test/p2.world.ts): floating static over a serial backup ─────

/** Every P2 daemon removed (a P1-profile world of P1 daemons), so nothing else changes the timing. */
function noP2(): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = undefined;
  return out;
}

const PRIMARY = 'l_r1_r2';
const BACKUP = 'l_r1_r2_serial';

/**
 * PC1 (10.1.0.10) — R1 — R2 — PC2 (10.2.0.10). Primary link Gi0/1–Gi0/0 (10.9.0.0/30), backup serial link
 * (10.8.0.0/30). Each router has a distance-1 static over the primary and a distance-5 floating static over the backup.
 */
function floatingWorld(seed = 3) {
  const sim = createP2Simulation({ seed, profile: 'P1', factories: noP2() });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section(`interface ${GI0}`, [`ip address 10.1.0.1 ${MASK24}`, 'no shutdown']),
      section(`interface ${GI1}`, [`ip address 10.9.0.1 255.255.255.252`, 'no shutdown']),
      section('interface Serial0/0/0', [`ip address 10.8.0.1 255.255.255.252`, 'clock rate 64000', 'no shutdown']),
      [`ip route 10.2.0.0 ${MASK24} 10.9.0.2`, `ip route 10.2.0.0 ${MASK24} 10.8.0.2 5`],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: configText([
      ['hostname R2'],
      section(`interface ${GI0}`, [`ip address 10.9.0.2 255.255.255.252`, 'no shutdown']),
      section(`interface ${GI1}`, [`ip address 10.2.0.1 ${MASK24}`, 'no shutdown']),
      section('interface Serial0/0/0', [`ip address 10.8.0.2 255.255.255.252`, 'no shutdown']),
      [`ip route 10.1.0.0 ${MASK24} 10.9.0.1`, `ip route 10.1.0.0 ${MASK24} 10.8.0.1 5`],
    ]),
  });
  sim.addLink({ id: 'l_pc1_r1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ id: PRIMARY, a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ id: BACKUP, a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce' });
  sim.addLink({ id: 'l_r2_pc2', a: { device: 'r2', port: GI1 }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(90 * SEC);
  return sim;
}

function pingFrom(sim: ReturnType<typeof floatingWorld>, device: string, target: string) {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  sim.cli.exec(session, `ping ${target}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}

describe('ip.static-routing on a real world (floating static over a serial backup)', () => {
  it('installs the distance-1 static when its next hop becomes usable, fails over to [5/0] in the instant of the cut and back on repair', () => {
    const sim = floatingWorld();
    const r1 = sim.device('r1')!;
    const evs = sim.trace(0).events;
    const writes = ofKind(evs, 'tableWrite').filter((e) => e.device === 'r1' && e.table === 'rib');
    const sWrites = writes.filter((e) => e.key === '10.2.0.0/24');
    const cWrite = writes.find((e) => e.key === '10.9.0.0/30')!;
    // D13: exactly one write of the static, in the dispatch that installed the connected route of its next hop
    expect(sWrites).toHaveLength(1);
    expect(sWrites[0]!.t).toBe(cWrite.t);
    expect(sWrites[0]!.row).toMatchObject({ source: 'S', nextHop: '10.9.0.2', ad: 1 });
    // the links come up in the boot dispatch, so the static is written at boot end, together with the C route
    expect(sWrites[0]!.t).toBeGreaterThanOrEqual(r1.bootedAt!);
    expect(r1.tables.rib.get('10.2.0.0/24')).toMatchObject({ nextHop: '10.9.0.2', ad: 1 });
    expect(sim.link(BACKUP)!.up).toBe(true);

    const first = pingFrom(sim, 'pc1', '10.2.0.10');
    expect(first.text).toContain('Sent 5, received 5, lost 0');
    const ttl = ofKind(first.evs, 'mutation').find((e) => e.mutation.reason === 'TtlDecrement' && e.mutation.device === 'r1')!;
    expect(ttl.mutation.cause).toBe(`ip route 10.2.0.0 ${MASK24} 10.9.0.2`);

    // cut the primary: the floating static is installed in the same instant, on both routers
    const cutAt = sim.now;
    sim.injectFault(cutAt, { id: 'cut', kind: 'cable-cut', target: { link: PRIMARY } });
    sim.runFor(SEC);
    const after = sim.trace(0).events.filter((e) => e.t >= cutAt);
    const failover = ofKind(after, 'tableWrite').filter((e) => e.device === 'r1' && e.key === '10.2.0.0/24');
    expect(failover).toHaveLength(1);
    expect(failover[0]!.t).toBe(cutAt);
    expect(failover[0]!.row).toMatchObject({ nextHop: '10.8.0.2', ad: 5 });
    expect(ofKind(after, 'tableExpire').filter((e) => e.device === 'r1' && e.key === '10.2.0.0/24')).toEqual([]);
    expect(sim.device('r2')!.tables.rib.get('10.1.0.0/24')).toMatchObject({ nextHop: '10.8.0.1', ad: 5 });
    const second = pingFrom(sim, 'pc1', '10.2.0.10');
    expect(second.text).toContain('Sent 5, received 5, lost 0');
    const ttl2 = ofKind(second.evs, 'mutation').find((e) => e.mutation.reason === 'TtlDecrement' && e.mutation.device === 'r1')!;
    expect(ttl2.mutation.cause).toBe(`ip route 10.2.0.0 ${MASK24} 10.8.0.2 5`);
    const routes = cliConsole(sim, 'r1', ['show ip route']).results[0]!.output;
    expect(routes).toContain('10.2.0.0/24  via 10.8.0.2 [5/0]');

    // repair: distance 1 takes over again
    const repairAt = sim.now;
    sim.injectFault(repairAt, { id: 'cut', kind: 'cable-cut', target: { link: PRIMARY }, params: { restore: true } });
    sim.runFor(5 * SEC);
    expect(r1.tables.rib.get('10.2.0.0/24')).toMatchObject({ nextHop: '10.9.0.2', ad: 1 });
    const back = sim.trace(0).events.filter((e) => e.t >= repairAt && e.kind === 'tableWrite' && e.device === 'r1' && e.key === '10.2.0.0/24');
    expect(back).toHaveLength(1);
    const third = pingFrom(sim, 'pc1', '10.2.0.10');
    expect(third.text).toContain('Sent 5, received 5, lost 0');
  });

  it('the router sources its own traffic through a recursive static: a host route whose next hop is behind another line', () => {
    const sim = floatingWorld(5);
    cliConsole(sim, 'r1', ['enable', 'configure terminal', 'ip route 10.2.0.10 255.255.255.255 10.2.0.1', 'end']);
    expect(sim.device('r1')!.tables.rib.get('10.2.0.10/32')).toMatchObject({ source: 'S', nextHop: '10.2.0.1' });
    // 10.2.0.1 is not on a connected network: the egress (and the source address) come from the /24 line's next hop
    const own = pingFrom(sim, 'r1', '10.2.0.10');
    expect(own.text).not.toContain('No route');
    expect(own.text).toContain('Sent 5, received 5, lost 0');
    // sourced from GI1 (10.9.0.1), the egress of the /24 line's next hop
    const requests = ofKind(own.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag?.startsWith('ping#'));
    expect(requests).toHaveLength(5);
    expect(requests.every((e) => e.pdu.summary.startsWith('ICMP echo request 10.9.0.1 > 10.2.0.10'))).toBe(true);
  });

  it('runs byte-identically twice', () => {
    const run = (): string => {
      const sim = floatingWorld(11);
      sim.injectFault(sim.now, { id: 'cut', kind: 'cable-cut', target: { link: PRIMARY } });
      pingFrom(sim, 'pc1', '10.2.0.10');
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });
});
