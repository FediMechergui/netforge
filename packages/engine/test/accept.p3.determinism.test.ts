/**
 * P3 acceptance — determinism (ARCHITECTURE-P3 §10.1 `accept.p3.determinism`; §4, §7 W7 qa).
 *
 *   "A composite P3 world (OSPF triangle, extended ACL, snooping + DAI, marking with two bounded flows through an LLQ
 *    serial port, CDP, NTP with syslog, one RESTCONF change; and an EIGRP pair, a PPP CHAP link, an IPsec VTI and an
 *    SSH session from a PC, for the approved items) runs 3× with one seed: byte-identical trace and snapshot JSON;
 *    `runToIdle` terminates."
 *
 * The twin of `accept.p2.determinism`. One P3-profile world on the real catalog (`createP3Simulation`, test/
 * p3-flip.world.ts: every approved P3 daemon registered since the W4 flip, [S32] since the W6 flip), every device
 * configured through its startup configuration (the saved-file path) and every action typed on a console or asked of
 * a host app, exactly as a learner would:
 *
 *   campus (OSPF area 0 triangle of NF-4451 routers, /30 GigE links, broadcast network type, DR elections)
 *     PC1 (DHCP) ─ Fa0/1 SW1 Gi0/1 ─ Gi0/0/0 R1 Gi0/0/1 ──────── Gi0/0/0 R2 Gi0/0/2 ─ SRV 192.168.20.10
 *                  (Vlan10 192.168.10.2)        Gi0/0/2                    Gi0/0/1      (web, time, syslog)
 *                                                  │                          │
 *                                               Gi0/0/0 R3 Gi0/0/1 ───────────┘
 *                                                       Gi0/0/2 ─ Gi0/0 R4 (OSPF; the QoS edge below)
 *     • R1 Gi0/0/0: DHCP pool for 192.168.10.0/24, the extended list LAN-IN inbound (web to SRV denied), SSH only on
 *       the vty lines (`login local`, an RSA key), `logging host` SRV at `trap warnings`, `ntp server` SRV;
 *     • SW1: DHCP snooping and DAI on VLAN 10 (the uplink trusted), RESTCONF on its Vlan10 SVI, `ntp server` R1 (the
 *       lines wake its dormant transport, D22); CDP runs on every router and switch (the P3 default);
 *     • R2, R3: `ntp server` SRV; SRV: `ip http server`, and `service ntp on`, `service syslog on` typed on its host
 *       shell once it has booted (they are host-shell services, not configuration lines).
 *   QoS (§3.5 and §3.11)
 *     PC-V, PC-D ─ SW2 ─ Gi0/1 R4 Se0/0/0 (DCE 128 kb/s, LLQ WAN-EDGE out) ── Se0/0/0 R5 Gi0/0 ── PC-S
 *     • R4 marks voice EF on Gi0/1 input (MARK); two BOUNDED flows (voice 50 pps, data 200 kb/s) congest the serial.
 *   [C1] + [S19]: R6 ── PPP with CHAP over Se0/0/0 (DCE 64 kb/s) ── R7, EIGRP AS 100 over it; PC6 and PC7 on their LANs.
 *   [C13]: PC8 ─ R8 Se0/0/0 ── ISP ── Se0/0/0 R9 ─ PC9, a site-to-site VTI (Tunnel0 in ipsec mode, IKEv2 pre-shared key).
 *   [S13]: PC1 logs in to R1 over SSH, runs one command and leaves.
 *
 * The script: boot and converge; PC1 asks for an address (DORA through the snooping switch); at one instant four pings
 * (PC1 → SRV across the triangle and the permitting list, PC-V and PC-D → PC-S warming the QoS path, PC6 → PC7 across
 * EIGRP/PPP, PC8 → PC9 through the VTI); at one later instant the two bounded flows, PC1's blocked web fetch and PC1's
 * RESTCONF PUT; the SSH session; then a cable cut between R1 and R3 (OSPF reconverges through R2, and R1's LINK-3 log
 * reaches SRV over syslog); `runToIdle` after each step must return without hitting its cap.
 *
 * Asserted: every ingredient really took part (a row or an event each), and three runs with one seed give
 * byte-identical trace JSON (every event of the run, none dropped) and snapshot JSON, and the same session outputs.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { RunStats, Simulation } from '../src/contracts/simulation.js';
import type {
  AclRow,
  ArpInspectionRow,
  CdpNeighbourRow,
  ClockRow,
  DhcpSnoopingRow,
  EigrpNeighborRow,
  FlowRow,
  IpsecSaRow,
  NtpPeerRow,
  OspfNeighborRow,
  PppRow,
  RestconfLogRow,
  SyslogMessageRow,
  TableRow,
  VlanRow,
  VtyLoginRow,
} from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { RESTCONF_JSON_TYPE } from '../src/protocols/restconf.js';
import { MASK24, MASK30, configText, section } from '../src/sim/scenarios/kit.js';
import { createP3Simulation } from './p3-flip.world.js';
import { ofKind, output } from './sim.harness.js';

const SEED = 20_261_013;
/** Every event of a run fits the ring, so the whole trace is compared (asserted: nothing dropped). */
const TRACE_CAPACITY = 1_000_000;
/** The cap of every `runToIdle`: far above what a step needs, so reaching it means the world did not converge. */
const IDLE_CAP = 2_000_000;
/** Boot (routers 45 s), the OSPF wait timers (40 s), spanning tree (30 s), the first NTP and IKE exchanges. */
const BOOT = 150 * SEC;
/** When SRV's host shell starts its services (a server boots in well under 10 s). */
const SERVER_UP = 10 * SEC;
/** Sim time after each line typed in the SSH session. */
const LINE_NS = 3 * SEC;

