/**
 * [S32] NF-Py: the bytecode compiler, the resumable VM and the library (ARCHITECTURE-P3 D21 "[S32] NF-Py", §3.8 step 8,
 * §4.1, §4.2; §7 W2 auto).
 *
 * Pure: every script runs against a FAKE I/O host (no simulation): the host answers each suspension — an HTTP request
 * becomes the `http.request` the W3 script host will send, a sleep advances the fake clock. Pinned: Python 3 semantics
 * of the subset (numbers with int and float kept apart, text, containers, scopes and closures, exceptions with
 * try/except/else/finally and tracebacks), the compiler's own syntax rules, the `json`, requests-style and `time`
 * modules, suspension and resumption, slicing by quantum, every cap (steps, requests, sleep, call depth, length, output),
 * and determinism. Lab 40's inventory script runs end to end against a fake RESTCONF host.
 */
import { describe, expect, it } from 'vitest';
import type { HttpResultEvent } from '../src/contracts/transport.js';
import { compilePy, disassemblePy, MSG_BREAK_OUTSIDE, MSG_CONTINUE_OUTSIDE, MSG_RETURN_OUTSIDE, PY_OP, type PyCode } from '../src/automation/py/compiler.js';
import {
  encodeBase64,
  pyIoHttpRequest,
  pyIoResultOfHttp,
  pyJsonDumps,
  PY_MODULE_NAMES,
  PY_USER_AGENT,
  pyStandardEnvironment,
  startPyScript,
} from '../src/automation/py/lib.js';
import {
  createPyVm,
  MSG_INT_OVERFLOW,
  MSG_PY_DEPTH_COMPARE,
  MSG_PY_DEPTH_HASH,
  MSG_PY_DEPTH_JSON,
  MSG_PY_DEPTH_REPR,
  MSG_PY_EXC_TEXT_FAILED,
  MSG_PY_INTERNAL,
  MSG_PY_LENGTH,
  MSG_PY_NESTED_IO,
  MSG_PY_OUTPUT,
  MSG_PY_REQUESTS,
  MSG_PY_SLEEP,
  MSG_PY_STEPS,
  PY_MAX_CALL_DEPTH,
  PY_MAX_OUTPUT_CHARS,
  PY_MAX_REQUESTS,
  PY_MAX_STEPS,
  PY_MAX_VALUE_DEPTH,
  PY_QUANTUM,
  pyFloatRepr,
  pyFormat,
  pyRoundFloat,
  type PyClock,
  type PyFailure,
  type PyIoRequest,
  type PyIoResult,
  type PyRunState,
  type PyStats,
  type PyValue,
} from '../src/automation/py/vm.js';

type HttpIo = Extract<PyIoRequest, { kind: 'http' }>;
type HttpAnswer = Extract<PyIoResult, { kind: 'http' }>;

interface Run {
  readonly state: PyRunState;
  readonly output: string;
  readonly error?: PyFailure;
  readonly waits: PyIoRequest[];
  readonly slices: number;
  readonly stats: PyStats;
}

interface FakeHost {
  /** Answers an HTTP request (default: 200 with an empty JSON object). */
  readonly http?: (io: HttpIo) => HttpAnswer;
  readonly clock?: PyClock;
  readonly quantum?: number;
  readonly argv?: readonly string[];
}

const START_CLOCK: PyClock = { unixMs: 1_700_000_000_000, monotonicNs: 5_000_000_000 };

/** Runs a script to its end against the fake host, as the script host will: slice by slice, answering every suspension. */
function run(source: string, host: FakeHost = {}): Run {
  const vm = startPyScript(source, { file: 'test.py', ...(host.argv !== undefined ? { argv: host.argv } : {}) });
  let clock = host.clock ?? START_CLOCK;
  const waits: PyIoRequest[] = [];
  let output = '';
  let slices = 0;
  let s = vm.run({ clock, ...(host.quantum !== undefined ? { quantum: host.quantum } : {}) });
  for (;;) {
    slices++;
    output += s.output;
    if (s.state === 'running') {
      clock = { ...clock, monotonicNs: clock.monotonicNs + 1_000_000 }; // the host's 1 ms between slices (§4.2)
    } else if (s.state === 'waiting') {
      const io = s.io!;
      waits.push(io);
      if (io.kind === 'sleep') {
        clock = { unixMs: clock.unixMs + Math.floor(io.ns / 1_000_000), monotonicNs: clock.monotonicNs + io.ns };
        vm.resume({ kind: 'sleep' });
      } else vm.resume(host.http?.(io) ?? { kind: 'http', status: 200, reason: 'OK', headers: [['Content-Type', 'application/json']], body: '{}' });
    } else break;
    if (slices > 10_000) throw new Error('the script did not end');
    s = vm.run({ clock, ...(host.quantum !== undefined ? { quantum: host.quantum } : {}) });
  }
  return { state: s.state, output, ...(s.error !== undefined ? { error: s.error } : {}), waits, slices, stats: vm.stats() };
}

/** The output of a script that must complete. */
function out(source: string, host?: FakeHost): string {
  const r = run(source, host);
  if (r.state !== 'completed') throw new Error(`${r.state}: ${r.error?.traceback ?? ''}\n--- output ---\n${r.output}`);
  return r.output;
}

/** The last traceback line of a script that must fail. */
function fails(source: string, host?: FakeHost): string {
  const r = run(source, host);
  expect(r.state, r.output).toBe('failed');
  return r.error!.last;
}

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

