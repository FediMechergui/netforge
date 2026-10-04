/**
 * Desktop "Traffic generator" app (ARCHITECTURE-P3 §5.9 `desktop.traffic`, M13, D16; W3 web-desktop).
 *
 * A form describes one flow — the destination and its UDP port, a rate in packets per second or in kb/s, the packet
 * size, the DSCP marking, and how long it runs (a packet count, a duration, or until stopped, which is at most five
 * minutes) — and two voice presets fill it the way a call would (50 packets per second of 60 or 200 bytes, DSCP 46).
 * Start sends exactly `hostRequest {app: 'traffic.start', flow}` with the form's values; Stop sends
 * `hostRequest {app: 'traffic.stop', id}`. Nothing here talks to the network: the flows list is the sender's `traffic`
 * StateView, and each flow's live delay, jitter and loss are read from the receiving host's `flows` table row (the
 * receiver measures them; key `${src}|${flow}`), so the numbers are what the destination actually saw.
 *
 * The form is checked by the engine's own `planTrafficFlow` before anything is sent, so the app refuses exactly what
 * the daemon would (eight flows per device, 2 Mb/s and 1000 packets per second per flow, five minutes per flow) and
 * says why; a request the daemon still refuses (no route) simply never appears in the list, which the form's note
 * explains. Marks are words and glyphs, never colour alone. Wording is original.
 */
import { useId, useState } from 'react';
import { TRAFFIC_MAX_DURATION_MS, TRAFFIC_VOICE_PRESETS, planTrafficFlow } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, FlowRow, SimSnapshot, TrafficFlowSpec } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { useStore } from '../../store/store';
import { DeviceGone, deviceBusyReason, errorText, processState, useDeviceById } from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

// ── the form ────────────────────────────────────────────────────────────────

/** How the rate is given: packets per second, or kilobits per second. */
export type TrafficRateKind = 'pps' | 'kbps';
/** How long a flow runs: a number of packets, a number of seconds, or until stopped (at most five minutes). */
export type TrafficLength = 'count' | 'duration' | 'continuous';

/** The form, as typed. */
export interface TrafficForm {
  /** Optional flow name; empty = the device picks the lowest free `f<n>`. */
  readonly name: string;
  readonly dst: string;
  readonly dstPort: string;
  readonly rateKind: TrafficRateKind;
  readonly rate: string;
  readonly sizeBytes: string;
  readonly dscp: string;
  readonly length: TrafficLength;
  readonly count: string;
  /** Seconds, up to three decimals. */
  readonly durationS: string;
}

/** A new form: 64 kb/s of 500-byte packets for ten seconds, unmarked, to the discard port. */
export const DEFAULT_TRAFFIC_FORM: TrafficForm = Object.freeze({
  name: '',
  dst: '',
  dstPort: '9',
  rateKind: 'kbps',
  rate: '64',
  sizeBytes: '500',
  dscp: '0',
  length: 'duration',
  count: '100',
  durationS: '10',
});

/** A voice preset's id (the engine's `TrafficFlowSpec.preset`). */
export type TrafficPresetId = NonNullable<TrafficFlowSpec['preset']>;

/** One voice preset of the form, with what it stands for. */
export interface TrafficPreset {
  readonly id: TrafficPresetId;
  readonly label: string;
  readonly pps: number;
  readonly sizeBytes: number;
  readonly dscp: number;
}

const PRESET_LABELS: Readonly<Record<TrafficPresetId, string>> = Object.freeze({
  'voice-g729': 'Voice call, compressed',
  'voice-g711': 'Voice call, uncompressed',
});

/** The voice presets: the engine's `TRAFFIC_VOICE_PRESETS`, read when asked (rule 12), with their labels. */
export function trafficPresets(): readonly TrafficPreset[] {
  return (Object.keys(PRESET_LABELS) as TrafficPresetId[]).map((id) => ({ id, label: PRESET_LABELS[id], ...TRAFFIC_VOICE_PRESETS[id] }));
}

/** The form after a voice preset: its packet rate, size and marking (destination and length are kept). */
export function applyTrafficPreset(form: TrafficForm, preset: TrafficPresetId): TrafficForm {
  const p = trafficPresets().find((x) => x.id === preset);
  if (p === undefined) return form;
  return { ...form, rateKind: 'pps', rate: String(p.pps), sizeBytes: String(p.sizeBytes), dscp: String(p.dscp) };
}

