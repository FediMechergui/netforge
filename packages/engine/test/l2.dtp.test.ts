/**
 * W3 l2 (ARCHITECTURE-P2 D3, D6, D7, §2.6 DtpRow, §3.3, §4.2, §4.3, §5.1, §5.4, §10.1 `accept.p2.dtp`): the `dtp`
 * daemon — the §3.3 decision matrix, who speaks (a dynamic auto port never initiates, an access port only answers,
 * nonegotiate ports are silent and ignore negotiation), the row shapes and their transitions, ageing, link changes,
 * and the real runtime on `test/p2.world.ts` worlds (two P2-stage NF-C2960 joined by a cable, real link timing): the
 * 5×5 mode matrix, silence on untouched switches in both profiles, an access port answering at once after a
 * reconfiguration, ageing after a neighbour went `nonegotiate`, and the members of a Port-channel in dynamic modes.
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_DTP } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { SwitchportMode } from '../src/contracts/port.js';
import type { Action, Process } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DtpRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { DTP_MODE_ACCESS, DTP_MODE_AUTO, DTP_MODE_DESIRABLE, DTP_MODE_TRUNK } from '../src/pdu/codecs/dtp.js';
import {
  DTP_AGE_NS,
  DTP_CAUSE_AGED,
  DTP_CAUSE_LINK_DOWN,
  DTP_DEBUG_CATEGORY,
  DTP_HELLO_NS,
  DTP_PROCESS,
  DTP_TAG,
  createDtp,
  dtpAdminModeOf,
  dtpAgeTimer,
  dtpFrameSpecs,
  dtpHelloTimer,
  dtpModeOf,
  dtpNotNegotiatingDetail,
  isDtpDelta,
  isDtpInitiator,
  negotiateOper,
} from '../src/protocols/dtp.js';
import { channelOperOf, operOf } from '../src/protocols/l2/membership.js';
import { readSwitchport } from '../src/protocols/l2/switchport-config.js';
import { createVlan } from '../src/protocols/vlan.js';
import { GI1, GI2, dropsOf, p2SwitchHarness, protosOf, sendsOf } from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';
import { createP2Simulation } from './p2.world.js';
import { ofKind } from './sim.harness.js';

const MODES: readonly SwitchportMode[] = ['access', 'trunk', 'dynamic-desirable', 'dynamic-auto'];
const NEIGHBOUR_MAC = '00:1f:00:00:00:99';

/** Expected oper mode per §3.3 rule 3 (this port × neighbour; 'nonegotiate' = a silent trunk). */
const MATRIX: Readonly<Record<string, Readonly<Record<string, 'access' | 'trunk'>>>> = {
  trunk: { access: 'trunk', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'trunk' },
  desirable: { access: 'access', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'access' },
  auto: { access: 'access', trunk: 'trunk', desirable: 'trunk', auto: 'access', nonegotiate: 'access' },
  access: { access: 'access', trunk: 'access', desirable: 'access', auto: 'access', nonegotiate: 'access' },
  nonegotiate: { access: 'trunk', trunk: 'trunk', desirable: 'trunk', auto: 'trunk', nonegotiate: 'trunk' },
};
const MODE_OF: Readonly<Record<string, SwitchportMode>> = { access: 'access', trunk: 'trunk', desirable: 'dynamic-desirable', auto: 'dynamic-auto', nonegotiate: 'trunk' };

// ─────────────────────────────── helpers (fake ctx) ───────────────────────────────

/** A received message built on the harness as the neighbour `NEIGHBOUR_MAC` would send it. */
function message(h: P2SwitchHarness, mode: SwitchportMode, operTrunk = false): Pdu {
  const specs: LayerSpec[] = dtpFrameSpecs(NEIGHBOUR_MAC, mode, operTrunk);
  return h.ctx.newPdu(specs, { tag: DTP_TAG, background: true });
}

const timersOf = (actions: readonly Action[]): Extract<Action, { type: 'timer' }>[] => actions.filter((a): a is Extract<Action, { type: 'timer' }> => a.type === 'timer');
const cancelsOf = (actions: readonly Action[]): string[] => actions.filter((a): a is Extract<Action, { type: 'cancelTimer' }> => a.type === 'cancelTimer').map((a) => a.key);
const l2ChangedOf = (actions: readonly Action[]): Extract<Action, { type: 'l2Changed' }>[] => actions.filter((a): a is Extract<Action, { type: 'l2Changed' }> => a.type === 'l2Changed');
const consumesOf = (actions: readonly Action[]): number => actions.filter((a) => a.type === 'consume').length;
const dtpOf = (pdu: Pdu) => pdu.layer('dtp')!.fields;
const rowOf = (h: P2SwitchHarness, port: PortId): DtpRow | undefined => h.tables.get<DtpRow>('dtp')!.get(port);
/** The transition events of the daemon's own ring (the fake ctx's `transition` records through `debug` with the fsm in `data`). */
const transitions = (d: Process) => d.debugEvents().filter((e) => e.fsm !== undefined);

