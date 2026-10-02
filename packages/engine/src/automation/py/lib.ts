/**
 * The NF-Py library (ARCHITECTURE-P3 D21 "[S32] NF-Py", §3.8 step 8, §4.1; §7 W2 auto [S32]): the builtins, the modules
 * a script may import, and the entry point the script host uses.
 *
 *   const vm = startPyScript(source, { file: 'inventory.py', argv: ['inventory.py'] });   // a syntax error → a failed vm
 *   …drive vm.run / vm.resume (see vm.ts); an HTTP request is `pyIoHttpRequest(io, …)` for http-client, and its
 *   `http.result` comes back through `pyIoResultOfHttp(ev)`.
 *
 * MODULES (fresh objects per run, so one script cannot change another's):
 *  - `json`: `loads` (RFC 8259 through `automation/data/json.ts`; a number with a point or an exponent is a float),
 *    `dumps` (Python's separators, `indent`, `sort_keys`, `ensure_ascii`), `JSONDecodeError`;
 *  - `requests` (the requests-style HTTP client; D23 names `nfrequests` as the fallback name, so both import the same
 *    module): `get`, `post`, `put`, `patch`, `delete`, `head`, `request` with `params`, `data`, `json`, `headers`,
 *    `auth=(user, password)` (HTTP Basic), `timeout` (seconds), `verify` (accepted: TLS is simulated); each call suspends
 *    the machine for one `http.request` of the host; the `Response` (`status_code`, `ok`, `reason`, `headers` — a
 *    dict whose keys ignore case — `text`, `content`, `url`, `json()`, `raise_for_status()`) and the exceptions in
 *    `requests.exceptions` (`RequestException`, `ConnectionError`, `Timeout`, `HTTPError`, `InvalidURL`,
 *    `JSONDecodeError`); `requests.auth.HTTPBasicAuth(user, password)`;
 *  - `time`: `sleep` (suspends: the host's non-periodic `script-sleep:<run>` timer), `time` (the device clock the host
 *    passes in; no `time_ns`, whose value is beyond NF-Py's 2^53 whole numbers), `monotonic`/`monotonic_ns`/
 *    `perf_counter` (sim time);
 *  - `sys`: `argv`, `exit`, `stdout`/`stderr` (both print to the run's output), `version`, `platform`;
 *  - `math`: `floor`, `ceil`, `trunc`, `sqrt`, `fabs`, `gcd`, `isnan`, `isinf`, `isfinite`, `pi`, `e`, `inf`, `nan`.
 * There is no `random`, no file or socket access and no other module (§4.1): `import os` is ModuleNotFoundError.
 *
 * Pure: the host is the only way out, through suspensions. The library's own classes (`json.JSONDecodeError`, the
 * requests exceptions, `Response`) are built once, lazily, on first use (rule 12) and never change.
 */
import type { HttpMethod, ProcessRequest } from '../../contracts/process.js';
import type { SessionId } from '../../contracts/ids.js';
import type { HttpResultEvent } from '../../contracts/transport.js';
import { parseJson, type DataNode } from '../data/json.js';
import { compilePy } from './compiler.js';
import type { PySyntaxError } from './lexer.js';
import {
  createFailedPyVm,
  createPyVm,
  PY_BOOL,
  PY_DICT_T,
  PY_EXC,
  PY_FLOAT_T,
  PY_INT,
  PY_LIST_T,
  PY_MODULE_T,
  PY_OBJECT,
  PY_RANGE_T,
  PY_SET_T,
  PY_MAX_LENGTH,
  PY_MAX_VALUE_DEPTH,
  MSG_PY_DEPTH_JSON,
  MSG_PY_LENGTH,
  PY_STR,
  PY_TUPLE_T,
  PY_TYPE_T,
  pyArgs,
  pyBinary,
  pyCheckInt,
  pyDict,
  pyDictSet,
  pyError,
  PyDictValue,
  PyDictView,
  PyError,
  PyException,
  PyFloat,
  pyFloatRepr,
  pyFormat,
  PyFunction,
  PyBuiltin,
  pyIsSubtype,
  PyIterator,
  pyLen,
  pyLt,
  PyListValue,
  PyObject,
  PyRange,
  pyRepr,
  pyRoundFloat,
  PySetValue,
  pySort,
  pyStr,
  pyStrRepr,
  PySuspend,
  pyTruthy,
  PyTupleValue,
  PyType,
  pyTypeName,
  pyTypeOf,
  type PyEnvironment,
  type PyFailure,
  type PyIoRequest,
  type PyIoResult,
  type PyKwargs,
  type PyMachine,
  type PyMeter,
  type PyNative,
  type PyValue,
  type PyVm,
} from './vm.js';

// ── the library's classes (built once, on first use) ────────────────────────

interface LibTypes {
  readonly JSONDecodeError: PyType;
  readonly RequestException: PyType;
  readonly ConnectionError: PyType;
  readonly Timeout: PyType;
  readonly HTTPError: PyType;
  readonly InvalidURL: PyType;
  readonly RequestsJSONDecodeError: PyType;
  readonly Response: PyType;
  readonly TextIO: PyType;
}

let libTypesCache: LibTypes | undefined;

