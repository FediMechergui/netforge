import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/sim/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { configText, device, section, topology } from './accept.p05.harness.js';

/** An AP whose Wlan0 runs `security <mode>`, and a laptop a few metres away with nothing configured. */
function lab(mode: 'wpa2-psk' | 'wpa3-sae') {
  const sim = createSimulation({ seed: 1 });
  sim.loadTopology(topology([
    device('ap1', 'ap.nfap-auto', 'AP1', 0, 0, configText([section('interface Wlan0', ['ssid Lab', `security ${mode}`, 'passphrase labpass123', 'no shutdown'])])),
    device('lap', 'laptop.nflaptop', 'LAP', 1, 0),
  ], []));
  sim.runFor(60 * SEC);
  const s = sim.cli.open('lap', 'console');
  sim.cli.exec(s, 'wifi connect Lab key labpass123');
  sim.runFor(30 * SEC);
  return { sim };
}

describe('review P0.5: host shell joins every security mode an AP can run', () => {
  it('control: a WPA2 network is joined from the host shell', () => {
    const { sim } = lab('wpa2-psk');
    expect(sim.snapshot().media!.associations.filter((a) => a.state === 'associated')).toHaveLength(1);
  });
  it('a WPA3 network is joined from the host shell (the Desktop Wi-Fi app uses the same line)', () => {
    const { sim } = lab('wpa3-sae');
    expect(sim.snapshot().media!.associations.filter((a) => a.state === 'associated')).toHaveLength(1);
  });
});
