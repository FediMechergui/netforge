// The QoS overlay model (ARCHITECTURE-P3 §6, D16, §3.5 step 5, §10.2 "overlays.qos-model"): FIFO stacks at egress
// ports from `PortSnapshot.txBacklog` (ruling R6), DSCP letters, and the cable load sleeves from `outBytes` deltas.
// W7 qa (§10.2): the last block adds the same row on a real P3 world — §3.5's voice and data flows congesting the
// 128 kb/s serial link — so the letters come from the frames the engine itself lists, not from a fixture.
import { describe, expect, it } from 'vitest';
import { createSimulation, emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, PduSummary, PortSnapshot, PortTxQueueView, Simulation, TraceEvent } from '@netforge/engine';
import {
  DSCP_EF,
  LOAD_SLEEVE_MAX_WIDTH,
  LOAD_WINDOW_NS,
  QOS_STACK_MAX,
  buildQosOverlay,
  deriveDeviceQos,
  dscpFamily,
  dscpLetter,
  dscpName,
  loadBaseOf,
  loadLevel,
  loadPercentLabel,
  loadSampleOf,
  portKey,
  pushLoadSample,
  stackOf,
  utilisation,
  type DscpReader,
  type TxBacklogFrame,
} from '../src/canvas/overlays/qos-model.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const MS = 1_000_000;
const SEC = 1_000_000_000;

function summary(id: number, proto: PduSummary['proto'] = 'udp', size = 1004): PduSummary {
  return { id, proto, size, summary: `UDP 192.168.1.10:16384 > 192.168.2.10:16384 len=${size - 44} #${id}` };
}

function frame(id: number, txStart: number, bytes = 1004): TxBacklogFrame {
  return { pdu: id, summary: summary(id, 'udp', bytes), txStart, bytes };
}

function serial(id: string, linkId: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return port(id, { short: id, kind: 'serial', role: 'routed', encap: 'hdlc', operUp: true, link: linkId, speedBps: 128_000, ...extra });
}

function router(id: string, ports: PortSnapshot[]): DeviceSnapshot {
  return device(id, 0, 0, ports, { type: 'router.nf2911', model: 'NF-2911', kind: 'router' });
}

/** R1 Se0/0/0 ↔ R2 Se0/0/0 at 128 kb/s (§3.5), with R1's egress backlog. */
function wan(backlog?: PortTxQueueView, r1Out = 0, r2Out = 0, now = 0) {
  const r1 = router('r1', [serial('Se0/0/0', 'l1', { counters: { ...emptyCounters(), outBytes: r1Out }, ...(backlog === undefined ? {} : { txBacklog: backlog }) })]);
  const r2 = router('r2', [serial('Se0/0/0', 'l1', { counters: { ...emptyCounters(), outBytes: r2Out } })]);
  return snapshot([r1, r2], [link('l1', ['r1', 'Se0/0/0'], ['r2', 'Se0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' })], { now });
}

describe('DSCP letters', () => {
  it('letters EF, AF, CS and BE, and shows any other code point as its number', () => {
    expect(DSCP_EF).toBe(46);
    expect(dscpLetter(46)).toBe('EF');
    expect(dscpLetter(0)).toBe('BE');
    for (const af of [10, 12, 14, 18, 20, 22, 26, 28, 30, 34, 36, 38]) expect(dscpLetter(af), String(af)).toBe('AF');
    for (const cs of [8, 16, 24, 32, 40, 48, 56]) expect(dscpLetter(cs), String(cs)).toBe('CS');
    expect(dscpLetter(5)).toBe('5');
    expect(dscpLetter(44)).toBe('44');
    expect(dscpFamily(44)).toBe('other');
  });

  it('names the code point for the tooltip, and leaves an unknown DSCP blank', () => {
    expect(dscpName(46)).toBe('EF (46)');
    expect(dscpName(34)).toBe('AF41 (34)');
    expect(dscpName(10)).toBe('AF11 (10)');
    expect(dscpName(48)).toBe('CS6 (48)');
    expect(dscpName(0)).toBe('BE (0)');
    expect(dscpName(5)).toBe('DSCP 5');
    for (const bad of [undefined, -1, 64, 4.5, Number.NaN]) {
      expect(dscpLetter(bad)).toBe('');
      expect(dscpName(bad)).toBe('');
    }
  });
});

