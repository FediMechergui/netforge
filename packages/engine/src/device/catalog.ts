/**
 * device/catalog.ts — re-export shim of the P0.5 catalog (device/catalog/index.ts; ARCHITECTURE-P1 §8.1 W2).
 *
 * P0 callers import `createCatalog`, `canonicalPort` and the three P0 models from this path. The models are now
 * the catalog entries themselves (defined with `defineModel` at CATALOG_STAGE), so `catalog.get('router.nf2911')`
 * returns exactly `NF_2911`. Their P0 fields (names, short names, speeds, auto-MDIX, timings, hostname prefixes)
 * are unchanged; the NF-2911 daemons gain `hdlc` at P0.5 (§9.2).
 */
import type { DeviceModel } from '../contracts/device.js';
import { ALL_MODELS } from './catalog/index.js';

export {
  ALL_MODEL_INPUTS,
  ALL_MODELS,
  ALL_MODULES,
  CATALOG_STAGE,
  CatalogValidationError,
  builtInCatalogIssues,
  canonicalPort,
  createCatalog,
  type CatalogOptions,
} from './catalog/index.js';

/** Serial WAN port speed used by the NF-2911 (2 Mbit/s). */
export const SPEED_SERIAL_2M = 2_000_000;

/** Console port bit rate (9600 baud). */
export const SPEED_CONSOLE = 9_600;

/** The catalog entry with type id `type`; throws when the built-in catalog lacks it. */
function builtInModel(type: string): DeviceModel {
  const model = ALL_MODELS.find((m) => m.type === type);
  if (model === undefined) throw new Error(`The built-in catalog has no model with the type id "${type}".`);
  return model;
}

/** NF-PC — a generic workstation with a single gigabit NIC. */
export const NF_PC: DeviceModel = builtInModel('pc.nfpc');

/** NF-C2960 — a 24-port fast-ethernet access switch with two gigabit uplinks. */
export const NF_C2960: DeviceModel = builtInModel('switch.nfc2960');

/** NF-2911 — a branch router with two gigabit LAN ports, two serial WAN ports and a console. */
export const NF_2911: DeviceModel = builtInModel('router.nf2911');

/** The three P0 models in their P0 order (PC, switch, router). */
export const P0_MODELS: readonly DeviceModel[] = Object.freeze([NF_PC, NF_C2960, NF_2911]);
