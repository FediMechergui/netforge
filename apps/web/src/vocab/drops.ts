/**
 * Drop vocabulary: the floating tag, the full sentence, a category and a remedy hint for every engine drop
 * reason (ARCHITECTURE-P1 §7; merges the P0 `markers.DROP_REASON_TEXT` and `Provenance.DROP_LABEL`
 * wordings into one table), plus the wording of frame-abort reasons.
 *
 * `DROP_VOCAB` is typed `Record<DropReason, …>`, so a new engine drop reason is a compile error here until
 * it has wording. All wording is original (§1.6).
 */
import type { DropReason, TraceEvent } from '@netforge/engine';

/** Broad cause of a drop (event filters and marker grouping). */
export type DropCategory = 'physical' | 'link' | 'wireless' | 'network' | 'policy' | 'device';

/** Presentation data for one drop reason. */
export interface DropVocab {
  readonly reason: DropReason;
  /** Floating tag on the canvas (short). */
  readonly tag: string;
  /** Sentence for the provenance timeline and the events list. */
  readonly label: string;
  readonly category: DropCategory;
  /** What a learner can try. */
  readonly hint: string;
}

function drop(reason: DropReason, tag: string, label: string, category: DropCategory, hint: string): DropVocab {
  return Object.freeze({ reason, tag, label, category, hint });
}

/** Every drop reason, exhaustive over `DropReason`. */
export const DROP_VOCAB: Readonly<Record<DropReason, DropVocab>> = Object.freeze({
  'link-down': drop('link-down', 'link is down', 'The link was down when the frame needed it', 'physical',
    'Check the cable, the shutdown state of both ports and the power of both devices.'),
  'link-loss': drop('link-loss', 'lost on the wire', 'Lost in transit because of the loss setting on the cable', 'physical',
    'Lower the loss impairment on the cable.'),
  'fcs-error': drop('fcs-error', 'damaged frame (FCS)', 'The frame check sequence did not match: bits were damaged in transit', 'physical',
    'Lower the corruption setting or look for a duplex problem on the link.'),
  runt: drop('runt', 'frame too short', 'Shorter than the 64-byte minimum, usually a collision fragment', 'physical',
    'Look for collisions or a duplex mismatch on this segment.'),
  giant: drop('giant', 'frame too long', 'Longer than the interface MTU allows', 'link',
    'Compare the MTU settings at both ends.'),
  'port-admin-down': drop('port-admin-down', 'port not accepting', 'Arrived on an interface that is administratively shut down', 'device',
    'Bring the interface up with "no shutdown" or from the port panel.'),
  'port-err-disabled': drop('port-err-disabled', 'port error-disabled', 'Arrived on an interface disabled by a protection feature', 'device',
    'Reset the interface to clear its error state.'),
  'queue-full': drop('queue-full', 'queue overflow', 'The transmit queue was full, so the frame was discarded', 'link',
    'Send less traffic or use a faster link.'),
  'no-route': drop('no-route', 'no route', 'No routing table entry matched the destination', 'network',
    'Add a route or a default gateway that covers this destination.'),
  'ttl-expired': drop('ttl-expired', 'TTL ran out', 'The time-to-live reached zero before the destination', 'network',
    'Look for a routing loop along the path.'),
  'arp-unresolved': drop('arp-unresolved', 'no ARP answer', 'The next hop never answered the ARP request', 'network',
    'Make sure the next hop is powered, up and in the same subnet.'),
  'not-for-me': drop('not-for-me', 'not addressed here', 'The destination MAC belongs to another device, so this interface ignored it', 'link',
    'Normal on shared media such as hubs; nothing needs fixing.'),
  'unsupported-ethertype': drop('unsupported-ethertype', 'unknown EtherType', 'No process on this device handles that frame type', 'link',
    'This device does not run the protocol the frame carries.'),
  'unsupported-protocol': drop('unsupported-protocol', 'no handler for protocol', 'No process on this device handles that upper-layer protocol or port', 'network',
    'Nothing on this device is listening for that protocol or port.'),
  'bad-checksum': drop('bad-checksum', 'bad checksum', 'A header checksum did not match its contents', 'network',
    'Look for corruption earlier on the path.'),
  'no-l3-address': drop('no-l3-address', 'no IP address', 'The outgoing interface has no IP address to send from', 'network',
    'Give the outgoing interface an address.'),
  'acl-deny': drop('acl-deny', 'blocked by a filter', 'A traffic filter on this device refused the packet', 'policy',
    'Review the filter rules configured on this device.'),
  other: drop('other', 'discarded', 'Discarded for the reason given in the detail line', 'device',
    'Read the detail text for the rule that applied.'),
  collision: drop('collision', 'collided on the shared wire', 'Hit by a collision while it was being received on a half-duplex segment', 'physical',
    'Expected on busy hubs; a switch gives each port its own collision domain.'),
  'late-collision': drop('late-collision', 'late collision', 'A collision was detected after the first 64 bytes, so the sender did not retry', 'physical',
    'Usually a duplex mismatch or a segment that is too long.'),
  'excessive-collisions': drop('excessive-collisions', 'gave up after 16 collisions', 'The sender collided 16 times in a row and abandoned the frame', 'physical',
    'The segment is overloaded; split it with a switch.'),
  'out-of-range': drop('out-of-range', 'out of radio range', 'The receiver was beyond the radio range of the sender', 'wireless',
    'Move the devices closer together or raise the transmit power.'),
  'not-associated': drop('not-associated', 'not joined to the access point', 'The wireless station had no authorised association', 'wireless',
    'Check the network name, security mode and passphrase on the station.'),
  'encapsulation-mismatch': drop('encapsulation-mismatch', 'line encapsulations differ', 'The two ends of the serial line use different encapsulations', 'link',
    'Set the same encapsulation on both ends.'),
  'out-of-band': drop('out-of-band', 'console cables carry no data', 'Console cables carry terminal sessions only, never network frames', 'link',
    'Use an Ethernet cable for network traffic.'),
});

