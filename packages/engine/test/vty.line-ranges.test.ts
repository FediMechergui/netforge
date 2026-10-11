/**
 * vty.line-ranges — the vty settings resolved per line number (ARCHITECTURE-P3 D14, §3.14, §5.2, [S13]; W5 fix #11).
 *
 * The CLI stores `line vty 0 15` as its own section after a startup `line vty 0 4`; a real router applies the range to
 * lines 0-15 (lines 0-4 too, a later setting replacing an earlier one) and shows `line vty 0 4` plus `line vty 5 15`.
 * Every P3 reader of the vty lines resolves them the same way, through `vtyLineRanges`:
 *   • the server (`readVtyConfig`: the lowest-numbered lines serve a connection);
 *   • `show ip ssh` (one row per range);
 *   • the grader's facts `vty.transport`, `vty.loginLocal` and `vty.accessClass` (the lowest-numbered lines).
 * A single section, or sections that do not overlap, come back exactly as stored (so nothing a P1/P2 world reads moves);
 * negations never count.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { readVtyAccessClasses } from '../src/protocols/acl.js';
import { readVtyConfig, vtyLineRanges } from '../src/protocols/vty.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { catalogModel, commandCtxFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const V04 = ['line', 'vty', '0', '4'];
const V015 = ['line', 'vty', '0', '15'];
const V515 = ['line', 'vty', '5', '15'];

/** A configuration tree with `sections` set in order: each is [header, ...child lines]. */
function tree(sections: readonly (readonly (readonly string[])[])[]) {
  const ast = createConfigAst();
  for (const [header, ...children] of sections) {
    ast.set([], [...header!]);
    for (const c of children) ast.set([header!], [...c]);
  }
  return ast;
}

/** The startup `line vty 0 4` of lab 19 (a line password), then the very common `line vty 0 15` answer. */
const OVERLAP = [
  [V04, ['password', 'letmein'], ['login']],
  [V015, ['login', 'local'], ['transport', 'input', 'ssh'], ['access-class', '10', 'in']],
] as const;

describe('vtyLineRanges / readVtyConfig: the settings of each vty line', () => {
  it("'line vty 0 15' after 'line vty 0 4' configures lines 0-4 too: the server serves line 0 with login local and SSH only", () => {
    const ast = tree(OVERLAP);
    // stored as typed: two sections, the startup one first
    expect(ast.root.children.filter((c) => c.key === 'line').map((c) => c.args.join(' '))).toEqual(['vty 0 4', 'vty 0 15']);
    expect(readVtyConfig(ast.root).lines).toEqual([
      { name: 'vty 0 4', transport: ['ssh'], accessClass: '10', login: 'local', password: 'letmein' },
      { name: 'vty 5 15', transport: ['ssh'], accessClass: '10', login: 'local' },
    ]);
    expect(vtyLineRanges(ast.root)).toEqual([
      { first: 0, last: 4, transport: ['ssh'], accessClass: '10', login: 'local', password: 'letmein' },
      { first: 5, last: 15, transport: ['ssh'], accessClass: '10', login: 'local' },
    ]);
  });

  it('a later section replaces a setting only on the lines it covers; an earlier wider section is overridden in part', () => {
    const ast = tree([
      [V015, ['login', 'local'], ['transport', 'input', 'ssh']],
      [V04, ['transport', 'input', 'telnet']],
    ]);
    expect(readVtyConfig(ast.root).lines.map((l) => [l.name, l.transport, l.login])).toEqual([
      ['vty 0 4', ['telnet'], 'local'],
      ['vty 5 15', ['ssh'], 'local'],
    ]);
  });

  it('a single section, or sections that do not overlap, come back as stored, ascending; negations never count', () => {
    expect(vtyLineRanges(tree([[V04, ['login', 'local']]]).root)).toEqual([{ first: 0, last: 4, login: 'local' }]);
    const two = tree([
      [V515, ['login']],
      [V04, ['transport', 'input', 'ssh']],
    ]);
    expect(readVtyConfig(two.root).lines.map((l) => l.name)).toEqual(['vty 0 4', 'vty 5 15']);
    // two adjacent sections with the same settings stay two rows (each as stored)
    const same = tree([
      [V04, ['login']],
      [V515, ['login']],
    ]);
    expect(vtyLineRanges(same.root).map((r) => [r.first, r.last])).toEqual([[0, 4], [5, 15]]);
    // a single line
    expect(readVtyConfig(tree([[['line', 'vty', '0']]]).root).lines).toEqual([{ name: 'vty 0', transport: ['telnet', 'ssh'], login: 'none' }]);
    // a stored negation under a section (a `no` node) sets nothing
    const neg = tree([[V04]]);
    neg.root.children.find((c) => c.key === 'line')!.children.push({ key: 'no', args: ['login', 'local'], children: [] });
    expect(vtyLineRanges(neg.root)).toEqual([{ first: 0, last: 4 }]);
    expect(vtyLineRanges(createConfigAst().root)).toEqual([]);
  });
});

