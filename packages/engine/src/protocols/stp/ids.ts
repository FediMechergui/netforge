/**
 * protocols/stp/ids.ts — spanning-tree bridge and port identifiers (ARCHITECTURE-P2 §3.6 "Identities and costs", D9,
 * §2.6 `BridgeIdText`, §5.1 the root macro).
 *
 * Bridge id (802.1t extended system id, D9: NF switches always use it, §12.2 deviation (13)):
 *   - the 16-bit priority field = configured priority (a multiple of 4096, 0..61440, default 32768) + the VLAN id
 *     (the 12-bit system-id extension), so VLAN 10 at the default is 32778;
 *   - the MAC is the switch's base MAC (`portMac(deviceMacBase(id), 0)`); the stp daemon passes it in;
 *   - text form `${priority}/${mac}` (`BridgeIdText`, e.g. '32778/02:4e:59:e8:af:00'), the form of every `stp` and
 *     `stp-bridge` row.
 * Port id (802.1t): priority (a multiple of 16, 0..240, default 128) in the top 4 bits and the port number in the low
 * 12 bits; the number is the port's `ordinal` for a physical port and 1024 + n for `Port-channel<n>`. Text form
 * `${priority}.${number}` ('128.1'), the `StpPortRow.portId` / `designatedPort` form.
 *
 * Root macro (`spanning-tree vlan <v> root primary|secondary`, §5.1): `rootMacroPriority` compares CONFIGURED
 * priorities (the root's bridge-id priority minus the VLAN) and returns what the CLI handler stores.
 *
 * Pure: no module state, no randomness; integers only.
 */
import { normalizeMac, type MacAddress } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import type { BridgeIdText, StpBridgeRow } from '../../contracts/tables.js';

/** Default configured bridge priority. */
export const STP_DEFAULT_BRIDGE_PRIORITY = 32768;
/** Configured bridge priorities are multiples of this (the low 12 bits carry the VLAN). */
export const STP_BRIDGE_PRIORITY_STEP = 4096;
/** Highest configurable bridge priority. */
export const STP_BRIDGE_PRIORITY_MAX = 61440;
/** Default port priority. */
export const STP_DEFAULT_PORT_PRIORITY = 128;
/** Port priorities are multiples of this. */
export const STP_PORT_PRIORITY_STEP = 16;
/** Highest configurable port priority. */
export const STP_PORT_PRIORITY_MAX = 240;
/** Port number of `Port-channel<n>` = this + n (physical ports use their ordinal, which stays below it). */
export const STP_CHANNEL_PORT_BASE = 1024;
/** Priority `root primary` stores when the current root is configured above it. */
export const STP_ROOT_PRIMARY_PRIORITY = 24576;
/** Priority `root secondary` stores. */
export const STP_ROOT_SECONDARY_PRIORITY = 28672;

/** A bridge identifier: the 16-bit priority field (configured priority + VLAN) and the base MAC. */
export interface BridgeId {
  readonly priority: number;
  readonly mac: MacAddress;
}

/** True for a configurable bridge priority: a multiple of 4096 in 0..61440. */
export function isBridgePriority(p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p <= STP_BRIDGE_PRIORITY_MAX && p % STP_BRIDGE_PRIORITY_STEP === 0;
}

/** True for a configurable port priority: a multiple of 16 in 0..240. */
export function isPortPriority(p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p <= STP_PORT_PRIORITY_MAX && p % STP_PORT_PRIORITY_STEP === 0;
}

/** The bridge-id priority field of an instance: configured priority + VLAN (extended system id). */
export function extendedBridgePriority(configured: number, vlan: number): number {
  if (!isBridgePriority(configured)) throw new RangeError(`bridge priority ${configured} is not a multiple of 4096 in 0..61440`);
  if (!Number.isInteger(vlan) || vlan < 0 || vlan >= STP_BRIDGE_PRIORITY_STEP) throw new RangeError(`VLAN ${vlan} does not fit the system-id extension`);
  return configured + vlan;
}

/** The bridge id of instance `vlan` of a switch with base MAC `mac` and configured priority `configured`. */
export function bridgeIdOf(configured: number, vlan: number, mac: MacAddress): BridgeId {
  const m = normalizeMac(mac);
  if (m === null) throw new RangeError(`invalid bridge MAC ${mac}`);
  return { priority: extendedBridgePriority(configured, vlan), mac: m };
}

/** `${priority}/${mac}`. */
export function bridgeIdText(id: BridgeId): BridgeIdText {
  return `${id.priority}/${id.mac}`;
}

