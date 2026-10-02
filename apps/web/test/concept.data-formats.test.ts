/**
 * The data-formats playground model (ARCHITECTURE-P3 D21, §6, §10.2 "concept.data-formats"; W2 web-concept).
 *
 * Under test: parse errors with line and column for JSON, YAML and XML; the tree rows with both key-path forms and
 * the node positions; the sample library (what the YANG reader returns for each request); conversions that
 * round-trip every RESTCONF sample through YAML and XML back to the same data; and the seeded "which type / which
 * key" practice generator.
 */
import { describe, expect, it } from 'vitest';
import { dataEquals, parseJson } from '@netforge/engine/pure';
import {
  DATA_FORMATS,
  DATA_PRACTICE_FORMATS,
  DATA_PRACTICE_KINDS,
  checkDataAnswer,
  convertDataDocument,
  dataPractice,
  dataPreview,
  dataSample,
  dataSamples,
  dataTreeRows,
  errorText,
  parseDataDocument,
  readKeyPath,
  writeDataDocument,
  type DataFormat,
} from '../src/concept/data-formats/model.js';

describe('parse errors name the line and the column', () => {
  it('JSON: a trailing comma and a Python word', () => {
    const r = parseDataDocument('json', '{\n  "a": 1,\n}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.error.line, r.error.column]).toEqual([3, 1]);
    expect(r.text).toBe(`Line 3, column 1: ${r.error.message}`);
    const py = parseDataDocument('json', '{"up": True}');
    expect(py.ok).toBe(false);
    if (!py.ok) expect([py.error.line, py.error.column]).toEqual([1, 8]);
  });

  it('YAML: a tab used for indentation', () => {
    const r = parseDataDocument('yaml', 'interfaces:\n\t- name: Gi0/0\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBe(2);
      expect(r.error.column).toBeGreaterThanOrEqual(1);
      expect(r.text.startsWith('Line 2, column ')).toBe(true);
    }
  });

  it('XML: a closing tag that does not match', () => {
    const r = parseDataDocument('xml', '<native>\n  <hostname>R1</host>\n</native>');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBe(2);
      expect(r.error.column).toBeGreaterThan(1);
      expect(errorText(r.error)).toBe(r.text);
    }
  });
});

describe('the tree', () => {
  it('lists every node in document order with both key-path forms, its type, a preview and where it starts', () => {
    const r = parseDataDocument('json', '{\n  "ietf-interfaces:interfaces": {\n    "interface": [\n      {"name": "Gi0/0", "enabled": true}\n    ]\n  }\n}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => [x.dotPath, x.type, x.preview, x.line])).toEqual([
      ['', 'object', '{1 key}', 1],
      ['["ietf-interfaces:interfaces"]', 'object', '{1 key}', 2],
      ['["ietf-interfaces:interfaces"].interface', 'array', '[1 item]', 3],
      ['["ietf-interfaces:interfaces"].interface[0]', 'object', '{2 keys}', 4],
      ['["ietf-interfaces:interfaces"].interface[0].name', 'string', '"Gi0/0"', 4],
      ['["ietf-interfaces:interfaces"].interface[0].enabled', 'boolean', 'true', 4],
    ]);
    const name = r.rows[4]!;
    expect(name.indexPath).toBe('["ietf-interfaces:interfaces"]["interface"][0]["name"]');
    // the position is where the value starts ("Gi0/0" on line 4)
    expect([name.depth, name.key, name.line, name.column]).toEqual([4, 'name', 4, 16]);
    expect(r.rows[0]!.key).toBeNull();
  });

  it('gives YAML positions and XML rows (XML has no positions per value)', () => {
    const y = parseDataDocument('yaml', 'native:\n  hostname: R1\n  vlans: [10, 20]\n');
    expect(y.ok && y.rows.map((x) => [x.dotPath, x.type, x.line])).toEqual([
      ['', 'object', 1],
      ['native', 'object', 2],
      ['native.hostname', 'string', 2],
      ['native.vlans', 'array', 3],
      ['native.vlans[0]', 'number', 3],
      ['native.vlans[1]', 'number', 3],
    ]);
    const x = parseDataDocument('xml', '<native xmlns="urn:netforge:yang:nf-native"><hostname>R1</hostname></native>');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.value).toEqual({ 'nf-native:native': { hostname: 'R1' } });
    expect(x.rows.map((r) => r.dotPath)).toEqual(['', '["nf-native:native"]', '["nf-native:native"].hostname']);
    expect(x.rows.every((r) => r.line === undefined)).toBe(true);
  });

  it('previews long strings shortly and counts what containers hold', () => {
    expect(dataPreview('x'.repeat(80))).toHaveLength(40);
    expect(dataPreview('x'.repeat(80)).endsWith('…')).toBe(true);
    expect(dataPreview([])).toBe('[0 items]');
    expect(dataPreview({ a: 1 })).toBe('{1 key}');
    expect(dataPreview(null)).toBe('null');
    expect(dataTreeRows(3)).toEqual([{ path: [], dotPath: '', indexPath: '', depth: 0, key: null, type: 'number', preview: '3' }]);
  });
});