/** A few DSCP values worth knowing by name (the hint under the field). */
export const DSCP_NAMES: readonly (readonly [number, string])[] = Object.freeze([
  [0, 'best effort'],
  [46, 'EF, voice'],
  [34, 'AF41, video'],
  [26, 'AF31'],
  [10, 'AF11'],
  [8, 'CS1, background'],
] as const);

function whole(text: string): number | null {
  const t = text.trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : null;
}

/** Seconds with up to three decimals → whole milliseconds, or null. */
function millis(text: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (m === null) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
}

export type TrafficFormResult =
  | { readonly ok: true; readonly flow: TrafficFlowSpec }
  | { readonly ok: false; readonly field: keyof TrafficForm; readonly error: string };

/** The flow the form describes, field by field (the caps are checked by `checkTrafficFlow`). */
export function trafficFlowOf(form: TrafficForm): TrafficFormResult {
  const no = (field: keyof TrafficForm, error: string): TrafficFormResult => ({ ok: false, field, error });
  const dst = form.dst.trim();
  if (dst === '') return no('dst', 'Enter the address of the device that receives the flow.');
  const dstPort = whole(form.dstPort);
  if (dstPort === null) return no('dstPort', 'The port is a whole number from 1 to 65535.');
  const rate = whole(form.rate);
  if (rate === null || rate === 0) return no('rate', form.rateKind === 'pps' ? 'The packet rate is a whole number of packets per second.' : 'The rate is a whole number of kb/s.');
  const sizeBytes = whole(form.sizeBytes);
  if (sizeBytes === null) return no('sizeBytes', 'The packet size is a whole number of bytes.');
  const dscp = whole(form.dscp);
  if (dscp === null) return no('dscp', 'DSCP is a whole number from 0 to 63.');
  const name = form.name.trim();
  const flow: { -readonly [K in keyof TrafficFlowSpec]: TrafficFlowSpec[K] } = { dst, dstPort, sizeBytes, dscp };
  if (name !== '') flow.id = name;
  if (form.rateKind === 'pps') flow.pps = rate;
  else flow.rateKbps = rate;
  if (form.length === 'count') {
    const count = whole(form.count);
    if (count === null || count === 0) return no('count', 'The packet count is a whole number of at least 1.');
    flow.count = count;
  } else if (form.length === 'duration') {
    const ms = millis(form.durationS);
    if (ms === null || ms === 0) return no('durationS', 'The duration is a number of seconds, for example 10 or 2.5.');
    flow.durationMs = ms;
  }
  return { ok: true, flow };
}

/** The daemon's refusal of `flow` on a device already sending `running` flows, as a sentence (null = accepted). */
export function checkTrafficFlow(flow: TrafficFlowSpec, running: readonly string[], ownAddresses: readonly string[] = []): string | null {
  const plan = planTrafficFlow(flow, new Set(running));
  if (!plan.ok) return plan.error.replace(/^%\s*/, '').replace(/\s*\(flow stop [^)]*\)/, '');
  if (ownAddresses.includes(plan.plan.dst)) return `${plan.plan.dst} is this device; a flow goes to another device.`;
  return null;
}

// ── the sender's flows and the receiver's measurements ──────────────────────

