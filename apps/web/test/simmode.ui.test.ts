// Simulation-mode panel, filter chips and breakpoint editor (ARCHITECTURE-P1 §4.11, §7 "Sim-mode list", §16):
// server-rendered smoke tests over a mocked store and a mocked engine, in the style of desktop.ui / palette.ui.
//
// What is checked here is what a learner can see and reach: every chip is a pressed-or-not button with a
// non-colour glyph, the list is one keyboard-reachable listbox whose rows are options with a position, the
// breakpoint controls refuse to run before a breakpoint is set, and the stop banner is a live region. Rendering
// the panel must not call the engine — every query happens in an effect, which the server never runs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, createSimulation } from '@netforge/engine';
import type { ScenarioInfo, SimSnapshot, TraceEvent } from '@netforge/engine';

const api = vi.hoisted(() => ({
  setSimFilters: vi.fn(),
  setPlaybackMode: vi.fn(),
  stepToNext: vi.fn(),
  runUntilStop: vi.fn(),
  traceQuery: vi.fn(),
}));
vi.mock('../src/bridge/client', () => ({
  engine: api,
  fmtSimTime: (t: number) => `T${t}`,
  fmtDuration: (t: number) => `${t} ns`,
}));
// A plain selector store: server rendering reads the current state.
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { FilterChips, chipTitle } from '../src/simmode/FilterChips';
import { BreakpointEditor, StopBanner } from '../src/simmode/BreakpointEditor';
import { SimEventRow, SimEventsPanel } from '../src/simmode/SimEventsPanel';
import {
  BREAKPOINT_PRESETS,
  DEFAULT_LIST_CHIPS,
  NO_CHIPS,
  chipsFromFilter,
  toggleChip,
  type ChipSelection,
} from '../src/simmode/sim-events-client';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function labOf(name: string): ScenarioInfo {
  const lab = SCENARIOS.find((s) => s.name === name);
  if (lab === undefined) throw new Error(`no scenario called ${name}`);
  return lab;
}

/** A booted-free world: enough for device names and port labels. */
const snapshot: SimSnapshot = (() => {
  const sim = createSimulation({ seed: 1 });
  sim.loadTopology(labOf('ccna1-dhcpv4-server').build());
  return sim.snapshot();
})();

const offer: TraceEvent = {
  t: 1_500_000,
  kind: 'frameTx',
  pdu: { id: 7, proto: 'dhcp', size: 342, summary: 'address offer for PC1', layers: ['ethernet', 'ipv4', 'udp', 'dhcp'], tag: 'dhcp-offer' },
  link: 'l1',
  from: { device: snapshot.devices[0]!.id, port: 'Gi0' },
  to: { device: snapshot.devices[1]!.id, port: 'Gi0' },
  txStart: 1_500_000,
  txEnd: 1_500_100,
  arrive: 1_500_200,
};

function baseState(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    epoch: 1,
    now: 2_000_000,
    playing: false,
    snapshot,
    snapshotIndex: undefined,
    events: [],
    droppedEvents: 0,
    selection: null,
    simMode: { mode: 'simulation', list: undefined, breakOn: null, stoppedAt: null, traceHead: 0 },
    select: vi.fn(),
    setSimModeUi: vi.fn(),
    toast: vi.fn(),
    ...patch,
  };
}

const devices = snapshot.devices.map((d) => ({ id: d.id, name: d.name }));

beforeEach(() => {
  vi.clearAllMocks();
  api.traceQuery.mockResolvedValue({ events: [], next: 0, oldest: 0, head: 0 });
  api.setSimFilters.mockResolvedValue(undefined);
  setState(baseState());
});

// ── filter chips ────────────────────────────────────────────────────────────

