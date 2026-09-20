/**
 * Regression tests from the P0 protocol-fidelity review. Each test pins a confirmed bug.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted, console, ofKind, ping } from './sim.harness.js';

describe('review/protocol regressions', () => {
  it('a ping to the directed subnet broadcast never ARPs for the broadcast address', () => {
    const sim = booted(twoPcsAndSwitch(), 4, 40 * SEC);
    const { evs } = ping(sim, 'pc1', '10.0.0.255');
    const arpForBroadcast = ofKind(evs, 'pduCreated').filter(
      (e) => e.pdu.tag === 'arp-request' && sim.pdu(e.pdu.id)!.get('arp.tpa') === '10.0.0.255',
    );
    expect(arpForBroadcast).toHaveLength(0);
    expect(ofKind(evs, 'drop').filter((e) => e.reason === 'arp-unresolved')).toHaveLength(0);
    const requests = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#'));
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(sim.pdu(r.pdu.id)!.get('ethernet.dst')).toBe('ff:ff:ff:ff:ff:ff');
    expect(ofKind(evs, 'pduCreated').some((e) => e.device === 'pc2' && e.pdu.tag === 'echo-reply')).toBe(true);
  });

  it('a router does not forward a directed broadcast onto a connected subnet', () => {
    const sim = booted(pcRouterPc(), 5);
    const { evs } = ping(sim, 'pc1', '10.0.1.255');
    const arpForBroadcast = ofKind(evs, 'pduCreated').filter(
      (e) => e.pdu.tag === 'arp-request' && sim.pdu(e.pdu.id)!.get('arp.tpa') === '10.0.1.255',
    );
    expect(arpForBroadcast).toHaveLength(0);
    expect(ofKind(evs, 'drop').some((e) => e.device === 'r1' && e.reason === 'not-for-me')).toBe(true);
    expect(ofKind(evs, 'pduCreated').some((e) => e.device === 'pc2' && e.pdu.tag === 'echo-reply')).toBe(false);
  });

  it('the address of a shut router interface does not answer echoes', () => {
    const sim = booted(pcRouterPc(), 5);
    console(sim, 'r1', ['enable', 'configure terminal', 'interface g0/1', 'shutdown', 'end']);
    const { text } = ping(sim, 'pc1', '10.0.1.254');
    expect(text).not.toContain('!');
    expect(text).toContain('received 0');
  });

  it('a ping with no route prints no echo header before the no-route line', () => {
    const sim = booted(twoPcsAndSwitch(), 4, 40 * SEC);
    const { text } = ping(sim, 'pc1', '8.8.8.8');
    expect(text).toContain('No route to 8.8.8.8');
    expect(text).not.toContain('Sending 5 echo requests');
  });
});
