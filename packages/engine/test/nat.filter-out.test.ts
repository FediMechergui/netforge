/**
 * nat.filter-out — nat's `filterOut` path (ARCHITECTURE-P3 D12, §2.4 `nat.outbound.filterOut` / `acl.filter`, §3.0 (a)
 * step 6, §3.3 step 7; §7 W2 nat), against a FAKE acl:
 *  • with `filterOut`, nat translates exactly as before (allocating its row) and then hands the translated packet to
 *    acl as `acl.filter {family 4, dir 'out', iface, inPort, natted: true, pdu, onPermit}`, where `onPermit` is the
 *    `arp.sendVia` request it would have sent; a packet no rule translates goes without `natted`;
 *  • the NAT row exists after an outbound deny (and ages out as usual), and no ICMP comes from nat;
 *  • a `nat-exhausted` drop never reaches acl;
 *  • without `filterOut`, every path answers exactly as P2 (the same `arp.sendVia` objects, no acl request).
 * The fake router is `test/nat.harness.ts` (real ipv4 and nat, real tables and PDU factory); the ipv4 → nat → acl chain
 * is driven with a ctx whose model also runs `acl`.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { natKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { NAT_SWEEP_TIMER } from '../src/protocols/nat.js';
import { ACL_LINE, GI0, GI1, MAC_PC1, MAC_R0, PAT_RULE, PC1, R1_OUT, SRV, STATIC_GLOBAL, STATIC_LINE, echo, icmpError, natFake, tcp, udp } from './nat.harness.js';
import { framed } from './ip.fake-ctx.js';

type FilterReq = Extract<ProcessRequest, { kind: 'acl.filter' }>;
type SendVia = Extract<ProcessRequest, { kind: 'arp.sendVia' }>;

const CAUSE = `connected via ${GI1}`;

/** R1 with NAT inside on Gi0/0, outside on Gi0/1, and the given global lines. */
function router(lines: readonly string[]) {
  const h = natFake();
  h.iface(GI0, 'ip nat inside');
  h.iface(GI1, 'ip nat outside');
  for (const l of lines) h.global(l);
  return h;
}

/** A packet from the inside as ipv4 hands it to nat (framed as it arrived on Gi0/0, TTL already decremented). */
function inside(h: ReturnType<typeof natFake>, packet: Parameters<typeof framed>[2]): Pdu {
  return h.fake.build(framed(MAC_R0, MAC_PC1, packet));
}

/** `nat.outbound` as ipv4 sends it for `pdu` to SRV out Gi0/1, with or without `filterOut`. */
function outboundReq(pdu: Pdu, filterOut: boolean): Extract<ProcessRequest, { kind: 'nat.outbound' }> {
  return filterOut
    ? { kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: SRV, cause: CAUSE, filterOut: true }
    : { kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: SRV, cause: CAUSE };
}

/** The acl.filter requests nat left for a (missing) acl daemon. */
function filters(actions: readonly Action[]): FilterReq[] {
  return actions.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request' && a.to === 'acl').map((a) => a.req as FilterReq);
}

const viaFor = (pdu: Pdu): Action => ({ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: SRV, iface: GI1, cause: CAUSE } });

