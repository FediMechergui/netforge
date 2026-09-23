/**
 * P2 acceptance — HSRP failover [SHOULD S2] (ARCHITECTURE-P2 §10.1 `accept.p2.hsrp`; D8, D15, §3.10, §4.2–§4.3,
 * §5.2, §7 W4 qa [S2]).
 *
 * Real worlds built with `createP2Simulation` (§0 rule 13) in the P2 profile, with every approved W1–W3 daemon
 * factory laid over the registry — what the real catalog holds once the W4 flip has landed. The §3.10 setup: R1 Gi0/0
 * 192.168.1.2 (`standby 1 priority 110`, `standby 1 preempt`) and R2 Gi0/0 192.168.1.3 on one LAN through SW1 (an
 * NF-C2960 running PVST+, its three edge ports `spanning-tree portfast` so that a returning router hears the LAN
 * while it listens — without PortFast the 30 s forward delay lets R1 elect itself alone before it can hear R2, and
 * §3.10 step 6 does not apply), both `standby version 2` / `standby 1 ip 192.168.1.1`; PC1 uses gateway .1.
 *   • R1 active, R2 standby; an ARP for .1 is answered only by R1 with 00:00:0c:9f:f0:01;
 *   • R1 powered off at T → R2 active at t ∈ [T + 7 s, T + 10 s]; a continuous ping loses only the echoes sent in
 *     that window and the PC sends no new ARP;
 *   • preempt returns R1 to active;
 *   • the v1 variant uses 00:00:0c:07:ac:01 and 224.0.0.2.
 */
import { describe, expect, it } from 'vitest';
import { HSRP_V1_GROUP, HSRP_V2_GROUP, UDP_PORT_HSRP } from '../src/contracts/pdu.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { HsrpRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createHsrp } from '../src/protocols/hsrp.js';
import { createNat } from '../src/protocols/nat.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, output } from './sim.harness.js';

const G0 = 'GigabitEthernet0/0';
const PC = 'GigabitEthernet0';
const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA3 = 'FastEthernet0/3';
const MASK24 = '255.255.255.0';
const VIP = '192.168.1.1';
const R1_IP = '192.168.1.2';
const R2_IP = '192.168.1.3';
const PC1_IP = '192.168.1.10';
const VMAC_V2 = '00:00:0c:9f:f0:01';
const VMAC_V1 = '00:00:0c:07:ac:01';
/** Router boot, the 30 s PVST+ forward delay of SW1's ports, listen + speak (20 s) and a margin for the routers to meet. */
const SETTLED = 150 * SEC;

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

interface LabOptions {
  readonly seed?: number;
  readonly version?: 1 | 2;
  /** R1 `standby 1 preempt` (default true). */
  readonly preempt?: boolean;
}

/** SW1: PortFast on the three edge ports (the router and host ports). */
const SW1_CONFIG = configText([['hostname SW1'], ...[FA1, FA2, FA3].map((port) => section(`interface ${port}`, ['spanning-tree portfast']))]);

function routerConfig(name: string, ip: string, o: LabOptions, extra: readonly string[]): string {
  const lines = [`ip address ${ip} ${MASK24}`];
  if ((o.version ?? 2) === 2) lines.push('standby version 2');
  lines.push(`standby 1 ip ${VIP}`, ...extra, 'no shutdown');
  return configText([[`hostname ${name}`], section(`interface ${G0}`, lines)]);
}

