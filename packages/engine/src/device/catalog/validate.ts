/**
 * device/catalog/validate.ts — `validateCatalog`: structural, vocabulary, derivation, legal and clone checks over
 * catalog models and modules (ARCHITECTURE-P1 D2, D3, D7, D13; §11 "Catalog validation checks owners").
 *
 * Validation never throws and never mutates. It returns issues in a deterministic order: every model in list
 * order (its own checks in a fixed order), then every module in list order. Each issue carries a stable code
 * (CATALOG_ISSUE_CODES), the subject (model type or module type), a path inside the entry and an original message.
 * `createCatalog` (device/catalog/index.ts) refuses a catalog with any issue.
 */
import type { DeviceModel } from '../../contracts/device.js';
import type { ProcessName } from '../../contracts/ids.js';
import type { PortKind, PortSpec } from '../../contracts/port.js';
import { CHANNELS, MCS_TABLES, WIDTH_FACTOR_PCT, type RadioPortSpec, type RfBand } from '../../contracts/rf.js';
import {
  BUILD_STAGES,
  CAPABILITIES,
  CAPABILITY_EXCLUDES,
  DEVICE_CATEGORIES,
  DEVICE_ICONS,
  GUI_PANELS,
  KIND_ENCAP,
  MAX_FIXED_PORT_ORDINAL,
  MAX_SLOTS,
  MODULE_PORTS_PER_SLOT,
  PORT_ROLES,
  PROCESS_ORDER,
  ROLE_KINDS,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  expandCapabilities,
  ipDefaultsFor,
  type BuildStage,
  type Capability,
  type ModuleFit,
  type ModuleModel,
  type ModuleType,
  type PoeSpec,
  type PortRole,
  type SlotType,
} from '../../contracts/catalog.js';
import { DEVICE_KINDS, deriveProcesses, deriveTables, kindOfType, modulePortSpecs, moduleReachableProcesses } from './define.js';
import { portFamilyByLong, portFamilyOf, splitPortName, virtualPortName } from './names.js';

// ── issue vocabulary ─────────────────────────────────────────────────────────

/** Every issue code `validateCatalog` can report, grouped by concern. */
export const CATALOG_ISSUE_CODES = [
  // identity, legal, shape
  'duplicate-type',
  'bad-type',
  'kind-prefix',
  'bad-model-name',
  'duplicate-model-name',
  'banned-word',
  'not-cloneable',
  'missing-field',
  'unknown-category',
  'unknown-icon',
  'bad-tags',
  'bad-hostname-prefix',
  'bad-timing',
  // capabilities and derivations
  'unknown-capability',
  'capabilities-not-expanded',
  'capability-conflict',
  'bad-processes',
  'processes-mismatch',
  'tables-mismatch',
  'ipdefaults-mismatch',
  'bad-cli',
  'bad-gui',
  // fixed ports
  'no-ports',
  'duplicate-port',
  'bad-port-name',
  'bad-port-short',
  'missing-port-field',
  'role-kind',
  'bad-allowed-roles',
  'bad-ordinal',
  'duplicate-ordinal',
  'bad-encap',
  'bad-speed',
  'bad-radio',
  'bad-mtu',
  // derived port data
  'bad-host-ports',
  'bad-port-owner',
  'bad-virtual-family',
  'bad-poe',
  // slots and modules
  'bad-slot',
  'modular-mismatch',
  'bad-default-module',
  'bad-module',
  'module-port-clash',
] as const;

/** One catalog issue code. */
export type CatalogIssueCode = (typeof CATALOG_ISSUE_CODES)[number];

/** A problem found in catalog data. */
export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  /** Model type id or module type (or `models[i]` / `modules[i]` when the entry has no usable id). */
  readonly subject: string;
  /** Location inside the entry, e.g. `ports[3].role`; '' for the entry as a whole. */
  readonly path: string;
  /** Original wording. */
  readonly message: string;
}

/** Options of `validateCatalog`. */
export interface CatalogValidationOptions {
  /** Build stage the models were defined for; enables the derived-processes comparison. */
  readonly stage?: BuildStage;
  /** Names the process registry can instantiate; when given, every model daemon must be one of them. */
  readonly processNames?: readonly ProcessName[];
}

/**
 * Vendor and third-party product words that must never appear in catalog names, descriptions, labels, tags or
 * default config (D13). Matched as whole lowercase words; hyphens and other punctuation separate words.
 */
export const BANNED_VENDOR_WORDS: readonly string[] = Object.freeze([
  'cisco', 'ios', 'ios-xe', 'nx-os', 'catalyst', 'nexus', 'meraki', 'aironet', 'linksys',
  'juniper', 'junos', 'arista', 'aruba', 'huawei', 'netgear', 'tp-link', 'tplink', 'ubiquiti', 'unifi',
  'mikrotik', 'fortinet', 'fortigate', 'palo alto', 'paloalto', 'sonicwall', 'checkpoint', 'd-link', 'dlink',
  'zyxel', 'hewlett', 'hpe', 'dell', 'lenovo', 'asus', 'belkin', 'apple', 'iphone', 'ipad', 'macbook', 'imac',
  'samsung', 'sony', 'nokia', 'ericsson', 'motorola', 'polycom', 'avaya', 'epson', 'honeywell', 'amazon',
  'alexa', 'google', 'android', 'microsoft', 'windows', 'macos', 'linux', 'ubuntu', 'wireshark', 'tcpdump',
  'packet tracer', 'gns3', 'eve-ng',
]);

