/**
 * qos.serial-integration — the W3 fix step's seams on real worlds (`staged.world` at stage P3; ARCHITECTURE-P3 §3.5,
 * §3.11, D16; §9.2 rulings R32, R33, R34, R35).
 *
 * World: the test injector INJ → R1 Gi0/0; R1 Se0/0/0 (DCE, `clock rate 128000`) ↔ R2 Se0/0/0 on a serial cable, HDLC.
 * INJ offers ≈ 205 kb/s toward R2 (alternating 1000-byte data and 32-byte voice datagrams, DSCP 46 on voice, one frame
 * every 20 ms), more than the line carries, so R1's serial port is congested.
 *
 * Pinned:
 *   • R32: with `service-policy output WAN-EDGE` (LLQ) the held queue engages in a real world: `frameQueued` events on
 *     R1 Se0/0/0 (and the trace filter finds them by port and by packet), the queue lines of `show policy-map interface`
 *     and `show interfaces`, and `PortSnapshot.qos.queue`;
 *   • R33: control traffic is never queued, classified or counted: with the policy on an idle line the HDLC keepalives
 *     match no class; under LLQ congestion no keepalive is queued or dropped and the line protocol never moves;
 *   • R33 extended to the virtual FIFO (verified finding 1): with no policy (the §3.5 FIFO, lab 27) 300 s of congestion
 *     tail-drop data `queue-full` but never a keepalive, and Se0/0/0 keeps its line protocol on both ends; the same
 *     with [S19] PPP and CHAP: no LCP echo is lost, so no keepalive-missed renegotiation;
 *   • R34: on a 64 kb/s line with no `bandwidth` line the CLI admission, the compiled scheduler and the `qos.admitted`
 *     fact read one reference rate (the routing bandwidth, 1544 kb/s);
 *   • R35: `copyQosView` carries a class's policer counts.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliResult } from '../src/contracts/cli.js';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import { fmtBps } from '../src/cli/format.js';
import { fillTemplate } from '../src/cli/handlers/common.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { copyQosView } from '../src/sim/snapshot-cache.js';
import { matchesTraceFilter } from '../src/trace/filter.js';
import type { PppRow } from '../src/contracts/tables.js';
import { createPpp } from '../src/protocols/ppp.js';
import { INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0';
const SE0 = 'Serial0/0/0';
const R1_LAN = 'GigabitEthernet0/0';

/** §3.11's policy: VOICE (dscp ef) priority 32 kb/s, class-default fair-queue. */
const WAN_EDGE = ['class-map match-all VOICE', ' match dscp ef', 'policy-map WAN-EDGE', ' class VOICE', '  priority 32', ' class class-default', '  fair-queue'];

interface WorldOptions {
  readonly seed?: number;
  /** Extra lines of R1's Se0/0/0 section. */
  readonly r1Serial?: readonly string[];
  /** Extra global lines of R1 (before its interfaces). */
  readonly r1Global?: readonly string[];
  /** R1's clock rate (default 128000). */
  readonly clockRate?: number;
  /** [S19] PPP with CHAP on both serial ends (the ppp daemon registered; W3 fix step, verified finding 1). */
  readonly ppp?: boolean;
}

/** [S19] Each end's CHAP lines (the username of its peer, and the interface lines). */
const PPP_SERIAL = ['encapsulation ppp', 'ppp authentication chap'];
const pppGlobal = (peer: string): string[] => [`username ${peer} password nf-chap`, '!'];

function routerConfig(name: string, global: readonly string[], interfaces: readonly (readonly [string, readonly string[]])[]): string {
  const lines = [`hostname ${name}`, '!', ...global];
  for (const [iface, body] of interfaces) lines.push(`interface ${iface}`, ...body.map((l) => ` ${l}`), ' no shutdown', '!');
  lines.push('end', '');
  return lines.join('\n');
}

