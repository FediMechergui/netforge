/**
 * eigrp.adjacency [C1] — the neighbour half of the eigrp daemon on `staged.world` (ARCHITECTURE-P3 D26, §2.16, §3.12
 * steps 1, 5 and 6, §4.2, §4.3; §7 W2 eigrp): the hello reply, the init update and its acknowledgement, the K-value
 * and AS mismatches, hold expiry across a switch, and 16 retransmissions then a reset. Silence: a router whose
 * configuration holds no `router eigrp` sends, joins and writes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import { EIGRP_GROUP } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpStateView } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { EIGRP_OPCODE } from '../src/pdu/codecs/eigrp.js';
import { EIGRP_MAX_RETRANSMISSIONS, EIGRP_RTO_MIN_MS, createEigrp } from '../src/protocols/eigrp.js';
import { createStagedSimulation } from './staged.world.js';
import {
  GI0,
  GI1,
  R1,
  R2,
  R3,
  during,
  eigrpCreated,
  eigrpWorld,
  neighborRows,
  ribRow,
  startup,
  transitions,
  wrapEigrp,
  type Debug,
} from './eigrp.world.js';

const eigrpFields = (sim: Simulation, id: PduId): Record<string, unknown> => sim.pdu(id)!.layers.find((l) => l.proto === 'eigrp')!.fields as Record<string, unknown>;
const debugLines = (evs: readonly TraceEvent[], device: string, category: string): Debug[] =>
  evs.filter((e): e is Debug => e.kind === 'debug' && e.event.device === device && e.event.category === category);

/** The first `operUp` time of a device's port in `evs`. */
function upAt(evs: readonly TraceEvent[], device: string, port: string): number {
  const e = evs.find((x) => x.kind === 'portState' && x.device === device && x.port === port && x.operUp);
  if (e === undefined) throw new Error(`${device} ${port} never came up`);
  return e.t;
}

