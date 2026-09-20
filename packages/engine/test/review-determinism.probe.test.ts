/**
 * Review probes (determinism / DES mechanics lens).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rng } from '../src/contracts/rng.js';
import { ETHERTYPE_ARP, ARP_OP_REQUEST } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { emptyCounters, type PortState } from '../src/contracts/port.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel } from '../src/link/link.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';

const SEEDS = [1, 7, 42, 20260914, 2 ** 31 + 5];

function run(seed: number, scen: 'two' | 'prp', impair: boolean) {
  const sim = createSimulation({ seed });
  const atEmit: string[] = [];
  sim.onTrace((ev) => atEmit.push(JSON.stringify(ev)));
  sim.loadTopology(scen === 'two' ? twoPcsAndSwitch() : pcRouterPc());
  if (impair) {
    for (const l of sim.snapshot().links) sim.setImpairments(l.id, { lossPct: 20, corruptPct: 10, jitterNs: 50_000, latencyNs: 1234 });
  }
  sim.runFor(60 * SEC);
  const s = sim.cli.open('pc1', 'console');
  sim.cli.exec(s, scen === 'two' ? 'ping 10.0.0.2' : 'ping 10.0.1.1');
  const idle = sim.runToIdle(200_000);
  const evs = sim.trace(0).events;
  return { sim, evs, idle, atEmit, trace: JSON.stringify(evs), snap: JSON.stringify(sim.snapshot()) };
}

describe('review: determinism across seeds and impairments', () => {
  for (const scen of ['two', 'prp'] as const) {
    for (const impair of [false, true]) {
      it(`${scen} impair=${impair}: 2 runs identical for 5 seeds, integral times, idle terminates`, () => {
        const traces = new Set<string>();
        for (const seed of SEEDS) {
          const a = run(seed, scen, impair);
          const b = run(seed, scen, impair);
          expect(b.trace).toBe(a.trace);
          expect(b.snap).toBe(a.snap);
          expect(a.idle.events).toBeLessThan(200_000);
          traces.add(a.trace);
          for (const e of a.evs) {
            expect(Number.isInteger(e.t)).toBe(true);
            if (e.kind === 'frameTx') {
              expect(Number.isInteger(e.txStart) && Number.isInteger(e.txEnd) && Number.isInteger(e.arrive)).toBe(true);
            }
          }
        }
        if (impair) expect(traces.size).toBeGreaterThan(1);
      });
    }
  }

  it('trace events are not mutated after emission (no live references)', () => {
    const a = run(3, 'prp', true);
    const later = a.evs.map((e) => JSON.stringify(e));
    const diffs: string[] = [];
    for (let i = 0; i < later.length; i++) if (later[i] !== a.atEmit[i]) diffs.push(`${a.atEmit[i]}\n  => ${later[i]}`);
    expect(diffs.slice(0, 3)).toEqual([]);
  });

  it('snapshot and trace are structured-clone safe after a ping', () => {
    const a = run(9, 'prp', false);
    const snap = a.sim.snapshot();
    const c = structuredClone(snap);
    expect(JSON.stringify(c)).toBe(JSON.stringify(snap));
    const ce = structuredClone(a.evs);
    expect(JSON.stringify(ce)).toBe(JSON.stringify(a.evs));
  });
});

describe('review: link rng draw count per frame', () => {
  function counting(inner: Rng, box: { n: number }): Rng {
    return {
      nextU32: () => (box.n++, inner.nextU32()),
      nextFloat: () => (box.n++, inner.nextFloat()),
      nextInt: (lo, hi) => (box.n++, inner.nextInt(lo, hi)),
      chance: (p) => (box.n++, inner.chance(p)),
      split: (label) => counting(inner.split(label), box),
      state: () => inner.state(),
    };
  }
  function draws(corruptPct: number): number {
    const box = { n: 0 };
    const mk = (id: string, mac: string): PortState => ({
      id, spec: testPortSpec({ name: id, short: id, kind: 'ethernet', speedBps: 1e9, autoMdix: true }, ['host']), mac, adminUp: true, operUp: false,
      mtu: 1500, counters: emptyCounters(), l3: {}, tx: { busyUntil: 0, queue: 0 }, role: 'routed', ordinal: 1, encap: 'ethernet',
    });
    const ports = new Map<string, PortState>([['a', mk('p', '00:1f:00:00:00:01')], ['b', mk('p', '00:1f:00:00:00:02')]]);
    const model = createLinkModel({
      ...INERT_LINK_DEPS,
      scheduler: createScheduler(), trace: { emit: () => {} }, rng: counting(createRng(1), box),
      port: (r) => ports.get(r.device), deviceUp: () => true, hostTerminal: () => true,
    });
    model.add({ id: 'l', a: { device: 'a', port: 'p' }, b: { device: 'b', port: 'p' }, media: 'copper-straight', lengthM: 3,
      impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct } }, 0);
    const f = createPduFactory();
    box.n = 0;
    const pdu = f.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: '00:1f:00:00:00:01', type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: '00:1f:00:00:00:01', spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
    ], { born: 0, origin: 'a' });
    model.transmit({ device: 'a', port: 'p' }, pdu, 0);
    return box.n;
  }
  for (const how of ['cut', 'remove'] as const) {
    it(`a frame on the wire when the cable is ${how === 'cut' ? 'cut' : 'removed'} is not delivered as a port-admin-down rx`, () => {
      const sim = createSimulation({ seed: 5 });
      sim.loadTopology(twoPcsAndSwitch());
      sim.runFor(60 * SEC);
      const link = sim.snapshot().links.find((l) => l.a.device === 'pc2' || l.b.device === 'pc2')!;
      sim.setImpairments(link.id, { latencyNs: SEC });
      const s = sim.cli.open('pc1', 'console');
      sim.cli.exec(s, 'ping 10.0.0.2');
      const cursor = sim.trace(0).next;
      const inBefore = sim.snapshot().devices.find((d) => d.id === 'pc2')!.ports.find((p) => p.id === 'GigabitEthernet0')!.counters.inPackets;
      // let the ARP broadcast reach the switch and be flooded onto the slow link
      sim.runFor(1_000_000);
      const onWire = sim.snapshot().inflight.filter((f) => f.link === link.id).map((f) => f.pdu.id);
      expect(onWire.length).toBe(1);
      if (how === 'cut') sim.injectFault(sim.now, { id: 'f_cut', kind: 'cable-cut', target: { link: link.id } });
      else sim.removeLink(link.id);
      sim.runFor(3 * SEC);
      const evs = sim.trace(cursor).events;
      const bad = evs.filter((e) => e.kind === 'drop' && e.device === 'pc2' && e.reason === 'port-admin-down');
      const rx = evs.filter((e) => e.kind === 'frameRx' && e.device === 'pc2');
      const pc2 = sim.snapshot().devices.find((d) => d.id === 'pc2')!;
      expect({ bad: bad.length, rx: rx.length, inPackets: pc2.ports.find((p) => p.id === 'GigabitEthernet0')!.counters.inPackets - inBefore })
        .toEqual({ bad: 0, rx: 0, inPackets: 0 });
      const linkDown = evs.filter((e) => e.kind === 'drop' && e.link === link.id && e.reason === 'link-down');
      expect(linkDown.map((e) => (e as { pdu: { id: number } }).pdu.id)).toEqual(onWire);
      expect(sim.snapshot().inflight.filter((f) => f.link === link.id)).toEqual([]);
    });
  }

  it('a lost frame stays in flight until its arrive time (contract), then is pruned', () => {
    const sim = createSimulation({ seed: 5 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(60 * SEC);
    for (const l of sim.snapshot().links) sim.setImpairments(l.id, { lossPct: 100, latencyNs: SEC });
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runFor(1000);
    const lostIds = sim.trace(0).events.filter((e) => e.kind === 'drop' && e.reason === 'link-loss').map((e) => (e as { pdu: { id: number } }).pdu.id);
    expect(lostIds.length).toBeGreaterThan(0);
    // contracts/link.ts + ARCHITECTURE "Animation": lost frames remain in inflight until
    // `arrive` so the UI reconciles them with their frameTx events.
    const inflight = sim.snapshot().inflight.map((f) => f.pdu.id);
    expect(inflight.filter((id) => lostIds.includes(id)).length).toBeGreaterThan(0);
    sim.runFor(2 * SEC);
    const later = sim.snapshot().inflight.map((f) => f.pdu.id);
    expect(later.filter((id) => lostIds.includes(id))).toEqual([]);
  });

  it('draws exactly 5 numbers per frame regardless of corruptPct', () => {
    expect(draws(0)).toBe(5);
    expect(draws(100)).toBe(5);
  });
});

describe('integer discipline grep (§5.4)', () => {
  const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;

  it('link/media uses no banned floating-point maths, exponentiation or clocks', () => {
    const dir = fileURLToPath(new URL('../src/link/media/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(['air.ts', 'cell.ts', 'p2p.ts', 'radio.ts', 'segment.ts', 'types.ts']);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(BANNED);
  });

  it('protocols/tcp* uses no banned floating-point maths, exponentiation or clocks', () => {
    const dir = fileURLToPath(new URL('../src/protocols/', import.meta.url));
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.startsWith('tcp') && f.endsWith('.ts'));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(BANNED);
  });

  it('the pattern catches each banned form', () => {
    for (const bad of ['Math.pow(2, 1)', 'Math.log10(x)', 'Math.exp (x)', 'Date.now()', 'x ** 2', '(a) ** b']) {
      expect(bad).toMatch(BANNED);
    }
    expect('return (1 << n) - 1;').not.toMatch(BANNED);
  });
});