describe('pure helpers', () => {
  it('the §3.3 matrix: static modes never move; desirable trunks facing anything that speaks; auto trunks only facing trunk or desirable', () => {
    const facing = (n: string): SwitchportMode | undefined => (n === 'nonegotiate' ? undefined : MODE_OF[n]);
    for (const mine of ['trunk', 'desirable', 'auto', 'access'] as const) {
      for (const theirs of ['access', 'trunk', 'desirable', 'auto', 'nonegotiate'] as const) {
        expect(negotiateOper(MODE_OF[mine]!, facing(theirs)), `${mine} facing ${theirs}`).toBe(MATRIX[mine]![theirs]);
      }
    }
    expect(negotiateOper('dynamic-desirable', undefined)).toBe('access');
    expect(negotiateOper('dynamic-auto', undefined)).toBe('access');
    expect(isDtpInitiator('trunk')).toBe(true);
    expect(isDtpInitiator('dynamic-desirable')).toBe(true);
    expect(isDtpInitiator('dynamic-auto')).toBe(false);
    expect(isDtpInitiator('access')).toBe(false);
  });

  it('wire modes round-trip; unknown values decode to nothing', () => {
    expect(MODES.map(dtpAdminModeOf)).toEqual([DTP_MODE_ACCESS, DTP_MODE_TRUNK, DTP_MODE_DESIRABLE, DTP_MODE_AUTO]);
    for (const m of MODES) expect(dtpModeOf(dtpAdminModeOf(m))).toBe(m);
    expect(dtpModeOf(0)).toBeUndefined();
    expect(dtpModeOf(9)).toBeUndefined();
    expect(dtpModeOf('2')).toBeUndefined();
  });

  it('a message is 802.3 + LLC/SNAP to the NF control group with the NF PID (§3.3 rule 2)', () => {
    const h = p2SwitchHarness();
    const pdu = h.ctx.newPdu(dtpFrameSpecs('00:1f:00:00:00:01', 'dynamic-desirable', false), { tag: DTP_TAG, background: true });
    expect(protosOf(pdu)).toEqual(['ethernet', 'llc', 'dtp']);
    expect(pdu.get('ethernet.dst')).toBe(NF_L2_CONTROL_MAC);
    expect(pdu.get('ethernet.src')).toBe('00:1f:00:00:00:01');
    expect(pdu.layer('llc')!.fields).toMatchObject({ dsap: 0xaa, ssap: 0xaa, control: 3, oui: NF_OUI, type: NF_PID_DTP });
    expect(dtpOf(pdu)).toEqual({ version: 1, domain: '', adminMode: DTP_MODE_DESIRABLE, operTrunk: false, trunkType: 1, neighbor: '00:1f:00:00:00:01' });
    expect(pdu.meta).toMatchObject({ tag: 'dtp', background: true });
  });

  it('only `switchport mode …` and `switchport nonegotiate` under an interface are dtp lines', () => {
    expect(isDtpDelta({ context: [['interface', GI1]], line: ['switchport', 'mode', 'trunk'] })).toBe(true);
    expect(isDtpDelta({ context: [['interface', GI1]], line: ['switchport', 'mode', 'dynamic', 'auto'] })).toBe(true);
    expect(isDtpDelta({ context: [['interface', GI1]], line: ['switchport', 'nonegotiate'] })).toBe(true);
    expect(isDtpDelta({ context: [['interface', GI1]], line: ['switchport', 'access', 'vlan', '10'] })).toBe(false);
    expect(isDtpDelta({ context: [['interface', GI1]], line: ['switchport', 'trunk', 'native', 'vlan', '99'] })).toBe(false);
    expect(isDtpDelta({ context: [], line: ['switchport', 'mode', 'trunk'] })).toBe(false);
    expect(isDtpDelta({ context: [['vlan', '10']], line: ['name', 'X'] })).toBe(false);
  });
});

// ─────────────────────────────── the daemon on a fake ctx ───────────────────────────────

describe('silence (§4.3)', () => {
  it('an untouched switch: init with every port up does nothing — no row, no message, no timer, no debug line', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    expect(d.name).toBe(DTP_PROCESS);
    expect(d.handles).toBeUndefined();
    expect(d.init!(h.ctx)).toEqual([]);
    expect(d.onLinkChange!(h.ctx, GI1, true)).toEqual([]);
    expect(d.onLinkChange!(h.ctx, GI1, false)).toEqual([]);
    expect(d.onTimer(h.ctx, dtpHelloTimer(GI1))).toEqual([]);
    expect(d.onTimer(h.ctx, 'anything')).toEqual([]);
    expect(d.onConfig(h.ctx, { op: 'set', context: [['interface', GI1]], line: ['switchport', 'access', 'vlan', '10'] })).toEqual([]);
    expect(d.onEvent!(h.ctx, { kind: 'l2.changed', what: 'vlans', vlan: 10, from: 'vlan' })).toEqual([]);
    expect(h.tables.get<DtpRow>('dtp')!.size).toBe(0);
    expect(h.debug).toEqual([]);
    expect(h.trace).toEqual([]);
    expect(d.stateSnapshot()).toEqual({ process: 'dtp', state: { speaking: [], sent: 0, received: 0 } });
  });

  it('a dynamic auto port (the default) never initiates: `switchport mode dynamic auto` typed explicitly changes nothing', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    expect(h.lines(d, GI1, ['switchport mode dynamic auto'])).toEqual([]);
    expect(rowOf(h, GI1)).toBeUndefined();
    expect(h.trace).toEqual([]);
  });
});

describe('initiators: trunk and dynamic desirable (§3.3 rule 1)', () => {
  it('`switchport mode trunk` on an up port: a static trunk row, one message at once, the 30 s periodic timer, the transition and the L2 signal', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.setNow(5 * SEC);
    const actions = h.lines(d, GI1, ['switchport mode trunk']);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'trunk', oper: 'trunk', status: 'static', updatedAt: 5 * SEC });
    expect(l2ChangedOf(actions)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    const out = sendsOf(actions);
    expect(out).toHaveLength(1);
    expect(out[0]!.port).toBe(GI1);
    expect(dtpOf(out[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_TRUNK, operTrunk: true, neighbor: h.ctx.macOf(GI1) });
    expect(out[0]!.pdu.get('ethernet.src')).toBe(h.ctx.macOf(GI1));
    expect(out[0]!.pdu.meta).toMatchObject({ tag: 'dtp', background: true });
    expect(timersOf(actions)).toEqual([{ type: 'timer', key: dtpHelloTimer(GI1), delay: DTP_HELLO_NS, periodic: true }]);
    expect(DTP_HELLO_NS).toBe(30 * SEC);
    const t = transitions(d);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ category: DTP_DEBUG_CATEGORY, fsm: { machine: 'dtp', subject: GI1, port: GI1, from: 'access', to: 'trunk', cause: 'switchport mode trunk' } });
    expect(h.kinds('tableWrite').map((e) => [e.table, e.key])).toEqual([['dtp', GI1]]);
    expect(d.stateSnapshot().state).toEqual({ speaking: [GI1], sent: 1, received: 0 });
    // the hello tick sends again and re-arms; the row is untouched
    h.setNow(35 * SEC);
    const tick = d.onTimer(h.ctx, dtpHelloTimer(GI1));
    expect(sendsOf(tick)).toHaveLength(1);
    expect(dtpOf(sendsOf(tick)[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_TRUNK, operTrunk: true });
    expect(timersOf(tick)).toEqual([{ type: 'timer', key: dtpHelloTimer(GI1), delay: DTP_HELLO_NS, periodic: true }]);
    expect(h.kinds('tableWrite')).toHaveLength(1);
    // a trunk port facing an access neighbour stays trunk (row: static, neighbour recorded), no answer
    const rx = d.onPdu(h.ctx, message(h, 'access'), GI1);
    expect(consumesOf(rx)).toBe(1);
    expect(sendsOf(rx)).toEqual([]);
    expect(timersOf(rx)).toEqual([{ type: 'timer', key: dtpAgeTimer(GI1), delay: DTP_AGE_NS, periodic: true }]);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', status: 'static', neighbor: NEIGHBOUR_MAC, neighborMode: 'access' });
    expect(l2ChangedOf(rx)).toEqual([]);
  });

  it('`dynamic desirable` on an up port: a waiting row (oper access), one message and the timer; no transition yet', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    const actions = h.lines(d, GI1, ['switchport mode dynamic desirable']);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'dynamic-desirable', oper: 'access', status: 'waiting', updatedAt: 0 });
    expect(sendsOf(actions)).toHaveLength(1);
    expect(dtpOf(sendsOf(actions)[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_DESIRABLE, operTrunk: false });
    expect(timersOf(actions).map((t) => t.key)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(actions)).toEqual([]);
    expect(transitions(d)).toEqual([]);
    // an auto neighbour answers: trunk, negotiated
    const rx = d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI1);
    expect(rowOf(h, GI1)).toMatchObject({ oper: 'trunk', status: 'negotiated', neighbor: NEIGHBOUR_MAC, neighborMode: 'dynamic-auto' });
    expect(l2ChangedOf(rx)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    expect(sendsOf(rx)).toEqual([]); // desirable never answers, it speaks on its timer
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ from: 'access', to: 'trunk', cause: `neighbour ${NEIGHBOUR_MAC} advertises dynamic auto` });
  });

  it('a port configured while down gets its row and message at link-up, not before', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.setOper(GI1, false);
    expect(h.lines(d, GI1, ['switchport mode trunk'])).toEqual([]);
    expect(rowOf(h, GI1)).toBeUndefined();
    h.setOper(GI1, true);
    const up = d.onLinkChange!(h.ctx, GI1, true);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', status: 'static' });
    expect(sendsOf(up)).toHaveLength(1);
    expect(timersOf(up).map((t) => t.key)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(up)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
  });
});