describe('NF-Py compiler', () => {
  it('compiles every construct of the subset into code objects with names, parameters, cells and free variables', () => {
    const r = compilePy(lines(
      'def outer(a, b=2):',
      '    total = a',
      '    def inner(c):',
      '        return total + c',
      '    return inner',
      'squares = [x * x for x in range(3)]',
      'f = lambda y: y',
    ), 'prog.py');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mod = r.program.code;
    expect(mod).toMatchObject({ name: '<module>', filename: 'prog.py', params: [] });
    const codes = mod.consts.filter((c): c is PyCode => c !== null && typeof c === 'object' && 'kind' in c);
    expect(codes.map((c) => c.name)).toEqual(['outer', '<listcomp>', '<lambda>']);
    const outer = codes[0]!;
    expect(outer).toMatchObject({ params: ['a', 'b'], ndefaults: 1, cellvars: ['total'], freevars: [], firstLine: 1 });
    const inner = outer.consts.find((c): c is PyCode => c !== null && typeof c === 'object' && 'kind' in c)!;
    expect(inner).toMatchObject({ name: 'inner', params: ['c'], freevars: ['total'], cellvars: [] });
    expect(codes[1]).toMatchObject({ params: ['.0'], varnames: ['.0', 'x'] });
    // module names are globals, never cells; every instruction carries its source line
    expect(mod.ops.includes(PY_OP.STORE_GLOBAL)).toBe(true);
    expect(mod.lines.length).toBe(mod.ops.length);
    expect(disassemblePy(mod)[0]).toMatch(/^\s+0\s+1 LOAD_CONST \d+$/);
  });

  it('refuses break, continue and return where Python does, with the line and column', () => {
    // the parser refuses them first; the compiler's guards use the same wording
    const err = (src: string) => {
      const r = compilePy(src);
      return r.ok ? undefined : r.error;
    };
    expect(err('x = 1\nbreak\n')).toMatchObject({ type: 'SyntaxError', message: MSG_BREAK_OUTSIDE, line: 2, column: 1 });
    expect(err('if True:\n    continue\n')).toMatchObject({ type: 'SyntaxError', message: MSG_CONTINUE_OUTSIDE, line: 2, column: 5 });
    expect(err('for i in range(2):\n    def f():\n        break\n')).toMatchObject({ message: MSG_BREAK_OUTSIDE, line: 3 });
    expect(err('return 5\n')).toMatchObject({ type: 'SyntaxError', message: MSG_RETURN_OUTSIDE, line: 1 });
    expect(err('def f(a):\n    global a\n')).toMatchObject({ type: 'SyntaxError', line: 2 });
    // a parser error comes back unchanged
    expect(err('print(1')).toMatchObject({ type: 'SyntaxError', line: 1 });
  });

  it('a syntax error gives a failed machine with a Python-style traceback and a caret', () => {
    const r = run('x = 1\nif x > 0\n    print(x)\n');
    expect(r.state).toBe('failed');
    expect(r.error!.type).toBe('SyntaxError');
    expect(r.error!.line).toBe(2);
    expect(r.error!.traceback.split('\n').slice(0, 3)).toEqual(['  File "test.py", line 2', '    if x > 0', `    ${' '.repeat(r.error!.traceback.split('\n')[2]!.indexOf('^') - 4)}^`]);
    expect(r.error!.last).toBe(`SyntaxError: ${r.error!.message}`);
    expect(r.output).toBe('');
  });
});

