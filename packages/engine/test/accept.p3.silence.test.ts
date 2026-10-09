/**
 * P3 acceptance — the silence rule (ARCHITECTURE-P3 §0 rules 5 and 14, D2, D14, D22, §4.3, §4.6, §7 W4 step 1,
 * §10.1 row `accept.p3.silence`).
 *
 * Worlds are built by `test/p3-flip.world.ts` on the real (flipped) catalog (the W4 flip deleted its pre-flip
 * `staged.world` branch, ruling R47), so this file is the flip's silence proof (rule 14: `accept.p2.silence` builds on
 * the P2-stage catalog and proves nothing about the flip).
 *
 *  (a) Every template and CCNA 1 lab (P1 profile) and every CCNA 2 lab (P2 profile), loaded as the worker's
 *      `loadScenario` loads them, booted 60 s, the reference solution applied, then 600 s: no `pduCreated`,
 *      `pduConsumed`, `tableWrite`, `tableExpire`, `log` or `debug` event attributable to `ospf, acl, cdp, lldp, ntp,
 *      restconf, traffic` or to the approved `ppp, gre, vty, vty-client, logger, syslog-server, eigrp, ike`, including
 *      `sockets` rows they would own; no write on a P3 table (descriptor `since: 'P3'`); no drop with a P3 reason; no
 *      PDU of a P3 protocol anywhere (so no IP-protocol-89, -88 or -50 PDU, no UDP-500 PDU, no `frameTx` of a CDP or
 *      LLDP frame); no join of 224.0.0.5, 224.0.0.6 or 224.0.0.10; no `frameQueued`; no `configChange` carrying an
 *      `origin`; no P3-only mutation (`QosMark`, `Encrypt`, `Decrypt`); no log line of a P3 path (a P3 facility or a
 *      mnemonic, which only P3 log sites set) and no "Process … is not available"; no udp or tcp delivery on a
 *      managed switch whose transport is dormant (D22; `ccna2-switch-management`, whose switch holds `line vty`,
 *      included); and the tcp StateView of every router holding `line vty` byte-identical to the P2 engine's — the
 *      engine the P2 golden was recorded from, i.e. the same world run on `staged.world` at stage P2 (D14: [S13]'s
 *      hidden listeners stay out of it). No shipped world puts `line vty` on a router, so two synthetic guard worlds
 *      (profile P1 and P2: a router and a managed switch holding `line vty`, TCP aimed at both) are added to (a); without
 *      them that clause would measure nothing.
 *      The same worlds and script are also compared at the scheduler (the W4b fix step, finding 5): the step()-level
 *      SimEvent stream (every dispatched event: time, kind, device, port, process, timer key; `seq` left out) on the
 *      real catalog equals the P2 engine's event for event, so no P1/P2 world gains a timer the trace cannot show (an
 *      idle eigrp `resync` armed by the P2 profile's `no ip routing` replay on a multilayer switch was the case).
 *  (b) A blank P3 world (NF-2911, NF-C2960, two PCs), 600 s: the only P3-daemon PDUs are CDP frames, all background;
 *      each one that reached a PC was dropped `not-for-me` with `background: true`; no other new PDU — every PDU that
 *      is not a CDP frame is the same (device, process, tag, summary) as in the same world in the P2 profile. Two
 *      variants: nothing configured (the router's port stays shut, so only the switch speaks), and the router port up
 *      with the PCs addressed (router and switch become CDP neighbours).
 *  (c) `cdp run` typed on R1 and SW1 in the same world in the P2 profile: the CDP neighbour rows that appear equal (b)'s
 *      row for row (every column but the times).
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { SimEvent } from '../src/contracts/events.js';
import type { DeviceId, ProcessName } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS, type CdpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { dormantTransportEligible } from '../src/protocols/ip-upper.js';
import { CCNA1_LABS, CCNA2_LABS, SCENARIO_SEED, TEMPLATES } from '../src/sim/scenarios.js';
import { configText, device, link, section, topology } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP3Simulation, loadScenarioP3, P3_SILENCE_DAEMONS } from './p3-flip.world.js';
import { ofKind } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

// ── what counts as P3 ───────────────────────────────────────────────────────────────────────────────────────────

const isP3Daemon = (name: unknown): boolean => P3_SILENCE_DAEMONS.includes(name as ProcessName);

/** Tables whose descriptor is `since: 'P3'` (read at call time, rule 12). */
const p3Tables = (): Set<string> => new Set(Object.values(TABLE_DESCRIPTORS).filter((d) => d.since === 'P3').map((d) => d.name as string));

