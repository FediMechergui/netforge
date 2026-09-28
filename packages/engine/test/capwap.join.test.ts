/**
 * W5 wireless (ARCHITECTURE-P2 §3.12 steps 1–5, §2.3, §2.6, §4.1–§4.3, §7 W5): a lightweight AP joins a controller.
 *
 * Real worlds on `p2.world` (§0 rule 13) with its TEST-ONLY wireless models and the two W5 factories
 * (test/capwap.harness.ts). Asserted:
 *   • the RFC 5415 state order discovery → dtls → join → configure → data-check → run on the AP (`capwap-wtp`
 *     transitions and `capwap` rows) and dtls → join → configure → data-check → run on the controller (`capwap-ac`,
 *     `capwap-aps` rows), with the RFC message types in order on UDP 5246, and the tunnel sockets on 5247;
 *   • `meta.protected` on every control message after the simulated DTLS step and on none before it; echoes are
 *     background;
 *   • the WLAN push: key tag, never the passphrase; the radios serve it centrally through the ONE settings renderer;
 *   • the AP learns its address by DHCP (the P2 profile default) and discovers in the instant of the lease (the
 *     `dhcp.lease` event, W5 fix), so a DHCP-addressed AP also joins while a world runs to idle — as the grader's
 *     settled copy does; `capwap controller` lines turn broadcast discovery into unicast discovery;
 *   • retransmission and fall-back: a join that goes unanswered is sent 3 times, then the AP rediscovers; three missed
 *     echoes send a running AP back to discovery and clear its radio profiles; a silent AP ages out of the controller;
 *   • discovery follows its targets: a `capwap controller` line typed during broadcast discovery ends the broadcast
 *     lane and starts the controller's; without a management address discovery stops, and it starts again with one;
 *   • silence: no `capwap enable` (a P1 world, even with a static address) → no CAPWAP at all; a controller without
 *     a management interface opens no socket; an unanswered AP never holds runToIdle;
 *   • the same seed gives the same trace;
 *   • W6 (§9.2 item 22b) the AP identity: the Discovery and Join Requests carry the AP's base MAC (`wtpMac`, NF vendor
 *     element 3), the controller keys its sessions and `capwap-aps` rows by it — two APs behind one router both join
 *     and stay in run; a rebooted AP replaces its own session; a newcomer at a joined AP's address takes the endpoint
 *     over; a Join Request without the element is refused — and the element's wire form is pinned byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { CAPWAP_MSG } from '../src/contracts/pdu.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { CapwapApRow, CapwapRow, SocketRow, WlanClientRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { passphraseTag } from '../src/link/rewrap80211.js';
import { CAPWAP_DTLS_CAUSE, capwapText, formatCapwapWlan, formatCapwapWlanRemoval, formatCapwapStationReport, parseCapwapWlan, parseCapwapStationReports } from '../src/protocols/capwap-wtp.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { capwapCodec } from '../src/pdu/codecs/capwap.js';
import {
  AP_ADDR,
  AP_GW,
  LAPTOP_ADDR,
  M24,
  PASSPHRASE,
  SETTLE,
  SSID,
  WLC_MGMT,
  GW20,
  capwapFactories,
  capwapWorld,
  controlMessages,
  macOf,
  ofKind,
  r1Config,
  wlcConfig,
} from './capwap.harness.js';
import { createP2Simulation } from './p2.world.js';

const events = (sim: { trace(c: number): { events: TraceEvent[] } }): TraceEvent[] => sim.trace(0).events;

/** The transitions of one machine on one device, in trace order. */
function transitions(evs: readonly TraceEvent[], device: string, machine: 'capwap-wtp' | 'capwap-ac') {
  return ofKind(evs, 'debug')
    .filter((e) => e.event.device === device && e.event.fsm?.machine === machine)
    .map((e) => ({ t: e.t, subject: e.event.fsm!.subject, from: e.event.fsm!.from, to: e.event.fsm!.to, cause: e.event.fsm!.cause }));
}

/** The state sequence written to one table of one device (tableWrite rows, in order). */
function rowStates(evs: readonly TraceEvent[], device: string, table: 'capwap' | 'capwap-aps'): string[] {
  return ofKind(evs, 'tableWrite')
    .filter((e) => e.device === device && e.table === table)
    .map((e) => (e.row as unknown as CapwapRow | CapwapApRow).state);
}

/** Deduplicate consecutive equal entries (a row rewritten with a new WLAN count keeps its state). */
function runs<T>(xs: readonly T[]): T[] {
  return xs.filter((x, i) => i === 0 || xs[i - 1] !== x);
}

