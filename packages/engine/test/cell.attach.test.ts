import { describe, expect, it } from 'vitest';
import type { MacAddress } from '../src/contracts/addr.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { Scheduler } from '../src/contracts/events.js';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps } from '../src/contracts/link.js';
import type { MediaSnapshot, MediumEvent, MediumOp } from '../src/contracts/medium.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import type { PortRole } from '../src/contracts/catalog.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { PortState, PortView } from '../src/contracts/port.js';
import type { Action, DebugEvent, ProcessCtx } from '../src/contracts/process.js';
import { MCS_TABLES, RF } from '../src/contracts/rf.js';
import type { RadioPortSpec } from '../src/contracts/rf.js';
import type { Rng } from '../src/contracts/rng.js';
import { propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { CELLULAR_UE_RADIO, cellularClient } from '../src/device/catalog/computers.js';
import { TOWER_RADIO } from '../src/device/catalog/radios.js';
import { createInflightRegistry } from '../src/link/inflight.js';
import {
  CELL_DETACH_REASONS,
  CELL_NOT_ATTACHED_DETAIL,
  CELL_NO_TOWER_MEDIUM,
  CELL_PHY_OVERHEAD_BYTES,
  CELL_UNKNOWN_UE_DETAIL,
  cellAssociationId,
  cellAttachKey,
  cellHoldKey,
  cellStreamLabel,
  createCellularCell,
} from '../src/link/media/cell.js';
import type { CellularCellStrategy } from '../src/link/media/cell.js';
import type { MediumHost } from '../src/link/media/types.js';
import { cellId } from '../src/link/media/types.js';
import { mcsRateBps } from '../src/link/rf/mcs.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  CELL_CLIENT,
  CELL_RESEARCH_NS,
  cellResearchTimerKey,
  createCellClient,
  isCellularAdapter,
} from '../src/protocols/cell-client.js';
import { testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';

// ── harness ───────────────────────────────────────────────────────────────────

const TOWER_SPEED = 300_000_000;
const UE_SPEED = cellularClient('Cellular0').speedBps;
const PORT = 'Cellular0';

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_x', ...over });

const frame = (dst: MacAddress, src: MacAddress): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: 1, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

function radioPort(role: PortRole, radio: RadioPortSpec, speedBps: number, mac: MacAddress): PortState {
  return {
    id: PORT,
    spec: testPortSpec({ name: PORT, short: 'Ce0', kind: 'cellular', speedBps, radio, role }),
    mac,
    adminUp: true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role,
    ordinal: 1,
    encap: 'ethernet',
  };
}

interface Note {
  ref: PortRef;
  ev: MediumEvent;
  t: number;
}

function harness(seed = 5) {
  const ports = new Map<string, PortState>();
  const positions = new Map<DeviceId, { x: number; y: number }>();
  const powered = new Map<DeviceId, boolean>();
  const radios: PortRef[] = [];
  const events: TraceEvent[] = [];
  const notes: Note[] = [];
  const scheduler: Scheduler = createScheduler();
  const root = createRng(seed).split('links');
  const streams = new Map<string, Rng>();
  const pdus = createPduFactory();
  const inflight = createInflightRegistry();
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: root,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => powered.get(id) === true,
    pdus,
    position: (id) => positions.get(id),
    metresPerUnit: 0.25,
  };
  const host: MediumHost = {
    deps,
    inflight,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => powered.get(id) === true,
    link: () => undefined,
    stream(label) {
      let s = streams.get(label);
      if (!s) {
        s = root.split(label);
        streams.set(label, s);
      }
      return s;
    },
    emit: (ev) => events.push(ev),
    schedule: (at, body) => scheduler.schedule(at, body),
    cancel: (seq) => scheduler.cancel(seq),
    txOutcome: () => undefined,
    notify: (ref, ev, now) => notes.push({ ref, ev, t: now }),
    capture: () => undefined,
  };
  const cell: CellularCellStrategy = createCellularCell(host, { radios: () => radios });

  const add = (device: DeviceId, x: number, y: number, port: PortState): PortRef => {
    const ref = { device, port: PORT };
    ports.set(portKey(ref), port);
    positions.set(device, { x, y });
    powered.set(device, true);
    radios.push(ref);
    return ref;
  };
  const addTower = (device: DeviceId, x: number, y: number, mac: MacAddress = '02:00:00:00:10:01'): PortRef => {
    const ref = add(device, x, y, radioPort('wireless-bss', TOWER_RADIO, TOWER_SPEED, mac));
    cell.onPortChanged(ref, scheduler.now, 'boot');
    return ref;
  };
  const addUe = (device: DeviceId, x: number, y: number, mac: MacAddress): PortRef =>
    add(device, x, y, radioPort('cellular', CELLULAR_UE_RADIO, UE_SPEED, mac));

  /** Pop every event up to `until` (inclusive); medium timers and txComplete are dispatched, arrivals returned. */
  const runUntil = (until: number) => {
    const arrivals: Extract<ReturnType<Scheduler['next']>, { kind: 'frameArrival' }>[] = [];
    for (let t = scheduler.peekTime(); t !== undefined && t <= until; t = scheduler.peekTime()) {
      const ev = scheduler.next()!;
      if (ev.kind === 'mediumTimer') cell.onMediumTimer(ev.medium, ev.key, ev.at);
      else if (ev.kind === 'txComplete') cell.onTxComplete?.({ device: ev.device, port: ev.port }, ev.at);
      else if (ev.kind === 'frameArrival') arrivals.push(ev);
    }
    if (scheduler.now < until) scheduler.advanceTo(until);
    return arrivals;
  };

  const attach = (ue: PortRef) => {
    cell.mediumOp(ue, { op: 'cell-attach' }, scheduler.now);
    runUntil(scheduler.now + RF.CELL_ATTACH_NS);
  };

  const snapshot = (): MediaSnapshot => {
    const into: MediaSnapshot = { metresPerUnit: cell.metresPerUnit(), segments: [], bss: [], cells: [], associations: [] };
    cell.contribute(scheduler.now, into);
    return into;
  };

  return {
    ports, positions, powered, radios, events, notes, scheduler, root, streams, pdus, inflight, host, cell,
    addTower, addUe, runUntil, attach, snapshot,
    port: (r: PortRef) => ports.get(portKey(r))!,
    kinds: (kind: TraceEvent['kind']) => events.filter((e) => e.kind === kind),
  };
}

