/**
 * protocols/script-host.ts — [S32] the NF-Py script host of the developer host NF-DEVHOST (ARCHITECTURE-P3 D21, §2.4
 * `script.run` / `script.stop` / `file.write` / `file.delete` and the `storage` action, §2.6 `script-runs`, §3.0 (d),
 * §3.8 step 8, §4.1, §4.2, §4.3, §5.7, §5.8; §7 W5 auto). The W6 flip registers it (`programmable` row, last in
 * `PROCESS_ORDER`); until then it runs on `staged.world`'s test-only NF-DEVHOST through the registry overlay.
 *
 * Runs. `script.run {token, file, argv?, session?}` (the host shell's `python` job, or the automation workspace through
 * `hostRequest`, whose ticket is the token) reads `file` from the host's `files:` store (`ctx.readFile`), compiles it
 * with the W2 NF-Py library (`startPyScript`: a syntax error gives a run that fails in its first slice, before any
 * packet) and starts run `r<n>` (n counts from 1 for the life of the daemon). The first slice runs at once, in the
 * request's dispatch. A slice is at most PY_QUANTUM (10 000) instructions of the VM; a slice that spends its quantum
 * arms the non-periodic timer `script-slice:<run>` 1 ms later (§4.2), so a run of k slices takes (k − 1) ms of sim time
 * and an endless loop ends at the VM's instruction cap (PY_MAX_STEPS: it fails in slice PY_MAX_STEPS / PY_QUANTUM + 1,
 * PY_MAX_STEPS / PY_QUANTUM ms — 500 ms — after its start, with the `LimitExceeded` failure no `except` catches). Every cap of
 * the VM (instructions, requests, sleep, depth, length, output) ends a run deterministically, and every timer of a
 * run is non-periodic and bounded, so a run never holds `runToIdle` for ever (rule 19).
 * Each slice runs at the device clock (`time.time()`, `ctx.clock()`) and the sim time (`time.monotonic()`).
 *
 * I/O. A slice that stops on a suspension does what the VM asks, one thing at a time (each call suspends the machine,
 * so the requests of a run are strictly sequential, §3.8 step 8):
 *  - `time.sleep(s)`: the non-periodic timer `script-sleep:<run>` after s seconds (rounded to the ns by the library);
 *    when it fires the machine resumes and the next slice runs in that dispatch;
 *  - an HTTP call of the `requests`-style module: one `http.request {owner 'script-host', token
 *    'script:<run>:<n>', method, url, headers, body?, timeoutNs?}` to http-client (`pyIoHttpRequest`; n counts the
 *    run's requests from 1); its `http.result` resumes the machine (`pyIoResultOfHttp`) and the next slice runs 0 ns
 *    later through `script-slice:<run>` — a dispatch of its own, so a script whose calls fail at once (a bad address,
 *    no route, no name server) never runs a whole loop of requests inside one action budget.
 * The output a slice prints goes to the run's StateView entry and, for a run started from a shell, to that session
 * (`cliOutput`) as it is printed. At the end the session gets the traceback of a failure (none for `sys.exit`, which
 * prints its own message) or the stop notice, then `cliDone`.
 *
 * Stop. `script.stop {token}` (Ctrl+C of the `python` job, the workspace's Stop button) ends the active run with that
 * token: its timers are cancelled and a pending request is abandoned — its `http.result`, when it comes, is ignored
 * (the request already left; the device may still apply it). Power-off ends every run with the daemon's RAM.
 *
 * Table (rule 20). Each run is one `script-runs` row (key = run id), written twice: when it starts (`running`, 0
 * requests) and when it ends (`completed`, `failed` with the traceback's last line as `error`, or `stopped`;
 * `endedAt`; `requests` = the HTTP requests it sent) — never per slice, output line or request. At most
 * SCRIPT_RUNS_LIMIT rows: a new run deletes the oldest finished row first (reason 'replaced'); at most
 * SCRIPT_HOST_MAX_RUNS runs are active at once on a host (a further `script.run` is refused), so a finished row
 * always exists to replace.
 *
 * Files (D21). `file.write {path, content}` and `file.delete {path}` (the automation workspace) become the W1 `storage`
 * action on the host's `files:` store; the runtime enforces the store's limits (ruling R20) and logs a refusal on its
 * own debug line. Scripts themselves have no file access (NF-Py has no `open`).
 *
 * Silence (§4.3): nothing is sent, no timer armed and no row written before a run; then only the run's own requests.
 * Refusals (an empty or unknown file name, a token already running, the active-run cap) start no run, write no row,
 * answer the session with one line and `cliDone`, and are kept in the StateView's `refused` list (the workspace has no
 * session). Debug category `script` (§5.8): one line per run start, request sent, answer, sleep, end, stop, refusal
 * and file request — never one per slice.
 *
 * stateSnapshot (`ScriptHostStateView`, display only — rule 20: the grader reads the table):
 *   { runs: [{ run, token, file, argv, state, startedAt, endedAt?, waiting?, output, error?, steps, slices, sleptNs,
 *     requests: [{ n, method, url, state, startedAt, endedAt?, status?, reason?, error? }] }] (every active run and the
 *     last SCRIPT_HOST_RETAINED_RUNS finished ones, in start order), refused: [{ token, file, reason, at }] (the last
 *     few), started, completed, failed, stopped }.
 *
 * ponytail: one daemon-wide run counter (run ids restart at r1 after a reload, with the table); a stopped run's pending
 * request is left to finish rather than aborted (http-client has no cancel for a process owner's call, and the request
 * may already have reached the server); a slice's output reaches the session only when the slice ends (a slice is at
 * most 10 000 instructions, so the delay is never visible).
 */
