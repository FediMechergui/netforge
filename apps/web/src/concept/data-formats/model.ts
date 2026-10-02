/**
 * Data-formats playground model (ARCHITECTURE-P3 D21 "Data formats", §6; lesson 37's concept tool; W2 web-concept):
 * pure, DOM-free functions behind the playground (the tool itself is W3).
 *
 * - `parseDataDocument` reads a JSON, YAML or XML document with the engine's own parsers (`automation/data/*` through
 *   `@netforge/engine/pure`, the same ones the devices' RESTCONF service and the lesson code-sample test use). A
 *   broken document gives the parser's message with its line and column; a good one gives its value and a tree of
 *   rows, one per node, each with its key path in the dotted form and in the form a script indexes with.
 * - `convertDataDocument` writes the same data in another format. XML follows the RESTCONF encoding (RFC 7951 member
 *   names; a list as repeated elements; the module's namespace on the element where it changes; a GET of one list
 *   entry answers with that entry's element), using the YANG model's hints. Reading XML needs to know where in the
 *   model the document's root sits, so the XML calls take an optional `context`, the RESTCONF path the document
 *   answers (a sample's `path`); without it the root is a top-level node. With it, a device's answer converts to
 *   XML and back to the same data.
 * - `dataSamples` is the sample library: the JSON a NetForge device returns to RESTCONF GETs, produced by the YANG
 *   model's reader (`readYang`, the one the RESTCONF service answers with) over sample devices.
 * - `dataPractice` / `checkDataAnswer` form the "which type / which key" practice generator over the samples, a pure
 *   function of `(seed, index)`.
 *
 * All wording is original.
 */
import {
  dataEntries,
  dataToXml,
  dataTypeName,
  formatDataPath,
  isDataObject,
  parseJson,
  parseRestconfTarget,
  parseXml,
  parseYaml,
  readYang,
  resolveYangPath,
  serializeXml,
  stringifyJson,
  stringifyYaml,
  xmlToData,
  yangXmlHints,
} from '@netforge/engine/pure';
import type { DataPathSegment, DataSyntaxError, DataValue, XmlToDataOptions, YangStep } from '@netforge/engine/pure';
import type { ConfigNode, YangDeviceView } from '@netforge/engine';

// ── formats ─────────────────────────────────────────────────────────────────

/** The three formats of the playground. */
export type DataFormat = 'json' | 'yaml' | 'xml';

/** The formats in display order, with a line on each. */
export const DATA_FORMATS: readonly { readonly id: DataFormat; readonly label: string; readonly hint: string }[] = Object.freeze([
  { id: 'json', label: 'JSON', hint: 'Objects in braces, lists in brackets, every key and string in double quotes.' },
  { id: 'yaml', label: 'YAML', hint: 'Indentation shows nesting; a dash starts a list item; quotes are rarely needed.' },
  { id: 'xml', label: 'XML', hint: 'Every value sits between an opening and a closing tag; a repeated tag makes a list.' },
]);

/** The JSON type names a learner meets (the same words the engine's `dataTypeName` gives). */
export type DataTypeName = ReturnType<typeof dataTypeName>;

/** One node of a parsed document, as the tree shows it. */
export interface DataTreeRow {
  readonly path: readonly DataPathSegment[];
  /** `interfaces.interface[0].name`; the root is the empty string. */
  readonly dotPath: string;
  /** `["interfaces"]["interface"][0]["name"]`, the form a script indexes with. */
  readonly indexPath: string;
  /** 0 for the root. */
  readonly depth: number;
  /** The member name or list index that leads here (null for the root). */
  readonly key: string | number | null;
  readonly type: DataTypeName;
  /** A short text of the value: the scalar as JSON writes it (cut at 40 characters), or `{2 keys}` / `[3 items]`. */
  readonly preview: string;
  /** Where the node's value starts in the text (JSON and YAML only). */
  readonly line?: number;
  readonly column?: number;
}

export type DataDocResult =
  | { readonly ok: true; readonly format: DataFormat; readonly value: DataValue; readonly rows: readonly DataTreeRow[] }
  | {
      readonly ok: false;
      readonly format: DataFormat;
      readonly error: DataSyntaxError;
      /** `Line 3, column 7: <message>` */
      readonly text: string;
    };

const PREVIEW_MAX = 40;

