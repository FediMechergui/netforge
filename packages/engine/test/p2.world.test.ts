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
import {
  P2_CAPABILITY_PROCESS_ROWS,
  P2_DAEMONS,
  P2_MODEL_DELTAS,
  P2_PROCESS_ORDER,
  applyP2ModelDelta,
  createP2Catalog,
  createP2Simulation,
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
