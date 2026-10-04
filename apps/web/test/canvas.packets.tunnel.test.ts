// Tunnel legs on the canvas (ARCHITECTURE-P3 §6 WAN row; ruling R42, W3 fix step): a GRE leg carries a `G` badge and
// an IPsec (ESP) leg a padlock, both top-left of the capsule (opposite the 802.1Q badge), from the WAN model's
// `tunnelLegStyle`; the IPsec pulse (`encryptedPulseAlpha`) is static under reduced motion. Every other leg draws as
// before (no badge, no padlock, full alpha).
import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { PduSummary } from '@netforge/engine';
import { drawPadlock, tagBadgeOffset, tunnelBadgeOffset } from '../src/canvas/packets.js';
import { encryptedPulseAlpha, tunnelLegStyle, ENCRYPTED_PULSE_MS } from '../src/canvas/overlays/wan-model.js';
import { TEST_THEME } from './canvas-fixtures.js';

const leg = (tunnel?: PduSummary['tunnel']): Pick<PduSummary, 'tunnel'> => (tunnel === undefined ? {} : { tunnel });

/** A recording stand-in for a pixi Graphics (the chainable calls drawPadlock makes). */
function recorder(): { g: Graphics; calls: Array<{ op: string; args: unknown[] }> } {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const g: Record<string, (...args: unknown[]) => unknown> = {};
  for (const op of ['roundRect', 'arc', 'fill', 'stroke']) {
    g[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return g;
    };
  }
  return { g: g as unknown as Graphics, calls };
}

describe('the tunnel badge position', () => {
  it('mirrors the 802.1Q badge: top-left of the capsule, outside the body, higher when zoomed in', () => {
    for (const [r, s] of [[5, 1], [7, 2], [11, 3]] as const) {
      const tag = tagBadgeOffset(r, s);
      const off = tunnelBadgeOffset(r, s);
      expect(off).toEqual({ x: -tag.x, y: tag.y });
      expect(off.x).toBeLessThan(-r);
      expect(off.y).toBeLessThan(-r);
    }
    expect(tunnelBadgeOffset(5, 3).y).toBeLessThan(tunnelBadgeOffset(5, 1).y);
  });
});

describe('the leg styles the packet layer draws', () => {
  it('GRE: the G badge, no padlock, no pulse; IPsec: the padlock, pulsing unless reduced motion; others: plain', () => {
    expect(tunnelLegStyle(leg('gre'), false)).toEqual({ badge: 'G', lock: false, pulse: false });
    expect(tunnelLegStyle(leg('ipsec'), false)).toEqual({ badge: '', lock: true, pulse: true });
    expect(tunnelLegStyle(leg('ipsec'), true)).toEqual({ badge: '', lock: true, pulse: false });
    expect(tunnelLegStyle(leg(), false)).toEqual({ badge: '', lock: false, pulse: false });
  });

  it('the IPsec alpha breathes between 0.55 and 1 on wall time, and stays 1 under reduced motion', () => {
    const samples = Array.from({ length: 24 }, (_, i) => encryptedPulseAlpha((i * ENCRYPTED_PULSE_MS) / 24, false));
    expect(Math.max(...samples)).toBeCloseTo(1, 6);
    expect(Math.min(...samples)).toBeCloseTo(0.55, 6);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0.55 - 1e-9);
      expect(s).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (let w = 0; w < 3 * ENCRYPTED_PULSE_MS; w += 97) expect(encryptedPulseAlpha(w, true)).toBe(1);
  });
});

describe('the IPsec padlock', () => {
  it('draws a body (filled in the leg colour, edged in the background) and a shackle, sized by `size`', () => {
    const { g, calls } = recorder();
    drawPadlock(g, 10, 0x123456, TEST_THEME);
    expect(calls.map((c) => c.op)).toEqual(['roundRect', 'fill', 'stroke', 'arc', 'stroke']);
    const [x, y, w, h] = calls[0]!.args as number[];
    expect(w).toBeCloseTo(8, 9);
    expect(h).toBeCloseTo(5.5, 9);
    expect(x).toBeCloseTo(-4, 9);
    expect(y).toBeCloseTo(-2.75 + 1.5, 9);
    expect(calls[1]!.args[0]).toEqual({ color: 0x123456 });
    expect(calls[2]!.args[0]).toMatchObject({ color: TEST_THEME.bg });
    expect(calls[4]!.args[0]).toMatchObject({ color: 0x123456 });
    // the shackle is a half circle above the body
    const [cx, cy, radius, start, end] = calls[3]!.args as number[];
    expect(cx).toBe(0);
    expect(cy).toBeCloseTo(y!, 9);
    expect(radius).toBeCloseTo(2.4, 9);
    expect([start, end]).toEqual([Math.PI, 0]);
  });

  it('scales with the zoom: twice the size, twice the body', () => {
    const a = recorder();
    const b = recorder();
    drawPadlock(a.g, 7, 1, TEST_THEME);
    drawPadlock(b.g, 14, 1, TEST_THEME);
    const wa = (a.calls[0]!.args as number[])[2]!;
    const wb = (b.calls[0]!.args as number[])[2]!;
    expect(wb).toBeCloseTo(2 * wa, 9);
  });
});
