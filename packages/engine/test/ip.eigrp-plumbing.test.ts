/**
 * ip.eigrp-plumbing [C1] — the l3 half of EIGRP (ARCHITECTURE-P3 D8, D11, D26, §2.16, §3.12; §7 W1 l3 [C1]):
 * `IPV4_UPPER` 88 → eigrp (hellos to 224.0.0.10 through a joined group); successors reach ipv4 as one `ipv4.routes`
 * batch (owner eigrp, source 'EIGRP', AD 90); `multipathEligible` covers 'EIGRP' (equal-cost successors share the
 * prefix); `routeCause` renders `eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2`, while the DHCP default keeps
 * 'D' and its own cause (D11); a successor through an interface that goes down is withdrawn at link-down (§3.12
 * step 3: the feasible successor's batch then installs with one write).
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { EIGRP_GROUP, IPPROTO_EIGRP } from '../src/contracts/pdu.js';
import type { ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { AD_DHCP, AD_EIGRP, AD_OSPF, routeKey, type RouteRow } from '../src/contracts/tables.js';
import { createIpv4, routeCause, routeSourceCode, routingProcessId } from '../src/protocols/ipv4.js';
import { IPV4_UPPER, ipv4UpperProcess } from '../src/protocols/ip-upper.js';
import { framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PEER = '00:1f:00:00:00:02';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });

function d(network: string, prefixLen: number, nextHop: string, iface: string, metric: number): RouteRow {
  return { key: routeKey(network, prefixLen), network, prefixLen, source: 'EIGRP', nextHop, iface, ad: AD_EIGRP, metric, updatedAt: 0 };
}

function o(network: string, prefixLen: number, nextHop: string, iface: string, metric: number): RouteRow {
  return { key: routeKey(network, prefixLen), network, prefixLen, source: 'O', nextHop, iface, ad: AD_OSPF, metric, updatedAt: 0 };
}

const routes = (owner: string, rows: RouteRow[]): ProcessRequest => ({ kind: 'ipv4.routes', owner, rows });

/** R1 of §3.12: Gi0/0 10.0.12.1/24 (R2 .2), Gi0/1 10.0.13.1/24 (R3 .3), `router eigrp 100` stored. */
function r1() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(makeSink('icmpv4'));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.12.1', '255.255.255.0')));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.13.1', '255.255.255.0')));
  fake.ctx.config.set([], ['router', 'eigrp', '100']);
  arp.requests.length = 0;
  return { fake, ipv4, arp };
}

function ribWrites(fake: Fake, from: number): { kind: string; key: string }[] {
  return fake.trace
    .slice(from)
    .filter((e) => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.table === 'rib')
    .map((e) => ({ kind: e.kind, key: (e as { key: string }).key }));
}

