// Simulation-mode event paging and filter building (ARCHITECTURE-P1 §4.11, §7 "Sim-mode list", §10.2 "Web P1"
// `sim-events-client.test.ts`): the pure layer under simmode/*.tsx, driven without React.
//
// The paging half runs against a REAL trace: the CCNA 1 DHCP lab is built, solved through `configure` and run to
// idle, so `traceQuery` returns the same cursors, `oldest` and `head` the worker would return. The filter half
// pins the two shapes the brief fixes — the §4.11 default list and the §10.2 "stop at the first OFFER" breakpoint.
import { describe, expect, it } from 'vitest';
import { SCENARIOS, SEC, createSimulation } from '@netforge/engine';
import type { DeviceId, PortRef, ScenarioInfo, Simulation, TraceEvent, TraceFilter, TraceKind } from '@netforge/engine';
import {
  BREAKPOINT_PRESETS,
  CHIP_GROUPS,
  DEFAULT_LIST_CHIPS,
  EMPTY_PAGE,
  NO_CHIPS,
  SIM_EVENTS_ROW_H,
  appendPage,
  atBottom,
  buildTraceFilter,
  chipIsOn,
  chipsFromFilter,
  describeFilter,
  eventText,
  filterKey,
  followQuery,
  hasChips,
  initialQuery,
  moveRowFocus,
  newestQuery,
  olderQuery,
  prependPage,
  presetOf,
  rowIndexOf,
  rowProto,
  rowTag,
  rowWindow,
  runStopText,
  scrollForIndex,
  selectionForEvent,
  stepEndedText,
  stopReasonText,
  tagsOf,
  toggleChip,
  type EventPage,
  type RowNames,
} from '../src/simmode/sim-events-client';

// ── a real trace to page ────────────────────────────────────────────────────

const BOOT_NS = 60 * SEC;