describe('the filter chips', () => {
  const render = (selection: ChipSelection): string =>
    renderToStaticMarkup(
      createElement(FilterChips, {
        idPrefix: 'x',
        selection,
        onToggle: vi.fn(),
        onBackground: vi.fn(),
        devices,
        tags: ['dhcp-offer', 'arp-request'],
      }),
    );

  it('draws one pressable chip per trace kind, protocol, device and message', () => {
    const html = render(DEFAULT_LIST_CHIPS);
    expect(html).toContain('Event kind: Packets');
    expect(html).toContain('Event kind: Media');
    expect(html).toContain('Protocol');
    expect(html).toContain('Device');
    expect(html).toContain('Message');
    for (const d of devices) expect(html).toContain(d.name);
    expect(html).toContain('dhcp-offer');
    expect(html).toContain('arp-request');
  });

  it('shows on and off without relying on colour', () => {
    const html = render(DEFAULT_LIST_CHIPS);
    // the default list is Sent + Dropped + Table write
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('●');
    expect(html).toContain('○');
    expect(html).toContain('is-off');
    const off = render(NO_CHIPS);
    expect(off).not.toContain('aria-pressed="true"');
  });

  it('badges every protocol chip with its vocabulary letter', () => {
    const html = render(toggleChip(NO_CHIPS, 'protos', 'dhcp'));
    expect(html).toContain('DH DHCP');
    expect(html).toContain('4 IPv4');
    expect(html).toContain('A ARP');
  });

  it('offers the keepalive switch and reports its state', () => {
    expect(render(NO_CHIPS)).toContain('○ Keepalives');
    expect(render({ ...NO_CHIPS, background: true })).toContain('● Keepalives');
  });

  it('says in the tooltip what a chip does and how it is drawn', () => {
    expect(chipTitle('kinds', 'drop', false)).toContain('Dropped');
    expect(chipTitle('kinds', 'drop', true)).toContain('Stop matching');
    expect(chipTitle('protos', 'dhcp', false)).toContain('capsule');
    expect(chipTitle('protos', 'dhcp', false)).toContain('badged DH');
    expect(chipTitle('devices', 'PC1', false)).toContain('PC1');
    expect(chipTitle('tags', 'dhcp-offer', false)).toContain('dhcp-offer');
  });

  it('says so when there is nothing to offer yet', () => {
    const html = renderToStaticMarkup(
      createElement(FilterChips, { idPrefix: 'x', selection: NO_CHIPS, onToggle: vi.fn(), onBackground: vi.fn(), devices: [], tags: [] }),
    );
    expect(html).toContain('No devices yet.');
    expect(html).toContain('Tagged messages appear here');
  });
});

// ── breakpoint editor ───────────────────────────────────────────────────────