describe('ip.eigrp-plumbing [C1]: IP protocol 88', () => {
  it('maps 88 to eigrp, delivered only where the model runs eigrp', () => {
    expect(IPV4_UPPER.find((e) => e.protocol === IPPROTO_EIGRP)).toEqual({ protocol: 88, process: 'eigrp', label: 'eigrp' });
    expect(ipv4UpperProcess({ processes: ['eigrp'] }, 88)).toBe('eigrp');
    expect(ipv4UpperProcess({ processes: ['ospf'] }, 88)).toBeUndefined();
    // the table stays in protocol-number order
    expect(IPV4_UPPER.map((e) => e.protocol)).toEqual([1, 6, 17, 47, 50, 88, 89]);
  });

  it('a hello to 224.0.0.10 joined on the port reaches eigrp; a model without eigrp drops it with no ICMP', () => {
    const { fake, ipv4 } = r1();
    const eigrp = makeSink('eigrp');
    fake.register(eigrp);
    const model: DeviceModel = { ...fake.ctx.model, processes: [...fake.ctx.model.processes, 'eigrp'] };
    const ctx = Object.create(fake.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
    fake.run(ipv4.onRequest!(ctx, { kind: 'ipv4.group', op: 'join', iface: GI0, group: EIGRP_GROUP, owner: 'eigrp' }));
    const hello = () =>
      fake.build(framed('01:00:5e:00:00:0a', MAC_PEER, [
        { proto: 'ipv4', fields: { src: '10.0.12.2', dst: EIGRP_GROUP, protocol: IPPROTO_EIGRP, ttl: 2, dscp: 48 } },
        { proto: 'payload', fields: { data: new Uint8Array(40) } },
      ]));
    const pdu = hello();
    expect(fake.run(ipv4.onPdu(ctx, pdu, GI0))).toEqual([{ type: 'deliver', to: 'eigrp', pdu, port: GI0 }]);
    expect(eigrp.pdus).toEqual([pdu]);
    const other = hello();
    expect(fake.run(ipv4.onPdu(fake.ctx, other, GI0))).toEqual([
      { type: 'drop', pdu: other, reason: 'unsupported-protocol', detail: 'ip protocol 88 has no listener', port: GI0 },
    ]);
  });
});

describe('ip.eigrp-plumbing [C1]: successors through ipv4.routes', () => {
  it('installs D rows (AD 90) with the EIGRP cause; equal-cost successors share the prefix', () => {
    const { fake, ipv4, arp } = r1();
    expect(ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.4.0.0', 24, '10.0.12.2', GI0, 3328)]))).toEqual([]);
    const row = fake.tables.rib.get('10.4.0.0/24')!;
    expect(row).toMatchObject({ source: 'EIGRP', ad: 90, metric: 3328, nextHop: '10.0.12.2', iface: GI0, owner: 'eigrp' });
    expect(routingProcessId(fake.ctx, 'eigrp')).toBe('100');
    expect(routeCause(row, fake.ctx)).toBe('eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2');
    expect(routeSourceCode(row)).toBe('D');
    expect(fake.debug.at(-1)!.message).toBe('add D 10.4.0.0/24 via 10.0.12.2 [90/3328] (eigrp)');
    // two equal-cost successors: one row with both paths, each with its cause
    ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.4.0.0', 24, '10.0.12.2', GI0, 3328), d('10.4.0.0', 24, '10.0.13.3', GI1, 3328)]));
    expect(fake.tables.rib.get('10.4.0.0/24')!.paths).toEqual([
      { nextHop: '10.0.12.2', iface: GI0, cause: 'eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2' },
      { nextHop: '10.0.13.3', iface: GI1, cause: 'eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.13.3' },
    ]);
    // forwarding uses the EIGRP cause on the TTL decrement
    const pdu = fake.build(framed(MAC_R0, MAC_PEER, [
      { proto: 'ipv4', fields: { src: '10.0.12.9', dst: '10.4.0.10', protocol: 1, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    ]));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    const req = arp.requests.at(-1) as Extract<ProcessRequest, { kind: 'arp.sendVia' }>;
    expect(req.cause).toMatch(/^eigrp 100: D 10\.4\.0\.0\/24 \[90\/3328\] via 10\.0\.1[23]\.[23]$/);
    expect(fake.mutations.at(-1)).toMatchObject({ reason: 'TtlDecrement', cause: req.cause });
  });

  it('EIGRP (90) beats OSPF (110) for one prefix; withdrawing EIGRP re-installs the OSPF route', () => {
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes('ospf', [o('10.4.0.0', 24, '10.0.13.3', GI1, 3)]));
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'O' });
    ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.4.0.0', 24, '10.0.12.2', GI0, 3328)]));
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'EIGRP', ad: 90 });
    expect(fake.debug.at(-1)!.message).toBe('change D 10.4.0.0/24 via 10.0.12.2 [90/3328] (eigrp; was O 10.4.0.0/24 via 10.0.13.3 [110/3])');
    ipv4.onRequest!(fake.ctx, routes('eigrp', []));
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'O', nextHop: '10.0.13.3' });
    // the two owners' sets are independent: an OSPF batch leaves EIGRP rows alone
    ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.5.0.0', 24, '10.0.12.2', GI0, 3072)]));
    ipv4.onRequest!(fake.ctx, routes('ospf', []));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ source: 'EIGRP' });
    expect(fake.tables.rib.get('10.4.0.0/24')).toBeUndefined();
  });

  it('§3.12 step 3: the successor via Gi0/0 goes at link-down; the feasible successor batch then installs with one write', () => {
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.4.0.0', 24, '10.0.12.2', GI0, 3328)]));
    fake.setOper(GI0, false);
    ipv4.onLinkChange!(fake.ctx, GI0, false);
    expect(fake.tables.rib.get('10.4.0.0/24')).toBeUndefined();
    expect(fake.trace.filter((e) => e.kind === 'tableExpire' && e.key === '10.4.0.0/24').map((e) => (e as { reason: string }).reason)).toEqual(['link-down']);
    const mark = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes('eigrp', [d('10.4.0.0', 24, '10.0.13.3', GI1, 28672)]));
    expect(ribWrites(fake, mark)).toEqual([{ kind: 'tableWrite', key: '10.4.0.0/24' }]);
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'EIGRP', nextHop: '10.0.13.3', metric: 28672 });
  });

  it('keeps EIGRP and the DHCP default apart: D is DHCP (D*, 254, its own cause), EIGRP is D only when rendered', () => {
    const dhcp: RouteRow = { key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'D', nextHop: '192.168.1.1', iface: GI0, ad: AD_DHCP, metric: 0, isDefault: true, updatedAt: 0 };
    expect(routeSourceCode(dhcp)).toBe('D*');
    expect(routeCause(dhcp)).toBe('dhcp default route via 192.168.1.1');
    const e = d('10.4.0.0', 24, '10.0.12.2', GI0, 3328);
    expect(routeSourceCode(e)).toBe('D');
    expect(routeCause(e)).toBe('eigrp: D 10.4.0.0/24 [90/3328] via 10.0.12.2');
  });
});
