/**
 * test/nat.harness.ts — shared helpers of the W3 nat tests (nat.static, nat.dynamic, nat.pat, nat.port-forward,
 * nat.icmp-error). Not a test file itself.
 *
 * Two levels:
 *  • `natFake()` — the ip.fake-ctx router (real ipv4, real tables, real PDU factory) extended with the `nat` and
 *    `sockets` tables and the real nat daemon; arp / icmpv4 / udp / tcp are recording sinks. Lines are applied through
 *    `configure` (config AST delta → `onConfig` of ipv4 and nat, actions routed), packets enter through `outbound`
 *    (arrives on the inside port) and `inbound` (arrives on the outside port), exactly as the runtime would call the
 *    daemons. Builders make datagrams, segments, echoes and ICMP errors quoting an original packet.
 *  • `natWorld()` — a real world on `test/p2.world.ts` (P1 profile, the real nat factory laid over the registry):
 *    PC1 and PC2 (or an inside router R0 for UDP traceroute) — R1 (Gi0/0 inside, Gi0/1 outside) — optionally R2 —
 *    SRV. Every R1 NAT line is given by the test.
 */
import type { Ipv4Address, MacAddress } from '../src/contracts/addr.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { PortId, ProcessName } from '../src/contracts/ids.js';
import {
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_QUOTE_PAYLOAD_BYTES,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  IPPROTO_UDP,
} from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessFactory, ProcessRequest } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DeviceTables, NatRow, SocketRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createTable } from '../src/core/table.js';
import { encodeLayers } from '../src/pdu/codecs/registry.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { createNat } from '../src/protocols/nat.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, output } from './sim.harness.js';

export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const MAC_R0 = '00:1f:00:00:00:10';
export const MAC_R1 = '00:1f:00:00:00:11';
export const MAC_PC1 = '00:1f:00:00:00:01';
export const MAC_PC2 = '00:1f:00:00:00:02';
export const MAC_SRV = '00:1f:00:00:00:20';
export const MASK24 = '255.255.255.0';

/** §3.9 addresses. */
export const PC1 = '192.168.1.10';
export const PC2 = '192.168.1.11';
export const R1_IN = '192.168.1.1';
export const R1_OUT = '203.0.113.1';
export const SRV = '203.0.113.10';
export const STATIC_GLOBAL = '203.0.113.5';

export const STATIC_LINE = `ip nat inside source static ${PC1} ${STATIC_GLOBAL}`;
export const ACL_LINE = 'access-list 1 permit 192.168.1.0 0.0.0.255';
export const POOL_LINE = 'ip nat pool P 203.0.113.20 203.0.113.29 netmask 255.255.255.0';
export const POOL_RULE = 'ip nat inside source list 1 pool P';
export const PAT_RULE = `ip nat inside source list 1 interface ${GI1} overload`;

// ── packet builders (no ethernet) ──────────────────────────────────────────

export function echo(src: Ipv4Address, dst: Ipv4Address, id: number, seq: number, ttl = 128, type = ICMP_ECHO_REQUEST): LayerSpec[] {
  const data = new Uint8Array(32);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  return [
    { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_ICMP, ttl, id: seq } },
    { proto: 'icmpv4', fields: { type, code: 0, id, seq } },
    { proto: 'payload', fields: { data } },
  ];
}

export function echoReply(src: Ipv4Address, dst: Ipv4Address, id: number, seq: number, ttl = 64): LayerSpec[] {
  return echo(src, dst, id, seq, ttl, ICMP_ECHO_REPLY);
}

export function udp(src: Ipv4Address, srcPort: number, dst: Ipv4Address, dstPort: number, ttl = 128, bytes = 12): LayerSpec[] {
  return [
    { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_UDP, ttl, id: 9 } },
    { proto: 'udp', fields: { srcPort, dstPort } },
    { proto: 'payload', fields: { data: new Uint8Array(bytes).fill(0xa5) } },
  ];
}

export function tcp(src: Ipv4Address, srcPort: number, dst: Ipv4Address, dstPort: number, flags: string, ttl = 128): LayerSpec[] {
  return [
    { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_TCP, ttl, id: 11 } },
    { proto: 'tcp', fields: { srcPort, dstPort, seq: 100, ack: 0, flags, window: 8192 } },
  ];
}

/** An ICMP error from `from` to `to` quoting the first IP header + 8 bytes of `original` (as icmpv4.ts builds it). */
export function icmpError(from: Ipv4Address, to: Ipv4Address, original: LayerSpec[], type = ICMP_TIME_EXCEEDED, code = 0, ttl = 255): LayerSpec[] {
  const packet = encodeLayers(original);
  const quote = packet.slice(0, 20 + ICMP_QUOTE_PAYLOAD_BYTES);
  return [
    { proto: 'ipv4', fields: { src: from, dst: to, protocol: IPPROTO_ICMP, ttl } },
    { proto: 'icmpv4', fields: { type, code, unused: 0 } },
    { proto: 'payload', fields: { data: quote } },
  ];
}