/** The tree's short text of a value. */
export function dataPreview(value: DataValue): string {
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  if (isDataObject(value)) {
    const n = Object.keys(value).length;
    return `{${n} key${n === 1 ? '' : 's'}}`;
  }
  const s = JSON.stringify(value);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}…` : s;
}

function row(path: readonly DataPathSegment[], value: DataValue, at?: { line: number; column: number }): DataTreeRow {
  return {
    path,
    dotPath: formatDataPath(path, 'dot'),
    indexPath: formatDataPath(path, 'index'),
    depth: path.length,
    key: path.length === 0 ? null : (path[path.length - 1] as string | number),
    type: dataTypeName(value),
    preview: dataPreview(value),
    ...(at === undefined ? {} : { line: at.line, column: at.column }),
  };
}

/** Every node of a value in document order (pre-order), the root first. */
export function dataTreeRows(value: DataValue): DataTreeRow[] {
  const out: DataTreeRow[] = [];
  const walk = (v: DataValue, path: DataPathSegment[]): void => {
    out.push(row(path, v));
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, [...path, i]));
    else if (isDataObject(v)) for (const k of Object.keys(v)) walk(v[k] as DataValue, [...path, k]);
  };
  walk(value, []);
  return out;
}

/** The resolved model steps of a RESTCONF data path (`/restconf/data/…`), or undefined when it names none. */
function contextSteps(context: string | undefined): readonly YangStep[] | undefined {
  if (context === undefined) return undefined;
  const t = parseRestconfTarget(context);
  if (!t.ok || t.resource.kind !== 'data') return undefined;
  const r = resolveYangPath(t.resource.path);
  return r.ok && r.steps.length > 0 ? r.steps : undefined;
}

/**
 * The YANG hints for reading an XML document whose root is the last step of `steps`: the member paths the reader
 * asks about are prefixed with the steps above the root, so a list or a typed leaf deep in the model is known.
 */
function xmlReadHints(steps: readonly YangStep[] | undefined): XmlToDataOptions {
  const base = yangXmlHints();
  if (steps === undefined || steps.length < 2) return base;
  const above = steps.slice(0, -1).map((st) => `${st.node.module}:${st.node.name}`);
  return {
    moduleOf: base.moduleOf,
    isArray: (path) => base.isArray([...above, ...path]),
    scalar: (path, text, selfClosing) => base.scalar([...above, ...path], text, selfClosing),
  };
}

/** Reads a document of `format` (file header); `context` is the RESTCONF path an XML document answers. */
export function parseDataDocument(format: DataFormat, text: string, context?: string): DataDocResult {
  if (format === 'xml') {
    const r = parseXml(text);
    if (!r.ok) return { ok: false, format, error: r.error, text: errorText(r.error) };
    const steps = contextSteps(context);
    let value: DataValue = xmlToData(r.document.root, xmlReadHints(steps));
    // a GET of one list entry answers with the entry's element; its JSON form is a one-element array
    const last = steps?.[steps.length - 1];
    if (last !== undefined && last.node.kind === 'list' && last.keys !== undefined && isDataObject(value)) {
      const member = Object.keys(value)[0]!;
      value = { [member]: [value[member] as DataValue] };
    }
    return { ok: true, format, value, rows: dataTreeRows(value) };
  }
  const r = format === 'json' ? parseJson(text) : parseYaml(text);
  if (!r.ok) return { ok: false, format, error: r.error, text: errorText(r.error) };
  const value = r.value;
  const rows = dataEntries(r.node).map((e) => {
    const v = valueAtPath(value, e.path);
    return row(e.path, v, { line: e.node.span.start.line, column: e.node.span.start.column });
  });
  return { ok: true, format, value, rows };
}

function valueAtPath(value: DataValue, path: readonly DataPathSegment[]): DataValue {
  let cur: DataValue = value;
  for (const seg of path) cur = (typeof seg === 'number' ? (cur as DataValue[])[seg] : (cur as Record<string, DataValue>)[seg]) as DataValue;
  return cur;
}

/** `Line 3, column 7: <message>` */
export function errorText(e: DataSyntaxError): string {
  return `Line ${e.line}, column ${e.column}: ${e.message}`;
}

export type DataConvertResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * Writes a value in `format`. XML is the RESTCONF encoding, which needs one root member; a root member holding a
 * one-element list (the answer to a GET of one list entry) is written as that entry's element.
 */
export function writeDataDocument(format: DataFormat, value: DataValue): DataConvertResult {
  if (format === 'json') return { ok: true, text: `${stringifyJson(value)}\n` };
  if (format === 'yaml') return { ok: true, text: stringifyYaml(value) };
  let root = value;
  if (isDataObject(value)) {
    const keys = Object.keys(value);
    const only = keys.length === 1 ? value[keys[0]!] : undefined;
    if (Array.isArray(only) && only.length === 1) root = { [keys[0]!]: only[0] as DataValue };
  }
  const r = dataToXml(root, { namespaceOf: yangXmlHints().namespaceOf });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, text: `${serializeXml(r.element)}\n` };
}

/** Reads `text` as `from` and writes the same data as `to` (file header); `context` as for `parseDataDocument`. */
export function convertDataDocument(text: string, from: DataFormat, to: DataFormat, context?: string): DataConvertResult {
  const parsed = parseDataDocument(from, text, context);
  if (!parsed.ok) return { ok: false, message: `The ${formatLabel(from)} document cannot be read. ${parsed.text}` };
  return writeDataDocument(to, parsed.value);
}

function formatLabel(f: DataFormat): string {
  return DATA_FORMATS.find((x) => x.id === f)?.label ?? f;
}

// ── the sample library ──────────────────────────────────────────────────────

/** One answer a device gives: what was asked, and the JSON body that came back. */
export interface DataSample {
  readonly id: string;
  readonly title: string;
  readonly device: string;
  /** The RESTCONF path asked for (`/restconf/data/…`): the `context` that reads the sample's XML form back. */
  readonly path: string;
  /** The request, as the host shell's `rest` command would send it. */
  readonly request: string;
  readonly value: DataValue;
  /** The body as the device sends it (pretty JSON). */
  readonly json: string;
}

/** A configuration node (the shape `ConfigAst.root` and its children have). */
function cfg(key: string, args: string[] = [], children: ConfigNode[] = []): ConfigNode {
  return { key, args, children };
}

/** The interfaces of the sample router (a home office edge: a LAN port, a WAN port, a disabled spare). */
function sampleRouter(): YangDeviceView {
  return {
    hostname: 'R1',
    config: cfg('', [], [
      cfg('hostname', ['R1']),
      cfg('banner', ['motd', 'Authorised', 'access', 'only']),
      cfg('interface', ['GigabitEthernet0/0'], [cfg('description', ['LAN', 'users']), cfg('ip', [], [cfg('address', ['192.168.10.1', '255.255.255.0'])])]),
      cfg('interface', ['GigabitEthernet0/1'], [cfg('description', ['to', 'ISP']), cfg('ip', [], [cfg('address', ['203.0.113.2', '255.255.255.252'])])]),
      cfg('interface', ['GigabitEthernet0/2'], [cfg('shutdown')]),
    ]),
    interfaces: [
      {
        name: 'GigabitEthernet0/0',
        ifType: 'ethernetCsmacd',
        operUp: true,
        physAddress: '0011.2233.4401',
        speedBps: 1_000_000_000,
        counters: { inOctets: 48213, inUnicastPkts: 391, inDiscards: 0, inErrors: 0, outOctets: 51877, outUnicastPkts: 402, outDiscards: 0, outErrors: 0 },
      },
      {
        name: 'GigabitEthernet0/1',
        ifType: 'ethernetCsmacd',
        operUp: true,
        physAddress: '0011.2233.4402',
        speedBps: 1_000_000_000,
        counters: { inOctets: 90112, inUnicastPkts: 655, inDiscards: 0, inErrors: 0, outOctets: 77310, outUnicastPkts: 610, outDiscards: 2, outErrors: 0 },
      },
      { name: 'GigabitEthernet0/2', ifType: 'ethernetCsmacd', operUp: false, physAddress: '0011.2233.4403', speedBps: 1_000_000_000 },
    ],
  };
}

/** The sample switch: VLANs and a management interface. */
function sampleSwitch(): YangDeviceView {
  return {
    hostname: 'SW1',
    config: cfg('', [], [
      cfg('hostname', ['SW1']),
      cfg('vlan', ['10'], [cfg('name', ['SALES'])]),
      cfg('vlan', ['20'], [cfg('name', ['ENGINEERING'])]),
      cfg('vlan', ['99'], [cfg('name', ['MANAGEMENT'])]),
      cfg('interface', ['Vlan99'], [cfg('ip', [], [cfg('address', ['192.168.99.11', '255.255.255.0'])])]),
    ]),
    interfaces: [{ name: 'Vlan99', ifType: 'l3ipvlan', operUp: true, physAddress: '0011.2233.5501' }],
  };
}

const SAMPLE_REQUESTS: readonly { id: string; title: string; device: 'R1' | 'SW1'; address: string; path: string }[] = [
  { id: 'interfaces', title: 'Every interface of a router', device: 'R1', address: '192.168.10.1', path: '/restconf/data/ietf-interfaces:interfaces' },
  {
    id: 'one-interface',
    title: 'One interface, named by its key',
    device: 'R1',
    address: '192.168.10.1',
    path: '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1',
  },
  {
    id: 'interface-state',
    title: 'The state and counters of one interface',
    device: 'R1',
    address: '192.168.10.1',
    path: '/restconf/data/ietf-interfaces:interfaces-state/interface=GigabitEthernet0%2F0',
  },
  { id: 'native', title: 'A router’s own settings', device: 'R1', address: '192.168.10.1', path: '/restconf/data/nf-native:native' },
  { id: 'vlans', title: 'The VLANs of a switch', device: 'SW1', address: '192.168.99.11', path: '/restconf/data/nf-native:native/vlan' },
  { id: 'modules', title: 'The models a device serves', device: 'SW1', address: '192.168.99.11', path: '/restconf/data/ietf-yang-library:modules-state' },
];

let samples: readonly DataSample[] | undefined;

/** The sample library (built on first use; the same objects afterwards). */
export function dataSamples(): readonly DataSample[] {
  if (samples !== undefined) return samples;
  const devices = { R1: sampleRouter(), SW1: sampleSwitch() };
  samples = Object.freeze(
    SAMPLE_REQUESTS.map((s) => {
      const target = parseRestconfTarget(s.path);
      if (!target.ok || target.resource.kind !== 'data') throw new Error(`sample ${s.id}: bad path`);
      const steps = resolveYangPath(target.resource.path);
      if (!steps.ok) throw new Error(`sample ${s.id}: ${steps.error.message}`);
      const read = readYang(devices[s.device], steps.steps);
      if (!read.ok) throw new Error(`sample ${s.id}: ${read.error.message}`);
      return Object.freeze({
        id: s.id,
        title: s.title,
        device: s.device,
        path: s.path,
        request: `rest GET https://${s.address}${s.path} -u admin:admin`,
        value: read.value,
        json: `${stringifyJson(read.value)}\n`,
      });
    }),
  );
  return samples;
}