describe('NF-Py values and operators', () => {
  it('keeps int and float apart, prints floats as Python does, and stops ints at 2^53 - 1', () => {
    expect(out(lines(
      'print(7 / 2, 7 // 2, -7 // 2, -7 % 3, 7 % -3, 2 ** 10, 2 ** -1)',
      'print(1 / 3, 0.1 + 0.2, 1e16, 1e-5, 10 ** 15 * 1.0, float(2), 2.5e-4, 123.456)',
      'print(True + 1, 3 == 3.0, 1 == True, int("42") + int(3.9), int("-0x1F", 16), float("1.5"), abs(-3), abs(-2.0))',
      'print(round(0.5), round(1.5), round(2.5), round(2.675, 2), round(1234, -2), divmod(-7, 2), 5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 40, -9 >> 1)',
      'print(type(1), type(1.0), type("s"), type(None), isinstance(True, int), 9007199254740991)',
    ))).toBe(lines(
      '3.5 3 -4 2 -2 1024 0.5',
      '0.3333333333333333 0.30000000000000004 1e+16 1e-05 1000000000000000.0 2.0 0.00025 123.456',
      '2 True True 45 -31 1.5 3 2.0',
      '0 2 2 2.67 1200 (-4, 1) 1 7 6 -6 1099511627776 -5',
      "<class 'int'> <class 'float'> <class 'str'> <class 'NoneType'> True 9007199254740991",
    ));
    expect(fails('print(9007199254740991 + 1)')).toBe(`OverflowError: ${MSG_INT_OVERFLOW}`);
    expect(fails('print(2 ** 53)')).toBe(`OverflowError: ${MSG_INT_OVERFLOW}`);
    expect(fails('print(1 / 0)')).toBe('ZeroDivisionError: division by zero');
    expect(fails('print(5 % 0)')).toBe('ZeroDivisionError: integer division or modulo by zero');
    expect(fails('print("a" + 1)')).toBe('TypeError: can only concatenate str (not "int") to str');
    expect(fails('print(1 < "a")')).toBe("TypeError: '<' not supported between instances of 'int' and 'str'");
  });

  it('formats text: f-strings with conversions and specs, str.format, % and the str methods', () => {
    expect(out(lines(
      'x = 3.14159',
      'name = "sw1"',
      'print(f"{x:.2f}|{42:>5}|{name:<5}|{1234567:,}|{255:#x}|{name!r}|{7:03d}|{0.5:.1%}|{-3:+d}|{x:e}|{name:^7}|{12.0}")',
      'print("{} {n} {0}".format("a", n=2), "{:>4}".format("b"), "{0[k]}".format({"k": "v"}))',
      'print("%s is %d (%5.1f) %r %x %%" % ("a", 3, 3.14159, "q", 255))',
      'print("%(a)s-%(b)03d" % {"a": "x", "b": 7})',
      's = "  Gi0/1, Gi0/2 ,Vlan1  "',
      'print([p.strip() for p in s.split(",")], s.strip().upper(), "a-b-c".split("-", 1), "a b  c".split(), "a,b".rsplit(",", 1))',
      'print("-".join(["x", "y"]), "abc".replace("b", "B"), "Gi0/1".startswith(("Fa", "Gi")), "abcabc".find("c"), "abcabc".count("bc"))',
      'print("7".zfill(3), "ab".center(6, "*"), "x=1".partition("="), "Hello World".lower().title(), "abc"[::-1], "abc"[-1], "héllo"[1:3])',
      'print(len("héllo"), "lo" in "hello", str(None), repr("it\'s"), ord("A"), chr(233), hex(255), bin(5), oct(8))',
    ))).toBe(lines(
      "3.14|   42|sw1  |1,234,567|0xff|'sw1'|007|50.0%|-3|3.141590e+00|  sw1  |12.0",
      'a 2 a    b v',
      "a is 3 (  3.1) 'q' ff %",
      'x-007',
      "['Gi0/1', 'Gi0/2', 'Vlan1'] GI0/1, GI0/2 ,VLAN1 ['a', 'b-c'] ['a', 'b', 'c'] ['a', 'b']",
      'x-y aBc True 2 2',
      "007 **ab** ('x', '=', '1') Hello World cba c él",
      '5 True None "it\'s" 65 é 0xff 0b101 0o10',
    ));
    // the pure formatters agree with Python
    expect(pyFloatRepr(0.1)).toBe('0.1');
    expect(pyFloatRepr(-0)).toBe('-0.0');
    expect(pyFloatRepr(1e22)).toBe('1e+22');
    expect(pyFloatRepr(123456789012345.6)).toBe('123456789012345.6');
    expect(pyRoundFloat(0.125, 2)).toBe(0.12);
    expect(pyFormat('ab', '>4')).toBe('  ab');
  });

  it('builds and reads containers: lists, tuples, dicts (insertion order), sets, ranges, slices, unpacking, del', () => {
    expect(out(lines(
      'l = [3, 1, 2]',
      'l.append(5); l.insert(0, 9); l.extend((7, 8))',
      'print(l, l[1:3], l[::-1], l[-2:], len(l), l.index(2), sorted(l), sorted(l, reverse=True), l.pop(), l)',
      'l[0:2] = ["a"]; del l[-1]',
      'print(l, l * 2 if len(l) < 3 else l[:2], [0] * 3, (1,), (1, 2) + (3,), list(range(2, 9, 3)), range(5)[1:3])',
      'd = {"b": 1, "a": 2}',
      'd["c"] = 3; d["b"] += 10',
      'print(d, list(d), list(d.keys()), list(d.values()), list(d.items()), d.get("z", 0), "a" in d, d.pop("a"), d)',
      'for k, v in sorted(d.items()):',
      '    print(k, v)',
      's = {3, 1}',
      's.add(2); s.add(3)',
      'print(s, {1, 2} | {2, 3}, {1, 2} & {2, 3}, {1, 2} - {2}, len(s), 2 in s, set(), dict(a=1), dict([("k", "v")]))',
      'a, b = 1, 2',
      'a, b = b, a',
      '(c, d2), e = [3, 4], 5',
      'print(a, b, c, d2, e, {k: v * 2 for k, v in {"x": 1}.items()}, {n % 3 for n in range(6)}, sum(x * x for x in range(4)))',
      'print(list(enumerate("ab", 1)), list(zip([1, 2, 3], "xy")), list(map(str, [1, 2])), list(filter(None, [0, 1, "", "a"])), any([0, 1]), all([]))',
      'print(min([4, 2, 8]), max("abc"), min([("b", 2), ("a", 9)], key=lambda p: p[1]), max([], default=None), [1, 2] == [1, 2], (1, 2) < (1, 3), [1, [2]])',
    ))).toBe(lines(
      // print() shows each object as it is once every argument was evaluated: `l` after the pop, `d` after its pop
      '[9, 3, 1, 2, 5, 7] [3, 1] [8, 7, 5, 2, 1, 3, 9] [7, 8] 7 3 [1, 2, 3, 5, 7, 8, 9] [9, 8, 7, 5, 3, 2, 1] 8 [9, 3, 1, 2, 5, 7]',
      "['a', 1, 2, 5] ['a', 1] [0, 0, 0] (1,) (1, 2, 3) [2, 5, 8] range(1, 3)",
      "{'b': 11, 'c': 3} ['b', 'a', 'c'] ['b', 'a', 'c'] [11, 2, 3] [('b', 11), ('a', 2), ('c', 3)] 0 True 2 {'b': 11, 'c': 3}",
      'b 11',
      'c 3',
      '{3, 1, 2} {1, 2, 3} {2} {1} 3 True set() {\'a\': 1} {\'k\': \'v\'}',
      "2 1 3 4 5 {'x': 2} {0, 1, 2} 14",
      "[(1, 'a'), (2, 'b')] [(1, 'x'), (2, 'y')] ['1', '2'] [1, 'a'] True True",
      "2 c ('b', 2) None True True [1, [2]]",
    ));
    expect(fails('d = {}\nprint(d["missing"])')).toBe("KeyError: 'missing'");
    expect(fails('print([1][3])')).toBe('IndexError: list index out of range');
    expect(fails('a, b = [1, 2, 3]')).toBe('ValueError: too many values to unpack (expected 2)');
    expect(fails('print({[1]: 2})')).toBe("TypeError: unhashable type: 'list'");
    expect(fails('d = {"a": 1}\nfor k in d:\n    d["b"] = 2')).toBe('RuntimeError: dictionary changed size during iteration');
    expect(fails('t = (1, 2)\nt[0] = 5')).toBe("TypeError: 'tuple' object does not support item assignment");
  });

  it('control flow: if/elif/else, while with break and continue, for over iterables, chained comparisons, and/or values', () => {
    expect(out(lines(
      'n = 0',
      'while True:',
      '    n += 1',
      '    if n % 2 == 0:',
      '        continue',
      '    if n > 6:',
      '        break',
      '    print("odd", n)',
      'for c in "ab":',
      '    for i in range(3):',
      '        if i == 1:',
      '            break',
      '        print(c, i)',
      'x = 15',
      'if x < 10:',
      '    print("small")',
      'elif x < 20:',
      '    print("medium")',
      'else:',
      '    print("large")',
      'print(1 < 2 < 3, 1 < 3 < 2, 0 or "x", 1 and 0, None or [] or "last", not 0, "yes" if x else "no")',
    ))).toBe(lines('odd 1', 'odd 3', 'odd 5', 'a 0', 'b 0', 'medium', 'True False x 0 last True yes'));
  });
});

describe('NF-Py functions and scopes', () => {
  it('binds arguments (defaults, keywords) with Python\'s errors; closures share cells; global; recursion', () => {
    expect(out(lines(
      'def f(a, b=2, c=3):',
      '    return a + b * c',
      'print(f(1), f(1, 1), f(1, c=10), f(c=1, b=1, a=1))',
      'def counter():',
      '    count = 0',
      '    def inc():',
      '        n = count + 1',
      '        return n',
      '    count = 41',
      '    return inc',
      'print(counter()())',
      'fs = [lambda: i for i in range(3)]',
      'print([g() for g in fs])',
      'total = 0',
      'def add(n):',
      '    global total',
      '    total += n',
      'add(5); add(6)',
      'print(total)',
      'def fact(n):',
      '    return 1 if n <= 1 else n * fact(n - 1)',
      'print(fact(10), (lambda a, b=1: a - b)(5), sorted(["bb", "a", "ccc"], key=len))',
      'def nested():',
      '    items = []',
      '    def push(v):',
      '        items.append(v)',
      '    push(1); push(2)',
      '    return items',
      'print(nested(), f.__name__)',
    ))).toBe(lines('7 4 21 2', '42', '[2, 2, 2]', '11', "3628800 4 ['a', 'bb', 'ccc']", '[1, 2] f'));
    expect(fails('def f(a, b):\n    pass\nf(1)')).toBe("TypeError: f() missing 1 required positional argument: 'b'");
    expect(fails('def f(a):\n    pass\nf(1, 2)')).toBe('TypeError: f() takes 1 positional argument but 2 were given');
    expect(fails('def f(a):\n    pass\nf(1, z=2)')).toBe("TypeError: f() got an unexpected keyword argument 'z'");
    expect(fails('x = 1\ndef f():\n    print(x)\n    x = 2\nf()')).toBe("UnboundLocalError: cannot access local variable 'x' where it is not associated with a value");
    expect(fails('print(undefined_name)')).toBe("NameError: name 'undefined_name' is not defined");
    expect(fails('x = 5\nx()')).toBe("TypeError: 'int' object is not callable");
  });
});

