/**
 * test/tunnel.world.ts — the worlds of the W4 tunnel acceptance rows (ARCHITECTURE-P3 §10.1: `accept.p3.gre` [S18],
 * `accept.p3.ipsec` and `accept.p3.ipsec-failure` [C13]; §3.10 and §3.13 setups; §7 W4 qa). Not a test file.
 *
 * The world (§3.10, §3.13): PC1 192.168.1.10 — R1 Gi0/0; R1 Se0/0/0 209.165.200.225/30 — ISP — R2 Se0/0/0
 * 209.165.200.230/30; R2 Gi0/0 — PC2 192.168.2.10. The ISP has no private routes; each router's default route points
 * at the ISP. R1 and R2 hold `interface Tunnel0` (172.16.0.1/30 and .2/30, source Serial0/0/0, destination the other
 * end): in `gre` mode with the static route through the tunnel's far address (§3.10), or OSPF over the tunnel; in
 * `ipsec` mode a VTI protected by `crypto ipsec profile VPN` → `crypto ikev2 profile PROF` → `crypto ikev2 keyring KR`
 * with the static route through Tunnel0 (§3.13). A test-only frame injector (test/inject.ts) on R1 Gi0/1
 * (192.168.3.1/24) supplies the one packet no host shell sends: an oversize datagram with DF set (the host `ping` has no
 * size or DF option), sourced from PC1's address so PC1 receives the ICMP 3/4.
 *
 * The worlds are built with `staged.world` at stage P3 (rule 13), whose registry is the real one: since the W4 catalog
 * flip `protocols/index.ts` registers every approved P3 daemon, so the world is the flipped catalog's (ruling R47
 * removed the pre-flip factory overlay; only the test injector is laid over the registry).
 *
 * Nothing here is module-level mutable state (rule 12).
 */
