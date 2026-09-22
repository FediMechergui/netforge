/**
 * protocols/l2/membership.ts — VLAN membership of bridged ports (ARCHITECTURE-P2 D5, §3.0 steps 4, 11 and 12).
 *
 * Pure rules shared by eth-switch (classification, flood candidates, tag normalisation), the runtime's SVI autostate,
 * the snapshot builder and stp:
 *
 *  • `classify(view, tag, exists)` — the VLAN V of a frame arriving on logical port L (§3.0 step 4):
 *      untagged or VID 0 → access: the access VLAN; trunk: the native VLAN if the native VLAN is allowed, else drop
 *        `vlan-filtered` "native VLAN <n> is not allowed on <L>";
 *      tagged v → access: v if it is the voice VLAN [S4], else drop "tagged frame for VLAN <v> on an access port
 *        (access VLAN <a>)"; trunk: v if allowed (a tagged native VLAN is accepted), else drop "VLAN <v> is not allowed
 *        on <L>";
 *      then V must exist (1, 1002–1005 or a `vlans` row), else drop "VLAN <V> does not exist".
 *  • `carries(view, V, exists)` — how port E carries V: access → 'untagged' for its access VLAN, 'tagged' for its voice
 *    VLAN [S4]; trunk → for an allowed, existing VLAN 'untagged' if native else 'tagged' (a native VLAN that is not
 *    allowed is not carried at all); a `wlan-tunnel` port (Capwap0) → every existing VLAN 'tagged'; else undefined.
 *    A Port-channel is asked with its own configuration; a controller distribution port with
 *    CONTROLLER_PORT_SWITCHPORT (readSwitchport does both). `carries` is never asked about an SVI.
 *  • `normaliseForPort` / `normaliseForSvi` — step 12: want = carries(E, V) for a port target, always 'untagged' for
 *    the SVI ingress target (an L3 daemon never sees a tag, D4); push, pop or nothing, with the cause line.
 *
 * `operOf(config, dtpRow)`: static modes as configured, dynamic modes from the dtp row ('access' until negotiated);
 * `channelOperOf` gives a Port-channel the common oper mode of its bundled members (§3.0 step 4, §3.3 rule 5).
 *
 * Pure: no state, no I/O, no clock, no randomness.
 */
import type { PortRole } from '../../contracts/catalog.js';
import type { PortId } from '../../contracts/ids.js';
import type { PduView } from '../../contracts/pdu.js';
import type { SwitchportConfig } from '../../contracts/port.js';
import { vlanKey } from '../../contracts/tables.js';
import type { DtpRow } from '../../contracts/tables.js';
import { trunkAllows } from './switchport-config.js';

/** How a port carries a VLAN on the wire. */
export type VlanCarry = 'tagged' | 'untagged';
/** Operational switchport mode. */
export type L2OperMode = 'access' | 'trunk';
/** Existence of a VLAN on the device (`isImplicitVlan` or a `vlans` row). */
export type VlanExistsFn = (vlan: number) => boolean;

/** The L2 facts of one bridged port that membership needs. */
export interface L2PortView {
  /** Logical port id (a physical switched port, `Port-channelN`, or `Capwap0`). */
  readonly port: PortId;
  /** `readSwitchport(config, port[, model])`. */
  readonly config: SwitchportConfig;
  /** `operOf` / `channelOperOf` of the port. Ignored for a `wlan-tunnel` port. */
  readonly oper: L2OperMode;
  /** Effective role; only 'wlan-tunnel' changes the rules (carries every existing VLAN tagged). */
  readonly role?: PortRole;
}

/** Cause of a push/pop toward the controller tunnel (Capwap0). */
export const CAUSE_CONTROLLER_TUNNEL = 'controller tunnel';
/** Cause of a push toward a trunk whose mode was negotiated by DTP. */
export const CAUSE_NEGOTIATED_TRUNK = 'negotiated trunk';

/** VLAN 1 and 1002–1005 exist implicitly and are never `vlans` rows (§2.6). */
export function isImplicitVlan(vlan: number): boolean {
  return vlan === 1 || (vlan >= 1002 && vlan <= 1005);
}

/** Existence predicate over a device's `vlans` table (undefined table = only the implicit VLANs). */
export function vlanExistsIn(vlans: { has(key: string): boolean } | undefined): VlanExistsFn {
  return (vlan: number): boolean => isImplicitVlan(vlan) || (vlans?.has(vlanKey(vlan)) ?? false);
}

/** SVI name of a VLAN: `Vlan<V>`. */
export function sviName(vlan: number): PortId {
  return `Vlan${vlan}`;
}