const assocSeq = (events: TraceEvent[]) =>
  events.flatMap((e) => (e.kind === 'assocState' ? [`${e.prev}>${e.state}${e.reason ? `(${e.reason})` : ''}`] : []));

const TOP_RATE = Math.min(mcsRateBps(MCS_TABLES.lte.at(-1)!, 20, 2), UE_SPEED, TOWER_SPEED);

// ── attach ────────────────────────────────────────────────────────────────────

describe('link/media/cell attach (§3.8)', () => {
  it('attaches after exactly 300 ms through searching and attaching', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    expect(h.port(tower).operUp).toBe(true);
    h.events.length = 0;

    expect(h.cell.mediumOp(ue, { op: 'cell-attach' }, 0)).toEqual([]);
    const medium = cellId(tower);
    expect(assocSeq(h.events)).toEqual(['idle>searching', 'searching>attaching']);
    expect(h.events[0]).toMatchObject({ kind: 'assocState', tech: 'cellular', medium, station: ue, ap: tower });
    expect(h.scheduler.peekTime()).toBe(RF.CELL_ATTACH_NS);
    expect(h.port(ue).operUp).toBe(false);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'attaching', medium, tower });

    // one ns early: still attaching
    h.runUntil(RF.CELL_ATTACH_NS - 1);
    expect(h.cell.attachment(ue)?.state).toBe('attaching');

    const ev = h.scheduler.next()!;
    expect(ev).toMatchObject({ kind: 'mediumTimer', medium, key: cellAttachKey(ue), at: RF.CELL_ATTACH_NS });
    if (ev.kind !== 'mediumTimer') throw new Error('expected a medium timer');
    expect(h.cell.onMediumTimer(ev.medium, ev.key, ev.at)).toEqual([{ port: ue, operUp: true }]);

    const p = h.port(ue);
    expect(p.operUp).toBe(true);
    expect(p.speedBps).toBe(TOP_RATE);
    expect(p.duplex).toBe('full');
    expect(p.lastChange).toBe(RF.CELL_ATTACH_NS);
    expect(p.phy).toEqual({ carrier: true, lineProtocol: true, medium: 'cell' });
    expect(h.notes).toEqual([{ ref: ue, ev: { kind: 'cell-attached', tower }, t: RF.CELL_ATTACH_NS }]);
    expect(assocSeq(h.events)).toEqual(['idle>searching', 'searching>attaching', 'attaching>attached']);
    expect(h.kinds('portState')).toEqual([
      { t: RF.CELL_ATTACH_NS, kind: 'portState', device: 'd_phone', port: PORT, adminUp: true, operUp: true, reason: 'associated' },
    ]);
    expect(h.kinds('rfState')).toHaveLength(1);
    expect(h.kinds('rfState')[0]).toMatchObject({ port: ue, peer: tower, rateBps: TOP_RATE, bars: 4 });

    // a repeated request while attached changes nothing
    const before = h.events.length;
    expect(h.cell.mediumOp(ue, { op: 'cell-attach' }, RF.CELL_ATTACH_NS)).toEqual([]);
    expect(h.events.length).toBe(before);
  });

  it('picks the strongest tower first, then the lowest tower device id on a tie', () => {
    const h = harness();
    const far = h.addTower('d_a_far', 600, 0);
    const nearB = h.addTower('d_c', 0, 200);
    const nearA = h.addTower('d_b', 0, -200);
    const ue = h.addUe('d_phone', 0, 0, '02:00:00:00:20:01');
    h.attach(ue);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'attached', tower: nearA });
    expect(far).not.toEqual(nearA);
    expect(nearB).not.toEqual(nearA);
  });

  it('without a tower in range: detached no-cell once, later requests stay silent', () => {
    const h = harness();
    h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 40_000, 0, '02:00:00:00:20:01'); // 10 km
    h.events.length = 0;
    h.cell.mediumOp(ue, { op: 'cell-attach' }, 0);
    expect(assocSeq(h.events)).toEqual(['idle>searching', `searching>detached(${CELL_DETACH_REASONS.noCell})`]);
    expect(h.events[0]).toMatchObject({ medium: CELL_NO_TOWER_MEDIUM });
    expect(h.notes).toEqual([{ ref: ue, ev: { kind: 'cell-detached', reason: 'no-cell' }, t: 0 }]);
    expect(h.scheduler.size).toBe(0);

    h.events.length = 0;
    h.cell.mediumOp(ue, { op: 'cell-attach' }, 5);
    expect(h.events).toEqual([]);
    expect(h.notes).toHaveLength(1);
  });

  it('a tower at its client limit is skipped', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    h.port(tower).spec.radio = { ...TOWER_RADIO, maxClients: 1 };
    const one = h.addUe('d_p1', 50, 0, '02:00:00:00:20:01');
    const two = h.addUe('d_p2', 60, 0, '02:00:00:00:20:02');
    h.attach(one);
    h.attach(two);
    expect(h.cell.attachment(one)?.state).toBe('attached');
    expect(h.cell.attachment(two)).toMatchObject({ state: 'detached', reason: 'no-cell' });
  });

  it('re-checks the tower when the attach timer fires', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.cell.mediumOp(ue, { op: 'cell-attach' }, 0);
    h.powered.set('d_tower', false);
    // the facade reports the power change; the attaching UE fails at once
    h.cell.onPortChanged(tower, 10, 'power');
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'detached', reason: 'tower-down' });
    expect(h.notes.at(-1)).toEqual({ ref: ue, ev: { kind: 'cell-detached', reason: 'tower-down' }, t: 10 });
    expect(h.scheduler.size).toBe(0);

    // without the port report the timer itself notices
    const g = harness();
    const t2 = g.addTower('d_tower', 0, 0);
    const u2 = g.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    g.cell.mediumOp(u2, { op: 'cell-attach' }, 0);
    g.port(t2).adminUp = false;
    g.runUntil(RF.CELL_ATTACH_NS);
    expect(g.cell.attachment(u2)).toMatchObject({ state: 'detached', reason: 'tower-down' });
    expect(g.port(u2).operUp).toBe(false);
  });

  it('remembers a request made while the adapter is down and starts when it is ready; power-off forgets it', () => {
    const h = harness();
    h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.port(ue).adminUp = false;
    h.events.length = 0;
    h.cell.mediumOp(ue, { op: 'cell-attach' }, 0);
    expect(h.events).toEqual([]);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'idle', wanted: true });

    h.port(ue).adminUp = true;
    h.cell.onPortChanged(ue, 1_000, 'admin');
    expect(h.cell.attachment(ue)?.state).toBe('attaching');
    h.runUntil(1_000 + RF.CELL_ATTACH_NS);
    expect(h.cell.attachment(ue)?.state).toBe('attached');

    h.powered.set('d_phone', false);
    expect(h.cell.onPortChanged(ue, 2_000_000_000, 'power')).toEqual([{ port: ue, operUp: false }]);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'idle', wanted: false, reason: 'power-off' });
    expect(h.notes.filter((n) => n.ev.kind === 'cell-detached')).toEqual([]);
    h.powered.set('d_phone', true);
    h.cell.onPortChanged(ue, 3_000_000_000, 'boot');
    expect(h.cell.attachment(ue)?.state).toBe('idle');
  });

  it('cell-detach from the daemon returns to idle without a notification', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.attach(ue);
    h.notes.length = 0;
    expect(h.cell.mediumOp(ue, { op: 'cell-detach', reason: 'admin-down' }, 1_000_000_000)).toEqual([{ port: ue, operUp: false }]);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'idle', wanted: false });
    expect(h.notes).toEqual([]);
    expect(h.kinds('portState').at(-1)).toMatchObject({ operUp: false, reason: 'disassociated' });
    expect(assocSeq(h.events).at(-1)).toBe('attached>idle(admin-down)');
    expect(h.snapshot().cells[0]).toMatchObject({ tower, ues: 0, up: true });
    // unrelated ops are ignored
    const op: MediumOp = { op: 'line-protocol', up: false };
    expect(h.cell.mediumOp(ue, op, 1)).toEqual([]);
  });
});

