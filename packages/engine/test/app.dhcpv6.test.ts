/**
 * app.dhcpv6.test.ts — dhcpv6-client and dhcpv6-server end to end (protocols/dhcpv6-{client,server}.ts;
 * ARCHITECTURE-P2 D16, §3.11, §4.1–§4.3, §7 W3 svc) on real P2-stage worlds (`createP2Simulation`, §0 rule 13) with
 * the real ipv6, nd, udp and dns-client daemons: stateless (INFORMATION-REQUEST / REPLY, DNS learned beside SLAAC),
 * stateful (SOLICIT / ADVERTISE / REQUEST / REPLY, the leased address of origin 'dhcpv6', one binding row, ping),
 * a router interface as client, renew and release, the silence rule (M = O = 0, P1 profile) and determinism.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Ipv6PortAddress } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Dhcpv6BindingRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { DHCPV6_ADVERTISE, DHCPV6_INFORMATION_REQUEST, DHCPV6_RELEASE, DHCPV6_RENEW, DHCPV6_REPLY, DHCPV6_REQUEST, DHCPV6_SOLICIT, duidLlFromMac } from '../src/pdu/codecs/dhcpv6.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server, dhcpv6PoolViews, dhcpv6ServerConfig, ipv6Plus } from '../src/protocols/dhcpv6-server.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const BOOT = 60 * SEC;
const PREFIX = '2001:db8:1::';
const DNS6 = '2001:db8:1::53';

/** Only the two daemons under test among the P2 daemons. */
function svcOnly(): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = undefined;
  out['dhcpv6-client'] = createDhcpv6Client;
  out['dhcpv6-server'] = createDhcpv6Server;
  return out;
}

interface LabOptions {
  seed?: number;
  /** R1 Gi0/0 flags. */
  managed?: boolean;
  other?: boolean;
  /** Pool prefix line (stateful). */
  stateful?: boolean;
  /** No `ipv6 dhcp server` line on Gi0/0 (server silent). */
  noServer?: boolean;
  profile?: 'P1' | 'P2';
  /** Extra PC interface lines. */
  pcLines?: readonly string[];
}

function r1Config(o: LabOptions): string {
  const pool = ['dns-server ' + DNS6, 'domain-name lab.nf'];
  if (o.stateful) pool.unshift(`address prefix ${PREFIX}/64 lifetime 86400 3600`);
  const gi = [`ipv6 address ${PREFIX}1/64`];
  if (o.noServer !== true) gi.push('ipv6 dhcp server LAN6');
  if (o.managed) gi.push('ipv6 nd managed-config-flag');
  if (o.other) gi.push('ipv6 nd other-config-flag');
  gi.push('no shutdown');
  return configText([['hostname R1', 'ipv6 unicast-routing'], section('ipv6 dhcp pool LAN6', pool), section(`interface ${G0}`, gi)]);
}

