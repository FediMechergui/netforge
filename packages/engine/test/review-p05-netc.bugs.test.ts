/**
 * Review P0.5 (networking-correctness lens): each test pins a confirmed defect a CCNA student would notice.
 * These FAIL on the current code; they pass once the matching fix lands.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/sim/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { homeWifi, serialPair, pcConfig } from '../src/sim/scenarios.js';
import { cable, device, topology } from './accept.p05.harness.js';

const typed = (sim: ReturnType<typeof createSimulation>, dev: string, lines: string[]): string[] => {
  const s = sim.cli.open(dev as never, 'console');
  return lines.map((l) => sim.cli.exec(s, l).output);
};
const serialCfg = (h: string, ip: string): string =>
  `hostname ${h}\n!\ninterface Serial0/0/0\n ip address ${ip} 255.255.255.252\n no shutdown\n!\nend\n`;

describe('review p05 netc: serial', () => {
  for (const [type, port] of [['csu.nfcsu', 'Serial0'], ['cloud.nfinternet', 'Serial0']] as const) {
    it(`${type}: a router cabled FROM its serial port to a clock-source port needs no clock rate (D6 / wan.ts)`, () => {
      const t = topology([device('r1', 'router.nf2911', 'R1', 0, 0, serialCfg('R1', '10.0.0.1')), device('x', type, 'X', 100, 0)],
        [cable('s', 'r1', 'Serial0/0/0', 'x', port, 'serial')]);
      const sim = createSimulation({ seed: 3 });
      sim.loadTopology(t);
      sim.runFor(80 * SEC);
      const ls = sim.link('s' as never)!;
      expect(ls.resolvedDceEnd).toBe('b'); // the clock-source end is the DCE
      expect(ls.downReason).not.toBe('no-clock');
    });
  }
});

describe('review p05 netc: show ip interface brief', () => {
  it('reports Status down (layer 1) when the far end is shut and carrier is lost, like show interfaces does', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(serialPair());
    sim.runFor(60 * SEC);
    typed(sim, 'r2', ['enable', 'configure terminal', 'interface Serial0/0/0', 'shutdown', 'end']);
    sim.runFor(40 * SEC);
    const [intf, brief] = typed(sim, 'r1', ['show interfaces Serial0/0/0', 'show ip interface brief']);
    expect(intf!.split('\n')[0]).toBe('Serial0/0/0: admin up, link down');
    expect(brief).toMatch(/^Serial0\/0\/0\s+10\.0\.12\.1\s+down\s+down$/m);
  });

  it('show interfaces of a shut interface does not say "admin admin down"', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(serialPair());
    sim.runFor(60 * SEC);
    const [out] = typed(sim, 'r1', ['show interfaces GigabitEthernet0/1']);
    expect(out).not.toContain('admin admin');
  });
});

describe('review p05 netc: cabling', () => {
  it('a console (rollover) cable joins a host terminal to a router console, never two console ports (CATALOG.md media table)', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'pc' as never, type: 'pc.nfpc' });
    sim.addDevice({ id: 'r1' as never, type: 'router.nf1941' });
    sim.addDevice({ id: 'r2' as never, type: 'router.nf2911' });
    const toHost = sim.validateLink({ a: { device: 'pc' as never, port: 'GigabitEthernet0' as never }, b: { device: 'r1' as never, port: 'Console' as never }, media: 'console' });
    const consoleToConsole = sim.validateLink({ a: { device: 'r1' as never, port: 'Console' as never }, b: { device: 'r2' as never, port: 'Console' as never }, media: 'console' });
    expect(toHost.ok).toBe(true);
    expect(consoleToConsole.ok).toBe(false);
  });
});

describe('review p05 netc: show wireless', () => {
  const failing = (mutate: (cfg: string) => string): string => {
    const t = homeWifi();
    const lap = t.devices.find((d) => d.id === 'laptop1')!;
    lap.config = mutate(lap.config!);
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(t);
    sim.runFor(90 * SEC);
    return typed(sim, 'laptop1', ['show wireless'])[0]!;
  };

  it('tells a wrong passphrase apart from a security mismatch', () => {
    const wrongKey = failing((c) => c.replace(/ passphrase [^\n]*\n/, ' passphrase wrong-pass-123\n'));
    const mismatch = failing((c) => c.replace(/ security wpa2-psk\n passphrase [^\n]*\n/, ' security open\n'));
    expect(wrongKey).not.toBe(mismatch);
    expect(wrongKey.toLowerCase()).toMatch(/key|passphrase/);
    expect(mismatch.toLowerCase()).toMatch(/security/);
  });

  it('prints the channel a station actually operates on (its BSS channel), as the snapshot does', () => {
    const t = homeWifi();
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(t);
    sim.runFor(60 * SEC);
    expect(sim.configure('home1' as never, ['interface Wlan0', 'channel 6']).ok).toBe(true);
    sim.runFor(90 * SEC);
    const radio = (sim.snapshot() as any).devices.find((d: any) => d.id === 'laptop1').ports.find((p: any) => p.id === 'Wlan0').radio;
    expect(radio.state).toBe('associated');
    expect(radio.channel).toBe(6);
    expect(typed(sim, 'laptop1', ['show wireless'])[0]).toContain('channel 6');
  });
});
