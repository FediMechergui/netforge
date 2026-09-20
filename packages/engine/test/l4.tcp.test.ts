/**
 * l4.tcp.test.ts — the TCP daemon (protocols/tcp.ts; ARCHITECTURE-P1 §4.5, §5.2; RFC 9293, RFC 6298, RFC 5681).
 *
 * PC1 (192.168.1.2) — R1 Gi0/0 (192.168.1.80) on the ip6.harness bus, with the real arp/ipv4/icmpv4 daemons and
 * the real tcp daemon. Applications are recorders ('http-client' on PC1, 'http-server' on R1) driven by hand.
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import type { Action } from '../src/contracts/process.js';
import { createTcp } from '../src/protocols/tcp.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type Sent, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';

interface Lab {
  w: World6;
  cli: Recorder;
  srv: Recorder;
}

function lab(opts: { seed?: number; lose?: (s: Sent) => boolean } = {}): Lab {
  const cli = recorder('http-client');
  const srv = recorder('http-server');
  const w = createWorld6({ seed: opts.seed ?? 7, extra: { tcp: createTcp, 'http-client': () => cli, 'http-server': () => srv }, ...(opts.lose ? { lose: opts.lose } : {}) });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  w.iface('r1', G0, 'ip address 192.168.1.80 255.255.255.0', 'no shutdown');
  w.runFor(1 * SEC);
  return { w, cli, srv };
}

const tcpOf = (p: Pdu): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === 'tcp')?.fields;
const segs = (w: World6, dev: string): Pdu[] => w.sentBy(dev).filter((p) => tcpOf(p) !== undefined);
const states = (w: World6, dev: string): string[] => w.dev(dev).tables.get<SocketRow>('sockets')!.rows().map((r) => r.state);
const kinds = (r: Recorder): string[] => r.evs.map((e) => e.kind);
const ofKind = <K extends ProcessEvent['kind']>(r: Recorder, k: K): Extract<ProcessEvent, { kind: K }>[] =>
  r.evs.filter((e): e is Extract<ProcessEvent, { kind: K }> => e.kind === k);

function received(r: Recorder): Uint8Array {
  const parts = ofKind(r, 'sock.data').map((e) => e.data);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

/** Listen on R1:80, connect from PC1, run the handshake. */
function open(l: Lab): void {
  l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
  l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'http-client#r_1', dst: '192.168.1.80', dstPort: 80 });
  l.w.runFor(1 * SEC);
}