describe('dynamic auto: answers once it hears a speaker, silent otherwise', () => {
  it('a desirable message: negotiated trunk row, one answer at once, then the 30 s timer; later messages only re-arm ageing', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.setNow(3 * SEC);
    const first = message(h, 'dynamic-desirable');
    const rx = d.onPdu(h.ctx, first, GI1);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'dynamic-auto', oper: 'trunk', status: 'negotiated', neighbor: NEIGHBOUR_MAC, neighborMode: 'dynamic-desirable', updatedAt: 3 * SEC });
    expect(consumesOf(rx)).toBe(1);
    const out = sendsOf(rx);
    expect(out).toHaveLength(1);
    expect(dtpOf(out[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_AUTO, operTrunk: true });
    expect(out[0]!.pdu.meta).toMatchObject({ tag: 'dtp', background: true, triggeredBy: first.id });
    expect(timersOf(rx)).toEqual([
      { type: 'timer', key: dtpAgeTimer(GI1), delay: DTP_AGE_NS, periodic: true },
      { type: 'timer', key: dtpHelloTimer(GI1), delay: DTP_HELLO_NS, periodic: true },
    ]);
    expect(DTP_AGE_NS).toBe(300 * SEC);
    expect(l2ChangedOf(rx)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ machine: 'dtp', subject: GI1, from: 'access', to: 'trunk', pdu: first.id });
    // the next message changes nothing: no write, no answer, only consume + the ageing re-arm
    const writes = h.kinds('tableWrite').length;
    const again = d.onPdu(h.ctx, message(h, 'dynamic-desirable', true), GI1);
    expect(again.map((a) => a.type)).toEqual(['consume', 'timer']);
    expect(timersOf(again)[0]!.key).toBe(dtpAgeTimer(GI1));
    expect(h.kinds('tableWrite')).toHaveLength(writes);
    expect(d.stateSnapshot().state).toEqual({ speaking: [GI1], sent: 1, received: 2 });
  });

  it('a trunk message pulls an auto port to trunk; an access or auto message leaves it access and silent (both silent)', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    const rx = d.onPdu(h.ctx, message(h, 'trunk', true), GI1);
    expect(rowOf(h, GI1)).toMatchObject({ oper: 'trunk', status: 'negotiated', neighborMode: 'trunk' });
    expect(sendsOf(rx)).toHaveLength(1);
    // neighbour reconfigured to access says so at once: back to access, hello cancelled, no answer (§13 #22)
    const back = d.onPdu(h.ctx, message(h, 'access'), GI1);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'access', status: 'negotiated', neighborMode: 'access' });
    expect(sendsOf(back)).toEqual([]);
    expect(cancelsOf(back)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(back)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ from: 'trunk', to: 'access', cause: `neighbour ${NEIGHBOUR_MAC} advertises access` });
    expect(d.stateSnapshot().state).toMatchObject({ speaking: [] });
    // an auto neighbour on a fresh port: access, no answer, no hello — the row records what was heard
    const rx2 = d.onPdu(h.ctx, message(h, 'dynamic-auto'), GI2);
    expect(rowOf(h, GI2)).toMatchObject({ admin: 'dynamic-auto', oper: 'access', status: 'negotiated', neighborMode: 'dynamic-auto' });
    expect(sendsOf(rx2)).toEqual([]);
    expect(timersOf(rx2).map((t) => t.key)).toEqual([dtpAgeTimer(GI2)]);
    expect(l2ChangedOf(rx2)).toEqual([]);
  });
});

