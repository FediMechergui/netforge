/**
 * Every CCNA 2 lesson body (`curriculum/ccna2/theory.ts`) teaches only commands a learner can really type, on the
 * device the lesson is about, and prints only address lines its lab accepts (ARCHITECTURE-P2 §7 W6 course, §11.3).
 *
 * GENERIC over every lesson of `ccna2/lessons.ts` that has a body in `CCNA2_THEORY`, whoever wrote it: a lesson that
 * gains a body is checked from that moment on, with no edit here.
 *
 * HOW A LESSON NAMES ITS MODELS. The models a lesson's commands are typed on are the union of:
 *   1. with a lab (`Lesson.lab`): the catalog types of that lab's topology (`ScenarioInfo.build()`), since the lesson
 *      sends the learner there;
 *   2. without a lab: its entry in `LABLESS_MODELS` below — either the lab of the neighbouring lesson it prepares or
 *      extends (by name, e.g. lesson 18 is practised in lesson 10's lab, §11.1), or an explicit list of types;
 *   3. in both cases, every catalog model the body names by its display name (`NF-C2960`, `NF-IPPHONE`, …), so a
 *      lesson that brings in another device says so in its own text.
 * A lesson whose rules give no model fails, and says which of the three to use.
 *
 * WHAT COUNTS AS A COMMAND. A backticked span, or a line of a fenced block, whose first word — after an optional `no`
 * or `do` — is the first keyword of some command in `GRAMMAR`, spelled in full and in lower case (`switchport`,
 * `show`, `interface`, `ip`, `vlan`, `name`, `ping`, `ipconfig` …). Everything else is a value and is skipped:
 * addresses, interface and VLAN names, and mode names such as `dynamic auto` start with no such keyword. So a span that
 * starts with a command keyword must be a whole line the learner can type: `switchport mode trunk`, never a bare
 * `switchport`. It passes when `matchCommand` accepts it on one of the lesson's models in some CLI mode of that model's
 * grammar (never the login prompt). Interface modes are tried on every port of the model in every role it may take
 * (`allowedRoles`, a serial port as either end), plus the virtual interfaces the body names — `Vlan99`,
 * `GigabitEthernet0/0.10`, `Port-channel1` — created the way the runtime creates them, because the lesson has the
 * learner create them first.
 *
 * ADDRESS LINES are the twin of curriculum.test.ts "prints only address lines the attached lab itself uses": every
 * `ip address …`, `ipv6 address …` or `ip default-gateway …` in the body of a lesson with a lab is a line of that lab's
 * reference solution, so a learner who copies it from the lesson passes the lab's task.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortView } from '../src/contracts/port.js';
import type { Lesson } from '../src/contracts/curriculum.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { CCNA2_THEORY } from '../src/curriculum/ccna2/theory.js';
import { SCENARIOS } from '../src/sim/scenarios/index.js';
import { HUB, MLSWITCH, PC, ROUTER, SERVER, SWITCH } from '../src/sim/scenarios/kit.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { matchCommand, type MatchContext } from '../src/cli/parser.js';
import { allModes, modeInGrammar } from '../src/cli/modes.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { parseSubinterfaceName, resolvePortName } from '../src/device/catalog/names.js';
import { createSubinterfacePortState, createVirtualPortState, parseVirtualPortName } from '../src/device/ports.js';
import { catalogModel, devicePortViews, matchContextFor } from './cli.p05.fixture.js';

/** Catalog types the lab-less lessons name that the lab kit has no constant for. */
const IP_PHONE = 'ipphone.nfphone';
const CONTROLLER = 'wlc.nfwlc9800';
const LIGHTWEIGHT_AP = 'ap.nfap-lw';
const AUTONOMOUS_AP = 'ap.nfap-auto';

/**
 * Rule 2: the models of every lesson without a lab — a lab name (the lab of the lesson it prepares or extends, whose
 * devices it talks about) or a list of catalog types. Every lab-less lesson of the skeleton has an entry, so a body
 * written for it later is checked at once.
 */