describe('l4.tcp handshake, transfer, close', () => {
  it('runs S / SA / A with the right seq/ack arithmetic and reports connected + accepted', () => {
    const l = lab();
    open(l);
    const [syn] = segs(l.w, 'pc1');
    const [synAck] = segs(l.w, 'r1');
    const s = tcpOf(syn!)!;
    const sa = tcpOf(synAck!)!;
    expect(s.flags).toBe('S');
    expect(s.mss).toBe(1460);
    expect(syn!.meta.tag).toBe('tcp-syn');
    expect(sa.flags).toBe('SA');
    expect(sa.ack).toBe(((s.seq as number) + 1) >>> 0);
    const ack = tcpOf(segs(l.w, 'pc1')[1]!)!;
    expect(ack.flags).toBe('A');
    expect(ack.seq).toBe(((s.seq as number) + 1) >>> 0);
    expect(ack.ack).toBe(((sa.seq as number) + 1) >>> 0);
    expect(kinds(l.cli)).toEqual(['sock.connected']);
    expect(kinds(l.srv)).toEqual(['sock.opened', 'sock.accepted']);
    expect(ofKind(l.srv, 'sock.accepted')[0]!.socket).toBe('http-server#80/1');
    expect(states(l.w, 'pc1')).toEqual(['ESTABLISHED']);
  });

  it('segments 4000 bytes by MSS, drains, then closes both ways through TIME_WAIT', () => {
    const l = lab();
    open(l);
    const data = bytes(4000);
    l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data });
    l.w.runFor(1 * SEC);
    const payloads = segs(l.w, 'pc1').map((p) => p.layers.find((x) => x.proto === 'tcp')!).map((t) => t.length - (t.fields.dataOffset as number) * 4);
    expect(payloads.filter((n) => n > 0)).toEqual([1460, 1460, 1080]);
    expect(received(l.srv)).toEqual(data);
    expect(kinds(l.cli)).toContain('sock.drained');

    l.w.request('pc1', 'tcp', { kind: 'tcp.close', socket: 'http-client#r_1' });
    l.w.runFor(1 * SEC);
    expect(kinds(l.srv)).toContain('sock.peerClosed');
    l.w.request('r1', 'tcp', { kind: 'tcp.close', socket: 'http-server#80/1' });
    l.w.runFor(1 * SEC);
    expect(ofKind(l.srv, 'sock.closed').map((e) => e.socket)).toEqual(['http-server#80/1']);
    expect(ofKind(l.cli, 'sock.closed').map((e) => e.socket)).toEqual(['http-client#r_1']);
    expect(states(l.w, 'pc1')).toEqual(['TIME_WAIT']);
    l.w.runFor(61 * SEC);
    expect(states(l.w, 'pc1')).toEqual([]);
    expect(states(l.w, 'r1')).toEqual(['LISTEN']);
  });

  it('acks the peer FIN before the owner sends its own: FIN / ACK / FIN / ACK', () => {
    const l = lab();
    const base = l.srv.onEvent!;
    // the design's http-server closes as soon as the peer does (§4.5 step 6)
    l.srv.onEvent = (ctx, ev): Action[] => [
      ...base(ctx, ev),
      ...(ev.kind === 'sock.peerClosed' ? [{ type: 'request', to: 'tcp', req: { kind: 'tcp.close', socket: ev.socket } } as Action] : []),
    ];
    open(l);
    l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data: bytes(100) });
    l.w.request('pc1', 'tcp', { kind: 'tcp.close', socket: 'http-client#r_1' });
    l.w.runFor(1 * SEC);
    const out = segs(l.w, 'r1');
    expect(out.map((p) => tcpOf(p)!.flags)).toEqual(['SA', 'A', 'FA']);
    // the pure ACK is not a stale-sequence keep-alive: it leaves at the same seq as the FIN that follows it
    expect(tcpOf(out[1]!)!.seq).toBe(tcpOf(out[2]!)!.seq);
    expect(kinds(l.srv)).toEqual(['sock.opened', 'sock.accepted', 'sock.data', 'sock.peerClosed', 'sock.closed']);
  });

  it('ignores a segment addressed to a directed broadcast: no child, no RST', () => {
    const l = lab();
    l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
    l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.255', dstPort: 80 });
    l.w.runFor(2 * SEC);
    expect(segs(l.w, 'pc1').length).toBeGreaterThan(0);
    expect(segs(l.w, 'r1')).toEqual([]);
    expect(kinds(l.srv)).toEqual(['sock.opened']);
    expect(l.w.kinds('drop').some((d) => (d.detail ?? '').includes('is not a unicast address of this device'))).toBe(true);
  });

  it('a re-opened listener never reuses the id of a live child', () => {
    const l = lab();
    open(l);
    l.w.request('r1', 'tcp', { kind: 'tcp.close', socket: 'http-server#80' });
    l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
    l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'http-client#r_2', dst: '192.168.1.80', dstPort: 80 });
    l.w.runFor(1 * SEC);
    const rows = l.w.dev('r1').tables.get<SocketRow>('sockets')!.rows();
    expect(rows.map((r) => r.id).sort()).toEqual(['http-server#80', 'http-server#80/1', 'http-server#80/2']);
    expect(rows.filter((r) => r.state === 'ESTABLISHED')).toHaveLength(2);
  });

  it('answers a closed port with RST → sock.error refused', () => {
    const l = lab();
    l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.80', dstPort: 81 });
    l.w.runFor(1 * SEC);
    const rst = tcpOf(segs(l.w, 'r1')[0]!)!;
    expect(rst.flags).toBe('RA');
    expect(ofKind(l.cli, 'sock.error').map((e) => e.code)).toEqual(['refused']);
    expect(l.w.kinds('drop').some((d) => d.detail === 'tcp port 81 closed')).toBe(true);
  });
});

