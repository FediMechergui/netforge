/**
 * The NetForge playbook language (ARCHITECTURE-P3C §7 W1b auto, [C22]). @since P3c
 *
 * A small YAML format of NetForge's own (decision Q10 / L3: our own dialect, naming no other tool): an INVENTORY names
 * the devices and how to log in to them, a PLAYBOOK is a list of PLAYS, each play runs its TASKS on a set of hosts,
 * and each task calls one `nf.*` MODULE. Every module works over the device's RESTCONF API (the YANG model of
 * `automation/yang/model.ts`) and is idempotent: it first reads the setting, and writes only when the setting differs,
 * so running a playbook a second time changes nothing. A run ends with a recap per host (ok, changed, failed,
 * unreachable), which `ScriptRunRow.recap` stores.
 *
 * This file is pure: parsing, validation, module planning and the run order as a generator. The I/O (HTTP requests,
 * the console lines, the `script-runs` row) belongs to the `playbook` host command (script-host, W3b), which pumps
 * `runPlaybook`. Every message and output line is original wording.
 *
 * INVENTORY:
 *   switches:                  # a group
 *     vars:                    # optional; applies to every host of the group
 *       user: netadmin
 *       password: Lab-pass1
 *     hosts:
 *       SW1:
 *         address: 192.168.10.11
 *       SW2: { address: 192.168.10.12, user: other }
 *
 * PLAYBOOK:
 *   - name: The lab VLANs
 *     hosts: switches          # a group, a host, `all`, or a list of them
 *     tasks:
 *       - name: VLAN 10 for sales
 *         nf.vlan: { id: 10, name: SALES }
 *       - nf.save_config: {}
 *
 * RUN ORDER. Plays in order; inside a play, task by task, and for each task host by host in inventory order. A host
 * whose task fails, or that cannot be reached, runs no further task of that play; the other hosts carry on.
 */
import { dataValueOf, type DataNode, type DataObjectNode, type DataValue, type SourceSpan } from '../data/json.js';
import { parseYaml } from '../data/yaml.js';
import { percentEncodeKey } from '../yang/path.js';

// ── errors ───────────────────────────────────────────────────────────────────

/** A problem in an inventory or playbook file, with where it is (line and column from 1; 0 when unknown). */
export interface PlaybookError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export type PlaybookParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly PlaybookError[] };

const at = (span: SourceSpan | undefined, message: string): PlaybookError => ({
  message,
  line: span?.start.line ?? 0,
  column: span?.start.column ?? 0,
});

/** Errors in line order (stable inside a line), the order a learner reads the file in. */
const byLine = (errors: readonly PlaybookError[]): PlaybookError[] => [...errors].sort((a, b) => a.line - b.line);

// ── inventory ────────────────────────────────────────────────────────────────

/** One managed device. */
export interface PlaybookHost {
  readonly name: string;
  /** The IPv4 address its API answers on. */
  readonly address: string;
  /** The groups that list it, in file order. */
  readonly groups: readonly string[];
  readonly user?: string;
  readonly password?: string;
}

export interface PlaybookGroup {
  readonly name: string;
  /** Host names, in file order. */
  readonly hosts: readonly string[];
}

export interface PlaybookInventory {
  /** Every host once, in the order it first appears. */
  readonly hosts: readonly PlaybookHost[];
  readonly groups: readonly PlaybookGroup[];
}

/** The word that selects every host of the inventory. */
export const PLAYBOOK_ALL_HOSTS = 'all';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,62}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_KEYS = ['address', 'user', 'password'] as const;
const VAR_KEYS = ['user', 'password'] as const;

function objectNode(node: DataNode | undefined): DataObjectNode | undefined {
  return node?.kind === 'object' ? node : undefined;
}

function stringOf(node: DataNode, what: string, errors: PlaybookError[]): string | undefined {
  if (node.kind === 'string' && node.value !== '') return node.value;
  if (node.kind === 'number') return node.raw;
  errors.push(at(node.span, `${what} must be a non-empty text value.`));
  return undefined;
}