/** Drop reasons P3 emits first (contracts/link.ts: 'acl-deny' exists since P0 but is first emitted in P3). */
const P3_DROP_REASONS: readonly string[] = ['acl-deny', 'dhcp-snooping', 'arp-inspection', 'mtu-exceeded', 'policed', 'ipsec-no-sa'];

/**
 * Wire protocols only P3 code speaks (contracts/pdu.ts ProtoName, P3 block). `ospf` is IP protocol 89, `eigrp` 88,
 * `esp` 50 and `ikev2` UDP 500; `cdp` and `lldp` are the discovery frames.
 */
const P3_PROTOS: readonly string[] = [
  'ospf', 'ospf-lsa', 'cdp', 'lldp', 'ntp', 'telnet', 'ssh', 'gre', 'ppp', 'lcp', 'pap', 'chap', 'ipcp', 'ipv6cp', 'syslog', 'eigrp', 'esp', 'ikev2',
];
/** Frame tags only P3 daemons set. */
const P3_TAG_PREFIXES: readonly string[] = ['cdp', 'lldp', 'ospf', 'ntp', 'traffic', 'eigrp', 'ike', 'esp', 'gre', 'ppp', 'lcp', 'chap', 'pap', 'ipcp', 'syslog', 'restconf', 'telnet', 'ssh'];

/** Debug categories of the P3 daemons and of eth-switch's snooping and DAI messages (§5.8, binding). */
const P3_DEBUG_CATEGORIES: readonly string[] = [
  'ip ospf adj', 'ip ospf hello', 'ip ospf flood', 'ip ospf spf', 'ip ospf packet', 'ip access-list', 'ip dhcp snooping', 'ip arp inspection',
  'cdp packets', 'cdp events', 'lldp packets', 'ntp packets', 'ntp events', 'restconf', 'traffic', 'ip ssh', 'telnet', 'tunnel',
  'ppp negotiation', 'ppp authentication', 'syslog', 'script', 'eigrp packets', 'eigrp fsm', 'crypto ikev2',
];
/** State machines added by P3 (contracts/process.ts FsmMachine, P3 block). */
const P3_FSM_MACHINES: readonly string[] = ['ospf-if', 'ospf-nbr', 'ntp', 'tunnel', 'ppp-lcp', 'ppp-auth', 'ppp-ncp', 'eigrp-nbr', 'eigrp-route', 'ike'];
/** Log facilities of the P3 daemons and the snooping/DAI paths (the extended-logging facilities carry a mnemonic). */
const P3_LOG_FACILITIES: readonly string[] = ['OSPF', 'ACL', 'EIGRP', 'TUNNEL', 'IKE', 'DAI', 'PPP', 'VTY', 'NTP', 'CDP', 'LLDP', 'RESTCONF', 'SYSLOG', 'DHCP_SNOOPING'];
/** Mutation reasons only P3 records (QosMark, D16; Encrypt and Decrypt are first recorded by [C13]). */
const P3_MUTATIONS: readonly string[] = ['QosMark', 'Encrypt', 'Decrypt'];
/** The multicast groups of OSPF (AllSPFRouters, AllDRouters) and [C1] EIGRP. */
const P3_GROUPS: readonly string[] = ['224.0.0.5', '224.0.0.6', '224.0.0.10'];

/**
 * The same facts read from a summary whose payload no codec decoded: the IPv4 summary names its protocol
 * (`proto=89`, pdu/codecs/ipv4.ts) and the UDP summary its ports (`a:500 > b:500`, pdu/codecs/udp.ts).
 */
const P3_IP_PROTOCOL_SUMMARY = /\bproto=(88|89|50)\b/;
const UDP_500_SUMMARY = /^UDP \S*:500 > |^UDP \S* > \S*:500\b/;

const layersOf = (pdu: { proto: string; layers?: readonly string[] }): readonly string[] => pdu.layers ?? [pdu.proto];
const carriesP3 = (pdu: { proto: string; layers?: readonly string[]; tag?: string; summary?: string }): boolean =>
  layersOf(pdu).some((l) => P3_PROTOS.includes(l)) ||
  P3_PROTOS.includes(pdu.proto) ||
  P3_TAG_PREFIXES.some((p) => (pdu.tag ?? '') === p || (pdu.tag ?? '').startsWith(`${p}-`)) ||
  P3_IP_PROTOCOL_SUMMARY.test(pdu.summary ?? '') ||
  UDP_500_SUMMARY.test(pdu.summary ?? '');

