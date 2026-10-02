/**
 * cli/grammar/qos.ts and cli/handlers/qos.ts, the marking half (ARCHITECTURE-P3 §5.4, §5.8, D16, M13; §7 W2 cli part
 * 1): `class-map [match-all|match-any]` with every `match` form, `policy-map` / `class` / `set`, `service-policy` (one
 * per direction; refused on SVIs and switched ports with `qosPortUnsupported`; a policy that does not exist), `show
 * class-map`, `show policy-map [interface]` against a fake `qosCounters`, the modes entered (no longer reserved, §9.2
 * W2 item 22) and one console session on a real P3-stage router. The host-shell `flow` job is cli.flow.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortSnapshot } from '../src/contracts/snapshot.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  dscpDisplay,
  dscpValue,
  MSG_CLASS_MAP_TYPE,
  MSG_NO_CLASS_MAP,
  MSG_NO_CLASS_MAP_SELECTED,
  MSG_NO_POLICY_MAP,
  MSG_NO_POLICY_CLASS_SELECTED,
  MSG_NO_SERVICE_POLICY,
  MSG_POLICY_MISSING,
  precedenceDisplay,
} from '../src/cli/handlers/qos.js';
import { modeForContext, modesOfClass } from '../src/cli/modes.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const MLS = catalogModel('mlswitch.nfc3650-24');
const SWITCH = catalogModel('switch.nfc2960');
const GI0 = 'GigabitEthernet0/0';

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);

function router(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(ROUTER, { mode: 'config', ...opts });
}

/** The lines of the running configuration from `head` to the next line that does not start with a space. */
function block(rec: RecordingCtx, head: string): string[] {
  const text = rec.running.render().split('\n');
  const at = text.indexOf(head);
  if (at === -1) return [];
  const out = [head];
  for (let i = at + 1; i < text.length && (text[i] as string).startsWith(' '); i++) out.push(text[i] as string);
  return out;
}

