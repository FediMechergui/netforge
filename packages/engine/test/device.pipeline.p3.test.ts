/**
 * device.pipeline.p3 — the control check on the physical port of a routed port, before step 10a (ARCHITECTURE-P3 D18,
 * §3.0 (b); §7 W2 device).
 *
 * A frame to the LLDP nearest-bridge group or to the NF control group that `classifyControl` classes `cdp` or `lldp`,
 * whose daemon runs on the device, is delivered to it on the physical port — also when the port has a native
 * subinterface (step 10a would hand the untagged frame to it). When the daemon does not run, the frame takes today's
 * path exactly (step 10a, then step 10b's `not-for-me` "link-layer control frame"). DTP, LACP and BPDUs on a routed
 * port never take the check: they keep today's path even on a device that runs their daemons.
 *
 * Two layers: the pure decision (`routedControlVerdict`, `frameArrivalVerdict` with `daemons`) on hand-built ports,
 * and real worlds on `staged.world` at stage P3 with a stub `cdp` (and `lldp`) daemon passed through `factories`; the
 * frames come from the test injector (`test/inject.ts`), so no real discovery daemon is needed.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import { BRIDGED_ROLES, L3_ROLES } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { DeviceId, PduId, PortId, ProcessName } from '../src/contracts/ids.js';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_LLDP,
  LLC_SAP_STP,
  LLDP_NEAREST_BRIDGE_MAC,
  NF_L2_CONTROL_MAC,
  STP_GROUP_MAC,
  type LayerSpec,
  type Pdu,
} from '../src/contracts/pdu.js';
import type { PortSpec, PortState } from '../src/contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessFactory, StateView } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { defineModel } from '../src/device/catalog/define.js';
import { createPortState } from '../src/device/ports.js';
import {
  PIPELINE_P2_DETAILS,
  ROUTED_CONTROL_CLASSES,
  buildDemuxIndex,
  frameArrivalVerdict,
  routedControlVerdict,
  type DemuxIndex,
  type FrameArrivalInput,
  type PipelineSubif,
} from '../src/device/pipeline.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { lacpduLayers } from '../src/protocols/etherchannel/lacp.js';
import { cdpFrameSpecs } from '../src/protocols/cdp.js';
import { dtpFrameSpecs } from '../src/protocols/dtp.js';
import { lldpFrameSpecs } from '../src/protocols/lldp.js';
import { NF_2911_INPUT } from './device.catalog.p0-inputs.js';
import { INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const PEER = '02:4e:59:00:00:01';
const BASE = deviceMacBase('d_p3pipe');

// ── frames ────────────────────────────────────────────────────────────────────────────────────────────────────

const CDP: LayerSpec[] = cdpFrameSpecs(PEER, {
  version: 2, ttl: 180, deviceId: 'SW9', portId: 'GigabitEthernet0/1', capabilities: 'S I', platform: 'NF-C2960',
  software: 'NetForge NF-OS, release 3, NF-C2960', duplex: 'full', addresses: '10.0.12.9',
});
const LLDP: LayerSpec[] = lldpFrameSpecs(PEER, {
  chassisId: PEER, portId: 'GigabitEthernet0/1', ttl: 120, systemName: 'SW9', systemDescription: 'NetForge NF-OS, release 3, NF-C2960',
  capabilities: 0x04, enabledCapabilities: 0x04,
});
const DTP: LayerSpec[] = dtpFrameSpecs(PEER, 'dynamic-desirable', false);
const LACP: LayerSpec[] = lacpduLayers({ srcMac: PEER, system: PEER, key: 1, portNumber: 1, state: 0x3d });
const BPDU: LayerSpec[] = [
  { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: PEER, type: 0 } },
  { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
  { proto: 'stp', fields: { version: 0, bpduType: 0, rootPriority: 32769, rootMac: PEER, rootPathCost: 0, bridgePriority: 32769, bridgeMac: PEER, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512, forwardDelay: 3840 } },
];

const pdus = createPduFactory();
const frame = (layers: readonly LayerSpec[]): Pdu => pdus.build(layers, { born: 0, origin: 'd_test' });

// ── pure decision ─────────────────────────────────────────────────────────────────────────────────────────────

const router = defineModel(NF_2911_INPUT, 'P2');

function livePort(model: DeviceModel, name: string, over: Partial<PortSpec> = {}): PortState {
  const i = model.ports.findIndex((p) => p.name === name);
  const spec = { ...(model.ports[i] as PortSpec), ...over };
  const port = createPortState(spec, i + 1, { macBase: BASE, capabilities: model.capabilities, portsDefaultUp: true });
  port.adminUp = true;
  port.operUp = true;
  return port;
}

function indexOf(entries: [ProcessName, DemuxSelector[]][]): DemuxIndex {
  return buildDemuxIndex(entries.map((e) => e[0]), new Map(entries.map(([name, handles]) => [name, { handles }])));
}
const BUILTIN = indexOf([
  ['eth-switch', [{ layer: 'ethernet', roles: BRIDGED_ROLES }]],
  ['arp', [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }]],
  ['ipv4', [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }]],
]);

function arrive(port: PortState, f: Pdu, over: Partial<FrameArrivalInput> = {}) {
  return frameArrivalVerdict({ port, frame: f, booted: true, index: BUILTIN, groupFilter: true, ...over });
}

const NATIVE: PipelineSubif[] = [{ id: 'GigabitEthernet0/0.1', dot1q: { vid: 1, native: true } }];
const CONTROL_DROP = { kind: 'drop', reason: 'not-for-me', detail: PIPELINE_P2_DETAILS.linkLayerControl, counters: [] };

describe('the control check (pure): classes cdp and lldp only, on a routed port, before step 10a', () => {
  it('names exactly the two discovery classes', () => {
    expect(ROUTED_CONTROL_CLASSES).toEqual(['cdp', 'lldp']);
  });

  it('delivers a CDP frame to a running cdp on the physical port, counting inBroadcasts; key = the ethernet type field', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    const f = frame(CDP);
    const type = f.layers[0]!.fields['type'];
    expect(typeof type).toBe('number');
    const want = { kind: 'deliver', process: 'cdp', layer: 'ethernet', key: type, counters: ['inBroadcasts'] };
    expect(arrive(port, f, { daemons: new Set(['cdp']) })).toEqual(want);
    expect(routedControlVerdict(f, f.layers[0]!, new Set(['cdp']))).toEqual(want);
    // also when the port has a native subinterface (step 10a would take the untagged frame)
    expect(arrive(port, f, { daemons: new Set(['cdp']), subinterfaces: NATIVE })).toEqual(want);
  });

  it('delivers an LLDP frame to a running lldp on the physical port', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    const want = { kind: 'deliver', process: 'lldp', layer: 'ethernet', key: ETHERTYPE_LLDP, counters: ['inBroadcasts'] };
    expect(arrive(port, frame(LLDP), { daemons: new Set(['lldp']) })).toEqual(want);
    expect(arrive(port, frame(LLDP), { daemons: new Map([['lldp', 1]]), subinterfaces: NATIVE })).toEqual(want);
  });

  it('when the class daemon does not run, the frame takes today path exactly: step 10a, then step 10b', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    for (const daemons of [undefined, new Set<string>(), new Set(['lldp'])]) {
      const over: Partial<FrameArrivalInput> = daemons === undefined ? {} : { daemons };
      expect(arrive(port, frame(CDP), over)).toEqual(CONTROL_DROP);
      expect(arrive(port, frame(CDP), { ...over, subinterfaces: NATIVE })).toEqual({ kind: 'subif', port: 'GigabitEthernet0/0.1', pop: false, counters: [] });
    }
    expect(arrive(port, frame(LLDP), { daemons: new Set(['cdp']) })).toEqual(CONTROL_DROP);
  });

  it('DTP, LACP and BPDUs never take the check, even when their daemons and cdp/lldp run', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    const all = new Set(['cdp', 'lldp', 'dtp', 'etherchannel', 'stp']);
    for (const layers of [DTP, LACP, BPDU]) {
      const f = frame(layers);
      expect(routedControlVerdict(f, f.layers[0]!, all)).toBeUndefined();
      expect(arrive(port, f, { daemons: all })).toEqual(arrive(port, f));
      expect(arrive(port, f, { daemons: all, subinterfaces: NATIVE })).toEqual(arrive(port, f, { subinterfaces: NATIVE }));
    }
    expect(arrive(port, frame(DTP), { daemons: all })).toEqual(CONTROL_DROP);
    expect(arrive(port, frame(BPDU), { daemons: all })).toEqual(CONTROL_DROP);
  });

  it('a near miss is not a discovery frame: the LLDP ethertype to another group, another ethertype to the LLDP group, another PID', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    const daemons = new Set(['cdp', 'lldp']);
    const otherGroup = frame([{ proto: 'ethernet', fields: { dst: '01:80:c2:00:00:03', src: PEER, type: ETHERTYPE_LLDP } }, LLDP[1]!]);
    expect(arrive(port, otherGroup, { daemons })).toEqual(CONTROL_DROP);
    const otherType = frame([{ proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: PEER, type: ETHERTYPE_IPV4 } }, { proto: 'payload', fields: {} }]);
    expect(arrive(port, otherType, { daemons })).toEqual(CONTROL_DROP);
    const pagpLike = frame([{ proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: PEER, type: 0 } }, { proto: 'llc', fields: { type: 0x0002 } }, { proto: 'payload', fields: {} }]);
    expect(arrive(port, pagpLike, { daemons })).toEqual(CONTROL_DROP);
  });

  it('a bridged port never takes the check (eth-switch step 2 delivers there); an ordinary frame is untouched', () => {
    const sw = defineModel({ ...NF_2911_INPUT, type: 'router.nf2911-bridged', capabilities: ['switching'] }, 'P2');
    const bridged = livePort(sw, 'GigabitEthernet0/0');
    expect(arrive(bridged, frame(CDP), { daemons: new Set(['cdp']) })).toMatchObject({ kind: 'deliver', process: 'eth-switch' });
    const port = livePort(router, 'GigabitEthernet0/0');
    const ip = frame([{ proto: 'ethernet', fields: { dst: port.mac, src: PEER, type: ETHERTYPE_IPV4 } }, { proto: 'payload', fields: {} }]);
    expect(arrive(port, ip, { daemons: new Set(['cdp', 'lldp']) })).toEqual(arrive(port, ip));
  });
});

// ── real worlds ───────────────────────────────────────────────────────────────────────────────────────────────

/** A stub discovery daemon: records each frame it is handed and consumes it. */
function stub(name: ProcessName): { factory: ProcessFactory; seen: { port: PortId; pdu: PduId; at: number }[] } {
  const seen: { port: PortId; pdu: PduId; at: number }[] = [];
  const factory: ProcessFactory = (): Process => ({
    name,
    onPdu(ctx, pdu, port): Action[] {
      seen.push({ port, pdu: pdu.id, at: ctx.now });
      return [{ type: 'consume', pdu }];
    },
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: (): StateView => ({ process: name, state: { seen: seen.length } }),
    debugEvents: (): readonly DebugEvent[] => [],
  });
  return { factory, seen };
}

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/**
 * INJ (the test injector) GigabitEthernet0 ↔ R1 (NF-2911) GigabitEthernet0/0, routed and up; optionally a native
 * subinterface GigabitEthernet0/0.1 and a multilayer switch ML1 (NF-C3650-24) with a routed GigabitEthernet1/0/1 on
 * the injector's second port.
 */
