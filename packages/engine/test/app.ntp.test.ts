/**
 * app.ntp — the ntp daemon on real worlds (ARCHITECTURE-P3 D19, §2.4, §2.6, §3.7, §4.2, §4.3; §7 W2 svc), built on
 * `staged.world` at stage P3 with the ntp factory (rule 13). Configuration goes through `startupConfig` or
 * `DeviceRuntime.applyConfigLine` (the config store; the `ntp` grammar is the W2 cli item's).
 *
 *  • the §3.7 chain SRV1 (ntp master 1) ← R1 (ntp server SRV1) ← SW1 (ntp server R1): every clock equals true time
 *    plus the exact path asymmetry of its chain — the offsets of the `clock` and `ntp-peers` rows are checked to the
 *    nanosecond, split into ms and ns, against the exchange times read from the trace;
 *  • the kicks: a port coming up and a route appearing re-poll at once;
 *  • the fast retries 1, 2, 4, 8, 16, 32 s after a poll nobody answers, nothing after the sixth but the 64 s poll, and
 *    `runToIdle` returns;
 *  • a stratum-16 answer is rejected; bare `ntp master` serves stratum 8; the `clock` row is written only on a change;
 *    `clock set` through `ntp.clockSet`; a lost server turns `unreached` after 8 polls; silence without a line.
 */
import { describe, expect, it } from 'vitest';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS } from '../src/contracts/clock.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ClockRow, NtpPeerRow, NtpStateView } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createNtp, NTP_POLL_NS, NTP_RETRY_SCHEDULE_NS, splitOffsetNs } from '../src/protocols/ntp.js';
import { createStagedSimulation } from './staged.world.js';

const FACTORIES = { ntp: createNtp };
const NS_PER_MS = 1_000_000n;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

function world(seed: number): Simulation {
  return createStagedSimulation({ seed, stage: 'P3', factories: FACTORIES });
}

/** Store one global line on `dev` at the current time (the facade's clock sync first, as `configure` does). */
function setLine(sim: Simulation, dev: DeviceId, text: string, negate = false): void {
  const d = sim.device(dev)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine([], text.split(' '), negate)).toEqual({ ok: true });
}

const peerRow = (sim: Simulation, dev: DeviceId, server: string): NtpPeerRow | undefined => sim.device(dev)!.tables.get<NtpPeerRow>('ntp-peers')?.get(server);
const clockRow = (sim: Simulation, dev: DeviceId): ClockRow | undefined => sim.device(dev)!.tables.get<ClockRow>('clock')?.get('clock');
const ntpView = (sim: Simulation, dev: DeviceId): NtpStateView => sim.device(dev)!.processes.get('ntp')!.stateSnapshot().state as unknown as NtpStateView;
const ntpMode = (sim: Simulation, id: number): unknown => sim.pdu(id)?.get('ntp.mode');

/** The NTP packets of `mode` that `dev` built (pduCreated), as PDU views. */
function built(sim: Simulation, dev: DeviceId, mode: number): NonNullable<ReturnType<Simulation['pdu']>>[] {
  return sim
    .trace(0)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === dev && ntpMode(sim, e.pdu.id) === mode)
    .map((e) => sim.pdu(e.pdu.id)!);
}

/** Times of the NTP client requests `dev` built (pduCreated of a mode-3 packet). */
function polls(sim: Simulation, dev: DeviceId, evs: readonly TraceEvent[] = sim.trace(0).events): SimTime[] {
  return evs.filter((e) => e.kind === 'pduCreated' && e.device === dev && ntpMode(sim, e.pdu.id) === 3).map((e) => e.t);
}

/** Floor division of BigInts. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/** A device clock's error (value − true time) in ns. */
function clockError(sim: Simulation, dev: DeviceId): bigint {
  const v = sim.device(dev)!.clockView(sim.now);
  return BigInt(v.unixMs) * NS_PER_MS + BigInt(v.subMsNs) - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(sim.now));
}

