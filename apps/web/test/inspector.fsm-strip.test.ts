// State-machine history strip [SHOULD S14] (ARCHITECTURE-P2 D19, §6, spec §9.5; §7 W6 web-inspector): the
// transitions the P2 daemons report as `debug` events with `DebugEvent.fsm`, grouped per machine and subject for the
// selected device or port (a bundle shows its members), in time order with from → to and the cause, cut at the
// reviewed instant, with a keyboard-reachable text form. Real transitions from a spanning-tree world close the loop.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSimulation } from '@netforge/engine';
import type { FsmTransition, SimTime, TraceEvent } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  // the store's live timeline slice (no review): `UiState.timeline` is required since the W8 exit gate
  const timeline = { review: null, head: null, lanes: [], seeking: false, reviewEvents: [] };
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], timeline, select: vi.fn() };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import { FSM_STRIP_LIMIT, FsmStrip, fsmEntrySpoken, fsmEntryText, fsmHistory, fsmStepLevels, fsmSubjectSummary } from '../src/inspector/FsmStrip';

// ── fixtures ─────────────────────────────────────────────────────────────────

const S = 1_000_000_000;

function fsm(t: SimTime, device: string, transition: Partial<FsmTransition> & Pick<FsmTransition, 'machine' | 'subject' | 'from' | 'to'>, category = 'spanning-tree events'): TraceEvent {
  return { t, kind: 'debug', event: { at: t, device, process: 'stp', category, message: `${transition.subject}: ${transition.from} -> ${transition.to}`, fsm: transition as FsmTransition } };
}

const EVENTS: TraceEvent[] = [
  { t: 0, kind: 'debug', event: { at: 0, device: 'sw1', process: 'stp', category: 'spanning-tree events', message: 'plain debug line' } },
  fsm(15 * S, 'sw1', { machine: 'stp-port', subject: 'VLAN0010 GigabitEthernet0/1', port: 'GigabitEthernet0/1', instance: 10, from: 'listening', to: 'learning', cause: 'forward delay expired' }),
  fsm(2 * S, 'sw1', { machine: 'stp-port', subject: 'VLAN0010 GigabitEthernet0/1', port: 'GigabitEthernet0/1', instance: 10, from: 'blocking', to: 'listening', cause: 'port came up', pdu: 42 }),
  fsm(30 * S, 'sw1', { machine: 'stp-port', subject: 'VLAN0010 GigabitEthernet0/1', port: 'GigabitEthernet0/1', instance: 10, from: 'learning', to: 'forwarding', cause: 'forward delay expired' }),
  fsm(3 * S, 'sw1', { machine: 'dtp', subject: 'GigabitEthernet0/1', port: 'GigabitEthernet0/1', from: 'access', to: 'trunk', cause: 'neighbour asked for a trunk' }, 'dtp'),
  fsm(4 * S, 'sw1', { machine: 'lacp', subject: 'Port-channel1 GigabitEthernet0/2', port: 'GigabitEthernet0/2', instance: 1, from: 'waiting', to: 'bundled' }, 'etherchannel'),
  fsm(5 * S, 'sw1', { machine: 'stp-port', subject: 'VLAN0010 GigabitEthernet0/3', port: 'GigabitEthernet0/3', from: 'blocking', to: 'mystery-state' }),
  fsm(6 * S, 'sw2', { machine: 'stp-port', subject: 'VLAN0010 GigabitEthernet0/1', port: 'GigabitEthernet0/1', from: 'blocking', to: 'listening' }),
  fsm(7 * S, 'wlc', { machine: 'capwap-ac', subject: 'access point 02:00:00:00:0a:00', from: 'join', to: 'configure' }, 'capwap'),
];

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

// ── model ────────────────────────────────────────────────────────────────────

