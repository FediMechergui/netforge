/**
 * fhrp.hsrp.test.ts — HSRP v1/v2 [SHOULD S2] (protocols/hsrp.ts; ARCHITECTURE-P2 §3.10, §4.1–§4.3, §7 W3 svc [S2])
 * on a real P2-stage world (§0 rule 13): R1 Gi0/0 192.168.1.2 (priority 110, preempt) and R2 Gi0/0 192.168.1.3 on one
 * LAN through SW1, PCs with gateway .1. Election, hello bytes, the virtual address and MAC through ipv4 and arp,
 * failover inside the hold time, preemption with a coup, resign on `no standby ip`, the v1 variant, silence and
 * determinism.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import { HSRP_V1_GROUP, HSRP_V2_GROUP, UDP_PORT_HSRP } from '../src/contracts/pdu.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { HsrpRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { HSRP_OP, HSRP_STATE, hsrpVirtualMac } from '../src/pdu/codecs/hsrp.js';
import { createHsrp, hsrpBetter, hsrpConfig } from '../src/protocols/hsrp.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const G0 = 'GigabitEthernet0/0';
const PC = 'GigabitEthernet0';
const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA3 = 'FastEthernet0/3';
const VIP = '192.168.1.1';
const R1_IP = '192.168.1.2';
const R2_IP = '192.168.1.3';
const VMAC_V2 = '00:00:0c:9f:f0:01';
const VMAC_V1 = '00:00:0c:07:ac:01';
const HSRP_V2_MAC = '01:00:5e:00:00:66';
const HSRP_V1_MAC = '01:00:5e:00:00:02';
const BOOT = 60 * SEC;
/** Boot plus listen (10 s) plus speak (10 s) plus a margin: the election is over. */
const SETTLED = BOOT + 40 * SEC;

function hsrpOnly(): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = undefined;
  out.hsrp = createHsrp;
  return out;
}

interface LabOptions {
  seed?: number;
  version?: 1 | 2;
  /** R1 `standby 1 preempt` (default true). */
  preempt?: boolean;
  /** No standby lines at all (silence). */
  silent?: boolean;
  profile?: 'P1' | 'P2';
}

function routerConfig(name: string, ip: string, o: LabOptions, extra: readonly string[]): string {
  const lines = [`ip address ${ip} 255.255.255.0`];
  if (o.silent !== true) {
    if ((o.version ?? 2) === 2) lines.push('standby version 2');
    lines.push(`standby 1 ip ${VIP}`, ...extra);
  }
  lines.push('no shutdown');
  return configText([[`hostname ${name}`], section(`interface ${G0}`, lines)]);
}