describe('W5 wireless — a lightweight AP joins its controller (§3.12 steps 1–4)', () => {
  it('walks discovery → dtls → join → configure → data-check → run in RFC 5415 order, with rows on both sides', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE);
    const evs = events(sim);
    const apMac = macOf(sim, 'lap1', 'Vlan1');

    // the AP side: broadcast discovery on the management subnet, then the controller's own subject
    const wtp = transitions(evs, 'lap1', 'capwap-wtp');
    expect(wtp.filter((t) => t.to !== 'idle').map((t) => t.to)).toEqual(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);
    expect(wtp[0]).toMatchObject({ subject: 'controller 192.168.99.255', from: 'idle', to: 'discovery' });
    const toController = wtp.filter((t) => t.subject === `controller ${WLC_MGMT}`);
    expect(toController.map((t) => [t.from, t.to])).toEqual([
      ['discovery', 'dtls'],
      ['dtls', 'join'],
      ['join', 'configure'],
      ['configure', 'data-check'],
      ['data-check', 'run'],
    ]);
    expect(toController[0]!.cause).toBe(CAPWAP_DTLS_CAUSE);
    // the DTLS step is a state with no records on the wire: dtls and join are entered in the same instant
    expect(toController[1]!.t).toBe(toController[0]!.t);
    expect(runs(rowStates(evs, 'lap1', 'capwap'))).toEqual(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.rows()).toEqual([
      expect.objectContaining({ key: WLC_MGMT, controller: WLC_MGMT, state: 'run', wlans: 1 }),
    ]);

    // the controller side, keyed by the AP's MAC (the WTP MAC of its requests: its base MAC, which its Vlan1 carries)
    const ac = transitions(evs, 'wlc1', 'capwap-ac');
    expect(ac.map((t) => [t.subject, t.from, t.to])).toEqual([
      [`access point ${apMac}`, 'idle', 'dtls'],
      [`access point ${apMac}`, 'dtls', 'join'],
      [`access point ${apMac}`, 'join', 'configure'],
      [`access point ${apMac}`, 'configure', 'data-check'],
      [`access point ${apMac}`, 'data-check', 'run'],
    ]);
    expect(ac[0]!.cause).toBe(CAPWAP_DTLS_CAUSE);
    expect(runs(rowStates(evs, 'wlc1', 'capwap-aps'))).toEqual(['dtls', 'join', 'configure', 'data-check', 'run']);
    expect(sim.device('wlc1')!.tables.get<CapwapApRow>('capwap-aps')!.rows()).toEqual([
      { key: apMac, apMac, apIp: AP_ADDR, name: 'LAP1', state: 'run', clients: 0, updatedAt: expect.any(Number) },
    ]);

    // the RFC 5415 / 5416 message types, in order, each from the side that sends it
    const msgs = controlMessages(sim, evs).filter((m) => m.type !== CAPWAP_MSG.echoReq && m.type !== CAPWAP_MSG.echoResp);
    expect(msgs.map((m) => [m.device, m.type])).toEqual([
      ['lap1', CAPWAP_MSG.discoveryReq],
      ['wlc1', CAPWAP_MSG.discoveryResp],
      ['lap1', CAPWAP_MSG.joinReq],
      ['wlc1', CAPWAP_MSG.joinResp],
      ['lap1', CAPWAP_MSG.configStatusReq],
      ['wlc1', CAPWAP_MSG.configStatusResp],
      ['lap1', CAPWAP_MSG.changeStateReq],
      ['wlc1', CAPWAP_MSG.changeStateResp],
      ['wlc1', CAPWAP_MSG.wlanConfigReq],
      ['lap1', CAPWAP_MSG.wlanConfigResp],
    ]);
    for (const m of msgs) {
      const udp = sim.pdu(m.id)!.layer('udp')!.fields;
      expect([udp.srcPort, udp.dstPort]).toEqual([5246, 5246]);
    }
    // requests and responses share their sequence number; the responses report success
    const join = sim.pdu(msgs[2]!.id)!;
    const joinResp = sim.pdu(msgs[3]!.id)!;
    expect(joinResp.get('capwap.seq')).toBe(join.get('capwap.seq'));
    expect(joinResp.get('capwap.resultCode')).toBe(0);
    expect(joinResp.get('capwap.acName')).toBe('WLC1');
    expect(join.get('capwap.wtpName')).toBe('LAP1');
    // W6 (§9.2 item 22b): the Discovery and Join Requests carry the AP's base MAC, the identity the controller keys by;
    // the later requests do not
    expect(sim.pdu(msgs[0]!.id)!.get('capwap.wtpMac')).toBe(apMac);
    expect(join.get('capwap.wtpMac')).toBe(apMac);
    expect(sim.pdu(msgs[4]!.id)!.get('capwap.wtpMac')).toBeUndefined();
    expect(sim.pdu(msgs[2]!.id)!.summary()).toBe(`CAPWAP Join Request from LAP1 (${apMac}) seq ${String(join.get('capwap.seq'))}`);

    // the sockets: control 5246 and the TUNNEL data socket 5247 on both sides
    for (const [device, owner] of [['lap1', 'capwap-wtp'], ['wlc1', 'capwap-ac']] as const) {
      const rows = sim.device(device)!.tables.get<SocketRow>('sockets')!.rows().filter((r) => r.owner === owner);
      expect(rows.map((r) => [r.id, r.localAddr, r.localPort, r.state])).toEqual([
        [`${owner}#ctl`, '0.0.0.0', 5246, 'BOUND'],
        [`${owner}#data`, '0.0.0.0', 5247, 'BOUND'],
      ]);
      const udp = sim.device(device)!.processes.get('udp')!.stateSnapshot().state as { sockets: { id: string; tunnel?: boolean }[] };
      expect(udp.sockets.filter((s) => s.id.startsWith(owner)).map((s) => [s.id, s.tunnel === true])).toEqual([
        [`${owner}#ctl`, false],
        [`${owner}#data`, true],
      ]);
    }
  });

  it('marks every control message after the simulated DTLS step meta.protected, and none before it; echoes are background', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE + 60 * SEC);
    const msgs = controlMessages(sim, events(sim));
    expect(msgs.filter((m) => m.type === CAPWAP_MSG.echoReq).length).toBeGreaterThanOrEqual(2);
    for (const m of msgs) {
      const beforeDtls = m.type === CAPWAP_MSG.discoveryReq || m.type === CAPWAP_MSG.discoveryResp;
      expect([m.type, m.protected]).toEqual([m.type, !beforeDtls]);
      const echo = m.type === CAPWAP_MSG.echoReq || m.type === CAPWAP_MSG.echoResp;
      expect([m.type, m.background]).toEqual([m.type, echo]);
    }
    // the protected payload is still decoded (headers real, crypto simulated): the inspector reads every element
    const wlan = msgs.find((m) => m.type === CAPWAP_MSG.wlanConfigReq)!;
    expect(sim.pdu(wlan.id)!.layer('capwap')!.error).toBeUndefined();
  });

  it('pushes the WLAN with its key tag and VLAN, never the passphrase, and the radios serve it centrally', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const evs = events(sim);
    const tag = passphraseTag(SSID, PASSPHRASE);
    const push = controlMessages(sim, evs).find((m) => m.type === CAPWAP_MSG.wlanConfigReq)!;
    expect(sim.pdu(push.id)!.get('capwap.wlans')).toBe(`1:${SSID}:wpa2-psk:20:${tag}`);
    expect(sim.pdu(push.id)!.get('capwap.radioId')).toBe(0);
    // the one settings renderer overlays the controller profile on both radios
    const lap = sim.device('lap1')!;
    for (const port of ['Wlan0', 'Wlan1']) {
      const settings = lap.radioSettings(port)!;
      expect(settings).toMatchObject({ ssid: SSID, security: 'wpa2-psk', controller: 'WLC1' });
      expect(settings.passphrase).toBeUndefined();
      expect(settings.bss).toEqual([{ index: 0, ssid: SSID, security: 'wpa2-psk', keyTag: tag, vlan: 20, switching: 'central', wlanId: 1 }]);
    }
    const bss = sim.snapshot().media!.bss.filter((b) => b.ap.device === 'lap1');
    expect(bss.map((b) => [b.id, b.ssid, b.up, b.wlanId, b.vlan, b.switching, 'index' in b])).toEqual([
      ['bss:lap1/Wlan0', SSID, true, 1, 20, 'central', false],
      ['bss:lap1/Wlan1', SSID, true, 1, 20, 'central', false],
    ]);
    // the laptop joins with the pushed key tag (its own passphrase), and the controller learns it
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(true);
    expect(sim.device('wlc1')!.tables.get('wlan-clients')!.size).toBe(1);
    // the passphrase is in no PDU byte and no snapshot
    const secret = Buffer.from(PASSPHRASE, 'latin1');
    for (const e of ofKind(evs, 'pduCreated')) expect(Buffer.from(sim.pdu(e.pdu.id)!.bytes).includes(secret)).toBe(false);
    expect(JSON.stringify(sim.snapshot())).not.toContain(PASSPHRASE);
    // the StateViews never carry a key tag or passphrase
    for (const d of ['lap1', 'wlc1']) {
      const views = JSON.stringify(sim.device(d)!.stateSnapshots());
      expect(views).not.toContain(PASSPHRASE);
      expect(views).not.toContain(String(tag));
    }
  });

  it('with the P2 defaults the AP takes a DHCP lease on Vlan1, then discovers in the instant of the lease', () => {
    const sim = capwapWorld({ ap: 'dhcp', laptop: false });
    sim.runFor(120 * SEC);
    const evs = events(sim);
    const lease = sim.device('lap1')!.port('Vlan1')!.l3.ipv4!;
    expect(lease).toMatchObject({ address: AP_ADDR, prefixLen: 24, origin: 'dhcp' });
    const bound = ofKind(evs, 'debug').find((e) => e.event.device === 'lap1' && e.event.process === 'dhcp-client' && e.event.message.includes('bound'))!;
    const discovery = transitions(evs, 'lap1', 'capwap-wtp')[0]!;
    expect(discovery.to).toBe('discovery');
    // W5 fix: dhcp-client's `dhcp.lease` reaches capwap-wtp, which starts at once instead of on the next 10 s tick
    expect(discovery.t).toBe(bound.t);
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.get(WLC_MGMT)!.state).toBe('run');
  });

  it('a DHCP-addressed AP joins while the world runs to idle, so a settled copy for the grader has a working WLAN', () => {
    // runToIdle never dispatches a periodic tick; the lease event is what starts the AP (§11.2 clones settle this way)
    const sim = capwapWorld({ ap: 'dhcp', laptopDhcp: true });
    sim.runToIdle(2_000_000);
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.get(WLC_MGMT)!.state).toBe('run');
    expect(sim.device('wlc1')!.tables.get<WlanClientRow>('wlan-clients')!.size).toBe(1);
    expect(sim.device('lt1')!.port('Wlan0')!.l3.ipv4).toMatchObject({ origin: 'dhcp', address: LAPTOP_ADDR });
    const lab: ScenarioInfo = {
      name: 'capwap-dhcp-probe',
      category: 'template',
      title: 'A DHCP access point',
      description: 'A laptop that leased its address through a lightweight AP reaches its gateway.',
      build: () => sim.exportTopology(),
      tasks: [{ id: 'reach', title: 'Reach the gateway', description: 'LAPTOP1 reaches R1.', points: 1, assertions: [{ kind: 'connectivity', from: 'LAPTOP1', to: 'R1', expect: 'success' }] }],
    };
    const status = evaluateLab(sim, lab);
    expect(status.results[0]!.assertions).toEqual([{ index: 0, pass: true }]);
  });

  it('sends discovery to the configured controllers instead of the subnet broadcast', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false, apLines: [`capwap controller ${WLC_MGMT}`] });
    sim.runFor(SETTLE);
    const evs = events(sim);
    const discoveries = controlMessages(sim, evs).filter((m) => m.type === CAPWAP_MSG.discoveryReq);
    expect(discoveries.length).toBe(1);
    expect(sim.pdu(discoveries[0]!.id)!.get('ipv4.dst')).toBe(WLC_MGMT);
    expect(transitions(evs, 'lap1', 'capwap-wtp')[0]).toMatchObject({ subject: `controller ${WLC_MGMT}`, from: 'idle', to: 'discovery' });
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.get(WLC_MGMT)!.state).toBe('run');
  });
});

