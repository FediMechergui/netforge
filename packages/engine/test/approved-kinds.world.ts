/**
 * test/approved-kinds.world.ts — the P3-profile worlds of the W5 sim tests (ARCHITECTURE-P3 §7 W5 sim):
 * `sim.lab-checks.approved-kinds.test.ts` and `accept.p3.grader-bounded.test.ts`. Not a test file.
 *
 * Every world is a `topology(…, {profile: 'P3'})` written with the scenario kit, as the CCNA 3 labs write theirs, and
 * runs on the REAL catalog (the flipped one, CATALOG_STAGE 'P3'):
 *   • `sshWorld` (§3.14): PC1 192.168.10.10 and PC2 .11 on SW1 → R1 Gi0/0 192.168.10.1, SSH only, `login local`,
 *     `access-class 10 in` admitting PC1 only;
 *   • `tunnelWorld('gre')` (§3.10): PC1 — R1 — ISP — R2 — PC2 with a GRE Tunnel0 (static route through 172.16.0.2),
 *     and a bystander PC3 on R1 Gi0/1; the ISP has no private route. `tunnelWorld('ipsec', key?, {silentPeer?})`
 *     (§3.13): the same sites over a protected VTI, optionally with another key on R2 or R2 without any crypto;
 *   • `ipv6World`: PC1 — R1 — PC2, SLAAC on both LANs;
 *   • `qosWorld(llq)` (§3.5, §3.11): PC-V and PC-D on SW1 → R1 — 128 kb/s serial — R2 → PC-S, R1 marking voice EF at
 *     the LAN edge, with or without the LLQ policy on the serial port;
 *   • `pairWorld(r1, r2, link)`: two routers on one cable (Gi0/0 10.0.12.1/30 — 10.0.12.2/30, or a serial link with
 *     R1 the DCE), each with the extra configuration sections given (the bounded worlds of `grader-bounded`).
 * Nothing here is module-level mutable state (rule 12).
 */
import { expect } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { PC, ROUTER, SWITCH, accessPort, cable, configText, device, link, section, topology } from '../src/sim/scenarios/kit.js';
import { createSimulation } from '../src/sim/simulation.js';

export const MASK24 = '255.255.255.0';
export const MASK30 = '255.255.255.252';
/** The SSH world's admin password, and the IPsec worlds' pre-shared key (lab values). */
export const PASSWORD = 'Lab-Pass1';
export const KEY = 'Nf-Site-Key-25';

/** A host's startup configuration (`extra` lines on its port, after the address). */
export const pc = (name: string, address: string, gateway: string, extra: readonly string[] = []): string =>
  configText([[`hostname ${name}`], section('interface GigabitEthernet0', [`ip address ${address} ${MASK24}`, ...extra]), [`ip default-gateway ${gateway}`]]);