// ── names and addresses ──────────────────────────────────────────────────────────────────────────────────────────

const PC_PORT = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const G000 = 'GigabitEthernet0/0/0';
const G001 = 'GigabitEthernet0/0/1';
const G002 = 'GigabitEthernet0/0/2';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const TU0 = 'Tunnel0';

const R1_LAN = '192.168.10.1';
const SW1_SVI = '192.168.10.2';
const SRV = '192.168.20.10';
const PCS = '192.168.50.10';
const PC7 = '10.7.0.10';
const PC9 = '192.168.90.10';
const R8_WAN = '209.165.200.225';
const R9_WAN = '209.165.200.230';

/** The lab values of the world (a user secret, a CHAP secret, an IKE key; original). */
const ADMIN_SECRET = 'Lab-Pass1';
const CHAP_SECRET = 'NetF0rge';
const IKE_KEY = 'Nf-Site-Key-25';

/** The extended list on R1 Gi0/0/0 inbound: web to SRV denied, everything else permitted. */
const LAN_IN = section('ip access-list extended LAN-IN', [`deny tcp any host ${SRV} eq www`, 'permit ip any any']);

/** §3.5's marking and §3.11's queueing policies (R4). */
const QOS_POLICIES: readonly (readonly string[])[] = [
  section('ip access-list extended VOICE-PORTS', ['permit udp any any range 16384 32767']),
  section('class-map match-all VOIP', ['match access-group name VOICE-PORTS']),
  ['policy-map MARK', ' class VOIP', '  set dscp ef'],
  section('class-map match-all VOICE', ['match dscp ef']),
  ['policy-map WAN-EDGE', ' class VOICE', '  priority 32', ' class class-default', '  fair-queue'],
];

/** The flows' bound: six seconds of each (§3.5 step 2's rates: voice 50 per second, data 25 per second). */
const FLOW_SECONDS = 6;
const VOICE_COUNT = 50 * FLOW_SECONDS;
const DATA_COUNT = 25 * FLOW_SECONDS;
/** The voice flow (60 bytes to a voice port, 50 per second) and the 200 kb/s data flow of 1000-byte datagrams. */
const VOICE_FLOW = `flow start ${PCS} pps 50 size 60 port 16384 count ${VOICE_COUNT}`;
const DATA_FLOW = `flow start ${PCS} rate 200 size 1000 count ${DATA_COUNT}`;

/** The RESTCONF change (§3.8 step 1): VLAN 30 named VOICE on SW1. */
const REST_PUT =
  `rest PUT https://${SW1_SVI}/restconf/data/nf-native:native/vlan/vlan-list=30 -u admin:${ADMIN_SECRET} ` +
  `-H "Content-Type: ${RESTCONF_JSON_TYPE}" -d {"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}`;

// ── configurations ───────────────────────────────────────────────────────────────────────────────────────────────

const iface = (port: string, address: string, mask: string, extra: readonly string[] = []): string[] =>
  section(`interface ${port}`, [`ip address ${address} ${mask}`, ...extra, 'no shutdown']);