const LABLESS_MODELS: Readonly<Record<string, string | readonly string[]>> = {
  'ccna2-01-how-a-switch-forwards': [SWITCH, PC],
  'ccna2-03-speed-duplex-and-cabling': [SWITCH, ROUTER, PC],
  'ccna2-04-why-split-a-lan': [SWITCH, PC],
  'ccna2-08-voice-vlans': [SWITCH, IP_PHONE, PC],
  'ccna2-12-what-a-loop-does': 'ccna2-stp-root-placement',
  'ccna2-14-port-roles-states-and-timers': 'ccna2-stp-root-placement',
  'ccna2-18-dhcp-across-vlans': 'ccna2-l3-switch-svis',
  'ccna2-20-one-gateway-one-point-of-failure': 'ccna2-hsrp-gateway',
  'ccna2-22-threats-at-layer-2': 'ccna2-port-security',
  'ccna2-24-hardening-switch-ports': 'ccna2-port-security',
  'ccna2-25-controllers-and-lightweight-aps': [CONTROLLER, LIGHTWEIGHT_AP, SWITCH],
  'ccna2-26-channels-and-overlap': [AUTONOMOUS_AP, LIGHTWEIGHT_AP],
  'ccna2-28-securing-a-wlan': [CONTROLLER, LIGHTWEIGHT_AP],
  'ccna2-29-how-a-router-chooses': 'ccna2-static-routes',
};

/** The address lines the lab grader compares (the regex of curriculum.test.ts, unchanged). */
const ADDRESS_LINE = /(?:ipv6 address|ip address|ip default-gateway) [^`\n']+/g;

/** A display name as the lessons print it (`NF-C2960`, `NF-C3650-24`, `NF-IPPHONE`). */
const MODEL_NAME = /\bNF-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

/** A token that may name an interface (`Vlan99`, `GigabitEthernet0/0.10`, `Port-channel1`, `g0/0.10`). */
const INTERFACE_NAME = /\b[A-Za-z][A-Za-z-]*\d+(?:\/\d+)*(?:\.\d+)?\b/g;

const lessons = (): Lesson[] => CCNA2_MODULES.flatMap((m) => [...m.lessons]);

/** Lessons that have a written body, with it. */
function writtenLessons(): { lesson: Lesson; body: string }[] {
  return lessons()
    .map((lesson) => ({ lesson, body: CCNA2_THEORY[lesson.id] ?? '' }))
    .filter(({ body }) => body.trim() !== '');
}

/** The first keyword of every command in `GRAMMAR` (literal path heads only). */
function commandKeywords(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of GRAMMAR) {
    const head = spec.path[0];
    if (head !== undefined && !head.startsWith('<')) out.add(head);
  }
  return out;
}

/** Whether a backticked span is a command (its first word, after `no`/`do`, is a command keyword). */
function isCommand(text: string, keywords: ReadonlySet<string>): boolean {
  const words = text.trim().split(/\s+/);
  const first = (words[0] === 'no' || words[0] === 'do') && words.length > 1 ? words[1] : words[0];
  return first !== undefined && keywords.has(first);
}

/** Every backticked span and every fenced line of a body that is a command, in body order. */
function commandsIn(body: string, keywords: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (line.trim() !== '') out.push(line.trim());
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push((m[1] ?? '').trim());
  }
  return out.filter((c) => isCommand(c, keywords));
}

/** The catalog types of a lab's topology, or undefined when no lab has that name. */
function labModels(name: string): string[] | undefined {
  const lab = SCENARIOS.find((s) => s.name === name);
  if (lab === undefined) return undefined;
  return [...new Set(lab.build().devices.map((d) => d.type))];
}

/** Rules 1–3: the catalog types a lesson's commands are typed on, or an explanation of why there are none. */
function modelsOf(lesson: Lesson, body: string): { types: string[] } | { error: string } {
  const types = new Set<string>();
  const source = lesson.lab ?? LABLESS_MODELS[lesson.id];
  if (typeof source === 'string') {
    const fromLab = labModels(source);
    if (fromLab === undefined) return { error: `${lesson.id} relies on lab ${source}, which is not in SCENARIOS` };
    for (const t of fromLab) types.add(t);
  } else if (source !== undefined) {
    for (const t of source) types.add(t);
  }
  for (const [name] of body.matchAll(MODEL_NAME)) {
    const named = ALL_MODELS.find((m) => m.model === name);
    if (named !== undefined) types.add(named.type);
  }
  if (types.size === 0) return { error: `${lesson.id} names no model: attach a lab, add it to LABLESS_MODELS, or name an NF-… model in its body` };
  return { types: [...types] };
}

/** The virtual interfaces a body names that `model` can create, as the runtime would create them. */
function namedVirtualPorts(model: DeviceModel, ports: Map<PortId, PortView>, body: string): PortView[] {
  const out: PortView[] = [];
  for (const [token] of body.matchAll(INTERFACE_NAME)) {
    const r = resolvePortName({ model, ports }, token);
    if (r.kind !== 'virtual' || ports.has(r.port) || out.some((p) => p.id === r.port)) continue;
    const sub = r.parent !== undefined ? parseSubinterfaceName(r.port) : undefined;
    const parent = r.parent !== undefined ? ports.get(r.parent) : undefined;
    if (sub !== undefined && parent !== undefined) {
      out.push(createSubinterfacePortState({ ...parent, ordinal: parent.ordinal ?? parent.spec.ordinal ?? 0 }, sub.number));
      continue;
    }
    const family = parseVirtualPortName(model, r.port);
    if (family !== undefined) out.push(createVirtualPortState(family.family, family.number, 0));
  }
  return out;
}

/** One view per distinct (kind, role, encapsulation, serial end) the interface modes can be entered on. */
function interfaceVariants(ports: ReadonlyMap<PortId, PortView>): PortView[] {
  const seen = new Set<string>();
  const out: PortView[] = [];
  for (const view of ports.values()) {
    const roles = view.spec.allowedRoles.length > 0 ? view.spec.allowedRoles : [view.role ?? view.spec.role];
    const ends: (boolean | undefined)[] = view.spec.kind === 'serial' ? [true, false] : [undefined];
    for (const role of roles) {
      for (const dce of ends) {
        const key = `${view.spec.kind}|${role}|${view.spec.encap}|${String(dce)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(dce === undefined ? { ...view, role } : { ...view, role, phy: { carrier: true, lineProtocol: true, dce } });
      }
    }
  }
  return out;
}