/** Load `t`, boot and settle it (a router boots in 45 s). */
export function boot(t: Topology): Simulation {
  const sim = createSimulation({ seed: t.seed });
  sim.loadTopology(t);
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

export function sshWorld(): Topology {
  return topology(
    314,
    [
      device('pc1', PC, 'PC1', 100, 300, pc('PC1', '192.168.10.10', '192.168.10.1')),
      device('pc2', PC, 'PC2', 300, 300, pc('PC2', '192.168.10.11', '192.168.10.1')),
      device(
        'sw1',
        SWITCH,
        'SW1',
        200,
        200,
        configText([
          ['hostname SW1'],
          accessPort('FastEthernet0/1', 1, { portfast: true }),
          accessPort('FastEthernet0/2', 1, { portfast: true }),
          accessPort('GigabitEthernet0/1', 1, { portfast: true }),
        ]),
      ),
      device(
        'r1',
        ROUTER,
        'R1',
        200,
        100,
        configText([
          ['hostname R1'],
          section('interface GigabitEthernet0/0', [`ip address 192.168.10.1 ${MASK24}`, 'no shutdown']),
          ['ip domain-name lab.nf', 'crypto key generate rsa modulus 1024', 'ip ssh version 2', `username admin secret ${PASSWORD}`, 'access-list 10 permit host 192.168.10.10'],
          section('line vty 0 4', ['login local', 'transport input ssh', 'access-class 10 in']),
        ]),
      ),
    ],
    [
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
      link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
      link('l_r1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
    ],
    [],
    '',
    { profile: 'P3' },
  );
}

/** The ipsec-mode Tunnel0 body and the three crypto sections of one end (§3.13 setup). */
const ipsecTunnel = (address: string, destination: string): string[] =>
  section('interface Tunnel0', [`ip address ${address} ${MASK30}`, 'tunnel source Serial0/0/0', `tunnel destination ${destination}`, 'tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VPN']);
const crypto = (peerName: string, peer: string, key: string): string[][] => [
  ['crypto ikev2 keyring KR', ` peer ${peerName}`, `  address ${peer}`, `  pre-shared-key ${key}`],
  ['crypto ikev2 profile PROF', ` match identity remote address ${peer} 255.255.255.255`, ' authentication remote pre-share', ' authentication local pre-share', ' keyring local KR'],
  ['crypto ipsec profile VPN', ' set ikev2-profile PROF'],
];

/**
 * §3.10 (GRE) or §3.13 (a protected VTI) between PC1's and PC2's sites, PC3 on R1 Gi0/1 as a bystander. In ipsec mode
 * `r2Key` is R2's pre-shared key, and `silentPeer` leaves R2 without crypto, tunnel or the route through it.
 */
export function tunnelWorld(mode: 'gre' | 'ipsec', r2Key: string = KEY, opts: { readonly silentPeer?: boolean } = {}): Topology {
  const r1Tunnel =
    mode === 'gre'
      ? [section('interface Tunnel0', [`ip address 172.16.0.1 ${MASK30}`, 'tunnel source Serial0/0/0', 'tunnel destination 209.165.200.230'])]
      : [...crypto('R2', '209.165.200.230', KEY), ipsecTunnel('172.16.0.1', '209.165.200.230')];
  const silent = mode === 'ipsec' && opts.silentPeer === true;
  const r2Tunnel = silent
    ? []
    : mode === 'gre'
      ? [section('interface Tunnel0', [`ip address 172.16.0.2 ${MASK30}`, 'tunnel source Serial0/0/0', 'tunnel destination 209.165.200.225'])]
      : [...crypto('R1', '209.165.200.225', r2Key), ipsecTunnel('172.16.0.2', '209.165.200.225')];
  const via = (lan: string, far: string): string[] => (silent ? [] : [mode === 'gre' ? `ip route ${lan} ${MASK24} ${far}` : `ip route ${lan} ${MASK24} Tunnel0`]);
  return topology(
    mode === 'gre' ? 24 : 25,
    [
      device('pc1', PC, 'PC1', 50, 300, pc('PC1', '192.168.1.10', '192.168.1.1')),
      device('pc3', PC, 'PC3', 50, 100, pc('PC3', '192.168.3.10', '192.168.3.1')),
      device(
        'r1',
        ROUTER,
        'R1',
        200,
        200,
        configText([
          ['hostname R1'],
          section('interface GigabitEthernet0/0', [`ip address 192.168.1.1 ${MASK24}`, 'no shutdown']),
          section('interface GigabitEthernet0/1', [`ip address 192.168.3.1 ${MASK24}`, 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 209.165.200.225 ${MASK30}`, 'no shutdown']),
          ...r1Tunnel,
          ['ip route 0.0.0.0 0.0.0.0 209.165.200.226', ...via('192.168.2.0', '172.16.0.2')],
        ]),
      ),
      device(
        'isp',
        ROUTER,
        'ISP',
        400,
        200,
        configText([
          ['hostname ISP'],
          section('interface Serial0/0/0', [`ip address 209.165.200.226 ${MASK30}`, 'clock rate 2000000', 'no shutdown']),
          section('interface Serial0/0/1', [`ip address 209.165.200.229 ${MASK30}`, 'clock rate 2000000', 'no shutdown']),
        ]),
      ),
      device(
        'r2',
        ROUTER,
        'R2',
        600,
        200,
        configText([
          ['hostname R2'],
          section('interface GigabitEthernet0/0', [`ip address 192.168.2.1 ${MASK24}`, 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 209.165.200.230 ${MASK30}`, 'no shutdown']),
          ...r2Tunnel,
          ['ip route 0.0.0.0 0.0.0.0 209.165.200.229', ...via('192.168.1.0', '172.16.0.1')],
        ]),
      ),
      device('pc2', PC, 'PC2', 750, 300, pc('PC2', '192.168.2.10', '192.168.2.1')),
    ],
    [
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
      link('l_pc3', 'pc3', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1'),
      cable('l_r1_isp', 'isp', 'Serial0/0/0', 'r1', 'Serial0/0/0', 'serial-dce'),
      cable('l_isp_r2', 'isp', 'Serial0/0/1', 'r2', 'Serial0/0/0', 'serial-dce'),
      link('l_pc2', 'r2', 'GigabitEthernet0/0', 'pc2', 'GigabitEthernet0'),
    ],
    [],
    '',
    { profile: 'P3' },
  );
}

/** PC1 — R1 — PC2 over IPv6 (SLAAC on both LANs) and IPv4. */
export function ipv6World(): Topology {
  const autoconfig = ['ipv6 address autoconfig'];
  return topology(
    66,
    [
      device('pc1', PC, 'PC1', 50, 200, pc('PC1', '192.168.1.10', '192.168.1.1', autoconfig)),
      device(
        'r1',
        ROUTER,
        'R1',
        200,
        200,
        configText([
          ['hostname R1'],
          ['ipv6 unicast-routing'],
          section('interface GigabitEthernet0/0', [`ip address 192.168.1.1 ${MASK24}`, 'ipv6 address 2001:db8:1::1/64', 'no shutdown']),
          section('interface GigabitEthernet0/1', [`ip address 192.168.2.1 ${MASK24}`, 'ipv6 address 2001:db8:2::1/64', 'no shutdown']),
        ]),
      ),
      device('pc2', PC, 'PC2', 350, 200, pc('PC2', '192.168.2.10', '192.168.2.1', autoconfig)),
    ],
    [link('l_pc1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'), link('l_pc2', 'r1', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0')],
    [],
    '',
    { profile: 'P3' },
  );
}

/** §3.5's world with `clock rate 128000`; `llq` adds §3.11's WAN-EDGE policy on R1 Se0/0/0. */
export function qosWorld(llq: boolean): Topology {
  const mark = [
    ['ip access-list extended VOICE-PORTS', ' permit udp any any range 16384 32767'],
    ['class-map match-all VOIP', ' match access-group name VOICE-PORTS'],
    ['policy-map MARK', ' class VOIP', '  set dscp ef'],
  ];
  const wanEdge = llq ? [['class-map match-all VOICE', ' match dscp ef'], ['policy-map WAN-EDGE', ' class VOICE', '  priority 32', ' class class-default', '  fair-queue']] : [];
  return topology(
    27,
    [
      device('pcv', PC, 'PC-V', 50, 300, pc('PC-V', '192.168.1.10', '192.168.1.1')),
      device('pcd', PC, 'PC-D', 150, 300, pc('PC-D', '192.168.1.20', '192.168.1.1')),
      device(
        'sw1',
        SWITCH,
        'SW1',
        100,
        200,
        configText([
          ['hostname SW1'],
          accessPort('FastEthernet0/1', 1, { portfast: true }),
          accessPort('FastEthernet0/2', 1, { portfast: true }),
          accessPort('GigabitEthernet0/1', 1, { portfast: true }),
        ]),
      ),
      device(
        'r1',
        ROUTER,
        'R1',
        250,
        200,
        configText([
          ['hostname R1'],
          ...mark,
          ...wanEdge,
          section('interface GigabitEthernet0/0', [`ip address 192.168.1.1 ${MASK24}`, 'service-policy input MARK', 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 10.0.0.1 ${MASK30}`, 'clock rate 128000', 'bandwidth 128', ...(llq ? ['service-policy output WAN-EDGE'] : []), 'no shutdown']),
          [`ip route 192.168.2.0 ${MASK24} 10.0.0.2`],
        ]),
      ),
      device(
        'r2',
        ROUTER,
        'R2',
        450,
        200,
        configText([
          ['hostname R2'],
          section('interface Serial0/0/0', [`ip address 10.0.0.2 ${MASK30}`, 'no shutdown']),
          section('interface GigabitEthernet0/0', [`ip address 192.168.2.1 ${MASK24}`, 'no shutdown']),
          [`ip route 192.168.1.0 ${MASK24} 10.0.0.1`],
        ]),
      ),
      device('pcs', PC, 'PC-S', 600, 300, pc('PC-S', '192.168.2.10', '192.168.2.1')),
    ],
    [
      link('l_pcv', 'pcv', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
      link('l_pcd', 'pcd', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
      link('l_r1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
      cable('l_wan', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
      link('l_pcs', 'r2', 'GigabitEthernet0/0', 'pcs', 'GigabitEthernet0'),
    ],
    [],
    '',
    { profile: 'P3' },
  );
}


/** One router of `pairWorld`: lines for its link interface (after the address) and global sections. */
export interface PairRouter {
  readonly iface?: readonly string[];
  readonly global?: readonly (readonly string[])[];
}

/**
 * Two routers on one cable: GigabitEthernet0/0 10.0.12.1/30 — 10.0.12.2/30, or (`serial`) Serial0/0/0 with R1 the DCE
 * end (`clock rate 2000000`). Each gets its extra interface lines and global sections.
 */
export function pairWorld(seed: number, media: 'ethernet' | 'serial', r1: PairRouter, r2: PairRouter): Topology {
  const port = media === 'serial' ? 'Serial0/0/0' : 'GigabitEthernet0/0';
  const router = (id: string, name: string, address: string, r: PairRouter, dce: boolean): ReturnType<typeof device> =>
    device(
      id,
      ROUTER,
      name,
      id === 'r1' ? 100 : 300,
      100,
      configText([
        [`hostname ${name}`],
        section(`interface ${port}`, [`ip address ${address} ${MASK30}`, ...(dce ? ['clock rate 2000000'] : []), ...(r.iface ?? []), 'no shutdown']),
        ...(r.global ?? []).map((s) => [...s]),
      ]),
    );
  return topology(
    seed,
    [router('r1', 'R1', '10.0.12.1', r1, media === 'serial'), router('r2', 'R2', '10.0.12.2', r2, false)],
    [media === 'serial' ? cable('l_r1_r2', 'r1', port, 'r2', port, 'serial-dce') : link('l_r1_r2', 'r1', port, 'r2', port)],
    [],
    '',
    { profile: 'P3' },
  );
}
