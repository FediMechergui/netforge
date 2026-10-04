/**
 * Port inspector, Policy section [S20] (ARCHITECTURE-P3 §5.9 "Port inspector", §6 "[S20] … the Policy section with
 * per-class bars and a 30-second sparkline"; §3.11; §7 W3 web-inspector). For a port whose output policy queues (the
 * held class queues of the link model, D16) it shows the policy, the scheduling strategy and the reference rate, then
 * one bar per class — how full its queue is (depth of limit) — with the class kind (`P` badge for the priority class,
 * as the canvas lanes), the packets matched and sent, the tail drops, the policed drops and the 30-second offered rate;
 * under them a sparkline of the packets held on the port over the last 30 simulated seconds, with the same facts in
 * words.
 *
 * Source: `PortSnapshot.qos.queue` (the [S20] `EgressQueueView`, display only, rule 20); a port without it shows
 * nothing. The sparkline is sampled in the web whenever the snapshot moves (the view itself carries no history). Every
 * bar keeps its numbers in text; wording is original (§0 rule 6).
 */
import { useEffect, useState } from 'react';
import type { EgressQueueView, PortSnapshot, SimTime } from '@netforge/engine';
import { formatBps } from '../vocab/fields';
import './inspector.css';

// ── vocabulary ───────────────────────────────────────────────────────────────

type QueueClass = EgressQueueView['classes'][number];

/** Words of the scheduling strategies. */
export const QUEUE_STRATEGY_WORDS: Readonly<Record<EgressQueueView['strategy'], string>> = Object.freeze({
  fifo: 'first in, first out',
  'class-based': 'class-based (a priority queue first, then the classes share by their bandwidth)',
  fair: 'fair queueing (the flows share the port)',
});

/** Words of the class kinds. */
export const QUEUE_CLASS_KIND_WORDS: Readonly<Record<QueueClass['kind'], string>> = Object.freeze({
  priority: 'priority (low-latency queue)',
  bandwidth: 'bandwidth guarantee',
  default: 'everything else',
});

/** Badge of a class kind: `P` for the priority class (the canvas lanes' badge), none otherwise. */
export const QUEUE_CLASS_BADGE: Readonly<Record<QueueClass['kind'], string>> = Object.freeze({ priority: 'P', bandwidth: '', default: '' });

/** The sparkline's window: the last 30 simulated seconds. */
export const SPARKLINE_WINDOW_NS = 30_000_000_000;

// ── model (pure) ─────────────────────────────────────────────────────────────

/** One class bar. */
export interface PolicyClassBar {
  readonly name: string;
  readonly kind: QueueClass['kind'];
  readonly kindText: string;
  readonly badge: string;
  readonly depth: number;
  readonly limit: number;
  /** depth / limit, clamped to [0, 1]. */
  readonly fill: number;
  readonly matched: number;
  readonly matchedBytes: number;
  readonly sent: number;
  readonly tailDrops: number;
  readonly policed: number;
  readonly offeredBps30s: number;
  /** offered / reference rate, clamped to [0, 1]. */
  readonly offeredShare: number;
  readonly flows?: number;
  /** The bar in words: `3 of 64 held · 120 matched · 117 sent · 0 tail drops`. */
  readonly words: string;
}

/** What the section shows. */
export interface PolicySectionModel {
  readonly policy?: string;
  readonly strategyText: string;
  readonly refBps: number;
  readonly classes: readonly PolicyClassBar[];
  /** Packets held on the port now (all classes). */
  readonly held: number;
}

function clamp01(x: number): number {
  return !(x > 0) ? 0 : x >= 1 ? 1 : x;
}

/** A rate in words (`0 b/s` rather than a dash). */
export function rateText(bps: number): string {
  return bps > 0 ? formatBps(bps) : '0 b/s';
}

/** The model of the section for one queue view. */
export function policySectionModel(view: EgressQueueView): PolicySectionModel {
  let held = 0;
  const classes = view.classes.map((c): PolicyClassBar => {
    held += c.depth;
    const fill = c.limit > 0 ? clamp01(c.depth / c.limit) : 0;
    const offeredShare = view.refBps > 0 ? clamp01(c.offeredBps30s / view.refBps) : 0;
    const parts = [`${c.depth} of ${c.limit} held`, `${c.matched} matched`, `${c.sent} sent`, `${c.tailDrops} tail drop${c.tailDrops === 1 ? '' : 's'}`];
    if (c.policed > 0) parts.push(`${c.policed} policed`);
    if (c.flows !== undefined) parts.push(`${c.flows} flow${c.flows === 1 ? '' : 's'}`);
    return {
      name: c.name,
      kind: c.kind,
      kindText: QUEUE_CLASS_KIND_WORDS[c.kind] ?? c.kind,
      badge: QUEUE_CLASS_BADGE[c.kind] ?? '',
      depth: c.depth,
      limit: c.limit,
      fill,
      matched: c.matched,
      matchedBytes: c.matchedBytes,
      sent: c.sent,
      tailDrops: c.tailDrops,
      policed: c.policed,
      offeredBps30s: c.offeredBps30s,
      offeredShare,
      ...(c.flows !== undefined ? { flows: c.flows } : {}),
      words: parts.join(' · '),
    };
  });
  return {
    ...(view.policy !== undefined && view.policy !== '' ? { policy: view.policy } : {}),
    strategyText: QUEUE_STRATEGY_WORDS[view.strategy] ?? view.strategy,
    refBps: view.refBps,
    classes,
    held,
  };
}

