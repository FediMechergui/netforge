/**
 * Shared fixture of the approved items' CLI tests (ARCHITECTURE-P3 §7 W2 cli, cli-b): the built-in grammar with the
 * approved fragments appended (until the W2 fold, `GRAMMAR` does not hold them; after it, nothing is appended twice),
 * the handler registry with the approved handlers, a CLI runtime over the recording `FakeDevice`s of
 * cli.runtime.fake.ts, parser contexts and recording command contexts over catalog models, and a tunnel port view.
 * Not a test file itself.
 */
import type { CliMode, CommandCtx, CommandHandler, CommandSpec } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { PortView } from '../src/contracts/port.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { Table, TableName, TableRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR } from '../src/cli/grammar/index.js';
import { P3_APPROVED_GRAMMAR } from '../src/cli/grammar/p3-approved.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { P3_APPROVED_HANDLERS } from '../src/cli/handlers/p3-approved.js';
import { matchCommand, type MatchResult } from '../src/cli/parser.js';
import { createCliRuntime, type CliRuntimeDepsP3, type CliRuntimeP3 } from '../src/cli/runtime.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type MatchContextOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { testPortView } from './cli.parser.fixture.js';
import { harness, type FakeDevice, type Harness } from './cli.runtime.fake.js';

/** The built-in grammar plus every approved spec it does not hold yet (identity comparison: the fold reuses the specs). */
export const APPROVED_GRAMMAR: readonly CommandSpec[] = Object.freeze([
  ...BUILTIN_GRAMMAR,
  ...P3_APPROVED_GRAMMAR.filter((s) => !BUILTIN_GRAMMAR.includes(s)),
]);

/** The handler registry plus the approved handlers. */
export const APPROVED_HANDLERS: Record<string, CommandHandler> = { ...HANDLER_REGISTRY, ...P3_APPROVED_HANDLERS };

/** Parse `line` on a catalog model in `mode` against the approved grammar. */
export function parse(type: string, mode: CliMode, line: string, opts: MatchContextOptions = {}): MatchResult {
  return matchCommand(APPROVED_GRAMMAR, matchContextFor(catalogModel(type), mode, opts), line);
}

/** The handler id `line` parses to (throws with the parser's message when it does not parse). */
export function handlerOf(type: string, mode: CliMode, line: string, opts: MatchContextOptions = {}): string {
  const m = parse(type, mode, line, opts);
  if (!m.ok) throw new Error(`"${line}" did not parse: ${m.error.message}`);
  return m.spec.handler;
}

/** A live view of `Tunnel<n>` (role `tunnel`), for parser contexts and recording command contexts. */
export function tunnelView(name = 'Tunnel0'): PortView {
  return testPortView({ name, short: name.replace('Tunnel', 'Tu'), kind: 'virtual', speedBps: 100_000, role: 'tunnel', encap: 'tunnel' }, { role: 'tunnel' });
}

/** The port views of a router with `Tunnel0` added. */
export function routerPortsWithTunnel(type = 'router.nf2911'): Map<string, PortView> {
  const ports = devicePortViews(catalogModel(type));
  ports.set('Tunnel0', tunnelView());
  return ports;
}

/** A recording command context over a catalog model (config writes land in a real ConfigAst). */
export function approvedCtx(type: string, opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(catalogModel(type), opts);
}

