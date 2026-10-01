/**
 * [S19] PPP family codecs (ARCHITECTURE-P3 §7 W1 approved pdu items, D17, §2.3, §3.9): `ppp` framing (RFC 1662 without
 * flags, the existing CRC-16/X.25), `lcp`, `pap`, `chap`, `ipcp`, `ipv6cp`, the new `ppp.proto` dispatch space and
 * `LINK_FIELDS.ppp`. Goldens assembled independently of the engine; the CHAP response is the RFC 1994 §4.1 value
 * MD5(identifier ‖ secret ‖ challenge), checked here against node's own MD5.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ICMP_ECHO_REQUEST, IPPROTO_ICMP, PPP_PROTO } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, decodeStandalone, encodeLayers, fillLinkField } from '../src/pdu/codecs/registry.js';
import { keyForProto, linkFieldFor, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { crc16X25 } from '../src/pdu/checksum.js';
import { PPP_CP_CODE, pppCodec } from '../src/pdu/codecs/ppp.js';
import { lcpCodec } from '../src/pdu/codecs/lcp.js';
import { CHAP_CODE, chapCodec } from '../src/pdu/codecs/chap.js';
import { PAP_CODE, papCodec } from '../src/pdu/codecs/pap.js';
import { ipcpCodec } from '../src/pdu/codecs/ipcp.js';
import { ipv6cpCodec } from '../src/pdu/codecs/ipv6cp.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });
const ascii = (s: string): number[] => Array.from(new TextEncoder().encode(s));

function checkNames(layers: readonly LayerView[]): void {
  for (const layer of layers) {
    const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
    for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
  }
}

/** §3.9 step 3: R1's LCP configure-request, CHAP with MD5 and a magic number (21 bytes; 23 on the wire with flags). */
const LCP_CONFREQ = 'ff 03 c021' + ' 01 01 000f' + ' 03 05 c223 05' + ' 05 06 1a2b3c4d' + ' 1d32';
const LCP_CONFACK = 'ff 03 c021' + ' 02 01 000f' + ' 03 05 c223 05' + ' 05 06 5e6f7081' + ' 8908';
const CHALLENGE = Uint8Array.from([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]);
const CHAP_CHALLENGE = 'ff 03 c223' + ' 01 01 0017 10 101112131415161718191a1b1c1d1e1f 5231' + ' 3da3';
/** RFC 1994 §4.1 response for identifier 1, secret 'NetF0rge' and the challenge above. */
const MD5_RESPONSE = 'fda50d0f5a402e218eb16143209b2ad1';
const CHAP_RESPONSE = 'ff 03 c223' + ` 02 01 0017 10 ${MD5_RESPONSE} 5232` + ' 043c';
const CHAP_SUCCESS = 'ff 03 c223' + ' 03 01 000b 57656c636f6d65' + ' b4c0';
const PAP_REQUEST = 'ff 03 c023' + ' 01 01 0010 02 5231 08 4e65744630726765' + ' e31c';
const IPCP_CONFREQ = 'ff 03 8021' + ' 01 01 000a 03 06 0a010101' + ' 30a6';
const IPV6CP_CONFREQ = 'ff 03 8057' + ' 01 01 000e 01 0a 0200000000000001' + ' fb4f';
const PPP_IPV4 = 'ff 03 0021' + ' 4500001c 0000 0000 ff 01 a5dc 0a010101 0a010102 0800 f7f7 0007 0001' + ' db85';
const LCP_TERMINATE = 'ff 03 c021' + ' 05 02 0019 61757468656e7469636174696f6e206661696c6564' + ' e900';
const LCP_ECHO = 'ff 03 c021' + ' 09 03 0008 1a2b3c4d' + ' a475';

const frame = (inner: LayerSpec): LayerSpec[] => [{ proto: 'ppp', fields: {} }, inner];

