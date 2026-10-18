/**
 * disc.cdp-mismatch — [S41] the two CDP mismatch logs (ARCHITECTURE-P3C D9, §4.3, §4.4, §7 W1b disc): a native-VLAN
 * mismatch on an operational trunk (never on an access port) and a duplex mismatch on any CDP port, each logged at
 * severity 4 with original wording, at most once per port per 60 s (exact to the ns), checked on receipt.
 *
 * World level: `staged.world` at stage P3 (CDP on by default in a P3 world), two NF-C2960 switches, configuration
 * through the stored-line path (`startupConfig`). Unit level: the real daemon on the fake context of
 * `disc.fake-ctx.ts`, for the 60 s boundary to the ns.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  CDP_LOG_FACILITY,
  CDP_MISMATCH_LOG_INTERVAL,
  CDP_MISMATCH_SEVERITY,
  cdpDuplexMismatchText,
  cdpFrameSpecs,
  cdpNativeMismatchText,
  createCdp,
  type CdpAdvertisement,
} from '../src/protocols/cdp.js';
import { fakeDevice, logsOf } from './disc.fake-ctx.js';
import { createStagedSimulation } from './staged.world.js';

type Log = Extract<TraceEvent, { kind: 'log' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** SW1 Gi0/2 ↔ SW2 Gi0/1 and SW1 Fa0/24 ↔ SW2 Fa0/24, with `sw1`/`sw2` extra startup sections. */
function world(opts: { sw1?: string[][]; sw2?: string[][]; profile?: DefaultsProfile; fast?: boolean } = {}): Simulation {
  const sim = createStagedSimulation({ seed: 41, stage: 'P3', ...(opts.profile !== undefined ? { profile: opts.profile } : {}), factories: { cdp: createCdp } });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ...(opts.sw1 ?? [])]) });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ...(opts.sw2 ?? [])]) });
  if (opts.fast === true) sim.addLink({ a: { device: 'sw1', port: 'FastEthernet0/24' }, b: { device: 'sw2', port: 'FastEthernet0/24' } });
  else sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  return sim;
}

const cdpLogs = (sim: Simulation): Log[] => sim.trace(0).events.filter((e): e is Log => e.kind === 'log' && e.facility === CDP_LOG_FACILITY);
const shape = (l: Log): [string, number, string] => [l.device, l.severity, l.message];

describe('[S41] the log texts (original wording)', () => {
  it('native VLAN and duplex', () => {
    expect(cdpNativeMismatchText('GigabitEthernet0/2', 99, 'SW2', 'GigabitEthernet0/1', 1)).toBe('Native VLAN differs on GigabitEthernet0/2: ours is 99, SW2 sends 1 from its GigabitEthernet0/1');
    expect(cdpDuplexMismatchText('FastEthernet0/24', 'full', 'SW2', 'FastEthernet0/24', 'half')).toBe('Duplex differs on FastEthernet0/24: ours is full, SW2 runs half duplex on its FastEthernet0/24');
    expect([CDP_LOG_FACILITY, CDP_MISMATCH_SEVERITY, CDP_MISMATCH_LOG_INTERVAL]).toEqual(['CDP', 4, 60 * SEC]);
  });
});

describe('[S41] on staged.world (P3 world, CDP on by default)', () => {
  it('a native-VLAN mismatch on a trunk logs on both ends at severity 4, once per 60 s, at the exact receipt instants', () => {
    const sim = world({
      sw1: [['interface GigabitEthernet0/2', ' switchport mode trunk', ' switchport trunk native vlan 99'], ['cdp timer 30']],
      sw2: [['interface GigabitEthernet0/1', ' switchport mode trunk'], ['cdp timer 30']],
    });
    sim.runFor(200 * SEC);
    const logs = cdpLogs(sim);
    const sw1 = logs.filter((l) => l.device === 'sw1');
    const sw2 = logs.filter((l) => l.device === 'sw2');
    expect(sw1.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sw1.map(shape).map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify(['sw1', 4, 'Native VLAN differs on GigabitEthernet0/2: ours is 99, SW2 sends 1 from its GigabitEthernet0/1'])]));
    expect(new Set(sw2.map(shape).map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify(['sw2', 4, 'Native VLAN differs on GigabitEthernet0/1: ours is 1, SW1 sends 99 from its GigabitEthernet0/2'])]));
    // frames every 30 s: a receipt logs exactly when 60 s or more passed since the last log on that port
    for (const [device, side] of [['sw1', sw1], ['sw2', sw2]] as const) {
      const receipts = sim.trace(0).events.filter((e) => e.kind === 'debug' && e.event.device === device && e.event.process === 'cdp' && e.event.message.startsWith('received CDP')).map((e) => e.t);
      const expected: number[] = [];
      for (const t of receipts) if (expected.length === 0 || t - expected[expected.length - 1]! >= 60 * SEC) expected.push(t);
      expect(side.map((l) => l.t)).toEqual(expected);
      expect(receipts.length).toBeGreaterThan(side.length);
    }
  });

  it('a duplex mismatch logs on both ends (forced full against autonegotiated half)', () => {
    const sim = world({ fast: true, sw1: [['interface FastEthernet0/24', ' speed 100', ' duplex full']] });
    sim.runFor(100 * SEC);
    const logs = cdpLogs(sim).map(shape);
    expect(logs).toContainEqual(['sw1', 4, 'Duplex differs on FastEthernet0/24: ours is full, SW2 runs half duplex on its FastEthernet0/24']);
    expect(logs).toContainEqual(['sw2', 4, 'Duplex differs on FastEthernet0/24: ours is half, SW1 runs full duplex on its FastEthernet0/24']);
    expect(logs.every(([, , m]) => m.startsWith('Duplex differs'))).toBe(true);
  });

  it('matched neighbours log nothing', () => {
    const sim = world({ sw1: [['interface GigabitEthernet0/2', ' switchport mode trunk']], sw2: [['interface GigabitEthernet0/1', ' switchport mode trunk']] });
    sim.runFor(200 * SEC);
    expect(cdpLogs(sim)).toEqual([]);
  });

  it('no native check on an access port: a trunk neighbour\'s native VLAN arriving on an access port logs nothing', () => {
    const sim = world({
      sw1: [['interface GigabitEthernet0/2', ' switchport mode access', ' switchport access vlan 1']],
      sw2: [['interface GigabitEthernet0/1', ' switchport mode trunk', ' switchport trunk native vlan 99']],
    });
    sim.runFor(200 * SEC);
    const rows = sim.device('sw1')!.tables.get<CdpNeighbourRow>('cdp-neighbours')!.rows();
    expect(rows.map((r) => [r.deviceId, r.nativeVlan])).toEqual([['SW2', 99]]);
    expect(cdpLogs(sim)).toEqual([]);
  });

  it('a P2 world sends no CDP, so nothing logs; `cdp run` turns it on there too', () => {
    const lines = { sw1: [['interface GigabitEthernet0/2', ' switchport mode trunk', ' switchport trunk native vlan 99']], sw2: [['interface GigabitEthernet0/1', ' switchport mode trunk']] };
    const quiet = world({ ...lines, profile: 'P2' });
    quiet.runFor(100 * SEC);
    expect(cdpLogs(quiet)).toEqual([]);
    const on = world({ sw1: [...lines.sw1, ['cdp run']], sw2: [...lines.sw2, ['cdp run']], profile: 'P2' });
    on.runFor(100 * SEC);
    expect(cdpLogs(on).map((l) => l.device).sort()).toEqual(['sw1', 'sw2']);
  });
});