/**
 * Every event of `evs` attributable to P3 (the row's list), as readable lines; empty = silence. `dormant` holds the
 * devices whose udp/tcp come only from the `managed-switch` row (D22): any udp or tcp activity there is a delivery.
 */
function p3Attributable(evs: readonly TraceEvent[], dormant: ReadonlySet<string>): string[] {
  const tables = p3Tables();
  const out: string[] = [];
  const at = (e: TraceEvent): string => String(e.t);
  for (const e of evs) {
    switch (e.kind) {
      case 'pduCreated':
      case 'pduConsumed':
        if (isP3Daemon(e.process)) out.push(`${at(e)} ${e.kind} ${e.device}/${e.process} ${e.pdu.tag ?? e.pdu.proto}: ${e.pdu.summary}`);
        else if (carriesP3(e.pdu)) out.push(`${at(e)} ${e.kind} ${e.device}/${e.process} carries P3: ${layersOf(e.pdu).join('/')} ${e.pdu.tag ?? ''}`);
        if (dormant.has(e.device) && (e.process === 'udp' || e.process === 'tcp')) out.push(`${at(e)} ${e.kind} ${e.device}/${e.process}: transport delivery on a dormant switch: ${e.pdu.summary}`);
        break;
      case 'frameTx':
      case 'frameRx':
        if (carriesP3(e.pdu)) out.push(`${at(e)} ${e.kind} ${e.pdu.tag ?? e.pdu.proto}: ${layersOf(e.pdu).join('/')} ${e.pdu.summary}`);
        break;
      case 'tableWrite':
      case 'tableExpire':
        if (tables.has(e.table)) out.push(`${at(e)} ${e.kind} ${e.device} ${e.table} ${e.key}`);
        if (e.table === 'sockets' && isP3Daemon(e.row['owner'])) out.push(`${at(e)} ${e.kind} ${e.device} sockets ${e.key} owned by ${String(e.row['owner'])}`);
        if (e.table === 'sockets' && dormant.has(e.device)) out.push(`${at(e)} ${e.kind} ${e.device} sockets ${e.key} on a dormant switch`);
        break;
      case 'debug': {
        const d = e.event;
        if (isP3Daemon(d.process)) out.push(`${at(e)} debug ${d.device}/${d.process} [${d.category ?? ''}] ${d.message}`);
        else if (P3_DEBUG_CATEGORIES.includes(d.category ?? '')) out.push(`${at(e)} debug ${d.device}/${d.process} P3 category [${d.category ?? ''}] ${d.message}`);
        else if (d.fsm !== undefined && P3_FSM_MACHINES.includes(d.fsm.machine)) out.push(`${at(e)} debug ${d.device}/${d.process} P3 machine ${d.fsm.machine} ${d.fsm.subject}`);
        const group = (d.data as Record<string, unknown> | undefined)?.['group'];
        if (P3_GROUPS.includes(String(group)) || P3_GROUPS.some((g) => d.message.includes(`group ${g} `))) out.push(`${at(e)} debug ${d.device}/${d.process} joins ${String(group)}: ${d.message}`);
        if (dormant.has(d.device) && (d.process === 'udp' || d.process === 'tcp')) out.push(`${at(e)} debug ${d.device}/${d.process} on a dormant switch: ${d.message}`);
        break;
      }
      case 'log':
        if (P3_LOG_FACILITIES.includes(e.facility) || e.mnemonic !== undefined || e.message.includes('is not available')) out.push(`${at(e)} log ${e.device} ${e.facility}${e.mnemonic === undefined ? '' : `-${e.mnemonic}`}: ${e.message}`);
        break;
      case 'drop':
        if (P3_DROP_REASONS.includes(e.reason)) out.push(`${at(e)} drop ${e.device ?? e.link ?? '?'} ${e.reason} ${e.detail ?? ''}`);
        else if (carriesP3(e.pdu)) out.push(`${at(e)} drop of a P3 PDU ${e.pdu.tag ?? e.pdu.proto} at ${e.device ?? e.link ?? '?'}: ${e.reason}`);
        break;
      case 'frameQueued':
        out.push(`${at(e)} frameQueued ${e.device} ${e.port} ${e.queue}`);
        break;
      case 'configChange':
        if ('origin' in e) out.push(`${at(e)} configChange ${e.device} with origin ${JSON.stringify(e.origin)}: ${e.line}`);
        break;
      case 'mutation':
        if (P3_MUTATIONS.includes(e.mutation.reason)) out.push(`${at(e)} mutation ${e.mutation.device} ${e.mutation.reason} ${e.mutation.field}`);
        break;
      default:
        break;
    }
  }
  return out;
}

