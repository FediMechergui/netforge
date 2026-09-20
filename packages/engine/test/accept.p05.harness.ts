/**
 * test/accept.p05.harness.ts — shared helpers of the P0.5 acceptance tests (ARCHITECTURE-P1 §10.1). Not a test file.
 *
 *  • Topology builders: startup-config text with `!`-separated sections, devices at integer canvas positions, cables
 *    and whole 1.1 documents.
 *  • CLI and trace helpers: lines typed on a fresh console with every result kept (errors included), the layer stack
 *    of a PDU, and `label: N` counters read from command output.
 *  • The P0 comparison. test/goldens/accept.p05.p0-sequences.json holds the trace and snapshot of the two P0
 *    acceptance scenarios as the P0 engine produced them. D8 changed every port MAC on purpose, so both sides are
 *    normalised the same way before they are compared: each port MAC becomes the token of the port that owns it, the
 *    FCS values recomputed over those MAC bytes become 'fcs', and `RouteRow.owner` (written from P0.5 for the §9.3
 *    routeCause rule) is left out of table rows. Events are compared as `<t>|<kind>|<digest>` lines; the digest is a
 *    SHA-256 over the canonical (key-sorted) JSON of the normalised event.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CliResult } from '../src/contracts/cli.js';
import type { PduId, SessionId } from '../src/contracts/ids.js';
import type { MediaType } from '../src/contracts/link.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimSnapshot } from '../src/contracts/snapshot.js';
import { TOPOLOGY_SCHEMA_ID, type Topology, type TopologyDevice, type TopologyLink } from '../src/contracts/topology.js';

/** /24 mask. */
export const MASK24 = '255.255.255.0';
/** /30 mask (point-to-point subnets). */
export const MASK30 = '255.255.255.252';
/** /32 mask (loopbacks and host routes). */
export const MASK32 = '255.255.255.255';

// ── topology builders ───────────────────────────────────────────────────────

/** Startup-config text from sections: each section's lines followed by `!`, then `end`. */
export function configText(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** A config section: its header line followed by its child lines, each indented by one space. */
export function section(header: string, children: readonly string[]): string[] {
  return [header, ...children.map((c) => ` ${c}`)];
}

/** A powered topology device at integer canvas position (x, y), with an optional startup config. */
export function device(id: string, type: string, name: string, x: number, y: number, config?: string): TopologyDevice {
  const d: TopologyDevice = { id, type, name, position: { logical: [x, y] }, power: true };
  if (config !== undefined) d.config = config;
  return d;
}

/** A cable between two ports (media `auto` and 3 m unless given). */
export function cable(id: string, aDevice: string, aPort: string, bDevice: string, bPort: string, media: MediaType = 'auto', lengthM = 3): TopologyLink {
  return { id, a: { device: aDevice, port: aPort }, b: { device: bDevice, port: bPort }, media, length_m: lengthM };
}

/** A topology document (latest schema) of `devices` and `links`. */
export function topology(devices: TopologyDevice[], links: TopologyLink[]): Topology {
  return { schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices, links };
}

/** The device `id` of a topology document; throws when the document has none. */
export function topologyDevice(topo: Topology, id: string): TopologyDevice {
  const d = topo.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`the topology has no device ${id}`);
  return d;
}

// ── CLI and trace helpers ───────────────────────────────────────────────────

/** Type `lines` on a fresh console session of `device`, the way a student would. Every result is returned, errors included. */
export function typeLines(sim: Simulation, deviceId: string, lines: readonly string[]): { session: SessionId; results: CliResult[] } {
  const session = sim.cli.open(deviceId, 'console');
  const results = lines.map((line) => sim.cli.exec(session, line));
  return { session, results };
}

/** Protocol names of a PDU's layers as the registry holds them now, outermost first (empty when evicted). */
export function layersOf(sim: Simulation, id: PduId): string[] {
  return sim.pdu(id)?.layers.map((l) => l.proto) ?? [];
}

/** The number N of the first `label: N` in command output (e.g. `collisions: 5`), or undefined when absent. */
export function countIn(text: string, label: string): number | undefined {
  const at = text.indexOf(`${label}: `);
  if (at < 0) return undefined;
  const m = /^\d+/.exec(text.slice(at + label.length + 2));
  return m === null ? undefined : Number(m[0]);
}

// ── P0 comparison ───────────────────────────────────────────────────────────

/** One scenario of the P0 reference file. */
export interface P0Reference {
  /** Seed the P0 acceptance test used. */
  readonly seed: number;
  /** `<t>|<kind>|<digest>` of every trace event, in emission order. */
  readonly events: readonly string[];
  /** The P0 end-of-run snapshot with port MACs replaced by their owner tokens. */
  readonly snapshot: unknown;
}

/** Contents of test/goldens/accept.p05.p0-sequences.json. */
export interface P0ReferenceFile {
  /** How the file was produced. */
  readonly about: string;
  /** Scenario name → reference. */
  readonly scenarios: Readonly<Record<string, P0Reference>>;
}

/** Location of the P0 reference sequences. */
export const P0_REFERENCE_URL = new URL('./goldens/accept.p05.p0-sequences.json', import.meta.url);

/** Read the P0 reference sequences. */
export function readP0Reference(): P0ReferenceFile {
  return JSON.parse(readFileSync(P0_REFERENCE_URL, 'utf8')) as P0ReferenceFile;
}

/** Canonical colon-separated MAC text. */
const MAC_TEXT = /[0-9a-f]{2}(?::[0-9a-f]{2}){5}/g;

