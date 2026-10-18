/**
 * wan.gre-keepalive [C17] — GRE keepalives and `tunnel key` in the tunnel owner (ARCHITECTURE-P3C §2.3 `gre.key`,
 * §2.6 `TunnelRow.keepalive` / `.tunnelKey` / `keepalive-missed`, §4.2 `gre-keepalive:<port>`, §4.3, §5; §7 W2a wan).
 *
 *   - `keepalive <s> <n>` (GRE mode only) sends one keepalive per period through the underlay: an outer GRE packet to
 *     the peer carrying an inner GRE packet addressed back to the sender; the peer returns the inner packet whatever its
 *     own configuration; its arrival resets the misses;
 *   - each period, the previous keepalive still unanswered counts one miss; `n` consecutive misses take the tunnel down
 *     `keepalive-missed`, exactly n periods after the first unanswered keepalive was sent (so a cut just before a
 *     keepalive is detected in n periods ± 1 ms); the next answer brings it back;
 *   - `tunnel key <k>` writes the GRE key word at the head; the tail drops a packet whose key differs (reason `other`
 *     with `greKeyMismatchDetail`);
 *   - silence: without the lines nothing is sent and the rows carry neither member.
 *
 * The world is test/tunnel.world.ts's §3.10 world in GRE mode (statics through the tunnel's far address).
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_GRE } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  GRE_KEEPALIVE_DEFAULT_RETRIES,
  GRE_KEEPALIVE_DEFAULT_S,
  GRE_KEEPALIVE_PROTOCOL_TYPE,
  GRE_KEEPALIVE_TAG,
  GRE_OUTER_TTL,
  greKeyMismatchDetail,
} from '../src/protocols/gre.js';
import { ping } from './sim.harness.js';
import {
  type Created,
  type Drop,
  PC2_ADDR,
  R1_GRE_TUNNEL,
  R1_WAN,
  R2_GRE_TUNNEL,
  R2_WAN,
  SE0,
  SE1,
  TU0,
  applyLine,
  ipsecTunnelLines,
  line,
  tunnelRow,
  tunnelUp,
  tunnelWorld,
} from './tunnel.world.js';

const KA = ' keepalive 10 3';

const keepalivesSent = (evs: readonly TraceEvent[], device: string): Created[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === device && e.process === 'gre' && e.pdu.tag === GRE_KEEPALIVE_TAG);
const consumedBy = (evs: readonly TraceEvent[], device: string): Set<string> =>
  new Set(evs.filter((e) => e.kind === 'pduConsumed' && e.device === device && e.process === 'gre').map((e) => String((e as { pdu: { id: unknown } }).pdu.id)));
const tunnelPortStates = (evs: readonly TraceEvent[], device: string): [number, boolean][] =>
  evs.filter((e) => e.kind === 'portState' && e.device === device && e.port === TU0).map((e) => [e.t, (e as { operUp: boolean }).operUp]);

/** The keepalives of `device` sent at least 1 s before the end of `evs`'s window (their answers are inside it). */
const answerable = (evs: readonly TraceEvent[], device: string, end: number): Created[] => keepalivesSent(evs, device).filter((e) => e.t <= end - SEC);

function runCollect(sim: Simulation, ns: number): TraceEvent[] {
  const cursor = sim.trace(0).next;
  sim.runFor(ns);
  return sim.trace(cursor).events;
}

