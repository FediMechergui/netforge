/**
 * P0.5 acceptance — determinism (ARCHITECTURE-P1 §10.1 `accept.p05.determinism`; G4, D8, D12, §5.1, §10).
 *
 * A composite world — a modular router with a serial card on a clocked serial line to a second router, a multilayer
 * switch with a routed port and a loopback, a hub LAN where two pings collide, and a Wi-Fi home router with a laptop —
 * run three times with the same seed gives byte-identical trace and snapshot JSON.
 *
 * The two P0 acceptance scenarios keep their P0 event sequences event for event, and their snapshots differ from the
 * P0 ones only in MAC values: test/goldens/accept.p05.p0-sequences.json holds what the P0 engine produced, compared
 * through the normalisation of test/accept.p05.harness.ts (MAC tokens, masked FCS values, no RouteRow.owner; snapshot
 * containment, so P0.5 snapshot fields and the §9.2 hdlc daemon on NF-2911 are additions, not changes).
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { RunStats } from '../src/contracts/simulation.js';
import type { SimSnapshot } from '../src/contracts/snapshot.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { pcConfig, pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind, output } from './sim.harness.js';
import {
  MASK24,
  MASK30,
  MASK32,
  cable,
  configText,
  containmentProblems,
  device,
  macOwners,
  p0EventLine,
  readP0Reference,
  replaceMacs,
  section,
  topology,
} from './accept.p05.harness.js';

/** P0 event lines that are not in `actual` as an ordered subsequence (empty when every one of them is). */
function missingP0Lines(expected: readonly string[], actual: readonly string[]): string[] {
  const missing: string[] = [];
  let i = 0;
  for (const line of expected) {
    const at = actual.indexOf(line, i);
    if (at < 0) missing.push(line);
    else i = at + 1;
  }
  return missing;
}

const SEED = 20_260_914;
const WIFI_LINES = ['ssid LAB', 'security wpa2-psk', 'passphrase composite-key-1357'];

