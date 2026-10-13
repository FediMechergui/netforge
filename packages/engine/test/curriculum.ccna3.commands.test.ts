/**
 * Every CCNA 3 lesson body (`curriculum/ccna3/theory.ts`) shows only code a learner can really use: commands that
 * parse on the devices the lesson is about, data documents that parse with their own parsers, and address lines its
 * lab accepts; and it keeps the content rules every course body keeps (ARCHITECTURE-P3 §7 W6 course, §11.3).
 *
 * GENERIC over every lesson of `ccna3/lessons.ts` that has a body in `CCNA3_THEORY`, whoever wrote it (theory-a, -b,
 * -c in W6, -d in W7): a lesson that gains a body is checked from that moment on; only the part-disjointness case names
 * the parts, and gained theory-d in W7 (§9.2 item 44d). The skeleton was DETACHED from `curriculum/index.ts` until the
 * W7 course flip (§11.3), so the bodies are read from `CCNA3_THEORY` directly. This is the CCNA 2 commands test (`curriculum.ccna2.commands.test.ts`) generalised as §11.3 asks.
 *
 * HOW A LESSON NAMES ITS MODELS (as in CCNA 2). The models a lesson's commands are typed on are the union of:
 *   1. with a lab (`Lesson.lab`): the devices of that lab's topology (`ScenarioInfo.build()`) — catalog type AND the
 *      modules installed in it, so a lesson may name a module port (`GigabitEthernet0/1/0` of an NF-4331 with a
 *      two-port module) its lab cables;
 *   2. without a lab: its entry in `LABLESS_MODELS` below — the lab where the lesson is practised or that its "See it"
 *      section opens (by name), or an explicit list of catalog types;
 *   3. in both cases, every catalog model the body names by its display name (`NF-2911`, `NF-C3650-24`, …).
 * A lesson whose rules give no model fails, and says which of the three to use.
 *
 * WHAT IS CODE, AND HOW EACH KIND IS CHECKED (§11.3).
 *   - A backticked span is a command when its first word — after an optional `no` or `do` — is the first keyword of
 *     some command in `GRAMMAR`, in full and in lower case (`show`, `router`, `network`, `ip`, `debug` …). Every other
 *     span is a value (an address, an interface or state name, a route code) and is skipped. A command span must be a
 *     whole line the learner can type: `ip ospf priority 200`, never a bare `ip ospf`.
 *   - A fenced block WITHOUT an info string is CLI: EVERY non-empty line of it must parse (stricter than CCNA 2, which
 *     skipped fence lines that started with no keyword). Output, prompts and anything else that is not typed belongs
 *     in a ```text block.
 *   - A fenced block WITH an info string is not CLI and must parse with its own parser: `json` with `JSON.parse`,
 *     `yaml` and `xml` with `automation/data`, `http` against the simulated RESTCONF route table (a request line whose
 *     method the API answers and whose target `automation/yang` resolves, or a status line with the API's own reason
 *     phrase; header lines; a JSON body), `python` with the NF-Py parser ([S32], approved); `text` is unchecked. Any
 *     other info string fails: the lab markdown would drop it and show the block as unlabelled code (D24, `lang` is
 *     display-only; the markdown reads the language in any case, and so does this file).
 * A command passes when `matchCommand` accepts it on one of the lesson's models in some CLI mode of that model's
 * grammar (never the login prompt). Interface modes are tried on every port of the model in every role it may take
 * (`allowedRoles`, a serial port as either end), plus the virtual interfaces the body names (`Tunnel0`, `Vlan99`,
 * `GigabitEthernet0/0.10`, `Loopback0`), created the way the runtime creates them.
 *
 * ADDRESS LINES (the CCNA 1 and 2 rule): every `ip address …`, `ipv6 address …` or `ip default-gateway …` in the body of
 * a lesson with a lab is a line of that lab's reference solution, so a learner who copies it passes the lab's task.
 * Prose therefore writes "address", never the lower-case command words.
 *
 * THE CONTENT RULES THAT APPLY UNCHANGED (§11.3): the five fixed section headings in order and no other heading; the
 * markdown subset (links only to `concept:<a ConceptToolId>` and `https://`, no raw markup, images, entities or
 * `http://`, and no more than the 20 000 characters the lab markdown reads) outside code — code is display-only text, so an XML sample keeps its angle brackets; no vendor,
 * controller product or vendor certification programme anywhere in a body; and the body's reading time (238 words a
 * minute, the video rule's rate) fits inside the lesson's minutes. The last block pins what §11.3 says the module 1-4
 * lessons must tell the learner (the OSPF deviations a learner can notice, and lesson 10's two EIGRP statements).
 */