// ── running a world ─────────────────────────────────────────────────────────────────────────────────────────────

/** §10.1: the P1 and P2 worlds are watched for 600 s after the script. */
const WINDOW_NS = 600 * SEC;
/** Every model of a template or lab is up by then (routers 45 s, data-centre switches 60 s). */
const BOOT_NS = 60 * SEC;
/** When the guard worlds' fetches start, into the window (the P2 digest script's 30 s settle). */
const PROBE_AT_NS = 30 * SEC;
/** Wall-clock budget of one world (two runs when it holds a router with `line vty`). */
const WORLD_TIMEOUT_MS = 240_000;

/** Device id of a topology name. */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this world`);
}

/** One world of (a): how it is built, its setup lines (per device name) and its probes (browser fetches). */
interface SilenceWorld {
  readonly name: string;
  readonly profile: DefaultsProfile;
  /** The world on the P3 catalog (the flip's source). */
  build(): Simulation;
  /** The same world on the P2-stage catalog: the engine the P2 golden was recorded from. */
  buildP2Engine(): Simulation;
  readonly setup: Readonly<Record<string, readonly string[]>>;
  readonly browse: readonly (readonly [device: string, url: string])[];
}

/** A scenario as the worker loads it, on the P2-stage catalog (`staged.world` at stage P2 is the real P2 catalog). */
function loadScenarioP2Engine(sc: ScenarioInfo): Simulation {
  const sim = createStagedSimulation({ seed: sc.seed ?? SCENARIO_SEED, stage: 'P2' });
  const topo = sc.build();
  sim.loadTopology((sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo);
  for (const f of sc.faults ?? []) sim.injectFault(f.at, f.fault);
  return sim;
}

function scenarioWorld(sc: ScenarioInfo): SilenceWorld {
  return {
    name: sc.name,
    profile: sc.category === 'ccna2-lab' ? 'P2' : 'P1',
    build: () => loadScenarioP3(sc),
    buildP2Engine: () => loadScenarioP2Engine(sc),
    setup: sc.solution ?? {},
    browse: [],
  };
}

/** Seed of the synthetic `line vty` guard worlds. */
const VTY_GUARD_SEED = 14;

/**
 * The synthetic guard (D14, D22): R1 (NF-2911, Gi0/0 192.168.1.1/24) holding `line vty 0 4` with a line password and
 * `login` — telnet is allowed, so [S13] opens a hidden listener on it — and SW1 (NF-C2960, Vlan1 192.168.1.2/24)
 * holding `line vty 0 4` with `login local` and a local user (only P1 lines: its transport stays dormant), PC1 and PC2.
 * At 90 s PC1 fetches `http://192.168.1.1/` (R1's tcp answers port 80) and PC2 `http://192.168.1.2/` (the dormant SVI).
 */
function vtyGuardDocument(profile: 'P1' | 'P2'): Topology {
  const r1 = configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', ['ip address 192.168.1.1 255.255.255.0', 'no shutdown']),
    section('line vty 0 4', ['password NetF0rge', 'login']),
  ]);
  const sw1 = configText([
    ['hostname SW1'],
    ['username admin secret NetF0rge'],
    section('interface Vlan1', ['ip address 192.168.1.2 255.255.255.0', 'no shutdown']),
    ['ip default-gateway 192.168.1.1'],
    section('line vty 0 4', ['login local']),
  ]);
  return topology(
    VTY_GUARD_SEED,
    [
      device('r1', 'router.nf2911', 'R1', 400, 100, r1),
      device('sw1', 'switch.nfc2960', 'SW1', 300, 220, sw1),
      device('pc1', 'pc.nfpc', 'PC1', 150, 340, pcConfig('PC1', '192.168.1.10', '255.255.255.0', '192.168.1.1')),
      device('pc2', 'pc.nfpc', 'PC2', 450, 340, pcConfig('PC2', '192.168.1.11', '255.255.255.0', '192.168.1.1')),
    ],
    [
      link('l_r1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
      link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
    ],
    [],
    '',
    { profile },
  );
}

