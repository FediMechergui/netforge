/**
 * P2 acceptance — EtherChannel with LACP, and its misconfigurations (ARCHITECTURE-P2 §3.7, D10, §4.2, §10.1 row
 * `accept.p2.etherchannel`), on real P2-profile worlds of `test/p2.world.ts` (vlan, dtp, etherchannel and stp).
 *
 * §3.7 setup: SW1 Gi0/1–2 ↔ SW2 Gi0/1–2, every member `switchport mode trunk`, SW1 `channel-group 1 mode active`,
 * SW2 `mode passive`; PC1 and PC2 on SW1 Fa0/1–2, PC3 and PC4 on SW2 Fa0/1–2 (one subnet, VLAN 1).
 *  • both members `bundled` within 3 s of link-up; Port-channel1 up; `show etherchannel summary` lists the bundle
 *    `in use` with both members bundled; `stp` rows exist for Port-channel1 and none for Gi0/1–2;
 *  • load balancing: the four PCs are chosen (by device id) so that the §3.7 fold of their MACs maps to both
 *    members (a precondition the test asserts) and each PC's frames leave on member `fold(mac) mod 2`;
 *  • cutting Gi0/2: the bundle stays up, Port-channel1's `stp` cost becomes 4, no role or state change, no topology
 *    change and no CAM flush on Port-channel1 in the next 60 s; a running ping loses at most the echo in flight;
 *  • passive–passive: every member `individual` with reason `no LACP partner` at link-up + 3 s, and a ping between
 *    the switches still succeeds over the spanning-tree path;
 *  • misconfiguration A (`on` against `active`): SW1's members `individual`, SW2's Port-channel1 up, no storm — the
 *    §10.1 loop-storm line-rate event bound holds around a broadcast;
 *  • misconfiguration B: the member with another access VLAN is `suspended` with a reason naming the difference.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac, type MacAddress } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { stpKey, vlanKey, type EtherchannelRow, type StpBridgeRow, type StpPortRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { NO_LACP_PARTNER, configDiffersReason } from '../src/protocols/etherchannel/compat.js';
import { macFold } from '../src/protocols/l2/lag-hash.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { P2P_EVENTS_PER_FRAME } from './p2p.constants.js';
import { ofKind, output, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const GI1: PortId = 'GigabitEthernet0/1';
const GI2: PortId = 'GigabitEthernet0/2';
const FA1: PortId = 'FastEthernet0/1';
const FA2: PortId = 'FastEthernet0/2';
const PO1: PortId = 'Port-channel1';
const MEMBERS: readonly PortId[] = [GI1, GI2];
/** Switches boot at 30 s; the bundle forms by 33 s; every port forwards by 63 s; the boot TC windows end by 98 s. */
const CONVERGED = 130 * SEC;
/** The four PCs: PC1/PC2 on SW1, PC3/PC4 on SW2 (10.0.0.1–4/24). */
const PCS: readonly [id: string, sw: string, port: PortId][] = [['pc1', 'sw1', FA1], ['pc2', 'sw1', FA2], ['pc3', 'sw2', FA1], ['pc4', 'sw2', FA2]];

interface ChannelOptions {
  readonly seed?: number;
  /** SW1's member mode (default `active`). */
  readonly sw1Mode?: string;
  /** SW2's member mode (default `passive`). */
  readonly sw2Mode?: string;
  /** Extra interface lines under a member of SW1 (misconfiguration B), by port. */
  readonly sw1Extra?: Partial<Record<PortId, readonly string[]>>;
  /** Global lines of SW1. */
  readonly sw1Global?: readonly string[];
  /** Switchport line of every member (default `switchport mode trunk`, the §3.7 setup). */
  readonly memberLine?: string;
}

