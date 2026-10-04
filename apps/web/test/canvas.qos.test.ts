// The QoS overlay layer (ARCHITECTURE-P3 §6, D16, §3.5 step 5, §3.11; W3 web-canvas): the [S20] class lanes of a
// scheduler port (priority lane nearest the cable with its `P` badge, fill, drop tags `queue full · class-default` and
// `policed` against the base sample), the layer's geometry (sleeves on the sender's right, stacks and lanes beyond the
// widest sleeve, the frame that leaves first nearest the cable), its colours, the text forms the keyboard outline reads,
// and the registry entry's load history.
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, EgressQueueView, PduSummary, PortQosView, PortSnapshot, PortTxQueueView } from '@netforge/engine';
import {
  LOAD_SLEEVE_MAX_WIDTH,
  QOS_PRIORITY_BADGE,
  buildQosLayerModel,
  buildQosOverlay,
  buildQosQueues,
  classKey,
  deriveDeviceQos,
  dropTagText,
  lanesOf,
  loadSampleOf,
  type QosLaneMark,
  type QosLayerModel,
  type QosQueueMark,
  type QosSleeveMark,
  type QosStackMark,
  type TxBacklogFrame,
} from '../src/canvas/overlays/qos-model.js';
import { QOS_OVERLAY, TOPO_OVERLAY_DEFAULTS, resetQosHistory } from '../src/canvas/overlays/registry.js';
import {
  CAPSULE_H,
  LANE_GAP,
  LANE_H,
  QOS_DROP_GLYPH,
  SLEEVE_EXTENT,
  SLEEVE_GAP,
  capsuleCenter,
  capsuleColor,
  capsuleQuad,
  describeLane,
  describeQueue,
  describeSleeve,
  describeStack,
  laneBadgePoint,
  laneBand,
  laneLegend,
  laneQuad,
  lanesThickness,
  legendPlacement,
  levelColor,
  portFrame,
  qosDeviceFacts,
  qosLinkFacts,
  qosPortFacts,
  shortQueue,
  shortStack,
  sideOf,
  sideStart,
  sleeveLabelPoint,
  sleeveOffset,
  sleevePath,
} from '../src/canvas/qos.js';
import { TEST_THEME, device, link, port, snapshot } from './canvas-fixtures.js';

const MS = 1_000_000;
const SEC = 1_000_000_000;

type ClassRow = EgressQueueView['classes'][number];

function cls(name: string, kind: ClassRow['kind'], over: Partial<ClassRow> = {}): ClassRow {
  return { name, kind, depth: 0, limit: 64, matched: 0, matchedBytes: 0, sent: 0, tailDrops: 0, policed: 0, offeredBps30s: 0, ...over };
}

/** §3.11: VOICE (priority 32) and class-default, plus a CBWFQ class between them in policy order. */
function wanEdge(over: { voice?: Partial<ClassRow>; bulk?: Partial<ClassRow>; dflt?: Partial<ClassRow> } = {}): EgressQueueView {
  return {
    policy: 'WAN-EDGE',
    strategy: 'class-based',
    refBps: 128_000,
    classes: [cls('BULK', 'bandwidth', over.bulk), cls('VOICE', 'priority', over.voice), cls('class-default', 'default', over.dflt)],
  };
}

function qosView(queue?: EgressQueueView): PortQosView {
  return { output: 'WAN-EDGE', classes: [], ...(queue === undefined ? {} : { queue }) };
}

function summary(id: number): PduSummary {
  return { id, proto: 'udp', size: 1004, summary: `UDP #${id}` };
}

function frame(id: number, txStart: number, dscp?: number): TxBacklogFrame {
  return { pdu: id, summary: summary(id), txStart, bytes: 1004, ...(dscp === undefined ? {} : { dscp }) };
}

function serial(id: string, linkId: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return port(id, { short: id, kind: 'serial', role: 'routed', encap: 'hdlc', operUp: true, link: linkId, speedBps: 128_000, ...extra });
}