/** Reads an inventory file. */
export function parseInventory(text: string): PlaybookParse<PlaybookInventory> {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ok: false, errors: [{ message: parsed.error.message, line: parsed.error.line, column: parsed.error.column }] };
  const root = objectNode(parsed.node);
  if (root === undefined || root.entries.length === 0) {
    return { ok: false, errors: [at(parsed.node.span, 'An inventory is a mapping of groups, each with a "hosts" mapping.')] };
  }
  const errors: PlaybookError[] = [];
  const hosts = new Map<string, { address?: string; user?: string; password?: string; groups: string[]; span: SourceSpan }>();
  const groups: PlaybookGroup[] = [];
  for (const g of root.entries) {
    if (!NAME_RE.test(g.key) || g.key === PLAYBOOK_ALL_HOSTS) {
      errors.push(at(g.keySpan, `"${g.key}" cannot name a group: use letters, digits, "_", "-" or ".", and not the word "${PLAYBOOK_ALL_HOSTS}".`));
      continue;
    }
    const body = objectNode(g.value);
    if (body === undefined) {
      errors.push(at(g.value.span, `Group "${g.key}" must be a mapping with a "hosts" key.`));
      continue;
    }
    const vars: { user?: string; password?: string } = {};
    let hostsNode: DataObjectNode | undefined;
    for (const e of body.entries) {
      if (e.key === 'hosts') {
        hostsNode = objectNode(e.value);
        if (hostsNode === undefined) errors.push(at(e.value.span, `The hosts of group "${g.key}" must be a mapping of host names.`));
      } else if (e.key === 'vars') {
        const v = objectNode(e.value);
        if (v === undefined) {
          errors.push(at(e.value.span, `The vars of group "${g.key}" must be a mapping.`));
          continue;
        }
        for (const ve of v.entries) {
          if (!(VAR_KEYS as readonly string[]).includes(ve.key)) {
            errors.push(at(ve.keySpan, `Unknown group variable "${ve.key}": a group may set ${VAR_KEYS.join(' and ')}.`));
            continue;
          }
          const s = stringOf(ve.value, `Variable "${ve.key}"`, errors);
          if (s !== undefined) vars[ve.key as 'user' | 'password'] = s;
        }
      } else {
        errors.push(at(e.keySpan, `Unknown key "${e.key}" in group "${g.key}": a group has "hosts" and, optionally, "vars".`));
      }
    }
    if (hostsNode === undefined) {
      if (!body.entries.some((e) => e.key === 'hosts')) errors.push(at(g.keySpan, `Group "${g.key}" lists no hosts.`));
      continue;
    }
    const names: string[] = [];
    for (const h of hostsNode.entries) {
      if (!NAME_RE.test(h.key) || h.key === PLAYBOOK_ALL_HOSTS) {
        errors.push(at(h.keySpan, `"${h.key}" cannot name a host: use letters, digits, "_", "-" or ".".`));
        continue;
      }
      const fields: { address?: string; user?: string; password?: string } = {};
      const hb = objectNode(h.value);
      if (hb === undefined && h.value.kind !== 'null') {
        errors.push(at(h.value.span, `Host "${h.key}" must be a mapping with an "address".`));
        continue;
      }
      for (const e of hb?.entries ?? []) {
        if (!(HOST_KEYS as readonly string[]).includes(e.key)) {
          errors.push(at(e.keySpan, `Unknown key "${e.key}" for host "${h.key}": a host may set ${HOST_KEYS.join(', ')}.`));
          continue;
        }
        const s = stringOf(e.value, `"${e.key}" of host "${h.key}"`, errors);
        if (s === undefined) continue;
        if (e.key === 'address' && !IPV4_RE.test(s)) {
          errors.push(at(e.value.span, `"${s}" is not an IPv4 address (host "${h.key}").`));
          continue;
        }
        fields[e.key as 'address' | 'user' | 'password'] = s;
      }
      const merged = { ...vars, ...fields };
      const prev = hosts.get(h.key);
      if (prev === undefined) hosts.set(h.key, { ...merged, groups: [g.key], span: h.keySpan });
      else {
        if (merged.address !== undefined && prev.address !== undefined && merged.address !== prev.address) {
          errors.push(at(h.keySpan, `Host "${h.key}" has two different addresses (${prev.address} and ${merged.address}).`));
        }
        Object.assign(prev, { ...merged, ...prev, groups: [...prev.groups, g.key] });
      }
      names.push(h.key);
    }
    groups.push({ name: g.key, hosts: names });
  }
  for (const [name, h] of hosts) if (h.address === undefined) errors.push(at(h.span, `Host "${name}" has no address.`));
  if (errors.length > 0) return { ok: false, errors: byLine(errors) };
  const out: PlaybookHost[] = [...hosts].map(([name, h]) => ({
    name,
    address: h.address as string,
    groups: h.groups,
    ...(h.user !== undefined ? { user: h.user } : {}),
    ...(h.password !== undefined ? { password: h.password } : {}),
  }));
  return { ok: true, value: { hosts: out, groups } };
}

