/**
 * W2 device + media (ARCHITECTURE-P2 §2.7 `PduSummary.vlan`, §3.2 step 2): every PDU summary of a tagged frame
 * carries the outermost 802.1Q VID — the `frameTx` summaries the media write (link/media/p2p.ts `summarizePdu`) and
 * the `frameRx` / drop summaries the device writes (device/process-ctx.ts `pduSummary`) — and no summary of an
 * untagged frame carries the key, so every P0/P1 trace keeps its bytes. On `test/p2.world.ts` (§0 rule 13) with the
 * real VLAN daemon in the P1 profile (no spanning tree), two managed switches joined by a static trunk.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createVlan } from '../src/protocols/vlan.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createP2Simulation } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const TRUNK = 'GigabitEthernet0/1';
const ACCESS = 'FastEthernet0/1';

const switchConfig = (hostname: string): string =>
  configText([
    [`hostname ${hostname}`],
    ['vlan 10'],
    section(`interface ${ACCESS}`, ['switchport mode access', 'switchport access vlan 10']),
    section(`interface ${TRUNK}`, ['switchport mode trunk']),
  ]);

/** Every summary-carrying event: the media frameTx, the device frameRx / pduCreated / pduConsumed, drops. */
function summaries(evs: readonly TraceEvent[], where: (e: TraceEvent) => boolean) {
  return evs.filter((e) => where(e) && 'pdu' in e && typeof e.pdu === 'object').map((e) => (e as { pdu: { vlan?: number } }).pdu);
}

describe('PduSummary.vlan (§2.7)', () => {
  it('frames on a trunk carry vlan = their VID on frameTx and frameRx; frames on access ports carry no vlan key', () => {
    // the vlan daemon only (dtp removed since the W4 flip registered it: §9.2 W4 fixture pins)
    const sim = createP2Simulation({ seed: 21, profile: 'P1', factories: { vlan: createVlan, dtp: undefined } });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: switchConfig('SW1') });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: ACCESS } });
    sim.addLink({ a: { device: 'sw1', port: TRUNK }, b: { device: 'sw2', port: TRUNK } });
    sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: ACCESS } });
    sim.runFor(60 * SEC);
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');

    const trunkTx = ofKind(p.evs, 'frameTx').filter((e) => e.from.port === TRUNK);
    expect(trunkTx.length).toBeGreaterThanOrEqual(10);
    expect(trunkTx.map((e) => e.pdu.vlan)).toEqual(trunkTx.map(() => 10));
    const trunkRx = ofKind(p.evs, 'frameRx').filter((e) => e.port === TRUNK);
    expect(trunkRx.length).toBe(trunkTx.length);
    expect(trunkRx.map((e) => e.pdu.vlan)).toEqual(trunkRx.map(() => 10));
    // the tag is pushed on the way out of the trunk and popped on the way in, so the PCs never see it
    const pcSide = summaries(p.evs, (e) => (e.kind === 'frameTx' && e.from.device.startsWith('pc')) || (e.kind === 'frameRx' && e.device.startsWith('pc')));
    expect(pcSide.length).toBeGreaterThanOrEqual(10);
    expect(pcSide.every((s) => !('vlan' in s))).toBe(true);
    const accessRx = summaries(p.evs, (e) => e.kind === 'frameRx' && e.port === ACCESS);
    expect(accessRx.every((s) => !('vlan' in s))).toBe(true);
  });

  it('the P1 two-pcs-and-switch scenario carries no vlan key in any summary', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(40 * SEC);
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const all = summaries(sim.trace(0).events, () => true);
    expect(all.length).toBeGreaterThan(20);
    expect(all.every((s) => !('vlan' in s))).toBe(true);
  });
});