/** Every parser context a learner can type a line in on `model` (never the login prompt). */
function contextsOf(model: DeviceModel, body: string): MatchContext[] {
  const ports = devicePortViews(model);
  for (const view of namedVirtualPorts(model, ports, body)) ports.set(view.id, view);
  const grammar = model.cli?.grammar ?? 'nfos';
  const out: MatchContext[] = [];
  for (const def of allModes()) {
    if (def.class === 'auth' || !modeInGrammar(def.name, grammar)) continue;
    if (def.contextKey === 'interface') {
      for (const view of interfaceVariants(ports)) out.push(matchContextFor(model, def.name, { ports, ifaceView: view }));
    } else {
      out.push(matchContextFor(model, def.name, { ports }));
    }
  }
  return out;
}

/** Whether `line` parses in one of `contexts`. */
function parsesIn(contexts: readonly MatchContext[], line: string): boolean {
  return contexts.some((ctx) => matchCommand(GRAMMAR, ctx, line).ok);
}

describe('the rules this file applies', () => {
  const keywords = commandKeywords();

  it('tells commands from values by their first keyword', () => {
    for (const cmd of ['switchport mode trunk', 'no shutdown', 'do show vlan brief', 'show interfaces trunk', 'ipconfig /all', 'vlan 10', 'name SALES']) {
      expect(isCommand(cmd, keywords), cmd).toBe(true);
    }
    for (const value of ['dynamic auto', '192.168.10.0/24', 'SALES', 'GigabitEthernet0/1', 'Vlan99', '10,20,99', 'native', 'no']) {
      expect(isCommand(value, keywords), value).toBe(false);
    }
  });

  it('reads backticked spans and fenced lines, and nothing else', () => {
    const body = ['Type `vlan 10` and then `name SALES`; the mode is `dynamic auto`.', '', '```', 'interface Vlan99', ' no shutdown', '```', 'switchport mode access'].join('\n');
    expect(commandsIn(body, keywords)).toEqual(['vlan 10', 'name SALES', 'interface Vlan99', 'no shutdown']);
  });

  it('checks a command against the lesson models, not against every device', () => {
    const pc = contextsOf(catalogModel(PC), '');
    const sw = contextsOf(catalogModel(SWITCH), '');
    expect(parsesIn(pc, 'switchport mode trunk')).toBe(false);
    expect(parsesIn(sw, 'switchport mode trunk')).toBe(true);
    expect(parsesIn(sw, 'switchport mode')).toBe(false);
    expect(parsesIn(pc, 'ipconfig /all')).toBe(true);
    expect(parsesIn(sw, 'ipconfig /all')).toBe(false);
  });

  it('lets a lesson use the virtual interfaces it names, on the models that can create them', () => {
    const router = catalogModel(ROUTER);
    expect(parsesIn(contextsOf(router, ''), 'show interfaces GigabitEthernet0/0.10')).toBe(false);
    expect(parsesIn(contextsOf(router, 'Create `interface GigabitEthernet0/0.10` first.'), 'show interfaces GigabitEthernet0/0.10')).toBe(true);
    const sw = catalogModel(SWITCH);
    expect(parsesIn(contextsOf(sw, ''), 'show interfaces Vlan99')).toBe(false);
    expect(parsesIn(contextsOf(sw, 'then `interface Vlan99`'), 'show interfaces Vlan99')).toBe(true);
    // a model with no such family gains nothing from the name
    expect(parsesIn(contextsOf(catalogModel(PC), 'then `interface Vlan99`'), 'show interfaces Vlan99')).toBe(false);
    expect(parsesIn(contextsOf(catalogModel(MLSWITCH), 'then `interface Vlan10`'), 'show interfaces Vlan10')).toBe(true);
  });

  it('takes the models from the lab, the lab-less map and the model names in the body', () => {
    const byId = (id: string): Lesson => {
      const l = lessons().find((x) => x.id === id);
      if (l === undefined) throw new Error(`no lesson ${id}`);
      return l;
    };
    expect(modelsOf(byId('ccna2-10-multilayer-switching'), '')).toEqual({ types: expect.arrayContaining([MLSWITCH, PC, ROUTER, SERVER]) as unknown });
    expect(modelsOf(byId('ccna2-08-voice-vlans'), '')).toEqual({ types: [SWITCH, IP_PHONE, PC] });
    expect(modelsOf(byId('ccna2-01-how-a-switch-forwards'), 'on an **NF-C3650-24**')).toEqual({ types: [SWITCH, PC, MLSWITCH] });
    expect(modelsOf(byId('ccna2-22-threats-at-layer-2'), '')).toEqual({ types: expect.arrayContaining([SWITCH, PC, HUB]) as unknown });
  });

  it('gives every lab-less lesson of the skeleton an entry, and only those', () => {
    const labless = lessons()
      .filter((l) => l.lab === undefined)
      .map((l) => l.id);
    expect(Object.keys(LABLESS_MODELS).sort()).toEqual([...labless].sort());
  });

  it('names only labs that exist and catalog types that exist', () => {
    for (const [id, source] of Object.entries(LABLESS_MODELS)) {
      if (typeof source === 'string') expect(labModels(source), `${id}: lab ${source}`).toBeDefined();
      else for (const t of source) expect(ALL_MODELS.some((m) => m.type === t), `${id}: type ${t}`).toBe(true);
    }
  });
});

