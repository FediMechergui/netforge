/**
 * test/p2.world.ts (ARCHITECTURE-P2 §0 rule 13, §7 W1 qa): P2-stage worlds from the real model inputs, the flips'
 * model-data deltas, `defineModel(…, 'P2')` and the later `CAPABILITY_PROCESSES` rows filtered to the registry.
 *
 * Every assertion here holds before AND after the W4/W6 catalog flips: the registries are spelled out with
 * `onlyP2(...)`, which removes every P2 daemon that is not named, so a daemon the flip registers later cannot change
 * the expected lists.
 */
import { describe, expect, it } from 'vitest';
import { PROCESS_ORDER, expandCapabilities, isVlanAware } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ALL_MODEL_INPUTS, ALL_MODELS } from '../src/device/catalog.js';
import { defineModel, deriveTables } from '../src/device/catalog/define.js';
import { NF_C2960_INPUT } from '../src/device/catalog/switches.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { NF_AP_1832_INPUT } from '../src/device/catalog/wireless.js';
import {
  CAPWAP_TUNNEL_FAMILY,
  NF_WLC_9800_TEST_INPUT,
  P2_CAPABILITY_PROCESS_ROWS,
  P2_DAEMONS,
  P2_MODEL_DELTAS,
  P2_PROCESS_ORDER,
  P2_WIRELESS_MODEL_DELTAS,
  applyP2ModelDelta,
  createP2Catalog,
  createP2Simulation,
  p2ModelDeltaFor,
  p2ModelInputs,
  p2Registry,
  type P2FactoryOverlay,
} from './p2.world.js';

/** A silent daemon: answers nothing, sends nothing, keeps no state. */
function stub(name: ProcessName): ProcessFactory {
  return () => ({
    name,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: () => ({ process: name, state: {} }),
    debugEvents: () => [],
  });
}

/** An overlay that gives the named P2 daemons a silent stub and removes every other P2 daemon. */
function onlyP2(...names: ProcessName[]): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = names.includes(p) ? stub(p) : undefined;
  return out;
}

const P1_SWITCH_DAEMONS: readonly ProcessName[] = ['eth-switch', 'arp', 'ipv4', 'icmpv4', 'host'];
const missing = (events: readonly TraceEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'log' && e.message.includes('is not available') ? [e.message] : []));

describe('p2.world data', () => {
  it('P2_PROCESS_ORDER keeps the contract order of every P1 daemon and adds exactly the approved P2 daemons', () => {
    const p1 = PROCESS_ORDER.filter((p) => !P2_DAEMONS.includes(p));
    expect(P2_PROCESS_ORDER.filter((p) => p1.includes(p))).toEqual(p1);
    expect(P2_PROCESS_ORDER.filter((p) => !p1.includes(p))).toEqual([
      'capwap-wtp', 'vlan', 'dtp', 'etherchannel', 'stp', 'nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server', 'capwap-ac',
    ]);
    expect(new Set(P2_PROCESS_ORDER).size).toBe(P2_PROCESS_ORDER.length);
    expect(P2_PROCESS_ORDER).not.toContain('vtp');
    expect(P2_PROCESS_ORDER).not.toContain('radius-server');
    for (const rows of Object.values(P2_CAPABILITY_PROCESS_ROWS)) for (const p of rows ?? []) expect(P2_PROCESS_ORDER).toContain(p);
  });

  it('the W4 deltas make exactly the nine managed switches managed, and are idempotent', () => {
    const managed = ALL_MODEL_INPUTS.filter((i) => applyP2ModelDelta(i).capabilities.includes('managed-switch')).map((i) => i.type);
    expect(managed).toEqual([
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48', 'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
    ]);
    expect(Object.keys(P2_MODEL_DELTAS)).toEqual(managed);
    const once = applyP2ModelDelta(NF_C2960_INPUT);
    expect(once).not.toBe(NF_C2960_INPUT);
    expect(expandCapabilities(once.capabilities)).toEqual(['switching', 'managed-switch']);
    expect(once.capabilities.filter((c) => c === 'managed-switch')).toHaveLength(1);
    expect(applyP2ModelDelta(once)).toEqual(once);
    const c9300 = ALL_MODEL_INPUTS.find((i) => i.type === 'mlswitch.nfc9300-48')!;
    expect(applyP2ModelDelta(c9300)).toMatchObject({ stpDefaultMode: 'rapid-pvst' });
    expect(applyP2ModelDelta({ ...c9300, stpDefaultMode: 'pvst' } as typeof c9300)).toMatchObject({ stpDefaultMode: 'pvst' });
    expect(applyP2ModelDelta(NF_C2960_INPUT)).not.toHaveProperty('stpDefaultMode');
    const hub = ALL_MODEL_INPUTS.find((i) => i.type === 'hub.nfhub4')!;
    expect(applyP2ModelDelta(hub)).toBe(hub);
  });

  it('p2Registry lays the overlay over PROCESS_FACTORIES: a factory wins, undefined removes', () => {
    const vlan = stub('vlan');
    const r = p2Registry({ vlan, arp: undefined });
    expect(r['vlan']).toBe(vlan);
    expect('arp' in r).toBe(false);
    expect(r['ipv4']).toBe(PROCESS_FACTORIES['ipv4']);
    expect(Object.isFrozen(r)).toBe(true);
    expect(PROCESS_FACTORIES['arp']).toBeDefined();
  });
});

