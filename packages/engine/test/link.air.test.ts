import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { MediaSnapshot } from '../src/contracts/medium.js';
import type { Pdu } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4 } from '../src/contracts/pdu.js';
import { MCS_TABLES, RF } from '../src/contracts/rf.js';
import { MS, SEC, propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { AIR_DETAILS } from '../src/link/media/air.js';
import { assessRfLink, mcsRateBps } from '../src/link/rf/mcs.js';
import { canvasDistanceMm } from '../src/link/rf/pathloss.js';
import {
  CAUSE_AP_BRIDGING,
  CAUSE_SIGNAL_ANNOTATION,
  CAUSE_STATION_FRAMING,
  applyRewrap,
  classifyAirFrame,
  dot11EthernetAddresses,
  dot11ToEthernetOp,
  eapolFrame,
  ethernetToDot11Op,
  mgmtFrame,
  passphraseTag,
  probeRequestFrame,
  saeCommitTag,
  tagBytes,
  tagFromBytes,
} from '../src/link/rewrap80211.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { echoLayers, keyOf, wifiWorld } from './wifi.harness.js';
import type { WifiWorld } from './wifi.harness.js';

const LAP = 'd_lap';
const AP = 'd_ap';
const meta = { born: 0, origin: 'd_x' };

/** Router at the origin serving `ssid` on Wlan0 (no daemons), laptop at `units` along x. */
function pair(units = 160, ssid = 'LAB', seed = 11): WifiWorld {
  const w = wifiWorld({ seed });
  w.addDevice(AP, 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', ssid]]] });
  w.addDevice(LAP, 'laptop.nflaptop', { x: units, y: 0 }, { daemons: false });
  w.boot();
  return w;
}

function grant(w: WifiWorld, ap: string, sta: string, aid = 1): void {
  const mac = w.port(sta, 'Wlan0').mac;
  w.op(ap, 'Wlan0', { op: 'assoc', station: mac, state: 'associated', aid });
  w.op(ap, 'Wlan0', { op: 'authorize', station: mac });
}

const echo = (w: WifiWorld, dst: string, src: string): Pdu => w.pdus.build(echoLayers(dst, src), meta);

const emptyMedia = (): MediaSnapshot => ({ metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] });

/** The medium's RF assessment for the router Wlan0 ↔ laptop pair at `units` (no interferers). */
function laptopAssessment(units: number, currentMcs?: number) {
  return assessRfLink({
    band: '2.4',
    cls: 'wifi',
    widthMhz: 20,
    distanceMm: canvasDistanceMm(units, 0, 0.25),
    a: { txPowerDbm: 20, antennaGainDbi: 3, generations: ['b', 'g', 'n'], streams: 2 },
    b: { txPowerDbm: 17, antennaGainDbi: 2, generations: ['b', 'g', 'n', 'ac'], streams: 2 },
    ...(currentMcs !== undefined ? { currentMcs } : {}),
  });
}

describe('rewrap80211: 802.3 ↔ 802.11 framing', () => {
  const STA = '02:11:22:33:44:55';
  const DST = '02:aa:bb:cc:dd:01';
  const BSSID = '02:4e:00:00:00:07';

  it('maps an Ethernet frame to a to-DS data frame and back, stamping each side', () => {
    const pdus = createPduFactory();
    const pdu = pdus.build(echoLayers(DST, STA), meta);
    const trace: TraceEvent[] = [];
    applyRewrap(pdu, ethernetToDot11Op(pdu, 'to-ds', BSSID), 'd_sta', 5, CAUSE_STATION_FRAMING, (e) => trace.push(e));
    const d = pdu.layers[0]!;
    expect(d.proto).toBe('dot11');
    expect(d.fields).toMatchObject({ frameType: 'data', toDs: true, fromDs: false, addr1: BSSID, addr2: STA, addr3: DST });
    expect(pdu.layers[1]).toMatchObject({ proto: 'llc', fields: { type: ETHERTYPE_IPV4 } });
    expect(pdu.layers.map((l) => l.proto)).toEqual(['dot11', 'llc', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.provenance.map((m) => [m.reason, m.field, m.device, m.cause])).toEqual([
      ['Decapsulate', 'ethernet', 'd_sta', CAUSE_STATION_FRAMING],
      ['Encapsulate', 'llc', 'd_sta', CAUSE_STATION_FRAMING],
      ['Encapsulate', 'dot11', 'd_sta', CAUSE_STATION_FRAMING],
    ]);
    expect(trace.map((e) => e.kind)).toEqual(['mutation', 'mutation', 'mutation']);
    expect(dot11EthernetAddresses(pdu)).toEqual({ dst: DST, src: STA, type: ETHERTYPE_IPV4, direction: 'to-ds' });

    const id = pdu.id;
    applyRewrap(pdu, dot11ToEthernetOp(pdu), 'd_ap', 9, CAUSE_AP_BRIDGING, (e) => trace.push(e));
    expect(pdu.id).toBe(id);
    expect(pdu.layers[0]).toMatchObject({ proto: 'ethernet', fields: { dst: DST, src: STA, type: ETHERTYPE_IPV4, fcsValid: true } });
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.provenance.slice(3).map((m) => [m.reason, m.field, m.device])).toEqual([
      ['Decapsulate', 'dot11', 'd_ap'],
      ['Decapsulate', 'llc', 'd_ap'],
      ['Encapsulate', 'ethernet', 'd_ap'],
    ]);
  });

  it('maps from-DS frames with the BSSID as transmitter and the source in addr3', () => {
    const pdus = createPduFactory();
    const pdu = pdus.build(echoLayers(STA, DST), meta);
    applyRewrap(pdu, ethernetToDot11Op(pdu, 'from-ds', BSSID), 'd_ap', 1, CAUSE_AP_BRIDGING, () => undefined);
    expect(pdu.layers[0]!.fields).toMatchObject({ toDs: false, fromDs: true, addr1: STA, addr2: BSSID, addr3: DST });
    expect(dot11EthernetAddresses(pdu)).toEqual({ dst: STA, src: DST, type: ETHERTYPE_IPV4, direction: 'from-ds' });
  });

  it('classifies management, EAPOL, data and Ethernet frames', () => {
    const pdus = createPduFactory();
    expect(classifyAirFrame(pdus.build(probeRequestFrame(STA, 'LAB'), meta))).toBe('mgmt');
    expect(classifyAirFrame(pdus.build(eapolFrame('from-ds', STA, BSSID, { step: 1, replayCounter: 1 }), meta))).toBe('eapol');
    expect(classifyAirFrame(pdus.build(echoLayers(DST, STA), meta))).toBe('ethernet');
    const data = pdus.build(echoLayers(DST, STA), meta);
    applyRewrap(data, ethernetToDot11Op(data, 'to-ds', BSSID), 'd', 0, CAUSE_STATION_FRAMING, () => undefined);
    expect(classifyAirFrame(data)).toBe('dot11-data');
    expect(() => dot11ToEthernetOp(pdus.build(probeRequestFrame(STA, ''), meta))).toThrow(/802\.11 data frame/);
    expect(() => ethernetToDot11Op(data, 'to-ds', BSSID)).toThrow(/ethernet frame/);
  });

  it('builds EAPOL messages with the tag as key data and the SAE commit fold', () => {
    const tag = passphraseTag('LAB', 'correct horse');
    expect(passphraseTag('LAB', 'correct horse')).toBe(tag);
    expect(passphraseTag('LAB', 'correct hors3')).not.toBe(tag);
    expect(passphraseTag('LAB2', 'correct horse')).not.toBe(tag);
    expect(tagFromBytes(tagBytes(tag))).toBe(tag);
    expect(tagFromBytes(new Uint8Array(3))).toBeUndefined();
    expect(saeCommitTag(tag)).toBe(((tag >>> 16) ^ (tag & 0xffff)) & 0xffff);

    const pdus = createPduFactory();
    const msg2 = pdus.build(eapolFrame('to-ds', STA, BSSID, { step: 2, replayCounter: 4, keyData: tagBytes(tag) }), meta);
    expect(msg2.layer('eapol')!.fields).toMatchObject({ handshakeStep: 2, replayCounter: 4, mic: true });
    expect(tagFromBytes(msg2.get('eapol.keyData'))).toBe(tag);
    const text = new TextDecoder().decode(msg2.bytes);
    expect(text.includes('correct horse')).toBe(false);
    const commit = pdus.build(mgmtFrame('auth', { addr1: BSSID, addr2: STA, addr3: BSSID, duration: saeCommitTag(tag) }, { authAlgorithm: 3, authSeq: 1, statusCode: 0 }), meta);
    expect(commit.get('dot11.duration')).toBe(saeCommitTag(tag));
  });
});

describe('air medium: carrier and refusals', () => {
  it('an access radio without an SSID has no carrier; configuring one brings the BSS up', () => {
    const w = wifiWorld();
    w.addDevice(AP, 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false });
    w.boot();
    const wl0 = w.port(AP, 'Wlan0');
    expect(wl0.phy?.carrier ?? false).toBe(false);
    expect(wl0.operUp).toBe(false);
    w.configure(AP, 'Wlan0', ['ssid', 'LAB']);
    expect(wl0.phy).toMatchObject({ carrier: true, lineProtocol: true, medium: 'air' });
    expect(wl0.operUp).toBe(true);
    expect(w.notifications.map((n) => [n.ref.port, n.ev])).toEqual([['Wlan0', { kind: 'carrier', up: true }]]);
    expect(w.ofKind('portState').at(-1)).toMatchObject({ device: AP, port: 'Wlan0', operUp: true });
    expect(w.air.radioPortView(w.ref(AP, 'Wlan0'))).toMatchObject({ mode: 'ap', up: true, ssid: 'LAB', band: '2.4', channel: 1, clients: 0 });
  });

  it('a station radio has carrier before association and refuses Ethernet data with not-associated', () => {
    const w = pair();
    const wl0 = w.port(LAP, 'Wlan0');
    expect(wl0.phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'not-associated' });
    expect(wl0.operUp).toBe(false);
    const ps = w.ofKind('portState').find((e) => e.device === LAP);
    expect(ps).toMatchObject({ operUp: false, carrier: true });
    const r = w.send(LAP, 'Wlan0', echo(w, w.port(AP, 'Wlan0').mac, wl0.mac));
    expect(r).toEqual({ ok: false, reason: 'not-associated' });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'not-associated', device: LAP, port: 'Wlan0', detail: AIR_DETAILS.notAssociated });
  });

  it('a radio that is administratively down refuses every frame with link-down and loses carrier', () => {
    const w = pair();
    w.setAdmin(LAP, 'Wlan0', false);
    expect(w.notifications.at(-1)).toMatchObject({ ref: { device: LAP, port: 'Wlan0' }, ev: { kind: 'carrier', up: false } });
    const r = w.send(LAP, 'Wlan0', w.pdus.build(probeRequestFrame(w.port(LAP, 'Wlan0').mac, 'LAB'), meta));
    expect(r).toEqual({ ok: false, reason: 'link-down' });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'link-down', detail: AIR_DETAILS.adminDown });
  });

  it('refuses frames that are neither 802.11 nor Ethernet', () => {
    const w = pair();
    const pdu = w.pdus.build([{ proto: 'payload', fields: { data: new Uint8Array(20) } }], meta);
    expect(w.send(AP, 'Wlan0', pdu)).toEqual({ ok: false, reason: 'encapsulation-mismatch' });
  });
});