describe('NF-Py exceptions', () => {
  it('try/except/else/finally, `as` names cleared, nested handlers, bare raise, finally around return and break', () => {
    expect(out(lines(
      'def safe_div(a, b):',
      '    try:',
      '        r = a / b',
      '    except ZeroDivisionError as e:',
      '        print("caught:", e)',
      '        return None',
      '    else:',
      '        print("no error")',
      '        return r',
      '    finally:',
      '        print("cleanup")',
      'print(safe_div(1, 2))',
      'print(safe_div(1, 0))',
      'try:',
      '    {}["k"]',
      'except (IndexError, KeyError) as err:',
      '    print(type(err).__name__, err, err.args)',
      'try:',
      '    print(err)',
      'except NameError:',
      '    print("the name is cleared")',
      'def finally_wins():',
      '    try:',
      '        return 1',
      '    finally:',
      '        return 2',
      'print(finally_wins())',
      'for i in range(3):',
      '    try:',
      '        if i == 1:',
      '            break',
      '    finally:',
      '        print("finally", i)',
      'try:',
      '    try:',
      '        raise ValueError("inner")',
      '    except ValueError:',
      '        print("handled, then raised again")',
      '        raise',
      'except Exception as outer:',
      '    print("outer got", repr(outer))',
      'try:',
      '    int("x")',
      'except ValueError as e:',
      '    print(e)',
      'try:',
      '    assert 1 == 2, "nope"',
      'except AssertionError as e:',
      '    print("assert:", e)',
      'try:',
      '    raise KeyError',
      'except LookupError:',
      '    print("a KeyError is a LookupError")',
      'for i in range(3):',
      '    try:',
      '        if i == 0:',
      '            continue',
      '        raise RuntimeError(i)',
      '    except RuntimeError as e:',
      '        print("loop", e)',
      '        continue',
    ))).toBe(lines(
      'no error', 'cleanup', '0.5', 'caught: division by zero', 'cleanup', 'None', "KeyError 'k' ('k',)", 'the name is cleared', '2',
      'finally 0', 'finally 1', 'handled, then raised again', "outer got ValueError('inner')", "invalid literal for int() with base 10: 'x'",
      'assert: nope', 'a KeyError is a LookupError', 'loop 1', 'loop 2',
    ));
  });

  it('an uncaught exception ends the run with a "most recent call last" traceback naming each frame and line', () => {
    const r = run(lines('def check(v):', '    if v > 1:', '        raise ValueError(f"bad value {v}")', 'print("start")', 'check(1)', 'check(5)'));
    expect(r.state).toBe('failed');
    expect(r.output).toBe('start\n');
    expect(r.error).toEqual({
      type: 'ValueError',
      message: 'bad value 5',
      last: 'ValueError: bad value 5',
      line: 3,
      traceback: [
        'Traceback (most recent call last):',
        '  File "test.py", line 6, in <module>',
        '    check(5)',
        '  File "test.py", line 3, in check',
        '    raise ValueError(f"bad value {v}")',
        'ValueError: bad value 5',
      ].join('\n'),
    });
    expect(fails('raise RuntimeError')).toBe('RuntimeError');
    expect(fails('raise 5')).toBe('TypeError: exceptions must derive from BaseException');
    expect(fails('raise')).toBe('RuntimeError: No active exception to reraise');
  });

  it('sys.exit and exit end the run: 0 or None completes, anything else fails', () => {
    expect(run('import sys\nprint("a")\nsys.exit()\nprint("b")').output).toBe('a\n');
    expect(run('import sys\nsys.exit(0)').state).toBe('completed');
    const r = run('exit("stopped by the script")');
    expect([r.state, r.output, r.error?.last]).toEqual(['failed', 'stopped by the script\n', 'SystemExit: stopped by the script']);
    expect(run('import sys\nsys.exit(3)').error?.last).toBe('SystemExit: 3');
    // SystemExit is not an Exception
    expect(run('import sys\ntry:\n    sys.exit(0)\nexcept Exception:\n    print("caught")\n').output).toBe('');
  });
});