/** Lowercase words separated by single spaces with a leading and trailing space. */
function wordText(text: string): string {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** True for a string with at least one non-space character. */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Banned words (as listed in BANNED_VENDOR_WORDS) that occur as whole words in `text`, in list order. */
export function findBannedWords(text: string): string[] {
  const hay = wordText(text);
  return BANNED_VENDOR_WORDS.filter((w) => hay.includes(wordText(w)));
}

/**
 * First reason `value` would not survive a JSON round trip unchanged (functions, symbols, bigints, undefined
 * values, non-finite numbers, class instances, Map/Set/RegExp/Date, sparse arrays, cycles), with its path; or
 * undefined when the value is plain JSON data.
 */
export function jsonCloneProblem(value: unknown, path = ''): { path: string; message: string } | undefined {
  return cloneWalk(value, path, []);
}

function cloneWalk(value: unknown, path: string, stack: object[]): { path: string; message: string } | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : { path, message: `The number ${String(value)} cannot be stored as JSON.` };
    case 'undefined':
      return { path, message: 'An undefined value is lost when the entry is copied as JSON.' };
    case 'function':
    case 'symbol':
    case 'bigint':
      return { path, message: `A ${typeof value} cannot be copied to the user interface.` };
    default:
      break;
  }
  const obj = value as object;
  if (stack.includes(obj)) return { path, message: 'The entry refers to itself.' };
  if (Array.isArray(obj)) {
    stack.push(obj);
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) {
        stack.pop();
        return { path: `${path}[${i}]`, message: 'The list has a gap.' };
      }
      const p = cloneWalk(obj[i], `${path}[${i}]`, stack);
      if (p) {
        stack.pop();
        return p;
      }
    }
    stack.pop();
    return undefined;
  }
  const proto = Object.getPrototypeOf(obj) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return { path, message: 'Only plain objects and lists can be copied to the user interface.' };
  }
  stack.push(obj);
  for (const key of Object.keys(obj)) {
    const p = cloneWalk((obj as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`, stack);
    if (p) {
      stack.pop();
      return p;
    }
  }
  stack.pop();
  return undefined;
}

/** One line per issue: `<subject> <path>: <message> [<code>]`. */
export function formatCatalogIssues(issues: readonly CatalogIssue[]): string {
  return issues.map((i) => `${i.subject}${i.path === '' ? '' : ` ${i.path}`}: ${i.message} [${i.code}]`).join('\n');
}

// ── shared constants ─────────────────────────────────────────────────────────

const TYPE_RE = /^[a-z]+\.[a-z0-9][a-z0-9-]*$/;
const MODULE_TYPE_RE = /^mod\.[a-z0-9][a-z0-9-]*$/;
const MODEL_NAME_RE = /^NF-[A-Z0-9][A-Z0-9-]*$/;
const HOSTNAME_PREFIX_RE = /^[A-Za-z][A-Za-z0-9-]{0,19}$/;
const PORT_NUMBER_RE = /^([0-9]+([/.][0-9]+)*)?$/;
const SLOT_NUMBERING_RE = /^([0-9]+(\/[0-9]+)*)?$/;
const RF_BANDS: readonly RfBand[] = ['2.4', '5', '6', '60', 'cell'];
const RADIO_KINDS: readonly PortKind[] = ['wlan', 'radio', 'cellular'];
const MODULE_FITS: readonly ModuleFit[] = ['ehwic', 'nim', 'sfp', 'sfp+', 'host-expansion'];
const CHASSIS_SLOT_TYPES: readonly SlotType[] = ['ehwic', 'nim', 'generic'];
const POE_STANDARDS = ['af', 'at', 'bt'];
/** Highest ordinal a MAC can carry (one octet). */
const MAX_ORDINAL = 255;
/** MTU bounds (IPv4 minimum link MTU to data-centre jumbo). */
const MIN_MTU = 68;
const MAX_MTU = 9216;
/** Largest virtual interface number. */
const MAX_VIRTUAL_NUMBER = 2147483647;

/** Model fields `defineModel` always fills. */
const DERIVED_FIELDS = [
  'category', 'family', 'variant', 'icon', 'tags', 'capabilities', 'cli', 'gui', 'slots', 'virtualFamilies',
  'hostPorts', 'portOwners', 'tables', 'ipDefaults',
] as const;

type Add = (code: CatalogIssueCode, path: string, message: string) => void;

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const isPositiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonNegativeInt = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositiveNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ── catalog ──────────────────────────────────────────────────────────────────

/**
 * Validate a whole catalog: every model (with its slots checked against `modules`), then every module, plus
 * duplicate ids and display names within each list. Returns an empty array when the catalog is sound.
 */
export function validateCatalog(models: readonly DeviceModel[], modules: readonly ModuleModel[], opts: CatalogValidationOptions = {}): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const moduleByType = new Map<ModuleType, ModuleModel>();
  for (const m of modules) if (!moduleByType.has(m.type)) moduleByType.set(m.type, m);

  const types = new Set<string>();
  const names = new Set<string>();
  models.forEach((model, i) => {
    const subject = typeof model.type === 'string' && model.type !== '' ? model.type : `models[${i}]`;
    const add: Add = (code, path, message) => out.push({ code, subject, path, message });
    if (types.has(model.type)) add('duplicate-type', 'type', `Another model already uses the type id "${model.type}".`);
    types.add(model.type);
    if (names.has(model.model)) add('duplicate-model-name', 'model', `Another model is already called "${model.model}".`);
    names.add(model.model);
    checkModel(model, modules, moduleByType, opts, add);
  });

  const moduleTypes = new Set<string>();
  const moduleNames = new Set<string>();
  modules.forEach((module, i) => {
    const subject = typeof module.type === 'string' && module.type !== '' ? module.type : `modules[${i}]`;
    const add: Add = (code, path, message) => out.push({ code, subject, path, message });
    if (moduleTypes.has(module.type)) add('duplicate-type', 'type', `Another module already uses the type id "${module.type}".`);
    moduleTypes.add(module.type);
    if (moduleNames.has(module.model)) add('duplicate-model-name', 'model', `Another module is already called "${module.model}".`);
    moduleNames.add(module.model);
    checkModule(module, add);
  });
  return out;
}

// ── models ───────────────────────────────────────────────────────────────────

function checkModel(
  model: DeviceModel,
  modules: readonly ModuleModel[],
  moduleByType: ReadonlyMap<ModuleType, ModuleModel>,
  opts: CatalogValidationOptions,
  add: Add,
): void {
  const clone = jsonCloneProblem(model);
  if (clone) add('not-cloneable', clone.path, clone.message);

  checkIdentity(model, add);
  checkLegal(model, add);

  const caps = model.capabilities;
  if (caps) checkCapabilities(caps, add);
  const effectiveCaps = caps ?? [];

  checkDaemons(model, effectiveCaps, opts, add);
  checkCliAndGui(model, add);
  checkPorts(model, add);
  checkHostPorts(model, effectiveCaps, add);
  checkOwners(model, modules, opts, add);
  checkVirtualFamilies(model, add);
  checkPoe(model, effectiveCaps, add);
  checkSlots(model, effectiveCaps, modules, moduleByType, add);
}

function checkIdentity(model: DeviceModel, add: Add): void {
  if (!TYPE_RE.test(model.type)) {
    add('bad-type', 'type', `The type id "${model.type}" must be a family and a name joined by a dot, in lowercase letters, digits and dashes.`);
  }
  const prefix = kindOfType(model.type);
  if (!DEVICE_KINDS.includes(prefix)) {
    add('kind-prefix', 'type', `"${prefix}" is not a known device family.`);
  } else if (model.kind !== prefix) {
    add('kind-prefix', 'kind', `The family "${model.kind}" must match the type id prefix "${prefix}".`);
  }
  if (!MODEL_NAME_RE.test(model.model)) {
    add('bad-model-name', 'model', `The display name "${model.model}" must start with "NF-" followed by capitals, digits and dashes.`);
  }
  if (!isText(model.description)) add('missing-field', 'description', 'The model needs a description.');
  for (const field of DERIVED_FIELDS) {
    const v = (model as unknown as Record<string, unknown>)[field];
    if (v === undefined || v === '') add('missing-field', field, `The field "${field}" is missing; define the model with defineModel.`);
  }
  if (model.category !== undefined && !DEVICE_CATEGORIES.some((c) => c.id === model.category)) {
    add('unknown-category', 'category', `"${String(model.category)}" is not a palette category.`);
  }
  if (model.icon !== undefined && !(DEVICE_ICONS as readonly string[]).includes(model.icon)) {
    add('unknown-icon', 'icon', `"${String(model.icon)}" is not a registered icon.`);
  }
  (model.tags ?? []).forEach((tag, i) => {
    if (tag === '' || tag !== tag.trim().toLowerCase()) add('bad-tags', `tags[${i}]`, `The tag "${tag}" must be lowercase text without surrounding spaces.`);
    else if ((model.tags ?? []).indexOf(tag) !== i) add('bad-tags', `tags[${i}]`, `The tag "${tag}" is listed twice.`);
  });
  if (!HOSTNAME_PREFIX_RE.test(model.hostnamePrefix)) {
    add('bad-hostname-prefix', 'hostnamePrefix', `The hostname prefix "${model.hostnamePrefix}" must start with a letter and use at most 20 letters, digits or dashes.`);
  }
  if (!isNonNegativeInt(model.bootNs)) add('bad-timing', 'bootNs', 'The boot time must be a whole number of nanoseconds, zero or more.');
  if (model.processingNs !== 0) add('bad-timing', 'processingNs', 'The processing delay is reserved and must be 0.');
}

function checkLegal(model: DeviceModel, add: Add): void {
  const texts: [string, string][] = [
    ['model', model.model],
    ['description', model.description],
    ['hostnamePrefix', model.hostnamePrefix],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (model.family !== undefined) texts.push(['family', model.family]);
  if (model.variant !== undefined) texts.push(['variant', model.variant]);
  (model.tags ?? []).forEach((t, i) => texts.push([`tags[${i}]`, t]));
  (model.slots ?? []).forEach((s, i) => {
    if (typeof s.label === 'string') texts.push([`slots[${i}].label`, s.label]);
  });
  (model.defaultConfig ?? []).forEach((l, i) => texts.push([`defaultConfig[${i}]`, l]));
  for (const [path, text] of texts) {
    const found = findBannedWords(text);
    if (found.length > 0) add('banned-word', path, `This text uses ${found.length === 1 ? 'a vendor or product name' : `${found.length} vendor or product names`}; catalog text must use original wording.`);
  }
}

function checkCapabilities(caps: readonly Capability[], add: Add): void {
  caps.forEach((c, i) => {
    if (!(CAPABILITIES as readonly string[]).includes(c)) add('unknown-capability', `capabilities[${i}]`, `"${String(c)}" is not a capability.`);
  });
  const known = caps.filter((c) => (CAPABILITIES as readonly string[]).includes(c));
  if (!sameList(caps, expandCapabilities(known))) {
    add('capabilities-not-expanded', 'capabilities', 'Capabilities must be the full implied set, without duplicates, in the standard order.');
  }
  for (const cap of CAPABILITIES) {
    if (!caps.includes(cap)) continue;
    for (const other of CAPABILITY_EXCLUDES[cap] ?? []) {
      if (caps.includes(other)) add('capability-conflict', 'capabilities', `"${cap}" cannot be combined with "${other}".`);
    }
  }
}

function checkDaemons(model: DeviceModel, caps: readonly Capability[], opts: CatalogValidationOptions, add: Add): void {
  let last = -1;
  const seen = new Set<ProcessName>();
  model.processes.forEach((p, i) => {
    const at = PROCESS_ORDER.indexOf(p);
    const path = `processes[${i}]`;
    if (at < 0) add('bad-processes', path, `"${p}" is not a known daemon.`);
    else if (seen.has(p)) add('bad-processes', path, `The daemon "${p}" is listed twice.`);
    else if (at < last) add('bad-processes', path, `The daemon "${p}" is out of the standard order.`);
    if (opts.processNames && at >= 0 && !opts.processNames.includes(p)) add('bad-processes', path, `No daemon called "${p}" is registered.`);
    seen.add(p);
    if (at > last) last = at;
  });
  if (opts.stage !== undefined && model.capabilities !== undefined) {
    const expected = deriveProcesses(caps, opts.stage);
    if (!sameList(model.processes, expected)) {
      add('processes-mismatch', 'processes', `The daemons must be those of the capabilities for stage ${opts.stage}: ${expected.join(', ') || 'none'}.`);
    }
  }
  if (model.tables !== undefined) {
    const expected = deriveTables(model.processes);
    if (!sameList(model.tables, expected)) add('tables-mismatch', 'tables', `The tables must be ${expected.join(', ')}.`);
  }
  if (model.ipDefaults !== undefined && model.capabilities !== undefined) {
    const expected = ipDefaultsFor(caps);
    const d = model.ipDefaults;
    if (d.ttl !== expected.ttl || d.hopLimit !== expected.hopLimit || d.arpTimeoutNs !== expected.arpTimeoutNs || d.camAgeingNs !== expected.camAgeingNs) {
      add('ipdefaults-mismatch', 'ipDefaults', 'The IP defaults must follow the capabilities (end systems without routing use host values).');
    }
  }
}

function checkCliAndGui(model: DeviceModel, add: Add): void {
  const cli = model.cli;
  if (cli) {
    const problems: string[] = [];
    if (!['nfos', 'host', 'none'].includes(cli.shell)) problems.push(`unknown shell "${String(cli.shell)}"`);
    if (!['nfos', 'host'].includes(cli.grammar)) problems.push(`unknown grammar "${String(cli.grammar)}"`);
    if (cli.shell !== 'none' && cli.shell !== cli.grammar) problems.push('a console shell must use its own grammar');
    if (![0, 1, 15].includes(cli.initialPrivilege)) problems.push('the starting privilege must be 0, 1 or 15');
    if (cli.grammar === 'host' && cli.initialPrivilege !== 15) problems.push('host shells start at privilege 15');
    const via: readonly string[] = Array.isArray(cli.consoleVia) ? cli.consoleVia : [];
    if (!Array.isArray(cli.consoleVia)) problems.push('the console access list is missing');
    if ((cli.shell === 'none') !== (via.length === 0)) problems.push('only a device without a shell has no console access');
    via.forEach((v, i) => {
      if (!['console', 'vty'].includes(v) || via.indexOf(v) !== i) problems.push(`console access "${String(v)}" is unknown or repeated`);
    });
    for (const p of problems) add('bad-cli', 'cli', `Command line settings are inconsistent: ${p}.`);
  }
  const gui = model.gui;
  if (gui) {
    if (gui[0] !== 'physical') add('bad-gui', 'gui', 'The physical panel must come first.');
    let last = -1;
    gui.forEach((id, i) => {
      const at = (GUI_PANELS as readonly string[]).indexOf(id);
      if (at < 0) add('bad-gui', `gui[${i}]`, `"${String(id)}" is not a settings panel.`);
      else if (at <= last) add('bad-gui', `gui[${i}]`, `The panel "${id}" is repeated or out of order.`);
      if (at > last) last = at;
    });
  }
}

function checkPorts(model: DeviceModel, add: Add): void {
  if (model.ports.length === 0) add('no-ports', 'ports', 'A model needs at least one port.');
  const nameOwner = new Map<string, number>();
  const ordinalOwner = new Map<number, number>();
  model.ports.forEach((p, i) => {
    const path = `ports[${i}]`;
    checkPortName(p, path, add);
    const keys = [p.name, p.short].filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase());
    for (const key of new Set(keys)) {
      const owner = nameOwner.get(key);
      if (owner !== undefined) add('duplicate-port', `${path}.name`, `The name "${key}" is already used by ports[${owner}].`);
      else nameOwner.set(key, i);
    }
    for (const field of ['role', 'allowedRoles', 'ordinal', 'encap', 'connector'] as const) {
      if (p[field] === undefined) add('missing-port-field', `${path}.${field}`, `The port field "${field}" is missing; define the model with defineModel.`);
    }
    checkPortRoles(p, path, add);
    if (p.ordinal !== undefined) {
      if (!Number.isSafeInteger(p.ordinal) || p.ordinal < 1 || p.ordinal > MAX_FIXED_PORT_ORDINAL) {
        add('bad-ordinal', `${path}.ordinal`, `Fixed port ordinals run from 1 to ${MAX_FIXED_PORT_ORDINAL}.`);
      } else {
        const owner = ordinalOwner.get(p.ordinal);
        if (owner !== undefined) add('duplicate-ordinal', `${path}.ordinal`, `The ordinal ${p.ordinal} is already used by ports[${owner}].`);
        else ordinalOwner.set(p.ordinal, i);
      }
    }
    if (p.encap !== undefined && !(p.encap === KIND_ENCAP[p.kind] || (p.kind === 'serial' && p.encap === 'ppp'))) {
      add('bad-encap', `${path}.encap`, `A ${p.kind} port cannot carry "${p.encap}" framing.`);
    }
    checkSpeed(p, path, add);
    if (p.mtu !== undefined && (!Number.isSafeInteger(p.mtu) || p.mtu < MIN_MTU || p.mtu > MAX_MTU)) {
      add('bad-mtu', `${path}.mtu`, `The MTU must be a whole number from ${MIN_MTU} to ${MAX_MTU}.`);
    }
    checkRadio(p, path, add);
  });
}

function checkPortName(p: PortSpec, path: string, add: Add): void {
  if (p.kind === 'virtual') {
    add('bad-port-name', `${path}.kind`, 'Virtual interfaces are declared as virtual families, not as fixed ports.');
    return;
  }
  if (typeof p.name !== 'string') {
    add('bad-port-name', `${path}.name`, 'The port needs a name.');
    return;
  }
  const parts = splitPortName(p.name);
  const fam = portFamilyOf(p.name);
  if (!parts || !fam || !PORT_NUMBER_RE.test(parts.number)) {
    add('bad-port-name', `${path}.name`, `"${p.name}" is not a family name followed by a port number.`);
    return;
  }
  if (fam.kind !== p.kind) {
    add('bad-port-name', `${path}.name`, `A ${fam.long} port must be of kind ${fam.kind}, not ${p.kind}.`);
    return;
  }
  const expected = `${fam.short}${parts.number}`;
  if (p.short !== expected) add('bad-port-short', `${path}.short`, `The short name of ${p.name} must be ${expected}.`);
}

function checkPortRoles(p: PortSpec, path: string, add: Add): void {
  const roleOk = (role: PortRole, at: string): boolean => {
    if (!(PORT_ROLES as readonly string[]).includes(role)) {
      add('role-kind', at, `"${String(role)}" is not a port role.`);
      return false;
    }
    if (!ROLE_KINDS[role].includes(p.kind)) {
      add('role-kind', at, `A ${p.kind} port cannot take the role "${role}".`);
      return false;
    }
    return true;
  };
  if (p.role !== undefined) roleOk(p.role, `${path}.role`);
  if (p.allowedRoles !== undefined) {
    p.allowedRoles.forEach((r, j) => {
      roleOk(r, `${path}.allowedRoles[${j}]`);
      if (p.allowedRoles?.indexOf(r) !== j) add('bad-allowed-roles', `${path}.allowedRoles[${j}]`, `The role "${r}" is listed twice.`);
    });
    if (p.role !== undefined && !p.allowedRoles.includes(p.role)) {
      add('bad-allowed-roles', `${path}.allowedRoles`, `The allowed roles must include the default role "${p.role}".`);
    }
  }
}

function checkSpeed(p: PortSpec, path: string, add: Add): void {
  if (!isPositiveInt(p.speedBps)) {
    add('bad-speed', `${path}.speedBps`, 'The port speed must be a positive whole number of bits per second.');
    return;
  }
  if (p.speeds === undefined) return;
  const ok = p.speeds.length > 0 && p.speeds.every((s, i) => isPositiveInt(s) && (i === 0 || s < (p.speeds?.[i - 1] ?? 0))) && p.speeds.includes(p.speedBps);
  if (!ok) add('bad-speed', `${path}.speeds`, 'Supported speeds must be listed fastest first and include the port speed.');
}

function radioProblem(kind: PortKind, r: RadioPortSpec): string | undefined {
  if (!Array.isArray(r.bands) || r.bands.length === 0 || r.bands.some((b) => !RF_BANDS.includes(b))) return 'the bands are empty or unknown';
  if (kind === 'cellular' ? r.bands.some((b) => b !== 'cell') : r.bands.includes('cell')) return 'cellular ports use the cell band and only cellular ports do';
  if (!Array.isArray(r.generations) || r.generations.length === 0 || r.generations.some((g) => !(g in MCS_TABLES))) return 'the radio generations are empty or unknown';
  if (!r.bands.includes(r.defaultBand)) return 'the default band is not one of the bands';
  if (r.defaultBand === 'cell') {
    if (!isNonNegativeInt(r.defaultChannel)) return 'the default channel must be a whole number';
  } else if (!CHANNELS[r.defaultBand].includes(r.defaultChannel)) {
    return `channel ${r.defaultChannel} does not exist in the ${r.defaultBand} band`;
  }
  if (!Number.isSafeInteger(r.maxTxPowerDbm) || !Number.isSafeInteger(r.antennaGainDbi)) return 'power and antenna gain must be whole numbers';
  if (!isPositiveInt(r.streams)) return 'spatial streams must be a positive whole number';
  if (!(r.maxWidthMhz in WIDTH_FACTOR_PCT)) return 'the channel width is unknown';
  if (!isPositiveNumber(r.maxRangeM)) return 'the range must be positive';
  if (r.maxBss !== undefined && !isPositiveInt(r.maxBss)) return 'the BSS limit must be a positive whole number';
  if (r.maxClients !== undefined && !isPositiveInt(r.maxClients)) return 'the client limit must be a positive whole number';
  return undefined;
}

function checkRadio(p: PortSpec, path: string, add: Add): void {
  const isRadio = RADIO_KINDS.includes(p.kind);
  if (isRadio && p.radio === undefined) {
    add('bad-radio', `${path}.radio`, `A ${p.kind} port needs radio capabilities.`);
    return;
  }
  if (!isRadio && p.radio !== undefined) {
    add('bad-radio', `${path}.radio`, `A ${p.kind} port cannot have radio capabilities.`);
    return;
  }
  if (p.radio !== undefined) {
    const problem = radioProblem(p.kind, p.radio);
    if (problem) add('bad-radio', `${path}.radio`, `Radio capabilities are invalid: ${problem}.`);
  }
}

/** Canonical names of the auto instances of the model's virtual families. */
function autoVirtualNames(model: DeviceModel): string[] {
  const out: string[] = [];
  for (const f of model.virtualFamilies ?? []) for (const n of f.auto ?? []) out.push(virtualPortName(f, n));
  return out;
}

function checkHostPorts(model: DeviceModel, caps: readonly Capability[], add: Add): void {
  const hostPorts = model.hostPorts;
  if (hostPorts === undefined) return;
  const valid = new Set<string>(autoVirtualNames(model));
  for (const p of model.ports) {
    if (p.role !== undefined && ROLE_TRAITS[p.role]?.l3 === true && !ROLE_TRAITS[p.role].virtual) valid.add(p.name);
  }
  hostPorts.forEach((name, i) => {
    if (!valid.has(name)) add('bad-host-ports', `hostPorts[${i}]`, `"${name}" is not an addressable port of this model.`);
    else if (hostPorts.indexOf(name) !== i) add('bad-host-ports', `hostPorts[${i}]`, `"${name}" is listed twice.`);
  });
  if (caps.includes('host') && hostPorts.length === 0) add('bad-host-ports', 'hostPorts', 'An end system needs at least one network adapter.');
}

function checkOwners(model: DeviceModel, modules: readonly ModuleModel[], opts: CatalogValidationOptions, add: Add): void {
  const owners = model.portOwners;
  if (owners === undefined) return;
  // An owner may also be a daemon that a module the model's slots accept adds (a router's switch module brings
  // eth-switch, which owns the router's Vlan1 egress).
  const stage = opts.stage ?? BUILD_STAGES[BUILD_STAGES.length - 1] ?? 'P1';
  const moduleProcesses = moduleReachableProcesses(model.capabilities ?? [], model.slots ?? [], model.processes, stage, modules);
  const present = new Set<PortRole>();
  for (const p of model.ports) {
    if (p.role !== undefined) present.add(p.role);
    for (const r of p.allowedRoles ?? []) present.add(r);
  }
  for (const f of model.virtualFamilies ?? []) present.add(f.role);
  for (const role of PORT_ROLES) {
    const owner = owners[role];
    const needsOwner = present.has(role) && ROLE_TRAITS[role].egress === 'owner';
    if (needsOwner && owner === undefined) {
      add('bad-port-owner', `portOwners.${role}`, `Ports with the role "${role}" need a daemon that sends for them.`);
    } else if (owner !== undefined) {
      if (ROLE_TRAITS[role].egress !== 'owner') add('bad-port-owner', `portOwners.${role}`, `The role "${role}" sends directly and takes no owner.`);
      else if (!model.processes.includes(owner) && !moduleProcesses.includes(owner)) add('bad-port-owner', `portOwners.${role}`, `The owner "${owner}" is not one of the model's daemons.`);
    }
  }
  for (const key of Object.keys(owners)) {
    if (!(PORT_ROLES as readonly string[]).includes(key)) add('bad-port-owner', `portOwners.${key}`, `"${key}" is not a port role.`);
  }
}

