/**
 * capture/filter/parser.ts — display-filter parser producing `DisplayFilterAst` (contracts/capture.ts).
 *
 * Grammar (precedence: `not` binds tightest, then `and`, then `or`; both binary operators associate left):
 *
 *   filter   := [ or ]                                   (empty text = match everything, ast null)
 *   or       := and { ('||' | 'or') and }
 *   and      := unary { ('&&' | 'and') unary }
 *   unary    := ('!' | 'not') unary | primary
 *   primary  := '(' or ')' | test
 *   test     := FIELD                                    (presence)
 *             | FIELD relop VALUE                        relop: == != < <= > >= eq ne lt le gt ge
 *             | FIELD 'contains' VALUE
 *             | FIELD ['not'] 'in' '{' VALUE { [','] VALUE } '}'
 *
 * Values are checked against the field's type at parse time: numbers (decimal, fractional, 0x hex), booleans
 * (`1 0 true false`), IPv4 / IPv6 with an optional `/len` (only with `== != in`), MACs (`:`, `-` or dotted-quad
 * form), and double-quoted text. A quoted literal is accepted for any type and converted with the same rules.
 * Every rejected construct gets an original message and its 0-based span.
 */
import type { DisplayFieldDef, DisplayFilterAst, DisplayFilterError, DisplayFilterValue } from '../../contracts/capture.js';
import { normalizeMac, parseIpv4 } from '../../contracts/addr.js';
import { formatFilterIpv6, lookupDisplayField, parseFilterIpv6 } from './fields.js';
import { tokenizeDisplayFilter, type DisplayFilterToken } from './lexer.js';

/** Outcome of parsing a display filter: an AST (null for an empty filter) or the first error. */
export type DisplayFilterParseResult = { ok: true; ast: DisplayFilterAst | null } | { ok: false; error: DisplayFilterError };

/** Relational operators of the AST. */
export type DisplayFilterRelOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains';

/** Symbolic and keyword spellings of the relational operators. */
export const DISPLAY_FILTER_RELOPS: Readonly<Record<string, DisplayFilterRelOp>> = Object.freeze({
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  eq: '==',
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
  contains: 'contains',
});

/** Words with a grammatical meaning; they can never be field names. */
export const DISPLAY_FILTER_KEYWORDS: readonly string[] = Object.freeze(['and', 'or', 'not', 'in', 'contains', 'eq', 'ne', 'lt', 'le', 'gt', 'ge']);

class FilterSyntaxError extends Error {
  constructor(readonly info: DisplayFilterError) {
    super(info.message);
  }
}

function fail(message: string, column: number, length: number): never {
  throw new FilterSyntaxError({ message, column, length: Math.max(0, length) });
}

function failAt(tok: DisplayFilterToken, message: string): never {
  return fail(message, tok.start, tok.end - tok.start);
}

/** True when the operator can be used with a field of this type. */
export function displayFilterOpAllowed(type: DisplayFieldDef['type'], op: DisplayFilterRelOp | 'in'): boolean {
  switch (op) {
    case '==':
    case '!=':
    case 'in':
      return type !== 'protocol';
    case 'contains':
      return type === 'string' || type === 'protocol';
    default:
      return type === 'number' || type === 'string' || type === 'ipv4' || type === 'ipv6' || type === 'mac';
  }
}

const NUMBER_RE = /^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)$/;

/** Numeric value of a number literal (`12`, `-3`, `1.5`, `0x1f`), or null. */
export function parseDisplayFilterNumber(text: string): number | null {
  if (!NUMBER_RE.test(text)) return null;
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const v = /^0[xX]/.test(body) ? parseInt(body.slice(2), 16) : Number(body);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

function splitPrefix(text: string): { addr: string; prefix?: string } {
  const slash = text.indexOf('/');
  if (slash < 0) return { addr: text };
  return { addr: text.slice(0, slash), prefix: text.slice(slash + 1) };
}

function parsePrefixLen(p: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(p)) return null;
  const v = Number(p);
  return v <= max ? v : null;
}