describe('p2.world models', () => {
  it('a P2 NF-C2960 with a vlan factory is VLAN-aware', () => {
    const model = createP2Catalog(onlyP2('vlan')).get('switch.nfc2960')!;
    expect(isVlanAware(model)).toBe(true);
    expect(model.capabilities).toEqual(['switching', 'managed-switch']);
    expect(model.processes).toEqual(['eth-switch', 'vlan', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(model.tables).toEqual(deriveTables(model.processes));
    expect(model.tables).toContain('vlans');
    expect(model.tables).toContain('port-security');
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.processes)).toBe(true);
  });

  it('a P2 daemon without a factory is filtered out, and the rest keep the final order', () => {
    const none = createP2Catalog(onlyP2());
    const sw = none.get('switch.nfc2960')!;
    expect(sw.processes).toEqual(P1_SWITCH_DAEMONS);
    expect(isVlanAware(sw)).toBe(false);
    for (const t of ['vlans', 'dtp', 'stp', 'stp-bridge', 'etherchannel', 'port-security']) expect(sw.tables).not.toContain(t);

    const all = createP2Catalog(onlyP2(...P2_DAEMONS));
    expect(all.get('switch.nfc2960')!.processes).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'icmpv4', 'host']);
    const mls = all.get('mlswitch.nfc3650-24')!.processes;
    expect(mls.filter((p) => P2_DAEMONS.includes(p))).toEqual(['vlan', 'dtp', 'etherchannel', 'stp', 'nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server']);
    expect(mls.indexOf('vlan')).toBe(mls.indexOf('eth-switch') + 1);
    const router = all.get('router.nf2911')!.processes;
    expect(router.filter((p) => P2_DAEMONS.includes(p))).toEqual(['nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server']);
    expect(router.indexOf('nat')).toBe(router.indexOf('ipv4') + 1);
    expect(all.get('pc.nfpc')!.processes.filter((p) => P2_DAEMONS.includes(p))).toEqual(['dhcpv6-client']);

    const noStp = createP2Catalog(onlyP2('vlan', 'dtp', 'etherchannel')).get('switch.nfc2960')!;
    expect(noStp.processes).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(noStp.tables).not.toContain('stp-bridge');

    for (const m of all.list()) {
      const ranks = m.processes.map((p) => P2_PROCESS_ORDER.indexOf(p));
      expect(ranks.every((r) => r >= 0)).toBe(true);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  it("holds every real model in palette order and keeps each one's P1 daemons in order", () => {
    const catalog = createP2Catalog(onlyP2(...P2_DAEMONS));
    const types = catalog.list().map((m) => m.type);
    const real = ALL_MODELS.map((m) => m.type);
    expect(types.filter((t) => real.includes(t))).toEqual(real);
    for (const model of ALL_MODELS) {
      const p1 = model.processes.filter((p) => !P2_DAEMONS.includes(p));
      expect(catalog.get(model.type)!.processes.filter((p) => p1.includes(p))).toEqual(p1);
    }
  });

  it('P1-stage models are untouched', () => {
    const inputs = JSON.stringify(ALL_MODEL_INPUTS);
    const models = JSON.stringify(ALL_MODELS);
    const p1Switch = defineModel(NF_C2960_INPUT, 'P1');
    createP2Catalog(onlyP2(...P2_DAEMONS));
    createP2Simulation({ seed: 1, factories: onlyP2('vlan') });
    expect(JSON.stringify(ALL_MODEL_INPUTS)).toBe(inputs);
    expect(JSON.stringify(ALL_MODELS)).toBe(models);
    expect(defineModel(NF_C2960_INPUT, 'P1')).toEqual(p1Switch);
    expect(isVlanAware(p1Switch)).toBe(false);
    // D5: a model defined at stage P1 is never VLAN-aware, whatever its capabilities
    const p1Managed = defineModel(applyP2ModelDelta(NF_C2960_INPUT), 'P1');
    expect(p1Managed.capabilities).toContain('managed-switch');
    expect(isVlanAware(p1Managed)).toBe(false);
    // models with no delta and no P2 row derive the same daemons, tables and owners at both stages
    const p2 = createP2Catalog(onlyP2(...P2_DAEMONS));
    for (const type of ['hub.nfhub4', 'modem.nfdsl', 'radio.nfptp5', 'cell.nftower', 'bridge.nfbr2']) {
      const mine = p2.get(type)!;
      const real = ALL_MODELS.find((m) => m.type === type)!;
      expect({ c: mine.capabilities, p: mine.processes, t: mine.tables, o: mine.portOwners }).toEqual({
        c: real.capabilities,
        p: real.processes,
        t: real.tables,
        o: real.portOwners,
      });
    }
    expect(p2.get('modem.nfdsl')!.processes).toEqual(['eth-switch']);
  });
});

describe('createP2Simulation', () => {
  it("builds a world from the P2 catalog, in the P2 profile unless told otherwise", () => {
    const sim = createP2Simulation({ seed: 1, factories: onlyP2('vlan') });
    expect(sim.profile).toBe('P2');
    expect(isVlanAware(sim.catalog.get('switch.nfc2960')!)).toBe(true);
    expect(createP2Simulation({ seed: 1, profile: 'P1' }).profile).toBe('P1');
    expect(createP2Simulation({ seed: 1, factories: onlyP2() }).catalog.get('switch.nfc2960')!.processes).toEqual(P1_SWITCH_DAEMONS);
  });

  it('boots a real world with the stubbed daemon and logs no missing daemon', () => {
    const sim = createP2Simulation({ seed: 4, profile: 'P1', factories: onlyP2('vlan') });
    const sw = sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runFor(40 * SEC);
    expect(sim.device(sw)!.processes.has('vlan')).toBe(true);
    expect(sim.device('pc1')!.processes.has('dhcpv6-client')).toBe(false);
    expect(missing(sim.trace(0).events)).toEqual([]);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runFor(10 * SEC);
    const replies = sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
  });

  it('two worlds built with the same inputs are byte-identical', () => {
    const build = (): string => {
      const sim = createP2Simulation({ seed: 9, profile: 'P1', factories: onlyP2('vlan') });
      sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
      sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
      sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
      sim.runFor(40 * SEC);
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(build()).toBe(build());
  });
});

describe('p2.world wireless deltas (W6 model data, test-only for W5)', () => {
  it('NF-AP-1832 gains lightweight-ap (idempotently) while the W4 delta list stays the nine managed switches', () => {
    expect(Object.keys(P2_WIRELESS_MODEL_DELTAS)).toEqual(['ap.nfap-lw']);
    expect(P2_MODEL_DELTAS).not.toHaveProperty('ap.nfap-lw');
    expect(p2ModelDeltaFor('ap.nfap-lw')).toEqual({ addCapabilities: ['lightweight-ap'] });
    expect(p2ModelDeltaFor('switch.nfc2960')).toEqual(P2_MODEL_DELTAS['switch.nfc2960']);
    expect(p2ModelDeltaFor('mlswitch.nfc9300-48')).toEqual(P2_MODEL_DELTAS['mlswitch.nfc9300-48']);
    expect(p2ModelDeltaFor('hub.nfhub4')).toBeUndefined();
    const once = applyP2ModelDelta(NF_AP_1832_INPUT);
    expect(once).not.toBe(NF_AP_1832_INPUT);
    expect(once.capabilities).toEqual(['wifi-ap', 'poe-powered', 'lightweight-ap']);
    expect(expandCapabilities(once.capabilities)).toEqual(['wifi-ap', 'poe-powered', 'lightweight-ap']);
    expect(applyP2ModelDelta(once)).toEqual(once);
    expect(NF_AP_1832_INPUT.capabilities).toEqual(['wifi-ap', 'poe-powered']);
  });

  it('the lightweight AP model derives its P2 profile lines and its daemons, capwap-wtp only with a factory', () => {
    const without = createP2Catalog(onlyP2()).get('ap.nfap-lw')!;
    expect(without.capabilities).toEqual(['wifi-ap', 'poe-powered', 'lightweight-ap']);
    expect(without.processes).toEqual(['wlan-ap', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'dhcp-client']);
    expect(without.tables).not.toContain('capwap');
    expect(without.profileConfig).toEqual({ P2: ['capwap enable', 'interface Vlan1', ' ip address dhcp', ' no shutdown'] });
    const withWtp = createP2Catalog(onlyP2('capwap-wtp')).get('ap.nfap-lw')!;
    expect(withWtp.processes).toEqual(['wlan-ap', 'capwap-wtp', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'dhcp-client']);
    expect(withWtp.tables).toContain('capwap');
    // the other access points are untouched
    const none = createP2Catalog(onlyP2());
    for (const type of ['ap.nfap-auto', 'ap.nfap-mesh', 'ap.nfap-ax']) {
      const m = none.get(type)!;
      expect(m.capabilities).not.toContain('lightweight-ap');
      expect(m.profileConfig).toBeUndefined();
      expect(m.processes).not.toContain('dhcp-client');
    }
  });

  it('NF-WLC-9800 is a test-only wireless-controller model before NF-WLC-3504 in palette order', () => {
    const types = p2ModelInputs().map((i) => i.type);
    expect(types.indexOf('wlc.nfwlc9800')).toBe(types.indexOf('wlc.nfwlc3504') - 1);
    expect(types.filter((t) => t !== 'wlc.nfwlc9800')).toEqual(ALL_MODEL_INPUTS.map((i) => i.type));
    expect(ALL_MODEL_INPUTS.some((i) => i.type === 'wlc.nfwlc9800')).toBe(false);
    expect(Object.isFrozen(NF_WLC_9800_TEST_INPUT)).toBe(true);

    const model = createP2Catalog(onlyP2('vlan')).get('wlc.nfwlc9800')!;
    expect(model.kind).toBe('wlc');
    expect(model.model).toBe('NF-WLC-9800');
    expect(model.capabilities).toEqual(['switching', 'wireless-controller']);
    expect(model.processes).toEqual(['eth-switch', 'vlan', 'arp', 'ipv4', 'icmpv4', 'host', 'udp']);
    expect(isVlanAware(model)).toBe(true);
    expect(model.cli).toEqual({ shell: 'none', grammar: 'nfos', initialPrivilege: 1, consoleVia: [] });
    expect(model.gui).toContain('wlc.controller');
    expect(model.ports.map((p) => p.name)).toEqual(['GigabitEthernet0/1', 'GigabitEthernet0/2', 'GigabitEthernet0/3', 'GigabitEthernet0/4', 'Console']);
    expect(model.ports.filter((p) => p.kind === 'ethernet').every((p) => p.role === 'switched')).toBe(true);
    expect(model.virtualFamilies).toEqual([expect.objectContaining({ family: 'Vlan', role: 'svi', max: 4094 }), CAPWAP_TUNNEL_FAMILY]);
    expect(model.defaultConfig).toBeUndefined();
    expect(model.portOwners['wlan-tunnel']).toBeUndefined();
    expect(model.tables).not.toContain('capwap-aps');

    const withAc = createP2Catalog(onlyP2('vlan', 'capwap-ac')).get('wlc.nfwlc9800')!;
    expect(withAc.processes).toEqual(['eth-switch', 'vlan', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'capwap-ac']);
    expect(withAc.portOwners['wlan-tunnel']).toBe('capwap-ac');
    expect(withAc.tables).toEqual(expect.arrayContaining(['capwap-aps', 'wlan-clients']));
    expect(JSON.parse(JSON.stringify(withAc))).toEqual(withAc);
  });

  it('a controller and a lightweight AP build in a real world: Capwap0 exists, the P2 profile replays the AP lines, no daemon is missing', () => {
    const sim = createP2Simulation({ seed: 6, factories: onlyP2('vlan') });
    sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1' });
    sim.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addLink({ id: 'l_wlc', a: { device: 'wlc1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addLink({ id: 'l_lap', a: { device: 'lap1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runFor(70 * SEC);
    const wlc = sim.device('wlc1')!;
    expect(wlc.port('Capwap0')).toMatchObject({ role: 'wlan-tunnel', adminUp: true });
    expect(wlc.processes.has('vlan')).toBe(true);
    expect(wlc.processes.has('capwap-ac')).toBe(false);
    const lap = sim.device('lap1')!;
    expect(lap.processes.has('dhcp-client')).toBe(true);
    expect(lap.processes.has('capwap-wtp')).toBe(false);
    const running = lap.running.render();
    expect(running).toContain('capwap enable');
    expect(running).toMatch(/interface Vlan1\n ip address dhcp\n!/);
    expect(lap.port('Vlan1')).toMatchObject({ adminUp: true });
    expect(missing(sim.trace(0).events)).toEqual([]);
    // the P1 profile replays nothing on the AP
    const p1 = createP2Simulation({ seed: 6, profile: 'P1', factories: onlyP2('vlan') });
    p1.addDevice({ id: 'lap1', type: 'ap.nfap-lw', name: 'LAP1' });
    p1.runFor(70 * SEC);
    expect(p1.device('lap1')!.running.render()).not.toContain('capwap');
  });
});
