/**
 * The W2 routing lines (ARCHITECTURE-P2 §3.4, §3.5, §5.2, D2, D11, D13; §7 W2 cli): `ip routing` (bothForms),
 * the `ip route` forms with a canonical stored line and a matching `no` form, the `ipv6 route` forms with a
 * distance, router subinterfaces (`interface g0/0.10` → `config-subif`, `encapsulation dot1Q`, the `ip address`
 * guard) and `show ip route static`.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { PortView } from '../src/contracts/port.js';
import { BUILTIN_GRAMMAR, HANDLERS, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_BAD_NEXT_HOP, MSG_BAD_ROUTE_OPTION, MSG_ROUTE_TWO_HOPS, MSG_UNKNOWN_INTERFACE, parseRouteTail } from '../src/cli/handlers/config.js';
import { MSG_BAD_IPV6_NEXT_HOP, MSG_ROUTE6_TWO_HOPS } from '../src/cli/handlers/ipv6.js';
import { ROUTE_CODES_LEGEND } from '../src/cli/handlers/show.js';
import { matchCommand } from '../src/cli/parser.js';
import { createCliRuntime } from '../src/cli/runtime.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { testPortView } from './cli.parser.fixture.js';
import { ArrayTrace, fakeCatalog, INERT_RF_VIEWS } from './cli.runtime.fake.js';
import { P05Device } from './cli.runtime.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const ROUTER = catalogModel('router.nf2911');
const MLS = catalogModel('mlswitch.nfc3650-24');
const GI0 = 'GigabitEthernet0/0';
const SUB = 'GigabitEthernet0/0.10';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function router(opts: CommandCtxOptions = { mode: 'config' }): RecordingCtx {
  return commandCtxFor(ROUTER, opts);
}

const routeLines = (rec: RecordingCtx): string[] => rec.running.render().split('\n').filter((l) => l.startsWith('ip route') || l.startsWith('ipv6 route'));

describe('ip routing', () => {
  it('stores both forms in one slot, each replacing the other', () => {
    const r = commandCtxFor(MLS, { mode: 'config' });
    expect(run(r, P2_HANDLERS.configIpRouting)).toEqual({});
    expect(r.configCalls).toEqual([{ line: ['ip', 'routing'], negate: false, context: [] }]);
    expect(r.running.render()).toContain('\nip routing\n');
    expect(run(r, P2_HANDLERS.configIpRouting, {}, true)).toEqual({});
    expect(r.running.render()).toContain('\nno ip routing\n');
    expect(r.running.render()).not.toContain('\nip routing\n');
    expect(run(r, P2_HANDLERS.configIpRouting)).toEqual({});
    expect(r.running.render()).toContain('\nip routing\n');
    expect(r.running.render()).not.toContain('no ip routing');
  });

  it('exists on routing devices only', () => {
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config'), 'ip routing')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpRouting } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(MLS, 'config'), 'no ip routing')).toMatchObject({ ok: true, negated: true });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('switch.nfc2960'), 'config'), 'ip routing').ok).toBe(false);
  });
});

describe('ip route forms', () => {
  it('parses the tail into a next hop, a distance and permanent', () => {
    expect(parseRouteTail('', false)).toEqual({ permanent: false });
    expect(parseRouteTail('10.1.1.1 5 permanent', true)).toEqual({ via: '10.1.1.1', distance: 5, permanent: true });
    expect(parseRouteTail('perm 200', true)).toEqual({ distance: 200, permanent: true });
    expect(parseRouteTail('10.1.1.1', false)).toBe(MSG_ROUTE_TWO_HOPS);
    expect(parseRouteTail('0', false)).toBe(MSG_BAD_ROUTE_OPTION);
    expect(parseRouteTail('256', false)).toBe(MSG_BAD_ROUTE_OPTION);
    expect(parseRouteTail('5 6', false)).toBe(MSG_BAD_ROUTE_OPTION);
    expect(parseRouteTail('tag 5', false)).toBe(MSG_BAD_ROUTE_OPTION);
  });

  it('stores the canonical §5.2 line: canonical ids, no distance of 1', () => {
    const r = router();
    expect(run(r, HANDLERS.configIpRoute, { network: '10.2.0.0', mask: '255.255.0.0', nexthop: '10.0.0.2' })).toEqual({});
    expect(run(r, HANDLERS.configIpRoute, { network: '10.3.0.0', mask: '255.255.0.0', nexthop: 'g0/1', tail: '10.9.0.2 5 permanent' })).toEqual({});
    expect(run(r, HANDLERS.configIpRoute, { network: '0.0.0.0', mask: '0.0.0.0', nexthop: '10.0.0.254', tail: '1' })).toEqual({});
    expect(run(r, HANDLERS.configIpRoute, { network: '10.4.0.0', mask: '255.255.0.0', nexthop: 'g0/1', tail: '250' })).toEqual({});
    expect(routeLines(r)).toEqual([
      'ip route 10.2.0.0 255.255.0.0 10.0.0.2',
      'ip route 10.3.0.0 255.255.0.0 GigabitEthernet0/1 10.9.0.2 5 permanent',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.254',
      'ip route 10.4.0.0 255.255.0.0 GigabitEthernet0/1 250',
    ]);
    expect(run(r, HANDLERS.configIpRoute, { network: '10.5.0.0', mask: '255.255.0.0', nexthop: '10.0.0.2', tail: '10.0.0.3' }).error).toBe(MSG_ROUTE_TWO_HOPS);
    expect(run(r, HANDLERS.configIpRoute, { network: '10.5.0.0', mask: '255.255.0.0', nexthop: 'nowhere' }).error).toBe(MSG_BAD_NEXT_HOP);
  });

  it('no ip route removes every line for the destination and hop, whatever the distance', () => {
    const r = router();
    r.running.set([], ['ip', 'route', '10.3.0.0', '255.255.0.0', '10.9.0.2', '5']);
    r.running.set([], ['ip', 'route', '10.3.0.0', '255.255.0.0', '10.0.0.2']);
    r.running.set([], ['ip', 'route', '10.3.0.0', '255.255.0.0', 'GigabitEthernet0/1', '10.9.0.3']);
    r.running.set([], ['ip', 'route', '10.3.0.0', '255.255.0.0', 'GigabitEthernet0/1', '7']);
    expect(run(r, HANDLERS.configIpRoute, { network: '10.3.0.0', mask: '255.255.0.0', nexthop: '10.9.0.2' }, true)).toEqual({});
    expect(routeLines(r)).toEqual([
      'ip route 10.3.0.0 255.255.0.0 10.0.0.2',
      'ip route 10.3.0.0 255.255.0.0 GigabitEthernet0/1 10.9.0.3',
      'ip route 10.3.0.0 255.255.0.0 GigabitEthernet0/1 7',
    ]);
    // an interface-only `no` leaves the fully specified route alone
    expect(run(r, HANDLERS.configIpRoute, { network: '10.3.0.0', mask: '255.255.0.0', nexthop: 'g0/1' }, true)).toEqual({});
    expect(routeLines(r)).toEqual(['ip route 10.3.0.0 255.255.0.0 10.0.0.2', 'ip route 10.3.0.0 255.255.0.0 GigabitEthernet0/1 10.9.0.3']);
    expect(run(r, HANDLERS.configIpRoute, { network: '10.3.0.0', mask: '255.255.0.0', nexthop: 'g0/1', tail: '10.9.0.3' }, true)).toEqual({});
    expect(routeLines(r)).toEqual(['ip route 10.3.0.0 255.255.0.0 10.0.0.2']);
    // nothing stored: the exact line is unset (a no-op, no error)
    expect(run(r, HANDLERS.configIpRoute, { network: '10.8.0.0', mask: '255.255.0.0', nexthop: '10.0.0.2' }, true)).toEqual({});
    expect(routeLines(r)).toEqual(['ip route 10.3.0.0 255.255.0.0 10.0.0.2']);
  });

  it('parses every form, keeping the P1 args exact when no tail is typed', () => {
    const conf = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ip route 10.0.0.0 255.0.0.0 10.1.1.1')).toMatchObject({ ok: true, args: { network: '10.0.0.0', mask: '255.0.0.0', nexthop: '10.1.1.1' } });
    const m = matchCommand(BUILTIN_GRAMMAR, conf, 'ip route 10.0.0.0 255.0.0.0 g0/1 10.1.1.1 5 permanent');
    expect(m).toMatchObject({ ok: true, args: { nexthop: 'g0/1', tail: '10.1.1.1 5 permanent' } });
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'no ip route 10.0.0.0 255.0.0.0 10.1.1.1 5')).toMatchObject({ ok: true, negated: true, args: { tail: '5' } });
  });
});

describe('ipv6 route forms', () => {
  it('stores the distance after an address or after an interface with its next hop, dropping 1', () => {
    const r = router();
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '2001:db8:2::/64', nexthop: '2001:DB8:1::2', distance: '5' })).toEqual({});
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'g0/1', via: 'fe80::1', distance: '10' })).toEqual({});
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '2001:db8:3::/64', nexthop: 'g0/1', distance: '1' })).toEqual({});
    expect(routeLines(r)).toEqual([
      'ipv6 route 2001:db8:2::/64 2001:db8:1::2 5',
      'ipv6 route ::/0 GigabitEthernet0/1 fe80::1 10',
      'ipv6 route 2001:db8:3::/64 GigabitEthernet0/1',
    ]);
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: '2001:db8::1', via: 'fe80::2' }).error).toBe(MSG_ROUTE6_TWO_HOPS);
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'nowhere' }).error).toBe(MSG_BAD_IPV6_NEXT_HOP);
    // no form: any distance, but a next hop after the interface is another route
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '2001:db8:2::/64', nexthop: '2001:db8:1::2' }, true)).toEqual({});
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'g0/1' }, true)).toEqual({});
    expect(routeLines(r)).toEqual(['ipv6 route ::/0 GigabitEthernet0/1 fe80::1 10', 'ipv6 route 2001:db8:3::/64 GigabitEthernet0/1']);
    expect(run(r, HANDLERS.configIpv6Route, { prefix: '::/0', nexthop: 'g0/1', via: 'fe80::1' }, true)).toEqual({});
    expect(routeLines(r)).toEqual(['ipv6 route 2001:db8:3::/64 GigabitEthernet0/1']);
  });

  it('parses the distance in both positions', () => {
    const conf = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ipv6 route 2001:db8::/64 2001:db8:1::2 5')).toMatchObject({ ok: true, args: { nexthop: '2001:db8:1::2', distance: '5' } });
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ipv6 route ::/0 g0/1 fe80::1 10')).toMatchObject({ ok: true, args: { nexthop: 'g0/1', via: 'fe80::1', distance: '10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ipv6 route ::/0 g0/1 10')).toMatchObject({ ok: true, args: { nexthop: 'g0/1', distance: '10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ipv6 route ::/0 g0/1 fe80::1')).toMatchObject({ ok: true, args: { via: 'fe80::1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'ipv6 route ::/0 g0/1 300').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'no ipv6 route ::/0 g0/1')).toMatchObject({ ok: true, negated: true });
  });
});

describe('subinterfaces', () => {
  /** A router whose Gi0/0 carries the subinterface Gi0/0.10 (created; `dot1q` set when asked). */
  function withSubif(dot1q?: { vid: number; native: boolean }): Map<string, PortView> {
    const ports = devicePortViews(ROUTER);
    const view = testPortView({ name: SUB, short: 'Gi0/0.10', kind: 'virtual', speedBps: 0, autoMdix: false, role: 'subif', parent: GI0 });
    ports.set(SUB, dot1q === undefined ? view : { ...view, dot1q });
    return ports;
  }

  it('interface g0/0.10 creates the subinterface and enters config-subif', () => {
    const r = router({ mode: 'config', ensureVirtualPort: (name) => ({ ok: true, port: SUB, created: true }) });
    expect(run(r, HANDLERS.configInterface, { iface: 'g0/0.10' })).toEqual({});
    expect(r.deviceCalls).toEqual(['ensureVirtualPort g0/0.10']);
    expect(r.configCalls).toEqual([{ line: ['interface', SUB], negate: false, context: [] }]);
    expect(r.enterModeCalls).toEqual([{ mode: 'config-subif', opts: { iface: SUB, context: [['interface', SUB]] } }]);
    const existing = router({ mode: 'config', ports: withSubif() });
    run(existing, HANDLERS.configInterface, { iface: SUB });
    expect(existing.deviceCalls).toEqual([]);
    expect(existing.enterModeCalls[0]?.mode).toBe('config-subif');
    expect(run(router(), HANDLERS.configInterface, { iface: 'Nothing9' }).error).toBe(MSG_UNKNOWN_INTERFACE);
  });

  it('encapsulation dot1Q belongs on a subinterface, once per VID on a parent', () => {
    const physical = router({ iface: GI0 });
    expect(run(physical, P2_HANDLERS.ifEncapsulationDot1q, { vid: '10' }).error).toBe(CLI_MESSAGES.encapNotHere.replace('{port}', GI0));
    const sub = router({ iface: SUB, ports: withSubif() });
    expect(run(sub, P2_HANDLERS.ifEncapsulationDot1q, { vid: '10' })).toEqual({});
    expect(run(sub, P2_HANDLERS.ifEncapsulationDot1q, { vid: '99', native: 'native' })).toEqual({});
    expect(run(sub, P2_HANDLERS.ifEncapsulationDot1q, {}, true)).toEqual({});
    expect(sub.configCalls).toEqual([
      { line: ['encapsulation', 'dot1Q', '10'], negate: false, context: undefined },
      { line: ['encapsulation', 'dot1Q', '99', 'native'], negate: false, context: undefined },
      { line: ['encapsulation'], negate: true, context: undefined },
    ]);
    const ports = withSubif();
    const other = testPortView({ name: 'GigabitEthernet0/0.20', short: 'Gi0/0.20', kind: 'virtual', speedBps: 0, autoMdix: false, role: 'subif', parent: GI0 });
    ports.set('GigabitEthernet0/0.20', { ...other, dot1q: { vid: 20, native: false } });
    const dup = router({ iface: SUB, ports });
    expect(run(dup, P2_HANDLERS.ifEncapsulationDot1q, { vid: '20' }).error).toBe(CLI_MESSAGES.duplicateVid.replace('{vlan}', '20').replace('{other}', 'GigabitEthernet0/0.20'));
    expect(dup.configCalls).toEqual([]);
  });

  it('ip address on a subinterface needs the encapsulation first', () => {
    const bare = router({ iface: SUB, ports: withSubif() });
    expect(run(bare, HANDLERS.ifIpAddress, { address: '192.168.10.1', mask: '255.255.255.0' }).error).toBe(CLI_MESSAGES.subifNeedsEncap);
    expect(bare.configCalls).toEqual([]);
    const tagged = router({ iface: SUB, ports: withSubif({ vid: 10, native: false }) });
    expect(run(tagged, HANDLERS.ifIpAddress, { address: '192.168.10.1', mask: '255.255.255.0' })).toEqual({});
    expect(run(tagged, HANDLERS.ifIpAddress, {}, true)).toEqual({});
  });

  it('parses on routed Ethernet ports and subinterfaces, in any case, not on a serial line', () => {
    const routed = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(matchCommand(BUILTIN_GRAMMAR, routed, 'encapsulation dot1Q 10 native')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifEncapsulationDot1q }, args: { vid: '10', native: 'native' } });
    expect(matchCommand(BUILTIN_GRAMMAR, routed, 'encapsulation dot1q 10')).toMatchObject({ ok: true, args: { vid: '10' } });
    const sub = matchContextFor(ROUTER, 'config-if', { ports: withSubif(), iface: SUB });
    expect(matchCommand(BUILTIN_GRAMMAR, sub, 'encapsulation dot1q 10')).toMatchObject({ ok: true });
    expect(matchCommand(BUILTIN_GRAMMAR, sub, 'ip address 192.168.10.1 255.255.255.0')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifIpAddress } });
    expect(matchCommand(BUILTIN_GRAMMAR, sub, 'duplex full').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config-if', { iface: 'Serial0/0/0' }), 'encapsulation dot1q 10').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config-if', { iface: 'Serial0/0/0' }), 'encapsulation hdlc')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifEncapsulation } });
  });

  it('the runtime enters config-subif on a P2-stage router and offers the interface lines there', () => {
    const devices = new Map<string, P05Device>();
    const cli = createCliRuntime({ device: (id) => devices.get(id), catalog: fakeCatalog, trace: new ArrayTrace(), now: () => 0, ...INERT_RF_VIEWS });
    const dev = new P05Device('d_r1', p2Model('router.nf2911'), 'R1');
    devices.set('d_r1', dev);
    const id = cli.open('d_r1', 'console');
    cli.exec(id, 'enable');
    cli.exec(id, 'configure terminal');
    const r = cli.exec(id, 'interface g0/0.10');
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('config-subif');
    expect(r.prompt).toBe('R1(config-subif)#');
    expect(cli.session(id)).toMatchObject({ iface: SUB, context: [['interface', SUB]] });
    expect(dev.ports.get(SUB)?.spec.parent).toBe(GI0);
    expect(cli.exec(id, 'encapsulation dot1Q 10').error).toBeUndefined();
    expect(dev.running.render()).toContain(`interface ${SUB}\n encapsulation dot1Q 10`);
    const tokens = cli.help(id, '').items.map((i) => i.token);
    for (const t of ['encapsulation', 'ip', 'ipv6', 'shutdown', 'description', 'exit']) expect(tokens, t).toContain(t);
    expect(tokens).not.toContain('duplex');
    expect(cli.exec(id, 'exit').mode).toBe('config');
  });

  it('no interface <parent>.<n> removes the subinterface and its section; a physical interface keeps having no no form', () => {
    const devices = new Map<string, P05Device>();
    const cli = createCliRuntime({ device: (id) => devices.get(id), catalog: fakeCatalog, trace: new ArrayTrace(), now: () => 0, ...INERT_RF_VIEWS });
    const dev = new P05Device('d_r1', p2Model('router.nf2911'), 'R1');
    devices.set('d_r1', dev);
    const id = cli.open('d_r1', 'console');
    cli.exec(id, 'enable');
    cli.exec(id, 'configure terminal');
    expect(cli.exec(id, 'interface g0/0.20').mode).toBe('config-subif');
    expect(cli.exec(id, 'encapsulation dot1Q 20 native').error).toBeUndefined();
    expect(cli.exec(id, 'exit').mode).toBe('config');
    expect(dev.ports.has('GigabitEthernet0/0.20')).toBe(true);
    expect(dev.running.render()).toContain('interface GigabitEthernet0/0.20');
    const removed = cli.exec(id, 'no interface g0/0.20');
    expect(removed.error).toBeUndefined();
    expect(removed.mode).toBe('config');
    expect(dev.ports.has('GigabitEthernet0/0.20')).toBe(false);
    expect(dev.running.render()).not.toContain('GigabitEthernet0/0.20');
    // the long form too, and the physical parent still answers the no-form message
    cli.exec(id, 'interface GigabitEthernet0/0.30');
    cli.exec(id, 'exit');
    expect(cli.exec(id, 'no interface GigabitEthernet0/0.30').error).toBeUndefined();
    expect(dev.ports.has('GigabitEthernet0/0.30')).toBe(false);
    const physical = cli.exec(id, 'no interface g0/0');
    expect(physical.error).toBeDefined();
    expect(physical.output).toContain("no 'no' form");
    expect(dev.ports.has(GI0)).toBe(true);
    // at the parser: the subinterface spec takes the dotted names, the physical one keeps the rest
    const conf = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'no interface g0/0').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, conf, 'interface g0/0')).toMatchObject({ ok: true, spec: { entersMode: 'config-if' } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config', { ports: withSubif() }), 'no interface g0/0.10')).toMatchObject({ ok: true, negated: true, args: { iface: SUB } });
  });
});

