/**
 * io/netforge-file.ts — the `.netforge` project container (spec §13.1) and the
 * plain-JSON topology save/load helpers (spec §13.2, §17 untrusted input).
 *
 * A `.netforge` file is a ZIP archive (fflate) holding
 *   manifest.json           format version, app version, timestamps, checksum
 *   topology.json           devices, links, positions — with device configs stripped
 *   configs/<id>.cfg        rendered startup-config of each device that has one (human-diffable)
 *   configs/<id>.running.cfg rendered running-config of each device booted at save time
 * (`.` in an id is written as `%2E`, so a literal `.running.cfg` suffix is unambiguous)
 *   README.md               a short description with the device list
 * Later phases add `configs-ast/`, `state/`, `activity.json`, …; this reader
 * ignores every entry it does not know, so those files round-trip untouched
 * by a P0 reader only in the sense that they are not rejected.
 *
 * Reading is defensive: the compressed input is size-capped, every entry's
 * declared uncompressed size is checked before inflation (zip-bomb guard), the
 * manifest and topology go through the zod schemas, and JSON syntax errors
 * are turned into readable messages.
 *
 * Determinism: nothing here touches the wall clock. fflate would stamp each
 * entry with `Date.now()` if no `mtime` were given, so a fixed timestamp is
 * passed; `manifest.created`/`modified` are supplied by the caller (UI).
 *
 * Integrity: `manifest.checksum` is an FNV-1a 64-bit hash of `topology.json`.
 * It detects accidental corruption / mismatched edits, NOT tampering — the
 * engine has no WebCrypto, and a cryptographic hash would not add security
 * without a signature anyway.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo, type Unzipped, type Zippable } from 'fflate';
import {
  NETFORGE_FORMAT_VERSION,
  type NetforgeProject,
  type Topology,
  type TopologyDevice,
  type TopologyDeviceUi,
  type TopologyLink,
} from '../contracts/topology.js';
import { MAX_NETFORGE_BYTES, parseManifest, parseTopology, validateManifest } from './schema.js';

// ── constants ─────────────────────────────────────────────────────────────

/** Entry names inside the archive. */
export const NETFORGE_ENTRY = Object.freeze({
  manifest: 'manifest.json',
  topology: 'topology.json',
  readme: 'README.md',
  configsDir: 'configs/',
  configExt: '.cfg',
  runningConfigExt: '.running.cfg',
});

/**
 * Fixed modification time (2000-01-01T00:00:00Z as epoch ms) stamped on every
 * zip entry so the archive bytes do not depend on when they were written.
 * (fflate converts it to a DOS timestamp with local-time getters, so the
 * bytes are stable per machine/timezone.)
 */
export const NETFORGE_ZIP_MTIME = 946_684_800_000;

/** Deflate level used when writing (0..9). 6 is the usual size/speed balance. */
const ZIP_LEVEL = 6;

// ── checksum ──────────────────────────────────────────────────────────────

const FNV64_OFFSET_HI = 0xcbf29ce4;
const FNV64_OFFSET_LO = 0x84222325;
/** Low 32 bits of the 64-bit FNV prime 0x100000001b3; the high part is exactly 1. */
const FNV64_PRIME_LO = 0x1b3;

/**
 * FNV-1a 64-bit hash of `bytes`, as 16 lowercase hex characters.
 *
 * Synchronous and dependency-free (the engine has no WebCrypto). Used for
 * `manifest.checksum`: an INTEGRITY check that catches truncated or
 * inconsistently edited archives — it is not a security measure.
 *
 * The 64-bit state is kept as two u32 halves; multiplying by the prime
 * `2^40 + 0x1b3` is `(h << 40) + h * 0x1b3`. Modulo 2^64 the shift only
 * moves `lo << 8` into the high half (`hi << 40` vanishes), so
 *   lo' = (lo * 0x1b3) mod 2^32
 *   hi' = (hi * 0x1b3 + (lo << 8) + carry(lo * 0x1b3)) mod 2^32
 * where `lo * 0x1b3 < 2^41` is exact in a double.
 */
