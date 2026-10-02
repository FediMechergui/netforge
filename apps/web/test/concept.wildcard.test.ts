/**
 * [S9] The wildcard visualizer model (ARCHITECTURE-P3 §6, §10.2 "concept.wildcard"; W2 web-concept).
 *
 * Under test: the three rows and the must-match / any bits, the count, contiguous and non-contiguous wildcards, the
 * octet and summary sentences, testing an address (the verdict is the engine's `wildcardMatches`), the three builders
 * (a prefix, a range through `rangeToAces`, a bit pattern) and the seeded practice generator.
 */
import { describe, expect, it } from 'vitest';
import { rangeToAces, wildcardMatches } from '@netforge/engine/pure';
import {
  WILDCARD_PRACTICE_KINDS,
  aceText,
  checkWildcardAnswer,
  parseWildcardInput,
  testWildcard,
  wildcardFromPattern,
  wildcardFromPrefix,
  wildcardPractice,
  wildcardPrefixLen,
  wildcardView,
  wildcardsFromRange,
} from '../src/concept/wildcard/model.js';

describe('the bit view', () => {
  it('192.168.1.0 0.0.0.255: the last octet may be anything, 256 addresses, one block (a /24)', () => {
    const v = wildcardView('192.168.1.0', '0.0.0.255');
    expect(v.rows).toEqual({
      address: '11000000.10101000.00000001.00000000',
      wildcard: '00000000.00000000.00000000.11111111',
      result: '11000000.10101000.00000001.********',
    });
    expect(v.bits).toHaveLength(32);
    expect(v.bits.filter((b) => b.mustMatch)).toHaveLength(24);
    expect(v.bits[31]).toEqual({ index: 31, address: '0', wildcard: '1', result: '*', mustMatch: false });
    expect(v.bits[0]).toEqual({ index: 0, address: '1', wildcard: '0', result: '1', mustMatch: true });
    expect([v.anyBits, v.count, v.first, v.last, v.contiguous, v.prefixLen]).toEqual([8, 256, '192.168.1.0', '192.168.1.255', true, 24]);
    expect(v.aceText).toBe('192.168.1.0 0.0.0.255');
    expect(v.octets).toEqual(['Octet 1 must be 192.', 'Octet 2 must be 168.', 'Octet 3 must be 1.', 'Octet 4 may be anything (0 to 255).']);
    expect(v.sentence).toBe('Matches 256 addresses, the contiguous block 192.168.1.0 to 192.168.1.255 (the network 192.168.1.0/24).');
    expect(v.normalised).toBe(false);
  });

  it('a non-contiguous wildcard: 10.1.0.1 0.0.254.0 matches 128 addresses whose third octet is even, not one block', () => {
    const v = wildcardView('10.1.0.1', '0.0.254.0');
    expect(v.count).toBe(128);
    expect(v.contiguous).toBe(false);
    expect(v.prefixLen).toBeNull();
    expect(v.first).toBe('10.1.0.1');
    expect(v.last).toBe('10.1.254.1');
    expect(v.octets[2]).toBe('Octet 3 must be even (128 values).');
    expect(v.sentence).toBe('Matches 128 addresses that are not one block: the lowest is 10.1.0.1, the highest 10.1.254.1, with gaps between them.');
    expect(wildcardView('10.1.1.1', '0.0.254.0').octets[2]).toBe('Octet 3 must be odd (128 values).');
  });

  it('describes a contiguous range inside an octet and a scattered one', () => {
    expect(wildcardView('172.16.32.0', '0.0.15.255').octets[2]).toBe('Octet 3 must be from 32 to 47 (16 values).');
    expect(wildcardView('10.0.0.0', '0.0.0.5').octets[3]).toBe(
      'Octet 4 must match 0 except in bits 2, 0 (counting 0 from the right), which may be anything: 4 values from 0 to 5.',
    );
    expect(wildcardView('10.0.0.0', '0.0.0.5').count).toBe(4);
  });

  it('host and any: one address, and every address', () => {
    const host = wildcardView('10.0.0.7', '0.0.0.0');
    expect([host.count, host.prefixLen, host.aceText]).toEqual([1, 32, 'host 10.0.0.7']);
    expect(host.sentence).toBe('Matches exactly one address, 10.0.0.7 (the "host" form).');
    const any = wildcardView('10.0.0.7', '255.255.255.255');
    expect([any.count, any.prefixLen, any.aceText, any.first, any.last]).toEqual([4294967296, 0, 'any', '0.0.0.0', '255.255.255.255']);
    expect(any.normalised).toBe(true);
  });

  it('clears the any-bits of a typed address, as an access list stores it', () => {
    const v = wildcardView('192.168.1.77', '0.0.0.255');
    expect(v.base).toBe('192.168.1.0');
    expect(v.normalised).toBe(true);
    expect(v.aceText).toBe('192.168.1.0 0.0.0.255');
    expect(v.rows.result).toBe('11000000.10101000.00000001.********');
  });

  it('wildcardPrefixLen: an inverted mask gives its prefix, anything else null', () => {
    expect(wildcardPrefixLen('0.0.0.0')).toBe(32);
    expect(wildcardPrefixLen('0.0.3.255')).toBe(22);
    expect(wildcardPrefixLen('127.255.255.255')).toBe(1);
    expect(wildcardPrefixLen('255.255.255.255')).toBe(0);
    expect(wildcardPrefixLen('0.0.255.0')).toBeNull();
    expect(wildcardPrefixLen('128.0.0.0')).toBeNull();
    expect(() => wildcardView('10.0.0.1', '1.2.3')).toThrow(RangeError);
  });
});

