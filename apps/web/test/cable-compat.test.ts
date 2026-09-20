// Cable picker model (ARCHITECTURE-P1 §7, §8.1 W2 web-inspector): picker rows, compatible-port filter driven by
// the engine's cable validator, serial DCE-end hints and link requests keyed by media.
import { describe, expect, it } from 'vitest';
import { MEDIA, defineModel, defineModule, emptyCounters } from '@netforge/engine';
import type { DeviceModel, DeviceSnapshot, ModuleModel, PortSnapshot, PortSpec, SimSnapshot } from '@netforge/engine';
import {
  DEFAULT_CABLE_LENGTH_M,
  addLinkSpecFor,
  buildCableLookup,
  cableEndFor,
  cablePickerItems,
  compatibleTargets,
  effectiveCableMedia,
  isPickablePort,
  mediaFitsPortKind,
  portCompatibility,
  serialDceHint,
  validationKey,
  verdictText,
} from '../src/app/cable/cable-compat.js';
import { MEDIA_PICKER_ORDER } from '../src/vocab/media.js';

const GIG = 1_000_000_000;

const PC = defineModel({
  type: 'pc.nfpc', model: 'NF-PC', description: 'Workstation', category: 'computers', icon: 'pc', capabilities: ['host'],
  ports: [{ name: 'GigabitEthernet0', kind: 'ethernet', speedBps: GIG, autoMdix: false }],
}, 'P0.5');
const SWITCH = defineModel({
  type: 'switch.nfsw', model: 'NF-SW', description: 'Switch', category: 'switches', icon: 'switch', capabilities: ['switching'],
  ports: [
    { name: 'FastEthernet0/1', kind: 'ethernet', speedBps: 100_000_000, autoMdix: false },
    { name: 'FastEthernet0/2', kind: 'ethernet', speedBps: 100_000_000, autoMdix: false },
    { name: 'GigabitEthernet0/1', kind: 'ethernet', speedBps: GIG, connector: 'sfp' },
  ],
}, 'P0.5');
const ROUTER = defineModel({
  type: 'router.nfr', model: 'NF-R', description: 'Router', category: 'routers', icon: 'router', capabilities: ['routing'],
  ports: [
    { name: 'GigabitEthernet0/0', kind: 'ethernet', speedBps: GIG, autoMdix: false },
    { name: 'Serial0/0/0', kind: 'serial', speedBps: 2_000_000 },
    { name: 'Console', kind: 'console', speedBps: 9_600 },
    { name: 'GigabitEthernet0/1', kind: 'ethernet', speedBps: GIG, connector: 'sfp' },
  ],
}, 'P0.5');
const AP = defineModel({
  type: 'ap.nfap', model: 'NF-AP', description: 'Access point', category: 'wireless', icon: 'ap', capabilities: ['wifi-ap'],
  ports: [
    { name: 'GigabitEthernet0', kind: 'ethernet', speedBps: GIG, autoMdix: true },
    {
      name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000,
      radio: { bands: ['2.4'], generations: ['n'], defaultBand: '2.4', defaultChannel: 1, maxTxPowerDbm: 20, antennaGainDbi: 2, streams: 2, maxWidthMhz: 40, maxRangeM: 300 },
    },
  ],
}, 'P0.5');
const SX: ModuleModel = defineModule({
  type: 'mod.sfp-1g-sx', model: 'NF-SFP-1G-SX', description: 'Multimode optics', fits: 'sfp', ports: [],
  transceiver: { connector: 'lc', mode: 'mm', speedBps: GIG, maxLengthM: 550, wavelengthNm: 850 },
});

/** Snapshot port from a catalog spec (P0.5 fields included unless `p0` strips them). */
function snapPort(spec: PortSpec, extra: Partial<PortSnapshot> = {}, p0 = false): PortSnapshot {
  const base: PortSnapshot = {
    id: spec.name, short: spec.short, kind: spec.kind, mac: '02:00:00:00:00:01', adminUp: true, operUp: false, mtu: 1500,
    counters: emptyCounters(), l3: {}, txQueue: 0,
  };
  if (!p0) {
    if (spec.role !== undefined) base.role = spec.role;
    if (spec.connector !== undefined) base.connector = spec.connector;
    if (spec.wiring !== undefined) base.wiring = spec.wiring;
    if (spec.autoMdix !== undefined) base.autoMdix = spec.autoMdix;
  }
  return { ...base, ...extra };
}

