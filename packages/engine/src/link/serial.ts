/**
 * link/serial.ts — serial DCE resolution, clocking and line-protocol rules (ARCHITECTURE-P1 D6, §3.4 step 8, §3.9).
 *
 * Pure helpers used by the link facade (link/link.ts) and the P2P medium for serial cables:
 *
 *  • DCE end: `LinkSpec.dceEnd` (topology `dce_end`) ?? `MEDIA[media].dceEnd` (serial-dce → 'a', serial-dte → 'b');
 *    legacy 'serial' media: the `PortSpec.clockSource` end when exactly one end is a clock source (a CSU/DSU or
 *    provider port supplies the clock), else the end whose `PortSpec.serial.dce` is set, otherwise end a.
 *  • Clocking (carrier already up): the DCE end needs `clock rate` (`PortPhySettings.clockRateBps`) or a
 *    `clockSource` port. Otherwise both ends keep carrier but the line protocol is down with reason `no-clock`.
 *    When the DCE end has no settings at all (a link model built without `portSettings`, i.e. P0 behaviour)
 *    the clock rule is not applied.
 *  • Encapsulations differ → both ends down with `encapsulation-mismatch`.
 *  • Keepalive: the hdlc daemon reports `line-protocol up:false` on ITS port, which sets a latch on that port
 *    only; that end alone gets `lineProtocol=false`, `lineProtocolReason='keepalive-missed'`, operUp=false.
 *    The peer keeps operUp = carrier && its own line protocol. `LinkState.up` = carrier && both ends' line
 *    protocol (display and animation only). Loss of carrier clears both latches.
 *  • While an end is down ONLY by its keepalive latch, HDLC keepalive frames (protocol 0x8035) are still sent
 *    and received on it so the line can recover (`keepaliveExempt`).
 *  • Rate: `negotiatedBps = min(clock rate, bandwidth cap, both port speeds)`.
 *
 * Every wording here is original.
 */
import type { PortRef } from '../contracts/ids.js';
import { portKey } from '../contracts/ids.js';
import type { LinkSpec, MediaType, PortPhy, PortPhySettings } from '../contracts/link.js';
import { MEDIA } from '../contracts/link.js';
import type { PortEncap } from '../contracts/catalog.js';
import type { PduView } from '../contracts/pdu.js';
import { HDLC_PROTO_KEEPALIVE } from '../contracts/pdu.js';
import type { PortSpec, PortState } from '../contracts/port.js';

/** Which end of a link carries the DCE connector. */
export type DceEnd = 'a' | 'b';

/** Line-protocol down reasons of a carrier-up serial link, in check order. */
export type SerialDownReason = 'no-clock' | 'encapsulation-mismatch' | 'keepalive-missed';

/** Original explanations for the serial line-protocol down reasons (show output, inspector, drop details). */
export const SERIAL_DOWN_TEXT: Readonly<Record<SerialDownReason, string>> = Object.freeze({
  'no-clock': 'The cable end with the DCE connector supplies no clock. Set a clock rate on that interface.',
  'encapsulation-mismatch': 'The two ends use different serial encapsulations, so neither understands the other.',
  'keepalive-missed': 'This end stopped hearing keepalives from the far end, so it declared the line protocol down.',
});

/** True for media of the serial class (legacy serial, serial-dce, serial-dte). */
export function isSerialMedia(media: MediaType): boolean {
  return MEDIA[media].class === 'serial';
}

/**
 * Resolve the DCE end of a serial link (see file header). `a`/`b` are the port specs of the ends (only
 * `clockSource` and `serial.dce` are read, and only for legacy 'serial' media). On legacy 'serial' media the
 * clockSource end is preferred when exactly one end is a clock source, whichever way the cable was dragged.
 * Pure; also valid to call for a link whose ports are unavailable (falls back to the media rule, then end a).
 */
