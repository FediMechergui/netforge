/**
 * P3 acceptance — device clocks and an NTP chain (ARCHITECTURE-P3 §10.1 row `accept.p3.clock-ntp`; §3.7 steps 1–6;
 * D19; §2.6 `ntp-peers` / `clock`; §4.2 the ntp timers; §4.5 time integers; §5.5, §5.8; rule 19, rule 20; §7 W4 qa).
 *
 * The row, clause by clause, on `staged.world` at stage P3 (rule 13), whose registry is the real one since the W4
 * catalog flip (ruling R47 removed the pre-flip overlay, `FLIP_FACTORIES`). Lines a learner types go through the real
 * CLI: `service ntp on` in the server's host shell, `clock set`, `ntp master`, `ntp server` on consoles; the §3.7 boot
 * configuration through `startupConfig`.
 *
 *   §3.7 chain: SRV1 (NF-SERVER) 10.0.0.10 ↔ SW1 Fa0/1; SW1 (NF-C2960) Vlan1 10.0.0.2; R1 (NF-2911) Gi0/1 10.0.0.1 ↔
 *   SW1 Gi0/1. SRV1 `service ntp on` (= `ntp master 1`), R1 `ntp server 10.0.0.10`, SW1 `ntp server 10.0.0.1` (the line
 *   that wakes SW1's dormant transport, D22).
 *
 *   • the unset `*` clock value (2020-01-01 00:00:00 plus uptime) and "No time source";
 *   • `clock set` writes the `clock` row (source `user`) and the clock reads the typed time;
 *   • the chain SRV1 (1) → R1 (2) → SW1 (3): after `runToIdle` each clock equals true time plus the exact path
 *     asymmetry of its chain (to the nanosecond, from the exchange instants in the trace); SW1's first poll (at its boot)
 *     is unanswered and its re-poll is kicked by the link-up toward R1; the still unsynchronised R1 answers stratum 16 /
 *     leap 3 / INIT and SW1 rejects it, then synchronises on its next retry;
 *   • the retry schedule from the constants (`NTP_RETRY_SCHEDULE_NS`, `NTP_POLL_NS`), and a server that never answers
 *     leaves only the periodic poll, so `runToIdle` returns (rule 19);
 *   • `show ntp associations` and `show ntp status` exact;
 *   • offsets stored as integer ms plus a ns remainder: a first sync from 2020 (beyond 2^53 ns) fits exactly;
 *   • server loss decays `reach` over the periodic polls (`runFor`), down to `unreached`; the clock keeps running;
 *   • bare `ntp master` serves stratum 8, and from an unset clock the wrong time (2020) to its clients;
 *   • the `clock.*` and `ntp.*` facts read tables only (a runtime clock change behind the tables changes no fact);
 *   • no bigint in any snapshot or trace JSON; three runs with one seed byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS } from '../src/contracts/clock.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { LabAssertion } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ClockRow, NtpPeerRow, NtpStateView } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { FACT_READERS, checkFact } from '../src/sim/lab-checks/facts.js';
import { NTP_POLL_NS, NTP_RETRY_SCHEDULE_NS } from '../src/protocols/ntp.js';
import { createStagedSimulation } from './staged.world.js';

const SEED = 3_007_007;
const NS_PER_MS = 1_000_000n;
const IDLE_CAP = 2_000_000;
const MS_PER_DAY = 86_400_000;

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Consumed = Extract<TraceEvent, { kind: 'pduConsumed' }>;
type Write = Extract<TraceEvent, { kind: 'tableWrite' }>;
type Debug = Extract<TraceEvent, { kind: 'debug' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

// ── consoles ──────────────────────────────────────────────────────────────────────────────────────────────────

function privileged(sim: Simulation, dev: DeviceId): SessionId {
  const s = sim.cli.open(dev, 'console');
  expect(sim.cli.exec(s, 'enable').error).toBeUndefined();
  return s;
}

function typeConfig(sim: Simulation, dev: DeviceId, lines: readonly string[]): void {
  const s = privileged(sim, dev);
  for (const line of ['configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

function exec(sim: Simulation, dev: DeviceId, line: string): string {
  const s = privileged(sim, dev);
  const r = sim.cli.exec(s, line);
  expect(r.error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
  return r.output ?? '';
}

/** A host-shell line on `dev`'s console. */
function hostShell(sim: Simulation, dev: DeviceId, line: string): string {
  const s = sim.cli.open(dev, 'console');
  const r = sim.cli.exec(s, line);
  expect(r.error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
  return r.output ?? '';
}

// ── worlds ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The §3.7 chain; SRV1's host shell gets `service ntp on` once it has booted (at 10 s). */
function chain(seed = SEED): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3' });
  sim.addDevice({ id: 'srv1', type: 'server.nfserver', name: 'SRV1', startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['ip default-gateway 10.0.0.1']]) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown'], ['ip default-gateway 10.0.0.1'], ['ntp server 10.0.0.1']]) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/1', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'], ['ntp server 10.0.0.10']]) });
  sim.addLink({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runUntil(10 * SEC);
  expect(hostShell(sim, 'srv1', 'service ntp on')).toBe('Time service started (stratum 1).');
  return sim;
}

/**
 * R1 Gi0/1 10.0.0.1 ↔ SW1 Gi0/1 (Vlan1 10.0.0.2); PC1 10.0.0.20 on SW1 Fa0/1 (it runs no NTP: its port 123 is closed);
 * nothing about time configured. Run until `until` (default 100 s: everything booted and forwarding).
 */
function pair(seed = SEED, until: SimTime = 100 * SEC): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/1', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown']]) });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface GigabitEthernet0/1', ' spanning-tree portfast'], ['interface FastEthernet0/1', ' spanning-tree portfast'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown']]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.0.20 255.255.255.0']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.runUntil(until);
  return sim;
}