/** Port MAC → `mac<device/port>` for every port of a snapshot. */
export function macOwners(snapshot: Pick<SimSnapshot, 'devices'>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const d of snapshot.devices) for (const p of d.ports) owners.set(p.mac, `mac<${d.id}/${p.id}>`);
  return owners;
}

/** JSON copy of `value` with every port MAC replaced by the token of the port that owns it (other MACs are kept). */
export function replaceMacs(value: unknown, owners: ReadonlyMap<string, string>): unknown {
  return JSON.parse(JSON.stringify(value).replace(MAC_TEXT, (mac) => owners.get(mac) ?? mac)) as unknown;
}

/** `value` with the keys of every object sorted. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** JSON text of `value` with object keys sorted at every level (key order carries no meaning). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(JSON.parse(JSON.stringify(value)) as unknown));
}

/**
 * A trace event normalised for the P0 comparison: port MACs replaced, the values of `FcsRecompute` mutations masked
 * (they are CRCs over MAC bytes), and `owner` removed from `tableWrite` / `tableExpire` rows.
 */
export function normalizeP0Event(ev: unknown, owners: ReadonlyMap<string, string>): Record<string, unknown> {
  const out = replaceMacs(ev, owners) as Record<string, unknown>;
  if (out.kind === 'mutation') {
    const mutation = out.mutation as Record<string, unknown> | undefined;
    if (mutation !== undefined && mutation.reason === 'FcsRecompute') {
      mutation.before = 'fcs';
      mutation.after = 'fcs';
    }
  }
  if (out.kind === 'tableWrite' || out.kind === 'tableExpire') {
    for (const key of ['row', 'previous']) {
      const row = out[key];
      if (row !== null && typeof row === 'object') delete (row as Record<string, unknown>).owner;
    }
  }
  return out;
}

/** `<t>|<kind>|<first 16 hex digits of the SHA-256 of the canonical normalised event>`. */
export function p0EventLine(ev: unknown, owners: ReadonlyMap<string, string>): string {
  const normalized = normalizeP0Event(ev, owners);
  const digest = createHash('sha256').update(canonicalJson(normalized)).digest('hex').slice(0, 16);
  return `${String(normalized.t)}|${String(normalized.kind)}|${digest}`;
}

/** True for a non-empty list of process StateViews (`{process, state}` objects). */
function isStateViewList(list: readonly unknown[]): boolean {
  return (
    list.length > 0 &&
    list.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).process === 'string' && 'state' in v)
  );
}

/** True for a non-empty list of port snapshots (`{id, mac, …}`). */
function isPortList(list: readonly unknown[]): boolean {
  return (
    list.length > 0 &&
    list.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).id === 'string' && 'mac' in v)
  );
}

/** Lines of `expected` that are not in `actual` as an ordered subsequence. */
function missingLines(expected: string, actual: string): string[] {
  const lines = actual.split('\n');
  const missing: string[] = [];
  let i = 0;
  for (const line of expected.split('\n')) {
    const at = lines.indexOf(line, i);
    if (at < 0) missing.push(line);
    else i = at + 1;
  }
  return missing;
}

/**
 * Where `expected` is not contained in `actual`, as readable paths (empty when contained). Every key of an expected
 * object must be present with a contained value (extra actual keys are allowed: P0.5 fields); arrays need the same
 * length and contained elements, except process StateView lists, whose expected entries are matched by process name
 * (P0.5 adds daemons such as `hdlc` to P0 models, ARCHITECTURE-P1 §9.2).
 *
 * Three more kinds of P1 W5 ADDITION are contained rather than equal (§9.2 "P1 W5 (catalog)"): a port list is
 * matched by port id (the L2 switch gains the auto `Vlan1`), `runningConfig` needs the P0 lines in order (that
 * Vlan1 adds its own section), and `pendingEvents` is a lower bound (the daemons P0 models gained arm their own
 * maintenance timers). Everything a P0 device already had must still match exactly.
 */
export function containmentProblems(expected: unknown, actual: unknown, path = '$'): string[] {
  if (expected === null || typeof expected !== 'object') {
    return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${JSON.stringify(actual)}`];
    if (isStateViewList(expected)) {
      const problems: string[] = [];
      for (const view of expected) {
        const name = (view as Record<string, unknown>).process;
        const match = actual.find((a) => a !== null && typeof a === 'object' && (a as Record<string, unknown>).process === name);
        if (match === undefined) problems.push(`${path}: no state view of ${String(name)}`);
        else problems.push(...containmentProblems(view, match, `${path}[${String(name)}]`));
      }
      return problems;
    }
    if (isPortList(expected)) {
      const problems: string[] = [];
      for (const port of expected) {
        const id = (port as Record<string, unknown>).id;
        const match = actual.find((a) => a !== null && typeof a === 'object' && (a as Record<string, unknown>).id === id);
        if (match === undefined) problems.push(`${path}: no port ${String(id)}`);
        else problems.push(...containmentProblems(port, match, `${path}[${String(id)}]`));
      }
      return problems;
    }
    if (expected.length !== actual.length) return [`${path}: expected ${expected.length} entries, got ${actual.length}`];
    return expected.flatMap((v, i) => containmentProblems(v, actual[i], `${path}[${i}]`));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const got = (actual as Record<string, unknown>)[key];
    if (key === 'runningConfig' && typeof value === 'string' && typeof got === 'string') {
      for (const line of missingLines(value, got)) problems.push(`${path}.${key}: missing line ${JSON.stringify(line)}`);
      continue;
    }
    if (key === 'pendingEvents' && typeof value === 'number' && typeof got === 'number') {
      if (got < value) problems.push(`${path}.${key}: expected at least ${value}, got ${got}`);
      continue;
    }
    problems.push(...containmentProblems(value, got, `${path}.${key}`));
  }
  return problems;
}
