/**
 * State-machine history strip [SHOULD S14] (ARCHITECTURE-P2 D19, §6 "State-machine history strip for the selected
 * port/group", spec §9.5 "a history strip of past transitions with timestamps"; §7 W6 web-inspector).
 *
 * Every P2 state machine reports a transition as ONE `debug` trace event whose `DebugEvent.fsm` carries `{machine,
 * subject, from, to, cause?, pdu?}` (D19). This strip reads those events from the trace the store keeps (`events`;
 * while the timeline reviews the past, only the events up to the reviewed instant), keeps the ones of the selected
 * device — and, for a port, the transitions whose `fsm.port` is that port or whose subject names it (so a
 * Port-channel shows its members) — and groups them per machine and subject.
 *
 * For each subject it shows the current state, a small step drawing of the states visited (laid out by
 * `fsmStateIndex`, vocab/fsm.ts; decorative, hidden from assistive technology) and its text form: an ordered list of
 * the transitions, oldest first, each "time: from → to — cause". The list is one tab stop with arrow-key, Home and End
 * navigation; Enter on a transition that a packet triggered selects that packet in the inspector. Nothing here
 * branches on the device kind; all wording is original (§1.6).
 */
import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { formatSimTime } from '@netforge/engine';
import type { DeviceId, FsmMachine, PduId, PortId, SimTime, TraceEvent } from '@netforge/engine';
import { store, useStore } from '../store/store';
import { FSM_MACHINES, fsmLabel, fsmStateIndex, isFsmMachine, FSM_VOCAB } from '../vocab/fsm';

// ── model ────────────────────────────────────────────────────────────────────

/** One transition of the strip. */
export interface FsmHistoryEntry {
  readonly t: SimTime;
  readonly from: string;
  readonly to: string;
  /** Original-wording reason, when the machine gave one. */
  readonly cause?: string;
  /** The packet that triggered the transition, when one did. */
  readonly pdu?: PduId;
}

/** The transitions of one machine and subject, oldest first. */
export interface FsmSubjectHistory {
  readonly machine: string;
  readonly subject: string;
  readonly device: DeviceId;
  readonly port?: PortId;
  readonly instance?: number;
  /** The newest `limit` transitions, oldest first. */
  readonly entries: readonly FsmHistoryEntry[];
  /** Transitions older than `entries` that were left out. */
  readonly omitted: number;
  /**
   * The current state: the newest `to` that the machine's vocabulary lists as a state (a spanning-tree port also
   * reports role changes under its subject), else the newest `to`.
   */
  readonly current: string;
}

/** Which transitions the strip shows. */
export interface FsmHistoryFilter {
  readonly device: DeviceId;
  /** Only transitions about this port: `fsm.port` equals it, or the subject names it (a bundle names its members). */
  readonly port?: PortId;
  /** Only these machines. */
  readonly machines?: readonly string[];
  /** Only transitions at or before this time (the reviewed instant). */
  readonly until?: SimTime;
  /** Transitions kept per subject, newest first (default `FSM_STRIP_LIMIT`). */
  readonly limit?: number;
}

/** Transitions shown per subject by default. */
export const FSM_STRIP_LIMIT = 20;

function aboutPort(subject: string, fsmPort: PortId | undefined, port: PortId): boolean {
  return fsmPort === port || subject.split(' ').includes(port);
}

function machineRank(machine: string): number {
  const i = isFsmMachine(machine) ? FSM_MACHINES.indexOf(machine) : -1;
  return i < 0 ? FSM_MACHINES.length : i;
}

/**
 * Group the state-machine transitions of `events` that match `filter`, per machine and subject. Subjects come in
 * machine display order (vocab/fsm.ts), then by subject text; entries are in time order (trace order within one
 * instant). Pure.
 */
