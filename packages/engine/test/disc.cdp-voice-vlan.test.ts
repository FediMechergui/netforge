/**
 * disc.cdp-voice-vlan — [S35] the discovery daemon parts of the voice VLAN (ARCHITECTURE-P3C D9, §3.9, §7 W1b disc;
 * ruling RC2 (d)):
 *  - a switch adds `voiceVlan` (NF TLV 9) to its CDP only on a port with `switchport voice vlan` (staged.world, P3);
 *  - the phone (`voice-endpoint`) runs CDP and LLDP answer-driven on its uplink only: silent until it hears a
 *    neighbour there, then it answers at once (`H P`; LLDP with the telephone bit and the MED capability TLV) and every
 *    timer; a newly learned voice VLAN restarts its DHCP unless `voice vlan` is typed; a link-down puts it back to sleep;
 *  - a switch sends the LLDP-MED Network Policy only to a neighbour that advertised MED, and at once when one appears.
 *
 * The phone side runs against a fake phone uplink (the real daemons on the fake context of `disc.fake-ctx.ts`): the
 * phone's transparent path does not hand CDP or LLDP to its daemons before the W2b l2 item, and NF-IPPHONE derives the
 * daemons only at the W4b flip.
 */
import { describe, expect, it } from 'vitest';
import type { Capability } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow, LldpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { NF_IPPHONE_MODEL_INPUT } from '../src/device/catalog/voice.js';
import { LLDP_CAPABILITY, LLDP_MED_CAPABILITY, LLDP_MED_DEVICE } from '../src/pdu/codecs/lldp.js';
import {
  CDP_TX_TIMER,
  cdpCapabilitiesOf,
  cdpFrameSpecs,
  cdpPortOffDetail,
  createCdp,
  discoveryAnswerOnly,
  phoneLearnedVoiceVlan,
  type CdpAdvertisement,
} from '../src/protocols/cdp.js';
import { LLDP_PHONE_MED_CAPABILITIES, LLDP_TX_TIMER, createLldp, lldpCapabilityBits, lldpFrameSpecs, type LldpAdvertisement } from '../src/protocols/lldp.js';
import { fakeDevice, requestsOf, sentLayers, timersOf, type FakeDevice } from './disc.fake-ctx.js';
import { createStagedSimulation } from './staged.world.js';

const UPLINK = 'FastEthernet0';
const PASS = 'FastEthernet1';
const PHONE_CAPS: readonly Capability[] = [...NF_IPPHONE_MODEL_INPUT.capabilities, 'voice-endpoint'];

/** The fake phone: network port (uplink group), pass-through port, Vlan1 adapter. */
function phone(): FakeDevice {
  return fakeDevice({
    model: 'NF-IPPHONE', hostname: 'PHONE1', capabilities: PHONE_CAPS,
    ports: [
      { id: UPLINK, role: 'switched', group: 'uplink' },
      { id: PASS, role: 'switched' },
      { id: 'Vlan1', kind: 'virtual', role: 'svi', ipv4: '10.0.30.5' },
    ],
  });
}

const swCdp = (over: Partial<CdpAdvertisement> = {}): CdpAdvertisement => ({
  version: 2, ttl: 180, deviceId: 'SW1', portId: 'FastEthernet0/2', capabilities: 'S I', platform: 'NF-C2960', software: 'x', duplex: 'full', voiceVlan: 30, ...over,
});
const swLldp = (over: Partial<LldpAdvertisement> = {}): LldpAdvertisement => ({
  chassisId: '02:00:00:00:bb:01', portId: 'FastEthernet0/2', ttl: 120, systemName: 'SW1', systemDescription: 'x',
  capabilities: LLDP_CAPABILITY.bridge, enabledCapabilities: LLDP_CAPABILITY.bridge, medVlan: 30, ...over,
});

const RESTART = { type: 'request', to: 'dhcp-client', req: { kind: 'dhcp.restart', iface: 'Vlan1' } };

