import { describe, expect, it } from 'vitest';
import { store } from '../src/store/store';
import { attachCanvasAnnouncer } from '../src/canvas/a11y/announcer';

const base = { playing: false, rate: 1, effectiveRate: 1, dropped: 0 };
const snap = () => ({ now: 0, devices: [], links: [], inflight: [], sessions: [], topologyVersion: 0 }) as never;
const collision = (t: number) => ({ t, kind: 'collision', stations: [{ device: 'd1', port: 'e0' }, { device: 'd2', port: 'e0' }], late: false });

describe('review p0.5: canvas announcer after an epoch change with an empty ring', () => {
  it('announces the first events of the new generation', () => {
    store.getState().applyBatch({ ...base, epoch: 500, now: 0, events: [collision(1)], snapshot: snap() } as never);
    const emitted: string[] = [];
    const detach = attachCanvasAnnouncer(store, { minGapMs: 0, now: () => 0 });
    const unsub = store.subscribe((s, p) => {
      if (s.a11y.announcement !== p.a11y.announcement && s.a11y.announcement) emitted.push(s.a11y.announcement.text);
    });
    // reset(): new epoch, empty ring
    store.getState().applyBatch({ ...base, epoch: 501, now: 0, events: [], snapshot: snap() } as never);
    // first real batch of the new run
    store.getState().applyBatch({ ...base, epoch: 501, now: 5, events: [collision(5)] } as never);
    unsub();
    detach();
    expect(emitted.some((t) => t.includes('Collision'))).toBe(true);
  });
});
