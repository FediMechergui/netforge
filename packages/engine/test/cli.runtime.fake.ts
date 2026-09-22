/**
 * Test double for `cli/runtime.ts`: a recording `DeviceRuntime`, a tiny catalog
 * with short-name expansion, and an array-backed trace sink. Shared by the
 * cli.runtime.*.test.ts files (not a test file itself).
 */
import type { Capability, HardwareResult, ModuleType, PortRole, SlotId } from '../src/contracts/catalog.js';
import type { PortPhySettings } from '../src/contracts/link.js';
import { MSG_CANNOT_CREATE_INTERFACE } from '../src/cli/handlers/config.js';
import type { CliRuntimeDeps, CommandHandler } from '../src/contracts/cli.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceCatalog, DeviceKind, DeviceModel, DeviceRuntime, DeviceSpec, PortResolution } from '../src/contracts/device.js';
import type { DeviceId, PortId, ProcessName } from '../src/contracts/ids.js';
import type { PortSpec, PortState } from '../src/contracts/port.js';
import type { Action, Process, StateView } from '../src/contracts/process.js';
import type { ArpRow, CamRow, DeviceTables, RouteRow, Table, TableRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent, TraceSink } from '../src/contracts/trace.js';
import { emptyCounters } from '../src/contracts/port.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { deriveCliSpec } from '../src/device/catalog/define.js';
import { P2_DEVICE, portStateFields, testModel, type TestPortInput, p0Tables } from './port.fixtures.js';

export interface ConfigCall {
  context: string[][];
  line: string[];
  negate: boolean;
}

export interface ActionCall {
  process: ProcessName;
  actions: Action[];
  now: SimTime;
}

/** Minimal recording table. */
export class FakeTable<R extends TableRow> implements Table<R> {
  readonly cleared: string[] = [];
  private readonly map = new Map<string, R>();
  constructor(readonly name: string, readonly device: DeviceId) {}
  get size(): number {
    return this.map.size;
  }
  get(key: string): R | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  rows(): R[] {
    return [...this.map.values()];
  }
  set(row: R): R | undefined {
    const prev = this.map.get(row.key);
    this.map.set(row.key, row);
    return prev;
  }
  delete(key: string): R | undefined {
    const prev = this.map.get(key);
    this.map.delete(key);
    return prev;
  }
  clear(reason: 'cleared' | 'link-down' = 'cleared'): void {
    this.cleared.push(reason);
    this.map.clear();
  }
  expire(): R[] {
    return [];
  }
  find(pred: (r: R) => boolean): R[] {
    return this.rows().filter(pred);
  }
}

function portSpec(name: string, short: string): TestPortInput {
  return { name, short, kind: 'ethernet', speedBps: 1_000_000_000, autoMdix: true };
}

/** Device kinds this fake models (DeviceKind widened in P0.5; the fake keeps the four P0 shapes). */
type FakeKind = Extract<DeviceKind, 'pc' | 'switch' | 'router' | 'hub'>;

/**
 * P0.5 scope data of a fake model: the capability list and the CLI spec `defineModel` derives from it, so the
 * runtime's scope and initial privilege come from data (D2), never from `kind`.
 */
function cliData(capabilities: readonly Capability[]): Pick<DeviceModel, 'capabilities' | 'cli'> {
  return { capabilities, cli: deriveCliSpec(capabilities) };
}

