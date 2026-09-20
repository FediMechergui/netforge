/**
 * Shared fixtures for the P0.5 grammar and handler tests (ARCHITECTURE-P1 §8.1 W3 cli): catalog models with live
 * port views (fixed, module and auto virtual ports), parser match contexts derived from a model exactly as the
 * runtime derives them (grammar, effective capabilities, selected interface, `resolvePortName`), and a recording
 * `CommandCtx` whose config writes land in a real ConfigAst.
 */
import type { Capability, ModuleInstall, PortRole } from '../src/contracts/catalog.js';
import { expandCapabilities } from '../src/contracts/catalog.js';
import type { CliMode, CommandCtx, PrivilegeLevel, SetModeOptions } from '../src/contracts/cli.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { AirView } from '../src/contracts/medium.js';
import type { RadioPortView } from '../src/contracts/rf.js';
import type { PortSpec, PortState, PortView } from '../src/contracts/port.js';
import type { ProcessRequest, StateView } from '../src/contracts/process.js';
import type { ArpRow, CamRow, Dot11AssocRow, ExtraTableName, RouteRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { ALL_MODELS, ALL_MODULES } from '../src/device/catalog/index.js';
import { modulePortSpecs } from '../src/device/catalog/define.js';
import { resolvePortName, virtualPortName } from '../src/device/catalog/names.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createTable } from '../src/core/table.js';
import type { MatchContext } from '../src/cli/parser.js';
import { testPortView } from './cli.parser.fixture.js';
import { secretsFor } from '../src/cli/runtime.js';

/** The catalog model with this type id (throws for an unknown type). */
export function catalogModel(type: string): DeviceModel {
  const m = ALL_MODELS.find((x) => x.type === type);
  if (m === undefined) throw new Error(`no catalog model ${type}`);
  return m;
}

/** Live-state overrides of one port view. */
export type PortPatch = Partial<Omit<PortState, 'id' | 'spec'>>;

/** Options of `devicePortViews`. */
export interface DevicePortOptions {
  /** Installed modules (slot order). */
  modules?: readonly ModuleInstall[];
  /** Live state per port id (role flips, phy, operUp, transceiver …). */
  patch?: Readonly<Record<PortId, PortPatch>>;
}

/** Effective capabilities of a model with installed modules (CAPABILITIES order). */
export function effectiveCapabilities(model: DeviceModel, modules: readonly ModuleInstall[] = []): readonly Capability[] {
  const added: Capability[] = [];
  for (const m of modules) for (const c of ALL_MODULES.find((x) => x.type === m.module)?.capabilitiesAdded ?? []) added.push(c);
  return expandCapabilities([...(model.capabilities ?? []), ...added]);
}

/** Spec of an auto virtual instance. */
function virtualSpec(family: string, short: string, n: number, role: PortRole): PortSpec {
  return {
    name: virtualPortName({ family }, n),
    short: `${short}${n}`,
    kind: 'virtual',
    speedBps: 1_000_000_000,
    role,
    allowedRoles: [role],
    encap: role === 'svi' ? 'ethernet' : 'none',
    ordinal: 0,
    connector: 'none',
  };
}

/** Port views of a device in canonical order: fixed ports, module ports (slot order), auto virtual instances. */
export function devicePortViews(model: DeviceModel, opts: DevicePortOptions = {}): Map<PortId, PortView> {
  const out = new Map<PortId, PortView>();
  const add = (spec: PortSpec, extra: PortPatch = {}): void => {
    const view: PortView = { ...testPortView(spec), ...extra, ...(opts.patch?.[spec.name] ?? {}) };
    out.set(spec.name, view);
  };
  for (const spec of model.ports) add(spec);
  for (const install of opts.modules ?? []) {
    const slot = (model.slots ?? []).find((s) => s.id === install.slot);
    const module = ALL_MODULES.find((m) => m.type === install.module);
    if (slot === undefined || module === undefined) throw new Error(`bad module install ${install.slot}/${install.module}`);
    if (module.transceiver !== undefined && slot.cage !== undefined) {
      const cage = out.get(slot.cage);
      if (cage !== undefined) out.set(slot.cage, { ...cage, transceiver: module.type });
      continue;
    }
    for (const spec of modulePortSpecs(model, slot, module)) add(spec, { module: install });
  }
  for (const fam of model.virtualFamilies ?? []) {
    for (const n of fam.auto ?? []) add(virtualSpec(fam.family, fam.short, n, fam.role));
  }
  return out;
}

/** Options of `matchContextFor`. */
export interface MatchContextOptions {
  privilege?: PrivilegeLevel;
  /** Selected interface by id (config-if). */
  iface?: PortId;
  /** Selected interface view (overrides `iface`). */
  ifaceView?: PortView;
  ports?: Map<PortId, PortView>;
  modules?: readonly ModuleInstall[];
}

/** A parser context for a catalog model the way the runtime builds it. */
export function matchContextFor(model: DeviceModel, mode: CliMode, opts: MatchContextOptions = {}): MatchContext {
  const ports = opts.ports ?? devicePortViews(model, { modules: opts.modules ?? [] });
  const grammar = model.cli?.grammar ?? 'nfos';
  const privilege = opts.privilege ?? (grammar === 'host' ? 15 : mode === 'user-exec' ? 1 : 15);
  const source = { model, ports };
  const c: MatchContext = {
    mode,
    privilege,
    grammar,
    capabilities: effectiveCapabilities(model, opts.modules),
    resolveInterface: (name) => {
      const r = resolvePortName(source, name);
      return r.kind === 'existing' ? r.port : undefined;
    },
    resolvePort: (name) => resolvePortName(source, name),
    portView: (id) => ports.get(id),
    listInterfaces: () => [...ports.keys()],
  };
  if (opts.ifaceView !== undefined) c.iface = opts.ifaceView;
  else if (opts.iface !== undefined) {
    const view = ports.get(opts.iface);
    if (view === undefined) throw new Error(`no port ${opts.iface} on ${model.type}`);
    c.iface = view;
  }
  return c;
}

/** One recorded `ctx.config` call. */
export interface RecordedConfig {
  line: string[];
  negate: boolean;
  context: string[][] | undefined;
}

/** Options of `commandCtxFor`. */
export interface CommandCtxOptions {
  mode?: CliMode;
  privilege?: PrivilegeLevel;
  iface?: PortId;
  /** Context stack of a sub-mode that is not an interface (`[['ip','dhcp','pool','LAN']]`, `[['line','con','0']]`). */
  context?: readonly (readonly string[])[];
  ports?: Map<PortId, PortView>;
  modules?: readonly ModuleInstall[];
  /** What the device's radios hear (default: nothing). */
  air?: AirView;
  /** Live RF view of a radio port (default: none). */
  radioView?: (port: PortId) => RadioPortView | undefined;
  ensureVirtualPort?: (name: PortId) => { ok: true; port: PortId; created: boolean } | { ok: false; error: string };
  removeVirtualPort?: (name: PortId) => { ok: boolean; error?: string };
  processStates?: Readonly<Record<string, StateView>>;
  /** Returned by every `ctx.config` call (undefined = success). */
  configError?: string;
  running?: ConfigAst;
  startup?: ConfigAst;
  hostname?: string;
}

/** A recording CommandCtx and what it recorded. */
export interface RecordingCtx {
  ctx: CommandCtx;
  ports: Map<PortId, PortView>;
  running: ConfigAst;
  configCalls: RecordedConfig[];
  enterModeCalls: { mode: CliMode; opts: SetModeOptions | undefined }[];
  setModeCalls: { mode: CliMode; iface: PortId | undefined }[];
  requests: { to: string; req: ProcessRequest }[];
  deviceCalls: string[];
  closed: { value: boolean };
  assoc: Table<Dot11AssocRow>;
  arp: Table<ArpRow>;
  /** The P1 extra tables (nd, rib6, sockets, dhcp-bindings, dns-cache, dot11-assoc), by name. */
  extra: Map<TableName, Table<TableRow>>;
  /** One extra table, typed (`table<SocketRow>('sockets')`). */
  table<R extends TableRow = TableRow>(name: TableName): Table<R>;
}

/** Build a recording `CommandCtx` for a catalog model. Config writes are applied to `running` (a real ConfigAst). */
export function commandCtxFor(model: DeviceModel, opts: CommandCtxOptions = {}): RecordingCtx {
  const ports = opts.ports ?? devicePortViews(model, { modules: opts.modules ?? [] });
  const mode: CliMode = opts.mode ?? (opts.iface !== undefined ? 'config-if' : 'config');
  const grammar = model.cli?.grammar ?? 'nfos';
  const privilege = opts.privilege ?? 15;
  const sink = { emit: (): void => undefined };
  const now = (): number => 0;
  const cam = createTable<CamRow>({ name: 'cam', device: 'd_1', sink, now });
  const arp = createTable<ArpRow>({ name: 'arp', device: 'd_1', sink, now });
  const rib = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink, now });
  const assoc = createTable<Dot11AssocRow>({ name: 'dot11-assoc', device: 'd_1', sink, now });
  const running = opts.running ?? createConfigAst();
  const configCalls: RecordedConfig[] = [];
  const enterModeCalls: RecordingCtx['enterModeCalls'] = [];
  const setModeCalls: RecordingCtx['setModeCalls'] = [];
  const requests: RecordingCtx['requests'] = [];
  const deviceCalls: string[] = [];
  const closed = { value: false };
  const defaultContext = (): string[][] =>
    opts.context !== undefined ? opts.context.map((e) => [...e]) : opts.iface !== undefined ? [['interface', opts.iface]] : [];
  // Every extra table a P1 model may own, so the show handlers of the feature fragments have something to read.
  const extra = new Map<TableName, Table<TableRow>>([['dot11-assoc', assoc as unknown as Table<TableRow>]]);
  const extraNames: readonly ExtraTableName[] = ['nd', 'rib6', 'sockets', 'dhcp-bindings', 'dns-cache'];
  for (const name of extraNames) extra.set(name, createTable<TableRow>({ name, device: 'd_1', sink, now }));

  const session: CommandCtx['session'] = {
    id: 's_1', device: 'd_1', via: 'console', mode, privilege, prompt: `R1${mode}`, busy: false, history: [], grammar,
  };
  if (opts.iface !== undefined) session.iface = opts.iface;
  session.context = defaultContext();

  const device: CommandCtx['device'] = {
    setHostname: (name) => { deviceCalls.push(`setHostname ${name}`); },
    saveConfig: () => { deviceCalls.push('saveConfig'); },
    eraseStartup: () => { deviceCalls.push('eraseStartup'); },
    reload: () => { deviceCalls.push('reload'); },
    setPortAdmin: (port, up) => { deviceCalls.push(`setPortAdmin ${port} ${up}`); },
    clearTable: (name) => { deviceCalls.push(`clearTable ${name}`); },
    ensureVirtualPort: (name) => {
      deviceCalls.push(`ensureVirtualPort ${name}`);
      return opts.ensureVirtualPort?.(name) ?? { ok: true, port: name, created: true };
    },
    removeVirtualPort: (name) => {
      deviceCalls.push(`removeVirtualPort ${name}`);
      return opts.removeVirtualPort?.(name) ?? { ok: true };
    },
    setPortRole: (port, role) => {
      deviceCalls.push(`setPortRole ${port} ${role}`);
      return { ok: true };
    },
  };

  const ctx: CommandCtx = {
    now: 0,
    session,
    deviceId: 'd_1',
    hostname: opts.hostname ?? 'R1',
    model,
    ports,
    tables: {
      cam, arp, rib,
      get: <R extends TableRow = TableRow>(name: TableName) => extra.get(name) as unknown as Table<R> | undefined,
      names: () => ['cam', 'arp', 'rib', ...extra.keys()],
    },
    running,
    startup: opts.startup,
    uptime: 0,
    processState: (name) => opts.processStates?.[name],
    config: (line, negate, context) => {
      configCalls.push({ line: [...line], negate, context: context ? context.map((c) => [...c]) : undefined });
      if (opts.configError !== undefined) return opts.configError;
      const where = context ?? defaultContext();
      if (negate) running.unset(where, line);
      else running.set(where, line);
      return undefined;
    },
    resolvePort: (name) => {
      const r = resolvePortName({ model, ports }, name);
      return r.kind === 'existing' ? r.port : undefined;
    },
    request: (to, req) => { requests.push({ to, req }); },
    act: () => undefined,
    device,
    setMode: (m, iface) => { setModeCalls.push({ mode: m, iface }); },
    setPrivilege: (level) => { deviceCalls.push(`setPrivilege ${level}`); },
    block: () => { deviceCalls.push('block'); },
    closeSession: () => { closed.value = true; },
    grammar,
    capabilities: new Set(effectiveCapabilities(model, opts.modules)),
    context: defaultContext(),
    headless: false,
    enterMode: (m, o) => { enterModeCalls.push({ mode: m, opts: o }); },
    radioView: (port) => opts.radioView?.(port),
    air: opts.air ?? { visibleBss: () => [], link: () => undefined },
    secrets: secretsFor('d_1'),
  };
  if (opts.iface !== undefined) (ctx as { iface?: PortView }).iface = ports.get(opts.iface);
  const table = <R extends TableRow = TableRow>(name: TableName): Table<R> => {
    const t = extra.get(name);
    if (t === undefined) throw new Error(`no ${name} table in the fixture`);
    return t as unknown as Table<R>;
  };
  return { ctx, ports, running, configCalls, enterModeCalls, setModeCalls, requests, deviceCalls, closed, assoc, arp, extra, table };
}
