/**
 * ip.acl-hooks — the ACL hooks of protocols/ipv4.ts (ARCHITECTURE-P3 D12, §2.4 `acl.filter` / `ipv4.resume.after` /
 * `nat.outbound.filterOut`, §3.0 (a) steps 2, 6 and 7; §7 W2 l3) against a FAKE acl daemon that answers exactly as the
 * contract says (`[onPermit]`, or a drop):
 *  • `ip access-group` per interface and direction, read from config deltas and at boot, one 'ip routing' line per
 *    changed binding, nothing in the StateView;
 *  • inbound: right after the checksum, BEFORE NAT inbound and the for-me test (traffic to the router is filtered too);
 *    the resumed packet (`after: 'acl-in'`) continues at the NAT inbound hook and is never filtered again;
 *  • outbound: after routing and the TTL decrement, `inPort` = the ingress port; with NAT inside → outside the packet goes
 *    to nat with `filterOut` instead (NAT before the output list); locally originated packets are never filtered;
 *  • without the acl daemon in the model, or without a line, every path is P2's.
 * The last case runs a real world (`test/staged.world.ts`, stage P3) with the fake acl as the `acl` factory.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';
import { createStagedSimulation } from './staged.world.js';
import { ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const MAC_SRV = '00:1f:00:00:00:02';
const MASK24 = '255.255.255.0';

type FilterReq = Extract<ProcessRequest, { kind: 'acl.filter' }>;

/** A fake acl daemon: records every request and answers by `verdict` (permit → [onPermit], deny → a drop). */
function fakeAcl(verdict: (req: FilterReq) => 'permit' | 'deny' = () => 'permit'): Process & { requests: FilterReq[] } {
  const requests: FilterReq[] = [];
  return {
    name: 'acl',
    requests,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onRequest(_ctx, req): Action[] {
      if (req.kind !== 'acl.filter') return [];
      requests.push(req);
      return verdict(req) === 'permit' ? [req.onPermit] : [{ type: 'drop', pdu: req.pdu, reason: 'acl-deny', detail: 'fake deny', port: req.iface }];
    },
    stateSnapshot: () => ({ process: 'acl', state: {} }),
    debugEvents: () => [],
  };
}

/** `p` answering every call with `ctx` (the fake's router hands routed actions its own ctx, whose model lacks `extra`). */
function bound(p: Process, ctx: ProcessCtx): Process {
  return {
    name: p.name,
    onPdu: (_c, pdu, port) => p.onPdu(ctx, pdu, port),
    onTimer: (_c, key) => p.onTimer(ctx, key),
    onConfig: (_c, delta) => p.onConfig(ctx, delta),
    onRequest: (_c, req) => p.onRequest!(ctx, req),
    stateSnapshot: () => p.stateSnapshot(),
    debugEvents: () => p.debugEvents(),
  };
}

