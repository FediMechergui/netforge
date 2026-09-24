/**
 * W5 wireless (ARCHITECTURE-P2 D17, §2.5, §2.7 `frameArrival.central`, §2.12, §3.12 steps 4–8, §4.5; §7 W5): the air
 * medium's CENTRAL mode and the wlan daemons' side of it, isolated from CAPWAP.
 *
 * A real world on `p2.world` (P1 profile, so no profile line is replayed) with the TEST-ONLY lightweight NF-AP-1832 and
 * a FAKE capwap-wtp registered under the real name: at boot it pushes a controller profile (`radio-profile`) that makes
 * Wlan0 a central BSS, and it records what the AP hands it — the `wlan.grant` events and the stations' 802.11 data
 * frames — and consumes those frames. Asserted:
 *   • index-0 identity: the central BSS keeps the local BSS's id and BSSID; the snapshot adds wlanId, vlan and
 *     `switching: 'central'` (no `index` key), the radio view lists its BSS; wlan-ap reads it through ctx.radioSettings;
 *   • the station authenticates against the PUSHED key tag (a wrong passphrase fails, with no grant);
 *   • `wlan.grant add` reaches capwap-wtp before the station's port opens; `del` follows every departure (power-off,
 *     the profile withdrawn);
 *   • uplink: the station's data frame reaches the AP as 802.11, unchanged (no AP rewrap), and wlan-ap hands it to
 *     capwap-wtp with its PduId; a central data leg in flight dies with its association (drop 'not-associated');
 *   • downlink: a pre-built from-DS frame is put on the air as it is and rewrapped at the station ('wireless client
 *     framing'); a group frame skips its source; an unknown station drops 'not-associated'; a frame for another BSSID
 *     drops 'encapsulation-mismatch';
 *   • the AP's own bridge never puts Ethernet on a central radio;
 *   • a pushed key-tag change restarts the BSS (the station is disassociated and cannot rejoin with the old key).
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { ETHERTYPE_ARP, type Pdu } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessFactory } from '../src/contracts/process.js';
import type { BssSettings } from '../src/contracts/rf.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ArpRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { WlanGrantEvent } from '../src/contracts/transport.js';
import { AIR_DETAILS } from '../src/link/media/air.js';
import { CAUSE_STATION_FRAMING, fromDsDataHeaders, passphraseTag } from '../src/link/rewrap80211.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createP2Simulation } from './p2.world.js';

const M24 = '255.255.255.0';
const SSID = 'LabNet';
const PASS = 'Secret123';
const GW = '192.168.20.1';
const GW_MAC = '02:aa:00:00:00:01';
const LAPTOP = '192.168.20.10';

/** What the fake capwap-wtp saw. */
interface WtpLog {
  ctx?: ProcessCtx;
  readonly grants: WlanGrantEvent[];
  readonly uplink: { pdu: Pdu; port: PortId; layers: string[]; t: number }[];
  /** Shared ordering log (the fake's grants and the test's trace listener write into it). */
  readonly order: string[];
}

function centralProfile(keyTag = passphraseTag(SSID, PASS)): BssSettings[] {
  return [{ index: 0, ssid: SSID, security: 'wpa2-psk', keyTag, vlan: 20, switching: 'central', wlanId: 7 }];
}

/** A stand-in for capwap-wtp: pushes `profile` on Wlan0 at boot, records grants and uplink frames (consumed). */
function fakeWtp(log: WtpLog, profile: BssSettings[]): ProcessFactory {
  return (): Process => ({
    name: 'capwap-wtp',
    handles: [{ layer: 'dot11', frame: 'data', roles: ['wireless-bss'] }],
    init(ctx): Action[] {
      log.ctx = ctx;
      return [{ type: 'radio-profile', port: 'Wlan0', bss: profile, controller: 'WLC-TEST' }];
    },
    onPdu(ctx, pdu, port): Action[] {
      log.uplink.push({ pdu, port, layers: pdu.layers.map((l) => l.proto), t: ctx.now });
      return [{ type: 'consume', pdu }];
    },
    onTimer: () => [],
    onConfig: () => [],
    onEvent(_ctx, ev): Action[] {
      if (ev.kind === 'wlan.grant') {
        log.grants.push(ev);
        log.order.push(`grant ${ev.op}`);
      }
      return [];
    },
    stateSnapshot: () => ({ process: 'capwap-wtp', state: {} }),
    debugEvents: () => [],
  });
}

interface World {
  readonly sim: Simulation;
  readonly log: WtpLog;
  readonly laptopMac: string;
  readonly bssid: string;
}