/** The sample with this id. */
export function dataSample(id: string): DataSample | undefined {
  return dataSamples().find((s) => s.id === id);
}

// ── practice ────────────────────────────────────────────────────────────────

/** The kinds of practice question: the type of the value at a path, or the path to a value. */
export type DataPracticeKind = 'type' | 'key';

export const DATA_PRACTICE_KINDS: readonly DataPracticeKind[] = Object.freeze(['type', 'key']);

/**
 * The formats practice documents are written in. Not XML: its values are all text (it has no number or boolean type
 * of its own) and its element names drop the RESTCONF module prefixes, so neither question has one answer there.
 */
export const DATA_PRACTICE_FORMATS: readonly DataFormat[] = Object.freeze(['json', 'yaml']);

/** One practice question with its expected answer. */
export interface DataProblem {
  readonly seed: number;
  readonly index: number;
  readonly kind: DataPracticeKind;
  readonly sample: string;
  readonly format: DataFormat;
  /** The document the question is about, in `format`. */
  readonly document: string;
  /** The path asked about (`type`) or the path that is the answer (`key`). */
  readonly path: readonly DataPathSegment[];
  readonly prompt: string;
  /** Canonical answer: a type name, or a dotted key path. */
  readonly answer: string;
}

export interface DataCheck {
  readonly correct: boolean;
  readonly expected: string;
  /** The answer read into canonical form, or null when it could not be read. */
  readonly given: string | null;
  readonly explanation: string;
}