/** A ctx whose model also runs `extra` (the fake's model is frozen; the prototype chain keeps its live getters). */
function withProcesses(ctx: ProcessCtx, extra: readonly ProcessName[]): ProcessCtx {
  const model = { ...ctx.model, processes: [...ctx.model.processes, ...extra] };
  return Object.create(ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
}

const accessGroup = (list: string, dir: 'in' | 'out'): readonly string[] => ['ip', 'access-group', list, dir];
const natLine = (side: 'inside' | 'outside'): readonly string[] => ['ip', 'nat', side];

interface Router {
  fake: Fake;
  ctx: ProcessCtx;
  ipv4: Process;
  acl: ReturnType<typeof fakeAcl>;
  arp: ReturnType<typeof makeSink>;
  nat: Process & { requests: ProcessRequest[] };
  icmp: ReturnType<typeof makeSink>;
  /** Store an interface line and hand the delta to ipv4. */
  iface(port: string, line: readonly string[], negate?: boolean): Action[];
}

/**
 * Router: GI0 10.0.0.1/24, GI1 203.0.113.1/24; the model runs `extra` (default: acl). nat is a fake that resumes an
 * inbound packet untranslated and, outbound, sends what nat would send (P2 seam) or what ipv4 asked for with filterOut.
 */
function router(opts: { extra?: readonly ProcessName[]; verdict?: (req: FilterReq) => 'permit' | 'deny' } = {}): Router {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
  const ctx = withProcesses(fake.ctx, opts.extra ?? ['acl']);
  const ipv4 = createIpv4();
  const acl = fakeAcl(opts.verdict);
  const arp = makeSink('arp');
  const icmp = makeSink('icmpv4');
  const natRequests: ProcessRequest[] = [];
  const nat: Process & { requests: ProcessRequest[] } = {
    name: 'nat',
    requests: natRequests,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onRequest(_ctx, req): Action[] {
      natRequests.push(req);
      if (req.kind === 'nat.inbound') return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu: req.pdu, inPort: req.inPort } }];
      if (req.kind === 'nat.outbound') {
        const via: Action = { type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu: req.pdu, nextHop: req.nextHop, iface: req.iface } };
        if (req.filterOut !== true) return [via];
        return [{ type: 'request', to: 'acl', req: { kind: 'acl.filter', family: 4, dir: 'out', iface: req.iface, inPort: req.inPort, natted: true, pdu: req.pdu, onPermit: via } }];
      }
      return [];
    },
    stateSnapshot: () => ({ process: 'nat', state: {} }),
    debugEvents: () => [],
  };
  for (const p of [bound(ipv4, ctx), acl, arp, icmp, nat]) fake.register(p);
  const iface = (port: string, line: readonly string[], negate = false): Action[] => {
    const delta: ConfigDelta | undefined = negate ? ctx.config.unset([['interface', port]], line) : ctx.config.set([['interface', port]], line);
    return delta === undefined ? [] : fake.run(ipv4.onConfig(ctx, delta));
  };
  iface(GI0, ['ip', 'address', '10.0.0.1', MASK24]);
  iface(GI1, ['ip', 'address', '203.0.113.1', MASK24]);
  arp.requests.length = 0;
  return { fake, ctx, ipv4, acl, arp, nat, icmp, iface };
}

/** A packet from 10.0.0.10 (behind GI0) to `dst`, arriving on GI0. */
function fromInside(r: Router, dst: string, seq = 1): Pdu {
  return r.fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', dst, 1, seq, 128)));
}

/** A packet from 203.0.113.10 (behind GI1) to `dst`, arriving on GI1. */
function fromOutside(r: Router, dst: string, seq = 1): Pdu {
  return r.fake.build(framed(MAC_R1, MAC_SRV, echoRequest('203.0.113.10', dst, 7, seq, 64)));
}

const routingLines = (f: Fake): string[] => f.debug.filter((d) => d.category === 'ip routing').map((d) => d.message);