describe('parsing and scope', () => {
  it('parses the class-map, policy-map and service-policy lines on a router', () => {
    const cfg = matchContextFor(ROUTER, 'config');
    expect(ok(cfg, 'class-map VOICE')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configClassMap, entersMode: 'config-cmap' }, args: { name: 'VOICE' } });
    expect(ok(cfg, 'class-map match-any VOICE')).toMatchObject({ ok: true, args: { name: 'VOICE', form: 'match-any' } });
    expect(ok(cfg, 'class-map match-all VOICE')).toMatchObject({ ok: true, args: { form: 'match-all' } });
    expect(ok(cfg, 'policy-map MARK')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configPolicyMap, entersMode: 'config-pmap' } });
    const cmap = matchContextFor(ROUTER, 'config-cmap');
    expect(ok(cmap, 'match dscp ef af41 46')).toMatchObject({ ok: true, spec: { handler: HANDLERS.cmapMatch }, args: { form: 'dscp', v1: 'ef', v2: 'af41', v3: '46' } });
    expect(ok(cmap, 'match dscp 64')).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(ok(cmap, 'match ip precedence critical 3')).toMatchObject({ ok: true, args: { form: 'precedence', v1: 'critical', v2: '3' } });
    expect(ok(cmap, 'match cos 5')).toMatchObject({ ok: true, args: { form: 'cos', v1: '5' } });
    expect(ok(cmap, 'match access-group 101')).toMatchObject({ ok: true, args: { form: 'access-group', number: '101' } });
    expect(ok(cmap, 'match access-group name VOICE-ACL')).toMatchObject({ ok: true, args: { form: 'access-group-name', list: 'VOICE-ACL' } });
    expect(ok(cmap, 'match protocol udp')).toMatchObject({ ok: true, args: { form: 'protocol', protocol: 'udp' } });
    expect(ok(cmap, 'match input-interface g0/1')).toMatchObject({ ok: true, args: { form: 'input-interface', iface: 'GigabitEthernet0/1' } });
    expect(ok(cmap, 'match any')).toMatchObject({ ok: true, args: { form: 'any' } });
    const pmap = matchContextFor(ROUTER, 'config-pmap');
    expect(ok(pmap, 'class VOICE')).toMatchObject({ ok: true, spec: { handler: HANDLERS.pmapClass, entersMode: 'config-pmap-c' } });
    expect(ok(pmap, 'class class-default')).toMatchObject({ ok: true, args: { name: 'class-default' } });
    const pmapc = matchContextFor(ROUTER, 'config-pmap-c');
    expect(ok(pmapc, 'set dscp ef')).toMatchObject({ ok: true, spec: { handler: HANDLERS.pmapcSet }, args: { form: 'dscp', value: 'ef' } });
    expect(ok(pmapc, 'set ip precedence 5')).toMatchObject({ ok: true, args: { form: 'precedence', value: '5' } });
    expect(ok(pmapc, 'set cos 3')).toMatchObject({ ok: true, args: { form: 'cos', value: '3' } });
    expect(ok(pmapc, 'no set dscp')).toMatchObject({ ok: true, negated: true });
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(ok(ifc, 'service-policy input MARK')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifServicePolicy }, args: { direction: 'input', name: 'MARK' } });
    expect(ok(ifc, 'service-policy output MARK')).toMatchObject({ ok: true, args: { direction: 'output' } });
    expect(ok(ifc, 'no service-policy output')).toMatchObject({ ok: true, negated: true });
    const exec = matchContextFor(ROUTER, 'user-exec');
    expect(ok(exec, 'show class-map')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showClassMap } });
    expect(ok(exec, 'show class-map VOICE')).toMatchObject({ ok: true, args: { name: 'VOICE' } });
    expect(ok(exec, 'show policy-map')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showPolicyMap } });
    expect(ok(exec, 'show policy-map interface g0/0')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showPolicyMapInterface }, args: { iface: GI0 } });
    expect(ok(exec, 'show policy-map interface g0/0 output')).toMatchObject({ ok: true, args: { direction: 'output' } });
  });

  it('offers no marking line on a managed L2 switch (D16)', () => {
    expect(ok(matchContextFor(SWITCH, 'config'), 'class-map VOICE').ok).toBe(false);
    expect(ok(matchContextFor(SWITCH, 'config'), 'policy-map MARK').ok).toBe(false);
    expect(ok(matchContextFor(MLS, 'config'), 'class-map VOICE').ok).toBe(true);
  });

  it('enters config-cmap, config-pmap and config-pmap-c, which are no longer reserved (§9.2 W2 item 22)', () => {
    const config = modesOfClass('config');
    for (const m of ['config-cmap', 'config-pmap', 'config-pmap-c']) expect(config).toContain(m);
    expect(modeForContext([['class-map', 'match-all', 'VOICE']])).toBe('config-cmap');
    expect(modeForContext([['policy-map', 'MARK']])).toBe('config-pmap');
    expect(modeForContext([['policy-map', 'MARK'], ['class', 'VOICE']])).toBe('config-pmap-c');
  });
});

describe('value forms', () => {
  it('shows DSCP by its standard name and precedence by number', () => {
    expect(dscpDisplay('46')).toBe('ef');
    expect(dscpDisplay('ef')).toBe('ef');
    expect(dscpDisplay('cs0')).toBe('default');
    expect(dscpDisplay('0')).toBe('default');
    expect(dscpDisplay('47')).toBe('47');
    expect(dscpValue('af41')).toBe(34);
    expect(dscpValue('63')).toBe(63);
    expect(dscpValue('64')).toBeUndefined();
    expect(precedenceDisplay('critical')).toBe('5');
    expect(precedenceDisplay('03')).toBe('3');
  });
});

