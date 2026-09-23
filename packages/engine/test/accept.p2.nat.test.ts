/**
 * P2 acceptance — NAT (ARCHITECTURE-P2 §10.1 `accept.p2.nat`; D14, §3.9, §4.2, §5.2, §5.4, §7 W4 qa).
 *
 * Real worlds built with `createP2Simulation` (§0 rule 13) in the P2 profile, with every approved W1–W3 daemon
 * factory laid over the registry — what the real catalog holds once the W4 flip has landed. The §3.9 setup:
 * PC1 192.168.1.10 and PC2 192.168.1.11 — SW1 (an NF-C2960 running PVST+) — R1 Gi0/0 192.168.1.1 (`ip nat inside`),
 * R1 Gi0/1 203.0.113.1/24 (`ip nat outside`) — SRV 203.0.113.10.
 *   • static: SRV sees source 203.0.113.5; the provenance has `NatTranslate ipv4.src` with the rule as cause;
 *   • dynamic: the first host gets .20; with the pool full the next drops `nat-exhausted`;
 *   • PAT: PC1 and PC2 ping SRV at the same time with ICMP id 1 → two overload rows with inside-global ids 1 and 2,
 *     SRV sees (203.0.113.1, 1) and (203.0.113.1, 2), both 5/5, every received ipv4/icmpv4 checksum valid — and the
 *     observed §3.9 step 2 mutation sequence of the moved host is pinned;
 *   • inbound match: while PC1's row icmp|203.0.113.1|1 is alive SRV pings 203.0.113.1 with id 1 — R1 itself answers
 *     and no packet reaches PC1;
 *   • `clear ip nat translation *` removes dynamic rows only; idle ICMP rows expire after 60 s.
 */
import { describe, expect, it } from 'vitest';
import type { Ipv4Address } from '../src/contracts/addr.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { natKey, type NatRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createHsrp } from '../src/protocols/hsrp.js';
import { createNat } from '../src/protocols/nat.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { console as cliConsole, ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const PC = 'GigabitEthernet0';
const MASK24 = '255.255.255.0';
/** Switch boot (30 s), router boot, and the 30 s PVST+ forward delay of every host port. */
const BOOT = 100 * SEC;

/** §3.9 addresses. */
const PC1 = '192.168.1.10';
const PC2 = '192.168.1.11';
const PC3 = '192.168.1.12';
const R1_IN = '192.168.1.1';
const R1_OUT = '203.0.113.1';
const SRV = '203.0.113.10';
const STATIC_GLOBAL = '203.0.113.5';

const STATIC_LINE = `ip nat inside source static ${PC1} ${STATIC_GLOBAL}`;
const ACL_LINE = 'access-list 1 permit 192.168.1.0 0.0.0.255';
const POOL_TWO = 'ip nat pool P 203.0.113.20 203.0.113.21 netmask 255.255.255.0';
const POOL_RULE = 'ip nat inside source list 1 pool P';
const PAT_RULE = `ip nat inside source list 1 interface ${GI1} overload`;

/** Every approved W1–W3 daemon with its real factory (the W4 flip registers exactly these; capwap-* arrive in W5). */
function p2Daemons(): P2FactoryOverlay {
  const out: Record<string, ProcessFactory> = {
    vlan: createVlan,
    dtp: createDtp,
    etherchannel: createEtherchannel,
    stp: createStp,
    nat: createNat,
    hsrp: createHsrp,
    'dhcpv6-client': createDhcpv6Client,
    'dhcpv6-server': createDhcpv6Server,
  };
  return out;
}

interface Inside {
  readonly id: string;
  readonly name: string;
  readonly address: Ipv4Address;
}
const PC1_HOST: Inside = { id: 'pc1', name: 'PC1', address: PC1 };
const PC2_HOST: Inside = { id: 'pc2', name: 'PC2', address: PC2 };
const PC3_HOST: Inside = { id: 'pc3', name: 'PC3', address: PC3 };

interface WorldOptions {
  readonly seed?: number;
  /** R1 global lines (rules, ACLs, pools). */
  readonly r1: readonly string[];
  /** Inside hosts on R1 Gi0/0 (one: a direct cable; several: through SW1). Default PC1 and PC2. */
  readonly inside?: readonly Inside[];
}

