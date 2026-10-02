/**
 * worker.tx-backlog — the batcher keeps a sender's FIFO backlog current (ARCHITECTURE-P3 D16, §2.8, §7 W2 sim; W2 fix,
 * verified finding 6; `bridge/worker/batch.ts`, a reviewed seam edit of web-shell's file).
 *
 * A port's `txBacklog` shrinks at each `txComplete`, which writes no trace event, so the dirty tracker alone (which marks
 * a sender at its `frameTx`) would leave the last backlog it posted in the store. The batcher feeds the engine's
 * `TxBacklogWatch` every drained event and merges its `drain(now)` into the dirty set on every post: the sender stays in
 * the deltas while it has a frame waiting, once more after its last committed frame has ended, and then no longer.
 * Driven against a fake simulation (only what the batcher reads), with the wall clock in the host's hands.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, PduSummary, SimSnapshot, Simulation, TraceEvent } from '@netforge/engine';
import { SNAPSHOT_EVERY_MS, type EngineBatch } from '../src/bridge/protocol';
import { createBatcher } from '../src/bridge/worker/batch';

const DEVICES: readonly DeviceId[] = ['pc1', 'sw1', 'pc2', 'pc3', 'pc4', 'pc5'];

/** A frame `pc1` commits on its uplink at `t`, starting at `txStart` (behind a busy transmitter when txStart > t). */
function frameTx(t: number, txStart: number, txEnd: number): TraceEvent {
  const pdu = { id: 1, protocols: ['ethernet'], bytes: 64 } as unknown as PduSummary;
  return {
    t,
    kind: 'frameTx',
    pdu,
    link: 'l_1',
    from: { device: 'pc1', port: 'GigabitEthernet0' },
    to: { device: 'sw1', port: 'FastEthernet0/1' },
    txStart,
    txEnd,
    arrive: txEnd + 1,
  } as TraceEvent;
}

/** A fake simulation: a trace the test appends to, a clock the test moves, and snapshots of the asked devices. */
function fakeSim() {
  const events: TraceEvent[] = [];
  let now = 0;
  const snap = (ids: readonly DeviceId[]): SimSnapshot => ({ topologyVersion: 1, now, devices: ids.map((id) => ({ id })), links: [] }) as unknown as SimSnapshot;
  const sim = {
    get now() {
      return now;
    },
    trace: (cursor: number) => ({ events: events.slice(cursor), next: events.length, dropped: 0 }),
    snapshot: (opts?: { devices?: readonly DeviceId[] }) => snap(opts?.devices ?? DEVICES),
    devices: () => DEVICES.map((id) => ({ id })),
    link: () => undefined,
  } as unknown as Simulation;
  return {
    sim,
    emit: (ev: TraceEvent) => events.push(ev),
    at: (t: number) => {
      now = t;
    },
  };
}

describe('the batcher keeps a sender with a FIFO backlog in the deltas (D16; W2 fix)', () => {
  it('re-posts the sender while its frame waits, once more after the frame has ended, then no longer', () => {
    const f = fakeSim();
    let wall = 0;
    const batches: EngineBatch[] = [];
    const batcher = createBatcher({
      sim: () => f.sim,
      epoch: () => 0,
      playing: () => true,
      rate: () => 1,
      effectiveRate: () => 1,
      wallNow: () => wall,
    });
    batcher.setListener((b) => {
      batches.push(b);
    });
    const deltaDevices = (): DeviceId[] | undefined => batches.at(-1)?.delta?.devices.map((d) => d.id);
    // the first post is a full snapshot
    batcher.post();
    expect(batches.at(-1)?.snapshot).toBeDefined();

    // t = 10: pc1 commits one frame at once and one behind it (it starts at 20 and ends at 30)
    f.at(10);
    f.emit(frameTx(10, 10, 20));
    f.emit(frameTx(10, 20, 30));
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(deltaDevices()).toEqual(['pc1', 'sw1']);

    // t = 25: no event at all (a txComplete writes none), but the frame still waits: pc1 is posted again
    f.at(25);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(deltaDevices()).toEqual(['pc1']);

    // t = 35: the last committed frame ended at 30: pc1 once more, so the store sees the backlog gone
    f.at(35);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(deltaDevices()).toEqual(['pc1']);

    // t = 40: nothing changed and nothing waits: no delta
    f.at(40);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(batches.at(-1)?.delta).toBeUndefined();
  });

  it('a frame that starts at once leaves no backlog: its sender is posted for its frameTx only', () => {
    const f = fakeSim();
    let wall = 0;
    const batches: EngineBatch[] = [];
    const batcher = createBatcher({ sim: () => f.sim, epoch: () => 0, playing: () => true, rate: () => 1, effectiveRate: () => 1, wallNow: () => wall });
    batcher.setListener((b) => {
      batches.push(b);
    });
    batcher.post();
    f.at(10);
    f.emit(frameTx(10, 10, 20));
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(batches.at(-1)?.delta?.devices.map((d) => d.id)).toEqual(['pc1', 'sw1']);
    f.at(15);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(batches.at(-1)?.delta).toBeUndefined();
  });

  it('a new generation forgets the watched senders', () => {
    const f = fakeSim();
    let wall = 0;
    const batches: EngineBatch[] = [];
    const batcher = createBatcher({ sim: () => f.sim, epoch: () => 0, playing: () => true, rate: () => 1, effectiveRate: () => 1, wallNow: () => wall });
    batcher.setListener((b) => {
      batches.push(b);
    });
    batcher.post();
    f.at(10);
    f.emit(frameTx(10, 20, 30));
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(batches.at(-1)?.delta?.devices.map((d) => d.id)).toEqual(['pc1', 'sw1']);
    // a new generation (a load): the watch is cleared with the dirty set, so the old world's sender is not re-posted
    batcher.reset(false);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post({ full: true });
    expect(batches.at(-1)?.snapshot).toBeDefined();
    f.at(25);
    wall += SNAPSHOT_EVERY_MS;
    batcher.post();
    expect(batches.at(-1)?.delta).toBeUndefined();
  });
});
