// [S20] The port inspector's Policy section (ARCHITECTURE-P3 §5.9, §6 "[S20] … the Policy section with per-class bars
// and a 30-second sparkline", §3.11, §10.2 `inspector.policy-section.test.ts`; §7 W3 web-inspector): from the
// `EgressQueueView` of `PortSnapshot.qos.queue`, one bar per class (depth of limit, the `P` badge on the priority class,
// matched / sent / tail drops / policed / the 30 s offered rate in words) and a sparkline of the packets held over the
// last 30 simulated seconds; nothing for a port without held queues.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EgressQueueView } from '@netforge/engine';
import {
  PolicySection,
  QUEUE_CLASS_BADGE,
  QUEUE_STRATEGY_WORDS,
  SPARKLINE_WINDOW_NS,
  policySectionModel,
  pushQueueSample,
  rateText,
  sparklinePoints,
  sparklineWords,
} from '../src/inspector/PolicySection';

const S = 1_000_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/** §3.11: `policy-map WAN-EDGE` with `class VOICE` / `priority 32` and `class class-default` / `fair-queue` at 128 kb/s. */
const LLQ: EgressQueueView = {
  policy: 'WAN-EDGE',
  strategy: 'class-based',
  refBps: 128_000,
  classes: [
    { name: 'VOICE', kind: 'priority', depth: 1, limit: 64, matched: 250, matchedBytes: 15_000, sent: 245, tailDrops: 0, policed: 4, offeredBps30s: 32_000 },
    {
      name: 'class-default',
      kind: 'default',
      depth: 64,
      limit: 64,
      matched: 900,
      matchedBytes: 900_000,
      sent: 800,
      tailDrops: 36,
      policed: 0,
      offeredBps30s: 256_000,
      flows: 2,
    },
  ],
};

describe('[S20] the Policy section model', () => {
  it('one bar per class in policy order, with its fill, badge and words', () => {
    const m = policySectionModel(LLQ);
    expect(m.policy).toBe('WAN-EDGE');
    expect(m.strategyText).toBe(QUEUE_STRATEGY_WORDS['class-based']);
    expect(m.held).toBe(65);
    expect(m.classes.map((c) => [c.name, c.badge, c.fill, c.offeredShare])).toEqual([
      ['VOICE', 'P', 1 / 64, 0.25],
      ['class-default', '', 1, 1], // a full queue; offered above the reference rate clamps to 1
    ]);
    expect(m.classes[0]?.words).toBe('1 of 64 held · 250 matched · 245 sent · 0 tail drops · 4 policed');
    expect(m.classes[1]?.words).toBe('64 of 64 held · 900 matched · 800 sent · 36 tail drops · 2 flows');
    expect(QUEUE_CLASS_BADGE).toEqual({ priority: 'P', bandwidth: '', default: '' });
  });

  it('interface fair-queue has no policy name; a zero rate reads 0 b/s', () => {
    const fq: EgressQueueView = { policy: '', strategy: 'fair', refBps: 0, classes: [] };
    const m = policySectionModel(fq);
    expect(m.policy).toBeUndefined();
    expect(m.held).toBe(0);
    expect(rateText(0)).toBe('0 b/s');
    expect(rateText(128_000)).toBe('128 kb/s');
  });
});

describe('[S20] the 30-second sparkline', () => {
  it('keeps the last 30 s, replaces an equal instant and restarts when time moves back', () => {
    let s = pushQueueSample([], 0, 0);
    s = pushQueueSample(s, 10 * S, 5);
    s = pushQueueSample(s, 10 * S, 6);
    expect(s).toEqual([
      { t: 0, v: 0 },
      { t: 10 * S, v: 6 },
    ]);
    s = pushQueueSample(s, 35 * S, 2);
    expect(s).toEqual([
      { t: 10 * S, v: 6 },
      { t: 35 * S, v: 2 },
    ]);
    expect(pushQueueSample(s, 5 * S, 1)).toEqual([{ t: 5 * S, v: 1 }]);
    expect(SPARKLINE_WINDOW_NS).toBe(30 * S);
  });

  it('draws time left to right and the peak at the top; says the same in words', () => {
    const s = [
      { t: 10 * S, v: 6 },
      { t: 25 * S, v: 3 },
      { t: 40 * S, v: 0 },
    ];
    expect(sparklinePoints(s, 40 * S, 180, 28)).toBe('0,0 90,14 180,28');
    expect(sparklineWords(s)).toBe('now 0 held, peak 6 in the last 30 s');
    expect(sparklinePoints([], 0, 180, 28)).toBe('');
    expect(sparklineWords([])).toBe('no sample yet');
    // one sample is a flat line across
    expect(sparklinePoints([{ t: 5 * S, v: 0 }], 5 * S, 180, 28)).toBe('0,28 180,28');
  });
});

describe('[S20] the rendered section', () => {
  it('shows the policy, a bar per class and the sparkline with its words', () => {
    const html = renderToStaticMarkup(createElement(PolicySection, { port: { id: 'Serial0/0/0', qos: { output: 'WAN-EDGE', classes: [], queue: LLQ } }, now: 40 * S }));
    const t = text(html);
    expect(html).toContain('aria-label="Policy"');
    expect(t).toContain('Output policy WAN-EDGE');
    expect(t).toContain('Reference rate 128 kb/s');
    expect(t).toContain('P VOICE priority (low-latency queue)');
    expect(t).toContain('1 of 64 held · 250 matched · 245 sent · 0 tail drops · 4 policed');
    expect(t).toContain('offered 32 kb/s over 30 s');
    expect(html).toContain('role="meter" aria-label="class-default queue" aria-valuemin="0" aria-valuemax="64" aria-valuenow="64"');
    expect(t).toContain('now 65 held, peak 65 in the last 30 s');
    expect(html).toContain('<polyline');
  });

  it('renders nothing for a port without held queues', () => {
    expect(renderToStaticMarkup(createElement(PolicySection, { port: { id: 'Serial0/0/0', qos: { output: 'MARK', classes: [] } }, now: 0 }))).toBe('');
    expect(renderToStaticMarkup(createElement(PolicySection, { port: { id: 'Serial0/0/0' }, now: 0 }))).toBe('');
  });
});
