/**
 * P2 acceptance — a lightweight AP joins its controller and a laptop reaches its gateway through it
 * (ARCHITECTURE-P2 §10.1 `accept.p2.wlc`; §3.12; §5.3; §7 W7 qa).
 *
 * The whole §10.1 row, on the REAL catalog (`createSimulation({ seed, profile: 'P2' })`, no registry overlay, no test
 * models): NF-WLC-9800 (`wlc.nfwlc9800`), NF-AP-1832 (`ap.nfap-lw`, lightweight), NF-C2960, NF-2911 and a laptop.
 *
 *   WLC1 Gi0/1 ── SW1 Gi0/1   (SW1: `switchport mode trunk`; the controller does not negotiate)
 *   LAP1 Gi0   ── SW1 Fa0/2   (access VLAN 99, the AP management VLAN; nothing configured on LAP1: the P2 profile
 *                              replays `capwap enable` and `ip address dhcp` on Vlan1)
 *   R1 Gi0/0   ── SW1 Fa0/3   (VLAN 20: 192.168.20.1, the clients' gateway, DHCP pool STAFF)
 *   R1 Gi0/1   ── SW1 Fa0/4   (VLAN 99: 192.168.99.1, DHCP pool APS)
 *   LAPTOP1                   (WLAN LabNet, wpa2-psk, address by DHCP) next to LAP1
 *   WLC1 Gi0/2 ── SW2 Gi0/1   (the second controller port cabled to a second switch, a trunk too)
 *   PC2 Gi0    ── SW2 Fa0/1   (VLAN 20, 192.168.20.50: the same subnet as the laptop, behind the backup port)
 *
 * WLC1 is configured after its boot exactly as the controller panel's Interfaces and WLANs pages write it (§3.12,
 * §5.3, §5.5): the canonical indented lines through `Simulation.configure` with the panel's options, so the
 * controller's own handlers maintain the SVIs and the default gateway.
 *
 * One scenario (built once, read by the cases, re-run for the determinism case): boot, configure WLC1, settle, the
 * laptop pings its gateway, PC2 pings the same gateway, then WLC1 is powered off and the world runs to idle. Asserted,
 * clause by clause of the row:
 *   • the LAP gets a lease, then discovery → dtls → join → configure → data-check → run with the RFC 5415 message
 *     types (rows on both sides: `capwap` on the AP, `capwap-aps` on the controller);
 *   • every control message after the DTLS step carries `meta.protected` (and none before it);
 *   • the laptop associates to LabNet through the LAP, gets a VLAN 20 address and pings its gateway 5/5;
 *   • the `wlan-clients` row exists before the first downlink frame for the laptop;
 *   • a laptop → gateway frame keeps one PduId end to end; its provenance shows station framing, the AP's tunnel
 *     encapsulation and the controller's decapsulation plus VLAN tag; no `pduConsumed` for it before the gateway;
 *   • the passphrase appears in no PDU byte and no snapshot;
 *   • with a second controller port cabled to a second switch, no frame and no BPDU crosses between the two switches
 *     through the controller;
 *   • 3 runs byte-identical;
 *   • with the WLC powered off `runToIdle` still terminates.
 */
import { describe, expect, it } from 'vitest';
import type { MacAddress } from '../src/contracts/addr.js';
import type { ConfigureOptions, ConfigureResult } from '../src/contracts/cli.js';
import type { DeviceId, PduId } from '../src/contracts/ids.js';
import { CAPWAP_MSG } from '../src/contracts/pdu.js';
import type { RunStats, Simulation } from '../src/contracts/simulation.js';
import type { CapwapApRow, CapwapRow, StpBridgeRow, WlanClientRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CAUSE_CAPWAP_TUNNEL, CAUSE_CONTROLLER_BRIDGING, CAUSE_STATION_FRAMING, passphraseTag } from '../src/link/rewrap80211.js';
import { CAPWAP_DTLS_CAUSE } from '../src/protocols/capwap-wtp.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createSimulation } from '../src/sim/simulation.js';

// ── the §3.12 world ─────────────────────────────────────────────────────────────────────────────────────────────

const SEED = 20_260_928;
const M24 = '255.255.255.0';
const SSID = 'LabNet';
const PASSPHRASE = 'Secret123';
const WLC_MGMT = '192.168.99.5';
const AP_GW = '192.168.99.1';
const GW20 = '192.168.20.1';
const AP_ADDR = '192.168.99.20';
const LAPTOP_ADDR = '192.168.20.10';
const PC2_ADDR = '192.168.20.50';
const DIST1 = 'GigabitEthernet0/1';
const DIST2 = 'GigabitEthernet0/2';

/** The controller panel's `configure` options (apps/web gui/commands.ts PANEL_CONFIGURE_OPTIONS.nfos). */
const PANEL_OPTIONS: ConfigureOptions = { indentation: true, stopOnError: true, atomic: true };