// ── data ──────────────────────────────────────────────────────────────────────

describe('link/media/cell data path', () => {
  it('UE frames: one loss draw per frame on cell:<cell>:<ueKey>, lte-derived timing, admit delivers', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.attach(ue);
    h.events.length = 0;
    const medium = cellId(tower);
    const now = h.scheduler.now;

    const pdu = h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta());
    const r = h.cell.transmit(ue, pdu, now);
    const txEnd = now + serializationNs(pdu.size + CELL_PHY_OVERHEAD_BYTES, TOP_RATE);
    const arrive = txEnd + propagationNs(25, 1.0);
    expect(r).toEqual({ ok: true, link: medium, txStart: now, txEnd, arrive });
    expect(h.events).toEqual([
      {
        t: now, kind: 'frameTx', pdu: expect.objectContaining({ id: pdu.id }), link: medium, from: ue, to: tower,
        txStart: now, txEnd, arrive, medium: 'cell', rateBps: TOP_RATE, rssiDbm: expect.any(Number),
      },
    ]);
    expect(h.port(ue).tx).toEqual({ busyUntil: txEnd, queue: 1 });
    expect(h.inflight.visible(now)).toEqual([expect.objectContaining({ link: medium, from: ue, to: tower, medium: 'cell', rateBps: TOP_RATE })]);

    const arrivals = h.runUntil(arrive);
    expect(h.port(ue).tx.queue).toBe(0);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({ device: 'd_tower', port: PORT, medium, pdu });
    expect(h.cell.admit(arrivals[0]!, arrive)).toEqual({ deliver: true, pdu, rx: { medium: 'cell' } });
    expect(h.inflight.size()).toBe(0);

    // two more frames: the UE stream advanced by exactly one draw per frame
    h.cell.transmit(ue, h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta()), arrive);
    h.cell.transmit(ue, h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta()), arrive);
    const probe = h.root.split(cellStreamLabel(medium, ue));
    for (let i = 0; i < 3; i++) probe.chance(0);
    expect(h.host.stream(cellStreamLabel(medium, ue)).nextU32()).toBe(probe.nextU32());
    expect([...h.streams.keys()]).toEqual([cellStreamLabel(medium, ue)]);
  });

  it('an unattached UE is refused not-associated, a shut radio link-down', () => {
    const h = harness();
    h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    const pdu = h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta());
    expect(h.cell.transmit(ue, pdu, 0)).toEqual({ ok: false, reason: 'not-associated' });
    expect(h.events.at(-1)).toMatchObject({ kind: 'drop', device: 'd_phone', port: PORT, reason: 'not-associated', detail: CELL_NOT_ATTACHED_DETAIL });
    h.port(ue).adminUp = false;
    expect(h.cell.transmit(ue, pdu, 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.scheduler.size).toBe(0);
  });

  it('tower frames: unicast to the attached MAC, group cloned to every UE but the source, unknown unicast refused', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const p1 = h.addUe('d_p1', 100, 0, '02:00:00:00:20:01');
    const p2 = h.addUe('d_p2', 0, 100, '02:00:00:00:20:02');
    const p3 = h.addUe('d_p3', -100, 0, '02:00:00:00:20:03');
    for (const ue of [p1, p2, p3]) h.attach(ue);
    const medium = cellId(tower);
    const now = h.scheduler.now;
    h.events.length = 0;

    const uni = h.pdus.build(frame('02:00:00:00:20:02', '02:00:00:00:99:99'), meta());
    const r1 = h.cell.transmit(tower, uni, now);
    expect(r1.ok).toBe(true);
    expect(h.kinds('frameTx').map((e) => (e.kind === 'frameTx' ? [e.to.device, e.pdu.id] : []))).toEqual([['d_p2', uni.id]]);

    const t2 = h.port(tower).tx.busyUntil;
    h.events.length = 0;
    const group = h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta());
    const r2 = h.cell.transmit(tower, group, t2);
    expect(r2.ok).toBe(true);
    const txs = h.kinds('frameTx').flatMap((e) => (e.kind === 'frameTx' ? [e] : []));
    expect(txs.map((e) => e.to.device)).toEqual(['d_p2', 'd_p3']);
    expect(txs.every((e) => e.pdu.id !== group.id && e.pdu.parent === group.id)).toBe(true);
    expect(new Set(txs.map((e) => e.pdu.id)).size).toBe(2);
    expect(h.port(tower).tx.queue).toBe(2);
    // each receiver's stream took exactly one draw for its own leg
    expect([...h.streams.keys()].sort()).toEqual([cellStreamLabel(medium, p2), cellStreamLabel(medium, p3)].sort());

    h.events.length = 0;
    const lost = h.pdus.build(frame('02:00:00:00:77:77', '02:00:00:00:99:99'), meta());
    expect(h.cell.transmit(tower, lost, t2)).toEqual({ ok: false, reason: 'not-associated' });
    expect(h.events).toEqual([expect.objectContaining({ kind: 'drop', device: 'd_tower', reason: 'not-associated', detail: CELL_UNKNOWN_UE_DETAIL, medium })]);

    // a group frame with nobody else attached is accepted and carries no leg
    const g = harness();
    const tw = g.addTower('d_tower', 0, 0);
    const only = g.addUe('d_p1', 100, 0, '02:00:00:00:20:01');
    g.attach(only);
    g.events.length = 0;
    const echo = g.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta());
    const r3 = g.cell.transmit(tw, echo, g.scheduler.now);
    expect(r3).toMatchObject({ ok: true, link: cellId(tw) });
    expect(g.events).toEqual([]);
  });

  it('admit refuses a frame whose UE left the cell meanwhile', () => {
    const h = harness();
    h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.attach(ue);
    const pdu = h.pdus.build(frame('ff:ff:ff:ff:ff:ff', '02:00:00:00:20:01'), meta());
    const r = h.cell.transmit(ue, pdu, h.scheduler.now);
    if (!r.ok) throw new Error('expected ok');
    const arrival = h.runUntil(r.arrive)[0]!;
    // force the record out without the abort path (the arrival was already popped)
    h.cell.mediumOp(ue, { op: 'cell-detach' }, r.arrive);
    h.events.length = 0;
    expect(h.cell.admit(arrival, r.arrive)).toEqual({ deliver: false });
    // the UE is idle (off the cell), so the sender is unknown: the drop names the cell but no association
    expect(h.events).toEqual([expect.objectContaining({ kind: 'drop', reason: 'not-associated', device: 'd_tower', port: PORT, medium: r.link, detail: CELL_NOT_ATTACHED_DETAIL })]);
    expect(h.events[0]).not.toHaveProperty('association');
    expect(cellAssociationId(r.link, ue)).toBe(`${r.link}|d_phone/Cellular0`);
  });
});