describe('W5 wireless — retransmission and fall-back (§3.12 step 3, §4.2)', () => {
  it('re-sends an unanswered Join Request 3 times in all, then goes back to discovery', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE, { stopOn: { tags: ['capwap-join'] } });
    sim.setPower('wlc1', false);
    const cursor = sim.trace(0).next;
    sim.runFor(12 * SEC);
    const evs = sim.trace(cursor).events;
    const joins = ofKind(evs, 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-join');
    expect(joins.length).toBe(2);
    const all = ofKind(events(sim), 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-join');
    expect(all.length).toBe(3);
    expect(all[1]!.t - all[0]!.t).toBe(3 * SEC);
    expect(all[2]!.t - all[1]!.t).toBe(3 * SEC);
    // the controller's lane ends (join → idle) and broadcast discovery starts again, 9 s after the first join
    const back = transitions(evs, 'lap1', 'capwap-wtp');
    expect(back.map((t) => [t.subject, t.from, t.to, t.cause])).toEqual([
      [`controller ${WLC_MGMT}`, 'join', 'idle', 'no answer after 3 tries'],
      ['controller 192.168.99.255', 'idle', 'discovery', 'no answer after 3 tries'],
    ]);
    expect(back[0]!.t - all[0]!.t).toBe(9 * SEC);
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([['192.168.99.255', 'discovery']]);
  });

  it('three missed echoes send a running AP back to discovery and clear its radio profiles', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(true);
    const off = sim.now;
    sim.setPower('wlc1', false);
    const cursor = sim.trace(0).next;
    sim.runFor(150 * SEC);
    const evs = sim.trace(cursor).events;
    const lost = transitions(evs, 'lap1', 'capwap-wtp');
    expect(lost.map((t) => [t.subject, t.from, t.to])).toEqual([
      [`controller ${WLC_MGMT}`, 'run', 'idle'],
      ['controller 192.168.99.255', 'idle', 'discovery'],
    ]);
    const back = lost[0]!;
    expect(back.cause).toBe('3 echo requests went unanswered');
    // the echoes left every 30 s; the fourth tick finds the third one unanswered
    const echoes = ofKind(evs, 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-echo' && e.t < back.t);
    expect(echoes.length).toBe(3);
    expect(back.t - off).toBeLessThanOrEqual(4 * 30 * SEC);
    const lap = sim.device('lap1')!;
    expect(lap.radioSettings('Wlan0')!.bss).toBeUndefined();
    expect(lap.radioSettings('Wlan0')!.ssid).toBeUndefined();
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    expect(lap.tables.get<CapwapRow>('capwap')!.rows().map((r) => r.state)).toEqual(['discovery']);
    // an unanswered AP keeps rediscovering on its periodic timer and never holds runToIdle
    const stats = sim.runToIdle(100_000);
    expect(stats.events).toBeLessThan(100_000);
  });

  it('ages a silent AP out of the controller after 90 s without an echo: its row and its stations go', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const wlc = sim.device('wlc1')!;
    expect(wlc.tables.get('capwap-aps')!.size).toBe(1);
    expect(wlc.tables.get('wlan-clients')!.size).toBe(1);
    sim.setPower('lap1', false);
    const cursor = sim.trace(0).next;
    sim.runFor(100 * SEC);
    const evs = sim.trace(cursor).events;
    expect(wlc.tables.get('capwap-aps')!.size).toBe(0);
    expect(wlc.tables.get('wlan-clients')!.size).toBe(0);
    const gone = transitions(evs, 'wlc1', 'capwap-ac');
    expect(gone.map((t) => [t.from, t.to, t.cause])).toEqual([['run', 'idle', 'no echo request for 90 s']]);
    const expired = ofKind(evs, 'tableExpire').filter((e) => e.device === 'wlc1');
    expect(expired.map((e) => [e.table, e.reason])).toEqual([
      ['wlan-clients', 'cleared'],
      ['capwap-aps', 'cleared'],
    ]);
  });
});