describe('ip.acl-hooks: the bindings (D12)', () => {
  it('reads ip access-group per direction from config deltas; one ip routing line per change; the StateView is unchanged', () => {
    const r = router();
    const before = routingLines(r.fake).length;
    expect(r.iface(GI0, accessGroup('101', 'in'))).toEqual([]);
    expect(r.fake.debug.at(-1)).toMatchObject({ category: 'ip routing', message: `interface ${GI0} filters inbound packets with access list 101`, data: { port: GI0, dir: 'in', list: '101' } });
    r.iface(GI1, accessGroup('OUT-LIST', 'out'));
    expect(r.fake.debug.at(-1)!.message).toBe(`interface ${GI1} filters outbound packets with access list OUT-LIST`);
    // a numbered list is known by its plain decimal number
    r.iface(GI0, accessGroup('010', 'out'));
    expect(r.fake.debug.at(-1)!.message).toBe(`interface ${GI0} filters outbound packets with access list 10`);
    expect(routingLines(r.fake).length - before).toBe(3);
    r.iface(GI1, accessGroup('OUT-LIST', 'out'), true);
    expect(r.fake.debug.at(-1)!.message).toBe(`interface ${GI1} no longer filters outbound packets (access list OUT-LIST)`);
    // an unrelated interface line adds no routing line about access lists
    const n = routingLines(r.fake).length;
    r.iface(GI1, ['description', 'uplink']);
    expect(routingLines(r.fake)).toHaveLength(n);
    // the StateView keeps its P2 keys: the bindings are internal state (§9.1)
    expect(Object.keys(r.ipv4.stateSnapshot().state as object)).toEqual(['forwarding', 'interfaces', 'staticRoutes', 'forwarded', 'delivered', 'sent', 'dropped']);
  });

  it('boot replay picks the bindings up from the running config', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
    fake.ctx.config.set([['interface', GI0]], ['ip', 'address', '10.0.0.1', MASK24]);
    fake.ctx.config.set([['interface', GI0]], ['ip', 'access-group', 'BLOCK', 'in']);
    fake.ctx.config.set([['interface', GI1]], ['ip', 'address', '203.0.113.1', MASK24]);
    const ctx = withProcesses(fake.ctx, ['acl']);
    const ipv4 = createIpv4();
    const acl = fakeAcl();
    fake.register(ipv4);
    fake.register(acl);
    fake.register(makeSink('arp'));
    fake.run(ipv4.init!(ctx));
    expect(fake.debug.some((d) => d.message === `interface ${GI0} filters inbound packets with access list BLOCK`)).toBe(true);
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', '203.0.113.10', 1, 1, 128)));
    fake.run(ipv4.onPdu(ctx, pdu, GI0));
    expect(acl.requests).toHaveLength(1);
    expect(acl.requests[0]).toMatchObject({ kind: 'acl.filter', dir: 'in', iface: GI0 });
  });
});

