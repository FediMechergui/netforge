/**
 * simmode/sim-events-client.ts — the pure layer under the simulation-mode event list (ARCHITECTURE-P1 §4.11,
 * §7 "Sim-mode list"): chips → `TraceFilter`, the `traceQuery` paging window that keeps thousands of events out of
 * the panel, the breakpoint presets, the virtual-row arithmetic, row activation and the wording of a stop.
 *
 * No React and no engine call lives here, so `test/sim-events-client.test.ts` (§10.2 "Web P1") drives it directly.
 *
 * Filter rules are trace/filter.ts': present keys AND, array members OR, and A PRESENT EMPTY ARRAY MATCHES NOTHING
 * — `buildTraceFilter` therefore omits every empty group. `includeBackground` is always written, so an unchanged
 * default produces exactly the §4.11 shape `{kinds:['frameTx','drop','tableWrite'], includeBackground:false}`.
 * P2 (ARCHITECTURE-P2 §2.7, §6): the background filter covers DROPS as well as frames — a `drop` flagged
 * `background` (a BPDU a host discards, a keepalive) is a background event (`isBackgroundEvent`), and the engine's
 * `traceQuery` leaves it out unless `includeBackground` is true, so an idle switched world lists nothing by default.
 *
 * ponytail: one ascending window of rows, trimmed at whichever end the reader is moving away from, instead of a
 * sparse cursor index — the list can only ever scroll to rows next to the ones it already holds. A backward trim
 * repairs `next` to the last retained cursor, so forward paging just refetches what it dropped. `eventText`
 * assembles its own sentences rather than importing the P0 dock description, whose module chain reaches the
 * terminal: every semantic word still comes from `vocab/*`, so there is one vocabulary and two sentence shapes.
 */
import type {
  DeviceId,
  PortRef,
  ProtoName,
  Selection,
  TraceEvent,
  TraceFilter,
  TraceKind,
  TraceQuery,
  TraceQueryResult,
} from '@netforge/engine';
import { SIM_STEP_HORIZON_NS, SIM_STEP_MAX_EVENTS, type RunStopResult, type StopInfo } from '../bridge/protocol';
import { FRAME_ABORT_TEXT, dropLabel } from '../vocab/drops';
import { formatSignal, mutationVocab } from '../vocab/fields';
import { protocolLabel } from '../vocab/protocols';
import {
  SEGMENT_OP_TEXT,
  SIM_MODE_LIST_KINDS,
  assocStateVocab,
  isTraceKind,
  portStateReasonText,
  traceKindLabel,
} from '../vocab/trace-kinds';

// ── sizes ───────────────────────────────────────────────────────────────────

/** Rows asked for per `traceQuery` (§4.11 item 5). */
export const SIM_EVENTS_PAGE = 500;
/** Rows kept in the panel; older or newer ones are refetched when the reader scrolls back to them. */
export const SIM_EVENTS_MAX_ROWS = 2000;
/** Row height in CSS pixels — the virtual list needs every row to be the same height. */
export const SIM_EVENTS_ROW_H = 22;
/** Rows rendered beyond each edge of the viewport. */
export const SIM_EVENTS_OVERSCAN = 8;
/** Shortest wall gap between incremental queries (§4.11 item 5: at most 4 Hz). */
export const SIM_EVENTS_QUERY_MS = 250;
/** Sim window one "run to the breakpoint" covers (60 s), so a quiet lab cannot run away. */
export const SIM_RUN_HORIZON_NS = 60_000_000_000;

// ── chips ───────────────────────────────────────────────────────────────────

/** The chip rows a learner can compose; each maps to one `TraceFilter` key. */
export type ChipGroup = 'kinds' | 'protos' | 'devices' | 'tags';

/** Chip rows in display order. */
export const CHIP_GROUPS: readonly ChipGroup[] = Object.freeze(['kinds', 'protos', 'devices', 'tags'] as const);

/** Row headings (original wording). */
export const CHIP_GROUP_LABELS: Readonly<Record<ChipGroup, string>> = Object.freeze({
  kinds: 'Event kind',
  protos: 'Protocol',
  devices: 'Device',
  tags: 'Message',
});

/** What the chips of one filter are switched on to. Empty group = that key is left out (it matches everything). */
export interface ChipSelection {
  readonly kinds: readonly TraceKind[];
  readonly protos: readonly ProtoName[];
  readonly devices: readonly DeviceId[];
  readonly tags: readonly string[];
  /** Let background traffic through (`TraceFilter.includeBackground`): keepalives and beacons, and (P2) their drops. */
  readonly background: boolean;
}