const MODELS: Record<FakeKind, DeviceModel> = {
  router: testModel({
    type: 'router.nf2911',
    model: 'NF-2911',
    kind: 'router',
    description: 'branch router',
    ports: [portSpec('GigabitEthernet0/0', 'Gi0/0'), portSpec('GigabitEthernet0/1', 'Gi0/1')],
    processes: ['arp', 'ipv4', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'traceroute'],
    hostnamePrefix: 'Router',
    portsDefaultUp: false,
    bootNs: 0,
    ipForwarding: true,
    processingNs: 0,
    ...cliData(['routing']),
  }),
  switch: testModel({
    type: 'switch.nfc2960',
    model: 'NF-C2960',
    kind: 'switch',
    description: 'access switch',
    ports: [portSpec('FastEthernet0/1', 'Fa0/1'), portSpec('FastEthernet0/2', 'Fa0/2')],
    // P1 (ARCHITECTURE-P1 §9.2): the `switching` capability brings the IPv4 stack for the management SVI.
    processes: ['eth-switch', 'arp', 'ipv4', 'icmpv4', 'host'],
    hostnamePrefix: 'Switch',
    portsDefaultUp: true,
    bootNs: 0,
    ipForwarding: false,
    processingNs: 0,
    ...cliData(['switching']),
  }),
  pc: testModel({
    type: 'pc.nfpc',
    model: 'NF-PC',
    kind: 'pc',
    description: 'workstation',
    ports: [portSpec('GigabitEthernet0', 'Gi0')],
    // P1: the `host` capability brings the IPv6 stack, transport and the application daemons (§8.2 W5).
    processes: ['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'traceroute'],
    hostnamePrefix: 'PC',
    portsDefaultUp: true,
    bootNs: 0,
    ipForwarding: false,
    processingNs: 0,
    hostPorts: ['GigabitEthernet0'],
    ...cliData(['host']),
  }),
  hub: testModel({
    type: 'hub.nfhub',
    model: 'NF-HUB',
    kind: 'hub',
    description: 'hub',
    ports: [],
    processes: [],
    hostnamePrefix: 'Hub',
    portsDefaultUp: true,
    bootNs: 0,
    ipForwarding: false,
    processingNs: 0,
    ...cliData(['repeater']),
  }),
};

function makePort(spec: PortSpec, index: number, adminUp: boolean): PortState {
  return {
    id: spec.name,
    spec,
    mac: `00:1f:00:00:00:${index.toString(16).padStart(2, '0')}`,
    adminUp,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    ...portStateFields(spec),
  };
}

/** Recording device runtime. `onRequest` lets a test simulate a daemon answering a request synchronously. */
export class FakeDevice implements DeviceRuntime {
  readonly model: DeviceModel;
  readonly spec: DeviceSpec;
  hostname: string;
  power = true;
  bootedAt: SimTime | undefined = 0;
  readonly ports = new Map<PortId, PortState>();
  readonly tables: DeviceTables & { arp: FakeTable<ArpRow>; cam: FakeTable<CamRow>; rib: FakeTable<RouteRow> };
  readonly running: ConfigAst = createConfigAst();
  startup: ConfigAst | undefined = undefined;
  readonly processes = new Map<ProcessName, Process>();
  readonly configCalls: ConfigCall[] = [];
  readonly actionCalls: ActionCall[] = [];
  readonly ops: string[] = [];
  /** Optional hook invoked for every `request` action the CLI applies. */
  onRequest: ((action: Extract<Action, { type: 'request' }>, now: SimTime) => void) | undefined = undefined;
  /** When set, `applyConfigLine` fails with this message. */
  rejectConfig: string | undefined = undefined;
  readonly capabilities: readonly Capability[];
  portsVersion = 0;
  // P2 (ARCHITECTURE-P2 §9.2 W1 item 7): the required runtime members, copied from P2_DEVICE.
  readonly profile = P2_DEVICE.profile;
  errDisablePort = P2_DEVICE.errDisablePort;

  constructor(readonly id: DeviceId, kind: FakeKind, hostname: string) {
    this.model = MODELS[kind];
    this.capabilities = this.model.capabilities ?? [];
    this.hostname = hostname;
    this.spec = { id, type: this.model.type, name: hostname, position: { x: 0, y: 0 }, power: true, modules: [], macSalt: 0 };
    this.model.ports.forEach((p, i) => this.ports.set(p.name, makePort(p, i + 1, this.model.portsDefaultUp)));
    this.tables = p0Tables({
      arp: new FakeTable<ArpRow>('arp', id),
      cam: new FakeTable<CamRow>('cam', id),
      rib: new FakeTable<RouteRow>('rib', id),
    });
    for (const name of this.model.processes) {
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
  resolvePortName(name: string): PortResolution {
    return fakeCatalog.resolvePort({ model: this.model, ports: this.ports }, name);
  }
  /** The fake creates no virtual interfaces (P0 shapes). */
  ensureVirtualPort(): { ok: false; error: string } {
    return { ok: false, error: MSG_CANNOT_CREATE_INTERFACE };
  }
  removeVirtualPort(name: PortId): { ok: boolean; error?: string } {
    return { ok: false, error: `Interface ${name} does not exist.` };
  }
  /** The fake's ports have one role each (P0 shapes). */
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

  portView(id: PortId): PortState | undefined {
    return this.ports.get(id);
  }
  applyConfigLine(context: string[][], line: string[], negate: boolean): { ok: boolean; error?: string } {
    this.configCalls.push({ context: context.map((c) => [...c]), line: [...line], negate });
    if (this.rejectConfig !== undefined) return { ok: false, error: this.rejectConfig };
    if (negate) this.running.unset(context, line);
    else this.running.set(context, line);
    if (context.length === 0 && line[0] === 'hostname') {
      this.hostname = negate ? this.model.hostnamePrefix : line[1] ?? this.hostname;
    }
    if (context.length === 1 && context[0]?.[0] === 'interface' && line[0] === 'shutdown') {
      const p = this.ports.get(context[0][1] ?? '');
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
    for (const a of actions) {
      if (a.type === 'request' && this.onRequest) this.onRequest(a, now);
    }
  }
  setPortAdmin(port: PortId, adminUp: boolean): void {
    this.ops.push(`setPortAdmin ${port} ${adminUp}`);
  }
  setPower(on: boolean): void {
    this.ops.push(`setPower ${on}`);
    this.power = on;
  }
  reload(now: SimTime): void {
    this.ops.push(`reload ${now}`);
  }
  saveConfig(): void {
    this.ops.push('saveConfig');
    this.startup = this.running.clone();
  }
  eraseStartup(): void {
    this.ops.push('eraseStartup');
    this.startup = undefined;
  }
}

/** Short-name expansion good enough for the fake models: `g0/0`, `gi0/1`, `fa0/2`, `GigabitEthernet 0/0`. */
export const fakeCatalog: DeviceCatalog = {
  get: (type) => Object.values(MODELS).find((m) => m.type === type),
  list: () => Object.values(MODELS),
  process: () => undefined,
  module: () => undefined,
  modules: () => [],
  resolvePort: (source, name) => {
    if (source.ports.has(name)) return { kind: 'existing', port: name };
    const t = name.replace(/\s+/g, '').toLowerCase();
    const m = /^([a-z-]+)(\d.*)$/.exec(t);
    if (!m) return { kind: 'unknown' };
    const [, prefix, rest] = m;
    for (const [id, p] of source.ports) {
      const long = p.spec.name.toLowerCase();
      const longPrefix = long.replace(/\d.*$/, '');
      if (long === longPrefix + rest && longPrefix.startsWith(prefix!)) return { kind: 'existing', port: id };
    }
    return { kind: 'unknown' };
  },
};

/** RF views of a world without radios (`CliRuntimeDeps.radioView` / `airView`). */
export const INERT_RF_VIEWS: Pick<CliRuntimeDeps, 'radioView' | 'airView'> = Object.freeze({
  radioView: () => undefined,
  airView: () => ({ visibleBss: () => [], link: () => undefined }),
});

/** Trace sink collecting events in order. */
export class ArrayTrace implements TraceSink {
  readonly events: TraceEvent[] = [];
  emit(ev: TraceEvent): void {
    this.events.push(ev);
  }
  of<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] {
    return this.events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  }
  clear(): void {
    this.events.length = 0;
  }
}

/** A `show`-style stub handler that prints a multi-line block (used for filter and `do` tests). */
export const SHOW_STUB_OUTPUT = [
  'interface GigabitEthernet0/0',
  ' ip address 10.0.0.1 255.255.255.0',
  ' no shutdown',
  'interface GigabitEthernet0/1',
  ' shutdown',
  'hostname R1',
].join('\n');

export const showStub: CommandHandler = () => ({ output: SHOW_STUB_OUTPUT });

/** Everything a runtime test needs: devices by id, a catalog, a trace, a settable clock. */
export interface Harness {
  devices: Map<DeviceId, FakeDevice>;
  trace: ArrayTrace;
  clock: { now: SimTime };
  deps: CliRuntimeDeps;
  add(id: DeviceId, kind: FakeKind, hostname: string): FakeDevice;
}

export function harness(): Harness {
  const devices = new Map<DeviceId, FakeDevice>();
  const trace = new ArrayTrace();
  const clock = { now: 0 };
  return {
    devices,
    trace,
    clock,
    deps: {
      device: (id) => devices.get(id),
      catalog: fakeCatalog,
      trace,
      now: () => clock.now,
      ...INERT_RF_VIEWS,
    },
    add(id, kind, hostname) {
      const d = new FakeDevice(id, kind, hostname);
      devices.set(id, d);
      return d;
    },
  };
}
