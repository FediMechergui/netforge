/**
 * sim — module insert and remove through the facade (ARCHITECTURE-P1 D7, §3.11): refusal order and wording,
 * topologyChanged module events and topologyVersion, cabled module removal (link removed first), CLI sessions of
 * removed ports, snapshot slots and module port fields, and module persistence.
 */
import { describe, expect, it } from 'vitest';
import { HARDWARE_MESSAGES } from '../src/contracts/catalog.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind } from './sim.harness.js';

const R1941 = 'router.nf1941';

describe('sim: modules (D7)', () => {
  it('refuses on a powered device with the original wording, then inserts while powered off', () => {
    const sim = createSimulation({ seed: 2 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1' });
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({
      ok: false,
      code: 'powered-on',
      error: HARDWARE_MESSAGES['powered-on'].replace('{device}', 'R1'),
    });
    expect(() => sim.insertModule('nope', '0/0', 'mod.ehwic-2t')).toThrow(/No device/);

    sim.setPower('r1', false);
    const v0 = sim.snapshot().topologyVersion;
    const cursor = sim.trace(0).next;
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({ ok: true });
    const dev = sim.device('r1')!;
    const fixed = dev.model.ports.map((p) => p.name);
    expect([...dev.ports.keys()]).toEqual([...fixed, 'Serial0/0/0', 'Serial0/0/1']);
    expect(dev.port('Serial0/0/0')!.ordinal).toBe(128);
    expect(dev.port('Serial0/0/1')!.ordinal).toBe(129);
    expect(ofKind(sim.trace(cursor).events, 'topologyChanged')).toEqual([
      { t: sim.now, kind: 'topologyChanged', what: 'module', id: 'r1/0/0', op: 'add' },
    ]);
    expect(sim.snapshot().topologyVersion).toBe(v0 + 1);

    expect(sim.insertModule('r1', '0/1', 'mod.nim-2t')).toMatchObject({ ok: false, code: 'does-not-fit' });
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toMatchObject({ ok: false, code: 'slot-occupied' });
    expect(sim.insertModule('r1', '9/9', 'mod.ehwic-2t')).toMatchObject({ ok: false, code: 'no-such-slot' });
    expect(sim.snapshot().topologyVersion).toBe(v0 + 1);

    const snap = sim.snapshot().devices.find((d) => d.id === 'r1')!;
    expect(snap.slots).toEqual([
      { id: '0/0', label: 'Interface card slot 0', type: 'ehwic', accepts: ['ehwic'], module: 'mod.ehwic-2t' },
      { id: '0/1', label: 'Interface card slot 1', type: 'ehwic', accepts: ['ehwic'] },
    ]);
    const serial = snap.ports.find((p) => p.id === 'Serial0/0/0')!;
    expect(serial).toMatchObject({ role: 'wan', encap: 'hdlc', ordinal: 128, slot: '0/0', module: { slot: '0/0', module: 'mod.ehwic-2t' } });
    expect(snap.runningConfig).toContain('interface Serial0/0/0');
  });

  it('removes a cabled module: the link goes first, sessions in a removed port drop to config', () => {
    const sim = createSimulation({ seed: 4 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1', modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }] });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
    const link = sim.addLink({ a: { device: 'r1', port: 'Se0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce' });
    expect(sim.link(link)!.kind).toBe('cable');
    sim.runFor(120 * SEC);

    const session = sim.cli.open('r1', 'console');
    for (const line of ['enable', 'configure terminal', 'interface Serial0/0/0']) expect(sim.cli.exec(session, line).error).toBeUndefined();
    expect(sim.cli.session(session)!.mode).toBe('config-if');

    expect(sim.removeModule('r1', '0/0')).toMatchObject({ ok: false, code: 'powered-on' });
    expect(sim.removeModule('r1', '0/1')).toMatchObject({ ok: false, code: 'slot-empty' });
    expect(sim.link(link)).toBeDefined();

    sim.setPower('r1', false);
    const v0 = sim.snapshot().topologyVersion;
    const cursor = sim.trace(0).next;
    expect(sim.removeModule('r1', '0/0')).toEqual({ ok: true });
    const changes = ofKind(sim.trace(cursor).events, 'topologyChanged').map((e) => [e.what, e.id, e.op]);
    expect(changes).toEqual([
      ['link', link, 'remove'],
      ['module', 'r1/0/0', 'remove'],
    ]);
    expect(sim.snapshot().topologyVersion).toBe(v0 + 2);
    expect(sim.link(link)).toBeUndefined();
    expect(sim.device('r1')!.port('Serial0/0/0')).toBeUndefined();
    expect(sim.device('r2')!.port('Serial0/0/0')!.link).toBeUndefined();
    expect(sim.cli.session(session)!.mode).toBe('config');
    expect(sim.snapshot().devices.find((d) => d.id === 'r1')!.slots![0]).not.toHaveProperty('module');
  });

  it('persists modules: a round trip keeps them, [] is an empty chassis, absent applies the defaults', () => {
    const sim = createSimulation({ seed: 6 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1', modules: [{ slot: '0/1', module: 'mod.ehwic-4esg' }, { slot: '0/0', module: 'mod.ehwic-2t' }] });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
    expect(sim.device('r1')!.spec.modules).toEqual([{ slot: '0/0', module: 'mod.ehwic-2t' }, { slot: '0/1', module: 'mod.ehwic-4esg' }]);
    const exported = sim.exportTopology();
    expect(exported.devices[0]!.modules).toEqual([{ slot: '0/0', module: 'mod.ehwic-2t' }, { slot: '0/1', module: 'mod.ehwic-4esg' }]);
    expect(exported.devices[1]).not.toHaveProperty('modules');

    const again = createSimulation({ seed: 6 });
    again.loadTopology(exported);
    expect([...again.device('r1')!.ports.keys()]).toEqual([...sim.device('r1')!.ports.keys()]);
    expect(again.exportTopology()).toEqual(exported);

    const doc = (modules: Topology['devices'][number]['modules']): Topology => ({
      schema: TOPOLOGY_SCHEMA_ID,
      seed: 1,
      devices: [{ id: 'r9', type: R1941, name: 'R9', position: { logical: [0, 0] }, ...(modules !== undefined ? { modules } : {}) }],
      links: [],
    });
    const empty = createSimulation({ seed: 1 });
    empty.loadTopology(doc([]));
    expect(empty.device('r9')!.spec.modules).toEqual([]);
    expect(empty.exportTopology().devices[0]!.modules).toEqual([]);
    const defaults = createSimulation({ seed: 1 });
    defaults.loadTopology(doc(undefined));
    const expectedDefaults = (defaults.device('r9')!.model.slots ?? [])
      .filter((s) => s.defaultModule !== undefined)
      .map((s) => ({ slot: s.id, module: s.defaultModule }));
    expect(defaults.device('r9')!.spec.modules).toEqual(expectedDefaults);
  });

  it('validates module installs before a device exists', () => {
    const sim = createSimulation({ seed: 1 });
    expect(() => sim.addDevice({ id: 'r1', type: R1941, modules: [{ slot: '0/0', module: 'mod.nim-2t' }] })).toThrow(/does not fit/);
    expect(() => sim.addDevice({ id: 'r1', type: R1941, modules: [{ slot: '7/7', module: 'mod.ehwic-2t' }] })).toThrow(/has no slot/);
    expect(sim.devices()).toEqual([]);
    expect(sim.addDevice({ type: 'pc.nfpc' })).toBe('d_0001');
  });
});
