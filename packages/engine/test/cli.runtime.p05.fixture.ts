/**
 * Test double for the P0.5 parts of `cli/runtime.ts` (context stack, fallback, jobs, headless configure,
 * canOpen, onPortsRemoved): a recording `DeviceRuntime` over REAL catalog models (capabilities, CliSpec,
 * hostPorts, virtual families come from `defineModel`), a focused grammar injected through
 * `CliRuntimeDeps.grammar`, and the handlers behind it. Independent of the built-in grammar fragments so the
 * runtime behaviour is pinned on its own. Not a test file itself.
 */
import type { Capability, HardwareResult, ModuleType, PortRole, SlotId } from '../src/contracts/catalog.js';
import type { PortPhySettings } from '../src/contracts/link.js';
import type { CliRuntime, CommandHandler, CommandSpec } from '../src/contracts/cli.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceModel, DeviceRuntime, DeviceSpec, PortResolution } from '../src/contracts/device.js';
import type { DeviceId, PortId, ProcessName } from '../src/contracts/ids.js';
import type { PortSpec, PortState } from '../src/contracts/port.js';
import type { Action, Process, StateView } from '../src/contracts/process.js';
import type { ArpRow, CamRow, DeviceTables, RouteRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import { emptyCounters } from '../src/contracts/port.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { exitTarget } from '../src/cli/modes.js';
import { createCliRuntime } from '../src/cli/runtime.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { ArrayTrace, fakeCatalog, FakeTable, INERT_RF_VIEWS, type ActionCall, type ConfigCall } from './cli.runtime.fake.js';
import { testPortSpec, p0Tables } from './port.fixtures.js';

/** A catalog model by type id (throws when the catalog lacks it). */
export function catalogModel(type: string): DeviceModel {
  const m = ALL_MODELS.find((x) => x.type === type);
  if (m === undefined) throw new Error(`catalog has no ${type}`);
  return m;
}

function portState(spec: PortSpec, ordinal: number, adminUp: boolean): PortState {
  const p: PortState = {
    id: spec.name,
    spec,
    mac: `02:00:00:00:00:${ordinal.toString(16).padStart(2, '0')}`,
    adminUp,
    operUp: false,
    mtu: spec.mtu ?? 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role: spec.role,
    ordinal,
    encap: spec.encap,
  };
  return p;
}

/** Recording device runtime over a real catalog model, with virtual-port creation and `portsVersion`. */
export class P05Device implements DeviceRuntime {
  readonly spec: DeviceSpec;
  hostname: string;
  power = true;
  bootedAt: SimTime | undefined = 0;
  readonly ports = new Map<PortId, PortState>();
  readonly tables: DeviceTables & { arp: FakeTable<ArpRow>; cam: FakeTable<CamRow>; rib: FakeTable<RouteRow> };
  readonly running: ConfigAst = createConfigAst();
  startup: ConfigAst | undefined = undefined;
  readonly processes = new Map<ProcessName, Process>();
  readonly capabilities: readonly Capability[];
  portsVersion = 0;
  readonly configCalls: ConfigCall[] = [];
  readonly actionCalls: ActionCall[] = [];
  /** When set, `applyConfigLine` fails with the returned message for matching lines. */
  rejectLine: ((line: readonly string[]) => string | undefined) | undefined = undefined;

  constructor(readonly id: DeviceId, readonly model: DeviceModel, hostname: string) {
    this.hostname = hostname;
    this.spec = { id, type: model.type, name: hostname, position: { x: 0, y: 0 }, power: true, modules: [], macSalt: 0 };
    this.capabilities = model.capabilities ?? [];
    model.ports.forEach((p, i) => this.ports.set(p.name, portState(p, i + 1, model.portsDefaultUp)));
    this.tables = p0Tables({
      arp: new FakeTable<ArpRow>('arp', id),
      cam: new FakeTable<CamRow>('cam', id),
      rib: new FakeTable<RouteRow>('rib', id),
    });
    for (const name of model.processes) {
      this.processes.set(name, {
        name,
        onPdu: () => [],
        onTimer: () => [],
        onConfig: () => [],
        stateSnapshot: (): StateView => ({ process: name, state: {} }),
        debugEvents: () => [],
      });
    }
  }

  port(id: PortId): PortState | undefined {
    return this.ports.get(id);
  }
  portView(id: PortId): PortState | undefined {
    return this.ports.get(id);
  }
  resolvePortName(name: string): PortResolution {
    return resolvePortName({ model: this.model, ports: this.ports }, name);
  }
  ensureVirtualPort(name: PortId): { ok: true; port: PortId; created: boolean } | { ok: false; error: string } {
    const r = this.resolvePortName(name);
    if (r.kind === 'existing') return { ok: true, port: r.port, created: false };
    if (r.kind !== 'virtual') return { ok: false, error: '% That interface cannot be created here.' };
    const spec: PortSpec = testPortSpec({ name: r.port, short: r.port, kind: 'virtual', speedBps: 0, autoMdix: false }, this.capabilities, 0);
    this.ports.set(r.port, portState(spec, 0, true));
    this.portsVersion++;
    this.running.set([], ['interface', r.port]);
    return { ok: true, port: r.port, created: true };
  }
  /** Role flips are the device runtime's business; the fixture records nothing and refuses. */
  setPortRole(port: PortId, role: PortRole): { ok: boolean; error?: string } {
    return { ok: false, error: `${port} cannot become ${role}.` };
  }
  /** P0.5 hardware surface: the fake has no slots, a zero MAC base and default PHY/radio settings. */
  readonly modules = new Map<SlotId, ModuleType>();
  readonly macBase = 0;
  insertModule(slot: SlotId): HardwareResult {
    return { ok: false, code: 'no-such-slot', error: `${this.model.model} has no slot ${slot}.` };
  }
  removeModule(slot: SlotId): HardwareResult {
    return { ok: false, code: 'no-such-slot', error: `${this.model.model} has no slot ${slot}.` };
  }
  modulePorts(): readonly PortId[] {
    return [];
  }
  phySettings(): PortPhySettings {
    return { speed: 'auto', duplex: 'auto' };
  }
  radioSettings(): undefined {
    return undefined;
  }
  onTxOutcome(): void {}
  onMediumEvent(): void {}
  removeVirtualPort(name: PortId): { ok: boolean; error?: string } {
    if (this.ports.get(name)?.spec.kind !== 'virtual') return { ok: false, error: '% Not a virtual interface.' };
    this.ports.delete(name);
    this.portsVersion++;
    this.running.unset([], ['interface', name]);
    return { ok: true };
  }
  applyConfigLine(context: string[][], line: string[], negate: boolean): { ok: boolean; error?: string } {
    this.configCalls.push({ context: context.map((c) => [...c]), line: [...line], negate });
    const refused = this.rejectLine?.(line);
    if (refused !== undefined) return { ok: false, error: refused };
    const first = context[0];
    if (first !== undefined && first[0] === 'interface' && !this.ports.has(first[1] ?? '')) return { ok: false, error: 'Unknown interface' };
    if (negate) this.running.unset(context, line);
    else this.running.set(context, line);
    if (context.length === 0 && line[0] === 'hostname') this.hostname = negate ? this.model.hostnamePrefix : line[1] ?? this.hostname;
    if (context.length === 1 && first?.[0] === 'interface' && line[0] === 'shutdown') {
      const p = this.ports.get(first[1] ?? '');
      if (p) p.adminUp = negate;
    }
    return { ok: true };
  }
  stateSnapshots(): StateView[] {
    return [...this.processes.values()].map((p) => p.stateSnapshot());
  }
  recentDebug(): [] {
    return [];
  }
  uptime(now: SimTime): SimTime {
    return this.bootedAt === undefined ? 0 : now - this.bootedAt;
  }
  onFrameArrival(): void {}
  onTimer(): void {}
  onBoot(): void {}
  onPortOper(): void {}
  applyActions(process: ProcessName, actions: Action[], now: SimTime): void {
    this.actionCalls.push({ process, actions: [...actions], now });
  }
  setPortAdmin(): void {}
  setPower(on: boolean): void {
    this.power = on;
  }
  reload(): void {}
  saveConfig(): void {
    this.startup = this.running.clone();
  }
  eraseStartup(): void {
    this.startup = undefined;
  }
}

/** Handler writing the matched literals and args of `path` as one config line (default context). */
function writes(path: readonly string[]): CommandHandler {
  return (ctx, args, negate) => {
    const line = path.map((el) => (el.startsWith('<') ? args[el.slice(1, -1)] ?? '' : el));
    const err = ctx.config(line, negate);
    return err === undefined ? {} : { error: err };
  };
}

const word = (help: string) => ({ type: 'word' as const, help });

const TEST_SPECS: CommandSpec[] = [
  { path: ['enable'], mode: 'user-exec', privilege: 1, help: 'Raise privilege', handler: 't.enable', entersMode: 'priv-exec', grammars: ['nfos'], sessionEffect: 'privilege' },
  { path: ['configure', 'terminal'], mode: 'priv-exec', privilege: 15, help: 'Configure', handler: 't.conf', entersMode: 'config', grammars: ['nfos'] },
  { path: ['exit'], mode: '@all', privilege: 1, help: 'Leave the mode', handler: 't.exit', sessionEffect: 'enter-mode' },
  { path: ['end'], mode: '@config', privilege: 15, help: 'Back to privileged mode', handler: 't.end', entersMode: 'priv-exec', grammars: ['nfos'] },
  { path: ['hostname', '<name>'], mode: 'config', privilege: 15, help: 'Name the device', args: { name: word('Host name') }, handler: 't.hostname', grammars: ['nfos'] },
  { path: ['interface', '<iface>'], mode: 'config', privilege: 15, help: 'Select an interface', args: { iface: { type: 'interface', help: 'Interface' } }, handler: 't.interface', entersMode: 'config-if', grammars: ['nfos'] },
  { path: ['ip', 'dhcp', 'pool', '<name>'], mode: 'config', privilege: 15, help: 'Address pool', args: { name: word('Pool name') }, handler: 't.pool', entersMode: 'dhcp-config', grammars: ['nfos'] },
  { path: ['network', '<net>', '<mask>'], mode: 'dhcp-config', privilege: 15, help: 'Pool network', args: { net: { type: 'ipv4', help: 'Network' }, mask: { type: 'ipv4-mask', help: 'Mask' } }, handler: 't.network', grammars: ['nfos'] },
  { path: ['shutdown'], mode: 'config-if', privilege: 15, help: 'Disable the interface', allowNo: true, handler: 't.shutdown', grammars: ['nfos'] },
  { path: ['ip', 'address', '<addr>', '<mask>'], mode: 'config-if', privilege: 15, help: 'Interface address', args: { addr: { type: 'ipv4', help: 'Address' }, mask: { type: 'ipv4-mask', help: 'Mask' } }, handler: 't.ifaddr', grammars: ['nfos'], requiresAny: ['routing'] },
  { path: ['clock', 'rate', '<bps>'], mode: 'config-if', privilege: 15, help: 'Serial clock', args: { bps: { type: 'int', help: 'Rate', min: 1200, max: 8000000 } }, handler: 't.clock', grammars: ['nfos'], portRequires: { kinds: ['serial'] } },
  { path: ['refuse'], mode: '@config', privilege: 15, help: 'Always fails', handler: 't.refuse', grammars: ['nfos'] },
  { path: ['show', 'state'], mode: '@exec', privilege: 1, help: 'Session state', handler: 't.show', filterable: true },
  { path: ['show', 'pool', '<name>'], mode: '@exec', privilege: 1, help: 'One pool', args: { name: { type: 'word', help: 'Pool name', completion: 'dhcp-pools' } }, handler: 't.show', grammars: ['nfos'] },
  { path: ['ping', '<target>'], mode: '@exec', privilege: 1, help: 'Echo test', args: { target: { type: 'ipv4', help: 'Target' } }, handler: 't.ping', job: true },
  { path: ['wait'], mode: '@exec', privilege: 1, help: 'Blocks without declaring a job', handler: 't.ping' },
  { path: ['trace'], mode: '@exec', privilege: 1, help: 'Custom job', handler: 't.trace', job: true },
  { path: ['confirm'], mode: '@exec', privilege: 1, help: 'Asks a question', handler: 't.ask' },
  { path: ['ip', 'address', '<addr>', '<mask>'], mode: 'user-exec', privilege: 15, help: 'Adapter address', args: { addr: { type: 'ipv4', help: 'Address' }, mask: { type: 'ipv4-mask', help: 'Mask' } }, handler: 't.hostaddr', grammars: ['host'] },
];

/** Test grammar: mode navigation, sections, portRequires, jobs, host shell, filters. Original wording. */
export const TEST_GRAMMAR: readonly CommandSpec[] = Object.freeze(TEST_SPECS);

/** Handlers behind `TEST_GRAMMAR`. */
export const TEST_HANDLERS: Record<string, CommandHandler> = {
  't.enable': (ctx) => {
    ctx.setPrivilege(15);
    ctx.setMode('priv-exec');
    return {};
  },
  't.conf': (ctx) => {
    ctx.setMode('config');
    return {};
  },
  't.exit': (ctx) => {
    const target = exitTarget(ctx.session.mode, ctx.context ?? []);
    if (target.close) ctx.closeSession();
    else ctx.enterMode!(target.mode, { context: target.context });
    return {};
  },
  't.end': (ctx) => {
    ctx.enterMode!('priv-exec');
    return {};
  },
  't.hostname': writes(['hostname', '<name>']),
  't.interface': (ctx, args) => {
    const raw = args['iface'] ?? '';
    let port = ctx.resolvePort(raw);
    if (port === undefined) {
      const r = ctx.device.ensureVirtualPort?.(raw);
      if (r === undefined || !r.ok) return { error: r === undefined ? '% Unknown interface.' : r.error };
      port = r.port;
    }
    ctx.config(['interface', port], false, []);
    ctx.enterMode!('config-if', { iface: port });
    return {};
  },
  't.pool': (ctx, args) => {
    const name = args['name'] ?? '';
    ctx.config(['ip', 'dhcp', 'pool', name], false, []);
    ctx.enterMode!('dhcp-config', { push: ['ip', 'dhcp', 'pool', name] });
    return {};
  },
  't.network': writes(['network', '<net>', '<mask>']),
  't.shutdown': writes(['shutdown']),
  't.ifaddr': writes(['ip', 'address', '<addr>', '<mask>']),
  't.clock': writes(['clock', 'rate', '<bps>']),
  't.refuse': () => ({ error: '% Refused by the test grammar.' }),
  't.show': (ctx) => ({
    output: JSON.stringify({
      session: ctx.session.id,
      mode: ctx.session.mode,
      context: ctx.context ?? null,
      iface: ctx.iface?.id ?? null,
      headless: ctx.headless === true,
      grammar: ctx.grammar ?? null,
    }),
  }),
  't.ping': (ctx) => {
    ctx.block();
    ctx.request('icmpv4', { kind: 'icmp.ping', session: ctx.session.id, target: '10.0.0.2', count: 5, timeoutNs: 1, sizeBytes: 100 });
    return {};
  },
  't.trace': (ctx) => {
    ctx.block({ process: 'traceroute', abort: { kind: 'job.abort', session: ctx.session.id }, label: 'traceroute' });
    return {};
  },
  't.ask': () => ({ ask: { request: { kind: 'confirm', prompt: 'Proceed? ' }, resume: () => ({}) } }),
  't.hostaddr': (ctx, args) => {
    const port = ctx.model.hostPorts?.[0];
    if (port === undefined) return { error: '% No adapter.' };
    const err = ctx.config(['ip', 'address', args['addr'] ?? '', args['mask'] ?? ''], false, [['interface', port]]);
    return err === undefined ? {} : { error: err };
  },
};

/** A runtime over P05Devices with the test grammar. */
export interface P05Harness {
  devices: Map<DeviceId, P05Device>;
  trace: ArrayTrace;
  clock: { now: SimTime };
  cli: CliRuntime;
  add(id: DeviceId, type: string, hostname: string): P05Device;
}

/** Build a harness; devices are added with `add(id, catalogType, hostname)`. */
export function p05Harness(): P05Harness {
  const devices = new Map<DeviceId, P05Device>();
  const trace = new ArrayTrace();
  const clock = { now: 0 };
  const cli = createCliRuntime(
    { device: (id) => devices.get(id), catalog: fakeCatalog, trace, now: () => clock.now, grammar: TEST_GRAMMAR, ...INERT_RF_VIEWS },
    TEST_HANDLERS,
  );
  return {
    devices,
    trace,
    clock,
    cli,
    add(id, type, hostname) {
      const d = new P05Device(id, catalogModel(type), hostname);
      devices.set(id, d);
      return d;
    },
  };
}

/** Parse the JSON printed by the test `show state` handler. */
export function stateOf(output: string): { session: string; mode: string; context: string[][] | null; iface: string | null; headless: boolean; grammar: string | null } {
  return JSON.parse(output) as ReturnType<typeof stateOf>;
}