describe('[S35] capabilities and the answer-only mode', () => {
  it('a voice-endpoint model is answer-only, advertises H P and the IEEE telephone bit', () => {
    expect(discoveryAnswerOnly({ capabilities: PHONE_CAPS })).toBe(true);
    expect(discoveryAnswerOnly({ capabilities: NF_IPPHONE_MODEL_INPUT.capabilities })).toBe(false);
    expect(cdpCapabilitiesOf({ capabilities: PHONE_CAPS })).toBe('H P');
    expect(cdpCapabilitiesOf({ capabilities: NF_IPPHONE_MODEL_INPUT.capabilities })).toBe('S'); // unchanged before the flip
    expect(lldpCapabilityBits({ capabilities: PHONE_CAPS })).toBe(LLDP_CAPABILITY.bridge | LLDP_CAPABILITY.telephone);
    expect(LLDP_PHONE_MED_CAPABILITIES).toBe(LLDP_MED_CAPABILITY.capabilities | LLDP_MED_CAPABILITY.networkPolicy);
  });
});

describe('[S35] the phone\'s CDP against a fake uplink', () => {
  it('silent at boot, at link-up and at a timer until it hears CDP; any profile', () => {
    for (const profile of ['P1', 'P2', 'P3'] as const) {
      const dev = fakeDevice({ model: 'NF-IPPHONE', capabilities: PHONE_CAPS, profile, ports: [{ id: UPLINK, role: 'switched', group: 'uplink' }, { id: PASS, role: 'switched' }] });
      const cdp = createCdp();
      expect(cdp.init!(dev.ctx())).toEqual([]);
      expect(cdp.onLinkChange!(dev.ctx(), UPLINK, true)).toEqual([]);
      expect(cdp.onTimer!(dev.ctx(), CDP_TX_TIMER)).toEqual([]);
      expect(cdp.stateSnapshot().state).toMatchObject({ running: true, awake: false, sent: 0 });
    }
  });

  it('listens on the uplink only: a frame on the pass-through port drops not-for-me', () => {
    const dev = phone();
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    const out = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp())), PASS);
    expect(out).toMatchObject([{ type: 'drop', reason: 'not-for-me', detail: cdpPortOffDetail(PASS) }]);
    expect(dev.table<CdpNeighbourRow>('cdp-neighbours').rows()).toEqual([]);
  });

  it('the first frame heard wakes it: one H P answer on the uplink at once, the 60 s timer, the row with voiceVlan, a DHCP restart', () => {
    const dev = phone();
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    dev.now = 40 * SEC;
    const out = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp())), UPLINK);
    expect(out[0]).toMatchObject({ type: 'consume' });
    const sent = sentLayers(out, 'cdp');
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(UPLINK);
    expect(sent[0]![1]).toMatchObject({ deviceId: 'PHONE1', portId: UPLINK, capabilities: 'H P', platform: 'NF-IPPHONE', addresses: '10.0.30.5' });
    expect(sent[0]![1].voiceVlan).toBeUndefined();
    expect(sent[0]![1].nativeVlan).toBeUndefined();
    expect(timersOf(out)).toContainEqual([CDP_TX_TIMER, 60 * SEC]);
    expect(requestsOf(out)).toEqual([RESTART]);
    expect(dev.table<CdpNeighbourRow>('cdp-neighbours').rows().map((r) => [r.localPort, r.deviceId, r.voiceVlan])).toEqual([[UPLINK, 'SW1', 30]]);
    expect(phoneLearnedVoiceVlan(dev.ctx())).toBe(30);
    expect(cdp.stateSnapshot().state).toMatchObject({ awake: true, sent: 1, received: 1 });

    // a refresh with the same VLAN: no answer, no restart
    dev.now = 100 * SEC;
    const again = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp())), UPLINK);
    expect(sentLayers(again, 'cdp')).toEqual([]);
    expect(requestsOf(again)).toEqual([]);
    // the periodic frame goes out on the uplink only
    const tick = cdp.onTimer!(dev.ctx(), CDP_TX_TIMER);
    expect(sentLayers(tick, 'cdp').map(([p]) => p)).toEqual([UPLINK]);
    // a new VLAN: restart again
    const moved = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp({ voiceVlan: 40 }))), UPLINK);
    expect(requestsOf(moved)).toEqual([RESTART]);
  });

  it('a typed `voice vlan` wins: a learned VLAN restarts nothing', () => {
    const dev = phone();
    dev.config.apply([], ['voice', 'vlan', '30'], false);
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    const out = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp({ voiceVlan: 50 }))), UPLINK);
    expect(sentLayers(out, 'cdp')).toHaveLength(1); // it still answers
    expect(requestsOf(out)).toEqual([]);
  });

  it('a neighbour with no voice VLAN: an answer, no restart', () => {
    const dev = phone();
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    const out = cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp({ voiceVlan: undefined }))), UPLINK);
    expect(sentLayers(out, 'cdp')).toHaveLength(1);
    expect(requestsOf(out)).toEqual([]);
  });

  it('a link-down of the uplink puts it back to sleep: rows gone, timer cancelled, silent at the next link-up', () => {
    const dev = phone();
    const cdp = createCdp();
    cdp.init!(dev.ctx());
    cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp())), UPLINK);
    dev.setUp(UPLINK, false);
    const down = cdp.onLinkChange!(dev.ctx(), UPLINK, false);
    expect(down).toContainEqual({ type: 'cancelTimer', key: CDP_TX_TIMER });
    expect(dev.table<CdpNeighbourRow>('cdp-neighbours').rows()).toEqual([]);
    expect(cdp.stateSnapshot().state).toMatchObject({ awake: false });
    dev.setUp(UPLINK, true);
    expect(cdp.onLinkChange!(dev.ctx(), UPLINK, true)).toEqual([]);
    expect(cdp.onTimer!(dev.ctx(), CDP_TX_TIMER)).toEqual([]);
  });
});

