/**
 * XML with positions (ARCHITECTURE-P3 D21 "Data formats", §7 W1 auto; §11.3 lesson code samples).
 *
 * Pure and dependency-free, exported through `@netforge/engine/pure`. `parseXml` checks well-formedness (XML 1.0:
 * one root, matching tags, quoted and unique attributes, the five predefined entities and numeric character
 * references, comments, CDATA sections, processing instructions and the XML declaration) and reports the first error
 * with its line and column. Document type declarations (`<!DOCTYPE`) are refused: they are not needed for the data a
 * device API exchanges, and refusing them keeps entity expansion out entirely. Namespaces are read as plain
 * attributes by the parser and resolved by the data conversion.
 *
 * `xmlToData` / `dataToXml` convert between an element tree and the shared data model with the RESTCONF XML rules
 * (RFC 7950 §§7.5–7.8, RFC 7951 member names): child elements become members, repeated elements become an array, and
 * a namespace change becomes a `module:` prefix on the member name when the caller can map namespaces to modules (the
 * YANG model does). Without schema hints the conversion guesses leaf types from the text; `automation/yang/model.ts`
 * supplies exact hints for the RESTCONF data.
 */
import {
  DATA_MAX_DEPTH,
  isDataObject,
  setDataMember,
  textPositions,
  type DataObject,
  type DataSyntaxError,
  type DataValue,
  type SourcePos,
  type SourceSpan,
} from './json.js';

/** One attribute as written (namespace declarations included). */
export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
  readonly span: SourceSpan;
}

/** Character data: text (entities decoded, line breaks normalised to LF) or a CDATA section. */
export interface XmlText {
  readonly type: 'text';
  readonly value: string;
  readonly cdata?: boolean;
  readonly span: SourceSpan;
}

export interface XmlElement {
  readonly type: 'element';
  /** The name as written, prefix included (`if:interfaces`). */
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlChild[];
  /** Written `<a/>` rather than `<a></a>` (kept so a conversion can tell an empty container from an empty text). */
  readonly selfClosing: boolean;
  readonly span: SourceSpan;
}

export type XmlChild = XmlElement | XmlText;

export interface XmlDeclaration {
  readonly version: string;
  readonly encoding?: string;
  readonly standalone?: 'yes' | 'no';
}

export interface XmlDocument {
  readonly declaration?: XmlDeclaration;
  readonly root: XmlElement;
}

export type XmlParseResult = { readonly ok: true; readonly document: XmlDocument } | { readonly ok: false; readonly error: DataSyntaxError };

/** Options of `parseXml`. */
export interface XmlParseOptions {
  /**
   * Keep whitespace-only text between child elements (the indentation of a pretty-printed document). Default false:
   * such text is dropped from any element that has an element child; an element holding only whitespace keeps it.
   */
  readonly keepWhitespace?: boolean;
}

class XmlFail extends Error {
  constructor(readonly at: number, message: string) {
    super(message);
  }
}

const NAME_START = /[A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\uD800-\uDBFF]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\uD800-\uDFFF]/;
const XML_NAME = new RegExp(`^${NAME_START.source}${NAME_CHAR.source}*$`);

/** Whether `name` is a well-formed XML name. */
export function isXmlName(name: string): boolean {
  return XML_NAME.test(name);
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Whether a code point may appear in an XML 1.0 document. */
function isXmlChar(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Whether every character of `s` may appear in an XML 1.0 document (no control character, no lone surrogate). */
function isXmlText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i) as number;
    if (!isXmlChar(code)) return false;
    if (code > 0xffff) i++;
  }
  return true;
}

class XmlParser {
  private i = 0;
  private readonly pos: (offset: number) => SourcePos;