/** The hosts a play's `hosts` selects, in inventory order; or the first word that names neither a group nor a host. */
export function selectPlaybookHosts(inv: PlaybookInventory, patterns: readonly string[]): { ok: true; hosts: PlaybookHost[] } | { ok: false; unknown: string } {
  const chosen = new Set<string>();
  for (const p of patterns) {
    if (p === PLAYBOOK_ALL_HOSTS) inv.hosts.forEach((h) => chosen.add(h.name));
    else if (inv.groups.some((g) => g.name === p)) inv.groups.find((g) => g.name === p)?.hosts.forEach((h) => chosen.add(h));
    else if (inv.hosts.some((h) => h.name === p)) chosen.add(p);
    else return { ok: false, unknown: p };
  }
  return { ok: true, hosts: inv.hosts.filter((h) => chosen.has(h.name)) };
}

// ── modules ──────────────────────────────────────────────────────────────────

export type PlaybookModuleName = 'nf.hostname' | 'nf.banner' | 'nf.vlan' | 'nf.interface' | 'nf.save_config';

export interface PlaybookParam {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean';
  readonly required: boolean;
  readonly range?: readonly [number, number];
  readonly choices?: readonly string[];
  readonly default?: string | number | boolean;
  readonly description: string;
}

export interface PlaybookModule {
  readonly name: PlaybookModuleName;
  readonly description: string;
  readonly params: readonly PlaybookParam[];
}

/** The modules, as plain data (the editor's completion list and the lesson's reference). */
export const PLAYBOOK_MODULES: readonly PlaybookModule[] = Object.freeze([
  {
    name: 'nf.hostname',
    description: 'Gives the device a name. Changes nothing when the device already has it.',
    params: [{ name: 'name', type: 'string', required: true, description: 'The new name, one word.' }],
  },
  {
    name: 'nf.banner',
    description: 'Sets the one-line message the device shows before login.',
    params: [{ name: 'motd', type: 'string', required: true, description: 'The message text.' }],
  },
  {
    name: 'nf.vlan',
    description: 'Makes sure a VLAN exists with the given name, or that it is gone.',
    params: [
      { name: 'id', type: 'integer', required: true, range: [1, 4094], description: 'The VLAN number.' },
      { name: 'name', type: 'string', required: false, description: 'The VLAN name; left as it is when not given.' },
      { name: 'state', type: 'string', required: false, choices: ['present', 'absent'], default: 'present', description: '"present" creates or renames the VLAN, "absent" removes it.' },
    ],
  },
  {
    name: 'nf.interface',
    description: 'Sets the description of an existing interface, and opens or shuts it.',
    params: [
      { name: 'name', type: 'string', required: true, description: 'The full interface name, for example GigabitEthernet0/1.' },
      { name: 'description', type: 'string', required: false, description: 'Free text saying what the interface is for.' },
      { name: 'enabled', type: 'boolean', required: false, description: 'true opens the interface, false shuts it down.' },
    ],
  },
  {
    name: 'nf.save_config',
    description: 'Saves the running configuration so it survives a restart. Counted as ok, never as a change.',
    params: [],
  },
] as PlaybookModule[]);

