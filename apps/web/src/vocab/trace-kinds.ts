/**
 * Trace-kind vocabulary: chip labels, tooltips, groups and default visibility for every engine trace event
 * kind (ARCHITECTURE-P1 §7; replaces the hand-maintained P0 `DockPanels.ALL_KINDS` list), plus the wording
 * of association phases, port-state reasons and segment changes that those events carry.
 *
 * Tables are typed `Record<TraceKind, …>` / `Record<WifiAssocState, …>`, so engine additions are compile
 * errors here. Association phases carry a lettered badge as their non-colour channel (§7). All wording is
 * original (§1.6).
 */
import type { CellAttachState, TraceKind, WifiAssocState } from '@netforge/engine';

/** Group of related trace kinds (filter chip rows). */
export type TraceKindGroup = 'packets' | 'media' | 'tables' | 'state' | 'cli' | 'diagnostics';

/** Presentation data for one trace kind. */
export interface TraceKindVocab {
  readonly kind: TraceKind;
  /** Chip label. */
  readonly label: string;
  /** Tooltip sentence. */
  readonly help: string;
  readonly group: TraceKindGroup;
  /** Hidden in the events list until the learner turns it on. */
  readonly hiddenByDefault: boolean;
}

function kind(k: TraceKind, label: string, group: TraceKindGroup, help: string, hiddenByDefault = false): TraceKindVocab {
  return Object.freeze({ kind: k, label, help, group, hiddenByDefault });
}

/** Every trace kind in display order, exhaustive over `TraceKind`. */
export const TRACE_KIND_VOCAB: Readonly<Record<TraceKind, TraceKindVocab>> = Object.freeze({
  frameTx: kind('frameTx', 'Sent', 'packets', 'A frame started out of a port onto a cable or the air.'),
  frameRx: kind('frameRx', 'Received', 'packets', 'A frame fully arrived at a port.'),
  frameAbort: kind('frameAbort', 'Cut short', 'packets', 'A frame stopped part-way along its medium.'),
  drop: kind('drop', 'Dropped', 'packets', 'A packet was discarded, with the reason.'),
  pduCreated: kind('pduCreated', 'Created', 'packets', 'A device process built a new packet.'),
  pduConsumed: kind('pduConsumed', 'Accepted', 'packets', 'A packet reached the process it was meant for.'),
  mutation: kind('mutation', 'Header change', 'packets', 'A header field was rewritten, with the cause.'),
  collision: kind('collision', 'Collision', 'media', 'Two transmissions overlapped on a shared segment.'),
  backoff: kind('backoff', 'Backoff', 'media', 'A sender waits a random number of slots after a collision.'),
  carrierDefer: kind('carrierDefer', 'Deferred', 'media', 'A sender waited because the shared wire was busy.'),
  phyNegotiated: kind('phyNegotiated', 'Negotiated', 'media', 'The speed and duplex of a cable were settled.'),
  segmentChanged: kind('segmentChanged', 'Segment', 'media', 'A shared collision domain formed, changed or dissolved.'),
  assocState: kind('assocState', 'Association', 'media', 'A wireless or mobile connection moved to a new phase.'),
  rfState: kind('rfState', 'Signal', 'media', 'Signal bars or data rate of a radio connection changed.'),
  tableWrite: kind('tableWrite', 'Table write', 'tables', 'A row was added to or refreshed in a device table.'),
  tableExpire: kind('tableExpire', 'Table expiry', 'tables', 'A row left a device table.'),
  linkState: kind('linkState', 'Link', 'state', 'A link came up or went down.'),
  portState: kind('portState', 'Port', 'state', 'The administrative or operational state of a port changed.'),
  deviceState: kind('deviceState', 'Device', 'state', 'A device was powered or finished starting.'),
  configChange: kind('configChange', 'Config', 'state', 'A configuration line was set or removed.'),
  topologyChanged: kind('topologyChanged', 'Topology', 'state', 'A device, link or module was added, removed or moved.'),
  cliOutput: kind('cliOutput', 'Terminal output', 'cli', 'Text printed to a terminal session.'),
  cliPrompt: kind('cliPrompt', 'Prompt', 'cli', 'A terminal session showed its prompt.', true),
  debug: kind('debug', 'Debug', 'diagnostics', 'A protocol process reported a step of its state machine.'),
  log: kind('log', 'Log', 'diagnostics', 'A device wrote a system log message.'),
});

/** Every trace kind in display order. */
export const TRACE_KINDS: readonly TraceKind[] = Object.freeze(Object.keys(TRACE_KIND_VOCAB) as TraceKind[]);