/**
 * @since P2 True for an event the background filter hides: a `frameTx` of a keepalive or beacon, or (§2.7) a `drop`
 * of a background PDU (a BPDU discarded by a host, a hello nobody joined). Every other event is foreground.
 */
export function isBackgroundEvent(ev: TraceEvent): boolean {
  return (ev.kind === 'frameTx' || ev.kind === 'drop') && ev.background === true;
}

/** @since P2 True when the chips would list `ev`: a background event only with the background chip on. */
export function listsBackground(sel: Pick<ChipSelection, 'background'>, ev: TraceEvent): boolean {
  return sel.background || !isBackgroundEvent(ev);
}

/** Nothing switched on: matches every foreground event. */
export const NO_CHIPS: ChipSelection = Object.freeze({ kinds: [], protos: [], devices: [], tags: [], background: false });

/** The list filter simulation mode starts with (§4.11 item 1). */
export const DEFAULT_LIST_CHIPS: ChipSelection = Object.freeze({ ...NO_CHIPS, kinds: SIM_MODE_LIST_KINDS });

function toggled<T extends string>(cur: readonly T[], v: T): T[] {
  return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
}

/** Switch one chip on or off. Unknown trace kinds are ignored (the vocabulary is the closed set). */
export function toggleChip(sel: ChipSelection, group: ChipGroup, value: string): ChipSelection {
  switch (group) {
    case 'kinds':
      return isTraceKind(value) ? { ...sel, kinds: toggled(sel.kinds, value) } : sel;
    case 'protos':
      return { ...sel, protos: toggled(sel.protos, value) };
    case 'devices':
      return { ...sel, devices: toggled(sel.devices, value) };
    default:
      return { ...sel, tags: toggled(sel.tags, value) };
  }
}

/** True when `value` is switched on in `group`. */
export function chipIsOn(sel: ChipSelection, group: ChipGroup, value: string): boolean {
  return (sel[group] as readonly string[]).includes(value);
}

/** True when at least one chip is switched on (an all-off selection filters nothing). */
export function hasChips(sel: ChipSelection): boolean {
  return CHIP_GROUPS.some((g) => (sel[g] as readonly string[]).length > 0);
}

/**
 * The filter the chips compose. Empty groups are omitted — a present empty array would match nothing — and
 * `includeBackground` is always written.
 */
export function buildTraceFilter(sel: ChipSelection): TraceFilter {
  const f: TraceFilter = { includeBackground: sel.background };
  if (sel.kinds.length > 0) f.kinds = sel.kinds;
  if (sel.protos.length > 0) f.protos = sel.protos;
  if (sel.devices.length > 0) f.devices = sel.devices;
  if (sel.tags.length > 0) f.tags = sel.tags;
  return f;
}

/** The chips that produce `f` (seeds the editor from a preset or from the stored filter). */
export function chipsFromFilter(f: TraceFilter | null | undefined): ChipSelection {
  if (f === undefined || f === null) return NO_CHIPS;
  return {
    kinds: f.kinds ?? [],
    protos: f.protos ?? [],
    devices: f.devices ?? [],
    tags: f.tags ?? [],
    background: f.includeBackground === true,
  };
}

/** Stable identity of a filter (effect dependency; chip order must not re-send it to the worker). */
export function filterKey(f: TraceFilter | null): string {
  if (f === null) return 'off';
  const part = (name: string, vs: readonly string[] | undefined): string => (vs === undefined ? '' : `${name}:${[...vs].sort().join(',')};`);
  return `${part('k', f.kinds)}${part('p', f.protos)}${part('d', f.devices)}${part('t', f.tags)}bg:${f.includeBackground === true ? '1' : '0'}`;
}

/** One line naming what a filter keeps (chip summary, screen-reader label). */
export function describeFilter(f: TraceFilter | null, deviceName?: (id: DeviceId) => string): string {
  if (f === null) return 'No breakpoint set.';
  const parts: string[] = [];
  if (f.kinds !== undefined) parts.push(`kind ${f.kinds.map(traceKindLabel).join(' or ')}`);
  if (f.protos !== undefined) parts.push(`protocol ${f.protos.map(protocolLabel).join(' or ')}`);
  if (f.devices !== undefined) parts.push(`device ${f.devices.map((d) => (deviceName ? deviceName(d) : d)).join(' or ')}`);
  if (f.tags !== undefined) parts.push(`message ${f.tags.join(' or ')}`);
  if (f.includeBackground === true) parts.push('keepalives included');
  return parts.length === 0 ? 'Every event except keepalives.' : parts.join('; ');
}