export function checksumHex(bytes: Uint8Array): string {
  let hi = FNV64_OFFSET_HI;
  let lo = FNV64_OFFSET_LO;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]!) >>> 0;
    const product = lo * FNV64_PRIME_LO;
    const carry = Math.floor(product / 0x1_0000_0000);
    hi = (Math.imul(hi, FNV64_PRIME_LO) + (lo << 8) + carry) >>> 0;
    lo = product >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// ── canonical JSON ────────────────────────────────────────────────────────

/** Whitelisted copy of the persisted GUI state (TopologyDeviceUi), keys in contract order. */
function canonicalUi(ui: TopologyDeviceUi): TopologyDeviceUi {
  const out: TopologyDeviceUi = {};
  if (ui.desktop !== undefined) {
    const desktop: NonNullable<TopologyDeviceUi['desktop']> = {};
    if (ui.desktop.browserUrl !== undefined) desktop.browserUrl = ui.desktop.browserUrl;
    if (ui.desktop.browserHistory !== undefined) desktop.browserHistory = [...ui.desktop.browserHistory];
    if (ui.desktop.pinnedApps !== undefined) desktop.pinnedApps = [...ui.desktop.pinnedApps];
    out.desktop = desktop;
  }
  if (ui.note !== undefined) out.note = ui.note;
  return out;
}

function canonicalDevice(d: TopologyDevice, withConfig: boolean): TopologyDevice {
  const out: TopologyDevice = {
    id: d.id,
    type: d.type,
    name: d.name,
    position: { logical: [d.position.logical[0], d.position.logical[1]] },
  };
  if (d.power !== undefined) out.power = d.power;
  if (withConfig && d.config !== undefined) out.config = d.config;
  if (withConfig && d.runningConfig !== undefined) out.runningConfig = d.runningConfig;
  if (d.modules !== undefined) out.modules = d.modules.map((m) => ({ slot: m.slot, module: m.module }));
  if (d.hardware !== undefined && d.hardware.macSalt !== undefined) out.hardware = { macSalt: d.hardware.macSalt };
  if (d.ui !== undefined) out.ui = canonicalUi(d.ui);
  return out;
}

function canonicalLink(l: TopologyLink): TopologyLink {
  const out: TopologyLink = {
    id: l.id,
    a: { device: l.a.device, port: l.a.port },
    b: { device: l.b.device, port: l.b.port },
    media: l.media,
  };
  if (l.length_m !== undefined) out.length_m = l.length_m;
  if (l.impairments !== undefined) {
    const imp: NonNullable<TopologyLink['impairments']> = {};
    if (l.impairments.lossPct !== undefined) imp.lossPct = l.impairments.lossPct;
    if (l.impairments.latencyNs !== undefined) imp.latencyNs = l.impairments.latencyNs;
    if (l.impairments.jitterNs !== undefined) imp.jitterNs = l.impairments.jitterNs;
    if (l.impairments.corruptPct !== undefined) imp.corruptPct = l.impairments.corruptPct;
    if (l.impairments.bandwidthBps !== undefined) imp.bandwidthBps = l.impairments.bandwidthBps;
    out.impairments = imp;
  }
  if (l.kind !== undefined) out.kind = l.kind;
  if (l.dce_end !== undefined) out.dce_end = l.dce_end;
  if (l.distance_m !== undefined) out.distance_m = l.distance_m;
  return out;
}

/**
 * Rebuild a topology with a fixed key order and no undefined-valued keys, so two equal topologies always serialise
 * to the same bytes. Whitelists (every other key is dropped):
 *   root    schema, seed, devices, links, objectives, notes, canvas, lab
 *   device  id, type, name, position, power, config, runningConfig, modules, hardware (macSalt), ui
 *   link    id, a, b, media, length_m, impairments, kind, dce_end, distance_m
 * The 1.1 keys come after every P0 key, so a document without them serialises exactly as in P0. A `hardware` block
 * without `macSalt` is dropped. `withConfig=false` strips `devices[].config` and `devices[].runningConfig` (the
 * archive keeps configs in `configs/`). The schema id is copied as is (writers never migrate).
 */
