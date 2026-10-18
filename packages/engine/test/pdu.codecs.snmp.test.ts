/**
 * [S33] [C23] SNMP codec (ARCHITECTURE-P3C §7 W1b pdu, §2.3, §3.5): RFC 3416 PDUs over the BER subset, the exceptions
 * 0x80–0x82, the v3 message header and USM parameters (RFC 3412, RFC 3414), and the dispatch of UDP 161 and 162.
 *
 * Every golden below was built independently of the engine: the GetRequest is the W0 guard world's hand-annotated
 * message (test/profile-digests.harness.ts), the GetBulk pair is annotated by hand here from the RFC 3416 §4.2.3
 * example (non-repeaters 1, max-repetitions 2 over sysUpTime, ipNetToMediaPhysAddress and ipNetToMediaType), and the
 * rest were packed by a separate BER script (X.690 definite lengths, minimal two's-complement integers, base-128
 * object identifier arcs) and checked by hand against the TLV comments.
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_UDP, UDP_PORT_SNMP, UDP_PORT_SNMP_TRAP } from '../src/contracts/pdu.js';
import type { LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { keyForProto, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { BER_TAG, SNMP_PDU_TAG, parseSnmpVarbinds, snmpCodec, snmpValueText, snmpVarbindsText } from '../src/pdu/codecs/snmp.js';
import type { SnmpVarbind } from '../src/pdu/codecs/snmp.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { SNMP_GET_BYTES } from './profile-digests.harness.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const bytesOf = (s: string): Uint8Array => Uint8Array.from(hex(s));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));
const meta = (): PduMeta => ({ born: 0, origin: 'd_nms' });
const dec = (s: string | Uint8Array) => {
  const b = typeof s === 'string' ? bytesOf(s) : s;
  return snmpCodec.decode(b, 0, b.length);
};
const enc = (fields: Record<string, unknown>): number[] => Array.from(snmpCodec.encode(fields as never, new Uint8Array(0)));

/** RFC 3416 §4.2.3: GetBulkRequest [non-repeaters = 1, max-repetitions = 2] (sysUpTime, ipNetToMediaPhysAddress, ipNetToMediaType). */
const BULK_REQ =
  '3043' + // Message SEQUENCE, 67 bytes
  '020101' + // version 1 = v2c
  '0406 7075626c6963' + // community "public"
  'a536' + // GetBulkRequest-PDU, 54 bytes
  '020101' + // request-id 1
  '020101' + // non-repeaters 1
  '020102' + // max-repetitions 2
  '302b' + // VarBindList, 43 bytes
  '300b 0607 2b06010201 0103 0500' + // sysUpTime (1.3.6.1.2.1.1.3) = NULL
  '300d 0609 2b06010201 04160102 0500' + // ipNetToMediaPhysAddress (1.3.6.1.2.1.4.22.1.2) = NULL
  '300d 0609 2b06010201 04160104 0500'; // ipNetToMediaType (1.3.6.1.2.1.4.22.1.4) = NULL

/** Its Response: sysUpTime.0 = 123456, then two rows of the ARP table (dynamic 9.2.3.4, static 10.0.0.51). */
const BULK_RESP =
  '308187' + // Message SEQUENCE, 135 bytes (long form)
  '020101 0406 7075626c6963' +
  'a27a' + // Response-PDU, 122 bytes
  '020101 020100 020100' + // request-id 1, noError, index 0
  '306f' +
  '300f 0608 2b0601020101 0300 4303 01e240' + // sysUpTime.0 = TimeTicks 123456
  '3018 060e 2b060102010416010201 09020304 0406 000010543210' + // ipNetToMediaPhysAddress.1.9.2.3.4
  '3013 060e 2b060102010416010401 09020304 020103' + // ipNetToMediaType.1.9.2.3.4 = dynamic(3)
  '3018 060e 2b060102010416010201 0a000033 0406 000010012345' + // ipNetToMediaPhysAddress.1.10.0.0.51
  '3013 060e 2b060102010416010401 0a000033 020104'; // ipNetToMediaType.1.10.0.0.51 = static(4)

/** The walk's end: both columns answer endOfMibView (0x82). */
const BULK_END =
  '305102010104067075626c6963a2440201030201000201003039300f06082b06010201010300430301e254' +
  '3012060e2b0601020104160102020a00000f8200' + '3012060e2b0601020104160104020a00000f8200';

