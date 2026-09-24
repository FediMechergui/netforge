/**
 * test/capwap.harness.ts — the §3.12 controller world for the W5 wireless tests (not a test file).
 *
 * Built with `createP2Simulation` (ARCHITECTURE-P2 §0 rule 13) on the TEST-ONLY wireless models of `p2.world`
 * (NF-AP-1832 with `lightweight-ap`, the NF-WLC-9800 appliance), with the two W5 factories laid over the registry —
 * the W6 catalog item registers them for real. The controller is configured through its saved configuration (the text
 * the §5.3 lines store: `wlc-interface`, `wlan`, and the SVI + default gateway the controller's CLI handler maintains),
 * so these tests do not depend on the same-wave cli grammar.
 *
 *   WLC1 (wlc.nfwlc9800) Gi0/1 ── SW1 Gi0/1  (trunk, nonegotiate, PortFast trunk: the controller runs no STP)
 *   LAP1 (ap.nfap-lw)   Gi0   ── SW1 Fa0/2  (access VLAN 99, the AP management VLAN)
 *   R1   (router.nf2911) Gi0/0 ── SW1 Fa0/3  (access VLAN 20: 192.168.20.1, the clients' gateway, DHCP pool STAFF)
 *   R1                   Gi0/1 ── SW1 Fa0/4  (access VLAN 99: 192.168.99.1, DHCP pool APS)
 *   LAPTOP1 (laptop.nflaptop) 10 m from LAP1, WLAN LabNet (wpa2-psk)
 *   optional: LAP2 on SW1 Fa0/5 (VLAN 99, 192.168.99.21) 75 m away with LAPTOP3 next to it; LAPTOP2 on WLAN LabNet5
 * WLC1: management interface VLAN 99, 192.168.99.5; STAFF-IF VLAN 20, 192.168.20.5; WLAN 1 STAFF LabNet on STAFF-IF.
 */
import type { MacAddress } from '../src/contracts/addr.js';
import type { PduId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createCapwapAc } from '../src/protocols/capwap-ac.js';
import { createCapwapWtp } from '../src/protocols/capwap-wtp.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';

export const M24 = '255.255.255.0';
export const WLC_MGMT = '192.168.99.5';
export const WLC_STAFF = '192.168.20.5';
export const AP_ADDR = '192.168.99.20';
export const AP_GW = '192.168.99.1';
export const GW20 = '192.168.20.1';
export const LAPTOP_ADDR = '192.168.20.10';
export const LAPTOP2_ADDR = '192.168.20.11';
export const LAPTOP3_ADDR = '192.168.20.12';
export const AP2_ADDR = '192.168.99.21';
export const SSID = 'LabNet';
export const SSID5 = 'LabNet5';
export const PASSPHRASE = 'Secret123';
export const DIST = 'GigabitEthernet0/1';
export const TUNNEL = 'Capwap0';

/** The two W5 daemons (the rest of the registry is the real `PROCESS_FACTORIES`). */
export function capwapFactories(): P2FactoryOverlay {
  return { 'capwap-wtp': createCapwapWtp, 'capwap-ac': createCapwapAc };
}

export interface CapwapWorldOptions {
  readonly seed?: number;
  /** LAP1 addressing: 'dhcp' = the P2 profile default (`ip address dhcp` on Vlan1, from R1's pool), else a static address. */
  readonly ap?: 'dhcp' | 'static';
  /** Extra global lines of LAP1 (e.g. `capwap controller 192.168.99.5`). */
  readonly apLines?: readonly string[];
  /** LAPTOP1's passphrase (default the WLAN's). */
  readonly passphrase?: string;
  /** false = no LAPTOP1 at all (default: present). */
  readonly laptop?: boolean;
  /** LAPTOP1 takes its address by DHCP (R1's pool STAFF, through the controller) instead of 192.168.20.10. */
  readonly laptopDhcp?: boolean;
  /** A second laptop on the 5 GHz WLAN LabNet5 (WLAN 2, `radio 5`; WLAN 1 then says `radio 2.4`). */
  readonly laptop2?: boolean;
  /** A second access point LAP2 (static 192.168.99.21 on SW1 Fa0/5) with LAPTOP3 (192.168.20.12) next to it. */
  readonly ap2?: boolean;
  /** `ip http server` on R1 (a TCP listener behind the controller). */
  readonly http?: boolean;
  /** The world's profile (default P2). */
  readonly profile?: 'P1' | 'P2';
}

