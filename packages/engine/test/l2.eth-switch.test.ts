import { describe, expect, it } from 'vitest';
import { createConfigAst } from '../src/cli/config-ast.js';
import type { Rng } from '../src/contracts/rng.js';
import { createRng } from '../src/core/prng.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  CAM_SWEEP_INTERVAL_NS,
  CAM_SWEEP_TIMER,
  DETAIL_FILTERED,
  DETAIL_NO_EGRESS,
  ETH_SWITCH_DEBUG_CATEGORY,
  ETH_SWITCH_DEBUG_RING,
  createEthSwitch,
} from '../src/protocols/eth-switch.js';
import { defineModel } from '../src/device/catalog/define.js';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import { BRIDGED_ROLES } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { NF_C2960_INPUT } from './device.catalog.p0-inputs.js';
import type { PortId } from '../src/contracts/ids.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { DEFAULT_MTU, SPEED_100M, emptyCounters } from '../src/contracts/port.js';
import type { PortView } from '../src/contracts/port.js';
import type { Action, DebugEvent, ProcessCtx } from '../src/contracts/process.js';
import { CAM_AGEING_NS, camKey } from '../src/contracts/tables.js';
import type { ArpRow, CamRow, RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { NO_IPV6_CTX, P2_CTX, p0Tables, testPortSpec } from './port.fixtures.js';

const DEVICE = 'd_sw1';
const P1 = 'FastEthernet0/1';
const P2 = 'FastEthernet0/2';
const P3 = 'FastEthernet0/3';
const P4 = 'FastEthernet0/4';
const MAC_A = '00:1f:00:00:00:0a';
const MAC_B = '00:1f:00:00:00:0b';
const MAC_C = '00:1f:00:00:00:0c';
const MAC_MCAST = '01:00:5e:00:00:01';

/** The catalog v2 NF-C2960 (capabilities switching, bridged ports, ipDefaults). */
const MODEL: DeviceModel = defineModel(NF_C2960_INPUT, 'P0.5');

/** A minimal PortView for the fake ctx (only fields the switch reads matter). */
function fakePort(id: PortId, index: number, operUp = true): PortView {
  return {
    id,
    spec: testPortSpec({ name: id, short: `Fa0/${index}`, kind: 'ethernet', speedBps: SPEED_100M, autoMdix: true }, ['switching'], index),
    mac: `00:1f:00:00:01:${index.toString(16).padStart(2, '0')}`,
    adminUp: true,
    operUp,
    mtu: DEFAULT_MTU,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role: 'switched',
    ordinal: index,
    encap: 'ethernet',
  };
}

interface Harness {
  ctx: ProcessCtx;
  ports: Map<PortId, PortView>;
  trace: TraceEvent[];
  debug: DebugEvent[];
  setNow(t: number): void;
  setOper(port: PortId, up: boolean): void;
  frame(src: string, dst: string, op?: number): Pdu;
}

/** Fake ProcessCtx: real tables (collecting sink), real pdu factory, clone delegating to the factory. */
function harness(portIds: readonly PortId[] = [P1, P2, P3, P4]): Harness {
  let now = 0;
  const trace: TraceEvent[] = [];
  const debug: DebugEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => { trace.push(ev); } };
  const clock = () => now;
  const tables = p0Tables({
    cam: createTable<CamRow>({ name: 'cam', device: DEVICE, sink, now: clock }),
    arp: createTable<ArpRow>({ name: 'arp', device: DEVICE, sink, now: clock }),
    rib: createTable<RouteRow>({ name: 'rib', device: DEVICE, sink, now: clock }),
  });
  const ports = new Map<PortId, PortView>();
  portIds.forEach((id, i) => ports.set(id, fakePort(id, i + 1)));
  const factory = createPduFactory();
  const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: now, origin: DEVICE, ...over });

  const rng = createRng(7);
  const streams = new Map<string, Rng>();

  const ctx: ProcessCtx = {
    ...P2_CTX,
    ...NO_IPV6_CTX,
    get now() { return now; },
    deviceId: DEVICE,
    hostname: 'Switch',
    model: MODEL,
    ports,
    tables,
    config: createConfigAst(),
    rng,
    stream(label) {
      let s = streams.get(label);
      if (s === undefined) {
        s = rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    debug(category, message, data) {
      debug.push(data === undefined
        ? { at: now, device: DEVICE, process: 'eth-switch', category, message }
        : { at: now, device: DEVICE, process: 'eth-switch', category, message, data });
    },
    newPdu(layers, m) { return factory.build(layers, meta(m)); },
    mutate(pdu, field, after, reason, cause) { pdu.mutate({ now, device: DEVICE }, field, after, reason, cause); },
    encapsulate(pdu, outer, cause) { pdu.encapsulate({ now, device: DEVICE }, outer, cause); },
    clone(pdu) { return factory.clone(pdu, now); },
    lpm() { return { candidates: [] }; },
    ownAddress() { return undefined; },
    isLocalDestination() { return false; },
    connectedPortFor() { return undefined; },
    sourceFor() { return undefined; },
    macOf(port) { return ports.get(port)!.mac; },
    rewrap(pdu, op, cause) { pdu.rewrap({ now, device: DEVICE }, op, cause); },
    hasCapability(cap) { return MODEL.capabilities.includes(cap); },
  };

  const frame = (src: string, dst: string, op = ARP_OP_REQUEST): Pdu => {
    const layers: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op, sha: src, spa: '10.0.0.1', tha: dst === MAC_BROADCAST ? '00:00:00:00:00:00' : dst, tpa: '10.0.0.2' } },
    ];
    return factory.build(layers, meta({ origin: 'd_pc1' }));
  };

  return {
    ctx,
    ports,
    trace,
    debug,
    setNow: (t) => { now = t; },
    setOper: (port, up) => { ports.set(port, { ...ports.get(port)!, operUp: up }); },
    frame,
  };
}

