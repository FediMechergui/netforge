/**
 * protocols/etherchannel/compat.ts — the EtherChannel compatibility check (ARCHITECTURE-P2 §3.7 step 9, §3.0 step 4,
 * D10, §13 #25/#32) and the original-wording reasons of the `etherchannel` rows.
 *
 * A member joins its Port-channel only while it agrees with the bundle on everything that would make the bundle
 * forward inconsistently:
 *   1. speed and duplex (negotiated values; compared with the bundled members already in the bundle);
 *   2. the switchport view (`readSwitchport`: mode, nonegotiate, access VLAN, native VLAN, allowed VLANs, voice VLAN;
 *      the member's own section against the Port-channel's own section — the CLI handler keeps them equal, a
 *      hand-written file may not);
 *   3. the negotiated trunking mode (DTP runs on the members; a member whose `operOf` differs from the bundle's
 *      `channelOperOf` over the OTHER bundled members is out).
 * The first difference found, in that order, names the reason:
 *   `configuration differs from Port-channel1 (<first difference>)`   for 1 and 2
 *   `trunk negotiation differs from Port-channel1`                     for 3
 * The other row reasons live here too: `partner differs from the rest of Port-channel1` (an LACP or PAgP partner
 * system or key unlike the bundle's) and `no LACP partner` / `no PAgP partner` (an individual member).
 *
 * Pure: no state, no I/O, no clock, no randomness; integers and strings only.
 */
import type { PortId } from '../../contracts/ids.js';
import type { Duplex, SwitchportConfig } from '../../contracts/port.js';
import type { L2OperMode } from '../l2/membership.js';
import { switchportModeText } from '../l2/switchport-config.js';

/** What the check reads of a member port. */
export interface MemberFacts {
  readonly port: PortId;
  /** `readSwitchport(config, port)`. */
  readonly config: SwitchportConfig;
  /** `operOf(config, dtpRow)`: the member's negotiated trunking mode. */
  readonly oper: L2OperMode;
  /** Negotiated speed and duplex (undefined until the link is up). */
  readonly speedBps?: number;
  readonly duplex?: Duplex;
}

/** What the check reads of the bundle the member wants to join. */
export interface BundleFacts {
  readonly bundle: PortId;
  /** `readSwitchport(config, bundle)`: the Port-channel's own switchport lines. */
  readonly config: SwitchportConfig;
  /**
   * The bundle's speed, duplex and negotiated trunking mode as its OTHER bundled members set them; each undefined when
   * no other member is bundled (the candidate then defines the bundle and nothing is compared).
   */
  readonly speedBps?: number;
  readonly duplex?: Duplex;
  readonly oper?: L2OperMode;
}

/** Result of the check. */
export type Compatibility = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Reason of an individual LACP member (§3.7 step 8). */
export const NO_LACP_PARTNER = 'no LACP partner';
/** [S3] Reason of an individual PAgP member. */
export const NO_PAGP_PARTNER = 'no PAgP partner';

/** `configuration differs from <bundle> (<difference>)`. */
export function configDiffersReason(bundle: PortId, difference: string): string {
  return `configuration differs from ${bundle} (${difference})`;
}
/** `trunk negotiation differs from <bundle>`. */
export function trunkNegotiationReason(bundle: PortId): string {
  return `trunk negotiation differs from ${bundle}`;
}
/** `partner differs from the rest of <bundle>`. */
export function partnerDiffersReason(bundle: PortId): string {
  return `partner differs from the rest of ${bundle}`;
}

/** Human text of a speed: '10 Mb/s', '100 Mb/s', '1 Gb/s', '10 Gb/s' (an unknown speed is 'unknown'). */
export function speedText(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return 'unknown';
  if (bps >= 1_000_000_000) return `${bps / 1_000_000_000} Gb/s`;
  if (bps >= 1_000_000) return `${bps / 1_000_000} Mb/s`;
  return `${bps} b/s`;
}

/** The allowed list as a learner reads it ('all' for every VLAN, 'none' for the empty list). */
function allowedText(allowed: string): string {
  if (allowed === '1-4094') return 'all';
  if (allowed === '') return 'none';
  return allowed;
}

/**
 * The first difference between a member's switchport view and the bundle's, as `<what> <member value> vs <bundle
 * value>`, or undefined when they agree. Order: mode, nonegotiate, access VLAN, native VLAN, allowed VLANs, voice
 * VLAN.
 */
export function switchportDifference(member: SwitchportConfig, bundle: SwitchportConfig): string | undefined {
  if (member.mode !== bundle.mode) return `switchport mode ${switchportModeText(member.mode)} vs ${switchportModeText(bundle.mode)}`;
  if (member.negotiate !== bundle.negotiate) return `${member.negotiate ? 'negotiate' : 'nonegotiate'} vs ${bundle.negotiate ? 'negotiate' : 'nonegotiate'}`;
  if (member.accessVlan !== bundle.accessVlan) return `access VLAN ${member.accessVlan} vs ${bundle.accessVlan}`;
  if (member.nativeVlan !== bundle.nativeVlan) return `native VLAN ${member.nativeVlan} vs ${bundle.nativeVlan}`;
  if (member.allowed !== bundle.allowed) return `allowed VLANs ${allowedText(member.allowed)} vs ${allowedText(bundle.allowed)}`;
  if (member.voiceVlan !== bundle.voiceVlan) return `voice VLAN ${member.voiceVlan ?? 'none'} vs ${bundle.voiceVlan ?? 'none'}`;
  return undefined;
}

/**
 * The compatibility of `member` with `bundle` (§3.7 step 9): speed, duplex, the switchport view, then the negotiated
 * trunking mode. Speed, duplex and trunking are compared only when the bundle has a value (another member bundled).
 */
export function compatibility(member: MemberFacts, bundle: BundleFacts): Compatibility {
  if (bundle.speedBps !== undefined && member.speedBps !== undefined && member.speedBps !== bundle.speedBps) {
    return { ok: false, reason: configDiffersReason(bundle.bundle, `speed ${speedText(member.speedBps)} vs ${speedText(bundle.speedBps)}`) };
  }
  if (bundle.duplex !== undefined && member.duplex !== undefined && member.duplex !== bundle.duplex) {
    return { ok: false, reason: configDiffersReason(bundle.bundle, `duplex ${member.duplex} vs ${bundle.duplex}`) };
  }
  const diff = switchportDifference(member.config, bundle.config);
  if (diff !== undefined) return { ok: false, reason: configDiffersReason(bundle.bundle, diff) };
  if (bundle.oper !== undefined && member.oper !== bundle.oper) return { ok: false, reason: trunkNegotiationReason(bundle.bundle) };
  return { ok: true };
}