describe('eigrp adjacency [C1]: hellos, the init update and its acknowledgement (§3.12 step 1)', () => {
  it('each router sends a hello at link-up, answers a new neighbour at once, and every neighbour is up within 10 ms', () => {
    const { sim } = eigrpWorld({ noRun: true });
    const evs = during(sim, () => undefined);
    const linkUp = upAt(evs, R1, GI0);
    // R1 at link-up: one hello per enabled interface, to 224.0.0.10, after joining the group
    const hellos = eigrpCreated(evs, R1).filter((e) => e.pdu.tag === 'eigrp-hello');
    expect(hellos.slice(0, 2).map((e) => [e.t, e.pdu.flow])).toEqual([
      [linkUp, `ipv4:10.0.12.1>${EIGRP_GROUP}:eigrp`],
      [linkUp, `ipv4:10.0.13.1>${EIGRP_GROUP}:eigrp`],
    ]);
    expect(evs.some((e) => e.kind === 'debug' && e.event.device === R1 && e.event.message === `eigrp joined group ${EIGRP_GROUP} on ${GI0}`)).toBe(true);
    // the hello from R2 creates a pending neighbour, and the hello reply leaves at that very instant, before the init update
    const r1Nbr = transitions(evs, R1, 'eigrp-nbr').filter((t) => t.subject === `${GI0} 10.0.12.2`);
    expect(r1Nbr.map((t) => [t.from, t.to, t.cause])).toEqual([
      ['down', 'pending', 'hello received'],
      ['pending', 'up', 'init update acknowledged'],
    ]);
    const pendingAt = r1Nbr[0]!.t;
    const out = eigrpCreated(evs, R1).filter((e) => e.pdu.flow?.startsWith('ipv4:10.0.12.1>') === true && e.t === pendingAt);
    expect(out.map((e) => e.pdu.tag)).toEqual(['eigrp-hello', 'eigrp-update']);
    const reply = debugLines(evs, R1, 'eigrp packets').find((d) => d.t === pendingAt && d.event.message.startsWith('sent hello'));
    expect(reply!.event.message).toBe(`sent hello (AS 100, hold 15 s, reply to a new neighbour) to ${EIGRP_GROUP} on ${GI0}`);
    // every neighbour of every router is up within link-up + 10 ms
    for (const d of [R1, R2, R3, 'r4']) {
      const ups = transitions(evs, d, 'eigrp-nbr').filter((t) => t.to === 'up');
      expect(ups).toHaveLength(2);
      for (const u of ups) expect(u.t - linkUp).toBeLessThan(10 * MS);
    }
  });

  it('the init update is acknowledged by a hello carrying ack; the row is written at pending and once at up with SRTT and RTO', () => {
    const { sim } = eigrpWorld({ noRun: true });
    const evs = during(sim, () => undefined);
    // R1 → R2: the init update (seq 1, init flag, no route)
    const init = eigrpCreated(evs, R1).find((e) => e.pdu.tag === 'eigrp-update' && e.pdu.flow === 'ipv4:10.0.12.1>10.0.12.2:eigrp')!;
    expect(eigrpFields(sim, init.pdu.id)).toMatchObject({ opcode: EIGRP_OPCODE.update, flags: 1, seq: 1, ack: 0, as: 100 });
    expect(eigrpFields(sim, init.pdu.id).routes).toBeUndefined();
    // R2's acknowledgement: a hello with ack = 1 and no parameter TLV, unicast to R1
    const ack = eigrpCreated(evs, R2).find((e) => e.pdu.tag === 'eigrp-ack' && e.pdu.flow === 'ipv4:10.0.12.2>10.0.12.1:eigrp')!;
    const af = eigrpFields(sim, ack.pdu.id);
    expect(af).toMatchObject({ opcode: EIGRP_OPCODE.hello, ack: 1, seq: 0 });
    expect(af.kValues).toBeUndefined();
    expect(sim.pdu(ack.pdu.id)!.summary()).toBe('EIGRP acknowledgement AS 100, ack 1');
    // the up transition at R1 follows that acknowledgement
    const up = transitions(evs, R1, 'eigrp-nbr').find((t) => t.subject === `${GI0} 10.0.12.2` && t.to === 'up')!;
    expect(up.t).toBeGreaterThan(ack.t);
    // the full topology follows as an update with EOT
    const full = eigrpCreated(evs, R1).find((e) => e.pdu.tag === 'eigrp-update' && e.pdu.flow === 'ipv4:10.0.12.1>10.0.12.2:eigrp' && e.t === up.t)!;
    expect(eigrpFields(sim, full.pdu.id)).toMatchObject({ seq: 2, flags: 8 });
    // eigrp-neighbors[Gi0/0|10.0.12.2]: written twice — pending, then up with SRTT and RTO measured
    const writes = evs.filter((e) => e.kind === 'tableWrite' && e.device === R1 && e.table === 'eigrp-neighbors' && e.key === `${GI0}|10.0.12.2`);
    expect(writes.map((w) => (w as { row: Record<string, unknown> }).row.state)).toEqual(['pending', 'up']);
    expect(neighborRows(sim, R1).find((r) => r.key === `${GI0}|10.0.12.2`)).toEqual({
      key: `${GI0}|10.0.12.2`,
      iface: GI0,
      address: '10.0.12.2',
      as: 100,
      state: 'up',
      holdS: 15,
      srttMs: 1,
      rtoMs: EIGRP_RTO_MIN_MS,
      upSince: up.t,
      updatedAt: up.t,
    });
    // the StateView: the process, the neighbours in neighbour order (interface canonical order, then address), no queue
    const view = sim.device(R1)!.stateSnapshots().find((v) => v.process === 'eigrp')!.state as unknown as EigrpStateView;
    expect(view.process).toEqual({ as: 100, routerId: '10.0.13.1', kValues: [1, 0, 1, 0, 0], maximumPaths: 4 });
    expect(view.neighbors.map((n) => [n.iface, n.address, n.queue])).toEqual([
      [GI0, '10.0.12.2', 0],
      [GI1, '10.0.13.3', 0],
    ]);
    expect(view.active).toEqual([]);
    // periodic hellos afterwards never rewrite the row (rule 20), and runToIdle returned with only periodic timers left
    const mark = sim.trace(0).next;
    sim.runFor(30 * SEC);
    expect(sim.trace(mark).events.filter((e) => e.kind === 'tableWrite' && e.table === 'eigrp-neighbors')).toEqual([]);
    expect(eigrpCreated(sim.trace(mark).events, R1).filter((e) => e.pdu.tag === 'eigrp-hello').length).toBeGreaterThanOrEqual(10);
  });

  it('a router configured later meets its neighbour at once: the hello reply spares the periodic hello', () => {
    const { sim } = eigrpWorld({ process: { [R2]: [] } });
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    sim.runFor(2_345 * MS); // off the 5 s hello grid of R1
    const t = sim.now;
    const evs = during(sim, () => {
      const r2 = sim.device(R2)!;
      r2.applyActions('sim', [], sim.now); // sync the device clock, as the facade does before a typed line
      expect(r2.applyConfigLine([], ['router', 'eigrp', '100'], false)).toEqual({ ok: true });
      expect(r2.applyConfigLine([['router', 'eigrp', '100']], ['network', '10.0.0.0'], false)).toEqual({ ok: true });
    });
    const r1Up = transitions(evs, R1, 'eigrp-nbr').find((x) => x.subject === `${GI0} 10.0.12.2` && x.to === 'up')!;
    const r2Up = transitions(evs, R2, 'eigrp-nbr').find((x) => x.subject === `${GI0} 10.0.12.1` && x.to === 'up')!;
    expect(r1Up.t - t).toBeLessThan(10 * MS);
    expect(r2Up.t - t).toBeLessThan(10 * MS);
    // R1 answered R2's first hello with a hello of its own in the same instant (not its next periodic one)
    const pending = transitions(evs, R1, 'eigrp-nbr').find((x) => x.to === 'pending')!;
    const replies = debugLines(evs, R1, 'eigrp packets').filter((d) => d.event.message.includes('reply to a new neighbour'));
    expect(replies.map((d) => d.t)).toEqual([pending.t]);
  });
});