describe('W5 wireless — silence (§4.3)', () => {
  it('an NF-AP-1832 without `capwap enable` sends no CAPWAP, opens no socket and writes no capwap row, even with a static address', () => {
    const sim = createP2Simulation({ seed: 3, profile: 'P1', factories: capwapFactories() });
    sim.addDevice({
      id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1', position: { x: 0, y: 0 },
      startupConfig: configText([['hostname LAP1'], section('interface Vlan1', [`ip address ${AP_ADDR} ${M24}`, 'no shutdown'])]),
    });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { x: 100, y: 0 }, startupConfig: configText([['hostname PC1'], section('interface GigabitEthernet0', [`ip address 192.168.99.30 ${M24}`])]) });
    sim.addLink({ id: 'l1', a: { device: 'lap1', port: 'GigabitEthernet0' }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
    sim.runFor(600 * SEC);
    const evs = events(sim);
    expect(sim.device('lap1')!.model.processes).toContain('capwap-wtp');
    expect(ofKind(evs, 'pduCreated').filter((e) => e.pdu.proto === 'capwap' || e.process === 'capwap-wtp')).toEqual([]);
    expect(ofKind(evs, 'debug').filter((e) => e.event.process === 'capwap-wtp')).toEqual([]);
    expect(sim.device('lap1')!.tables.get('capwap')!.size).toBe(0);
    expect(sim.device('lap1')!.tables.get<SocketRow>('sockets')!.rows()).toEqual([]);
    // the stored negation of a P2 world behaves the same: `no capwap enable` is not `capwap enable`
    const sim2 = createP2Simulation({ seed: 3, factories: capwapFactories() });
    sim2.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1', position: { x: 0, y: 0 }, startupConfig: configText([['hostname LAP1'], ['no capwap enable']]) });
    sim2.runFor(120 * SEC);
    expect(ofKind(events(sim2), 'debug').filter((e) => e.event.process === 'capwap-wtp')).toEqual([]);
  });

  it('a controller without a management interface opens no socket and writes no row', () => {
    const sim = createP2Simulation({ seed: 4, factories: capwapFactories() });
    const noManagement = wlcConfig().replace(/wlc-interface management\n( [^\n]*\n)+/, '');
    expect(noManagement).not.toContain('wlc-interface management');
    sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 0, y: 0 }, startupConfig: noManagement });
    sim.runFor(120 * SEC);
    const evs = events(sim);
    expect(ofKind(evs, 'debug').filter((e) => e.event.process === 'capwap-ac')).toEqual([]);
    expect(sim.device('wlc1')!.tables.get<SocketRow>('sockets')!.rows()).toEqual([]);
    expect(sim.device('wlc1')!.tables.get('capwap-aps')!.size).toBe(0);
  });

  it('an AP whose controller never answers retries discovery every 10 s and never holds runToIdle', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.setPower('wlc1', false);
    sim.runFor(SETTLE);
    const stats = sim.runToIdle(100_000);
    expect(stats.events).toBeLessThan(100_000);
    const discoveries = controlMessages(sim, events(sim)).filter((m) => m.type === CAPWAP_MSG.discoveryReq);
    expect(discoveries.length).toBeGreaterThanOrEqual(5);
    const times = ofKind(events(sim), 'pduCreated').filter((e) => e.pdu.tag === 'capwap-discovery').map((e) => e.t);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBe(10 * SEC);
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([['192.168.99.255', 'discovery']]);
  });
});

/**
 * Apply one config line on a device at the current time, as a typed line (the same-wave cli owns the grammar of these
 * lines, so the runtime is called directly; an empty action list first brings the device's clock to now).
 */