function checkVirtualFamilies(model: DeviceModel, add: Add): void {
  const families = model.virtualFamilies;
  if (families === undefined) return;
  const seen = new Set<string>();
  families.forEach((f, i) => {
    const path = `virtualFamilies[${i}]`;
    const fam = portFamilyByLong(f.family);
    const problems: string[] = [];
    if (!fam || fam.kind !== 'virtual') problems.push(`"${f.family}" is not a virtual interface family`);
    else if (f.short !== fam.short) problems.push(`the short family must be ${fam.short}`);
    if (seen.has(f.family)) problems.push('the family is declared twice');
    seen.add(f.family);
    const expectedRole = f.family === 'Vlan' ? 'svi' : f.family === 'Loopback' ? 'virtual' : undefined;
    if (f.role !== expectedRole) problems.push(`the role must be ${expectedRole ?? 'svi or virtual'}`);
    if (!isNonNegativeInt(f.min) || !isNonNegativeInt(f.max) || f.min > f.max || f.max > MAX_VIRTUAL_NUMBER) problems.push('the number range is invalid');
    const auto = f.auto ?? [];
    if (auto.some((n, j) => !Number.isSafeInteger(n) || n < f.min || n > f.max || (j > 0 && n <= (auto[j - 1] ?? 0)))) {
      problems.push('automatic instances must be ascending numbers inside the range');
    }
    if (typeof f.defaultAdminUp !== 'boolean') problems.push('the default admin state must be true or false');
    for (const p of problems) add('bad-virtual-family', path, `Virtual interface family is invalid: ${p}.`);
  });
}

