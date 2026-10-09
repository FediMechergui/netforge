/**
 * P3 acceptance — [S24] local logging and [S25] syslog (ARCHITECTURE-P3 §10.1 row `accept.p3.syslog`; §3.7 steps 7–8;
 * D2, D4, D19, D20, D22; §4.3, §4.4; §5.7, §5.8; §7 W4 qa, approved items S24 and S25).
 *
 * The row, clause by clause, on `staged.world` at stage P3 (rule 13). The W4 catalog flip made the two pieces of its
 * data this file laid over the staged catalog before the flip the real catalog's, so ruling R47 removed both: the
 * daemons the flip registers (`FLIP_FACTORIES`), and [S24] the two `service timestamps` lines in `profileConfig.P3` of
 * routers, managed switches and the controller (§9.2 item 36; `withTimestampsProfile`), which `defineModel` now
 * derives at stage P3 for the `cdpDefault` set (D2; `staged.world.p3-parity` compares them).
 * Lines a learner types go through the real CLI (`service ntp on`, `service syslog on` in the server's host shell; the
 * `logging …` lines, `shutdown`, `service timestamps …` on consoles).
 *
 *   §3.7 world: SRV1 (NF-SERVER) 10.0.0.10 ↔ SW1 Fa0/1; SW1 (NF-C2960) Vlan1 10.0.0.2; R1 (NF-2911) Gi0/1 10.0.0.1 ↔ SW1
 *   Gi0/1; R1 Gi0/0 10.0.2.1 ↔ PC2 (the cable that is cut; §3.7 names Gi0/2, which an NF-2911 does not have). SRV1
 *   `service ntp on`, `service syslog on`; R1 `ntp server 10.0.0.10`, then `logging host 10.0.0.10`, `logging trap
 *   warnings`.
 *
 *   • trap, console and buffer levels, each filtering on its own;
 *   • RFC 3164 bytes with PRI 187 (local7 × 8 + 3) for the cut's LINK-3 line, sent at once over UDP 514 → 514 [S25];
 *   • the server's `syslog-messages` row, with the sender's stamp and its own received stamp [S25];
 *   • stamps before the clock is synchronised carry `*`, after it they do not;
 *   • the two `service timestamps` lines coexist (identity 3) and are replayed in a P3 world only;
 *   • the [S25] extended-logging logs (link, line protocol, boot, configuration) appear in P3 worlds only;
 *   • `logging host` on a switch wakes its dormant transport (D22): protocol unreachable before, port unreachable after,
 *     and the switch's logs reach the server;
 *   • P1 and P2 typed transcripts carry no log line; a P3 console prints them.
 */
import { describe, expect, it } from 'vitest';
import { NF_WORLD_EPOCH_UNIX_MS } from '../src/contracts/clock.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { LoggerStateView, Severity } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SyslogMessageRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createStagedCatalog } from './staged.world.js';

/** [S24] The two visible P3 defaults of routers, managed switches and the controller (D2). */
const TIMESTAMPS_LINES: readonly string[] = Object.freeze(['service timestamps debug datetime msec', 'service timestamps log datetime msec']);

function stagedWorld(seed: number, profile: DefaultsProfile = 'P3'): Simulation {
  return createSimulation({ seed, profile, catalog: createStagedCatalog({ stage: 'P3' }) });
}

const SEED = 3_007_008;
const NS_PER_MS = 1_000_000n;
const MS_PER_DAY = 86_400_000;
const SYSLOG_PORT = 514;

type Log = Extract<TraceEvent, { kind: 'log' }>;
type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Write = Extract<TraceEvent, { kind: 'tableWrite' }>;

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

