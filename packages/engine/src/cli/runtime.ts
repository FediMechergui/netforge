/**
 * cli/runtime.ts — the CLI runtime (spec §7.1, §7.3, §7.5; ARCHITECTURE "cli/runtime.ts", "Config flow",
 * "Ping flow"; ARCHITECTURE-P1 D2, D9, §3.11–§3.13).
 *
 * Owns the console/vty sessions of every device: mode, context stack, privilege level, prompt, history, and
 * the running job while the session is `busy`. `exec` parses a whole line with `cli/parser.ts` against the
 * grammar, builds a `CommandCtx` and dispatches to the handler registry; `complete` and `help` delegate to the
 * parser; `interrupt` aborts the running job.
 *
 * Scope (§3.13): the parser receives the device grammar (`model.cli.grammar`), the EFFECTIVE capabilities, the
 * selected interface (innermost `interface` context entry), `portsVersion` and one shared scope cache. *
 * Modes (§3.13): the session keeps a context stack (`[['interface','Gi0/0']]`, `[['ip','dhcp','pool','LAN']]`).
 * `setMode`/`enterMode` derive the stack from `MODES` (cli/modes.ts): exec-class modes carry none, a mode keeps
 * as many entries as its parent chain declares context keys. A line UNRECOGNIZED in a configuration sub-mode is
 * retried in each ancestor configuration mode; on the first match the session moves to that mode with the
 * context truncated, then the handler runs there. Help and completion list only the current mode.
 *
 * Jobs: `block(job?)` records the job (no argument = the P0 ping job `{process:'icmpv4', abort: icmp.abort}`);
 * `interrupt` sends `job.abort` to `job.process`, then unblocks if the job did not answer with `cliDone`.
 *
 * Access: a model whose shell is `none` cannot be opened (`open` throws `CLI_MESSAGES.noShell`, `canOpen`
 * reports it). Initial privilege comes from `model.cli.initialPrivilege`.
 *
 * Headless configure (D9, §3.12): `configure` runs lines through a transient session (id `h_<n>` from its own
 * counter, privilege 15, never listed, no history, no trace of its own: output is captured per line). Job and
 * interactive specs are refused with `CLI_MESSAGES.notHeadless`. `indentation` uses the ONE indentation walker
 * (cli/config-text.ts) to pick each line's nesting level; `atomic` reverts through `running.diffTree(before)`
 * applied with `DeviceRuntime.applyConfigLine`, so processes see the inverse deltas.
 *
 * Module removal (§3.11): `onPortsRemoved` drops sessions whose context names a removed port to `config`.
 *
 * P2 (ARCHITECTURE-P2 §2.11, §5.1, §7 W2 cli): the built-in table is `BUILTIN_GRAMMAR` (the P1 table followed by
 * the P2 fragments). Two interface-context modes reuse the `config-if` command set: `config-subif` (a router
 * subinterface, context `[['interface', 'GigabitEthernet0/0.10']]`) is matched as `config-if` with its own context,
 * so every `config-if` spec whose port requirement the subinterface meets applies there; `config-if-range` (context
 * `[['interface', 'range', <ports…>]]`, entered by `interface range`) is matched as `config-if` against the FIRST port,
 * and a `config-if` line is then re-matched and run once per port of the list with that port's own context (so port
 * requirements and interface args are checked per port; a port's error is printed with its name and the others
 * still run). Lines whose spec admits `config-if-range` itself (`exit`, `end`, `do …`, and a global line reached by
 * the parent-mode fallback) run once, in the session's real mode.
 *
 * Input (P1, §4.10): a handler answering `CommandOutcome.ask` leaves the session waiting for input. The result and
 * the `cliPrompt` event carry `input`; the next `exec` line is the answer: it is neither parsed nor trimmed nor
 * recorded in history, and it goes to `resume(ctx, answer, attempt)`. A resume that asks the SAME question again
 * (same kind and prompt) counts as a failed answer (`attempt` grows); after `MAX_INPUT_ATTEMPTS` failed answers the
 * command ends with `MSG_INPUT_DENIED`. A different question starts again at attempt 1. `interrupt` drops a pending
 * question. Headless configure refuses asking commands with `CLI_MESSAGES.notHeadless`.
 *
 * Login (§4.10): a `line con 0` (console) or `line vty …` (vty) section holding `login` and a `password` puts a new
 * session in mode `login` at privilege 0: banner motd, banner login, then a secret `Password: ` question. The right
 * password moves to user EXEC at the model's initial privilege and prints banner exec; three wrong ones print
 * `MSG_LOGIN_DENIED` (console: the session waits in `login` and any line starts over; vty: the session closes).
 * `login local` asks `Username: ` then `Password: ` against the `username X secret|password Y` lines.
 *
 * Secrets: `CommandCtx.secrets` hashes with `hashSecret` (`nf1$` + FNV-1a-64 over the device-id salt followed by the
 * plain text, UTF-8) and verifies hashed (`nf1`), reversible (`nf7`, `service password-encryption`) and plain
 * stored values. Secret args typed on a command line are replaced by `CONFIG_SECRET_MASK` in the session history.
 *
 * Output conventions:
 *   • A parse error renders as a caret line followed by the message. The terminal has already echoed
 *     `<prompt><line>`, so the caret is indented by `prompt.length + column`; `CliError.column` stays the 0-based
 *     column within the line (contract).
 *   • Handler `error` text is appended to the output and mirrored in `CliResult.error`.
 *   • `| section|include|exclude|begin <pattern>` on a filterable command is applied over the output lines.
 *   • After every non-empty console line a `cliPrompt` trace event carries the new prompt and busy state;
 *     asynchronous job output arrives through `onOutput` → `cliOutput`, and `onDone` → `cliPrompt {busy:false}`.
 *   • `debug <category>` state is a per-device set (`'all'` matches everything); `onDebugEvent` prints
 *     `*hh:mm:ss.uuuuuu: <category>: <message>` to every console/vty session on that device.
 *
 * Deterministic: no wall clock, no randomness; sessions are kept in Maps in open order and every iteration is
 * over that order.
 */
import type {
  CliError,
  CliInputRequest,
  CliJob,
  CliMode,
  CliResult,
  CliRuntime,
  CliRuntimeDeps,
  CliSessionView,
  CommandCtx,
  CommandHandler,
  CommandOutcome,
  CommandSpec,
  CompletionSource,
  ConfigureLineResult,
  ConfigureOptions,
  ConfigureResult,
  PrivilegeLevel,
  SetModeOptions,
} from '../contracts/cli.js';
import { CLI_MESSAGES, HEADLESS_SESSION_PREFIX } from '../contracts/cli.js';
import type { Capability, CliGrammar, CliSpec } from '../contracts/catalog.js';
import type { DeviceModel, DeviceRuntime, PortResolution } from '../contracts/device.js';
import type { DeviceId, PortId, SessionId } from '../contracts/ids.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent } from '../contracts/process.js';
import type { Dot11AssocRow, TableName, TableRow, Table } from '../contracts/tables.js';
import { formatSimTime, type SimTime } from '../contracts/time.js';
import { walkConfigText } from './config-text.js';
import { PASSWORD_PROMPT, secretsFor, USERNAME_PROMPT, verifySecret } from './secrets.js';
import { CONFIG_SECRET_MASK } from './config-rules.js';
import { BUILTIN_GRAMMAR, HANDLERS } from './grammar.js';
import {
  contextDepth,
  contextKeyOf,
  INTERFACE_RANGE_KEYWORD,
  isConfigClassMode,
  modeForContext,
  modeInGrammar,
  modePromptSuffix,
  parentMode,
  specModeAllows,
} from './modes.js';
import {
  complete as parserComplete,
  help as parserHelp,
  matchCommand,
  secretSpansOf,
  MSG_INCOMPLETE,
  type MatchContext,
  type MatchResult,
  type OutputFilter,
  type TextSpan,
} from './parser.js';
import { createScopeCache } from './scope.js';
import { createRuntimeHandlers, type CliRuntimeServices } from './handlers/exec.js';
import { HANDLER_REGISTRY } from './handlers/index.js';

