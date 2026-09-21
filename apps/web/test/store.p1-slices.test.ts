/**
 * The P1 store slices (ARCHITECTURE-P1 §7 "Shell", §8.2 W7 web-shell; store/types.ts header).
 *
 * Three rules are under test: batches are the only write path for what the worker owns (playback mode, trace head,
 * where a breakpoint stopped, capture heads, lab status); the panels own the rest through their patch actions; and
 * a new simulation generation drops everything that belonged to the old world while keeping imported captures,
 * which are the worker's and survive it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptureInfo, LabStatus, ScenarioMeta, SimSnapshot, TraceEvent } from '@netforge/engine';
import { DEFAULT_SIM_FILTERS, type EngineBatch, type StopInfo } from '../src/bridge/protocol';
import { store } from '../src/store/store';

const base = { playing: false, rate: 1, effectiveRate: 1_000_000, dropped: 0 };
let epoch = 700;

function batch(p: Partial<EngineBatch>): EngineBatch {
  return { ...base, epoch, now: 0, events: [], ...p } as EngineBatch;
}

const snap = (extra: Partial<SimSnapshot> = {}): SimSnapshot =>
  ({ now: 0, seed: 1, topologyVersion: 1, devices: [], links: [], inflight: [], sessions: [], pduCount: 0, pendingEvents: 0, ...extra }) as SimSnapshot;

const capture = (id: string, head = 0): CaptureInfo =>
  ({ id, name: id, source: id.startsWith('i_') ? 'import' : 'live', running: true, interfaces: [], head, oldest: 0, dropped: 0 }) as CaptureInfo;

const stopEvent = { t: 4_000, kind: 'frameTx' } as TraceEvent;
const stopped: StopInfo = { cursor: 12, event: stopEvent, reason: 'breakpoint' };

const labStatus = (score: number): LabStatus => ({ lab: 'ccna1-switched-lan', checkedAt: 0, score, total: 40, results: [] });

// The store is a singleton, so each case starts from the state the module was created with.
const DEFAULTS = {
  view: store.getState().view,
  conceptTool: store.getState().conceptTool,
  simMode: { ...store.getState().simMode },
  netscope: { ...store.getState().netscope },
  lab: { ...store.getState().lab },
};

beforeEach(() => {
  const s = store.getState();
  s.setView(DEFAULTS.view, DEFAULTS.conceptTool);
  s.setSimModeUi(DEFAULTS.simMode);
  s.setNetscope(DEFAULTS.netscope);
  s.setLab(DEFAULTS.lab);
  epoch += 1;
  store.getState().applyBatch(batch({ snapshot: snap() }));
});

describe('P1 slice defaults', () => {
  it('starts a first visit on the course landing page (P2), in real time, with no capture and no lab', () => {
    const s = store.getState();
    expect(s.view).toBe('landing');
    expect(s.conceptTool).toBe('subnetting');
    expect(s.simMode.mode).toBe('realtime');
    expect(s.simMode.list).toEqual(DEFAULT_SIM_FILTERS.list);
    expect(s.simMode.breakOn).toBeNull();
    expect(s.simMode.stoppedAt).toBeNull();
    expect(s.netscope.active).toBeNull();
    expect(s.netscope.pane).toBe('packets');
    expect(s.netscope.filterText).toBe('');
    expect(s.lab.active).toBeNull();
    expect(s.lab.status).toBeNull();
  });
});

describe('what the worker owns reaches the store only through batches', () => {
  it('mirrors the playback mode, the trace head and a breakpoint stop', () => {
    store.getState().applyBatch(batch({ playbackMode: 'simulation', traceHead: 88, stopped, snapshot: snap({ now: 4_000 }) }));
    const s = store.getState();
    expect(s.simMode.mode).toBe('simulation');
    expect(s.simMode.traceHead).toBe(88);
    expect(s.simMode.stoppedAt).toEqual(stopped);
  });

  it('clears the stop marker as soon as the clock runs again', () => {
    store.getState().applyBatch(batch({ stopped }));
    expect(store.getState().simMode.stoppedAt).not.toBeNull();
    store.getState().applyBatch(batch({ playing: true, now: 9_000 }));
    expect(store.getState().simMode.stoppedAt).toBeNull();
  });

  it('merges capture heads rather than replacing the map', () => {
    store.getState().applyBatch(batch({ captureHeads: { c_1: 10, i_1: 4 } }));
    store.getState().applyBatch(batch({ captureHeads: { c_1: 25 } }));
    expect(store.getState().netscope.heads).toEqual({ c_1: 25, i_1: 4 });
  });

  it('takes the lab status, including "no lab is loaded any more"', () => {
    const meta = { name: 'ccna1-switched-lan', title: 'Build a switched LAN' } as ScenarioMeta;
    store.getState().setLab({ active: meta, browserOpen: false });
    store.getState().applyBatch(batch({ lab: labStatus(15) }));
    expect(store.getState().lab.status?.score).toBe(15);
    store.getState().applyBatch(batch({ lab: null }));
    expect(store.getState().lab.status).toBeNull();
    // `null` is the worker saying the lab went with the world: the panel offers the catalogue again.
    expect(store.getState().lab.active).toBeNull();
    expect(store.getState().lab.browserOpen).toBe(true);
    // A batch that says nothing about the lab leaves it alone.
    store.getState().applyBatch(batch({ lab: labStatus(25) }));
    store.getState().applyBatch(batch({ now: 1 }));
    expect(store.getState().lab.status?.score).toBe(25);
  });
});

describe('what the panels own', () => {
  it('patches the sim-mode filters, the NetScope panes and the lab without touching the rest', () => {
    const s = store.getState();
    s.setSimModeUi({ list: { kinds: ['drop'] }, breakOn: { kinds: ['frameTx'], tags: ['dhcp-offer'] } });
    expect(store.getState().simMode.list).toEqual({ kinds: ['drop'] });
    expect(store.getState().simMode.breakOn?.tags).toEqual(['dhcp-offer']);
    expect(store.getState().simMode.mode).toBe('realtime');

    s.setNetscope({ captures: [capture('c_1', 3)], active: 'c_1', filterText: 'ip.addr == 10.0.0.1', applied: 'ip.addr == 10.0.0.1', selected: 2, pane: 'stream', streamKey: 'tcp:a-b' });
    const ns = store.getState().netscope;
    expect(ns.active).toBe('c_1');
    expect(ns.selected).toBe(2);
    expect(ns.pane).toBe('stream');
    expect(ns.heads).toEqual({});

    const meta = { name: 'ccna1-switched-lan', title: 'Build a switched LAN' } as ScenarioMeta;
    s.setLab({ active: meta, browserOpen: false });
    expect(store.getState().lab.active?.name).toBe('ccna1-switched-lan');
    expect(store.getState().lab.browserOpen).toBe(false);
    expect(store.getState().lab.status).toBeNull();
  });

  it('switches to a concept tool and back to the topology', () => {
    store.getState().setView('concept', 'ipv6');
    expect(store.getState().view).toBe('concept');
    expect(store.getState().conceptTool).toBe('ipv6');
    store.getState().setView('topology');
    // Leaving the view keeps the tool, so coming back opens the same one.
    expect(store.getState().view).toBe('topology');
    expect(store.getState().conceptTool).toBe('ipv6');
  });
});

describe('a new simulation generation', () => {
  it('drops the old world: the stop marker, live captures and the lab status', () => {
    const s = store.getState();
    s.setNetscope({ captures: [capture('c_1', 5), capture('i_1', 9)], active: 'c_1', selected: 4, streamKey: 'tcp:a-b' });
    s.setLab({ active: { name: 'ccna1-switched-lan', title: 'Build a switched LAN' } as ScenarioMeta, browserOpen: false });
    store.getState().applyBatch(batch({ captureHeads: { c_1: 5, i_1: 9 }, stopped, lab: labStatus(30) }));
    expect(store.getState().lab.status?.score).toBe(30);

    epoch += 1;
    store.getState().applyBatch(batch({ snapshot: snap() }));

    const after = store.getState();
    expect(after.simMode.stoppedAt).toBeNull();
    expect(after.lab.status).toBeNull();
    expect(after.lab.active).toBeNull();
    expect(after.lab.browserOpen).toBe(true);
    expect(after.netscope.captures.map((c) => c.id)).toEqual(['i_1']);
    expect(after.netscope.heads).toEqual({ i_1: 9 });
    expect(after.netscope.active).toBeNull();
    expect(after.netscope.selected).toBeNull();
    expect(after.netscope.streamKey).toBeNull();
  });

  it('keeps an imported capture selected across the change', () => {
    store.getState().setNetscope({ captures: [capture('i_2', 7)], active: 'i_2', selected: 1 });
    epoch += 1;
    store.getState().applyBatch(batch({ snapshot: snap() }));
    const after = store.getState().netscope;
    expect(after.active).toBe('i_2');
    expect(after.selected).toBe(1);
  });

  it('keeps the filters and the mode the learner chose', () => {
    store.getState().setSimModeUi({ list: { kinds: ['drop'] }, breakOn: { kinds: ['frameTx'] } });
    store.getState().applyBatch(batch({ playbackMode: 'simulation' }));
    epoch += 1;
    store.getState().applyBatch(batch({ snapshot: snap(), playbackMode: 'simulation' }));
    const after = store.getState().simMode;
    expect(after.list).toEqual({ kinds: ['drop'] });
    expect(after.breakOn).toEqual({ kinds: ['frameTx'] });
    expect(after.mode).toBe('simulation');
  });
});
