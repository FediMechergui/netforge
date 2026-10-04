/**
 * [S9] The wildcard visualizer tool (ARCHITECTURE-P3 §6 "Wildcard visualizer", §10.3 W3 gate; W3 web-concept).
 *
 * Under test: the Address/Wildcard/Result rows (must-match columns solid, any-bit columns hatched with `*`), the
 * count, range, block and access-list form, the per-octet and summary sentences, testing an address (✓/✗ per
 * must-match column, the model's verdict), the three builders (a prefix, a range, a bit pattern), the practice pane,
 * and the panes as a labelled toggle group with labelled controls only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BitGrid,
  BitsView,
  BuildPane,
  DEFAULT_WILDCARD_INPUT,
  DEFAULT_WILDCARD_TEST,
  WILDCARD_PANES,
  WildcardPracticePane,
  WildcardTool,
  pairInput,
  readPrefix,
  readTest,
  readWildcard,
} from '../src/concept/wildcard/WildcardTool';
import { testWildcard, wildcardPractice, wildcardView, wildcardsFromRange } from '../src/concept/wildcard/model';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Every input in `html` is named by a `<label for>` or an aria-label. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;
const bits = (input: string): string => renderToStaticMarkup(createElement(BitsView, { input, onInput: () => undefined }));

describe('reading input', () => {
  it('reads a pair the access-list ways and reports a refusal', () => {
    const ok = readWildcard(DEFAULT_WILDCARD_INPUT);
    expect('view' in ok && ok.view.count).toBe(4096);
    expect('view' in readWildcard('any') && readWildcard('any')).toMatchObject({ view: { count: 2 ** 32 } });
    expect('view' in readWildcard('host 10.0.0.5')).toBe(true);
    const bad = readWildcard('10.0.0.300 0.0.0.255');
    expect('error' in bad && bad.error).toBe('"10.0.0.300" is not a valid IPv4 address.');
  });

  it('reads a prefix into its pair and refuses what is not one', () => {
    expect(readPrefix('10.20.0.0/14')).toEqual({ pair: { address: '10.20.0.0', wildcard: '0.3.255.255' }, prefixLen: 14 });
    expect(readPrefix(' 192.168.5.77 / 24 ')).toEqual({ pair: { address: '192.168.5.0', wildcard: '0.0.0.255' }, prefixLen: 24 });
    expect(readPrefix('10.0.0.0/33')).toEqual({ error: 'A prefix length runs from 0 to 32.' });
    expect(readPrefix('10.0.0.0')).toEqual({ error: 'Write a network and its prefix length, for example 10.1.0.0/16.' });
    expect(readPrefix('ten/8')).toEqual({ error: '"ten" is not a valid IPv4 address.' });
    expect(pairInput({ address: '10.0.0.0', wildcard: '0.0.0.255' })).toBe('10.0.0.0 0.0.0.255');
  });

  it('tests an address with the model, says nothing for an empty box and refuses a non-address', () => {
    const pair = { address: '172.16.32.0', wildcard: '0.0.15.255' };
    expect(readTest(pair, '  ')).toBeNull();
    expect(readTest(pair, DEFAULT_WILDCARD_TEST)).toEqual({ test: testWildcard(pair, DEFAULT_WILDCARD_TEST) });
    expect(readTest(pair, 'nope')).toEqual({ error: '"nope" is not a valid IPv4 address.' });
  });
});

describe('the bit view', () => {
  it('draws the three rows: must-match columns solid, any-bit columns hatched and shown as *', () => {
    const v = wildcardView('172.16.32.0', '0.0.15.255');
    const html = renderToStaticMarkup(createElement(BitGrid, { view: v }));
    expect(count(html, /data-bit="must"/g)).toBe(20);
    expect(count(html, /data-bit="any"/g)).toBe(12);
    // every any-bit of the Result row is a *, in a hatched cell
    expect(count(html, /data-bit="any">\*</g)).toBe(12);
    expect(count(html, /repeating-linear-gradient/g)).toBe(12);
    expect(text(html)).toContain('20 bits must match, 12 may be anything');
    for (const row of ['Address', 'Wildcard', 'Result']) expect(html).toContain(`<th scope="row">${row}</th>`);
  });

  it('gives the figures of the default pair: count, range, block, access-list form, sentences', () => {
    const v = wildcardView('172.16.32.0', '0.0.15.255');
    const t = text(bits(DEFAULT_WILDCARD_INPUT));
    expect(t).toContain(v.rows.address);
    expect(t).toContain(v.rows.wildcard);
    expect(t).toContain(v.rows.result);
    expect(t).toContain('4096 (2 to the power 12)');
    expect(t).toContain('172.16.32.0');
    expect(t).toContain('172.16.47.255');
    expect(t).toContain('yes: 172.16.32.0/20');
    expect(t).toContain(v.aceText);
    expect(t).toContain(v.sentence);
    for (const o of v.octets) expect(t).toContain(o);
    expect(unlabelledControls(bits(DEFAULT_WILDCARD_INPUT))).toEqual([]);
  });

  it('says when the matches are not one block, and when the typed address had any-bits set', () => {
    const t = text(bits('10.1.0.9 0.255.0.255'));
    expect(t).toContain('no: there are gaps between the matches');
    expect(t).toContain(wildcardView('10.1.0.9', '0.255.0.255').sentence);
    expect(t).toContain('a device stores 10.0.0.0 0.255.0.255');
  });

  it('marks a tested address column by column: ✓ for a matching must-match bit, ✗ for a wrong one, · for an any-bit', () => {
    const v = wildcardView('172.16.32.0', '0.0.15.255');
    const inside = renderToStaticMarkup(createElement(BitGrid, { view: v, test: testWildcard(v, '172.16.40.7') }));
    expect(count(inside, />✓</g)).toBe(20);
    expect(count(inside, />·</g)).toBe(12);
    expect(count(inside, /data-bit="wrong"/g)).toBe(0);
    const miss = testWildcard(v, '172.16.64.7');
    expect(miss.matches).toBe(false);
    const outside = renderToStaticMarkup(createElement(BitGrid, { view: v, test: miss }));
    expect(count(outside, /data-bit="wrong">✗</g)).toBe(miss.wrongBits.length);
    expect(count(outside, />✓</g)).toBe(20 - miss.wrongBits.length);
    // the verdict sentence under the grid is the model's
    expect(text(bits(DEFAULT_WILDCARD_INPUT))).toContain(testWildcard(v, DEFAULT_WILDCARD_TEST).text);
  });

  it('reports an input it cannot read instead of a grid', () => {
    const html = bits('192.168.1.0');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(count(html, /data-bit=/g)).toBe(0);
  });
});

describe('building a wildcard', () => {
  const html = renderToStaticMarkup(createElement(BuildPane, { onOpen: () => undefined }));
  const t = text(html);

  it('from a prefix: the inverted mask', () => {
    expect(t).toContain('The wildcard is the mask inverted: 10.20.0.0 0.3.255.255');
  });

  it('from a range: the fewest entries that cover it exactly, as the model builds them', () => {
    const entries = wildcardsFromRange('192.168.1.10', '192.168.1.40');
    expect(entries.length).toBeGreaterThan(1);
    expect(t).toContain(`these ${entries.length} entries together do`);
    for (const e of entries) {
      expect(t).toContain(e.aceText);
      expect(html).toContain(`aria-label="Show the bits of ${e.aceText}"`);
    }
  });

  it('from a bit pattern: 0 and 1 must match, * may be anything', () => {
    expect(t).toContain('That pattern is 192.168.1.0 0.0.16.255');
  });

  it('labels every control', () => {
    expect(unlabelledControls(html)).toEqual([]);
  });
});

describe('practice and the tool', () => {
  it('asks the seeded question of the model, with a live verdict region', () => {
    const html = renderToStaticMarkup(createElement(WildcardPracticePane));
    expect(text(html)).toContain(text(wildcardPractice(1, 0).prompt).trim());
    expect(html).toContain('aria-live="polite"');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('offers its three panes as a labelled toggle group and opens on the bit view', () => {
    const html = renderToStaticMarkup(createElement(WildcardTool));
    expect(WILDCARD_PANES.map((p) => p.id)).toEqual(['bits', 'build', 'practice']);
    expect(html).toContain('role="group" aria-label="Wildcard panes"');
    expect(count(html, /aria-pressed="true"/g)).toBe(1);
    expect(count(html, /data-bit="any">\*</g)).toBe(12);
    expect(unlabelledControls(html)).toEqual([]);
  });
});
