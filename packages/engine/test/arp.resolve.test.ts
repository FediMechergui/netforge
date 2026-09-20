import { describe, expect, it } from 'vitest';
import { ARP_QUEUE_LIMIT, createArp } from '../src/protocols/arp.js';
import { MAC_BROADCAST, MAC_ZERO } from '../src/contracts/addr.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from '../src/contracts/pdu.js';
import { ARP_REQUEST_RETRIES, ARP_REQUEST_RETRY_NS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { arpFrame, cancels, drops, echoPacket, forwardedFrame, makeHarness, sends, timers } from './arp.harness.js';

const ME_MAC = '00:1f:00:00:00:01';
const ME_IP = '10.0.0.1';
const PEER_MAC = '00:1f:00:00:00:02';
const PEER_IP = '10.0.0.2';
const GI0 = 'GigabitEthernet0';
const RETRY_KEY = `arp-retry:${GI0}:${PEER_IP}`;

function pcHarness() {
  return makeHarness({ ports: [{ id: GI0, mac: ME_MAC, address: ME_IP }] });
}

describe('arp resolve (arp.sendVia)', () => {
  it('cache miss: queues the packet, writes an Incomplete row and broadcasts a request', () => {
    const h = pcHarness();
    h.setNow(2 * SEC);
    const arp = createArp();
    const pkt = echoPacket(h, ME_IP, PEER_IP);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: PEER_IP, iface: GI0, cause: 'connected' });

    expect(actions.map((a) => a.type)).toEqual(['send', 'timer']);
    const req = sends(actions)[0]!.pdu;
    expect(sends(actions)[0]!.port).toBe(GI0);
    expect(req.id).not.toBe(pkt.id);
    expect(req.meta.triggeredBy).toBe(pkt.id);
    expect(req.meta.tag).toBe('arp-request');
    expect(req.get('ethernet.dst')).toBe(MAC_BROADCAST);
    expect(req.get('ethernet.src')).toBe(ME_MAC);
    expect(req.get('ethernet.type')).toBe(ETHERTYPE_ARP);
    expect(req.get('arp.op')).toBe(ARP_OP_REQUEST);
    expect(req.get('arp.sha')).toBe(ME_MAC);
    expect(req.get('arp.spa')).toBe(ME_IP);
    expect(req.get('arp.tha')).toBe(MAC_ZERO);
    expect(req.get('arp.tpa')).toBe(PEER_IP);
    expect(req.summary()).toBe(`ARP request who-has ${PEER_IP} tell ${ME_IP}`);
    expect(timers(actions)[0]).toEqual({ type: 'timer', key: RETRY_KEY, delay: ARP_REQUEST_RETRY_NS });

    const row = h.tables.arp.get(PEER_IP)!;
    expect(row.incomplete).toBe(true);
    expect(row.mac).toBe(MAC_ZERO);
    expect(row.iface).toBe(GI0);
    expect(row.updatedAt).toBe(2 * SEC);
    expect(row.expiresAt).toBe(2 * SEC + ARP_REQUEST_RETRIES * ARP_REQUEST_RETRY_NS + SEC);

    // The queued packet is untouched (no ethernet layer yet).
    expect(pkt.layer('ethernet')).toBeUndefined();
    expect(pkt.provenance).toHaveLength(0);

    const snap = arp.stateSnapshot();
    expect(snap.process).toBe('arp');
    expect(snap.state.pending).toEqual([{ ip: PEER_IP, iface: GI0, retries: 0, requests: 1, queued: 1 }]);
    expect(snap.state.requestsSent).toBe(1);
  });

  it('a second packet for the same next hop is queued without another request', () => {
    const h = pcHarness();
    const arp = createArp();
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: echoPacket(h, ME_IP, PEER_IP, 1), nextHop: PEER_IP, iface: GI0 });
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: echoPacket(h, ME_IP, PEER_IP, 2), nextHop: PEER_IP, iface: GI0 });
    expect(actions).toEqual([]);
    expect(arp.stateSnapshot().state.pending).toEqual([{ ip: PEER_IP, iface: GI0, retries: 0, requests: 1, queued: 2 }]);
    expect(arp.stateSnapshot().state.requestsSent).toBe(1);
  });

  it('reply flushes the queue in order with an Encapsulate mutation and the right MACs', () => {
    const h = pcHarness();
    const arp = createArp();
    const p1 = echoPacket(h, ME_IP, PEER_IP, 1);
    const p2 = echoPacket(h, ME_IP, PEER_IP, 2);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p1, nextHop: PEER_IP, iface: GI0, cause: 'connected 10.0.0.0/24' });
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p2, nextHop: PEER_IP, iface: GI0, cause: 'connected 10.0.0.0/24' });

    h.setNow(SEC / 2);
    const reply = arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP });
    const actions = arp.onPdu(h.ctx, reply, GI0);

    expect(actions.map((a) => a.type)).toEqual(['consume', 'cancelTimer', 'send', 'send']);
    expect(cancels(actions)[0]!.key).toBe(RETRY_KEY);
    const out = sends(actions);
    expect(out.map((s) => s.pdu.id)).toEqual([p1.id, p2.id]);
    for (const s of out) {
      expect(s.port).toBe(GI0);
      expect(s.pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
      expect(s.pdu.get('ethernet.dst')).toBe(PEER_MAC);
      expect(s.pdu.get('ethernet.src')).toBe(ME_MAC);
      expect(s.pdu.get('ethernet.type')).toBe(ETHERTYPE_IPV4);
      expect(s.pdu.get('ipv4.dst')).toBe(PEER_IP);
      expect(s.pdu.provenance).toHaveLength(1);
      const m = s.pdu.provenance[0]!;
      expect(m.reason).toBe('Encapsulate');
      expect(m.field).toBe('ethernet');
      expect(m.after).toBe('ethernet');
      expect(m.cause).toBe('connected 10.0.0.0/24');
      expect(m.device).toBe('d_test');
      expect(m.at).toBe(SEC / 2);
    }
    const row = h.tables.arp.get(PEER_IP)!;
    expect(row.incomplete).toBeUndefined();
    expect(row.mac).toBe(PEER_MAC);
    const writes = h.events.filter((e) => e.kind === 'tableWrite' && e.table === 'arp');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.kind === 'tableWrite' && writes[1]!.previous?.incomplete).toBe(true);
    const snap = arp.stateSnapshot();
    expect(snap.state.pending).toEqual([]);
    expect(snap.state.resolved).toBe(1);
  });

  it('a request from the awaited host also resolves the queue', () => {
    const h = pcHarness();
    const arp = createArp();
    const p1 = echoPacket(h, ME_IP, PEER_IP, 1);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p1, nextHop: PEER_IP, iface: GI0 });
    const req = arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: MAC_ZERO, tpa: ME_IP });
    const actions = arp.onPdu(h.ctx, req, GI0);
    // consume, cancelTimer, flushed packet, then our reply
    expect(actions.map((a) => a.type)).toEqual(['consume', 'cancelTimer', 'send', 'send']);
    expect(sends(actions)[0]!.pdu.id).toBe(p1.id);
    expect(sends(actions)[1]!.pdu.meta.tag).toBe('arp-reply');
  });

  it('retries every second and gives up after three requests with arp-unresolved drops', () => {
    const h = pcHarness();
    const arp = createArp();
    const p1 = echoPacket(h, ME_IP, PEER_IP, 1);
    const p2 = echoPacket(h, ME_IP, PEER_IP, 2);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p1, nextHop: PEER_IP, iface: GI0 });
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p2, nextHop: PEER_IP, iface: GI0 });

    h.setNow(SEC);
    const r1 = arp.onTimer(h.ctx, RETRY_KEY);
    expect(r1.map((a) => a.type)).toEqual(['send', 'timer']);
    expect(sends(r1)[0]!.pdu.get('arp.tpa')).toBe(PEER_IP);
    expect(sends(r1)[0]!.pdu.meta.triggeredBy).toBe(p1.id);
    expect(arp.stateSnapshot().state.pending).toEqual([{ ip: PEER_IP, iface: GI0, retries: 1, requests: 2, queued: 2 }]);

    h.setNow(2 * SEC);
    const r2 = arp.onTimer(h.ctx, RETRY_KEY);
    expect(r2.map((a) => a.type)).toEqual(['send', 'timer']);
    expect(arp.stateSnapshot().state.requestsSent).toBe(3);

    h.setNow(3 * SEC);
    const r3 = arp.onTimer(h.ctx, RETRY_KEY);
    expect(sends(r3)).toHaveLength(0);
    expect(timers(r3)).toHaveLength(0);
    const d = drops(r3);
    expect(d.map((x) => x.pdu.id)).toEqual([p1.id, p2.id]);
    for (const x of d) {
      expect(x.reason).toBe('arp-unresolved');
      expect(x.detail).toBe(`no reply from ${PEER_IP} after 3 requests`);
      expect(x.port).toBe(GI0);
    }
    expect(h.tables.arp.get(PEER_IP)).toBeUndefined();
    const expire = h.events.filter((e) => e.kind === 'tableExpire' && e.table === 'arp');
    expect(expire).toHaveLength(1);
    expect(expire[0]!.kind === 'tableExpire' && expire[0]!.reason).toBe('aged');
    expect(expire[0]!.t).toBe(3 * SEC);
    const snap = arp.stateSnapshot();
    expect(snap.state.pending).toEqual([]);
    expect(snap.state.failed).toBe(1);
    // A stale timer for a forgotten resolution is a no-op.
    expect(arp.onTimer(h.ctx, RETRY_KEY)).toEqual([]);
    // The queued packets were never encapsulated.
    expect(p1.layer('ethernet')).toBeUndefined();
  });

  it('cache hit: encapsulates a locally-originated packet and sends immediately', () => {
    const h = pcHarness();
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    const pkt = echoPacket(h, ME_IP, PEER_IP);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: PEER_IP, iface: GI0 });
    expect(actions.map((a) => a.type)).toEqual(['send']);
    expect(sends(actions)[0]!.pdu).toBe(pkt);
    expect(pkt.get('ethernet.dst')).toBe(PEER_MAC);
    expect(pkt.get('ethernet.src')).toBe(ME_MAC);
    expect(pkt.get('ethernet.type')).toBe(ETHERTYPE_IPV4);
    expect(pkt.provenance.map((m) => m.reason)).toEqual(['Encapsulate']);
    expect(h.decode(pkt.bytes).get('ethernet.fcsValid')).toBe(true);
  });

  it('forwarded frame: rewrites the MAC pair with MacRewrite mutations and keeps the id', () => {
    const h = makeHarness({
      kind: 'router',
      ports: [
        { id: 'GigabitEthernet0/0', mac: '00:1f:00:00:00:10', address: '10.0.0.254' },
        { id: 'GigabitEthernet0/1', mac: '00:1f:00:00:00:11', address: '10.0.1.254' },
      ],
    });
    const arp = createArp();
    // Learn the far host on Gi0/1.
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: '00:1f:00:00:00:22', spa: '10.0.1.2', tha: '00:1f:00:00:00:11', tpa: '10.0.1.254' }), 'GigabitEthernet0/1');
    const frame = forwardedFrame(h, '10.0.0.1', '10.0.1.2', '00:1f:00:00:00:02', '00:1f:00:00:00:10');
    const id = frame.id;
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: frame, nextHop: '10.0.1.2', iface: 'GigabitEthernet0/1', cause: 'C 10.0.1.0/24 GigabitEthernet0/1' });
    expect(actions.map((a) => a.type)).toEqual(['send']);
    expect(sends(actions)[0]!.port).toBe('GigabitEthernet0/1');
    expect(frame.id).toBe(id);
    expect(frame.get('ethernet.src')).toBe('00:1f:00:00:00:11');
    expect(frame.get('ethernet.dst')).toBe('00:1f:00:00:00:22');
    expect(frame.get('ipv4.ttl')).toBe(127);
    const macs = frame.provenance.filter((m) => m.reason === 'MacRewrite');
    expect(macs.map((m) => [m.field, m.before, m.after])).toEqual([
      ['ethernet.src', '00:1f:00:00:00:02', '00:1f:00:00:00:11'],
      ['ethernet.dst', '00:1f:00:00:00:10', '00:1f:00:00:00:22'],
    ]);
    expect(macs.every((m) => m.cause === 'C 10.0.1.0/24 GigabitEthernet0/1')).toBe(true);
    expect(frame.provenance.some((m) => m.reason === 'Encapsulate')).toBe(false);
    expect(h.decode(frame.bytes).get('ethernet.fcsValid')).toBe(true);
  });

  it('caps the queue per next hop, dropping the oldest packet queue-full', () => {
    const h = pcHarness();
    const arp = createArp();
    const pkts = [];
    for (let i = 0; i < ARP_QUEUE_LIMIT + 1; i++) pkts.push(echoPacket(h, ME_IP, PEER_IP, i + 1));
    let last: ReturnType<typeof drops> = [];
    for (const p of pkts) {
      const a = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: p, nextHop: PEER_IP, iface: GI0 });
      last = drops(a);
    }
    expect(last).toHaveLength(1);
    expect(last[0]!.pdu.id).toBe(pkts[0]!.id);
    expect(last[0]!.reason).toBe('queue-full');
    expect(arp.stateSnapshot().state.pending).toEqual([{ ip: PEER_IP, iface: GI0, retries: 0, requests: 1, queued: ARP_QUEUE_LIMIT }]);
    // Flush order is still oldest surviving first.
    const flushed = sends(arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0));
    expect(flushed.map((s) => s.pdu.id)).toEqual(pkts.slice(1).map((p) => p.id));
  });

  it('drops link-down when the egress port is not up', () => {
    const h = makeHarness({ ports: [{ id: GI0, mac: ME_MAC, address: ME_IP, operUp: false }] });
    const arp = createArp();
    const pkt = echoPacket(h, ME_IP, PEER_IP);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: PEER_IP, iface: GI0 });
    expect(actions).toEqual([{ type: 'drop', pdu: pkt, reason: 'link-down', detail: `${GI0} is down`, port: GI0 }]);
    expect(h.tables.arp.size).toBe(0);
  });

  it('drops no-l3-address when the egress port has no address to ask from', () => {
    const h = makeHarness({ ports: [{ id: GI0, mac: ME_MAC }] });
    const arp = createArp();
    const pkt = echoPacket(h, ME_IP, PEER_IP);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: pkt, nextHop: PEER_IP, iface: GI0 });
    expect(drops(actions)).toHaveLength(1);
    expect(drops(actions)[0]!.reason).toBe('no-l3-address');
    expect(sends(actions)).toHaveLength(0);
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state.pending).toEqual([]);
  });

  it('ignores requests it does not understand', () => {
    const h = pcHarness();
    const arp = createArp();
    expect(arp.onRequest!(h.ctx, { kind: 'icmp.abort', session: 's_1' })).toEqual([]);
    expect(arp.onRequest!(h.ctx, { kind: 'ext.whatever' })).toEqual([]);
  });
});
