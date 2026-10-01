// protocols/ospf/hello-check (ARCHITECTURE-P3 §3.1 step 2; RFC 2328 §8.2, §10.5; §7 W1 ospf): the checks a received
// hello must pass before a neighbour exists — area, mask and subnet (broadcast only), hello and dead intervals,
// authentication type, E bit, duplicate router id — in that order, each with its reason text; and the interface
// parameters a hello carries, read from the configuration (timers, network type, priority).
import { describe, expect, it } from 'vitest';
import {
  ospfIfacePriority,
  ospfIfaceTimers,
  ospfNetworkType,
  readOspfConfig,
} from '../src/protocols/ospf/config.js';
import { checkOspfHello, OSPF_OPTION_E, type OspfHelloIface, type OspfHelloSeen } from '../src/protocols/ospf/hello-check.js';
import type { ConfigNode } from '../src/contracts/config.js';

const lan: OspfHelloIface = {
  routerId: '1.1.1.1',
  area: '0.0.0.0',
  networkType: 'broadcast',
  address: '10.0.123.1',
  prefixLen: 24,
  helloS: 10,
  deadS: 40,
};
const good: OspfHelloSeen = {
  routerId: '2.2.2.2',
  area: '0.0.0.0',
  src: '10.0.123.2',
  mask: '255.255.255.0',
  helloS: 10,
  deadS: 40,
  options: OSPF_OPTION_E,
  authType: 0,
};

describe('ospf/hello-check: each refusal', () => {
  it('accepts a matching hello', () => {
    expect(checkOspfHello(lan, good)).toEqual({ ok: true });
    // options bits other than E do not matter
    expect(checkOspfHello(lan, { ...good, options: 0x12 })).toEqual({ ok: true });
  });

  it('area', () => {
    expect(checkOspfHello(lan, { ...good, area: '0.0.0.1' })).toEqual({ ok: false, reason: 'area', text: "area 0.0.0.1 does not match this interface's area 0.0.0.0" });
  });

  it('mask and subnet on broadcast networks', () => {
    expect(checkOspfHello(lan, { ...good, mask: '255.255.0.0' })).toEqual({ ok: false, reason: 'mask', text: "network mask /16 does not match this interface's /24" });
    expect(checkOspfHello(lan, { ...good, mask: '255.0.255.0' })).toMatchObject({ reason: 'mask', text: "network mask 255.0.255.0 does not match this interface's /24" });
    expect(checkOspfHello(lan, { ...good, src: '10.0.124.2' })).toEqual({ ok: false, reason: 'subnet', text: "source 10.0.124.2 is not on this interface's subnet" });
  });

  it('point-to-point networks skip the mask and subnet checks (RFC 2328 §10.5)', () => {
    const p2p: OspfHelloIface = { ...lan, networkType: 'point-to-point', address: '10.0.12.1', prefixLen: 30 };
    expect(checkOspfHello(p2p, { ...good, src: '10.0.12.2', mask: '255.255.255.0' })).toEqual({ ok: true });
    expect(checkOspfHello(p2p, { ...good, src: '192.168.9.9', mask: '0.0.0.0' })).toEqual({ ok: true });
  });

  it('hello and dead intervals', () => {
    expect(checkOspfHello(lan, { ...good, helloS: 5 })).toEqual({ ok: false, reason: 'hello', text: "hello interval 5 s does not match this interface's 10 s" });
    expect(checkOspfHello(lan, { ...good, deadS: 20 })).toEqual({ ok: false, reason: 'dead', text: "dead interval 20 s does not match this interface's 40 s" });
    expect(checkOspfHello({ ...lan, helloS: 5, deadS: 20 }, { ...good, helloS: 5, deadS: 20 })).toEqual({ ok: true });
  });

  it('authentication type', () => {
    expect(checkOspfHello(lan, { ...good, authType: 1 })).toEqual({ ok: false, reason: 'auth', text: "authentication type 1 does not match this interface's type 0" });
    expect(checkOspfHello({ ...lan, authType: 2 }, { ...good, authType: 2 })).toEqual({ ok: true });
  });

  it('E bit', () => {
    expect(checkOspfHello(lan, { ...good, options: 0 })).toEqual({ ok: false, reason: 'e-bit', text: 'external routing capability (E bit) clear, this interface has it set' });
    expect(checkOspfHello({ ...lan, options: 0 }, { ...good, options: OSPF_OPTION_E })).toEqual({ ok: false, reason: 'e-bit', text: 'external routing capability (E bit) set, this interface has it clear' });
  });

  it('a duplicate router id', () => {
    expect(checkOspfHello(lan, { ...good, routerId: '1.1.1.1' })).toEqual({ ok: false, reason: 'router-id', text: "the neighbour uses this router's own router ID 1.1.1.1" });
  });

  it('reports the first failing check in the documented order', () => {
    const everything: OspfHelloSeen = { routerId: '1.1.1.1', area: '0.0.0.9', src: '172.16.0.1', mask: '255.255.0.0', helloS: 1, deadS: 4, options: 0, authType: 1 };
    const order: string[] = [];
    let h = everything;
    const fixes: Partial<OspfHelloSeen>[] = [{ area: '0.0.0.0' }, { mask: '255.255.255.0' }, { src: '10.0.123.2' }, { helloS: 10 }, { deadS: 40 }, { authType: 0 }, { options: OSPF_OPTION_E }, { routerId: '2.2.2.2' }];
    for (const fix of fixes) {
      const r = checkOspfHello(lan, h);
      order.push(r.ok ? 'ok' : r.reason);
      h = { ...h, ...fix };
    }
    order.push(checkOspfHello(lan, h).ok ? 'ok' : 'refused');
    expect(order).toEqual(['area', 'mask', 'subnet', 'hello', 'dead', 'auth', 'e-bit', 'router-id', 'ok']);
  });
});

