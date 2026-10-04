/**
 * cli/handlers/time.ts, the W3 shows (ARCHITECTURE-P3 §5.8, D19; §7 W3 cli part 2; rule 20): `show ntp associations
 * [detail]` (configuration order; the `ntp-peers` rows for the reference, stratum, octal reach, delay and offset, `When`
 * from the row's last reply; the next poll from the ntp StateView's `peers[].nextPollAt`, with the retries left and the
 * last refusal) and `show ntp status` (the §5.8 first line from the device clock; the source, the `clock` row and the
 * requests answered). Against fake tables, the §2.6 NtpStateView and a clock view; the integer offset and delay
 * renderers on their edge cases (negative offsets, offsets beyond 2^53 ns).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandCtx, CommandOutcome } from '../src/contracts/cli.js';
import type { DeviceClockView } from '../src/contracts/clock.js';
import type { ClockRow, NtpPeerRow, NtpStateView, Table, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { SHOW_NTP_DETAIL_ARG } from '../src/cli/grammar/time.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_NO_NTP_SERVER, NTP_ASSOCIATIONS_LEGEND, ntpDelayText, ntpOffsetText } from '../src/cli/handlers/time.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');
const NOW = 1000 * SEC;

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, false);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name as never, t as unknown as Table<TableRow>);
  return t;
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

/** A recording context whose clock reads `view`. */
function withClock(rec: RecordingCtx, view: DeviceClockView): RecordingCtx {
  return { ...rec, ctx: { ...rec.ctx, clock: () => view } as CommandCtx };
}

const PEER_A: NtpPeerRow = {
  key: '10.0.0.10', address: '10.0.0.10', configured: true, refId: 'LOCL', stratum: 1, lastRxAt: NOW - 36 * SEC, pollS: 64, reach: 0xff,
  delayNs: 1_234_567, offsetMs: 0, offsetSubMsNs: 567_890, selected: 'sys-peer', updatedAt: 0,
};
const PEER_B: NtpPeerRow = {
  key: '10.0.0.11', address: '10.0.0.11', configured: true, refId: 'INIT', stratum: 16, pollS: 64, reach: 0b110, selected: 'reject', updatedAt: 0,
};
const SV: NtpStateView = {
  peers: [
    { address: '10.0.0.10', nextPollAt: NOW + 28 * SEC, retriesLeft: 0, lastSentAt: NOW - 36 * SEC },
    { address: '10.0.0.11', nextPollAt: NOW + 4 * SEC, retriesLeft: 3, lastReject: 'the server is not synchronised (stratum 16)' },
  ],
  served: 3,
};

/** R2: two servers (the second preferred) and one name that is not used; their rows and the ntp StateView. */
function r2(sv: NtpStateView | null = SV): RecordingCtx {
  const r = commandCtxFor(ROUTER, { mode: 'priv-exec', ...(sv === null ? {} : { processStates: { ntp: { process: 'ntp', state: sv as unknown as Record<string, unknown> } } }) });
  (r.ctx as { now: number }).now = NOW;
  r.running.set([], ['ntp', 'server', '10.0.0.10']);
  r.running.set([], ['ntp', 'server', '10.0.0.11', 'prefer']);
  r.running.set([], ['ntp', 'server', 'time.example']);
  const peers = attach<NtpPeerRow>(r, 'ntp-peers');
  peers.set(PEER_B);
  peers.set(PEER_A);
  return r;
}

describe('parsing and scope', () => {
  it('parses the NTP shows on routers and managed switches (any exec mode), not on a host', () => {
    const cases: [string, string, Record<string, string>][] = [
      ['show ntp associations', HANDLERS.showNtpAssociations, {}],
      ['show ntp associations detail', HANDLERS.showNtpAssociations, { [SHOW_NTP_DETAIL_ARG]: 'detail' }],
      ['sh ntp st', HANDLERS.showNtpStatus, {}],
    ];
    for (const [line, handler, args] of cases) {
      for (const model of [ROUTER, SWITCH]) {
        const m = matchCommand(GRAMMAR, matchContextFor(model, 'user-exec'), line);
        expect(m.ok, `${line} on ${model.type}`).toBe(true);
        if (!m.ok) continue;
        expect(m.spec.handler).toBe(handler);
        expect({ ...m.args }).toEqual(args);
      }
      expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), line).ok, `${line} on a PC`).toBe(false);
    }
  });
});

describe('the offset and delay renderers (integer arithmetic)', () => {
  it('render θ = offsetMs ms + offsetSubMsNs ns with three decimals, truncated toward zero', () => {
    expect(ntpOffsetText(0, 567_890)).toBe('0.567');
    expect(ntpOffsetText(12, 0)).toBe('12.000');
    expect(ntpOffsetText(-2, 500_000)).toBe('-1.500');
    expect(ntpOffsetText(-3, 0)).toBe('-3.000');
    expect(ntpOffsetText(-1, 999_999)).toBe('-0.000');
    // a first sync of an unset clock (2020-01-01) against true time (2025-01-06): far beyond 2^53 ns, exact in ms
    expect(ntpOffsetText(157_680_000_123, 456_789)).toBe('157680000123.456');
    expect(ntpOffsetText(-157_680_000_124, 543_211)).toBe('-157680000123.456');
    expect(ntpDelayText(1_234_567)).toBe('1.234');
    expect(ntpDelayText(999)).toBe('0.000');
    expect(ntpDelayText(25_000_000)).toBe('25.000');
  });
});

