/**
 * app.syslog — [S25] syslog (ARCHITECTURE-P3 D20, §2.6 `syslog-messages`, §3.7 step 8, §4.3, §5.7; §7 W3 svc) and
 * the rulings R24 (`udp.send` gains `dscp?`) and R25 (the `LoggerStateView` contract and the console default), on
 * `staged.world` at stage P3 with the logger, syslog-server and ntp (for `clock set`) factories (rule 13). The
 * configuration is stored through `startupConfig` or `DeviceRuntime.applyConfigLine`.
 *
 *  • a server receives exactly the messages at or below the trap level's severity number, in RFC 3164 bytes, with the
 *    device's own timestamps (the stamp of the buffered line) and its own received stamp;
 *  • §3.7 step 8: a cable cut in a P3 world under `logging trap warnings` — the LINK line reaches the server, the
 *    LINEPROTO line does not;
 *  • defaults (trap informational, facility local7), `logging facility`, the `logging <a>` alias, two hosts,
 *    `logging source-interface`; a managed switch's `logging host` wakes its dormant transport (D22);
 *  • silence: no socket and no syslog packet without a logging host, no receiver socket without `syslog-server
 *    enable`; the 500-row bound; a message without a priority;
 *  • R24: `dscp` on a udp.send reaches the IPv4 header (and IPv6's traffic class); absent = 0; out of range refused;
 *  • R25: the logger's console default equals `cli/log-render.ts` `consoleLogLevel` in P3 and P2 worlds.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigNode } from '../src/contracts/config.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LoggerStateView, Severity } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SyslogMessageRow } from '../src/contracts/tables.js';
import { formatSimTime, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { consoleLogLevel } from '../src/cli/log-render.js';
import {
  createLogger,
  formatLogTimestamp,
  LOGGER_SYSLOG_SOCKET,
  loggingConfigOf,
  syslogConfigOf,
  syslogFacilityOf,
  syslogFields,
  syslogHostname,
} from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import {
  createSyslogServer,
  receivedSyslogOf,
  SYSLOG_MESSAGES_LIMIT,
  SYSLOG_RECEIVED_FORMAT,
  SYSLOG_SERVER_SOCKET,
  syslogServerEnabled,
} from '../src/protocols/syslog-server.js';
import { createStagedSimulation } from './staged.world.js';

const FACTORIES = { logger: createLogger, 'syslog-server': createSyslogServer, ntp: createNtp };
/** Mon 2025-01-06 08:10:03.123 UTC (§3.7). */
const JAN6 = 1_736_151_003_123;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface WorldOpts {
  readonly r1Lines?: readonly string[];
  readonly r1Sections?: readonly (readonly string[])[];
  readonly srvLines?: readonly string[];
  readonly profile?: 'P2' | 'P3';
}

/**
 * R1 (NF-2911) Gi0/0 10.0.0.1 — SRV1 (NF-SERVER) 10.0.0.10; R1 Gi0/1 10.0.1.1 — PC1 10.0.1.10. Booted and settled at
 * 100 s. Returns the world and the PC link's id (the cable a test may cut).
 */
function world(seed: number, opts: WorldOpts = {}): { sim: Simulation; pcLink: string } {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: FACTORIES, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
  sim.addDevice({
    id: 'srv1', type: 'server.nfserver', name: 'SRV1',
    startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['ip default-gateway 10.0.0.1'], ...(opts.srvLines ?? []).map((l) => [l])]),
  });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' ip address 10.0.1.1 255.255.255.0', ' no shutdown'],
      ...(opts.r1Sections ?? []),
      ...(opts.r1Lines ?? []).map((l) => [l]),
    ]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.1.10 255.255.255.0']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'srv1', port: 'GigabitEthernet0' } });
  const pcLink = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
  sim.runUntil(100 * SEC);
  return { sim, pcLink };
}

function setLine(sim: Simulation, dev: DeviceId, text: string, negate = false, context: string[][] = []): void {
  const d = sim.device(dev)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, text.split(' '), negate)).toEqual({ ok: true });
}

