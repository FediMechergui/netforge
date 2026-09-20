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
 */
import type { DeviceId, LinkId, PortRef } from './ids.js';
import type { Impairments, LinkKind, MediaType } from './link.js';
import type { ModuleInstall } from './catalog.js';

export const TOPOLOGY_SCHEMA_ID_1_0 = 'netforge.topology/1.0';
export const TOPOLOGY_SCHEMA_ID_1_1 = 'netforge.topology/1.1';
/** Every schema id a loader accepts (older first). */
export const TOPOLOGY_SCHEMA_IDS = [TOPOLOGY_SCHEMA_ID_1_0, TOPOLOGY_SCHEMA_ID_1_1] as const;
export type TopologySchemaId = (typeof TOPOLOGY_SCHEMA_IDS)[number];
/** Target of `migrateTopology`. */
export const LATEST_TOPOLOGY_SCHEMA_ID: TopologySchemaId = TOPOLOGY_SCHEMA_ID_1_1;
/**
 * Schema id the exporter writes. P0 value was 1.0; the D11 io wave (P0.5 W1) switched it to TOPOLOGY_SCHEMA_ID_1_1
 * together with `migrateTopology` (io/migrate.ts) and io/schema.ts accepting every id in TOPOLOGY_SCHEMA_IDS.
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
