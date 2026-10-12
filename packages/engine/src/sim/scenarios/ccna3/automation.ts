/**
 * sim/scenarios/ccna3/automation.ts — the CCNA 3 automation labs (ARCHITECTURE-P3 §11.1 module 14 "Automating the
 * network", §11.2, §3.8, §5.6, D21, D22; owner auto, W6).
 *
 *   • `ccna3-restconf-change` — lesson 38 "Talking to devices through APIs" (§3.8): three switches in a line (SW1–SW2–SW3,
 *     802.1Q trunks carrying the management VLAN 99) answer the RESTCONF API on HTTPS — each starts with a privilege-15
 *     local user, `ip http secure-server`, `ip http authentication local` and `restconf`, the lines that wake a
 *     managed switch's transport (D22) — and PC1, the management station on VLAN 99, talks to them with the host
 *     shell's `rest` command. The learner (1) reads SW2's interfaces as RFC 7951 JSON with a `rest GET` (the JSON
 *     reading tasks lesson 37 used to carry, §11.1), (2) acts on the note found in that JSON — SW2's
 *     `GigabitEthernet0/2` carries the description `RESTCONF_LAB_NOTE`, which asks for VLAN 40 named FINANCE on SW3 —
 *     and (3) creates VLAN 30 named VOICE on every switch with a `rest PUT` to its `nf-native` VLAN-list entry.
 *
 * A P3-profile world (`topology(…, { profile: 'P3' })`, schema 1.3). The lesson is not about spanning tree: PC1's port
 * is an edge port (`spanning-tree portfast`, §11.2); the trunks between the switches are not, so they forward 30 s
 * after the switches have booted, and the instructions say so. Tasks read structured state only, live (§2.10, rule
 * 20; no clone, no replay of a request): the request by the `restconf-log` rows the API wrote (`table` with
 * `whereOps`), the effect by the `vlan` kind. The read task asks for a GET answered `200` (a GET refused `401` for want
 * of credentials leaves a row too, and reads nothing), and the API task for a PUT to the path of VLAN 30's entry,
 * `/restconf/data/nf-native:native/vlan/vlan-list=30` matched whole, answered `201` or `204` (`status le 204`) on each
 * switch, so a VLAN typed on a console, a POST, a PUT the API refused, or a PUT to another entry (`vlan-list=300`) does
 * not count.
 *
 * The learner's requests are host-shell `rest` lines, i.e. CLI jobs journaled as `cliExec`: `Simulation.configure`
 * refuses a job, so the reference `solution` cannot hold them. The lab gives them as data instead,
 * `RESTCONF_LAB_REQUESTS` (the shape of lab 15's `ACL_STANDARD_LOGINS` and lab 27's `QOS_LEARNER_FLOWS`: the console
 * lines a solutions test types on each host after the solution), and the `solution` holds what a console can do: the
 * change the note asks for, typed on SW3 (the instructions allow the console or a PUT for it; the grader reads only
 * the effect). Every request line is printed in the instructions as a learner types it. Addresses and names are
 * §3.8's; the password is a lab value; all wording is original (§0 rule 6) and the YANG paths use IETF modules and
 * `nf-native` only (§11.3).
 *
 * Lab 40 `ccna3-script-inventory` ([S32]) joins `CCNA3_AUTOMATION_LABS` in the step after the NF-DEVHOST catalog flip
 * (§7 W6, rule 14's order); `ccna3/index.ts` already lists it in `CCNA3_LAB_ORDER`.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` (rule 12: the catalogue reads the arrays at
 * module scope, so no lab file may import it back). Every exported name carries a `RESTCONF_LAB_`, `restconfLab`,
 * `ccna3Restconf` or `CCNA3_AUTOMATION_` prefix, since `ccna3/index.ts` re-exports every lab file with `export *`.
 */
