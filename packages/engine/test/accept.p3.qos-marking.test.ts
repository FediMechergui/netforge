/**
 * accept.p3.qos-marking — QoS marking at the edge and a FIFO link under congestion, wired (ARCHITECTURE-P3 §10.1
 * `accept.p3.qos-marking`, §3.5, D16, §3.0 (a) step 9 and (b) step 10c; §7 W4 qa).
 *
 * The §3.5 world on `staged.world` at stage P3 (`accept.p3.qos.harness.ts`): PC-V and PC-D on SW1 → R1 Gi0/0 (input
 * policy MARK: VOIP = `VOICE-PORTS` = UDP 16384-32767 → `set dscp ef`), R1 Se0/0/0 (DCE, 128 kb/s, a plain FIFO) →
 * R2 → PC-S. Flows start from the host shell (`flow start …`) and are bounded (a count), so `runToIdle` converges after
 * the queue drains (rule 19); the congestion part runs them under `runFor`.
 *
 * Pinned (the row, clause by clause):
 *   • the voice datagram's provenance at R1 is exactly `QosMark ipv4.dscp 0→46` (cause `policy-map MARK class VOIP set
 *     dscp ef`), `ChecksumRecompute`, `FcsRecompute` (the derived records of the one `Pdu.mutate`), followed by the
 *     forwarding records every routed datagram gets; data datagrams are not rewritten (no QosMark, DSCP 0 at PC-S);
 *   • a frame SW1 floods for another MAC reaches R1 Gi0/0 and is dropped `not-for-me`, neither classified nor counted;
 *   • editing VOICE-PORTS (one CLI line on R1) changes the class of the next datagram;
 *   • an output `set cos 5` on a subinterface records `QosMark dot1q.pcp 0→5` on the tag `vlanPush` pushed;
 *   • `service-policy` on an SVI (and on a switchport) is refused with `qosPortUnsupported`;
 *   • `show policy-map interface` counts (packets, bytes, marked) equal the counts derived from the trace;
 *   • under `runFor`, within 30 s of the flows' start: PC-S's `flows` row `where {src: PC-V, flow: 'f1', dscp: 46}`
 *     shows a voice delay above 1 s (also graded as the lab's `table` check), `queue-full` drops on the FIFO serial link
 *     (both flows, the P2 D23 detail), and `PortSnapshot.txBacklog` at R1 Se0/0/0 with depth > 8 and 8 summaries;
 *   • three runs with one seed give byte-identical trace and snapshot JSON.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceId, PduId } from '../src/contracts/ids.js';
import { MEDIA, P2P_QUEUE_LIMIT } from '../src/contracts/link.js';
import { ETHERTYPE_IPV4, IPPROTO_UDP, type LayerSpec } from '../src/contracts/pdu.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { MS, SEC, serializationNs } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { fillTemplate } from '../src/cli/handlers/common.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import {
  dataFlow,
  hostExec,
  INJ_PORT,
  MARK_CAUSE,
  MARK_LINES,
  mutationsAt,
  mutationsByPdu,
  ofKind,
  PCD_IP,
  PCS_IP,
  PCT_IP,
  PCV_IP,
  qosWorld,
  R1_SUB,
  R_LAN,
  routerExec,
  SE0,
  showPolicyMapInterface,
  traceFrom,
  trafficPdus,
  voiceFlow,
} from './accept.p3.qos.harness.js';
import { injectFrames } from './inject.js';
import { createStagedSimulation } from './staged.world.js';

/** Voice: 50 datagrams per second; data: 25 per second (200 kb/s of 1000-byte datagrams). */
const VOICE_PPS = 50;
const DATA_PPS = 25;
/** A MAC no device owns: SW1 floods a frame to it. */
const OTHER_MAC = '02:00:5e:10:20:30';

/** The PDUs each sender's traffic daemon created, as a lookup id → sender. */
function senders(evs: readonly TraceEvent[]): Map<PduId, DeviceId> {
  const out = new Map<PduId, DeviceId>();
  for (const e of ofKind(evs, 'pduCreated')) if (e.process === 'traffic') out.set(e.pdu.id, e.device);
  return out;
}