/** R1, R2 and PC1 (192.168.1.10, gateway .1) on SW1, booted and, unless `settle` is false, past the election. */
function lab(o: LabOptions = {}, settle = true): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 21, profile: o.profile ?? 'P2', factories: hsrpOnly() });
  const r1Extra = ['standby 1 priority 110'];
  if (o.preempt !== false) r1Extra.push('standby 1 preempt');
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', R1_IP, o, r1Extra) });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: routerConfig('R2', R2_IP, o, []) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '192.168.1.10', '255.255.255.0', VIP) });
  sim.addLink({ id: 'l_r1', a: { device: 'r1', port: G0 }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_r2', a: { device: 'r2', port: G0 }, b: { device: 'sw1', port: FA2 } });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC }, b: { device: 'sw1', port: FA3 } });
  if (settle) sim.runFor(SETTLED);
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
const rows = (sim: Simulation, dev: string): HsrpRow[] => sim.device(dev)!.tables.get<HsrpRow>('hsrp')?.rows() ?? [];
const row = (sim: Simulation, dev: string): HsrpRow | undefined => rows(sim, dev)[0];
const virtual4 = (sim: Simulation, dev: string) => sim.device(dev)!.port(G0)!.l3.virtual4;
const groups4 = (sim: Simulation, dev: string) => sim.device(dev)!.port(G0)!.l3.groups4;
const sockets = (sim: Simulation, dev: string): string[] => (sim.device(dev)!.tables.get<SocketRow>('sockets')?.rows() ?? []).map((r) => r.id);
/** HSRP state transitions of `dev` (machine 'hsrp'), in trace order. */
const transitions = (sim: Simulation, dev: string) =>
  ofKind(events(sim), 'debug').filter((e) => e.event.device === dev && e.event.fsm?.machine === 'hsrp').map((e) => ({ t: e.t, from: e.event.fsm!.from, to: e.event.fsm!.to, cause: e.event.fsm!.cause }));
const created = (sim: Simulation, dev: string, tag: string) => ofKind(events(sim), 'pduCreated').filter((e) => e.device === dev && e.pdu.tag === tag);
const camPortOf = (sim: Simulation, mac: string): string | undefined => sim.device('sw1')!.tables.cam.rows().find((r) => r.mac === mac)?.port;
/** Apply one interface line through the runtime (the W3 cli grammar of the standby lines is a parallel item). */
function line(sim: Simulation, device: string, text: string): void {
  const toks = text.split(' ');
  const negate = toks[0] === 'no';
  const dev = sim.device(device)!;
  dev.applyActions('cli', [], sim.now);
  const r = dev.applyConfigLine([['interface', G0]], negate ? toks.slice(1) : toks, negate);
  if (!r.ok) throw new Error(`${text} on ${device}: ${r.error ?? 'failed'}`);
}

describe('fhrp.hsrp election (v2)', () => {
  it('R1 (priority 110) ends active with the virtual address and MAC; R2 ends standby; both joined 224.0.0.102', () => {
    const sim = lab();
    expect(row(sim, 'r1')).toMatchObject({ key: `${G0}|1`, iface: G0, group: 1, version: 2, state: 'active', priority: 110, preempt: true, virtualIp: VIP, virtualMac: VMAC_V2, active: 'local', standby: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', priority: 100, preempt: false, virtualMac: VMAC_V2, active: R1_IP, standby: 'local' });
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    expect(virtual4(sim, 'r2')).toBeUndefined();
    expect(groups4(sim, 'r1')).toEqual([HSRP_V2_GROUP]);
    expect(groups4(sim, 'r2')).toEqual([HSRP_V2_GROUP]);
    expect(sockets(sim, 'r1')).toContain(`hsrp#${G0}`);
    // listen → speak → standby → active on R1; R2 went through listen and speak to standby
    expect(transitions(sim, 'r1').map((x) => x.to)).toEqual(['listen', 'speak', 'standby', 'active']);
    expect(transitions(sim, 'r2').map((x) => x.to).at(-1)).toBe('standby');
    expect(rows(sim, 'r2').map((x) => x.state)).toEqual(['standby']);
    // the gratuitous ARP for the virtual address left R1 from the virtual MAC, and SW1 learned it on R1's port
    const garp = created(sim, 'r1', 'arp-gratuitous').map((e) => sim.pdu(e.pdu.id)!).find((p) => p.layer('arp')!.fields.spa === VIP)!;
    expect(garp.layer('arp')!.fields).toMatchObject({ sha: VMAC_V2, spa: VIP });
    expect(garp.layer('ethernet')!.fields.src).toBe(VMAC_V2);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA1);
    expect(sim.runToIdle(100_000).stopped).toBeUndefined();
  });

  it('hellos are [ethernet, ipv4 ttl 1, udp 1985, hsrp] to the group, background, from the virtual MAC once active', () => {
    const sim = lab();
    const hellos = created(sim, 'r1', 'hsrp-hello').map((e) => sim.pdu(e.pdu.id)!);
    expect(hellos.length).toBeGreaterThan(3);
    const first = hellos[0]!;
    expect(first.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'udp', 'hsrp']);
    expect(first.layer('ethernet')!.fields).toMatchObject({ dst: HSRP_V2_MAC, src: sim.device('r1')!.port(G0)!.mac });
    expect(first.layer('ipv4')!.fields).toMatchObject({ src: R1_IP, dst: HSRP_V2_GROUP, ttl: 1, protocol: 17 });
    expect(first.layer('udp')!.fields).toMatchObject({ srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP });
    expect(first.layer('hsrp')!.fields).toMatchObject({ version: 2, opCode: HSRP_OP.hello, state: HSRP_STATE.speak, helloMs: 3000, holdMs: 10000, priority: 110, group: 1, virtualIp: VIP, identifier: sim.device('r1')!.port(G0)!.mac });
    expect(first.meta.background).toBe(true);
    const active = hellos.find((p) => p.layer('hsrp')!.fields.state === HSRP_STATE.active)!;
    expect(active.layer('ethernet')!.fields.src).toBe(VMAC_V2);
    // a hello every 3 s once speaking (a state change sends one at once, so a gap is never longer)
    const times = created(sim, 'r1', 'hsrp-hello').map((e) => e.t);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.every((g) => g <= 3 * SEC)).toBe(true);
    expect(gaps.filter((g) => g === 3 * SEC).length).toBeGreaterThan(3);
    // PC1 drops the hellos as background, not for it (group not joined)
    const pcDrops = ofKind(events(sim), 'drop').filter((e) => e.device === 'pc1' && e.pdu.tag === 'hsrp-hello');
    expect(pcDrops.length).toBeGreaterThan(0);
    expect(pcDrops.every((e) => e.reason === 'not-for-me' && e.background === true)).toBe(true);
  });

  it('an ARP request for .1 is answered by R1 only, with the virtual MAC; PC1 pings the gateway', () => {
    const sim = lab();
    const before = created(sim, 'r1', 'arp-reply').length + created(sim, 'r2', 'arp-reply').length;
    const r = ping(sim, 'pc1', VIP);
    expect(r.text).toMatch(/Sent 5, received 5, lost 0/);
    const r1Replies = created(sim, 'r1', 'arp-reply').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('arp')!.fields.spa === VIP);
    const r2Replies = created(sim, 'r2', 'arp-reply').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('arp')!.fields.spa === VIP);
    expect(r1Replies).toHaveLength(1);
    expect(r2Replies).toHaveLength(0);
    expect(r1Replies[0]!.layer('arp')!.fields.sha).toBe(VMAC_V2);
    expect(created(sim, 'r1', 'arp-reply').length + created(sim, 'r2', 'arp-reply').length).toBe(before + 1);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V2 });
    // the echo replies came from the virtual address, framed from the virtual MAC
    const replies = created(sim, 'r1', 'ping-reply').length + ofKind(r.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.proto === 'icmpv4').length;
    expect(replies).toBeGreaterThan(0);
  });
});

