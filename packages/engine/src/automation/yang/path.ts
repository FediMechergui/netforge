/**
 * The RESTCONF request-target parser (ARCHITECTURE-P3 D21, §5.6 "RESTCONF resources", §7 W1 auto).
 *
 * Pure, exported through `@netforge/engine/pure`. It turns the target of an HTTP request (or a whole `https://…` URL,
 * whose scheme and authority are skipped) into one of the resources a NetForge device serves:
 *   `/.well-known/host-meta`, `/restconf`, `/restconf/data[/<api-path>]`, `/restconf/operations[/<module>:<rpc>]`;
 * anything else is `unknown` (404 for the daemon). The api-path follows RFC 8040 §3.5.3: segments separated by `/`,
 * each `[module:]identifier` optionally followed by `=key[,key…]`; the first segment names its module; key values are
 * percent-decoded after splitting, so a key that holds `/` or `,` is written `%2F` / `%2C`
 * (`interface=GigabitEthernet0%2F1`). The query string is split into name/value pairs; which parameters a request may
 * use is the daemon's rule, not the parser's.
 *
 * The parser knows nothing of the schema: `automation/yang/model.ts` resolves a parsed path to model nodes.
 */

/** One step of an api-path: `ietf-interfaces:interfaces`, `interface=Vlan99`. */
export interface ApiSegment {
  /** The module named on this step, when it names one. */
  readonly module?: string;
  readonly name: string;
  /** Decoded key values (`interface=Vlan99` → `['Vlan99']`); absent when the step has no `=`. */
  readonly keys?: readonly string[];
  /** The step as written (still percent-encoded). */
  readonly text: string;
}

/** A query parameter, both parts percent-decoded (`+` is a plus sign, not a space). */
export interface RestconfQueryParam {
  readonly name: string;
  readonly value: string;
}

export type RestconfResource =
  | { readonly kind: 'host-meta' }
  | { readonly kind: 'root' }
  | { readonly kind: 'data'; readonly path: readonly ApiSegment[] }
  | { readonly kind: 'operations'; readonly path: readonly ApiSegment[] }
  | { readonly kind: 'unknown' };

export interface RestconfTarget {
  readonly resource: RestconfResource;
  /** The path part as written (no query), `/restconf/data/…`. */
  readonly path: string;
  readonly query: readonly RestconfQueryParam[];
}

/** Why a target could not be read: always a 400 (`malformed-message` / `invalid-value`) for the daemon. */
export interface RestconfPathError {
  readonly message: string;
  /** 0-based index into the parsed target text where the problem starts. */
  readonly at: number;
}

export type RestconfTargetResult = ({ readonly ok: true } & RestconfTarget) | { readonly ok: false; readonly error: RestconfPathError };

/** The root of the RESTCONF API on every NetForge device (what `/.well-known/host-meta` points to). */
export const RESTCONF_ROOT = '/restconf';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Whether `s` is a YANG identifier (RFC 7950 §6.2). */
export function isYangIdentifier(s: string): boolean {
  return IDENTIFIER.test(s) && !/^xml/i.test(s);
}

