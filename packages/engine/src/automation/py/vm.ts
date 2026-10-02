/**
 * The NF-Py virtual machine (ARCHITECTURE-P3 D21 "[S32] NF-Py", §4.1, §4.2, §7 W2 auto [S32]).
 *
 * A resumable stack machine over the code objects of `compiler.ts`. Pure and deterministic: no clock, no random
 * source, no host I/O of its own and no module-level mutable state (every value lives in one machine). The host (the
 * W5 `script-host` daemon, or a test's fake host) drives it:
 *   const vm = createPyVm(program, { env });           // `lib.ts` `startPyScript` wires the standard library
 *   let s = vm.run({ quantum, clock });                  // at most `quantum` instructions
 *   while (s.state === 'running') s = vm.run(…);         // the host waits 1 ms between slices (`script-slice:<run>`)
 *   if (s.state === 'waiting') { …do s.io…; vm.resume(result); s = vm.run(…) }   // an HTTP request or a sleep
 *   s.state === 'completed' | 'failed'                   // `s.error` holds the traceback of a failure
 * Every slice returns the text the script printed during it. I/O never blocks: a call that needs the network or time
 * (`requests.get`, `time.sleep`) returns a suspension, the machine stops with `state 'waiting'` and the frame that made
 * the call receives the host's answer on `resume`.
 *
 * VALUES. int is a JS number (exact up to 2^53 − 1: a result beyond raises OverflowError, the listed deviation "NF-Py is
 * a subset with 2^53 integers"); float is boxed (`PyFloat`) so `1` and `1.0` stay apart; bool, str and None are JS
 * values; list, tuple, dict (insertion ordered), set (insertion ordered), range, slice, dict views, functions, builtins,
 * types, exceptions, iterators and objects (modules, responses) are classes below. Float text follows Python's repr
 * rule (shortest round-trip digits, exponent below 1e-4 and from 1e16); powers use exact repeated squaring, never
 * `Math.pow`; there is no `random` (§4.1).
 *
 * CAPS (all deterministic; a run that passes one never holds `runToIdle`, rule 19): PY_MAX_STEPS instructions, PY_MAX_
 * REQUESTS HTTP requests and PY_MAX_SLEEP_NS of sleep per run end it at once with a failure no `except` can catch;
 * PY_MAX_CALL_DEPTH nested calls raise RecursionError; a str, list, tuple, dict or set beyond PY_MAX_LENGTH items
 * raises MemoryError; output beyond PY_MAX_OUTPUT_CHARS characters is cut with one note.
 *
 * NATIVE WORK (W2 fix, verified finding 0). The work a builtin does is charged to the same budget as instructions
 * (`PyMachine.charge`): one step per item it copies or iterates (`items`), per comparison it makes (`in`, `index`,
 * `count`, `remove`, `==`/`<` of containers, `min`/`max`, the sort — a merge sort of our own, so the comparisons and
 * their order never depend on the JS engine), and per element `repr`/`str`/`json.dumps` render. A charge counts against
 * PY_MAX_STEPS and against the slice's quantum: a native call is never split, so a slice ends at the first instruction
 * boundary after its quantum is spent (`run` returns 'running' and the host waits its 1 ms). A function a builtin calls
 * back (a sort key, `map`, `filter`) runs on the same quantum. Every str a builtin, `%` or an f-string produces is held
 * to PY_MAX_LENGTH, and the ones that could grow past it (`join`, `replace`, `format`, `%`, `repr`, `json.dumps`,
 * a width) are checked before they are built, so no engine allocation limit is ever reached.
 *
 * NESTING (verified finding 1). `repr`/`str`, `==`/`<`, hashing and `json.dumps` walk a value with an explicit depth
 * counter: past PY_MAX_VALUE_DEPTH nested values they raise a catchable RecursionError, the same in every JS engine and
 * at any caller depth. Anything else the engine throws (it cannot happen within the caps above) ends the run with the
 * fixed MSG_PY_INTERNAL text, never the engine's own message, and never escapes `run` or `resume`.
 *
 * Exceptions follow Python 3: try/except/else/finally, `raise`, bare `raise` in a handler, the builtin hierarchy below,
 * tracebacks "most recent call last" with the source line of each frame.
 */
import type { HttpMethod } from '../../contracts/process.js';
import {
  PY_BINARY_OPS,
  PY_COMPARE_OPS,
  PY_FN_CLOSURE,
  PY_FN_DEFAULTS,
  PY_FORMAT_HAS_SPEC,
  PY_OP,
  PY_UNARY_OPS,
  type PyCode,
  type PyConstant,
  type PyProgram,
} from './compiler.js';

// ── caps ────────────────────────────────────────────────────────────────────

/** Instructions per slice (§4.2: the host arms `script-slice:<run>` 1 ms after each quantum). */
export const PY_QUANTUM = 10_000;
/** Instructions per run. */
export const PY_MAX_STEPS = 5_000_000;
/** Nested Python calls. */
export const PY_MAX_CALL_DEPTH = 100;
/** Characters a run may print. */
export const PY_MAX_OUTPUT_CHARS = 65_536;
/** HTTP requests per run. */
export const PY_MAX_REQUESTS = 100;
/** Total `time.sleep` per run: 300 s of sim time (the traffic cap of D16). */
export const PY_MAX_SLEEP_NS = 300_000_000_000;
/** Items of one str, list, tuple, dict or set. */
export const PY_MAX_LENGTH = 1_000_000;
/**
 * Nested values `repr`, `==`, `<`, hashing and `json.dumps` walk (a fixed bound well inside every JS engine's stack, and
 * above the 256 levels `json.loads` accepts, so any loaded document prints).
 */
export const PY_MAX_VALUE_DEPTH = 500;

// ── I/O between the machine and its host ────────────────────────────────────

/** What a waiting machine asks its host to do. */
export type PyIoRequest =
  | {
      readonly kind: 'http';
      readonly method: HttpMethod;
      readonly url: string;
      readonly headers: readonly (readonly [string, string])[];
      /** UTF-8 text (the host encodes it). */
      readonly body?: string;
      readonly timeoutNs?: number;
    }
  | { readonly kind: 'sleep'; readonly ns: number };

/** The host's answer to a `PyIoRequest`. */
export type PyIoResult =
  | {
      readonly kind: 'http';
      readonly status?: number;
      readonly reason?: string;
      readonly headers?: readonly (readonly [string, string])[];
      /** UTF-8 text. */
      readonly body?: string;
      /** The transport's error code (`timeout`, `refused`, `bad-url`, …) when there is no response. */
      readonly error?: string;
    }
  | { readonly kind: 'sleep' };

/** The time a slice runs at: the device clock (for `time.time()`) and the sim time (for `time.monotonic()`). */
export interface PyClock {
  readonly unixMs: number;
  readonly monotonicNs: number;
}

export type PyRunState = 'running' | 'waiting' | 'completed' | 'failed';

/** Why a run failed: the exception (or cap) and its traceback. */
export interface PyFailure {
  /** The exception class (`KeyError`, `requests.exceptions.ConnectionError`, `SyntaxError`), or `LimitExceeded` for a cap. */
  readonly type: string;
  readonly message: string;
  /** The full text, Python style. */
  readonly traceback: string;
  /** Its last line (`KeyError: 'name'`): the `script-runs` row's `error`. */
  readonly last: string;
  /** Line of the innermost frame, when known. */
  readonly line?: number;
}

/** What one `run` did. */
export interface PyRunSlice {
  readonly state: PyRunState;
  /** Text printed during this slice. */
  readonly output: string;
  /** Instructions executed during this slice. */
  readonly steps: number;
  /** `state 'waiting'`: what to do before `resume`. */
  readonly io?: PyIoRequest;
  /** `state 'failed'`. */
  readonly error?: PyFailure;
}

export interface PyRunOptions {
  /** Instructions for this slice (default PY_QUANTUM). */
  readonly quantum?: number;
  readonly clock?: PyClock;
}

/** Counters of a run (the script host's StateView and `script-runs.requests`). */
export interface PyStats {
  readonly steps: number;
  readonly requests: number;
  readonly sleptNs: number;
  readonly outputChars: number;
}

export interface PyVm {
  readonly state: PyRunState;
  run(opts?: PyRunOptions): PyRunSlice;
  /** Answer the pending I/O of a waiting machine; the next `run` continues the script. */
  resume(result: PyIoResult): void;
  stats(): PyStats;
}

// ── values ──────────────────────────────────────────────────────────────────

export class PyFloat {
  constructor(readonly v: number) {}
}

export class PyListValue {
  constructor(public items: PyValue[]) {}
}

export class PyTupleValue {
  constructor(readonly items: readonly PyValue[]) {}
}

/** dict: insertion ordered; `caseless` folds str keys to lower case (an HTTP header dict). */
export class PyDictValue {
  readonly entries = new Map<string, [PyValue, PyValue]>();
  constructor(readonly caseless = false) {}
}

export class PySetValue {
  readonly entries = new Map<string, PyValue>();
}

export class PyRange {
  constructor(readonly start: number, readonly stop: number, readonly step: number) {}
  get length(): number {
    const n = this.step > 0 ? Math.ceil((this.stop - this.start) / this.step) : Math.ceil((this.start - this.stop) / -this.step);
    return Math.max(0, n);
  }
  at(i: number): number {
    return this.start + i * this.step;
  }
}

export class PySliceValue {
  constructor(readonly start: PyValue, readonly stop: PyValue, readonly step: PyValue) {}
}

export class PyDictView {
  constructor(readonly dict: PyDictValue, readonly kind: 'keys' | 'values' | 'items') {}
}

export class PyCell {
  constructor(public value: PyValue | undefined) {}
}

export class PyFunction {
  constructor(
    readonly name: string,
    readonly code: PyCode,
    readonly globals: Map<string, PyValue>,
    readonly defaults: readonly PyValue[],
    readonly closure: readonly PyCell[],
    readonly id: number,
  ) {}
}

export type PyKwargs = ReadonlyMap<string, PyValue>;
/** A function written in TypeScript. `self` is set for a bound method. */
export type PyNative = (vm: PyMachine, args: readonly PyValue[], kw: PyKwargs | undefined, self: PyValue | undefined) => PyValue | PySuspend;

export class PyBuiltin {
  constructor(readonly name: string, readonly fn: PyNative, readonly id: number, readonly self?: PyValue) {}
}

/** A class: the builtin types and the exception classes. `module` qualifies the name in tracebacks. */
export class PyType {
  constructor(readonly name: string, readonly base?: PyType, readonly module = 'builtins') {}
}

export interface PyTracebackEntry {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly frame: number;
}

export class PyException {
  readonly attrs = new Map<string, PyValue>();
  readonly traceback: PyTracebackEntry[] = [];
  constructor(readonly type: PyType, readonly args: readonly PyValue[]) {}
}

/** A module or a library object (a response): a type and attributes. */
export class PyObject {
  constructor(readonly type: PyType, readonly attrs: Map<string, PyValue>, readonly id: number) {}
}

/** An iterator: `next` returns undefined when exhausted. */
export class PyIterator {
  constructor(readonly next: () => PyValue | undefined) {}
}

/** A native call that needs the host: the request and how the answer becomes the call's value. */
export class PySuspend {
  constructor(readonly io: PyIoRequest, readonly resume: (r: PyIoResult) => PyValue) {}
}

export type PyValue =
  | null
  | boolean
  | number
  | string
  | PyFloat
  | PyListValue
  | PyTupleValue
  | PyDictValue
  | PySetValue
  | PyRange
  | PySliceValue
  | PyDictView
  | PyFunction
  | PyBuiltin
  | PyType
  | PyException
  | PyObject
  | PyIterator;

// ── types ───────────────────────────────────────────────────────────────────

const tp = (name: string, base?: PyType, module?: string): PyType => Object.freeze(new PyType(name, base, module));

export const PY_OBJECT = tp('object');
export const PY_INT = tp('int', PY_OBJECT);
export const PY_BOOL = tp('bool', PY_INT);
export const PY_FLOAT_T = tp('float', PY_OBJECT);
export const PY_STR = tp('str', PY_OBJECT);
export const PY_LIST_T = tp('list', PY_OBJECT);
export const PY_TUPLE_T = tp('tuple', PY_OBJECT);
export const PY_DICT_T = tp('dict', PY_OBJECT);
export const PY_SET_T = tp('set', PY_OBJECT);
export const PY_RANGE_T = tp('range', PY_OBJECT);
export const PY_SLICE_T = tp('slice', PY_OBJECT);
export const PY_NONE_T = tp('NoneType', PY_OBJECT);
export const PY_FUNCTION_T = tp('function', PY_OBJECT);
export const PY_BUILTIN_T = tp('builtin_function_or_method', PY_OBJECT);
export const PY_TYPE_T = tp('type', PY_OBJECT);
export const PY_MODULE_T = tp('module', PY_OBJECT);
export const PY_ITERATOR_T = tp('iterator', PY_OBJECT);
export const PY_DICT_KEYS_T = tp('dict_keys', PY_OBJECT);
export const PY_DICT_VALUES_T = tp('dict_values', PY_OBJECT);
export const PY_DICT_ITEMS_T = tp('dict_items', PY_OBJECT);

const BaseException = tp('BaseException', PY_OBJECT);
const Exception = tp('Exception', BaseException);
const ArithmeticError = tp('ArithmeticError', Exception);
const LookupError = tp('LookupError', Exception);
const OSError = tp('OSError', Exception);
const RuntimeError = tp('RuntimeError', Exception);
const NameError = tp('NameError', Exception);
const ValueError = tp('ValueError', Exception);
const ImportError = tp('ImportError', Exception);

/** The builtin exception classes (frozen data, shared by every machine). */
export const PY_EXC = Object.freeze({
  BaseException,
  SystemExit: tp('SystemExit', BaseException),
  KeyboardInterrupt: tp('KeyboardInterrupt', BaseException),
  Exception,
  ArithmeticError,
  ZeroDivisionError: tp('ZeroDivisionError', ArithmeticError),
  OverflowError: tp('OverflowError', ArithmeticError),
  LookupError,
  KeyError: tp('KeyError', LookupError),
  IndexError: tp('IndexError', LookupError),
  AssertionError: tp('AssertionError', Exception),
  AttributeError: tp('AttributeError', Exception),
  EOFError: tp('EOFError', Exception),
  ImportError,
  ModuleNotFoundError: tp('ModuleNotFoundError', ImportError),
  MemoryError: tp('MemoryError', Exception),
  NameError,
  UnboundLocalError: tp('UnboundLocalError', NameError),
  OSError,
  ConnectionError: tp('ConnectionError', OSError),
  TimeoutError: tp('TimeoutError', OSError),
  RuntimeError,
  NotImplementedError: tp('NotImplementedError', RuntimeError),
  RecursionError: tp('RecursionError', RuntimeError),
  StopIteration: tp('StopIteration', Exception),
  TypeError: tp('TypeError', Exception),
  ValueError,
  UnicodeError: tp('UnicodeError', ValueError),
});