function router(id: string, ports: PortSnapshot[]): DeviceSnapshot {
  return device(id, 0, 0, ports, { type: 'router.nf2911', model: 'NF-2911', kind: 'router' });
}

/** R1 Se0/0/0 ↔ R2 Se0/0/0 at 128 kb/s; R1's egress has the queue view and/or a backlog. */
function wan(opts: { queue?: EgressQueueView; backlog?: PortTxQueueView; r1Out?: number; now?: number } = {}) {
  const r1Port = serial('Se0/0/0', 'l1', {
    counters: { ...emptyCounters(), outBytes: opts.r1Out ?? 0 },
    ...(opts.queue === undefined ? {} : { qos: qosView(opts.queue) }),
    ...(opts.backlog === undefined ? {} : { txBacklog: opts.backlog }),
  });
  const r1 = router('r1', [r1Port]);
  const r2 = router('r2', [serial('Se0/0/0', 'l1')]);
  return snapshot([r1, r2], [link('l1', ['r1', 'Se0/0/0'], ['r2', 'Se0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' })], { now: opts.now ?? 0 });
}

const WHERE = { device: 'r1', port: 'Se0/0/0' } as const;

afterEach(() => resetQosHistory());

// ── the model: lanes ─────────────────────────────────────────────────────────

describe('[S20] class lanes', () => {
  it('puts the priority lane nearest the cable with its P badge, then the other classes in policy order', () => {
    const lanes = lanesOf(wanEdge({ voice: { depth: 1 }, dflt: { depth: 64 } }), WHERE);
    expect(lanes.map((l) => l.name)).toEqual(['VOICE', 'BULK', 'class-default']);
    expect(lanes.map((l) => l.badge)).toEqual([QOS_PRIORITY_BADGE, '', '']);
    expect(QOS_PRIORITY_BADGE).toBe('P');
    expect(lanes.map((l) => l.priority)).toEqual([true, false, false]);
    expect(lanes.map((l) => l.label)).toEqual(['VOICE 1/64', 'BULK 0/64', 'class-default 64/64']);
    expect(lanes.map((l) => l.fill)).toEqual([1 / 64, 0, 1]);
  });

  it('keeps several priority classes in policy order, and clamps the fill (an unknown limit fills nothing)', () => {
    const view: EgressQueueView = {
      strategy: 'class-based',
      refBps: 128_000,
      classes: [cls('A', 'bandwidth'), cls('P1', 'priority', { depth: 70 }), cls('P2', 'priority', { limit: 0, depth: 3 })],
    };
    const lanes = lanesOf(view, WHERE);
    expect(lanes.map((l) => l.name)).toEqual(['P1', 'P2', 'A']);
    expect(lanes.map((l) => l.fill)).toEqual([1, 0, 0]);
  });

  it('tags tail drops and policed drops with their exact texts, every counted drop when there is no base', () => {
    expect(dropTagText('queue-full', 'class-default')).toBe('queue full · class-default');
    expect(dropTagText('policed', 'VOICE')).toBe('policed');
    const lanes = lanesOf(wanEdge({ voice: { policed: 2 }, dflt: { tailDrops: 3 } }), WHERE);
    const byName = new Map(lanes.map((l) => [l.name, l]));
    expect(byName.get('VOICE')?.tags).toEqual([{ kind: 'policed', text: 'policed', count: 2 }]);
    expect(byName.get('class-default')?.tags).toEqual([{ kind: 'queue-full', text: 'queue full · class-default', count: 3 }]);
    expect(byName.get('BULK')?.tags).toEqual([]);
    const both = lanesOf(wanEdge({ bulk: { tailDrops: 1, policed: 4 } }), WHERE).find((l) => l.name === 'BULK');
    expect(both?.tags.map((t) => t.kind)).toEqual(['queue-full', 'policed']);
  });

  it('counts only the drops since the base sample; a counter that went back counts from zero', () => {
    const base = new Map([
      [classKey('r1', 'Se0/0/0', 'class-default'), { tailDrops: 3, policed: 0 }],
      [classKey('r1', 'Se0/0/0', 'VOICE'), { tailDrops: 0, policed: 2 }],
      [classKey('r1', 'Se0/0/0', 'BULK'), { tailDrops: 9, policed: 0 }],
    ]);
    const lanes = lanesOf(wanEdge({ voice: { policed: 2 }, dflt: { tailDrops: 5 }, bulk: { tailDrops: 1 } }), WHERE, base);
    const byName = new Map(lanes.map((l) => [l.name, l]));
    expect(byName.get('class-default')?.tags).toEqual([{ kind: 'queue-full', text: 'queue full · class-default', count: 2 }]);
    expect(byName.get('VOICE')?.tags).toEqual([]);
    expect(byName.get('BULK')?.tags).toEqual([{ kind: 'queue-full', text: 'queue full · BULK', count: 1 }]);
    expect(byName.get('class-default')?.tailDrops).toBe(5);
    // a class the base does not know (the policy was attached since) shows every drop it counted
    const fresh = lanesOf(wanEdge({ dflt: { tailDrops: 4 } }), WHERE, new Map());
    expect(fresh.find((l) => l.name === 'class-default')?.tags.map((t) => t.count)).toEqual([4]);
  });

  it('carries the fair-queue flow count when the view has one', () => {
    const lanes = lanesOf(wanEdge({ dflt: { flows: 3 } }), WHERE);
    expect(lanes.find((l) => l.name === 'class-default')?.flows).toBe(3);
    expect('flows' in (lanes.find((l) => l.name === 'VOICE') as QosLaneMark)).toBe(false);
  });

  it('derives the scheduler ports of a device and samples their drop counters', () => {
    const snap = wan({ queue: wanEdge({ dflt: { tailDrops: 7, policed: 1 } }) });
    const r1 = snap.devices[0] as DeviceSnapshot;
    expect(deriveDeviceQos(r1).queues?.map((q) => q.port)).toEqual(['Se0/0/0']);
    expect(deriveDeviceQos(snap.devices[1] as DeviceSnapshot).queues).toEqual([]);
    const sample = loadSampleOf(snap);
    expect(sample.classDrops?.get(classKey('r1', 'Se0/0/0', 'class-default'))).toEqual({ tailDrops: 7, policed: 1 });
    expect(sample.classDrops?.size).toBe(3);
    expect(loadSampleOf(wan()).classDrops).toBeUndefined();
    // a queue view without classes is not a scheduler port
    const empty = wan({ queue: { strategy: 'fifo', refBps: 128_000, classes: [] } });
    expect(deriveDeviceQos(empty.devices[0] as DeviceSnapshot).queues).toEqual([]);
  });

  it('builds one queue mark per scheduler port, with its cable end and policy', () => {
    const queues = buildQosQueues(wan({ queue: wanEdge({ voice: { depth: 2 } }) }));
    expect(queues).toHaveLength(1);
    const q = queues[0] as QosQueueMark;
    expect(q).toMatchObject({ device: 'r1', port: 'Se0/0/0', link: 'l1', end: 'a', policy: 'WAN-EDGE', strategy: 'class-based' });
    expect(q.lanes.map((l) => l.name)).toEqual(['VOICE', 'BULK', 'class-default']);
    expect(buildQosQueues(wan())).toEqual([]);
  });

  it('compares the drop tags against the base sample only when it is older than now', () => {
    const before = wan({ queue: wanEdge({ dflt: { tailDrops: 3 } }), now: 0 });
    const after = wan({ queue: wanEdge({ dflt: { tailDrops: 3 } }), now: SEC });
    const quiet = buildQosQueues(after, { base: loadSampleOf(before) });
    expect(quiet[0]?.lanes.every((l) => l.tags.length === 0)).toBe(true);
    // a base at the same instant is no base: every counted drop tags
    const same = buildQosQueues(after, { base: loadSampleOf(after) });
    expect(same[0]?.lanes.find((l) => l.name === 'class-default')?.tags.map((t) => t.count)).toEqual([3]);
  });

  it('leaves buildQosOverlay as it was and adds the lanes in the layer model', () => {
    const plain = snapshot([device('pc1', 0, 0, [port('Gi0')])]);
    expect(buildQosOverlay(plain)).toEqual({ stacks: [], sleeves: [] });
    expect(buildQosLayerModel(plain)).toEqual({ stacks: [], sleeves: [], queues: [] });
    const snap = wan({ queue: wanEdge(), backlog: { depth: 1, frames: [frame(9, 4 * MS, 46)] } });
    const model = buildQosLayerModel(snap);
    expect(model.stacks).toEqual(buildQosOverlay(snap).stacks);
    expect(model.queues).toEqual(buildQosQueues(snap));
  });
});

