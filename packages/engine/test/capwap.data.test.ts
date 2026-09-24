/**
 * W5 wireless (ARCHITECTURE-P2 §3.12 steps 5–9, §2.4 tunnel sockets, §2.6 `wlan-clients`, §4.5, §7 W5): client data
 * through a lightweight AP and its controller, on `p2.world` with the TEST-ONLY wireless models (test/capwap.harness.ts).
 * Asserted:
 *   • a laptop → gateway frame keeps ONE PduId end to end: station framing at the laptop, the AP's tunnel
 *     encapsulation, the controller's decapsulation plus VLAN tag; no `pduConsumed` for it before the gateway (the
 *     controller's data socket is a tunnel socket); the reply comes back the same way with one PduId; the legs inside
 *     the tunnel, and only those, carry `PduSummary.tunnel = 'capwap'` (§2.7, §3.12 step 6);
 *   • the controller's `wlan-clients` row exists before the first downlink frame for the station, and follows the
 *     station reports (`add` on authorization, `del` when it leaves); the AP row's `clients` follows;
 *   • group frames are cloned per (AP, BSSID) serving a station of the VLAN, all clones allocated first; the source
 *     station never gets its own broadcast back; two WLANs reach two radios (`radio 2.4` / `radio 5`);
 *   • no row → a downlink frame drops 'other', `no access point serves <station>`; so does a frame of ANOTHER VLAN for
 *     a station (Capwap0 carries every VLAN, the station's row names its own): nothing leaks between VLANs;
 *   • TCP SYNs crossing the controller are clamped to MSS 1360 in both directions; a tunnelled frame larger than the
 *     path MTU drops 'giant', `too large for the controller tunnel`;
 *   • three runs with one seed are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { WlanClientRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CAUSE_CAPWAP_TUNNEL, CAUSE_CONTROLLER_BRIDGING, CAUSE_STATION_FRAMING } from '../src/link/rewrap80211.js';
import { CAPWAP_MSS_CAUSE, CAPWAP_TUNNEL_MSS } from '../src/protocols/capwap-ac.js';
import { CAPWAP_TOO_LARGE_DETAIL } from '../src/protocols/capwap-wtp.js';
import { AP2_ADDR, AP_ADDR, GW20, LAPTOP2_ADDR, LAPTOP3_ADDR, LAPTOP_ADDR, SETTLE, SSID, SSID5, WLC_MGMT, capwapWorld, macOf, ofKind } from './capwap.harness.js';

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;

/** Structural provenance of a PDU: [device, reason, field, cause] of every Encapsulate / Decapsulate / tag entry. */
function structure(sim: Simulation, id: PduId): [string, string, string, string | undefined][] {
  return sim
    .pdu(id)!
    .provenance.filter((m) => m.reason === 'Encapsulate' || m.reason === 'Decapsulate' || m.reason === 'VlanTagPush' || m.reason === 'VlanTagPop')
    .map((m) => [m.device, m.reason, m.field, m.cause]);
}

/** Ping `target` from `device`, run `ns`; the session text and the events since. */
function ping(sim: Simulation, device: string, target: string, ns = 15 * SEC): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const r = sim.cli.exec(session, `ping ${target}`);
  if (r.error !== undefined) throw new Error(`ping: ${r.output}`);
  sim.runFor(ns);
  const evs = sim.trace(cursor).events;
  let text = '';
  for (const e of evs) if (e.kind === 'cliOutput' && e.session === session) text += e.text;
  return { text, evs };
}

/** The first PDU `device` created with `tag`. */
function created(evs: readonly TraceEvent[], device: string, tag: string): PduId {
  const e = ofKind(evs, 'pduCreated').find((x) => x.device === device && x.pdu.tag === tag);
  if (e === undefined) throw new Error(`no ${tag} created on ${device}`);
  return e.pdu.id;
}

