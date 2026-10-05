// The `mgmt` and `wan` lanes' timeline wiring (ARCHITECTURE-P3 §2.12, §3.6 step 4, §3.7, §7 W4 "web-shell"): the
// events the engine classifies into lane 12 (`mgmt`: the cdp-neighbours, lldp-neighbours, ntp-peers, clock and
// syslog-messages rows and the `ntp` machine) and lane 13 (`wan`: the tunnels, ppp and ipsec-sa rows and the tunnel,
// ppp-* and ike machines) reach the worker's lane index, the strip's rows (last, in canonical order) and its event list
// as sentences. In those two lanes a refresh that moves only a row's volatile keys (CDP every 60 s, LLDP every 30 s) is
// not a mark, so the lane shows discoveries, ageings, clock changes and logs; the P1/P2 lanes index as before.
import { describe, expect, it } from 'vitest';
import { LANE_IDS, LANE_INDEX, VOLATILE_ROW_KEYS, laneOf } from '@netforge/engine';
import type { FsmMachine, TableName, TraceEvent } from '@netforge/engine';
import { REFRESH_FILTERED_LANES, createLaneIndex, isRefreshOnly } from '../src/bridge/worker/lanes';
import { DEFAULT_TIMELINE_LANES } from '../src/store/store';
import { lanesFilter } from '../src/timeline/TimelineStrip';
import { laneRows, markText, p3RowText, type TimelineMark } from '../src/timeline/timeline-client';
import { LANE_ORDER, LANE_VOCAB } from '../src/vocab/lanes';

const SEC = 1_000_000_000;

type Row = Record<string, unknown>;

function write(t: number, table: TableName, key: string, row: Row, previous?: Row): TraceEvent {
  return { t, kind: 'tableWrite', device: 'r1', table, key, row: { key, updatedAt: t, ...row }, ...(previous === undefined ? {} : { previous: { key, ...previous } }) } as TraceEvent;
}

function expire(t: number, table: TableName, key: string, row: Row, reason: string): TraceEvent {
  return { t, kind: 'tableExpire', device: 'r1', table, key, row: { key, updatedAt: t, ...row }, reason } as TraceEvent;
}

function fsm(t: number, machine: FsmMachine, subject: string, from: string, to: string): TraceEvent {
  return { t, kind: 'debug', event: { at: t, device: 'r1', process: machine, category: `${machine} events`, message: `${subject} ${from} -> ${to}`, fsm: { machine, subject, from, to } } } as TraceEvent;
}

const CDP_ROW: Row = {
  localPort: 'GigabitEthernet0/1',
  deviceId: 'R2',
  remotePort: 'GigabitEthernet0/0',
  platform: 'NF-2911',
  capabilities: 'R',
  addresses: '10.0.12.2',
  version: 'NF-OS',
  holdtimeS: 180,
  cdpVersion: 2,
  expiresAt: 181 * SEC,
};

/** The first CDP row, then a refresh 60 s later that moves only `expiresAt` and `updatedAt` (§3.6 step 4). */
function cdpFoundThenRefreshed(): [TraceEvent, TraceEvent] {
  const key = 'GigabitEthernet0/1|R2';
  const found = write(1 * SEC, 'cdp-neighbours', key, CDP_ROW);
  const refresh = write(61 * SEC, 'cdp-neighbours', key, { ...CDP_ROW, expiresAt: 241 * SEC }, { ...CDP_ROW, updatedAt: 1 * SEC });
  return [found, refresh];
}

