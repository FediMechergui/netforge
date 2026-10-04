// [S3] The SPF stepper's parity with the one SPF (ARCHITECTURE-P3 D10, §6, §10.2 "routing.spf-parity"): the stepper's
// last frame is exactly the tree `core/ospf-spf.ts` computes on the same database (`runSpf` over `buildSpfGraph`, with
// the root interfaces the daemon gives it), and the tree of the router's StateView once it ran SPF on it; every frame's
// tentative list, sentence and canvas model follow the frames of `spfSteps`.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSpfGraph, runSpf, spfSteps } from '@netforge/engine/pure';
import { portKey, type OspfLsaRow } from '@netforge/engine';
import {
  buildSpfOverlay,
  clampStep,
  matchesRouter,
  rootIfacesOf,
  sameTree,
  spfChip,
  spfFrame,
  spfRunFor,
  spfRunOf,
  stateViewTree,
} from '../src/canvas/overlays/spf-model.js';
import { placeCentre, ringRadius, spfDeviceFacts, spfLinkFacts, spfPortFacts, spfUnderlayWidth } from '../src/canvas/spf.js';
import { lsdbOf, routerDevices } from '../src/routing/lsdb-model.js';
import { SpfStepperView, routerTreeSentence } from '../src/routing/SpfStepper.js';
import { AREA0, SEC, T0, expectedR1Tree, routerLsa, world, worldLsas } from './routing-fixtures.js';

const NOW = T0 + 5 * SEC;