/** WLC1's configuration as the Interfaces and WLANs pages write it (§3.12, §5.3). */
const WLC_PANEL_LINES: readonly string[] = [
  'wlc-interface management',
  ' vlan 99',
  ` address ${WLC_MGMT} ${M24}`,
  ` gateway ${AP_GW}`,
  'wlc-interface STAFF-IF',
  ' vlan 20',
  ` address 192.168.20.5 ${M24}`,
  ` gateway ${GW20}`,
  ` dhcp-server ${GW20}`,
  `wlan 1 STAFF ${SSID}`,
  ' security wpa2-psk',
  ` passphrase ${PASSPHRASE}`,
  ' interface STAFF-IF',
  ' no shutdown',
];

/** The controller's boot (20 s) is over: the panel can write to it. */
const CONFIGURE_AT = 30 * SEC;
/** R1 boots (45 s), SW1's trunk forwards (link-up + 30 s), the AP's lease and join, the laptop's handshake and lease. */
const SETTLE = 150 * SEC;
/** One ping (5 echoes, 2 s timeout each). */
const PING_NS = 15 * SEC;
/** Cap of every `runToIdle` here: far above what an idle world needs, so reaching it means it never idled. */
const IDLE_CAP = 500_000;

/** Devices on SW1's side of the controller, and on SW2's. */
const SIDE_SW1: readonly DeviceId[] = ['sw1', 'lap1', 'r1', 'lt1'];
const SIDE_SW2: readonly DeviceId[] = ['sw2', 'pc2'];

