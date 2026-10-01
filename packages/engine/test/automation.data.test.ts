/**
 * The data-format parsers of `automation/data` (ARCHITECTURE-P3 D21, §7 W1 auto): JSON with positions, the YAML subset
 * and XML — round trips, and every error with its line and column.
 */
import { describe, expect, it } from 'vitest';
import {
  dataAt,
  dataEntries,
  dataEquals,
  dataTypeName,
  formatDataPath,
  parseJson,
  stringifyJson,
  textPositions,
  type DataNode,
  type DataParseResult,
  type DataValue,
} from '../src/automation/data/json.js';
import { parseYaml, stringifyYaml } from '../src/automation/data/yaml.js';
import { dataToXml, parseXml, serializeXml, xmlToData, type XmlElement, type XmlParseResult } from '../src/automation/data/xml.js';

/** The error of a failed parse as `line:column message`. */
function errorOf(r: DataParseResult | XmlParseResult): { line: number; column: number; message: string } {
  if (r.ok) throw new Error('expected a parse error');
  return { line: r.error.line, column: r.error.column, message: r.error.message };
}

function valueOf(r: DataParseResult): DataValue {
  if (!r.ok) throw new Error(`unexpected error ${r.error.line}:${r.error.column} ${r.error.message}`);
  return r.value;
}

/** The RFC 7951 JSON a switch returns for its interfaces (the playground's sample shape). */
const INTERFACES_JSON = `{
  "ietf-interfaces:interfaces": {
    "interface": [
      {
        "name": "GigabitEthernet0/2",
        "description": "uplink - add vlan 40 NAME FINANCE on SW3",
        "type": "iana-if-type:ethernetCsmacd",
        "enabled": true
      },
      {
        "name": "Vlan99",
        "type": "iana-if-type:l3ipvlan",
        "enabled": true,
        "ietf-ip:ipv4": {
          "address": [
            {
              "ip": "10.0.99.12",
              "prefix-length": 24
            }
          ]
        }
      }
    ]
  }
}`;

describe('positions', () => {
  it('counts lines and columns from 1, with LF, CR LF and CR breaks', () => {
    const at = textPositions('ab\ncd\r\nef\rgh');
    expect(at(0)).toEqual({ line: 1, column: 1, offset: 0 });
    expect(at(3)).toEqual({ line: 2, column: 1, offset: 3 });
    expect(at(4)).toEqual({ line: 2, column: 2, offset: 4 });
    expect(at(7)).toEqual({ line: 3, column: 1, offset: 7 });
    expect(at(10)).toEqual({ line: 4, column: 1, offset: 10 });
    expect(at(99)).toEqual({ line: 4, column: 3, offset: 12 });
  });
});

