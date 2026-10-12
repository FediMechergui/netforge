// Packet inspector opened from a hop (ARCHITECTURE-P3 §9.2 ruling R57(b); §3.13 steps 7–8; W6 web-inspector): a
// Packets-list row or a provenance stop opens the inspector on the packet AS IT WAS ON THAT LEG (`inspectPduAtHop`), with
// that leg's banner — the ISP leg of an IPsec ping says "Encrypted (ESP, simulated)" although the engine now holds the
// packet decrypted at the far end — while a packet selected any other way keeps today's view. The leg is rebuilt from
// the packet's newest image by undoing the provenance recorded after it (`rewindToHop`); what it rebuilds is checked
// against what a live capture recorded on the same wire, in real worlds.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, SEC, createPduFactory, createSimulation } from '@netforge/engine';
import type { CaptureId, CaptureRecordDetail, LayerSpec, Mutation, PduJson, ScenarioInfo, Simulation, TraceEvent } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {
    catalog: [],
    snapshot: null,
    snapshotIndex: undefined,
    epoch: 0,
    events: [],
    selection: null,
    select(sel: unknown) {
      state.selection = sel;
    },
  };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});
// Provenance opens a device's configuration through the device inspector, whose terminal needs a browser.
vi.mock('../src/inspector/DeviceInspector', () => ({ openDeviceTab: () => undefined }));

import { store } from '../src/store/store';
import {
  HOP_LAYER_NOT_KEPT,
  PROTECTED_LAYER_MARK,
  PacketInspector,
  hopCut,
  hopProtection,
  hopRebuiltNote,
  inspectPduAtHop,
  protectedBannerTitle,
  rewindToHop,
  type PacketHop,
} from '../src/inspector/PacketInspector';
import { buildHops } from '../src/inspector/Provenance';
import { PacketRow, openPacketLeg } from '../src/inspector/DockPanels';
import { activateSimEvent } from '../src/simmode/SimEventsPanel';

type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;

const state = (store as unknown as { getState(): Record<string, unknown> }).getState();

/** Wall-clock budget of a test that boots a lab world. */
const WORLD_TEST_TIMEOUT_MS = 60_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function scenario(name: string): ScenarioInfo {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
}

/** A shipped world as `loadScenario` builds it, booted and settled. */
function world(name: string): Simulation {
  const lab = scenario(name);
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), ...(lab.tasks !== undefined ? { lab: { name: lab.name, version: lab.version ?? 1 } } : {}) });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

function idOf(sim: Simulation, name: string): string {
  const d = sim.devices().find((x) => x.spec.name === name);
  if (d === undefined) throw new Error(`no device ${name}`);
  return d.id;
}

/** One ping from `from` to `to` (the host's own count), run to the end; the trace it produced. */
function ping(sim: Simulation, from: string, to: string): TraceEvent[] {
  const evs: TraceEvent[] = [];
  const off = sim.onTrace((e) => evs.push(e));
  const s = sim.cli.open(from, 'console');
  sim.cli.exec(s, `ping ${to}`);
  expect(sim.runToIdle().stopped).toBeUndefined();
  off();
  return evs;
}

/** The legs of packet `id`, in order. */
function legsOf(evs: readonly TraceEvent[], id: number): FrameTx[] {
  return evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === id);
}

/** What the capture recorded of packet `id` leaving `leg.from` (the tap's tx record of that leg). */
function recorded(sim: Simulation, cap: CaptureId, leg: FrameTx): CaptureRecordDetail {
  const info = sim.captures().find((c) => c.id === cap);
  const iface = info?.interfaces.find((i) => i.ref?.device === leg.from.device && i.ref.port === leg.from.port);
  const row = sim.queryCapture(cap, { from: 0, limit: 500 }).rows.find((r) => r.pdu === leg.pdu.id && r.dir === 'tx' && r.iface === iface?.index && r.t === leg.txStart);
  if (row === undefined) throw new Error(`no record of #${leg.pdu.id} leaving ${leg.from.device}/${leg.from.port}`);
  const d = sim.captureRecord(cap, row.index);
  if (d === undefined) throw new Error('record gone');
  return d;
}

