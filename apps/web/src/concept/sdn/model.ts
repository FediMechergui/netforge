/**
 * [C26] Controller explorer model (ARCHITECTURE-P3C §7 W1b web-concept (a), §8.2 C26, §10.2; lesson 36,
 * CCNA3.automation.8): pure, DOM-free functions behind the controller-based networking concept tool.
 *
 * Five parts:
 *  - **Planes** (`PLANES`, `PLANE_TASKS`, `scorePlanes`): the data, control and management planes, and a set of jobs a
 *    device does to sort into them.
 *  - **Interfaces** (`CONTROLLER_INTERFACES`): what the controller's northbound and southbound interfaces face, and
 *    what typically runs on each.
 *  - **Underlay and overlay** (`SDN_FABRIC`, `overlayStatus`): a small spine-and-leaf fabric whose overlay tunnels are
 *    up only while the underlay still joins their two ends (a breadth-first search over the links that are up).
 *  - **Intent** (`SDN_INTENTS`, `compileIntent`, `assureIntent`, `driftConfig`, `changeEffort`): an outcome stated once
 *    is turned into the lines each device needs; assurance compares what the devices hold against it and names every
 *    device that has drifted; and a change counted box by box against the controller.
 *  - **Quiz** (`sdnQuiz`, `scoreSdnQuiz`): a seeded multiple-choice quiz over the above.
 *
 * The configuration lines are illustrative and in NetForge's own form; no controller product is modelled or named.
 * Every result is also a sentence of text. All wording is original.
 */

// ── planes ──────────────────────────────────────────────────────────────────

export type Plane = 'data' | 'control' | 'management';

export const PLANES: readonly { readonly id: Plane; readonly label: string; readonly does: string; readonly withController: string }[] = Object.freeze([
  {
    id: 'data',
    label: 'Data plane',
    does: 'Forwards each packet or frame, at line rate, usually in hardware.',
    withController: 'Stays on every device: packets are still forwarded by the devices, never by the controller.',
  },
  {
    id: 'control',
    label: 'Control plane',
    does: 'Runs the protocols that build the tables the data plane reads.',
    withController: 'Much of the deciding moves to the controller, which computes paths and policy for the whole network.',
  },
  {
    id: 'management',
    label: 'Management plane',
    does: 'Lets people and tools reach, configure and watch the device.',
    withController: 'Nearly all of it moves to the controller: policy is written once and pushed to every device.',
  },
]);

export interface PlaneTask {
  readonly id: string;
  readonly text: string;
  readonly plane: Plane;
  readonly why: string;
}

/** Jobs a device does, each in one plane. */
export const PLANE_TASKS: readonly PlaneTask[] = Object.freeze([
  { id: 'mac-forward', text: 'Send a frame out of the port its MAC table names', plane: 'data', why: 'Moving a frame is the data plane\'s job.' },
  { id: 'acl-match', text: 'Match a packet against an access list on its way through', plane: 'data', why: 'It is applied to every packet as it is forwarded.' },
  { id: 'nat', text: 'Rewrite a packet\'s source address with NAT', plane: 'data', why: 'The rewrite happens to each packet in flight.' },
  { id: 'tunnel', text: 'Wrap a packet in a tunnel header', plane: 'data', why: 'Encapsulation is done per packet.' },
  { id: 'ospf-hello', text: 'Exchange OSPF hellos with a neighbour', plane: 'control', why: 'Routing protocols build the routing table.' },
  { id: 'spf', text: 'Compute the shortest-path tree after a link fails', plane: 'control', why: 'Deciding the paths is the control plane.' },
  { id: 'stp', text: 'Elect a root bridge and block a redundant port', plane: 'control', why: 'Spanning tree decides which ports forward.' },
  { id: 'arp', text: 'Learn a next hop\'s MAC address with ARP', plane: 'control', why: 'ARP fills a table the data plane then reads.' },
  { id: 'ssh', text: 'Accept an administrator\'s SSH login', plane: 'management', why: 'It is how a person reaches the device.' },
  { id: 'syslog', text: 'Send a log message to a syslog server', plane: 'management', why: 'It reports on the device to the people who run it.' },
  { id: 'snmp', text: 'Answer an SNMP poll for interface counters', plane: 'management', why: 'Monitoring tools watch the device through it.' },
  { id: 'ntp', text: 'Keep the clock in step with NTP', plane: 'management', why: 'Correct time serves logs and management, not forwarding.' },
]);