/** Run one approved handler on a recording context. */
export function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): ReturnType<CommandHandler> {
  const h = APPROVED_HANDLERS[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

/** The top-level rendered body of a running config (header and `end` left out). */
export function body(rec: RecordingCtx): string[] {
  return rec.running.render().split('\n').filter((l) => l !== '' && l !== 'end' && !l.startsWith('!') && !l.startsWith('version'));
}

/** A runtime harness whose CLI runs the approved grammar and handlers. */
export interface ApprovedHarness extends Harness {
  cli: CliRuntimeP3;
}

/** A CLI runtime over FakeDevices with the approved grammar (`extra` adds P3 deps such as `remoteOutput`). */
export function approvedHarness(extra: Partial<CliRuntimeDepsP3> = {}): ApprovedHarness {
  const h = harness();
  const cli = createCliRuntime({ ...h.deps, grammar: APPROVED_GRAMMAR, ...extra }, APPROVED_HANDLERS);
  return { ...h, cli };
}

/**
 * Give a FakeDevice extra daemons: the model lists them (a copy installed on the instance: the fake's model is shared)
 * and the process map holds an inert stub for each.
 */
export function withProcesses(d: FakeDevice, ...names: ProcessName[]): FakeDevice {
  const model: DeviceModel = { ...d.model, processes: [...d.model.processes, ...names] };
  Object.defineProperty(d, 'model', { value: model, writable: false, configurable: true });
  for (const name of names) {
    d.processes.set(name, { name, onPdu: () => [], onTimer: () => [], onConfig: () => [], stateSnapshot: () => ({ process: name, state: {} }), debugEvents: () => [] });
  }
  return d;
}

/** Set a FakeDevice's defaults profile (the fake's profile is P2's). */
export function withProfile(d: FakeDevice, profile: DefaultsProfile): FakeDevice {
  Object.defineProperty(d, 'profile', { value: profile, writable: false, configurable: true });
  return d;
}

// ── W3 cli (cli-b): command contexts for the approved items' shows ───────────────────────────────────────────────

/** Options of `showCtx`: table rows by table name, StateViews by daemon, the sim time and any other member. */
export interface ShowCtxOptions {
  readonly rows?: Readonly<Record<string, readonly TableRow[]>>;
  readonly states?: Readonly<Record<string, Record<string, unknown>>>;
  readonly now?: SimTime;
  readonly patch?: Partial<CommandCtx>;
}

/**
 * A command context over a recording one, with the approved items' tables filled from `rows` (fake tables of
 * core/table.ts; a name not given falls back to the recording context's tables), fake StateViews and the sim time.
 */
export function showCtx(rec: RecordingCtx, opts: ShowCtxOptions = {}): CommandCtx {
  const sink = { emit: (): void => undefined };
  const now = opts.now ?? rec.ctx.now;
  const tables = new Map<string, Table<TableRow>>();
  for (const [name, list] of Object.entries(opts.rows ?? {})) {
    const t = createTable<TableRow>({ name, device: 'd_1', sink, now: () => now });
    for (const r of list) t.set(r);
    tables.set(name, t);
  }
  const base = rec.ctx;
  return {
    ...base,
    now,
    tables: {
      cam: base.tables.cam,
      arp: base.tables.arp,
      rib: base.tables.rib,
      get: <R extends TableRow = TableRow>(name: TableName) => (tables.get(name) ?? base.tables.get(name)) as unknown as Table<R> | undefined,
      names: () => [...base.tables.names(), ...tables.keys()],
    },
    processState: (name) => {
      const state = opts.states?.[name];
      return state !== undefined ? { process: name, state } : base.processState(name);
    },
    ...opts.patch,
  };
}

/** Run one approved handler on a command context. */
export function runOn(ctx: CommandCtx, id: string, args: Record<string, string> = {}, negate = false): ReturnType<CommandHandler> {
  const h = APPROVED_HANDLERS[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(ctx, args, negate);
}

/** The output lines of one approved show handler (throws on an error outcome). */
export function showLines(ctx: CommandCtx, id: string, args: Record<string, string> = {}): string[] {
  const out = runOn(ctx, id, args);
  if (out.error !== undefined) throw new Error(`${id}: ${out.error}`);
  return (out.output ?? '').split('\n');
}

/** A catalog model with extra daemons in its process list (the W4 flip adds the approved ones). */
export function modelWith(type: string, ...processes: ProcessName[]): DeviceModel {
  const m = catalogModel(type);
  return { ...m, processes: [...m.processes, ...processes] };
}

/**
 * A catalog model without some daemons (ARCHITECTURE-P3 §9.2 W4: since the catalog flip the catalog models run the
 * approved P3 daemons, so a case about a device that does not run one removes it here).
 */
export function modelWithout(type: string, ...processes: ProcessName[]): DeviceModel {
  const m = catalogModel(type);
  return { ...m, processes: m.processes.filter((p) => !processes.includes(p)) };
}