/** PC1 (ipv6 address autoconfig) — R1 Gi0/0 2001:db8:1::1/64 with pool LAN6, booted and settled. */
function lab(o: LabOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, profile: o.profile ?? 'P2', factories: svcOnly() });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1'], section(`interface ${PC}`, ['ipv6 address autoconfig', ...(o.pcLines ?? [])])]) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config(o) });
  sim.addLink({ id: 'l_pc1_r1', a: { device: 'pc1', port: PC }, b: { device: 'r1', port: G0 } });
  sim.runFor(BOOT + 20 * SEC);
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
/** Apply one interface line through the runtime (the W3 cli grammar of these lines is a parallel item). */
function line(sim: Simulation, device: string, port: string, text: string): boolean {
  const toks = text.split(' ');
  const negate = toks[0] === 'no';
  const dev = sim.device(device)!;
  dev.applyActions('cli', [], sim.now); // sync the device clock, as the facade does before a typed line
  return dev.applyConfigLine([['interface', port]], negate ? toks.slice(1) : toks, negate).ok;
}
/** DHCPv6 message types created by `device`, in order. */
function messages(sim: Simulation, device: string): number[] {
  return ofKind(events(sim), 'pduCreated')
    .filter((e) => e.device === device && e.pdu.tag?.startsWith('dhcpv6-'))
    .map((e) => sim.pdu(e.pdu.id)?.layer('dhcpv6')?.fields.msgType as number);
}
const tags = (sim: Simulation, device: string): string[] => ofKind(events(sim), 'pduCreated').filter((e) => e.device === device && e.pdu.tag?.startsWith('dhcpv6-')).map((e) => e.pdu.tag!);
const addrs = (sim: Simulation, device: string, port: string): readonly Ipv6PortAddress[] => sim.device(device)!.port(port)!.l3.ipv6 ?? [];
const bindings = (sim: Simulation, device: string): Dhcpv6BindingRow[] => sim.device(device)!.tables.get<Dhcpv6BindingRow>('dhcpv6-bindings')?.rows() ?? [];
const sockets = (sim: Simulation, device: string): string[] => (sim.device(device)!.tables.get<SocketRow>('sockets')?.rows() ?? []).map((r) => r.id);
const dnsServers = (sim: Simulation, device: string): unknown => sim.device(device)!.processes.get('dns-client')!.stateSnapshot().state.servers;
const snap6 = (sim: Simulation, device: string): Record<string, unknown> => sim.device(device)!.processes.get('dhcpv6-client')!.stateSnapshot().state;