/** The §3.7 world. Link ids: `l1` (Gi0/1–Gi0/1), `l2` (Gi0/2–Gi0/2), `l_pc1` … `l_pc4`. Nothing has run yet. */
function channelWorld(o: ChannelOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, profile: 'P2', factories: L2 });
  const memberLine = o.memberLine ?? 'switchport mode trunk';
  const member = (port: PortId, mode: string, extra: readonly string[] = []): string[] => section(`interface ${port}`, [memberLine, ...extra, `channel-group 1 mode ${mode}`]);
  const cfg = (host: string, mode: string, extra: ChannelOptions['sw1Extra'] = {}, globals: readonly string[] = []): string =>
    configText([[`hostname ${host}`], ...globals.map((g) => [g]), ['interface Port-channel1', ` ${memberLine}`], member(GI1, mode, extra[GI1]), member(GI2, mode, extra[GI2])]);
  sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: cfg('SW1', o.sw1Mode ?? 'active', o.sw1Extra, o.sw1Global) });
  sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: cfg('SW2', o.sw2Mode ?? 'passive') });
  PCS.forEach(([id, sw, port], i) => {
    sim.addDevice({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.0.0.${i + 1}`, '255.255.255.0') });
    sim.addLink({ id: `l_${id}`, a: { device: id, port: 'GigabitEthernet0' }, b: { device: sw, port } });
  });
  sim.addLink({ id: 'l1', a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
  sim.addLink({ id: 'l2', a: { device: 'sw1', port: GI2 }, b: { device: 'sw2', port: GI2 } });
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
const row = (sim: Simulation, dev: string, port: PortId): EtherchannelRow | undefined => sim.device(dev)!.tables.get<EtherchannelRow>('etherchannel')!.get(port);
const stpRow = (sim: Simulation, dev: string, port: PortId, vlan = 1): StpPortRow | undefined => sim.device(dev)!.tables.get<StpPortRow>('stp')?.get(stpKey(vlan, port));
const bridge = (sim: Simulation, dev: string, vlan = 1): StpBridgeRow => sim.device(dev)!.tables.get<StpBridgeRow>('stp-bridge')!.get(vlanKey(vlan))!;
const pcMac = (id: string): MacAddress => portMac(deviceMacBase(id), 1);
/** The `linkState up` time of `link`. */
function linkUpAt(sim: Simulation, link: string): number {
  const e = events(sim).find((x) => x.kind === 'linkState' && x.link === link && x.up);
  if (e === undefined) throw new Error(`link ${link} never came up`);
  return e.t;
}
/** `[t, state]` of every etherchannel row write of (dev, port), in order. */
function stateWrites(sim: Simulation, dev: string, port: PortId): [number, string][] {
  return ofKind(events(sim), 'tableWrite').filter((e) => e.device === dev && e.table === 'etherchannel' && e.key === port).map((e) => [e.t, String(e.row['state'])]);
}
/** The bundled time of (dev, port): the first `bundled` write. */
function bundledAt(sim: Simulation, dev: string, port: PortId): number {
  const w = stateWrites(sim, dev, port).find((x) => x[1] === 'bundled');
  if (w === undefined) throw new Error(`${dev} ${port} never bundled`);
  return w[0];
}
/** Data frames (not LACP, not BPDU) that left `dev` on a member port, with their Ethernet source. */
function memberFrames(sim: Simulation, evs: readonly TraceEvent[], dev: string): { port: PortId; src: MacAddress }[] {
  return ofKind(evs, 'frameTx')
    .filter((e) => e.from.device === dev && MEMBERS.includes(e.from.port) && e.pdu.tag !== 'lacp' && e.pdu.tag !== 'bpdu')
    .map((e) => ({ port: e.from.port, src: String(sim.pdu(e.pdu.id)!.layers[0]!.fields['src']) as MacAddress }));
}
/**
 * The §10.1 `accept.p2.loop-storm-bounded` line-rate event bound of a window: for every link, both directions can
 * carry at most ⌈duration / slot⌉ minimum-size frames (slot = 84 bytes on the wire at that link's speed), each
 * dispatching `P2P_EVENTS_PER_FRAME` scheduler events, plus 10 %.
 */
function lineRateEventBound(linkSpeedsBps: readonly number[], durationNs: number): number {
  let frames = 0;
  for (const bps of linkSpeedsBps) {
    const slotNs = ((64 + ETH_PHY_OVERHEAD) * 8 * 1_000_000_000) / bps;
    frames += 2 * Math.ceil(durationNs / slotNs);
  }
  return frames * P2P_EVENTS_PER_FRAME * 1.1;
}

describe('accept P2 etherchannel: LACP active/passive (§3.7 steps 1–4)', () => {
  it('both members bundle within 3 s of link-up, Port-channel1 is up and in use, spanning tree runs on the bundle only', () => {
    const sim = channelWorld();
    sim.runUntil(CONVERGED);
    const up = linkUpAt(sim, 'l1');
    expect(linkUpAt(sim, 'l2')).toBe(up);
    for (const dev of ['sw1', 'sw2']) {
      for (const port of MEMBERS) {
        expect(row(sim, dev, port), `${dev} ${port}`).toMatchObject({ bundle: PO1, protocol: 'lacp', mode: dev === 'sw1' ? 'active' : 'passive', state: 'bundled' });
        expect(bundledAt(sim, dev, port) - up, `${dev} ${port}`).toBeLessThanOrEqual(3 * SEC);
        expect(stpRow(sim, dev, port), `${dev} ${port} stp row`).toBeUndefined();
      }
      expect(sim.device(dev)!.port(PO1)!.operUp, dev).toBe(true);
      expect(stpRow(sim, dev, PO1), `${dev} ${PO1} stp row`).toMatchObject({ port: PO1, state: 'forwarding', cost: 3 });
      const summary = sim.cli.exec(sim.cli.open(dev, 'console'), 'show etherchannel summary');
      expect(summary.error, dev).toBeUndefined();
      expect(summary.output, dev).toMatch(/^1\s+Port-channel1\s+in use\s+lacp\s+GigabitEthernet0\/1 \(bundled\), GigabitEthernet0\/2 \(bundled\)$/m);
    }
    expect(ping(sim, 'pc1', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
  });

  it('load balancing: every PC\'s frames leave on the member fold(mac) mod 2, and the four PCs cover both members', () => {
    // precondition (§10.1): the PC ids were chosen so that the folds of their MACs map to both members
    const folds = PCS.map(([id]) => macFold(pcMac(id)) % 2);
    expect(new Set(folds)).toEqual(new Set([0, 1]));
    expect(new Set(folds.slice(0, 2)), 'SW1 side').toEqual(new Set([0, 1]));
    expect(new Set(folds.slice(2)), 'SW2 side').toEqual(new Set([0, 1]));
    const sim = channelWorld();
    sim.runUntil(CONVERGED);
    // the folds above are of the PCs' ACTUAL MACs
    for (const [id] of PCS) expect(sim.device(id)!.port('GigabitEthernet0')!.mac, id).toBe(pcMac(id));
    const cursor = sim.trace(0).next;
    expect(ping(sim, 'pc1', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(sim, 'pc2', '10.0.0.4').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(sim, 'pc3', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(sim, 'pc4', '10.0.0.1').text).toContain('Sent 5, received 5, lost 0');
    const evs = sim.trace(cursor).events;
    for (const [id, sw] of PCS) {
      const mac = pcMac(id);
      const want = MEMBERS[macFold(mac) % 2]!;
      const frames = memberFrames(sim, evs, sw).filter((f) => f.src === mac);
      expect(frames.length, id).toBeGreaterThan(0);
      expect(frames.map((f) => f.port), id).toEqual(frames.map(() => want));
    }
  });
});

describe('accept P2 etherchannel: losing a member (§3.7 step 7)', () => {
  it('cutting Gi0/2 keeps the bundle up: cost 3 -> 4, no role, state, topology change or bundle CAM flush in 60 s; a running ping loses at most one echo', () => {
    const sim = channelWorld();
    sim.runUntil(CONVERGED);
    expect(ping(sim, 'pc1', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
    const before = {
      sw1: { ...stpRow(sim, 'sw1', PO1)!, cost: 4, updatedAt: 0 },
      sw2: { ...stpRow(sim, 'sw2', PO1)!, cost: 4, updatedAt: 0 },
      tc1: bridge(sim, 'sw1').topologyChanges,
      tc2: bridge(sim, 'sw2').topologyChanges,
      cam: sim.device('sw1')!.tables.cam.rows().filter((r) => r.port === PO1).map((r) => r.mac).sort(),
    };
    expect(stpRow(sim, 'sw1', PO1)!.cost).toBe(3);
    expect(before.cam).toEqual([pcMac('pc3')]);
    // a running ping: two echoes done, the third in flight when the member is cut
    const cursor = sim.trace(0).next;
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, 'ping 10.0.0.3');
    sim.runFor(2 * SEC + 500);
    const T = sim.now;
    sim.removeLink('l2');
    sim.runUntil(T + 60 * SEC);
    const evs = sim.trace(cursor).events;
    const report = output(evs, session);
    expect(report).toMatch(/Sent 5, received [45], lost [01] /);
    for (const dev of ['sw1', 'sw2']) {
      expect(row(sim, dev, GI2), dev).toMatchObject({ state: 'down' });
      expect(row(sim, dev, GI1), dev).toMatchObject({ state: 'bundled' });
      expect(sim.device(dev)!.port(PO1)!.operUp, dev).toBe(true);
      const after = stpRow(sim, dev, PO1)!;
      expect(after.cost, dev).toBe(4);
      expect({ ...after, updatedAt: 0 }, dev).toEqual(before[dev as 'sw1' | 'sw2']);
    }
    expect(bridge(sim, 'sw1').topologyChanges).toBe(before.tc1);
    expect(bridge(sim, 'sw2').topologyChanges).toBe(before.tc2);
    const since = evs.filter((e) => e.t >= T);
    expect(ofKind(since, 'frameTx').filter((e) => e.pdu.tag === 'bpdu' && (e.pdu.summary.includes('[TC') || e.pdu.summary.includes('topology change')))).toEqual([]);
    expect(ofKind(since, 'tableWrite').filter((e) => e.table === 'stp' && (e.row['port'] === PO1) && (e.row['role'] !== before[e.device as 'sw1' | 'sw2'].role || e.row['state'] !== 'forwarding'))).toEqual([]);
    expect(ofKind(since, 'tableExpire').filter((e) => e.table === 'cam' && e.row['port'] === PO1)).toEqual([]);
    expect(sim.device('sw1')!.tables.cam.rows().filter((r) => r.port === PO1).map((r) => r.mac).sort()).toEqual(before.cam);
    // flows rehash onto Gi0/1
    const cursor2 = sim.trace(0).next;
    expect(ping(sim, 'pc2', '10.0.0.4').text).toContain('Sent 5, received 5, lost 0');
    const frames = memberFrames(sim, sim.trace(cursor2).events, 'sw1');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.port === GI1)).toBe(true);
  });
});

describe('accept P2 etherchannel: no partner and misconfigurations (§3.7 steps 8–9)', () => {
  it('passive–passive: every member individual with `no LACP partner` at link-up + 3 s; the ping crosses the spanning-tree path', () => {
    const sim = channelWorld({ sw1Mode: 'passive', sw2Mode: 'passive' });
    sim.runUntil(CONVERGED);
    const up = linkUpAt(sim, 'l1');
    for (const dev of ['sw1', 'sw2']) {
      for (const port of MEMBERS) {
        expect(row(sim, dev, port), `${dev} ${port}`).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
        const at = stateWrites(sim, dev, port).find((x) => x[1] === 'individual')![0];
        expect(at - up, `${dev} ${port}`).toBe(3 * SEC);
        expect(stpRow(sim, dev, port), `${dev} ${port}`).toBeDefined();
      }
      expect(sim.device(dev)!.port(PO1)?.operUp, dev).toBe(false);
      expect(stpRow(sim, dev, PO1), dev).toBeUndefined();
    }
    expect(ofKind(events(sim), 'frameTx').filter((e) => e.pdu.tag === 'lacp')).toEqual([]);
    // the two individual links form a loop that spanning tree breaks: exactly one member end is blocking
    const memberRows = ['sw1', 'sw2'].flatMap((dev) => MEMBERS.map((p) => stpRow(sim, dev, p)!));
    expect(memberRows.filter((r) => r.state !== 'forwarding')).toHaveLength(1);
    expect(memberRows.filter((r) => r.state !== 'forwarding')[0]!.role).toBe('alternate');
    expect(ping(sim, 'pc1', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
  });

  it('misconfiguration A (SW2 `on` against SW1 `active`): SW1 individual, SW2 bundled and up, no storm', () => {
    const sim = channelWorld({ sw1Mode: 'active', sw2Mode: 'on' });
    sim.runUntil(CONVERGED);
    for (const port of MEMBERS) {
      expect(row(sim, 'sw2', port)).toMatchObject({ state: 'bundled', protocol: 'static' });
      expect(row(sim, 'sw1', port)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
    }
    expect(sim.device('sw2')!.port(PO1)!.operUp).toBe(true);
    expect(sim.device('sw1')!.port(PO1)?.operUp).toBe(false);
    // no storm: one broadcast (PC1's ARP request), then one second at line rate is the most any loop could dispatch
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, 'ping 10.0.0.3');
    const window = sim.runFor(1 * SEC);
    const ends: readonly [string, PortId][] = [['sw1', GI1], ['sw1', GI2], ...PCS.map(([, sw, port]) => [sw, port] as [string, PortId])];
    const speeds = ends.map(([dev, port]) => sim.device(dev)!.portView(port)!.speedBps!);
    expect(speeds.every((s) => s !== undefined && s > 0)).toBe(true);
    expect(window.events).toBeLessThanOrEqual(lineRateEventBound(speeds, 1 * SEC));
    expect(ofKind(sim.trace(0).events, 'drop').filter((e) => e.reason === 'queue-full')).toEqual([]);
    sim.runToIdle();
    expect(output(sim.trace(0).events, session)).toContain('Sent 5, received 5, lost 0');
  });

  it('misconfiguration B: the member with another access VLAN is suspended with a reason naming the difference', () => {
    const sim = channelWorld({
      sw1Mode: 'active', sw2Mode: 'active', memberLine: 'switchport mode access',
      sw1Global: ['vlan 20'], sw1Extra: { [GI2]: ['switchport access vlan 20'] },
    });
    sim.runUntil(CONVERGED);
    expect(row(sim, 'sw1', GI1)!.state).toBe('bundled');
    const suspended = row(sim, 'sw1', GI2)!;
    expect(suspended.state).toBe('suspended');
    expect(suspended.reason).toBe(configDiffersReason(PO1, 'access VLAN 20 vs 1'));
    expect(suspended.reason).toContain('20');
    expect(sim.device('sw1')!.port(PO1)!.operUp).toBe(true);
    expect(ping(sim, 'pc1', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
    // a suspended member carries no traffic
    const frames = memberFrames(sim, sim.trace(0).events, 'sw1');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.port === GI1)).toBe(true);
  });
});
