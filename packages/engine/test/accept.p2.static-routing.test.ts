/**
 * P2 acceptance — static routing (ARCHITECTURE-P2 §10.1 `accept.p2.static-routing`; D13, §3.5, §5.2, §7 W4 qa).
 *
 * Real worlds built with `createP2Simulation` (§0 rule 13) in the P2 profile, with every approved W1–W3 daemon
 * factory laid over the registry — what the real catalog holds once the W4 flip has landed. PC1 — R1 — R2 — PC2 with a
 * primary Ethernet link and a backup serial link between the routers:
 *   • the floating static `ip route 10.3.0.0 255.255.0.0 10.9.0.2 5` waits while the distance-1 line is installed,
 *     is installed in the instant the primary is cut and withdrawn again when the cable is restored;
 *   • a fully specified route (interface and next hop) is installed and forwards;
 *   • a three-level recursive static resolves, a line whose next hop resolves only through itself never installs;
 *   • a static configured before its link is up is installed when the next hop becomes reachable, not before;
 *   • IPv6: a static with a link-local next hop and an interface forwards, and a floating IPv6 static takes over
 *     after a cut;
 *   • the `route` lab assertion picks a /24 over a /16 (§9.2b: un-skipped by the §7 W5 sim item that implements the
 *     kind).
 */
import { describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Route6Row, RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { linkLocalFromMac } from '../src/core/addr6.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createHsrp } from '../src/protocols/hsrp.js';
import { createNat } from '../src/protocols/nat.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { console as cliConsole, ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const SE0 = 'Serial0/0/0';
const PC = 'GigabitEthernet0';
const MASK24 = '255.255.255.0';
const MASK30 = '255.255.255.252';
const PRIMARY = 'l_primary';
const BACKUP = 'l_backup';
const BOOT = 90 * SEC;

/** R1's lines (§10.1 row). */
const PRIMARY_LINE = 'ip route 10.3.0.0 255.255.0.0 10.8.0.2';
const FLOATING_LINE = 'ip route 10.3.0.0 255.255.0.0 10.9.0.2 5';
const FULL_LINE = `ip route 10.3.1.0 255.255.255.0 ${GI1} 10.8.0.2`;
const KEY16 = '10.3.0.0/16';
const KEY24 = '10.3.1.0/24';

/** Every approved W1–W3 daemon with its real factory (the W4 flip registers exactly these; capwap-* arrive in W5). */
function p2Daemons(): P2FactoryOverlay {
  const out: Record<string, ProcessFactory> = {
    vlan: createVlan,
    dtp: createDtp,
    etherchannel: createEtherchannel,
    stp: createStp,
    nat: createNat,
    hsrp: createHsrp,
    'dhcpv6-client': createDhcpv6Client,
    'dhcpv6-server': createDhcpv6Server,
  };
  return out;
}

interface WorldOptions {
  readonly seed?: number;
  /** R1's Serial0/0/0 starts administratively down (the backup link stays down until `no shutdown`). */
  readonly serialShut?: boolean;
  /** Extra R1 global lines. */
  readonly extraR1?: readonly string[];
}

/** A dual-stack PC config: address, gateway and SLAAC. */
function pc(name: string, address: string, gateway: string): string {
  return configText([[`hostname ${name}`], section(`interface ${PC}`, [`ip address ${address} ${MASK24}`, 'ipv6 address autoconfig']), [`ip default-gateway ${gateway}`]]);
}

/**
 * PC1 (10.1.0.10) — R1 — R2 — PC2 (10.3.0.10). Primary R1 Gi0/1 – R2 Gi0/0 (10.8.0.0/30, 2001:db8:8::/64); backup
 * R1 Se0/0/0 – R2 Se0/0/0 (10.9.0.0/30, 2001:db8:9::/64, R1 clocks). R2 Loopback0 10.3.1.1/24 lies inside 10.3.0.0/16.
 * R1: the distance-1 line over the primary, the floating line over the backup and a fully specified /24 to the
 * loopback; R2: the mirror image for 10.1.0.0/24. Booted for 90 s (the links come up in the boot dispatch).
 */
function world(o: WorldOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 3, factories: p2Daemons() });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', '10.1.0.10', '10.1.0.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', '10.3.0.10', '10.3.0.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1', 'ipv6 unicast-routing'],
      section(`interface ${GI0}`, [`ip address 10.1.0.1 ${MASK24}`, 'ipv6 address 2001:db8:1::1/64', 'no shutdown']),
      section(`interface ${GI1}`, [`ip address 10.8.0.1 ${MASK30}`, 'ipv6 address 2001:db8:8::1/64', 'no shutdown']),
      section(`interface ${SE0}`, [`ip address 10.9.0.1 ${MASK30}`, 'ipv6 address 2001:db8:9::1/64', 'clock rate 64000', o.serialShut ? 'shutdown' : 'no shutdown']),
      [PRIMARY_LINE, FLOATING_LINE, FULL_LINE, ...(o.extraR1 ?? [])],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: configText([
      ['hostname R2', 'ipv6 unicast-routing'],
      section(`interface ${GI0}`, [`ip address 10.8.0.2 ${MASK30}`, 'ipv6 address 2001:db8:8::2/64', 'no shutdown']),
      section(`interface ${GI1}`, [`ip address 10.3.0.1 ${MASK24}`, 'ipv6 address 2001:db8:3::1/64', 'no shutdown']),
      section(`interface ${SE0}`, [`ip address 10.9.0.2 ${MASK30}`, 'ipv6 address 2001:db8:9::2/64', 'no shutdown']),
      section('interface Loopback0', [`ip address 10.3.1.1 ${MASK24}`]),
      [`ip route 10.1.0.0 ${MASK24} 10.8.0.1`, `ip route 10.1.0.0 ${MASK24} 10.9.0.1 5`],
    ]),
  });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ id: PRIMARY, a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ id: BACKUP, a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ id: 'l_pc2', a: { device: 'r2', port: GI1 }, b: { device: 'pc2', port: PC } });
  sim.runFor(BOOT);
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
const rib = (sim: Simulation, dev: string, key: string): RouteRow | undefined => sim.device(dev)!.tables.rib.get(key);
const rib6 = (sim: Simulation, dev: string, key: string): Route6Row | undefined => sim.device(dev)!.tables.get<Route6Row>('rib6')!.get(key);
/** `tableWrite` events of the rib of `dev` for `key`, optionally from `since`. */
const writes = (sim: Simulation, dev: string, key: string, since = 0) => ofKind(events(sim), 'tableWrite').filter((e) => e.device === dev && e.table === 'rib' && e.key === key && e.t >= since);
const expires = (sim: Simulation, dev: string, key: string, since = 0) => ofKind(events(sim), 'tableExpire').filter((e) => e.device === dev && e.table === 'rib' && e.key === key && e.t >= since);
/** Time of the first `linkState up` of `link` at or after `since`; throws when there is none. */
function linkUpAt(sim: Simulation, link: string, since = 0): number {
  const e = ofKind(events(sim), 'linkState').find((x) => x.link === link && x.up && x.t >= since);
  if (e === undefined) throw new Error(`${link} never came up after ${since}`);
  return e.t;
}