function poeProblem(poe: PoeSpec, caps: readonly Capability[]): string | undefined {
  if (poe.pse !== undefined) {
    if (!caps.includes('poe-source')) return 'only power-sourcing models can supply power on a port';
    if (!POE_STANDARDS.includes(poe.pse.standard) || !isPositiveNumber(poe.pse.maxW)) return 'the supplied power is invalid';
  }
  if (poe.pd !== undefined) {
    if (!caps.includes('poe-powered')) return 'only powered models can draw power from a port';
    if (!POE_STANDARDS.includes(poe.pd.standard) || !isPositiveNumber(poe.pd.drawW)) return 'the drawn power is invalid';
  }
  return undefined;
}

function checkPoe(model: DeviceModel, caps: readonly Capability[], add: Add): void {
  if (model.poeBudgetW !== undefined) {
    if (!isPositiveNumber(model.poeBudgetW)) add('bad-poe', 'poeBudgetW', 'The power budget must be a positive number of watts.');
    if (!caps.includes('poe-source')) add('bad-poe', 'poeBudgetW', 'Only power-sourcing models have a power budget.');
  } else if (caps.includes('poe-source')) {
    add('bad-poe', 'poeBudgetW', 'A power-sourcing model needs a power budget.');
  }
  model.ports.forEach((p, i) => {
    if (p.poe === undefined) return;
    const problem = poeProblem(p.poe, caps);
    if (problem) add('bad-poe', `ports[${i}].poe`, `Power over the port is invalid: ${problem}.`);
  });
}

