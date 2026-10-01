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
 *
 * P3 the configure seam (ARCHITECTURE-P3 D21, §3.0 (c), §7 W1 sim): a daemon's `configure` action makes the runtime
 * schedule `SimEvent {kind: 'deviceConfigure'}` at now (zero delay, non-periodic) through its scheduler. The
 * Simulation's dispatch of that event calls `dispatchDeviceConfigure` — the one caller of the CLI core's headless
 * `configure` for a daemon — in the event's OWN dispatch, so the lines never run inside the issuer's action
 * application and every device call below starts its own action budget. It skips a device that is gone, powered off
 * or still booting (its daemons died with the power, so nobody waits for the answer); otherwise it syncs the device
 * clock, runs the lines at privilege 15 with `{atomic, indentation, origin}` (the headless session hands `origin` to
 * `applyConfigLine`, so the `configChange` events carry it), invalidates the rendered configs, and delivers
 * `ProcessEvent {kind: 'config.result', token, result}` to the issuer through `applyActions`. The run is never
 * journaled: it is a consequence of replayed events, so a replay repeats it exactly.
 */
import type { CliRuntime, ConfigureOptions, ConfigureResult } from '../contracts/cli.js';
import { type HardwareResult, type ModuleType, type SlotId } from '../contracts/catalog.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { SimEvent } from '../contracts/events.js';
import type { DeviceId, LinkId, ProcessName } from '../contracts/ids.js';
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

// ── P3: the configure seam (D21) ─────────────────────────────────────────────

/** @since P3 What the `deviceConfigure` dispatch needs from the facade (D21). */
export interface DeviceConfigureEnv {
  /** Live device lookup in the current world. */
  device(id: DeviceId): DeviceRuntime | undefined;
  /** The CLI core's headless configure — never the journaled facade call (the run is a consequence of replayed events). */
  configure(device: DeviceId, commands: readonly string[], opts: ConfigureOptions): ConfigureResult;
  /** Bring the device's own clock to the event's time. */
  syncClock(dev: DeviceRuntime): void;
  /** Mark the device's rendered configs stale. */
  invalidate(device: DeviceId): void;
  /** The process name the facade applies its own actions as (`SIM_PROCESS_NAME`). */
  readonly caller: ProcessName;
}

/** @since P3 The `deviceConfigure` SimEvent (contracts/events.ts). */
export type DeviceConfigureEvent = Extract<SimEvent, { kind: 'deviceConfigure' }>;

/** @since P3 The headless-configure options of a `deviceConfigure` event: its `origin`, and `atomic` / `indentation` when given. */
export function deviceConfigureOptions(opts: DeviceConfigureEvent['opts']): ConfigureOptions {
  const out: ConfigureOptions = { origin: opts.origin };
  if (opts.atomic !== undefined) out.atomic = opts.atomic;
  if (opts.indentation !== undefined) out.indentation = opts.indentation;
  return out;
}

/**
 * @since P3 The Simulation's dispatch of a `deviceConfigure` event (file header, D21): run the lines through the CLI
 * core in this event's own dispatch and deliver `config.result` to the issuer.
 */
export function dispatchDeviceConfigure(env: DeviceConfigureEnv, ev: DeviceConfigureEvent): void {
  const dev = env.device(ev.device);
  if (dev === undefined || !dev.power || dev.bootedAt === undefined) return;
  env.syncClock(dev);
  let result: ConfigureResult;
  try {
    result = env.configure(ev.device, ev.lines, deviceConfigureOptions(ev.opts));
  } finally {
    env.invalidate(ev.device);
  }
  dev.applyActions(env.caller, [{ type: 'event', to: ev.from, ev: { kind: 'config.result', token: ev.token, result } }], ev.at);
}