describe('the engine puts the P3 events in lanes 12 and 13', () => {
  it('mgmt is lane 12 and wan lane 13, after the twelve P2 lanes, everywhere the web lists lanes', () => {
    expect([LANE_INDEX.mgmt, LANE_INDEX.wan]).toEqual([12, 13]);
    expect(LANE_IDS.slice(-2)).toEqual(['mgmt', 'wan']);
    expect(LANE_ORDER).toEqual([...LANE_IDS]);
    expect(DEFAULT_TIMELINE_LANES).toEqual([...LANE_IDS]);
    // a fresh strip asks for every lane (no filter), the two P3 lanes included
    expect(lanesFilter(DEFAULT_TIMELINE_LANES)).toBeUndefined();
    expect(lanesFilter(DEFAULT_TIMELINE_LANES.filter((l) => l !== 'wan'))).not.toContain('wan');
    expect(REFRESH_FILTERED_LANES).toEqual(['mgmt', 'wan']);
  });

  it('classifies the management and WAN rows and machines', () => {
    const mgmt = [
      write(1, 'cdp-neighbours', 'k', {}),
      write(1, 'lldp-neighbours', 'k', {}),
      write(1, 'ntp-peers', 'k', {}),
      write(1, 'clock', 'clock', {}),
      write(1, 'syslog-messages', '1', {}),
      expire(1, 'cdp-neighbours', 'k', {}, 'aged'),
      fsm(1, 'ntp', '10.0.0.10', 'unsynchronised', 'synchronised'),
    ];
    for (const ev of mgmt) expect(laneOf(ev)).toBe('mgmt');
    const wan = [
      write(1, 'tunnels', 'Tunnel0', {}),
      write(1, 'ppp', 'Serial0/0/0', {}),
      write(1, 'ipsec-sa', 'Tunnel0', {}),
      fsm(1, 'tunnel', 'Tunnel0', 'down', 'up'),
      fsm(1, 'ppp-lcp', 'Serial0/0/0', 'req-sent', 'opened'),
      fsm(1, 'ppp-auth', 'Serial0/0/0', 'pending', 'success'),
      fsm(1, 'ppp-ncp', 'Serial0/0/0', 'req-sent', 'opened'),
      fsm(1, 'ike', '203.0.113.2', 'negotiating', 'established'),
    ];
    for (const ev of wan) expect(laneOf(ev)).toBe('wan');
  });
});

describe('a refresh is not a mark', () => {
  it('recognises a rewrite that moved only the volatile keys', () => {
    expect(VOLATILE_ROW_KEYS).toEqual(['updatedAt', 'expiresAt']);
    const [found, refresh] = cdpFoundThenRefreshed();
    expect(isRefreshOnly(found)).toBe(false); // a first write
    expect(isRefreshOnly(refresh)).toBe(true);
    const changed = write(62 * SEC, 'cdp-neighbours', 'GigabitEthernet0/1|R2', { ...CDP_ROW, platform: 'NF-4321' }, CDP_ROW);
    expect(isRefreshOnly(changed)).toBe(false);
    const grown = write(62 * SEC, 'cdp-neighbours', 'GigabitEthernet0/1|R2', { ...CDP_ROW, nativeVlan: 1 }, CDP_ROW);
    expect(isRefreshOnly(grown)).toBe(false);
    expect(isRefreshOnly(expire(63 * SEC, 'cdp-neighbours', 'k', CDP_ROW, 'aged'))).toBe(false);
    expect(isRefreshOnly(fsm(1, 'ntp', 's', 'a', 'b'))).toBe(false);
  });

  it('the lane index keeps the discovery and the ageing of a CDP neighbour, and none of its refreshes', () => {
    const index = createLaneIndex(100);
    const [found, refresh] = cdpFoundThenRefreshed();
    index.observe(found, 1);
    index.observe(refresh, 2);
    index.observe(write(121 * SEC, 'cdp-neighbours', 'GigabitEthernet0/1|R2', { ...CDP_ROW, expiresAt: 301 * SEC }, { ...CDP_ROW, updatedAt: 61 * SEC, expiresAt: 241 * SEC }), 3);
    index.observe(write(150 * SEC, 'cdp-neighbours', 'GigabitEthernet0/1|R2', { ...CDP_ROW, platform: 'NF-4321' }, CDP_ROW), 4);
    index.observe(expire(330 * SEC, 'cdp-neighbours', 'GigabitEthernet0/1|R2', CDP_ROW, 'aged'), 5);
    expect(index.marks({ lane: 'mgmt', from: 0, to: 400 * SEC, limit: 10 }).map((m) => m.cursor)).toEqual([1, 4, 5]);
    expect(index.revision).toBe(3);
  });

  it('a P2 lane still indexes every write, refreshes included (its writers rewrite only on a change)', () => {
    const index = createLaneIndex(100);
    const row = { network: '10.0.0.0/24', nextHop: '10.0.12.2', source: 'static' };
    index.observe(write(1 * SEC, 'rib', '10.0.0.0/24', row), 1);
    index.observe(write(2 * SEC, 'rib', '10.0.0.0/24', row, { ...row, updatedAt: 1 * SEC }), 2);
    expect(index.marks({ lane: 'routing', from: 0, to: 10 * SEC, limit: 10 }).map((m) => m.cursor)).toEqual([1, 2]);
  });
});