/** Whether `t` is `of` or derives from it. */
export function pyIsSubtype(t: PyType, of: PyType): boolean {
  for (let c: PyType | undefined = t; c !== undefined; c = c.base) if (c === of) return true;
  return false;
}

/** The name a traceback shows: qualified unless the class is a builtin. */
export function pyQualifiedName(t: PyType): string {
  return t.module === 'builtins' ? t.name : `${t.module}.${t.name}`;
}

// ── errors raised by native code ────────────────────────────────────────────

/** A Python exception thrown through TypeScript code; the machine turns it into a raise in the current frame. */
export class PyError extends Error {
  constructor(readonly exc: PyException) {
    super(exc.type.name);
  }
}

/** A cap was passed: the run ends at once, no handler runs. */
export class PyLimitExceeded extends Error {}

export function pyException(type: PyType, message?: string): PyException {
  return new PyException(type, message === undefined ? [] : [message]);
}

/** A PyError to `throw` from native code. */
export function pyError(type: PyType, message?: string): PyError {
  return new PyError(pyException(type, message));
}

// ── the machine interface native code uses ─────────────────────────────────

export interface PyMachine {
  /** Call any callable synchronously (a nested run; I/O inside it raises RuntimeError). */
  call(fn: PyValue, args: readonly PyValue[], kw?: PyKwargs): PyValue;
  getattr(obj: PyValue, name: string): PyValue;
  iterate(v: PyValue): PyIterator;
  /** All items of an iterable. */
  items(v: PyValue): PyValue[];
  write(text: string): void;
  native(name: string, fn: PyNative, self?: PyValue): PyBuiltin;
  object(type: PyType, attrs: Iterable<readonly [string, PyValue]>): PyObject;
  importModule(name: string): PyObject;
  /** Count one HTTP request against PY_MAX_REQUESTS (ends the run past it). */
  noteRequest(): void;
  /** Count sleep time against PY_MAX_SLEEP_NS (ends the run past it). */
  noteSleep(ns: number): void;
  /**
   * Charge `n` steps of native work (items copied or iterated, comparisons, rendered elements) against PY_MAX_STEPS
   * (ends the run past it) and against the current slice's quantum (file header, "NATIVE WORK").
   */
  charge(n: number): void;
  readonly clock: PyClock;
  readonly argv: readonly string[];
}

/** What a native helper charges its work to (a machine; absent where no run is charged, e.g. a traceback's text). */
export type PyMeter = Pick<PyMachine, 'charge'>;

/** What a machine needs from its library (`lib.ts`): the builtins namespace and the importable modules. */
export interface PyEnvironment {
  builtins(vm: PyMachine): Map<string, PyValue>;
  /** A fresh module object, or undefined when no module has that name. */
  module(vm: PyMachine, name: string): PyObject | undefined;
}

export interface PyVmOptions {
  readonly env: PyEnvironment;
  /** `sys.argv` (the script's file name first, as Python sets it). */
  readonly argv?: readonly string[];
}

// ── numbers ─────────────────────────────────────────────────────────────────

const typeError = (m: string): PyError => pyError(PY_EXC.TypeError, m);
const valueError = (m: string): PyError => pyError(PY_EXC.ValueError, m);

export const MSG_INT_OVERFLOW = 'the result is too large: NF-Py whole numbers stop at 2^53 - 1 (9007199254740991)';

/** An exact int result, or OverflowError; -0 becomes 0. */
export function pyCheckInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw pyError(PY_EXC.OverflowError, MSG_INT_OVERFLOW);
  return n === 0 ? 0 : n;
}

const isIntLike = (v: PyValue): v is number | boolean => typeof v === 'number' || typeof v === 'boolean';
const intOf = (v: number | boolean): number => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const isNumber = (v: PyValue): v is number | boolean | PyFloat => isIntLike(v) || v instanceof PyFloat;
const numOf = (v: number | boolean | PyFloat): number => (v instanceof PyFloat ? v.v : intOf(v));

export const MSG_PY_LENGTH = `NF-Py values hold at most ${PY_MAX_LENGTH} items`;

function checkLength(n: number): void {
  if (n > PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
}

/**
 * The UTF-16 bound a str under construction may reach: a str of at most PY_MAX_LENGTH code points has at most twice as
 * many units, so text past this bound is past the cap for sure (checked before the text is built).
 */
const MAX_TEXT_UNITS = 2 * PY_MAX_LENGTH;

/** A str a builtin produced: MemoryError past PY_MAX_LENGTH code points (the cap of the file header). */
export function pyCheckStr(s: string): string {
  if (s.length > PY_MAX_LENGTH && pyLen(s) > PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
  return s;
}

/** MemoryError when text about to be built would have more than MAX_TEXT_UNITS UTF-16 units. */
function checkTextUnits(units: number): void {
  if (units > MAX_TEXT_UNITS) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
}

export const MSG_PY_DEPTH_REPR = 'maximum recursion depth exceeded while getting the repr of an object';
export const MSG_PY_DEPTH_COMPARE = 'maximum recursion depth exceeded in comparison';
export const MSG_PY_DEPTH_HASH = 'maximum recursion depth exceeded while hashing a value';
export const MSG_PY_DEPTH_JSON = 'maximum recursion depth exceeded while encoding a JSON object';

/** RecursionError once a value walk is PY_MAX_VALUE_DEPTH levels deep (file header, "NESTING"). */
function checkDepth(depth: number, message: string): void {
  if (depth >= PY_MAX_VALUE_DEPTH) throw pyError(PY_EXC.RecursionError, message);
}

/** Python's floor division of two ints. */
function floorDiv(a: number, b: number): number {
  if (b === 0) throw pyError(PY_EXC.ZeroDivisionError, 'integer division or modulo by zero');
  const r = pyMod(a, b);
  return pyCheckInt((a - r) / b);
}

/** Python's modulo (the sign of the divisor). */
function pyMod(a: number, b: number): number {
  let r = a % b;
  if (r !== 0 && r < 0 !== b < 0) r += b;
  return r === 0 ? 0 : r;
}

/** Exact int power by repeated squaring (no Math.pow). */
function intPow(base: number, exp: number): number {
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e % 2 === 1) result = pyCheckInt(result * b);
    e = Math.floor(e / 2);
    if (e > 0) b = Math.abs(b) <= 1 ? b * b : pyCheckInt(b * b);
  }
  return result;
}

/** Float power with a whole exponent, by repeated squaring (deterministic); `** 0.5` is a square root. */
function floatPow(base: number, exp: number): number {
  if (exp === 0.5) {
    if (base < 0) throw valueError('NF-Py has no complex numbers: the square root of a negative number is not defined');
    return Math.sqrt(base);
  }
  if (!Number.isInteger(exp)) throw valueError('NF-Py raises numbers to whole powers only (and ** 0.5 for a square root)');
  let result = 1;
  let b = base;
  let e = Math.abs(exp);
  while (e > 0) {
    if (e % 2 === 1) result *= b;
    e = Math.floor(e / 2);
    if (e > 0) b *= b;
  }
  if (exp < 0) {
    if (result === 0) throw pyError(PY_EXC.ZeroDivisionError, '0.0 cannot be raised to a negative power');
    return 1 / result;
  }
  return result;
}

const TWO32 = 4294967296;

/** Python's bitwise ops on ints of up to 53 bits (two's complement with infinite sign). */
function bitOp(op: '&' | '|' | '^', a: number, b: number): number {
  const ah = Math.floor(a / TWO32);
  const bh = Math.floor(b / TWO32);
  const al = a - ah * TWO32;
  const bl = b - bh * TWO32;
  const lo = (op === '&' ? al & bl : op === '|' ? al | bl : al ^ bl) >>> 0;
  const hi = op === '&' ? ah & bh : op === '|' ? ah | bh : ah ^ bh;
  return pyCheckInt(hi * TWO32 + lo);
}

function shift(a: number, n: number, left: boolean): number {
  if (n < 0) throw valueError('negative shift count');
  let r = a;
  if (left) {
    for (let i = 0; i < n; i++) {
      r = pyCheckInt(r * 2);
      if (r === 0) break;
    }
    return r;
  }
  for (let i = 0; i < n && r !== 0 && r !== -1; i++) r = Math.floor(r / 2);
  return r;
}

/** Python's repr of a float: shortest round-trip digits, fixed from 1e-4 to below 1e16, else an exponent. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, e] = Math.abs(x).toExponential().split('e') as [string, string];
  const ev = Number(e);
  const digits = mant.replace('.', '');
  const sign = x < 0 ? '-' : '';
  if (ev >= -4 && ev < 16) {
    if (ev >= 0) {
      const int = digits.slice(0, ev + 1).padEnd(ev + 1, '0');
      const frac = digits.slice(ev + 1);
      return `${sign}${int}.${frac === '' ? '0' : frac}`;
    }
    return `${sign}0.${'0'.repeat(-ev - 1)}${digits}`;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${m}e${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
}

/** Python's round-half-to-even of a float to `n` decimals (the decimal value of the binary float decides). */
export function pyRoundFloat(x: number, n: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  if (n < 0) {
    // past 10^308 every finite float rounds to a signed zero (and the loop stays bounded whatever `n` is)
    if (-n > 308) return x * 0;
    let m = 1;
    for (let i = 0; i < -n; i++) m *= 10;
    return pyRoundFloat(x / m, 0) * m;
  }
  const digits = Math.min(n, 80);
  const ax = Math.abs(x);
  const exact = ax.toFixed(Math.min(100, digits + 25));
  const dot = exact.indexOf('.');
  const next = exact[dot + 1 + digits];
  const rest = exact.slice(dot + 2 + digits);
  let r = Number(ax.toFixed(digits));
  if (next === '5' && /^0*$/.test(rest)) {
    const kept = exact.slice(0, dot + 1 + digits).replace(/\.$/, '');
    const last = kept.replace('.', '').slice(-1);
    if (Number(last) % 2 === 0) r = Number(kept);
  }
  return x < 0 ? -r : r;
}

// ── text ────────────────────────────────────────────────────────────────────

