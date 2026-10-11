/**
 * sim/lab-checks/path.ts — [S18] the `path` kind and its [C13] `tunnelAt` member: the way a probe really goes, read
 * from the grader clone's trace (ARCHITECTURE-P3 §2.10, §3.10, §3.13 step 12; §7 W5 sim).
 *
 * `{kind: 'path', from, to, toIface?, toAddress?, family?, via?, notVia?, after?, settleMs?, tunnelAt?}`. Devices by
 * NAME. The check runs through `CloneHost.run` (the clone memo, D5): the base clone, or with `after` the clone of that
 * fault set, settled `settleMs` (default LAB_AFTER_SETTLE_MS) after its faults — exactly the clone a `connectivity`
 * check with the same `after` and `settleMs` gets.
 *
 * The probe is the connectivity check's ping: LAB_PING_COUNT echo requests of LAB_PING_SIZE_BYTES from `from` to the
 * address of `to` — its first address of the family, or with `toIface` that interface's, or `toAddress`, which `to`
 * must hold — read inside the clone (in a fault clone, as held just before the faults; the `connectivity` rules,
 * sim/lab-checks/core.ts). While the job runs a synchronous trace listener follows the probe: the echo requests icmpv4
 * (or icmpv6) creates on `from` and every copy made of them (a `parent` among them: a switch's flooded copies), with
 * each frame sent (`frameTx`: from which device to which), each frame received (`frameRx`, with its
 * `PduSummary.tunnel`), each consumption and each drop.
 *
 * The path of an echo request that reached `to` (consumed there) is rebuilt backwards from that consumption: the frame
 * that brought it to a device came from the previous device, which received the same PduId (a tunnel keeps one PduId
 * end to end, §3.10 step 4) or the PDU it was copied from. A flooded copy that went nowhere is therefore never on the
 * path. The check passes when:
 *   • at least one echo request reached `to` (otherwise it fails, naming the first drop when there was one);
 *   • `via`: those devices are on the path of every echo request that reached `to`, in the order given (other
 *     devices may lie between them);
 *   • `notVia`: none of those devices is on any such path;
 *   • `tunnelAt` [C13]: `device` received at least one frame of the probe (its echo requests and their copies), and
 *     every such frame carried `PduSummary.tunnel === tunnel` — "only ESP crosses the provider" (§3.13 step 12).
 * Every device a member names must exist in the live world, and `from` must not hold the target itself.
 *
 * A `path` assertion inside `connectivity.then` is refused (the registry): a follow-up check reads state.
 *
 * Nothing here touches the live world: it is read by name and every action happens in the clone.
 */
import { isIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { DeviceId, PduId, PortId } from '../../contracts/ids.js';
import type { DropReason } from '../../contracts/link.js';
import type { ProcessRequest } from '../../contracts/process.js';
import type { LabAssertion } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import { MS, type SimTime } from '../../contracts/time.js';
import type { PduSummary, TraceEvent } from '../../contracts/trace.js';
import { normalizeIpv6 } from '../../core/addr6.js';
import { SIM_PROCESS_NAME } from '../simulation.js';
import {
  LAB_FLOOD_DROP_REASONS,
  LAB_PING_COUNT,
  LAB_PING_MAX_EVENTS,
  LAB_PING_SETTLE_NS,
  LAB_PING_SIZE_BYTES,
  LAB_PING_TIMEOUT_MS,
  PASS,
  canonicalJson,
  deviceNamed,
  fail,
  noDevice,
  noPort,
  pingAddressOf,
  portAddressesOf,
  portNamed,
  resolveFaults,
  settleNsOf,
  type Check,
  type CloneEntry,
  type CloneHost,
} from './core.js';

/** @since P3 [S18] The assertion this file grades. */
export type PathAssertion = Extract<LabAssertion, { kind: 'path' }>;

/** @since P3 [C13] How a detail names each tunnel a frame can travel in (`PduSummary.tunnel`). */
const TUNNEL_LABEL = Object.freeze({ gre: 'a GRE tunnel', ipsec: 'an IPsec (ESP) tunnel', capwap: 'a CAPWAP tunnel' } as const);

/** Hops a rebuilt path may have (a loop in the clone stops the walk here). */
const MAX_HOPS = 64;

/** What the check resolved in the live world. */
interface PathPlan {
  readonly family: 4 | 6;
  readonly toPort?: PortId;
  readonly toAddress?: string;
  readonly via: readonly DeviceId[];
  readonly notVia: readonly DeviceId[];
  readonly tunnelAt?: { readonly device: DeviceId; readonly tunnel: 'gre' | 'ipsec' };
}

/** `text` as an address of `family` in canonical form, else undefined. */
function addressOf(family: 4 | 6, text: string): string | undefined {
  if (family === 4) return isIpv4(text) ? text : undefined;
  return normalizeIpv6(text) ?? undefined;
}

/** Resolve every device the members name (file header). */
function devicesNamed(sim: Simulation, names: readonly string[] | undefined): { ok: true; ids: DeviceId[] } | { ok: false; check: Check } {
  const ids: DeviceId[] = [];
  for (const name of names ?? []) {
    const d = deviceNamed(sim, name);
    if (d === undefined) return { ok: false, check: noDevice(name) };
    ids.push(d.id);
  }
  return { ok: true, ids };
}

/** @since P3 [S18] Grade one `path` assertion (file header). */
export function checkPath(sim: Simulation, host: CloneHost, a: PathAssertion): Check {
  const family: unknown = a.family ?? 4;
  if (family !== 4 && family !== 6) return fail(`A path check is for IPv4 or IPv6 (family 4 or 6), not ${String(family)}.`);
  const from = deviceNamed(sim, a.from);
  if (from === undefined) return noDevice(a.from);
  const to = deviceNamed(sim, a.to);
  if (to === undefined) return noDevice(a.to);
  const plan: { -readonly [K in keyof PathPlan]: PathPlan[K] } = { family, via: [], notVia: [] };
  if (a.toIface !== undefined) {
    const p = portNamed(to, a.toIface);
    if (p === undefined) return noPort(a.to, a.toIface);
    plan.toPort = p.id;
  }
  if (a.toAddress !== undefined) {
    const address = addressOf(family, a.toAddress);
    if (address === undefined) return fail(`${a.toAddress} is not an IPv${family} address.`);
    plan.toAddress = address;
  }
  const via = devicesNamed(sim, a.via);
  if (!via.ok) return via.check;
  plan.via = via.ids;
  const notVia = devicesNamed(sim, a.notVia);
  if (!notVia.ok) return notVia.check;
  plan.notVia = notVia.ids;
  if (a.tunnelAt !== undefined) {
    const tunnel: unknown = a.tunnelAt.tunnel;
    if (tunnel !== 'gre' && tunnel !== 'ipsec') return fail(`"${String(tunnel)}" is not a tunnel a path check knows; use gre or ipsec.`);
    const d = deviceNamed(sim, a.tunnelAt.device);
    if (d === undefined) return noDevice(a.tunnelAt.device);
    plan.tunnelAt = { device: d.id, tunnel };
  }
  const resolved = resolveFaults(sim, a.after ?? []);
  if (!resolved.ok) return fail(resolved.detail);
  const fromId = from.id;
  const toId = to.id;
  return host.run(resolved.faults, settleNsOf(a.settleMs), canonicalJson(a), (entry, session) => pathInClone(entry, session(), a, fromId, toId, plan));
}

/** The address the probe targets inside the clone (the `connectivity` rules, file header). */
function targetIn(entry: CloneEntry, cloneTo: DeviceRuntime | undefined, toId: DeviceId, a: PathAssertion, plan: PathPlan): { address: string } | { detail: string } {
  const family = plan.family;
  if (plan.toPort === undefined && plan.toAddress === undefined) {
    const address = (cloneTo === undefined ? undefined : pingAddressOf(cloneTo, family)) ?? entry.before?.get(toId)?.[family];
    return address === undefined ? { detail: `${a.to} has no IPv${family} address to be reached at.` } : { address };
  }
  const before = entry.beforePorts?.get(toId);
  const now = (port: PortId): readonly string[] => {
    const p = cloneTo?.port(port);
    return p === undefined ? [] : portAddressesOf(p, family);
  };
  const then = (port: PortId): readonly string[] => before?.get(port)?.[family] ?? [];
  if (plan.toPort !== undefined) {
    const port = plan.toPort;
    if (plan.toAddress === undefined) {
      const address = now(port)[0] ?? then(port)[0];
      return address === undefined ? { detail: `${a.to} ${a.toIface ?? port} has no IPv${family} address to be reached at.` } : { address };
    }
    const held = now(port).includes(plan.toAddress) || then(port).includes(plan.toAddress);
    return held ? { address: plan.toAddress } : { detail: `${a.to} ${a.toIface ?? port} does not hold ${plan.toAddress}.` };
  }
  const address = plan.toAddress as string;
  const ports = new Set<PortId>([...(cloneTo === undefined ? [] : [...cloneTo.ports.keys()]), ...(before === undefined ? [] : [...before.keys()])]);
  for (const port of ports) if (now(port).includes(address) || then(port).includes(address)) return { address };
  return { detail: `${a.to} does not hold ${address}.` };
}

/** Does `dev` hold `address` (canonical form of `family`) on any port? */
function holds(dev: DeviceRuntime, family: 4 | 6, address: string): boolean {
  for (const p of dev.ports.values()) if (portAddressesOf(p, family).includes(address)) return true;
  return false;
}

/** What the trace showed of the probe (file header); `seq` orders the events. */
interface ProbeRecord {
  readonly ids: Set<PduId>;
  readonly parent: Map<PduId, PduId>;
  readonly sent: { readonly seq: number; readonly id: PduId; readonly from: DeviceId; readonly to: DeviceId }[];
  readonly received: { readonly id: PduId; readonly device: DeviceId; readonly tunnel?: PduSummary['tunnel'] }[];
  readonly consumed: { readonly seq: number; readonly id: PduId; readonly device: DeviceId }[];
  readonly drops: { readonly device?: DeviceId; readonly reason: DropReason }[];
}

/** Follow the echo requests `process` creates on `from` (file header); `stop()` removes the listener. */
function followProbe(clone: Simulation, from: DeviceId, process: 'icmpv4' | 'icmpv6'): { readonly record: ProbeRecord; stop(): void } {
  const tag = process === 'icmpv4' ? 'ping#' : 'ping6#';
  const record: ProbeRecord = { ids: new Set(), parent: new Map(), sent: [], received: [], consumed: [], drops: [] };
  let seq = 0;
  const stop = clone.onTrace((ev: TraceEvent) => {
    seq++;
    if (ev.kind === 'pduCreated') {
      if (ev.device === from && ev.process === process && ev.pdu.tag?.startsWith(tag) === true) record.ids.add(ev.pdu.id);
      return;
    }
    if (ev.kind !== 'frameTx' && ev.kind !== 'frameRx' && ev.kind !== 'pduConsumed' && ev.kind !== 'drop' && ev.kind !== 'frameQueued' && ev.kind !== 'frameAbort') return;
    const pdu = ev.pdu;
    // a copy of a probe PDU (a switch's flooded copy, a fan-out leg) is the probe too
    if (pdu.parent !== undefined && record.ids.has(pdu.parent) && !record.ids.has(pdu.id)) {
      record.ids.add(pdu.id);
      record.parent.set(pdu.id, pdu.parent);
    }
    if (!record.ids.has(pdu.id)) return;
    switch (ev.kind) {
      case 'frameTx':
        record.sent.push({ seq, id: pdu.id, from: ev.from.device, to: ev.to.device });
        return;
      case 'frameRx':
        record.received.push(pdu.tunnel === undefined ? { id: pdu.id, device: ev.device } : { id: pdu.id, device: ev.device, tunnel: pdu.tunnel });
        return;
      case 'pduConsumed':
        record.consumed.push({ seq, id: pdu.id, device: ev.device });
        return;
      case 'drop':
        record.drops.push(ev.device === undefined ? { reason: ev.reason } : { device: ev.device, reason: ev.reason });
        return;
      default:
        return;
    }
  });
  return { record, stop };
}

/** Is the ping job `session` still running on `dev`? */
function jobRunning(dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string): boolean {
  const jobs = dev.processes.get(process)?.stateSnapshot().state['jobs'];
  return Array.isArray(jobs) && jobs.some((j) => (j as { session?: unknown }).session === session);
}

/** Run the probe's echo job to its end (or its deadline), as the connectivity check runs its ping. */
function runProbe(clone: Simulation, dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string, target: string): void {
  const timeoutNs: SimTime = LAB_PING_TIMEOUT_MS * MS;
  const req: ProcessRequest =
    process === 'icmpv4'
      ? { kind: 'icmp.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES }
      : { kind: 'icmp6.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES };
  dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: process, req }], clone.now);
  const deadline = clone.now + timeoutNs * (LAB_PING_COUNT + 2) + LAB_PING_SETTLE_NS;
  for (let i = 0; i < LAB_PING_MAX_EVENTS; i++) {
    if (!jobRunning(dev, process, session)) break;
    const next = clone.nextEventTime();
    if (next === undefined || next > deadline) break;
    if (clone.step() === undefined) break;
  }
}

