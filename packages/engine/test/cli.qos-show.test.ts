/**
 * cli.qos-show — [S20]/[S21] the admission refusal at `service-policy output` through the W2 `qos/config.ts` reader,
 * the queue lines of `show policy-map interface` (§3.11 step 5) and of `show interfaces`, and ruling R26's policer
 * conform/exceed counts read from `DeviceRuntime.qosCounters` (ARCHITECTURE-P3 §3.11, §5.4, §5.8, D16, R26; §7 W3 cli,
 * approved items) — against fake `EgressQueueView`s and fake QoS counters. A port without an output scheduler (every
 * P1/P2 port) gains no line.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandCtx } from '../src/contracts/cli.js';
import type { EgressQueueView } from '../src/contracts/link.js';
import type { PortQosView } from '../src/contracts/snapshot.js';
import { QOS_HANDLERS as Q } from '../src/cli/grammar/qos.js';
import { SHOW_HANDLERS as S } from '../src/cli/grammar/show.js';
import { fillTemplate } from '../src/cli/handlers/common.js';
import { policeActionText, policerCounts, qosPortReferenceBps } from '../src/cli/handlers/qos.js';
import { egressQueueOf, interfaceQueueLines } from '../src/cli/handlers/show.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { qosPoliceBurstBytes } from '../src/link/qos/scheduler.js';
import type { ConfigAst } from '../src/contracts/config.js';
import { approvedCtx, run, showCtx, showLines } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const SE0 = 'Serial0/0/0';
const GI0 = 'GigabitEthernet0/0';

/** §3.11's configuration on R1: `class-map match-all VOICE` / `match dscp ef`; `policy-map WAN-EDGE` with `extra` lines. */
function wanEdge(voice: readonly (readonly string[])[], def: readonly (readonly string[])[] = [['fair-queue']]): ConfigAst {
  const running = createConfigAst();
  running.set([], ['class-map', 'match-all', 'VOICE']);
  running.set([['class-map', 'match-all', 'VOICE']], ['match', 'dscp', 'ef']);
  running.set([], ['policy-map', 'WAN-EDGE']);
  running.set([['policy-map', 'WAN-EDGE']], ['class', 'VOICE']);
  for (const l of voice) running.set([['policy-map', 'WAN-EDGE'], ['class', 'VOICE']], [...l]);
  running.set([['policy-map', 'WAN-EDGE']], ['class', 'class-default']);
  for (const l of def) running.set([['policy-map', 'WAN-EDGE'], ['class', 'class-default']], [...l]);
  return running;
}

/** `service-policy output WAN-EDGE` typed on Se0/0/0 (with `bandwidth <kbps>` when given). */
function attach(running: ConfigAst, bandwidthKbps?: number): ReturnType<typeof run> {
  if (bandwidthKbps !== undefined) running.set([['interface', SE0]], ['bandwidth', String(bandwidthKbps)]);
  const rec = approvedCtx(R, { iface: SE0, running });
  return run(rec, Q.ifServicePolicy, { direction: 'output', name: 'WAN-EDGE' });
}

function refusal(asked: number, bw: number, port = SE0): { error: string } {
  return { error: fillTemplate(CLI_MESSAGES.qosAdmission, { asked, bw, port }) };
}

