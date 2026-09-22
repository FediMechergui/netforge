/**
 * Timeline lane vocabulary [SHOULD S1] (ARCHITECTURE-P2 §2.13, §6): the label, glyph, colour and tooltip of every lane
 * of the timeline strip. The engine decides which lane an event belongs to (`laneOf`, timeline/lanes.ts); this table
 * only words and marks the lanes.
 *
 * `LANE_VOCAB` is typed `Record<LaneId, …>`, so a new engine lane is a compile error here until it has wording. Every
 * lane has a non-colour channel: a glyph unique across lanes, drawn on each of its marks (the colour only repeats it).
 * Display order is the order of this table, which is also the engine's canonical lane order (`LANE_IDS`).
 * All wording is original (§1.6).
 */
import type { LaneId } from '@netforge/engine';
import type { ColorToken } from './protocols.js';

/** Presentation data for one timeline lane. */
export interface LaneVocab {
  readonly lane: LaneId;
  /** Row label. */
  readonly label: string;
  /** Short glyph drawn on the lane's marks; unique across lanes (the non-colour channel). */
  readonly glyph: string;
  /** Theme colour of the lane's marks. */
  readonly color: ColorToken;
  /** Tooltip sentence. */
  readonly hint: string;
}

function lane(id: LaneId, label: string, glyph: string, color: ColorToken, hint: string): LaneVocab {
  return Object.freeze({ lane: id, label, glyph, color, hint });
}

/** Every timeline lane in display order, exhaustive over `LaneId`. */
export const LANE_VOCAB: Readonly<Record<LaneId, LaneVocab>> = Object.freeze({
  link: lane('link', 'Links and ports', 'L', 'accent', 'A cable or a port went up or down.'),
  stp: lane('stp', 'Spanning tree', 'ST', 'warn', 'A spanning-tree port changed role or state, or a bridge saw a topology change.'),
  etherchannel: lane('etherchannel', 'Bundles', 'EC', 'purple', 'A link joined, left or was refused by a bundle of parallel links.'),
  vlan: lane('vlan', 'VLANs and trunks', 'V', 'yellow', 'A VLAN was created or removed, or a trunk negotiation changed.'),
  fhrp: lane('fhrp', 'Gateway redundancy', 'GW', 'ok', 'A standby group changed its active or standby router.'),
  routing: lane('routing', 'Routes', 'R', 'ok', 'A route was installed or removed.'),
  nat: lane('nat', 'Address translation', 'NT', 'accent', 'A translation was created or expired.'),
  dhcp: lane('dhcp', 'Address leases', 'DH', 'yellow', 'An address lease was offered, bound or ended.'),
  wireless: lane('wireless', 'Wireless', 'W', 'blueDeep', 'An access point, a controller link or a wireless client changed.'),
  security: lane('security', 'Port security', 'PS', 'err', 'A secured port learned an address, saw a violation or was error-disabled.'),
  config: lane('config', 'Configuration', 'C', 'textDim', 'A configuration line was set or removed.'),
  drops: lane('drops', 'Drops', 'X', 'err', 'A packet was discarded.'),
});

/** Every lane in display order. */
export const LANE_ORDER: readonly LaneId[] = Object.freeze(Object.keys(LANE_VOCAB) as LaneId[]);

/** True when `id` names a timeline lane. */
export function isLaneId(id: string): id is LaneId {
  return Object.prototype.hasOwnProperty.call(LANE_VOCAB, id);
}

/** Vocabulary entry of a lane, or undefined for an unknown name. */
export function laneVocab(id: string): LaneVocab | undefined {
  return isLaneId(id) ? LANE_VOCAB[id] : undefined;
}

/** Row label of a lane (the raw name when unknown). */
export function laneLabel(id: string): string {
  return laneVocab(id)?.label ?? id;
}