/**
 * Inside hosts — [SW1] — R1 (Gi0/0 inside, Gi0/1 outside, the given lines) — SRV. In the P2 profile SW1 runs PVST+ and
 * its host ports forward 30 s after link-up; `BOOT` covers that.
 */
function natWorld(o: WorldOptions): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 5, factories: p2Daemons() });
  const inside = o.inside ?? [PC1_HOST, PC2_HOST];
  for (const h of inside) sim.addDevice({ id: h.id, type: 'pc.nfpc', name: h.name, startupConfig: pcConfig(h.name, h.address, MASK24, R1_IN) });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: pcConfig('SRV', SRV, MASK24, R1_OUT) });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section(`interface ${GI0}`, [`ip address ${R1_IN} ${MASK24}`, 'ip nat inside', 'no shutdown']),
      section(`interface ${GI1}`, [`ip address ${R1_OUT} ${MASK24}`, 'ip nat outside', 'no shutdown']),
      [...o.r1],
    ]),
  });
  sim.addLink({ id: 'l_r1_srv', a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC } });
  if (inside.length === 1) {
    sim.addLink({ id: 'l_in', a: { device: inside[0]!.id, port: PC }, b: { device: 'r1', port: GI0 } });
  } else {
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addLink({ id: 'l_sw1_r1', a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'r1', port: GI0 } });
    inside.forEach((h, i) => sim.addLink({ id: `l_${h.id}`, a: { device: h.id, port: PC }, b: { device: 'sw1', port: `FastEthernet0/${i + 1}` } }));
  }
  sim.runFor(BOOT);
  return sim;
}

const rows = (sim: Simulation): NatRow[] => sim.device('r1')!.tables.get<NatRow>('nat')!.rows();
const brief = (r: NatRow): unknown[] => [r.proto, r.insideLocal, r.insideLocalPort, r.insideGlobal, r.insideGlobalPort, r.outsideGlobal, r.outsideGlobalPort, r.kind];

/** Type `line` on `device` without running (so two hosts can act at the same instant). */
function start(sim: Simulation, device: string, line: string): string {
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`"${line}" on ${device} failed: ${r.output}`);
  return session;
}

/** Type `line` on `device`, run to idle, return the session's output and the events since. */
function exec(sim: Simulation, device: string, line: string): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = start(sim, device, line);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}

/** Ids of the PDUs `device` created with a tag starting with `tag`. */
const createdBy = (evs: readonly TraceEvent[], device: string, tag: string): number[] =>
  ofKind(evs, 'pduCreated').filter((e) => e.device === device && (e.pdu.tag ?? '').startsWith(tag)).map((e) => e.pdu.id);
/** `[reason, field, before, after]` of every mutation stamped `device` on PDU `id`. */
const mutationsAt = (sim: Simulation, id: number, device: string): [string, string, unknown, unknown][] =>
  sim.pdu(id)!.provenance.filter((m) => m.device === device).map((m) => [m.reason, m.field, m.before, m.after]);
/** Drops at `device` that are not background maintenance (BPDUs and the like are dropped as background). */
const realDrops = (evs: readonly TraceEvent[], device: string) => ofKind(evs, 'drop').filter((d) => d.device === device && d.background !== true);
/** The IPv4 packets received by `device` among `evs` (frames that carry an ipv4 layer). */
const ipv4At = (sim: Simulation, evs: readonly TraceEvent[], device: string) =>
  ofKind(evs, 'frameRx').filter((e) => e.device === device).map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('ipv4') !== undefined);