describe('PPP framing [S19]', () => {
  it('frames an LCP configure-request (the §3.9 23-byte frame), filling ppp.protocol from the inner layer', () => {
    expect(linkFieldFor('ppp')).toEqual({ field: 'protocol', space: 'ppp.proto' });
    expect(fillLinkField('ppp', {}, 'lcp')).toEqual({ protocol: 0xc021 });
    const b = encodeLayers(frame({ proto: 'lcp', fields: { code: PPP_CP_CODE.configureRequest, id: 1, authProto: 'chap-md5', magic: 0x1a2b3c4d } }));
    expect(Array.from(b)).toEqual(hex(LCP_CONFREQ));
    expect(b.length + 2).toBe(23); // plus the two flags the serial link counts for timing
    const layers = decodeLayers(b, 'ppp');
    expect(protos(layers)).toEqual(['ppp', 'lcp']);
    expect(layers[0]!.fields).toEqual({ address: 0xff, control: 0x03, protocol: 0xc021, fcs: 0x321d, fcsValid: true });
    expect(layers[0]!.trailerLength).toBe(2);
    expect(layers[1]!.fields).toEqual({ code: 1, id: 1, length: 15, authProto: 'chap-md5', magic: 0x1a2b3c4d });
    checkNames(layers);
    expect(crc16X25(b, 0, b.length - 2)).toBe(0x321d);
    expect(createPduFactory().decode(b, meta(), 'ppp').summary()).toBe('LCP configure-request id 1, auth chap-md5, magic 0x1a2b3c4d');
    const ack = encodeLayers(frame({ proto: 'lcp', fields: { code: PPP_CP_CODE.configureAck, id: 1, authProto: 'chap-md5', magic: 0x5e6f7081 } }));
    expect(Array.from(ack)).toEqual(hex(LCP_CONFACK));
  });

  it('dispatches every PPP_PROTO value in the ppp.proto space and carries an IPv4 ping on 0x0021', () => {
    for (const [name, key] of Object.entries(PPP_PROTO)) {
      expect(lookupNext('ppp.proto', key)).toBe(name);
      expect(keyForProto('ppp.proto', name)).toBe(key);
    }
    const b = encodeLayers([
      { proto: 'ppp', fields: {} },
      { proto: 'ipv4', fields: { src: '10.1.1.1', dst: '10.1.1.2', ttl: 255, protocol: IPPROTO_ICMP } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 7, seq: 1 } },
    ]);
    expect(Array.from(b)).toEqual(hex(PPP_IPV4));
    expect(protos(decodeLayers(b, 'ppp'))).toEqual(['ppp', 'ipv4', 'icmpv4', 'payload']); // the echo carries no data
    const pdu = createPduFactory().decode(b, meta(), 'ppp');
    expect(pdu.topProto()).toBe('icmpv4');
    // a capture record without its CRC (fcsLen 0) bounds the payload and invents no FCS
    const noFcs = decodeStandalone(b.slice(0, b.length - 2), 'ppp', { fcsLen: 0 });
    expect(noFcs.layers[0]!.fields.fcs).toBeUndefined();
    expect(protos(noFcs.layers)).toEqual(['ppp', 'ipv4', 'icmpv4', 'payload']);
    // a damaged frame keeps its layers and reports the FCS
    const bad = b.slice();
    bad[10] = bad[10]! ^ 0x01;
    expect(decodeLayers(bad, 'ppp')[0]!.fields.fcsValid).toBe(false);
    expect(pppCodec.decode(Uint8Array.from([0xff, 0x03, 0xc0]), 0, 3).error).toBe('PPP header truncated');
    expect(() => pppCodec.encode({}, new Uint8Array(0))).toThrow(/ppp.protocol is required/);
  });
});