  constructor(private readonly t: string, private readonly keepWhitespace: boolean) {
    this.pos = textPositions(t);
    if (t.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  error(e: XmlFail): DataSyntaxError {
    const p = this.pos(e.at);
    return { message: e.message, line: p.line, column: p.column, offset: p.offset };
  }

  private span(start: number, end = this.i): SourceSpan {
    return { start: this.pos(start), end: this.pos(end) };
  }

  private startsWith(s: string): boolean {
    return this.t.startsWith(s, this.i);
  }

  private skipWs(): boolean {
    const from = this.i;
    while (isWs(this.t[this.i])) this.i++;
    return this.i > from;
  }

  parse(): XmlDocument {
    let declaration: XmlDeclaration | undefined;
    if (this.startsWith('<?xml') && isWs(this.t[this.i + 5])) declaration = this.declaration();
    else if (this.startsWith('<?xml?>') || this.startsWith('<?xml ')) throw new XmlFail(this.i, 'The XML declaration needs a version, e.g. <?xml version="1.0"?>.');
    this.misc(false);
    if (this.i >= this.t.length) throw new XmlFail(this.i, 'The document has no root element.');
    if (this.t[this.i] !== '<') throw new XmlFail(this.i, 'Text is not allowed before the root element.');
    const root = this.element(0);
    this.misc(true);
    if (this.i < this.t.length) {
      if (this.t[this.i] === '<') throw new XmlFail(this.i, 'A document has exactly one root element; this is a second one.');
      throw new XmlFail(this.i, 'Text is not allowed after the root element.');
    }
    return declaration === undefined ? { root } : { declaration, root };
  }

  /** Whitespace, comments and processing instructions outside the root. */
  private misc(afterRoot: boolean): void {
    for (;;) {
      this.skipWs();
      if (this.startsWith('<!--')) this.comment();
      else if (this.startsWith('<?')) this.processingInstruction();
      else if (this.startsWith('<!DOCTYPE')) throw new XmlFail(this.i, 'Document type declarations (<!DOCTYPE …>) are not supported.');
      else if (!afterRoot && this.startsWith('<![CDATA[')) throw new XmlFail(this.i, 'A CDATA section must be inside the root element.');
      else return;
    }
  }

  private declaration(): XmlDeclaration {
    const start = this.i;
    this.i += 5;
    const attrs = new Map<string, string>();
    for (;;) {
      const ws = this.skipWs();
      if (this.startsWith('?>')) {
        this.i += 2;
        break;
      }
      if (this.i >= this.t.length) throw new XmlFail(start, 'The XML declaration is never closed: "?>" is missing.');
      if (!ws) throw new XmlFail(this.i, 'Expected a space between the declaration\'s settings.');
      const nameAt = this.i;
      const name = this.name('a declaration setting');
      if (name !== 'version' && name !== 'encoding' && name !== 'standalone') throw new XmlFail(nameAt, `The XML declaration has no setting "${name}".`);
      if (attrs.has(name)) throw new XmlFail(nameAt, `The declaration setting "${name}" appears twice.`);
      this.skipWs();
      if (this.t[this.i] !== '=') throw new XmlFail(this.i, `Expected "=" after "${name}".`);
      this.i++;
      this.skipWs();
      attrs.set(name, this.quotedValue(false));
    }
    const version = attrs.get('version');
    if (version === undefined) throw new XmlFail(start, 'The XML declaration needs a version, e.g. <?xml version="1.0"?>.');
    if (!/^1\.[0-9]+$/.test(version)) throw new XmlFail(start, `Unsupported XML version "${version}".`);
    const standalone = attrs.get('standalone');
    if (standalone !== undefined && standalone !== 'yes' && standalone !== 'no') throw new XmlFail(start, 'standalone must be "yes" or "no".');
    const encoding = attrs.get('encoding');
    return {
      version,
      ...(encoding !== undefined ? { encoding } : {}),
      ...(standalone !== undefined ? { standalone: standalone as 'yes' | 'no' } : {}),
    };
  }

  private comment(): void {
    const start = this.i;
    const end = this.t.indexOf('-->', this.i + 4);
    if (end < 0) throw new XmlFail(start, 'This comment is never closed: "-->" is missing.');
    const body = this.t.slice(this.i + 4, end);
    const dd = body.indexOf('--');
    if (dd >= 0 || body.endsWith('-')) throw new XmlFail(this.i + 4 + (dd >= 0 ? dd : body.length - 1), 'A comment cannot contain "--" or end with "-".');
    this.i = end + 3;
  }

  private processingInstruction(): void {
    const start = this.i;
    this.i += 2;
    const target = this.name('a processing instruction');
    if (target.toLowerCase() === 'xml') throw new XmlFail(start, 'The XML declaration may appear only at the very start of the document.');
    const end = this.t.indexOf('?>', this.i);
    if (end < 0) throw new XmlFail(start, 'This processing instruction is never closed: "?>" is missing.');
    this.i = end + 2;
  }

  private name(what: string): string {
    const start = this.i;
    const c = this.t[this.i];
    if (c === undefined || !NAME_START.test(c)) {
      if (c !== undefined && /[0-9.\-]/.test(c)) throw new XmlFail(this.i, `A name cannot start with "${c}" (${what}).`);
      throw new XmlFail(this.i, `Expected a name (${what}).`);
    }
    this.i++;
    while (this.t[this.i] !== undefined && NAME_CHAR.test(this.t[this.i] as string)) this.i++;
    return this.t.slice(start, this.i);
  }

  /** A quoted attribute value; `normalize` turns tab and line breaks written literally into spaces (XML §3.3.3). */
  private quotedValue(normalize: boolean): string {
    const q = this.t[this.i];
    if (q !== '"' && q !== "'") throw new XmlFail(this.i, 'An attribute value must be in quotes.');
    const open = this.i;
    this.i++;
    let out = '';
    for (;;) {
      const c = this.t[this.i];
      if (c === undefined) throw new XmlFail(open, `This value is never closed: a ${q} is missing.`);
      if (c === q) {
        this.i++;
        return out;
      }
      if (c === '<') throw new XmlFail(this.i, 'An attribute value cannot contain "<"; write it as &lt;.');
      if (c === '&') {
        out += this.reference();
        continue;
      }
      this.checkChar();
      if (c === '\r') {
        if (this.t[this.i + 1] === '\n') this.i++;
        out += normalize ? ' ' : '\n';
      } else out += normalize && (c === '\t' || c === '\n') ? ' ' : c;
      this.i++;
    }
  }

  private checkChar(): void {
    const code = this.t.codePointAt(this.i) as number;
    if (!isXmlChar(code)) throw new XmlFail(this.i, 'This character is not allowed in an XML document.');
  }

  /** An entity or character reference at `i` (the `&`); returns its text. */
  private reference(): string {
    const start = this.i;
    const semi = this.t.indexOf(';', this.i);
    const body = semi < 0 ? '' : this.t.slice(this.i + 1, semi);
    if (semi < 0 || semi - this.i > 12 || body === '') throw new XmlFail(start, 'A "&" must start a reference such as &amp; — write a lone & as &amp;.');
    let text: string;
    if (body.startsWith('#x')) {
      if (!/^#x[0-9A-Fa-f]+$/.test(body)) throw new XmlFail(start, `"&${body};" is not a valid character reference.`);
      text = this.charRef(parseInt(body.slice(2), 16), start);
    } else if (body.startsWith('#')) {
      if (!/^#[0-9]+$/.test(body)) throw new XmlFail(start, `"&${body};" is not a valid character reference.`);
      text = this.charRef(parseInt(body.slice(1), 10), start);
    } else {
      const p = Object.prototype.hasOwnProperty.call(PREDEFINED, body) ? PREDEFINED[body] : undefined;
      if (p === undefined) throw new XmlFail(start, `Unknown entity "&${body};": XML knows only &lt; &gt; &amp; &quot; &apos; and numeric references such as &#160;.`);
      text = p;
    }
    this.i = semi + 1;
    return text;
  }

  private charRef(code: number, at: number): string {
    if (!isXmlChar(code)) throw new XmlFail(at, 'That character reference names a character XML does not allow.');
    return String.fromCodePoint(code);
  }

  private element(depth: number): XmlElement {
    if (depth >= DATA_MAX_DEPTH) throw new XmlFail(this.i, `The document nests more than ${DATA_MAX_DEPTH} levels deep.`);
    const start = this.i;
    this.i++; // '<'
    const name = this.name('an element name');
    const attributes: XmlAttribute[] = [];
    const seen = new Set<string>();
    for (;;) {
      const ws = this.skipWs();
      const c = this.t[this.i];
      if (c === '>' || (c === '/' && this.t[this.i + 1] === '>')) break;
      if (c === undefined) throw new XmlFail(start, `The start tag <${name}> is never closed: ">" is missing.`);
      if (!ws) throw new XmlFail(this.i, 'Expected a space before the next attribute.');
      const attrStart = this.i;
      const attrName = this.name('an attribute name');
      if (seen.has(attrName)) throw new XmlFail(attrStart, `The attribute "${attrName}" appears twice on <${name}>.`);
      seen.add(attrName);
      this.skipWs();
      if (this.t[this.i] !== '=') throw new XmlFail(this.i, `Expected "=" after the attribute "${attrName}".`);
      this.i++;
      this.skipWs();
      const value = this.quotedValue(true);
      attributes.push({ name: attrName, value, span: this.span(attrStart) });
    }
    if (this.t[this.i] === '/') {
      this.i += 2;
      return { type: 'element', name, attributes, children: [], selfClosing: true, span: this.span(start) };
    }
    this.i++; // '>'
    const children: XmlChild[] = [];
    for (;;) {
      if (this.i >= this.t.length) throw new XmlFail(start, `The element <${name}> opened on line ${this.pos(start).line} is never closed.`);
      if (this.startsWith('</')) {
        const closeAt = this.i;
        this.i += 2;
        const endName = this.name('an end tag');
        this.skipWs();
        if (this.t[this.i] !== '>') throw new XmlFail(this.i, `Expected ">" to close the end tag </${endName}>.`);
        this.i++;
        if (endName !== name) throw new XmlFail(closeAt, `The end tag </${endName}> does not match the start tag <${name}> on line ${this.pos(start).line}.`);
        break;
      }
      if (this.startsWith('<!--')) {
        this.comment();
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        const cs = this.i;
        const end = this.t.indexOf(']]>', this.i + 9);
        if (end < 0) throw new XmlFail(cs, 'This CDATA section is never closed: "]]>" is missing.');
        const value = this.t.slice(this.i + 9, end).replace(/\r\n?/g, '\n');
        this.i = end + 3;
        children.push({ type: 'text', value, cdata: true, span: this.span(cs) });
        continue;
      }
      if (this.startsWith('<?')) {
        this.processingInstruction();
        continue;
      }
      if (this.startsWith('<!')) throw new XmlFail(this.i, this.startsWith('<!DOCTYPE') ? 'Document type declarations (<!DOCTYPE …>) are not supported.' : 'Unexpected "<!".');
      if (this.t[this.i] === '<') {
        children.push(this.element(depth + 1));
        continue;
      }
      children.push(this.text());
    }
    const hasElement = children.some((c) => c.type === 'element');
    const kept = this.keepWhitespace || !hasElement ? children : children.filter((c) => c.type === 'element' || c.cdata === true || /[^ \t\n\r]/.test(c.value));
    return { type: 'element', name, attributes, children: kept, selfClosing: false, span: this.span(start) };
  }

  private text(): XmlText {
    const start = this.i;
    let out = '';
    for (;;) {
      const c = this.t[this.i];
      if (c === undefined || c === '<') break;
      if (c === '&') {
        out += this.reference();
        continue;
      }
      if (c === ']' && this.startsWith(']]>')) throw new XmlFail(this.i, 'The text "]]>" is not allowed outside a CDATA section; write it as ]]&gt;.');
      this.checkChar();
      if (c === '\r') {
        if (this.t[this.i + 1] === '\n') this.i++;
        out += '\n';
        this.i++;
        continue;
      }
      const code = this.t.codePointAt(this.i) as number;
      const width = code > 0xffff ? 2 : 1;
      out += this.t.slice(this.i, this.i + width);
      this.i += width;
    }
    return { type: 'text', value: out, span: this.span(start) };
  }
}

/** Parses an XML document (see the file header for what is checked). */
export function parseXml(text: string, opts: XmlParseOptions = {}): XmlParseResult {
  const p = new XmlParser(text, opts.keepWhitespace === true);
  try {
    return { ok: true, document: p.parse() };
  } catch (e) {
    if (e instanceof XmlFail) return { ok: false, error: p.error(e) };
    throw e;
  }
}

// ── writing ──

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

/** Options of `serializeXml`. */
export interface XmlSerializeOptions {
  /** Spaces per level for elements that hold only elements; 0 writes no added whitespace. Default 2. */
  readonly indent?: number;
  /** Write the document's declaration (or `<?xml version="1.0" encoding="UTF-8"?>` for a bare element). Default: only when the document has one. */
  readonly declaration?: boolean;
}

/**
 * Writes a document or an element. Elements holding only elements are indented (so `parseXml` reads the output back
 * to the same tree); text is escaped, CDATA kept as CDATA.
 */
export function serializeXml(node: XmlDocument | XmlElement, opts: XmlSerializeOptions = {}): string {
  const indent = Math.max(0, opts.indent ?? 2);
  const out: string[] = [];
  const el = 'root' in node ? node.root : node;
  const decl = 'root' in node ? node.declaration : undefined;
  if (opts.declaration === true || (opts.declaration === undefined && decl !== undefined)) {
    const d = decl ?? { version: '1.0', encoding: 'UTF-8' };
    let s = `<?xml version="${d.version}"`;
    if (d.encoding !== undefined) s += ` encoding="${d.encoding}"`;
    if (d.standalone !== undefined) s += ` standalone="${d.standalone}"`;
    out.push(`${s}?>`);
  }
  const write = (e: XmlElement, pad: number): string => {
    const attrs = e.attributes.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
    if (e.children.length === 0) return e.selfClosing ? `<${e.name}${attrs}/>` : `<${e.name}${attrs}></${e.name}>`;
    const onlyElements = e.children.every((c) => c.type === 'element');
    if (onlyElements && indent > 0) {
      const inner = ' '.repeat(pad + indent);
      const body = e.children.map((c) => `\n${inner}${write(c as XmlElement, pad + indent)}`).join('');
      return `<${e.name}${attrs}>${body}\n${' '.repeat(pad)}</${e.name}>`;
    }
    const body = e.children
      .map((c) => {
        if (c.type === 'element') return write(c, pad);
        if (c.cdata === true) return `<![CDATA[${c.value.split(']]>').join(']]]]><![CDATA[>')}]]>`;
        return escapeText(c.value);
      })
      .join('');
    return `<${e.name}${attrs}>${body}</${e.name}>`;
  };
  out.push(write(el, 0));
  return out.join('\n');
}

// ── XML ↔ data (RESTCONF XML encoding) ──

/** Schema hints for `xmlToData`; the member path is the list of member names from the root member down. */
export interface XmlToDataOptions {
  /** Whether the member at `path` is a list or leaf-list: an array even when it occurs once. */
  isArray?(path: readonly string[]): boolean;
  /** The value of a leaf from its text. Default: `true`/`false` → boolean, a JSON number → number, else the text. */
  scalar?(path: readonly string[], text: string, selfClosing: boolean): DataValue;
  /** The module of a namespace URI, for RFC 7951 member names; unknown namespaces keep the element's own name. */
  moduleOf?(namespace: string): string | undefined;
}

const JSON_NUMBER_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** The default leaf reading of `xmlToData`: booleans and JSON numbers by their text, an empty `<a/>` as null. */
export function guessXmlScalar(text: string, selfClosing: boolean): DataValue {
  if (text === '') return selfClosing ? null : '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (JSON_NUMBER_TEXT.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n === 0 ? 0 : n;
  }
  return text;
}

/**
 * Converts an element tree to the data model: `{<root member>: <content>}`. Attributes other than namespace
 * declarations are ignored, as RESTCONF data carries none; text beside child elements is ignored.
 */
export function xmlToData(root: XmlElement, opts: XmlToDataOptions = {}): DataObject {
  const convert = (e: XmlElement, scope: ReadonlyMap<string, string>, parentModule: string | undefined, path: readonly string[]): { member: string; module: string | undefined; value: DataValue } => {
    let inner = scope;
    for (const a of e.attributes) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        if (inner === scope) inner = new Map(scope);
        (inner as Map<string, string>).set(a.name === 'xmlns' ? '' : a.name.slice(6), a.value);
      }
    }
    const colon = e.name.indexOf(':');
    const prefix = colon > 0 ? e.name.slice(0, colon) : '';
    const local = colon > 0 ? e.name.slice(colon + 1) : e.name;
    const ns = inner.get(prefix);
    const module = ns !== undefined && opts.moduleOf !== undefined ? opts.moduleOf(ns) : undefined;
    let member: string;
    if (module !== undefined) member = module === parentModule ? local : `${module}:${local}`;
    else member = e.name;
    const here = [...path, member];
    const kids = e.children.filter((c): c is XmlElement => c.type === 'element');
    if (kids.length === 0) {
      const text = e.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
      const value = opts.scalar !== undefined ? opts.scalar(here, text, e.selfClosing) : guessXmlScalar(text, e.selfClosing);
      return { member, module: module ?? parentModule, value };
    }
    const obj: DataObject = {};
    const arrays = new Set<string>();
    for (const k of kids) {
      const r = convert(k, inner, module ?? parentModule, here);
      if (!Object.prototype.hasOwnProperty.call(obj, r.member)) {
        if (opts.isArray?.([...here, r.member]) === true) {
          arrays.add(r.member);
          setDataMember(obj, r.member, [r.value]);
        } else setDataMember(obj, r.member, r.value);
      } else if (arrays.has(r.member)) (obj[r.member] as DataValue[]).push(r.value);
      else {
        arrays.add(r.member);
        setDataMember(obj, r.member, [obj[r.member] as DataValue, r.value]);
      }
    }
    return { member, module: module ?? parentModule, value: obj };
  };
  const r = convert(root, new Map(), undefined, []);
  const out: DataObject = {};
  setDataMember(out, r.member, r.value);
  return out;
}

/** Options of `dataToXml`. */
export interface DataToXmlOptions {
  /** The namespace URI of a module; a member `module:name` becomes `<name xmlns="…">` when this knows the module. */
  namespaceOf?(module: string): string | undefined;
  /** Wrap the value in this root element instead of taking the root from a one-member object. */
  rootName?: string;
}

export type DataToXmlResult = { readonly ok: true; readonly element: XmlElement } | { readonly ok: false; readonly message: string };

const NO_SPAN: SourceSpan = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };

/**
 * Converts data to an element tree with the RESTCONF XML rules (the inverse of `xmlToData`). Without `rootName` the
 * value must be an object with exactly one member, which becomes the root. An array member becomes repeated elements
 * (an empty array writes nothing); `{}` and null become `<a/>`, `""` `<a></a>`. Refused: an array inside an array,
 * a member name that is not an XML name, and text holding a character XML cannot carry.
 */
export function dataToXml(value: DataValue, opts: DataToXmlOptions = {}): DataToXmlResult {
  class Refuse extends Error {}
  const build = (member: string, v: DataValue, parentModule: string | undefined): XmlElement[] => {
    const colon = member.indexOf(':');
    const module = colon > 0 ? member.slice(0, colon) : undefined;
    const ns = module !== undefined && opts.namespaceOf !== undefined ? opts.namespaceOf(module) : undefined;
    const name = ns !== undefined ? member.slice(colon + 1) : member;
    if (!isXmlName(name)) throw new Refuse(`"${member}" is not a valid XML element name.`);
    const effective = ns !== undefined ? module : parentModule;
    const attributes: XmlAttribute[] = ns !== undefined && module !== parentModule ? [{ name: 'xmlns', value: ns, span: NO_SPAN }] : [];
    const one = (x: DataValue): XmlElement => {
      if (Array.isArray(x)) throw new Refuse(`"${member}" holds an array inside an array, which XML cannot express.`);
      if (x === null) return { type: 'element', name, attributes, children: [], selfClosing: true, span: NO_SPAN };
      if (isDataObject(x)) {
        const keys = Object.keys(x);
        const children = keys.flatMap((k) => build(k, x[k] as DataValue, effective));
        return { type: 'element', name, attributes, children, selfClosing: keys.length === 0, span: NO_SPAN };
      }
      const text = typeof x === 'string' ? x : String(x);
      if (!isXmlText(text)) throw new Refuse(`"${member}" holds a character XML cannot carry (a control character or a lone surrogate).`);
      const children: XmlChild[] = text === '' ? [] : [{ type: 'text', value: text, span: NO_SPAN }];
      return { type: 'element', name, attributes, children, selfClosing: false, span: NO_SPAN };
    };
    return Array.isArray(v) ? v.map(one) : [one(v)];
  };
  try {
    if (opts.rootName !== undefined) {
      const els = build(opts.rootName, Array.isArray(value) ? { item: value } : value, undefined);
      return { ok: true, element: els[0] as XmlElement };
    }
    if (!isDataObject(value) || Object.keys(value).length !== 1) {
      return { ok: false, message: 'XML has exactly one root element, so the data must be an object with exactly one member.' };
    }
    const member = Object.keys(value)[0] as string;
    const v = value[member] as DataValue;
    if (Array.isArray(v)) return { ok: false, message: `The root member "${member}" is an array; XML needs a single root element.` };
    return { ok: true, element: build(member, v, undefined)[0] as XmlElement };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, message: e.message };
    throw e;
  }
}