function typeConfig(sim: Simulation, dev: DeviceId, lines: readonly string[], session?: SessionId): void {
  const s = session ?? privileged(sim, dev);
  for (const line of ['configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${dev}: ${line}`).toBeUndefined();
  if (session === undefined) sim.cli.close(s);
}

function exec(sim: Simulation, dev: DeviceId, line: string): string {
  const s = privileged(sim, dev);
  const r = sim.cli.exec(s, line);
  expect(r.error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
  return r.output ?? '';
}

function hostShell(sim: Simulation, dev: DeviceId, line: string): string {
  const s = sim.cli.open(dev, 'console');
  const r = sim.cli.exec(s, line);
  expect(r.error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
  return r.output ?? '';
}

/** The text a session printed in `evs`. */
const printed = (evs: readonly TraceEvent[], s: SessionId): string[] =>
  evs.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s).map((e) => e.text);

// ── the §3.7 world ────────────────────────────────────────────────────────────────────────────────────────────

interface World {
  readonly sim: Simulation;
  readonly pcLink: string;
}

/** The §3.7 world; SRV1's host shell gets `service ntp on` and `service syslog on` once it has booted (10 s). */
function world(opts: { seed?: number; profile?: DefaultsProfile; ntp?: boolean } = {}): World {
  const sim = stagedWorld(opts.seed ?? SEED, opts.profile ?? 'P3');
  sim.addDevice({ id: 'srv1', type: 'server.nfserver', name: 'SRV1', startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ' ip address 10.0.0.10 255.255.255.0'], ['ip default-gateway 10.0.0.1']]) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown'], ['ip default-gateway 10.0.0.1']]) });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/1', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/0', ' ip address 10.0.2.1 255.255.255.0', ' no shutdown'],
      ...(opts.ntp === false ? [] : [['ntp server 10.0.0.10']]),
    ]),
  });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 10.0.2.10 255.255.255.0']]) });
  sim.addLink({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  const pcLink = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runUntil(10 * SEC);
  if (opts.ntp !== false) expect(hostShell(sim, 'srv1', 'service ntp on')).toBe('Time service started (stratum 1).');
  expect(hostShell(sim, 'srv1', 'service syslog on')).toBe('Syslog receiver started.');
  return { sim, pcLink };
}

const loggerView = (sim: Simulation, dev: DeviceId = 'r1'): LoggerStateView => sim.device(dev)!.processes.get('logger')!.stateSnapshot().state as unknown as LoggerStateView;
const serverRows = (sim: Simulation): SyslogMessageRow[] => sim.device('srv1')!.tables.get<SyslogMessageRow>('syslog-messages')?.rows() ?? [];
const sentSyslog = (sim: Simulation, evs: readonly TraceEvent[], dev: DeviceId): NonNullable<ReturnType<Simulation['pdu']>>[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === dev).map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('syslog') !== undefined);
const udpPayload = (p: NonNullable<ReturnType<Simulation['pdu']>>): string => {
  const udp = p.layer('udp')!;
  return new TextDecoder().decode(p.bytes.subarray(udp.offset + 8, udp.offset + udp.length));
};

/** Floor division of BigInts. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/** A device clock's error (value − true time), in ns. */
function clockError(sim: Simulation, dev: DeviceId): bigint {
  const v = sim.device(dev)!.clockView(sim.now);
  return BigInt(v.unixMs) * NS_PER_MS + BigInt(v.subMsNs) - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(sim.now));
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
/** The `datetime msec` stamp (`Mon dd hh:mm:ss.mmm`, the day space-padded) of a clock with error `err` at `at`, in UTC. */
function msecStamp(at: SimTime, err: bigint, month: 'Jan', day: number): string {
  const unixMs = Number(floorDiv(BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS + BigInt(at) + err, NS_PER_MS));
  const d = ((unixMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return `${month} ${String(day).padStart(2, ' ')} ${pad(Math.floor(d / 3_600_000), 2)}:${pad(Math.floor(d / 60_000) % 60, 2)}:${pad(Math.floor(d / 1000) % 60, 2)}.${pad(d % 1000, 3)}`;
}

// ── the row ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('[S24] the timestamps lines (D2, §5.7)', () => {
  it('both lines are replayed in a P3 world, on routers and managed switches; never in P2 or P1 worlds; never on hosts', () => {
    for (const profile of ['P3', 'P2', 'P1'] as const) {
      const sim = stagedWorld(SEED, profile);
      sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
      sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
      sim.addDevice({ id: 'srv1', type: 'server.nfserver', name: 'SRV1' });
      sim.runFor(60 * SEC);
      for (const dev of ['r1', 'sw1'] as const) {
        const text = sim.device(dev)!.running.render();
        for (const line of TIMESTAMPS_LINES) {
          if (profile === 'P3') expect(text, `${profile} ${dev}`).toContain(`\n${line}\n`);
          else expect(text, `${profile} ${dev}`).not.toContain('service timestamps');
        }
      }
      expect(sim.device('srv1')!.running.render()).not.toContain('service timestamps');
      if (profile === 'P3') expect(loggerView(sim).timestamps).toEqual({ log: 'datetime msec', debug: 'datetime msec' });
    }
  });

  it('the two lines coexist (identity 3): changing the log form keeps the debug form, and the other way round', () => {
    const sim = stagedWorld(SEED);
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    typeConfig(sim, 'r1', ['service timestamps log uptime']);
    let text = sim.device('r1')!.running.render();
    expect(text).toContain('\nservice timestamps debug datetime msec\n');
    expect(text).toContain('\nservice timestamps log uptime\n');
    expect(text).not.toContain('service timestamps log datetime');
    typeConfig(sim, 'r1', ['no service timestamps debug datetime msec']);
    text = sim.device('r1')!.running.render();
    expect(text).toContain('\nservice timestamps log uptime\n');
    expect(text).not.toContain('service timestamps debug datetime');
    expect(loggerView(sim).timestamps.log).toBe('uptime');
  });
});

