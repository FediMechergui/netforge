/**
 * Review regression test for apps/web/src/store/store.ts: engine-mirrored history must not
 * survive a reset / load (PDU ids and session ids restart in the new simulation).
 */
import { describe, expect, it } from 'vitest';
import { store } from '../src/store/store';
import { SessionCursor } from '../src/terminal/use-session-output';

const emptySnapshot = (now: number): any => ({
  now,
  seed: 1,
  topologyVersion: 1,
  devices: [],
  links: [],
  sessions: [],
  inflight: [],
  pduCount: 0,
  pendingEvents: 0,
});

describe('review: store history across a reset', () => {
  it('drops old trace events so reused PDU / session ids are not mixed with the old run', () => {
    const st = store.getState();
    // Old run: session s_1 printed a transcript; PDU #1 crossed link l_old.
    st.applyBatch({
      epoch: 0,
      now: 40_000_000_000,
      playing: true,
      rate: 1,
      effectiveRate: 1_000_000,
      dropped: 0,
      events: [
        { t: 1, kind: 'cliOutput', session: 's_1', text: 'OLD TRANSCRIPT\n' },
        {
          t: 2,
          kind: 'frameTx',
          pdu: { id: 1, proto: 'arp', size: 64, summary: 'old arp' },
          link: 'l_old',
          from: { device: 'pc1', port: 'g0' },
          to: { device: 'sw1', port: 'f1' },
          txStart: 2,
          txEnd: 3,
          arrive: 4,
        },
      ] as any,
    });
    // "New (empty)": worker reset(seed) bumps the epoch and posts a fresh snapshot at t=0.
    st.applyBatch({ epoch: 1, now: 0, playing: false, rate: 1, effectiveRate: 1_000_000, dropped: 0, events: [], snapshot: emptySnapshot(0) });

    const after = store.getState();
    const stalePdu = after.events.filter((e: any) => e.kind === 'frameTx' && e.pdu.id === 1);
    expect(stalePdu).toHaveLength(0);

    // A console opened on the new simulation gets id s_1 again and replays from the ring.
    const cursor = new SessionCursor('s_1');
    expect(cursor.take().map((e: any) => e.text)).not.toContain('OLD TRANSCRIPT\n');
  });
});