describe('service-policy output: the 75 % admission through the qos/config.ts reader', () => {
  it('§3.11 step 1: priority 32 on a 128 kb/s line is admitted (32 <= 96); 100 is refused with the exact message', () => {
    expect(attach(wanEdge([['priority', '32']]), 128)).toEqual({});
    expect(attach(wanEdge([['priority', '100']]), 128)).toEqual(refusal(100, 128));
    // exactly 75 % is admitted (asked x 4 <= ref x 3)
    expect(attach(wanEdge([['priority', '96']]), 128)).toEqual({});
    expect(attach(wanEdge([['priority', '97']]), 128)).toEqual(refusal(97, 128));
  });

  it('percent forms are shares of the reference rate, asked rounded up; remaining percent reserves nothing', () => {
    // 50 % + 30 % of 128000 b/s = 64000 + 38400 = 102400 b/s → 103 kb/s
    const pct = wanEdge([['priority', 'percent', '50']], [['bandwidth', 'percent', '30']]);
    expect(attach(pct, 128)).toEqual(refusal(103, 128));
    const remaining = wanEdge([['priority', 'percent', '50']], [['bandwidth', 'remaining', 'percent', '90']]);
    expect(attach(remaining, 128)).toEqual({});
  });

  it('without a bandwidth line the reference is the routing bandwidth (1544 kb/s on serial; ruling R34), not the port rate', () => {
    const rec = approvedCtx(R, { iface: SE0 });
    const port = rec.ports.get(SE0)!;
    // ruling R34: one QoS reference rate for the CLI, the runtime and the qos.admitted fact
    expect(port.speedBps ?? port.spec.speedBps).toBe(2_000_000);
    expect(qosPortReferenceBps(rec.ctx, port)).toBe(1_544_000);
    // 1158 kb/s is exactly 75 % of 1544 (admitted); 1159 and 1200 are refused against 1544
    expect(attach(wanEdge([['priority', '1158']]))).toEqual({});
    expect(attach(wanEdge([['priority', '1159']]))).toEqual(refusal(1159, 1544));
    expect(attach(wanEdge([['priority', '1200']]))).toEqual(refusal(1200, 1544));
  });

  it('keeps the W2 direction and port rules, read from the compiled policy', () => {
    const rec = approvedCtx(R, { iface: SE0, running: wanEdge([['queue-limit', '20']]) });
    expect(run(rec, Q.ifServicePolicy, { direction: 'input', name: 'WAN-EDGE' })).toEqual({ error: CLI_MESSAGES.qosQueueingOutputOnly });
    expect(run(rec, Q.ifServicePolicy, { direction: 'output', name: 'NOPE' })).toEqual({ error: '% There is no policy-map named NOPE.' });
    expect(run(rec, Q.ifServicePolicy, { direction: 'output', name: 'WAN-EDGE' })).toEqual({});
    expect(rec.running.render()).toContain('\n service-policy output WAN-EDGE\n');
  });
});

/** The held queues of §3.11 at Se0/0/0 (LLQ VOICE, WFQ class-default). */
const VIEW: EgressQueueView = {
  policy: 'WAN-EDGE',
  strategy: 'class-based',
  refBps: 128_000,
  classes: [
    { name: 'VOICE', kind: 'priority', depth: 0, limit: 64, matched: 120, matchedBytes: 7200, sent: 118, tailDrops: 0, policed: 2, offeredBps30s: 30_000 },
    { name: 'class-default', kind: 'default', depth: 12, limit: 64, matched: 300, matchedBytes: 301_200, sent: 283, tailDrops: 5, policed: 0, offeredBps30s: 200_000, flows: 2 },
  ],
};

/** R1 with WAN-EDGE on Se0/0/0 (`bandwidth 128`), shown through a context whose queues and counters are `patch`'s. */
function shown(running: ConfigAst, patch: Partial<CommandCtx> = {}): CommandCtx {
  running.set([['interface', SE0]], ['bandwidth', '128']);
  running.set([['interface', SE0]], ['service-policy', 'output', 'WAN-EDGE']);
  return showCtx(approvedCtx(R, { mode: 'priv-exec', running }), { patch });
}

describe('show policy-map interface: the queue lines (§3.11 step 5)', () => {
  it('per class: matched, the priority or fair-queue parameters, depth / limit, sent, drops, policed and the offered rate', () => {
    const ctx = shown(wanEdge([['priority', '32']]), { egressQueues: (p) => (p === SE0 ? VIEW : undefined) });
    expect(showLines(ctx, Q.showPolicyMapInterface, { iface: SE0 })).toEqual([
      SE0,
      '  Output policy WAN-EDGE',
      '    Queueing: class-based, policy WAN-EDGE, reference rate 128 kb/s',
      '    Class VOICE: 120 packets (7200 bytes) matched',
      '      Priority: 32 kb/s, served first and held to that rate while the link is congested',
      '      Queue: 0/64 packets waiting, 118 sent, 0 dropped (queue full), 2 policed; offered 30 kb/s over the last 30 s',
      '    Class class-default: 300 packets (301200 bytes) matched',
      "      Fair queueing among the class's flows",
      '      Queue: 12/64 packets waiting, 283 sent, 5 dropped (queue full), 0 policed, 2 flows; offered 200 kb/s over the last 30 s',
    ]);
  });

  it('reads the queues from the QoS view when the context has no egressQueues', () => {
    const counters: PortQosView = { output: 'WAN-EDGE', classes: [], queue: VIEW };
    const ctx = shown(wanEdge([['priority', '32']]), { qosCounters: (p) => (p === SE0 ? counters : undefined) });
    expect(egressQueueOf(ctx, SE0)).toBe(VIEW);
    expect(showLines(ctx, Q.showPolicyMapInterface, { iface: SE0 })[2]).toBe('    Queueing: class-based, policy WAN-EDGE, reference rate 128 kb/s');
  });

  it('without held queues: the parameters from the configuration, and the admission refusal when the policy no longer fits', () => {
    const ok = shown(wanEdge([['bandwidth', '64'], ['queue-limit', '20']], [['shape', 'average', '96000', '9600']]));
    expect(showLines(ok, Q.showPolicyMapInterface, { iface: SE0 })).toEqual([
      SE0,
      '  Output policy WAN-EDGE',
      '    Queueing: class-based, reference rate 128 kb/s',
      '    Class VOICE: 0 packets (0 bytes) matched',
      '      Bandwidth: 64 kb/s guaranteed',
      '      Queue limit: 20 packets',
      '    Class class-default: 0 packets (0 bytes) matched',
      '      Shape: average 96000 b/s, bucket 9600 bits',
    ]);
    // the bandwidth was lowered after the attach: the runtime keeps the FIFO, the show says why
    const running = wanEdge([['priority', '100']]);
    const ctx = shown(running);
    running.set([['interface', SE0]], ['bandwidth', '64']);
    expect(showLines(ctx, Q.showPolicyMapInterface, { iface: SE0 })[2]).toBe(
      '    Not queueing: the priority and bandwidth classes ask for 100 kb/s, more than 75% of the 64 kb/s on Serial0/0/0',
    );
    const pct = shown(wanEdge([['priority', 'percent', '25']], [['bandwidth', 'remaining', 'percent', '50']]));
    expect(showLines(pct, Q.showPolicyMapInterface, { iface: SE0 }).filter((l) => l.startsWith('      '))).toEqual([
      '      Priority: 25% of the reference rate, served first and held to that rate while the link is congested',
      '      Bandwidth: 50% of what the priority and bandwidth classes leave',
    ]);
  });
});