describe('CCNA 2 lesson commands agree with the engine and the attached lab', () => {
  it('has a body only for lessons of the skeleton', () => {
    const ids = new Set(lessons().map((l) => l.id));
    expect(Object.keys(CCNA2_THEORY).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('prints only commands that parse on a model the lesson names', () => {
    const keywords = commandKeywords();
    const wrong: string[] = [];
    let checked = 0;
    for (const { lesson, body } of writtenLessons()) {
      const models = modelsOf(lesson, body);
      if ('error' in models) {
        wrong.push(models.error);
        continue;
      }
      const contexts = models.types.flatMap((t) => contextsOf(catalogModel(t), body));
      for (const cmd of new Set(commandsIn(body, keywords))) {
        checked += 1;
        if (!parsesIn(contexts, cmd)) wrong.push(`${lesson.id} :: ${cmd}   (models: ${models.types.join(', ')})`);
      }
    }
    expect(wrong, `commands a learner could not type on the lesson's models:\n${wrong.join('\n')}`).toEqual([]);
    if (writtenLessons().length > 0) expect(checked, 'no command was found in any written lesson').toBeGreaterThan(0);
  });

  it('prints only address lines the attached lab itself uses', () => {
    const wrong: string[] = [];
    for (const { lesson, body } of writtenLessons()) {
      if (lesson.lab === undefined) continue;
      const solution = SCENARIOS.find((s) => s.name === lesson.lab)?.solution;
      if (solution === undefined) {
        wrong.push(`${lesson.id} :: lab ${lesson.lab} has no reference solution`);
        continue;
      }
      const lines = new Set(Object.values(solution).flat().map((l) => l.trim()));
      for (const [line] of body.matchAll(ADDRESS_LINE)) {
        const cmd = line.trim().replace(/\.$/, '');
        if (!lines.has(cmd)) wrong.push(`${lesson.id} :: ${cmd}`);
      }
    }
    expect(wrong, `address lines the attached lab would not accept:\n${wrong.join('\n')}`).toEqual([]);
  });
});