/** The composite world of the determinism row. */
function compositeWorld(): Topology {
  const r1 = device(
    'r1',
    'router.nf1941',
    'R1',
    200,
    200,
    configText([
      ['hostname R1'],
      section('interface GigabitEthernet0/0', [`ip address 10.3.0.1 ${MASK24}`, 'no shutdown']),
      section('interface Serial0/0/0', [`ip address 10.0.12.1 ${MASK30}`, 'clock rate 64000', 'no shutdown']),
      [`ip route 10.1.1.0 ${MASK24} 10.0.12.2`, `ip route 10.9.9.1 ${MASK32} 10.0.12.2`],
    ]),
  );
  r1.modules = [{ slot: '0/0', module: 'mod.ehwic-2t' }];
  return topology(
    [
      r1,
      device(
        'r2',
        'router.nf2911',
        'R2',
        400,
        200,
        configText([
          ['hostname R2'],
          section('interface GigabitEthernet0/0', [`ip address 10.1.1.2 ${MASK24}`, 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 10.0.12.2 ${MASK30}`, 'no shutdown']),
          [`ip route 10.3.0.0 ${MASK24} 10.0.12.1`, `ip route 10.9.9.1 ${MASK32} 10.1.1.1`],
        ]),
      ),
      device(
        'mls1',
        'mlswitch.nfc3650-24',
        'MLS1',
        600,
        200,
        configText([
          ['hostname MLS1'],
          section('interface GigabitEthernet1/0/24', ['no switchport', `ip address 10.1.1.1 ${MASK24}`]),
          section('interface Loopback0', [`ip address 10.9.9.1 ${MASK32}`]),
          [`ip route 10.3.0.0 ${MASK24} 10.1.1.2`, `ip route 10.0.12.0 ${MASK30} 10.1.1.2`],
        ]),
      ),
      device('hub1', 'hub.nfhub4', 'HUB1', 200, 400),
      device('pc3', 'pc.nfpc', 'PC3', 100, 500, pcConfig('PC3', '10.3.0.3', MASK24, '10.3.0.1')),
      device('pc4', 'pc.nfpc', 'PC4', 300, 500, pcConfig('PC4', '10.3.0.4', MASK24, '10.3.0.1')),
      device('home1', 'wrouter.nfhome', 'HOME1', 800, 400, configText([['hostname HOME1'], section('interface Vlan1', [`ip address 192.168.1.1 ${MASK24}`]), section('interface Wlan0', WIFI_LINES)])),
      device('pc5', 'pc.nfpc', 'PC5', 700, 550, pcConfig('PC5', '192.168.1.10', MASK24)),
      device('laptop1', 'laptop.nflaptop', 'LAPTOP1', 960, 400, configText([['hostname LAPTOP1'], section('interface Wlan0', [`ip address 192.168.1.20 ${MASK24}`, ...WIFI_LINES])])),
    ],
    [
      cable('l_r1_hub1', 'r1', 'GigabitEthernet0/0', 'hub1', 'Ethernet0'),
      cable('l_pc3_hub1', 'pc3', 'GigabitEthernet0', 'hub1', 'Ethernet1'),
      cable('l_pc4_hub1', 'pc4', 'GigabitEthernet0', 'hub1', 'Ethernet2'),
      cable('l_r1_r2', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
      cable('l_r2_mls1', 'r2', 'GigabitEthernet0/0', 'mls1', 'GigabitEthernet1/0/24'),
      cable('l_pc5_home1', 'pc5', 'GigabitEthernet0', 'home1', 'GigabitEthernet1'),
    ],
  );
}

/** One run of the composite world. */
interface CompositeRun {
  readonly events: TraceEvent[];
  readonly trace: string;
  readonly snapshot: SimSnapshot;
  readonly snapshotJson: string;
  readonly outputs: string[];
  readonly idle: RunStats;
}

/** Boot the composite world, start three pings at the same instant (two of them on the hub), run until idle. */
function runComposite(): CompositeRun {
  const sim = createSimulation({ seed: SEED });
  sim.loadTopology(compositeWorld());
  sim.runFor(90 * SEC);
  const pings = [
    ['pc3', 'ping 10.9.9.1'],
    ['pc4', 'ping 10.3.0.3'],
    ['laptop1', 'ping 192.168.1.10'],
  ] as const;
  const sessions = pings.map(([id, line]) => {
    const session = sim.cli.open(id, 'console');
    sim.cli.exec(session, line);
    return session;
  });
  const idle = sim.runToIdle(500_000);
  const events = sim.trace(0).events;
  const snapshot = sim.snapshot();
  return { events, trace: JSON.stringify(events), snapshot, snapshotJson: JSON.stringify(snapshot), outputs: sessions.map((s) => output(events, s)), idle };
}

describe('accept P0.5: determinism', () => {
  it('replays a composite of a serial module, a routed port and loopback, CSMA/CD on a hub and Wi-Fi byte for byte 3×', () => {
    const runs = [runComposite(), runComposite(), runComposite()];
    const first = runs[0]!;
    expect(first.idle.events).toBeLessThan(500_000);
    for (const text of first.outputs) expect(text).toContain('Sent 5, received 5, lost 0');

    const evs = first.events;
    expect(ofKind(evs, 'frameTx').filter((e) => e.link === 'l_r1_r2' && e.from.device === 'r1' && e.from.port === 'Serial0/0/0').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'frameTx').filter((e) => e.medium === 'segment').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'collision').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'backoff').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'frameTx').filter((e) => e.medium === 'air').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'assocState').some((e) => e.station.device === 'laptop1' && e.state === 'associated')).toBe(true);

    const devices = first.snapshot.devices;
    expect(devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === 'Serial0/0/0')).toMatchObject({ ordinal: 128, module: { slot: '0/0', module: 'mod.ehwic-2t' } });
    expect(devices.find((d) => d.id === 'mls1')!.ports.find((p) => p.id === 'GigabitEthernet1/0/24')).toMatchObject({ role: 'routed' });
    expect(devices.find((d) => d.id === 'mls1')!.ports.find((p) => p.id === 'Loopback0')).toMatchObject({ role: 'virtual', operUp: true });
    expect(first.snapshot.media!.segments).toHaveLength(1);
    expect(first.snapshot.media!.associations).toHaveLength(1);

    for (const run of runs.slice(1)) {
      expect(run.trace).toBe(first.trace);
      expect(run.snapshotJson).toBe(first.snapshotJson);
    }
  });

  it('keeps the P0 event sequences of the two P0 acceptance scenarios, with snapshots that differ only in MAC values', () => {
    const reference = readP0Reference();
    const scenarios = [
      { name: 'two-pcs-and-switch', build: twoPcsAndSwitch, bootNs: 40 * SEC, target: '10.0.0.2' },
      { name: 'pc-router-pc', build: pcRouterPc, bootNs: 60 * SEC, target: '10.0.1.1' },
    ];
    expect(Object.keys(reference.scenarios)).toEqual(scenarios.map((s) => s.name));
    for (const s of scenarios) {
      const ref = reference.scenarios[s.name]!;
      const sim = createSimulation({ seed: ref.seed });
      sim.loadTopology(s.build());
      sim.runFor(s.bootNs);
      const session = sim.cli.open('pc1', 'console');
      sim.cli.exec(session, `ping ${s.target}`);
      sim.runToIdle();

      const snapshot = sim.snapshot();
      const owners = macOwners(snapshot);
      // §9.2: daemons added to P0 models after P0 are silent on the wire but log one `debug` line at boot (arp on
      // the L2 switch from P1 W5, the host stack on the PCs). The traffic sequence stays identical event for
      // event, and every P0 line — debug included — is still there, in order.
      const actual = sim.trace(0).events.map((e) => p0EventLine(e, owners));
      const traffic = (lines: readonly string[]): string[] => lines.filter((l) => !l.includes('|debug|'));
      expect(traffic(actual), s.name).toEqual(traffic(ref.events));
      expect(missingP0Lines(ref.events, actual), s.name).toEqual([]);
      expect(containmentProblems(ref.snapshot, replaceMacs(snapshot, owners)), s.name).toEqual([]);
      expect(JSON.stringify(ref.snapshot)).not.toMatch(/\d\d:1f:/);
      for (const d of snapshot.devices) {
        for (const p of d.ports) expect(p.mac, `${s.name} ${d.id} ${p.id}`).toBe(portMac(deviceMacBase(d.id), p.ordinal ?? 0));
      }
    }
  });
});
