/**
 * device.pipeline.ppp — [S19] PPP framing and the receive gate in the frame pipeline, and the encapsulation refusal
 * removed from the runtime (ARCHITECTURE-P3 D17, §3.9, ruling R4, §9.2 item 30; §7 W2 device, approved items).
 *
 *  - `FramingProto` 'ppp': a `ppp` port accepts exactly the PPP framing (`ENCAP_ALLOWS`), whose rules are RFC 1662
 *    without flags — `PPP_HEADER` + `PPP_FCS` bytes around the payload, an FCS check, no destination MAC (so no MAC
 *    filter and no group counting), the demux key `ppp.protocol` on the demux layer 'ppp';
 *  - the step-4 receive gate's PPP branch: a PPP control frame (LCP, PAP, CHAP, IPCP, IPv6CP) is still received on a
 *    `ppp` port with carrier whose line protocol is down only by PPP; data (IPv4, IPv6) is not; an HDLC port never
 *    takes the branch; the HDLC keepalive branch is unchanged;
 *  - the runtime: `encapsulation ppp` is accepted on a router's serial WAN port (the effective encapsulation becomes
 *    'ppp', the link model is told) and refused on a serial access line; a PPP frame arriving on the port reaches the
 *    process whose 'ppp' selector matches its protocol, also while the line is still negotiating.
 * The daemons are recording fakes (the real ppp daemon and ipv4's 'ppp' selector are other W2/W3 items).
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import { FRAME_ROLES, L3_ROLES, macFilterApplies, type FramingProto } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { HDLC_PROTO_IPV4, HDLC_PROTO_KEEPALIVE, PPP_FCS, PPP_HEADER, PPP_PROTO, type LayerSpec, type Pdu } from '../src/contracts/pdu.js';
import type { PortPhy } from '../src/contracts/link.js';
import type { PortSpec, PortState } from '../src/contracts/port.js';
import type { DemuxSelector } from '../src/contracts/process.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { defineModel } from '../src/device/catalog/define.js';
import { DEVICE_CONFIG_MESSAGES } from '../src/device/device.js';
import { createPortState } from '../src/device/ports.js';
import {
  DEMUX_LAYERS,
  ENCAP_ALLOWS,
  FRAMING_PROTOS,
  FRAMING_RULES,
  buildDemuxIndex,
  checkEncap,
  frameArrivalVerdict,
  isDemuxLayer,
  isFramingProto,
  loopIngressLayer,
  portReceiveUp,
  validateFraming,
  type DemuxIndex,
  type FrameArrivalInput,
} from '../src/device/pipeline.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { NF_2911_INPUT } from './device.catalog.p0-inputs.js';
import { boot, fakeProcess, harness } from './device.harness.js';

const BASE = deviceMacBase('d_ppp');
const router = defineModel(NF_2911_INPUT, 'P2');
const pdus = createPduFactory();
const build = (layers: readonly LayerSpec[]): Pdu => pdus.build(layers, { born: 0, origin: 'd_peer' });

const ppp = (inner: LayerSpec): LayerSpec[] => [{ proto: 'ppp', fields: {} }, inner];
const LCP = ppp({ proto: 'lcp', fields: { code: 1, id: 1, authProto: 'chap-md5', magic: 0x1a2b3c4d } });
const PAP = ppp({ proto: 'pap', fields: { code: 1, id: 1, peerId: 'R1', password: 'NetF0rge' } });
const CHAP = ppp({ proto: 'chap', fields: { code: 1, id: 1, value: new Uint8Array(16).fill(7), name: 'R1' } });
const IPCP = ppp({ proto: 'ipcp', fields: { code: 1, id: 1, ipAddress: '10.1.1.1' } });
const IPV6CP = ppp({ proto: 'ipv6cp', fields: { code: 1, id: 1 } });
const IPV4: LayerSpec[] = [
  { proto: 'ppp', fields: {} },
  { proto: 'ipv4', fields: { src: '10.1.1.1', dst: '10.1.1.2', ttl: 255, protocol: 1 } },
  { proto: 'icmpv4', fields: { type: 8, code: 0, id: 7, seq: 1 } },
];
const HDLC_KEEPALIVE: LayerSpec[] = [{ proto: 'hdlc', fields: { address: 0x8f, control: 0, protocol: HDLC_PROTO_KEEPALIVE } }, { proto: 'payload', fields: { data: new Uint8Array(14) } }];

/** A live serial port of the NF-2911 with encapsulation `encap` and the given line state. */
function serialPort(encap: 'ppp' | 'hdlc', operUp: boolean, phy?: PortPhy): PortState {
  const i = router.ports.findIndex((p) => p.name === 'Serial0/0/0');
  const port = createPortState(router.ports[i] as PortSpec, i + 1, { macBase: BASE, capabilities: router.capabilities, portsDefaultUp: true });
  port.adminUp = true;
  port.operUp = operUp;
  port.encap = encap;
  if (phy !== undefined) port.phy = phy;
  return port;
}

