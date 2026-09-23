/**
 * Shared helper of the W3 lag tests (lag.lacp, lag.misconfig, lag.egress, lag.cost, lag.pagp): a fake-ctx switch with
 * the etherchannel daemon (over `p2SwitchHarness`, a P2-stage NF-C2960 with the real vlan and etherchannel factories)
 * and real two-switch worlds on `createP2Simulation` (§0 rule 13) whose members are configured through startup
 * configs. Not a test file itself.
 */
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { MacAddress } from '../src/contracts/addr.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { PortState, PortView } from '../src/contracts/port.js';
import { SPEED_1G } from '../src/contracts/port.js';
import type { Action, Process } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EtherchannelRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { lacpActorState, lacpduLayers } from '../src/protocols/etherchannel/lacp.js';
import { pagpLayers } from '../src/protocols/etherchannel/pagp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { configText } from './accept.p05.harness.js';
import { NF_C2960_INPUT } from './device.catalog.p0-inputs.js';
import { p2SwitchHarness, type P2SwitchHarness, type P2SwitchHarnessOptions } from './l2.eth-switch.p2.harness.js';
import { createP2Simulation, defineP2Model, p2Registry } from './p2.world.js';

export const GI1: PortId = 'GigabitEthernet0/1';
export const GI2: PortId = 'GigabitEthernet0/2';
export const FA1: PortId = 'FastEthernet0/1';
export const PO1: PortId = 'Port-channel1';
/** The partner switch of the fake tests: its base MAC and its port MACs. */
export const PEER_SYSTEM: MacAddress = '02:aa:00:00:01:00';
export const PEER_PORT_MAC: MacAddress = '02:aa:00:00:01:01';
export const OTHER_SYSTEM: MacAddress = '02:bb:00:00:02:00';

/** The P2-stage NF-C2960 with the vlan and etherchannel factories. */
export const LAG_MODEL: DeviceModel = defineP2Model(NF_C2960_INPUT, p2Registry({ vlan: createVlan, etherchannel: createEtherchannel }));

export interface LagFake {
  readonly h: P2SwitchHarness;
  readonly d: Process;
  /** The etherchannel row of `port`. */
  row(port: PortId): EtherchannelRow | undefined;
  /** Apply `channel-group <group> mode <mode>` (or its `no` form) under `interface <port>`. */
  group(port: PortId, group: number, mode: string, negate?: boolean): Action[];
  /** Apply one switchport line under `interface <port>` (or its `no` form with `negate`). */
  line(port: PortId, line: string, negate?: boolean): Action[];
  /** An LACPDU from the peer as heard on a member (actor = the peer). */
  lacpdu(o?: { system?: MacAddress; key?: number; port?: number; sync?: boolean; active?: boolean; srcMac?: MacAddress }): Pdu;
  /** A PAgP message from the peer. */
  pagp(o?: { device?: MacAddress; group?: number; port?: number; mode?: 'desirable' | 'auto' }): Pdu;
  /** Set the negotiated speed of a fake port (the link model's job in a real device). */
  speed(port: PortId, bps: number | undefined): void;
}