// ── breakpoint presets ──────────────────────────────────────────────────────

/** A ready-made breakpoint. `filter` is the `stopOn` the engine is given unchanged. */
export interface BreakpointPreset {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly filter: TraceFilter;
}

function preset(id: string, label: string, help: string, filter: TraceFilter): BreakpointPreset {
  return Object.freeze({ id, label, help, filter: Object.freeze(filter) });
}

/**
 * Breakpoints worth one click in CCNA 1. The first is the §10.2 `accept.p1.sim-mode-dhcp-offer` shape; the tag
 * strings are the ones the engine daemons put on their PDUs.
 */
export const BREAKPOINT_PRESETS: readonly BreakpointPreset[] = Object.freeze([
  preset('dhcp-offer', 'First address offer', 'Stops as the DHCP server puts its offer on the wire.', {
    kinds: ['frameTx'],
    protos: ['dhcp'],
    tags: ['dhcp-offer'],
  }),
  preset('arp-request', 'An address is looked up', 'Stops when a device asks who owns an IPv4 address.', {
    kinds: ['frameTx'],
    protos: ['arp'],
    tags: ['arp-request'],
  }),
  preset('dns-query', 'A name is looked up', 'Stops when a host sends a name query.', {
    kinds: ['frameTx'],
    protos: ['dns'],
    tags: ['dns-query'],
  }),
  preset('tcp-syn', 'A connection starts', 'Stops on the first segment of a TCP handshake.', {
    kinds: ['frameTx'],
    protos: ['tcp'],
    tags: ['tcp-syn'],
  }),
  preset('drop', 'Anything is dropped', 'Stops wherever a packet is discarded, with the reason.', { kinds: ['drop'] }),
  preset('table', 'A table row is written', 'Stops when a device learns a MAC, ARP or route entry.', { kinds: ['tableWrite'] }),
]);

/** The preset whose filter equals `f`, if any (so the editor can show which one is armed). */
export function presetOf(f: TraceFilter | null): BreakpointPreset | undefined {
  if (f === null) return undefined;
  const key = filterKey(f);
  return BREAKPOINT_PRESETS.find((p) => filterKey(p.filter) === key);
}

// ── paging ──────────────────────────────────────────────────────────────────

/** One listed event and its ring cursor. */
export interface EventRow {
  readonly cursor: number;
  readonly event: TraceEvent;
}

/** The window of matching rows the panel holds, ascending by cursor. */
export interface EventPage {
  readonly rows: readonly EventRow[];
  /** Forward continuation cursor (`TraceQueryResult.next`). */
  readonly next: number;
  /** Oldest cursor the ring still holds. */
  readonly oldest: number;
  /** Ring head at the last query. */
  readonly head: number;
  /** Older rows may still exist before `rows[0]`. */
  readonly more: boolean;
}

/** Nothing loaded yet; also the state after an epoch change or a filter change. */
export const EMPTY_PAGE: EventPage = Object.freeze({ rows: [], next: 0, oldest: 0, head: 0, more: false });

function moreBefore(rows: readonly EventRow[], oldest: number): boolean {
  const first = rows[0];
  return first !== undefined && first.cursor > oldest;
}

/** The query that opens the list: the last page of the ring (§4.11 item 5). */
export function initialQuery(head: number, filter: TraceFilter, limit = SIM_EVENTS_PAGE): TraceQuery {
  return { from: Math.max(0, head - limit), filter, limit };
}

/**
 * The newest matching page when the trace head is not known yet (the first batch has not arrived). A backward
 * query clamps itself to the ring head, so it always lands on the end of the trace; merge it with `prependPage`.
 */
export function newestQuery(filter: TraceFilter, limit = SIM_EVENTS_PAGE): TraceQuery {
  return { from: Number.MAX_SAFE_INTEGER, filter, limit, direction: 'backward' };
}

/** The incremental query run whenever the trace head advanced. */
export function followQuery(page: EventPage, filter: TraceFilter, limit = SIM_EVENTS_PAGE): TraceQuery {
  return { from: page.next, filter, limit };
}