export interface PlaneScore {
  readonly total: number;
  readonly correct: number;
  readonly results: readonly { readonly id: string; readonly given: Plane | null; readonly expected: Plane; readonly correct: boolean; readonly text: string }[];
  readonly summary: string;
}

const planeLabel = (p: Plane): string => PLANES.find((x) => x.id === p)!.label.toLowerCase();

/** Scores a sorting of `PLANE_TASKS` (a missing task counts as not sorted). */
export function scorePlanes(answers: Readonly<Partial<Record<string, Plane>>>): PlaneScore {
  const results = PLANE_TASKS.map((t) => {
    const given = answers[t.id] ?? null;
    const correct = given === t.plane;
    const text =
      given === null
        ? `Not sorted: "${t.text}" belongs to the ${planeLabel(t.plane)}. ${t.why}`
        : correct
          ? `Right: "${t.text}" is ${planeLabel(t.plane)}. ${t.why}`
          : `"${t.text}" is ${planeLabel(t.plane)}, not ${planeLabel(given)}. ${t.why}`;
    return { id: t.id, given, expected: t.plane, correct, text };
  });
  const correct = results.filter((r) => r.correct).length;
  return { total: results.length, correct, results, summary: `${correct} of ${results.length} jobs in the right plane.` };
}

// ── interfaces ──────────────────────────────────────────────────────────────

export type InterfaceDirection = 'northbound' | 'southbound';

export const CONTROLLER_INTERFACES: readonly { readonly name: string; readonly direction: InterfaceDirection; readonly carries: string }[] = Object.freeze([
  { name: 'REST API with JSON', direction: 'northbound', carries: 'Applications and scripts ask the controller for inventory, health and policy, and send it changes.' },
  { name: 'OpenFlow', direction: 'southbound', carries: 'The controller writes flow entries straight into a switch\'s forwarding tables.' },
  { name: 'NETCONF', direction: 'southbound', carries: 'The controller reads and writes a device\'s configuration as structured data over SSH.' },
  { name: 'RESTCONF', direction: 'southbound', carries: 'The same data models as NETCONF, over HTTPS with JSON or XML.' },
  { name: 'Command line over SSH', direction: 'southbound', carries: 'The controller types configuration into older devices, as a person would.' },
]);

/** The direction of a named interface (null for a name the tool does not know). */
export function interfaceDirection(name: string): InterfaceDirection | null {
  return CONTROLLER_INTERFACES.find((i) => i.name === name)?.direction ?? null;
}

// ── underlay and overlay ────────────────────────────────────────────────────

export interface FabricDevice {
  readonly id: string;
  readonly role: 'spine' | 'edge' | 'border';
}

export interface FabricLink {
  readonly id: string;
  readonly a: string;
  readonly b: string;
}

export interface FabricTunnel {
  readonly id: string;
  readonly a: string;
  readonly b: string;
}

export interface Fabric {
  readonly devices: readonly FabricDevice[];
  /** The underlay: physical links, routed. */
  readonly links: readonly FabricLink[];
  /** The overlay: tunnels between leaf devices. */
  readonly tunnels: readonly FabricTunnel[];
}

const LEAVES = ['B1', 'E1', 'E2', 'E3'] as const;
const SPINES = ['S1', 'S2'] as const;

/** Two spines, three edge leaves and a border leaf; every leaf has a link to each spine. */
export const SDN_FABRIC: Fabric = Object.freeze({
  devices: Object.freeze([
    ...SPINES.map((id) => ({ id, role: 'spine' as const })),
    { id: 'B1', role: 'border' as const },
    ...(['E1', 'E2', 'E3'] as const).map((id) => ({ id, role: 'edge' as const })),
  ]),
  links: Object.freeze(LEAVES.flatMap((l) => SPINES.map((s) => ({ id: `${l}-${s}`, a: l, b: s })))),
  tunnels: Object.freeze([
    { id: 'E1~B1', a: 'E1', b: 'B1' },
    { id: 'E2~B1', a: 'E2', b: 'B1' },
    { id: 'E3~B1', a: 'E3', b: 'B1' },
    { id: 'E1~E2', a: 'E1', b: 'E2' },
  ]),
});

