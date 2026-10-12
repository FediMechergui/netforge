// NetScope's frame detail shows the protected banner (ARCHITECTURE-P3 §9.2 ruling R57(b); §3.8 step 2, §3.13 step 8;
// W6 web-inspector): "Encrypted (ESP, simulated)" for a frame with an ESP header — a capture of an IPsec ping at the ISP —
// and "Protected (TLS / SSH / IKE, simulated)" for a segment the engine marked, with the Packet inspector's own banner
// (`protectedBannerTitle`) and the simulated mark on the layers the protection covers. A CAPWAP control frame (P2's DTLS)
// and every unmarked frame keep their view. Frames come from real engine captures, so the detail is what the worker sends.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, SEC, createCaptureStore, createPduFactory, createSimulation, vtySshCrypt, vtySshKey } from '@netforge/engine';
import type { CaptureId, CaptureRecordDetail, LayerSpec, PduMeta, Simulation } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => String(t) }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { snapshot: null, epoch: 0, events: [], selection: null };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { DetailTree, frameNeedsMark, frameProtection } from '../src/netscope/DetailTree';
import { capturePortOf } from '../src/netscope/netscope-client';
import { PROTECTED_BANNER_TITLE, PROTECTED_LAYER_MARK, protectedBannerTitle } from '../src/inspector/PacketInspector';

/** Wall-clock budget of the test that boots the IPsec lab. */
const WORLD_TEST_TIMEOUT_MS = 60_000;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tree(detail: CaptureRecordDetail, protection?: ReturnType<typeof frameProtection>): string {
  return renderToStaticMarkup(
    createElement(DetailTree, { detail, selectedLayer: null, onSelectLayer: () => undefined, hot: null, onHot: () => undefined, note: 'pick one', protection }),
  );
}

/** Which layer sections carry the simulated-plaintext mark. */
function marks(html: string): boolean[] {
  return html
    .split('class="pk-layer ')
    .slice(1)
    .map((c) => c.includes(PROTECTED_LAYER_MARK));
}

const ALL_TITLES = ['Protected (DTLS, simulated)', 'Protected (TLS, simulated)', 'Protected (SSH, simulated)', 'Encrypted (ESP, simulated)', 'Protected (IKE, simulated)'];

function noBanner(html: string): void {
  const t = text(html);
  for (const title of ALL_TITLES) expect(t).not.toContain(title);
  expect(t).not.toContain(PROTECTED_LAYER_MARK);
  expect(html).not.toContain('role="note"');
}

function idOf(sim: Simulation, name: string): string {
  const d = sim.devices().find((x) => x.spec.name === name);
  if (d === undefined) throw new Error(`no device ${name}`);
  return d.id;
}

/**
 * Lab 25 booted, a capture on the ISP's two serial ports started BEFORE the solution (so IKEv2 is recorded too), the
 * solution typed, then PC1 pings PC2 across the tunnel.
 */
function ipsecCapture(): { sim: Simulation; cap: CaptureId } {
  const lab = SCENARIOS.find((s) => s.name === 'ccna3-ipsec-site-to-site');
  if (lab === undefined) throw new Error('lab 25 missing');
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const isp = idOf(sim, 'ISP');
  const cap = sim.startCapture({ ports: [{ device: isp, port: 'Serial0/0/0' }, { device: isp, port: 'Serial0/0/1' }], dir: 'both' });
  for (const [name, lines] of Object.entries(lab.solution ?? {})) expect(sim.configure(idOf(sim, name), lines).ok, name).toBe(true);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const s = sim.cli.open('pc1', 'console');
  sim.cli.exec(s, 'ping 192.168.2.10');
  expect(sim.runToIdle().stopped).toBeUndefined();
  return { sim, cap };
}

