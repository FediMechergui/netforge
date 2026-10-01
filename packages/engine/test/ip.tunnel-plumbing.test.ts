/**
 * ip.tunnel-plumbing [S18] — the l3 half of GRE (ARCHITECTURE-P3 D15, D17, §3.0 (a) steps 4 and 8, §3.10; §7 W1 l3
 * [S18], [C13]): on a hand-built tunnel port (role and encapsulation `tunnel`), `arp.sendVia` resolves nothing and
 * frames nothing — the send goes to the tunnel owner's egress, whatever the next hop (unicast, a group, a broadcast);
 * the ipv4 selector `{layer: 'ipv4', roles: ['tunnel']}` receives what the owner injects with `ingress {port,
 * layer: 'ipv4'}`; `IPV4_UPPER` 47 → gre and [C13] 50 → gre; ICMP 3/4 carries the next-hop MTU in the low 16 bits of
 * `unused` when `icmp.error` has `param` (RFC 1191), and nothing changes without it.
 */
import { describe, expect, it } from 'vitest';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, ICMP_DEST_UNREACHABLE, ICMP_TIME_EXCEEDED, ICMP_UNREACH_FRAG_NEEDED, IPPROTO_ESP, IPPROTO_GRE, OSPF_ALL_ROUTERS } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Process, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { buildDemuxIndex, demuxLookup, ingressVerdict } from '../src/device/pipeline.js';
import { createArp } from '../src/protocols/arp.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { IPV4_HANDLES, createIpv4 } from '../src/protocols/ipv4.js';
import { IPV4_UPPER, ipv4UpperProcess } from '../src/protocols/ip-upper.js';
import { drops, forwardedFrame, makeHarness, sends, type Harness } from './arp.harness.js';
import { framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const TU0 = 'Tunnel0';
const MAC_R = '00:1f:00:00:00:10';
const MAC_TU = '00:1f:00:00:00:30';
const MAC_PC = '00:1f:00:00:00:01';

/** A router with Gi0/0 192.168.1.1/24 and a hand-built Tunnel0 172.16.0.1/30 (role and encapsulation `tunnel`). */
function arpRouter(): Harness {
  return makeHarness({
    kind: 'router',
    ports: [
      { id: GI0, mac: MAC_R, address: '192.168.1.1', prefixLen: 24 },
      { id: TU0, mac: MAC_TU, address: '172.16.0.1', prefixLen: 30, kind: 'virtual', role: 'tunnel', encap: 'tunnel' },
    ],
  });
}

function bare(h: { build(layers: readonly LayerSpec[]): Pdu }, src: string, dst: string): Pdu {
  return h.build([
    { proto: 'ipv4', fields: { src, dst, protocol: 1, ttl: 63 } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(32) } },
  ]);
}

describe('ip.tunnel-plumbing [S18]: the arp.sendVia tunnel branch', () => {
  it('sends on the tunnel port unchanged: no resolution, no framing, no cache row, whatever the next hop', () => {
    const h = arpRouter();
    const arp = createArp();
    for (const nextHop of ['172.16.0.2', OSPF_ALL_ROUTERS, '255.255.255.255', '172.16.0.3']) {
      const pdu = bare(h, '192.168.1.10', '192.168.2.10');
      const before = pdu.bytes.slice();
      const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop, iface: TU0, cause: 'ip route 192.168.2.0 255.255.255.0 172.16.0.2' });
      expect(actions).toEqual([{ type: 'send', port: TU0, pdu }]);
      expect(pdu.layers[0]!.proto).toBe('ipv4');
      expect(pdu.provenance).toEqual([]);
      expect(Array.from(pdu.bytes)).toEqual(Array.from(before));
      expect(h.debug.at(-1)!.message).toBe(`sending to ${nextHop} on ${TU0}: tunnel interface, the tunnel owner encapsulates`);
    }
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state).toMatchObject({ pending: [], requestsSent: 0 });
  });

  it('leaves the framing of a forwarded packet for the owner to strip (D17: strip then push [ipv4, gre])', () => {
    const h = arpRouter();
    const arp = createArp();
    const pdu = forwardedFrame(h, '192.168.1.10', '192.168.2.10', MAC_PC, MAC_R);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: '172.16.0.2', iface: TU0 });
    expect(sends(actions)).toEqual([{ type: 'send', port: TU0, pdu }]);
    expect(pdu.layer('ethernet')!.fields).toMatchObject({ src: MAC_PC, dst: MAC_R, type: ETHERTYPE_IPV4 });
  });

  it('a down tunnel drops link-down; the tunnel never sends ARP (gratuitous or probe)', () => {
    const h = arpRouter();
    const arp = createArp();
    h.ports.get(TU0)!.operUp = false;
    const pdu = bare(h, '192.168.1.10', '192.168.2.10');
    expect(drops(arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: '172.16.0.2', iface: TU0 }))).toEqual([
      { type: 'drop', pdu, reason: 'link-down', detail: `${TU0} is down`, port: TU0 },
    ]);
    h.ports.get(TU0)!.operUp = true;
    expect(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: TU0 })).toEqual([]);
    expect(h.debug.at(-1)!.message).toBe(`no announcement for ${TU0}: the link does not use ARP`);
    // the Ethernet port keeps resolving
    const eth = bare(h, '192.168.1.1', '192.168.1.20');
    const out = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: eth, nextHop: '192.168.1.20', iface: GI0 });
    expect(sends(out)[0]!.pdu.get('ethernet.type')).toBe(ETHERTYPE_ARP);
  });
});