/** The error of an unset clock of a device booted at `bootedAt`: (unset − epoch) ms − bootedAt ns, at any time. */
const unsetError = (bootedAt: SimTime): bigint => BigInt(NF_CLOCK_UNSET_UNIX_MS - NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS - BigInt(bootedAt);

/**
 * The exchange that synchronised `client` from `server`, read from the trace: a = the request built at the client,
 * b = the request consumed at the server (its reply built in the same instant), c = the reply consumed at the client
 * (the instant the client wrote its `clock` row).
 */
function syncExchange(sim: Simulation, client: DeviceId, server: DeviceId): { a: SimTime; b: SimTime; c: SimTime } {
  const evs = sim.trace(0).events;
  const write = evs.find((e) => e.kind === 'tableWrite' && e.device === client && e.table === 'clock' && e.row.source === 'ntp');
  expect(write, `${client} clock row`).toBeDefined();
  const c = write!.t;
  const consumed = evs.find((e) => e.kind === 'pduConsumed' && e.device === client && e.t === c && ntpMode(sim, e.pdu.id) === 4);
  expect(consumed, `${client} reply`).toBeDefined();
  const origin = sim.pdu((consumed as { pdu: { id: number } }).pdu.id)!.get('ntp.originTimestamp');
  const req = evs.find(
    (e) => e.kind === 'pduCreated' && e.device === client && ntpMode(sim, e.pdu.id) === 3 && sim.pdu(e.pdu.id)!.get('ntp.transmitTimestamp') === origin,
  ) as Extract<TraceEvent, { kind: 'pduCreated' }>;
  expect(req, `${client} request`).toBeDefined();
  const atServer = evs.find((e) => e.kind === 'pduConsumed' && e.device === server && e.pdu.id === req.pdu.id);
  expect(atServer, `${server} received the request`).toBeDefined();
  return { a: req.t, b: atServer!.t, c };
}

/** The last reply `client` received from `serverAddr`, with its exchange times (as `syncExchange`). */
function lastExchange(sim: Simulation, client: DeviceId, server: DeviceId, serverAddr: string): { a: SimTime; b: SimTime; c: SimTime } {
  const evs = sim.trace(0).events;
  const consumed = evs.filter((e) => e.kind === 'pduConsumed' && e.device === client && ntpMode(sim, e.pdu.id) === 4 && sim.pdu(e.pdu.id)!.get('ipv4.src') === serverAddr).at(-1);
  expect(consumed, `${client} last reply`).toBeDefined();
  const origin = sim.pdu((consumed as { pdu: { id: number } }).pdu.id)!.get('ntp.originTimestamp');
  const req = evs.find(
    (e) => e.kind === 'pduCreated' && e.device === client && ntpMode(sim, e.pdu.id) === 3 && sim.pdu(e.pdu.id)!.get('ntp.transmitTimestamp') === origin,
  ) as Extract<TraceEvent, { kind: 'pduCreated' }>;
  const atServer = evs.find((e) => e.kind === 'pduConsumed' && e.device === server && e.pdu.id === req.pdu.id);
  return { a: req.t, b: atServer!.t, c: consumed!.t };
}

/** θ of the step `client` made (its `ntp events` line "stepped the clock by <θ> ns …"). */
function stepTheta(sim: Simulation, client: DeviceId): bigint {
  const ev = sim.trace(0).events.find((e) => e.kind === 'debug' && e.event.device === client && e.event.process === 'ntp' && e.event.message.startsWith('stepped the clock by '));
  expect(ev, `${client} step`).toBeDefined();
  return BigInt(/^stepped the clock by (-?\d+) ns/.exec((ev as Extract<TraceEvent, { kind: 'debug' }>).event.message)![1]!);
}

/** The §3.7 chain: SRV1 10.0.0.10 (ntp master 1), R1 Gi0/1 10.0.0.1 (ntp server 10.0.0.10), SW1 Vlan1 10.0.0.2 (ntp server 10.0.0.1). */
function chain(seed: number): Simulation {
  const sim = world(seed);
  sim.addDevice({
    id: 'srv1', type: 'server.nfserver', name: 'SRV1',
    startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['ip default-gateway 10.0.0.1'], ['ntp master 1']]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown'], ['ip default-gateway 10.0.0.1'], ['ntp server 10.0.0.1']]),
  });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/1', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'], ['ntp server 10.0.0.10']]),
  });
  sim.addLink({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  return sim;
}

/** R1 Gi0/0 10.0.0.1 — SRV1 10.0.0.10 (cabled when `cabled`); SRV1 runs ntp with `srvLines` (none: port 123 closed). */
function pair(seed: number, opts: { cabled: boolean; srvLines?: readonly string[]; r1Lines?: readonly string[] }): Simulation {
  const sim = world(seed);
  sim.addDevice({
    id: 'srv1', type: 'server.nfserver', name: 'SRV1',
    startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['ip default-gateway 10.0.0.1'], ...(opts.srvLines ?? []).map((l) => [l])]),
  });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' no shutdown'],
      ...(opts.r1Lines ?? []).map((l) => [l]),
    ]),
  });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2']]) });
  if (opts.cabled) sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'srv1', port: 'GigabitEthernet0' } });
  return sim;
}

