/**
 * test/accept.p3.qos.harness.ts — the shared world of the W4 QoS acceptance rows (ARCHITECTURE-P3 §10.1
 * `accept.p3.qos-marking`, [S20] `accept.p3.qos-llq`, `accept.p3.qos-cbwfq`, [S21] `accept.p3.qos-police-shape`;
 * §3.5, §3.11; §7 W4 qa). Not a test file.
 *
 * The world is §3.5's, built on `staged.world` at stage P3 (rule 13; the catalog flip is a later, separate step):
 *
 *   PC-V 192.168.1.10 ─ Fa0/1 ┐                                   Se0/0/0 (DCE, clock rate 128000)
 *   PC-D 192.168.1.20 ─ Fa0/2 ┤ SW1 Gi0/1 ── Gi0/0 R1 192.168.1.1 ──────────── R2 Se0/0/0 ── Gi0/0 R2 ── PC-S
 *   [INJ Gi0          ─ Fa0/3 ┘]                     10.0.0.1/30          10.0.0.2/30   192.168.2.1   192.168.2.10
 *   [PC-T 192.168.10.10 ─ Fa0/4 (VLAN 10); SW1 Gi0/2 (trunk) ── R1 Gi0/1, Gi0/1.10 dot1Q 10 192.168.10.1]
 *
 * R1 holds §3.5's marking policy (`VOICE-PORTS`, `VOIP`, `MARK` on Gi0/0 input) unless a caller replaces it; static
 * routes join the two LANs. The bracketed parts are optional: the test injector on SW1 (a frame the switch floods to R1
 * for another MAC) and a router-on-a-stick leg (output marking on a subinterface).
 *
 * The daemon registry is `PROCESS_FACTORIES`, which since the W4 catalog flip holds every approved P3 daemon (the
 * seven MUST daemons and the eight of the approved items), so the world is the one the flipped catalog builds: CDP runs
 * on the router and the switch (P3 profile), every other P3 daemon is silent without its lines (ruling R47 removed the
 * pre-flip overlay, `P3_ACCEPT_FACTORIES`; only the test injector is laid over the registry).
 *
 * Flows start from the host shell (`flow start …`, a journaled `cliExec`, §3.5 step 2). Pings warm every ARP cache
 * first, so no datagram of a flow waits for a resolution.
 */
import type { DeviceId, PduId, PortId } from '../src/contracts/ids.js';
import type { Mutation } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { INJECTOR_HOST_TYPE, withInjector } from './inject.js';
import { createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

// ── names ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PC_PORT = 'GigabitEthernet0';
export const R_LAN = 'GigabitEthernet0/0';
export const R1_TRUNK = 'GigabitEthernet0/1';
export const R1_SUB = 'GigabitEthernet0/1.10';
export const SE0 = 'Serial0/0/0';
export const INJ_PORT = 'GigabitEthernet0';

export const PCV_IP = '192.168.1.10';
export const PCD_IP = '192.168.1.20';
export const PCS_IP = '192.168.2.10';
export const PCT_IP = '192.168.10.10';
export const R1_SUB_IP = '192.168.10.1';

/** §3.5's marking lines on R1 (before its interfaces). */
export const MARK_LINES: readonly string[] = Object.freeze([
  'ip access-list extended VOICE-PORTS',
  ' permit udp any any range 16384 32767',
  '!',
  'class-map match-all VOIP',
  ' match access-group name VOICE-PORTS',
  '!',
  'policy-map MARK',
  ' class VOIP',
  '  set dscp ef',
  '!',
]);

/** The cause every voice rewrite at R1 carries (§3.5 step 3). */
export const MARK_CAUSE = 'policy-map MARK class VOIP set dscp ef';

/** The voice flow of §3.5 step 2 (PC-V), bounded by `count` (50 per second). */
export const voiceFlow = (count: number): string => `flow start ${PCS_IP} pps 50 size 60 port 16384 count ${count}`;
/** The data flow of §3.5 step 2 (PC-D: 200 kb/s of 1000-byte datagrams, port 9), bounded by `count` (25 per second). */
export const dataFlow = (count: number): string => `flow start ${PCS_IP} rate 200 size 1000 count ${count}`;

// ── the world ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface QosWorldOptions {
  readonly seed?: number;
  /** R1's global QoS lines (default `MARK_LINES`). */
  readonly r1Qos?: readonly string[];
  /** Extra lines of R1 Gi0/0 (default `service-policy input MARK`). */
  readonly r1Lan?: readonly string[];
  /** Extra lines of R1 Se0/0/0 (after its address and clock rate). */
  readonly r1Serial?: readonly string[];
  /** R1's clock rate (default 128000). */
  readonly clockRate?: number;
  /** The test injector on SW1 Fa0/3. */
  readonly injector?: boolean;
  /** The router-on-a-stick leg: SW1 Gi0/2 trunk ── R1 Gi0/1 (Gi0/1.10 dot1Q 10) and PC-T on Fa0/4 (VLAN 10). */
  readonly subinterface?: readonly string[];
}