/** One flow of the sender's `traffic` StateView (the daemon's file header). */
export interface SenderFlowView {
  readonly id: string;
  readonly dst: string;
  readonly dstPort: number;
  readonly sizeBytes: number;
  readonly dscp: number;
  readonly paceNs: number;
  readonly mode: 'count' | 'duration' | 'continuous';
  readonly limit: number;
  readonly sent: number;
  readonly errors: number;
  readonly state: 'starting' | 'running' | 'ended' | 'stopped';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The flows a device sends (running ones first, then the last finished ones), from its `traffic` StateView. */
export function senderFlows(device: Pick<DeviceSnapshot, 'processes'>): readonly SenderFlowView[] {
  const rows = processState(device, 'traffic')?.['flows'];
  if (!Array.isArray(rows)) return [];
  const out: SenderFlowView[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const state = str(o['state']);
    const mode = str(o['mode']);
    out.push({
      id: str(o['id']),
      dst: str(o['dst']),
      dstPort: num(o['dstPort']),
      sizeBytes: num(o['sizeBytes']),
      dscp: num(o['dscp']),
      paceNs: num(o['paceNs']),
      mode: mode === 'count' || mode === 'duration' ? mode : 'continuous',
      limit: num(o['limit']),
      sent: num(o['sent']),
      errors: num(o['errors']),
      state: state === 'starting' || state === 'running' || state === 'ended' ? state : 'stopped',
    });
  }
  return out;
}

/** Ids of the flows still sending (what `planTrafficFlow` counts against the per-device cap). */
export function runningFlowIds(flows: readonly SenderFlowView[]): string[] {
  return flows.filter((f) => f.state === 'starting' || f.state === 'running').map((f) => f.id);
}

/** The IPv4 addresses of a device's ports. */
export function ownIpv4Addresses(device: Pick<DeviceSnapshot, 'ports'>): string[] {
  const out: string[] = [];
  for (const p of device.ports) {
    const a = p.l3.ipv4?.address;
    if (a !== undefined) out.push(a);
  }
  return out;
}

/** A receiver's `flows` row and the device that wrote it. */
export interface ReceivedFlow {
  readonly device: string;
  readonly row: FlowRow;
}

function flowRowsOf(device: DeviceSnapshot): FlowRow[] {
  const t = device.tables.extra?.find((x) => x.name === 'flows');
  return t === undefined ? [] : (t.rows as unknown as FlowRow[]);
}

/**
 * The row the receiver keeps for `flow` sent by `sender`: a `flows` row of another device with the flow's name, its
 * destination port and one of the sender's addresses as its source; when none has (the source was translated on the
 * way), the one row with the flow's name, destination and port.
 */
export function receivedFlowOf(snapshot: Pick<SimSnapshot, 'devices'>, sender: DeviceSnapshot, flow: Pick<SenderFlowView, 'id' | 'dst' | 'dstPort'>): ReceivedFlow | undefined {
  const own = new Set(ownIpv4Addresses(sender));
  let loose: ReceivedFlow | undefined;
  let looseCount = 0;
  for (const d of snapshot.devices) {
    if (d.id === sender.id) continue;
    for (const row of flowRowsOf(d)) {
      if (row.flow !== flow.id || row.dstPort !== flow.dstPort) continue;
      if (own.has(row.src)) return { device: d.name, row };
      if (row.dst === flow.dst) {
        loose = { device: d.name, row };
        looseCount++;
      }
    }
  }
  return looseCount === 1 ? loose : undefined;
}

/** `12.3 ms` (two decimals below 10 ms, so a LAN's fractions of a millisecond show). */
export function fmtDelay(ns: number): string {
  const ms = ns / 1_000_000;
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
}

/** What the receiver measured, as text. */
export interface FlowStatsText {
  readonly delay: string;
  readonly jitter: string;
  readonly loss: string;
  /** One sentence with all three (the row's accessible summary). */
  readonly sentence: string;
}

/** The delay, jitter and loss of a receiver's row, in words. */
export function flowStatsText(r: ReceivedFlow): FlowStatsText {
  const row = r.row;
  const delay = row.received === 0 ? 'nothing received yet' : `${fmtDelay(row.delayAvgNs)} average (${fmtDelay(row.delayMinNs)} to ${fmtDelay(row.delayMaxNs)})`;
  const jitter = row.received < 2 ? 'needs two packets' : fmtDelay(row.jitterNs);
  const total = row.received + row.lost;
  const tenths = total === 0 ? 0 : Math.round((row.lost * 1000) / total);
  const loss = row.lost === 0 ? `none (${row.received} received)` : `${row.lost} of ${total} (${Math.floor(tenths / 10)}.${tenths % 10} %)`;
  const end = row.ended ? ' The last packet has arrived.' : row.lost > 0 ? ' Packets lost after the last one received are counted when the flow ends.' : '';
  return { delay, jitter, loss, sentence: `${r.device} measured: delay ${delay}; jitter ${jitter}; loss ${loss}.${end}` };
}

/** The flow's rate in words, from its pacing (`50 packets/s`, `64 kb/s`). */
export function flowRateText(f: Pick<SenderFlowView, 'paceNs' | 'sizeBytes'>): string {
  if (f.paceNs <= 0) return '—';
  const pps = Math.round(1_000_000_000 / f.paceNs);
  const kbps = Math.round((f.sizeBytes * 8 * 1_000_000) / f.paceNs);
  return `${pps} packets/s (${kbps} kb/s)`;
}

const LENGTH_CHOICES: readonly (readonly [TrafficLength, string])[] = Object.freeze([
  ['count', 'a number of packets'],
  ['duration', 'a number of seconds'],
  ['continuous', 'until stopped'],
] as const);

const STATE_TEXT: Readonly<Record<SenderFlowView['state'], string>> = Object.freeze({
  starting: '▶ starting',
  running: '▶ sending',
  ended: '✓ finished',
  stopped: '■ stopped',
});

// ── requests ─────────────────────────────────────────────────────────────────

/** Ask `device` to start `flow` (exactly the form's values); resolves to the ticket's id. */
export async function startTrafficFlow(device: DeviceId, flow: TrafficFlowSpec): Promise<string> {
  const ticket = await engine.hostRequest(device, { app: 'traffic.start', flow });
  return ticket.requestId;
}

/** Ask `device` to stop its flow `id`. */
export async function stopTrafficFlow(device: DeviceId, id: string): Promise<void> {
  await engine.hostRequest(device, { app: 'traffic.stop', id });
}

// ── the app ─────────────────────────────────────────────────────────────────

export function TrafficApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  if (device === undefined) return <DeviceGone />;
  return <TrafficPanel device={device} />;
}

