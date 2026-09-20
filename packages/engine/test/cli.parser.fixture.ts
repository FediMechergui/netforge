/**
 * Shared CLI parser fixtures (ARCHITECTURE-P1 §9.2 CLI): the P0 test contexts derive their grammar and
 * effective capabilities from the re-authored P0 models (`defineModel` over the W1 catalog inputs) instead of
 * relying on the device kind alone, and config-if contexts carry a selected interface view.
 */
import type { Capability, CliGrammar, PortRole } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortPhy } from '../src/contracts/link.js';
import { emptyCounters, type PortView } from '../src/contracts/port.js';
import { defineModel } from '../src/device/catalog/define.js';
import { portStateFields, testPortSpec, type TestPortInput } from './port.fixtures.js';
import { NF_2911_INPUT, NF_C2960_INPUT, NF_PC_INPUT } from './device.catalog.p0-inputs.js';

/** The three P0 device shapes used by the parser tests. */
export type P0CliKind = 'pc' | 'switch' | 'router';

/** P0 models re-authored through `defineModel` at stage P0.5. */
export const P0_CLI_MODELS: Readonly<Record<P0CliKind, DeviceModel>> = {
  pc: defineModel(NF_PC_INPUT, 'P0.5'),
  switch: defineModel(NF_C2960_INPUT, 'P0.5'),
  router: defineModel(NF_2911_INPUT, 'P0.5'),
};

/** Grammar and effective capabilities of a P0 model, as the runtime derives them. */
export function cliProfile(kind: P0CliKind): { grammar: CliGrammar; capabilities: readonly Capability[] } {
  const model = P0_CLI_MODELS[kind];
  return { grammar: model.cli!.grammar, capabilities: model.capabilities ?? [] };
}

/** Options of `testPortView`. */
export interface TestPortOptions {
  /** Live effective role (omitted = the spec role applies). */
  role?: PortRole;
  /** Serial cable end: true DCE, false DTE (sets `phy`). */
  dce?: boolean;
}

/** A minimal live port view around a spec (derived spec members filled by `testPortSpec`; live role = spec role). */
export function testPortView(input: TestPortInput, opts: TestPortOptions = {}): PortView {
  const spec = testPortSpec(input);
  const view: PortView & { role: PortRole; phy?: PortPhy } = {
    id: spec.name,
    spec,
    ...portStateFields(spec),
    mac: '00:00:00:00:00:01',
    adminUp: true,
    operUp: true,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
  };
  if (opts.role !== undefined) view.role = opts.role;
  if (opts.dce !== undefined) view.phy = { carrier: true, lineProtocol: true, dce: opts.dce };
  return view;
}

/** Live view of a named port of a P0 model. Throws for an unknown name. */
export function modelPortView(kind: P0CliKind, name: string, opts: TestPortOptions = {}): PortView {
  const spec = P0_CLI_MODELS[kind].ports.find((p) => p.name === name);
  if (spec === undefined) throw new Error(`no port ${name} on the ${kind} model`);
  return testPortView(spec, opts);
}

/** Default selected interface of a P0 model in config-if contexts. */
export const DEFAULT_IFACE: Readonly<Record<P0CliKind, string>> = {
  pc: 'GigabitEthernet0',
  switch: 'FastEthernet0/1',
  router: 'GigabitEthernet0/0',
};