function checkSlots(
  model: DeviceModel,
  caps: readonly Capability[],
  modules: readonly ModuleModel[],
  moduleByType: ReadonlyMap<ModuleType, ModuleModel>,
  add: Add,
): void {
  const slots = model.slots;
  if (slots === undefined) return;
  if (slots.length > MAX_SLOTS) add('bad-slot', 'slots', `A model has at most ${MAX_SLOTS} slots.`);
  const ids = new Set<string>();
  slots.forEach((s, i) => {
    const path = `slots[${i}]`;
    const problems: string[] = [];
    if (s.id === '' || ids.has(s.id)) problems.push('the slot id is empty or repeated');
    ids.add(s.id);
    if (s.slotIndex !== i) problems.push(`the slot index must be ${i}`);
    if (!isText(s.label)) problems.push('the slot needs a label');
    if (!(s.type in SLOT_ACCEPTS)) problems.push(`"${String(s.type)}" is not a slot type`);
    if (!SLOT_NUMBERING_RE.test(s.numbering)) problems.push(`"${s.numbering}" is not a port numbering prefix`);
    const cageType = s.type === 'sfp' || s.type === 'sfp+';
    if (cageType) {
      const cage = model.ports.find((p) => p.name === s.cage);
      if (!cage) problems.push('a transceiver cage must name one of the fixed ports');
      else if (cage.kind !== 'ethernet' || cage.connector !== s.type) problems.push(`the cage port must be an ethernet port with a ${s.type} connector`);
    } else if (s.cage !== undefined) {
      problems.push('only transceiver slots have a cage port');
    }
    for (const p of problems) add('bad-slot', path, `Slot ${s.id} is invalid: ${p}.`);
    if (s.defaultModule !== undefined) {
      const m = moduleByType.get(s.defaultModule);
      if (!m) add('bad-default-module', `${path}.defaultModule`, `There is no module called ${s.defaultModule}.`);
      else if (!(SLOT_ACCEPTS[s.type] ?? []).includes(m.fits)) add('bad-default-module', `${path}.defaultModule`, `${m.model} does not fit a ${s.type} slot.`);
    }
  });

  const chassisSlots = slots.filter((s) => CHASSIS_SLOT_TYPES.includes(s.type)).length;
  if (caps.includes('modular') && chassisSlots === 0) add('modular-mismatch', 'slots', 'A modular model needs at least one module slot.');
  if (!caps.includes('modular') && chassisSlots > 0) add('modular-mismatch', 'capabilities', 'A model with module slots must have the modular capability.');

  checkModuleFit(model, modules, add);
}