const loggerView = (sim: Simulation, dev: DeviceId = 'r1'): LoggerStateView => sim.device(dev)!.processes.get('logger')!.stateSnapshot().state as unknown as LoggerStateView;
const rows = (sim: Simulation, dev: DeviceId = 'srv1'): SyslogMessageRow[] => sim.device(dev)!.tables.get<SyslogMessageRow>('syslog-messages')?.rows() ?? [];
const udpSockets = (sim: Simulation, dev: DeviceId): string[] =>
  (sim.device(dev)!.processes.get('udp')!.stateSnapshot().state.sockets as { id: string }[]).map((s) => s.id);

/** The PDUs `dev` built since `cursor` whose tag is `tag`. */
function built(sim: Simulation, dev: DeviceId, cursor: number, tag: string): NonNullable<ReturnType<Simulation['pdu']>>[] {
  return sim
    .trace(cursor)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === dev && sim.pdu(e.pdu.id)?.meta.tag === tag)
    .map((e) => sim.pdu(e.pdu.id)!);
}

/** The UDP payload of a PDU as text. */
function udpText(p: NonNullable<ReturnType<Simulation['pdu']>>): string {
  const udp = p.layer('udp')!;
  return new TextDecoder().decode(p.bytes.subarray(udp.offset + 8, udp.offset + udp.length));
}

/** The syslog-messages rows SRV1 wrote since `cursor`, with the instant of each write. */
function rowsSince(sim: Simulation, cursor: number, dev: DeviceId = 'srv1'): { t: number; row: SyslogMessageRow }[] {
  return sim
    .trace(cursor)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.device === dev && e.table === 'syslog-messages')
    .map((e) => ({ t: e.t, row: e.row as unknown as SyslogMessageRow }));
}

