/**
 * P0.5 acceptance — Wi-Fi home router (ARCHITECTURE-P1 §10.1 `accept.p05.wifi-home-router`; D5, D9, §3.1, §3.6).
 *
 * The home Wi-Fi template: HOME1 (`wrouter.nfhome`, WPA2 network LAB on Wlan0, LAN SVI Vlan1), PC1 on Gi1 and LAPTOP1
 * 40 m away. The laptop walks scanning → authenticating → associating → handshake → associated with the four EAPOL
 * key messages, then pings PC1; the 802.3 ↔ 802.11 rewraps show in the provenance at the laptop and at the router. A
 * wrong passphrase ends in failed/wrong-key without a single data frame on the air. The router has no console, yet
 * `configure` gives its Vlan1 an address that the laptop can ping.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { PduId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CAUSE_AP_BRIDGING, CAUSE_STATION_FRAMING } from '../src/link/rewrap80211.js';
import { KEY_ATTEMPTS } from '../src/protocols/wlan-client.js';
import { HOME_WIFI_LAPTOP_UNITS, HOME_WIFI_PASSPHRASE, HOME_WIFI_SSID, homeWifi } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createdId, ofKind, ping } from './sim.harness.js';
import { topologyDevice } from './accept.p05.harness.js';

/** The successful association attempt, state by state. */
const HANDSHAKE_WALK = ['scanning', 'authenticating', 'associating', 'handshake', 'associated'];

/** Wi-Fi association state changes of the laptop's radio. */
function laptopStates(evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'assocState' }>[] {
  return ofKind(evs, 'assocState').filter((e) => e.tech === 'wifi' && e.station.device === 'laptop1');
}

/** Structural provenance of a PDU: [device, Encapsulate | Decapsulate, layer, cause]. */
function rewraps(sim: Simulation, id: PduId): [string, string, string, string | undefined][] {
  return sim
    .pdu(id)!
    .provenance.filter((m) => m.reason === 'Encapsulate' || m.reason === 'Decapsulate')
    .map((m) => [m.device, m.reason, m.field, m.cause]);
}

