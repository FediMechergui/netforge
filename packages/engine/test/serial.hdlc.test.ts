/**
 * P0.5 W3 l2l3: serial HDLC (ARCHITECTURE-P1 D6, §3.9).
 *  - the hdlc keepalive daemon: carrier-driven periodic timer, 12-byte keepalives, per-end miss latch through
 *    `medium line-protocol`, recovery on the next keepalive, `keepalive 0` / `no keepalive`, silence without carrier
 *    or clock;
 *  - `arp.sendVia` frames IPv4 in HDLC with no resolution and rewraps across Ethernet/HDLC with recorded provenance;
 *  - ipv4 receives HDLC-framed IPv4 on WAN ports and forwards it onto Ethernet.
 */
import { describe, expect, it } from 'vitest';
import { defineModel } from '../src/device/catalog/define.js';
import { buildDemuxIndex, demuxLookup } from '../src/device/pipeline.js';
import { createArp, leadingFramingLayers } from '../src/protocols/arp.js';
import {
  HDLC_HANDLES,
  HDLC_KEEPALIVE_PAYLOAD_BYTES,
  HDLC_KEEPALIVE_TAG,
  createHdlc,
  decodeKeepalivePayload,
  encodeKeepalivePayload,
  keepaliveIntervalFromConfig,
  keepaliveIntervalFromDelta,
  keepaliveTimerKey,
  parseKeepaliveSeconds,
} from '../src/protocols/hdlc.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { PortPhy } from '../src/contracts/link.js';
import {
  ETHERTYPE_IPV4,
  HDLC_ADDRESS_BROADCAST,
  HDLC_ADDRESS_UNICAST,
  HDLC_PROTO_IPV4,
  HDLC_PROTO_IPV6,
  HDLC_PROTO_KEEPALIVE,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action, Process } from '../src/contracts/process.js';
import { HDLC_KEEPALIVE_DEFAULT_NS, HDLC_KEEPALIVE_MISSES } from '../src/contracts/services.js';
import { SEC } from '../src/contracts/time.js';
import { arpFrame, consumes, drops, echoPacket, makeHarness, mediums, sends, timers, cancels } from './arp.harness.js';
import type { Harness } from './arp.harness.js';
import { NF_2911_INPUT } from './device.catalog.p0-inputs.js';
import { echoRequest, makeFake } from './ip.fake-ctx.js';

const SE = 'Serial0/0/0';
const GI = 'GigabitEthernet0/0';
const R1_SE_MAC = '02:4e:00:01:00:03';
const R1_GI_MAC = '02:4e:00:01:00:01';
const CLOCKED: PortPhy = { carrier: true, lineProtocol: true, dce: true };

function router(id: string, phy: PortPhy | undefined = CLOCKED): Harness {
  return makeHarness({
    deviceId: id,
    kind: 'router',
    ports: [
      { id: GI, mac: R1_GI_MAC, address: '192.168.1.1', prefixLen: 24 },
      { id: SE, mac: R1_SE_MAC, kind: 'serial', address: '10.0.0.1', prefixLen: 30, ...(phy === undefined ? {} : { phy }) },
    ],
  });
}

const tick = (h: Harness, hdlc: Process) => hdlc.onTimer(h.ctx, keepaliveTimerKey(SE));
const carrier = (h: Harness, hdlc: Process, up: boolean) => hdlc.onMediumEvent!(h.ctx, SE, { kind: 'carrier', up });
const ifDelta = (op: 'set' | 'unset', line: string[]) => ({ op, context: [['interface', SE]], line });

/** Carry a sent keepalive onto the far router's serial port (decoded from the wire bytes). */
function deliver(from: Action[], to: Harness, hdlc: Process): Action[] {
  const out = sends(from);
  expect(out).toHaveLength(1);
  const pdu = to.decode(out[0]!.pdu.bytes, 'hdlc');
  return hdlc.onPdu(to.ctx, pdu, SE);
}