export function resolveDceEnd(
  link: Pick<LinkSpec, 'dceEnd'>,
  media: Exclude<MediaType, 'auto'>,
  a?: Pick<PortSpec, 'serial' | 'clockSource'>,
  b?: Pick<PortSpec, 'serial' | 'clockSource'>,
): DceEnd {
  if (link.dceEnd !== undefined) return link.dceEnd;
  const byMedia = MEDIA[media].dceEnd;
  if (byMedia !== undefined) return byMedia;
  const ca = a?.clockSource === true;
  const cb = b?.clockSource === true;
  if (ca !== cb) return ca ? 'a' : 'b';
  if (a?.serial?.dce === true) return 'a';
  if (b?.serial?.dce === true) return 'b';
  return 'a';
}

/** Effective encapsulation of a port: the runtime-owned `PortState.encap` (serial default hdlc). */
export function effectiveEncap(port: Pick<PortState, 'encap'>): PortEncap {
  return port.encap;
}

/** One end of a carrier-up serial link as the line-protocol rules see it. */
export interface SerialEndInput {
  /** Port maximum (`PortSpec.speedBps`). */
  speedBps: number;
  encap: PortEncap;
  /** Config-derived PHY settings; undefined = the link model has no settings source (no clock rule). */
  settings?: PortPhySettings;
  /** The port generates line clock itself (`PortSpec.clockSource`). */
  clockSource?: boolean;
  /** This end's keepalive latch is set (see `KeepaliveLatches`). */
  keepaliveLatched: boolean;
}

export interface SerialLinkInput {
  a: SerialEndInput;
  b: SerialEndInput;
  dceEnd: DceEnd;
  /** `Impairments.bandwidthBps`. */
  bandwidthBps?: number;
}

/** Result of `evaluateSerialLine` for a link whose carrier is up. */
export interface SerialLinkResult {
  /** carrier && both ends' line protocol (display/animation; per-end `operUp` gates data). */
  up: boolean;
  /** First failing rule in check order; `keepalive-missed` when any latch is set and nothing else failed. */
  downReason?: SerialDownReason;
  /** Line clock in bps (clock rate, or the clock-source port's speed); undefined when unclocked or unchecked. */
  clockBps?: number;
  /** Undefined only when the DCE end has no clock (`no-clock`). */
  negotiatedBps?: number;
  a: PortPhy;
  b: PortPhy;
  operUp: { a: boolean; b: boolean };
  dceEnd: DceEnd;
}

/** Evaluate clocking, encapsulation and the per-end keepalive latches of a carrier-up serial link. */
export function evaluateSerialLine(input: SerialLinkInput): SerialLinkResult {
  const { a, b, dceEnd } = input;
  const dce = dceEnd === 'a' ? a : b;

  let clockBps: number | undefined;
  let noClock = false;
  if (dce.settings?.clockRateBps !== undefined) clockBps = dce.settings.clockRateBps;
  else if (dce.clockSource === true) clockBps = dce.speedBps;
  else if (dce.settings !== undefined) noClock = true;

  let negotiatedBps: number | undefined;
  if (!noClock) {
    negotiatedBps = Math.min(a.speedBps, b.speedBps);
    if (clockBps !== undefined && clockBps < negotiatedBps) negotiatedBps = clockBps;
    if (input.bandwidthBps !== undefined && input.bandwidthBps < negotiatedBps) negotiatedBps = input.bandwidthBps;
  }

  const encapMismatch = a.encap !== b.encap;
  const endPhy = (end: SerialEndInput, isDce: boolean): PortPhy => {
    const phy: PortPhy = { carrier: true, lineProtocol: true, dce: isDce };
    if (noClock) {
      phy.lineProtocol = false;
      phy.lineProtocolReason = 'no-clock';
    } else if (encapMismatch) {
      phy.lineProtocol = false;
      phy.lineProtocolReason = 'encapsulation-mismatch';
    } else if (end.keepaliveLatched) {
      phy.lineProtocol = false;
      phy.lineProtocolReason = 'keepalive-missed';
    }
    return phy;
  };

  const phyA = endPhy(a, dceEnd === 'a');
  const phyB = endPhy(b, dceEnd === 'b');
  const result: SerialLinkResult = {
    up: phyA.lineProtocol && phyB.lineProtocol,
    a: phyA,
    b: phyB,
    operUp: { a: phyA.lineProtocol, b: phyB.lineProtocol },
    dceEnd,
  };
  if (noClock) result.downReason = 'no-clock';
  else if (encapMismatch) result.downReason = 'encapsulation-mismatch';
  else if (a.keepaliveLatched || b.keepaliveLatched) result.downReason = 'keepalive-missed';
  if (clockBps !== undefined) result.clockBps = clockBps;
  if (negotiatedBps !== undefined) result.negotiatedBps = negotiatedBps;
  return result;
}

