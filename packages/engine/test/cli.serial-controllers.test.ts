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
 *   • scope of the listing (ruling R58 (d), W6b cli): the visible form is offered on the models with the routing
 *     capability (routers, layer-3 switches, firewalls, and the home routers) and on the Internet cloud (the ruling's
 *     "serial port" clause: its `cloud` capability; W6b review); every other network-OS model (layer-2 switches, hubs,
 *     access points, modems, bridges, and the CSU/DSU, whose only capability is the modems' `modem`) keeps the R56
 *     lines executable through a hidden twin of the same path, which `?` and Tab never offer;
 *   • output, on booted worlds (a P1 serial pair and a P3-profile world, plus the CCNA 3 lab 22 world): every form
 *     prints the accepted form's text byte for byte on the DCE and the DTE end, with and without a filter, and on a
 *     router without serial ports the bare form refuses exactly as the accepted form does — as it does, unlisted, on a
 *     layer-2 switch, an access point and a bridge (R58 (d)).
 */
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import { SEC } from '../src/contracts/time.js';
import { CONTROLLERS_LISTED_ON, GRAMMAR, HANDLERS, MSG_NO_LINE_CONTROLLER } from '../src/cli/grammar/index.js';
import { MSG_NO_SERIAL } from '../src/cli/handlers/show.js';
import { complete, help, matchCommand, MSG_UNKNOWN_INTERFACE, type MatchContext } from '../src/cli/parser.js';
import { cable, configText, device, section, topology } from '../src/sim/scenarios/kit.js';
import { ccna3SerialLinks } from '../src/sim/scenarios/ccna3/wan.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { catalogModel, devicePortViews, matchContextFor } from './cli.p05.fixture.js';

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

  it('is listed by ? (R56: the help golden gains it, §9.2 item 40h) on routing models and the Internet cloud (R58 (d)); the accepted form stays hidden', () => {
    const forms = GRAMMAR.filter((s) => s.handler === HANDLERS.showControllers);
    // ARCHITECTURE-P3 §9.2 W6, the W6b entry of ruling R58 (d) (cli): the R56 form is two specs of one path — the listed one
    // on models with the routing capability and its hidden twin everywhere else — so `[ACCEPTED_PATH, NEW_PATH]` gains
    // the twin's NEW_PATH
    expect(forms.map((s) => s.path)).toEqual([ACCEPTED_PATH, NEW_PATH, NEW_PATH]);
    for (const s of forms) expect(s).toMatchObject({ mode: '@exec', privilege: 1, filterable: true, grammars: ['nfos'] });
    expect(forms[0]!.hidden).toBe(true);
    expect(forms[0]!.requiresAny).toBeUndefined();
    expect(forms[0]!.excludesAny).toBeUndefined();
    expect(forms[1]!.hidden).toBeUndefined();
    expect(forms[1]!.since).toBe('P3');
    expect(forms[1]!.args).toEqual(forms[0]!.args);
    // R58 (d): "the routing capability or a serial port" — the Internet cloud's serial ports are its `cloud` capability
    expect(CONTROLLERS_LISTED_ON).toEqual(['routing', 'cloud']);
    expect(forms[1]!.excludesAny).toBeUndefined();
    // the twin is the listed spec with the opposite capability gate and `hidden`, nothing else
    const { requiresAny: listedGate, ...listed } = forms[1]!;
    const { excludesAny: twinGate, hidden: twinHidden, ...twin } = forms[2]!;
    expect(listedGate).toEqual(['routing', 'cloud']);
    expect(twinGate).toEqual(['routing', 'cloud']);
    expect(twinHidden).toBe(true);
    expect(twin).toEqual(listed);
    expect(tokens(priv, 'show ')).toContain('controllers');
    expect(tokens(user, 'show ')).toContain('controllers');
    expect(help(GRAMMAR, priv, 'show ').items.find((i) => i.token === 'controllers')?.help).toBe('Cable end, clock and framing of serial interfaces');
    // `show controllers ` offers the serial ports (and the filter bar), never the accepted form's `serial` keyword
    expect(tokens(priv, 'show controllers ')).toEqual(['Serial0/0/0', 'Serial0/0/1', '|']);
    // the slot form offers the slot numbers of the serial ports
    expect(tokens(priv, 'show controllers serial ')).toEqual(['0/0/0', '0/0/1']);
  });
});