function world(seed: number): Simulation {
  const sim = createSimulation({ seed, profile: 'P2' });
  sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 100, y: 100 } });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 300, y: 100 },
    startupConfig: configText([
      ['hostname SW1'],
      ['vlan 20'],
      ['vlan 99'],
      section('interface GigabitEthernet0/1', ['switchport mode trunk']),
      section('interface FastEthernet0/2', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
      section('interface FastEthernet0/3', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
      section('interface FastEthernet0/4', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
    ]),
  });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 300, y: 300 },
    startupConfig: configText([
      ['hostname R1'],
      ['ip dhcp excluded-address 192.168.99.1 192.168.99.19'],
      ['ip dhcp excluded-address 192.168.20.1 192.168.20.9'],
      section('ip dhcp pool APS', [`network 192.168.99.0 ${M24}`, `default-router ${AP_GW}`]),
      section('ip dhcp pool STAFF', [`network 192.168.20.0 ${M24}`, `default-router ${GW20}`]),
      section('interface GigabitEthernet0/0', [`ip address ${GW20} ${M24}`, 'no shutdown']),
      section('interface GigabitEthernet0/1', [`ip address ${AP_GW} ${M24}`, 'no shutdown']),
    ]),
  });
  sim.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1', position: { x: 500, y: 100 } });
  sim.addDevice({
    id: 'lt1', type: 'laptop.nflaptop', name: 'LAPTOP1', position: { x: 540, y: 100 },
    startupConfig: configText([['hostname LAPTOP1'], section('interface Wlan0', ['ip address dhcp', `ssid ${SSID}`, 'security wpa2-psk', `passphrase ${PASSPHRASE}`])]),
  });
  sim.addDevice({
    id: 'sw2', type: 'switch.nfc2960', name: 'SW2', position: { x: 100, y: 300 },
    startupConfig: configText([
      ['hostname SW2'],
      ['vlan 20'],
      ['vlan 99'],
      section('interface GigabitEthernet0/1', ['switchport mode trunk']),
      section('interface FastEthernet0/1', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
    ]),
  });
  sim.addDevice({
    id: 'pc2', type: 'pc.nfpc', name: 'PC2', position: { x: 100, y: 500 },
    startupConfig: configText([['hostname PC2'], section('interface GigabitEthernet0', [`ip address ${PC2_ADDR} ${M24}`]), [`ip default-gateway ${GW20}`]]),
  });
  sim.addLink({ id: 'l_wlc_sw1', a: { device: 'wlc1', port: DIST1 }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ id: 'l_wlc_sw2', a: { device: 'wlc1', port: DIST2 }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ id: 'l_lap', a: { device: 'lap1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'l_r1_20', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  sim.addLink({ id: 'l_r1_99', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'FastEthernet0/4' } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: 'FastEthernet0/1' } });
  return sim;
}

// ── the scenario ────────────────────────────────────────────────────────────────────────────────────────────────

interface Scenario {
  readonly sim: Simulation;
  readonly configured: ConfigureResult;
  /** Every event up to the power-off (the whole trace is retained: `dropped` is checked). */
  readonly main: TraceEvent[];
  /** Cursor where the laptop's ping starts, and where PC2's starts. */
  readonly laptopPingAt: number;
  readonly pc2PingAt: number;
  readonly laptopPing: string;
  readonly pc2Ping: string;
  /** The laptop's `wlan-clients` row as it was when the controller sent each tunnelled frame, by PDU id (first leg). */
  readonly rowAtTunnel: ReadonlyMap<PduId, WlanClientRow | undefined>;
  /**
   * State read before the power-off: the AP's `capwap` rows, the controller's `capwap-aps` rows, its two SVIs and its
   * running configuration, each switch's `stp-bridge` rows, the AP's and the laptop's addresses, the laptop's radio.
   */
  readonly apRows: readonly CapwapRow[];
  readonly controllerRows: readonly CapwapApRow[];
  readonly svis: Readonly<Record<string, unknown>>;
  readonly wlcRunning: string;
  readonly stpRows: Readonly<Record<'sw1' | 'sw2', readonly StpBridgeRow[]>>;
  readonly apLease: unknown;
  readonly laptopLease: unknown;
  readonly laptopRadio: unknown;
  /** Snapshot and StateView JSON of the live world, taken before the power-off. */
  readonly liveSnapshot: string;
  readonly liveViews: string;
  /** `runToIdle` after WLC1 is powered off. */
  readonly poweredOff: RunStats;
  /** Trace and final snapshot JSON (the determinism case compares it). */
  readonly json: string;
}

/** Ping `target` from `device`'s console and run `PING_NS`; the session's output. */
function ping(sim: Simulation, device: DeviceId, target: string): string {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, `ping ${target}`);
  if (r.error !== undefined) throw new Error(`ping on ${device}: ${r.output}`);
  sim.runFor(PING_NS);
  let text = '';
  for (const e of sim.trace(cursor).events) if (e.kind === 'cliOutput' && e.session === session) text += e.text;
  return text;
}

function runScenario(seed: number): Scenario {
  const sim = world(seed);
  const wlc = sim.device('wlc1')!;
  const laptop = sim.device('lt1')!.port('Wlan0')!.mac;
  const rowAtTunnel = new Map<PduId, WlanClientRow | undefined>();
  const unsubscribe = sim.onTrace((e) => {
    if (e.kind !== 'frameTx' || e.from.device !== 'wlc1' || e.pdu.tunnel !== 'capwap' || rowAtTunnel.has(e.pdu.id)) return;
    const row = wlc.tables.get<WlanClientRow>('wlan-clients')?.get(laptop);
    rowAtTunnel.set(e.pdu.id, row === undefined ? undefined : { ...row });
  });

  sim.runFor(CONFIGURE_AT);
  const configured = sim.configure('wlc1', WLC_PANEL_LINES, PANEL_OPTIONS);
  sim.runFor(SETTLE);
  const laptopPingAt = sim.trace(0).next;
  const laptopPing = ping(sim, 'lt1', GW20);
  const pc2PingAt = sim.trace(0).next;
  const pc2Ping = ping(sim, 'pc2', GW20);
  unsubscribe();

  const whole = sim.trace(0);
  if (whole.dropped !== 0) throw new Error(`the trace ring dropped ${whole.dropped} events`);
  const main = whole.events;
  const apRows = JSON.parse(JSON.stringify(sim.device('lap1')!.tables.get<CapwapRow>('capwap')!.rows())) as CapwapRow[];
  const controllerRows = JSON.parse(JSON.stringify(wlc.tables.get<CapwapApRow>('capwap-aps')!.rows())) as CapwapApRow[];
  const svis = { Vlan99: wlc.portView('Vlan99')?.l3.ipv4, Vlan20: wlc.portView('Vlan20')?.l3.ipv4 };
  const wlcRunning = wlc.running.render();
  const stpOf = (sw: DeviceId): StpBridgeRow[] => JSON.parse(JSON.stringify(sim.device(sw)!.tables.get<StpBridgeRow>('stp-bridge')!.rows())) as StpBridgeRow[];
  const stpRows = { sw1: stpOf('sw1'), sw2: stpOf('sw2') };
  const apLease = { ...sim.device('lap1')!.port('Vlan1')!.l3.ipv4 };
  const laptopLease = { ...sim.device('lt1')!.port('Wlan0')!.l3.ipv4 };
  const radios = sim.device('lt1')!.processes.get('wlan-client')!.stateSnapshot().state as { ports: { port: string }[] };
  const laptopRadio = JSON.parse(JSON.stringify(radios.ports.find((p) => p.port === 'Wlan0'))) as unknown;
  const liveSnapshot = JSON.stringify(sim.snapshot());
  const liveViews = JSON.stringify(sim.devices().map((d) => [d.id, d.stateSnapshots()]));

  sim.setPower('wlc1', false);
  const poweredOff = sim.runToIdle(IDLE_CAP);
  const json = JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
  return { sim, configured, main, laptopPingAt, pc2PingAt, laptopPing, pc2Ping, rowAtTunnel, apRows, controllerRows, svis, wlcRunning, stpRows, apLease, laptopLease, laptopRadio, liveSnapshot, liveViews, poweredOff, json };
}

let cached: Scenario | undefined;
/** The scenario with `SEED`, run once and shared by the read-only cases. */
function scenario(): Scenario {
  cached ??= runScenario(SEED);
  return cached;
}

// ── trace helpers ───────────────────────────────────────────────────────────────────────────────────────────────

function ofKind<K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Extract<TraceEvent, { kind: K }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
}

/** Index in `evs` of the first event matching `pred` (-1 when none). */
function indexOf(evs: readonly TraceEvent[], pred: (e: TraceEvent) => boolean): number {
  return evs.findIndex(pred);
}

/** The CAPWAP state transitions of one device, in trace order, with their trace index. */
function transitions(evs: readonly TraceEvent[], device: DeviceId, machine: 'capwap-wtp' | 'capwap-ac') {
  const out: { i: number; t: number; subject: string; from: string; to: string; cause: string | undefined }[] = [];
  evs.forEach((e, i) => {
    if (e.kind !== 'debug' || e.event.device !== device || e.event.fsm?.machine !== machine) return;
    const f = e.event.fsm;
    out.push({ i, t: e.t, subject: f.subject, from: f.from, to: f.to, cause: f.cause });
  });
  return out;
}

/** The states written to one CAPWAP table of one device, in order, consecutive repeats collapsed. */
function rowStates(evs: readonly TraceEvent[], device: DeviceId, table: 'capwap' | 'capwap-aps'): string[] {
  const states = ofKind(evs, 'tableWrite')
    .filter((e) => e.device === device && e.table === table)
    .map((e) => (e.row as unknown as CapwapRow | CapwapApRow).state);
  return states.filter((s, i) => i === 0 || states[i - 1] !== s);
}

interface ControlMessage {
  readonly i: number;
  readonly device: DeviceId;
  readonly type: number;
  readonly id: PduId;
  readonly seq: number;
  readonly protected: boolean;
}

/** The CAPWAP control messages created in `evs` (the control channel: UDP 5246 both ways), in trace order. */
function controlMessages(sim: Simulation, evs: readonly TraceEvent[]): ControlMessage[] {
  const out: ControlMessage[] = [];
  evs.forEach((e, i) => {
    if (e.kind !== 'pduCreated' || e.pdu.proto !== 'capwap') return;
    const pdu = sim.pdu(e.pdu.id)!;
    const type = pdu.get('capwap.messageType');
    if (typeof type !== 'number') return;
    out.push({ i, device: e.device, type, id: e.pdu.id, seq: Number(pdu.get('capwap.seq')), protected: pdu.meta.protected === true });
  });
  return out;
}

/** The PDU a clone was made from, followed to the original. */
function rootOf(sim: Simulation, id: PduId): PduId {
  let at = id;
  for (let parent = sim.pdu(at)?.meta.parent; parent !== undefined; parent = sim.pdu(at)?.meta.parent) at = parent;
  return at;
}

/** Device that created each PDU (pduCreated). */
function creators(evs: readonly TraceEvent[]): Map<PduId, DeviceId> {
  const out = new Map<PduId, DeviceId>();
  for (const e of ofKind(evs, 'pduCreated')) out.set(e.pdu.id, e.device);
  return out;
}

const macOf = (sim: Simulation, device: DeviceId, port: string): MacAddress => sim.device(device)!.port(port)!.mac;

// ── the cases ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('P2 acceptance — the wireless controller on the real catalog (§3.12, §10.1 accept.p2.wlc)', () => {
  it('builds the world from the real catalog and configures WLC1 with the controller panel lines', () => {
    const { sim, configured, svis, wlcRunning } = scenario();
    expect(sim.profile).toBe('P2');
    expect(sim.device('wlc1')!.model.model).toBe('NF-WLC-9800');
    expect(sim.device('lap1')!.model.model).toBe('NF-AP-1832');
    expect(configured.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`)).toEqual([]);
    expect(configured.ok).toBe(true);
    // the controller's handlers maintained the SVIs and the management default gateway (§3.12, §5.3)
    expect(svis).toEqual({ Vlan99: { address: WLC_MGMT, prefixLen: 24 }, Vlan20: { address: '192.168.20.5', prefixLen: 24 } });
    expect(wlcRunning).toContain(`\nip default-gateway ${AP_GW}\n`);
  });

  it('the LAP gets a lease, then walks discovery → dtls → join → configure → data-check → run, with rows on both sides', () => {
    const { sim, main, apRows, controllerRows, apLease } = scenario();
    const apMac = macOf(sim, 'lap1', 'Vlan1');

    // the lease: the P2 profile's `ip address dhcp` on Vlan1, from R1's pool APS
    expect(apLease).toMatchObject({ address: AP_ADDR, prefixLen: 24, origin: 'dhcp' });
    const bound = indexOf(main, (e) => e.kind === 'debug' && e.event.device === 'lap1' && e.event.process === 'dhcp-client' && e.event.message.includes(`bound ${AP_ADDR}/24`));
    expect(bound).toBeGreaterThan(-1);

    // then the AP's state machine, in RFC 5415 order: nothing CAPWAP before the lease
    const wtp = transitions(main, 'lap1', 'capwap-wtp');
    expect(wtp[0]).toMatchObject({ from: 'idle', to: 'discovery' });
    expect(wtp[0]!.i).toBeGreaterThan(bound);
    expect(controlMessages(sim, main).filter((m) => m.device === 'lap1' && m.i < bound)).toEqual([]);
    expect(wtp.filter((t) => t.to !== 'idle').map((t) => t.to)).toEqual(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);
    const lane = wtp.filter((t) => t.subject === `controller ${WLC_MGMT}`);
    expect(lane.map((t) => [t.from, t.to])).toEqual([
      ['discovery', 'dtls'],
      ['dtls', 'join'],
      ['join', 'configure'],
      ['configure', 'data-check'],
      ['data-check', 'run'],
    ]);
    expect(lane[0]!.cause).toBe(CAPWAP_DTLS_CAUSE);

    // the controller's side, keyed by the AP's base MAC
    const ac = transitions(main, 'wlc1', 'capwap-ac');
    expect(ac.map((t) => [t.subject, t.from, t.to])).toEqual([
      [`access point ${apMac}`, 'idle', 'dtls'],
      [`access point ${apMac}`, 'dtls', 'join'],
      [`access point ${apMac}`, 'join', 'configure'],
      [`access point ${apMac}`, 'configure', 'data-check'],
      [`access point ${apMac}`, 'data-check', 'run'],
    ]);
    expect(ac[0]!.cause).toBe(CAPWAP_DTLS_CAUSE);

    // rows on both sides walk the same states
    expect(rowStates(main, 'lap1', 'capwap')).toEqual(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);
    expect(rowStates(main, 'wlc1', 'capwap-aps')).toEqual(['dtls', 'join', 'configure', 'data-check', 'run']);
    expect(apRows.map((r) => [r.key, r.controller, r.state, r.wlans])).toEqual([[WLC_MGMT, WLC_MGMT, 'run', 1]]);
    expect(controllerRows).toEqual([{ key: apMac, apMac, apIp: AP_ADDR, name: 'LAP1', state: 'run', clients: 1, updatedAt: expect.any(Number) }]);
  });

  it('exchanges the RFC 5415 message types in order on UDP 5246, each response answering its request', () => {
    const { sim, main } = scenario();
    const all = controlMessages(sim, main);
    // echoes are periodic keep-alives: every Echo Request of the AP is answered by one Echo Response of the controller
    const echoes = all.filter((m) => m.type === CAPWAP_MSG.echoReq || m.type === CAPWAP_MSG.echoResp);
    expect(echoes.filter((m) => m.type === CAPWAP_MSG.echoReq).length).toBeGreaterThanOrEqual(3);
    echoes.forEach((m, k) => {
      if (m.type === CAPWAP_MSG.echoReq) {
        expect(m.device).toBe('lap1');
        // answered before the next one leaves (only the very last request may still be in flight)
        if (k < echoes.length - 1) expect([echoes[k + 1]!.device, echoes[k + 1]!.type, echoes[k + 1]!.seq]).toEqual(['wlc1', CAPWAP_MSG.echoResp, m.seq]);
      } else {
        expect([m.device, echoes[k - 1]?.type]).toEqual(['wlc1', CAPWAP_MSG.echoReq]);
      }
    });
    // the rest, in order (a run of unanswered Discovery Requests collapsed to the one answered, its last): the join, then
    // the laptop's station report
    const rest = all.filter((m) => !echoes.includes(m));
    const collapsed = rest.filter((m, k) => !(m.type === CAPWAP_MSG.discoveryReq && rest[k + 1]?.type === CAPWAP_MSG.discoveryReq));
    expect(collapsed.map((m) => [m.device, m.type])).toEqual([
      ['lap1', CAPWAP_MSG.discoveryReq],
      ['wlc1', CAPWAP_MSG.discoveryResp],
      ['lap1', CAPWAP_MSG.joinReq],
      ['wlc1', CAPWAP_MSG.joinResp],
      ['lap1', CAPWAP_MSG.configStatusReq],
      ['wlc1', CAPWAP_MSG.configStatusResp],
      ['lap1', CAPWAP_MSG.changeStateReq],
      ['wlc1', CAPWAP_MSG.changeStateResp],
      ['wlc1', CAPWAP_MSG.wlanConfigReq],
      ['lap1', CAPWAP_MSG.wlanConfigResp],
      ['lap1', CAPWAP_MSG.wtpEventReq],
      ['wlc1', CAPWAP_MSG.wtpEventResp],
    ]);
    // every response carries its request's sequence number and reports success
    for (let k = 1; k < collapsed.length; k += 2) {
      const [req, resp] = [collapsed[k - 1]!, collapsed[k]!];
      expect([resp.type, resp.seq]).toEqual([resp.type, req.seq]);
      const result = sim.pdu(resp.id)!.get('capwap.resultCode');
      if (result !== undefined) expect([resp.type, result]).toEqual([resp.type, 0]);
    }
    // the control channel is UDP 5246 at both ends
    for (const m of all) {
      const udp = sim.pdu(m.id)!.layer('udp')!.fields;
      expect([m.type, udp.srcPort, udp.dstPort]).toEqual([m.type, 5246, 5246]);
    }
  });

  it('marks every control message after the DTLS step meta.protected, and none before it', () => {
    const { sim, main } = scenario();
    const dtls = (device: DeviceId, machine: 'capwap-wtp' | 'capwap-ac'): number => transitions(main, device, machine).find((t) => t.to === 'dtls')!.i;
    const step: Record<string, number> = { lap1: dtls('lap1', 'capwap-wtp'), wlc1: dtls('wlc1', 'capwap-ac') };
    const all = controlMessages(sim, main);
    const before = all.filter((m) => m.i < step[m.device]!);
    const after = all.filter((m) => m.i > step[m.device]!);
    expect(before.length + after.length).toBe(all.length);
    // before the step: the discovery exchange only, in clear
    expect(new Set(before.map((m) => m.type))).toEqual(new Set([CAPWAP_MSG.discoveryReq, CAPWAP_MSG.discoveryResp]));
    expect(before.filter((m) => m.protected)).toEqual([]);
    // after it: everything protected, from both sides
    expect(after.length).toBeGreaterThanOrEqual(12);
    expect(new Set(after.map((m) => m.device))).toEqual(new Set(['lap1', 'wlc1']));
    expect(after.filter((m) => !m.protected)).toEqual([]);
  });

  it('the laptop associates to LabNet through the LAP, leases a VLAN 20 address through the controller and pings its gateway 5/5', () => {
    const { sim, main, laptopPing, laptopLease, laptopRadio } = scenario();
    const laptop = macOf(sim, 'lt1', 'Wlan0');
    // associated to one of LAP1's radios
    const assoc = ofKind(main, 'assocState').filter((e) => e.station.device === 'lt1');
    const last = assoc[assoc.length - 1]!;
    expect(last).toMatchObject({ tech: 'wifi', state: 'associated', ap: { device: 'lap1' } });
    expect(last.bssid).toBe(macOf(sim, 'lap1', last.ap!.port));
    expect(laptopRadio).toMatchObject({ port: 'Wlan0', state: 'associated', ssid: SSID, bssid: last.bssid });
    // the controller learned it from the AP's station report, in the WLAN's interface VLAN
    const reported = ofKind(main, 'tableWrite').filter((e) => e.device === 'wlc1' && e.table === 'wlan-clients' && e.key === laptop);
    expect(reported.map((e) => e.row)).toEqual([
      { key: laptop, station: laptop, ap: macOf(sim, 'lap1', 'Vlan1'), bssid: last.bssid, wlanId: 1, ssid: SSID, vlan: 20, iface: 'STAFF-IF', state: 'associated', updatedAt: expect.any(Number) },
    ]);
    // a VLAN 20 address from R1's pool STAFF: the answer came from R1's VLAN 20 interface, through the controller
    expect(laptopLease).toMatchObject({ address: LAPTOP_ADDR, prefixLen: 24, origin: 'dhcp' });
    const ack = ofKind(main, 'pduConsumed').find((e) => e.device === 'lt1' && e.pdu.tag === 'dhcp-ack')!;
    expect(ack).toBeDefined();
    expect(ofKind(main, 'pduCreated').find((e) => e.pdu.id === ack.pdu.id)?.device).toBe('r1');
    expect(sim.pdu(ack.pdu.id)!.provenance.some((m) => m.device === 'wlc1' && m.cause === CAUSE_CONTROLLER_BRIDGING && m.field === 'capwap' && m.reason === 'Encapsulate')).toBe(true);
    // and pings its gateway 5/5
    expect(laptopPing).toContain('Sent 5, received 5, lost 0');
  });

  it('the wlan-clients row exists before the first downlink frame for the laptop', () => {
    const { sim, main, rowAtTunnel } = scenario();
    const laptop = macOf(sim, 'lt1', 'Wlan0');
    const write = indexOf(main, (e) => e.kind === 'tableWrite' && e.device === 'wlc1' && e.table === 'wlan-clients' && e.key === laptop);
    expect(write).toBeGreaterThan(-1);
    const reachedLaptop = new Set(ofKind(main, 'frameRx').filter((e) => e.device === 'lt1').map((e) => e.pdu.id));
    // the first frame the controller tunnelled toward the AP that reached the laptop (the downlink: controller → AP)
    const firstTunnelled = indexOf(main, (e) => e.kind === 'frameTx' && e.from.device === 'wlc1' && e.pdu.tunnel === 'capwap' && reachedLaptop.has(e.pdu.id));
    expect(firstTunnelled).toBeGreaterThan(write);
    const tunnelled = main[firstTunnelled] as Extract<TraceEvent, { kind: 'frameTx' }>;
    // the controller's table held the row at the instant it sent that frame
    expect(rowAtTunnel.get(tunnelled.pdu.id)).toMatchObject({ station: laptop, ap: macOf(sim, 'lap1', 'Vlan1'), vlan: 20, ssid: SSID, state: 'associated' });
    // and the first frame the AP put on the air for the laptop that the controller had bridged came later still
    const firstOnAir = indexOf(main, (e) => e.kind === 'frameTx' && e.medium === 'air' && e.from.device === 'lap1' && e.to.device === 'lt1'
      && (sim.pdu(e.pdu.id)?.provenance.some((m) => m.device === 'wlc1' && m.cause === CAUSE_CONTROLLER_BRIDGING) ?? false));
    expect(firstOnAir).toBeGreaterThan(firstTunnelled);
    // no tunnelled data frame at all left the controller before the row
    expect(ofKind(main.slice(0, write), 'frameTx').filter((e) => e.from.device === 'wlc1' && e.pdu.tunnel === 'capwap')).toEqual([]);
  });

  it('a laptop → gateway frame keeps one PduId end to end, framed by the station, tunnelled by the AP, bridged and tagged by the controller', () => {
    const { sim, main, laptopPingAt, pc2PingAt } = scenario();
    const evs = main.slice(laptopPingAt, pc2PingAt);
    const request = ofKind(evs, 'pduCreated').find((e) => e.device === 'lt1' && e.process === 'icmpv4')!.pdu.id;

    // one PduId from the laptop's radio to R1: every leg carries it, no copy of it was ever made
    const legs = ofKind(evs, 'frameTx').filter((e) => e.pdu.id === request);
    expect(legs.map((e) => [e.from.device, e.to.device])).toEqual([
      ['lt1', 'lap1'],
      ['lap1', 'sw1'],
      ['sw1', 'wlc1'],
      ['wlc1', 'sw1'],
      ['sw1', 'r1'],
    ]);
    expect(evs.filter((e) => (e.kind === 'frameTx' || e.kind === 'frameRx' || e.kind === 'pduCreated') && e.pdu.parent === request)).toEqual([]);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.id === request)).toEqual([]);
    // inside the tunnel on the AP's side, VLAN 20 tagged when the controller sends it on
    expect(legs.map((e) => e.pdu.tunnel)).toEqual([undefined, 'capwap', 'capwap', undefined, undefined]);
    expect(legs[3]!.pdu.vlan).toBe(20);

    // its provenance: station framing at the laptop, the AP's tunnel encapsulation, the controller's decapsulation and
    // its VLAN tag — in that order
    const prov = sim.pdu(request)!.provenance.map((m) => [m.device, m.reason, m.field, m.cause] as const);
    const expected: readonly (readonly [string, string, string, string])[] = [
      ['lt1', 'Encapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['lap1', 'Encapsulate', 'capwap', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'udp', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'ipv4', CAUSE_CAPWAP_TUNNEL],
      ['wlc1', 'Decapsulate', 'ipv4', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'udp', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'capwap', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'dot11', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'dot1q', CAUSE_CONTROLLER_BRIDGING],
    ];
    let at = -1;
    for (const want of expected) {
      const found = prov.findIndex((m, k) => k > at && m[0] === want[0] && m[1] === want[1] && m[2] === want[2] && m[3] === want[3]);
      expect([want, found > at]).toEqual([want, true]);
      at = found;
    }

    // no pduConsumed for it before the gateway: R1's icmpv4 is its only consumer, after it reached R1
    const consumed = evs.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'pduConsumed' && e.pdu.id === request);
    expect(consumed.map(({ e }) => [(e as Extract<TraceEvent, { kind: 'pduConsumed' }>).device, (e as Extract<TraceEvent, { kind: 'pduConsumed' }>).process])).toEqual([['r1', 'icmpv4']]);
    const atGateway = evs.findIndex((e) => e.kind === 'frameRx' && e.device === 'r1' && e.pdu.id === request);
    expect(atGateway).toBeGreaterThan(-1);
    expect(consumed[0]!.i).toBeGreaterThan(atGateway);
    // it reached R1 as the laptop's own packet
    const final = sim.pdu(request)!;
    expect(final.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect([final.get('ipv4.src'), final.get('ipv4.dst'), final.get('ethernet.src')]).toEqual([LAPTOP_ADDR, GW20, macOf(sim, 'lt1', 'Wlan0')]);
  });

  it('the passphrase appears in no PDU byte and no snapshot; the AP receives only its key tag', () => {
    const { sim, main, liveSnapshot, liveViews, json } = scenario();
    const secret = Buffer.from(PASSPHRASE, 'latin1');
    const created = ofKind(main, 'pduCreated');
    expect(created.length).toBeGreaterThan(100);
    for (const e of created) {
      const pdu = sim.pdu(e.pdu.id);
      expect(pdu, `pdu ${e.pdu.id}`).toBeDefined();
      expect([e.pdu.id, Buffer.from(pdu!.bytes).includes(secret)]).toEqual([e.pdu.id, false]);
      expect([e.pdu.id, JSON.stringify(pdu!.layers.map((l) => l.fields)).includes(PASSPHRASE)]).toEqual([e.pdu.id, false]);
    }
    expect(liveSnapshot).not.toContain(PASSPHRASE);
    expect(liveViews).not.toContain(PASSPHRASE);
    expect(JSON.stringify(JSON.parse(json).snapshot)).not.toContain(PASSPHRASE);
    // what the controller pushed instead: the WLAN with its VLAN and key tag (§3.12 step 3)
    const push = controlMessages(sim, main).filter((m) => m.type === CAPWAP_MSG.wlanConfigReq);
    expect(push.map((m) => sim.pdu(m.id)!.get('capwap.wlans'))).toEqual([`1:${SSID}:wpa2-psk:20:${passphraseTag(SSID, PASSPHRASE)}`]);
  });

  it('with a second controller port cabled to a second switch, no frame and no BPDU crosses between the switches through the controller', () => {
    const { sim, main, pc2Ping, stpRows } = scenario();
    const made = creators(main);
    const origin = (id: PduId): DeviceId | undefined => made.get(rootOf(sim, id));

    // SW2's side really sent to the controller: its BPDUs and PC2's ARP broadcasts arrived on the backup port
    const fromSw2 = ofKind(main, 'frameRx').filter((e) => e.device === 'wlc1' && e.port === DIST2);
    expect(fromSw2.filter((e) => e.pdu.proto === 'stp' && origin(e.pdu.id) === 'sw2').length).toBeGreaterThan(10);
    expect(fromSw2.filter((e) => e.pdu.proto === 'arp' && origin(e.pdu.id) === 'pc2').length).toBeGreaterThan(0);
    // and SW1's BPDUs arrived on the active one
    expect(ofKind(main, 'frameRx').filter((e) => e.device === 'wlc1' && e.port === DIST1 && e.pdu.proto === 'stp' && origin(e.pdu.id) === 'sw1').length).toBeGreaterThan(10);

    // nothing of one side leaves the controller toward the other
    const sent = ofKind(main, 'frameTx').filter((e) => e.from.device === 'wlc1' && e.medium !== 'air');
    const toSw2 = sent.filter((e) => e.from.port === DIST2);
    const toSw1 = sent.filter((e) => e.from.port === DIST1);
    expect(toSw1.length).toBeGreaterThan(0);
    expect(toSw2.filter((e) => SIDE_SW1.includes(origin(e.pdu.id)!)).map((e) => e.pdu.summary)).toEqual([]);
    expect(toSw1.filter((e) => SIDE_SW2.includes(origin(e.pdu.id)!)).map((e) => e.pdu.summary)).toEqual([]);
    // no frame reached one switch from the controller that the other side made; no BPDU crossed either way
    // (each switch's GigabitEthernet0/1 faces the controller)
    const rxFromWlc = (sw: DeviceId): Extract<TraceEvent, { kind: 'frameRx' }>[] =>
      ofKind(main, 'frameRx').filter((e) => e.device === sw && e.port === 'GigabitEthernet0/1');
    expect(rxFromWlc('sw2').filter((e) => SIDE_SW1.includes(origin(e.pdu.id)!)).map((e) => e.pdu.summary)).toEqual([]);
    expect(rxFromWlc('sw1').filter((e) => SIDE_SW2.includes(origin(e.pdu.id)!)).map((e) => e.pdu.summary)).toEqual([]);
    for (const sw of ['sw1', 'sw2'] as const) {
      const bpdus = ofKind(main, 'frameRx').filter((e) => e.device === sw && e.pdu.proto === 'stp');
      expect([sw, bpdus.map((e) => origin(e.pdu.id))]).toEqual([sw, []]);
    }
    expect(ofKind(main, 'pduCreated').filter((e) => e.device === 'wlc1' && e.pdu.proto === 'stp')).toEqual([]);
    // so each switch is the root of its own spanning tree in every VLAN it runs
    for (const sw of ['sw1', 'sw2'] as const) {
      const rows = stpRows[sw];
      expect(rows.map((r) => r.vlan).sort((a, b) => a - b)).toEqual([1, 20, 99]);
      for (const r of rows) expect([sw, r.vlan, r.isRoot, r.rootId]).toEqual([sw, r.vlan, true, r.bridgeId]);
    }

    // PC2, in VLAN 20 behind the backup port, cannot reach the VLAN 20 gateway through the controller
    expect(pc2Ping).toContain('Sent 5, received 0, lost 5');
    const pc2Frames = fromSw2.filter((e) => origin(e.pdu.id) === 'pc2').map((e) => e.pdu.id);
    const pc2Drops = ofKind(main, 'drop').filter((e) => e.device === 'wlc1' && pc2Frames.includes(e.pdu.id));
    expect(pc2Drops.length).toBe(pc2Frames.length);
    expect(new Set(pc2Drops.map((e) => `${e.port} ${e.reason} ${e.detail}`))).toEqual(new Set([`${DIST2} other ${DIST2} is a backup distribution port`]));
  });

  it('three runs with one seed are byte-identical', () => {
    const first = scenario().json;
    expect(first).toContain(WLC_MGMT);
    expect(runScenario(SEED).json).toBe(first);
    expect(runScenario(SEED).json).toBe(first);
  });

  it('with the WLC powered off runToIdle still terminates', () => {
    // after the scenario: the AP is still in run, its echoes are periodic, nothing holds the queue
    const { poweredOff, sim } = scenario();
    expect(poweredOff.stopped).toBeUndefined();
    expect(poweredOff.events).toBeLessThan(IDLE_CAP);
    expect(sim.device('wlc1')!.power).toBe(false);

    // from the start: the controller is configured, then powered off before any AP could join; the AP keeps
    // discovering on its periodic timer and the world still idles
    const cold = world(SEED);
    cold.runFor(CONFIGURE_AT);
    expect(cold.configure('wlc1', WLC_PANEL_LINES, PANEL_OPTIONS).ok).toBe(true);
    cold.setPower('wlc1', false);
    cold.runFor(SETTLE);
    const stats = cold.runToIdle(IDLE_CAP);
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(IDLE_CAP);
    expect(cold.device('lap1')!.tables.get<CapwapRow>('capwap')!.rows().map((r) => r.state)).toEqual(['discovery']);
    expect(cold.device('wlc1')!.tables.get('wlan-clients')!.size).toBe(0);
  });
});
