/**
 * Shared fixtures of the [S2]/[S3] routing tests (`routing.lsdb-model.test.ts`, `routing.spf-parity.test.ts`): a
 * converged single-area OSPF world built from rows, the shape the ospf daemon writes (§2.6).
 *
 *        R1 (1.1.1.1) ──Se0/0/0── 64 ── Se0/0/0── R3 (3.3.3.3)
 *        Gi0/0 │ 10.0.123.1                         │ Gi0/0 10.0.123.3        R3 Gi0/1 ── R4 Gi0/1 (10.0.34.0/30, cost 1)
 *              └──────── SW1 (the LAN 10.0.123.0/24, DR R2 10.0.123.2) ───────┘
 *                         │ Gi0/0 10.0.123.2
 *                        R2 (2.2.2.2) Gi0/1 ── R4 Gi0/0 (10.0.24.0/30, cost 1)        R4 (4.4.4.4): Lo0 stub, an E2 default
 *
 * From R1: the LAN at 1, R2 and R3 at 1 through it (R3's serial path at 64 is beaten), R4 at 2 by two equal paths.
 */
import type { DeviceSnapshot, LinkSnapshot, OspfAreaId, OspfInterfaceRow, OspfLsaRow, OspfRouterLink, SimSnapshot, SpfTree, TableSnapshot } from '@netforge/engine';
import { device, link, port, snapshot } from './canvas-fixtures.js';

export const SEC = 1_000_000_000;
/** When the fixture's LSAs were installed. */
export const T0 = 1000 * SEC;
export const AREA0: OspfAreaId = '0.0.0.0';

const P30 = '255.255.255.252';
const P24 = '255.255.255.0';

export function routerLsa(adv: string, links: OspfRouterLink[], over: Partial<OspfLsaRow> = {}): OspfLsaRow {
  const row: OspfLsaRow = {
    key: '',
    updatedAt: T0,
    scope: AREA0,
    type: 1,
    lsid: adv,
    advRouter: adv,
    seq: 0x80000003,
    ageAtInstall: 10,
    installedAt: T0,
    checksum: 0x1000 + Number(adv.split('.')[0]),
    length: 24 + 12 * links.length,
    options: 2,
    self: false,
    flags: { b: false, e: false, v: false },
    links,
    ...over,
  };
  return { ...row, key: `${row.scope}|${row.type}|${row.lsid}|${row.advRouter}` };
}

export function networkLsa(lsid: string, adv: string, mask: string, attached: string[], over: Partial<OspfLsaRow> = {}): OspfLsaRow {
  const row: OspfLsaRow = {
    key: '',
    updatedAt: T0,
    scope: AREA0,
    type: 2,
    lsid,
    advRouter: adv,
    seq: 0x80000002,
    ageAtInstall: 12,
    installedAt: T0,
    checksum: 0x2abc,
    length: 24 + 4 * attached.length,
    options: 2,
    self: false,
    mask,
    attached,
    ...over,
  };
  return { ...row, key: `${row.scope}|${row.type}|${row.lsid}|${row.advRouter}` };
}

export function externalLsa(lsid: string, adv: string, mask: string, metric: number, over: Partial<OspfLsaRow> = {}): OspfLsaRow {
  const row: OspfLsaRow = {
    key: '',
    updatedAt: T0,
    scope: 'as',
    type: 5,
    lsid,
    advRouter: adv,
    seq: 0x80000001,
    ageAtInstall: 30,
    installedAt: T0,
    checksum: 0x5ee5,
    length: 36,
    options: 2,
    self: false,
    mask,
    metric,
    external: { e2: true, forward: '0.0.0.0', tag: 1 },
    ...over,
  };
  return { ...row, key: `${row.scope}|${row.type}|${row.lsid}|${row.advRouter}` };
}

export function ifRow(port: string, routerId: string, address: string | undefined, over: Partial<OspfInterfaceRow> = {}): OspfInterfaceRow {
  const row: OspfInterfaceRow = {
    key: port,
    updatedAt: T0,
    port,
    process: 1,
    routerId,
    area: AREA0,
    networkType: 'point-to-point',
    state: 'point-to-point',
    cost: 1,
    costSource: 'bandwidth',
    priority: 1,
    helloS: 10,
    deadS: 40,
    passive: false,
    neighbors: 1,
    adjacent: 1,
    stateSince: T0,
    ...over,
  };
  return address === undefined ? row : { ...row, address, prefixLen: 24 };
}