/** Number of lines kept in a session's history (`show history`). */
export const HISTORY_LIMIT = 50;

/** Result for a line typed on a session id that no longer exists. */
export const MSG_NO_SESSION = '% This console session is closed.';
/** Result when the device behind the session disappeared. */
export const MSG_NO_DEVICE = '% The device behind this session no longer exists.';
/** Result for a line typed on a powered-off device. */
export const MSG_POWERED_OFF = '% The device is powered off. Nothing answers on this console.';
/** Result for a line typed while the device is still booting. */
export const MSG_BOOTING = '% The device is still starting up. Try again in a moment.';
/** Result for a command whose handler is not registered. */
export const MSG_NO_HANDLER = '% This command is not available in this release.';
/** A command whose question was answered wrongly `MAX_INPUT_ATTEMPTS` times in a row ends with this denial. */
export const MSG_INPUT_DENIED = '% Access denied after three wrong answers.';
/** Console login after three wrong passwords: the session waits in the login stage until the next line. */
export const MSG_LOGIN_DENIED = '% Access denied after three wrong passwords. Press Enter to try again.';
/** Remote (vty) login after three wrong passwords: the session is closed. */
export const MSG_LOGIN_DENIED_CLOSED = '% Access denied after three wrong passwords. The session is closed.';
/** `login local`: the user name is unknown or its password is wrong. */
export const MSG_LOGIN_FAILED = '% Login failed: unknown user name or wrong password.';
/** Failed answers to the same question after which the command (or login) is denied. */
export const MAX_INPUT_ATTEMPTS = 3;
/** Default message for a configuration line the device rejected without saying why. */
export const MSG_CONFIG_REJECTED = '% The configuration change was rejected.';

/** Process name used when the CLI applies actions on a device (`DeviceRuntime.applyActions`). */
export const CLI_PROCESS_NAME = 'cli';

/** Terminal label of the P0 ping job. */
export const PING_JOB_LABEL = 'ping';

/** The P0 job behind a bare `CommandCtx.block()`: the icmpv4 ping of `session`, aborted with `icmp.abort`. */
export function pingJob(session: SessionId): CliJob {
  return { process: 'icmpv4', abort: { kind: 'icmp.abort', session }, label: PING_JOB_LABEL };
}

/** The model's CLI spec (console shell, headless grammar, initial privilege). */
export function cliSpecOf(model: Pick<DeviceModel, 'cli'>): CliSpec {
  return model.cli;
}

/** Start mode of a headless session without `startMode`: global configuration for nfos, user EXEC for the host shell. */
export function defaultStartMode(grammar: CliGrammar): CliMode {
  return grammar === 'nfos' ? 'config' : 'user-exec';
}

/**
 * Result of a headless configure run refused before any line ran (unavailable start mode, refused start context):
 * the first line carries `error`, every line is skipped.
 */
function refusedRun(commands: readonly string[], error: CliError, mode: CliMode): ConfigureResult {
  const lines: ConfigureLineResult[] = commands.map((line, index) => ({ index, line, ok: false, output: '', mode, skipped: true }));
  if (lines[0] !== undefined) lines[0].error = error;
  return { ok: false, lines, applied: 0, finalMode: mode };
}

/**
 * Selected interface of a context stack: the port named by its innermost `interface` entry. An `interface range …`
 * entry (P2) selects no single interface: `rangePortsOf` lists its ports.
 */
export function selectedInterface(context: readonly (readonly string[])[]): PortId | undefined {
  for (let i = context.length - 1; i >= 0; i--) {
    const entry = context[i] as readonly string[];
    if (contextKeyOf(entry) === 'interface' && entry[1] !== undefined) return entry[1] === INTERFACE_RANGE_KEYWORD ? undefined : entry[1];
  }
  return undefined;
}

/** @since P2 The ports of the innermost `interface range …` context entry, or undefined when the stack has none. */
export function rangePortsOf(context: readonly (readonly string[])[]): PortId[] | undefined {
  for (let i = context.length - 1; i >= 0; i--) {
    const entry = context[i] as readonly string[];
    if (contextKeyOf(entry) === 'interface' && entry[1] === INTERFACE_RANGE_KEYWORD) return entry.slice(2);
  }
  return undefined;
}

/**
 * @since P2 The mode a session's lines are MATCHED in: `config-subif` and `config-if-range` reuse the `config-if`
 * command set (module header); every other mode is matched as itself.
 */
export function matchModeOf(mode: CliMode): CliMode {
  return mode === 'config-subif' || mode === 'config-if-range' ? 'config-if' : mode;
}

/** Deep copy of a context stack. */
function copyContext(context: readonly (readonly string[])[]): string[][] {
  return context.map((e) => e.slice());
}

/**
 * Context stack after entering `mode` from `context` (§3.13). `opts.context` replaces the stack. Exec and auth
 * class modes carry no context. Otherwise the stack keeps `contextDepth(mode)` entries: `opts.iface` supplies an
 * `['interface', iface]` entry and `opts.push` one more entry, each replacing the deepest kept level; without
 * them the existing entries up to that depth are kept (P0 `setMode('config-if')` keeps the selected interface).
 */
export function contextForMode(context: readonly (readonly string[])[], mode: CliMode, opts: SetModeOptions = {}): string[][] {
  if (opts.context !== undefined) return copyContext(opts.context);
  if (!isConfigClassMode(mode)) return [];
  const depth = contextDepth(mode);
  const added: string[][] = [];
  if (opts.iface !== undefined) added.push(['interface', opts.iface]);
  if (opts.push !== undefined) added.push(opts.push.slice());
  const keep = Math.max(0, Math.min(context.length, depth - added.length));
  return [...copyContext(context.slice(0, keep)), ...added];
}

/** Compile a filter pattern; an invalid regular expression matches literally. */
function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

/**
 * Apply a `| section|include|exclude|begin <pattern>` filter to command output.
 * `section` keeps every top-level line that matches together with the indented
 * lines below it (same semantics as `ConfigAst.renderFiltered`). Lines are split on
 * `\n`; a trailing newline is preserved when the input had one.
 */
export function applyOutputFilter(text: string, filter: OutputFilter): string {
  if (text === '') return text;
  const trailing = text.endsWith('\n');
  const lines = (trailing ? text.slice(0, -1) : text).split('\n');
  const re = compilePattern(filter.pattern);
  let kept: string[];
  switch (filter.kind) {
    case 'include':
      kept = lines.filter((l) => re.test(l));
      break;
    case 'exclude':
      kept = lines.filter((l) => !re.test(l));
      break;
    case 'begin': {
      const idx = lines.findIndex((l) => re.test(l));
      kept = idx === -1 ? [] : lines.slice(idx);
      break;
    }
    case 'section': {
      kept = [];
      let keeping = false;
      for (const l of lines) {
        const isChild = l.startsWith(' ') || l.startsWith('\t');
        if (!isChild) keeping = re.test(l);
        if (keeping) kept.push(l);
      }
      break;
    }
  }
  if (kept.length === 0) return '';
  return kept.join('\n') + (trailing ? '\n' : '');
}

/**
 * Render a parse error for the terminal: a caret under the offending token (the echoed
 * `<prompt><line>` is already on screen, hence the prompt offset) then the message.
 * Errors without a column (incomplete command) render as the message alone.
 */
