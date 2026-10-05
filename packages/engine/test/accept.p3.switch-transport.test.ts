/**
 * P3 acceptance — the dormant switch transport, D22 on the P3 catalog (ARCHITECTURE-P3 D22, D19, D21, §3.7, §3.8,
 * §4.3, §7 W4 step 1, §10.1 row `accept.p3.switch-transport`).
 *
 * Worlds are built by `test/p3-flip.world.ts`: on `staged.world` at stage P3 with every approved P3 daemon registered
 * until the W4 catalog flip, on the real (flipped) catalog after it. Every line is typed through `Simulation.configure`
 * (the CLI validator, W2/W3 grammar), as a learner's GUI or console would.
 *
 *  1. The D22 guard world of the P2 golden (`guard-switch-svi`: an NF-C2960 whose Vlan1 192.168.1.2/24 is up, an
 *     NF-2911 serving DHCP on that VLAN, two DHCP PCs), built in profile P3 and driven by the golden's fixed script
 *     (boot 60 s; the PCs' `ip address dhcp`; 30 s; R1's `traceroute` to the SVI and PC1's browser fetch of
 *     `http://<SVI>/`; 20 s; `show ip dhcp binding`; 600 s), answers exactly as the P2 golden: the typed results equal
 *     the golden's `guard-switch-svi/P2` entry, and the golden's own guard facts (`guardProblems`) hold — every DHCP
 *     DISCOVER and REQUEST dies in ipv4 as `unsupported-protocol`, ICMP 3/2 for the traceroute's datagrams and the
 *     fetch's SYN, the traceroute stops on `!2`, the fetch fails on protocol unreachable — with no udp or tcp delivery
 *     and no `sockets` row on the switch.
 *  2. `ntp server` on the switch (R1 `ntp master`) wakes it: a unicast datagram to a closed port draws 3/3, a SYN draws
 *     a RST, and the NTP exchange works (SW1 synchronised to R1 at R1's stratum + 1, its `clock` row from ntp).
 *  3. `restconf` + `ip http secure-server` (with a privilege-15 user and `ip http authentication local`) and
 *     `no ntp server`: still awake, and the API answers PC1's `rest GET` with 200 and the interfaces JSON, logged in
 *     `restconf-log`.
 *  4. Removing the last such line (`no restconf`) restores 3/2, and the switch's `sockets` table empties.
 * The world's copy of the guard document is proved equal to the golden harness's own (its export, on the real catalog).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ClockRow, NtpPeerRow, RestconfLogRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { NTP_MASTER_DEFAULT_STRATUM } from '../src/protocols/ntp.js';
import { createSimulation } from '../src/sim/simulation.js';
import { GUARD_SVI, GUARD_WORLDS, guardProblems, p2Worlds, type TypedResult, type WorldRun } from './p2-digests.harness.js';
import { createP3Simulation, p3WorldSource, startupText } from './p3-flip.world.js';

// ── the guard world (a copy of test/p2-digests.harness.ts `guardDocument`, proved equal below) ─────────────────────

const GUARD_SEED = 22;
const R1_ADDRESS = '192.168.1.1';

/** The guard document of the P2 golden, in profile P2 (schema 1.2) or P3 (schema 1.3). */
function guardDocument(profile: 'P2' | 'P3'): Topology {
  const at = (x: number, y: number): { logical: [number, number] } => ({ logical: [x, y] });
  return {
    schema: profile === 'P3' ? TOPOLOGY_SCHEMA_ID_1_3 : TOPOLOGY_SCHEMA_ID_1_2,
    seed: GUARD_SEED,
    devices: [
      {
        id: 'r1', type: 'router.nf2911', name: 'R1', position: at(500, 120), power: true,
        config: startupText([
          ['hostname R1'],
          ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
          ['ip dhcp excluded-address 192.168.1.1 192.168.1.10'],
          ['ip dhcp pool GUARD', ' network 192.168.1.0 255.255.255.0', ' default-router 192.168.1.1'],
        ]),
      },
      {
        id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: at(300, 220), power: true,
        config: startupText([['hostname SW1'], ['interface Vlan1', ` ip address ${GUARD_SVI} 255.255.255.0`, ' no shutdown'], ['ip default-gateway 192.168.1.1']]),
      },
      { id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: at(100, 340), power: true, config: startupText([['hostname PC1']]) },
      { id: 'pc2', type: 'pc.nfpc', name: 'PC2', position: at(300, 400), power: true, config: startupText([['hostname PC2']]) },
    ],
    links: [
      { id: 'l_pc1_sw1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' }, media: 'auto', length_m: 3 },
      { id: 'l_pc2_sw1', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' }, media: 'auto', length_m: 3 },
      { id: 'l_r1_sw1', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' }, media: 'auto', length_m: 3 },
    ],
    profile,
  };
}

/** The golden's fixed script (test/p2-digests.harness.ts): boot, settle after the setup, probes, then the long run. */
const BOOT_NS = 60 * SEC;
const SETTLE_NS = 30 * SEC;
const PROBE_NS = 20 * SEC;
const RUN_NS = 600 * SEC;

/** The golden's typed results of `guard-switch-svi/P2` (read from the golden file itself). */
function goldenGuardTyped(): readonly TypedResult[] {
  const file = JSON.parse(readFileSync(new URL('./goldens/p2-profile-digests.json', import.meta.url), 'utf8')) as {
    worlds: Record<string, { typed: readonly TypedResult[]; profile: string }>;
  };
  const entry = file.worlds[GUARD_WORLDS.P2];
  if (entry === undefined) throw new Error(`the P2 golden has no ${GUARD_WORLDS.P2} entry`);
  expect(entry.profile).toBe('P2');
  return entry.typed;
}

/** A console line on a fresh session of `device`; the CliResult as JSON (the golden's form). */
function typeFresh(sim: Simulation, device: DeviceId, name: string, line: string): { typed: TypedResult; session: SessionId } {
  const session = sim.cli.open(device, 'console');
  const result = sim.cli.exec(session, line);
  return { typed: { device: name, line, result: JSON.parse(JSON.stringify(result)) as unknown }, session };
}

/** The P3 guard world driven by the golden's script; what `guardProblems` reads, plus the live simulation. */
function guardRunP3(): { sim: Simulation; run: WorldRun; typed: TypedResult[]; events: TraceEvent[] } {
  const sim = createP3Simulation({ seed: GUARD_SEED });
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  sim.loadTopology(guardDocument('P3'));
  sim.runFor(BOOT_NS);
  for (const pc of ['pc1', 'pc2']) expect(sim.configure(pc, ['ip address dhcp']).ok, pc).toBe(true);
  sim.runFor(SETTLE_NS);
  const trace = typeFresh(sim, 'r1', 'R1', `traceroute ${GUARD_SVI}`);
  const url = `http://${GUARD_SVI}/`;
  const ticket = JSON.parse(JSON.stringify(sim.hostRequest('pc1', { app: 'http.get', url }))) as Record<string, unknown>;
  sim.runFor(PROBE_NS);
  const tabs = (sim.device('pc1')!.processes.get('http-client')!.stateSnapshot().state['tabs'] ?? {}) as Record<string, unknown>;
  const tab = JSON.parse(JSON.stringify(tabs[String(ticket['requestId'])] ?? {})) as unknown;
  const typed: TypedResult[] = [trace.typed, { device: 'PC1', line: `browse ${url}`, result: { ticket, tab } }];
  typed.push(typeFresh(sim, 'r1', 'R1', 'show ip dhcp binding').typed);
  sim.runFor(RUN_NS);
  let report = '';
  for (const ev of events) if (ev.kind === 'cliOutput' && ev.session === trace.session) report += ev.text;
  const ids = new Map<string, DeviceId>();
  for (const d of sim.devices()) ids.set(d.spec.name, d.id);
  // the members `guardProblems` reads (ids, events, the traceroute report, the typed fetch); the digests are not ours
  const run = { events, reports: [report, ''], ids, entry: { typed } } as unknown as WorldRun;
  return { sim, run, typed, events };
}

// ── the switch's answers (the probes of the seam test, ip.switch-transport) ─────────────────────────────────────

/** Events of `fn` and the `runNs` after it. */
function during(sim: Simulation, fn: () => void, runNs = 20 * SEC): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(runNs);
  return sim.trace(cursor).events;
}