function configLine(sim: Simulation, device: string, context: string[][], line: string[], negate: boolean): { ok: boolean; error?: string } {
  const dev = sim.device(device)!;
  dev.applyActions('capwap-wtp', [], sim.now);
  return dev.applyConfigLine(context, line, negate);
}

describe('W5 wireless — configuration changes while running', () => {
  it('a WLAN shut on the controller is withdrawn from the AP (radios stop, rows go) and offered again when enabled', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const wlc = sim.device('wlc1')!;
    expect(wlc.tables.get('wlan-clients')!.size).toBe(1);
    const cursor = sim.trace(0).next;
    expect(configLine(sim, 'wlc1', [['wlan', '1', 'STAFF', SSID]], ['shutdown'], false)).toEqual({ ok: true });
    sim.runFor(5 * SEC);
    let evs = sim.trace(cursor).events;
    const withdraw = controlMessages(sim, evs).filter((m) => m.type === CAPWAP_MSG.wlanConfigReq);
    expect(withdraw.map((m) => sim.pdu(m.id)!.get('capwap.wlans'))).toEqual(['1::open:0:0']);
    expect(wlc.tables.get('wlan-clients')!.size).toBe(0);
    expect(wlc.tables.get<CapwapApRow>('capwap-aps')!.rows()[0]!.clients).toBe(0);
    const lap = sim.device('lap1')!;
    expect(lap.radioSettings('Wlan0')!.bss).toEqual([]);
    expect(lap.radioSettings('Wlan0')!.ssid).toBeUndefined();
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    expect(lap.tables.get<CapwapRow>('capwap')!.get(WLC_MGMT)).toMatchObject({ state: 'run', wlans: 0 });
    // enabled again: pushed again, the laptop rejoins and is reported
    const again = sim.trace(0).next;
    expect(configLine(sim, 'wlc1', [['wlan', '1', 'STAFF', SSID]], ['shutdown'], true)).toEqual({ ok: true });
    sim.runFor(15 * SEC);
    evs = sim.trace(again).events;
    const push = controlMessages(sim, evs).filter((m) => m.type === CAPWAP_MSG.wlanConfigReq);
    expect(push.map((m) => sim.pdu(m.id)!.get('capwap.wlans'))).toEqual([`1:${SSID}:wpa2-psk:20:${passphraseTag(SSID, PASSPHRASE)}`]);
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(true);
    expect(wlc.tables.get('wlan-clients')!.size).toBe(1);
  });

  it('a `capwap controller` line typed during broadcast discovery ends the broadcast lane and starts the controller one', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.setPower('wlc1', false);
    sim.runFor(SETTLE);
    const lap = sim.device('lap1')!;
    expect(lap.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([['192.168.99.255', 'discovery']]);
    const cursor = sim.trace(0).next;
    expect(configLine(sim, 'lap1', [], ['capwap', 'controller', WLC_MGMT], false)).toEqual({ ok: true });
    sim.runFor(15 * SEC);
    const evs = sim.trace(cursor).events;
    expect(transitions(evs, 'lap1', 'capwap-wtp').map((t) => [t.subject, t.from, t.to, t.cause])).toEqual([
      ['controller 192.168.99.255', 'discovery', 'idle', 'controller list changed'],
      [`controller ${WLC_MGMT}`, 'idle', 'discovery', 'controller list changed'],
    ]);
    expect(lap.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([[WLC_MGMT, 'discovery']]);
    // from now on discovery is unicast to the controller only
    const sent = controlMessages(sim, evs).filter((m) => m.type === CAPWAP_MSG.discoveryReq).map((m) => sim.pdu(m.id)!.get('ipv4.dst'));
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent)).toEqual(new Set([WLC_MGMT]));
    // the same line again changes nothing
    const again = sim.trace(0).next;
    expect(configLine(sim, 'lap1', [], ['capwap', 'controller', WLC_MGMT], false)).toEqual({ ok: true });
    sim.runFor(1 * SEC);
    expect(transitions(sim.trace(again).events, 'lap1', 'capwap-wtp')).toEqual([]);
  });

  it('discovery stops while the management interface is down and starts again when it comes back', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.setPower('wlc1', false);
    sim.runFor(SETTLE);
    const lap = sim.device('lap1')!;
    const cursor = sim.trace(0).next;
    expect(configLine(sim, 'lap1', [['interface', 'Vlan1']], ['shutdown'], false)).toEqual({ ok: true });
    sim.runFor(30 * SEC);
    let evs = sim.trace(cursor).events;
    const down = transitions(evs, 'lap1', 'capwap-wtp');
    expect(down.map((t) => [t.subject, t.from, t.to, t.cause])).toEqual([['controller 192.168.99.255', 'discovery', 'idle', 'the management interface has no address']]);
    expect(lap.tables.get('capwap')!.size).toBe(0);
    // nothing is sent while idle (the first tick after the shutdown finds no address)
    expect(ofKind(evs, 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-discovery' && e.t > down[0]!.t)).toEqual([]);
    const up = sim.trace(0).next;
    expect(configLine(sim, 'lap1', [['interface', 'Vlan1']], ['shutdown'], true)).toEqual({ ok: true });
    sim.runFor(5 * SEC);
    evs = sim.trace(up).events;
    expect(transitions(evs, 'lap1', 'capwap-wtp').map((t) => [t.subject, t.from, t.to])).toEqual([['controller 192.168.99.255', 'idle', 'discovery']]);
    expect(ofKind(evs, 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-discovery').length).toBe(1);
    expect(lap.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([['192.168.99.255', 'discovery']]);
    // an unanswered AP still never holds runToIdle
    expect(sim.runToIdle(100_000).events).toBeLessThan(100_000);
  });

  it('`no capwap enable` on a running AP stops CAPWAP: profiles cleared, sockets closed, rows gone', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const lap = sim.device('lap1')!;
    const cursor = sim.trace(0).next;
    expect(configLine(sim, 'lap1', [], ['capwap', 'enable'], true)).toEqual({ ok: true });
    sim.runFor(5 * SEC);
    const evs = sim.trace(cursor).events;
    expect(transitions(evs, 'lap1', 'capwap-wtp').map((t) => [t.subject, t.from, t.to, t.cause])).toEqual([[`controller ${WLC_MGMT}`, 'run', 'idle', 'capwap disabled']]);
    expect(lap.radioSettings('Wlan0')!.bss).toBeUndefined();
    expect(lap.tables.get('capwap')!.size).toBe(0);
    expect(lap.tables.get<SocketRow>('sockets')!.rows().filter((r) => r.owner === 'capwap-wtp')).toEqual([]);
    expect(sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    // the stored negation survives in the running config (a P2 default slot) and nothing more is sent
    expect(lap.running.render()).toContain('no capwap enable');
    const later = sim.trace(0).next;
    sim.runFor(60 * SEC);
    expect(ofKind(sim.trace(later).events, 'pduCreated').filter((e) => e.device === 'lap1' && e.process === 'capwap-wtp')).toEqual([]);
  });
});

/**
 * W6 wireless (§9.2 item 22b, W5 review finding #13): the controller knows an AP by the WTP MAC its Discovery and Join
 * Requests carry (NF vendor element 3, the AP's base MAC), never by the Ethernet source. The W5 interim (a second AP
 * behind the same Ethernet source was refused while the first was joined) is replaced by the proper fix: two APs
 * behind one router both join and stay in run.
 */
describe('W6 wireless — the CAPWAP AP identity: two access points behind one router (§9.2 item 22b)', () => {
  /**
   * LAP1 and LAP2 sit in VLAN 20 behind R1 (192.168.20.1) and reach the controller's VLAN 99 through it: every request
   * reaches the controller with R1's MAC as its Ethernet source.
   */
  function routedApsWorld(): Simulation {
    const sim = createP2Simulation({ seed: 5, profile: 'P2', factories: capwapFactories() });
    const routedAp = (name: string, address: string): string =>
      configText([[`hostname ${name}`], [`capwap controller ${WLC_MGMT}`], section('interface Vlan1', [`ip address ${address} ${M24}`, 'no shutdown']), [`ip default-gateway ${GW20}`]]);
    const sw = configText([
      ['hostname SW1'],
      ['vlan 20'],
      ['vlan 99'],
      section('interface GigabitEthernet0/1', ['switchport mode trunk', 'switchport nonegotiate', 'spanning-tree portfast trunk']),
      section('interface FastEthernet0/3', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
      section('interface FastEthernet0/4', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
      section('interface FastEthernet0/6', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
      section('interface FastEthernet0/7', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
    ]);
    sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 100, y: 100 }, startupConfig: wlcConfig() });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 300, y: 100 }, startupConfig: sw });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 300, y: 300 }, startupConfig: r1Config() });
    sim.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1', position: { x: 500, y: 100 }, startupConfig: routedAp('LAP1', '192.168.20.20') });
    sim.addDevice({ id: 'lap2', type: 'ap.nfap-lw', name: 'LAP2', position: { x: 500, y: 300 }, startupConfig: routedAp('LAP2', '192.168.20.21') });
    sim.addLink({ id: 'l_wlc', a: { device: 'wlc1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addLink({ id: 'l_r1_20', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
    sim.addLink({ id: 'l_r1_99', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'FastEthernet0/4' } });
    sim.addLink({ id: 'l_lap1', a: { device: 'lap1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/6' } });
    sim.addLink({ id: 'l_lap2', a: { device: 'lap2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/7' } });
    return sim;
  }

  it('both APs join under their own WTP MAC and stay in run, although every request reaches the controller from the router’s MAC', () => {
    const sim = routedApsWorld();
    sim.runFor(600 * SEC);
    const evs = events(sim);
    const router = macOf(sim, 'r1', 'GigabitEthernet0/1');
    const lap1 = macOf(sim, 'lap1', 'Vlan1');
    const lap2 = macOf(sim, 'lap2', 'Vlan1');
    expect(new Set([router, lap1, lap2]).size).toBe(3);

    // every Discovery and Join Request names its AP's base MAC; each AP sent one Join Request (the discoveries repeat
    // every 10 s until R1 routes), and every request the controller answered reached it from R1's MAC
    const messages = controlMessages(sim, evs);
    const requests = messages.filter((m) => m.type === CAPWAP_MSG.discoveryReq || m.type === CAPWAP_MSG.joinReq);
    for (const ap of ['lap1', 'lap2']) {
      expect(requests.filter((m) => m.device === ap && m.type === CAPWAP_MSG.joinReq)).toHaveLength(1);
      expect(requests.filter((m) => m.device === ap && m.type === CAPWAP_MSG.discoveryReq).length).toBeGreaterThanOrEqual(1);
    }
    const answered = new Set(messages.filter((m) => m.device === 'wlc1').map((m) => sim.pdu(m.id)!.meta.triggeredBy));
    let reached = 0;
    for (const m of requests) {
      const pdu = sim.pdu(m.id)!;
      expect([m.device, m.type, pdu.get('capwap.wtpMac')]).toEqual([m.device, m.type, m.device === 'lap1' ? lap1 : lap2]);
      if (!answered.has(m.id)) continue;
      reached++;
      expect([m.device, m.type, pdu.get('ethernet.src')]).toEqual([m.device, m.type, router]);
    }
    expect(reached).toBeGreaterThanOrEqual(4);

    // the controller keeps one session and one row per AP, keyed by the WTP MAC, both in run
    const rows = sim.device('wlc1')!.tables.get<CapwapApRow>('capwap-aps')!.rows();
    const byKey = (a: readonly unknown[], b: readonly unknown[]): number => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
    expect(rows.map((r) => [r.key, r.apMac, r.apIp, r.name, r.state]).sort(byKey)).toEqual(
      [[lap1, lap1, '192.168.20.20', 'LAP1', 'run'], [lap2, lap2, '192.168.20.21', 'LAP2', 'run']].sort(byKey),
    );
    const ac = transitions(evs, 'wlc1', 'capwap-ac');
    for (const mac of [lap1, lap2]) {
      expect(ac.filter((t) => t.subject === `access point ${mac}`).map((t) => [t.from, t.to])).toEqual([
        ['idle', 'dtls'], ['dtls', 'join'], ['join', 'configure'], ['configure', 'data-check'], ['data-check', 'run'],
      ]);
    }
    // nobody was evicted, refused or aged out: no lane ever went back to idle, and no refusal was logged
    expect(ac.filter((t) => t.to === 'idle')).toEqual([]);
    expect(ofKind(evs, 'debug').filter((e) => e.event.device === 'wlc1' && e.event.message.includes('refused'))).toEqual([]);
    expect(controlMessages(sim, evs).filter((m) => m.device === 'wlc1' && sim.pdu(m.id)!.get('capwap.resultCode') === 1)).toEqual([]);

    // both APs are in run with the controller and stayed there, echoing every 30 s
    for (const ap of ['lap1', 'lap2']) {
      expect(sim.device(ap)!.tables.get<CapwapRow>('capwap')!.rows().map((r) => [r.controller, r.state])).toEqual([[WLC_MGMT, 'run']]);
      expect(transitions(evs, ap, 'capwap-wtp').filter((t) => t.from === 'run')).toEqual([]);
      expect(ofKind(evs, 'pduCreated').filter((e) => e.device === ap && e.pdu.tag === 'capwap-echo').length).toBeGreaterThanOrEqual(15);
    }
    const state = sim.device('wlc1')!.processes.get('capwap-ac')!.stateSnapshot().state as { aps: { apMac: string; state: string }[] };
    expect(state.aps.map((a) => [a.apMac, a.state])).toEqual([[lap1, 'run'], [lap2, 'run']].sort(byKey));
    // echoes are periodic: nothing holds runToIdle
    expect(sim.runToIdle(50_000).events).toBeLessThan(50_000);
  });

  it('an AP that reboots and joins again replaces its own session under the same WTP MAC', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE);
    const apMac = macOf(sim, 'lap1', 'Vlan1');
    sim.setPower('lap1', false);
    sim.runFor(1 * SEC);
    const cursor = sim.trace(0).next;
    sim.setPower('lap1', true);
    sim.runFor(60 * SEC);
    const ac = transitions(sim.trace(cursor).events, 'wlc1', 'capwap-ac');
    expect(ac.map((t) => [t.subject, t.from, t.to, t.cause])).toEqual([
      [`access point ${apMac}`, 'run', 'idle', 'it joined again'],
      [`access point ${apMac}`, 'idle', 'dtls', CAPWAP_DTLS_CAUSE],
      [`access point ${apMac}`, 'dtls', 'join', 'join request accepted'],
      [`access point ${apMac}`, 'join', 'configure', 'configuration status received'],
      [`access point ${apMac}`, 'configure', 'data-check', 'change state event received'],
      [`access point ${apMac}`, 'data-check', 'run', 'access point joined'],
    ]);
    expect(sim.device('wlc1')!.tables.get<CapwapApRow>('capwap-aps')!.rows().map((r) => [r.key, r.apIp, r.state])).toEqual([[apMac, AP_ADDR, 'run']]);
  });

  it('a new AP that joins from the address of a joined one takes that endpoint over: the old session ends', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE);
    const old = macOf(sim, 'lap1', 'Vlan1');
    sim.setPower('lap1', false);
    // LAP3 takes LAP1's address (192.168.99.20) on SW1 Fa0/5 (VLAN 99) before the controller ages LAP1 out
    const cursor = sim.trace(0).next;
    sim.addDevice({
      id: 'lap3', type: 'ap.nfap-lw', name: 'LAP3', position: { x: 500, y: 200 },
      startupConfig: configText([['hostname LAP3'], section('interface Vlan1', [`ip address ${AP_ADDR} ${M24}`, 'no shutdown']), [`ip default-gateway ${AP_GW}`]]),
    });
    sim.addLink({ id: 'l_lap3', a: { device: 'lap3', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/5' } });
    sim.runFor(60 * SEC);
    const fresh = macOf(sim, 'lap3', 'Vlan1');
    expect(fresh).not.toBe(old);
    const ac = transitions(sim.trace(cursor).events, 'wlc1', 'capwap-ac');
    expect(ac[0]).toMatchObject({ subject: `access point ${old}`, from: 'run', to: 'idle', cause: `access point ${fresh} joined from ${AP_ADDR}` });
    expect(ac.slice(1).map((t) => [t.subject, t.to])).toEqual([
      [`access point ${fresh}`, 'dtls'], [`access point ${fresh}`, 'join'], [`access point ${fresh}`, 'configure'],
      [`access point ${fresh}`, 'data-check'], [`access point ${fresh}`, 'run'],
    ]);
    expect(sim.device('wlc1')!.tables.get<CapwapApRow>('capwap-aps')!.rows().map((r) => [r.key, r.name, r.apIp, r.state])).toEqual([[fresh, 'LAP3', AP_ADDR, 'run']]);
  });

  it('refuses a Join Request that names no WTP MAC (result 1) and keeps no session for it', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE);
    const cursor = sim.trace(0).next;
    // R1 (192.168.99.1, the AP subnet's gateway) sends a hand-built Join Request without the WTP MAC element
    const join = capwapCodec.encode({ messageType: CAPWAP_MSG.joinReq, seq: 9, wtpName: 'ROGUE' }, new Uint8Array(0));
    sim.device('r1')!.applyActions('dns-client', [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: 'dns-client', socket: 'probe#1', family: 4, localPort: 40001 } },
      { type: 'request', to: 'udp', req: { kind: 'udp.send', socket: 'probe#1', dst: WLC_MGMT, dstPort: 5246, src: AP_GW, data: join } },
    ], sim.now);
    sim.runFor(2 * SEC);
    const evs = sim.trace(cursor).events;
    const answers = controlMessages(sim, evs).filter((m) => m.device === 'wlc1' && m.type === CAPWAP_MSG.joinResp);
    expect(answers.map((m) => {
      const pdu = sim.pdu(m.id)!;
      return [pdu.get('capwap.resultCode'), pdu.get('ipv4.dst'), pdu.get('udp.dstPort')];
    })).toEqual([[1, AP_GW, 40001]]);
    expect(ofKind(evs, 'debug').filter((e) => e.event.device === 'wlc1' && e.event.message === `join request from ROGUE (${AP_GW}) refused: it names no access point MAC`)).toHaveLength(1);
    // no session, no row, no lane for it; the joined AP is untouched
    expect(transitions(evs, 'wlc1', 'capwap-ac')).toEqual([]);
    expect(sim.device('wlc1')!.tables.get<CapwapApRow>('capwap-aps')!.rows().map((r) => [r.apIp, r.state])).toEqual([[AP_ADDR, 'run']]);
  });
});

