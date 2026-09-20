import { describe, expect, it } from 'vitest';
import { createArp } from '../src/protocols/arp.js';
import { L3_ROLES } from '../src/contracts/catalog.js';
import { ARP_OP_REPLY, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import { ARP_HOST_TIMEOUT_NS, ARP_TIMEOUT_NS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { arpFrame, consumes, drops, makeHarness, sends } from './arp.harness.js';

const ME_MAC = '00:1f:00:00:00:01';
const ME_IP = '10.0.0.1';
const PEER_MAC = '00:1f:00:00:00:02';
const PEER_IP = '10.0.0.2';
const GI0 = 'GigabitEthernet0';

function pcHarness() {
  return makeHarness({ ports: [{ id: GI0, mac: ME_MAC, address: ME_IP }] });
}

describe('arp receive', () => {
  it('declares itself and its demux selector', () => {
    const arp = createArp();
    expect(arp.name).toBe('arp');
    // P0.5 (§9.2): ARP frames are taken only on ports whose role holds L3 addresses.
    expect(arp.handles).toEqual([{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }]);
  });

  it('answers a request for my address with a correctly encoded reply and learns the sender', () => {
    const h = pcHarness();
    h.setNow(5 * SEC);
    const arp = createArp();
    const req = arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: ME_IP });
    const actions = arp.onPdu(h.ctx, req, GI0);

    expect(consumes(actions).map((a) => a.pdu.id)).toEqual([req.id]);
    const out = sends(actions);
    expect(out).toHaveLength(1);
    expect(out[0]!.port).toBe(GI0);
    const reply = out[0]!.pdu;
    expect(reply.meta.triggeredBy).toBe(req.id);
    expect(reply.meta.tag).toBe('arp-reply');
    expect(reply.get('ethernet.dst')).toBe(PEER_MAC);
    expect(reply.get('ethernet.src')).toBe(ME_MAC);
    expect(reply.get('ethernet.type')).toBe(ETHERTYPE_ARP);
    expect(reply.get('arp.op')).toBe(ARP_OP_REPLY);
    expect(reply.get('arp.sha')).toBe(ME_MAC);
    expect(reply.get('arp.spa')).toBe(ME_IP);
    expect(reply.get('arp.tha')).toBe(PEER_MAC);
    expect(reply.get('arp.tpa')).toBe(PEER_IP);
    // The wire image round-trips through the decoder.
    const again = h.decode(reply.bytes);
    expect(again.get('arp.sha')).toBe(ME_MAC);
    expect(again.get('ethernet.fcsValid')).toBe(true);
    expect(again.size).toBe(64);
    expect(reply.summary()).toBe(`ARP reply ${ME_IP} is-at ${ME_MAC}`);

    const row = h.tables.arp.get(PEER_IP);
    expect(row).toBeDefined();
    expect(row!.mac).toBe(PEER_MAC);
    expect(row!.iface).toBe(GI0);
    expect(row!.type).toBe('dynamic');
    expect(row!.incomplete).toBeUndefined();
    expect(row!.updatedAt).toBe(5 * SEC);
    expect(row!.expiresAt).toBe(5 * SEC + ARP_HOST_TIMEOUT_NS);
    expect(h.events.filter((e) => e.kind === 'tableWrite' && e.table === 'arp')).toHaveLength(1);
    expect(arp.stateSnapshot().state.repliesSent).toBe(1);
    expect(h.debug.every((d) => d.category === 'arp')).toBe(true);
    expect(arp.debugEvents().length).toBeGreaterThan(0);
  });

  it('uses the router cache timeout on routers', () => {
    const h = makeHarness({ kind: 'router', ports: [{ id: 'GigabitEthernet0/0', mac: ME_MAC, address: ME_IP }] });
    h.setNow(SEC);
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: ME_IP }), 'GigabitEthernet0/0');
    expect(h.tables.arp.get(PEER_IP)!.expiresAt).toBe(SEC + ARP_TIMEOUT_NS);
  });

  it('consumes a request for another host silently, without learning an unknown sender', () => {
    const h = pcHarness();
    const arp = createArp();
    const req = arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: '10.0.0.3' });
    expect(arp.onPdu(h.ctx, req, GI0)).toEqual([]);
    expect(h.tables.arp.size).toBe(0);
    expect(h.debug.at(-1)!.message).toContain('another host');
  });

  it('refreshes a known sender from a request for another host', () => {
    const h = pcHarness();
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: ME_IP }), GI0);
    h.setNow(30 * SEC);
    const actions = arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: '10.0.0.3' }), GI0);
    expect(actions).toEqual([]);
    const row = h.tables.arp.get(PEER_IP)!;
    expect(row.updatedAt).toBe(30 * SEC);
    expect(row.expiresAt).toBe(30 * SEC + ARP_HOST_TIMEOUT_NS);
  });

  it('learns from a reply addressed to me and consumes it', () => {
    const h = pcHarness();
    const arp = createArp();
    const reply = arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP });
    const actions = arp.onPdu(h.ctx, reply, GI0);
    expect(consumes(actions)).toHaveLength(1);
    expect(sends(actions)).toHaveLength(0);
    expect(h.tables.arp.get(PEER_IP)!.mac).toBe(PEER_MAC);
  });

  it('ignores a reply meant for someone else unless the sender is already known', () => {
    const h = pcHarness();
    const arp = createArp();
    const other = arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: '00:1f:00:00:00:09', tpa: '10.0.0.9' });
    expect(arp.onPdu(h.ctx, other, GI0)).toEqual([]);
    expect(h.tables.arp.size).toBe(0);
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    h.setNow(7 * SEC);
    const moved = arpFrame(h, { op: 'reply', sha: '00:1f:00:00:00:22', spa: PEER_IP, tha: '00:1f:00:00:00:09', tpa: '10.0.0.9' });
    expect(arp.onPdu(h.ctx, moved, GI0)).toEqual([]);
    expect(h.tables.arp.get(PEER_IP)!.mac).toBe('00:1f:00:00:00:22');
    expect(h.tables.arp.get(PEER_IP)!.updatedAt).toBe(7 * SEC);
  });

  it('drops frames with an unsupported operation or address sizes', () => {
    const h = pcHarness();
    const arp = createArp();
    const bad = h.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PEER_MAC, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: 3, sha: PEER_MAC, spa: PEER_IP, tha: '00:00:00:00:00:00', tpa: ME_IP } },
    ]);
    const actions = arp.onPdu(h.ctx, bad, GI0);
    expect(drops(actions)).toHaveLength(1);
    expect(drops(actions)[0]!.reason).toBe('other');
    expect(drops(actions)[0]!.detail).toContain('operation 3');
    expect(h.tables.arp.size).toBe(0);

    const odd = h.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PEER_MAC, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: 1, hlen: 8, plen: 4, sha: '0011223344556677', spa: PEER_IP, tha: '0000000000000000', tpa: ME_IP } },
    ]);
    const a2 = arp.onPdu(h.ctx, odd, GI0);
    expect(drops(a2)[0]!.detail).toContain('address sizes');
  });

  it('drops a frame with no ARP layer at all', () => {
    const h = pcHarness();
    const arp = createArp();
    const plain = h.build([
      { proto: 'ethernet', fields: { dst: ME_MAC, src: PEER_MAC, type: 0x88b5 } },
      { proto: 'payload', fields: { data: new Uint8Array(10) } },
    ]);
    const actions = arp.onPdu(h.ctx, plain, GI0);
    expect(drops(actions)).toHaveLength(1);
    expect(drops(actions)[0]!.reason).toBe('other');
  });

  it('never learns a sender claiming one of my own addresses', () => {
    const h = pcHarness();
    const arp = createArp();
    const spoof = arpFrame(h, { op: 'request', sha: PEER_MAC, spa: ME_IP, tha: '00:00:00:00:00:00', tpa: ME_IP });
    expect(arp.onPdu(h.ctx, spoof, GI0)).toEqual([]);
    expect(h.tables.arp.size).toBe(0);
    expect(h.debug.at(-1)!.message).toContain('claims my address');
  });
});
