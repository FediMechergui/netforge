import { describe, expect, it } from 'vitest';
import { ARP_SWEEP_NS, createArp } from '../src/protocols/arp.js';
import { MAC_BROADCAST, MAC_ZERO } from '../src/contracts/addr.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import { ARP_HOST_TIMEOUT_NS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { arpFrame, cancels, drops, echoPacket, makeHarness, sends, timers } from './arp.harness.js';

const ME_MAC = '00:1f:00:00:00:01';
const ME_IP = '10.0.0.1';
const PEER_MAC = '00:1f:00:00:00:02';
const PEER_IP = '10.0.0.2';
const GI0 = 'GigabitEthernet0';
const GARP_KEY = `garp:${GI0}`;

function pcHarness() {
  return makeHarness({ ports: [{ id: GI0, mac: ME_MAC, address: ME_IP }] });
}

describe('arp lifecycle', () => {
  it('init arms the ageing sweep and the sweep expires aged rows then re-arms', () => {
    const h = pcHarness();
    const arp = createArp();
    expect(arp.init!(h.ctx)).toEqual([{ type: 'timer', key: 'arp-sweep', delay: 60 * SEC, periodic: true }]);
    expect(ARP_SWEEP_NS).toBe(60 * SEC);

    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    h.setNow(60 * SEC);
    expect(arp.onTimer(h.ctx, 'arp-sweep')).toEqual([{ type: 'timer', key: 'arp-sweep', delay: ARP_SWEEP_NS, periodic: true }]);
    expect(h.tables.arp.size).toBe(1);

    h.setNow(ARP_HOST_TIMEOUT_NS + 60 * SEC);
    expect(arp.onTimer(h.ctx, 'arp-sweep')).toEqual([{ type: 'timer', key: 'arp-sweep', delay: ARP_SWEEP_NS, periodic: true }]);
    expect(h.tables.arp.size).toBe(0);
    const exp = h.events.filter((e) => e.kind === 'tableExpire');
    expect(exp).toHaveLength(1);
    expect(exp[0]!.kind === 'tableExpire' && exp[0]!.reason).toBe('aged');
    expect(h.debug.at(-1)!.message).toContain('timed out');
  });

  it('ip address config arms a zero-delay announcement timer that sends a gratuitous request', () => {
    const h = pcHarness();
    h.setNow(3 * SEC);
    const arp = createArp();
    const actions = arp.onConfig(h.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', ME_IP, '255.255.255.0'] });
    expect(actions).toEqual([{ type: 'timer', key: GARP_KEY, delay: 0 }]);

    const fired = arp.onTimer(h.ctx, GARP_KEY);
    expect(fired.map((a) => a.type)).toEqual(['send']);
    const g = sends(fired)[0]!;
    expect(g.port).toBe(GI0);
    expect(g.pdu.meta.tag).toBe('arp-gratuitous');
    expect(g.pdu.get('ethernet.dst')).toBe(MAC_BROADCAST);
    expect(g.pdu.get('ethernet.src')).toBe(ME_MAC);
    expect(g.pdu.get('ethernet.type')).toBe(ETHERTYPE_ARP);
    expect(g.pdu.get('arp.op')).toBe(ARP_OP_REQUEST);
    expect(g.pdu.get('arp.sha')).toBe(ME_MAC);
    expect(g.pdu.get('arp.spa')).toBe(ME_IP);
    expect(g.pdu.get('arp.tha')).toBe(MAC_ZERO);
    expect(g.pdu.get('arp.tpa')).toBe(ME_IP);
    expect(arp.stateSnapshot().state.gratuitousSent).toBe(1);
  });

  it('a gratuitous request and the announcement timer at the same instant send only once', () => {
    const h = pcHarness();
    h.setNow(3 * SEC);
    const arp = createArp();
    arp.onConfig(h.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', ME_IP, '255.255.255.0'] });
    expect(sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0 }))).toHaveLength(1);
    expect(arp.onTimer(h.ctx, GARP_KEY)).toEqual([]);
    expect(arp.stateSnapshot().state.gratuitousSent).toBe(1);
    // A later announcement is sent again.
    h.setNow(4 * SEC);
    expect(sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0 }))).toHaveLength(1);
  });

  it('does not announce on a down port, an unknown port or a port without an address', () => {
    const h = makeHarness({ ports: [{ id: GI0, mac: ME_MAC, address: ME_IP, operUp: false }, { id: 'GigabitEthernet1', mac: '00:1f:00:00:00:03' }] });
    const arp = createArp();
    expect(arp.onTimer(h.ctx, GARP_KEY)).toEqual([]);
    expect(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: 'GigabitEthernet1' })).toEqual([]);
    expect(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: 'Nope0' })).toEqual([]);
    expect(arp.stateSnapshot().state.gratuitousSent).toBe(0);
  });

  it('ignores config lines it does not own', () => {
    const h = pcHarness();
    const arp = createArp();
    expect(arp.onConfig(h.ctx, { op: 'set', context: [], line: ['hostname', 'PC1'] })).toEqual([]);
    expect(arp.onConfig(h.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] })).toEqual([]);
    expect(arp.onConfig(h.ctx, { op: 'set', context: [['interface', GI0]], line: ['shutdown'] })).toEqual([]);
  });

  it('link down purges rows learned on the port and drops its pending packets', () => {
    const h = makeHarness({
      kind: 'router',
      ports: [
        { id: 'GigabitEthernet0/0', mac: '00:1f:00:00:00:10', address: '10.0.0.254' },
        { id: 'GigabitEthernet0/1', mac: '00:1f:00:00:00:11', address: '10.0.1.254' },
      ],
    });
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: '00:1f:00:00:00:02', spa: '10.0.0.1', tha: '00:1f:00:00:00:10', tpa: '10.0.0.254' }), 'GigabitEthernet0/0');
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: '00:1f:00:00:00:22', spa: '10.0.1.2', tha: '00:1f:00:00:00:11', tpa: '10.0.1.254' }), 'GigabitEthernet0/1');
    const waiting = echoPacket(h, '10.0.0.254', '10.0.0.7');
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: waiting, nextHop: '10.0.0.7', iface: 'GigabitEthernet0/0' });
    expect(h.tables.arp.size).toBe(3);

    h.setNow(SEC);
    h.ports.get('GigabitEthernet0/0')!.operUp = false;
    const actions = arp.onLinkChange!(h.ctx, 'GigabitEthernet0/0', false);
    expect(cancels(actions).map((c) => c.key)).toEqual(['arp-retry:GigabitEthernet0/0:10.0.0.7']);
    expect(drops(actions)).toEqual([{ type: 'drop', pdu: waiting, reason: 'link-down', detail: 'GigabitEthernet0/0 went down', port: 'GigabitEthernet0/0' }]);
    expect(h.tables.arp.rows().map((r) => r.ip)).toEqual(['10.0.1.2']);
    const exp = h.events.filter((e) => e.kind === 'tableExpire' && e.table === 'arp');
    expect(exp).toHaveLength(2);
    expect(exp.every((e) => e.kind === 'tableExpire' && e.reason === 'link-down' && e.t === SEC)).toBe(true);
    expect(arp.stateSnapshot().state.pending).toEqual([]);
    // Link up changes nothing.
    expect(arp.onLinkChange!(h.ctx, 'GigabitEthernet0/0', true)).toEqual([]);
    // A late retry for the forgotten resolution is a no-op.
    expect(arp.onTimer(h.ctx, 'arp-retry:GigabitEthernet0/0:10.0.0.7')).toEqual([]);
  });

  it('a retry on a port that went down without notice gives up with link-down', () => {
    const h = pcHarness();
    const arp = createArp();
    const waiting = echoPacket(h, ME_IP, PEER_IP);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: waiting, nextHop: PEER_IP, iface: GI0 });
    h.ports.get(GI0)!.operUp = false;
    h.setNow(SEC);
    const actions = arp.onTimer(h.ctx, `arp-retry:${GI0}:${PEER_IP}`);
    expect(drops(actions).map((d) => d.reason)).toEqual(['link-down']);
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state.failed).toBe(1);
  });

  it('removing the interface address purges its rows and pending packets', () => {
    const h = pcHarness();
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    const waiting = echoPacket(h, ME_IP, '10.0.0.9');
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: waiting, nextHop: '10.0.0.9', iface: GI0 });
    const actions = arp.onConfig(h.ctx, { op: 'unset', context: [['interface', GI0]], line: ['ip', 'address'], before: [ME_IP, '255.255.255.0'] });
    expect(cancels(actions).map((c) => c.key)).toEqual([GARP_KEY, `arp-retry:${GI0}:10.0.0.9`]);
    expect(drops(actions).map((d) => [d.pdu.id, d.reason])).toEqual([[waiting.id, 'no-l3-address']]);
    expect(h.tables.arp.size).toBe(0);
  });

  it('changing the interface address flushes the old subnet and re-announces', () => {
    const h = pcHarness();
    const arp = createArp();
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    const actions = arp.onConfig(h.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', '10.0.5.1', '255.255.255.0'], before: [ME_IP, '255.255.255.0'] });
    expect(timers(actions)).toEqual([{ type: 'timer', key: GARP_KEY, delay: 0 }]);
    expect(h.tables.arp.size).toBe(0);
    // Re-applying the same address keeps the cache.
    arp.onPdu(h.ctx, arpFrame(h, { op: 'reply', sha: PEER_MAC, spa: PEER_IP, tha: ME_MAC, tpa: ME_IP }), GI0);
    arp.onConfig(h.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', ME_IP, '255.255.255.0'], before: [ME_IP, '255.255.255.0'] });
    expect(h.tables.arp.size).toBe(1);
  });

  it('unknown timers are ignored and the snapshot is structured-clone safe', () => {
    const h = pcHarness();
    const arp = createArp();
    expect(arp.onTimer(h.ctx, 'bogus')).toEqual([]);
    expect(arp.onTimer(h.ctx, 'arp-retry:')).toEqual([]);
    const snap = arp.stateSnapshot();
    expect(structuredClone(snap)).toEqual(snap);
    expect(snap.state).toEqual({ pending: [], requestsSent: 0, repliesSent: 0, gratuitousSent: 0, resolved: 0, failed: 0 });
  });
});