/** SNMPv2-Trap linkDown (§3.5 step 4) to UDP 162, community NMS-TRAP, request-id 7. */
const TRAP =
  '3076 020101 0408 4e4d532d54524150' + // v2c, "NMS-TRAP"
  'a767 020107 020100 020100 305c' + // SNMPv2-Trap-PDU
  '300e 0608 2b0601020101 0300 4302 1068' + // sysUpTime.0 = 4200
  '3017 060a 2b060106030101040100 0609 2b0601060301010503' + // snmpTrapOID.0 = linkDown
  '300f 060a 2b06010201020201 0102 020102' + // ifIndex.2 = 2
  '300f 060a 2b06010201020201 0702 020101' + // ifAdminStatus.2 = up(1)
  '300f 060a 2b06010201020201 0802 020102'; // ifOperStatus.2 = down(2)

/** A response carrying every value type of the subset; request-id -2, notWritable (17) at index 1. */
const TYPES =
  '3081b702010104064e4d532d5257a281a90201fe02011102010130819d' +
  '301606082b06010201010200060a2b0601040181fd590103' + // sysObjectID.0 = 1.3.6.1.4.1.32473.1.3 (32473 = 81 fd 59)
  '3013060a2b060102010202010a01410500ffffffff' + // Counter32 4294967295 (a leading 00)
  '3012060a2b06010201020201050142043b9aca00' + // Gauge32 1000000000
  '3018060b2b060102011f0101010601460900ffffffffffffffff' + // Counter64 2^64-1
  '3015060d2b06010201041401010a00000140040a000001' + // IpAddress 10.0.0.1
  '300d06082b060102010107000201ff' + // INTEGER -1
  '300c06082b060102010108008000' + // noSuchObject
  '300c06082b060102010109008100'; // noSuchInstance

/** v3 authNoPriv GET sysName.0: msgId 100, maxSize 65507, flags auth|reportable, USM user admin, a zeroed auth code. */
const V3_AUTH =
  '306c 020103' +
  '300e 020164 020300ffe3 040105 020103' + // msgGlobalData
  '042c 302a 040a 80007ed9046e662d7231 020101 0202012c 0405 61646d696e 040c 000000000000000000000000 0400' + // USM
  '3029 040a 80007ed9046e662d7231 0400' + // ScopedPDU: contextEngineID, contextName ""
  'a019 020129 020100 020100 300e 300c 0608 2b0601020101 0500 0500'; // GetRequest sysName.0
/** v3 authPriv: the scoped PDU is an OCTET STRING of encrypted bytes. */
const V3_PRIV =
  '305b020103300e020165020300ffe304010702010304343032040a80007ed9046e662d72310201010202012c040561646d696e' +
  '040c0102030405060708090a0b0c0408a0a1a2a3a4a5a6a7' + '0410101112131415161718191a1b1c1d1e1f';
/** v3 noAuthNoPriv Report: usmStatsUnknownEngineIDs.0 = 1. */
const V3_REPORT =
  '305e020103300e020164020300ffe3040100020103041b3019040a80007ed9046e662d72310201010202012c040004000400' +
  '302c040a80007ed9046e662d72310400a81c0201290201000201003011300f060a2b060106030f01010400410101';

const ENGINE = bytesOf('80007ed9046e662d7231');

