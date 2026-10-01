// The markdown code block's display-only `lang` (ARCHITECTURE-P3 §2.14, D24, §10.2 "labs.markdown.lang", §11.3; W1
// web-learn): a fence may name json, yaml, xml, http, python or text; the block then carries `lang` and the renderer
// labels it. A `json` block renders as code — never as a link or as HTML — and a fence without a known language parses
// exactly as before (no `lang` member at all).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/labs/LabPanel';
import { MD_CODE_LANGS, MD_CODE_LANG_LABEL, fenceLang, markdownText, parseMarkdown, type MdBlock } from '../src/labs/markdown';

const JSON_BODY = [
  '{',
  '  "ietf-interfaces:interface": {',
  '    "name": "GigabitEthernet0/1",',
  '    "description": "[uplink](https://example.org) <b>core</b> & **bold** `tick`",',
  '    "enabled": true',
  '  }',
  '}',
].join('\n');

const html = (blocks: MdBlock[]): string => renderToStaticMarkup(createElement(Markdown, { blocks }));

describe('the fence language', () => {
  it('reads the six display languages, in any case, and nothing else', () => {
    expect([...MD_CODE_LANGS]).toEqual(['json', 'yaml', 'xml', 'http', 'python', 'text']);
    for (const lang of MD_CODE_LANGS) {
      expect(fenceLang('```' + lang), lang).toBe(lang);
      expect(fenceLang('~~~' + lang), lang).toBe(lang);
      expect(MD_CODE_LANG_LABEL[lang].length, lang).toBeGreaterThan(0);
    }
    expect(fenceLang('```JSON')).toBe('json');
    expect(fenceLang('  ``` yaml  ')).toBe('yaml');
    expect(fenceLang('```json\r')).toBe('json');
    for (const other of ['```', '```js', '```javascript', '```json extra', '```json{}', '```unclosed', '```c++', '```toString', '```__proto__', 'json']) {
      expect(fenceLang(other), other).toBeUndefined();
    }
  });

  it('puts the language on the code block, and parses a fence without one exactly as before', () => {
    const blocks = parseMarkdown(['Send this body:', '', '```json', JSON_BODY, '```', '', '```', 'show ip route', '```', '', '```shell', 'x', '```'].join('\n'));
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'code', 'code']);
    expect(blocks[1]).toEqual({ kind: 'code', text: JSON_BODY, lang: 'json' });
    expect(blocks[2]).toEqual({ kind: 'code', text: 'show ip route' });
    expect('lang' in (blocks[2] as object)).toBe(false);
    expect(blocks[3]).toEqual({ kind: 'code', text: 'x' });
    expect('lang' in (blocks[3] as object)).toBe(false);
    // The P1 cases keep their exact nodes.
    expect(parseMarkdown('```unclosed\nbody')).toEqual([{ kind: 'code', text: 'body' }]);
    expect(parseMarkdown('```yaml\nkey: value')).toEqual([{ kind: 'code', text: 'key: value', lang: 'yaml' }]);
  });

  it('keeps the body literal whatever the language: no link, emphasis or markup inside a fence', () => {
    const [block] = parseMarkdown('```json\n' + JSON_BODY + '\n```');
    expect(block).toEqual({ kind: 'code', text: JSON_BODY, lang: 'json' });
    expect(markdownText([block as MdBlock])).toBe(JSON_BODY);
    expect(JSON.stringify(block)).not.toContain('"link"');
    expect(JSON.stringify(block)).not.toContain('"html"');
  });
});

describe('the renderer', () => {
  it('renders a json block as labelled code: escaped characters, never a link or an element from the body', () => {
    const out = html(parseMarkdown('```json\n' + JSON_BODY + '\n```'));
    expect(out).toContain('data-lang="json"');
    expect(out).toContain('aria-label="JSON code"');
    expect(out).toContain('>JSON</div>');
    expect(out).toContain('<pre class="mono">');
    // The body's markup arrives as text.
    expect(out).toContain('&lt;b&gt;core&lt;/b&gt; &amp; **bold** `tick`');
    expect(out).toContain('[uplink](https://example.org)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<strong');
    expect(out).not.toContain('<code');
    expect(out).not.toContain('href=');
  });

  it('labels every language and renders a block without one exactly as in P1/P2', () => {
    for (const lang of MD_CODE_LANGS) {
      const out = html([{ kind: 'code', text: 'a < b', lang }]);
      expect(out, lang).toContain(`>${MD_CODE_LANG_LABEL[lang]}</div>`);
      expect(out, lang).toContain('<pre class="mono">a &lt; b</pre>');
    }
    expect(html([{ kind: 'code', text: 'show ip route' }])).toBe('<pre class="mono">show ip route</pre>');
  });

  it('renders a link beside a json block as a link, and the one inside it as text', () => {
    const blocks = parseMarkdown(['See [the tool](concept:data-formats).', '', '```json', '{"see": "[the tool](concept:data-formats)"}', '```'].join('\n'));
    const out = html(blocks);
    expect(out.match(/<button/g)?.length ?? 0).toBe(1);
    expect(out).toContain('{&quot;see&quot;: &quot;[the tool](concept:data-formats)&quot;}');
  });
});