function world(overlay: StagedFactoryOverlay, opts: { native?: boolean; stage?: 'P2' | 'P3' } = {}): Simulation {
  const sim = createStagedSimulation({ seed: 31, stage: opts.stage ?? 'P3', factories: withInjector(overlay) });
  const r1: string[][] = [['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']];
  if (opts.native === true) r1.push(['interface GigabitEthernet0/0.1', ' encapsulation dot1Q 1 native', ' ip address 10.0.1.1 255.255.255.0']);
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup(r1) });
  sim.addDevice({
    id: 'ml1', type: 'mlswitch.nfc3650-24', name: 'ML1',
    startupConfig: startup([['hostname ML1'], ['interface GigabitEthernet1/0/1', ' no switchport', ' ip address 10.0.13.1 255.255.255.0', ' no shutdown']]),
  });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet1' }, b: { device: 'ml1', port: 'GigabitEthernet1/0/1' } });
  sim.runFor(70 * SEC);
  return sim;
}

/** Inject `frames` from INJ's `port`, run 1 s, return the trace of that second. */
function inject(sim: Simulation, port: PortId, frames: readonly (readonly LayerSpec[])[]): TraceEvent[] {
  const cursor = sim.trace(0).next;
  const ticket = injectFrames(sim, { from: 'inj', port, frames, spacingNs: 10 * MS });
  sim.runUntil(ticket.lastAt + SEC);
  return sim.trace(cursor).events;
}

