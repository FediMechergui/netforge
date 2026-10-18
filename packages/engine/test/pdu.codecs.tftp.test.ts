/**
 * [S29] TFTP codec (ARCHITECTURE-P3C §7 W1b pdu, §2.3, §3.4): RFC 1350 packets, the RFC 2347 option acknowledgement and
 * the RFC 2349 `tsize` option, and the dispatch of UDP 69 (no longer reserved). Goldens assembled by hand from the
 * RFC layouts (ASCII spelled out byte by byte), independently of the engine.
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_UDP, UDP_PORT_TFTP } from '../src/contracts/pdu.js';
import type { LayerView, PduMeta } from '../src/contracts/pdu.js';
import { DISPATCH_TABLE, PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { keyForProto, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { TFTP_ERROR, TFTP_MAX_DATA, TFTP_OPCODE, tftpCodec } from '../src/pdu/codecs/tftp.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { TFTP_RRQ_BYTES } from './profile-digests.harness.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const bytesOf = (s: string): Uint8Array => Uint8Array.from(hex(s));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });
const dec = (s: string | Uint8Array) => {
  const b = typeof s === 'string' ? bytesOf(s) : s;
  return tftpCodec.decode(b, 0, b.length);
};
const enc = (fields: Record<string, unknown>): number[] => Array.from(tftpCodec.encode(fields as never, new Uint8Array(0)));

/** §3.4 step 5: `copy tftp: flash:` asks the size of nf2900-15.9.bin (RRQ, octet, tsize 0). */
const RRQ_TSIZE = '0001' + '6e66323930302d31352e392e62696e 00' + '6f63746574 00' + '7473697a65 00' + '30 00';
/** The server's OACK: tsize 40960. */
const OACK = '0006' + '7473697a65 00' + '3430393630 00';
/** §3.4 step 1: the backup's write request, r1-confg, octet. */
const WRQ = '0002' + '72312d636f6e6667 00' + '6f63746574 00';
/** DATA block 1 holding "hostname R1\n" (12 bytes: the last block). */
const DATA1 = '0003 0001' + '686f73746e616d652052310a';
/** ACK 0 (answers a WRQ or an OACK). */
const ACK0 = '0004 0000';
/** ERROR 3 "disk full" (the flash-full refusal of an OACK). */
const ERR3 = '0005 0003' + '6469736b2066756c6c 00';