describe('the breakpoint editor', () => {
  const render = (selection: ChipSelection, armed: boolean, busy = false): string =>
    renderToStaticMarkup(
      createElement(BreakpointEditor, {
        id: 'bp',
        selection,
        onSelection: vi.fn(),
        armed,
        onArm: vi.fn(),
        onRun: vi.fn(),
        busy,
        devices,
        tags: ['dhcp-offer'],
        deviceName: (id: string) => id,
      }),
    );

  it('offers a ready-made breakpoint for each of the moments a lab stops at', () => {
    const html = render(NO_CHIPS, false);
    for (const p of BREAKPOINT_PRESETS) expect(html).toContain(p.label);
  });

  it('refuses to arm or run until a chip is on', () => {
    const html = render(NO_CHIPS, false);
    expect(html).toContain('Pick at least one chip to set a breakpoint.');
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('marks the armed preset and describes what it will stop at', () => {
    const html = render(chipsFromFilter(BREAKPOINT_PRESETS[0]!.filter), true);
    expect(html).toContain('Breakpoint on');
    expect(html).toContain('kind Sent');
    expect(html).toContain('protocol DHCP');
    expect(html).toContain('message dhcp-offer');
    // the preset chip for "first address offer" is pressed
    expect(html).toContain('● First address offer');
  });

  it('lets the run start only once the breakpoint is armed', () => {
    const off = render(chipsFromFilter(BREAKPOINT_PRESETS[0]!.filter), false);
    const on = render(chipsFromFilter(BREAKPOINT_PRESETS[0]!.filter), true);
    expect(off).toContain('Run to the breakpoint');
    expect((off.match(/disabled/g) ?? []).length).toBeGreaterThan((on.match(/disabled/g) ?? []).length);
  });
});

// ── the stop banner ─────────────────────────────────────────────────────────

describe('the stop banner', () => {
  // A live region has to exist before its text arrives, or nothing is announced when the clock stops (§16),
  // so the banner stays mounted and empty instead of rendering nothing at all.
  it('stays mounted and empty when the run has not stopped', () => {
    const html = renderToStaticMarkup(createElement(StopBanner, { stopped: null, text: '', note: null, onReveal: vi.fn() }));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('is-empty');
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
  });

  it('announces where and why the clock stopped', () => {
    const html = renderToStaticMarkup(
      createElement(StopBanner, {
        stopped: { cursor: 12, event: offer, reason: 'breakpoint' },
        text: 'the offer left the router',
        note: null,
        onReveal: vi.fn(),
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Paused at the breakpoint');
    expect(html).toContain('T1500000');
    expect(html).toContain('the offer left the router');
    expect(html).toContain('Show the event');
  });

  it('reports a step that found nothing', () => {
    const html = renderToStaticMarkup(
      createElement(StopBanner, { stopped: null, text: '', note: 'No matching event in the next 10 s', onReveal: vi.fn() }),
    );
    expect(html).toContain('No matching event in the next 10 s');
    expect(html).toContain('aria-live="polite"');
  });
});

// ── one row ─────────────────────────────────────────────────────────────────

describe('one event row', () => {
  const render = (over: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(SimEventRow, {
        id: 'r7',
        event: offer,
        text: 'the offer left the router',
        position: 3,
        total: 40,
        focused: false,
        stopped: false,
        onActivate: vi.fn(),
        ...over,
      } as never),
    );

  it('is an option with its place in the list, for a screen reader', () => {
    const html = render();
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-posinset="3"');
    expect(html).toContain('aria-setsize="40"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('id="r7"');
  });

  it('names the kind in words and the protocol by its badge letter', () => {
    const html = render();
    expect(html).toContain('Sent');
    expect(html).toContain('DH DHCP');
    expect(html).toContain('T1500000');
    expect(html).toContain('the offer left the router');
  });

  it('marks the row the run stopped on with a glyph and says so in its label', () => {
    const html = render({ stopped: true });
    expect(html).toContain('⏸');
    expect(html).toContain('Stopped here.');
  });

  it('keeps every row the same height, which the virtual window depends on', () => {
    expect(render()).toContain('height:22px');
  });
});

// ── the panel ───────────────────────────────────────────────────────────────

describe('the simulation-mode panel', () => {
  const render = (): string => renderToStaticMarkup(createElement(SimEventsPanel));

  it('renders its controls and an empty, keyboard-reachable list', () => {
    const html = render();
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="Simulation events"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Next matching event');
    expect(html).toContain('Event by event');
    expect(html).toContain('No event matches yet.');
  });

  it('touches no engine method while rendering: every query lives in an effect', () => {
    render();
    expect(api.traceQuery).not.toHaveBeenCalled();
    expect(api.setSimFilters).not.toHaveBeenCalled();
    expect(api.stepToNext).not.toHaveBeenCalled();
    expect(api.runUntilStop).not.toHaveBeenCalled();
  });

  it('starts from the stored list filter when the shell has one, and from the §4.11 default otherwise', () => {
    expect(render()).toContain('kind Sent or Dropped or Table write');
    setState(baseState({ simMode: { mode: 'simulation', list: { kinds: ['log'] }, breakOn: null, stoppedAt: null, traceHead: 0 } }));
    const html = render();
    expect(html).toContain('kind Log');
    expect(html).not.toContain('kind Sent or Dropped');
  });

  it('works before the shell has wired the sim-mode slice', () => {
    setState(baseState({ simMode: undefined }));
    const html = render();
    expect(html).toContain('role="listbox"');
    expect(html).toContain('Free running');
  });

  it('shows the breakpoint editor only when it is opened, and marks it armed', () => {
    expect(render()).not.toContain('Run to the breakpoint');
    setState(
      baseState({
        simMode: { mode: 'simulation', list: undefined, breakOn: BREAKPOINT_PRESETS[0]!.filter, stoppedAt: null, traceHead: 0 },
      }),
    );
    expect(render()).toContain('● Breakpoint');
  });

  it('carries a stop the store mirrored from the worker batch', () => {
    setState(
      baseState({
        simMode: { mode: 'simulation', list: undefined, breakOn: null, stoppedAt: { cursor: 5, event: offer, reason: 'breakpoint' }, traceHead: 9 },
      }),
    );
    const html = render();
    expect(html).toContain('Paused at the breakpoint');
    expect(html).toContain('address offer for PC1');
  });

  it('counts the rows it holds and says whether it is following the tail', () => {
    const html = render();
    expect(html).toContain('0 rows');
    expect(html).toContain('Following');
  });

  it('keeps the list defaults the §4.11 brief fixes', () => {
    expect(DEFAULT_LIST_CHIPS.kinds).toEqual(['frameTx', 'drop', 'tableWrite']);
    expect(DEFAULT_LIST_CHIPS.background).toBe(false);
  });
});