describe('ip.acl-hooks: inbound (§3.0 (a) step 2)', () => {
  it('hands the packet to acl right after the checksum; the resume (after acl-in) forwards it and is never filtered again', () => {
    const r = router();
    r.iface(GI0, accessGroup('101', 'in'));
    const pdu = fromInside(r, '203.0.113.10');
    const first = r.ipv4.onPdu(r.ctx, pdu, GI0);
    expect(first).toEqual([
      {
        type: 'request', to: 'acl',
        req: { kind: 'acl.filter', family: 4, dir: 'in', iface: GI0, pdu, onPermit: { type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: GI0, after: 'acl-in' } } },
      },
    ]);
    // nothing happened to the packet yet: no TTL decrement, no arp
    expect(pdu.get('ipv4.ttl')).toBe(128);
    expect(r.arp.requests).toEqual([]);
    expect(r.fake.debug.at(-1)!.message).toBe(`filtering 10.0.0.10 > 203.0.113.10 ttl 128 proto 1 on ${GI0} (ip access-group 101 in)`);
    r.fake.run(first);
    // the fake acl permitted: the resume continued at the for-me test and forwarded the packet exactly once
    expect(r.acl.requests).toHaveLength(1);
    expect(r.arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '203.0.113.10', iface: GI1, cause: `connected via ${GI1}` }]);
    expect(pdu.get('ipv4.ttl')).toBe(127);
    expect(r.fake.debug.some((d) => d.message === `resume 10.0.0.10 > 203.0.113.10 ttl 128 proto 1 on ${GI0} after the inbound access list`)).toBe(true);
    expect(r.ipv4.stateSnapshot().state).toMatchObject({ forwarded: 1 });
  });

  it('filters traffic to the router itself, and a denied packet is neither delivered nor forwarded', () => {
    const r = router({ verdict: (req) => (String(req.pdu.get('ipv4.dst')) === '10.0.0.1' ? 'permit' : 'deny') });
    r.iface(GI0, accessGroup('101', 'in'));
    const own = fromInside(r, '10.0.0.1');
    r.fake.run(r.ipv4.onPdu(r.ctx, own, GI0));
    expect(r.acl.requests.map((q) => q.pdu)).toEqual([own]);
    expect(r.icmp.pdus).toEqual([own]);
    const denied = fromInside(r, '203.0.113.10', 2);
    const actions = r.fake.run(r.ipv4.onPdu(r.ctx, denied, GI0));
    expect(actions).toHaveLength(1);
    expect(r.fake.actionsOf('drop')).toEqual([{ type: 'drop', pdu: denied, reason: 'acl-deny', detail: 'fake deny', port: GI0 }]);
    expect(r.arp.requests).toEqual([]);
    expect(r.icmp.pdus).toEqual([own]);
    expect(denied.get('ipv4.ttl')).toBe(128);
  });

  it('a port without an inbound list, and an outbound-only binding, leave the inbound path as P2', () => {
    const r = router();
    r.iface(GI1, accessGroup('101', 'out'));
    const pdu = fromInside(r, '10.0.0.20');
    r.fake.run(r.ipv4.onPdu(r.ctx, pdu, GI0));
    expect(r.acl.requests).toEqual([]);
    expect(r.arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '10.0.0.20', iface: GI0, cause: `connected via ${GI0}` }]);
  });

  it('order against NAT: on an outside port the inbound list runs first, then nat.inbound, then the for-me test', () => {
    const r = router({ extra: ['nat', 'acl'] });
    r.iface(GI0, natLine('inside'));
    r.iface(GI1, natLine('outside'));
    r.iface(GI1, accessGroup('OUTSIDE-IN', 'in'));
    const pdu = fromOutside(r, '203.0.113.1');
    const first = r.ipv4.onPdu(r.ctx, pdu, GI1);
    expect(first).toEqual([
      {
        type: 'request', to: 'acl',
        req: { kind: 'acl.filter', family: 4, dir: 'in', iface: GI1, pdu, onPermit: { type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: GI1, after: 'acl-in' } } },
      },
    ]);
    expect(r.nat.requests).toEqual([]);
    // the resume goes to nat's inbound hook (it sees what the list let through), and nat's own resume reaches the for-me test
    const resumed = r.ipv4.onRequest!(r.ctx, { kind: 'ipv4.resume', pdu, inPort: GI1, after: 'acl-in' });
    expect(resumed).toEqual([{ type: 'request', to: 'nat', req: { kind: 'nat.inbound', pdu, inPort: GI1 } }]);
    r.fake.run(resumed);
    expect(r.nat.requests).toEqual([{ kind: 'nat.inbound', pdu, inPort: GI1 }]);
    expect(r.icmp.pdus).toEqual([pdu]);
    expect(r.acl.requests).toEqual([]);
    // a packet the list denies never reaches nat (no NAT row can be allocated for it)
    const r2 = router({ extra: ['nat', 'acl'], verdict: () => 'deny' });
    r2.iface(GI0, natLine('inside'));
    r2.iface(GI1, natLine('outside'));
    r2.iface(GI1, accessGroup('OUTSIDE-IN', 'in'));
    r2.fake.run(r2.ipv4.onPdu(r2.ctx, fromOutside(r2, '203.0.113.1'), GI1));
    expect(r2.acl.requests).toHaveLength(1);
    expect(r2.nat.requests).toEqual([]);
  });
});