describe('ip.tunnel-plumbing [S18]: the ipv4 tunnel selector', () => {
  it('ipv4 declares {layer: ipv4, roles: [tunnel]} and the demux sends an injected packet on a tunnel port to it', () => {
    expect(IPV4_HANDLES.at(-1)).toEqual({ layer: 'ipv4', roles: ['tunnel'] });
    const processes = new Map<ProcessName, Process>([['arp', createArp()], ['ipv4', createIpv4()], ['icmpv4', createIcmpv4()]]);
    const index = buildDemuxIndex(['arp', 'ipv4', 'icmpv4'], processes);
    expect(demuxLookup(index, 'tunnel', 'ipv4', undefined)?.process).toBe('ipv4');
    // only the tunnel role: a loop ingress at the IP layer elsewhere is unchanged
    expect(demuxLookup(index, 'routed', 'ipv4', undefined)).toBeUndefined();
    expect(demuxLookup(index, 'virtual', 'ipv4', undefined)).toBeUndefined();
    const h = arpRouter();
    const inner = bare(h, '192.168.1.10', '192.168.2.10');
    const port = h.ports.get(TU0)!;
    expect(ingressVerdict({ port, frame: inner, layer: 'ipv4', index })).toMatchObject({ kind: 'deliver', process: 'ipv4', layer: 'ipv4' });
  });

  it('ipv4 forwards a packet received on the tunnel port like any other (the inner TTL decrement)', () => {
    const fake = makeFake({
      kind: 'router',
      ports: [
        { id: GI0, mac: MAC_R, ipv4: { address: '192.168.2.1', prefixLen: 24 } },
        { id: TU0, mac: MAC_TU, ipv4: { address: '172.16.0.2', prefixLen: 30 }, kind: 'virtual', role: 'tunnel', encap: 'tunnel' },
      ],
    });
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    fake.register(ipv4);
    fake.register(arp);
    fake.register(makeSink('icmpv4'));
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', '192.168.2.1', '255.255.255.0'] }));
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', TU0]], line: ['ip', 'address', '172.16.0.2', '255.255.255.252'] }));
    arp.requests.length = 0;
    const pdu = bare(fake, '192.168.1.10', '192.168.2.10');
    fake.run(ipv4.onPdu(fake.ctx, pdu, TU0));
    expect(arp.requests).toMatchObject([{ kind: 'arp.sendVia', pdu, nextHop: '192.168.2.10', iface: GI0, cause: `connected via ${GI0}` }]);
    expect(pdu.get('ipv4.ttl')).toBe(62);
    // and the reverse direction: a route through the tunnel leaves by it
    ipv4.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'route', '192.168.1.0', '255.255.255.0', '172.16.0.1'] });
    arp.requests.length = 0;
    const back = fake.build(framed(MAC_R, MAC_PC, [
      { proto: 'ipv4', fields: { src: '192.168.2.10', dst: '192.168.1.10', protocol: 1, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: 0, code: 0, id: 1, seq: 1 } },
    ]));
    fake.run(ipv4.onPdu(fake.ctx, back, GI0));
    expect(arp.requests).toMatchObject([{ kind: 'arp.sendVia', nextHop: '172.16.0.1', iface: TU0 }]);
  });
});

describe('ip.tunnel-plumbing [S18] [C13]: IP protocols 47 and 50', () => {
  it('maps 47 → gre and 50 → gre (ESP goes to the tunnel owner), delivered only where the model runs gre', () => {
    expect(IPV4_UPPER.find((e) => e.protocol === IPPROTO_GRE)).toEqual({ protocol: 47, process: 'gre', label: 'gre' });
    expect(IPV4_UPPER.find((e) => e.protocol === IPPROTO_ESP)).toEqual({ protocol: 50, process: 'gre', label: 'esp' });
    expect(ipv4UpperProcess({ processes: ['gre'] }, 47)).toBe('gre');
    expect(ipv4UpperProcess({ processes: ['gre'] }, 50)).toBe('gre');
    expect(ipv4UpperProcess({ processes: ['ipv4', 'udp', 'tcp'] }, 47)).toBeUndefined();
    expect(ipv4UpperProcess({ processes: ['ipv4', 'udp', 'tcp'] }, 50)).toBeUndefined();
  });

  it('an outer packet to this router reaches gre when the model runs it; without gre it keeps P1s protocol unreachable', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R, ipv4: { address: '209.165.200.230', prefixLen: 30 } }] });
    const ipv4 = createIpv4();
    const gre = makeSink('gre');
    const icmp = makeSink('icmpv4');
    fake.register(ipv4);
    fake.register(gre);
    fake.register(icmp);
    const model: DeviceModel = { ...fake.ctx.model, processes: [...fake.ctx.model.processes, 'gre'] };
    const withGre = Object.create(fake.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
    for (const protocol of [IPPROTO_GRE, IPPROTO_ESP]) {
      const outer = fake.build(framed(MAC_R, MAC_PC, [
        { proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', protocol, ttl: 254 } },
        { proto: 'payload', fields: { data: new Uint8Array(28) } },
      ]));
      expect(fake.run(ipv4.onPdu(withGre, outer, GI0))).toEqual([{ type: 'deliver', to: 'gre', pdu: outer, port: GI0 }]);
      const plain = fake.build(framed(MAC_R, MAC_PC, [
        { proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', protocol, ttl: 254 } },
        { proto: 'payload', fields: { data: new Uint8Array(28) } },
      ]));
      const acts = fake.run(ipv4.onPdu(fake.ctx, plain, GI0));
      expect(acts[0]).toEqual({ type: 'drop', pdu: plain, reason: 'unsupported-protocol', detail: `ip protocol ${protocol} has no listener`, port: GI0 });
    }
    expect(gre.pdus).toHaveLength(2);
    expect(icmp.requests.map((r) => (r as Extract<ProcessRequest, { kind: 'icmp.error' }>).code)).toEqual([2, 2]);
  });
});