/** The module with this name, or undefined. */
export function playbookModule(name: string): PlaybookModule | undefined {
  return PLAYBOOK_MODULES.find((m) => m.name === name);
}

export type PlaybookArgs = Readonly<Record<string, string | number | boolean>>;

// ── playbook ─────────────────────────────────────────────────────────────────

export interface PlaybookTask {
  /** The task's own name, or a name made from its module. */
  readonly name: string;
  readonly module: PlaybookModuleName;
  /** The arguments, defaults filled in. */
  readonly args: PlaybookArgs;
  readonly line: number;
}

export interface PlaybookPlay {
  readonly name: string;
  /** Group names, host names or `all`. */
  readonly hosts: readonly string[];
  readonly tasks: readonly PlaybookTask[];
  readonly line: number;
}

export interface Playbook {
  readonly plays: readonly PlaybookPlay[];
}

const PLAY_KEYS = ['name', 'hosts', 'tasks'];

function readArgs(module: PlaybookModule, node: DataNode, errors: PlaybookError[]): PlaybookArgs | undefined {
  const obj = objectNode(node);
  if (obj === undefined && node.kind !== 'null') {
    errors.push(at(node.span, `The arguments of ${module.name} must be a mapping.`));
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  const before = errors.length;
  for (const e of obj?.entries ?? []) {
    const p = module.params.find((x) => x.name === e.key);
    if (p === undefined) {
      const known = module.params.map((x) => x.name);
      errors.push(at(e.keySpan, `${module.name} has no argument "${e.key}"${known.length > 0 ? ` (it takes ${known.join(', ')})` : ' (it takes none)'}.`));
      continue;
    }
    const v = dataValueOf(e.value);
    if (p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(at(e.value.span, `"${p.name}" of ${module.name} must be a whole number.`));
      else if (p.range !== undefined && (v < p.range[0] || v > p.range[1])) errors.push(at(e.value.span, `"${p.name}" of ${module.name} must be from ${p.range[0]} to ${p.range[1]}.`));
      else out[p.name] = v;
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') errors.push(at(e.value.span, `"${p.name}" of ${module.name} must be true or false.`));
      else out[p.name] = v;
    } else {
      const s = typeof v === 'number' ? String(v) : v;
      if (typeof s !== 'string') errors.push(at(e.value.span, `"${p.name}" of ${module.name} must be text.`));
      else if (p.choices !== undefined && !p.choices.includes(s)) errors.push(at(e.value.span, `"${p.name}" of ${module.name} must be one of: ${p.choices.join(', ')}.`));
      else out[p.name] = s;
    }
  }
  for (const p of module.params) {
    if (out[p.name] !== undefined) continue;
    if (p.default !== undefined) out[p.name] = p.default;
    else if (p.required && !(obj?.entries ?? []).some((e) => e.key === p.name)) errors.push(at(node.span, `${module.name} needs the argument "${p.name}".`));
  }
  if (module.name === 'nf.hostname' && typeof out.name === 'string' && !/^\S{1,63}$/.test(out.name)) {
    errors.push(at(node.span, 'nf.hostname: the name must be one word of at most 63 characters.'));
  }
  if (module.name === 'nf.vlan' && out.state === 'absent' && out.name !== undefined) {
    errors.push(at(node.span, 'nf.vlan: a VLAN being removed takes no "name".'));
  }
  return errors.length > before ? undefined : out;
}

function defaultTaskName(module: PlaybookModuleName, args: PlaybookArgs): string {
  switch (module) {
    case 'nf.hostname': return `name the device ${String(args.name)}`;
    case 'nf.banner': return 'set the login banner';
    case 'nf.vlan': return args.state === 'absent' ? `remove VLAN ${String(args.id)}` : `VLAN ${String(args.id)}`;
    case 'nf.interface': return `interface ${String(args.name)}`;
    case 'nf.save_config': return 'save the configuration';
  }
}

function readTask(node: DataNode, errors: PlaybookError[]): PlaybookTask | undefined {
  const obj = objectNode(node);
  if (obj === undefined) {
    errors.push(at(node.span, 'A task must be a mapping with one nf.* module.'));
    return undefined;
  }
  let name: string | undefined;
  let found: { module: PlaybookModule; value: DataNode } | undefined;
  let ok = true;
  for (const e of obj.entries) {
    if (e.key === 'name') {
      name = stringOf(e.value, 'A task name', errors);
      if (name === undefined) ok = false;
      continue;
    }
    const module = playbookModule(e.key);
    if (module === undefined) {
      errors.push(at(e.keySpan, e.key.startsWith('nf.')
        ? `There is no module "${e.key}". The modules are ${PLAYBOOK_MODULES.map((m) => m.name).join(', ')}.`
        : `Unknown key "${e.key}" in a task: a task has a "name" and one nf.* module.`));
      ok = false;
      continue;
    }
    if (found !== undefined) {
      errors.push(at(e.keySpan, `A task calls one module; this one also calls ${found.module.name}.`));
      ok = false;
      continue;
    }
    found = { module, value: e.value };
  }
  if (found === undefined) {
    if (ok) errors.push(at(node.span, 'This task calls no module.'));
    return undefined;
  }
  const args = readArgs(found.module, found.value, errors);
  if (!ok || args === undefined) return undefined;
  return { name: name ?? defaultTaskName(found.module.name, args), module: found.module.name, args, line: node.span.start.line };
}

function readHostPatterns(node: DataNode, errors: PlaybookError[]): string[] | undefined {
  const items = node.kind === 'array' ? node.items : [node];
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== 'string' || it.value.trim() === '') {
      errors.push(at(it.span, '"hosts" names a group, a host or "all", or lists several.'));
      return undefined;
    }
    out.push(...it.value.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  }
  if (out.length === 0) {
    errors.push(at(node.span, '"hosts" is empty.'));
    return undefined;
  }
  return out;
}