export function fsmHistory(events: readonly TraceEvent[], filter: FsmHistoryFilter): readonly FsmSubjectHistory[] {
  const limit = Math.max(1, filter.limit ?? FSM_STRIP_LIMIT);
  const groups = new Map<string, { machine: string; subject: string; port?: PortId; instance?: number; entries: (FsmHistoryEntry & { seq: number })[] }>();
  events.forEach((ev, seq) => {
    if (ev.kind !== 'debug') return;
    const fsm = ev.event.fsm;
    if (fsm === undefined || ev.event.device !== filter.device) return;
    if (filter.until !== undefined && ev.t > filter.until) return;
    if (filter.machines !== undefined && !filter.machines.includes(fsm.machine)) return;
    if (filter.port !== undefined && !aboutPort(fsm.subject, fsm.port, filter.port)) return;
    const key = `${fsm.machine}\u0000${fsm.subject}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { machine: fsm.machine, subject: fsm.subject, entries: [] };
      if (fsm.port !== undefined) g.port = fsm.port;
      if (fsm.instance !== undefined) g.instance = fsm.instance;
      groups.set(key, g);
    }
    g.entries.push({
      t: ev.t,
      from: fsm.from,
      to: fsm.to,
      ...(fsm.cause !== undefined ? { cause: fsm.cause } : {}),
      ...(fsm.pdu !== undefined ? { pdu: fsm.pdu } : {}),
      seq,
    });
  });
  const out: FsmSubjectHistory[] = [];
  for (const g of groups.values()) {
    const sorted = [...g.entries].sort((a, b) => a.t - b.t || a.seq - b.seq);
    const kept = sorted.slice(-limit).map(({ seq: _seq, ...e }) => Object.freeze(e));
    // A machine may report other changes under the same subject (a spanning-tree port also reports its role): the
    // current STATE is the newest `to` its vocabulary lists, else simply the newest `to`.
    const known = [...sorted].reverse().find((e) => fsmStateIndex(g.machine, e.to) >= 0);
    out.push(
      Object.freeze({
        machine: g.machine,
        subject: g.subject,
        device: filter.device,
        ...(g.port !== undefined ? { port: g.port } : {}),
        ...(g.instance !== undefined ? { instance: g.instance } : {}),
        entries: Object.freeze(kept),
        omitted: sorted.length - kept.length,
        current: (known ?? (sorted[sorted.length - 1] as FsmHistoryEntry)).to,
      }),
    );
  }
  return out.sort((a, b) => machineRank(a.machine) - machineRank(b.machine) || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}

/** The text form of one transition: "00:00:30.000000: listening → learning (forward delay expired)". */
export function fsmEntryText(entry: FsmHistoryEntry): string {
  return `${formatSimTime(entry.t)}: ${entry.from} → ${entry.to}${entry.cause !== undefined && entry.cause !== '' ? ` (${entry.cause})` : ''}`;
}

/** The spoken form of one transition (the list item's accessible name). */
export function fsmEntrySpoken(entry: FsmHistoryEntry): string {
  const cause = entry.cause !== undefined && entry.cause !== '' ? `, because ${entry.cause}` : '';
  const pdu = entry.pdu !== undefined ? `; press Enter to show packet ${entry.pdu}, which caused it` : '';
  return `At ${formatSimTime(entry.t)}, from ${entry.from} to ${entry.to}${cause}${pdu}`;
}

/** A one-line summary of a subject: "Spanning-tree port VLAN0010 Gi0/1: now forwarding after 3 changes". */
export function fsmSubjectSummary(h: FsmSubjectHistory): string {
  const n = h.entries.length + h.omitted;
  return `${fsmLabel(h.machine)} ${h.subject}: now ${h.current} after ${n} change${n === 1 ? '' : 's'}`;
}

/**
 * Levels of the step drawing: the state visited first (the first transition's `from`) and each `to`, as the state's
 * position in its machine's list. A state the vocabulary does not list is drawn one level above the known states.
 */
export function fsmStepLevels(h: Pick<FsmSubjectHistory, 'machine' | 'entries'>): readonly number[] {
  const known = isFsmMachine(h.machine) ? FSM_VOCAB[h.machine as FsmMachine].states.length : 0;
  const level = (state: string): number => {
    const i = fsmStateIndex(h.machine, state);
    return i < 0 ? known : i;
  };
  const first = h.entries[0];
  if (first === undefined) return [];
  return [level(first.from), ...h.entries.map((e) => level(e.to))];
}

// ── components ───────────────────────────────────────────────────────────────

const STEP_W = 18;
const LEVEL_H = 6;

/** Decorative step drawing of the states visited (its facts are all in the list next to it). */
function StepDrawing({ levels }: { levels: readonly number[] }) {
  if (levels.length < 2) return null;
  const top = Math.max(...levels);
  const h = (top + 1) * LEVEL_H + 4;
  const w = levels.length * STEP_W;
  const y = (lv: number): number => h - 2 - lv * LEVEL_H - LEVEL_H / 2;
  let d = `M 0 ${y(levels[0] as number)}`;
  levels.forEach((lv, i) => {
    if (i > 0) d += ` V ${y(lv)}`;
    d += ` H ${(i + 1) * STEP_W}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false" style={{ display: 'block', margin: '2px 0' }}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {levels.map((lv, i) => (
        <circle key={i} cx={i * STEP_W + 2} cy={y(lv)} r={2} fill="currentColor" />
      ))}
    </svg>
  );
}

