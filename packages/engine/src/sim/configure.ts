/**
 * sim/configure.ts — configuration and hardware changes applied by the Simulation facade between scheduler events
 * (ARCHITECTURE-P1 D7, D9, §3.11, §3.12; contracts/simulation.ts `configure`, `insertModule`, `removeModule`).
 *
 * Headless configure (D9, §3.12): look the device up (throw for an unknown id), sync its clock to `now` (exactly like
 * `cli.exec`), then run the lines through `CliRuntime.configure` — a transient `h_<n>` session at privilege 15 that
 * is never listed and emits no CLI trace. Afterwards the device's rendered-config cache entry is invalidated so the
 * next snapshot (or worker delta) shows the result.
 *
 * Config-fragment faults use the same path (§3.12 migrations): the fragment text (or its line list) becomes the
 * command list of `configure(device, lines, CONFIG_FRAGMENT_OPTIONS)`, i.e. pasted-config indentation semantics
 * with every line attempted.
 *
 * Module insert (§3.11): sync the clock; `DeviceRuntime.insertModule` checks slot → module → fit → power →
 * occupancy; on success emit `topologyChanged {what:'module', id:'<device>/<slot>', op:'add'}` (which bumps
 * `topologyVersion`) and invalidate the device's cached configs (new interface sections).
 *
 * Module remove (§3.11): sync the clock; pre-check slot, occupancy and power (a failing pre-check returns the
 * runtime's own refusal and changes nothing); remove every link on the module's ports FIRST (link remove events,
 * oper fan-out); then `DeviceRuntime.removeModule`, `CliRuntime.onPortsRemoved` (sessions inside a removed port's
 * sub-mode drop to `config`), `topologyChanged {what:'module', op:'remove'}`.
 */
import type { CliRuntime, ConfigureOptions, ConfigureResult } from '../contracts/cli.js';
import { type HardwareResult, type ModuleType, type SlotId } from '../contracts/catalog.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { DeviceId, LinkId } from '../contracts/ids.js';
import type { SimTime } from '../contracts/time.js';

/** Options of a config-fragment fault run: pasted-config indentation, keep going after a failing line. */
export const CONFIG_FRAGMENT_OPTIONS: Readonly<ConfigureOptions> = Object.freeze({ indentation: true, stopOnError: false });

/** What the configure and hardware operations need from the facade. */
export interface ConfigureEnv {
  /** Live device lookup in the current world. */
  device(id: DeviceId): DeviceRuntime | undefined;
  /** The facade CLI runtime (its `configure` and `onPortsRemoved` are used). */
  readonly cli: Pick<CliRuntime, 'configure' | 'onPortsRemoved'>;
  /** Current simulation time. */
  now(): SimTime;
  /** Bring the device's own clock to `now` before an operation without a time argument. */
  syncClock(dev: DeviceRuntime): void;
  /** Mark the device's rendered configs stale. */
  invalidate(device: DeviceId): void;
  /** Remove a link with all its events and the oper fan-out (`Simulation.removeLink`). */
  removeLink(id: LinkId): void;
  /** Emit a module `topologyChanged` event and bump `topologyVersion`. */
  moduleChanged(id: string, op: 'add' | 'remove'): void;
}

/** Readable error for an operation on a device id the simulation does not have. */
export function unknownDeviceError(id: DeviceId): Error {
  return new Error(`No device with id "${id}" exists in this simulation.`);
}

function requireDevice(env: ConfigureEnv, id: DeviceId): DeviceRuntime {
  const dev = env.device(id);
  if (dev === undefined) throw unknownDeviceError(id);
  return dev;
}

/**
 * `Simulation.configure`: headless CLI run on one device. Throws only for an unknown device id (and when the CLI
 * runtime lacks headless configure, which the built-in runtime always provides).
 */
export function configureDevice(env: ConfigureEnv, device: DeviceId, commands: readonly string[], opts?: ConfigureOptions): ConfigureResult {
  const dev = requireDevice(env, device);
  env.syncClock(dev);
  try {
    return env.cli.configure(device, commands, opts);
  } finally {
    env.invalidate(device);
  }
}

/**
 * Command list of a config-fragment fault: `params.config` text split into lines, or the string entries of
 * `params.lines`. Undefined when the fault carries neither.
 */
export function configFragmentCommands(params: Readonly<Record<string, unknown>> | undefined): string[] | undefined {
  const text = params?.['config'];
  if (typeof text === 'string') return text.split(/\r?\n/);
  const lines = params?.['lines'];
  if (Array.isArray(lines)) return lines.filter((l): l is string => typeof l === 'string');
  return undefined;
}

/** `Simulation.insertModule`. */
export function insertModule(env: ConfigureEnv, device: DeviceId, slot: SlotId, module: ModuleType): HardwareResult {
  const dev = requireDevice(env, device);
  env.syncClock(dev);
  const now = env.now();
  const r = dev.insertModule(slot, module, now);
  if (!r.ok) return r;
  env.invalidate(device);
  env.moduleChanged(`${device}/${slot}`, 'add');
  return { ok: true };
}

/** `Simulation.removeModule`. */
export function removeModule(env: ConfigureEnv, device: DeviceId, slot: SlotId): HardwareResult {
  const dev = requireDevice(env, device);
  env.syncClock(dev);
  const now = env.now();
  const slotExists = (dev.model.slots ?? []).some((s) => s.id === slot);
  const occupied = dev.modules.has(slot);
  if (!slotExists || !occupied || dev.power) {
    // The runtime reports the first failing check (slot, empty, powered on) without changing anything.
    const refused = dev.removeModule(slot, now);
    return refused.ok ? { ok: true } : { ok: false, code: refused.code, error: refused.error };
  }

  for (const port of dev.modulePorts(slot)) {
    const link = dev.port(port)?.link;
    if (link !== undefined) env.removeLink(link);
  }
  const r = dev.removeModule(slot, env.now());
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  env.cli.onPortsRemoved(device, r.removedPorts ?? []);
  env.invalidate(device);
  env.moduleChanged(`${device}/${slot}`, 'remove');
  return { ok: true };
}
