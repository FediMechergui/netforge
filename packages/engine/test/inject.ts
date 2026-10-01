/**
 * test/inject.ts — the test frame injector (ARCHITECTURE-P3 §7 W1 qa, D13, §3.4 steps 5 and 7).
 *
 * No MUST sender produces a DHCP or ARP burst (a DHCP server sends one OFFER per DISCOVER; the traffic generator's
 * payload is neither DHCP nor ARP), so the DHCP snooping and DAI rate limits are proven with injected frames:
 *
 *   const sim = createStagedSimulation({ seed, stage: 'P3', factories: withInjector({ ... }) });
 *   sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'ROGUE' });           // cabled like any host
 *   …
 *   const ticket = injectFrames(sim, { from: 'inj', port: 'GigabitEthernet0', frames: [dhcpServerFrame({ … })],
 *                                      count: 11, spacingNs: 10 * MS });
 *   sim.runUntil(ticket.lastAt); …
 *
 * Pieces:
 *  • `createInjector()` — the test-only `injector` daemon. It keeps the jobs it is given and, on each job's timer
 *    `inject:<n>` (non-periodic, so `runToIdle` waits for the job's end), builds the next pre-built frame with
 *    `ctx.newPdu` (a fresh PDU each time, meta tag `injected`) and sends it out of the job's port; frames are taken in
 *    order and cycled when `count` exceeds their number. It sends nothing else and declares no demux selector, so a
 *    frame reaching the host (a flooded broadcast) ends in the device pipeline as at any device without a daemon for
 *    it. No randomness, no wall clock.
 *  • `withInjector(overlay)` — a `staged.world` factory overlay with the injector registered; `staged.world` then adds
 *    the test-only host NF-INJECTOR (`INJECTOR_HOST_TYPE`: no capability, four gigabit ports, the injector its only
 *    daemon) to the catalog.
 *  • `injectFrames(sim, {from, port, frames, count, spacingNs, startNs})` — gives the booted injector of device `from`
 *    a job and arms its first timer through the device runtime (`applyActions`, the runtime's scheduler), at
 *    `sim.now + startNs` (default 0); frame k (0-based) leaves at `firstAt + k · spacingNs`. Returns the ticket. An
 *    injection is a test-only side door: it is not a journaled input, so a replay of the world's journal does not
 *    repeat it (tests compare two worlds that inject the same way instead).
 *  • Frame builders for the two bursts the brief names: `dhcpServerFrame` (a server message, OFFER by default, from a
 *    given MAC and address, UDP 67 → 68, broadcast) and `arpFrame` (a request or reply; broadcast by default); both
 *    take an optional 802.1Q `vlan` for trunk ports.
 *
 * Nothing here is module-level mutable state: each `createInjector()` call owns its jobs (rule 12).
 */
import { MAC_BROADCAST, MAC_ZERO } from '../src/contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../src/contracts/addr.js';
import type { DeviceId, PortId } from '../src/contracts/ids.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_VLAN, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { FieldValue, LayerSpec } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessFactory, StateView } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimTime } from '../src/contracts/time.js';
import { INJECTOR_HOST_TYPE, INJECTOR_PROCESS, type StagedFactoryOverlay } from './staged.world.js';

export { INJECTOR_HOST_TYPE, INJECTOR_PROCESS };

/** The meta tag of every injected frame. */
export const INJECTED_TAG = 'injected';
/** The injector's timer prefix: `inject:<job>`. */
export const INJECT_TIMER_PREFIX = 'inject:';

/** One job: frames to send out of `port`, `count` in all, `spacingNs` apart. */
export interface InjectJob {
  readonly port: PortId;
  /** Pre-built frames (layer specs, outermost first), sent in order and cycled. */
  readonly frames: readonly (readonly LayerSpec[])[];
  readonly count: number;
  readonly spacingNs: SimTime;
}

/** The injector daemon with its test entry point. */
export interface InjectorProcess extends Process {
  /** Store `job` and return the timer key that sends its frames (the caller arms it for the first frame). */
  enqueue(job: InjectJob): string;
}

interface RunningJob {
  readonly job: InjectJob;
  sent: number;
}