describe('app.syslog: the sender and the receiver (§3.7 step 8)', () => {
  it('a server receives exactly the messages at or above the trap level, in RFC 3164 bytes, with the device timestamps', () => {
    const { sim } = world(1, {
      r1Lines: ['service timestamps log datetime msec', 'logging host 10.0.0.10', 'logging trap warnings'],
      srvLines: ['syslog-server enable'],
    });
    const r1 = sim.device('r1')!;
    expect(udpSockets(sim, 'r1')).toContain(LOGGER_SYSLOG_SOCKET);
    expect(udpSockets(sim, 'srv1')).toContain(SYSLOG_SERVER_SOCKET);
    // clock set (through ntp) to 08:10:03.123 UTC on Mon 2025-01-06
    r1.applyActions('sim', [{ type: 'request', to: 'ntp', req: { kind: 'ntp.clockSet', unixMs: JAN6 } }], sim.now);
    const cursor = sim.trace(0).next;
    const sentBefore = loggerView(sim).syslog!.sent;
    const t = sim.now;
    r1.emitLog(3, 'LINK', 'Interface GigabitEthernet0/2 changed state to down', t, 'UPDOWN');
    r1.emitLog(5, 'LINEPROTO', 'Line protocol on Interface GigabitEthernet0/2 changed state to down', t, 'UPDOWN');
    r1.emitLog(4, 'SYS', 'a warning', t);
    r1.emitLog(7, 'SYS', 'a debugging detail', t);
    r1.emitLog(0, 'SYS', 'an emergency', t);
    sim.runFor(1 * SEC);

    // the wire: one datagram per record at or below severity 4, at once, 514 → 514, PRI = local7 × 8 + severity
    const sent = built(sim, 'r1', cursor, 'syslog');
    expect(sent.map((p) => p.get('syslog.pri'))).toEqual([187, 188, 184]);
    expect(sent.map((p) => [p.get('udp.srcPort'), p.get('udp.dstPort'), p.get('ipv4.dst'), p.get('ipv4.dscp')])).toEqual([
      [514, 514, '10.0.0.10', 0],
      [514, 514, '10.0.0.10', 0],
      [514, 514, '10.0.0.10', 0],
    ]);
    expect(udpText(sent[0]!)).toBe('<187>Jan  6 08:10:03.123 R1: %LINK-3-UPDOWN: Interface GigabitEthernet0/2 changed state to down');
    expect(sent.every((p) => sim.trace(cursor).events.some((e) => e.kind === 'pduCreated' && e.pdu.id === p.id && e.t === t))).toBe(true);

    // the server: one row each, the sender's stamp and the server's own received stamp
    const got = rowsSince(sim, cursor);
    expect(got.map(({ row }) => [row.from, row.facility, row.severity, row.hostname, row.stamp, row.message])).toEqual([
      ['10.0.0.1', 23, 3, 'R1', 'Jan  6 08:10:03.123', '%LINK-3-UPDOWN: Interface GigabitEthernet0/2 changed state to down'],
      ['10.0.0.1', 23, 4, 'R1', 'Jan  6 08:10:03.123', '%SYS-4: a warning'],
      ['10.0.0.1', 23, 0, 'R1', 'Jan  6 08:10:03.123', '%SYS-0: an emergency'],
    ]);
    const srv1 = sim.device('srv1')!;
    for (const { t: at, row } of got) {
      expect(row.key).toBe(String(row.seq));
      expect(row.receivedStamp).toBe(formatLogTimestamp(at, srv1.clockView(at), SYSLOG_RECEIVED_FORMAT));
      expect(row.receivedStamp).toMatch(/^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\.\d{3}$/); // a true-time clock: no '*'
    }
    // the device's timestamps: each message's stamp and text are the buffered line, byte for byte (one renderer)
    const buffered = loggerView(sim).entries.slice(-5).map((e) => e.text);
    for (const { row } of got) expect(buffered).toContain(`${row.stamp}: ${row.message}`);
    expect(loggerView(sim).syslog).toEqual({ trap: 4, facility: 23, hosts: [{ address: '10.0.0.10', sent: sentBefore + 3 }], sent: sentBefore + 3 });
  });

  it('§3.7 step 8: a cable cut in a P3 world under `logging trap warnings` sends the LINK line, not the LINEPROTO line', () => {
    const { sim, pcLink } = world(2, {
      r1Lines: ['service timestamps log datetime msec', 'logging host 10.0.0.10', 'logging trap warnings'],
      srvLines: ['syslog-server enable'],
    });
    sim.device('r1')!.applyActions('sim', [{ type: 'request', to: 'ntp', req: { kind: 'ntp.clockSet', unixMs: JAN6 } }], sim.now);
    sim.runUntil(400 * SEC);
    const cursor = sim.trace(0).next;
    sim.removeLink(pcLink);
    sim.runFor(1 * SEC);
    const logs = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'log' }> => e.kind === 'log' && e.device === 'r1');
    expect(logs.map((e) => [e.severity, e.facility, e.mnemonic])).toEqual([
      [3, 'LINK', 'UPDOWN'],
      [5, 'LINEPROTO', 'UPDOWN'],
    ]);
    const got = rowsSince(sim, cursor).map(({ row }) => row);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 3, facility: 23, hostname: 'R1', from: '10.0.0.1' });
    expect(got[0]!.message).toMatch(/^%LINK-3-UPDOWN: /);
    expect(got[0]!.stamp).toMatch(/^Jan {2}6 08:\d{2}:\d{2}\.\d{3}$/);
    // both lines are buffered; the console prints them (the CLI's), the server sees only the warning-or-worse one
    expect(loggerView(sim).entries.slice(-2).map((e) => e.facility)).toEqual(['LINK', 'LINEPROTO']);
  });

  it('defaults (informational, local7), `logging facility`, the alias, two hosts, `logging source-interface`; no timestamps line', () => {
    const { sim } = world(3, {
      r1Sections: [['interface Loopback0', ' ip address 1.1.1.1 255.255.255.255']],
      srvLines: ['syslog-server enable'],
    });
    const r1 = sim.device('r1')!;
    expect(udpSockets(sim, 'r1')).not.toContain(LOGGER_SYSLOG_SOCKET);
    setLine(sim, 'r1', 'logging 10.0.0.10');
    expect(udpSockets(sim, 'r1')).toContain(LOGGER_SYSLOG_SOCKET);
    expect(loggerView(sim).syslog).toMatchObject({ trap: 6, facility: 23, hosts: [{ address: '10.0.0.10' }] });
    sim.runFor(1 * SEC); // the configuration log of that line (severity 5, P3 world) is delivered first
    let cursor = sim.trace(0).next;
    let t = sim.now;
    r1.emitLog(6, 'SYS', 'informational line', t);
    r1.emitLog(7, 'SYS', 'debugging line', t);
    sim.runFor(1 * SEC);
    // informational (the default trap) goes out, debugging does not; without the timestamps line the stamp is P1's
    expect(rowsSince(sim, cursor).map(({ row }) => [row.severity, row.facility, row.stamp, row.message])).toEqual([
      [6, 23, `*${formatSimTime(t)}`, '%SYS-6: informational line'],
    ]);
    // facility local3, a second host, the loopback as source
    setLine(sim, 'r1', 'logging facility local3');
    setLine(sim, 'r1', 'logging host 10.0.0.20');
    setLine(sim, 'r1', 'logging source-interface Loopback0');
    sim.runFor(5 * SEC);
    cursor = sim.trace(0).next;
    t = sim.now;
    r1.emitLog(2, 'SYS', 'critical line', t);
    sim.runFor(5 * SEC);
    const sent = built(sim, 'r1', cursor, 'syslog');
    expect(sent.map((p) => [p.get('ipv4.src'), p.get('ipv4.dst'), p.get('syslog.pri')]).sort()).toEqual([
      ['1.1.1.1', '10.0.0.10', 19 * 8 + 2],
      ['1.1.1.1', '10.0.0.20', 19 * 8 + 2],
    ]);
    expect(rowsSince(sim, cursor).map(({ row }) => [row.from, row.facility, row.severity, row.message])).toEqual([['1.1.1.1', 19, 2, '%SYS-2: critical line']]);
    const v = loggerView(sim).syslog!;
    expect([v.trap, v.facility, v.hosts.map((h) => h.address).sort()]).toEqual([6, 19, ['10.0.0.10', '10.0.0.20']]);
    expect(v.hosts.find((h) => h.address === '10.0.0.20')!.sent).toBe(1);
    expect(v.sent).toBe(v.hosts.reduce((n, h) => n + h.sent, 0));
  });

  it("a managed switch's `logging host` wakes its dormant transport (D22): the switch's logs reach the server", () => {
    const sim = createStagedSimulation({ seed: 4, stage: 'P3', factories: FACTORIES });
    sim.addDevice({
      id: 'srv1', type: 'server.nfserver', name: 'SRV1',
      startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['syslog-server enable']]),
    });
    sim.addDevice({
      id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
      startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown'], ['logging host 10.0.0.10']]),
    });
    sim.addLink({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.runUntil(100 * SEC);
    const cursor = sim.trace(0).next;
    sim.device('sw1')!.emitLog(4, 'SYS', 'switch warning', sim.now);
    sim.runFor(2 * SEC);
    expect(rowsSince(sim, cursor).map(({ row }) => [row.from, row.hostname, row.severity, row.message])).toEqual([['10.0.0.2', 'SW1', 4, '%SYS-4: switch warning']]);
  });
});