/** INJ → R1 ⇄ R2, booted and settled. */
function world(o: WorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 31, stage: 'P3', factories: withInjector(o.ppp === true ? { ppp: createPpp } : {}) });
  const ppp = o.ppp === true ? PPP_SERIAL : [];
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig('R1', [...(o.ppp === true ? pppGlobal('R2') : []), ...(o.r1Global ?? [])], [
      [R1_LAN, ['ip address 10.0.0.1 255.255.255.0']],
      [SE0, ['ip address 10.1.1.1 255.255.255.252', `clock rate ${o.clockRate ?? 128000}`, ...ppp, ...(o.r1Serial ?? [])]],
    ]),
  });
  sim.addDevice({
    id: 'r2',
    type: 'router.nf2911',
    name: 'R2',
    startupConfig: routerConfig('R2', o.ppp === true ? pppGlobal('R1') : [], [[SE0, ['ip address 10.1.1.2 255.255.255.252', ...ppp]]]),
  });
  sim.addLink({ a: { device: 'inj', port: GI0 }, b: { device: 'r1', port: R1_LAN } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

/** A UDP datagram INJ → R2 (10.1.1.2) through R1 with `payload` bytes and `dscp`. */
function datagram(r1Mac: string, payload: number, dscp: number): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: r1Mac, src: '02:00:00:00:99:01', type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '10.0.0.9', dst: '10.1.1.2', protocol: IPPROTO_UDP, ttl: 64, dscp } },
    { proto: 'udp', fields: { srcPort: dscp === 46 ? 16384 : 40000, dstPort: 9 } },
    { proto: 'payload', fields: { data: new Uint8Array(payload) } },
  ];
}

/** Congest R1 Se0/0/0 for `seconds` (data and voice alternately, one frame every 20 ms). */
function congest(sim: Simulation, seconds: number): void {
  const r1Mac = sim.device('r1')!.port(R1_LAN)!.mac;
  injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(r1Mac, 972, 0), datagram(r1Mac, 32, 46)], count: seconds * 50, spacingNs: 20_000_000 });
}

const exec = (sim: Simulation, device: string, lines: readonly string[]): string[] => {
  const s = sim.cli.open(device, 'console');
  return lines.map((l) => sim.cli.exec(s, l).output);
};

/** Every trace event since `cursor` (read through a listener-free page of the ring). */
const since = (sim: Simulation, cursor: number): TraceEvent[] => sim.trace(cursor).events;

/** The portState events of a serial end since `cursor`. */
const serialStateChanges = (evs: readonly TraceEvent[]): TraceEvent[] =>
  evs.filter((e) => e.kind === 'portState' && (e.device === 'r1' || e.device === 'r2') && e.port === SE0);

/** Keepalive drops (an HDLC keepalive is a background frame tagged `keepalive`). */
const keepaliveDrops = (evs: readonly TraceEvent[]): TraceEvent[] => evs.filter((e) => e.kind === 'drop' && e.pdu.tag === 'keepalive');

describe('R32: the held queue engages in a real world', () => {
  it('a congested LLQ serial port queues (frameQueued), shows its queue lines and carries PortSnapshot.qos.queue', () => {
    const sim = world({ r1Global: WAN_EDGE, r1Serial: ['bandwidth 128', 'service-policy output WAN-EDGE'] });
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'WAN-EDGE', refBps: 128_000 });
    const cursor = sim.trace(0).next;
    congest(sim, 30);
    sim.runFor(20 * SEC);
    const evs = since(sim, cursor);
    const queued = evs.filter((e): e is Extract<TraceEvent, { kind: 'frameQueued' }> => e.kind === 'frameQueued');
    expect(queued.length).toBeGreaterThan(0);
    for (const q of queued) expect([q.device, q.port]).toEqual(['r1', SE0]);
    // the trace filter finds them by port and by packet (R32: frameQueued has its pdu and port)
    const q0 = queued[0]!;
    expect(matchesTraceFilter({ kinds: ['frameQueued'], ports: [{ device: 'r1', port: SE0 }] }, q0)).toBe(true);
    expect(matchesTraceFilter({ kinds: ['frameQueued'], protos: ['udp'] }, q0)).toBe(true);
    expect(matchesTraceFilter({ kinds: ['frameQueued'], devices: ['r2'] }, q0)).toBe(false);
    // the CLI prints the queue lines (CliRuntimeDeps.egressQueues)
    const [, pmap, iface] = exec(sim, 'r1', ['enable', `show policy-map interface ${SE0}`, `show interfaces ${SE0}`]);
    expect(pmap).toContain('Queueing: ');
    expect(pmap).toContain('policy WAN-EDGE');
    expect(pmap).toMatch(/packets waiting, \d+ sent, \d+ dropped \(queue full\), \d+ policed/);
    expect(iface).toContain('  Queueing: ');
    expect(iface).toMatch(/ {4}VOICE \(priority\): \d+\/\d+ packets waiting/);
    expect(iface).toMatch(/ {4}class-default \(default\): \d+\/\d+ packets waiting/);
    // the snapshot carries the queue view (and the class counters)
    const port = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === SE0)!;
    expect(port.qos?.output).toBe('WAN-EDGE');
    expect(port.qos?.queue).toMatchObject({ policy: 'WAN-EDGE', refBps: 128_000 });
    expect(port.qos?.queue?.classes.map((c) => c.name)).toEqual(['VOICE', 'class-default']);
    // no port of R2 (no policy) has one
    for (const p of sim.snapshot().devices.find((d) => d.id === 'r2')!.ports) expect(p.qos).toBeUndefined();
  });
});