describe('NF-Py modules', () => {
  it('imports: the listed modules only; aliases, from-imports and submodules', () => {
    expect(PY_MODULE_NAMES).toEqual(['json', 'time', 'sys', 'math', 'requests', 'requests.exceptions', 'requests.auth', 'nfrequests']);
    expect(out(lines(
      'import json as j, math',
      'from json import dumps, loads',
      'import requests.exceptions',
      'from requests.exceptions import ConnectionError as CE',
      'import nfrequests',
      'import sys',
      'print(j.dumps([1]), dumps(loads("{}")), math.floor(2.7), math.sqrt(16), math.gcd(12, 18), math.pi)',
      'print(requests.exceptions.ConnectionError is CE, nfrequests.get.__name__, sys.argv, sys.platform, j)',
    ), { argv: ['a', 'b'] })).toBe(lines('[1] {} 2 4.0 6 3.141592653589793', "True get ['test.py', 'a', 'b'] netforge <module 'json'>"));
    // `import json as j` binds only the alias
    expect(fails('import json as j\nprint(json)')).toBe("NameError: name 'json' is not defined");
    expect(fails('import os')).toBe("ModuleNotFoundError: No module named 'os'");
    expect(fails('import random')).toBe("ModuleNotFoundError: No module named 'random'");
    expect(fails('from json import nothing')).toBe("ImportError: cannot import name 'nothing' from 'json'");
    expect(fails('print(open("x"))')).toBe('OSError: NF-Py scripts cannot open files in this release');
    expect(fails('import math\nmath.sqrt(-1)')).toBe('ValueError: math domain error');
  });

  it('json: loads keeps member order and tells int from float; dumps writes Python\'s text; errors carry the position', () => {
    expect(out(lines(
      'import json',
      'doc = json.loads(\'{"b": 1, "a": [1.0, 2.5e1, true, null, "\\\\u00e9"], "10": {}}\')',
      'print(doc, type(doc["a"][0]).__name__)',
      'print(json.dumps(doc))',
      'print(json.dumps(doc, indent=2, sort_keys=True))',
      'print(json.dumps({"k": [1, 2]}, separators=(",", ":")), json.dumps("é"), json.dumps("é", ensure_ascii=False), json.dumps((1, None, False, 0.5)))',
      'try:',
      '    json.loads(\'{"a": }\')',
      'except json.JSONDecodeError as e:',
      '    print(type(e).__name__, e.lineno, e.colno, isinstance(e, ValueError))',
    ))).toBe(lines(
      "{'b': 1, 'a': [1.0, 25.0, True, None, 'é'], '10': {}} float",
      '{"b": 1, "a": [1.0, 25.0, true, null, "\\u00e9"], "10": {}}',
      '{',
      '  "10": {},',
      '  "a": [',
      '    1.0,',
      '    25.0,',
      '    true,',
      '    null,',
      '    "\\u00e9"',
      '  ],',
      '  "b": 1',
      '}',
      '{"k":[1,2]} "\\u00e9" "é" [1, null, false, 0.5]',
      'JSONDecodeError 1 7 True',
    ));
    expect(fails('import json\njson.dumps({1, 2})')).toBe('TypeError: Object of type set is not JSON serializable');
    expect(pyJsonDumps(null, { sortKeys: false, ascii: true, itemSep: ', ', keySep: ': ' })).toBe('null');
  });

  it('time: sleep suspends for the host\'s timer; time() reads the device clock, monotonic() the sim time', () => {
    const r = run(lines(
      'import time',
      't0 = time.monotonic()',
      'print(time.time(), time.monotonic_ns())',
      'time.sleep(1.5)',
      'time.sleep(0)',
      'print(round(time.monotonic() - t0, 3), time.time())',
    ));
    expect(r.state).toBe('completed');
    expect(r.waits).toEqual([{ kind: 'sleep', ns: 1_500_000_000 }, { kind: 'sleep', ns: 0 }]);
    expect(r.output).toBe(lines('1700000000.0 5000000000', '1.5 1700000001.5'));
    // wall-clock nanoseconds would pass NF-Py's 2^53 whole numbers, so the module has no time_ns
    expect(fails('import time\ntime.time_ns()')).toBe("AttributeError: module 'time' has no attribute 'time_ns'");
    expect(fails('import time\ntime.sleep(-1)')).toBe('ValueError: sleep length must be non-negative');
    expect(fails('import time\ntime.sleep("1")')).toBe('TypeError: sleep length must be a number, not str');
  });
});

