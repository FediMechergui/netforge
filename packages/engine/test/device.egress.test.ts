import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import type { MediumOp } from '../src/contracts/medium.js';
import { ETHERTYPE_ARP, ICMP_ECHO_REQUEST, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MAC_A, MAC_B, arpFrame, boot, echoFrame, fakeProcess, harness } from './device.harness.js';

const drops = (h: ReturnType<typeof harness>) => h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];

function pc(opts: { mediumOps?: boolean } = {}) {
  const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }] });
  const ipv4 = fakeProcess('ipv4');
  const icmpv4 = fakeProcess('icmpv4');
  const host = fakeProcess('host');
  const h = harness({ processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory, host: host.factory }, ...opts });
  boot(h);
  return { h, d: h.device, arp, host, at: h.device.bootedAt! + 1 };
}

describe('egress by role (§3.2)', () => {
  it('link egress: deferred results count nothing, retries add to txRetries, refusals count outDrops', () => {
    const { h, d, at } = pc();
    const port = d.port('GigabitEthernet0')!;
    const f = arpFrame(h);
    h.setTransmit((_f, _p, now) => ({ ok: true, link: 'seg:l_1', txStart: now, txEnd: now, arrive: now, deferred: true }));
    d.applyActions('arp', [{ type: 'send', port: 'GigabitEthernet0', pdu: f }], at);
    expect(port.counters.outPackets).toBe(0);
    expect(port.lastOutput).toBeUndefined();
    h.setTransmit((_f, _p, now) => ({ ok: true, link: 'bss:d_9/Wlan0', txStart: now + 5, txEnd: now + 9, arrive: now + 10, retries: 2 }));
    d.applyActions('arp', [{ type: 'send', port: 'GigabitEthernet0', pdu: f }], at);
    expect(port.counters).toMatchObject({ outPackets: 1, outBytes: f.size, txRetries: 2 });
    expect(port.lastOutput).toBe(at + 5);
    h.setTransmit(() => ({ ok: false, reason: 'not-associated' }));
    d.applyActions('arp', [{ type: 'send', port: 'GigabitEthernet0', pdu: f }], at);
    expect(port.counters).toMatchObject({ outPackets: 1, outDrops: 1 });
  });

  it('owner egress: another process sending on an SVI is counted there and handed to the owner onEgress', () => {
    const sw = fakeProcess('eth-switch', { onEgress: (_c, pdu) => [{ type: 'send', port: 'GigabitEthernet1/0/1', pdu }] });
    const arp = fakeProcess('arp');
    const h = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', processes: { 'eth-switch': sw.factory, arp: arp.factory } });
    boot(h);
    const d = h.device;
    const at = d.bootedAt! + 1;
    const f = arpFrame(h);
    h.events.length = 0;
    d.applyActions('arp', [{ type: 'send', port: 'Vlan1', pdu: f }], at);
    expect(sw.calls.filter((c) => c.kind === 'onEgress').map((c) => [c.port, c.pdu?.id])).toEqual([['Vlan1', f.id]]);
    expect(d.port('Vlan1')!.counters).toMatchObject({ outPackets: 1, outBytes: f.size });
    expect(d.port('Vlan1')!.lastOutput).toBe(at);
    expect(h.transmits.map((t) => t.from)).toEqual([{ device: 'd_1', port: 'GigabitEthernet1/0/1' }]);
    expect(d.port('GigabitEthernet1/0/1')!.counters.outPackets).toBe(1);

    // the owner's own send on the SVI never re-enters onEgress
    d.applyActions('eth-switch', [{ type: 'send', port: 'Vlan1', pdu: f }], at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'other', detail: 'virtual-transmit', port: 'Vlan1' });
    expect(sw.calls.filter((c) => c.kind === 'onEgress')).toHaveLength(1);
    expect(d.port('Vlan1')!.counters.outPackets).toBe(1);
  });

  it('owner egress without a running owner drops no-owner', () => {
    const arp = fakeProcess('arp');
    const h = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', processes: { arp: arp.factory } });
    boot(h);
    const f = arpFrame(h);
    h.device.applyActions('arp', [{ type: 'send', port: 'Vlan1', pdu: f }], h.device.bootedAt!);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'other', detail: 'no-owner:svi', port: 'Vlan1' });
    expect(h.device.port('Vlan1')!.counters.outPackets).toBe(0);
    expect(h.transmits).toEqual([]);
  });

  it('loop egress: a loopback send is counted out and re-enters the pipeline at the IP layer', () => {
    const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ipv4', roles: ['virtual'] }] });
    const icmpv4 = fakeProcess('icmpv4');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { ipv4: ipv4.factory, icmpv4: icmpv4.factory } });
    boot(h);
    const d = h.device;
    const at = d.bootedAt! + 1;
    d.ensureVirtualPort?.('Loopback0', at);
    const packet = h.pdus.build([
      { proto: 'ipv4', fields: { src: '1.1.1.1', dst: '1.1.1.1', protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    ], { born: at, origin: 'd_1' });
    d.applyActions('icmpv4', [{ type: 'send', port: 'Loopback0', pdu: packet }], at);
    const lo = d.port('Loopback0')!;
    expect(lo.counters).toMatchObject({ outPackets: 1, outBytes: packet.size, inPackets: 1, inBytes: packet.size });
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu').map((c) => [c.port, c.pdu?.id])).toEqual([['Loopback0', packet.id]]);
    expect(h.transmits).toEqual([]);
  });

  it('loop egress without an IP-layer handler drops unsupported-protocol', () => {
    const icmpv4 = fakeProcess('icmpv4');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { icmpv4: icmpv4.factory } });
    boot(h);
    const d = h.device;
    const at = d.bootedAt!;
    d.ensureVirtualPort?.('Loopback1', at);
    const packet = h.pdus.build([
      { proto: 'ipv4', fields: { src: '1.1.1.1', dst: '1.1.1.1', protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    ], { born: at, origin: 'd_1' });
    d.applyActions('icmpv4', [{ type: 'send', port: 'Loopback1', pdu: packet }], at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'unsupported-protocol', detail: 'no-handler-ipv4', port: 'Loopback1' });
    expect(d.port('Loopback1')!.counters.inDrops).toBe(1);
  });
});