describe('app.ntp: the §3.7 chain (D19)', () => {
  it('synchronises SRV1 → R1 → SW1 with exact offsets (ms + ns) and the rows of each level', () => {
    const sim = chain(31);
    const idle = sim.runToIdle(2_000_000);
    expect(idle.events).toBeLessThan(2_000_000);
    // SRV1: master at stratum 1 over its true-time clock
    expect(clockRow(sim, 'srv1')).toMatchObject({ source: 'master', stratum: 1, reference: 'LOCL', offsetMs: 0, offsetSubMsNs: 0 });
    expect(clockError(sim, 'srv1')).toBe(0n);

    // R1 (stratum 2): error = 0 + floor(((b − a) − (c − b)) / 2), measured against its unset boot clock
    const x1 = syncExchange(sim, 'r1', 'srv1');
    const e1 = floorDiv(BigInt(x1.b - x1.a) - BigInt(x1.c - x1.b), 2n);
    const theta1 = e1 - unsetError(sim.device('r1')!.bootedAt!);
    expect(theta1).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER)); // a 2020 → 2025 step: beyond 2^53 ns, hence the split
    expect(stepTheta(sim, 'r1')).toBe(theta1);
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'ntp', stratum: 2, reference: '10.0.0.10', ...splitOffsetNs(e1), since: x1.c });
    expect(clockError(sim, 'r1')).toBe(e1);
    // the peer row holds the last exchange (a later poll of a synchronised client only updates it)
    const l1 = lastExchange(sim, 'r1', 'srv1', '10.0.0.10');
    const thetaL1 = (l1.c === x1.c ? theta1 : -e1 + floorDiv(BigInt(l1.b - l1.a) - BigInt(l1.c - l1.b), 2n));
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({
      address: '10.0.0.10', configured: true, refId: 'LOCL', stratum: 1, pollS: 64, selected: 'sys-peer', lastRxAt: l1.c, delayNs: l1.c - l1.a, ...splitOffsetNs(thetaL1),
    });
    expect(peerRow(sim, 'r1', '10.0.0.10')!.reach & 1).toBe(1);

    // SW1 (stratum 3): R1's error plus its own exchange's half asymmetry
    const x2 = syncExchange(sim, 'sw1', 'r1');
    const e2 = e1 + floorDiv(BigInt(x2.b - x2.a) - BigInt(x2.c - x2.b), 2n);
    const theta2 = e2 - unsetError(sim.device('sw1')!.bootedAt!);
    expect(stepTheta(sim, 'sw1')).toBe(theta2);
    expect(clockRow(sim, 'sw1')).toMatchObject({ source: 'ntp', stratum: 3, reference: '10.0.0.1', ...splitOffsetNs(e2) });
    expect(clockError(sim, 'sw1')).toBe(e2);
    const l2 = lastExchange(sim, 'sw1', 'r1', '10.0.0.1');
    const thetaL2 = l2.c === x2.c ? theta2 : e1 - e2 + floorDiv(BigInt(l2.b - l2.a) - BigInt(l2.c - l2.b), 2n);
    expect(peerRow(sim, 'sw1', '10.0.0.1')).toMatchObject({ refId: '10.0.0.10', stratum: 2, selected: 'sys-peer', delayNs: l2.c - l2.a, ...splitOffsetNs(thetaL2) });

    // the split: 0 ≤ sub-ms < 1 000 000, floored toward −∞
    for (const r of [clockRow(sim, 'r1')!, clockRow(sim, 'sw1')!, peerRow(sim, 'r1', '10.0.0.10')!]) {
      expect(r.offsetSubMsNs).toBeGreaterThanOrEqual(0);
      expect(r.offsetSubMsNs).toBeLessThan(1_000_000);
    }
    // the runtime's transition (category 'ntp events') on each client, once
    const transitions = sim.trace(0).events.filter((e) => e.kind === 'debug' && e.event.fsm?.machine === 'ntp' && e.event.fsm.to === 'synchronised');
    expect(transitions.map((e) => (e as Extract<TraceEvent, { kind: 'debug' }>).event.device).sort()).toEqual(['r1', 'srv1', 'sw1']);
    // SW1 woke its dormant transport through its `ntp server` line (D22): R1 answered it
    expect(ntpView(sim, 'r1').served).toBeGreaterThan(0);
  });

  it('later periodic polls rewrite nothing on the clock row (rule 20), and a synchronised client is answered at its stratum', () => {
    const sim = chain(32);
    sim.runToIdle(2_000_000);
    const writes = (dev: DeviceId): number => sim.trace(0).events.filter((e) => e.kind === 'tableWrite' && e.device === dev && e.table === 'clock').length;
    expect(writes('r1')).toBe(1);
    expect(writes('sw1')).toBe(1);
    const before = clockError(sim, 'r1');
    sim.runFor(10 * NTP_POLL_NS);
    expect(writes('r1')).toBe(1);
    expect(writes('sw1')).toBe(1);
    expect(clockError(sim, 'r1')).toBe(before);
    expect(peerRow(sim, 'r1', '10.0.0.10')!.reach).toBe(0xff);
    // the replies R1 sent after it synchronised carry stratum 2 and its reference
    const replies = built(sim, 'r1', 4);
    expect(replies.at(-1)!.get('ntp.stratum')).toBe(2);
    expect(replies.at(-1)!.get('ntp.refId')).toBe('10.0.0.10');
    expect(replies.at(-1)!.get('ntp.leap')).toBe(0);
  });

  it('a server that goes away: reach shifts in zeros every 64 s and the peer is unreached after 8 polls; the clock stays', () => {
    const sim = chain(33);
    sim.runToIdle(2_000_000);
    const err = clockError(sim, 'r1');
    sim.setPower('srv1', false);
    sim.runFor(9 * NTP_POLL_NS);
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({ reach: 0, selected: 'unreached' });
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'ntp', stratum: 2 });
    expect(clockError(sim, 'r1')).toBe(err);
  });
});