/** The query for the page before the first retained row; undefined when the ring holds nothing older. */
export function olderQuery(page: EventPage, filter: TraceFilter, limit = SIM_EVENTS_PAGE): TraceQuery | undefined {
  const first = page.rows[0];
  const from = (first === undefined ? page.head : first.cursor) - 1;
  if (from < page.oldest) return undefined;
  return { from, filter, limit, direction: 'backward' };
}

/** Merge a forward result: new rows at the end, rows that fell out of the ring and the oldest overflow dropped. */
export function appendPage(page: EventPage, r: TraceQueryResult, cap = SIM_EVENTS_MAX_ROWS): EventPage {
  const kept = page.rows.filter((row) => row.cursor >= r.oldest);
  const last = kept[kept.length - 1];
  const lastCursor = last === undefined ? -1 : last.cursor;
  const merged = kept.concat(r.events.filter((e) => e.cursor > lastCursor));
  const rows = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  return { rows, next: Math.max(page.next, r.next), oldest: r.oldest, head: r.head, more: moreBefore(rows, r.oldest) };
}

/**
 * Merge a backward result: older rows at the front (a backward query returns them newest first) and the newest
 * overflow dropped. `next` always sits just past the last retained row — pulled back after a trim so forward
 * paging refetches what it dropped, pushed forward when this is the first page the panel loaded.
 */
export function prependPage(page: EventPage, r: TraceQueryResult, cap = SIM_EVENTS_MAX_ROWS): EventPage {
  const first = page.rows[0];
  const limitCursor = first === undefined ? Number.POSITIVE_INFINITY : first.cursor;
  const older = [...r.events].reverse().filter((e) => e.cursor < limitCursor && e.cursor >= r.oldest);
  const merged = older.concat(page.rows.filter((row) => row.cursor >= r.oldest));
  const trimmed = merged.length > cap;
  const rows = trimmed ? merged.slice(0, cap) : merged;
  const last = rows[rows.length - 1];
  const after = last === undefined ? page.next : trimmed ? last.cursor + 1 : Math.max(page.next, last.cursor + 1);
  return { rows, next: after, oldest: r.oldest, head: r.head, more: r.next >= r.oldest && moreBefore(rows, r.oldest) };
}

/** Index of the row with `cursor`, or -1 (used to keep a stop or a selection focused across pages). */
export function rowIndexOf(page: EventPage, cursor: number): number {
  return page.rows.findIndex((r) => r.cursor === cursor);
}

/** Distinct `PduSummary.tag`s among the loaded rows, sorted — the tag chips offer what the run actually produced. */
export function tagsOf(page: EventPage, also: readonly string[] = []): string[] {
  const out = new Set<string>(also);
  for (const row of page.rows) {
    const ev = row.event;
    switch (ev.kind) {
      case 'frameTx':
      case 'frameRx':
      case 'drop':
      case 'pduCreated':
      case 'pduConsumed':
      case 'frameAbort':
        if (ev.pdu.tag !== undefined) out.add(ev.pdu.tag);
        break;
      default:
        break;
    }
  }
  return [...out].sort();
}

// ── virtual rows ────────────────────────────────────────────────────────────

/** The slice of rows worth rendering, with the spacer heights that keep the scrollbar honest. */
export interface RowWindow {
  readonly start: number;
  readonly end: number;
  readonly padTop: number;
  readonly padBottom: number;
}

/** Rows to render for a scroll position. Thousands of rows cost a fixed number of DOM nodes. */
export function rowWindow(
  count: number,
  scrollTop: number,
  viewportH: number,
  rowH = SIM_EVENTS_ROW_H,
  overscan = SIM_EVENTS_OVERSCAN,
): RowWindow {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportH) / rowH));
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowH) - overscan);
  const start = Math.min(first, Math.max(0, count - 1));
  const end = Math.min(count, start + visible + overscan * 2);
  return { start, end, padTop: start * rowH, padBottom: (count - end) * rowH };
}

/** True while the list is parked at its newest row (it then follows new events instead of holding still). */
export function atBottom(scrollTop: number, viewportH: number, count: number, rowH = SIM_EVENTS_ROW_H): boolean {
  return scrollTop + viewportH >= count * rowH - rowH;
}

