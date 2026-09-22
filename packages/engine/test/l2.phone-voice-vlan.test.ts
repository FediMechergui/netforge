/**
 * [S4] The IP phone's voice VLAN on the real runtime (ARCHITECTURE-P2 §5.5 `voice vlan <v>`, §3.0 step 4 for the
 * access port's voice VLAN): the phone's OWN frames leave its network port tagged with the voice VLAN and its answers
 * arrive tagged and are handed to Vlan1 untagged, while the computer behind the pass-through port keeps its untagged
 * frames in the access VLAN. Without the line the phone is the P1 transparent bridge.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createVlan } from '../src/protocols/vlan.js';
import { createP2Simulation } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const UPLINK = 'FastEthernet0';
const PASS = 'FastEthernet1';

function world(voice: boolean) {
  const sim = createP2Simulation({ seed: 9, factories: { vlan: createVlan } });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'], ['vlan 10'], ['vlan 150'],
      section('interface FastEthernet0/1', ['switchport mode access', 'switchport access vlan 10', 'switchport voice vlan 150']),
      section('interface FastEthernet0/2', ['switchport mode access', 'switchport access vlan 150']),
      section('interface FastEthernet0/3', ['switchport mode access', 'switchport access vlan 10']),
    ]),
  });
  sim.addDevice({
    id: 'phone1', type: 'ipphone.nfphone', name: 'PHONE1',
    startupConfig: configText([['hostname PHONE1'], ...(voice ? [['voice vlan 150']] : []), section('interface Vlan1', ['ip address 10.0.150.2 255.255.255.0'])]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.10.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.10.2', '255.255.255.0') });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: pcConfig('SRV', '10.0.150.1', '255.255.255.0') });
  sim.addLink({ id: 'l_phone', a: { device: 'phone1', port: UPLINK }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'phone1', port: PASS } });
  sim.addLink({ id: 'l_srv', a: { device: 'srv', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  sim.runFor(60 * SEC);
  return sim;
}

/** `[src, vid | undefined]` of every frame the phone sent on its network port (the summary's VID at transmit time). */
function uplinkFrames(sim: ReturnType<typeof world>): [string, number | undefined][] {
  return ofKind(sim.trace(0).events, 'frameTx')
    .filter((e) => e.from.device === 'phone1' && e.from.port === UPLINK)
    .map((e) => [sim.pdu(e.pdu.id)!.layers[0]!.fields.src as string, e.pdu.vlan]);
}

describe('[S4] the phone tags its own frames with its voice VLAN', () => {
  it('the phone reaches a host in VLAN 150 with tagged frames; the PC behind it reaches VLAN 10 untagged', () => {
    const sim = world(true);
    const phoneMac = sim.device('phone1')!.port('Vlan1')!.mac;
    const pcMac = sim.device('pc1')!.port('GigabitEthernet0')!.mac;
    expect(ping(sim, 'phone1', '10.0.150.1').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(sim, 'pc1', '10.0.10.2').text).toContain('Sent 5, received 5, lost 0');
    const frames = uplinkFrames(sim);
    const own = frames.filter(([src]) => src === phoneMac);
    const pc = frames.filter(([src]) => src === pcMac);
    expect(own.length).toBeGreaterThan(0);
    expect(pc.length).toBeGreaterThan(0);
    expect(own.every(([, vid]) => vid === 150)).toBe(true);
    expect(pc.every(([, vid]) => vid === undefined)).toBe(true);
    // the tag the phone pushed is a provenance mutation with the line as its cause
    const tagged = ofKind(sim.trace(0).events, 'mutation').filter((e) => e.mutation.device === 'phone1' && e.mutation.cause === 'voice vlan 150');
    expect(tagged.length).toBeGreaterThan(0);
    // the phone learned the server on its network port and answers came in tagged: the SVI saw them untagged
    const consumed = ofKind(sim.trace(0).events, 'pduConsumed').filter((e) => e.device === 'phone1' && e.pdu.tag === 'echo-reply');
    expect(consumed).toHaveLength(5);
  });

  it('without the line the phone is in the access VLAN like the PC (the P1 transparent bridge)', () => {
    const sim = world(false);
    expect(ping(sim, 'phone1', '10.0.150.1').text).toContain('received 0');
    expect(ping(sim, 'pc1', '10.0.10.2').text).toContain('Sent 5, received 5, lost 0');
    expect(uplinkFrames(sim).every(([, vid]) => vid === undefined)).toBe(true);
  });
});