function world(o: { passphrase?: string; profile?: BssSettings[] } = {}): World {
  const log: WtpLog = { grants: [], uplink: [], order: [] };
  const sim = createP2Simulation({ seed: 5, profile: 'P1', factories: { 'capwap-wtp': fakeWtp(log, o.profile ?? centralProfile()) } });
  sim.addDevice({
    id: 'ap1', type: 'ap.nfap-lw', name: 'AP1', position: { x: 300, y: 150 },
    startupConfig: configText([['hostname AP1'], section('interface Vlan1', [`ip address 192.168.20.2 ${M24}`, 'no shutdown'])]),
  });
  sim.addDevice({
    id: 'lt1', type: 'laptop.nflaptop', name: 'LAPTOP1', position: { x: 340, y: 150 },
    startupConfig: configText([
      ['hostname LAPTOP1'],
      section('interface Wlan0', [`ip address ${LAPTOP} ${M24}`, `ssid ${SSID}`, 'security wpa2-psk', `passphrase ${o.passphrase ?? PASS}`]),
      [`ip default-gateway ${GW}`],
    ]),
  });
  sim.addDevice({
    id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { x: 300, y: 300 },
    startupConfig: configText([['hostname PC1'], section('interface GigabitEthernet0', [`ip address 192.168.20.30 ${M24}`])]),
  });
  sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'ap1', port: 'GigabitEthernet0' } });
  sim.onTrace((e) => {
    if (e.kind === 'portState' && e.device === 'lt1' && e.port === 'Wlan0') log.order.push(`laptop ${e.operUp ? 'up' : 'down'}`);
  });
  sim.runFor(30 * SEC);
  return { sim, log, laptopMac: sim.device('lt1')!.port('Wlan0')!.mac, bssid: sim.device('ap1')!.port('Wlan0')!.mac };
}

const since = (sim: Simulation, cursor: number): TraceEvent[] => sim.trace(cursor).events;

function ofKind<K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Extract<TraceEvent, { kind: K }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
}

/** Send `layers` on AP1's Wlan0 as capwap-wtp would (a downlink frame out of the tunnel). */
function sendDown(w: World, layers: Parameters<ProcessCtx['newPdu']>[0]): Pdu {
  const pdu = w.log.ctx!.newPdu(layers, { tag: 'downlink-test' });
  w.sim.device('ap1')!.applyActions('capwap-wtp', [{ type: 'send', port: 'Wlan0', pdu }], w.sim.now);
  return pdu;
}

function arpReply(w: World, addr1: string, addr2 = w.bssid, addr3 = GW_MAC): Parameters<ProcessCtx['newPdu']>[0] {
  return [
    ...fromDsDataHeaders(addr1, addr2, addr3, ETHERTYPE_ARP),
    { proto: 'arp', fields: { op: 2, sha: GW_MAC, spa: GW, tha: w.laptopMac, tpa: LAPTOP } },
  ];
}

