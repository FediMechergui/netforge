/**
 * protocols/stp/mixed.ts — port protocol migration between a `pvst` and a `rapid-pvst` bridge (ARCHITECTURE-P2 §3.6
 * "Mixed modes", §13 #19; IEEE 802.1D-2004 §17.24).
 *
 *   - A rapid port starts in protocol `rstp` with a 3 s migrate delay (`migrate:<vlan>:<port>`, non-periodic). A
 *     version-0 (802.1D) BPDU received AFTER that delay sets the port's protocol to `stp`: on that port only it sends
 *     802.1D configuration and TCN BPDUs, forgoes proposal / agreement, uses the forward-delay timers and accepts
 *     TCNs. An RST BPDU received on a port speaking `stp` after the delay migrates it back to `rstp` (§17.24, the
 *     `rcvdRSTP` transition), and `clear spanning-tree detected-protocols` forces `rstp` and restarts the delay.
 *   - A `pvst` bridge discards type-0x02 (RST) BPDUs, as legacy bridges do, so its neighbour's rapid port migrates on
 *     the pvst side's own BPDUs.
 *
 * Pure: no state, no clock.
 */
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { STP_BPDU_RST, STP_VERSION_RSTP } from '../../pdu/codecs/stp.js';

/** The protocol a port speaks (`StpPortRow.protocol`). */
export type StpPortProtocol = 'stp' | 'rstp';

/** 802.1D-2004 MigrateTime: 3 s. */
export const STP_MIGRATE_DELAY_NS: SimTime = 3 * SEC;

/** The protocol a received BPDU speaks: RST (version ≥ 2, type 0x02) or 802.1D. */
export function bpduProtocolOf(version: number, bpduType: number): StpPortProtocol {
  return version >= STP_VERSION_RSTP && bpduType === STP_BPDU_RST ? 'rstp' : 'stp';
}

/** True when a legacy (`pvst`) bridge discards the BPDU: every RST BPDU. */
export function legacyBridgeDiscards(version: number, bpduType: number): boolean {
  return bpduProtocolOf(version, bpduType) === 'rstp';
}

/**
 * The protocol a rapid port speaks after receiving a BPDU of `received` protocol: unchanged while the migrate delay
 * runs (`migrating`), else the received protocol (802.1D → `stp`, RST → `rstp`).
 */
export function migrationDecision(current: StpPortProtocol, received: StpPortProtocol, migrating: boolean): StpPortProtocol {
  if (migrating) return current;
  return received;
}

/** The kind of `ext.` request the CLI sends for `clear spanning-tree detected-protocols [interface <if>]` (§5.4). */
export const STP_CLEAR_DETECTED_PROTOCOLS_REQUEST = 'ext.stp.clear-detected-protocols';

/** Cause texts of the migration transitions (original wording, D19). */
export const CAUSE_MIGRATED_TO_STP = 'neighbour speaks 802.1D';
export const CAUSE_MIGRATED_TO_RSTP = 'neighbour speaks 802.1w';
export const CAUSE_MIGRATION_CLEARED = 'detected protocols cleared';