describe('show ntp associations', () => {
  it('one row per configured server in configuration order: reach in octal, When from the last reply, Next from nextPollAt', () => {
    expect(lines(run(r2(), HANDLERS.showNtpAssociations))).toEqual([
      '   Address          Reference  Stratum  When  Poll  Next  Reach  Delay (ms)  Offset (ms)',
      '*  10.0.0.10        LOCL       1        36    64    28    377    1.234       0.567',
      '-  10.0.0.11        INIT       16       -     64    4     6      -           -',
      NTP_ASSOCIATIONS_LEGEND,
      'Not used (a name, not an address): time.example',
    ]);
  });

  it('a server not polled yet, and no StateView (the daemon does not run): dashes and a zero reach', () => {
    const r = r2(null);
    r.running.set([], ['ntp', 'server', '10.0.0.12']);
    const out = lines(run(r, HANDLERS.showNtpAssociations));
    expect(out[1]).toBe('*  10.0.0.10        LOCL       1        36    64    -     377    1.234       0.567');
    expect(out[3]).toBe('?  10.0.0.12        -          -        -     -     -     0      -           -');
  });

  it('detail: one block per server with its timers, retries and last refusal', () => {
    expect(lines(run(r2(), HANDLERS.showNtpAssociations, { [SHOW_NTP_DETAIL_ARG]: 'detail' }))).toEqual([
      '10.0.0.10: configured, the server this clock follows',
      '  Stratum 1, reference LOCL',
      '  Reach 377 (octal); poll every 64 s; last reply 00:00:36 ago',
      '  Delay 1.234 ms, offset 0.567 ms',
      '  Next poll in 00:00:28; quick retries left 0',
      '',
      '10.0.0.11: configured (prefer), its last reply was refused',
      '  Stratum 16, reference INIT',
      '  Reach 6 (octal); poll every 64 s; no reply yet',
      '  Delay unknown, offset unknown',
      '  Next poll in 00:00:04; quick retries left 3',
      '  Last refusal: the server is not synchronised (stratum 16)',
      'Not used (a name, not an address): time.example',
    ]);
  });

  it('says how to add a server when none is configured', () => {
    expect(run(commandCtxFor(ROUTER, { mode: 'priv-exec' }), HANDLERS.showNtpAssociations)).toEqual({ output: MSG_NO_NTP_SERVER });
  });
});

describe('show ntp status', () => {
  const TZ = { name: 'UTC', offsetMin: 0 };

  it('synchronised by NTP: the §5.8 first line, the source, the clock row and the requests answered', () => {
    const r = withClock(r2(), { source: 'ntp', authoritative: true, unixMs: 1_736_150_400_000, subMsNs: 0, stratum: 2, reference: '10.0.0.10', tz: TZ });
    const row: ClockRow = { key: 'clock', source: 'ntp', stratum: 2, reference: '10.0.0.10', offsetMs: 0, offsetSubMsNs: 567_890, since: NOW - 36 * SEC, updatedAt: 0 };
    attach<ClockRow>(r, 'clock').set(row);
    expect(lines(run(r, HANDLERS.showNtpStatus))).toEqual([
      'Clock is synchronised, stratum 2, reference is 10.0.0.10',
      '  Time source: NTP',
      '  Last set 00:00:36 ago; it reads 0.567 ms from true time',
      '  Requests answered as a time server: 3',
    ]);
  });

  it('ntp master: synchronised to its own clock; set by hand or never set: not synchronised', () => {
    const master = withClock(commandCtxFor(ROUTER, { mode: 'priv-exec' }), {
      source: 'master', authoritative: true, unixMs: 0, subMsNs: 0, stratum: 8, reference: '127.127.1.1', tz: TZ,
    });
    expect(lines(run(master, HANDLERS.showNtpStatus))).toEqual([
      'Clock is synchronised, stratum 8, reference is 127.127.1.1',
      "  Time source: this device's own clock, served at stratum 8 (ntp master)",
    ]);
    const user = withClock(commandCtxFor(ROUTER, { mode: 'priv-exec' }), { source: 'user', authoritative: true, unixMs: 0, subMsNs: 0, tz: TZ });
    expect(lines(run(user, HANDLERS.showNtpStatus))).toEqual(['Clock is not synchronised, stratum 16, no reference', '  Time source: set by hand (clock set); not synchronised']);
    // the fixture's default clock is the unset view of P3_CTX
    expect(lines(run(commandCtxFor(ROUTER, { mode: 'priv-exec' }), HANDLERS.showNtpStatus))).toEqual([
      'Clock is not synchronised, stratum 16, no reference',
      '  Time source: none: the clock was never set',
    ]);
  });
});