/** The frames R1 received on Gi0/0 that reached step 10c (D16): delivered (no pipeline drop at the port) and not control. */
function classifiedAtR1(evs: readonly TraceEvent[]): Of10c[] {
  const pipelineDrops = new Set(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === R_LAN && d.reason === 'not-for-me').map((d) => d.pdu.id));
  return ofKind(evs, 'frameRx')
    .filter((e) => e.device === 'r1' && e.port === R_LAN)
    .filter((e) => !pipelineDrops.has(e.pdu.id) && e.pdu.proto !== 'cdp' && e.pdu.proto !== 'lldp')
    .map((e) => ({ id: e.pdu.id, size: e.pdu.size }));
}
interface Of10c {
  readonly id: PduId;
  readonly size: number;
}

/** The QosMark records R1 made, by PDU. */
function marksAtR1(evs: readonly TraceEvent[]): Map<PduId, number> {
  const out = new Map<PduId, number>();
  for (const e of ofKind(evs, 'mutation')) {
    if (e.mutation.device === 'r1' && e.mutation.reason === 'QosMark') out.set(e.pdu, (out.get(e.pdu) ?? 0) + 1);
  }
  return out;
}

/** A UDP datagram to port 16384 for `OTHER_MAC` (SW1 floods it), from the injector on SW1 Fa0/3. */
function floodedVoice(srcMac: string): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: OTHER_MAC, src: srcMac, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '192.168.1.99', dst: PCS_IP, protocol: IPPROTO_UDP, ttl: 64, dscp: 0 } },
    { proto: 'udp', fields: { srcPort: 40000, dstPort: 16384 } },
    { proto: 'payload', fields: { data: new Uint8Array(32) } },
  ];
}

/** `count` datagrams of each flow plus one flooded frame mid-way; runs to idle. The trace from just before the flows. */
function boundedRun(seed: number, seconds: number): { sim: Simulation; evs: TraceEvent[]; flooded: PduId } {
  const sim = qosWorld({ seed, injector: true });
  const cursor = sim.trace(0).next;
  hostExec(sim, 'pcv', voiceFlow(seconds * VOICE_PPS));
  hostExec(sim, 'pcd', dataFlow(seconds * DATA_PPS));
  sim.runFor(SEC);
  const injMac = sim.device('inj')!.port(INJ_PORT)!.mac;
  injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: [floodedVoice(injMac)], count: 1, spacingNs: SEC });
  const stats = sim.runToIdle();
  expect(stats.stopped).not.toBe('maxEvents');
  const evs = traceFrom(sim, cursor);
  // SW1 floods copies (each its own PDU, `parent` = the injected one): the copy that reached R1 Gi0/0
  const injected = ofKind(evs, 'pduCreated').find((e) => e.device === 'inj')!.pdu.id;
  const atR1 = ofKind(evs, 'frameRx').find((e) => e.device === 'r1' && e.port === R_LAN && (e.pdu.id === injected || e.pdu.parent === injected));
  expect(atR1).toBeDefined();
  return { sim, evs, flooded: atR1!.pdu.id };
}

const flowsRow = (sim: Simulation, key: string): FlowRow | undefined => sim.device('pcs')!.tables.get<FlowRow>('flows')?.get(key);

