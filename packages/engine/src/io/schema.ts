/**
 * io/schema.ts — zod schemas and validators for the topology document and the
 * `.netforge` manifest (spec §13.2 topology schema, §17 untrusted input;
 * ARCHITECTURE-P1 D11, §3.14).
 *
 * Every byte that arrives from a file is untrusted: this module is the single
 * gate through which JSON becomes a typed `Topology` / `NetforgeManifest`.
 * Validation is structural (zod) plus cross-field refinements that a schema
 * alone cannot express: unique ids, link endpoints that name existing devices,
 * one link per port, one module per slot. Failures are reported as readable,
 * path-qualified messages (`links[2].a.device: unknown device "d_zz"`), never
 * as raw zod issue objects.
 *
 * Versions: every id in `TOPOLOGY_SCHEMA_IDS` is accepted. A document is read
 * with the field set of ITS version: the 1.1 sections (canvas, lab, device
 * modules/hardware/ui, link kind/dce_end/distance_m) are stripped from a 1.0
 * document, and the 1.2 root key `profile` (ARCHITECTURE-P2 §2.9) from a 1.0 or
 * 1.1 document, exactly like any other unknown key, so `migrateTopology` can stay
 * the identity and a 1.1 document that carries `profile` loads as P1. Unknown
 * keys are stripped at every level.
 *
 * Catalog-aware validation (`validateTopologyAgainstCatalog`) and the atomic
 * load gate (`prepareTopologyLoad`) run before a simulation replaces its world;
 * they report `TopologyLoadProblem`s per device or link.
 *
 * Limits (`MAX_*`) are enforced here so a hostile file cannot make the
 * simulation allocate unbounded state before anyone looks at it.
 */
import { z } from 'zod';
import {
  HARDWARE_MESSAGES,
  KIND_CONNECTOR,
  KIND_ENCAP,
  MAX_SLOTS,
  PORT_FAMILIES,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  defaultRoleFor,
  expandCapabilities,
  moduleOrdinal,
  type Capability,
  type ModuleInstall,
  type ModuleModel,
  type SlotSpec,
} from '../contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortNameSource } from '../contracts/device.js';
import type { PortId } from '../contracts/ids.js';
import { MEDIA, type MediaType } from '../contracts/link.js';
import type { PortSpec } from '../contracts/port.js';
import { TopologyLoadError, type TopologyLoadProblem } from '../contracts/simulation.js';
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  NETFORGE_FORMAT_VERSION,
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
  type NetforgeManifest,
  type Topology,
  type TopologyDevice,
} from '../contracts/topology.js';
import { migrateTopologyTo } from './migrate.js';

// ── limits ────────────────────────────────────────────────────────────────

/** Hard cap on a `.netforge` archive (compressed bytes in, and total uncompressed bytes out). */
export const MAX_NETFORGE_BYTES = 64 * 1024 * 1024;
/** Maximum number of devices in one topology. */
export const MAX_DEVICES = 2000;
/** Maximum number of links in one topology. */
export const MAX_LINKS = 20000;
/** Maximum length of an id (device, link) or a device name, in UTF-16 code units. */
export const MAX_ID_CHARS = 64;
/** Maximum length of one device's startup-config text. */
export const MAX_CONFIG_CHARS = 1024 * 1024;
/** Maximum length of the free-form `notes` field. */
export const MAX_NOTES_CHARS = 64 * 1024;
/** Maximum number of objective tags. */
export const MAX_OBJECTIVES = 256;
/** Maximum cable length accepted by the schema (metres); the link model applies per-media limits. Radio links are exempt. */
export const MAX_LENGTH_M = 1_000_000;
/** (1.1) Maximum number of `devices[].modules` entries (one per slot). */
export const MAX_MODULES_PER_DEVICE = MAX_SLOTS;
/** (1.1) Largest accepted `devices[].hardware.macSalt`. */
export const MAX_MAC_SALT = 1_000_000;
/** (1.1) Maximum size of `devices[].ui` serialised as JSON, in UTF-16 code units. */
export const MAX_UI_JSON_CHARS = 64 * 1024;
/** (1.1) Maximum length of `ui.desktop.browserUrl` and of each `ui.desktop.browserHistory` entry. */
export const MAX_UI_URL_CHARS = 512;
/** (1.1) Maximum number of `ui.desktop.browserHistory` entries. */
export const MAX_UI_HISTORY = 20;
/** (1.1) Maximum number of `ui.desktop.pinnedApps` entries. */
export const MAX_UI_PINNED_APPS = 32;
/** (1.1) Largest accepted `canvas.metresPerUnit` (the lower bound is exclusive 0). */
export const MAX_METRES_PER_UNIT = 10_000;
/** (1.1) Largest accepted `links[].distance_m` (radio distance override). */
export const MAX_DISTANCE_M = 100_000;
/** (1.1) Maximum length of `lab.name`. */
export const MAX_LAB_NAME_CHARS = 128;
/** (1.1) Largest accepted `lab.version`. */
export const MAX_LAB_VERSION = 1_000_000;