// ── the registry entry ───────────────────────────────────────────────────────

describe('the qos registry entry', () => {
  const ON = { ...TOPO_OVERLAY_DEFAULTS, qos: true };

  it('syncs nothing while the toggle is off or there is no snapshot', () => {
    expect(QOS_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: wan(), now: 0 })).toBeNull();
    expect(QOS_OVERLAY.sync({ state: ON, snapshot: null, now: 0 })).toBeNull();
  });

  it('keeps a load history: the first snapshot draws no sleeve, the next one compares with it', () => {
    const t0 = wan({ r1Out: 0, now: 0, queue: wanEdge({ dflt: { tailDrops: 3 } }) });
    const first = QOS_OVERLAY.sync({ state: ON, snapshot: t0, now: 0 }) as QosLayerModel;
    expect(first.sleeves).toEqual([]);
    expect(first.queues[0]?.lanes.find((l) => l.name === 'class-default')?.tags.map((t) => t.count)).toEqual([3]);
    // syncing the same snapshot again (the canvas and the outline both do) changes nothing
    expect(QOS_OVERLAY.sync({ state: ON, snapshot: t0, now: 0 })).toEqual(first);
    // one second later R1 sent 16 000 bytes over 128 kb/s: saturated; class-default dropped 2 more
    const t1 = wan({ r1Out: 16_000, now: SEC, queue: wanEdge({ dflt: { tailDrops: 5 } }) });
    const next = QOS_OVERLAY.sync({ state: ON, snapshot: t1, now: SEC }) as QosLayerModel;
    expect(next.sleeves.map((s) => [s.from, s.fraction, s.level, s.label])).toEqual([
      ['a', 1, 'err', '100 %'],
      ['b', 0, 'ok', '0 %'],
    ]);
    expect(next.sleeves[0]?.width).toBe(LOAD_SLEEVE_MAX_WIDTH);
    expect(next.queues[0]?.lanes.find((l) => l.name === 'class-default')?.tags).toEqual([
      { kind: 'queue-full', text: 'queue full · class-default', count: 2 },
    ]);
  });

  it('starts again after resetQosHistory', () => {
    QOS_OVERLAY.sync({ state: ON, snapshot: wan({ now: 0 }), now: 0 });
    resetQosHistory();
    const later = QOS_OVERLAY.sync({ state: ON, snapshot: wan({ r1Out: 8_000, now: SEC }), now: SEC }) as QosLayerModel;
    expect(later.sleeves).toEqual([]);
  });

  it('memoises the per-device data per device object', () => {
    const snap = wan({ queue: wanEdge() });
    const a = QOS_OVERLAY.select(snap);
    const b = QOS_OVERLAY.select(snapshot([...snap.devices], snap.links));
    expect(b.get('r1')).toBe(a.get('r1'));
  });
});