import { describe, expect, it } from 'vitest';
import type { ModuleInstall } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortView } from '../src/contracts/port.js';
import type { Lesson } from '../src/contracts/curriculum.js';
import type { ConceptToolId } from '../src/contracts/scenario.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { CCNA3_OBJECTIVES } from '../src/curriculum/ccna3/objectives.js';
import { CCNA3_THEORY } from '../src/curriculum/ccna3/theory.js';
import { CCNA3_THEORY_A } from '../src/curriculum/ccna3/theory-a.js';
import { CCNA3_THEORY_B } from '../src/curriculum/ccna3/theory-b.js';
import { CCNA3_THEORY_C } from '../src/curriculum/ccna3/theory-c.js';
import { CCNA3_THEORY_D } from '../src/curriculum/ccna3/theory-d.js';
import { SCENARIOS } from '../src/sim/scenarios/index.js';
import { MLSWITCH, PC, ROUTER, SERVER, SWITCH } from '../src/sim/scenarios/kit.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { matchCommand, type MatchContext } from '../src/cli/parser.js';
import { allModes, modeInGrammar } from '../src/cli/modes.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { parseSubinterfaceName, resolvePortName } from '../src/device/catalog/names.js';
import { createSubinterfacePortState, createVirtualPortState, parseVirtualPortName } from '../src/device/ports.js';
import { parseYaml } from '../src/automation/data/yaml.js';
import { parseXml } from '../src/automation/data/xml.js';
import { parsePy } from '../src/automation/py/parser.js';
import { parseRestconfTarget } from '../src/automation/yang/path.js';
import { resolveYangOperation, resolveYangPath } from '../src/automation/yang/model.js';
import { restconfReason } from '../src/protocols/restconf.js';
import { OSPF_SPF_DELAY_NS, OSPF_SPF_HOLD_NS } from '../src/protocols/ospf.js';
import { networkLsaBody, type OriginIface } from '../src/protocols/ospf/originate.js';
import { SEC } from '../src/contracts/time.js';
import { catalogModel, devicePortViews, matchContextFor } from './cli.p05.fixture.js';

/**
 * Rule 2: the models of every lesson without a lab — the lab where the lesson is practised or that its "See it"
 * section opens (whose devices it talks about), or a list of catalog types. Every lab-less lesson of the skeleton has
 * an entry, so a body written for it later is checked at once; a body that brings in another model names it.
 */
const LABLESS_MODELS: Readonly<Record<string, string | readonly string[]>> = {
  // module 1: the routing table of lesson 05's world (OSPF runs from the start), and its link-state database
  'ccna3-01-why-routers-share-routes': 'ccna3-ospf-cost',
  'ccna3-02-how-ospf-maps-a-network': 'ccna3-ospf-cost',
  // module 3 (theory: [S4] and [S6] are not approved): an area mismatch typed in lesson 05's world; the link-local
  // next hops of the CCNA 2 IPv6 static-route lab
  'ccna3-08-more-than-one-area': 'ccna3-ospf-cost',
  'ccna3-09-ospf-for-ipv6': 'ccna2-ipv6-static',
  // module 5: concepts, on the everyday devices
  'ccna3-11-the-language-of-security': [ROUTER, SWITCH, PC],
  'ccna3-12-how-attacks-unfold': [ROUTER, SWITCH, PC],
  'ccna3-13-layers-of-defence': [ROUTER, SWITCH, PC],
  // module 6: lesson 14 prepares lesson 15's lab; lesson 18 is practised in lesson 34's lab (§11.1)
  'ccna3-14-how-an-acl-decides': 'ccna3-acl-standard',
  'ccna3-18-translation-at-the-edge': 'ccna3-troubleshoot-enterprise',
  // modules 8-10: the lab of the lesson each concept lesson prepares
  'ccna3-21-joining-distant-sites': 'ccna3-serial-links',
  'ccna3-23-private-paths-over-public-networks': 'ccna3-ipsec-site-to-site',
  'ccna3-26-why-traffic-needs-priority': 'ccna3-qos-voice-first',
  // modules 11-13: theory ([S33], [S34], [S29] are not approved) and concepts
  'ccna3-30-watching-the-network': [ROUTER, SWITCH, PC],
  'ccna3-31-looking-after-files-and-images': [ROUTER, SWITCH],
  'ccna3-32-designing-networks-that-grow': [SWITCH, MLSWITCH, ROUTER],
  'ccna3-35-clouds-and-virtual-machines': [SERVER, SWITCH, PC],
  'ccna3-36-software-defined-networking': [ROUTER, SWITCH],
  // module 14 (W7): the concept tool's lesson and the configuration-management lesson
  'ccna3-37-data-a-machine-can-read': [ROUTER, SWITCH],
  'ccna3-39-configuration-as-code': [ROUTER, SWITCH],
};

/** The address lines the lab grader compares (the regex of curriculum.test.ts, unchanged). */
const ADDRESS_LINE = /(?:ipv6 address|ip address|ip default-gateway) [^`\n']+/g;

/** A display name as the lessons print it (`NF-2911`, `NF-C3650-24`, `NF-4331`). */
const MODEL_NAME = /\bNF-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

/** A token that may name an interface (`Vlan99`, `GigabitEthernet0/0.10`, `Tunnel0`, `Loopback0`, `g0/0.10`). */
const INTERFACE_NAME = /\b[A-Za-z][A-Za-z-]*\d+(?:\/\d+)*(?:\.\d+)?\b/g;

/** The fence languages the lab markdown labels (apps/web/src/labs/markdown.ts `MD_CODE_LANGS`, §2.14). */
const FENCE_LANGS = ['json', 'yaml', 'xml', 'http', 'python', 'text'] as const;
type FenceLang = (typeof FENCE_LANGS)[number];

/** A fence line (``` or ~~~, as the lab markdown reads it) and its info string. */
const FENCE = /^[ \t]*(?:```|~~~)(.*)$/;

/** The five sections of every body, in this order (the CCNA 1 and 2 bodies keep the same list). */
const SECTIONS = ['## The idea in one breath', '## Why it exists', '## How it actually works', '## What trips people up', '## See it in NetForge'];

/** The concept tools a body may link to (`concept:<id>`): exhaustive over `ConceptToolId` (D24). */
const CONCEPT_TOOLS: Readonly<Record<ConceptToolId, true>> = { subnetting: true, ipv6: true, queueing: true, 'data-formats': true, wildcard: true };
const LINK = /\[[^\]\n]*\]\(([^()\s]*)\)/g;
const HTTPS_TARGET = /^https:\/\/[^\s<>"'`\\]+$/;