describe('[S35] the phone\'s LLDP-MED against a fake uplink', () => {
  it('silent until it hears LLDP (no `lldp run` needed); then an answer with the telephone bit and MED class III; medVlan restarts DHCP', () => {
    const dev = phone();
    const lldp = createLldp();
    expect(lldp.init!(dev.ctx())).toEqual([]);
    expect(lldp.onLinkChange!(dev.ctx(), UPLINK, true)).toEqual([]);
    const out = lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:bb:01', swLldp())), UPLINK);
    const sent = sentLayers(out, 'lldp');
    expect(sent.map(([p]) => p)).toEqual([UPLINK]);
    expect(sent[0]![1]).toMatchObject({
      systemName: 'PHONE1', capabilities: LLDP_CAPABILITY.bridge | LLDP_CAPABILITY.telephone,
      medCapabilities: LLDP_PHONE_MED_CAPABILITIES, medDeviceType: LLDP_MED_DEVICE.endpointClass3,
    });
    expect(sent[0]![1].medVlan).toBeUndefined();
    expect(timersOf(out)).toContainEqual([LLDP_TX_TIMER, 30 * SEC]);
    expect(requestsOf(out)).toEqual([RESTART]);
    expect(dev.table<LldpNeighbourRow>('lldp-neighbours').rows().map((r) => [r.localPort, r.medVlan])).toEqual([[UPLINK, 30]]);
    expect(lldp.stateSnapshot().state).toMatchObject({ awake: true });
  });

  it('CDP and LLDP-MED giving the same VLAN restart DHCP once', () => {
    const dev = phone();
    const cdp = createCdp();
    const lldp = createLldp();
    cdp.init!(dev.ctx());
    lldp.init!(dev.ctx());
    expect(requestsOf(cdp.onPdu!(dev.ctx(), dev.frame(cdpFrameSpecs('02:00:00:00:bb:01', swCdp())), UPLINK))).toEqual([RESTART]);
    expect(requestsOf(lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:bb:01', swLldp())), UPLINK))).toEqual([]);
  });
});

describe('[S35] the switch\'s LLDP-MED network policy', () => {
  function sw(): FakeDevice {
    const dev = fakeDevice({
      model: 'NF-C2960', hostname: 'SW1', capabilities: ['switching', 'managed-switch'],
      ports: [{ id: 'FastEthernet0/2', role: 'switched' }, { id: 'FastEthernet0/3', role: 'switched' }],
    });
    dev.config.apply([], ['lldp', 'run'], false);
    dev.config.apply([['interface', 'FastEthernet0/2']], ['switchport', 'access', 'vlan', '10'], false);
    dev.config.apply([['interface', 'FastEthernet0/2']], ['switchport', 'voice', 'vlan', '30'], false);
    return dev;
  }
  const phoneAdv = (over: Partial<LldpAdvertisement> = {}): LldpAdvertisement => ({
    chassisId: '02:00:00:00:cc:01', portId: UPLINK, ttl: 120, systemName: 'PHONE1', systemDescription: 'x',
    capabilities: LLDP_CAPABILITY.telephone, enabledCapabilities: LLDP_CAPABILITY.telephone, medCapabilities: LLDP_PHONE_MED_CAPABILITIES, ...over,
  });

  it('no policy before a MED neighbour; the first MED neighbour on the voice port gets it at once; never on a port without a voice VLAN', () => {
    const dev = sw();
    const lldp = createLldp();
    const boot = sentLayers(lldp.init!(dev.ctx()), 'lldp');
    expect(boot.map(([p]) => p)).toEqual(['FastEthernet0/2', 'FastEthernet0/3']);
    expect(boot.every(([, f]) => f.medVlan === undefined && f.medCapabilities === undefined)).toBe(true);
    // a MED neighbour without a voice VLAN on its port: no policy
    expect(sentLayers(lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:cc:02', phoneAdv({ chassisId: '02:00:00:00:cc:02' }))), 'FastEthernet0/3'), 'lldp')).toEqual([]);
    // the voice port: an immediate frame with the policy
    const first = sentLayers(lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:cc:01', phoneAdv())), 'FastEthernet0/2'), 'lldp');
    expect(first.map(([p, f]) => [p, f.medVlan])).toEqual([['FastEthernet0/2', 30]]);
    // a refresh: no extra frame
    expect(sentLayers(lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:cc:01', phoneAdv())), 'FastEthernet0/2'), 'lldp')).toEqual([]);
    // the periodic frames: the policy on the voice port only
    const tick = sentLayers(lldp.onTimer!(dev.ctx(), LLDP_TX_TIMER), 'lldp');
    expect(tick.map(([p, f]) => [p, f.medVlan])).toEqual([['FastEthernet0/2', 30], ['FastEthernet0/3', undefined]]);
    expect(tick.every(([, f]) => f.medCapabilities === undefined)).toBe(true);
  });

  it('a neighbour that does not speak MED gets no policy', () => {
    const dev = sw();
    const lldp = createLldp();
    lldp.init!(dev.ctx());
    expect(sentLayers(lldp.onPdu!(dev.ctx(), dev.frame(lldpFrameSpecs('02:00:00:00:cc:01', phoneAdv({ medCapabilities: undefined }))), 'FastEthernet0/2'), 'lldp')).toEqual([]);
    expect(sentLayers(lldp.onTimer!(dev.ctx(), LLDP_TX_TIMER), 'lldp').map(([, f]) => f.medVlan)).toEqual([undefined, undefined]);
  });
});

describe('[S35] the switch\'s CDP TLV 9 on staged.world (P3 world)', () => {
  type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
  function world(): Simulation {
    const sim = createStagedSimulation({ seed: 35, stage: 'P3', factories: { cdp: createCdp } });
    const cfg = [
      'hostname SW1', '!', 'vlan 10', '!', 'vlan 30', '!',
      'interface FastEthernet0/2', ' switchport mode access', ' switchport access vlan 10', ' switchport voice vlan 30', '!',
      'interface FastEthernet0/3', ' switchport mode access', ' switchport access vlan 10', '!',
      'interface GigabitEthernet0/1', ' switchport mode access', ' switchport voice vlan 30', '!', 'end', '',
    ].join('\n');
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: cfg });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: 'hostname SW2\n!\nend\n' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: 'hostname PC1\n!\nend\n' });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: 'hostname PC2\n!\nend\n' });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
    return sim;
  }

  it('voiceVlan 30 only on the ports with a voice VLAN; the neighbour row records it', () => {
    const sim = world();
    sim.runFor(100 * SEC);
    const frames = sim.trace(0).events
      .filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'cdp' && e.device === 'sw1')
      .map((e) => sim.pdu(e.pdu.id)!.layers[2]!.fields);
    const byPort = new Map<string, unknown[]>();
    for (const f of frames) byPort.set(f.portId as string, [...(byPort.get(f.portId as string) ?? []), f.voiceVlan]);
    expect(byPort.get('FastEthernet0/2')!.length).toBeGreaterThan(0);
    expect(byPort.get('FastEthernet0/2')!.every((v) => v === 30)).toBe(true);
    expect(byPort.get('GigabitEthernet0/1')!.every((v) => v === 30)).toBe(true);
    expect(byPort.get('FastEthernet0/3')!.every((v) => v === undefined)).toBe(true);
    const sw2 = sim.device('sw2')!.tables.get<CdpNeighbourRow>('cdp-neighbours')!.rows();
    expect(sw2.map((r) => [r.deviceId, r.voiceVlan])).toEqual([['SW1', 30]]);
    const sw1 = sim.device('sw1')!.tables.get<CdpNeighbourRow>('cdp-neighbours')!.rows();
    expect(sw1.map((r) => [r.deviceId, r.voiceVlan])).toEqual([['SW2', undefined]]);
  });
});
