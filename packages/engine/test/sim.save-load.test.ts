/**
 * Save / load: exportTopology → .netforge → readNetforge → loadTopology → ping still works.
 */
import { describe, expect, it } from 'vitest';
import { NETFORGE_FORMAT_VERSION } from '../src/contracts/topology.js';
import { readNetforge, writeNetforge } from '../src/io/netforge-file.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { BOOT_NS, console, ping } from './sim.harness.js';

describe('sim/save and load', () => {
  it('captures CLI-configured addresses and restores a working network', () => {
    const topo = twoPcsAndSwitch();
    for (const d of topo.devices) delete d.config;
    const src = createSimulation({ seed: 4 });
    src.loadTopology(topo);
    src.runFor(BOOT_NS);
    console(src, 'pc1', ['ip address 10.0.0.1 255.255.255.0']);
    console(src, 'pc2', ['ip address 10.0.0.2 255.255.255.0']);
    src.moveDevice('pc2', { x: 640, y: 480 });
    expect(ping(src, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');

    const exported = src.exportTopology();
    // Unsaved CLI changes are captured as running-config, never promoted to startup-config.
    expect(exported.devices.find((d) => d.id === 'pc1')!.runningConfig).toContain('ip address 10.0.0.1 255.255.255.0');
    expect(exported.devices.find((d) => d.id === 'pc1')!.config).toBeUndefined();
    const bytes = writeNetforge({
      manifest: { format: NETFORGE_FORMAT_VERSION, app: 'netforge/0.0.1', created: '2026-09-14T00:00:00.000Z', modified: '2026-09-14T00:00:00.000Z' },
      topology: exported,
      configs: {},
    });
    const project = readNetforge(bytes);

    const dst = createSimulation({ seed: 4 });
    dst.loadTopology(project.topology);
    expect(dst.devices().map((d) => d.id)).toEqual(['pc1', 'sw1', 'pc2']);
    expect(dst.device('pc2')!.spec.position).toEqual({ x: 640, y: 480 });
    expect(dst.snapshot().links.map((l) => l.id)).toEqual(['l_pc1_sw1', 'l_pc2_sw1']);
    dst.runFor(BOOT_NS);
    const snap = dst.snapshot();
    expect(snap.devices.every((d) => d.booted && !d.hasStartupConfig)).toBe(true);
    expect(dst.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toEqual({ address: '10.0.0.1', prefixLen: 24 });
    expect(ping(dst, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');

    // The restored running-config is RAM: a reload drops it (nothing was saved).
    dst.device('pc1')!.reload(dst.now);
    dst.runFor(BOOT_NS);
    expect(dst.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toBeUndefined();
  });
});
