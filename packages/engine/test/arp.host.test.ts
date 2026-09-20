import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE_KEY, createHost, defaultGatewayRow } from '../src/protocols/host.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { SEC } from '../src/contracts/time.js';
import type { Action } from '../src/contracts/process.js';
import { makeFake } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0';

/**
 * §9.2 (P1 W3): the host daemon no longer writes the RIB itself — it offers the default route to ipv4 through
 * `ipv4.route`, ipv4 arbitrates it (core/rib-arbiter.ts) and reports the decision back; the row shape is unchanged.
 */
function pc(kind: 'pc' | 'router' = 'pc') {
  const fake = makeFake({ kind, ports: [{ id: GI0, mac: '00:1f:00:00:00:01', ipv4: { address: '10.0.0.1', prefixLen: 24 } }] });
  const host = createHost();
  const ipv4 = createIpv4();
  fake.register(host);
  fake.register(ipv4);
  return { fake, host, ipv4 };
}

const offer = (gw: string, now: number): Action => ({
  type: 'request', to: 'ipv4', req: { kind: 'ipv4.route', op: 'offer', row: defaultGatewayRow(gw, now), owner: 'host' },
});

describe('host daemon', () => {
  it('has no demux selector and ignores frames and timers', () => {
    const { fake, host } = pc();
    expect(host.name).toBe('host');
    expect(host.handles).toBeUndefined();
    expect(host.onTimer(fake.ctx, 'anything')).toEqual([]);
    const pdu = fake.build([{ proto: 'payload', fields: { data: new Uint8Array(4) } }]);
    expect(host.onPdu(fake.ctx, pdu, GI0)).toEqual([]);
  });

  it('installs a static default route on ip default-gateway (offered to ipv4, row shape unchanged)', () => {
    const { fake, host } = pc();
    fake.setNow(2 * SEC);
    const actions = host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] });
    expect(actions).toEqual([offer('10.0.0.254', 2 * SEC)]);
    // nothing is written before ipv4 has decided
    expect(fake.tables.rib.size).toBe(0);
    fake.run(actions);
    const row = fake.tables.rib.get(DEFAULT_ROUTE_KEY);
    expect(row).toEqual({
      key: '0.0.0.0/0',
      network: '0.0.0.0',
      prefixLen: 0,
      source: 'S',
      nextHop: '10.0.0.254',
      ad: 1,
      metric: 0,
      isDefault: true,
      updatedAt: 2 * SEC,
      // §9.3: the row names its owner so ipv4 renders the cause `ip default-gateway` without a kind check.
      owner: 'host',
    });
    expect(fake.ctx.lpm('8.8.8.8').winner?.nextHop).toBe('10.0.0.254');
    expect(host.stateSnapshot()).toEqual({ process: 'host', state: { defaultGateway: '10.0.0.254' } });
    expect(fake.trace.filter((e) => e.kind === 'tableWrite' && e.table === 'rib')).toHaveLength(1);
    // the decision is logged by host after the write (the P0 wording)
    expect(fake.debug.at(-1)!.category).toBe('ip routing');
    expect(fake.debug.at(-1)!.message).toBe('default gateway set to 10.0.0.254: default route installed');
    expect(host.debugEvents()).toHaveLength(1);
    // ipv4 itself stays quiet about routes other daemons offer
    expect(fake.debug).toHaveLength(1);
  });

  it('replaces the route when the gateway changes and removes it on the no form', () => {
    const { fake, host } = pc();
    fake.run(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] }));
    fake.setNow(SEC);
    fake.run(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.253'], before: ['10.0.0.254'] }));
    expect(fake.tables.rib.size).toBe(1);
    expect(fake.tables.rib.get(DEFAULT_ROUTE_KEY)!.nextHop).toBe('10.0.0.253');
    expect(fake.debug.at(-1)!.message).toContain('changed from 10.0.0.254 to 10.0.0.253');

    fake.setNow(2 * SEC);
    const unset = host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'], before: ['10.0.0.253'] });
    expect(unset).toEqual([{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.route', op: 'withdraw', row: defaultGatewayRow('10.0.0.253', 2 * SEC), owner: 'host' } }]);
    fake.run(unset);
    expect(fake.tables.rib.size).toBe(0);
    const exp = fake.trace.filter((e) => e.kind === 'tableExpire' && e.table === 'rib');
    expect(exp).toHaveLength(1);
    expect(exp[0]!.kind === 'tableExpire' && exp[0]!.reason).toBe('cleared');
    expect(exp[0]!.t).toBe(2 * SEC);
    expect(fake.debug.at(-1)!.message).toBe('default gateway removed: default route via 10.0.0.253 withdrawn');
    expect(host.stateSnapshot().state.defaultGateway).toBeNull();
    // Unsetting again is harmless.
    expect(host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'] })).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
  });

  it('ignores other lines, interface-scoped lines and invalid gateways', () => {
    const { fake, host } = pc();
    expect(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['hostname', 'PC1'] })).toEqual([]);
    expect(host.onConfig(fake.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', '10.0.0.1', '255.255.255.0'] })).toEqual([]);
    expect(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254'] })).toEqual([]);
    expect(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', 'gateway'] })).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
    expect(host.stateSnapshot().state.defaultGateway).toBeNull();
  });

  it('leaves a default route it did not install alone', () => {
    const { fake, host, ipv4 } = pc();
    // A default route from `ip route` (offered by ipv4 itself): host's unset without an offer changes nothing.
    ipv4.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.9'] });
    expect(host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'] })).toEqual([]);
    expect(fake.tables.rib.size).toBe(1);
    // An equal-distance static offered earlier stays installed; host's candidate waits and its withdrawal is silent.
    fake.run(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] }));
    expect(fake.tables.rib.get(DEFAULT_ROUTE_KEY)).toMatchObject({ source: 'S', nextHop: '10.0.0.9' });
    expect(fake.tables.rib.get(DEFAULT_ROUTE_KEY)!.owner).toBeUndefined();
    expect(fake.debug.at(-1)!.message).toBe('default gateway 10.0.0.254 kept as a candidate: ip route 0.0.0.0 0.0.0.0 10.0.0.9 is preferred');
    fake.run(host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'] }));
    expect(fake.tables.rib.get(DEFAULT_ROUTE_KEY)).toMatchObject({ source: 'S', nextHop: '10.0.0.9' });
    expect(fake.debug.at(-1)!.message).toBe('default gateway removed (no default route was installed)');
  });

  it('offers nothing on a device that routes (§4.2: only while !model.ipForwarding)', () => {
    const { fake, host } = pc('router');
    expect(fake.ctx.model.ipForwarding).toBe(true);
    expect(host.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] })).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
    expect(host.stateSnapshot().state.defaultGateway).toBe('10.0.0.254');
    expect(fake.debug.at(-1)!.message).toContain('not used while this device routes');
    expect(host.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'default-gateway'] })).toEqual([]);
  });
});
