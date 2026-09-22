/**
 * Shared fixture of the W2 cli tests (ARCHITECTURE-P2 §7 W2 cli): P2-stage catalog models (managed-switch on the
 * switches, subinterfaces on the routers) built exactly as the W4 catalog flip will build them (test/p2.world.ts).
 * Not a test file itself.
 */
import type { DeviceModel } from '../src/contracts/device.js';
import { ALL_MODEL_INPUTS } from '../src/device/catalog.js';
import { defineP2Model } from './p2.world.js';

/** A P2-stage model by type id (throws for an unknown type). */
export function p2Model(type: string): DeviceModel {
  const input = ALL_MODEL_INPUTS.find((i) => i.type === type);
  if (input === undefined) throw new Error(`no model input ${type}`);
  return defineP2Model(input);
}