describe('tftp codec [S29]', () => {
  it('encodes and decodes the six opcodes byte for byte', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ opcode: TFTP_OPCODE.rrq, filename: 'nf2900-15.9.bin', mode: 'octet', tsize: 0 }, RRQ_TSIZE],
      [{ opcode: TFTP_OPCODE.oack, tsize: 40960 }, OACK],
      [{ opcode: TFTP_OPCODE.wrq, filename: 'r1-confg', mode: 'octet' }, WRQ],
      [{ opcode: TFTP_OPCODE.data, block: 1, data: new TextEncoder().encode('hostname R1\n') }, DATA1],
      [{ opcode: TFTP_OPCODE.ack, block: 0 }, ACK0],
      [{ opcode: TFTP_OPCODE.error, errorCode: TFTP_ERROR.diskFull, errorMsg: 'disk full' }, ERR3],
    ];
    for (const [fields, golden] of cases) {
      expect(enc(fields)).toEqual(hex(golden));
      const d = dec(golden);
      expect(d.error).toBeUndefined();
      expect(d.fields).toEqual(fields);
      expect(d.length).toBe(hex(golden).length);
    }
    expect(enc({ opcode: 1, filename: 'r1-confg' })).toEqual(hex('0001 72312d636f6e6667 00 6f63746574 00')); // mode defaults to octet
    expect(dec(RRQ_TSIZE).fieldRanges).toEqual({ opcode: [0, 2], filename: [2, 15], mode: [18, 5], tsize: [24, 8] });
    expect(dec(DATA1).fieldRanges).toEqual({ opcode: [0, 2], block: [2, 2], data: [4, 12] });
  });

  it('summarises each opcode in original wording', () => {
    expect(tftpCodec.summarize(dec(RRQ_TSIZE).fields)).toBe('TFTP read request "nf2900-15.9.bin", mode octet, tsize 0');
    expect(tftpCodec.summarize(dec(WRQ).fields)).toBe('TFTP write request "r1-confg", mode octet');
    expect(tftpCodec.summarize(dec(OACK).fields)).toBe('TFTP option acknowledgement, tsize 40960');
    expect(tftpCodec.summarize(dec(DATA1).fields)).toBe('TFTP data, block 1, 12 bytes (last)');
    expect(tftpCodec.summarize({ opcode: 3, block: 2, data: new Uint8Array(TFTP_MAX_DATA) })).toBe('TFTP data, block 2, 512 bytes');
    expect(tftpCodec.summarize(dec(ACK0).fields)).toBe('TFTP acknowledgement, block 0');
    expect(tftpCodec.summarize(dec(ERR3).fields)).toBe('TFTP error 3: disk full');
    expect(tftpCodec.summarize({})).toBe('TFTP (truncated)');
  });

  it('reads tsize with any case, skips every other option, and carries a full and an empty DATA block', () => {
    // RFC 2348 blksize 1428 first (not modelled, skipped), then TSIZE in capitals
    const d = dec('0001 6100 6f6374657400 626c6b73697a6500 3134323800 5453495a4500 31303200');
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual({ opcode: 1, filename: 'a', mode: 'octet', tsize: 102 });
    const full = new Uint8Array(TFTP_MAX_DATA).map((_, i) => i & 0xff);
    const b = enc({ opcode: 3, block: 80, data: full });
    expect(b.length).toBe(516);
    expect(dec(Uint8Array.from(b)).fields).toEqual({ opcode: 3, block: 80, data: full });
    expect(enc({ opcode: 3, block: 81 })).toEqual(hex('0003 0051')); // RFC 1350: a multiple of 512 ends with an empty block
    expect(dec('0003 0051').fields).toEqual({ opcode: 3, block: 81, data: new Uint8Array(0) });
  });

  it('decodes malformed packets tolerantly, with an error', () => {
    const cases: [string, string][] = [
      ['', 'TFTP packet truncated'],
      ['00', 'TFTP packet truncated'],
      ['0001 6162', 'TFTP file name not terminated'],
      ['0001 6100 6f63', 'TFTP mode not terminated'],
      ['0001 6100 6f00 7473697a6500', 'TFTP option value not terminated'],
      ['0001 6100 6f00 7473', 'TFTP option name not terminated'],
      ['0006 7473697a6500 2d3100', 'TFTP tsize value is not a size: "-1"'],
      ['0003 00', 'TFTP packet truncated'],
      ['0004 0001 00', 'TFTP acknowledgement longer than 4 bytes'],
      ['0005 0001 6e6f', 'TFTP error message not terminated'],
      ['0009', 'TFTP opcode 9 is not defined'],
    ];
    for (const [h, error] of cases) expect([h, dec(h).error]).toEqual([h, error]);
    expect(dec('0005 0001 6e6f').fields).toEqual({ opcode: 5, errorCode: 1, errorMsg: 'no' });
    const big = new Uint8Array(4 + 513);
    big[1] = 3;
    expect(dec(big).error).toBe('TFTP data block longer than 512 bytes');
  });

  it('refuses to encode what RFC 1350 cannot carry', () => {
    expect(() => enc({})).toThrow(/tftp.opcode is required/);
    expect(() => enc({ opcode: 7 })).toThrow(/opcode 7 is not defined/);
    expect(() => enc({ opcode: 1 })).toThrow(/tftp.filename is required/);
    expect(() => enc({ opcode: 1, filename: '' })).toThrow(/must not be empty/);
    expect(() => enc({ opcode: 2, filename: 'a\u0000b' })).toThrow(/ASCII without NUL/);
    expect(() => enc({ opcode: 3, block: 1, data: new Uint8Array(513) })).toThrow(/at most 512 bytes/);
    expect(() => enc({ opcode: 4 })).toThrow(/tftp.block is required/);
    expect(() => enc({ opcode: 4, block: 65536 })).toThrow(/out of range/);
    expect(() => enc({ opcode: 6, tsize: -1 })).toThrow(/tsize out of range/);
    expect(() => enc({ opcode: 5 })).toThrow(/tftp.errorCode is required/);
    expect(() => tftpCodec.encode({ opcode: 4, block: 1 }, new Uint8Array(1))).toThrow(/no inner layer/);
  });
});

describe('tftp dispatch and field table', () => {
  it('dispatches UDP 69 to tftp (no longer reserved, stage P1 kept) and decodes the guard world request', () => {
    expect(lookupNext('udp.port', UDP_PORT_TFTP)).toBe('tftp');
    expect(keyForProto('udp.port', 'tftp')).toBe(69);
    expect(DISPATCH_TABLE.find((e) => e.space === 'udp.port' && e.key === 69)).toEqual({ space: 'udp.port', key: 69, proto: 'tftp', since: 'P1' });
    const b = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.0.100', dst: '10.0.0.1', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 49152, dstPort: UDP_PORT_TFTP } },
      { proto: 'payload', fields: { data: Uint8Array.from(TFTP_RRQ_BYTES) } },
    ]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'udp', 'tftp']);
    expect(layers[2]!.fields).toEqual({ opcode: 1, filename: 'startup-config', mode: 'octet' });
    expect(layerBytes(b, layers[2]!)).toEqual(Array.from(TFTP_RRQ_BYTES));
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe('TFTP read request "startup-config", mode octet');
    // the transfer between two ephemeral ports is not port-dispatched; a receiver decodes it from 'tftp' itself
    const data = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.0.100', dst: '10.0.0.1', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 49153, dstPort: 49152 } },
      { proto: 'tftp', fields: { opcode: 4, block: 1 } },
    ]);
    expect(protos(decodeLayers(data, 'ipv4'))).toEqual(['ipv4', 'udp', 'payload']);
  });

  it('declares the tftp table at P3c, and every decoded field is a name of its table', () => {
    expect(PROTO_FIELDS.tftp!.since).toBe('P3c');
    const names = new Set(PROTO_FIELDS.tftp!.fields.map((x) => x.name));
    for (const h of [RRQ_TSIZE, OACK, WRQ, DATA1, ACK0, ERR3]) {
      for (const k of Object.keys(dec(h).fields)) expect(names.has(k), k).toBe(true);
    }
  });
});