describe('the strip shows the two lanes', () => {
  /** A minute of a P3 world: CDP found and refreshed, an NTP sync, a log at a server, a PPP link and a tunnel coming up. */
  function minute(): TraceEvent[] {
    const [found, refresh] = cdpFoundThenRefreshed();
    return [
      found,
      fsm(5 * SEC, 'ppp-lcp', 'Serial0/0/0', 'req-sent', 'opened'),
      write(6 * SEC, 'ppp', 'Serial0/0/0', { port: 'Serial0/0/0', phase: 'network', lcp: 'opened', authLocal: 'chap', authPeer: 'none', ipcp: 'opened', magic: 1, failures: 0, since: 6 * SEC }),
      write(7 * SEC, 'tunnels', 'Tunnel0', { port: 'Tunnel0', mode: 'gre', state: 'up', transportMtu: 1500, ipMtu: 1476, since: 7 * SEC }),
      fsm(20 * SEC, 'ntp', '10.0.0.10', 'unsynchronised', 'synchronised'),
      write(20 * SEC, 'clock', 'clock', { source: 'ntp', stratum: 2, reference: '10.0.0.10', offsetMs: 12, offsetSubMsNs: 0, since: 20 * SEC }),
      write(40 * SEC, 'syslog-messages', '1', { seq: 1, from: '10.0.0.1', facility: 23, severity: 3, hostname: 'R1', stamp: 'Jan  6 08:00:40.000', message: '%LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down', receivedStamp: 'Jan  6 08:00:40.001' }),
      refresh,
    ];
  }

  it('as the last two rows, with their vocabulary, counting the state changes only', () => {
    const index = createLaneIndex(100);
    minute().forEach((ev, i) => index.observe(ev, i));
    const buckets = index.buckets({ from: 0, to: 60 * SEC, buckets: 6 });
    const rows = laneRows(buckets, DEFAULT_TIMELINE_LANES, { hideEmpty: true });
    expect(rows.map((r) => r.lane)).toEqual(['mgmt', 'wan']);
    const [mgmt, wan] = rows;
    expect(mgmt).toMatchObject({ label: LANE_VOCAB.mgmt.label, glyph: 'MG', total: 4 });
    expect(wan).toMatchObject({ label: LANE_VOCAB.wan.label, glyph: 'WN', total: 3 });
    // every row, quiet ones included, ends with the two P3 lanes
    expect(laneRows(buckets).slice(-2).map((r) => r.lane)).toEqual(['mgmt', 'wan']);
    // a learner who hid the WAN lane does not get it back
    expect(laneRows(buckets, DEFAULT_TIMELINE_LANES.filter((l) => l !== 'wan'), { hideEmpty: true }).map((r) => r.lane)).toEqual(['mgmt']);
  });

  it('lists the marks of each lane as sentences', () => {
    const index = createLaneIndex(100);
    const events = minute();
    events.forEach((ev, i) => index.observe(ev, i));
    const listed = (lane: 'mgmt' | 'wan'): string[] =>
      index.marks({ lane, from: 0, to: 60 * SEC, limit: 20 }).map((m) => markText({ ...m, event: events[m.cursor]! } satisfies TimelineMark, (id) => id.toUpperCase()));
    expect(listed('mgmt')).toEqual([
      'R1: CDP neighbour R2 on GigabitEthernet0/1 found',
      `${LANE_FSM_LABEL('ntp')} · 10.0.0.10: unsynchronised → synchronised`,
      'R1: clock synchronised by NTP from 10.0.0.10, stratum 2',
      'R1: log from R1: %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down',
    ]);
    expect(listed('wan')).toEqual([
      `${LANE_FSM_LABEL('ppp-lcp')} · Serial0/0/0: req-sent → opened`,
      'R1: PPP on Serial0/0/0: network phase',
      'R1: Tunnel0 (GRE) up',
    ]);
  });
});

/** The FSM label the strip prints for a machine (vocab/fsm via markText's own path). */
function LANE_FSM_LABEL(machine: FsmMachine): string {
  const text = markText({ cursor: 0, t: 0, lane: 'mgmt', event: fsm(0, machine, 's', 'a', 'b') });
  return text.slice(0, text.indexOf(' · '));
}