/** One sparkline sample: packets held at a simulated instant. */
export interface QueueSample {
  readonly t: SimTime;
  readonly v: number;
}

/**
 * Add a sample and keep the last `windowNs`: a later instant appends (an equal one replaces the last value), an
 * earlier one restarts the line (the world was reset or the time machine moved back).
 */
export function pushQueueSample(samples: readonly QueueSample[], t: SimTime, v: number, windowNs: number = SPARKLINE_WINDOW_NS): QueueSample[] {
  const last = samples[samples.length - 1];
  if (last !== undefined && t < last.t) return [{ t, v }];
  const kept = last !== undefined && t === last.t ? samples.slice(0, -1) : samples.slice();
  kept.push({ t, v });
  const from = t - windowNs;
  return kept.filter((s) => s.t >= from);
}

/** The polyline points of a sparkline `width` × `height` ending at `now` (x = time in the window, y = held packets). */
export function sparklinePoints(samples: readonly QueueSample[], now: SimTime, width: number, height: number, windowNs: number = SPARKLINE_WINDOW_NS): string {
  if (samples.length === 0) return '';
  const peak = Math.max(1, ...samples.map((s) => s.v));
  const pts = samples.map((s) => {
    const x = width * clamp01(1 - (now - s.t) / windowNs);
    const y = height - (s.v / peak) * height;
    return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
  });
  // one sample alone draws a flat line to the right edge
  const only = samples[0];
  if (samples.length === 1 && only !== undefined) pts.unshift(`0,${Math.round((height - (only.v / peak) * height) * 10) / 10}`);
  return pts.join(' ');
}

/** The sparkline in words: `now 3 held, peak 12 in the last 30 s`. */
export function sparklineWords(samples: readonly QueueSample[]): string {
  const last = samples[samples.length - 1];
  if (last === undefined) return 'no sample yet';
  const peak = Math.max(...samples.map((s) => s.v));
  return `now ${last.v} held, peak ${peak} in the last 30 s`;
}

// ── component ────────────────────────────────────────────────────────────────

export interface PolicySectionProps {
  port: Pick<PortSnapshot, 'id' | 'qos'>;
  /** The snapshot's simulated time (the sparkline's clock). */
  now: SimTime;
}

const SPARK_W = 180;
const SPARK_H = 28;

/** The Policy section of a scheduler port, or nothing when the port has no held queues. */
export function PolicySection({ port, now }: PolicySectionProps) {
  const view = port.qos?.queue;
  if (view === undefined) return null;
  return <PolicyBody view={view} now={now} />;
}

function PolicyBody({ view, now }: { view: EgressQueueView; now: SimTime }) {
  const model = policySectionModel(view);
  const [samples, setSamples] = useState<QueueSample[]>(() => [{ t: now, v: model.held }]);
  useEffect(() => {
    setSamples((prev) => pushQueueSample(prev, now, model.held));
  }, [now, model.held]);
  const spark = sparklinePoints(samples, now, SPARK_W, SPARK_H);
  const sparkWords = sparklineWords(samples);
  return (
    <section className="insp-section" aria-label="Policy">
      <div className="panel-title">Policy</div>
      <dl className="kv">
        <dt>Output policy</dt>
        <dd className="mono">{model.policy ?? 'fair-queue on the interface'}</dd>
        <dt>Scheduling</dt>
        <dd>{model.strategyText}</dd>
        <dt>Reference rate</dt>
        <dd className="mono">{rateText(model.refBps)}</dd>
      </dl>
      <ul style={{ listStyle: 'none', margin: '4px 0', padding: 0 }}>
        {model.classes.map((c) => (
          <li key={c.name} style={{ marginBottom: 6 }}>
            <div>
              {c.badge !== '' && (
                <span className="chip tiny accent" title={c.kindText}>
                  {c.badge}
                </span>
              )}{' '}
              <span className="mono">{c.name}</span> <span className="dim">{c.kindText}</span>
            </div>
            <div
              role="meter"
              aria-label={`${c.name} queue`}
              aria-valuemin={0}
              aria-valuemax={c.limit}
              aria-valuenow={c.depth}
              aria-valuetext={`${c.depth} of ${c.limit} packets held`}
              style={{ height: 6, margin: '2px 0', background: 'var(--border)', borderRadius: 3 }}
            >
              <div
                style={{
                  width: `${Math.round(c.fill * 100)}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: c.fill >= 0.85 ? 'var(--err)' : c.fill >= 0.5 ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
            <div className="dim mono">{c.words}</div>
            <div className="dim mono">offered {rateText(c.offeredBps30s)} over 30 s</div>
          </li>
        ))}
      </ul>
      <div className="dim">Packets held on this port over the last 30 s</div>
      <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={sparkWords}>
        <title>{sparkWords}</title>
        <line x1={0} y1={SPARK_H - 0.5} x2={SPARK_W} y2={SPARK_H - 0.5} stroke="var(--border)" strokeWidth={1} />
        {spark !== '' && <polyline points={spark} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
      </svg>
      <div className="dim mono">{sparkWords}</div>
    </section>
  );
}