describe('fsmHistory', () => {
  it('groups one device\'s transitions per machine and subject, in machine order, each in time order', () => {
    const h = fsmHistory(EVENTS, { device: 'sw1' });
    expect(h.map((x) => `${x.machine} ${x.subject}`)).toEqual([
      'stp-port VLAN0010 GigabitEthernet0/1',
      'stp-port VLAN0010 GigabitEthernet0/3',
      'dtp GigabitEthernet0/1',
      'lacp Port-channel1 GigabitEthernet0/2',
    ]);
    const stp = h[0]!;
    expect(stp.entries.map((e) => `${e.from}>${e.to}`)).toEqual(['blocking>listening', 'listening>learning', 'learning>forwarding']);
    expect(stp.entries[0]).toEqual({ t: 2 * S, from: 'blocking', to: 'listening', cause: 'port came up', pdu: 42 });
    expect(stp.current).toBe('forwarding');
    expect(stp.port).toBe('GigabitEthernet0/1');
    expect(stp.instance).toBe(10);
    expect(stp.omitted).toBe(0);
  });

  it('narrows to a port (its own transitions and a bundle\'s members), to machines, and to the reviewed instant', () => {
    expect(fsmHistory(EVENTS, { device: 'sw1', port: 'GigabitEthernet0/1' }).map((x) => x.machine)).toEqual(['stp-port', 'dtp']);
    expect(fsmHistory(EVENTS, { device: 'sw1', port: 'Port-channel1' }).map((x) => x.subject)).toEqual(['Port-channel1 GigabitEthernet0/2']);
    expect(fsmHistory(EVENTS, { device: 'sw1', machines: ['dtp'] }).map((x) => x.machine)).toEqual(['dtp']);
    const past = fsmHistory(EVENTS, { device: 'sw1', port: 'GigabitEthernet0/1', until: 15 * S });
    expect(past[0]!.current).toBe('learning');
    expect(past[0]!.entries).toHaveLength(2);
    expect(fsmHistory(EVENTS, { device: 'pc1' })).toEqual([]);
    expect(fsmHistory(EVENTS, { device: 'wlc' })[0]!.current).toBe('configure');
  });

  it('keeps the newest transitions per subject and counts the rest', () => {
    const many: TraceEvent[] = [];
    for (let i = 0; i < FSM_STRIP_LIMIT + 5; i++) many.push(fsm(i * S, 'sw1', { machine: 'dtp', subject: 'GigabitEthernet0/1', from: i % 2 === 0 ? 'access' : 'trunk', to: i % 2 === 0 ? 'trunk' : 'access' }, 'dtp'));
    const [h] = fsmHistory(many, { device: 'sw1' });
    expect(h!.entries).toHaveLength(FSM_STRIP_LIMIT);
    expect(h!.omitted).toBe(5);
    expect(h!.entries[0]!.t).toBe(5 * S);
    expect(fsmHistory(many, { device: 'sw1', limit: 3 })[0]!.entries.map((e) => e.t)).toEqual([22 * S, 23 * S, 24 * S]);
  });

  it('has a text form for every transition and every subject', () => {
    const [stp] = fsmHistory(EVENTS, { device: 'sw1' });
    expect(fsmEntryText(stp!.entries[1]!)).toBe('00:00:15.000000: listening → learning (forward delay expired)');
    expect(fsmEntryText({ t: 0, from: 'a', to: 'b' })).toBe('00:00:00.000000: a → b');
    expect(fsmEntrySpoken(stp!.entries[0]!)).toBe('At 00:00:02.000000, from blocking to listening, because port came up; press Enter to show packet 42, which caused it');
    expect(fsmSubjectSummary(stp!)).toBe('Spanning-tree port VLAN0010 GigabitEthernet0/1: now forwarding after 3 changes');
  });

  it('lays the states out by their place in the machine vocabulary, unknown words above the known ones', () => {
    const h = fsmHistory(EVENTS, { device: 'sw1' });
    // stp-port states: disabled 0, blocking 1, discarding 2, listening 3, learning 4, forwarding 5
    expect(fsmStepLevels(h[0]!)).toEqual([1, 3, 4, 5]);
    expect(fsmStepLevels(h[1]!)).toEqual([1, 6]);
    expect(fsmStepLevels({ machine: 'not-a-machine', entries: [{ t: 0, from: 'x', to: 'y' }] })).toEqual([0, 0]);
    expect(fsmStepLevels({ machine: 'dtp', entries: [] })).toEqual([]);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('FsmStrip', () => {
  it('renders each subject with its current state and an ordered, keyboard-reachable list of transitions', () => {
    const html = renderToStaticMarkup(createElement(FsmStrip, { device: 'sw1', port: 'GigabitEthernet0/1', events: EVENTS }));
    const t = text(html);
    expect(t).toContain('Spanning-tree port VLAN0010 GigabitEthernet0/1');
    expect(t).toContain('Now forwarding');
    expect(t).toContain('00:00:02.000000: blocking → listening (port came up) packet #42');
    expect(t).toContain('00:00:30.000000: learning → forwarding (forward delay expired)');
    expect(t).toContain('Trunk negotiation GigabitEthernet0/1');
    // one tab stop per list (the newest transition), the others reachable with the arrow keys
    expect(html.match(/<ol /g)?.length).toBe(2);
    expect(html.match(/<li[^>]*tabindex="0"/g)?.length).toBe(2);
    expect(html.match(/<li[^>]*tabindex="-1"/g)?.length).toBe(2);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="At 00:00:02.000000, from blocking to listening, because port came up; press Enter to show packet 42, which caused it"');
    // the drawing is decorative: its facts are all in the list
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('says so when nothing matches, or renders nothing when asked to hide', () => {
    expect(text(renderToStaticMarkup(createElement(FsmStrip, { device: 'pc1', events: EVENTS })))).toContain('No protocol state change is in the recent trace.');
    expect(text(renderToStaticMarkup(createElement(FsmStrip, { device: 'sw1', port: 'GigabitEthernet0/9', events: EVENTS })))).toContain('No protocol state change of this port is in the recent trace.');
    expect(renderToStaticMarkup(createElement(FsmStrip, { device: 'pc1', events: EVENTS, hideWhenEmpty: true }))).toBe('');
  });

  it('reads the store trace by default and stops at the reviewed instant', () => {
    store.setState({ events: EVENTS, timeline: { review: { t: 15 * S }, head: null, lanes: [], seeking: false, reviewEvents: [] } });
    const t = text(renderToStaticMarkup(createElement(FsmStrip, { device: 'sw1', machines: ['stp-port'] })));
    expect(t).toContain('Now learning');
    expect(t).not.toContain('Trunk negotiation');
    store.setState({ timeline: { review: null, head: null, lanes: [], seeking: false, reviewEvents: [] } });
    expect(text(renderToStaticMarkup(createElement(FsmStrip, { device: 'sw1', machines: ['stp-port'] })))).toContain('Now forwarding');
    store.setState({ events: [] });
  });

  it('shows the transitions a real spanning-tree world reports', () => {
    const sim = createSimulation({ seed: 21, profile: 'P2' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 0, y: 0 } });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', position: { x: 200, y: 0 } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
    sim.runFor(70 * S);
    const events = sim.traceQuery({ from: 0, limit: 200_000 }).events.map((e) => e.event);
    const h = fsmHistory(events, { device: 'sw1', port: 'GigabitEthernet0/1' });
    const port = h.find((x) => x.machine === 'stp-port' && x.subject === 'VLAN0001 GigabitEthernet0/1');
    expect(port).toBeDefined();
    for (const subject of h) {
      expect(subject.subject.split(' ')).toContain('GigabitEthernet0/1');
      const times = subject.entries.map((e) => e.t);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    // the port also reports its role under the same subject; its STATE changes chain from one to the next
    const states = port!.entries.filter((e) => [e.from, e.to].every((s) => ['disabled', 'blocking', 'discarding', 'listening', 'learning', 'forwarding'].includes(s)));
    expect(states.map((e) => e.to)).toEqual(['listening', 'learning', 'forwarding']);
    states.forEach((e, i) => {
      if (i > 0) expect(e.from).toBe(states[i - 1]!.to);
    });
    expect(port!.current).toBe('forwarding');
    const t = text(renderToStaticMarkup(createElement(FsmStrip, { device: 'sw1', port: 'GigabitEthernet0/1', events })));
    expect(t).toContain('Spanning-tree port VLAN0001 GigabitEthernet0/1 Now forwarding');
    expect(t).toContain('00:00:30.000000: disabled → listening (port came up)');
  });
});