export function canonicalTopology(t: Topology, withConfig = true): Topology {
  const out: Topology = {
    schema: t.schema,
    seed: t.seed,
    devices: t.devices.map((d) => canonicalDevice(d, withConfig)),
    links: t.links.map(canonicalLink),
  };
  if (t.objectives !== undefined) out.objectives = [...t.objectives];
  if (t.notes !== undefined) out.notes = t.notes;
  if (t.canvas !== undefined) out.canvas = { metresPerUnit: t.canvas.metresPerUnit };
  if (t.lab !== undefined) out.lab = { name: t.lab.name, version: t.lab.version };
  return out;
}

/** Pretty, canonically ordered JSON text of a topology (inline configs kept) — the plain-JSON save format. */
export function topologyToJson(t: Topology): string {
  return JSON.stringify(canonicalTopology(t, true), null, 2) + '\n';
}

/** Parse and validate plain-JSON topology text; throws a readable `Error` on bad syntax or schema. */
export function topologyFromJson(s: string): Topology {
  return parseTopology(parseJsonText(s, NETFORGE_ENTRY.topology));
}

function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${what} is not valid JSON: ${detail}`);
  }
}

// ── README ────────────────────────────────────────────────────────────────

/** Original short description of the project with a device list; written as `README.md` when the project has none. */
export function renderReadme(t: Topology): string {
  const lines: string[] = [
    '# NetForge project',
    '',
    'This archive holds a NetForge network topology: a set of simulated devices, the cables between them,',
    'and each device\'s saved startup configuration. Open it in NetForge to load the lab exactly as it was saved.',
    '',
    `Seed: ${t.seed}`,
    '',
    `## Devices (${t.devices.length})`,
    '',
  ];
  if (t.devices.length === 0) {
    lines.push('_none_');
  } else {
    for (const d of t.devices) lines.push(`- ${d.name} (${d.type}, id ${d.id})`);
  }
  lines.push('', `## Links (${t.links.length})`, '');
  if (t.links.length === 0) {
    lines.push('_none_');
  } else {
    const nameOf = new Map<string, string>();
    for (const d of t.devices) nameOf.set(d.id, d.name);
    for (const l of t.links) {
      const a = `${nameOf.get(l.a.device) ?? l.a.device} ${l.a.port}`;
      const b = `${nameOf.get(l.b.device) ?? l.b.device} ${l.b.port}`;
      lines.push(`- ${a} <-> ${b} (${l.media})`);
    }
  }
  if (t.notes !== undefined && t.notes.length > 0) lines.push('', '## Notes', '', t.notes);
  lines.push(
    '',
    'Layout: `manifest.json`, `topology.json`, `configs/<device-id>.cfg` (saved startup configuration),',
    '`configs/<device-id>.running.cfg` (configuration that was running, including unsaved changes), `README.md`.',
    '',
  );
  return lines.join('\n');
}

// ── entry naming ──────────────────────────────────────────────────────────

/** URI-encode an id for an entry name; `.` is escaped too so the `.running` marker cannot collide with an id. */
function encodeEntryId(deviceId: string): string {
  return encodeURIComponent(deviceId).replace(/\./g, '%2E');
}

/** `configs/<id>.cfg` (startup-config); the id is URI-encoded so any id (even one with `/`) maps to a flat, safe file name. */
export function configEntryName(deviceId: string): string {
  return `${NETFORGE_ENTRY.configsDir}${encodeEntryId(deviceId)}${NETFORGE_ENTRY.configExt}`;
}

/** `configs/<id>.running.cfg` (running-config at save time). */
export function runningConfigEntryName(deviceId: string): string {
  return `${NETFORGE_ENTRY.configsDir}${encodeEntryId(deviceId)}${NETFORGE_ENTRY.runningConfigExt}`;
}