describe('app.syslog: silence and bounds', () => {
  it('no logging host: no socket, no syslog packet, no `syslog` view; removing the last host closes the socket', () => {
    const { sim } = world(5, { srvLines: ['syslog-server enable'] });
    const r1 = sim.device('r1')!;
    const cursor = sim.trace(0).next;
    for (let s = 0; s < 8; s++) r1.emitLog(s as Severity, 'SYS', `severity ${s}`, sim.now);
    sim.runFor(2 * SEC);
    expect(built(sim, 'r1', 0, 'syslog')).toEqual([]);
    expect(sim.trace(0).events.some((e) => e.kind === 'pduCreated' && sim.pdu(e.pdu.id)?.layer('syslog') !== undefined)).toBe(false);
    expect(udpSockets(sim, 'r1')).not.toContain(LOGGER_SYSLOG_SOCKET);
    expect('syslog' in loggerView(sim)).toBe(false);
    expect(rows(sim)).toEqual([]);
    expect(sim.trace(cursor).events.filter((e) => e.kind === 'log').length).toBe(8);
    // a host, then its removal: the socket closes and nothing more is sent
    setLine(sim, 'r1', 'logging host 10.0.0.10');
    expect(udpSockets(sim, 'r1')).toContain(LOGGER_SYSLOG_SOCKET);
    setLine(sim, 'r1', 'logging host 10.0.0.10', true);
    expect(udpSockets(sim, 'r1')).not.toContain(LOGGER_SYSLOG_SOCKET);
    expect('syslog' in loggerView(sim)).toBe(false);
    const c2 = sim.trace(0).next;
    r1.emitLog(0, 'SYS', 'after removal', sim.now);
    sim.runFor(1 * SEC);
    expect(built(sim, 'r1', c2, 'syslog')).toEqual([]);
  });

  it('a server without `syslog-server enable` opens no socket: the datagram meets a closed port, no row', () => {
    const { sim } = world(6, { r1Lines: ['logging host 10.0.0.10'] });
    expect(udpSockets(sim, 'srv1')).not.toContain(SYSLOG_SERVER_SOCKET);
    expect(sim.device('srv1')!.processes.get('syslog-server')!.stateSnapshot().state).toEqual({ listening: false, received: 0, malformed: 0 });
    const cursor = sim.trace(0).next;
    sim.device('r1')!.emitLog(3, 'SYS', 'nobody listens', sim.now);
    sim.runFor(2 * SEC);
    expect(built(sim, 'r1', cursor, 'syslog')).toHaveLength(1);
    const drops = sim.trace(cursor).events.filter((e) => e.kind === 'drop' && e.device === 'srv1');
    expect(drops.map((e) => (e as Extract<TraceEvent, { kind: 'drop' }>).detail)).toEqual(['udp port 514 closed']);
    expect(rows(sim)).toEqual([]);
    // `service syslog on` stores the line: the receiver opens its socket and the next message is kept
    setLine(sim, 'srv1', 'syslog-server enable');
    expect(udpSockets(sim, 'srv1')).toContain(SYSLOG_SERVER_SOCKET);
    sim.device('r1')!.emitLog(3, 'SYS', 'now it listens', sim.now);
    sim.runFor(2 * SEC);
    expect(rows(sim).map((r) => r.message)).toEqual(['%SYS-3: now it listens']);
    setLine(sim, 'srv1', 'syslog-server enable', true);
    expect(udpSockets(sim, 'srv1')).not.toContain(SYSLOG_SERVER_SOCKET);
  });

  it('the table keeps the newest 500 rows; a message without a priority is kept as user.notifications', () => {
    const { sim } = world(7, { r1Lines: ['logging host 10.0.0.10', 'logging trap debugging'], srvLines: ['syslog-server enable'] });
    const r1 = sim.device('r1')!;
    const before = rows(sim).length;
    const cursor = sim.trace(0).next;
    for (let i = 0; i < SYSLOG_MESSAGES_LIMIT + 5; i++) {
      r1.emitLog(7, 'TEST', `line ${i}`, sim.now);
      sim.runFor(SEC / 100); // one message per 10 ms: no transmit queue in the way
    }
    sim.runFor(1 * SEC);
    const all = rows(sim);
    expect(all).toHaveLength(SYSLOG_MESSAGES_LIMIT);
    expect(all.at(-1)!.message).toBe(`%TEST-7: line ${SYSLOG_MESSAGES_LIMIT + 4}`);
    expect(all[0]!.seq).toBe(before + 5 + 1);
    const expired = sim.trace(cursor).events.filter((e) => e.kind === 'tableExpire' && e.device === 'srv1' && e.table === 'syslog-messages');
    expect(expired).toHaveLength(before + 5);
    expect(expired.every((e) => (e as Extract<TraceEvent, { kind: 'tableExpire' }>).reason === 'replaced')).toBe(true);
    // a raw datagram to 514 without a <priority>: RFC 3164 §4.3.3's default 13 (user, notifications)
    r1.applyActions('logger', [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: 'logger', socket: 'raw#1', family: 4 } }], sim.now);
    r1.applyActions('logger', [{ type: 'request', to: 'udp', req: { kind: 'udp.send', socket: 'raw#1', dst: '10.0.0.10', dstPort: 514, data: new TextEncoder().encode('hello there') } }], sim.now);
    sim.runFor(1 * SEC);
    expect(rows(sim).at(-1)).toMatchObject({ facility: 1, severity: 5, stamp: '', message: 'hello there' });
    expect(rows(sim).at(-1)!.hostname).toBeUndefined();
    expect(sim.device('srv1')!.processes.get('syslog-server')!.stateSnapshot().state).toMatchObject({ listening: true, malformed: 1 });
  });

  it('pure helpers: the syslog lines, facility names, the header fields, the received message', () => {
    const root = (lines: readonly (readonly string[])[]): ConfigNode => ({ key: '', args: [], children: lines.map(([key, ...args]) => ({ key: key!, args, children: [] })) });
    expect(syslogConfigOf(root([]))).toEqual({ hosts: [], trap: 6, facility: 23 });
    expect(
      syslogConfigOf(
        root([
          ['logging', 'host', '10.0.0.10'],
          ['logging', '10.0.0.20'],
          ['logging', 'host', '10.0.0.10'],
          ['logging', 'trap', 'warnings'],
          ['logging', 'facility', 'local0'],
          ['logging', 'source-interface', 'Loopback0'],
          ['logging', 'buffered', '8192'],
        ]),
      ),
    ).toEqual({ hosts: ['10.0.0.10', '10.0.0.20'], trap: 4, facility: 16, sourceInterface: 'Loopback0' });
    expect([syslogFacilityOf('local7'), syslogFacilityOf('LOCAL2'), syslogFacilityOf('local8'), syslogFacilityOf(undefined)]).toEqual([23, 18, undefined, undefined]);
    expect([syslogHostname('R1'), syslogHostname('my router'), syslogHostname('%a:b')]).toEqual(['R1', 'my-router', 'a-b']);
    expect(syslogFields({ severity: 3, facility: 'LINK', message: 'm', mnemonic: 'UPDOWN' }, 23, 'Jan  6 08:10:03.123', 'R1')).toEqual({
      pri: 187, timestamp: 'Jan  6 08:10:03.123', hostname: 'R1', message: '%LINK-3-UPDOWN: m',
    });
    expect(syslogFields({ severity: 5, facility: 'SYS', message: 'm' }, 16, 'stamp', '%')).toEqual({ pri: 133, timestamp: '', hostname: '', message: '%SYS-5: m' });
    expect(receivedSyslogOf({ pri: 187, facility: 23, severity: 3, timestamp: 'T', hostname: 'R1', message: 'x' }, '')).toEqual({ facility: 23, severity: 3, hostname: 'R1', stamp: 'T', message: 'x', malformed: false });
    expect(receivedSyslogOf({ message: 'raw' }, 'raw')).toEqual({ facility: 1, severity: 5, stamp: '', message: 'raw', malformed: true });
    expect([syslogServerEnabled(root([['syslog-server', 'enable']])), syslogServerEnabled(root([]))]).toEqual([true, false]);
  });
});