describe('W5 wireless — central switching through the controller (§3.12 steps 6–8)', () => {
  it('a laptop → gateway echo keeps one PduId end to end, with no pduConsumed before the gateway', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const p = ping(sim, 'lt1', GW20);
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const request = created(p.evs, 'lt1', 'ping#1');
    // one PduId from the laptop to R1: the only consumer is R1's icmpv4
    expect(ofKind(p.evs, 'pduConsumed').filter((e) => e.pdu.id === request).map((e) => [e.device, e.process])).toEqual([['r1', 'icmpv4']]);
    expect(ofKind(p.evs, 'drop').filter((e) => e.pdu.id === request)).toEqual([]);
    // station framing, the AP's tunnel, the trunk tag to the controller, the controller's bridging into VLAN 20
    expect(structure(sim, request)).toEqual([
      ['lt1', 'Encapsulate', 'ethernet', `ping ${GW20}`],
      ['lt1', 'Decapsulate', 'ethernet', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['lap1', 'Decapsulate', 'dot11', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'dot11', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'capwap', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'udp', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'ipv4', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'ethernet', CAUSE_CAPWAP_TUNNEL],
      ['sw1', 'VlanTagPush', 'dot1q.vid', 'switchport mode trunk'],
      ['wlc1', 'VlanTagPop', 'dot1q.vid', 'interface Vlan99'],
      ['wlc1', 'Decapsulate', 'ethernet', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'ipv4', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'udp', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'capwap', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'dot11', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'llc', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'dot1q', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'ethernet', CAUSE_CONTROLLER_BRIDGING],
      ['sw1', 'VlanTagPop', 'dot1q.vid', 'switchport access vlan 20'],
    ]);
    // the controller bridged it tagged VLAN 20 (its WLAN's interface VLAN) through Capwap0 and out Gi0/1
    const tx = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === request);
    expect(tx.map((e) => [e.from.device, e.from.port, e.to.device])).toEqual([
      ['lt1', 'Wlan0', 'lap1'],
      ['lap1', 'GigabitEthernet0', 'sw1'],
      ['sw1', 'GigabitEthernet0/1', 'wlc1'],
      ['wlc1', 'GigabitEthernet0/1', 'sw1'],
      ['sw1', 'FastEthernet0/3', 'r1'],
    ]);
    expect(tx[3]!.pdu.vlan).toBe(20);
    // §3.12 step 6: the two legs inside the tunnel carry `tunnel: 'capwap'` (sent and received); the air leg and the
    // legs after the controller's decapsulation do not
    expect(tx.map((e) => e.pdu.tunnel)).toEqual([undefined, 'capwap', 'capwap', undefined, undefined]);
    const rx = ofKind(p.evs, 'frameRx').filter((e) => e.pdu.id === request);
    expect(rx.filter((e) => e.pdu.tunnel === 'capwap').map((e) => e.device)).toEqual(['sw1', 'wlc1']);
    expect(rx.filter((e) => e.device === 'lap1' || e.device === 'r1').every((e) => e.pdu.tunnel === undefined)).toBe(true);
    // the frame arrived at R1 exactly as the laptop's IP packet left: same addresses, same ICMP
    const final = sim.pdu(request)!;
    expect(final.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(final.get('ipv4.src')).toBe(LAPTOP_ADDR);
    expect(final.get('ethernet.src')).toBe(macOf(sim, 'lt1', 'Wlan0'));

    // the reply: into the tunnel at the controller, out of it at the AP, consumed only by the laptop
    const reply = created(p.evs, 'r1', 'echo-reply');
    expect(ofKind(p.evs, 'pduConsumed').filter((e) => e.pdu.id === reply).map((e) => [e.device, e.process])).toEqual([['lt1', 'icmpv4']]);
    const back = structure(sim, reply).filter(([d]) => d === 'wlc1' || d === 'lap1' || d === 'lt1');
    expect(back).toEqual([
      ['wlc1', 'Decapsulate', 'ethernet', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Decapsulate', 'dot1q', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'llc', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'dot11', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'capwap', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'udp', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'ipv4', CAUSE_CONTROLLER_BRIDGING],
      ['wlc1', 'Encapsulate', 'ethernet', CAUSE_CONTROLLER_BRIDGING],
      // the controller's distribution port is an intrinsic trunk: eth-switch tags the management VLAN on it
      ['wlc1', 'VlanTagPush', 'dot1q.vid', 'switchport mode trunk'],
      ['lap1', 'Decapsulate', 'ethernet', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Decapsulate', 'ipv4', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Decapsulate', 'udp', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Decapsulate', 'capwap', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Decapsulate', 'dot11', CAUSE_CAPWAP_TUNNEL],
      ['lap1', 'Encapsulate', 'dot11', CAUSE_CAPWAP_TUNNEL],
      ['lt1', 'Decapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['lt1', 'Decapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['lt1', 'Encapsulate', 'ethernet', CAUSE_STATION_FRAMING],
    ]);
    // the tunnelled data frames: UDP 5247 both ways, the 802.11 frame inside without an FCS
    const down = ofKind(p.evs, 'frameTx').find((e) => e.pdu.id === reply && e.from.device === 'wlc1')!;
    expect(down.pdu.proto).toBe('icmpv4');
    // the reply's legs: tunnelled from the controller through sw1 to the AP, native before and after
    const replyTx = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === reply);
    expect(replyTx.map((e) => [e.from.device, e.to.device, e.pdu.tunnel])).toEqual([
      ['r1', 'sw1', undefined],
      ['sw1', 'wlc1', undefined],
      ['wlc1', 'sw1', 'capwap'],
      ['sw1', 'lap1', 'capwap'],
      ['lap1', 'lt1', undefined],
    ]);
    const counts = sim.device('wlc1')!.processes.get('capwap-ac')!.stateSnapshot().state as { tunnelledUp: number; tunnelledDown: number };
    expect(counts.tunnelledUp).toBeGreaterThanOrEqual(6);
    expect(counts.tunnelledDown).toBeGreaterThanOrEqual(6);
  });

  it('the wlan-clients row exists before the first downlink frame for the station, and follows its reports', () => {
    const sim = capwapWorld({ ap: 'dhcp', laptopDhcp: true });
    const wlc = sim.device('wlc1');
    // the first frame the controller tunnelled that reaches the laptop over the air (a DHCP answer, broadcast)
    let rowAtFirstDownlink: WlanClientRow | undefined | null = null;
    let firstDownlink: number | undefined;
    let seen = sim.trace(0).next;
    const unsubscribe = sim.onTrace((e) => {
      seen++;
      if (rowAtFirstDownlink !== null || e.kind !== 'frameTx' || e.medium !== 'air' || e.from.device !== 'lap1' || e.to.device !== 'lt1') return;
      const pdu = sim.pdu(e.pdu.id);
      if (pdu === undefined || !pdu.provenance.some((m) => m.device === 'wlc1' && m.cause === CAUSE_CONTROLLER_BRIDGING)) return;
      rowAtFirstDownlink = wlc!.tables.get<WlanClientRow>('wlan-clients')!.get(sim.device('lt1')!.port('Wlan0')!.mac);
      firstDownlink = seen - 1;
    });
    sim.runFor(150 * SEC);
    unsubscribe();
    const mac = sim.device('lt1')!.port('Wlan0')!.mac;
    // the laptop's DHCP OFFER is its first downlink frame: by then the controller already knew the station
    expect(rowAtFirstDownlink).toEqual({
      key: mac, station: mac, ap: macOf(sim, 'lap1', 'Vlan1'), bssid: macOf(sim, 'lap1', 'Wlan0'), wlanId: 1, ssid: SSID, vlan: 20,
      iface: 'STAFF-IF', state: 'associated', updatedAt: expect.any(Number),
    });
    const evs = events(sim);
    const write = evs.findIndex((e) => e.kind === 'tableWrite' && e.device === 'wlc1' && e.table === 'wlan-clients');
    expect(write).toBeGreaterThan(-1);
    expect(firstDownlink).toBeGreaterThan(write);
    // it was a DHCP answer for the laptop, broadcast in VLAN 20 and tunnelled to the laptop's BSSID
    const first = evs[firstDownlink!] as Extract<TraceEvent, { kind: 'frameTx' }>;
    expect(first.pdu.proto).toBe('dhcp');
    // the laptop got its lease through the controller, from the pool of the WLAN's VLAN
    expect(sim.device('lt1')!.port('Wlan0')!.l3.ipv4).toMatchObject({ address: '192.168.20.10', origin: 'dhcp' });
    expect(sim.device('wlc1')!.tables.get('capwap-aps')!.rows()).toEqual([expect.objectContaining({ apIp: AP_ADDR, clients: 1 })]);

    // R1 learns the laptop (a ping through the controller), then the station leaves (powered off): the AP reports `del`,
    // the controller deletes the row and a downlink frame for it now has no access point
    expect(ping(sim, 'lt1', GW20).text).toContain('Sent 5, received 5, lost 0');
    const before = sim.trace(0).next;
    sim.setPower('lt1', false);
    sim.runFor(5 * SEC);
    expect(sim.device('wlc1')!.tables.get('wlan-clients')!.size).toBe(0);
    expect(sim.device('wlc1')!.tables.get('capwap-aps')!.rows()).toEqual([expect.objectContaining({ clients: 0 })]);
    const reports = ofKind(sim.trace(before).events, 'pduCreated').filter((e) => e.device === 'lap1' && e.pdu.tag === 'capwap-wtp-event');
    expect(reports.map((e) => sim.pdu(e.pdu.id)!.get('capwap.stations'))).toEqual([`del:${mac}:${macOf(sim, 'lap1', 'Wlan0')}:1`]);
    const p = ping(sim, 'r1', '192.168.20.10', 12 * SEC);
    expect(p.text).not.toContain('!');
    const drops = ofKind(p.evs, 'drop').filter((e) => e.device === 'wlc1' && e.background !== true);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((e) => e.reason === 'other' && e.detail === `no access point serves ${mac}` && e.port === 'Capwap0')).toBe(true);
  });

  it('clones a group frame once per (AP, BSSID) serving its VLAN, never back to its source; two WLANs on two radios', () => {
    const sim = capwapWorld({ ap: 'static', laptop2: true });
    sim.runFor(SETTLE);
    // WLAN 1 (radio 2.4) on Wlan0, WLAN 2 (radio 5) on Wlan1
    const lap = sim.device('lap1')!;
    expect(lap.radioSettings('Wlan0')!.bss).toEqual([expect.objectContaining({ ssid: SSID, wlanId: 1, vlan: 20 })]);
    expect(lap.radioSettings('Wlan1')!.bss).toEqual([expect.objectContaining({ ssid: SSID5, wlanId: 2, vlan: 20 })]);
    const rows = sim.device('wlc1')!.tables.get<WlanClientRow>('wlan-clients')!.rows();
    expect(rows.map((r) => [r.station, r.bssid, r.wlanId, r.ssid, r.vlan])).toEqual([
      [macOf(sim, 'lt1', 'Wlan0'), macOf(sim, 'lap1', 'Wlan0'), 1, SSID, 20],
      [macOf(sim, 'lt2', 'Wlan0'), macOf(sim, 'lap1', 'Wlan1'), 2, SSID5, 20],
    ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)));

    // R1 looks for an absent host: its ARP broadcast reaches both radios, one copy each (the original and one clone)
    const r = ping(sim, 'r1', '192.168.20.99', 10 * SEC);
    const arp = created(r.evs, 'r1', 'arp-request');
    const onAir = ofKind(r.evs, 'frameTx').filter((e) => e.medium === 'air' && e.from.device === 'lap1' && (e.pdu.id === arp || e.pdu.parent === arp));
    expect(onAir.map((e) => [e.from.port, e.to.device])).toEqual([
      ['Wlan0', 'lt1'],
      ['Wlan1', 'lt2'],
    ]);
    expect(new Set(onAir.map((e) => e.pdu.id)).size).toBe(2);

    // a laptop's own broadcast comes back through the controller's hairpin to the OTHER radio only
    const l = ping(sim, 'lt1', '192.168.20.98', 10 * SEC);
    const own = created(l.evs, 'lt1', 'arp-request');
    const toStations = ofKind(l.evs, 'frameTx').filter((e) => e.medium === 'air' && e.from.device === 'lap1' && (e.pdu.id === own || e.pdu.parent === own));
    expect(toStations.map((e) => [e.from.port, e.to.device])).toEqual([['Wlan1', 'lt2']]);
    // and the ping between the two laptops crosses the controller both ways
    expect(ping(sim, 'lt1', LAPTOP2_ADDR).text).toContain('Sent 5, received 5, lost 0');
  });
  it('with two APs a group frame is cloned per AP in device-id order, every clone allocated first', () => {
    const sim = capwapWorld({ ap: 'static', ap2: true });
    sim.runFor(SETTLE);
    const aps = sim.device('wlc1')!.tables.get('capwap-aps')!.rows();
    expect(aps.map((r) => (r as unknown as { apIp: string; state: string; clients: number })).map((r) => [r.apIp, r.state, r.clients]).sort()).toEqual([
      [AP_ADDR, 'run', 1],
      [AP2_ADDR, 'run', 1],
    ]);
    const r = ping(sim, 'r1', '192.168.20.99', 10 * SEC);
    const arp = created(r.evs, 'r1', 'arp-request');
    // the controller's copies, in the order they left: lap1 (the original PDU) then lap2 (a clone of it)
    const tunnelled = ofKind(r.evs, 'frameTx').filter((e) => e.from.device === 'wlc1' && (e.pdu.id === arp || e.pdu.parent === arp));
    expect(tunnelled.map((e) => sim.pdu(e.pdu.id)!.meta.parent === undefined)).toEqual([true, false]);
    const encap = ofKind(r.evs, 'mutation').filter((e) => e.mutation.device === 'wlc1' && e.mutation.field === 'capwap' && e.mutation.reason === 'Encapsulate'
      && (e.pdu === arp || sim.pdu(e.pdu)!.meta.parent === arp));
    expect(encap.map((e) => e.pdu)).toEqual(tunnelled.map((e) => e.pdu.id));
    const onAir = ofKind(r.evs, 'frameTx').filter((e) => e.medium === 'air' && (e.pdu.id === arp || e.pdu.parent === arp));
    expect(onAir.map((e) => [e.from.device, e.to.device])).toEqual([
      ['lap1', 'lt1'],
      ['lap2', 'lt3'],
    ]);
    // stations on two APs reach each other through the controller
    expect(ping(sim, 'lt1', LAPTOP3_ADDR).text).toContain('Sent 5, received 5, lost 0');
  });

  it("never tunnels a frame of another VLAN to a station: the station's row in the frame's VLAN decides", () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const laptop = macOf(sim, 'lt1', 'Wlan0');
    expect(sim.device('wlc1')!.tables.get<WlanClientRow>('wlan-clients')!.get(laptop)!.vlan).toBe(20);
    // R1 frames a packet for the laptop's MAC on its VLAN 99 interface (a static cache entry): unknown in VLAN 99, it is
    // flooded there — over the trunk to the controller and on to Capwap0, which carries every VLAN
    const r1 = sim.device('r1')!;
    r1.applyActions('arp', [], sim.now);
    r1.tables.arp.set({ key: '192.168.99.77', ip: '192.168.99.77', mac: laptop, iface: 'GigabitEthernet0/1', type: 'static', updatedAt: sim.now });
    const p = ping(sim, 'r1', '192.168.99.77', 12 * SEC);
    expect(p.text).not.toContain('!');
    const requests = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.process === 'icmpv4').map((e) => e.pdu.id);
    expect(requests.length).toBeGreaterThan(0);
    // every copy that reached the controller's tunnel port was refused there, none crossed the tunnel or the air
    const atTunnel = ofKind(p.evs, 'drop').filter((e) => e.device === 'wlc1' && e.port === 'Capwap0' && (requests.includes(e.pdu.id) || (e.pdu.parent !== undefined && requests.includes(e.pdu.parent))));
    expect(atTunnel.length).toBe(requests.length);
    expect(atTunnel.every((e) => e.reason === 'other' && e.detail === `no access point serves ${laptop}`)).toBe(true);
    const leaked = ofKind(p.evs, 'frameTx').filter((e) => (e.from.device === 'wlc1' || e.medium === 'air') && (requests.includes(e.pdu.id) || (e.pdu.parent !== undefined && requests.includes(e.pdu.parent))));
    expect(leaked).toEqual([]);
    // the laptop's own VLAN still reaches it
    expect(ping(sim, 'r1', LAPTOP_ADDR).text).toContain('Sent 5, received 5, lost 0');
  });


  it('clamps the MSS of TCP SYNs crossing the controller to 1360, both ways', () => {
    const sim = capwapWorld({ ap: 'static', http: true });
    sim.runFor(SETTLE);
    const lt1 = sim.device('lt1')!;
    const cursor = sim.trace(0).next;
    lt1.applyActions('http-client', [{ type: 'request', to: 'tcp', req: { kind: 'tcp.connect', owner: 'http-client', socket: 'mss-test#1', dst: GW20, dstPort: 80 } }], sim.now);
    sim.runFor(5 * SEC);
    const evs = sim.trace(cursor).events;
    const syn = ofKind(evs, 'pduCreated').find((e) => e.device === 'lt1' && e.pdu.tag === 'tcp-syn')!;
    const synAck = ofKind(evs, 'pduCreated').find((e) => e.device === 'r1' && e.process === 'tcp' && sim.pdu(e.pdu.id)!.get('tcp.flags') === 'SA')!;
    expect(syn).toBeDefined();
    expect(synAck).toBeDefined();
    for (const [id, from] of [[syn.pdu.id, 1460], [synAck.pdu.id, 1460]] as const) {
      const clamp = sim.pdu(id)!.provenance.filter((m) => m.field === 'tcp.mss');
      expect(clamp.map((m) => [m.device, m.reason, m.before, m.after, m.cause])).toEqual([['wlc1', 'Other', from, CAPWAP_TUNNEL_MSS, CAPWAP_MSS_CAUSE]]);
      expect(sim.pdu(id)!.get('tcp.mss')).toBe(CAPWAP_TUNNEL_MSS);
      expect(sim.pdu(id)!.get('tcp.checksumValid')).toBe(true);
    }
    // the connection opened through the tunnel
    const r1Syn = ofKind(evs, 'pduConsumed').filter((e) => e.pdu.id === syn.pdu.id);
    expect(r1Syn.map((e) => e.device)).toEqual(['r1']);
  });

  it('drops a frame too large for the tunnel as a giant at the tunnel entrance', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    expect(ping(sim, 'lt1', GW20).text).toContain('received 5');
    const session = sim.cli.open('lt1', 'console');
    const cursor = sim.trace(0).next;
    sim.device('lt1')!.applyActions('icmpv4', [{ type: 'request', to: 'icmpv4', req: { kind: 'icmp.ping', session, target: GW20, count: 1, timeoutNs: 2 * SEC, sizeBytes: 1500 } }], sim.now);
    sim.runFor(5 * SEC);
    const evs = sim.trace(cursor).events;
    const big = ofKind(evs, 'pduCreated').find((e) => e.device === 'lt1' && e.process === 'icmpv4')!;
    const drop = ofKind(evs, 'drop').filter((e) => e.pdu.id === big.pdu.id);
    expect(drop.map((e) => [e.device, e.reason, e.detail])).toEqual([['lap1', 'giant', CAPWAP_TOO_LARGE_DETAIL]]);
    expect(drop[0]!.pdu.size).toBeGreaterThan(1500);
    expect(drop[0]!.pdu.tunnel).toBe('capwap');
  });
});

describe('W5 wireless — determinism of the data path', () => {
  it('three runs with one seed give byte-identical traces and snapshots', () => {
    const run = (): string => {
      const sim = capwapWorld({ seed: 77, ap: 'dhcp', laptop2: true });
      sim.runFor(150 * SEC);
      const session = sim.cli.open('lt1', 'console');
      sim.cli.exec(session, `ping ${LAPTOP2_ADDR}`);
      sim.runFor(15 * SEC);
      return JSON.stringify({ trace: events(sim), snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
    expect(a).toContain(WLC_MGMT);
  });
});
