/**
 * cli/grammar/acl.ts and cli/handlers/acl.ts, the P3 part (ARCHITECTURE-P3 §5.2, §5.8, D12, D14; §7 W2 cli part 1):
 * extended entries in every form and `log` on standard ones, stored in core/acl's canonical text; remarks; sequence
 * editing in a list section (`15 permit …`, `no 15`, a taken number, `ip access-list resequence`); `ip access-group`
 * with one list per direction (D12), the undefined-list note and the switched-port refusal; `clear access-list
 * counters`; `show access-lists [<list>]` with the `acl` rows' match counts and never the implicit deny; `show ip
 * interface`; the lists on a managed switch (D14); the `config-ext-nacl` mode (no longer reserved, §9.2 W2 item 22).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import { aclKey, type AclRow, type Table, type TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  MSG_ACL_NO_SEQ,
  MSG_ACL_NOT_CONFIGURED,
  MSG_ACL_OTHER_TYPE,
  MSG_ACL_SEQ_ALONE,
  MSG_ACL_SEQ_TAKEN,
  MSG_ACL_TYPE_MISMATCH,
  MSG_ACL_UNKNOWN,
  MSG_NO_LIST_SECTION,
  renderAcl,
  typedEntryTokens,
} from '../src/cli/handlers/acl.js';
import { readAcls, readStandardAcls } from '../src/core/acl.js';
import { modeForContext, modesOfClass } from '../src/cli/modes.js';
import { matchCommand, type MatchResult } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');
const GI0 = 'GigabitEthernet0/0';
const NAMED = [['ip', 'access-list', 'extended', 'NO-WEB']];

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

function router(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(ROUTER, { mode: 'config', ...opts });
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string): MatchResult => matchCommand(GRAMMAR, ctx, line);

/** Run a typed line through the grammar and its handler (the args the parser produced), on `rec`. */
function typed(rec: RecordingCtx, mode: Parameters<typeof matchContextFor>[1], line: string, opts: { iface?: string } = {}): CommandOutcome {
  const m = matchCommand(GRAMMAR, matchContextFor(rec.ctx.model, mode, opts.iface === undefined ? {} : { iface: opts.iface }), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

function attachAcl(rec: RecordingCtx): Table<AclRow> {
  const t = createTable<AclRow>({ name: 'acl', device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set('acl', t as unknown as Table<TableRow>);
  return t;
}

describe('parsing and scope', () => {
  it('parses the extended forms and standard log on a router', () => {
    const cfg = matchContextFor(ROUTER, 'config');
    const cases: [string, Record<string, string>][] = [
      ['access-list 100 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log', { number: '100', action: 'deny', proto: 'tcp', srcForm: 'host', src: '192.168.10.10', dstForm: 'host', dport: 'www', dportOp: 'eq', log: 'log' }],
      ['access-list 101 permit icmp 192.168.10.0 0.0.0.255 any echo-reply', { proto: 'icmp', srcForm: 'net', srcWild: '0.0.0.255', dstForm: 'any', icmpForm: 'msg', icmp: 'echo-reply' }],
      ['access-list 101 permit icmp any any 3 4', { icmpForm: 'code', icmpType: '3', icmpCode: '4' }],
      ['access-list 102 permit tcp any range 1000 2000 any eq 80 established', { sportForm: 'range', sport: '1000', sportHigh: '2000', dportForm: 'op', dport: '80', established: 'established' }],
      ['access-list 103 permit udp any any eq domain', { proto: 'udp', dportOp: 'eq', dport: 'domain' }],
      ['access-list 104 permit ip any any', { protocol: 'ip', srcForm: 'any', dstForm: 'any' }],
      ['access-list 104 permit ospf any any log', { protocol: 'ospf', log: 'log' }],
      ['access-list 104 permit 47 any host 10.0.0.1', { protocol: '47', dstForm: 'host', dst: '10.0.0.1' }],
      ['access-list 2000 permit tcp any gt 1023 any lt 1024', { number: '2000', sportOp: 'gt', sport: '1023', dportOp: 'lt', dport: '1024' }],
      ['access-list 10 permit 192.168.10.0 0.0.0.255 log', { type: 'standard', srcForm: 'net', log: 'log' }],
      ['access-list 10 deny host 192.168.10.5 log', { type: 'standard', srcForm: 'host', src: '192.168.10.5' }],
      ['access-list 10 permit any log', { type: 'standard', srcForm: 'any' }],
    ];
    for (const [line, args] of cases) {
      const m = ok(cfg, line);
      expect(m, line).toMatchObject({ ok: true, args });
      if (m.ok) expect(m.spec.handler, line).toBe(HANDLERS.configAccessListEntry);
    }
    // the P2 standard forms keep their P2 spec (no log)
    expect(ok(cfg, 'access-list 10 permit 192.168.10.0 0.0.0.255')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configAccessList } });
    expect(ok(cfg, 'access-list 100 remark keep the web server private')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configAccessListRemark }, args: { text: 'keep the web server private' } });
    expect(ok(cfg, 'access-list 100 deny tcp any any eq 70000').ok).toBe(false);
    expect(ok(cfg, 'ip access-list extended NO-WEB')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configIpAccessListExtended, entersMode: 'config-ext-nacl' } });
    expect(ok(cfg, 'ip access-list resequence NO-WEB 100 5')).toMatchObject({ ok: true, args: { list: 'NO-WEB', start: '100', step: '5' } });
    const ext = matchContextFor(ROUTER, 'config-ext-nacl');
    expect(ok(ext, 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www')).toMatchObject({ ok: true, spec: { handler: HANDLERS.naclEntryP3 }, args: { action: 'deny' } });
    expect(ok(ext, '15 permit ip any any')).toMatchObject({ ok: true, args: { seq: '15', action: 'permit' } });
    expect(ok(ext, 'no 15')).toMatchObject({ ok: true, negated: true, spec: { handler: HANDLERS.naclSeq }, args: { seq: '15' } });
    expect(ok(ext, 'remark web servers')).toMatchObject({ ok: true, spec: { handler: HANDLERS.naclRemark } });
    const std = matchContextFor(ROUTER, 'config-std-nacl');
    expect(ok(std, 'permit any log')).toMatchObject({ ok: true, spec: { handler: HANDLERS.naclEntryP3 }, args: { log: 'log' } });
    expect(ok(std, '25 deny host 10.0.0.1')).toMatchObject({ ok: true, args: { seq: '25', src: '10.0.0.1' } });
    expect(ok(std, 'permit any')).toMatchObject({ ok: true, spec: { handler: HANDLERS.naclEntry } });
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(ok(ifc, 'ip access-group NO-WEB in')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifIpAccessGroup }, args: { list: 'NO-WEB', direction: 'in' } });
    expect(ok(ifc, 'ip access-group 10 out')).toMatchObject({ ok: true, args: { direction: 'out' } });
    expect(ok(ifc, 'no ip access-group in')).toMatchObject({ ok: true, negated: true });
    const exec = matchContextFor(ROUTER, 'priv-exec');
    expect(ok(exec, 'clear access-list counters')).toMatchObject({ ok: true, spec: { handler: HANDLERS.execClearAccessListCounters } });
    expect(ok(exec, 'clear access-list counters 10')).toMatchObject({ ok: true, args: { list: '10' } });
    expect(ok(exec, 'show access-lists 10')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showAccessLists }, args: { list: '10' } });
    expect(ok(exec, 'show ip access-lists')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showAccessLists } });
    expect(ok(exec, 'show ip interface')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showIpInterface } });
    expect(ok(exec, 'show ip interface g0/0')).toMatchObject({ ok: true, args: { iface: GI0 } });
    // the P1 brief listing keeps its own spec
    expect(ok(exec, 'show ip interface brief')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showIpIntBrief } });
  });

  it('offers every ACL line on a managed switch too (D14), never on a host', () => {
    const cfg = matchContextFor(SWITCH, 'config');
    expect(ok(cfg, 'access-list 10 permit host 192.168.10.10').ok).toBe(true);
    expect(ok(cfg, 'access-list 10 permit any log').ok).toBe(true);
    expect(ok(cfg, 'access-list 100 permit tcp any any eq 22').ok).toBe(true);
    expect(ok(cfg, 'ip access-list standard VTY').ok).toBe(true);
    expect(ok(cfg, 'ip access-list extended MGMT').ok).toBe(true);
    expect(ok(matchContextFor(SWITCH, 'config-line'), 'access-class 10 in').ok).toBe(true);
    expect(ok(matchContextFor(SWITCH, 'priv-exec'), 'show access-lists').ok).toBe(true);
    expect(ok(matchContextFor(SWITCH, 'config-if', { iface: 'Vlan1' }), 'ip access-group 10 in').ok).toBe(true);
    expect(ok(matchContextFor(PC, 'user-exec'), 'show access-lists').ok).toBe(false);
  });

  it('enters config-ext-nacl, which is no longer reserved (§9.2 W2 item 22)', () => {
    expect(modesOfClass('config')).toContain('config-ext-nacl');
    expect(modeForContext(NAMED)).toBe('config-ext-nacl');
  });
});