/** VLAN of an SVI name (`Vlan10` → 10), else undefined. */
export function vlanOfSviName(port: PortId): number | undefined {
  const m = /^Vlan(\d{1,4})$/.exec(port);
  if (m === null) return undefined;
  const v = Number(m[1]);
  return v >= 1 && v <= 4094 ? v : undefined;
}

/**
 * The 802.1Q VID of a frame: `layers[1].vid` when `layers[1]` is `dot1q` (the only place a tag may sit, D4), else
 * undefined (untagged). VID 0 (priority tag) is returned as 0; `classify` treats it as untagged.
 */
export function frameVlanTag(frame: Pick<PduView, 'layers'>): number | undefined {
  const l = frame.layers[1];
  if (l === undefined || l.proto !== 'dot1q') return undefined;
  const vid = l.fields.vid;
  return typeof vid === 'number' ? vid : undefined;
}

/** True when the frame carries an 802.1Q tag (`layers[1]` is `dot1q`). */
export function isTaggedFrame(frame: Pick<PduView, 'layers'>): boolean {
  return frame.layers[1]?.proto === 'dot1q';
}

/** Oper mode of a port: static modes as configured; dynamic modes from its dtp row ('access' until negotiated). */
export function operOf(config: SwitchportConfig, dtp?: Pick<DtpRow, 'oper'>): L2OperMode {
  if (config.mode === 'access') return 'access';
  if (config.mode === 'trunk') return 'trunk';
  return dtp?.oper ?? 'access';
}

/**
 * Oper mode of a Port-channel: static modes from its own configuration; dynamic modes from the dtp rows of its
 * BUNDLED members (DTP runs on members) — 'trunk' only when there is at least one and every one is trunk.
 */
export function channelOperOf(config: SwitchportConfig, memberRows: readonly (Pick<DtpRow, 'oper'> | undefined)[]): L2OperMode {
  if (config.mode === 'access') return 'access';
  if (config.mode === 'trunk') return 'trunk';
  if (memberRows.length === 0) return 'access';
  return memberRows.every((r) => r?.oper === 'trunk') ? 'trunk' : 'access';
}

/** Result of classifying a frame on a logical port. */
export type VlanClassification =
  | { readonly ok: true; readonly vlan: number }
  | { readonly ok: false; readonly reason: 'vlan-filtered'; readonly detail: string };

/** Drop detail: `native VLAN <n> is not allowed on <L>`. */
export function nativeNotAllowedDetail(native: number, port: PortId): string {
  return `native VLAN ${native} is not allowed on ${port}`;
}
/** Drop detail: `tagged frame for VLAN <v> on an access port (access VLAN <a>)`. */
export function taggedOnAccessDetail(vlan: number, access: number): string {
  return `tagged frame for VLAN ${vlan} on an access port (access VLAN ${access})`;
}
/** Drop detail: `VLAN <v> is not allowed on <L>`. */
export function vlanNotAllowedDetail(vlan: number, port: PortId): string {
  return `VLAN ${vlan} is not allowed on ${port}`;
}
/** Drop detail: `VLAN <V> does not exist`. */
export function vlanMissingDetail(vlan: number): string {
  return `VLAN ${vlan} does not exist`;
}
/** Drop detail: an untagged frame on the controller tunnel, which carries tagged VLANs only. */
export function untaggedOnTunnelDetail(port: PortId): string {
  return `untagged frame on ${port}, which carries tagged VLANs only`;
}

const filtered = (detail: string): VlanClassification => ({ ok: false, reason: 'vlan-filtered', detail });

/**
 * The VLAN of a frame with 802.1Q VID `tag` (undefined = untagged; 0 = priority-tagged, treated as untagged) arriving
 * on the logical port `view`, or the `vlan-filtered` drop (§3.0 step 4).
 */
export function classify(view: L2PortView, tag: number | undefined, exists: VlanExistsFn): VlanClassification {
  const untagged = tag === undefined || tag === 0;
  let vlan: number;
  if (view.role === 'wlan-tunnel') {
    if (untagged) return filtered(untaggedOnTunnelDetail(view.port));
    vlan = tag;
  } else if (view.oper === 'access') {
    if (untagged) {
      vlan = view.config.accessVlan;
    } else if (acceptsVoiceTag(view.config, tag)) {
      vlan = tag;
    } else {
      return filtered(taggedOnAccessDetail(tag, view.config.accessVlan));
    }
  } else if (untagged) {
    if (!trunkAllows(view.config, view.config.nativeVlan)) {
      return filtered(nativeNotAllowedDetail(view.config.nativeVlan, view.port));
    }
    vlan = view.config.nativeVlan;
  } else {
    if (!trunkAllows(view.config, tag)) return filtered(vlanNotAllowedDetail(tag, view.port));
    vlan = tag;
  }
  if (!exists(vlan)) return filtered(vlanMissingDetail(vlan));
  return { ok: true, vlan };
}