/** Words a learner may use for each type (Python and YAML habits included). */
const TYPE_WORDS: Readonly<Record<DataTypeName, readonly string[]>> = Object.freeze({
  object: ['object', 'dictionary', 'dict', 'mapping', 'map'],
  array: ['array', 'list', 'sequence'],
  string: ['string', 'str', 'text'],
  number: ['number', 'integer', 'int', 'float'],
  boolean: ['boolean', 'bool'],
  null: ['null', 'none', 'nil'],
});

/**
 * Question `index` (0, 1, 2, …) of the practice series for `seed`, over the sample library: the same `(seed, index,
 * kinds)` always gives the same question, on every machine.
 */
export function dataPractice(seed: number, index: number, kinds: readonly DataPracticeKind[] = DATA_PRACTICE_KINDS): DataProblem {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`practice index ${index}`);
  if (kinds.length === 0) throw new RangeError('dataPractice: no question kinds selected');
  const rng = new PracticeRng(seed, index);
  const kind = kinds[rng.below(kinds.length)]!;
  const lib = dataSamples();
  const sample = lib[rng.below(lib.length)]!;
  const format = DATA_PRACTICE_FORMATS[rng.below(DATA_PRACTICE_FORMATS.length)]!;
  const written = writeDataDocument(format, sample.value);
  const document = written.ok ? written.text : sample.json;
  const shownFormat: DataFormat = written.ok ? format : 'json';
  const rows = dataTreeRows(sample.value).filter((r) => r.depth > 0);
  const name = formatLabel(shownFormat);
  if (kind === 'type') {
    const r = rows[rng.below(rows.length)]!;
    return {
      seed,
      index,
      kind,
      sample: sample.id,
      format: shownFormat,
      document,
      path: r.path,
      prompt: `In this ${name} document, what type of value does ${r.dotPath} hold?`,
      answer: r.type,
    };
  }
  // a scalar whose value appears once in the document, so exactly one path leads to it
  const scalars = rows.filter((r) => r.type !== 'object' && r.type !== 'array');
  const unique = scalars.filter((r) => scalars.filter((o) => o.preview === r.preview).length === 1);
  const pool = unique.length > 0 ? unique : scalars;
  const r = pool[rng.below(pool.length)]!;
  return {
    seed,
    index,
    kind,
    sample: sample.id,
    format: shownFormat,
    document,
    path: r.path,
    prompt: `In this ${name} document, which key path leads to the value ${r.preview}? Write it with dots, as in a.b[0].c.`,
    answer: r.dotPath,
  };
}