describe('numbered entries', () => {
  it('store the canonical text: ports, protocols and ICMP messages by name, hosts as host <a>', () => {
    const r = router();
    expect(typed(r, 'config', 'access-list 100 deny tcp host 192.168.10.10 host 192.168.20.100 eq 80 log')).toEqual({});
    expect(typed(r, 'config', 'access-list 100 permit icmp 192.168.10.0 0.0.0.255 any 0')).toEqual({});
    expect(typed(r, 'config', 'access-list 100 permit udp any 10.0.0.0 0.0.0.255 eq 53')).toEqual({});
    expect(typed(r, 'config', 'access-list 100 permit ip any any')).toEqual({});
    expect(typed(r, 'config', 'access-list 10 permit 192.168.10.7 0.0.0.0 log')).toEqual({});
    const text = r.running.render();
    expect(text).toContain('access-list 100 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log\n');
    expect(text).toContain('access-list 100 permit icmp 192.168.10.0 0.0.0.255 any echo-reply\n');
    expect(text).toContain('access-list 100 permit udp any 10.0.0.0 0.0.0.255 eq domain\n');
    expect(text).toContain('access-list 100 permit ip any any\n');
    expect(text).toContain('access-list 10 permit 192.168.10.7 log\n');
    expect(readAcls(r.running).get('100')?.entries.map((e) => e.seq)).toEqual([10, 20, 30, 40]);
    // the no form of one entry removes it
    expect(typed(r, 'config', 'no access-list 100 permit udp any 10.0.0.0 0.0.0.255 eq 53')).toEqual({});
    expect(r.running.render()).not.toContain('eq domain');
  });

  it('refuse a form of the other list type and numbers outside the ranges', () => {
    const r = router();
    expect(typed(r, 'config', 'access-list 10 permit tcp any any')).toEqual({ error: MSG_ACL_TYPE_MISMATCH('10', 'standard') });
    expect(typed(r, 'config', 'access-list 100 permit any log')).toEqual({ error: MSG_ACL_TYPE_MISMATCH('100', 'extended') });
    expect(run(r, HANDLERS.configAccessListEntry, { number: '200', action: 'permit', type: 'extended', protocol: 'ip', srcForm: 'any', dstForm: 'any' })).toEqual({ error: CLI_MESSAGES.aclNumberRange });
    expect(r.running.render()).not.toContain('access-list');
  });

  it('remarks are stored with the list and never shown as entries', () => {
    const r = router();
    typed(r, 'config', 'access-list 100 remark keep the web server private');
    typed(r, 'config', 'access-list 100 permit ip any any');
    expect(r.running.render()).toContain('access-list 100 remark keep the web server private\naccess-list 100 permit ip any any\n');
    expect(readAcls(r.running).get('100')?.remarks).toEqual([{ before: 0, text: 'keep the web server private' }]);
    // a remark keeps its place by a sequence number of its own (the sequenced rule numbers it like an entry)
    expect(run(r, HANDLERS.showAccessLists).output).toBe('Extended access list 100\n    20 permit ip any any');
    // a protocol given by number is stored by its name
    typed(r, 'config', 'access-list 100 permit 1 any any');
    expect(r.running.render()).toContain('access-list 100 permit icmp any any\n');
  });

  it('typedEntryTokens rebuilds the typed entry from the generated spec args', () => {
    expect(typedEntryTokens({ action: 'deny', type: 'extended', proto: 'tcp', srcForm: 'net', src: '10.0.0.0', srcWild: '0.0.0.255', sportForm: 'range', sport: '1', sportHigh: '9', dstForm: 'any', established: 'established', log: 'log' }))
      .toEqual(['deny', 'tcp', '10.0.0.0', '0.0.0.255', 'range', '1', '9', 'any', 'established', 'log']);
    expect(typedEntryTokens({ action: 'permit', type: 'standard', srcForm: 'host', src: '10.0.0.1' })).toEqual(['permit', 'host', '10.0.0.1']);
    expect(typedEntryTokens({ type: 'standard' })).toBeUndefined();
  });
});

