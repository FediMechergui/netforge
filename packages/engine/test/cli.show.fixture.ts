/**
 * Shared fake `CommandCtx` for the show/PC handler tests. Ports are hand-made
 * `PortView` objects; tables come from core/table.ts; configs from cli/config-ast.ts.
 */
import type { CliSessionView, CommandCtx } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortCounters, PortView } from '../src/contracts/port.js';
import type { ArpRow, CamRow, RouteRow, Table } from '../src/contracts/tables.js';
import type { ConfigAst } from '../src/contracts/config.js';
import { emptyCounters, SPEED_100M, SPEED_1G } from '../src/contracts/port.js';
import { createTable } from '../src/core/table.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { KIND_ENCAP, defaultRoleFor } from '../src/contracts/catalog.js';
import { testModel, testPortSpec, p0Tables } from './port.fixtures.js';
import { secretsFor } from '../src/cli/runtime.js';

export interface FakePortInit {
  id: string;
  kind?: 'ethernet' | 'serial' | 'console';
  mac?: string;
  adminUp?: boolean;
  operUp?: boolean;
  speedBps?: number;
  duplex?: 'full' | 'half' | 'auto';
  mtu?: number;
  link?: string;
  errDisabled?: string;
  counters?: Partial<PortCounters>;
  ipv4?: { address: string; prefixLen: number };
  lastInput?: number;
  lastOutput?: number;
  lastChange?: number;
  txQueue?: number;
  specSpeedBps?: number;
}

export function fakePort(init: FakePortInit): PortView {
  const kind = init.kind ?? 'ethernet';
  const short = init.id.replace('GigabitEthernet', 'Gi').replace('FastEthernet', 'Fa').replace('Serial', 'Se');
  return {
    id: init.id,
    spec: testPortSpec({ name: init.id, short, kind, speedBps: init.specSpeedBps ?? SPEED_1G }),
    mac: init.mac ?? '00:1f:00:00:00:01',
    adminUp: init.adminUp ?? true,
    operUp: init.operUp ?? false,
    speedBps: init.speedBps,
    duplex: init.duplex,
    mtu: init.mtu ?? 1500,
    link: init.link,
    errDisabled: init.errDisabled,
    counters: { ...emptyCounters(), ...(init.counters ?? {}) },
    l3: init.ipv4 ? { ipv4: init.ipv4 } : {},
    tx: { busyUntil: 0, queue: init.txQueue ?? 0 },
    lastInput: init.lastInput,
    lastOutput: init.lastOutput,
    lastChange: init.lastChange,
    role: defaultRoleFor(kind, []),
    ordinal: 1,
    encap: KIND_ENCAP[kind],
  };
}

export const PC_MODEL: DeviceModel = testModel({
  type: 'pc.nfpc', model: 'NF-PC', kind: 'pc', description: 'generic workstation',
  ports: [{ name: 'GigabitEthernet0', short: 'Gi0', kind: 'ethernet', speedBps: SPEED_1G }],
  processes: ['arp', 'ipv4', 'icmpv4', 'host'], hostnamePrefix: 'PC', portsDefaultUp: true,
  bootNs: 0, ipForwarding: false, processingNs: 0,
});

export const ROUTER_MODEL: DeviceModel = testModel({
  type: 'router.nf2911', model: 'NF-2911', kind: 'router', description: 'branch router',
  ports: [
    { name: 'GigabitEthernet0/0', short: 'Gi0/0', kind: 'ethernet', speedBps: SPEED_1G },
    { name: 'GigabitEthernet0/1', short: 'Gi0/1', kind: 'ethernet', speedBps: SPEED_1G },
    { name: 'Serial0/0/0', short: 'Se0/0/0', kind: 'serial', speedBps: 1_544_000 },
    { name: 'Serial0/0/1', short: 'Se0/0/1', kind: 'serial', speedBps: 1_544_000 },
    { name: 'Console', short: 'Con', kind: 'console', speedBps: 9600 },
  ],
  processes: ['arp', 'ipv4', 'icmpv4', 'host'], hostnamePrefix: 'Router', portsDefaultUp: false,
  bootNs: 0, ipForwarding: true, processingNs: 0,
});