describe('LCP [S19]', () => {
  it('terminates with a reason text, echoes a magic number, and names what it rejects', () => {
    const term = encodeLayers(frame({ proto: 'lcp', fields: { code: PPP_CP_CODE.terminateRequest, id: 2, reason: 'authentication failed' } }));
    expect(Array.from(term)).toEqual(hex(LCP_TERMINATE));
    expect(decodeLayers(term, 'ppp')[1]!.fields).toEqual({ code: 5, id: 2, length: 25, reason: 'authentication failed' });
    const echo = encodeLayers(frame({ proto: 'lcp', fields: { code: PPP_CP_CODE.echoRequest, id: 3, echoMagic: 0x1a2b3c4d } }));
    expect(Array.from(echo)).toEqual(hex(LCP_ECHO));
    expect(decodeLayers(echo, 'ppp')[1]!.fields).toEqual({ code: 9, id: 3, length: 8, echoMagic: 0x1a2b3c4d });
    // a configure-reject lists the options it carries; on encode it selects them
    const rej = lcpCodec.encode({ code: PPP_CP_CODE.configureReject, id: 4, mru: 1500, authProto: 'pap', magic: 7, rejected: 'auth-proto' }, new Uint8Array(0));
    expect(Array.from(rej)).toEqual(hex('04 04 0008 03 04 c023'));
    expect(lcpCodec.decode(rej, 0, rej.length).fields).toEqual({ code: 4, id: 4, length: 8, authProto: 'pap', rejected: 'auth-proto' });
    const all = lcpCodec.encode({ code: PPP_CP_CODE.configureReject, id: 5, mru: 1500, magic: 7 }, new Uint8Array(0));
    expect(lcpCodec.decode(all, 0, all.length).fields).toMatchObject({ mru: 1500, magic: 7, rejected: 'mru,magic' });
    // a protocol-reject names the protocol the peer does not run (IPv6CP here)
    const pr = lcpCodec.encode({ code: PPP_CP_CODE.protocolReject, id: 6, rejected: '0x8057' }, new Uint8Array(0));
    expect(Array.from(pr)).toEqual(hex('08 06 0006 8057'));
    expect(lcpCodec.decode(pr, 0, pr.length).fields).toEqual({ code: 8, id: 6, length: 6, rejected: '0x8057' });
    expect(() => lcpCodec.encode({ code: 1, id: 1, authProto: 'eap' }, new Uint8Array(0))).toThrow(/'pap' or 'chap-md5'/);
    expect(() => lcpCodec.encode({ code: 4, id: 1, rejected: 'mru' }, new Uint8Array(0))).toThrow(/lcp.mru is not set/);
    expect(lcpCodec.decode(Uint8Array.from([1, 1, 0, 9, 3, 9, 0xc2, 0x23, 5]), 0, 9).error).toMatch(/option 3 has a bad length 9/);
    expect(lcpCodec.decode(Uint8Array.from([1, 1, 0, 30]), 0, 4).error).toMatch(/LCP packet truncated/);
  });
});

