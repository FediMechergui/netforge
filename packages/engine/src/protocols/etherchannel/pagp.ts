/**
 * protocols/etherchannel/pagp.ts — the PAgP half of the EtherChannel daemon [SHOULD S3] (ARCHITECTURE-P2 D8, §2.3,
 * §2.4 control table, §3.7, §4.3): message construction and reading, the timer keys and intervals.
 *
 * Frames: `[ethernet {dst NF_L2_CONTROL_MAC, src <port MAC>}, llc {SNAP, oui NF_OUI, type NF_PID_PAGP}, pagp {…}]`
 * (802.3 length filled by the codec chain), meta `{tag:'pagp', background:true}`. The device id is the switch's
 * base MAC, the port number the member's `ordinal`, the group the channel group; the partner fields repeat what the
 * sender last heard (zeros when nothing).
 *
 * `desirable` initiates (like LACP `active`), `auto` answers only (like `passive`). A member bundles on the first
 * message heard from a partner (PAgP carries no sync bit; the partner's device and group must match the rest of the
 * bundle, and the member must be compatible, compat.ts). Timers mirror LACP's (§4.2 names only the LACP keys; the
 * PAgP keys follow the same pattern): `pagp-fast:<port>` (1 s, ≤ 3 tries, non-periodic), `pagp-wait:<port>` (3 s,
 * non-periodic), `pagp-tx:<port>` (30 s, periodic), `pagp-age:<port>` (90 s, periodic flag, re-armed per message).
 * An `auto` member that heard nothing for 3 s, or a `desirable` member after its third unanswered message, is
 * `individual` with reason `no PAgP partner`.
 *
 * No randomness (§4.1). Pure helpers: no state, no I/O, no clock.
 */
import type { MacAddress } from '../../contracts/addr.js';
import { MAC_ZERO, normalizeMac } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_PAGP } from '../../contracts/pdu.js';
import type { LayerSpec, PduView } from '../../contracts/pdu.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { PAGP_MODE_AUTO, PAGP_MODE_DESIRABLE } from '../../pdu/codecs/pagp.js';

/** `PduMeta.tag` of every PAgP message. */
export const PAGP_TAG = 'pagp';
/** Initial burst of a desirable member: one message per second, at most this many. */
export const PAGP_FAST_INTERVAL_NS: SimTime = 1 * SEC;
export const PAGP_FAST_TRIES = 3;
/** How long an auto member waits for a first message before running individual. */
export const PAGP_WAIT_NS: SimTime = 3 * SEC;
/** Steady message interval. */
export const PAGP_TX_INTERVAL_NS: SimTime = 30 * SEC;
/** Partner information expires this long after the last message heard. */
export const PAGP_AGE_NS: SimTime = 90 * SEC;

/** Timer key prefixes. */
export const PAGP_TIMER_FAST = 'pagp-fast';
export const PAGP_TIMER_WAIT = 'pagp-wait';
export const PAGP_TIMER_TX = 'pagp-tx';
export const PAGP_TIMER_AGE = 'pagp-age';
export type PagpTimerKind = typeof PAGP_TIMER_FAST | typeof PAGP_TIMER_WAIT | typeof PAGP_TIMER_TX | typeof PAGP_TIMER_AGE;
const PAGP_TIMER_KINDS: readonly PagpTimerKind[] = Object.freeze([PAGP_TIMER_FAST, PAGP_TIMER_WAIT, PAGP_TIMER_TX, PAGP_TIMER_AGE]);

/** `<kind>:<port>`. */
export function pagpTimerKey(kind: PagpTimerKind, port: PortId): string {
  return `${kind}:${port}`;
}

/** The kind and port of a PAgP timer key, else undefined. */
export function parsePagpTimerKey(key: string): { readonly kind: PagpTimerKind; readonly port: PortId } | undefined {
  const at = key.indexOf(':');
  if (at < 0) return undefined;
  const kind = key.slice(0, at) as PagpTimerKind;
  if (!PAGP_TIMER_KINDS.includes(kind)) return undefined;
  const port = key.slice(at + 1);
  return port === '' ? undefined : { kind, port };
}

/** What a member knows of its PAgP partner (the sender fields of the last message heard). */
export interface PagpPartner {
  readonly device: MacAddress;
  readonly port: number;
  readonly group: number;
  /** 1 desirable, 2 auto. */
  readonly mode: number;
}

/** The `mode` field value of a channel mode (`desirable` → 1, `auto` → 2). */
export function pagpModeValue(mode: 'desirable' | 'auto'): number {
  return mode === 'desirable' ? PAGP_MODE_DESIRABLE : PAGP_MODE_AUTO;
}

/** What a PAgP message is built from. */
export interface PagpInputs {
  readonly srcMac: MacAddress;
  readonly device: MacAddress;
  readonly portNumber: number;
  readonly group: number;
  readonly mode: 'desirable' | 'auto';
  readonly partner?: PagpPartner;
}

/** The layer specs of a PAgP message (NF format, D8). */
export function pagpLayers(i: PagpInputs): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: i.srcMac } },
    { proto: 'llc', fields: { oui: NF_OUI, type: NF_PID_PAGP } },
    {
      proto: 'pagp',
      fields: {
        mode: pagpModeValue(i.mode),
        device: i.device,
        port: i.portNumber,
        group: i.group,
        partnerDevice: i.partner?.device ?? MAC_ZERO,
        partnerPort: i.partner?.port ?? 0,
      },
    },
  ];
}

/** The `pagp` layer of a frame, if any. */
export function pagpLayerOf(frame: Pick<PduView, 'layers'>): PduView['layers'][number] | undefined {
  for (const l of frame.layers) if (l.proto === 'pagp') return l;
  return undefined;
}

/** The partner a received message describes (its sender fields), or undefined when the frame carries no valid pagp layer. */
export function readPagpPartner(frame: Pick<PduView, 'layers'>): PagpPartner | undefined {
  const l = pagpLayerOf(frame);
  if (l === undefined || l.error !== undefined) return undefined;
  const f = l.fields;
  const device = typeof f.device === 'string' ? normalizeMac(f.device) : null;
  if (device === null) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return { device, port: num(f.port), group: num(f.group), mode: num(f.mode) };
}
