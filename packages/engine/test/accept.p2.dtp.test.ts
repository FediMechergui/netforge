/**
 * P2 acceptance — trunk negotiation (ARCHITECTURE-P2 §3.3, D3, §10.1 row `accept.p2.dtp`), on real two-switch worlds
 * of `test/p2.world.ts` (P2 profile; vlan, dtp, etherchannel and stp daemons; both NF-C2960 boot at 30 s and the cable
 * comes up at 30 s).
 *
 *  • All 25 mode pairs of §3.3 (access, trunk, desirable, auto, trunk + nonegotiate): 1 s after link-up each end's
 *    operational mode equals the table; auto–auto and auto–access (and every other pair without an initiator) send
 *    zero DTP PDUs.
 *  • After a negotiated trunk's peer is reconfigured to `access`, the dynamic port is `access` within propagation +
 *    1 s, told by the access port's one DTP frame.
 *  • A Port-channel of two `dynamic desirable` members facing two `dynamic auto` members is a trunk; a member whose
 *    peer is set to access is `suspended` with reason `trunk negotiation differs from Port-channel1`.
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import type { SwitchportMode } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DtpRow, EtherchannelRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { DTP_PROCESS, DTP_TAG, createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { trunkNegotiationReason } from '../src/protocols/etherchannel/compat.js';
import { channelOperOf, operOf } from '../src/protocols/l2/membership.js';
import { readSwitchport } from '../src/protocols/l2/switchport-config.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const SWITCH = 'switch.nfc2960';
const GI1: PortId = 'GigabitEthernet0/1';
const GI2: PortId = 'GigabitEthernet0/2';
const PO1: PortId = 'Port-channel1';
/** Both switches boot at 30 s and the cable comes up right then. */
const LINK_UP = 30 * SEC;

type Kind = 'access' | 'trunk' | 'desirable' | 'auto' | 'nonegotiate';
const KINDS: readonly Kind[] = ['access', 'trunk', 'desirable', 'auto', 'nonegotiate'];

/** §3.3 rule 3: this port × the neighbour → the operational mode ('nonegotiate' = a silent trunk). */
const TABLE: Readonly<Record<Kind, Readonly<Record<Kind, 'access' | 'trunk'>>>> = {
  trunk: { access: 'trunk', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'trunk' },
  desirable: { access: 'access', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'access' },
  auto: { access: 'access', trunk: 'trunk', desirable: 'trunk', auto: 'access', nonegotiate: 'access' },
  access: { access: 'access', trunk: 'access', desirable: 'access', auto: 'access', nonegotiate: 'access' },
  nonegotiate: { access: 'trunk', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'trunk' },
};
const ADMIN: Readonly<Record<Kind, SwitchportMode>> = { access: 'access', trunk: 'trunk', desirable: 'dynamic-desirable', auto: 'dynamic-auto', nonegotiate: 'trunk' };
/** Only trunk and dynamic desirable ports initiate (D3). */
const speaks = (k: Kind): boolean => k === 'trunk' || k === 'desirable';

/** The interface lines of a matrix column. */
function linesFor(kind: Kind, port: PortId = GI1): string[] {
  switch (kind) {
    case 'access':
      return section(`interface ${port}`, ['switchport mode access']);
    case 'trunk':
      return section(`interface ${port}`, ['switchport mode trunk']);
    case 'desirable':
      return section(`interface ${port}`, ['switchport mode dynamic desirable']);
    case 'auto':
      return [];
    case 'nonegotiate':
      return section(`interface ${port}`, ['switchport mode trunk', 'switchport nonegotiate']);
  }
}

interface World {
  readonly sim: Simulation;
  /** The link between Gi0/1 and Gi0/1. */
  readonly link: string;
  events(): TraceEvent[];
}