function checkModuleFit(model: DeviceModel, modules: readonly ModuleModel[], add: Add): void {
  const slots = model.slots ?? [];
  const fixed = new Set<string>();
  for (const p of model.ports) {
    if (typeof p.name === 'string') fixed.add(p.name.toLowerCase());
    if (typeof p.short === 'string') fixed.add(p.short.toLowerCase());
  }
  for (const n of autoVirtualNames(model)) fixed.add(n.toLowerCase());
  const generated: { slot: string; module: string; names: Set<string> }[][] = [];
  slots.forEach((slot, i) => {
    const perSlot: { slot: string; module: string; names: Set<string> }[] = [];
    const accepts = SLOT_ACCEPTS[slot.type] ?? [];
    for (const module of modules) {
      if (!accepts.includes(module.fits) || module.ports.length === 0) continue;
      const specs = modulePortSpecs(model, slot, module);
      const names = new Set<string>();
      for (const spec of specs) {
        const lower = spec.name.toLowerCase();
        const shortLower = spec.short.toLowerCase();
        const where = `slots[${i}]`;
        if (fixed.has(lower) || fixed.has(shortLower)) add('module-port-clash', where, `${module.model} in slot ${slot.id} would add ${spec.name}, which the model already has.`);
        else if (names.has(lower)) add('module-port-clash', where, `${module.model} in slot ${slot.id} would add ${spec.name} twice.`);
        if ((spec.ordinal ?? 0) > MAX_ORDINAL) add('module-port-clash', where, `${module.model} in slot ${slot.id} would need a port ordinal above ${MAX_ORDINAL}.`);
        names.add(lower);
      }
      perSlot.push({ slot: slot.id, module: module.model, names });
    }
    generated.push(perSlot);
  });
  for (let a = 0; a < generated.length; a++) {
    for (let b = a + 1; b < generated.length; b++) {
      for (const x of generated[a] ?? []) {
        for (const y of generated[b] ?? []) {
          const shared = [...x.names].find((n) => y.names.has(n));
          if (shared !== undefined) {
            add('module-port-clash', `slots[${b}]`, `${x.module} in slot ${x.slot} and ${y.module} in slot ${y.slot} would both add the port "${shared}".`);
          }
        }
      }
    }
  }
}

