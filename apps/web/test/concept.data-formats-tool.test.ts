/**
 * The data-formats playground tool (ARCHITECTURE-P3 D21, §6 "Data-formats playground", §10.3 W3 gate; lesson 37;
 * W3 web-concept).
 *
 * Under test: the editor (a valid document's tree with both key-path forms, the type, the value and where it starts;
 * a broken one's parser message with its line and column and the offending line with a caret; XML read against the
 * RESTCONF path it answers), conversion into the other formats, the sample library of device answers, the seeded
 * practice pane, and the panes as a labelled toggle group with labelled controls only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DATA_PANES,
  DEFAULT_DATA_SAMPLE,
  DataFormatsTool,
  DataPracticePane,
  EditorPane,
  SamplesPane,
  defaultDataEditor,
  errorContext,
  formatLabel,
  treeRowName,
  type DataEditorState,
} from '../src/concept/data-formats/DataFormatsTool';
import { convertDataDocument, dataPractice, dataSample, dataSamples, parseDataDocument, writeDataDocument } from '../src/concept/data-formats/model';

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

/** Every input, select and textarea in `html` is named by a `<label for>` or an aria-label. */
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

const editor = (state: DataEditorState): string => renderToStaticMarkup(createElement(EditorPane, { state, onChange: () => undefined }));

describe('helpers', () => {
  it('opens the editor on the one-interface answer, as JSON, with its RESTCONF path', () => {
    const s = dataSample(DEFAULT_DATA_SAMPLE)!;
    expect(defaultDataEditor()).toEqual({ format: 'json', text: s.json, context: s.path });
    expect(formatLabel('yaml')).toBe('YAML');
  });

  it('points at the error: the numbered line and a caret under the column', () => {
    expect(errorContext('{\n  "a": ,\n}', 2, 8)).toEqual({ number: '2', lineText: '2 |   "a": ,', caret: '  |        ^' });
    expect(errorContext('x', 5, 1)).toBeNull();
    // a column past the end of the line puts the caret just after it
    expect(errorContext('ab', 1, 9)?.caret).toBe('  |   ^');
  });

  it('names the root row and every other row by its dotted path', () => {
    expect(treeRowName({ depth: 0, dotPath: '' })).toBe('(the whole document)');
    expect(treeRowName({ depth: 2, dotPath: 'a.b' })).toBe('a.b');
  });
});

describe('the editor', () => {
  it('shows the tree of a valid document: key paths in both forms, types, values and where each starts', () => {
    const state = defaultDataEditor();
    const parsed = parseDataDocument('json', state.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const t = text(editor(state));
    expect(t).toContain(`A valid JSON document: ${parsed.rows.length} nodes.`);
    expect(t).toContain('(the whole document)');
    for (const r of parsed.rows.slice(1)) {
      expect(t).toContain(r.dotPath);
      expect(t).toContain(r.indexPath);
      expect(t).toContain(`line ${r.line}, column ${r.column}`);
    }
    // a member name with a module prefix is quoted in the dotted form
    expect(t).toContain('["ietf-interfaces:interface"][0].name');
    expect(t).toContain('"GigabitEthernet0/1"');
    expect(unlabelledControls(editor(state))).toEqual([]);
  });

  it('reports a broken document with the parser’s line and column and the offending line', () => {
    const bad = '{\n  "name": "Gi0/1",\n  "enabled": tru\n}\n';
    const parsed = parseDataDocument('json', bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const html = editor({ format: 'json', text: bad, context: '' });
    const t = text(html);
    expect(t).toContain(`The JSON document cannot be read. ${parsed.text}`);
    expect(parsed.text).toMatch(/^Line 3, column \d+: /);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    const where = errorContext(bad, parsed.error.line, parsed.error.column)!;
    expect(html).toContain(where.lineText.replace(/"/g, '&quot;'));
    expect(t).not.toContain('The tree');
  });

  it('reads YAML and XML the same way, XML against the RESTCONF path it answers', () => {
    const s = dataSample('interfaces')!;
    const yaml = writeDataDocument('yaml', s.value);
    const xml = writeDataDocument('xml', s.value);
    expect(yaml.ok && xml.ok).toBe(true);
    if (!yaml.ok || !xml.ok) return;
    const ty = text(editor({ format: 'yaml', text: yaml.text, context: '' }));
    expect(ty).toContain('A valid YAML document');
    expect(ty).toContain('["ietf-interfaces:interfaces"].interface[2].name');
    const hx = editor({ format: 'xml', text: xml.text, context: s.path });
    expect(text(hx)).toContain('A valid XML document');
    expect(text(hx)).toContain('RESTCONF path this XML answers (optional)');
    expect(unlabelledControls(hx)).toEqual([]);
  });

  it('offers the other two formats to convert into, and the conversion is the model’s', () => {
    const state = defaultDataEditor();
    const html = editor(state);
    expect(text(html)).toContain('Show it as');
    const group = /aria-label="Convert to">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(text(group).trim()).toBe('YAML XML');
    const yaml = convertDataDocument(state.text, 'json', 'yaml');
    const xml = convertDataDocument(state.text, 'json', 'xml', state.context);
    expect(yaml.ok && xml.ok).toBe(true);
  });
});

describe('the device answers', () => {
  it('lists every sample with its request and the JSON the device sent, each one openable', () => {
    const html = renderToStaticMarkup(createElement(SamplesPane, { onOpen: () => undefined }));
    const t = text(html);
    for (const s of dataSamples()) {
      expect(t).toContain(s.title);
      expect(t).toContain(s.request);
      expect(t).toContain(text(s.json).trim());
    }
    expect((html.match(/Open in the editor/g) ?? []).length).toBe(dataSamples().length);
  });
});

describe('practice', () => {
  it('asks the seeded question of the model, with its document, and has a live verdict region', () => {
    const html = renderToStaticMarkup(createElement(DataPracticePane));
    const p = dataPractice(1, 0);
    expect(text(html)).toContain(text(p.prompt).trim());
    expect(text(html)).toContain(text(p.document).trim());
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('is-empty');
    expect(unlabelledControls(html)).toEqual([]);
  });
});

describe('the tool', () => {
  it('offers its three panes as a labelled toggle group and opens on the editor', () => {
    const html = renderToStaticMarkup(createElement(DataFormatsTool));
    expect(DATA_PANES.map((p) => p.id)).toEqual(['edit', 'samples', 'practice']);
    expect(html).toContain('role="group" aria-label="Data-format panes"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(2); // the pane, and the JSON format
    expect(text(html)).toContain('Read and convert');
    expect(text(html)).toContain('A valid JSON document');
    expect(unlabelledControls(html)).toEqual([]);
  });
});