/** Reads a playbook file. With an inventory, every play's `hosts` must also name something in it. */
export function parsePlaybook(text: string, inventory?: PlaybookInventory): PlaybookParse<Playbook> {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ok: false, errors: [{ message: parsed.error.message, line: parsed.error.line, column: parsed.error.column }] };
  if (parsed.node.kind !== 'array' || parsed.node.items.length === 0) {
    return { ok: false, errors: [at(parsed.node.span, 'A playbook is a list of plays, each starting with "- name:".')] };
  }
  const errors: PlaybookError[] = [];
  const plays: PlaybookPlay[] = [];
  parsed.node.items.forEach((item, n) => {
    const obj = objectNode(item);
    if (obj === undefined) {
      errors.push(at(item.span, 'A play must be a mapping with "hosts" and "tasks".'));
      return;
    }
    let name: string | undefined;
    let hosts: string[] | undefined;
    let tasks: PlaybookTask[] | undefined;
    let ok = true;
    for (const e of obj.entries) {
      if (!PLAY_KEYS.includes(e.key)) {
        errors.push(at(e.keySpan, `Unknown key "${e.key}" in a play: a play has ${PLAY_KEYS.join(', ')}.`));
        ok = false;
      } else if (e.key === 'name') {
        name = stringOf(e.value, 'A play name', errors);
        ok &&= name !== undefined;
      } else if (e.key === 'hosts') {
        hosts = readHostPatterns(e.value, errors);
        if (hosts !== undefined && inventory !== undefined) {
          const sel = selectPlaybookHosts(inventory, hosts);
          if (!sel.ok) {
            errors.push(at(e.value.span, `"${sel.unknown}" names no group or host of the inventory.`));
            hosts = undefined;
          }
        }
        ok &&= hosts !== undefined;
      } else if (e.value.kind !== 'array' || e.value.items.length === 0) {
        errors.push(at(e.value.span, '"tasks" must be a list of at least one task.'));
        ok = false;
      } else {
        const before = errors.length;
        tasks = e.value.items.map((t) => readTask(t, errors)).filter((t): t is PlaybookTask => t !== undefined);
        ok &&= errors.length === before;
      }
    }
    if (hosts === undefined && !obj.entries.some((e) => e.key === 'hosts')) errors.push(at(item.span, 'This play has no "hosts".'));
    if (tasks === undefined && !obj.entries.some((e) => e.key === 'tasks')) errors.push(at(item.span, 'This play has no "tasks".'));
    if (ok && hosts !== undefined && tasks !== undefined) plays.push({ name: name ?? `play ${n + 1}`, hosts, tasks, line: item.span.start.line });
  });
  if (errors.length > 0) return { ok: false, errors: byLine(errors) };
  return { ok: true, value: { plays } };
}

