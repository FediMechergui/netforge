// Packet inspector, protected payloads (ARCHITECTURE-P2 §3.12 step 3, §6 "Protected (DTLS, simulated) banner"; §7 W6
// web-inspector): a CAPWAP control message after the simulated DTLS step carries `meta.protected`; the inspector says
// the channel is encrypted in the story, still decodes the fields, and marks the layers inside the UDP payload as
// simulated plaintext. A PDU without the flag shows neither.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPduFactory } from '@netforge/engine';
import type { LayerSpec, PduJson, PduMeta } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], selection: null };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import {
  PROTECTED_BANNER_TITLE,
  PROTECTED_LAYER_MARK,
  PacketInspector,
  isProtectedPdu,
  protectedBannerText,
  protectedLayerIndexes,
} from '../src/inspector/PacketInspector';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A CAPWAP control message as the controller builds it: [ethernet, ipv4, udp 5246, capwap]. */
function capwapControl(meta: Partial<PduMeta>): PduJson {
  const layers: LayerSpec[] = [
    { proto: 'ethernet', fields: { src: '02:00:00:00:0a:00', dst: '02:00:00:00:0b:00', type: 0x0800 } },
    { proto: 'ipv4', fields: { src: '192.168.99.5', dst: '192.168.99.20', protocol: 17, ttl: 64 } },
    { proto: 'udp', fields: { srcPort: 5246, dstPort: 5246 } },
    { proto: 'capwap', fields: { radioId: 0, messageType: 3398913, seq: 4, wlans: '1:LabNet:wpa2-psk:20:305419896' } },
  ];
  return createPduFactory().build(layers, { born: 1_000_000_000, origin: 'wlc', ...meta }).toJSON();
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('protected payloads', () => {
  it('knows which PDUs are protected and which layers the protection covers', () => {
    const p = capwapControl({ protected: true });
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'udp', 'capwap']);
    expect(isProtectedPdu(p)).toBe(true);
    expect(isProtectedPdu(capwapControl({}))).toBe(false);
    expect([...protectedLayerIndexes(p.layers)]).toEqual([3]);
    // no UDP layer: only the innermost layer
    expect([...protectedLayerIndexes([{ proto: 'ethernet' }, { proto: 'raw' }])]).toEqual([1]);
    expect([...protectedLayerIndexes([])]).toEqual([]);
  });

  it('says the CAPWAP control channel is encrypted in the story and only simulated here', () => {
    const words = protectedBannerText([{ proto: 'udp' }, { proto: 'capwap' }]);
    expect(words).toContain('CAPWAP control message');
    expect(words).toContain('encrypted DTLS session');
    expect(words).toContain('simulated');
    expect(protectedBannerText([{ proto: 'udp' }])).toMatch(/^This message travels inside an encrypted session/);
    expect(PROTECTED_BANNER_TITLE).toBe('Protected (DTLS, simulated)');
  });

  it('shows the banner, keeps decoding the fields and marks the protected layer as simulated', () => {
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: capwapControl({ protected: true }) }));
    const t = text(html);
    expect(html).toContain(`role="note" aria-label="${PROTECTED_BANNER_TITLE}"`);
    expect(t).toContain(PROTECTED_BANNER_TITLE);
    expect(t).toContain('inside an encrypted DTLS session');
    expect(t).toContain('protected (simulated)');
    // the fields are still decoded and shown…
    expect(t).toContain('messageType');
    expect(t).toContain('1:LabNet:wpa2-psk:20:305419896');
    // …and exactly the capwap layer card carries the simulated mark
    const cards = html.split('class="pk-layer ').slice(1);
    expect(cards.map((c) => /<span class="proto">([^<]+)<\/span>/.exec(c)?.[1])).toEqual(['ethernet', 'ipv4', 'udp', 'capwap']);
    expect(cards.map((c) => c.includes(PROTECTED_LAYER_MARK))).toEqual([false, false, false, true]);
  });

  it('shows no banner and no mark for an unprotected PDU (the discovery exchange)', () => {
    const t = text(renderToStaticMarkup(createElement(PacketInspector, { pdu: capwapControl({}) })));
    expect(t).not.toContain(PROTECTED_BANNER_TITLE);
    expect(t).not.toContain(PROTECTED_LAYER_MARK);
    expect(t).not.toContain('protected (simulated)');
    expect(t).toContain('messageType');
  });
});