describe('the FIFO stack (txBacklog)', () => {
  it('draws three capsules in txStart order for a port whose backlog holds three frames (§10.2)', () => {
    const backlog: PortTxQueueView = { depth: 3, frames: [frame(7, 130 * MS), frame(5, 4 * MS), frame(6, 67 * MS)] };
    const model = buildQosOverlay(wan(backlog));
    expect(model.stacks).toHaveLength(1);
    const stack = model.stacks[0]!;
    expect(stack).toMatchObject({ device: 'r1', port: 'Se0/0/0', link: 'l1', end: 'a', depth: 3, more: 0, moreLabel: '' });
    expect(stack.capsules.map((c) => c.pdu)).toEqual([5, 6, 7]);
    expect(stack.capsules.map((c) => c.txStart)).toEqual([4 * MS, 67 * MS, 130 * MS]);
    expect(stack.capsules[0]).toMatchObject({ proto: 'udp', bytes: 1004, summary: 'UDP 192.168.1.10:16384 > 192.168.2.10:16384 len=960 #5' });
  });

  it('draws 8 capsules and +4 for a depth of 12 with 8 summaries (§10.2)', () => {
    const frames = Array.from({ length: 8 }, (_, i) => frame(100 + i, (i + 1) * 63 * MS));
    const stack = buildQosOverlay(wan({ depth: 12, frames })).stacks[0]!;
    expect(stack.capsules).toHaveLength(QOS_STACK_MAX);
    expect(stack.depth).toBe(12);
    expect(stack.more).toBe(4);
    expect(stack.moreLabel).toBe('+4');
  });

  it('never draws more than 8 capsules, keeps equal start times in list order, and trusts no depth below the frames', () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i + 1, 5 * MS));
    const stack = stackOf({ depth: 3, frames }, { device: 'r1', port: 'Se0/0/0' });
    expect(stack.capsules.map((c) => c.pdu)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stack.depth).toBe(8);
    expect(stack.more).toBe(0);
  });

  it('draws nothing where there is no txBacklog (an uncongested world)', () => {
    expect(buildQosOverlay(wan()).stacks).toEqual([]);
    expect(buildQosOverlay(wan({ depth: 0, frames: [] })).stacks).toEqual([]);
    expect(buildQosOverlay(snapshot([device('pc1', 0, 0, [port('Gi0')])]))).toEqual({ stacks: [], sleeves: [] });
  });

  it('letters the capsules from the frame entry dscp (the W1 contract fix) when no reader is given', () => {
    const backlog: PortTxQueueView = { depth: 3, frames: [{ ...frame(1, 1 * MS), dscp: 46 }, frame(2, 2 * MS), { ...frame(3, 3 * MS), dscp: 34 }] };
    const stack = buildQosOverlay(wan(backlog)).stacks[0]!;
    expect(stack.capsules.map((c) => c.letter)).toEqual(['EF', '', 'AF']);
    expect(stack.capsules.map((c) => c.dscp)).toEqual([46, undefined, 34]);
    // a reader the caller passes takes precedence
    expect(buildQosOverlay(wan(backlog), { dscpOf: () => 0 }).stacks[0]!.capsules.map((c) => c.letter)).toEqual(['BE', 'BE', 'BE']);
  });

  it('letters the capsules with the DSCP of the frames (voice EF, bulk data BE)', () => {
    // A caller's reader (frames without their own dscp).
    const voice = new Set([2, 4]);
    const dscpOf: DscpReader = (f, where) => {
      expect(where).toEqual({ device: 'r1', port: 'Se0/0/0' });
      return voice.has(f.pdu) ? 46 : 0;
    };
    const backlog: PortTxQueueView = { depth: 4, frames: [frame(1, 1 * MS), frame(2, 2 * MS, 64), frame(3, 3 * MS), frame(4, 4 * MS, 64)] };
    const stack = buildQosOverlay(wan(backlog), { dscpOf }).stacks[0]!;
    expect(stack.capsules.map((c) => c.letter)).toEqual(['BE', 'EF', 'BE', 'EF']);
    expect(stack.capsules.map((c) => c.dscp)).toEqual([0, 46, 0, 46]);
    expect(stack.capsules[1]?.dscpName).toBe('EF (46)');
    // Without a reader (or with a value that is no DSCP) the capsule has no letter and no dscp member.
    const plain = buildQosOverlay(wan(backlog)).stacks[0]!;
    expect(plain.capsules.every((c) => c.letter === '' && !('dscp' in c))).toBe(true);
    const odd = buildQosOverlay(wan(backlog), { dscpOf: () => 99 }).stacks[0]!;
    expect(odd.capsules.every((c) => c.letter === '' && c.dscp === undefined)).toBe(true);
  });

  it('keeps a stack on a port with no cable, without link and end', () => {
    const r1 = router('r1', [port('Gi0/0', { role: 'routed', txBacklog: { depth: 1, frames: [frame(1, 5)] } })]);
    const stack = buildQosOverlay(snapshot([r1])).stacks[0]!;
    expect(stack).toMatchObject({ device: 'r1', port: 'Gi0/0', depth: 1 });
    expect('link' in stack).toBe(false);
  });
});