/** R1 traceroutes to the SVI (UDP datagrams to closed ports) and PC1's browser fetches `http://<SVI>/` (a SYN to 80). */
function probe(sim: Simulation): TraceEvent[] {
  return during(sim, () => {
    const session = sim.cli.open('r1', 'console');
    sim.cli.exec(session, `traceroute ${GUARD_SVI}`);
    sim.hostRequest('pc1', { app: 'http.get', url: `http://${GUARD_SVI}/` });
  });
}

/** What SW1 did with the probes: the ICMP errors it created (by code word and transport), RSTs, transport activity, drops. */
function switchAnswers(evs: readonly TraceEvent[]) {
  const created = evs.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'sw1');
  const icmp = (word: string, proto: 'udp' | 'tcp'): number =>
    created.filter((e) => e.process === 'icmpv4' && e.pdu.summary === `ICMP destination unreachable (${word})` && (e.pdu.flow ?? '').endsWith(`:${proto}`)).length;
  const transport = evs.filter((e) => (e.kind === 'pduCreated' || e.kind === 'pduConsumed') && e.device === 'sw1' && (e.process === 'udp' || e.process === 'tcp'));
  const drops = evs
    .filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => {
      if (e.kind !== 'drop' || e.device !== 'sw1') return false;
      const layers = e.pdu.layers ?? [e.pdu.proto];
      return layers.includes('udp') || layers.includes('tcp');
    })
    .map((e) => `${e.reason}|${e.detail ?? ''}`);
  return {
    protoUdp: icmp('protocol', 'udp'),
    protoTcp: icmp('protocol', 'tcp'),
    portUdp: icmp('port', 'udp'),
    // a segment's summary carries its flag letters in brackets (pdu/codecs/tcp.ts: F S R P A U E C)
    rst: created.filter((e) => e.process === 'tcp' && /\[[A-Z]*R[A-Z]*\]/.test(e.pdu.summary)).length,
    tcpCreated: created.filter((e) => e.process === 'tcp').length,
    transport: transport.length,
    drops: Array.from(new Set(drops)).sort(),
  };
}