describe('app.dhcpv6 stateless (O = 1)', () => {
  it('sends exactly INFORMATION-REQUEST then receives REPLY, keeps its SLAAC address and learns the DNS server', () => {
    const sim = lab({ other: true });
    expect(messages(sim, 'pc1')).toEqual([DHCPV6_INFORMATION_REQUEST]);
    expect(messages(sim, 'r1')).toEqual([DHCPV6_REPLY]);
    expect(tags(sim, 'pc1')).toEqual(['dhcpv6-inforeq']);
    expect(tags(sim, 'r1')).toEqual(['dhcpv6-reply']);
    // the request: link-local → ff02::1:2, 546 → 547, DUID-LL of the port MAC, options 23 and 24 asked for
    const req = ofKind(events(sim), 'pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'dhcpv6-inforeq')!;
    const reqPdu = sim.pdu(req.pdu.id)!;
    expect(reqPdu.layer('ipv6')!.fields.dst).toBe('ff02::1:2');
    expect(String(reqPdu.layer('ipv6')!.fields.src)).toMatch(/^fe80:/);
    expect(reqPdu.layer('udp')!.fields).toMatchObject({ srcPort: 546, dstPort: 547 });
    expect(reqPdu.layer('dhcpv6')!.fields).toMatchObject({ msgType: 11, clientDuid: duidLlFromMac(sim.device('pc1')!.port(PC)!.mac), oro: '23,24', elapsedTimeCs: 0 });
    // the reply: unicast to the link-local, triggered by the request, carrying the pool's DNS data
    const rep = ofKind(events(sim), 'pduCreated').find((e) => e.device === 'r1' && e.pdu.tag === 'dhcpv6-reply')!;
    const repPdu = sim.pdu(rep.pdu.id)!;
    expect(repPdu.meta.triggeredBy).toBe(req.pdu.id);
    expect(repPdu.layer('ipv6')!.fields.dst).toBe(reqPdu.layer('ipv6')!.fields.src);
    expect(repPdu.layer('dhcpv6')!.fields).toMatchObject({ msgType: 7, transactionId: reqPdu.layer('dhcpv6')!.fields.transactionId, dnsServers: DNS6, domainList: 'lab.nf' });
    // PC1 keeps its SLAAC address (no dhcpv6 one) and its resolver lists the learned server
    const a = addrs(sim, 'pc1', PC);
    expect(a.some((x) => x.origin === 'slaac' && x.address.startsWith('2001:db8:1:'))).toBe(true);
    expect(a.some((x) => x.origin === 'dhcpv6')).toBe(false);
    expect(dnsServers(sim, 'pc1')).toEqual([DNS6]);
    expect(snap6(sim, 'pc1')).toMatchObject({ clients: [{ iface: PC, mode: 'stateless', state: 'bound', dns: [DNS6], domain: 'lab.nf', address: null }] });
    expect(bindings(sim, 'r1')).toEqual([]);
    // the server socket exists only because Gi0/0 carries `ipv6 dhcp server`
    expect(sockets(sim, 'r1')).toContain('dhcpv6-server#547');
    expect(sockets(sim, 'pc1')).toContain(`dhcpv6-client#${PC}`);
  });

  it('runToIdle returns with the exchange done (only periodic timers remain)', () => {
    const sim = createP2Simulation({ seed: 3, factories: svcOnly() });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1'], section(`interface ${PC}`, ['ipv6 address autoconfig'])]) });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config({ other: true }) });
    sim.addLink({ id: 'l', a: { device: 'pc1', port: PC }, b: { device: 'r1', port: G0 } });
    const stats = sim.runToIdle(200_000);
    expect(stats.stopped).toBeUndefined();
    expect(messages(sim, 'pc1')).toEqual([DHCPV6_INFORMATION_REQUEST]);
    expect(dnsServers(sim, 'pc1')).toEqual([DNS6]);
  });
});

describe('app.dhcpv6 stateful (M = 1)', () => {
  it('SOLICIT, ADVERTISE, REQUEST, REPLY in order; PC1 gets 2001:db8:1::2/128 of origin dhcpv6; one binding row; ping', () => {
    const sim = lab({ managed: true, stateful: true });
    expect(messages(sim, 'pc1')).toEqual([DHCPV6_SOLICIT, DHCPV6_REQUEST]);
    expect(messages(sim, 'r1')).toEqual([DHCPV6_ADVERTISE, DHCPV6_REPLY]);
    const all = [...ofKind(events(sim), 'pduCreated').filter((e) => e.pdu.tag?.startsWith('dhcpv6-'))].map((e) => e.pdu.tag);
    expect(all).toEqual(['dhcpv6-solicit', 'dhcpv6-advertise', 'dhcpv6-request', 'dhcpv6-reply']);
    // each exchange has its own transaction id (RFC 8415 §18.2.2): the REQUEST does not reuse the SOLICIT's, the
    // answers copy the id of the message they answer
    const xids = ofKind(events(sim), 'pduCreated').filter((e) => e.pdu.tag?.startsWith('dhcpv6-')).map((e) => sim.pdu(e.pdu.id)!.layer('dhcpv6')!.fields.transactionId as number);
    expect(xids).toHaveLength(4);
    expect(xids[1]).toBe(xids[0]);
    expect(xids[2]).not.toBe(xids[0]);
    expect(xids[3]).toBe(xids[2]);
    const leased = addrs(sim, 'pc1', PC).find((x) => x.origin === 'dhcpv6');
    expect(leased).toMatchObject({ address: `${PREFIX}2`, prefixLen: 128, origin: 'dhcpv6', state: 'preferred', scope: 'global' });
    expect(leased!.validUntil).toBeDefined();
    const rows = bindings(sim, 'r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `LAN6|${PREFIX}2`, address: `${PREFIX}2`, iaid: sim.device('pc1')!.port(PC)!.ordinal, pool: 'LAN6', duid: duidLlFromMac(sim.device('pc1')!.port(PC)!.mac) });
    expect(rows[0]!.expiresAt).toBe(rows[0]!.updatedAt + 86400 * SEC);
    expect(rows[0]!.preferredUntil).toBe(rows[0]!.updatedAt + 3600 * SEC);
    // the advertise offered the same address with the pool's lifetimes and T1/T2
    const adv = ofKind(events(sim), 'pduCreated').find((e) => e.device === 'r1' && e.pdu.tag === 'dhcpv6-advertise')!;
    expect(sim.pdu(adv.pdu.id)!.layer('dhcpv6')!.fields).toMatchObject({ iaAddress: `${PREFIX}2`, preferredLifetimeS: 3600, validLifetimeS: 86400, t1S: 1800, t2S: 2880, dnsServers: DNS6 });
    expect(dnsServers(sim, 'pc1')).toEqual([DNS6]);
    expect(dhcpv6PoolViews({ config: sim.device('r1')!.running, tables: sim.device('r1')!.tables })).toEqual([
      { name: 'LAN6', prefix: `${PREFIX}/64`, validS: 86400, preferredS: 3600, dns: [DNS6], domain: 'lab.nf', bound: 1, interfaces: [G0] },
    ]);
    // the leased address answers: ping from PC1 to R1 and back over the leased source
    const r = ping(sim, 'pc1', `${PREFIX}1`);
    expect(r.text).toMatch(/Sending 5 echo requests to 2001:db8:1::1/);
    expect(r.text).toMatch(/Sent 5, received 5, lost 0/);
    const log = ofKind(events(sim), 'log').find((e) => e.device === 'pc1' && e.facility === 'DHCPV6');
    expect(log?.message).toBe(`Interface ${PC} received address ${PREFIX}2/128 from ${addrs(sim, 'r1', G0).find((x) => x.scope === 'link-local')!.address}`);
  });

  it('renews at T1 with RENEW and keeps the address; `no ipv6 address autoconfig` … a lost RA flag releases it', () => {
    const sim = lab({ managed: true, stateful: true });
    sim.runFor(1801 * SEC);
    expect(messages(sim, 'pc1')).toEqual([DHCPV6_SOLICIT, DHCPV6_REQUEST, DHCPV6_RENEW]);
    expect(messages(sim, 'r1')).toEqual([DHCPV6_ADVERTISE, DHCPV6_REPLY, DHCPV6_REPLY]);
    expect(addrs(sim, 'pc1', PC).find((x) => x.origin === 'dhcpv6')?.address).toBe(`${PREFIX}2`);
    expect(bindings(sim, 'r1')).toHaveLength(1);
    expect(snap6(sim, 'pc1').clients).toMatchObject([{ state: 'bound', address: `${PREFIX}2` }]);
    // the router stops advertising M: the next RA (solicited by nothing, so the periodic one) turns the client off
    expect(line(sim, 'r1', G0, 'no ipv6 nd managed-config-flag')).toBe(true);
    sim.runFor(300 * SEC);
    expect(messages(sim, 'pc1').at(-1)).toBe(DHCPV6_RELEASE);
    expect(addrs(sim, 'pc1', PC).some((x) => x.origin === 'dhcpv6')).toBe(false);
    expect(bindings(sim, 'r1')).toEqual([]);
    expect(dnsServers(sim, 'pc1')).toEqual([]);
    expect(sockets(sim, 'pc1')).not.toContain(`dhcpv6-client#${PC}`);
  });

  it('a router interface with `ipv6 address dhcp` runs the exchange without a router advertisement', () => {
    const sim = createP2Simulation({ seed: 5, factories: svcOnly() });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config({ stateful: true }) });
    // `ipv6 enable` keeps the link-local address when the dhcp line goes, so the RELEASE can leave
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: configText([['hostname R2'], section(`interface ${G0}`, ['ipv6 enable', 'ipv6 address dhcp', 'no shutdown'])]) });
    sim.addLink({ id: 'l', a: { device: 'r2', port: G0 }, b: { device: 'r1', port: G0 } });
    sim.runFor(BOOT + 20 * SEC);
    expect(messages(sim, 'r2')).toEqual([DHCPV6_SOLICIT, DHCPV6_REQUEST]);
    expect(addrs(sim, 'r2', G0).find((x) => x.origin === 'dhcpv6')).toMatchObject({ address: `${PREFIX}2`, prefixLen: 128, state: 'preferred' });
    expect(bindings(sim, 'r1').map((b) => b.address)).toEqual([`${PREFIX}2`]);
    // `no ipv6 address dhcp` releases it
    expect(line(sim, 'r2', G0, 'no ipv6 address dhcp')).toBe(true);
    sim.runFor(2 * SEC);
    expect(messages(sim, 'r2').at(-1)).toBe(DHCPV6_RELEASE);
    expect(bindings(sim, 'r1')).toEqual([]);
    expect(addrs(sim, 'r2', G0).some((x) => x.origin === 'dhcpv6')).toBe(false);
  });

  it('two clients get ::2 and ::3; a client that solicits again gets its own binding back', () => {
    const sim = createP2Simulation({ seed: 8, factories: svcOnly() });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config({ stateful: true }) });
    for (const id of ['r2', 'r3']) {
      sim.addDevice({ id, type: 'router.nf2911', name: id.toUpperCase(), startupConfig: configText([[`hostname ${id.toUpperCase()}`], section(`interface ${G0}`, ['ipv6 address dhcp', 'no shutdown'])]) });
    }
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addLink({ id: 'l1', a: { device: 'r1', port: G0 }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'r2', port: G0 }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.addLink({ id: 'l3', a: { device: 'r3', port: G0 }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
    sim.runFor(BOOT + 30 * SEC);
    const got = [addrs(sim, 'r2', G0), addrs(sim, 'r3', G0)].map((a) => a.find((x) => x.origin === 'dhcpv6')?.address).sort();
    expect(got).toEqual([`${PREFIX}2`, `${PREFIX}3`]);
    expect(bindings(sim, 'r1').map((b) => b.address).sort()).toEqual([`${PREFIX}2`, `${PREFIX}3`]);
    const before = addrs(sim, 'r2', G0).find((x) => x.origin === 'dhcpv6')!.address;
    sim.setPower('r2', false);
    sim.runFor(SEC);
    sim.setPower('r2', true);
    sim.runFor(BOOT + 20 * SEC);
    expect(addrs(sim, 'r2', G0).find((x) => x.origin === 'dhcpv6')?.address).toBe(before);
    expect(bindings(sim, 'r1')).toHaveLength(2);
  });
});