describe('readVtyAccessClasses: the lists the vty lines really use (W5 integration, the hardening fixer request)', () => {
  it("a list every line of which a later 'line vty 0 15' rebinds is no longer bound; separate sections keep each list", () => {
    // 'line vty 0 15' binds list 20 on lines 0-15: list 10 of 'line vty 0 4' is replaced on all its lines
    expect(readVtyAccessClasses(tree([[V04, ['access-class', '10', 'in']], [V015, ['access-class', '20', 'in']]]))).toEqual(['20']);
    // the overlap of lab 19: one list on both ranges, reported once
    expect(readVtyAccessClasses(tree(OVERLAP))).toEqual(['10']);
    // sections that do not overlap: each keeps its own list (ascending line order); an outbound class is no filter here
    expect(
      readVtyAccessClasses(tree([[V515, ['access-class', 'REMOTE', 'in']], [V04, ['access-class', '10', 'in']], [['line', 'vty', '16'], ['access-class', '30', 'out']]])),
    ).toEqual(['10', 'REMOTE']);
    expect(readVtyAccessClasses(createConfigAst())).toEqual([]);
  });
});

describe('show ip ssh: one row per range of vty lines', () => {
  const run = (rec: RecordingCtx): string[] => {
    const h: CommandHandler | undefined = HANDLER_REGISTRY[HANDLERS.showIpSsh];
    if (h === undefined) throw new Error('no show.ip-ssh handler');
    const o: CommandOutcome = h(rec.ctx, {}, false);
    return (o.output ?? '').split('\n');
  };

  it("prints 'line vty 0 4' plus 'line vty 5 15' for 'line vty 0 15' typed after 'line vty 0 4'", () => {
    const r = commandCtxFor(catalogModel('router.nf2911'), { mode: 'priv-exec', hostname: 'R1' });
    r.running.set([], ['ip', 'domain-name', 'lab.nf']);
    r.running.set([], ['crypto', 'key', 'generate', 'rsa', 'modulus', '1024']);
    for (const [header, ...children] of OVERLAP) {
      r.running.set([], [...header]);
      for (const c of children) r.running.set([header], [...c]);
    }
    expect(run(r).slice(4)).toEqual([
      '  line vty 0 4: accepts ssh; access class 10 in; login local',
      '  line vty 5 15: accepts ssh; access class 10 in; login local',
    ]);
  });
});

describe('the grader facts read the lowest-numbered vty lines as the server serves them', () => {
  let sim: Simulation;
  const detail = (a: LabAssertion): string | undefined => {
    const r = runCheck({ sim, host: undefined }, a);
    return r.pass ? undefined : (r.detail ?? '(no detail)');
  };
  const fact = (device: string, f: LabFactName, equals: string | boolean): LabAssertion => ({ kind: 'fact', device, fact: f, equals });

  beforeAll(() => {
    sim = createStagedSimulation({ seed: 11, stage: 'P3' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const r = sim.configure('r1', [
      'line vty 0 4',
      'password letmein',
      'login',
      'exit',
      'line vty 0 15',
      'login local',
      'transport input ssh',
      'access-class 10 in',
      'exit',
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.lines.filter((l) => !l.ok)));
  });

  it("vty.loginLocal, vty.transport and vty.accessClass count 'line vty 0 15' for line 0", () => {
    expect(detail(fact('R1', 'vty.loginLocal', true))).toBeUndefined();
    expect(detail(fact('R1', 'vty.transport', 'ssh'))).toBeUndefined();
    expect(detail(fact('R1', 'vty.accessClass', '10'))).toBeUndefined();
  });
});
