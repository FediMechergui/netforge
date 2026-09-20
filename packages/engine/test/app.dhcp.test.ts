/**
 * app.dhcp.test.ts — dhcp-client and dhcp-server end to end (protocols/dhcp-{client,server}.ts; ARCHITECTURE-P1
 * §4.3; RFC 2131, RFC 3927), on the ip6.harness bus with the real arp/ipv4/icmpv4/udp daemons.
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { DhcpBindingRow } from '../src/contracts/tables.js';
import { MIN, SEC } from '../src/contracts/time.js';
import { createDhcpClient } from '../src/protocols/dhcp-client.js';
import { createDhcpServer } from '../src/protocols/dhcp-server.js';
import { createUdp } from '../src/protocols/udp.js';
import { BOOT_NS, createWorld6, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const EXTRA = { udp: createUdp, 'dhcp-client': createDhcpClient, 'dhcp-server': createDhcpServer };

function pool(w: World6, dev: string, name: string, ...lines: string[]): void {
  w.global(dev, `ip dhcp pool ${name}`);
  w.act(dev, 'cli', []);
  for (const l of lines) {
    const r = w.dev(dev).applyConfigLine([['ip', 'dhcp', 'pool', name]], l.split(' '), false);
    if (!r.ok) throw new Error(`${l}: ${r.error ?? 'failed'}`);
  }
}

const tags = (w: World6, dev: string): string[] => w.sentBy(dev).map((p: Pdu) => p.meta.tag ?? '').filter((t) => t.startsWith('dhcp-'));
const addr = (w: World6, dev: string, port: string): string | undefined => {
  const a = w.dev(dev).port(port)?.l3.ipv4;
  return a === undefined ? undefined : `${a.address}/${a.prefixLen}`;
};
const bindings = (w: World6, dev: string): DhcpBindingRow[] => w.dev(dev).tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];

/** PC1 (ip address dhcp) — R1 Gi0/0 192.168.1.1 with pool LAN (.1–.9 excluded, 1 h lease). */
function lan(seed = 3, pcs = ['pc1']): World6 {
  const w = createWorld6({ seed, extra: EXTRA });
  for (const pc of pcs) w.add(pc, 'pc');
  w.add('r1', 'router');
  w.link(...pcs.map((pc) => ({ device: pc, port: PC })), { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown');
  w.global('r1', 'ip dhcp excluded-address 192.168.1.1 192.168.1.9');
  pool(w, 'r1', 'LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 192.168.1.10', 'domain-name lab.nf', 'lease 0 1');
  for (const pc of pcs) w.iface(pc, PC, 'ip address dhcp');
  w.runFor(5 * SEC);
  return w;
}

describe('app.dhcp DORA, renew, release', () => {
  it('leases the lowest free address with router and DNS, and installs the DHCP default route', () => {
    const w = lan();
    expect(tags(w, 'pc1')).toEqual(['dhcp-discover', 'dhcp-request']);
    expect(tags(w, 'r1')).toEqual(['dhcp-offer', 'dhcp-ack']);
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.10/24');
    expect(bindings(w, 'r1').map((b) => [b.ip, b.state, b.mac])).toEqual([['192.168.1.10', 'bound', w.dev('pc1').port(PC)!.mac]]);
    const d = w.dev('pc1').tables.rib.rows().find((r) => r.source === 'D');
    expect(d?.nextHop).toBe('192.168.1.1');
    const offer = w.sentBy('r1').find((p) => p.meta.tag === 'dhcp-offer')!;
    expect(offer.meta.triggeredBy).toBe(w.sentBy('pc1').find((p) => p.meta.tag === 'dhcp-discover')!.id);
    const f = offer.layers.find((l) => l.proto === 'dhcp')!.fields;
    expect([f.yiaddr, f.subnetMask, f.router, f.dnsServers, f.domainName, f.leaseTimeS, f.renewalTimeS]).toEqual(['192.168.1.10', '255.255.255.0', '192.168.1.1', '192.168.1.10', 'lab.nf', 3600, 1800]);
  });

  it('renews by unicast at T1 and keeps the address; release frees the binding and the port address', () => {
    const w = lan();
    w.runFor(31 * MIN);
    const renew = w.sentBy('pc1').filter((p) => p.meta.tag === 'dhcp-request')[1]!;
    expect(renew.layers.find((l) => l.proto === 'ipv4')!.fields.dst).toBe('192.168.1.1');
    expect(renew.layers.find((l) => l.proto === 'dhcp')!.fields.ciaddr).toBe('192.168.1.10');
    expect(tags(w, 'r1')).toEqual(['dhcp-offer', 'dhcp-ack', 'dhcp-ack']);
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.10/24');

    w.request('pc1', 'dhcp-client', { kind: 'dhcp.client', iface: PC, op: 'release' });
    w.runFor(1 * SEC);
    expect(tags(w, 'pc1').at(-1)).toBe('dhcp-release');
    expect(addr(w, 'pc1', PC)).toBeUndefined();
    expect(bindings(w, 'r1')).toEqual([]);
  });

  it('renewed as an infinite lease: the old lease timers go, on the client and on the server', () => {
    const w = lan();
    w.dev('r1').applyConfigLine([['ip', 'dhcp', 'pool', 'LAN']], ['lease', 'infinite'], false);
    w.runFor(31 * MIN);
    const ack = w.sentBy('r1').filter((p) => p.meta.tag === 'dhcp-ack').at(-1)!;
    expect(ack.layers.find((l) => l.proto === 'dhcp')!.fields.leaseTimeS).toBe(0xffffffff);
    w.runFor(45 * MIN); // past the end of the lease the client and the server first agreed on
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.10/24');
    expect(bindings(w, 'r1').map((b) => [b.ip, b.state])).toEqual([['192.168.1.10', 'bound']]);
    expect(tags(w, 'pc1').filter((t) => t === 'dhcp-discover')).toHaveLength(1);
  });

  it('a binding outside the pool network is dropped on the next DISCOVER, not re-offered and NAKed', () => {
    const w = lan();
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.10/24');
    w.iface('r1', G0, 'ip address 10.1.1.1 255.255.255.0');
    w.dev('r1').applyConfigLine([['ip', 'dhcp', 'pool', 'LAN']], ['network', '10.1.1.0', '255.255.255.0'], false);
    // the RELEASE goes to an address R1 no longer has, so the server keeps the stale binding
    w.request('pc1', 'dhcp-client', { kind: 'dhcp.client', iface: PC, op: 'release' });
    w.runFor(1 * SEC);
    w.request('pc1', 'dhcp-client', { kind: 'dhcp.client', iface: PC, op: 'renew' });
    w.runFor(10 * SEC);
    expect(addr(w, 'pc1', PC)).toMatch(/^10\.1\.1\.\d+\/24$/);
    expect(tags(w, 'r1').filter((t) => t === 'dhcp-nak')).toEqual([]);
    expect(bindings(w, 'r1').map((b) => b.state)).toEqual(['bound']);
  });

  it('job.abort ends a blocking renew, and nothing later reaches that session', () => {
    const w = createWorld6({ seed: 9, extra: EXTRA });
    w.add('pc1', 'pc');
    w.add('r1', 'router');
    w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
    w.runFor(BOOT_NS);
    w.iface('r1', G0, 'no shutdown');
    w.iface('pc1', PC, 'ip address dhcp');
    w.runFor(1 * SEC);
    w.request('pc1', 'dhcp-client', { kind: 'dhcp.client', iface: PC, op: 'renew', session: 's1' });
    w.runFor(1 * SEC);
    expect(w.done.filter((d) => d.session === 's1')).toHaveLength(0);
    w.request('pc1', 'dhcp-client', { kind: 'job.abort', session: 's1' });
    expect(w.output('s1')).toBe(`${PC}: renew aborted\n`);
    expect(w.done.filter((d) => d.session === 's1')).toHaveLength(1);
    w.runFor(120 * SEC); // the APIPA fallback binds meanwhile: its line belongs to no session
    expect(addr(w, 'pc1', PC)).toMatch(/^169\.254\./);
    expect(w.output('s1')).toBe(`${PC}: renew aborted\n`);
    expect(w.done.filter((d) => d.session === 's1')).toHaveLength(1);
  });

  it('two clients on one segment get distinct addresses', () => {
    const w = lan(3, ['pc1', 'pc2']);
    expect([addr(w, 'pc1', PC), addr(w, 'pc2', PC)].sort()).toEqual(['192.168.1.10/24', '192.168.1.11/24']);
    expect(bindings(w, 'r1').filter((b) => b.state === 'bound')).toHaveLength(2);
  });
});

/** PC1 — R1 Gi0/0 192.168.1.1 (ip helper-address 10.0.0.10) — R2 10.0.0.10 with pool REMOTE 192.168.1.0/24. */
function relayLab(...poolLines: string[]): World6 {
  const w = createWorld6({ seed: 5, extra: EXTRA });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
  w.runFor(BOOT_NS);
  w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'ip helper-address 10.0.0.10', 'no shutdown');
  w.iface('r1', G1, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
  w.iface('r2', G1, 'ip address 10.0.0.10 255.255.255.0', 'no shutdown');
  w.global('r2', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'ip dhcp excluded-address 192.168.1.1');
  pool(w, 'r2', 'REMOTE', 'network 192.168.1.0 /24', 'default-router 192.168.1.1', ...poolLines);
  w.iface('pc1', PC, 'ip address dhcp');
  w.runFor(10 * SEC);
  return w;
}

describe('app.dhcp relay and fallback', () => {
  it('relays through ip helper-address: giaddr picks the remote pool, the reply comes back as a broadcast', () => {
    const w = relayLab();
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.2/24');
    expect(bindings(w, 'r2').map((b) => [b.ip, b.relay])).toEqual([['192.168.1.2', '192.168.1.1']]);
    const relayOut = w.sentBy('r1', G1).find((p) => p.meta.tag === 'dhcp-relay')!;
    expect(relayOut.layers.find((l) => l.proto === 'dhcp')!.fields.giaddr).toBe('192.168.1.1');
    expect(relayOut.meta.triggeredBy).toBeDefined();
  });

  it('answers a relayed client renewing by unicast at T1, and its release, by reading ciaddr', () => {
    const w = relayLab('lease 0 1');
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.2/24');
    w.runFor(31 * MIN);
    const renew = w.sentBy('pc1').filter((p) => p.meta.tag === 'dhcp-request').at(-1)!;
    expect(renew.layers.find((l) => l.proto === 'ipv4')!.fields.dst).toBe('10.0.0.10');
    expect(tags(w, 'r2')).toEqual(['dhcp-offer', 'dhcp-ack', 'dhcp-ack']);
    expect(addr(w, 'pc1', PC)).toBe('192.168.1.2/24');

    w.request('pc1', 'dhcp-client', { kind: 'dhcp.client', iface: PC, op: 'release' });
    w.runFor(1 * SEC);
    expect(bindings(w, 'r2')).toEqual([]);
  });

  it('falls back to 169.254/16 after 4 unanswered DISCOVERs, deterministically', () => {
    const run = (): [string | undefined, number] => {
      const w = createWorld6({ seed: 9, extra: EXTRA });
      w.add('pc1', 'pc');
      w.add('r1', 'router');
      w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
      w.runFor(BOOT_NS);
      w.iface('r1', G0, 'no shutdown');
      w.iface('pc1', PC, 'ip address dhcp');
      w.runFor(70 * SEC);
      return [addr(w, 'pc1', PC), tags(w, 'pc1').filter((t) => t === 'dhcp-discover').length];
    };
    const [a, discovers] = run();
    expect(a).toMatch(/^169\.254\.\d+\.\d+\/16$/);
    expect(discovers).toBe(4);
    expect(run()[0]).toBe(a);
  });
});