describe('list sections: sequence editing', () => {
  function named(): { r: RecordingCtx; inList: RecordingCtx } {
    const r = router();
    expect(run(r, HANDLERS.configIpAccessListExtended, { name: 'NO-WEB' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: 'config-ext-nacl', opts: { context: NAMED } }]);
    return { r, inList: router({ context: NAMED, running: r.running }) };
  }

  it('numbers entries 10, 20, … and places a numbered entry by its number', () => {
    const { r, inList } = named();
    expect(typed(inList, 'config-ext-nacl', 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log')).toEqual({});
    expect(typed(inList, 'config-ext-nacl', 'permit ip any any')).toEqual({});
    expect(typed(inList, 'config-ext-nacl', '15 permit icmp 192.168.10.0 0.0.0.255 any')).toEqual({});
    expect(readAcls(r.running).get('NO-WEB')?.entries.map((e) => `${e.seq} ${e.text}`)).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '15 permit icmp 192.168.10.0 0.0.0.255 any',
      '20 permit ip any any',
    ]);
    // the running configuration shows the entries without their numbers, in sequence order
    const text = r.running.render();
    expect(text).toContain('ip access-list extended NO-WEB\n deny tcp host 192.168.10.10 host 192.168.20.100 eq www log\n permit icmp 192.168.10.0 0.0.0.255 any\n permit ip any any\n');
    expect(run(r, HANDLERS.showAccessLists).output!.split('\n')).toEqual([
      'Extended access list NO-WEB',
      '    10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '    15 permit icmp 192.168.10.0 0.0.0.255 any',
      '    20 permit ip any any',
    ]);
  });

  it('refuses a taken number, removes an entry by number, and refuses a number alone', () => {
    const { r, inList } = named();
    typed(inList, 'config-ext-nacl', 'permit tcp any any eq www');
    typed(inList, 'config-ext-nacl', '15 permit udp any any eq domain');
    expect(typed(inList, 'config-ext-nacl', '15 deny ip any any')).toEqual({ error: MSG_ACL_SEQ_TAKEN('15') });
    expect(typed(inList, 'config-ext-nacl', '15')).toEqual({ error: MSG_ACL_SEQ_ALONE });
    expect(typed(inList, 'config-ext-nacl', 'no 15')).toEqual({});
    expect(readAcls(r.running).get('NO-WEB')?.entries.map((e) => e.seq)).toEqual([10]);
    expect(typed(inList, 'config-ext-nacl', 'no 30')).toEqual({ error: MSG_ACL_NO_SEQ('30') });
    // the no form of a whole entry removes it too
    expect(typed(inList, 'config-ext-nacl', 'no permit tcp any any eq 80')).toEqual({});
    expect(readAcls(r.running).get('NO-WEB')?.entries).toEqual([]);
  });

  it('a standard section takes numbered entries and log; a standard form in an extended section is refused', () => {
    const r = router();
    run(r, HANDLERS.configIpAccessListStandard, { name: 'VTY' });
    const std = router({ context: [['ip', 'access-list', 'standard', 'VTY']], running: r.running });
    expect(typed(std, 'config-std-nacl', 'permit host 192.168.10.10 log')).toEqual({});
    expect(typed(std, 'config-std-nacl', '5 deny 192.168.10.0 0.0.0.255')).toEqual({});
    expect(readAcls(r.running).get('VTY')?.entries.map((e) => `${e.seq} ${e.text}`)).toEqual(['5 deny 192.168.10.0 0.0.0.255', '10 permit 192.168.10.10 log']);
    const { inList } = named();
    expect(run(inList, HANDLERS.naclEntryP3, { action: 'permit', type: 'standard', srcForm: 'any' })).toEqual({ error: MSG_ACL_TYPE_MISMATCH('NO-WEB', 'extended') });
    expect(run(router(), HANDLERS.naclEntryP3, { action: 'permit', type: 'standard', srcForm: 'any' })).toEqual({ error: MSG_NO_LIST_SECTION });
  });

  it('a name keeps its type: the other section type is refused', () => {
    const { r } = named();
    expect(run(r, HANDLERS.configIpAccessListStandard, { name: 'NO-WEB' })).toEqual({ error: MSG_ACL_OTHER_TYPE('NO-WEB', 'extended') });
    const s = router();
    run(s, HANDLERS.configIpAccessListStandard, { name: 'VTY' });
    expect(run(s, HANDLERS.configIpAccessListExtended, { name: 'VTY' })).toEqual({ error: MSG_ACL_OTHER_TYPE('VTY', 'standard') });
    expect(run(s, HANDLERS.configIpAccessListExtended, { name: '10' })).toEqual({ error: CLI_MESSAGES.aclNumberRange });
  });

  it('a numbered extended section joins the global lines of its number; no removes both', () => {
    const r = router();
    typed(r, 'config', 'access-list 101 permit tcp any any eq www');
    expect(run(r, HANDLERS.configIpAccessListExtended, { name: '101' })).toEqual({});
    const inList = router({ context: [['ip', 'access-list', 'extended', '101']], running: r.running });
    typed(inList, 'config-ext-nacl', '5 deny ip host 10.0.0.66 any');
    expect(readAcls(r.running).get('101')?.entries.map((e) => `${e.seq} ${e.text}`)).toEqual(['5 deny ip host 10.0.0.66 any', '10 permit tcp any any eq www']);
    expect(run(r, HANDLERS.configIpAccessListExtended, { name: '101' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('101');
  });

  it('ip access-list resequence renumbers in order; global lines move into the section', () => {
    const { r, inList } = named();
    typed(inList, 'config-ext-nacl', 'permit tcp any any eq www');
    typed(inList, 'config-ext-nacl', '15 permit udp any any eq domain');
    typed(inList, 'config-ext-nacl', 'permit ip any any');
    expect(run(r, HANDLERS.configIpAccessListResequence, { list: 'NO-WEB', start: '100', step: '5' })).toEqual({});
    expect(readAcls(r.running).get('NO-WEB')?.entries.map((e) => `${e.seq} ${e.text}`)).toEqual([
      '100 permit tcp any any eq www',
      '105 permit udp any any eq domain',
      '110 permit ip any any',
    ]);
    const g = router();
    typed(g, 'config', 'access-list 10 permit host 10.0.0.1');
    typed(g, 'config', 'access-list 10 deny any');
    expect(run(g, HANDLERS.configIpAccessListResequence, { list: '10', start: '1', step: '1' })).toEqual({});
    expect(g.running.render()).not.toContain('access-list 10 ');
    expect(g.running.render()).toContain('ip access-list standard 10\n permit 10.0.0.1\n deny any\n');
    expect(readAcls(g.running).get('10')?.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(run(g, HANDLERS.configIpAccessListResequence, { list: 'NOPE', start: '1', step: '1' })).toEqual({ error: MSG_ACL_UNKNOWN('NOPE') });
  });
});

describe('ip access-group', () => {
  it('keeps one list per direction (D12) and notes an undefined list', () => {
    const r = router({ iface: GI0 });
    typed(r, 'config', 'access-list 10 permit any');
    expect(run(r, HANDLERS.ifIpAccessGroup, { list: '10', direction: 'in' })).toEqual({});
    expect(run(r, HANDLERS.ifIpAccessGroup, { list: 'NO-WEB', direction: 'out' })).toEqual({ output: CLI_MESSAGES.aclUndefinedApplied.replace('{list}', 'NO-WEB') });
    expect(run(r, HANDLERS.ifIpAccessGroup, { list: '0010', direction: 'in' })).toEqual({});
    const section = (): string => r.running.render().split(`interface ${GI0}\n`)[1]!.split('!')[0]!;
    expect(section()).toContain(' ip access-group 10 in\n');
    expect(section()).toContain(' ip access-group NO-WEB out\n');
    // the same direction replaces the list
    typed(r, 'config', 'access-list 20 permit any');
    expect(run(r, HANDLERS.ifIpAccessGroup, { list: '20', direction: 'in' })).toEqual({});
    expect(section()).not.toContain('access-group 10 in');
    expect(section()).toContain(' ip access-group 20 in\n');
    expect(section()).toContain(' ip access-group NO-WEB out\n');
    // no ip access-group in removes only that direction
    expect(run(r, HANDLERS.ifIpAccessGroup, { direction: 'in' }, true)).toEqual({});
    expect(section()).not.toContain('access-group 20');
    expect(section()).toContain(' ip access-group NO-WEB out\n');
    expect(run(r, HANDLERS.ifIpAccessGroup, { list: '99', direction: 'out' }, true)).toEqual({});
    expect(section()).toContain('NO-WEB out');
    expect(run(r, HANDLERS.ifIpAccessGroup, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('access-group');
  });

  it('is refused on a switched port (accessGroupSwitchport); a switch filters on its VLAN interface', () => {
    const sw = commandCtxFor(SWITCH, { iface: 'FastEthernet0/1' });
    expect(run(sw, HANDLERS.ifIpAccessGroup, { list: '10', direction: 'in' })).toEqual({ error: CLI_MESSAGES.accessGroupSwitchport.replace('{port}', 'FastEthernet0/1') });
    const svi = commandCtxFor(SWITCH, { iface: 'Vlan1' });
    svi.running.set([], ['access-list', '10', 'permit', 'any']);
    expect(run(svi, HANDLERS.ifIpAccessGroup, { list: '10', direction: 'in' })).toEqual({});
    expect(svi.running.render()).toContain('interface Vlan1\n ip access-group 10 in\n');
  });
});

describe('clear access-list counters', () => {
  it('sends acl.clear for every list or one; an unknown list is refused', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.running.set([], ['access-list', '10', 'permit', 'any']);
    expect(run(r, HANDLERS.execClearAccessListCounters)).toEqual({});
    expect(run(r, HANDLERS.execClearAccessListCounters, { list: '010' })).toEqual({});
    expect(run(r, HANDLERS.execClearAccessListCounters, { list: 'NOPE' })).toEqual({ error: MSG_ACL_UNKNOWN('NOPE') });
    expect(r.requests).toEqual([
      { to: 'acl', req: { kind: 'acl.clear' } },
      { to: 'acl', req: { kind: 'acl.clear', list: '10' } },
    ]);
  });
});

describe('show access-lists', () => {
  function lists(): RecordingCtx {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    for (const l of ['permit 192.168.10.0 0.0.0.255', 'deny any']) r.running.set([], ['access-list', '10', ...l.split(' ')]);
    r.running.set([], ['ip', 'access-list', 'extended', 'NO-WEB']);
    for (const l of ['deny tcp host 192.168.10.10 host 192.168.20.100 eq www log', 'permit icmp 192.168.10.0 0.0.0.255 any', 'permit ip any any']) {
      r.running.set(NAMED, l.split(' '));
    }
    return r;
  }

  function row(list: string, seq: number | null, entry: string, matches: number): AclRow {
    return {
      key: aclKey(4, list, seq ?? 'implicit'), updatedAt: 0, family: 4, list, type: list === '10' ? 'standard' : 'extended', seq,
      ...(seq === null ? { implicit: 'deny' as const } : {}), entry, action: entry.startsWith('permit') ? 'permit' : 'deny', matches, applied: `${GI0} in`,
    };
  }

  it('prints each list in sequence order with the match counts of the acl rows, never the implicit deny (§5.8)', () => {
    const r = lists();
    const acl = attachAcl(r);
    acl.set(row('10', 10, 'permit 192.168.10.0 0.0.0.255', 12));
    acl.set(row('10', null, 'deny any', 3));
    acl.set(row('NO-WEB', 10, 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log', 4));
    acl.set(row('NO-WEB', 20, 'permit icmp 192.168.10.0 0.0.0.255 any', 1));
    acl.set(row('NO-WEB', 30, 'permit ip any any', 9));
    expect(run(r, HANDLERS.showAccessLists).output!.split('\n')).toEqual([
      'Standard access list 10',
      '    10 permit 192.168.10.0 0.0.0.255 (12 matches)',
      '    20 deny any',
      'Extended access list NO-WEB',
      '    10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log (4 matches)',
      '    20 permit icmp 192.168.10.0 0.0.0.255 any (1 match)',
      '    30 permit ip any any (9 matches)',
    ]);
    expect(run(r, HANDLERS.showAccessLists, { list: 'NO-WEB' }).output!.split('\n')[0]).toBe('Extended access list NO-WEB');
    expect(run(r, HANDLERS.showAccessLists, { list: '010' }).output!.split('\n')[0]).toBe('Standard access list 10');
    expect(run(r, HANDLERS.showAccessLists, { list: 'X' })).toEqual({ output: MSG_ACL_NOT_CONFIGURED('X') });
  });

  it('a standard list without matches prints exactly P2\'s block', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    for (const l of ['permit 192.168.10.0 0.0.0.255', 'permit 10.0.0.1', 'deny any']) r.running.set([], ['access-list', '1', ...l.split(' ')]);
    const p2 = [...readStandardAcls(r.running).values()].map(renderAcl).join('\n');
    expect(run(r, HANDLERS.showAccessLists).output).toBe(p2);
  });
});

/** A recording context whose `CommandCtx.profile` is `profile` (the runtime fills it from the device; W2 fix). */
function withProfile(rec: RecordingCtx, profile: DefaultsProfile): RecordingCtx {
  return { ...rec, ctx: { ...rec.ctx, profile } };
}

describe('show ip interface', () => {
  it('prints the address, helpers, both access lists and the NAT side of each L3 interface (§5.8)', () => {
    const r = withProfile(commandCtxFor(ROUTER, { mode: 'priv-exec' }), 'P2');
    const gi = r.ports.get(GI0)!;
    r.ports.set(GI0, { ...gi, adminUp: true, operUp: true, mtu: 1500, l3: { ...gi.l3, ipv4: { address: '192.168.10.1', prefixLen: 24 } } } as typeof gi);
    r.running.set([['interface', GI0]], ['ip', 'access-group', 'NO-WEB', 'in']);
    r.running.set([['interface', GI0]], ['ip', 'helper-address', '10.0.0.5']);
    r.running.set([['interface', GI0]], ['ip', 'nat', 'inside']);
    expect(run(r, HANDLERS.showIpInterface, { iface: GI0 }).output!.split('\n')).toEqual([
      `${GI0} is up, line protocol is up`,
      '  Address 192.168.10.1/24, MTU 1500 bytes',
      '  Helper addresses: 10.0.0.5',
      '  Inbound access list: NO-WEB',
      '  Outbound access list: not set',
      '  Unreachables: sent    Proxy ARP: on    NAT: inside interface',
    ]);
    const all = run(r, HANDLERS.showIpInterface).output!;
    expect(all).toContain(`${GI0} is up, line protocol is up`);
    expect(all).toContain('GigabitEthernet0/1 is ');
    expect(run(r, HANDLERS.showIpInterface, { iface: 'Nope9' }).error).toBeDefined();
    r.running.set([['interface', GI0]], ['no', 'ip', 'proxy-arp']);
    expect(run(r, HANDLERS.showIpInterface, { iface: GI0 }).output).toContain('Proxy ARP: off');
  });

  it('reports proxy ARP as the arp daemon decides it: off in a P1 world, on in P2 and P3 (W2 fix, finding 8)', () => {
    const line = (profile: DefaultsProfile | undefined): string => {
      const base = commandCtxFor(ROUTER, { mode: 'priv-exec' });
      const r = profile === undefined ? base : withProfile(base, profile);
      return run(r, HANDLERS.showIpInterface, { iface: GI0 }).output!.split('\n').find((l) => l.includes('Proxy ARP'))!;
    };
    expect(line('P1')).toBe('  Unreachables: sent    Proxy ARP: off    NAT: not a NAT interface');
    expect(line('P2')).toBe('  Unreachables: sent    Proxy ARP: on    NAT: not a NAT interface');
    expect(line('P3')).toBe('  Unreachables: sent    Proxy ARP: on    NAT: not a NAT interface');
    // a hand-built context without a profile reads as the Simulation's default, P1
    expect(line(undefined)).toBe('  Unreachables: sent    Proxy ARP: off    NAT: not a NAT interface');
    // the real runtime fills the profile from the device: a P1 world's router says off
    const sim = createStagedSimulation({ seed: 7, stage: 'P2', profile: 'P1' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(r1, 'console');
    for (const l of ['enable', 'configure terminal', `interface ${GI0}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) sim.cli.exec(s, l);
    expect(sim.cli.exec(s, `show ip interface ${GI0}`).output).toContain('Proxy ARP: off');
  });
});

describe('a console session on a P3-stage switch (D14)', () => {
  it('stores a vty list, shows it, and puts an extended list on the VLAN interface', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const sw = sim.addDevice({ type: 'switch.nfc2960', name: 'SW1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(sw, 'console');
    for (const line of [
      'enable',
      'configure terminal',
      'access-list 10 permit host 192.168.10.10',
      'line vty 0 4',
      'access-class 10 in',
      'exit',
      'ip access-list extended MGMT',
      'permit tcp 192.168.10.0 0.0.0.255 any eq 22',
      'exit',
      'interface vlan 1',
      'ip access-group MGMT in',
      'end',
    ]) {
      expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    }
    const text = sim.cli.exec(s, 'show running-config').output;
    expect(text).toContain('access-list 10 permit 192.168.10.10\n');
    expect(text).toContain('ip access-list extended MGMT\n permit tcp 192.168.10.0 0.0.0.255 any eq 22\n');
    expect(text).toContain(' access-class 10 in\n');
    expect(text).toContain('interface Vlan1\n');
    expect(text).toContain(' ip access-group MGMT in\n');
    expect(sim.cli.exec(s, 'show access-lists').output.split('\n')).toEqual([
      'Standard access list 10',
      '    10 permit 192.168.10.10',
      'Extended access list MGMT',
      '    10 permit tcp 192.168.10.0 0.0.0.255 any eq 22',
    ]);
    const refused = sim.cli.exec(s, 'configure terminal');
    expect(refused.error).toBeUndefined();
    sim.cli.exec(s, 'interface fa0/1');
    expect(sim.cli.exec(s, 'ip access-group 10 in').output).toContain(CLI_MESSAGES.accessGroupSwitchport.replace('{port}', 'FastEthernet0/1'));
  });
});