function snapDevice(id: string, name: string, model: DeviceModel, ports?: PortSnapshot[], p0 = false): DeviceSnapshot {
  return {
    id, type: model.type, model: model.model, kind: model.kind, name, position: { x: 0, y: 0 }, power: true, booted: true, uptimeNs: 0,
    ports: ports ?? model.ports.map((p) => snapPort(p, {}, p0)), tables: { cam: [], arp: [], rib: [] }, processes: [],
    runningConfig: '', hasStartupConfig: false,
  };
}

const port = (m: DeviceModel, name: string): PortSpec => m.ports.find((p) => p.name === name)!;

const PC1 = snapDevice('pc1', 'PC1', PC);
const PC2 = snapDevice('pc2', 'PC2', PC);
const SW1 = snapDevice('sw1', 'SW1', SWITCH, [
  snapPort(port(SWITCH, 'FastEthernet0/1')),
  snapPort(port(SWITCH, 'FastEthernet0/2'), { link: 'l_1' }),
  snapPort(port(SWITCH, 'GigabitEthernet0/1'), { transceiver: 'mod.sfp-1g-sx' }),
]);
const R1 = snapDevice('r1', 'R1', ROUTER);
const R2 = snapDevice('r2', 'R2', ROUTER);
const AP1 = snapDevice('ap1', 'AP1', AP);
const SNAP: Pick<SimSnapshot, 'devices'> = { devices: [PC1, PC2, SW1, R1, R2, AP1] };
const LOOKUP = buildCableLookup([PC, SWITCH, ROUTER, AP], [SX]);

const at = (device: string, p: string) => ({ device, port: p });

describe('picker rows', () => {
  it('lists the picker media with auto first and marks media missing from the worker table', () => {
    const all = cablePickerItems();
    expect(all.map((i) => i.media)).toEqual(MEDIA_PICKER_ORDER);
    expect(all[0]!.media).toBe('auto');
    expect(all.every((i) => i.available)).toBe(true);
    expect(all.find((i) => i.media === 'serial-dce')?.dceHint).toContain('first port');
    expect(all.find((i) => i.media === 'copper-straight')?.dceHint).toBeUndefined();
    const limited = cablePickerItems([{ media: 'auto' }, { media: 'copper-straight' }]);
    expect(limited.filter((i) => i.available).map((i) => i.media)).toEqual(['auto', 'copper-straight']);
    expect(effectiveCableMedia('coax', [{ media: 'auto' }])).toBe('auto');
    expect(effectiveCableMedia('coax')).toBe('coax');
    expect(effectiveCableMedia('bogus')).toBe('auto');
  });

  it('applies the MEDIA port-kind rule', () => {
    expect(mediaFitsPortKind('auto', 'serial')).toBe(true);
    expect(mediaFitsPortKind('auto', 'wlan')).toBe(false);
    expect(mediaFitsPortKind('copper-straight', 'ethernet')).toBe(true);
    expect(mediaFitsPortKind('serial-dce', 'ethernet')).toBe(false);
    for (const m of MEDIA_PICKER_ORDER) if (m !== 'auto') for (const k of MEDIA[m].portKinds) expect(mediaFitsPortKind(m, k)).toBe(true);
  });
});

describe('port compatibility before the first click', () => {
  const map = portCompatibility(SNAP, LOOKUP, null, 'copper-straight');

  it('hides radios and marks occupied, eligible and unfitting ports', () => {
    expect(map.get('ap1/Wlan0')?.status).toBe('hidden');
    expect(map.get('ap1/Wlan0')?.enabled).toBe(false);
    expect(map.get('sw1/FastEthernet0/2')?.status).toBe('occupied');
    expect(map.get('sw1/FastEthernet0/2')?.reason).toBe('SW1 FastEthernet0/2 already has a connection.');
    expect(map.get('pc1/GigabitEthernet0')?.status).toBe('eligible');
    expect(map.get('pc1/GigabitEthernet0')?.enabled).toBe(true);
    const serial = map.get('r1/Serial0/0/0');
    expect(serial?.status).toBe('incompatible');
    expect(serial?.code).toBe('media-mismatch');
    expect(serial?.reason).toBe('The straight-through copper does not fit R1 Serial0/0/0, which is a Serial port.');
  });

  it('keys every port of every device in snapshot order', () => {
    const expected = SNAP.devices.flatMap((d) => d.ports.map((p) => `${d.id}/${p.id}`));
    expect([...map.keys()]).toEqual(expected);
    expect(isPickablePort({ kind: 'virtual' })).toBe(false);
    expect(isPickablePort({ kind: 'ethernet', role: 'svi' })).toBe(false);
    expect(isPickablePort({ kind: 'radio', role: 'radio-ptp' })).toBe(true);
    expect(isPickablePort({ kind: 'ethernet', linkable: false })).toBe(false);
  });
});