describe('§3.7 steps 7–8: stamps, the wire and the server', () => {
  const { sim, pcLink } = world();
  // logs of R1's boot, before NTP synchronised its clock (R1 boots at 45 s, synchronises later)
  sim.runUntil(50 * SEC);
  const bootBuffer = loggerView(sim).entries.map((e) => e.text);
  sim.runToIdle(2_000_000);
  // the trap level first: the configuration log of this block is emitted at its first changed line, before any host exists
  typeConfig(sim, 'r1', ['logging trap warnings', 'logging host 10.0.0.10']);
  sim.runUntil(400 * SEC);
  const con = privileged(sim, 'r1');
  const cursor = sim.trace(0).next;
  const cutAt = sim.now;
  sim.removeLink(pcLink);
  sim.runFor(SEC);
  const evs = sim.trace(cursor).events;

  it('before synchronisation the stamps carry *, after it they do not', () => {
    expect(bootBuffer.length).toBeGreaterThan(0);
    expect(bootBuffer).toContain('*Jan  1 00:00:00.000: %SYS-5-BOOTED: The system has started (NF-2911).');
    for (const line of bootBuffer) expect(line).toMatch(/^\*Jan {2}1 00:00:0\d\.\d{3}: %/);
    expect(sim.device('r1')!.clockView(sim.now).authoritative).toBe(true);
    const after = loggerView(sim).entries.slice(-2).map((e) => e.text);
    for (const line of after) expect(line).toMatch(/^Jan {2}6 08:\d{2}:\d{2}\.\d{3}: %LIN(K|EPROTO)-/);
  });

  it('the cut logs LINK-3 then LINEPROTO-5 (P3 extended logging); both buffered; the console prints both', () => {
    const logs = evs.filter((e): e is Log => e.kind === 'log' && e.device === 'r1');
    expect(logs.map((l) => [l.t, l.severity, l.facility, l.mnemonic, l.message])).toEqual([
      [cutAt, 3, 'LINK', 'UPDOWN', 'Interface GigabitEthernet0/0: the link is down'],
      [cutAt, 5, 'LINEPROTO', 'UPDOWN', 'Interface GigabitEthernet0/0: line protocol is down'],
    ]);
    const stamp = msecStamp(cutAt, clockError(sim, 'r1'), 'Jan', 6);
    const lines = [
      `${stamp}: %LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is down`,
      `${stamp}: %LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is down`,
    ];
    expect(loggerView(sim).entries.slice(-2).map((e) => e.text)).toEqual(lines);
    expect(printed(evs, con)).toEqual(lines);
    const shown = exec(sim, 'r1', 'show logging').split('\n');
    expect(shown.slice(-2)).toEqual(lines);
    expect(shown).toContain('Syslog logging: level warnings (4), facility local7, 1 message sent');
    expect(shown).toContain('Timestamps: log datetime msec, debug datetime msec');
  });

  it('only severity ≤ 4 goes to the server: RFC 3164 bytes with PRI 187, 514 → 514, at once', () => {
    const sent = sentSyslog(sim, evs, 'r1');
    expect(sent).toHaveLength(1);
    const p = sent[0]!;
    const stamp = msecStamp(cutAt, clockError(sim, 'r1'), 'Jan', 6);
    const text = `<187>${stamp} R1: %LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is down`;
    expect(udpPayload(p)).toBe(text);
    const udp = p.layer('udp')!;
    expect(Array.from(p.bytes.subarray(udp.offset + 8, udp.offset + udp.length))).toEqual([...text].map((c) => c.charCodeAt(0)));
    expect([p.get('syslog.pri'), p.get('udp.srcPort'), p.get('udp.dstPort'), p.get('ipv4.src'), p.get('ipv4.dst')]).toEqual([187, SYSLOG_PORT, SYSLOG_PORT, '10.0.0.1', '10.0.0.10']);
    expect(evs.find((e) => e.kind === 'pduCreated' && e.pdu.id === p.id)!.t).toBe(cutAt);
  });

  it("the server writes a syslog-messages row with the sender's stamp and its own received stamp", () => {
    const writes = evs.filter((e): e is Write => e.kind === 'tableWrite' && e.device === 'srv1' && e.table === 'syslog-messages');
    expect(writes).toHaveLength(1);
    const at = writes[0]!.t;
    const row = writes[0]!.row as unknown as SyslogMessageRow;
    expect(row).toEqual({
      key: String(row.seq), seq: row.seq, updatedAt: at, from: '10.0.0.1', facility: 23, severity: 3, hostname: 'R1',
      stamp: msecStamp(cutAt, clockError(sim, 'r1'), 'Jan', 6),
      message: '%LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is down',
      receivedStamp: msecStamp(at, 0n, 'Jan', 6), // SRV1 keeps true time
    });
    expect(serverRows(sim).at(-1)).toEqual(row);
  });
});

