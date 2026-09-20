/**
 * capture/filter/eval.ts — compile and evaluate display filters over decoded frames.
 *
 * Semantics (contracts/capture.ts):
 *  • `field` alone: the field or protocol occurs in the frame;
 *  • `==`, `<`, `<=`, `>`, `>=`, `contains`, `in`: true when ANY value of the field satisfies the relation (a frame
 *    without the field never matches);
 *  • `!=`: true when NO value of the field equals the literal (documented extension; a frame without the field
 *    matches, exactly like `!(field == value)`);
 *  • addresses with `/len` match every address inside the prefix; IPv4/IPv6/MAC order by their bytes;
 *  • text compares by UTF-16 code units; byte fields (`payload.data`) compare as Latin-1 text of their bytes against
 *    the UTF-8 bytes of the literal; `<protocol> contains "text"` searches that protocol's bytes in the frame.
 *
 * `compileDisplayFilter` parses once and resolves every field accessor and literal up front, so a capture store
 * compiles each filter text once and runs the returned predicate per record.
 */
import type { DisplayFilterAst, DisplayFilterError, DisplayFilterValue } from '../../contracts/capture.js';
import { parseIpv4 } from '../../contracts/addr.js';
import { displayFieldAccessor, parseFilterIpv6, type DisplayFieldAccessor, type DisplayFilterFrame, type DisplayScalar } from './fields.js';
import { parseDisplayFilter } from './parser.js';

/** A predicate over one frame. */
export type DisplayFilterPredicate = (frame: DisplayFilterFrame) => boolean;

/** A compiled display filter: the parsed AST (null = match all) or the parse error, and its predicate. */
export interface CompiledDisplayFilter {
  readonly text: string;
  readonly ast: DisplayFilterAst | null;
  /** Present when the text does not parse; `test` then matches nothing. */
  readonly error?: DisplayFilterError;
  readonly test: DisplayFilterPredicate;
}

/** A literal prepared for fast comparison against one field type. */
type Prepared =
  | { kind: 'number'; n: number }
  | { kind: 'bool'; b: boolean }
  | { kind: 'text'; s: string; latin1: string }
  | { kind: 'bytes'; b: Uint8Array; prefixLen?: number }
  | { kind: 'mac'; s: string };

const encoder = new TextEncoder();

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
}