describe('the load sleeves (outBytes deltas against speedBps)', () => {
  it('computes utilisation, clamped, and refuses what it cannot know', () => {
    expect(utilisation(16_000, SEC, 128_000)).toBe(1);
    expect(utilisation(8_000, SEC, 128_000)).toBe(0.5);
    expect(utilisation(64_000, SEC, 128_000)).toBe(1);
    expect(utilisation(0, SEC, 128_000)).toBe(0);
    expect(utilisation(16_000, 0, 128_000)).toBeUndefined();
    expect(utilisation(16_000, SEC, undefined)).toBeUndefined();
    expect(utilisation(16_000, SEC, 0)).toBeUndefined();
    expect(utilisation(-5, SEC, 128_000)).toBeUndefined();
  });

  it('ramps ok / warn / err as the redundant channel and labels the percentage', () => {
    expect(loadLevel(0)).toBe('ok');
    expect(loadLevel(0.49)).toBe('ok');
    expect(loadLevel(0.5)).toBe('warn');
    expect(loadLevel(0.84)).toBe('warn');
    expect(loadLevel(0.85)).toBe('err');
    expect(loadLevel(1)).toBe('err');
    expect(loadPercentLabel(1)).toBe('100 %');
    expect(loadPercentLabel(0.374)).toBe('37 %');
  });

  it('gives a saturated 128 kb/s link a sleeve fraction of 1.0 (§10.2)', () => {
    const before = wan(undefined, 1_000, 2_000, 10 * SEC);
    const base = loadSampleOf(before);
    expect(base.at).toBe(10 * SEC);
    expect(base.outBytes.get(portKey('r1', 'Se0/0/0'))).toBe(1_000);
    // One second later R1 sent 16 000 bytes (128 kb/s × 1 s); R2 sent 4 000 (a quarter of the line).
    const after = wan(undefined, 17_000, 6_000, 11 * SEC);
    const model = buildQosOverlay(after, { base });
    expect(model.sleeves).toEqual([
      { link: 'l1', from: 'a', device: 'r1', port: 'Se0/0/0', fraction: 1, width: LOAD_SLEEVE_MAX_WIDTH, label: '100 %', level: 'err' },
      { link: 'l1', from: 'b', device: 'r2', port: 'Se0/0/0', fraction: 0.25, width: 0.25 * LOAD_SLEEVE_MAX_WIDTH, label: '25 %', level: 'ok' },
    ]);
  });

  it('draws no sleeve without an earlier sample, at the same instant, on a link that is down, or after a counter reset', () => {
    const now = wan(undefined, 17_000, 6_000, 11 * SEC);
    expect(buildQosOverlay(now).sleeves).toEqual([]);
    expect(buildQosOverlay(now, { base: null }).sleeves).toEqual([]);
    expect(buildQosOverlay(now, { base: loadSampleOf(now) }).sleeves).toEqual([]);
    const down = { ...now, links: now.links.map((l) => ({ ...l, up: false })) };
    expect(buildQosOverlay(down, { base: loadSampleOf(wan(undefined, 0, 0, 10 * SEC)) }).sleeves).toEqual([]);
    const reset = buildQosOverlay(wan(undefined, 100, 6_000, 11 * SEC), { base: loadSampleOf(wan(undefined, 5_000, 2_000, 10 * SEC)) });
    expect(reset.sleeves.map((s) => s.from)).toEqual(['b']);
  });

  it('falls back to the negotiated rate of the link when the port reports no speed', () => {
    const r1 = router('r1', [port('Gi0/0', { role: 'routed', operUp: true, link: 'l1', counters: { ...emptyCounters(), outBytes: 12_500_000 } })]);
    const r2 = router('r2', [port('Gi0/0', { role: 'routed', operUp: true, link: 'l1' })]);
    const l = link('l1', ['r1', 'Gi0/0'], ['r2', 'Gi0/0'], { negotiatedBps: 1_000_000_000 });
    const base = loadSampleOf(snapshot([router('r1', [port('Gi0/0', { role: 'routed' })]), r2], [l], { now: 0 }));
    const model = buildQosOverlay(snapshot([r1, r2], [l], { now: SEC }), { base });
    expect(model.sleeves.map((s) => [s.from, s.fraction])).toEqual([
      ['a', 0.1],
      ['b', 0],
    ]);
  });

  it('keeps a sample history about one window long, and restarts it after a seek back', () => {
    const at = (t: number): { at: number; outBytes: Map<string, number> } => ({ at: t, outBytes: new Map() });
    let h = pushLoadSample([], at(0));
    expect(loadBaseOf(h, 0)).toBeNull(); // nothing older than now yet
    h = pushLoadSample(h, at(400 * MS));
    h = pushLoadSample(h, at(800 * MS));
    expect(h.map((s) => s.at)).toEqual([0, 400 * MS, 800 * MS]);
    expect(loadBaseOf(h, 800 * MS)?.at).toBe(0);
    h = pushLoadSample(h, at(1_200 * MS));
    expect(h.map((s) => s.at)).toEqual([0, 400 * MS, 800 * MS, 1_200 * MS]);
    h = pushLoadSample(h, at(1_500 * MS));
    // 400 ms is the newest sample at least one window (1 s) older than 1.5 s.
    expect(h.map((s) => s.at)).toEqual([400 * MS, 800 * MS, 1_200 * MS, 1_500 * MS]);
    expect(loadBaseOf(h, 1_500 * MS)?.at).toBe(400 * MS);
    // The same instant replaces the last sample.
    expect(pushLoadSample(h, at(1_500 * MS)).map((s) => s.at)).toEqual([400 * MS, 800 * MS, 1_200 * MS, 1_500 * MS]);
    // A seek back in time starts over.
    expect(pushLoadSample(h, at(100 * MS)).map((s) => s.at)).toEqual([100 * MS]);
    expect(LOAD_WINDOW_NS).toBe(SEC);
  });

  it('derives a device once from its object: backlogs in port order and every port counter', () => {
    const r1 = router('r1', [
      serial('Se0/0/0', 'l1', { txBacklog: { depth: 2, frames: [frame(1, 1), frame(2, 2)] } }),
      port('Gi0/0', { role: 'routed', counters: { ...emptyCounters(), outBytes: 77 } }),
      serial('Se0/0/1', 'l2', { txBacklog: { depth: 1, frames: [frame(3, 3)] } }),
    ]);
    const q = deriveDeviceQos(r1);
    expect(q.backlogs.map((b) => b.port)).toEqual(['Se0/0/0', 'Se0/0/1']);
    expect(q.ports.get('Gi0/0')).toEqual({ outBytes: 77 });
    expect(q.ports.get('Se0/0/0')).toEqual({ outBytes: 0, speedBps: 128_000 });
    let calls = 0;
    const counting = (d: DeviceSnapshot) => {
      calls++;
      return deriveDeviceQos(d);
    };
    buildQosOverlay(snapshot([r1]), {}, counting);
    expect(calls).toBe(1);
  });
});

