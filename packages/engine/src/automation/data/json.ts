/**
 * JSON with positions (ARCHITECTURE-P3 D21 "Data formats", §7 W1 auto) — and the data model the three data-format
 * parsers share.
 *
 * Pure and dependency-free: exported through `@netforge/engine/pure` for the data-formats playground (parse errors with
 * line and column, a tree with key paths, conversion), the lesson code-sample test (§11.3) and the RESTCONF daemon and
 * client (request and response bodies). Nothing here reads a clock, a random source or another module's state.
 *
 * The parser is strict RFC 8259 plus the I-JSON rule that a member name appears once per object (RFC 7493 §2.3, which
 * RFC 7951 relies on). Every error names its line and column (both 1-based) and says, in original wording, what a
 * learner typed wrong — including the mistakes a Python or YAML writer makes (`True`, `None`, single quotes, comments,
 * trailing commas).
 */

// ── the shared data model ────────────────────────────────────────────────────

/** A place in a text: `line` and `column` count from 1 (columns in UTF-16 code units), `offset` from 0. */
export interface SourcePos {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** A range of a text, `end` exclusive. */
export interface SourceSpan {
  readonly start: SourcePos;
  readonly end: SourcePos;
}

/** A scalar of the shared data model. Numbers are always finite. */
export type DataScalar = null | boolean | number | string;

/** An object of the shared data model; member order is insertion order (as JavaScript keeps it). */
export interface DataObject {
  [key: string]: DataValue;
}

/** The value the JSON and YAML parsers produce and the converters consume (the JSON data model). */
export type DataValue = DataScalar | DataValue[] | DataObject;

interface DataNodeBase {
  readonly span: SourceSpan;
}

/** `null` (JSON), `null`/`~`/empty (YAML). */
export interface DataNullNode extends DataNodeBase {
  readonly kind: 'null';
  readonly value: null;
}

export interface DataBooleanNode extends DataNodeBase {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface DataNumberNode extends DataNodeBase {
  readonly kind: 'number';
  readonly value: number;
  /** The number exactly as written (`1.50`, `0x1F`). */
  readonly raw: string;
}

export interface DataStringNode extends DataNodeBase {
  readonly kind: 'string';
  readonly value: string;
}

export interface DataArrayNode extends DataNodeBase {
  readonly kind: 'array';
  readonly items: readonly DataNode[];
}

/** One member of an object, with where its key was written. */
export interface DataEntry {
  readonly key: string;
  readonly keySpan: SourceSpan;
  readonly value: DataNode;
}

export interface DataObjectNode extends DataNodeBase {
  readonly kind: 'object';
  readonly entries: readonly DataEntry[];
}

/** A parsed value with the position of every part of it (the playground's tree). */
export type DataNode = DataNullNode | DataBooleanNode | DataNumberNode | DataStringNode | DataArrayNode | DataObjectNode;

/** Where a document stops being valid, and why (original wording). */
export interface DataSyntaxError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** The result of the JSON and YAML parsers. */
export type DataParseResult =
  | { readonly ok: true; readonly value: DataValue; readonly node: DataNode }
  | { readonly ok: false; readonly error: DataSyntaxError };

/** One step of a key path: a member name or an array index. */
export type DataPathSegment = string | number;

/** The deepest nesting any of the parsers accepts (a guard against stack exhaustion, not a format rule). */
export const DATA_MAX_DEPTH = 256;

// ── positions ────────────────────────────────────────────────────────────────

/**
 * Maps offsets of `text` to positions. A line ends at LF, at CR LF (one break) or at a lone CR.
 * Built once per text; each lookup is a binary search.
 */
export function textPositions(text: string): (offset: number) => SourcePos {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return (offset: number): SourcePos => {
    const at = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - (starts[lo] as number) + 1, offset: at };
  };
}

// ── value helpers ────────────────────────────────────────────────────────────

/** Sets `obj[key]` as an own data member, even for `__proto__` (never touches the prototype). */
export function setDataMember(obj: DataObject, key: string, value: DataValue): void {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

/** Whether `v` is a data object (not null, not an array). */
export function isDataObject(v: DataValue | undefined): v is DataObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep structural equality of two data values (member order ignored, array order kept; `-0` equals `0`). */
export function dataEquals(a: DataValue, b: DataValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!dataEquals(a[i] as DataValue, b[i] as DataValue)) return false;
    return true;
  }
  if (isDataObject(a)) {
    if (!isDataObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!dataEquals(a[k] as DataValue, b[k] as DataValue)) return false;
    }
    return true;
  }
  return false;
}