/** PortPhy of both ends of a serial link without carrier (power, admin, cable problem, cut). */
export function serialCarrierDown(dceEnd: DceEnd): { a: PortPhy; b: PortPhy } {
  return {
    a: { carrier: false, lineProtocol: false, dce: dceEnd === 'a' },
    b: { carrier: false, lineProtocol: false, dce: dceEnd === 'b' },
  };
}

/**
 * Per-port keepalive latches of serial links. Iteration is insertion ordered (deterministic). A latch can
 * only be set while the port's carrier is up; losing carrier clears both ends' latches.
 */
export interface KeepaliveLatches {
  isLatched(ref: PortRef): boolean;
  /**
   * Apply a `line-protocol` medium op reported by the hdlc daemon on `ref`: `up:false` sets the latch,
   * `up:true` clears it. Ignored (returns false) while `carrier` is down. Returns whether the latch changed.
   */
  apply(ref: PortRef, op: { up: boolean }, carrier: boolean): boolean;
  /** Clear one port's latch; returns whether it was set. */
  clear(ref: PortRef): boolean;
  /** Carrier loss on a link: clear both ends; returns whether any latch was set. */
  clearLink(a: PortRef, b: PortRef): boolean;
  /** Latched ports in the order they were latched. */
  latched(): PortRef[];
}

/** Create an empty latch set. */
export function createKeepaliveLatches(): KeepaliveLatches {
  const set = new Map<string, PortRef>();
  const clear = (ref: PortRef): boolean => set.delete(portKey(ref));
  return {
    isLatched: (ref) => set.has(portKey(ref)),
    apply(ref, op, carrier) {
      if (!carrier) return false;
      const key = portKey(ref);
      if (op.up) return set.delete(key);
      if (set.has(key)) return false;
      set.set(key, { device: ref.device, port: ref.port });
      return true;
    },
    clear,
    clearLink(a, b) {
      const ca = clear(a);
      const cb = clear(b);
      return ca || cb;
    },
    latched: () => [...set.values()].map((r) => ({ device: r.device, port: r.port })),
  };
}

/** True when the outermost layer is an HDLC keepalive (protocol 0x8035). */
export function isKeepaliveFrame(pdu: Pick<PduView, 'layers'>): boolean {
  const outer = pdu.layers[0];
  return outer !== undefined && outer.proto === 'hdlc' && outer.fields.protocol === HDLC_PROTO_KEEPALIVE;
}

/** True when the port has carrier and its line protocol is down only by its keepalive latch. */
export function downOnlyByKeepalive(port: { readonly phy?: PortPhy }): boolean {
  return port.phy?.carrier === true && port.phy.lineProtocol === false && port.phy.lineProtocolReason === 'keepalive-missed';
}

/**
 * Keepalive exemption (§3.1 step 4, `LinkModel.transmit`): a keepalive frame on a port that is down only by
 * its keepalive latch is still sent and received. `no-clock` and `encapsulation-mismatch` stay fully blocked.
 */
export function keepaliveExempt(pdu: Pick<PduView, 'layers'>, port: { readonly phy?: PortPhy }): boolean {
  return isKeepaliveFrame(pdu) && downOnlyByKeepalive(port);
}