/** How port `view` carries VLAN `vlan`, or undefined when it does not carry it (§3.0 `carries`). */
export function carries(view: L2PortView, vlan: number, exists: VlanExistsFn): VlanCarry | undefined {
  if (view.role === 'wlan-tunnel') return exists(vlan) ? 'tagged' : undefined;
  if (view.oper === 'access') {
    if (vlan === view.config.accessVlan) return 'untagged';
    return voiceVlanCarry(view.config, vlan);
  }
  if (!exists(vlan) || !trunkAllows(view.config, vlan)) return undefined;
  return vlan === view.config.nativeVlan ? 'untagged' : 'tagged';
}

/**
 * The config line that makes `view` carry `vlan` the way `how` says — the provenance cause of a push or pop toward it
 * (§3.0 step 12): `switchport mode trunk` (static trunk, tagged), `negotiated trunk` (dynamic trunk, tagged),
 * `switchport trunk native vlan <V>` (trunk, untagged), `switchport access vlan <V>`, `switchport voice vlan <V>` [S4],
 * `controller tunnel` (Capwap0).
 */
export function carryCause(view: L2PortView, vlan: number, how: VlanCarry): string {
  if (view.role === 'wlan-tunnel') return CAUSE_CONTROLLER_TUNNEL;
  if (view.oper === 'access') {
    if (how === 'tagged') return voiceVlanCause(vlan);
    return `switchport access vlan ${vlan}`;
  }
  if (how === 'untagged') return `switchport trunk native vlan ${vlan}`;
  return view.config.mode === 'trunk' ? 'switchport mode trunk' : CAUSE_NEGOTIATED_TRUNK;
}

/** What to do to a copy's tag: push (untagged → tagged), pop (tagged → untagged) or nothing. */
export type TagChange = 'push' | 'pop' | 'none';

/** Tag change that turns a copy that is `tagged` (or not) into `want`. */
export function tagChange(tagged: boolean, want: VlanCarry): TagChange {
  if (want === 'tagged') return tagged ? 'none' : 'push';
  return tagged ? 'pop' : 'none';
}

/** Tag normalisation of one copy toward one target (§3.0 step 12). */
export interface EgressNormalisation {
  readonly want: VlanCarry;
  readonly change: TagChange;
  /** Provenance cause of the push/pop (also given when `change` is 'none'). */
  readonly cause: string;
}

/** Normalisation of a copy (tagged or not) of a VLAN-`vlan` frame toward port `view`; undefined when not carried. */
export function normaliseForPort(view: L2PortView, vlan: number, tagged: boolean, exists: VlanExistsFn): EgressNormalisation | undefined {
  const want = carries(view, vlan, exists);
  if (want === undefined) return undefined;
  return { want, change: tagChange(tagged, want), cause: carryCause(view, vlan, want) };
}

/** Normalisation of a copy handed to the SVI `Vlan<vlan>`: always untagged (D4), cause `interface Vlan<V>`. */
export function normaliseForSvi(vlan: number, tagged: boolean): EgressNormalisation {
  return { want: 'untagged', change: tagChange(tagged, 'untagged'), cause: `interface ${sviName(vlan)}` };
}

// [S4] ── voice VLAN rules (ARCHITECTURE-P2 §5.1 `switchport voice vlan <v>`, §3.0 step 4 and `carries`) ──────────
// An access port also carries its voice VLAN, TAGGED (the phone tags its own traffic; the PC behind it sends untagged
// frames in the access VLAN). A trunk ignores the voice VLAN. The voice VLAN must exist like any other VLAN
// (`classify` checks it); `carries` does not check existence for access-port VLANs, as for the access VLAN.

/** [S4] True when an access port with `config` accepts a frame tagged `vid` (the voice VLAN). */
export function acceptsVoiceTag(config: SwitchportConfig, vid: number): boolean {
  return config.voiceVlan !== undefined && vid === config.voiceVlan;
}

/** [S4] 'tagged' when `vlan` is the voice VLAN of an access port with `config` (and not its access VLAN), else undefined. */
export function voiceVlanCarry(config: SwitchportConfig, vlan: number): VlanCarry | undefined {
  if (config.voiceVlan === undefined || vlan !== config.voiceVlan || vlan === config.accessVlan) return undefined;
  return 'tagged';
}

/** [S4] Provenance cause of a tag pushed toward (or popped from) the voice VLAN of an access port. */
export function voiceVlanCause(vlan: number): string {
  return `switchport voice vlan ${vlan}`;
}
// [S4] ── end ───────────────────────────────────────────────────────────────────────────────────────────────────
