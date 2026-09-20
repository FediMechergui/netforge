/**
 * CLI emulation subsystem (spec §7; ARCHITECTURE-P1 D2, D9, §3.10, §3.12–§3.13).
 *
 * Commands are DATA (§7.2): a tree of `CommandSpec`s with typed args, modes,
 * privilege levels and a handler id. From that one table the runtime derives
 * `?` help, tab completion, `%` error messages with a caret, and per-mode
 * availability.
 *
 * The line editor (history, ^A/^E/^W/^U, keystroke echo) lives in the
 * terminal adapter on the UI side. The engine receives WHOLE LINES via `exec`
 * and answers completion/help queries for partial lines. Command output that
 * arrives over sim time (ping replies) is streamed as `cliOutput` trace events
 * while the session is `busy`; `interrupt` implements ^Shift+6 / ^C.
 *
 * SCOPING (P0.5, D2): a spec is available iff its mode and privilege allow it AND the device's
 * `cli.grammar` ∈ `grammars` (default DEFAULT_GRAMMARS) AND every `requires` capability and at least
 * one `requiresAny` capability is in the device's EFFECTIVE capabilities (`DeviceRuntime.capabilities`).
 * `portRequires` is evaluated against the session's selected interface: failing specs are hidden from
 * `?` and Tab, and a line typed in full returns `portRequires.mismatch ?? CLI_MESSAGES.portUnsupported`
 * at the column of the spec's first literal. (The P0 `kinds` gate was deleted at the P0.5 exit gate.)
 * Scope results are cached per (grammar, mode, privilege, capability set, portsVersion).
 *
 * LEGAL (spec §1.6): command SYNTAX may mirror IOS; help strings, error
 * messages, banners and `show` output wording MUST be original. Do not copy
 * vendor text verbatim.
 */
