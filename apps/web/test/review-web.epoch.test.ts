import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../src/store/store';

const snap = (sessions: { id: string; prompt: string }[] = []) =>
  ({ now: 0, devices: [], links: [], inflight: [], sessions }) as never;
const base = { playing: false, rate: 1, effectiveRate: 1, dropped: 0 };

const oldRunEvents = [
  { t: 2, kind: 'cliOutput', session: 's_1', text: 'OLD RUN\n' },
  { t: 3, kind: 'frameTx', pdu: { id: 1 }, link: 'l1', from: { device: 'a', port: 'p' }, to: { device: 'b', port: 'p' }, txStart: 3, txEnd: 4, arrive: 9e9 },
  { t: 4, kind: 'drop', pdu: { id: 1 }, device: 'a', reason: 'no-route' },
  { t: 4, kind: 'tableWrite', device: 'a', table: 'arp', key: '10.0.0.1' },
];

describe('simulation epoch clears mirrored history', () => {
  beforeEach(() => {
    // Force a fresh generation so each case starts from an empty mirror.
    store.getState().applyBatch({ ...base, epoch: -99, now: 0, events: [], snapshot: snap() } as never);
  });

  it('reset batch (new epoch) drops old-run events, inflight, markers and flashes', () => {
    store.getState().applyBatch({
      ...base,
      epoch: 0,
      now: 5,
      // No snapshot here: an authoritative snapshot without the frame would prune it.
      events: oldRunEvents,
    } as never);
    store.getState().select({ kind: 'pdu', id: 1 } as never);
    let st = store.getState();
    expect(st.events.length).toBe(4);
    expect(st.inflight.length).toBe(1);
    expect(st.dropMarkers.length).toBe(1);
    expect(st.tableFlashes.length).toBe(1);

    // the worker's reset(): fresh sim, new epoch, now 0, empty snapshot
    store.getState().applyBatch({ ...base, epoch: 1, now: 0, events: [], snapshot: snap() } as never);
    st = store.getState();
    expect(st.epoch).toBe(1);
    expect(st.events).toHaveLength(0);
    expect(st.events.filter((e) => e.kind === 'cliOutput' && e.session === 's_1')).toHaveLength(0);
    expect(st.inflight).toHaveLength(0);
    expect(st.dropMarkers).toHaveLength(0);
    expect(st.tableFlashes).toHaveLength(0);
    expect(st.droppedEvents).toBe(0);
    expect(st.inspectedPdu).toBeNull();
    expect(st.selection).toBeNull();
  });

  it('batches within the same epoch still accumulate events', () => {
    store.getState().applyBatch({
      ...base,
      epoch: 7,
      now: 1,
      events: [{ t: 1, kind: 'cliOutput', session: 's_1', text: 'a\n' }],
    } as never);
    store.getState().applyBatch({
      ...base,
      epoch: 7,
      now: 2,
      events: [{ t: 2, kind: 'cliOutput', session: 's_1', text: 'b\n' }],
      snapshot: snap([{ id: 's_1', prompt: 'R1>' }]),
    } as never);
    const evs = store.getState().events;
    expect(evs.map((e) => (e.kind === 'cliOutput' ? e.text : ''))).toEqual(['a\n', 'b\n']);
  });

  it('P0.5: a new epoch also clears desktop windows, the canvas focus, left-out counts and P1 run state', () => {
    store.getState().applyBatch({ ...base, epoch: 20, now: 0, events: [], snapshot: snap([]) } as never);
    const deviceSnap = { now: 0, devices: [{ id: 'pc1', name: 'PC1', ports: [] }], links: [], inflight: [], sessions: [] } as never;
    store.getState().applyBatch({ ...base, epoch: 20, now: 1, events: [], snapshot: deviceSnap, eventsTruncated: 4 } as never);
    store.getState().openDesktopWindow('pc1', 'desktop.ip-config');
    store.getState().setCanvasFocus('pc1');
    store.setState({
      simMode: { mode: 'simulation', list: {}, breakOn: null, stoppedAt: { cursor: 3, event: oldRunEvents[0], reason: 'step' }, traceHead: 3 },
      netscope: {
        captures: [{ id: 'c_1' }, { id: 'i_1' }],
        active: 'c_1',
        filterText: '',
        applied: '',
        selected: 2,
        pane: 'packets',
        streamKey: 'k',
        heads: { c_1: 5, i_1: 9 },
      },
      lab: { active: null, status: { lab: 'x', checkedAt: 0, score: 0, total: 1, results: [] }, browserOpen: false },
    } as never);
    let st = store.getState();
    expect(st.eventsTruncated).toBe(4);
    expect(st.desktopWindows).toHaveLength(1);
    expect(st.a11y.canvasFocus).toBe('pc1');

    // Same epoch: nothing is cleared.
    store.getState().applyBatch({ ...base, epoch: 20, now: 2, events: [], snapshot: deviceSnap } as never);
    expect(store.getState().desktopWindows).toHaveLength(1);

    store.getState().applyBatch({ ...base, epoch: 21, now: 0, events: [], snapshot: deviceSnap } as never);
    st = store.getState();
    expect(st.desktopWindows).toHaveLength(0);
    expect(st.a11y.canvasFocus).toBeNull();
    expect(st.eventsTruncated).toBe(0);
    expect(st.simMode?.stoppedAt).toBeNull();
    expect(st.netscope?.captures.map((c) => c.id)).toEqual(['i_1']);
    expect(st.netscope?.heads).toEqual({ i_1: 9 });
    expect(st.netscope?.active).toBeNull();
    expect(st.netscope?.selected).toBeNull();
    expect(st.lab?.status).toBeNull();
    // The lab slice is reset whole, so a lab of the previous world cannot outlive it (§4.13).
    expect(st.lab?.active).toBeNull();
    expect(st.lab?.browserOpen).toBe(true);
  });

  it('P0.5: a snapshot without a device closes its windows and drops the canvas focus', () => {
    const one = { now: 0, devices: [{ id: 'pc1', name: 'PC1', ports: [] }], links: [], inflight: [], sessions: [] } as never;
    store.getState().applyBatch({ ...base, epoch: 30, now: 0, events: [], snapshot: one } as never);
    store.getState().openDesktopWindow('pc1', 'desktop.wifi');
    store.getState().setCanvasFocus('pc1');
    store.getState().select({ kind: 'device', id: 'pc1' } as never);
    store.getState().applyBatch({ ...base, epoch: 30, now: 1, events: [], snapshot: snap() } as never);
    const st = store.getState();
    expect(st.desktopWindows).toHaveLength(0);
    expect(st.a11y.canvasFocus).toBeNull();
    expect(st.selection).toBeNull();
  });
});