describe('ip.tunnel-plumbing [S18]: icmp.error param (D15, RFC 1191)', () => {
  /** A router whose icmpv4 answers for a packet that arrived on Gi0/0; ipv4 is a sink that records the error. */
  function errorRig(): { fake: Fake; icmp: Process; out: ReturnType<typeof makeSink> } {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R, ipv4: { address: '192.168.1.1', prefixLen: 24 } }] });
    fake.tables.rib.set({ key: '192.168.1.0/24', network: '192.168.1.0', prefixLen: 24, source: 'C', iface: GI0, ad: 0, metric: 0, updatedAt: 0 });
    const icmp = createIcmpv4();
    const out = makeSink('ipv4');
    fake.register(icmp);
    fake.register(out);
    return { fake, icmp, out };
  }

  /** A 1500-byte echo request with DF, from PC1 to PC2 behind the tunnel. */
  function big(fake: Fake): Pdu {
    return fake.build(framed(MAC_R, MAC_PC, [
      { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', protocol: 1, ttl: 63, flags: 2 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 7, seq: 1 } },
      { proto: 'payload', fields: { data: new Uint8Array(1472) } },
    ]));
  }

  const sentError = (out: ReturnType<typeof makeSink>): Pdu => (out.requests.at(-1) as Extract<ProcessRequest, { kind: 'ipv4.send' }>).pdu;

  it('ICMP 3/4 carries the next-hop MTU in the low 16 bits of unused, on the wire', () => {
    const { fake, icmp, out } = errorRig();
    const original = big(fake);
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_FRAG_NEEDED, inPort: GI0, param: 1476 }));
    const err = sentError(out);
    const layer = err.layer('icmpv4')!;
    expect(layer.fields).toMatchObject({ type: 3, code: 4, unused: 1476 });
    expect(Array.from(err.bytes.slice(layer.offset + 4, layer.offset + 8))).toEqual([0x00, 0x00, 0x05, 0xc4]);
    expect(err.layer('ipv4')!.fields).toMatchObject({ src: '192.168.1.1', dst: '192.168.1.10' });
    expect(err.meta).toMatchObject({ triggeredBy: original.id, tag: 'unreachable' });
    expect(fake.debug.at(-1)!.message).toBe('error type 3 code 4 192.168.1.1 > 192.168.1.10 quoting 192.168.1.10 > 192.168.2.10 (next-hop MTU 1476)');
    expect(fake.debug.at(-1)!.data).toMatchObject({ type: 3, code: 4, mtu: 1476 });
    // [C13] an IPsec tunnel's 1456; only the low 16 bits are written
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: big(fake), type: 3, code: 4, inPort: GI0, param: 0x1_05b0 }));
    expect(sentError(out).layer('icmpv4')!.fields.unused).toBe(1456);
  });

  it('without param (every P1/P2 error) and for any other type or code, unused stays 0 and the debug line is unchanged', () => {
    const { fake, icmp, out } = errorRig();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: big(fake), type: 3, code: 4, inPort: GI0 }));
    expect(sentError(out).layer('icmpv4')!.fields.unused).toBe(0);
    expect(fake.debug.at(-1)!.message).toBe('error type 3 code 4 192.168.1.1 > 192.168.1.10 quoting 192.168.1.10 > 192.168.2.10');
    expect(Object.keys(fake.debug.at(-1)!.data!)).toEqual(['original', 'error', 'type', 'code']);
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: big(fake), type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI0, param: 1476 }));
    expect(sentError(out).layer('icmpv4')!.fields).toMatchObject({ type: 11, unused: 0 });
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: big(fake), type: 3, code: 1, inPort: GI0, param: 1476 }));
    expect(sentError(out).layer('icmpv4')!.fields).toMatchObject({ type: 3, code: 1, unused: 0 });
  });
});