const negotiating = (reason = 'ppp-negotiating', carrier = true): PortPhy => ({ carrier, lineProtocol: false, lineProtocolReason: reason });

function indexOf(entries: [ProcessName, DemuxSelector[]][]): DemuxIndex {
  return buildDemuxIndex(entries.map((e) => e[0]), new Map(entries.map(([name, handles]) => [name, { handles }])));
}
/** The selectors the [S19] items will declare: ppp takes its control protocols (key-less), ipv4 takes 0x0021. */
const PPP_INDEX = indexOf([
  ['ppp', [{ layer: 'ppp', roles: ['wan'] }]],
  ['ipv4', [{ layer: 'ppp', ethertype: PPP_PROTO.ipv4, roles: ['wan'] }]],
]);

function arrive(port: PortState, layers: readonly LayerSpec[], over: Partial<FrameArrivalInput> = {}) {
  return frameArrivalVerdict({ port, frame: build(layers), booted: true, index: PPP_INDEX, groupFilter: true, ...over });
}

describe('[S19] PPP framing (ruling R4): FramingProto ppp, its rules, its demux layer', () => {
  it('ppp is an outer framing and a demux layer, appended to the declared orders', () => {
    expect(FRAMING_PROTOS).toEqual(['ethernet', 'hdlc', 'dot11', 'ppp']);
    expect(DEMUX_LAYERS).toEqual(['ethernet', 'hdlc', 'dot11', 'ipv4', 'ipv6', 'ppp']);
    expect(isFramingProto('ppp')).toBe(true);
    expect(isDemuxLayer('ppp')).toBe(true);
    expect(loopIngressLayer(build(LCP))).toBe('ppp');
  });

  it('a ppp port carries exactly the PPP framing; other ports refuse it', () => {
    expect(ENCAP_ALLOWS.ppp).toEqual(['ppp']);
    expect(checkEncap('ppp', 'ppp')).toEqual({ ok: true, outer: 'ppp' });
    expect(checkEncap('ppp', 'hdlc')).toEqual({ ok: false, detail: 'no-ppp-layer' });
    expect(checkEncap('hdlc', 'ppp')).toEqual({ ok: false, detail: 'no-hdlc-layer' });
    expect(checkEncap('ethernet', 'ppp')).toEqual({ ok: false, detail: 'no-ethernet-layer' });
    expect(arrive(serialPort('hdlc', true), LCP)).toEqual({ kind: 'drop', reason: 'other', detail: 'no-hdlc-layer', counters: ['inDrops'] });
    expect(arrive(serialPort('ppp', true), HDLC_KEEPALIVE)).toEqual({ kind: 'drop', reason: 'other', detail: 'no-ppp-layer', counters: ['inDrops'] });
  });

  it('size: PPP_HEADER + PPP_FCS around an MTU-sized payload; a longer frame is a giant; a bad FCS is an fcs-error', () => {
    expect(PPP_HEADER + PPP_FCS).toBe(6);
    expect(FRAMING_RULES.ppp.minBytes).toBe(0);
    expect(FRAMING_RULES.ppp.maxBytes(1500)).toBe(1506);
    const f = build(IPV4);
    expect(validateFraming('ppp', f, false, 1500)).toBeUndefined();
    const big = { ...f, size: 1507, layers: f.layers, layer: f.layer.bind(f) };
    expect(validateFraming('ppp', big, false, 1500)).toEqual({ kind: 'drop', reason: 'giant', detail: '1507 bytes', counters: ['giants', 'inErrors'] });
    expect(validateFraming('ppp', f, true, 1500)).toEqual({ kind: 'drop', reason: 'fcs-error', counters: ['crcErrors', 'inErrors'] });
  });

  it('no destination MAC: the MAC filter never applies to PPP (as for HDLC); the demux key is ppp.protocol', () => {
    for (const role of L3_ROLES) {
      expect(macFilterApplies(role, 'ppp', false)).toBe(false);
      expect(macFilterApplies(role, 'hdlc', false)).toBe(false);
    }
    const outers: FramingProto[] = ['ethernet', 'dot11'];
    for (const outer of outers) expect(macFilterApplies('routed', outer, false)).toBe(true);
    const f = build(LCP);
    expect(FRAMING_RULES.ppp.destination(f.layers[0]!)).toBeUndefined();
    expect(FRAMING_RULES.ppp.demuxKey(f, f.layers[0]!)).toBe(PPP_PROTO.lcp);
    expect(FRAMING_RULES.ppp.managementSubtype(f.layers[0]!)).toBeUndefined();
  });

  it('an up ppp port demuxes on the protocol: control protocols to the key-less ppp selector, 0x0021 to ipv4', () => {
    const port = serialPort('ppp', true, { carrier: true, lineProtocol: true });
    expect(arrive(port, LCP)).toEqual({ kind: 'deliver', process: 'ppp', layer: 'ppp', key: PPP_PROTO.lcp, counters: [] });
    expect(arrive(port, CHAP)).toEqual({ kind: 'deliver', process: 'ppp', layer: 'ppp', key: PPP_PROTO.chap, counters: [] });
    expect(arrive(port, IPCP)).toEqual({ kind: 'deliver', process: 'ppp', layer: 'ppp', key: PPP_PROTO.ipcp, counters: [] });
    expect(arrive(port, IPV4)).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ppp', key: PPP_PROTO.ipv4, counters: [] });
    // nobody handles PPP on a port without a 'ppp' selector: unsupported, with the protocol as the detail
    expect(arrive(port, IPV4, { index: indexOf([['hdlc', [{ layer: 'hdlc', roles: ['wan'] }]]]) })).toEqual({
      kind: 'drop', reason: 'unsupported-ethertype', detail: '0x0021', counters: ['inDrops'],
    });
    expect(FRAME_ROLES).toContain('wan');
  });
});