describe('accept P2: NAT — static (§3.9)', () => {
  it('SRV sees source 203.0.113.5; the provenance has NatTranslate ipv4.src with the rule as cause; every checksum valid', () => {
    const sim = natWorld({ r1: [STATIC_LINE] });
    expect(sim.device('r1')!.processes.has('nat')).toBe(true);
    expect(rows(sim)).toEqual([expect.objectContaining({ key: natKey('any', STATIC_GLOBAL), proto: 'any', insideLocal: PC1, insideGlobal: STATIC_GLOBAL, kind: 'static', rule: STATIC_LINE })]);
    const { text, evs } = exec(sim, 'pc1', `ping ${SRV}`);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const requests = createdBy(evs, 'pc1', 'ping#');
    expect(requests).toHaveLength(5);
    for (const id of requests) {
      const nat = sim.pdu(id)!.provenance.filter((m) => m.reason === 'NatTranslate');
      expect(nat).toEqual([expect.objectContaining({ device: 'r1', field: 'ipv4.src', before: PC1, after: STATIC_GLOBAL, cause: STATIC_LINE })]);
    }
    expect(mutationsAt(sim, requests[0]!, 'r1').map((m) => m[0])).toEqual([
      'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute', 'NatTranslate', 'ChecksumRecompute', 'FcsRecompute', 'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
    // what SRV received: five requests from 203.0.113.5, checksums valid, no inside address in sight
    const atSrv = ipv4At(sim, evs, 'srv').filter((p) => p.get('icmpv4.type') === 8);
    expect(atSrv).toHaveLength(5);
    for (const p of atSrv) {
      expect(p.get('ipv4.src')).toBe(STATIC_GLOBAL);
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
    }
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip).filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
    // the replies came back to PC1 translated
    const replies = createdBy(evs, 'srv', 'echo-reply').map((id) => sim.pdu(id)!);
    expect(replies).toHaveLength(5);
    for (const p of replies) {
      expect(p.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['ipv4.dst', STATIC_GLOBAL, PC1]]);
      expect(p.get('ipv4.dst')).toBe(PC1);
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
    }
    expect(realDrops(evs, 'r1')).toEqual([]);
    expect(rows(sim)).toHaveLength(1);
  });
});

describe('accept P2: NAT — dynamic pool (§3.9)', () => {
  it('the first host gets .20 and the second .21; with the pool full the next host drops nat-exhausted', () => {
    const sim = natWorld({ r1: [ACL_LINE, POOL_TWO, POOL_RULE], inside: [PC1_HOST, PC2_HOST, PC3_HOST] });
    expect(rows(sim)).toEqual([]);
    const first = exec(sim, 'pc1', `ping ${SRV}`);
    expect(first.text).toContain('Sent 5, received 5, lost 0');
    const req = createdBy(first.evs, 'pc1', 'ping#')[0]!;
    expect(sim.pdu(req)!.provenance.find((m) => m.reason === 'NatTranslate')).toMatchObject({ device: 'r1', field: 'ipv4.src', before: PC1, after: '203.0.113.20', cause: POOL_RULE });
    expect(rows(sim)).toEqual([expect.objectContaining({ key: natKey('any', '203.0.113.20'), insideLocal: PC1, insideGlobal: '203.0.113.20', kind: 'dynamic', rule: POOL_RULE })]);
    expect(rows(sim)[0]!.expiresAt).toBe(rows(sim)[0]!.updatedAt + 86_400 * SEC);
    expect(ipv4At(sim, first.evs, 'srv').filter((p) => p.get('icmpv4.type') === 8).every((p) => p.get('ipv4.src') === '203.0.113.20')).toBe(true);

    const second = exec(sim, 'pc2', `ping ${SRV}`);
    expect(second.text).toContain('Sent 5, received 5, lost 0');
    expect(rows(sim).map((r) => [r.insideLocal, r.insideGlobal, r.kind])).toEqual([[PC1, '203.0.113.20', 'dynamic'], [PC2, '203.0.113.21', 'dynamic']]);

    const third = exec(sim, 'pc3', `ping ${SRV}`);
    expect(third.text).toContain('received 0');
    const drops = ofKind(third.evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'nat-exhausted');
    expect(drops).toHaveLength(5);
    expect(drops.every((d) => d.detail === 'pool P has no free address')).toBe(true);
    expect(ipv4At(sim, third.evs, 'srv')).toEqual([]);
    expect(rows(sim)).toHaveLength(2);
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip).filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
  });
});