/** Dormant: protocol unreachable for the datagrams and the SYN, nothing handed to udp or tcp. */
function expectDormant(evs: readonly TraceEvent[], what: string): void {
  const a = switchAnswers(evs);
  expect(a.protoUdp, `${what}: 3/2 per traceroute datagram`).toBeGreaterThanOrEqual(3);
  expect(a.protoTcp, `${what}: 3/2 for the SYN`).toBeGreaterThanOrEqual(1);
  expect({ portUdp: a.portUdp, tcpCreated: a.tcpCreated, transport: a.transport }, what).toEqual({ portUdp: 0, tcpCreated: 0, transport: 0 });
  expect(a.drops, what).toEqual(['unsupported-protocol|ip protocol 17 has no listener', 'unsupported-protocol|ip protocol 6 has no listener']);
}

/** Awake: port unreachable for the datagrams, a RST for the SYN, never protocol unreachable. */
function expectAwake(evs: readonly TraceEvent[], what: string): void {
  const a = switchAnswers(evs);
  expect(a.protoUdp + a.protoTcp, `${what}: no 3/2`).toBe(0);
  expect(a.portUdp, `${what}: 3/3 per traceroute datagram`).toBeGreaterThanOrEqual(3);
  expect(a.tcpCreated, `${what}: the SYN draws a segment`).toBeGreaterThanOrEqual(1);
  expect(a.rst, `${what}: a RST`).toBeGreaterThanOrEqual(1);
  expect(a.transport, what).toBeGreaterThan(0);
  expect(a.drops, what).toContain('unsupported-protocol|tcp port 80 closed');
  expect(a.drops.some((d) => /^unsupported-protocol\|udp port \d+ closed$/.test(d)), what).toBe(true);
  expect(a.drops.filter((d) => d.includes('has no listener')), what).toEqual([]);
}

