import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { moduleOrdinal } from '../src/contracts/catalog.js';
import type { AirView } from '../src/contracts/medium.js';
import { ALL_MODULES } from '../src/device/catalog.js';
import { boot, fakeProcess, harness } from './device.harness.js';

const moduleName = (type: string): string => {
  const m = ALL_MODULES.find((x) => x.type === type);
  if (m === undefined) throw new Error(`test fixture: no module ${type}`);
  return m.model;
};

const pcProcesses = () => {
  const wlan = fakeProcess('wlan-client');
  const arp = fakeProcess('arp');
  const ipv4 = fakeProcess('ipv4');
  const icmpv4 = fakeProcess('icmpv4');
  const host = fakeProcess('host');
  return {
    wlan, arp,
    processes: { 'wlan-client': wlan.factory, arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory, host: host.factory },
  };
};

describe('device modules: insert and remove (D7, §3.11)', () => {
  it('inserts a serial module while powered off: ports follow the fixed ports with module ordinals and D8 MACs', () => {
    const h = harness({ type: 'router.nf1941', name: 'R1', power: false });
    const d = h.device;
    const fixed = d.model.ports.map((p) => p.name);
    const v0 = d.portsVersion ?? 0;
    expect(d.insertModule?.('0/1', 'mod.ehwic-2t', 5)).toEqual({ ok: true });
    expect(d.insertModule?.('0/0', 'mod.ehwic-2t', 5)).toEqual({ ok: true });
    expect([...d.ports.keys()]).toEqual([...fixed, 'Serial0/0/0', 'Serial0/0/1', 'Serial0/1/0', 'Serial0/1/1']);
    const s0 = d.port('Serial0/0/0')!;
    expect(s0.ordinal).toBe(moduleOrdinal(0, 0));
    expect(d.port('Serial0/0/1')?.ordinal).toBe(129);
    expect(d.port('Serial0/1/0')?.ordinal).toBe(144);
    expect(s0.mac).toBe(portMac(deviceMacBase('d_1'), 128));
    expect(s0.role).toBe('wan');
    expect(s0.encap).toBe('hdlc');
    expect(s0.adminUp).toBe(false);
    expect(s0.module).toEqual({ slot: '0/0', module: 'mod.ehwic-2t' });
    expect([...(d.modules ?? new Map())]).toEqual([['0/0', 'mod.ehwic-2t'], ['0/1', 'mod.ehwic-2t']]);
    expect(d.spec.modules).toEqual([{ slot: '0/0', module: 'mod.ehwic-2t' }, { slot: '0/1', module: 'mod.ehwic-2t' }]);
    expect(d.portsVersion).toBe(v0 + 2);
    expect(d.modulePorts?.('0/0')).toEqual(['Serial0/0/0', 'Serial0/0/1']);
    expect(d.running.render()).toContain('interface Serial0/0/0\n shutdown');
    expect(d.resolvePortName?.('se0/1/1')).toEqual({ kind: 'existing', port: 'Serial0/1/1' });
  });

  it('refuses in the order slot → module → fit → power → occupancy with the original wording', () => {
    const h = harness({ type: 'router.nf1941', name: 'R1' });
    const d = h.device;
    expect(d.insertModule?.('9/9', 'nope', 1)).toEqual({ ok: false, code: 'no-such-slot', error: 'NF-1941 has no slot 9/9.' });
    expect(d.insertModule?.('0/0', 'nope', 1)).toEqual({ ok: false, code: 'unknown-module', error: 'There is no module called nope in the catalog.' });
    expect(d.insertModule?.('0/0', 'mod.nim-2t', 1)).toEqual({ ok: false, code: 'does-not-fit', error: `${moduleName('mod.nim-2t')} does not fit a ehwic slot.` });
    expect(d.insertModule?.('0/0', 'mod.ehwic-2t', 1)).toEqual({
      ok: false, code: 'powered-on', error: 'Switch R1 off before adding or removing modules; modules are not hot-swappable.',
    });
    d.setPower(false, 2);
    expect(d.insertModule?.('0/0', 'mod.ehwic-2t', 3)).toEqual({ ok: true });
    expect(d.insertModule?.('0/0', 'mod.ehwic-2t', 3)).toEqual({
      ok: false, code: 'slot-occupied', error: `Slot 0/0 already holds ${moduleName('mod.ehwic-2t')}. Remove it first.`,
    });
    expect(d.removeModule?.('7', 3)).toEqual({ ok: false, code: 'no-such-slot', error: 'NF-1941 has no slot 7.' });
    expect(d.removeModule?.('0/1', 3)).toEqual({ ok: false, code: 'slot-empty', error: 'Slot 0/1 is empty.' });
    d.setPower(true, 4);
    expect(d.removeModule?.('0/0', 4)).toMatchObject({ ok: false, code: 'powered-on' });
    expect(d.port('Serial0/0/0')).toBeDefined();
  });

  it('removeModule returns the removed ports, refills the Map and keeps the interface text', () => {
    const h = harness({ type: 'router.nf1941', name: 'R1', power: false });
    const d = h.device;
    d.insertModule?.('0/0', 'mod.ehwic-2t', 1);
    const v = d.portsVersion ?? 0;
    const map = d.ports;
    expect(d.removeModule?.('0/0', 2)).toEqual({ ok: true, removedPorts: ['Serial0/0/0', 'Serial0/0/1'] });
    expect(d.ports).toBe(map);
    expect([...d.ports.keys()]).toEqual(d.model.ports.map((p) => p.name));
    expect(d.modules?.size).toBe(0);
    expect(d.spec.modules).toEqual([]);
    expect(d.portsVersion).toBe(v + 1);
    expect(d.running.render()).toContain('interface Serial0/0/0');
  });

  it('installs spec.modules at construction in slot order and throws on an invalid list before building anything', () => {
    const h = harness({
      type: 'router.nf1941', name: 'R1', power: false,
      modules: [{ slot: '0/1', module: 'mod.ehwic-2t' }, { slot: '0/0', module: 'mod.ehwic-4esg' }],
    });
    const d = h.device;
    expect([...(d.modules ?? new Map()).keys()]).toEqual(['0/0', '0/1']);
    const switched = d.modulePorts?.('0/0') ?? [];
    expect(switched.length).toBeGreaterThan(0);
    const keys = [...d.ports.keys()];
    expect(keys.slice(keys.length - 2)).toEqual(['Serial0/1/0', 'Serial0/1/1']);
    expect(keys.indexOf(switched[0] as string)).toBe(d.model.ports.length);
    expect(d.port(switched[0] as string)?.ordinal).toBe(128);
    expect(d.port(switched[0] as string)?.role).toBe('switched');
    expect(d.capabilities).toContain('switching');
    expect(d.port('Serial0/1/0')?.ordinal).toBe(144);

    expect(() => harness({ type: 'router.nf1941', modules: [{ slot: '0/0', module: 'mod.nim-2t' }] })).toThrow(/does not fit a ehwic slot/);
    expect(() => harness({ type: 'router.nf1941', modules: [{ slot: '5/5', module: 'mod.ehwic-2t' }] })).toThrow('NF-1941 has no slot 5/5.');
    expect(() => harness({ type: 'router.nf1941', modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }, { slot: '0/0', module: 'mod.ehwic-2t' }] })).toThrow(/already holds/);
    expect(() => harness({ type: 'router.nf1941', modules: [{ slot: '0/0', module: 'mod.none' }] })).toThrow('There is no module called mod.none in the catalog.');
  });

  it('an SFP transceiver becomes the cage port transceiver and adds no ports', () => {
    const h = harness({ type: 'router.nf4331', name: 'R1', power: false });
    const d = h.device;
    const cage = (d.model.slots ?? []).find((s) => s.cage !== undefined)!;
    const before = [...d.ports.keys()];
    expect(d.insertModule?.(cage.id, 'mod.sfp-10g-sr', 1)).toMatchObject({ ok: false, code: 'does-not-fit' });
    expect(d.insertModule?.(cage.id, 'mod.sfp-1g-sx', 1)).toEqual({ ok: true });
    expect(d.port(cage.cage as string)?.transceiver).toBe('mod.sfp-1g-sx');
    expect(d.modulePorts?.(cage.id)).toEqual([]);
    expect([...d.ports.keys()]).toEqual(before);
    expect(d.removeModule?.(cage.id, 2)).toEqual({ ok: true, removedPorts: [] });
    expect(d.port(cage.cage as string)?.transceiver).toBeUndefined();
  });
});

