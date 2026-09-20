/**
 * P0 acceptance: two PCs and a switch — ping works and the ARP exchange is visible in the trace.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createdId, ofKind, output } from './sim.harness.js';

/** Index of the first event after `from` satisfying `pred`; fails the test if absent. */
function indexAfter(evs: readonly TraceEvent[], from: number, pred: (e: TraceEvent) => boolean, what: string): number {
  for (let i = from + 1; i < evs.length; i++) if (pred(evs[i]!)) return i;
  throw new Error(`expected ${what} after index ${from}`);
}

describe('sim/two PCs and a switch', () => {
  it('pings 5/5 with the ARP → flood → reply → echo ×5 sequence', () => {
    const sim = createSimulation({ seed: 7 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(40 * SEC);
    for (const d of sim.devices()) expect(d.bootedAt).toBeDefined();

    const cursor = sim.trace(0).next;
    const session = sim.cli.open('pc1', 'console');
    const r = sim.cli.exec(session, 'ping 10.0.0.2');
    expect(r.error).toBeUndefined();
    expect(r.busy).toBe(true);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;

    // ARP request created on PC1
    const arpId = createdId(evs, 'pc1', 'arp-request');
    const iCreated = evs.findIndex((e) => e.kind === 'pduCreated' && e.pdu.id === arpId);
    const created = evs[iCreated] as Extract<TraceEvent, { kind: 'pduCreated' }>;
    expect(created.process).toBe('arp');
    expect(created.pdu.proto).toBe('arp');

    // PC1 → SW
    const iTx1 = indexAfter(evs, iCreated, (e) => e.kind === 'frameTx' && e.pdu.id === arpId && e.from.device === 'pc1' && e.to.device === 'sw1', 'frameTx PC1→SW');
    const iRx1 = indexAfter(evs, iTx1, (e) => e.kind === 'frameRx' && e.pdu.id === arpId && e.device === 'sw1', 'frameRx at SW');
    // SW floods to PC2 …
    const iFlood = indexAfter(
      evs,
      iRx1,
      (e) => e.kind === 'frameTx' && e.from.device === 'sw1' && e.to.device === 'pc2' && (e.pdu.id === arpId || e.pdu.parent === arpId),
      'flooded frameTx SW→PC2',
    );
    // … but never back out the ingress port to PC1
    const backToPc1 = ofKind(evs, 'frameTx').filter((e) => e.from.device === 'sw1' && e.to.device === 'pc1' && (e.pdu.id === arpId || e.pdu.parent === arpId));
    expect(backToPc1).toEqual([]);

    // PC2 answers with an ARP reply that reaches PC1 through the switch
    const replyId = createdId(evs, 'pc2', 'arp-reply');
    const iReply = indexAfter(evs, iFlood, (e) => e.kind === 'pduCreated' && e.pdu.id === replyId, 'ARP reply created');
    const iReplyRx = indexAfter(evs, iReply, (e) => e.kind === 'frameRx' && e.pdu.id === replyId && e.device === 'pc1', 'ARP reply at PC1');

    // five echo requests and five replies, all after the ARP exchange
    const requests = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag?.startsWith('ping#'));
    const replies = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc2' && e.pdu.tag === 'echo-reply');
    expect(requests.map((e) => e.pdu.tag)).toEqual(['ping#1', 'ping#2', 'ping#3', 'ping#4', 'ping#5']);
    expect(replies).toHaveLength(5);
    const firstEchoTx = indexAfter(evs, iReplyRx, (e) => e.kind === 'frameTx' && e.pdu.id === requests[0]!.pdu.id, 'first echo on the wire');
    expect(firstEchoTx).toBeGreaterThan(iReplyRx);
    for (const req of requests) {
      expect(ofKind(evs, 'frameRx').some((e) => e.device === 'pc2' && e.pdu.id === req.pdu.id)).toBe(true);
    }
    for (const rep of replies) {
      expect(ofKind(evs, 'pduConsumed').some((e) => e.device === 'pc1' && e.pdu.id === rep.pdu.id)).toBe(true);
    }
    expect(ofKind(evs, 'drop')).toEqual([]);

    // tables
    const sw = sim.device('sw1')!;
    expect(sw.tables.cam.size).toBe(2);
    const pc1 = sim.device('pc1')!;
    const pc2 = sim.device('pc2')!;
    expect(pc1.tables.arp.rows().map((r) => r.ip)).toEqual(['10.0.0.2']);
    expect(pc2.tables.arp.rows().map((r) => r.ip)).toEqual(['10.0.0.1']);
    expect(pc1.tables.arp.rows()[0]!.mac).toBe(pc2.port('GigabitEthernet0')!.mac);

    // CLI output
    const text = output(evs, session);
    expect(text.split('!').length - 1).toBe(5);
    expect(text).toContain('Sent 5, received 5, lost 0');
    expect(sim.cli.session(session)!.busy).toBe(false);

    // provenance of echo request #1: TTL 128 untouched, encapsulated at PC1
    const echo = sim.pdu(requests[0]!.pdu.id)!;
    expect(echo.get('ipv4.ttl')).toBe(128);
    expect(echo.provenance.some((m) => m.reason === 'TtlDecrement')).toBe(false);
    const enc = echo.provenance.find((m) => m.reason === 'Encapsulate');
    expect(enc).toBeDefined();
    expect(enc!.device).toBe('pc1');
    expect(enc!.field).toBe('ethernet');
    // the ARP request that the echo triggered points back at it
    expect(sim.pdu(arpId)!.meta.triggeredBy).toBe(requests[0]!.pdu.id);

    // snapshot agrees
    const snap = sim.snapshot();
    expect(snap.devices.find((d) => d.id === 'sw1')!.tables.cam).toHaveLength(2);
    expect(snap.sessions.find((s) => s.id === session)!.busy).toBe(false);
  });
});