/** Reads a typed key path (dotted or indexed form) into the canonical dotted form, or null. */
export function readKeyPath(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  const path: DataPathSegment[] = [];
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === '.') {
      if (path.length === 0) return null;
      i++;
      continue;
    }
    if (c === '[') {
      const close = t.indexOf(']', i);
      if (close < 0) return null;
      const inner = t.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) path.push(Number(inner));
      else if (/^"(?:[^"\\]|\\.)*"$/.test(inner) || /^'[^']*'$/.test(inner)) path.push(inner.startsWith('"') ? (JSON.parse(inner) as string) : inner.slice(1, -1));
      else return null;
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < t.length && t[j] !== '.' && t[j] !== '[') j++;
    const name = t.slice(i, j).trim();
    if (name === '') return null;
    path.push(name);
    i = j;
  }
  return formatDataPath(path, 'dot');
}

/** Checks `input` against `problem`, accepting any reasonable spelling. */
export function checkDataAnswer(problem: DataProblem, input: string): DataCheck {
  let given: string | null = null;
  if (problem.kind === 'type') {
    const t = input.trim().toLowerCase();
    for (const [type, words] of Object.entries(TYPE_WORDS)) if (words.includes(t)) given = type;
  } else {
    given = readKeyPath(input);
  }
  return { correct: given === problem.answer, expected: problem.answer, given, explanation: explainProblem(problem) };
}

function explainProblem(p: DataProblem): string {
  const sample = dataSample(p.sample);
  const value = sample === undefined ? undefined : valueAtPath(sample.value, p.path);
  if (p.kind === 'type') {
    const how: Record<DataTypeName, string> = {
      object: 'it holds named members',
      array: 'it holds an ordered list of items',
      string: 'it is text',
      number: 'it is a number written without quotes',
      boolean: 'it is true or false, without quotes',
      null: 'it holds no value',
    };
    return `${formatDataPath(p.path, 'dot')} is ${p.answer === 'object' || p.answer === 'array' ? 'an' : 'a'} ${p.answer}: ${how[p.answer as DataTypeName]}.`;
  }
  const preview = value === undefined ? '' : ` ${dataPreview(value)}`;
  return `Follow the names from the top: ${p.answer} leads to${preview}. In a script it reads ${formatDataPath(p.path, 'index')}.`;
}

/**
 * Deterministic draws for practice questions: the state is a 32-bit hash of `(seed, index)` (the murmur3
 * finaliser) and draws come from xorshift32. Integer maths only, so every platform agrees.
 */
class PracticeRng {
  #s: number;

  constructor(seed: number, index: number) {
    const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    let h = fmix32((s >>> 0) ^ 0x1b873593);
    h = fmix32(h ^ Math.imul(Math.floor(s / 4294967296) >>> 0, 0x85ebca6b));
    h = fmix32(h ^ Math.imul(index >>> 0, 0xc2b2ae35) ^ 0x7feb352d);
    this.#s = h === 0 ? 0x6d2b79f5 : h;
  }

  next(): number {
    let x = this.#s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.#s = x;
    return x;
  }

  /** Uniform integer in [0, n) by rejection (no modulo bias). */
  below(n: number): number {
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