describe('app.syslog: R24 — dscp on udp.send', () => {
  it('reaches the IPv4 header; absent is 0 (no field written); out of range is refused; IPv6 traffic class', () => {
    const { sim } = world(8, { r1Sections: [['interface GigabitEthernet0/0', ' ipv6 address 2001:db8::1/64']] });
    const r1 = sim.device('r1')!;
    const open = (socket: string, family: 4 | 6): void =>
      r1.applyActions('logger', [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: 'logger', socket, family } }], sim.now);
    const send = (socket: string, dst: string, tag: string, dscp?: number): void =>
      r1.applyActions('logger', [{ type: 'request', to: 'udp', req: { kind: 'udp.send', socket, dst, dstPort: 9, tag, data: new Uint8Array([1, 2, 3]), ...(dscp !== undefined ? { dscp } : {}) } }], sim.now);
    open('m#4', 4);
    open('m#6', 6);
    const cursor = sim.trace(0).next;
    send('m#4', '10.0.0.10', 'marked', 46);
    send('m#4', '10.0.0.10', 'unmarked');
    send('m#4', '10.0.0.10', 'zero', 0);
    send('m#4', '10.0.0.10', 'bad', 64);
    send('m#4', '10.0.0.10', 'bad', 2.5);
    send('m#6', '2001:db8::10', 'marked6', 46);
    sim.runFor(1 * SEC);
    const [marked] = built(sim, 'r1', cursor, 'marked');
    const [unmarked] = built(sim, 'r1', cursor, 'unmarked');
    const [zero] = built(sim, 'r1', cursor, 'zero');
    expect(marked!.get('ipv4.dscp')).toBe(46);
    const tos = (p: NonNullable<ReturnType<Simulation['pdu']>>): number => p.bytes[p.layer('ipv4')!.offset + 1]!;
    expect(tos(marked!)).toBe(46 << 2);
    expect([unmarked!.get('ipv4.dscp'), tos(unmarked!), zero!.get('ipv4.dscp'), tos(zero!)]).toEqual([0, 0, 0, 0]);
    expect(built(sim, 'r1', cursor, 'bad')).toEqual([]);
    const udpDebug = sim.trace(cursor).events.filter((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.process === 'udp').map((e) => (e as Extract<TraceEvent, { kind: 'debug' }>).event.message);
    expect(udpDebug).toContain('socket m#4: bad-socket (DSCP 64 is outside 0-63)');
    expect(udpDebug).toContain('socket m#4: bad-socket (DSCP 2.5 is outside 0-63)');
    const [marked6] = built(sim, 'r1', cursor, 'marked6');
    expect(marked6!.get('ipv6.trafficClass')).toBe(46 << 2);
  });
});