/** WLC1's saved configuration (§3.12 setup, §5.3 lines plus the SVIs and gateway the CLI handler maintains). */
export function wlcConfig(o: Pick<CapwapWorldOptions, 'laptop2'> = {}): string {
  const wlan1 = ['security wpa2-psk', `passphrase ${PASSPHRASE}`, 'interface STAFF-IF'];
  if (o.laptop2 === true) wlan1.push('radio 2.4');
  const sections: string[][] = [
    ['hostname WLC1'],
    ['vlan 20'],
    ['vlan 99'],
    section('wlc-interface management', ['vlan 99', `address ${WLC_MGMT} ${M24}`, `gateway ${AP_GW}`]),
    section('wlc-interface STAFF-IF', ['vlan 20', `address ${WLC_STAFF} ${M24}`, `gateway ${GW20}`, `dhcp-server ${GW20}`]),
    section(`wlan 1 STAFF ${SSID}`, wlan1),
  ];
  if (o.laptop2 === true) sections.push(section(`wlan 2 STAFF5 ${SSID5}`, ['security wpa2-psk', `passphrase ${PASSPHRASE}`, 'interface STAFF-IF', 'radio 5']));
  sections.push(
    section('interface Vlan99', [`ip address ${WLC_MGMT} ${M24}`, 'no shutdown']),
    section('interface Vlan20', [`ip address ${WLC_STAFF} ${M24}`, 'no shutdown']),
    [`ip default-gateway ${AP_GW}`],
  );
  return configText(sections);
}