describe('the ingress action (§3.1)', () => {
  it('demuxes at the MAC filter step on an SVI; group frames count inBroadcasts; other unicast is not-for-me', () => {
    const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }] });
    const sw = fakeProcess('eth-switch');
    const h = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', processes: { 'eth-switch': sw.factory, arp: arp.factory } });
    boot(h);
    const d = h.device;
    const at = d.bootedAt! + 1;
    const a = arpFrame(h);
    d.applyActions('eth-switch', [{ type: 'ingress', port: 'Vlan1', pdu: a }], at);
    expect(arp.calls.filter((c) => c.kind === 'onPdu').map((c) => c.port)).toEqual(['Vlan1']);
    const vlan = d.port('Vlan1')!;
    expect(vlan.counters).toMatchObject({ inPackets: 1, inBytes: a.size, inBroadcasts: 1, inDrops: 0 });
    expect(vlan.lastInput).toBe(at);

    d.applyActions('eth-switch', [{ type: 'ingress', port: 'Vlan1', pdu: echoFrame(h, MAC_A) }], at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'not-for-me', detail: MAC_A, port: 'Vlan1' });
    expect(vlan.counters.inDrops).toBe(1);

    // physical ports were counted on arrival; the ingress action does not count them again
    d.applyActions('eth-switch', [{ type: 'ingress', port: 'GigabitEthernet1/0/3', pdu: echoFrame(h, MAC_B) }], at);
    expect(d.port('GigabitEthernet1/0/3')!.counters.inPackets).toBe(0);

    d.applyActions('eth-switch', [{ type: 'ingress', port: 'Nope', pdu: a }], at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'other', detail: 'unknown-port:Nope' });
  });

  it('receive detail: a collided frame drops without error counters; a fragment counts its bytes and a runt', () => {
    const { h, d, at } = pc();
    const port = d.port('GigabitEthernet0')!;
    port.operUp = true;
    const f = echoFrame(h, port.mac);
    d.onFrameArrival('GigabitEthernet0', f, false, at, { collided: true });
    expect(drops(h).at(-1)).toMatchObject({ reason: 'collision' });
    expect(port.counters).toMatchObject({ inPackets: 1, inBytes: f.size, inErrors: 0, inDrops: 0 });
    d.onFrameArrival('GigabitEthernet0', f, false, at, { fragmentBytes: 40 });
    expect(drops(h).at(-1)).toMatchObject({ reason: 'runt', detail: '40 bytes' });
    expect(port.counters).toMatchObject({ inPackets: 2, inBytes: f.size + 40, runts: 1, inErrors: 1 });
  });
});