/** Number of issues quoted in the message of the Error thrown by `parseTopology` / `parseManifest`. */
const ISSUES_IN_MESSAGE = 5;

// ── leaf schemas ──────────────────────────────────────────────────────────

/** Media names accepted in `links[].media`, derived from the `MEDIA` table so the two never drift. */
export const MEDIA_TYPES: readonly MediaType[] = Object.keys(MEDIA) as MediaType[];

const idSchema = z
  .string({ invalid_type_error: 'must be a string' })
  .min(1, 'must not be empty')
  .max(MAX_ID_CHARS, `must be at most ${MAX_ID_CHARS} characters`);

const nameSchema = z
  .string({ invalid_type_error: 'must be a string' })
  .min(1, 'must not be empty')
  .max(MAX_ID_CHARS, `must be at most ${MAX_ID_CHARS} characters`);

const finiteNumber = z.number({ invalid_type_error: 'must be a number' }).finite('must be finite');

const pctSchema = finiteNumber.min(0, 'must be between 0 and 100').max(100, 'must be between 0 and 100');

const nsSchema = z
  .number({ invalid_type_error: 'must be a number' })
  .int('must be an integer number of nanoseconds')
  .min(0, 'must be >= 0')
  .max(Number.MAX_SAFE_INTEGER, 'exceeds the largest representable time');

const boundedString = (max: number) =>
  z.string({ invalid_type_error: 'must be a string' }).max(max, `must be at most ${max} characters`);

/** `{ device, port }` endpoint of a link. */
export const portRefSchema = z.object({
  device: idSchema,
  port: z
    .string({ invalid_type_error: 'must be a string' })
    .min(1, 'must not be empty')
    .max(MAX_ID_CHARS, `must be at most ${MAX_ID_CHARS} characters`),
});

/** Partial impairment block; every field optional, ranges enforced. */
export const impairmentsSchema = z.object({
  lossPct: pctSchema.optional(),
  latencyNs: nsSchema.optional(),
  jitterNs: nsSchema.optional(),
  corruptPct: pctSchema.optional(),
  bandwidthBps: finiteNumber.positive('must be > 0').optional(),
});

/** Device position: a finite logical `[x, y]` pair. */
export const positionSchema = z.object({
  logical: z.tuple([finiteNumber, finiteNumber], {
    invalid_type_error: 'must be an [x, y] pair',
  }),
});

/** (1.1) One installed module `{ slot, module }`. */
export const moduleInstallSchema = z.object({
  slot: idSchema,
  module: idSchema,
});

/** (1.1) Hardware identity; `macSalt` is an integer 0..MAX_MAC_SALT. */
export const hardwareSchema = z.object({
  macSalt: z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be an integer')
    .min(0, `must be between 0 and ${MAX_MAC_SALT}`)
    .max(MAX_MAC_SALT, `must be between 0 and ${MAX_MAC_SALT}`)
    .optional(),
});