describe('eigrp adjacency [C1]: mismatches never form (§3.12 step 6)', () => {
  it('K values 0 1 1 1 0 0 on R2: both refuse, one severity-5 log each, never form; runToIdle returns', () => {
    const { sim } = eigrpWorld({ noRun: true, process: { [R2]: ['router eigrp 100', ' network 10.0.0.0', ' metric weights 0 1 1 1 0 0'] } });
    const cursor = sim.trace(0).next;
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    sim.runFor(30 * SEC);
    const evs = sim.trace(cursor).events;
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    expect(neighborRows(sim, R2)).toEqual([]);
    const logs = evs.filter((e): e is Extract<TraceEvent, { kind: 'log' }> => e.kind === 'log' && e.facility === 'EIGRP');
    expect(logs.filter((l) => l.device === R1).map((l) => [l.severity, l.message])).toEqual([
      [5, `EIGRP 100: neighbour 10.0.12.2 (${GI0}) refused: K-value mismatch (theirs 1 1 1 0 0, ours 1 0 1 0 0)`],
    ]);
    expect(logs.filter((l) => l.device === R2).map((l) => l.message)).toEqual([
      `EIGRP 100: neighbour 10.0.12.1 (${GI0}) refused: K-value mismatch (theirs 1 0 1 0 0, ours 1 1 1 0 0)`,
      `EIGRP 100: neighbour 10.0.24.4 (${GI1}) refused: K-value mismatch (theirs 1 0 1 0 0, ours 1 1 1 0 0)`,
    ]);
    // every refused hello is dropped with the reason; no neighbour ever went pending between R1 and R2
    const refusedAtR1 = evs.filter((e) => e.kind === 'drop' && e.device === R1 && e.detail?.startsWith('K-value mismatch with 10.0.12.2') === true);
    expect(refusedAtR1.length).toBeGreaterThanOrEqual(6);
    expect(transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`)).toEqual([]);
  });

  it('router eigrp 200 on R2: its hellos are ignored with a debug line, no log, no neighbour', () => {
    const { sim } = eigrpWorld({ noRun: true, process: { [R2]: ['router eigrp 200', ' network 10.0.0.0'] } });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    sim.runFor(30 * SEC);
    const evs = sim.trace(cursor).events;
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    expect(neighborRows(sim, R2)).toEqual([]);
    const ignored = debugLines(evs, R1, 'eigrp packets').filter((d) => d.event.message.startsWith('ignored hello from 10.0.12.2'));
    expect(ignored.length).toBeGreaterThanOrEqual(6);
    expect(ignored[0]!.event.message).toBe(`ignored hello from 10.0.12.2 on ${GI0}: AS 200, this router runs AS 100`);
    expect(evs.filter((e) => e.kind === 'log' && e.facility === 'EIGRP')).toEqual([]);
  });

  it('silence: a router with the daemon but no router eigrp sends, joins and writes nothing (§4.3)', () => {
    const { sim } = eigrpWorld({ noRun: true, process: { [R3]: [] } });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    sim.runFor(20 * SEC);
    const evs = sim.trace(cursor).events;
    expect(sim.device(R3)!.processes.has('eigrp')).toBe(true);
    expect(eigrpCreated(evs, R3)).toEqual([]);
    expect(evs.filter((e) => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.device === R3 && e.table.startsWith('eigrp'))).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.device === R3 && e.event.process === 'eigrp')).toEqual([]);
    expect(sim.device(R3)!.ports.get(GI0)!.l3.groups4).toBeUndefined();
    // R3 drops the hellos it receives (protocol 88 for a group it never joined): no neighbour on R1's Gi0/1
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.12.2']);
  });
});

describe('eigrp adjacency [C1]: failure detection', () => {
  /** R1 Gi0/0 — SW1 Fa0/1, SW1 Fa0/2 — R2 Gi0/0 (an indirect failure keeps R1's port up, §3.12 step 5). */
  function switched(): { sim: Simulation; swR2: string } {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3', factories: { eigrp: createEigrp } });
    const r = (name: string, addr: string): string =>
      startup([[`hostname ${name}`], [`interface ${GI0}`, ` ip address ${addr} 255.255.255.0`, ' no shutdown'], ['router eigrp 100', ' network 10.0.0.0']]);
    sim.addDevice({ id: R1, type: 'router.nf2911', name: 'R1', startupConfig: r('R1', '10.0.12.1') });
    sim.addDevice({ id: R2, type: 'router.nf2911', name: 'R2', startupConfig: r('R2', '10.0.12.2') });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
    sim.addLink({ a: { device: R1, port: GI0 }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    const swR2 = sim.addLink({ a: { device: R2, port: GI0 }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runToIdle();
    return { sim, swR2 };
  }

  it('hold expiry: with the switch–R2 cable cut at T, R1 keeps its port and loses R2 in [T + 10 s, T + 15 s]', () => {
    const { sim, swR2 } = switched();
    expect(neighborRows(sim, R1).map((r) => [r.address, r.state])).toEqual([['10.0.12.2', 'up']]);
    const t = sim.now;
    const cursor = sim.trace(0).next;
    sim.removeLink(swR2);
    sim.runUntil(t + 10 * SEC - 1);
    expect(neighborRows(sim, R1)).toHaveLength(1);
    sim.runUntil(t + 20 * SEC);
    const evs = sim.trace(cursor).events;
    expect(sim.device(R1)!.ports.get(GI0)!.operUp).toBe(true);
    const down = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.to === 'down');
    expect(down.map((x) => [x.subject, x.from, x.cause])).toEqual([[`${GI0} 10.0.12.2`, 'up', 'hold time expired']]);
    expect(down[0]!.t).toBeGreaterThanOrEqual(t + 10 * SEC);
    expect(down[0]!.t).toBeLessThanOrEqual(t + 15 * SEC);
    expect(neighborRows(sim, R1)).toEqual([]);
    const expired = evs.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'eigrp-neighbors');
    expect(expired.map((e) => [e.device, e.key, e.reason])).toEqual([
      [R2, `${GI0}|10.0.12.1`, 'link-down'],
      [R1, `${GI0}|10.0.12.2`, 'aged'],
    ]);
  });

  it('16 retransmissions, then a reset: a peer that never acknowledges never holds runToIdle', () => {
    // R2's daemon hears R1's hellos but swallows R1's acknowledgements and reliable packets
    const deaf = wrapEigrp((_inner, ctx, pdu) => {
      const ip = pdu.layer('ipv4');
      const e = pdu.layer('eigrp');
      if (ctx.deviceId !== R2 || ip?.fields.src !== '10.0.12.1' || e === undefined) return undefined;
      if (e.fields.opcode === EIGRP_OPCODE.hello && e.fields.kValues !== undefined) return undefined;
      return [{ type: 'consume', pdu }];
    });
    const { sim } = eigrpWorld({ noRun: true, factory: deaf });
    const cursor = sim.trace(0).next;
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    // the init update to R2: sent once and retransmitted 16 times, one RTO (200 ms, SRTT never measured) apart
    const inits = eigrpCreated(evs, R1).filter((e) => e.pdu.tag === 'eigrp-update' && e.pdu.flow === 'ipv4:10.0.12.1>10.0.12.2:eigrp');
    expect(inits).toHaveLength(1 + EIGRP_MAX_RETRANSMISSIONS);
    for (const p of inits) expect(eigrpFields(sim, p.pdu.id)).toMatchObject({ seq: 1, flags: 1 });
    for (let i = 1; i < inits.length; i++) expect(inits[i]!.t - inits[i - 1]!.t).toBe(EIGRP_RTO_MIN_MS * MS);
    const r2 = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`);
    expect(r2.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['down', 'pending', 'hello received'],
      ['pending', 'down', 'retry limit exceeded'],
    ]);
    expect(r2[1]!.t - inits.at(-1)!.t).toBe(EIGRP_RTO_MIN_MS * MS);
    expect(debugLines(evs, R1, 'eigrp packets').some((d) => d.event.message === `sent update seq 1, init, 0 routes, retransmission 16 of 16 to 10.0.12.2 on ${GI0}`)).toBe(true);
    // R1's other neighbour is untouched; the next attempt waits for R2's next periodic hello
    expect(neighborRows(sim, R1).map((r) => [r.address, r.state])).toEqual([['10.0.13.3', 'up']]);
    const later = during(sim, () => undefined, 6 * SEC);
    expect(transitions(later, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`)[0]).toMatchObject({ from: 'down', to: 'pending' });
  });
});

describe('eigrp adjacency [C1]: operator resets and removal', () => {
  it('clear ip eigrp neighbors: R1 resets R2; the next hello forms it again and R2 sees the init as a peer restart', () => {
    const { sim } = eigrpWorld();
    const r1 = sim.device(R1)!;
    const t = sim.now;
    const evs = during(sim, () => r1.applyActions('cli', [{ type: 'request', to: 'eigrp', req: { kind: 'eigrp.clear', neighbor: '10.0.12.2' } }], t), 6 * SEC);
    const atR1 = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`);
    expect(atR1.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['up', 'down', 'neighbours cleared'],
      ['down', 'pending', 'hello received'],
      ['pending', 'up', 'init update acknowledged'],
    ]);
    expect(atR1[0]!.t).toBe(t);
    const atR2 = transitions(evs, R2, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.1`);
    expect(atR2.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['up', 'down', 'peer restarted'],
      ['down', 'pending', 'hello received'],
      ['pending', 'up', 'init update acknowledged'],
    ]);
    // R3 was not cleared; the route to the LAN is back through R2
    expect(transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI1} 10.0.13.3`)).toEqual([]);
    expect(ribRow(sim, R1, '10.4.0.0/24')).toMatchObject({ nextHop: '10.0.12.2', metric: 3328 });
  });

  it('no router eigrp: neighbours down, tables emptied, every EIGRP route withdrawn, the group left; nothing sent after', () => {
    const { sim } = eigrpWorld();
    const r1 = sim.device(R1)!;
    r1.applyActions('sim', [], sim.now);
    const evs = during(sim, () => expect(r1.applyConfigLine([], ['router', 'eigrp', '100'], true)).toEqual({ ok: true }), 20 * SEC);
    expect(transitions(evs, R1, 'eigrp-nbr').map((x) => [x.to, x.cause])).toEqual([
      ['down', 'EIGRP process removed'],
      ['down', 'EIGRP process removed'],
    ]);
    expect(neighborRows(sim, R1)).toEqual([]);
    expect(r1.tables.get('eigrp-topology')!.size).toBe(0);
    expect(r1.tables.rib.rows().filter((r) => r.source === 'EIGRP')).toEqual([]);
    expect(r1.ports.get(GI0)!.l3.groups4).toBeUndefined();
    const after = evs.filter((e) => e.t > evs[0]!.t);
    expect(eigrpCreated(after, R1)).toEqual([]);
    // R2 loses R1 when its hold expires
    expect(transitions(evs, R2, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.1`).map((x) => x.cause)).toEqual(['hold time expired']);
  });
});