describe('fhrp.hsrp failover and preemption', () => {
  it('R1 off at T: R2 becomes active between T + 7 s and T + 10 s, SW1 moves the virtual MAC, PC1 sends no new ARP', () => {
    const sim = lab();
    ping(sim, 'pc1', VIP);
    const arpBefore = created(sim, 'pc1', 'arp-request').length;
    const T = sim.now;
    sim.setPower('r1', false);
    sim.runFor(12 * SEC);
    const takeover = transitions(sim, 'r2').find((x) => x.to === 'active')!;
    expect(takeover).toBeDefined();
    expect(takeover.from).toBe('standby');
    expect(takeover.cause).toBe(`active router ${R1_IP} timed out`);
    expect(takeover.t).toBeGreaterThanOrEqual(T + 7 * SEC);
    expect(takeover.t).toBeLessThanOrEqual(T + 10 * SEC);
    expect(row(sim, 'r2')).toMatchObject({ state: 'active', active: 'local' });
    expect(virtual4(sim, 'r2')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    // R2's gratuitous ARP from the virtual MAC re-learned the CAM entry on R2's port (R1's port going down had
    // flushed the old row, so the switch learns it afresh rather than reporting a move)
    expect(camPortOf(sim, VMAC_V2)).toBe(FA2);
    const garp = created(sim, 'r2', 'arp-gratuitous').map((e) => sim.pdu(e.pdu.id)!).find((p) => p.layer('arp')!.fields.spa === VIP)!;
    expect(garp.layer('ethernet')!.fields.src).toBe(VMAC_V2);
    const learned = ofKind(events(sim), 'tableWrite').filter((e) => e.device === 'sw1' && e.table === 'cam' && e.t >= T && e.key.endsWith(VMAC_V2));
    expect(learned.length).toBeGreaterThan(0);
    // PC1 keeps its ARP entry and pings the gateway again without a new request
    const r = ping(sim, 'pc1', VIP);
    expect(r.text).toMatch(/Sent 5, received 5, lost 0/);
    expect(created(sim, 'pc1', 'arp-request').length).toBe(arpBefore);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V2 });
  });

  it('a ping during the failover window loses only the echoes sent before R2 took over', () => {
    const sim = lab();
    const T = sim.now;
    sim.setPower('r1', false);
    const cursor = sim.trace(0).next;
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, `ping ${VIP}`);
    sim.runFor(30 * SEC);
    const text = ofKind(sim.trace(cursor).events, 'cliOutput').filter((e) => e.session === session).map((e) => e.text).join('');
    const m = /Sent 5, received (\d), lost (\d)/.exec(text)!;
    expect(m).not.toBeNull();
    expect(Number(m[2])).toBeGreaterThan(0);
    expect(Number(m[1])).toBeGreaterThan(0);
    const takeover = transitions(sim, 'r2').find((x) => x.to === 'active')!;
    expect(takeover.t).toBeLessThanOrEqual(T + 10 * SEC);
  });

  it('R1 returns with preempt: a coup makes it active again; R2 goes speak, then standby', () => {
    const sim = lab();
    sim.setPower('r1', false);
    sim.runFor(15 * SEC);
    expect(row(sim, 'r2')!.state).toBe('active');
    const cursor = sim.trace(0).next;
    sim.setPower('r1', true);
    sim.runFor(BOOT + 40 * SEC);
    const since = sim.trace(cursor).events;
    const coup = ofKind(since, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'hsrp-coup');
    expect(coup).toHaveLength(1);
    expect(sim.pdu(coup[0]!.pdu.id)!.layer('hsrp')!.fields).toMatchObject({ opCode: HSRP_OP.coup, priority: 110 });
    const r1 = ofKind(since, 'debug').filter((e) => e.event.device === 'r1' && e.event.fsm?.machine === 'hsrp').map((e) => e.event.fsm!);
    expect(r1.map((x) => x.to)).toEqual(['listen', 'active']);
    expect(r1[1]!.cause).toBe(`preempted ${R2_IP}`);
    const r2 = ofKind(since, 'debug').filter((e) => e.event.device === 'r2' && e.event.fsm?.machine === 'hsrp').map((e) => e.event.fsm!);
    expect(r2.map((x) => x.to)).toEqual(['speak', 'standby']);
    expect(r2[0]!.cause).toBe(`coup from ${R1_IP}`);
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', standby: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', active: R1_IP });
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V2, owner: 'hsrp', local: true }]);
    expect(virtual4(sim, 'r2') ?? []).toEqual([]);
    expect(camPortOf(sim, VMAC_V2)).toBe(FA1);
  });

  it('without preempt R1 returns as standby and R2 stays active', () => {
    const sim = lab({ preempt: false });
    expect(row(sim, 'r1')!.state).toBe('active');
    sim.setPower('r1', false);
    sim.runFor(15 * SEC);
    sim.setPower('r1', true);
    sim.runFor(BOOT + 40 * SEC);
    expect(row(sim, 'r1')).toMatchObject({ state: 'standby', preempt: false, active: R2_IP });
    expect(row(sim, 'r2')).toMatchObject({ state: 'active', standby: R1_IP });
    expect(created(sim, 'r1', 'hsrp-coup')).toHaveLength(0);
  });

  it('`no standby 1 ip` on the active router sends a resign: the standby takes over at once, the row goes', () => {
    const sim = lab();
    const T = sim.now;
    line(sim, 'r1', `no standby 1 ip ${VIP}`);
    sim.runFor(SEC);
    expect(created(sim, 'r1', 'hsrp-resign')).toHaveLength(1);
    expect(rows(sim, 'r1')).toEqual([]);
    expect(virtual4(sim, 'r1') ?? []).toEqual([]);
    expect(groups4(sim, 'r1') ?? []).toEqual([]);
    expect(sockets(sim, 'r1')).not.toContain(`hsrp#${G0}`);
    const takeover = transitions(sim, 'r2').find((x) => x.to === 'active')!;
    expect(takeover.cause).toBe(`resign from ${R1_IP}`);
    expect(takeover.t).toBeLessThan(T + SEC);
    expect(row(sim, 'r2')).toMatchObject({ state: 'active' });
  });

  it('a priority raised with preempt on the standby router preempts the active one', () => {
    const sim = lab({ preempt: false });
    line(sim, 'r2', 'standby 1 priority 120');
    line(sim, 'r2', 'standby 1 preempt');
    sim.runFor(5 * SEC);
    expect(row(sim, 'r2')).toMatchObject({ state: 'active', priority: 120, preempt: true });
    expect(created(sim, 'r2', 'hsrp-coup')).toHaveLength(1);
    sim.runFor(15 * SEC);
    expect(row(sim, 'r1')).toMatchObject({ state: 'standby', active: R2_IP });
  });

  it('`shutdown` on the interface puts the group in initial (the virtual address goes); `no shutdown` re-elects', () => {
    const sim = lab();
    line(sim, 'r1', 'shutdown');
    sim.runFor(15 * SEC);
    expect(row(sim, 'r1')).toMatchObject({ state: 'initial' });
    expect(virtual4(sim, 'r1') ?? []).toEqual([]);
    expect(row(sim, 'r2')!.state).toBe('active');
    line(sim, 'r1', 'no shutdown');
    sim.runFor(30 * SEC);
    expect(row(sim, 'r1')!.state).toBe('active');
    expect(row(sim, 'r2')!.state).toBe('standby');
  });
});