describe('hdlc keepalive helpers', () => {
  it('declares its selector, parses keepalive periods and round-trips the 12-byte body', () => {
    expect(createHdlc().name).toBe('hdlc');
    expect(createHdlc().handles).toEqual([{ layer: 'hdlc', ethertype: HDLC_PROTO_KEEPALIVE, roles: ['wan', 'access-line'] }]);
    expect(HDLC_HANDLES).toEqual(createHdlc().handles);
    expect(keepaliveTimerKey(SE)).toBe('ka:Serial0/0/0');
    expect(parseKeepaliveSeconds('0')).toBe(0);
    expect(parseKeepaliveSeconds('10')).toBe(10);
    expect(parseKeepaliveSeconds('32767')).toBe(32767);
    expect(parseKeepaliveSeconds('32768')).toBeUndefined();
    expect(parseKeepaliveSeconds('-1')).toBeUndefined();
    expect(parseKeepaliveSeconds('5s')).toBeUndefined();
    const body = encodeKeepalivePayload(0xfffffffe, 7);
    expect(body).toHaveLength(HDLC_KEEPALIVE_PAYLOAD_BYTES);
    expect(Array.from(body)).toEqual([0xff, 0xff, 0xff, 0xfe, 0, 0, 0, 7, 0xff, 0xff, 0, 0]);
    expect(decodeKeepalivePayload(body)).toEqual({ mySeq: 0xfffffffe, yourSeq: 7, reliability: 0xffff });
    expect(decodeKeepalivePayload(new Uint8Array(11))).toBeUndefined();
  });

  it('reads the keepalive period from a delta and from the running config', () => {
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['keepalive']))).toBe(HDLC_KEEPALIVE_DEFAULT_NS);
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['keepalive', '5']))).toBe(5 * SEC);
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['keepalive', '0']))).toBe(0);
    expect(keepaliveIntervalFromDelta(ifDelta('unset', ['keepalive']))).toBe(0);
    expect(keepaliveIntervalFromDelta(ifDelta('unset', ['keepalive', '5']))).toBe(HDLC_KEEPALIVE_DEFAULT_NS);
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['no', 'keepalive']))).toBe(0);
    expect(keepaliveIntervalFromDelta(ifDelta('unset', ['no', 'keepalive']))).toBe(HDLC_KEEPALIVE_DEFAULT_NS);
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['keepalive', 'soon']))).toBeUndefined();
    expect(keepaliveIntervalFromDelta(ifDelta('set', ['clock', 'rate', '64000']))).toBeUndefined();

    const ast = createConfigAst();
    expect(keepaliveIntervalFromConfig(ast, SE)).toBe(HDLC_KEEPALIVE_DEFAULT_NS);
    ast.set([['interface', SE]], ['keepalive', '3']);
    expect(keepaliveIntervalFromConfig(ast, SE)).toBe(3 * SEC);
    ast.unset([['interface', SE]], ['keepalive']);
    expect(keepaliveIntervalFromConfig(ast, SE)).toBe(0);
    expect(ast.render()).toContain(' no keepalive');
    expect(keepaliveIntervalFromConfig(ast, 'Serial0/0/1')).toBe(HDLC_KEEPALIVE_DEFAULT_NS);
  });
});

