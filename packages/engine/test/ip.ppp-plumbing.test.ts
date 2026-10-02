/**
 * ip.ppp-plumbing [S19] — the l3 half of PPP (ARCHITECTURE-P3 D17, §3.0 (a) step 8, §3.9 step 5, §9.2 item 30; §7 W2
 * l3 [S19]) on hand-built serial ports whose effective encapsulation is `ppp`:
 *  • the ipv4 selector `{layer: 'ppp', ethertype: 0x0021, roles: ['wan']}` (after the HDLC one), so the demux hands an
 *    IPv4 PPP frame on a WAN port to ipv4 and nothing else to it;
 *  • the `arp.sendVia` ppp branch: no resolution and no ARP ever, `ppp {address 0xff, control 0x03, protocol 0x0021}`
 *    encapsulated on a bare packet, a packet framed by another link rewrapped (one PduId), a PPP-framed one sent as it
 *    is, and IP held back (`link-down`) while the port's `ppp` row says IPCP is not opened; a packet that arrived over
 *    PPP and leaves on Ethernet loses its PPP header;
 *  • the `nd.ts:143-148` mapping fix: an IPv6 packet (and an ND message nd builds) on a `ppp` port is PPP-framed with
 *    protocol 0x0057, no longer HDLC-framed; an HDLC port keeps HDLC;
 *  • (W2 fix, verified findings 2 and 7; §9.2 item 30b) the ipv6 selector `{layer: 'ppp', ethertype: 0x0057, roles:
 *    ['wan']}` after the HDLC one, so the far end receives that IPv6, and nd's IPv6CP gate, the twin of arp's IPCP gate.
 */
import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { ETHERTYPE_IPV4, ETHERTYPE_IPV6, HDLC_PROTO_IPV4, HDLC_PROTO_IPV6, PPP_ADDRESS, PPP_CONTROL, PPP_PROTO } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Process, ProcessCtx } from '../src/contracts/process.js';
import type { DeviceTables, PppRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { buildDemuxIndex, demuxLookup } from '../src/device/pipeline.js';
import { LINK_FRAMING_PROTOS, createArp } from '../src/protocols/arp.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { IPV4_HANDLES, createIpv4 } from '../src/protocols/ipv4.js';
import { IPV6_HANDLES, createIpv6 } from '../src/protocols/ipv6.js';
import { createNd } from '../src/protocols/nd.js';
import { drops, forwardedFrame, makeHarness, sends, type Harness } from './arp.harness.js';

const GI0 = 'GigabitEthernet0/0';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const MAC_R = '00:1f:00:00:00:10';
const MAC_SE = '00:1f:00:00:00:20';
const MAC_SE1 = '00:1f:00:00:00:21';
const MAC_PC = '00:1f:00:00:00:01';
const PPP_IPV4: LayerSpec = { proto: 'ppp', fields: { address: PPP_ADDRESS, control: PPP_CONTROL, protocol: PPP_PROTO.ipv4 } };

/** A router with Gi0/0 192.168.1.1/24, Se0/0/0 10.1.1.1/30 in PPP and Se0/0/1 10.2.2.1/30 in HDLC. */
function pppRouter(): Harness {
  return makeHarness({
    kind: 'router',
    ports: [
      { id: GI0, mac: MAC_R, address: '192.168.1.1', prefixLen: 24 },
      { id: SE0, mac: MAC_SE, address: '10.1.1.1', prefixLen: 30, kind: 'serial', encap: 'ppp' },
      { id: SE1, mac: MAC_SE1, address: '10.2.2.1', prefixLen: 30, kind: 'serial' },
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

/** `h.ctx` with a `ppp` table holding `rows` (as the ppp daemon writes it, key = the serial port). */
function withPppTable(h: Harness, rows: readonly Partial<PppRow>[]): ProcessCtx {
  const table = createTable<PppRow>({ name: 'ppp', device: h.ctx.deviceId, sink: { emit: () => undefined }, now: () => h.ctx.now });
  for (const r of rows) table.set({ key: r.port!, updatedAt: 0, phase: 'network', lcp: 'opened', authLocal: 'none', authPeer: 'none', ipcp: 'initial', magic: 1, failures: 0, since: 0, ...r } as PppRow);
  const base = h.ctx.tables;
  const tables: DeviceTables = {
    cam: base.cam,
    arp: base.arp,
    rib: base.rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => (name === 'ppp' ? (table as unknown as Table<R>) : base.get<R>(name)),
    names: () => [...base.names(), 'ppp'],
  };
  return Object.create(h.ctx, { tables: { value: tables, enumerable: true } }) as ProcessCtx;
}

describe('ip.ppp-plumbing [S19]: the ipv4 selector', () => {
  it('ipv4 declares {layer: ppp, ethertype: 0x0021, roles: [wan]} after the HDLC selector; the demux hands it IPv4 PPP frames only', () => {
    expect(IPV4_HANDLES).toEqual([
      { layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES },
      { layer: 'hdlc', ethertype: HDLC_PROTO_IPV4, roles: ['wan'] },
      { layer: 'ppp', ethertype: PPP_PROTO.ipv4, roles: ['wan'] },
      { layer: 'ipv4', roles: ['tunnel'] },
    ]);
    expect(PPP_PROTO.ipv4).toBe(0x0021);
    const processes = new Map<ProcessName, Process>([['arp', createArp()], ['ipv4', createIpv4()], ['icmpv4', createIcmpv4()]]);
    const index = buildDemuxIndex(['arp', 'ipv4', 'icmpv4'], processes);
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipv4)?.process).toBe('ipv4');
    // LCP, IPCP, IPv6 frames are not ipv4's; nor is a PPP frame on a non-WAN role
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.lcp)).toBeUndefined();
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipcp)).toBeUndefined();
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipv6)).toBeUndefined();
    expect(demuxLookup(index, 'routed', 'ppp', PPP_PROTO.ipv4)).toBeUndefined();
    // HDLC keeps its selector
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_IPV4)?.process).toBe('ipv4');
  });
});