describe('class-map', () => {
  it('stores its type (match-all when omitted) and enters config-cmap', () => {
    const r = router();
    expect(run(r, HANDLERS.configClassMap, { name: 'VOICE' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: 'config-cmap', opts: { context: [['class-map', 'match-all', 'VOICE']] } }]);
    expect(r.running.render()).toContain('\nclass-map match-all VOICE\n');
    // re-entering without a type keeps it; with the other type is refused
    expect(run(r, HANDLERS.configClassMap, { name: 'VOICE' })).toEqual({});
    expect(run(r, HANDLERS.configClassMap, { name: 'VOICE', form: 'match-any' })).toEqual({ error: MSG_CLASS_MAP_TYPE('VOICE', 'match-all') });
  });

  it('keeps several class-maps of the same type, each with its own match lines', () => {
    const r = router();
    run(r, HANDLERS.configClassMap, { name: 'VOICE', form: 'match-any' });
    run(r, HANDLERS.configClassMap, { name: 'VIDEO', form: 'match-any' });
    run(r, HANDLERS.configClassMap, { name: 'WEB' });
    run(r, HANDLERS.configClassMap, { name: 'MAIL' });
    const text = r.running.render();
    for (const head of ['class-map match-any VOICE', 'class-map match-any VIDEO', 'class-map match-all WEB', 'class-map match-all MAIL']) {
      expect(text, head).toContain(`${head}\n`);
    }
    const voice = router({ context: [['class-map', 'match-any', 'VOICE']], running: r.running });
    const web = router({ context: [['class-map', 'match-all', 'WEB']], running: r.running });
    expect(run(voice, HANDLERS.cmapMatch, { form: 'dscp', v1: '46' })).toEqual({});
    expect(run(web, HANDLERS.cmapMatch, { form: 'protocol', protocol: 'tcp' })).toEqual({});
    expect(block(r, 'class-map match-any VOICE')).toEqual(['class-map match-any VOICE', ' match dscp ef']);
    expect(block(r, 'class-map match-all WEB')).toEqual(['class-map match-all WEB', ' match protocol tcp']);
    expect(block(r, 'class-map match-any VIDEO')).toEqual(['class-map match-any VIDEO']);
  });

  it('stores every match form in the display form; no match dscp removes every dscp line', () => {
    const r = router();
    run(r, HANDLERS.configClassMap, { name: 'C', form: 'match-any' });
    const c = router({ context: [['class-map', 'match-any', 'C']], running: r.running });
    expect(run(c, HANDLERS.cmapMatch, { form: 'dscp', v1: '46', v2: 'af41', v3: 'ef' })).toEqual({});
    run(c, HANDLERS.cmapMatch, { form: 'dscp', v1: '10' });
    run(c, HANDLERS.cmapMatch, { form: 'precedence', v1: 'critical', v2: '3' });
    run(c, HANDLERS.cmapMatch, { form: 'cos', v1: '5' });
    run(c, HANDLERS.cmapMatch, { form: 'access-group', number: '0101' });
    run(c, HANDLERS.cmapMatch, { form: 'access-group-name', list: 'VOICE-ACL' });
    run(c, HANDLERS.cmapMatch, { form: 'protocol', protocol: 'udp' });
    run(c, HANDLERS.cmapMatch, { form: 'input-interface', iface: GI0 });
    run(c, HANDLERS.cmapMatch, { form: 'any' });
    expect(block(r, 'class-map match-any C')).toEqual([
      'class-map match-any C',
      ' match dscp ef af41',
      ' match dscp af11',
      ' match ip precedence 5 3',
      ' match cos 5',
      ' match access-group 101',
      ' match access-group name VOICE-ACL',
      ' match protocol udp',
      ` match input-interface ${GI0}`,
      ' match any',
    ]);
    expect(run(c, HANDLERS.cmapMatch, { form: 'dscp' }, true)).toEqual({});
    expect(block(r, 'class-map match-any C').filter((l) => l.includes('dscp'))).toEqual([]);
    expect(run(c, HANDLERS.cmapMatch, { form: 'protocol', protocol: 'udp' }, true)).toEqual({});
    expect(block(r, 'class-map match-any C')).not.toContain(' match protocol udp');
    expect(run(c, HANDLERS.cmapMatch, { form: 'dscp' })).toEqual({ error: '% Give at least one value.' });
  });

  it('no class-map removes it whatever its type; a match line outside a class-map is refused', () => {
    const r = router();
    run(r, HANDLERS.configClassMap, { name: 'VOICE', form: 'match-any' });
    expect(run(r, HANDLERS.configClassMap, { name: 'VOICE' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('class-map');
    expect(run(r, HANDLERS.configClassMap, { name: 'NONE' }, true)).toEqual({});
    expect(run(router(), HANDLERS.cmapMatch, { form: 'any' })).toEqual({ error: MSG_NO_CLASS_MAP_SELECTED });
  });
});

describe('policy-map, class and set', () => {
  function policy(): { r: RecordingCtx; inPolicy: RecordingCtx } {
    const r = router();
    run(r, HANDLERS.configClassMap, { name: 'VOICE', form: 'match-any' });
    expect(run(r, HANDLERS.configPolicyMap, { name: 'MARK' })).toEqual({});
    return { r, inPolicy: router({ context: [['policy-map', 'MARK']], running: r.running }) };
  }

  it('enters the modes; class needs an existing class-map except class-default', () => {
    const { r, inPolicy } = policy();
    expect(r.enterModeCalls.at(-1)).toEqual({ mode: 'config-pmap', opts: { context: [['policy-map', 'MARK']] } });
    expect(run(inPolicy, HANDLERS.pmapClass, { name: 'NOPE' })).toEqual({ error: CLI_MESSAGES.qosClassMissing.replace('{name}', 'NOPE') });
    expect(run(inPolicy, HANDLERS.pmapClass, { name: 'VOICE' })).toEqual({});
    expect(inPolicy.enterModeCalls).toEqual([{ mode: 'config-pmap-c', opts: { context: [['policy-map', 'MARK'], ['class', 'VOICE']] } }]);
    expect(run(inPolicy, HANDLERS.pmapClass, { name: 'class-default' })).toEqual({});
    expect(run(router(), HANDLERS.pmapClass, { name: 'VOICE' })).toEqual({ error: '% Select a policy-map first (policy-map <name>).' });
  });

  it('set stores one value per field in the display form; the no form clears it', () => {
    const { r, inPolicy } = policy();
    run(inPolicy, HANDLERS.pmapClass, { name: 'VOICE' });
    run(inPolicy, HANDLERS.pmapClass, { name: 'class-default' });
    const voice = router({ context: [['policy-map', 'MARK'], ['class', 'VOICE']], running: r.running });
    const rest = router({ context: [['policy-map', 'MARK'], ['class', 'class-default']], running: r.running });
    expect(run(voice, HANDLERS.pmapcSet, { form: 'dscp', value: '46' })).toEqual({});
    expect(run(voice, HANDLERS.pmapcSet, { form: 'cos', value: '5' })).toEqual({});
    expect(run(rest, HANDLERS.pmapcSet, { form: 'precedence', value: 'routine' })).toEqual({});
    expect(run(rest, HANDLERS.pmapcSet, { form: 'dscp', value: 'af11' })).toEqual({});
    expect(run(rest, HANDLERS.pmapcSet, { form: 'dscp', value: 'cs0' })).toEqual({});
    expect(block(r, 'policy-map MARK')).toEqual([
      'policy-map MARK',
      ' class VOICE',
      '  set dscp ef',
      '  set cos 5',
      ' class class-default',
      '  set ip precedence 0',
      '  set dscp default',
    ]);
    expect(run(voice, HANDLERS.pmapcSet, { form: 'dscp' }, true)).toEqual({});
    expect(block(r, 'policy-map MARK')).not.toContain('  set dscp ef');
    expect(run(router({ context: [['policy-map', 'MARK']] }), HANDLERS.pmapcSet, { form: 'dscp', value: 'ef' })).toEqual({ error: MSG_NO_POLICY_CLASS_SELECTED });
    // no policy-map removes the whole section
    expect(run(r, HANDLERS.configPolicyMap, { name: 'MARK' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('policy-map');
  });
});

describe('service-policy', () => {
  function withPolicy(model = ROUTER, iface: PortId = GI0): RecordingCtx {
    const base = commandCtxFor(model, { mode: 'config' });
    base.running.set([], ['class-map', 'match-any', 'VOICE']);
    base.running.set([['class-map', 'match-any', 'VOICE']], ['match', 'dscp', 'ef']);
    base.running.set([], ['policy-map', 'MARK']);
    base.running.set([['policy-map', 'MARK']], ['class', 'VOICE']);
    base.running.set([['policy-map', 'MARK'], ['class', 'VOICE']], ['set', 'dscp', 'ef']);
    return commandCtxFor(model, { iface, running: base.running });
  }

  it('attaches one policy per direction on a routed port; the same direction replaces', () => {
    const r = withPolicy();
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'input', name: 'MARK' })).toEqual({});
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'output', name: 'MARK' })).toEqual({});
    expect(block(r, `interface ${GI0}`)).toEqual([`interface ${GI0}`, ' service-policy input MARK', ' service-policy output MARK']);
    r.running.set([], ['policy-map', 'OTHER']);
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'input', name: 'OTHER' })).toEqual({});
    expect(block(r, `interface ${GI0}`)).toEqual([`interface ${GI0}`, ' service-policy input OTHER', ' service-policy output MARK']);
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'output' }, true)).toEqual({});
    expect(block(r, `interface ${GI0}`)).toEqual([`interface ${GI0}`, ' service-policy input OTHER']);
    expect(run(r, HANDLERS.ifServicePolicy, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('service-policy');
  });

  it('refuses a policy-map that does not exist', () => {
    expect(run(withPolicy(), HANDLERS.ifServicePolicy, { direction: 'input', name: 'NOPE' })).toEqual({ error: MSG_POLICY_MISSING('NOPE') });
  });

  it('is refused on SVIs and switched ports with qosPortUnsupported', () => {
    const svi = withPolicy(MLS, 'Vlan1');
    expect(run(svi, HANDLERS.ifServicePolicy, { direction: 'input', name: 'MARK' })).toEqual({ error: CLI_MESSAGES.qosPortUnsupported.replace('{port}', 'Vlan1') });
    const sw = withPolicy(MLS, 'GigabitEthernet1/0/1');
    expect(run(sw, HANDLERS.ifServicePolicy, { direction: 'output', name: 'MARK' })).toEqual({ error: CLI_MESSAGES.qosPortUnsupported.replace('{port}', 'GigabitEthernet1/0/1') });
    expect(sw.running.render()).not.toContain('service-policy');
  });

  it('[S20] a policy with a queueing action attaches only as output', () => {
    const r = withPolicy();
    r.running.set([['policy-map', 'MARK'], ['class', 'VOICE']], ['priority', '1000']);
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'input', name: 'MARK' })).toEqual({ error: CLI_MESSAGES.qosQueueingOutputOnly });
    expect(run(r, HANDLERS.ifServicePolicy, { direction: 'output', name: 'MARK' })).toEqual({});
  });
});