/** Classify a `configs/` entry name; undefined when `name` is not a config entry. */
export function parseConfigEntry(name: string): { id: string; kind: 'startup' | 'running' } | undefined {
  if (!name.startsWith(NETFORGE_ENTRY.configsDir) || !name.endsWith(NETFORGE_ENTRY.configExt)) return undefined;
  const kind = name.endsWith(NETFORGE_ENTRY.runningConfigExt) ? 'running' : 'startup';
  const ext = kind === 'running' ? NETFORGE_ENTRY.runningConfigExt : NETFORGE_ENTRY.configExt;
  if (name.length < NETFORGE_ENTRY.configsDir.length + ext.length) return undefined;
  const encoded = name.slice(NETFORGE_ENTRY.configsDir.length, name.length - ext.length);
  if (encoded.length === 0 || encoded.includes('/')) return undefined;
  try {
    return { id: decodeURIComponent(encoded), kind };
  } catch {
    return undefined;
  }
}

/** Inverse of `configEntryName`; undefined when `name` is not a startup-config entry. */
export function deviceIdFromConfigEntry(name: string): string | undefined {
  const e = parseConfigEntry(name);
  return e?.kind === 'startup' ? e.id : undefined;
}

// ── write ─────────────────────────────────────────────────────────────────

/**
 * Serialise a project to `.netforge` bytes.
 *
 * `topology.json` is written with device configs stripped; each config goes to
 * `configs/<id>.cfg`. A device's config comes from `project.configs[id]` when
 * present, else from `devices[].config`. Config ids that name no device are
 * still written (sorted after the device-ordered ones) so nothing is lost.
 * `manifest.checksum` is recomputed from the topology bytes; `format` is forced
 * to the current version; `created`/`modified` are taken from the caller.
 */