function labOf(name: string): ScenarioInfo {
  const lab = SCENARIOS.find((s) => s.name === name);
  if (lab === undefined) throw new Error(`no scenario called ${name}`);
  return lab;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name}`);
}

/** The DHCP lab, solved and run to idle: a trace with DORA in it. */
function dhcpWorld(): Simulation {
  const lab = labOf('ccna1-dhcpv4-server');
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology(lab.build());
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  for (const [name, lines] of Object.entries(lab.solution ?? {})) sim.configure(idOf(sim, name), [...lines]);
  sim.runToIdle();
  return sim;
}

const world = dhcpWorld();
const names: RowNames = {
  device: (id) => id,
  port: (ref: PortRef) => `${ref.device}/${ref.port}`,
};

/** Everything the ring holds, unfiltered — the yardstick every paged read is compared with. */
function allRows(filter: TraceFilter): { cursor: number; event: TraceEvent }[] {
  const head = world.traceQuery({ from: 0, limit: 0 }).head;
  return world.traceQuery({ from: 0, filter, limit: head + 1 }).events;
}

/** Page forward with `limit` per query until the head is reached. */
function pageForward(filter: TraceFilter, limit: number, cap?: number): EventPage {
  let page = appendPage(EMPTY_PAGE, world.traceQuery(initialQuery(0, filter, limit)), cap);
  for (let guard = 0; guard < 5000 && page.next < page.head; guard++) {
    page = appendPage(page, world.traceQuery(followQuery(page, filter, limit)), cap);
  }
  return page;
}

describe('the lab world the paging tests read', () => {
  it('ran the four DHCP messages, so the trace has an offer to stop at', () => {
    const offers = allRows({ kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'] });
    expect(offers.length).toBeGreaterThan(0);
    for (const { event } of offers) {
      expect(event.kind).toBe('frameTx');
      if (event.kind === 'frameTx') expect(event.pdu.tag).toBe('dhcp-offer');
    }
  });
});

// ── chips → TraceFilter ─────────────────────────────────────────────────────

describe('chips compose the filter the engine understands', () => {
  it('builds the §4.11 default list filter exactly', () => {
    expect(buildTraceFilter(DEFAULT_LIST_CHIPS)).toEqual({ kinds: ['frameTx', 'drop', 'tableWrite'], includeBackground: false });
  });

  it('leaves empty groups out, because a present empty array matches nothing', () => {
    const f = buildTraceFilter(NO_CHIPS);
    expect(f).toEqual({ includeBackground: false });
    for (const key of ['kinds', 'protos', 'devices', 'tags']) expect(Object.prototype.hasOwnProperty.call(f, key)).toBe(false);
    // and the engine agrees that such a filter keeps everything that is not background
    expect(allRows(f).length).toBe(allRows({ includeBackground: false }).length);
  });

  it('switches a chip on and off again, and ignores a kind outside the vocabulary', () => {
    const on = toggleChip(NO_CHIPS, 'kinds', 'drop');
    expect(chipIsOn(on, 'kinds', 'drop')).toBe(true);
    expect(hasChips(on)).toBe(true);
    expect(toggleChip(on, 'kinds', 'drop')).toEqual(NO_CHIPS);
    expect(toggleChip(NO_CHIPS, 'kinds', 'not-a-kind')).toEqual(NO_CHIPS);
  });

  it('composes an or inside a row and an and across rows', () => {
    let sel = toggleChip(NO_CHIPS, 'kinds', 'frameTx');
    sel = toggleChip(sel, 'kinds', 'drop');
    sel = toggleChip(sel, 'protos', 'dhcp');
    const f = buildTraceFilter(sel);
    expect(f.kinds).toEqual(['frameTx', 'drop']);
    expect(f.protos).toEqual(['dhcp']);
    const both = allRows(f).length;
    const txOnly = allRows({ kinds: ['frameTx'], protos: ['dhcp'], includeBackground: false }).length;
    expect(both).toBeGreaterThanOrEqual(txOnly);
    expect(both).toBeLessThanOrEqual(allRows({ protos: ['dhcp'], includeBackground: false }).length);
  });

  it('carries keepalives only when the chip is on', () => {
    expect(buildTraceFilter({ ...NO_CHIPS, background: true }).includeBackground).toBe(true);
    expect(allRows({ includeBackground: true }).length).toBeGreaterThanOrEqual(allRows({ includeBackground: false }).length);
  });

  it('keys a filter by meaning, not by chip order', () => {
    const a = buildTraceFilter({ ...NO_CHIPS, kinds: ['frameTx', 'drop'] as TraceKind[] });
    const b = buildTraceFilter({ ...NO_CHIPS, kinds: ['drop', 'frameTx'] as TraceKind[] });
    expect(filterKey(a)).toBe(filterKey(b));
    expect(filterKey(null)).toBe('off');
  });

  it('describes a filter in words, with device names when it is given them', () => {
    const text = describeFilter({ kinds: ['frameTx'], protos: ['dhcp'], devices: ['d1'], includeBackground: false }, () => 'PC1');
    expect(text).toContain('Sent');
    expect(text).toContain('DHCP');
    expect(text).toContain('PC1');
    expect(describeFilter(null)).toBe('No breakpoint set.');
  });
});

describe('breakpoint presets', () => {
  it('spells "stop at the first DHCP offer" the way §10.2 does', () => {
    const p = BREAKPOINT_PRESETS.find((x) => x.id === 'dhcp-offer');
    expect(p?.filter).toEqual({ kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'] });
  });

  it('round-trips through the chips and still matches exactly the offers', () => {
    const p = BREAKPOINT_PRESETS[0]!;
    const chips = chipsFromFilter(p.filter);
    const rebuilt = buildTraceFilter(chips);
    expect(rebuilt).toEqual({ kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'], includeBackground: false });
    expect(presetOf(rebuilt)?.id).toBe('dhcp-offer');
    const matched = allRows(rebuilt);
    expect(matched.length).toBeGreaterThan(0);
    for (const { event } of matched) expect(rowTag(event)).toBe('dhcp-offer');
  });

  it('gives every preset a distinct filter and original wording', () => {
    const keys = BREAKPOINT_PRESETS.map((p) => filterKey(p.filter));
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of BREAKPOINT_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.help.endsWith('.')).toBe(true);
    }
  });

  it('reports no preset for a filter nobody offers', () => {
    expect(presetOf({ kinds: ['log'] })).toBeUndefined();
    expect(presetOf(null)).toBeUndefined();
  });
});

// ── paging ──────────────────────────────────────────────────────────────────

describe('paging the trace ring', () => {
  const listFilter = buildTraceFilter(DEFAULT_LIST_CHIPS);

  it('opens on the last page of the ring (§4.11 item 5)', () => {
    const head = world.traceQuery({ from: 0, limit: 0 }).head;
    const q = initialQuery(head, listFilter, 500);
    expect(q).toEqual({ from: Math.max(0, head - 500), filter: listFilter, limit: 500 });
    const page = appendPage(EMPTY_PAGE, world.traceQuery(q));
    expect(page.head).toBe(head);
    expect(page.rows.every((r) => r.cursor >= q.from)).toBe(true);
  });

  it('collects every matching row in cursor order, once, whatever the page size', () => {
    const expected = allRows(listFilter).map((r) => r.cursor);
    expect(expected.length).toBeGreaterThan(20);
    for (const limit of [3, 17, 500]) {
      const page = pageForward(listFilter, limit);
      expect(page.rows.map((r) => r.cursor)).toEqual(expected);
      expect(new Set(page.rows.map((r) => r.cursor)).size).toBe(page.rows.length);
    }
  });

  it('keeps only the newest rows under the cap, and says older ones exist', () => {
    const expected = allRows(listFilter).map((r) => r.cursor);
    const page = pageForward(listFilter, 5, 10);
    expect(page.rows.length).toBe(10);
    expect(page.rows.map((r) => r.cursor)).toEqual(expected.slice(-10));
    expect(page.more).toBe(true);
  });

  it('walks backwards from the newest page to the same rows', () => {
    const expected = allRows(listFilter).map((r) => r.cursor);
    // a backward result comes back newest first, so it is merged with prependPage
    let page = prependPage(EMPTY_PAGE, world.traceQuery(newestQuery(listFilter, 5)));
    expect(page.rows.map((r) => r.cursor)).toEqual(expected.slice(-5));
    for (let guard = 0; guard < 5000; guard++) {
      const q = olderQuery(page, listFilter, 5);
      if (q === undefined) break;
      const before = page.rows.length;
      page = prependPage(page, world.traceQuery(q), 5000);
      if (page.rows.length === before) break;
    }
    expect(page.rows.map((r) => r.cursor)).toEqual(expected);
    expect(page.more).toBe(false);
  });

  it('asks for nothing older once the page starts at the oldest retained cursor', () => {
    const page = pageForward(listFilter, 500);
    expect(page.rows[0]?.cursor).toBe(allRows(listFilter)[0]?.cursor);
    expect(olderQuery({ ...page, oldest: page.rows[0]?.cursor ?? 0 }, listFilter)).toBeUndefined();
  });

  it('repairs the forward cursor when a backward page pushed rows off the end', () => {
    const full = pageForward(listFilter, 500);
    const tail = prependPage(EMPTY_PAGE, world.traceQuery(newestQuery(listFilter, 20)), 20);
    const older = olderQuery(tail, listFilter, 20);
    expect(older).toBeDefined();
    const trimmed = prependPage(tail, world.traceQuery(older!), 20);
    expect(trimmed.rows.length).toBe(20);
    const last = trimmed.rows[trimmed.rows.length - 1]!;
    expect(trimmed.next).toBe(last.cursor + 1);
    // paging forward again refetches exactly what the trim dropped
    const back = appendPage(trimmed, world.traceQuery(followQuery(trimmed, listFilter, 500)), 5000);
    expect(back.rows.map((r) => r.cursor)).toEqual(full.rows.map((r) => r.cursor).slice(-back.rows.length));
  });

  it('leaves the forward cursor past the newest row of a first backward page', () => {
    const page = prependPage(EMPTY_PAGE, world.traceQuery(newestQuery(listFilter, 10)));
    const last = page.rows[page.rows.length - 1]!;
    expect(page.next).toBeGreaterThan(last.cursor);
    // so the next follow query asks for something new rather than crawling from cursor 0
    expect(followQuery(page, listFilter).from).toBe(page.next);
    expect(appendPage(page, world.traceQuery(followQuery(page, listFilter))).rows).toEqual(page.rows);
  });

  it('drops rows the ring no longer holds', () => {
    const page = pageForward(listFilter, 500);
    const first = page.rows[0]!;
    const moved = appendPage(page, { events: [], next: page.next, oldest: first.cursor + 1, head: page.head });
    expect(moved.rows.some((r) => r.cursor === first.cursor)).toBe(false);
    expect(moved.rows.length).toBe(page.rows.length - 1);
  });

  it('finds a row by its cursor so a stop can be revealed', () => {
    const page = pageForward(listFilter, 500);
    const target = page.rows[3]!;
    expect(rowIndexOf(page, target.cursor)).toBe(3);
    expect(rowIndexOf(page, -1)).toBe(-1);
  });

  it('offers the message tags the run actually produced', () => {
    const page = pageForward(buildTraceFilter({ ...NO_CHIPS, kinds: ['frameTx'] as TraceKind[] }), 500);
    const tags = tagsOf(page);
    expect(tags).toContain('dhcp-offer');
    expect(tags).toEqual([...tags].sort());
    expect(tagsOf(EMPTY_PAGE, ['kept'])).toEqual(['kept']);
  });
});

// ── virtual rows and the keyboard ───────────────────────────────────────────

describe('the virtual window', () => {
  it('renders a bounded slice and pads the rest, whatever the row count', () => {
    const count = 20_000;
    const w = rowWindow(count, 4_000, 300);
    expect(w.end - w.start).toBeLessThan(60);
    expect(w.padTop + (w.end - w.start) * SIM_EVENTS_ROW_H + w.padBottom).toBe(count * SIM_EVENTS_ROW_H);
    // the viewport is inside the rendered slice
    expect(w.start * SIM_EVENTS_ROW_H).toBeLessThanOrEqual(4_000);
    expect(w.end * SIM_EVENTS_ROW_H).toBeGreaterThanOrEqual(4_300);
  });

  it('renders nothing for an empty list and at least one row for a zero-height viewport', () => {
    expect(rowWindow(0, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(rowWindow(5, 0, 0).end).toBeGreaterThan(0);
  });

  it('knows when the list is parked at its newest row', () => {
    expect(atBottom(0, 100, 3)).toBe(true);
    expect(atBottom(0, 100, 500)).toBe(false);
    expect(atBottom(500 * SIM_EVENTS_ROW_H - 100, 100, 500)).toBe(true);
  });

  it('moves the focused row with the keys §16 asks for', () => {
    expect(moveRowFocus('ArrowDown', -1, 10, 4)).toBe(0);
    expect(moveRowFocus('ArrowDown', 9, 10, 4)).toBe(9);
    expect(moveRowFocus('ArrowUp', -1, 10, 4)).toBe(9);
    expect(moveRowFocus('ArrowUp', 0, 10, 4)).toBe(0);
    expect(moveRowFocus('Home', 5, 10, 4)).toBe(0);
    expect(moveRowFocus('End', 5, 10, 4)).toBe(9);
    expect(moveRowFocus('PageDown', 0, 10, 4)).toBe(4);
    expect(moveRowFocus('PageUp', 9, 10, 4)).toBe(5);
    expect(moveRowFocus('a', 0, 10, 4)).toBeNull();
    expect(moveRowFocus('ArrowDown', 0, 0, 4)).toBeNull();
  });

  it('scrolls a row into view only when it is outside', () => {
    expect(scrollForIndex(0, 200, 100)).toBe(0);
    expect(scrollForIndex(50, 0, 100)).toBe(50 * SIM_EVENTS_ROW_H + SIM_EVENTS_ROW_H - 100);
    expect(scrollForIndex(1, 0, 100)).toBeUndefined();
  });
});

// ── rows ────────────────────────────────────────────────────────────────────

describe('what a row shows and selects', () => {
  const listFilter = buildTraceFilter(DEFAULT_LIST_CHIPS);

  it('writes a sentence for every event the lab produced', () => {
    const rows = allRows({ includeBackground: true });
    expect(rows.length).toBeGreaterThan(50);
    const kinds = new Set<string>();
    for (const { event } of rows) {
      const text = eventText(event, names);
      expect(text.length, `${event.kind} has no wording`).toBeGreaterThan(0);
      kinds.add(event.kind);
    }
    expect(kinds.size).toBeGreaterThan(4);
  });

  it('writes a sentence for the media kinds a wired lab never reaches', () => {
    const at = 1_000;
    const ref = (device: string, port: string): PortRef => ({ device, port });
    const extra: TraceEvent[] = [
      { t: at, kind: 'segmentChanged', segment: 'm1', members: [ref('d1', 'Gi0')], op: 'formed' },
      { t: at, kind: 'collision', segment: 'm1', stations: [ref('d1', 'Gi0'), ref('d2', 'Gi0')], pdus: [1, 2], detectAt: at, jamUntil: at, late: false },
      { t: at, kind: 'rfState', port: ref('d1', 'Wl0'), peer: ref('d2', 'Wl0'), rssiDbm: -60, snrDb: 30, rateBps: 1, bars: 3 },
      { t: at, kind: 'assocState', tech: 'wifi', medium: 'air1', station: ref('d1', 'Wl0'), state: 'associated', prev: 'associating' },
      { t: at, kind: 'carrierDefer', device: 'd1', port: 'Gi0', pdu: 1, until: at },
      { t: at, kind: 'backoff', device: 'd1', port: 'Gi0', pdu: 1, attempt: 2, slots: 3, until: at },
      { t: at, kind: 'phyNegotiated', device: 'd1', link: 'l1', a: {} as never, b: {} as never, mismatch: 'duplex' } as unknown as TraceEvent,
    ];
    for (const ev of extra) expect(eventText(ev, names).length, ev.kind).toBeGreaterThan(0);
    expect(eventText(extra[5]!, names)).toContain('3 slots');
    expect(eventText(extra[3]!, names)).toContain('connected');
  });

  it('selects the packet of a packet row and the device or port of the others', () => {
    const tx = allRows({ kinds: ['frameTx'], includeBackground: false })[0]!.event;
    expect(selectionForEvent(tx)).toEqual({ kind: 'pdu', id: tx.kind === 'frameTx' ? tx.pdu.id : 0 });
    const write = allRows({ kinds: ['tableWrite'] })[0]!.event;
    expect(selectionForEvent(write)).toEqual({ kind: 'device', id: write.kind === 'tableWrite' ? write.device : '' });
    expect(selectionForEvent({ t: 1, kind: 'portState', device: 'd1', port: 'Gi0', adminUp: true, operUp: true })).toEqual({
      kind: 'port',
      ref: { device: 'd1', port: 'Gi0' },
    });
    expect(selectionForEvent({ t: 1, kind: 'linkState', link: 'l1', up: true })).toEqual({ kind: 'link', id: 'l1' });
    expect(selectionForEvent({ t: 1, kind: 'topologyChanged', what: 'device', id: 'd1', op: 'add' })).toBeNull();
  });

  it('names the innermost protocol of a packet row and nothing for the rest', () => {
    const offer = allRows({ kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'] })[0]!.event;
    expect(rowProto(offer)).toBe('dhcp');
    expect(rowTag(offer)).toBe('dhcp-offer');
    const write = allRows({ kinds: ['tableWrite'] })[0]!.event;
    expect(rowProto(write)).toBeUndefined();
    expect(rowTag(write)).toBeUndefined();
  });

  it('lists its chip rows once each', () => {
    expect(new Set(CHIP_GROUPS).size).toBe(CHIP_GROUPS.length);
    expect(pageForward(listFilter, 500).rows.length).toBeGreaterThan(0);
  });
});

// ── stops ───────────────────────────────────────────────────────────────────

describe('what the panel says about a stop', () => {
  it('uses the §4.11 wording when a step finds nothing within the horizon', () => {
    expect(stepEndedText('horizon')).toBe('No matching event in the next 10 s');
    expect(stepEndedText('idle')).toContain('Nothing left to run');
    expect(stepEndedText('maxEvents')).toContain('20000');
  });

  it('tells a breakpoint stop from a step', () => {
    expect(stopReasonText('breakpoint')).toContain('breakpoint');
    expect(stopReasonText('step')).not.toBe(stopReasonText('breakpoint'));
  });

  it('summarises a run result', () => {
    const ev = allRows({ kinds: ['frameTx'], includeBackground: false })[0]!;
    expect(runStopText({ stopped: { cursor: ev.cursor, event: ev.event, reason: 'breakpoint' } })).toBe(stopReasonText('breakpoint'));
    expect(runStopText({ stopped: null, ended: 'horizon' })).toBe(stepEndedText('horizon'));
    expect(runStopText({ stopped: null })).toContain('60 s');
  });
});