function vtyGuardWorld(profile: 'P1' | 'P2'): SilenceWorld {
  const load = (sim: Simulation): Simulation => {
    sim.loadTopology(vtyGuardDocument(profile));
    return sim;
  };
  return {
    name: `guard-line-vty/${profile}`,
    profile,
    build: () => load(createP3Simulation({ seed: VTY_GUARD_SEED })),
    buildP2Engine: () => load(createStagedSimulation({ seed: VTY_GUARD_SEED, stage: 'P2' })),
    setup: {},
    browse: [['PC1', 'http://192.168.1.1/'], ['PC2', 'http://192.168.1.2/']],
  };
}

/** What one scripted run left behind. */
interface WorldRun {
  readonly sim: Simulation;
  readonly events: TraceEvent[];
  readonly refused: string[];
}

/** Boot 60 s, the setup lines, the browser fetches, then the 600 s window; every event collected through `onTrace`. */
function runScript(sim: Simulation, w: SilenceWorld): WorldRun {
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  sim.runFor(BOOT_NS);
  const refused: string[] = [];
  for (const [name, lines] of Object.entries(w.setup)) {
    const r = sim.configure(idOf(sim, name), lines);
    for (const l of r.lines) if (!l.ok) refused.push(`${name}: ${l.line}: ${l.error?.message ?? l.output}`);
  }
  if (w.browse.length === 0) {
    sim.runFor(WINDOW_NS);
  } else {
    // the fetches start 30 s into the window, once spanning tree forwards on every port of a P2 world
    sim.runFor(PROBE_AT_NS);
    for (const [name, url] of w.browse) sim.hostRequest(idOf(sim, name), { app: 'http.get', url });
    sim.runFor(WINDOW_NS - PROBE_AT_NS);
  }
  return { sim, events, refused };
}

/** One dispatched scheduler event without its `seq`: time, kind, device, port, process and timer key. */
function stepKey(e: SimEvent): string {
  const x = e as unknown as Record<string, unknown>;
  const field = (k: string): string => (x[k] === undefined ? '-' : String(x[k]));
  return `${e.at} ${e.kind} ${field('device')} ${field('port')} ${field('process')} ${field('key')}`;
}

/** `runUntil(t)` one `step()` at a time (the same dispatches as `runFor`), each dispatched event appended to `out`. */
function stepUntil(sim: Simulation, t: number, out: string[]): void {
  for (let next = sim.nextEventTime(); next !== undefined && next <= t; next = sim.nextEventTime()) {
    const e = sim.step();
    if (e === undefined) break;
    out.push(stepKey(e));
  }
  sim.runUntil(t);
}

/** `runScript` at the scheduler: the same boot, setup lines, fetches and window, returning every dispatched event. */
function stepScript(sim: Simulation, w: SilenceWorld): string[] {
  const out: string[] = [];
  stepUntil(sim, sim.now + BOOT_NS, out);
  for (const [name, lines] of Object.entries(w.setup)) sim.configure(idOf(sim, name), lines);
  if (w.browse.length === 0) {
    stepUntil(sim, sim.now + WINDOW_NS, out);
  } else {
    stepUntil(sim, sim.now + PROBE_AT_NS, out);
    for (const [name, url] of w.browse) sim.hostRequest(idOf(sim, name), { app: 'http.get', url });
    stepUntil(sim, sim.now + WINDOW_NS - PROBE_AT_NS, out);
  }
  return out;
}

/** Devices whose udp and tcp come only from the `managed-switch` row (D22's dormant transport). */
function dormantSwitches(sim: Simulation): Set<string> {
  return new Set(sim.devices().filter((d) => dormantTransportEligible(d.model, 'udp') || dormantTransportEligible(d.model, 'tcp')).map((d) => d.id));
}

/** Routing devices whose running configuration holds a `line vty` section. */
function vtyRouters(sim: Simulation): DeviceId[] {
  return sim.devices().filter((d) => d.model.capabilities.includes('routing') && /(^|\n)line vty /.test(d.running.render())).map((d) => d.id);
}

/** The tcp StateView of a device, as JSON (byte comparison). */
const tcpView = (sim: Simulation, id: DeviceId): string => JSON.stringify(sim.device(id)!.processes.get('tcp')!.stateSnapshot());