/** The converged LSDB every router holds (database order is NOT assumed: the rows are shuffled on purpose). */
export function worldLsas(): OspfLsaRow[] {
  return [
    externalLsa('0.0.0.0', '4.4.4.4', '0.0.0.0', 1),
    routerLsa('4.4.4.4', [
      { kind: 'p2p', id: '2.2.2.2', data: '10.0.24.2', metric: 1 },
      { kind: 'stub', id: '10.0.24.0', data: P30, metric: 1 },
      { kind: 'p2p', id: '3.3.3.3', data: '10.0.34.2', metric: 1 },
      { kind: 'stub', id: '10.0.34.0', data: P30, metric: 1 },
      { kind: 'stub', id: '4.4.4.4', data: '255.255.255.255', metric: 1 },
    ], { flags: { b: false, e: true, v: false } }),
    routerLsa('2.2.2.2', [
      { kind: 'transit', id: '10.0.123.2', data: '10.0.123.2', metric: 1 },
      { kind: 'p2p', id: '4.4.4.4', data: '10.0.24.1', metric: 1 },
      { kind: 'stub', id: '10.0.24.0', data: P30, metric: 1 },
    ]),
    networkLsa('10.0.123.2', '2.2.2.2', P24, ['2.2.2.2', '1.1.1.1', '3.3.3.3']),
    routerLsa('1.1.1.1', [
      { kind: 'transit', id: '10.0.123.2', data: '10.0.123.1', metric: 1 },
      { kind: 'p2p', id: '3.3.3.3', data: '10.0.13.1', metric: 64 },
      { kind: 'stub', id: '10.0.13.0', data: P30, metric: 64 },
      { kind: 'stub', id: '10.1.0.0', data: P24, metric: 1 },
    ]),
    routerLsa('3.3.3.3', [
      { kind: 'transit', id: '10.0.123.2', data: '10.0.123.3', metric: 1 },
      { kind: 'p2p', id: '1.1.1.1', data: '10.0.13.2', metric: 64 },
      { kind: 'stub', id: '10.0.13.0', data: P30, metric: 64 },
      { kind: 'p2p', id: '4.4.4.4', data: '10.0.34.1', metric: 1 },
      { kind: 'stub', id: '10.0.34.0', data: P30, metric: 1 },
    ]),
  ];
}

/** The rows a router holds: the world's LSAs with its own marked `self`. */
export function heldBy(rid: string, rows: OspfLsaRow[] = worldLsas()): OspfLsaRow[] {
  return rows.map((r) => (r.advRouter === rid ? { ...r, self: true } : r));
}

function tables(lsas: OspfLsaRow[], ifs: OspfInterfaceRow[]): { cam: []; arp: []; rib: []; extra: TableSnapshot[] } {
  return {
    cam: [],
    arp: [],
    rib: [],
    extra: [
      { name: 'ospf-interfaces', title: 'OSPF interfaces', columns: [], rows: ifs as unknown as Record<string, unknown>[] },
      { name: 'ospf-neighbors', title: 'OSPF neighbours', columns: [], rows: [] },
      { name: 'ospf-lsdb', title: 'Link-state database', columns: [], rows: lsas as unknown as Record<string, unknown>[] },
    ],
  };
}

export interface RouterSpec {
  readonly id: string;
  readonly name?: string;
  readonly rid: string;
  readonly x: number;
  readonly y: number;
  /** [port, address or undefined, link or undefined, area?, state?] */
  readonly ports: readonly (readonly [string, string | undefined, string | undefined, OspfAreaId?, OspfInterfaceRow['state']?])[];
  readonly lsas?: OspfLsaRow[];
  readonly trees?: { area: OspfAreaId; tree: SpfTree }[];
}

export function ospfRouter(spec: RouterSpec): DeviceSnapshot {
  const ports = spec.ports.map(([id, , l]) => port(id, l === undefined ? { role: 'routed' } : { role: 'routed', link: l, operUp: true }));
  const ifs = spec.ports.map(([id, addr, , area, state]) => ifRow(id, spec.rid, addr, { area: area ?? AREA0, state: state ?? 'point-to-point' }));
  const extra: Partial<DeviceSnapshot> = {
    type: 'router.nf2911',
    kind: 'router',
    name: spec.name ?? spec.id.toUpperCase(),
    tables: tables(spec.lsas ?? heldBy(spec.rid), ifs),
  };
  if (spec.trees !== undefined) extra.processes = [{ process: 'ospf', state: { spf: { runs: 1 }, interfaces: [], neighbors: [], trees: spec.trees } }];
  return device(spec.id, spec.x, spec.y, ports, extra);
}

