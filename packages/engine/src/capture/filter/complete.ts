/**
 * capture/filter/complete.ts — display-filter autocompletion (contracts/capture.ts `DisplayFilterCompletion`).
 *
 * Works on partial text: the tokens before the cursor decide what may come next, and the word (or operator)
 * touching the cursor is the prefix that the items replace (`from`..`to`, 0-based offsets; `to` extends over the
 * rest of a word that continues after the cursor).
 *
 *  • expecting a test: field and protocol names starting with the prefix (only protocols and `frame` when the prefix
 *    is empty), plus `not`;
 *  • after a field: the operators its type allows, then `&&` / `||`;
 *  • after an operator: known values for booleans and enumerated text fields;
 *  • after a complete test: `&&`, `||`, `and`, `or`, and `)` while a parenthesis is open.
 * Items are sorted deterministically (fields by name; operators and keywords in a fixed order), at most
 * DISPLAY_FILTER_COMPLETION_LIMIT.
 */
import type { DisplayFieldDef, DisplayFilterCompletion } from '../../contracts/capture.js';
import { DISPLAY_FIELDS, lookupDisplayField } from './fields.js';
import { isDisplayFilterWordChar, tokenizeDisplayFilter, type DisplayFilterToken } from './lexer.js';
import { DISPLAY_FILTER_RELOPS, displayFilterOpAllowed, type DisplayFilterRelOp } from './parser.js';

/** Maximum number of completion items returned. */
export const DISPLAY_FILTER_COMPLETION_LIMIT = 200;

type Item = DisplayFilterCompletion['items'][number];

const OPERATOR_ITEMS: readonly { label: string; op: DisplayFilterRelOp | 'in'; help: string }[] = [
  { label: '==', op: '==', help: 'Equal: any value of the field matches.' },
  { label: '!=', op: '!=', help: 'Not equal: no value of the field matches.' },
  { label: '<', op: '<', help: 'Less than.' },
  { label: '<=', op: '<=', help: 'Less than or equal.' },
  { label: '>', op: '>', help: 'Greater than.' },
  { label: '>=', op: '>=', help: 'Greater than or equal.' },
  { label: 'contains', op: 'contains', help: 'The text or protocol bytes include the quoted text.' },
  { label: 'in', op: 'in', help: 'Equal to one of a set, e.g. {80 443}.' },
];

const JOIN_ITEMS: readonly Item[] = [
  { label: '&&', kind: 'operator', help: 'Both tests must match.' },
  { label: '||', kind: 'operator', help: 'Either test may match.' },
  { label: 'and', kind: 'keyword', help: 'Both tests must match (same as &&).' },
  { label: 'or', kind: 'keyword', help: 'Either test may match (same as ||).' },
];

const NOT_ITEM: Item = { label: 'not', kind: 'keyword', help: 'Negate the next test (same as !).' };
const CLOSE_ITEM: Item = { label: ')', kind: 'operator', help: 'Close the parenthesis.' };
const CLOSE_SET_ITEM: Item = { label: '}', kind: 'operator', help: 'Close the set of values.' };

/** Suggested values for enumerated text fields (display names; canonical and alias spellings). */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'dhcp.messageType': ['DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM'],
  'dhcp.type': ['DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM'],
  'http.method': ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  'http.request.method': ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  'http.kind': ['request', 'response'],
  'dns.qry.type': ['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'NS', 'SOA'],
  'dot11.frameType': ['mgmt', 'ctrl', 'data'],
  'dot11-mgmt.security': ['open', 'wpa2-psk', 'wpa3-sae', 'wpa2-ent'],
  'frame.direction': ['tx', 'rx', 'unknown'],
});

/** Operators that may still grow into a longer one ('=' to '==', '<' to '<='); complete operators end the prefix. */
const PARTIAL_OPS: readonly string[] = ['=', '&', '|', '<', '>'];

type State =
  | { kind: 'test' }
  | { kind: 'afterField'; field: DisplayFieldDef }
  | { kind: 'value'; field: DisplayFieldDef }
  | { kind: 'inOpen'; field: DisplayFieldDef }
  | { kind: 'setValue'; field: DisplayFieldDef }
  | { kind: 'notIn'; field: DisplayFieldDef }
  | { kind: 'afterTest' }
  | { kind: 'none' };

/** Walk complete tokens and return what may follow them, with the open-parenthesis depth. */
function stateAfter(tokens: readonly DisplayFilterToken[]): { state: State; depth: number } {
  let state: State = { kind: 'test' };
  let depth = 0;
  for (const t of tokens) {
    const word = t.kind === 'word' ? t.text : undefined;
    switch (state.kind) {
      case 'test':
        if (t.kind === 'lparen') {
          depth++;
        } else if (t.kind === 'op' && t.text === '!') {
          // still expecting a test
        } else if (word === 'not') {
          // still expecting a test
        } else if (word !== undefined) {
          const def = lookupDisplayField(word);
          state = def === undefined ? { kind: 'none' } : { kind: 'afterField', field: def };
        } else {
          state = { kind: 'none' };
        }
        break;
      case 'afterField': {
        const rel = t.kind === 'op' || t.kind === 'word' ? DISPLAY_FILTER_RELOPS[t.text] : undefined;
        if (rel !== undefined) state = { kind: 'value', field: state.field };
        else if (word === 'in') state = { kind: 'inOpen', field: state.field };
        else if (word === 'not') state = { kind: 'notIn', field: state.field };
        else state = joinOrClose(t, depth, (d) => (depth = d));
        break;
      }
      case 'notIn':
        state = word === 'in' ? { kind: 'inOpen', field: state.field } : { kind: 'none' };
        break;
      case 'value':
        state = t.kind === 'word' || t.kind === 'string' ? { kind: 'afterTest' } : { kind: 'none' };
        break;
      case 'inOpen':
        state = t.kind === 'lbrace' ? { kind: 'setValue', field: state.field } : { kind: 'none' };
        break;
      case 'setValue':
        if (t.kind === 'rbrace') state = { kind: 'afterTest' };
        else if (t.kind !== 'word' && t.kind !== 'string' && t.kind !== 'comma') state = { kind: 'none' };
        break;
      case 'afterTest':
        state = joinOrClose(t, depth, (d) => (depth = d));
        break;
      case 'none':
        break;
    }
  }
  return { state, depth };
}