// ── the fake router ────────────────────────────────────────────────────────

export interface NatFake {
  readonly fake: Fake;
  readonly ctx: ProcessCtx;
  readonly nat: Process;
  readonly ipv4: Process;
  readonly natTable: Table<NatRow>;
  readonly sockets: Table<SocketRow>;
  readonly arp: ReturnType<typeof makeSink>;
  readonly icmp: ReturnType<typeof makeSink>;
  readonly udp: ReturnType<typeof makeSink>;
  readonly tcpSink: ReturnType<typeof makeSink>;
  /** Everything the router collected that was not routed to a process (drops, timers, …). */
  readonly actions: Action[];
  /** Every action applied, in order, routed ones included (requests, setPortL3, …). */
  readonly all: Action[];
  /** Apply a config line (global when `context` is empty); returns the actions of the fan-out. */
  configure(context: readonly (readonly string[])[], line: readonly string[], negate?: boolean): Action[];
  /** Global line from text (`ip nat inside source static …`). */
  global(text: string, negate?: boolean): Action[];
  /** Interface line from text. */
  iface(port: PortId, text: string, negate?: boolean): Action[];
  /** Boot: ipv4 then nat `init` with the current config. */
  boot(): Action[];
  /** A packet from an inside host arrives on GI0 (framed to R1). */
  outbound(packet: LayerSpec[], srcMac?: MacAddress): { pdu: Pdu; actions: Action[] };
  /** A packet from the outside arrives on GI1 (framed to R1). */
  inbound(packet: LayerSpec[], srcMac?: MacAddress): { pdu: Pdu; actions: Action[] };
  /** Send a request straight to nat. */
  request(req: ProcessRequest): Action[];
  /** Fire nat's timer. */
  timer(key: string): Action[];
  /** Advance the clock. */
  setNow(t: number): void;
  /** The `nat` rows (insertion order). */
  rows(): NatRow[];
  /** Mutation reasons recorded on `pdu` by this device, `reason:field`. */
  reasons(pdu: Pdu): string[];
  /** Debug messages of the `ip nat` category so far. */
  natDebug(): string[];
  /** The trace events of a kind. */
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
  /** Drop actions collected. */
  drops(): Extract<Action, { type: 'drop' }>[];
}

