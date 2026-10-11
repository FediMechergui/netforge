/**
 * sim/lab-checks/service.ts — [S13] the `service` kind: a real remote login, graded in the grader's clone
 * (ARCHITECTURE-P3 §2.10, §3.14, D14, D22; §7 W5 sim; rulings R17 and R27).
 *
 * `{kind: 'service', from, to, service: 'telnet' | 'ssh', user?, password?, expect: 'success' | 'fail' | 'refused',
 * timeoutMs?, after?}`. Devices by NAME. The check runs through `CloneHost.run` (the clone memo, D5): the base clone,
 * or with `after` the clone of that fault set (resolved by name in the live world exactly as `connectivity.after`,
 * settled for the default LAB_AFTER_SETTLE_MS — the kind has no `settleMs`). Inside the clone:
 *   • the target is an IPv4 address of `to`: the first one on a subnet `from` is attached to, else its first address
 *     in port order (the `connectivity` rule); in a fault clone a target the faults left without an address is reached
 *     at the address it held just before them;
 *   • `from`'s vty-client gets `vty.connect {session: 'lab-check:<n>', target, proto: service, user, password}` —
 *     applied exactly as `icmp.ping` is (a `request` action of the sim pseudo-process). The credentials always travel
 *     in the request (absent = the empty text), so the client answers every login prompt itself and never waits for a
 *     console line: a missing credential is simply a wrong one;
 *   • the clone is stepped until the outcome is known or `timeoutMs` (default LAB_SERVICE_TIMEOUT_MS) passes. The
 *     outcome is read, as §2.10 says, from `to`'s `vty-logins` table first — the first row written after the attempt
 *     for this protocol from one of `from`'s addresses: `success`, `failed` (→ 'fail') or `refused` (an access-class) —
 *     and else from the client's own record (the vty-client StateView `results`): `refused` is a TCP reset before any
 *     login (no listener for that protocol: the transport, or no vty lines at all), which writes no row; `open` is a
 *     login; `unreachable`, `timeout` or a closed connection with no row is no outcome at all, and fails every
 *     expectation with its reason;
 *   • then the session is ended (`vty.interrupt`) and the clone runs LAB_SERVICE_CLOSE_NS more, so a later check of
 *     the same clone finds no session left open.
 * Since the client's session id is numbered per clone, the result depends only on the clone input and the checks run
 * before it in that clone (the memo's guarantee).
 *
 * A `service` assertion inside `connectivity.then` is refused (the registry): a follow-up check reads state.
 *
 * Nothing here touches the live world: it is read by name and every action happens in the clone.
 */