/** Joined groups of every device (the ipv4 StateView's `groups`), as `device port group` lines. */
function joinedP3Groups(sim: Simulation): string[] {
  const out: string[] = [];
  for (const d of sim.devices()) {
    const groups = (d.processes.get('ipv4')?.stateSnapshot().state['groups'] ?? {}) as Record<string, readonly { group: string }[]>;
    for (const [port, list] of Object.entries(groups)) for (const g of list) if (P3_GROUPS.includes(g.group)) out.push(`${d.id} ${port} ${g.group}`);
  }
  return out;
}

// ── (a) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('accept P3 silence (a): every template, CCNA 1 lab and CCNA 2 lab stays silent on the P3 catalog', () => {
  const worlds: SilenceWorld[] = [...TEMPLATES, ...CCNA1_LABS, ...CCNA2_LABS].map(scenarioWorld);
  worlds.push(vtyGuardWorld('P1'), vtyGuardWorld('P2'));

  it(`covers every template and CCNA 1 lab (P1), every CCNA 2 lab (P2) and the two line-vty guards; on the real catalog`, () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(9);
    expect(CCNA1_LABS.length).toBeGreaterThanOrEqual(15);
    expect(CCNA2_LABS.length).toBeGreaterThanOrEqual(20);
    expect([...TEMPLATES, ...CCNA1_LABS].every((s) => s.category === 'template' || s.category === 'ccna1-lab')).toBe(true);
    expect(CCNA2_LABS.every((s) => s.category === 'ccna2-lab')).toBe(true);
    expect(worlds).toHaveLength(TEMPLATES.length + CCNA1_LABS.length + CCNA2_LABS.length + 2);
    // the attribution list is exactly the row's
    expect([...P3_SILENCE_DAEMONS]).toEqual(['ospf', 'acl', 'cdp', 'lldp', 'ntp', 'restconf', 'traffic', 'ppp', 'gre', 'vty', 'vty-client', 'logger', 'syslog-server', 'eigrp', 'ike']);
  });

  for (const w of worlds) {
    it(`${w.name}: 600 s in the ${w.profile} profile without a P3 event, table write, drop reason, protocol, join or transport delivery`, () => {
      const { sim, events, refused } = runScript(w.build(), w);
      expect(refused, 'the reference solution was accepted').toEqual([]);
      expect(sim.profile).toBe(w.profile);
      expect(sim.now).toBe(BOOT_NS + WINDOW_NS);
      // the world really ran, and the P3 daemons really are installed where the catalog puts them
      expect(ofKind(events, 'pduCreated').length).toBeGreaterThan(0);
      const installed = new Set<ProcessName>();
      for (const d of sim.devices()) for (const p of d.processes.keys()) if (isP3Daemon(p)) installed.add(p);
      expect(installed.size, 'P3 daemons run in this world').toBeGreaterThan(0);
      expect(installed.has('traffic') && installed.has('vty-client'), 'every host runs traffic and vty-client').toBe(true);

      const dormant = dormantSwitches(sim);
      expect(p3Attributable(events, dormant)).toEqual([]);
      expect(joinedP3Groups(sim)).toEqual([]);
      for (const id of dormant) {
        expect(sim.device(id)!.tables.get('sockets')?.rows() ?? [], `${id}: no sockets row on a dormant switch`).toEqual([]);
      }

      // D14: the tcp StateView of every router holding `line vty` is the P2 engine's, byte for byte
      const routers = vtyRouters(sim);
      if (routers.length > 0) {
        const twin = runScript(w.buildP2Engine(), w);
        expect(twin.refused).toEqual([]);
        expect(vtyRouters(twin.sim)).toEqual(routers);
        for (const id of routers) expect(tcpView(sim, id), `${w.name} ${id}`).toBe(tcpView(twin.sim, id));
      }
      if (w.name.startsWith('guard-line-vty/')) {
        // the guard is not vacuous: R1 holds line vty and runs vty, SW1 is a dormant switch holding line vty, and both
        // were sent TCP (R1 answered with a RST, SW1 with protocol unreachable)
        expect(routers).toEqual(['r1']);
        expect(sim.device('r1')!.processes.get('vty')!.stateSnapshot().state['listening'], 'the hidden telnet listener is open').toEqual(['telnet']);
        expect([...dormant]).toEqual(['sw1']);
        expect(sim.device('sw1')!.running.render()).toMatch(/\nline vty 0 4\n login local\n/);
        expect(ofKind(events, 'pduCreated').filter((e) => e.device === 'r1' && e.process === 'tcp').length).toBeGreaterThan(0);
        expect(ofKind(events, 'drop').filter((e) => e.device === 'sw1' && e.reason === 'unsupported-protocol' && e.pdu.proto === 'tcp').length).toBeGreaterThan(0);
      }
    }, WORLD_TIMEOUT_MS);
  }

  for (const w of worlds) {
    it(`${w.name}: the scheduler dispatches exactly the P2 engine's events (no timer the trace cannot show)`, () => {
      const real = stepScript(w.build(), w);
      const p2Engine = stepScript(w.buildP2Engine(), w);
      expect(real.length, 'the world really ran').toBeGreaterThan(0);
      const firstDiff = real.findIndex((k, i) => k !== p2Engine[i]);
      expect(firstDiff === -1 ? undefined : `${real[firstDiff]} | P2 engine: ${p2Engine[firstDiff] ?? 'none'}`).toBeUndefined();
      expect(real).toEqual(p2Engine);
    }, WORLD_TIMEOUT_MS);
  }

  it('ccna2-switch-management keeps a dormant switch that holds line vty', () => {
    const sc = CCNA2_LABS.find((s) => s.name === 'ccna2-switch-management');
    expect(sc).toBeDefined();
    const sim = loadScenarioP3(sc!);
    sim.runFor(BOOT_NS);
    for (const [name, lines] of Object.entries(sc!.solution ?? {})) expect(sim.configure(idOf(sim, name), lines).ok, name).toBe(true);
    const dormant = dormantSwitches(sim);
    const holders = [...dormant].filter((id) => /(^|\n)line vty /.test(sim.device(id)!.running.render()));
    expect(holders.length, 'a dormant switch with line vty').toBeGreaterThan(0);
  });
});