describe('[S19] the receive gate: PPP control frames flow on a ppp port down only by PPP', () => {
  it('LCP, PAP, CHAP, IPCP and IPv6CP pass while negotiating, after a failed authentication and after missed echoes', () => {
    for (const reason of ['ppp-negotiating', 'ppp-auth-failed', 'keepalive-missed']) {
      const port = serialPort('ppp', false, negotiating(reason));
      for (const layers of [LCP, PAP, CHAP, IPCP, IPV6CP]) {
        expect(portReceiveUp(port, build(layers))).toBe(true);
        expect(arrive(port, layers)).toMatchObject({ kind: 'deliver', process: 'ppp', layer: 'ppp' });
      }
      // data does not
      expect(portReceiveUp(port, build(IPV4))).toBe(false);
      expect(arrive(port, IPV4)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    }
  });

  it('nothing passes without carrier, without clock, on an encapsulation mismatch, on an HDLC port, or before boot', () => {
    expect(arrive(serialPort('ppp', false, negotiating('ppp-negotiating', false)), LCP)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    expect(arrive(serialPort('ppp', false, negotiating('no-clock')), LCP)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    expect(arrive(serialPort('ppp', false, negotiating('encapsulation-mismatch')), LCP)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    expect(arrive(serialPort('ppp', false), LCP)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    // an HDLC port never takes the PPP branch, whatever its line state says
    expect(portReceiveUp(serialPort('hdlc', false, negotiating('ppp-negotiating')), build(LCP))).toBe(false);
    expect(arrive(serialPort('ppp', false, negotiating()), LCP, { booted: false })).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    // the effective encapsulation decides: a port with no live encapsulation reads its spec default (hdlc)
    const specDefault = serialPort('ppp', false, negotiating());
    delete (specDefault as { encap?: string }).encap;
    expect(portReceiveUp(specDefault, build(LCP))).toBe(false);
  });

  it('the HDLC keepalive branch is unchanged', () => {
    const latched = serialPort('hdlc', false, { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed' });
    expect(portReceiveUp(latched, build(HDLC_KEEPALIVE))).toBe(true);
    expect(portReceiveUp(latched, build([{ proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV4 } }, { proto: 'payload', fields: {} }]))).toBe(false);
    expect(portReceiveUp(serialPort('hdlc', false, { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock' }), build(HDLC_KEEPALIVE))).toBe(false);
    // a PPP-only reason never opens the HDLC branch
    expect(portReceiveUp(serialPort('hdlc', false, negotiating()), build(HDLC_KEEPALIVE))).toBe(false);
  });
});

describe('[S19] the runtime: encapsulation ppp accepted on a serial WAN port (§9.2 item 30), refused on an access line', () => {
  /** An NF-2911 whose hdlc and ipv4 daemons are fakes declaring the [S19] 'ppp' selectors. */
  function router2911() {
    const link = fakeProcess('hdlc', { handles: [{ layer: 'ppp', roles: ['wan'] }, { layer: 'hdlc', roles: ['wan'] }] });
    const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ppp', ethertype: PPP_PROTO.ipv4, roles: ['wan'] }] });
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { hdlc: link.factory, ipv4: ipv4.factory } });
    boot(h);
    return { h, d: h.device, link, ipv4 };
  }

  it('the effective encapsulation becomes ppp, the line is stored, the link model is told; no encapsulation restores hdlc', () => {
    const { h, d } = router2911();
    const ctx = [['interface', 'Serial0/0/0']];
    expect(d.applyConfigLine(ctx, ['encapsulation', 'ppp'], false)).toEqual({ ok: true });
    expect(d.port('Serial0/0/0')?.encap).toBe('ppp');
    expect(d.running.render()).toContain(' encapsulation ppp\n');
    expect(h.phyCalls.map((c) => c.ref.port)).toEqual(['Serial0/0/0']);
    const changes = h.kinds('configChange') as Extract<TraceEvent, { kind: 'configChange' }>[];
    expect(changes.map((e) => e.line)).toContain('encapsulation ppp');
    expect(d.applyConfigLine(ctx, ['encapsulation'], true)).toEqual({ ok: true });
    expect(d.port('Serial0/0/0')?.encap).toBe('hdlc');
    expect(DEVICE_CONFIG_MESSAGES).not.toHaveProperty('pppUnavailable');
  });

  it('a serial access line (NF-CSU-DSU) stays HDLC only', () => {
    const h = harness({ type: 'csu.nfcsu', name: 'CSU1' });
    boot(h);
    const d = h.device;
    expect(d.port('Serial0')?.role).toBe('access-line');
    expect(d.applyConfigLine([['interface', 'Serial0']], ['encapsulation', 'ppp'], false)).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.pppAccessLine });
    expect(DEVICE_CONFIG_MESSAGES.pppAccessLine).toBe('This serial access line carries HDLC only.');
    expect(d.port('Serial0')?.encap).toBe('hdlc');
  });

  it('a PPP frame reaches its process on the port: LCP while negotiating, IPv4 only once the line protocol is up', () => {
    const { h, d, link, ipv4 } = router2911();
    d.applyConfigLine([['interface', 'Serial0/0/0']], ['encapsulation', 'ppp'], false);
    const port = d.port('Serial0/0/0')!;
    port.adminUp = true;
    port.operUp = false;
    port.phy = negotiating();
    const t = d.bootedAt! + 1_000;
    d.onFrameArrival('Serial0/0/0', build(LCP), false, t);
    expect(link.calls.filter((c) => c.kind === 'onPdu').map((c) => [c.port, c.pdu!.layers[1]!.proto])).toEqual([['Serial0/0/0', 'lcp']]);
    d.onFrameArrival('Serial0/0/0', build(IPV4), false, t + 1);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toEqual([]);
    const drops = h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(drops.map((e) => [e.port, e.reason])).toEqual([['Serial0/0/0', 'link-down']]);
    port.operUp = true;
    port.phy = { carrier: true, lineProtocol: true };
    d.onFrameArrival('Serial0/0/0', build(IPV4), false, t + 2);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu').map((c) => c.port)).toEqual(['Serial0/0/0']);
    expect(port.counters.inBroadcasts).toBe(0);
  });
});
