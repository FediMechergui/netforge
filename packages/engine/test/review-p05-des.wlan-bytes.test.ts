/**
 * review-p05 (des lens): a Wi-Fi port counts its sent frames at their 802.11 size (device.ts reads `pdu.size` after
 * `deps.transmit`, and the air medium rewraps the frame in place) but its received frames at their Ethernet size.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { homeWifi } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

describe('review-p05-des wlan byte counters', () => {
  it('a symmetric ping over Wi-Fi counts the same bytes out as in on the laptop Wlan0', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(homeWifi());
    sim.runFor(60 * SEC);
    const counters = () => sim.device('laptop1')!.port('Wlan0')!.counters;
    const out0 = counters().outBytes;
    const in0 = counters().inBytes;
    const s = sim.cli.open('laptop1', 'console');
    sim.cli.exec(s, 'ping 192.168.1.10');
    sim.runToIdle();
    // ARP request/reply are 64 bytes each way; echo request and reply have equal sizes.
    const outDelta = counters().outBytes - out0;
    const inDelta = counters().inBytes - in0;
    expect(outDelta).toBeGreaterThan(0);
    expect(outDelta).toBe(inDelta);
  });
});