describe('snmp codec [S33]: RFC 3416 PDUs over BER', () => {
  it('decodes the guard world GetRequest and encodes it back byte for byte', () => {
    const b = Uint8Array.from(SNMP_GET_BYTES);
    const d = dec(b);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual({
      version: 1, community: 'public', pdu: 'get', requestId: 1, errorStatus: 0, errorIndex: 0,
      varbinds: '1.3.6.1.2.1.1.1.0=null', malformed: false,
    });
    expect(d.length).toBe(40);
    expect(d.fieldRanges.community).toEqual([7, 6]);
    expect(d.fieldRanges.pdu).toEqual([13, 2]);
    expect(enc(d.fields)).toEqual(Array.from(b));
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v2c get-request #1 (community "public"), 1 varbind: 1.3.6.1.2.1.1.1.0');
  });

  it('encodes the RFC 3416 §4.2.3 GetBulk exchange exactly and decodes it back', () => {
    const req = { version: 1, community: 'public', pdu: 'getbulk', requestId: 1, nonRepeaters: 1, maxRepetitions: 2,
      varbinds: '1.3.6.1.2.1.1.3=null; 1.3.6.1.2.1.4.22.1.2=null; 1.3.6.1.2.1.4.22.1.4=null' };
    expect(enc(req)).toEqual(hex(BULK_REQ));
    expect(dec(BULK_REQ).fields).toEqual({ ...req, malformed: false });
    const resp = { version: 1, community: 'public', pdu: 'response', requestId: 1, errorStatus: 0, errorIndex: 0,
      varbinds: '1.3.6.1.2.1.1.3.0=timeticks:123456; 1.3.6.1.2.1.4.22.1.2.1.9.2.3.4=octets:0x000010543210; ' +
        '1.3.6.1.2.1.4.22.1.4.1.9.2.3.4=integer:3; 1.3.6.1.2.1.4.22.1.2.1.10.0.0.51=octets:0x000010012345; ' +
        '1.3.6.1.2.1.4.22.1.4.1.10.0.0.51=integer:4' };
    expect(enc(resp)).toEqual(hex(BULK_RESP));
    expect(dec(BULK_RESP).fields).toEqual({ ...resp, malformed: false });
    expect(dec(BULK_END).fields.varbinds).toBe(
      '1.3.6.1.2.1.1.3.0=timeticks:123476; 1.3.6.1.2.1.4.22.1.2.2.10.0.0.15=endOfMibView; 1.3.6.1.2.1.4.22.1.4.2.10.0.0.15=endOfMibView');
    expect(enc(dec(BULK_END).fields)).toEqual(hex(BULK_END));
    expect(snmpCodec.summarize(dec(BULK_REQ).fields)).toBe('SNMP v2c get-bulk-request #1 (community "public"), 3 varbinds: 1.3.6.1.2.1.1.3, …');
  });

  it('carries an SNMPv2-Trap with an OID value (linkDown) and summarises it', () => {
    const fields = { version: 1, community: 'NMS-TRAP', pdu: 'trap', requestId: 7,
      varbinds: '1.3.6.1.2.1.1.3.0=timeticks:4200; 1.3.6.1.6.3.1.1.4.1.0=oid:1.3.6.1.6.3.1.1.5.3; ' +
        '1.3.6.1.2.1.2.2.1.1.2=integer:2; 1.3.6.1.2.1.2.2.1.7.2=integer:1; 1.3.6.1.2.1.2.2.1.8.2=integer:2' };
    expect(enc(fields)).toEqual(hex(TRAP));
    const d = dec(TRAP);
    expect(d.fields).toEqual({ ...fields, errorStatus: 0, errorIndex: 0, malformed: false });
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v2c trap #7 (community "NMS-TRAP"), 5 varbinds: 1.3.6.1.2.1.1.3.0, …');
  });

  it('round-trips every value type, a negative request id, the exceptions 0x80 and 0x81, and an error status', () => {
    const d = dec(TYPES);
    expect(d.error).toBeUndefined();
    expect(d.fields).toMatchObject({ community: 'NMS-RW', pdu: 'response', requestId: -2, errorStatus: 17, errorIndex: 1 });
    expect(parseSnmpVarbinds(d.fields.varbinds as string)).toEqual([
      { oid: '1.3.6.1.2.1.1.2.0', value: { type: 'oid', value: '1.3.6.1.4.1.32473.1.3' } },
      { oid: '1.3.6.1.2.1.2.2.1.10.1', value: { type: 'counter32', value: 4294967295 } },
      { oid: '1.3.6.1.2.1.2.2.1.5.1', value: { type: 'gauge32', value: 1000000000 } },
      { oid: '1.3.6.1.2.1.31.1.1.1.6.1', value: { type: 'counter64', value: '18446744073709551615' } },
      { oid: '1.3.6.1.2.1.4.20.1.1.10.0.0.1', value: { type: 'ipaddress', value: '10.0.0.1' } },
      { oid: '1.3.6.1.2.1.1.7.0', value: { type: 'integer', value: -1 } },
      { oid: '1.3.6.1.2.1.1.8.0', value: { type: 'noSuchObject' } },
      { oid: '1.3.6.1.2.1.1.9.0', value: { type: 'noSuchInstance' } },
    ]);
    expect(enc(d.fields)).toEqual(hex(TYPES));
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v2c response #-2 (community "NMS-RW"), notWritable at 1, 8 varbinds: 1.3.6.1.2.1.1.2.0, …');
    expect([BER_TAG.noSuchObject, BER_TAG.noSuchInstance, BER_TAG.endOfMibView]).toEqual([0x80, 0x81, 0x82]);
    expect(Object.values(SNMP_PDU_TAG)).toEqual([0xa0, 0xa1, 0xa2, 0xa3, 0xa5, 0xa7, 0xa8]);
  });

  it('writes long-form lengths (0x81, 0x82) and reads them back', () => {
    const text = 'NF '.repeat(70);
    const b = enc({ community: 'public', pdu: 'response', requestId: 5, varbinds: `1.3.6.1.2.1.1.1.0=octets:${JSON.stringify(text)}` });
    expect(b.slice(0, 3)).toEqual([0x30, 0x81, 0xfc]); // 252 bytes of message
    expect(b.slice(14, 17)).toEqual([0xa2, 0x81, 0xee]);
    expect(b.slice(42, 45)).toEqual([0x04, 0x81, 0xd2]); // 210 bytes of octets
    expect(b.length).toBe(255);
    const long = 'x'.repeat(300);
    const b2 = Uint8Array.from(enc({ community: 'public', pdu: 'set', varbinds: `1.3.6.1.2.1.1.4.0=octets:${JSON.stringify(long)}` }));
    expect(Array.from(b2.slice(0, 4))).toEqual([0x30, 0x82, 0x01, 0x5a]); // 346
    expect(parseSnmpVarbinds(dec(b2).fields.varbinds as string)[0]!.value).toEqual({ type: 'octets', value: long });
  });

  it('marks malformed messages and keeps what was read before the fault', () => {
    const cases: [string, string][] = [
      ['3080020101', 'SNMP message uses an indefinite length'],
      ['300302010', 'SNMP message runs past the message'],
      ['3003020102', 'SNMP version 2 is not defined'],
      ['300b020100 0406 7075626c6963', 'SNMP PDU missing'],
      ['3010 020100 0406 7075626c6963 a403 020101', 'SNMPv1 Trap-PDU is not simulated'],
      ['3010 020101 0406 7075626c6963 a603 020101', 'SNMP PDU type 0xa6 is not simulated'],
      ['301c 020101 0406 7075626c6963 a00f 020101 020100 020100 3004 3002 0600', 'SNMP varbind 1 name is empty'],
      ['3022 020101 0406 7075626c6963 a015 020101 020100 020100 300a 3008 0603 2b0601 4401 00', 'SNMP value type 0x44 is not simulated'],
      ['3021 020101 0406 7075626c6963 a014 020101 020100 020100 3009 3007 0603 2b0681 0500', 'SNMP varbind 1 name ends inside a sub-identifier'],
      ['3005 020101 0400 00', 'SNMP message is followed by other bytes'],
      ['0000', 'SNMP message has tag 0x00, expected 0x30'],
      ['30', 'SNMP message truncated'],
      ['', 'SNMP message missing'],
    ];
    for (const [h, error] of cases) {
      const d = dec(h);
      expect([h, d.error, d.fields.malformed]).toEqual([h, error, true]);
    }
    const v1 = dec('3010 020100 0406 7075626c6963 a403 020101');
    expect(v1.fields).toEqual({ version: 0, community: 'public', malformed: true });
    expect(snmpCodec.summarize(v1.fields)).toBe('SNMP v1 (malformed)');
    expect(snmpCodec.summarize({ malformed: true })).toBe('SNMP (malformed)');
  });

  it('refuses to encode what the subset cannot carry', () => {
    expect(() => enc({ pdu: 'get' })).toThrow(/snmp.community is required/);
    expect(() => enc({ community: 'x' })).toThrow(/snmp.pdu is required/);
    expect(() => enc({ community: 'x', pdu: 'inform' })).toThrow(/snmp.pdu must be one of/);
    expect(() => enc({ version: 2, community: 'x', pdu: 'get' })).toThrow(/snmp.version must be/);
    expect(() => enc({ community: 'x', pdu: 'get', varbinds: '1.3=integer:2147483648' })).toThrow(/out of range/);
    expect(() => enc({ community: 'x', pdu: 'get', varbinds: '3.1=null' })).toThrow(/invalid pair/);
    expect(() => enc({ community: 'x', pdu: 'get', varbinds: '1.3=counter64:18446744073709551616' })).toThrow(/counter64/);
    expect(() => enc({ community: 'x', pdu: 'get', varbinds: '1.3=octets:"Ā"' })).toThrow(/Latin-1/);
    expect(() => enc({ community: 'x', pdu: 'get', varbinds: '1.3=null:1' })).toThrow(/takes no value/);
  });
});

