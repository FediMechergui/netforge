/**
 * Regression tests for the P0.5 engine-cli review fixes: brief Status is layer 1, `show interfaces` admin wording,
 * `show wireless` join failures / joined channel / UE attach / PtP peer, WPA3 from the host shell, and the configure
 * API's start mode and start context validation.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/sim/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { cellularPhones, homeWifi, radioBridge, serialPair } from '../src/sim/scenarios.js';
import { configText, device, section, topology } from './accept.p05.harness.js';

type Sim = ReturnType<typeof createSimulation>;

const typed = (sim: Sim, dev: string, lines: string[]): string[] => {
  const s = sim.cli.open(dev as never, 'console');
  return lines.map((l) => sim.cli.exec(s, l).output);
};

describe('show ip interface brief: Status is layer 1', () => {
  it('an unplugged, not-shut interface reads down/down; a shut one admin down/down', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(serialPair());
    sim.runFor(60 * SEC);
    typed(sim, 'r1', ['enable', 'configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    sim.runFor(5 * SEC);
    const [brief] = typed(sim, 'r1', ['show ip interface brief']);
    expect(brief).toMatch(/^GigabitEthernet0\/1\s+\S+\s+down\s+down$/m);
    expect(brief).not.toMatch(/^GigabitEthernet0\/1\s+\S+\s+up\s+down$/m);
    expect(brief).toMatch(/^GigabitEthernet0\/0\s+\S+\s+up\s+up$/m);
  });

  it('show interfaces of a shut port says "admin down" exactly once', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(serialPair());
    sim.runFor(60 * SEC);
    typed(sim, 'r1', ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    const [out] = typed(sim, 'r1', ['show interfaces GigabitEthernet0/0']);
    expect(out!.split('\n')[0]).toBe('GigabitEthernet0/0: admin down, link down');
  });
});

describe('show wireless on a station', () => {
  const failing = (mutate: (cfg: string) => string): string => {
    const t = homeWifi();
    const lap = t.devices.find((d) => d.id === 'laptop1')!;
    lap.config = mutate(lap.config!);
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(t);
    sim.runFor(90 * SEC);
    return typed(sim, 'laptop1', ['show wireless'])[0]!;
  };

  it('names the rejected passphrase and the security mismatch', () => {
    const wrongKey = failing((c) => c.replace(/ passphrase [^\n]*\n/, ' passphrase wrong-pass-123\n'));
    const mismatch = failing((c) => c.replace(/ security wpa2-psk\n passphrase [^\n]*\n/, ' security open\n'));
    expect(wrongKey).toMatch(/passphrase for "[^"]+" was rejected/);
    expect(mismatch).toMatch(/uses security wpa2-psk, but this station is set to open/);
    expect(wrongKey).not.toContain('Not associated.');
    expect(mismatch).not.toContain('Not associated.');
  });

  it('prints the joined BSS channel, marked as the network channel', () => {
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(homeWifi());
    sim.runFor(60 * SEC);
    expect(sim.configure('home1' as never, ['interface Wlan0', 'channel 11']).ok).toBe(true);
    sim.runFor(90 * SEC);
    expect(typed(sim, 'laptop1', ['show wireless'])[0]).toContain('channel 11 (network channel)');
  });
});

/** `show wireless` through the configure API (phones, towers and radios have no console of their own). */
const headlessShow = (sim: Sim, dev: string): string => {
  const d = sim.device(dev as never)!;
  const r = sim.configure(dev as never, ['show wireless'], d.model.cli?.grammar === 'nfos' ? { startMode: 'priv-exec' } : {});
  expect(r.ok).toBe(true);
  return r.lines[0]!.output;
};