/** SW1: VLANs 20 and 99, the trunk to the controller, PortFast on the edge ports. */
export function sw1Config(): string {
  return configText([
    ['hostname SW1'],
    ['vlan 20'],
    ['vlan 99'],
    section('interface GigabitEthernet0/1', ['switchport mode trunk', 'switchport nonegotiate', 'spanning-tree portfast trunk']),
    section('interface FastEthernet0/2', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
    section('interface FastEthernet0/3', ['switchport mode access', 'switchport access vlan 20', 'spanning-tree portfast']),
    section('interface FastEthernet0/4', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
    section('interface FastEthernet0/5', ['switchport mode access', 'switchport access vlan 99', 'spanning-tree portfast']),
  ]);
}

/** R1: the two gateways and their DHCP pools. */
export function r1Config(o: Pick<CapwapWorldOptions, 'http'> = {}): string {
  const sections: string[][] = [
    ['hostname R1'],
    ['ip dhcp excluded-address 192.168.99.1 192.168.99.19'],
    ['ip dhcp excluded-address 192.168.20.1 192.168.20.9'],
    section('ip dhcp pool APS', [`network 192.168.99.0 ${M24}`, `default-router ${AP_GW}`]),
    section('ip dhcp pool STAFF', [`network 192.168.20.0 ${M24}`, `default-router ${GW20}`]),
    section('interface GigabitEthernet0/0', [`ip address ${GW20} ${M24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${AP_GW} ${M24}`, 'no shutdown']),
  ];
  if (o.http === true) sections.push(['ip http server']);
  return configText(sections);
}

/** LAP1: nothing (the P2 profile replays `capwap enable` and DHCP on Vlan1), or a static management address. */
export function lapConfig(o: Pick<CapwapWorldOptions, 'ap' | 'apLines'> = {}): string | undefined {
  const sections: string[][] = [['hostname LAP1']];
  for (const l of o.apLines ?? []) sections.push([l]);
  if (o.ap === 'static') sections.push(section('interface Vlan1', [`ip address ${AP_ADDR} ${M24}`, 'no shutdown']), [`ip default-gateway ${AP_GW}`]);
  return configText(sections);
}

/** A laptop joining `ssid` with a static address, or by DHCP when `address` is 'dhcp'. */
export function laptopConfig(name: string, address: string, ssid: string, passphrase: string): string {
  if (address === 'dhcp') {
    return configText([[`hostname ${name}`], section('interface Wlan0', ['ip address dhcp', `ssid ${ssid}`, 'security wpa2-psk', `passphrase ${passphrase}`])]);
  }
  return configText([
    [`hostname ${name}`],
    section('interface Wlan0', [`ip address ${address} ${M24}`, `ssid ${ssid}`, 'security wpa2-psk', `passphrase ${passphrase}`]),
    [`ip default-gateway ${GW20}`],
  ]);
}

/** The §3.12 world, not yet run. */
export function capwapWorld(o: CapwapWorldOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 12, profile: o.profile ?? 'P2', factories: capwapFactories() });
  sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 100, y: 100 }, startupConfig: wlcConfig(o) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 300, y: 100 }, startupConfig: sw1Config() });
  const lap = lapConfig(o);
  sim.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1', position: { x: 500, y: 100 }, ...(lap !== undefined ? { startupConfig: lap } : {}) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 300, y: 300 }, startupConfig: r1Config(o) });
  if (o.laptop !== false) {
    sim.addDevice({ id: 'lt1', type: 'laptop.nflaptop', name: 'LAPTOP1', position: { x: 540, y: 100 }, startupConfig: laptopConfig('LAPTOP1', o.laptopDhcp === true ? 'dhcp' : LAPTOP_ADDR, SSID, o.passphrase ?? PASSPHRASE) });
  }
  if (o.laptop2 === true) {
    sim.addDevice({ id: 'lt2', type: 'laptop.nflaptop', name: 'LAPTOP2', position: { x: 500, y: 140 }, startupConfig: laptopConfig('LAPTOP2', LAPTOP2_ADDR, SSID5, PASSPHRASE) });
  }
  if (o.ap2 === true) {
    sim.addDevice({
      id: 'lap2', type: 'ap.nfap-lw', name: 'LAP2', position: { x: 500, y: 400 },
      startupConfig: configText([['hostname LAP2'], section('interface Vlan1', [`ip address ${AP2_ADDR} ${M24}`, 'no shutdown']), [`ip default-gateway ${AP_GW}`]]),
    });
    sim.addDevice({ id: 'lt3', type: 'laptop.nflaptop', name: 'LAPTOP3', position: { x: 540, y: 400 }, startupConfig: laptopConfig('LAPTOP3', LAPTOP3_ADDR, SSID, PASSPHRASE) });
    sim.addLink({ id: 'l_lap2', a: { device: 'lap2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/5' } });
  }
  sim.addLink({ id: 'l_wlc', a: { device: 'wlc1', port: DIST }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ id: 'l_lap', a: { device: 'lap1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'l_r1_20', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  sim.addLink({ id: 'l_r1_99', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'FastEthernet0/4' } });
  return sim;
}

/** Long enough for every device to boot (router 45 s), the AP's lease, a discovery tick and the laptop's handshake. */
export const SETTLE: SimTime = 90 * SEC;

/** Narrow helper. */
export function ofKind<K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Extract<TraceEvent, { kind: K }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
}

/** The CAPWAP control messages created so far, in creation order: [device, messageType, pdu id]. */
export function controlMessages(sim: Simulation, evs: readonly TraceEvent[]): { device: string; type: number; id: PduId; protected: boolean; background: boolean }[] {
  const out: { device: string; type: number; id: PduId; protected: boolean; background: boolean }[] = [];
  for (const e of ofKind(evs, 'pduCreated')) {
    if (e.pdu.tag === undefined || !e.pdu.tag.startsWith('capwap-')) continue;
    const pdu = sim.pdu(e.pdu.id);
    const type = pdu?.get('capwap.messageType');
    if (pdu === undefined || typeof type !== 'number') continue;
    out.push({ device: e.device, type, id: e.pdu.id, protected: pdu.meta.protected === true, background: pdu.meta.background === true });
  }
  return out;
}

/** The MAC of a device port. */
export function macOf(sim: Simulation, device: string, port: string): MacAddress {
  const p = sim.device(device)?.port(port);
  if (p === undefined) throw new Error(`no port ${port} on ${device}`);
  return p.mac;
}