describe('snmp varbind text', () => {
  it('formats and parses every SnmpValue, with octets as a quoted string or 0x hex', () => {
    const list: SnmpVarbind[] = [
      { oid: '1.3.6.1.2.1.1.5.0', value: { type: 'octets', value: 'R1; "core"=1' } },
      { oid: '1.3.6.1.2.1.2.2.1.6.1', value: { type: 'octets', value: '\u0000\u0010T2\u0010ÿ' } },
      { oid: '1.3.6.1.2.1.1.3.0', value: { type: 'timeticks', value: 0 } },
      { oid: '1.3.6.1.2.1.1.2.0', value: { type: 'oid', value: '1.3.6.1.4.1.32473.1.1' } },
      { oid: '1.3.6.1.2.1.31.1.1.1.10.1', value: { type: 'counter64', value: '0' } },
      { oid: '1.3.6.1.2.1.1.1.0', value: { type: 'null' } },
      { oid: '1.3.6.1.2.1.1.9.1', value: { type: 'endOfMibView' } },
    ];
    const text = snmpVarbindsText(list);
    expect(text).toBe('1.3.6.1.2.1.1.5.0=octets:"R1; \\"core\\"=1"; 1.3.6.1.2.1.2.2.1.6.1=octets:0x0010543210ff; ' +
      '1.3.6.1.2.1.1.3.0=timeticks:0; 1.3.6.1.2.1.1.2.0=oid:1.3.6.1.4.1.32473.1.1; 1.3.6.1.2.1.31.1.1.1.10.1=counter64:0; ' +
      '1.3.6.1.2.1.1.1.0=null; 1.3.6.1.2.1.1.9.1=endOfMibView');
    expect(parseSnmpVarbinds(text)).toEqual(list);
    expect(parseSnmpVarbinds('')).toEqual([]);
    expect(snmpValueText({ type: 'ipaddress', value: '10.0.0.1' })).toBe('ipaddress:10.0.0.1');
    // the bytes of the round trip are the same through the codec
    const b = enc({ community: 'public', pdu: 'response', varbinds: text });
    expect(dec(Uint8Array.from(b)).fields.varbinds).toBe(text);
    expect(() => parseSnmpVarbinds('1.3.6=octets:"open')).toThrow(/unterminated/);
    expect(() => parseSnmpVarbinds('1.3.6=integer:1;')).toThrow(/no entry after it/);
    expect(() => parseSnmpVarbinds('1.3.6')).toThrow(/expected <oid>=<type>/);
    expect(() => parseSnmpVarbinds('1.3.6=float:1')).toThrow(/unknown value type/);
  });
});