import { inSubnet, isIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { DeviceId } from '../../contracts/ids.js';
import type { ProcessRequest } from '../../contracts/process.js';
import type { LabAssertion } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { VtyLoginRow } from '../../contracts/tables.js';
import { MS, SEC, type SimTime } from '../../contracts/time.js';
import { SIM_PROCESS_NAME } from '../simulation.js';
import {
  LAB_PING_MAX_EVENTS,
  PASS,
  canonicalJson,
  deviceNamed,
  fail,
  noDevice,
  pingAddressOf,
  resolveFaults,
  rowsOf,
  settleNsOf,
  type Check,
  type CloneEntry,
  type CloneHost,
} from './core.js';

/** @since P3 [S13] The assertion this file grades. */
export type ServiceAssertion = Extract<LabAssertion, { kind: 'service' }>;

/** @since P3 [S13] Clone time a login may take when the assertion gives no `timeoutMs` (three SYN retries and a login). */
export const LAB_SERVICE_TIMEOUT_MS = 20_000;

/** @since P3 [S13] Clone time after the verdict in which the check's own session is closed. */
export const LAB_SERVICE_CLOSE_NS: SimTime = 2 * SEC;

/** @since P3 [S13] The process that opens the session (the `telnet` / `ssh -l` client of every shell). */
const CLIENT = 'vty-client';

/** What came of one login attempt: the three outcomes the kind grades, or none with its reason. */
type Outcome = { readonly kind: 'success' | 'fail' | 'refused'; readonly reason?: string } | { readonly kind: 'none'; readonly reason: string };

/** The client's record of one session (the vty-client StateView `results`). */
interface ClientResult {
  readonly session: string;
  readonly outcome: string;
  readonly detail?: string;
}

const LABEL = Object.freeze({ telnet: 'Telnet', ssh: 'SSH' } as const);

/** @since P3 [S13] Grade one `service` assertion (file header). */
export function checkService(sim: Simulation, host: CloneHost, a: ServiceAssertion): Check {
  const service: unknown = a.service;
  if (service !== 'telnet' && service !== 'ssh') return fail(`"${String(service)}" is not a remote login service; use telnet or ssh.`);
  const expect: unknown = a.expect;
  if (expect !== 'success' && expect !== 'fail' && expect !== 'refused') return fail(`A remote login check expects success, fail or refused, not "${String(expect)}".`);
  const from = deviceNamed(sim, a.from);
  if (from === undefined) return noDevice(a.from);
  const to = deviceNamed(sim, a.to);
  if (to === undefined) return noDevice(a.to);
  const resolved = resolveFaults(sim, a.after ?? []);
  if (!resolved.ok) return fail(resolved.detail);
  const timeoutMs = a.timeoutMs !== undefined && Number.isFinite(a.timeoutMs) && a.timeoutMs >= 1 ? Math.round(a.timeoutMs) : LAB_SERVICE_TIMEOUT_MS;
  const fromId = from.id;
  const toId = to.id;
  return host.run(resolved.faults, settleNsOf(undefined), canonicalJson(a), (entry, session) => serviceInClone(entry, session(), a, service, fromId, toId, timeoutMs));
}

/** Every IPv4 address `dev` holds, in port order. */
function ipv4Of(dev: DeviceRuntime): string[] {
  const out: string[] = [];
  for (const p of dev.ports.values()) if (p.l3.ipv4 !== undefined) out.push(p.l3.ipv4.address);
  return out;
}

/** The address a login targets (file header): one of `to`'s on a subnet `from` is attached to, else its first. */
function loginTarget(from: DeviceRuntime, to: DeviceRuntime | undefined, before: string | undefined): string | undefined {
  if (to !== undefined) {
    const nets: { address: string; prefixLen: number }[] = [];
    for (const p of from.ports.values()) if (p.l3.ipv4 !== undefined) nets.push(p.l3.ipv4);
    for (const p of to.ports.values()) {
      const v4 = p.l3.ipv4;
      if (v4 === undefined) continue;
      if (nets.some((n) => inSubnet(v4.address, n.address, n.prefixLen) && v4.address !== n.address)) return v4.address;
    }
    const first = pingAddressOf(to, 4);
    if (first !== undefined) return first;
  }
  return before;
}

/** The newest seq of `dev`'s vty-logins rows (0 when it keeps none). */
function lastLoginSeq(dev: DeviceRuntime | undefined): number {
  if (dev === undefined) return 0;
  let max = 0;
  for (const r of rowsOf<VtyLoginRow>(dev, 'vty-logins')) if (r.seq > max) max = r.seq;
  return max;
}

/** The client's record of `session`, if it kept one. */
function clientResult(dev: DeviceRuntime, session: string): ClientResult | undefined {
  const results = dev.processes.get(CLIENT)?.stateSnapshot().state['results'];
  if (!Array.isArray(results)) return undefined;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i] as ClientResult | undefined;
    if (r !== undefined && r.session === session) return r;
  }
  return undefined;
}

/** Is the client still running `session` (not yet ended)? */
function clientBusy(dev: DeviceRuntime, session: string): boolean {
  const sessions = dev.processes.get(CLIENT)?.stateSnapshot().state['sessions'];
  return Array.isArray(sessions) && sessions.some((s) => (s as { session?: unknown }).session === session);
}

