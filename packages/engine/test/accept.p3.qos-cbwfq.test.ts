/**
 * accept.p3.qos-cbwfq — [S20] CBWFQ shares a congested serial link by the configured bandwidths, wired
 * (ARCHITECTURE-P3 §10.1 `accept.p3.qos-cbwfq`, D16 [S20], §3.11, ruling R34; §7 W4 qa).
 *
 * The §3.5 world (`accept.p3.qos.harness.ts`, `staged.world` at stage P3) without the input marking: PC-V sends
 * 200 kb/s of 1000-byte datagrams marked AF41 and PC-D the same marked AF21 (the host shell's `dscp` keyword), both to
 * PC-S, so 400 kb/s meet R1 Se0/0/0 (128 kb/s, `bandwidth 128`) with
 *   class-map match-all GOLD / match dscp af41;  class-map match-all SILVER / match dscp af21
 *   policy-map CBWFQ / class GOLD / bandwidth 64 / class SILVER / bandwidth 32
 * (96 kb/s = exactly 75 % of 128 kb/s: admitted).
 *
 * Pinned (the row): while both classes are backlogged, the bytes the port sends for GOLD and SILVER are in the ratio
 * 2:1 ± 5 % (class DRR with quanta proportional to the bandwidths); a policy asking for more than 75 % is refused with
 * the exact `qosAdmission` message, typed or loaded (the runtime then keeps the virtual FIFO, and `show policy-map
 * interface` says why it does not queue).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { fillTemplate } from '../src/cli/handlers/common.js';
import { QOS_ADMISSION_PERCENT } from '../src/link/qos/scheduler.js';
import { hostExec, ofKind, PCS_IP, qosWorld, routerExec, SE0, showPolicyMapInterface, traceFrom, trafficPdus } from './accept.p3.qos.harness.js';

const LINE_KBPS = 128;
const GOLD_KBPS = 64;
const SILVER_KBPS = 32;

const CLASSES: readonly string[] = ['class-map match-all GOLD', ' match dscp af41', '!', 'class-map match-all SILVER', ' match dscp af21', '!'];
const policy = (name: string, gold: number, silver: number): string[] => [
  `policy-map ${name}`,
  ' class GOLD',
  `  bandwidth ${gold}`,
  ' class SILVER',
  `  bandwidth ${silver}`,
  '!',
];

/** 200 kb/s of 1000-byte datagrams marked `dscp`, `seconds` long (25 per second). */
const markedFlow = (dscp: string, seconds: number): string => `flow start ${PCS_IP} rate 200 size 1000 dscp ${dscp} count ${seconds * 25}`;

function cbwfqWorld(seed: number, attach: readonly string[]): Simulation {
  return qosWorld({ seed, r1Qos: [...CLASSES, ...policy('CBWFQ', GOLD_KBPS, SILVER_KBPS), ...policy('BIG', 64, 64)], r1Lan: [], r1Serial: attach });
}