describe('testing an address', () => {
  it('matches exactly when the engine matcher does, naming the must-match bits that differ', () => {
    const pair = { address: '10.1.0.0', wildcard: '0.0.254.255' };
    const inside = testWildcard(pair, '10.1.8.200');
    expect(inside).toEqual({ candidate: '10.1.8.200', matches: true, wrongBits: [], text: '10.1.8.200 matches: every must-match bit agrees with 10.1.0.0 0.0.254.255.' });
    const odd = testWildcard(pair, '10.1.9.1');
    expect(odd.matches).toBe(false);
    expect(odd.wrongBits).toEqual([23]);
    expect(odd.text).toBe('10.1.9.1 does not match: 1 must-match bit differs, in octet 3.');
    const far = testWildcard(pair, '11.2.0.0');
    expect(far.wrongBits).toEqual([7, 14, 15]);
    expect(far.text).toBe('11.2.0.0 does not match: 3 must-match bits differ, in octets 1 and 2.');
    for (const c of ['10.1.0.0', '10.1.254.255', '10.1.1.0', '10.0.0.0', '10.1.200.3']) {
      expect(testWildcard(pair, c).matches, c).toBe(wildcardMatches(c, pair.address, pair.wildcard));
    }
  });
});

describe('builders', () => {
  it('from a prefix: the network and the inverted mask', () => {
    expect(wildcardFromPrefix('192.168.1.130', 26)).toEqual({ address: '192.168.1.128', wildcard: '0.0.0.63' });
    expect(wildcardFromPrefix('10.0.0.0', 0)).toEqual({ address: '0.0.0.0', wildcard: '255.255.255.255' });
    expect(wildcardFromPrefix('10.0.0.9', 32)).toEqual({ address: '10.0.0.9', wildcard: '0.0.0.0' });
    expect(() => wildcardFromPrefix('10.0.0.0', 33)).toThrow(RangeError);
  });

  it('from a range: the engine’s fewest blocks, with counts and the access-list form', () => {
    const out = wildcardsFromRange('192.168.1.10', '192.168.1.20');
    expect(out.map((e) => ({ address: e.address, wildcard: e.wildcard }))).toEqual(rangeToAces('192.168.1.10', '192.168.1.20'));
    expect(out.map((e) => e.aceText)).toEqual(['192.168.1.10 0.0.0.1', '192.168.1.12 0.0.0.3', '192.168.1.16 0.0.0.3', 'host 192.168.1.20']);
    expect(out.map((e) => e.count)).toEqual([2, 4, 4, 1]);
    expect(out.reduce((n, e) => n + e.count, 0)).toBe(11);
    expect(wildcardsFromRange('10.0.0.0', '10.0.255.255').map((e) => e.aceText)).toEqual(['10.0.0.0 0.0.255.255']);
    expect(wildcardsFromRange('10.0.0.9', '10.0.0.1')).toEqual([]);
  });

  it('from a bit pattern: 0 and 1 must match, * may be anything; the Result row reads back', () => {
    const v = wildcardView('10.1.0.1', '0.0.254.0');
    expect(wildcardFromPattern(v.rows.result)).toEqual({ ok: true, value: { address: '10.1.0.1', wildcard: '0.0.254.0' } });
    expect(wildcardFromPattern('11000000 10101000 00000001 xxxxxxxx')).toEqual({ ok: true, value: { address: '192.168.1.0', wildcard: '0.0.0.255' } });
    expect(wildcardFromPattern('1100')).toEqual({ ok: false, error: 'A pattern has 32 symbols; this one has 4.' });
    expect(wildcardFromPattern('2'.repeat(32))).toEqual({ ok: false, error: 'Use only 0, 1 and * (dots and spaces may separate the octets).' });
  });

  it('reads typed input, with the any and host shorthands', () => {
    expect(parseWildcardInput(' 192.168.1.0   0.0.0.255 ')).toEqual({ ok: true, value: { address: '192.168.1.0', wildcard: '0.0.0.255' } });
    expect(parseWildcardInput('any')).toEqual({ ok: true, value: { address: '0.0.0.0', wildcard: '255.255.255.255' } });
    expect(parseWildcardInput('host 10.0.0.1')).toEqual({ ok: true, value: { address: '10.0.0.1', wildcard: '0.0.0.0' } });
    expect(parseWildcardInput('')).toMatchObject({ ok: false });
    expect(parseWildcardInput('10.0.0.1')).toMatchObject({ ok: false });
    expect(parseWildcardInput('10.0.0.300 0.0.0.255')).toEqual({ ok: false, error: '"10.0.0.300" is not a valid IPv4 address.' });
    expect(parseWildcardInput('host x')).toEqual({ ok: false, error: '"x" is not a valid IPv4 address.' });
    expect(aceText({ address: '10.9.9.9', wildcard: '0.0.255.255' })).toBe('10.9.0.0 0.0.255.255');
  });
});

