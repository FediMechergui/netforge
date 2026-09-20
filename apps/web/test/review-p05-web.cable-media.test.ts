/**
 * Review regression test: the cable picker and the canvas must agree on the cable media. A persisted
 * media the picker does not offer (legacy 'serial') falls back to 'auto' on load, and a media the engine
 * does not offer is normalized when the init result arrives (so the pending cable follows too).
 */
import { MEDIA } from '@netforge/engine';
import { describe, expect, it } from 'vitest';
import { sanitizePersistedUi } from '../src/store/persist';
import { store } from '../src/store/store';

describe('review: cable media normalization', () => {
  it('drops a persisted media the picker does not offer', () => {
    expect(sanitizePersistedUi({ cable: { media: 'serial' } }).cable.media).toBe('auto');
    expect(sanitizePersistedUi({ cable: { media: 'serial-dce' } }).cable.media).toBe('serial-dce');
  });

  it('normalizes the store media to what the engine offers on init', () => {
    const st = store.getState();
    st.setCableMedia('fiber-pon');
    st.setPendingCable({ from: { device: 'd1', port: 'p1' }, media: 'fiber-pon' } as any);
    const media = Object.values(MEDIA).filter((m) => m.media !== 'fiber-pon');
    st.setReady({ catalog: [], modules: [], media } as any);
    const after = store.getState();
    expect(after.cable.media).toBe('auto');
    expect(after.pendingCable?.media).toBe('auto');
    after.setPendingCable(null);
  });
});