describe('R33: control traffic is never queued, classified or counted', () => {
  it('on an idle line with the policy, the keepalives match no class', () => {
    const sim = world({ r1Global: WAN_EDGE, r1Serial: ['bandwidth 128', 'service-policy output WAN-EDGE'] });
    sim.runFor(120 * SEC);
    const counters = sim.device('r1')!.qosCounters(SE0)!;
    expect(counters.output).toBe('WAN-EDGE');
    for (const c of counters.classes) expect([c.name, c.matched, c.matchedBytes]).toEqual([c.name, 0, 0]);
    const [, pmap] = exec(sim, 'r1', ['enable', `show policy-map interface ${SE0}`]);
    expect(pmap).not.toMatch(/Class class-default: [1-9]/);
  });

  it('under LLQ congestion no keepalive is queued or dropped, and the line protocol never moves', () => {
    const sim = world({ r1Global: WAN_EDGE, r1Serial: ['bandwidth 128', 'service-policy output WAN-EDGE'] });
    const cursor = sim.trace(0).next;
    congest(sim, 120);
    sim.runFor(130 * SEC);
    const evs = since(sim, cursor);
    expect(evs.some((e) => e.kind === 'frameQueued')).toBe(true);
    expect(evs.some((e) => e.kind === 'drop' && e.reason === 'queue-full')).toBe(true);
    expect(evs.filter((e) => e.kind === 'frameQueued' && e.pdu.tag === 'keepalive')).toEqual([]);
    expect(keepaliveDrops(evs)).toEqual([]);
    expect(serialStateChanges(evs)).toEqual([]);
    for (const d of ['r1', 'r2']) expect(sim.device(d)!.port(SE0)!.operUp).toBe(true);
  });
});

describe('R33 on the virtual FIFO (verified finding 1): congestion alone never takes the §3.5 serial line down', () => {
  it('300 s of congestion with no policy: data is tail-dropped, keepalives never, and Se0/0/0 keeps its line protocol', () => {
    const sim = world();
    expect(sim.device('r1')!.egressPolicy(SE0)).toBeUndefined();
    const cursor = sim.trace(0).next;
    congest(sim, 300);
    sim.runFor(310 * SEC);
    const evs = since(sim, cursor);
    expect(evs.filter((e) => e.kind === 'drop' && e.reason === 'queue-full').length).toBeGreaterThan(100);
    expect(evs.some((e) => e.kind === 'frameQueued')).toBe(false);
    expect(keepaliveDrops(evs)).toEqual([]);
    expect(serialStateChanges(evs)).toEqual([]);
    expect(evs.some((e) => e.kind === 'drop' && e.reason === 'link-down')).toBe(false);
    for (const d of ['r1', 'r2']) expect(sim.device(d)!.port(SE0)!.operUp).toBe(true);
  });

  it('the same with PPP and CHAP: no LCP echo is lost to congestion, so no keepalive-missed renegotiation', () => {
    const sim = world({ ppp: true });
    const pppRow = (d: string): PppRow | undefined => sim.device(d)!.tables.get<PppRow>('ppp')?.get(SE0);
    for (const d of ['r1', 'r2']) expect(pppRow(d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened', failures: 0 });
    const cursor = sim.trace(0).next;
    congest(sim, 300);
    sim.runFor(310 * SEC);
    const evs = since(sim, cursor);
    // the data is congested (tail-dropped), the PPP control frames never are
    const tailDrops = evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.reason === 'queue-full');
    expect(tailDrops.length).toBeGreaterThan(100);
    // every tail drop is a data datagram (an LCP echo or any other PPP control frame is never refused)
    expect([...new Set(tailDrops.map((e) => e.pdu.proto))]).toEqual(['udp']);
    expect(serialStateChanges(evs)).toEqual([]);
    expect(evs.some((e) => e.kind === 'drop' && e.reason === 'link-down')).toBe(false);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened', failures: 0 });
      expect(pppRow(d)!.lastFailure).toBeUndefined();
      expect(sim.device(d)!.port(SE0)!.operUp).toBe(true);
    }
  });
});