describe('access ports answer only (§3.3 rule 1, §13 #22)', () => {
  it('every received message is answered at once with access; no row until then, never a timer', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    expect(h.lines(d, GI1, ['switchport mode access'])).toEqual([]);
    expect(rowOf(h, GI1)).toBeUndefined();
    const first = message(h, 'dynamic-desirable');
    const rx = d.onPdu(h.ctx, first, GI1);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'access', oper: 'access', status: 'static', neighbor: NEIGHBOUR_MAC, neighborMode: 'dynamic-desirable', updatedAt: 0 });
    const out = sendsOf(rx);
    expect(out).toHaveLength(1);
    expect(dtpOf(out[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_ACCESS, operTrunk: false });
    expect(out[0]!.pdu.meta.triggeredBy).toBe(first.id);
    expect(timersOf(rx).map((t) => t.key)).toEqual([dtpAgeTimer(GI1)]);
    expect(l2ChangedOf(rx)).toEqual([]);
    expect(transitions(d)).toEqual([]);
    // answered again, still no hello timer
    const rx2 = d.onPdu(h.ctx, message(h, 'trunk', true), GI1);
    expect(sendsOf(rx2)).toHaveLength(1);
    expect(timersOf(rx2).map((t) => t.key)).toEqual([dtpAgeTimer(GI1)]);
    expect(d.stateSnapshot().state).toEqual({ speaking: [], sent: 2, received: 2 });
  });

  it('a message from an access neighbour is consumed and recorded but never answered (two access ports would answer each other forever)', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.lines(d, GI1, ['switchport mode access']);
    const rx = d.onPdu(h.ctx, message(h, 'access'), GI1);
    expect(consumesOf(rx)).toBe(1);
    expect(sendsOf(rx)).toEqual([]);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'access', oper: 'access', status: 'static', neighbor: NEIGHBOUR_MAC, neighborMode: 'access', updatedAt: 0 });
    expect(timersOf(rx).map((t) => t.key)).toEqual([dtpAgeTimer(GI1)]);
    expect(l2ChangedOf(rx)).toEqual([]);
    expect(transitions(d)).toEqual([]);
    expect(d.stateSnapshot().state).toEqual({ speaking: [], sent: 0, received: 1 });
    // a neighbour that can still change its mind is answered as before
    const auto = d.onPdu(h.ctx, message(h, 'dynamic-auto'), GI1);
    expect(sendsOf(auto)).toHaveLength(1);
    expect(dtpOf(sendsOf(auto)[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_ACCESS, operTrunk: false });
    expect(d.stateSnapshot().state).toEqual({ speaking: [], sent: 1, received: 2 });
  });

  it('a negotiated trunk whose port becomes access sends one message at once, cancels its timer and drops back', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.lines(d, GI1, ['switchport mode dynamic desirable']);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI1);
    expect(rowOf(h, GI1)).toMatchObject({ oper: 'trunk' });
    h.setNow(10 * SEC);
    const actions = h.lines(d, GI1, ['switchport mode access']);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'access', oper: 'access', status: 'static', neighbor: NEIGHBOUR_MAC, neighborMode: 'dynamic-auto', updatedAt: 10 * SEC });
    const out = sendsOf(actions);
    expect(out).toHaveLength(1);
    expect(dtpOf(out[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_ACCESS, operTrunk: false });
    expect(cancelsOf(actions)).toEqual([dtpHelloTimer(GI1)]);
    expect(timersOf(actions)).toEqual([]);
    expect(l2ChangedOf(actions)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ from: 'trunk', to: 'access', cause: 'switchport mode access' });
    // becoming access with nothing heard: no row, no message
    expect(h.lines(d, GI2, ['switchport mode access'])).toEqual([]);
    expect(rowOf(h, GI2)).toBeUndefined();
  });

  it('a mode change with a known neighbour announces the new mode once; auto keeps speaking only facing a speaker', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.lines(d, GI1, ['switchport mode dynamic desirable']);
    d.onPdu(h.ctx, message(h, 'dynamic-desirable', true), GI1);
    // desirable → auto facing a desirable neighbour: still trunk, one message, timer kept
    const toAuto = h.lines(d, GI1, ['switchport mode dynamic auto']);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'trunk', status: 'negotiated', neighborMode: 'dynamic-desirable' });
    expect(sendsOf(toAuto)).toHaveLength(1);
    expect(dtpOf(sendsOf(toAuto)[0]!.pdu)).toMatchObject({ adminMode: DTP_MODE_AUTO, operTrunk: true });
    expect(timersOf(toAuto).map((t) => t.key)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(toAuto)).toEqual([]);
    // the neighbour turns auto as well: both access, this side falls silent
    const rx = d.onPdu(h.ctx, message(h, 'dynamic-auto'), GI1);
    expect(rowOf(h, GI1)).toMatchObject({ oper: 'access', neighborMode: 'dynamic-auto' });
    expect(sendsOf(rx)).toEqual([]);
    expect(cancelsOf(rx)).toEqual([dtpHelloTimer(GI1)]);
    // auto → trunk with an auto neighbour: static trunk, speaks again
    const toTrunk = h.lines(d, GI1, ['switchport mode trunk']);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', status: 'static', neighbor: NEIGHBOUR_MAC });
    expect(sendsOf(toTrunk)).toHaveLength(1);
    expect(timersOf(toTrunk).map((t) => t.key)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(toTrunk)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
  });
});

describe('nonegotiate (§3.3 rule 1)', () => {
  it('`switchport nonegotiate` on a trunk: the row goes, the timer stops, nothing is sent, received messages are dropped without a word', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.lines(d, GI1, ['switchport mode trunk']);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI1);
    const debugBefore = h.debug.length;
    const actions = h.lines(d, GI1, ['switchport nonegotiate']);
    expect(rowOf(h, GI1)).toBeUndefined();
    expect(h.kinds('tableExpire')).toEqual([expect.objectContaining({ table: 'dtp', key: GI1, reason: 'cleared' })]);
    expect(sendsOf(actions)).toEqual([]);
    expect(cancelsOf(actions).sort()).toEqual([dtpAgeTimer(GI1), dtpHelloTimer(GI1)].sort());
    expect(l2ChangedOf(actions)).toEqual([]); // a static trunk is still a trunk (operOf reads the config)
    expect(operOf(readSwitchport(h.config, GI1), rowOf(h, GI1))).toBe('trunk');
    const pdu = message(h, 'dynamic-desirable');
    const rx = d.onPdu(h.ctx, pdu, GI1);
    expect(rx).toEqual([{ type: 'drop', pdu, reason: 'not-for-me', detail: dtpNotNegotiatingDetail(GI1), port: GI1 }]);
    expect(rowOf(h, GI1)).toBeUndefined();
    expect(h.debug.slice(debugBefore).filter((e) => e.category === DTP_DEBUG_CATEGORY)).toEqual([]);
    expect(d.stateSnapshot().state).toMatchObject({ speaking: [] });
    // `no switchport nonegotiate` brings negotiation back at once
    const on = h.lines(d, GI1, ['no switchport nonegotiate']);
    expect(rowOf(h, GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', status: 'static' });
    expect(sendsOf(on)).toHaveLength(1);
  });

  it('an access port with nonegotiate ignores messages and keeps no row', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    expect(h.lines(d, GI1, ['switchport mode access', 'switchport nonegotiate'])).toEqual([]);
    const rx = d.onPdu(h.ctx, message(h, 'trunk', true), GI1);
    expect(dropsOf(rx)).toEqual([expect.objectContaining({ reason: 'not-for-me', detail: dtpNotNegotiatingDetail(GI1) })]);
    expect(rowOf(h, GI1)).toBeUndefined();
    expect(h.kinds('tableWrite')).toEqual([]);
  });

  it('a frame that is not a trunk negotiation message is dropped unsupported-protocol', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    const pdu = h.frame('00:1f:00:00:00:0a', 'ff:ff:ff:ff:ff:ff');
    expect(d.onPdu(h.ctx, pdu, GI1)).toEqual([expect.objectContaining({ type: 'drop', pdu, reason: 'unsupported-protocol' })]);
    expect(rowOf(h, GI1)).toBeUndefined();
  });
});