/** A fresh injector daemon (the `injector` factory). */
export function createInjector(): InjectorProcess {
  const jobs = new Map<string, RunningJob>();
  let nextJob = 1;
  let framesSent = 0;
  return {
    name: INJECTOR_PROCESS,
    enqueue(job: InjectJob): string {
      if (job.frames.length === 0) throw new RangeError('injectFrames: at least one frame is required');
      const key = `${INJECT_TIMER_PREFIX}${nextJob++}`;
      jobs.set(key, { job, sent: 0 });
      return key;
    },
    onPdu(): Action[] {
      return [];
    },
    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const run = jobs.get(key);
      if (run === undefined) return [];
      const { job } = run;
      const layers = job.frames[run.sent % job.frames.length] as readonly LayerSpec[];
      const pdu = ctx.newPdu(layers.map((l) => ({ proto: l.proto, fields: { ...l.fields } })), { tag: INJECTED_TAG });
      run.sent++;
      framesSent++;
      const out: Action[] = [{ type: 'send', port: job.port, pdu }];
      if (run.sent < job.count) out.push({ type: 'timer', key, delay: job.spacingNs });
      else jobs.delete(key);
      return out;
    },
    onConfig(): Action[] {
      return [];
    },
    stateSnapshot(): StateView {
      return { process: INJECTOR_PROCESS, state: { jobs: jobs.size, framesSent } };
    },
    debugEvents() {
      return [];
    },
  };
}

/** The injector's factory, for a `staged.world` overlay. */
export const injectorFactory: ProcessFactory = createInjector;

/** `overlay` with the injector registered (so `staged.world` adds the NF-INJECTOR host to the catalog). */
export function withInjector(overlay: StagedFactoryOverlay = {}): StagedFactoryOverlay {
  return { ...overlay, [INJECTOR_PROCESS]: injectorFactory };
}

/** What `injectFrames` sends. */
export interface InjectSpec {
  /** The injector host (a device of type `INJECTOR_HOST_TYPE`, booted). */
  readonly from: DeviceId;
  /** The port the frames leave by. */
  readonly port: PortId;
  /** Pre-built frames (layer specs, outermost first), sent in order and cycled. */
  readonly frames: readonly (readonly LayerSpec[])[];
  /** Frames to send in all (default: `frames.length`). */
  readonly count?: number;
  /** Fixed spacing between two frames (integer ns, ≥ 0). */
  readonly spacingNs: SimTime;
  /** Delay of the first frame after `sim.now` (integer ns, default 0). */
  readonly startNs?: SimTime;
}

/** The schedule of an injection. */
export interface InjectTicket {
  /** The job's timer key. */
  readonly key: string;
  readonly count: number;
  /** When the first frame leaves. */
  readonly firstAt: SimTime;
  /** When the last frame leaves: `firstAt + (count − 1) · spacingNs`. */
  readonly lastAt: SimTime;
}

/**
 * Hand the injector of `spec.from` a job and arm its first timer. Throws when the device does not exist, is not booted
 * or runs no injector, or when the spacing, start or count is not a non-negative integer (count ≥ 1).
 */
export function injectFrames(sim: Simulation, spec: InjectSpec): InjectTicket {
  const count = spec.count ?? spec.frames.length;
  const startNs = spec.startNs ?? 0;
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`injectFrames: count must be a positive integer, got ${count}`);
  if (!Number.isInteger(spec.spacingNs) || spec.spacingNs < 0) throw new RangeError(`injectFrames: spacingNs must be a non-negative integer, got ${spec.spacingNs}`);
  if (!Number.isInteger(startNs) || startNs < 0) throw new RangeError(`injectFrames: startNs must be a non-negative integer, got ${startNs}`);
  const device = sim.device(spec.from);
  if (device === undefined) throw new Error(`injectFrames: no device ${spec.from}`);
  const proc = device.processes.get(INJECTOR_PROCESS) as InjectorProcess | undefined;
  if (proc === undefined || typeof proc.enqueue !== 'function') {
    throw new Error(`injectFrames: ${spec.from} runs no injector (add a ${INJECTOR_HOST_TYPE} to a world built with withInjector(), and let it boot)`);
  }
  if (device.port(spec.port) === undefined) throw new Error(`injectFrames: ${spec.from} has no port ${spec.port}`);
  const key = proc.enqueue({ port: spec.port, frames: spec.frames, count, spacingNs: spec.spacingNs });
  const now = sim.now;
  device.applyActions(INJECTOR_PROCESS, [{ type: 'timer', key, delay: startNs }], now);
  const firstAt = now + startNs;
  return { key, count, firstAt, lastAt: firstAt + (count - 1) * spec.spacingNs };
}