// ── geometry ─────────────────────────────────────────────────────────────────

/** A port on the right edge of its device, the cable leaving to the east. */
const EAST = { x: 100, y: 50, nx: 1, ny: 0 };
/** A port on the bottom edge, the cable leaving to the south. */
const SOUTH = { x: 100, y: 50, nx: 0, ny: 1 };

describe('geometry', () => {
  it('measures across the cable on the right-hand side of the leaving frame (screen axes)', () => {
    expect([Math.abs(sideOf(EAST).x), sideOf(EAST).y]).toEqual([0, 1]);
    expect([sideOf(SOUTH).x, Math.abs(sideOf(SOUTH).y)]).toEqual([-1, 0]);
    expect(portFrame(EAST, 10, 4)).toEqual({ x: 110, y: 54 });
    expect(portFrame(SOUTH, 10, 4)).toEqual({ x: 96, y: 60 });
  });

  it('starts the stacks and lanes past the reach of the widest sleeve', () => {
    expect(SLEEVE_EXTENT).toBe(SLEEVE_GAP + LOAD_SLEEVE_MAX_WIDTH);
    expect(sideStart()).toBeGreaterThan(SLEEVE_EXTENT);
    expect(sideStart(0.5)).toBeGreaterThan(SLEEVE_EXTENT);
    const [inner] = laneBand(0);
    expect(inner).toBe(sideStart());
  });

  it('piles a stack away from the cable, the frame that leaves first nearest it', () => {
    const c0 = capsuleCenter(EAST, 0);
    const c1 = capsuleCenter(EAST, 1);
    expect(c0.x).toBe(c1.x);
    expect(c1.y).toBeGreaterThan(c0.y);
    expect(c0.y - EAST.y).toBeGreaterThan(SLEEVE_EXTENT);
    // a stack behind the lanes starts beyond them
    const behind = capsuleCenter(EAST, 0, lanesThickness(3));
    expect(behind.y - c0.y).toBe(lanesThickness(3));
    const quad = capsuleQuad(EAST, 0);
    expect(quad).toHaveLength(8);
    expect(Math.max(quad[1] as number, quad[3] as number, quad[5] as number, quad[7] as number) - Math.min(quad[1] as number, quad[3] as number, quad[5] as number, quad[7] as number)).toBeCloseTo(CAPSULE_H);
  });

  it('lays lanes side by side, lane 0 nearest the cable, each filled along the cable to its fraction', () => {
    const [a0, a1] = laneBand(0);
    const [b0] = laneBand(1);
    expect(a1 - a0).toBeCloseTo(LANE_H);
    expect(b0 - a1).toBeCloseTo(LANE_GAP);
    expect(lanesThickness(0)).toBe(0);
    expect(lanesThickness(2)).toBe(2 * (LANE_H + LANE_GAP));
    const full = laneQuad(EAST, 0, 1);
    const half = laneQuad(EAST, 0, 0.5);
    const len = (q: number[]): number => (q[2] as number) - (q[0] as number);
    expect(len(half)).toBeCloseTo(len(full) / 2);
    expect(laneQuad(EAST, 0, 7)).toEqual(full);
    const badge = laneBadgePoint(EAST, 0);
    expect(badge.x).toBeLessThan(full[0] as number);
    expect(badge.y).toBeCloseTo((a0 + a1) / 2 + EAST.y);
  });

  it('places the lane legend beside the lanes, away from the cable', () => {
    const east = legendPlacement(EAST, 2);
    expect(east.at.y - EAST.y).toBeCloseTo(sideStart() + lanesThickness(2) + 2);
    expect([east.anchorX, east.anchorY, east.reversed]).toEqual([0.5, 0, false]);
    const west = legendPlacement({ x: 100, y: 50, nx: -1, ny: 0 }, 2);
    expect([west.anchorX, west.anchorY, west.reversed]).toEqual([0.5, 1, true]);
    expect(west.at.y).toBeLessThan(50);
    const south = legendPlacement(SOUTH, 2);
    expect([south.anchorX, south.anchorY, south.reversed]).toEqual([1, 0.5, false]);
    expect(south.at.x).toBeLessThan(100);
  });

  it('runs each direction’s sleeve on its sender’s right, so the two directions never overlap', () => {
    const geom = { p0: { x: 0, y: 0 }, p1: { x: 30, y: 0 }, p2: { x: 70, y: 0 }, p3: { x: 100, y: 0 } };
    const fromA = sleevePath(geom, 'a', 6, 4);
    const fromB = sleevePath(geom, 'b', 6, 4);
    expect(fromA).toHaveLength(5);
    expect(fromA[0]).toEqual({ x: 0, y: sleeveOffset(6) });
    expect(fromA[4]?.x).toBeCloseTo(100);
    for (const p of fromA) expect(p.y).toBeCloseTo(SLEEVE_GAP + 3);
    for (const p of fromB) expect(p.y).toBeCloseTo(-(SLEEVE_GAP + 3));
    expect(fromB[0]?.x).toBeCloseTo(100);
    expect(sleeveLabelPoint(geom, 'a', 6).y).toBeGreaterThan(SLEEVE_GAP + 6);
    expect(sleeveLabelPoint(geom, 'b', 6).y).toBeLessThan(-(SLEEVE_GAP + 6));
  });
});