describe('ageing and link changes (§3.3 rule 4)', () => {
  it('ageing: an auto trunk returns to access (waiting) and falls silent; a trunk forgets its neighbour; an access row is deleted', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    d.onPdu(h.ctx, message(h, 'dynamic-desirable'), GI1);
    h.lines(d, GI2, ['switchport mode trunk']);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI2);
    h.lines(d, 'FastEthernet0/1', ['switchport mode access']);
    d.onPdu(h.ctx, message(h, 'trunk', true), 'FastEthernet0/1');
    h.setNow(300 * SEC);
    const aged = d.onTimer(h.ctx, dtpAgeTimer(GI1));
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'dynamic-auto', oper: 'access', status: 'waiting', updatedAt: 300 * SEC });
    expect(cancelsOf(aged)).toEqual([dtpHelloTimer(GI1)]);
    expect(l2ChangedOf(aged)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI1 }]);
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ from: 'trunk', to: 'access', cause: DTP_CAUSE_AGED });
    expect(timersOf(aged)).toEqual([]);
    const trunkAged = d.onTimer(h.ctx, dtpAgeTimer(GI2));
    expect(rowOf(h, GI2)).toEqual({ key: GI2, port: GI2, admin: 'trunk', oper: 'trunk', status: 'static', updatedAt: 300 * SEC });
    expect(trunkAged).toEqual([]);
    expect(d.stateSnapshot().state).toMatchObject({ speaking: [GI2] });
    const accessAged = d.onTimer(h.ctx, dtpAgeTimer('FastEthernet0/1'));
    expect(rowOf(h, 'FastEthernet0/1')).toBeUndefined();
    expect(h.kinds('tableExpire').at(-1)).toMatchObject({ table: 'dtp', key: 'FastEthernet0/1', reason: 'aged' });
    expect(accessAged).toEqual([]);
    // a stray age tick with no row is a no-op
    expect(d.onTimer(h.ctx, dtpAgeTimer('FastEthernet0/2'))).toEqual([]);
  });

  it('link down: a trunk row back to static, a desirable row to waiting (oper access), an auto row deleted; timers cancelled', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.lines(d, GI1, ['switchport mode trunk']);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI1);
    h.lines(d, GI2, ['switchport mode dynamic desirable']);
    d.onPdu(h.ctx, message(h, 'trunk', true), GI2);
    d.onPdu(h.ctx, message(h, 'dynamic-desirable', true), 'FastEthernet0/1');
    h.setNow(50 * SEC);
    h.setOper(GI1, false);
    const t = d.onLinkChange!(h.ctx, GI1, false);
    expect(rowOf(h, GI1)).toEqual({ key: GI1, port: GI1, admin: 'trunk', oper: 'trunk', status: 'static', updatedAt: 50 * SEC });
    expect(cancelsOf(t).sort()).toEqual([dtpAgeTimer(GI1), dtpHelloTimer(GI1)].sort());
    expect(l2ChangedOf(t)).toEqual([]);
    h.setOper(GI2, false);
    const dsr = d.onLinkChange!(h.ctx, GI2, false);
    expect(rowOf(h, GI2)).toEqual({ key: GI2, port: GI2, admin: 'dynamic-desirable', oper: 'access', status: 'waiting', updatedAt: 50 * SEC });
    expect(l2ChangedOf(dsr)).toEqual([{ type: 'l2Changed', what: 'trunk', port: GI2 }]);
    expect(transitions(d).at(-1)!.fsm).toMatchObject({ port: GI2, from: 'trunk', to: 'access', cause: DTP_CAUSE_LINK_DOWN });
    h.setOper('FastEthernet0/1', false);
    const auto = d.onLinkChange!(h.ctx, 'FastEthernet0/1', false);
    expect(rowOf(h, 'FastEthernet0/1')).toBeUndefined();
    expect(h.kinds('tableExpire').at(-1)).toMatchObject({ table: 'dtp', key: 'FastEthernet0/1', reason: 'link-down' });
    expect(l2ChangedOf(auto)).toEqual([{ type: 'l2Changed', what: 'trunk', port: 'FastEthernet0/1' }]);
    expect(d.stateSnapshot().state).toMatchObject({ speaking: [] });
    // the hello timer of a port that went down no longer sends
    expect(d.onTimer(h.ctx, dtpHelloTimer(GI1))).toEqual([]);
    // link up again: the desirable port speaks again from its waiting row
    h.setOper(GI2, true);
    const up = d.onLinkChange!(h.ctx, GI2, true);
    expect(sendsOf(up)).toHaveLength(1);
    expect(timersOf(up).map((x) => x.key)).toEqual([dtpHelloTimer(GI2)]);
    expect(h.kinds('tableWrite').filter((e) => e.key === GI2)).toHaveLength(3); // waiting, negotiated, waiting — link-up rewrote nothing
  });

  it('a Port-channel port never negotiates itself (DTP runs on the members, §3.3 rule 5)', () => {
    const h = p2SwitchHarness();
    const d = createDtp();
    h.addPort('Port-channel1', 9, { kind: 'virtual', role: 'channel' });
    expect(h.lines(d, 'Port-channel1', ['switchport mode dynamic desirable'])).toEqual([]);
    expect(rowOf(h, 'Port-channel1')).toBeUndefined();
    expect(d.onLinkChange!(h.ctx, 'Port-channel1', true)).toEqual([]);
    const pdu = message(h, 'trunk', true);
    expect(d.onPdu(h.ctx, pdu, 'Port-channel1')).toEqual([{ type: 'drop', pdu, reason: 'not-for-me', detail: dtpNotNegotiatingDetail('Port-channel1'), port: 'Port-channel1' }]);
    // the members negotiate on their own
    expect(sendsOf(h.lines(d, GI1, ['switchport mode dynamic desirable']))).toHaveLength(1);
    expect(sendsOf(h.lines(d, GI2, ['switchport mode dynamic desirable']))).toHaveLength(1);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI1);
    d.onPdu(h.ctx, message(h, 'dynamic-auto', true), GI2);
    const members = [rowOf(h, GI1), rowOf(h, GI2)];
    expect(members.map((r) => r?.oper)).toEqual(['trunk', 'trunk']);
    expect(channelOperOf(readSwitchport(h.config, 'Port-channel1'), members)).toBe('trunk');
    d.onPdu(h.ctx, message(h, 'access'), GI2);
    expect(channelOperOf(readSwitchport(h.config, 'Port-channel1'), [rowOf(h, GI1), rowOf(h, GI2)])).toBe('access');
  });
});