describe('the sample library', () => {
  it('holds the answers a device gives to six RESTCONF GETs, each as pretty JSON that parses back to its value', () => {
    const lib = dataSamples();
    expect(lib.map((s) => s.id)).toEqual(['interfaces', 'one-interface', 'interface-state', 'native', 'vlans', 'modules']);
    expect(dataSamples()).toBe(lib);
    for (const s of lib) {
      const back = parseJson(s.json);
      expect(back.ok && dataEquals(back.value, s.value), s.id).toBe(true);
      expect(s.request, s.id).toMatch(/^rest GET https:\/\/[\d.]+\/restconf\/data\/[a-z-]+:[a-z-]+/);
      expect(s.json.endsWith('\n')).toBe(true);
    }
  });

  it('is what the YANG reader returns: module-qualified members, a list entry as a one-element array, counters as strings', () => {
    expect(Object.keys(dataSample('interfaces')!.value as object)).toEqual(['ietf-interfaces:interfaces']);
    const one = dataSample('one-interface')!.value as Record<string, Record<string, unknown>[]>;
    expect(one['ietf-interfaces:interface']).toEqual([
      {
        name: 'GigabitEthernet0/1',
        description: 'to ISP',
        type: 'iana-if-type:ethernetCsmacd',
        enabled: true,
        'ietf-ip:ipv4': { address: [{ ip: '203.0.113.2', 'prefix-length': 30 }] },
      },
    ]);
    const state = dataSample('interface-state')!.value as Record<string, Record<string, Record<string, unknown>>[]>;
    expect(state['ietf-interfaces:interface']![0]!['statistics']!['in-octets']).toBe('48213');
    expect(dataSample('vlans')!.value).toEqual({
      'nf-native:vlan': {
        'vlan-list': [
          { id: 10, name: 'SALES' },
          { id: 20, name: 'ENGINEERING' },
          { id: 99, name: 'MANAGEMENT' },
        ],
      },
    });
    expect(dataSample('nope')).toBeUndefined();
  });
});

describe('conversions', () => {
  const FORMATS: readonly DataFormat[] = ['json', 'yaml', 'xml'];

  it('round-trip every RESTCONF sample through YAML and XML back to the same data', () => {
    for (const s of dataSamples()) {
      for (const via of ['yaml', 'xml'] as const) {
        const out = convertDataDocument(s.json, 'json', via);
        expect(out.ok, `${s.id} → ${via}`).toBe(true);
        if (!out.ok) continue;
        // XML is read back where the sample's request puts its root in the model
        const back = convertDataDocument(out.text, via, 'json', s.path);
        expect(back.ok, `${s.id} → ${via} → json`).toBe(true);
        if (!back.ok) continue;
        const parsed = parseJson(back.text);
        expect(parsed.ok && dataEquals(parsed.value, s.value), `${s.id} via ${via}`).toBe(true);
      }
    }
  });

  it('writes a GET of one list entry as that entry’s element, and reads it back as a one-element list', () => {
    const s = dataSample('one-interface')!;
    expect(s.path).toBe('/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1');
    const xml = writeDataDocument('xml', s.value);
    expect(xml.ok && xml.text).toBe(
      [
        '<interface xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">',
        '  <name>GigabitEthernet0/1</name>',
        '  <description>to ISP</description>',
        '  <type>iana-if-type:ethernetCsmacd</type>',
        '  <enabled>true</enabled>',
        '  <ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip">',
        '    <address>',
        '      <ip>203.0.113.2</ip>',
        '      <prefix-length>30</prefix-length>',
        '    </address>',
        '  </ipv4>',
        '</interface>',
        '',
      ].join('\n'),
    );
    if (!xml.ok) return;
    const withContext = parseDataDocument('xml', xml.text, s.path);
    expect(withContext.ok && dataEquals(withContext.value, s.value)).toBe(true);
    // without the context the reader cannot know the types deep in the model: the text stays text
    const bare = parseDataDocument('xml', xml.text);
    expect(bare.ok && bare.value).toMatchObject({ 'ietf-interfaces:interface': { enabled: 'true' } });
  });

  it('converts between any two formats and says why when it cannot', () => {
    const json = '{"nf-native:native": {"hostname": "R1", "banner": {"motd": "Authorised access only"}}}';
    for (const to of FORMATS) expect(convertDataDocument(json, 'json', to).ok, to).toBe(true);
    const xml = convertDataDocument(json, 'json', 'xml');
    expect(xml.ok && xml.text).toBe(
      '<native xmlns="urn:netforge:yang:nf-native">\n  <hostname>R1</hostname>\n  <banner>\n    <motd>Authorised access only</motd>\n  </banner>\n</native>\n',
    );
    const yaml = convertDataDocument(json, 'json', 'yaml');
    expect(yaml.ok && yaml.text).toBe('nf-native:native:\n  hostname: R1\n  banner:\n    motd: Authorised access only\n');
    // XML needs one root member
    const two = writeDataDocument('xml', { a: 1, b: 2 });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.message.length).toBeGreaterThan(0);
    const broken = convertDataDocument('{"a": }', 'json', 'yaml');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message).toMatch(/^The JSON document cannot be read\. Line 1, column 7: /);
    expect(DATA_FORMATS.map((f) => f.id)).toEqual([...FORMATS]);
  });
});