/** Where a key moves the focused row, or null when the key is not ours. `index` -1 = nothing focused yet. */
export function moveRowFocus(key: string, index: number, count: number, pageRows: number): number | null {
  if (count <= 0) return null;
  const clamp = (i: number): number => Math.min(count - 1, Math.max(0, i));
  const step = Math.max(1, pageRows);
  switch (key) {
    case 'ArrowDown':
      return clamp(index < 0 ? 0 : index + 1);
    case 'ArrowUp':
      return clamp(index < 0 ? count - 1 : index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clamp((index < 0 ? 0 : index) + step);
    case 'PageUp':
      return clamp((index < 0 ? count - 1 : index) - step);
    default:
      return null;
  }
}

/** The scrollTop that brings row `index` into view, or undefined when it already is. */
export function scrollForIndex(index: number, scrollTop: number, viewportH: number, rowH = SIM_EVENTS_ROW_H): number | undefined {
  const top = index * rowH;
  if (top < scrollTop) return top;
  if (top + rowH > scrollTop + viewportH) return top + rowH - viewportH;
  return undefined;
}

// ── rows ────────────────────────────────────────────────────────────────────

/** What clicking (or pressing Enter on) a row selects; null when the event points at nothing selectable. */
export function selectionForEvent(ev: TraceEvent): Selection | null {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
    case 'frameAbort':
      return { kind: 'pdu', id: ev.pdu.id };
    case 'mutation':
      return { kind: 'pdu', id: ev.pdu };
    case 'tableWrite':
    case 'tableExpire':
    case 'log':
    case 'deviceState':
    case 'configChange':
    case 'backoff':
    case 'carrierDefer':
      return { kind: 'device', id: ev.device };
    case 'debug':
      return { kind: 'device', id: ev.event.device };
    case 'portState':
      return { kind: 'port', ref: { device: ev.device, port: ev.port } };
    case 'rfState':
      return { kind: 'port', ref: ev.port };
    case 'assocState':
      return { kind: 'port', ref: ev.station };
    case 'linkState':
    case 'phyNegotiated':
      return { kind: 'link', id: ev.link };
    case 'cliOutput':
    case 'cliPrompt':
      return { kind: 'session', id: ev.session };
    default:
      return null;
  }
}

/** The protocol a row shows, or undefined for events that carry no packet. */
export function rowProto(ev: TraceEvent): ProtoName | undefined {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
    case 'frameAbort':
      return ev.pdu.layers?.[ev.pdu.layers.length - 1] ?? ev.pdu.proto;
    default:
      return undefined;
  }
}

/** The message tag a row shows, if the packet carries one. */
export function rowTag(ev: TraceEvent): string | undefined {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
    case 'frameAbort':
      return ev.pdu.tag;
    default:
      return undefined;
  }
}

/** How a row names the devices and ports of an event (the panel passes the inspector's index helpers). */
export interface RowNames {
  device(id: DeviceId): string;
  port(ref: PortRef): string;
}

const upDown = (v: boolean): string => (v ? 'up' : 'down');

/**
 * One line for any trace event, exhaustive over `TraceKind`. Every semantic word comes from `vocab/*` (drop
 * sentences, abort reasons, mutation reasons, port-state reasons, segment operations, association phases), so
 * this function only assembles sentences — it invents no vocabulary of its own.
 */
