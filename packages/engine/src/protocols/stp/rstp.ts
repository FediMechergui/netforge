/**
 * protocols/stp/rstp.ts — the 802.1w (Rapid PVST+) rules of one instance, as pure functions (ARCHITECTURE-P2 §3.6
 * "Rapid PVST+", §13 #18; IEEE 802.1D-2004 clause 17).
 *
 *   - States are `discarding`, `learning`, `forwarding`; roles add `backup`. Every bridge sends its own RST BPDUs
 *     (version 2, type 0x02) on its designated ports every hello; stored information ages after 3 × hello.
 *   - A link is point-to-point when the port is full duplex. An edge port (PortFast) forwards at link-up.
 *   - Proposal / agreement: a designated port that is not forwarding on a point-to-point link proposes. The bridge
 *     accepting a superior proposal on its new root port syncs (every non-edge designated port to discarding), agrees
 *     and puts the root port forwarding at once; the proposing port receiving the agreement forwards at once. An
 *     alternate or backup port answers a proposal with an agreement at once (ALTERNATE_AGREED, #18). A designated
 *     port with no agreement falls back to the `fwd:` timers (discarding → learning → forwarding, 2 × forward delay).
 *   - Topology change: only a non-edge port entering forwarding originates one; `tcWhile` = 2 × hello on every
 *     non-edge root and designated port, TC flagged in their BPDUs, dynamic rows flushed on them (except the port that
 *     went forwarding); a receiver propagates on every non-edge root and designated port but the one it heard on.
 *
 * The RST flags byte: bit 0 TC, bit 1 proposal, bits 2–3 role (0 unknown, 1 alternate/backup, 2 root, 3 designated),
 * bit 4 learning, bit 5 forwarding, bit 6 agreement, bit 7 TC-ack (never set by 802.1w).
 *
 * Pure: no state, no clock, integers only.
 */
import type { StpRole, StpState } from '../../contracts/tables.js';
import type { Duplex } from '../../contracts/port.js';
import type { SimTime } from '../../contracts/time.js';
import {
  STP_FLAG_AGREEMENT,
  STP_FLAG_FORWARDING,
  STP_FLAG_LEARNING,
  STP_FLAG_PROPOSAL,
  STP_FLAG_ROLE_MASK,
  STP_FLAG_ROLE_SHIFT,
  STP_FLAG_TC,
  STP_FLAG_TC_ACK,
  STP_ROLE_ALTERNATE_BACKUP,
  STP_ROLE_DESIGNATED,
  STP_ROLE_ROOT,
  STP_ROLE_UNKNOWN,
} from '../../pdu/codecs/stp.js';
import { stpUnitsToNs } from './vector.js';

/** The state a newly active (root or designated) 802.1w port starts in. */
export const RSTP_ENTRY_STATE: StpState = 'discarding';
/** The state of a port that is neither root nor designated. */
export const RSTP_BLOCKED_STATE: StpState = 'discarding';

/** Stored information ages after 3 × hello. */
export function rstpAgeTimerNs(helloUnits: number): SimTime {
  return stpUnitsToNs(3 * helloUnits);
}

/** `tcWhile` = 2 × hello (4 s at the default). */
export function tcWhileNs(helloUnits: number): SimTime {
  return stpUnitsToNs(2 * helloUnits);
}

/** A link is point-to-point when the port negotiated full duplex (`PortState.duplex`); unknown or half = shared. */
export function isPointToPoint(duplex: Duplex | undefined): boolean {
  return duplex === 'full';
}

/** The next timer-driven state of an 802.1w port (`discarding → learning → forwarding`), or undefined when none. */
export function rstpNextState(state: StpState): StpState | undefined {
  if (state === 'discarding') return 'learning';
  if (state === 'learning') return 'forwarding';
  return undefined;
}

/** The role bits (flags bits 2–3) of a port role. */
export function roleBitsOf(role: StpRole): number {
  if (role === 'root') return STP_ROLE_ROOT;
  if (role === 'designated') return STP_ROLE_DESIGNATED;
  if (role === 'alternate' || role === 'backup') return STP_ROLE_ALTERNATE_BACKUP;
  return STP_ROLE_UNKNOWN;
}

/** The decoded flags of an RST BPDU. */
export interface RstFlags {
  readonly tc: boolean;
  readonly proposal: boolean;
  /** 0 unknown, 1 alternate/backup, 2 root, 3 designated. */
  readonly roleBits: number;
  readonly learning: boolean;
  readonly forwarding: boolean;
  readonly agreement: boolean;
  readonly tcAck: boolean;
}

/** Decode a flags byte. */
export function decodeRstFlags(flags: number): RstFlags {
  return {
    tc: (flags & STP_FLAG_TC) !== 0,
    proposal: (flags & STP_FLAG_PROPOSAL) !== 0,
    roleBits: (flags & STP_FLAG_ROLE_MASK) >>> STP_FLAG_ROLE_SHIFT,
    learning: (flags & STP_FLAG_LEARNING) !== 0,
    forwarding: (flags & STP_FLAG_FORWARDING) !== 0,
    agreement: (flags & STP_FLAG_AGREEMENT) !== 0,
    tcAck: (flags & STP_FLAG_TC_ACK) !== 0,
  };
}

/** Encode the flags byte of an RST BPDU sent by a port of `role` in `state`. */
export function rstFlags(role: StpRole, state: StpState, opts: { tc?: boolean; proposal?: boolean; agreement?: boolean } = {}): number {
  let f = roleBitsOf(role) << STP_FLAG_ROLE_SHIFT;
  if (opts.tc === true) f |= STP_FLAG_TC;
  if (opts.proposal === true) f |= STP_FLAG_PROPOSAL;
  if (opts.agreement === true) f |= STP_FLAG_AGREEMENT;
  if (state === 'learning' || state === 'forwarding') f |= STP_FLAG_LEARNING;
  if (state === 'forwarding') f |= STP_FLAG_FORWARDING;
  return f;
}

/** True when the role bits say the sender's port is designated (a version-0 configuration BPDU always is). */
export function isDesignatedSender(version: number, roleBits: number): boolean {
  return version < 2 || roleBits === STP_ROLE_DESIGNATED || roleBits === STP_ROLE_UNKNOWN;
}

/**
 * An agreement is taken on a designated port when the BPDU carries the agreement flag from a root, alternate or backup
 * port (the neighbour accepted this port's information) and names the same root bridge.
 */
export function isAgreementFor(flags: RstFlags, sameRoot: boolean): boolean {
  return flags.agreement && sameRoot && (flags.roleBits === STP_ROLE_ROOT || flags.roleBits === STP_ROLE_ALTERNATE_BACKUP);
}

/** Causes of the rapid transitions (original wording, D19). */
export const CAUSE_AGREEMENT_RECEIVED = 'agreement received';
export const CAUSE_PROPOSAL_ACCEPTED = 'proposal accepted on the root port';
export const CAUSE_SYNC = 'synchronising for a new root port';
export const CAUSE_REROOT = 'new root port on a point-to-point link';
export const CAUSE_TC_RECEIVED = 'topology change received';