import { expect } from 'vitest';
import type { Ipv4Address } from '../src/contracts/addr.js';
import { ETHERTYPE_IPV4, IPPROTO_ICMP, type LayerSpec } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { IpsecSaRow, TunnelRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { INJECTOR_HOST_TYPE, withInjector } from './inject.js';
import { createStagedSimulation } from './staged.world.js';

// ── names and addresses (§3.10, §3.13) ───────────────────────────────────────────────────────────────────────────

export const TU0 = 'Tunnel0';
export const SE0 = 'Serial0/0/0';
export const SE1 = 'Serial0/0/1';
export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const PC_PORT = 'GigabitEthernet0';
export const INJ_PORT = 'GigabitEthernet0';
export const MASK30 = '255.255.255.252';
export const MASK24 = '255.255.255.0';
export const R1_WAN: Ipv4Address = '209.165.200.225';
export const ISP_R1: Ipv4Address = '209.165.200.226';
export const ISP_R2: Ipv4Address = '209.165.200.229';
export const R2_WAN: Ipv4Address = '209.165.200.230';
export const PC1_ADDR: Ipv4Address = '192.168.1.10';
export const PC2_ADDR: Ipv4Address = '192.168.2.10';
/** The provider's addresses: the only ones an outer header may carry inside the provider. */
export const PUBLIC_ADDRS: readonly Ipv4Address[] = Object.freeze([R1_WAN, ISP_R1, ISP_R2, R2_WAN]);
/** The pre-shared key of the IPsec worlds (a lab value) and a wrong one. */
export const LAB_KEY = 'Nf-Site-Key-25';
export const WRONG_KEY = 'Nf-Other-Key-99';
/** The context of R2's keyring peer (where its `pre-shared-key` line lives). */
export const KEYRING_PEER_CTX = (peer: string): string[][] => [['crypto', 'ikev2', 'keyring', 'KR'], ['peer', peer]];

/** A startup configuration from sections (each closed by `!`), ended by `end`. */
export function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

// ── the world ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The GRE-mode Tunnel0 body of R1 / R2 (§3.10 setup). */
export const R1_GRE_TUNNEL: readonly string[] = Object.freeze([` ip address 172.16.0.1 ${MASK30}`, ` tunnel source ${SE0}`, ` tunnel destination ${R2_WAN}`]);
export const R2_GRE_TUNNEL: readonly string[] = Object.freeze([` ip address 172.16.0.2 ${MASK30}`, ` tunnel source ${SE0}`, ` tunnel destination ${R1_WAN}`]);

/** The ipsec-mode Tunnel0 body (§3.13 setup); `protection` null leaves the protection line out. */
export function ipsecTunnelLines(address: string, destination: string, protection: string | null = 'VPN'): string[] {
  return [
    ` ip address ${address} ${MASK30}`,
    ` tunnel source ${SE0}`,
    ` tunnel destination ${destination}`,
    ' tunnel mode ipsec ipv4',
    ...(protection === null ? [] : [` tunnel protection ipsec profile ${protection}`]),
  ];
}

/** The three crypto sections of one end (§3.13 setup). */
export function cryptoSections(peerName: string, peer: string, key: string, keyringAddress: string = peer): string[][] {
  return [
    ['crypto ikev2 keyring KR', ` peer ${peerName}`, `  address ${keyringAddress}`, `  pre-shared-key ${key}`],
    ['crypto ikev2 profile PROF', ` match identity remote address ${peer} 255.255.255.255`, ' authentication remote pre-share', ' authentication local pre-share', ' keyring local KR'],
    ['crypto ipsec profile VPN', ' set ikev2-profile PROF'],
  ];
}

export interface TunnelWorldOptions {
  /** The tunnel mode: GRE (§3.10) or a protected VTI (§3.13). */
  readonly mode: 'gre' | 'ipsec';
  readonly seed?: number;
  /** R1's / R2's Tunnel0 body instead of the mode's default. */
  readonly r1Tunnel?: readonly string[];
  readonly r2Tunnel?: readonly string[];
  /** GRE mode: OSPF over the tunnel (process 1, area 0: the tunnel and the LAN) instead of the static through it. */
  readonly ospf?: boolean;
  /** IPsec mode: R2's pre-shared key (default `LAB_KEY`). */
  readonly r2Key?: string;
  /** IPsec mode: the address of R2's keyring peer (default R1's address). */
  readonly r2KeyringPeer?: string;
  /** IPsec mode: R2 without crypto sections and without Tunnel0 (a silent peer). */
  readonly r2Silent?: boolean;
  /** Called once every device and link exists, before the first run (e.g. to start a capture of the boot). */
  readonly beforeRun?: (sim: Simulation) => void;
}

/** The §3.10 / §3.13 world with the injector on R1 Gi0/1, run to idle (which must return). */
export function tunnelWorld(opts: TunnelWorldOptions): Simulation {
  const sim = createStagedSimulation({ seed: opts.seed ?? (opts.mode === 'gre' ? 18 : 25), stage: 'P3', factories: withInjector() });
  const ipsec = opts.mode === 'ipsec';
  const ospf = opts.ospf === true;
  const r1Routes = ipsec
    ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.226', `ip route 192.168.2.0 ${MASK24} ${TU0}`]
    : ospf
      ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.226']
      : ['ip route 0.0.0.0 0.0.0.0 209.165.200.226', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`];
  const r2Routes = ipsec
    ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.229', `ip route 192.168.1.0 ${MASK24} ${TU0}`]
    : ospf
      ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.229']
      : ['ip route 0.0.0.0 0.0.0.0 209.165.200.229', `ip route 192.168.1.0 ${MASK24} 172.16.0.1`];
  const ospfSection = (lan: string): string[][] => (ospf ? [['router ospf 1', ' network 172.16.0.0 0.0.0.3 area 0', ` network ${lan} 0.0.0.255 area 0`]] : []);
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      [`interface ${GI0}`, ` ip address 192.168.1.1 ${MASK24}`, ' no shutdown'],
      [`interface ${GI1}`, ` ip address 192.168.3.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address ${R1_WAN} ${MASK30}`, ' no shutdown'],
      ...(ipsec ? cryptoSections('R2', R2_WAN, LAB_KEY) : []),
      [`interface ${TU0}`, ...(opts.r1Tunnel ?? (ipsec ? ipsecTunnelLines('172.16.0.1', R2_WAN) : R1_GRE_TUNNEL))],
      r1Routes,
      ...ospfSection('192.168.1.0'),
    ]),
  });
  sim.addDevice({
    id: 'isp', type: 'router.nf2911', name: 'ISP',
    startupConfig: startup([
      ['hostname ISP'],
      [`interface ${SE0}`, ` ip address ${ISP_R1} ${MASK30}`, ' clock rate 2000000', ' no shutdown'],
      [`interface ${SE1}`, ` ip address ${ISP_R2} ${MASK30}`, ' clock rate 2000000', ' no shutdown'],
    ]),
  });
  const r2Silent = ipsec && opts.r2Silent === true;
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      [`interface ${GI0}`, ` ip address 192.168.2.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address ${R2_WAN} ${MASK30}`, ' no shutdown'],
      ...(r2Silent
        ? [['ip route 0.0.0.0 0.0.0.0 209.165.200.229']]
        : [
            ...(ipsec ? cryptoSections('R1', R1_WAN, opts.r2Key ?? LAB_KEY, opts.r2KeyringPeer ?? R1_WAN) : []),
            [`interface ${TU0}`, ...(opts.r2Tunnel ?? (ipsec ? ipsecTunnelLines('172.16.0.2', R1_WAN) : R2_GRE_TUNNEL))],
            r2Routes,
            ...ospfSection('192.168.2.0'),
          ]),
    ]),
  });
  const pc = (name: string, addr: string, gw: string): string =>
    startup([[`hostname ${name}`], [`interface ${PC_PORT}`, ` ip address ${addr} ${MASK24}`], [`ip default-gateway ${gw}`]]);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', PC1_ADDR, '192.168.1.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', PC2_ADDR, '192.168.2.1') });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'inj', port: INJ_PORT }, b: { device: 'r1', port: GI1 } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'isp', port: SE0 }, dceEnd: 'b' });
  sim.addLink({ a: { device: 'isp', port: SE1 }, b: { device: 'r2', port: SE0 }, dceEnd: 'a' });
  sim.addLink({ a: { device: 'r2', port: GI0 }, b: { device: 'pc2', port: PC_PORT } });
  opts.beforeRun?.(sim);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

// ── readers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
export type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;
export type Drop = Extract<TraceEvent, { kind: 'drop' }>;
/** A provenance record as the tests read it. */
export type Mut = { device: string; reason: string; field: string; before: unknown; after: unknown; cause?: string };

export const tunnelRow = (sim: Simulation, device: string): TunnelRow | undefined => sim.device(device)!.tables.get<TunnelRow>('tunnels')?.get(TU0);
export const saRow = (sim: Simulation, device: string): IpsecSaRow | undefined => sim.device(device)!.tables.get<IpsecSaRow>('ipsec-sa')?.get(TU0);
export const tunnelUp = (sim: Simulation, device: string): boolean => sim.device(device)!.port(TU0)?.operUp === true;

/** The networks of `device`'s RIB that are private (RFC 1918 192.168/16 or 172.16/12). */
export function privateRoutes(sim: Simulation, device: string): string[] {
  return sim.device(device)!.tables.rib.rows().map((r) => r.network).filter((n) => n.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(n));
}

/** Apply one stored line on `device` at `sim.now` (the device clock synced first, as the facade does). */
export function applyLine(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): void {
  const d = sim.device(device)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, tokens, negate)).toEqual({ ok: true });
}

/** Apply one stored line, then run to idle (which must return); the events of both. */
export function line(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): TraceEvent[] {
  const cursor = sim.trace(0).next;
  applyLine(sim, device, context, tokens, negate);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim.trace(cursor).events;
}

/** An ICMP echo request of `size` bytes (IPv4 total length) from PC1's address to PC2, as the injector sends it. */
export function oversizeEcho(sim: Simulation, size: number, df: boolean): LayerSpec[] {
  const r1Mac = sim.device('r1')!.port(GI1)!.mac;
  const injMac = sim.device('inj')!.port(INJ_PORT)!.mac;
  return [
    { proto: 'ethernet', fields: { dst: r1Mac, src: injMac, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: PC1_ADDR, dst: PC2_ADDR, protocol: IPPROTO_ICMP, ttl: 64, flags: df ? 2 : 0, id: size } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id: 9, seq: size } },
    { proto: 'payload', fields: { data: new Uint8Array(size - 28) } },
  ];
}

/** True when `bytes` contain the ASCII text `text`. */
export function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = Array.from(text, (ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/** JSON of a value with byte arrays as number lists (trace and snapshot scans). */
export function jsonOf(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? Array.from(x) : x));
}
