/**
 * protocols/ospf/nsm.ts — the OSPF neighbour state machine's pure rules (ARCHITECTURE-P3 D9, §3.1 steps 2, 3, 5 and
 * 7, §3.2, §4.1, §4.2; RFC 2328 §10.1–§10.8; §7 W2 ospf). The daemon keeps the neighbour records and runs the timers;
 * this module says what a state means, what a database description does, and how a neighbour shows up in rows. No
 * module state, no randomness.
 *
 *   • States in RFC order (`nsmRank`): Down < Attempt < Init < 2-Way < ExStart < Exchange < Loading < Full. A
 *     neighbour at 2-Way or more is bidirectional (crossing that line is an interface NeighborChange); at Exchange or
 *     more it takes part in flooding.
 *   • The initial DD sequence number (D9, §4.1): `(u32(ownRid) ^ u32(nbrRid) ^ (attempt << 16)) & 0x7fffffff`, attempt
 *     = the neighbour's restart counter (0 for the first ExStart, + 1 on every SeqNumberMismatch, BadLSReq or ExStart
 *     restart after `OSPF_EXSTART_MAX_RETRANSMITS` retransmissions). Both ends compute the same value; the slave adopts
 *     the master's anyway.
 *   • `dbdVerdict` (RFC 2328 §10.6) classifies a received database description:
 *       ExStart   I|M|MS, empty, from a higher router id          → 'slave' (NegotiationDone, the neighbour is master)
 *                 I and MS clear, our DD sequence, lower router id → 'master' (NegotiationDone, we are master)
 *                 anything else                                    → 'ignore'
 *       Exchange  the same flags and sequence as the last one received → 'duplicate' (a master discards it, a slave
 *                 answers again with its last packet); MS inconsistent with the roles, I set, or a sequence other than
 *                 the expected one (master: ours; slave: ours + 1) → 'mismatch'; else → 'accept'
 *       Loading, Full  a duplicate → 'duplicate'; anything else → 'mismatch'
 *       Down, Attempt, 2-Way → 'ignore' (Init is turned into 2-WayReceived by the daemon before this call, §3.1 step 7)
 *   • Rows (`OspfNeighborRow.role`): the neighbour's role on the segment as this router sees it: 'dr' / 'bdr' when its
 *     address is the interface's DR / BDR, 'drother' otherwise on a broadcast network, 'none' on point-to-point.
 */
import { ipv4ToU32, type Ipv4Address } from '../../contracts/addr.js';
import type { OspfNetworkType, OspfNsmState } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import { OSPF_DD_FLAG } from '../../pdu/codecs/ospf.js';

/** @since P3 RxmtInterval: DBD, LSR and unacknowledged LSU retransmission (5 s, periodic, §4.2). */
export const OSPF_RXMT_NS = 5 * SEC;
/** @since P3 Retransmissions of the initial DBD before ExStart restarts with a new DD sequence number (§4.2). */
export const OSPF_EXSTART_MAX_RETRANSMITS = 10;
/** @since P3 The hello reply delay after a neighbour goes Down → Init (D9). */
export const OSPF_HELLO_REPLY_NS = 1 * SEC;
/** @since P3 The interface MTU a database description announces when the port has none. */
export const OSPF_DBD_MTU_DEFAULT = 1500;
/** @since P3 Bytes of IPv4 and OSPF headers in front of a packet body (20 + 24). */
export const OSPF_PACKET_OVERHEAD = 44;
/** @since P3 The largest packet body (bytes) the daemon puts in one packet: a 1500-byte IP MTU less the headers. */
export const OSPF_MAX_BODY = 1500 - OSPF_PACKET_OVERHEAD;
/** @since P3 LSA headers in one database description (8 bytes of DBD fields, then 20 per header). */
export const OSPF_DBD_MAX_HEADERS = Math.floor((OSPF_MAX_BODY - 8) / 20);
/** @since P3 Entries in one link-state request (12 bytes each). */
export const OSPF_LSR_MAX_ENTRIES = Math.floor(OSPF_MAX_BODY / 12);

const RANK: Readonly<Record<OspfNsmState, number>> = Object.freeze({
  down: 0,
  attempt: 1,
  init: 2,
  '2way': 3,
  exstart: 4,
  exchange: 5,
  loading: 6,
  full: 7,
});

/** @since P3 The RFC order of neighbour states (Down 0 … Full 7). */
export function nsmRank(state: OspfNsmState): number {
  return RANK[state];
}

/** @since P3 True when `state` is `at` or later in the RFC order. */
export function nsmAtLeast(state: OspfNsmState, at: OspfNsmState): boolean {
  return RANK[state] >= RANK[at];
}

/** @since P3 Neighbour events (RFC 2328 §10.2), as the daemon names them. */
export type OspfNsmEvent =
  | 'hello-received'
  | '2-way-received'
  | '1-way-received'
  | 'adj-ok'
  | 'negotiation-done'
  | 'exchange-done'
  | 'loading-done'
  | 'seq-number-mismatch'
  | 'bad-ls-req'
  | 'kill-nbr'
  | 'inactivity-timer'
  | 'll-down';

