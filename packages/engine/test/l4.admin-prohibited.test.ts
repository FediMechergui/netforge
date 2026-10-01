/**
 * l4.admin-prohibited — tcp's soft error for ICMP 3/13 (ARCHITECTURE-P3 D12, §2.5, §3.3 step: "PC1's TCP records the
 * soft error admin-prohibited (a soft error does not abort the connect)"; §7 W1 svc): an ICMP "communication
 * administratively prohibited" quoting a segment of a connection is recorded, never aborts it (not even in SYN_SENT),
 * and becomes the `sock.error` code if the connection then times out. Hard errors (3/3, 3/2) keep their P1 meaning.
 *
 * PC1 (192.168.1.2) — R1 (192.168.1.80) on the ip6.harness bus, as in l4.tcp.test.ts. R1 never sees PC1's SYNs (the
 * bus loses them); R1's icmpv4 is asked to answer them with 3/13, as the acl daemon of a W2 router would.
 */
import { describe, expect, it } from 'vitest';
import { ICMP_DEST_UNREACHABLE, ICMP_UNREACH_ADMIN, ICMP_UNREACH_HOST, type Pdu } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { createTcp } from '../src/protocols/tcp.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';

const tcpOf = (p: Pdu): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === 'tcp')?.fields;
const syns = (w: World6): Pdu[] => w.sentBy('pc1').filter((p) => tcpOf(p)?.flags === 'S');
const ofKind = <K extends ProcessEvent['kind']>(r: Recorder, k: K): Extract<ProcessEvent, { kind: K }>[] =>
  r.evs.filter((e): e is Extract<ProcessEvent, { kind: K }> => e.kind === k);

/** PC1 connects to R1:80; every SYN is lost on the bus, so the connect can only end by its timeout. */
function lab(): { w: World6; cli: Recorder } {
  const cli = recorder('http-client');
  const w = createWorld6({
    seed: 7,
    extra: { tcp: createTcp, 'http-client': () => cli },
    lose: (s) => s.from.device === 'pc1' && tcpOf(s.pdu)?.flags === 'S',
  });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  w.iface('r1', G0, 'ip address 192.168.1.80 255.255.255.0', 'no shutdown');
  w.runFor(1 * SEC);
  w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'http-client', socket: 'c#1', dst: '192.168.1.80', dstPort: 80 });
  w.runFor(100_000_000); // the SYN (and the ARP before it) left
  return { w, cli };
}

/** R1 answers PC1's last SYN with ICMP 3/`code`. */
function answer(w: World6, code: number): void {
  const syn = syns(w).at(-1)!;
  w.request('r1', 'icmpv4', { kind: 'icmp.error', original: syn, type: ICMP_DEST_UNREACHABLE, code, inPort: G0 });
  w.runFor(100_000_000);
}

const debugLines = (w: World6): string[] => w.kinds('debug').filter((e) => e.event.device === w.dev('pc1').id && e.event.category === 'tcp').map((e) => e.event.message);

describe('l4.admin-prohibited: ICMP 3/13 is a soft error (D12)', () => {
  it('records the soft error without aborting the connect; the timeout reports admin-prohibited', () => {
    const { w, cli } = lab();
    expect(syns(w)).toHaveLength(1);
    answer(w, ICMP_UNREACH_ADMIN);
    expect(cli.evs).toEqual([]);
    expect(debugLines(w).some((m) => m === 'c#1: soft error admin-prohibited from 192.168.1.80 (type 3 code 13)')).toBe(true);
    // the connect goes on: the SYN is retransmitted after the RTO
    w.runFor(2 * SEC);
    expect(syns(w).length).toBeGreaterThan(1);
    expect(cli.evs).toEqual([]);
    // every SYN retry is lost: the connect times out with the recorded soft error as its code
    w.runFor(30 * SEC);
    expect(ofKind(cli, 'sock.error')).toEqual([{ kind: 'sock.error', socket: 'c#1', code: 'admin-prohibited', detail: 'no answer from 192.168.1.80' }]);
    expect(w.dev('pc1').tables.get('sockets')!.rows()).toEqual([]);
  });

  it('the last soft error wins, as before: a later 3/1 turns it into host-unreachable', () => {
    const { w, cli } = lab();
    answer(w, ICMP_UNREACH_ADMIN);
    answer(w, ICMP_UNREACH_HOST);
    w.runFor(30 * SEC);
    expect(ofKind(cli, 'sock.error').map((e) => e.code)).toEqual(['host-unreachable']);
  });

  it('hard errors keep their P1 meaning: 3/3 in SYN_SENT aborts at once with port-unreachable', () => {
    const { w, cli } = lab();
    answer(w, 3);
    expect(ofKind(cli, 'sock.error').map((e) => [e.code, e.detail])).toEqual([['port-unreachable', 'port-unreachable reported by 192.168.1.80']]);
  });
});