/** SW1 and SW2 (NF-C2960) joined Gi0/1 ↔ Gi0/1 (and Gi0/2 ↔ Gi0/2 with `twoLinks`), from startup sections. */
function twoSwitches(sw1: readonly (readonly string[])[], sw2: readonly (readonly string[])[], opts: { twoLinks?: boolean; seed?: number } = {}): World {
  const sim = createP2Simulation({ seed: opts.seed ?? 11, profile: 'P2', factories: L2 });
  sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: configText([['hostname SW1'], ...sw1]) });
  sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: configText([['hostname SW2'], ...sw2]) });
  const link = sim.addLink({ id: 'l1', a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
  if (opts.twoLinks === true) sim.addLink({ id: 'l2', a: { device: 'sw1', port: GI2 }, b: { device: 'sw2', port: GI2 } });
  return { sim, link, events: () => sim.trace(0).events };
}

const dtpRow = (sim: Simulation, dev: string, port: PortId): DtpRow | undefined => sim.device(dev)!.tables.get<DtpRow>('dtp')!.get(port);
/** The operational mode of a port as eth-switch sees it: the static mode, or the negotiated one from the `dtp` row. */
const operIn = (sim: Simulation, dev: string, port: PortId): 'access' | 'trunk' => operOf(readSwitchport(sim.device(dev)!.running, port), dtpRow(sim, dev, port));
const dtpCreated = (evs: readonly TraceEvent[], dev?: string) => ofKind(evs, 'pduCreated').filter((e) => e.pdu.tag === DTP_TAG && (dev === undefined || e.device === dev));
const dtpTransitions = (evs: readonly TraceEvent[], dev: string) => ofKind(evs, 'debug').filter((e) => e.event.device === dev && e.event.process === DTP_PROCESS && e.event.fsm !== undefined);

describe('accept P2 dtp: the 25 mode pairs of §3.3', () => {
  for (const mine of KINDS) {
    for (const theirs of KINDS) {
      const want1 = TABLE[mine][theirs];
      const want2 = TABLE[theirs][mine];
      it(`SW1 ${mine} ↔ SW2 ${theirs}: SW1 ${want1}, SW2 ${want2} one second after link-up${speaks(mine) || speaks(theirs) ? '' : ', with no DTP frame'}`, () => {
        const w = twoSwitches([linesFor(mine)], [linesFor(theirs)]);
        w.sim.runUntil(LINK_UP + 1 * SEC);
        const evs = w.events();
        const up = ofKind(evs, 'linkState').find((e) => e.link === w.link && e.up);
        expect(up?.t).toBe(LINK_UP);
        expect(operIn(w.sim, 'sw1', GI1)).toBe(want1);
        expect(operIn(w.sim, 'sw2', GI1)).toBe(want2);
        const frames = dtpCreated(evs);
        if (!speaks(mine) && !speaks(theirs)) expect(frames).toEqual([]);
        else expect(frames.length).toBeGreaterThan(0);
        for (const f of ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === DTP_TAG)) expect(f.background).toBe(true);
        // rows: initiators from link-up; auto and access ports only once a frame arrived; nonegotiate never
        const expectRow = (kind: Kind, other: Kind, dev: string): void => {
          const row = dtpRow(w.sim, dev, GI1);
          if (kind === 'nonegotiate' || ((kind === 'auto' || kind === 'access') && !speaks(other))) expect(row, `${dev} ${kind}`).toBeUndefined();
          else expect(row, `${dev} ${kind}`).toMatchObject({ admin: ADMIN[kind], oper: TABLE[kind][other] });
        };
        expectRow(mine, theirs, 'sw1');
        expectRow(theirs, mine, 'sw2');
        // every transition happened between link-up and one second later
        for (const dev of ['sw1', 'sw2']) {
          for (const t of dtpTransitions(evs, dev)) {
            expect(t.t).toBeGreaterThanOrEqual(LINK_UP);
            expect(t.t).toBeLessThanOrEqual(LINK_UP + 1 * SEC);
          }
        }
        // the outcome holds: no flapping over the next minute
        w.sim.runFor(60 * SEC);
        expect(operIn(w.sim, 'sw1', GI1)).toBe(want1);
        expect(operIn(w.sim, 'sw2', GI1)).toBe(want2);
      });
    }
  }

  it('auto–auto and auto–access are silent for 300 s: no DTP PDU, no dtp row, no dtp debug line', () => {
    for (const pair of [['auto', 'auto'], ['auto', 'access'], ['access', 'auto']] as const) {
      const w = twoSwitches([linesFor(pair[0])], [linesFor(pair[1])]);
      w.sim.runUntil(LINK_UP + 300 * SEC);
      const evs = w.events();
      expect(dtpCreated(evs), pair.join('-')).toEqual([]);
      expect(ofKind(evs, 'debug').filter((e) => e.event.process === DTP_PROCESS), pair.join('-')).toEqual([]);
      expect(ofKind(evs, 'tableWrite').filter((e) => e.table === 'dtp'), pair.join('-')).toEqual([]);
      expect(operIn(w.sim, 'sw1', GI1)).toBe('access');
      expect(operIn(w.sim, 'sw2', GI1)).toBe('access');
    }
  });
});