// ── (b) and (c) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The blank world: R1 (NF-2911) on SW1 (NF-C2960) Gi0/1, PC1 and PC2 on Fa0/1 and Fa0/2. */
function blankWorld(profile: DefaultsProfile, configured: boolean): { sim: Simulation; events: TraceEvent[] } {
  const sim = createP3Simulation({ seed: 3, profile });
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  const r1 = configured ? configText([['hostname R1'], section('interface GigabitEthernet0/0', ['ip address 10.0.0.1 255.255.255.0', 'no shutdown'])]) : undefined;
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', ...(r1 === undefined ? {} : { startupConfig: r1 }) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  for (const n of [1, 2]) {
    const startupConfig = configured ? pcConfig(`PC${n}`, `10.0.0.${10 + n}`, '255.255.255.0', '10.0.0.1') : undefined;
    sim.addDevice({ id: `pc${n}`, type: 'pc.nfpc', name: `PC${n}`, ...(startupConfig === undefined ? {} : { startupConfig }) });
  }
  sim.addLink({ id: 'l_r1', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  return { sim, events };
}

const isCdpFrame = (pdu: { proto: string; layers?: readonly string[]; tag?: string }): boolean => pdu.tag === 'cdp' && layersOf(pdu).includes('cdp');

/** Every PDU created that is not a CDP frame, time-free: `device/process tag summary`. */
const nonCdpPdus = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'pduCreated').filter((e) => !isCdpFrame(e.pdu)).map((e) => `${e.device}/${e.process} ${e.pdu.tag ?? ''} ${e.pdu.summary}`);

/** A device's CDP rows without their times (`updatedAt`, `expiresAt`), key order. */
function cdpRows(sim: Simulation, id: DeviceId): Record<string, unknown>[] {
  const rows = sim.device(id)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? [];
  return rows.map((r) => {
    const { updatedAt: _u, expiresAt: _e, ...rest } = r as CdpNeighbourRow & Record<string, unknown>;
    return rest;
  }).sort((a, b) => String(a['key']).localeCompare(String(b['key'])));
}

