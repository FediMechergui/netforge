/**
 * P3c W0h [C32] (b) (ARCHITECTURE-P3C §7 W0h "sim + web-shell", §10.2 `simmode.vlan-chip.test.tsx`): the VLAN chip row
 * of simulation mode. The chips compose `TraceFilter.vlans` (left out while no VLAN chip is on, so every P1/P2/P3
 * filter keeps its shape and its key), round-trip through `chipsFromFilter`, are offered from the VIDs the loaded rows
 * carry (`PduSummary.vlan`), and are drawn in both the event list's `FilterChips` and the breakpoint editor. The
 * engine's own predicate agrees with the chips on real events.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { matchesTraceFilter } from '@netforge/engine';
import type { PduSummary, TraceEvent } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({
  engine: {},
  fmtSimTime: (t: number) => `T${t}`,
  fmtDuration: (t: number) => `${t} ns`,
}));

import { BreakpointEditor } from '../src/simmode/BreakpointEditor';
import { FilterChips, chipTitle } from '../src/simmode/FilterChips';
import {
  BREAKPOINT_PRESETS,
  CHIP_GROUPS,
  CHIP_GROUP_LABELS,
  DEFAULT_LIST_CHIPS,
  EMPTY_PAGE,
  NO_CHIPS,
  buildTraceFilter,
  chipIsOn,
  chipVlan,
  chipsFromFilter,
  describeFilter,
  filterKey,
  hasChips,
  toggleChip,
  vlansOf,
  type EventPage,
} from '../src/simmode/sim-events-client';

const pdu = (id: number, vlan?: number): PduSummary => ({
  id,
  proto: 'icmpv4',
  size: 102,
  summary: 'echo request',
  layers: vlan === undefined ? ['ethernet', 'ipv4', 'icmpv4'] : ['ethernet', 'dot1q', 'ipv4', 'icmpv4'],
  ...(vlan === undefined ? {} : { vlan }),
});

const tx = (id: number, vlan?: number): TraceEvent => ({
  t: id,
  kind: 'frameTx',
  pdu: pdu(id, vlan),
  link: 'l_1',
  from: { device: 'sw1', port: 'GigabitEthernet0/1' },
  to: { device: 'sw2', port: 'GigabitEthernet0/1' },
  txStart: id,
  txEnd: id + 1,
  arrive: id + 2,
});

const EVENTS: TraceEvent[] = [
  tx(1, 20),
  tx(2),
  tx(3, 10),
  { t: 4, kind: 'frameRx', pdu: pdu(3, 10), device: 'sw2', port: 'GigabitEthernet0/1' },
  { t: 5, kind: 'drop', pdu: pdu(5, 30), device: 'sw2', port: 'GigabitEthernet0/1', reason: 'vlan-filtered' },
  { t: 6, kind: 'deviceState', device: 'sw1', power: true, booted: true } as TraceEvent,
];
const PAGE: EventPage = { rows: EVENTS.map((event, cursor) => ({ cursor, event })), next: EVENTS.length, oldest: 0, head: EVENTS.length, more: false };

const devices = [{ id: 'sw1', name: 'SW1' }];

describe('the VLAN chips compose TraceFilter.vlans', () => {
  it('is the last chip row, headed "VLAN"', () => {
    expect(CHIP_GROUPS[CHIP_GROUPS.length - 1]).toBe('vlans');
    expect(CHIP_GROUP_LABELS.vlans).toBe('VLAN');
    expect(NO_CHIPS.vlans).toEqual([]);
    expect(DEFAULT_LIST_CHIPS.vlans).toEqual([]);
  });

  it('leaves the key out while no VLAN chip is on, so the P1 filters and their keys are unchanged', () => {
    expect(buildTraceFilter(DEFAULT_LIST_CHIPS)).toEqual({ kinds: ['frameTx', 'drop', 'tableWrite'], includeBackground: false });
    expect(Object.prototype.hasOwnProperty.call(buildTraceFilter(NO_CHIPS), 'vlans')).toBe(false);
    for (const p of BREAKPOINT_PRESETS) expect(filterKey(buildTraceFilter(chipsFromFilter(p.filter)))).not.toContain('v:');
  });

  it('switches a VLAN on and off, ORs VLANs, and ignores a value that is not a VID', () => {
    let sel = toggleChip(NO_CHIPS, 'vlans', '10');
    expect(chipIsOn(sel, 'vlans', '10')).toBe(true);
    expect(hasChips(sel)).toBe(true);
    sel = toggleChip(sel, 'vlans', '20');
    expect(buildTraceFilter(sel)).toEqual({ vlans: [10, 20], includeBackground: false });
    expect(toggleChip(toggleChip(sel, 'vlans', '20'), 'vlans', '10')).toEqual(NO_CHIPS);
    for (const bad of ['0', '4095', 'ten', '1.5', '', '-3', '010x']) {
      expect(chipVlan(bad), bad).toBeUndefined();
      expect(toggleChip(NO_CHIPS, 'vlans', bad)).toEqual(NO_CHIPS);
    }
    expect(chipVlan('1')).toBe(1);
    expect(chipVlan('4094')).toBe(4094);
  });

  it('round-trips through chipsFromFilter, keys by meaning and says it in words', () => {
    const f = buildTraceFilter(toggleChip(toggleChip(NO_CHIPS, 'kinds', 'frameTx'), 'vlans', '20'));
    expect(buildTraceFilter(chipsFromFilter(f))).toEqual(f);
    expect(filterKey({ vlans: [20, 10] })).toBe(filterKey({ vlans: [10, 20] }));
    expect(filterKey({ vlans: [10] })).not.toBe(filterKey({}));
    expect(describeFilter(f)).toContain('VLAN 20');
    expect(describeFilter({ vlans: [10, 20] })).toBe('VLAN 10 or 20');
  });

  it('selects, through the engine predicate, exactly the rows whose PduSummary.vlan is on', () => {
    const f = buildTraceFilter(toggleChip(toggleChip(NO_CHIPS, 'vlans', '10'), 'vlans', '30'));
    const kept = EVENTS.filter((e) => matchesTraceFilter(f, e)).map((e) => e.t);
    expect(kept).toEqual([3, 4, 5]);
  });

  it('offers the VIDs the loaded rows carry, plus the ones already on, ascending', () => {
    expect(vlansOf(PAGE)).toEqual([10, 20, 30]);
    expect(vlansOf(PAGE, [99, 10])).toEqual([10, 20, 30, 99]);
    expect(vlansOf(EMPTY_PAGE)).toEqual([]);
  });
});

describe('the VLAN chip row is drawn', () => {
  const chips = (vlans: readonly number[] | undefined, selection = NO_CHIPS): string =>
    renderToStaticMarkup(
      createElement(FilterChips, { idPrefix: 'x', selection, onToggle: vi.fn(), onBackground: vi.fn(), devices, tags: [], ...(vlans === undefined ? {} : { vlans }) }),
    );

  it('in the event list chips: one pressable chip per VLAN, on and off without colour', () => {
    const html = chips([10, 20], toggleChip(NO_CHIPS, 'vlans', '20'));
    expect(html).toContain('id="x-vlans"');
    expect(html).toContain('○ VLAN 10');
    expect(html).toContain('● VLAN 20');
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(chipTitle('vlans', '20', false)).toContain('VLAN 20');
    expect(chipTitle('vlans', '20', true)).toContain('Stop matching');
  });

  it('says so while no tagged frame was seen', () => {
    expect(chips(undefined)).toContain('VLANs appear here once a trunk carries tagged frames.');
    expect(chips([])).toContain('VLANs appear here once a trunk carries tagged frames.');
  });

  it('in the breakpoint editor, which describes and arms a VLAN breakpoint', () => {
    const selection = toggleChip(toggleChip(NO_CHIPS, 'kinds', 'frameTx'), 'vlans', '10');
    const html = renderToStaticMarkup(
      createElement(BreakpointEditor, {
        id: 'bp',
        selection,
        onSelection: vi.fn(),
        armed: true,
        onArm: vi.fn(),
        onRun: vi.fn(),
        busy: false,
        devices,
        tags: [],
        vlans: [10, 20],
        deviceName: (id: string) => id,
      }),
    );
    expect(html).toContain('id="bp-chips-vlans"');
    expect(html).toContain('● VLAN 10');
    expect(html).toContain('○ VLAN 20');
    expect(html).toContain('VLAN 10');
    expect(html).toContain('Breakpoint on');
    expect(html).toContain('kind Sent; VLAN 10');
  });
});