describe('hdlc keepalive daemon', () => {
  it('is silent without carrier and arms ka:<port> only on serial ports with carrier', () => {
    const quiet = router('d_r1', { carrier: false, lineProtocol: false });
    expect(createHdlc().init!(quiet.ctx)).toEqual([]);
    const h = router('d_r1');
    const hdlc = createHdlc();
    expect(hdlc.init!(h.ctx)).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 10 * SEC, periodic: true }]);
    expect(hdlc.stateSnapshot()).toEqual({
      process: 'hdlc',
      state: {
        lines: [{ port: SE, intervalNs: 10 * SEC, carrier: true, armed: true, misses: 0, lineProtocolDown: false, mySeq: 0, yourSeq: 0, sent: 0, received: 0 }],
        sent: 0,
        received: 0,
      },
    });
    expect(() => structuredClone(hdlc.stateSnapshot())).not.toThrow();
    expect(h.debug.every((d) => d.category === 'serial')).toBe(true);
  });

  it('follows carrier MediumEvents: up arms, down cancels, other events are ignored', () => {
    const h = router('d_r1', { carrier: false, lineProtocol: false });
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    expect(carrier(h, hdlc, true)).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 10 * SEC, periodic: true }]);
    expect(carrier(h, hdlc, false)).toEqual([{ type: 'cancelTimer', key: 'ka:Serial0/0/0' }]);
    expect(carrier(h, hdlc, false)).toEqual([]);
    expect(hdlc.onMediumEvent!(h.ctx, SE, { kind: 'bss-down', bssid: '02:00:00:00:00:01' })).toEqual([]);
    expect(hdlc.onMediumEvent!(h.ctx, GI, { kind: 'carrier', up: true })).toEqual([]);
    expect(tick(h, hdlc)).toEqual([]);
  });

  it('sends a background keepalive frame on every tick and re-arms the periodic timer', () => {
    const h = router('d_r1');
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    h.setNow(10 * SEC);
    const actions = tick(h, hdlc);
    expect(actions.map((a) => a.type)).toEqual(['send', 'timer']);
    expect(timers(actions)).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 10 * SEC, periodic: true }]);
    const frame = sends(actions)[0]!;
    expect(frame.port).toBe(SE);
    expect(frame.pdu.layers.map((l) => l.proto)).toEqual(['hdlc', 'payload']);
    expect(frame.pdu.layers[0]!.fields).toMatchObject({ address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE, fcsValid: true });
    expect(frame.pdu.meta).toMatchObject({ tag: HDLC_KEEPALIVE_TAG, background: true });
    expect(frame.pdu.size).toBe(4 + 12 + 2);
    expect(decodeKeepalivePayload(frame.pdu.layers[1]!.fields.data as Uint8Array)).toEqual({ mySeq: 1, yourSeq: 0, reliability: 0xffff });
    expect(frame.pdu.summary()).toBe('HDLC keepalive address=0x8f');
    expect(decodeKeepalivePayload(sends(tick(h, hdlc))[0]!.pdu.layers[1]!.fields.data as Uint8Array)!.mySeq).toBe(2);
  });

  it('latches this end down after three missed intervals, reports once, and recovers on the next keepalive', () => {
    const r1 = router('d_r1');
    const r2 = router('d_r2');
    const k1 = createHdlc();
    const k2 = createHdlc();
    k1.init!(r1.ctx);
    k2.init!(r2.ctx);
    for (let i = 1; i < HDLC_KEEPALIVE_MISSES; i++) expect(mediums(tick(r1, k1))).toEqual([]);
    const third = tick(r1, k1);
    expect(mediums(third)).toEqual([{ type: 'medium', port: SE, op: { op: 'line-protocol', up: false, reason: 'keepalive-missed' } }]);
    expect(sends(third)).toHaveLength(1);
    expect(k1.stateSnapshot().state).toMatchObject({ lines: [{ misses: 3, lineProtocolDown: true }] });
    expect(mediums(tick(r1, k1))).toEqual([]);

    // R2's keepalive reaches R1: the latch is released and R1 learns R2's sequence number.
    const heard = deliver(tick(r2, k2), r1, k1);
    expect(consumes(heard)).toHaveLength(1);
    expect(mediums(heard)).toEqual([{ type: 'medium', port: SE, op: { op: 'line-protocol', up: true } }]);
    expect(k1.stateSnapshot().state).toMatchObject({ lines: [{ misses: 0, lineProtocolDown: false, yourSeq: 1, received: 1 }] });
    expect(r1.debug.some((d) => d.message === `line protocol on ${SE} is up again: keepalive received`)).toBe(true);
    // the next tick after hearing the peer counts no miss and echoes the peer sequence
    const next = tick(r1, k1);
    expect(mediums(next)).toEqual([]);
    expect(decodeKeepalivePayload(sends(next)[0]!.pdu.layers[1]!.fields.data as Uint8Array)!.yourSeq).toBe(1);
  });

  it('keepalive 0 on R2: R2 never reports, R1 alone goes down after 30 s, keepalive 10 on R2 brings R1 back', () => {
    const r1 = router('d_r1');
    const r2 = router('d_r2');
    const k1 = createHdlc();
    const k2 = createHdlc();
    k1.init!(r1.ctx);
    k2.init!(r2.ctx);
    expect(k2.onConfig(r2.ctx, ifDelta('set', ['keepalive', '0']))).toEqual([{ type: 'cancelTimer', key: 'ka:Serial0/0/0' }]);

    const r1Reports: Action[] = [];
    for (let t = 10; t <= 30; t += 10) {
      r1.setNow(t * SEC);
      const out = tick(r1, k1);
      r1Reports.push(...mediums(out));
      // R2 hears R1's keepalives but, with keepalives disabled, never reports anything
      expect(mediums(deliver(out, r2, k2))).toEqual([]);
    }
    expect(r1Reports).toEqual([{ type: 'medium', port: SE, op: { op: 'line-protocol', up: false, reason: 'keepalive-missed' } }]);
    expect(k2.stateSnapshot().state).toMatchObject({ lines: [{ armed: false, lineProtocolDown: false, intervalNs: 0 }] });
    expect(tick(r2, k2)).toEqual([]);

    expect(k2.onConfig(r2.ctx, ifDelta('set', ['keepalive', '10']))).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 10 * SEC, periodic: true }]);
    expect(mediums(deliver(tick(r2, k2), r1, k1))).toEqual([{ type: 'medium', port: SE, op: { op: 'line-protocol', up: true } }]);
  });

  it('applies keepalive config: new period re-arms, no keepalive disarms and releases its own latch, invalid values are ignored', () => {
    const h = router('d_r1');
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    expect(hdlc.onConfig(h.ctx, ifDelta('set', ['keepalive', '5']))).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 5 * SEC, periodic: true }]);
    expect(hdlc.onConfig(h.ctx, ifDelta('set', ['keepalive', '5']))).toEqual([]);
    expect(hdlc.onConfig(h.ctx, ifDelta('set', ['keepalive', '99999']))).toEqual([]);
    expect(h.debug.at(-1)!.message).toContain('ignored keepalive 99999');
    for (let i = 0; i < HDLC_KEEPALIVE_MISSES; i++) tick(h, hdlc);
    const off = hdlc.onConfig(h.ctx, ifDelta('unset', ['keepalive']));
    expect(off).toEqual([
      { type: 'cancelTimer', key: 'ka:Serial0/0/0' },
      { type: 'medium', port: SE, op: { op: 'line-protocol', up: true } },
    ]);
    expect(hdlc.onConfig(h.ctx, ifDelta('set', ['keepalive']))).toEqual([{ type: 'timer', key: 'ka:Serial0/0/0', delay: 10 * SEC, periodic: true }]);
    // lines for other interfaces and non-serial ports are not the daemon's business
    expect(hdlc.onConfig(h.ctx, { op: 'set', context: [['interface', GI]], line: ['keepalive', '3'] })).toEqual([]);
    expect(hdlc.onConfig(h.ctx, { op: 'set', context: [], line: ['hostname', 'R1'] })).toEqual([]);
  });

  it('config seen before init is applied at init; keepalive 0 in the startup config keeps the line silent', () => {
    const h = router('d_r1');
    h.ctx.config.set([['interface', SE]], ['keepalive', '0']);
    const hdlc = createHdlc();
    expect(hdlc.onConfig(h.ctx, ifDelta('set', ['keepalive', '0']))).toEqual([]);
    expect(hdlc.init!(h.ctx)).toEqual([]);
    expect(carrier(h, hdlc, true)).toEqual([]);
  });

  it('sends and counts nothing on a line that is not clocked', () => {
    const h = router('d_r1', { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true });
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    for (let i = 0; i < 5; i++) {
      const out = tick(h, hdlc);
      expect(out.map((a) => a.type)).toEqual(['timer']);
    }
    expect(hdlc.stateSnapshot().state).toMatchObject({ sent: 0, lines: [{ misses: 0, lineProtocolDown: false }] });
  });

  it('drops a malformed keepalive and ignores foreign timers', () => {
    const h = router('d_r1');
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    const short = h.build([{ proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, protocol: HDLC_PROTO_KEEPALIVE } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }]);
    expect(drops(hdlc.onPdu(h.ctx, short, SE))).toMatchObject([{ reason: 'other', detail: 'malformed keepalive' }]);
    expect(hdlc.onTimer(h.ctx, 'cam-sweep')).toEqual([]);
    expect(hdlc.onTimer(h.ctx, 'ka:Serial0/0/1')).toEqual([]);
    expect(cancels(carrier(h, hdlc, false))).toHaveLength(1);
  });
});

