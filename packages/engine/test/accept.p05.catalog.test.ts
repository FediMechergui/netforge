/**
 * P0.5 acceptance — the device catalog (ARCHITECTURE-P1 §10.1 `accept.p05.catalog`; D2, D7, D8, D13; docs/CATALOG.md).
 *
 * Every model of docs/CATALOG.md validates, is listed in palette order, boots through `runToIdle`, snapshots
 * structured-clone safe and reloads from its own export to an identical snapshot. Every module fits each compatible
 * slot with unique port names, ordinals and MACs (and comes out again), and is refused by every other slot. The web
 * half of the row, every model's icon resolving without the generic fallback, is apps/web/test/visuals.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { DEVICE_CATEGORIES, HARDWARE_MESSAGES, SLOT_ACCEPTS, moduleOrdinal, type ModuleModel, type SlotSpec } from '../src/contracts/catalog.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import { ALL_MODELS, ALL_MODULES, CATALOG_STAGE, builtInCatalogIssues } from '../src/device/catalog/index.js';
import { validateCatalog } from '../src/device/catalog/validate.js';
import { REGISTERED_PROCESSES } from '../src/protocols/index.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind } from './sim.harness.js';
import { device, topology } from './accept.p05.harness.js';

/** Model ids of docs/CATALOG.md: "Network devices", then "End devices", in document order. */
const CATALOG_MD_MODELS: readonly string[] = [
  'router.nf1941', 'router.nf2911', 'router.nf4331', 'router.nf4451', 'router.nfgeneric',
  'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
  'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48', 'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
  'hub.nfhub4', 'hub.nfhub8', 'hub.nfcoax', 'repeater.nfrep', 'bridge.nfbr2', 'bridge.nfbr4',
  'firewall.nfasa5506', 'firewall.nfngfw1120', 'ids.nfsensor',
  'ap.nfap-auto', 'ap.nfap-lw', 'ap.nfap-mesh', 'ap.nfap-ax', 'wlc.nfwlc3504',
  'wrouter.nfhome', 'wrouter.nfhome-ax', 'radio.nfptp5', 'radio.nfptp60', 'cell.nftower',
  'modem.nfdsl', 'modem.nfcable', 'modem.nfont', 'csu.nfcsu', 'cloud.nfinternet',
  'pc.nfpc', 'pc.nfpc-wifi', 'laptop.nflaptop', 'server.nfserver', 'server.nfrack',
  'phone.nfsmartphone', 'tablet.nftablet', 'tablet.nftablet-lte', 'ipphone.nfphone', 'printer.nfprinter',
  'tv.nfsmarttv', 'iot.nfsensor', 'iot.nfcamera', 'iot.nfthermostat', 'iot.nfplug', 'iot.nfgateway',
];

/** Module ids of docs/CATALOG.md, in document order. */
const CATALOG_MD_MODULES: readonly string[] = [
  'mod.ehwic-2t', 'mod.ehwic-4esg', 'mod.nim-2t', 'mod.nim-es2-4', 'mod.nim-2ge',
  'mod.sfp-1g-sx', 'mod.sfp-1g-lx', 'mod.sfp-10g-sr', 'mod.wlan-card',
];

/** Substitute the `{key}` fields of a HARDWARE_MESSAGES template. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Checks on a device right after `mod` went into `slot`: names, ordinals, MACs, canonical order, cage optics. */
function expectInstalled(dev: DeviceRuntime, slot: SlotSpec, mod: ModuleModel, where: string): void {
  const ports = [...dev.ports.values()];
  const physical = ports.filter((p) => p.spec.kind !== 'virtual');
  expect(new Set(ports.map((p) => p.id)).size, where).toBe(ports.length);
  expect(new Set(physical.map((p) => p.ordinal)).size, where).toBe(physical.length);
  expect(new Set(physical.map((p) => p.mac)).size, where).toBe(physical.length);
  // canonical port order: fixed ports, then module ports, then virtual ports
  const rank = ports.map((p) => (p.spec.kind === 'virtual' ? 2 : p.module !== undefined ? 1 : 0));
  expect(rank, where).toEqual([...rank].sort((x, y) => x - y));

  const added = ports.filter((p) => p.module !== undefined);
  if (mod.ports.length === 0) {
    expect(added, where).toEqual([]);
    expect(slot.cage, where).toBeDefined();
    expect(dev.port(slot.cage ?? '')?.transceiver, where).toBe(mod.type);
    return;
  }
  const names = mod.ports.flatMap((t) =>
    Array.from({ length: t.count }, (_, k) => {
      const index = (t.firstIndex ?? 0) + k;
      return t.absolute === true || slot.numbering === '' ? `${t.family}${index}` : `${t.family}${slot.numbering}/${index}`;
    }),
  );
  expect(added.map((p) => p.id), where).toEqual(names);
  added.forEach((p, i) => {
    const ordinal = moduleOrdinal(slot.slotIndex, i);
    expect([p.ordinal, p.mac, p.module], where).toEqual([ordinal, portMac(deviceMacBase(dev.id), ordinal), { slot: slot.id, module: mod.type }]);
  });
}