/** Group order and names. */
export const TRACE_KIND_GROUP_LABELS: Readonly<Record<TraceKindGroup, string>> = Object.freeze({
  packets: 'Packets',
  media: 'Media',
  tables: 'Tables',
  state: 'State',
  cli: 'Terminal',
  diagnostics: 'Diagnostics',
});

/** Kinds hidden by default in the events list. */
export const DEFAULT_HIDDEN_TRACE_KINDS: readonly TraceKind[] = Object.freeze(TRACE_KINDS.filter((k) => TRACE_KIND_VOCAB[k].hiddenByDefault));

/** Default list filter of simulation mode (ARCHITECTURE-P1 §4.11). */
export const SIM_MODE_LIST_KINDS: readonly TraceKind[] = Object.freeze(['frameTx', 'drop', 'tableWrite'] as const);

/** True when `k` names a trace kind. */
export function isTraceKind(k: string): k is TraceKind {
  return Object.prototype.hasOwnProperty.call(TRACE_KIND_VOCAB, k);
}

/** Chip label of a trace kind (the raw name when unknown). */
export function traceKindLabel(k: string): string {
  return isTraceKind(k) ? TRACE_KIND_VOCAB[k].label : k;
}

/** Trace kinds of one group, in display order. */
export function traceKindsInGroup(group: TraceKindGroup): readonly TraceKind[] {
  return TRACE_KINDS.filter((k) => TRACE_KIND_VOCAB[k].group === group);
}

// ── association phases ───────────────────────────────────────────────────────

/** Presentation of one association or attach phase. */
export interface AssocStateVocab {
  readonly label: string;
  /** Lettered badge drawn on association lines; unique within its technology. */
  readonly badge: string;
  /** The phase is an end state (connected, failed or idle). */
  readonly settled: boolean;
}

function phase(label: string, badge: string, settled: boolean): AssocStateVocab {
  return Object.freeze({ label, badge, settled });
}

/** Wi-Fi station phases, exhaustive over `WifiAssocState`. */
export const WIFI_ASSOC_STATE_VOCAB: Readonly<Record<WifiAssocState, AssocStateVocab>> = Object.freeze({
  idle: phase('idle', '–', true),
  scanning: phase('looking for networks', 'Sc', false),
  authenticating: phase('authenticating', 'Au', false),
  associating: phase('joining', 'As', false),
  handshake: phase('exchanging keys', '4W', false),
  associated: phase('connected', '✓', true),
  failed: phase('could not connect', '✗', true),
});

/** Cellular attach phases, exhaustive over `CellAttachState`. */
export const CELL_ATTACH_STATE_VOCAB: Readonly<Record<CellAttachState, AssocStateVocab>> = Object.freeze({
  idle: phase('idle', '–', true),
  searching: phase('searching for a tower', 'Se', false),
  attaching: phase('attaching', 'At', false),
  attached: phase('attached', '✓', true),
  detached: phase('detached', '✗', true),
});

/** Presentation of a phase for a technology (undefined when the state is not in that technology). */
export function assocStateVocab(tech: 'wifi' | 'cellular', state: string): AssocStateVocab | undefined {
  const table: Readonly<Record<string, AssocStateVocab>> = tech === 'wifi' ? WIFI_ASSOC_STATE_VOCAB : CELL_ATTACH_STATE_VOCAB;
  return Object.prototype.hasOwnProperty.call(table, state) ? table[state] : undefined;
}

// ── port-state reasons and segment changes ──────────────────────────────────

/** Wording of the `portState.reason` values the engine documents. */
export const PORT_STATE_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'role-change': 'switched between switching and routing',
  'virtual-created': 'virtual interface created',
  'virtual-removed': 'virtual interface removed',
  'no-clock': 'no clock on the serial line',
  'keepalive-missed': 'keepalives stopped arriving',
  associated: 'joined a wireless network',
  disassociated: 'left a wireless network',
});

/** Wording of a port-state reason (the raw value when unknown, empty when absent). */
export function portStateReasonText(reason: string | undefined): string {
  if (reason === undefined) return '';
  return Object.prototype.hasOwnProperty.call(PORT_STATE_REASON_TEXT, reason) ? (PORT_STATE_REASON_TEXT[reason] as string) : reason;
}

/** Wording of `segmentChanged.op`. */
export const SEGMENT_OP_TEXT: Readonly<Record<'formed' | 'changed' | 'dissolved', string>> = Object.freeze({
  formed: 'shared segment formed',
  changed: 'shared segment changed',
  dissolved: 'shared segment dissolved',
});