/**
 * Names this course never prints (§0 rule 6, §11.3: no vendor, controller product or vendor certification programme),
 * the list of `curriculum.ccna3.test.ts`; checked on the whole body, code included.
 */
const VENDORS =
  /\b(?:cisco|ios|ios-xe|nx-os|packet\s*tracer|netacad|juniper|junos|huawei|catalyst|meraki|aruba|nexus|ansible|netflow|dna\s*center|apic|sd-access|devnet|ccna|ccnp|wireshark)\b/i;

/** The reading rate of the video rule (§11.3): a body must fit in its lesson's minutes at this rate. */
const WORDS_PER_MINUTE = 238;

/** The longest text the lab markdown reads (apps/web/src/labs/markdown.ts `MARKDOWN_MAX_CHARS`); the rest is dropped. */
const MARKDOWN_MAX_CHARS = 20_000;

/** The HTTP methods the RESTCONF API answers (protocols/restconf.ts, `MSG_RESTCONF_METHOD`). */
const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

const lessons = (): Lesson[] => CCNA3_MODULES.flatMap((m) => [...m.lessons]);

/** Lessons that have a written body, with it. */
function writtenLessons(): { lesson: Lesson; body: string }[] {
  return lessons()
    .map((lesson) => ({ lesson, body: CCNA3_THEORY[lesson.id] ?? '' }))
    .filter(({ body }) => body.trim() !== '');
}

// ── reading the code of a body ───────────────────────────────────────────────

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

/** One fenced block: its info string (trimmed, '' for none) and its text. */
interface FencedBlock {
  readonly info: string;
  readonly text: string;
}

/** The code of a body: inline spans of the prose, fenced blocks, the prose with code removed, an unclosed fence. */
interface BodyCode {
  readonly spans: string[];
  readonly blocks: FencedBlock[];
  readonly prose: string;
  readonly unclosed: boolean;
}

