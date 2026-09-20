/**
 * device/catalog/index.ts — the assembled device and module catalog (ARCHITECTURE-P1 D2, D7, §8.1 W2;
 * docs/CATALOG.md).
 *
 * The category data files author `ModelInput`s. This file defines every one of them for the build stage
 * `CATALOG_STAGE`, orders the result by DEVICE_CATEGORIES (file order inside a category), and builds the
 * `DeviceCatalog` the Simulation uses. `createCatalog` validates the lists with `validateCatalog` and refuses a
 * catalog with any issue, so a broken data edit fails at construction instead of at some later device boot.
 *
 * The data files each carry their own stage constant (they cannot import this file without an import cycle);
 * the catalog test checks that every one of them equals CATALOG_STAGE. Flipping the stage here re-derives every
 * model from its input without a data edit.
 */
import type { DeviceCatalog, DeviceModel, PortNameSource, PortResolution } from '../../contracts/device.js';
import type { PortId, ProcessName } from '../../contracts/ids.js';
import type { ProcessFactory } from '../../contracts/process.js';
import { DEVICE_CATEGORIES, type BuildStage, type DeviceCategory, type ModuleModel, type ModuleType } from '../../contracts/catalog.js';
import { defineModel, type ModelInput } from './define.js';
import { canonicalPortName, resolvePortName } from './names.js';
import { formatCatalogIssues, validateCatalog, type CatalogIssue } from './validate.js';
import { ROUTER_INPUTS } from './routers.js';
import { SWITCH_INPUTS } from './switches.js';
import { MULTILAYER_INPUTS } from './multilayer.js';
import { DATACENTRE_INPUTS } from './datacentre.js';
import { LEGACY_INPUTS } from './legacy.js';
import { SECURITY_INPUTS } from './security.js';
import { WIRELESS_INPUTS } from './wireless.js';
import { HOME_INPUTS } from './home.js';
import { RADIO_INPUTS } from './radios.js';
import { WAN_INPUTS } from './wan.js';
import { COMPUTER_MODEL_INPUTS } from './computers.js';
import { SERVER_MODEL_INPUTS } from './servers.js';
import { MOBILE_MODEL_INPUTS } from './mobile.js';
import { VOICE_MODEL_INPUTS } from './voice.js';
import { HOME_END_DEVICE_MODEL_INPUTS, PERIPHERAL_MODEL_INPUTS } from './peripherals.js';
import { IOT_MODEL_INPUTS } from './iot.js';
import { MODULE_MODELS } from './modules.js';

/** Build stage the catalog derives daemons and GUI panels for (D1). Flipped to 'P1' in P1 W5 (§8.2). */
export const CATALOG_STAGE: BuildStage = 'P1';

/** Palette index of a category (DEVICE_CATEGORIES order); unknown categories sort last. */
function categoryIndex(category: DeviceCategory): number {
  const at = DEVICE_CATEGORIES.findIndex((c) => c.id === category);
  return at < 0 ? DEVICE_CATEGORIES.length : at;
}

/**
 * Inputs in `lists` order, stably sorted by DEVICE_CATEGORIES so that models keep their file order inside a
 * category (the home-soho end device follows the home routers).
 */
function orderInputs(lists: readonly (readonly ModelInput[])[]): readonly ModelInput[] {
  const flat = lists.flatMap((list) => [...list]);
  const indexed = flat.map((input, i) => ({ input, i, c: categoryIndex(input.category) }));
  indexed.sort((a, b) => a.c - b.c || a.i - b.i);
  return Object.freeze(indexed.map((e) => e.input));
}

/** Every model input of the catalog in palette order (DEVICE_CATEGORIES order, then file order). */
export const ALL_MODEL_INPUTS: readonly ModelInput[] = orderInputs([
  ROUTER_INPUTS,
  SWITCH_INPUTS,
  MULTILAYER_INPUTS,
  DATACENTRE_INPUTS,
  LEGACY_INPUTS,
  SECURITY_INPUTS,
  WIRELESS_INPUTS,
  HOME_INPUTS,
  HOME_END_DEVICE_MODEL_INPUTS,
  RADIO_INPUTS,
  WAN_INPUTS,
  COMPUTER_MODEL_INPUTS,
  SERVER_MODEL_INPUTS,
  MOBILE_MODEL_INPUTS,
  VOICE_MODEL_INPUTS,
  PERIPHERAL_MODEL_INPUTS,
  IOT_MODEL_INPUTS,
]);