/** What the attempt has shown so far: the server's row first, then the client's record; undefined = not known yet. */
function outcomeOf(
  cloneFrom: DeviceRuntime,
  cloneTo: DeviceRuntime | undefined,
  session: string,
  service: 'telnet' | 'ssh',
  sinceSeq: number,
  fromAddresses: readonly string[],
): Outcome | undefined {
  if (cloneTo !== undefined) {
    const rows = rowsOf<VtyLoginRow>(cloneTo, 'vty-logins')
      .filter((r) => r.seq > sinceSeq && r.proto === service && fromAddresses.includes(r.peer))
      .sort((x, y) => x.seq - y.seq);
    const row = rows[0];
    if (row !== undefined) {
      const reason = row.reason;
      const kind = row.result === 'failed' ? 'fail' : row.result;
      return reason === undefined ? { kind } : { kind, reason };
    }
  }
  const r = clientResult(cloneFrom, session);
  if (r === undefined) return undefined;
  switch (r.outcome) {
    case 'connecting':
      return undefined;
    case 'open':
      return { kind: 'success' };
    case 'refused':
      return { kind: 'refused' };
    case 'failed':
      return r.detail === undefined ? { kind: 'fail' } : { kind: 'fail', reason: r.detail };
    case 'unreachable':
      return { kind: 'none', reason: r.detail === undefined ? 'the address could not be reached' : `the address could not be reached (${r.detail})` };
    case 'timeout':
      return { kind: 'none', reason: 'nothing answered the connection (it timed out)' };
    default:
      return { kind: 'none', reason: 'the connection closed before any login' };
  }
}

/** The clone side of one `service` check (the closure `CloneHost.run` runs, or replays). */
function serviceInClone(
  entry: CloneEntry,
  session: string,
  a: ServiceAssertion,
  service: 'telnet' | 'ssh',
  fromId: DeviceId,
  toId: DeviceId,
  timeoutMs: number,
): Check {
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a remote login check.');
  const label = LABEL[service];
  const cloneFrom = clone.device(fromId);
  if (cloneFrom === undefined || !cloneFrom.processes.has(CLIENT)) return fail(`${a.from} has no remote terminal client, so it cannot open a ${label} session.`);
  const cloneTo = clone.device(toId);
  const target = loginTarget(cloneFrom, cloneTo, entry.before?.get(toId)?.[4]);
  if (target === undefined || !isIpv4(target)) return fail(`${a.to} has no IPv4 address to log in to.`);
  const fromAddresses = ipv4Of(cloneFrom);
  if (fromAddresses.includes(target)) return fail(`${a.from} already holds ${target} itself, so a login to it would not reach ${a.to}.`);

  const sinceSeq = lastLoginSeq(cloneTo);
  const req: ProcessRequest = { kind: 'vty.connect', session, target, proto: service, user: a.user ?? '', password: a.password ?? '' };
  cloneFrom.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: CLIENT, req }], clone.now);

  let outcome: Outcome | undefined;
  const deadline = clone.now + timeoutMs * MS;
  for (let i = 0; i < LAB_PING_MAX_EVENTS; i++) {
    outcome = outcomeOf(cloneFrom, cloneTo, session, service, sinceSeq, fromAddresses);
    if (outcome !== undefined) break;
    const next = clone.nextEventTime();
    if (next === undefined || next > deadline) break;
    if (clone.step() === undefined) break;
  }
  outcome ??= { kind: 'none', reason: `nothing came of it within ${timeoutMs} ms` };

  // end the check's own session, so a later check of this clone finds none left open
  if (clientBusy(cloneFrom, session)) {
    cloneFrom.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: CLIENT, req: { kind: 'vty.interrupt', session } }], clone.now);
  }
  clone.runFor(LAB_SERVICE_CLOSE_NS, { maxEvents: LAB_PING_MAX_EVENTS });

  if (outcome.kind === a.expect) return PASS;
  return fail(serviceDetail(a, label, target, outcome));
}

/** The failing detail: what the task expected, and what happened instead. */
function serviceDetail(a: ServiceAssertion, label: string, target: string, o: Outcome): string {
  const who = `${a.from}'s ${label} login to ${a.to} (${target})`;
  const why = o.reason === undefined ? '' : ` (${o.reason})`;
  const happened =
    o.kind === 'success'
      ? `${who} succeeded`
      : o.kind === 'fail'
        ? `${who} failed on the user name or password${why}`
        : o.kind === 'refused'
          ? o.reason === undefined
            ? `${who} was refused with a reset before any login: ${a.to} does not accept ${label} there`
            : `${who} was refused${why}`
          : `${who} came to nothing: ${o.reason}`;
  const wanted = a.expect === 'success' ? 'to succeed' : a.expect === 'fail' ? 'to fail on its credentials' : 'to be refused';
  return `${happened}; this task expects it ${wanted}.`;
}
