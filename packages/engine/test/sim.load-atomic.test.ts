/**
 * sim — atomic topology load and 1.1 export (ARCHITECTURE-P1 D11, D12, §3.14): TopologyLoadError before the world is
 * replaced, 1.0 and 1.1 documents, retained canvas/objectives/notes/lab, link kind / dce_end / distance_m, device ui,
 * rounded positions, topologyVersion accounting.
 */
import { describe, expect, it } from 'vitest';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, TOPOLOGY_SCHEMA_ID_1_0, type Topology } from '../src/contracts/topology.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

function loaded() {
  const sim = createSimulation({ seed: 11 });
  sim.loadTopology(twoPcsAndSwitch());
  sim.runFor(40 * SEC);
  const session = sim.cli.open('pc1', 'console');
  return { sim, session };
}

function loadError(fn: () => void): TopologyLoadError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TopologyLoadError);
    return e as TopologyLoadError;
  }
  throw new Error('expected a TopologyLoadError');
}

describe('sim: atomic loadTopology', () => {
  const broken: [string, (t: Topology) => void, { device?: string; link?: string }][] = [
    ['an unknown device type', (t) => (t.devices[1]!.type = 'switch.nf-imaginary'), { device: 'sw1' }],
    ['an unknown port name', (t) => (t.links[0]!.b.port = 'FastEthernet9/99'), { link: 'l_pc1_sw1' }],
    ['a module that does not fit', (t) => t.devices.push({ id: 'r9', type: 'router.nf1941', name: 'R9', position: { logical: [1, 1] }, modules: [{ slot: '0/0', module: 'mod.nim-2t' }] }), { device: 'r9' }],
    ['a schema violation', (t) => ((t.devices[0] as { name: unknown }).name = 42), { device: 'pc1' }],
  ];
  for (const [what, breakIt, where] of broken) {
    it(`throws a TopologyLoadError for ${what} and leaves the world untouched`, () => {
      const { sim, session } = loaded();
      const before = JSON.stringify(sim.snapshot());
      const nowBefore = sim.now;
      const topo = twoPcsAndSwitch();
      breakIt(topo);
      const err = loadError(() => sim.loadTopology(topo));
      expect(err.problems.length).toBeGreaterThan(0);
      expect(err.problems[0]).toMatchObject(where);
      expect(sim.now).toBe(nowBefore);
      expect(JSON.stringify(sim.snapshot())).toBe(before);
      expect(sim.cli.session(session)).toBeDefined();
      expect(sim.cli.exec(session, 'ping 10.0.0.2').error).toBeUndefined();
    });
  }

  it('loads a 1.0 document, ignoring 1.1 sections, and exports 1.1', () => {
    const topo = { ...twoPcsAndSwitch(), schema: TOPOLOGY_SCHEMA_ID_1_0, canvas: { metresPerUnit: 3 } } as Topology;
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topo);
    const out = sim.exportTopology();
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID);
    expect(out).not.toHaveProperty('canvas');
    expect(out.objectives).toEqual(twoPcsAndSwitch().objectives);
    expect(out.notes).toBe(twoPcsAndSwitch().notes);
  });

  it('round-trips the 1.1 sections, fills link kinds and rounds positions', () => {
    const topo: Topology = {
      schema: TOPOLOGY_SCHEMA_ID,
      seed: 1,
      devices: [
        { id: 'r1', type: 'router.nf2911', name: 'R1', position: { logical: [10.4, 20.6] }, ui: { note: 'core', desktop: { pinnedApps: ['ip-config'] } } },
        { id: 'r2', type: 'router.nf2911', name: 'R2', position: { logical: [-0.4, 2.5] } },
        { id: 'b1', type: 'radio.nfptp5', name: 'B1', position: { logical: [0, 0] } },
        { id: 'b2', type: 'radio.nfptp5', name: 'B2', position: { logical: [400, 0] } },
      ],
      links: [
        { id: 'ser', a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce', length_m: 3, dce_end: 'b' },
        { id: 'air', a: { device: 'b1', port: 'Radio0' }, b: { device: 'b2', port: 'Radio0' }, media: 'auto', length_m: 3, distance_m: 900 },
      ],
      objectives: ['bring the serial line up'],
      notes: 'retained verbatim',
      canvas: { metresPerUnit: 0.5 },
      lab: { name: 'serial-basics', version: 2 },
    };
    const sim = createSimulation({ seed: 1 });
    const v0 = sim.snapshot().topologyVersion;
    sim.loadTopology(topo);
    expect(sim.snapshot().topologyVersion).toBe(v0 + 1 + topo.devices.length + topo.links.length);
    expect(sim.device('r1')!.spec.position).toEqual({ x: 10, y: 21 });
    expect(sim.device('r2')!.spec.position).toEqual({ x: 0, y: 3 });
    expect(Object.is(sim.device('r2')!.spec.position.x, -0)).toBe(false);
    expect(sim.link('ser')).toMatchObject({ kind: 'cable', dceEnd: 'b' });
    expect(sim.link('air')).toMatchObject({ kind: 'radio', distanceOverrideM: 900 });
    expect(sim.snapshot().media?.metresPerUnit).toBe(0.5);
    expect(sim.snapshot().devices[0]!.ui).toEqual({ note: 'core', desktop: { pinnedApps: ['ip-config'] } });

    const out = sim.exportTopology();
    expect(out.canvas).toEqual({ metresPerUnit: 0.5 });
    expect(out.lab).toEqual({ name: 'serial-basics', version: 2 });
    expect(out.objectives).toEqual(['bring the serial line up']);
    expect(out.notes).toBe('retained verbatim');
    expect(out.devices[0]).toMatchObject({ position: { logical: [10, 21] }, ui: { note: 'core' } });
    expect(out.links[0]).toMatchObject({ id: 'ser', dce_end: 'b' });
    expect(out.links[0]).not.toHaveProperty('kind');
    expect(out.links[1]).toMatchObject({ id: 'air', kind: 'radio', distance_m: 900 });

    const again = createSimulation({ seed: 1 });
    again.loadTopology(out);
    expect(JSON.stringify(again.exportTopology())).toBe(JSON.stringify(out));
  });

  it('rounds positions on addDevice and moveDevice, and validates GUI state', () => {
    const sim = createSimulation({ seed: 1 });
    const id = sim.addDevice({ type: 'pc.nfpc', position: { x: 1.5, y: -2.5 } });
    expect(sim.device(id)!.spec.position).toEqual({ x: 2, y: -2 });
    sim.moveDevice(id, { x: 7.49, y: 8.51 });
    expect(sim.device(id)!.spec.position).toEqual({ x: 7, y: 9 });
    expect(() => sim.moveDevice(id, { x: Number.NaN, y: 0 })).toThrow(RangeError);

    const cursor = sim.trace(0).next;
    const v = sim.snapshot().topologyVersion;
    sim.setDeviceUi(id, { note: 'desk 4' });
    expect(sim.exportTopology().devices[0]!.ui).toEqual({ note: 'desk 4' });
    expect(sim.trace(cursor).events).toEqual([]);
    expect(sim.snapshot().topologyVersion).toBe(v);
    expect(() => sim.setDeviceUi(id, { desktop: { browserHistory: new Array(40).fill('x') } })).toThrow(/ui/);
    expect(() => sim.setDeviceUi('ghost', {})).toThrow(/No device/);
  });
});