/** Every device model, defined for CATALOG_STAGE, in palette order. Frozen and structured-clone safe. */
export const ALL_MODELS: readonly DeviceModel[] = Object.freeze(ALL_MODEL_INPUTS.map((input) => defineModel(input, CATALOG_STAGE)));

/** Every module in docs/CATALOG.md order. Frozen and structured-clone safe. */
export const ALL_MODULES: readonly ModuleModel[] = MODULE_MODELS;

/** Thrown by `createCatalog` when the model or module lists fail validation. */
export class CatalogValidationError extends Error {
  /** Every issue found, in `validateCatalog` order. */
  readonly issues: readonly CatalogIssue[];

  /** Build the error from a non-empty issue list; the message lists one issue per line. */
  constructor(issues: readonly CatalogIssue[]) {
    super(`The device catalog has ${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}:\n${formatCatalogIssues(issues)}`);
    this.name = 'CatalogValidationError';
    this.issues = issues;
  }
}

/** Options of `createCatalog` (tests use them to build catalogs from other lists). */
export interface CatalogOptions {
  /** Models in palette order; default ALL_MODELS. */
  readonly models?: readonly DeviceModel[];
  /** Modules in catalog order; default ALL_MODULES. */
  readonly modules?: readonly ModuleModel[];
  /** Stage the models were defined for (enables the derived-daemon check); default CATALOG_STAGE. */
  readonly stage?: BuildStage;
}

/** Validation result of the built-in lists, computed once on first use. */
let builtInIssues: readonly CatalogIssue[] | undefined;

/** Issues of the built-in lists (ALL_MODELS, ALL_MODULES at CATALOG_STAGE), validated once and cached. */
export function builtInCatalogIssues(): readonly CatalogIssue[] {
  if (builtInIssues === undefined) builtInIssues = Object.freeze(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: CATALOG_STAGE }));
  return builtInIssues;
}

/** The P0 port-name expansion against `model.ports` only (fixed ports; live devices use `resolvePort`). */
export function canonicalPort(model: DeviceModel, name: string): PortId | undefined {
  return canonicalPortName(model, name);
}

/**
 * Build the `DeviceCatalog` from a process registry (name → factory; `protocols/index.ts` in the Simulation,
 * fakes in tests). The model and module lists are validated first; any issue throws `CatalogValidationError`.
 * Daemon names are not checked against the registry: a model daemon without a factory is reported by the device
 * runtime at boot, which lets the registry grow wave by wave.
 */
export function createCatalog(processes: Record<ProcessName, ProcessFactory>, options: CatalogOptions = {}): DeviceCatalog {
  const models = options.models ?? ALL_MODELS;
  const modules = options.modules ?? ALL_MODULES;
  const builtIn = options.models === undefined && options.modules === undefined && (options.stage === undefined || options.stage === CATALOG_STAGE);
  const issues = builtIn ? builtInCatalogIssues() : validateCatalog(models, modules, { stage: options.stage ?? CATALOG_STAGE });
  if (issues.length > 0) throw new CatalogValidationError(issues);

  const byType = new Map<string, DeviceModel>();
  for (const m of models) byType.set(m.type, m);
  const moduleByType = new Map<ModuleType, ModuleModel>();
  for (const m of modules) moduleByType.set(m.type, m);
  const registry = new Map<ProcessName, ProcessFactory>(Object.entries(processes));

  return {
    get(type: string): DeviceModel | undefined {
      return byType.get(type);
    },
    list(): readonly DeviceModel[] {
      return models;
    },
    process(name: ProcessName): ProcessFactory | undefined {
      return registry.get(name);
    },
    module(type: ModuleType): ModuleModel | undefined {
      return moduleByType.get(type);
    },
    modules(): readonly ModuleModel[] {
      return modules;
    },
    resolvePort(source: PortNameSource, name: string): PortResolution {
      return resolvePortName(source, name);
    },
  };
}