/** A fake-ctx switch with GI1, GI2, FA1 up, the Port-channel1 section and virtual port present, and the daemon initialised. */
export function lagFake(opts: { ports?: readonly PortId[]; bundles?: readonly PortId[] } & Omit<P2SwitchHarnessOptions, 'ports' | 'model'> = {}): LagFake {
  const h = p2SwitchHarness({ model: LAG_MODEL, ports: opts.ports ?? [GI1, GI2, FA1] });
  for (const b of opts.bundles ?? [PO1]) {
    h.addPort(b, 0, { kind: 'virtual', role: 'channel' });
    h.config.set([], ['interface', b]);
  }
  for (const p of opts.ports ?? [GI1, GI2, FA1]) speed(p, SPEED_1G);
  const d = createEtherchannel();
  d.init!(h.ctx);

  function speed(port: PortId, bps: number | undefined): void {
    const v = h.ports.get(port)!;
    const { speedBps: _s, ...rest } = v;
    h.ports.set(port, (bps === undefined ? rest : { ...rest, speedBps: bps }) as PortView);
  }

  return {
    h,
    d,
    row: (port) => h.tables.get<EtherchannelRow>('etherchannel')!.get(port),
    group: (port, group, mode, negate = false) => h.configure(d, [['interface', port]], ['channel-group', String(group), 'mode', mode], negate),
    line: (port, line, negate = false) => h.configure(d, [['interface', port]], line.split(' '), negate),
    lacpdu: (o = {}) =>
      h.ctx.newPdu(
        lacpduLayers({
          srcMac: o.srcMac ?? PEER_PORT_MAC,
          system: o.system ?? PEER_SYSTEM,
          key: o.key ?? 1,
          portNumber: o.port ?? 1,
          state: lacpActorState({ active: o.active ?? true, sync: o.sync ?? true, bundled: false, partnerKnown: false }),
        }),
        { tag: 'lacp', background: true, origin: 'd_sw2' },
      ),
    pagp: (o = {}) =>
      h.ctx.newPdu(
        pagpLayers({ srcMac: PEER_PORT_MAC, device: o.device ?? PEER_SYSTEM, portNumber: o.port ?? 1, group: o.group ?? 1, mode: o.mode ?? 'desirable' }),
        { tag: 'pagp', background: true, origin: 'd_sw2' },
      ),
    speed,
  };
}

/** The `type` of every action, in order. */
export const types = (actions: readonly Action[]): string[] => actions.map((a) => a.type);
/** Timer actions as `[key, delay, periodic]`. */
export const timersOf = (actions: readonly Action[]): [string, number, boolean | undefined][] =>
  actions.flatMap((a) => (a.type === 'timer' ? [[a.key, a.delay, a.periodic] as [string, number, boolean | undefined]] : []));
/** Keys of the cancelTimer actions. */
export const cancelsOf = (actions: readonly Action[]): string[] => actions.flatMap((a) => (a.type === 'cancelTimer' ? [a.key] : []));
/** `[port, tag]` of the send actions. */
export const sendsOf = (actions: readonly Action[]): [PortId, string | undefined][] =>
  actions.flatMap((a) => (a.type === 'send' ? [[a.port, a.pdu.meta.tag] as [PortId, string | undefined]] : []));
/** The l2Changed actions. */
export const signalsOf = (actions: readonly Action[]): Extract<Action, { type: 'l2Changed' }>[] =>
  actions.filter((a): a is Extract<Action, { type: 'l2Changed' }> => a.type === 'l2Changed');
/** The drop actions as `[reason, detail]`. */
export const dropsOf = (actions: readonly Action[]): [string, string | undefined][] =>
  actions.flatMap((a) => (a.type === 'drop' ? [[a.reason, a.detail] as [string, string | undefined]] : []));

// ── real worlds ──────────────────────────────────────────────────────────────

/** A member line set of one switch: `[port, mode]` pairs, plus optional extra interface lines per port. */
export interface SwitchLag {
  readonly hostname: string;
  readonly members: readonly (readonly [PortId, string])[];
  /** Extra lines under each member section (e.g. `switchport access vlan 20`), by port. */
  readonly extra?: Readonly<Record<string, readonly string[]>>;
  /** Lines under `interface Port-channel1`. */
  readonly bundle?: readonly string[];
  /** Global lines (e.g. `port-channel load-balance dst-mac`, `vlan 10`). */
  readonly global?: readonly string[];
}

/** Startup config of a switch with one Port-channel1 and the given members. */
export function switchConfig(s: SwitchLag): string {
  const sections: string[][] = [[`hostname ${s.hostname}`]];
  for (const g of s.global ?? []) sections.push([g]);
  sections.push(['interface Port-channel1', ...(s.bundle ?? []).map((l) => ` ${l}`)]);
  for (const [port, mode] of s.members) {
    sections.push([`interface ${port}`, ...(s.extra?.[port] ?? []).map((l) => ` ${l}`), ` channel-group 1 mode ${mode}`]);
  }
  return configText(sections);
}

