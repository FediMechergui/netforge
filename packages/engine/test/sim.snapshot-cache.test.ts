/**
 * sim — snapshot v2 and the rendered-config cache (ARCHITECTURE-P1 §3.14): render reuse and invalidation, secret
 * masking, subset snapshots, port/device v2 fields, plain-cable phy omission, media presence, extra tables.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { maskConfigSecrets } from '../src/cli/handlers/show.js';
import { createRenderCache, isPlainPortPhy } from '../src/sim/snapshot-cache.js';
import { BOOT_NS, console } from './sim.harness.js';

describe('snapshot-cache: render cache', () => {
  it('renders once until a config event, an AST identity change or an explicit invalidation', () => {
    const cache = createRenderCache();
    const dev = { id: 'd1', running: createConfigAst(), startup: undefined as ReturnType<typeof createConfigAst> | undefined };
    dev.running.set([], ['hostname', 'A']);
    expect(cache.configs(dev)).toEqual({ running: dev.running.render(), startup: undefined });
    cache.configs(dev);
    expect(cache.renders).toBe(1);

    dev.running.set([], ['hostname', 'B']);
    const change: TraceEvent = { t: 0, kind: 'configChange', device: 'd1', line: 'hostname B', negate: false, context: [] };
    cache.observe({ ...change, device: 'other' });
    expect(cache.configs(dev).running).toContain('hostname A');
    cache.observe(change);
    expect(cache.configs(dev).running).toContain('hostname B');
    expect(cache.renders).toBe(2);

    dev.startup = dev.running.clone();
    expect(cache.configs(dev).startup).toContain('hostname B');
    expect(cache.renders).toBe(3);
    dev.running = createConfigAst();
    expect(cache.configs(dev).running).toBe(dev.running.render());
    cache.invalidate('d1');
    cache.configs(dev);
    cache.forget('d1');
    cache.configs(dev);
    expect(cache.renders).toBe(6);
  });

  it('masks secret tokens and leaves other lines byte for byte', () => {
    const text = 'hostname AP1\nenable secret topsecret\n!\ninterface Wlan0\n ssid LAB NET\n passphrase my long pass\n no passphrase\n!\nend\n';
    const masked = maskConfigSecrets(text);
    expect(masked).toBe(`hostname AP1\nenable secret ${CONFIG_SECRET_MASK}\n!\ninterface Wlan0\n ssid LAB NET\n passphrase ${CONFIG_SECRET_MASK}\n no passphrase\n!\nend\n`);
    const plain = 'hostname R1\n!\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n!\nend\n';
    expect(maskConfigSecrets(plain)).toBe(plain);
  });

  it('classifies plain cable phy', () => {
    expect(isPlainPortPhy({ operUp: true, phy: { carrier: true, lineProtocol: true, medium: 'cable' } })).toBe(true);
    expect(isPlainPortPhy({ operUp: false, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', medium: 'cable', dce: true } })).toBe(false);
    expect(isPlainPortPhy({ operUp: true, phy: { carrier: true, lineProtocol: true, medium: 'cable', end: { speedBps: 1e7, duplex: 'half', autoneg: true, via: 'parallel-detect' } } })).toBe(false);
    expect(isPlainPortPhy({ operUp: false, phy: { carrier: true, lineProtocol: false, medium: 'air' } })).toBe(false);
  });
});

describe('sim: snapshots v2', () => {
  function booted() {
    const sim = createSimulation({ seed: 21 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(BOOT_NS);
    return sim;
  }

  it('reflects console, save, erase, power and fault changes in the cached configs', () => {
    const sim = booted();
    const running = (id: string) => sim.snapshot().devices.find((d) => d.id === id)!.runningConfig;
    const first = running('pc1');
    expect(running('pc1')).toBe(first);
    expect(sim.snapshot()).toEqual(sim.snapshot());

    console(sim, 'sw1', ['enable', 'configure terminal', 'hostname Core', 'end']);
    expect(running('sw1')).toContain('hostname Core');
    console(sim, 'sw1', ['enable', 'write memory']);
    const saved = sim.snapshot().devices.find((d) => d.id === 'sw1')!;
    expect(saved.hasStartupConfig).toBe(true);
    expect(saved.startupConfig).toContain('hostname Core');
    console(sim, 'sw1', ['enable', 'erase startup-config']);
    expect(sim.snapshot().devices.find((d) => d.id === 'sw1')!).not.toHaveProperty('startupConfig');

    sim.injectFault(sim.now, { id: 'flap', kind: 'port-flap', target: { device: 'sw1', port: 'Fa0/2' }, params: { count: 1 } });
    sim.runFor(1);
    expect(running('sw1')).toContain('interface FastEthernet0/2\n shutdown');

    sim.renameDevice('pc2', 'Beta');
    expect(running('pc2')).toContain('hostname Beta');
    sim.setPower('pc1', false);
    expect(running('pc1')).not.toContain('ip address');
  });

  it('builds a subset snapshot in creation order with complete links and in-flight frames', () => {
    const sim = booted();
    const full = sim.snapshot();
    const part = sim.snapshot({ devices: ['pc2', 'ghost', 'pc1'] });
    expect(part.devices.map((d) => d.id)).toEqual(['pc1', 'pc2']);
    expect(part.links).toEqual(full.links);
    expect(part.inflight).toEqual(full.inflight);
    expect(part.devices[1]).toEqual(full.devices[2]);
    expect(structuredClone(part)).toEqual(part);
  });

  it('adds port and device v2 fields, omits plain phy and default phy settings, and omits empty media', () => {
    const sim = booted();
    const snap = sim.snapshot();
    expect(snap).not.toHaveProperty('media');
    const pc = snap.devices.find((d) => d.id === 'pc1')!;
    expect(pc).toMatchObject({ category: 'computers', capabilities: ['host'], cli: { shell: 'host', grammar: 'host' }, hostPorts: ['GigabitEthernet0'] });
    expect(pc.baseMac).toBe(portMac(deviceMacBase('pc1'), 0));
    expect(pc.slots?.map((s) => [s.id, s.type])).toEqual((sim.device('pc1')!.model.slots ?? []).map((s) => [s.id, s.type]));
    expect(pc.slots?.every((s) => s.module === undefined)).toBe(true);
    const nic = pc.ports.find((p) => p.id === 'GigabitEthernet0')!;
    expect(nic).toMatchObject({ role: 'routed', allowedRoles: ['routed'], encap: 'ethernet', ordinal: 1, virtual: false, linkable: true, configurable: true, connector: 'rj45' });
    expect(nic).not.toHaveProperty('phy');
    expect(nic).not.toHaveProperty('phySettings');
    expect(nic).not.toHaveProperty('radio');
    const sw = snap.devices.find((d) => d.id === 'sw1')!;
    expect(sw.ports.find((p) => p.id === 'FastEthernet0/1')).toMatchObject({ role: 'switched', operUp: true });
    expect(snap.links[0]).toMatchObject({ kind: 'cable', up: true });

    console(sim, 'sw1', ['enable', 'configure terminal', 'interface FastEthernet0/3', 'speed 100']);
    const port3 = sim.snapshot().devices.find((d) => d.id === 'sw1')!.ports.find((p) => p.id === 'FastEthernet0/3')!;
    expect(port3.phySettings).toEqual({ speed: 100_000_000, duplex: 'auto' });
  });

  it('publishes hub phy detail and media segments', () => {
    const topo: Topology = {
      schema: TOPOLOGY_SCHEMA_ID,
      seed: 1,
      devices: [
        { id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { logical: [0, 0] } },
        { id: 'hub', type: 'hub.nfhub4', name: 'Hub1', position: { logical: [50, 0] } },
      ],
      links: [{ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'hub', port: 'Ethernet0' }, media: 'auto', length_m: 3 }],
    };
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(topo);
    sim.runFor(BOOT_NS);
    const snap = sim.snapshot();
    const nic = snap.devices.find((d) => d.id === 'pc1')!.ports.find((p) => p.id === 'GigabitEthernet0')!;
    expect(nic.phy).toMatchObject({ carrier: true, end: { duplex: 'half', via: 'parallel-detect' } });
    expect(snap.devices.find((d) => d.id === 'hub')!.ports[0]!.role).toBe('repeater');
    expect(snap.media?.segments.length).toBe(1);
  });

  it('never exposes a passphrase and lists extra tables with their descriptors', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'home', type: 'wrouter.nfhome', name: 'Home1' });
    sim.runToIdle();
    const r = sim.configure('home', ['interface Wlan0', ' ssid LAB', ' security wpa2-psk', ' passphrase labpass-secret-1'], { indentation: true });
    expect(r.ok).toBe(true);
    sim.runFor(SEC);
    const snap = sim.snapshot();
    const home = snap.devices[0]!;
    expect(JSON.stringify(snap)).not.toContain('labpass-secret-1');
    expect(home.runningConfig).toContain(`passphrase ${CONFIG_SECRET_MASK}`);
    expect(sim.device('home')!.running.render()).toContain('passphrase labpass-secret-1');
    // the home router derives the whole P1 daemon list at CATALOG_STAGE 'P1' (§8.2 W5), so it owns their tables too
    expect(home.tables.extra?.map((t) => [t.name, t.title])).toEqual([
      ['dot11-assoc', 'Wireless associations'],
      ['rib6', 'IPv6 routes'],
      ['nd', 'IPv6 neighbours'],
      ['sockets', 'Sockets'],
      ['dhcp-bindings', 'DHCP leases'],
      ['dns-cache', 'DNS cache'],
    ]);
    expect(home.ports.find((p) => p.id === 'Wlan0')!.radio).toMatchObject({ mode: 'ap', ssid: 'LAB' });
  });
});