describe('wan.gre-keepalive [C17]: the exchange', () => {
  it('both ends `keepalive 10 3`: one keepalive per 10 s from each, each answered; the row carries the keepalive; data still flows', () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, KA], r2Tunnel: [...R2_GRE_TUNNEL, KA] });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', keepalive: { periodS: 10, retries: 3, missed: 0 } });
    expect(tunnelRow(sim, 'r2')).toMatchObject({ state: 'up', keepalive: { periodS: 10, retries: 3, missed: 0 } });
    const cap = sim.startCapture({ ports: [{ device: 'isp', port: SE0 }, { device: 'isp', port: SE1 }], dir: 'rx', name: 'ISP', includeBackground: true });
    const evs = runCollect(sim, 60 * SEC);
    for (const d of ['r1', 'r2']) {
      const sent = keepalivesSent(evs, d);
      expect(sent.length).toBe(6);
      for (let i = 1; i < sent.length; i++) expect(sent[i]!.t - sent[i - 1]!.t).toBe(10 * SEC);
      // every keepalive came back to its sender and was consumed there
      const back = consumedBy(evs, d);
      const due = answerable(evs, d, sim.now);
      expect(due.length).toBeGreaterThanOrEqual(5);
      for (const s of due) expect(back.has(String(s.pdu.id))).toBe(true);
    }
    expect(evs.filter((e): e is Drop => e.kind === 'drop' && e.background !== true).map((d) => [d.device, d.reason, d.detail])).toEqual([]);
    expect(tunnelPortStates(evs, 'r1')).toEqual([]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', keepalive: { periodS: 10, retries: 3, missed: 0 } });
    // the wire: R1's keepalive toward R2, and R2's return of it toward R1
    const rows = sim.queryCapture(cap, { from: 0, limit: 1000 }).rows.map((r) => sim.captureRecord(cap, r.index)!);
    const outbound = rows.filter((r) => r.layers.length === 5 && r.layers[1]!.fields.src === R1_WAN);
    expect(outbound.length).toBeGreaterThanOrEqual(5);
    expect(outbound[0]!.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'gre', 'ipv4', 'gre']);
    expect(outbound[0]!.layers[1]!.fields).toMatchObject({ src: R1_WAN, dst: R2_WAN, protocol: IPPROTO_GRE, ttl: GRE_OUTER_TTL });
    expect(outbound[0]!.layers[2]!.fields).toMatchObject({ protocolType: 0x0800, keyPresent: false });
    expect(outbound[0]!.layers[3]!.fields).toMatchObject({ src: R2_WAN, dst: R1_WAN, protocol: IPPROTO_GRE });
    expect(outbound[0]!.layers[4]!.fields).toMatchObject({ protocolType: GRE_KEEPALIVE_PROTOCOL_TYPE });
    const returned = rows.filter((r) => r.layers.length === 3 && r.layers[1]!.fields.src === R2_WAN && r.layers[1]!.fields.dst === R1_WAN && r.layers[2]!.proto === 'gre');
    expect(returned.length).toBeGreaterThanOrEqual(5);
    expect(returned[0]!.layers[2]!.fields).toMatchObject({ protocolType: GRE_KEEPALIVE_PROTOCOL_TYPE });
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
  });

  it('a peer with no keepalive line answers anyway; `keepalive` alone means 10 s and 3 retries', () => {
    expect([GRE_KEEPALIVE_DEFAULT_S, GRE_KEEPALIVE_DEFAULT_RETRIES]).toEqual([10, 3]);
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' keepalive 5'] });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ keepalive: { periodS: 5, retries: 3, missed: 0 } });
    expect(tunnelRow(sim, 'r2')).not.toHaveProperty('keepalive');
    const evs = runCollect(sim, 40 * SEC);
    expect(keepalivesSent(evs, 'r1').length).toBe(8);
    const back = consumedBy(evs, 'r1');
    const due = answerable(evs, 'r1', sim.now);
    expect(due.length).toBeGreaterThanOrEqual(7);
    for (const s of due) expect(back.has(String(s.pdu.id))).toBe(true);
    expect(keepalivesSent(evs, 'r2')).toEqual([]);
    expect(tunnelUp(sim, 'r1')).toBe(true);
  });
});

