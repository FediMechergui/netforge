/**
 * Shared fixture of the W2 cli tests (ARCHITECTURE-P2 §7 W2 cli): P2-stage catalog models (managed-switch on the
 * switches, subinterfaces on the routers) built exactly as the W4 catalog flip will build them (test/p2.world.ts).
 * Not a test file itself.
 */
import type { DeviceModel } from '../src/contracts/device.js';
import { ALL_MODEL_INPUTS } from '../src/device/catalog.js';
import { defineModel } from '../src/device/catalog/define.js';
import { NF_C2960_INPUT } from '../src/device/catalog/switches.js';
import { defineP2Model } from './p2.world.js';

/** A P2-stage model by type id (throws for an unknown type). */
export function p2Model(type: string): DeviceModel {
  const input = ALL_MODEL_INPUTS.find((i) => i.type === type);
  if (input === undefined) throw new Error(`no model input ${type}`);
  return defineP2Model(input);
}

/**
 * The NF-C2960 exactly as the P1 catalog built it (not managed, not VLAN-aware): the live input without
 * `managed-switch`, at stage P1. Since the W4 flip the live NF-C2960 is managed, so the negatives that need "the P1
 * switch" build it here (ARCHITECTURE-P2 §9.2 W4 fixture pins); a stage alone is not enough, because the P2 lines are
 * scoped by the stage-independent `managed-switch` capability.
 */
export function p1SwitchModel(): DeviceModel {
  return defineModel({ ...NF_C2960_INPUT, capabilities: ['switching'] }, 'P1');
}
