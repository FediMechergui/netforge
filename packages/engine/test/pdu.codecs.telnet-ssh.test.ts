/**
 * [S13] Telnet and simulated SSH codecs (ARCHITECTURE-P3 §7 W1 approved pdu items, D14, §2.3, §3.14): TCP 23 and 22 are
 * no longer reserved; telnet carries its text and option commands in the clear, SSH a clear version line then
 * length-prefixed protected packets. Goldens assembled independently of the engine.
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_TCP } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { lookupNext } from '../src/pdu/codecs/dispatch.js';
import { TELNET_OPTION, telnetCodec } from '../src/pdu/codecs/telnet.js';
import { sshCodec } from '../src/pdu/codecs/ssh.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

const R1 = '192.168.10.1';
const PC1 = '192.168.10.10';

const segment = (srcPort: number, dstPort: number, app: LayerSpec): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: srcPort < 1024 ? R1 : PC1, dst: srcPort < 1024 ? PC1 : R1, protocol: IPPROTO_TCP } },
  { proto: 'tcp', fields: { srcPort, dstPort, flags: 'PA', seq: 1, ack: 1 } },
  app,
];

function checkNames(layers: readonly LayerView[]): void {
  for (const layer of layers) {
    const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
    for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
  }
}

describe('telnet codec [S13]', () => {
  it('decodes TCP 23 as telnet: the password prompt with IAC WILL ECHO, in the clear', () => {
    expect(lookupNext('tcp.port', 23)).toBe('telnet');
    const b = encodeLayers(segment(23, 49152, { proto: 'telnet', fields: { iac: 'WILL ECHO;WILL SUPPRESS-GO-AHEAD', data: 'Password: ' } }));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'tcp', 'telnet']);
    expect(layerBytes(b, layers[2]!)).toEqual(hex('fffb01 fffb03 50617373776f72643a20'));
    expect(layers[2]!.fields).toEqual({ data: 'Password: ', iac: 'WILL ECHO;WILL SUPPRESS-GO-AHEAD' });
    checkNames(layers);
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe('Telnet [WILL ECHO, WILL SUPPRESS-GO-AHEAD] "Password: "');
  });

  it('carries a typed password character in the clear, one per segment', () => {
    const b = encodeLayers(segment(49152, 23, { proto: 'telnet', fields: { data: 'N' } }));
    const layers = decodeLayers(b, 'ipv4');
    expect(layerBytes(b, layers[2]!)).toEqual([0x4e]);
    expect(layers[2]!.fields).toEqual({ data: 'N', iac: '' });
  });

  it('reads commands interleaved with text, subnegotiations, a doubled IAC and a command cut at the segment end', () => {
    const mixed = Uint8Array.from([0x61, 0x62, 0xff, 0xfd, 0x01, 0x63, 0xff, 0xf9, 0xff, 0xfa, 24, 0x01, 0xff, 0xf0, 0xff, 0xfb, 99]);
    const d = telnetCodec.decode(mixed, 0, mixed.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual({ data: 'abc', iac: 'DO ECHO;GA;SB TERMINAL-TYPE 01;WILL 99' });
    // re-encoded in the canonical order: the commands first, then the text
    expect(Array.from(telnetCodec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual([0xff, 0xfd, 0x01, 0xff, 0xf9, 0xff, 0xfa, 24, 0x01, 0xff, 0xf0, 0xff, 0xfb, 99, 0x61, 0x62, 0x63]);
    expect(telnetCodec.decode(Uint8Array.from([0x41, 0xff]), 0, 2).error).toBe('partial');
    expect(telnetCodec.decode(Uint8Array.from([0xff, 0xfb]), 0, 2).error).toBe('partial');
    expect(telnetCodec.decode(Uint8Array.from([0xff, 0xfa, 24, 1]), 0, 4).error).toBe('partial');
    const doubled = telnetCodec.decode(Uint8Array.from([0x41, 0xff, 0xff]), 0, 3);
    expect(doubled.error).toBeUndefined();
    expect((doubled.fields.data as string).startsWith('A')).toBe(true);
    expect(TELNET_OPTION.ECHO).toBe(1);
    expect(() => telnetCodec.encode({ iac: 'WILL NOPE' }, new Uint8Array(0))).toThrow(/unknown option/);
    expect(() => telnetCodec.encode({ iac: 'JUMP' }, new Uint8Array(0))).toThrow(/unknown command/);
  });
});

describe('simulated SSH codec [S13]', () => {
  it('decodes TCP 22 as ssh: the clear version exchange', () => {
    expect(lookupNext('tcp.port', 22)).toBe('ssh');
    const b = encodeLayers(segment(22, 49153, { proto: 'ssh', fields: { phase: 'version', version: 'SSH-2.0-NF_1.0' } }));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'tcp', 'ssh']);
    expect(layerBytes(b, layers[2]!)).toEqual(hex('5353482d322e302d4e465f312e300d0a'));
    expect(layers[2]!.fields).toEqual({ phase: 'version', version: 'SSH-2.0-NF_1.0' });
    checkNames(layers);
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe('SSH version exchange SSH-2.0-NF_1.0');
  });

  it('carries a protected packet as length and payload bytes (the keystream is the daemon\'s)', () => {
    const payload = Uint8Array.from([0x9e, 0x21, 0x7a, 0x00, 0xff]);
    const b = encodeLayers(segment(49153, 22, { proto: 'ssh', fields: { phase: 'protected', payload } }));
    const layers = decodeLayers(b, 'ipv4');
    expect(layerBytes(b, layers[2]!)).toEqual(hex('00000005 9e217a00ff'));
    expect(layers[2]!.fields).toEqual({ phase: 'protected', length: 5, payload });
    expect(layers[2]!.headerLength).toBe(4);
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe('SSH protected packet, 5 bytes');
  });

  it('reports a packet split across segments as partial and refuses a malformed version line', () => {
    const cut = sshCodec.decode(Uint8Array.from([0, 0, 0, 10, 1, 2, 3]), 0, 7);
    expect(cut.error).toBe('partial');
    expect(cut.fields).toEqual({ phase: 'protected', length: 10, payload: Uint8Array.from([1, 2, 3]) });
    expect(sshCodec.decode(Uint8Array.from([0, 0]), 0, 2).error).toBe('partial');
    const line = new TextEncoder().encode('SSH-2.0-NF');
    expect(sshCodec.decode(line, 0, line.length)).toMatchObject({ fields: { phase: 'version', version: 'SSH-2.0-NF' }, error: 'partial' });
    expect(() => sshCodec.encode({ phase: 'version', version: 'HTTP/1.1' }, new Uint8Array(0))).toThrow(/one 'SSH-…' line/);
    expect(() => sshCodec.encode({ phase: 'other' }, new Uint8Array(0))).toThrow(/'version' or 'protected'/);
  });
});
