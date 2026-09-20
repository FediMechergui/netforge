/**
 * P1 acceptance — the TCP handshake and its reliability (ARCHITECTURE-P1 §10.2 `accept.p1.tcp-handshake`; §4.5).
 *
 * PC1 – SW1 – R1, where R1 answers web requests. The handshake, the lossy fetch and the ephemeral port are read
 * from the fetch the browser starts, so nothing about the connection is faked.
 *
 * The fast-retransmit case needs ten segments in one direction, which no configurable page can produce (a page body
 * is at most a kilobyte, one segment). It therefore opens a bulk connection the way a daemon does — through
 * `DeviceRuntime.applyActions`, the entry point behind `CommandCtx.request` — naming `traceroute` as the owner,
 * a daemon that ignores TCP socket events. Everything below that request is the real tcp process.
 *
 * ponytail: one world builder; the loss cases tune the impairments of a cable instead of rebuilding the world. The
 * single lost segment is taken out on the switch-to-router cable, where the switch forwards one frame per event, so
 * exactly one frame of a burst can be lost.
 */
import { describe, expect, it } from 'vitest';
import type { Action } from '../src/contracts/process.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TCP_DUPACK_THRESHOLD, TCP_INITIAL_RTO_NS, TCP_MSS_IPV4 } from '../src/contracts/transport.js';
import { createSimulation } from '../src/sim/simulation.js';
import { cable, device, topology } from './accept.p05.harness.js';
import { ofKind } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const BOOT = 60 * SEC;
/** PC1's own cable, and the switch-to-router cable the segments travel on next. */
const PC_CABLE = 'l_pc1_sw1';
const UPLINK = 'l_sw1_r1';
const PC_ADDRESS = '192.168.1.2';
/** Port the bulk connection uses; nothing else listens there. */
const BULK_PORT = 9000;
/** Segments the bulk transfer sends. */
const BULK_SEGMENTS = 10;

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** PC1 (192.168.1.2) – SW1 – R1 (192.168.1.1, web server), booted and configured. */
function lab(seed = 13): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [device('pc1', 'pc.nfpc', 'PC1', 100, 300), device('sw1', 'switch.nfc2960', 'SW1', 300, 200), device('r1', 'router.nf2911', 'R1', 500, 120)],
      [cable(PC_CABLE, 'pc1', PC_PORT, 'sw1', 'FastEthernet0/1'), cable(UPLINK, 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0')],
    ),
  );
  sim.runFor(BOOT);
  configured(sim, 'r1', ['interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit', 'ip http server']);
  configured(sim, 'pc1', [`ip address ${PC_ADDRESS} 255.255.255.0 192.168.1.1`]);
  sim.runToIdle();
  return sim;
}

/** The http-client tab a ticket owns. */
function tab(sim: Simulation, dev: string, token: string): Record<string, unknown> {
  const state = sim.device(dev)?.processes.get('http-client')?.stateSnapshot().state;
  const tabs = state?.['tabs'] as Record<string, Record<string, unknown>> | undefined;
  return tabs?.[token] ?? {};
}

/** Every PDU created since `cursor`, with the device that made it and the tag it carries. */
function created(sim: Simulation, cursor: number): { device: string; tag?: string; pdu: PduView }[] {
  return ofKind(sim.trace(cursor).events, 'pduCreated').map((e) => ({
    device: e.device,
    ...(e.pdu.tag !== undefined ? { tag: e.pdu.tag } : {}),
    pdu: sim.pdu(e.pdu.id)!,
  }));
}

/** A process request as the daemon that owns the socket would issue it. */
const toTcp = (r: Extract<Action, { type: 'request' }>['req']): Action[] => [{ type: 'request', to: 'tcp', req: r }];

/** True for a frame carrying one of PC1's data segments (not a bare acknowledgement). */
function isPcSegment(pdu: PduView | undefined): boolean {
  if (pdu === undefined || pdu.layer('tcp') === undefined) return false;
  const tcp = pdu.layer('tcp')!;
  return String(pdu.get('ipv4.src')) === PC_ADDRESS && tcp.length - tcp.headerLength > 0;
}