export function TrafficPanel({ device, initialForm = DEFAULT_TRAFFIC_FORM }: { device: DeviceSnapshot; initialForm?: TrafficForm }) {
  const uid = useId();
  const snapshot = useStore((s) => s.snapshot);
  const [form, setForm] = useState<TrafficForm>(initialForm);
  const [problem, setProblem] = useState<{ field: keyof TrafficForm | null; text: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const flows = senderFlows(device);
  const blocked = deviceBusyReason(device);
  const edit = (patch: Partial<TrafficForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
  };
  const errorOf = (field: keyof TrafficForm): string | undefined => (problem !== null && problem.field === field ? problem.text : undefined);

  const start = async (): Promise<void> => {
    setStatus(null);
    const read = trafficFlowOf(form);
    if (!read.ok) {
      setProblem({ field: read.field, text: read.error });
      return;
    }
    const refusal = checkTrafficFlow(read.flow, runningFlowIds(flows), ownIpv4Addresses(device));
    if (refusal !== null) {
      setProblem({ field: null, text: refusal });
      return;
    }
    setSending(true);
    try {
      await startTrafficFlow(device.id, read.flow);
      setStatus(`Asked ${device.name} to start ${read.flow.id === undefined ? 'a flow' : `flow ${read.flow.id}`} to ${read.flow.dst}.`);
    } catch (err) {
      setProblem({ field: null, text: errorText(err) });
    } finally {
      setSending(false);
    }
  };

  const stop = async (id: string): Promise<void> => {
    try {
      await stopTrafficFlow(device.id, id);
      setStatus(`Asked ${device.name} to stop flow ${id}.`);
    } catch (err) {
      setProblem({ field: null, text: errorText(err) });
    }
  };

  const field = (key: keyof TrafficForm, label: string, hint?: string) => {
    const error = errorOf(key);
    const id = `${uid}-${key}`;
    const described = [error !== undefined ? `${id}-err` : '', hint !== undefined ? `${id}-hint` : ''].filter((x) => x !== '').join(' ');
    return (
      <div className={`desk-field ${error !== undefined ? 'has-error' : ''}`}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="input desk-mono"
          value={form[key]}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== undefined}
          aria-describedby={described === '' ? undefined : described}
          onChange={(e) => edit({ [key]: e.target.value } as Partial<TrafficForm>)}
        />
        {hint !== undefined && (
          <span id={`${id}-hint`} className="desk-hint">
            {hint}
          </span>
        )}
        {error !== undefined && (
          <span id={`${id}-err`} className="desk-error">
            <span aria-hidden="true">⚠ </span>
            {error}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="desk-app">
      <form
        className="desk-form"
        aria-labelledby={`${uid}-title`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!sending && blocked === undefined) void start();
        }}
      >
        <h3 id={`${uid}-title`} className="desk-heading">
          New flow
        </h3>
        <div className="desk-actions" role="group" aria-label="Presets">
          {trafficPresets().map((p) => (
            <button key={p.id} type="button" className="btn" onClick={() => edit(applyTrafficPreset(form, p.id))} title={`${p.pps} packets per second of ${p.sizeBytes} bytes, DSCP ${p.dscp}`}>
              {p.label} ({p.pps} pps × {p.sizeBytes} B, DSCP {p.dscp})
            </button>
          ))}
        </div>
        {field('dst', 'Destination address')}
        {field('dstPort', 'UDP port', 'Port 9 (discard) is the receiver of a test flow on any host.')}
        <fieldset className="desk-field">
          <legend>Rate given as</legend>
          <input id={`${uid}-rk-pps`} type="radio" name={`${uid}-rk`} checked={form.rateKind === 'pps'} onChange={() => edit({ rateKind: 'pps' })} />
          <label htmlFor={`${uid}-rk-pps`}> packets per second</label>{' '}
          <input id={`${uid}-rk-kbps`} type="radio" name={`${uid}-rk`} checked={form.rateKind === 'kbps'} onChange={() => edit({ rateKind: 'kbps' })} />
          <label htmlFor={`${uid}-rk-kbps`}> kb/s</label>
        </fieldset>
        {field('rate', form.rateKind === 'pps' ? 'Packets per second' : 'Rate (kb/s)', 'At most 2000 kb/s and 1000 packets per second.')}
        {field('sizeBytes', 'Packet size (bytes)', 'The whole IP packet: 60 to 1500 bytes.')}
        {field('dscp', 'DSCP marking', DSCP_NAMES.map(([v, n]) => `${v} = ${n}`).join('; '))}
        <fieldset className="desk-field">
          <legend>Runs for</legend>
          {LENGTH_CHOICES.map(([value, text]) => (
            <span key={value}>
              <input id={`${uid}-len-${value}`} type="radio" name={`${uid}-len`} checked={form.length === value} onChange={() => edit({ length: value })} />
              <label htmlFor={`${uid}-len-${value}`}> {text}</label>{' '}
            </span>
          ))}
        </fieldset>
        {form.length === 'count' && field('count', 'Packets')}
        {form.length === 'duration' && field('durationS', 'Seconds')}
        {form.length === 'continuous' && <p className="desk-note">“Until stopped” stops by itself after {TRAFFIC_MAX_DURATION_MS / 60_000} minutes of simulated time.</p>}
        {field('name', 'Flow name (optional)', 'Letters, digits, - or _. Empty: the device names it f1, f2, …')}
        {blocked !== undefined && <p className="desk-note">{blocked}</p>}
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary" disabled={sending || blocked !== undefined}>
            {sending ? 'Asking…' : 'Start'}
          </button>
        </div>
        {problem !== null && problem.field === null && (
          <p className="desk-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {problem.text}
          </p>
        )}
        {status !== null && (
          <p className="desk-status is-ok" role="status">
            <span aria-hidden="true">✓ </span>
            {status}
          </p>
        )}
        <p className="desk-sub">A flow the device cannot send (no route to its destination) does not appear in the list below.</p>
      </form>

      <section aria-labelledby={`${uid}-flows`}>
        <h3 id={`${uid}-flows`} className="desk-heading">
          Flows from {device.name}
        </h3>
        {flows.length === 0 ? (
          <p className="desk-empty">No flow has been started yet.</p>
        ) : (
          <table className="desk-table">
            <thead>
              <tr>
                <th scope="col">Flow</th>
                <th scope="col">To</th>
                <th scope="col">Rate</th>
                <th scope="col">Sent</th>
                <th scope="col">State</th>
                <th scope="col">Delay</th>
                <th scope="col">Jitter</th>
                <th scope="col">Loss</th>
                <th scope="col" aria-label="Stop" />
              </tr>
            </thead>
            <tbody>
              {flows.map((f, i) => {
                const rx = snapshot === null ? undefined : receivedFlowOf(snapshot, device, f);
                const stats = rx === undefined ? undefined : flowStatsText(rx);
                const live = f.state === 'starting' || f.state === 'running';
                return (
                  <tr key={`${f.id}-${i}`} aria-label={stats?.sentence}>
                    <th scope="row" className="desk-mono">
                      {f.id}
                    </th>
                    <td className="desk-mono">
                      {f.dst}:{f.dstPort} <span className="desk-sub">DSCP {f.dscp}</span>
                    </td>
                    <td>{flowRateText(f)}</td>
                    <td className="desk-mono">
                      {f.sent} of {f.limit}
                      {f.errors > 0 && <span className="desk-sub"> ({f.errors} not sent)</span>}
                    </td>
                    <td>{STATE_TEXT[f.state]}</td>
                    <td>{stats?.delay ?? 'no report yet'}</td>
                    <td>{stats?.jitter ?? '—'}</td>
                    <td>{stats?.loss ?? '—'}</td>
                    <td>
                      {live && (
                        <button type="button" className="btn" aria-label={`Stop flow ${f.id}`} onClick={() => void stop(f.id)}>
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="desk-sub">Delay, jitter and loss are measured by the receiving device and refreshed about once a second.</p>
      </section>
    </div>
  );
}