describe('accept P2 dtp: reconfiguration (§3.3 rule 1b)', () => {
  it('a negotiated trunk whose peer becomes access: one DTP frame from the access port, the dynamic port is access within propagation + 1 s', () => {
    const w = twoSwitches([linesFor('desirable')], [linesFor('auto')]);
    w.sim.runUntil(LINK_UP + 5 * SEC);
    expect(operIn(w.sim, 'sw1', GI1)).toBe('trunk');
    expect(operIn(w.sim, 'sw2', GI1)).toBe('trunk');
    const cursor = w.sim.trace(0).next;
    expect(w.sim.configure('sw1', [`interface ${GI1}`, 'switchport mode access']).ok).toBe(true);
    const at = w.sim.now;
    w.sim.runFor(1 * SEC);
    const evs = w.sim.trace(cursor).events;
    const told = dtpCreated(evs, 'sw1');
    expect(told).toHaveLength(1);
    expect(told[0]!.t).toBe(at);
    expect(dtpCreated(evs, 'sw2')).toEqual([]);
    expect(operIn(w.sim, 'sw2', GI1)).toBe('access');
    expect(dtpRow(w.sim, 'sw2', GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'access', status: 'negotiated', neighborMode: 'access' });
    expect(dtpRow(w.sim, 'sw1', GI1)).toMatchObject({ admin: 'access', oper: 'access', status: 'static' });
    const back = dtpTransitions(evs, 'sw2');
    expect(back).toHaveLength(1);
    expect(back[0]!.event.fsm).toMatchObject({ machine: 'dtp', subject: GI1, from: 'trunk', to: 'access' });
    expect(back[0]!.t - at).toBeLessThan(1 * SEC);
    // the frame that told SW2 is the one SW1 sent
    expect(back[0]!.event.fsm!.pdu).toBe(told[0]!.pdu.id);
    // and both ends fall silent
    w.sim.runFor(120 * SEC);
    expect(dtpCreated(w.sim.trace(cursor).events)).toHaveLength(1);
  });
});

describe('accept P2 dtp: Port-channel members negotiate on their own (§3.3 rule 5, §3.7 compatibility)', () => {
  it('two desirable members facing two auto members bundle as a trunk; a member whose peer turns access is suspended', () => {
    const member = (port: PortId, mode: Kind): string[] => [...(mode === 'auto' ? [`interface ${port}`] : linesFor(mode, port)), ' channel-group 1 mode on'];
    const w = twoSwitches(
      [['interface Port-channel1', ' switchport mode dynamic desirable'], member(GI1, 'desirable'), member(GI2, 'desirable')],
      [['interface Port-channel1'], member(GI1, 'auto'), member(GI2, 'auto')],
      { twoLinks: true },
    );
    w.sim.runUntil(LINK_UP + 5 * SEC);
    for (const dev of ['sw1', 'sw2']) {
      for (const port of [GI1, GI2]) {
        expect(operIn(w.sim, dev, port), `${dev} ${port}`).toBe('trunk');
        expect(w.sim.device(dev)!.tables.get<EtherchannelRow>('etherchannel')!.get(port), `${dev} ${port}`).toMatchObject({ bundle: PO1, state: 'bundled' });
      }
      expect(w.sim.device(dev)!.port(PO1)?.operUp, dev).toBe(true);
      const rows = [dtpRow(w.sim, dev, GI1), dtpRow(w.sim, dev, GI2)];
      expect(channelOperOf(readSwitchport(w.sim.device(dev)!.running, PO1), rows), dev).toBe('trunk');
    }
    // SW2 Gi0/2 becomes an access port: it tells SW1 at once; SW1 Gi0/2 negotiates access and no longer matches its bundle
    expect(w.sim.configure('sw2', [`interface ${GI2}`, 'switchport mode access']).ok).toBe(true);
    w.sim.runFor(1 * SEC);
    expect(operIn(w.sim, 'sw1', GI1)).toBe('trunk');
    expect(operIn(w.sim, 'sw1', GI2)).toBe('access');
    const suspended = w.sim.device('sw1')!.tables.get<EtherchannelRow>('etherchannel')!.get(GI2)!;
    expect(suspended.state).toBe('suspended');
    expect(suspended.reason).toBe(trunkNegotiationReason(PO1));
    expect(suspended.reason).toBe('trunk negotiation differs from Port-channel1');
    expect(w.sim.device('sw1')!.tables.get<EtherchannelRow>('etherchannel')!.get(GI1)!.state).toBe('bundled');
    expect(channelOperOf(readSwitchport(w.sim.device('sw1')!.running, PO1), [dtpRow(w.sim, 'sw1', GI1)])).toBe('trunk');
    expect(w.sim.device('sw1')!.port(PO1)?.operUp).toBe(true);
  });
});
