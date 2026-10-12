/**
 * The `show controllers` forms (ARCHITECTURE-P3 §9.2 ruling R56, W6 cli; cli/grammar/serial.ts): the bare
 * `show controllers` (every serial port) and the slot form `show controllers serial 0/0/0` are accepted next to the
 * accepted form `show controllers serial [<name>]`, and print exactly what the accepted form prints.
 *
 *   • grammar, on real catalog models: both new forms match the `show.controllers` handler with the accepted form's
 *     arguments (none, or the resolved serial port); the accepted form keeps its lines (`show controllers serial` and
 *     `show controllers serial <name>` still match it, its error column is unchanged); a slot that names no port and a
 *     port that is not serial are refused with a caret; filters, user exec and `do` work; the host shell has none of
 *     it; the bare form is listed by `?` (R56: the help golden gains it, §9.2 W6 item 40h) and offers the serial ports
 *     and their slot numbers, while the accepted form's spec stays hidden;
 *   • output, on booted worlds (a P1 serial pair and a P3-profile world, plus the CCNA 3 lab 22 world): every form
 *     prints the accepted form's text byte for byte on the DCE and the DTE end, with and without a filter, and on a
 *     router without serial ports the bare form refuses exactly as the accepted form does.
 */
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS, MSG_NO_LINE_CONTROLLER } from '../src/cli/grammar/index.js';
import { MSG_NO_SERIAL } from '../src/cli/handlers/show.js';
import { help, matchCommand, MSG_UNKNOWN_INTERFACE, type MatchContext } from '../src/cli/parser.js';
import { cable, configText, device, section, topology } from '../src/sim/scenarios/kit.js';
import { ccna3SerialLinks } from '../src/sim/scenarios/ccna3/wan.js';
import { createSimulation } from '../src/sim/simulation.js';
import { catalogModel, matchContextFor } from './cli.p05.fixture.js';

const ACCEPTED_PATH = ['show', 'controllers', 'serial', '<iface>'];
const NEW_PATH = ['show', 'controllers', '<iface>'];

function ok(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (!r.ok) throw new Error(`expected "${line}" to match, got ${r.kind}: ${r.error.message}`);
  return r;
}

function fail(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (r.ok) throw new Error(`expected "${line}" to fail, matched ${r.spec.path.join(' ')}`);
  return r;
}

const tokens = (c: MatchContext, partial: string): string[] => help(GRAMMAR, c, partial).items.map((i) => i.token);

