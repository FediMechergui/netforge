// Packet inspector, protected payloads (ARCHITECTURE-P2 §3.12 step 3, §6 "Protected (DTLS, simulated) banner"; §7 W6
// web-inspector): a CAPWAP control message after the simulated DTLS step carries `meta.protected`; the inspector says
// the channel is encrypted in the story, still decodes the fields, and marks the layers inside the UDP payload as
// simulated plaintext. A PDU without the flag shows neither.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPduFactory, vtySshCrypt, vtySshKey } from '@netforge/engine';
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
  PROTECTED_BANNER_TITLES,
  PROTECTED_HEADER_CHIPS,
  PROTECTED_LAYER_MARK,
  PacketInspector,
  SSH_MESSAGE_NAMES,
  isProtectedPdu,
  protectedBannerText,
  protectedBannerTitle,
  protectedLayerIndexes,
  protectionOf,
  sshPlaintextOf,
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

// ── P3 (ARCHITECTURE-P3 §6, §9.2 W3 items 28 and 30b; §10.2): the banner by `protectedBy` ─────────────────────────────
// The DTLS case above keeps its exact text; 'tls' adds a case, and the approved [S13] 'ssh' and [C13] 'esp' / 'ike' add
// theirs. Each case: the title, the text, the layers the protection covers, the rendered banner and its header chip.

const factory = createPduFactory();

function build(layers: LayerSpec[], meta: Partial<PduMeta>): PduJson {
  return factory.build(layers, { born: 2_000_000_000, origin: 'r1', ...meta }).toJSON();
}

/** RESTCONF over 443 (D21): [ethernet, ipv4, tcp 443, http] with protectedBy 'tls'. */
function restconfRequest(meta: Partial<PduMeta>): PduJson {
  return build(
    [
      { proto: 'ethernet', fields: { src: '02:00:00:00:01:00', dst: '02:00:00:00:02:00', type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '10.0.0.10', dst: '10.0.0.2', protocol: 6, ttl: 64 } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 443, seq: 1, ack: 1, flags: 0x18 } },
      { proto: 'http', fields: { kind: 'request', method: 'GET', target: '/restconf/data/ietf-interfaces:interfaces', version: 'HTTP/1.1' } },
    ],
    meta,
  );
}

const SSH_SRC = '192.168.10.10';
const SSH_DST = '192.168.10.1';
const SSH_SPORT = 49153;
const SSH_DPORT = 22;

/** One protected SSH packet: [ethernet, ipv4, tcp 22, ssh {protected}], the payload XORed as the client does. */
function sshPacket(plain: Uint8Array): PduJson {
  const payload = vtySshCrypt(vtySshKey(SSH_SRC, SSH_SPORT, SSH_DST, SSH_DPORT), plain);
  return build(
    [
      { proto: 'ethernet', fields: { src: '02:00:00:00:0a:00', dst: '02:00:00:00:0b:00', type: 0x0800 } },
      { proto: 'ipv4', fields: { src: SSH_SRC, dst: SSH_DST, protocol: 6, ttl: 64 } },
      { proto: 'tcp', fields: { srcPort: SSH_SPORT, dstPort: SSH_DPORT, seq: 100, ack: 200, flags: 0x18 } },
      { proto: 'ssh', fields: { phase: 'protected', payload } },
    ],
    { protected: true, protectedBy: 'ssh' },
  );
}

