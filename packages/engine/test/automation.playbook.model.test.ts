/**
 * automation/playbook/model.ts — inventory, plays, tasks, the nf.* modules, idempotent planning and the run order.
 * [C22] Legal (Q10 / L3): our own dialect; no vendor word and no other tool's name in any learner-visible string.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLAYBOOK_MODULES,
  PLAYBOOK_SAVE_PATH,
  decidePlaybookTask,
  parseInventory,
  parsePlaybook,
  playbookHostLine,
  playbookPlayLine,
  playbookReadRequest,
  playbookRecapLines,
  playbookTaskLine,
  runPlaybook,
  selectPlaybookHosts,
  type Playbook,
  type PlaybookEffect,
  type PlaybookInventory,
  type PlaybookRecapEntry,
  type PlaybookRequest,
  type PlaybookResponse,
  type PlaybookTask,
} from '../src/automation/playbook/model.js';
import { parseJson, type DataValue } from '../src/automation/data/json.js';
import { findBannedWords } from '../src/device/catalog/validate.js';

/** The automation tool name Q10 / L3 bans, matched case-insensitively (built reversed so this file never spells it). */
const TOOL_WORD = new RegExp([...'elbisna'].reverse().join(''), 'i');

const INVENTORY = [
  'switches:',
  '  vars:',
  '    user: netadmin',
  '    password: Lab-pass1',
  '  hosts:',
  '    SW1:',
  '      address: 192.168.10.11',
  '    SW2: { address: 192.168.10.12 }',
  '    SW3: { address: 192.168.10.13, user: other }',
  'core:',
  '  hosts:',
  '    R1: { address: 192.168.10.1 }',
  '    SW1: {}',
].join('\n');

const PLAYBOOK = [
  '- name: The lab VLANs',
  '  hosts: switches',
  '  tasks:',
  '    - name: VLAN 10 for sales',
  '      nf.vlan: { id: 10, name: SALES }',
  '    - nf.vlan:',
  '        id: 20',
  '    - nf.save_config: {}',
].join('\n');