export function eventText(ev: TraceEvent, n: RowNames): string {
  switch (ev.kind) {
    case 'frameTx':
      return `#${ev.pdu.id} ${n.port(ev.from)} → ${n.port(ev.to)}: ${ev.pdu.summary} (${ev.pdu.size} B)`;
    case 'frameRx':
      return `#${ev.pdu.id} arrived at ${n.port({ device: ev.device, port: ev.port })}: ${ev.pdu.summary}`;
    case 'frameAbort':
      return `#${ev.pdu.id} between ${n.port(ev.from)} and ${n.port(ev.to)} ${FRAME_ABORT_TEXT[ev.reason]}`;
    case 'drop': {
      const where =
        ev.device === undefined
          ? (ev.link ?? ev.medium ?? 'the medium')
          : ev.port === undefined
            ? n.device(ev.device)
            : n.port({ device: ev.device, port: ev.port });
      return `#${ev.pdu.id} dropped at ${where}: ${dropLabel(ev.reason)}${ev.detail === undefined ? '' : ` — ${ev.detail}`}`;
    }
    case 'pduCreated':
      return `${n.device(ev.device)} ${ev.process} built #${ev.pdu.id}: ${ev.pdu.summary}`;
    case 'pduConsumed':
      return `${n.device(ev.device)} ${ev.process} took #${ev.pdu.id}: ${ev.pdu.summary}`;
    case 'mutation':
      return `#${ev.pdu} at ${n.device(ev.mutation.device)}: ${ev.mutation.field} — ${mutationVocab(ev.mutation.reason).label}`;
    case 'tableWrite':
      return `${n.device(ev.device)} ${ev.table} ${ev.previous === undefined ? 'added' : 'refreshed'} ${ev.key}`;
    case 'tableExpire':
      return `${n.device(ev.device)} ${ev.table} lost ${ev.key} (${ev.reason})`;
    case 'debug':
      return `${n.device(ev.event.device)} [${ev.event.category}] ${ev.event.message}`;
    case 'log':
      return `${n.device(ev.device)} ${ev.facility} (level ${ev.severity}): ${ev.message}`;
    case 'linkState':
      return `cable ${ev.link} went ${upDown(ev.up)}${ev.reason === undefined ? '' : ` (${ev.reason})`}`;
    case 'portState':
      return `${n.port({ device: ev.device, port: ev.port })}: admin ${upDown(ev.adminUp)}, line ${upDown(ev.operUp)}${
        ev.reason === undefined ? '' : ` — ${portStateReasonText(ev.reason)}`
      }`;
    case 'deviceState':
      return `${n.device(ev.device)} ${ev.power ? (ev.booted ? 'finished starting' : 'is starting') : 'was switched off'}`;
    case 'configChange':
      return `${n.device(ev.device)} config: ${ev.negate ? 'no ' : ''}${ev.line}`;
    case 'topologyChanged':
      return `${ev.what} ${ev.id} was ${ev.op === 'add' ? 'added' : ev.op === 'remove' ? 'removed' : 'moved'}`;
    case 'cliOutput':
      return `session ${ev.session} printed ${ev.text.length} character${ev.text.length === 1 ? '' : 's'}`;
    case 'cliPrompt':
      return `session ${ev.session} showed ${ev.prompt}${ev.busy ? ' (busy)' : ''}`;
    case 'collision':
      return `${ev.stations.map((s) => n.port(s)).join(' and ')} transmitted at once on ${ev.segment}${ev.late ? ', detected late' : ''}`;
    case 'backoff':
      return `${n.port({ device: ev.device, port: ev.port })} waits ${ev.slots} slot${ev.slots === 1 ? '' : 's'} after attempt ${ev.attempt}`;
    case 'carrierDefer':
      return `${n.port({ device: ev.device, port: ev.port })} held back until the shared wire went quiet`;
    case 'phyNegotiated':
      return `cable ${ev.link} settled its speed and duplex${ev.mismatch === undefined ? '' : ` — ${ev.mismatch} mismatch`}`;
    case 'assocState': {
      const v = assocStateVocab(ev.tech, ev.state);
      return `${n.port(ev.station)} is now ${v === undefined ? ev.state : v.label}${ev.reason === undefined ? '' : ` (${ev.reason})`}`;
    }
    case 'rfState':
      return `${n.port(ev.port)} ↔ ${n.port(ev.peer)}: ${formatSignal(ev.rssiDbm, ev.bars)}`;
    default:
      return `${SEGMENT_OP_TEXT[ev.op]} on ${ev.segment} (${ev.members.length} port${ev.members.length === 1 ? '' : 's'})`;
  }
}

// ── stops ───────────────────────────────────────────────────────────────────

/** Heading of the stop banner. */
export function stopReasonText(reason: StopInfo['reason']): string {
  return reason === 'breakpoint' ? 'Paused at the breakpoint' : 'Moved to the next matching event';
}

/** Why a step found nothing (§4.11 item 4; the horizon wording is the one the brief fixes). */
export function stepEndedText(ended: NonNullable<RunStopResult['ended']>): string {
  switch (ended) {
    case 'horizon':
      return `No matching event in the next ${SIM_STEP_HORIZON_NS / 1_000_000_000} s`;
    case 'maxEvents':
      return `No matching event within ${SIM_STEP_MAX_EVENTS} steps of the simulation`;
    default:
      return 'Nothing left to run: no event is waiting.';
  }
}

/** One sentence for what a run or a step just did. */
export function runStopText(res: Pick<RunStopResult, 'stopped' | 'ended'>): string {
  if (res.stopped !== null) return stopReasonText(res.stopped.reason);
  if (res.ended !== undefined) return stepEndedText(res.ended);
  return `Nothing matched in the next ${SIM_RUN_HORIZON_NS / 1_000_000_000} s`;
}
