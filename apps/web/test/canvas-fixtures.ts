// Shared fixtures of the canvas tests: hand-built snapshots and real simulations of the P0.5 templates.
import { SCENARIOS, createSimulation, emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, LinkSnapshot, PortSnapshot, SimSnapshot } from '@netforge/engine';
import type { ThemeColors } from '../src/canvas/scene.js';

/**
 * A complete snapshot port (the P1 web fixture migration, finished in ARCHITECTURE-P3 §9.2 W0 item 7). The P0.5
 * members the canvas reads default to what its readers took an absent member to mean before the fixtures carried them
 * — role 'switched' (`l2-model.ts` isSwitchedPort), not virtual, linkable, configurable — so completing the fixture
 * changes no test's path; `allowedRoles` follows the final role; encapsulation, ordinal and connector, which no canvas
 * reader reads, are a copper Ethernet port's. A test that needs another value passes it.
 */
export function port(id: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  const p: PortSnapshot = {
    id,
    short: id,
    kind: 'ethernet',
    mac: '00:00:00:00:00:01',
    adminUp: true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    txQueue: 0,
    role: 'switched',
    allowedRoles: ['switched'],
    encap: 'ethernet',
    ordinal: 1,
    virtual: false,
    linkable: true,
    configurable: true,
    connector: 'rj45',
    ...extra,
  };
  return extra.allowedRoles === undefined ? { ...p, allowedRoles: [p.role] } : p;
}

/**
 * A complete snapshot device: an NF-PC unless `extra` says otherwise. The P0.5 members are the NF-PC's identity
 * (category, family, variant, icon, command shell) and empty lists where the readers took an absent member as empty
 * (capabilities, GUI panels, host ports).
 */
export function device(id: string, x: number, y: number, ports: PortSnapshot[], extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    id,
    type: 'pc.nfpc',
    model: 'NF-PC',
    kind: 'pc',
    name: id.toUpperCase(),
    position: { x, y },
    power: true,
    booted: true,
    uptimeNs: 0,
    ports,
    tables: { cam: [], arp: [], rib: [] },
    processes: [],
    runningConfig: '',
    hasStartupConfig: false,
    category: 'computers',
    family: 'nf-pc',
    variant: 'Wired',
    icon: 'pc',
    capabilities: [],
    cli: { shell: 'host', grammar: 'host' },
    gui: [],
    hostPorts: [],
    baseMac: '00:00:00:00:00:00',
    ...extra,
  };
}

export function link(id: string, a: [string, string], b: [string, string], extra: Partial<LinkSnapshot> = {}): LinkSnapshot {
  return {
    id,
    a: { device: a[0], port: a[1] },
    b: { device: b[0], port: b[1] },
    media: 'auto',
    lengthM: 3,
    impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 },
    up: true,
    resolvedMedia: 'copper-straight',
    ...extra,
  };
}

export function snapshot(devices: DeviceSnapshot[], links: LinkSnapshot[] = [], extra: Partial<SimSnapshot> = {}): SimSnapshot {
  return { now: 0, seed: 1, topologyVersion: 1, devices, links, inflight: [], sessions: [], pduCount: 0, pendingEvents: 0, ...extra };
}

/** Snapshot of a built-in template after it settled (`runToIdle`). */
export function templateSnapshot(name: string, seed = 7): SimSnapshot {
  const sc = SCENARIOS.find((s) => s.name === name);
  if (!sc) throw new Error(`no template ${name}`);
  const sim = createSimulation({ seed });
  sim.loadTopology(sc.build());
  sim.runToIdle(200_000);
  return sim.snapshot();
}

/** A theme with distinct numbers per token (no DOM needed). */
export const TEST_THEME: ThemeColors = {
  bg: 0x000001,
  bg2: 0x000002,
  panel: 0x000003,
  panel2: 0x000004,
  border: 0x000005,
  borderStrong: 0x000006,
  text: 0x000007,
  textDim: 0x000008,
  textFaint: 0x000009,
  accent: 0x00000a,
  ok: 0x00000b,
  warn: 0x00000c,
  err: 0x00000d,
  purple: 0x00000e,
  yellow: 0x00000f,
  blueDeep: 0x000010,
  sans: 'sans-serif',
  mono: 'monospace',
  icon: { face: 1, face2: 2, line: 3, dim: 4, accent: 5, accent2: 6, ok: 7, warn: 8, err: 9 },
  stamp: 1,
};