describe('show controllers: where the visible form is listed (R58 (d))', () => {
  /** The network-OS models: the 37 `priv-exec show` lists of the help golden (`goldens/cli-help.p05.json`). */
  const NFOS = ALL_MODELS.filter((m) => m.cli.grammar === 'nfos');
  /**
   * The models whose `show ` lists keep `controllers` (catalog order): routers, layer-3 switches, firewalls, home routers
   * (the routing capability) and the Internet cloud (a serial-port model, R58 (d); W6b review).
   */
  const LISTED = [
    'router.nf1941', 'router.nf2911', 'router.nf4331', 'router.nf4451', 'router.nfgeneric',
    'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48', 'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
    'firewall.nfasa5506', 'firewall.nfngfw1120', 'wrouter.nfhome', 'wrouter.nfhome-ax', 'cloud.nfinternet',
  ];
  /**
   * The models whose `show ` lists lose the 40h addition (catalog order): the moves of the help golden. The CSU/DSU has
   * serial ports, but its only capability is the modems' `modem`, and R58 (d) names the modems among those no longer
   * listing it: no capability gate can tell them apart, so it stays here until the architect rules on it (W6b review).
   */
  const UNLISTED = [
    'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
    'hub.nfhub4', 'hub.nfhub8', 'hub.nfcoax', 'repeater.nfrep', 'bridge.nfbr2', 'bridge.nfbr4',
    'ap.nfap-auto', 'ap.nfap-lw', 'ap.nfap-mesh', 'ap.nfap-ax', 'wlc.nfwlc9800', 'radio.nfptp5', 'radio.nfptp60',
    'cell.nftower', 'modem.nfdsl', 'modem.nfcable', 'modem.nfont', 'csu.nfcsu',
  ];
  const offers = (type: string, mode: 'priv-exec' | 'user-exec'): boolean => tokens(matchContextFor(catalogModel(type), mode), 'show ').includes('controllers');
  /** The scope rule of R58 (d) on the catalog data: the routing capability or (the Internet cloud) the `cloud` one. */
  const listedBy = (caps: readonly string[]): boolean => caps.includes('routing') || caps.includes('cloud');

  it('`show ` offers controllers on exactly the 13 models with the routing capability and the Internet cloud, and on none of the 23 others', () => {
    expect(NFOS.length).toBe(37);
    expect(LISTED.length).toBe(14);
    expect(UNLISTED.length).toBe(23);
    expect(NFOS.filter((m) => offers(m.type, 'priv-exec')).map((m) => m.type)).toEqual(LISTED);
    expect(NFOS.filter((m) => !offers(m.type, 'priv-exec')).map((m) => m.type)).toEqual(UNLISTED);
    // the rule is the capability, nothing else: every serial port and serial module slot sits on a routing model except
    // the console-less Internet cloud (listed by its `cloud` capability) and the console-less CSU/DSU (a `modem`)
    for (const m of NFOS) expect(offers(m.type, 'priv-exec'), m.type).toBe(listedBy(m.capabilities));
    for (const type of [...LISTED, ...UNLISTED]) expect(offers(type, 'user-exec'), type).toBe(LISTED.includes(type));
    const withSerial = NFOS.filter((m) => m.ports.some((p) => p.kind === 'serial')).map((m) => m.type);
    expect(withSerial).toEqual(['router.nf2911', 'csu.nfcsu', 'cloud.nfinternet']);
    // R58 (d) "or a serial port": the Internet cloud's serial ports keep the form listed (W6b review), and
    // `show controllers ` offers them; the CSU/DSU shares the modems' only capability (above)
    expect(offers('cloud.nfinternet', 'priv-exec')).toBe(true);
    expect(offers('cloud.nfinternet', 'user-exec')).toBe(true);
    const cloud = matchContextFor(catalogModel('cloud.nfinternet'), 'priv-exec');
    expect(ok(cloud, 'show controllers').spec.hidden).toBeUndefined();
    expect(tokens(cloud, 'show controllers ')).toEqual(['Serial0', 'Serial1', 'Serial2', 'Serial3', '|']);
    expect(catalogModel('csu.nfcsu').capabilities).toEqual(['modem']);
    expect(catalogModel('modem.nfdsl').capabilities).toEqual(['modem']);
    // a serial module in a slot adds no capability, so an NF-1941 lists it with or without one
    const r1941 = catalogModel('router.nf1941');
    const ports = devicePortViews(r1941, { modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }] });
    expect(tokens(matchContextFor(r1941, 'priv-exec', { ports, modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }] }), 'show ')).toContain('controllers');
  });

  it('elsewhere the R56 lines still run, through the hidden twin, and `?` and Tab never offer them', () => {
    for (const type of UNLISTED.filter((t) => catalogModel(t).cli.shell === 'nfos')) {
      const priv = matchContextFor(catalogModel(type), 'priv-exec');
      const bare = ok(priv, 'show controllers');
      expect(bare.spec.handler, type).toBe(HANDLERS.showControllers);
      expect(bare.spec.path, type).toEqual(NEW_PATH);
      expect(bare.spec.hidden, type).toBe(true);
      expect(bare.args, type).toEqual(ok(priv, 'show controllers serial').args);
      expect(ok(priv, 'sh contr | include Clock').filter, type).toEqual({ kind: 'include', pattern: 'Clock' });
      expect(ok(matchContextFor(catalogModel(type), 'user-exec'), 'show controllers').spec.path, type).toEqual(NEW_PATH);
      // nothing is listed after the keyword (both forms are hidden there), and the line is executable as typed
      const after = help(GRAMMAR, priv, 'show controllers ');
      expect(after.items, type).toEqual([]);
      expect(after.cr, type).toBe(true);
      expect(complete(GRAMMAR, priv, 'show contr').items, type).toEqual([]);
    }
    // the shell-less models of the list have no console at all, so `?` is all they ever had of it
    expect(UNLISTED.filter((t) => catalogModel(t).cli.shell === 'nfos')).toEqual([
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'bridge.nfbr2', 'bridge.nfbr4', 'ap.nfap-auto', 'ap.nfap-lw', 'ap.nfap-mesh', 'ap.nfap-ax',
    ]);
  });

  it('the listed form and its twin are never both in scope, so no line is ambiguous between them', () => {
    for (const m of NFOS) {
      const priv = matchContextFor(m, 'priv-exec');
      const r = ok(priv, 'show controllers');
      expect(r.spec.hidden === true, m.type).toBe(!listedBy(m.capabilities));
    }
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

  it('R58 (d): unlisted on a layer-2 switch, an access point and a bridge (listed on a firewall), the bare form refuses exactly as the accepted form does', () => {
    const t: Topology = topology(
      7,
      [
        device('s1', 'switch.nfc2960', 'S1', 100, 100, configText([['hostname S1']])),
        device('ap1', 'ap.nfap-auto', 'AP1', 300, 100, configText([['hostname AP1']])),
        device('br1', 'bridge.nfbr2', 'BR1', 500, 100, configText([['hostname BR1']])),
        device('fw1', 'firewall.nfasa5506', 'FW1', 700, 100, configText([['hostname FW1']])),
      ],
      [],
      [],
      'show controllers off the routing models',
      { profile: 'P3' },
    );
    const sim = createSimulation({ seed: 7, profile: 'P3' });
    sim.loadTopology(t);
    sim.runFor(60 * SEC);
    for (const id of ['s1', 'ap1', 'br1', 'fw1'] as const) {
      const s = privileged(sim, id);
      const [accepted, bare, short] = runAll(sim, s, ['show controllers serial', 'show controllers', 'sh contr']);
      expect(accepted!.error?.message, id).toBe(MSG_NO_SERIAL);
      expect(bare, id).toEqual(accepted);
      expect(short, id).toEqual(accepted);
      // no serial port to name, in either form
      expect(sim.cli.exec(s, 'show controllers serial 0/0/0').error?.message, id).toBe(MSG_UNKNOWN_INTERFACE);
      // user exec too
      const user = sim.cli.open(id, 'console');
      expect(sim.cli.exec(user, 'show controllers'), id).toEqual(sim.cli.exec(user, 'show controllers serial'));
    }
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