describe('l4.tcp reliability', () => {
  it('retransmits a lost SYN after the 1 s RTO as a new pdu tagged tcp-retransmit', () => {
    let lost = false;
    const l = lab({
      lose: (s) => {
        if (lost || s.from.device !== 'pc1' || tcpOf(s.pdu)?.flags !== 'S') return false;
        lost = true;
        return true;
      },
    });
    open(l);
    l.w.runFor(1 * SEC);
    const syns = segs(l.w, 'pc1').filter((p) => tcpOf(p)!.flags === 'S');
    expect(syns).toHaveLength(2);
    expect(syns[1]!.id).not.toBe(syns[0]!.id);
    expect(syns[1]!.meta.tag).toBe('tcp-retransmit');
    expect(syns[1]!.meta.triggeredBy).toBe(syns[0]!.id);
    expect(kinds(l.cli)).toEqual(['sock.connected']);
  });

  it('one lost segment of ten → 3 duplicate ACKs → one fast retransmit, data intact', () => {
    let n = 0;
    let lostId: PduId | undefined;
    const l = lab({
      lose: (s) => {
        const t = s.pdu.layers.find((x) => x.proto === 'tcp');
        if (s.from.device !== 'pc1' || t === undefined || t.length === (t.fields.dataOffset as number) * 4 || s.pdu.meta.tag === 'tcp-retransmit') return false;
        if (++n !== 5) return false;
        lostId = s.pdu.id;
        return true;
      },
    });
    open(l);
    l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data: bytes(30_000) });
    l.w.runFor(5 * SEC);
    const retx = segs(l.w, 'pc1').filter((p) => p.meta.tag === 'tcp-retransmit');
    expect(retx).toHaveLength(1);
    expect(retx[0]!.meta.triggeredBy).toBe(lostId);
    expect(received(l.srv)).toEqual(bytes(30_000));
    const dupAcks = segs(l.w, 'r1').filter((p) => tcpOf(p)!.ack === tcpOf(retx[0]!)!.seq);
    expect(dupAcks.length).toBeGreaterThanOrEqual(4); // the first ACK plus ≥ 3 duplicates
    expect(retx[0]!.meta.born - dupAcks[3]!.meta.born).toBeLessThan(100_000); // sent on the 3rd duplicate, not by the RTO
  });

  it('gives up after 3 SYN retries with sock.error timeout', () => {
    const l = lab({ lose: (s) => s.from.device === 'pc1' && tcpOf(s.pdu) !== undefined });
    l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.80', dstPort: 80 });
    l.w.runFor(30 * SEC);
    expect(segs(l.w, 'pc1').filter((p) => tcpOf(p)!.flags === 'S')).toHaveLength(4);
    expect(ofKind(l.cli, 'sock.error').map((e) => e.code)).toEqual(['timeout']);
    expect(states(l.w, 'pc1')).toEqual([]);
  });

  it('sends the RST of an abort at SND.MAX, so a peer past a go-back-N retransmission accepts it', () => {
    // every pure ACK from R1 is lost: PC1's RTO pulls SND.NXT back below SND.MAX while R1 has all the data
    const l = lab({ lose: (s) => s.from.device === 'r1' && tcpOf(s.pdu)?.flags === 'A' });
    open(l);
    l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data: bytes(4000) });
    l.w.runFor(1500 * MS);
    expect(segs(l.w, 'pc1').some((p) => p.meta.tag === 'tcp-retransmit')).toBe(true);
    l.w.request('pc1', 'tcp', { kind: 'tcp.abort', socket: 'http-client#r_1' });
    l.w.runFor(1 * SEC);
    const rst = segs(l.w, 'pc1').filter((p) => (tcpOf(p)!.flags as string).includes('R')).at(-1)!;
    expect(tcpOf(rst)!.seq).toBe(ofKind(l.srv, 'sock.data').reduce((n, e) => n + e.data.length, 0) + (tcpOf(segs(l.w, 'pc1')[0]!)!.seq as number) + 1);
    expect(states(l.w, 'r1')).toEqual(['LISTEN']);
    expect(ofKind(l.srv, 'sock.error').map((e) => e.code)).toEqual(['reset']);
  });

  it('is deterministic: same seed → same ephemeral port and ISN', () => {
    const first = (seed: number): [unknown, unknown] => {
      const l = lab({ seed });
      open(l);
      const s = tcpOf(segs(l.w, 'pc1')[0]!)!;
      return [s.srcPort, s.seq];
    };
    expect(first(11)).toEqual(first(11));
  });
});