describe('W5 air — a central BSS (controller profile, switching central)', () => {
  it('keeps the index-0 identity, shows its WLAN, and lets the station join against the pushed key tag', () => {
    const w = world();
    const snap = w.sim.snapshot();
    const bss = snap.media!.bss.filter((b) => b.ap.device === 'ap1');
    expect(bss).toHaveLength(1);
    expect(bss[0]).toMatchObject({ id: 'bss:ap1/Wlan0', bssid: w.bssid, ssid: SSID, security: 'wpa2-psk', up: true, loaded: true, wlanId: 7, vlan: 20, switching: 'central' });
    expect('index' in bss[0]!).toBe(false);
    const radio = snap.devices.find((d) => d.id === 'ap1')!.ports.find((p) => p.id === 'Wlan0')!.radio!;
    expect(radio.bss).toEqual([{ index: 0, ssid: SSID, bssid: w.bssid, security: 'wpa2-psk', clients: 1 }]);
    // a radio without a profile keeps its P0.5 view (no bss list)
    const wlan1 = snap.devices.find((d) => d.id === 'ap1')!.ports.find((p) => p.id === 'Wlan1')!.radio!;
    expect('bss' in wlan1).toBe(false);
    // the station authenticated against the key tag (no passphrase was ever pushed) and is associated
    expect(w.sim.device('ap1')!.radioSettings('Wlan0')!.passphrase).toBeUndefined();
    expect(w.sim.device('lt1')!.port('Wlan0')!.operUp).toBe(true);
    expect(snap.media!.associations).toEqual([expect.objectContaining({ station: { device: 'lt1', port: 'Wlan0' }, authorized: true, bssid: w.bssid })]);
    const ap = w.sim.device('ap1')!.processes.get('wlan-ap')!.stateSnapshot().state as { radios: Record<string, unknown>[] };
    expect(ap.radios.find((r) => r.port === 'Wlan0')).toMatchObject({ ssid: SSID, switching: 'central', wlanId: 7 });
    expect('switching' in ap.radios.find((r) => r.port === 'Wlan1')!).toBe(false);
  });

  it('reports the grant to capwap-wtp before the station port opens, and every departure after it', () => {
    const w = world();
    expect(w.log.grants).toEqual([
      { kind: 'wlan.grant', op: 'add', port: 'Wlan0', station: w.laptopMac, bssid: w.bssid, wlanId: 7, state: 'associated' },
    ]);
    expect(w.log.order.slice(w.log.order.indexOf('grant add'))).toEqual(['grant add', 'laptop up']);
    // the station powers off: the AP loses it and reports it gone
    w.sim.setPower('lt1', false);
    w.sim.runFor(5 * SEC);
    expect(w.log.grants.map((g) => [g.op, g.station, g.state])).toEqual([
      ['add', w.laptopMac, 'associated'],
      ['del', w.laptopMac, 'idle'],
    ]);
    // back on, it joins again; then the controller withdraws the profile (the radio has no lines of its own: it stops)
    w.sim.setPower('lt1', true);
    w.sim.runFor(20 * SEC);
    expect(w.log.grants.map((g) => g.op)).toEqual(['add', 'del', 'add']);
    w.sim.device('ap1')!.applyActions('capwap-wtp', [{ type: 'radio-profile', port: 'Wlan0', bss: null }], w.sim.now);
    w.sim.runFor(5 * SEC);
    expect(w.log.grants.map((g) => g.op)).toEqual(['add', 'del', 'add', 'del']);
    expect(w.sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    expect(w.sim.snapshot().media!.bss.filter((b) => b.ap.device === 'ap1' && b.up)).toEqual([]);
  });

  it('a wrong passphrase fails against the pushed key tag, and nothing is reported', () => {
    const w = world({ passphrase: 'not-the-key' });
    w.sim.runFor(60 * SEC);
    expect(w.sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    const client = w.sim.device('lt1')!.processes.get('wlan-client')!.stateSnapshot().state as { ports: { state: string; reason?: string }[] };
    expect(client.ports[0]).toMatchObject({ state: 'failed', reason: 'wrong-key' });
    expect(w.log.grants).toEqual([]);
  });

  it('uplink: the station frame reaches the AP as 802.11, unchanged, and goes to capwap-wtp with its PduId', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const session = w.sim.cli.open('lt1', 'console');
    w.sim.cli.exec(session, `ping ${GW}`);
    w.sim.runFor(3 * SEC);
    const evs = since(w.sim, cursor);
    const arp = ofKind(evs, 'pduCreated').find((e) => e.device === 'lt1' && e.pdu.tag === 'arp-request')!;
    const got = w.log.uplink.filter((u) => u.pdu.id === arp.pdu.id);
    expect(got).toHaveLength(1);
    expect(got[0]!.port).toBe('Wlan0');
    expect(got[0]!.layers).toEqual(['dot11', 'llc', 'arp']);
    const d = got[0]!.pdu.layer('dot11')!.fields;
    expect([d.frameType, d.toDs, d.fromDs, d.addr1, d.addr2, d.addr3]).toEqual(['data', true, false, w.bssid, w.laptopMac, MAC_BROADCAST]);
    // station framing only: the AP did not rewrap it to Ethernet
    expect(got[0]!.pdu.provenance.filter((m) => m.device === 'ap1')).toEqual([]);
    expect(got[0]!.pdu.provenance.filter((m) => m.reason === 'Encapsulate' || m.reason === 'Decapsulate').map((m) => [m.device, m.reason, m.field, m.cause])).toEqual([
      // (arp builds its request as an Ethernet frame, so the station framing is the first structural change)
      ['lt1', 'Decapsulate', 'ethernet', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'dot11', CAUSE_STATION_FRAMING],
    ]);
    expect(ofKind(evs, 'frameRx').filter((e) => e.pdu.id === arp.pdu.id).map((e) => [e.device, e.port])).toEqual([['ap1', 'Wlan0']]);
    // the AP's bridge never saw the station: no CAM row, no flood to PC1
    expect(w.sim.device('ap1')!.tables.cam.rows().filter((r) => r.mac === w.laptopMac)).toEqual([]);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.id === arp.pdu.id && e.to.device === 'pc1')).toEqual([]);
  });

  it('a central data leg in flight dies with its association', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const session = w.sim.cli.open('lt1', 'console');
    w.sim.cli.exec(session, `ping ${GW}`);
    const arp = ofKind(since(w.sim, cursor), 'pduCreated').find((e) => e.device === 'lt1' && e.pdu.tag === 'arp-request')!;
    // the frame is on the air; the AP withdraws the grant in the same instant
    w.sim.device('ap1')!.applyActions('wlan-ap', [{ type: 'medium', port: 'Wlan0', op: { op: 'assoc', station: w.laptopMac, state: 'none' } }], w.sim.now);
    w.sim.runFor(1 * SEC);
    const evs = since(w.sim, cursor);
    const drops = ofKind(evs, 'drop').filter((e) => e.pdu.id === arp.pdu.id);
    expect(drops.map((e) => [e.reason, e.medium, e.association])).toEqual([['not-associated', 'bss:ap1/Wlan0', 'bss:ap1/Wlan0|lt1/Wlan0']]);
    expect(ofKind(evs, 'frameAbort').filter((e) => e.pdu.id === arp.pdu.id)).toHaveLength(1);
    expect(w.log.uplink.filter((u) => u.pdu.id === arp.pdu.id)).toEqual([]);
  });

  it('downlink: a pre-built from-DS frame goes on the air unchanged and is rewrapped at the station', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const reply = sendDown(w, arpReply(w, w.laptopMac));
    w.sim.runFor(1 * SEC);
    const evs = since(w.sim, cursor);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.id === reply.id).map((e) => [e.from.device, e.to.device, e.medium])).toEqual([['ap1', 'lt1', 'air']]);
    expect(reply.provenance.map((m) => [m.device, m.reason, m.field, m.cause])).toEqual([
      ['lt1', 'Decapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['lt1', 'Decapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'ethernet', CAUSE_STATION_FRAMING],
    ]);
    expect(w.sim.device('lt1')!.tables.arp.get(GW)).toMatchObject<Partial<ArpRow>>({ mac: GW_MAC, iface: 'Wlan0' });
  });

  it('downlink: a group frame skips its source, an unknown station and a foreign BSSID are refused', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const echo = sendDown(w, arpReply(w, MAC_BROADCAST, w.bssid, w.laptopMac));
    const stranger = sendDown(w, arpReply(w, '02:bb:00:00:00:09'));
    const foreign = sendDown(w, arpReply(w, w.laptopMac, '02:cc:00:00:00:02'));
    w.sim.runFor(1 * SEC);
    const evs = since(w.sim, cursor);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.id === echo.id || e.pdu.parent === echo.id)).toEqual([]);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.id === stranger.id).map((e) => [e.reason, e.detail, e.device])).toEqual([['not-associated', AIR_DETAILS.unknownStation, 'ap1']]);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.id === foreign.id).map((e) => [e.reason, e.detail])).toEqual([['encapsulation-mismatch', AIR_DETAILS.malformedData]]);
  });

  it("the AP's own bridge never puts Ethernet on a central radio", () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const session = w.sim.cli.open('pc1', 'console');
    w.sim.cli.exec(session, `ping ${LAPTOP}`);
    w.sim.runFor(12 * SEC);
    const evs = since(w.sim, cursor);
    const fromPc = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1').map((e) => e.pdu.id);
    const air = ofKind(evs, 'frameTx').filter((e) => e.medium === 'air' && (fromPc.includes(e.pdu.id) || (e.pdu.parent !== undefined && fromPc.includes(e.pdu.parent))));
    expect(air).toEqual([]);
    expect(ofKind(evs, 'frameRx').filter((e) => e.device === 'lt1' && e.pdu.proto === 'arp')).toEqual([]);
  });

  it('a pushed key-tag change restarts the BSS: the station is let go and cannot rejoin with the old key', () => {
    const w = world();
    expect(w.sim.device('lt1')!.port('Wlan0')!.operUp).toBe(true);
    const cursor = w.sim.trace(0).next;
    w.sim.device('ap1')!.applyActions('capwap-wtp', [{ type: 'radio-profile', port: 'Wlan0', bss: centralProfile(passphraseTag(SSID, 'a new key')), controller: 'WLC-TEST' }], w.sim.now);
    w.sim.runFor(30 * SEC);
    const evs = since(w.sim, cursor);
    expect(w.sim.device('lt1')!.port('Wlan0')!.operUp).toBe(false);
    expect(ofKind(evs, 'debug').some((e) => e.event.device === 'ap1' && e.event.process === 'wlan-ap' && e.event.message.includes('the controller changed'))).toBe(true);
    expect(w.log.grants.map((g) => g.op)).toEqual(['add', 'del']);
    const client = w.sim.device('lt1')!.processes.get('wlan-client')!.stateSnapshot().state as { ports: { state: string; reason?: string }[] };
    expect(client.ports[0]!.reason).toBe('wrong-key');
  });
});