function selectPacket(pdu: PduId): void {
  store.getState().select({ kind: 'pdu', id: pdu });
}

/** One subject: heading, drawing and the keyboard-navigable list of transitions. */
function SubjectStrip({ history }: { history: FsmSubjectHistory }) {
  const { entries } = history;
  const [active, setActive] = useState(entries.length - 1);
  const at = Math.min(Math.max(0, active), entries.length - 1);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLOListElement>): void => {
      const n = entries.length;
      let next: number | undefined;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(n - 1, at + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(0, at - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        const pdu = entries[at]?.pdu;
        if (pdu !== undefined) {
          e.preventDefault();
          selectPacket(pdu);
        }
        return;
      }
      if (next === undefined) return;
      e.preventDefault();
      setActive(next);
      const items = e.currentTarget.querySelectorAll<HTMLLIElement>('li[data-fsm-entry]');
      items[next]?.focus();
    },
    [entries, at],
  );

  const label = fsmLabel(history.machine);
  return (
    <section className="insp-section fsm-strip" aria-label={`${label} ${history.subject}`}>
      <div className="panel-title">
        {label} <span className="mono">{history.subject}</span>
      </div>
      <div className="insp-note">
        Now <strong>{history.current}</strong>
        {history.omitted > 0 && <span className="dim"> · {history.omitted} earlier change{history.omitted === 1 ? '' : 's'} not shown</span>}
      </div>
      <StepDrawing levels={fsmStepLevels(history)} />
      <ol className="fsm-strip-list" aria-label={`State changes of ${label} ${history.subject}, oldest first`} onKeyDown={onKey} style={{ margin: 0, paddingLeft: 18 }}>
        {entries.map((e, i) => (
          <li
            key={`${e.t}:${i}`}
            data-fsm-entry=""
            tabIndex={i === at ? 0 : -1}
            aria-current={i === entries.length - 1 ? 'step' : undefined}
            onFocus={() => setActive(i)}
            aria-label={fsmEntrySpoken(e)}
            className="mono"
          >
            {formatSimTime(e.t)}: {e.from} → {e.to}
            {e.cause !== undefined && e.cause !== '' && <span className="dim"> ({e.cause})</span>}
            {e.pdu !== undefined && (
              <>
                {' '}
                <button type="button" className="link-btn" tabIndex={-1} onClick={() => selectPacket(e.pdu as PduId)} aria-label={`Show packet ${e.pdu}, which caused this change`}>
                  packet #{e.pdu}
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The state-machine history of a device, or of one port or bundle of it. `events` defaults to the store's trace ring
 * (cut at the reviewed instant while the timeline reviews the past); `machines` narrows the machines shown.
 * `hideWhenEmpty` renders nothing when no transition matches (for embedding in other sections).
 */
export function FsmStrip({
  device,
  port,
  machines,
  events,
  hideWhenEmpty = false,
  limit,
}: {
  device: DeviceId;
  port?: PortId;
  machines?: readonly FsmMachine[];
  events?: readonly TraceEvent[];
  hideWhenEmpty?: boolean;
  limit?: number;
}) {
  const ring = useStore((s) => s.events);
  const reviewAt = useStore((s) => s.timeline.review?.t);
  const source = events ?? ring;
  const machineKey = machines?.join(',') ?? '';
  const histories = useMemo(
    () =>
      fsmHistory(source, {
        device,
        ...(port !== undefined ? { port } : {}),
        ...(machineKey !== '' ? { machines: machineKey.split(',') } : {}),
        ...(events === undefined && reviewAt !== undefined ? { until: reviewAt } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    [source, device, port, machineKey, events, reviewAt, limit],
  );

  if (histories.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <section className="insp-section" aria-label="State changes">
        <div className="panel-title">State changes</div>
        <div className="insp-note">
          No protocol state change {port !== undefined ? 'of this port ' : ''}is in the recent trace. Spanning tree, trunk
          negotiation, bundles, port security and controller joins report theirs here as they happen.
        </div>
      </section>
    );
  }
  return (
    <div className="fsm-strips" aria-label="State changes">
      {histories.map((h) => (
        <SubjectStrip key={`${h.machine}\u0000${h.subject}`} history={h} />
      ))}
    </div>
  );
}