describe('accept P0.5: Wi-Fi home router', () => {
  it('walks a laptop 40 m away through scan, authentication, association and the key handshake, then pings PC1', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(homeWifi());
    sim.runFor(60 * SEC);
    const boot = sim.trace(0).events;

    const states = laptopStates(boot);
    const walk = states.slice(states.map((e) => e.state).lastIndexOf('scanning'));
    expect(walk.map((e) => e.state)).toEqual(HANDSHAKE_WALK);
    walk.slice(1).forEach((e, i) => expect(e.prev).toBe(walk[i]!.state));

    const associations = sim.snapshot().media!.associations;
    expect(associations).toHaveLength(1);
    const association = associations[0]!;
    expect(association).toMatchObject({
      tech: 'wifi',
      state: 'associated',
      authorized: true,
      ssid: HOME_WIFI_SSID,
      ap: { device: 'home1', port: 'Wlan0' },
      station: { device: 'laptop1', port: 'Wlan0' },
      bssid: sim.device('home1')!.port('Wlan0')!.mac,
    });
    expect(association.distanceM).toBe(HOME_WIFI_LAPTOP_UNITS * DEFAULT_METRES_PER_UNIT);
    expect(association.distanceM).toBe(40);
    expect(sim.device('laptop1')!.port('Wlan0')!.operUp).toBe(true);

    // exactly the four EAPOL key messages, alternating access point → station → access point → station
    const eapol = ofKind(boot, 'frameTx').filter((e) => e.medium === 'air' && e.pdu.proto === 'eapol');
    expect(eapol.map((e) => [e.from.device, e.to.device, sim.pdu(e.pdu.id)!.get('eapol.handshakeStep')])).toEqual([
      ['home1', 'laptop1', 1],
      ['laptop1', 'home1', 2],
      ['home1', 'laptop1', 3],
      ['laptop1', 'home1', 4],
    ]);
    for (const e of eapol) expect(Buffer.from(sim.pdu(e.pdu.id)!.bytes).toString('latin1')).not.toContain(HOME_WIFI_PASSPHRASE);

    const p = ping(sim, 'laptop1', '192.168.1.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');

    // echo request: Ethernet → 802.11 at the laptop, 802.11 → Ethernet at the router
    const request = createdId(p.evs, 'laptop1', 'ping#1');
    expect(rewraps(sim, request)).toEqual([
      ['laptop1', 'Encapsulate', 'ethernet', expect.any(String)],
      ['laptop1', 'Decapsulate', 'ethernet', CAUSE_STATION_FRAMING],
      ['laptop1', 'Encapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['laptop1', 'Encapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['home1', 'Decapsulate', 'dot11', CAUSE_AP_BRIDGING],
      ['home1', 'Decapsulate', 'llc', CAUSE_AP_BRIDGING],
      ['home1', 'Encapsulate', 'ethernet', CAUSE_AP_BRIDGING],
    ]);
    const mirrored = ofKind(p.evs, 'mutation').filter((e) => e.pdu === request && (e.mutation.reason === 'Encapsulate' || e.mutation.reason === 'Decapsulate'));
    expect(mirrored.map((e) => [e.mutation.device, e.mutation.reason, e.mutation.field])).toEqual(rewraps(sim, request).map(([d, r, f]) => [d, r, f]));

    // echo reply: the reverse, Ethernet → 802.11 at the router and 802.11 → Ethernet at the laptop
    const reply = createdId(p.evs, 'pc1', 'echo-reply');
    expect(rewraps(sim, reply)).toEqual([
      ['pc1', 'Encapsulate', 'ethernet', expect.any(String)],
      ['home1', 'Decapsulate', 'ethernet', CAUSE_AP_BRIDGING],
      ['home1', 'Encapsulate', 'llc', CAUSE_AP_BRIDGING],
      ['home1', 'Encapsulate', 'dot11', CAUSE_AP_BRIDGING],
      ['laptop1', 'Decapsulate', 'dot11', CAUSE_STATION_FRAMING],
      ['laptop1', 'Decapsulate', 'llc', CAUSE_STATION_FRAMING],
      ['laptop1', 'Encapsulate', 'ethernet', CAUSE_STATION_FRAMING],
    ]);

    const air = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === request && e.medium === 'air');
    expect(air.map((e) => [e.from.device, e.to.device])).toEqual([['laptop1', 'home1']]);
    expect(air[0]!.rateBps).toBeGreaterThan(0);
    expect(air[0]!.rssiDbm).toBe(association.rssiDbm);
  });

  it('ends a wrong passphrase in failed/wrong-key without a single data frame on the air', () => {
    const topo = homeWifi();
    const laptop = topologyDevice(topo, 'laptop1');
    laptop.config = laptop.config!.replace(`passphrase ${HOME_WIFI_PASSPHRASE}`, 'passphrase not-the-right-one');
    expect(laptop.config).toContain('passphrase not-the-right-one');
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topo);
    sim.runFor(120 * SEC);
    const evs = sim.trace(0).events;

    const states = laptopStates(evs);
    expect(states.filter((e) => e.state === 'handshake')).toHaveLength(KEY_ATTEMPTS);
    expect(states.filter((e) => e.state === 'failed' && e.reason === 'wrong-key')).toHaveLength(KEY_ATTEMPTS);
    expect(states.filter((e) => e.state === 'associated')).toEqual([]);
    expect(states.at(-1)).toMatchObject({ state: 'failed', reason: 'wrong-key' });
    const client = sim.device('laptop1')!.processes.get('wlan-client')!.stateSnapshot().state as {
      ports: { port: string; state: string; reason?: string; keyFailures: number }[];
    };
    expect(client.ports).toEqual([expect.objectContaining({ port: 'Wlan0', state: 'failed', reason: 'wrong-key', keyFailures: KEY_ATTEMPTS })]);
    expect(sim.device('laptop1')!.port('Wlan0')!.operUp).toBe(false);
    expect(sim.snapshot().media?.associations ?? []).toEqual([]);

    // every attempt stops after key message 2: the access point never answers a wrong key with message 3
    const eapol = ofKind(evs, 'frameTx').filter((e) => e.medium === 'air' && e.pdu.proto === 'eapol');
    expect(eapol.map((e) => sim.pdu(e.pdu.id)!.get('eapol.handshakeStep'))).toEqual([1, 2, 1, 2, 1, 2]);

    expect(ping(sim, 'laptop1', '192.168.1.10').text).not.toContain('received 5');
    const all = sim.trace(0).events;
    const air = ofKind(all, 'frameTx').filter((e) => e.medium === 'air');
    expect(air.length).toBeGreaterThan(0);
    expect(air.filter((e) => e.pdu.proto !== 'dot11-mgmt' && e.pdu.proto !== 'eapol')).toEqual([]);
    expect(ofKind(all, 'frameRx').filter((e) => e.device === 'pc1' && e.pdu.summary.includes('192.168.1.20'))).toEqual([]);
  });

  it('refuses a console on the home router, yet configures its LAN interface Vlan1 headlessly', () => {
    const topo = homeWifi();
    const home = topologyDevice(topo, 'home1');
    home.config = home.config!.replace(' ip address 192.168.1.1 255.255.255.0\n', '');
    expect(home.config).not.toContain('ip address');
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topo);
    sim.runFor(60 * SEC);

    expect(sim.cli.canOpen('home1', 'console')).toEqual({ ok: false, reason: CLI_MESSAGES.noShell });
    expect(() => sim.cli.open('home1', 'console')).toThrow(CLI_MESSAGES.noShell);
    expect(sim.device('home1')!.port('Vlan1')).toMatchObject({ operUp: true, l3: {} });
    expect(sim.device('laptop1')!.port('Wlan0')!.operUp).toBe(true);

    const cursor = sim.trace(0).next;
    const result = sim.configure('home1', ['interface Vlan1', ' ip address 192.168.1.1 255.255.255.0'], { indentation: true });
    expect(result).toMatchObject({ ok: true, applied: 1, finalMode: 'config-if' });
    expect(result.lines.map((l) => [l.ok, l.mode])).toEqual([
      [true, 'config-if'],
      [true, 'config-if'],
    ]);
    const evs = sim.trace(cursor).events;
    expect(ofKind(evs, 'configChange')).toMatchObject([
      { device: 'home1', line: 'ip address 192.168.1.1 255.255.255.0', negate: false, context: [['interface', 'Vlan1']] },
    ]);
    expect(evs.filter((e) => e.kind === 'cliPrompt' || e.kind === 'cliOutput')).toEqual([]);
    expect(sim.cli.sessions()).toEqual([]);
    expect(sim.device('home1')!.port('Vlan1')!.l3.ipv4).toEqual({ address: '192.168.1.1', prefixLen: 24 });
    expect(sim.snapshot().devices.find((d) => d.id === 'home1')!.runningConfig).toContain('interface Vlan1\n ip address 192.168.1.1 255.255.255.0');

    expect(ping(sim, 'laptop1', '192.168.1.1').text).toContain('Sent 5, received 5, lost 0');
  });
});