describe('snmp codec [C23]: the v3 message header and USM parameters', () => {
  it('encodes and decodes an authNoPriv GetRequest; authParams ranges over the twelve bytes an HMAC replaces', () => {
    const fields = {
      version: 3, msgId: 100, msgMaxSize: 65507, msgFlags: 0x05, securityModel: 3,
      engineId: ENGINE, engineBoots: 1, engineTime: 300, userName: 'admin', authParams: new Uint8Array(12), privParams: new Uint8Array(0),
      contextEngineId: ENGINE, contextName: '', pdu: 'get', requestId: 41, errorStatus: 0, errorIndex: 0, varbinds: '1.3.6.1.2.1.1.5.0=null',
    };
    expect(enc(fields)).toEqual(hex(V3_AUTH));
    const d = dec(V3_AUTH);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual({ ...fields, malformed: false });
    expect(d.fieldRanges.authParams).toEqual([53, 12]);
    expect(Array.from(bytesOf(V3_AUTH).slice(51, 53))).toEqual([0x04, 0x0c]);
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v3 get-request #41 (user "admin", authNoPriv), 1 varbind: 1.3.6.1.2.1.1.5.0');
  });

  it('carries an authPriv scoped PDU as encrypted bytes: no PDU field is readable', () => {
    const fields = {
      version: 3, msgId: 101, msgMaxSize: 65507, msgFlags: 0x07, securityModel: 3, engineId: ENGINE, engineBoots: 1, engineTime: 300,
      userName: 'admin', authParams: bytesOf('0102030405060708090a0b0c'), privParams: bytesOf('a0a1a2a3a4a5a6a7'),
      encrypted: bytesOf('101112131415161718191a1b1c1d1e1f'),
    };
    expect(enc({ ...fields, pdu: 'get', varbinds: '1.3.6.1.2.1.1.5.0=null' })).toEqual(hex(V3_PRIV)); // the PDU fields are not written
    const d = dec(V3_PRIV);
    expect(d.fields).toEqual({ ...fields, malformed: false });
    expect(d.fields.pdu).toBeUndefined();
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v3 encrypted PDU (user "admin", authPriv)');
    expect(() => enc({ version: 3, msgFlags: 0x07 })).toThrow(/snmp.encrypted is required/);
  });

  it('carries a Report PDU (0xA8) and refuses another security model', () => {
    const d = dec(V3_REPORT);
    expect(d.fields).toMatchObject({ version: 3, msgFlags: 0, userName: '', pdu: 'report', requestId: 41, varbinds: '1.3.6.1.6.3.15.1.1.4.0=counter32:1' });
    expect(enc(d.fields)).toEqual(hex(V3_REPORT));
    expect(snmpCodec.summarize(d.fields)).toBe('SNMP v3 report #41 (user "", noAuthNoPriv), 1 varbind: 1.3.6.1.6.3.15.1.1.4.0');
    const other = bytesOf(V3_REPORT);
    other[20] = 2; // msgSecurityModel 2
    expect(dec(other)).toMatchObject({ error: 'SNMP security model 2 is not simulated', fields: { securityModel: 2, malformed: true } });
    expect(() => enc({ version: 3, securityModel: 2, pdu: 'get' })).toThrow(/securityModel must be 3/);
  });
});