const host = (name: string, address: string, gateway: string, extra: readonly string[] = []): string =>
  configText([[`hostname ${name}`], section(`interface ${PC_PORT}`, [`ip address ${address} ${MASK24}`]), [`ip default-gateway ${gateway}`, ...extra]]);

const edgePort = (port: string, vlan?: number): string[] =>
  section(`interface ${port}`, ['switchport mode access', ...(vlan === undefined ? [] : [`switchport access vlan ${vlan}`]), 'spanning-tree portfast']);

const R1_CONFIG = configText([
  ['hostname R1'],
  ['ip domain-name lab.nf'],
  ['crypto key generate rsa modulus 1024'],
  ['ip ssh version 2'],
  [`username admin secret ${ADMIN_SECRET}`],
  [`ip dhcp excluded-address ${R1_LAN} 192.168.10.10`],
  section('ip dhcp pool LAN10', [`network 192.168.10.0 ${MASK24}`, `default-router ${R1_LAN}`]),
  LAN_IN,
  iface(G000, R1_LAN, MASK24, ['ip access-group LAN-IN in']),
  iface(G001, '10.0.12.1', MASK30),
  iface(G002, '10.0.13.1', MASK30),
  section('router ospf 1', ['router-id 1.1.1.1', `passive-interface ${G000}`, 'network 192.168.10.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.13.0 0.0.0.3 area 0']),
  [`ntp server ${SRV}`, `logging host ${SRV}`, 'logging trap warnings'],
  section('line vty 0 4', ['login local', 'transport input ssh']),
]);

const R2_CONFIG = configText([
  ['hostname R2'],
  iface(G000, '10.0.12.2', MASK30),
  iface(G001, '10.0.23.1', MASK30),
  iface(G002, '192.168.20.1', MASK24),
  section('router ospf 1', ['router-id 2.2.2.2', `passive-interface ${G002}`, 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'network 192.168.20.0 0.0.0.255 area 0']),
  [`ntp server ${SRV}`],
]);

