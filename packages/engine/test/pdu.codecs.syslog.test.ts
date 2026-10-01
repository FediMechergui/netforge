/**
 * [S25] Syslog codec (ARCHITECTURE-P3 §7 W1 approved pdu items, D20, §2.3, §3.7 step 8): UDP 514 is no longer reserved;
 * RFC 3164-style `<PRI>TIMESTAMP HOSTNAME: message`. Goldens assembled independently of the engine.
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_UDP, UDP_PORT_SYSLOG } from '../src/contracts/pdu.js';
import type { LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { lookupNext } from '../src/pdu/codecs/dispatch.js';
import { SYSLOG_FACILITY_NAMES, SYSLOG_SEVERITY_NAMES, syslogCodec } from '../src/pdu/codecs/syslog.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView, len = l.length): number[] => Array.from(b.slice(l.offset, l.offset + len));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const MESSAGE = '%LINK-3-UPDOWN: Interface GigabitEthernet0/2 link state is now down';
/** `<187>Jan  6 08:10:03.123 R1: %LINK-3-UPDOWN: …` in ASCII (local7 × 8 + errors = 187). */
const LINE = '3c3138373e' + '4a616e2020362030383a31303a30332e313233' + '20' + '5231' + '3a20' +
  '254c494e4b2d332d5550444f574e3a20496e74657266616365204769676162697445746865726e6574302f32206c696e6b207374617465206973206e6f7720646f776e';

describe('syslog codec [S25]', () => {
  it('encodes the §3.7 message to UDP 514 and derives facility local7 and severity errors', () => {
    expect(lookupNext('udp.port', UDP_PORT_SYSLOG)).toBe('syslog');
    const b = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.10', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_SYSLOG, dstPort: UDP_PORT_SYSLOG } },
      { proto: 'syslog', fields: { pri: 187, timestamp: 'Jan  6 08:10:03.123', hostname: 'R1', message: MESSAGE } },
    ]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'udp', 'syslog']);
    expect(layerBytes(b, layers[1]!, 8)).toEqual(hex('0202 0202 0068 c940'));
    expect(layerBytes(b, layers[2]!)).toEqual(hex(LINE));
    expect(layers[2]!.fields).toEqual({ pri: 187, facility: 23, severity: 3, timestamp: 'Jan  6 08:10:03.123', hostname: 'R1', message: MESSAGE });
    expect(layers[2]!.error).toBeUndefined();
    const names = new Set(PROTO_FIELDS.syslog!.fields.map((x) => x.name));
    for (const k of Object.keys(layers[2]!.fields)) expect(names.has(k), k).toBe(true);
    const rng = layers[2]!.fieldRanges;
    expect(Array.from(b.slice(rng.hostname![0], rng.hostname![0] + rng.hostname![1]))).toEqual(Array.from(text('R1')));
    expect(Array.from(b.slice(rng.message![0], rng.message![0] + rng.message![1]))).toEqual(Array.from(text(MESSAGE)));
    expect(SYSLOG_FACILITY_NAMES[23]).toBe('local7');
    expect(SYSLOG_SEVERITY_NAMES[3]).toBe('errors');
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe(`Syslog local7.errors from R1: ${MESSAGE.slice(0, 60)}…`);
  });

  it('round-trips an unauthoritative timestamp, a message without a timestamp, and one without a hostname', () => {
    for (const fields of [
      { pri: 189, timestamp: '*Jan  1 00:00:12.500', hostname: 'SW1', message: '%SYS-5-CONFIG: configuration changed from the console' },
      { pri: 190, timestamp: '', hostname: 'R2', message: 'plain text: with a colon' },
      { pri: 13, timestamp: '', hostname: '', message: '%LINEPROTO-5-UPDOWN: Line protocol on Serial0/0/0 is now up' },
    ]) {
      const b = syslogCodec.encode({ ...fields }, new Uint8Array(0));
      const d = syslogCodec.decode(b, 0, b.length);
      expect(d.error).toBeUndefined();
      expect(d.fields).toEqual({ ...fields, facility: fields.pri >>> 3, severity: fields.pri & 7 });
      expect(Array.from(syslogCodec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual(Array.from(b));
    }
  });

  it('refuses what it could not read back and reports text without a priority', () => {
    expect(() => syslogCodec.encode({ pri: 192 }, new Uint8Array(0))).toThrow(/pri out of range/);
    expect(() => syslogCodec.encode({ pri: 1, hostname: 'two words' }, new Uint8Array(0))).toThrow(/one word/);
    expect(() => syslogCodec.encode({ pri: 1, timestamp: 'Jan  6 08:10:03' }, new Uint8Array(0))).toThrow(/needs a hostname/);
    expect(() => syslogCodec.encode({}, new Uint8Array(0))).toThrow(/syslog.pri is required/);
    const junk = syslogCodec.decode(text('hello'), 0, 5);
    expect(junk.error).toBe('not a syslog message (no <priority>)');
    expect(junk.fields).toEqual({ message: 'hello' });
    expect(syslogCodec.decode(text('<999>x'), 0, 6).error).toMatch(/not a syslog message/);
  });
});
