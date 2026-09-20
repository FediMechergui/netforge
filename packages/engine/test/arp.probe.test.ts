/**
 * arp.probe / arp.probeResult (ARCHITECTURE-P1 §4.3 APIPA, §12 finding 10; contracts/process.ts `arp.probe`):
 * address conflict detection after RFC 5227 §2.1 — probes are ARP requests with sender IP 0.0.0.0, sent 3 times
 * 1 s apart; a conflict is an ARP whose sender IP is the candidate, or another station's probe for it; the cache is
 * never touched by probing.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST, MAC_ZERO } from '../src/contracts/addr.js';
import { ARP_OP_REQUEST } from '../src/contracts/pdu.js';
import type { Action } from '../src/contracts/process.js';
import { APIPA_PROBES, APIPA_PROBE_INTERVAL_NS } from '../src/contracts/services.js';
import { SEC } from '../src/contracts/time.js';
import { createArp } from '../src/protocols/arp.js';
import { arpFrame, cancels, makeHarness, sends, timers } from './arp.harness.js';

const GI0 = 'GigabitEthernet0';
const GI1 = 'GigabitEthernet1';
const MY_MAC = '00:1f:00:00:00:01';
const OTHER_MAC = '00:1f:00:00:00:99';
const CANDIDATE = '169.254.17.3';
const TOKEN = 'apipa:GigabitEthernet0';

const events = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'event' }> => a.type === 'event');

function setup() {
  const h = makeHarness({ ports: [{ id: GI0, mac: MY_MAC }, { id: GI1, mac: '00:1f:00:00:00:02' }] });
  const arp = createArp();
  return { h, arp };
}

function start(h: ReturnType<typeof setup>['h'], arp: ReturnType<typeof createArp>, extra: { count?: number; intervalNs?: number; iface?: string } = {}): Action[] {
  return arp.onRequest!(h.ctx, { kind: 'arp.probe', owner: 'dhcp-client', token: TOKEN, iface: extra.iface ?? GI0, address: CANDIDATE, ...extra });
}

describe('arp.probe', () => {
  it('sends 3 probes 1 s apart (spa 0.0.0.0, broadcast) on a non-periodic timer, then reports no conflict', () => {
    const { h, arp } = setup();
    expect(APIPA_PROBES).toBe(3);
    expect(APIPA_PROBE_INTERVAL_NS).toBe(SEC);
    const sentAt: number[] = [];
    let out = start(h, arp);
    for (let i = 1; i <= 3; i++) {
      const s = sends(out);
      expect(s).toHaveLength(1);
      expect(s[0]!.port).toBe(GI0);
      const f = s[0]!.pdu;
      sentAt.push(h.ctx.now);
      expect(f.meta.tag).toBe('arp-probe');
      expect(f.get('ethernet.dst')).toBe(MAC_BROADCAST);
      expect(f.get('ethernet.src')).toBe(MY_MAC);
      expect(f.get('arp.op')).toBe(ARP_OP_REQUEST);
      expect(f.get('arp.spa')).toBe('0.0.0.0');
      expect(f.get('arp.sha')).toBe(MY_MAC);
      expect(f.get('arp.tha')).toBe(MAC_ZERO);
      expect(f.get('arp.tpa')).toBe(CANDIDATE);
      // the bytes on the wire decode to the same probe
      expect(h.decode(f.bytes).get('arp.spa')).toBe('0.0.0.0');
      expect(timers(out)).toEqual([{ type: 'timer', key: `arp-probe:${TOKEN}`, delay: SEC }]);
      expect(events(out)).toEqual([]);
      h.setNow(i * SEC);
      out = arp.onTimer(h.ctx, `arp-probe:${TOKEN}`);
    }
    expect(sentAt).toEqual([0, SEC, 2 * SEC]);
    // the interval after the last probe ended without a conflict
    expect(sends(out)).toEqual([]);
    expect(cancels(out)).toEqual([{ type: 'cancelTimer', key: `arp-probe:${TOKEN}` }]);
    expect(events(out)).toEqual([
      { type: 'event', to: 'dhcp-client', ev: { kind: 'arp.probeResult', token: TOKEN, iface: GI0, address: CANDIDATE, conflict: false } },
    ]);
    expect(h.ctx.now).toBe(3 * SEC);
    // no address was needed and the cache was never written
    expect(h.ports.get(GI0)!.l3.ipv4).toBeUndefined();
    expect(h.events.filter((e) => e.kind === 'tableWrite' || e.kind === 'tableExpire')).toEqual([]);
    expect(arp.onTimer(h.ctx, `arp-probe:${TOKEN}`)).toEqual([]);
    expect(arp.stateSnapshot().state.probes).toBeUndefined();
  });

  it('conflict form 1: any ARP whose sender address is the candidate ends the probe, cache untouched', () => {
    const { h, arp } = setup();
    start(h, arp);
    expect(arp.stateSnapshot().state.probes).toEqual([{ token: TOKEN, owner: 'dhcp-client', iface: GI0, address: CANDIDATE, sent: 1, count: 3 }]);
    h.setNow(SEC / 2);
    // the owner of the address answers our probe (unicast reply to us)
    const reply = arpFrame(h, { op: 'reply', sha: OTHER_MAC, spa: CANDIDATE, tha: MY_MAC, tpa: '0.0.0.0' });
    const out = arp.onPdu(h.ctx, reply, GI0);
    expect(cancels(out)).toEqual([{ type: 'cancelTimer', key: `arp-probe:${TOKEN}` }]);
    expect(events(out)).toEqual([
      { type: 'event', to: 'dhcp-client', ev: { kind: 'arp.probeResult', token: TOKEN, iface: GI0, address: CANDIDATE, conflict: true, mac: OTHER_MAC } },
    ]);
    expect(sends(out)).toEqual([]);
    expect(h.tables.arp.size).toBe(0);
    expect(h.events.filter((e) => e.kind === 'tableWrite')).toEqual([]);
    // the probe is over: a stray timer does nothing
    expect(arp.onTimer(h.ctx, `arp-probe:${TOKEN}`)).toEqual([]);
    // a gratuitous announcement of the candidate by someone else is also a conflict
    start(h, arp);
    const garp = arpFrame(h, { op: 'request', sha: OTHER_MAC, spa: CANDIDATE, tha: MAC_ZERO, tpa: CANDIDATE });
    expect(events(arp.onPdu(h.ctx, garp, GI0))[0]!.ev).toMatchObject({ conflict: true, mac: OTHER_MAC });
    expect(h.tables.arp.size).toBe(0);
  });

  it('conflict form 2: another station probing the same candidate (spa 0.0.0.0, tpa = candidate, other MAC)', () => {
    const { h, arp } = setup();
    start(h, arp);
    // our own probe seen back is not a conflict
    const own = arpFrame(h, { op: 'request', sha: MY_MAC, spa: '0.0.0.0', tha: MAC_ZERO, tpa: CANDIDATE });
    expect(events(arp.onPdu(h.ctx, own, GI0))).toEqual([]);
    // a probe for a different address is not a conflict either
    const otherTarget = arpFrame(h, { op: 'request', sha: OTHER_MAC, spa: '0.0.0.0', tha: MAC_ZERO, tpa: '169.254.9.9' });
    expect(events(arp.onPdu(h.ctx, otherTarget, GI0))).toEqual([]);
    const theirs = arpFrame(h, { op: 'request', sha: OTHER_MAC, spa: '0.0.0.0', tha: MAC_ZERO, tpa: CANDIDATE });
    const out = arp.onPdu(h.ctx, theirs, GI0);
    expect(events(out)).toEqual([
      { type: 'event', to: 'dhcp-client', ev: { kind: 'arp.probeResult', token: TOKEN, iface: GI0, address: CANDIDATE, conflict: true, mac: OTHER_MAC } },
    ]);
    expect(h.tables.arp.size).toBe(0);
    expect(h.events.filter((e) => e.kind === 'tableWrite')).toEqual([]);
  });

  it('only frames on the probed port count; count and interval can be overridden', () => {
    const { h, arp } = setup();
    const out = start(h, arp, { count: 2, intervalNs: 200_000_000 });
    expect(timers(out)).toEqual([{ type: 'timer', key: `arp-probe:${TOKEN}`, delay: 200_000_000 }]);
    const elsewhere = arpFrame(h, { op: 'reply', sha: OTHER_MAC, spa: CANDIDATE, tha: MY_MAC, tpa: '0.0.0.0' });
    expect(events(arp.onPdu(h.ctx, elsewhere, GI1))).toEqual([]);
    h.setNow(200_000_000);
    expect(sends(arp.onTimer(h.ctx, `arp-probe:${TOKEN}`))).toHaveLength(1);
    h.setNow(400_000_000);
    expect(events(arp.onTimer(h.ctx, `arp-probe:${TOKEN}`))[0]!.ev).toMatchObject({ conflict: false });
  });

  it('a new probe with the same token restarts it; a port without ARP reports no conflict at once', () => {
    const { h, arp } = setup();
    start(h, arp);
    const again = start(h, arp);
    expect(cancels(again)).toEqual([{ type: 'cancelTimer', key: `arp-probe:${TOKEN}` }]);
    expect(sends(again)).toHaveLength(1);
    expect(arp.stateSnapshot().state.probes).toEqual([{ token: TOKEN, owner: 'dhcp-client', iface: GI0, address: CANDIDATE, sent: 1, count: 3 }]);

    const serial = makeHarness({ kind: 'router', ports: [{ id: 'Serial0/0/0', mac: '00:1f:00:00:00:05', kind: 'serial' }] });
    const arp2 = createArp();
    const out = arp2.onRequest!(serial.ctx, { kind: 'arp.probe', owner: 'dhcp-client', token: 't', iface: 'Serial0/0/0', address: CANDIDATE });
    expect(sends(out)).toEqual([]);
    expect(events(out)).toEqual([{ type: 'event', to: 'dhcp-client', ev: { kind: 'arp.probeResult', token: 't', iface: 'Serial0/0/0', address: CANDIDATE, conflict: false } }]);
  });

  it('a station that owns the address defends it against a probe, and never caches the 0.0.0.0 sender', () => {
    const h = makeHarness({ ports: [{ id: GI0, mac: MY_MAC, address: CANDIDATE, prefixLen: 16 }] });
    const arp = createArp();
    const probe = arpFrame(h, { op: 'request', sha: OTHER_MAC, spa: '0.0.0.0', tha: MAC_ZERO, tpa: CANDIDATE });
    const out = arp.onPdu(h.ctx, probe, GI0);
    const s = sends(out);
    expect(s).toHaveLength(1);
    expect(s[0]!.pdu.get('ethernet.dst')).toBe(OTHER_MAC);
    expect(s[0]!.pdu.get('arp.spa')).toBe(CANDIDATE);
    expect(s[0]!.pdu.get('arp.sha')).toBe(MY_MAC);
    expect(s[0]!.pdu.get('arp.tpa')).toBe('0.0.0.0');
    expect(h.tables.arp.size).toBe(0);
    // a probe for someone else's address is ignored and not cached
    const other = arpFrame(h, { op: 'request', sha: OTHER_MAC, spa: '0.0.0.0', tha: MAC_ZERO, tpa: '169.254.1.1' });
    expect(arp.onPdu(h.ctx, other, GI0)).toEqual([]);
    expect(h.tables.arp.size).toBe(0);
  });
});