describe('the "which type / which key" practice', () => {
  it('is a pure function of (seed, index), over JSON and YAML documents of the samples', () => {
    const a = Array.from({ length: 30 }, (_, i) => dataPractice(11, i));
    expect(Array.from({ length: 30 }, (_, i) => dataPractice(11, i))).toEqual(a);
    expect(new Set(a.map((p) => p.kind))).toEqual(new Set(DATA_PRACTICE_KINDS));
    expect(new Set(a.map((p) => p.format))).toEqual(new Set(DATA_PRACTICE_FORMATS));
    expect(new Set(a.map((p) => p.sample)).size).toBeGreaterThan(3);
    expect(() => dataPractice(1, -1)).toThrow(RangeError);
    expect(() => dataPractice(1, 0, [])).toThrow(RangeError);
  });

  it('every answer holds for its document, and the checker accepts it', () => {
    for (let i = 0; i < 120; i++) {
      const p = dataPractice(5, i);
      const doc = parseDataDocument(p.format, p.document);
      expect(doc.ok, `${p.sample} ${p.format}`).toBe(true);
      if (!doc.ok) continue;
      const row = doc.rows.find((r) => r.dotPath === (p.kind === 'type' ? readKeyPath(p.prompt.split(' does ')[1]!.split(' hold?')[0]!) : p.answer));
      expect(row, p.prompt).toBeDefined();
      if (p.kind === 'type') expect(row!.type).toBe(p.answer);
      else {
        expect(p.prompt).toContain(row!.preview);
        // one path only leads to that value
        expect(doc.rows.filter((r) => r.type !== 'object' && r.type !== 'array' && r.preview === row!.preview)).toHaveLength(1);
      }
      expect(checkDataAnswer(p, p.answer).correct, p.prompt).toBe(true);
    }
  });

  it('accepts the words a learner uses and both key-path forms', () => {
    const typeQ = Array.from({ length: 50 }, (_, i) => dataPractice(9, i)).find((p) => p.kind === 'type' && p.answer === 'array')!;
    expect(checkDataAnswer(typeQ, 'List')).toMatchObject({ correct: true, given: 'array' });
    expect(checkDataAnswer(typeQ, 'dict')).toMatchObject({ correct: false, given: 'object' });
    expect(checkDataAnswer(typeQ, 'tuple')).toMatchObject({ correct: false, given: null });
    expect(checkDataAnswer(typeQ, 'list').explanation).toMatch(/is an array: it holds an ordered list of items\.$/);
    const keyQ = Array.from({ length: 50 }, (_, i) => dataPractice(9, i)).find((p) => p.kind === 'key')!;
    const index = keyQ.path.map((s) => (typeof s === 'number' ? `[${s}]` : `["${s}"]`)).join('');
    expect(checkDataAnswer(keyQ, index)).toMatchObject({ correct: true });
    expect(checkDataAnswer(keyQ, 'nowhere.at.all')).toMatchObject({ correct: false });
    expect(readKeyPath('ietf-interfaces:interfaces.interface[0].name')).toBe('["ietf-interfaces:interfaces"].interface[0].name');
    expect(readKeyPath(`['nf-native:native']['vlan']`)).toBe('["nf-native:native"].vlan');
    expect(readKeyPath('')).toBeNull();
    expect(readKeyPath('.a')).toBeNull();
    expect(readKeyPath('a[0')).toBeNull();
    expect(readKeyPath('a[x]')).toBeNull();
  });
});
