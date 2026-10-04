/**
 * The queueing sandbox tool (ARCHITECTURE-P3 D16, §3.5 step 7, §6 "Queueing sandbox", §10.3 W3 gate; W3 web-concept).
 *
 * Under test: the settings form (the default scenario, refusals in words), the step view (the model's sentence, the
 * queues as they stand after each step with every waiting packet named, the packet on the wire, clamping), and the
 * server-rendered tool: the four disciplines as a labelled toggle group, the step controls, every packet's fate as
 * text, the side-by-side comparison, labelled controls only, a live region for the step sentence.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  QUEUEING_LINK_RATES_KBPS,
  QueueingTool,
  defaultQueueingForm,
  packetLongName,
  packetToken,
  queueingScenarioOf,
  queueingStepView,
} from '../src/concept/queueing/QueueingTool';
import { QUEUEING_DEFAULT_SCENARIO, QUEUEING_DISCIPLINES, compareQueueing, packetFateText, runQueueing, type QueueingDiscipline } from '../src/concept/queueing/model';

const ALL: readonly QueueingDiscipline[] = ['fifo', 'wfq', 'cbwfq', 'llq'];

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Every input and select in `html` is named by a `<label for>` or an aria-label. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

describe('the settings form', () => {
  it('opens on the walk-through scenario exactly', () => {
    const r = queueingScenarioOf(defaultQueueingForm());
    expect(r).toEqual({ ok: true, scenario: { ...QUEUEING_DEFAULT_SCENARIO } });
    expect(QUEUEING_LINK_RATES_KBPS).toContain(QUEUEING_DEFAULT_SCENARIO.rateBps / 1000);
  });

  it('changes only the link and the queues: rate, queue limit and the class shares', () => {
    const r = queueingScenarioOf({ ...defaultQueueingForm(), rateKbps: '256', queueLimit: '8', voiceKbps: '64', dataKbps: '100', defaultKbps: '20' });
    expect(r.ok && r.scenario).toEqual({ ...QUEUEING_DEFAULT_SCENARIO, rateBps: 256_000, queueLimit: 8, voiceKbps: 64, dataKbps: 100, defaultKbps: 20 });
    if (r.ok) expect(r.scenario.flows).toBe(QUEUEING_DEFAULT_SCENARIO.flows);
  });

  it('refuses a figure it cannot run, in words', () => {
    expect(queueingScenarioOf({ ...defaultQueueingForm(), rateKbps: '100' })).toEqual({ ok: false, error: 'Choose a link rate of 64, 128, 256, 512 kb/s.' });
    expect(queueingScenarioOf({ ...defaultQueueingForm(), queueLimit: '0' })).toEqual({ ok: false, error: 'A queue holds 1 to 200 packets.' });
    expect(queueingScenarioOf({ ...defaultQueueingForm(), queueLimit: 'ten' })).toEqual({ ok: false, error: 'A queue holds 1 to 200 packets.' });
    expect(queueingScenarioOf({ ...defaultQueueingForm(), dataKbps: '-5' })).toEqual({
      ok: false,
      error: 'The DATA share is a whole number of kb/s from 1 to 10000.',
    });
  });
});

describe('the step view', () => {
  it('names packets by a letter and their number in the flow', () => {
    expect(packetToken({ kind: 'voice', seq: 3 })).toBe('V3');
    expect(packetToken({ kind: 'data', seq: 12 })).toBe('D12');
    expect(packetLongName({ kind: 'voice', seq: 3, bytes: 80 })).toBe('voice packet 3 (80 B)');
  });

  it('shows each step as the model recorded it: its sentence, every queue and the wire', () => {
    for (const d of ALL) {
      const run = runQueueing(QUEUEING_DEFAULT_SCENARIO, d);
      expect(run.steps.length, d).toBeGreaterThan(0);
      run.steps.forEach((step, i) => {
        const v = queueingStepView(run, i);
        expect(v.index).toBe(i);
        expect(v.total).toBe(run.steps.length);
        expect(v.text).toBe(step.text);
        expect(v.queues.map((q) => q.tokens)).toEqual(step.queues.map((q) => q.map((n) => packetToken(run.packets[n]!))));
        if (step.onWire === null) expect(v.wire).toBe('The link is idle.');
        else expect(v.wire).toContain(packetLongName(run.packets[step.onWire.packet]!));
      });
    }
  });

  it('heads a step with its number and time, and clamps outside the run', () => {
    const run = runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo');
    expect(queueingStepView(run, 0).heading).toBe(`Step 1 of ${run.steps.length} at 0.0 ms`);
    expect(queueingStepView(run, -4).index).toBe(0);
    expect(queueingStepView(run, 10_000).index).toBe(run.steps.length - 1);
    // the first step: voice packet 1 is on the wire at once, data packet 1 waits in the one queue
    const first = run.steps.findIndex((s) => s.kind === 'send');
    const v = queueingStepView(run, first);
    expect(v.wire).toMatch(/^On the wire: voice packet 1 \(80 B\), from 0\.0 ms to 5\.0 ms\.$/);
  });

  it('names the classes of CBWFQ and LLQ, the priority one marked, and one queue for FIFO and WFQ', () => {
    const llq = queueingStepView(runQueueing(QUEUEING_DEFAULT_SCENARIO, 'llq'), 0);
    expect(llq.queues.map((q) => q.name)).toEqual(['VOICE (priority)', 'DATA', 'class-default']);
    expect(llq.queues.map((q) => q.priority)).toEqual([true, false, false]);
    expect(queueingStepView(runQueueing(QUEUEING_DEFAULT_SCENARIO, 'cbwfq'), 0).queues.map((q) => q.name)).toEqual(['VOICE', 'DATA', 'class-default']);
    expect(queueingStepView(runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo'), 0).queues.map((q) => q.name)).toEqual(['Queue']);
    expect(queueingStepView(runQueueing(QUEUEING_DEFAULT_SCENARIO, 'wfq'), 0).queues.map((q) => q.name)).toEqual(['Queue']);
    const empty = queueingStepView(runQueueing(QUEUEING_DEFAULT_SCENARIO, 'llq'), 0).queues.find((q) => q.tokens.length === 0);
    expect(empty?.text).toMatch(/: empty$/);
  });
});

describe('the tool', () => {
  const html = renderToStaticMarkup(createElement(QueueingTool));
  const t = text(html);

  it('offers the four disciplines as a labelled toggle group, FIFO first', () => {
    expect(html).toContain('role="group" aria-label="Queueing discipline"');
    for (const d of QUEUEING_DISCIPLINES) expect(t).toContain(d.label);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>FIFO</);
  });

  it('walks the FIFO run step by step: controls, the first step in a live region, the queues and the wire', () => {
    const run = runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo');
    for (const b of ['First', 'Back', 'Step', 'Play', 'Last']) expect(t).toContain(b);
    expect(html).toContain('role="status" aria-live="polite"');
    expect(t).toContain(run.steps[0]!.text);
    expect(t).toContain(`Step 1 of ${run.steps.length} at 0.0 ms`);
  });

  it('writes every packet’s wait as a sentence', () => {
    const run = runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo');
    expect(run.packets.length).toBeGreaterThan(30);
    for (const p of run.packets) expect(t).toContain(packetFateText(run, p.index));
  });

  it('compares the four disciplines over the same arrivals', () => {
    for (const r of compareQueueing(QUEUEING_DEFAULT_SCENARIO)) for (const s of r.summary) expect(t).toContain(s.text);
    expect(t).toContain('(shown above)');
  });

  it('labels every control and tells nothing by colour alone', () => {
    expect(unlabelledControls(html)).toEqual([]);
    // the class shares only matter to CBWFQ and LLQ; FIFO shows the rate and the queue limit
    expect(t).toContain('Link rate');
    expect(t).toContain('Queue limit (packets)');
    expect(t).not.toContain('DATA bandwidth');
    expect(t).toContain('V is a voice packet and D a data packet');
  });
});
