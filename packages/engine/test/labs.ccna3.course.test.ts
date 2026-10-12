/**
 * P3 W5 course: the CCNA 3 lab catalogue's course order (ARCHITECTURE-P3 §7 W5 "course", §11.1, §11.2;
 * sim/scenarios/ccna3/index.ts; the twin of the catalogue cases of `labs.ccna2.solutions.test.ts`).
 *
 *   • `CCNA3_LAB_ORDER` names the 21 labs of the approved plan (§8.4, §8.5) exactly once each — the 16 MUST labs, the
 *     two approved SHOULD labs (24 [S18], 40 [S32]) and the three approved COULD labs (10 and 33 [C1], 25 [C13]) — in
 *     the order the lesson skeleton (curriculum/ccna3/lessons.ts) meets them, the two W6 automation labs included;
 *     every name is the lab of exactly one lesson, and no lesson names a lab the order does not know;
 *   • `CCNA3_LABS` is every lab of the eleven lab files (the ten W5 area files and W6's automation.ts, §9.2 item 40g)
 *     sorted by that order (a name whose lab has not landed yet is absent, as in CCNA 2), each lab sits in the file
 *     its area owns (§11.2), and every lab is named in the order;
 *   • every lab a lesson points at is in `SCENARIOS` exactly once as a `ccna3-lab` (§11.3), lab 38 included from W6;
 *     only lab 40 [S32] may still be absent, until the flip step lands it;
 *   • no lab file imports the catalogue it belongs to (the arrays are read at module scope: a cycle is the rule-12
 *     hazard).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import {
  CCNA3_ACL_LABS,
  CCNA3_AUTOMATION_LABS,
  CCNA3_DISCOVERY_LABS,
  CCNA3_EIGRP_LABS,
  CCNA3_HARDENING_LABS,
  CCNA3_LABS,
  CCNA3_LAB_ORDER,
  CCNA3_OSPF_LABS,
  CCNA3_QOS_LABS,
  CCNA3_TIME_LABS,
  CCNA3_TROUBLESHOOTING_LABS,
  CCNA3_VPN_LABS,
  CCNA3_WAN_LABS,
} from '../src/sim/scenarios/ccna3/index.js';
import { SCENARIOS } from '../src/sim/scenarios.js';

/**
 * The eleven lab files — the ten area files of W5 and W6's automation.ts (§9.2 item 40g) — with the lab names §11.1
 * and §11.2 give each. Lab 40 is named in the automation file but lands only after the [S32] flip step.
 */
const FILES: readonly { file: string; labs: readonly ScenarioInfo[]; names: readonly string[] }[] = [
  {
    file: 'ospf',
    labs: CCNA3_OSPF_LABS,
    names: ['ccna3-ospf-dr-election', 'ccna3-ospf-single-area', 'ccna3-ospf-cost', 'ccna3-ospf-default-route', 'ccna3-troubleshoot-ospf'],
  },
  { file: 'eigrp', labs: CCNA3_EIGRP_LABS, names: ['ccna3-eigrp-feasible-successor', 'ccna3-troubleshoot-eigrp'] },
  { file: 'acl', labs: CCNA3_ACL_LABS, names: ['ccna3-acl-standard', 'ccna3-acl-extended', 'ccna3-acl-edit-verify'] },
  { file: 'hardening', labs: CCNA3_HARDENING_LABS, names: ['ccna3-secure-device-access', 'ccna3-dhcp-snooping-dai'] },
  { file: 'wan', labs: CCNA3_WAN_LABS, names: ['ccna3-serial-links'] },
  { file: 'vpn', labs: CCNA3_VPN_LABS, names: ['ccna3-gre-tunnel', 'ccna3-ipsec-site-to-site'] },
  { file: 'qos', labs: CCNA3_QOS_LABS, names: ['ccna3-qos-voice-first'] },
  { file: 'discovery', labs: CCNA3_DISCOVERY_LABS, names: ['ccna3-discover-neighbours'] },
  { file: 'time', labs: CCNA3_TIME_LABS, names: ['ccna3-time-and-logs'] },
  { file: 'troubleshooting', labs: CCNA3_TROUBLESHOOTING_LABS, names: ['ccna3-troubleshoot-enterprise'] },
  { file: 'automation', labs: CCNA3_AUTOMATION_LABS, names: ['ccna3-restconf-change', 'ccna3-script-inventory'] },
];