export interface TunnelStatus {
  readonly id: string;
  readonly up: boolean;
  /** The underlay path the tunnel's packets take (fewest hops; ties broken by link order), or null when there is none. */
  readonly path: readonly string[] | null;
  readonly text: string;
}

/** The underlay path from `from` to `to` over the links not in `failed`, or null. */
export function underlayPath(fabric: Fabric, failed: ReadonlySet<string>, from: string, to: string): string[] | null {
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === to) break;
    for (const l of fabric.links) {
      if (failed.has(l.id)) continue;
      const next = l.a === at ? l.b : l.b === at ? l.a : null;
      if (next === null || prev.has(next)) continue;
      prev.set(next, at);
      queue.push(next);
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return path;
}

/** Each overlay tunnel's state with the underlay links in `failed` down. */
export function overlayStatus(fabric: Fabric, failed: readonly string[]): TunnelStatus[] {
  const down = new Set(failed);
  return fabric.tunnels.map((t) => {
    const path = underlayPath(fabric, down, t.a, t.b);
    return {
      id: t.id,
      up: path !== null,
      path,
      text:
        path === null
          ? `Tunnel ${t.a}–${t.b} is down: the underlay no longer joins ${t.a} and ${t.b}.`
          : `Tunnel ${t.a}–${t.b} is up, carried by the underlay along ${path.join(' → ')}.`,
    };
  });
}

// ── intent ──────────────────────────────────────────────────────────────────

export type IntentId = 'guest-internet' | 'voice-first' | 'isolate-cameras';

export interface Intent {
  readonly id: IntentId;
  /** The outcome, as a person states it. */
  readonly outcome: string;
  /** The device roles it touches. */
  readonly roles: readonly FabricDevice['role'][];
  /** The lines each touched device needs. */
  readonly lines: (device: FabricDevice) => readonly string[];
}

const PRIVATE_DENY = [' deny ip any 10.0.0.0 0.255.255.255', ' deny ip any 172.16.0.0 0.15.255.255', ' deny ip any 192.168.0.0 0.0.255.255'];

export const SDN_INTENTS: readonly Intent[] = Object.freeze([
  {
    id: 'guest-internet',
    outcome: 'Guests reach the internet and nothing else.',
    roles: ['edge', 'border'],
    lines: (d) =>
      d.role === 'edge'
        ? ['vlan 40', ' name GUESTS', 'ip access-list extended GUESTS-OUT', ...PRIVATE_DENY, ' permit ip any any']
        : ['ip access-list extended GUESTS-OUT', ...PRIVATE_DENY, ' permit ip 10.40.0.0 0.0.255.255 any'],
  },
  {
    id: 'voice-first',
    outcome: 'Voice calls go first everywhere in the network.',
    roles: ['spine', 'edge', 'border'],
    lines: () => ['class-map match-any VOICE', ' match dscp ef', 'policy-map VOICE-FIRST', ' class VOICE', '  priority percent 30'],
  },
  {
    id: 'isolate-cameras',
    outcome: 'Cameras talk only to the video recorder.',
    roles: ['edge'],
    lines: () => ['vlan 60', ' name CAMERAS', 'ip access-list extended CAMERAS-ONLY', ' permit ip 10.60.0.0 0.0.255.255 host 10.9.0.20', ' deny ip any any'],
  },
]);

export function intent(id: IntentId): Intent {
  const i = SDN_INTENTS.find((x) => x.id === id);
  if (i === undefined) throw new Error(`unknown intent ${id}`);
  return i;
}

export interface DeviceConfig {
  readonly device: string;
  readonly lines: readonly string[];
}

/** The lines the controller pushes for `id`, per touched device, in fabric order. */
export function compileIntent(id: IntentId, fabric: Fabric = SDN_FABRIC): DeviceConfig[] {
  const it = intent(id);
  return fabric.devices.filter((d) => it.roles.includes(d.role)).map((d) => ({ device: d.id, lines: Object.freeze([...it.lines(d)]) }));
}

/** A device edited by hand behind the controller's back: its last intended line removed. */
export function driftConfig(lines: readonly string[]): string[] {
  return lines.slice(0, -1);
}