describe('show controllers: the grammar of the three forms (R56)', () => {
  const r2911 = catalogModel('router.nf2911');
  const priv = matchContextFor(r2911, 'priv-exec');
  const user = matchContextFor(r2911, 'user-exec');

  it('the bare form matches the controllers handler with no arguments, as `show controllers serial` does', () => {
    const bare = ok(priv, 'show controllers');
    expect(bare).toMatchObject({ spec: { handler: HANDLERS.showControllers, path: NEW_PATH }, args: {}, negated: false });
    expect(ok(priv, 'sh contr').spec.path).toEqual(NEW_PATH);
    const accepted = ok(priv, 'show controllers serial');
    expect(accepted).toMatchObject({ spec: { handler: HANDLERS.showControllers, path: ACCEPTED_PATH }, args: {} });
    expect(bare.args).toEqual(accepted.args);
  });

  it('the slot form names the serial port, with the arguments the full name gives the accepted form', () => {
    for (const [line, port] of [
      ['show controllers serial 0/0/0', 'Serial0/0/0'],
      ['show controllers Serial 0/0/1', 'Serial0/0/1'],
      ['show controllers SERIAL 0/0/0', 'Serial0/0/0'],
      ['show controllers se 0/0/1', 'Serial0/0/1'],
      ['sh contr ser 0/0/0', 'Serial0/0/0'],
    ] as const) {
      const r = ok(priv, line);
      expect(r.spec.handler, line).toBe(HANDLERS.showControllers);
      expect(r.spec.path, line).toEqual(NEW_PATH);
      expect(r.args, line).toEqual({ iface: port });
      expect(r.args, line).toEqual(ok(priv, `show controllers serial ${port}`).args);
    }
  });

  it('the accepted form keeps its lines and its error column', () => {
    expect(ok(priv, 'show controllers serial se0/0/0')).toMatchObject({ spec: { path: ACCEPTED_PATH }, args: { iface: 'Serial0/0/0' } });
    expect(ok(priv, 'show controllers serial Serial0/0/1')).toMatchObject({ spec: { path: ACCEPTED_PATH }, args: { iface: 'Serial0/0/1' } });
    expect(ok(priv, 'show controllers s')).toMatchObject({ spec: { path: ACCEPTED_PATH }, args: {} });
    expect(fail(priv, 'show controllers serial gi0/0')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_NO_LINE_CONTROLLER, column: 24 } });
  });

  it('a slot that names no port, or a port that is not serial, is refused with a caret', () => {
    // the caret marks the slot number (the furthest token reached: the accepted form judges it as a name)
    expect(fail(priv, 'show controllers serial 0/0/7')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_UNKNOWN_INTERFACE, column: 24 } });
    expect(fail(priv, 'show controllers gigabitethernet 0/0')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_NO_LINE_CONTROLLER, column: 17 } });
    expect(fail(priv, 'show controllers gi0/0')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_NO_LINE_CONTROLLER, column: 17 } });
    expect(fail(priv, 'show controllers serial 0/0/0 extra')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 30 } });
    expect(fail(priv, 'show controllers serial 0/0/0 0/0/1')).toMatchObject({ ok: false, error: { column: 30 } });
  });

  it('takes an output filter, runs from user exec and through do', () => {
    expect(ok(priv, 'show controllers | include Clock')).toMatchObject({ spec: { path: NEW_PATH }, args: {}, filter: { kind: 'include', pattern: 'Clock' } });
    expect(ok(priv, 'show controllers serial 0/0/0 | begin Line')).toMatchObject({
      spec: { path: NEW_PATH },
      args: { iface: 'Serial0/0/0' },
      filter: { kind: 'begin', pattern: 'Line' },
    });
    expect(ok(user, 'show controllers').spec.path).toEqual(NEW_PATH);
    expect(ok(user, 'show controllers serial 0/0/1').args).toEqual({ iface: 'Serial0/0/1' });
    const config = matchContextFor(r2911, 'config');
    expect(ok(config, 'do show controllers')).toMatchObject({ doPrefix: true, spec: { path: NEW_PATH }, args: {} });
    expect(ok(config, 'do show controllers serial 0/0/0')).toMatchObject({ doPrefix: true, args: { iface: 'Serial0/0/0' } });
  });

  it('exists wherever the network OS runs, never in the host shell', () => {
    expect(ok(matchContextFor(catalogModel('router.nf1941'), 'priv-exec'), 'show controllers').spec.path).toEqual(NEW_PATH);
    expect(ok(matchContextFor(catalogModel('switch.nfc2960'), 'priv-exec'), 'show controllers').spec.path).toEqual(NEW_PATH);
    const pc = matchContextFor(catalogModel('pc.nfpc'), 'user-exec');
    expect(fail(pc, 'show controllers').ok).toBe(false);
    expect(fail(pc, 'show controllers serial 0/0/0').ok).toBe(false);
  });

  it('is listed by ? (R56: the help golden gains it, §9.2 item 40h); the accepted form stays hidden', () => {
    const forms = GRAMMAR.filter((s) => s.handler === HANDLERS.showControllers);
    expect(forms.map((s) => s.path)).toEqual([ACCEPTED_PATH, NEW_PATH]);
    for (const s of forms) expect(s).toMatchObject({ mode: '@exec', privilege: 1, filterable: true, grammars: ['nfos'] });
    expect(forms[0]!.hidden).toBe(true);
    expect(forms[1]!.hidden).toBeUndefined();
    expect(forms[1]!.since).toBe('P3');
    expect(forms[1]!.args).toEqual(forms[0]!.args);
    expect(tokens(priv, 'show ')).toContain('controllers');
    expect(tokens(user, 'show ')).toContain('controllers');
    expect(help(GRAMMAR, priv, 'show ').items.find((i) => i.token === 'controllers')?.help).toBe('Cable end, clock and framing of serial interfaces');
    // `show controllers ` offers the serial ports (and the filter bar), never the accepted form's `serial` keyword
    expect(tokens(priv, 'show controllers ')).toEqual(['Serial0/0/0', 'Serial0/0/1', '|']);
    // the slot form offers the slot numbers of the serial ports
    expect(tokens(priv, 'show controllers serial ')).toEqual(['0/0/0', '0/0/1']);
  });
});

// ── output ───────────────────────────────────────────────────────────────────