// ── on a real P3 world (W7 qa, §10.2; §3.5 steps 2-5) ─────────────────────────

/** §3.5's world: PC-V and PC-D behind SW1 and R1 (marking voice EF at Gi0/0), R1 ⇄ R2 on 128 kb/s serial, PC-S. */
function section35World(): Simulation {
  const cfg = (sections: readonly (readonly string[])[]): string => [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
  const pc = (name: string, ip: string, gw: string): string =>
    cfg([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${gw}`]]);
  const access = (p: string): string[] => [`interface ${p}`, ' switchport mode access', ' spanning-tree portfast'];
  const sim = createSimulation({ seed: 27, profile: 'P3' });
  sim.addDevice({ id: 'pcv', type: 'pc.nfpc', name: 'PC-V', startupConfig: pc('PC-V', '192.168.1.10', '192.168.1.1') });
  sim.addDevice({ id: 'pcd', type: 'pc.nfpc', name: 'PC-D', startupConfig: pc('PC-D', '192.168.1.20', '192.168.1.1') });
  sim.addDevice({ id: 'pcs', type: 'pc.nfpc', name: 'PC-S', startupConfig: pc('PC-S', '192.168.2.10', '192.168.2.1') });
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: cfg([['hostname SW1'], access('FastEthernet0/1'), access('FastEthernet0/2'), access('GigabitEthernet0/1')]),
  });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: cfg([
      ['hostname R1'],
      ['ip access-list extended VOICE-PORTS', ' permit udp any any range 16384 32767'],
      ['class-map match-all VOIP', ' match access-group name VOICE-PORTS'],
      ['policy-map MARK', ' class VOIP', '  set dscp ef'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' service-policy input MARK', ' no shutdown'],
      ['interface Serial0/0/0', ' ip address 10.0.0.1 255.255.255.252', ' clock rate 128000', ' no shutdown'],
      ['ip route 192.168.2.0 255.255.255.0 10.0.0.2'],
    ]),
  });
  sim.addDevice({
    id: 'r2',
    type: 'router.nf2911',
    name: 'R2',
    startupConfig: cfg([
      ['hostname R2'],
      ['interface Serial0/0/0', ' ip address 10.0.0.2 255.255.255.252', ' no shutdown'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
      ['ip route 192.168.1.0 255.255.255.0 10.0.0.1'],
    ]),
  });
  sim.addLink({ id: 'lv', a: { device: 'pcv', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ id: 'ld', a: { device: 'pcd', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'lu', a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ id: 'wan', a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce' });
  sim.addLink({ id: 'ls', a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'pcs', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  // warm the ARP caches on both flows' paths, so no datagram of a flow waits for a resolution
  shell(sim, 'pcv', 'ping 192.168.2.10');
  shell(sim, 'pcd', 'ping 192.168.2.10');
  sim.runFor(15 * SEC);
  return sim;
}

/** One host-shell line in a fresh console session; its output, the job's lines included. */
function shell(sim: Simulation, device: string, line: string): string {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  return (r.output + job.map((e) => e.text).join('')).trim();
}

describe('on a real P3 world: §3.5 voice (EF) and data (BE) over the 128 kb/s serial link', () => {
  const VOICE = /> 192\.168\.2\.10:16384 /;
  const DATA = /> 192\.168\.2\.10:9 /;

  it('stacks the frames waiting at R1 Se0/0/0, lettered from the DSCP the engine lists, and fills the R1 → R2 sleeve', () => {
    const sim = section35World();
    // an uncongested world: no port holds a backlog, so nothing is stacked
    expect(buildQosOverlay(sim.snapshot()).stacks).toEqual([]);

    // §3.5 step 2: 24 kb/s of voice and 200 kb/s of data offered to a 128 kb/s line
    expect(shell(sim, 'pcv', 'flow start 192.168.2.10 pps 50 size 60 port 16384 count 250')).toMatch(/^Flow f\d+ started/);
    expect(shell(sim, 'pcd', 'flow start 192.168.2.10 rate 200 size 1000 count 125')).toMatch(/^Flow f\d+ started/);
    sim.runFor(2 * SEC);
    const base = loadSampleOf(sim.snapshot());
    sim.runFor(1 * SEC);
    const snap = sim.snapshot();
    const model = buildQosOverlay(snap, { base });

    // one stack: R1's egress onto the serial cable, at its 'a' end
    expect(model.stacks.map((s) => [s.device, s.port, s.link, s.end])).toEqual([['r1', 'Serial0/0/0', 'wan', 'a']]);
    const stack = model.stacks[0]!;
    const backlog = snap.devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === 'Serial0/0/0')!.txBacklog!;
    expect(stack.depth).toBe(backlog.depth);
    expect(stack.depth).toBeGreaterThan(QOS_STACK_MAX);
    expect(stack.capsules).toHaveLength(QOS_STACK_MAX);
    expect(stack.more).toBe(stack.depth - QOS_STACK_MAX);
    expect(stack.moreLabel).toBe(`+${stack.depth - QOS_STACK_MAX}`);
    // in txStart order, and exactly the frames (and DSCP values) the snapshot lists
    for (let i = 1; i < stack.capsules.length; i++) expect(stack.capsules[i]!.txStart).toBeGreaterThanOrEqual(stack.capsules[i - 1]!.txStart);
    const listed = [...backlog.frames].sort((x, y) => x.txStart - y.txStart).map((f) => [f.pdu, f.dscp, f.summary.summary]);
    expect(stack.capsules.map((c) => [c.pdu, c.dscp, c.summary])).toEqual(listed);
    // the letters: R1 marked the voice datagrams EF on the way in; the data stays best effort
    for (const c of stack.capsules) {
      if (VOICE.test(c.summary)) expect([c.letter, c.dscp, c.dscpName], c.summary).toEqual(['EF', 46, 'EF (46)']);
      else {
        expect(c.summary).toMatch(DATA);
        expect([c.letter, c.dscp, c.dscpName], c.summary).toEqual(['BE', 0, 'BE (0)']);
      }
    }
    expect(new Set(stack.capsules.map((c) => c.letter))).toEqual(new Set(['EF', 'BE']));

    // the saturated 128 kb/s direction reads 1.0; the way back and every LAN cable stay low
    const wan = model.sleeves.filter((s) => s.link === 'wan');
    expect(wan.find((s) => s.from === 'a')).toEqual({
      link: 'wan',
      from: 'a',
      device: 'r1',
      port: 'Serial0/0/0',
      fraction: 1,
      width: LOAD_SLEEVE_MAX_WIDTH,
      label: '100 %',
      level: 'err',
    });
    expect(wan.find((s) => s.from === 'b')?.level).toBe('ok');
    for (const s of model.sleeves.filter((x) => x.link !== 'wan')) expect(s.level, `${s.link} ${s.from}`).toBe('ok');
  }, 60_000);
});