describe('nat.filter-out: nat hands the translated packet to acl (D12)', () => {
  it('PAT: the row is allocated, the source translated, then acl.filter {out, natted} with the arp.sendVia as onPermit', () => {
    const h = router([ACL_LINE, PAT_RULE]);
    const pdu = inside(h, echo(PC1, SRV, 1, 1, 127));
    const actions = h.request(outboundReq(pdu, true));
    expect(filters(actions)).toEqual([{ kind: 'acl.filter', family: 4, dir: 'out', iface: GI1, inPort: GI0, natted: true, pdu, onPermit: viaFor(pdu) }]);
    // translated before acl sees it: the list matches the global source (§3.3 step 7)
    expect(pdu.get('ipv4.src')).toBe(R1_OUT);
    expect(h.rows().map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    // nothing went to arp: only acl's permit sends it
    expect(h.arp.requests).toEqual([]);
    // the request nat would have sent without filterOut is exactly the continuation
    const p2 = router([ACL_LINE, PAT_RULE]);
    const twin = inside(p2, echo(PC1, SRV, 1, 1, 127));
    p2.request(outboundReq(twin, false));
    expect(p2.arp.requests).toEqual([(viaFor(twin) as Extract<Action, { type: 'request' }>).req]);
    expect(filters(p2.actions)).toEqual([]);
  });

  it('every translating branch sets natted (static, port forward, existing overload row); an untranslated packet does not', () => {
    const h = router([STATIC_LINE, 'ip nat inside source static tcp 192.168.1.11 8080 203.0.113.6 80', ACL_LINE, PAT_RULE]);
    const st = inside(h, udp(PC1, 5000, SRV, 53, 127));
    expect(filters(h.request(outboundReq(st, true)))[0]).toMatchObject({ natted: true });
    expect(st.get('ipv4.src')).toBe(STATIC_GLOBAL);
    const pf = inside(h, tcp('192.168.1.11', 8080, SRV, 40000, 'SA', 127));
    expect(filters(h.request(outboundReq(pf, true)))[0]).toMatchObject({ natted: true });
    expect(pf.get('ipv4.src')).toBe('203.0.113.6');
    // the second packet of a PAT flow reuses its row
    const first = inside(h, echo('192.168.1.12', SRV, 9, 1, 127));
    h.request(outboundReq(first, true));
    const again = inside(h, echo('192.168.1.12', SRV, 9, 2, 127));
    expect(filters(h.request(outboundReq(again, true)))[0]).toMatchObject({ natted: true, pdu: again });
    // a source no rule covers (the list permits 192.168.1.0/24 only) keeps its real address: no natted flag
    const stray = inside(h, echo('10.9.9.9', SRV, 3, 1, 127));
    const [req] = filters(h.request(outboundReq(stray, true)));
    expect(req).toEqual({ kind: 'acl.filter', family: 4, dir: 'out', iface: GI1, inPort: GI0, pdu: stray, onPermit: viaFor(stray) });
    expect(stray.get('ipv4.src')).toBe('10.9.9.9');
  });

  it('an [S9] ICMP error translated outbound is natted too', () => {
    const h = router([STATIC_LINE]);
    // SRV's packet to the static global came in and was translated to PC1; PC1 answers with a port unreachable
    const original = udp(SRV, 40000, PC1, 9999, 63);
    const err = inside(h, icmpError(PC1, SRV, original, 3, 3, 127));
    const [req] = filters(h.request(outboundReq(err, true)));
    expect(req).toMatchObject({ dir: 'out', natted: true, pdu: err });
    expect(err.get('ipv4.src')).toBe(STATIC_GLOBAL);
  });

  it('the row exists after an outbound deny; it ages out like any row; nat sends no ICMP', () => {
    const h = router([ACL_LINE, PAT_RULE]);
    const t0 = h.ctx.now;
    const pdu = inside(h, udp(PC1, 5000, SRV, 53, 127));
    const actions = h.request(outboundReq(pdu, true));
    // the fake acl denies: onPermit is never applied
    expect(filters(actions)).toHaveLength(1);
    expect(h.arp.requests).toEqual([]);
    expect(h.rows()).toEqual([expect.objectContaining({ key: natKey('udp', R1_OUT, 5000), insideLocal: PC1, kind: 'overload', expiresAt: t0 + 300 * SEC })]);
    expect(h.icmp.requests).toEqual([]);
    expect(actions.some((a) => a.type === 'timer' && a.key === NAT_SWEEP_TIMER)).toBe(true);
    h.setNow(t0 + 301 * SEC);
    h.timer(NAT_SWEEP_TIMER);
    expect(h.rows()).toEqual([]);
  });

  it('a nat-exhausted drop never reaches acl', () => {
    const h = router([ACL_LINE, 'ip nat pool P 203.0.113.20 203.0.113.20 netmask 255.255.255.0', 'ip nat inside source list 1 pool P']);
    h.request(outboundReq(inside(h, echo(PC1, SRV, 1, 1, 127)), true));
    const second = inside(h, echo('192.168.1.11', SRV, 2, 1, 127));
    const actions = h.request(outboundReq(second, true));
    expect(actions).toEqual([{ type: 'drop', pdu: second, reason: 'nat-exhausted', detail: 'pool P has no free address', port: GI0 }]);
    expect(filters(h.all)).toHaveLength(1);
  });
});

describe('nat.filter-out: ipv4 → nat → acl (a ctx whose model runs acl)', () => {
  it('ipv4 asks nat with filterOut; the deny leaves the row; a permit sends the packet with one PduId', () => {
    const h = router([ACL_LINE, PAT_RULE]);
    h.iface(GI1, `ip access-group 199 out`);
    const model = { ...h.ctx.model, processes: [...h.ctx.model.processes, 'acl' as ProcessName] };
    const ctx = Object.create(h.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
    let verdict: 'permit' | 'deny' = 'deny';
    const seen: FilterReq[] = [];
    const run = (actions: readonly Action[]): void => {
      for (const a of actions) {
        if (a.type !== 'request') continue;
        if (a.to === 'nat') run(h.nat.onRequest!(ctx, a.req));
        else if (a.to === 'arp') run(h.arp.onRequest!(ctx, a.req));
        else if (a.to === 'acl' && a.req.kind === 'acl.filter') {
          seen.push(a.req);
          if (verdict === 'permit') run([a.req.onPermit]);
        }
      }
    };
    const pdu = h.fake.build(framed(MAC_R0, MAC_PC1, echo(PC1, SRV, 1, 1, 128)));
    const first = h.ipv4.onPdu(ctx, pdu, GI0);
    expect(first).toEqual([{ type: 'request', to: 'nat', req: { kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: SRV, cause: CAUSE, filterOut: true } }]);
    run(first);
    expect(seen).toEqual([{ kind: 'acl.filter', family: 4, dir: 'out', iface: GI1, inPort: GI0, natted: true, pdu, onPermit: viaFor(pdu) }]);
    expect(h.rows().map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    expect(h.arp.requests).toEqual([]);
    verdict = 'permit';
    const next = h.fake.build(framed(MAC_R0, MAC_PC1, echo(PC1, SRV, 1, 2, 128)));
    run(h.ipv4.onPdu(ctx, next, GI0));
    expect(h.arp.requests).toEqual([(viaFor(next) as Extract<Action, { type: 'request' }>).req as SendVia]);
    expect(next.get('ipv4.src')).toBe(R1_OUT);
    expect(next.get('ipv4.ttl')).toBe(127);
  });
});

describe('nat.filter-out: without filterOut, P2 bytes', () => {
  it('every outbound branch answers with exactly the P2 arp.sendVia request (same object shape and key order) and nothing for acl', () => {
    const h = router([STATIC_LINE, ACL_LINE, PAT_RULE]);
    const packets = [
      inside(h, udp(PC1, 5000, SRV, 53, 127)), // static
      inside(h, echo('192.168.1.11', SRV, 4, 1, 127)), // PAT, new row
      inside(h, echo('192.168.1.11', SRV, 4, 2, 127)), // PAT, existing row
      inside(h, echo('10.9.9.9', SRV, 5, 1, 127)), // untranslated
    ];
    for (const pdu of packets) {
      const actions = h.request(outboundReq(pdu, false));
      const sends = actions.filter((a) => a.type === 'request' && a.to === 'arp');
      expect(sends).toEqual([viaFor(pdu)]);
      expect(Object.keys((sends[0] as Extract<Action, { type: 'request' }>).req)).toEqual(['kind', 'pdu', 'nextHop', 'iface', 'cause']);
    }
    expect(filters(h.all)).toEqual([]);
    expect(h.all.some((a) => a.type === 'request' && a.to === 'acl')).toBe(false);
    // the debug lines of the ip nat category are the P2 ones (no line mentions an access list)
    expect(h.natDebug().some((m) => m.includes('access'))).toBe(false);
  });

  it('ipv4 without the acl daemon never sets filterOut, whatever lines are stored', () => {
    const h = router([ACL_LINE, PAT_RULE]);
    h.iface(GI1, 'ip access-group 199 out');
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 1));
    const req = h.all.find((a) => a.type === 'request' && a.to === 'nat') as Extract<Action, { type: 'request' }>;
    expect(req.req).toEqual({ kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: SRV, cause: CAUSE });
    expect(h.arp.requests).toEqual([(viaFor(pdu) as Extract<Action, { type: 'request' }>).req]);
  });
});