import type { ProcessName, SessionId } from '../contracts/ids.js';
import type { Action, DebugEvent, HttpMethod, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { ScriptRunRow } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { HttpResultEvent, ProcessEvent } from '../contracts/transport.js';
import { pyIoHttpRequest, pyIoResultOfHttp, startPyScript } from '../automation/py/lib.js';
import { PY_QUANTUM, type PyFailure, type PyIoRequest, type PyVm } from '../automation/py/vm.js';

const NAME: ProcessName = 'script-host';
const DEBUG_RING = 256;

/** @since P3 [S32] The daemon's name (the owner of its `http.request` calls). */
export const SCRIPT_HOST_NAME: ProcessName = NAME;
/** @since P3 [S32] Debug category (§5.8: `debug script`). */
export const SCRIPT_HOST_DEBUG = 'script';
/** @since P3 [S32] Rows of the `script-runs` table (§2.6). */
export const SCRIPT_RUNS_LIMIT = 20;
/** @since P3 [S32] Runs a host keeps active at once; a further `script.run` is refused. */
export const SCRIPT_HOST_MAX_RUNS = 4;
/** @since P3 [S32] Finished runs kept in the StateView (with their output), besides the active ones. */
export const SCRIPT_HOST_RETAINED_RUNS = 4;
/** @since P3 [S32] Refusals kept in the StateView. */
export const SCRIPT_HOST_RETAINED_REFUSALS = 8;
/** @since P3 [S32] The pause between two slices of a run (§4.2: 1 ms after each quantum). */
export const SCRIPT_SLICE_DELAY_NS: SimTime = 1_000_000;
/** @since P3 [S32] The process that carries a script's HTTP requests. */
export const SCRIPT_HTTP_CLIENT: ProcessName = 'http-client';

// Original wording, never a vendor phrase.
/** @since P3 [S32] The session's last line when a run is stopped (Ctrl+C or the workspace's Stop). */
export const MSG_SCRIPT_STOPPED = 'The script was stopped.';
/** @since P3 [S32] A `script.run` without a file name. */
export const MSG_SCRIPT_NO_NAME = '% Give the script file name.';
/** @since P3 [S32] A `script.run` whose token names a run that is still active. */
export const MSG_SCRIPT_TOKEN_BUSY = '% That script is already running.';
/** @since P3 [S32] A `script.run` while SCRIPT_HOST_MAX_RUNS runs are active. */
export function msgScriptHostBusy(max: number): string {
  return `% This host already runs ${max} scripts. Stop one before starting another.`;
}
/** @since P3 [S32] A `script.run` of a file the store does not hold (the shell's own wording, cli/handlers/devhost.ts). */
export function msgScriptNoFile(name: string): string {
  return `% There is no file named ${name}.`;
}

// ── the StateView (display only, rule 20) ────────────────────────────────────

/** @since P3 [S32] One HTTP request of a run, as the StateView lists it. */
export interface ScriptRequestView {
  /** 1, 2, … within the run. */
  readonly n: number;
  readonly method: HttpMethod;
  readonly url: string;
  /** pending → done (a response) | failed (no response: `error` holds the transport code) | abandoned (the run stopped first). */
  readonly state: 'pending' | 'done' | 'failed' | 'abandoned';
  readonly startedAt: SimTime;
  readonly endedAt?: SimTime;
  readonly status?: number;
  readonly reason?: string;
  readonly error?: string;
}

/** @since P3 [S32] Why a run failed, as the StateView shows it (the VM's `PyFailure`). */
export interface ScriptFailureView {
  /** The exception class (`KeyError`, `requests.exceptions.ConnectionError`, `SyntaxError`), or `LimitExceeded` for a cap. */
  readonly type: string;
  readonly message: string;
  /** The full text a shell prints, Python style. */
  readonly traceback: string;
  /** Its last line: the `script-runs` row's `error`. */
  readonly last: string;
  /** The line of the innermost frame, when known. */
  readonly line?: number;
}

/** @since P3 [S32] One run, as the StateView lists it. */
export interface ScriptRunView {
  readonly run: string;
  /** The requester's token (`py:<session>@<now>` from the shell, the `hostRequest` ticket from the workspace). */
  readonly token: string;
  readonly file: string;
  /** The arguments after the file name (`sys.argv[1:]`). */
  readonly argv: readonly string[];
  readonly state: ScriptRunRow['state'];
  readonly startedAt: SimTime;
  readonly endedAt?: SimTime;
  /** What an active run waits for, if anything. */
  readonly waiting?: 'sleep' | 'http';
  /** Everything the script printed (the VM caps it at PY_MAX_OUTPUT_CHARS with one note). */
  readonly output: string;
  /** A failed run's exception or cap. */
  readonly error?: ScriptFailureView;
  readonly steps: number;
  readonly slices: number;
  readonly sleptNs: number;
  readonly requests: readonly ScriptRequestView[];
}

/** @since P3 [S32] A refused `script.run`. */
export interface ScriptRefusalView {
  readonly token: string;
  readonly file: string;
  readonly reason: string;
  readonly at: SimTime;
}

/** @since P3 [S32] The script host's StateView (`stateSnapshot().state`). */
export interface ScriptHostStateView {
  readonly runs: readonly ScriptRunView[];
  readonly refused: readonly ScriptRefusalView[];
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly stopped: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** @since P3 [S32] The slice timer of a run (`script-slice:<run>`, §4.2). */
export function scriptSliceTimer(run: string): string {
  return `script-slice:${run}`;
}

/** @since P3 [S32] The sleep timer of a run (`script-sleep:<run>`, §4.2). */
export function scriptSleepTimer(run: string): string {
  return `script-sleep:${run}`;
}

/** @since P3 [S32] The `http.request` token of request `n` of a run. */
export function scriptRequestToken(run: string, n: number): string {
  return `script:${run}:${n}`;
}

interface RequestEntry {
  readonly n: number;
  readonly token: string;
  readonly method: HttpMethod;
  readonly url: string;
  state: ScriptRequestView['state'];
  readonly startedAt: SimTime;
  endedAt?: SimTime;
  status?: number;
  reason?: string;
  error?: string;
}

interface Run {
  readonly id: string;
  readonly token: string;
  readonly file: string;
  readonly argv: readonly string[];
  readonly session?: SessionId;
  readonly startedAt: SimTime;
  readonly vm: PyVm;
  state: ScriptRunRow['state'];
  endedAt?: SimTime;
  output: string;
  failure?: PyFailure;
  slices: number;
  wait?: { readonly kind: 'sleep' } | { readonly kind: 'http'; readonly token: string };
  readonly requests: RequestEntry[];
}

const isActive = (r: Run): boolean => r.state === 'running';

export function createScriptHost(): Process {
  const ring: DebugEvent[] = [];
  /** Every active run and the retained finished ones, in start order. */
  const runs = new Map<string, Run>();
  const refused: ScriptRefusalView[] = [];
  let counter = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let stopped = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(SCRIPT_HOST_DEBUG, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: SCRIPT_HOST_DEBUG, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: SCRIPT_HOST_DEBUG, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const activeRuns = (): Run[] => [...runs.values()].filter(isActive);

  /** Forget the oldest finished runs beyond SCRIPT_HOST_RETAINED_RUNS (active ones never; start order). */
  function evictFinished(): void {
    let finished = 0;
    for (const r of runs.values()) if (!isActive(r)) finished++;
    for (const [id, r] of runs) {
      if (finished <= SCRIPT_HOST_RETAINED_RUNS) break;
      if (isActive(r)) continue;
      runs.delete(id);
      finished--;
    }
  }

  /** The `script-runs` row of `run` (rule 20: written at its start and at its end only). */
  function writeRow(ctx: ProcessCtx, run: Run): void {
    const table = ctx.tables.get<ScriptRunRow>('script-runs');
    if (table === undefined) return;
    if (!table.has(run.id)) {
      while (table.size >= SCRIPT_RUNS_LIMIT) {
        const oldest = table.rows().find((r) => r.state !== 'running');
        if (oldest === undefined) break;
        table.delete(oldest.key, 'replaced');
      }
    }
    const row: ScriptRunRow = {
      key: run.id,
      run: run.id,
      file: run.file,
      state: run.state,
      startedAt: run.startedAt,
      requests: run.requests.length,
      updatedAt: ctx.now,
    };
    if (run.endedAt !== undefined) row.endedAt = run.endedAt;
    if (run.state === 'failed' && run.failure !== undefined) row.error = run.failure.last;
    table.set(row);
  }

  /** One line to a session, then the end of its job. */
  function reply(session: SessionId | undefined, text: string): Action[] {
    return session === undefined ? [] : [{ type: 'cliOutput', session, text: `${text}\n` }, { type: 'cliDone', session }];
  }

  function refuse(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'script.run' }>, reason: string): Action[] {
    refused.push({ token: req.token, file: req.file, reason, at: ctx.now });
    if (refused.length > SCRIPT_HOST_RETAINED_REFUSALS) refused.splice(0, refused.length - SCRIPT_HOST_RETAINED_REFUSALS);
    debug(ctx, `run of ${req.file.trim() === '' ? '(no file)' : req.file} refused: ${reason}`, { token: req.token, file: req.file });
    return reply(req.session, reason);
  }

  /** End a run: its state and end time, its row, its counters; the session's last words and `cliDone`. */
  function finish(ctx: ProcessCtx, run: Run, state: Exclude<ScriptRunRow['state'], 'running'>): Action[] {
    run.state = state;
    run.endedAt = ctx.now;
    run.wait = undefined;
    for (const q of run.requests) {
      if (q.state !== 'pending') continue;
      q.state = 'abandoned';
      q.endedAt = ctx.now;
    }
    writeRow(ctx, run);
    const out: Action[] = [];
    if (state === 'completed') {
      completed++;
      debug(ctx, `${run.id}: ${run.file} completed`, { run: run.id, requests: run.requests.length });
    } else if (state === 'failed') {
      failed++;
      const last = run.failure?.last ?? '';
      debug(ctx, `${run.id}: ${run.file} failed: ${last}`, { run: run.id, error: last });
      // Python prints the traceback of an uncaught exception; `sys.exit(<text>)` already printed its own message
      if (run.session !== undefined && run.failure !== undefined && run.failure.type !== 'SystemExit') {
        out.push({ type: 'cliOutput', session: run.session, text: `${run.failure.traceback}\n` });
      }
    } else {
      stopped++;
      debug(ctx, `${run.id}: ${run.file} stopped`, { run: run.id });
      out.push({ type: 'cancelTimer', key: scriptSliceTimer(run.id) }, { type: 'cancelTimer', key: scriptSleepTimer(run.id) });
      if (run.session !== undefined) out.push({ type: 'cliOutput', session: run.session, text: `${MSG_SCRIPT_STOPPED}\n` });
    }
    if (run.session !== undefined) out.push({ type: 'cliDone', session: run.session });
    evictFinished();
    return out;
  }

  /** What a waiting machine asked for: a sleep timer, or the next HTTP request of the run. */
  function waitFor(ctx: ProcessCtx, run: Run, io: PyIoRequest): Action[] {
    if (io.kind === 'sleep') {
      run.wait = { kind: 'sleep' };
      const length = io.ns % 1_000_000 === 0 ? `${io.ns / 1_000_000} ms` : `${io.ns} ns`;
      debug(ctx, `${run.id}: sleeping ${length}`, { run: run.id, ns: io.ns });
      return [{ type: 'timer', key: scriptSleepTimer(run.id), delay: io.ns }];
    }
    const n = run.requests.length + 1;
    const token = scriptRequestToken(run.id, n);
    run.requests.push({ n, token, method: io.method, url: io.url, state: 'pending', startedAt: ctx.now });
    run.wait = { kind: 'http', token };
    debug(ctx, `${run.id}: request ${n}: ${io.method} ${io.url}`, { run: run.id, n, method: io.method, url: io.url });
    return [{ type: 'request', to: SCRIPT_HTTP_CLIENT, req: pyIoHttpRequest(io, NAME, token) }];
  }

  /** Run one slice of an active, non-waiting run and act on how it stopped. */
  function advance(ctx: ProcessCtx, run: Run): Action[] {
    const s = run.vm.run({ quantum: PY_QUANTUM, clock: { unixMs: ctx.clock().unixMs, monotonicNs: ctx.now } });
    run.slices++;
    const out: Action[] = [];
    if (s.output !== '') {
      run.output += s.output;
      if (run.session !== undefined) out.push({ type: 'cliOutput', session: run.session, text: s.output });
    }
    switch (s.state) {
      case 'running':
        out.push({ type: 'timer', key: scriptSliceTimer(run.id), delay: SCRIPT_SLICE_DELAY_NS });
        return out;
      case 'waiting':
        if (s.io !== undefined) return [...out, ...waitFor(ctx, run, s.io)];
        // a machine never waits without saying for what; end the run rather than leave it hanging
        run.failure = { type: 'RuntimeError', message: 'the script waited for nothing', traceback: 'RuntimeError: the script waited for nothing', last: 'RuntimeError: the script waited for nothing' };
        return [...out, ...finish(ctx, run, 'failed')];
      case 'completed':
        return [...out, ...finish(ctx, run, 'completed')];
      case 'failed':
        if (s.error !== undefined) run.failure = s.error;
        return [...out, ...finish(ctx, run, 'failed')];
    }
  }

  function start(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'script.run' }>): Action[] {
    const file = typeof req.file === 'string' ? req.file : '';
    if (file.trim() === '') return refuse(ctx, req, MSG_SCRIPT_NO_NAME);
    const active = activeRuns();
    if (active.some((r) => r.token === req.token)) return refuse(ctx, req, MSG_SCRIPT_TOKEN_BUSY);
    if (active.length >= SCRIPT_HOST_MAX_RUNS) return refuse(ctx, req, msgScriptHostBusy(SCRIPT_HOST_MAX_RUNS));
    const stored = ctx.readFile('files', file);
    if (stored === undefined) return refuse(ctx, req, msgScriptNoFile(file));
    const argv = Array.isArray(req.argv) ? req.argv.map((a) => String(a)) : [];
    counter++;
    started++;
    const run: Run = {
      id: `r${counter}`,
      token: req.token,
      file,
      argv,
      ...(req.session !== undefined ? { session: req.session } : {}),
      startedAt: ctx.now,
      vm: startPyScript(stored.content, { file, argv }),
      state: 'running',
      output: '',
      slices: 0,
      requests: [],
    };
    runs.set(run.id, run);
    writeRow(ctx, run);
    debug(ctx, `${run.id}: ${file} started${argv.length > 0 ? ` with ${argv.join(' ')}` : ''}`, { run: run.id, token: run.token, file });
    return advance(ctx, run);
  }

  function stop(ctx: ProcessCtx, token: string): Action[] {
    const run = activeRuns().find((r) => r.token === token);
    if (run === undefined) return [];
    return finish(ctx, run, 'stopped');
  }

  function answer(ctx: ProcessCtx, ev: HttpResultEvent): Action[] {
    const run = activeRuns().find((r) => r.wait?.kind === 'http' && r.wait.token === ev.token);
    // a stopped run's late answer (or a token that was never ours) changes nothing
    if (run === undefined) return [];
    const q = run.requests.find((x) => x.token === ev.token);
    if (q !== undefined) {
      q.state = ev.status !== undefined ? 'done' : 'failed';
      q.endedAt = ctx.now;
      if (ev.status !== undefined) q.status = ev.status;
      if (ev.reason !== undefined) q.reason = ev.reason;
      if (ev.error !== undefined) q.error = ev.error;
      debug(
        ctx,
        `${run.id}: request ${q.n}: ${ev.status !== undefined ? `${ev.status}${ev.reason !== undefined && ev.reason !== '' ? ` ${ev.reason}` : ''}` : `failed (${ev.error ?? 'no answer'})`}`,
        { run: run.id, n: q.n, ...(ev.status !== undefined ? { status: ev.status } : { error: ev.error ?? 'no answer' }) },
      );
    }
    run.wait = undefined;
    run.vm.resume(pyIoResultOfHttp(ev));
    // the next slice runs in a dispatch of its own (file header, "I/O")
    return [{ type: 'timer', key: scriptSliceTimer(run.id), delay: 0 }];
  }

  function viewOf(r: Run): ScriptRunView {
    const stats = r.vm.stats();
    const requests = r.requests.map((q): ScriptRequestView => {
      const v: { -readonly [K in keyof ScriptRequestView]: ScriptRequestView[K] } = { n: q.n, method: q.method, url: q.url, state: q.state, startedAt: q.startedAt };
      if (q.endedAt !== undefined) v.endedAt = q.endedAt;
      if (q.status !== undefined) v.status = q.status;
      if (q.reason !== undefined) v.reason = q.reason;
      if (q.error !== undefined) v.error = q.error;
      return v;
    });
    const v: { -readonly [K in keyof ScriptRunView]: ScriptRunView[K] } = {
      run: r.id,
      token: r.token,
      file: r.file,
      argv: [...r.argv],
      state: r.state,
      startedAt: r.startedAt,
      output: r.output,
      steps: stats.steps,
      slices: r.slices,
      sleptNs: stats.sleptNs,
      requests,
    };
    if (r.endedAt !== undefined) v.endedAt = r.endedAt;
    if (r.wait !== undefined) v.waiting = r.wait.kind;
    if (r.failure !== undefined) v.error = { ...r.failure };
    return v;
  }

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'script-host takes no packets', port }];
    },

    onConfig(): Action[] {
      return [];
    },

    onTimer(ctx, key): Action[] {
      if (key.startsWith('script-slice:')) {
        const run = runs.get(key.slice('script-slice:'.length));
        return run === undefined || !isActive(run) || run.wait !== undefined ? [] : advance(ctx, run);
      }
      if (key.startsWith('script-sleep:')) {
        const run = runs.get(key.slice('script-sleep:'.length));
        if (run === undefined || !isActive(run) || run.wait?.kind !== 'sleep') return [];
        run.wait = undefined;
        run.vm.resume({ kind: 'sleep' });
        return advance(ctx, run);
      }
      return [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      return ev.kind === 'http.result' ? answer(ctx, ev) : [];
    },

    onRequest(ctx, req): Action[] {
      switch (req.kind) {
        case 'script.run':
          return start(ctx, req);
        case 'script.stop':
          return stop(ctx, req.token);
        case 'file.write':
          // the runtime checks the name and the store's limits (ruling R20) and logs its own refusal
          if (typeof req.path !== 'string' || typeof req.content !== 'string') return [];
          debug(ctx, `write of ${req.path} (${req.content.length} characters)`, { path: req.path });
          return [{ type: 'storage', op: 'write', fs: 'files', path: req.path, file: { content: req.content } }];
        case 'file.delete':
          if (typeof req.path !== 'string') return [];
          debug(ctx, `delete of ${req.path}`, { path: req.path });
          return [{ type: 'storage', op: 'delete', fs: 'files', path: req.path }];
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const state: ScriptHostStateView = {
        runs: [...runs.values()].map(viewOf),
        refused: refused.map((r) => ({ ...r })),
        started,
        completed,
        failed,
        stopped,
      };
      return { process: NAME, state: state as unknown as Record<string, unknown> };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
