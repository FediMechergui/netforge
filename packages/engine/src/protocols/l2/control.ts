/**
 * protocols/l2/control.ts — the L2 control-frame table (ARCHITECTURE-P2 D7, §2.4 "The L2 control table", §3.0 steps 2
 * and 5). Its shape is contract: eth-switch dispatches with it, and stp, dtp and etherchannel receive what it names.
 *
 * Only a VLAN-aware device (`isVlanAware(model)`) uses the table, for frames arriving on a bridged port. Transparent
 * bridges bridge every frame exactly as before and never call it.
 *
 * | Frame                                                   | class        | delivered to                 | port passed |
 * |---------------------------------------------------------|--------------|------------------------------|-------------|
 * | dst 01:80:c2:00:00:00, llc dsap 0x42                    | 'stp'        | stp if an instance runs for  | logical     |
 * |                                                         |              | the VLAN; else bridged       |             |
 * | ethertype 0x8809 (untagged), lacp.subtype 1             | 'lacp'       | etherchannel; never bridged  | physical    |
 * | dst NF_L2_CONTROL_MAC, SNAP NF_OUI, PID 1               | 'dtp'        | dtp; never bridged           | physical    |
 * | dst NF_L2_CONTROL_MAC, SNAP NF_OUI, PID 3   [S3]        | 'pagp'       | etherchannel; never bridged  | physical    |
 * | any other dst in 01:80:c2:00:00:00–0f                   | 'reserved'   | dropped not-for-me           | —           |
 * | anything else                                           | undefined    | normal bridging              | —           |
 *
 * A class whose daemon is not in `model.processes` is dropped `unsupported-protocol`, detail `<class> is not running
 * on this device` — except 'stp', which is bridged as an ordinary multicast of its VLAN; on a `wireless-controller`
 * (which never relays spanning tree) a BPDU is dropped `not-for-me`, detail `the controller does not relay spanning
 * tree`. (VTP, PID 2, is a COULD item that is not approved: its frames are not classified and bridge like any other
 * multicast.)
 *
 * The reserved block: exactly `01:80:c2:00:00:01`–`0f`, as the table says. `01:80:c2:00:00:00` is claimed by the STP
 * row, so a frame to the bridge group address that is not an LLC-0x42 BPDU classifies `undefined` and is bridged as an
 * ordinary multicast of its VLAN ("anything else"). `isReservedLinkGroup` still covers the whole IEEE block 00–0f —
 * that is the block the pipeline's step 10b (§3.0, non-bridged ports only) treats as link-layer control — so
 * `classifyControl` excludes the bridge group address itself.
 *
 * Pure: no state, no I/O, no clock, no randomness.
 */
import type { MacAddress } from '../../contracts/addr.js';
import type { Capability } from '../../contracts/catalog.js';
import type { ProcessName } from '../../contracts/ids.js';
import type { DropReason } from '../../contracts/link.js';
import {
  ETHERTYPE_SLOW_PROTOCOLS,
  LLC_SAP_STP,
  NF_L2_CONTROL_MAC,
  NF_OUI,
  NF_PID_DTP,
  NF_PID_PAGP,
  STP_GROUP_MAC,
} from '../../contracts/pdu.js';
import type { LayerView, PduView } from '../../contracts/pdu.js';

/** Class of an L2 control frame on a bridged port of a VLAN-aware device (§2.4). 'pagp' is [SHOULD S3]. */
export type L2ControlClass = 'stp' | 'lacp' | 'dtp' | 'pagp' | 'reserved';

/** One row of the control table. */
export interface L2ControlRow {
  readonly cls: L2ControlClass;
  /** Daemon that receives the frame; undefined for 'reserved'. */
  readonly to?: ProcessName;
  /**
   * Which port the daemon is told: 'physical' = the arrival port, dispatched at §3.0 step 2 BEFORE member translation
   * (so LACP still reaches a waiting or suspended member); 'logical' = the bundle when the arrival port is a bundled
   * member, dispatched at step 5 after classification. null for 'reserved'.
   */
  readonly port: 'physical' | 'logical' | null;
  /** What happens when `to` does not run on the device: 'bridge' (stp only) or 'drop'. */
  readonly whenAbsent: 'bridge' | 'drop';
}

/** The control table, in table order (§2.4). */
export const L2_CONTROL: readonly L2ControlRow[] = Object.freeze([
  Object.freeze({ cls: 'stp', to: 'stp', port: 'logical', whenAbsent: 'bridge' } as const),
  Object.freeze({ cls: 'lacp', to: 'etherchannel', port: 'physical', whenAbsent: 'drop' } as const),
  Object.freeze({ cls: 'dtp', to: 'dtp', port: 'physical', whenAbsent: 'drop' } as const),
  // [S3] PAgP in its NF format (D8)
  Object.freeze({ cls: 'pagp', to: 'etherchannel', port: 'physical', whenAbsent: 'drop' } as const),
  Object.freeze({ cls: 'reserved', port: null, whenAbsent: 'drop' } as const),
]) as readonly L2ControlRow[];

/** The table row of `cls`. */
export function l2ControlRow(cls: L2ControlClass): L2ControlRow {
  return L2_CONTROL.find((r) => r.cls === cls) as L2ControlRow;
}