describe('ospf/hello-check: the interface parameters a hello carries (config)', () => {
  const n = (key: string, args: string[] = [], children: ConfigNode[] = []): ConfigNode => ({ key, args, children });

  it('hello 10 s and dead 40 s by default; without a dead line the dead interval is 4 × hello', () => {
    expect(ospfIfaceTimers(undefined)).toEqual({ helloS: 10, deadS: 40 });
    expect(ospfIfaceTimers({ helloS: 5 })).toEqual({ helloS: 5, deadS: 20 });
    expect(ospfIfaceTimers({ helloS: 5, deadS: 30 })).toEqual({ helloS: 5, deadS: 30 });
    expect(ospfIfaceTimers({ deadS: 60 })).toEqual({ helloS: 10, deadS: 60 });
  });

  it('reads the interface timers, priority and network type, in either storage form', () => {
    const root = n('', [], [
      n('interface', ['GigabitEthernet0/0'], [
        n('ip', ['address', '10.0.123.1', '255.255.255.0']),
        n('ip', ['ospf', 'hello-interval', '5']),
        n('ip', ['ospf', 'priority', '0']),
      ]),
      n('interface', ['GigabitEthernet0/1'], [
        n('ip', [], [n('ospf', ['dead-interval', '60']), n('ospf', ['network', 'point-to-point'])]),
      ]),
      n('interface', ['GigabitEthernet0/2'], [n('ip', ['ospf', 'hello-interval', '0']), n('ip', ['ospf', 'priority', '256']), n('ip', ['ospf', 'network', 'nbma'])]),
      n('interface', ['Loopback0'], [n('ip', ['address', '1.1.1.1', '255.255.255.255'])]),
    ]);
    const cfg = readOspfConfig({ root });
    expect(cfg.process).toBeUndefined();
    expect([...cfg.interfaces.keys()]).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1']);
    const g0 = cfg.interfaces.get('GigabitEthernet0/0');
    expect(g0).toEqual({ port: 'GigabitEthernet0/0', helloS: 5, priority: 0 });
    expect(ospfIfaceTimers(g0)).toEqual({ helloS: 5, deadS: 20 });
    expect(ospfIfacePriority(g0)).toBe(0);
    const g1 = cfg.interfaces.get('GigabitEthernet0/1');
    expect(g1).toEqual({ port: 'GigabitEthernet0/1', deadS: 60, networkType: 'point-to-point' });
    expect(ospfIfaceTimers(g1)).toEqual({ helloS: 10, deadS: 60 });
    expect(ospfIfacePriority(g1)).toBe(1);
    // out-of-range values are not read (Gi0/2 has no OSPF line left)
    expect(cfg.interfaces.has('GigabitEthernet0/2')).toBe(false);
  });

  it('the network type by role, and `ip ospf network` overriding it', () => {
    expect(['routed', 'subif', 'svi', 'wan', 'tunnel', 'virtual'].map((r) => ospfNetworkType(r as never))).toEqual(
      ['broadcast', 'broadcast', 'broadcast', 'point-to-point', 'point-to-point', 'loopback'],
    );
    expect(ospfNetworkType('routed', 'point-to-point')).toBe('point-to-point');
    expect(ospfNetworkType('wan', 'broadcast')).toBe('broadcast');
    expect(ospfNetworkType('virtual', 'point-to-point')).toBe('point-to-point');
    expect(ospfNetworkType('virtual', 'broadcast')).toBe('loopback');
  });
});