// ── mobility ──────────────────────────────────────────────────────────────────

describe('link/media/cell mobility and tower loss', () => {
  it('beyond the drop threshold a 2 s hold runs; moving back cancels it; expiry detaches out-of-range', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.attach(ue);
    const t0 = h.scheduler.now;
    const rf0 = h.kinds('rfState').length;

    // a small move keeps bars and rate: no rfState
    h.positions.set('d_phone', { x: 110, y: 0 });
    expect(h.cell.onDevicesMoved(['d_phone'], t0)).toEqual([]);
    expect(h.kinds('rfState')).toHaveLength(rf0);

    // 1.5 km: below the drop threshold → hold
    h.positions.set('d_phone', { x: 6_000, y: 0 });
    h.cell.onDevicesMoved(['d_phone'], t0);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'attached', holdUntil: t0 + RF.RF_HOLD_NS });
    expect(h.port(ue).operUp).toBe(true);
    expect(h.kinds('rfState').length).toBeGreaterThan(rf0);
    expect(h.snapshot().associations[0]).toMatchObject({ holdUntil: t0 + RF.RF_HOLD_NS, state: 'attached' });

    // back in range before expiry → hold cancelled
    h.positions.set('d_phone', { x: 100, y: 0 });
    h.cell.onDevicesMoved(['d_phone'], t0 + 1_000);
    expect(h.cell.attachment(ue)?.holdUntil).toBeUndefined();
    expect(h.scheduler.size).toBe(0);

    // a frame queued behind a long transmission (sent while still in range, so it is not lost) …
    const pdu = h.pdus.build(frame('02:00:00:00:10:01', '02:00:00:00:20:01'), meta());
    h.port(ue).tx.busyUntil = t0 + 3 * RF.RF_HOLD_NS;
    const r = h.cell.transmit(ue, pdu, t0 + 1_500);
    if (!r.ok || r.lost === true) throw new Error('expected a leg in the air');
    // … then away again, and the hold expires while that leg is still in the air
    h.positions.set('d_phone', { x: 6_000, y: 0 });
    h.cell.onDevicesMoved(['d_phone'], t0 + 2_000);
    h.events.length = 0;
    h.notes.length = 0;
    const holdEv = h.scheduler.next()!;
    expect(holdEv).toMatchObject({ kind: 'mediumTimer', medium: cellId(tower), key: cellHoldKey(ue), at: t0 + 2_000 + RF.RF_HOLD_NS });
    if (holdEv.kind !== 'mediumTimer') throw new Error('expected hold');
    expect(h.cell.onMediumTimer(holdEv.medium, holdEv.key, holdEv.at)).toEqual([{ port: ue, operUp: false }]);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'detached', reason: 'out-of-range' });
    expect(h.notes).toEqual([{ ref: ue, ev: { kind: 'cell-detached', reason: 'out-of-range' }, t: holdEv.at }]);
    expect(h.kinds('frameAbort')).toEqual([expect.objectContaining({ from: ue, to: tower, reason: 'out-of-range', abortAt: holdEv.at })]);
    expect(h.kinds('drop')).toEqual([expect.objectContaining({ reason: 'out-of-range', link: cellId(tower) })]);
    expect(h.inflight.size()).toBe(0);
    expect(assocSeq(h.events)).toEqual(['attached>detached(out-of-range)']);
  });

  it('setScale re-assesses attached pairs; a tower shutdown detaches its UEs with tower-down', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 1_000, 0, '02:00:00:00:20:01'); // 250 m
    h.attach(ue);
    const t0 = h.scheduler.now;
    h.cell.setScale(2, t0); // 2 km
    expect(h.cell.metresPerUnit()).toBe(2);
    expect(h.cell.attachment(ue)?.holdUntil).toBe(t0 + RF.RF_HOLD_NS);
    h.cell.setScale(0.25, t0 + 1);
    expect(h.cell.attachment(ue)?.holdUntil).toBeUndefined();
    expect(h.cell.setScale(-1, t0 + 2)).toEqual([]);

    h.notes.length = 0;
    h.port(tower).adminUp = false;
    expect(h.cell.onPortChanged(tower, t0 + 3, 'admin')).toEqual([
      { port: tower, operUp: false },
      { port: ue, operUp: false },
    ]);
    expect(h.cell.attachment(ue)).toMatchObject({ state: 'detached', reason: 'tower-down' });
    expect(h.notes).toEqual([{ ref: ue, ev: { kind: 'cell-detached', reason: 'tower-down' }, t: t0 + 3 }]);
    expect(h.snapshot().cells[0]).toMatchObject({ up: false, ues: 0 });
  });
});