/** (1.1) Persisted per-device GUI state (`TopologyDeviceUi`); total JSON size capped at MAX_UI_JSON_CHARS. */
export const deviceUiSchema = z
  .object({
    desktop: z
      .object({
        browserUrl: boundedString(MAX_UI_URL_CHARS).optional(),
        browserHistory: z
          .array(boundedString(MAX_UI_URL_CHARS), { invalid_type_error: 'must be an array' })
          .max(MAX_UI_HISTORY, `at most ${MAX_UI_HISTORY} entries are allowed`)
          .optional(),
        pinnedApps: z
          .array(boundedString(MAX_ID_CHARS), { invalid_type_error: 'must be an array' })
          .max(MAX_UI_PINNED_APPS, `at most ${MAX_UI_PINNED_APPS} entries are allowed`)
          .optional(),
      })
      .optional(),
    note: boundedString(MAX_UI_JSON_CHARS).optional(),
  })
  .superRefine((ui, ctx) => {
    const size = JSON.stringify(ui).length;
    if (size > MAX_UI_JSON_CHARS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must serialise to at most ${MAX_UI_JSON_CHARS} characters (got ${size})` });
    }
  });

/** One entry of `topology.devices` (1.1 field set; 1.0 documents are stripped of the 1.1 keys before parsing). */
export const topologyDeviceSchema = z.object({
  id: idSchema,
  type: z
    .string({ invalid_type_error: 'must be a string' })
    .min(1, 'must not be empty')
    .max(MAX_ID_CHARS, `must be at most ${MAX_ID_CHARS} characters`),
  name: nameSchema,
  position: positionSchema,
  power: z.boolean({ invalid_type_error: 'must be true or false' }).optional(),
  config: z
    .string({ invalid_type_error: 'must be a string' })
    .max(MAX_CONFIG_CHARS, `must be at most ${MAX_CONFIG_CHARS} characters`)
    .optional(),
  runningConfig: z
    .string({ invalid_type_error: 'must be a string' })
    .max(MAX_CONFIG_CHARS, `must be at most ${MAX_CONFIG_CHARS} characters`)
    .optional(),
  modules: z
    .array(moduleInstallSchema, { invalid_type_error: 'must be an array' })
    .max(MAX_MODULES_PER_DEVICE, `at most ${MAX_MODULES_PER_DEVICE} modules are allowed`)
    .optional(),
  hardware: hardwareSchema.optional(),
  ui: deviceUiSchema.optional(),
});

/** One entry of `topology.links` (1.1 field set). `length_m` is range-checked in the topology refinement (radio links are exempt from MAX_LENGTH_M). */
export const topologyLinkSchema = z.object({
  id: idSchema,
  a: portRefSchema,
  b: portRefSchema,
  media: z.enum(MEDIA_TYPES as [MediaType, ...MediaType[]], {
    errorMap: () => ({ message: `must be one of ${MEDIA_TYPES.join(', ')}` }),
  }),
  length_m: finiteNumber.min(0, 'must be >= 0').optional(),
  impairments: impairmentsSchema.optional(),
  kind: z
    .enum(['cable', 'radio'], { errorMap: () => ({ message: 'must be one of cable, radio' }) })
    .optional(),
  dce_end: z.enum(['a', 'b'], { errorMap: () => ({ message: 'must be "a" or "b"' }) }).optional(),
  distance_m: finiteNumber.min(0, 'must be >= 0').max(MAX_DISTANCE_M, `must be at most ${MAX_DISTANCE_M}`).optional(),
});

/** (1.1) Canvas scale section. */
export const canvasSchema = z.object({
  metresPerUnit: finiteNumber
    .gt(0, `must be greater than 0 and at most ${MAX_METRES_PER_UNIT}`)
    .max(MAX_METRES_PER_UNIT, `must be greater than 0 and at most ${MAX_METRES_PER_UNIT}`),
});

/** (1.1) Loaded lab reference. */
export const labSchema = z.object({
  name: z
    .string({ invalid_type_error: 'must be a string' })
    .min(1, 'must not be empty')
    .max(MAX_LAB_NAME_CHARS, `must be at most ${MAX_LAB_NAME_CHARS} characters`),
  version: z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be an integer')
    .min(1, `must be between 1 and ${MAX_LAB_VERSION}`)
    .max(MAX_LAB_VERSION, `must be between 1 and ${MAX_LAB_VERSION}`),
});

/**
 * @since P2 (1.2) The world's defaults profile (ARCHITECTURE-P2 D2). Only 'P2' is ever written: an absent key means
 * 'P1', so the explicit value 'P1' (or anything else) is refused rather than silently dropped.
 */
export const profileSchema = z.literal('P2', {
  errorMap: () => ({ message: 'must be "P2"; leave it out for the classic (P1) defaults' }),
});

// ── topology ──────────────────────────────────────────────────────────────

/** Keys introduced by schema 1.1, per level. A 1.0 document never carries them. */
const V11_ROOT_KEYS = ['canvas', 'lab'] as const;
const V11_DEVICE_KEYS = ['modules', 'hardware', 'ui'] as const;
const V11_LINK_KEYS = ['kind', 'dce_end', 'distance_m'] as const;
/** @since P2 Keys introduced by schema 1.2 (root level only). A 1.0 or 1.1 document never carries them. */
const V12_ROOT_KEYS = ['profile'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function withoutKeys(v: unknown, keys: readonly string[]): unknown {
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!keys.includes(k)) out[k] = v[k];
  return out;
}

/**
 * Read a document with the field set of its own version: copies (never mutates) the input without the keys of every
 * later version — a 1.0 document loses the 1.1 and 1.2 keys, a 1.1 document the 1.2 key `profile`. Any other input
 * (1.2, unknown ids, non-objects) passes through untouched and is judged by the schema.
 */
function stripNewerSections(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if (input['schema'] === TOPOLOGY_SCHEMA_ID_1_1) return withoutKeys(input, V12_ROOT_KEYS);
  if (input['schema'] !== TOPOLOGY_SCHEMA_ID_1_0) return input;
  const out = withoutKeys(input, [...V11_ROOT_KEYS, ...V12_ROOT_KEYS]) as Record<string, unknown>;
  if (Array.isArray(input['devices'])) out['devices'] = input['devices'].map((d: unknown) => withoutKeys(d, V11_DEVICE_KEYS));
  if (Array.isArray(input['links'])) out['links'] = input['links'].map((l: unknown) => withoutKeys(l, V11_LINK_KEYS));
  return out;
}

type RefinableTopology = {
  devices: { id: string; modules?: { slot: string }[] | undefined }[];
  links: {
    id: string;
    a: { device: string; port: string };
    b: { device: string; port: string };
    media: MediaType;
    kind?: 'cable' | 'radio' | undefined;
    length_m?: number | undefined;
  }[];
};

/**
 * Cross-field checks: unique device ids, one module per slot, unique link ids, link endpoints that name an existing
 * device, no self-loop, at most one link per (raw) port name, and cable lengths within MAX_LENGTH_M.
 */
function refineTopology(t: RefinableTopology, ctx: z.RefinementCtx): void {
  const deviceIds = new Set<string>();
  for (let i = 0; i < t.devices.length; i++) {
    const d = t.devices[i]!;
    if (deviceIds.has(d.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['devices', i, 'id'], message: `duplicate device id "${d.id}"` });
    } else {
      deviceIds.add(d.id);
    }
    if (d.modules !== undefined) {
      const slots = new Set<string>();
      for (let j = 0; j < d.modules.length; j++) {
        const slot = d.modules[j]!.slot;
        if (slots.has(slot)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['devices', i, 'modules', j, 'slot'], message: `slot "${slot}" is listed more than once` });
        } else {
          slots.add(slot);
        }
      }
    }
  }

  const linkIds = new Set<string>();
  const usedPorts = new Map<string, string>(); // "device/port" → link id
  for (let i = 0; i < t.links.length; i++) {
    const link = t.links[i]!;
    if (linkIds.has(link.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['links', i, 'id'], message: `duplicate link id "${link.id}"` });
    } else {
      linkIds.add(link.id);
    }
    const radio = link.kind === 'radio' || link.media === 'radio';
    if (!radio && link.length_m !== undefined && link.length_m > MAX_LENGTH_M) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['links', i, 'length_m'], message: `must be at most ${MAX_LENGTH_M}` });
    }
    const ends: readonly ['a' | 'b', { device: string; port: string }][] = [['a', link.a], ['b', link.b]];
    for (const [side, ref] of ends) {
      if (!deviceIds.has(ref.device)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['links', i, side, 'device'],
          message: `unknown device "${ref.device}"`,
        });
        continue;
      }
      const key = `${ref.device}/${ref.port}`;
      const owner = usedPorts.get(key);
      if (owner !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['links', i, side],
          message: `port ${key} is already used by link "${owner}"`,
        });
      } else {
        usedPorts.set(key, link.id);
      }
    }
    if (link.a.device === link.b.device && link.a.port === link.b.port) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['links', i],
        message: `link "${link.id}" connects port ${link.a.device}/${link.a.port} to itself`,
      });
    }
  }
}

const SCHEMA_ID_MESSAGE = `must be one of ${TOPOLOGY_SCHEMA_IDS.map((id) => `"${id}"`).join(', ')}`;

/** The object schema behind `topologySchema` (1.2 field set, cross-field refinements applied). */
const topologyObjectSchema = z
  .object({
    schema: z.enum(TOPOLOGY_SCHEMA_IDS, {
      errorMap: () => ({ message: SCHEMA_ID_MESSAGE }),
    }),
    seed: z
      .number({ invalid_type_error: 'must be a number' })
      .int('must be an integer')
      .min(Number.MIN_SAFE_INTEGER, 'out of range')
      .max(Number.MAX_SAFE_INTEGER, 'out of range'),
    devices: z
      .array(topologyDeviceSchema, { invalid_type_error: 'must be an array' })
      .max(MAX_DEVICES, `at most ${MAX_DEVICES} devices are allowed`),
    links: z
      .array(topologyLinkSchema, { invalid_type_error: 'must be an array' })
      .max(MAX_LINKS, `at most ${MAX_LINKS} links are allowed`),
    objectives: z
      .array(z.string().max(MAX_ID_CHARS, `must be at most ${MAX_ID_CHARS} characters`))
      .max(MAX_OBJECTIVES, `at most ${MAX_OBJECTIVES} objectives are allowed`)
      .optional(),
    notes: z.string().max(MAX_NOTES_CHARS, `must be at most ${MAX_NOTES_CHARS} characters`).optional(),
    canvas: canvasSchema.optional(),
    lab: labSchema.optional(),
    profile: profileSchema.optional(),
  })
  .superRefine(refineTopology);

/**
 * Full topology document schema: `schema` (any id in TOPOLOGY_SCHEMA_IDS), `seed`, `devices`, `links`, optional
 * `objectives`/`notes`, the 1.1 sections and the 1.2 `profile`. A 1.0 document is read without its 1.1 and 1.2 keys,
 * a 1.1 document without its 1.2 key.
 */
export const topologySchema = z.preprocess(stripNewerSections, topologyObjectSchema);

/** Type produced by `topologySchema`; structurally identical to the `Topology` contract. */
export type ParsedTopology = z.output<typeof topologySchema>;

// ── manifest ──────────────────────────────────────────────────────────────

/** `manifest.json` schema. Timestamps are ISO-8601 strings set by the caller, never by the engine. */
export const manifestSchema = z.object({
  format: z.literal(NETFORGE_FORMAT_VERSION, {
    errorMap: () => ({ message: `must be ${NETFORGE_FORMAT_VERSION}` }),
  }),
  app: z.string({ invalid_type_error: 'must be a string' }).min(1, 'must not be empty').max(128, 'must be at most 128 characters'),
  created: z.string({ invalid_type_error: 'must be a string' }).datetime({ offset: true, message: 'must be an ISO-8601 timestamp' }),
  modified: z.string({ invalid_type_error: 'must be a string' }).datetime({ offset: true, message: 'must be an ISO-8601 timestamp' }),
  checksum: z
    .string({ invalid_type_error: 'must be a string' })
    .regex(/^[0-9a-f]+$/i, 'must be a hex string')
    .max(128, 'must be at most 128 characters')
    .optional(),
});

/** Type produced by `manifestSchema`; structurally identical to the `NetforgeManifest` contract. */
export type ParsedManifest = z.infer<typeof manifestSchema>;

// ── issue formatting ──────────────────────────────────────────────────────

/** `devices[1].position.logical[0]` style path; `(root)` for top-level issues. */
function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? seg : `.${seg}`;
  }
  return out;
}

/** Turn a zod issue into one readable line. Exported for callers that want to format their own zod results. */
export function formatIssue(issue: z.ZodIssue): string {
  let message = issue.message;
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === 'undefined') message = 'is required';
    else if (message === 'Required') message = `must be ${issue.expected}, got ${issue.received}`;
    else message = `${message} (got ${issue.received})`;
  } else if (issue.code === z.ZodIssueCode.invalid_literal && issue.received === undefined) {
    message = 'is required';
  } else if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    message = `unknown keys: ${issue.keys.join(', ')}`;
  }
  return `${formatPath(issue.path)}: ${message}`;
}

/** Format all issues of a zod error, one line each, in the order zod reported them. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map(formatIssue);
}

function buildErrorMessage(what: string, errors: readonly string[]): string {
  const shown = errors.slice(0, ISSUES_IN_MESSAGE);
  const more = errors.length - shown.length;
  const head = `Invalid ${what}: ${errors.length} issue${errors.length === 1 ? '' : 's'}`;
  const lines = shown.map((e) => `  - ${e}`);
  if (more > 0) lines.push(`  ... and ${more} more`);
  return [head, ...lines].join('\n');
}

// ── public API ────────────────────────────────────────────────────────────

/** Result of a non-throwing validation. */
export type ValidationResult<T> = { ok: true; topology: T } | { ok: false; errors: string[] };

/**
 * Validate an arbitrary JSON value as a `Topology` without throwing. The schema id is kept as found (no migration).
 * On failure `errors` lists every issue with its path.
 */
export function validateTopology(json: unknown): ValidationResult<Topology> {
  const result = topologySchema.safeParse(json);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const topology: Topology = result.data;
  return { ok: true, topology };
}

/**
 * Parse an arbitrary JSON value as a `Topology`. Throws an `Error` whose message
 * lists the first few issues with their paths (all issues are available through
 * `validateTopology`).
 */
export function parseTopology(json: unknown): Topology {
  const result = validateTopology(json);
  if (!result.ok) throw new Error(buildErrorMessage('topology', result.errors));
  return result.topology;
}

/** Validate an arbitrary JSON value as a `NetforgeManifest` without throwing. */
export function validateManifest(json: unknown): { ok: true; manifest: NetforgeManifest } | { ok: false; errors: string[] } {
  const result = manifestSchema.safeParse(json);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const manifest: NetforgeManifest = result.data;
  return { ok: true, manifest };
}

/** Parse an arbitrary JSON value as a `NetforgeManifest`; throws a readable `Error` on failure. */
export function parseManifest(json: unknown): NetforgeManifest {
  const result = validateManifest(json);
  if (!result.ok) throw new Error(buildErrorMessage('manifest', result.errors));
  return result.manifest;
}

// ── catalog-aware validation (atomic load, §3.14) ─────────────────────────

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Short form of a long port family (PORT_FAMILIES), or the long form itself when the family is unknown. */
function shortFamily(long: string): string {
  for (const f of PORT_FAMILIES) if (f.long === long) return f.short;
  return long;
}

/**
 * Port names a module adds in a slot (D7: `${family}${numbering}/${index}`, or `${family}${index}` for absolute
 * host-expansion templates). Name resolution needs name, short, kind and speed; the role (for the virtual-port check)
 * and the other derived members default as in the catalog's `modulePortSpecs`.
 */
function modulePortNames(modelCaps: readonly Capability[], slot: SlotSpec, module: ModuleModel): PortSpec[] {
  const caps = expandCapabilities([...modelCaps, ...(module.capabilitiesAdded ?? [])]);
  const out: PortSpec[] = [];
  let n = 0;
  for (const tpl of module.ports) {
    const first = tpl.firstIndex ?? 0;
    for (let i = 0; i < tpl.count; i++) {
      const index = first + i;
      const suffix = tpl.absolute === true ? `${index}` : `${slot.numbering}/${index}`;
      const role = tpl.spec.role ?? defaultRoleFor(tpl.spec.kind, caps);
      out.push({
        ...tpl.spec,
        name: `${tpl.family}${suffix}`,
        short: `${shortFamily(tpl.family)}${suffix}`,
        role,
        allowedRoles: tpl.spec.allowedRoles ?? [role],
        connector: tpl.spec.connector ?? KIND_CONNECTOR[tpl.spec.kind],
        encap: tpl.spec.encap ?? KIND_ENCAP[tpl.spec.kind],
        ordinal: moduleOrdinal(slot.slotIndex, n++),
        slot: slot.id,
        module: module.type,
      });
    }
  }
  return out;
}

/** Installs to apply: the file's list when present, else the model's default modules (slot order). */
function effectiveInstalls(d: TopologyDevice, model: DeviceModel): readonly ModuleInstall[] {
  if (d.modules !== undefined) return d.modules;
  const out: ModuleInstall[] = [];
  for (const s of model.slots ?? []) if (s.defaultModule !== undefined) out.push({ slot: s.id, module: s.defaultModule });
  return out;
}

/** Scratch port-name source for one device: fixed ports, then the ports of every valid module install. */
interface ScratchDevice {
  readonly d: TopologyDevice;
  readonly model: DeviceModel;
  readonly source: PortNameSource;
}

function deviceLabel(d: TopologyDevice): string {
  return `Device "${d.name}" (${d.id})`;
}

function checkModules(d: TopologyDevice, model: DeviceModel, catalog: DeviceCatalog, problems: TopologyLoadProblem[]): PortSpec[] {
  const ports: PortSpec[] = [];
  const slots = model.slots ?? [];
  for (const install of effectiveInstalls(d, model)) {
    const slot = slots.find((s) => s.id === install.slot);
    if (slot === undefined) {
      problems.push({ device: d.id, message: `${deviceLabel(d)}: ${fill(HARDWARE_MESSAGES['no-such-slot'], { model: model.model, slot: install.slot })}` });
      continue;
    }
    const module = catalog.module?.(install.module);
    if (module === undefined) {
      problems.push({ device: d.id, message: `${deviceLabel(d)}: ${fill(HARDWARE_MESSAGES['unknown-module'], { module: install.module })}` });
      continue;
    }
    if (!SLOT_ACCEPTS[slot.type].includes(module.fits)) {
      problems.push({
        device: d.id,
        message: `${deviceLabel(d)}: ${fill(HARDWARE_MESSAGES['does-not-fit'], { module: module.model, slotType: slot.type })}`,
      });
      continue;
    }
    ports.push(...modulePortNames(model.capabilities, slot, module));
  }
  return ports;
}

type EndpointResolution = { ok: true; port: PortId; spec: PortSpec | undefined } | { ok: false; message: string };

function resolveEndpoint(dev: ScratchDevice, name: string, catalog: DeviceCatalog): EndpointResolution {
  const where = `${deviceLabel(dev.d)} has no port named "${name}"`;
  const r = catalog.resolvePort(dev.source, name);
  switch (r.kind) {
    case 'existing':
      return { ok: true, port: r.port, spec: dev.source.ports.get(r.port)?.spec as PortSpec | undefined };
    case 'virtual':
      return { ok: false, message: `${deviceLabel(dev.d)}: ${r.port} is a virtual interface and cannot terminate a link` };
    case 'ambiguous':
      return { ok: false, message: `${deviceLabel(dev.d)}: port name "${name}" is ambiguous (${r.candidates.join(', ')})` };
    case 'unknown':
      return { ok: false, message: where };
  }
}

/**
 * Validate a PARSED topology against a device catalog before any world state changes (§3.14 step 3).
 *
 * Checks, per device in file order: the type exists; every module install (the file's `modules`, or the model's
 * default modules when absent) names a slot of the model, a catalog module, and a module that fits the slot (wording
 * from HARDWARE_MESSAGES). Then, per link in file order: each endpoint's port name resolves on a scratch port set
 * made of the fixed ports plus the ports of the valid module installs (`catalog.resolvePort`); virtual interfaces and virtual-role ports cannot terminate a link; and
 * no canonical port is used by two links (catching `Gi0` vs `GigabitEthernet0`) or twice by one link.
 *
 * Links touching a device whose type is unknown are skipped (the device problem already explains them). Returns the
 * problems in that order; an empty array means the topology can be loaded.
 */
export function validateTopologyAgainstCatalog(t: Topology, catalog: DeviceCatalog): TopologyLoadProblem[] {
  const problems: TopologyLoadProblem[] = [];
  const devices = new Map<string, ScratchDevice>();
  for (const d of t.devices) {
    const model = catalog.get(d.type);
    if (model === undefined) {
      problems.push({ device: d.id, message: `${deviceLabel(d)} has type "${d.type}", which this build's catalog does not contain` });
      continue;
    }
    const ports = new Map<PortId, { readonly spec: PortSpec }>();
    for (const spec of model.ports) ports.set(spec.name, { spec });
    for (const spec of checkModules(d, model, catalog, problems)) if (!ports.has(spec.name)) ports.set(spec.name, { spec });
    devices.set(d.id, { d, model, source: { model, ports } });
  }

  const used = new Map<string, string>(); // "device/canonical port" → link id
  for (const l of t.links) {
    const ends: readonly { device: string; port: string }[] = [l.a, l.b];
    const keys: string[] = [];
    for (const ref of ends) {
      const dev = devices.get(ref.device);
      if (dev === undefined) continue;
      const r = resolveEndpoint(dev, ref.port, catalog);
      if (!r.ok) {
        problems.push({ device: ref.device, link: l.id, message: `Link "${l.id}": ${r.message}` });
        continue;
      }
      if (r.spec !== undefined) {
        if (ROLE_TRAITS[r.spec.role].virtual) {
          problems.push({ device: ref.device, link: l.id, message: `Link "${l.id}": ${deviceLabel(dev.d)}: ${r.port} is a virtual interface and cannot terminate a link` });
          continue;
        }
      }
      const key = `${ref.device}/${r.port}`;
      if (keys.includes(key)) {
        problems.push({ device: ref.device, link: l.id, message: `Link "${l.id}" connects ${deviceLabel(dev.d)} port ${r.port} to itself` });
        continue;
      }
      keys.push(key);
      const owner = used.get(key);
      if (owner !== undefined) {
        problems.push({ device: ref.device, link: l.id, message: `Link "${l.id}": ${deviceLabel(dev.d)} port ${r.port} is already used by link "${owner}"` });
      } else {
        used.set(key, l.id);
      }
    }
  }
  return problems;
}

