/**
 * acl.daemon.rig — the shared rig of the P3c acl daemon tests (ARCHITECTURE-P3C §7 W2a acl [S11] [S12]):
 * `acl.daemon.ipv6`, `acl.daemon.log-input`, `acl.unreachables`. The unit rig is the one `acl.daemon.test.ts` uses
 * (the ip.fake-ctx router with an `acl` table, the real acl daemon), widened to family-6 requests; `world` is its
 * staged P3 world (PC1 — R1 — SRV) with the configuration in `startupConfig` (rule 13).
 */
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { AclRow, DeviceTables, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { createTable } from '../src/core/table.js';
import { ACL_DEBUG_CATEGORY, createAcl } from '../src/protocols/acl.js';
import { framed, makeFake, type Fake } from './ip.fake-ctx.js';
import { createStagedSimulation } from './staged.world.js';
import { output } from './sim.harness.js';

export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const MAC_R0 = '00:1f:00:00:00:10';
export const MAC_R1 = '00:1f:00:00:00:11';
export const MAC_PC = '00:1f:00:00:00:01';
export const PC1 = '192.168.10.10';
export const PC2 = '192.168.10.11';
export const SRV = '192.168.20.100';
export const MS = 1_000_000;

export type FilterReq = Extract<ProcessRequest, { kind: 'acl.filter' }>;

export interface AclRig {
  fake: Fake;
  ctx: ProcessCtx;
  acl: Process;
  table: Table<AclRow>;
  /** Store a line (context = mode path) and hand the delta to acl; `negate` stores the `no` form. */
  line(context: readonly (readonly string[])[], text: string, negate?: boolean): Action[];
  /** `acl.filter` for `pdu` (onPermit = a marker resume request to ipv4 or ipv6). */
  filter(pdu: Pdu, dir: 'in' | 'out', iface: string, extra?: Partial<Pick<FilterReq, 'inPort' | 'natted' | 'family'>>): { actions: Action[]; onPermit: Action };
  at(ns: number): void;
  writes(): Extract<TraceEvent, { kind: 'tableWrite' }>[];
  aclDebug(): string[];
}

/** The fake router (Gi0/0 192.168.10.1, Gi0/1 192.168.20.1) with an `acl` table; the model runs acl (and `extra`). */
export function rig(extra: readonly ProcessName[] = []): AclRig {
  const fake = makeFake({
    kind: 'router',
    ports: [
      { id: GI0, mac: MAC_R0, ipv4: { address: '192.168.10.1', prefixLen: 24 } },
      { id: GI1, mac: MAC_R1, ipv4: { address: '192.168.20.1', prefixLen: 24 } },
    ],
  });
  const base = fake.ctx;
  const sink = { emit: (ev: TraceEvent) => void fake.trace.push(ev) };
  const table = createTable<AclRow>({ name: 'acl', device: base.deviceId, sink, now: () => base.now });
  const tables: DeviceTables = {
    cam: base.tables.cam,
    arp: base.tables.arp,
    rib: base.tables.rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => (name === 'acl' ? (table as unknown as Table<R>) : base.tables.get<R>(name)),
    names: () => [...base.tables.names(), 'acl'],
  };
  const model = { ...base.model, processes: [...base.model.processes, 'acl' as ProcessName, ...extra], tables: [...base.model.tables, 'acl' as TableName] };
  const ctx = Object.create(base, { model: { value: model, enumerable: true }, tables: { value: tables, enumerable: true } }) as ProcessCtx;
  const acl = createAcl();
  acl.init?.(ctx);
  return {
    fake,
    ctx,
    acl,
    table,
    line(context, text, negate = false) {
      const tokens = text.split(' ');
      const delta: ConfigDelta | undefined = negate ? ctx.config.unset(context, tokens) : ctx.config.set(context, tokens);
      return delta === undefined ? [] : acl.onConfig(ctx, delta);
    },
    filter(pdu, dir, iface, more = {}) {
      const family = more.family ?? 4;
      const onPermit: Action = family === 6
        ? { type: 'request', to: 'ipv6', req: { kind: 'ipv6.resume', pdu, inPort: iface, after: 'acl-in' } }
        : { type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: iface, after: 'acl-in' } };
      const req: FilterReq = { kind: 'acl.filter', family, dir, iface, pdu, onPermit, ...more };
      return { actions: acl.onRequest!(ctx, req), onPermit };
    },
    at: (ns) => fake.setNow(ns),
    writes: () => fake.trace.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.table === 'acl'),
    aclDebug: () => fake.debug.filter((d) => d.category === ACL_DEBUG_CATEGORY).map((d) => d.message),
  };
}

