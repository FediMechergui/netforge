// Shared fixtures of the canvas tests: hand-built snapshots and real simulations of the P0.5 templates.
import { SCENARIOS, createSimulation, emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, LinkSnapshot, PortSnapshot, SimSnapshot } from '@netforge/engine';
import type { ThemeColors } from '../src/canvas/scene.js';

export function port(id: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return {
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
    ...extra,
  };
}

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
    icon: 'pc',
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
