/**
 * capture/filter/lexer.ts — tokenizer for the NetScope display-filter language (contracts/capture.ts).
 *
 * Token kinds:
 *  • `word`   — a maximal run of letters, digits and `_ . : - /`: field names, keywords (`and or not in contains
 *               eq ne lt le gt ge true false`), numbers, IPv4/IPv6 addresses with an optional `/len`, MACs;
 *  • `string` — a double-quoted literal with `\" \\ \n \t \r \xHH` escapes (`value` holds the decoded text);
 *  • `op`     — `== != < <= > >= && || !` plus the recognised-but-unsupported `= & | ~ === !== ^^ [ ]` (the parser
 *               reports them with a message naming the construct);
 *  • `(` `)` `{` `}` `,`.
 * Columns are 0-based offsets into the filter text. The lexer is tolerant: it stops at the first bad character or
 * unterminated string and reports it, returning the tokens read so far (completion works on partial input).
 */
import type { DisplayFilterError } from '../../contracts/capture.js';

/** Kind of a display-filter token. */
export type DisplayFilterTokenKind = 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'comma';

/** One display-filter token with its 0-based span `[start, end)`. */
export interface DisplayFilterToken {
  kind: DisplayFilterTokenKind;
  /** Source text of the token (for strings: including the quotes). */
  text: string;
  /** Decoded text of a string literal; equals `text` for other kinds. */
  value: string;
  start: number;
  end: number;
}

/** Result of tokenizing a display filter. */
export interface DisplayFilterLexResult {
  tokens: DisplayFilterToken[];
  /** First lexical error; `tokens` holds everything before it. */
  error?: DisplayFilterError;
  /** Set when the text ends inside a string literal: the offset of its opening quote. */
  openStringAt?: number;
}

/** True for characters that may appear inside a `word` token. */
export function isDisplayFilterWordChar(ch: string): boolean {
  return /^[A-Za-z0-9_.:\-/]$/.test(ch);
}

const SINGLE: Readonly<Partial<Record<string, DisplayFilterTokenKind>>> = Object.freeze({ '(': 'lparen', ')': 'rparen', '{': 'lbrace', '}': 'rbrace', ',': 'comma' });

const ESCAPES: Readonly<Partial<Record<string, string>>> = Object.freeze({ '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r' });

const OPERATORS: readonly string[] = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '^^', '<', '>', '!', '=', '&', '|', '~', '[', ']'];

/** Tokenize display-filter text. Never throws. */
export function tokenizeDisplayFilter(text: string): DisplayFilterLexResult {
  const tokens: DisplayFilterToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const kind = SINGLE[ch];
    if (kind !== undefined) {
      tokens.push({ kind, text: ch, value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const c = text[i] as string;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          const e = text[i + 1];
          if (e === undefined) {
            i++;
            break;
          }
          if (e === 'x') {
            const hex = text.slice(i + 2, i + 4);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
              return { tokens, error: { message: 'A \\x escape needs two hexadecimal digits.', column: i, length: Math.min(4, n - i) } };
            }
            value += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            continue;
          }
          const m = ESCAPES[e];
          if (m === undefined) {
            return { tokens, error: { message: `Unknown escape '\\${e}' in a text value.`, column: i, length: 2 } };
          }
          value += m;
          i += 2;
          continue;
        }
        value += c;
        i++;
      }
      if (!closed) {
        return { tokens, error: { message: 'This text value is missing its closing quote.', column: start, length: n - start }, openStringAt: start };
      }
      tokens.push({ kind: 'string', text: text.slice(start, i), value, start, end: i });
      continue;
    }
    if (isDisplayFilterWordChar(ch)) {
      const start = i;
      while (i < n && isDisplayFilterWordChar(text[i] as string)) i++;
      const w = text.slice(start, i);
      tokens.push({ kind: 'word', text: w, value: w, start, end: i });
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op !== undefined) {
      tokens.push({ kind: 'op', text: op, value: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    return { tokens, error: { message: `Unexpected character '${ch}'.`, column: i, length: 1 } };
  }
  return { tokens };
}