describe('JSON', () => {
  const VALID = [
    '0', '-0', '12.5e-3', '1E+2', '"a\\u00e9\\n\\"\\\\\\/"', 'true', 'false', 'null', '[]', '{}', '[1, [2, [3]], {"a": {"b": null}}]',
    '  {"z": 1, "a": 2, "10": 3}  ', INTERFACES_JSON, '"\\ud83d\\ude00"', '{"__proto__": 1}',
  ];

  it('reads what JSON.parse reads, to the same value', () => {
    for (const text of VALID) expect(dataEquals(valueOf(parseJson(text)), JSON.parse(text) as DataValue), text).toBe(true);
    const proto = valueOf(parseJson('{"__proto__": {"x": 1}}')) as Record<string, DataValue>;
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.keys(proto)).toEqual(['__proto__']);
  });

  it('keeps the position of every node and key', () => {
    const r = parseJson(INTERFACES_JSON);
    if (!r.ok) throw new Error('parse failed');
    const entries = dataEntries(r.node);
    const name = entries.find((e) => formatDataPath(e.path) === '["ietf-interfaces:interfaces"].interface[1].name');
    expect(name?.node.span.start).toEqual({ line: 11, column: 17, offset: expect.any(Number) as number });
    const iface = r.node.kind === 'object' ? r.node.entries[0] : undefined;
    expect(iface?.keySpan.start).toMatchObject({ line: 2, column: 3 });
    const prefix = entries.find((e) => e.path[e.path.length - 1] === 'prefix-length');
    expect(prefix?.node).toMatchObject({ kind: 'number', value: 24, raw: '24', span: { start: { line: 18, column: 32 }, end: { line: 18, column: 34 } } });
  });

  it('names key paths for the tree view and for scripts', () => {
    const path = ['ietf-interfaces:interfaces', 'interface', 0, 'name'];
    expect(formatDataPath(path)).toBe('["ietf-interfaces:interfaces"].interface[0].name');
    expect(formatDataPath(path, 'index')).toBe('["ietf-interfaces:interfaces"]["interface"][0]["name"]');
    expect(formatDataPath(['a', 'b-c', 2])).toBe('a["b-c"][2]');
    const v = valueOf(parseJson(INTERFACES_JSON));
    expect(dataAt(v, path)).toBe('GigabitEthernet0/2');
    expect(dataAt(v, ['ietf-interfaces:interfaces', 'interface', 1, 'ietf-ip:ipv4', 'address', 0, 'prefix-length'])).toBe(24);
    expect(dataAt(v, ['ietf-interfaces:interfaces', 'nope'])).toBeUndefined();
    expect(dataTypeName(dataAt(v, ['ietf-interfaces:interfaces', 'interface']) as DataValue)).toBe('array');
    expect(dataTypeName(true)).toBe('boolean');
  });

  it('round-trips: text → value → text → the same value', () => {
    for (const text of VALID) {
      const v = valueOf(parseJson(text));
      expect(dataEquals(valueOf(parseJson(stringifyJson(v))), v), text).toBe(true);
      expect(dataEquals(valueOf(parseJson(stringifyJson(v, { indent: 0 }))), v), text).toBe(true);
    }
    expect(stringifyJson(valueOf(parseJson(INTERFACES_JSON)))).toBe(INTERFACES_JSON);
    expect(() => stringifyJson({ a: Number.NaN })).toThrow(RangeError);
  });

  it('reports every error at its line and column, in words a learner can act on', () => {
    const cases: [string, number, number, RegExp][] = [
      ['', 1, 1, /document is empty/],
      ['{"a": 1,}', 1, 9, /trailing comma/],
      ['[1, 2,]', 1, 7, /trailing comma/],
      ["{'a': 1}", 1, 2, /double quotes/],
      ['{"a": \'x\'}', 1, 7, /double quotes/],
      ['{"a": True}', 1, 7, /lower case/],
      ['{"a": None}', 1, 7, /Python/],
      ['{\n  "a": 1\n  "b": 2\n}', 3, 3, /Expected ","/],
      ['{"a" 1}', 1, 6, /Expected ":"/],
      ['{"a" = 1}', 1, 6, /":", not "="/],
      ['{"a": "x', 1, 7, /never closed/],
      ['{"a": [1, 2}', 1, 12, /Expected "," or "\]"/],
      ['{"a": 1', 1, 1, /never closed/],
      ['{"a": 1, "a": 2}', 1, 10, /appears twice/],
      ['// note\n{}', 1, 1, /comments/],
      ['{"a": 1} # note', 1, 10, /comments/],
      ['{"a": 01}', 1, 7, /start with 0/],
      ['{"a": 1.}', 1, 9, /at least one digit/],
      ['{"ip": 10.0.0.1}', 1, 8, /at most one decimal point.*double quotes/],
      ['[1.5.3]', 1, 2, /at most one decimal point/],
      ['{"ip": 192.168.1.1}', 1, 8, /double quotes/],
      ['[1.5.]', 1, 2, /at most one decimal point/],
      ['[1e5.3]', 1, 5, /exponent is a whole number/],
      ['{"a": .5}', 1, 7, /digit before the decimal point/],
      ['{"a": +1}', 1, 7, /cannot start with "\+"/],
      ['{"a": "x\ny"}', 1, 9, /line break/],
      ['{"a": "\\q"}', 1, 8, /Unknown escape/],
      ['{"a": "\\u12"}', 1, 8, /four hexadecimal/],
      ['{"a": NaN}', 1, 7, /finite/],
      ['{"a": 1e999}', 1, 7, /too large/],
      ['{"a": 1} {"b": 2}', 1, 10, /Only one value/],
      ['{"a": 1}, {"b": 2}', 1, 9, /wrap several values/],
      ['{a: 1}', 1, 2, /Object keys must be strings/],
      ['{"a": yes}', 1, 7, /needs double quotes/],
      ['[1 2]', 1, 4, /Expected "," or "\]"/],
      ['{\n  "vlan": 30,\n  "name": VOICE\n}', 3, 11, /needs double quotes/],
    ];
    for (const [text, line, column, message] of cases) {
      const e = errorOf(parseJson(text));
      expect({ text, line: e.line, column: e.column }).toEqual({ text, line, column });
      expect(e.message, text).toMatch(message);
    }
  });

  it('refuses nesting deeper than the guard, without exhausting the stack', () => {
    expect(errorOf(parseJson('['.repeat(300) + ']'.repeat(300))).message).toMatch(/levels deep/);
    expect(parseJson('['.repeat(200) + ']'.repeat(200)).ok).toBe(true);
  });
});