describe('app.dhcpv6 silence and determinism', () => {
  it('with M = O = 0 no DHCPv6 datagram is sent, and no client socket is opened', () => {
    const sim = lab({ stateful: true });
    sim.runFor(600 * SEC);
    expect(messages(sim, 'pc1')).toEqual([]);
    expect(messages(sim, 'r1')).toEqual([]);
    expect(sockets(sim, 'pc1').filter((s) => s.startsWith('dhcpv6'))).toEqual([]);
    expect(bindings(sim, 'r1')).toEqual([]);
    expect(snap6(sim, 'pc1')).toEqual({ clients: [] });
  });

  it('a server without an `ipv6 dhcp server` interface opens no socket; a P1-profile world stays silent too', () => {
    const p1 = lab({ noServer: true, profile: 'P1' });
    p1.runFor(600 * SEC);
    expect(sockets(p1, 'r1').filter((s) => s.startsWith('dhcpv6'))).toEqual([]);
    expect(messages(p1, 'pc1')).toEqual([]);
    expect(ofKind(events(p1), 'debug').filter((e) => e.event.process === 'dhcpv6-client' || e.event.process === 'dhcpv6-server')).toEqual([]);
    expect(ofKind(events(p1), 'tableWrite').filter((e) => e.table === 'dhcpv6-bindings')).toEqual([]);
  });

  it('a client without a server pauses after 5 sends (1, 2, 4, 8, 16 s) and retries after the 60 s pause; runToIdle returns', () => {
    const sim = lab({ managed: true, stateful: true, noServer: true });
    const sent = ofKind(events(sim), 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag === 'dhcpv6-solicit').map((e) => e.t);
    expect(sent).toHaveLength(5);
    const gaps = sent.slice(1).map((t, i) => (t - sent[i]!) / SEC);
    expect(gaps).toEqual([1, 2, 4, 8]);
    expect(snap6(sim, 'pc1').clients).toMatchObject([{ state: 'paused' }]);
    sim.runFor(100 * SEC);
    expect(ofKind(events(sim), 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag === 'dhcpv6-solicit').length).toBeGreaterThan(5);
    expect(sim.runToIdle(200_000).stopped).toBeUndefined();
  });

  it('a client whose link-local address is a duplicate pauses instead of re-arming its solicit timer; runToIdle returns', () => {
    // R1 and R2 both take fe80::1 by hand: DAD marks R1's link-local duplicate, so the client never has a usable
    // source address. It must wait on the periodic restart timer (which does not hold runToIdle, §4.2).
    const sim = createP2Simulation({ seed: 5, factories: svcOnly() });
    const r = (host: string, extra: readonly string[]): string => configText([['hostname ' + host], section(`interface ${G0}`, ['ipv6 address fe80::1 link-local', ...extra, 'no shutdown'])]);
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r('R1', ['ipv6 address dhcp']) });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: r('R2', []) });
    sim.addLink({ id: 'l', a: { device: 'r1', port: G0 }, b: { device: 'r2', port: G0 } });
    sim.runFor(BOOT);
    expect(addrs(sim, 'r1', G0).map((a) => [a.address, a.state])).toEqual([['fe80::1', 'duplicate']]);
    const idle = sim.runToIdle(20_000);
    expect(idle.stopped).toBeUndefined();
    expect(idle.events).toBeLessThan(2_000);
    expect(snap6(sim, 'r1').clients).toMatchObject([{ iface: G0, mode: 'stateful', state: 'paused' }]);
    expect(messages(sim, 'r1')).toEqual([]);
  });

  it('transaction ids and the whole trace are identical over 3 runs with one seed', () => {
    const runs = [1, 2, 3].map(() => {
      const sim = lab({ managed: true, stateful: true, seed: 11 });
      const xids = ofKind(events(sim), 'pduCreated')
        .filter((e) => e.pdu.tag?.startsWith('dhcpv6-'))
        .map((e) => sim.pdu(e.pdu.id)!.layer('dhcpv6')!.fields.transactionId);
      return { xids, trace: JSON.stringify(events(sim)) };
    });
    expect(runs[0]!.xids).toHaveLength(4);
    expect(runs[1]!.xids).toEqual(runs[0]!.xids);
    expect(runs[2]!.xids).toEqual(runs[0]!.xids);
    expect(runs[1]!.trace).toBe(runs[0]!.trace);
    expect(runs[2]!.trace).toBe(runs[0]!.trace);
  });
});

describe('app.dhcpv6 config readers', () => {
  it('reads pools, lifetimes, DNS servers, domains and serving interfaces; ipv6Plus walks a prefix', () => {
    const sim = lab({ managed: true, stateful: true });
    const cfg = dhcpv6ServerConfig(sim.device('r1')!.running.root);
    expect(cfg.pools).toEqual([{ name: 'LAN6', prefix: PREFIX, prefixLen: 64, validS: 86400, preferredS: 3600, dns: [DNS6], domain: 'lab.nf' }]);
    expect([...cfg.interfaces]).toEqual([[G0, 'LAN6']]);
    expect(ipv6Plus(PREFIX, 2)).toBe(`${PREFIX}2`);
    expect(ipv6Plus(PREFIX, 256)).toBe(`${PREFIX}100`);
    expect(ipv6Plus('2001:db8:1::ff', 1)).toBe('2001:db8:1::100');
  });
});
