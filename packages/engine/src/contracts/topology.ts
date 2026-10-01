/**
 * Topology / project file schema (spec §13; ARCHITECTURE-P1 D11). Validated with zod in io/schema.ts
 * because uploaded files are untrusted input (spec §17).
 *
 * netforge.topology/1.1 (P0.5) adds OPTIONAL sections only: canvas scale, device modules, device
 * hardware identity (MAC salt), device ui state, link kind / dce_end / radio distance, lab reference.
 * `migrateTopology` (io/migrate.ts) is pure: 1.0 → 1.1 is identity + schema rewrite. Older files always
 * load; loading is ATOMIC (parse → migrate → validate against the catalog — unknown types, modules or
 * port names produce a readable per-device `TopologyLoadError` — BEFORE the world is replaced).
 * io limits: modules ≤ MAX_SLOTS with unique slots per device; macSalt integer 0..1 000 000; ui JSON
 * ≤ 64 KiB; metresPerUnit in (0, 10 000]; distance_m ≤ 100 000 (radio links are exempt from MAX_LENGTH_M).
 * Wi-Fi SSID/security/passphrase, DHCP pools, IPv6 addresses etc. are CONFIG LINES (configs/*.cfg), never
 * schema fields. Segments, BSSs, associations and cellular attachments are runtime-derived, never persisted.
 *
 * netforge.topology/1.2 (P2, ARCHITECTURE-P2 §2.9) adds one optional root key, `profile: 'P2'`, and nothing else.
 * `migrateTopology` walks a document up to `schemaIdFor(t)` (1.1 → 1.2 is identity + schema rewrite), so a P1
 * document stays 1.1 and exports byte-identically; a 1.0 or 1.1 document never carries `profile` (it is read with
 * its own field set, which strips the key).
 *
 * netforge.topology/1.3 (P3, ARCHITECTURE-P3 §2.9) adds `profile: 'P3'` and [S32] `devices[].files` (a host's
 * `files:` store). 1.2 → 1.3 is identity + schema rewrite; a 1.2 document keeps its `'P2'`-only profile field set (a 1.2
 * document carrying `'P3'` is refused), and a 1.0–1.2 document never carries `files` (its field set strips it).
 */
import type { DeviceId, LinkId, PortRef } from './ids.js';
import type { Impairments, LinkKind, MediaType } from './link.js';
import type { ModuleInstall } from './catalog.js';
import type { TopologyFile } from './storage.js';

export const TOPOLOGY_SCHEMA_ID_1_0 = 'netforge.topology/1.0';
export const TOPOLOGY_SCHEMA_ID_1_1 = 'netforge.topology/1.1';
/**
 * @since P2 Schema 1.2 = 1.1 plus `Topology.profile` (ARCHITECTURE-P2 §2.9, D2). The W1 io item made the one
 * pre-assigned edit of this file (§9.2 item 6): 1.2 appended to TOPOLOGY_SCHEMA_IDS, LATEST_TOPOLOGY_SCHEMA_ID = 1.2,
 * and `schemaIdFor` below, together with the identity 1.1 → 1.2 migration in io/migrate.ts. TOPOLOGY_SCHEMA_ID stays
 * 1.1 (the id every P1 document keeps).
 */
export const TOPOLOGY_SCHEMA_ID_1_2 = 'netforge.topology/1.2';
/**
 * @since P3 Schema 1.3 = 1.2 plus `Topology.profile` 'P3' and [S32] `TopologyDevice.files` (ARCHITECTURE-P3 §2.9).
 * W0 declares the constant only (ruling R7): the W1 io item appends it to TOPOLOGY_SCHEMA_IDS, sets
 * LATEST_TOPOLOGY_SCHEMA_ID and extends `schemaIdFor`, as a reviewed additive edit of this file, together with the
 * identity 1.2 → 1.3 migration.
 */
export const TOPOLOGY_SCHEMA_ID_1_3 = 'netforge.topology/1.3';
/**
 * Every schema id a loader accepts (older first). 1.3 appended @since P3 by the W1 io item (ruling R7, a reviewed
 * additive edit of this file).
 */
export const TOPOLOGY_SCHEMA_IDS = [TOPOLOGY_SCHEMA_ID_1_0, TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3] as const;
export type TopologySchemaId = (typeof TOPOLOGY_SCHEMA_IDS)[number];
/**
 * The newest id this build reads (1.2 @since P2, 1.3 @since P3). `migrateTopology` walks a document up to
 * `schemaIdFor(t)`, never further: a P1 document stays 1.1 and a P2 document 1.2, so neither gains an id it does not need.
 */
export const LATEST_TOPOLOGY_SCHEMA_ID: TopologySchemaId = TOPOLOGY_SCHEMA_ID_1_3;
/**
 * The id of a document with no 1.2 content. P0 value was 1.0; the D11 io wave (P0.5 W1) switched it to
 * TOPOLOGY_SCHEMA_ID_1_1 together with `migrateTopology` (io/migrate.ts) and io/schema.ts accepting every id in
 * TOPOLOGY_SCHEMA_IDS. It stays 1.1 in P2: every P1 document keeps exporting as 1.1, byte for byte; writers use
 * `schemaIdFor(t)`, which is this id unless the document carries `profile`.
 */
export const TOPOLOGY_SCHEMA_ID = TOPOLOGY_SCHEMA_ID_1_1;
export const NETFORGE_FORMAT_VERSION = 1;

/** Default canvas scale (D5): metres per logical canvas unit. */
export const DEFAULT_METRES_PER_UNIT = 0.25;