/** Python's repr of a str: single quotes unless the text holds ' and no ". */
export function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += `\\${q}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + q;
}

/** The class of a value. */
export function pyTypeOf(v: PyValue): PyType {
  if (v === null) return PY_NONE_T;
  if (typeof v === 'boolean') return PY_BOOL;
  if (typeof v === 'number') return PY_INT;
  if (typeof v === 'string') return PY_STR;
  if (v instanceof PyFloat) return PY_FLOAT_T;
  if (v instanceof PyListValue) return PY_LIST_T;
  if (v instanceof PyTupleValue) return PY_TUPLE_T;
  if (v instanceof PyDictValue) return PY_DICT_T;
  if (v instanceof PySetValue) return PY_SET_T;
  if (v instanceof PyRange) return PY_RANGE_T;
  if (v instanceof PySliceValue) return PY_SLICE_T;
  if (v instanceof PyDictView) return v.kind === 'keys' ? PY_DICT_KEYS_T : v.kind === 'values' ? PY_DICT_VALUES_T : PY_DICT_ITEMS_T;
  if (v instanceof PyFunction) return PY_FUNCTION_T;
  if (v instanceof PyBuiltin) return PY_BUILTIN_T;
  if (v instanceof PyType) return PY_TYPE_T;
  if (v instanceof PyException) return v.type;
  if (v instanceof PyObject) return v.type;
  return PY_ITERATOR_T;
}

export const pyTypeName = (v: PyValue): string => pyTypeOf(v).name;

/** Python's truth value. */
export function pyTruthy(v: PyValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PyFloat) return v.v !== 0;
  if (v instanceof PyListValue || v instanceof PyTupleValue) return v.items.length > 0;
  if (v instanceof PyDictValue || v instanceof PySetValue) return v.entries.size > 0;
  if (v instanceof PyRange) return v.length > 0;
  if (v instanceof PyDictView) return v.dict.entries.size > 0;
  return true;
}

/** `str(e)` of an exception. */
export function pyExceptionText(e: PyException): string {
  if (e.args.length === 0) return '';
  if (e.args.length === 1) return e.type === PY_EXC.KeyError || pyIsSubtype(e.type, PY_EXC.KeyError) ? pyRepr(e.args[0] as PyValue) : pyStr(e.args[0] as PyValue);
  return pyRepr(new PyTupleValue(e.args));
}

/** The last traceback line: `KeyError: 'x'`, or the class alone when the text is empty. */
export function pyExceptionLine(e: PyException): string {
  const text = pyExceptionText(e);
  return text === '' ? pyQualifiedName(e.type) : `${pyQualifiedName(e.type)}: ${text}`;
}

/** `str(v)`; `meter` (the running machine) is charged one step per element a container's text renders. */
export function pyStr(v: PyValue, meter?: PyMeter): string {
  if (typeof v === 'string') return v;
  if (v instanceof PyException) return pyExceptionText(v);
  return pyRepr(v, meter);
}

/** One `repr` walk: the containers on the current path (cycles print `[...]`), its depth and its meter. */
interface ReprWalk {
  readonly seen: Set<unknown>;
  readonly meter: PyMeter | undefined;
  depth: number;
}

/**
 * `repr(v)`, held to PY_MAX_LENGTH code points (MemoryError) and PY_MAX_VALUE_DEPTH nested values (RecursionError),
 * both checked while the text is built (file header, "NATIVE WORK", "NESTING").
 */
export function pyRepr(v: PyValue, meter?: PyMeter): string {
  return pyCheckStr(reprOf(v, { seen: new Set(), meter, depth: 0 }));
}

/** The texts of `items` joined by `sep`, refused before the joined text would pass MAX_TEXT_UNITS. */
function joinTexts<T>(items: Iterable<T>, render: (x: T) => string, sep: string, w: ReprWalk): string {
  const parts: string[] = [];
  let units = 0;
  for (const x of items) {
    const t = render(x);
    units += t.length + (parts.length > 0 ? sep.length : 0);
    checkTextUnits(units);
    parts.push(t);
  }
  w.meter?.charge(parts.length);
  return parts.join(sep);
}

function reprOf(v: PyValue, w: ReprWalk): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyStrRepr(v);
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (v instanceof PyRange) return v.step === 1 ? `range(${v.start}, ${v.stop})` : `range(${v.start}, ${v.stop}, ${v.step})`;
  if (v instanceof PyFunction) return `<function ${v.name}>`;
  if (v instanceof PyBuiltin) return v.self !== undefined ? `<built-in method ${v.name} of ${pyTypeName(v.self)} object>` : `<built-in function ${v.name}>`;
  if (v instanceof PyType) return `<class '${pyQualifiedName(v)}'>`;
  if (v instanceof PyObject) {
    if (v.type === PY_MODULE_T) return `<module '${pyStr(v.attrs.get('__name__') ?? '?')}'>`;
    const r = v.attrs.get('__repr__');
    if (typeof r === 'string') return r;
    return `<${v.type.name} object>`;
  }
  if (v instanceof PyIterator) return '<iterator object>';
  // a value that holds other values: one level deeper
  const container = v instanceof PyListValue || v instanceof PyTupleValue || v instanceof PyDictValue || v instanceof PySetValue;
  if (container && w.seen.has(v)) return v instanceof PyListValue ? '[...]' : v instanceof PyDictValue ? '{...}' : '(...)';
  checkDepth(w.depth, MSG_PY_DEPTH_REPR);
  const nested = (x: PyValue): string => reprOf(x, w);
  if (container) w.seen.add(v);
  w.depth++;
  try {
    if (v instanceof PyListValue) return `[${joinTexts(v.items, nested, ', ', w)}]`;
    if (v instanceof PyTupleValue) return v.items.length === 1 ? `(${nested(v.items[0] as PyValue)},)` : `(${joinTexts(v.items, nested, ', ', w)})`;
    if (v instanceof PyDictValue) return `{${joinTexts(v.entries.values(), ([k, x]) => `${nested(k)}: ${nested(x)}`, ', ', w)}}`;
    if (v instanceof PySetValue) return v.entries.size === 0 ? 'set()' : `{${joinTexts(v.entries.values(), nested, ', ', w)}}`;
    if (v instanceof PySliceValue) return `slice(${nested(v.start)}, ${nested(v.stop)}, ${nested(v.step)})`;
    if (v instanceof PyDictView) {
      const entries = v.dict.entries.values();
      const text =
        v.kind === 'keys'
          ? joinTexts(entries, ([k]) => nested(k), ', ', w)
          : v.kind === 'values'
            ? joinTexts(entries, ([, x]) => nested(x), ', ', w)
            : joinTexts(entries, ([k, x]) => nested(new PyTupleValue([k, x])), ', ', w);
      return `dict_${v.kind}([${text}])`;
    }
    return `${v.type.name}(${joinTexts(v.args, nested, ', ', w)})`;
  } finally {
    w.depth--;
    if (container) w.seen.delete(v);
  }
}

// ── identity, equality, order, hashing ─────────────────────────────────────

/** Python `==`; `meter` (the running machine) is charged one step per element pair two containers compare. */
export function pyEq(a: PyValue, b: PyValue, meter?: PyMeter): boolean {
  return eqOf(a, b, meter, 0);
}

function eqOf(a: PyValue, b: PyValue, meter: PyMeter | undefined, depth: number): boolean {
  if (a === b) return true;
  if (isNumber(a) && isNumber(b)) return numOf(a) === numOf(b);
  if (typeof a === 'string' || typeof b === 'string') return false;
  if ((a instanceof PyListValue && b instanceof PyListValue) || (a instanceof PyTupleValue && b instanceof PyTupleValue)) {
    if (a.items.length !== b.items.length) return false;
    checkDepth(depth, MSG_PY_DEPTH_COMPARE);
    let i = 0;
    try {
      for (; i < a.items.length; i++) if (!eqOf(a.items[i] as PyValue, b.items[i] as PyValue, meter, depth + 1)) return false;
      return true;
    } finally {
      meter?.charge(Math.min(i + 1, a.items.length));
    }
  }
  if (a instanceof PyDictValue && b instanceof PyDictValue) {
    if (a.entries.size !== b.entries.size) return false;
    checkDepth(depth, MSG_PY_DEPTH_COMPARE);
    let n = 0;
    try {
      for (const [k, [, v]] of a.entries) {
        n++;
        const other = b.entries.get(k);
        if (other === undefined || !eqOf(v, other[1], meter, depth + 1)) return false;
      }
      return true;
    } finally {
      meter?.charge(n);
    }
  }
  if (a instanceof PySetValue && b instanceof PySetValue) {
    if (a.entries.size !== b.entries.size) return false;
    meter?.charge(a.entries.size);
    for (const k of a.entries.keys()) if (!b.entries.has(k)) return false;
    return true;
  }
  if (a instanceof PyRange && b instanceof PyRange) return a.length === b.length && (a.length === 0 || (a.start === b.start && (a.length === 1 || a.step === b.step)));
  return false;
}

/** The dict/set key of a hashable value (self-delimiting text; 1, 1.0 and True share one). */
export function pyKey(v: PyValue, caseless = false): string {
  return keyOf(v, caseless, 0);
}

function keyOf(v: PyValue, caseless: boolean, depth: number): string {
  if (v === null) return 'N';
  if (typeof v === 'boolean') return v ? 'n1;' : 'n0;';
  if (typeof v === 'number') return `n${v};`;
  if (v instanceof PyFloat) return Number.isNaN(v.v) ? 'fnan;' : `n${v.v};`;
  if (typeof v === 'string') {
    const s = caseless ? v.toLowerCase() : v;
    return `s${s.length}:${s}`;
  }
  if (v instanceof PyTupleValue) {
    checkDepth(depth, MSG_PY_DEPTH_HASH);
    return `t${v.items.length}:${v.items.map((x) => keyOf(x, false, depth + 1)).join('')}`;
  }
  if (v instanceof PyFunction) return `o${v.id};`;
  if (v instanceof PyBuiltin) return `o${v.id};`;
  if (v instanceof PyType) return `T${pyQualifiedName(v)};`;
  if (v instanceof PyObject) return `o${v.id};`;
  throw typeError(`unhashable type: '${pyTypeName(v)}'`);
}

const cmpError = (op: string, a: PyValue, b: PyValue): PyError => typeError(`'${op}' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);

/** Python `<` (numbers, str, list, tuple; sets as subsets); `meter` is charged one step per element pair compared. */
export function pyLt(a: PyValue, b: PyValue, op = '<', meter?: PyMeter): boolean {
  return ltOf(a, b, op, meter, 0);
}

function ltOf(a: PyValue, b: PyValue, op: string, meter: PyMeter | undefined, depth: number): boolean {
  if (isNumber(a) && isNumber(b)) return numOf(a) < numOf(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  if ((a instanceof PyListValue && b instanceof PyListValue) || (a instanceof PyTupleValue && b instanceof PyTupleValue)) {
    checkDepth(depth, MSG_PY_DEPTH_COMPARE);
    const n = Math.min(a.items.length, b.items.length);
    let i = 0;
    try {
      for (; i < n; i++) {
        const x = a.items[i] as PyValue;
        const y = b.items[i] as PyValue;
        if (!eqOf(x, y, meter, depth + 1)) return ltOf(x, y, op, meter, depth + 1);
      }
      return a.items.length < b.items.length;
    } finally {
      meter?.charge(Math.min(i + 1, n));
    }
  }
  if (a instanceof PySetValue && b instanceof PySetValue) {
    meter?.charge(a.entries.size);
    return a.entries.size < b.entries.size && [...a.entries.keys()].every((k) => b.entries.has(k));
  }
  throw cmpError(op, a, b);
}

// ── dict helpers ────────────────────────────────────────────────────────────

export function pyDictGet(d: PyDictValue, k: PyValue): PyValue | undefined {
  return d.entries.get(pyKey(k, d.caseless))?.[1];
}

export function pyDictSet(d: PyDictValue, k: PyValue, v: PyValue): void {
  const key = pyKey(k, d.caseless);
  const cur = d.entries.get(key);
  if (cur !== undefined) cur[1] = v;
  else {
    checkLength(d.entries.size + 1);
    d.entries.set(key, [k, v]);
  }
}

/** A new dict from pairs (str keys given as plain strings). */
export function pyDict(pairs: Iterable<readonly [PyValue, PyValue]>, caseless = false): PyDictValue {
  const d = new PyDictValue(caseless);
  for (const [k, v] of pairs) pyDictSet(d, k, v);
  return d;
}

function setAdd(s: PySetValue, v: PyValue): void {
  const k = pyKey(v);
  if (!s.entries.has(k)) {
    checkLength(s.entries.size + 1);
    s.entries.set(k, v);
  }
}

// ── sequences ───────────────────────────────────────────────────────────────

const hasSurrogate = (s: string): boolean => /[\uD800-\uDFFF]/.test(s);
/** The code points of a str (Python indexes and counts code points). */
const codePoints = (s: string): string[] => (hasSurrogate(s) ? Array.from(s) : s.split(''));
export const pyLen = (s: string): number => (hasSurrogate(s) ? Array.from(s).length : s.length);

function asIndex(v: PyValue, what = 'indices'): number {
  if (isIntLike(v)) return intOf(v);
  throw typeError(`${what} must be integers, not ${pyTypeName(v)}`);
}

/** CPython's slice adjustment: (start, stop, step, count) for a sequence of `len`. */
function sliceIndices(s: PySliceValue, len: number): [number, number, number, number] {
  const step = s.step === null ? 1 : asIndex(s.step, 'slice indices');
  if (step === 0) throw valueError('slice step cannot be zero');
  const def = (v: PyValue, dflt: number, low: number, high: number): number => {
    if (v === null) return dflt;
    let i = asIndex(v, 'slice indices');
    if (i < 0) i += len;
    return Math.min(Math.max(i, low), high);
  };
  const start = step > 0 ? def(s.start, 0, 0, len) : def(s.start, len - 1, -1, len - 1);
  const stop = step > 0 ? def(s.stop, len, 0, len) : def(s.stop, -1, -1, len - 1);
  const count = step > 0 ? Math.max(0, Math.ceil((stop - start) / step)) : Math.max(0, Math.ceil((start - stop) / -step));
  return [start, stop, step, count];
}

function sliceOf<T>(items: readonly T[], s: PySliceValue): T[] {
  const [start, , step, count] = sliceIndices(s, items.length);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[start + i * step] as T);
  return out;
}

function seqIndex(len: number, idx: PyValue, what: string): number {
  let i = asIndex(idx, `${what} indices`);
  if (i < 0) i += len;
  if (i < 0 || i >= len) throw pyError(PY_EXC.IndexError, `${what} index out of range`);
  return i;
}

// ── formatting ──────────────────────────────────────────────────────────────

function groupThousands(int: string, sep: string): string {
  const neg = int.startsWith('-');
  const d = neg ? int.slice(1) : int;
  let out = '';
  for (let i = 0; i < d.length; i++) {
    if (i > 0 && (d.length - i) % 3 === 0) out += sep;
    out += d[i];
  }
  return (neg ? '-' : '') + out;
}

