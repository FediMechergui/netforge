/**
 * l4.tls-flag — tcp's simulated TLS channel (ARCHITECTURE-P3 D21, §2.5; §7 W1 svc): `tls` on `tcp.listen` /
 * `tcp.connect` (optional by meaning) marks every data-carrying segment of the connection — an accepted child inherits
 * its listener's flag — with `meta.protected` and `protectedBy: 'tls'`; handshake, pure ACK, FIN and RST segments are
 * not marked, the bytes are unchanged (no handshake bytes: TLS is a simulated state), and a connection without the
 * flag carries no mark (P1/P2 bytes).
 *
 * PC1 (192.168.1.2) — R1 (192.168.1.80) on the ip6.harness bus with the real arp/ipv4/icmpv4 and tcp daemons, as in
 * l4.tcp.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { SEC } from '../src/contracts/time.js';
import { createTcp } from '../src/protocols/tcp.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type Sent, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';

interface Lab {
  w: World6;
  cli: Recorder;
  srv: Recorder;
}

function lab(lose?: (s: Sent) => boolean): Lab {
  const cli = recorder('http-client');
  const srv = recorder('http-server');
  const w = createWorld6({ seed: 7, extra: { tcp: createTcp, 'http-client': () => cli, 'http-server': () => srv }, ...(lose ? { lose } : {}) });
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
const hasData = (p: Pdu): boolean => p.layers.some((l) => l.proto !== 'ethernet' && l.proto !== 'ipv4' && l.proto !== 'tcp');
const ofKind = <K extends ProcessEvent['kind']>(r: Recorder, k: K): Extract<ProcessEvent, { kind: K }>[] =>
  r.evs.filter((e): e is Extract<ProcessEvent, { kind: K }> => e.kind === k);
const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 11 + 5) & 0xff);

/** Open R1:443 (tls on the listener when `listenTls`) and connect from PC1 (tls when `connectTls`). */
function open(l: Lab, listenTls: boolean, connectTls: boolean): void {
  l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#443', family: 4, localPort: 443, ...(listenTls ? { tls: true as const } : {}) });
  l.w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'http-client#r_1', dst: '192.168.1.80', dstPort: 443, ...(connectTls ? { tls: true as const } : {}) });
  l.w.runFor(1 * SEC);
}

/** Exchange a request (PC1 → R1), a two-segment answer (R1 → PC1), then close both ways. */
function exchange(l: Lab): void {
  l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data: bytes(300) });
  l.w.runFor(1 * SEC);
  const child = ofKind(l.srv, 'sock.accepted')[0]!.socket;
  l.w.request('r1', 'tcp', { kind: 'tcp.send', socket: child, data: bytes(2000) });
  l.w.runFor(1 * SEC);
  l.w.request('pc1', 'tcp', { kind: 'tcp.close', socket: 'http-client#r_1' });
  l.w.runFor(1 * SEC);
  l.w.request('r1', 'tcp', { kind: 'tcp.close', socket: child });
  l.w.runFor(1 * SEC);
}

describe('l4.tls-flag: the simulated TLS channel (D21)', () => {
  it('marks every data segment of both ends, and only those, with protected + protectedBy tls', () => {
    const l = lab();
    open(l, true, true);
    exchange(l);
    for (const dev of ['pc1', 'r1']) {
      const all = segs(l.w, dev);
      const data = all.filter(hasData);
      expect(data.length).toBeGreaterThan(0);
      for (const p of data) expect(p.meta).toMatchObject({ protected: true, protectedBy: 'tls' });
      const control = all.filter((p) => !hasData(p));
      expect(control.map((p) => tcpOf(p)!.flags)).toEqual(expect.arrayContaining(['A']));
      for (const p of control) {
        expect(p.meta.protected).toBeUndefined();
        expect(p.meta.protectedBy).toBeUndefined();
      }
    }
    // the SYN / SYN-ACK and the FINs carry no mark
    expect(tcpOf(segs(l.w, 'pc1')[0]!)!.flags).toBe('S');
    expect(segs(l.w, 'pc1')[0]!.meta.protected).toBeUndefined();
    expect(tcpOf(segs(l.w, 'r1')[0]!)!.flags).toBe('SA');
    expect(segs(l.w, 'r1')[0]!.meta.protected).toBeUndefined();
    // what the owners receive is the plain stream: TLS is a simulated state, no handshake bytes
    const got = ofKind(l.srv, 'sock.data').map((e) => e.data.length).reduce((a, b) => a + b, 0);
    expect(got).toBe(300);
    expect(ofKind(l.cli, 'sock.data').map((e) => e.data.length).reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it('the accepted child inherits the listener flag; a plain connect to it marks only the server side', () => {
    const l = lab();
    open(l, true, false);
    exchange(l);
    expect(segs(l.w, 'r1').filter(hasData).every((p) => p.meta.protectedBy === 'tls')).toBe(true);
    expect(segs(l.w, 'pc1').filter(hasData).every((p) => p.meta.protected === undefined)).toBe(true);
  });

  it('retransmitted data keeps the mark', () => {
    let dropped = false;
    const l = lab((s) => {
      // lose the first data segment PC1 sends once
      if (!dropped && s.from.device === 'pc1' && hasData(s.pdu) && tcpOf(s.pdu) !== undefined) {
        dropped = true;
        return true;
      }
      return false;
    });
    open(l, false, true);
    l.w.request('pc1', 'tcp', { kind: 'tcp.send', socket: 'http-client#r_1', data: bytes(100) });
    l.w.runFor(5 * SEC);
    const data = segs(l.w, 'pc1').filter(hasData);
    expect(data.length).toBe(2);
    expect(data[1]!.meta).toMatchObject({ tag: 'tcp-retransmit', triggeredBy: data[0]!.id, protected: true, protectedBy: 'tls' });
  });

  it('without the flag nothing is marked and the bytes are those of a tls connection (the mark is meta only)', () => {
    const plain = lab();
    open(plain, false, false);
    exchange(plain);
    const tls = lab();
    open(tls, true, true);
    exchange(tls);
    for (const dev of ['pc1', 'r1']) {
      const a = segs(plain.w, dev);
      const b = segs(tls.w, dev);
      expect(a.every((p) => p.meta.protected === undefined && p.meta.protectedBy === undefined)).toBe(true);
      expect(a.map((p) => Array.from(p.bytes))).toEqual(b.map((p) => Array.from(p.bytes)));
    }
  });
});