/** The labs that may still be missing from `SCENARIOS`: lab 40 [S32], which needs NF-DEVHOST from the flip step. */
const AWAITING_FLIP: readonly string[] = ['ccna3-script-inventory'];

/** The lessons of the skeleton in teaching order. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons);

/** Every lab of the eleven files, in file order. */
const ALL_FILE_LABS: readonly ScenarioInfo[] = FILES.flatMap((f) => f.labs);

describe('CCNA3 labs: the course order', () => {
  it('names the 21 labs of the approved plan once each, frozen', () => {
    expect(CCNA3_LAB_ORDER).toHaveLength(21);
    expect(new Set(CCNA3_LAB_ORDER).size).toBe(21);
    expect(Object.isFrozen(CCNA3_LAB_ORDER)).toBe(true);
    for (const name of CCNA3_LAB_ORDER) expect(name, name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
    // the lab files' names (the two automation labs included) are exactly the order's names
    const planned = FILES.flatMap((f) => f.names);
    expect(new Set(planned).size).toBe(planned.length);
    expect([...planned].sort()).toEqual([...CCNA3_LAB_ORDER].sort());
  });

  it('follows the lesson skeleton: each name is the lab of exactly one lesson, in lesson order', () => {
    const lessonLabs = LESSONS.flatMap((l) => (l.lab === undefined ? [] : [l.lab]));
    for (const name of CCNA3_LAB_ORDER) expect(lessonLabs.filter((n) => n === name), name).toHaveLength(1);
    expect(lessonLabs).toEqual([...CCNA3_LAB_ORDER]);
  });

  it('keeps the lesson numbers of the comments: lab 22 and lab 34 sit after their lessons', () => {
    const at = (name: string): string | undefined => LESSONS.find((l) => l.lab === name)?.id;
    expect(at('ccna3-serial-links')).toBe('ccna3-22-point-to-point-links');
    expect(at('ccna3-troubleshoot-enterprise')).toBe('ccna3-34-finding-faults-across-layers');
    expect(at('ccna3-restconf-change')).toBe('ccna3-38-talking-to-devices-through-apis');
    expect(at('ccna3-script-inventory')).toBe('ccna3-40-scripting-the-network');
  });
});

describe('CCNA3 labs: the catalogue', () => {
  it('sorts every lab of the eleven files by the course order, each lab in the file of its area', () => {
    const names = ALL_FILE_LABS.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of FILES) {
      for (const lab of f.labs) expect(f.names, `${lab.name} in ${f.file}.ts`).toContain(lab.name);
    }
    for (const name of names) expect(CCNA3_LAB_ORDER, name).toContain(name);
    expect(CCNA3_LABS.length).toBe(ALL_FILE_LABS.length);
    for (const lab of ALL_FILE_LABS) expect(CCNA3_LABS, lab.name).toContain(lab);
    expect(CCNA3_LABS.map((l) => l.name)).toEqual(CCNA3_LAB_ORDER.filter((n) => names.includes(n)));
    expect(Object.isFrozen(CCNA3_LABS)).toBe(true);
  });

  it('holds the course lab files of W5: lab 22 in wan.ts and lab 34 in troubleshooting.ts', () => {
    expect(CCNA3_WAN_LABS.map((l) => l.name)).toEqual(['ccna3-serial-links']);
    expect(CCNA3_TROUBLESHOOTING_LABS.map((l) => l.name)).toEqual(['ccna3-troubleshoot-enterprise']);
    const order = (name: string): number => CCNA3_LABS.findIndex((l) => l.name === name);
    expect(order('ccna3-serial-links')).toBeLessThan(order('ccna3-troubleshoot-enterprise'));
  });

  it('lists every lab a lesson points at in SCENARIOS once (lab 38 from W6; lab 40 after the flip step, §11.3)', () => {
    for (const name of CCNA3_LAB_ORDER) {
      const found = SCENARIOS.filter((s) => s.name === name);
      if (AWAITING_FLIP.includes(name) && found.length === 0) continue;
      expect(found.map((s) => s.category), name).toEqual(['ccna3-lab']);
    }
  });

  it('keeps the lab files free of imports of the catalogue they belong to', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    for (const f of FILES) expect(files, `${f.file}.ts`).toContain(`${f.file}.ts`);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        expect(m[1], `${file} imports ${m[1]}`).not.toMatch(/^\.\/index\.js$|^\.\.\/index\.js$|^\.\.\/\.\.\/scenarios\.js$|^\.\.\/\.\.\/\.\.\/index\.js$/);
      }
    }
  });
});