import type { DeviceId, PortId, PortRef, ProcessName, SessionId } from './ids.js';
import type { ConfigAst } from './config.js';
import type { Action, DebugEvent, ProcessRequest, StateView } from './process.js';
import type { PortKind, PortView } from './port.js';
import type { RadioPortView } from './rf.js';
import type { AirView } from './medium.js';
import type { DeviceTables, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { DeviceCatalog, DeviceModel, DeviceRuntime } from './device.js';
import type { TraceSink } from './trace.js';
import type { BuildStage, Capability, CliGrammar, PortRole } from './catalog.js';

export type CliMode =
  | 'user-exec'
  | 'priv-exec'
  | 'config'
  | 'config-if'
  | 'config-line'
  // ── P0.5 / P1 ──
  | 'login'
  | 'dhcp-config'
  | 'config-router'
  | 'config-subif'
  | 'config-vlan'
  | (string & {});

export type PrivilegeLevel = 0 | 1 | 15;

export type ArgType =
  | 'word' // any single token
  | 'int'
  | 'ipv4'
  | 'ipv4-mask' // dotted mask
  | 'ipv4-prefix' // a.b.c.d/len
  | 'mac'
  | 'interface' // short or long port name, completed from the device's ports
  | 'rest' // everything to end of line (banner text, description)
  | 'choice'
  // ── P1 ──
  | 'ipv6' // X:X:X:X::X, normalised to RFC 5952
  | 'ipv6-prefix' // X:X:X:X::X/<0-128>
  | 'ip' // IPv4 or IPv6
  | 'host' // IPv4, IPv6 or DNS name (ping, tracert, nslookup)
  | 'hostname' // DNS label / FQDN
  | 'url'
  | 'hex'
  | 'secret' // the terminal may mask; stored hashed where the rule says so
  | 'int-range' // 1-4,7
  | 'quoted'; // "text with spaces" or one token

/** Dynamic completion sources for args. */
export type CompletionSource = 'interfaces' | 'host-adapters' | 'virtual-interfaces' | 'ssids-seen' | 'dhcp-pools' | (string & {});

/** Per-port requirement evaluated against the session's selected interface (top `interface` context entry). */
export interface PortRequirement {
  /** Live effective role must be one of these (after `no switchport` etc.). */
  roles?: readonly PortRole[];
  kinds?: readonly PortKind[];
  /** Serial: the attached cable end must be DCE (true) or DTE (false) — `PortState.phy.dce`. */
  dce?: boolean;
  /** Original message printed when the command is typed in full on a non-matching port. */
  mismatch?: string;
}

export interface ArgSpec {
  type: ArgType;
  help: string;
  choices?: readonly string[];
  min?: number;
  max?: number;
  optional?: boolean;
  /** @since P0.5 Dynamic completion from device state. */
  completion?: CompletionSource;
  /** @since P0.5 Extra JS RegExp source (no flags) the token must fully match. */
  pattern?: string;
  /** @since P0.5 For 'interface' args: only ports satisfying this are valid and completed. */
  portFilter?: PortRequirement;
  /** @since P0.5 */
  maxLength?: number;
}

/**
 * A command. `path` tokens are literals unless wrapped in `<>` which names an
 * arg from `args`. Literals may be abbreviated by the user to any unambiguous
 * prefix (IOS behaviour). Example:
 *   { path: ['ip','address','<addr>','<mask>'], mode: 'config-if', ... }
 * `mode` may also name a class selector ('@exec' | '@config' | '@auth' | '@all') from P0.5.
 */
export interface CommandSpec {
  path: readonly string[];
  mode: CliMode | readonly CliMode[];
  privilege: PrivilegeLevel;
  /** Help shown for the LAST literal token of `path` in `?` listings. Original wording. */
  help: string;
  args?: Readonly<Record<string, ArgSpec>>;
  /** Executing this command changes the session mode (e.g. `configure terminal` → 'config'). */
  entersMode?: CliMode;
  /** Whether `no <path>` is accepted. */
  allowNo?: boolean;
  /** Handler id resolved by the CLI runtime's handler registry. */
  handler: string;
  /** Curriculum objective tags (spec §2.8). */
  objectives?: readonly string[];
  /** If true, this command is a NetForge extension, marked as non-standard in help (spec §7.6). */
  extension?: boolean;
  /** Output may be piped through `| section|include|exclude|begin <pattern>`; the parser handles the filter generically. */
  filterable?: boolean;
  /** Constant args merged into the handler's `args` (e.g. `debug ip icmp` → `{ category: 'ip icmp' }`), so several literal paths can share one handler. */
  fixedArgs?: Readonly<Record<string, string>>;
  /** When negated (`no <path>`), the command's args may be omitted (`no ip address`, `no description`). */
  noArgsOptional?: boolean;

  // ── P0.5 scoping and behaviour flags ──
  /** @since P0.5 Grammars the spec exists in (default DEFAULT_GRAMMARS). Host-shell specs: ['host']; network OS specs: ['nfos']. */
  grammars?: readonly CliGrammar[];
  /** @since P0.5 All of these effective capabilities are required. */
  requires?: readonly Capability[];
  /** @since P0.5 At least one of these effective capabilities is required. */
  requiresAny?: readonly Capability[];
  /** @since P0.5 Selected-interface requirement (config-if family). */
  portRequires?: PortRequirement;
  /** @since P0.5 Starts a blocking job (ping, tracert, nslookup, renew); refused in headless configure. */
  job?: boolean;
  /** @since P1 May ask for input (password, confirm); refused in headless configure. */
  interactive?: boolean;
  /** @since P0.5 Changes session state beyond config (derives `do` blocking): 'enter-mode' | 'privilege' | 'close'. */
  sessionEffect?: 'enter-mode' | 'privilege' | 'close';
  /** @since P0.5 Executable but excluded from `?` listings (compatibility aliases). */
  hidden?: boolean;
  /** @since P0.5 Stage the spec ships in (grammar goldens per stage). */
  since?: BuildStage;
}

/** Grammars a spec applies to when `grammars` is omitted (P0 kind-less semantics). */
export const DEFAULT_GRAMMARS: readonly CliGrammar[] = ['nfos', 'host'];

export interface CliError {
  /** Original wording, e.g. "Unrecognized command", "Incomplete command", "Invalid input detected at the marked position". */
  message: string;
  /** 0-based column of the offending token, for the caret line. Undefined for incomplete-command errors. */
  column?: number;
}

/** @since P1 Input the session waits for (the next exec line is the answer; not parsed, not recorded in history). */
export interface CliInputRequest {
  kind: 'secret' | 'text' | 'confirm';
  /** Original wording, e.g. 'Password: '. */
  prompt: string;
}

export interface CliResult {
  /** Text to print (may be empty). No trailing prompt — the terminal adds it from `prompt`. */
  output: string;
  error?: CliError;
  mode: CliMode;
  prompt: string;
  /** True when the command started a job (ping) and the session waits for `cliDone`. */
  busy: boolean;
  /** Session was closed by this command (`exit` at user-exec / `logout`). */
  closed?: boolean;
  /** @since P1 The terminal must mask (secret) / expect y/n (confirm) for the next line. */
  input?: CliInputRequest;
}

export interface CliCompletionItem {
  token: string;
  help: string;
  /** Arg placeholders (e.g. `A.B.C.D`) are not completable. */
  isArg?: boolean;
}

export interface CliCompletion {
  /** Candidates for the current partial token. Empty when `error` is set. */
  items: CliCompletionItem[];
  /** If exactly one literal completes, the text to append to the line. */
  insert?: string;
  /** `<cr>` is a valid completion (the line is executable as-is). */
  cr?: boolean;
  /**
   * Set when `partial` cannot be parsed up to the cursor (unrecognized or
   * ambiguous token, wrong mode/privilege). `items` is then empty and the
   * terminal prints `message` with a caret at `column`, exactly as for `exec`
   * errors. Original wording (spec §1.6).
   */
  error?: CliError;
}

/** @since P0.5 A blocking job; `interrupt` sends `abort` to `process`. */
export interface CliJob {
  process: ProcessName;
  abort: ProcessRequest;
  /** Short label for the terminal status line, e.g. 'ping', 'tracert'. */
  label: string;
}

export interface CliSessionView {
  id: SessionId;
  device: DeviceId;
  via: 'console' | 'vty';
  mode: CliMode;
  privilege: PrivilegeLevel;
  prompt: string;
  busy: boolean;
  /** Interface selected in config-if mode. */
  iface?: PortId;
  history: string[];
  /** @since P0.5 Grammar of the session. */
  grammar: CliGrammar;
  /** @since P0.5 Mode path, outermost first (`[['interface','Gi0/0']]`, `[['ip','dhcp','pool','LAN']]`); absent in exec modes. */
  context?: string[][];
  /** @since P1 Pending input request. */
  input?: CliInputRequest;
  /** @since P0.5 Running job. */
  job?: { process: ProcessName; label: string };
}

/** Constructor dependencies for `cli/runtime.ts` (`createCliRuntime(deps)`), supplied by the Simulation. */
export interface CliRuntimeDeps {
  device(id: DeviceId): DeviceRuntime | undefined;
  catalog: DeviceCatalog;
  trace: TraceSink;
  /** Current sim time (the `at` of the event being dispatched, or `Simulation.now` between events). */
  now(): SimTime;
  /** @since P0.5 Grammar injection (fragments, focused tests). Default: the full built-in grammar. */
  grammar?: readonly CommandSpec[];
  /** @since P0.5 Live RF view of a radio port (the link model's `radioPortView`); feeds `CommandCtx.radioView`. */
  radioView(ref: PortRef): RadioPortView | undefined;
  /** @since P0.5 RF view of a device's radios (the link model's `airView`); feeds `CommandCtx.air`. */
  airView(device: DeviceId): AirView;
}

/** @since P0.5 Options of a headless configure run (D9). */
export interface ConfigureOptions {
  /** Default: grammar nfos → 'config' (as after `enable` + `configure terminal`); grammar host → 'user-exec'. */
  startMode?: CliMode;
  startContext?: string[][];
  /** Pasted-config semantics: leading-space depth selects the context level before each line. */
  indentation?: boolean;
  /** Default true: lines after the first error are reported `skipped`. */
  stopOnError?: boolean;
  /** Revert every applied delta (inverse `diffTree` changes, applied through the runtime) when any line fails. Implies stopOnError. Default false. */
  atomic?: boolean;
}

export interface ConfigureLineResult {
  index: number;
  line: string;
  ok: boolean;
  /** Captured handler output (never emitted as trace). */
  output: string;
  /** Parser/handler error with caret column (same wording as the console). */
  error?: CliError;
  /** Mode after the line. */
  mode: CliMode;
  /** Not run because an earlier line failed. */
  skipped?: boolean;
}

export interface ConfigureResult {
  /** True iff every line ran and succeeded. */
  ok: boolean;
  lines: ConfigureLineResult[];
  /** configChange events emitted for the device during the call (after any revert). */
  applied: number;
  /** Set when `atomic` reverted the applied changes (processes saw set-then-unset deltas). */
  reverted?: boolean;
  /** Mode the headless session ended in. */
  finalMode: CliMode;
}

/** Public surface used by the Simulation facade and the worker bridge. */
export interface CliRuntime {
  /**
   * Fed by the Simulation from `DeviceRuntimeDeps.cliSink`: asynchronous output for a
   * session (ping progress). Emits a `cliOutput` trace event.
   */
  onOutput(session: SessionId, text: string, now: SimTime): void;
  /** A job finished: unblock the session, emit `cliPrompt` (busy=false). */
  onDone(session: SessionId, now: SimTime): void;
  /**
   * Fed by the Simulation for every `debug` trace event: if any console/vty session on that
   * device has `debug <category>` enabled, print the line to those sessions (`cliOutput`).
   */
  onDebugEvent(ev: DebugEvent): void;
  /** Open a console/vty session. From P0.5 throws Error(CLI_MESSAGES.noShell) when `model.cli.shell === 'none'`. */
  open(device: DeviceId, via: 'console' | 'vty'): SessionId;
  close(id: SessionId): void;
  exec(id: SessionId, line: string): CliResult;
  /** Tab completion for `partial` (text before the cursor). Returns `error` instead of items if `partial` is not parseable. */
  complete(id: SessionId, partial: string): CliCompletion;
  /** `?` help for `partial`. Same shape as completion; `partial` ending in a space lists next tokens. Returns `error` (with column) for an unrecognized or ambiguous line. */
  help(id: SessionId, partial: string): CliCompletion;
  /** ^Shift+6 / ^C: send the job's abort request (P0: `icmp.abort` to icmpv4), clear pending input, unblock the session. */
  interrupt(id: SessionId): void;
  session(id: SessionId): CliSessionView | undefined;
  sessions(): CliSessionView[];
  /** @since P0.5 Whether a console/vty can be opened (shell 'none' → ok:false with CLI_MESSAGES.noShell). */
  canOpen(device: DeviceId, via: 'console' | 'vty'): { ok: true } | { ok: false; reason: string };
  /** @since P0.5 D9 headless configure (see `Simulation.configure`). */
  configure(device: DeviceId, commands: readonly string[], opts?: ConfigureOptions): ConfigureResult;
  /** @since P0.5 Module removal: sessions in a sub-mode of a removed port drop to 'config'. */
  onPortsRemoved(device: DeviceId, ports: readonly PortId[]): void;
}

/** @since P0.5 Options of `CommandCtx.enterMode`. */
export interface SetModeOptions {
  /** config-if family: the selected interface. */
  iface?: PortId;
  /** Append one context entry (e.g. ['ip','dhcp','pool','LAN']). */
  push?: readonly string[];
  /** Replace the whole context stack. */
  context?: readonly (readonly string[])[];
}

/** What a command handler can see and do. Handlers are synchronous; async work goes through process requests. */
export interface CommandCtx {
  readonly now: SimTime;
  readonly session: CliSessionView;
  readonly deviceId: DeviceId;
  readonly hostname: string;
  readonly model: DeviceModel;
  readonly ports: ReadonlyMap<PortId, PortView>;
  readonly tables: DeviceTables;
  readonly running: ConfigAst;
  readonly startup: ConfigAst | undefined;
  readonly uptime: SimTime;
  /** Process state snapshots by name. */
  processState(name: string): StateView | undefined;
  /**
   * Apply a config line. Default context is the session's context stack (P0: `[]` in exec/config,
   * `[['interface',iface]]` in config-if). `context` overrides it — used by the host shell, which has no
   * config modes, so `ip address A M [GW]` is stored in the same shape a router produces.
   * Pass-through to `DeviceRuntime.applyConfigLine(context, line, negate)`. Returns an error message on failure.
   */
  config(line: string[], negate: boolean, context?: string[][]): string | undefined;
  /** Resolve a port name typed by the user. */
  resolvePort(name: string): PortId | undefined;
  /** Ask a process to do something (ping, clear arp, ...). */
  request(to: string, req: ProcessRequest): void;
  /** Apply raw actions (rarely needed; prefer request). */
  act(actions: Action[]): void;
  /** Device-level operations. */
  device: {
    setHostname(name: string): void;
    saveConfig(): void; // copy running startup
    eraseStartup(): void;
    reload(): void;
    setPortAdmin(port: PortId, up: boolean): void;
    /** Clear a table by name (P0 runtime: 'arp' | 'cam'; P1 adds nd, dhcp-bindings, dns-cache). */
    clearTable(name: TableName): void;
    /** @since P0.5 `interface VlanN` / `LoopbackN`. */
    ensureVirtualPort(name: PortId): { ok: true; port: PortId; created: boolean } | { ok: false; error: string };
    /** @since P0.5 `no interface VlanN` / `LoopbackN`. */
    removeVirtualPort(name: PortId): { ok: boolean; error?: string };
    /** @since P0.5 `switchport` / `no switchport` (runtime special case; see ARCHITECTURE-P1 §3.10). */
    setPortRole(port: PortId, role: PortRole): { ok: boolean; error?: string };
  };
  /** Session-level operations. P0 form: `iface` only for config-if. */
  setMode(mode: CliMode, iface?: PortId): void;
  setPrivilege(level: PrivilegeLevel): void;
  /** Mark the session busy until a `cliDone` action arrives. No argument = P0 ping job {process:'icmpv4', abort: icmp.abort}. */
  block(job?: CliJob): void;
  closeSession(): void;

  // ── P0.5 ──
  /** @since P0.5 Grammar of the device (headless sessions use it even when shell is 'none'). */
  readonly grammar: CliGrammar;
  /** @since P0.5 Effective capabilities. */
  readonly capabilities: ReadonlySet<Capability>;
  /** @since P0.5 Current context stack, outermost first. */
  readonly context: readonly (readonly string[])[];
  /** @since P0.5 Selected interface in interface-context modes. */
  readonly iface?: PortView;
  /** @since P0.5 True inside `Simulation.configure`. */
  readonly headless: boolean;
  /** @since P0.5 Enter a mode with context (sub-modes beyond config-if). */
  enterMode(mode: CliMode, opts?: SetModeOptions): void;
  /** @since P0.5 Live RF view of one of this device's radio ports (band/channel in use, peer, signal, rate). */
  radioView(port: PortId): RadioPortView | undefined;
  /** @since P0.5 What this device's station radios hear right now (the same view daemons get as `ProcessCtx.air`). */
  readonly air: AirView;
  /** @since P1 Hash/verify secrets (`nf1$<16 hex>` = FNV-1a-64 of device-id salt + plain); deterministic. */
  readonly secrets: { hash(plain: string): string; verify(stored: string, plain: string): boolean };
}

export interface CommandOutcome {
  output?: string;
  error?: string;
  /** @since P1 Ask for input and continue in `resume` (the next exec line is `answer`; `attempt` starts at 1). */
  ask?: { request: CliInputRequest; resume: (ctx: CommandCtx, answer: string, attempt: number) => CommandOutcome };
}

export type CommandHandler = (ctx: CommandCtx, args: Record<string, string>, negate: boolean) => CommandOutcome;

/** Prompt suffixes per mode (original but conventional). Derived from MODES for P0.5 modes. */
export const MODE_PROMPT: Readonly<Record<string, string>> = {
  'user-exec': '>',
  'priv-exec': '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-line': '(config-line)#',
  login: '>',
  'dhcp-config': '(dhcp-config)#',
  'config-router': '(config-router)#',
  'config-subif': '(config-subif)#',
  'config-vlan': '(config-vlan)#',
};

/** @since P0.5 Mode classes: `exit` pops a config-class mode to its parent; `end` returns to priv-exec; `do` works only in config class. */
export type ModeClass = 'exec' | 'config' | 'auth';
/** @since P0.5 Class selectors accepted in `CommandSpec.mode`. */
export type ModeClassSelector = '@exec' | '@config' | '@auth' | '@all';

/** @since P0.5 One CLI mode (replaces EXEC_MODES/CONFIG_MODES/ALL_MODES, isConfigMode, isSubConfigMode, DO_BLOCKED_HANDLERS). */
export interface ModeDef {
  name: CliMode;
  class: ModeClass;
  /** Mode `exit` returns to (config class). Exec-class `exit` closes the session (P0). */
  parent?: CliMode;
  /** Suffix appended to the hostname. */
  prompt: string;
  /** Head of the context entry pushed on entry: 'interface' | 'line' | 'ip dhcp pool' | 'router' | 'vlan'. */
  contextKey?: string;
  grammars: readonly CliGrammar[];
  /** Registered but unreachable until a grammar enters it. */
  reserved?: boolean;
}

export const MODES: Readonly<Record<string, ModeDef>> = Object.freeze({
  'user-exec': { name: 'user-exec', class: 'exec', prompt: '>', grammars: ['nfos', 'host'] },
  'priv-exec': { name: 'priv-exec', class: 'exec', parent: 'user-exec', prompt: '#', grammars: ['nfos'] },
  login: { name: 'login', class: 'auth', prompt: '>', grammars: ['nfos'] },
  config: { name: 'config', class: 'config', parent: 'priv-exec', prompt: '(config)#', grammars: ['nfos'] },
  'config-if': { name: 'config-if', class: 'config', parent: 'config', prompt: '(config-if)#', contextKey: 'interface', grammars: ['nfos'] },
  'config-line': { name: 'config-line', class: 'config', parent: 'config', prompt: '(config-line)#', contextKey: 'line', grammars: ['nfos'] },
  'dhcp-config': { name: 'dhcp-config', class: 'config', parent: 'config', prompt: '(dhcp-config)#', contextKey: 'ip dhcp pool', grammars: ['nfos'] },
  'config-router': { name: 'config-router', class: 'config', parent: 'config', prompt: '(config-router)#', contextKey: 'router', grammars: ['nfos'], reserved: true },
  'config-subif': { name: 'config-subif', class: 'config', parent: 'config', prompt: '(config-subif)#', contextKey: 'interface', grammars: ['nfos'], reserved: true },
  'config-vlan': { name: 'config-vlan', class: 'config', parent: 'config', prompt: '(config-vlan)#', contextKey: 'vlan', grammars: ['nfos'], reserved: true },
});

/** @since P0.5 Debug categories are data (`debug <category>` grammar and validation derive from the registry). */
export interface DebugCategoryDef {
  category: string;
  help: string;
  requiresAny?: readonly Capability[];
  since?: BuildStage;
}

/** @since P0.5 Headless configure session ids are `${HEADLESS_SESSION_PREFIX}<n>` from a separate counter (P0 `s_<n>` ids unchanged). */
export const HEADLESS_SESSION_PREFIX = 'h_';

/** @since P0.5 Cross-module CLI wording (original). */
export const CLI_MESSAGES = Object.freeze({
  /** `cli.open` on a device whose shell is 'none'. */
  noShell: 'This device has no command line. Use its settings panel in the inspector instead.',
  /** A job or interactive command inside `Simulation.configure`. */
  notHeadless: 'This command waits for the network or asks questions, so it cannot run from a settings panel. Use a terminal.',
  /** A spec whose `portRequires` does not match the selected interface. */
  portUnsupported: '% This command does not apply to the selected interface.',
  /** `ip address` on a switched port of a multilayer switch. */
  switchedPort: '% This interface is switched. Enter "no switchport" first to give it an address.',
  /** `no switchport` on a port whose allowedRoles lack 'routed'. */
  roleLocked: '% This interface cannot change between switched and routed operation.',
});