/** The devices an echo request consumed on `to` went through, `from` first (file header); undefined if the walk breaks. */
function pathOf(r: ProbeRecord, consumed: ProbeRecord['consumed'][number], fromId: DeviceId): DeviceId[] | undefined {
  const chain: DeviceId[] = [consumed.device];
  let device = consumed.device;
  let id = consumed.id;
  let anchor = consumed.seq;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let tx: ProbeRecord['sent'][number] | undefined;
    for (const s of r.sent) if (s.id === id && s.to === device && s.seq < anchor && (tx === undefined || s.seq > tx.seq)) tx = s;
    if (tx === undefined) {
      // `device` made this PDU as a copy of another it received, or created it
      const parent = r.parent.get(id);
      if (parent === undefined) break;
      id = parent;
      continue;
    }
    device = tx.from;
    anchor = tx.seq;
    chain.unshift(device);
  }
  return chain[0] === fromId ? chain : undefined;
}

/** Is `want` a subsequence of `path` (in order, gaps allowed)? */
function inOrder(path: readonly DeviceId[], want: readonly DeviceId[]): boolean {
  let at = 0;
  for (const d of path) if (at < want.length && d === want[at]) at++;
  return at === want.length;
}

/** The clone side of one `path` check (the closure `CloneHost.run` runs, or replays). */
function pathInClone(entry: CloneEntry, session: string, a: PathAssertion, fromId: DeviceId, toId: DeviceId, plan: PathPlan): Check {
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a path check.');
  const family = plan.family;
  const process = family === 4 ? 'icmpv4' : 'icmpv6';
  const cloneFrom = clone.device(fromId);
  if (cloneFrom === undefined || !cloneFrom.processes.has(process)) return fail(`${a.from} cannot send an IPv${family} probe.`);
  const t = targetIn(entry, clone.device(toId), toId, a, plan);
  if ('detail' in t) return fail(t.detail);
  const target = t.address;
  if (fromId !== toId && holds(cloneFrom, family, target)) return fail(`${a.from} already holds ${target} itself, so its probe would not show the way to ${a.to}.`);

  const watch = followProbe(clone, fromId, process);
  try {
    runProbe(clone, cloneFrom, process, session, target);
  } finally {
    watch.stop();
  }
  const r = watch.record;
  const name = (id: DeviceId): string => clone.device(id)?.spec.name ?? id;
  const probe = `${a.from}'s probe to ${a.to} (${target})`;

  const delivered = r.consumed.filter((c) => c.device === toId);
  if (delivered.length === 0) {
    const drop = r.drops.find((d) => !LAB_FLOOD_DROP_REASONS.includes(d.reason)) ?? r.drops[0];
    if (drop === undefined) return fail(`${probe} never reached ${a.to}.`);
    return fail(`${probe} never reached ${a.to}: it was dropped ${drop.device === undefined ? 'on a link' : `at ${name(drop.device)}`} (${drop.reason}).`);
  }
  const paths: DeviceId[][] = [];
  for (const c of delivered) {
    const p = pathOf(r, c, fromId);
    if (p === undefined) return fail(`The way ${probe} went could not be followed in the trace.`);
    paths.push(p);
  }
  const shown = (p: readonly DeviceId[]): string => p.map(name).join(' → ');
  for (const p of paths) {
    if (!inOrder(p, plan.via)) return fail(`${probe} went ${shown(p)}, not through ${plan.via.map(name).join(', then ')}.`);
    const crossed = plan.notVia.find((d) => p.includes(d));
    if (crossed !== undefined) return fail(`${probe} went ${shown(p)}, through ${name(crossed)}, which this task rules out.`);
  }
  if (plan.tunnelAt !== undefined) {
    const at = plan.tunnelAt;
    const label = TUNNEL_LABEL[at.tunnel];
    const frames = r.received.filter((f) => f.device === at.device);
    if (frames.length === 0) return fail(`No frame of ${probe} reached ${name(at.device)}, so nothing shows it crossed there inside ${label}.`);
    const outside = frames.filter((f) => f.tunnel !== at.tunnel);
    const first = outside[0];
    if (first !== undefined) {
      const how = first.tunnel === undefined ? 'outside any tunnel' : `inside ${TUNNEL_LABEL[first.tunnel]}`;
      return fail(`${name(at.device)} received ${outside.length} of ${frames.length} frame${frames.length === 1 ? '' : 's'} of ${probe} ${how}, not inside ${label}.`);
    }
  }
  return PASS;
}