describe('colours', () => {
  it('ramps the sleeves ok / warn / err, and fills capsules by DSCP family', () => {
    expect([levelColor('ok', TEST_THEME), levelColor('warn', TEST_THEME), levelColor('err', TEST_THEME)]).toEqual([TEST_THEME.ok, TEST_THEME.warn, TEST_THEME.err]);
    expect(capsuleColor('EF', TEST_THEME)).toBe(TEST_THEME.purple);
    expect(capsuleColor('AF', TEST_THEME)).toBe(TEST_THEME.accent);
    expect(capsuleColor('CS', TEST_THEME)).toBe(TEST_THEME.blueDeep);
    expect(capsuleColor('BE', TEST_THEME)).toBe(TEST_THEME.panel2);
    expect(capsuleColor('', TEST_THEME)).toBe(TEST_THEME.panel2);
    expect(capsuleColor('44', TEST_THEME)).toBe(TEST_THEME.yellow);
  });
});

// ── text forms ───────────────────────────────────────────────────────────────

describe('text forms', () => {
  function layerModel(): QosLayerModel {
    const backlog: PortTxQueueView = { depth: 6, frames: [frame(1, 1, 46), frame(2, 2, 0), frame(3, 3)] };
    return buildQosLayerModel(wan({ queue: wanEdge({ voice: { depth: 1, policed: 2 }, dflt: { depth: 64, tailDrops: 3, flows: 2 } }), backlog }));
  }

  it('says a stack: its depth, every capsule’s code point first to last, and the frames beyond', () => {
    const stack = layerModel().stacks[0] as QosStackMark;
    expect(describeStack(stack)).toBe('6 frames waiting to be sent, first to last: EF (46), BE (0), unmarked, and 3 more');
    expect(shortStack(stack)).toBe('queue 6: EF BE · +3');
    const one = buildQosOverlay(wan({ backlog: { depth: 1, frames: [frame(1, 1, 46)] } })).stacks[0] as QosStackMark;
    expect(describeStack(one)).toBe('1 frame waiting to be sent, first to last: EF (46)');
    expect(shortStack(one)).toBe('queue 1: EF');
  });

  it('says the lanes: the priority queue, each depth of its limit, flows and drop tags', () => {
    const q = layerModel().queues[0] as QosQueueMark;
    const [voice, bulk, dflt] = q.lanes as [QosLaneMark, QosLaneMark, QosLaneMark];
    expect(describeLane(voice)).toBe('VOICE, the priority queue, 1 of 64 waiting, policed (2 dropped)');
    expect(describeLane(bulk)).toBe('BULK, 0 of 64 waiting');
    expect(describeLane(dflt)).toBe('class-default, 64 of 64 waiting, 2 flows, queue full · class-default (3 dropped)');
    expect(laneLegend(voice)).toBe(`P VOICE 1/64 ${QOS_DROP_GLYPH} policed`);
    expect(laneLegend(bulk)).toBe('BULK 0/64');
    expect(laneLegend(dflt)).toBe('class-default 64/64 ✕ queue full · class-default');
    expect(describeQueue(q)).toBe(
      'output policy WAN-EDGE: VOICE, the priority queue, 1 of 64 waiting, policed (2 dropped); BULK, 0 of 64 waiting; ' +
        'class-default, 64 of 64 waiting, 2 flows, queue full · class-default (3 dropped)',
    );
    expect(shortQueue(q)).toBe('P VOICE 1/64 ✕ · BULK 0/64 · class-default 64/64 ✕');
    const unnamed: QosQueueMark = { device: q.device, port: q.port, strategy: q.strategy, lanes: q.lanes };
    expect(describeQueue(unnamed).startsWith('output queues: VOICE')).toBe(true);
  });

  it('says a sleeve: the load, its level in words, and who sends', () => {
    const sleeve: QosSleeveMark = { link: 'l1', from: 'a', device: 'r1', port: 'Se0/0/0', fraction: 1, width: 10, label: '100 %', level: 'err' };
    expect(describeSleeve(sleeve)).toBe('sending at 100 % of the line rate (near saturation) from r1 Se0/0/0');
    expect(describeSleeve({ ...sleeve, label: '37 %', level: 'ok' })).toBe('sending at 37 % of the line rate (light) from r1 Se0/0/0');
    expect(describeSleeve({ ...sleeve, label: '60 %', level: 'warn' })).toBe('sending at 60 % of the line rate (heavy) from r1 Se0/0/0');
  });

  it('folds the lanes and the stack of one port into one fact, lanes first', () => {
    const facts = qosPortFacts(layerModel());
    expect([...facts.keys()]).toEqual(['r1/Se0/0/0']);
    const fact = facts.get('r1/Se0/0/0');
    expect(fact?.short).toBe('P VOICE 1/64 ✕ · BULK 0/64 · class-default 64/64 ✕ · queue 6: EF BE · +3');
    expect(fact?.text.startsWith('output policy WAN-EDGE: VOICE')).toBe(true);
    expect(fact?.text.endsWith('; 6 frames waiting to be sent, first to last: EF (46), BE (0), unmarked, and 3 more')).toBe(true);
    expect(qosPortFacts(null).size).toBe(0);
  });

  it('says per device how many ports hold frames, and per cable each direction’s load', () => {
    expect(qosDeviceFacts(layerModel()).get('r1')).toEqual({ short: 'queues 1', text: 'frames waiting at 1 port' });
    expect(qosDeviceFacts(layerModel()).has('r2')).toBe(false);
    // lanes with nothing waiting and no stack: no device fact
    expect(qosDeviceFacts(buildQosLayerModel(wan({ queue: wanEdge() }))).size).toBe(0);
    expect(qosDeviceFacts(null).size).toBe(0);
    const base = loadSampleOf(wan({ now: 0 }));
    const model = buildQosLayerModel(wan({ r1Out: 4_000, now: SEC }), { base });
    const links = qosLinkFacts(model);
    expect(links.get('l1')).toEqual({ short: '→ 25 % ← 0 %', text: 'load: sending at 25 % of the line rate (light) from r1 Se0/0/0; sending at 0 % of the line rate (light) from r2 Se0/0/0' });
    expect(qosLinkFacts(null).size).toBe(0);
  });
});
