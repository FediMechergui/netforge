/**
 * The P2 host-shell expansions of ARCHITECTURE-P2 §5.5 on the real runtime (`sim.configure`): `ipv6 address dhcp
 * [<adapter>]` (the IP configuration app's "automatic with DHCPv6" choice) stores the same `ipv6 address dhcp`
 * interface line a router does, and [S4] `voice vlan <v>` stores the phone's global line (hosts with a built-in
 * bridge only). Both `no` forms remove their line.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { readVoiceVlan } from '../src/protocols/l2/switchport-config.js';
import { createP2Simulation } from './p2.world.js';

const PC = 'GigabitEthernet0';

function world(): Simulation {
  const sim = createP2Simulation({ seed: 3, factories: {} });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'phone1', type: 'ipphone.nfphone', name: 'PHONE1' });
  sim.runFor(60 * SEC);
  return sim;
}

/** The lines of one interface section of the running-config text (`show running-config`), trimmed. */
function ifaceLines(sim: Simulation, device: string, port: string): string[] {
  const s = sim.cli.open(device, 'console');
  const text = sim.cli.exec(s, 'show running-config').output ?? '';
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    if (raw === `interface ${port}`) { inside = true; continue; }
    if (!raw.startsWith(' ')) inside = false;
    if (inside) out.push(raw.trim());
  }
  return out;
}

describe('ipv6 address dhcp [<adapter>] (§5.5)', () => {
  it('stores `ipv6 enable` and `ipv6 address dhcp` under the adapter; `no` removes the dhcp line; a bad adapter is refused', () => {
    const sim = world();
    const on = sim.configure('pc1', ['ipv6 address dhcp']);
    expect(on.ok).toBe(true);
    expect(on.lines[0]!.output).toContain(PC);
    expect(ifaceLines(sim, 'pc1', PC)).toContain('ipv6 address dhcp');
    expect(ifaceLines(sim, 'pc1', PC)).toContain('ipv6 enable');
    const off = sim.configure('pc1', ['no ipv6 address dhcp']);
    expect(off.ok).toBe(true);
    expect(ifaceLines(sim, 'pc1', PC)).not.toContain('ipv6 address dhcp');
    expect(sim.configure('pc1', [`ipv6 address dhcp ${PC}`]).ok).toBe(true);
    expect(ifaceLines(sim, 'pc1', PC)).toContain('ipv6 address dhcp');
    expect(sim.configure('pc1', [`no ipv6 address dhcp ${PC}`]).ok).toBe(true);
    expect(ifaceLines(sim, 'pc1', PC)).not.toContain('ipv6 address dhcp');
    expect(sim.configure('pc1', ['ipv6 address dhcp Nope9']).ok).toBe(false);
    // the `<prefix>` form still works beside the keyword
    expect(sim.configure('pc1', ['ipv6 address 2001:db8::5/64']).ok).toBe(true);
    expect(ifaceLines(sim, 'pc1', PC)).toContain('ipv6 address 2001:db8::5/64');
  });
});

describe('[S4] voice vlan <v> (§5.5)', () => {
  it('stores the global line on the phone, refuses a bad number, is unknown to a plain host; `no voice vlan` removes it', () => {
    const sim = world();
    expect(sim.configure('phone1', ['voice vlan 150']).ok).toBe(true);
    expect(readVoiceVlan(sim.device('phone1')!.running)).toBe(150);
    expect(sim.configure('phone1', ['voice vlan 4095']).ok).toBe(false);
    expect(readVoiceVlan(sim.device('phone1')!.running)).toBe(150);
    expect(sim.configure('phone1', ['no voice vlan']).ok).toBe(true);
    expect(readVoiceVlan(sim.device('phone1')!.running)).toBeUndefined();
    expect(sim.configure('pc1', ['voice vlan 150']).ok).toBe(false);
    expect(readVoiceVlan(sim.device('pc1')!.running)).toBeUndefined();
  });
});
