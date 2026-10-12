/**
 * automation/workspace-model.ts — [S32] what the automation workspace reads and asks (ARCHITECTURE-P3 §6 "Automation
 * workspace", §3.8 step 8, D21; §7 W6 web-desktop). Pure readers of one host's snapshot, plus the few calls the
 * workspace makes through the bridge.
 *
 * Reads (display only; the grader reads the table, rule 20):
 *  - the host's files: `DeviceSnapshot.storage` (`files:`, path order) — names, sizes and times only; a file's text is
 *    read when it is opened, from `exportTopology()`'s `TopologyDevice.files` (the one bridge call that carries it);
 *  - the runs: the script host's StateView (`ScriptHostStateView`: every active run and the last finished ones, with
 *    their output, failure and request list, and the refused starts) and the `script-runs` table (one row per run,
 *    written at its start and its end: the history, kept longer than the StateView keeps output);
 *  - each request's NetScope display filter (its server's address and TCP port), so the "Requests" list links to
 *    the packets that carried it.
 *
 * Asks (each one `hostRequest`, so each is journaled and replayed like any GUI action): `file.write` / `file.delete`
 * (the script host turns them into the `storage` action), `script.run` (the ticket is the run's token, which is how the
 * workspace finds its run in the StateView) and `script.stop` (the run's token).
 *
 * Nothing here branches on device kind: a device shows the workspace when its `gui` lists `desktop.automation`
 * (the `programmable` capability). Wording is original.
 */
import { MAX_TOPOLOGY_FILE_CHARS, MAX_TOPOLOGY_FILE_NAME_CHARS, MAX_TOPOLOGY_FILES_PER_DEVICE, SCRIPT_HOST_NAME, isTopologyFileName } from '@netforge/engine';
import type {
  DeviceId,
  DeviceSnapshot,
  ScriptFailureView,
  ScriptHostStateView,
  ScriptRefusalView,
  ScriptRequestView,
  ScriptRunRow,
  ScriptRunView,
  SimTime,
  StoredFileMeta,
  Topology,
} from '@netforge/engine';
import { engine } from '../bridge/client';
import { showDockTab } from '../shared/openDeviceSurface';
import { store } from '../store/store';

// ── files ────────────────────────────────────────────────────────────────────

/** The files of a host's `files:` store, as the snapshot lists them (path order; empty when it keeps none). */
export function hostFiles(device: Pick<DeviceSnapshot, 'storage'>): readonly StoredFileMeta[] {
  const view = device.storage?.find((s) => s.fs === 'files');
  return view === undefined ? [] : [...view.files];
}

/** The text of `path` on `device` in an exported topology, if it holds that file. */
export function fileContentOf(topology: Pick<Topology, 'devices'>, device: DeviceId, path: string): string | undefined {
  const d = topology.devices.find((x) => x.id === device);
  return d?.files?.find((f) => f.path === path)?.content;
}

/** `0 bytes`, `1 byte`, `512 bytes`, `1.2 kB`, `3.4 MB` (a file's size as the list shows it). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 1) return '1 byte';
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${(Math.round(n / 100) / 10).toString()} kB`;
  return `${(Math.round(n / 100_000) / 10).toString()} MB`;
}

/**
 * Why `raw` cannot name a file of the store, or undefined when it can: the store's own rule (a plain name, no folders,
 * no control characters, at most MAX_TOPOLOGY_FILE_NAME_CHARS characters); when `creating`, also a name already used
 * and a full store.
 */
export function fileNameProblem(raw: string, files: readonly Pick<StoredFileMeta, 'path'>[], creating: boolean): string | undefined {
  const name = raw.trim();
  if (name === '') return 'Give the file a name, for example inventory.py.';
  if (name.length > MAX_TOPOLOGY_FILE_NAME_CHARS) return `A file name has at most ${MAX_TOPOLOGY_FILE_NAME_CHARS} characters.`;
  if (!isTopologyFileName(name)) return 'A file name is one plain name: no folders ("/" or "\\"), no control characters, and not "." or "..".';
  if (creating && files.some((f) => f.path === name)) return `${name} already exists. Pick it in the list to open it.`;
  if (creating && files.length >= MAX_TOPOLOGY_FILES_PER_DEVICE) return `This host already keeps ${MAX_TOPOLOGY_FILES_PER_DEVICE} files. Delete one first.`;
  return undefined;
}

/** Why `content` cannot be saved, or undefined when it can (the store's size limit). */
export function contentProblem(content: string): string | undefined {
  return content.length > MAX_TOPOLOGY_FILE_CHARS ? `A file holds at most ${MAX_TOPOLOGY_FILE_CHARS} characters; this one has ${content.length}.` : undefined;
}