describe('YAML subset', () => {
  const PLAYBOOK = [
    '---',
    '# the VLANs of the access switches',
    'switches:',
    '  - name: SW1',
    '    address: 10.0.99.11',
    '    vlans: [10, 20, 30]',
    '  - name: SW2',
    '    address: "10.0.99.12"',
    '    enabled: true',
    '    notes: ~',
    'defaults:',
    '  vlan: {id: 99, name: MGMT}',
    '  retries: 3',
    '...',
    '',
  ].join('\n');

  it('reads block mappings and sequences, compact entries, flow collections and comments', () => {
    expect(valueOf(parseYaml(PLAYBOOK))).toEqual({
      switches: [
        { name: 'SW1', address: '10.0.99.11', vlans: [10, 20, 30] },
        { name: 'SW2', address: '10.0.99.12', enabled: true, notes: null },
      ],
      defaults: { vlan: { id: 99, name: 'MGMT' }, retries: 3 },
    });
  });

  it('reads a sequence at the indentation of its key, and nested sequences', () => {
    expect(valueOf(parseYaml('vlans:\n- 10\n- 20\nname: x\n'))).toEqual({ vlans: [10, 20], name: 'x' });
    expect(valueOf(parseYaml('- - a\n  - b\n- - c\n'))).toEqual([['a', 'b'], ['c']]);
    expect(valueOf(parseYaml('-\n  a: 1\n-\n- x\n'))).toEqual([{ a: 1 }, null, 'x']);
    expect(valueOf(parseYaml('a:\n  b:\n    c: 1\n  d: 2\ne: 3'))).toEqual({ a: { b: { c: 1 }, d: 2 }, e: 3 });
  });

  it('resolves plain scalars with the core schema', () => {
    const v = valueOf(parseYaml([
      'a: null', 'b: ~', 'c:', 'd: True', 'e: FALSE', 'f: yes', 'g: 0x1F', 'h: 0o17', 'i: -12', 'j: 1.5e3', 'k: .5',
      'l: 10.0.99.11', 'm: +7', 'n: "true"', "o: '12'", 'p: 1_000', 'q: no',
    ].join('\n')));
    expect(v).toEqual({ a: null, b: null, c: null, d: true, e: false, f: 'yes', g: 31, h: 15, i: -12, j: 1500, k: 0.5, l: '10.0.99.11', m: 7, n: 'true', o: '12', p: '1_000', q: 'no' });
  });

  it('reads quoted scalars with escapes and line folding, and plain scalars folded over lines', () => {
    expect(valueOf(parseYaml('a: "x\\ty\\u00e9\\x41 \\"q\\""\nb: \'it\'\'s\'\n'))).toEqual({ a: 'x\ty\u00e9A "q"', b: "it's" });
    expect(valueOf(parseYaml('a: "one\n  two\n\n  three"\n'))).toEqual({ a: 'one two\nthree' });
    expect(valueOf(parseYaml('a: "one \\\n  two"\n'))).toEqual({ a: 'one two' });
    expect(valueOf(parseYaml('a: first\n  second\n\n  third # note\nb: 2\n'))).toEqual({ a: 'first second\nthird', b: 2 });
    expect(valueOf(parseYaml('a: x#y\nb: "#z" # c\n'))).toEqual({ a: 'x#y', b: '#z' });
    expect(valueOf(parseYaml('url: https://10.0.99.11/restconf\n'))).toEqual({ url: 'https://10.0.99.11/restconf' });
    // as YAML says: a more-indented "- b" under a plain item continues that item's text
    expect(valueOf(parseYaml('- a\n  - b\n'))).toEqual(['a - b']);
  });

  it('reads literal and folded block scalars with their chomping indicators', () => {
    expect(valueOf(parseYaml('a: |\n  line 1\n    indented\n  line 3\nb: 1\n'))).toEqual({ a: 'line 1\n  indented\nline 3\n', b: 1 });
    expect(valueOf(parseYaml('a: >\n  one\n  two\n\n  three\nb: 1\n'))).toEqual({ a: 'one two\nthree\n', b: 1 });
    expect(valueOf(parseYaml('a: |-\n  x\n\nb: 1\n'))).toEqual({ a: 'x', b: 1 });
    expect(valueOf(parseYaml('a: |+\n  x\n\nb: 1\n'))).toEqual({ a: 'x\n\n', b: 1 });
    expect(valueOf(parseYaml('a: >2\n   x\n  y\n'))).toEqual({ a: ' x\ny\n' });
    expect(valueOf(parseYaml('- |\n  banner\n- next\n'))).toEqual(['banner\n', 'next']);
    expect(valueOf(parseYaml('a: |\nb: 1\n'))).toEqual({ a: '', b: 1 });
  });

  it('reads every JSON document to the same value', () => {
    for (const text of [INTERFACES_JSON, '{"a": [1, 2.5, -3e2, true, null, "x"]}', '[]', '{"k": {"n": {}}}', '"just text"']) {
      expect(dataEquals(valueOf(parseYaml(text)), JSON.parse(text) as DataValue), text).toBe(true);
    }
  });

  it('keeps positions of keys and values', () => {
    const r = parseYaml(PLAYBOOK);
    if (!r.ok) throw new Error('parse failed');
    const at = (p: string): DataNode | undefined => dataEntries(r.node).find((e) => formatDataPath(e.path) === p)?.node;
    expect(at('switches[1].address')?.span.start).toMatchObject({ line: 8, column: 14 });
    expect(at('switches[0].vlans[2]')?.span).toMatchObject({ start: { line: 6, column: 21 }, end: { line: 6, column: 23 } });
    expect(at('defaults.retries')).toMatchObject({ kind: 'number', value: 3, span: { start: { line: 13, column: 12 } } });
    expect(r.node.kind === 'object' ? r.node.entries[1]?.keySpan.start : undefined).toMatchObject({ line: 11, column: 1 });
  });

  it('reports every error at its line and column', () => {
    const cases: [string, number, number, RegExp][] = [
      ['a: 1\n\tb: 2\n', 2, 1, /tabs/],
      ['a:\n  b: 1\n   c: 2\n', 3, 4, /cannot start a new key/],
      ['a:\n  b: [1]\n   c: 2\n', 3, 4, /matches none of the keys/],
      ['a: 1\na: 2\n', 2, 1, /appears twice/],
      ['a: &x 1\n', 1, 4, /Anchors/],
      ['a: *x\n', 1, 4, /Anchors/],
      ['a: !!str 1\n', 1, 4, /Tags/],
      ['%YAML 1.2\n---\na: 1\n', 1, 1, /Directives/],
      ['a: 1\n---\nb: 2\n', 2, 1, /Several documents/],
      ['a: "x\n', 1, 4, /never closed/],
      ["a: 'x\n", 1, 4, /never closed/],
      ['a: b: c\n', 1, 4, /same line/],
      ['a: - b\n', 1, 4, /same line as its key/],
      ['a: 1\n- b\n', 2, 1, /list item cannot follow/],
      ['a: [1, 2\nb: 3\n', 1, 4, /never closed/],
      ['a: {x: 1, x: 2}\n', 1, 11, /appears twice/],
      ['a: .inf\n', 1, 4, /infinite/],
      ['? a\n: 1\n', 1, 1, /Complex keys/],
      ['a: "x" y\n', 1, 8, /Unexpected text/],
      ['a: x\n  b: y\n', 2, 3, /cannot start a new key/],
      ['- [a]\n  - b\n', 2, 3, /matches none of the list items/],
      ['a: [x: 1]\n', 1, 6, /use \{ \}/],
      ['a: "\\q"\n', 1, 5, /Unknown escape/],
      ['a: 1e999\n', 1, 4, /too large/],
      ['a: @x\n', 1, 4, /cannot start a plain value/],
    ];
    for (const [text, line, column, message] of cases) {
      const e = errorOf(parseYaml(text));
      expect({ text, line: e.line, column: e.column }).toEqual({ text, line, column });
      expect(e.message, text).toMatch(message);
    }
  });

  it('reads an empty document as null', () => {
    expect(valueOf(parseYaml(''))).toBeNull();
    expect(valueOf(parseYaml('# nothing\n---\n'))).toBeNull();
  });

  it('writes block YAML and reads it back to the same value', () => {
    const values: DataValue[] = [
      valueOf(parseJson(INTERFACES_JSON)),
      valueOf(parseYaml(PLAYBOOK)),
      {
        strings: ['true', 'null', '12', '0x1F', '1.5', '', ' lead', 'trail ', 'a: b', 'x #y', '#c', '- d', '[e]', '{f}', 'g:', 'it\'s', 'q"q', 'two\nlines', 'tab\there', '---', '... x', 'caf\u00e9', '\u00e9t\u00e9', 'yes'],
        numbers: [0, -1, 2.5, 1e21, -3e-7],
        flags: [true, false, null],
        nested: [[1, [2, []]], [{ a: {} }], { 'key with: colon': { '': 'empty key', '#': 1 } }],
        empty: {},
        list: [],
      },
      'plain', 'needs: quotes', 42, null, [], {},
    ];
    for (const v of values) {
      const text = stringifyYaml(v);
      expect(dataEquals(valueOf(parseYaml(text)), v), text).toBe(true);
      expect(dataEquals(valueOf(parseYaml(stringifyYaml(v, { indent: 4 }))), v), text).toBe(true);
    }
    expect(stringifyYaml({ switches: [{ name: 'SW1', vlans: [10, 20] }, { name: 'SW2', vlans: [] }], retries: 3, note: 'x: y' })).toBe(
      ['switches:', '  - name: SW1', '    vlans:', '      - 10', '      - 20', '  - name: SW2', '    vlans: []', 'retries: 3', 'note: "x: y"', ''].join('\n'),
    );
  });

  it('converts JSON to YAML and back without loss', () => {
    const json = valueOf(parseJson(INTERFACES_JSON));
    expect(stringifyJson(valueOf(parseYaml(stringifyYaml(json))))).toBe(INTERFACES_JSON);
  });
});