// ── planning a task (idempotence) ────────────────────────────────────────────

/** One RESTCONF request a task makes (the runner adds the host's address and login). */
export interface PlaybookRequest {
  readonly method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  /** From `/restconf/…`. */
  readonly path: string;
  /** JSON text (RFC 7951). */
  readonly body?: string;
}

/** The answer to a request, as the runner got it. `status` 0: no answer (the host is unreachable). */
export interface PlaybookResponse {
  readonly status: number;
  /** The parsed JSON body of a 200 answer. */
  readonly body?: DataValue;
}

const DATA = '/restconf/data';
const vlanPath = (id: number): string => `${DATA}/nf-native:native/vlan/vlan-list=${id}`;
const ifPath = (name: string): string => `${DATA}/ietf-interfaces:interfaces/interface=${percentEncodeKey(name)}`;
export const PLAYBOOK_SAVE_PATH = '/restconf/operations/nf-native:save-config';

/** The GET that reads the current setting of a task, or undefined for a task that only acts (nf.save_config). */
export function playbookReadRequest(task: PlaybookTask): PlaybookRequest | undefined {
  const a = task.args;
  switch (task.module) {
    case 'nf.hostname': return { method: 'GET', path: `${DATA}/nf-native:native/hostname` };
    case 'nf.banner': return { method: 'GET', path: `${DATA}/nf-native:native/banner/motd` };
    case 'nf.vlan': return { method: 'GET', path: vlanPath(a.id as number) };
    case 'nf.interface': return { method: 'GET', path: ifPath(a.name as string) };
    case 'nf.save_config': return undefined;
  }
}

/** What a task does once its setting is known. */
export type PlaybookDecision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'write'; readonly request: PlaybookRequest; readonly changes: boolean }
  | { readonly kind: 'failed'; readonly message: string };

const member = (body: DataValue | undefined, name: string): DataValue | undefined =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? body[name] : undefined;
const firstEntry = (body: DataValue | undefined, name: string): Record<string, DataValue> | undefined => {
  const list = member(body, name);
  const e = Array.isArray(list) ? list[0] : undefined;
  return e !== null && typeof e === 'object' && !Array.isArray(e) ? e : undefined;
};

function refused(status: number, what: string): PlaybookDecision {
  if (status === 401) return { kind: 'failed', message: `the device refused the login (HTTP 401) while ${what}` };
  return { kind: 'failed', message: `the device answered HTTP ${status} while ${what}` };
}