// ── readers ───────────────────────────────────────────────────────────────────────────────────────────────────

const peerRow = (sim: Simulation, dev: DeviceId, server: string): NtpPeerRow | undefined => sim.device(dev)!.tables.get<NtpPeerRow>('ntp-peers')?.get(server);
const clockRow = (sim: Simulation, dev: DeviceId): ClockRow | undefined => sim.device(dev)!.tables.get<ClockRow>('clock')?.get('clock');
const ntpView = (sim: Simulation, dev: DeviceId): NtpStateView => sim.device(dev)!.processes.get('ntp')!.stateSnapshot().state as unknown as NtpStateView;
const mode = (sim: Simulation, id: number): unknown => sim.pdu(id)?.get('ntp.mode');

/** Times of the NTP requests (mode 3) `dev` built. */
function polls(sim: Simulation, dev: DeviceId, evs: readonly TraceEvent[] = sim.trace(0).events): SimTime[] {
  return evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === dev && mode(sim, e.pdu.id) === 3).map((e) => e.t);
}

/** Floor division of BigInts (toward −∞). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/** A device clock's error (value − true time), in ns. */
function clockError(sim: Simulation, dev: DeviceId): bigint {
  const v = sim.device(dev)!.clockView(sim.now);
  return BigInt(v.unixMs) * NS_PER_MS + BigInt(v.subMsNs) - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(sim.now));
}

/** The error of an unset clock (2020-01-01 plus uptime) of a device booted at `bootedAt`. */
const unsetError = (bootedAt: SimTime): bigint => BigInt(NF_CLOCK_UNSET_UNIX_MS - NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS - BigInt(bootedAt);

/** `θ` (ns) split as the tables store it: integer ms (floor) and a 0 … 999 999 ns remainder. */
function split(theta: bigint): { offsetMs: number; offsetSubMsNs: number } {
  const ms = floorDiv(theta, NS_PER_MS);
  return { offsetMs: Number(ms), offsetSubMsNs: Number(theta - ms * NS_PER_MS) };
}

/**
 * The exchange that synchronised `client` from `server`, from the trace: a = the request built at the client, b = the
 * request consumed at the server (its reply built in the same instant), c = the reply consumed at the client (the
 * instant of its `clock` row).
 */
function syncExchange(sim: Simulation, client: DeviceId, server: DeviceId): { a: SimTime; b: SimTime; c: SimTime } {
  const evs = sim.trace(0).events;
  const write = evs.find((e): e is Write => e.kind === 'tableWrite' && e.device === client && e.table === 'clock' && e.row.source === 'ntp')!;
  expect(write, `${client} clock row`).toBeDefined();
  const reply = evs.find((e): e is Consumed => e.kind === 'pduConsumed' && e.device === client && e.t === write.t && mode(sim, e.pdu.id) === 4)!;
  const origin = sim.pdu(reply.pdu.id)!.get('ntp.originTimestamp');
  const req = evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === client && mode(sim, e.pdu.id) === 3 && sim.pdu(e.pdu.id)!.get('ntp.transmitTimestamp') === origin)!;
  const atServer = evs.find((e): e is Consumed => e.kind === 'pduConsumed' && e.device === server && e.pdu.id === req.pdu.id)!;
  expect(atServer, `${server} got the request`).toBeDefined();
  return { a: req.t, b: atServer.t, c: write.t };
}