/** An element tree without positions, for comparing trees. */
function shape(e: XmlElement): unknown {
  return {
    name: e.name,
    attributes: e.attributes.map((a) => [a.name, a.value]),
    selfClosing: e.selfClosing,
    children: e.children.map((c) => (c.type === 'element' ? shape(c) : { text: c.value, cdata: c.cdata === true })),
  };
}

function rootOf(r: XmlParseResult): XmlElement {
  if (!r.ok) throw new Error(`unexpected error ${r.error.line}:${r.error.column} ${r.error.message}`);
  return r.document.root;
}

const INTERFACES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">',
  '  <!-- one interface -->',
  '  <interface>',
  '    <name>Vlan99</name>',
  '    <description>mgmt &amp; ops &lt;main&gt; &#233;&#x41;</description>',
  '    <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:l3ipvlan</type>',
  '    <enabled>true</enabled>',
  '    <ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip">',
  '      <address>',
  '        <ip>10.0.99.12</ip>',
  '        <prefix-length>24</prefix-length>',
  '      </address>',
  '    </ipv4>',
  '    <note><![CDATA[a <raw> & text]]></note>',
  '    <empty/>',
  '  </interface>',
  '</interfaces>',
].join('\n');

describe('XML', () => {
  it('reads elements, attributes, entities, character references, CDATA, comments and the declaration', () => {
    const r = parseXml(INTERFACES_XML);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.document.declaration).toEqual({ version: '1.0', encoding: 'UTF-8' });
    const itf = r.document.root.children[0] as XmlElement;
    expect(r.document.root.attributes.map((a) => [a.name, a.value])).toEqual([['xmlns', 'urn:ietf:params:xml:ns:yang:ietf-interfaces']]);
    expect(itf.children.map((c) => (c.type === 'element' ? c.name : '#text'))).toEqual(['name', 'description', 'type', 'enabled', 'ipv4', 'note', 'empty']);
    const text = (name: string): string => {
      const el = itf.children.find((c): c is XmlElement => c.type === 'element' && c.name === name);
      return (el?.children ?? []).map((c) => (c.type === 'text' ? c.value : '')).join('');
    };
    expect(text('description')).toBe('mgmt & ops <main> \u00e9A');
    expect(text('note')).toBe('a <raw> & text');
    expect((itf.children[6] as XmlElement).selfClosing).toBe(true);
    expect(itf.span.start).toMatchObject({ line: 4, column: 3 });
    expect((itf.children[0] as XmlElement).span).toMatchObject({ start: { line: 5, column: 5 }, end: { line: 5, column: 24 } });
  });

  it('keeps whitespace-only text only when asked, or when an element holds nothing else', () => {
    expect(shape(rootOf(parseXml('<a>\n  <b> </b>\n</a>')))).toEqual({ name: 'a', attributes: [], selfClosing: false, children: [{ name: 'b', attributes: [], selfClosing: false, children: [{ text: ' ', cdata: false }] }] });
    expect(rootOf(parseXml('<a>\n  <b/>\n</a>', { keepWhitespace: true })).children).toHaveLength(3);
    expect(rootOf(parseXml('<a>x\r\ny</a>')).children[0]).toMatchObject({ value: 'x\ny' });
    expect(rootOf(parseXml('<a b="1\t2\n3"/>')).attributes[0]?.value).toBe('1 2 3');
  });

  it('round-trips: tree → text → the same tree', () => {
    for (const text of [INTERFACES_XML, '<a x="&quot;q&quot; &amp; &lt;"><b>1</b><b>2</b><c/><d></d>mixed<e>t</e></a>', '<r><![CDATA[x]]>y</r>', '<\u00e9l\u00e9ment att="\u00e9">\u00fcnicode \ud83d\ude00</\u00e9l\u00e9ment>']) {
      const doc = parseXml(text);
      if (!doc.ok) throw new Error(doc.error.message);
      for (const indent of [2, 0]) {
        const back = parseXml(serializeXml(doc.document, { indent }));
        expect(shape(rootOf(back)), text).toEqual(shape(doc.document.root));
      }
    }
    expect(serializeXml(rootOf(parseXml('<a><b>x</b><c/></a>')))).toBe('<a>\n  <b>x</b>\n  <c/>\n</a>');
    expect(serializeXml(rootOf(parseXml('<a/>')), { declaration: true })).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<a/>');
  });

  it('reports every error at its line and column', () => {
    const cases: [string, number, number, RegExp][] = [
      ['', 1, 1, /no root element/],
      ['<a>\n  <b>x</c>\n</a>', 2, 7, /does not match the start tag <b> on line 2/],
      ['<a>\n  <b>x</b>\n', 1, 1, /opened on line 1 is never closed/],
      ['<a/><b/>', 1, 5, /exactly one root/],
      ['hello<a/>', 1, 1, /before the root/],
      ['<a/>tail', 1, 5, /after the root/],
      ['<a>&nbsp;</a>', 1, 4, /Unknown entity/],
      ['<a>fish & chips</a>', 1, 9, /lone & as &amp;/],
      ['<a x="1" x="2"/>', 1, 10, /appears twice/],
      ['<a x=1/>', 1, 6, /in quotes/],
      ['<a x="<"/>', 1, 7, /cannot contain "<"/],
      ['<!DOCTYPE a>\n<a/>', 1, 1, /Document type declarations/],
      ['<a><!-- a -- b --></a>', 1, 11, /cannot contain "--"/],
      ['<a>x ]]> y</a>', 1, 6, /CDATA/],
      ['<1a/>', 1, 2, /cannot start with "1"/],
      ['<a x="1"y="2"/>', 1, 9, /space before the next attribute/],
      ['<a>&#0;</a>', 1, 4, /does not allow/],
      [' <?xml version="1.0"?><a/>', 1, 2, /very start/],
      ['<?xml encoding="UTF-8"?><a/>', 1, 1, /needs a version/],
      ['<a><b></a>', 1, 7, /does not match the start tag <b>/],
      ['<a x="1"', 1, 1, /never closed/],
      ['<a>\u0001</a>', 1, 4, /not allowed/],
    ];
    for (const [text, line, column, message] of cases) {
      const e = errorOf(parseXml(text));
      expect({ text, line: e.line, column: e.column }).toEqual({ text, line, column });
      expect(e.message, text).toMatch(message);
    }
  });
});