describe('W5 wireless — the NF encodings of the WLAN and station elements', () => {
  it('round-trips a WLAN entry (an SSID may contain ":"), reads a removal, and refuses what does not parse', () => {
    const w = { id: 3, ssid: 'Lab:Net 2', security: 'wpa3-sae' as const, vlan: 99, keyTag: 0xfedcba98 };
    expect(formatCapwapWlan(w)).toBe('3:Lab:Net 2:wpa3-sae:99:4275878552');
    expect(parseCapwapWlan(formatCapwapWlan(w))).toEqual(w);
    expect(parseCapwapWlan(formatCapwapWlanRemoval(3))).toEqual({ remove: 3 });
    for (const bad of ['', '1:x', 'x:ssid:open:1:0', '1:ssid:wep:1:0', '1:ssid:open:5000:0', '1:ssid:open:1:-4', '0:ssid:open:1:0']) {
      expect([bad, parseCapwapWlan(bad)]).toEqual([bad, undefined]);
    }
  });

  it('round-trips station reports (six-octet MACs in fixed positions) and skips malformed ones', () => {
    const add = { op: 'add' as const, station: '02:98:4b:70:7c:02', bssid: '02:27:63:71:d9:02', wlanId: 1 };
    const del = { op: 'del' as const, station: '02:98:4b:70:7c:03', bssid: '02:27:63:71:d9:03', wlanId: 2 };
    const text = `${formatCapwapStationReport(add)};${formatCapwapStationReport(del)};bogus:1;add:02:98:4b:70:7c:02:1`;
    expect(text.startsWith('add:02:98:4b:70:7c:02:02:27:63:71:d9:02:1;del:')).toBe(true);
    expect(parseCapwapStationReports(text)).toEqual([add, del]);
  });

  it('carries the WTP MAC as NF vendor element 3 (six octets, §9.2 item 22b) and refuses any other size', () => {
    const b = capwapCodec.encode({ messageType: CAPWAP_MSG.joinReq, seq: 3, wtpName: 'LAP1', wtpMac: '02:4e:59:e8:af:00' }, new Uint8Array(0));
    const hex = (bytes: Uint8Array): string => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    expect(hex(b)).toBe([
      '00 10 02 00 00 00 00 00', // preamble, HLEN 2 / RID 0 / WBID 1, no flags, no fragmentation
      '00 00 00 03', // message type 3 (Join Request)
      '03', // sequence
      '00 1b', // element length = 24 + 3
      '00', // flags
      '00 2d 00 04 4c 41 50 31', // WTP Name "LAP1"
      '00 25 00 0c 00 02 4e 46 00 03 02 4e 59 e8 af 00', // Vendor Specific (37): NF OUI, NF element 3, the six octets
    ].join(' '));
    const decoded = capwapCodec.decode(b, 0, b.length);
    expect(decoded.error).toBeUndefined();
    expect(decoded.fields).toEqual({ radioId: 0, wbid: 1, tbit: false, messageType: 3, seq: 3, wtpName: 'LAP1', wtpMac: '02:4e:59:e8:af:00' });
    expect(decoded.fieldRanges?.wtpMac).toEqual([24, 16]);
    expect(capwapCodec.summarize(decoded.fields)).toBe('CAPWAP Join Request from LAP1 (02:4e:59:e8:af:00) seq 3');
    expect(capwapCodec.summarize({ messageType: CAPWAP_MSG.discoveryReq, seq: 1, wtpMac: '02:4e:59:e8:af:00' })).toBe('CAPWAP Discovery Request from 02:4e:59:e8:af:00 seq 1');
    // a WTP MAC element of five octets is an error; an unparseable MAC is refused on encode
    const short = Uint8Array.from([0x00, 0x10, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x01, 0x00, 0x12, 0x00, 0x00, 0x25, 0x00, 0x0b, 0x00, 0x02, 0x4e, 0x46, 0x00, 0x03, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    expect(capwapCodec.decode(short, 0, short.length).error).toBe('CAPWAP WTP MAC element carries 5 octets, not 6');
    expect(() => capwapCodec.encode({ messageType: CAPWAP_MSG.joinReq, wtpMac: 'not-a-mac' }, new Uint8Array(0))).toThrow(/capwap\.wtpMac must be a MAC address/);
  });

  it('keeps CAPWAP name elements printable', () => {
    expect(capwapText('AP-Hall 2')).toBe('AP-Hall 2');
    expect(capwapText('Accès 1')).toBe('Acc?s?1');
  });
});

describe('W5 wireless — determinism', () => {
  it('the same seed gives the same join, trace for trace', () => {
    const run = (): string => {
      const sim = capwapWorld({ seed: 31, ap: 'dhcp' });
      sim.runFor(120 * SEC);
      return JSON.stringify({ trace: events(sim), snapshot: sim.snapshot() });
    };
    expect(run()).toBe(run());
  });
});

describe('W6 fix — the lease event reaches only the daemons the access point runs', () => {
  it('a DHCP-addressed NF-AP-1832 (dhcp-client without dns-client) logs no "no process" runtime line on its lease', () => {
    const sim = capwapWorld({ seed: 12, ap: 'dhcp', laptop: false });
    sim.runFor(SETTLE);
    const evs = events(sim);
    expect(sim.device('lap1')!.model.processes).toContain('dhcp-client');
    expect(sim.device('lap1')!.model.processes).not.toContain('dns-client');
    // the lease happened (so the event was built), and capwap-wtp still got its copy: the AP reached run
    expect(sim.device('lap1')!.port('Vlan1')!.l3.ipv4).toMatchObject({ address: AP_ADDR, origin: 'dhcp' });
    expect(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.get(WLC_MGMT)!.state).toBe('run');
    const stray = ofKind(evs, 'debug').filter((e) => e.event.device === 'lap1' && e.event.message.includes('no process'));
    expect(stray.map((e) => e.event.message)).toEqual([]);
  });
});