/** Grade one `qos.admitted` assertion on R1 Se0/0/0. */
function admitted(sim: Simulation, equals: boolean): boolean {
  const assertion: LabAssertion = { kind: 'fact', device: 'R1', fact: 'qos.admitted', subject: SE0, equals };
  const lab: ScenarioInfo = {
    name: 'r34-admitted',
    title: 'R34',
    description: 'one fact',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 't', title: 't', description: 't', points: 1, assertions: [assertion] }],
  };
  return evaluateLab(sim, lab).results[0]!.assertions[0]!.pass;
}

describe('R34: one QoS reference rate on a 64 kb/s line with no bandwidth line', () => {
  const policy = (kbps: number): string[] => ['class-map match-all VOICE', ' match dscp ef', 'policy-map BIG', ' class VOICE', `  priority ${kbps}`];

  /** `service-policy output BIG` typed on R1 Se0/0/0 (the CLI's admission), then `show policy-map interface`. */
  function typed(sim: Simulation): { attach: CliResult; pmap: string } {
    const s = sim.cli.open('r1', 'console');
    for (const l of ['enable', 'configure terminal', `interface ${SE0}`]) sim.cli.exec(s, l);
    const attach = sim.cli.exec(s, 'service-policy output BIG');
    return { attach, pmap: sim.cli.exec(s, `do show policy-map interface ${SE0}`).output };
  }

  it('priority 50 kb/s: the CLI admits it, the runtime compiles it at 1544 kb/s, qos.admitted is true', () => {
    const sim = world({ clockRate: 64000, r1Global: policy(50) });
    expect(sim.device('r1')!.port(SE0)!.speedBps).toBe(64_000);
    const { attach, pmap } = typed(sim);
    expect(attach.error).toBeUndefined();
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'BIG', refBps: 1_544_000 });
    expect(pmap).toContain(`reference rate ${fmtBps(1_544_000)}`);
    expect(admitted(sim, true)).toBe(true);
  });

  it('priority 1200 kb/s: refused by the CLI against 1544 kb/s, not compiled from a startup-config, qos.admitted false', () => {
    const sim = world({ clockRate: 64000, r1Global: policy(1200) });
    const { attach } = typed(sim);
    expect(attach.error?.message).toBe(fillTemplate(CLI_MESSAGES.qosAdmission, { asked: 1200, bw: 1544, port: SE0 }));
    const loaded = world({ clockRate: 64000, r1Global: policy(1200), r1Serial: ['service-policy output BIG'] });
    expect(loaded.device('r1')!.egressPolicy(SE0)).toBeUndefined();
    expect(admitted(loaded, false)).toBe(true);
  });
});

describe('R35: copyQosView carries the policer counts', () => {
  it('copies `police` when present, after the M13 members, and nothing when absent', () => {
    const view = copyQosView({
      input: 'IN',
      classes: [
        { name: 'WEB', matched: 4, matchedBytes: 400, marked: 1, police: { conform: 1, conformBytes: 2, exceed: 3, exceedBytes: 4 } },
        { name: 'class-default', matched: 1, matchedBytes: 60, marked: 0 },
      ],
    });
    expect(view.classes).toEqual([
      { name: 'WEB', matched: 4, matchedBytes: 400, marked: 1, police: { conform: 1, conformBytes: 2, exceed: 3, exceedBytes: 4 } },
      { name: 'class-default', matched: 1, matchedBytes: 60, marked: 0 },
    ]);
    expect(Object.keys(view.classes[0]!)).toEqual(['name', 'matched', 'matchedBytes', 'marked', 'police']);
    expect(Object.keys(view.classes[1]!)).toEqual(['name', 'matched', 'matchedBytes', 'marked']);
  });
});