export function sw(id: string, x: number, y: number, ports: [string, string][]): DeviceSnapshot {
  return device(
    id,
    x,
    y,
    ports.map(([p, l]) => port(p, { link: l, operUp: true })),
    { type: 'switch.nf2960', kind: 'switch', name: id.toUpperCase() },
  );
}

export const LINKS: LinkSnapshot[] = [
  link('l1', ['r1', 'Gi0/0'], ['sw1', 'Fa0/1']),
  link('l2', ['r2', 'Gi0/0'], ['sw1', 'Fa0/2']),
  link('l3', ['r3', 'Gi0/0'], ['sw1', 'Fa0/3']),
  link('l5', ['r1', 'Se0/0/0'], ['r3', 'Se0/0/0']),
  link('l6', ['r2', 'Gi0/1'], ['r4', 'Gi0/0']),
  link('l7', ['r3', 'Gi0/1'], ['r4', 'Gi0/1']),
];

export interface WorldOptions {
  /** Replace a router's rows (by router id). */
  readonly lsas?: Readonly<Record<string, OspfLsaRow[]>>;
  /** Give a router a StateView with these trees. */
  readonly trees?: Readonly<Record<string, { area: OspfAreaId; tree: SpfTree }[]>>;
  readonly extraDevices?: DeviceSnapshot[];
}

/** The fixture world: R1–R4 and SW1 (devices in a non-sorted order: R10 naming is checked separately). */
export function world(opts: WorldOptions = {}): SimSnapshot {
  const spec = (s: RouterSpec): DeviceSnapshot => {
    const lsas = opts.lsas?.[s.rid];
    const trees = opts.trees?.[s.rid];
    return ospfRouter({ ...s, ...(lsas === undefined ? {} : { lsas }), ...(trees === undefined ? {} : { trees }) });
  };
  const devices = [
    spec({ id: 'r3', rid: '3.3.3.3', x: 200, y: 300, ports: [['Gi0/0', '10.0.123.3', 'l3', AREA0, 'drother'], ['Se0/0/0', '10.0.13.2', 'l5'], ['Gi0/1', '10.0.34.1', 'l7']] }),
    spec({ id: 'r1', rid: '1.1.1.1', x: 100, y: 100, ports: [['Gi0/0', '10.0.123.1', 'l1', AREA0, 'backup'], ['Se0/0/0', '10.0.13.1', 'l5'], ['Gi0/1', '10.1.0.1', undefined]] }),
    spec({ id: 'r2', rid: '2.2.2.2', x: 300, y: 100, ports: [['Gi0/0', '10.0.123.2', 'l2', AREA0, 'dr'], ['Gi0/1', '10.0.24.1', 'l6']] }),
    spec({ id: 'r4', rid: '4.4.4.4', x: 400, y: 300, ports: [['Gi0/0', '10.0.24.2', 'l6'], ['Gi0/1', '10.0.34.2', 'l7'], ['Lo0', '4.4.4.4', undefined, AREA0, 'loopback']] }),
    sw('sw1', 200, 180, [['Fa0/1', 'l1'], ['Fa0/2', 'l2'], ['Fa0/3', 'l3']]),
    ...(opts.extraDevices ?? []),
  ];
  return snapshot(devices, LINKS, { now: T0 + 5 * SEC });
}

/** R1's tree as RFC 2328 §16.1 gives it for the fixture, written by hand (the StateView a converged R1 reports). */
export function expectedR1Tree(): SpfTree {
  return {
    root: '1.1.1.1',
    vertices: [
      { key: 'R:1.1.1.1', kind: 'router', id: '1.1.1.1', cost: 0, nextHops: [] },
      { key: 'N:10.0.123.2', kind: 'network', id: '10.0.123.2', cost: 1, parent: 'R:1.1.1.1', nextHops: [{ iface: 'Gi0/0' }] },
      { key: 'R:2.2.2.2', kind: 'router', id: '2.2.2.2', cost: 1, parent: 'N:10.0.123.2', nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.123.2' }] },
      { key: 'R:3.3.3.3', kind: 'router', id: '3.3.3.3', cost: 1, parent: 'N:10.0.123.2', nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.123.3' }] },
      {
        key: 'R:4.4.4.4',
        kind: 'router',
        id: '4.4.4.4',
        cost: 2,
        parent: 'R:2.2.2.2',
        nextHops: [
          { iface: 'Gi0/0', nextHop: '10.0.123.2' },
          { iface: 'Gi0/0', nextHop: '10.0.123.3' },
        ],
      },
    ],
  };
}