describe('accept P2: NAT — PAT on the interface (§3.9)', () => {
  it('two pings at once with id 1: overload rows with inside-global ids 1 and 2; SRV sees (203.0.113.1, 1) and (203.0.113.1, 2); both 5/5; checksums valid', () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE] });
    const cursor = sim.trace(0).next;
    const s1 = start(sim, 'pc1', `ping ${SRV}`);
    const s2 = start(sim, 'pc2', `ping ${SRV}`);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(output(evs, s1)).toContain('Sent 5, received 5, lost 0');
    expect(output(evs, s2)).toContain('Sent 5, received 5, lost 0');
    // both hosts used ICMP id 1
    for (const pc of ['pc1', 'pc2']) {
      const ids = createdBy(evs, pc, 'ping#').map((id) => sim.pdu(id)!.provenance.find((m) => m.field === 'icmpv4.id')?.before ?? sim.pdu(id)!.get('icmpv4.id'));
      expect(ids).toEqual([1, 1, 1, 1, 1]);
    }
    expect(rows(sim).map(brief)).toEqual([
      ['icmp', PC1, 1, R1_OUT, 1, SRV, undefined, 'overload'],
      ['icmp', PC2, 1, R1_OUT, 2, SRV, undefined, 'overload'],
    ]);
    expect(rows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1), natKey('icmp', R1_OUT, 2)]);
    expect(rows(sim).every((r) => r.rule === PAT_RULE)).toBe(true);
    // what SRV received: five requests with id 1 and five with id 2, all from 203.0.113.1, every checksum valid
    const atSrv = ipv4At(sim, evs, 'srv');
    const seen = atSrv.filter((p) => p.get('icmpv4.type') === 8).map((p) => [p.get('ipv4.src'), p.get('icmpv4.id')]);
    expect(seen.filter((s) => s[1] === 1)).toHaveLength(5);
    expect(seen.filter((s) => s[1] === 2)).toHaveLength(5);
    expect(seen.every((s) => s[0] === R1_OUT)).toBe(true);
    const received = [...atSrv, ...ipv4At(sim, evs, 'pc1'), ...ipv4At(sim, evs, 'pc2')];
    expect(received.length).toBeGreaterThanOrEqual(20);
    for (const p of received) {
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
    }
    // the replies came back translated to the right host
    const replies = createdBy(evs, 'srv', 'echo-reply').map((id) => sim.pdu(id)!);
    expect(replies).toHaveLength(10);
    expect(replies.map((p) => p.get('ipv4.dst')).sort()).toEqual([...Array<string>(5).fill(PC1), ...Array<string>(5).fill(PC2)]);
    expect(replies.every((p) => p.get('icmpv4.id') === 1)).toBe(true);
    // the observed §3.9 step 2 sequence at R1 for the host whose id moved (the nat owner derived it in nat.pat.test.ts)
    const moved = createdBy(evs, 'pc2', 'ping#').map((id) => mutationsAt(sim, id, 'r1')).find((ms) => ms.some((m) => m[1] === 'icmpv4.id'))!;
    expect(moved).toBeDefined();
    expect(moved.map((m) => m[0])).toEqual([
      'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute',
      'NatTranslate', 'ChecksumRecompute', 'FcsRecompute',
      'NatTranslate', 'ChecksumRecompute', 'FcsRecompute',
      'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
    expect(moved.filter((m) => m[0] === 'NatTranslate')).toEqual([['NatTranslate', 'icmpv4.id', 1, 2], ['NatTranslate', 'ipv4.src', PC2, R1_OUT]]);
    // PC1 kept its id: only the address moved
    const kept = createdBy(evs, 'pc1', 'ping#').map((id) => mutationsAt(sim, id, 'r1'));
    expect(kept.every((ms) => ms.filter((m) => m[0] === 'NatTranslate').length === 1)).toBe(true);
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip).filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
    expect(realDrops(evs, 'r1')).toEqual([]);
  });

  it("inbound match: while PC1's row icmp|203.0.113.1|1 is alive SRV pings 203.0.113.1 with id 1 — R1 answers, nothing reaches PC1", () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE], inside: [PC1_HOST] });
    const first = exec(sim, 'pc1', `ping ${SRV}`);
    expect(first.text).toContain('Sent 5, received 5, lost 0');
    expect(rows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    const srv = exec(sim, 'srv', `ping ${R1_OUT}`);
    expect(srv.text).toContain('Sent 5, received 5, lost 0');
    const srvRequests = createdBy(srv.evs, 'srv', 'ping#');
    expect(srvRequests).toHaveLength(5);
    expect(srvRequests.every((id) => sim.pdu(id)!.get('icmpv4.id') === 1)).toBe(true);
    for (const id of srvRequests) expect(sim.pdu(id)!.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    const r1Replies = createdBy(srv.evs, 'r1', 'echo-reply');
    expect(r1Replies).toHaveLength(5);
    expect(r1Replies.every((id) => sim.pdu(id)!.get('ipv4.src') === R1_OUT && sim.pdu(id)!.get('ipv4.dst') === SRV)).toBe(true);
    expect(ipv4At(sim, srv.evs, 'pc1')).toEqual([]);
    expect(ofKind(srv.evs, 'frameRx').filter((e) => e.device === 'pc1')).toEqual([]);
    // the row is untouched: still exactly the one PC1 made
    expect(rows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
  });

  it('idle ICMP rows expire after 60 s', () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE], inside: [PC1_HOST] });
    const { text } = exec(sim, 'pc1', `ping ${SRV}`);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const done = sim.now;
    const row = rows(sim)[0]!;
    expect(row.key).toBe(natKey('icmp', R1_OUT, 1));
    expect(row.expiresAt).toBe(row.updatedAt + 60 * SEC);
    sim.runFor(59 * SEC);
    expect(rows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    sim.runFor(66 * SEC);
    expect(rows(sim)).toEqual([]);
    const expired = ofKind(sim.trace(0).events, 'tableExpire').filter((e) => e.device === 'r1' && e.table === 'nat');
    expect(expired).toEqual([expect.objectContaining({ key: natKey('icmp', R1_OUT, 1), reason: 'aged' })]);
    expect(expired[0]!.t).toBeGreaterThanOrEqual(done + 60 * SEC);
    // the sweep is periodic: nothing holds runToIdle
    expect(sim.runToIdle(100_000).stopped).toBeUndefined();
  });
});