describe('a capture of an IPsec ping at the ISP (R57(b))', () => {
  it('shows every ESP frame under "Encrypted (ESP, simulated)", the inner packet decoded and marked as simulated', () => {
    const { sim, cap } = ipsecCapture();
    const rows = sim.queryCapture(cap, { from: 0, limit: 500 }).rows;
    const esp = rows.filter((r) => r.layers.includes('esp'));
    expect(esp.length).toBeGreaterThanOrEqual(20); // 5 requests and 5 replies, each seen on both serial ports
    for (const row of esp) {
      const detail = sim.captureRecord(cap, row.index)!;
      // the header decides alone: the packet the engine holds now was decrypted at the far end, its mark cleared
      expect(sim.pdu(row.pdu!)?.meta.protected).toBeUndefined();
      expect(frameProtection(detail.layers, sim.pdu(row.pdu!)?.meta)).toBe('esp');
      expect(frameProtection(detail.layers)).toBe('esp');
      expect(frameNeedsMark(detail.layers)).toBe(false);
    }

    const detail = sim.captureRecord(cap, esp[0]!.index)!;
    expect(detail.layers.map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']);
    const html = tree(detail, frameProtection(detail.layers));
    const t = text(html);
    expect(protectedBannerTitle('esp')).toBe('Encrypted (ESP, simulated)');
    expect(html).toContain(`role="note" aria-label="${protectedBannerTitle('esp')}"`);
    expect(t).toContain('Encrypted (ESP, simulated)');
    expect(t).toContain('inside an IPsec tunnel');
    expect(t).toContain('only the outer addresses, the SPI and the sequence number');
    // what the provider sees (the outer headers) carries no mark; the packet inside does
    expect(marks(html)).toEqual([false, false, false, true, true, true]);
    // the banner sits under the frame's summary, above the first layer
    expect(html.indexOf('role="note"')).toBeGreaterThan(html.indexOf(detail.summary.replace(/>/g, '&gt;')));
    expect(html.indexOf('role="note"')).toBeLessThan(html.indexOf('class="pk-layer '));
  }, WORLD_TEST_TIMEOUT_MS);

  it('IKE_AUTH frames carry the IKE banner from the engine’s mark; IKE_SA_INIT frames none', () => {
    const { sim, cap } = ipsecCapture();
    const ike = sim.queryCapture(cap, { from: 0, limit: 500 }).rows.filter((r) => r.layers.includes('ikev2'));
    const seen = new Map<number, number>();
    for (const row of ike) {
      const detail = sim.captureRecord(cap, row.index)!;
      const exchange = detail.layers.find((l) => l.proto === 'ikev2')?.fields.exchange;
      expect(frameNeedsMark(detail.layers)).toBe(true);
      const by = frameProtection(detail.layers, sim.pdu(row.pdu!)?.meta);
      expect(by, `exchange ${String(exchange)}`).toBe(exchange === 35 ? 'ike' : undefined);
      seen.set(Number(exchange), (seen.get(Number(exchange)) ?? 0) + 1);
      const html = tree(detail, by);
      if (by === 'ike') {
        expect(html).toContain('role="note" aria-label="Protected (IKE, simulated)"');
        expect(marks(html)).toEqual(detail.layers.map((l) => l.proto === 'ikev2'));
      } else noBanner(html);
    }
    // both exchanges crossed the provider, each message on both serial ports
    expect([...seen.keys()].sort()).toEqual([34, 35]);
  }, WORLD_TEST_TIMEOUT_MS);
});

// ── marked segments and unmarked frames, as a live capture records them ──────────────────────────────────────────────

const factory = createPduFactory();

/** A frame as the live tap records it (an Ethernet capture point, FCS kept), decoded by the engine's capture store. */
function captured(layers: LayerSpec[]): CaptureRecordDetail {
  const bytes = factory.build(layers, { born: 0, origin: 'pc1' }).toJSON().bytes;
  const store = createCaptureStore({ id: 'c_1', name: 'test', source: 'live', interfaces: [{ index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 }] });
  store.append({ index: 0, t: 0, iface: 0, dir: 'tx', bytes, origLen: bytes.length, pdu: 7 });
  return store.record(0)!;
}

const ETH: LayerSpec = { proto: 'ethernet', fields: { src: '02:00:00:00:01:00', dst: '02:00:00:00:02:00', type: 0x0800 } };
const ip = (protocol: number): LayerSpec => ({ proto: 'ipv4', fields: { src: '10.0.0.10', dst: '10.0.0.2', protocol, ttl: 64 } });

const restconf = (): CaptureRecordDetail =>
  captured([
    ETH,
    ip(6),
    { proto: 'tcp', fields: { srcPort: 49152, dstPort: 443, seq: 1, ack: 1, flags: 0x18 } },
    { proto: 'http', fields: { kind: 'request', method: 'PUT', target: '/restconf/data/ietf-interfaces:interfaces', version: 'HTTP/1.1' } },
  ]);

function sshFrame(): CaptureRecordDetail {
  const payload = vtySshCrypt(vtySshKey('10.0.0.10', 49153, '10.0.0.2', 22), new Uint8Array([50, ...new TextEncoder().encode('admin\0NetF0rge')]));
  return captured([ETH, ip(6), { proto: 'tcp', fields: { srcPort: 49153, dstPort: 22, seq: 100, ack: 200, flags: 0x18 } }, { proto: 'ssh', fields: { phase: 'protected', payload } }]);
}

const capwap = (): CaptureRecordDetail =>
  captured([
    ETH,
    { proto: 'ipv4', fields: { src: '192.168.99.5', dst: '192.168.99.20', protocol: 17, ttl: 64 } },
    { proto: 'udp', fields: { srcPort: 5246, dstPort: 5246 } },
    { proto: 'capwap', fields: { radioId: 0, messageType: 3398913, seq: 4, wlans: '1:LabNet:wpa2-psk:20:305419896' } },
  ]);

const icmpEcho = (): CaptureRecordDetail => captured([ETH, ip(1), { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } }]);