/** The solved IPsec lab, a capture on every wire of the path, and one echo request's legs. */
function ipsecPing(): { sim: Simulation; cap: CaptureId; pdu: PduJson; legs: FrameTx[] } {
  const lab = scenario('ccna3-ipsec-site-to-site');
  const sim = world(lab.name);
  for (const [name, lines] of Object.entries(lab.solution ?? {})) expect(sim.configure(idOf(sim, name), lines).ok, name).toBe(true);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const cap = sim.startCapture({
    ports: [
      { device: 'pc1', port: 'GigabitEthernet0' },
      { device: idOf(sim, 'R1'), port: 'Serial0/0/0' },
      { device: idOf(sim, 'ISP'), port: 'Serial0/0/1' },
      { device: idOf(sim, 'R2'), port: 'GigabitEthernet0/0' },
    ],
    dir: 'tx',
  });
  const evs = ping(sim, 'pc1', '192.168.2.10');
  const first = evs.find((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.tunnel === 'ipsec');
  if (first === undefined) throw new Error('no ESP leg');
  const json = sim.pdu(first.pdu.id)?.toJSON();
  if (json === undefined) throw new Error('packet gone');
  return { sim, cap, pdu: json, legs: legsOf(evs, first.pdu.id) };
}

function fieldsOf(d: Pick<CaptureRecordDetail, 'layers'>, from: number): Record<string, unknown>[] {
  return d.layers.slice(from).map((l) => ({ proto: l.proto, ...l.fields }));
}

function cards(html: string): string[] {
  return html
    .split('class="pk-layer ')
    .slice(1)
    .map((c) => /<span class="proto">([^<]+)<\/span>/.exec(c)?.[1] ?? '?');
}

function marks(html: string): boolean[] {
  return html
    .split('class="pk-layer ')
    .slice(1)
    .map((c) => c.includes(PROTECTED_LAYER_MARK));
}

describe('a leg of an IPsec ping, rebuilt from the newest image (R57(b))', () => {
  it('the ISP leg: outer headers by name, the inner packet exactly as the capture saw it, under the ESP banner', () => {
    const { sim, cap, pdu, legs } = ipsecPing();
    expect(legs.map((l) => `${l.from.device}>${l.to.device}`)).toEqual(['pc1>r1', 'r1>isp', 'isp>r2', 'r2>pc2']);
    // the engine holds the packet as delivered: decrypted, unmarked
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.meta.protected).toBeUndefined();

    const isp = legs[2]!;
    const at = rewindToHop(pdu, isp);
    expect(at.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']);
    expect(at.layers.map((l) => l.kept)).toEqual(['none', 'none', 'none', 'all', 'all', 'all']);
    expect(at.inexact).toBe(false);
    expect(at.image).toBeUndefined();
    // R2's changes were undone: the decryption, its TTL decrement, the LAN frame
    expect(at.later).toBe(pdu.provenance.filter((m) => m.device === 'r2').length);
    // the packet inside the tunnel is exactly what the capture at the ISP recorded
    const wire = recorded(sim, cap, isp);
    expect(wire.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']);
    expect(at.layers.slice(3).map((l) => ({ proto: l.proto, ...l.fields }))).toEqual(fieldsOf(wire, 3));
    expect(at.layers[3]?.fields.ttl).toBe(127);
    expect(hopProtection(at.layers, pdu.meta)).toBe('esp');
    expect(hopRebuiltNote(at)).toContain('Headers a later device removed were not kept');
  }, WORLD_TEST_TIMEOUT_MS);

  it('the first and last legs: the LAN before R1, exact inside; the last leg is the packet itself', () => {
    const { sim, cap, pdu, legs } = ipsecPing();
    const first = rewindToHop(pdu, legs[0]!);
    // R1 removed the Ethernet header to tunnel the packet: its fields were not kept
    expect(first.layers.map((l) => `${l.proto}:${l.kept}`)).toEqual(['ethernet:none', 'ipv4:all', 'icmpv4:all', 'payload:all']);
    expect(first.layers.slice(1).map((l) => ({ proto: l.proto, ...l.fields }))).toEqual(fieldsOf(recorded(sim, cap, legs[0]!), 1));
    expect(first.layers[1]?.fields.ttl).toBe(128);
    // no ESP header on the LAN: no banner, whatever the packet's mark is now
    expect(hopProtection(first.layers, pdu.meta)).toBeUndefined();
    expect(hopProtection(first.layers, { ...pdu.meta, protected: true, protectedBy: 'esp' })).toBeUndefined();

    const last = rewindToHop(pdu, legs[3]!);
    expect(last.later).toBe(0);
    expect(last.image).toBe(pdu);
    expect(recorded(sim, cap, legs[3]!).bytes).toEqual(pdu.bytes);
  }, WORLD_TEST_TIMEOUT_MS);

  it('opened from the ISP leg the inspector shows that leg under the ESP banner; selected otherwise, today’s view', () => {
    const { pdu, legs } = ipsecPing();
    state.selection = null;
    inspectPduAtHop(legs[2]!);
    expect(state.selection).toEqual({ kind: 'pdu', id: pdu.id });

    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu }));
    const t = text(html);
    expect(html).toContain(`role="note" aria-label="${protectedBannerTitle('esp')}"`);
    expect(t).toContain('Encrypted (ESP, simulated)');
    expect(t).toContain('encrypted (simulated)');
    expect(t).toContain('As sent from isp Serial0/0/1 to r2 Serial0/0/0');
    expect(t).toContain('show the packet as it is now');
    expect(cards(html)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']);
    expect(marks(html)).toEqual([false, false, false, true, true, true]);
    expect(t).toContain(HOP_LAYER_NOT_KEPT.none);
    expect(t).toContain('192.168.2.10'); // the inner packet is decoded under the banner
    expect(t).toContain('Capture on this link in NetScope');
    expect(t).toContain(`${legs[2]!.pdu.size} bytes on the wire`);

    // the same packet selected any other way (the canvas, the Events list): today's view, unchanged
    (store as unknown as { getState(): { select(s: unknown): void } }).getState().select({ kind: 'pdu', id: pdu.id });
    const now = text(renderToStaticMarkup(createElement(PacketInspector, { pdu })));
    expect(now).not.toContain('Encrypted (ESP, simulated)');
    expect(now).not.toContain('As sent from');
    expect(now).not.toContain(HOP_LAYER_NOT_KEPT.none);
    expect(now).toContain(`${pdu.bytes.length} bytes on the wire`);
    state.selection = null;
  }, WORLD_TEST_TIMEOUT_MS);

  it('a hop never outlives a reset, nor applies to another packet', () => {
    const { pdu, legs } = ipsecPing();
    inspectPduAtHop(legs[2]!);
    expect(text(renderToStaticMarkup(createElement(PacketInspector, { pdu })))).toContain('As sent from');
    expect(text(renderToStaticMarkup(createElement(PacketInspector, { pdu: { ...pdu, id: pdu.id + 1 } })))).not.toContain('As sent from');
    state.epoch = 1;
    expect(text(renderToStaticMarkup(createElement(PacketInspector, { pdu })))).not.toContain('As sent from');
    state.epoch = 0;
    state.selection = null;
  }, WORLD_TEST_TIMEOUT_MS);

  it('the provenance timeline offers each stop that sent the packet as a leg to open', () => {
    const { pdu, legs } = ipsecPing();
    const hops = buildHops(pdu, legs);
    expect(hops.filter((h) => h.tx !== undefined).map((h) => h.tx)).toEqual(legs);
  }, WORLD_TEST_TIMEOUT_MS);

  it('a Packets-list row and a sim-mode row of the ISP leg open that leg under the ESP banner (W6a integration)', () => {
    const { pdu, legs } = ipsecPing();
    const isp = legs[2]!;
    const expectIspLeg = (): void => {
      expect(state.selection).toEqual({ kind: 'pdu', id: pdu.id });
      const t = text(renderToStaticMarkup(createElement(PacketInspector, { pdu })));
      expect(t).toContain('Encrypted (ESP, simulated)');
      expect(t).toContain('As sent from isp Serial0/0/1 to r2 Serial0/0/0');
    };

    // the Packets row's own click handler (the memoised row's render, then its onClick)
    state.selection = null;
    const row = (PacketRow as unknown as { type(p: unknown): { type: string; props: { onClick(): void } } }).type({
      line: { ev: isp, from: 'isp Serial0/0/1', to: 'r2 Serial0/0/0' },
      selected: false,
    });
    expect(row.type).toBe('tr');
    row.props.onClick();
    expectIspLeg();
    state.selection = null;
    openPacketLeg(isp);
    expectIspLeg();

    // a sim-mode row: a frameTx opens its leg; any other row keeps today's selection and view
    state.selection = null;
    activateSimEvent(isp);
    expectIspLeg();
    activateSimEvent({ t: isp.t, kind: 'pduConsumed', pdu: isp.pdu, device: isp.to.device } as unknown as TraceEvent);
    expect(state.selection).toEqual({ kind: 'pdu', id: pdu.id });
    const now = text(renderToStaticMarkup(createElement(PacketInspector, { pdu })));
    expect(now).not.toContain('Encrypted (ESP, simulated)');
    expect(now).not.toContain('As sent from');
    state.selection = null;
  }, WORLD_TEST_TIMEOUT_MS);
});