/** True for the classes handled on the physical port at §3.0 step 2 (everything but 'stp'). */
export function isPhysicalControl(cls: L2ControlClass): boolean {
  return l2ControlRow(cls).port !== 'logical';
}

/** Drop detail of a reserved link-layer group frame. */
export const DETAIL_RESERVED_GROUP = 'reserved link-layer group';
/** Drop detail of a BPDU at a wireless controller (D17). */
export const DETAIL_CONTROLLER_NO_STP = 'the controller does not relay spanning tree';
/** Drop detail of a control class whose daemon does not run here: `<class> is not running on this device`. */
export function controlNotRunningDetail(cls: L2ControlClass): string {
  return `${cls} is not running on this device`;
}

/** True for a destination in the IEEE reserved block 01:80:c2:00:00:00–0f. */
export function isReservedLinkGroup(mac: MacAddress): boolean {
  const m = mac.toLowerCase();
  if (!m.startsWith('01:80:c2:00:00:')) return false;
  const last = parseInt(m.slice(15), 16);
  return m.length === 17 && Number.isInteger(last) && last >= 0 && last <= 0x0f;
}

/** First layer of `proto`, outermost first. */
function firstLayer(frame: Pick<PduView, 'layers'>, proto: string): LayerView | undefined {
  for (const l of frame.layers) if (l.proto === proto) return l;
  return undefined;
}

/**
 * Class of a frame (§2.4 table), or undefined for an ordinary frame. Reads only decoded fields: the outer
 * `ethernet.dst` and `ethernet.type`, the first `llc` layer's `dsap`/`oui`/`type` and a `lacp` layer's `subtype`, so a
 * per-VLAN BPDU tagged on a trunk (`[ethernet 0x8100, dot1q, llc, stp]`) classifies like an untagged one.
 */
export function classifyControl(frame: Pick<PduView, 'layers'>): L2ControlClass | undefined {
  const eth = frame.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') return undefined;
  const dst = String(eth.fields.dst ?? '').toLowerCase();

  if (dst === STP_GROUP_MAC) {
    const llc = firstLayer(frame, 'llc');
    if (llc !== undefined && llc.fields.dsap === LLC_SAP_STP) return 'stp';
  }
  if (eth.fields.type === ETHERTYPE_SLOW_PROTOCOLS) {
    const lacp = firstLayer(frame, 'lacp');
    if (lacp !== undefined && lacp.fields.subtype === 1) return 'lacp';
  }
  if (dst === NF_L2_CONTROL_MAC) {
    const llc = firstLayer(frame, 'llc');
    if (llc !== undefined && llc.fields.oui === NF_OUI) {
      if (llc.fields.type === NF_PID_DTP) return 'dtp';
      if (llc.fields.type === NF_PID_PAGP) return 'pagp'; // [S3]
    }
    return undefined;
  }
  // §2.4 reserves `01:80:c2:00:00:01`–`0f` only: the bridge group address `…:00` is claimed by the STP row above, and
  // a frame to it that is not an LLC-0x42 BPDU falls through to "anything else" and bridges as an ordinary multicast.
  if (dst !== STP_GROUP_MAC && isReservedLinkGroup(dst)) return 'reserved';
  return undefined;
}

/** What eth-switch does with a classified control frame. */
export type L2ControlAction =
  /** `Action deliver {to, pdu, port}` with the physical (arrival) or logical (bundle) port, and the frame stops. */
  | { readonly kind: 'deliver'; readonly to: ProcessName; readonly port: 'physical' | 'logical' }
  /** The frame continues as an ordinary multicast of its VLAN (a BPDU with no spanning-tree instance for it). */
  | { readonly kind: 'bridge' }
  /** `Action drop {reason, detail}`, and the frame stops. */
  | { readonly kind: 'drop'; readonly reason: DropReason; readonly detail: string };

/**
 * The action for a frame of class `cls` on a device running `model.processes`. For 'stp', `stpInstance` tells whether
 * a `stp-bridge` row exists for the frame's VLAN (§3.0 step 5: delivered even when the port is blocking); it is
 * ignored for the other classes.
 */
export function controlAction(
  cls: L2ControlClass,
  model: { readonly processes: readonly ProcessName[]; readonly capabilities?: readonly Capability[] },
  stpInstance = false,
): L2ControlAction {
  const row = l2ControlRow(cls);
  if (cls === 'reserved' || row.to === undefined) {
    return { kind: 'drop', reason: 'not-for-me', detail: DETAIL_RESERVED_GROUP };
  }
  if (cls === 'stp') {
    if (model.capabilities?.includes('wireless-controller') === true) {
      return { kind: 'drop', reason: 'not-for-me', detail: DETAIL_CONTROLLER_NO_STP };
    }
    if (!model.processes.includes(row.to) || !stpInstance) return { kind: 'bridge' };
    return { kind: 'deliver', to: row.to, port: 'logical' };
  }
  if (!model.processes.includes(row.to)) {
    return { kind: 'drop', reason: 'unsupported-protocol', detail: controlNotRunningDetail(cls) };
  }
  return { kind: 'deliver', to: row.to, port: row.port === 'logical' ? 'logical' : 'physical' };
}