describe('shows', () => {
  function configured(counters?: PortSnapshot['qos']): RecordingCtx {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    r.running.set([], ['class-map', 'match-any', 'VOICE']);
    r.running.set([['class-map', 'match-any', 'VOICE']], ['match', 'dscp', 'ef']);
    r.running.set([['class-map', 'match-any', 'VOICE']], ['match', 'protocol', 'udp']);
    r.running.set([], ['class-map', 'match-all', 'EMPTY']);
    r.running.set([], ['policy-map', 'MARK']);
    r.running.set([['policy-map', 'MARK']], ['class', 'class-default']);
    r.running.set([['policy-map', 'MARK'], ['class', 'class-default']], ['set', 'dscp', 'default']);
    r.running.set([['policy-map', 'MARK']], ['class', 'VOICE']);
    r.running.set([['policy-map', 'MARK'], ['class', 'VOICE']], ['set', 'dscp', 'ef']);
    r.running.set([['interface', GI0]], ['service-policy', 'input', 'MARK']);
    if (counters !== undefined) (r.ctx as { qosCounters?: CommandCtx['qosCounters'] }).qosCounters = (port) => (port === GI0 ? counters : undefined);
    return r;
  }

  it('say so when nothing is configured', () => {
    const r = commandCtxFor(ROUTER, { mode: 'priv-exec' });
    expect(run(r, HANDLERS.showClassMap)).toEqual({ output: MSG_NO_CLASS_MAP });
    expect(run(r, HANDLERS.showPolicyMap)).toEqual({ output: MSG_NO_POLICY_MAP });
    expect(run(r, HANDLERS.showPolicyMapInterface, { iface: GI0 })).toEqual({ output: MSG_NO_SERVICE_POLICY(GI0) });
  });

  it('show class-map [<name>]', () => {
    expect(run(configured(), HANDLERS.showClassMap).output!.split('\n')).toEqual([
      'Class-map VOICE (any one line matches)',
      '  match dscp ef',
      '  match protocol udp',
      'Class-map EMPTY (every line must match)',
      '  (no match line: matches nothing)',
    ]);
    expect(run(configured(), HANDLERS.showClassMap, { name: 'EMPTY' }).output!.split('\n')[0]).toBe('Class-map EMPTY (every line must match)');
    expect(run(configured(), HANDLERS.showClassMap, { name: 'X' })).toEqual({ output: 'No class-map named X is configured.' });
  });

  it('show policy-map: the classes in policy order, class-default last', () => {
    expect(run(configured(), HANDLERS.showPolicyMap).output!.split('\n')).toEqual([
      'Policy-map MARK',
      '  Class VOICE',
      '    set dscp ef',
      '  Class class-default',
      '    set dscp default',
    ]);
  });

  it('show policy-map interface: the matched and marked counts per class (PortSnapshot.qos)', () => {
    const counters = {
      input: 'MARK',
      classes: [
        { name: 'VOICE', matched: 12, matchedBytes: 2400, marked: 12 },
        { name: 'class-default', matched: 1, matchedBytes: 98, marked: 0 },
      ],
    } as unknown as PortSnapshot['qos'];
    expect(run(configured(counters), HANDLERS.showPolicyMapInterface, { iface: GI0 }).output!.split('\n')).toEqual([
      GI0,
      '  Input policy MARK',
      '    Class VOICE: 12 packets (2400 bytes) matched; 12 marked (set dscp ef)',
      '    Class class-default: 1 packet (98 bytes) matched; 0 marked (set dscp default)',
    ]);
    // without counters (a runtime that has none yet) every count reads 0
    expect(run(configured(), HANDLERS.showPolicyMapInterface, { iface: GI0 }).output!.split('\n')[2]).toBe('    Class VOICE: 0 packets (0 bytes) matched; 0 marked (set dscp ef)');
    expect(run(configured(), HANDLERS.showPolicyMapInterface, { iface: GI0, direction: 'output' })).toEqual({ output: MSG_NO_SERVICE_POLICY(GI0) });
  });
});