// ── snapshot ──────────────────────────────────────────────────────────────────

describe('link/media/cell snapshot', () => {
  it('lists the cell with its range ring and the association, structured-clone safe', () => {
    const h = harness();
    const tower = h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', 100, 0, '02:00:00:00:20:01');
    h.attach(ue);
    const snap = h.snapshot();
    expect(snap.cells).toEqual([{ id: cellId(tower), tower, up: true, ues: 1, rangeM: expect.any(Number) }]);
    expect(snap.cells[0]!.rangeM).toBeGreaterThan(500);
    expect(snap.cells[0]!.rangeM).toBeLessThanOrEqual(TOWER_RADIO.maxRangeM);
    expect(snap.associations).toEqual([
      {
        id: cellAssociationId(cellId(tower), ue), tech: 'cellular', medium: cellId(tower), ap: tower, station: ue, band: 'cell', channel: 0,
        state: 'attached', authorized: true, rssiDbm: expect.any(Number), snrDb: expect.any(Number), rateBps: TOP_RATE, bars: 4,
        distanceM: 25, since: RF.CELL_ATTACH_NS,
      },
    ]);
    expect(() => structuredClone(snap)).not.toThrow();
  });
});

// ── cell-client daemon ───────────────────────────────────────────────────────

function daemonCtx(ports: PortView[], now = 0) {
  const debug: DebugEvent[] = [];
  const map = new Map<PortId, PortView>(ports.map((p) => [p.id, p]));
  let t = now;
  const ctx = {
    get now() {
      return t;
    },
    deviceId: 'd_phone',
    hostname: 'Phone1',
    ports: map,
    debug(category: string, message: string, data?: Record<string, unknown>) {
      debug.push(data ? { at: t, device: 'd_phone', process: CELL_CLIENT, category, message, data } : { at: t, device: 'd_phone', process: CELL_CLIENT, category, message });
    },
  } as unknown as ProcessCtx;
  return { ctx, debug, map, setNow: (n: number) => void (t = n) };
}

