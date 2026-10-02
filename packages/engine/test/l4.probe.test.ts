/**
 * l4.probe — the grader's transport probes (ARCHITECTURE-P3 §2.4 `tcp.probe` / `udp.probe`, §2.6 the `probes` member,
 * §2.10; §7 W2 svc). tcp: one SYN from an ephemeral port, 'open' on the SYN-ACK (answered with a RST, so no connection
 * is kept), 'refused' on a RST, 'unreachable' on an ICMP destination unreachable (type and code kept) or at once without
 * a route, 'timeout' after timeoutNs. udp: one datagram `NFPR<session>`, 'unreachable' on an ICMP error, else 'sent'
 * when the timer fires. The `probes` member is optional by meaning: absent until a probe ran (the P1 StateView keys are
 * unchanged), at most 16, newest last.
 *
 * PC1 (192.168.1.2, gateway 192.168.1.80) — R1 (192.168.1.80) on the ip6.harness bus with the real arp/ipv4/icmpv4,
 * udp and tcp daemons, as in l4.tcp.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { TransportProbeView } from '../src/contracts/tables.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { SEC } from '../src/contracts/time.js';
import { createTcp } from '../src/protocols/tcp.js';
import { createUdp, TRANSPORT_PROBES_KEPT, UDP_PROBE_MARKER } from '../src/protocols/udp.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type Sent, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const R1 = '192.168.1.80';
const PROBE_NS = 3 * SEC;

interface Lab {
  w: World6;
  http: Recorder;
  dns: Recorder;
}

function lab(opts: { gateway?: boolean; lose?: (s: Sent) => boolean } = {}): Lab {
  const http = recorder('http-server');
  const dns = recorder('dns-server');
  const w = createWorld6({ seed: 11, extra: { tcp: createTcp, udp: createUdp, 'http-server': () => http, 'dns-server': () => dns }, ...(opts.lose ? { lose: opts.lose } : {}) });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  if (opts.gateway !== false) w.global('pc1', `ip default-gateway ${R1}`);
  w.iface('r1', G0, 'ip address 192.168.1.80 255.255.255.0', 'no shutdown');
  w.runFor(1 * SEC);
  return { w, http, dns };
}

const state = (w: World6, dev: string, proc: 'tcp' | 'udp'): Record<string, unknown> => w.dev(dev).processes.get(proc)!.stateSnapshot().state;
const probesOf = (w: World6, dev: string, proc: 'tcp' | 'udp'): TransportProbeView[] => (state(w, dev, proc).probes as TransportProbeView[] | undefined) ?? [];
const tcpOf = (p: Pdu): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === 'tcp')?.fields;
const tcpSegs = (w: World6, dev: string): Pdu[] => w.sentBy(dev).filter((p) => tcpOf(p) !== undefined);
const ofKind = <K extends ProcessEvent['kind']>(r: Recorder, k: K): Extract<ProcessEvent, { kind: K }>[] =>
  r.evs.filter((e): e is Extract<ProcessEvent, { kind: K }> => e.kind === k);

function tcpProbe(l: Lab, session: string, dst: string, port: number): void {
  l.w.request('pc1', 'tcp', { kind: 'tcp.probe', session, dst, port, timeoutNs: PROBE_NS });
}

function udpProbe(l: Lab, session: string, dst: string, port: number): void {
  l.w.request('pc1', 'udp', { kind: 'udp.probe', session, dst, port, timeoutNs: PROBE_NS });
}

describe('l4.probe: tcp.probe (§2.4)', () => {
  it('open: a listener answers the SYN-ACK; the probe resets it and no connection is kept on either side', () => {
    const l = lab();
    l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
    const t0 = l.w.now();
    tcpProbe(l, 'p1', R1, 80);
    l.w.runFor(1 * SEC);
    const got = probesOf(l.w, 'pc1', 'tcp');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ session: 'p1', dst: R1, port: 80, outcome: 'open' });
    expect(got[0]!.icmp).toBeUndefined();
    expect(got[0]!.at).toBeGreaterThan(t0);
    const sent = tcpSegs(l.w, 'pc1');
    expect(sent.map((p) => tcpOf(p)!.flags)).toEqual(['S', 'R']);
    expect(sent[0]!.meta.tag).toBe('tcp-probe');
    const synAck = tcpSegs(l.w, 'r1')[0]!;
    expect(tcpOf(synAck)!.flags).toBe('SA');
    // the RST sits at the SYN-ACK's ack, so R1 drops its half-open child
    expect(tcpOf(sent[1]!)!.seq).toBe(tcpOf(synAck)!.ack);
    expect(tcpOf(sent[0]!)!.srcPort).toBe(tcpOf(sent[1]!)!.srcPort);
    expect(state(l.w, 'r1', 'tcp').connections).toEqual([]);
    expect(state(l.w, 'pc1', 'tcp').connections).toEqual([]);
    expect(ofKind(l.http, 'sock.accepted')).toEqual([]);
    // no socket row on the prober
    expect(l.w.dev('pc1').tables.get('sockets')?.rows() ?? []).toEqual([]);
    // the timer is cancelled: nothing changes when it would have fired
    l.w.runFor(5 * SEC);
    expect(probesOf(l.w, 'pc1', 'tcp')[0]!.outcome).toBe('open');
  });

  it('refused: a closed port answers with a RST', () => {
    const l = lab();
    tcpProbe(l, 'p2', R1, 81);
    l.w.runFor(1 * SEC);
    expect(probesOf(l.w, 'pc1', 'tcp')).toEqual([expect.objectContaining({ session: 'p2', port: 81, outcome: 'refused' })]);
    // nothing answers a RST
    expect(tcpSegs(l.w, 'pc1').map((p) => tcpOf(p)!.flags)).toEqual(['S']);
  });

  it('unreachable: an ICMP destination unreachable from the gateway keeps its type and code', () => {
    const l = lab();
    tcpProbe(l, 'p3', '10.9.9.9', 80);
    l.w.runFor(1 * SEC);
    const [p] = probesOf(l.w, 'pc1', 'tcp');
    expect(p).toMatchObject({ session: 'p3', dst: '10.9.9.9', outcome: 'unreachable', icmp: { type: 3, code: 0 } });
  });

  it('unreachable at once when there is no route (no SYN leaves)', () => {
    const l = lab({ gateway: false });
    tcpProbe(l, 'p4', '10.9.9.9', 80);
    expect(probesOf(l.w, 'pc1', 'tcp')).toEqual([expect.objectContaining({ session: 'p4', outcome: 'unreachable' })]);
    expect(probesOf(l.w, 'pc1', 'tcp')[0]!.icmp).toBeUndefined();
    l.w.runFor(1 * SEC);
    expect(tcpSegs(l.w, 'pc1')).toEqual([]);
  });

  it('timeout: no answer within timeoutNs (the SYN-ACK is lost); pending until then', () => {
    const l = lab({ lose: (s) => s.from.device === 'r1' && tcpOf(s.pdu)?.flags === 'SA' });
    l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#80', family: 4, localPort: 80 });
    const t0 = l.w.now();
    tcpProbe(l, 'p5', R1, 80);
    l.w.runFor(PROBE_NS - 1);
    expect(probesOf(l.w, 'pc1', 'tcp')[0]).toMatchObject({ outcome: 'pending', at: t0 });
    l.w.runFor(1);
    expect(probesOf(l.w, 'pc1', 'tcp')[0]).toMatchObject({ outcome: 'timeout', at: t0 + PROBE_NS });
    // the probe sends one SYN only (no retries)
    expect(tcpSegs(l.w, 'pc1').map((p) => tcpOf(p)!.flags)).toEqual(['S']);
  });
});

describe('l4.probe: udp.probe (§2.4)', () => {
  it('a closed port: ICMP 3/3 makes the outcome unreachable with its type and code', () => {
    const l = lab();
    udpProbe(l, 'u1', R1, 9999);
    l.w.runFor(1 * SEC);
    expect(probesOf(l.w, 'pc1', 'udp')).toEqual([expect.objectContaining({ session: 'u1', dst: R1, port: 9999, outcome: 'unreachable', icmp: { type: 3, code: 3 } })]);
    l.w.runFor(5 * SEC);
    expect(probesOf(l.w, 'pc1', 'udp')[0]!.outcome).toBe('unreachable');
  });

  it('a listening socket: the datagram NFPR<session> reaches it, and the outcome is sent when the timer fires', () => {
    const l = lab();
    l.w.request('r1', 'udp', { kind: 'udp.open', owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    const t0 = l.w.now();
    udpProbe(l, 'u2', R1, 53);
    l.w.runFor(1 * SEC);
    expect(probesOf(l.w, 'pc1', 'udp')[0]).toMatchObject({ outcome: 'pending' });
    const got = ofKind(l.dns, 'sock.datagram');
    expect(got).toHaveLength(1);
    expect(new TextDecoder().decode(got[0]!.data)).toBe(`${UDP_PROBE_MARKER}u2`);
    expect(got[0]!.from).toBe('192.168.1.2');
    l.w.runFor(PROBE_NS);
    expect(probesOf(l.w, 'pc1', 'udp')[0]).toMatchObject({ session: 'u2', outcome: 'sent', at: t0 + PROBE_NS });
    // the probe's port was never a socket
    expect(l.w.dev('pc1').tables.get('sockets')?.rows() ?? []).toEqual([]);
  });

  it('no route: unreachable at once, no datagram', () => {
    const l = lab({ gateway: false });
    const before = l.w.sentBy('pc1').length;
    udpProbe(l, 'u3', '10.9.9.9', 53);
    expect(probesOf(l.w, 'pc1', 'udp')).toEqual([expect.objectContaining({ session: 'u3', outcome: 'unreachable' })]);
    l.w.runFor(1 * SEC);
    expect(l.w.sentBy('pc1').length).toBe(before);
  });
});

describe('l4.probe: the probes member (optional by meaning, §2.6)', () => {
  it('is absent until a probe runs: the StateView keys are the P1 ones', () => {
    const l = lab();
    expect(Object.keys(state(l.w, 'pc1', 'udp'))).toEqual(['sockets', 'ephemeralNext', 'datagramsIn', 'datagramsOut', 'noPort', 'checksumErrors', 'icmpErrors']);
    expect(Object.keys(state(l.w, 'pc1', 'tcp'))).toEqual(['listeners', 'connections', 'ephemeralNext', 'segmentsIn', 'segmentsOut', 'retransmits', 'resetsOut', 'checksumErrors']);
    udpProbe(l, 'u', R1, 9999);
    tcpProbe(l, 't', R1, 81);
    expect(Object.keys(state(l.w, 'pc1', 'udp')).at(-1)).toBe('probes');
    expect(Object.keys(state(l.w, 'pc1', 'tcp')).at(-1)).toBe('probes');
  });

  it(`keeps the newest ${TRANSPORT_PROBES_KEPT}, oldest first; a session probed again is replaced and counted anew`, () => {
    const l = lab();
    for (let i = 1; i <= TRANSPORT_PROBES_KEPT + 2; i++) {
      tcpProbe(l, `s${i}`, R1, 81);
      l.w.runFor(10_000_000);
    }
    const got = probesOf(l.w, 'pc1', 'tcp');
    expect(got.map((p) => p.session)).toEqual(Array.from({ length: TRANSPORT_PROBES_KEPT }, (_, i) => `s${i + 3}`));
    expect(got.every((p) => p.outcome === 'refused')).toBe(true);
    // the same session again: the old record stays in the log, the new one is appended
    l.w.request('r1', 'tcp', { kind: 'tcp.listen', owner: 'http-server', socket: 'http-server#81', family: 4, localPort: 81 });
    tcpProbe(l, 's18', R1, 81);
    l.w.runFor(1 * SEC);
    const again = probesOf(l.w, 'pc1', 'tcp');
    expect(again.at(-1)).toMatchObject({ session: 's18', outcome: 'open' });
    expect(again.at(-2)).toMatchObject({ session: 's18', outcome: 'refused' });
  });

  it('each probe takes its own ephemeral port; sockets bound later skip a held port', () => {
    const l = lab();
    tcpProbe(l, 'a', R1, 81);
    tcpProbe(l, 'b', R1, 81);
    l.w.runFor(1 * SEC);
    const syns = tcpSegs(l.w, 'pc1').filter((p) => tcpOf(p)!.flags === 'S');
    expect(syns).toHaveLength(2);
    expect(tcpOf(syns[0]!)!.srcPort).not.toBe(tcpOf(syns[1]!)!.srcPort);
  });
});