describe('air medium: management frames', () => {
  it('a broadcast probe request reaches every up access radio in range on any channel, with scan backoff only', () => {
    const w = wifiWorld();
    w.addDevice('d_r1', 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'ONE']]] });
    w.addDevice('d_r2', 'wrouter.nfhome', { x: 40, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'TWO']], ['Wlan0', ['channel', '6']]] });
    w.addDevice('d_r3', 'wrouter.nfhome', { x: 4000, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'FAR']]] });
    w.addDevice(LAP, 'laptop.nflaptop', { x: 160, y: 0 }, { daemons: false });
    w.boot();
    w.runFor(MS);
    const now = w.now();
    const probe = w.pdus.build(probeRequestFrame(w.port(LAP, 'Wlan0').mac, ''), meta);
    const r = w.send(LAP, 'Wlan0', probe);
    const txs = w.ofKind('frameTx');
    expect(txs.map((e) => e.to.device)).toEqual(['d_r1', 'd_r2']);
    expect(txs.map((e) => e.link)).toEqual(['bss:d_r1/Wlan0', 'bss:d_r2/Wlan0']);
    expect(new Set(txs.map((e) => e.pdu.id)).size).toBe(2);
    const backoff = w.linksRng().split(`air:scan:${keyOf(LAP, 'Wlan0')}`).nextInt(0, RF.CW_MIN);
    const start = now + RF.DIFS_NS + backoff * RF.SLOT_NS;
    const rate = mcsRateBps(MCS_TABLES.n[0]!, 20, 1);
    expect(r).toMatchObject({ ok: true, txStart: start, txEnd: start + RF.OFDM_PREAMBLE_NS + serializationNs(probe.size, rate) });
    for (const tx of txs) expect(tx).toMatchObject({ medium: 'air', rateBps: rate, txStart: start });
    w.runFor(MS);
    expect(w.received.map((s) => [s.device, s.pdu.meta.parent]).sort()).toEqual([['d_r1', probe.id], ['d_r2', probe.id]]);
    expect(w.received[0]!.device).toBe('d_r2');
  });

  it('never reaches a radio on a band the station does not support', () => {
    const w = wifiWorld();
    w.addDevice(AP, 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan1', ['ssid', 'FIVE']]] });
    w.addDevice('d_iot', 'iot.nfsensor', { x: 40, y: 0 }, { daemons: false });
    w.boot();
    w.send('d_iot', 'Wlan0', w.pdus.build(probeRequestFrame(w.port('d_iot', 'Wlan0').mac, ''), meta));
    expect(w.ofKind('frameTx')).toHaveLength(0);
    expect(w.air.visibleBss(w.ref('d_iot', 'Wlan0'))).toEqual([]);
  });

  it('a directed frame to an unknown BSSID goes on the air but nobody hears it', () => {
    const w = pair();
    const mac = w.port(LAP, 'Wlan0').mac;
    const r = w.send(LAP, 'Wlan0', w.pdus.build(mgmtFrame('auth', { addr1: '02:99:99:99:99:99', addr2: mac, addr3: '02:99:99:99:99:99' }, { authAlgorithm: 0, authSeq: 1 }), meta));
    expect(r).toMatchObject({ ok: true });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'out-of-range', device: LAP, medium: 'air' });
    expect(w.ofKind('frameTx')).toHaveLength(0);
  });

  it('a background frame nobody hears is dropped out-of-range with background: true; a background data leg aborted by a withdrawn grant carries it too (P2 §2.7)', () => {
    const w = pair();
    const mac = w.port(LAP, 'Wlan0').mac;
    const beacon = w.pdus.build(mgmtFrame('auth', { addr1: '02:99:99:99:99:99', addr2: mac, addr3: '02:99:99:99:99:99' }, { authAlgorithm: 0, authSeq: 1 }), { ...meta, background: true });
    expect(w.send(LAP, 'Wlan0', beacon)).toMatchObject({ ok: true });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'out-of-range', device: LAP, medium: 'air', pdu: { id: beacon.id }, background: true });
    // the same drop without the flag for an ordinary frame
    const plain = w.pdus.build(mgmtFrame('auth', { addr1: '02:99:99:99:99:99', addr2: mac, addr3: '02:99:99:99:99:99' }, { authAlgorithm: 0, authSeq: 1 }), meta);
    w.send(LAP, 'Wlan0', plain);
    expect('background' in w.ofKind('drop').at(-1)!).toBe(false);

    grant(w, AP, LAP);
    const data = w.pdus.build(echoLayers(w.port(AP, 'GigabitEthernet1').mac, mac), { ...meta, background: true });
    expect(w.send(LAP, 'Wlan0', data)).toMatchObject({ ok: true });
    w.op(AP, 'Wlan0', { op: 'assoc', station: mac, state: 'none' });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'not-associated', pdu: { id: data.id }, background: true });
    expect(w.ofKind('frameAbort').at(-1)).toMatchObject({ reason: 'not-associated', pdu: { id: data.id } });
  });

  it('annotates the received signal on probe responses delivered to a station', () => {
    const w = pair();
    const ap = w.port(AP, 'Wlan0');
    const bssid = w.air.radioPortView(w.ref(AP, 'Wlan0'))!.bssid!;
    const resp = w.pdus.build(mgmtFrame('probe-resp', { addr1: w.port(LAP, 'Wlan0').mac, addr2: bssid, addr3: bssid }, { ssid: 'LAB', security: 'open', band: '2.4', channel: 1 }), meta);
    expect(w.send(AP, 'Wlan0', resp)).toMatchObject({ ok: true });
    expect(ap.operUp).toBe(true);
    w.runFor(MS);
    const got = w.received.find((s) => s.device === LAP)!;
    const visible = w.air.visibleBss(w.ref(LAP, 'Wlan0'));
    expect(visible).toHaveLength(1);
    expect(got.pdu.get('dot11-mgmt.rssiDbm')).toBe(visible[0]!.rssiDbm);
    expect(got.pdu.provenance.find((m) => m.cause === CAUSE_SIGNAL_ANNOTATION)).toMatchObject({ reason: 'Other', device: LAP, field: 'dot11-mgmt.rssiDbm' });
  });
});