describe('XML and data', () => {
  const MODULES: Record<string, string> = {
    'urn:ietf:params:xml:ns:yang:ietf-interfaces': 'ietf-interfaces',
    'urn:ietf:params:xml:ns:yang:ietf-ip': 'ietf-ip',
  };
  const moduleOf = (ns: string): string | undefined => MODULES[ns];
  const namespaceOf = (m: string): string | undefined => Object.keys(MODULES).find((ns) => MODULES[ns] === m);

  it('turns repeated elements into arrays and namespace changes into module names (RFC 7951)', () => {
    const data = xmlToData(rootOf(parseXml(INTERFACES_XML)), { moduleOf });
    expect(data).toEqual({
      'ietf-interfaces:interfaces': {
        interface: {
          name: 'Vlan99',
          description: 'mgmt & ops <main> \u00e9A',
          type: 'ianaift:l3ipvlan',
          enabled: true,
          'ietf-ip:ipv4': { address: { ip: '10.0.99.12', 'prefix-length': 24 } },
          note: 'a <raw> & text',
          empty: null,
        },
      },
    });
    const listed = xmlToData(rootOf(parseXml(INTERFACES_XML)), { moduleOf, isArray: (p) => p[p.length - 1] === 'interface' || p[p.length - 1] === 'address' });
    expect(dataAt(listed, ['ietf-interfaces:interfaces', 'interface', 0, 'ietf-ip:ipv4', 'address', 0, 'ip'])).toBe('10.0.99.12');
    expect(xmlToData(rootOf(parseXml('<a><b>1</b><b>x</b><c>007</c><d>-1.5</d></a>')))).toEqual({ a: { b: [1, 'x'], c: '007', d: -1.5 } });
  });

  it('writes data as XML with namespaces and reads it back to the same data', () => {
    const json = valueOf(parseJson(INTERFACES_JSON));
    const x = dataToXml(json, { namespaceOf });
    if (!x.ok) throw new Error(x.message);
    const text = serializeXml(x.element);
    expect(text.split('\n').slice(0, 3)).toEqual([
      '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">',
      '  <interface>',
      '    <name>GigabitEthernet0/2</name>',
    ]);
    expect(text).toContain('<ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip">');
    const isArray = (p: readonly string[]): boolean => ['interface', 'address'].includes(p[p.length - 1] as string);
    const back = xmlToData(rootOf(parseXml(text)), { moduleOf, isArray });
    expect(stringifyJson(back)).toBe(INTERFACES_JSON);
    // without a namespace map the qualified names stay element names, and still come back
    const plain = dataToXml(json);
    if (!plain.ok) throw new Error(plain.message);
    expect(dataEquals(xmlToData(rootOf(parseXml(serializeXml(plain.element))), { isArray }), json)).toBe(true);
  });

  it('refuses data XML cannot express', () => {
    expect(dataToXml([1, 2])).toMatchObject({ ok: false, message: expect.stringMatching(/exactly one member/) as unknown });
    expect(dataToXml({ a: 1, b: 2 })).toMatchObject({ ok: false });
    expect(dataToXml({ a: [[1]] })).toMatchObject({ ok: false });
    expect(dataToXml({ a: { 'bad name': 1 } })).toMatchObject({ ok: false, message: expect.stringMatching(/not a valid XML element name/) as unknown });
    expect(dataToXml({ a: { b: 'bell\u0007' } })).toMatchObject({ ok: false, message: expect.stringMatching(/"b" holds a character XML cannot carry/) as unknown });
    expect(dataToXml({ a: '\ud83d' })).toMatchObject({ ok: false });
    expect(dataToXml({ a: 'tab\there\r\n😀' })).toMatchObject({ ok: true });
    const wrapped = dataToXml([1, 2], { rootName: 'data' });
    if (!wrapped.ok) throw new Error(wrapped.message);
    expect(serializeXml(wrapped.element)).toBe('<data>\n  <item>1</item>\n  <item>2</item>\n</data>');
    const empties = dataToXml({ r: { s: '', n: null, o: {} } });
    if (!empties.ok) throw new Error(empties.message);
    expect(serializeXml(empties.element)).toBe('<r>\n  <s></s>\n  <n/>\n  <o/>\n</r>');
  });
});