describe('CHAP and PAP [S19]', () => {
  it('pins the RFC 1994 vector: the response is MD5(identifier ‖ secret ‖ challenge), and the secret never travels', () => {
    const md5 = createHash('md5').update(Uint8Array.from([1])).update('NetF0rge').update(CHALLENGE).digest();
    expect(md5.toString('hex')).toBe(MD5_RESPONSE);
    const challenge = encodeLayers(frame({ proto: 'chap', fields: { code: CHAP_CODE.challenge, id: 1, value: CHALLENGE, name: 'R1' } }));
    expect(Array.from(challenge)).toEqual(hex(CHAP_CHALLENGE));
    const response = encodeLayers(frame({ proto: 'chap', fields: { code: CHAP_CODE.response, id: 1, value: Uint8Array.from(md5), name: 'R2' } }));
    expect(Array.from(response)).toEqual(hex(CHAP_RESPONSE));
    const d = decodeLayers(response, 'ppp');
    expect(protos(d)).toEqual(['ppp', 'chap']);
    expect(d[1]!.fields).toEqual({ code: 2, id: 1, value: Uint8Array.from(md5), name: 'R2' });
    checkNames(d);
    const secret = ascii('NetF0rge');
    const contains = (hay: Uint8Array, needle: number[]): boolean => {
      for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((v, k) => hay[i + k] === v)) return true;
      return false;
    };
    expect(contains(challenge, secret)).toBe(false);
    expect(contains(response, secret)).toBe(false);
    const success = encodeLayers(frame({ proto: 'chap', fields: { code: CHAP_CODE.success, id: 1, message: 'Welcome' } }));
    expect(Array.from(success)).toEqual(hex(CHAP_SUCCESS));
    expect(createPduFactory().decode(success, meta(), 'ppp').summary()).toBe('CHAP success id 1: Welcome');
    expect(createPduFactory().decode(challenge, meta(), 'ppp').summary()).toBe('CHAP challenge id 1 from R1');
    expect(() => chapCodec.encode({ code: 1, id: 1 }, new Uint8Array(0))).toThrow(/1 to 255 bytes/);
    expect(chapCodec.decode(Uint8Array.from([1, 1, 0, 6, 16, 1]), 0, 6).error).toMatch(/runs past the packet/);
  });

  it('PAP sends the password in the clear, by design', () => {
    const b = encodeLayers(frame({ proto: 'pap', fields: { code: PAP_CODE.authenticateRequest, id: 1, peerId: 'R1', password: 'NetF0rge' } }));
    expect(Array.from(b)).toEqual(hex(PAP_REQUEST));
    const d = decodeLayers(b, 'ppp');
    expect(d[1]!.fields).toEqual({ code: 1, id: 1, peerId: 'R1', password: 'NetF0rge' });
    checkNames(d);
    const ack = papCodec.encode({ code: PAP_CODE.authenticateAck, id: 1, message: 'ok' }, new Uint8Array(0));
    expect(Array.from(ack)).toEqual(hex('02 01 0007 02 6f6b'));
    expect(papCodec.decode(ack, 0, ack.length).fields).toEqual({ code: 2, id: 1, message: 'ok' });
    expect(papCodec.decode(Uint8Array.from([1, 1, 0, 6, 2, 0x52]), 0, 6).error).toBe('PAP authenticate-request truncated');
    expect(createPduFactory().decode(b, meta(), 'ppp').summary()).toBe('PAP authenticate-request id 1 from R1');
  });
});

describe('IPCP and IPv6CP [S19]', () => {
  it('negotiate an IPv4 address and an interface identifier', () => {
    const v4 = encodeLayers(frame({ proto: 'ipcp', fields: { code: PPP_CP_CODE.configureRequest, id: 1, ipAddress: '10.1.1.1' } }));
    expect(Array.from(v4)).toEqual(hex(IPCP_CONFREQ));
    const d4 = decodeLayers(v4, 'ppp');
    expect(d4[1]!.fields).toEqual({ code: 1, id: 1, ipAddress: '10.1.1.1' });
    checkNames(d4);
    const v6 = encodeLayers(frame({ proto: 'ipv6cp', fields: { code: PPP_CP_CODE.configureRequest, id: 1, interfaceId: '0200000000000001' } }));
    expect(Array.from(v6)).toEqual(hex(IPV6CP_CONFREQ));
    const d6 = decodeLayers(v6, 'ppp');
    expect(d6[1]!.fields).toEqual({ code: 1, id: 1, interfaceId: '0200000000000001' });
    checkNames(d6);
    expect(createPduFactory().decode(v4, meta(), 'ppp').summary()).toBe('IPCP configure-request id 1, address 10.1.1.1');
    const term = ipcpCodec.encode({ code: PPP_CP_CODE.terminateAck, id: 9 }, new Uint8Array(0));
    expect(Array.from(term)).toEqual(hex('06 09 0004'));
    expect(ipcpCodec.decode(term, 0, 4).fields).toEqual({ code: 6, id: 9 });
    expect(() => ipcpCodec.encode({ code: 8, id: 1 }, new Uint8Array(0))).toThrow(/ipcp.code out of range/);
    expect(() => ipv6cpCodec.encode({ code: 1, id: 1, interfaceId: 'xyz' }, new Uint8Array(0))).toThrow(/16 hex digits/);
  });
});