/** The plain value of a positioned node. */
export function dataValueOf(node: DataNode): DataValue {
  switch (node.kind) {
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return node.value;
    case 'array':
      return node.items.map(dataValueOf);
    case 'object': {
      const out: DataObject = {};
      for (const e of node.entries) setDataMember(out, e.key, dataValueOf(e.value));
      return out;
    }
  }
}

/** One node of a document with its key path from the root (the playground's tree and "which key" practice). */
export interface DataPathEntry {
  readonly path: readonly DataPathSegment[];
  readonly node: DataNode;
}

/** Every node of a document in document order (pre-order), the root first with the empty path. */
export function dataEntries(root: DataNode): DataPathEntry[] {
  const out: DataPathEntry[] = [];
  const walk = (node: DataNode, path: DataPathSegment[]): void => {
    out.push({ path, node });
    if (node.kind === 'array') node.items.forEach((item, i) => walk(item, [...path, i]));
    else if (node.kind === 'object') for (const e of node.entries) walk(e.value, [...path, e.key]);
  };
  walk(root, []);
  return out;
}

const PATH_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A key path as text. `'dot'`: `interfaces.interface[0].name`, with `["…"]` for a key that is not an identifier
 * (`["ietf-interfaces:interfaces"].interface[0]`); `'index'`: the form a script indexes with,
 * `["ietf-interfaces:interfaces"]["interface"][0]["name"]`.
 */
export function formatDataPath(path: readonly DataPathSegment[], style: 'dot' | 'index' = 'dot'): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (style === 'dot' && PATH_IDENTIFIER.test(seg)) out += out === '' ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** The value at `path` inside `value`, or undefined when a step does not exist. */
export function dataAt(value: DataValue, path: readonly DataPathSegment[]): DataValue | undefined {
  let cur: DataValue | undefined = value;
  for (const seg of path) {
    if (cur === undefined) return undefined;
    if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : undefined;
    else cur = isDataObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
  }
  return cur;
}

/** The JSON type name a learner sees for a value: object, array, string, number, boolean or null. */
export function dataTypeName(value: DataValue): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value as 'string' | 'number' | 'boolean';
}

// ── JSON parsing ─────────────────────────────────────────────────────────────

/** Thrown inside the parser only; turned into a `DataSyntaxError` at the entry. */
class JsonFail extends Error {
  constructor(readonly at: number, message: string) {
    super(message);
  }
}

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

function describeChar(c: string): string {
  if (c === '') return 'the end of the document';
  if (c === '\n' || c === '\r') return 'a line break';
  if (c === '\t') return 'a tab';
  return `"${c}"`;
}

class JsonParser {
  private i = 0;
  private readonly pos: (offset: number) => SourcePos;

  constructor(private readonly text: string) {
    this.pos = textPositions(text);
  }

  parse(): DataNode {
    this.skipSpace();
    if (this.i >= this.text.length) throw new JsonFail(this.i, 'The document is empty: a JSON document holds one value.');
    const node = this.value(0);
    this.skipSpace();
    if (this.i < this.text.length) {
      const c = this.text[this.i] as string;
      if (c === ',') throw new JsonFail(this.i, 'Only one value may appear at the top level; wrap several values in [ ] to make an array.');
      throw new JsonFail(this.i, `Only one value may appear at the top level; found ${describeChar(c)} after it.`);
    }
    return node;
  }

  private span(start: number): SourceSpan {
    return { start: this.pos(start), end: this.pos(this.i) };
  }