describe('accept P2: NAT — clear ip nat translation *', () => {
  it('removes dynamic rows only; the static row and its translation stay', () => {
    const sim = natWorld({ r1: [STATIC_LINE, ACL_LINE, POOL_TWO, POOL_RULE] });
    expect(rows(sim).map((r) => r.kind)).toEqual(['static']);
    const pc2 = exec(sim, 'pc2', `ping ${SRV}`);
    expect(pc2.text).toContain('Sent 5, received 5, lost 0');
    expect(rows(sim).map((r) => [r.kind, r.insideLocal, r.insideGlobal])).toEqual([['static', PC1, STATIC_GLOBAL], ['dynamic', PC2, '203.0.113.20']]);
    const before = sim.trace(0).next;
    const results = cliConsole(sim, 'r1', ['enable', 'clear ip nat translation *']).results;
    expect(results[1]!.error).toBeUndefined();
    sim.runToIdle();
    expect(rows(sim).map((r) => [r.kind, r.insideLocal, r.insideGlobal])).toEqual([['static', PC1, STATIC_GLOBAL]]);
    const cleared = ofKind(sim.trace(before).events, 'tableExpire').filter((e) => e.device === 'r1' && e.table === 'nat');
    expect(cleared.map((e) => e.key)).toEqual([natKey('any', '203.0.113.20')]);
    // the static translation still works, and the pool address is free again for the next host
    const pc1 = exec(sim, 'pc1', `ping ${SRV}`);
    expect(pc1.text).toContain('Sent 5, received 5, lost 0');
    expect(ipv4At(sim, pc1.evs, 'srv').filter((p) => p.get('icmpv4.type') === 8).every((p) => p.get('ipv4.src') === STATIC_GLOBAL)).toBe(true);
    const again = exec(sim, 'pc2', `ping ${SRV}`);
    expect(again.text).toContain('Sent 5, received 5, lost 0');
    expect(rows(sim).map((r) => [r.kind, r.insideGlobal])).toEqual([['static', STATIC_GLOBAL], ['dynamic', '203.0.113.20']]);
  });
});