export interface DeviceAssurance {
  readonly device: string;
  readonly delivered: boolean;
  /** Intended lines the device does not hold. */
  readonly missing: readonly string[];
}

export interface Assurance {
  readonly compliant: boolean;
  readonly devices: readonly DeviceAssurance[];
  readonly text: string;
}

/** Compares what each device holds (`actual`) with what the intent needs; a device not in `actual` holds nothing. */
export function assureIntent(id: IntentId, actual: Readonly<Record<string, readonly string[]>>, fabric: Fabric = SDN_FABRIC): Assurance {
  const devices = compileIntent(id, fabric).map((c) => {
    const held = new Set(actual[c.device] ?? []);
    const missing = c.lines.filter((l) => !held.has(l));
    return { device: c.device, delivered: missing.length === 0, missing };
  });
  const drifted = devices.filter((d) => !d.delivered).map((d) => d.device);
  const outcome = intent(id).outcome.replace(/\.$/, '');
  return {
    compliant: drifted.length === 0,
    devices,
    text:
      drifted.length === 0
        ? `Delivered: every device holds what "${outcome}" needs.`
        : `Not delivered: ${drifted.join(', ')} ${drifted.length === 1 ? 'has' : 'have'} drifted from "${outcome}". Pushing the intent again repairs ${drifted.length === 1 ? 'it' : 'them'}.`,
  };
}

export interface ChangeEffort {
  readonly boxByBox: { readonly sessions: number; readonly lines: number };
  readonly controller: { readonly intents: number; readonly pushes: number };
  readonly text: string;
}

/** One change that needs `lines` lines on each of `devices` devices, done box by box and through a controller. */
export function changeEffort(devices: number, lines: number): ChangeEffort {
  const d = Math.max(0, Math.trunc(devices));
  const l = Math.max(0, Math.trunc(lines));
  return {
    boxByBox: { sessions: d, lines: d * l },
    controller: { intents: d === 0 ? 0 : 1, pushes: d },
    text:
      d === 0
        ? 'No device needs the change.'
        : `Box by box: ${d} login${d === 1 ? '' : 's'} and ${d * l} typed line${d * l === 1 ? '' : 's'}, each a chance to slip. With a controller: one intent, which it pushes to ${d} device${d === 1 ? '' : 's'} and then keeps checking.`,
  };
}

// ── quiz ────────────────────────────────────────────────────────────────────

export type SdnQuizKind = 'plane' | 'interface' | 'concept';

export interface SdnQuizQuestion {
  readonly id: string;
  readonly kind: SdnQuizKind;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly answer: number;
  readonly explanation: string;
}

export interface SdnQuizScore {
  readonly total: number;
  readonly answered: number;
  readonly correct: number;
  readonly percent: number;
  readonly results: readonly { readonly id: string; readonly given: number | null; readonly expected: number; readonly correct: boolean; readonly text: string }[];
  readonly summary: string;
}

const CONCEPTS: readonly { readonly id: string; readonly prompt: string; readonly right: string; readonly wrong: readonly string[]; readonly why: string }[] = [
  {
    id: 'c1',
    prompt: 'A controller loses contact with its switches for a minute. What happens to traffic?',
    right: 'The switches keep forwarding with what they were last told',
    wrong: ['All forwarding stops until the controller returns', 'Every packet is sent to the controller instead', 'The switches erase their tables'],
    why: 'The data plane stays on the devices.',
  },
  {
    id: 'c2',
    prompt: 'Tunnels built across the routed physical network form the…',
    right: 'overlay',
    wrong: ['underlay', 'management plane', 'northbound interface'],
    why: 'The physical network is the underlay; tunnels over it are the overlay; together they make a fabric.',
  },
  {
    id: 'c3',
    prompt: 'Intent-based networking means that you…',
    right: 'state the outcome, and the system configures and keeps checking it',
    wrong: ['type the same commands on every device faster', 'replace every switch with a server', 'move packet forwarding into the controller'],
    why: 'You say what you want; the system turns it into configuration, deploys it and verifies it continuously.',
  },
  {
    id: 'c4',
    prompt: 'An edge leaf loses both links to the spines. What happens to its overlay tunnels?',
    right: 'They go down: the underlay no longer joins their ends',
    wrong: ['They stay up through the controller', 'They move to the management plane', 'Nothing: tunnels do not need the underlay'],
    why: 'An overlay depends on its underlay.',
  },
  {
    id: 'c5',
    prompt: 'What does a controller-based network offer that managing devices one by one does not?',
    right: 'Policy written once and pushed everywhere, with the whole network in one view',
    wrong: ['Faster forwarding of each packet', 'No need for any routing in the underlay', 'Devices that need no configuration at all'],
    why: 'It centralises configuration, policy and visibility, and makes automation the normal way of working.',
  },
];