describe('trap, console and buffer levels, each on its own', () => {
  it('trap warnings, console errors, buffered informational: a record of each severity goes exactly where its level allows', () => {
    const { sim } = world({ seed: SEED + 1 });
    sim.runToIdle(2_000_000);
    typeConfig(sim, 'r1', ['logging host 10.0.0.10', 'logging trap warnings', 'logging console errors', 'logging buffered 16384 informational']);
    const text = sim.device('r1')!.running.render();
    for (const l of ['logging host 10.0.0.10', 'logging trap warnings', 'logging console errors', 'logging buffered 16384 informational']) expect(text).toContain(`\n${l}\n`);
    sim.runFor(SEC); // the configuration log of those lines is delivered first
    const s = privileged(sim, 'r1');
    const before = loggerView(sim).entries.length;
    const cursor = sim.trace(0).next;
    const r1 = sim.device('r1')!;
    for (let sev = 0; sev <= 7; sev++) r1.emitLog(sev as Severity, 'TEST', `severity ${sev}`, sim.now);
    sim.runFor(SEC);
    const evs = sim.trace(cursor).events;
    const sevOf = (line: string): number => Number(/%TEST-(\d): /.exec(line)![1]);
    // the server: 0–4
    expect(sentSyslog(sim, evs, 'r1').map((p) => p.get('syslog.pri'))).toEqual([184, 185, 186, 187, 188]);
    expect(serverRows(sim).slice(-5).map((r) => r.severity)).toEqual([0, 1, 2, 3, 4]);
    // the console: 0–3
    expect(printed(evs, s).map(sevOf)).toEqual([0, 1, 2, 3]);
    // the buffer: 0–6
    const entries = loggerView(sim).entries.slice(before);
    expect(entries.map((e) => e.severity)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(exec(sim, 'r1', 'show logging').split('\n').slice(0, 2)).toEqual([
      `Buffer logging: on, level informational (6), 16384 bytes (${loggerView(sim).buffered.usedBytes} used)`,
      'Console logging: on, level errors (3)',
    ]);
    // every record is still a trace log event (one renderer, three consumers; trace bytes unchanged, D20)
    expect(evs.filter((e) => e.kind === 'log' && e.device === 'r1' && e.facility === 'TEST').length).toBe(8);
  });
});

describe('[S25] extended logging: P3 worlds only (D2)', () => {
  it('a cut and a configuration log in a P3 world; in P2 and P1 worlds only the P1 admin log exists', () => {
    const script = (profile: DefaultsProfile): Log[] => {
      const { sim, pcLink } = world({ seed: SEED + 2, profile, ntp: false });
      sim.runUntil(100 * SEC);
      const cursor = sim.trace(0).next;
      typeConfig(sim, 'r1', ['interface GigabitEthernet0/1', 'shutdown', 'no shutdown']);
      sim.runFor(5 * SEC);
      sim.removeLink(pcLink);
      sim.runFor(5 * SEC);
      return sim.trace(cursor).events.filter((e): e is Log => e.kind === 'log' && e.device === 'r1');
    };
    const extended = (l: Log): boolean => l.mnemonic !== undefined;
    const p3 = script('P3');
    expect(p3.filter(extended).map((l) => `${l.facility}-${l.severity}-${l.mnemonic}`)).toEqual(
      expect.arrayContaining(['LINK-3-UPDOWN', 'LINEPROTO-5-UPDOWN', 'SYS-5-CONFIGURED']),
    );
    for (const profile of ['P2', 'P1'] as const) {
      const old = script(profile);
      expect(old.filter(extended), profile).toEqual([]);
      expect(old.map((l) => l.message), profile).toEqual(['Interface GigabitEthernet0/1 administratively down', 'Interface GigabitEthernet0/1 administratively enabled']);
      // the logs every profile had are the P3 world's, minus the extended ones (same text, same severity, D4)
      expect(old.map((l) => [l.severity, l.facility, l.message])).toEqual(p3.filter((l) => !extended(l)).map((l) => [l.severity, l.facility, l.message]));
    }
  });
});

describe('D22: logging host wakes a switch transport', () => {
  it('protocol unreachable before the line; port unreachable after it, and the switch logs reach the server', () => {
    const { sim } = world({ seed: SEED + 3, ntp: false });
    sim.runUntil(100 * SEC);
    const srv1 = sim.device('srv1')!;
    srv1.applyActions('syslog-server', [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: 'syslog-server', socket: 'probe#1', family: 4 } }], sim.now);
    /** A datagram from SRV1 to SW1's UDP port 9 (nothing listens there); the ICMP code SW1 answers with. */
    const probe = (): number | undefined => {
      const cursor = sim.trace(0).next;
      srv1.applyActions('syslog-server', [{ type: 'request', to: 'udp', req: { kind: 'udp.send', socket: 'probe#1', dst: '10.0.0.2', dstPort: 9, data: new Uint8Array([1, 2, 3]) } }], sim.now);
      sim.runFor(SEC);
      const icmp = sim.trace(cursor).events.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'sw1' && e.process === 'icmpv4');
      expect(icmp).toHaveLength(1);
      const p = sim.pdu(icmp[0]!.pdu.id)!;
      expect(p.get('icmpv4.type')).toBe(3);
      return p.get('icmpv4.code') as number;
    };
    expect(probe()).toBe(2); // dormant: protocol unreachable, as in P2
    typeConfig(sim, 'sw1', ['logging host 10.0.0.10']);
    expect(probe()).toBe(3); // awake: port unreachable
    const cursor = sim.trace(0).next;
    typeConfig(sim, 'sw1', ['interface FastEthernet0/5', 'shutdown']);
    sim.runFor(SEC);
    const rows = sim.trace(cursor).events.filter((e): e is Write => e.kind === 'tableWrite' && e.device === 'srv1' && e.table === 'syslog-messages').map((e) => e.row as unknown as SyslogMessageRow);
    expect(rows.map((r) => [r.from, r.hostname, r.severity, r.message])).toEqual(
      expect.arrayContaining([['10.0.0.2', 'SW1', 3, '%LINK-3: Interface FastEthernet0/5 administratively down']]),
    );
    // the last such line removed: dormant again
    typeConfig(sim, 'sw1', ['no logging host 10.0.0.10']);
    expect(probe()).toBe(2);
  });
});