/** The library's classes (rule 12: built on first use; frozen, identical for every run). */
function libTypes(): LibTypes {
  if (libTypesCache !== undefined) return libTypesCache;
  const tp = (name: string, base: PyType, module: string): PyType => Object.freeze(new PyType(name, base, module));
  const JSONDecodeError = tp('JSONDecodeError', PY_EXC.ValueError, 'json');
  const RequestException = tp('RequestException', PY_EXC.OSError, 'requests.exceptions');
  libTypesCache = Object.freeze({
    JSONDecodeError,
    RequestException,
    ConnectionError: tp('ConnectionError', RequestException, 'requests.exceptions'),
    Timeout: tp('Timeout', RequestException, 'requests.exceptions'),
    HTTPError: tp('HTTPError', RequestException, 'requests.exceptions'),
    InvalidURL: tp('InvalidURL', RequestException, 'requests.exceptions'),
    RequestsJSONDecodeError: tp('JSONDecodeError', JSONDecodeError, 'requests.exceptions'),
    Response: tp('Response', PY_OBJECT, 'requests'),
    TextIO: tp('TextIOWrapper', PY_OBJECT, 'io'),
  });
  return libTypesCache;
}

/** The module name of the requests-style client, and the fallback name D23 reserves (both import the same module). */
export const PY_REQUESTS_MODULE = 'requests';
export const PY_REQUESTS_FALLBACK_MODULE = 'nfrequests';
/** The modules a script may import. */
export const PY_MODULE_NAMES: readonly string[] = Object.freeze(['json', 'time', 'sys', 'math', 'requests', 'requests.exceptions', 'requests.auth', 'nfrequests']);
/** The User-Agent of a script's requests (original). */
export const PY_USER_AGENT = 'NF-Py/1';

// ── helpers ─────────────────────────────────────────────────────────────────

const typeError = (m: string): PyError => pyError(PY_EXC.TypeError, m);
const valueError = (m: string): PyError => pyError(PY_EXC.ValueError, m);

const isIntLike = (v: PyValue): v is number | boolean => typeof v === 'number' || typeof v === 'boolean';
const isNumber = (v: PyValue): v is number | boolean | PyFloat => isIntLike(v) || v instanceof PyFloat;
const numOf = (v: number | boolean | PyFloat): number => (v instanceof PyFloat ? v.v : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function str(v: PyValue | undefined, what: string): string {
  if (typeof v !== 'string') throw typeError(`${what} must be str, not ${pyTypeName(v ?? null)}`);
  return v;
}

function seconds(v: PyValue | undefined, what: string): number {
  if (v === undefined || !isNumber(v)) throw typeError(`${what} must be a number, not ${pyTypeName(v ?? null)}`);
  return numOf(v);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (RFC 4648), for HTTP Basic credentials. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/** `application/x-www-form-urlencoded` text of a str→value dict (spaces as `+`). */
function formEncode(d: PyDictValue): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%20/g, '+');
  return [...d.entries.values()].map(([k, v]) => `${enc(pyStr(k))}=${enc(pyStr(v))}`).join('&');
}

function nativeFn(vm: PyMachine, name: string, fn: PyNative): PyBuiltin {
  return vm.native(name, fn);
}

function moduleObject(vm: PyMachine, name: string, members: Iterable<readonly [string, PyValue]>): PyObject {
  return vm.object(PY_MODULE_T, [['__name__', name], ...members]);
}

// ── JSON ────────────────────────────────────────────────────────────────────

function fromData(node: DataNode): PyValue {
  switch (node.kind) {
    case 'null':
      return null;
    case 'boolean':
      return node.value;
    case 'string':
      return node.value;
    case 'number':
      if (/[.eE]/.test(node.raw) || !Number.isSafeInteger(node.value)) return new PyFloat(node.value);
      return node.value === 0 ? 0 : node.value;
    case 'array':
      return new PyListValue(node.items.map(fromData));
    case 'object': {
      const d = new PyDictValue();
      for (const e of node.entries) pyDictSet(d, e.key, fromData(e.value));
      return d;
    }
  }
}

/** `json.loads`: text → value, or JSONDecodeError (`type` lets requests raise its own subclass). */
export function pyJsonLoads(text: string, type: PyType = libTypes().JSONDecodeError): PyValue {
  const r = parseJson(text);
  if (r.ok) return fromData(r.node);
  const e = r.error;
  const exc = new PyException(type, [`${e.message}: line ${e.line} column ${e.column} (char ${e.offset})`]);
  exc.attrs.set('msg', e.message);
  exc.attrs.set('lineno', e.line);
  exc.attrs.set('colno', e.column);
  exc.attrs.set('pos', e.offset);
  exc.attrs.set('doc', text);
  throw new PyError(exc);
}

function jsonString(s: string, ascii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] as string;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || (ascii && c > 0x7e)) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

interface DumpOptions {
  readonly indent?: string;
  readonly sortKeys: boolean;
  readonly ascii: boolean;
  readonly itemSep: string;
  readonly keySep: string;
  /** The running machine, charged one step per element written (vm.ts header, "NATIVE WORK"). */
  readonly meter?: PyMeter;
}

function jsonNumber(v: number | boolean | PyFloat): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Number.isNaN(v.v)) return 'NaN';
  if (!Number.isFinite(v.v)) return v.v > 0 ? 'Infinity' : '-Infinity';
  return pyFloatRepr(v.v);
}

/**
 * `json.dumps`: Python's output, byte for byte for the supported options. Held to PY_MAX_LENGTH (MemoryError, checked
 * while the text is built) and PY_MAX_VALUE_DEPTH nested values (RecursionError), whatever the JS engine (vm.ts header).
 */