/** R1: GI0 192.168.1.1/24 (inside), GI1 203.0.113.1/24 (outside); the `ip nat` interface lines are applied by the test. */
export function natFake(opts: { addresses?: boolean } = {}): NatFake {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }], stage: 'P1' });
  const base = fake.ctx;
  const sink = { emit: (ev: TraceEvent) => void fake.trace.push(ev) };
  const clock = (): number => base.now;
  const natTable = createTable<NatRow>({ name: 'nat', device: base.deviceId, sink, now: clock });
  const sockets = createTable<SocketRow>({ name: 'sockets', device: base.deviceId, sink, now: clock });
  const extra = new Map<TableName, Table<TableRow>>([
    ['nat', natTable as unknown as Table<TableRow>],
    ['sockets', sockets as unknown as Table<TableRow>],
  ]);
  const tables: DeviceTables = {
    cam: base.tables.cam,
    arp: base.tables.arp,
    rib: base.tables.rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => (extra.get(name) as unknown as Table<R> | undefined) ?? base.tables.get<R>(name),
    names: () => [...base.tables.names(), 'nat', 'sockets'],
  };
  const model = { ...base.model, processes: [...base.model.processes, 'nat' as ProcessName], tables: [...base.model.tables, 'nat', 'sockets'] };
  const ctx = Object.create(base, { model: { value: model, enumerable: true }, tables: { value: tables, enumerable: true } }) as ProcessCtx;

  const ipv4 = createIpv4();
  const nat = createNat();
  const arp = makeSink('arp');
  const icmp = makeSink('icmpv4');
  const udpSink = makeSink('udp');
  const tcpSink = makeSink('tcp');
  const processes = new Map<string, Process>([
    ['ipv4', ipv4],
    ['nat', nat],
    ['arp', arp],
    ['icmpv4', icmp],
    ['udp', udpSink],
    ['tcp', tcpSink],
  ]);
  const collected: Action[] = [];
  const all: Action[] = [];

  function run(actions: Action[]): Action[] {
    for (const a of actions) {
      all.push(a);
      if (a.type === 'setPortL3') {
        fake.run([a]);
      } else if (a.type === 'deliver') {
        const p = processes.get(a.to);
        if (p) run(p.onPdu(ctx, a.pdu, a.port));
        else collected.push(a);
      } else if (a.type === 'request') {
        const p = processes.get(a.to);
        if (p?.onRequest) run(p.onRequest(ctx, a.req));
        else collected.push(a);
      } else if (a.type === 'event') {
        const p = processes.get(a.to);
        if (p?.onEvent) run(p.onEvent(ctx, a.ev));
        else collected.push(a);
      } else {
        collected.push(a);
      }
    }
    return actions;
  }

  function configure(context: readonly (readonly string[])[], line: readonly string[], negate = false): Action[] {
    const delta: ConfigDelta | undefined = negate ? ctx.config.unset(context, line) : ctx.config.set(context, line);
    if (delta === undefined) return [];
    const out: Action[] = [];
    for (const p of [ipv4, nat]) {
      const acts = p.onConfig(ctx, delta);
      out.push(...acts);
      run(acts);
    }
    return out;
  }

  const h: NatFake = {
    fake,
    ctx,
    nat,
    ipv4,
    natTable,
    sockets,
    arp,
    icmp,
    udp: udpSink,
    tcpSink,
    actions: collected,
    all,
    configure,
    global: (text, negate = false) => configure([], text.split(' '), negate),
    iface: (port, text, negate = false) => configure([['interface', port]], text.split(' '), negate),
    boot() {
      const out: Action[] = [];
      for (const p of [ipv4, nat]) {
        const acts = p.init ? p.init(ctx) : [];
        out.push(...acts);
        run(acts);
      }
      return out;
    },
    outbound(packet, srcMac = MAC_PC1) {
      const pdu = fake.build(framed(MAC_R0, srcMac, packet));
      const actions = run(ipv4.onPdu(ctx, pdu, GI0));
      return { pdu, actions };
    },
    inbound(packet, srcMac = MAC_SRV) {
      const pdu = fake.build(framed(MAC_R1, srcMac, packet));
      const actions = run(ipv4.onPdu(ctx, pdu, GI1));
      return { pdu, actions };
    },
    request: (req) => run(nat.onRequest!(ctx, req)),
    timer: (key) => run(nat.onTimer(ctx, key)),
    setNow: (t) => fake.setNow(t),
    rows: () => natTable.rows(),
    reasons: (pdu) => pdu.provenance.filter((m) => m.device === base.deviceId).map((m) => `${m.reason}:${m.field}`),
    natDebug: () => fake.debug.filter((d) => d.category === 'ip nat').map((d) => d.message),
    kinds: <K extends TraceEvent['kind']>(kind: K) => fake.trace.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind),
    drops: () => collected.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop'),
  };
  if (opts.addresses !== false) {
    h.iface(GI0, `ip address ${R1_IN} ${MASK24}`);
    h.iface(GI1, `ip address ${R1_OUT} ${MASK24}`);
    arp.requests.length = 0;
  }
  return h;
}

/** The `arp.sendVia` requests the sinks recorded, as `[nextHop, iface]`. */
export function sendVias(h: NatFake): [string, string][] {
  return h.arp.requests.filter((r): r is Extract<ProcessRequest, { kind: 'arp.sendVia' }> => r.kind === 'arp.sendVia').map((r) => [r.nextHop, r.iface]);
}

// ── real worlds ────────────────────────────────────────────────────────────

/** A registry overlay with only nat added (every other P2 daemon left out). */
export function natOverlay(): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = undefined;
  out['nat'] = createNat;
  return out;
}

export interface NatWorldOptions {
  readonly seed?: number;
  /** R1 global lines (NAT rules, ACLs, pools, routes). */
  readonly r1: readonly string[];
  /** Inside end systems on R1 Gi0/0 (a switch joins several); default PC1 and PC2. */
  readonly inside?: readonly { id: string; name: string; address: Ipv4Address; type?: 'pc' | 'router' }[];
  /** With R2 between R1 and SRV: R1 Gi0/1 203.0.113.1 — R2 Gi0/0 203.0.113.2, R2 Gi0/1 198.51.100.1 — SRV 198.51.100.10. */
  readonly far?: boolean;
  readonly bootNs?: number;
}

/** Address of SRV in a `far` world. */
export const SRV_FAR = '198.51.100.10';
export const R2_NEAR = '203.0.113.2';
export const R2_FAR = '198.51.100.1';

/**
 * PC1/PC2 — [SW] — R1 — (R2 —) SRV, R1 with `ip nat inside` on Gi0/0 and `ip nat outside` on Gi0/1 plus the given
 * lines. Inside end systems beyond the first share R1 Gi0/0 through an NF-C2960 (a transparent bridge here: no P2
 * daemon but nat has a factory, so eth-switch keeps the P1 path). Booted for `bootNs` (default 60 s).
 */