const ueView = (over: Partial<PortState> = {}): PortView => ({ ...radioPort('cellular', CELLULAR_UE_RADIO, UE_SPEED, '02:00:00:00:20:01'), ...over });
const ifaceDelta = (op: 'set' | 'unset'): ConfigDelta => ({ op, context: [['interface', PORT]], line: ['shutdown'] });

describe('protocols/cell-client', () => {
  it('manages only UE cellular adapters', () => {
    expect(isCellularAdapter(ueView())).toBe(true);
    expect(isCellularAdapter(radioPort('wireless-bss', TOWER_RADIO, TOWER_SPEED, '02:00:00:00:10:01'))).toBe(false);
    const eth = { ...ueView(), spec: testPortSpec({ name: 'Gi0', short: 'Gi0', kind: 'ethernet', speedBps: 1e9 }), role: 'routed' as const };
    expect(isCellularAdapter(eth)).toBe(false);
  });

  it('asks to attach at boot, re-searches periodically while detached, stops once attached', () => {
    const d = createCellClient();
    const f = daemonCtx([ueView()]);
    expect(d.init!(f.ctx)).toEqual([{ type: 'medium', port: PORT, op: { op: 'cell-attach' } }]);

    const detached = d.onMediumEvent!(f.ctx, PORT, { kind: 'cell-detached', reason: 'no-cell' });
    expect(detached).toEqual([{ type: 'timer', key: cellResearchTimerKey(PORT), delay: CELL_RESEARCH_NS, periodic: true }]);
    expect(d.stateSnapshot().state).toEqual({
      ports: [{ port: PORT, phase: 'detached', tower: null, reason: 'no-cell', requests: 1, operUp: false, since: 0 }],
    });

    f.setNow(CELL_RESEARCH_NS);
    expect(d.onTimer(f.ctx, cellResearchTimerKey(PORT))).toEqual([
      { type: 'medium', port: PORT, op: { op: 'cell-attach' } },
      { type: 'timer', key: cellResearchTimerKey(PORT), delay: CELL_RESEARCH_NS, periodic: true },
    ]);

    const tower = { device: 'd_tower', port: PORT };
    expect(d.onMediumEvent!(f.ctx, PORT, { kind: 'cell-attached', tower })).toEqual([{ type: 'cancelTimer', key: cellResearchTimerKey(PORT) }]);
    expect(d.onTimer(f.ctx, cellResearchTimerKey(PORT))).toEqual([]);
    expect(d.onLinkChange!(f.ctx, PORT, true)).toEqual([]);
    expect(d.stateSnapshot().state).toMatchObject({ ports: [{ phase: 'attached', tower: 'd_tower/Cellular0', requests: 2, operUp: true }] });
    expect(f.debug.every((e) => e.category === 'wireless')).toBe(true);
    expect(d.debugEvents().length).toBe(f.debug.length);
    expect(() => structuredClone(d.stateSnapshot())).not.toThrow();
  });

  it('shutdown detaches and cancels the re-search; no shutdown asks again; a shut adapter stays quiet at boot', () => {
    const d = createCellClient();
    const f = daemonCtx([ueView({ adminUp: false })]);
    expect(d.init!(f.ctx)).toEqual([]);
    expect(d.onMediumEvent!(f.ctx, PORT, { kind: 'cell-detached', reason: 'no-cell' })).toEqual([]);

    f.map.set(PORT, ueView());
    expect(d.onConfig(f.ctx, ifaceDelta('unset'))).toEqual([{ type: 'medium', port: PORT, op: { op: 'cell-attach' } }]);
    // a repeated unset while searching is a no-op
    expect(d.onConfig(f.ctx, ifaceDelta('unset'))).toEqual([]);
    expect(d.onConfig(f.ctx, ifaceDelta('set'))).toEqual([
      { type: 'cancelTimer', key: cellResearchTimerKey(PORT) },
      { type: 'medium', port: PORT, op: { op: 'cell-detach', reason: 'admin-down' } },
    ]);
    // other lines and other interfaces are ignored
    expect(d.onConfig(f.ctx, { op: 'set', context: [['interface', 'Wlan0']], line: ['shutdown'] })).toEqual([]);
    expect(d.onConfig(f.ctx, { op: 'set', context: [], line: ['hostname', 'P'] })).toEqual([]);
    expect(d.onTimer(f.ctx, 'unrelated')).toEqual([]);
    expect(d.onPdu(f.ctx, {} as Pdu, PORT)).toEqual([]);
  });
});

