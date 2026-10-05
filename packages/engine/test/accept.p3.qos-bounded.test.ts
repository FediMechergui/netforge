/**
 * P3 acceptance [S20] — the line-rate event bound of a scheduler port (ARCHITECTURE-P3 D16, §3.11, §4.2, §12.2 R3:
 * "[S20] runs at WAN rates (64 kb/s–2 Mb/s) with generator caps and `accept.p3.qos-bounded`"; §10.1 row
 * `accept.p3.qos-bounded`), on `staged.world` at stage P3 (the catalog flip is a later step). Owner: W4 qa-media.
 *
 * World: PC1 — R1 Gi0/0; R1 Se0/0/0 (DCE, `clock rate` R, `bandwidth` R, a queueing `service-policy output`) ⇄ R2
 * Se0/0/0; R2 Gi0/0 — PC2. PC1 runs the generator at its caps: `TRAFFIC_MAX_FLOWS` continuous flows, one voice
 * preset (50 pps × 60 B, DSCP 46) and the others each at `TRAFFIC_MAX_PPS` packets of TRAFFIC_MAX_BPS / (8 ×
 * TRAFFIC_MAX_PPS) bytes (both per-flow caps at once) — far more than either line carries.
 *   • (a) R = 2 Mb/s, LLQ: VOICE `priority 32`, class-default `fair-queue` [S21];
 *   • (b) R = 64 kb/s, CBWFQ with a shaper: VOICE `bandwidth 16`, class-default `shape average 32000` [S21].
 *
 * The bound (the P2 storm test's line-rate bound, `accept.p2.loop-storm-bounded`, carried to a scheduler port): the
 * scheduler events dispatched in a window W of saturation are at most
 *     ( D × (1 + P2P_EVENTS_PER_FRAME)                 the generator: one pacing timer and one PC1 → R1 frame per datagram
 *     + S × 2 × P2P_EVENTS_PER_FRAME                   at most S frames leave R1 Se0/0/0 (line rate), each then R2 → PC2
 *     + S × G                                          (b) at most one shaper gate (`qos:` mediumTimer) per frame left
 *     + B ) × 1.1                                      B: the same world's idle events over 10 s (keepalives …)
 * with D = Σ flows (⌊W / pace⌋ + 1) (the generator caps) and S = ⌊W / slot⌋ + 2, slot the wire time of the smallest
 * datagram frame at R (the line rate). Nothing in it grows with the held queue: a held frame costs no event until it
 * leaves (no polling, no per-frame timer), so the queue's work is bounded by the line, and its memory by its limits.
 * Also pinned: the frames R1 sends in W are at most S (and, unshaped, fill the line); the held depth of every class
 * stays within its limit and the virtual FIFO behind the scheduler holds at most the frame on the wire and a control
 * frame; once the flows stop, `runToIdle` drains the held queue and returns.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import { HDLC_FCS, HDLC_HEADER, HDLC_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, serializationNs, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createTraffic, TRAFFIC_MAX_BPS, TRAFFIC_MAX_FLOWS, TRAFFIC_MAX_PPS, TRAFFIC_VOICE_PRESETS } from '../src/protocols/traffic.js';
import { P2P_EVENTS_PER_FRAME } from './p2p.constants.js';
import { createStagedSimulation } from './staged.world.js';

const SE0 = 'Serial0/0/0';
const PC2 = '192.168.2.10';
/** The window of saturation the bound is checked over. */
const W: SimTime = 3 * SEC;
/** The data flows' size: both per-flow caps reached at once. */
const DATA_BYTES = TRAFFIC_MAX_BPS / (8 * TRAFFIC_MAX_PPS);
const VOICE = TRAFFIC_VOICE_PRESETS['voice-g729'];

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface Variant {
  readonly name: string;
  /** The line rate, b/s (`clock rate` and `bandwidth`). */
  readonly rate: number;
  /** R1's global QoS lines. */
  readonly policy: readonly string[];
  /** One shaper gate per frame left may be dispatched. */
  readonly shaped: boolean;
}

const VARIANTS: readonly Variant[] = [
  {
    name: '(a) 2 Mb/s, LLQ with fair-queue',
    rate: 2_000_000,
    policy: ['class-map match-all VOICE', ' match dscp ef', 'policy-map WAN-EDGE', ' class VOICE', '  priority 32', ' class class-default', '  fair-queue'],
    shaped: false,
  },
  {
    name: '(b) 64 kb/s, CBWFQ with a shaped class-default',
    rate: 64_000,
    policy: ['class-map match-all VOICE', ' match dscp ef', 'policy-map WAN-EDGE', ' class VOICE', '  bandwidth 16', ' class class-default', '  shape average 32000'],
    shaped: true,
  },
];

/** PC1 — R1 ⇄ R2 — PC2 with the variant's policy on R1 Se0/0/0; booted, the caches warm, settled. */
function world(v: Variant, seed: number): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { traffic: createTraffic } });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.1.10 255.255.255.0'], ['ip default-gateway 192.168.1.1']]) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2'], ['interface GigabitEthernet0', ` ip address ${PC2} 255.255.255.0`], ['ip default-gateway 192.168.2.1']]) });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      v.policy,
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.1 255.255.255.252', ` clock rate ${v.rate}`, ` bandwidth ${v.rate / 1000}`, ' service-policy output WAN-EDGE', ' no shutdown'],
      ['ip route 192.168.2.0 255.255.255.0 10.1.1.2'],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.2 255.255.255.252', ' no shutdown'],
      ['ip route 192.168.1.0 255.255.255.0 10.1.1.1'],
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  expect(sim.link(sim.device('r1')!.port(SE0)!.link!)!.negotiatedBps).toBe(v.rate);
  expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'WAN-EDGE', refBps: v.rate });
  expect(shell(sim, 'pc1', `flow start ${PC2} pps 10 size 60 count 1`)).toMatch(/^Flow f1 started: /);
  sim.runFor(2 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

/** One line in a fresh console session: the command's output and its job's line. */
function shell(sim: Simulation, device: DeviceId, line: string): string {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  if (r.error !== undefined) throw new Error(`${device}: ${line}: ${r.error.message}`);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  return (r.output + job.map((e) => e.text).join('')).trim();
}

/** The scheduler view of R1 Se0/0/0 from the snapshot (R32: `PortSnapshot.qos.queue`). */
function queueView(sim: Simulation) {
  const port = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === SE0)!;
  return port.qos!.queue!;
}