function deviceOf(snap: ReturnType<typeof world>, id: string) {
  const d = snap.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

describe('the last frame is the one SPF of core/ospf-spf.ts', () => {
  it.each(['r1', 'r2', 'r3', 'r4'])('%s: spfSteps frames end on runSpf’s tree, on the same database', (id) => {
    const snap = world();
    const d = deviceOf(snap, id);
    const lsdb = lsdbOf(d);
    const run = spfRunFor(d, AREA0, NOW);
    expect(run).toBeDefined();
    const graph = buildSpfGraph(lsdb.lsas, AREA0, NOW);
    const ifaces = rootIfacesOf(lsdb, AREA0);
    const core = runSpf(graph, lsdb.routerId!, ifaces);
    expect(run!.root).toBe(lsdb.routerId);
    expect(run!.tree).toEqual(core.tree);
    expect(spfFrame(run!, run!.steps.length - 1).tree).toEqual(core.tree.vertices);
    expect(run!.steps).toEqual(spfSteps(graph, lsdb.routerId!, ifaces));
    expect(sameTree(run!.tree, core.tree)).toBe(true);
  });

  it("R1's frames: root, the LAN, R2 and R3 through it, R4 by two equal-cost paths", () => {
    const run = spfRunFor(deviceOf(world(), 'r1'), AREA0, NOW)!;
    expect(run.rootIfaces).toEqual([
      { port: 'Gi0/0', address: '10.0.123.1' },
      { port: 'Se0/0/0', address: '10.0.13.1' },
      { port: 'Gi0/1', address: '10.1.0.1' },
    ]);
    expect(run.tree).toEqual(expectedR1Tree());
    expect(run.steps.map((s) => s.candidates.map((c) => `${c.key}@${c.cost}`))).toEqual([
      ['N:10.0.123.2@1', 'R:3.3.3.3@64'],
      ['R:2.2.2.2@1', 'R:3.3.3.3@1'],
      ['R:3.3.3.3@1', 'R:4.4.4.4@2'],
      ['R:4.4.4.4@2'],
      [],
    ]);
  });

  it('the root interfaces are the area’s up, addressed interfaces in canonical port order (as the daemon gives them)', () => {
    const snap = world();
    const d = deviceOf(snap, 'r4');
    expect(rootIfacesOf(lsdbOf(d), AREA0)).toEqual([
      { port: 'Gi0/0', address: '10.0.24.2' },
      { port: 'Gi0/1', address: '10.0.34.2' },
      { port: 'Lo0', address: '4.4.4.4' },
    ]);
    expect(rootIfacesOf(lsdbOf(d), '0.0.0.1')).toEqual([]);
  });

  it('an LSA that reached MaxAge at now is left out of both, the same way', () => {
    const rows = worldLsas().map((r) => (r.advRouter === '4.4.4.4' && r.type === 1 ? { ...r, ageAtInstall: 3590 } : r));
    const snap = world({ lsas: { '1.1.1.1': rows } });
    const d = deviceOf(snap, 'r1');
    const early = spfRunFor(d, AREA0, T0 + 5 * SEC)!;
    const late = spfRunFor(d, AREA0, T0 + 20 * SEC)!;
    expect(early.tree.vertices.map((v) => v.key)).toContain('R:4.4.4.4');
    expect(late.tree.vertices.map((v) => v.key)).not.toContain('R:4.4.4.4');
    const lsdb = lsdbOf(d);
    expect(late.tree).toEqual(runSpf(buildSpfGraph(lsdb.lsas, AREA0, T0 + 20 * SEC), '1.1.1.1', rootIfacesOf(lsdb, AREA0)).tree);
  });

  it('a one-way link is relaxed as one-way, and the tree still equals runSpf', () => {
    const rows: OspfLsaRow[] = worldLsas().map((r) =>
      r.advRouter === '4.4.4.4' && r.type === 1 ? { ...r, links: [...(r.links ?? []), { kind: 'p2p' as const, id: '5.5.5.5', data: '10.0.45.1', metric: 1 }] } : r,
    );
    rows.push(routerLsa('5.5.5.5', [{ kind: 'stub', id: '10.5.0.0', data: '255.255.255.0', metric: 1 }]));
    const snap = world({ lsas: { '1.1.1.1': rows } });
    const run = spfRunFor(deviceOf(snap, 'r1'), AREA0, NOW)!;
    const lsdb = lsdbOf(deviceOf(snap, 'r1'));
    expect(run.tree).toEqual(runSpf(buildSpfGraph(lsdb.lsas, AREA0, NOW), '1.1.1.1', rootIfacesOf(lsdb, AREA0)).tree);
    const last = spfFrame(run, 99, routerDevices(snap));
    expect(last.relaxed.find((r) => r.to === 'R:5.5.5.5')?.outcome).toBe('one-way');
    expect(last.sentence).toContain('Not used, listed one way only: 5.5.5.5.');
  });

  it('a router with no router-LSA of its own yields the root alone, like runSpf', () => {
    const rows = worldLsas().filter((r) => r.advRouter !== '1.1.1.1');
    const run = spfRunFor(deviceOf(world({ lsas: { '1.1.1.1': rows } }), 'r1'), AREA0, NOW)!;
    expect(run.tree).toEqual({ root: '1.1.1.1', vertices: [{ key: 'R:1.1.1.1', kind: 'router', id: '1.1.1.1', cost: 0, nextHops: [] }] });
    expect(spfFrame(run, 0).sentence).toContain('the tree is complete with 1 vertex');
  });
});

describe('the last frame equals the StateView tree', () => {
  it('matches the tree the router reports for the area (written by hand from RFC 2328 §16.1)', () => {
    const snap = world({ trees: { '1.1.1.1': [{ area: AREA0, tree: expectedR1Tree() }] } });
    const run = spfRunOf(snap, { device: 'r1', area: AREA0 }, NOW)!;
    expect(stateViewTree(deviceOf(snap, 'r1'), AREA0)).toEqual(expectedR1Tree());
    expect(run.routerTree).toEqual(expectedR1Tree());
    expect(spfFrame(run, run.steps.length - 1).tree).toEqual(run.routerTree!.vertices);
    expect(matchesRouter(run)).toBe(true);
    expect(routerTreeSentence(run)).toBe('The last step is the tree R1 computed in its last SPF run.');
  });

  it('says so when the router’s last run differs (its database changed since), or when it has not run', () => {
    const stale = { ...expectedR1Tree(), vertices: expectedR1Tree().vertices.slice(0, 4) };
    const run = spfRunOf(world({ trees: { '1.1.1.1': [{ area: AREA0, tree: stale }] } }), { device: 'r1', area: AREA0 }, NOW)!;
    expect(matchesRouter(run)).toBe(false);
    expect(routerTreeSentence(run)).toContain('computed a different tree');
    const none = spfRunOf(world(), { device: 'r1', area: AREA0 }, NOW)!;
    expect(matchesRouter(none)).toBeNull();
    expect(routerTreeSentence(none)).toBe('R1 has not run SPF on this area yet.');
    // a tree of another area does not count
    const other = spfRunOf(world({ trees: { '1.1.1.1': [{ area: '0.0.0.1', tree: expectedR1Tree() }] } }), { device: 'r1', area: AREA0 }, NOW)!;
    expect(matchesRouter(other)).toBeNull();
  });

  it('sameTree compares next hops in order', () => {
    const a = expectedR1Tree();
    const swapped = {
      ...a,
      vertices: a.vertices.map((v) => (v.key === 'R:4.4.4.4' ? { ...v, nextHops: [...v.nextHops].reverse() } : v)),
    };
    expect(sameTree(a, a)).toBe(true);
    expect(sameTree(a, swapped)).toBe(false);
  });
});

describe('frames: the tentative list and one sentence per step', () => {
  const snap = world();
  const run = spfRunOf(snap, { device: 'r1', area: AREA0 }, NOW)!;
  const names = routerDevices(snap);

  it('clamps the step to the run', () => {
    expect(clampStep(run, -3)).toBe(0);
    expect(clampStep(run, 2.7)).toBe(2);
    expect(clampStep(run, 99)).toBe(4);
    expect(clampStep(run, Number.NaN)).toBe(0);
  });

  it('each frame says what settled, what changed on the list and what comes next', () => {
    const sentences = [0, 1, 2, 3, 4].map((i) => spfFrame(run, i, names).sentence);
    expect(sentences).toEqual([
      'Step 1 of 5. R1 (1.1.1.1) is the root: it starts at cost 0. New on the tentative list: network 10.0.123.0/24 (DR 10.0.123.2) at 1 and R3 (3.3.3.3) at 64. Next: network 10.0.123.0/24 (DR 10.0.123.2) at cost 1.',
      'Step 2 of 5. network 10.0.123.0/24 (DR 10.0.123.2) settles at cost 1, reached through R1 (1.1.1.1). New on the tentative list: R2 (2.2.2.2) at 1. A cheaper path: R3 (3.3.3.3) now at 1. Next: R2 (2.2.2.2) at cost 1.',
      'Step 3 of 5. R2 (2.2.2.2) settles at cost 1, reached through network 10.0.123.0/24 (DR 10.0.123.2). New on the tentative list: R4 (4.4.4.4) at 2. Next: R3 (3.3.3.3) at cost 1.',
      'Step 4 of 5. R3 (3.3.3.3) settles at cost 1, reached through network 10.0.123.0/24 (DR 10.0.123.2). An equal-cost path: R4 (4.4.4.4) at 2. Next: R4 (4.4.4.4) at cost 2.',
      'Step 5 of 5. R4 (4.4.4.4) settles at cost 2, reached through R2 (2.2.2.2). Its links offer nothing new. The tentative list is empty: the tree is complete with 5 vertices.',
    ]);
  });

  it('the tentative rows carry cost, parent and this step’s change', () => {
    const f1 = spfFrame(run, 1, names);
    expect(f1.candidates.map((c) => [c.name, c.cost, c.parentName, c.change])).toEqual([
      ['R2 (2.2.2.2)', 1, 'network 10.0.123.0/24 (DR 10.0.123.2)', 'new'],
      ['R3 (3.3.3.3)', 1, 'network 10.0.123.0/24 (DR 10.0.123.2)', 'cheaper'],
    ]);
    const f3 = spfFrame(run, 3, names);
    expect(f3.candidates.map((c) => [c.name, c.change])).toEqual([['R4 (4.4.4.4)', 'equal-cost']]);
    expect(f3.treeNames).toEqual(['R1 (1.1.1.1)', 'network 10.0.123.0/24 (DR 10.0.123.2)', 'R2 (2.2.2.2)', 'R3 (3.3.3.3)']);
  });

  it('the stepper view: the controls, the live region and the tables', () => {
    const html = renderToStaticMarkup(createElement(SpfStepperView, { run, frame: spfFrame(run, 0, names), playing: false, onStep: () => undefined, onPlay: () => undefined }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Step 1 of 5');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>« First<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>‹ Back<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn">Step ›<\/button>/);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Tentative list');
    expect(html).toContain('R3 (3.3.3.3)');
    const last = renderToStaticMarkup(createElement(SpfStepperView, { run, frame: spfFrame(run, 4, names), playing: false, onStep: () => undefined, onPlay: () => undefined }));
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*>Step ›<\/button>/);
    expect(last).toContain('Empty: every reachable vertex is settled.');
    expect(last).toContain('Settled (5)');
  });
});

describe('the canvas spf model and layer facts', () => {
  const snap = world();

  it('frame 1: the root ring, the LAN on its switch, cables to the tentative routers', () => {
    const m = buildSpfOverlay(snap, { device: 'r1', area: AREA0, step: 1 }, NOW)!;
    expect(m.step).toBe(1);
    expect(m.last).toBe(4);
    expect(m.rootName).toBe('R1 (1.1.1.1)');
    expect(m.vertices.map((v) => [v.key, v.status, v.chip, v.at])).toEqual([
      ['R:1.1.1.1', 'root', '0', { kind: 'device', device: 'r1' }],
      ['N:10.0.123.2', 'current', '1', { kind: 'device', device: 'sw1' }],
      ['R:2.2.2.2', 'tentative', '1?', { kind: 'device', device: 'r2' }],
      ['R:3.3.3.3', 'tentative', '1?', { kind: 'device', device: 'r3' }],
    ]);
    expect(m.links.map((l) => [l.link, l.status, l.ports])).toEqual([
      ['l1', 'tree', [{ device: 'r1', port: 'Gi0/0' }]],
      ['l2', 'tentative', [{ device: 'r2', port: 'Gi0/0' }]],
      ['l3', 'tentative', [{ device: 'r3', port: 'Gi0/0' }]],
    ]);
    expect(m.sentence).toBe(spfFrame(spfRunOf(snap, { device: 'r1', area: AREA0 }, NOW)!, 1, routerDevices(snap)).sentence);
  });

  it('frame 0 offers the serial path at 64; the last frame keeps only the tree on the real cables', () => {
    const first = buildSpfOverlay(snap, { device: 'r1', area: AREA0, step: 0 }, NOW)!;
    expect(first.links.map((l) => [l.link, l.status])).toEqual([
      ['l1', 'tentative'],
      ['l5', 'tentative'],
    ]);
    expect(first.vertices.find((v) => v.key === 'R:3.3.3.3')?.chip).toBe('64?');
    const last = buildSpfOverlay(snap, { device: 'r1', area: AREA0, step: 99 }, NOW)!;
    expect(last.step).toBe(4);
    expect(last.vertices.map((v) => [v.key, v.status])).toEqual([
      ['R:1.1.1.1', 'root'],
      ['N:10.0.123.2', 'settled'],
      ['R:2.2.2.2', 'settled'],
      ['R:3.3.3.3', 'settled'],
      ['R:4.4.4.4', 'current'],
    ]);
    expect(last.links.map((l) => [l.link, l.status, l.text])).toEqual([
      ['l1', 'tree', 'R1 (1.1.1.1) → network 10.0.123.0/24 (DR 10.0.123.2), cost 1'],
      ['l2', 'tree', 'network 10.0.123.0/24 (DR 10.0.123.2) → R2 (2.2.2.2), cost 1'],
      ['l3', 'tree', 'network 10.0.123.0/24 (DR 10.0.123.2) → R3 (3.3.3.3), cost 1'],
      ['l6', 'tree', 'R2 (2.2.2.2) → R4 (4.4.4.4), cost 2'],
    ]);
  });

  it('follows the selection: another router, a fallback when none is chosen, null without OSPF', () => {
    expect(buildSpfOverlay(snap, { device: 'r4', area: AREA0, step: 0 }, NOW)?.root).toBe('4.4.4.4');
    expect(buildSpfOverlay(snap, { device: null, area: null, step: 0 }, NOW)?.device).toBe('r1');
    expect(buildSpfOverlay(snap, { device: 'sw1', area: null, step: 0 }, NOW)?.device).toBe('r1');
    expect(buildSpfOverlay(null, { device: 'r1', area: AREA0, step: 0 }, NOW)).toBeNull();
    const bare = { ...snap, devices: snap.devices.filter((d) => d.id === 'sw1') };
    expect(buildSpfOverlay(bare, { device: null, area: null, step: 0 }, NOW)).toBeNull();
  });

  it('a transit network with no common segment device sits at the centroid of its routers', () => {
    const direct = { ...snap, links: snap.links.map((l) => (l.id === 'l2' ? { ...l, b: { device: 'r9', port: 'Gi0/0' } } : l)) };
    const m = buildSpfOverlay(direct, { device: 'r1', area: AREA0, step: 1 }, NOW)!;
    expect(m.vertices.find((v) => v.key === 'N:10.0.123.2')?.at).toEqual({ kind: 'centroid', devices: ['r1', 'r2', 'r3'] });
  });

  it('the layer facts say every drawn mark in words', () => {
    const m = buildSpfOverlay(snap, { device: 'r1', area: AREA0, step: 1 }, NOW)!;
    const dev = spfDeviceFacts(m);
    expect(dev.get('r1')).toEqual({ short: 'SPF root', text: 'shortest-path tree from R1 (1.1.1.1), step 2 of 5: R1 (1.1.1.1) the root, at cost 0' });
    expect(dev.get('sw1')?.text).toBe(
      'shortest-path tree from R1 (1.1.1.1), step 2 of 5: network 10.0.123.0/24 (DR 10.0.123.2) settled in this step at cost 1, reached through R1 (1.1.1.1)',
    );
    expect(dev.get('r2')).toEqual({
      short: 'SPF 1?',
      text: 'shortest-path tree from R1 (1.1.1.1), step 2 of 5: R2 (2.2.2.2) tentative at cost 1 so far, reached through network 10.0.123.0/24 (DR 10.0.123.2)',
    });
    expect(spfLinkFacts(m).get('l2')?.short).toBe('SPF offer');
    expect(spfLinkFacts(m).get('l1')?.text).toBe('in the shortest-path tree from R1 (1.1.1.1): R1 (1.1.1.1) → network 10.0.123.0/24 (DR 10.0.123.2), cost 1');
    expect([...spfPortFacts(m).keys()]).toEqual(['r1', 'r2', 'r3'].map((device) => portKey({ device, port: 'Gi0/0' })));
    expect(spfDeviceFacts(null).size + spfLinkFacts(null).size + spfPortFacts(null).size).toBe(0);
  });

  it('geometry: ring radius and underlay widths keep a non-colour channel', () => {
    expect(ringRadius(20)).toBe(27);
    expect(ringRadius(0)).toBe(12);
    expect(spfUnderlayWidth('tree')).toBeGreaterThan(spfUnderlayWidth('tentative'));
    expect(spfChip('tentative', 3)).toBe('3?');
    expect(spfChip('settled', 3)).toBe('3');
    const layout = { devices: new Map([['a', { x: 0, y: 0, halfW: 20, halfH: 10 }], ['b', { x: 100, y: 50, halfW: 20, halfH: 10 }]]) } as never;
    expect(placeCentre({ kind: 'device', device: 'a' }, layout)).toEqual({ x: 0, y: 0, body: 20 });
    expect(placeCentre({ kind: 'centroid', devices: ['a', 'b', 'zz'] }, layout)).toEqual({ x: 50, y: 25, body: 0 });
    expect(placeCentre({ kind: 'device', device: 'zz' }, layout)).toBeUndefined();
  });
});
