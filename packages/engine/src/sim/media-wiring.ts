/**
 * sim/media-wiring.ts — how the Simulation connects devices to the link model (ARCHITECTURE-P1 §3.1–§3.9, §3.6
 * mobility, §3.14; contracts/link.ts `LinkModelDeps`, contracts/device.ts `DeviceRuntimeDeps`).
 *
 * One wiring per world. It builds the link model with every P0.5 dependency and gives the device runtimes their
 * link-side dependencies, so devices and mediums only meet through the contracts:
 *
 *   link model deps                         → source
 *     port / deviceUp                       → the device map (powered AND booted)
 *     pdus                                  → the world's PDU factory (per-receiver clones on shared media)
 *     portSettings / radioSettings          → DeviceRuntime.phySettings / radioSettings (rendered running-config)
 *     transceiver                           → the catalog optics of the module installed in an SFP cage
 *     position / metresPerUnit              → DeviceSpec.position (integer canvas units) / the world's scale
 *     onTxOutcome                           → DeviceRuntime.onTxOutcome (deferred segment counters)
 *     notify                                → DeviceRuntime.onMediumEvent → Process.onMediumEvent
 *     devices / devicePorts                 → device creation order / canonical port order
 *     capture (P1)                          → the Simulation's NetScope capture hub (capture/tap.ts)
 *   device deps                             → link model
 *     transmit                              → LinkModel.transmit
 *     onPortAdmin, onPortPhyConfig          → LinkModel.onPortChanged, then the OperChanges fan-out
 *     airView                               → LinkModel.airView (ProcessCtx.air)
 *     mediumOp                              → LinkModel.mediumOp, then the fan-out
 *
 * Event dispatch owned here:
 *   frameArrival → LinkModel.admit (prunes the in-flight leg, re-checks authorization, rewraps air data) and, when
 *                  delivered, DeviceRuntime.onFrameArrival(port, verdict.pdu, verdict.corrupted, at, verdict.rx);
 *   txComplete   → LinkModel.onTxComplete;
 *   mediumTimer  → LinkModel.onMediumTimer, then the fan-out;
 *   deviceMoved  → LinkModel.onDevicesMoved([device]), then the fan-out.
 *
 * Coalesced moves (§3.6 step 1): `scheduleMove` schedules ONE `deviceMoved` event at `now` for a device with a
 * wlan, radio or cellular port, unless one is already pending for it. Any number of drags between two dispatches
 * therefore cost one re-evaluation, done at the final position. A removed device's pending move is cancelled.
 *
 * OperChanges fan-out: every OperChanges list the link model returns is applied in order through
 * `DeviceRuntime.onPortOper`; changes addressed to devices that no longer exist are skipped.
 *
 * P0 stability: a plain cable admits silently (no trace), `onPortChanged` without a cause recomputes exactly like
 * the P0 `recompute`, and devices without radio ports never schedule `deviceMoved`, so P0 traces are unchanged.
 */
import type { CaptureTap } from '../contracts/capture.js';
import type { DeviceCatalog, DeviceRuntime } from '../contracts/device.js';
import type { SimEvent } from '../contracts/events.js';
import type { DeviceId, PortId, PortRef } from '../contracts/ids.js';
import type { OperChanges, TransmitFn } from '../contracts/link.js';
import type { AirView, MediumOp } from '../contracts/medium.js';
import type { PduFactory } from '../contracts/pdu.js';
import type { PortKind } from '../contracts/port.js';
import type { Rng } from '../contracts/rng.js';
import type { SimTime } from '../contracts/time.js';
import type { TraceSink } from '../contracts/trace.js';
import { createLinkModel, type LinkModelImpl } from '../link/link.js';
import type { TrackedScheduler } from './run-control.js';

/** Port kinds whose devices take part in mobility (a move re-evaluates their radio pairs). */
export const RADIO_PORT_KINDS: readonly PortKind[] = Object.freeze(['wlan', 'radio', 'cellular']);

/** The part of a simulation world the wiring reads. The collections are live: the wiring never copies them. */
export interface MediaWorld {
  readonly scheduler: TrackedScheduler;
  /** Root rng of the world; the link model receives `split('links')`. */
  readonly rng: Rng;
  readonly pdus: PduFactory;
  /** Devices by id, in creation order. */
  readonly devices: ReadonlyMap<DeviceId, DeviceRuntime>;
  /** Device ids in creation order (kept in step with `devices`). */
  readonly deviceOrder: readonly DeviceId[];
}

/** Construction options of the wiring. */
export interface MediaWiringOptions {
  readonly trace: TraceSink;
  readonly catalog: DeviceCatalog;
  /** Initial metres per canvas unit. */
  readonly metresPerUnit: number;
  /** @since P1 NetScope tap installed as `LinkModelDeps.capture` (the Simulation's capture hub). */
  readonly capture?: CaptureTap;
}

