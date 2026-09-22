/**
 * protocols/etherchannel/lacp.ts — the LACP half of the EtherChannel daemon: LACPDU construction and reading, the
 * actor state bits, the timer keys and intervals (ARCHITECTURE-P2 D8, §3.7 steps 3 and 8, §4.2, §4.3).
 *
 * Frames: `[ethernet {dst SLOW_PROTOCOLS_MAC, src <port MAC>, type 0x8809}, lacp {actor…, partner…}]`, meta
 * `{tag:'lacp', background:true}`. The actor system is the switch's base MAC (the MAC every virtual port carries,
 * `portMac(base, 0)`), the key is the channel group, the port number is the member's `ordinal`; priorities are the
 * fixed default 32768. The partner block repeats what the actor last heard (zeros when it heard nothing).
 *
 * Actor state (802.1AX bits, `LACP_STATE_*` of the codec):
 *   activity    set for `mode active` (the member speaks first);
 *   timeout     clear (long timeout: the partner ages after 90 s);
 *   aggregation set always (every NF member may aggregate);
 *   sync        set while the member is selected for its bundle — it has a channel group, its link is up and it is
 *               not `suspended` (an incompatible member tells its partner so);
 *   collecting, distributing   set while the member is `bundled`;
 *   defaulted   set while no partner is known; expired never.
 * A member bundles on a partner whose sync bit is set (§3.7 step 3); the other bits are recorded and shown only.
 *
 * Timers (§4.2; keys are `<kind>:<port>`):
 *   lacp-fast:<port>  non-periodic, 1 s, at most 3 tries — the initial burst of an `active` member (send at link-up,
 *                     then once per second; after the third unanswered LACPDU, at link-up + 3 s, the member is
 *                     `individual`, reason `no LACP partner`);
 *   lacp-wait:<port>  non-periodic, 3 s — a `passive` member that heard nothing by then is `individual`;
 *   lacp-tx:<port>    periodic, 30 s — the steady LACPDU of an `active` member (bundled or individual, so a partner
 *                     configured later is found);
 *   lacp-age:<port>   periodic flag, 90 s, re-armed on every LACPDU received — partner information expires.
 * A `passive` member never runs lacp-tx: it answers every LACPDU it receives with one of its own (and sends one when
 * its own state changes while it knows a partner), which is what keeps its active partner's ageing timer armed.
 *
 * No randomness (§4.1). Pure helpers: no state, no I/O, no clock.
 */
import type { MacAddress } from '../../contracts/addr.js';
import { MAC_ZERO, normalizeMac } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import { ETHERTYPE_SLOW_PROTOCOLS, SLOW_PROTOCOLS_MAC } from '../../contracts/pdu.js';
import type { LayerSpec, PduView } from '../../contracts/pdu.js';
import type { PortView } from '../../contracts/port.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import {
  LACP_STATE_ACTIVITY,
  LACP_STATE_AGGREGATION,
  LACP_STATE_COLLECTING,
  LACP_STATE_DEFAULTED,
  LACP_STATE_DISTRIBUTING,
  LACP_STATE_SYNC,
} from '../../pdu/codecs/lacp.js';

/** `PduMeta.tag` of every LACPDU. */
export const LACP_TAG = 'lacp';
/** Fixed system and port priorities of every NF actor. */
export const LACP_SYSTEM_PRIORITY = 32768;
export const LACP_PORT_PRIORITY = 32768;
/** Initial burst of an active member: one LACPDU per second, at most this many. */
export const LACP_FAST_INTERVAL_NS: SimTime = 1 * SEC;
export const LACP_FAST_TRIES = 3;
/** How long a passive member waits for a first LACPDU before running individual. */
export const LACP_WAIT_NS: SimTime = 3 * SEC;
/** Steady LACPDU interval (long timeout). */
export const LACP_TX_INTERVAL_NS: SimTime = 30 * SEC;
/** Partner information expires this long after the last LACPDU heard. */
export const LACP_AGE_NS: SimTime = 90 * SEC;

/** Timer key prefixes (§4.2). */
export const LACP_TIMER_FAST = 'lacp-fast';
export const LACP_TIMER_WAIT = 'lacp-wait';
export const LACP_TIMER_TX = 'lacp-tx';
export const LACP_TIMER_AGE = 'lacp-age';
export type LacpTimerKind = typeof LACP_TIMER_FAST | typeof LACP_TIMER_WAIT | typeof LACP_TIMER_TX | typeof LACP_TIMER_AGE;
const LACP_TIMER_KINDS: readonly LacpTimerKind[] = Object.freeze([LACP_TIMER_FAST, LACP_TIMER_WAIT, LACP_TIMER_TX, LACP_TIMER_AGE]);