describe('a routed leg rebuilt byte for byte', () => {
  it('PC1 → R1 of a ping through a router: every header known, the bytes equal the capture', () => {
    const sim = world('pc-router-pc');
    const cap = sim.startCapture({ ports: [{ device: 'pc1', port: 'GigabitEthernet0' }, { device: 'r1', port: 'GigabitEthernet0/1' }], dir: 'tx' });
    const evs = ping(sim, 'pc1', '10.0.1.1');
    const echo = evs.find((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.proto === 'icmpv4' && e.from.device === 'pc1');
    if (echo === undefined) throw new Error('no echo request');
    const pdu = sim.pdu(echo.pdu.id)!.toJSON();
    const legs = legsOf(evs, echo.pdu.id);
    expect(legs.map((l) => `${l.from.device}>${l.to.device}`)).toEqual(['pc1>r1', 'r1>pc2']);
    const at = rewindToHop(pdu, legs[0]!);
    expect(at.later).toBeGreaterThan(0); // the router's TTL and MAC rewrites
    expect(at.inexact).toBe(false);
    expect(at.layers.every((l) => l.kept === 'all')).toBe(true);
    const wire = recorded(sim, cap, legs[0]!);
    expect(at.image?.bytes).toEqual(wire.bytes);
    expect(at.image?.layers.map((l) => l.fields)).toEqual(wire.layers.map((l) => l.fields));
    expect(at.image?.provenance).toEqual(pdu.provenance.slice(0, hopCut(pdu.provenance, legs[0]!)));
    expect(at.image?.summary).toBe(legs[0]!.pdu.summary);

    // opened from that leg: the exact image with its bytes, the strip, and no banner (nothing is protected)
    inspectPduAtHop(legs[0]!);
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu }));
    const t = text(html);
    expect(t).toContain('As sent from pc1 GigabitEthernet0 to r1 GigabitEthernet0/0');
    expect(t).toContain(`${wire.bytes.length} bytes on the wire`);
    expect(t).toContain('underlined = inside a layer'); // the hex view of the rebuilt bytes
    expect(t).not.toContain('simulated)');
    state.selection = null;
  }, WORLD_TEST_TIMEOUT_MS);
});

