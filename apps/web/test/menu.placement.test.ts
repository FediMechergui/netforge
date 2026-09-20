import { describe, expect, it } from 'vitest';
import { placePopup } from '../src/app/Menu';

const viewport = { width: 1024, height: 768 };

describe('Menu popup placement (fixed, never clipped by panels)', () => {
  it('opens a top-bar menu downward, just under its button', () => {
    const s = placePopup({ top: 6, bottom: 34, left: 100, right: 150 }, viewport, 'left');
    expect(s.top).toBe(38);
    expect(s.bottom).toBeUndefined();
    expect(s.left).toBe(100);
    expect(s.maxHeight).toBe(768 - 34 - 4 - 8);
  });

  it('anchors a right-aligned menu to the button right edge', () => {
    const s = placePopup({ top: 6, bottom: 34, left: 950, right: 1010 }, viewport, 'right');
    expect(s.right).toBe(14);
    expect(s.left).toBeUndefined();
  });

  it('opens upward near the bottom of the window when there is more room above', () => {
    const s = placePopup({ top: 700, bottom: 724, left: 800, right: 900 }, viewport, 'left');
    expect(s.bottom).toBe(768 - 700 + 4);
    expect(s.top).toBeUndefined();
    expect(s.maxHeight).toBe(700 - 4 - 8);
  });

  it('keeps a left-aligned menu inside the window', () => {
    const s = placePopup({ top: 6, bottom: 34, left: 1000, right: 1020 }, viewport, 'left');
    expect(s.left).toBe(1024 - 8 - 220);
  });
});