describe('device modules: effective capabilities', () => {
  it('a wlan card adds wifi-client: the Wlan0 port, the wlan-client daemon and the association table', () => {
    const p = pcProcesses();
    const h = harness({ processes: p.processes, power: false });
    const d = h.device;
    expect(d.capabilities).not.toContain('wifi-client');
    expect(d.tables.get?.('dot11-assoc')).toBeUndefined();
    expect(d.insertModule?.('exp0', 'mod.wlan-card', 0)).toEqual({ ok: true });
    expect(d.capabilities).toContain('wifi-client');
    const wl = d.port('Wlan0')!;
    expect(wl.spec.kind).toBe('wlan');
    expect(wl.role).toBe('wireless-client');
    expect(wl.encap).toBe('dot11');
    expect(wl.ordinal).toBe(128);
    expect(d.tables.names?.()).toEqual(['cam', 'arp', 'rib', 'rib6', 'nd', 'sockets', 'dns-cache', 'dot11-assoc']);
    expect(d.tables.get?.('dot11-assoc')?.name).toBe('dot11-assoc');

    d.setPower(true, 10);
    boot(h);
    expect([...d.processes.keys()]).toEqual(['wlan-client', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(p.wlan.ctx?.hasCapability?.('wifi-client')).toBe(true);
    expect(p.wlan.ctx?.hasCapability?.('routing')).toBe(false);
    expect(d.stateSnapshots().map((s) => s.process)).toEqual(['wlan-client', 'arp', 'ipv4', 'icmpv4', 'host']);

    d.setPower(false, d.bootedAt! + 1);
    expect(d.removeModule?.('exp0', d.bootedAt ?? 0)).toMatchObject({ ok: true, removedPorts: ['Wlan0'] });
    expect(d.capabilities).not.toContain('wifi-client');
    expect(d.tables.get?.('dot11-assoc')).toBeUndefined();
    d.setPower(true, 100);
    boot(h);
    expect([...d.processes.keys()]).toEqual(['arp', 'ipv4', 'icmpv4', 'host']);
  });

  it('ctx.air comes from deps.airView only on devices with a radio port', () => {
    const view: AirView = { visibleBss: () => [], link: () => undefined };
    const asked: string[] = [];
    const airView = (device: string): AirView => {
      asked.push(device);
      return view;
    };
    const plain = pcProcesses();
    const h1 = harness({ processes: plain.processes, airView });
    boot(h1);
    expect(plain.arp.ctx?.air).toBeUndefined();
    expect(asked).toEqual([]);

    const card = pcProcesses();
    const h2 = harness({ id: 'd_2', processes: card.processes, airView, modules: [{ slot: 'exp0', module: 'mod.wlan-card' }] });
    boot(h2);
    expect(card.wlan.ctx?.air).toBe(view);
    expect(card.arp.ctx?.air).toBe(view);
    expect(asked).toEqual(['d_2']);
  });
});