describe('air medium: associations and data', () => {
  it('authorization brings the station up with reason associated and returns the OperChange', () => {
    const w = pair();
    const mac = w.port(LAP, 'Wlan0').mac;
    expect(w.op(AP, 'Wlan0', { op: 'assoc', station: mac, state: 'associated', aid: 1 })).toEqual([]);
    expect(w.port(LAP, 'Wlan0').operUp).toBe(false);
    const changes = w.op(AP, 'Wlan0', { op: 'authorize', station: mac });
    expect(changes).toEqual([{ port: { device: LAP, port: 'Wlan0' }, operUp: true }]);
    const port = w.port(LAP, 'Wlan0');
    expect(port.phy).toMatchObject({ carrier: true, lineProtocol: true });
    expect(w.ofKind('portState').at(-1)).toMatchObject({ device: LAP, operUp: true, reason: 'associated' });
    const assoc = w.air.associationOf(w.ref(LAP, 'Wlan0'))!;
    expect(assoc).toMatchObject({ id: `bss:${AP}/Wlan0|${keyOf(LAP, 'Wlan0')}`, tech: 'wifi', authorized: true, aid: 1, ssid: 'LAB', distanceM: 40, band: '2.4', channel: 1 });
    expect(port.speedBps).toBe(assoc.rateBps);
    expect(assoc.rateBps).toBe(laptopAssessment(160).rateBps);
    expect(w.ofKind('rfState')).toEqual([expect.objectContaining({ port: { device: LAP, port: 'Wlan0' }, rateBps: assoc.rateBps, bars: assoc.bars })]);
    expect(w.air.airView(LAP).link('Wlan0', assoc.bssid!)).toEqual({ rssiDbm: assoc.rssiDbm, snrDb: assoc.snrDb, rateBps: assoc.rateBps, bars: assoc.bars });
  });

  it('rewraps station data to 802.11 at the station and back to Ethernet at the AP with the air timing', () => {
    const w = pair();
    grant(w, AP, LAP);
    w.runFor(MS);
    const now = w.now();
    const assoc = w.air.associationOf(w.ref(LAP, 'Wlan0'))!;
    const lapMac = w.port(LAP, 'Wlan0').mac;
    const dst = w.port(AP, 'GigabitEthernet1').mac;
    const pdu = echo(w, dst, lapMac);
    const r = w.send(LAP, 'Wlan0', pdu);
    expect(pdu.layers[0]!.proto).toBe('dot11');
    const backoff = w.linksRng().split(`air:${assoc.medium}:${keyOf(LAP, 'Wlan0')}`).nextInt(0, RF.CW_MIN);
    const start = now + RF.DIFS_NS + backoff * RF.SLOT_NS;
    const end = start + RF.OFDM_PREAMBLE_NS + serializationNs(pdu.size, assoc.rateBps);
    const arrive = end + propagationNs(40, 1.0);
    expect(r).toEqual({ ok: true, link: assoc.medium, txStart: start, txEnd: end, arrive });
    const tx = w.ofKind('frameTx').at(-1)!;
    expect(tx).toMatchObject({ link: assoc.medium, from: { device: LAP, port: 'Wlan0' }, to: { device: AP, port: 'Wlan0' }, medium: 'air', rateBps: assoc.rateBps, rssiDbm: assoc.rssiDbm });
    expect(tx.attempt).toBeUndefined();
    w.runFor(MS);
    const got = w.delivered.find((s) => s.device === AP)!;
    expect(got.pdu.id).toBe(pdu.id);
    expect(got.at).toBe(arrive);
    expect(got.pdu.layers[0]!.fields).toMatchObject({ dst, src: lapMac, type: ETHERTYPE_IPV4 });
    expect(got.pdu.provenance.map((m) => [m.reason, m.field, m.device])).toEqual([
      ['Decapsulate', 'ethernet', LAP], ['Encapsulate', 'llc', LAP], ['Encapsulate', 'dot11', LAP],
      ['Decapsulate', 'dot11', AP], ['Decapsulate', 'llc', AP], ['Encapsulate', 'ethernet', AP],
    ]);
  });

  it('refuses AP unicast to unknown stations; group frames skip the source station and are cloned per receiver', () => {
    const w = wifiWorld();
    w.addDevice(AP, 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'LAB']]] });
    w.addDevice('d_l1', 'laptop.nflaptop', { x: 160, y: 0 }, { daemons: false });
    w.addDevice('d_l2', 'laptop.nflaptop', { x: 0, y: 160 }, { daemons: false });
    w.boot();
    grant(w, AP, 'd_l1', 1);
    grant(w, AP, 'd_l2', 2);
    const apMac = w.port(AP, 'GigabitEthernet1').mac;
    const l1 = w.port('d_l1', 'Wlan0').mac;

    expect(w.send(AP, 'Wlan0', echo(w, '02:77:77:77:77:77', apMac))).toEqual({ ok: false, reason: 'not-associated' });

    const echoOfL1 = echo(w, MAC_BROADCAST, l1);
    w.send(AP, 'Wlan0', echoOfL1);
    let txs = w.ofKind('frameTx');
    expect(txs.map((e) => e.to.device)).toEqual(['d_l2']);
    expect(txs[0]!.pdu.id).toBe(echoOfL1.id);

    const flood = echo(w, MAC_BROADCAST, apMac);
    w.send(AP, 'Wlan0', flood);
    txs = w.ofKind('frameTx').slice(1);
    expect(txs.map((e) => e.to.device)).toEqual(['d_l1', 'd_l2']);
    expect(txs.every((e) => e.pdu.parent === flood.id && e.pdu.id !== flood.id)).toBe(true);
    w.runFor(MS);
    const atStations = w.delivered.filter((s) => s.pdu.meta.parent === flood.id);
    expect(atStations.map((s) => s.device)).toEqual(['d_l1', 'd_l2']);
    for (const s of atStations) {
      expect(s.pdu.layers[0]!.fields).toMatchObject({ dst: MAC_BROADCAST, src: apMac });
      expect(s.pdu.provenance.slice(-3).map((m) => [m.reason, m.device])).toEqual([['Decapsulate', s.device], ['Decapsulate', s.device], ['Encapsulate', s.device]]);
    }
  });

  it('admit re-checks authorization, and withdrawing a grant aborts only the data legs of that station', () => {
    const w = pair();
    const lapMac = w.port(LAP, 'Wlan0').mac;
    const bssid = w.air.radioPortView(w.ref(AP, 'Wlan0'))!.bssid!;
    const forged = echo(w, w.port(AP, 'GigabitEthernet1').mac, lapMac);
    applyRewrap(forged, ethernetToDot11Op(forged, 'to-ds', bssid), LAP, 0, CAUSE_STATION_FRAMING, () => undefined);
    const verdict = w.air.admit({ kind: 'frameArrival', device: AP, port: 'Wlan0', pdu: forged, medium: `bss:${AP}/Wlan0`, rewrap: 'dot11-to-ethernet' }, w.now());
    expect(verdict).toEqual({ deliver: false });
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'not-associated', device: AP, port: 'Wlan0' });

    grant(w, AP, LAP);
    const data = echo(w, w.port(AP, 'GigabitEthernet1').mac, lapMac);
    w.send(LAP, 'Wlan0', data);
    const mgmt = w.pdus.build(mgmtFrame('deauth', { addr1: lapMac, addr2: bssid, addr3: bssid }, { reasonCode: 15 }), meta);
    w.send(AP, 'Wlan0', mgmt);
    const changes = w.op(AP, 'Wlan0', { op: 'assoc', station: lapMac, state: 'none' });
    expect(changes).toEqual([{ port: { device: LAP, port: 'Wlan0' }, operUp: false }]);
    expect(w.ofKind('frameAbort')).toEqual([expect.objectContaining({ reason: 'not-associated', from: { device: LAP, port: 'Wlan0' } })]);
    w.runFor(MS);
    expect(w.delivered).toHaveLength(0);
    expect(w.received.map((s) => s.pdu.id)).toEqual([mgmt.id]);
  });

  it('exhausts seven attempts with one backoff draw each when every attempt is lost', () => {
    const w = pair(1160);
    grant(w, AP, LAP);
    const now = w.now();
    const assoc = w.air.associationOf(w.ref(LAP, 'Wlan0'))!;
    expect(laptopAssessment(1160).mcs).toBeUndefined();
    expect(assoc.rateBps).toBe(0);
    const pdu = echo(w, w.port(AP, 'GigabitEthernet1').mac, w.port(LAP, 'Wlan0').mac);
    const r = w.send(LAP, 'Wlan0', pdu);
    expect(r).toMatchObject({ ok: true, lost: true, retries: RF.RETRY_LIMIT - 1 });
    expect(w.ofKind('frameTx')).toHaveLength(0);
    expect(w.ofKind('drop').at(-1)).toMatchObject({ reason: 'link-loss', detail: AIR_DETAILS.retriesExhausted, medium: assoc.medium });

    const rate = mcsRateBps(MCS_TABLES.n[0]!, 20, 1);
    const tx = w.linksRng().split(`air:${assoc.medium}:${keyOf(LAP, 'Wlan0')}`);
    const dur = RF.OFDM_PREAMBLE_NS + serializationNs(pdu.size, rate);
    const ack = RF.SIFS_NS + RF.OFDM_PREAMBLE_NS + serializationNs(RF.ACK_BYTES, rate);
    let base = now;
    let cw = RF.CW_MIN as number;
    let first = 0;
    for (let k = 1; k <= RF.RETRY_LIMIT; k++) {
      const start = base + RF.DIFS_NS + tx.nextInt(0, cw) * RF.SLOT_NS;
      if (k === 1) first = start;
      base = start + dur + ack;
      cw = Math.min(2 * cw + 1, RF.CW_MAX);
    }
    expect(r).toMatchObject({ txStart: first, txEnd: base - ack });
    const media = emptyMedia();
    w.air.contribute(w.now(), media);
    expect(media.bss[0]).toMatchObject({ id: assoc.medium, busyUntil: base });
  });

  it('reports successful retransmissions with attempt numbers and retries', () => {
    let units = 160;
    while (laptopAssessment(units).perPermille !== 100 || !laptopAssessment(units).canConnect) units++;
    const w = pair(units, 'LAB', 5);
    grant(w, AP, LAP);
    let retried = 0;
    for (let i = 0; i < 120; i++) {
      const before = w.ofKind('frameTx').length;
      const r = w.send(LAP, 'Wlan0', echo(w, w.port(AP, 'GigabitEthernet1').mac, w.port(LAP, 'Wlan0').mac));
      const tx = w.ofKind('frameTx').slice(before);
      if (r.ok && r.retries !== undefined && !r.lost) {
        retried++;
        expect(tx).toHaveLength(1);
        expect(tx[0]!.attempt).toBe(r.retries + 1);
      }
      w.runFor(10 * MS);
    }
    expect(retried).toBeGreaterThan(0);
  });
});