describe('ip.ppp-plumbing [S19]: the arp.sendVia ppp branch', () => {
  it('encapsulates a bare packet in PPP 0x0021: no resolution, no ARP, no cache row; the wire image round-trips', () => {
    const h = pppRouter();
    const arp = createArp();
    const pdu = bare(h, '10.1.1.1', '10.1.1.2');
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: '10.1.1.2', iface: SE0, cause: `connected via ${SE0}` });
    expect(actions).toEqual([{ type: 'send', port: SE0, pdu }]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.layer('ppp')!.fields).toMatchObject({ address: PPP_ADDRESS, control: PPP_CONTROL, protocol: PPP_PROTO.ipv4 });
    expect(pdu.provenance.map((m) => [m.reason, m.cause])).toEqual([['Encapsulate', `connected via ${SE0}`]]);
    expect(h.debug.at(-1)!.message).toBe(`framing for 10.1.1.2 on ${SE0}: serial PPP link, no address resolution`);
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state).toMatchObject({ pending: [], requestsSent: 0 });
    const wire = h.decode(pdu.bytes, 'ppp');
    expect(wire.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv4', 'icmpv4', 'payload']);
    expect(wire.get('ppp.fcsValid')).toBe(true);
    expect(wire.get('ipv4.dst')).toBe('10.1.1.2');
  });

  it('rewraps a packet framed by Ethernet (strip, push ppp; one PduId) and sends a PPP-framed packet unchanged', () => {
    const h = pppRouter();
    const arp = createArp();
    const fwd = forwardedFrame(h, '192.168.1.10', '10.1.1.2', MAC_PC, MAC_R);
    const id = fwd.id;
    expect(sends(arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: fwd, nextHop: '10.1.1.2', iface: SE0 }))).toEqual([{ type: 'send', port: SE0, pdu: fwd }]);
    expect(fwd.id).toBe(id);
    expect(fwd.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv4', 'icmpv4', 'payload']);
    expect(fwd.provenance.map((m) => [m.reason, m.field])).toEqual([['Decapsulate', 'ethernet'], ['Encapsulate', 'ppp']]);
    const framed = h.build([PPP_IPV4, ...bare(h, '10.9.9.9', '10.1.1.2').layers.map((l) => ({ proto: l.proto, fields: l.fields }))]);
    const before = Array.from(framed.bytes);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: framed, nextHop: '10.1.1.2', iface: SE0 });
    expect(Array.from(framed.bytes)).toEqual(before);
    expect(framed.provenance).toEqual([]);
  });

  it('a packet that arrived over PPP and leaves on Ethernet (or HDLC) loses its PPP header', () => {
    const h = pppRouter();
    const arp = createArp();
    expect(LINK_FRAMING_PROTOS).toContain('ppp');
    h.tables.arp.set({ key: '192.168.1.10', ip: '192.168.1.10', mac: MAC_PC, iface: GI0, type: 'dynamic', updatedAt: 0 });
    const inner = bare(h, '10.1.1.2', '192.168.1.10').layers.map((l) => ({ proto: l.proto, fields: l.fields }));
    const fromPpp = h.build([PPP_IPV4, ...inner]);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: fromPpp, nextHop: '192.168.1.10', iface: GI0 });
    expect(fromPpp.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(fromPpp.layer('ethernet')!.fields).toMatchObject({ dst: MAC_PC, src: MAC_R, type: ETHERTYPE_IPV4 });
    const toHdlc = h.build([PPP_IPV4, ...inner]);
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: toHdlc, nextHop: '10.2.2.2', iface: SE1 });
    expect(toHdlc.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'icmpv4', 'payload']);
  });

  it('IP waits for IPCP: dropped link-down while the ppp row says it is not opened; sent once it is; no row, no gate', () => {
    const h = pppRouter();
    const arp = createArp();
    const negotiating = withPppTable(h, [{ port: SE0, ipcp: 'req-sent' }]);
    const pdu = bare(h, '10.1.1.1', '10.1.1.2');
    expect(arp.onRequest!(negotiating, { kind: 'arp.sendVia', pdu, nextHop: '10.1.1.2', iface: SE0 })).toEqual([
      { type: 'drop', pdu, reason: 'link-down', detail: `IPCP is not open on ${SE0}`, port: SE0 },
    ]);
    expect(pdu.layers[0]!.proto).toBe('ipv4');
    expect(h.debug.at(-1)!.message).toBe(`cannot send to 10.1.1.2 on ${SE0}: IPCP is req-sent, not opened`);
    const open = withPppTable(h, [{ port: SE0, ipcp: 'opened' }]);
    expect(sends(arp.onRequest!(open, { kind: 'arp.sendVia', pdu, nextHop: '10.1.1.2', iface: SE0 }))).toEqual([{ type: 'send', port: SE0, pdu }]);
    // a row for another port gates nothing here
    const other = withPppTable(h, [{ port: SE1, ipcp: 'closed' }]);
    const p2 = bare(h, '10.1.1.1', '10.1.1.2');
    expect(sends(arp.onRequest!(other, { kind: 'arp.sendVia', pdu: p2, nextHop: '10.1.1.2', iface: SE0 }))).toHaveLength(1);
  });

  it('a down PPP port drops link-down; a PPP port never sends ARP (gratuitous or probe); HDLC is unchanged', () => {
    const h = pppRouter();
    const arp = createArp();
    expect(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: SE0 })).toEqual([]);
    expect(h.debug.at(-1)!.message).toBe(`no announcement for ${SE0}: the link does not use ARP`);
    const probe = arp.onRequest!(h.ctx, { kind: 'arp.probe', owner: 'dhcp-client', token: 't1', iface: SE0, address: '10.1.1.1' });
    expect(probe).toEqual([{ type: 'event', to: 'dhcp-client', ev: { kind: 'arp.probeResult', token: 't1', iface: SE0, address: '10.1.1.1', conflict: false } }]);
    const hdlc = bare(h, '10.2.2.1', '10.2.2.2');
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: hdlc, nextHop: '10.2.2.2', iface: SE1 });
    expect(hdlc.layer('hdlc')!.fields).toMatchObject({ protocol: HDLC_PROTO_IPV4 });
    h.ports.get(SE0)!.operUp = false;
    const pdu = bare(h, '10.1.1.1', '10.1.1.2');
    expect(drops(arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: '10.1.1.2', iface: SE0 }))).toEqual([
      { type: 'drop', pdu, reason: 'link-down', detail: `${SE0} is down`, port: SE0 },
    ]);
  });
});

