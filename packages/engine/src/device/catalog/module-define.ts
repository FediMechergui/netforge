/**
 * device/catalog/module-define.ts — `defineModule` and `deepFreeze` (ARCHITECTURE-P1 D7).
 *
 * Kept apart from define.ts so that modules.ts (which freezes its data with `defineModule`) does not import
 * define.ts, and define.ts can read MODULE_MODELS without an import cycle. define.ts re-exports both.
 */
import type { ModuleModel } from '../../contracts/catalog.js';

/** Recursively freeze plain objects and arrays (catalog output is shared by every device instance). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Freeze a module definition (modules have no derived fields; `validateCatalog` checks them). */
export function defineModule(input: ModuleModel): ModuleModel {
  const out: ModuleModel = {
    type: input.type,
    model: input.model,
    description: input.description,
    fits: input.fits,
    ports: input.ports.map((t) => ({ ...t, spec: { ...t.spec } })),
    ...(input.transceiver !== undefined ? { transceiver: { ...input.transceiver } } : {}),
    ...(input.capabilitiesAdded !== undefined ? { capabilitiesAdded: [...input.capabilitiesAdded] } : {}),
  };
  return deepFreeze(out);
}