/** Parse `${priority}/${mac}` (priority 0..65535, any accepted MAC form; the MAC comes back canonical). */
export function parseBridgeIdText(text: BridgeIdText): BridgeId | undefined {
  const m = /^(\d{1,5})\/(.+)$/.exec(text);
  if (m === null) return undefined;
  const priority = Number(m[1]);
  const mac = normalizeMac(m[2]!);
  if (priority > 0xffff || mac === null) return undefined;
  return { priority, mac };
}

/**
 * Configured priority of a bridge id seen in instance `vlan`: its priority minus the VLAN (§5.1). When that is not a
 * configurable priority (a BPDU of another VLAN, e.g. across a native-VLAN mismatch), the top 4 bits of the field
 * are used, which is the same value whenever the system-id extension equals the VLAN.
 */
export function configuredPriorityOf(id: BridgeId | BridgeIdText, vlan: number): number {
  const b = typeof id === 'string' ? parseBridgeIdText(id) : id;
  if (b === undefined) throw new RangeError(`invalid bridge id ${String(id)}`);
  const p = b.priority - vlan;
  return isBridgePriority(p) ? p : b.priority & 0xf000;
}

/** What `spanning-tree vlan <v> root primary|secondary` stores for one VLAN (§5.1). */
export type RootMacroOutcome =
  /** Store `spanning-tree vlan <v> priority <priority>`. */
  | { readonly kind: 'store'; readonly priority: number }
  /** This switch is the root with a priority already below 24576: store nothing. */
  | { readonly kind: 'keep' }
  /** Undercutting the root would need a priority below 0: refuse (`CLI_MESSAGES.rootPriorityExhausted`), store nothing. */
  | { readonly kind: 'exhausted' };

/**
 * The root macro for one VLAN, from that VLAN's `stp-bridge` row (§5.1):
 *   - secondary: 28672;
 *   - primary on the root: 24576, unless its own configured priority is already lower (then keep);
 *   - primary elsewhere: 24576 when the root's configured priority is above 24576, else the root's configured
 *     priority − 4096 (so a tie with a lower-MAC root is broken), refused when that is below 0.
 */
export function rootMacroPriority(which: 'primary' | 'secondary', bridge: Pick<StpBridgeRow, 'vlan' | 'bridgeId' | 'rootId' | 'isRoot'>): RootMacroOutcome {
  if (which === 'secondary') return { kind: 'store', priority: STP_ROOT_SECONDARY_PRIORITY };
  if (bridge.isRoot) {
    const own = configuredPriorityOf(bridge.bridgeId, bridge.vlan);
    return own < STP_ROOT_PRIMARY_PRIORITY ? { kind: 'keep' } : { kind: 'store', priority: STP_ROOT_PRIMARY_PRIORITY };
  }
  const root = configuredPriorityOf(bridge.rootId, bridge.vlan);
  if (root > STP_ROOT_PRIMARY_PRIORITY) return { kind: 'store', priority: STP_ROOT_PRIMARY_PRIORITY };
  const p = root - STP_BRIDGE_PRIORITY_STEP;
  return p < 0 ? { kind: 'exhausted' } : { kind: 'store', priority: p };
}

/** Spanning-tree port number of a port: 1024 + n for `Port-channel<n>`, else the port's ordinal. */
export function stpPortNumber(port: PortId, ordinal: number): number {
  const m = /^Port-channel(\d+)$/.exec(port);
  const n = m === null ? ordinal : STP_CHANNEL_PORT_BASE + Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 0xfff) throw new RangeError(`port ${port} has no spanning-tree port number (ordinal ${ordinal})`);
  return n;
}

/** 16-bit port id value: priority in the top 4 bits, number in the low 12 (the value compared in vectors). */
export function portIdValue(priority: number, number: number): number {
  if (!isPortPriority(priority)) throw new RangeError(`port priority ${priority} is not a multiple of 16 in 0..240`);
  if (!Number.isInteger(number) || number < 0 || number > 0xfff) throw new RangeError(`port number ${number} is outside 0..4095`);
  return (priority / STP_PORT_PRIORITY_STEP) * 0x1000 + number;
}

/** Split a 16-bit port id value into priority and number. */
export function portIdParts(value: number): { priority: number; number: number } {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`port id ${value} is outside 0..65535`);
  return { priority: Math.floor(value / 0x1000) * STP_PORT_PRIORITY_STEP, number: value % 0x1000 };
}

/** `${priority}.${number}` ('128.1'). */
export function portIdText(priority: number, number: number): string {
  portIdValue(priority, number);
  return `${priority}.${number}`;
}

/** Parse `${priority}.${number}` into its 16-bit value (undefined when malformed or out of range). */
export function parsePortIdText(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,4})$/.exec(text);
  if (m === null) return undefined;
  const priority = Number(m[1]);
  const number = Number(m[2]);
  if (!isPortPriority(priority) || number > 0xfff) return undefined;
  return portIdValue(priority, number);
}