const R3_CONFIG = configText([
  ['hostname R3'],
  iface(G000, '10.0.13.2', MASK30),
  iface(G001, '10.0.23.2', MASK30),
  iface(G002, '10.0.34.1', MASK30),
  section('router ospf 1', ['router-id 3.3.3.3', 'network 10.0.13.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'network 10.0.34.0 0.0.0.3 area 0']),
  [`ntp server ${SRV}`],
]);

const SW1_CONFIG = configText([
  ['hostname SW1'],
  [`username admin privilege 15 secret ${ADMIN_SECRET}`, 'ip http secure-server', 'ip http authentication local', 'restconf'],
  section('vlan 10', ['name USERS']),
  edgePort('FastEthernet0/1', 10),
  section(`interface ${G1}`, ['switchport mode access', 'switchport access vlan 10', 'ip dhcp snooping trust', 'ip arp inspection trust']),
  iface('Vlan10', SW1_SVI, MASK24),
  [`ip default-gateway ${R1_LAN}`, 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'ip arp inspection vlan 10', `ntp server ${R1_LAN}`],
]);

const SRV_CONFIG = host('SRV', SRV, '192.168.20.1', ['ip http server']);

const R4_CONFIG = configText([
  ['hostname R4'],
  ...QOS_POLICIES,
  iface(G0, '10.0.34.2', MASK30),
  iface(G1, '192.168.30.1', MASK24, ['service-policy input MARK']),
  iface(SE0, '10.0.45.1', MASK30, ['clock rate 128000', 'bandwidth 128', 'service-policy output WAN-EDGE']),
  [`ip route 192.168.50.0 ${MASK24} 10.0.45.2`],
  section('router ospf 1', ['router-id 4.4.4.4', `passive-interface ${G1}`, 'network 10.0.34.0 0.0.0.3 area 0', 'network 192.168.30.0 0.0.0.255 area 0']),
]);

const R5_CONFIG = configText([['hostname R5'], iface(SE0, '10.0.45.2', MASK30), iface(G0, '192.168.50.1', MASK24), ['ip route 0.0.0.0 0.0.0.0 10.0.45.1']]);

const SW2_CONFIG = configText([['hostname SW2'], edgePort('FastEthernet0/1'), edgePort('FastEthernet0/2'), edgePort(G1)]);

/** One end of the EIGRP pair over the PPP CHAP link (R6 holds the DCE end). */
const eigrpPppConfig = (name: string, peer: string, n: 6 | 7, dce: boolean): string =>
  configText([
    [`hostname ${name}`],
    [`username ${peer} password ${CHAP_SECRET}`],
    iface(G0, `10.${n}.0.1`, MASK24),
    iface(SE0, `10.0.67.${n === 6 ? 1 : 2}`, MASK30, ['encapsulation ppp', 'ppp authentication chap', ...(dce ? ['clock rate 64000'] : [])]),
    section('router eigrp 100', ['network 10.0.0.0', `passive-interface ${G0}`]),
  ]);

/** The crypto sections of one VTI end (§3.13 setup). */
const cryptoSections = (peerName: string, peer: string): string[][] => [
  ['crypto ikev2 keyring KR', ` peer ${peerName}`, `  address ${peer}`, `  pre-shared-key ${IKE_KEY}`],
  ['crypto ikev2 profile PROF', ` match identity remote address ${peer} 255.255.255.255`, ' authentication remote pre-share', ' authentication local pre-share', ' keyring local KR'],
  ['crypto ipsec profile VPN', ' set ikev2-profile PROF'],
];

/** One end of the VTI: its LAN, its provider port, the crypto sections, Tunnel0 and the routes. */
const vtiConfig = (name: string, peerName: string, lan: string, wan: string, peer: string, tunnel: string, ispNext: string, remoteLan: string): string =>
  configText([
    [`hostname ${name}`],
    iface(G0, lan, MASK24),
    iface(SE0, wan, MASK30),
    ...cryptoSections(peerName, peer),
    section(`interface ${TU0}`, [`ip address ${tunnel} ${MASK30}`, `tunnel source ${SE0}`, `tunnel destination ${peer}`, 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VPN']),
    [`ip route 0.0.0.0 0.0.0.0 ${ispNext}`, `ip route ${remoteLan} ${MASK24} ${TU0}`],
  ]);

const ISP_CONFIG = configText([
  ['hostname ISP'],
  iface(SE0, '209.165.200.226', MASK30, ['clock rate 2000000']),
  iface(SE1, '209.165.200.229', MASK30, ['clock rate 2000000']),
]);

// ── the world ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The composite world (file header), not yet run. */
function compositeWorld(): Simulation {
  const sim = createP3Simulation({ seed: SEED, traceCapacity: TRACE_CAPACITY });
  const add = (id: DeviceId, type: string, name: string, startupConfig: string): void => {
    sim.addDevice({ id, type, name, startupConfig });
  };
  // campus
  add('r1', 'router.nf4451', 'R1', R1_CONFIG);
  add('r2', 'router.nf4451', 'R2', R2_CONFIG);
  add('r3', 'router.nf4451', 'R3', R3_CONFIG);
  add('sw1', 'switch.nfc2960', 'SW1', SW1_CONFIG);
  add('pc1', 'pc.nfpc', 'PC1', configText([['hostname PC1']]));
  add('srv', 'server.nfserver', 'SRV', SRV_CONFIG);
  // QoS
  add('r4', 'router.nf2911', 'R4', R4_CONFIG);
  add('r5', 'router.nf2911', 'R5', R5_CONFIG);
  add('sw2', 'switch.nfc2960', 'SW2', SW2_CONFIG);
  add('pcv', 'pc.nfpc', 'PC-V', host('PC-V', '192.168.30.10', '192.168.30.1'));
  add('pcd', 'pc.nfpc', 'PC-D', host('PC-D', '192.168.30.20', '192.168.30.1'));
  add('pcs', 'pc.nfpc', 'PC-S', host('PC-S', PCS, '192.168.50.1'));
  // [C1] EIGRP over [S19] PPP with CHAP
  add('r6', 'router.nf2911', 'R6', eigrpPppConfig('R6', 'R7', 6, true));
  add('r7', 'router.nf2911', 'R7', eigrpPppConfig('R7', 'R6', 7, false));
  add('pc6', 'pc.nfpc', 'PC6', host('PC6', '10.6.0.10', '10.6.0.1'));
  add('pc7', 'pc.nfpc', 'PC7', host('PC7', PC7, '10.7.0.1'));
  // [C13] the VTI across a provider
  add('r8', 'router.nf2911', 'R8', vtiConfig('R8', 'R9', '192.168.80.1', R8_WAN, R9_WAN, '172.16.0.1', '209.165.200.226', '192.168.90.0'));
  add('isp', 'router.nf2911', 'ISP', ISP_CONFIG);
  add('r9', 'router.nf2911', 'R9', vtiConfig('R9', 'R8', '192.168.90.1', R9_WAN, R8_WAN, '172.16.0.2', '209.165.200.229', '192.168.80.0'));
  add('pc8', 'pc.nfpc', 'PC8', host('PC8', '192.168.80.10', '192.168.80.1'));
  add('pc9', 'pc.nfpc', 'PC9', host('PC9', PC9, '192.168.90.1'));

  const cable = (id: string, a: DeviceId, ap: string, b: DeviceId, bp: string, extra: { media?: 'serial-dce'; dceEnd?: 'a' | 'b' } = {}): void => {
    sim.addLink({ id, a: { device: a, port: ap }, b: { device: b, port: bp }, ...extra });
  };
  cable('l_pc1_sw1', 'pc1', PC_PORT, 'sw1', 'FastEthernet0/1');
  cable('l_sw1_r1', 'sw1', G1, 'r1', G000);
  cable('l_r1_r2', 'r1', G001, 'r2', G000);
  cable('l_r1_r3', 'r1', G002, 'r3', G000);
  cable('l_r2_r3', 'r2', G001, 'r3', G001);
  cable('l_r2_srv', 'r2', G002, 'srv', PC_PORT);
  cable('l_r3_r4', 'r3', G002, 'r4', G0);
  cable('l_pcv_sw2', 'pcv', PC_PORT, 'sw2', 'FastEthernet0/1');
  cable('l_pcd_sw2', 'pcd', PC_PORT, 'sw2', 'FastEthernet0/2');
  cable('l_sw2_r4', 'sw2', G1, 'r4', G1);
  cable('l_r4_r5', 'r4', SE0, 'r5', SE0, { media: 'serial-dce' });
  cable('l_r5_pcs', 'r5', G0, 'pcs', PC_PORT);
  cable('l_r6_r7', 'r6', SE0, 'r7', SE0, { media: 'serial-dce' });
  cable('l_r6_pc6', 'r6', G0, 'pc6', PC_PORT);
  cable('l_r7_pc7', 'r7', G0, 'pc7', PC_PORT);
  cable('l_r8_isp', 'r8', SE0, 'isp', SE0, { dceEnd: 'b' });
  cable('l_isp_r9', 'isp', SE1, 'r9', SE0, { dceEnd: 'a' });
  cable('l_r8_pc8', 'r8', G0, 'pc8', PC_PORT);
  cable('l_r9_pc9', 'r9', G0, 'pc9', PC_PORT);
  return sim;
}

// ── the script ───────────────────────────────────────────────────────────────────────────────────────────────────

interface CompositeRun {
  readonly sim: Simulation;
  readonly events: TraceEvent[];
  readonly dropped: number;
  readonly trace: string;
  readonly snapshotJson: string;
  /** Every console session's output, by name. */
  readonly outputs: Readonly<Record<string, string>>;
  /** Every `runToIdle` of the script, in order. */
  readonly idles: readonly RunStats[];
  /** The browser tab of PC1's blocked web fetch (the http-client StateView entry). */
  readonly webTab: Readonly<Record<string, unknown>> | undefined;
  /** The trace cursors around the four pings' step. */
  readonly pingWindow: readonly [number, number];
}

/** The script of the file header, run on a fresh world. */
function runComposite(): CompositeRun {
  const sim = compositeWorld();
  const idles: RunStats[] = [];
  const idle = (): void => {
    idles.push(sim.runToIdle(IDLE_CAP));
  };
  const sessions: Record<string, SessionId> = {};
  /** One line on a fresh console session of `device`, remembered as `name`. */
  const typed = (name: string, device: DeviceId, line: string): void => {
    const s = sim.cli.open(device, 'console');
    const r = sim.cli.exec(s, line);
    if (r.error !== undefined) throw new Error(`"${line}" on ${device}: ${r.output}`);
    sessions[name] = s;
  };

  // boot and converge; SRV's time service and syslog receiver are started on its host shell once it has booted
  sim.runFor(SERVER_UP);
  typed('srv-ntp', 'srv', 'service ntp on');
  typed('srv-syslog', 'srv', 'service syslog on');
  sim.runFor(BOOT - SERVER_UP);
  idle();

  // PC1 asks for an address: DORA through the snooping switch (R1's pool, the uplink trusted)
  const dhcp = sim.configure('pc1', ['ip address dhcp']);
  if (!dhcp.ok) throw new Error(`ip address dhcp: ${JSON.stringify(dhcp.lines)}`);
  idle();

  // four pings at one instant
  const pingFrom = sim.trace(0).next;
  typed('pc1-srv', 'pc1', `ping ${SRV}`);
  typed('pcv-pcs', 'pcv', `ping ${PCS}`);
  typed('pcd-pcs', 'pcd', `ping ${PCS}`);
  typed('pc6-pc7', 'pc6', `ping ${PC7}`);
  typed('pc8-pc9', 'pc8', `ping ${PC9}`);
  idle();
  const pingTo = sim.trace(0).next;

  // at one later instant: the two bounded flows, PC1's blocked web fetch and PC1's RESTCONF change
  typed('voice', 'pcv', VOICE_FLOW);
  typed('data', 'pcd', DATA_FLOW);
  const web = sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SRV}/` });
  typed('rest', 'pc1', REST_PUT);
  idle();

  // the SSH session from PC1: the password is asked locally, the login, one command, the logout
  const ssh = sim.cli.open('pc1', 'console');
  sessions['ssh'] = ssh;
  for (const line of [`ssh -l admin ${R1_LAN}`, ADMIN_SECRET, 'show users', 'exit']) {
    sim.cli.exec(ssh, line);
    sim.runFor(LINE_NS);
  }
  idle();

  // a cable cut between R1 and R3: OSPF reconverges through R2; R1's LINK-3 log goes to SRV
  sim.injectFault(sim.now + SEC, { id: 'cut-r1-r3', kind: 'cable-cut', target: { link: 'l_r1_r3' } });
  sim.runFor(2 * SEC);
  idle();

  const page = sim.trace(0);
  const snapshot = sim.snapshot();
  const tabs = sim.device('pc1')!.processes.get('http-client')?.stateSnapshot().state['tabs'] as Record<string, Record<string, unknown>> | undefined;
  return {
    sim,
    events: page.events,
    dropped: page.dropped,
    trace: JSON.stringify(page.events),
    snapshotJson: JSON.stringify(snapshot),
    outputs: Object.fromEntries(Object.entries(sessions).map(([name, s]) => [name, output(page.events, s)])),
    idles,
    webTab: tabs?.[web.requestId],
    pingWindow: [pingFrom, pingTo],
  };
}

// ── readers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const rows = <R extends TableRow>(sim: Simulation, device: DeviceId, table: string): R[] => sim.device(device)!.tables.get<R>(table)?.rows() ?? [];
/** The installed route of `key` (`192.168.20.0/24`) on `device`, as [source, next hop]. */
const routeOf = (sim: Simulation, device: DeviceId, key: string): [string, string | undefined] | undefined => {
  const r = sim.device(device)!.tables.rib.get(key);
  return r === undefined ? undefined : [r.source, r.nextHop];
};

describe('accept P3: determinism', () => {
  it('a composite P3 world (OSPF, ACL, snooping + DAI, marking and LLQ, CDP, NTP, syslog, RESTCONF, EIGRP, PPP, IPsec, SSH) is byte-identical over 3 runs and runToIdle terminates', () => {
    const runs = [runComposite(), runComposite(), runComposite()];
    const first = runs[0]!;
    const sim = first.sim;
    const evs = first.events;

    // runToIdle terminates at every step, and the whole trace is kept
    for (const s of first.idles) {
      expect(s.stopped).toBeUndefined();
      expect(s.events).toBeLessThan(IDLE_CAP);
    }
    expect(first.dropped).toBe(0);
    expect(evs.length).toBeLessThan(TRACE_CAPACITY);

    // pings: across the triangle and the permitting list, the QoS path, EIGRP over PPP, the VTI
    for (const name of ['pc1-srv', 'pcv-pcs', 'pcd-pcs', 'pc6-pc7', 'pc8-pc9']) {
      expect(first.outputs[name], name).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    }

    // OSPF triangle: R1 reached FULL with R2 and R3 before the cut; after it, R1 keeps R2 only, R2 and R3 keep theirs,
    // and R1 reaches SRV's LAN and R3's link to R4 through R2
    const full = (dev: DeviceId): string[] => rows<OspfNeighborRow>(sim, dev, 'ospf-neighbors').filter((r) => r.state === 'full').map((r) => r.routerId).sort();
    const everFull = ofKind(evs, 'tableWrite').filter((e) => e.device === 'r1' && e.table === 'ospf-neighbors' && e.row['state'] === 'full').map((e) => e.row['routerId']);
    expect([...new Set(everFull)].sort()).toEqual(['2.2.2.2', '3.3.3.3']);
    expect(full('r1')).toEqual(['2.2.2.2']);
    expect(full('r2')).toEqual(['1.1.1.1', '3.3.3.3']);
    expect(full('r3')).toEqual(['2.2.2.2', '4.4.4.4']);
    expect(routeOf(sim, 'r1', '192.168.20.0/24')).toEqual(['O', '10.0.12.2']);
    expect(routeOf(sim, 'r1', '10.0.34.0/30')).toEqual(['O', '10.0.12.2']);

    // extended ACL: the web SYNs to SRV denied by LAN-IN 10, PC1's other traffic permitted by 20
    const acl = (key: string): AclRow | undefined => rows<AclRow>(sim, 'r1', 'acl').find((r) => r.key === key);
    expect(acl('4|LAN-IN|10')?.matches).toBeGreaterThan(0);
    expect(acl('4|LAN-IN|20')?.matches).toBeGreaterThan(0);
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'acl-deny').length).toBe(acl('4|LAN-IN|10')!.matches);
    expect(first.webTab).toMatchObject({ phase: 'error' });

    // DHCP snooping and DAI: PC1's binding learned on Fa0/1; its ARPs inspected and forwarded
    const lease = sim.device('pc1')!.port(PC_PORT)!.l3.ipv4;
    expect(lease).toMatchObject({ origin: 'dhcp', prefixLen: 24 });
    expect(rows<DhcpSnoopingRow>(sim, 'sw1', 'dhcp-snooping').map((r) => [r.ip, r.port, r.kind])).toEqual([[lease!.address, 'FastEthernet0/1', 'learned']]);
    const dai = rows<ArpInspectionRow>(sim, 'sw1', 'arp-inspection');
    expect(dai.map((r) => r.vlan)).toEqual([10]);
    expect(dai[0]!.forwarded).toBeGreaterThan(0);
    expect(dai[0]!.dropped).toBe(0);

    // marking and LLQ: the voice datagrams marked EF at R4 and queued at the congested serial port; both bounded flows
    // ended; LLQ lost no voice datagram, while the data class overflowed and every datagram lost was tail-dropped there
    const flows = rows<FlowRow>(sim, 'pcs', 'flows');
    expect(flows.map((f) => [f.src, f.dscp, f.ended]).sort()).toEqual([
      ['192.168.30.10', 46, true],
      ['192.168.30.20', 0, true],
    ]);
    const voice = flows.find((f) => f.src === '192.168.30.10')!;
    const data = flows.find((f) => f.src === '192.168.30.20')!;
    expect([voice.received, voice.lost]).toEqual([VOICE_COUNT, 0]);
    expect(data.lost).toBeGreaterThan(0);
    expect(data.received + data.lost).toBe(DATA_COUNT);
    const serialDrops = ofKind(evs, 'drop').filter((d) => d.device === 'r4' && d.port === SE0);
    expect(serialDrops.map((d) => d.reason)).toEqual(Array.from({ length: data.lost }, () => 'queue-full'));
    expect(ofKind(evs, 'mutation').filter((m) => m.mutation.device === 'r4' && m.mutation.reason === 'QosMark').length).toBe(VOICE_COUNT);
    expect(ofKind(evs, 'frameQueued').some((e) => e.device === 'r4' && e.port === SE0)).toBe(true);
    expect(sim.device('r4')!.egressPolicy(SE0)).toMatchObject({ policy: 'WAN-EDGE' });

    // CDP: SW1 and R1 see each other; R1 sees R2 and SW1
    expect(rows<CdpNeighbourRow>(sim, 'sw1', 'cdp-neighbours').map((r) => [r.localPort, r.deviceId])).toContainEqual([G1, 'R1']);
    expect(rows<CdpNeighbourRow>(sim, 'r1', 'cdp-neighbours').map((r) => r.deviceId).sort()).toEqual(['R2', 'SW1']);

    // NTP: SRV → R1 (stratum 2) → SW1 (stratum 3); the routers synchronised
    for (const dev of ['r1', 'r2', 'r3']) expect(rows<ClockRow>(sim, dev, 'clock'), dev).toMatchObject([{ source: 'ntp', stratum: 2, reference: SRV }]);
    expect(rows<ClockRow>(sim, 'sw1', 'clock')).toMatchObject([{ source: 'ntp', stratum: 3, reference: R1_LAN }]);
    expect(rows<NtpPeerRow>(sim, 'r1', 'ntp-peers').map((r) => [r.address, r.selected])).toEqual([[SRV, 'sys-peer']]);

    // syslog: the cut's LINK-3 line reached SRV (severity ≤ warnings), with R1's synchronised stamp
    const received = rows<SyslogMessageRow>(sim, 'srv', 'syslog-messages');
    const linkDown = received.filter((r) => r.from === '10.0.12.1' && r.hostname === 'R1' && r.message.includes('%LINK-3-UPDOWN'));
    expect(linkDown.length).toBeGreaterThan(0);
    for (const r of linkDown) expect(r.stamp, 'a synchronised stamp carries no *').not.toMatch(/^\*/);
    expect(received.every((r) => r.severity <= 4)).toBe(true);

    // RESTCONF: one PUT, 201, VLAN 30 VOICE on SW1
    expect(rows<RestconfLogRow>(sim, 'sw1', 'restconf-log').map((r) => [r.method, r.path, r.status])).toEqual([
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', 201],
    ]);
    expect(rows<VlanRow>(sim, 'sw1', 'vlans').find((r) => r.vlan === 30)).toMatchObject({ name: 'VOICE' });
    expect(first.outputs['rest']).toMatch(/^HTTP\/1\.1 201 Created/);
    expect(ofKind(evs, 'configChange').filter((c) => c.device === 'sw1' && c.origin !== undefined).map((c) => [c.line, c.origin!.via, c.origin!.user])).toContainEqual(['vlan 30', 'restconf', 'admin']);

    // [C1] + [S19]: CHAP verified both ways, the EIGRP neighbour up over the PPP link, PC7's LAN learned through EIGRP
    for (const dev of ['r6', 'r7']) {
      expect(rows<PppRow>(sim, dev, 'ppp'), dev).toMatchObject([{ port: SE0, phase: 'network', lcp: 'opened', ipcp: 'opened', authLocal: 'chap', authLocalState: 'success' }]);
      expect(rows<EigrpNeighborRow>(sim, dev, 'eigrp-neighbors').map((r) => [r.iface, r.state]), dev).toEqual([[SE0, 'up']]);
    }
    expect(routeOf(sim, 'r6', '10.7.0.0/24')).toEqual(['EIGRP', '10.0.67.2']);

    // [C13]: both SAs established, Tunnel0 up at both ends, only ESP at the provider
    for (const dev of ['r8', 'r9']) {
      expect(rows<IpsecSaRow>(sim, dev, 'ipsec-sa'), dev).toMatchObject([{ port: TU0, state: 'established' }]);
      expect(sim.device(dev)!.port(TU0)?.operUp, dev).toBe(true);
    }
    // the two legs at the provider (into it, out of it) of each echo request and reply are ESP legs (keepalives aside)
    const [from, to] = first.pingWindow;
    const atIsp = evs
      .slice(from, to)
      .filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.background !== true && (e.from.device === 'isp' || e.to.device === 'isp'));
    expect(atIsp).toHaveLength(2 * 2 * PING_COUNT);
    for (const leg of atIsp) expect(leg.pdu.tunnel).toBe('ipsec');

    // [S13]: PC1 logged in to R1 over SSH once, and left
    expect(rows<VtyLoginRow>(sim, 'r1', 'vty-logins').map((r) => [r.proto, r.peer, r.user, r.result])).toEqual([['ssh', lease!.address, 'admin', 'success']]);
    expect(sim.cli.sessions().filter((v) => v.via === 'vty')).toEqual([]);
    expect(first.outputs['ssh']).toMatch(new RegExp(`vty 0 +admin +ssh +${lease!.address.replace(/\./g, '\\.')} `));

    // three runs, one seed: byte-identical
    for (const run of runs.slice(1)) {
      expect(run.dropped).toBe(0);
      expect(run.outputs).toEqual(first.outputs);
      expect(run.idles).toEqual(first.idles);
      expect(run.trace === first.trace, 'the trace JSON is byte-identical').toBe(true);
      expect(run.snapshotJson === first.snapshotJson, 'the snapshot JSON is byte-identical').toBe(true);
    }
  }, 600_000);
});