describe('ip.acl-hooks: outbound (§3.0 (a) steps 6 and 7)', () => {
  it('a forwarded packet goes to acl after the TTL decrement, with inPort = the ingress port and arp.sendVia as onPermit', () => {
    const r = router();
    r.iface(GI1, accessGroup('120', 'out'));
    const pdu = fromInside(r, '203.0.113.10');
    const actions = r.ipv4.onPdu(r.ctx, pdu, GI0);
    expect(actions).toEqual([
      {
        type: 'request', to: 'acl',
        req: {
          kind: 'acl.filter', family: 4, dir: 'out', iface: GI1, inPort: GI0, pdu,
          onPermit: { type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: '203.0.113.10', iface: GI1, cause: `connected via ${GI1}` } },
        },
      },
    ]);
    expect(pdu.get('ipv4.ttl')).toBe(127);
    expect(pdu.provenance.map((m) => m.reason)).toEqual(['TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    expect(r.fake.debug.at(-1)!.message).toBe(`filtering 10.0.0.10 > 203.0.113.10 ttl 127 proto 1 on the way out ${GI1} (ip access-group 120 out)`);
    expect(r.arp.requests).toEqual([]);
    r.fake.run(actions);
    expect(r.arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '203.0.113.10', iface: GI1, cause: `connected via ${GI1}` }]);
    // the reverse direction has no outbound list on GI0
    const back = fromOutside(r, '10.0.0.10');
    r.fake.run(r.ipv4.onPdu(r.ctx, back, GI1));
    expect(r.acl.requests).toHaveLength(1);
    expect(r.arp.requests.at(-1)).toEqual({ kind: 'arp.sendVia', pdu: back, nextHop: '10.0.0.10', iface: GI0, cause: `connected via ${GI0}` });
  });

  it('an outbound deny sends nothing to arp', () => {
    const r = router({ verdict: () => 'deny' });
    r.iface(GI1, accessGroup('120', 'out'));
    const pdu = fromInside(r, '203.0.113.10');
    r.fake.run(r.ipv4.onPdu(r.ctx, pdu, GI0));
    expect(r.arp.requests).toEqual([]);
    expect(r.fake.actionsOf('drop')).toEqual([{ type: 'drop', pdu, reason: 'acl-deny', detail: 'fake deny', port: GI1 }]);
  });

  it('locally originated packets are never filtered outbound (ipv4.send, with or without an egress interface)', () => {
    const r = router();
    r.iface(GI1, accessGroup('120', 'out'));
    r.iface(GI1, accessGroup('121', 'in'));
    const routed = r.ctx.newPdu(echoRequest('203.0.113.1', '203.0.113.10', 9, 1, 255));
    r.fake.run(r.ipv4.onRequest!(r.ctx, { kind: 'ipv4.send', pdu: routed }));
    const forced = r.ctx.newPdu(echoRequest('203.0.113.1', '203.0.113.10', 9, 2, 255));
    r.fake.run(r.ipv4.onRequest!(r.ctx, { kind: 'ipv4.send', pdu: forced, iface: GI1 }));
    expect(r.acl.requests).toEqual([]);
    expect(r.arp.requests.map((q) => (q as Extract<ProcessRequest, { kind: 'arp.sendVia' }>).pdu)).toEqual([routed, forced]);
  });

  it('NAT inside → outside: the packet goes to nat with filterOut (NAT before the output list), never straight to acl', () => {
    const r = router({ extra: ['nat', 'acl'] });
    r.iface(GI0, natLine('inside'));
    r.iface(GI1, natLine('outside'));
    // without an outbound list: P2's nat.outbound exactly (no filterOut member)
    const p2 = fromInside(r, '203.0.113.10');
    const plain = r.ipv4.onPdu(r.ctx, p2, GI0);
    expect(plain).toEqual([{ type: 'request', to: 'nat', req: { kind: 'nat.outbound', pdu: p2, inPort: GI0, iface: GI1, nextHop: '203.0.113.10', cause: `connected via ${GI1}` } }]);
    const req = (plain[0] as Extract<Action, { type: 'request' }>).req;
    expect(Object.keys(req)).toEqual(['kind', 'pdu', 'inPort', 'iface', 'nextHop', 'cause']);
    // with one: filterOut, and acl is asked by nat (natted), not by ipv4
    r.iface(GI1, accessGroup('OUTSIDE-OUT', 'out'));
    const pdu = fromInside(r, '203.0.113.10', 2);
    const actions = r.ipv4.onPdu(r.ctx, pdu, GI0);
    expect(actions).toEqual([
      { type: 'request', to: 'nat', req: { kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: '203.0.113.10', cause: `connected via ${GI1}`, filterOut: true } },
    ]);
    r.fake.run(actions);
    expect(r.acl.requests).toHaveLength(1);
    expect(r.acl.requests[0]).toMatchObject({ dir: 'out', iface: GI1, inPort: GI0, natted: true });
    // inside → inside keeps the P1 path; a NAT outside → inside packet resumed and forwarded meets GI0's outbound list
    r.iface(GI0, accessGroup('INSIDE-OUT', 'out'));
    const inbound = fromOutside(r, '10.0.0.10', 3);
    r.fake.run(r.ipv4.onPdu(r.ctx, inbound, GI1));
    expect(r.nat.requests.at(-1)).toEqual({ kind: 'nat.inbound', pdu: inbound, inPort: GI1 });
    expect(r.acl.requests.at(-1)).toMatchObject({ kind: 'acl.filter', dir: 'out', iface: GI0, inPort: GI1, pdu: inbound });
    expect(r.acl.requests.at(-1)).not.toHaveProperty('natted');
  });

  it('without the acl daemon in the model the lines are stored but every path is P2: no request ever reaches acl', () => {
    const r = router({ extra: [] });
    r.iface(GI0, accessGroup('101', 'in'));
    r.iface(GI1, accessGroup('120', 'out'));
    const pdu = fromInside(r, '203.0.113.10');
    r.fake.run(r.ipv4.onPdu(r.ctx, pdu, GI0));
    expect(r.acl.requests).toEqual([]);
    expect(r.arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '203.0.113.10', iface: GI1, cause: `connected via ${GI1}` }]);
  });
});