// ─────────────────────────────── real worlds (test/p2.world.ts) ───────────────────────────────

const FACTORIES = { vlan: createVlan, dtp: createDtp };
const SW1 = 'sw1';
const SW2 = 'sw2';
/** Both switches boot in 30 s; the cable comes up right after. */
const SETTLE = 40 * SEC;

/** The startup lines of Gi0/1 for a matrix column. */
function linesFor(kind: string, port = GI1): string[] {
  switch (kind) {
    case 'access':
      return [`interface ${port}`, ' switchport mode access'];
    case 'trunk':
      return [`interface ${port}`, ' switchport mode trunk'];
    case 'desirable':
      return [`interface ${port}`, ' switchport mode dynamic desirable'];
    case 'auto':
      return [];
    case 'nonegotiate':
      return [`interface ${port}`, ' switchport mode trunk', ' switchport nonegotiate'];
    default:
      throw new Error(kind);
  }
}

interface World {
  sim: Simulation;
  /** Events since the last `since()` call. */
  since(): TraceEvent[];
}

/** Two P2-stage NF-C2960 (SW1, SW2) joined Gi0/1 ↔ Gi0/1 (and Gi0/2 ↔ Gi0/2 when `twoLinks`), booted and settled. */
function twoSwitches(a: readonly string[], b: readonly string[], opts: { profile?: 'P1' | 'P2'; twoLinks?: boolean; seed?: number } = {}): World {
  const sim = createP2Simulation({ seed: opts.seed ?? 11, factories: FACTORIES, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
  sim.addDevice({ id: SW1, type: 'switch.nfc2960', name: 'SW1', startupConfig: [...a, ''].join('\n') });
  sim.addDevice({ id: SW2, type: 'switch.nfc2960', name: 'SW2', startupConfig: [...b, ''].join('\n') });
  sim.addLink({ a: { device: SW1, port: GI1 }, b: { device: SW2, port: GI1 } });
  if (opts.twoLinks === true) sim.addLink({ a: { device: SW1, port: GI2 }, b: { device: SW2, port: GI2 } });
  let cursor = 0;
  return {
    sim,
    since() {
      const r = sim.trace(cursor);
      cursor = r.next;
      return r.events;
    },
  };
}

const rowIn = (sim: Simulation, device: string, port: PortId): DtpRow | undefined => sim.device(device)!.tables.get<DtpRow>('dtp')!.get(port);
const operIn = (sim: Simulation, device: string, port: PortId) => operOf(readSwitchport(sim.device(device)!.running, port), rowIn(sim, device, port));
const dtpCreated = (evs: readonly TraceEvent[], device?: string) => ofKind(evs, 'pduCreated').filter((e) => e.pdu.tag === DTP_TAG && (device === undefined || e.device === device));
const dtpDebug = (evs: readonly TraceEvent[]) => ofKind(evs, 'debug').filter((e) => e.event.process === DTP_PROCESS);

describe('real worlds: silence', () => {
  it.each(['P1', 'P2'] as const)('two untouched switches in the %s profile: no message, no row, no dtp debug line in 120 s', (profile) => {
    const w = twoSwitches([], [], { profile });
    w.sim.runFor(120 * SEC);
    const evs = w.since();
    expect(dtpCreated(evs)).toEqual([]);
    expect(dtpDebug(evs)).toEqual([]);
    expect(ofKind(evs, 'tableWrite').filter((e) => e.table === 'dtp')).toEqual([]);
    for (const d of [SW1, SW2]) {
      expect(w.sim.device(d)!.tables.get<DtpRow>('dtp')!.size).toBe(0);
      expect(w.sim.device(d)!.stateSnapshots().find((s) => s.process === DTP_PROCESS)).toEqual({ process: 'dtp', state: { speaking: [], sent: 0, received: 0 } });
      expect(operIn(w.sim, d, GI1)).toBe('access');
    }
  });
});

describe('real worlds: the 5×5 matrix (§3.3, accept.p2.dtp)', () => {
  const KINDS = ['access', 'trunk', 'desirable', 'auto', 'nonegotiate'] as const;
  for (const mine of KINDS) {
    for (const theirs of KINDS) {
      it(`SW1 ${mine} ↔ SW2 ${theirs}: SW1 ${MATRIX[mine]![theirs]}, SW2 ${MATRIX[theirs]![mine]}, settled within 1 s of link-up`, () => {
        const w = twoSwitches(linesFor(mine), linesFor(theirs));
        w.sim.runFor(SETTLE);
        const evs = w.since();
        expect(operIn(w.sim, SW1, GI1)).toBe(MATRIX[mine]![theirs]);
        expect(operIn(w.sim, SW2, GI1)).toBe(MATRIX[theirs]![mine]);
        const speaks = (k: string) => k === 'trunk' || k === 'desirable';
        const messages = dtpCreated(evs);
        if (!speaks(mine) && !speaks(theirs)) expect(messages).toEqual([]);
        else expect(messages.length).toBeGreaterThan(0);
        // rows: initiators from link-up; auto and access only after a message; nonegotiate never
        const expectRow = (kind: string, other: string, device: string) => {
          const row = rowIn(w.sim, device, GI1);
          if (kind === 'nonegotiate' || ((kind === 'auto' || kind === 'access') && !speaks(other))) expect(row, `${device} ${kind}`).toBeUndefined();
          else expect(row, `${device} ${kind}`).toMatchObject({ admin: MODE_OF[kind], oper: MATRIX[kind]![other] });
        };
        expectRow(mine, theirs, SW1);
        expectRow(theirs, mine, SW2);
        // every transition happened within 1 s of the cable coming up (one frame exchange, propagation only)
        const linkUp = ofKind(evs, 'linkState').find((e) => e.up)!.t;
        for (const e of dtpDebug(evs).filter((e) => e.event.fsm !== undefined)) {
          expect(e.t).toBeGreaterThanOrEqual(linkUp);
          expect(e.t).toBeLessThanOrEqual(linkUp + 1 * SEC);
        }
        // and the world keeps its state afterwards (no flapping): same oper 60 s later
        w.sim.runFor(60 * SEC);
        expect(operIn(w.sim, SW1, GI1)).toBe(MATRIX[mine]![theirs]);
        expect(operIn(w.sim, SW2, GI1)).toBe(MATRIX[theirs]![mine]);
        expect(dtpDebug(w.since()).filter((e) => e.event.fsm !== undefined)).toEqual([]);
      });
    }
  }

  it('desirable ↔ auto: the messages are what the rules say (SW1 every 30 s, SW2 answers the first one then every 30 s), background, never bridged', () => {
    const w = twoSwitches(linesFor('desirable'), linesFor('auto'));
    w.sim.runFor(SETTLE + 65 * SEC);
    const evs = w.since();
    const sw1 = dtpCreated(evs, SW1);
    const sw2 = dtpCreated(evs, SW2);
    expect(sw1.length).toBe(3); // link-up, +30 s, +60 s
    expect(sw2.length).toBe(3); // the answer, then its own 30 s ticks
    expect(sw1[1]!.t - sw1[0]!.t).toBe(DTP_HELLO_NS);
    expect(sw2[0]!.t - sw1[0]!.t).toBeLessThan(1 * SEC);
    expect(sw2[0]!.pdu.tag).toBe('dtp');
    for (const tx of ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === DTP_TAG)) expect(tx.background).toBe(true);
    // consumed by the far end, never bridged out another port, never dropped
    expect(ofKind(evs, 'pduConsumed').filter((e) => e.pdu.tag === DTP_TAG).length).toBe(6);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.tag === DTP_TAG)).toEqual([]);
    expect(rowIn(w.sim, SW1, GI1)).toMatchObject({ admin: 'dynamic-desirable', oper: 'trunk', status: 'negotiated', neighborMode: 'dynamic-auto', neighbor: w.sim.device(SW2)!.port(GI1)!.mac });
    expect(rowIn(w.sim, SW2, GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'trunk', status: 'negotiated', neighborMode: 'dynamic-desirable', neighbor: w.sim.device(SW1)!.port(GI1)!.mac });
    // `runToIdle` never waits for the periodic timers
    const idle = w.sim.runToIdle();
    expect(idle.events).toBeLessThan(50);
  });

  it('the feature is not gated by the profile: desirable ↔ auto negotiates a trunk in a P1 world too', () => {
    const w = twoSwitches(linesFor('desirable'), linesFor('auto'), { profile: 'P1' });
    w.sim.runFor(SETTLE);
    expect(operIn(w.sim, SW1, GI1)).toBe('trunk');
    expect(operIn(w.sim, SW2, GI1)).toBe('trunk');
  });

  it('is deterministic: two runs with one seed give the same rows and the same message times', () => {
    const run = () => {
      const w = twoSwitches(linesFor('desirable'), linesFor('auto'), { seed: 3 });
      w.sim.runFor(SETTLE + 100 * SEC);
      const evs = w.since();
      return JSON.stringify({ msgs: dtpCreated(evs).map((e) => [e.t, e.device, e.pdu.id]), rows: [rowIn(w.sim, SW1, GI1), rowIn(w.sim, SW2, GI1)] });
    };
    expect(run()).toBe(run());
  });
});