describe('accept P0.5: device catalog', () => {
  it('validates every model and module with every daemon registered', () => {
    expect(builtInCatalogIssues()).toEqual([]);
    expect(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: CATALOG_STAGE, processNames: REGISTERED_PROCESSES })).toEqual([]);
  });

  it('lists exactly the docs/CATALOG.md models and modules, in palette order', () => {
    const catalog = createSimulation({ seed: 1 }).catalog;
    const list = catalog.list();
    const types = list.map((m) => m.type);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...CATALOG_MD_MODELS].sort());
    for (const m of list) expect(catalog.get(m.type)).toBe(m);

    const rank = list.map((m) => DEVICE_CATEGORIES.findIndex((c) => c.id === m.category));
    expect(rank.every((r) => r >= 0)).toBe(true);
    expect(rank).toEqual([...rank].sort((x, y) => x - y));
    expect(new Set(rank).size).toBe(DEVICE_CATEGORIES.length);
    for (const category of DEVICE_CATEGORIES) {
      const inCategory = list.filter((m) => m.category === category.id).map((m) => m.type);
      expect(inCategory, category.id).toEqual(CATALOG_MD_MODELS.filter((t) => inCategory.includes(t)));
    }
    expect(catalog.modules?.().map((m) => m.type)).toEqual(CATALOG_MD_MODULES);
  });

  it('boots every model, snapshots it structured-clone safe and reloads its export to an identical snapshot', () => {
    for (const model of createSimulation({ seed: 1 }).catalog.list()) {
      const first = createSimulation({ seed: 5 });
      first.loadTopology(topology([device('d1', model.type, 'D1', 0, 0)], []));
      expect(first.runToIdle(200_000).events, model.type).toBeLessThan(200_000);

      const dev = first.device('d1')!;
      expect(dev.bootedAt, model.type).toBe(model.bootNs);
      expect([...dev.processes.keys()], model.type).toEqual([...model.processes]);
      const problems = ofKind(first.trace(0).events, 'log').filter((e) => /not available|unknown interface/i.test(e.message));
      expect(problems, model.type).toEqual([]);

      const snapshot = first.snapshot();
      const json = JSON.stringify(snapshot);
      expect(JSON.stringify(structuredClone(snapshot)), model.type).toBe(json);
      expect(snapshot.devices[0], model.type).toMatchObject({
        type: model.type,
        model: model.model,
        kind: model.kind,
        category: model.category,
        icon: model.icon,
        power: true,
        booted: true,
      });
      expect(snapshot.devices[0]!.capabilities, model.type).toEqual(model.capabilities);

      const second = createSimulation({ seed: 5 });
      second.loadTopology(first.exportTopology());
      expect(second.runToIdle(200_000).events, model.type).toBeLessThan(200_000);
      expect(JSON.stringify(second.snapshot()), model.type).toBe(json);
    }
  }, 120_000);

  it('fits every module into each compatible slot with unique port names, ordinals and MACs, and refuses the other slots', () => {
    const catalog = createSimulation({ seed: 1 }).catalog;
    const modules = catalog.modules!();
    const fitted = new Set<string>();
    for (const model of catalog.list()) {
      const slots = model.slots ?? [];
      if (slots.length === 0) continue;
      const sim = createSimulation({ seed: 1 });
      sim.addDevice({ id: 'dev', type: model.type, modules: [], power: false });
      const dev = sim.device('dev')!;
      const bare = [...dev.ports.keys()];
      for (const slot of slots) {
        for (const mod of modules) {
          const where = `${model.type} slot ${slot.id} ${mod.type}`;
          const result = sim.insertModule('dev', slot.id, mod.type);
          if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) {
            expect(result, where).toEqual({
              ok: false,
              code: 'does-not-fit',
              error: fill(HARDWARE_MESSAGES['does-not-fit'], { module: mod.model, slotType: slot.type }),
            });
            continue;
          }
          expect(result, where).toEqual({ ok: true });
          fitted.add(mod.type);
          expectInstalled(dev, slot, mod, where);
          expect(sim.removeModule('dev', slot.id), where).toEqual({ ok: true });
          expect([...dev.ports.keys()], where).toEqual(bare);
        }
      }
    }
    expect([...fitted].sort()).toEqual([...CATALOG_MD_MODULES].sort());
  }, 120_000);
});