/** `<kind>:<port>`. */
export function lacpTimerKey(kind: LacpTimerKind, port: PortId): string {
  return `${kind}:${port}`;
}

/** The kind and port of an LACP timer key, else undefined. */
export function parseLacpTimerKey(key: string): { readonly kind: LacpTimerKind; readonly port: PortId } | undefined {
  const at = key.indexOf(':');
  if (at < 0) return undefined;
  const kind = key.slice(0, at) as LacpTimerKind;
  if (!LACP_TIMER_KINDS.includes(kind)) return undefined;
  const port = key.slice(at + 1);
  return port === '' ? undefined : { kind, port };
}

/** What a member knows of its LACP partner (the actor block of the last LACPDU heard). */
export interface LacpPartner {
  readonly system: MacAddress;
  readonly systemPriority: number;
  readonly key: number;
  readonly port: number;
  readonly portPriority: number;
  readonly state: number;
}

/** Inputs of the actor state bits. */
export interface LacpActorFacts {
  /** `mode active`. */
  readonly active: boolean;
  /** Selected for the bundle: link up and not suspended. */
  readonly sync: boolean;
  /** Currently `bundled`. */
  readonly bundled: boolean;
  /** A partner is known. */
  readonly partnerKnown: boolean;
}

/** The actor state byte of an LACPDU for `facts` (see the file header). */
export function lacpActorState(facts: LacpActorFacts): number {
  let s = LACP_STATE_AGGREGATION;
  if (facts.active) s |= LACP_STATE_ACTIVITY;
  if (facts.sync) s |= LACP_STATE_SYNC;
  if (facts.bundled) s |= LACP_STATE_COLLECTING | LACP_STATE_DISTRIBUTING;
  if (!facts.partnerKnown) s |= LACP_STATE_DEFAULTED;
  return s;
}

/** True when a partner state byte carries the sync bit (the partner is selected for its bundle, §3.7 step 3). */
export function partnerInSync(state: number): boolean {
  return (state & LACP_STATE_SYNC) !== 0;
}

/**
 * The switch's base MAC as the LACP system id: the MAC of a virtual port (ordinal 0 = `portMac(base, 0)`), else the
 * first port's MAC with its ordinal octet cleared (every NF port MAC is `02:b3:b2:b1:b0:<ordinal>`, D8).
 */
export function lacpSystemMac(ports: ReadonlyMap<PortId, PortView>): MacAddress {
  for (const p of ports.values()) if (p.ordinal === 0) return p.mac;
  for (const p of ports.values()) return `${p.mac.slice(0, 15)}00`;
  return MAC_ZERO;
}

/** What an LACPDU is built from. */
export interface LacpduInputs {
  readonly srcMac: MacAddress;
  readonly system: MacAddress;
  readonly key: number;
  readonly portNumber: number;
  readonly state: number;
  readonly partner?: LacpPartner;
}

/** The layer specs of an LACPDU (§3.7 step 3). */
export function lacpduLayers(i: LacpduInputs): LayerSpec[] {
  const partner = i.partner;
  return [
    { proto: 'ethernet', fields: { dst: SLOW_PROTOCOLS_MAC, src: i.srcMac, type: ETHERTYPE_SLOW_PROTOCOLS } },
    {
      proto: 'lacp',
      fields: {
        actorSystemPriority: LACP_SYSTEM_PRIORITY,
        actorSystem: i.system,
        actorKey: i.key,
        actorPortPriority: LACP_PORT_PRIORITY,
        actorPort: i.portNumber,
        actorState: i.state,
        partnerSystemPriority: partner?.systemPriority ?? 0,
        partnerSystem: partner?.system ?? MAC_ZERO,
        partnerKey: partner?.key ?? 0,
        partnerPortPriority: partner?.portPriority ?? 0,
        partnerPort: partner?.port ?? 0,
        partnerState: partner?.state ?? 0,
      },
    },
  ];
}

/** The `lacp` layer of a frame, if any. */
export function lacpLayerOf(frame: Pick<PduView, 'layers'>): PduView['layers'][number] | undefined {
  for (const l of frame.layers) if (l.proto === 'lacp') return l;
  return undefined;
}

/** The partner a received LACPDU describes (its actor block), or undefined when the frame carries no valid LACP layer. */
export function readLacpPartner(frame: Pick<PduView, 'layers'>): LacpPartner | undefined {
  const l = lacpLayerOf(frame);
  if (l === undefined || l.error !== undefined) return undefined;
  const f = l.fields;
  const system = typeof f.actorSystem === 'string' ? normalizeMac(f.actorSystem) : null;
  if (system === null) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    system,
    systemPriority: num(f.actorSystemPriority),
    key: num(f.actorKey),
    port: num(f.actorPort),
    portPriority: num(f.actorPortPriority),
    state: num(f.actorState),
  };
}