/** @since P0.5 Per-device GUI state that travels with a project. Never read by the engine; ≤ 64 KiB JSON. */
export interface TopologyDeviceUi {
  desktop?: {
    browserUrl?: string;
    /** Most recent first, ≤ 20 entries, each ≤ 512 chars. */
    browserHistory?: string[];
    pinnedApps?: string[];
  };
  note?: string;
}

export interface TopologyDevice {
  id: DeviceId;
  /** Catalog type, e.g. `"pc.nfpc" | "switch.nfc2960" | "router.nf2911" | "router.nf1941"`. */
  type: string;
  name: string;
  position: { logical: [number, number] };
  power?: boolean;
  /** startup-config text. Stored in `configs/<id>.cfg` in a .netforge archive; inline here for simple JSON saves. */
  config?: string;
  /**
   * running-config text of a booted device at save time (unsaved CLI changes included).
   * Stored in `configs/<id>.running.cfg` in a .netforge archive. When present, the device
   * boots into this running-config once; `config` stays its startup-config (NVRAM).
   */
  runningConfig?: string;
  /**
   * @since P0.5 (1.1) Installed modules in model slot order. ABSENT = apply the model's default modules
   * (1.0 files, hand-written JSON); PRESENT (even []) = exactly these. Export writes it iff the model has slots.
   */
  modules?: ModuleInstall[];
  /** @since P0.5 (1.1) Hardware identity; `macSalt` is written only when > 0 so MACs reproduce after reload (D8). */
  hardware?: { macSalt?: number };
  /** @since P0.5 (1.1) Opaque GUI state. */
  ui?: TopologyDeviceUi;
  /**
   * @since P3 (optional by meaning; 1.3) [S32] The host's `files:` store (D21, ARCHITECTURE-P3 §2.9): schema 1.3 only,
   * absent on every P1/P2 document. Declared in W0; the W1 io item reads and writes it.
   */
  files?: readonly TopologyFile[];
}

export interface TopologyLink {
  id: LinkId;
  a: PortRef;
  b: PortRef;
  media: MediaType;
  length_m?: number;
  impairments?: Partial<Impairments>;
  /** @since P0.5 (1.1) 'radio' = PtP radio pairing (media must be 'radio'). Default 'cable'. */
  kind?: LinkKind;
  /** @since P0.5 (1.1) Serial DCE end override. */
  dce_end?: 'a' | 'b';
  /** @since P0.5 (1.1) Radio links: distance override in metres (else canvas distance × metresPerUnit). */
  distance_m?: number;
}

export interface Topology {
  schema: TopologySchemaId;
  seed: number;
  devices: TopologyDevice[];
  links: TopologyLink[];
  objectives?: string[];
  notes?: string;
  /** @since P0.5 (1.1) Canvas scale; written only when != DEFAULT_METRES_PER_UNIT. */
  canvas?: { metresPerUnit: number };
  /**
   * @since P1 (1.1) Loaded lab reference: reopening a saved lab restores its panel by name. Round-tripped like
   * objectives/notes: loadTopology retains t.lab verbatim and exportTopology writes it back; there is no other setter.
   */
  lab?: { name: string; version: number };
  /**
   * @since P2 (optional by meaning; 1.2) The world's defaults profile when it is 'P2'; absent = 'P1' (D2). `profile`
   * belongs ONLY to the 1.2 field set: a 1.1 document carrying it is read with the 1.1 field set, which strips it, so
   * it loads as P1. EVERY writer that sets `profile` (exportTopology, useCurrentDefaults, the scenario kit's
   * `topology(…, {profile})`) sets `schema = schemaIdFor(t)` in the same step.
   * 'P3' @since P3 (optional by meaning): belongs ONLY to the 1.3 field set (the 1.2 field set keeps its 'P2' literal,
   * so a 1.2 document carrying 'P3' is refused with the schema's value message; W1 io).
   */
  profile?: 'P2' | 'P3';
}

/**
 * @since P2 The lowest schema id that can express `t`: 1.2 iff `t.profile` is present, else 1.1 (ARCHITECTURE-P2
 * §2.9). The exporter writes this, so every P1 document still exports byte-identically as 1.1. EVERY writer that sets
 * `profile` (exportTopology, useCurrentDefaults, the scenario kit's `topology(…, {profile})`) sets
 * `schema = schemaIdFor(t)` in the same step.
 * @since P3 (ARCHITECTURE-P3 §2.9, ruling R7; W1 io) 1.3 iff `t.profile` is 'P3' or a 1.3-only key is present: [S32]
 * a device whose `files` store holds at least one file (an empty `files` is no content, and the writer drops it). A P1
 * or P2 document therefore still exports byte-identically as 1.1 or 1.2. Pure; reads `t.profile` and `devices[].files`.
 */
export function schemaIdFor(t: Topology): TopologySchemaId {
  if (t.profile === 'P3' || t.devices.some((d) => d.files !== undefined && d.files.length > 0)) return TOPOLOGY_SCHEMA_ID_1_3;
  return t.profile !== undefined ? TOPOLOGY_SCHEMA_ID_1_2 : TOPOLOGY_SCHEMA_ID_1_1;
}

/** `manifest.json` inside a `.netforge` zip. */
export interface NetforgeManifest {
  format: typeof NETFORGE_FORMAT_VERSION;
  app: string; // "netforge/0.0.1"
  created: string; // ISO — set by the caller (UI), never by the engine
  modified: string;
  /** SHA-256 hex of topology.json (integrity, not security). */
  checksum?: string;
}

export interface NetforgeProject {
  manifest: NetforgeManifest;
  topology: Topology;
  /** device id → startup-config text (mirrors topology.devices[].config). */
  configs: Record<string, string>;
  readme?: string;
}