/** The exponent form Python writes: at least two exponent digits. */
function expText(x: number, prec: number, upper: boolean): string {
  const [m, e] = x.toExponential(prec).split('e') as [string, string];
  const ev = Number(e);
  const s = `${m}e${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
  return upper ? s.toUpperCase() : s;
}

/** The 'g' presentation: precision `p` significant digits, exponent outside [-4, p). */
function generalText(x: number, p: number, alt: boolean, upper: boolean): string {
  if (x === 0) return alt ? `0.${'0'.repeat(Math.max(0, p - 1))}` : '0';
  const prec = p === 0 ? 1 : p;
  const ev = Number(Math.abs(x).toExponential(prec - 1).split('e')[1]);
  let s: string;
  if (ev >= -4 && ev < prec) s = x.toFixed(Math.max(0, prec - 1 - ev));
  else s = expText(x, prec - 1, upper);
  if (!alt) {
    const [mant, exp] = s.split(/(?=[eE])/) as [string, string | undefined];
    const trimmed = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    s = trimmed + (exp ?? '');
  }
  return s;
}

const SPEC = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/su;

/** `format(v, spec)`: the format-spec mini-language for str, int and float. */
export function pyFormat(v: PyValue, spec: string): string {
  if (spec === '') return pyStr(v);
  const m = SPEC.exec(spec);
  if (m === null) throw valueError(`Invalid format specifier '${spec}' for object of type '${pyTypeName(v)}'`);
  let [, fill, align, sign, alt, zero, width, group, precision, type] = m as unknown as (string | undefined)[];
  const prec = precision === undefined ? undefined : Number(precision);
  if (zero !== undefined && align === undefined) {
    fill = '0';
    align = '=';
  }
  let body: string;
  let numeric = false;
  let negative = false;
  if (typeof v === 'string') {
    if (type !== undefined && type !== 's') throw valueError(`Unknown format code '${type}' for object of type 'str'`);
    body = prec !== undefined ? codePoints(v).slice(0, prec).join('') : v;
  } else if (isNumber(v)) {
    numeric = true;
    const isFloat = v instanceof PyFloat;
    const x = numOf(v);
    negative = x < 0 || Object.is(x, -0);
    const ax = Math.abs(x);
    const t = type ?? (isFloat ? (prec !== undefined ? 'g' : 'r') : 'd');
    switch (t) {
      case 'd':
      case 'n':
        if (isFloat) throw valueError(`Unknown format code 'd' for object of type 'float'`);
        body = String(ax);
        break;
      case 'b':
      case 'o':
      case 'x':
      case 'X':
      case 'c':
        if (isFloat) throw valueError(`Unknown format code '${t}' for object of type 'float'`);
        if (t === 'c') {
          body = String.fromCodePoint(x);
          negative = false;
          break;
        }
        body = ax.toString(t === 'b' ? 2 : t === 'o' ? 8 : 16);
        if (t === 'X') body = body.toUpperCase();
        if (alt !== undefined) body = `0${t === 'X' ? 'X' : t}${body}`;
        break;
      case 'f':
      case 'F':
        body = ax.toFixed(prec ?? 6);
        break;
      case '%':
        body = `${(ax * 100).toFixed(prec ?? 6)}%`;
        break;
      case 'e':
      case 'E':
        body = expText(ax, prec ?? 6, t === 'E');
        break;
      case 'g':
      case 'G':
        body = generalText(ax, prec ?? 6, alt !== undefined, t === 'G');
        if (isFloat && type === undefined && !/[.e]/.test(body)) body += '.0';
        break;
      case 'r':
        body = pyFloatRepr(ax);
        break;
      default:
        throw valueError(`Unknown format code '${t}' for object of type '${pyTypeName(v)}'`);
    }
    if (group !== undefined && /^[0-9]/.test(body)) {
      const dot = body.search(/[.e%]/);
      const int = dot < 0 ? body : body.slice(0, dot);
      body = groupThousands(int, group) + (dot < 0 ? '' : body.slice(dot));
    }
  } else {
    if (spec !== '') throw typeError(`unsupported format string passed to ${pyTypeName(v)}.__format__`);
    body = pyStr(v);
  }
  const signText = numeric ? (negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') : '';
  const w = width === undefined ? 0 : Number(width);
  // a width past the cap is refused before the padding is built (file header, "NATIVE WORK")
  if (w > PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
  const f = fill ?? ' ';
  const total = pyLen(signText + body);
  if (total >= w) return signText + body;
  const pad = f.repeat(w - total);
  switch (align ?? (numeric ? '>' : '<')) {
    case '<':
      return signText + body + pad;
    case '>':
      return pad + signText + body;
    case '^': {
      const left = f.repeat(Math.floor((w - total) / 2));
      return left + signText + body + f.repeat(w - total - pyLen(left));
    }
    default:
      return signText + pad + body;
  }
}

/** `str.format`: `{}`, `{0}`, `{name}`, `{0[key]}`, `{x.attr}`, with `!r`/`!s` and a spec; `{{` and `}}` escape. */
export function pyStrFormat(vm: PyMachine, fmt: string, args: readonly PyValue[], kw: PyKwargs | undefined): string {
  let out = '';
  let auto = 0;
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i] as string;
    if (c === '{' && fmt[i + 1] === '{') {
      out += '{';
      i += 2;
      continue;
    }
    if (c === '}' && fmt[i + 1] === '}') {
      out += '}';
      i += 2;
      continue;
    }
    if (c === '}') throw valueError("Single '}' encountered in format string");
    if (c !== '{') {
      out += c;
      i++;
      continue;
    }
    const close = fmt.indexOf('}', i);
    if (close < 0) throw valueError("Single '{' encountered in format string");
    const field = fmt.slice(i + 1, close);
    i = close + 1;
    const colon = field.indexOf(':');
    const head = colon < 0 ? field : field.slice(0, colon);
    const spec = colon < 0 ? '' : field.slice(colon + 1);
    const bang = head.indexOf('!');
    const ref = bang < 0 ? head : head.slice(0, bang);
    const conv = bang < 0 ? '' : head.slice(bang + 1);
    const m = /^([^.[]*)(.*)$/.exec(ref) as RegExpExecArray;
    const first = m[1] as string;
    let value: PyValue;
    if (first === '') {
      if (auto >= args.length) throw pyError(PY_EXC.IndexError, `Replacement index ${auto} out of range for positional args tuple`);
      value = args[auto++] as PyValue;
    } else if (/^\d+$/.test(first)) {
      const n = Number(first);
      if (n >= args.length) throw pyError(PY_EXC.IndexError, `Replacement index ${n} out of range for positional args tuple`);
      value = args[n] as PyValue;
    } else {
      const v = kw?.get(first);
      if (v === undefined) throw pyError(PY_EXC.KeyError, first);
      value = v;
    }
    for (const step of (m[2] as string).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]*)\]/g)) {
      if (step[1] !== undefined) value = vm.getattr(value, step[1]);
      else {
        const k = step[2] as string;
        value = pyGetItem(value, /^\d+$/.test(k) ? Number(k) : k);
      }
    }
    if (conv === 'r' || conv === 'a') value = pyRepr(value, vm);
    else if (conv === 's') value = pyStr(value, vm);
    else if (conv !== '') throw valueError(`Unknown conversion specifier ${conv}`);
    const piece = pyFormat(value, spec);
    checkTextUnits(out.length + piece.length);
    out += piece;
  }
  return out;
}

/** `fmt % args`: %s %r %d %i %f %F %e %E %g %G %x %X %o %c %%, flags, width, precision, `%(name)s` with a dict. */
export function pyPercentFormat(fmt: string, arg: PyValue): string {
  const list = arg instanceof PyTupleValue ? arg.items : [arg];
  const byName = arg instanceof PyDictValue ? arg : undefined;
  let n = 0;
  const take = (): PyValue => {
    if (n >= list.length) throw typeError('not enough arguments for format string');
    return list[n++] as PyValue;
  };
  let units = 0;
  const out = fmt.replace(/%(?:\(([^)]*)\))?([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sdirfFeEgGxXoc%])/g, (_all, name: string | undefined, flags: string, width: string | undefined, prec: string | undefined, conv: string) => {
    // the text built so far, refused before it passes the cap (file header, "NATIVE WORK")
    const done = (piece: string): string => {
      units += piece.length;
      checkTextUnits(units);
      return piece;
    };
    if (conv === '%') return '%';
    const w = width === '*' ? asIndex(take()) : width;
    const p = prec === '*' ? asIndex(take()) : prec;
    let v: PyValue;
    if (name !== undefined) {
      if (byName === undefined) throw typeError('format requires a mapping');
      const got = pyDictGet(byName, name);
      if (got === undefined) throw pyError(PY_EXC.KeyError, name);
      v = got;
    } else v = take();
    let align = flags.includes('-') ? '<' : '';
    const fill = flags.includes('0') && align === '' && conv !== 's' && conv !== 'r' ? '0' : '';
    if (fill === '0') align = '=';
    const signFlag = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
    const altFlag = flags.includes('#') ? '#' : '';
    const widthText = w === undefined ? '' : String(w);
    const precText = p === undefined ? '' : `.${p}`;
    if (conv === 's' || conv === 'r') {
      const text = conv === 's' ? pyStr(v) : pyRepr(v);
      return done(pyFormat(text, `${align === '<' ? '<' : align === '' ? '>' : align}${widthText}${precText}`));
    }
    if (!isNumber(v)) throw typeError(`%${conv} format: a real number is required, not ${pyTypeName(v)}`);
    let value: PyValue = v;
    let code = conv;
    if (conv === 'd' || conv === 'i') {
      value = isIntLike(v) ? v : Math.trunc(numOf(v));
      code = 'd';
    } else if ('xXoc'.includes(conv)) {
      if (!isIntLike(v)) throw typeError(`%${conv} format: an integer is required, not ${pyTypeName(v)}`);
    } else if (isIntLike(v)) value = new PyFloat(intOf(v));
    const fillAlign = fill === '0' ? '0=' : align === '<' ? '<' : '';
    return done(pyFormat(value, `${fillAlign}${signFlag}${altFlag}${widthText}${code === 'd' ? '' : precText}${code}`));
  });
  if (byName === undefined && n < list.length) throw typeError('not all arguments converted during string formatting');
  return out;
}

// ── items and containment ───────────────────────────────────────────────────

/** `obj[idx]`. */
export function pyGetItem(obj: PyValue, idx: PyValue): PyValue {
  if (obj instanceof PyListValue || obj instanceof PyTupleValue) {
    if (idx instanceof PySliceValue) {
      const items = sliceOf(obj.items, idx);
      return obj instanceof PyListValue ? new PyListValue(items) : new PyTupleValue(items);
    }
    return obj.items[seqIndex(obj.items.length, idx, obj instanceof PyListValue ? 'list' : 'tuple')] as PyValue;
  }
  if (typeof obj === 'string') {
    const cps = codePoints(obj);
    if (idx instanceof PySliceValue) return sliceOf(cps, idx).join('');
    return cps[seqIndex(cps.length, idx, 'string')] as string;
  }
  if (obj instanceof PyDictValue) {
    const v = pyDictGet(obj, idx);
    if (v === undefined) throw new PyError(new PyException(PY_EXC.KeyError, [idx]));
    return v;
  }
  if (obj instanceof PyRange) {
    if (idx instanceof PySliceValue) {
      const [start, , step, count] = sliceIndices(idx, obj.length);
      return new PyRange(obj.at(start), obj.at(start) + count * step * obj.step, step * obj.step);
    }
    return obj.at(seqIndex(obj.length, idx, 'range object'));
  }
  throw typeError(`'${pyTypeName(obj)}' object is not subscriptable`);
}

/**
 * The first index of `items` equal to `x` from `start` (-1 for none), charging `vm` one step per comparison (file
 * header, "NATIVE WORK"): `in`, `index`, `remove`.
 */
function indexOfEq(vm: PyMachine, items: readonly PyValue[], x: PyValue, start = 0): number {
  let i = start;
  try {
    for (; i < items.length; i++) if (pyEq(items[i] as PyValue, x, vm)) return i;
    return -1;
  } finally {
    vm.charge(Math.min(i + 1, items.length) - start);
  }
}

/** How many items of `items` equal `x`, charging `vm` one step per comparison: `count`. */
function countEq(vm: PyMachine, items: readonly PyValue[], x: PyValue): number {
  vm.charge(items.length);
  let n = 0;
  for (const i of items) if (pyEq(i, x, vm)) n++;
  return n;
}

/** `x in container`. */
export function pyContains(vm: PyMachine, container: PyValue, x: PyValue): boolean {
  if (typeof container === 'string') {
    if (typeof x !== 'string') throw typeError(`'in <string>' requires string as left operand, not ${pyTypeName(x)}`);
    return container.includes(x);
  }
  if (container instanceof PyDictValue) return pyDictGet(container, x) !== undefined;
  if (container instanceof PySetValue) return container.entries.has(pyKey(x));
  if (container instanceof PyDictView && container.kind === 'keys') return pyDictGet(container.dict, x) !== undefined;
  if (container instanceof PyListValue || container instanceof PyTupleValue) return indexOfEq(vm, container.items, x) >= 0;
  if (container instanceof PyRange) {
    if (!isIntLike(x)) return false;
    const n = intOf(x);
    const off = n - container.start;
    return off % container.step === 0 && off / container.step >= 0 && off / container.step < container.length;
  }
  return indexOfEq(vm, vm.items(container), x) >= 0;
}

// ── operators ───────────────────────────────────────────────────────────────

function repeatSeq<T>(items: readonly T[], times: number): T[] {
  const n = Math.max(0, times);
  checkLength(items.length * n);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...items);
  return out;
}

function unsupported(op: string, a: PyValue, b: PyValue): PyError {
  return typeError(`unsupported operand type(s) for ${op}: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** `a <op> b` for the binary operators. */
export function pyBinary(op: string, a: PyValue, b: PyValue): PyValue {
  if (isNumber(a) && isNumber(b)) {
    const bothInt = isIntLike(a) && isIntLike(b);
    const x = numOf(a);
    const y = numOf(b);
    switch (op) {
      case '+':
        return bothInt ? pyCheckInt(x + y) : new PyFloat(x + y);
      case '-':
        return bothInt ? pyCheckInt(x - y) : new PyFloat(x - y);
      case '*':
        return bothInt ? pyCheckInt(x * y) : new PyFloat(x * y);
      case '/':
        if (y === 0) throw pyError(PY_EXC.ZeroDivisionError, 'division by zero');
        return new PyFloat(x / y);
      case '//':
        if (bothInt) return floorDiv(x, y);
        if (y === 0) throw pyError(PY_EXC.ZeroDivisionError, 'float floor division by zero');
        return new PyFloat(Math.floor(x / y));
      case '%':
        if (bothInt) {
          if (y === 0) throw pyError(PY_EXC.ZeroDivisionError, 'integer division or modulo by zero');
          return pyMod(x, y);
        }
        if (y === 0) throw pyError(PY_EXC.ZeroDivisionError, 'float modulo');
        return new PyFloat(pyMod(x, y));
      case '**':
        if (bothInt && y >= 0) return intPow(x, y);
        if (x === 0 && y < 0) throw pyError(PY_EXC.ZeroDivisionError, '0.0 cannot be raised to a negative power');
        return new PyFloat(floatPow(x, y));
      case '<<':
      case '>>':
        if (!bothInt) throw unsupported(op, a, b);
        return shift(x, y, op === '<<');
      case '&':
      case '|':
      case '^':
        if (!bothInt) throw unsupported(op, a, b);
        if (typeof a === 'boolean' && typeof b === 'boolean') return op === '&' ? a && b : op === '|' ? a || b : a !== b;
        return bitOp(op, x, y);
      default:
        throw unsupported(op, a, b);
    }
  }
  if (op === '+') {
    if (typeof a === 'string' && typeof b === 'string') {
      checkLength(a.length + b.length);
      return a + b;
    }
    if (a instanceof PyListValue && b instanceof PyListValue) {
      checkLength(a.items.length + b.items.length);
      return new PyListValue([...a.items, ...b.items]);
    }
    if (a instanceof PyTupleValue && b instanceof PyTupleValue) return new PyTupleValue([...a.items, ...b.items]);
    if (typeof a === 'string' || typeof b === 'string') {
      const other = typeof a === 'string' ? b : a;
      throw typeError(typeof a === 'string' ? `can only concatenate str (not "${pyTypeName(other)}") to str` : `unsupported operand type(s) for +: '${pyTypeName(a)}' and 'str'`);
    }
  }
  if (op === '*') {
    const [seq, times] = isIntLike(b) ? [a, intOf(b)] : isIntLike(a) ? [b, intOf(a)] : [undefined, 0];
    if (typeof seq === 'string') {
      checkLength(seq.length * Math.max(0, times));
      return times <= 0 ? '' : seq.repeat(times);
    }
    if (seq instanceof PyListValue) return new PyListValue(repeatSeq(seq.items, times));
    if (seq instanceof PyTupleValue) return new PyTupleValue(repeatSeq(seq.items, times));
  }
  if (op === '%' && typeof a === 'string') return pyCheckStr(pyPercentFormat(a, b));
  if (a instanceof PySetValue && b instanceof PySetValue && (op === '|' || op === '&' || op === '-' || op === '^')) {
    const out = new PySetValue();
    const inA = (v: PyValue): boolean => a.entries.has(pyKey(v));
    const inB = (v: PyValue): boolean => b.entries.has(pyKey(v));
    if (op === '|') for (const v of [...a.entries.values(), ...b.entries.values()]) setAdd(out, v);
    if (op === '&') for (const v of a.entries.values()) if (inB(v)) setAdd(out, v);
    if (op === '-') for (const v of a.entries.values()) if (!inB(v)) setAdd(out, v);
    if (op === '^') for (const v of [...a.entries.values(), ...b.entries.values()]) if (inA(v) !== inB(v)) setAdd(out, v);
    return out;
  }
  if (op === '|' && a instanceof PyDictValue && b instanceof PyDictValue) {
    const out = pyDict([...a.entries.values()]);
    for (const [k, v] of b.entries.values()) pyDictSet(out, k, v);
    return out;
  }
  throw unsupported(op, a, b);
}

/** `-x`, `+x`, `~x`, `not x`. */
export function pyUnary(op: string, v: PyValue): PyValue {
  if (op === 'not') return !pyTruthy(v);
  if (isIntLike(v)) {
    const n = intOf(v);
    if (op === '-') return pyCheckInt(-n);
    if (op === '+') return n;
    return pyCheckInt(-n - 1);
  }
  if (v instanceof PyFloat && op !== '~') return op === '-' ? new PyFloat(-v.v) : v;
  throw typeError(`bad operand type for unary ${op}: '${pyTypeName(v)}'`);
}

/** The comparison operators. */
export function pyCompare(vm: PyMachine, op: string, a: PyValue, b: PyValue): boolean {
  switch (op) {
    case '==':
      return pyEq(a, b, vm);
    case '!=':
      return !pyEq(a, b, vm);
    case '<':
      return pyLt(a, b, '<', vm);
    case '>':
      return pyLt(b, a, '>', vm);
    case '<=':
      return pyEq(a, b, vm) ? isComparable(a, b, '<=') : pyLt(a, b, '<=', vm);
    case '>=':
      return pyEq(a, b, vm) ? isComparable(a, b, '>=') : pyLt(b, a, '>=', vm);
    case 'in':
      return pyContains(vm, b, a);
    case 'not in':
      return !pyContains(vm, b, a);
    case 'is':
      return a === b;
    case 'is not':
      return a !== b;
    default:
      throw typeError(`unknown comparison ${op}`);
  }
}

function isComparable(a: PyValue, b: PyValue, op: string): boolean {
  if ((isNumber(a) && isNumber(b)) || (typeof a === 'string' && typeof b === 'string')) return true;
  if ((a instanceof PyListValue && b instanceof PyListValue) || (a instanceof PyTupleValue && b instanceof PyTupleValue) || (a instanceof PySetValue && b instanceof PySetValue)) return true;
  throw cmpError(op, a, b);
}

// ── sorting ─────────────────────────────────────────────────────────────────

/**
 * A stable sort by Python `<` (with an optional key function and `reverse`): a bottom-up merge sort of our own, so
 * which pairs are compared, in which order (and so which TypeError a mixed list raises) never depends on the JS
 * engine's `Array.prototype.sort`; each comparison is charged one step (file header, "NATIVE WORK"). Only `<` is used,
 * as Python does: ascending, a later item goes first only when it is less; with `reverse`, only when it is greater, so
 * equal items keep their order either way.
 */
export function pySort(vm: PyMachine, items: readonly PyValue[], key: PyValue, reverse: boolean): PyValue[] {
  const keys = key === null ? [...items] : items.map((i) => vm.call(key, [i]));
  const n = items.length;
  /** Whether item `j` (from the right run) goes before item `i` (from the left run). */
  const before = (j: number, i: number): boolean => {
    vm.charge(1);
    const a = keys[i] as PyValue;
    const b = keys[j] as PyValue;
    return reverse ? pyLt(a, b, '<', vm) : pyLt(b, a, '<', vm);
  };
  let src = items.map((_, i) => i);
  let dst = new Array<number>(n);
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) dst[k++] = before(src[j] as number, src[i] as number) ? (src[j++] as number) : (src[i++] as number);
      while (i < mid) dst[k++] = src[i++] as number;
      while (j < hi) dst[k++] = src[j++] as number;
    }
    [src, dst] = [dst, src];
  }
  return src.map((i) => items[i] as PyValue);
}