describe('accept P3 silence (b): a blank P3 world sends CDP and nothing else new', () => {
  for (const configured of [false, true]) {
    const variant = configured ? 'the router port up and the PCs addressed' : 'nothing configured';
    it(`${variant}: CDP frames (background) are the only P3-daemon PDUs; the PCs drop each one not-for-me; nothing else is new`, () => {
      const { sim, events } = blankWorld('P3', configured);
      sim.runFor(WINDOW_NS);
      expect(sim.profile).toBe('P3');
      for (const id of ['r1', 'sw1']) expect(sim.device(id)!.processes.has('cdp'), id).toBe(true);

      const created = ofKind(events, 'pduCreated');
      const byP3 = created.filter((e) => isP3Daemon(e.process));
      expect(byP3.length).toBeGreaterThan(0);
      expect(byP3.filter((e) => !(e.process === 'cdp' && isCdpFrame(e.pdu))).map((e) => `${e.device}/${e.process} ${e.pdu.tag ?? ''}`)).toEqual([]);
      // no other P3 protocol on the wire, from any daemon
      expect(created.filter((e) => carriesP3(e.pdu) && !isCdpFrame(e.pdu)).map((e) => `${e.device}/${e.process} ${layersOf(e.pdu).join('/')}`)).toEqual([]);
      const cdpTx = ofKind(events, 'frameTx').filter((e) => isCdpFrame(e.pdu));
      expect(cdpTx.length).toBeGreaterThan(0);
      expect(cdpTx.every((e) => e.background === true)).toBe(true);
      // the switch speaks in both variants; the router only once its port is up
      expect(new Set(byP3.map((e) => e.device))).toEqual(new Set(configured ? ['r1', 'sw1'] : ['sw1']));
      // every CDP frame a PC received was dropped there, not-for-me and background
      for (const pc of ['pc1', 'pc2']) {
        const received = ofKind(events, 'frameRx').filter((e) => e.device === pc && isCdpFrame(e.pdu));
        const dropped = ofKind(events, 'drop').filter((e) => e.device === pc && isCdpFrame(e.pdu));
        expect(received.length, pc).toBeGreaterThan(0);
        expect(dropped.length, pc).toBe(received.length);
        expect(dropped.every((e) => e.reason === 'not-for-me' && e.background === true), pc).toBe(true);
      }
      // nothing else new: the same world in the P2 profile creates exactly the other PDUs
      const p2 = blankWorld('P2', configured);
      p2.sim.runFor(WINDOW_NS);
      expect(ofKind(p2.events, 'pduCreated').filter((e) => isCdpFrame(e.pdu))).toEqual([]);
      expect(nonCdpPdus(events)).toEqual(nonCdpPdus(p2.events));
      expect(ofKind(events, 'log').filter((e) => e.message.includes('is not available'))).toEqual([]);
      // the detector of (a) is not blind: this P3 world's CDP traffic and rows are exactly what it attributes
      const caught = p3Attributable(events, dormantSwitches(sim));
      expect(caught.some((l) => l.includes(' pduCreated sw1/cdp cdp'))).toBe(true);
      expect(caught.some((l) => l.includes(' frameTx cdp'))).toBe(true);
      if (configured) expect(caught.some((l) => l.includes(' tableWrite sw1 cdp-neighbours '))).toBe(true);
      if (configured) {
        expect(cdpRows(sim, 'r1').map((r) => r['deviceId'])).toEqual(['SW1']);
        expect(cdpRows(sim, 'sw1').map((r) => r['deviceId'])).toEqual(['R1']);
      } else {
        for (const id of ['r1', 'sw1']) expect(cdpRows(sim, id), id).toEqual([]);
      }
    }, 120_000);
  }
});

describe('accept P3 silence (c): cdp run typed in a P2 world', () => {
  it('on R1 and SW1: the CDP neighbours appear exactly as in (b)', () => {
    const p3 = blankWorld('P3', true);
    p3.sim.runFor(WINDOW_NS);
    const p2 = blankWorld('P2', true);
    p2.sim.runFor(BOOT_NS);
    for (const id of ['r1', 'sw1']) expect(cdpRows(p2.sim, id), `${id} before cdp run`).toEqual([]);
    expect(ofKind(p2.events, 'pduCreated').filter((e) => e.process === 'cdp')).toEqual([]);
    for (const id of ['r1', 'sw1']) {
      const session = p2.sim.cli.open(id, 'console');
      for (const line of ['enable', 'configure terminal', 'cdp run', 'end']) {
        const r = p2.sim.cli.exec(session, line);
        expect(r.error, `${id}: ${line}: ${r.output}`).toBeUndefined();
      }
      expect(p2.sim.device(id)!.running.render().split('\n')).toContain('cdp run');
    }
    p2.sim.runFor(WINDOW_NS);
    expect(p2.sim.profile).toBe('P2');
    for (const id of ['r1', 'sw1']) {
      expect(cdpRows(p2.sim, id).length, id).toBeGreaterThan(0);
      expect(cdpRows(p2.sim, id), id).toEqual(cdpRows(p3.sim, id));
    }
  }, 120_000);
});