describe('app.syslog: R25 — the console default equals log-render', () => {
  const root = (lines: readonly (readonly string[])[]): ConfigNode => ({ key: '', args: [], children: lines.map(([key, ...args]) => ({ key: key!, args, children: [] })) });
  const asLevel = (o: { enabled: boolean; level: number }): number => (o.enabled ? o.level : -1);

  it('pure: the same answer for every console line, in P3 and P1/P2 worlds', () => {
    const roots = [root([]), root([['logging', 'console']]), root([['logging', 'console', 'warnings']]), root([['no', 'logging', 'console']])];
    for (const p3 of [true, false]) {
      for (const r of roots) expect(asLevel(loggingConfigOf(r, p3).console)).toBe(consoleLogLevel(r, p3));
    }
    expect(loggingConfigOf(root([]), false).console).toEqual({ enabled: false, level: 7 });
    expect(loggingConfigOf(root([])).console).toEqual({ enabled: true, level: 7 });
  });

  it('on real devices: the StateView console matches consoleLogLevel in a P3 world and a P2-profile world', () => {
    for (const profile of ['P3', 'P2'] as const) {
      const { sim } = world(9, { profile });
      const r1 = sim.device('r1')!;
      const p3 = profile === 'P3';
      const check = (): void => expect(asLevel(loggerView(sim).console)).toBe(consoleLogLevel(r1.running.root, p3));
      expect(loggerView(sim).console).toEqual({ enabled: p3, level: 7 });
      check();
      setLine(sim, 'r1', 'logging console errors');
      check();
      setLine(sim, 'r1', 'logging console', true);
      check();
      expect(loggerView(sim).console.enabled).toBe(false);
    }
  });
});