describe('[S20] the line-rate event bound of a scheduler port, under the generator at its caps', () => {
  for (const [i, v] of VARIANTS.entries()) {
    it(v.name, () => {
      const sim = world(v, 401 + i);
      // B: the idle world's events over 10 s (the longest periodic interval here: the HDLC keepalive)
      const idle = sim.runFor(10 * SEC).events;

      // the generator at its caps: one voice preset, the other flows each at both per-flow caps
      expect(shell(sim, 'pc1', `flow voice ${PC2}`)).toMatch(/^Flow f\d+ started: /);
      for (let f = 1; f < TRAFFIC_MAX_FLOWS; f++) expect(shell(sim, 'pc1', `flow start ${PC2} pps ${TRAFFIC_MAX_PPS} size ${DATA_BYTES}`)).toMatch(/^Flow f\d+ started: /);
      sim.runFor(1 * SEC); // the held queues fill within milliseconds

      const evs: TraceEvent[] = [];
      const off = sim.onTrace((e) => evs.push(e));
      const window = sim.runFor(W);
      off();

      // the bound, from the generator caps, the line rate and the idle background
      const paces = [Math.floor(SEC / VOICE.pps), ...Array.from({ length: TRAFFIC_MAX_FLOWS - 1 }, () => Math.floor(SEC / TRAFFIC_MAX_PPS))];
      const D = paces.reduce((n, pace) => n + Math.floor(W / pace) + 1, 0);
      const slot = serializationNs(Math.min(VOICE.sizeBytes, DATA_BYTES) + HDLC_HEADER + HDLC_FCS + HDLC_PHY_OVERHEAD, v.rate);
      const S = Math.floor(W / slot) + 2;
      const bound = (D * (1 + P2P_EVENTS_PER_FRAME) + S * 2 * P2P_EVENTS_PER_FRAME + (v.shaped ? S : 0) + idle) * 1.1;
      expect(window.events).toBeGreaterThan(D); // the load is real
      expect(window.events).toBeLessThanOrEqual(bound);

      // at most S frames leave R1 Se0/0/0 in W; unshaped, they fill the line
      const sentOnLine = evs.filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.from.device === 'r1' && e.from.port === SE0);
      expect(sentOnLine.length).toBeLessThanOrEqual(S);
      if (!v.shaped) {
        const bits = sentOnLine.reduce((n, e) => n + (e.pdu.size + HDLC_PHY_OVERHEAD) * 8, 0);
        expect(bits).toBeGreaterThanOrEqual(0.95 * (v.rate * W) / SEC);
      }
      // the scheduler really queued and dropped (the generator outran the line)
      expect(evs.some((e) => e.kind === 'frameQueued' && e.device === 'r1' && e.port === SE0)).toBe(true);
      expect(evs.some((e) => e.kind === 'drop' && e.device === 'r1' && e.port === SE0 && (e.reason === 'queue-full' || e.reason === 'policed'))).toBe(true);
      if (v.shaped) expect(sentOnLine.length).toBeGreaterThan(0);

      // memory: every class within its limit — on a shaped port the frame staged for its shaper gate is counted by its
      // class's depth AND by the tail-drop admission (link/qos/scheduler.ts, W4a fix), so the depth never exceeds the
      // limit (no "65/64") — and the virtual FIFO behind the scheduler at most the frame on the wire and a control frame
      const q = queueView(sim);
      expect(q.classes.length).toBe(2);
      for (const c of q.classes) expect(c.depth, c.name).toBeLessThanOrEqual(c.limit);
      expect(q.classes.reduce((n, c) => n + c.depth, 0)).toBeGreaterThan(0);
      expect(q.classes.reduce((n, c) => n + c.depth, 0)).toBeLessThanOrEqual(q.classes.reduce((n, c) => n + c.limit, 0));
      expect(sim.device('r1')!.port(SE0)!.tx.queue).toBeLessThanOrEqual(2);
      for (const e of evs) if (e.kind === 'frameQueued') expect(e.depth).toBeLessThanOrEqual(q.classes.find((c) => c.name === e.queue)!.limit);
      if (v.shaped) {
        // the shaped class reached its limit (the case the staged frame used to push past it)
        expect(evs.some((e) => e.kind === 'frameQueued' && e.device === 'r1' && e.depth === q.classes.find((c) => c.name === e.queue)!.limit)).toBe(true);
      }

      // the flows stop: the held queue drains and runToIdle returns
      for (const f of (sim.device('pc1')!.processes.get('traffic')!.stateSnapshot().state as { flows: { id: string; state: string }[] }).flows) {
        if (f.state === 'running') expect(shell(sim, 'pc1', `flow stop ${f.id}`)).toMatch(/stopped after/);
      }
      const drained = sim.runToIdle();
      expect(drained.stopped).toBeUndefined();
      expect(queueView(sim).classes.map((c) => c.depth)).toEqual([0, 0]);
    }, 120_000);
  }
});