/**
 * Decides a task from the answer to its read (`undefined` for a task with no read). A setting that already matches
 * is `ok`; a different one is a `write` that changes it. The caller treats status 0 as unreachable before calling.
 */
export function decidePlaybookTask(task: PlaybookTask, read: PlaybookResponse | undefined): PlaybookDecision {
  const a = task.args;
  if (task.module === 'nf.save_config') return { kind: 'write', request: { method: 'POST', path: PLAYBOOK_SAVE_PATH }, changes: false };
  const r = read ?? { status: 0 };
  const found = r.status === 200;
  if (!found && r.status !== 404) return refused(r.status, 'reading the current setting');
  switch (task.module) {
    case 'nf.hostname': {
      if (found && member(r.body, 'nf-native:hostname') === a.name) return { kind: 'ok' };
      return { kind: 'write', changes: true, request: { method: 'PUT', path: `${DATA}/nf-native:native/hostname`, body: JSON.stringify({ 'nf-native:hostname': a.name }) } };
    }
    case 'nf.banner': {
      if (found && member(r.body, 'nf-native:motd') === a.motd) return { kind: 'ok' };
      return { kind: 'write', changes: true, request: { method: 'PUT', path: `${DATA}/nf-native:native/banner/motd`, body: JSON.stringify({ 'nf-native:motd': a.motd }) } };
    }
    case 'nf.vlan': {
      const id = a.id as number;
      if (a.state === 'absent') return found ? { kind: 'write', changes: true, request: { method: 'DELETE', path: vlanPath(id) } } : { kind: 'ok' };
      const cur = found ? firstEntry(r.body, 'nf-native:vlan-list') : undefined;
      if (found && (a.name === undefined || cur?.name === a.name)) return { kind: 'ok' };
      const entry: Record<string, DataValue> = { id };
      const name = a.name ?? cur?.name;
      if (typeof name === 'string') entry.name = name;
      return { kind: 'write', changes: true, request: { method: 'PUT', path: vlanPath(id), body: JSON.stringify({ 'nf-native:vlan-list': [entry] }) } };
    }
    case 'nf.interface': {
      if (!found) return { kind: 'failed', message: `the device has no interface ${String(a.name)}` };
      const cur = firstEntry(r.body, 'ietf-interfaces:interface');
      const entry: Record<string, DataValue> = { name: a.name as string };
      if (a.description !== undefined && (cur?.description ?? '') !== a.description) entry.description = a.description;
      if (a.enabled !== undefined && (cur?.enabled ?? true) !== a.enabled) entry.enabled = a.enabled;
      if (Object.keys(entry).length === 1) return { kind: 'ok' };
      return { kind: 'write', changes: true, request: { method: 'PATCH', path: ifPath(a.name as string), body: JSON.stringify({ 'ietf-interfaces:interface': [entry] }) } };
    }
  }
}

/** The outcome of a write: `changed` (or `ok` for a write that changes no setting) on 2xx, else failed. */
export function playbookWriteOutcome(decision: Extract<PlaybookDecision, { kind: 'write' }>, res: PlaybookResponse): { kind: 'ok' | 'changed' } | { kind: 'failed'; message: string } {
  if (res.status >= 200 && res.status < 300) return { kind: decision.changes ? 'changed' : 'ok' };
  return refused(res.status, 'writing the change') as { kind: 'failed'; message: string };
}

// ── the run ──────────────────────────────────────────────────────────────────

export type PlaybookOutcome = 'ok' | 'changed' | 'failed' | 'unreachable';

/** One host's totals (the shape of `ScriptRunRow.recap`). */
export interface PlaybookRecapEntry {
  host: string;
  ok: number;
  changed: number;
  failed: number;
  unreachable: number;
}

/** What `runPlaybook` asks of its runner: send a request (answered through `next(response)`), or print a line. */
export type PlaybookEffect =
  | { readonly kind: 'request'; readonly host: PlaybookHost; readonly request: PlaybookRequest }
  | { readonly kind: 'line'; readonly text: string };