// ── frame builders ────────────────────────────────────────────────────────────────────────────────────────────

/** The Ethernet header (and an 802.1Q tag when `vlan` is given) for a payload of ethertype `type`. */
function ethernet(dst: MacAddress, src: MacAddress, type: number, vlan: number | undefined): LayerSpec[] {
  if (vlan === undefined) return [{ proto: 'ethernet', fields: { dst, src, type } }];
  return [
    { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_VLAN } },
    { proto: 'dot1q', fields: { vid: vlan, type } },
  ];
}

/** Options of `dhcpServerFrame`. */
export interface DhcpServerFrameOptions {
  /** The server's MAC (the Ethernet source). */
  readonly srcMac: MacAddress;
  /** The server's address (IPv4 source and option 54). */
  readonly serverIp: Ipv4Address;
  /** The client the message is for. */
  readonly chaddr: MacAddress;
  /** The offered address (default 0.0.0.0, e.g. for a NAK). */
  readonly yiaddr?: Ipv4Address;
  /** Option 53 (default OFFER). */
  readonly type?: 'OFFER' | 'ACK' | 'NAK';
  readonly xid?: number;
  /** Option 51, seconds (default 86400; none on a NAK). */
  readonly leaseS?: number;
  /** Ethernet destination (default broadcast). */
  readonly dstMac?: MacAddress;
  /** An 802.1Q tag, for a trunk port. */
  readonly vlan?: number;
}

/** A DHCP server message, UDP 67 → 68 to 255.255.255.255 (the rogue server's OFFER of §3.4 by default). */
export function dhcpServerFrame(o: DhcpServerFrameOptions): LayerSpec[] {
  const type = o.type ?? 'OFFER';
  const dhcp: Record<string, FieldValue> = {
    op: 2,
    xid: o.xid ?? 1,
    broadcastFlag: true,
    yiaddr: o.yiaddr ?? '0.0.0.0',
    chaddr: o.chaddr,
    messageType: type,
    serverId: o.serverIp,
  };
  if (type !== 'NAK') dhcp.leaseTimeS = o.leaseS ?? 86400;
  return [
    ...ethernet(o.dstMac ?? MAC_BROADCAST, o.srcMac, ETHERTYPE_IPV4, o.vlan),
    { proto: 'ipv4', fields: { src: o.serverIp, dst: '255.255.255.255', protocol: IPPROTO_UDP, ttl: 255 } },
    { proto: 'udp', fields: { srcPort: 67, dstPort: 68 } },
    { proto: 'dhcp', fields: dhcp },
  ];
}

/** Options of `arpFrame`. */
export interface ArpFrameOptions {
  /** ARP operation (default request). */
  readonly op?: number;
  /** Sender hardware address (also the Ethernet source unless `srcMac` is given). */
  readonly sha: MacAddress;
  /** Sender protocol address. */
  readonly spa: Ipv4Address;
  /** Target hardware address (default 00:00:00:00:00:00). */
  readonly tha?: MacAddress;
  /** Target protocol address (default `spa`: a gratuitous ARP). */
  readonly tpa?: Ipv4Address;
  /** Ethernet destination (default broadcast). */
  readonly dstMac?: MacAddress;
  /** Ethernet source (default `sha`). */
  readonly srcMac?: MacAddress;
  /** An 802.1Q tag, for a trunk port. */
  readonly vlan?: number;
}

/** An ARP frame (a gratuitous request by default, as the §3.4 step 6 spoof). */
export function arpFrame(o: ArpFrameOptions): LayerSpec[] {
  return [
    ...ethernet(o.dstMac ?? MAC_BROADCAST, o.srcMac ?? o.sha, ETHERTYPE_ARP, o.vlan),
    { proto: 'arp', fields: { op: o.op ?? ARP_OP_REQUEST, sha: o.sha, spa: o.spa, tha: o.tha ?? MAC_ZERO, tpa: o.tpa ?? o.spa } },
  ];
}