export function writeNetforge(project: NetforgeProject): Uint8Array {
  const manifestCheck = validateManifest({ ...project.manifest, format: NETFORGE_FORMAT_VERSION, checksum: undefined });
  if (!manifestCheck.ok) {
    throw new Error(`Cannot write project: invalid manifest\n${manifestCheck.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  const topology = parseTopology(canonicalTopology(project.topology, true));

  const topologyBytes = strToU8(JSON.stringify(canonicalTopology(topology, false), null, 2) + '\n');
  const manifest = {
    format: NETFORGE_FORMAT_VERSION,
    app: project.manifest.app,
    created: project.manifest.created,
    modified: project.manifest.modified,
    checksum: checksumHex(topologyBytes),
  };

  // Configs: device order first, then any extra keys in sorted order.
  const configs = new Map<string, string>();
  for (const d of topology.devices) {
    const text = project.configs[d.id] ?? d.config;
    if (text !== undefined) configs.set(d.id, text);
  }
  const extra = Object.keys(project.configs)
    .filter((id) => !configs.has(id))
    .sort();
  for (const id of extra) configs.set(id, project.configs[id]!);

  const attrs = { mtime: NETFORGE_ZIP_MTIME, level: ZIP_LEVEL } as const;
  const entries: Zippable = {};
  entries[NETFORGE_ENTRY.manifest] = [strToU8(JSON.stringify(manifest, null, 2) + '\n'), attrs];
  entries[NETFORGE_ENTRY.topology] = [topologyBytes, attrs];
  for (const [id, text] of configs) entries[configEntryName(id)] = [strToU8(text), attrs];
  for (const d of topology.devices) {
    if (d.runningConfig !== undefined) entries[runningConfigEntryName(d.id)] = [strToU8(d.runningConfig), attrs];
  }
  entries[NETFORGE_ENTRY.readme] = [strToU8(project.readme ?? renderReadme(topology)), attrs];

  return zipSync(entries, { mtime: NETFORGE_ZIP_MTIME, level: ZIP_LEVEL });
}

// ── read ──────────────────────────────────────────────────────────────────

/** Options for `readNetforge`. */
export interface ReadNetforgeOptions {
  /**
   * Verify `manifest.checksum` against `topology.json` (default true). Only a
   * 16-hex-char FNV-1a checksum is checked; other lengths (foreign formats) are ignored.
   * Turn off to load an archive whose `topology.json` was edited by hand.
   */
  verifyChecksum?: boolean;
}

function isWantedEntry(name: string): boolean {
  return (
    name === NETFORGE_ENTRY.manifest ||
    name === NETFORGE_ENTRY.topology ||
    name === NETFORGE_ENTRY.readme ||
    parseConfigEntry(name) !== undefined
  );
}

function inflate(bytes: Uint8Array): Unzipped {
  let total = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    if (!isWantedEntry(file.name)) return false;
    if (file.originalSize > MAX_NETFORGE_BYTES) {
      throw new Error(`Archive entry ${file.name} declares ${file.originalSize} bytes; the limit is ${MAX_NETFORGE_BYTES}`);
    }
    total += file.originalSize;
    if (total > MAX_NETFORGE_BYTES) {
      throw new Error(`Archive expands to more than ${MAX_NETFORGE_BYTES} bytes`);
    }
    return true;
  };
  try {
    return unzipSync(bytes, { filter });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (detail.startsWith('Archive ')) throw e instanceof Error ? e : new Error(detail);
    throw new Error(`Not a readable project archive: ${detail}`);
  }
}

/**
 * Parse `.netforge` bytes into a project.
 *
 * Rejects inputs over `MAX_NETFORGE_BYTES` (before and after inflation),
 * unreadable zips, missing/invalid `manifest.json` or `topology.json`, and a
 * checksum mismatch (see `ReadNetforgeOptions`). Configs from `configs/*.cfg`
 * are re-attached to `topology.devices[].config` and mirrored in `configs`;
 * a config entry naming no device is ignored, as is any unknown file. A
 * missing `README.md` is fine.
 */
export function readNetforge(bytes: Uint8Array, options: ReadNetforgeOptions = {}): NetforgeProject {
  if (bytes.length > MAX_NETFORGE_BYTES) {
    throw new Error(`Archive is ${bytes.length} bytes; the limit is ${MAX_NETFORGE_BYTES}`);
  }
  const files = inflate(bytes);

  const manifestBytes = files[NETFORGE_ENTRY.manifest];
  if (manifestBytes === undefined) throw new Error(`Archive has no ${NETFORGE_ENTRY.manifest}`);
  const topologyBytes = files[NETFORGE_ENTRY.topology];
  if (topologyBytes === undefined) throw new Error(`Archive has no ${NETFORGE_ENTRY.topology}`);

  const manifest = parseManifest(parseJsonText(strFromU8(manifestBytes), NETFORGE_ENTRY.manifest));
  if ((options.verifyChecksum ?? true) && manifest.checksum !== undefined && manifest.checksum.length === 16) {
    const actual = checksumHex(topologyBytes);
    if (actual !== manifest.checksum.toLowerCase()) {
      throw new Error(
        `${NETFORGE_ENTRY.topology} does not match the manifest checksum (expected ${manifest.checksum}, found ${actual}); the archive may be corrupted or edited`,
      );
    }
  }

  const topology = parseTopology(parseJsonText(strFromU8(topologyBytes), NETFORGE_ENTRY.topology));

  // Collect config entries (only for devices that exist), then attach.
  const fromArchive = new Map<string, string>();
  const runningFromArchive = new Map<string, string>();
  for (const name of Object.keys(files)) {
    const entry = parseConfigEntry(name);
    if (entry === undefined) continue;
    (entry.kind === 'running' ? runningFromArchive : fromArchive).set(entry.id, strFromU8(files[name]!));
  }
  const configs: Record<string, string> = {};
  for (const d of topology.devices) {
    const running = runningFromArchive.get(d.id) ?? d.runningConfig;
    if (running === undefined) delete d.runningConfig;
    else d.runningConfig = running;
  }
  for (const d of topology.devices) {
    const text = fromArchive.get(d.id) ?? d.config;
    if (text === undefined) {
      delete d.config;
      continue;
    }
    d.config = text;
    configs[d.id] = text;
  }

  const project: NetforgeProject = { manifest, topology, configs };
  const readmeBytes = files[NETFORGE_ENTRY.readme];
  if (readmeBytes !== undefined) project.readme = strFromU8(readmeBytes);
  return project;
}