describe('snmp dispatch and field table', () => {
  it('dispatches UDP 161 and 162 to snmp (no longer reserved) and the reverse lookup stays 161', () => {
    expect(lookupNext('udp.port', UDP_PORT_SNMP)).toBe('snmp');
    expect(lookupNext('udp.port', UDP_PORT_SNMP_TRAP)).toBe('snmp');
    expect(keyForProto('udp.port', 'snmp')).toBe(161);
    const trap = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.100', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 49152, dstPort: UDP_PORT_SNMP_TRAP } },
      { proto: 'payload', fields: { data: bytesOf(TRAP) } },
    ]);
    const layers = decodeLayers(trap, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'udp', 'snmp']);
    expect(layerBytes(trap, layers[2]!)).toEqual(hex(TRAP));
    // a response from 161 to an ephemeral port dispatches by its source port
    const resp = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.100', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_SNMP, dstPort: 49152 } },
      { proto: 'snmp', fields: dec(BULK_RESP).fields },
    ]);
    expect(protos(decodeLayers(resp, 'ipv4'))).toEqual(['ipv4', 'udp', 'snmp']);
    const pdu = createPduFactory().decode(resp, meta(), 'ipv4');
    expect(pdu.summary()).toBe('SNMP v2c response #1 (community "public"), 5 varbinds: 1.3.6.1.2.1.1.3.0, …');
  });

  it('declares the snmp table at P3c, and every decoded field is a name of its table', () => {
    expect(PROTO_FIELDS.snmp!.since).toBe('P3c');
    const names = new Set(PROTO_FIELDS.snmp!.fields.map((x) => x.name));
    for (const h of [BULK_REQ, BULK_RESP, BULK_END, TRAP, TYPES, V3_AUTH, V3_PRIV, V3_REPORT, '30100201000406' + '7075626c6963' + 'a403020101']) {
      for (const k of Object.keys(dec(h).fields)) expect(names.has(k), k).toBe(true);
    }
  });
});