/** Decodes `%XX` sequences as UTF-8; undefined when a sequence is malformed. */
export function percentDecode(s: string): string | undefined {
  if (!s.includes('%')) return s;
  if (/%(?![0-9A-Fa-f]{2})/.test(s)) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/** Encodes a key value for a URL: every character outside RFC 3986 unreserved is `%XX` (so `/` → `%2F`, `,` → `%2C`). */
export function percentEncodeKey(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Parses an api-path (the text after `/restconf/data` or `/restconf/operations`, starting with `/`, or empty). */
export function parseApiPath(text: string, base = 0): { ok: true; path: ApiSegment[] } | { ok: false; error: RestconfPathError } {
  const fail = (at: number, message: string): { ok: false; error: RestconfPathError } => ({ ok: false, error: { message, at: base + at } });
  if (text === '' || text === '/') return { ok: true, path: [] };
  if (!text.startsWith('/')) return fail(0, 'The path must start with "/".');
  const body = text.endsWith('/') ? text.slice(0, -1) : text;
  const path: ApiSegment[] = [];
  let at = 1;
  for (const raw of body.slice(1).split('/')) {
    if (raw === '') return fail(at, 'The path has an empty step ("//").');
    const eq = raw.indexOf('=');
    const head = eq < 0 ? raw : raw.slice(0, eq);
    const colon = head.indexOf(':');
    const module = colon < 0 ? undefined : head.slice(0, colon);
    const name = colon < 0 ? head : head.slice(colon + 1);
    if (module !== undefined && !isYangIdentifier(module)) return fail(at, `"${module}" is not a valid module name.`);
    if (!isYangIdentifier(name)) {
      if (/^[0-9]/.test(raw) && path.length > 0 && path[path.length - 1]?.keys !== undefined) {
        return fail(at, 'A key value that contains "/" must be written as %2F (e.g. interface=GigabitEthernet0%2F1).');
      }
      return fail(at, `"${head}" is not a valid node name.`);
    }
    if (path.length === 0 && module === undefined) return fail(at, `The first step must name its module, as in "<module>:${name}".`);
    let keys: string[] | undefined;
    if (eq >= 0) {
      keys = [];
      for (const part of raw.slice(eq + 1).split(',')) {
        const decoded = percentDecode(part);
        if (decoded === undefined) return fail(at + eq + 1, 'A key value has a broken %-escape.');
        keys.push(decoded);
      }
    }
    path.push({ ...(module !== undefined ? { module } : {}), name, ...(keys !== undefined ? { keys } : {}), text: raw });
    at += raw.length + 1;
  }
  return { ok: true, path };
}

/** Splits a query string (without `?`) into decoded parameters, in order. */
function parseQuery(q: string, base: number): { ok: true; query: RestconfQueryParam[] } | { ok: false; error: RestconfPathError } {
  const query: RestconfQueryParam[] = [];
  if (q === '') return { ok: true, query };
  let at = 0;
  for (const part of q.split('&')) {
    if (part !== '') {
      const eq = part.indexOf('=');
      const name = percentDecode(eq < 0 ? part : part.slice(0, eq));
      const value = percentDecode(eq < 0 ? '' : part.slice(eq + 1));
      if (name === undefined || value === undefined || name === '') return { ok: false, error: { message: 'The query string has a broken parameter.', at: base + at } };
      query.push({ name, value });
    }
    at += part.length + 1;
  }
  return { ok: true, query };
}

/**
 * Parses a request target (`/restconf/data/…?depth=1`) or a whole URL (`https://10.0.99.11/restconf/data/…`). A
 * fragment (`#…`) is ignored.
 */
export function parseRestconfTarget(target: string): RestconfTargetResult {
  let from = 0;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(target);
  if (scheme !== null) {
    const slash = target.indexOf('/', scheme[0].length);
    if (slash < 0) return { ok: true, resource: { kind: 'unknown' }, path: '/', query: [] };
    from = slash;
  }
  let rest = target.slice(from);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const qm = rest.indexOf('?');
  const path = qm < 0 ? rest : rest.slice(0, qm);
  const q = parseQuery(qm < 0 ? '' : rest.slice(qm + 1), from + qm + 1);
  if (!q.ok) return q;
  const query = q.query;
  if (!path.startsWith('/')) return { ok: false, error: { message: 'The target must start with "/".', at: from } };
  if (path === '/.well-known/host-meta') return { ok: true, resource: { kind: 'host-meta' }, path, query };
  if (path === RESTCONF_ROOT || path === `${RESTCONF_ROOT}/`) return { ok: true, resource: { kind: 'root' }, path, query };
  for (const kind of ['data', 'operations'] as const) {
    const prefix = `${RESTCONF_ROOT}/${kind}`;
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      const r = parseApiPath(path.slice(prefix.length), from + prefix.length);
      if (!r.ok) return r;
      if (kind === 'operations' && (r.path.length > 1 || r.path.some((s) => s.keys !== undefined))) {
        return { ok: false, error: { message: 'An operation is named by one step, "<module>:<operation>".', at: from + prefix.length } };
      }
      return { ok: true, resource: { kind, path: r.path }, path, query };
    }
  }
  return { ok: true, resource: { kind: 'unknown' }, path, query };
}

/** Writes an api-path back as text (`/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1`). */
export function formatApiPath(path: readonly Pick<ApiSegment, 'module' | 'name' | 'keys'>[]): string {
  return path
    .map((s) => {
      const head = s.module !== undefined ? `${s.module}:${s.name}` : s.name;
      return s.keys !== undefined ? `/${head}=${s.keys.map(percentEncodeKey).join(',')}` : `/${head}`;
    })
    .join('');
}