// ── type constructors and methods (the core of the builtins) ───────────────

/** One positional-or-keyword argument list: values by name, in order, with Python's TypeError wording. */
export function pyArgs(fname: string, args: readonly PyValue[], kw: PyKwargs | undefined, names: readonly string[], required: number): (PyValue | undefined)[] {
  if (args.length > names.length) throw typeError(`${fname}() takes ${names.length === required ? '' : 'at most '}${names.length} argument${names.length === 1 ? '' : 's'} (${args.length} given)`);
  const out: (PyValue | undefined)[] = names.map((_, i) => args[i]);
  for (const [k, v] of kw ?? []) {
    const i = names.indexOf(k);
    if (i < 0) throw typeError(`${fname}() got an unexpected keyword argument '${k}'`);
    if (out[i] !== undefined) throw typeError(`${fname}() got multiple values for argument '${k}'`);
    out[i] = v;
  }
  for (let i = 0; i < required; i++) if (out[i] === undefined) throw typeError(`${fname}() missing required argument '${names[i]}' (pos ${i + 1})`);
  return out;
}

function noKw(fname: string, kw: PyKwargs | undefined): void {
  if (kw !== undefined && kw.size > 0) throw typeError(`${fname}() takes no keyword arguments`);
}

const INT_TEXT = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*)$/;

/** `int(text, base)`. */
function intFromText(text: string, base: number): number {
  const t = text.trim();
  const bad = (): PyError => valueError(`invalid literal for int() with base ${base}: ${pyStrRepr(text)}`);
  if (base === 10 && !/^[+-]?[0-9](?:_?[0-9])*$/.test(t)) throw bad();
  if (base !== 10 && !INT_TEXT.test(t) && !new RegExp(`^[+-]?[0-9a-zA-Z_]+$`).test(t)) throw bad();
  const neg = t.startsWith('-');
  let digits = t.replace(/^[+-]/, '').replace(/_/g, '');
  if (base === 16) digits = digits.replace(/^0[xX]/, '');
  else if (base === 8) digits = digits.replace(/^0[oO]/, '');
  else if (base === 2) digits = digits.replace(/^0[bB]/, '');
  let n = 0;
  for (const ch of digits.toLowerCase()) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= base) throw bad();
    n = pyCheckInt(n * base + d);
  }
  return neg ? -n : n;
}

/** `float(text)`. */
function floatFromText(text: string): number {
  const t = text.trim().toLowerCase().replace(/_/g, '');
  if (/^[+-]?(inf|infinity)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(t)) return NaN;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(t)) throw valueError(`could not convert string to float: ${pyStrRepr(text)}`);
  return Number(t);
}

/** Calling a type: the builtin constructors and the exception classes. */
export function pyConstruct(vm: PyMachine, type: PyType, args: readonly PyValue[], kw: PyKwargs | undefined): PyValue {
  if (pyIsSubtype(type, PY_EXC.BaseException)) {
    noKw(type.name, kw);
    return new PyException(type, [...args]);
  }
  switch (type) {
    case PY_INT: {
      const [x, base] = pyArgs('int', args, kw, ['x', 'base'], 0);
      if (x === undefined) return 0;
      if (base !== undefined) {
        if (typeof x !== 'string') throw typeError("int() can't convert non-string with explicit base");
        return intFromText(x, asIndex(base));
      }
      if (typeof x === 'string') return intFromText(x, 10);
      if (isIntLike(x)) return intOf(x);
      if (x instanceof PyFloat) {
        if (!Number.isFinite(x.v)) throw pyError(Number.isNaN(x.v) ? PY_EXC.ValueError : PY_EXC.OverflowError, `cannot convert float ${pyFloatRepr(x.v)} to integer`);
        return pyCheckInt(Math.trunc(x.v));
      }
      throw typeError(`int() argument must be a string or a number, not '${pyTypeName(x)}'`);
    }
    case PY_FLOAT_T: {
      const [x] = pyArgs('float', args, kw, ['x'], 0);
      if (x === undefined) return new PyFloat(0);
      if (typeof x === 'string') return new PyFloat(floatFromText(x));
      if (isNumber(x)) return new PyFloat(numOf(x));
      throw typeError(`float() argument must be a string or a real number, not '${pyTypeName(x)}'`);
    }
    case PY_STR: {
      const [x] = pyArgs('str', args, kw, ['object'], 0);
      return x === undefined ? '' : pyStr(x, vm);
    }
    case PY_BOOL: {
      const [x] = pyArgs('bool', args, kw, ['x'], 0);
      return x === undefined ? false : pyTruthy(x);
    }
    case PY_LIST_T: {
      noKw('list', kw);
      return new PyListValue(args.length === 0 ? [] : vm.items(args[0] as PyValue));
    }
    case PY_TUPLE_T: {
      noKw('tuple', kw);
      return new PyTupleValue(args.length === 0 ? [] : vm.items(args[0] as PyValue));
    }
    case PY_SET_T: {
      noKw('set', kw);
      const s = new PySetValue();
      if (args.length > 0) for (const v of vm.items(args[0] as PyValue)) setAdd(s, v);
      return s;
    }
    case PY_DICT_T: {
      const d = new PyDictValue();
      if (args.length > 1) throw typeError(`dict expected at most 1 argument, got ${args.length}`);
      if (args.length === 1) dictUpdate(vm, d, args[0] as PyValue);
      for (const [k, v] of kw ?? []) pyDictSet(d, k, v);
      return d;
    }
    case PY_RANGE_T: {
      noKw('range', kw);
      if (args.length === 0 || args.length > 3) throw typeError(`range expected 1 to 3 arguments, got ${args.length}`);
      const n = args.map((a) => asIndex(a, "'range' arguments"));
      const [start, stop, step] = n.length === 1 ? [0, n[0] as number, 1] : [n[0] as number, n[1] as number, n[2] ?? 1];
      if (step === 0) throw valueError('range() arg 3 must not be zero');
      return new PyRange(start, stop, step);
    }
    case PY_TYPE_T: {
      noKw('type', kw);
      if (args.length !== 1) throw typeError('type() takes 1 argument in NF-Py');
      return pyTypeOf(args[0] as PyValue);
    }
    case PY_OBJECT:
      return vm.object(PY_OBJECT, []);
    default:
      throw typeError(`cannot create '${type.name}' instances`);
  }
}

/** `d.update(other)`: a dict or an iterable of pairs. */
function dictUpdate(vm: PyMachine, d: PyDictValue, other: PyValue): void {
  if (other instanceof PyDictValue) {
    for (const [k, v] of other.entries.values()) pyDictSet(d, k, v);
    return;
  }
  for (const pair of vm.items(other)) {
    const kv = vm.items(pair);
    if (kv.length !== 2) throw valueError(`dictionary update sequence element has length ${kv.length}; 2 is required`);
    pyDictSet(d, kv[0] as PyValue, kv[1] as PyValue);
  }
}

const WS = /\s/;

function splitText(s: string, sep: PyValue | undefined, maxsplit: number, right: boolean): string[] {
  if (sep === undefined || sep === null) {
    const words = s.trim().split(/\s+/).filter((w) => w !== '');
    if (maxsplit < 0 || words.length <= maxsplit + 1) return words;
    if (right) {
      const out: string[] = [];
      let rest = s.replace(/\s+$/, '');
      for (let i = 0; i < maxsplit; i++) {
        const m = /\s+(\S+)$/.exec(rest);
        if (m === null) break;
        out.unshift(m[1] as string);
        rest = rest.slice(0, m.index);
      }
      return [rest.trim(), ...out].filter((w, i) => i > 0 || w !== '');
    }
    const out: string[] = [];
    let rest = s.replace(/^\s+/, '');
    for (let i = 0; i < maxsplit; i++) {
      const m = /^(\S+)\s+/.exec(rest);
      if (m === null) break;
      out.push(m[1] as string);
      rest = rest.slice(m[0].length);
    }
    if (rest !== '') out.push(rest);
    return out;
  }
  if (typeof sep !== 'string') throw typeError(`must be str or None, not ${pyTypeName(sep)}`);
  if (sep === '') throw valueError('empty separator');
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return parts;
  if (right) return [parts.slice(0, parts.length - maxsplit).join(sep), ...parts.slice(parts.length - maxsplit)];
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}

function stripChars(s: string, chars: PyValue | undefined, left: boolean, right: boolean): string {
  const set = chars === undefined || chars === null ? undefined : String(chars);
  const strip = (c: string): boolean => (set === undefined ? WS.test(c) : set.includes(c));
  const cps = codePoints(s);
  let a = 0;
  let b = cps.length;
  if (left) while (a < b && strip(cps[a] as string)) a++;
  if (right) while (b > a && strip(cps[b - 1] as string)) b--;
  return cps.slice(a, b).join('');
}