export const SWITCH_MODEL: DeviceModel = testModel({
  type: 'switch.nfc2960', model: 'NF-C2960', kind: 'switch', description: '24-port access switch',
  ports: [
    { name: 'FastEthernet0/1', short: 'Fa0/1', kind: 'ethernet', speedBps: SPEED_100M },
    { name: 'FastEthernet0/2', short: 'Fa0/2', kind: 'ethernet', speedBps: SPEED_100M },
    { name: 'GigabitEthernet0/1', short: 'Gi0/1', kind: 'ethernet', speedBps: SPEED_1G },
  ],
  processes: ['eth-switch'], hostnamePrefix: 'Switch', portsDefaultUp: true,
  bootNs: 0, ipForwarding: false, processingNs: 0,
});

export interface ConfigCall {
  line: string[];
  negate: boolean;
  context: string[][] | undefined;
}

export interface FakeCtxInit {
  model?: DeviceModel;
  hostname?: string;
  ports?: PortView[];
  now?: number;
  uptime?: number;
  history?: string[];
  running?: ConfigAst;
  startup?: ConfigAst;
  /** Return value for ctx.config (undefined = success). */
  configResult?: string | undefined;
}

export interface FakeCtx {
  ctx: CommandCtx;
  configCalls: ConfigCall[];
  arp: Table<ArpRow>;
  cam: Table<CamRow>;
  rib: Table<RouteRow>;
}

export function fakeCtx(init: FakeCtxInit = {}): FakeCtx {
  const now = init.now ?? 0;
  const sink = { emit: () => undefined };
  const clock = () => now;
  const arp = createTable<ArpRow>({ name: 'arp', device: 'd_1', sink, now: clock });
  const cam = createTable<CamRow>({ name: 'cam', device: 'd_1', sink, now: clock });
  const rib = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink, now: clock });
  const ports = new Map<string, PortView>();
  for (const p of init.ports ?? []) ports.set(p.id, p);
  const model = init.model ?? PC_MODEL;
  const session: CliSessionView = {
    id: 's_1', device: 'd_1', via: 'console', mode: 'user-exec', privilege: 15,
    prompt: `${init.hostname ?? 'PC1'}>`, busy: false, history: init.history ?? [], grammar: model.cli.grammar,
  };
  const configCalls: ConfigCall[] = [];
  const running = init.running ?? createConfigAst();
  const ctx: CommandCtx = {
    now,
    session,
    deviceId: 'd_1',
    hostname: init.hostname ?? 'PC1',
    model,
    ports,
    tables: p0Tables({ cam, arp, rib }),
    running,
    startup: init.startup,
    uptime: init.uptime ?? 0,
    processState: () => undefined,
    config: (line, negate, context) => {
      configCalls.push({ line: [...line], negate, context: context ? context.map((c) => [...c]) : undefined });
      return init.configResult;
    },
    resolvePort: (name) => {
      const lower = name.toLowerCase();
      for (const id of ports.keys()) {
        if (id.toLowerCase() === lower) return id;
        const p = ports.get(id)!;
        if (p.spec.short.toLowerCase() === lower) return id;
      }
      return undefined;
    },
    request: () => undefined,
    act: () => undefined,
    device: {
      setHostname: () => undefined,
      saveConfig: () => undefined,
      eraseStartup: () => undefined,
      reload: () => undefined,
      setPortAdmin: () => undefined,
      clearTable: () => undefined,
      ensureVirtualPort: () => ({ ok: false, error: 'This fixture creates no interfaces.' }),
      removeVirtualPort: () => ({ ok: false }),
      setPortRole: () => ({ ok: false }),
    },
    setMode: () => undefined,
    setPrivilege: () => undefined,
    block: () => undefined,
    closeSession: () => undefined,
    grammar: model.cli.grammar,
    capabilities: new Set(model.capabilities),
    context: [],
    headless: false,
    enterMode: () => undefined,
    radioView: () => undefined,
    air: { visibleBss: () => [], link: () => undefined },
    secrets: secretsFor('d_1'),
  };
  return { ctx, configCalls, arp, cam, rib };
}

export const SEC = 1_000_000_000;
export const MIN = 60 * SEC;