describe('wan.gre-keepalive [C17]: detection and recovery', () => {
  it("the peer's underlay cut 1 ms before a keepalive: down keepalive-missed 30 s ± 1 ms later; up again on the next answer", () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, KA], r2Tunnel: [...R2_GRE_TUNNEL, KA] });
    const first = runCollect(sim, 10 * SEC + 500 * MS);
    const k1 = keepalivesSent(first, 'r1');
    expect(k1.length).toBe(1);
    expect(consumedBy(first, 'r1').has(String(k1[0]!.pdu.id))).toBe(true);
    const lastAnswered = k1[0]!.t;
    // the cut, 1 ms before the next keepalive: R2's provider link shut (R1's own underlay stays up, so only the
    // keepalives can tell)
    runCollect(sim, lastAnswered + 10 * SEC - MS - sim.now);
    const cutAt = sim.now;
    expect(cutAt).toBe(lastAnswered + 10 * SEC - MS);
    applyLine(sim, 'r2', [['interface', SE0]], ['shutdown']);
    const cut = runCollect(sim, 40 * SEC);
    const firstLost = lastAnswered + 10 * SEC;
    const down = firstLost + 30 * SEC;
    expect(tunnelPortStates(cut, 'r1')).toEqual([[down, false]]);
    expect(Math.abs(down - cutAt - 30 * SEC)).toBeLessThanOrEqual(MS);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'keepalive-missed', keepalive: { periodS: 10, retries: 3, missed: 3 }, since: down });
    // the misses as the row showed them: 1, 2, 3 at the three unanswered periods
    const writes = cut.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'tunnels') as Extract<TraceEvent, { kind: 'tableWrite' }>[];
    expect(writes.map((w) => [w.t - firstLost, (w.row.keepalive as { missed: number }).missed, w.row.state])).toEqual([
      [10 * SEC, 1, 'up'],
      [20 * SEC, 2, 'up'],
      [30 * SEC, 3, 'down'],
    ]);
    // R1 keeps sending while down; nothing answers
    expect(keepalivesSent(cut, 'r1').map((e) => e.t - firstLost)).toEqual([0, 10 * SEC, 20 * SEC, 30 * SEC]);
    expect(consumedBy(cut, 'r1').size).toBe(0);
    // data is refused while down
    expect(ping(sim, 'pc1', PC2_ADDR).text).not.toContain('!');
    // the link restored: the next keepalive is answered and the tunnel comes up on its return
    applyLine(sim, 'r2', [['interface', SE0]], ['shutdown'], true);
    const back = runCollect(sim, 30 * SEC);
    const ups = tunnelPortStates(back, 'r1');
    expect(ups.length).toBe(1);
    expect(ups[0]![1]).toBe(true);
    const answered = keepalivesSent(back, 'r1').filter((s) => consumedBy(back, 'r1').has(String(s.pdu.id)));
    expect(answered.length).toBeGreaterThan(0);
    expect(ups[0]![0] - answered[0]!.t).toBeGreaterThan(0);
    expect(ups[0]![0] - answered[0]!.t).toBeLessThan(10 * MS);
    expect((ups[0]![0] - lastAnswered) % (10 * SEC)).toBe(ups[0]![0] - answered[0]!.t);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', keepalive: { periodS: 10, retries: 3, missed: 0 } });
    expect(tunnelRow(sim, 'r1')!.reason).toBeUndefined();
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
  });

  it('`keepalive 10 1` goes down one period after the first unanswered keepalive; removing the line brings the tunnel up and stops the timer', () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' keepalive 10 1'] });
    const first = runCollect(sim, 10 * SEC + 500 * MS);
    const lastAnswered = keepalivesSent(first, 'r1')[0]!.t;
    applyLine(sim, 'r2', [['interface', SE0]], ['shutdown']);
    const cut = runCollect(sim, 25 * SEC);
    expect(tunnelPortStates(cut, 'r1')).toEqual([[lastAnswered + 20 * SEC, false]]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ reason: 'keepalive-missed', keepalive: { periodS: 10, retries: 1, missed: 1 } });
    // the keepalive line removed: the underlay is fine, so the tunnel is up again and no keepalive leaves any more
    const evs = line(sim, 'r1', [['interface', TU0]], ['keepalive', '10', '1'], true);
    expect(tunnelPortStates(evs, 'r1').map(([, up]) => up)).toEqual([true]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
    expect(tunnelRow(sim, 'r1')).not.toHaveProperty('keepalive');
    expect(keepalivesSent(runCollect(sim, 30 * SEC), 'r1')).toEqual([]);
  });
});