describe('[S41] the 60 s rate limit to the ns (the real daemon on a fake switch)', () => {
  const peer = (over: Partial<CdpAdvertisement> = {}): CdpAdvertisement => ({
    version: 2, ttl: 180, deviceId: 'SW2', portId: 'GigabitEthernet0/1', capabilities: 'S I', platform: 'NF-C2960', software: 'x', duplex: 'half', nativeVlan: 99, ...over,
  });

  it('per port and per kind; 60 s − 1 ns is quiet, 60 s logs again', () => {
    const dev = fakeDevice({
      model: 'NF-C2960', hostname: 'SW1', capabilities: ['switching', 'managed-switch'],
      ports: [{ id: 'GigabitEthernet0/1', role: 'switched' }, { id: 'GigabitEthernet0/2', role: 'switched' }],
    });
    dev.config.apply([['interface', 'GigabitEthernet0/1']], ['switchport', 'mode', 'trunk'], false);
    dev.config.apply([['interface', 'GigabitEthernet0/2']], ['switchport', 'mode', 'trunk'], false);
    dev.config.apply([], ['cdp', 'run'], false);
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    const rx = (port: string, over: Partial<CdpAdvertisement> = {}) => logsOf(cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', peer(over))), port)).map((l) => [l.severity, l.facility, l.message.split(':')[0]]);
    const T = 1_000 * SEC;
    dev.now = T;
    expect(rx('GigabitEthernet0/1')).toEqual([[4, 'CDP', 'Native VLAN differs on GigabitEthernet0/1'], [4, 'CDP', 'Duplex differs on GigabitEthernet0/1']]);
    // another port has its own limit
    expect(rx('GigabitEthernet0/2')).toEqual([[4, 'CDP', 'Native VLAN differs on GigabitEthernet0/2'], [4, 'CDP', 'Duplex differs on GigabitEthernet0/2']]);
    dev.now = T + 60 * SEC - 1;
    expect(rx('GigabitEthernet0/1')).toEqual([]);
    dev.now = T + 60 * SEC;
    expect(rx('GigabitEthernet0/1')).toEqual([[4, 'CDP', 'Native VLAN differs on GigabitEthernet0/1'], [4, 'CDP', 'Duplex differs on GigabitEthernet0/1']]);
    // each kind has its own limit: a duplex-only mismatch 30 s later stays quiet, then logs at its own 60 s
    dev.now = T + 90 * SEC;
    expect(rx('GigabitEthernet0/1', { nativeVlan: 1 })).toEqual([]);
    dev.now = T + 120 * SEC;
    expect(rx('GigabitEthernet0/1', { nativeVlan: 1 })).toEqual([[4, 'CDP', 'Duplex differs on GigabitEthernet0/1']]);
    // matched: nothing, whatever the time
    dev.now = T + 500 * SEC;
    expect(rx('GigabitEthernet0/1', { nativeVlan: 1, duplex: 'full' })).toEqual([]);
    // no rate-limit member in the StateView (the snapshot hash of every P3 world keeps its bytes)
    expect(Object.keys(cdp.stateSnapshot().state as object).filter((k) => k !== 'nextTxAt')).toEqual(['running', 'timerS', 'holdtimeS', 'advertiseV2', 'disabled', 'sent', 'received', 'errors']);
  });
});