describe('the sentences of the mgmt and wan rows', () => {
  const words = (ev: TraceEvent): string | undefined => (ev.kind === 'tableWrite' || ev.kind === 'tableExpire' ? p3RowText(ev) : undefined);

  it('neighbours: found, updated, removed with the reason; LLDP by system name, else chassis id', () => {
    const key = 'GigabitEthernet0/1|R2';
    expect(words(write(1, 'cdp-neighbours', key, CDP_ROW))).toBe('CDP neighbour R2 on GigabitEthernet0/1 found');
    expect(words(write(2, 'cdp-neighbours', key, { ...CDP_ROW, platform: 'NF-4321' }, CDP_ROW))).toBe('CDP neighbour R2 on GigabitEthernet0/1 updated');
    expect(words(expire(3, 'cdp-neighbours', key, CDP_ROW, 'link-down'))).toBe('CDP neighbour R2 on GigabitEthernet0/1 removed (link-down)');
    const lldp = { localPort: 'GigabitEthernet0/2', chassisId: '02:00:00:00:00:02', portId: 'Gi0/1', ttlS: 120 };
    expect(words(write(1, 'lldp-neighbours', 'k', { ...lldp, systemName: 'SW2' }))).toBe('LLDP neighbour SW2 on GigabitEthernet0/2 found');
    expect(words(write(1, 'lldp-neighbours', 'k', lldp))).toBe('LLDP neighbour 02:00:00:00:00:02 on GigabitEthernet0/2 found');
  });

  it('time: the server’s selection with its stratum, and where the clock came from', () => {
    const peer = { address: '10.0.0.10', configured: true, refId: 'LOCL', stratum: 1, pollS: 64, reach: 1 };
    expect(words(write(1, 'ntp-peers', '10.0.0.10', { ...peer, selected: 'sys-peer' }))).toBe('time server 10.0.0.10 chosen as the time source, stratum 1');
    expect(words(write(1, 'ntp-peers', '10.0.0.10', { ...peer, stratum: 16, selected: 'reject' }))).toBe('time server 10.0.0.10 rejected, stratum 16');
    expect(words(write(1, 'ntp-peers', '10.0.0.10', { ...peer, selected: 'unreached' }))).toBe('time server 10.0.0.10 not answering, stratum 1');
    expect(words(write(1, 'clock', 'clock', { source: 'user', offsetMs: 0, offsetSubMsNs: 0, since: 1 }))).toBe('clock set by hand');
    expect(words(write(1, 'clock', 'clock', { source: 'master', stratum: 8, offsetMs: 0, offsetSubMsNs: 0, since: 1 }))).toBe('clock serving its own time (ntp master), stratum 8');
    expect(words(expire(1, 'clock', 'clock', { source: 'ntp' }, 'cleared'))).toBe('clock entry removed (cleared)');
  });

  it('WAN: tunnel state with the reason, PPP phase with an authentication failure, the IPsec SA state', () => {
    const tunnel = { port: 'Tunnel0', mode: 'ipsec', transportMtu: 1500, ipMtu: 1456, since: 1 };
    expect(words(write(1, 'tunnels', 'Tunnel0', { ...tunnel, state: 'down', reason: 'ike-negotiating' }))).toBe('Tunnel0 (IPsec) down (ike-negotiating)');
    const ppp = { port: 'Serial0/0/0', lcp: 'opened', authLocal: 'chap', authPeer: 'none', ipcp: 'initial', magic: 1, failures: 1, since: 1 };
    expect(words(write(1, 'ppp', 'Serial0/0/0', { ...ppp, phase: 'authenticate', authLocalState: 'failed' }))).toBe('PPP on Serial0/0/0: authenticate phase, authentication failed');
    const sa = { port: 'Tunnel0', local: '198.51.100.1', peer: '203.0.113.2', profile: 'VPN', role: 'initiator', since: 1 };
    expect(words(write(1, 'ipsec-sa', 'Tunnel0', { ...sa, state: 'established' }))).toBe('IPsec SA on Tunnel0 with 203.0.113.2 established');
    expect(words(write(1, 'ipsec-sa', 'Tunnel0', { ...sa, state: 'failed', reason: 'ike-failed' }))).toBe('IPsec SA on Tunnel0 with 203.0.113.2 failed (ike-failed)');
  });

  it('leaves every other table to the generic wording (P1/P2 marks unchanged)', () => {
    expect(words(write(1, 'rib', '10.0.0.0/24', {}))).toBeUndefined();
    expect(markText({ cursor: 0, t: 1, lane: 'routing', event: write(1, 'rib', '10.0.0.0/24', {}) })).toBe('r1: IPv4 routes 10.0.0.0/24 written');
    expect(markText({ cursor: 0, t: 1, lane: 'security', event: write(1, 'acl', '4|101|10', {}) })).toBe('r1: Access list hits 4|101|10 written');
  });
});