/** R1 (priority 110, preempt), R2 and PC1 on SW1, booted and past the election. */
function lab(o: LabOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 21, factories: p2Daemons() });
  const r1Extra = ['standby 1 priority 110'];
  if (o.preempt !== false) r1Extra.push('standby 1 preempt');
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', R1_IP, o, r1Extra) });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: routerConfig('R2', R2_IP, o, []) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: SW1_CONFIG });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', PC1_IP, MASK24, VIP) });
  sim.addLink({ id: 'l_r1', a: { device: 'r1', port: G0 }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_r2', a: { device: 'r2', port: G0 }, b: { device: 'sw1', port: FA2 } });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC }, b: { device: 'sw1', port: FA3 } });
  sim.runFor(SETTLED);
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
const row = (sim: Simulation, dev: string): HsrpRow | undefined => sim.device(dev)!.tables.get<HsrpRow>('hsrp')?.rows()[0];
const virtual4 = (sim: Simulation, dev: string) => sim.device(dev)!.port(G0)!.l3.virtual4;
const created = (evs: readonly TraceEvent[], dev: string, tag: string) => ofKind(evs, 'pduCreated').filter((e) => e.device === dev && e.pdu.tag === tag);
/** HSRP state transitions of `dev` (machine 'hsrp') in trace order. */
const transitions = (evs: readonly TraceEvent[], dev: string) =>
  ofKind(evs, 'debug').filter((e) => e.event.device === dev && e.event.fsm?.machine === 'hsrp').map((e) => ({ t: e.t, from: e.event.fsm!.from, to: e.event.fsm!.to }));
const camPortOf = (sim: Simulation, mac: string): string | undefined => sim.device('sw1')!.tables.cam.rows().find((r) => r.mac === mac)?.port;

/** Ping the gateway from PC1, run until idle; the output and the events since. */
function ping(sim: Simulation): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, `ping ${VIP}`);
  if (r.error !== undefined) throw new Error(`ping: ${r.output}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}

describe('accept P2: HSRP [S2] — election and the virtual gateway (§3.10)', () => {
  it('R1 is active and R2 standby; an ARP for .1 is answered only by R1, with 00:00:0c:9f:f0:01', () => {
    const sim = lab();
    expect(row(sim, 'r1')).toMatchObject({ iface: G0, group: 1, version: 2, state: 'active', priority: 110, preempt: true, virtualIp: VIP, virtualMac: VMAC_V2, active: 'local', standby: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', priority: 100, preempt: false, virtualMac: VMAC_V2, active: R1_IP, standby: 'local' });
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    expect(virtual4(sim, 'r2') ?? []).toEqual([]);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA1);
    // hellos: UDP 1985 to 224.0.0.102, background; the active router sends them from the virtual MAC
    const hello = created(events(sim), 'r1', 'hsrp-hello').map((e) => sim.pdu(e.pdu.id)!).at(-1)!;
    expect(hello.layer('ipv4')!.fields).toMatchObject({ dst: HSRP_V2_GROUP, ttl: 1 });
    expect(hello.layer('udp')!.fields).toMatchObject({ srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP });
    expect(hello.layer('ethernet')!.fields.src).toBe(VMAC_V2);
    expect(hello.meta.background).toBe(true);

    const before = created(events(sim), 'r1', 'arp-reply').length + created(events(sim), 'r2', 'arp-reply').length;
    const r = ping(sim);
    expect(r.text).toContain('Sent 5, received 5, lost 0');
    const answers = (dev: string) => created(r.evs, dev, 'arp-reply').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('arp')!.fields.spa === VIP);
    expect(answers('r1')).toHaveLength(1);
    expect(answers('r2')).toHaveLength(0);
    expect(answers('r1')[0]!.layer('arp')!.fields.sha).toBe(VMAC_V2);
    expect(answers('r1')[0]!.layer('ethernet')!.fields.src).toBe(VMAC_V2);
    expect(created(events(sim), 'r1', 'arp-reply').length + created(events(sim), 'r2', 'arp-reply').length).toBe(before + 1);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V2 });
    // the replies came from R1 through the virtual address
    const replies = ofKind(r.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
    expect(replies.every((e) => sim.pdu(e.pdu.id)!.get('ipv4.src') === VIP)).toBe(true);
    expect(ofKind(r.evs, 'pduCreated').filter((e) => e.device === 'r2' && e.pdu.tag === 'echo-reply')).toEqual([]);
  });
});

describe('accept P2: HSRP [S2] — failover and preemption (§3.10 steps 5–6)', () => {
  it('R1 off at T: R2 is active in [T + 7 s, T + 10 s]; a continuous ping loses only the echoes sent in that window; PC1 sends no new ARP', () => {
    const sim = lab();
    expect(ping(sim).text).toContain('Sent 5, received 5, lost 0');
    const arpBefore = created(events(sim), 'pc1', 'arp-request').length;
    const T = sim.now;
    const cursor = sim.trace(0).next;
    sim.setPower('r1', false);
    // a continuous ping: one five-echo ping after another, each started as the previous one ends (2 s per lost echo)
    const sessions: string[] = [];
    for (let k = 0; k < 3; k++) {
      const session = sim.cli.open('pc1', 'console');
      const r = sim.cli.exec(session, `ping ${VIP}`);
      if (r.error !== undefined) throw new Error(`ping: ${r.output}`);
      sessions.push(session);
      sim.runFor(10 * SEC);
    }
    sim.runFor(12 * SEC);
    const since = sim.trace(cursor).events;
    const takeover = transitions(since, 'r2').find((x) => x.to === 'active')!;
    expect(takeover).toBeDefined();
    expect(takeover.from).toBe('standby');
    expect(takeover.t).toBeGreaterThanOrEqual(T + 7 * SEC);
    expect(takeover.t).toBeLessThanOrEqual(T + 10 * SEC);
    expect(row(sim, 'r2')).toMatchObject({ state: 'active', active: 'local' });
    expect(virtual4(sim, 'r2')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA2);
    // every echo: lost iff sent before R2 took over (the replies name the request they answer)
    const answered = new Set(ofKind(since, 'pduConsumed').filter((e) => e.device === 'pc1' && e.pdu.tag === 'echo-reply').map((e) => sim.pdu(e.pdu.id)?.meta.triggeredBy));
    const echoes = ofKind(since, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#')).map((e) => ({ t: e.t, answered: answered.has(e.pdu.id) }));
    expect(echoes).toHaveLength(15);
    const lost = echoes.filter((e) => !e.answered);
    const got = echoes.filter((e) => e.answered);
    expect(lost.length).toBeGreaterThan(0);
    expect(got.length).toBeGreaterThan(0);
    expect(lost.every((e) => e.t >= T && e.t <= takeover.t)).toBe(true);
    expect(got.every((e) => e.t >= takeover.t)).toBe(true);
    const totals = sessions.map((s) => /Sent 5, received (\d), lost (\d)/.exec(output(since, s))!);
    expect(totals.reduce((n, m) => n + Number(m[2]), 0)).toBe(lost.length);
    expect(totals.reduce((n, m) => n + Number(m[1]), 0)).toBe(got.length);
    // no new ARP: PC1 kept the virtual MAC, which now lives on R2's port
    expect(created(events(sim), 'pc1', 'arp-request').length).toBe(arpBefore);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V2 });
    const garp = created(since, 'r2', 'arp-gratuitous').map((e) => sim.pdu(e.pdu.id)!).find((p) => p.layer('arp')!.fields.spa === VIP)!;
    expect(garp).toBeDefined();
    expect(garp.layer('ethernet')!.fields.src).toBe(VMAC_V2);
  });

  it('preempt returns R1 to active when it comes back: a coup, R2 goes speak then standby', () => {
    const sim = lab();
    sim.setPower('r1', false);
    sim.runFor(15 * SEC);
    expect(row(sim, 'r2')!.state).toBe('active');
    const cursor = sim.trace(0).next;
    sim.setPower('r1', true);
    sim.runFor(SETTLED);
    const since = sim.trace(cursor).events;
    const coups = created(since, 'r1', 'hsrp-coup');
    expect(coups).toHaveLength(1);
    expect(sim.pdu(coups[0]!.pdu.id)!.layer('hsrp')!.fields).toMatchObject({ opCode: 1, priority: 110 });
    expect(transitions(since, 'r1').map((x) => x.to)).toEqual(['listen', 'active']);
    expect(transitions(since, 'r2').map((x) => x.to)).toEqual(['speak', 'standby']);
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', active: 'local', standby: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', active: R1_IP });
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    expect(virtual4(sim, 'r2') ?? []).toEqual([]);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA1);
    expect(ping(sim).text).toContain('Sent 5, received 5, lost 0');
  });

  it('without preempt R1 comes back as standby and R2 stays active', () => {
    const sim = lab({ preempt: false });
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', preempt: false });
    sim.setPower('r1', false);
    sim.runFor(15 * SEC);
    expect(row(sim, 'r2')!.state).toBe('active');
    const cursor = sim.trace(0).next;
    sim.setPower('r1', true);
    sim.runFor(SETTLED);
    expect(created(sim.trace(cursor).events, 'r1', 'hsrp-coup')).toEqual([]);
    expect(row(sim, 'r1')).toMatchObject({ state: 'standby', active: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'active', standby: R1_IP });
    expect(virtual4(sim, 'r1') ?? []).toEqual([]);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA2);
    expect(ping(sim).text).toContain('Sent 5, received 5, lost 0');
  });
});

describe('accept P2: HSRP [S2] — version 1 (§3.10 step 7)', () => {
  it('uses 00:00:0c:07:ac:01 and 224.0.0.2', () => {
    const sim = lab({ version: 1 });
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', version: 1, virtualMac: VMAC_V1 });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', version: 1, virtualMac: VMAC_V1 });
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V1, owner: 'hsrp', local: true }]);
    expect(sim.device('r1')!.port(G0)!.l3.groups4).toEqual([HSRP_V1_GROUP]);
    expect(HSRP_V1_GROUP).toBe('224.0.0.2');
    const hello = created(events(sim), 'r1', 'hsrp-hello').map((e) => sim.pdu(e.pdu.id)!).at(-1)!;
    expect(hello.layer('ipv4')!.fields.dst).toBe(HSRP_V1_GROUP);
    expect(hello.layer('ethernet')!.fields).toMatchObject({ dst: '01:00:5e:00:00:02', src: VMAC_V1 });
    expect(hello.layer('hsrp')!.fields).toMatchObject({ version: 1, group: 1, virtualIp: VIP });
    const r = ping(sim);
    expect(r.text).toContain('Sent 5, received 5, lost 0');
    const answers = created(r.evs, 'r1', 'arp-reply').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('arp')!.fields.spa === VIP);
    expect(answers.map((p) => p.layer('arp')!.fields.sha)).toEqual([VMAC_V1]);
    expect(created(r.evs, 'r2', 'arp-reply').filter((e) => sim.pdu(e.pdu.id)!.layer('arp')!.fields.spa === VIP)).toEqual([]);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V1 });
    expect(camPortOf(sim, VMAC_V1)).toBe(FA1);
  });
});