describe('show ip route static', () => {
  it('keeps the legend and default line and lists static routes only', () => {
    const r = router({ mode: 'priv-exec' });
    r.ctx.tables.rib.set({ key: '10.0.0.0/24', network: '10.0.0.0', prefixLen: 24, source: 'C', iface: GI0, ad: 0, metric: 0, updatedAt: 0 });
    r.ctx.tables.rib.set({ key: '10.2.0.0/16', network: '10.2.0.0', prefixLen: 16, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    const out = (run(r, HANDLERS.showIpRoute, { source: 'S' }).output ?? '').split('\n');
    expect(out[0]).toBe(ROUTE_CODES_LEGEND);
    expect(out[2]).toBe('Default route: none configured');
    expect(out.slice(4)).toEqual(['S    10.2.0.0/16  via 10.0.0.2 [1/0]']);
    expect((run(r, HANDLERS.showIpRoute).output ?? '').split('\n').slice(4)).toHaveLength(2);
    r.ctx.tables.rib.delete('10.2.0.0/16');
    expect((run(r, HANDLERS.showIpRoute, { source: 'S' }).output ?? '').split('\n')[4]).toBe('The routing table holds no static route.');
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'user-exec'), 'show ip route static')).toMatchObject({ ok: true, args: { source: 'S' } });
  });
});