describe('a console session on a P3-stage router', () => {
  it('enters the three modes, stores the lines and renders them before the interfaces', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(r1, 'console');
    for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(s, line).error).toBeUndefined();
    const steps: [string, string][] = [
      ['class-map match-any VOICE', 'R1(config-cmap)#'],
      ['match dscp 46', 'R1(config-cmap)#'],
      ['policy-map MARK', 'R1(config-pmap)#'],
      ['class VOICE', 'R1(config-pmap-c)#'],
      ['set dscp ef', 'R1(config-pmap-c)#'],
      ['interface g0/0', 'R1(config-if)#'],
      ['service-policy input MARK', 'R1(config-if)#'],
    ];
    for (const [line, prompt] of steps) {
      const res = sim.cli.exec(s, line);
      expect(res.error, line).toBeUndefined();
      expect(res.prompt, line).toBe(prompt);
    }
    sim.cli.exec(s, 'end');
    const text = sim.cli.exec(s, 'show running-config').output;
    expect(text).toContain('class-map match-any VOICE\n match dscp ef\n');
    expect(text).toContain('policy-map MARK\n class VOICE\n  set dscp ef\n');
    expect(text).toContain(`interface ${GI0}\n`);
    expect(text).toContain(' service-policy input MARK\n');
    expect(text.indexOf('policy-map MARK')).toBeLessThan(text.indexOf(`interface ${GI0}`));
    expect(sim.cli.exec(s, 'show policy-map').output).toContain('Policy-map MARK');
  });
});