describe('ip.acl-hooks: a real world (staged.world, stage P3) with a fake acl factory', () => {
  it('an inbound deny on R1 drops PC1 echo requests acl-deny at R1 Gi0/0 (counted aclDenies); PC2 is permitted', () => {
    const fakes: ReturnType<typeof fakeAcl>[] = [];
    const sim = createStagedSimulation({
      seed: 31,
      stage: 'P3',
      factories: {
        acl: () => {
          const f = fakeAcl((req) => (String(req.pdu.get('ipv4.src')) === '192.168.1.10' ? 'deny' : 'permit'));
          fakes.push(f);
          return f;
        },
      },
    });
    const host = (name: string, address: string): string =>
      [`hostname ${name}`, '!', 'interface GigabitEthernet0', ` ip address ${address} 255.255.255.0`, '!', 'ip default-gateway 192.168.1.1', '!', 'end', ''].join('\n');
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: host('PC1', '192.168.1.10') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: host('PC2', '192.168.1.11') });
    sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: [
      'hostname SRV', '!', 'interface GigabitEthernet0', ' ip address 192.168.2.100 255.255.255.0', '!', 'ip default-gateway 192.168.2.1', '!', 'end', '',
    ].join('\n') });
    sim.addDevice({ id: 'sw', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: [
        'hostname R1', '!',
        `interface ${GI0}`, ' ip address 192.168.1.1 255.255.255.0', ' ip access-group 1 in', ' no shutdown', '!',
        `interface ${GI1}`, ' ip address 192.168.2.1 255.255.255.0', ' no shutdown', '!',
        'end', '',
      ].join('\n'),
    });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw', port: 'FastEthernet0/1' } });
    sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw', port: 'FastEthernet0/2' } });
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'sw', port: 'GigabitEthernet0/1' } });
    sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
    sim.runFor(120 * SEC);
    expect(sim.device('r1')!.model.processes).toContain('acl');

    const cursor = sim.trace(0).next;
    const s1 = sim.cli.open('pc1', 'console');
    sim.cli.exec(s1, 'ping 192.168.2.100');
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const denies = ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'acl-deny');
    expect(denies.length).toBe(PING_COUNT);
    expect(denies.every((d) => d.port === GI0)).toBe(true);
    expect(output(evs, s1)).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(sim.device('r1')!.port(GI0)!.counters.aclDenies).toBe(PING_COUNT);
    expect(sim.device('r1')!.port(GI1)!.counters).not.toHaveProperty('aclDenies');

    const c2 = sim.trace(0).next;
    const s2 = sim.cli.open('pc2', 'console');
    sim.cli.exec(s2, 'ping 192.168.2.100');
    sim.runToIdle();
    const evs2 = sim.trace(c2).events;
    expect(output(evs2, s2)).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}`);
    expect(ofKind(evs2, 'drop').filter((d) => d.reason === 'acl-deny')).toEqual([]);
    // only R1 asked acl (the PCs and the switch bind no list); every request named Gi0/0 inbound
    const asked = fakes.flatMap((f) => f.requests);
    expect(asked).toHaveLength(2 * PING_COUNT);
    expect(asked.every((q) => q.iface === GI0 && q.dir === 'in')).toBe(true);
  });
});