describe('P1/P2 typed transcripts carry no log lines', () => {
  it('a console session in P1 and P2 worlds prints no log for a shutdown and a cut; a P3 console prints them', () => {
    const transcript = (profile: DefaultsProfile): { text: string[]; logs: number } => {
      const { sim, pcLink } = world({ seed: SEED + 4, profile, ntp: false });
      sim.runUntil(100 * SEC);
      const s = privileged(sim, 'r1');
      const cursor = sim.trace(0).next;
      typeConfig(sim, 'r1', ['interface GigabitEthernet0/1', 'shutdown', 'no shutdown'], s);
      sim.runFor(5 * SEC);
      sim.removeLink(pcLink);
      sim.runFor(5 * SEC);
      const evs = sim.trace(cursor).events;
      return { text: printed(evs, s), logs: evs.filter((e) => e.kind === 'log' && e.device === 'r1').length };
    };
    for (const profile of ['P1', 'P2'] as const) {
      const t = transcript(profile);
      expect(t.logs, profile).toBeGreaterThan(0);
      expect(t.text.filter((line) => line.includes('%')), profile).toEqual([]);
    }
    const p3 = transcript('P3');
    const logLines = p3.text.filter((line) => /: %[A-Z]+-\d/.test(line));
    expect(logLines.length).toBe(p3.logs);
    expect(logLines.some((l) => l.includes('%LINK-3: Interface GigabitEthernet0/1 administratively down'))).toBe(true);
    expect(logLines.some((l) => l.includes('%LINK-3-UPDOWN: Interface GigabitEthernet0/0: the link is down'))).toBe(true);
  });
});

describe('determinism', () => {
  it('three runs with one seed give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const { sim, pcLink } = world({ seed: SEED + 5 });
      sim.runToIdle(2_000_000);
      typeConfig(sim, 'r1', ['logging trap warnings', 'logging host 10.0.0.10', 'logging buffered 8192 notifications']);
      sim.runFor(10 * SEC);
      sim.removeLink(pcLink);
      sim.runFor(10 * SEC);
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(a).toContain('%LINK-3-UPDOWN');
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
