/**
 * ip6.nd.flags — the DHCPv6 side of ipv6/nd (ARCHITECTURE-P2 D16, §3.11 steps 1–2, §2.5 `RaFlagsEvent`, §7 W2 l3):
 * `ipv6 nd managed-config-flag` / `other-config-flag` set the RA M/O bits (default off, so every existing RA keeps
 * its bytes); ipv6 forwards the flags to dhcpv6-client as `ipv6.ra` whenever they change on an autoconfig interface
 * (only when the model runs dhcpv6-client); an `ipv6 dhcp server <pool>` interface joins ff02::1:2; `ipv6.lease`
 * binds and unbinds a DHCPv6 address that runs DAD; `ipv6 address dhcp` enables IPv6 on the interface.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import { DHCPV6_ALL_AGENTS, ICMPV6_NS, ICMPV6_RA } from '../src/contracts/pdu.js';
import type { ProcessCtx } from '../src/contracts/process.js';
import type { Route6Row } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createIpv6 } from '../src/protocols/ipv6.js';
import { makeFake } from './ip.fake-ctx.js';
import { BOOT_NS, createWorld6, icmp6Of, ofIcmp6Type, type World6 } from './ip6.harness.js';

const R1_LAN = 'GigabitEthernet0/0';
const PC = 'GigabitEthernet0';
const GI0 = 'GigabitEthernet0/0';
const MAC_PC = '00:1f:00:00:00:01';

/** R1 and PC1 on one cable, both booted, R1 routing with a prefix on the LAN. */
function pair(seed = 1): World6 {
  const w = createWorld6({ seed });
  w.add('r1', 'router');
  w.add('pc1', 'pc');
  w.link({ device: 'r1', port: R1_LAN }, { device: 'pc1', port: PC });
  w.runFor(BOOT_NS);
  w.global('r1', 'ipv6 unicast-routing');
  return w;
}

describe('ip6.nd.flags RA M/O bits (D16)', () => {
  it('defaults to M = O = 0 and sets the bits from the interface lines; the flags follow the config at each RA', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.runFor(3 * SEC);
    const before = ofIcmp6Type(w.sentBy('r1', R1_LAN), ICMPV6_RA);
    expect(before.length).toBeGreaterThan(0);
    expect(icmp6Of(before.at(-1)!)).toMatchObject({ managedFlag: false, otherFlag: false });
    w.iface('r1', R1_LAN, 'ipv6 nd other-config-flag');
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(5 * SEC);
    const solicited = ofIcmp6Type(w.sentBy('r1', R1_LAN), ICMPV6_RA).slice(before.length);
    expect(solicited.length).toBeGreaterThan(0);
    expect(icmp6Of(solicited.at(-1)!)).toMatchObject({ managedFlag: false, otherFlag: true });
    w.iface('r1', R1_LAN, 'ipv6 nd managed-config-flag');
    w.runFor(201 * SEC);
    const periodic = ofIcmp6Type(w.sentBy('r1', R1_LAN), ICMPV6_RA);
    expect(icmp6Of(periodic.at(-1)!)).toMatchObject({ managedFlag: true, otherFlag: true });
    w.iface('r1', R1_LAN, 'no ipv6 nd managed-config-flag', 'no ipv6 nd other-config-flag');
    w.runFor(201 * SEC);
    expect(icmp6Of(ofIcmp6Type(w.sentBy('r1', R1_LAN), ICMPV6_RA).at(-1)!)).toMatchObject({ managedFlag: false, otherFlag: false });
    // the PC still autoconfigured its address as in P1
    expect((w.dev('pc1').port(PC)!.l3.ipv6 ?? []).some((a) => a.origin === 'slaac' && a.state === 'preferred')).toBe(true);
  });
});

