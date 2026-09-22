/**
 * sim [S1] — the input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 step 1; §7 W2 sim [S1]): every outermost mutating
 * facade call is recorded at its position with a deep copy of its op and the trace head after it; nothing nested or
 * dispatched records; `loadTopology` starts a new journal whose origin holds the counters from before the load;
 * `resume` starts the facade counters; `journal: false` records nothing; `pduRegistryLimit` bounds the registry.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEntry, JournalOp } from '../src/contracts/journal.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { comparePositions, createJournalRecorder, isJournalPosition } from '../src/sim/journal.js';
import { ZERO_FACADE_COUNTERS, checkedFacadeCounters, createSimulation } from '../src/sim/simulation.js';

const ops = (sim: Simulation): JournalOp['op'][] => sim.journal().entries.map((e) => e.op.op);
const last = (sim: Simulation): JournalEntry => {
  const entries = sim.journal().entries;
  const e = entries[entries.length - 1];
  if (e === undefined) throw new Error('the journal is empty');
  return e;
};
const head = (sim: Simulation): number => sim.trace(Number.MAX_SAFE_INTEGER).next;

describe('the journal recorder', () => {
  it('orders positions by event count, then by time', () => {
    expect(comparePositions({ dispatched: 1, now: 5 }, { dispatched: 2, now: 0 })).toBeLessThan(0);
    expect(comparePositions({ dispatched: 2, now: 0 }, { dispatched: 1, now: 5 })).toBeGreaterThan(0);
    expect(comparePositions({ dispatched: 2, now: 3 }, { dispatched: 2, now: 4 })).toBeLessThan(0);
    expect(comparePositions({ dispatched: 2, now: 4 }, { dispatched: 2, now: 4 })).toBe(0);
    expect(isJournalPosition({ dispatched: 0, now: 0 })).toBe(true);
    expect(isJournalPosition({ dispatched: -1, now: 0 })).toBe(false);
    expect(isJournalPosition({ dispatched: 1.5, now: 0 })).toBe(false);
    expect(isJournalPosition(null)).toBe(false);
  });

  it('records only the outermost call, copies the op before the call, and marks a call that threw', () => {
    let position = { dispatched: 3, now: 40 };
    let traceHead = 10;
    const origin = { seed: 1, mode: 'simulation' as const, profile: 'P1' as const, topology: null, counters: ZERO_FACADE_COUNTERS };
    const rec = createJournalRecorder({ position: () => position, traceHead: () => traceHead }, origin);
    const spec = { type: 'pc.nfpc', name: 'A' };
    const result = rec.apply({ op: 'addDevice', spec }, () => {
      traceHead = 12;
      // a nested facade call while the outer one runs
      rec.apply({ op: 'removeDevice', id: 'x' }, () => 'inner');
      expect(rec.depth).toBe(1);
      return 'outer';
    });
    expect(result).toBe('outer');
    spec.name = 'changed after the call';
    position = { dispatched: 9, now: 99 };
    expect(rec.journal()).toEqual({
      version: 1,
      origin,
      entries: [{ at: { dispatched: 3, now: 40 }, op: { op: 'addDevice', spec: { type: 'pc.nfpc', name: 'A' } }, traceHead: 12 }],
    });
    expect(() =>
      rec.apply({ op: 'removeLink', id: 'l9' }, () => {
        throw new Error('no such link');
      }),
    ).toThrow('no such link');
    expect(rec.journal().entries[1]).toEqual({ at: { dispatched: 9, now: 99 }, op: { op: 'removeLink', id: 'l9' }, traceHead: 12, threw: true });
    expect(rec.depth).toBe(0);
    expect(rec.nested(() => rec.depth)).toBe(1);
    // the copy handed out is not the recorder's own
    const copy = rec.journal();
    (copy.entries as JournalEntry[]).length = 0;
    expect(rec.journal().entries).toHaveLength(2);
    expect(rec.length).toBe(2);
    rec.reset({ ...origin, seed: 2 });
    expect(rec.journal()).toEqual({ version: 1, origin: { ...origin, seed: 2 }, entries: [] });
    expect(rec.origin().seed).toBe(2);
  });

  it('records nothing when disabled but keeps the origin', () => {
    const origin = { seed: 1, mode: 'simulation' as const, profile: 'P1' as const, topology: null, counters: ZERO_FACADE_COUNTERS };
    const rec = createJournalRecorder({ position: () => ({ dispatched: 0, now: 0 }), traceHead: () => 0 }, origin, false);
    expect(rec.enabled).toBe(false);
    expect(rec.apply({ op: 'removeDevice', id: 'x' }, () => 7)).toBe(7);
    expect(rec.journal()).toEqual({ version: 1, origin, entries: [] });
  });
});

describe('Simulation.journal() and position()', () => {
  it('starts empty at the origin of a world built from nothing', () => {
    const sim = createSimulation({ seed: 5 });
    expect(sim.position()).toEqual({ dispatched: 0, now: 0 });
    expect(sim.journal()).toEqual({
      version: 1,
      origin: { seed: 5, mode: 'simulation', profile: 'P1', topology: null, counters: ZERO_FACADE_COUNTERS },
      entries: [],
    });
    const p2 = createSimulation({ seed: 5, profile: 'P2', mode: 'turbo' });
    expect(p2.journal().origin).toEqual({ seed: 5, mode: 'turbo', profile: 'P2', topology: null, counters: ZERO_FACADE_COUNTERS });
  });

  it('records each mutating call at the position before it, with a deep copy of its op and the head after it', () => {
    const sim = createSimulation({ seed: 5 });
    const spec = { type: 'pc.nfpc', name: 'PC1', position: { x: 1.4, y: 2 } };
    const pc1 = sim.addDevice(spec);
    spec.name = 'mutated';
    expect(sim.journal().entries).toEqual([{ at: { dispatched: 0, now: 0 }, op: { op: 'addDevice', spec: { type: 'pc.nfpc', name: 'PC1', position: { x: 1.4, y: 2 } } }, traceHead: head(sim) }]);
    const pc2 = sim.addDevice({ type: 'pc.nfpc', name: 'PC2' });
    const link = sim.addLink({ a: { device: pc1, port: 'gi0' }, b: { device: pc2, port: 'GigabitEthernet0' } });
    sim.runFor(10 * SEC);
    const at = sim.position();
    expect(at.now).toBe(10 * SEC);
    expect(at.dispatched).toBeGreaterThan(0);
    sim.moveDevice(pc1, { x: 5, y: 6 });
    expect(last(sim)).toEqual({ at, op: { op: 'moveDevice', id: pc1, position: { x: 5, y: 6 } }, traceHead: head(sim) });
    sim.setImpairments(link, { lossPct: 10 });
    sim.injectFault(at.now + SEC, { id: 'f1', kind: 'cable-cut', target: { link } });
    sim.configure(pc1, ['ip address 10.0.0.1 255.255.255.0']);
    sim.configure(pc2, ['ip address 10.0.0.2 255.255.255.0'], { stopOnError: false });
    sim.setDeviceUi(pc1, { notes: 'hi' } as never);
    sim.setCanvasScale(2);
    sim.renameDevice(pc2, 'Beta');
    sim.setPower(pc2, false);
    sim.setPower(pc2, true);
    const s = sim.cli.open(pc1, 'console');
    sim.cli.exec(s, 'show ip');
    sim.cli.interrupt(s);
    sim.cli.close(s);
    sim.removeLink(link);
    sim.removeDevice(pc2);
    expect(ops(sim)).toEqual([
      'addDevice',
      'addDevice',
      'addLink',
      'moveDevice',
      'setImpairments',
      'injectFault',
      'configure',
      'configure',
      'setDeviceUi',
      'setCanvasScale',
      'renameDevice',
      'setPower',
      'setPower',
      'cliOpen',
      'cliExec',
      'cliInterrupt',
      'cliClose',
      'removeLink',
      'removeDevice',
    ]);
    const entries = sim.journal().entries;
    expect(entries[6]!.op).toEqual({ op: 'configure', device: pc1, commands: ['ip address 10.0.0.1 255.255.255.0'] });
    expect(entries[7]!.op).toEqual({ op: 'configure', device: pc2, commands: ['ip address 10.0.0.2 255.255.255.0'], opts: { stopOnError: false } });
    expect(entries[13]!.op).toEqual({ op: 'cliOpen', device: pc1, via: 'console' });
    expect(entries[14]!.op).toEqual({ op: 'cliExec', session: s, line: 'show ip' });
    // positions never go backwards, and each entry's head is at most the next one's
    for (let i = 1; i < entries.length; i++) {
      expect(comparePositions(entries[i - 1]!.at, entries[i]!.at)).toBeLessThanOrEqual(0);
      expect(entries[i - 1]!.traceHead).toBeLessThanOrEqual(entries[i]!.traceHead);
    }
    expect(entries[entries.length - 1]!.traceHead).toBe(head(sim));
    // every entry is structured-clone data
    expect(() => structuredClone(sim.journal())).not.toThrow();
  });

  it('records a call that threw with `threw: true` and rethrows it', () => {
    const sim = createSimulation({ seed: 5 });
    expect(() => sim.addDevice({ type: 'no-such-model' })).toThrow('Unknown device type');
    expect(() => sim.removeLink('l_nope')).toThrow();
    expect(sim.journal().entries).toEqual([
      { at: { dispatched: 0, now: 0 }, op: { op: 'addDevice', spec: { type: 'no-such-model' } }, traceHead: 0, threw: true },
      { at: { dispatched: 0, now: 0 }, op: { op: 'removeLink', id: 'l_nope' }, traceHead: 0, threw: true },
    ]);
  });

  it('never records what a facade call or a dispatch does inside: sessions closed, links removed, fragments, ticks', () => {
    const sim = createSimulation({ seed: 5 });
    sim.loadTopology(pcRouterPc());
    sim.runFor(60 * SEC);
    const s = sim.cli.open('pc1', 'console');
    // a job: the ping runs inside dispatches, none of which records
    sim.cli.exec(s, 'ping 10.0.1.1');
    sim.runToIdle();
    // a config-fragment fault runs `configure` during a dispatch: not an entry
    sim.injectFault(sim.now + SEC, { id: 'frag', kind: 'config-fragment', target: { device: 'r1' }, params: { lines: ['hostname Frag'] } });
    sim.runFor(2 * SEC);
    expect(sim.device('r1')!.hostname).toBe('Frag');
    // removing a device closes its session and removes its links inside the one call
    sim.removeDevice('pc1');
    expect(sim.cli.session(s)).toBeUndefined();
    // `sim.configure` goes through the CLI wrapper: one entry, not two
    sim.configure('r1', ['hostname R1']);
    expect(ops(sim)).toEqual(['cliOpen', 'cliExec', 'injectFault', 'removeDevice', 'configure']);
    // a direct CLI-wrapper configure is an entry of its own
    sim.cli.configure('r1', ['hostname R1b']);
    expect(ops(sim).at(-1)).toBe('configure');
  });

  it('loadTopology starts a new journal whose origin holds the document and the counters from BEFORE the load', () => {
    const sim = createSimulation({ seed: 3 });
    const pc = sim.addDevice({ type: 'pc.nfpc' });
    sim.runFor(20 * SEC);
    sim.hostRequest(pc, { app: 'dhcp.renew', port: 'GigabitEthernet0' });
    const before = { traceHead: head(sim), topologyVersion: sim.snapshot().topologyVersion };
    const topo = twoPcsAndSwitch();
    sim.loadTopology(topo);
    const j = sim.journal();
    expect(j.entries).toEqual([]);
    expect(j.origin.seed).toBe(3);
    expect(j.origin.profile).toBe('P1');
    expect(j.origin.topology).toEqual(topo);
    expect(j.origin.topology).not.toBe(topo);
    expect(j.origin.counters).toEqual({ traceHead: before.traceHead, sessions: 0, headless: 0, requests: 1, topologyVersion: before.topologyVersion });
    expect(head(sim)).toBeGreaterThan(before.traceHead);
    expect(sim.position()).toEqual({ dispatched: 0, now: 0 });
    // a failed load leaves the journal alone
    sim.addDevice({ type: 'pc.nfpc' });
    const kept = sim.journal();
    expect(() => sim.loadTopology({ ...topo, devices: [{ ...topo.devices[0]!, type: 'nope' }] })).toThrow();
    expect(sim.journal()).toEqual(kept);
  });

  it('carries the profile of a loaded P2 document in the origin', () => {
    const sim = createSimulation({ seed: 3 });
    const topo = { ...twoPcsAndSwitch(), schema: 'netforge.topology/1.2' as const, profile: 'P2' as const };
    sim.loadTopology(topo);
    expect(sim.profile).toBe('P2');
    expect(sim.journal().origin.profile).toBe('P2');
    expect(sim.journal().origin.topology?.profile).toBe('P2');
  });

  it('journal: false records no entry; reads never record', () => {
    const sim = createSimulation({ seed: 3, journal: false });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(40 * SEC);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runToIdle();
    expect(sim.journal().entries).toEqual([]);
    expect(sim.journal().origin.topology).toEqual(twoPcsAndSwitch());
    expect(sim.position().dispatched).toBeGreaterThan(0);

    const live = createSimulation({ seed: 3 });
    live.loadTopology(twoPcsAndSwitch());
    live.runFor(40 * SEC);
    live.snapshot();
    live.snapshot({ devices: ['pc1'] });
    live.trace(0);
    live.traceQuery({ from: 0, limit: 5 });
    live.pdu(1);
    live.validateLink({ a: { device: 'pc1', port: 'gi0' }, b: { device: 'sw1', port: 'fa0/9' } });
    live.nextEventTime();
    live.cli.canOpen('pc1', 'console');
    live.exportTopology();
    live.captures();
    live.position();
    expect(live.journal().entries).toEqual([]);
  });

  it('resume starts the facade counters: the ring, the topology version and the request tickets', () => {
    const counters = { traceHead: 100, sessions: 2, headless: 1, requests: 3, topologyVersion: 5 };
    const sim = createSimulation({ seed: 3, resume: counters });
    expect(sim.journal().origin.counters).toEqual(counters);
    expect(sim.trace(0)).toEqual({ events: [], next: 100, dropped: 100 });
    expect(sim.snapshot().topologyVersion).toBe(5);
    const pc = sim.addDevice({ type: 'pc.nfpc' });
    expect(sim.snapshot().topologyVersion).toBe(6);
    const emitted = sim.trace(0).events.length;
    expect(emitted).toBeGreaterThan(0);
    expect(sim.trace(0).next).toBe(100 + emitted);
    expect(sim.traceQuery({ from: 0, limit: 10 }).events.map((e) => e.cursor)).toEqual(Array.from({ length: emitted }, (_, i) => 100 + i));
    sim.runFor(20 * SEC);
    expect(sim.hostRequest(pc, { app: 'dhcp.renew', port: 'GigabitEthernet0' }).requestId).toBe('r_4');
    expect(sim.journal().origin.counters).toEqual(counters);
    // the counts move with the facade
    const headBeforeLoad = sim.trace(0).next;
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.journal().origin.counters).toEqual({ traceHead: headBeforeLoad, sessions: 2, headless: 1, requests: 4, topologyVersion: 6 });
    sim.runFor(40 * SEC);
    sim.cli.open('pc1', 'console');
    sim.configure('pc1', ['hostname X']);
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.journal().origin.counters.sessions).toBe(3);
    expect(sim.journal().origin.counters.headless).toBe(2);
    expect(() => createSimulation({ seed: 3, resume: { ...counters, traceHead: -1 } })).toThrow(RangeError);
    expect(() => createSimulation({ seed: 3, resume: { ...counters, sessions: 1.5 } })).toThrow(RangeError);
    expect(checkedFacadeCounters(counters)).toEqual(counters);
  });

  it('pduRegistryLimit bounds the id → PDU registry', () => {
    const sim = createSimulation({ seed: 3, pduRegistryLimit: 3 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(40 * SEC);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runToIdle();
    const count = sim.snapshot().pduCount;
    expect(count).toBeGreaterThan(3);
    expect(sim.pdu(1)).toBeUndefined();
    expect(sim.pdu(count)).toBeDefined();
    expect(sim.pdu(count - 2)).toBeDefined();
    expect(sim.pdu(count - 3)).toBeUndefined();
    expect(() => createSimulation({ seed: 3, pduRegistryLimit: -1 })).toThrow(RangeError);
  });
});