describe('show policy-map interface: the policer and its R26 counts', () => {
  /** §3.11 step 6: `policy-map MARK` / `class class-default` / `police …` as R1 Gi0/0's input policy. */
  function marked(police: readonly string[], counters?: PortQosView): CommandCtx {
    const running = createConfigAst();
    running.set([], ['policy-map', 'MARK']);
    running.set([['policy-map', 'MARK']], ['class', 'class-default']);
    running.set([['policy-map', 'MARK'], ['class', 'class-default']], ['police', ...police]);
    running.set([['interface', GI0]], ['service-policy', 'input', 'MARK']);
    const patch: Partial<CommandCtx> = counters === undefined ? {} : { qosCounters: (p) => (p === GI0 ? counters : undefined) };
    return showCtx(approvedCtx(R, { mode: 'priv-exec', running }), { patch });
  }

  it('counts conform and exceed packets from the runtime counters', () => {
    const counters: PortQosView = {
      input: 'MARK',
      classes: [{ name: 'class-default', matched: 50, matchedBytes: 50_000, marked: 0, police: { conform: 40, conformBytes: 40_000, exceed: 10, exceedBytes: 10_000 } }],
    };
    expect(showLines(marked(['64000', 'conform-action', 'transmit', 'exceed-action', 'drop'], counters), Q.showPolicyMapInterface, { iface: GI0 })).toEqual([
      GI0,
      '  Input policy MARK',
      '    Class class-default: 50 packets (50000 bytes) matched',
      `      Police: 64000 b/s, burst ${qosPoliceBurstBytes(64_000)} bytes, conform transmit, exceed drop; 40 conformed, 10 exceeded`,
    ]);
  });

  it('shows the actions as configured, and no count while the counters carry none', () => {
    const out = showLines(marked(['64000', '8000', 'conform-action', 'transmit', 'exceed-action', 'set-dscp-transmit', 'af11']), Q.showPolicyMapInterface, { iface: GI0 });
    expect(out[3]).toBe('      Police: 64000 b/s, burst 8000 bytes, conform transmit, exceed set-dscp-transmit af11');
    expect(policeActionText({ kind: 'set-dscp-transmit', dscp: 46 })).toBe('set-dscp-transmit ef');
    expect(policerCounts(undefined)).toBeUndefined();
    expect(policerCounts({ name: 'x', matched: 1, matchedBytes: 1, marked: 0 })).toBeUndefined();
  });

  it('an output policer enforced by the scheduler counts its exceeds from the held queue', () => {
    const running = wanEdge([['priority', '32']], [['police', '64000', 'conform-action', 'transmit', 'exceed-action', 'drop']]);
    const view: EgressQueueView = { ...VIEW, classes: [VIEW.classes[0]!, { ...VIEW.classes[1]!, policed: 7 }] };
    const out = showLines(shown(running, { egressQueues: () => view }), Q.showPolicyMapInterface, { iface: SE0 });
    expect(out).toContain(`      Police: 64000 b/s, burst ${qosPoliceBurstBytes(64_000)} bytes, conform transmit, exceed drop; 7 exceeded`);
  });

  it('splits the runtime counters by direction: the input policy\'s classes first, then the output policy\'s', () => {
    const running = wanEdge([['priority', '32']]);
    running.set([], ['policy-map', 'MARK']);
    running.set([['policy-map', 'MARK']], ['class', 'class-default']);
    running.set([['policy-map', 'MARK'], ['class', 'class-default']], ['set', 'dscp', 'af11']);
    running.set([['interface', SE0]], ['service-policy', 'input', 'MARK']);
    const counters: PortQosView = {
      input: 'MARK',
      output: 'WAN-EDGE',
      classes: [
        { name: 'class-default', matched: 5, matchedBytes: 500, marked: 5 },
        { name: 'VOICE', matched: 7, matchedBytes: 700, marked: 0 },
        { name: 'class-default', matched: 9, matchedBytes: 900, marked: 0 },
      ],
    };
    const out = showLines(shown(running, { qosCounters: (p) => (p === SE0 ? counters : undefined) }), Q.showPolicyMapInterface, { iface: SE0 });
    expect(out.filter((l) => l.startsWith('    Class ') || l.startsWith('  '))).toEqual([
      '  Input policy MARK',
      '    Class class-default: 5 packets (500 bytes) matched; 5 marked (set dscp af11)',
      '  Output policy WAN-EDGE',
      '    Queueing: class-based, reference rate 128 kb/s',
      '    Class VOICE: 7 packets (700 bytes) matched',
      '      Priority: 32 kb/s, served first and held to that rate while the link is congested',
      '    Class class-default: 9 packets (900 bytes) matched',
      "      Fair queueing among the class's flows",
    ]);
  });

  it('a marking-only policy keeps its W2 lines exactly (no new line)', () => {
    const running = createConfigAst();
    running.set([], ['policy-map', 'MARK']);
    running.set([['policy-map', 'MARK']], ['class', 'class-default']);
    running.set([['policy-map', 'MARK'], ['class', 'class-default']], ['set', 'dscp', 'af11']);
    running.set([['interface', GI0]], ['service-policy', 'input', 'MARK']);
    const counters: PortQosView = { input: 'MARK', classes: [{ name: 'class-default', matched: 3, matchedBytes: 300, marked: 3 }] };
    const ctx = showCtx(approvedCtx(R, { mode: 'priv-exec', running }), { patch: { qosCounters: () => counters } });
    expect(showLines(ctx, Q.showPolicyMapInterface, { iface: GI0 })).toEqual([
      GI0,
      '  Input policy MARK',
      '    Class class-default: 3 packets (300 bytes) matched; 3 marked (set dscp af11)',
    ]);
  });
});

