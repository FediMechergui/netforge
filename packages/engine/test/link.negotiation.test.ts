import { describe, expect, it } from 'vitest';
import { SPEED_100M, SPEED_10G, SPEED_1G, SPEED_10M } from '../src/contracts/port.js';
import {
  bestCommonBps,
  endSupports,
  formatBps,
  maxEndBps,
  negotiate,
  negotiatesPhy,
  samePhyEnd,
  samePhyResult,
  type NegotiationEnd,
} from '../src/link/negotiation.js';

// P0 catalog speed lists (device/catalog.ts): gigabit ports [1G,100M,10M], fast ethernet [100M,10M].
const pcNic = (over: Partial<NegotiationEnd> = {}): NegotiationEnd => ({
  kind: 'ethernet', role: 'routed', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], label: 'PC1 Gi0', ...over,
});
const fastSwitchPort = (over: Partial<NegotiationEnd> = {}): NegotiationEnd => ({
  kind: 'ethernet', role: 'switched', speedBps: SPEED_100M, speeds: [SPEED_100M, SPEED_10M], label: 'S1 Fa0/1', ...over,
});
const hubPort = (label = 'H1 Et0'): NegotiationEnd => ({ kind: 'ethernet', role: 'repeater', speedBps: SPEED_10M, label });

describe('link/negotiation P0.5 defaults', () => {
  it('PC auto ↔ hub port → 10 Mb half on both ends; the PC end parallel-detects', () => {
    const r = negotiate(pcNic(), hubPort());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bps).toBe(SPEED_10M);
    expect(r.a).toEqual({ speedBps: SPEED_10M, duplex: 'half', autoneg: true, via: 'parallel-detect' });
    expect(r.b).toEqual({ speedBps: SPEED_10M, duplex: 'half', autoneg: false, via: 'fixed' });
    expect(r.shared).toBe(true);

    // symmetric: hub on end a
    const s = negotiate(hubPort(), pcNic());
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.a.via).toBe('fixed');
    expect(s.b).toEqual({ speedBps: SPEED_10M, duplex: 'half', autoneg: true, via: 'parallel-detect' });
    expect(s.shared).toBe(true);
  });

  it('a P0 port without a speeds list also parallel-detects 10 Mb half against a hub', () => {
    const r = negotiate({ kind: 'ethernet', role: 'routed', speedBps: SPEED_1G }, hubPort());
    expect(r.ok && r.a.duplex === 'half' && r.a.speedBps === SPEED_10M && r.a.via === 'parallel-detect').toBe(true);
  });

  it('hub ↔ hub → 10 Mb half on both ends, fixed', () => {
    const r = negotiate(hubPort('H1 Et3'), hubPort('H2 Et0'));
    expect(r).toEqual({
      ok: true,
      bps: SPEED_10M,
      a: { speedBps: SPEED_10M, duplex: 'half', autoneg: false, via: 'fixed' },
      b: { speedBps: SPEED_10M, duplex: 'half', autoneg: false, via: 'fixed' },
      shared: true,
    });
  });

  it('auto/auto → min speed, full duplex (the P0 numbers), not shared', () => {
    const r = negotiate(pcNic(), fastSwitchPort());
    expect(r).toEqual({
      ok: true,
      bps: SPEED_100M,
      a: { speedBps: SPEED_100M, duplex: 'full', autoneg: true, via: 'autoneg' },
      b: { speedBps: SPEED_100M, duplex: 'full', autoneg: true, via: 'autoneg' },
      shared: false,
    });
    // without speed lists: exactly min(speedBps)
    const p0 = negotiate({ kind: 'ethernet', role: 'routed', speedBps: SPEED_1G }, { kind: 'ethernet', role: 'switched', speedBps: SPEED_100M });
    expect(p0.ok && p0.bps).toBe(SPEED_100M);
    const gig = negotiate(pcNic(), pcNic({ label: 'R1 Gi0/0' }));
    expect(gig.ok && gig.bps).toBe(SPEED_1G);
  });

  it('no common speed → speed-mismatch with an original explanation', () => {
    const tenGigOnly: NegotiationEnd = { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G, speeds: [SPEED_10G], label: 'R4 Te0/1/0' };
    const r = negotiate(tenGigOnly, fastSwitchPort());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('speed-mismatch');
    expect(r.reason).toContain('R4 Te0/1/0');
    expect(r.reason).toContain('S1 Fa0/1');
    expect(r.reason).not.toMatch(/cisco|ios\b/i);

    const hub = negotiate(tenGigOnly, hubPort());
    expect(hub.ok).toBe(false);
    if (!hub.ok) expect(hub.reason).toContain('only runs at 10 Mb/s');
  });

  it('best common speed skips speeds one end does not list', () => {
    const a: NegotiationEnd = { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G] };
    const b: NegotiationEnd = { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_100M] };
    expect(bestCommonBps(a, b)).toBe(SPEED_10G);
    expect(bestCommonBps(a, { ...b, speedBps: SPEED_1G, speeds: [SPEED_100M] })).toBeUndefined();
    expect(bestCommonBps(a, { kind: 'ethernet', role: 'routed', speedBps: SPEED_1G })).toBe(SPEED_1G);
  });

  it('an installed transceiver caps the port speed', () => {
    const cage: NegotiationEnd = { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G, transceiverBps: SPEED_1G };
    expect(maxEndBps(cage)).toBe(SPEED_1G);
    expect(endSupports(cage, SPEED_10G)).toBe(false);
    const r = negotiate(cage, { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G });
    expect(r.ok && r.bps).toBe(SPEED_1G);
  });

  it('only ethernet-class cables negotiate', () => {
    expect(negotiatesPhy('ethernet', 'ethernet')).toBe(true);
    expect(negotiatesPhy('coax', 'coax')).toBe(true);
    expect(negotiatesPhy('serial', 'serial')).toBe(false);
    expect(negotiatesPhy('console', 'usb')).toBe(false);
    expect(negotiatesPhy('radio', 'radio')).toBe(false);
    expect(negotiatesPhy('ethernet', 'serial')).toBe(false);
  });

  it('change detection and speed wording', () => {
    const r1 = negotiate(pcNic(), fastSwitchPort());
    const r2 = negotiate(pcNic(), fastSwitchPort());
    const r3 = negotiate(pcNic(), hubPort());
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('unexpected mismatch');
    expect(samePhyResult(r1, r2)).toBe(true);
    expect(samePhyResult(r1, r3)).toBe(false);
    expect(samePhyResult(undefined, undefined)).toBe(true);
    expect(samePhyResult(r1, undefined)).toBe(false);
    expect(samePhyResult({ a: r1.a, b: r1.b }, { a: r1.a, b: r1.b, mismatch: 'duplex' })).toBe(false);
    expect(samePhyEnd(r1.a, { ...r1.a, via: 'forced' })).toBe(false);
    expect(formatBps(SPEED_10M)).toBe('10 Mb/s');
    expect(formatBps(SPEED_1G)).toBe('1 Gb/s');
    expect(formatBps(64_000)).toBe('64 kb/s');
    expect(formatBps(1_544_000)).toBe('1544 kb/s');
    expect(formatBps(300)).toBe('300 b/s');
  });

  it('results are structured-clone safe and independent objects', () => {
    const r = negotiate(hubPort(), hubPort());
    expect(structuredClone(r)).toEqual(r);
    if (r.ok) {
      r.a.speedBps = 1;
      const again = negotiate(hubPort(), hubPort());
      expect(again.ok && again.a.speedBps).toBe(SPEED_10M);
    }
  });
});