/** @since P3 The RFC names of the events, for `ip ospf adj` lines and transition causes. */
export const OSPF_NSM_EVENT_NAMES: Readonly<Record<OspfNsmEvent, string>> = Object.freeze({
  'hello-received': 'HelloReceived',
  '2-way-received': '2-WayReceived',
  '1-way-received': '1-WayReceived',
  'adj-ok': 'AdjOK?',
  'negotiation-done': 'NegotiationDone',
  'exchange-done': 'ExchangeDone',
  'loading-done': 'LoadingDone',
  'seq-number-mismatch': 'SeqNumberMismatch',
  'bad-ls-req': 'BadLSReq',
  'kill-nbr': 'KillNbr',
  'inactivity-timer': 'InactivityTimer',
  'll-down': 'LLDown',
});

/** @since P3 `show ip ospf neighbor` state words (RFC state names). */
export const OSPF_NSM_STATE_TEXT: Readonly<Record<OspfNsmState, string>> = Object.freeze({
  down: 'DOWN',
  attempt: 'ATTEMPT',
  init: 'INIT',
  '2way': '2WAY',
  exstart: 'EXSTART',
  exchange: 'EXCHANGE',
  loading: 'LOADING',
  full: 'FULL',
});

/** @since P3 The initial DD sequence number (D9, §4.1). */
export function ospfDdSeqInitial(ownRid: Ipv4Address, nbrRid: Ipv4Address, attempt: number): number {
  return (((ipv4ToU32(ownRid) ^ ipv4ToU32(nbrRid) ^ ((attempt & 0x7fff) << 16)) >>> 0) & 0x7fffffff) >>> 0;
}

/** @since P3 What a received database description shows. */
export interface OspfDbdSeen {
  readonly flags: number;
  readonly ddSeq: number;
  readonly routerId: Ipv4Address;
  /** It carries no LSA header. */
  readonly empty: boolean;
}

/** @since P3 The neighbour side of a database description exchange. */
export interface OspfDbdState {
  readonly state: OspfNsmState;
  /** This router is master (meaningful from Exchange on). */
  readonly master: boolean;
  /** This router's DD sequence number for the neighbour (the master's current one, or the last the slave accepted). */
  readonly ddSeq: number;
  readonly ownRouterId: Ipv4Address;
  /** Flags and sequence of the last database description accepted from the neighbour. */
  readonly lastReceived?: { readonly flags: number; readonly ddSeq: number };
}

/** @since P3 What a database description does (see the module header). */
export type OspfDbdVerdict = 'slave' | 'master' | 'accept' | 'duplicate' | 'mismatch' | 'ignore';

/** @since P3 Classify a received database description (RFC 2328 §10.6; the module header). */
export function dbdVerdict(nbr: OspfDbdState, pkt: OspfDbdSeen): OspfDbdVerdict {
  const I = (pkt.flags & OSPF_DD_FLAG.I) !== 0;
  const M = (pkt.flags & OSPF_DD_FLAG.M) !== 0;
  const MS = (pkt.flags & OSPF_DD_FLAG.MS) !== 0;
  const higher = ipv4ToU32(pkt.routerId) > ipv4ToU32(nbr.ownRouterId);
  const duplicate = nbr.lastReceived !== undefined && nbr.lastReceived.flags === pkt.flags && nbr.lastReceived.ddSeq === pkt.ddSeq;
  switch (nbr.state) {
    case 'exstart':
      if (I && M && MS && pkt.empty && higher) return 'slave';
      if (!I && !MS && pkt.ddSeq === nbr.ddSeq && !higher) return 'master';
      return 'ignore';
    case 'exchange':
      if (duplicate) return 'duplicate';
      if (I) return 'mismatch';
      if (nbr.master) {
        if (MS) return 'mismatch';
        return pkt.ddSeq === nbr.ddSeq ? 'accept' : 'mismatch';
      }
      if (!MS) return 'mismatch';
      return pkt.ddSeq === ((nbr.ddSeq + 1) >>> 0) ? 'accept' : 'mismatch';
    case 'loading':
    case 'full':
      return duplicate ? 'duplicate' : 'mismatch';
    default:
      return 'ignore';
  }
}

/** @since P3 The `OspfNeighborRow.role` of a neighbour at `address` (see the module header). */
export function ospfNeighborRole(
  networkType: OspfNetworkType,
  address: Ipv4Address,
  dr: Ipv4Address,
  bdr: Ipv4Address,
): 'dr' | 'bdr' | 'drother' | 'none' {
  if (networkType !== 'broadcast') return 'none';
  if (address === dr) return 'dr';
  if (address === bdr) return 'bdr';
  return 'drother';
}

/** @since P3 The DBD flag letters ('I M MS'), for debug lines. */
export function ddFlagsText(flags: number): string {
  const out: string[] = [];
  if (flags & OSPF_DD_FLAG.I) out.push('I');
  if (flags & OSPF_DD_FLAG.M) out.push('M');
  if (flags & OSPF_DD_FLAG.MS) out.push('MS');
  return out.length === 0 ? '-' : out.join(' ');
}