/** Splits a body into prose, inline code spans and fenced blocks, as the lab markdown reads them. */
function codeOf(body: string): BodyCode {
  const spans: string[] = [];
  const blocks: FencedBlock[] = [];
  const prose: string[] = [];
  let open: { info: string; lines: string[] } | undefined;
  for (const line of body.split('\n')) {
    const fence = FENCE.exec(line);
    if (open !== undefined) {
      if (fence !== null) {
        blocks.push({ info: open.info, text: open.lines.join('\n') });
        open = undefined;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    if (fence !== null) {
      open = { info: (fence[1] ?? '').trim(), lines: [] };
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) spans.push((m[1] ?? '').trim());
    prose.push(line.replace(/`[^`\n]+`/g, ' '));
  }
  return { spans, blocks, prose: prose.join('\n'), unclosed: open !== undefined };
}

/** Every line the learner is shown as typed CLI: the command spans and every non-empty line of a plain fence. */
function cliLinesOf(code: BodyCode, keywords: ReadonlySet<string>): string[] {
  const out = code.spans.filter((s) => isCommand(s, keywords));
  for (const b of code.blocks) {
    if (b.info !== '') continue;
    for (const line of b.text.split('\n')) if (line.trim() !== '') out.push(line.trim());
  }
  return out;
}

// ── data blocks (§11.3: each language with its own parser) ─────────────────

/** Why an `http` block is not a request or response the simulated RESTCONF API knows, or undefined. */
function httpProblem(text: string): string | undefined {
  const lines = text.split('\n');
  const start = (lines[0] ?? '').trim();
  const blank = lines.findIndex((l) => l.trim() === '');
  const headers = (blank < 0 ? lines.slice(1) : lines.slice(1, blank)).filter((l) => l.trim() !== '');
  const body = blank < 0 ? '' : lines.slice(blank + 1).join('\n').trim();
  const status = /^HTTP\/1\.1 (\d{3}) (.+)$/.exec(start);
  if (status !== null) {
    const code = Number(status[1]);
    const reason = restconfReason(code);
    if (reason === '' || reason !== status[2]) return `"${start}": the API answers ${code} with the reason "${reason || '(none)'}"`;
  } else {
    const request = /^([A-Z]+) (\S+) HTTP\/1\.1$/.exec(start);
    if (request === null) return `"${start}" is neither a request line nor a status line`;
    const method = request[1] ?? '';
    if (!API_METHODS.includes(method)) return `the API does not answer ${method}`;
    const target = parseRestconfTarget(request[2] ?? '');
    if (!target.ok) return `${request[2]}: ${target.error.message}`;
    const res = target.resource;
    if (res.kind === 'unknown') return `${request[2]} is not an API resource (the API lives under /restconf)`;
    if (res.kind === 'data') {
      const r = resolveYangPath(res.path);
      if (!r.ok) return `${request[2]}: ${r.error.message}`;
    } else if (res.kind === 'operations' && res.path.length > 0) {
      const r = resolveYangOperation(res.path);
      if (!r.ok) return `${request[2]}: ${r.error.message}`;
    } else if (method !== 'GET' && method !== 'HEAD') {
      return `${method} ${request[2]}: only data and operations can be written`;
    }
  }
  for (const h of headers) if (!/^[A-Za-z][A-Za-z0-9-]*: \S.*$/.test(h)) return `"${h}" is not a header line`;
  if (body !== '') {
    try {
      JSON.parse(body);
    } catch (e) {
      return `the body is not JSON: ${(e as Error).message}`;
    }
  }
  return undefined;
}

/** Why a fenced block with an info string does not parse with its language's parser, or undefined. */
function dataProblem(block: FencedBlock): string | undefined {
  // the lab markdown reads the language in any case (`fenceLang`), and only a single known word
  const lang = block.info.toLowerCase();
  if (!(FENCE_LANGS as readonly string[]).includes(lang)) {
    return `the fence language "${block.info}" is not one the lab markdown labels (${FENCE_LANGS.join(', ')})`;
  }
  switch (lang as FenceLang) {
    case 'json':
      try {
        JSON.parse(block.text);
        return undefined;
      } catch (e) {
        return `json: ${(e as Error).message}`;
      }
    case 'yaml': {
      const r = parseYaml(block.text);
      return r.ok ? undefined : `yaml: line ${r.error.line}: ${r.error.message}`;
    }
    case 'xml': {
      const r = parseXml(block.text);
      return r.ok ? undefined : `xml: line ${r.error.line}: ${r.error.message}`;
    }
    case 'http':
      return httpProblem(block.text);
    case 'python': {
      const r = parsePy(block.text);
      return r.ok ? undefined : `python: line ${r.error.line}: ${r.error.type}: ${r.error.message}`;
    }
    case 'text':
      return undefined;
  }
}

// ── the models a lesson names, and the parser contexts they offer ──────────

/** One device kind a lesson's commands may be typed on: a catalog type and the modules installed in it. */
interface LessonModel {
  readonly type: string;
  readonly modules: readonly ModuleInstall[];
}

const modelKey = (m: LessonModel): string => `${m.type}|${m.modules.map((i) => `${i.slot}=${i.module}`).join(',')}`;

/** The devices of a lab's topology (type and modules, once each), or undefined when no lab has that name. */
function labModels(name: string): LessonModel[] | undefined {
  const lab = SCENARIOS.find((s) => s.name === name);
  if (lab === undefined) return undefined;
  const out = new Map<string, LessonModel>();
  for (const d of lab.build().devices) {
    const m: LessonModel = { type: d.type, modules: [...(d.modules ?? [])] };
    out.set(modelKey(m), m);
  }
  return [...out.values()];
}

/** Rules 1–3: the models a lesson's commands are typed on, or an explanation of why there are none. */
function modelsOf(lesson: Lesson, body: string): { models: LessonModel[] } | { error: string } {
  const out = new Map<string, LessonModel>();
  const add = (m: LessonModel): void => {
    out.set(modelKey(m), m);
  };
  const source = lesson.lab ?? LABLESS_MODELS[lesson.id];
  if (typeof source === 'string') {
    const fromLab = labModels(source);
    if (fromLab === undefined) return { error: `${lesson.id} relies on lab ${source}, which is not in SCENARIOS` };
    fromLab.forEach(add);
  } else if (source !== undefined) {
    for (const type of source) add({ type, modules: [] });
  }
  for (const [name] of body.matchAll(MODEL_NAME)) {
    const named = ALL_MODELS.find((m) => m.model === name);
    if (named !== undefined) add({ type: named.type, modules: [] });
  }
  if (out.size === 0) return { error: `${lesson.id} names no model: attach a lab, add it to LABLESS_MODELS, or name an NF-… model in its body` };
  return { models: [...out.values()] };
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

/** Every parser context a learner can type a line in on a lesson model (never the login prompt). */
function contextsOf(m: LessonModel, body: string): MatchContext[] {
  const model = catalogModel(m.type);
  const ports = devicePortViews(model, { modules: m.modules });
  for (const view of namedVirtualPorts(model, ports, body)) ports.set(view.id, view);
  const grammar = model.cli?.grammar ?? 'nfos';
  const out: MatchContext[] = [];
  for (const def of allModes()) {
    if (def.class === 'auth' || !modeInGrammar(def.name, grammar)) continue;
    if (def.contextKey === 'interface') {
      for (const view of interfaceVariants(ports)) out.push(matchContextFor(model, def.name, { ports, ifaceView: view, modules: m.modules }));
    } else {
      out.push(matchContextFor(model, def.name, { ports, modules: m.modules }));
    }
  }
  return out;
}

/** Whether `line` parses in one of `contexts`. */
function parsesIn(contexts: readonly MatchContext[], line: string): boolean {
  return contexts.some((ctx) => matchCommand(GRAMMAR, ctx, line).ok);
}

/** Words of a text: whitespace-separated runs that hold at least one letter or digit. */
function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

const lessonById = (id: string): Lesson => {
  const l = lessons().find((x) => x.id === id);
  if (l === undefined) throw new Error(`no lesson ${id}`);
  return l;
};

// ── the rules themselves ─────────────────────────────────────────────────────

describe('the rules this file applies', () => {
  const keywords = commandKeywords();

  it('tells commands from values by their first keyword', () => {
    for (const cmd of ['router ospf 1', 'no shutdown', 'do show ip route', 'show ip ospf neighbor', 'network 10.0.0.0 0.255.255.255 area 0', 'ip ospf cost 10', 'debug eigrp fsm']) {
      expect(isCommand(cmd, keywords), cmd).toBe(true);
    }
    for (const value of ['O*E2', '10.0.0.0/8', 'FULL/DR', 'GigabitEthernet0/1', '2WAY/DROTHER', '224.0.0.5', 'no']) {
      expect(isCommand(value, keywords), value).toBe(false);
    }
  });

  it('reads inline spans in the prose, plain fences as CLI and labelled fences as data', () => {
    const body = [
      'Type `router ospf 1`, then read the code `O*E2`.',
      '',
      '```',
      'router ospf 1',
      ' network 10.0.0.0 0.255.255.255 area 0',
      '```',
      '',
      '```json',
      '{"a": "`show version`"}',
      '```',
      'After it, `show ip route`.',
    ].join('\n');
    const code = codeOf(body);
    expect(code.unclosed).toBe(false);
    expect(code.blocks.map((b) => b.info)).toEqual(['', 'json']);
    expect(cliLinesOf(code, keywords)).toEqual(['router ospf 1', 'show ip route', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0']);
    expect(code.prose).not.toMatch(/`/);
    expect(codeOf('```\nshow ip route').unclosed).toBe(true);
  });

  it('checks each data language with its own parser, and refuses a language the markdown does not label', () => {
    expect(dataProblem({ info: 'json', text: '{"name": "Vlan10", "enabled": true}' })).toBeUndefined();
    expect(dataProblem({ info: 'json', text: '{"name": "Vlan10",}' })).toMatch(/^json: /);
    expect(dataProblem({ info: 'yaml', text: 'name: Vlan10\nenabled: true' })).toBeUndefined();
    expect(dataProblem({ info: 'xml', text: '<interface><name>Vlan10</name></interface>' })).toBeUndefined();
    expect(dataProblem({ info: 'xml', text: '<interface><name>Vlan10</interface>' })).toMatch(/^xml: /);
    expect(dataProblem({ info: 'python', text: 'for port in ports:\n    print(port)' })).toBeUndefined();
    expect(dataProblem({ info: 'python', text: 'for port in ports\n    print(port)' })).toMatch(/^python: /);
    expect(dataProblem({ info: 'text', text: 'anything at all <b>' })).toBeUndefined();
    expect(dataProblem({ info: 'JSON', text: '[1, 2]' }), 'the markdown reads the language in any case').toBeUndefined();
    expect(dataProblem({ info: 'console', text: 'R1# show ip route' })).toMatch(/not one the lab markdown labels/);
  });

  it('checks an http block against the simulated RESTCONF routes', () => {
    expect(httpProblem('GET /restconf/data/ietf-interfaces:interfaces HTTP/1.1\nAccept: application/yang-data+json')).toBeUndefined();
    expect(httpProblem('GET /restconf HTTP/1.1')).toBeUndefined();
    expect(httpProblem('HTTP/1.1 200 OK\nContent-Type: application/yang-data+json\n\n{"x": 1}')).toBeUndefined();
    expect(httpProblem('GET /restconf/data/ietf-interfaces:nothing-here HTTP/1.1')).toBeDefined();
    expect(httpProblem('GET /api/v1/interfaces HTTP/1.1')).toMatch(/not an API resource/);
    expect(httpProblem('TRACE /restconf HTTP/1.1')).toMatch(/does not answer TRACE/);
    expect(httpProblem('HTTP/1.1 200 Fine')).toMatch(/reason/);
    expect(httpProblem('PUT /restconf/data/ietf-interfaces:interfaces HTTP/1.1\nContent-Type: application/yang-data+json\n\n{not json}')).toMatch(/not JSON/);
  });

  it('checks a command against the lesson models, not against every device', () => {
    const pc = contextsOf({ type: PC, modules: [] }, '');
    const router = contextsOf({ type: ROUTER, modules: [] }, '');
    const sw = contextsOf({ type: SWITCH, modules: [] }, '');
    expect(parsesIn(router, 'router ospf 1')).toBe(true);
    expect(parsesIn(router, 'network 10.0.0.0 0.255.255.255 area 0')).toBe(true);
    expect(parsesIn(router, 'ip ospf priority 0')).toBe(true);
    expect(parsesIn(router, 'ip ospf')).toBe(false);
    expect(parsesIn(sw, 'router ospf 1')).toBe(false);
    expect(parsesIn(pc, 'router ospf 1')).toBe(false);
    expect(parsesIn(pc, 'ipconfig /all')).toBe(true);
  });

  it('lets a lesson use the module ports its lab installs, and the virtual interfaces it names', () => {
    const plain = contextsOf({ type: 'router.nf4331', modules: [] }, '');
    const withNim = contextsOf({ type: 'router.nf4331', modules: [{ slot: '0/1', module: 'mod.nim-2ge' }] }, '');
    expect(parsesIn(plain, 'interface GigabitEthernet0/1/0')).toBe(false);
    expect(parsesIn(withNim, 'interface GigabitEthernet0/1/0')).toBe(true);
    const router = { type: ROUTER, modules: [] };
    expect(parsesIn(contextsOf(router, ''), 'show interfaces Loopback0')).toBe(false);
    expect(parsesIn(contextsOf(router, 'Create `interface Loopback0` first.'), 'show interfaces Loopback0')).toBe(true);
  });

  it('takes the models from the lab, the lab-less map and the model names in the body', () => {
    const types = (r: ReturnType<typeof modelsOf>): string[] => ('models' in r ? [...new Set(r.models.map((m) => m.type))].sort() : []);
    expect(types(modelsOf(lessonById('ccna3-03-neighbours-and-the-designated-router'), ''))).toEqual([PC, ROUTER, SWITCH].sort());
    const eigrp = modelsOf(lessonById('ccna3-10-eigrp-and-its-metric'), '');
    expect('models' in eigrp && eigrp.models.some((m) => m.type === 'router.nf4331' && m.modules.length === 1)).toBe(true);
    expect(types(modelsOf(lessonById('ccna3-11-the-language-of-security'), ''))).toEqual([PC, ROUTER, SWITCH].sort());
    expect(types(modelsOf(lessonById('ccna3-11-the-language-of-security'), 'on an **NF-C3650-24**'))).toEqual([MLSWITCH, PC, ROUTER, SWITCH].sort());
    // a lab-less lesson that names a lab takes that lab's devices, a CCNA 2 lab included
    expect(types(modelsOf(lessonById('ccna3-09-ospf-for-ipv6'), ''))).toEqual([PC, ROUTER].sort());
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

describe('CCNA 3 lesson code agrees with the engine and the attached lab (§11.3)', () => {
  it('has a body only for lessons of the skeleton, and the parts never write the same lesson', () => {
    const ids = new Set(lessons().map((l) => l.id));
    expect(Object.keys(CCNA3_THEORY).filter((id) => !ids.has(id))).toEqual([]);
    const parts = [CCNA3_THEORY_A, CCNA3_THEORY_B, CCNA3_THEORY_C, CCNA3_THEORY_D].map((p) => Object.keys(p));
    const all = parts.flat();
    expect(all.filter((id, i) => all.indexOf(id) !== i), 'a lesson written in two parts').toEqual([]);
    expect(Object.keys(CCNA3_THEORY).sort()).toEqual([...all].sort());
  });

  it('closes every fence', () => {
    const open = writtenLessons()
      .filter(({ body }) => codeOf(body).unclosed)
      .map(({ lesson }) => lesson.id);
    expect(open).toEqual([]);
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
      const contexts = models.models.flatMap((m) => contextsOf(m, body));
      for (const cmd of new Set(cliLinesOf(codeOf(body), keywords))) {
        checked += 1;
        if (!parsesIn(contexts, cmd)) wrong.push(`${lesson.id} :: ${cmd}   (models: ${models.models.map(modelKey).join(', ')})`);
      }
    }
    expect(wrong, `commands a learner could not type on the lesson's models (output belongs in a \`\`\`text fence):\n${wrong.join('\n')}`).toEqual([]);
    if (writtenLessons().length > 0) expect(checked, 'no command was found in any written lesson').toBeGreaterThan(0);
  });

  it('labels every other fenced block with a language whose parser accepts it', () => {
    const wrong: string[] = [];
    for (const { lesson, body } of writtenLessons()) {
      for (const block of codeOf(body).blocks) {
        if (block.info === '') continue;
        const problem = dataProblem(block);
        if (problem !== undefined) wrong.push(`${lesson.id} :: ${problem}`);
      }
    }
    expect(wrong, `data samples that do not parse:\n${wrong.join('\n')}`).toEqual([]);
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

describe('CCNA 3 bodies keep the course content rules (§11.3)', () => {
  it('gives every body the five sections in order and no other heading', () => {
    for (const { lesson, body } of writtenLessons()) {
      const headings = codeOf(body)
        .prose.split('\n')
        .filter((line) => line.startsWith('#'));
      expect(headings, lesson.id).toEqual(SECTIONS);
      expect(body.startsWith(SECTIONS[0]!), lesson.id).toBe(true);
      expect(body, lesson.id).toBe(body.trim());
    }
  });

  it('keeps the prose inside the markdown subset: allowed links only, no raw markup, images or entities', () => {
    for (const { lesson, body } of writtenLessons()) {
      expect(body.length, `${lesson.id}: the lab markdown drops what lies beyond ${MARKDOWN_MAX_CHARS} characters`).toBeLessThanOrEqual(MARKDOWN_MAX_CHARS);
      const prose = codeOf(body).prose;
      expect(prose, lesson.id).not.toMatch(/[<>]/);
      expect(prose, lesson.id).not.toMatch(/http:\/\//i);
      expect(prose, lesson.id).not.toMatch(/!\[/);
      expect(prose, lesson.id).not.toMatch(/&[a-z]+;/i);
      for (const m of prose.matchAll(LINK)) {
        const target = m[1] ?? '';
        const concept = target.startsWith('concept:') && Object.hasOwn(CONCEPT_TOOLS, target.slice('concept:'.length));
        expect(concept || HTTPS_TARGET.test(target), `${lesson.id}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('names no vendor, controller product or certification programme, in prose or code', () => {
    for (const { lesson, body } of writtenLessons()) expect(body, lesson.id).not.toMatch(VENDORS);
  });

  it('fits each body in its lesson minutes at 238 words a minute (the 45-minute cap holds on the skeleton)', () => {
    for (const { lesson, body } of writtenLessons()) {
      const n = words(body);
      expect(n / WORDS_PER_MINUTE, `${lesson.id}: ${n} words`).toBeLessThanOrEqual(lesson.estimatedMinutes);
      expect(lesson.estimatedMinutes, lesson.id).toBeLessThanOrEqual(45);
    }
  });
});

/**
 * §11.3 for modules 1-4 (theory-a): what the OSPF and EIGRP lessons must tell the learner. The OSPF lessons state the
 * listed deviations a learner can notice (§12.2 R2 (1), (6), (22)); the theory-only lessons say what NetForge does not
 * build ([S4] areas, [S6] OSPF for IPv6) and never link to a lab that does not exist; lesson 10 says EIGRP has left the
 * current exam blueprint and that `D` is EIGRP except a `D*` default at distance 254, which DHCP installed (D11).
 *
 * The W6a review pins (each failed on the first draft): which links elect a DR (03), when a DR originates a network LSA
 * (04, checked against the engine's `networkLsaBody`), how long routes take after an adjacency on a link already up
 * (06, 07, from the engine's SPF delay and hold), what `show ip protocols` lists as OSPF sources (01), the EIGRP
 * neighbour table of objective CCNA3.eigrp.1 (10), and the CCNA 2 body length (250-500 words) the trims keep.
 */
describe('what the module 1-4 lessons say plainly (§11.3)', () => {
  const body = (id: string): string => CCNA3_THEORY_A[id] ?? '';
  /** The text of one `## heading` section of a body, up to the next heading. */
  const sectionOf = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}\n`);
    if (start < 0) return '';
    const next = text.indexOf('\n## ', start + 3);
    return text.slice(start, next < 0 ? undefined : next);
  };
  const ospfLessons = [
    'ccna3-02-how-ospf-maps-a-network',
    'ccna3-03-neighbours-and-the-designated-router',
    'ccna3-04-switching-ospf-on',
    'ccna3-05-cost-and-the-best-path',
    'ccna3-06-default-routes-and-timers',
    'ccna3-07-fixing-ospf',
  ];
  const allOspf = (): string => ospfLessons.map(body).join('\n');

  it('writes all ten lessons of modules 1-4, in teaching order, and nothing else', () => {
    const ids = CCNA3_MODULES.slice(0, 4).flatMap((m) => m.lessons.map((l) => l.id));
    expect(ids).toHaveLength(10);
    expect(Object.keys(CCNA3_THEORY_A)).toEqual(ids);
  });

  it('states the OSPF deviations a learner can notice', () => {
    // (1) the hello reply one second after a new neighbour is heard
    expect(allOspf()).toMatch(/one second after/i);
    // (22) the extra hello when an interface's DR or BDR changes
    expect(body('ccna3-03-neighbours-and-the-designated-router')).toMatch(/extra hello/i);
    // (6) serial cost from 1544 kb/s while `show interfaces` shows the clock rate
    const cost = body('ccna3-05-cost-and-the-best-path');
    expect(cost).toMatch(/1544 kb\/s/);
    expect(cost).toMatch(/`show interfaces Serial0\/0\/0`[^.]*clock rate/);
  });

  it('says what the theory-only lessons of module 3 cannot show, and names no lab for them', () => {
    expect(body('ccna3-08-more-than-one-area')).toMatch(/NetForge does not build area border routers yet/);
    expect(body('ccna3-09-ospf-for-ipv6')).toMatch(/NetForge does not run OSPF for IPv6 yet/);
    for (const id of ['ccna3-08-more-than-one-area', 'ccna3-09-ospf-for-ipv6']) expect(lessonById(id).lab, id).toBeUndefined();
  });

  it('says in lesson 10 that EIGRP left the exam blueprint, and what D and D* mean', () => {
    const l10 = body('ccna3-10-eigrp-and-its-metric');
    expect(l10).toMatch(/no longer on the current exam blueprint/);
    expect(l10).toMatch(/`D\*`[^.]*distance 254[^.]*DHCP/);
  });

  it('points each lesson with a lab at it by the title the Labs tab shows', () => {
    for (const id of Object.keys(CCNA3_THEORY_A)) {
      const lab = lessonById(id).lab;
      if (lab === undefined) continue;
      const title = SCENARIOS.find((s) => s.name === lab)?.title;
      expect(title, `${id}: lab ${lab}`).toBeDefined();
      expect(body(id), id).toContain(`**${title ?? ''}**`);
    }
  });

  it('keeps every module 1-4 body within the CCNA 2 length (250-500 words)', () => {
    for (const [id, text] of Object.entries(CCNA3_THEORY_A)) {
      const n = words(text);
      expect(n, `${id}: ${n} words`).toBeGreaterThanOrEqual(250);
      expect(n, `${id}: ${n} words`).toBeLessThanOrEqual(500);
    }
  });

  it('says in lesson 03 that a point-to-point link elects nobody and an Ethernet link elects even with two routers', () => {
    const idea = sectionOf(body('ccna3-03-neighbours-and-the-designated-router'), 'The idea in one breath');
    expect(idea).not.toBe('');
    // OSPF picks the network type from the medium, not from how many routers the link holds
    expect(idea).not.toMatch(/two routers elects nobody/);
    expect(idea).toMatch(/point-to-point link[^.;]*elects nobody/);
    expect(idea).toMatch(/Ethernet link elects[^.;]*only two routers/);
  });

  it('gives in lesson 04 the rule a DR follows for its network LSA, the engine\'s own', () => {
    const l04 = body('ccna3-04-switching-ospf-on');
    expect(l04).not.toMatch(/for each broadcast segment that has a DR/);
    expect(l04).toMatch(/network LSA \(type 2\) from the DR of each segment where it has a Full neighbour/);
    expect(l04).toMatch(/one-router LAN, passive or not, has none/);
    // the engine: a DR alone on its LAN originates none; with one Full neighbour it does
    const lan: OriginIface = {
      port: 'GigabitEthernet0/0',
      area: '0.0.0.0',
      networkType: 'broadcast',
      state: 'dr',
      address: '192.168.3.1',
      prefixLen: 24,
      cost: 1,
      dr: '192.168.3.1',
      fullNeighbors: [],
    };
    expect(networkLsaBody('3.3.3.3', lan)).toBeUndefined();
    expect(networkLsaBody('3.3.3.3', { ...lan, fullNeighbors: [{ routerId: '4.4.4.4', address: '192.168.3.2' }] })).toBeDefined();
  });

  it('quotes the SPF window, 5 to 15 seconds after the neighbours form, for the routes (lessons 02, 06 and 07)', () => {
    // routes follow Full at the next SPF run: OSPF_SPF_DELAY_NS after the change, or later by the hold when one ran just
    // before. Measured: lab 06 13.9 s at boot (R1-R3), 8.9 s after a link bounce, 5.0 s after a hello-interval repair;
    // lab 07 5 to 14 s after a repair. So neither a flat 5 s nor a flat 15 s, and never under 5 s (W6a integration)
    expect(OSPF_SPF_DELAY_NS / SEC).toBe(5);
    expect((OSPF_SPF_DELAY_NS + OSPF_SPF_HOLD_NS) / SEC).toBe(15);
    expect(allOspf()).not.toMatch(/about 15 seconds (?:after the neighbours form|later)/);
    expect(allOspf()).not.toMatch(/about 5 seconds after the neighbours form/);
    expect(allOspf()).not.toMatch(/up to 5 seconds later/);
    expect(body('ccna3-02-how-ospf-maps-a-network')).toMatch(/Full does not mean the routes are in: SPF follows 5 to 15 seconds later/);
    expect(body('ccna3-06-default-routes-and-timers')).toMatch(/routes follow 5 to 15 seconds after the neighbours form, when SPF next runs/);
    expect(body('ccna3-07-fixing-ospf')).toMatch(/routes follow 5 to 15 seconds later, when SPF next runs/);
  });

  it('says in lesson 01 that `show ip protocols` lists every OSPF router whose advertisement is held, not only neighbours', () => {
    const l01 = body('ccna3-01-why-routers-share-routes');
    expect(l01).not.toMatch(/the neighbours it learned from/);
    expect(l01).toMatch(/`show ip protocols`[^.]*routing information sources: for OSPF, every other router whose advertisement it holds, neighbour or not/);
  });

  it('teaches in lesson 10 both tables of objective CCNA3.eigrp.1 with the commands its lab uses', () => {
    const objective = CCNA3_OBJECTIVES.find((o) => o.id === 'CCNA3.eigrp.1');
    expect(objective?.lesson).toBe('ccna3-10-eigrp-and-its-metric');
    const l10 = body('ccna3-10-eigrp-and-its-metric');
    const lab = SCENARIOS.find((s) => s.name === objective?.lab);
    expect(lab, `lab ${objective?.lab ?? '(none)'}`).toBeDefined();
    for (const cmd of ['show ip eigrp neighbors', 'show ip eigrp topology']) {
      expect(lab?.instructions ?? '', `the lab uses ${cmd}`).toContain(`\`${cmd}`);
      expect(l10, `lesson 10 teaches ${cmd}`).toContain(`\`${cmd}\``);
    }
    // what the neighbour table holds: the columns `show ip eigrp neighbors` prints
    expect(l10).toMatch(/`show ip eigrp neighbors` lists[^.]*address[^.]*interface[^.]*hold time[^.]*uptime[^.]*SRTT[^.]*RTO/);
  });
});

describe('what the module 5-8 lessons say plainly (theory-b.ts, W6a review; §11.3)', () => {
  /** A body cut into clauses (at sentence and clause punctuation), so one claim is tested at a time. */
  const clauses = (text: string): string[] =>
    text
      .split(/[.;:\n]/)
      .map((c) => c.trim())
      .filter((c) => c !== '');

  it('never says the brief `show cdp neighbors` lists addresses: the detail form adds them (lesson 12)', () => {
    for (const [id, text] of Object.entries(CCNA3_THEORY_B)) {
      for (const c of clauses(text)) {
        if (!/address/i.test(c) || !c.includes('`show cdp neighbors`')) continue;
        const brief = c.indexOf('`show cdp neighbors`');
        const detail = c.search(/`show cdp (?:neighbors detail|entry)/);
        const addr = c.search(/address/i);
        expect(detail !== -1 && brief < detail && detail < addr, `${id}: "${c}"`).toBe(true);
      }
    }
    expect(CCNA3_THEORY_B['ccna3-12-how-attacks-unfold']).toMatch(/`show cdp neighbors detail` adds their addresses/);
  });

  it('defines dual-homed as two links to the same provider and multihomed as two providers, with the partial mesh (lesson 21)', () => {
    const l21 = CCNA3_THEORY_B['ccna3-21-joining-distant-sites'] ?? '';
    const cs = clauses(l21);
    expect(cs.some((c) => /dual-homed/i.test(c))).toBe(true);
    for (const c of cs.filter((x) => /dual-homed/i.test(x))) {
      expect(c, c).toMatch(/same provider/i);
      expect(c, c).not.toMatch(/(?:two|different) providers/i);
    }
    expect(cs.some((c) => /multihomed/i.test(c) && /(?:two|different) providers/i.test(c))).toBe(true);
    expect(l21).toMatch(/partial mesh/i);
    expect(l21).toMatch(/same trench/);
  });
});