import type { LabAssertion, ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, SWITCH, accessPort, configText, device, link, section, topology, trunkPort, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

// ── lab 38: a VLAN change through RESTCONF ──────────────────────────────────

/** §3.8's addresses: PC1 and the three management SVIs (Vlan99) of SW1, SW2 and SW3. */
export const RESTCONF_LAB_ADDRESSES = Object.freeze({ pc1: '10.0.99.10', sw1: '10.0.99.11', sw2: '10.0.99.12', sw3: '10.0.99.13' });
/** The management VLAN the trunks carry and PC1's port belongs to. */
export const RESTCONF_LAB_MGMT_VLAN = 99;
/** The privilege-15 local user every switch checks API logins against, and its password (a lab value, printed). */
export const RESTCONF_LAB_USER = 'admin';
export const RESTCONF_LAB_SECRET = 'Api-Lab38';
/** The media type of a RESTCONF JSON body (RFC 8040), which a write must name in its Content-Type header. */
export const RESTCONF_LAB_JSON_TYPE = 'application/yang-data+json';
/** The VLAN the learner creates on every switch through the API. */
export const RESTCONF_LAB_VLAN = Object.freeze({ id: 30, name: 'VOICE' });
/** The note on SW2's `GigabitEthernet0/2` the learner reads in the JSON of a GET (§3.8, original text) … */
export const RESTCONF_LAB_NOTE = 'uplink - add vlan 40 NAME FINANCE on SW3';
/** … and the change it asks for. */
export const RESTCONF_LAB_NOTE_VLAN = Object.freeze({ device: 'SW3', id: 40, name: 'FINANCE' });

/** The base URL of a switch's RESTCONF data resources. */
const dataUrl = (address: string): string => `https://${address}/restconf/data`;
/** The credentials and the JSON content type of every write. */
const CREDENTIALS = `-u ${RESTCONF_LAB_USER}:${RESTCONF_LAB_SECRET}`;
const JSON_HEADER = `-H "Content-Type: ${RESTCONF_LAB_JSON_TYPE}"`;

/** `rest GET` of a switch's interfaces in the `ietf-interfaces` model (the read of step 1). */
export function restconfLabGetInterfaces(address: string): string {
  return `rest GET ${dataUrl(address)}/ietf-interfaces:interfaces ${CREDENTIALS}`;
}

/**
 * The request path of VLAN `id`'s entry in the `nf-native` VLAN list: what the PUT of step 3 names and, the query
 * removed, what a switch's `restconf-log` row keeps as written (automation/yang/path.ts).
 */
const vlanEntryPath = (id: number): string => `/restconf/data/nf-native:native/vlan/vlan-list=${id}`;

/** `rest PUT` of VLAN `id` named `name` to a switch's `nf-native` VLAN-list entry (the write of step 3). */
export function restconfLabPutVlan(address: string, id: number = RESTCONF_LAB_VLAN.id, name: string = RESTCONF_LAB_VLAN.name): string {
  return `rest PUT https://${address}${vlanEntryPath(id)} ${CREDENTIALS} ${JSON_HEADER} -d {"nf-native:vlan-list":[{"id":${id},"name":"${name}"}]}`;
}

const A = RESTCONF_LAB_ADDRESSES;

/**
 * @since P3 The requests lab 38 asks the learner to send from PC1 before Check, as the lines typed on PC1's console:
 * the GET of SW2's interfaces, then the PUT of VLAN 30 to each switch. Each `rest` line is a CLI job (journaled as
 * `cliExec`), which `Simulation.configure` refuses, so the reference solution cannot hold them (module header).
 */
export const RESTCONF_LAB_REQUESTS: readonly { readonly from: string; readonly lines: readonly string[] }[] = Object.freeze([
  Object.freeze({
    from: 'PC1',
    lines: Object.freeze([restconfLabGetInterfaces(A.sw2), restconfLabPutVlan(A.sw1), restconfLabPutVlan(A.sw2), restconfLabPutVlan(A.sw3)]),
  }),
]);

/** One switch of the line: the API service lines, the management VLAN and SVI, its trunks and (SW1) PC1's edge port. */
function restconfSwitchConfig(name: string, address: string, ports: readonly (readonly string[])[]): string {
  return configText([
    [`hostname ${name}`],
    [`username ${RESTCONF_LAB_USER} privilege 15 secret ${RESTCONF_LAB_SECRET}`],
    ['ip http secure-server'],
    ['ip http authentication local'],
    ['restconf'],
    ...vlanSections([{ id: RESTCONF_LAB_MGMT_VLAN, name: 'MGMT' }]),
    ...ports,
    section(`interface Vlan${RESTCONF_LAB_MGMT_VLAN}`, [`ip address ${address} ${MASK24}`, 'no shutdown']),
  ]);
}

/** SW1: PC1's edge port in VLAN 99 and the trunk toward SW2. */
function restconfSw1Config(): string {
  return restconfSwitchConfig('SW1', A.sw1, [accessPort('FastEthernet0/1', RESTCONF_LAB_MGMT_VLAN, { portfast: true }), trunkPort('GigabitEthernet0/2')]);
}

/** SW2: the trunk toward SW1, and the trunk toward SW3 carrying the note. */
function restconfSw2Config(): string {
  return restconfSwitchConfig('SW2', A.sw2, [
    section('interface GigabitEthernet0/1', ['description trunk to SW1', 'switchport mode trunk']),
    section('interface GigabitEthernet0/2', [`description ${RESTCONF_LAB_NOTE}`, 'switchport mode trunk']),
  ]);
}

/** SW3: the trunk toward SW2. */
function restconfSw3Config(): string {
  return restconfSwitchConfig('SW3', A.sw3, [trunkPort('GigabitEthernet0/1')]);
}

/**
 * The API task's read of one switch's `restconf-log`: a PUT to VLAN 30's entry that the API accepted (201 or 204). The
 * path is matched whole (`where`, equality), never as a substring: `contains 'vlan-list=30'` would also take an accepted
 * PUT to `vlan-list=300` (or 301–309, 3000–3099), which never touches VLAN 30.
 */
function putLogged(device: string): LabAssertion {
  return {
    kind: 'table',
    device,
    table: 'restconf-log',
    where: { method: 'PUT', path: vlanEntryPath(RESTCONF_LAB_VLAN.id) },
    whereOps: { status: { op: 'le', value: 204 } },
    exists: true,
    feedback: `${device} has answered no PUT to vlan-list=${RESTCONF_LAB_VLAN.id} with 201 or 204: send the PUT of step 3 to its address and read the status line it prints.`,
  };
}

/** The effect: VLAN 30 named VOICE on one switch. */
function vlan30On(device: string): LabAssertion {
  return {
    kind: 'vlan',
    device,
    vlan: RESTCONF_LAB_VLAN.id,
    name: RESTCONF_LAB_VLAN.name,
    feedback: `${device} needs VLAN ${RESTCONF_LAB_VLAN.id} named ${RESTCONF_LAB_VLAN.name}, exactly as written (names are case-sensitive).`,
  };
}

/** Lab 38: read a switch's interfaces as JSON, act on a value found there, and change a VLAN through RESTCONF. */
export const ccna3RestconfChange: ScenarioInfo = {
  name: 'ccna3-restconf-change',
  category: 'ccna3-lab',
  labType: 'guided',
  course: 'CCNA 3',
  topic: 'Automating the network',
  title: 'A VLAN change through RESTCONF',
  description:
    'Three switches answer a RESTCONF API over HTTPS. From the management PC, read a switch\'s interfaces as JSON, act on a note you find in them, then create a VLAN on every switch with PUT requests, reading the status code of every answer.',
  objectives: [
    'Send a REST request with a verb, a URI, credentials and headers, and read the status code of the answer',
    'Read a device\'s interfaces as JSON in an IETF YANG model and find one value in the document',
    'Create a VLAN through RESTCONF with a PUT, and tell 201 and 204 from the 4xx refusals',
    'Confirm an API change on the device and in the log of the requests it answered',
  ],
  tags: ['rest', 'restconf', 'yang', 'json', 'http status codes', 'basic authentication', 'device api'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH],
  seed: 3038,
  instructions: [
    '## What you have',
    '',
    `PC1 (\`${A.pc1}\`) is the management station on VLAN ${RESTCONF_LAB_MGMT_VLAN}. Three switches in a line, SW1, SW2 and SW3, are joined by trunks and managed on VLAN ${RESTCONF_LAB_MGMT_VLAN} at \`${A.sw1}\`, \`${A.sw2}\` and \`${A.sw3}\`. Each one answers the RESTCONF API over HTTPS (TCP 443): \`restconf\` and \`ip http secure-server\` are on, and \`ip http authentication local\` checks every request against the local user \`${RESTCONF_LAB_USER}\` (privilege 15), password \`${RESTCONF_LAB_SECRET}\`.`,
    '',
    "On PC1's command line, `rest` sends one HTTP request and prints the answer: the status line, the headers and the body. `-u user:password` adds the credentials, `-H \"Name: value\"` adds a header, and `-d` comes last: everything typed after it is the body, sent exactly as typed, so a JSON body needs no quotes around it.",
    '',
    '## 1. Read a switch through the API',
    '',
    `- Ask SW2 for its interfaces: \`${restconfLabGetInterfaces(A.sw2)}\`. The answer is \`200 OK\` with a JSON document in the IETF interfaces model: one object per interface, with its \`name\` and \`type\`, and its \`description\` when one is configured.`,
    '- Send the same request without `-u`: the switch answers `401 Unauthorized` and tells you why. Every request is logged on the switch; `show restconf` on its console lists the latest ones with their status codes.',
    '- Somebody left a note in the description of one of SW2\'s interfaces. Find it in the JSON.',
    '',
    '## 2. Act on what you read',
    '',
    '- Do what the note asks, on the switch it names. Type the change on that switch\'s console, or send it through the API with a PUT like the ones of step 3: Check looks at the result, not at how you made it.',
    '',
    '## 3. Change a VLAN through the API',
    '',
    `- Create VLAN ${RESTCONF_LAB_VLAN.id} named ${RESTCONF_LAB_VLAN.name} on SW1 with a PUT to its entry in the VLAN list: \`${restconfLabPutVlan(A.sw1)}\`. A new entry answers \`201 Created\`; the same PUT again answers \`204 No Content\` (nothing to change). The key in the address (\`vlan-list=${RESTCONF_LAB_VLAN.id}\`) must equal the \`id\` in the body, or the switch answers \`400 Bad Request\`; a body sent without the Content-Type header is refused with \`415\`.`,
    `- Send the same PUT to SW2 (\`${A.sw2}\`) and SW3 (\`${A.sw3}\`), then read each change back: a GET of the same address, or \`show vlan brief\` on the switch.`,
    '- Check reads the request log of each switch: a VLAN typed on a console does not count for this step.',
    '',
    '## Timing',
    '',
    'The switches take about 30 s to start, and spanning tree lets their trunks forward 30 s after that, so allow about a minute before the first request. After that every request is answered within a second.',
    '',
    '*TLS is simulated: no handshake bytes cross the wire, and the capture shows the HTTP of each segment decoded under a "Protected (TLS, simulated)" banner.*',
  ].join('\n'),
  build: () =>
    topology(
      3038,
      [
        device('pc1', PC, 'PC1', 150, 260, pcConfig('PC1', A.pc1, MASK24)),
        device('sw1', SWITCH, 'SW1', 370, 260, restconfSw1Config()),
        device('sw2', SWITCH, 'SW2', 590, 260, restconfSw2Config()),
        device('sw3', SWITCH, 'SW3', 810, 260, restconfSw3Config()),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw2_sw3', 'sw2', 'GigabitEthernet0/2', 'sw3', 'GigabitEthernet0/1'),
      ],
      ['Read a switch\'s interfaces as JSON', 'Act on the note you find', 'Create a VLAN on every switch with PUT', 'Read the status codes'],
      'A device API answers structured requests with structured data: the verb says what to do, the URI names the resource in a YANG model, the credentials say who asks, and the status code says what happened.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'read-interfaces',
      title: 'Read SW2\'s interfaces through the API',
      description: 'SW2 has answered a GET of its interfaces (the ietf-interfaces model) with 200 OK.',
      points: 20,
      hint: 'The API needs the credentials of a privilege 15 user: add -u with the user name and the password.',
      assertions: [
        {
          kind: 'table',
          device: 'SW2',
          table: 'restconf-log',
          where: { method: 'GET', status: 200 },
          whereOps: { path: { op: 'contains', value: 'ietf-interfaces' } },
          exists: true,
          feedback: 'SW2 has not answered a GET of its interfaces with 200 OK yet: send the GET of step 1 to SW2, with -u.',
        },
      ],
      feedbackOnFail: 'Every request is logged with its status code: show restconf on SW2 lists them.',
    },
    {
      id: 'act-on-note',
      title: 'Do what the note asks',
      description: 'The change the note in SW2\'s interface descriptions asks for is made, on the switch it names.',
      points: 20,
      dependsOn: ['read-interfaces'],
      hint: 'Look for the description member in the JSON of your GET: one of them is not a usual description.',
      assertions: [
        {
          kind: 'vlan',
          device: RESTCONF_LAB_NOTE_VLAN.device,
          vlan: RESTCONF_LAB_NOTE_VLAN.id,
          name: RESTCONF_LAB_NOTE_VLAN.name,
          feedback: 'Read the description of each of SW2\'s interfaces in the JSON: the note names a VLAN, its name and the switch that needs it.',
          misconception: 'note-applied-where-it-was-read',
        },
      ],
      feedbackOnFail: 'The note was found on SW2, but the change it asks for belongs to another switch.',
    },
    {
      id: 'vlan-30',
      title: `VLAN ${RESTCONF_LAB_VLAN.id} ${RESTCONF_LAB_VLAN.name} on every switch`,
      description: `SW1, SW2 and SW3 each have VLAN ${RESTCONF_LAB_VLAN.id} named ${RESTCONF_LAB_VLAN.name}.`,
      points: 30,
      hint: 'The name travels in the JSON body: "name" holds it exactly as the switch will store it.',
      assertions: [vlan30On('SW1'), vlan30On('SW2'), vlan30On('SW3')],
    },
    {
      id: 'through-the-api',
      title: 'The change came through the API',
      description: `Each switch has accepted a PUT to its vlan-list=${RESTCONF_LAB_VLAN.id} entry (201 Created or 204 No Content).`,
      points: 30,
      dependsOn: ['vlan-30'],
      hint: `A write names the type of its body: -H "Content-Type: ${RESTCONF_LAB_JSON_TYPE}". Read the status line every PUT prints.`,
      assertions: [{ ...putLogged('SW1'), misconception: 'console-change-counted-as-api' }, putLogged('SW2'), putLogged('SW3')],
      feedbackOnFail: 'A 4xx answer changed nothing: 400 is a body the switch could not accept, 401 missing or wrong credentials, 415 a missing Content-Type.',
    },
  ],
  solution: {
    // the change the note asks for, typed on SW3's console; the requests are RESTCONF_LAB_REQUESTS (module header)
    SW3: [`vlan ${RESTCONF_LAB_NOTE_VLAN.id}`, `name ${RESTCONF_LAB_NOTE_VLAN.name}`],
  },
};

/** The CCNA 3 automation labs: lesson 38 (lab 40 [S32] joins after the NF-DEVHOST flip). */
export const CCNA3_AUTOMATION_LABS: readonly ScenarioInfo[] = [ccna3RestconfChange];