/** The console lines (original layout). */
export const playbookPlayLine = (play: PlaybookPlay, hosts: number): string => `=== play: ${play.name} (${hosts} host${hosts === 1 ? '' : 's'})`;
export const playbookTaskLine = (task: PlaybookTask): string => `--- task: ${task.name} [${task.module}]`;
export function playbookHostLine(host: string, outcome: PlaybookOutcome, message?: string): string {
  return `    ${host}: ${outcome}${message !== undefined ? ` - ${message}` : ''}`;
}

/** The recap block: a header and one line per host, in inventory order. */
export function playbookRecapLines(recap: readonly PlaybookRecapEntry[]): string[] {
  const width = Math.max(4, ...recap.map((r) => r.host.length));
  return [
    '=== summary',
    ...recap.map((r) => `    ${r.host.padEnd(width)}  ok ${r.ok}, changed ${r.changed}, failed ${r.failed}, unreachable ${r.unreachable}`),
  ];
}

/**
 * Runs a playbook against an inventory as a generator: it yields effects and receives the answer to each `request`
 * effect through `next(response)` (undefined for a `line`). It returns the recap, one entry per host any play
 * selected, in inventory order. Deterministic: the same answers give the same effects.
 */
export function* runPlaybook(pb: Playbook, inv: PlaybookInventory): Generator<PlaybookEffect, PlaybookRecapEntry[], PlaybookResponse | undefined> {
  const recap = new Map<string, PlaybookRecapEntry>();
  const entry = (h: string): PlaybookRecapEntry => {
    let e = recap.get(h);
    if (e === undefined) recap.set(h, (e = { host: h, ok: 0, changed: 0, failed: 0, unreachable: 0 }));
    return e;
  };
  for (const play of pb.plays) {
    const sel = selectPlaybookHosts(inv, play.hosts);
    const hosts = sel.ok ? sel.hosts : [];
    yield { kind: 'line', text: playbookPlayLine(play, hosts.length) };
    if (!sel.ok) {
      yield { kind: 'line', text: `    "${sel.unknown}" names no group or host of the inventory; the play is skipped` };
      continue;
    }
    hosts.forEach((h) => entry(h.name));
    const stopped = new Set<string>();
    for (const task of play.tasks) {
      yield { kind: 'line', text: playbookTaskLine(task) };
      for (const host of hosts) {
        if (stopped.has(host.name)) continue;
        const e = entry(host.name);
        let outcome: PlaybookOutcome;
        let message: string | undefined;
        const readReq = playbookReadRequest(task);
        const read = readReq !== undefined ? (yield { kind: 'request', host, request: readReq }) ?? { status: 0 } : undefined;
        if (read?.status === 0) outcome = 'unreachable';
        else {
          const d = decidePlaybookTask(task, read);
          if (d.kind === 'ok') outcome = 'ok';
          else if (d.kind === 'failed') ({ kind: outcome, message } = d);
          else {
            const res = (yield { kind: 'request', host, request: d.request }) ?? { status: 0 };
            if (res.status === 0) outcome = 'unreachable';
            else {
              const w = playbookWriteOutcome(d, res);
              outcome = w.kind;
              if (w.kind === 'failed') message = w.message;
            }
          }
        }
        if (outcome === 'unreachable') message = `no answer from ${host.address}`;
        e[outcome]++;
        if (outcome === 'failed' || outcome === 'unreachable') stopped.add(host.name);
        yield { kind: 'line', text: playbookHostLine(host.name, outcome, message) };
      }
    }
  }
  const out = inv.hosts.filter((h) => recap.has(h.name)).map((h) => recap.get(h.name) as PlaybookRecapEntry);
  for (const line of playbookRecapLines(out)) yield { kind: 'line', text: line };
  return out;
}