// ── daemon ↔ medium loop ─────────────────────────────────────────────────────

describe('cell-client with the cellular medium', () => {
  /** Minimal device loop: daemon actions → medium, medium notifications → daemon, timers of both. */
  function world(seed: number, ueX: number) {
    const h = harness(seed);
    h.addTower('d_tower', 0, 0);
    const ue = h.addUe('d_phone', ueX, 0, '02:00:00:00:20:01');
    const daemon = createCellClient();
    const f = daemonCtx([h.port(ue)]);
    const daemonTimers = new Map<string, number>();
    const apply = (actions: Action[]): void => {
      for (const a of actions) {
        if (a.type === 'medium') h.cell.mediumOp(ue, a.op, h.scheduler.now);
        else if (a.type === 'timer') daemonTimers.set(a.key, h.scheduler.now + a.delay);
        else if (a.type === 'cancelTimer') daemonTimers.delete(a.key);
      }
    };
    const flush = (): void => {
      while (h.notes.length > 0) {
        const n = h.notes.shift()!;
        apply(daemon.onMediumEvent!(f.ctx, n.ref.port, n.ev));
      }
    };
    const step = (until: number): void => {
      h.runUntil(until);
      f.setNow(until);
      flush();
      for (const [key, at] of [...daemonTimers]) {
        if (at <= until) {
          daemonTimers.delete(key);
          apply(daemon.onTimer(f.ctx, key));
          flush();
        }
      }
    };
    apply(daemon.init!(f.ctx));
    flush();
    return { h, ue, daemon, step, daemonTimers, f };
  }

  it('boot → attached after 300 ms; the trace is identical on every run', () => {
    const runs = [1, 2, 3].map(() => {
      const w = world(9, 200);
      w.step(RF.CELL_ATTACH_NS);
      expect(w.h.port(w.ue).operUp).toBe(true);
      expect(w.daemon.stateSnapshot().state).toMatchObject({ ports: [{ phase: 'attached', tower: 'd_tower/Cellular0' }] });
      expect(w.daemonTimers.size).toBe(0);
      return JSON.stringify(w.h.events);
    });
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('out of range at boot: periodic re-search, then attach once the phone is carried into range', () => {
    const w = world(9, 40_000);
    expect(w.daemonTimers.get(cellResearchTimerKey(PORT))).toBe(CELL_RESEARCH_NS);
    w.step(CELL_RESEARCH_NS);
    expect(w.daemonTimers.get(cellResearchTimerKey(PORT))).toBe(2 * CELL_RESEARCH_NS);
    expect(assocSeq(w.h.events)).toEqual(['idle>searching', 'searching>detached(no-cell)']);

    w.h.positions.set('d_phone', { x: 300, y: 0 });
    w.step(2 * CELL_RESEARCH_NS);
    w.step(2 * CELL_RESEARCH_NS + RF.CELL_ATTACH_NS);
    expect(w.h.cell.attachment(w.ue)?.state).toBe('attached');
    expect(w.daemonTimers.size).toBe(0);
    expect(assocSeq(w.h.events)).toEqual(['idle>searching', 'searching>detached(no-cell)', 'detached>searching', 'searching>attaching', 'attaching>attached']);
  });
});
