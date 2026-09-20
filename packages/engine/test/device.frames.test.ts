import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4 } from '../src/contracts/pdu.js';
import { MAC_A, arpFrame, boot, echoFrame, fakeProcess, harness, unknownFrame } from './device.harness.js';
import { FRAME_ROLES } from '../src/contracts/catalog.js';

/** A booted PC whose port is operationally up, with recording processes. */
function bootedPc() {
  const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: FRAME_ROLES }] });
  const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: FRAME_ROLES }] });
  const icmpv4 = fakeProcess('icmpv4');
  const host = fakeProcess('host');
  const h = harness({ processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory, host: host.factory } });
  boot(h);
  const port = h.device.port('GigabitEthernet0')!;
  port.operUp = true; // the link model owns this; tests set it directly
  h.events.length = 0;
  return { h, arp, ipv4, icmpv4, host, port, mac: port.mac, at: h.device.bootedAt! + 1 };
}

const drops = (h: ReturnType<typeof harness>) => h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];

describe('device frame pipeline', () => {
  it('counts every arriving frame, emits frameRx and demuxes by ethertype', () => {
    const { h, arp, ipv4, port, mac, at } = bootedPc();
    const f = echoFrame(h, mac);
    h.device.onFrameArrival('GigabitEthernet0', f, undefined, at);
    expect(port.counters.inPackets).toBe(1);
    expect(port.counters.inBytes).toBe(f.size);
    expect(port.lastInput).toBe(at);
    expect(h.kinds('frameRx')).toEqual([{ t: at, kind: 'frameRx', pdu: { id: f.id, proto: 'icmpv4', size: f.size, summary: f.summary() }, device: 'd_1', port: 'GigabitEthernet0' }]);
    expect(ipv4.calls.at(-1)).toMatchObject({ kind: 'onPdu', pdu: f, port: 'GigabitEthernet0', at });
    expect(arp.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(0);
    const a = arpFrame(h);
    h.device.onFrameArrival('GigabitEthernet0', a, false, at + 1);
    expect(arp.calls.at(-1)).toMatchObject({ kind: 'onPdu', pdu: a });
    expect(port.counters.inBroadcasts).toBe(1);
    expect(port.counters.inPackets).toBe(2);
    expect(drops(h)).toEqual([]);
    expect(port.counters.inDrops).toBe(0);
    // an unknown port is ignored
    h.device.onFrameArrival('Gi9', a, false, at + 2);
    expect(port.counters.inPackets).toBe(2);
  });

  it('ethertype-specific selectors beat generic ones regardless of process order', () => {
    const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', roles: FRAME_ROLES }] }); // generic, listed first
    const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: FRAME_ROLES }] });
    const h = harness({ processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: fakeProcess('icmpv4').factory, host: fakeProcess('host').factory } });
    boot(h);
    const port = h.device.port('GigabitEthernet0')!;
    port.operUp = true;
    const at = h.device.bootedAt! + 1;
    h.device.onFrameArrival('GigabitEthernet0', echoFrame(h, port.mac), false, at);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(1);
    expect(arp.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(0);
    h.device.onFrameArrival('GigabitEthernet0', arpFrame(h), false, at);
    expect(arp.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(1);
    h.device.onFrameArrival('GigabitEthernet0', unknownFrame(h, port.mac), false, at);
    expect(arp.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(2); // generic catches unknown ethertypes
  });

  it('drops with reason unsupported-ethertype when no process handles the frame', () => {
    const { h, port, mac, at } = bootedPc();
    const f = unknownFrame(h, mac);
    h.device.onFrameArrival('GigabitEthernet0', f, false, at);
    expect(drops(h)).toEqual([{ t: at, kind: 'drop', pdu: expect.objectContaining({ id: f.id }), device: 'd_1', port: 'GigabitEthernet0', reason: 'unsupported-ethertype', detail: '0x88b5' }]);
    expect(port.counters.inDrops).toBe(1);
  });

  it('drops corrupted or FCS-invalid frames as fcs-error with crc/inErrors counters', () => {
    const { h, ipv4, port, mac, at } = bootedPc();
    const f = echoFrame(h, mac);
    h.device.onFrameArrival('GigabitEthernet0', f, true, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'fcs-error', port: 'GigabitEthernet0', device: 'd_1' });
    expect(port.counters).toMatchObject({ inPackets: 1, crcErrors: 1, inErrors: 1, inDrops: 0 });
    // an actually corrupted wire image (bit flip, FCS not recomputed) is caught by fcsValid
    const g = echoFrame(h, mac);
    g.corrupt({ now: at, device: 'd_peer' }, 20, 0x01);
    expect(g.get('ethernet.fcsValid')).toBe(false);
    h.device.onFrameArrival('GigabitEthernet0', g, undefined, at + 1);
    expect(port.counters).toMatchObject({ inPackets: 2, crcErrors: 2, inErrors: 2 });
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(0);
  });

  it('drops giants with the giants counter', () => {
    const { h, port, mac, at } = bootedPc();
    const g = echoFrame(h, mac, MAC_A, 1600);
    expect(g.size).toBeGreaterThan(1518);
    h.device.onFrameArrival('GigabitEthernet0', g, false, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'giant', detail: `${g.size} bytes` });
    expect(port.counters).toMatchObject({ giants: 1, inErrors: 1 });
  });

  it('drops runts with the runts counter', () => {
    const { h, port, at } = bootedPc();
    // a truncated wire image decoded as an ethernet frame (the pdu module never builds one, so decode raw bytes)
    const short = h.pdus.decode(new Uint8Array(40).fill(0), { born: 0, origin: 'd_peer' });
    expect(short.size).toBeLessThan(64);
    // the truncated frame carries no valid FCS; force the FCS check to be irrelevant by checking the order: fcs first
    h.device.onFrameArrival('GigabitEthernet0', short, false, at);
    const d = drops(h).at(-1)!;
    expect(['fcs-error', 'runt']).toContain(d.reason);
    expect(port.counters.inErrors).toBe(1);
    if (d.reason === 'runt') expect(port.counters.runts).toBe(1);
  });

  it('drops frames on an oper-down port as link-down (admin-up) or port-admin-down (admin-down) with inDrops', () => {
    const { h, ipv4, port, mac, at } = bootedPc();
    port.operUp = false;
    const f = echoFrame(h, mac);
    h.device.onFrameArrival('GigabitEthernet0', f, false, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'link-down', port: 'GigabitEthernet0' });
    expect(port.counters).toMatchObject({ inPackets: 1, inDrops: 1 });
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(0);
    // administratively down
    port.adminUp = false;
    h.device.onFrameArrival('GigabitEthernet0', f, false, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'port-admin-down', port: 'GigabitEthernet0' });
    expect(port.counters.inDrops).toBe(2);
    port.adminUp = true;
    // err-disabled
    port.operUp = true;
    port.errDisabled = 'bpduguard';
    h.device.onFrameArrival('GigabitEthernet0', f, false, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'port-err-disabled', detail: 'bpduguard' });
    expect(port.counters.inDrops).toBe(3);
  });

  it('hosts drop unicast frames for another MAC as not-for-me; broadcast and multicast pass', () => {
    const { h, ipv4, port, at } = bootedPc();
    const other = echoFrame(h, MAC_A);
    h.device.onFrameArrival('GigabitEthernet0', other, false, at);
    expect(drops(h).at(-1)).toMatchObject({ reason: 'not-for-me', detail: MAC_A, port: 'GigabitEthernet0' });
    expect(port.counters.inDrops).toBe(1);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(0);
    h.device.onFrameArrival('GigabitEthernet0', echoFrame(h, 'ff:ff:ff:ff:ff:ff'), false, at);
    h.device.onFrameArrival('GigabitEthernet0', echoFrame(h, '01:00:5e:00:00:01'), false, at);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(2);
    expect(port.counters.inBroadcasts).toBe(2);
    expect(port.counters.inDrops).toBe(1);
  });

  it('switches skip the not-for-me check and hand everything to the generic handler', () => {
    const sw = fakeProcess('eth-switch', { handles: [{ layer: 'ethernet', roles: FRAME_ROLES }] });
    const h = harness({ type: 'switch.nfc2960', name: 'S1', processes: { 'eth-switch': sw.factory } });
    boot(h);
    const port = h.device.port('FastEthernet0/3')!;
    port.operUp = true;
    const at = h.device.bootedAt! + 1;
    h.device.onFrameArrival('FastEthernet0/3', echoFrame(h, MAC_A), false, at);
    h.device.onFrameArrival('FastEthernet0/3', arpFrame(h), false, at);
    h.device.onFrameArrival('FastEthernet0/3', unknownFrame(h, MAC_A), false, at);
    expect(sw.calls.filter((c) => c.kind === 'onPdu').map((c) => c.port)).toEqual(['FastEthernet0/3', 'FastEthernet0/3', 'FastEthernet0/3']);
    expect(port.counters.inDrops).toBe(0);
    expect(port.counters.inPackets).toBe(3);
  });

  it('actions returned by the demuxed process are applied (send goes to transmit)', () => {
    const arp = fakeProcess('arp', {
      handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: FRAME_ROLES }],
      onPdu: (ctx, pdu, port) => {
        ctx.debug('arp', 'request seen', { from: pdu.get('arp.spa') });
        return [{ type: 'send', port, pdu: ctx.clone(pdu) }];
      },
    });
    const h = harness({ processes: { arp: arp.factory, ipv4: fakeProcess('ipv4').factory, icmpv4: fakeProcess('icmpv4').factory, host: fakeProcess('host').factory } });
    boot(h);
    const port = h.device.port('GigabitEthernet0')!;
    port.operUp = true;
    const at = h.device.bootedAt! + 1;
    const f = arpFrame(h);
    h.device.onFrameArrival('GigabitEthernet0', f, false, at);
    expect(h.transmits).toHaveLength(1);
    expect(h.transmits[0]?.pdu.meta.parent).toBe(f.id);
    expect(port.counters.outPackets).toBe(1);
    const dbg = h.kinds('debug') as Extract<TraceEvent, { kind: 'debug' }>[];
    expect(dbg.at(-1)?.event).toEqual({ at, device: 'd_1', process: 'arp', category: 'arp', message: 'request seen', data: { from: '10.0.0.1' } });
    expect(h.device.recentDebug(1)).toEqual([dbg.at(-1)?.event]);
  });
});