export function natWorld(opts: NatWorldOptions): Simulation {
  const sim = createP2Simulation({ seed: opts.seed ?? 5, profile: 'P1', factories: natOverlay() });
  const inside = opts.inside ?? [
    { id: 'pc1', name: 'PC1', address: PC1 },
    { id: 'pc2', name: 'PC2', address: PC2 },
  ];
  const srvAddress = opts.far ? SRV_FAR : SRV;
  const srvGateway = opts.far ? R2_FAR : R1_OUT;
  for (const h of inside) {
    if (h.type === 'router') {
      sim.addDevice({
        id: h.id, type: 'router.nf2911', name: h.name,
        startupConfig: configText([[`hostname ${h.name}`], section(`interface ${GI0}`, [`ip address ${h.address} ${MASK24}`, 'no shutdown']), [`ip route 0.0.0.0 0.0.0.0 ${R1_IN}`]]),
      });
    } else {
      sim.addDevice({ id: h.id, type: 'pc.nfpc', name: h.name, startupConfig: pcConfig(h.name, h.address, MASK24, R1_IN) });
    }
  }
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: pcConfig('SRV', srvAddress, MASK24, srvGateway) });
  const r1Routes = opts.far ? [`ip route 0.0.0.0 0.0.0.0 ${R2_NEAR}`] : [];
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section(`interface ${GI0}`, [`ip address ${R1_IN} ${MASK24}`, 'ip nat inside', 'no shutdown']),
      section(`interface ${GI1}`, [`ip address ${R1_OUT} ${MASK24}`, 'ip nat outside', 'no shutdown']),
      [...r1Routes, ...opts.r1],
    ]),
  });
  if (opts.far) {
    sim.addDevice({
      id: 'r2', type: 'router.nf2911', name: 'R2',
      startupConfig: configText([
        ['hostname R2'],
        section(`interface ${GI0}`, [`ip address ${R2_NEAR} ${MASK24}`, 'no shutdown']),
        section(`interface ${GI1}`, [`ip address ${R2_FAR} ${MASK24}`, 'no shutdown']),
      ]),
    });
    sim.addLink({ id: 'l_r1_r2', a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ id: 'l_r2_srv', a: { device: 'r2', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
  } else {
    sim.addLink({ id: 'l_r1_srv', a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
  }
  const portOf = (h: { type?: 'pc' | 'router' }): string => (h.type === 'router' ? GI0 : 'GigabitEthernet0');
  if (inside.length === 1) {
    const only = inside[0]!;
    sim.addLink({ id: 'l_in', a: { device: only.id, port: portOf(only) }, b: { device: 'r1', port: GI0 } });
  } else {
    sim.addDevice({ id: 'sw', type: 'switch.nfc2960', name: 'SW1' });
    sim.addLink({ id: 'l_sw_r1', a: { device: 'sw', port: 'GigabitEthernet0/1' }, b: { device: 'r1', port: GI0 } });
    inside.forEach((h, i) => {
      sim.addLink({ id: `l_in_${h.id}`, a: { device: h.id, port: portOf(h) }, b: { device: 'sw', port: `FastEthernet0/${i + 1}` } });
    });
  }
  sim.runFor(opts.bootNs ?? 60 * SEC);
  return sim;
}

/** Type `line` on `device`, run to idle, return the session output and the events since. */
export function exec(sim: Simulation, device: string, line: string): { session: string; text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`"${line}" on ${device} failed: ${r.output}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { session, text: output(evs, session), evs };
}

/** Type `line` on `device` without running (the caller runs, so two devices can act "at the same time"). */
export function start(sim: Simulation, device: string, line: string): string {
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`"${line}" on ${device} failed: ${r.output}`);
  return session;
}

/** The NAT rows of R1. */
export function natRows(sim: Simulation, device = 'r1'): NatRow[] {
  return sim.device(device)!.tables.get<NatRow>('nat')!.rows();
}

/** `[reason, field, before, after]` of every mutation stamped `device` on `pdu`. */
export function mutationsAt(sim: Simulation, pduId: number, device: string): [string, string, unknown, unknown][] {
  return sim.pdu(pduId)!.provenance.filter((m) => m.device === device).map((m) => [m.reason, m.field, m.before, m.after]);
}

/** Ids of the PDUs `device` created with a tag starting with `tag`. */
export function createdBy(evs: readonly TraceEvent[], device: string, tag: string): number[] {
  return ofKind(evs, 'pduCreated').filter((e) => e.device === device && (e.pdu.tag ?? '').startsWith(tag)).map((e) => e.pdu.id);
}