describe('accept P1: TCP handshake', () => {
  it('shows S, SA and A with the sequence arithmetic of a three-way handshake', () => {
    const sim = lab();
    const cursor = sim.trace(0).next;
    sim.hostRequest!('pc1', { app: 'http.get', url: 'http://192.168.1.1/' });
    sim.runFor(5 * SEC);

    const tcp = created(sim, cursor).filter((f) => f.pdu.layer('tcp') !== undefined);
    const [syn, synAck, ack] = tcp;
    expect([syn!.device, synAck!.device, ack!.device]).toEqual(['pc1', 'r1', 'pc1']);
    expect([syn!.pdu.get('tcp.flags'), synAck!.pdu.get('tcp.flags'), ack!.pdu.get('tcp.flags')]).toEqual(['S', 'SA', 'A']);
    expect(syn!.tag).toBe('tcp-syn');

    const iss = Number(syn!.pdu.get('tcp.seq'));
    const irs = Number(synAck!.pdu.get('tcp.seq'));
    expect(Number(synAck!.pdu.get('tcp.ack'))).toBe((iss + 1) >>> 0);
    expect(Number(ack!.pdu.get('tcp.seq'))).toBe((iss + 1) >>> 0);
    expect(Number(ack!.pdu.get('tcp.ack'))).toBe((irs + 1) >>> 0);
    // The options a P1 SYN carries, and the ports of the pair.
    expect(syn!.pdu.get('tcp.mss')).toBe(TCP_MSS_IPV4);
    expect(synAck!.pdu.get('tcp.mss')).toBe(TCP_MSS_IPV4);
    expect(syn!.pdu.get('tcp.dstPort')).toBe(80);
    expect(synAck!.pdu.get('tcp.dstPort')).toBe(syn!.pdu.get('tcp.srcPort'));
  });

  it('picks the same ephemeral port on every run of the same lab', () => {
    const portOf = (seed: number): number => {
      const sim = lab(seed);
      const cursor = sim.trace(0).next;
      sim.hostRequest!('pc1', { app: 'http.get', url: 'http://192.168.1.1/' });
      sim.runFor(5 * SEC);
      const syn = created(sim, cursor).find((f) => f.tag === 'tcp-syn')!;
      return Number(syn.pdu.get('tcp.srcPort'));
    };
    const first = portOf(13);
    expect(portOf(13)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(1024);
  });

  it('still finishes the fetch on a cable that loses a fifth of the frames, retransmitting new tagged PDUs', () => {
    const sim = lab(2);
    sim.setImpairments(PC_CABLE, { lossPct: 20 });
    const cursor = sim.trace(0).next;
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://192.168.1.1/' });
    sim.runFor(30 * SEC);

    const t = tab(sim, 'pc1', ticket.requestId);
    expect(t['phase']).toBe('done');
    expect(t['status']).toBe(200);

    const flight = created(sim, cursor);
    const lost = ofKind(sim.trace(cursor).events, 'drop').filter((e) => e.reason === 'link-loss');
    expect(lost.length).toBeGreaterThan(0);

    const retransmits = flight.filter((f) => f.tag === 'tcp-retransmit');
    expect(retransmits.length).toBeGreaterThan(0);
    for (const r of retransmits) {
      // A retransmission is a NEW pdu that names the segment it repeats.
      const original = r.pdu.meta.triggeredBy;
      expect(original).toBeDefined();
      expect(original).not.toBe(r.pdu.id);
      const first = flight.find((f) => f.pdu.id === original);
      expect(first).toBeDefined();
      expect(first!.pdu.get('tcp.seq')).toBe(r.pdu.get('tcp.seq'));
    }
  });

  it('answers one lost segment of ten with three duplicate acknowledgements and a single fast retransmit', () => {
    const sim = lab();
    const pc = sim.device('pc1')!;
    sim.device('r1')!.applyActions('traceroute', toTcp({ kind: 'tcp.listen', owner: 'traceroute', socket: 'bulk#in', family: 4, localPort: BULK_PORT }), sim.now);
    pc.applyActions('traceroute', toTcp({ kind: 'tcp.connect', owner: 'traceroute', socket: 'bulk#out', dst: '192.168.1.1', dstPort: BULK_PORT }), sim.now);
    sim.runFor(SEC);

    const cursor = sim.trace(0).next;
    pc.applyActions('traceroute', toTcp({ kind: 'tcp.send', socket: 'bulk#out', data: new Uint8Array(BULK_SEGMENTS * TCP_MSS_IPV4) }), sim.now);

    // Let the first two segments and the acknowledgement they earn through the switch, then lose the next
    // segment and heal the cable at once: the switch forwards one frame per event, so exactly one is lost.
    const onUplink = { kinds: ['frameTx'] as const, links: [UPLINK] };
    let through = 0;
    let acknowledged = false;
    while (!acknowledged) {
      const stop = sim.stepToNext(onUplink, { maxEvents: 50_000 });
      const stopped = stop.stopEvent;
      expect(stopped?.kind).toBe('frameTx');
      const frame = stopped !== undefined && stopped.kind === 'frameTx' ? sim.pdu(stopped.pdu.id) : undefined;
      if (isPcSegment(frame)) through++;
      else if (through >= 2 && frame?.layer('tcp') !== undefined) acknowledged = true;
    }
    sim.setImpairments(UPLINK, { lossPct: 100 });
    sim.stepToNext(onUplink, { maxEvents: 50_000 });
    sim.setImpairments(UPLINK, { lossPct: 0 });
    sim.runFor(30 * SEC);

    const evs = sim.trace(cursor).events;
    const lost = ofKind(evs, 'drop').filter((e) => e.reason === 'link-loss');
    expect(lost).toHaveLength(1);
    const lostPdu = sim.pdu(lost[0]!.pdu.id)!;
    expect(isPcSegment(lostPdu)).toBe(true);
    const lostSeq = Number(lostPdu.get('tcp.seq'));

    const flight = created(sim, cursor);
    expect(flight.filter((f) => isPcSegment(f.pdu)).length).toBeGreaterThanOrEqual(BULK_SEGMENTS);

    // The receiver repeats the same acknowledgement for every segment that arrives past the gap.
    const acks = flight.filter((f) => f.device === 'r1' && f.pdu.layer('tcp') !== undefined).map((f) => Number(f.pdu.get('tcp.ack')));
    const repeats = acks.filter((a) => a === lostSeq).length - 1;
    expect(repeats).toBeGreaterThanOrEqual(TCP_DUPACK_THRESHOLD);

    const retransmits = flight.filter((f) => f.tag === 'tcp-retransmit');
    expect(retransmits).toHaveLength(1);
    expect(Number(retransmits[0]!.pdu.get('tcp.seq'))).toBe(lostSeq);
    expect(retransmits[0]!.pdu.meta.triggeredBy).toBe(lostPdu.id);
    // It left on the duplicate acknowledgements, well before the retransmission timer could have fired.
    const sentAt = ofKind(evs, 'pduCreated').find((e) => e.pdu.id === retransmits[0]!.pdu.id)!.t;
    expect(sentAt - lostPdu.meta.born).toBeLessThan(TCP_INITIAL_RTO_NS);
  });
});