/** Ping `target` from `device`, run until idle, return the output and the events since. */
function ping(sim: Simulation, device: string, target: string): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, `ping ${target}`);
  if (r.error !== undefined) throw new Error(`ping ${target} on ${device}: ${r.output}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}

/** The cause of the first hop-count decrement stamped by `device` among `evs`. */
function decrementCause(evs: readonly TraceEvent[], device: string): string | undefined {
  return ofKind(evs, 'mutation').find((e) => e.mutation.reason === 'TtlDecrement' && e.mutation.device === device)?.mutation.cause;
}

/** Type global config lines on `device` (enable, configure terminal, the lines, end). */
function config(sim: Simulation, device: string, lines: readonly string[]): void {
  cliConsole(sim, device, ['enable', 'configure terminal', ...lines, 'end']);
}

function cut(sim: Simulation, link: string, restore = false): number {
  const at = sim.now;
  sim.injectFault(at, { id: `cut:${link}`, kind: 'cable-cut', target: { link }, ...(restore ? { params: { restore: true } } : {}) });
  return at;
}

describe('accept P2: static routing — floating static over a backup link (D13)', () => {
  it('installs only the distance-1 route while the primary is up; the [5/0] line waits as a candidate', () => {
    const sim = world();
    expect(sim.link(PRIMARY)!.up).toBe(true);
    expect(sim.link(BACKUP)!.up).toBe(true);
    expect(rib(sim, 'r1', KEY16)).toMatchObject({ source: 'S', nextHop: '10.8.0.2', ad: 1, metric: 0 });
    const w = writes(sim, 'r1', KEY16);
    expect(w).toHaveLength(1);
    expect(w[0]!.row).toMatchObject({ nextHop: '10.8.0.2', ad: 1 });
    expect(expires(sim, 'r1', KEY16)).toEqual([]);
    // D13: the static is written in the dispatch that installed the connected route of its next hop
    expect(w[0]!.t).toBe(writes(sim, 'r1', '10.8.0.0/30')[0]!.t);
    expect(rib(sim, 'r2', '10.1.0.0/24')).toMatchObject({ source: 'S', nextHop: '10.8.0.1', ad: 1 });
    const routes = cliConsole(sim, 'r1', ['show ip route']).results[0]!.output;
    expect(routes).toMatch(/10\.3\.0\.0\/16\s+via 10\.8\.0\.2 \[1\/0\]/);
    expect(routes).not.toContain('[5/0]');
    const r = ping(sim, 'pc1', '10.3.0.10');
    expect(r.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(r.evs, 'r1')).toBe(PRIMARY_LINE);
    expect(ofKind(r.evs, 'frameTx').filter((e) => e.link === BACKUP && sim.pdu(e.pdu.id)?.layer('icmpv4') !== undefined)).toEqual([]);
  });

  it('cutting the primary installs [5/0] in the same instant; restoring the cable reverses it', () => {
    const sim = world();
    const T = cut(sim, PRIMARY);
    sim.runFor(SEC);
    expect(sim.link(PRIMARY)!.up).toBe(false);
    const failover = writes(sim, 'r1', KEY16, T);
    expect(failover).toHaveLength(1);
    expect(failover[0]!.t).toBe(T);
    expect(failover[0]!.row).toMatchObject({ nextHop: '10.9.0.2', ad: 5 });
    expect(expires(sim, 'r1', KEY16, T)).toEqual([]);
    expect(rib(sim, 'r1', KEY16)).toMatchObject({ nextHop: '10.9.0.2', ad: 5, updatedAt: T });
    const r2Failover = writes(sim, 'r2', '10.1.0.0/24', T);
    expect(r2Failover).toHaveLength(1);
    expect(r2Failover[0]!.t).toBe(T);
    expect(rib(sim, 'r2', '10.1.0.0/24')).toMatchObject({ nextHop: '10.9.0.1', ad: 5 });
    expect(cliConsole(sim, 'r1', ['show ip route']).results[0]!.output).toMatch(/10\.3\.0\.0\/16\s+via 10\.9\.0\.2 \[5\/0\]/);
    const over = ping(sim, 'pc1', '10.3.0.10');
    expect(over.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(over.evs, 'r1')).toBe(FLOATING_LINE);
    expect(ofKind(over.evs, 'frameTx').filter((e) => e.link === BACKUP && sim.pdu(e.pdu.id)?.layer('icmpv4') !== undefined).length).toBeGreaterThanOrEqual(10);

    // repair: the distance-1 line is installed again when its next hop is reachable (the link-up), and nothing else
    const T2 = cut(sim, PRIMARY, true);
    sim.runFor(10 * SEC);
    expect(sim.link(PRIMARY)!.up).toBe(true);
    const back = writes(sim, 'r1', KEY16, T2);
    expect(back).toHaveLength(1);
    expect(back[0]!.row).toMatchObject({ nextHop: '10.8.0.2', ad: 1 });
    expect(back[0]!.t).toBe(linkUpAt(sim, PRIMARY, T2));
    expect(expires(sim, 'r1', KEY16, T2)).toEqual([]);
    expect(rib(sim, 'r1', KEY16)).toMatchObject({ nextHop: '10.8.0.2', ad: 1 });
    expect(rib(sim, 'r2', '10.1.0.0/24')).toMatchObject({ nextHop: '10.8.0.1', ad: 1 });
    const again = ping(sim, 'pc1', '10.3.0.10');
    expect(again.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(again.evs, 'r1')).toBe(PRIMARY_LINE);
  });

  it('a fully specified route (exit interface and next hop) is installed, forwards, and goes with its interface', () => {
    const sim = world();
    expect(rib(sim, 'r1', KEY24)).toMatchObject({ source: 'S', iface: GI1, nextHop: '10.8.0.2', ad: 1 });
    const r = ping(sim, 'pc1', '10.3.1.1');
    expect(r.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(r.evs, 'r1')).toBe(FULL_LINE);
    // its interface goes down with the cut: withdrawn; the loopback is then reached through the floating /16
    const T = cut(sim, PRIMARY);
    sim.runFor(SEC);
    expect(rib(sim, 'r1', KEY24)).toBeUndefined();
    expect(expires(sim, 'r1', KEY24, T)).toHaveLength(1);
    const via16 = ping(sim, 'pc1', '10.3.1.1');
    expect(via16.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(via16.evs, 'r1')).toBe(FLOATING_LINE);
  });

  it('a three-level recursive static resolves; a line whose next hop resolves only through itself is never installed', () => {
    const sim = world();
    const L1 = 'ip route 172.16.0.0 255.255.0.0 10.8.0.2';
    const L2 = 'ip route 192.168.9.0 255.255.255.0 172.16.1.1';
    const L3 = 'ip route 10.77.0.0 255.255.0.0 192.168.9.9';
    const SELF = 'ip route 10.66.0.0 255.255.0.0 10.66.1.1';
    // deepest line first: each waits for the one below it
    config(sim, 'r1', [L3, L2, L1, SELF]);
    expect(rib(sim, 'r1', '172.16.0.0/16')).toMatchObject({ source: 'S', nextHop: '10.8.0.2', ad: 1 });
    expect(rib(sim, 'r1', '192.168.9.0/24')).toMatchObject({ source: 'S', nextHop: '172.16.1.1', ad: 1 });
    expect(rib(sim, 'r1', '10.77.0.0/16')).toMatchObject({ source: 'S', nextHop: '192.168.9.9', ad: 1 });
    expect(rib(sim, 'r1', '10.66.0.0/16')).toBeUndefined();
    expect(writes(sim, 'r1', '10.66.0.0/16')).toEqual([]);
    expect(sim.device('r1')!.running.render()).toContain(SELF);
    // forwarding walks the chain down to the connected next hop with the top line as the cause
    const r = ping(sim, 'pc1', '10.77.5.5');
    expect(r.text).not.toContain('No route');
    expect(decrementCause(r.evs, 'r1')).toBe(L3);
    const requests = ofKind(r.evs, 'frameTx').filter((e) => e.link === PRIMARY && e.from.device === 'r1' && sim.pdu(e.pdu.id)?.get('icmpv4.type') === 8);
    expect(requests).toHaveLength(5);
    // withdrawing the connected-side line takes the whole chain down
    config(sim, 'r1', [`no ${L1}`]);
    for (const key of ['172.16.0.0/16', '192.168.9.0/24', '10.77.0.0/16']) expect(rib(sim, 'r1', key)).toBeUndefined();
  });

  it('a static configured before its link is up is installed when the next hop becomes reachable, not before', () => {
    const WAITING = 'ip route 10.4.0.0 255.255.255.0 10.9.0.2';
    const sim = world({ serialShut: true, extraR1: [WAITING] });
    expect(sim.link(BACKUP)!.up).toBe(false);
    expect(sim.device('r1')!.running.render()).toContain(WAITING);
    expect(rib(sim, 'r1', '10.4.0.0/24')).toBeUndefined();
    expect(writes(sim, 'r1', '10.4.0.0/24')).toEqual([]);
    expect(rib(sim, 'r1', '10.9.0.0/30')).toBeUndefined();
    // the floating candidate over the same next hop is not installed either: the primary is up
    expect(writes(sim, 'r1', KEY16)).toHaveLength(1);
    expect(rib(sim, 'r1', KEY16)).toMatchObject({ nextHop: '10.8.0.2', ad: 1 });

    const T = sim.now;
    cliConsole(sim, 'r1', ['enable', 'configure terminal', `interface ${SE0}`, 'no shutdown', 'end']);
    sim.runFor(10 * SEC);
    expect(sim.link(BACKUP)!.up).toBe(true);
    const up = linkUpAt(sim, BACKUP, T);
    const w = writes(sim, 'r1', '10.4.0.0/24');
    expect(w).toHaveLength(1);
    expect(w[0]!.t).toBe(up);
    expect(w[0]!.t).toBe(writes(sim, 'r1', '10.9.0.0/30', T)[0]!.t);
    expect(rib(sim, 'r1', '10.4.0.0/24')).toMatchObject({ source: 'S', nextHop: '10.9.0.2', ad: 1, updatedAt: up });
    // still one write of the /16: the floating line stays a candidate
    expect(writes(sim, 'r1', KEY16)).toHaveLength(1);
  });
});

describe('accept P2: static routing — IPv6', () => {
  it('a static with a link-local next hop and an interface forwards; a floating IPv6 static takes over after a cut', () => {
    const sim = world({ seed: 4 });
    const r2Ll = linkLocalFromMac(sim.device('r2')!.port(GI0)!.mac);
    const r1Ll = linkLocalFromMac(sim.device('r1')!.port(GI1)!.mac);
    const R1_LL_LINE = `ipv6 route 2001:db8:3::/64 ${GI1} ${r2Ll}`;
    const R1_FLOATING = 'ipv6 route 2001:db8:3::/64 2001:db8:9::2 5';
    config(sim, 'r1', [R1_LL_LINE, R1_FLOATING]);
    config(sim, 'r2', [`ipv6 route 2001:db8:1::/64 ${GI0} ${r1Ll}`, 'ipv6 route 2001:db8:1::/64 2001:db8:9::1 5']);
    sim.runFor(2 * SEC);
    expect(rib6(sim, 'r1', '2001:db8:3::/64')).toMatchObject({ source: 'S', iface: GI1, nextHop: r2Ll, ad: 1 });
    expect(rib6(sim, 'r2', '2001:db8:1::/64')).toMatchObject({ source: 'S', iface: GI0, nextHop: r1Ll, ad: 1 });
    const r = ping(sim, 'pc1', '2001:db8:3::1');
    expect(r.text).toContain('Sending 5 echo requests to 2001:db8:3::1');
    expect(r.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(r.evs, 'r1')).toBe(R1_LL_LINE);
    const onPrimary = ofKind(r.evs, 'frameTx').filter((e) => e.link === PRIMARY && sim.pdu(e.pdu.id)?.get('icmpv6.type') === 128);
    expect(onPrimary).toHaveLength(5);

    const T = cut(sim, PRIMARY);
    sim.runFor(2 * SEC);
    expect(rib6(sim, 'r1', '2001:db8:3::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:9::2', ad: 5 });
    expect(rib6(sim, 'r2', '2001:db8:1::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:9::1', ad: 5 });
    const w = ofKind(events(sim), 'tableWrite').filter((e) => e.device === 'r1' && e.table === 'rib6' && e.key === '2001:db8:3::/64' && e.t >= T);
    expect(w).toHaveLength(1);
    expect(w[0]!.t).toBe(T);
    const over = ping(sim, 'pc1', '2001:db8:3::1');
    expect(over.text).toContain('Sent 5, received 5, lost 0');
    expect(decrementCause(over.evs, 'r1')).toBe(R1_FLOATING);
    const onBackup = ofKind(over.evs, 'frameTx').filter((e) => e.link === BACKUP && sim.pdu(e.pdu.id)?.get('icmpv6.type') === 128);
    expect(onBackup).toHaveLength(5);
  });
});

describe('accept P2: static routing — the route lab assertion', () => {
  // `sim/lab-checks.ts` grades the `route` LabAssertion kind since §7 W5 sim (§9.2b): the longest-prefix winner.
  it('picks a /24 over a /16 as the longest-prefix winner', () => {
    const sim = world();
    const task = (id: string, network: string, destination: string): NonNullable<ScenarioInfo['tasks']>[number] => ({
      id,
      title: id,
      description: `${destination} is routed through ${network}`,
      points: 1,
      assertions: [{ kind: 'route', device: 'R1', destination, network }],
    });
    const lab: ScenarioInfo = {
      name: 'accept-p2-static-routing-route-kind',
      title: 'Static routing: longest prefix',
      description: 'The route assertion reports the longest-prefix winner.',
      category: 'ccna2-lab',
      build: () => sim.exportTopology(),
      tasks: [task('host-in-24', KEY24, '10.3.1.1'), task('host-in-24-not-16', KEY16, '10.3.1.1'), task('host-in-16', KEY16, '10.3.5.5')],
    };
    const status = evaluateLab(sim, lab);
    expect(status.results.map((r) => [r.task, r.pass])).toEqual([
      ['host-in-24', true],
      ['host-in-24-not-16', false],
      ['host-in-16', true],
    ]);
  });
});