  private skipSpace(): void {
    const t = this.text;
    for (;;) {
      const c = t.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.i++;
        continue;
      }
      if (c === 47 && (t[this.i + 1] === '/' || t[this.i + 1] === '*')) throw new JsonFail(this.i, 'JSON does not allow comments.');
      if (c === 35) throw new JsonFail(this.i, 'JSON does not allow comments ("#" starts a comment in YAML and Python, not in JSON).');
      return;
    }
  }

  private value(depth: number): DataNode {
    if (depth >= DATA_MAX_DEPTH) throw new JsonFail(this.i, `The document nests more than ${DATA_MAX_DEPTH} levels deep.`);
    const c = this.text[this.i] ?? '';
    const start = this.i;
    switch (c) {
      case '{':
        return this.object(depth);
      case '[':
        return this.array(depth);
      case '"':
        return { kind: 'string', value: this.string(), span: this.span(start) };
      case "'":
        throw new JsonFail(this.i, 'JSON strings use double quotes ("), not single quotes.');
      case '':
        throw new JsonFail(this.i, 'The document ends too early: a value is missing.');
      default:
        break;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    WORD.lastIndex = this.i;
    const w = WORD.exec(this.text)?.[0];
    if (w !== undefined) {
      if (w === 'true' || w === 'false') {
        this.i += w.length;
        return { kind: 'boolean', value: w === 'true', span: this.span(start) };
      }
      if (w === 'null') {
        this.i += w.length;
        return { kind: 'null', value: null, span: this.span(start) };
      }
      const lower = w.toLowerCase();
      if (lower === 'true' || lower === 'false' || lower === 'null') throw new JsonFail(this.i, `JSON writes true, false and null in lower case; found "${w}".`);
      if (w === 'None') throw new JsonFail(this.i, 'JSON writes an empty value as null; "None" is Python.');
      if (w === 'NaN' || w === 'Infinity') throw new JsonFail(this.i, `JSON has no "${w}"; numbers must be finite.`);
      throw new JsonFail(this.i, `Unexpected word "${w}": a string value needs double quotes.`);
    }
    if (c === '+') throw new JsonFail(this.i, 'A JSON number cannot start with "+".');
    if (c === '.') throw new JsonFail(this.i, 'A JSON number needs a digit before the decimal point.');
    if (c === ']' || c === '}') throw new JsonFail(this.i, `Unexpected "${c}": a value is missing here.`);
    if (c === ',') throw new JsonFail(this.i, 'Unexpected ",": a value is missing here.');
    throw new JsonFail(this.i, `Unexpected ${describeChar(c)}: expected a value.`);
  }

  private number(): DataNode {
    const start = this.i;
    JSON_NUMBER.lastIndex = start;
    const m = JSON_NUMBER.exec(this.text);
    const raw = m?.[0] ?? '';
    if (raw === '' || raw === '-') throw new JsonFail(start + raw.length, 'A number needs at least one digit.');
    const next = this.text[start + raw.length] ?? '';
    if (raw === '0' || raw === '-0') {
      if (next >= '0' && next <= '9') throw new JsonFail(start, 'A JSON number cannot start with 0 followed by more digits.');
    }
    if (next === '.') {
      // a second point (an unquoted address such as 10.0.0.1, the commonest slip) is reported at the value's start
      if (raw.includes('.')) {
        throw new JsonFail(start, 'A number has at most one decimal point; a dotted value such as 10.0.0.1 is text and needs double quotes.');
      }
      const after = this.text[start + raw.length + 1] ?? '';
      if (after >= '0' && after <= '9') throw new JsonFail(start + raw.length, 'An exponent is a whole number: it cannot have a decimal point.');
      throw new JsonFail(start + raw.length + 1, 'A decimal point must be followed by at least one digit.');
    }
    if (next === 'e' || next === 'E') throw new JsonFail(start + raw.length + 1, 'An exponent needs at least one digit.');
    if (/[A-Za-z_]/.test(next)) throw new JsonFail(start + raw.length, `Unexpected "${next}" inside a number.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new JsonFail(start, 'The number is too large to represent.');
    this.i = start + raw.length;
    return { kind: 'number', value: value === 0 ? 0 : value, raw, span: this.span(start) };
  }

  private string(): string {
    const t = this.text;
    const open = this.i;
    this.i++;
    let out = '';
    let run = this.i;
    for (;;) {
      const c = t.charCodeAt(this.i);
      if (Number.isNaN(c)) throw new JsonFail(open, 'This string is never closed: a " is missing.');
      if (c === 34) {
        out += t.slice(run, this.i);
        this.i++;
        return out;
      }
      if (c < 0x20) {
        if (c === 10 || c === 13) throw new JsonFail(this.i, 'A string cannot contain a line break; write it as \\n, or close the string with ".');
        throw new JsonFail(this.i, 'A string cannot contain a raw control character; write it as an escape such as \\t.');
      }
      if (c === 92) {
        out += t.slice(run, this.i);
        const e = t[this.i + 1] ?? '';
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = t.slice(this.i + 2, this.i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new JsonFail(this.i, 'A \\u escape needs exactly four hexadecimal digits.');
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          case '':
            throw new JsonFail(open, 'This string is never closed: a " is missing.');
          default:
            throw new JsonFail(this.i, `Unknown escape "\\${e}" in a string; JSON knows \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX.`);
        }
        this.i += 2;
        run = this.i;
        continue;
      }
      this.i++;
    }
  }

  private array(depth: number): DataNode {
    const start = this.i;
    this.i++;
    const items: DataNode[] = [];
    this.skipSpace();
    if (this.text[this.i] === ']') {
      this.i++;
      return { kind: 'array', items, span: this.span(start) };
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.i] === ']' && items.length > 0) throw new JsonFail(this.i, 'A trailing comma is not allowed in JSON: remove the "," before "]".');
      items.push(this.value(depth + 1));
      this.skipSpace();
      const c = this.text[this.i] ?? '';
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return { kind: 'array', items, span: this.span(start) };
      }
      if (c === '') throw new JsonFail(start, 'This array is never closed: a "]" is missing.');
      throw new JsonFail(this.i, `Expected "," or "]" after an array item; found ${describeChar(c)}.`);
    }
  }

  private object(depth: number): DataNode {
    const start = this.i;
    this.i++;
    const entries: DataEntry[] = [];
    const seen = new Set<string>();
    this.skipSpace();
    if (this.text[this.i] === '}') {
      this.i++;
      return { kind: 'object', entries, span: this.span(start) };
    }
    for (;;) {
      this.skipSpace();
      const c = this.text[this.i] ?? '';
      if (c === '}' && entries.length > 0) throw new JsonFail(this.i, 'A trailing comma is not allowed in JSON: remove the "," before "}".');
      if (c === '') throw new JsonFail(start, 'This object is never closed: a "}" is missing.');
      if (c === "'") throw new JsonFail(this.i, 'Object keys must be strings in double quotes ("), not single quotes.');
      if (c !== '"') throw new JsonFail(this.i, 'Object keys must be strings in double quotes.');
      const keyStart = this.i;
      const key = this.string();
      const keySpan = this.span(keyStart);
      if (seen.has(key)) throw new JsonFail(keyStart, `The key "${key}" appears twice in the same object.`);
      seen.add(key);
      this.skipSpace();
      if (this.text[this.i] !== ':') {
        const found = this.text[this.i] ?? '';
        if (found === '=') throw new JsonFail(this.i, 'JSON separates a key from its value with ":", not "=".');
        throw new JsonFail(this.i, `Expected ":" after the key "${key}"; found ${describeChar(found)}.`);
      }
      this.i++;
      this.skipSpace();
      const value = this.value(depth + 1);
      entries.push({ key, keySpan, value });
      this.skipSpace();
      const d = this.text[this.i] ?? '';
      if (d === ',') {
        this.i++;
        continue;
      }
      if (d === '}') {
        this.i++;
        return { kind: 'object', entries, span: this.span(start) };
      }
      if (d === '') throw new JsonFail(start, 'This object is never closed: a "}" is missing.');
      if (d === '"') throw new JsonFail(this.i, 'Expected "," between two members of an object.');
      throw new JsonFail(this.i, `Expected "," or "}" after the value of "${key}"; found ${describeChar(d)}.`);
    }
  }

  error(e: JsonFail): DataSyntaxError {
    const p = this.pos(e.at);
    return { message: e.message, line: p.line, column: p.column, offset: p.offset };
  }
}

/** Parses a JSON document (RFC 8259, member names unique). A leading byte-order mark is skipped. */
export function parseJson(text: string): DataParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text;
  const p = new JsonParser(src);
  try {
    const node = p.parse();
    return { ok: true, value: dataValueOf(node), node };
  } catch (e) {
    if (e instanceof JsonFail) return { ok: false, error: p.error(e) };
    throw e;
  }
}

/** Options of `stringifyJson`. */
export interface JsonStringifyOptions {
  /** Spaces per level; 0 writes one line. Default 2 (the pretty form the `rest` command prints). */
  readonly indent?: number;
}

/**
 * Writes a data value as JSON, members in insertion order. Throws a RangeError for a non-finite number, which no
 * parser here produces.
 */
export function stringifyJson(value: DataValue, opts: JsonStringifyOptions = {}): string {
  const indent = opts.indent ?? 2;
  const check = (v: DataValue): void => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('JSON cannot hold a non-finite number');
    if (Array.isArray(v)) v.forEach(check);
    else if (isDataObject(v)) for (const k of Object.keys(v)) check(v[k] as DataValue);
  };
  check(value);
  return indent > 0 ? JSON.stringify(value, null, indent) : JSON.stringify(value);
}