export interface LagWorld {
  readonly sim: Simulation;
  /** Every trace event so far (the ring from cursor 0). */
  events(): TraceEvent[];
  /** The etherchannel row of `port` on `dev`. */
  row(dev: string, port: PortId): EtherchannelRow | undefined;
  /** Time of the `linkState up` event of link `id`, or undefined. */
  linkUpAt(id: string): number | undefined;
  /** The MAC of a PC's GigabitEthernet0. */
  pcMac(id: string): MacAddress;
}

export interface LagWorldOptions {
  readonly seed?: number;
  readonly profile?: 'P1' | 'P2';
  readonly sw1: SwitchLag;
  readonly sw2: SwitchLag;
  /** Parallel links between the switches, `[sw1 port, sw2 port]` pairs; link ids `l1`, `l2`, … Default: Gi0/1–Gi0/1 and Gi0/2–Gi0/2. */
  readonly links?: readonly (readonly [PortId, PortId])[];
  /** Add PC1 on SW1 Fa0/1 (10.0.0.1) and PC2 on SW2 Fa0/1 (10.0.0.2). Default true. */
  readonly pcs?: boolean;
  /** Extra factories laid over the default (vlan + etherchannel; stp and dtp removed unless given here). */
  readonly factories?: Parameters<typeof createP2Simulation>[0]['factories'];
}

/**
 * Two NF-C2960 switches with the vlan and etherchannel daemons, joined by parallel links, with a PC behind each. The
 * world the W3 lag tests were written for: since the W4 flip registered every P2 factory, stp and dtp are removed
 * explicitly (`undefined` overlay) unless a test passes them (ARCHITECTURE-P2 §9.2 W4 fixture pins).
 */
export function lagWorld(o: LagWorldOptions): LagWorld {
  const sim = createP2Simulation({
    seed: o.seed ?? 11,
    profile: o.profile ?? 'P2',
    factories: { vlan: createVlan, etherchannel: createEtherchannel, stp: undefined, dtp: undefined, ...(o.factories ?? {}) },
  });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: o.sw1.hostname, startupConfig: switchConfig(o.sw1) });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: o.sw2.hostname, startupConfig: switchConfig(o.sw2) });
  const links = o.links ?? [[GI1, GI1], [GI2, GI2]];
  links.forEach(([a, b], i) => sim.addLink({ id: `l${i + 1}`, a: { device: 'sw1', port: a }, b: { device: 'sw2', port: b } }));
  if (o.pcs !== false) {
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ id: 'lpc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    sim.addLink({ id: 'lpc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
  }
  // boot every device (switches boot at 30 s) before any link comes up
  sim.runFor(30 * SEC + 1);
  return {
    sim,
    events: () => sim.trace(0).events,
    row: (dev, port) => sim.device(dev)?.tables.get<EtherchannelRow>('etherchannel')?.get(port),
    linkUpAt: (id) => sim.trace(0).events.find((e) => e.kind === 'linkState' && e.link === id && e.up)?.t,
    pcMac: (id) => portMac(deviceMacBase(id), 1),
  };
}

/** Echoes of one `ping` at a host shell. */
export const PING_COUNT = 5;

/** Ping `target` from `pc` (five echoes) and return the number of echo replies the PC consumed. */
export function ping(w: LagWorld, pc: string, target: string): number {
  const before = w.events().length;
  const s = w.sim.cli.open(pc, 'console');
  w.sim.cli.exec(s, `ping ${target}`);
  w.sim.runFor(20 * SEC);
  return w.events().slice(before).filter((e) => e.kind === 'pduConsumed' && e.device === pc && e.pdu.tag === 'echo-reply').length;
}

/** Table writes of the `etherchannel` table on `dev` as `[t, key, state]`. */
export function channelWrites(events: readonly TraceEvent[], dev: string): [number, string, string][] {
  return events.flatMap((e) => (e.kind === 'tableWrite' && e.device === dev && e.table === 'etherchannel' ? [[e.t, e.key, String(e.row.state)] as [number, string, string]] : []));
}