describe('port compatibility from a source port', () => {
  it('follows copper wiring: straight joins MDI to MDI-X, crossover joins equal sides', () => {
    const straight = portCompatibility(SNAP, LOOKUP, at('pc1', 'GigabitEthernet0'), 'copper-straight');
    expect(straight.get('pc1/GigabitEthernet0')?.status).toBe('source');
    expect(straight.get('pc1/GigabitEthernet0')?.enabled).toBe(true);
    expect(straight.get('sw1/FastEthernet0/1')?.status).toBe('compatible');
    expect(straight.get('pc2/GigabitEthernet0')?.status).toBe('incompatible');
    expect(straight.get('pc2/GigabitEthernet0')?.code).toBe('media-mismatch');
    expect(straight.get('pc2/GigabitEthernet0')?.reason).toContain('PC1 GigabitEthernet0');
    const cross = portCompatibility(SNAP, LOOKUP, at('pc1', 'GigabitEthernet0'), 'copper-crossover');
    expect(cross.get('pc2/GigabitEthernet0')?.status).toBe('compatible');
    expect(cross.get('sw1/FastEthernet0/1')?.status).toBe('incompatible');
    expect(cross.get('ap1/GigabitEthernet0')?.status).toBe('compatible');
  });

  it('reports the cable automatic selection would create', () => {
    const auto = portCompatibility(SNAP, LOOKUP, at('pc1', 'GigabitEthernet0'), 'auto');
    expect(auto.get('sw1/FastEthernet0/1')?.resolvedMedia).toBe('copper-straight');
    expect(auto.get('pc2/GigabitEthernet0')?.resolvedMedia).toBe('copper-crossover');
    expect(auto.get('r1/Serial0/0/0')?.status).toBe('incompatible');
    expect(compatibleTargets(SNAP, LOOKUP, at('r1', 'Serial0/0/0'), 'serial-dce').map((v) => `${v.ref.device}/${v.ref.port}`)).toEqual(['r2/Serial0/0/0']);
  });

  it('refuses both ends on one device and checks optics from the module catalog', () => {
    const same = portCompatibility(SNAP, LOOKUP, at('r1', 'GigabitEthernet0/0'), 'copper-crossover');
    expect(same.get('r1/GigabitEthernet0/1')?.status).toBe('incompatible');
    const fromCage = portCompatibility(SNAP, LOOKUP, at('sw1', 'GigabitEthernet0/1'), 'fiber-mm');
    expect(fromCage.get('r2/GigabitEthernet0/1')?.code).toBe('no-transceiver');
    const withOptics = snapDevice('r3', 'R3', ROUTER, [...R2.ports.slice(0, 3), snapPort(port(ROUTER, 'GigabitEthernet0/1'), { transceiver: 'mod.sfp-1g-sx' })]);
    const snap = { devices: [SW1, withOptics] };
    expect(portCompatibility(snap, LOOKUP, at('sw1', 'GigabitEthernet0/1'), 'fiber-mm').get('r3/GigabitEthernet0/1')?.status).toBe('compatible');
    expect(portCompatibility(snap, LOOKUP, at('sw1', 'GigabitEthernet0/1'), 'fiber-sm').get('r3/GigabitEthernet0/1')?.code).toBe('sfp-mismatch');
    expect(portCompatibility(snap, LOOKUP, at('sw1', 'GigabitEthernet0/1'), 'fiber-mm', { lengthM: 900 }).get('r3/GigabitEthernet0/1')?.code).toBe('too-long');
  });

  it('fills P0-shaped snapshot ports from the catalog so verdicts do not change', () => {
    const p0 = { devices: [snapDevice('pc1', 'PC1', PC, undefined, true), snapDevice('pc2', 'PC2', PC, undefined, true), snapDevice('sw1', 'SW1', SWITCH, undefined, true)] };
    const end = cableEndFor(LOOKUP, p0.devices[2]!, p0.devices[2]!.ports[0]!);
    expect(end).toMatchObject({ kind: 'ethernet', role: 'switched', wiring: 'MDI-X', connector: 'rj45', speedBps: 100_000_000, label: 'SW1 FastEthernet0/1', device: 'sw1' });
    const map = portCompatibility(p0, LOOKUP, at('pc1', 'GigabitEthernet0'), 'copper-straight');
    expect(map.get('sw1/FastEthernet0/1')?.status).toBe('compatible');
    expect(map.get('pc2/GigabitEthernet0')?.status).toBe('incompatible');
    // Without catalog data a P0 port carries no role or wiring, so both ends read as MDI (no device-kind fallback, D2).
    const bare = portCompatibility(p0, buildCableLookup(), at('pc1', 'GigabitEthernet0'), 'copper-straight');
    expect(bare.get('sw1/FastEthernet0/1')?.status).toBe('incompatible');
    expect(bare.get('sw1/FastEthernet0/1')?.code).toBe('media-mismatch');
  });

  it('offers a console cable from a device console line to computers only (host shell = terminal end)', () => {
    expect(cableEndFor(LOOKUP, PC1, PC1.ports[0]!).hostTerminal).toBe(true);
    expect(cableEndFor(LOOKUP, SW1, SW1.ports[0]!).hostTerminal).toBeUndefined();
    const rollover = portCompatibility(SNAP, LOOKUP, at('r1', 'Console'), 'console');
    expect(rollover.get('pc1/GigabitEthernet0')?.status).toBe('compatible');
    expect(rollover.get('sw1/FastEthernet0/1')?.status).toBe('incompatible');
    expect(rollover.get('r2/Console')?.status).toBe('incompatible');
    expect(rollover.get('r2/Console')?.reason).toContain('both ends are device console lines');
    expect(portCompatibility(SNAP, LOOKUP, at('pc1', 'GigabitEthernet0'), 'auto').get('r1/Console')?.resolvedMedia).toBe('console');
  });

  it('treats a vanished source as incompatible', () => {
    const map = portCompatibility(SNAP, LOOKUP, at('ghost', 'Gi0'), 'auto');
    expect(map.get('pc1/GigabitEthernet0')?.status).toBe('incompatible');
  });
});