describe('arp.sendVia on serial HDLC ports', () => {
  it('encapsulates a local packet in HDLC protocol 0x0800 without any address resolution', () => {
    const h = router('d_r1');
    const arp = createArp();
    const pkt = echoPacket(h, '10.0.0.1', '10.0.0.2');
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: '10.0.0.2', iface: SE, cause: 'ping 10.0.0.2' });
    expect(actions).toEqual([{ type: 'send', port: SE, pdu: pkt }]);
    expect(pkt.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'icmpv4', 'payload']);
    expect(pkt.layers[0]!.fields).toMatchObject({ address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV4, fcsValid: true });
    expect(pkt.provenance.map((m) => [m.reason, m.field, m.cause])).toEqual([['Encapsulate', 'hdlc', 'ping 10.0.0.2']]);
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state).toMatchObject({ requestsSent: 0, pending: [] });
    const wire = h.decode(pkt.bytes, 'hdlc');
    expect(wire.get('hdlc.fcsValid')).toBe(true);
    expect(wire.get('ipv4.dst')).toBe('10.0.0.2');
  });

  it('rewraps a forwarded Ethernet frame into HDLC (Decapsulate ethernet, Encapsulate hdlc) and keeps the id', () => {
    const h = router('d_r1');
    const arp = createArp();
    const frame = h.build([
      { proto: 'ethernet', fields: { dst: R1_GI_MAC, src: '00:1f:00:00:00:02', type: ETHERTYPE_IPV4 } },
      ...echoRequest('192.168.1.2', '10.0.0.2', 1, 1, 127),
    ]);
    const id = frame.id;
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: frame, nextHop: '10.0.0.2', iface: SE, cause: `connected via ${SE}` });
    expect(sends(actions).map((s) => s.pdu.id)).toEqual([id]);
    expect(frame.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'icmpv4', 'payload']);
    expect(frame.provenance.map((m) => [m.reason, m.field])).toEqual([['Decapsulate', 'ethernet'], ['Encapsulate', 'hdlc']]);
    expect(frame.provenance.every((m) => m.device === 'd_r1' && m.cause === `connected via ${SE}`)).toBe(true);
    expect(frame.get('ipv4.ttl')).toBe(127);
    expect(frame.size).toBe(4 + 100 + 2);
  });

  it('sends an HDLC-framed packet unchanged, and never announces addresses on a serial link', () => {
    const h = router('d_r1');
    const arp = createArp();
    const framed = h.build([{ proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV4 } }, ...echoRequest('10.0.0.1', '10.0.0.2', 1, 1)]);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: framed, nextHop: '10.0.0.2', iface: SE });
    expect(framed.provenance).toEqual([]);
    expect(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: SE })).toEqual([]);
    expect(arp.onTimer(h.ctx, `garp:${SE}`)).toEqual([]);
    expect(h.debug.at(-1)!.message).toBe(`no announcement for ${SE}: the link does not use ARP`);
  });

  it('drops link-down on a serial port that is not up', () => {
    const h = router('d_r1');
    h.ports.get(SE)!.operUp = false;
    const arp = createArp();
    const pkt = echoPacket(h, '10.0.0.1', '10.0.0.2');
    expect(arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: '10.0.0.2', iface: SE })).toEqual([
      { type: 'drop', pdu: pkt, reason: 'link-down', detail: `${SE} is down`, port: SE },
    ]);
  });

  it('rewraps an HDLC-framed packet onto Ethernet with a fresh header (cache hit and after resolution)', () => {
    const h = router('d_r1');
    const arp = createArp();
    const fromSerial = () => h.build([{ proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV4 } }, ...echoRequest('10.0.0.2', '192.168.1.2', 1, 1, 63)]);

    // cache miss: queued, resolved, then rewrapped on flush
    const waiting = fromSerial();
    const miss = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: waiting, nextHop: '192.168.1.2', iface: GI, cause: `connected via ${GI}` });
    expect(sends(miss).map((s) => s.pdu.get('arp.tpa'))).toEqual(['192.168.1.2']);
    expect(waiting.layers[0]!.proto).toBe('hdlc');
    const flushed = arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: '00:1f:00:00:00:02', spa: '192.168.1.2', tha: R1_GI_MAC, tpa: '192.168.1.1' }), GI);
    expect(sends(flushed).map((s) => s.pdu)).toEqual([waiting]);
    expect(waiting.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(waiting.provenance.map((m) => [m.reason, m.field])).toEqual([['Decapsulate', 'hdlc'], ['Encapsulate', 'ethernet']]);
    expect(waiting.get('ethernet.dst')).toBe('00:1f:00:00:00:02');
    expect(waiting.get('ethernet.src')).toBe(R1_GI_MAC);
    expect(waiting.get('ethernet.type')).toBe(ETHERTYPE_IPV4);
    expect(h.decode(waiting.bytes).get('ethernet.fcsValid')).toBe(true);

    // cache hit
    const hit = fromSerial();
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: hit, nextHop: '192.168.1.2', iface: GI });
    expect(hit.layers[0]!.proto).toBe('ethernet');
    expect(hit.provenance.some((m) => m.reason === 'MacRewrite')).toBe(false);
    expect(leadingFramingLayers(hit)).toBe(1);
    expect(leadingFramingLayers(echoPacket(h, '10.0.0.1', '10.0.0.2'))).toBe(0);
  });
});