export function pyJsonDumps(v: PyValue, opts: DumpOptions): string {
  const seen = new Set<unknown>();
  /** The texts of one container's members, refused before the joined text would pass the cap. */
  const members = <T>(items: readonly T[], render: (x: T) => string): string => {
    const parts: string[] = [];
    let units = 0;
    for (const x of items) {
      const t = render(x);
      units += t.length + (parts.length > 0 ? opts.itemSep.length : 0);
      if (units > 2 * PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
      parts.push(t);
    }
    opts.meter?.charge(parts.length);
    return parts.join(opts.itemSep);
  };
  const walk = (x: PyValue, level: number): string => {
    if (x === null) return 'null';
    if (typeof x === 'string') return jsonString(x, opts.ascii);
    if (isNumber(x)) return jsonNumber(x);
    if (opts.indent !== undefined && opts.indent.length * (level + 1) > 2 * PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
    const nl = opts.indent === undefined ? '' : `\n${opts.indent.repeat(level + 1)}`;
    const close = opts.indent === undefined ? '' : `\n${opts.indent.repeat(level)}`;
    if (x instanceof PyListValue || x instanceof PyTupleValue) {
      if (x.items.length === 0) return '[]';
      if (seen.has(x)) throw valueError('Circular reference detected');
      if (level >= PY_MAX_VALUE_DEPTH) throw pyError(PY_EXC.RecursionError, MSG_PY_DEPTH_JSON);
      seen.add(x);
      const body = members(x.items, (i) => nl + walk(i, level + 1));
      seen.delete(x);
      return `[${body}${close}]`;
    }
    if (x instanceof PyDictValue) {
      if (x.entries.size === 0) return '{}';
      if (seen.has(x)) throw valueError('Circular reference detected');
      if (level >= PY_MAX_VALUE_DEPTH) throw pyError(PY_EXC.RecursionError, MSG_PY_DEPTH_JSON);
      seen.add(x);
      let pairs = [...x.entries.values()].map(([k, val]): [string, PyValue] => {
        if (typeof k === 'string') return [k, val];
        if (k === null) return ['null', val];
        if (isNumber(k)) return [jsonNumber(k), val];
        throw typeError(`keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
      });
      if (opts.sortKeys) pairs = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const body = members(pairs, ([k, val]) => `${nl}${jsonString(k, opts.ascii)}${opts.keySep}${walk(val, level + 1)}`);
      seen.delete(x);
      return `{${body}${close}}`;
    }
    throw typeError(`Object of type ${pyTypeName(x)} is not JSON serializable`);
  };
  return walk(v, 0);
}

function jsonModule(vm: PyMachine): PyObject {
  const t = libTypes();
  return moduleObject(vm, 'json', [
    ['JSONDecodeError', t.JSONDecodeError],
    ['loads', nativeFn(vm, 'loads', (_vm, args, kw) => {
      const [s] = pyArgs('loads', args, kw, ['s'], 1);
      return pyJsonLoads(str(s, 'the JSON object'));
    })],
    ['dumps', nativeFn(vm, 'dumps', (_vm, args, kw) => {
      const [obj, indent, sortKeys, ensureAscii, separators] = pyArgs('dumps', args, kw, ['obj', 'indent', 'sort_keys', 'ensure_ascii', 'separators'], 1);
      let ind: string | undefined;
      if (indent !== undefined && indent !== null) {
        const width = typeof indent === 'string' ? 0 : numOf(indent as number);
        if (width > PY_MAX_LENGTH) throw pyError(PY_EXC.MemoryError, MSG_PY_LENGTH);
        ind = typeof indent === 'string' ? indent : ' '.repeat(Math.max(0, width));
      }
      let itemSep = ind === undefined ? ', ' : ',';
      let keySep = ': ';
      if (separators !== undefined && separators !== null) {
        const parts = vm.items(separators);
        itemSep = str(parts[0], 'separators[0]');
        keySep = str(parts[1], 'separators[1]');
      }
      return pyJsonDumps(obj as PyValue, {
        meter: vm,
        ...(ind !== undefined ? { indent: ind } : {}),
        sortKeys: sortKeys !== undefined && sortKeys !== null && pyTruthy(sortKeys),
        ascii: ensureAscii === undefined || pyTruthy(ensureAscii),
        itemSep,
        keySep,
      });
    })],
  ]);
}


// ── time ────────────────────────────────────────────────────────────────────

function timeModule(vm: PyMachine): PyObject {
  return moduleObject(vm, 'time', [
    // no time_ns(): wall-clock nanoseconds (about 1.7e18) are beyond NF-Py's 2^53 whole numbers
    ['time', nativeFn(vm, 'time', () => new PyFloat(vm.clock.unixMs / 1000))],
    ['monotonic', nativeFn(vm, 'monotonic', () => new PyFloat(vm.clock.monotonicNs / 1_000_000_000))],
    ['monotonic_ns', nativeFn(vm, 'monotonic_ns', () => pyCheckInt(vm.clock.monotonicNs))],
    ['perf_counter', nativeFn(vm, 'perf_counter', () => new PyFloat(vm.clock.monotonicNs / 1_000_000_000))],
    ['sleep', nativeFn(vm, 'sleep', (_vm, args, kw) => {
      const [s] = pyArgs('sleep', args, kw, ['secs'], 1);
      const secs = seconds(s, 'sleep length');
      if (!(secs >= 0) || !Number.isFinite(secs)) throw valueError('sleep length must be non-negative');
      const ns = Math.round(secs * 1_000_000_000);
      vm.noteSleep(ns);
      return new PySuspend({ kind: 'sleep', ns }, () => null);
    })],
  ]);
}

// ── sys, math ───────────────────────────────────────────────────────────────

function textStream(vm: PyMachine, name: string): PyObject {
  return vm.object(libTypes().TextIO, [
    ['name', name],
    ['write', nativeFn(vm, 'write', (_vm, args) => {
      const text = str(args[0], 'write() argument');
      vm.write(text);
      return pyLen(text);
    })],
    ['flush', nativeFn(vm, 'flush', () => null)],
  ]);
}

function sysModule(vm: PyMachine): PyObject {
  return moduleObject(vm, 'sys', [
    ['argv', new PyListValue([...vm.argv])],
    ['version', 'NF-Py 1 (a teaching subset of Python 3)'],
    ['platform', 'netforge'],
    ['stdout', textStream(vm, '<stdout>')],
    ['stderr', textStream(vm, '<stderr>')],
    ['maxsize', Number.MAX_SAFE_INTEGER],
    ['exit', nativeFn(vm, 'exit', (_vm, args) => {
      throw new PyError(new PyException(PY_EXC.SystemExit, args.length > 0 ? [args[0] as PyValue] : []));
    })],
  ]);
}

function mathModule(vm: PyMachine): PyObject {
  const num = (name: string, f: (x: number) => PyValue): [string, PyBuiltin] => [name, nativeFn(vm, name, (_vm, args) => f(seconds(args[0], `${name}() argument`)))];
  return moduleObject(vm, 'math', [
    ['pi', new PyFloat(Math.PI)],
    ['e', new PyFloat(Math.E)],
    ['inf', new PyFloat(Infinity)],
    ['nan', new PyFloat(NaN)],
    num('floor', (x) => pyCheckInt(Math.floor(x))),
    num('ceil', (x) => pyCheckInt(Math.ceil(x))),
    num('trunc', (x) => pyCheckInt(Math.trunc(x))),
    num('fabs', (x) => new PyFloat(Math.abs(x))),
    num('sqrt', (x) => {
      if (x < 0) throw valueError('math domain error');
      return new PyFloat(Math.sqrt(x));
    }),
    num('isnan', (x) => Number.isNaN(x)),
    num('isinf', (x) => !Number.isFinite(x) && !Number.isNaN(x)),
    num('isfinite', (x) => Number.isFinite(x)),
    ['gcd', nativeFn(vm, 'gcd', (_vm, args) => {
      let g = 0;
      for (const a of args) {
        if (!isIntLike(a)) throw typeError(`'${pyTypeName(a)}' object cannot be interpreted as an integer`);
        let x = Math.abs(numOf(a));
        let y = g;
        while (x !== 0) [x, y] = [y % x, x];
        g = y;
      }
      return g;
    })],
  ]);
}

// ── requests ────────────────────────────────────────────────────────────────

const METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Original description of a transport error code, for ConnectionError texts. */
function transportText(code: string): string {
  switch (code) {
    case 'refused':
      return 'the server refused the connection';
    case 'reset':
      return 'the connection was reset';
    case 'host-unreachable':
      return 'the server could not be reached (no answer to the address, or the name did not resolve)';
    case 'net-unreachable':
    case 'no-route':
      return 'there is no route to the server';
    case 'no-address':
      return 'this device has no address to reach the server';
    case 'proto-unreachable':
    case 'port-unreachable':
      return 'the server does not offer this service';
    case 'admin-prohibited':
      return 'an access list on the path refused the connection';
    default:
      return `the connection failed (${code})`;
  }
}

function libException(type: PyType, message: string, attrs: readonly (readonly [string, PyValue])[] = []): PyError {
  const e = new PyException(type, [message]);
  for (const [k, v] of attrs) e.attrs.set(k, v);
  return new PyError(e);
}

/** The Response object of an answered request. */
function responseObject(vm: PyMachine, url: string, r: Extract<PyIoResult, { kind: 'http' }>): PyObject {
  const t = libTypes();
  const status = r.status ?? 0;
  const reason = r.reason ?? '';
  const text = r.body ?? '';
  const headers = pyDict((r.headers ?? []).map(([k, v]) => [k, v] as const), true);
  const resp = vm.object(t.Response, [
    ['status_code', status],
    ['reason', reason],
    ['ok', status < 400],
    ['headers', headers],
    ['text', text],
    ['content', text],
    ['url', url],
    ['encoding', 'utf-8'],
    ['__repr__', `<Response [${status}]>`],
  ]);
  resp.attrs.set('json', vm.native('json', () => pyJsonLoads(text, t.RequestsJSONDecodeError)));
  resp.attrs.set(
    'raise_for_status',
    vm.native('raise_for_status', () => {
      if (status < 400) return null;
      const kind = status < 500 ? 'Client Error' : 'Server Error';
      throw libException(t.HTTPError, `${status} ${kind}: ${reason} for url: ${url}`, [['response', resp]]);
    }),
  );
  return resp;
}

/** One request function: `requests.get(url, …)`, or `requests.request(method, url, …)` when `method` is undefined. */
function requestFn(vm: PyMachine, name: string, method: HttpMethod | undefined): PyBuiltin {
  const t = libTypes();
  const names = ['url', 'params', 'data', 'json', 'headers', 'auth', 'timeout', 'verify', 'allow_redirects'];
  return vm.native(name, (_vm, rawArgs, kw) => {
    let m: HttpMethod;
    let args = rawArgs;
    if (method === undefined) {
      const given = args[0] ?? kw?.get('method');
      const upper = typeof given === 'string' ? given.toUpperCase() : '';
      if (!METHODS.includes(upper as HttpMethod)) throw valueError(`NF-Py sends ${METHODS.join(', ')} requests; ${pyRepr(given ?? null)} is not one of them`);
      m = upper as HttpMethod;
      args = args.slice(1);
      if (kw?.has('method') === true) kw = new Map([...kw].filter(([k]) => k !== 'method'));
    } else m = method;
    // the keyword-only parameters of requests: only `url` (and get's `params`, post's `data`/`json`) may be positional
    const positional = method === 'GET' ? ['url', 'params'] : method === 'POST' ? ['url', 'data', 'json'] : method === 'PUT' || method === 'PATCH' ? ['url', 'data'] : ['url'];
    if (args.length > positional.length) throw typeError(`${name}() takes ${positional.length === 1 ? '1 positional argument' : `up to ${positional.length} positional arguments`} but ${args.length} were given`);
    const merged = new Map<string, PyValue>(kw ?? []);
    args.forEach((a, i) => {
      const key = positional[i] as string;
      if (merged.has(key)) throw typeError(`${name}() got multiple values for argument '${key}'`);
      merged.set(key, a);
    });
    const [url, params, data, json, headers, auth, timeout] = pyArgs(name, [], merged, names, 0);
    if (url === undefined) throw typeError(`${name}() missing 1 required positional argument: 'url'`);
    if (typeof url !== 'string') throw libException(t.InvalidURL, `Invalid URL ${pyRepr(url)}: the address must be a str`);
    let target = url;
    if (params !== undefined && params !== null) {
      const q = params instanceof PyDictValue ? formEncode(params) : pyStr(params);
      if (q !== '') target += (target.includes('?') ? '&' : '?') + q;
    }
    const out: [string, string][] = [];
    const has = (h: string): boolean => out.some(([k]) => k.toLowerCase() === h);
    if (headers !== undefined && headers !== null) {
      if (!(headers instanceof PyDictValue)) throw typeError(`headers must be a dict, not ${pyTypeName(headers)}`);
      for (const [k, v] of headers.entries.values()) out.push([pyStr(k), pyStr(v)]);
    }
    if (auth !== undefined && auth !== null) {
      const pair = vm.items(auth);
      if (pair.length !== 2) throw typeError('auth must be a (user, password) pair');
      const token = encodeBase64(new TextEncoder().encode(`${pyStr(pair[0] as PyValue)}:${pyStr(pair[1] as PyValue)}`));
      out.push(['Authorization', `Basic ${token}`]);
    }
    let body: string | undefined;
    if (json !== undefined && json !== null) {
      body = pyJsonDumps(json, { sortKeys: false, ascii: true, itemSep: ', ', keySep: ': ' });
      if (!has('content-type')) out.push(['Content-Type', 'application/json']);
    } else if (data !== undefined && data !== null) {
      if (data instanceof PyDictValue) {
        body = formEncode(data);
        if (!has('content-type')) out.push(['Content-Type', 'application/x-www-form-urlencoded']);
      } else body = pyStr(data);
    }
    if (!has('user-agent')) out.unshift(['User-Agent', PY_USER_AGENT]);
    if (!has('accept')) out.push(['Accept', '*/*']);
    let timeoutNs: number | undefined;
    if (timeout !== undefined && timeout !== null) {
      const parts = timeout instanceof PyTupleValue || timeout instanceof PyListValue ? timeout.items : [timeout];
      let total = 0;
      for (const p of parts) if (p !== null) total += seconds(p, 'timeout');
      if (!(total > 0)) throw valueError('timeout must be a positive number of seconds');
      timeoutNs = Math.round(total * 1_000_000_000);
    }
    vm.noteRequest();
    const io: PyIoRequest = { kind: 'http', method: m, url: target, headers: out, ...(body !== undefined ? { body } : {}), ...(timeoutNs !== undefined ? { timeoutNs } : {}) };
    return new PySuspend(io, (r) => {
      if (r.kind !== 'http') throw new Error('nf-py: an http request was answered with a sleep');
      if (r.status === undefined) {
        const code = r.error ?? 'reset';
        if (code === 'timeout') throw libException(t.Timeout, `The request to ${target} timed out.`);
        if (code === 'bad-url') throw libException(t.InvalidURL, `Invalid URL ${pyStrRepr(target)}: an address starts with http:// or https://`);
        throw libException(t.ConnectionError, `Could not connect to ${target}: ${transportText(code)}.`);
      }
      return responseObject(vm, target, r);
    });
  });
}

function requestsExceptionsModule(vm: PyMachine, name: string): PyObject {
  const t = libTypes();
  return moduleObject(vm, name, [
    ['RequestException', t.RequestException],
    ['ConnectionError', t.ConnectionError],
    ['Timeout', t.Timeout],
    ['HTTPError', t.HTTPError],
    ['InvalidURL', t.InvalidURL],
    ['JSONDecodeError', t.RequestsJSONDecodeError],
  ]);
}

function requestsAuthModule(vm: PyMachine, name: string): PyObject {
  return moduleObject(vm, name, [
    ['HTTPBasicAuth', vm.native('HTTPBasicAuth', (_vm, args, kw) => {
      const [user, password] = pyArgs('HTTPBasicAuth', args, kw, ['username', 'password'], 2);
      return new PyTupleValue([user as PyValue, password as PyValue]);
    })],
  ]);
}

function requestsModule(vm: PyMachine, name: string): PyObject {
  const t = libTypes();
  // the submodules are attributes from the start (the classes are shared, so `import requests.exceptions` agrees)
  const exceptions = requestsExceptionsModule(vm, `${name}.exceptions`);
  const auth = requestsAuthModule(vm, `${name}.auth`);
  return moduleObject(vm, name, [
    ['get', requestFn(vm, 'get', 'GET')],
    ['head', requestFn(vm, 'head', 'HEAD')],
    ['post', requestFn(vm, 'post', 'POST')],
    ['put', requestFn(vm, 'put', 'PUT')],
    ['patch', requestFn(vm, 'patch', 'PATCH')],
    ['delete', requestFn(vm, 'delete', 'DELETE')],
    ['request', requestFn(vm, 'request', undefined)],
    ['exceptions', exceptions],
    ['auth', auth],
    ['Response', t.Response],
    ['RequestException', t.RequestException],
    ['ConnectionError', t.ConnectionError],
    ['Timeout', t.Timeout],
    ['HTTPError', t.HTTPError],
    ['JSONDecodeError', t.RequestsJSONDecodeError],
  ]);
}

// ── builtins ────────────────────────────────────────────────────────────────

function lenOf(v: PyValue): number {
  if (typeof v === 'string') return pyLen(v);
  if (v instanceof PyListValue || v instanceof PyTupleValue) return v.items.length;
  if (v instanceof PyDictValue || v instanceof PySetValue) return v.entries.size;
  if (v instanceof PyDictView) return v.dict.entries.size;
  if (v instanceof PyRange) return v.length;
  throw typeError(`object of type '${pyTypeName(v)}' has no len()`);
}

function minMax(vm: PyMachine, name: 'min' | 'max', args: readonly PyValue[], kw: PyKwargs | undefined): PyValue {
  const key = kw?.get('key') ?? null;
  const dflt = kw?.get('default');
  for (const k of kw?.keys() ?? []) if (k !== 'key' && k !== 'default') throw typeError(`${name}() got an unexpected keyword argument '${k}'`);
  if (args.length === 0) throw typeError(`${name} expected at least 1 argument, got 0`);
  const items = args.length === 1 ? vm.items(args[0] as PyValue) : [...args];
  if (items.length === 0) {
    if (dflt !== undefined) return dflt;
    throw valueError(`${name}() arg is an empty sequence`);
  }
  let best = items[0] as PyValue;
  let bestKey = key === null ? best : vm.call(key, [best]);
  // one comparison per further item (vm.ts header, "NATIVE WORK")
  vm.charge(items.length - 1);
  for (const x of items.slice(1)) {
    const k = key === null ? x : vm.call(key, [x]);
    if (name === 'min' ? pyLt(k, bestKey, '<', vm) : pyLt(bestKey, k, '<', vm)) {
      best = x;
      bestKey = k;
    }
  }
  return best;
}

function intText(v: PyValue | undefined, radix: number, prefix: string): string {
  if (v === undefined || !isIntLike(v)) throw typeError(`'${pyTypeName(v ?? null)}' object cannot be interpreted as an integer`);
  const n = numOf(v);
  return (n < 0 ? '-' : '') + prefix + Math.abs(n).toString(radix);
}

function builtins(vm: PyMachine): Map<string, PyValue> {
  const b = new Map<string, PyValue>();
  const def = (name: string, fn: PyNative): void => {
    b.set(name, vm.native(name, fn));
  };
  for (const [name, type] of [
    ['int', PY_INT], ['float', PY_FLOAT_T], ['str', PY_STR], ['bool', PY_BOOL], ['list', PY_LIST_T], ['tuple', PY_TUPLE_T],
    ['dict', PY_DICT_T], ['set', PY_SET_T], ['range', PY_RANGE_T], ['type', PY_TYPE_T], ['object', PY_OBJECT],
  ] as const) b.set(name, type);
  for (const [name, type] of Object.entries(PY_EXC)) b.set(name, type);
  def('print', (_vm, args, kw) => {
    const [sep, end] = [kw?.get('sep') ?? null, kw?.get('end') ?? null];
    for (const k of kw?.keys() ?? []) if (!['sep', 'end', 'file', 'flush'].includes(k)) throw typeError(`'${k}' is an invalid keyword argument for print()`);
    const s = sep === null ? ' ' : str(sep, 'sep');
    const e = end === null ? '\n' : str(end, 'end');
    // written piece by piece (the output cap cuts it exactly where the joined text would be cut)
    args.forEach((a, i) => {
      if (i > 0) vm.write(s);
      vm.write(pyStr(a, vm));
    });
    vm.write(e);
    return null;
  });
  def('len', (_vm, args) => lenOf(args[0] ?? null));
  def('repr', (_vm, args) => pyRepr(args[0] ?? null, vm));
  def('ascii', (_vm, args) => pyRepr(args[0] ?? null, vm).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  def('format', (_vm, args) => pyFormat(args[0] ?? null, args[1] === undefined ? '' : str(args[1], 'format_spec')));
  def('isinstance', (_vm, args) => {
    const spec = args[1] ?? null;
    const types = spec instanceof PyTupleValue ? spec.items : [spec];
    for (const t of types) if (!(t instanceof PyType)) throw typeError('isinstance() arg 2 must be a type or tuple of types');
    const actual = pyTypeOf(args[0] ?? null);
    return types.some((t) => pyIsSubtype(actual, t as PyType));
  });
  def('abs', (_vm, args) => {
    const v = args[0] ?? null;
    if (v instanceof PyFloat) return new PyFloat(Math.abs(v.v));
    if (isIntLike(v)) return Math.abs(numOf(v));
    throw typeError(`bad operand type for abs(): '${pyTypeName(v)}'`);
  });
  def('min', (_vm, args, kw) => minMax(vm, 'min', args, kw));
  def('max', (_vm, args, kw) => minMax(vm, 'max', args, kw));
  def('sum', (_vm, args, kw) => {
    const [iterable, start] = pyArgs('sum', args, kw, ['iterable', 'start'], 1);
    let total: PyValue = start ?? 0;
    if (typeof total === 'string') throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
    const items = vm.items(iterable as PyValue);
    // one addition per item (vm.ts header, "NATIVE WORK")
    vm.charge(items.length);
    for (const x of items) total = pyBinary('+', total, x);
    return total;
  });
  def('sorted', (_vm, args, kw) => {
    if (args.length !== 1) throw typeError(`sorted expected 1 argument, got ${args.length}`);
    const [key, reverse] = pyArgs('sorted', [], kw, ['key', 'reverse'], 0);
    return new PyListValue(pySort(vm, vm.items(args[0] as PyValue), key ?? null, reverse !== undefined && pyTruthy(reverse)));
  });
  def('reversed', (_vm, args) => {
    const v = args[0] ?? null;
    if (!(v instanceof PyListValue || v instanceof PyTupleValue || typeof v === 'string' || v instanceof PyRange)) throw typeError(`'${pyTypeName(v)}' object is not reversible`);
    const items = vm.items(v).reverse();
    let i = 0;
    return new PyIterator(() => (i < items.length ? items[i++] : undefined));
  });
  def('enumerate', (_vm, args, kw) => {
    const [iterable, start] = pyArgs('enumerate', args, kw, ['iterable', 'start'], 1);
    const it = vm.iterate(iterable as PyValue);
    let n = start === undefined ? 0 : numOf(start as number);
    return new PyIterator(() => {
      const v = it.next();
      return v === undefined ? undefined : new PyTupleValue([n++, v]);
    });
  });
  def('zip', (_vm, args) => {
    const its = args.map((a) => vm.iterate(a));
    return new PyIterator(() => {
      if (its.length === 0) return undefined;
      const row: PyValue[] = [];
      for (const it of its) {
        const v = it.next();
        if (v === undefined) return undefined;
        row.push(v);
      }
      return new PyTupleValue(row);
    });
  });
  def('map', (_vm, args) => {
    if (args.length < 2) throw typeError('map() must have at least two arguments.');
    const fn = args[0] as PyValue;
    const lists = args.slice(1).map((a) => vm.items(a));
    const n = Math.min(...lists.map((l) => l.length));
    const out: PyValue[] = [];
    for (let i = 0; i < n; i++) out.push(vm.call(fn, lists.map((l) => l[i] as PyValue)));
    let i = 0;
    return new PyIterator(() => (i < out.length ? out[i++] : undefined));
  });
  def('filter', (_vm, args) => {
    const fn = args[0] ?? null;
    const out = vm.items(args[1] ?? null).filter((x) => pyTruthy(fn === null ? x : vm.call(fn, [x])));
    let i = 0;
    return new PyIterator(() => (i < out.length ? out[i++] : undefined));
  });
  def('any', (_vm, args) => vm.items(args[0] ?? null).some((x) => pyTruthy(x)));
  def('all', (_vm, args) => vm.items(args[0] ?? null).every((x) => pyTruthy(x)));
  def('round', (_vm, args, kw) => {
    const [x, nd] = pyArgs('round', args, kw, ['number', 'ndigits'], 1);
    const v = x as PyValue;
    if (nd === undefined || nd === null) {
      if (isIntLike(v)) return numOf(v);
      if (v instanceof PyFloat) {
        if (!Number.isFinite(v.v)) throw pyError(Number.isNaN(v.v) ? PY_EXC.ValueError : PY_EXC.OverflowError, `cannot convert float ${pyFloatRepr(v.v)} to integer`);
        return pyCheckInt(pyRoundFloat(v.v, 0));
      }
      throw typeError(`type ${pyTypeName(v)} doesn't define __round__ method`);
    }
    const n = numOf(nd as number);
    if (isIntLike(v)) {
      if (n >= 0) return numOf(v);
      return pyCheckInt(pyRoundFloat(numOf(v), n));
    }
    if (v instanceof PyFloat) return new PyFloat(pyRoundFloat(v.v, n));
    throw typeError(`type ${pyTypeName(v)} doesn't define __round__ method`);
  });
  def('ord', (_vm, args) => {
    const s = str(args[0], 'ord() argument');
    if (pyLen(s) !== 1) throw typeError(`ord() expected a character, but string of length ${pyLen(s)} found`);
    return s.codePointAt(0) as number;
  });
  def('chr', (_vm, args) => {
    const v = args[0] ?? null;
    if (!isIntLike(v)) throw typeError(`'${pyTypeName(v)}' object cannot be interpreted as an integer`);
    const n = numOf(v);
    if (n < 0 || n > 0x10ffff) throw valueError('chr() arg not in range(0x110000)');
    return String.fromCodePoint(n);
  });
  def('hex', (_vm, args) => intText(args[0], 16, '0x'));
  def('oct', (_vm, args) => intText(args[0], 8, '0o'));
  def('bin', (_vm, args) => intText(args[0], 2, '0b'));
  def('divmod', (_vm, args) => new PyTupleValue([pyBinary('//', args[0] ?? null, args[1] ?? null), pyBinary('%', args[0] ?? null, args[1] ?? null)]));
  def('pow', (_vm, args) => {
    if (args.length !== 2) throw typeError('NF-Py pow() takes exactly 2 arguments');
    return pyBinary('**', args[0] as PyValue, args[1] as PyValue);
  });
  def('input', () => {
    throw pyError(PY_EXC.EOFError, 'EOF when reading a line (an NF-Py script reads no keyboard input)');
  });
  def('open', () => {
    throw pyError(PY_EXC.OSError, 'NF-Py scripts cannot open files in this release');
  });
  def('iter', (_vm, args) => vm.iterate(args[0] ?? null));
  def('next', (_vm, args) => {
    const it = args[0] ?? null;
    if (!(it instanceof PyIterator)) throw typeError(`'${pyTypeName(it)}' object is not an iterator`);
    const v = it.next();
    if (v !== undefined) return v;
    if (args.length > 1) return args[1] as PyValue;
    throw pyError(PY_EXC.StopIteration);
  });
  def('callable', (_vm, args) => {
    const v = args[0] ?? null;
    return v instanceof PyFunction || v instanceof PyBuiltin || v instanceof PyType;
  });
  def('getattr', (_vm, args) => {
    const name = str(args[1], 'attribute name');
    try {
      return vm.getattr(args[0] ?? null, name);
    } catch (e) {
      if (args.length > 2 && e instanceof PyError && e.exc.type === PY_EXC.AttributeError) return args[2] as PyValue;
      throw e;
    }
  });
  def('hasattr', (_vm, args) => {
    try {
      vm.getattr(args[0] ?? null, str(args[1], 'attribute name'));
      return true;
    } catch (e) {
      if (e instanceof PyError && e.exc.type === PY_EXC.AttributeError) return false;
      throw e;
    }
  });
  def('exit', (_vm, args) => {
    throw new PyError(new PyException(PY_EXC.SystemExit, args.length > 0 ? [args[0] as PyValue] : []));
  });
  b.set('quit', b.get('exit') as PyValue);
  return b;
}


// ── the environment and the entry point ─────────────────────────────────────

/** The standard environment: the builtins and the modules of the file header. */
export function pyStandardEnvironment(): PyEnvironment {
  return {
    builtins,
    module(vm, name) {
      switch (name) {
        case 'json':
          return jsonModule(vm);
        case 'time':
          return timeModule(vm);
        case 'sys':
          return sysModule(vm);
        case 'math':
          return mathModule(vm);
        case PY_REQUESTS_MODULE:
        case PY_REQUESTS_FALLBACK_MODULE:
          return requestsModule(vm, name);
        case 'requests.exceptions':
        case 'nfrequests.exceptions':
          return requestsExceptionsModule(vm, name);
        case 'requests.auth':
        case 'nfrequests.auth':
          return requestsAuthModule(vm, name);
        default:
          return undefined;
      }
    },
  };
}

/** The traceback of a syntax error, Python style (the line, a caret under the column, the message). */
export function pySyntaxFailure(error: PySyntaxError, source: string, file: string): PyFailure {
  const text = source.split(/\r\n|\r|\n/)[error.line - 1] ?? '';
  const trimmed = text.replace(/^\s+/, '');
  const caretAt = Math.max(0, error.column - 1 - (text.length - trimmed.length));
  const last = `${error.type}: ${error.message}`;
  const traceback = `  File "${file}", line ${error.line}\n    ${trimmed}\n    ${' '.repeat(caretAt)}^\n${last}`;
  return { type: error.type, message: error.message, traceback, last, line: error.line };
}

export interface PyScriptOptions {
  /** The file name tracebacks show (and `sys.argv[0]`). */
  readonly file: string;
  /** The arguments after the file name (`python inventory.py a b`). */
  readonly argv?: readonly string[];
}

/** Compile and start a script with the standard library; a syntax error gives a machine that is already failed. */
export function startPyScript(source: string, opts: PyScriptOptions): PyVm {
  const compiled = compilePy(source, opts.file);
  if (!compiled.ok) return createFailedPyVm(pySyntaxFailure(compiled.error, source, opts.file));
  return createPyVm(compiled.program, { env: pyStandardEnvironment(), argv: [opts.file, ...(opts.argv ?? [])] });
}

// ── the host side of an HTTP request ────────────────────────────────────────

/** The `http.request` a waiting machine's HTTP I/O becomes (the script host is the owner). */
export function pyIoHttpRequest(
  io: Extract<PyIoRequest, { kind: 'http' }>,
  owner: string,
  token: string,
  session?: SessionId,
): Extract<ProcessRequest, { kind: 'http.request' }> {
  return {
    kind: 'http.request',
    owner,
    token,
    method: io.method,
    url: io.url,
    headers: io.headers,
    ...(io.body !== undefined ? { body: new TextEncoder().encode(io.body) } : {}),
    ...(io.timeoutNs !== undefined ? { timeoutNs: io.timeoutNs } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}

/** The machine's answer from http-client's `http.result`. */
export function pyIoResultOfHttp(ev: HttpResultEvent): PyIoResult {
  return {
    kind: 'http',
    ...(ev.status !== undefined ? { status: ev.status } : {}),
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
    ...(ev.headers !== undefined ? { headers: ev.headers } : {}),
    ...(ev.body !== undefined ? { body: new TextDecoder('utf-8', { fatal: false }).decode(ev.body) } : {}),
    ...(ev.error !== undefined ? { error: ev.error } : {}),
  };
}