/**
 * Convert a literal token to a value of the field's type, or return an error message. `allowPrefix` permits the
 * `/len` suffix on addresses.
 */
function coerce(field: DisplayFieldDef, tok: DisplayFilterToken, allowPrefix: boolean): DisplayFilterValue | string {
  const quoted = tok.kind === 'string';
  const text = tok.value;
  switch (field.type) {
    case 'string':
      if (!quoted) {
        if (lookupDisplayField(text) !== undefined) return 'Comparing one field with another is not supported.';
        return `Text values go in double quotes, e.g. "${text}".`;
      }
      return { type: 'string', value: text };
    case 'protocol':
      if (!quoted) return `'${field.name}' is a protocol: it can only be tested for presence or with contains "text".`;
      return { type: 'string', value: text };
    case 'number': {
      const v = parseDisplayFilterNumber(text);
      if (v === null) return `'${text}' is not a number; ${field.name} holds numbers.`;
      return { type: 'number', value: v };
    }
    case 'bool': {
      const t = text.toLowerCase();
      if (t === '1' || t === 'true') return { type: 'bool', value: true };
      if (t === '0' || t === 'false') return { type: 'bool', value: false };
      return `${field.name} is true or false: compare it with 1, 0, true or false.`;
    }
    case 'ipv4': {
      const { addr, prefix } = splitPrefix(text);
      const v = parseIpv4(addr);
      if (v === null || !/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return `'${text}' is not an IPv4 address; ${field.name} holds IPv4 addresses.`;
      if (prefix === undefined) return { type: 'ipv4', value: addr };
      if (!allowPrefix) return 'A prefix length (/len) can only be used with ==, != and in.';
      const len = parsePrefixLen(prefix, 32);
      if (len === null) return `'/${prefix}' is not an IPv4 prefix length (0 to 32).`;
      return { type: 'ipv4', value: addr, prefixLen: len };
    }
    case 'ipv6': {
      const { addr, prefix } = splitPrefix(text);
      const b = parseFilterIpv6(addr);
      if (b === null) return `'${text}' is not an IPv6 address; ${field.name} holds IPv6 addresses.`;
      const value = formatFilterIpv6(b);
      if (prefix === undefined) return { type: 'ipv6', value };
      if (!allowPrefix) return 'A prefix length (/len) can only be used with ==, != and in.';
      const len = parsePrefixLen(prefix, 128);
      if (len === null) return `'/${prefix}' is not an IPv6 prefix length (0 to 128).`;
      return { type: 'ipv6', value, prefixLen: len };
    }
    case 'mac': {
      const mac = normalizeMac(text);
      if (mac === null) return `'${text}' is not a MAC address; ${field.name} holds MAC addresses.`;
      return { type: 'mac', value: mac };
    }
  }
}

class Parser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly tokens: readonly DisplayFilterToken[],
  ) {}

  private peek(offset = 0): DisplayFilterToken | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): DisplayFilterToken | undefined {
    const t = this.tokens[this.pos];
    if (t !== undefined) this.pos++;
    return t;
  }

  private isWord(tok: DisplayFilterToken | undefined, ...words: string[]): boolean {
    return tok !== undefined && tok.kind === 'word' && words.includes(tok.text);
  }

  private isOp(tok: DisplayFilterToken | undefined, ...ops: string[]): boolean {
    return tok !== undefined && tok.kind === 'op' && ops.includes(tok.text);
  }

  private endFail(message: string): never {
    return fail(message, this.text.length, 0);
  }

  parse(): DisplayFilterAst | null {
    if (this.tokens.length === 0) return null;
    const ast = this.parseOr();
    const rest = this.peek();
    if (rest !== undefined) this.unexpected(rest, 'after');
    return ast;
  }

  /** Error for a token that cannot start or continue here, naming unsupported constructs. */
  private unexpected(tok: DisplayFilterToken, where: 'after' | 'operand'): never {
    this.rejectUnsupported(tok);
    if (tok.kind === 'rparen') failAt(tok, "There is no '(' for this ')'.");
    if (where === 'after') failAt(tok, "Expected '&&', '||' or the end of the filter here.");
    failAt(tok, 'Expected a field or protocol name here.');
  }

  private rejectUnsupported(tok: DisplayFilterToken): void {
    if (tok.kind === 'op') {
      switch (tok.text) {
        case '=':
          failAt(tok, "Use '==' to test for equality.");
          break;
        case '&':
          failAt(tok, "Use '&&' (or 'and') to require both tests.");
          break;
        case '|':
          failAt(tok, "Use '||' (or 'or') to accept either test.");
          break;
        case '~':
          failAt(tok, "Regular-expression matching ('~', 'matches') is not supported.");
          break;
        case '===':
        case '!==':
          failAt(tok, `The '${tok.text}' operator is not supported; use '==' or '!='.`);
          break;
        case '^^':
          failAt(tok, "Exclusive or ('^^', 'xor') is not supported; combine '&&', '||' and '!'.");
          break;
        case '[':
        case ']':
          failAt(tok, "Byte slices ('field[...]') are not supported.");
          break;
        default:
          break;
      }
    }
    if (tok.kind === 'word') {
      if (tok.text === 'matches') failAt(tok, "Regular-expression matching ('~', 'matches') is not supported.");
      if (tok.text === 'xor') failAt(tok, "Exclusive or ('^^', 'xor') is not supported; combine '&&', '||' and '!'.");
    }
  }

  private parseOr(): DisplayFilterAst {
    let left = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (!(this.isOp(t, '||') || this.isWord(t, 'or'))) return left;
      this.next();
      const right = this.parseAnd();
      left = { op: 'or', left, right };
    }
  }

  private parseAnd(): DisplayFilterAst {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!(this.isOp(t, '&&') || this.isWord(t, 'and'))) return left;
      this.next();
      const right = this.parseUnary();
      left = { op: 'and', left, right };
    }
  }

  private parseUnary(): DisplayFilterAst {
    const t = this.peek();
    if (this.isOp(t, '!') || this.isWord(t, 'not')) {
      this.next();
      return { op: 'not', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): DisplayFilterAst {
    const t = this.next();
    if (t === undefined) this.endFail('The filter ends here; a field or protocol name is missing.');
    if (t.kind === 'lparen') {
      if (this.peek() === undefined) this.endFail("The filter ends here; a field or protocol name is missing.");
      if (this.peek()?.kind === 'rparen') failAt(this.peek() as DisplayFilterToken, "Empty parentheses '()' hold no test.");
      const inner = this.parseOr();
      const close = this.next();
      if (close === undefined) failAt(t, "This '(' is never closed.");
      if (close.kind !== 'rparen') {
        this.rejectUnsupported(close);
        failAt(close, "Expected ')' or '&&' / '||' here.");
      }
      return inner;
    }
    if (t.kind !== 'word') this.unexpected(t, 'operand');
    return this.parseTest(t);
  }

  private parseTest(nameTok: DisplayFilterToken): DisplayFilterAst {
    this.rejectUnsupported(nameTok);
    const name = nameTok.text;
    if (DISPLAY_FILTER_KEYWORDS.includes(name)) failAt(nameTok, `'${name}' needs a field or protocol name before it.`);
    const after = this.peek();
    if (after?.kind === 'lparen' && after.start === nameTok.end) {
      failAt(nameTok, `Functions such as '${name}()' are not supported.`);
    }
    const field = lookupDisplayField(name);
    if (field === undefined) {
      if (/^[0-9:-]/.test(name) || name.includes('/')) failAt(nameTok, `A test starts with a field or protocol name, not a value such as '${name}'.`);
      failAt(nameTok, `'${name}' is not a field or protocol that NetScope knows.`);
    }
    const opTok = this.peek();
    if (opTok === undefined) return { op: 'present', field: name };
    this.rejectUnsupported(opTok);
    // `field not in {…}`
    if (this.isWord(opTok, 'not') && this.isWord(this.peek(1), 'in')) {
      this.next();
      const inTok = this.next() as DisplayFilterToken;
      return { op: 'not', expr: this.parseIn(field, inTok) };
    }
    if (this.isWord(opTok, 'in')) {
      this.next();
      return this.parseIn(field, opTok);
    }
    const rel = (opTok.kind === 'op' || opTok.kind === 'word') ? DISPLAY_FILTER_RELOPS[opTok.text] : undefined;
    if (rel === undefined) return { op: 'present', field: name };
    this.next();
    if (!displayFilterOpAllowed(field.type, rel)) failAt(opTok, this.opMessage(field, rel));
    const valTok = this.next();
    if (valTok === undefined) this.endFail(`The filter ends here; '${opTok.text}' needs a value after it.`);
    if (valTok.kind !== 'word' && valTok.kind !== 'string') {
      this.rejectUnsupported(valTok);
      failAt(valTok, `Expected a value after '${opTok.text}'.`);
    }
    if (valTok.kind === 'word' && DISPLAY_FILTER_KEYWORDS.includes(valTok.text)) failAt(valTok, `Expected a value after '${opTok.text}', not '${valTok.text}'.`);
    const allowPrefix = rel === '==' || rel === '!=';
    const value = coerce(field, valTok, allowPrefix);
    if (typeof value === 'string') failAt(valTok, value);
    const follow = this.peek();
    if (follow?.kind === 'lparen' && follow.start === valTok.end && valTok.kind === 'word') {
      failAt(valTok, `Functions such as '${valTok.text}()' are not supported.`);
    }
    return { op: rel, field: name, value };
  }

  private opMessage(field: DisplayFieldDef, op: DisplayFilterRelOp | 'in'): string {
    if (field.type === 'protocol') return `'${field.name}' is a protocol: it can only be tested for presence or with contains "text".`;
    if (op === 'contains') return `'contains' works on text fields and protocols; ${field.name} is not text.`;
    return `${field.name} is true or false; it cannot be ordered with '${op}'.`;
  }

  private parseIn(field: DisplayFieldDef, inTok: DisplayFilterToken): DisplayFilterAst {
    if (!displayFilterOpAllowed(field.type, 'in')) failAt(inTok, this.opMessage(field, 'in'));
    const open = this.next();
    if (open === undefined) this.endFail("The filter ends here; 'in' needs a set such as {80 443}.");
    if (open.kind !== 'lbrace') failAt(open, "Expected '{' to start the set of values after 'in'.");
    const values: DisplayFilterValue[] = [];
    for (;;) {
      const t = this.next();
      if (t === undefined) failAt(open, "This '{' is never closed.");
      if (t.kind === 'rbrace') break;
      if (t.kind === 'comma') {
        if (values.length === 0) failAt(t, 'Expected a value before this comma.');
        continue;
      }
      if (t.kind !== 'word' && t.kind !== 'string') {
        this.rejectUnsupported(t);
        failAt(t, "Expected a value or '}' here.");
      }
      if (t.kind === 'word' && t.text.includes('..')) failAt(t, "Ranges such as '1..9' inside '{ }' are not supported; list each value.");
      const v = coerce(field, t, true);
      if (typeof v === 'string') failAt(t, v);
      values.push(v);
    }
    if (values.length === 0) failAt(open, "The set after 'in' is empty.");
    return { op: 'in', field: field.name, values };
  }
}

/**
 * Parse display-filter text. Empty or blank text yields `ast: null` (every frame matches). Errors carry an
 * original message and a 0-based column with the length of the offending span (0 at the end of the text).
 */
export function parseDisplayFilter(text: string): DisplayFilterParseResult {
  const lexed = tokenizeDisplayFilter(text);
  try {
    if (lexed.error !== undefined) {
      // Report a grammar error that precedes the lexical one first.
      new Parser(text, lexed.tokens).parse();
      return { ok: false, error: lexed.error };
    }
    return { ok: true, ast: new Parser(text, lexed.tokens).parse() };
  } catch (e) {
    if (e instanceof FilterSyntaxError) {
      if (lexed.error !== undefined && e.info.column >= lexed.error.column) return { ok: false, error: lexed.error };
      return { ok: false, error: e.info };
    }
    throw e;
  }
}