const marked = (protectedBy?: PduMeta['protectedBy']): Pick<PduMeta, 'protected' | 'protectedBy'> =>
  protectedBy === undefined ? { protected: true } : { protected: true, protectedBy };

describe('a segment the engine marked (R57(b))', () => {
  it("TLS: RESTCONF over 443 shows \"Protected (TLS, simulated)\" over the decoded request", () => {
    const d = restconf();
    expect(d.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'tcp', 'http']);
    expect(frameNeedsMark(d.layers)).toBe(true);
    expect(frameProtection(d.layers, marked('tls'))).toBe('tls');
    const html = tree(d, 'tls');
    const t = text(html);
    expect(html).toContain('role="note" aria-label="Protected (TLS, simulated)"');
    expect(t).toMatch(/This web request travels inside an encrypted TLS session \(HTTPS on TCP port 443\)/);
    expect(marks(html)).toEqual([false, false, false, true]);
    // the same frame without the mark: no banner (the port alone never decides)
    expect(frameProtection(d.layers, {})).toBeUndefined();
    expect(frameProtection(d.layers)).toBeUndefined();
  });

  it('SSH: the banner, and the payload decoded from the connection’s keystream', () => {
    const d = sshFrame();
    expect(frameProtection(d.layers, marked('ssh'))).toBe('ssh');
    const html = tree(d, 'ssh');
    const t = text(html);
    expect(html).toContain('role="note" aria-label="Protected (SSH, simulated)"');
    expect(t).toContain('Simulated plaintext: USERAUTH_REQUEST (50) · admin␀NetF0rge');
    expect(marks(html)).toEqual([false, false, false, true]);
  });

  it('the DTLS case is unchanged: a CAPWAP control frame shows no banner in NetScope', () => {
    const d = capwap();
    expect(frameProtection(d.layers, marked())).toBeUndefined();
    noBanner(tree(d, frameProtection(d.layers, marked())));
    expect(text(tree(d))).not.toContain(PROTECTED_BANNER_TITLE);
  });

  it("a LAN frame of a packet now inside a tunnel shows no banner: an 'esp' mark needs the ESP header", () => {
    const d = icmpEcho();
    expect(frameNeedsMark(d.layers)).toBe(false);
    expect(frameProtection(d.layers, marked('esp'))).toBeUndefined();
    noBanner(tree(d, frameProtection(d.layers, marked('esp'))));
  });

  it('a detail without a protection renders as before P3', () => {
    for (const d of [restconf(), sshFrame(), icmpEcho()]) noBanner(tree(d));
  });

  it("the capture port reads a frame's mark through the bridge's pdu call, and is silent without one", async () => {
    const meta: PduMeta = { born: 0, origin: 'pc1', protected: true, protectedBy: 'tls' };
    const asked: number[] = [];
    const port = capturePortOf({
      pdu: async (id: number) => {
        asked.push(id);
        return id === 7 ? { id, meta } : undefined;
      },
    });
    await expect(port.pduMeta?.(7)).resolves.toEqual(meta);
    await expect(port.pduMeta?.(8)).resolves.toBeUndefined();
    expect(asked).toEqual([7, 8]);
    await expect(capturePortOf({}).pduMeta?.(7)).resolves.toBeUndefined();
  });
});