describe('rewinding the recorded changes (pure)', () => {
  const factory = createPduFactory();
  const frame = (layers: LayerSpec[]): PduJson => factory.build(layers, { born: 0, origin: 'sw1' }).toJSON();
  const eth = (type: number): LayerSpec => ({ proto: 'ethernet', fields: { src: '02:00:00:00:00:01', dst: '02:00:00:00:00:02', type } });
  const ip: LayerSpec = { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 1, ttl: 64 } };
  const icmp: LayerSpec = { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } };
  const leg = (t: number, device: string): PacketHop => ({
    t,
    kind: 'frameTx',
    pdu: { id: 1, proto: 'icmpv4', size: 0, summary: 'echo' },
    link: 'l1',
    from: { device, port: 'Gi0/1' },
    to: { device: 'x', port: 'Gi0' },
    txStart: t,
    txEnd: t + 1,
    arrive: t + 2,
  });
  const m = (at: number, device: string, reason: Mutation['reason'], field: string, before: Mutation['before'], after: Mutation['after']): Mutation => ({ at, device, reason, field, before, after });

  it('cuts after the leg: later times, other devices at the same instant, and a flip of the carried copy', () => {
    const prov = [m(5, 'sw1', 'TtlDecrement', 'ipv4.ttl', 64, 63), m(10, 'sw1', 'MacRewrite', 'ethernet.src', 'a', 'b'), m(10, 'sw1', 'Corruption', 'raw.bytes', 1, 3), m(10, 'sw2', 'Other', 'ipv4.ttl', 63, 62)];
    expect(hopCut(prov, leg(10, 'sw1'))).toBe(2);
    expect(hopCut(prov, leg(4, 'sw1'))).toBe(0);
    expect(hopCut(prov, leg(20, 'sw1'))).toBe(4);
  });

  it('undoes a tag a later switch popped (its VID comes back) and a tag a later switch pushed', () => {
    const popped = frame([eth(0x0800), ip, icmp]);
    const withPop: PduJson = { ...popped, provenance: [m(7, 'sw2', 'VlanTagPop', 'dot1q.vid', 20, null), m(7, 'sw2', 'FcsRecompute', 'ethernet.fcs', 1234, popped.layers[0]!.fields.fcs ?? null)] };
    const back = rewindToHop(withPop, leg(5, 'sw1'));
    expect(back.layers.map((l) => `${l.proto}:${l.kept}`)).toEqual(['ethernet:all', 'dot1q:some', 'ipv4:all', 'icmpv4:all', 'payload:all']);
    expect(back.layers[1]?.fields).toEqual({ vid: 20, type: 0x0800 });
    expect(back.layers[0]?.fields.type).toBe(0x8100);
    expect(back.layers[0]?.fields.fcs).toBe(1234);
    expect(back.image).toBeUndefined();

    const tagged = frame([eth(0x8100), { proto: 'dot1q', fields: { vid: 10, pcp: 0, type: 0x0800 } }, ip, icmp]);
    const withPush: PduJson = { ...tagged, provenance: [m(7, 'sw2', 'VlanTagPush', 'dot1q.vid', null, 10)] };
    const before = rewindToHop(withPush, leg(5, 'sw1'));
    expect(before.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(before.layers[0]?.fields.type).toBe(0x0800);
  });

  it('a flipped bit or a record that matches no header makes the rebuild inexact, with no bytes', () => {
    const p = frame([eth(0x0800), ip, icmp]);
    const flipped = rewindToHop({ ...p, provenance: [m(7, 'sw2', 'Corruption', 'raw.bytes', 0x10, 0x11)] }, leg(5, 'sw1'));
    expect(flipped.inexact).toBe(true);
    expect(flipped.image).toBeUndefined();
    expect(hopRebuiltNote(flipped)).toContain('could not be undone');
    const stray = rewindToHop({ ...p, provenance: [m(7, 'sw2', 'Encapsulate', 'hdlc', null, 'hdlc')] }, leg(5, 'sw1'));
    expect(stray.inexact).toBe(true);
  });

  it('a leg whose fields all come back but whose size does not match keeps no bytes', () => {
    const p = frame([eth(0x0800), ip, icmp]);
    const at = rewindToHop({ ...p, provenance: [m(7, 'r1', 'TtlDecrement', 'ipv4.ttl', 65, 64)] }, { ...leg(5, 'pc1'), pdu: { id: 1, proto: 'icmpv4', size: p.bytes.length + 4, summary: 'echo' } });
    expect(at.layers.every((l) => l.kept === 'all')).toBe(true);
    expect(at.layers[1]?.fields.ttl).toBe(65);
    expect(at.image).toBeUndefined();
    expect(hopRebuiltNote(at)).toContain('Every field is known, but the bytes of the leg could not be rebuilt');
  });
});
