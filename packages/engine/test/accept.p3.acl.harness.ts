/**
 * test/accept.p3.acl.harness.ts — shared helpers of the W4 ACL acceptance rows (ARCHITECTURE-P3 §10.1
 * `accept.p3.acl-standard`, `accept.p3.acl-extended`, `accept.p3.acl-order`, `accept.p3.acl-edit`, `accept.p3.ospf-acl`;
 * D12, §3.0 (a), §3.3, §5.2, §5.8; §7 W4 qa). Not a test file.
 *
 * Worlds are built on `staged.world` at stage P3 (rule 13). The daemon registry is `PROCESS_FACTORIES`, which since
 * the W4 catalog flip holds every approved P3 daemon (the seven MUST daemons and the eight of the approved items), so
 * each world is the one the flipped catalog builds: CDP runs on routers and managed switches (P3 profile), every other
 * P3 daemon is silent without its lines (ruling R47 removed the pre-flip overlay, `ACL_ACCEPT_FACTORIES`).
 *
 * Devices are configured through `startupConfig` or the headless `configure` (the console grammar and handlers at
 * privilege 15), and read through tables, the trace and the CLI — never a daemon's private state, except where a row
 * names a StateView on purpose (the http-client tab).
 */
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { createStagedSimulation } from './staged.world.js';
import { ofKind, output } from './sim.harness.js';

// ── names ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PC_PORT = 'GigabitEthernet0';
export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const GI2 = 'GigabitEthernet0/2';
export const MASK24 = '255.255.255.0';
export const MASK30 = '255.255.255.252';

// ── worlds ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** An empty P3 world on `staged.world` (stage P3, profile P3) with every approved P3 daemon registered. */
export function aclWorld(seed: number): Simulation {
  return createStagedSimulation({ seed, stage: 'P3' });
}

/** Startup configuration of a host: hostname, the NIC address, an optional gateway, then `extra` global lines. */
export function hostConfig(name: string, address: string, gateway?: string, extra: readonly string[] = []): string {
  return configText([
    [`hostname ${name}`],
    section(`interface ${PC_PORT}`, [`ip address ${address} ${MASK24}`]),
    [...(gateway === undefined ? [] : [`ip default-gateway ${gateway}`]), ...extra],
  ]);
}

/** One routed interface section: address, `extra` interface lines, `no shutdown`. */
export function routedPort(port: string, address: string, mask: string, extra: readonly string[] = []): string[] {
  return section(`interface ${port}`, [`ip address ${address} ${mask}`, ...extra, 'no shutdown']);
}

/** Startup configuration of a router: hostname, then the given sections. */
export function routerConfig(name: string, sections: readonly (readonly string[])[]): string {
  return configText([[`hostname ${name}`], ...sections]);
}

/** Configure `device` through the headless CLI (privilege 15, global configuration); a refused line is a test bug. */
export function cfg(sim: Simulation, device: DeviceId, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  if (!r.ok) throw new Error(`${device}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** A privileged console session on `device`. */
export function privileged(sim: Simulation, device: DeviceId): SessionId {
  const s = sim.cli.open(device, 'console');
  const r = sim.cli.exec(s, 'enable');
  if (r.error !== undefined) throw new Error(`enable on ${device}: ${r.output}`);
  return s;
}

/** One exec command's output lines on a privileged session (the command must succeed). */
export function show(sim: Simulation, session: SessionId, line: string): string[] {
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`${line}: ${r.output}`);
  return r.output.split('\n');
}

/** The trace cursor now. */
export function mark(sim: Simulation): number {
  return sim.trace(0).next;
}

/** The trace events since cursor `from`. */
export function since(sim: Simulation, from: number): TraceEvent[] {
  return sim.trace(from).events;
}

/** `ping <target>` from `device`, run until idle: the session output and the events since. */
export function pingFrom(sim: Simulation, device: DeviceId, target: string): { text: string; evs: TraceEvent[] } {
  const c = mark(sim);
  const s = sim.cli.open(device, 'console');
  sim.cli.exec(s, `ping ${target}`);
  sim.runToIdle();
  const evs = since(sim, c);
  return { text: output(evs, s), evs };
}

/** The marks line of a ping's output (`!!!!!`, `U.U.U`, `.....`): the line after the `Sending …` header. */
export function pingMarks(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Sending '));
  return at < 0 ? '' : (lines[at + 1] ?? '');
}

/** The `acl` rows of `device`, sorted by key (rows are written in evaluation order, which a boot replay interleaves). */
export function aclRows(sim: Simulation, device: DeviceId): AclRow[] {
  return (sim.device(device)!.tables.get<AclRow>('acl')?.rows() ?? []).slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One `acl` row of `device` by key. */
export function aclRow(sim: Simulation, device: DeviceId, key: string): AclRow | undefined {
  return sim.device(device)!.tables.get<AclRow>('acl')?.get(key);
}

/** The `drop` events of `reason` at `device`. */
export function dropsAt(evs: readonly TraceEvent[], device: DeviceId, reason: string): Extract<TraceEvent, { kind: 'drop' }>[] {
  return ofKind(evs, 'drop').filter((d) => d.device === device && d.reason === reason);
}

/** The ICMP 3/13 errors `device` created (tag `unreachable`, type 3 code 13), with their decoded PDUs. */
export function adminProhibited(sim: Simulation, evs: readonly TraceEvent[], device: DeviceId): { t: number; pdu: PduView }[] {
  const out: { t: number; pdu: PduView }[] = [];
  for (const e of ofKind(evs, 'pduCreated')) {
    if (e.device !== device) continue;
    const pdu = sim.pdu(e.pdu.id);
    if (pdu === undefined || pdu.get('icmpv4.type') !== 3 || pdu.get('icmpv4.code') !== 13) continue;
    out.push({ t: e.t, pdu });
  }
  return out;
}

/** The ACL log lines (`facility 'ACL'`) of `device`, as [time, severity, message]. */
export function aclLogs(evs: readonly TraceEvent[], device: DeviceId): { t: number; severity: number; message: string }[] {
  return ofKind(evs, 'log')
    .filter((l) => l.device === device && l.facility === 'ACL')
    .map((l) => ({ t: l.t, severity: l.severity, message: l.message }));
}

/** The `tableWrite` events of `table` on `device`. */
export function writesOf(evs: readonly TraceEvent[], device: DeviceId, table: string): Extract<TraceEvent, { kind: 'tableWrite' }>[] {
  return ofKind(evs, 'tableWrite').filter((e) => e.device === device && e.table === table);
}

/** The http-client tab of a `hostRequest` ticket (the Desktop browser's StateView, §2.4). */
export function browserTab(sim: Simulation, device: DeviceId, token: string): Record<string, unknown> {
  const state = sim.device(device)?.processes.get('http-client')?.stateSnapshot().state;
  const tabs = state?.['tabs'] as Record<string, Record<string, unknown>> | undefined;
  return tabs?.[token] ?? {};
}