describe('show interfaces: the queue lines', () => {
  it('a scheduler port gains the strategy, policy and one line per class after the transmit queue', () => {
    const ctx = shown(wanEdge([['priority', '32']]), { egressQueues: (p) => (p === SE0 ? VIEW : undefined) });
    const out = showLines(ctx, S.showInterfaces, { iface: SE0 });
    const at = out.indexOf('  Transmit queue: 0 frames waiting');
    expect(out.slice(at + 1)).toEqual([
      '  Queueing: class-based, policy WAN-EDGE, reference rate 128 kb/s',
      '    VOICE (priority): 0/64 packets waiting, 118 sent, 0 dropped (queue full), 2 policed',
      '    class-default (default): 12/64 packets waiting, 283 sent, 5 dropped (queue full), 0 policed, 2 flows',
    ]);
    // the other ports keep their block: it ends with the transmit queue
    const gi = showLines(ctx, S.showInterfaces, { iface: GI0 });
    expect(gi[gi.length - 1]).toBe('  Transmit queue: 0 frames waiting');
  });

  it('[S21] interface fair-queue: weighted fair, no policy name', () => {
    const fair: EgressQueueView = {
      policy: '',
      strategy: 'fair',
      refBps: 128_000,
      classes: [{ name: 'class-default', kind: 'default', depth: 3, limit: 256, matched: 9, matchedBytes: 900, sent: 6, tailDrops: 0, policed: 0, offeredBps30s: 0, flows: 3 }],
    };
    expect(interfaceQueueLines(fair)).toEqual([
      '  Queueing: weighted fair, reference rate 128 kb/s',
      '    class-default (default): 3/256 packets waiting, 6 sent, 0 dropped (queue full), 0 policed, 3 flows',
    ]);
  });
});