describe('DCE hint and link requests', () => {
  it('names the DCE end per serial media', () => {
    const a = at('r1', 'Serial0/0/0');
    const b = at('r2', 'Serial0/0/0');
    expect(serialDceHint('serial-dce', a, b, { from: 'R1 Serial0/0/0', to: 'R2 Serial0/0/0' })).toEqual({
      dceEnd: 'a', dce: a, text: 'R1 Serial0/0/0 gets the DCE end and needs "clock rate".',
    });
    expect(serialDceHint('serial-dte', a, b, { from: 'R1 Serial0/0/0', to: 'R2 Serial0/0/0' })?.dce).toEqual(b);
    const pending = serialDceHint('serial-dte', a);
    expect(pending?.dceEnd).toBe('b');
    expect(pending?.dce).toBeUndefined();
    expect(pending?.text).toContain('second port');
    expect(serialDceHint('serial', a, b)).toBeUndefined();
    expect(serialDceHint('copper-straight', a, b)).toBeUndefined();
  });

  it('builds AddLinkSpecs and cache keys that include the media', () => {
    const a = at('r1', 'Gi0/0');
    const b = at('r2', 'Gi0/0');
    expect(addLinkSpecFor(a, b, 'auto')).toEqual({ a, b, media: 'auto' });
    expect(addLinkSpecFor(a, b, 'radio', 10)).toEqual({ a, b, media: 'radio', lengthM: 10, kind: 'radio' });
    expect(validationKey({ a, b, media: 'copper-straight' })).not.toBe(validationKey({ a, b, media: 'copper-crossover' }));
    expect(validationKey({ a, b, media: 'auto' })).toBe(`r1/Gi0/0>r2/Gi0/0|auto|${DEFAULT_CABLE_LENGTH_M}`);
    expect(validationKey({ a, b })).toBe(validationKey({ a, b, media: 'auto', lengthM: DEFAULT_CABLE_LENGTH_M }));
  });

  it('words verdicts with a glyph and text', () => {
    expect(verdictText({ ok: true, resolvedMedia: 'copper-crossover' }, 'auto')).toEqual({
      ok: true, title: '✓ Crossover', detail: 'Automatic choice: crossover copper.',
    });
    const bad = verdictText({ ok: false, reason: 'Nope.', resolvedMedia: 'copper-straight' }, 'copper-straight');
    expect(bad.title).toBe('✕ Straight-through');
    expect(bad.detail).toBe('Nope.');
    expect(verdictText({ ok: false }, 'coax').detail).toBe('This cable cannot join these ports.');
  });
});