describe('deferred outcomes and medium notifications', () => {
  it('onTxOutcome applies counter results and emits nothing', () => {
    const { h, d, at } = pc();
    const port = d.port('GigabitEthernet0')!;
    h.events.length = 0;
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'deferred', pdu: 7 }, at);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'collision', pdu: 7, late: false, attempt: 1 }, at);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'collision', pdu: 7, late: true, attempt: 2 }, at);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'sent', pdu: 7, txStart: at + 3, bytes: 98 }, at + 9);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'dropped', pdu: 8, reason: 'excessive-collisions' }, at + 9);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'dropped', pdu: 9, reason: 'late-collision' }, at + 9);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'repeated', bytes: 64, dir: 'in' }, at + 10);
    d.onTxOutcome?.('GigabitEthernet0', { kind: 'repeated', bytes: 70, dir: 'out' }, at + 11);
    d.onTxOutcome?.('Nope', { kind: 'deferred', pdu: 1 }, at + 12);
    expect(port.counters).toMatchObject({
      deferred: 1, collisions: 2, lateCollisions: 1, outPackets: 2, outBytes: 168, outDrops: 2, excessiveCollisions: 1, inPackets: 1, inBytes: 64,
    });
    expect(port.lastOutput).toBe(at + 11);
    expect(h.events).toEqual([]);
  });

  it('onMediumEvent fans out in daemon order and applies each process actions', () => {
    const seen: string[] = [];
    const arp = fakeProcess('arp', { onMediumEvent: (_c, port, ev) => { seen.push(`arp ${port} ${ev.kind}`); return [{ type: 'log', severity: 6, facility: 'T', message: 'from-arp' }]; } });
    const host = fakeProcess('host', { onMediumEvent: (_c, port, ev) => { seen.push(`host ${port} ${ev.kind}`); return []; } });
    const h = harness({ processes: { arp: arp.factory, ipv4: fakeProcess('ipv4').factory, icmpv4: fakeProcess('icmpv4').factory, host: host.factory } });
    boot(h);
    const at = h.device.bootedAt! + 1;
    h.events.length = 0;
    h.device.onMediumEvent?.('GigabitEthernet0', { kind: 'carrier', up: true }, at);
    expect(seen).toEqual(['arp GigabitEthernet0 carrier', 'host GigabitEthernet0 carrier']);
    expect(h.kinds('log')).toEqual([{ t: at, kind: 'log', device: 'd_1', severity: 6, facility: 'T', message: 'from-arp' }]);
    h.device.onMediumEvent?.('Nope', { kind: 'carrier', up: false }, at);
    expect(seen).toHaveLength(2);
  });

  it('medium actions reach deps.mediumOp; a request on an unknown port is dropped with a runtime debug event', () => {
    const op: MediumOp = { op: 'line-protocol', up: false, reason: 'keepalive-missed' };
    const a = pc();
    a.d.applyActions('host', [{ type: 'medium', port: 'GigabitEthernet0', op }], a.at);
    expect(a.h.mediumOps).toEqual([{ from: { device: 'd_1', port: 'GigabitEthernet0' }, op, now: a.at }]);
    const b = pc();
    b.h.events.length = 0;
    b.d.applyActions('host', [{ type: 'medium', port: 'Nope', op }], b.at);
    expect(b.h.mediumOps).toEqual([]);
    expect(b.h.kinds('debug')).toEqual([{
      t: b.at, kind: 'debug',
      event: { at: b.at, device: 'd_1', process: 'host', category: 'runtime', message: 'medium request line-protocol on Nope ignored: no medium' },
    }]);
  });

  it('ctx.rewrap is a recorded structural write mirrored to the trace', () => {
    const { h, arp, at } = pc();
    const ctx = arp.ctx!;
    const f = arpFrame(h);
    h.device.onPortOper('GigabitEthernet0', true, at);
    h.events.length = 0;
    ctx.rewrap?.(f, { strip: 1, push: [{ proto: 'ethernet', fields: { dst: MAC_B, src: ctx.macOf('GigabitEthernet0') } }] }, 'reframe');
    expect(f.layers.map((l) => l.proto)).toEqual(['ethernet', 'arp']);
    expect(f.get('ethernet.src')).toBe(ctx.macOf('GigabitEthernet0'));
    expect(f.provenance.map((m) => [m.reason, m.device, m.at, m.cause])).toEqual([['Decapsulate', 'd_1', at, 'reframe'], ['Encapsulate', 'd_1', at, 'reframe']]);
    const muts = h.kinds('mutation') as Extract<TraceEvent, { kind: 'mutation' }>[];
    expect(muts.map((m) => m.mutation)).toEqual([...f.provenance]);
    expect(muts.every((m) => m.pdu === f.id && m.t === at)).toBe(true);
  });
});