/** Two NF-2911 on a serial cable (R1 the DCE end, clocked) and an NF-1941 without serial ports, in `profile`. */
function controllersWorld(profile: DefaultsProfile | undefined): Simulation {
  const t: Topology = topology(
    7,
    [
      device('r1', 'router.nf2911', 'R1', 100, 100, configText([['hostname R1'], section('interface Serial0/0/0', ['ip address 10.0.12.1 255.255.255.252', 'clock rate 64000', 'no shutdown'])])),
      device('r2', 'router.nf2911', 'R2', 300, 100, configText([['hostname R2'], section('interface Serial0/0/0', ['ip address 10.0.12.2 255.255.255.252', 'no shutdown'])])),
      device('r3', 'router.nf1941', 'R3', 500, 100, configText([['hostname R3']])),
    ],
    [cable('l_r1_r2', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce')],
    [],
    'show controllers forms',
    profile === undefined ? {} : { profile },
  );
  const sim = createSimulation(profile === undefined ? { seed: 7 } : { seed: 7, profile });
  sim.loadTopology(t);
  sim.runFor(60 * SEC);
  return sim;
}

/** A privileged console session on `device`. */
function privileged(sim: Simulation, device: DeviceId): SessionId {
  const s = sim.cli.open(device, 'console');
  expect(sim.cli.exec(s, 'enable').error).toBeUndefined();
  return s;
}

/** Every form of one question, run on one session: the accepted form first. */
function runAll(sim: Simulation, s: SessionId, lines: readonly string[]): CliResult[] {
  return lines.map((line) => sim.cli.exec(s, line));
}

/** The lines asking for every serial port, accepted form first. */
const ALL_FORMS = ['show controllers serial', 'show controllers', 'sh controllers', 'show contr'];
/** The lines asking for Serial0/0/0, accepted form first. */
const ONE_FORMS = (n: string): string[] => [
  `show controllers serial Serial${n}`,
  `show controllers serial se${n}`,
  `show controllers serial ${n}`,
  `show controllers Serial ${n}`,
  `show controllers se ${n}`,
  `show controllers Serial${n}`,
];

/** Every result equals the first (output, error, mode, prompt, busy) and none failed. */
function expectSame(results: readonly CliResult[], lines: readonly string[]): string {
  expect(results[0]!.error, lines[0]).toBeUndefined();
  expect(results[0]!.output.length, lines[0]).toBeGreaterThan(0);
  for (let i = 1; i < results.length; i++) expect(results[i], lines[i]).toEqual(results[0]);
  return results[0]!.output;
}

describe('show controllers: every form prints the accepted form\'s output (R56)', () => {
  for (const profile of [undefined, 'P3'] as const) {
    it(`${profile ?? 'P1'} world: the DCE and DTE ends, every port and one port, with and without a filter`, () => {
      const sim = controllersWorld(profile);
      const r1 = privileged(sim, 'r1');
      const all = expectSame(runAll(sim, r1, ALL_FORMS), ALL_FORMS);
      expect(all.split('\n\n').map((b) => b.split('\n')[0])).toEqual(['Serial0/0/0: DCE end of the serial cable', 'Serial0/0/1: no cable attached']);
      expect(all).toContain('  Clock: supplied at 64000 bit/s');
      const one = expectSame(runAll(sim, r1, ONE_FORMS('0/0/0')), ONE_FORMS('0/0/0'));
      expect(one).toBe(all.split('\n\n')[0]);
      const unused = expectSame(runAll(sim, r1, ONE_FORMS('0/0/1')), ONE_FORMS('0/0/1'));
      expect(unused).toBe(all.split('\n\n')[1]);
      const filtered = ['show controllers serial | include Clock', 'show controllers | include Clock', 'show controllers serial 0/0/0 | include Clock'];
      const f = expectSame(runAll(sim, r1, filtered.slice(0, 2)), filtered.slice(0, 2));
      expect(f.split('\n')).toEqual(['  Clock: supplied at 64000 bit/s', '  Clock: no clock rate configured']);
      expect(sim.cli.exec(r1, filtered[2]!)).toEqual(sim.cli.exec(r1, 'show controllers serial Serial0/0/0 | include Clock'));

      const r2 = privileged(sim, 'r2');
      const dte = expectSame(runAll(sim, r2, ALL_FORMS), ALL_FORMS);
      expect(dte.split('\n')[0]).toBe('Serial0/0/0: DTE end of the serial cable');
      expectSame(runAll(sim, r2, ONE_FORMS('0/0/0')), ONE_FORMS('0/0/0'));

      // user exec (privilege 1) prints the same text
      const user = sim.cli.open('r1', 'console');
      expect(runAll(sim, user, ['show controllers serial', 'show controllers', 'show controllers serial 0/0/0']).map((r) => r.output)).toEqual([all, all, one]);
    });
  }

  it('a router without serial ports: the bare form refuses exactly as the accepted form does', () => {
    const sim = controllersWorld(undefined);
    const r3 = privileged(sim, 'r3');
    const [accepted, bare] = runAll(sim, r3, ['show controllers serial', 'show controllers']);
    expect(accepted!.error).toBeDefined();
    expect(accepted!.output + (accepted!.error?.message ?? '')).toContain(MSG_NO_SERIAL);
    expect(bare).toEqual(accepted);
    // a serial slot typed on it names no port: refused by the parser, as the full name is
    expect(sim.cli.exec(r3, 'show controllers serial 0/0/0').error?.message).toBe(MSG_UNKNOWN_INTERFACE);
    expect(sim.cli.exec(r3, 'show controllers serial Serial0/0/0').error?.message).toBeDefined();
  });

  it('the CCNA 3 lab 22 world (P3 profile): the forms a learner tries print what the hint\'s form prints', () => {
    const lab = ccna3SerialLinks;
    const sim = createSimulation({ seed: lab.seed ?? 1 });
    sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
    for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
    sim.runFor(90 * SEC);
    sim.runToIdle();
    const r1 = sim.devices().find((d) => d.spec.name === 'R1')!.id;
    const s = privileged(sim, r1);
    expectSame(runAll(sim, s, ALL_FORMS), ALL_FORMS);
    expectSame(runAll(sim, s, ONE_FORMS('0/0/0')), ONE_FORMS('0/0/0'));
    expect(sim.cli.exec(s, 'show controllers').output).toContain('DCE');
  }, 60_000);
});