const inv = (): PlaybookInventory => {
  const r = parseInventory(INVENTORY);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const pb = (text: string, i?: PlaybookInventory): Playbook => {
  const r = parsePlaybook(text, i);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const errorsOf = (r: { ok: boolean; errors?: readonly { message: string; line: number }[] }): string[] =>
  r.ok ? [] : (r.errors ?? []).map((e) => `${e.line}: ${e.message}`);

describe('inventory', () => {
  it('reads groups, hosts and group vars; a host keeps its first place and gains groups', () => {
    const i = inv();
    expect(i.groups).toEqual([{ name: 'switches', hosts: ['SW1', 'SW2', 'SW3'] }, { name: 'core', hosts: ['R1', 'SW1'] }]);
    expect(i.hosts).toEqual([
      { name: 'SW1', address: '192.168.10.11', groups: ['switches', 'core'], user: 'netadmin', password: 'Lab-pass1' },
      { name: 'SW2', address: '192.168.10.12', groups: ['switches'], user: 'netadmin', password: 'Lab-pass1' },
      { name: 'SW3', address: '192.168.10.13', groups: ['switches'], user: 'other', password: 'Lab-pass1' },
      { name: 'R1', address: '192.168.10.1', groups: ['core'] },
    ]);
  });

  it('selects hosts by group, host, all and lists, in inventory order', () => {
    const i = inv();
    const names = (p: string[]) => { const s = selectPlaybookHosts(i, p); return s.ok ? s.hosts.map((h) => h.name) : s.unknown; };
    expect(names(['core'])).toEqual(['SW1', 'R1']);
    expect(names(['all'])).toEqual(['SW1', 'SW2', 'SW3', 'R1']);
    expect(names(['R1', 'SW2'])).toEqual(['SW2', 'R1']);
    expect(names(['nowhere'])).toBe('nowhere');
  });

  it('reports each problem with its line', () => {
    expect(errorsOf(parseInventory('a: [1'))).toHaveLength(1);
    expect(errorsOf(parseInventory('- x'))).toEqual(['1: An inventory is a mapping of groups, each with a "hosts" mapping.']);
    expect(errorsOf(parseInventory(['g:', '  hosts:', '    S1: { address: 10.0.0.300 }', '    S2: { port: 22 }', '  extra: 1'].join('\n')))).toEqual([
      '3: "10.0.0.300" is not an IPv4 address (host "S1").',
      '3: Host "S1" has no address.',
      '4: Unknown key "port" for host "S2": a host may set address, user, password.',
      '4: Host "S2" has no address.',
      '5: Unknown key "extra" in group "g": a group has "hosts" and, optionally, "vars".',
    ]);
    expect(errorsOf(parseInventory('all:\n  hosts: {}'))[0]).toMatch(/cannot name a group/);
    expect(errorsOf(parseInventory('g:\n  vars: { user: a }'))).toEqual(['1: Group "g" lists no hosts.']);
  });
});

describe('playbook', () => {
  it('reads plays and tasks, fills defaults and names unnamed tasks', () => {
    const p = pb(PLAYBOOK, inv());
    expect(p.plays).toHaveLength(1);
    const play = p.plays[0]!;
    expect([play.name, play.hosts, play.line]).toEqual(['The lab VLANs', ['switches'], 1]);
    expect(play.tasks.map((t) => [t.name, t.module, t.args, t.line])).toEqual([
      ['VLAN 10 for sales', 'nf.vlan', { id: 10, name: 'SALES', state: 'present' }, 4],
      ['VLAN 20', 'nf.vlan', { id: 20, state: 'present' }, 6],
      ['save the configuration', 'nf.save_config', {}, 8],
    ]);
    expect(pb('- hosts: SW1, R1\n  tasks:\n    - nf.hostname: { name: CORE }').plays[0]).toMatchObject({ name: 'play 1', hosts: ['SW1', 'R1'] });
    expect(pb('- hosts: [SW1, core]\n  tasks:\n    - nf.interface: { name: Gi0/1, enabled: false }').plays[0]!.hosts).toEqual(['SW1', 'core']);
  });

  it('refuses unknown modules, unknown arguments, wrong types and missing parts, with lines', () => {
    const bad = [
      '- name: p',
      '  hosts: nowhere',
      '  tasks:',
      '    - nf.vlans: { id: 1 }',
      '    - nf.vlan: { id: 5000 }',
      '    - nf.vlan: { id: 10, colour: red }',
      '    - nf.interface: { enabled: yes }',
      '    - shell: ls',
      '    - nf.vlan: { id: 2 }',
      '      nf.hostname: { name: X }',
      '    - name: no module',
      '  when: always',
    ].join('\n');
    expect(errorsOf(parsePlaybook(bad, inv()))).toEqual([
      '2: "nowhere" names no group or host of the inventory.',
      '4: There is no module "nf.vlans". The modules are nf.hostname, nf.banner, nf.vlan, nf.interface, nf.save_config.',
      '5: "id" of nf.vlan must be from 1 to 4094.',
      '6: nf.vlan has no argument "colour" (it takes id, name, state).',
      '7: "enabled" of nf.interface must be true or false.',
      '7: nf.interface needs the argument "name".',
      '8: Unknown key "shell" in a task: a task has a "name" and one nf.* module.',
      '10: A task calls one module; this one also calls nf.vlan.',
      '11: This task calls no module.',
      '12: Unknown key "when" in a play: a play has name, hosts, tasks.',
    ]);
    expect(errorsOf(parsePlaybook('name: x'))).toEqual(['1: A playbook is a list of plays, each starting with "- name:".']);
    expect(errorsOf(parsePlaybook('- name: x'))).toEqual(['1: This play has no "hosts".', '1: This play has no "tasks".']);
    expect(errorsOf(parsePlaybook('- hosts: all\n  tasks: []'))).toEqual(['2: "tasks" must be a list of at least one task.']);
    expect(errorsOf(parsePlaybook('- hosts: all\n  tasks:\n    - nf.vlan: { id: 3, state: absent, name: X }'))).toEqual(['3: nf.vlan: a VLAN being removed takes no "name".']);
    expect(errorsOf(parsePlaybook('- hosts: all\n  tasks:\n    - nf.hostname: { name: two words }'))).toEqual(['3: nf.hostname: the name must be one word of at most 63 characters.']);
  });
});

const task = (module: PlaybookTask['module'], args: PlaybookTask['args']): PlaybookTask => ({ name: 't', module, args, line: 1 });
const ok200 = (json: string): PlaybookResponse => ({ status: 200, body: (parseJson(json) as { value: DataValue }).value });

describe('modules plan idempotent RESTCONF requests', () => {
  it('nf.vlan: present, renamed, absent', () => {
    const t = task('nf.vlan', { id: 10, name: 'SALES', state: 'present' });
    expect(playbookReadRequest(t)).toEqual({ method: 'GET', path: '/restconf/data/nf-native:native/vlan/vlan-list=10' });
    expect(decidePlaybookTask(t, ok200('{"nf-native:vlan-list":[{"id":10,"name":"SALES"}]}'))).toEqual({ kind: 'ok' });
    const put = { method: 'PUT', path: '/restconf/data/nf-native:native/vlan/vlan-list=10', body: '{"nf-native:vlan-list":[{"id":10,"name":"SALES"}]}' };
    expect(decidePlaybookTask(t, ok200('{"nf-native:vlan-list":[{"id":10,"name":"OLD"}]}'))).toEqual({ kind: 'write', changes: true, request: put });
    expect(decidePlaybookTask(t, { status: 404 })).toEqual({ kind: 'write', changes: true, request: put });
    const noName = task('nf.vlan', { id: 20, state: 'present' });
    expect(decidePlaybookTask(noName, ok200('{"nf-native:vlan-list":[{"id":20,"name":"X"}]}'))).toEqual({ kind: 'ok' });
    expect(decidePlaybookTask(noName, { status: 404 })).toMatchObject({ request: { body: '{"nf-native:vlan-list":[{"id":20}]}' } });
    const gone = task('nf.vlan', { id: 30, state: 'absent' });
    expect(decidePlaybookTask(gone, { status: 404 })).toEqual({ kind: 'ok' });
    expect(decidePlaybookTask(gone, ok200('{"nf-native:vlan-list":[{"id":30}]}'))).toEqual({ kind: 'write', changes: true, request: { method: 'DELETE', path: '/restconf/data/nf-native:native/vlan/vlan-list=30' } });
  });

  it('nf.hostname, nf.banner, nf.interface, nf.save_config', () => {
    const h = task('nf.hostname', { name: 'CORE1' });
    expect(decidePlaybookTask(h, ok200('{"nf-native:hostname":"CORE1"}'))).toEqual({ kind: 'ok' });
    expect(decidePlaybookTask(h, ok200('{"nf-native:hostname":"SW1"}'))).toEqual({ kind: 'write', changes: true, request: { method: 'PUT', path: '/restconf/data/nf-native:native/hostname', body: '{"nf-native:hostname":"CORE1"}' } });
    const b = task('nf.banner', { motd: 'Authorised staff only' });
    expect(playbookReadRequest(b)!.path).toBe('/restconf/data/nf-native:native/banner/motd');
    expect(decidePlaybookTask(b, { status: 404 })).toMatchObject({ kind: 'write', request: { method: 'PUT', body: '{"nf-native:motd":"Authorised staff only"}' } });
    const i = task('nf.interface', { name: 'GigabitEthernet0/1', description: 'to SW2', enabled: true });
    expect(playbookReadRequest(i)!.path).toBe('/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1');
    expect(decidePlaybookTask(i, ok200('{"ietf-interfaces:interface":[{"name":"GigabitEthernet0/1","description":"to SW2"}]}'))).toEqual({ kind: 'ok' });
    expect(decidePlaybookTask(i, ok200('{"ietf-interfaces:interface":[{"name":"GigabitEthernet0/1","enabled":false}]}'))).toEqual({
      kind: 'write', changes: true,
      request: { method: 'PATCH', path: '/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1', body: '{"ietf-interfaces:interface":[{"name":"GigabitEthernet0/1","description":"to SW2","enabled":true}]}' },
    });
    expect(decidePlaybookTask(i, { status: 404 })).toEqual({ kind: 'failed', message: 'the device has no interface GigabitEthernet0/1' });
    expect(decidePlaybookTask(h, { status: 401 })).toEqual({ kind: 'failed', message: 'the device refused the login (HTTP 401) while reading the current setting' });
    const s = task('nf.save_config', {});
    expect(playbookReadRequest(s)).toBeUndefined();
    expect(decidePlaybookTask(s, undefined)).toEqual({ kind: 'write', changes: false, request: { method: 'POST', path: PLAYBOOK_SAVE_PATH } });
  });
});

/** A fake set of devices answering RESTCONF over a VLAN store, for the run tests. */
function fakeNet(down: readonly string[] = [], refuse: readonly string[] = []) {
  const vlans = new Map<string, Map<number, string | undefined>>();
  const log: string[] = [];
  const answer = (host: string, r: PlaybookRequest): PlaybookResponse => {
    log.push(`${host} ${r.method} ${r.path}`);
    if (down.includes(host)) return { status: 0 };
    if (refuse.includes(host)) return { status: 401 };
    if (r.path === PLAYBOOK_SAVE_PATH) return { status: 204 };
    const store = vlans.get(host) ?? new Map<number, string | undefined>();
    vlans.set(host, store);
    const id = Number(/vlan-list=(\d+)$/.exec(r.path)![1]);
    if (r.method === 'GET') {
      if (!store.has(id)) return { status: 404 };
      const name = store.get(id);
      return { status: 200, body: { 'nf-native:vlan-list': [name === undefined ? { id } : { id, name }] } };
    }
    if (r.method === 'DELETE') { store.delete(id); return { status: 204 }; }
    const existed = store.has(id);
    const e = (JSON.parse(r.body!) as { 'nf-native:vlan-list': { name?: string }[] })['nf-native:vlan-list'][0]!;
    store.set(id, e.name);
    return { status: existed ? 204 : 201 };
  };
  const run = (p: Playbook, i: PlaybookInventory): { lines: string[]; recap: PlaybookRecapEntry[] } => {
    const lines: string[] = [];
    const g = runPlaybook(p, i);
    let next = g.next();
    while (!next.done) {
      const eff: PlaybookEffect = next.value;
      if (eff.kind === 'line') { lines.push(eff.text); next = g.next(); }
      else next = g.next(answer(eff.host.name, eff.request));
    }
    return { lines, recap: next.value };
  };
  return { run, log };
}

describe('a run', () => {
  it('the first run changes N, the second changes nothing; lines and recap exact', () => {
    const i = inv();
    const p = pb(PLAYBOOK, i);
    const net = fakeNet();
    const first = net.run(p, i);
    expect(first.recap).toEqual([
      { host: 'SW1', ok: 1, changed: 2, failed: 0, unreachable: 0 },
      { host: 'SW2', ok: 1, changed: 2, failed: 0, unreachable: 0 },
      { host: 'SW3', ok: 1, changed: 2, failed: 0, unreachable: 0 },
    ]);
    expect(first.lines).toEqual([
      '=== play: The lab VLANs (3 hosts)',
      '--- task: VLAN 10 for sales [nf.vlan]',
      '    SW1: changed', '    SW2: changed', '    SW3: changed',
      '--- task: VLAN 20 [nf.vlan]',
      '    SW1: changed', '    SW2: changed', '    SW3: changed',
      '--- task: save the configuration [nf.save_config]',
      '    SW1: ok', '    SW2: ok', '    SW3: ok',
      '=== summary',
      '    SW1   ok 1, changed 2, failed 0, unreachable 0',
      '    SW2   ok 1, changed 2, failed 0, unreachable 0',
      '    SW3   ok 1, changed 2, failed 0, unreachable 0',
    ]);
    const second = net.run(p, i);
    expect(second.recap.map((r) => [r.ok, r.changed])).toEqual([[3, 0], [3, 0], [3, 0]]);
  });

  it('a failed or unreachable host stops for the play; the others carry on', () => {
    const i = inv();
    const p = pb(PLAYBOOK, i);
    const net = fakeNet(['SW2'], ['SW3']);
    const r = net.run(p, i);
    expect(r.recap).toEqual([
      { host: 'SW1', ok: 1, changed: 2, failed: 0, unreachable: 0 },
      { host: 'SW2', ok: 0, changed: 0, failed: 0, unreachable: 1 },
      { host: 'SW3', ok: 0, changed: 0, failed: 1, unreachable: 0 },
    ]);
    expect(r.lines.slice(2, 5)).toEqual([
      '    SW1: changed',
      '    SW2: unreachable - no answer from 192.168.10.12',
      '    SW3: failed - the device refused the login (HTTP 401) while reading the current setting',
    ]);
    expect(net.log.filter((l) => !l.startsWith('SW1'))).toHaveLength(2);
  });

  it('is deterministic', () => {
    const i = inv();
    const p = pb(PLAYBOOK, i);
    expect(fakeNet().run(p, i)).toEqual(fakeNet().run(p, i));
  });
});

describe('legal (Q10 / L3)', () => {
  it('no learner-visible string names a vendor or another automation tool', () => {
    const texts = [
      ...PLAYBOOK_MODULES.flatMap((m) => [m.name, m.description, ...m.params.flatMap((p) => [p.name, p.description, ...(p.choices ?? [])])]),
      playbookPlayLine({ name: 'x', hosts: ['all'], tasks: [], line: 1 }, 2),
      playbookTaskLine(task('nf.vlan', { id: 1 })),
      playbookHostLine('SW1', 'failed', 'm'),
      ...playbookRecapLines([{ host: 'SW1', ok: 1, changed: 0, failed: 0, unreachable: 0 }]),
      ...errorsOf(parsePlaybook('- name: p\n  hosts: x\n  tasks:\n    - nf.nope: {}\n    - foo: 1\n  bar: 2', inv())),
      ...errorsOf(parseInventory('g:\n  hosts:\n    S: { a: 1 }\n  b: 2')),
    ];
    for (const t of texts) {
      expect(findBannedWords(t), t).toEqual([]);
      expect(TOOL_WORD.test(t), t).toBe(false);
    }
  });

  it('neither model source file contains the banned tool name', () => {
    for (const f of ['../src/automation/playbook/model.ts', '../src/automation/mib/model.ts']) {
      expect(TOOL_WORD.test(readFileSync(new URL(f, import.meta.url), 'utf8')), f).toBe(false);
    }
  });
});