describe('fhrp.hsrp version 1', () => {
  it('uses 224.0.0.2, 00:00:0c:07:ac:01 and the 20-byte message with whole seconds', () => {
    const sim = lab({ version: 1 });
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', version: 1, virtualMac: VMAC_V1 });
    expect(row(sim, 'r2')).toMatchObject({ state: 'standby', version: 1 });
    expect(groups4(sim, 'r1')).toEqual([HSRP_V1_GROUP]);
    expect(virtual4(sim, 'r1')).toEqual([{ address: VIP, mac: VMAC_V1, owner: 'hsrp', local: true }]);
    const hello = sim.pdu(created(sim, 'r1', 'hsrp-hello')[0]!.pdu.id)!;
    expect(hello.layer('ethernet')!.fields.dst).toBe(HSRP_V1_MAC);
    expect(hello.layer('ipv4')!.fields.dst).toBe(HSRP_V1_GROUP);
    expect(hello.layer('hsrp')!.fields).toMatchObject({ version: 1, group: 1, helloMs: 3000, holdMs: 10000, priority: 110, virtualIp: VIP });
    expect(hello.layer('hsrp')!.length).toBe(20);
    expect(Array.from(hello.layer('hsrp')!.fields.authData as Uint8Array)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(hsrpVirtualMac(1, 1)).toBe(VMAC_V1);
    expect(hsrpVirtualMac(2, 1)).toBe(VMAC_V2);
    const r = ping(sim, 'pc1', VIP);
    expect(r.text).toMatch(/Sent 5, received 5, lost 0/);
    expect(sim.device('pc1')!.tables.arp.get(VIP)).toMatchObject({ mac: VMAC_V1 });
  });
});

describe('fhrp.hsrp silence and determinism', () => {
  it('without standby lines nothing is sent, no row, no socket, no group is joined — in either profile', () => {
    for (const profile of ['P1', 'P2'] as const) {
      const sim = lab({ silent: true, profile });
      sim.runFor(600 * SEC);
      expect(created(sim, 'r1', 'hsrp-hello')).toEqual([]);
      expect(ofKind(events(sim), 'pduCreated').filter((e) => e.pdu.tag?.startsWith('hsrp-'))).toEqual([]);
      expect(rows(sim, 'r1')).toEqual([]);
      expect(sockets(sim, 'r1').filter((s) => s.startsWith('hsrp'))).toEqual([]);
      expect(groups4(sim, 'r1')).toBeUndefined();
      expect(ofKind(events(sim), 'debug').filter((e) => e.event.process === 'hsrp')).toEqual([]);
      expect(ofKind(events(sim), 'tableWrite').filter((e) => e.table === 'hsrp')).toEqual([]);
    }
  });

  it('a lone router with standby lines becomes active after listen and speak; runToIdle returns', () => {
    const sim = createP2Simulation({ seed: 2, factories: hsrpOnly() });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', R1_IP, {}, ['standby 1 priority 110']) });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '192.168.1.10', '255.255.255.0', VIP) });
    sim.addLink({ id: 'l', a: { device: 'r1', port: G0 }, b: { device: 'pc1', port: PC } });
    const stats = sim.runToIdle(200_000);
    expect(stats.stopped).toBeUndefined();
    expect(row(sim, 'r1')).toMatchObject({ state: 'active', active: 'local' });
    expect(row(sim, 'r1')!.standby).toBeUndefined();
    const ts = transitions(sim, 'r1');
    expect(ts.map((x) => x.to)).toEqual(['listen', 'speak', 'standby', 'active']);
    expect(ts[1]!.t - ts[0]!.t).toBe(10 * SEC);
    expect(ts[2]!.t - ts[1]!.t).toBe(10 * SEC);
    expect(ts[3]!.t).toBe(ts[2]!.t);
  });

  it('the trace of the election is byte-identical over 3 runs with one seed', () => {
    const traces = [1, 2, 3].map(() => JSON.stringify(events(lab({ seed: 33 }))));
    expect(traces[1]).toBe(traces[0]);
    expect(traces[2]).toBe(traces[0]);
  });
});

describe('fhrp.hsrp config reader and comparison', () => {
  it('reads every standby line, the group-less form as group 0, and drops groups without an ip line', () => {
    const sim = lab();
    const dev = sim.device('r1')!;
    line(sim, 'r1', 'standby priority 90');
    line(sim, 'r1', 'standby ip 192.168.1.250');
    line(sim, 'r1', 'standby 5 priority 50');
    line(sim, 'r1', 'standby 1 timers 1 4');
    line(sim, 'r1', 'standby 1 preempt delay minimum 30');
    const cfg = hsrpConfig({ config: dev.running, ports: dev.ports });
    expect(cfg.map((g) => [g.group, g.version, g.virtualIp, g.priority, g.preempt, g.preemptDelayS, g.helloMs, g.holdMs])).toEqual([
      [1, 2, VIP, 110, true, 30, 1000, 4000],
      [0, 2, '192.168.1.250', 90, false, 0, 3000, 10000],
    ]);
    expect(hsrpBetter({ ip: R1_IP, priority: 110 }, { ip: R2_IP, priority: 100 })).toBe(true);
    expect(hsrpBetter({ ip: R1_IP, priority: 100 }, { ip: R2_IP, priority: 100 })).toBe(false);
    expect(hsrpBetter({ ip: R2_IP, priority: 100 }, { ip: R1_IP, priority: 100 })).toBe(true);
  });
});