describe('NF-Py requests-style client against a fake I/O host', () => {
  const JSON_BODY = '{"ietf-interfaces:interfaces": {"interface": [{"name": "Vlan1", "enabled": true}]}}';

  it('each call suspends the machine for one request: method, URL with params, headers, Basic auth, timeout, body', () => {
    const seen: HttpIo[] = [];
    const r = run(lines(
      'import requests',
      'url = "https://10.0.99.11/restconf/data/ietf-interfaces:interfaces"',
      'r = requests.get(url, auth=("admin", "Lab-Pass1"), headers={"Accept": "application/yang-data+json"}, params={"depth": 2}, verify=False, timeout=5)',
      'print(r, r.status_code, r.ok, r.reason, r.headers["content-type"], r.url)',
      'print(r.json()["ietf-interfaces:interfaces"]["interface"][0]["name"])',
      'requests.put("https://10.0.99.11/x", json={"id": 30, "name": "VOICE"})',
      'requests.post("https://10.0.99.11/y", data={"a": "b c"}, headers={"X-Trace": "1"})',
      'requests.request("delete", "https://10.0.99.11/z", auth=requests.auth.HTTPBasicAuth("u", "p"), timeout=(1, 2.5))',
      'requests.patch("https://10.0.99.11/w", data="raw text")',
      'print(requests.head("https://10.0.99.11/").status_code)',
    ), { http: (io) => {
      seen.push(io);
      return { kind: 'http', status: 200, reason: 'OK', headers: [['Content-Type', 'application/yang-data+json'], ['Connection', 'close']], body: io.method === 'GET' ? JSON_BODY : '' };
    } });
    expect(r.state).toBe('completed');
    expect(r.output).toBe(lines('<Response [200]> 200 True OK application/yang-data+json https://10.0.99.11/restconf/data/ietf-interfaces:interfaces?depth=2', 'Vlan1', '200'));
    const basic = `Basic ${encodeBase64(new TextEncoder().encode('admin:Lab-Pass1'))}`;
    expect(basic).toBe(`Basic ${Buffer.from('admin:Lab-Pass1').toString('base64')}`);
    expect(seen).toEqual([
      {
        kind: 'http', method: 'GET', url: 'https://10.0.99.11/restconf/data/ietf-interfaces:interfaces?depth=2', timeoutNs: 5_000_000_000,
        headers: [['User-Agent', PY_USER_AGENT], ['Accept', 'application/yang-data+json'], ['Authorization', basic]],
      },
      { kind: 'http', method: 'PUT', url: 'https://10.0.99.11/x', body: '{"id": 30, "name": "VOICE"}', headers: [['User-Agent', PY_USER_AGENT], ['Content-Type', 'application/json'], ['Accept', '*/*']] },
      { kind: 'http', method: 'POST', url: 'https://10.0.99.11/y', body: 'a=b+c', headers: [['User-Agent', PY_USER_AGENT], ['X-Trace', '1'], ['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', '*/*']] },
      { kind: 'http', method: 'DELETE', url: 'https://10.0.99.11/z', timeoutNs: 3_500_000_000, headers: [['User-Agent', PY_USER_AGENT], ['Authorization', `Basic ${Buffer.from('u:p').toString('base64')}`], ['Accept', '*/*']] },
      { kind: 'http', method: 'PATCH', url: 'https://10.0.99.11/w', body: 'raw text', headers: [['User-Agent', PY_USER_AGENT], ['Accept', '*/*']] },
      { kind: 'http', method: 'HEAD', url: 'https://10.0.99.11/', headers: [['User-Agent', PY_USER_AGENT], ['Accept', '*/*']] },
    ]);
    expect(r.stats.requests).toBe(6);
  });

  it('transport errors raise the requests exceptions; raise_for_status raises HTTPError with the response', () => {
    const answers: Record<string, HttpAnswer> = {
      'https://a/': { kind: 'http', error: 'refused' },
      'https://b/': { kind: 'http', error: 'timeout' },
      'ftp://c/': { kind: 'http', error: 'bad-url' },
      'https://d/': { kind: 'http', status: 404, reason: 'Not Found', headers: [], body: '{"ietf-restconf:errors": {}}' },
      'https://e/': { kind: 'http', status: 200, reason: 'OK', headers: [], body: 'not json' },
    };
    expect(out(lines(
      'import requests',
      'from requests.exceptions import RequestException',
      'for url in ["https://a/", "https://b/", "ftp://c/"]:',
      '    try:',
      '        requests.get(url)',
      '    except RequestException as e:',
      '        print(type(e).__name__, "|", e)',
      'r = requests.get("https://d/")',
      'print(r.ok, r.status_code)',
      'try:',
      '    r.raise_for_status()',
      'except requests.exceptions.HTTPError as e:',
      '    print(e, e.response.status_code)',
      'try:',
      '    requests.get("https://e/").json()',
      'except requests.JSONDecodeError as e:',
      '    print("bad json:", isinstance(e, ValueError))',
      'try:',
      '    requests.get(42)',
      'except requests.exceptions.InvalidURL as e:',
      '    print("invalid:", e)',
    ), { http: (io) => answers[io.url]! })).toBe(lines(
      'ConnectionError | Could not connect to https://a/: the server refused the connection.',
      'Timeout | The request to https://b/ timed out.',
      "InvalidURL | Invalid URL 'ftp://c/': an address starts with http:// or https://",
      'False 404',
      '404 Client Error: Not Found for url: https://d/ 404',
      'bad json: True',
      'invalid: Invalid URL 42: the address must be a str',
    ));
    // uncaught: the qualified class name ends the traceback
    expect(fails('import requests\nrequests.get("https://a/")', { http: () => ({ kind: 'http', error: 'host-unreachable' }) }))
      .toBe('requests.exceptions.ConnectionError: Could not connect to https://a/: the server could not be reached (no answer to the address, or the name did not resolve).');
    // an error the answer raises lands in the frame that made the call and unwinds through its callers
    const nested = lines('import requests', 'def fetch(u):', '    return requests.get(u)', 'try:', '    fetch("https://a/")', 'except requests.ConnectionError:', '    print("caught in the caller")', 'fetch("https://b/")');
    const r = run(nested, { http: (io) => answers[io.url]! });
    expect(r.output).toBe('caught in the caller\n');
    expect(r.error?.traceback).toBe([
      'Traceback (most recent call last):',
      '  File "test.py", line 8, in <module>',
      '    fetch("https://b/")',
      '  File "test.py", line 3, in fetch',
      '    return requests.get(u)',
      'requests.exceptions.Timeout: The request to https://b/ timed out.',
    ].join('\n'));
    expect(fails('import requests\nrequests.request("TRACE", "https://a/")')).toMatch(/^ValueError: NF-Py sends GET, HEAD, POST, PUT, PATCH, DELETE requests; 'TRACE'/);
  });

  it('the host side: a request becomes http-client\'s `http.request`, and `http.result` becomes the answer', () => {
    const io: HttpIo = { kind: 'http', method: 'PUT', url: 'https://10.0.99.11/x', headers: [['Content-Type', 'application/json']], body: '{"é": 1}', timeoutNs: 2_000_000_000 };
    expect(pyIoHttpRequest(io, 'script-host', 'r1:3')).toEqual({
      kind: 'http.request', owner: 'script-host', token: 'r1:3', method: 'PUT', url: 'https://10.0.99.11/x',
      headers: [['Content-Type', 'application/json']], body: new TextEncoder().encode('{"é": 1}'), timeoutNs: 2_000_000_000,
    });
    expect(pyIoHttpRequest({ kind: 'http', method: 'GET', url: 'http://h/', headers: [] }, 'script-host', 't', 's1')).toEqual({ kind: 'http.request', owner: 'script-host', token: 't', method: 'GET', url: 'http://h/', headers: [], session: 's1' });
    const ok: HttpResultEvent = { kind: 'http.result', token: 't', status: 201, reason: 'Created', headers: [['A', 'b']], body: new TextEncoder().encode('é') };
    expect(pyIoResultOfHttp(ok)).toEqual({ kind: 'http', status: 201, reason: 'Created', headers: [['A', 'b']], body: 'é' });
    expect(pyIoResultOfHttp({ kind: 'http.result', token: 't', error: 'timeout' })).toEqual({ kind: 'http', error: 'timeout' });
  });

  it('runs lab 40\'s inventory script: strictly sequential requests, one skipped switch, the totals', () => {
    const INVENTORY = lines(
      '# Inventory the access switches through their API',
      'import requests',
      'import json',
      '',
      'SWITCHES = ["10.0.99.11", "10.0.99.12", "10.0.99.13"]',
      'AUTH = ("admin", "NetForge1")',
      'HEADERS = {"Accept": "application/yang-data+json"}',
      '',
      '',
      'def interfaces_of(address, timeout=5):',
      '    url = f"https://{address}/restconf/data/ietf-interfaces:interfaces"',
      '    reply = requests.get(url, auth=AUTH, headers=HEADERS, verify=False, timeout=timeout)',
      '    if reply.status_code != 200:',
      '        raise RuntimeError(f"{address} answered {reply.status_code}")',
      '    data = reply.json()',
      '    return data["ietf-interfaces:interfaces"]["interface"]',
      '',
      '',
      'up = 0',
      'for sw in SWITCHES:',
      '    try:',
      '        rows = interfaces_of(sw)',
      '    except RuntimeError as err:',
      '        print("skipped:", err)',
      '        continue',
      '    names = [row["name"] for row in rows if row.get("enabled", True)]',
      '    up += len(names)',
      '    print(f"{sw:<15} {len(names):>3} up  {\', \'.join(sorted(names))!s}")',
      'print("total up:", up)',
    );
    const iface = (name: string, enabled?: boolean): string => JSON.stringify({ name, type: 'iana-if-type:ethernetCsmacd', ...(enabled !== undefined ? { enabled } : {}) });
    const bodies: Record<string, HttpAnswer> = {
      '10.0.99.11': { kind: 'http', status: 200, reason: 'OK', headers: [['Content-Type', 'application/yang-data+json']], body: `{"ietf-interfaces:interfaces":{"interface":[${iface('Vlan1', true)},${iface('GigabitEthernet0/1')},${iface('FastEthernet0/2', false)}]}}` },
      '10.0.99.12': { kind: 'http', status: 401, reason: 'Unauthorized', headers: [], body: '' },
      '10.0.99.13': { kind: 'http', status: 200, reason: 'OK', headers: [], body: `{"ietf-interfaces:interfaces":{"interface":[${iface('Vlan99', true)}]}}` },
    };
    const go = (): Run => run(INVENTORY, { http: (io) => bodies[/^https:\/\/([^/]+)\//.exec(io.url)![1]!]! });
    const a = go();
    expect(a.state).toBe('completed');
    expect(a.output).toBe(lines(
      '10.0.99.11        2 up  GigabitEthernet0/1, Vlan1',
      'skipped: 10.0.99.12 answered 401',
      '10.0.99.13        1 up  Vlan99',
      'total up: 3',
    ));
    expect(a.waits.map((io) => (io.kind === 'http' ? `${io.method} ${io.url} ${io.timeoutNs}` : 'sleep'))).toEqual([
      'GET https://10.0.99.11/restconf/data/ietf-interfaces:interfaces 5000000000',
      'GET https://10.0.99.12/restconf/data/ietf-interfaces:interfaces 5000000000',
      'GET https://10.0.99.13/restconf/data/ietf-interfaces:interfaces 5000000000',
    ]);
    expect(a.stats.requests).toBe(3);
    // determinism: the same script and the same answers give the same run, byte for byte
    expect(JSON.stringify(go())).toBe(JSON.stringify(a));
  });
});

describe('NF-Py slices and caps', () => {
  it('runs in quanta: each slice executes at most `quantum` instructions and returns what it printed', () => {
    expect(PY_QUANTUM).toBe(10_000);
    const vm = startPyScript('for i in range(3):\n    print(i)\n', { file: 'q.py' });
    const first = vm.run({ quantum: 5 });
    expect(first).toMatchObject({ state: 'running', steps: 5 });
    let text = first.output;
    let s = first;
    let slices = 1;
    while (s.state === 'running') {
      s = vm.run({ quantum: 5 });
      text += s.output;
      slices++;
    }
    expect([s.state, text]).toEqual(['completed', '0\n1\n2\n']);
    expect(slices).toBe(Math.ceil(vm.stats().steps / 5));
    // a finished machine returns its state again and runs nothing
    expect(vm.run()).toEqual({ state: 'completed', output: '', steps: 0 });
  });

  it(`stops a run past ${PY_MAX_STEPS} instructions; no handler can catch a cap`, () => {
    const r = run('try:\n    while True:\n        pass\nexcept BaseException:\n    print("caught")\n', { quantum: 1_000_000 });
    expect(r.state).toBe('failed');
    expect(r.output).toBe('');
    // the line of the last instruction run (the loop test)
    expect(r.error).toMatchObject({ type: 'LimitExceeded', message: MSG_PY_STEPS, last: `LimitExceeded: ${MSG_PY_STEPS}`, line: 2 });
    expect(r.error!.traceback).toBe(`Traceback (most recent call last):\n  File "test.py", line 2, in <module>\n    while True:\nLimitExceeded: ${MSG_PY_STEPS}`);
    expect(r.stats.steps).toBe(PY_MAX_STEPS + 1);
  });

  it(`stops a run at its ${PY_MAX_REQUESTS + 1}th request and past 300 s of sleep`, () => {
    const many = run('import requests\nwhile True:\n    try:\n        requests.get("https://10.0.99.11/")\n    except Exception:\n        pass\n');
    expect(many.state).toBe('failed');
    expect(many.waits.length).toBe(PY_MAX_REQUESTS);
    expect(many.error?.last).toBe(`LimitExceeded: ${MSG_PY_REQUESTS}`);
    const sleepy = run('import time\nfor i in range(10):\n    time.sleep(60)\n');
    expect(sleepy.state).toBe('failed');
    expect(sleepy.waits.length).toBe(5);
    expect(sleepy.error?.last).toBe(`LimitExceeded: ${MSG_PY_SLEEP}`);
  });

  it('call depth raises RecursionError (catchable); huge values raise MemoryError; output past the cap is cut once', () => {
    expect(out(lines(
      'def down(n):',
      '    return down(n + 1)',
      'try:',
      '    down(0)',
      'except RecursionError as e:',
      '    print("recursion:", e)',
    ))).toBe('recursion: maximum recursion depth exceeded\n');
    expect(PY_MAX_CALL_DEPTH).toBe(100);
    expect(fails('s = "x" * 2000000')).toMatch(/^MemoryError: /);
    expect(fails('l = [0] * 2000000')).toMatch(/^MemoryError: /);
    const loud = run('for i in range(100):\n    print("y" * 999)\nprint("end")\n');
    expect(loud.state).toBe('completed');
    expect(loud.output.length).toBe(PY_MAX_OUTPUT_CHARS + MSG_PY_OUTPUT.length);
    expect(loud.output.endsWith(MSG_PY_OUTPUT)).toBe(true);
    expect(loud.stats.outputChars).toBe(PY_MAX_OUTPUT_CHARS);
  });

  it('a function a built-in calls cannot wait for I/O (a sort key that sleeps raises RuntimeError)', () => {
    expect(fails('import time\nsorted([2, 1], key=lambda v: time.sleep(v))')).toBe(`RuntimeError: ${MSG_PY_NESTED_IO}`);
    // ordinary keys and map functions run synchronously
    expect(out('print(sorted([3, 1, 2], key=lambda v: -v), list(map(lambda v: v * 2, [1, 2])))')).toBe('[3, 2, 1] [2, 4]\n');
  });

  it('resume() refuses a machine that is not waiting', () => {
    const vm = startPyScript('print(1)\n', { file: 'r.py' });
    expect(() => vm.resume({ kind: 'sleep' })).toThrow(/without a pending request/);
  });
});

describe('NF-Py native work and nesting (W2 fix, verified findings 0 and 1)', () => {
  it('a callback a builtin runs shares the quantum: the slice ends at the next instruction boundary, never mid-call', () => {
    const vm = startPyScript('x = list(map(lambda v: v + 1, range(200000)))\nprint(len(x), x[-1])\n', { file: 'm.py' });
    const first = vm.run();
    // the native call is whole (it cannot be resumed mid-way), then the slice ends: the script is not finished
    expect(first.state).toBe('running');
    expect(first.steps).toBeGreaterThan(4 * 200_000);
    const r = run('x = list(map(lambda v: v + 1, range(200000)))\nprint(len(x), x[-1])\n');
    expect([r.state, r.output]).toEqual(['completed', '200000 200000\n']);
    expect(r.slices).toBeGreaterThan(1);
    // the items map and list copy are charged too: 200 000 each, on top of the lambda's instructions
    expect(r.stats.steps).toBeGreaterThan(4 * 200_000 + 2 * 200_000);
  });

  it('the work of a builtin counts against the step cap: an index loop over a big list ends in a few slices', () => {
    const r = run('x = list(range(999999))\nwhile True:\n    x.index(999998)\n');
    expect(r.state).toBe('failed');
    expect(r.error?.last).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    expect(r.slices).toBeLessThanOrEqual(8);
    expect(r.stats.steps).toBeGreaterThan(PY_MAX_STEPS);
    expect(r.stats.steps).toBeLessThanOrEqual(PY_MAX_STEPS + 1_000_000);
    // a sort of a big list is charged per comparison: it cannot run past the cap either
    expect(fails('x = sorted(list(range(600000)), reverse=True)')).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    // `in` and == of big lists are charged the same way
    expect(fails('x = list(range(999999))\nwhile True:\n    999998 in x\n')).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    expect(fails('x = list(range(999999))\ny = list(range(999999))\nwhile True:\n    x == y\n')).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    // so are the copies an operator or a slice builds (an index reads an existing value and costs nothing more)
    expect(fails('x = list(range(999999))\nwhile True:\n    y = x[:]\n')).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    expect(fails('x = list(range(499999))\nwhile True:\n    y = x + x\n')).toBe(`LimitExceeded: ${MSG_PY_STEPS}`);
    const indexed = run('m = [list(range(1000))] * 3\nfor i in range(3):\n    r = m[i]\n');
    expect(indexed.state).toBe('completed');
    expect(indexed.stats.steps).toBeLessThan(1100); // list(range(1000)) is the one charge of 1000
  });

  it('sorts with a merge sort of its own: stable both ways, and a mixed list raises the same TypeError everywhere', () => {
    expect(out('print(sorted([(1, "b"), (0, "z"), (1, "a"), (0, "y")], key=lambda p: p[0]))')).toBe("[(0, 'z'), (0, 'y'), (1, 'b'), (1, 'a')]\n");
    expect(out('print(sorted([(1, "b"), (0, "z"), (1, "a"), (0, "y")], key=lambda p: p[0], reverse=True))')).toBe("[(1, 'b'), (1, 'a'), (0, 'z'), (0, 'y')]\n");
    expect(out('l = [5, 3, 9, 1, 7, 3]\nl.sort()\nprint(l, sorted("banana"), sorted([2.5, 1, True]))')).toBe("[1, 3, 3, 5, 7, 9] ['a', 'a', 'a', 'b', 'n', 'n'] [1, True, 2.5]\n");
    expect(fails('sorted([1, "a"])')).toBe("TypeError: '<' not supported between instances of 'str' and 'int'");
  });

  it('every str a builtin, % or a format builds is held to the cap, before an engine limit can be reached', () => {
    const memory = `MemoryError: ${MSG_PY_LENGTH}`;
    expect(fails('print(len(str(list(range(999999)))))')).toBe(memory);
    expect(fails('print(len(repr(list(range(999999)))))')).toBe(memory);
    expect(fails('print(len("".join(["abcdefgh"] * 999999)))')).toBe(memory);
    expect(fails('s = "x" * 999999\nprint(len("%s%s" % (s, s)))')).toBe(memory);
    expect(fails('s = "x" * 999999\nprint(len("{}{}".format(s, s)))')).toBe(memory);
    expect(fails('s = "x" * 999999\nprint(len(s.replace("x", "abcdefgh")))')).toBe(memory);
    expect(fails('d = {}\nfor i in range(300000):\n    d[i] = "value"\nprint(len(repr(d)))')).toBe(memory);
    expect(fails('print(len(f"{1:>999999999}"))')).toBe(memory);
    expect(fails('print(len("1".zfill(999999999)))')).toBe(memory);
    expect(fails('import json\nprint(len(json.dumps([1], indent=999999999)))')).toBe(memory);
    expect(fails('import json\nprint(len(json.dumps(list(range(999999)))))')).toBe(memory);
    // within the cap nothing changes, and a str exactly at the cap is fine
    expect(out('s = "x" * 999999\nprint(len(s + "y"), len("-".join(["ab"] * 3)), "abc".replace("", "-"), "abc".replace("", "-", 2))')).toBe('1000000 8 -a-b-c- -a-bc\n');
    expect(out('print(round(123.0, -400), round(-5.5, -400))')).toBe('0.0 -0.0\n');
  });

  it(`nesting past ${PY_MAX_VALUE_DEPTH} values raises a catchable RecursionError, the same at any caller depth`, () => {
    expect(PY_MAX_VALUE_DEPTH).toBe(500);
    const script = lines(
      'import json',
      'x = []',
      'y = []',
      't = ()',
      'for i in range(100000):',
      '    x = [x]',
      '    y = [y]',
      '    t = (t,)',
      'for name, f in [("str", lambda: str(x)), ("repr", lambda: repr({1: x})), ("eq", lambda: x == y), ("lt", lambda: x < y), ("json", lambda: json.dumps(x)), ("hash", lambda: {t: 1})]:',
      '    try:',
      '        f()',
      '        print(name, "ok")',
      '    except RecursionError as e:',
      '        print(name, e)',
      'print(len(str(json.loads("[" * 256 + "]" * 256))))',
    );
    const expected = [
      `str ${MSG_PY_DEPTH_REPR}`,
      `repr ${MSG_PY_DEPTH_REPR}`,
      `eq ${MSG_PY_DEPTH_COMPARE}`,
      `lt ${MSG_PY_DEPTH_COMPARE}`,
      `json ${MSG_PY_DEPTH_JSON}`,
      `hash ${MSG_PY_DEPTH_HASH}`,
      '512',
      '',
    ].join('\n');
    expect(out(script)).toBe(expected);
    // the same script from a JS stack 3000 frames deeper gives the same run, byte for byte (no engine stack involved)
    const deep = (n: number): string => (n === 0 ? out(script) : deep(n - 1));
    expect(deep(3000)).toBe(expected);
    // an uncaught exception whose own text cannot be built still fails cleanly, with Python's placeholder
    expect(fails('x = []\nfor i in range(1000):\n    x = [x]\nraise ValueError(x)')).toBe(`ValueError: ${MSG_PY_EXC_TEXT_FAILED}`);
  });

  it('anything else the engine throws ends the run with one fixed text, never escaping run() or the engine message', () => {
    const std = pyStandardEnvironment();
    const compiled = compilePy('print("before")\nexplode()\nprint("after")\n', 'x.py');
    if (!compiled.ok) throw new Error('the script compiles');
    for (const thrown of [new RangeError('Maximum call stack size exceeded'), new Error('too much recursion'), 'a bare value']) {
      const vm = createPyVm(compiled.program, {
        env: {
          builtins: (m) => {
            const b = std.builtins(m);
            b.set(
              'explode',
              m.native('explode', (): PyValue => {
                throw thrown;
              }),
            );
            return b;
          },
          module: (m, name) => std.module(m, name),
        },
      });
      const s = vm.run();
      expect(s.state).toBe('failed');
      expect(s.output).toBe('before\n');
      expect(s.error).toMatchObject({ type: 'LimitExceeded', message: MSG_PY_INTERNAL, last: `LimitExceeded: ${MSG_PY_INTERNAL}`, line: 2 });
      expect(JSON.stringify(s.error)).not.toMatch(/Maximum call stack|too much recursion|a bare value/);
    }
  });
});