describe('show wireless on cellular and point-to-point radios', () => {
  it('a phone shows the tower it is attached to with signal and rate; the tower counts its phones', () => {
    const sim = createSimulation({ seed: 6 });
    sim.loadTopology(cellularPhones());
    sim.runFor(60 * SEC);
    expect(headlessShow(sim, 'phone1')).toMatch(/Attach: attached to tower1 Cellular0, signal -?\d+ dBm, rate /);
    expect(headlessShow(sim, 'tower1')).toContain('Attached devices: 2');
  });

  it('a PtP radio shows its peer, signal, rate and range; a key mismatch shows no peer link', () => {
    const sim = createSimulation({ seed: 4 });
    sim.loadTopology(radioBridge());
    sim.runFor(60 * SEC);
    expect(headlessShow(sim, 'radio1')).toMatch(/Peer: radio2 Radio0, signal -?\d+ dBm, rate [^,]+, range \d+ m/);
    expect(sim.configure('radio2' as never, ['interface Radio0', ' peer-key another-key-9'], { indentation: true }).ok).toBe(true);
    sim.runFor(10 * SEC);
    expect(headlessShow(sim, 'radio1')).toContain('No peer link.');
  });
});

describe('host shell joins WPA3 networks', () => {
  it('wifi connect with a key writes security wpa3-sae for a WPA3 network and associates', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topology([
      device('ap1', 'ap.nfap-auto', 'AP1', 0, 0, configText([section('interface Wlan0', ['ssid Lab', 'security wpa3-sae', 'passphrase labpass123', 'no shutdown'])])),
      device('lap', 'laptop.nflaptop', 'LAP', 1, 0),
    ], []));
    sim.runFor(60 * SEC);
    const [out] = typed(sim, 'lap', ['wifi connect Lab key labpass123']);
    expect(out).toContain('WPA3 personal');
    sim.runFor(30 * SEC);
    expect(sim.device('lap' as never)!.running.render()).toContain('security wpa3-sae');
    expect(sim.snapshot().media!.associations.filter((a) => a.state === 'associated')).toHaveLength(1);
  });

  it('falls back to WPA2 personal when the network is not heard', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topology([device('lap', 'laptop.nflaptop', 'LAP', 1, 0)], []));
    sim.runFor(60 * SEC);
    expect(typed(sim, 'lap', ['wifi connect Nowhere key labpass123'])[0]).toContain('WPA2 personal');
    expect(sim.device('lap' as never)!.running.render()).toContain('security wpa2-psk');
  });
});

describe('configure start mode and start context', () => {
  function booted(): Sim {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' } as never);
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' } as never);
    sim.runFor(60 * SEC);
    return sim;
  }

  it('refuses a start mode the device grammar lacks, running nothing', () => {
    const sim = booted();
    const before = sim.device('pc1' as never)!.running.render();
    const r = sim.configure('pc1' as never, ['hostname X', 'ip address 10.0.0.1 255.255.255.0'], { startMode: 'config' });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.lines[0]!.error!.message).toBe('% Mode config is not available on this device.');
    expect(r.lines.every((l) => l.skipped === true && !l.ok)).toBe(true);
    expect(sim.device('pc1' as never)!.running.render()).toBe(before);
  });

  it('refuses a start context on a host, which has no configuration contexts', () => {
    const sim = booted();
    const r = sim.configure('pc1' as never, ['shutdown'], { startContext: [['interface', 'GigabitEthernet0']] });
    expect(r.ok).toBe(false);
    expect(sim.device('pc1' as never)!.port('GigabitEthernet0' as never)!.adminUp).toBe(true);
  });

  it('rolls back a virtual interface created by a start context whose next frame is refused', () => {
    const sim = booted();
    const r = sim.configure('r1' as never, ['shutdown'], { startContext: [['interface', 'Loopback3'], ['interface', 'Console']] });
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.error).toBeDefined();
    expect(sim.device('r1' as never)!.running.render()).not.toContain('Loopback3');
    expect(sim.device('r1' as never)!.port('Loopback3' as never)).toBeUndefined();
  });

  it('a valid start context on a new loopback creates it and applies the lines', () => {
    const sim = booted();
    const r = sim.configure('r1' as never, ['ip address 10.9.9.9 255.255.255.255'], { startContext: [['interface', 'Loopback3']] });
    expect(r).toMatchObject({ ok: true, finalMode: 'config-if' });
    expect(sim.device('r1' as never)!.running.render()).toMatch(/interface Loopback3\n ip address 10\.9\.9\.9 255\.255\.255\.255/);
  });
});