class QuizRng {
  private s: number;
  constructor(seed: number, salt: number) {
    const v = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    let h = (v ^ Math.imul(salt + 1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    this.s = (h ^ (h >>> 16)) | 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(n: number): number {
    return n <= 0 ? 0 : this.next() % n;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

function make(rng: QuizRng, base: Omit<SdnQuizQuestion, 'options' | 'answer'>, right: string, wrong: readonly string[]): SdnQuizQuestion {
  const distractors = [...new Set(wrong)].filter((w) => w !== right).slice(0, 3);
  const options = rng.shuffle([right, ...distractors]);
  return { ...base, options, answer: options.indexOf(right) };
}

const PLANE_OPTIONS = PLANES.map((p) => p.label);

/** The quiz kinds, in the order a quiz cycles through them. */
export const SDN_QUIZ_KINDS: readonly SdnQuizKind[] = Object.freeze(['plane', 'interface', 'concept']);

/**
 * A quiz of `count` questions for `seed`: kinds cycle in `SDN_QUIZ_KINDS` order and question `i` draws from its own
 * stream of `(seed, i)`. Plane questions keep the three planes in their usual order, data first.
 */
export function sdnQuiz(seed: number, count = 6): SdnQuizQuestion[] {
  const n = Math.max(0, Math.min(40, Math.trunc(count)));
  return Array.from({ length: n }, (_, i) => {
    const rng = new QuizRng(seed, i);
    const kind = SDN_QUIZ_KINDS[i % SDN_QUIZ_KINDS.length]!;
    if (kind === 'plane') {
      const t = PLANE_TASKS[rng.int(PLANE_TASKS.length)]!;
      const right = PLANES.find((p) => p.id === t.plane)!.label;
      return { id: `q${i}-${t.id}`, kind, prompt: `Which plane does this job? ${t.text}.`, options: PLANE_OPTIONS, answer: PLANE_OPTIONS.indexOf(right), explanation: t.why };
    }
    if (kind === 'interface') {
      const f = CONTROLLER_INTERFACES[rng.int(CONTROLLER_INTERFACES.length)]!;
      const options = ['Northbound: toward applications', 'Southbound: toward devices'];
      return {
        id: `q${i}-${f.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        kind,
        prompt: `Which way does ${f.name} face from the controller?`,
        options,
        answer: f.direction === 'northbound' ? 0 : 1,
        explanation: f.carries,
      };
    }
    const c = CONCEPTS[rng.int(CONCEPTS.length)]!;
    return make(rng, { id: `q${i}-${c.id}`, kind, prompt: c.prompt, explanation: c.why }, c.right, c.wrong);
  });
}

/** Scores `answers` (an option index per question; null, missing or out of range counts as not right). */
export function scoreSdnQuiz(quiz: readonly SdnQuizQuestion[], answers: readonly (number | null | undefined)[]): SdnQuizScore {
  const results = quiz.map((q, i) => {
    const raw = answers[i];
    const given = raw === undefined || raw === null || !Number.isInteger(raw) ? null : raw;
    const correct = given === q.answer;
    const right = q.options[q.answer]!;
    const text =
      given === null ? `Skipped. The answer is: ${right}. ${q.explanation}` : correct ? `Right: ${right}. ${q.explanation}` : `Not this one: the answer is ${right}. ${q.explanation}`;
    return { id: q.id, given, expected: q.answer, correct, text };
  });
  const correct = results.filter((r) => r.correct).length;
  const answered = results.filter((r) => r.given !== null).length;
  const total = quiz.length;
  const percent = total === 0 ? 0 : Math.round((100 * correct) / total);
  const summary = total === 0 ? 'There are no questions.' : `${correct} of ${total} right (${percent} %)${answered < total ? `, ${total - answered} skipped` : ''}.`;
  return { total, answered, correct, percent, results, summary };
}