function config(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const pcConfig = (name: string, ip: string, gw: string): string =>
  config([[`hostname ${name}`], [`interface ${PC_PORT}`, ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${gw}`]]);

/**
 * The §3.5 world, booted and settled (60 s, every LAN port forwarding), with every ARP cache warm (one ping from each
 * sender to PC-S, and from PC-T to R1's subinterface when that leg exists). Devices: `pcv`, `pcd`, `sw1`, `r1`, `r2`,
 * `pcs` (and `inj`, `pct`).
 */
export function qosWorld(o: QosWorldOptions = {}): Simulation {
  const factories: StagedFactoryOverlay = o.injector === true ? withInjector() : {};
  const sim = createStagedSimulation({ seed: o.seed ?? 27, stage: 'P3', factories });
  const sub = o.subinterface;
  sim.addDevice({ id: 'pcv', type: 'pc.nfpc', name: 'PC-V', startupConfig: pcConfig('PC-V', PCV_IP, '192.168.1.1') });
  sim.addDevice({ id: 'pcd', type: 'pc.nfpc', name: 'PC-D', startupConfig: pcConfig('PC-D', PCD_IP, '192.168.1.1') });
  sim.addDevice({ id: 'pcs', type: 'pc.nfpc', name: 'PC-S', startupConfig: pcConfig('PC-S', PCS_IP, '192.168.2.1') });
  const access = (port: string, vlan?: number): string[] => [
    `interface ${port}`,
    ' switchport mode access',
    ...(vlan === undefined ? [] : [` switchport access vlan ${vlan}`]),
    ' spanning-tree portfast',
  ];
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: config([
      ['hostname SW1'],
      ...(sub !== undefined ? [['vlan 10']] : []),
      access('FastEthernet0/1'),
      access('FastEthernet0/2'),
      access('FastEthernet0/3'),
      ...(sub !== undefined ? [access('FastEthernet0/4', 10), ['interface GigabitEthernet0/2', ' switchport mode trunk']] : []),
      ['interface GigabitEthernet0/1', ' switchport mode access', ' spanning-tree portfast'],
    ]),
  });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: config([
      ['hostname R1'],
      [...(o.r1Qos ?? MARK_LINES)],
      [`interface ${R_LAN}`, ' ip address 192.168.1.1 255.255.255.0', ...(o.r1Lan ?? [' service-policy input MARK']).map((l) => (l.startsWith(' ') ? l : ` ${l}`)), ' no shutdown'],
      ...(sub !== undefined
        ? [
            [`interface ${R1_TRUNK}`, ' no shutdown'],
            [`interface ${R1_SUB}`, ' encapsulation dot1Q 10', ` ip address ${R1_SUB_IP} 255.255.255.0`, ...sub.map((l) => ` ${l.trim()}`)],
          ]
        : []),
      [
        `interface ${SE0}`,
        ' ip address 10.0.0.1 255.255.255.252',
        ` clock rate ${o.clockRate ?? 128000}`,
        ...(o.r1Serial ?? []).map((l) => ` ${l.trim()}`),
        ' no shutdown',
      ],
      ['ip route 192.168.2.0 255.255.255.0 10.0.0.2'],
    ]),
  });
  sim.addDevice({
    id: 'r2',
    type: 'router.nf2911',
    name: 'R2',
    startupConfig: config([
      ['hostname R2'],
      [`interface ${SE0}`, ' ip address 10.0.0.2 255.255.255.252', ' no shutdown'],
      [`interface ${R_LAN}`, ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
      ['ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'ip route 192.168.10.0 255.255.255.0 10.0.0.1'],
    ]),
  });
  sim.addLink({ a: { device: 'pcv', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pcd', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'r1', port: R_LAN } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ a: { device: 'r2', port: R_LAN }, b: { device: 'pcs', port: PC_PORT } });
  if (o.injector === true) {
    sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
    sim.addLink({ a: { device: 'inj', port: INJ_PORT }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  }
  if (sub !== undefined) {
    sim.addDevice({ id: 'pct', type: 'pc.nfpc', name: 'PC-T', startupConfig: pcConfig('PC-T', PCT_IP, R1_SUB_IP) });
    sim.addLink({ a: { device: 'pct', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/4' } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'r1', port: R1_TRUNK } });
  }
  sim.runFor(60 * SEC);
  // warm every ARP cache on the flows' paths (one echo each), so no datagram waits for a resolution
  hostExec(sim, 'pcv', `ping ${PCS_IP}`);
  hostExec(sim, 'pcd', `ping ${PCS_IP}`);
  if (sub !== undefined) hostExec(sim, 'pct', `ping ${R1_SUB_IP}`);
  sim.runFor(15 * SEC);
  return sim;
}

// ── sessions ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line in a fresh console session of `device` (a host shell on a PC); returns its output. */
export function hostExec(sim: Simulation, device: DeviceId, line: string): string {
  const s = sim.cli.open(device, 'console');
  const r = sim.cli.exec(s, line);
  if (r.error !== undefined) throw new Error(`${device}: ${line}: ${r.error.message}`);
  return r.output;
}

/** Lines in one console session of a router (typed in order); returns each result. */
export function routerExec(sim: Simulation, device: DeviceId, lines: readonly string[]): { output: string; error?: string }[] {
  const s = sim.cli.open(device, 'console');
  return lines.map((l) => {
    const r = sim.cli.exec(s, l);
    return r.error === undefined ? { output: r.output } : { output: r.output, error: r.error.message };
  });
}

/** `show policy-map interface <port>` on `device` (privileged). */
export function showPolicyMapInterface(sim: Simulation, device: DeviceId, port: PortId): string {
  const [, r] = routerExec(sim, device, ['enable', `show policy-map interface ${port}`]);
  return r!.output;
}

// ── trace ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Of<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>;
export const ofKind = <K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Of<K>[] => evs.filter((e): e is Of<K> => e.kind === kind);

/** Every trace event from `cursor` on; throws when the ring (200 000 events) has already dropped some of them. */
export function traceFrom(sim: Simulation, cursor = 0): TraceEvent[] {
  const page = sim.trace(cursor);
  if (page.dropped > 0) throw new Error(`the trace ring dropped ${page.dropped} events after cursor ${cursor}`);
  return page.events;
}

/** A mutation record without its time and device. */
export type MutationRecord = Omit<Mutation, 'at' | 'device'>;

const recordOf = (m: Mutation): MutationRecord => ({ reason: m.reason, field: m.field, before: m.before, after: m.after, ...(m.cause === undefined ? {} : { cause: m.cause }) });

/** The mutations `device` recorded on `pdu` (from the trace), without their time and device. */
export function mutationsAt(evs: readonly TraceEvent[], pdu: PduId, device: DeviceId): MutationRecord[] {
  return ofKind(evs, 'mutation')
    .filter((e) => e.pdu === pdu && e.mutation.device === device)
    .map(({ mutation: m }) => recordOf(m));
}

/** Every mutation `device` recorded (from the trace), by PDU, in trace order: `mutationsAt` for many PDUs at once. */
export function mutationsByPdu(evs: readonly TraceEvent[], device: DeviceId): (pdu: PduId) => MutationRecord[] {
  const out = new Map<PduId, MutationRecord[]>();
  for (const e of ofKind(evs, 'mutation')) {
    if (e.mutation.device !== device) continue;
    let list = out.get(e.pdu);
    if (list === undefined) out.set(e.pdu, (list = []));
    list.push(recordOf(e.mutation));
  }
  return (pdu) => out.get(pdu) ?? [];
}

/** The datagrams `device`'s traffic daemon built (pduCreated by `traffic`), in order. */
export function trafficPdus(evs: readonly TraceEvent[], device: DeviceId): PduId[] {
  return ofKind(evs, 'pduCreated').filter((e) => e.device === device && e.process === 'traffic').map((e) => e.pdu.id);
}