/** Every drop reason in table order. */
export const DROP_REASONS: readonly DropReason[] = Object.freeze(Object.keys(DROP_VOCAB) as DropReason[]);

/** Human names of the drop categories. */
export const DROP_CATEGORY_LABELS: Readonly<Record<DropCategory, string>> = Object.freeze({
  physical: 'Physical',
  link: 'Link',
  wireless: 'Wireless',
  network: 'Network',
  policy: 'Policy',
  device: 'Device',
});

/** Longest detail line a drop marker shows before clipping. */
export const DROP_DETAIL_MAX = 44;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** True when `reason` is a known drop reason. */
export function isDropReason(reason: string): reason is DropReason {
  return Object.prototype.hasOwnProperty.call(DROP_VOCAB, reason);
}

/**
 * Title and detail line of a drop marker. A drop with reason `other` and a detail shows the detail as its
 * title; unknown reasons show the raw code.
 */
export function dropTag(reason: string, detail?: string): { title: string; detail: string } {
  if (reason === 'other' && detail) return { title: clip(detail, DROP_DETAIL_MAX), detail: '' };
  const title = isDropReason(reason) ? DROP_VOCAB[reason].tag : reason;
  return { title, detail: detail ? clip(detail, DROP_DETAIL_MAX) : '' };
}

/** Sentence for a drop reason (the raw code when unknown). */
export function dropLabel(reason: string): string {
  return isDropReason(reason) ? DROP_VOCAB[reason].label : reason;
}

/** Reasons a frame leg can be cut short. */
export type FrameAbortReason = Extract<TraceEvent, { kind: 'frameAbort' }>['reason'];

/** Wording of frame-abort reasons, exhaustive over the engine union. */
export const FRAME_ABORT_TEXT: Readonly<Record<FrameAbortReason, string>> = Object.freeze({
  collision: 'cut short by a collision',
  'late-collision': 'cut short by a late collision',
  'link-down': 'cut short because the link went down',
  'out-of-range': 'cut short because the receiver left radio range',
  'not-associated': 'cut short because the station left the wireless network',
});