describe('CBWFQ on R1 Se0/0/0', () => {
  it('shares the congested line 2:1 ± 5 % between bandwidth 64 and bandwidth 32 while both are backlogged', () => {
    const sim = cbwfqWorld(321, [`bandwidth ${LINE_KBPS}`, 'service-policy output CBWFQ']);
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({
      policy: 'CBWFQ',
      refBps: LINE_KBPS * 1000,
      classes: [
        { name: 'GOLD', kind: 'bandwidth', weightKbps: GOLD_KBPS },
        { name: 'SILVER', kind: 'bandwidth', weightKbps: SILVER_KBPS },
        { name: 'class-default', kind: 'default' },
      ],
    });
    const SECONDS = 60;
    const cursor = sim.trace(0).next;
    hostExec(sim, 'pcv', markedFlow('af41', SECONDS));
    hostExec(sim, 'pcd', markedFlow('af21', SECONDS));
    const start = sim.now;
    expect(sim.runToIdle().stopped).not.toBe('maxEvents');
    const evs = traceFrom(sim, cursor);
    const gold = new Set(trafficPdus(evs, 'pcv'));
    const silver = new Set(trafficPdus(evs, 'pcd'));
    expect([gold.size, silver.size]).toEqual([SECONDS * 25, SECONDS * 25]);

    // both classes overflow (each offers 200 kb/s), so both stay backlogged through the measuring window
    const drops = ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === SE0);
    expect(drops.some((d) => gold.has(d.pdu.id))).toBe(true);
    expect(drops.some((d) => silver.has(d.pdu.id))).toBe(true);
    const queued = ofKind(evs, 'frameQueued').filter((q) => q.device === 'r1' && q.port === SE0);
    expect(new Set(queued.map((q) => q.queue))).toEqual(new Set(['GOLD', 'SILVER']));

    // the window: from 10 s after the start (both queues full) to 10 s before the flows end
    const from = start + 10 * SEC;
    const to = start + (SECONDS - 10) * SEC;
    expect(backloggedThroughout(evs, 'GOLD', from, to)).toBe(true);
    expect(backloggedThroughout(evs, 'SILVER', from, to)).toBe(true);
    let goldBytes = 0;
    let silverBytes = 0;
    for (const e of ofKind(evs, 'frameTx')) {
      if (e.from.device !== 'r1' || e.from.port !== SE0 || e.txStart < from || e.txStart >= to) continue;
      if (gold.has(e.pdu.id)) goldBytes += e.pdu.size;
      else if (silver.has(e.pdu.id)) silverBytes += e.pdu.size;
    }
    expect(silverBytes).toBeGreaterThan(0);
    const ratio = goldBytes / silverBytes;
    const target = GOLD_KBPS / SILVER_KBPS;
    expect(ratio).toBeGreaterThanOrEqual(target * 0.95);
    expect(ratio).toBeLessThanOrEqual(target * 1.05);
    // together they fill the line (the port never idles while backlogged): ≥ 95 % of 128 kb/s in the window
    const windowBits = (goldBytes + silverBytes) * 8;
    expect(windowBits * SEC).toBeGreaterThanOrEqual(0.95 * LINE_KBPS * 1000 * (to - from));
  }, 180_000);

  it('a policy asking for more than 75 % is refused with the admission message, typed or loaded', () => {
    // typed: refused, nothing stored, the port keeps the policy it had
    const sim = cbwfqWorld(322, [`bandwidth ${LINE_KBPS}`, 'service-policy output CBWFQ']);
    const typed = routerExec(sim, 'r1', ['enable', 'configure terminal', `interface ${SE0}`, 'service-policy output BIG', 'end']);
    const message = fillTemplate(CLI_MESSAGES.qosAdmission, { asked: 128, bw: LINE_KBPS, port: SE0 });
    expect(message).toBe(`% The priority and bandwidth classes ask for 128 kb/s, more than ${QOS_ADMISSION_PERCENT}% of the 128 kb/s on ${SE0}.`);
    expect(typed.map((r) => r.error)).toEqual([undefined, undefined, undefined, message, undefined]);
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'CBWFQ' });
    const [, run] = routerExec(sim, 'r1', ['enable', 'show running-config']);
    expect(run!.output).toContain(' service-policy output CBWFQ\n');
    expect(run!.output).not.toContain('service-policy output BIG');
    // exactly at 75 % is admitted (64 + 32 = 96 of 128): the policy above is in use
    expect(showPolicyMapInterface(sim, 'r1', SE0)).toContain('    Queueing: class-based, policy CBWFQ, reference rate 128 kb/s');

    // loaded from a startup configuration: stored, but the runtime does not compile it (the port keeps the FIFO)
    const loaded = cbwfqWorld(323, [`bandwidth ${LINE_KBPS}`, 'service-policy output BIG']);
    expect(loaded.device('r1')!.egressPolicy(SE0)).toBeUndefined();
    expect(showPolicyMapInterface(loaded, 'r1', SE0).split('\n')).toContain(
      `    Not queueing: the priority and bandwidth classes ask for 128 kb/s, more than ${QOS_ADMISSION_PERCENT}% of the 128 kb/s on ${SE0}`,
    );
  }, 180_000);
});

/** True when the class's queue never ran empty in [from, to): each of its dequeues there left another frame queued. */
function backloggedThroughout(evs: readonly TraceEvent[], queue: string, from: number, to: number): boolean {
  // the queue's depth after each enqueue rises and falls; a class is backlogged when, between consecutive enqueues in
  // the window, the depth it reports never drops to 1 (a frame joining an empty queue reports depth 1)
  const depths = ofKind(evs, 'frameQueued').filter((q) => q.device === 'r1' && q.port === SE0 && q.queue === queue && q.t >= from && q.t < to).map((q) => q.depth);
  return depths.length > 0 && depths.every((d) => d > 1);
}