describe('seeded practice', () => {
  it('is a pure function of (seed, index): same question every time, and the series varies', () => {
    const a = Array.from({ length: 40 }, (_, i) => wildcardPractice(7, i));
    const b = Array.from({ length: 40 }, (_, i) => wildcardPractice(7, i));
    expect(a).toEqual(b);
    expect(new Set(a.map((p) => p.prompt)).size).toBeGreaterThan(30);
    expect(new Set(a.map((p) => p.kind))).toEqual(new Set(WILDCARD_PRACTICE_KINDS));
    expect(wildcardPractice(8, 0)).not.toEqual(wildcardPractice(7, 0));
    expect(() => wildcardPractice(1, -1)).toThrow(RangeError);
    expect(() => wildcardPractice(1, 0, [])).toThrow(RangeError);
  });

  it('every answer is right by the model’s own figures, and the checker accepts it', () => {
    for (let i = 0; i < 200; i++) {
      const p = wildcardPractice(2026, i);
      const v = wildcardView(p.pair.address, p.pair.wildcard);
      switch (p.kind) {
        case 'wildcard-for-prefix':
          expect(v.contiguous).toBe(true);
          expect(p.answer).toBe(p.pair.wildcard);
          break;
        case 'count':
          expect(p.answer).toBe(String(v.count));
          break;
        case 'last-address':
          expect(p.answer).toBe(v.last);
          break;
        case 'matches':
          expect(p.answer).toBe(wildcardMatches(p.candidate!, p.pair.address, p.pair.wildcard) ? 'yes' : 'no');
          break;
      }
      const ok = checkWildcardAnswer(p, p.answer);
      expect(ok.correct, p.prompt).toBe(true);
      expect(ok.explanation.length).toBeGreaterThan(0);
    }
  });

  it('asks about non-contiguous wildcards too, and both yes and no answers occur', () => {
    const series = Array.from({ length: 200 }, (_, i) => wildcardPractice(3, i));
    expect(series.some((p) => p.kind === 'count' && !wildcardView(p.pair.address, p.pair.wildcard).contiguous)).toBe(true);
    const matches = series.filter((p) => p.kind === 'matches').map((p) => p.answer);
    expect(new Set(matches)).toEqual(new Set(['yes', 'no']));
  });

  it('reads reasonable spellings and refuses what it cannot read', () => {
    const p = { seed: 0, index: 0, kind: 'count' as const, pair: { address: '10.0.0.0', wildcard: '0.0.3.255' }, prompt: '', answer: '1024' };
    expect(checkWildcardAnswer(p, ' 1,024 ')).toMatchObject({ correct: true, given: '1024' });
    expect(checkWildcardAnswer(p, 'lots')).toMatchObject({ correct: false, given: null, expected: '1024' });
    expect(checkWildcardAnswer(p, '1024').explanation).toBe('0.0.3.255 has 10 one-bits (bits that may be anything), so it matches 2^10 = 1024 addresses.');
    const m = { ...p, kind: 'matches' as const, candidate: '10.0.4.0', answer: 'no' };
    expect(checkWildcardAnswer(m, 'N')).toMatchObject({ correct: true, given: 'no' });
    expect(checkWildcardAnswer(m, 'yes')).toMatchObject({ correct: false });
    const w = { ...p, kind: 'wildcard-for-prefix' as const, answer: '0.0.3.255' };
    expect(checkWildcardAnswer(w, '0.0.3.255')).toMatchObject({ correct: true });
    expect(checkWildcardAnswer(w, '255.255.252.0')).toMatchObject({ correct: false, given: '255.255.252.0' });
  });
});