describe('ip6.nd.flags ipv6.ra event to dhcpv6-client', () => {
  /** A PC fake whose model also runs dhcpv6-client, with `ipv6 address autoconfig` on GI0 (prototype chain keeps the live getters). */
  function pc(withClient: boolean) {
    const fake = makeFake({ kind: 'pc', ports: [{ id: GI0, mac: MAC_PC }] });
    fake.ctx.config.set([['interface', GI0]], ['ipv6', 'address', 'autoconfig']);
    const model = { ...fake.ctx.model, processes: withClient ? [...fake.ctx.model.processes, 'dhcpv6-client' as ProcessName] : fake.ctx.model.processes };
    const ctx = Object.create(fake.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
    const ipv6 = createIpv6();
    fake.register(ipv6);
    fake.run(ipv6.init!(ctx));
    return { fake, ctx, ipv6 };
  }
  const ra = (managed: boolean, other: boolean, router = 'fe80::1') => ({ kind: 'ipv6.raLearned' as const, iface: GI0, router, managed, other, routerLifetimeS: 1800 });

  it('sends ipv6.ra when the flags change on an autoconfig interface, never when they repeat, and not without the client', () => {
    const { fake, ctx, ipv6 } = pc(true);
    const events = () => fake.actionsOf('event').filter((a) => a.to === 'dhcpv6-client').map((a) => a.ev);
    fake.run(ipv6.onRequest!(ctx, ra(false, false)));
    expect(events()).toEqual([{ kind: 'ipv6.ra', iface: GI0, router: 'fe80::1', managed: false, other: false }]);
    fake.run(ipv6.onRequest!(ctx, ra(false, false)));
    expect(events()).toHaveLength(1);
    fake.run(ipv6.onRequest!(ctx, ra(false, true)));
    fake.run(ipv6.onRequest!(ctx, ra(true, true)));
    fake.run(ipv6.onRequest!(ctx, ra(true, true)));
    expect(events().slice(1)).toEqual([
      { kind: 'ipv6.ra', iface: GI0, router: 'fe80::1', managed: false, other: true },
      { kind: 'ipv6.ra', iface: GI0, router: 'fe80::1', managed: true, other: true },
    ]);
    // another router with the same flags is a change (the client keys on the router)
    fake.run(ipv6.onRequest!(ctx, ra(true, true, 'fe80::2')));
    expect(events()).toHaveLength(4);
    // a link bounce forgets the last flags: the next RA is reported again
    fake.setOper(GI0, false);
    fake.run(ipv6.onLinkChange!(ctx, GI0, false));
    fake.setOper(GI0, true);
    fake.run(ipv6.onLinkChange!(ctx, GI0, true));
    fake.run(ipv6.onRequest!(ctx, ra(true, true, 'fe80::2')));
    expect(events()).toHaveLength(5);

    const plain = pc(false);
    plain.fake.run(plain.ipv6.onRequest!(plain.ctx, ra(true, true)));
    expect(plain.fake.actionsOf('event')).toEqual([]);
  });

  it('does not report flags on an interface without autoconfig', () => {
    const fake = makeFake({ kind: 'pc', ports: [{ id: GI0, mac: MAC_PC }] });
    fake.ctx.config.set([['interface', GI0]], ['ipv6', 'enable']);
    const model = { ...fake.ctx.model, processes: [...fake.ctx.model.processes, 'dhcpv6-client' as ProcessName] };
    const ctx = Object.create(fake.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
    const ipv6 = createIpv6();
    fake.register(ipv6);
    fake.run(ipv6.init!(ctx));
    fake.run(ipv6.onRequest!(ctx, ra(true, true)));
    expect(fake.actionsOf('event')).toEqual([]);
  });
});

describe('ip6.nd.flags DHCPv6 server group and leases (D16)', () => {
  it('an ipv6 dhcp server interface joins ff02::1:2 and leaves it with the line', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.runFor(2 * SEC);
    expect(w.dev('r1').port(R1_LAN)!.l3.groups6).not.toContain(DHCPV6_ALL_AGENTS);
    w.iface('r1', R1_LAN, 'ipv6 dhcp server STATELESS');
    expect(w.dev('r1').port(R1_LAN)!.l3.groups6).toContain(DHCPV6_ALL_AGENTS);
    expect(w.dev('r1').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({ interfaces: [{ port: R1_LAN, dhcpServer: true }] });
    w.iface('r1', R1_LAN, 'no ipv6 dhcp server STATELESS');
    expect(w.dev('r1').port(R1_LAN)!.l3.groups6).not.toContain(DHCPV6_ALL_AGENTS);
  });

  it('ipv6 address dhcp enables IPv6 with the link-local only; ipv6.lease binds an address that runs DAD, then unbinds it', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address dhcp');
    w.runFor(2 * SEC);
    const before = w.dev('pc1').port(PC)!.l3.ipv6 ?? [];
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ scope: 'link-local', state: 'preferred' });
    expect(w.dev('pc1').port(PC)!.l3.ipv6Enabled).toBe(true);
    const bindAt = w.now();
    w.request('pc1', 'ipv6', { kind: 'ipv6.lease', op: 'bind', iface: PC, address: '2001:db8:1::2', prefixLen: 128, preferredUntil: bindAt + 3600 * SEC, validUntil: bindAt + 86_400 * SEC, server: 'fe80::1' });
    const tentative = (w.dev('pc1').port(PC)!.l3.ipv6 ?? []).find((a) => a.address === '2001:db8:1::2')!;
    expect(tentative).toMatchObject({ origin: 'dhcpv6', prefixLen: 128, state: 'tentative', preferredUntil: bindAt + 3600 * SEC, validUntil: bindAt + 86_400 * SEC });
    w.runFor(2 * SEC);
    const dad = ofIcmp6Type(w.sentBy('pc1', PC), ICMPV6_NS).filter((p) => icmp6Of(p)!.target === '2001:db8:1::2');
    expect(dad).toHaveLength(1);
    const preferred = (w.dev('pc1').port(PC)!.l3.ipv6 ?? []).find((a) => a.address === '2001:db8:1::2')!;
    expect(preferred).toMatchObject({ origin: 'dhcpv6', state: 'preferred' });
    const rib = w.dev('pc1').tables.get<Route6Row>('rib6')!;
    expect(rib.get('2001:db8:1::2/128')).toMatchObject({ source: 'L', iface: PC });
    expect(w.dev('pc1').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({ interfaces: [{ port: PC, leases: ['2001:db8:1::2'] }] });
    // a renewal keeps the address and only moves its lifetimes
    w.request('pc1', 'ipv6', { kind: 'ipv6.lease', op: 'bind', iface: PC, address: '2001:db8:1::2', prefixLen: 128, preferredUntil: bindAt + 7200 * SEC, validUntil: bindAt + 90_000 * SEC });
    const renewed = (w.dev('pc1').port(PC)!.l3.ipv6 ?? []).find((a) => a.address === '2001:db8:1::2')!;
    expect(renewed).toMatchObject({ state: 'preferred', preferredUntil: bindAt + 7200 * SEC, validUntil: bindAt + 90_000 * SEC });
    w.request('pc1', 'ipv6', { kind: 'ipv6.lease', op: 'unbind', iface: PC, address: '2001:db8:1::2' });
    expect((w.dev('pc1').port(PC)!.l3.ipv6 ?? []).some((a) => a.address === '2001:db8:1::2')).toBe(false);
    expect(rib.has('2001:db8:1::2/128')).toBe(false);
    // a lease on an interface without IPv6 is ignored
    w.request('r1', 'ipv6', { kind: 'ipv6.lease', op: 'bind', iface: 'GigabitEthernet0/1', address: '2001:db8:9::2', prefixLen: 128 });
    expect(w.dev('r1').port('GigabitEthernet0/1')!.l3.ipv6).toBeUndefined();
  });

  it('a leased address expires at the end of its valid lifetime', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address dhcp');
    w.runFor(2 * SEC);
    const at = w.now();
    w.request('pc1', 'ipv6', { kind: 'ipv6.lease', op: 'bind', iface: PC, address: '2001:db8:1::3', prefixLen: 128, preferredUntil: at + 20 * SEC, validUntil: at + 40 * SEC });
    w.runFor(25 * SEC);
    expect((w.dev('pc1').port(PC)!.l3.ipv6 ?? []).find((a) => a.address === '2001:db8:1::3')).toMatchObject({ state: 'deprecated' });
    w.runFor(20 * SEC);
    expect((w.dev('pc1').port(PC)!.l3.ipv6 ?? []).some((a) => a.address === '2001:db8:1::3')).toBe(false);
  });
});