export function renderCliError(error: CliError, promptLength: number): string {
  if (error.column === undefined) return error.message;
  return `${' '.repeat(promptLength + error.column)}^\n${error.message}`;
}

/** Prompt suffix for a mode: the `MODES` registry, then `MODE_PROMPT`, then `(mode)#`. */
export function promptSuffix(mode: CliMode): string {
  return modePromptSuffix(mode);
}

/**
 * Nesting level of every command for `configure({indentation})`, from the shared indentation walker: index →
 * number of enclosing lines. Commands the walker skips (blank, `!` comments, `end` / `version` at depth 0) are
 * absent. Line breaks inside one command are folded into spaces so indices stay aligned.
 */
export function indentationLevels(commands: readonly string[]): ReadonlyMap<number, number> {
  const text = commands.map((c) => c.replace(/[\r\n]+/g, ' ')).join('\n');
  const levels = new Map<number, number>();
  for (const l of walkConfigText(text)) levels.set(l.lineNo - 1, l.context.length);
  return levels;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets (§4.10): the nf1/nf7 primitives live in cli/secrets.ts (a leaf module the
// handlers share); they are re-exported here so the runtime stays their one public door.
// ─────────────────────────────────────────────────────────────────────────────

export {
  decodeReversibleSecret,
  encodeReversibleSecret,
  fnv1a64Hex,
  hashSecret,
  isTaggedSecret,
  PASSWORD_PROMPT,
  secretsFor,
  secretTokens,
  SECRET_HASH_TAG,
  SECRET_REVERSIBLE_TAG,
  USERNAME_PROMPT,
  verifySecret,
} from './secrets.js';

/** `line` with every span replaced by `CONFIG_SECRET_MASK` (history masking). Spans are in line order. */
export function maskSpans(line: string, spans: readonly TextSpan[]): string {
  let out = line;
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i] as TextSpan;
    out = `${out.slice(0, sp.column)}${CONFIG_SECRET_MASK}${out.slice(sp.end)}`;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Login configuration read from the running config
// ─────────────────────────────────────────────────────────────────────────────

/** Authentication a new session must pass, from the running config. */
export interface LineAuth {
  /** `login local`: user name + password from the `username` lines; else the line password. */
  local: boolean;
  /** Stored line password (`password …` args joined by one space); undefined without a password line. */
  password?: string;
}

/** True when a `line` section's type names the access path (`con`/`console` for console, `vty` for vty). */
function lineMatches(type: string | undefined, via: 'console' | 'vty'): boolean {
  const t = (type ?? '').toLowerCase();
  return via === 'console' ? t === 'con' || t === 'console' : t === 'vty';
}

/**
 * Login required on `via` according to `running`: a matching `line` section holding `login` and a `password`
 * (or `login local`). Undefined when a session opens straight into user EXEC.
 */
export function lineAuthOf(running: CommandCtx['running'], via: 'console' | 'vty'): LineAuth | undefined {
  for (const node of running.root.children) {
    if (node.key !== 'line' || !lineMatches(node.args[0], via)) continue;
    const login = node.children.find((c) => c.key === 'login');
    if (login === undefined) continue;
    const pw = node.children.find((c) => c.key === 'password');
    const local = login.args[0] === 'local';
    if (!local && (pw === undefined || pw.args.length === 0)) continue;
    const auth: LineAuth = { local };
    if (pw !== undefined && pw.args.length > 0) auth.password = pw.args.join(' ');
    return auth;
  }
  return undefined;
}

/** Stored secret of `username <name> secret|password <value>`, or undefined for an unknown user. */
export function userSecretOf(running: CommandCtx['running'], name: string): string | undefined {
  for (const node of running.root.children) {
    if (node.key !== 'username' || node.args[0] !== name) continue;
    if ((node.args[1] === 'secret' || node.args[1] === 'password') && node.args.length > 2) return node.args.slice(2).join(' ');
  }
  return undefined;
}

/** Text of `banner <type> <text>` in `running`, or undefined when that banner is not configured (or empty). */
export function bannerOf(running: CommandCtx['running'], type: 'motd' | 'login' | 'exec'): string | undefined {
  for (const node of running.root.children) {
    if (node.key !== 'banner' || node.args[0] !== type) continue;
    const text = node.args.slice(1).join(' ');
    return text === '' ? undefined : text;
  }
  return undefined;
}

/** One step of a question-and-answer exchange. */
interface InputStep {
  output: string;
  error?: CliError;
  /** Ask again (`failed`: the answer was wrong; default = same question as before). */
  next?: { request: CliInputRequest; answer: AnswerFn; failed?: boolean };
}

/** Consumes the answer typed at a pending question. */
type AnswerFn = (s: SessionState, dev: DeviceRuntime, answer: string, attempt: number) => InputStep;

/** A question the session waits on. */
interface PendingInput {
  request: CliInputRequest;
  answer: AnswerFn;
  /** 1-based attempt at this question. */
  attempt: number;
  /** Failed answers in this exchange so far. */
  failures: number;
  /** What `MAX_INPUT_ATTEMPTS` failures do. */
  denied: (s: SessionState) => InputStep;
}

/** Same question: kind and prompt equal. */
function sameRequest(a: CliInputRequest, b: CliInputRequest): boolean {
  return a.kind === b.kind && a.prompt === b.prompt;
}

/** `line` without one trailing line ending (CR LF, LF or CR). */
function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n') || line.endsWith('\r')) return line.slice(0, -1);
  return line;
}

/** Join two output fragments with a newline, skipping empty ones. */
function joinOutput(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return `${a}\n${b}`;
}

/** Mutable session record (the contract's view is derived from it on demand). */
interface SessionState {
  id: SessionId;
  device: DeviceId;
  via: 'console' | 'vty';
  mode: CliMode;
  privilege: PrivilegeLevel;
  busy: boolean;
  /** Mode path, outermost first; empty in exec-class modes. */
  context: string[][];
  history: string[];
  /** Set by `closeSession()` during a command; the session is removed once the command returns. */
  closing: boolean;
  /** True while `exec` runs on this session (suppresses the `cliPrompt` of a synchronous `cliDone`). */
  executing: boolean;
  /** Job the session waits for while `busy`. */
  job?: CliJob;
  /** Transient `configure` session: never listed, no trace, jobs refused. */
  headless: boolean;
  /** Headless only: configuration changes applied during the call (configChange events). */
  applied: number;
  /** Question the next `exec` line answers (§4.10). */
  pending?: PendingInput;
}

/** Everything one line produced, before it is shaped into a `CliResult` or a `ConfigureLineResult`. */
interface LineOutcome {
  /** Console text: rendered parse error, or handler output with the error appended. */
  output: string;
  /** Handler output alone (after any `|` filter); '' when no handler ran. */
  handlerOutput: string;
  error?: CliError;
  /** The session was closed by the command (console) or the device vanished. */
  closed: boolean;
  /** The device behind the session no longer exists. */
  noDevice: boolean;
}

/** Thrown by `CommandCtx.block` inside a headless session so a job handler stops before issuing its request. */
class HeadlessJobRefused extends Error {
  constructor() {
    super(CLI_MESSAGES.notHeadless);
    this.name = 'HeadlessJobRefused';
  }
}

/**
 * Create the CLI runtime. `handlers` overrides the default `HANDLER_REGISTRY` (tests inject a reduced registry);
 * the runtime-bound handlers (`debug`, `undebug all`, `do`) are always merged over it. The grammar is
 * `deps.grammar` when given, else the built-in `GRAMMAR`.
 */
export function createCliRuntime(deps: CliRuntimeDeps, handlers?: Record<string, CommandHandler>): CliRuntime {
  const grammar: readonly CommandSpec[] = deps.grammar ?? BUILTIN_GRAMMAR;
  const scope = createScopeCache();
  const sessions = new Map<SessionId, SessionState>();
  const headlessSessions = new Map<SessionId, SessionState>();
  const debugByDevice = new Map<DeviceId, Set<string>>();
  // [S1] counted from `deps.resume` so a replay numbers its sessions exactly as the live world did (§2.13)
  let nextSession = deps.resume?.sessions ?? 0;
  let nextHeadless = deps.resume?.headless ?? 0;

  // ── small helpers ──────────────────────────────────────────────────────────

  const hostnameOf = (s: SessionState): string => deps.device(s.device)?.hostname ?? '';
  const promptOf = (s: SessionState, mode: CliMode = s.mode): string => hostnameOf(s) + promptSuffix(mode);
  const capabilitiesOf = (dev: DeviceRuntime): readonly Capability[] => dev.capabilities;
  /** Context a command sees in `mode`: the session stack in configuration-class modes, none elsewhere. */
  const contextIn = (s: SessionState, mode: CliMode): string[][] => (isConfigClassMode(mode) ? copyContext(s.context) : []);

  /**
   * Context a line is MATCHED in (P2, module header): in `config-if-range` the first port of the range stands for the
   * list (port requirements and interface args are re-checked per port when the line runs); elsewhere `contextIn`.
   */
  const matchContextIn = (s: SessionState, mode: CliMode): string[][] => {
    if (mode !== 'config-if-range') return contextIn(s, mode);
    const first = rangePortsOf(s.context)?.[0];
    return first === undefined ? [] : [['interface', first]];
  };

  const viewOf = (s: SessionState, mode: CliMode = s.mode, contextOverride?: string[][]): CliSessionView => {
    const v: CliSessionView = {
      id: s.id,
      device: s.device,
      via: s.via,
      mode,
      privilege: s.privilege,
      prompt: promptOf(s, mode),
      busy: s.busy,
      history: s.history.slice(),
      // sessions close with their device, so the device is always there; 'nfos' only guards a stale id
      grammar: deps.device(s.device)?.model.cli.grammar ?? 'nfos',
    };
    const context = contextOverride ?? contextIn(s, mode);
    const iface = selectedInterface(context);
    if (iface !== undefined) v.iface = iface;
    if (isConfigClassMode(mode)) v.context = context;
    if (s.job !== undefined) v.job = { process: s.job.process, label: s.job.label };
    if (s.pending !== undefined) v.input = { ...s.pending.request };
    return v;
  };

  const emitPrompt = (s: SessionState, now: SimTime): void => {
    if (s.headless) return;
    if (s.pending !== undefined) {
      deps.trace.emit({ t: now, kind: 'cliPrompt', session: s.id, prompt: promptOf(s), busy: s.busy, input: { ...s.pending.request } });
      return;
    }
    deps.trace.emit({ t: now, kind: 'cliPrompt', session: s.id, prompt: promptOf(s), busy: s.busy });
  };

  const emitOutput = (s: SessionState, text: string, now: SimTime): void => {
    if (s.headless) return;
    deps.trace.emit({ t: now, kind: 'cliOutput', session: s.id, text });
  };

  const debugSet = (device: DeviceId): Set<string> => {
    let set = debugByDevice.get(device);
    if (set === undefined) {
      set = new Set();
      debugByDevice.set(device, set);
    }
    return set;
  };

  /** Resolve a typed port name against the live device (fixed, module and virtual ports). */
  const resolvePortOf = (dev: DeviceRuntime, name: string): PortResolution => dev.resolvePortName(name);

  /** Canonical id of an EXISTING port named `name`, or undefined. */
  const existingPort = (dev: DeviceRuntime, name: string): PortId | undefined => {
    const r = resolvePortOf(dev, name);
    return r.kind === 'existing' ? r.port : undefined;
  };

  /** Values of a dynamic completion source, from live device state; a source without device data yields none. */
  const completionValues = (dev: DeviceRuntime, source: CompletionSource): readonly string[] => {
    switch (source) {
      case 'interfaces':
        return [...dev.ports.keys()];
      case 'host-adapters':
        return (dev.model.hostPorts ?? []).filter((p) => dev.ports.has(p));
      case 'virtual-interfaces': {
        const out: string[] = [];
        for (const p of dev.ports.values()) if (p.spec.kind === 'virtual') out.push(p.id);
        return out;
      }
      case 'dhcp-pools': {
        const out: string[] = [];
        for (const n of dev.running.root.children) {
          const name = n.args[2];
          if (n.key === 'ip' && n.args[0] === 'dhcp' && n.args[1] === 'pool' && name !== undefined && !out.includes(name)) out.push(name);
        }
        return out;
      }
      case 'ssids-seen': {
        const table = dev.tables.get?.<Dot11AssocRow>('dot11-assoc');
        const out: string[] = [];
        for (const row of table?.rows() ?? []) if (row.ssid !== '' && !out.includes(row.ssid)) out.push(row.ssid);
        return out;
      }
      default:
        return [];
    }
  };

  const matchContext = (s: SessionState, dev: DeviceRuntime, mode: CliMode, context: readonly (readonly string[])[]): MatchContext => {
    const model = dev.model;
    const mc: MatchContext = {
      mode,
      privilege: s.privilege,
      capabilities: capabilitiesOf(dev),
      portsVersion: dev.portsVersion,
      scope,
      resolveInterface: (name) => existingPort(dev, name),
      portView: (id) => dev.portView(id),
      listInterfaces: () => [...dev.ports.keys()],
      completions: (source) => completionValues(dev, source),
    };
    mc.grammar = model.cli.grammar;
    mc.resolvePort = (name) => resolvePortOf(dev, name);
    const iface = isConfigClassMode(mode) ? selectedInterface(context) : undefined;
    const view = iface === undefined ? undefined : dev.portView(iface);
    if (view !== undefined) mc.iface = view;
    return mc;
  };

  const portViews = (dev: DeviceRuntime): ReadonlyMap<PortId, PortView> => {
    const out = new Map<PortId, PortView>();
    for (const id of dev.ports.keys()) {
      const v = dev.portView(id);
      if (v !== undefined) out.set(id, v);
    }
    return out;
  };

  const closeNow = (s: SessionState): void => {
    sessions.delete(s.id);
  };

  /** Session state after entering `mode` (mode + context stack). */
  const enterMode = (s: SessionState, mode: CliMode, opts: SetModeOptions): void => {
    s.context = contextForMode(s.context, mode, opts);
    s.mode = mode;
  };

  /** Fingerprint of the running tree; a changed fingerprint means the device emitted a configChange. */
  const runningFingerprint = (dev: DeviceRuntime): string => JSON.stringify(dev.running.toJSON());

  /** Run a device configuration operation, counting applied changes for a headless session. */
  const counted = <T>(s: SessionState, dev: DeviceRuntime, op: () => T): T => {
    if (!s.headless) return op();
    const before = runningFingerprint(dev);
    const r = op();
    if (runningFingerprint(dev) !== before) s.applied++;
    return r;
  };

  // ── runtime-bound handlers (debug / undebug / do) ─────────────────────────

  const services: CliRuntimeServices = {
    debugEnable: (device, category) => {
      debugSet(device).add(category);
    },
    debugDisable: (device, category) => {
      debugByDevice.get(device)?.delete(category);
    },
    debugDisableAll: (device) => {
      debugByDevice.get(device)?.clear();
    },
    debugEnabled: (device) => [...(debugByDevice.get(device) ?? [])],
    exec: (session, line, mode): CommandOutcome => {
      const s = sessions.get(session) ?? headlessSessions.get(session);
      if (s === undefined) return { error: MSG_NO_SESSION };
      const r = runLine(s, line, mode, true);
      if (s.headless) {
        const out: CommandOutcome = { output: r.handlerOutput };
        if (r.error !== undefined) out.error = r.error.message;
        return out;
      }
      return { output: r.output };
    },
  };

  const registry: Record<string, CommandHandler> = { ...(handlers ?? HANDLER_REGISTRY), ...createRuntimeHandlers(services) };

  // ── command context ───────────────────────────────────────────────────────

  const buildCtx = (s: SessionState, dev: DeviceRuntime, mode: CliMode, now: SimTime, contextOverride?: string[][]): CommandCtx => {
    const context = contextOverride ?? contextIn(s, mode);
    const ifaceId = selectedInterface(context);
    const ifaceView = ifaceId === undefined ? undefined : dev.portView(ifaceId);
    const apply = (ctxPath: string[][], line: string[], negate: boolean): { ok: boolean; error?: string } =>
      counted(s, dev, () => dev.applyConfigLine(ctxPath, line, negate));

    const deviceOps: CommandCtx['device'] = {
      setHostname: (name) => {
        apply([], ['hostname', name], false);
      },
      saveConfig: () => dev.saveConfig(),
      eraseStartup: () => dev.eraseStartup(),
      reload: () => dev.reload(now),
      setPortAdmin: (port, up) => {
        apply([['interface', port]], ['shutdown'], up);
      },
      clearTable: (name: TableName) => {
        let table: Table<TableRow> | undefined;
        if (name === 'arp') table = dev.tables.arp;
        else if (name === 'cam') table = dev.tables.cam;
        else if (name === 'rib') table = dev.tables.rib;
        else table = dev.tables.get?.(name);
        table?.clear('cleared');
      },
      ensureVirtualPort: (name) => counted(s, dev, () => dev.ensureVirtualPort(name, now)),
      removeVirtualPort: (name) => counted(s, dev, () => dev.removeVirtualPort(name, now)),
      setPortRole: (port, role) => counted(s, dev, () => dev.setPortRole(port, role, now)),
    };
    const ctx: CommandCtx = {
      now,
      session: viewOf(s, mode, contextOverride),
      deviceId: dev.id,
      hostname: dev.hostname,
      model: dev.model,
      ports: portViews(dev),
      tables: dev.tables,
      running: dev.running,
      startup: dev.startup,
      uptime: dev.uptime(now),
      processState: (name) => dev.processes.get(name)?.stateSnapshot(),
      config: (line, negate, ctxPath) => {
        const r = apply(ctxPath ?? copyContext(context), line, negate);
        if (r.ok) return undefined;
        return r.error ?? MSG_CONFIG_REJECTED;
      },
      resolvePort: (name) => existingPort(dev, name),
      request: (to, req) => {
        dev.applyActions(CLI_PROCESS_NAME, [{ type: 'request', to, req }], now);
      },
      act: (actions: Action[]) => {
        dev.applyActions(CLI_PROCESS_NAME, actions, now);
      },
      device: deviceOps,
      setMode: (newMode, iface) => {
        enterMode(s, newMode, iface !== undefined ? { iface } : {});
      },
      setPrivilege: (level) => {
        s.privilege = level;
      },
      block: (job) => {
        if (s.headless) throw new HeadlessJobRefused();
        s.busy = true;
        s.job = job ?? pingJob(s.id);
      },
      closeSession: () => {
        s.closing = true;
      },
      capabilities: new Set(capabilitiesOf(dev)),
      context: Object.freeze(context.map((e) => Object.freeze(e.slice()))),
      headless: s.headless,
      enterMode: (newMode, opts) => {
        enterMode(s, newMode, opts ?? {});
      },
      grammar: dev.model.cli.grammar,
      ...(ifaceView !== undefined ? { iface: ifaceView } : {}),
      radioView: (port: PortId) => deps.radioView({ device: dev.id, port }),
      air: deps.airView(dev.id),
      secrets: secretsFor(dev.id),
    };
    return ctx;
  };

  // ── questions and answers (§4.10) ─────────────────────────────────────────

  /** Wait for an answer to `request`, starting a new exchange. */
  const askNew = (s: SessionState, request: CliInputRequest, answer: AnswerFn, denied: (s: SessionState) => InputStep): void => {
    s.pending = { request: { ...request }, answer, attempt: 1, failures: 0, denied };
  };

  /** Denial of a command question answered wrongly too often. */
  const commandDenied = (): InputStep => ({ output: MSG_INPUT_DENIED, error: { message: MSG_INPUT_DENIED } });

  /** Shape a handler outcome as an input step (output with the error appended, a further question as `next`). */
  const stepOf = (outcome: CommandOutcome, mode: CliMode, filter: OutputFilter | undefined): InputStep => {
    let output = outcome.output ?? '';
    if (filter !== undefined && output !== '') output = applyOutputFilter(output, filter);
    const step: InputStep = { output };
    if (outcome.error !== undefined) {
      step.error = { message: outcome.error };
      step.output = joinOutput(output, outcome.error);
    }
    if (outcome.ask !== undefined) step.next = { request: outcome.ask.request, answer: resumeAnswer(outcome.ask.resume, mode, filter) };
    return step;
  };

  /** Answer function continuing a handler through its `resume` in the mode the command ran in. */
  const resumeAnswer = (resume: NonNullable<CommandOutcome['ask']>['resume'], mode: CliMode, filter: OutputFilter | undefined): AnswerFn =>
    (s, dev, answer, attempt) => {
      const ctx = buildCtx(s, dev, mode, deps.now());
      return stepOf(resume(ctx, answer, attempt), mode, filter);
    };

  /** Leave the login stage: user EXEC at the model's initial privilege, banner exec. */
  const finishLogin = (s: SessionState, dev: DeviceRuntime): InputStep => {
    s.mode = 'user-exec';
    s.context = [];
    s.privilege = cliSpecOf(dev.model).initialPrivilege;
    return { output: bannerOf(dev.running, 'exec') ?? '' };
  };

  /** Three wrong passwords: the console waits in the login stage, a vty session closes. */
  const loginDenied = (s: SessionState): InputStep => {
    if (s.via === 'vty') {
      s.closing = true;
      return { output: MSG_LOGIN_DENIED_CLOSED, error: { message: MSG_LOGIN_DENIED_CLOSED } };
    }
    return { output: MSG_LOGIN_DENIED, error: { message: MSG_LOGIN_DENIED } };
  };

  /** `Password: ` of a line password; the config is read at answer time. */
  const linePasswordAnswer: AnswerFn = (s, dev, answer) => {
    const auth = lineAuthOf(dev.running, s.via);
    if (auth === undefined || auth.local || auth.password === undefined || verifySecret(dev.id, auth.password, answer)) {
      return finishLogin(s, dev);
    }
    return { output: '', next: { request: PASSWORD_PROMPT, answer: linePasswordAnswer, failed: true } };
  };

  /** `Username: ` of `login local`, followed by that user's `Password: `. */
  const usernameAnswer: AnswerFn = (_s, _dev, answer) => ({
    output: '',
    next: { request: PASSWORD_PROMPT, answer: localPasswordAnswer(answer), failed: false },
  });

  const localPasswordAnswer = (user: string): AnswerFn => (s, dev, answer) => {
    const auth = lineAuthOf(dev.running, s.via);
    if (auth === undefined || !auth.local) return finishLogin(s, dev);
    const stored = userSecretOf(dev.running, user);
    if (stored !== undefined && verifySecret(dev.id, stored, answer)) return finishLogin(s, dev);
    return { output: MSG_LOGIN_FAILED, next: { request: USERNAME_PROMPT, answer: usernameAnswer, failed: true } };
  };

  /**
   * Enter the login stage when the running config asks for it: mode `login`, privilege 0, the first question
   * pending. Returns the login banner (or '') or undefined when no login is required.
   */
  const startLogin = (s: SessionState, dev: DeviceRuntime): string | undefined => {
    const auth = lineAuthOf(dev.running, s.via);
    if (auth === undefined) return undefined;
    s.mode = 'login';
    s.context = [];
    s.privilege = 0;
    if (auth.local) askNew(s, USERNAME_PROMPT, usernameAnswer, loginDenied);
    else askNew(s, PASSWORD_PROMPT, linePasswordAnswer, loginDenied);
    return bannerOf(dev.running, 'login') ?? '';
  };

  /** Feed `answer` to the pending question of `s` (device checks as for a command line). */
  const answerPending = (s: SessionState, answer: string): CliResult => {
    const p = s.pending as PendingInput;
    const dev = deps.device(s.device);
    if (dev === undefined) {
      closeNow(s);
      return { output: MSG_NO_DEVICE, error: { message: MSG_NO_DEVICE }, mode: s.mode, prompt: '', busy: false, closed: true };
    }
    if (!dev.power) return result(s, MSG_POWERED_OFF, s.busy, { message: MSG_POWERED_OFF });
    if (dev.bootedAt === undefined) return result(s, MSG_BOOTING, s.busy, { message: MSG_BOOTING });
    delete s.pending;
    s.closing = false;
    let step = p.answer(s, dev, answer, p.attempt);
    const next = step.next;
    if (next !== undefined) {
      const failed = next.failed ?? sameRequest(next.request, p.request);
      const failures = p.failures + (failed ? 1 : 0);
      if (failed && failures >= MAX_INPUT_ATTEMPTS) {
        const denial = p.denied(s);
        step = { output: joinOutput(step.output, denial.output), ...(denial.error !== undefined ? { error: denial.error } : {}) };
      } else {
        s.pending = { request: { ...next.request }, answer: next.answer, attempt: failed ? p.attempt + 1 : 1, failures, denied: p.denied };
      }
    }
    if (s.closing) {
      closeNow(s);
      return result(s, step.output, false, step.error, true);
    }
    return result(s, step.output, s.busy, step.error);
  };

  // ── matching with the parent-mode fallback ─────────────────────────────────

  /**
   * Match `line` in `mode` (P2: `config-subif` and `config-if-range` are matched as `config-if`, `matchModeOf`). An
   * `unrecognized` line in a configuration sub-mode (the session's own mode) is retried in each ancestor
   * configuration mode with the context truncated to that mode's depth; `fallback` carries the mode and context of
   * the first ancestor that matched.
   */
  const matchLine = (
    s: SessionState,
    dev: DeviceRuntime,
    line: string,
    mode: CliMode,
  ): { m: MatchResult; fallback?: { mode: CliMode; context: string[][] } } => {
    const m = matchCommand(grammar, matchContext(s, dev, matchModeOf(mode), matchContextIn(s, mode)), line);
    if (m.ok || m.kind !== 'unrecognized' || mode !== s.mode || !isConfigClassMode(mode) || mode === 'config') return { m };
    const seen = new Set<CliMode>([mode]);
    let cur = parentMode(mode);
    while (cur !== undefined && isConfigClassMode(cur) && !seen.has(cur)) {
      seen.add(cur);
      const context = copyContext(s.context.slice(0, Math.min(contextDepth(cur), s.context.length)));
      const pm = matchCommand(grammar, matchContext(s, dev, cur, context), line);
      if (pm.ok) return { m: pm, fallback: { mode: cur, context } };
      cur = parentMode(cur);
    }
    return { m };
  };

  // ── the core: run one line in an explicit mode ─────────────────────────────

  const failure = (output: string, error: CliError, extra: Partial<LineOutcome> = {}): LineOutcome => ({
    output,
    handlerOutput: '',
    error,
    closed: false,
    noDevice: false,
    ...extra,
  });

  /**
   * Parse and run `line` on `s` as if the session were in `mode`. `nested` (the `do` service) leaves session
   * removal to the outer call.
   */
  function runLine(s: SessionState, line: string, mode: CliMode, nested: boolean): LineOutcome {
    const now = deps.now();
    const dev = deps.device(s.device);
    if (dev === undefined) {
      if (!s.headless) closeNow(s);
      return failure(MSG_NO_DEVICE, { message: MSG_NO_DEVICE }, { closed: true, noDevice: true });
    }
    if (!dev.power) return failure(MSG_POWERED_OFF, { message: MSG_POWERED_OFF });
    if (dev.bootedAt === undefined) return failure(MSG_BOOTING, { message: MSG_BOOTING });

    const prompt = promptOf(s, mode);
    const found = matchLine(s, dev, line, mode);
    const m = found.m;
    // Masking runs BEFORE the failure return: a line that carries a secret and then fails to parse (wrong mode,
    // over-long value) was still typed in the clear, and `exec` recorded it last.
    const spans = m.ok ? (m.secretSpans ?? []) : secretSpansOf(grammar, matchContext(s, dev, matchModeOf(mode), matchContextIn(s, mode)), line);
    if (!nested && !s.headless && spans.length > 0 && s.history.length > 0) {
      s.history[s.history.length - 1] = maskSpans(line, spans);
    }
    if (!m.ok) return failure(renderCliError(m.error, prompt.length), m.error);

    let runMode = mode;
    if (found.fallback !== undefined) {
      s.mode = found.fallback.mode;
      s.context = found.fallback.context;
      runMode = found.fallback.mode;
    }
    const effectiveMode: CliMode = m.doPrefix ? 'priv-exec' : runMode;
    const handler = registry[m.spec.handler];
    if (handler === undefined) return failure(MSG_NO_HANDLER, { message: MSG_NO_HANDLER });
    if (m.spec.handler === HANDLERS.execDo && (m.args['command'] ?? '').trim() === '') {
      return failure(MSG_INCOMPLETE, { message: MSG_INCOMPLETE });
    }
    if (s.headless && (m.spec.job === true || m.spec.interactive === true)) {
      return failure(CLI_MESSAGES.notHeadless, { message: CLI_MESSAGES.notHeadless });
    }

    s.closing = false;
    // P2: a `config-if` line typed in `config-if-range` runs once per port of the range (module header).
    const range = runMode === 'config-if-range' && found.fallback === undefined && m.doPrefix !== true && !specModeAllows(m.spec.mode, 'config-if-range')
      ? rangePortsOf(s.context)
      : undefined;
    if (range !== undefined) return runOnRange(s, dev, line, range, now);
    const ctx = buildCtx(s, dev, effectiveMode, now);
    let outcome: CommandOutcome;
    try {
      outcome = handler(ctx, m.args, m.negated);
    } catch (e) {
      if (e instanceof HeadlessJobRefused) return failure(CLI_MESSAGES.notHeadless, { message: CLI_MESSAGES.notHeadless });
      throw e;
    }
    if (outcome.ask !== undefined) {
      if (s.headless) {
        outcome = { ...(outcome.output !== undefined ? { output: outcome.output } : {}), error: CLI_MESSAGES.notHeadless };
      } else {
        // The next console line answers the question; `resume` runs in the mode this command ran in.
        const filter = m.filter !== undefined && m.spec.filterable === true ? m.filter : undefined;
        askNew(s, outcome.ask.request, resumeAnswer(outcome.ask.resume, effectiveMode, filter), commandDenied);
        outcome = { ...(outcome.output !== undefined ? { output: outcome.output } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}) };
      }
    }

    let handlerOutput = outcome.output ?? '';
    if (m.filter !== undefined && m.spec.filterable === true && handlerOutput !== '') {
      handlerOutput = applyOutputFilter(handlerOutput, m.filter);
    }
    let output = handlerOutput;
    let error: CliError | undefined;
    if (outcome.error !== undefined) {
      error = { message: outcome.error };
      output = output === '' ? outcome.error : `${output}\n${outcome.error}`;
    }

    const closed = s.closing && !s.headless;
    if (s.headless) s.closing = false;
    if (closed && !nested) closeNow(s);
    const r: LineOutcome = { output, handlerOutput, closed, noDevice: false };
    if (error !== undefined) r.error = error;
    return r;
  }

  /**
   * P2: run a `config-if` line on every port of an `interface range` (module header). Each port is matched and run
   * with its own `[['interface', p]]` context in mode `config-if`, so a port that fails the spec's requirement (or
   * an interface arg) is reported by name — `<port>: <message>` — and the others still run. The outcome joins the
   * ports' outputs; its error is the joined errors (the first line's message for a `ConfigureLineResult`).
   */
  function runOnRange(s: SessionState, dev: DeviceRuntime, line: string, ports: readonly PortId[], now: SimTime): LineOutcome {
    const outputs: string[] = [];
    const errors: string[] = [];
    for (const port of ports) {
      const context: string[][] = [['interface', port]];
      const pm = matchCommand(grammar, matchContext(s, dev, 'config-if', context), line);
      if (!pm.ok) {
        errors.push(`${port}: ${pm.error.message}`);
        continue;
      }
      const handler = registry[pm.spec.handler];
      if (handler === undefined) {
        errors.push(`${port}: ${MSG_NO_HANDLER}`);
        continue;
      }
      let outcome: CommandOutcome;
      try {
        outcome = handler(buildCtx(s, dev, 'config-if', now, context), pm.args, pm.negated);
      } catch (e) {
        if (e instanceof HeadlessJobRefused) return failure(CLI_MESSAGES.notHeadless, { message: CLI_MESSAGES.notHeadless });
        throw e;
      }
      if (outcome.output !== undefined && outcome.output !== '') outputs.push(`${port}: ${outcome.output}`);
      if (outcome.error !== undefined) errors.push(`${port}: ${outcome.error}`);
    }
    const handlerOutput = outputs.join('\n');
    const r: LineOutcome = { output: joinOutput(handlerOutput, errors.join('\n')), handlerOutput, closed: false, noDevice: false };
    if (errors.length > 0) r.error = { message: errors.join('\n') };
    return r;
  }

  const result = (s: SessionState, output: string, busy: boolean, error?: CliError, closed?: boolean): CliResult => {
    const r: CliResult = { output, mode: s.mode, prompt: promptOf(s), busy };
    if (error !== undefined) r.error = error;
    if (closed === true) r.closed = true;
    else if (s.pending !== undefined) r.input = { ...s.pending.request };
    return r;
  };

  /** Console form of `runLine`. */
  function execLine(s: SessionState, line: string, mode: CliMode): CliResult {
    const r = runLine(s, line, mode, false);
    if (r.noDevice) {
      return { output: MSG_NO_DEVICE, error: { message: MSG_NO_DEVICE }, mode: s.mode, prompt: '', busy: false, closed: true };
    }
    if (r.closed) return result(s, r.output, false, r.error, true);
    return result(s, r.output, s.busy, r.error);
  }

  // ── headless configure ────────────────────────────────────────────────────

  function configure(device: DeviceId, commands: readonly string[], opts: ConfigureOptions = {}): ConfigureResult {
    const dev = deps.device(device);
    if (dev === undefined) throw new Error(`cannot configure unknown device ${device}`);
    const spec = cliSpecOf(dev.model);
    const atomic = opts.atomic === true;
    const stopOnError = atomic || opts.stopOnError !== false;
    const startContext = copyContext(opts.startContext ?? []);
    if (opts.startMode !== undefined && !modeInGrammar(opts.startMode, spec.grammar)) {
      const message = `% Mode ${opts.startMode} is not available on this device.`;
      return refusedRun(commands, { message }, defaultStartMode(spec.grammar));
    }
    if (startContext.length > 0 && !modeInGrammar('config', spec.grammar)) {
      return refusedRun(commands, { message: '% This device has no configuration contexts to start in.' }, defaultStartMode(spec.grammar));
    }
    /** A start context is entered by replaying its lines, so it gets the same checks as the console (below). */
    const replayContext = startContext.length > 0 && dev.power && dev.bootedAt !== undefined;
    const startMode: CliMode = replayContext
      ? 'config'
      : opts.startMode ?? (startContext.length > 0 ? modeForContext(startContext) ?? defaultStartMode(spec.grammar) : defaultStartMode(spec.grammar));

    nextHeadless++;
    const s: SessionState = {
      id: `${HEADLESS_SESSION_PREFIX}${nextHeadless}`,
      device,
      via: 'console',
      mode: startMode,
      privilege: 15,
      busy: false,
      context: !replayContext && isConfigClassMode(startMode) ? startContext : [],
      history: [],
      closing: false,
      executing: true,
      headless: true,
      applied: 0,
    };
    const before = atomic || replayContext ? dev.running.clone() : undefined;
    const levels = opts.indentation === true ? indentationLevels(commands) : undefined;
    /** frames[k] = session state before the latest line at nesting level k ran (indentation mode). */
    const frames: { mode: CliMode; context: string[][] }[] = [];
    const lines: ConfigureLineResult[] = [];
    let failed = false;
    let reverted = false;

    /** Undo every running-config change made since `before` (processes see the inverse deltas). */
    const revert = (): boolean => {
      if (before === undefined || !dev.power || dev.bootedAt === undefined) return false;
      const changes = dev.running.diffTree(before);
      for (const change of changes) {
        counted(s, dev, () => dev.applyConfigLine(copyContext(change.context), change.line.slice(), change.op === 'unset'));
      }
      return changes.length > 0;
    };

    headlessSessions.set(s.id, s);
    try {
      if (replayContext) {
        // Enter the start context the way the console does (`interface X`, `router ospf 1`, …) so an interface the
        // CLI refuses (console line, repeater port, unknown name) is refused here too.
        // A frame naming an existing port (or a pool, a line, …) is only matched, so entering it writes nothing; a
        // frame the console would create (`interface Loopback3`, a sub-interface) is run and rolled back on failure.
        let refusal: CliError | undefined;
        for (let i = 0; i < startContext.length && refusal === undefined; i++) {
          const frame = startContext[i] as string[];
          const line = frame.join(' ');
          const context = copyContext(startContext.slice(0, i));
          const mode = i === 0 ? 'config' : modeForContext(context) ?? 'config';
          s.mode = mode;
          s.context = context;
          const m = matchCommand(grammar, matchContext(s, dev, mode, context), line);
          if (!m.ok) {
            refusal = { message: `${m.error.message} (start context "${line}")` };
          } else if (m.spec.entersMode === undefined) {
            refusal = { message: `% "${line}" does not open a configuration context.` };
          } else if (frame[0] === 'interface' && existingPort(dev, frame.slice(1).join(' ')) === undefined) {
            const r = runLine(s, line, mode, false);
            if (r.error !== undefined) refusal = { message: `${r.error.message} (start context "${line}")` };
          }
        }
        if (refusal !== undefined) {
          const refused = refusedRun(commands, refusal, 'config');
          if (revert()) refused.reverted = true;
          refused.applied = s.applied;
          return refused;
        }
        s.mode = opts.startMode ?? modeForContext(startContext) ?? 'config';
        s.context = isConfigClassMode(s.mode) ? copyContext(startContext) : [];
      }
      commands.forEach((raw, index) => {
        if (failed && stopOnError) {
          lines.push({ index, line: raw, ok: false, output: '', mode: s.mode, skipped: true });
          return;
        }
        const text = raw.trim();
        if (levels !== undefined) {
          const level = levels.get(index);
          if (level === undefined) {
            lines.push({ index, line: raw, ok: true, output: '', mode: s.mode });
            return;
          }
          if (frames.length > level) {
            const frame = frames[level] as { mode: CliMode; context: string[][] };
            s.mode = frame.mode;
            s.context = copyContext(frame.context);
            frames.length = level;
          }
          while (frames.length <= level) frames.push({ mode: s.mode, context: copyContext(s.context) });
        } else if (text === '') {
          lines.push({ index, line: raw, ok: true, output: '', mode: s.mode });
          return;
        }
        const r = runLine(s, text, s.mode, false);
        const entry: ConfigureLineResult = { index, line: raw, ok: r.error === undefined, output: r.handlerOutput, mode: s.mode };
        if (r.error !== undefined) {
          entry.error = r.error;
          failed = true;
        }
        lines.push(entry);
      });

      if (failed && atomic && before !== undefined && dev.power && dev.bootedAt !== undefined) {
        revert();
        reverted = true;
      }
    } finally {
      headlessSessions.delete(s.id);
    }

    const out: ConfigureResult = {
      ok: lines.every((l) => l.ok && l.skipped !== true),
      lines,
      applied: s.applied,
      finalMode: s.mode,
    };
    if (reverted) out.reverted = true;
    return out;
  }

  // ── public surface ────────────────────────────────────────────────────────

  const runtime: CliRuntime = {
    onOutput(session, text, now) {
      const s = sessions.get(session);
      if (s === undefined) return;
      emitOutput(s, text, now);
    },

    onDone(session, now) {
      const s = sessions.get(session);
      if (s === undefined) return;
      s.busy = false;
      delete s.job;
      if (!s.executing) emitPrompt(s, now);
    },

    onDebugEvent(ev: DebugEvent) {
      const set = debugByDevice.get(ev.device);
      if (set === undefined || set.size === 0) return;
      if (!set.has(ev.category) && !set.has('all')) return;
      const text = `*${formatSimTime(ev.at)}: ${ev.category}: ${ev.message}`;
      for (const s of sessions.values()) {
        if (s.device === ev.device) emitOutput(s, text, ev.at);
      }
    },

    canOpen(device, _via) {
      const dev = deps.device(device);
      if (dev === undefined) return { ok: false, reason: `cannot open a console on unknown device ${device}` };
      if (cliSpecOf(dev.model).shell === 'none') return { ok: false, reason: CLI_MESSAGES.noShell };
      return { ok: true };
    },

    open(device, via) {
      const dev = deps.device(device);
      if (dev === undefined) throw new Error(`cannot open a console on unknown device ${device}`);
      const spec = cliSpecOf(dev.model);
      if (spec.shell === 'none') throw new Error(CLI_MESSAGES.noShell);
      nextSession++;
      const s: SessionState = {
        id: `s_${nextSession}`,
        device,
        via,
        mode: 'user-exec',
        privilege: spec.initialPrivilege,
        busy: false,
        context: [],
        history: [],
        closing: false,
        executing: false,
        headless: false,
        applied: 0,
      };
      sessions.set(s.id, s);
      const now = deps.now();
      const motd = bannerOf(dev.running, 'motd');
      if (motd !== undefined) emitOutput(s, motd, now);
      const loginBanner = startLogin(s, dev);
      if (loginBanner === undefined) {
        const execBanner = bannerOf(dev.running, 'exec');
        if (execBanner !== undefined) emitOutput(s, execBanner, now);
      } else if (loginBanner !== '') {
        emitOutput(s, loginBanner, now);
      }
      emitPrompt(s, now);
      return s.id;
    },

    close(id) {
      sessions.delete(id);
    },

    exec(id, line) {
      const s = sessions.get(id);
      if (s === undefined) {
        return { output: MSG_NO_SESSION, error: { message: MSG_NO_SESSION }, mode: 'user-exec', prompt: '', busy: false, closed: true };
      }
      if (s.pending !== undefined) {
        // An answer: not parsed, not trimmed (only the line ending goes), never recorded in history.
        s.executing = true;
        let r: CliResult;
        try {
          r = answerPending(s, stripLineEnding(line));
        } finally {
          s.executing = false;
        }
        if (r.closed !== true && sessions.has(s.id)) emitPrompt(s, deps.now());
        return r;
      }
      if (s.mode === 'login') {
        // After a denial the console waits in the login stage; any line starts it over.
        const dev = deps.device(s.device);
        if (dev === undefined) {
          closeNow(s);
          return { output: MSG_NO_DEVICE, error: { message: MSG_NO_DEVICE }, mode: s.mode, prompt: '', busy: false, closed: true };
        }
        // The login lines may have been removed meanwhile: then the session goes straight to user EXEC.
        const banner = startLogin(s, dev);
        const r = result(s, banner ?? finishLogin(s, dev).output, s.busy);
        emitPrompt(s, deps.now());
        return r;
      }
      const trimmed = line.trim();
      if (trimmed === '') return result(s, '', s.busy);
      if (s.busy) return result(s, '', true);

      s.history.push(trimmed);
      if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);

      s.executing = true;
      let r: CliResult;
      try {
        r = execLine(s, trimmed, s.mode);
      } finally {
        s.executing = false;
      }
      if (r.closed !== true && sessions.has(s.id)) emitPrompt(s, deps.now());
      return r;
    },

    complete(id, partial) {
      const s = sessions.get(id);
      const dev = s === undefined ? undefined : deps.device(s.device);
      if (s === undefined || dev === undefined) return { items: [], error: { message: MSG_NO_SESSION } };
      if (s.pending !== undefined || s.mode === 'login') return { items: [] };
      return parserComplete(grammar, matchContext(s, dev, matchModeOf(s.mode), matchContextIn(s, s.mode)), partial);
    },

    help(id, partial) {
      const s = sessions.get(id);
      const dev = s === undefined ? undefined : deps.device(s.device);
      if (s === undefined || dev === undefined) return { items: [], error: { message: MSG_NO_SESSION } };
      if (s.pending !== undefined || s.mode === 'login') return { items: [] };
      return parserHelp(grammar, matchContext(s, dev, matchModeOf(s.mode), matchContextIn(s, s.mode)), partial);
    },

    interrupt(id) {
      const s = sessions.get(id);
      if (s === undefined) return;
      const now = deps.now();
      if (s.pending !== undefined) {
        // Drop the question; a login stage stays (the next line starts it over).
        delete s.pending;
        emitPrompt(s, now);
        return;
      }
      if (s.busy) {
        const job = s.job ?? pingJob(s.id);
        const dev = deps.device(s.device);
        if (dev !== undefined) {
          dev.applyActions(CLI_PROCESS_NAME, [{ type: 'request', to: job.process, req: job.abort }], now);
        }
        // The job's `cliDone` normally lands here via onDone; unblock defensively if it did not.
        if (s.busy) {
          s.busy = false;
          delete s.job;
          emitPrompt(s, now);
        }
      } else {
        emitPrompt(s, now);
      }
    },

    session(id) {
      const s = sessions.get(id);
      return s === undefined ? undefined : viewOf(s);
    },

    sessions() {
      const out: CliSessionView[] = [];
      for (const s of sessions.values()) out.push(viewOf(s));
      return out;
    },

    configure,

    counters() {
      return { sessions: nextSession, headless: nextHeadless };
    },

    onPortsRemoved(device, ports) {
      const removed = new Set<PortId>(ports);
      const now = deps.now();
      for (const s of [...sessions.values(), ...headlessSessions.values()]) {
        if (s.device !== device) continue;
        // an `interface range …` entry names its ports from the third token (P2)
        const hit = s.context.some((entry) => contextKeyOf(entry) === 'interface' && entry.slice(1).some((p) => removed.has(p)));
        if (!hit) continue;
        s.mode = 'config';
        s.context = [];
        emitPrompt(s, now);
      }
    },
  };

  return runtime;
}