describe('air medium: mobility and RF hold', () => {
  it('emits rfState only on bars or rate changes and tears down after the hold below the drop threshold', () => {
    const w = pair();
    grant(w, AP, LAP);
    const rf0 = w.ofKind('rfState').length;
    w.move(LAP, { x: 161, y: 0 });
    expect(w.ofKind('rfState')).toHaveLength(rf0);
    w.move(LAP, { x: 1000, y: 0 });
    expect(w.ofKind('rfState')).toHaveLength(rf0 + 1);
    const holdUntil = w.now() + RF.RF_HOLD_NS;
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))).toMatchObject({ holdUntil });
    w.run(holdUntil - 1);
    expect(w.port(LAP, 'Wlan0').operUp).toBe(true);
    expect(w.notifications.some((n) => n.ev.kind === 'beacon-loss')).toBe(false);
    w.run(holdUntil);
    const bssid = w.air.radioPortView(w.ref(AP, 'Wlan0'))!.bssid!;
    const lapMac = w.port(LAP, 'Wlan0').mac;
    expect(w.notifications.slice(-2).map((n) => [n.ref.device, n.ev])).toEqual([
      [LAP, { kind: 'beacon-loss', bssid }],
      [AP, { kind: 'station-lost', station: lapMac, reason: 'out-of-range' }],
    ]);
    expect(w.port(LAP, 'Wlan0').operUp).toBe(false);
    expect(w.port(LAP, 'Wlan0').phy?.carrier).toBe(true);
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))).toBeUndefined();
  });

  it('moving back above the connect threshold cancels the hold', () => {
    const w = pair();
    grant(w, AP, LAP);
    w.move(LAP, { x: 1000, y: 0 });
    w.runFor(SEC);
    w.move(LAP, { x: 160, y: 0 });
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))!.holdUntil).toBeUndefined();
    w.runFor(3 * SEC);
    expect(w.notifications.some((n) => n.ev.kind === 'beacon-loss')).toBe(false);
    expect(w.port(LAP, 'Wlan0').operUp).toBe(true);
  });

  it('does not start a hold between the drop and connect thresholds (no flapping)', () => {
    let units = 160;
    while (!(laptopAssessment(units).rssiMdb < RF.WIFI_CONNECT_RSSI_MDB && laptopAssessment(units).rssiMdb > RF.WIFI_DROP_RSSI_MDB + 1000)) units++;
    const w = pair();
    grant(w, AP, LAP);
    for (let i = 0; i < 6; i++) {
      w.move(LAP, { x: i % 2 === 0 ? units : units + 4, y: 0 });
      expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))!.holdUntil).toBeUndefined();
      w.runFor(500 * MS);
    }
    w.runFor(5 * SEC);
    expect(w.port(LAP, 'Wlan0').operUp).toBe(true);
  });

  it('keeps the MCS until the SINR clears the next threshold by the upgrade margin (hysteresis)', () => {
    let far = 700;
    while (laptopAssessment(far).mcs === undefined || laptopAssessment(far - 1).mcs?.mcs === laptopAssessment(far).mcs?.mcs) far--;
    const low = laptopAssessment(far).mcs!.mcs;
    let near = far - 1;
    while (laptopAssessment(near, low).mcs?.mcs === low && near > 10) near--;
    const w = pair(far);
    grant(w, AP, LAP);
    const rate0 = w.air.associationOf(w.ref(LAP, 'Wlan0'))!.rateBps;
    w.move(LAP, { x: far - 1, y: 0 });
    expect(laptopAssessment(far - 1).mcs!.mcs).toBeGreaterThan(low);
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))!.rateBps).toBe(rate0);
    w.move(LAP, { x: near, y: 0 });
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))!.rateBps).toBeGreaterThan(rate0);
    w.move(LAP, { x: far + 1, y: 0 });
    expect(w.air.associationOf(w.ref(LAP, 'Wlan0'))!.rateBps).toBeLessThanOrEqual(laptopAssessment(far + 1).rateBps);
  });

  it('tells a scanning station once when a matching BSS crosses the connect threshold', () => {
    const w = pair(2000);
    w.op(LAP, 'Wlan0', { op: 'sta-state', state: 'scanning', ssid: 'LAB' });
    const bssid = w.air.radioPortView(w.ref(AP, 'Wlan0'))!.bssid!;
    expect(w.ofKind('assocState')).toEqual([expect.objectContaining({ station: { device: LAP, port: 'Wlan0' }, state: 'scanning', prev: 'idle' })]);
    w.move(LAP, { x: 1200, y: 0 });
    expect(w.notifications.filter((n) => n.ev.kind === 'bss-in-range')).toHaveLength(0);
    w.move(LAP, { x: 160, y: 0 });
    w.move(LAP, { x: 161, y: 0 });
    expect(w.notifications.filter((n) => n.ev.kind === 'bss-in-range')).toEqual([{ ref: { device: LAP, port: 'Wlan0' }, ev: { kind: 'bss-in-range', bssid }, at: w.now() }]);
  });

  it('tears associations down with bss-down when the access radio goes down, and station-lost when a station powers off', () => {
    const w = wifiWorld();
    w.addDevice(AP, 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'LAB']]] });
    w.addDevice('d_l1', 'laptop.nflaptop', { x: 160, y: 0 }, { daemons: false });
    w.addDevice('d_l2', 'laptop.nflaptop', { x: 0, y: 160 }, { daemons: false });
    w.boot();
    grant(w, AP, 'd_l1', 1);
    grant(w, AP, 'd_l2', 2);
    w.powerOff('d_l2');
    expect(w.notifications.at(-1)).toMatchObject({ ref: { device: AP }, ev: { kind: 'station-lost', station: w.port('d_l2', 'Wlan0').mac, reason: 'power-off' } });
    expect(w.port('d_l2', 'Wlan0').phy?.carrier).toBe(false);
    const bssid = w.air.radioPortView(w.ref(AP, 'Wlan0'))!.bssid!;
    w.setAdmin(AP, 'Wlan0', false);
    expect(w.notifications.filter((n) => n.ev.kind === 'bss-down')).toEqual([expect.objectContaining({ ref: { device: 'd_l1', port: 'Wlan0' }, ev: { kind: 'bss-down', bssid } })]);
    expect(w.port('d_l1', 'Wlan0').operUp).toBe(false);
    expect(w.port('d_l1', 'Wlan0').phy?.carrier).toBe(true);
    expect(w.port(AP, 'Wlan0').operUp).toBe(false);
  });

  it('forgetting an access point notifies its stations and drops its BSS from snapshots', () => {
    const w = pair();
    grant(w, AP, LAP);
    const changes = w.air.forgetDevice(AP, w.now());
    expect(changes).toEqual([{ port: { device: LAP, port: 'Wlan0' }, operUp: false }]);
    const media = emptyMedia();
    w.air.contribute(w.now(), media);
    expect(media.bss).toEqual([]);
    expect(w.air.radios().map((r) => r.device)).toEqual([LAP]);
  });
});