/** An IPv4 packet from the PC side, framed toward R1's Gi0/0. */
export function pkt(r: AclRig, layers: LayerSpec[], src = MAC_PC): Pdu {
  return r.fake.build(framed(MAC_R0, src, layers));
}

/** An IPv6 packet from the PC side, framed toward R1's Gi0/0 (EtherType 0x86dd). */
export function pkt6(r: AclRig, layers: LayerSpec[], src = MAC_PC): Pdu {
  return r.fake.build([{ proto: 'ethernet', fields: { dst: MAC_R0, src, type: 0x86dd } }, ...layers]);
}

export const tcpSyn = (src: string, sport: number, dst: string, dport: number, extraIp: Record<string, number> = {}): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst, protocol: 6, ttl: 128, id: 1, ...extraIp } },
  { proto: 'tcp', fields: { srcPort: sport, dstPort: dport, seq: 100, ack: 0, flags: 'S', window: 8192 } },
];

export const udp4 = (src: string, sport: number, dst: string, dport: number): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst, protocol: 17, ttl: 128, id: 1 } },
  { proto: 'udp', fields: { srcPort: sport, dstPort: dport } },
  { proto: 'payload', fields: { data: new Uint8Array(4) } },
];

export const tcpSyn6 = (src: string, sport: number, dst: string, dport: number): LayerSpec[] => [
  { proto: 'ipv6', fields: { src, dst, nextHeader: 6, hopLimit: 64 } },
  { proto: 'tcp', fields: { srcPort: sport, dstPort: dport, seq: 100, ack: 0, flags: 'S', window: 8192 } },
];

export const udp6 = (src: string, sport: number, dst: string, dport: number): LayerSpec[] => [
  { proto: 'ipv6', fields: { src, dst, nextHeader: 17, hopLimit: 64 } },
  { proto: 'udp', fields: { srcPort: sport, dstPort: dport } },
  { proto: 'payload', fields: { data: new Uint8Array(4) } },
];

/** An ICMPv6 message; a neighbour solicitation or advertisement (135, 136) carries `target` (default: `dst`). */
export const icmp6 = (src: string, dst: string, type: number, hopLimit = 64, target = dst): LayerSpec[] =>
  type === 135 || type === 136
    ? [{ proto: 'ipv6', fields: { src, dst, nextHeader: 58, hopLimit } }, { proto: 'icmpv6', fields: { type, code: 0, target } }]
    : [
      { proto: 'ipv6', fields: { src, dst, nextHeader: 58, hopLimit } },
      { proto: 'icmpv6', fields: { type, code: 0 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ];

export const drops = (actions: readonly Action[]) => actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');
export const requestsTo = (actions: readonly Action[], to: ProcessName) =>
  actions.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request' && a.to === to).map((a) => a.req);
export const logs = (actions: readonly Action[]) => actions.filter((a): a is Extract<Action, { type: 'log' }> => a.type === 'log');

// ── real worlds (staged.world, stage P3, the real acl daemon) ──────────────────────────────────────────────────────

const host = (name: string, address: string, gateway: string): string =>
  [`hostname ${name}`, '!', 'interface GigabitEthernet0', ` ip address ${address} 255.255.255.0`, '!', `ip default-gateway ${gateway}`, '!', 'end', ''].join('\n');

/** PC1 — R1 Gi0/0 (192.168.10.1); R1 Gi0/1 (192.168.20.1) — SRV, R1 with `r1Lines` appended (sections as text lines). */
export function world(r1Lines: readonly string[], seed = 41, gi0Lines: readonly string[] = []): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { acl: createAcl } });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: host('PC1', PC1, '192.168.10.1') });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: host('SRV', SRV, '192.168.20.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: [
      'hostname R1', '!',
      `interface ${GI0}`, ' ip address 192.168.10.1 255.255.255.0', ...gi0Lines, ' no shutdown', '!',
      `interface ${GI1}`, ' ip address 192.168.20.1 255.255.255.0', ' no shutdown', '!',
      ...r1Lines, '!', 'end', '',
    ].join('\n'),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  return sim;
}

/** `ping <target>` typed on `device`'s console, run to idle: the session text and the events of the run. */
export function pingFrom(sim: Simulation, device: string, target: string): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  sim.cli.exec(session, `ping ${target}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}