function ipv4Bytes(text: string): Uint8Array | null {
  const v = parseIpv4(text);
  if (v === null) return null;
  return Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function prepare(v: DisplayFilterValue): Prepared {
  switch (v.type) {
    case 'number':
      return { kind: 'number', n: v.value };
    case 'bool':
      return { kind: 'bool', b: v.value };
    case 'string':
      return { kind: 'text', s: v.value, latin1: latin1(encoder.encode(v.value)) };
    case 'mac':
      return { kind: 'mac', s: v.value.toLowerCase() };
    case 'ipv4': {
      const b = ipv4Bytes(v.value);
      if (b === null) throw new Error(`display filter literal is not an IPv4 address: ${v.value}`);
      return v.prefixLen === undefined ? { kind: 'bytes', b } : { kind: 'bytes', b, prefixLen: v.prefixLen };
    }
    case 'ipv6': {
      const b = parseFilterIpv6(v.value);
      if (b === null) throw new Error(`display filter literal is not an IPv6 address: ${v.value}`);
      return v.prefixLen === undefined ? { kind: 'bytes', b } : { kind: 'bytes', b, prefixLen: v.prefixLen };
    }
  }
}

/** -1 / 0 / 1 comparing two equal-length byte strings, over the first `bits` bits when given. */
function compareBytes(a: Uint8Array, b: Uint8Array, bits?: number): number {
  const total = bits ?? Math.max(a.length, b.length) * 8;
  const whole = Math.floor(total / 8);
  for (let i = 0; i < whole; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const rem = total % 8;
  if (rem > 0) {
    const mask = (0xff << (8 - rem)) & 0xff;
    const x = (a[whole] ?? 0) & mask;
    const y = (b[whole] ?? 0) & mask;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Field value in the comparison domain of a prepared literal, or undefined when it cannot be compared. */
function valueFor(p: Prepared, v: DisplayScalar): number | boolean | string | Uint8Array | undefined {
  switch (p.kind) {
    case 'number':
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : undefined;
    case 'bool':
      return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : undefined;
    case 'text':
      return typeof v === 'string' ? v : v instanceof Uint8Array ? v : typeof v === 'number' ? String(v) : undefined;
    case 'mac':
      return typeof v === 'string' ? v.toLowerCase() : undefined;
    case 'bytes': {
      if (typeof v !== 'string') return undefined;
      const b = p.b.length === 4 ? ipv4Bytes(v) : parseFilterIpv6(v);
      return b ?? undefined;
    }
  }
}

type Rel = '==' | '<' | '<=' | '>' | '>=' | 'contains';

function relate(rel: Rel, p: Prepared, raw: DisplayScalar): boolean {
  const v = valueFor(p, raw);
  if (v === undefined) return false;
  let cmp: number;
  switch (p.kind) {
    case 'number':
      cmp = (v as number) - p.n;
      break;
    case 'bool':
      return rel === '==' && v === p.b;
    case 'mac': {
      const s = v as string;
      cmp = s === p.s ? 0 : s < p.s ? -1 : 1;
      break;
    }
    case 'bytes': {
      const b = v as Uint8Array;
      if (rel === '==') return compareBytes(b, p.b, p.prefixLen) === 0;
      cmp = compareBytes(b, p.b);
      break;
    }
    case 'text': {
      if (v instanceof Uint8Array) {
        if (rel === 'contains') return contains(v, encoder.encode(p.s));
        const s = latin1(v);
        cmp = s === p.latin1 ? 0 : s < p.latin1 ? -1 : 1;
        break;
      }
      const s = v as string;
      if (rel === 'contains') return s.includes(p.s);
      cmp = s === p.s ? 0 : s < p.s ? -1 : 1;
      break;
    }
  }
  switch (rel) {
    case '==':
      return cmp === 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case 'contains':
      return false;
  }
}

function accessorOf(field: string): DisplayFieldAccessor {
  const acc = displayFieldAccessor(field);
  if (acc === undefined) throw new Error(`display filter names an unknown field: ${field}`);
  return acc;
}

/** Build a predicate from an AST (null = match everything). Throws on a field the registry does not know. */
export function compileDisplayFilterAst(ast: DisplayFilterAst | null): DisplayFilterPredicate {
  if (ast === null) return () => true;
  switch (ast.op) {
    case 'and': {
      const l = compileDisplayFilterAst(ast.left);
      const r = compileDisplayFilterAst(ast.right);
      return (f) => l(f) && r(f);
    }
    case 'or': {
      const l = compileDisplayFilterAst(ast.left);
      const r = compileDisplayFilterAst(ast.right);
      return (f) => l(f) || r(f);
    }
    case 'not': {
      const e = compileDisplayFilterAst(ast.expr);
      return (f) => !e(f);
    }
    case 'present': {
      const acc = accessorOf(ast.field);
      return (f) => acc.present(f);
    }
    case 'in': {
      const acc = accessorOf(ast.field);
      const lits = ast.values.map(prepare);
      return (f) => acc.values(f).some((v) => lits.some((p) => relate('==', p, v)));
    }
    case '!=': {
      const acc = accessorOf(ast.field);
      const p = prepare(ast.value);
      return (f) => !acc.values(f).some((v) => relate('==', p, v));
    }
    default: {
      const acc = accessorOf(ast.field);
      const p = prepare(ast.value);
      const rel: Rel = ast.op;
      return (f) => acc.values(f).some((v) => relate(rel, p, v));
    }
  }
}

/** Evaluate an AST against one frame (null = match). Prefer `compileDisplayFilter` when filtering many frames. */
export function evaluateDisplayFilter(ast: DisplayFilterAst | null, frame: DisplayFilterFrame): boolean {
  return compileDisplayFilterAst(ast)(frame);
}

/** Parse and compile display-filter text once. An invalid filter carries `error` and a predicate matching nothing. */
export function compileDisplayFilter(text: string): CompiledDisplayFilter {
  const parsed = parseDisplayFilter(text);
  if (!parsed.ok) return Object.freeze({ text, ast: null, error: parsed.error, test: () => false });
  return Object.freeze({ text, ast: parsed.ast, test: compileDisplayFilterAst(parsed.ast) });
}