describe('§3.5 with bounded flows: marking at R1 Gi0/0', () => {
  it('the voice provenance at R1 is exactly QosMark, ChecksumRecompute, FcsRecompute; data is untouched; a flooded frame is not classified; show equals the trace', () => {
    const SECONDS = 5;
    const { sim, evs, flooded } = boundedRun(27, SECONDS);
    const from = senders(evs);
    const voice = trafficPdus(evs, 'pcv');
    const data = trafficPdus(evs, 'pcd');
    expect(voice).toHaveLength(SECONDS * VOICE_PPS);
    expect(data).toHaveLength(SECONDS * DATA_PPS);

    const atR1 = mutationsByPdu(evs, 'r1');
    // every voice datagram: R1's records are exactly the three of the one mutate, then the forwarding records
    for (const id of voice) {
      const got = atR1(id);
      expect(got).toEqual([
        { reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 46, cause: MARK_CAUSE },
        { reason: 'ChecksumRecompute', field: 'ipv4.checksum', before: expect.any(Number), after: expect.any(Number), cause: MARK_CAUSE },
        { reason: 'FcsRecompute', field: 'ethernet.fcs', before: expect.any(Number), after: expect.any(Number), cause: MARK_CAUSE },
        { reason: 'TtlDecrement', field: 'ipv4.ttl', before: 128, after: 127, cause: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
        { reason: 'ChecksumRecompute', field: 'ipv4.checksum', before: expect.any(Number), after: expect.any(Number), cause: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
        { reason: 'FcsRecompute', field: 'ethernet.fcs', before: expect.any(Number), after: expect.any(Number), cause: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
        { reason: 'Decapsulate', field: 'ethernet', before: 'ethernet', after: null, cause: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
        { reason: 'Encapsulate', field: 'hdlc', before: null, after: 'hdlc', cause: 'ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
      ]);
      // the checksum the mark recomputed is the one the TTL decrement starts from (one chain of records)
      expect(got[1]!.after).toBe(got[4]!.before);
      expect(sim.pdu(id)!.layer('ipv4')!.fields['dscp']).toBe(46);
    }
    // the provenance on the PDU itself agrees with the trace: R1's part starts with the three marking records
    const prov = sim.pdu(voice[0]!)!.provenance.filter((m) => m.device === 'r1').map((m) => [m.reason, m.field]);
    expect(prov.slice(0, 3)).toEqual([['QosMark', 'ipv4.dscp'], ['ChecksumRecompute', 'ipv4.checksum'], ['FcsRecompute', 'ethernet.fcs']]);

    // data datagrams fall in class-default and are not rewritten anywhere
    for (const id of data) {
      expect(atR1(id).filter((m) => m.reason === 'QosMark')).toEqual([]);
      expect(atR1(id)[0]!.reason).toBe('TtlDecrement');
      expect(sim.pdu(id)!.layer('ipv4')!.fields['dscp']).toBe(0);
    }
    expect(ofKind(evs, 'mutation').filter((e) => e.mutation.reason === 'QosMark' && from.get(e.pdu) !== 'pcv')).toEqual([]);

    // the flooded frame for another MAC reached R1 Gi0/0 (boundedRun found it), was dropped not-for-me, never marked
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.pdu.id === flooded).map((d) => [d.port, d.reason])).toEqual([[R_LAN, 'not-for-me']]);
    expect(atR1(flooded)).toEqual([]);

    // PC-S sees DSCP 46 on the voice flow and 0 on the data flow; nothing lost on these bounded runs' rows is required
    expect(flowsRow(sim, `${PCV_IP}|f1`)).toMatchObject({ flow: 'f1', src: PCV_IP, dscp: 46, dstPort: 16384 });
    expect(flowsRow(sim, `${PCD_IP}|f1`)).toMatchObject({ flow: 'f1', src: PCD_IP, dscp: 0, dstPort: 9 });

    // show policy-map interface equals the trace: the whole run (boot included), per class
    const all = traceFrom(sim, 0);
    const classified = classifiedAtR1(all);
    const marks = marksAtR1(all);
    expect(classified.some((c) => c.id === flooded)).toBe(false);
    const voip = classified.filter((c) => marks.has(c.id));
    const other = classified.filter((c) => !marks.has(c.id));
    expect(voip.map((c) => c.id)).toEqual(voice);
    const bytes = (xs: readonly Of10c[]): number => xs.reduce((n, c) => n + c.size, 0);
    expect(showPolicyMapInterface(sim, 'r1', R_LAN).split('\n')).toEqual([
      R_LAN,
      '  Input policy MARK',
      `    Class VOIP: ${voip.length} packets (${bytes(voip)} bytes) matched; ${marks.size} marked (set dscp ef)`,
      `    Class class-default: ${other.length} packets (${bytes(other)} bytes) matched`,
    ]);
    // the same counters in the runtime's view and the snapshot (display only)
    expect(sim.device('r1')!.qosCounters(R_LAN)).toEqual({
      input: 'MARK',
      classes: [
        { name: 'VOIP', matched: voip.length, matchedBytes: bytes(voip), marked: marks.size },
        { name: 'class-default', matched: other.length, matchedBytes: bytes(other), marked: 0 },
      ],
    });
    const snapPort = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === R_LAN)!;
    expect(snapPort.qos?.classes.map((c) => [c.name, c.matched, c.marked])).toEqual([['VOIP', voip.length, marks.size], ['class-default', other.length, 0]]);
  }, 120_000);
});

describe('the policy follows its configuration', () => {
  it('editing VOICE-PORTS changes the class of the next datagram', () => {
    const sim = qosWorld({ seed: 28 });
    const cursor = sim.trace(0).next;
    hostExec(sim, 'pcd', dataFlow(4 * DATA_PPS));
    sim.runFor(2 * SEC);
    // one line typed on R1 adds the data port to the list the class-map reads
    const edit = routerExec(sim, 'r1', ['enable', 'configure terminal', 'ip access-list extended VOICE-PORTS', 'permit udp any any eq 9', 'end']);
    expect(edit.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const editedAt = sim.now;
    sim.runToIdle();
    const evs = traceFrom(sim, cursor);
    const rxAt = new Map(ofKind(evs, 'frameRx').filter((e) => e.device === 'r1' && e.port === R_LAN).map((e) => [e.pdu.id, e.t] as const));
    const data = trafficPdus(evs, 'pcd');
    expect(data).toHaveLength(4 * DATA_PPS);
    const before = data.filter((id) => rxAt.get(id)! < editedAt);
    const after = data.filter((id) => rxAt.get(id)! > editedAt);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(before.length + after.length).toBe(data.length);
    for (const id of before) expect(mutationsAt(evs, id, 'r1').filter((m) => m.reason === 'QosMark')).toEqual([]);
    // the first datagram after the edit is already VOIP (the generation bump recompiles on the next frame)
    for (const id of after) expect(mutationsAt(evs, id, 'r1')[0]).toEqual({ reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 46, cause: MARK_CAUSE });
    const pmap = showPolicyMapInterface(sim, 'r1', R_LAN);
    expect(pmap).toContain(`    Class VOIP: ${after.length} packets (`);
    expect(pmap).toContain(`; ${after.length} marked (set dscp ef)`);
    // PC-S's row shows the last datagram's DSCP
    expect(flowsRow(sim, `${PCD_IP}|f1`)).toMatchObject({ dscp: 46, received: data.length });
  }, 120_000);
});

describe('output marking on a subinterface', () => {
  it('set cos 5 on Gi0/1.10: VlanTagPush, then QosMark dot1q.pcp 0→5 on the pushed tag, on every frame leaving it', () => {
    const cos5 = ['policy-map COS5', ' class class-default', '  set cos 5', '!'];
    const sim = qosWorld({ seed: 29, r1Qos: [...MARK_LINES, ...cos5], subinterface: ['service-policy output COS5'] });
    const cursor = sim.trace(0).next;
    expect(hostExec(sim, 'pcs', `ping ${PCT_IP}`)).toBeDefined();
    sim.runFor(10 * SEC);
    const evs = traceFrom(sim, cursor);
    // PC-S's echo requests, forwarded by R1 out of the subinterface toward PC-T
    const requests = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pcs' && e.pdu.proto === 'icmpv4').map((e) => e.pdu.id);
    expect(requests.length).toBeGreaterThan(0);
    const cause = 'policy-map COS5 class class-default set cos 5';
    const atR1 = mutationsByPdu(evs, 'r1');
    for (const id of requests) {
      const got = atR1(id);
      const push = got.findIndex((m) => m.reason === 'VlanTagPush');
      expect(push).toBeGreaterThanOrEqual(0);
      expect(got.slice(push).map((m) => [m.reason, m.field])).toEqual([
        ['VlanTagPush', 'dot1q.vid'],
        ['FcsRecompute', 'ethernet.fcs'],
        ['QosMark', 'dot1q.pcp'],
        ['FcsRecompute', 'ethernet.fcs'],
      ]);
      expect(got[push + 2]).toEqual({ reason: 'QosMark', field: 'dot1q.pcp', before: 0, after: 5, cause });
      // R1's input policy is on Gi0/0 only: the serial-side arrival is not classified (no QosMark before the push)
      expect(got.slice(0, push).filter((m) => m.reason === 'QosMark')).toEqual([]);
      // the frame left R1 tagged 10 with PCP 5: SW1 received it so on its trunk
      const rx = ofKind(evs, 'frameRx').find((e) => e.device === 'sw1' && e.pdu.id === id);
      expect(rx?.pdu.vlan).toBe(10);
    }
    // the replies came back: the ping succeeded through the marked subinterface
    expect(ofKind(evs, 'pduConsumed').filter((e) => e.device === 'pcs' && e.pdu.proto === 'icmpv4').length).toBe(requests.length);
    const out = sim.device('r1')!.qosCounters(R1_SUB)!;
    expect(out.output).toBe('COS5');
    const def = out.classes.at(-1)!;
    expect(def.name).toBe('class-default');
    expect(def.marked).toBe(def.matched);
    expect(def.matched).toBeGreaterThanOrEqual(requests.length);
  }, 120_000);
});

describe('where a service policy may attach', () => {
  it('an SVI and a switchport refuse it with qosPortUnsupported; a routed port of the same switch takes it', () => {
    const sim = createStagedSimulation({ seed: 30, stage: 'P3' });
    sim.addDevice({ id: 'dsw', type: 'mlswitch.nfc3650-24', name: 'DSW1' });
    sim.runFor(60 * SEC);
    const typed = routerExec(sim, 'dsw', [
      'enable',
      'configure terminal',
      // each section closed by `exit` (a named-ACL entry mode does not take a global line)
      ...MARK_LINES.map((l) => (l === '!' ? 'exit' : l.trim())),
      'end',
      'configure terminal',
      'interface vlan 10',
      'service-policy input MARK',
      'exit',
      'interface GigabitEthernet1/0/1',
      'service-policy input MARK',
      'no switchport',
      'service-policy input MARK',
      'end',
    ]);
    const errors = typed.map((r) => r.error).filter((e) => e !== undefined);
    expect(errors).toEqual([
      fillTemplate(CLI_MESSAGES.qosPortUnsupported, { port: 'Vlan10' }),
      fillTemplate(CLI_MESSAGES.qosPortUnsupported, { port: 'GigabitEthernet1/0/1' }),
    ]);
    const [, run] = routerExec(sim, 'dsw', ['enable', 'show running-config']);
    expect(run!.output).toMatch(/interface Vlan10\n(?! service-policy)/);
    expect(run!.output.match(/ service-policy input MARK/g)).toHaveLength(1);
    expect(run!.output).toMatch(/interface GigabitEthernet1\/0\/1\n no switchport\n(?:.*\n)*? service-policy input MARK/);
  }, 120_000);
});

describe('§3.5 congestion under runFor: marking alone does not protect voice on a FIFO link', () => {
  it('within 30 s: voice delay above 1 s at PC-S (row and lab check), queue-full drops on both flows, a deep txBacklog at R1 Se0/0/0', () => {
    const sim = qosWorld({ seed: 31 });
    expect(sim.device('r1')!.egressPolicy(SE0)).toBeUndefined();
    const cursor = sim.trace(0).next;
    const SECONDS = 30;
    hostExec(sim, 'pcv', voiceFlow(SECONDS * VOICE_PPS));
    hostExec(sim, 'pcd', dataFlow(SECONDS * DATA_PPS));
    const startedAt = sim.now;
    sim.runFor(SECONDS * SEC);
    expect(sim.now - startedAt).toBe(SECONDS * SEC);

    // the receiver's row: DSCP 46 (marked at R1), and a delay above one second
    const row = flowsRow(sim, `${PCV_IP}|f1`)!;
    expect(row).toMatchObject({ flow: 'f1', src: PCV_IP, dscp: 46 });
    expect(row.delayMaxNs).toBeGreaterThan(SEC);
    // graded as §3.5 step 8 grades it: an exact dscp 46 in `where`
    expect(gradeFlows(sim, { src: PCV_IP, flow: 'f1', dscp: 46 }, { delayMaxNs: { op: 'gt', value: SEC } })).toBe(true);
    expect(gradeFlows(sim, { src: PCV_IP, flow: 'f1', dscp: 48 })).toBe(false);

    // queue-full drops on the FIFO serial link, both flows, with the P2 D23 detail (the constant, not a typed number)
    const evs = traceFrom(sim, cursor);
    const from = senders(evs);
    const tail = ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === SE0 && d.reason === 'queue-full');
    expect(tail.length).toBeGreaterThan(0);
    for (const d of tail) expect(d.detail).toBe(`${P2P_QUEUE_LIMIT} frames already queued`);
    expect([...new Set(tail.map((d) => from.get(d.pdu.id)))].sort()).toEqual(['pcd', 'pcv']);
    // no scheduler on this port: nothing is ever held, every frame was committed by the virtual FIFO
    expect(ofKind(evs, 'frameQueued')).toEqual([]);

    // the congestion view: the virtual FIFO's backlog at R1 Se0/0/0
    const port = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === SE0)!;
    const backlog = port.txBacklog!;
    expect(backlog.depth).toBeGreaterThan(8);
    expect(backlog.frames).toHaveLength(8);
    const starts = backlog.frames.map((f) => f.txStart);
    expect(starts.every((t) => t > sim.now)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // voice frames wait in it marked EF (the overlay's EF capsules), data frames unmarked; both flows are in the 8
    // (a serial keepalive committed meanwhile may sit among them: it carries no DSCP)
    const datagrams = backlog.frames.filter((f) => f.summary.proto === 'udp');
    const kinds = datagrams.map((f) => [f.summary.flow?.endsWith(':16384:udp') === true ? 'voice' : 'data', f.dscp]);
    for (const [kind, dscp] of kinds) expect(dscp).toBe(kind === 'voice' ? 46 : 0);
    expect(new Set(kinds.map(([k]) => k))).toEqual(new Set(['voice', 'data']));
    for (const f of backlog.frames) if (f.summary.proto !== 'udp') expect([f.summary.tag, f.dscp]).toEqual(['keepalive', undefined]);
    // each data frame (1000-byte datagram in HDLC) takes 63 ms on the 128 kb/s line (§3.5 "≈ 63 ms"), from the
    // serialisation rule of the link (frame bytes plus the serial PHY overhead)
    const dataFrame = backlog.frames.find((f) => f.dscp === 0)!;
    const dataSerialisation = serializationNs(dataFrame.bytes + MEDIA['serial-dce'].phyOverheadBytes!, 128_000);
    expect(dataSerialisation).toBeGreaterThan(62 * MS);
    expect(dataSerialisation).toBeLessThan(64 * MS);
    // the committed times of the backlog are back to back at that rule (oldest first)
    for (let i = 1; i < backlog.frames.length; i++) {
      const prev = backlog.frames[i - 1]!;
      expect(backlog.frames[i]!.txStart - prev.txStart).toBe(serializationNs(prev.bytes + MEDIA['serial-dce'].phyOverheadBytes!, 128_000));
    }

    // the flows are bounded: after their last datagram the queue drains and the world goes idle
    expect(sim.runToIdle().stopped).not.toBe('maxEvents');
    expect(flowsRow(sim, `${PCV_IP}|f1`)!.ended).toBe(true);
  }, 120_000);
});

/** Grade one `table flows` assertion on PC-S (§3.5 step 8). */
function gradeFlows(sim: Simulation, where: Record<string, string | number>, whereOps?: Extract<LabAssertion, { kind: 'table' }>['whereOps']): boolean {
  const assertion: LabAssertion = { kind: 'table', device: 'PC-S', table: 'flows', where, exists: true, ...(whereOps === undefined ? {} : { whereOps }) };
  const lab: ScenarioInfo = {
    name: 'qos-marking-flows',
    title: 'flows',
    description: 'one table check',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 't', title: 't', description: 't', points: 1, assertions: [assertion] }],
  };
  return evaluateLab(sim, lab).results[0]!.assertions[0]!.pass;
}

describe('determinism', () => {
  it('three runs of the bounded scenario with one seed give byte-identical trace and snapshot JSON', () => {
    const digest = (): string => {
      const { sim } = boundedRun(41, 4);
      const h = createHash('sha256');
      h.update(JSON.stringify(traceFrom(sim, 0)));
      h.update('\n');
      h.update(JSON.stringify(sim.snapshot()));
      return h.digest('hex');
    };
    const a = digest();
    expect(digest()).toBe(a);
    expect(digest()).toBe(a);
  }, 180_000);
});