type Drop = Extract<TraceEvent, { kind: 'drop' }>;
const dropsAt = (evs: readonly TraceEvent[], device: DeviceId): Drop[] => evs.filter((e): e is Drop => e.kind === 'drop' && e.device === device);
const dropShape = (d: Drop) => ({ port: d.port, reason: d.reason, detail: d.detail, proto: d.pdu.proto, background: d.background });

describe('the control check on staged.world (stage P3, stub cdp and lldp through factories)', () => {
  it('a CDP frame reaches the running cdp on the routed physical port; inBroadcasts counts it; nothing is dropped', () => {
    const cdp = stub('cdp');
    const sim = world({ cdp: cdp.factory });
    expect(sim.device('r1')!.model.processes).toContain('cdp');
    const port = sim.device('r1')!.port('GigabitEthernet0/0')!;
    expect(port.operUp).toBe(true);
    const before = port.counters.inBroadcasts;
    const evs = inject(sim, 'GigabitEthernet0', [CDP]);
    expect(cdp.seen.map((s) => s.port)).toEqual(['GigabitEthernet0/0']);
    expect(dropsAt(evs, 'r1')).toEqual([]);
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === 'r1' && e.process === 'cdp' && e.pdu.id === cdp.seen[0]!.pdu)).toBe(true);
    expect(port.counters.inBroadcasts).toBe(before + 1);
  });

  it('with a native subinterface the frame still goes to cdp on the physical port, not to the subinterface', () => {
    const cdp = stub('cdp');
    const sim = world({ cdp: cdp.factory }, { native: true });
    const sub = sim.device('r1')!.port('GigabitEthernet0/0.1')!;
    expect(sub.dot1q).toEqual({ vid: 1, native: true });
    expect(sub.operUp).toBe(true);
    const subIn = sub.counters.inPackets;
    const evs = inject(sim, 'GigabitEthernet0', [CDP, CDP]);
    expect(cdp.seen.map((s) => s.port)).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/0']);
    expect(sub.counters.inPackets).toBe(subIn);
    expect(dropsAt(evs, 'r1')).toEqual([]);
  });

  it('an LLDP frame reaches a running lldp the same way (with and without a native subinterface)', () => {
    for (const native of [false, true]) {
      const lldp = stub('lldp');
      const sim = world({ lldp: lldp.factory }, { native });
      const evs = inject(sim, 'GigabitEthernet0', [LLDP]);
      expect(lldp.seen.map((s) => s.port)).toEqual(['GigabitEthernet0/0']);
      expect(dropsAt(evs, 'r1')).toEqual([]);
    }
  });

  it('when the daemon does not run the frame is dropped exactly as today: the same drop as in a P2-stage world', () => {
    for (const native of [false, true]) {
      // ARCHITECTURE-P3 §9.2 W4 (the catalog flip registered cdp and lldp, so a world without them now removes them
      // through the overlay, staged.world's documented way to model a missing daemon; same assertions)
      const p3 = world({ cdp: undefined, lldp: undefined }, { native });
      expect(p3.device('r1')!.model.processes).not.toContain('cdp');
      const p2 = world({}, { native, stage: 'P2' });
      const got = dropsAt(inject(p3, 'GigabitEthernet0', [CDP, LLDP]), 'r1').map(dropShape);
      const today = dropsAt(inject(p2, 'GigabitEthernet0', [CDP, LLDP]), 'r1').map(dropShape);
      const port = native ? 'GigabitEthernet0/0.1' : 'GigabitEthernet0/0';
      expect(got).toEqual([
        { port, reason: 'not-for-me', detail: PIPELINE_P2_DETAILS.linkLayerControl, proto: 'cdp', background: undefined },
        { port, reason: 'not-for-me', detail: PIPELINE_P2_DETAILS.linkLayerControl, proto: 'lldp', background: undefined },
      ]);
      expect(got).toEqual(today);
    }
    // cdp runs but lldp does not: the LLDP frame still drops at step 10b
    const cdp = stub('cdp');
    const mixed = world({ cdp: cdp.factory, lldp: undefined });
    expect(dropsAt(inject(mixed, 'GigabitEthernet0', [LLDP]), 'r1').map(dropShape)).toEqual([
      { port: 'GigabitEthernet0/0', reason: 'not-for-me', detail: PIPELINE_P2_DETAILS.linkLayerControl, proto: 'lldp', background: undefined },
    ]);
    expect(cdp.seen).toEqual([]);
  });

  it('DTP, LACP and BPDUs on a multilayer switch routed port (whose daemons run there) keep today path', () => {
    const cdp = stub('cdp');
    const lldp = stub('lldp');
    const withStubs = world({ cdp: cdp.factory, lldp: lldp.factory });
    const ml = withStubs.device('ml1')!;
    expect(ml.model.processes).toEqual(expect.arrayContaining(['dtp', 'etherchannel', 'stp', 'cdp', 'lldp']));
    expect(ml.port('GigabitEthernet1/0/1')!.role).toBe('routed');
    const without = world({});
    const got = dropsAt(inject(withStubs, 'GigabitEthernet1', [DTP, LACP, BPDU]), 'ml1').map(dropShape);
    const today = dropsAt(inject(without, 'GigabitEthernet1', [DTP, LACP, BPDU]), 'ml1').map(dropShape);
    expect(got.map((d) => d.proto)).toEqual(['dtp', 'lacp', 'stp']);
    expect(got.every((d) => d.reason === 'not-for-me' && d.port === 'GigabitEthernet1/0/1')).toBe(true);
    expect(got).toEqual(today);
    expect(cdp.seen).toEqual([]);
    expect(lldp.seen).toEqual([]);
  });
});