function strMethod(vm: PyMachine, s: string, name: string): PyNative | undefined {
  const str = (v: PyValue | undefined, what: string): string => {
    if (typeof v !== 'string') throw typeError(`${what} must be str, not ${pyTypeName(v ?? null)}`);
    return v;
  };
  switch (name) {
    case 'upper':
      return () => s.toUpperCase();
    case 'lower':
    case 'casefold':
      return () => s.toLowerCase();
    case 'title':
      return () => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
    case 'capitalize':
      return () => (s === '' ? '' : (codePoints(s)[0] as string).toUpperCase() + codePoints(s).slice(1).join('').toLowerCase());
    case 'swapcase':
      return () => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
    case 'strip':
    case 'lstrip':
    case 'rstrip':
      return (_vm, args) => stripChars(s, args[0], name !== 'rstrip', name !== 'lstrip');
    case 'split':
    case 'rsplit':
      return (_vm, args, kw) => {
        const [sep, max] = pyArgs(name, args, kw, ['sep', 'maxsplit'], 0);
        return new PyListValue(splitText(s, sep, max === undefined ? -1 : asIndex(max), name === 'rsplit'));
      };
    case 'splitlines':
      return (_vm, args) => {
        const keep = args[0] !== undefined && pyTruthy(args[0]);
        const parts = s.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
        return new PyListValue(parts.map((p) => (keep ? p : p.replace(/(?:\r\n|\r|\n)$/, ''))));
      };
    case 'join':
      return (_vm, args) => {
        const items = vm.items(args[0] ?? null);
        // the joined length is known before the text is built (file header, "NATIVE WORK")
        let units = 0;
        items.forEach((v, i) => {
          if (typeof v !== 'string') throw typeError(`sequence item ${i}: expected str instance, ${pyTypeName(v)} found`);
          units += v.length + (i > 0 ? s.length : 0);
        });
        checkTextUnits(units);
        return (items as string[]).join(s);
      };
    case 'replace':
      return (_vm, args) => {
        const old = str(args[0], 'replace() argument 1');
        const rep = str(args[1], 'replace() argument 2');
        const count = args[2] === undefined ? -1 : asIndex(args[2]);
        // Python: "" matches before every code point and at the end
        const parts = old === '' ? ['', ...codePoints(s), ''] : s.split(old);
        const found = parts.length - 1;
        const n = count < 0 ? found : Math.min(count, found);
        checkTextUnits(s.length + n * (rep.length - old.length));
        if (n === found) return parts.join(rep);
        return parts.slice(0, n + 1).join(rep) + old + parts.slice(n + 1).join(old);
      };
    case 'startswith':
    case 'endswith':
      return (_vm, args) => {
        const what = args[0] ?? null;
        const opts = what instanceof PyTupleValue ? what.items : [what];
        return opts.some((o) => (name === 'startswith' ? s.startsWith(str(o, `${name} first arg`)) : s.endsWith(str(o, `${name} first arg`))));
      };
    case 'find':
    case 'rfind':
    case 'index':
    case 'rindex':
      return (_vm, args) => {
        const sub = str(args[0], 'must be str');
        const k = name.startsWith('r') ? s.lastIndexOf(sub) : s.indexOf(sub);
        if (k < 0 && name.endsWith('index')) throw valueError('substring not found');
        return k;
      };
    case 'count':
      return (_vm, args) => {
        const sub = str(args[0], 'must be str');
        if (sub === '') return pyLen(s) + 1;
        return s.split(sub).length - 1;
      };
    case 'format':
      return (_vm, args, kw) => pyStrFormat(vm, s, args, kw);
    case 'isdigit':
    case 'isnumeric':
    case 'isdecimal':
      return () => s !== '' && /^[0-9]+$/.test(s);
    case 'isalpha':
      return () => s !== '' && /^\p{L}+$/u.test(s);
    case 'isalnum':
      return () => s !== '' && /^[\p{L}0-9]+$/u.test(s);
    case 'isspace':
      return () => s !== '' && /^\s+$/.test(s);
    case 'isupper':
      return () => /[A-Za-z]/.test(s) && s === s.toUpperCase();
    case 'islower':
      return () => /[A-Za-z]/.test(s) && s === s.toLowerCase();
    case 'center':
    case 'ljust':
    case 'rjust':
      return (_vm, args) => {
        const w = asIndex(args[0] ?? null);
        const fill = args[1] === undefined ? ' ' : str(args[1], 'fill character');
        return pyFormat(s, `${fill}${name === 'center' ? '^' : name === 'ljust' ? '<' : '>'}${w}`);
      };
    case 'zfill':
      return (_vm, args) => {
        const w = asIndex(args[0] ?? null);
        if (w > PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
        const sign = /^[+-]/.test(s) ? (s[0] as string) : '';
        const rest = sign === '' ? s : s.slice(1);
        return sign + rest.padStart(Math.max(0, w - sign.length), '0');
      };
    case 'partition':
    case 'rpartition':
      return (_vm, args) => {
        const sep = str(args[0], 'sep');
        const k = name === 'partition' ? s.indexOf(sep) : s.lastIndexOf(sep);
        if (k < 0) return name === 'partition' ? new PyTupleValue([s, '', '']) : new PyTupleValue(['', '', s]);
        return new PyTupleValue([s.slice(0, k), sep, s.slice(k + sep.length)]);
      };
    default:
      return undefined;
  }
}

function listMethod(vm: PyMachine, l: PyListValue, name: string): PyNative | undefined {
  switch (name) {
    case 'append':
      return (_vm, args) => {
        checkLength(l.items.length + 1);
        l.items.push(args[0] ?? null);
        return null;
      };
    case 'extend':
      return (_vm, args) => {
        const add = vm.items(args[0] ?? null);
        checkLength(l.items.length + add.length);
        l.items.push(...add);
        return null;
      };
    case 'insert':
      return (_vm, args) => {
        let i = asIndex(args[0] ?? null);
        if (i < 0) i = Math.max(0, i + l.items.length);
        checkLength(l.items.length + 1);
        // the items after the slot move (file header, "NATIVE WORK")
        vm.charge(l.items.length - Math.min(i, l.items.length));
        l.items.splice(Math.min(i, l.items.length), 0, args[1] ?? null);
        return null;
      };
    case 'pop':
      return (_vm, args) => {
        if (l.items.length === 0) throw pyError(PY_EXC.IndexError, 'pop from empty list');
        const i = args[0] === undefined ? l.items.length - 1 : seqIndex(l.items.length, args[0], 'pop');
        vm.charge(l.items.length - 1 - i);
        return l.items.splice(i, 1)[0] as PyValue;
      };
    case 'remove':
      return (_vm, args) => {
        const i = indexOfEq(vm, l.items, args[0] ?? null);
        if (i < 0) throw valueError('list.remove(x): x not in list');
        l.items.splice(i, 1);
        return null;
      };
    case 'index':
      return (_vm, args) => {
        const i = indexOfEq(vm, l.items, args[0] ?? null);
        if (i < 0) throw valueError(`${pyRepr(args[0] ?? null, vm)} is not in list`);
        return i;
      };
    case 'count':
      return (_vm, args) => countEq(vm, l.items, args[0] ?? null);
    case 'sort':
      return (_vm, args, kw) => {
        if (args.length > 0) throw typeError('sort() takes no positional arguments');
        const [key, reverse] = pyArgs('sort', [], kw, ['key', 'reverse'], 0);
        l.items = pySort(vm, l.items, key ?? null, reverse !== undefined && pyTruthy(reverse));
        return null;
      };
    case 'reverse':
      return () => {
        vm.charge(l.items.length);
        l.items.reverse();
        return null;
      };
    case 'copy':
      return () => {
        vm.charge(l.items.length);
        return new PyListValue([...l.items]);
      };
    case 'clear':
      return () => {
        l.items = [];
        return null;
      };
    default:
      return undefined;
  }
}

function dictMethod(vm: PyMachine, d: PyDictValue, name: string): PyNative | undefined {
  switch (name) {
    case 'get':
      return (_vm, args) => {
        const v = pyDictGet(d, args[0] ?? null);
        return v !== undefined ? v : (args[1] ?? null);
      };
    case 'keys':
    case 'values':
    case 'items':
      return () => new PyDictView(d, name);
    case 'pop':
      return (_vm, args) => {
        const key = pyKey(args[0] ?? null, d.caseless);
        const cur = d.entries.get(key);
        if (cur === undefined) {
          if (args.length > 1) return args[1] as PyValue;
          throw new PyError(new PyException(PY_EXC.KeyError, [args[0] ?? null]));
        }
        d.entries.delete(key);
        return cur[1];
      };
    case 'popitem':
      return () => {
        vm.charge(d.entries.size);
        const last = [...d.entries.keys()].pop();
        if (last === undefined) throw pyError(PY_EXC.KeyError, 'popitem(): dictionary is empty');
        const [k, v] = d.entries.get(last) as [PyValue, PyValue];
        d.entries.delete(last);
        return new PyTupleValue([k, v]);
      };
    case 'setdefault':
      return (_vm, args) => {
        const cur = pyDictGet(d, args[0] ?? null);
        if (cur !== undefined) return cur;
        pyDictSet(d, args[0] ?? null, args[1] ?? null);
        return args[1] ?? null;
      };
    case 'update':
      return (_vm, args, kw) => {
        if (args.length > 0) dictUpdate(vm, d, args[0] as PyValue);
        for (const [k, v] of kw ?? []) pyDictSet(d, k, v);
        return null;
      };
    case 'copy':
      return () => {
        vm.charge(d.entries.size);
        return pyDict([...d.entries.values()], d.caseless);
      };
    case 'clear':
      return () => {
        d.entries.clear();
        return null;
      };
    default:
      return undefined;
  }
}

/** A set a method built: charged per item (file header, "NATIVE WORK"). */
function setResult(vm: PyMachine, v: PyValue): PyValue {
  if (v instanceof PySetValue) vm.charge(v.entries.size);
  return v;
}

function setMethod(vm: PyMachine, s: PySetValue, name: string): PyNative | undefined {
  const other = (v: PyValue | undefined): PySetValue => {
    const o = new PySetValue();
    for (const x of vm.items(v ?? null)) setAdd(o, x);
    return o;
  };
  switch (name) {
    case 'add':
      return (_vm, args) => {
        setAdd(s, args[0] ?? null);
        return null;
      };
    case 'remove':
    case 'discard':
      return (_vm, args) => {
        const k = pyKey(args[0] ?? null);
        if (!s.entries.delete(k) && name === 'remove') throw new PyError(new PyException(PY_EXC.KeyError, [args[0] ?? null]));
        return null;
      };
    case 'pop':
      return () => {
        const first = s.entries.keys().next().value;
        if (first === undefined) throw pyError(PY_EXC.KeyError, 'pop from an empty set');
        const v = s.entries.get(first) as PyValue;
        s.entries.delete(first);
        return v;
      };
    case 'clear':
      return () => {
        s.entries.clear();
        return null;
      };
    case 'copy':
      return () => setResult(vm, pyBinary('|', s, new PySetValue()));
    case 'union':
      return (_vm, args) => setResult(vm, pyBinary('|', s, other(args[0])));
    case 'intersection':
      return (_vm, args) => setResult(vm, pyBinary('&', s, other(args[0])));
    case 'difference':
      return (_vm, args) => setResult(vm, pyBinary('-', s, other(args[0])));
    case 'symmetric_difference':
      return (_vm, args) => setResult(vm, pyBinary('^', s, other(args[0])));
    case 'update':
      return (_vm, args) => {
        for (const x of vm.items(args[0] ?? null)) setAdd(s, x);
        return null;
      };
    case 'issubset':
      return (_vm, args) => {
        const o = other(args[0]);
        return [...s.entries.keys()].every((k) => o.entries.has(k));
      };
    case 'issuperset':
      return (_vm, args) => [...other(args[0]).entries.keys()].every((k) => s.entries.has(k));
    default:
      return undefined;
  }
}

/** The bound method `obj.name` of a builtin type, or undefined. */
function methodOf(vm: PyMachine, obj: PyValue, name: string): PyNative | undefined {
  if (typeof obj === 'string') return strMethod(vm, obj, name);
  if (obj instanceof PyListValue) return listMethod(vm, obj, name);
  if (obj instanceof PyDictValue) return dictMethod(vm, obj, name);
  if (obj instanceof PySetValue) return setMethod(vm, obj, name);
  if (obj instanceof PyTupleValue && (name === 'index' || name === 'count')) {
    return (_vm, args) => {
      if (name === 'count') return countEq(vm, obj.items, args[0] ?? null);
      const i = indexOfEq(vm, obj.items, args[0] ?? null);
      if (i < 0) throw valueError('tuple.index(x): x not in tuple');
      return i;
    };
  }
  if (obj instanceof PyFloat && name === 'is_integer') return () => Number.isInteger(obj.v);
  return undefined;
}

// ── the machine ─────────────────────────────────────────────────────────────

interface Block {
  readonly handler: number;
  readonly depth: number;
  readonly excDepth: number;
}

class Frame {
  ip = 0;
  readonly stack: PyValue[] = [];
  readonly blocks: Block[] = [];
  readonly handling: PyException[] = [];
  constructor(
    readonly id: number,
    readonly code: PyCode,
    readonly locals: (PyValue | undefined)[],
    readonly cells: PyCell[],
    readonly globals: Map<string, PyValue>,
    readonly consts: readonly unknown[],
  ) {}
}

type Exit = { readonly kind: 'return'; readonly value: PyValue } | { readonly kind: 'raise'; readonly exc: PyException } | { readonly kind: 'quantum' } | { readonly kind: 'suspend'; readonly io: PyIoRequest };

const FRAME_PUSHED = Symbol('frame');
const NO_CLOCK: PyClock = Object.freeze({ unixMs: 0, monotonicNs: 0 });

export const MSG_PY_NESTED_IO = 'NF-Py cannot wait for the network or sleep inside a function that a built-in calls (a sort key, map or filter)';
export const MSG_PY_STEPS = `The script ran more than ${PY_MAX_STEPS} steps and was stopped.`;
export const MSG_PY_REQUESTS = `The script made more than ${PY_MAX_REQUESTS} requests and was stopped.`;
export const MSG_PY_SLEEP = `The script slept more than ${PY_MAX_SLEEP_NS / 1_000_000_000} seconds in all and was stopped.`;
/** @since W2 fix The failure text of anything the engine throws that is not a Python exception or a cap (file header). */
export const MSG_PY_INTERNAL = 'The script was stopped: it nested too deeply or built too large a value.';
/** Python's placeholder when an uncaught exception's own text cannot be built. */
export const MSG_PY_EXC_TEXT_FAILED = '<exception str() failed>';
export const MSG_PY_OUTPUT = `\n[output cut: a script prints at most ${PY_MAX_OUTPUT_CHARS} characters]\n`;

class Machine implements PyMachine, PyVm {
  state: PyRunState = 'running';
  clock: PyClock = NO_CLOCK;
  readonly argv: readonly string[];
  private readonly frames: Frame[] = [];
  private readonly builtins: Map<string, PyValue>;
  private readonly modules = new Map<string, PyObject>();
  private readonly constCache = new WeakMap<PyCode, unknown[]>();
  private ids = 0;
  private steps = 0;
  /** Instructions and charged work left in the current slice's quantum (set by `run`; may go below zero). */
  private left = 0;
  private requests = 0;
  private sleptNs = 0;
  private outputChars = 0;
  private cut = false;
  private out = '';
  private pending?: { readonly io: PyIoRequest; readonly resume: (r: PyIoResult) => PyValue };
  private answered?: { readonly value: PyValue } | { readonly error: PyException };
  private failure?: PyFailure;

  constructor(private readonly program: PyProgram, private readonly env: PyEnvironment, argv: readonly string[]) {
    this.argv = argv;
    this.builtins = env.builtins(this);
    const globals = new Map<string, PyValue>([['__name__', '__main__']]);
    this.frames.push(new Frame(this.nextId(), program.code, [], [], globals, this.constsOf(program.code)));
  }

  nextId(): number {
    this.ids += 1;
    return this.ids;
  }

  // ── PyMachine ──

  native(name: string, fn: PyNative, self?: PyValue): PyBuiltin {
    return new PyBuiltin(name, fn, this.nextId(), self);
  }

  object(type: PyType, attrs: Iterable<readonly [string, PyValue]>): PyObject {
    return new PyObject(type, new Map(attrs), this.nextId());
  }

  write(text: string): void {
    if (this.cut) return;
    const room = PY_MAX_OUTPUT_CHARS - this.outputChars;
    if (text.length <= room) {
      this.out += text;
      this.outputChars += text.length;
      return;
    }
    this.out += text.slice(0, room) + MSG_PY_OUTPUT;
    this.outputChars = PY_MAX_OUTPUT_CHARS;
    this.cut = true;
  }

  noteRequest(): void {
    this.requests += 1;
    if (this.requests > PY_MAX_REQUESTS) throw new PyLimitExceeded(MSG_PY_REQUESTS);
  }

  noteSleep(ns: number): void {
    this.sleptNs += ns;
    if (this.sleptNs > PY_MAX_SLEEP_NS) throw new PyLimitExceeded(MSG_PY_SLEEP);
  }

  importModule(name: string): PyObject {
    const cached = this.modules.get(name);
    if (cached !== undefined) return cached;
    const dot = name.lastIndexOf('.');
    if (dot > 0) this.importModule(name.slice(0, dot));
    const m = this.env.module(this, name);
    if (m === undefined) {
      const e = pyException(PY_EXC.ModuleNotFoundError, `No module named ${pyStrRepr(name)}`);
      e.attrs.set('name', name);
      throw new PyError(e);
    }
    this.modules.set(name, m);
    if (dot > 0) {
      const parent = this.modules.get(name.slice(0, dot)) as PyObject;
      if (!parent.attrs.has(name.slice(dot + 1))) parent.attrs.set(name.slice(dot + 1), m);
    }
    return m;
  }

  getattr(obj: PyValue, name: string): PyValue {
    if (obj instanceof PyObject) {
      if (obj.attrs.has(name)) return obj.attrs.get(name) as PyValue;
      if (obj.type === PY_MODULE_T) throw pyError(PY_EXC.AttributeError, `module ${pyStrRepr(pyStr(obj.attrs.get('__name__') ?? '?'))} has no attribute ${pyStrRepr(name)}`);
    } else if (obj instanceof PyException) {
      if (name === 'args') return new PyTupleValue(obj.args);
      if (obj.attrs.has(name)) return obj.attrs.get(name) as PyValue;
    } else if ((obj instanceof PyFunction || obj instanceof PyType || obj instanceof PyBuiltin) && name === '__name__') {
      return obj.name;
    } else {
      const m = methodOf(this, obj, name);
      if (m !== undefined) return new PyBuiltin(name, m, 0, obj);
    }
    throw pyError(PY_EXC.AttributeError, `'${pyTypeName(obj)}' object has no attribute ${pyStrRepr(name)}`);
  }

  private setattr(obj: PyValue, name: string, v: PyValue): void {
    if (obj instanceof PyObject || obj instanceof PyException) {
      obj.attrs.set(name, v);
      return;
    }
    throw pyError(PY_EXC.AttributeError, `'${pyTypeName(obj)}' object has no attribute ${pyStrRepr(name)}`);
  }

  iterate(v: PyValue): PyIterator {
    if (v instanceof PyIterator) return v;
    if (v instanceof PyListValue) {
      let i = 0;
      return new PyIterator(() => (i < v.items.length ? v.items[i++] : undefined));
    }
    if (v instanceof PyTupleValue) {
      let i = 0;
      return new PyIterator(() => (i < v.items.length ? v.items[i++] : undefined));
    }
    if (typeof v === 'string') {
      const cps = codePoints(v);
      let i = 0;
      return new PyIterator(() => (i < cps.length ? cps[i++] : undefined));
    }
    if (v instanceof PyRange) {
      let i = 0;
      const n = v.length;
      return new PyIterator(() => (i < n ? v.at(i++) : undefined));
    }
    if (v instanceof PyDictValue || v instanceof PySetValue || v instanceof PyDictView) {
      const source = v instanceof PyDictView ? v.dict : v;
      const size = source.entries.size;
      const snap: PyValue[] =
        v instanceof PySetValue
          ? [...v.entries.values()]
          : v instanceof PyDictView && v.kind !== 'keys'
            ? [...v.dict.entries.values()].map(([k, x]) => (v.kind === 'values' ? x : new PyTupleValue([k, x])))
            : [...source.entries.values()].map((e) => (e as [PyValue, PyValue])[0]);
      let i = 0;
      return new PyIterator(() => {
        if (source.entries.size !== size) throw pyError(PY_EXC.RuntimeError, `${v instanceof PySetValue ? 'Set' : 'dictionary'} changed size during iteration`);
        return i < snap.length ? snap[i++] : undefined;
      });
    }
    throw typeError(`'${pyTypeName(v)}' object is not iterable`);
  }

  items(v: PyValue): PyValue[] {
    if (v instanceof PyListValue || v instanceof PyTupleValue) {
      this.charge(v.items.length);
      return [...v.items];
    }
    const it = this.iterate(v);
    const out: PyValue[] = [];
    try {
      for (let x = it.next(); x !== undefined; x = it.next()) {
        out.push(x);
        checkLength(out.length);
      }
    } finally {
      this.charge(out.length);
    }
    return out;
  }

  charge(n: number): void {
    if (n <= 0) return;
    this.steps += n;
    if (this.steps > PY_MAX_STEPS) throw new PyLimitExceeded(MSG_PY_STEPS);
    this.left -= n;
  }

  call(fn: PyValue, args: readonly PyValue[], kw?: PyKwargs): PyValue {
    const r = this.invoke(fn, args, kw);
    if (r === FRAME_PUSHED) {
      const base = this.frames.length - 1;
      // the callback runs on the slice's quantum but is never cut: a native call cannot be resumed mid-way, so the
      // caller's loop ends the slice at its next instruction boundary once the quantum is spent (file header)
      const exit = this.exec(base, false);
      if (exit.kind === 'return') return exit.value;
      if (exit.kind === 'raise') throw new PyError(exit.exc);
      throw new Error('nf-py: a nested run stopped');
    }
    if (r instanceof PySuspend) throw pyError(PY_EXC.RuntimeError, MSG_PY_NESTED_IO);
    return r;
  }

  // ── PyVm ──

  stats(): PyStats {
    return { steps: this.steps, requests: this.requests, sleptNs: this.sleptNs, outputChars: this.outputChars };
  }

  resume(result: PyIoResult): void {
    const p = this.pending;
    if (this.state !== 'waiting' || p === undefined) throw new Error('nf-py: resume() without a pending request');
    this.pending = undefined;
    this.state = 'running';
    try {
      this.answered = { value: p.resume(result) };
    } catch (e) {
      if (e instanceof PyError) this.answered = { error: e.exc };
      else if (e instanceof PyLimitExceeded) this.fail(this.limitFailure(e.message));
      // anything else the engine throws ends the run with the fixed text, never escaping (file header, "NESTING")
      else this.fail(this.limitFailure(MSG_PY_INTERNAL));
    }
  }

  run(opts: PyRunOptions = {}): PyRunSlice {
    if (this.state === 'completed' || this.state === 'failed') return this.slice(0);
    if (this.state === 'waiting') return this.slice(0, this.pending?.io);
    this.clock = opts.clock ?? this.clock;
    const quantum = Math.max(1, opts.quantum ?? PY_QUANTUM);
    this.left = quantum;
    const before = this.steps;
    try {
      let exit: Exit | undefined;
      const answered = this.answered;
      this.answered = undefined;
      if (answered !== undefined) {
        if ('value' in answered) this.top().stack.push(answered.value);
        else exit = this.unwind(answered.error, 0);
      }
      exit ??= this.exec(0, true);
      return this.finishSlice(exit, before);
    } catch (e) {
      if (e instanceof PyLimitExceeded) {
        this.fail(this.limitFailure(e.message));
        return this.slice(this.steps - before);
      }
      // anything else the engine throws (a stack or allocation limit of whatever class, which the caps keep out of
      // reach): end the run like a cap with one fixed text, never the engine's own message, never out of the engine
      this.fail(this.limitFailure(MSG_PY_INTERNAL));
      return this.slice(this.steps - before);
    }
  }

  private finishSlice(exit: Exit, before: number): PyRunSlice {
    const steps = this.steps - before;
    switch (exit.kind) {
      case 'quantum':
        return this.slice(steps);
      case 'suspend':
        this.state = 'waiting';
        return this.slice(steps, exit.io);
      case 'return':
        this.state = 'completed';
        this.frames.length = 0;
        return this.slice(steps);
      case 'raise': {
        this.frames.length = 0;
        if (pyIsSubtype(exit.exc.type, PY_EXC.SystemExit)) {
          const code = exit.exc.args[0] ?? null;
          if (code === null || code === 0 || code === false) {
            this.state = 'completed';
            return this.slice(steps);
          }
          if (typeof code === 'string') this.write(`${code}\n`);
          const line = isIntLike(code) ? `SystemExit: ${intOf(code)}` : `SystemExit: ${pyStr(code)}`;
          this.fail({ type: 'SystemExit', message: pyStr(code), traceback: line, last: line });
          return this.slice(steps);
        }
        this.fail(this.exceptionFailure(exit.exc));
        return this.slice(steps);
      }
    }
  }

  private slice(steps: number, io?: PyIoRequest): PyRunSlice {
    const output = this.out;
    this.out = '';
    return {
      state: this.state,
      output,
      steps,
      ...(io !== undefined ? { io } : {}),
      ...(this.state === 'failed' && this.failure !== undefined ? { error: this.failure } : {}),
    };
  }

  private fail(f: PyFailure): void {
    this.state = 'failed';
    this.failure = f;
    this.frames.length = 0;
    this.pending = undefined;
  }

  private limitFailure(message: string): PyFailure {
    const line = this.frames.length > 0 ? this.lineOf(this.top()) : undefined;
    const tb = `Traceback (most recent call last):\n${this.frames.map((f) => this.tbLine(f.code.filename, this.lineOf(f), f.code.name)).join('')}LimitExceeded: ${message}`;
    return { type: 'LimitExceeded', message, traceback: tb, last: `LimitExceeded: ${message}`, ...(line !== undefined ? { line } : {}) };
  }

  private exceptionFailure(exc: PyException): PyFailure {
    const entries = [...exc.traceback].reverse();
    let message: string;
    try {
      message = pyExceptionText(exc);
    } catch (e) {
      // the exception's own text cannot be built (too deep or too large): Python's placeholder
      if (!(e instanceof PyError)) throw e;
      message = MSG_PY_EXC_TEXT_FAILED;
    }
    const last = message === '' ? pyQualifiedName(exc.type) : `${pyQualifiedName(exc.type)}: ${message}`;
    const tb = `Traceback (most recent call last):\n${entries.map((e) => this.tbLine(e.file, e.line, e.name)).join('')}${last}`;
    const innermost = exc.traceback[0];
    return { type: pyQualifiedName(exc.type), message, traceback: tb, last, ...(innermost !== undefined ? { line: innermost.line } : {}) };
  }

  private tbLine(file: string, line: number, name: string): string {
    const src = (this.program.source.split(/\r\n|\r|\n/)[line - 1] ?? '').trim();
    return `  File "${file}", line ${line}, in ${name}\n${src !== '' ? `    ${src}\n` : ''}`;
  }

  // ── execution ──

  private top(): Frame {
    return this.frames[this.frames.length - 1] as Frame;
  }

  private lineOf(f: Frame): number {
    return f.code.lines[Math.max(0, f.ip - 1)] ?? f.code.firstLine;
  }

  private constsOf(code: PyCode): unknown[] {
    let c = this.constCache.get(code);
    if (c === undefined) {
      c = code.consts.map((k: PyConstant) => (k !== null && typeof k === 'object' && 'float' in k ? new PyFloat(k.float) : k));
      this.constCache.set(code, c);
    }
    return c;
  }

  /** Call any callable: a Python function pushes a frame; natives and types return at once (or suspend). */
  private invoke(fn: PyValue, args: readonly PyValue[], kw: PyKwargs | undefined): PyValue | PySuspend | typeof FRAME_PUSHED {
    if (fn instanceof PyFunction) {
      if (this.frames.length >= PY_MAX_CALL_DEPTH) throw pyError(PY_EXC.RecursionError, 'maximum recursion depth exceeded');
      const code = fn.code;
      const locals = this.bind(fn, args, kw);
      const cells: PyCell[] = code.cellvars.map((_, i) => {
        const p = code.cellParams[i] as number;
        return new PyCell(p >= 0 ? locals[p] : undefined);
      });
      cells.push(...fn.closure);
      this.frames.push(new Frame(this.nextId(), code, locals, cells, fn.globals, this.constsOf(code)));
      return FRAME_PUSHED;
    }
    // every str a builtin or a type produces is held to the cap (file header, "NATIVE WORK")
    if (fn instanceof PyBuiltin) {
      const r = fn.fn(this, args, kw, fn.self);
      return typeof r === 'string' ? pyCheckStr(r) : r;
    }
    if (fn instanceof PyType) {
      const r = pyConstruct(this, fn, args, kw);
      return typeof r === 'string' ? pyCheckStr(r) : r;
    }
    throw typeError(`'${pyTypeName(fn)}' object is not callable`);
  }

  /** Python's argument binding: positionals, keywords, defaults, with the TypeError texts. */
  private bind(fn: PyFunction, args: readonly PyValue[], kw: PyKwargs | undefined): (PyValue | undefined)[] {
    const code = fn.code;
    const params = code.params;
    const n = params.length;
    const locals: (PyValue | undefined)[] = new Array<PyValue | undefined>(code.varnames.length).fill(undefined);
    if (args.length > n) throw typeError(`${fn.name}() takes ${n} positional argument${n === 1 ? '' : 's'} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
    for (let i = 0; i < args.length; i++) locals[i] = args[i];
    for (const [k, v] of kw ?? []) {
      const i = params.indexOf(k);
      if (i < 0) throw typeError(`${fn.name}() got an unexpected keyword argument '${k}'`);
      if (locals[i] !== undefined) throw typeError(`${fn.name}() got multiple values for argument '${k}'`);
      locals[i] = v;
    }
    const firstDefault = n - code.ndefaults;
    const missing: string[] = [];
    for (let i = 0; i < n; i++) {
      if (locals[i] !== undefined) continue;
      if (i >= firstDefault) locals[i] = fn.defaults[i - firstDefault];
      else missing.push(`'${params[i]}'`);
    }
    if (missing.length > 0) {
      const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
      throw typeError(`${fn.name}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${list}`);
    }
    return locals;
  }

  /** Raise `exc` in the top frame and unwind to a handler (or out of `base`). */
  private unwind(exc: PyException, base: number): Exit | undefined {
    for (;;) {
      const f = this.top();
      if (!exc.traceback.some((t) => t.frame === f.id)) exc.traceback.push({ file: f.code.filename, name: f.code.name, line: this.lineOf(f), frame: f.id });
      const blk = f.blocks.pop();
      if (blk !== undefined) {
        f.stack.length = blk.depth;
        f.handling.length = blk.excDepth;
        f.stack.push(exc);
        f.ip = blk.handler;
        return undefined;
      }
      this.frames.pop();
      if (this.frames.length <= base) return { kind: 'raise', exc };
    }
  }

  private raiseValue(v: PyValue): never {
    if (v instanceof PyException) throw new PyError(v);
    if (v instanceof PyType && pyIsSubtype(v, PY_EXC.BaseException)) throw new PyError(new PyException(v, []));
    throw typeError('exceptions must derive from BaseException');
  }

  private excMatches(exc: PyValue, spec: PyValue): boolean {
    const types = spec instanceof PyTupleValue ? spec.items : [spec];
    for (const t of types) {
      if (!(t instanceof PyType) || !pyIsSubtype(t, PY_EXC.BaseException)) throw typeError('catching classes that do not inherit from BaseException is not allowed');
    }
    return exc instanceof PyException && types.some((t) => pyIsSubtype(exc.type, t as PyType));
  }

  /** A container an operator or a subscript built (a slice, a concatenation, a set operation): charged per item. */
  private charged(v: PyValue): PyValue {
    if (v instanceof PyListValue || v instanceof PyTupleValue) this.charge(v.items.length);
    else if (v instanceof PyDictValue || v instanceof PySetValue) this.charge(v.entries.size);
    return v;
  }

  /**
   * The interpreter loop: runs until the frame stack drops to `base`, the quantum ends (`bounded`: the run's own loop;
   * a builtin's callback shares the quantum but is never cut), or a call suspends.
   */
  private exec(base: number, bounded: boolean): Exit {
    for (;;) {
      if (bounded && this.left <= 0) return { kind: 'quantum' };
      this.left--;
      this.steps++;
      if (this.steps > PY_MAX_STEPS) throw new PyLimitExceeded(MSG_PY_STEPS);
      const f = this.top();
      const op = f.code.ops[f.ip] as number;
      const arg = f.code.args[f.ip] as number;
      f.ip++;
      try {
        const r = this.step(f, op, arg, base);
        if (r !== undefined) return r;
      } catch (e) {
        if (!(e instanceof PyError)) throw e;
        const exit = this.unwind(e.exc, base);
        if (exit !== undefined) return exit;
      }
    }
  }

  /** One instruction; returns an exit only for RETURN to `base` and a suspension. */
  private step(f: Frame, op: number, arg: number, base: number): Exit | undefined {
    const OP = PY_OP;
    const s = f.stack;
    const pop = (): PyValue => s.pop() as PyValue;
    switch (op) {
      case OP.NOP:
        return undefined;
      case OP.POP_TOP:
        s.pop();
        return undefined;
      case OP.DUP_TOP:
        s.push(s[s.length - 1] as PyValue);
        return undefined;
      case OP.DUP_TOP_TWO:
        s.push(s[s.length - 2] as PyValue, s[s.length - 1] as PyValue);
        return undefined;
      case OP.ROT_TWO: {
        const a = pop();
        const b = pop();
        s.push(a, b);
        return undefined;
      }
      case OP.ROT_THREE: {
        const a = pop();
        const b = pop();
        const c = pop();
        s.push(a, c, b);
        return undefined;
      }
      case OP.LOAD_CONST:
        s.push(f.consts[arg] as PyValue);
        return undefined;
      case OP.LOAD_FAST: {
        const v = f.locals[arg];
        if (v === undefined) throw pyError(PY_EXC.UnboundLocalError, `cannot access local variable '${f.code.varnames[arg]}' where it is not associated with a value`);
        s.push(v);
        return undefined;
      }
      case OP.STORE_FAST:
        f.locals[arg] = pop();
        return undefined;
      case OP.DELETE_FAST:
        if (f.locals[arg] === undefined) throw pyError(PY_EXC.UnboundLocalError, `cannot access local variable '${f.code.varnames[arg]}' where it is not associated with a value`);
        f.locals[arg] = undefined;
        return undefined;
      case OP.LOAD_DEREF: {
        const v = (f.cells[arg] as PyCell).value;
        if (v === undefined) throw pyError(PY_EXC.NameError, `cannot access free variable '${this.cellName(f, arg)}' where it is not associated with a value in enclosing scope`);
        s.push(v);
        return undefined;
      }
      case OP.STORE_DEREF:
        (f.cells[arg] as PyCell).value = pop();
        return undefined;
      case OP.DELETE_DEREF:
        (f.cells[arg] as PyCell).value = undefined;
        return undefined;
      case OP.LOAD_CLOSURE:
        s.push(f.cells[arg] as unknown as PyValue);
        return undefined;
      case OP.LOAD_GLOBAL: {
        const name = f.code.names[arg] as string;
        const v = f.globals.has(name) ? f.globals.get(name) : this.builtins.get(name);
        if (v === undefined) throw pyError(PY_EXC.NameError, `name '${name}' is not defined`);
        s.push(v);
        return undefined;
      }
      case OP.STORE_GLOBAL:
        f.globals.set(f.code.names[arg] as string, pop());
        return undefined;
      case OP.DELETE_GLOBAL: {
        const name = f.code.names[arg] as string;
        if (!f.globals.delete(name)) throw pyError(PY_EXC.NameError, `name '${name}' is not defined`);
        return undefined;
      }
      case OP.LOAD_ATTR:
        s.push(this.getattr(pop(), f.code.names[arg] as string));
        return undefined;
      case OP.STORE_ATTR: {
        const obj = pop();
        this.setattr(obj, f.code.names[arg] as string, pop());
        return undefined;
      }
      case OP.DELETE_ATTR: {
        const obj = pop();
        const name = f.code.names[arg] as string;
        if (!((obj instanceof PyObject || obj instanceof PyException) && obj.attrs.delete(name))) throw pyError(PY_EXC.AttributeError, `'${pyTypeName(obj)}' object has no attribute ${pyStrRepr(name)}`);
        return undefined;
      }
      case OP.LOAD_SUBSCR: {
        const idx = pop();
        const item = pyGetItem(pop(), idx);
        // a slice is a copy (charged per item); an index reads an existing value
        s.push(idx instanceof PySliceValue ? this.charged(item) : item);
        return undefined;
      }
      case OP.STORE_SUBSCR: {
        const idx = pop();
        const obj = pop();
        this.setItem(obj, idx, pop());
        return undefined;
      }
      case OP.DELETE_SUBSCR: {
        const idx = pop();
        this.delItem(pop(), idx);
        return undefined;
      }
      case OP.BUILD_SLICE: {
        const step = pop();
        const stop = pop();
        s.push(new PySliceValue(pop(), stop, step));
        return undefined;
      }
      case OP.BINARY: {
        const b = pop();
        s.push(this.charged(pyBinary(PY_BINARY_OPS[arg] as string, pop(), b)));
        return undefined;
      }
      case OP.INPLACE: {
        const b = pop();
        const a = pop();
        if (a instanceof PyListValue && PY_BINARY_OPS[arg] === '+') {
          const add = this.items(b);
          checkLength(a.items.length + add.length);
          a.items.push(...add);
          s.push(a);
        } else s.push(this.charged(pyBinary(PY_BINARY_OPS[arg] as string, a, b)));
        return undefined;
      }
      case OP.UNARY:
        s.push(pyUnary(PY_UNARY_OPS[arg] as string, pop()));
        return undefined;
      case OP.COMPARE: {
        const b = pop();
        s.push(pyCompare(this, PY_COMPARE_OPS[arg] as string, pop(), b));
        return undefined;
      }
      case OP.JUMP:
        f.ip = arg;
        return undefined;
      case OP.POP_JUMP_IF_FALSE:
        if (!pyTruthy(pop())) f.ip = arg;
        return undefined;
      case OP.POP_JUMP_IF_TRUE:
        if (pyTruthy(pop())) f.ip = arg;
        return undefined;
      case OP.JUMP_IF_FALSE_OR_POP:
        if (!pyTruthy(s[s.length - 1] as PyValue)) f.ip = arg;
        else s.pop();
        return undefined;
      case OP.JUMP_IF_TRUE_OR_POP:
        if (pyTruthy(s[s.length - 1] as PyValue)) f.ip = arg;
        else s.pop();
        return undefined;
      case OP.GET_ITER:
        s.push(this.iterate(pop()));
        return undefined;
      case OP.FOR_ITER: {
        const v = (s[s.length - 1] as PyIterator).next();
        if (v === undefined) {
          s.pop();
          f.ip = arg;
        } else s.push(v);
        return undefined;
      }
      case OP.BUILD_LIST:
        s.push(new PyListValue(s.splice(s.length - arg, arg)));
        return undefined;
      case OP.BUILD_TUPLE:
        s.push(new PyTupleValue(s.splice(s.length - arg, arg)));
        return undefined;
      case OP.BUILD_SET: {
        const set = new PySetValue();
        for (const v of s.splice(s.length - arg, arg)) setAdd(set, v);
        s.push(set);
        return undefined;
      }
      case OP.BUILD_MAP: {
        const flat = s.splice(s.length - 2 * arg, 2 * arg);
        const d = new PyDictValue();
        for (let i = 0; i < flat.length; i += 2) pyDictSet(d, flat[i] as PyValue, flat[i + 1] as PyValue);
        s.push(d);
        return undefined;
      }
      case OP.LIST_APPEND: {
        const v = pop();
        const l = s[s.length - 1 - arg] as PyListValue;
        checkLength(l.items.length + 1);
        l.items.push(v);
        return undefined;
      }
      case OP.SET_ADD: {
        const v = pop();
        setAdd(s[s.length - 1 - arg] as PySetValue, v);
        return undefined;
      }
      case OP.MAP_ADD: {
        const v = pop();
        const k = pop();
        pyDictSet(s[s.length - 1 - arg] as PyDictValue, k, v);
        return undefined;
      }
      case OP.BUILD_STRING: {
        const parts = s.splice(s.length - arg, arg) as string[];
        const text = parts.join('');
        checkLength(text.length);
        s.push(text);
        return undefined;
      }
      case OP.FORMAT_VALUE: {
        const spec = (arg & PY_FORMAT_HAS_SPEC) !== 0 ? (pop() as string) : '';
        let v = pop();
        const conv = arg & 3;
        if (conv === 1) v = pyStr(v, this);
        else if (conv >= 2) v = pyRepr(v, this);
        s.push(pyCheckStr(pyFormat(v, spec)));
        return undefined;
      }
      case OP.UNPACK_SEQUENCE: {
        const items = this.items(pop());
        if (items.length < arg) throw valueError(`not enough values to unpack (expected ${arg}, got ${items.length})`);
        if (items.length > arg) throw valueError(`too many values to unpack (expected ${arg})`);
        for (let i = items.length - 1; i >= 0; i--) s.push(items[i] as PyValue);
        return undefined;
      }
      case OP.MAKE_FUNCTION: {
        const code = s.pop() as unknown as PyCode;
        const closure = (arg & PY_FN_CLOSURE) !== 0 ? ((pop() as PyTupleValue).items as unknown as PyCell[]) : [];
        const defaults = (arg & PY_FN_DEFAULTS) !== 0 ? (pop() as PyTupleValue).items : [];
        s.push(new PyFunction(code.name, code, f.globals, defaults, closure, this.nextId()));
        return undefined;
      }
      case OP.CALL:
      case OP.CALL_KW: {
        let kw: Map<string, PyValue> | undefined;
        let args: PyValue[];
        if (op === OP.CALL_KW) {
          const names = (s.pop() as unknown as { kwnames: readonly string[] }).kwnames;
          const all = s.splice(s.length - arg, arg);
          args = all.slice(0, all.length - names.length);
          kw = new Map(names.map((n, i) => [n, all[args.length + i] as PyValue]));
        } else args = s.splice(s.length - arg, arg);
        const fn = pop();
        const r = this.invoke(fn, args, kw);
        if (r === FRAME_PUSHED) return undefined;
        if (r instanceof PySuspend) {
          if (base > 0) throw pyError(PY_EXC.RuntimeError, MSG_PY_NESTED_IO);
          this.pending = { io: r.io, resume: r.resume };
          return { kind: 'suspend', io: r.io };
        }
        s.push(r);
        return undefined;
      }
      case OP.RETURN_VALUE: {
        const v = pop();
        this.frames.pop();
        if (this.frames.length <= base) return { kind: 'return', value: v };
        this.top().stack.push(v);
        return undefined;
      }
      case OP.IMPORT_NAME:
        s.push(this.importModule(f.code.names[arg] as string));
        return undefined;
      case OP.IMPORT_FROM: {
        const mod = s[s.length - 1] as PyObject;
        const name = f.code.names[arg] as string;
        const v = mod.attrs.get(name);
        if (v !== undefined) {
          s.push(v);
          return undefined;
        }
        const modName = pyStr(mod.attrs.get('__name__') ?? '?');
        try {
          s.push(this.importModule(`${modName}.${name}`));
        } catch (e) {
          if (!(e instanceof PyError) || e.exc.type !== PY_EXC.ModuleNotFoundError) throw e;
          throw pyError(PY_EXC.ImportError, `cannot import name '${name}' from '${modName}'`);
        }
        return undefined;
      }
      case OP.SETUP_EXCEPT:
      case OP.SETUP_FINALLY:
        f.blocks.push({ handler: arg, depth: s.length, excDepth: f.handling.length });
        return undefined;
      case OP.POP_BLOCK:
        f.blocks.pop();
        return undefined;
      case OP.EXC_MATCH: {
        const spec = pop();
        s.push(this.excMatches(pop(), spec));
        return undefined;
      }
      case OP.BEGIN_HANDLER:
        f.handling.push(pop() as PyException);
        return undefined;
      case OP.END_HANDLER:
        f.handling.pop();
        return undefined;
      case OP.LOAD_EXC:
        s.push(f.handling[f.handling.length - 1] as PyException);
        return undefined;
      case OP.RAISE: {
        if (arg === 0) {
          const cur = f.handling[f.handling.length - 1];
          if (cur === undefined) throw pyError(PY_EXC.RuntimeError, 'No active exception to reraise');
          throw new PyError(cur);
        }
        return this.raiseValue(pop());
      }
      case OP.RERAISE:
        throw new PyError(pop() as PyException);
      case OP.LOAD_ASSERTION_ERROR:
        s.push(PY_EXC.AssertionError);
        return undefined;
      default:
        throw new Error(`nf-py: unknown opcode ${op}`);
    }
  }

  private cellName(f: Frame, i: number): string {
    const c = f.code.cellvars;
    return i < c.length ? (c[i] as string) : (f.code.freevars[i - c.length] as string);
  }

  private setItem(obj: PyValue, idx: PyValue, v: PyValue): void {
    if (obj instanceof PyListValue) {
      if (idx instanceof PySliceValue) {
        const [start, stop, step, count] = sliceIndices(idx, obj.items.length);
        const items = this.items(v);
        if (step === 1) {
          obj.items.splice(start, Math.max(0, stop - start), ...items);
          checkLength(obj.items.length);
          return;
        }
        if (items.length !== count) throw valueError(`attempt to assign sequence of size ${items.length} to extended slice of size ${count}`);
        for (let i = 0; i < count; i++) obj.items[start + i * step] = items[i] as PyValue;
        return;
      }
      obj.items[seqIndex(obj.items.length, idx, 'list assignment')] = v;
      return;
    }
    if (obj instanceof PyDictValue) {
      pyDictSet(obj, idx, v);
      return;
    }
    throw typeError(`'${pyTypeName(obj)}' object does not support item assignment`);
  }

  private delItem(obj: PyValue, idx: PyValue): void {
    if (obj instanceof PyListValue) {
      if (idx instanceof PySliceValue) {
        const [start, , step, count] = sliceIndices(idx, obj.items.length);
        const drop = new Set<number>();
        for (let i = 0; i < count; i++) drop.add(start + i * step);
        obj.items = obj.items.filter((_, i) => !drop.has(i));
        return;
      }
      obj.items.splice(seqIndex(obj.items.length, idx, 'list assignment'), 1);
      return;
    }
    if (obj instanceof PyDictValue) {
      if (!obj.entries.delete(pyKey(idx, obj.caseless))) throw new PyError(new PyException(PY_EXC.KeyError, [idx]));
      return;
    }
    throw typeError(`'${pyTypeName(obj)}' object does not support item deletion`);
  }
}

/** A machine ready to run `program` (its first `run` starts the module body). */
export function createPyVm(program: PyProgram, opts: PyVmOptions): PyVm {
  return new Machine(program, opts.env, opts.argv ?? [program.filename]);
}

/** A machine that failed before it ran (a syntax error): every `run` returns that failure. */
export function createFailedPyVm(failure: PyFailure): PyVm {
  return {
    state: 'failed',
    run: () => ({ state: 'failed', output: '', steps: 0, error: failure }),
    resume: () => {
      throw new Error('nf-py: resume() on a failed run');
    },
    stats: () => ({ steps: 0, requests: 0, sleptNs: 0, outputChars: 0 }),
  };
}