describe('real worlds: reconfiguration and ageing', () => {
  it('a negotiated trunk whose peer becomes access: one message from the access port, the dynamic port is access within propagation + 1 s', () => {
    const w = twoSwitches(linesFor('desirable'), linesFor('auto'));
    w.sim.runFor(SETTLE);
    expect(operIn(w.sim, SW2, GI1)).toBe('trunk');
    w.since();
    expect(w.sim.configure(SW1, [`interface ${GI1}`, 'switchport mode access'])).toMatchObject({ ok: true });
    const at = w.sim.now;
    w.sim.runFor(1 * SEC);
    const evs = w.since();
    expect(dtpCreated(evs, SW1)).toHaveLength(1);
    expect(dtpCreated(evs, SW1)[0]!.t).toBe(at);
    expect(operIn(w.sim, SW2, GI1)).toBe('access');
    expect(rowIn(w.sim, SW2, GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'access', status: 'negotiated', neighborMode: 'access' });
    expect(rowIn(w.sim, SW1, GI1)).toMatchObject({ admin: 'access', oper: 'access', status: 'static', neighborMode: 'dynamic-auto' });
    const back = dtpDebug(evs).filter((e) => e.event.fsm !== undefined && e.event.device === SW2);
    expect(back).toHaveLength(1);
    expect(back[0]!.event.fsm).toMatchObject({ machine: 'dtp', subject: GI1, from: 'trunk', to: 'access' });
    expect(back[0]!.t - at).toBeLessThan(1 * SEC);
    // both ends are silent from now on
    w.sim.runFor(120 * SEC);
    expect(dtpCreated(w.since())).toEqual([]);
    expect(w.sim.device(SW2)!.stateSnapshots().find((s) => s.process === DTP_PROCESS)!.state).toMatchObject({ speaking: [] });
  });

  it('a static trunk facing an access port turns access: its one message is not answered, and both access ports stay silent (no answer loop)', () => {
    const w = twoSwitches(linesFor('trunk'), linesFor('access'));
    w.sim.runFor(SETTLE);
    // SW2's access port heard SW1's trunk messages (and answered them): both ends have a row
    expect(rowIn(w.sim, SW2, GI1)).toMatchObject({ admin: 'access', oper: 'access', status: 'static', neighborMode: 'trunk' });
    expect(rowIn(w.sim, SW1, GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', neighborMode: 'access' });
    w.since();
    expect(w.sim.configure(SW1, [`interface ${GI1}`, 'switchport mode access'])).toMatchObject({ ok: true });
    const at = w.sim.now;
    // capped: an answer loop would exhaust the budget within a few milliseconds of sim time
    const run = w.sim.runUntil(at + 1 * SEC, { maxEvents: 10_000 });
    expect(run.stopped).toBeUndefined();
    expect(w.sim.now).toBe(at + 1 * SEC);
    const evs = w.since();
    // SW1's one message (§3.3 rule 1b); SW2's access port records it and does not answer an access neighbour
    expect(dtpCreated(evs).map((e) => [e.device, e.t])).toEqual([[SW1, at]]);
    expect(rowIn(w.sim, SW1, GI1)).toMatchObject({ admin: 'access', oper: 'access', status: 'static', neighborMode: 'access' });
    expect(rowIn(w.sim, SW2, GI1)).toMatchObject({ admin: 'access', oper: 'access', status: 'static', neighborMode: 'access' });
    // and nothing more is ever sent on that link
    w.sim.runFor(120 * SEC);
    expect(dtpCreated(w.since())).toEqual([]);
  });

  it('a neighbour that goes nonegotiate falls silent: the auto port keeps its trunk for 300 s after its last message, then returns to access', () => {
    const w = twoSwitches(linesFor('trunk'), linesFor('auto'));
    w.sim.runFor(SETTLE);
    expect(operIn(w.sim, SW2, GI1)).toBe('trunk');
    const last = dtpCreated(w.since(), SW1).at(-1)!.t; // SW1's last message before the line
    expect(w.sim.configure(SW1, [`interface ${GI1}`, 'switchport nonegotiate'])).toMatchObject({ ok: true });
    const at = w.sim.now;
    expect(at - last).toBeLessThanOrEqual(DTP_HELLO_NS);
    expect(rowIn(w.sim, SW1, GI1)).toBeUndefined();
    expect(operIn(w.sim, SW1, GI1)).toBe('trunk'); // a nonegotiate trunk is still a trunk
    // SW1 sends nothing more; SW2's messages are ignored by SW1 (dropped not-for-me, background)
    w.sim.runUntil(last + DTP_AGE_NS - 1 * SEC);
    let evs = w.since();
    expect(dtpCreated(evs, SW1)).toEqual([]);
    expect(dtpCreated(evs, SW2).length).toBeGreaterThan(5);
    const ignored = ofKind(evs, 'drop').filter((e) => e.pdu.tag === DTP_TAG);
    expect(ignored.length).toBe(dtpCreated(evs, SW2).length);
    for (const d of ignored) expect(d).toMatchObject({ device: SW1, reason: 'not-for-me', detail: dtpNotNegotiatingDetail(GI1), background: true });
    expect(operIn(w.sim, SW2, GI1)).toBe('trunk');
    // the neighbour is forgotten exactly 300 s after its last message
    w.sim.runUntil(last + DTP_AGE_NS + 1 * SEC);
    evs = w.since();
    expect(operIn(w.sim, SW2, GI1)).toBe('access');
    expect(rowIn(w.sim, SW2, GI1)).toMatchObject({ admin: 'dynamic-auto', oper: 'access', status: 'waiting' });
    const aged = dtpDebug(evs).filter((e) => e.event.fsm !== undefined);
    expect(aged).toHaveLength(1);
    expect(aged[0]!.event.fsm).toMatchObject({ from: 'trunk', to: 'access', cause: DTP_CAUSE_AGED });
    expect(aged[0]!.t).toBeGreaterThan(last + DTP_AGE_NS);
    expect(aged[0]!.t).toBeLessThan(last + DTP_AGE_NS + 1 * SEC);
    // and SW2 has fallen silent
    w.sim.runFor(90 * SEC);
    expect(dtpCreated(w.since())).toEqual([]);
  });

  it('a cut cable: the desirable row waits, the auto row goes; reconnecting negotiates the trunk again', () => {
    const w = twoSwitches(linesFor('desirable'), linesFor('auto'));
    w.sim.runFor(SETTLE);
    const link = ofKind(w.since(), 'linkState')[0]!.link;
    w.sim.removeLink(link);
    w.sim.runFor(1 * SEC);
    expect(rowIn(w.sim, SW1, GI1)).toMatchObject({ admin: 'dynamic-desirable', oper: 'access', status: 'waiting' });
    expect(rowIn(w.sim, SW2, GI1)).toBeUndefined();
    const down = dtpDebug(w.since()).filter((e) => e.event.fsm !== undefined);
    expect(down.map((e) => [e.event.device, e.event.fsm!.to, e.event.fsm!.cause]).sort()).toEqual([[SW1, 'access', DTP_CAUSE_LINK_DOWN], [SW2, 'access', DTP_CAUSE_LINK_DOWN]]);
    w.sim.runFor(60 * SEC);
    expect(dtpCreated(w.since())).toEqual([]);
    w.sim.addLink({ a: { device: SW1, port: GI1 }, b: { device: SW2, port: GI1 } });
    w.sim.runFor(5 * SEC);
    expect(operIn(w.sim, SW1, GI1)).toBe('trunk');
    expect(operIn(w.sim, SW2, GI1)).toBe('trunk');
  });
});

describe('real worlds: Port-channel members in dynamic modes (§3.3 rule 5)', () => {
  it('two desirable members facing two auto members negotiate trunk on every member; the bundle mode follows; a member whose peer turns access differs', () => {
    const w = twoSwitches([...linesFor('desirable', GI1), ...linesFor('desirable', GI2)], [], { twoLinks: true });
    w.sim.runFor(SETTLE);
    for (const d of [SW1, SW2]) for (const p of [GI1, GI2]) expect(operIn(w.sim, d, p), `${d} ${p}`).toBe('trunk');
    const bundleConfig = readSwitchport(w.sim.device(SW1)!.running, 'Port-channel1'); // no section: dynamic auto, so the members decide
    expect(channelOperOf(bundleConfig, [rowIn(w.sim, SW1, GI1), rowIn(w.sim, SW1, GI2)])).toBe('trunk');
    expect(channelOperOf(bundleConfig, [rowIn(w.sim, SW2, GI1), rowIn(w.sim, SW2, GI2)])).toBe('trunk');
    // SW2 Gi0/2 becomes access: SW1 Gi0/2 drops to access at once, Gi0/1 stays trunk — the members disagree
    expect(w.sim.configure(SW2, [`interface ${GI2}`, 'switchport mode access'])).toMatchObject({ ok: true });
    w.sim.runFor(1 * SEC);
    expect(operIn(w.sim, SW1, GI1)).toBe('trunk');
    expect(operIn(w.sim, SW1, GI2)).toBe('access');
    expect(rowIn(w.sim, SW1, GI2)).toMatchObject({ admin: 'dynamic-desirable', oper: 'access', status: 'negotiated', neighborMode: 'access' });
    expect(channelOperOf(bundleConfig, [rowIn(w.sim, SW1, GI1), rowIn(w.sim, SW1, GI2)])).toBe('access');
    expect(channelOperOf(bundleConfig, [rowIn(w.sim, SW1, GI1)])).toBe('trunk');
  });
});