// ── modules ──────────────────────────────────────────────────────────────────

function checkModule(module: ModuleModel, add: Add): void {
  const clone = jsonCloneProblem(module);
  if (clone) add('not-cloneable', clone.path, clone.message);
  if (!MODULE_TYPE_RE.test(module.type)) add('bad-type', 'type', `The module id "${module.type}" must be "mod." followed by lowercase letters, digits and dashes.`);
  if (!MODEL_NAME_RE.test(module.model)) add('bad-model-name', 'model', `The display name "${module.model}" must start with "NF-" followed by capitals, digits and dashes.`);
  if (!isText(module.description)) add('missing-field', 'description', 'The module needs a description.');
  for (const [path, text] of [['model', module.model], ['description', module.description]] as const) {
    if (typeof text !== 'string') continue;
    const found = findBannedWords(text);
    if (found.length > 0) add('banned-word', path, `This text uses ${found.length === 1 ? 'a vendor or product name' : `${found.length} vendor or product names`}; catalog text must use original wording.`);
  }
  (module.capabilitiesAdded ?? []).forEach((c, i) => {
    if (!(CAPABILITIES as readonly string[]).includes(c)) add('unknown-capability', `capabilitiesAdded[${i}]`, `"${String(c)}" is not a capability.`);
  });

  const problems: { path: string; text: string }[] = [];
  const bad = (path: string, text: string): void => {
    problems.push({ path, text });
  };
  if (!MODULE_FITS.includes(module.fits)) bad('fits', `"${String(module.fits)}" is not a slot fit`);
  const isTransceiver = module.fits === 'sfp' || module.fits === 'sfp+';
  if (isTransceiver) {
    const t = module.transceiver;
    if (!t) bad('transceiver', 'a transceiver module needs optics');
    else if (!['lc', 'sc'].includes(t.connector) || !['mm', 'sm'].includes(t.mode) || !isPositiveInt(t.speedBps) || !isPositiveNumber(t.maxLengthM) || !isPositiveInt(t.wavelengthNm)) {
      bad('transceiver', 'the optics are invalid');
    }
    if (module.ports.length > 0) bad('ports', 'a transceiver adds no ports');
  } else if (module.transceiver !== undefined) {
    bad('transceiver', 'only transceiver modules have optics');
  }
  let total = 0;
  module.ports.forEach((t, i) => {
    const path = `ports[${i}]`;
    const fam = portFamilyByLong(t.family);
    if (!fam || fam.kind === 'virtual') bad(`${path}.family`, `"${t.family}" is not a port family a module can add`);
    else if (fam.kind !== t.spec.kind) bad(`${path}.spec.kind`, `a ${fam.long} port must be of kind ${fam.kind}`);
    if (!isPositiveInt(t.count)) bad(`${path}.count`, 'the port count must be a positive whole number');
    else total += t.count;
    if (t.firstIndex !== undefined && !isNonNegativeInt(t.firstIndex)) bad(`${path}.firstIndex`, 'the first index must be a whole number, zero or more');
    if (t.absolute === true && module.fits !== 'host-expansion') bad(`${path}.absolute`, 'only expansion cards use absolute port names');
    if (t.spec.role !== undefined && (!(PORT_ROLES as readonly string[]).includes(t.spec.role) || !ROLE_KINDS[t.spec.role].includes(t.spec.kind))) {
      bad(`${path}.spec.role`, `a ${t.spec.kind} port cannot take the role "${String(t.spec.role)}"`);
    }
    if (!isPositiveInt(t.spec.speedBps)) bad(`${path}.spec.speedBps`, 'the port speed must be a positive whole number');
    const isRadio = RADIO_KINDS.includes(t.spec.kind);
    if (isRadio && t.spec.radio === undefined) bad(`${path}.spec.radio`, `a ${t.spec.kind} port needs radio capabilities`);
    else if (!isRadio && t.spec.radio !== undefined) bad(`${path}.spec.radio`, `a ${t.spec.kind} port cannot have radio capabilities`);
    else if (t.spec.radio !== undefined) {
      const problem = radioProblem(t.spec.kind, t.spec.radio);
      if (problem) bad(`${path}.spec.radio`, `the radio capabilities are invalid: ${problem}`);
    }
  });
  if (total > MODULE_PORTS_PER_SLOT) bad('ports', `a module adds at most ${MODULE_PORTS_PER_SLOT} ports`);
  if (!isTransceiver && module.ports.length === 0 && MODULE_FITS.includes(module.fits)) bad('ports', 'the module adds no ports');
  for (const p of problems) add('bad-module', p.path, `Module ${module.model} is invalid: ${p.text}.`);
}