const sends = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'send' }> => a.type === 'send');
const drops = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');

describe('protocols/eth-switch', () => {
  it('is named eth-switch and asks for every ethernet frame', () => {
    const sw = createEthSwitch();
    expect(sw.name).toBe('eth-switch');
    // P0.5 (process.ts, §9.2): every frame on a bridged role; HDLC too, for the transparent serial relay.
    expect(sw.handles).toEqual([{ layer: 'ethernet', roles: BRIDGED_ROLES }, { layer: 'hdlc', roles: BRIDGED_ROLES }]);
    expect(sw.stateSnapshot()).toEqual({
      process: 'eth-switch',
      state: { vlan: 1, ageingNs: CAM_AGEING_NS, entries: 0, floods: 0, forwards: 0, filtered: 0, learned: 0, moved: 0, aged: 0 },
    });
  });

  it('init arms the cam-sweep timer every 15 s', () => {
    const h = harness();
    const sw = createEthSwitch();
    expect(sw.init!(h.ctx)).toEqual([{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }]);
    expect(CAM_SWEEP_INTERVAL_NS).toBe(15 * SEC);
    expect(h.debug[0]?.category).toBe(ETH_SWITCH_DEBUG_CATEGORY);
  });

  it('learns the source and floods a broadcast to every other port, original first then clones', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.setNow(1000);
    const pdu = h.frame(MAC_A, MAC_BROADCAST);
    const actions = sw.onPdu(h.ctx, pdu, P1);

    // CAM row
    const row = h.ctx.tables.cam.get(camKey(1, MAC_A));
    expect(row).toEqual({ key: '1/' + MAC_A, mac: MAC_A, vlan: 1, port: P1, type: 'dynamic', updatedAt: 1000, expiresAt: 1000 + CAM_AGEING_NS });
    const writes = h.trace.filter((e) => e.kind === 'tableWrite');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: 'tableWrite', table: 'cam', key: '1/' + MAC_A, t: 1000, device: DEVICE });

    // flood: one send per other port, in ctx.ports insertion order
    expect(actions.map((a) => a.type)).toEqual(['send', 'send', 'send']);
    const out = sends(actions);
    expect(out.map((a) => a.port)).toEqual([P2, P3, P4]);
    expect(out[0]!.pdu).toBe(pdu);
    for (const a of out.slice(1)) {
      expect(a.pdu).not.toBe(pdu);
      expect(a.pdu.id).not.toBe(pdu.id);
      expect(a.pdu.meta.parent).toBe(pdu.id);
      expect(a.pdu.bytes).toEqual(pdu.bytes);
      expect(a.pdu.summary()).toBe(pdu.summary());
    }
    expect(new Set(out.map((a) => a.pdu.id)).size).toBe(3);

    // debug events with original wording
    const messages = h.debug.map((d) => d.message);
    expect(messages.some((m) => m === `learned ${MAC_A} on ${P1} (vlan 1)`)).toBe(true);
    expect(messages.some((m) => m.startsWith(`flooding broadcast frame for ${MAC_BROADCAST} from ${P1} to 3 port(s): ${P2}, ${P3}, ${P4}`))).toBe(true);
    for (const d of h.debug) expect(d.category).toBe(ETH_SWITCH_DEBUG_CATEGORY);
    expect(sw.debugEvents().map((d) => d.message)).toEqual(messages);

    expect(sw.stateSnapshot().state).toMatchObject({ entries: 1, floods: 1, forwards: 0, filtered: 0, learned: 1 });
  });

  it('floods unknown unicast and multicast destinations too', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    const unknown = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_C, ARP_OP_REPLY), P1);
    expect(sends(unknown).map((a) => a.port)).toEqual([P2, P3, P4]);
    expect(h.debug.at(-1)!.message).toContain('flooding unknown unicast frame');
    const mcast = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_MCAST), P2);
    expect(sends(mcast).map((a) => a.port)).toEqual([P1, P3, P4]);
    expect(h.debug.at(-1)!.message).toContain('flooding multicast frame');
    expect(sw.stateSnapshot().state).toMatchObject({ floods: 2 });
  });

  it('forwards a known unicast destination out its learned port with the original pdu', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P2);
    h.setNow(5000);
    const pdu = h.frame(MAC_A, MAC_B, ARP_OP_REPLY);
    const actions = sw.onPdu(h.ctx, pdu, P1);
    expect(actions).toEqual([{ type: 'send', port: P2, pdu }]);
    expect(actions[0]!.type === 'send' && actions[0].pdu).toBe(pdu);
    expect(h.debug.at(-1)!.message).toBe(`forwarding frame for ${MAC_B} from ${P1} out ${P2} (vlan 1)`);
    // the source row was refreshed, not re-learned
    expect(h.ctx.tables.cam.get(camKey(1, MAC_A))!.updatedAt).toBe(5000);
    expect(sw.stateSnapshot().state).toMatchObject({ entries: 2, floods: 2, forwards: 1, filtered: 0, learned: 2, moved: 0 });
  });

  it('filters a frame whose destination is on the ingress port', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    // A and B both hang off P1 (a hub behind the port)
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P1);
    const pdu = h.frame(MAC_A, MAC_B, ARP_OP_REPLY);
    const actions = sw.onPdu(h.ctx, pdu, P1);
    expect(actions).toEqual([{ type: 'drop', pdu, reason: 'other', detail: DETAIL_FILTERED, port: P1 }]);
    expect(h.debug.at(-1)!.message).toContain(DETAIL_FILTERED);
    expect(sw.stateSnapshot().state).toMatchObject({ filtered: 1, forwards: 0 });
  });

  it('never learns a broadcast or multicast source but still floods the frame', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    const a = sw.onPdu(h.ctx, h.frame(MAC_BROADCAST, MAC_BROADCAST), P1);
    const b = sw.onPdu(h.ctx, h.frame(MAC_MCAST, MAC_BROADCAST), P2);
    expect(sends(a).map((x) => x.port)).toEqual([P2, P3, P4]);
    expect(sends(b).map((x) => x.port)).toEqual([P1, P3, P4]);
    expect(h.ctx.tables.cam.size).toBe(0);
    expect(h.trace.filter((e) => e.kind === 'tableWrite')).toHaveLength(0);
    expect(h.debug.some((d) => d.message.startsWith('learned'))).toBe(false);
    expect(sw.stateSnapshot().state).toMatchObject({ entries: 0, learned: 0 });
  });

  it('records a move when a MAC shows up on a different port', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    h.setNow(2000);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P3);
    const row = h.ctx.tables.cam.get(camKey(1, MAC_A))!;
    expect(row.port).toBe(P3);
    expect(row.updatedAt).toBe(2000);
    expect(row.expiresAt).toBe(2000 + CAM_AGEING_NS);
    expect(h.ctx.tables.cam.size).toBe(1);
    expect(h.debug.some((d) => d.message === `${MAC_A} moved from ${P1} to ${P3} (vlan 1)`)).toBe(true);
    expect(sw.stateSnapshot().state).toMatchObject({ learned: 1, moved: 1, entries: 1 });
  });

  it('does not overwrite a static CAM row', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.ctx.tables.cam.set({ key: camKey(1, MAC_A), mac: MAC_A, vlan: 1, port: P4, type: 'static', updatedAt: 0 });
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    const row = h.ctx.tables.cam.get(camKey(1, MAC_A))!;
    expect(row.port).toBe(P4);
    expect(row.type).toBe('static');
    expect(row.expiresAt).toBeUndefined();
  });

  it('sweep timer ages a silent entry out after 300 s and always re-arms', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    let t = 0;
    for (let i = 1; i <= 19; i++) {
      t = i * CAM_SWEEP_INTERVAL_NS; // 15 s … 285 s
      h.setNow(t);
      const actions = sw.onTimer(h.ctx, CAM_SWEEP_TIMER);
      expect(actions).toEqual([{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }]);
      expect(h.ctx.tables.cam.size).toBe(1);
    }
    h.setNow(300 * SEC);
    const actions = sw.onTimer(h.ctx, CAM_SWEEP_TIMER);
    expect(actions).toEqual([{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }]);
    expect(h.ctx.tables.cam.size).toBe(0);
    const expired = h.trace.filter((e) => e.kind === 'tableExpire');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ kind: 'tableExpire', table: 'cam', key: camKey(1, MAC_A), reason: 'aged', t: 300 * SEC });
    expect(h.debug.at(-1)!.message).toBe(`aged out ${MAC_A} on ${P1} (vlan 1) after 300 s of silence`);
    expect(sw.stateSnapshot().state).toMatchObject({ entries: 0, aged: 1 });
    // a refreshed entry survives the sweep that would have aged the original
    h.setNow(301 * SEC);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P2);
    h.setNow(590 * SEC);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P2);
    h.setNow(601 * SEC);
    sw.onTimer(h.ctx, CAM_SWEEP_TIMER);
    expect(h.ctx.tables.cam.size).toBe(1);
  });

  it('ignores unknown timers and config deltas', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    expect(sw.onTimer(h.ctx, 'something-else')).toEqual([]);
    expect(sw.onConfig(h.ctx, { op: 'set', context: [], line: ['hostname', 'SW1'] })).toEqual([]);
    expect(sw.onConfig(h.ctx, { op: 'set', context: [['interface', P1]], line: ['shutdown'] })).toEqual([]);
  });

  it('purges the CAM rows of a port that went down and leaves the others', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), P1);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P2);
    h.setNow(7000);
    expect(sw.onLinkChange!(h.ctx, P1, false)).toEqual([]);
    expect(h.ctx.tables.cam.rows().map((r) => r.mac)).toEqual([MAC_B]);
    const expired = h.trace.filter((e) => e.kind === 'tableExpire');
    expect(expired.map((e) => (e.kind === 'tableExpire' ? [e.key, e.reason, e.t] : null))).toEqual([
      [camKey(1, MAC_A), 'link-down', 7000],
      [camKey(1, MAC_C), 'link-down', 7000],
    ]);
    expect(h.debug.slice(-2).map((d) => d.message)).toEqual([
      `removed ${MAC_A} on ${P1} (vlan 1): link down`,
      `removed ${MAC_C} on ${P1} (vlan 1): link down`,
    ]);
    // link up is a no-op
    const before = h.trace.length;
    expect(sw.onLinkChange!(h.ctx, P1, true)).toEqual([]);
    expect(h.trace.length).toBe(before);
    expect(sw.stateSnapshot().state).toMatchObject({ entries: 1 });
  });

  it('drops with "no egress port" when every other port is down, and skips down ports when flooding', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.setOper(P3, false);
    const partial = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1);
    expect(sends(partial).map((a) => a.port)).toEqual([P2, P4]);
    h.setOper(P2, false);
    h.setOper(P4, false);
    const pdu = h.frame(MAC_A, MAC_BROADCAST);
    const actions = sw.onPdu(h.ctx, pdu, P1);
    expect(actions).toEqual([{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port: P1 }]);
    expect(drops(actions)).toHaveLength(1);
    expect(sw.stateSnapshot().state).toMatchObject({ floods: 1 });
    // a known destination whose port is down is also dropped, not sent
    h.setOper(P2, true);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), P2);
    h.setOper(P2, false);
    const known = h.frame(MAC_A, MAC_B, ARP_OP_REPLY);
    expect(sw.onPdu(h.ctx, known, P1)).toEqual([{ type: 'drop', pdu: known, reason: 'other', detail: DETAIL_NO_EGRESS, port: P1 }]);
  });

  it('floods in ctx.ports insertion order, identically on every run', () => {
    const order = [P3, P1, P4, P2];
    const run = () => {
      const h = harness(order);
      const sw = createEthSwitch();
      sw.init!(h.ctx);
      const out = sends(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P4));
      return { ports: out.map((a) => a.port), ids: out.map((a) => a.pdu.id), parents: out.map((a) => a.pdu.meta.parent) };
    };
    const first = run();
    expect(first.ports).toEqual([P3, P1, P2]);
    expect(first.ids).toEqual([1, 2, 3]);
    expect(first.parents).toEqual([undefined, 1, 1]);
    expect(run()).toEqual(first);
    expect(run()).toEqual(first);
  });

  it('keeps a bounded debug ring of the newest events', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    for (let i = 0; i < 250; i++) {
      h.setNow(i);
      sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), P1); // 1 init + 1 learn + 250 floods
    }
    expect(h.debug.length).toBe(252);
    const ring = sw.debugEvents();
    expect(ring).toHaveLength(ETH_SWITCH_DEBUG_RING);
    expect(ring).toEqual(h.debug.slice(-ETH_SWITCH_DEBUG_RING));
    expect(ring.at(-1)!.at).toBe(249);
    expect(ring[0]!.at).toBe(250 - ETH_SWITCH_DEBUG_RING);
  });

  it('drops a pdu that carries no ethernet layer', () => {
    const h = harness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    const bare = h.ctx.newPdu([{ proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } }]);
    const actions = sw.onPdu(h.ctx, bare, P1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'drop', reason: 'other', port: P1 });
  });
});