describe('air medium: views, contention and determinism', () => {
  it('lists visible BSSs by RSSI then BSSID and marks which can be joined', () => {
    let weak = 160;
    while (!(laptopAssessment(weak).rssiMdb < RF.WIFI_CONNECT_RSSI_MDB && laptopAssessment(weak).rssiMdb >= RF.WIFI_DROP_RSSI_MDB)) weak++;
    const w = wifiWorld();
    w.addDevice('d_near', 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'NEAR']], ['Wlan0', ['security', 'wpa2-psk']]] });
    w.addDevice('d_weak', 'wrouter.nfhome', { x: 160 + weak, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'WEAK']], ['Wlan0', ['channel', '11']]] });
    w.addDevice(LAP, 'laptop.nflaptop', { x: 160, y: 0 }, { daemons: false });
    w.boot();
    const list = w.air.visibleBss(w.ref(LAP, 'Wlan0'));
    expect(list.map((b) => [b.ssid, b.security, b.channel, b.canAssociate])).toEqual([
      ['NEAR', 'wpa2-psk', 1, true],
      ['WEAK', 'open', 11, false],
    ]);
    expect(list[0]!.rssiDbm).toBeGreaterThan(list[1]!.rssiDbm);
    expect(w.air.airView(LAP).visibleBss('Wlan0')).toEqual(list);
  });

  it('co-channel BSSs in carrier-sense range share airtime; snapshots are clone-safe and never carry passphrases', () => {
    const w = wifiWorld();
    w.addDevice('d_a', 'wrouter.nfhome', { x: 0, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'A']], ['Wlan0', ['security', 'wpa2-psk']], ['Wlan0', ['passphrase', 'hunter22-secret']]] });
    w.addDevice('d_b', 'wrouter.nfhome', { x: 40, y: 0 }, { daemons: false, lines: [['Wlan0', ['ssid', 'B']]] });
    w.addDevice('d_c', 'wrouter.nfhome', { x: 40, y: 40 }, { daemons: false, lines: [['Wlan0', ['ssid', 'C']], ['Wlan0', ['channel', '11']]] });
    w.addDevice(LAP, 'laptop.nflaptop', { x: 160, y: 0 }, { daemons: false });
    w.boot();
    grant(w, 'd_a', LAP);
    const media = emptyMedia();
    w.air.contribute(w.now(), media);
    expect(media.bss.map((b) => [b.id, b.contention, b.loaded])).toEqual([
      ['bss:d_a/Wlan0', ['bss:d_b/Wlan0'], true],
      ['bss:d_b/Wlan0', ['bss:d_a/Wlan0'], false],
      ['bss:d_c/Wlan0', [], false],
    ]);
    expect(media.associations).toHaveLength(1);
    expect(structuredClone(media)).toEqual(media);
    const view = w.air.radioPortView(w.ref(LAP, 'Wlan0'))!;
    expect(view).toMatchObject({ mode: 'station', state: 'idle', peer: { device: 'd_a', port: 'Wlan0' }, security: 'wpa2-psk' });
    expect(JSON.stringify([media, view, w.air.radioPortView(w.ref('d_a', 'Wlan0'))]).includes('hunter22')).toBe(false);

    const sent = w.send('d_a', 'Wlan0', echo(w, w.port(LAP, 'Wlan0').mac, w.port('d_a', 'GigabitEthernet1').mac));
    const again = w.send('d_b', 'Wlan0', w.pdus.build(mgmtFrame('beacon', { addr1: MAC_BROADCAST, addr2: '02:00:00:00:00:0b', addr3: '02:00:00:00:00:0b' }, { ssid: 'B' }), meta));
    expect(sent.ok && again.ok).toBe(true);
    if (sent.ok && again.ok) expect(again.txStart).toBeGreaterThan(sent.txEnd + RF.SIFS_NS);
  });

  it('gives byte-identical traces for the same scenario', () => {
    const scenario = (): string => {
      const w = pair(400, 'LAB', 99);
      grant(w, AP, LAP);
      for (let i = 0; i < 10; i++) {
        w.send(LAP, 'Wlan0', echo(w, MAC_BROADCAST, w.port(LAP, 'Wlan0').mac));
        w.send(AP, 'Wlan0', echo(w, w.port(LAP, 'Wlan0').mac, w.port(AP, 'GigabitEthernet1').mac));
        w.move(LAP, { x: 400 + i * 60, y: 0 });
        w.runFor(300 * MS);
      }
      w.runFor(3 * SEC);
      return JSON.stringify([w.events, w.notifications.map((n) => [n.ref, n.ev, n.at])]);
    };
    expect(scenario()).toBe(scenario());
  });
});