/** Half the path asymmetry of an exchange, floored: ((b − a) − (c − b)) / 2. */
const halfAsymmetry = (x: { a: SimTime; b: SimTime; c: SimTime }): bigint => floorDiv(BigInt(x.b - x.a) - BigInt(x.c - x.b), 2n);

// ── independent renderers (the §5.8 formats, from the documented rules) ──────────────────────────────────────

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
/** `hh:mm:ss.mmm` of a Unix instant in ms (UTC). */
function timeOfDay(unixMs: number): string {
  const d = ((unixMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return `${pad(Math.floor(d / 3_600_000), 2)}:${pad(Math.floor(d / 60_000) % 60, 2)}:${pad(Math.floor(d / 1000) % 60, 2)}.${pad(d % 1000, 3)}`;
}
/** The Unix ms a clock reads at `now` given its error (ns). */
const readsMs = (now: SimTime, errorNs: bigint): number => Number(floorDiv(BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(now) + errorNs, NS_PER_MS));
/** θ in ms with three decimals, truncated toward zero. */
function offsetText(offsetMs: number, subNs: number): string {
  const ns = BigInt(offsetMs) * NS_PER_MS + BigInt(subNs);
  const abs = ns < 0n ? -ns : ns;
  return `${ns < 0n ? '-' : ''}${abs / NS_PER_MS}.${String((abs / 1000n) % 1000n).padStart(3, '0')}`;
}
const delayText = (ns: number): string => `${Math.floor(ns / 1_000_000)}.${pad(Math.floor(ns / 1000) % 1000, 3)}`;
const since = (from: SimTime, now: SimTime): string => {
  const s = Math.floor((now - from) / SEC);
  return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}`;
};
/** Left-aligned columns two spaces apart, each as wide as its widest cell (or its minimum); the last column unpadded. */
function columns(rows: readonly (readonly string[])[], minWidths: readonly number[]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(minWidths[i] ?? 0, ...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join(''));
}

/** A fact assertion graded on the live world (the §2.10 `fact` kind, the real readers). */
function fact(sim: Simulation, a: Omit<Extract<LabAssertion, { kind: 'fact' }>, 'kind'>): { pass: boolean; detail?: string } {
  const r = checkFact(sim, { kind: 'fact', ...a });
  return r.pass ? { pass: true } : { pass: false, detail: r.detail ?? '' };
}

/** Throws (JSON.stringify does) if any bigint is anywhere in `value`. */
function noBigint(value: unknown, what: string): void {
  expect(() => JSON.stringify(value), what).not.toThrow();
}

// ── the row ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('§3.7 step 1: the unset clock; clock set', () => {
  it('a router boots unset: 2020-01-01 00:00:00 plus uptime, shown with *, "No time source"; the fact reads unset', () => {
    const sim = pair(SEED, 50 * SEC);
    const r1 = sim.device('r1')!;
    expect(r1.bootedAt).toBe(45 * SEC);
    sim.runUntil(r1.bootedAt! + 12 * SEC + 500_000_000);
    expect(exec(sim, 'r1', 'show clock')).toBe('*00:00:12.500 UTC Wed Jan 1 2020');
    expect(exec(sim, 'r1', 'show clock detail')).toBe('*00:00:12.500 UTC Wed Jan 1 2020\nNo time source: the clock was never set.');
    expect(clockError(sim, 'r1')).toBe(unsetError(r1.bootedAt!));
    expect(clockRow(sim, 'r1')).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'clock.source', equals: 'unset' })).toEqual({ pass: true });
    // hosts and servers boot with true time
    expect(exec(sim, 'r1', 'show ntp status')).toBe('Clock is not synchronised, stratum 16, no reference\n  Time source: none: the clock was never set\n  Requests answered as a time server: 0');
  });

  it('clock set writes the clock row (source user) and the clock reads the typed time from that instant', () => {
    const sim = pair();
    const cursor = sim.trace(0).next;
    const t = sim.now;
    const s = privileged(sim, 'r1');
    expect(sim.cli.exec(s, 'clock set 10:30:00 6 January 2025').error).toBeUndefined();
    const unixMs = NF_WORLD_EPOCH_UNIX_MS + (2 * 3600 + 30 * 60) * 1000; // 10:30:00 on Mon 2025-01-06
    const offset = BigInt(unixMs) * NS_PER_MS - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(t));
    const writes = sim.trace(cursor).events.filter((e): e is Write => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'clock');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.row).toEqual({ key: 'clock', updatedAt: t, source: 'user', ...split(offset), since: t });
    expect(sim.cli.exec(s, 'show clock').output).toBe('10:30:00.000 UTC Mon Jan 6 2025');
    sim.runFor(2 * SEC + 250_000_000);
    expect(sim.cli.exec(s, 'show clock detail').output).toBe('10:30:02.250 UTC Mon Jan 6 2025\nTime source: set by hand (clock set).');
    expect(sim.cli.exec(s, 'show ntp status').output).toBe(
      `Clock is not synchronised, stratum 16, no reference\n  Time source: set by hand (clock set); not synchronised\n  Last set 00:00:02 ago; it reads ${offsetText(split(offset).offsetMs, split(offset).offsetSubMsNs)} ms from true time\n  Requests answered as a time server: 0`,
    );
    expect(fact(sim, { device: 'R1', fact: 'clock.source', equals: 'user' })).toEqual({ pass: true });
    expect(fact(sim, { device: 'R1', fact: 'clock.offsetMs', equals: split(offset).offsetMs })).toEqual({ pass: true });
  });
});

describe('§3.7 steps 2–5: the chain SRV1 (1) → R1 (2) → SW1 (3)', () => {
  const sim = chain();
  const stats = sim.runToIdle(IDLE_CAP);
  const evs = sim.trace(0).events;
  const r1 = sim.device('r1')!;
  const sw1 = sim.device('sw1')!;
  const debug = (dev: DeviceId): Debug[] => evs.filter((e): e is Debug => e.kind === 'debug' && e.event.device === dev && e.event.process === 'ntp');

  it('runToIdle returns; every clock equals true time plus the exact path asymmetry of its chain', () => {
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(IDLE_CAP);
    // SRV1: a host clock at true time, served at stratum 1
    expect(clockError(sim, 'srv1')).toBe(0n);
    expect(clockRow(sim, 'srv1')).toMatchObject({ source: 'master', stratum: 1, reference: 'LOCL', offsetMs: 0, offsetSubMsNs: 0 });
    // R1: its error is half the asymmetry of the path to SRV1
    const x1 = syncExchange(sim, 'r1', 'srv1');
    const e1 = halfAsymmetry(x1);
    expect(clockError(sim, 'r1')).toBe(e1);
    expect(clockRow(sim, 'r1')).toEqual({ key: 'clock', updatedAt: x1.c, source: 'ntp', stratum: 2, reference: '10.0.0.10', ...split(e1), since: x1.c });
    // SW1: R1's error plus half the asymmetry of its own path to R1
    const x2 = syncExchange(sim, 'sw1', 'r1');
    const e2 = e1 + halfAsymmetry(x2);
    expect(clockError(sim, 'sw1')).toBe(e2);
    expect(clockRow(sim, 'sw1')).toEqual({ key: 'clock', updatedAt: x2.c, source: 'ntp', stratum: 3, reference: '10.0.0.1', ...split(e2), since: x2.c });
    expect(x2.c).toBeGreaterThan(x1.c);
    // the rows of the peers: each follows its server (sys-peer)
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({ configured: true, refId: 'LOCL', stratum: 1, selected: 'sys-peer', pollS: 64 });
    expect(peerRow(sim, 'sw1', '10.0.0.1')).toMatchObject({ configured: true, refId: '10.0.0.10', stratum: 2, selected: 'sys-peer', pollS: 64 });
    // show clock: no '*', the synchronised time
    const now = sim.now;
    expect(exec(sim, 'r1', 'show clock')).toBe(`${timeOfDay(readsMs(now, e1))} UTC Mon Jan 6 2025`);
    expect(exec(sim, 'sw1', 'show clock detail')).toBe(`${timeOfDay(readsMs(now, e2))} UTC Mon Jan 6 2025\nTime source: NTP, stratum 3, from 10.0.0.1.`);
    // the runtime transition, once per device (category ntp events)
    const synced = evs.filter((e): e is Debug => e.kind === 'debug' && e.event.fsm?.machine === 'ntp' && e.event.fsm.to === 'synchronised');
    expect(synced.map((e) => e.event.device).sort()).toEqual(['r1', 'srv1', 'sw1']);
  });

  it("SW1's first poll (at its boot) is unanswered, and its re-poll is kicked by the link-up toward R1", () => {
    const boot = sw1.bootedAt!;
    const first = debug('sw1').find((e) => e.event.message.startsWith('sent a request to 10.0.0.1'))!;
    expect(first.t).toBe(boot);
    expect(first.event.message).toContain('(first poll)');
    // nothing answered SW1 before the cable toward R1 came up
    const up = evs.find((e) => e.kind === 'portState' && e.device === 'sw1' && e.port === 'GigabitEthernet0/1' && e.operUp)!;
    expect(up.t).toBe(r1.bootedAt!);
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === 'sw1' && mode(sim, e.pdu.id) === 4 && e.t <= up.t)).toBe(false);
    expect(peerRow(sim, 'sw1', '10.0.0.1')).toBeDefined();
    const atBoot = evs.find((e): e is Write => e.kind === 'tableWrite' && e.device === 'sw1' && e.table === 'ntp-peers')!;
    expect([atBoot.t, atBoot.row.reach, atBoot.row.selected]).toEqual([boot, 0, 'unreached']);
    // the link-up kicks a poll at once (0 ns, coalesced)
    const atUp = debug('sw1').filter((e) => e.t === up.t).map((e) => e.event.message);
    expect(atUp).toContain('polling 10.0.0.1 again now (a port came up or the route changed)');
    expect(atUp.some((m) => m.startsWith('sent a request to 10.0.0.1 (kick)'))).toBe(true);
  });

  it('the still unsynchronised R1 answers stratum 16 / leap 3 / INIT; SW1 rejects it and synchronises on its next retry', () => {
    const r1Synced = syncExchange(sim, 'r1', 'srv1').c;
    const early = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && mode(sim, e.pdu.id) === 4 && e.t < r1Synced);
    expect(early.length).toBeGreaterThan(0);
    for (const e of early) {
      const p = sim.pdu(e.pdu.id)!;
      expect([p.get('ntp.stratum'), p.get('ntp.leap'), p.get('ntp.refId'), p.get('ipv4.dst')]).toEqual([16, 3, 'INIT', '10.0.0.2']);
    }
    // SW1 consumed that answer and wrote a rejected peer row; its clock was not touched
    const rejected = evs.find((e): e is Write => e.kind === 'tableWrite' && e.device === 'sw1' && e.table === 'ntp-peers' && e.row.selected === 'reject')!;
    expect(rejected.row).toMatchObject({ stratum: 16, refId: 'INIT', reach: 0 });
    expect(evs.some((e) => e.kind === 'tableWrite' && e.device === 'sw1' && e.table === 'clock' && e.t <= rejected.t)).toBe(false);
    expect(debug('sw1').some((e) => e.t === rejected.t && e.event.message === 'rejected the reply from 10.0.0.1: the server is not synchronised (leap alarm)')).toBe(true);
    // the rejected poll is treated as unanswered: SW1's next request is the next instant of its fast schedule
    const sw1Polls = polls(sim, 'sw1');
    const rejectedPoll = sw1Polls.filter((t) => t <= rejected.t).at(-1)!;
    const next = sw1Polls.find((t) => t > rejected.t)!;
    const x2 = syncExchange(sim, 'sw1', 'r1');
    expect(x2.a).toBe(next);
    expect(NTP_RETRY_SCHEDULE_NS).toContain(next - rejectedPoll);
    expect(x2.b).toBeGreaterThan(r1Synced);
  });

  it('the retry schedule follows the constants: a kick, then +1, +2, +4, +8, +16 s while unsynchronised, then the 64 s poll', () => {
    // R1: no route at its first poll (boot), the port's link-up kicks a poll, the fast retries follow until the reply
    const up = evs.find((e) => e.kind === 'portState' && e.device === 'r1' && e.port === 'GigabitEthernet0/1' && e.operUp)!;
    const kick = up.t;
    const synced = syncExchange(sim, 'r1', 'srv1');
    const expected = [kick];
    let at = kick;
    for (const d of NTP_RETRY_SCHEDULE_NS) {
      at += d;
      if (at > synced.a) break;
      expected.push(at);
    }
    expect(expected.at(-1)).toBe(synced.a);
    const r1Polls = polls(sim, 'r1');
    expect(r1Polls.filter((t) => t <= synced.a)).toEqual(expected);
    // once synchronised no fast retry is left: the next request is the periodic poll, armed at the first poll (boot)
    expect(r1Polls.filter((t) => t > synced.a)).toEqual([r1.bootedAt! + NTP_POLL_NS].filter((t) => t <= sim.now));
  });

  it('show ntp associations and show ntp status are exact', () => {
    const now = sim.now;
    for (const [dev, server, mark] of [['r1', '10.0.0.10', '*'], ['sw1', '10.0.0.1', '*']] as const) {
      const row = peerRow(sim, dev, server)!;
      const peer = ntpView(sim, dev).peers.find((p) => p.address === server)!;
      const lines = columns(
        [
          ['', 'Address', 'Reference', 'Stratum', 'When', 'Poll', 'Next', 'Reach', 'Delay (ms)', 'Offset (ms)'],
          [
            mark, server, row.refId, String(row.stratum), String(Math.floor((now - row.lastRxAt!) / SEC)), '64', String(Math.floor((peer.nextPollAt! - now) / SEC)),
            row.reach.toString(8), delayText(row.delayNs!), offsetText(row.offsetMs!, row.offsetSubMsNs!),
          ],
        ],
        [1, 15, 9],
      );
      expect(exec(sim, dev, 'show ntp associations')).toBe(
        [...lines, 'Marks: * the server this clock follows, + a candidate, - its last reply was refused, ? not reached yet'].join('\n'),
      );
    }
    const c1 = clockRow(sim, 'r1')!;
    expect(exec(sim, 'r1', 'show ntp status')).toBe(
      [
        'Clock is synchronised, stratum 2, reference is 10.0.0.10',
        '  Time source: NTP',
        `  Last set ${since(c1.since, now)} ago; it reads ${offsetText(c1.offsetMs, c1.offsetSubMsNs)} ms from true time`,
        `  Requests answered as a time server: ${ntpView(sim, 'r1').served}`,
      ].join('\n'),
    );
    // R1 answered SW1 at every request that reached it (the stratum-16 answer included)
    expect(ntpView(sim, 'r1').served).toBe(evs.filter((e) => e.kind === 'pduCreated' && e.device === 'r1' && mode(sim, e.pdu.id) === 4).length);
    const c2 = clockRow(sim, 'sw1')!;
    expect(exec(sim, 'sw1', 'show ntp status')).toBe(
      [
        'Clock is synchronised, stratum 3, reference is 10.0.0.1',
        '  Time source: NTP',
        `  Last set ${since(c2.since, now)} ago; it reads ${offsetText(c2.offsetMs, c2.offsetSubMsNs)} ms from true time`,
        '  Requests answered as a time server: 0',
      ].join('\n'),
    );
  });

  it('offsets are stored as integer ms plus a ns remainder: the first sync from 2020 (beyond 2^53 ns) fits exactly', () => {
    const x1 = syncExchange(sim, 'r1', 'srv1');
    const theta = halfAsymmetry(x1) - unsetError(r1.bootedAt!);
    expect(theta > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // the peer row written by the synchronising reply holds θ split exactly
    const write = evs.find((e): e is Write => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'ntp-peers' && e.t === x1.c)!;
    const row = write.row as unknown as NtpPeerRow;
    expect({ offsetMs: row.offsetMs, offsetSubMsNs: row.offsetSubMsNs }).toEqual(split(theta));
    expect(Number.isSafeInteger(row.offsetMs)).toBe(true);
    expect(row.offsetSubMsNs! >= 0 && row.offsetSubMsNs! < 1_000_000).toBe(true);
    expect(BigInt(row.offsetMs!) * NS_PER_MS + BigInt(row.offsetSubMsNs!)).toBe(theta);
    expect(row.delayNs).toBe(x1.c - x1.a);
    // the step it made, in the ntp events line
    expect(debug('r1').some((e) => e.t === x1.c && e.event.message.startsWith(`stepped the clock by ${theta} ns`))).toBe(true);
  });

  it('the clock.* and ntp.* facts read the tables (§3.7 grading), never the runtime clock', () => {
    expect(fact(sim, { device: 'R1', fact: 'ntp.synced', equals: true })).toEqual({ pass: true });
    expect(fact(sim, { device: 'SW1', fact: 'ntp.stratum', equals: 3 })).toEqual({ pass: true });
    expect(fact(sim, { device: 'R1', fact: 'ntp.peer', equals: 'SRV1' })).toEqual({ pass: true });
    expect(fact(sim, { device: 'SW1', fact: 'clock.source', equals: 'ntp' })).toEqual({ pass: true });
    expect(fact(sim, { device: 'SW1', fact: 'ntp.stratum', equals: 2 })).toEqual({ pass: false, detail: 'SW1 ntp.stratum is 3, expected 2.' });
    // every reader names a table column (clock.source falls back to the catalog's boot clock, never the runtime)
    for (const name of ['ntp.synced', 'ntp.peer', 'ntp.stratum', 'clock.source', 'clock.offsetMs'] as const) {
      const source = FACT_READERS[name]!.source;
      expect(source.startsWith('ntp-peers.') || source.startsWith('clock.'), `${name}: ${source}`).toBe(true);
    }
    // the runtime clock moved behind the tables' back (no daemon, no row): every fact still reads the rows
    const before = clockRow(sim, 'sw1')!;
    sw1.setClock({ type: 'clock', op: 'set', unixMs: NF_WORLD_EPOCH_UNIX_MS + 3_600_000, source: 'user' }, sim.now);
    expect(sw1.clockView(sim.now).source).toBe('user');
    expect(clockRow(sim, 'sw1')).toEqual(before);
    expect(fact(sim, { device: 'SW1', fact: 'clock.source', equals: 'ntp' })).toEqual({ pass: true });
    expect(fact(sim, { device: 'SW1', fact: 'ntp.stratum', equals: 3 })).toEqual({ pass: true });
    expect(fact(sim, { device: 'SW1', fact: 'clock.offsetMs', equals: before.offsetMs })).toEqual({ pass: true });
  });
});

describe('§3.7 step 6 and rule 19: unanswered polls', () => {
  it('a server that never answers: a poll, six fast retries from the constants, then only the 64 s poll; runToIdle returns', () => {
    const sim = pair();
    const t0 = sim.now;
    typeConfig(sim, 'r1', ['ntp server 10.0.0.20']); // PC1: reachable, but no NTP service
    const stats = sim.runToIdle(IDLE_CAP);
    expect(stats.stopped).toBeUndefined();
    expect(sim.now).toBeLessThan(t0 + NTP_POLL_NS);
    const expected = [t0];
    let at = t0;
    for (const d of NTP_RETRY_SCHEDULE_NS) expected.push((at += d));
    expect(expected).toHaveLength(7);
    expect(polls(sim, 'r1')).toEqual(expected);
    // every request reached PC1 and met its closed port
    const evs = sim.trace(0).events;
    const reqs = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && mode(sim, e.pdu.id) === 3).map((e) => e.pdu.id);
    for (const id of reqs) expect(evs.some((e) => e.kind === 'drop' && e.device === 'pc1' && e.pdu.id === id && e.detail === 'udp port 123 closed'), `request ${id}`).toBe(true);
    sim.runUntil(t0 + 2 * NTP_POLL_NS + SEC);
    expect(polls(sim, 'r1')).toEqual([...expected, t0 + NTP_POLL_NS, t0 + 2 * NTP_POLL_NS]);
    expect(peerRow(sim, 'r1', '10.0.0.20')).toMatchObject({ reach: 0, selected: 'unreached', stratum: 16, refId: 'INIT' });
    expect(clockRow(sim, 'r1')).toBeUndefined();
    expect(ntpView(sim, 'r1').peers).toEqual([expect.objectContaining({ address: '10.0.0.20', retriesLeft: 0, nextPollAt: t0 + 3 * NTP_POLL_NS })]);
  });

  it('server loss: reach shifts in a zero at every periodic poll, unreached after 8 unanswered polls; the clock keeps running', () => {
    const sim = chain();
    sim.runToIdle(IDLE_CAP);
    const errBefore = clockError(sim, 'r1');
    const rowBefore = clockRow(sim, 'r1');
    const reach0 = peerRow(sim, 'r1', '10.0.0.10')!.reach;
    expect(reach0 & 1).toBe(1); // the last poll before the loss was answered
    const cursor = sim.trace(0).next;
    sim.setPower('srv1', false);
    sim.runFor(9 * NTP_POLL_NS + SEC);
    const evs = sim.trace(cursor).events;
    // only periodic polls (a synchronised client has no fast retries), 64 s apart
    const p = polls(sim, 'r1', evs);
    expect(p).toHaveLength(9);
    for (let i = 1; i < p.length; i++) expect(p[i]! - p[i - 1]!).toBe(NTP_POLL_NS);
    // the reach register: an unanswered poll is known when the next one leaves, and shifts a zero in at that instant
    const writes = evs.filter((e): e is Write => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'ntp-peers');
    const expected: number[] = [];
    let r = reach0;
    for (let i = 0; i < 8; i++) expected.push((r = (r << 1) & 0xff));
    expect(writes.map((e) => e.row.reach)).toEqual(expected);
    expect(writes.map((e) => e.t)).toEqual(p.slice(1));
    expect(expected.at(-1)).toBe(0);
    expect(writes.slice(0, -1).every((e) => e.row.selected === 'sys-peer')).toBe(true);
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({ reach: 0, selected: 'unreached' });
    // no drift model: the clock keeps its last step; the clock row is unchanged
    expect(clockError(sim, 'r1')).toBe(errBefore);
    expect(clockRow(sim, 'r1')).toEqual(rowBefore);
    expect(fact(sim, { device: 'R1', fact: 'ntp.synced', equals: false })).toEqual({ pass: true });
  });
});

describe('bare ntp master (D19)', () => {
  it('serves stratum 8; from an unset clock it serves the wrong time (2020), which its client then shows as synchronised', () => {
    const sim = pair();
    const r1 = sim.device('r1')!;
    typeConfig(sim, 'r1', ['ntp master']);
    expect(r1.running.render()).toContain('\nntp master\n');
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'master', stratum: 8, reference: '127.127.1.1', ...split(unsetError(r1.bootedAt!)) });
    expect(exec(sim, 'r1', 'show ntp status').split('\n').slice(0, 2)).toEqual([
      'Clock is synchronised, stratum 8, reference is 127.127.1.1',
      "  Time source: this device's own clock, served at stratum 8 (ntp master)",
    ]);
    typeConfig(sim, 'sw1', ['ntp server 10.0.0.1']);
    sim.runFor(3 * SEC);
    const replies = sim.trace(0).events.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && mode(sim, e.pdu.id) === 4);
    expect(replies.length).toBeGreaterThan(0);
    expect(sim.pdu(replies[0]!.pdu.id)!.get('ntp.stratum')).toBe(8);
    expect(clockRow(sim, 'sw1')).toMatchObject({ source: 'ntp', stratum: 9, reference: '10.0.0.1' });
    // SW1 now follows R1's 2020 clock: authoritative (no '*'), and five years wrong
    const x = syncExchange(sim, 'sw1', 'r1');
    const err = unsetError(r1.bootedAt!) + halfAsymmetry(x);
    expect(clockError(sim, 'sw1')).toBe(err);
    expect(exec(sim, 'sw1', 'show clock')).toBe(`${timeOfDay(readsMs(sim.now, err))} UTC Wed Jan 1 2020`);
    expect(fact(sim, { device: 'SW1', fact: 'ntp.stratum', equals: 9 })).toEqual({ pass: true });
  });
});

describe('no bigint in JSON; determinism', () => {
  it('snapshots and traces of NTP worlds serialise (no bigint anywhere); three runs with one seed are byte-identical', () => {
    const run = (): string => {
      const sim = chain();
      sim.runToIdle(IDLE_CAP);
      sim.runFor(2 * NTP_POLL_NS);
      typeConfig(sim, 'r1', ['ntp master 4']);
      sim.runFor(NTP_POLL_NS);
      const snapshot = sim.snapshot();
      const trace = sim.trace(0).events;
      noBigint(snapshot, 'snapshot');
      noBigint(trace, 'trace');
      for (const dev of ['r1', 'sw1', 'srv1'] as const) noBigint(sim.device(dev)!.processes.get('ntp')!.stateSnapshot(), `${dev} ntp StateView`);
      return JSON.stringify({ trace, snapshot });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