/** Map a formatted schema issue (`devices[3].id: …`) to the device or link it concerns. */
function problemFromIssue(issue: z.ZodIssue, raw: unknown): TopologyLoadProblem {
  const message = formatIssue(issue);
  const [section, index] = issue.path;
  if (typeof index === 'number' && isRecord(raw)) {
    const list = raw[section === 'devices' ? 'devices' : section === 'links' ? 'links' : ''];
    const entry = Array.isArray(list) ? list[index] : undefined;
    const id = isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined;
    if (id !== undefined && section === 'devices') return { device: id, message };
    if (id !== undefined && section === 'links') return { link: id, message };
  }
  return { message };
}

/** Build the TopologyLoadError for a non-empty problem list: a count line followed by the first few problems. */
export function topologyLoadError(problems: readonly TopologyLoadProblem[]): TopologyLoadError {
  return new TopologyLoadError(buildErrorMessage('topology', problems.map((p) => p.message)), problems);
}

/**
 * The atomic load gate (§3.14 steps 1–4): parse (any accepted schema id; each id with its own field set) →
 * `migrateTopologyTo(latest)` → `validateTopologyAgainstCatalog`. Returns the migrated topology (schema = latest, 1.2
 * @since P2; `profile` present only when a 1.2 document carried it) when it can be loaded; otherwise
 * throws a `TopologyLoadError` whose `problems` carry every schema issue (with the device or link id when known) or
 * every catalog problem. Pure: never mutates `json`, never touches a simulation.
 */
export function prepareTopologyLoad(json: unknown, catalog: DeviceCatalog): Topology {
  const parsed = topologySchema.safeParse(json);
  if (!parsed.success) throw topologyLoadError(parsed.error.issues.map((i) => problemFromIssue(i, json)));
  const topology = migrateTopologyTo(parsed.data, LATEST_TOPOLOGY_SCHEMA_ID);
  const problems = validateTopologyAgainstCatalog(topology, catalog);
  if (problems.length > 0) throw topologyLoadError(problems);
  return topology;
}