/** The text a new file starts with. */
export function newScriptText(name: string): string {
  return `# ${name.trim()}\n`;
}

/**
 * The arguments typed for a run (`sys.argv[1:]`), split as the host shell splits a line: at spaces, with double
 * quotes grouping words (no escapes; an unclosed quote takes the rest of the line).
 */
export function parseScriptArgs(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    if (i >= text.length) break;
    let word = '';
    let quoted = false;
    while (i < text.length && (quoted || !/\s/.test(text[i] as string))) {
      const c = text[i] as string;
      if (c === '"') quoted = !quoted;
      else word += c;
      i++;
    }
    out.push(word);
  }
  return out;
}

// ── the script host ──────────────────────────────────────────────────────────

/** The script host's process name (`script-host`). */
export const AUTOMATION_PROCESS = SCRIPT_HOST_NAME;

/** Whether the device runs the script host (a programmable host that is on). */
export function runsScriptHost(device: Pick<DeviceSnapshot, 'processes'>): boolean {
  return device.processes.some((p) => p.process === AUTOMATION_PROCESS);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const RUN_STATES: readonly ScriptRunRow['state'][] = ['running', 'completed', 'failed', 'stopped'];
const REQUEST_STATES: readonly ScriptRequestView['state'][] = ['pending', 'done', 'failed', 'abandoned'];

function asRequest(v: unknown): ScriptRequestView | undefined {
  const o = obj(v);
  if (o === undefined) return undefined;
  const state = REQUEST_STATES.find((s) => s === o['state']) ?? 'failed';
  const q: { -readonly [K in keyof ScriptRequestView]: ScriptRequestView[K] } = {
    n: num(o['n']),
    method: (str(o['method']) || 'GET') as ScriptRequestView['method'],
    url: str(o['url']),
    state,
    startedAt: num(o['startedAt']),
  };
  const endedAt = optNum(o['endedAt']);
  if (endedAt !== undefined) q.endedAt = endedAt;
  const status = optNum(o['status']);
  if (status !== undefined) q.status = status;
  const reason = optStr(o['reason']);
  if (reason !== undefined) q.reason = reason;
  const error = optStr(o['error']);
  if (error !== undefined) q.error = error;
  return q;
}

function asFailure(v: unknown): ScriptFailureView | undefined {
  const o = obj(v);
  if (o === undefined) return undefined;
  const f: { -readonly [K in keyof ScriptFailureView]: ScriptFailureView[K] } = {
    type: str(o['type']),
    message: str(o['message']),
    traceback: str(o['traceback']),
    last: str(o['last']),
  };
  const line = optNum(o['line']);
  if (line !== undefined) f.line = line;
  return f;
}

function asRun(v: unknown): ScriptRunView | undefined {
  const o = obj(v);
  if (o === undefined || str(o['run']) === '') return undefined;
  const r: { -readonly [K in keyof ScriptRunView]: ScriptRunView[K] } = {
    run: str(o['run']),
    token: str(o['token']),
    file: str(o['file']),
    argv: list(o['argv']).map((a) => String(a)),
    state: RUN_STATES.find((s) => s === o['state']) ?? 'failed',
    startedAt: num(o['startedAt']),
    output: str(o['output']),
    steps: num(o['steps']),
    slices: num(o['slices']),
    sleptNs: num(o['sleptNs']),
    requests: list(o['requests']).flatMap((q) => asRequest(q) ?? []),
  };
  const endedAt = optNum(o['endedAt']);
  if (endedAt !== undefined) r.endedAt = endedAt;
  if (o['waiting'] === 'sleep' || o['waiting'] === 'http') r.waiting = o['waiting'];
  const error = asFailure(o['error']);
  if (error !== undefined) r.error = error;
  return r;
}

/** The script host's StateView of a device (normalised; undefined when the device does not run it). */
export function scriptHostView(device: Pick<DeviceSnapshot, 'processes'>): ScriptHostStateView | undefined {
  const state = device.processes.find((p) => p.process === AUTOMATION_PROCESS)?.state;
  if (state === undefined) return undefined;
  return {
    runs: list(state['runs']).flatMap((r) => asRun(r) ?? []),
    refused: list(state['refused']).flatMap((x): ScriptRefusalView[] => {
      const o = obj(x);
      return o === undefined ? [] : [{ token: str(o['token']), file: str(o['file']), reason: str(o['reason']), at: num(o['at']) }];
    }),
    started: num(state['started']),
    completed: num(state['completed']),
    failed: num(state['failed']),
    stopped: num(state['stopped']),
  };
}

/** The number of a run id (`r12` → 12; anything else → 0). */
export function runNumber(id: string): number {
  const m = /^r(\d+)$/.exec(id);
  return m === null ? 0 : Number(m[1]);
}

/** The `script-runs` rows of a device, newest run first. */
export function scriptRunRows(device: Pick<DeviceSnapshot, 'tables'>): ScriptRunRow[] {
  const t = device.tables.extra?.find((x) => x.name === 'script-runs');
  if (t === undefined) return [];
  const rows = (t.rows as unknown as ScriptRunRow[]).filter((r) => typeof r.run === 'string');
  return rows.sort((a, b) => runNumber(b.run) - runNumber(a.run) || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
}

/** Which run the workspace shows. */
export interface RunChoice {
  /** A run picked in the history (its id). */
  readonly run?: string | null;
  /** The token of the run started from this window (the `script.run` ticket). */
  readonly token?: string | null;
  /** The open file: its newest run. */
  readonly file?: string | null;
}

/** The run to show: the picked one, else the one started from this window, else the open file's newest run. */
export function chooseRun(view: Pick<ScriptHostStateView, 'runs'> | undefined, choice: RunChoice): ScriptRunView | undefined {
  if (view === undefined) return undefined;
  const last = (pred: (r: ScriptRunView) => boolean): ScriptRunView | undefined => {
    for (let i = view.runs.length - 1; i >= 0; i--) {
      const r = view.runs[i] as ScriptRunView;
      if (pred(r)) return r;
    }
    return undefined;
  };
  if (choice.run !== undefined && choice.run !== null) return last((r) => r.run === choice.run);
  if (choice.token !== undefined && choice.token !== null) return last((r) => r.token === choice.token);
  if (choice.file !== undefined && choice.file !== null) return last((r) => r.file === choice.file);
  return undefined;
}

/** The refusal of the start whose token is `token`, if the script host refused it. */
export function refusalOf(view: Pick<ScriptHostStateView, 'refused'> | undefined, token: string | null | undefined): ScriptRefusalView | undefined {
  if (view === undefined || token === undefined || token === null) return undefined;
  for (let i = view.refused.length - 1; i >= 0; i--) if (view.refused[i]?.token === token) return view.refused[i];
  return undefined;
}

/** A run's state as a glyph and a word (never colour alone). */
export function runStateText(state: ScriptRunRow['state']): { readonly glyph: string; readonly word: string; readonly text: string } {
  const glyph = state === 'running' ? '▶' : state === 'completed' ? '✓' : state === 'failed' ? '✕' : '■';
  return { glyph, word: state, text: `${glyph} ${state}` };
}

/** A sim time as seconds with milliseconds (`100.250 s`). */
export function fmtSimSeconds(ns: SimTime): string {
  const t = Math.max(0, Math.floor(ns));
  const s = Math.floor(t / 1_000_000_000);
  const ms = Math.floor(t / 1_000_000) % 1000;
  return `${s}.${ms.toString().padStart(3, '0')} s`;
}

/** How long something took (`under 1 ms`, `12 ms`, `1.234 s`). */
export function fmtTook(ns: number): string {
  if (!Number.isFinite(ns) || ns < 1_000_000) return 'under 1 ms';
  if (ns < 1_000_000_000) return `${Math.floor(ns / 1_000_000)} ms`;
  return fmtSimSeconds(ns);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The one sentence the live region says about a run (changes only when its state does). */
export function runHeadline(run: Pick<ScriptRunView, 'run' | 'file' | 'state'>): string {
  return `Run ${run.run} of ${run.file}: ${runStateText(run.state).text}.`;
}

/** The details of a run in words: when it started and ended, what it waits for, its requests. */
export function runDetails(run: ScriptRunView): string {
  const parts = [`started at ${fmtSimSeconds(run.startedAt)}`];
  if (run.argv.length > 0) parts.push(`with ${run.argv.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  if (run.endedAt !== undefined) parts.push(`ended at ${fmtSimSeconds(run.endedAt)}, ${fmtTook(run.endedAt - run.startedAt)} after it started`);
  else if (run.waiting === 'http') parts.push(`waiting for the answer to request ${run.requests.length}`);
  else if (run.waiting === 'sleep') parts.push('sleeping');
  parts.push(plural(run.requests.length, 'request', 'requests'));
  return `${parts.join(', ')}.`;
}

/** Words for a transport failure code of a request. */
const REQUEST_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  'bad-url': 'the address is not a valid URL',
  timeout: 'no answer in time',
  refused: 'the server refused the connection',
  reset: 'the connection was reset',
  'no-route': 'no route to the server',
  'no-address': 'this host has no IP address',
  'host-unreachable': 'the server could not be reached',
  'net-unreachable': 'the server’s network could not be reached',
  'port-unreachable': 'nothing listens on that port',
  'proto-unreachable': 'the server does not accept that protocol',
  'ttl-exceeded': 'the packets went round in circles (time to live exceeded)',
});

/** A request's outcome as a glyph and words. */
export function requestResultText(q: Pick<ScriptRequestView, 'state' | 'status' | 'reason' | 'error'>): { readonly glyph: string; readonly text: string } {
  switch (q.state) {
    case 'pending':
      return { glyph: '…', text: 'waiting for the answer' };
    case 'done': {
      const status = q.status ?? 0;
      const words = q.reason !== undefined && q.reason !== '' ? `${status} ${q.reason}` : `${status}`;
      return status >= 400 ? { glyph: '⚠', text: words } : { glyph: '✓', text: words };
    }
    case 'failed': {
      const code = q.error ?? 'no answer';
      const words = REQUEST_ERRORS[code];
      return { glyph: '✕', text: words === undefined ? `failed (${code})` : `failed: ${words}` };
    }
    case 'abandoned':
      return { glyph: '■', text: 'abandoned: the run was stopped first' };
  }
}

/** How long a request took, once it ended. */
export function requestTook(q: Pick<ScriptRequestView, 'startedAt' | 'endedAt'>): string | undefined {
  return q.endedAt === undefined ? undefined : fmtTook(q.endedAt - q.startedAt);
}

/** The parts of a request's URL the capture filter needs. */
export interface RequestTarget {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  /** The path and query (`/` when none). */
  readonly path: string;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The scheme, host, port (default 80 / 443) and path of an `http:` or `https:` URL, else undefined. */
export function parseRequestUrl(url: string): RequestTarget | undefined {
  const m = /^(https?):\/\/([^/:?#\s[\]]+)(?::(\d{1,5}))?([/?#]\S*)?$/i.exec(url.trim());
  if (m === null) return undefined;
  const scheme = (m[1] as string).toLowerCase() as 'http' | 'https';
  const port = m[3] === undefined ? (scheme === 'https' ? 443 : 80) : Number(m[3]);
  if (port < 1 || port > 65535) return undefined;
  const rest = m[4] ?? '/';
  return { scheme, host: (m[2] as string).toLowerCase(), port, path: rest.startsWith('/') ? rest : `/${rest}` };
}

/**
 * The NetScope display filter that shows the packets of a request: the conversation with its server
 * (`ip.addr == 10.0.99.11 && tcp.port == 443`), or, for a server given by name, the HTTP messages whose Host header
 * names it on that port. Undefined for a URL that is not http(s).
 */
export function requestCaptureFilter(url: string): string | undefined {
  const t = parseRequestUrl(url);
  if (t === undefined) return undefined;
  if (IPV4.test(t.host)) return `ip.addr == ${t.host} && tcp.port == ${t.port}`;
  if (!/^[a-z0-9.-]+$/.test(t.host)) return undefined;
  return `tcp.port == ${t.port} && http.host contains "${t.host}"`;
}

// ── asks (through the bridge) ────────────────────────────────────────────────

/** The text of `path` on `device`, read from an export of the world (undefined when the file is gone). */
export async function loadHostFile(device: DeviceId, path: string): Promise<string | undefined> {
  return fileContentOf(await engine.exportTopology(), device, path);
}

/** Save `content` as `path` on `device` (`hostRequest file.write`). */
export async function saveHostFile(device: DeviceId, path: string, content: string): Promise<void> {
  await engine.hostRequest(device, { app: 'file.write', path, content });
}

/** Delete `path` on `device` (`hostRequest file.delete`). */
export async function deleteHostFile(device: DeviceId, path: string): Promise<void> {
  await engine.hostRequest(device, { app: 'file.delete', path });
}

/** Run `file` on `device` with `argv` (`hostRequest script.run`); resolves to the run's token (the ticket). */
export async function runHostScript(device: DeviceId, file: string, argv: readonly string[] = []): Promise<string> {
  const ticket = await engine.hostRequest(device, argv.length > 0 ? { app: 'script.run', file, argv: [...argv] } : { app: 'script.run', file });
  return ticket.requestId;
}

/** Stop the run whose token is `token` on `device` (`hostRequest script.stop`). */
export async function stopHostScript(device: DeviceId, token: string): Promise<void> {
  await engine.hostRequest(device, { app: 'script.stop', run: token });
}

/**
 * Open NetScope's Frames view on `filter` (the store's shared filter, as the link-state browser does). The workspace is
 * a window over the canvas, not a dock tab, so the dock may be collapsed: `showDockTab` also opens it.
 */
export function showInNetScope(filter: string, what: string): void {
  const s = store.getState();
  s.setNetscope({ filterText: filter, applied: filter });
  showDockTab('netscope');
  s.announce(`NetScope shows ${what}. The packets appear when a capture was running on a port they crossed.`);
}