/** The link-side services of one world. */
export interface MediaWiring {
  /** The world's link model. */
  readonly links: LinkModelImpl;
  /** `DeviceRuntimeDeps.transmit`. */
  readonly transmit: TransmitFn;
  /** `DeviceRuntimeDeps.onPortAdmin`: the port changed admin/power/boot state. */
  onPortAdmin(ref: PortRef, adminUp: boolean, now: SimTime): void;
  /** `DeviceRuntimeDeps.onPortPhyConfig`: a PHY- or radio-relevant config line changed on the port. */
  onPortPhyConfig(ref: PortRef, now: SimTime): void;
  /** `DeviceRuntimeDeps.airView`. */
  airView(device: DeviceId): AirView;
  /** `DeviceRuntimeDeps.mediumOp`. */
  mediumOp(from: PortRef, op: MediumOp, now: SimTime): void;
  /** Apply link-model oper changes to the devices, in order. */
  fanOut(changes: OperChanges | undefined, now: SimTime): void;
  /**
   * Dispatch a medium-owned event (`frameArrival`, `txComplete`, `mediumTimer`, `deviceMoved`). Returns false for
   * any other event kind, which the caller dispatches itself.
   */
  dispatch(ev: SimEvent): boolean;
  /**
   * Schedule the coalesced `deviceMoved` event of a device at `now` (§3.6). Returns true when an event is pending
   * for the device after the call: scheduled now or already pending. Devices without radio ports return false.
   */
  scheduleMove(device: DeviceId, now: SimTime): boolean;
  /** Whether a `deviceMoved` event is pending for the device. */
  movePending(device: DeviceId): boolean;
  /** Canvas scale change: recompute radio links and air/cell pairs, then fan out. */
  setScale(metresPerUnit: number, now: SimTime): void;
  /** A device left the world (its links already removed, the map entry already deleted): cancel its move, release its radios. */
  forgetDevice(device: DeviceId, now: SimTime): void;
}

/** True when the device has a wlan, radio or cellular port. */
export function hasRadioPort(dev: Pick<DeviceRuntime, 'ports'>): boolean {
  for (const p of dev.ports.values()) if (RADIO_PORT_KINDS.includes(p.spec.kind)) return true;
  return false;
}

/** Build the link model of a world and the device-facing services around it. */
export function createMediaWiring(world: MediaWorld, opts: MediaWiringOptions): MediaWiring {
  const { devices } = world;
  /** device id → seq of its pending `deviceMoved` event. Lookup only; never iterated. */
  const pendingMoves = new Map<DeviceId, number>();

  const deviceUp = (id: DeviceId): boolean => {
    const d = devices.get(id);
    return d !== undefined && d.power && d.bootedAt !== undefined;
  };

  const links: LinkModelImpl = createLinkModel({
    scheduler: world.scheduler,
    trace: opts.trace,
    rng: world.rng.split('links'),
    port: (ref) => devices.get(ref.device)?.port(ref.port),
    deviceUp,
    hostTerminal: (id) => devices.get(id)?.model.cli?.shell === 'host',
    pdus: world.pdus,
    portSettings: (ref) => devices.get(ref.device)?.phySettings(ref.port),
    radioSettings: (ref) => devices.get(ref.device)?.radioSettings(ref.port),
    transceiver: (ref) => {
      const type = devices.get(ref.device)?.port(ref.port)?.transceiver;
      return type === undefined ? undefined : opts.catalog.module?.(type)?.transceiver;
    },
    position: (id) => devices.get(id)?.spec.position,
    metresPerUnit: opts.metresPerUnit,
    onTxOutcome: (ref, outcome, now) => devices.get(ref.device)?.onTxOutcome(ref.port, outcome, now),
    notify: (ref, ev, now) => devices.get(ref.device)?.onMediumEvent(ref.port, ev, now),
    devices: () => world.deviceOrder,
    devicePorts: (id): readonly PortId[] => {
      const d = devices.get(id);
      return d === undefined ? [] : [...d.ports.keys()];
    },
    capture: opts.capture,
  });

  const fanOut = (changes: OperChanges | undefined, now: SimTime): void => {
    if (changes === undefined) return;
    for (const c of changes) devices.get(c.port.device)?.onPortOper(c.port.port, c.operUp, now);
  };

  const dispatch = (ev: SimEvent): boolean => {
    const at = ev.at;
    switch (ev.kind) {
      case 'frameArrival': {
        const verdict = links.admit(ev, at);
        if (!verdict.deliver) return true;
        devices.get(ev.device)?.onFrameArrival(ev.port, verdict.pdu, verdict.corrupted, at, verdict.rx);
        return true;
      }
      case 'txComplete':
        links.onTxComplete({ device: ev.device, port: ev.port }, at);
        return true;
      case 'mediumTimer':
        fanOut(links.onMediumTimer(ev.medium, ev.key, at), at);
        return true;
      case 'deviceMoved': {
        pendingMoves.delete(ev.device);
        if (!devices.has(ev.device)) return true;
        fanOut(links.onDevicesMoved([ev.device], at), at);
        return true;
      }
      default:
        return false;
    }
  };

  return {
    links,
    transmit: (from, pdu, now) => links.transmit(from, pdu, now),
    onPortAdmin(ref, _adminUp, now) {
      fanOut(links.onPortChanged(ref, now), now);
    },
    onPortPhyConfig(ref, now) {
      fanOut(links.onPortChanged(ref, now), now);
    },
    airView: (device) => links.airView(device),
    mediumOp(from, op, now) {
      fanOut(links.mediumOp(from, op, now), now);
    },
    fanOut,
    dispatch,
    scheduleMove(device, now) {
      if (pendingMoves.has(device)) return true;
      const dev = devices.get(device);
      if (dev === undefined || !hasRadioPort(dev)) return false;
      pendingMoves.set(device, world.scheduler.schedule(now, { kind: 'deviceMoved', device }));
      return true;
    },
    movePending: (device) => pendingMoves.has(device),
    setScale(metresPerUnit, now) {
      fanOut(links.setScale(metresPerUnit, now), now);
    },
    forgetDevice(device, now) {
      const seq = pendingMoves.get(device);
      if (seq !== undefined) {
        world.scheduler.cancel(seq);
        pendingMoves.delete(device);
      }
      fanOut(links.forgetDevice(device, now), now);
    },
  };
}