describe('wan.gre-keepalive [C17]: tunnel key', () => {
  it('the same key on both ends: the head writes the key word, data flows, the row carries tunnelKey', () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' tunnel key 7'], r2Tunnel: [...R2_GRE_TUNNEL, ' tunnel key 7'] });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', tunnelKey: 7 });
    const cap = sim.startCapture({ ports: [{ device: 'isp', port: SE0 }], dir: 'rx', name: 'ISP' });
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
    const rows = sim.queryCapture(cap, { from: 0, limit: 100 }).rows.map((r) => sim.captureRecord(cap, r.index)!);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.layers[2]!.fields).toMatchObject({ protocolType: 0x0800, keyPresent: true, key: 7 });
  });

  it('a key mismatch drops at the tail with its detail (other key, or no key)', () => {
    const run = (r2Key: readonly string[]): { sim: Simulation; drops: Drop[] } => {
      const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' tunnel key 7'], r2Tunnel: [...R2_GRE_TUNNEL, ...r2Key] });
      const r = ping(sim, 'pc1', PC2_ADDR);
      expect(r.text).not.toContain('!');
      return { sim, drops: r.evs.filter((e): e is Drop => e.kind === 'drop' && e.device === 'r2' && e.reason === 'other') };
    };
    const other = run([' tunnel key 8']);
    expect(other.drops.length).toBe(5);
    for (const d of other.drops) expect([d.port, d.detail]).toEqual([SE0, greKeyMismatchDetail(TU0, 7, 8)]);
    expect(greKeyMismatchDetail(TU0, 7, 8)).toBe('GRE key mismatch on Tunnel0: received key 7, expected key 8');
    const none = run([]);
    expect(none.drops.length).toBe(5);
    for (const d of none.drops) expect(d.detail).toBe(greKeyMismatchDetail(TU0, 7, undefined));
    expect(greKeyMismatchDetail(TU0, 7, undefined)).toBe('GRE key mismatch on Tunnel0: received key 7, expected no key');
  });

  it('keepalives across a key mismatch go unanswered: down keepalive-missed after three periods', () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' tunnel key 7', KA], r2Tunnel: [...R2_GRE_TUNNEL, ' tunnel key 8'] });
    const t0 = sim.now;
    const evs = runCollect(sim, 45 * SEC);
    const sent = keepalivesSent(evs, 'r1');
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(tunnelPortStates(evs, 'r1')).toEqual([[sent[3]!.t, false]]);
    expect(sent[3]!.t - sent[0]!.t).toBe(30 * SEC);
    expect(sent[0]!.t - t0).toBeLessThanOrEqual(10 * SEC);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ reason: 'keepalive-missed', tunnelKey: 7 });
  });
});

describe('wan.gre-keepalive [C17]: silence (§4.3)', () => {
  it('without the lines: no keepalive is sent, and the rows carry neither keepalive nor tunnelKey', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const evs = runCollect(sim, 60 * SEC);
    expect(evs.filter((e) => e.kind === 'pduCreated' && e.pdu.tag === GRE_KEEPALIVE_TAG)).toEqual([]);
    for (const d of ['r1', 'r2']) {
      expect(tunnelRow(sim, d)).not.toHaveProperty('keepalive');
      expect(tunnelRow(sim, d)).not.toHaveProperty('tunnelKey');
    }
  });

  it('`keepalive 0` disables; an ipsec-mode tunnel ignores the line (GRE mode only)', () => {
    const off = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' keepalive 0'] });
    expect(tunnelRow(off, 'r1')).not.toHaveProperty('keepalive');
    expect(keepalivesSent(runCollect(off, 30 * SEC), 'r1')).toEqual([]);
    const vti = tunnelWorld({ mode: 'ipsec', r1Tunnel: [...ipsecTunnelLines('172.16.0.1', R2_WAN), KA] });
    expect(tunnelRow(vti, 'r1')).toMatchObject({ mode: 'ipsec', state: 'up' });
    expect(tunnelRow(vti, 'r1')).not.toHaveProperty('keepalive');
    expect(keepalivesSent(runCollect(vti, 30 * SEC), 'r1')).toEqual([]);
  });
});