function joinOrClose(t: DisplayFilterToken, depth: number, setDepth: (d: number) => void): State {
  if ((t.kind === 'op' && (t.text === '&&' || t.text === '||')) || (t.kind === 'word' && (t.text === 'and' || t.text === 'or'))) return { kind: 'test' };
  if (t.kind === 'rparen' && depth > 0) {
    setDepth(depth - 1);
    return { kind: 'afterTest' };
  }
  return { kind: 'none' };
}

function byLabel(a: Item, b: Item): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function fieldItems(prefix: string): Item[] {
  const out: Item[] = [];
  for (const d of DISPLAY_FIELDS) {
    if (!d.name.startsWith(prefix)) continue;
    if (prefix.length === 0 && d.type !== 'protocol') continue;
    out.push({ label: d.name, kind: 'field', help: d.help });
  }
  out.sort(byLabel);
  if ('not'.startsWith(prefix) && prefix !== 'not') out.push(NOT_ITEM);
  return out;
}

function operatorItems(field: DisplayFieldDef, prefix: string): Item[] {
  const out: Item[] = [];
  for (const o of OPERATOR_ITEMS) {
    if (!displayFilterOpAllowed(field.type, o.op)) continue;
    if (o.label.startsWith(prefix)) out.push({ label: o.label, kind: o.op === 'contains' || o.op === 'in' ? 'keyword' : 'operator', help: o.help });
  }
  return out;
}

function valueItems(field: DisplayFieldDef, prefix: string): Item[] {
  const raw = prefix.startsWith('"') ? prefix.slice(1) : prefix;
  const out: Item[] = [];
  if (field.type === 'bool') {
    for (const [label, help] of [['1', 'True.'], ['0', 'False.'], ['true', 'True.'], ['false', 'False.']] as const) {
      if (label.startsWith(prefix)) out.push({ label, kind: 'value', help });
    }
    return out;
  }
  const values = ENUM_VALUES[field.name];
  if (values !== undefined && field.type === 'string') {
    for (const v of values) {
      if (v.toLowerCase().startsWith(raw.toLowerCase())) out.push({ label: `"${v}"`, kind: 'value', help: `${field.name} value ${v}.` });
    }
  }
  return out;
}

function joinItems(prefix: string, depth: number): Item[] {
  const out = JOIN_ITEMS.filter((i) => i.label.startsWith(prefix));
  if (depth > 0 && ')'.startsWith(prefix)) out.push(CLOSE_ITEM);
  return out;
}

/**
 * Completion items for the display filter `text` with the cursor at `cursor` (0-based, default end of text).
 * Items replace `text.slice(from, to)`.
 */
export function completeDisplayFilter(text: string, cursor: number = text.length): DisplayFilterCompletion {
  const at = Math.max(0, Math.min(cursor, text.length));
  const lexed = tokenizeDisplayFilter(text.slice(0, at));
  const tokens = lexed.tokens;
  let from = at;
  let to = at;
  let prefix = '';
  let context = tokens;
  if (lexed.openStringAt !== undefined) {
    // Typing inside a quoted value: complete enumerated values.
    from = lexed.openStringAt;
    prefix = text.slice(from, at);
    const close = text.indexOf('"', at);
    to = close >= 0 ? close + 1 : at;
  } else if (lexed.error !== undefined) {
    return { from: at, to: at, items: [] };
  } else {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.end === at && (last.kind === 'word' || (last.kind === 'op' && PARTIAL_OPS.includes(last.text)))) {
      from = last.start;
      prefix = last.text;
      context = tokens.slice(0, -1);
      if (last.kind === 'word') {
        let end = at;
        while (end < text.length && isDisplayFilterWordChar(text[end] as string)) end++;
        to = end;
      }
    }
  }
  const { state, depth } = stateAfter(context);
  let items: Item[];
  switch (state.kind) {
    case 'test':
      items = fieldItems(prefix);
      break;
    case 'afterField':
      items = [...operatorItems(state.field, prefix), ...joinItems(prefix, depth)];
      break;
    case 'notIn':
      items = 'in'.startsWith(prefix) ? [{ label: 'in', kind: 'keyword', help: 'Equal to one of a set, e.g. {80 443}.' }] : [];
      break;
    case 'value':
      items = valueItems(state.field, prefix);
      break;
    case 'inOpen':
      items = prefix.length === 0 ? [{ label: '{', kind: 'operator', help: 'Start the set of values.' }] : [];
      break;
    case 'setValue':
      items = [...valueItems(state.field, prefix), ...(prefix.length === 0 ? [CLOSE_SET_ITEM] : [])];
      break;
    case 'afterTest':
      items = joinItems(prefix, depth);
      break;
    case 'none':
      items = [];
      break;
  }
  return { from, to, items: items.slice(0, DISPLAY_FILTER_COMPLETION_LIMIT) };
}