describe('app.ntp: polling while unsynchronised (D19, §4.2)', () => {
  it('retries after 1, 2, 4, 8, 16 and 32 s, then only the periodic poll; runToIdle returns', () => {
    const sim = pair(41, { cabled: true });
    sim.runFor(100 * SEC);
    const t0 = sim.now;
    setLine(sim, 'r1', 'ntp server 10.0.0.10');
    const idle = sim.runToIdle(1_000_000);
    expect(idle.events).toBeLessThan(1_000_000);
    expect(sim.now).toBeLessThan(t0 + NTP_POLL_NS);
    let at = t0;
    const expected = [t0];
    for (const d of NTP_RETRY_SCHEDULE_NS) expected.push((at += d));
    expect(expected.at(-1)).toBe(t0 + 63 * SEC);
    expect(polls(sim, 'r1')).toEqual(expected);
    expect(ntpView(sim, 'r1').peers).toEqual([expect.objectContaining({ address: '10.0.0.10', retriesLeft: 0, nextPollAt: t0 + NTP_POLL_NS })]);
    sim.runUntil(t0 + 2 * NTP_POLL_NS + 10 * SEC);
    expect(polls(sim, 'r1')).toEqual([...expected, t0 + NTP_POLL_NS, t0 + 2 * NTP_POLL_NS]);
    // SRV1 has no ntp line: port 123 is closed there, nothing answered, nothing was written but the peer row
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({ reach: 0, selected: 'unreached', stratum: 16, refId: 'INIT' });
    expect(clockRow(sim, 'r1')).toBeUndefined();
  });

  it('kicks a poll at once when a port comes up (the route toward the server unchanged)', () => {
    const sim = pair(42, { cabled: true, r1Lines: ['ntp server 10.0.0.10'] });
    sim.runFor(200 * SEC);
    const before = polls(sim, 'r1');
    expect(before.length).toBeGreaterThanOrEqual(7); // a kicked poll and six retries since the link came up, then periodic polls
    const cursor = sim.trace(0).next;
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
    sim.runFor(5 * SEC);
    const evs = sim.trace(cursor).events;
    const up = evs.find((e) => e.kind === 'portState' && e.device === 'r1' && e.port === 'GigabitEthernet0/1' && e.operUp === true);
    expect(up).toBeDefined();
    const after = polls(sim, 'r1', evs);
    expect(after[0]).toBe(up!.t);
    // and the fast schedule restarted: +1 s, +3 s
    expect(after.slice(0, 3)).toEqual([up!.t, up!.t + 1 * SEC, up!.t + 3 * SEC]);
  });

  it('kicks a poll at once when the route toward the server appears, and synchronises', () => {
    const sim = world(43);
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 10.0.1.1 255.255.255.0', ' no shutdown'], ['ntp server 10.0.2.10']]),
    });
    sim.addDevice({
      id: 'r2', type: 'router.nf2911', name: 'R2',
      startupConfig: startup([
        ['hostname R2'],
        ['interface GigabitEthernet0/0', ' ip address 10.0.1.2 255.255.255.0', ' no shutdown'],
        ['interface GigabitEthernet0/1', ' ip address 10.0.2.1 255.255.255.0', ' no shutdown'],
      ]),
    });
    sim.addDevice({
      id: 'srv1', type: 'server.nfserver', name: 'SRV1',
      startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.2.10 255.255.255.0'], ['ip default-gateway 10.0.2.1'], ['ntp master 1']]),
    });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'r2', port: 'GigabitEthernet0/0' } });
    sim.addLink({ a: { device: 'r2', port: 'GigabitEthernet0/1' }, b: { device: 'srv1', port: 'GigabitEthernet0' } });
    sim.runFor(200 * SEC);
    // no route: no request ever left (the sends failed no-route), nothing is synchronised
    expect(polls(sim, 'r1')).toEqual([]);
    expect(clockRow(sim, 'r1')).toBeUndefined();
    const t = sim.now;
    const d = sim.device('r1')!;
    d.applyActions('sim', [], t);
    expect(d.applyConfigLine([], ['ip', 'route', '10.0.2.0', '255.255.255.0', '10.0.1.2'], false)).toEqual({ ok: true });
    sim.runFor(2 * SEC);
    expect(polls(sim, 'r1')[0]).toBe(t);
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'ntp', stratum: 2, reference: '10.0.2.10' });
    expect(peerRow(sim, 'r1', '10.0.2.10')).toMatchObject({ selected: 'sys-peer', stratum: 1 });
  });
});