describe('ip.ppp-plumbing [S19]: the nd.ts mapping fix (a ppp port frames IPv6 as PPP 0x0057)', () => {
  const v6 = (h: Harness): Pdu =>
    h.build([
      { proto: 'ipv6', fields: { src: '2001:db8:1::1', dst: '2001:db8:1::2', nextHeader: 17, hopLimit: 64 } },
      { proto: 'udp', fields: { srcPort: 50000, dstPort: 9 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);

  it('nd.sendVia on a ppp port: PPP 0x0057, no neighbour resolution; an HDLC port keeps HDLC 0x86dd', () => {
    const h = pppRouter();
    const nd = createNd();
    const pdu = v6(h);
    expect(nd.onRequest!(h.ctx, { kind: 'nd.sendVia', pdu, nextHop: 'fe80::2', iface: SE0 })).toEqual([{ type: 'send', port: SE0, pdu }]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv6', 'udp', 'payload']);
    expect(pdu.layer('ppp')!.fields).toMatchObject({ address: PPP_ADDRESS, control: PPP_CONTROL, protocol: PPP_PROTO.ipv6 });
    expect(h.debug.at(-1)!.message).toBe(`framing for fe80::2 on ${SE0}: serial PPP link, no neighbour resolution`);
    expect(h.decode(pdu.bytes, 'ppp').get('ppp.fcsValid')).toBe(true);
    const hdlc = v6(h);
    nd.onRequest!(h.ctx, { kind: 'nd.sendVia', pdu: hdlc, nextHop: 'fe80::2', iface: SE1 });
    expect(hdlc.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv6', 'udp', 'payload']);
    expect(hdlc.layer('hdlc')!.fields).toMatchObject({ protocol: HDLC_PROTO_IPV6 });
    // a packet that arrived over Ethernet is rewrapped into PPP (one PduId)
    const eth = h.build([{ proto: 'ethernet', fields: { dst: MAC_R, src: MAC_PC, type: 0x86dd } }, ...v6(h).layers.map((l) => ({ proto: l.proto, fields: l.fields }))]);
    nd.onRequest!(h.ctx, { kind: 'nd.sendVia', pdu: eth, nextHop: 'fe80::2', iface: SE0 });
    expect(eth.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv6', 'udp', 'payload']);
  });

  it('an ND message nd builds for a ppp port (the DAD solicitation) carries a PPP header, never HDLC, and no link-layer option', () => {
    const h = pppRouter();
    const nd = createNd();
    const out = nd.onRequest!(h.ctx, { kind: 'nd.dad', iface: SE0, address: '2001:db8:1::1' });
    const sent = sends(out);
    expect(sent).toHaveLength(1);
    const ns = sent[0]!.pdu;
    expect(ns.layers.map((l) => l.proto)).toEqual(['ppp', 'ipv6', 'icmpv6']);
    expect(ns.layer('ppp')!.fields).toMatchObject({ protocol: PPP_PROTO.ipv6 });
    expect(ns.layer('icmpv6')!.fields).not.toHaveProperty('sourceLla');
  });
});

describe('ip.ppp-plumbing [S19]: IPv6 over PPP is received, and waits for IPv6CP (W2 fix, §9.2 item 30b)', () => {
  const v6 = (h: Harness): Pdu =>
    h.build([
      { proto: 'ipv6', fields: { src: '2001:db8:1::1', dst: '2001:db8:1::2', nextHeader: 17, hopLimit: 64 } },
      { proto: 'udp', fields: { srcPort: 50000, dstPort: 9 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);

  it('ipv6 declares {layer: ppp, ethertype: 0x0057, roles: [wan]} after the HDLC selector; the demux hands it IPv6 PPP frames', () => {
    expect(IPV6_HANDLES).toEqual([
      { layer: 'ethernet', ethertype: ETHERTYPE_IPV6, roles: L3_ROLES },
      { layer: 'hdlc', ethertype: HDLC_PROTO_IPV6, roles: ['wan'] },
      { layer: 'ppp', ethertype: PPP_PROTO.ipv6, roles: ['wan'] },
    ]);
    expect(PPP_PROTO.ipv6).toBe(0x0057);
    const processes = new Map<ProcessName, Process>([['arp', createArp()], ['ipv4', createIpv4()], ['ipv6', createIpv6()], ['nd', createNd()]]);
    const index = buildDemuxIndex(['arp', 'ipv4', 'ipv6', 'nd'], processes);
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipv6)?.process).toBe('ipv6');
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipv4)?.process).toBe('ipv4');
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_IPV6)?.process).toBe('ipv6');
    // the control protocols are the ppp daemon's, and a PPP frame on a non-WAN role is nobody's
    expect(demuxLookup(index, 'wan', 'ppp', PPP_PROTO.ipv6cp)).toBeUndefined();
    expect(demuxLookup(index, 'routed', 'ppp', PPP_PROTO.ipv6)).toBeUndefined();
  });

  it('IPv6 waits for IPv6CP: dropped link-down while the ppp row says it is not opened (or absent); sent once it is; no row, no gate', () => {
    const h = pppRouter();
    const nd = createNd();
    const pdu = v6(h);
    const negotiating = withPppTable(h, [{ port: SE0, ipcp: 'opened', ipv6cp: 'req-sent' }]);
    expect(nd.onRequest!(negotiating, { kind: 'nd.sendVia', pdu, nextHop: 'fe80::2', iface: SE0 })).toEqual([
      { type: 'drop', pdu, reason: 'link-down', detail: `IPv6CP is not open on ${SE0}`, port: SE0 },
    ]);
    expect(h.debug.at(-1)!.message).toBe(`cannot send to fe80::2 on ${SE0}: IPv6CP is req-sent, not opened`);
    // a row without IPv6CP (only IPCP negotiated) holds IPv6 back too
    const ipv4Only = withPppTable(h, [{ port: SE0, ipcp: 'opened' }]);
    expect(drops(nd.onRequest!(ipv4Only, { kind: 'nd.sendVia', pdu: v6(h), nextHop: 'fe80::2', iface: SE0 }))).toHaveLength(1);
    expect(h.debug.at(-1)!.message).toBe(`cannot send to fe80::2 on ${SE0}: IPv6CP is not negotiated, not opened`);
    const open = withPppTable(h, [{ port: SE0, ipcp: 'opened', ipv6cp: 'opened' }]);
    const ok = v6(h);
    expect(nd.onRequest!(open, { kind: 'nd.sendVia', pdu: ok, nextHop: 'fe80::2', iface: SE0 })).toEqual([{ type: 'send', port: SE0, pdu: ok }]);
    expect(ok.layer('ppp')!.fields).toMatchObject({ protocol: PPP_PROTO.ipv6 });
    // another port's row gates nothing here, and no ppp table at all (W2: no ppp daemon) sends as before
    const other = withPppTable(h, [{ port: SE1, ipcp: 'initial', ipv6cp: 'initial' }]);
    expect(sends(nd.onRequest!(other, { kind: 'nd.sendVia', pdu: v6(h), nextHop: 'fe80::2', iface: SE0 }))).toHaveLength(1);
    expect(sends(nd.onRequest!(h.ctx, { kind: 'nd.sendVia', pdu: v6(h), nextHop: 'fe80::2', iface: SE0 }))).toHaveLength(1);
  });
});