/** An ESP tunnel leg at the provider: [ethernet, ipv4 proto 50, esp, ipv4 (inner), icmpv4] with protectedBy 'esp'. */
function espLeg(meta: Partial<PduMeta> = { protected: true, protectedBy: 'esp' }): PduJson {
  return build(
    [
      { proto: 'ethernet', fields: { src: '02:00:00:00:0c:00', dst: '02:00:00:00:0d:00', type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', protocol: 50, ttl: 254 } },
      { proto: 'esp', fields: { spi: 0x1001, seq: 1, nextHeader: 4 } },
      { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', protocol: 1, ttl: 127 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    ],
    meta,
  );
}

/** IKE_AUTH: [ethernet, ipv4, udp 500, ikev2 {exchange 35}] with protectedBy 'ike'. */
function ikeAuth(): PduJson {
  return build(
    [
      { proto: 'ethernet', fields: { src: '02:00:00:00:0c:00', dst: '02:00:00:00:0d:00', type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', protocol: 17, ttl: 255 } },
      { proto: 'udp', fields: { srcPort: 500, dstPort: 500 } },
      {
        proto: 'ikev2',
        fields: {
          spiI: '0123456789abcdef',
          spiR: 'fedcba9876543210',
          exchange: 35,
          flags: 0x08,
          messageId: 1,
          idi: '209.165.200.225',
          auth: '00112233445566778899aabbccddeeff',
        },
      },
    ],
    { protected: true, protectedBy: 'ike' },
  );
}

function protos(p: PduJson): string[] {
  return p.layers.map((l) => l.proto);
}

function layerMarks(html: string): boolean[] {
  return html
    .split('class="pk-layer ')
    .slice(1)
    .map((c) => c.includes(PROTECTED_LAYER_MARK));
}

describe('P3 protected payloads: the banner follows protectedBy (§9.2 W3 items 28, 30b)', () => {
  it('a protected PDU without protectedBy is still DTLS, with the P2 title and text exactly', () => {
    const p = capwapControl({ protected: true });
    expect(protectionOf(p)).toBe('dtls');
    expect(protectionOf(capwapControl({}))).toBeUndefined();
    expect(protectedBannerTitle()).toBe('Protected (DTLS, simulated)');
    expect(PROTECTED_BANNER_TITLES.dtls).toBe(PROTECTED_BANNER_TITLE);
    expect(protectedBannerText([{ proto: 'udp' }, { proto: 'capwap' }], 'dtls')).toBe(
      'This CAPWAP control message travels between the access point and its controller inside an encrypted DTLS session: ' +
        'a capture on a real network would show the outer addresses and ports, not the protected fields. NetForge only ' +
        'simulates that encryption, so the protected fields below are decoded for study and marked as simulated.',
    );
    expect(protectedBannerText([{ proto: 'udp' }])).toBe(
      'This message travels inside an encrypted session: a capture on a real network would show the outer addresses and ' +
        'ports, not the protected fields. NetForge only simulates that encryption, so the protected fields below are ' +
        'decoded for study and marked as simulated.',
    );
  });

  it('the five titles are distinct, and ESP says "Encrypted"', () => {
    expect(PROTECTED_BANNER_TITLES).toEqual({
      dtls: 'Protected (DTLS, simulated)',
      tls: 'Protected (TLS, simulated)',
      ssh: 'Protected (SSH, simulated)',
      esp: 'Encrypted (ESP, simulated)',
      ike: 'Protected (IKE, simulated)',
    });
    expect(PROTECTED_HEADER_CHIPS.esp).toBe('encrypted (simulated)');
    expect(PROTECTED_HEADER_CHIPS.tls).toBe('protected (simulated)');
  });

  it("'tls': RESTCONF over 443 shows the TLS banner and marks the layers inside TCP", () => {
    const p = restconfRequest({ protected: true, protectedBy: 'tls' });
    expect(protos(p)).toEqual(['ethernet', 'ipv4', 'tcp', 'http']);
    expect(protectionOf(p)).toBe('tls');
    expect([...protectedLayerIndexes(p.layers, 'tls')]).toEqual([3]);
    const words = protectedBannerText(p.layers, 'tls');
    expect(words).toMatch(/^This web request travels inside an encrypted TLS session \(HTTPS on TCP port 443\)/);
    expect(words).toContain('simulated');
    expect(protectedBannerText([{ proto: 'tcp' }], 'tls')).toMatch(/^This message travels inside an encrypted TLS session/);
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: p }));
    const t = text(html);
    expect(html).toContain('role="note" aria-label="Protected (TLS, simulated)"');
    expect(t).toContain('Protected (TLS, simulated)');
    expect(t).not.toContain(PROTECTED_BANNER_TITLE);
    expect(t).toContain('protected (simulated)');
    expect(t).toContain('/restconf/data/ietf-interfaces:interfaces'); // still decoded
    expect(layerMarks(html)).toEqual([false, false, false, true]);
  });

  it("[S13] 'ssh': the banner, the layer inside TCP, and the payload decoded from the connection's keystream", () => {
    const plain = new Uint8Array([50, ...new TextEncoder().encode('admin\0NetF0rge')]);
    const p = sshPacket(plain);
    expect(protos(p)).toEqual(['ethernet', 'ipv4', 'tcp', 'ssh']);
    expect(p.layers[3]?.fields.phase).toBe('protected');
    // the wire carries the XORed bytes, never the clear text
    expect(new TextDecoder().decode(p.layers[3]?.fields.payload as Uint8Array)).not.toContain('NetF0rge');
    expect(protectionOf(p)).toBe('ssh');
    expect([...protectedLayerIndexes(p.layers, 'ssh')]).toEqual([3]);
    expect(sshPlaintextOf(p.layers)).toEqual({ type: 50, name: 'USERAUTH_REQUEST', text: 'admin␀NetF0rge' });
    expect(SSH_MESSAGE_NAMES[94]).toBe('CHANNEL_DATA');
    const words = protectedBannerText(p.layers, 'ssh');
    expect(words).toContain('encrypted SSH session');
    expect(words).toContain('never the user name, the password or the commands typed');
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: p }));
    const t = text(html);
    expect(html).toContain('role="note" aria-label="Protected (SSH, simulated)"');
    expect(t).toContain('Simulated plaintext: USERAUTH_REQUEST (50) · admin␀NetF0rge');
    expect(layerMarks(html)).toEqual([false, false, false, true]);
  });

  it('[S13] a line of the terminal stream decodes with visible line ends; a version line is not decoded', () => {
    const p = sshPacket(new Uint8Array([94, ...new TextEncoder().encode('show clock\r\n')]));
    expect(sshPlaintextOf(p.layers)).toEqual({ type: 94, name: 'CHANNEL_DATA', text: 'show clock↵' });
    const version = build(
      [
        { proto: 'ethernet', fields: { src: '02:00:00:00:0a:00', dst: '02:00:00:00:0b:00', type: 0x0800 } },
        { proto: 'ipv4', fields: { src: SSH_SRC, dst: SSH_DST, protocol: 6, ttl: 64 } },
        { proto: 'tcp', fields: { srcPort: SSH_SPORT, dstPort: SSH_DPORT, seq: 1, ack: 1, flags: 0x18 } },
        { proto: 'ssh', fields: { phase: 'version', version: 'SSH-2.0-NFSSH_1.0' } },
      ],
      {},
    );
    expect(sshPlaintextOf(version.layers)).toBeUndefined();
    expect(text(renderToStaticMarkup(createElement(PacketInspector, { pdu: version })))).not.toContain('Simulated plaintext');
  });

  it("[C13] 'esp': \"Encrypted (ESP, simulated)\" marks the whole inner packet, never the outer headers", () => {
    const p = espLeg();
    expect(protos(p)).toEqual(['ethernet', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']);
    expect(protectionOf(p)).toBe('esp');
    expect([...protectedLayerIndexes(p.layers, 'esp')]).toEqual([3, 4, 5]);
    const words = protectedBannerText(p.layers, 'esp');
    expect(words).toContain('inside an IPsec tunnel');
    expect(words).toContain('only the outer addresses, the SPI and the sequence number');
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: p }));
    const t = text(html);
    expect(html).toContain('role="note" aria-label="Encrypted (ESP, simulated)"');
    expect(t).toContain('encrypted (simulated)');
    expect(t).toContain('192.168.2.10'); // the inner packet is decoded under the banner
    expect(layerMarks(html)).toEqual([false, false, false, true, true, true]);
  });

  it("[C13] 'ike': IKE_AUTH shows the IKE banner and marks the IKE message inside UDP", () => {
    const p = ikeAuth();
    expect(protos(p)).toEqual(['ethernet', 'ipv4', 'udp', 'ikev2']);
    expect(protectionOf(p)).toBe('ike');
    expect([...protectedLayerIndexes(p.layers, 'ike')]).toEqual([3]);
    const words = protectedBannerText(p.layers, 'ike');
    expect(words).toMatch(/^This key-exchange message \(IKE_AUTH\) is encrypted/);
    expect(words).toContain('The key itself is never sent.');
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: p }));
    expect(html).toContain('role="note" aria-label="Protected (IKE, simulated)"');
    expect(text(html)).toContain('Protected (IKE, simulated)');
    expect(layerMarks(html)).toEqual([false, false, false, true]);
  });

  it('the same layers without the protected flag show no banner', () => {
    for (const p of [restconfRequest({}), espLeg({})]) {
      const t = text(renderToStaticMarkup(createElement(PacketInspector, { pdu: p })));
      for (const title of Object.values(PROTECTED_BANNER_TITLES)) expect(t).not.toContain(title);
      expect(t).not.toContain(PROTECTED_LAYER_MARK);
    }
  });
});