describe('app.ntp: servers, master and the clock row', () => {
  it('rejects a stratum-16 answer (leap 3, INIT) and keeps retrying', () => {
    // SRV1 runs ntp as a client of a server it cannot reach: it answers, unsynchronised
    const sim = pair(51, { cabled: true, srvLines: ['ntp server 10.9.9.9'] });
    sim.runFor(100 * SEC);
    const t0 = sim.now;
    setLine(sim, 'r1', 'ntp server 10.0.0.10');
    sim.runFor(2 * SEC);
    const replies = built(sim, 'srv1', 4);
    expect(replies.length).toBeGreaterThan(0);
    expect([replies[0]!.get('ntp.stratum'), replies[0]!.get('ntp.leap'), replies[0]!.get('ntp.refId')]).toEqual([16, 3, 'INIT']);
    expect(peerRow(sim, 'r1', '10.0.0.10')).toMatchObject({ selected: 'reject', stratum: 16, refId: 'INIT', reach: 0 });
    expect(ntpView(sim, 'r1').peers[0]!.lastReject).toMatch(/not synchronised/);
    expect(clockRow(sim, 'r1')).toBeUndefined();
    sim.runFor(10 * SEC);
    expect(polls(sim, 'r1').filter((t) => t >= t0)).toEqual([t0, t0 + 1 * SEC, t0 + 3 * SEC, t0 + 7 * SEC]);
  });

  it('bare `ntp master` serves stratum 8 (even an unset clock); a client of it is at stratum 9', () => {
    const sim = pair(52, { cabled: true, r1Lines: ['ntp master'] });
    sim.runFor(60 * SEC);
    const r1 = sim.device('r1')!;
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'master', stratum: 8, reference: '127.127.1.1', ...splitOffsetNs(unsetError(r1.bootedAt!)) });
    expect(ntpView(sim, 'r1').master).toEqual({ stratum: 8 });
    expect(r1.clockView(sim.now)).toMatchObject({ source: 'master', authoritative: true, stratum: 8 });
    // SRV1 (a host: true time) follows R1's unset 2020 clock at stratum 9 — realistic, and a lesson
    setLine(sim, 'srv1', 'ntp server 10.0.0.1');
    sim.runFor(2 * SEC);
    expect(clockRow(sim, 'srv1')).toMatchObject({ source: 'ntp', stratum: 9, reference: '10.0.0.1' });
    expect(peerRow(sim, 'srv1', '10.0.0.1')).toMatchObject({ stratum: 8, refId: '127.127.1.1', selected: 'sys-peer' });
    expect(clockError(sim, 'srv1') < -100_000_000_000_000_000n).toBe(true);
  });

  it('`clock set` through ntp.clockSet: a user clock and its row; a synchronised client becomes unsynchronised', () => {
    const sim = chain(53);
    sim.runToIdle(2_000_000);
    const r1 = sim.device('r1')!;
    const unixMs = 1_748_779_200_000; // Sun 2025-06-01 12:00:00 UTC
    const t = sim.now;
    r1.applyActions('sim', [{ type: 'request', to: 'ntp', req: { kind: 'ntp.clockSet', unixMs } }], t);
    const offset = BigInt(unixMs) * NS_PER_MS - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(t));
    expect(clockRow(sim, 'r1')).toEqual({ key: 'clock', updatedAt: t, source: 'user', ...splitOffsetNs(offset), since: t });
    expect(r1.clockView(t)).toMatchObject({ source: 'user', authoritative: true, unixMs, subMsNs: 0 });
    expect(peerRow(sim, 'r1', '10.0.0.10')!.selected).toBe('candidate');
    const last = sim.trace(0).events.filter((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.fsm?.machine === 'ntp').at(-1) as Extract<TraceEvent, { kind: 'debug' }>;
    expect(last.event.fsm).toMatchObject({ from: 'synchronised', to: 'unsynchronised' });
    // the next periodic poll synchronises it again
    sim.runFor(NTP_POLL_NS + SEC);
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'ntp', stratum: 2, reference: '10.0.0.10' });
  });

  it('a malformed clock set changes nothing', () => {
    const sim = pair(54, { cabled: true, r1Lines: ['ntp master 3'] });
    sim.runFor(60 * SEC);
    const row = clockRow(sim, 'r1');
    sim.device('r1')!.applyActions('sim', [{ type: 'request', to: 'ntp', req: { kind: 'ntp.clockSet', unixMs: -5 } }], sim.now);
    expect(clockRow(sim, 'r1')).toEqual(row);
  });

  it('removing the lines: the sys-peer gone leaves a user clock; master removed likewise; the socket closes', () => {
    const sim = pair(55, { cabled: true, srvLines: ['ntp master 2'], r1Lines: ['ntp server 10.0.0.10'] });
    sim.runFor(60 * SEC);
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'ntp', stratum: 3 });
    const err = clockError(sim, 'r1');
    setLine(sim, 'r1', 'ntp server 10.0.0.10', true);
    expect(peerRow(sim, 'r1', '10.0.0.10')).toBeUndefined();
    expect(clockRow(sim, 'r1')).toMatchObject({ source: 'user', ...splitOffsetNs(err) });
    expect(clockRow(sim, 'r1')!.stratum).toBeUndefined();
    expect(sim.device('r1')!.tables.get('sockets')!.rows().filter((r) => (r as { owner?: string }).owner === 'ntp')).toEqual([]);
    setLine(sim, 'srv1', 'ntp master 2', true);
    expect(clockRow(sim, 'srv1')).toMatchObject({ source: 'user', offsetMs: 0, offsetSubMsNs: 0 });
  });
});

describe('app.ntp: silence (§4.3)', () => {
  it('without an ntp line: no socket, no row, no packet, no debug line', () => {
    const sim = pair(61, { cabled: true });
    sim.runFor(200 * SEC);
    const evs = sim.trace(0).events;
    expect(evs.filter((e) => e.kind === 'tableWrite' && (e.table === 'clock' || e.table === 'ntp-peers'))).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.process === 'ntp')).toEqual([]);
    expect(polls(sim, 'r1')).toEqual([]);
    for (const dev of ['r1', 'srv1'] as const) {
      expect(sim.device(dev)!.tables.get('sockets')!.rows().filter((r) => (r as { owner?: string }).owner === 'ntp')).toEqual([]);
      expect(ntpView(sim, dev)).toEqual({ peers: [], served: 0 });
    }
  });
});