describe('ipv4 over HDLC', () => {
  const model = defineModel(NF_2911_INPUT, 'P0.5');

  it('demuxes HDLC IPv4 on WAN ports to ipv4 and keepalives to hdlc; nothing else on serial', () => {
    expect(model.processes).toEqual(['hdlc', 'arp', 'ipv4', 'icmpv4']);
    const processes = new Map<ProcessName, Process>([['hdlc', createHdlc()], ['arp', createArp()], ['ipv4', createIpv4()], ['icmpv4', createIcmpv4()]]);
    const index = buildDemuxIndex(model.processes, processes);
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_IPV4)?.process).toBe('ipv4');
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_KEEPALIVE)?.process).toBe('hdlc');
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_IPV6)).toBeUndefined();
    expect(demuxLookup(index, 'routed', 'hdlc', HDLC_PROTO_IPV4)).toBeUndefined();
    expect(demuxLookup(index, 'wan', 'ethernet', ETHERTYPE_IPV4)?.process).toBe('ipv4');
  });

  function wanRouter() {
    const fake = makeFake({
      kind: 'router',
      deviceId: 'd_r2',
      ports: [
        { id: GI, mac: '02:4e:00:02:00:01', ipv4: { address: '192.168.2.1', prefixLen: 24 } },
        { id: SE, mac: '02:4e:00:02:00:03', kind: 'serial', ipv4: { address: '10.0.0.2', prefixLen: 30 } },
      ],
    });
    const ipv4 = createIpv4();
    const arp = createArp();
    const icmp = createIcmpv4();
    fake.register(ipv4);
    fake.register(arp);
    fake.register(icmp);
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI]], line: ['ip', 'address', '192.168.2.1', '255.255.255.0'] }));
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', SE]], line: ['ip', 'address', '10.0.0.2', '255.255.255.252'] }));
    fake.actions.length = 0;
    return { fake, ipv4, arp, icmp };
  }

  function hdlcPacket(fake: ReturnType<typeof makeFake>, dst: string, ttl: number): Pdu {
    return fake.build([{ proto: 'hdlc', fields: { address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV4 } }, ...echoRequest('10.0.0.1', dst, 9, 1, ttl)]);
  }

  it('forwards an HDLC-framed packet from the WAN onto Ethernet: TTL decrement, then Decapsulate hdlc / Encapsulate ethernet', () => {
    const { fake, ipv4 } = wanRouter();
    expect(fake.ctx.ports.get(SE)).toMatchObject({ role: 'wan', encap: 'hdlc' });
    fake.tables.arp.set({ key: '192.168.2.2', ip: '192.168.2.2', mac: '00:1f:00:00:00:22', iface: GI, type: 'dynamic', updatedAt: 0 });
    const pdu = hdlcPacket(fake, '192.168.2.2', 64);
    fake.run(ipv4.onPdu(fake.ctx, pdu, SE));
    const sent = fake.actionsOf('send');
    expect(sent.map((s) => [s.port, s.pdu.id])).toEqual([[GI, pdu.id]]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.get('ipv4.ttl')).toBe(63);
    expect(pdu.get('ipv4.checksumValid')).toBe(true);
    const reasons = pdu.provenance.map((m) => m.reason).filter((r) => r === 'TtlDecrement' || r === 'Decapsulate' || r === 'Encapsulate');
    expect(reasons).toEqual(['TtlDecrement', 'Decapsulate', 'Encapsulate']);
    expect(pdu.provenance.find((m) => m.reason === 'TtlDecrement')!.cause).toBe(`connected via ${GI}`);
    expect(pdu.get('ethernet.dst')).toBe('00:1f:00:00:00:22');
  });

  it('delivers an HDLC-framed echo request for itself and answers it back over the serial link in HDLC', () => {
    const { fake, ipv4 } = wanRouter();
    const request = hdlcPacket(fake, '10.0.0.2', 255);
    fake.run(ipv4.onPdu(fake.ctx, request, SE));
    const sent = fake.actionsOf('send');
    expect(sent).toHaveLength(1);
    const reply = sent[0]!.pdu;
    expect(sent[0]!.port).toBe(SE);
    expect(reply.meta.triggeredBy).toBe(request.id);
    expect(reply.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'icmpv4', 'payload']);
    expect(reply.get('ipv4.dst')).toBe('10.0.0.1');
    expect(reply.get('ipv4.ttl')).toBe(255);
    expect(fake.actionsOf('consume').map((c) => c.pdu.id)).toEqual([request.id]);
  });
});