/** `configure` that must succeed line by line. */
function configureOk(sim: Simulation, device: DeviceId, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${device}: ${lines.join(' / ')}`).toEqual([]);
}

const sockets = (sim: Simulation): SocketRow[] => sim.device('sw1')!.tables.get<SocketRow>('sockets')?.rows() ?? [];

/** A job typed on a fresh console of `device`, and the session's output after `runNs`. */
function job(sim: Simulation, device: DeviceId, line: string, runNs = 10 * SEC): string {
  const session = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(session, line);
  expect(r.error, `${line}: ${r.output}`).toBeUndefined();
  sim.runFor(runNs);
  let text = r.output;
  for (const ev of sim.trace(cursor).events) if (ev.kind === 'cliOutput' && ev.session === session) text += ev.text;
  return text;
}

const PASSWORD = 'Lab-Pass1';
const REST_URL = `https://${GUARD_SVI}/restconf/data/ietf-interfaces:interfaces`;

describe('accept P3 switch-transport (D22) on the P3 catalog', () => {
  it('the copy of the guard document is the golden harness\'s own world', () => {
    const harness = p2Worlds().find((w) => w.name === GUARD_WORLDS.P2);
    expect(harness).toBeDefined();
    const theirs = harness!.build();
    const ours = createSimulation({ seed: GUARD_SEED });
    ours.loadTopology(guardDocument('P2'));
    expect(ours.exportTopology()).toEqual(theirs.exportTopology());
    expect(ours.profile).toBe('P2');
  });

  it(`the guard world built in P3 answers exactly as the P2 golden, then wakes on ntp server and restconf and sleeps again (source: ${p3WorldSource()})`, () => {
    // 1. dormant, exactly the P2 golden's answers
    const { sim, run, typed, events } = guardRunP3();
    expect(sim.profile).toBe('P3');
    expect(sim.now).toBe(BOOT_NS + SETTLE_NS + PROBE_NS + RUN_NS);
    const sw = sim.device('sw1')!;
    expect(sw.model.processes).toEqual(expect.arrayContaining(['udp', 'tcp', 'ntp', 'restconf']));
    expect(sw.processes.has('cdp'), 'P3 profile: CDP runs on the switch').toBe(true);
    expect(guardProblems(run)).toEqual([]);
    expect(typed).toEqual(goldenGuardTyped());
    expect(events.filter((e) => (e.kind === 'pduCreated' || e.kind === 'pduConsumed') && e.device === 'sw1' && (e.process === 'udp' || e.process === 'tcp'))).toEqual([]);
    expect(events.filter((e) => e.kind === 'tableWrite' && e.device === 'sw1' && e.table === 'sockets')).toEqual([]);
    expect(sockets(sim)).toEqual([]);
    expectDormant(probe(sim), 'the P3 guard world');

    // 2. `ntp server` wakes it; the NTP exchange works
    configureOk(sim, 'r1', ['ntp master']);
    configureOk(sim, 'sw1', [`ntp server ${R1_ADDRESS}`]);
    sim.runFor(10 * SEC);
    const peer = sw.tables.get<NtpPeerRow>('ntp-peers')!.get(R1_ADDRESS);
    expect(peer, 'the ntp-peers row').toBeDefined();
    expect(peer!.reach).toBeGreaterThan(0);
    expect(peer!.stratum).toBe(NTP_MASTER_DEFAULT_STRATUM);
    expect(peer!.selected).toBe('sys-peer');
    const clock = sw.tables.get<ClockRow>('clock')!.get('clock');
    expect(clock).toMatchObject({ source: 'ntp', stratum: NTP_MASTER_DEFAULT_STRATUM + 1, reference: R1_ADDRESS });
    // the exchange went through the switch's udp: its NTP socket, and R1's answer delivered to it
    expect(sockets(sim).some((s) => s.proto === 'udp' && s.localPort === 123 && s.owner === 'ntp')).toBe(true);
    expectAwake(probe(sim), 'after ntp server');

    // 3. restconf + ip http secure-server; `no ntp server` leaves it awake; the API answers
    configureOk(sim, 'sw1', [`username admin privilege 15 secret ${PASSWORD}`, 'ip http secure-server', 'ip http authentication local', 'restconf']);
    configureOk(sim, 'sw1', [`no ntp server ${R1_ADDRESS}`]);
    sim.runFor(1 * SEC);
    expect(sw.running.render()).not.toContain('ntp server');
    expect(sockets(sim).some((s) => s.proto === 'tcp' && s.localPort === 443 && s.state === 'LISTEN' && s.owner === 'restconf')).toBe(true);
    expectAwake(probe(sim), 'with restconf only');
    const out = job(sim, 'pc1', `rest GET ${REST_URL} -u admin:${PASSWORD}`);
    expect(out).toMatch(/^HTTP\/1\.1 200 /m);
    expect(out).toContain('"ietf-interfaces:interfaces"');
    const pc1Address = sim.device('pc1')!.portView('GigabitEthernet0')!.l3?.ipv4?.address;
    const log = sw.tables.get<RestconfLogRow>('restconf-log')!.rows();
    expect(log.map((r) => ({ method: r.method, path: r.path, status: r.status, client: r.client, user: r.user }))).toEqual([
      { method: 'GET', path: '/restconf/data/ietf-interfaces:interfaces', status: 200, client: pc1Address, user: 'admin' },
    ]);

    // 4. removing the last such line restores 3/2
    configureOk(sim, 'sw1', ['no restconf']);
    sim.runFor(2 * 30 * SEC + 10 * SEC);
    expectDormant(probe(sim), 'after the last service line was removed');
    expect(sockets(sim)).toEqual([]);
  }, 120_000);
});
