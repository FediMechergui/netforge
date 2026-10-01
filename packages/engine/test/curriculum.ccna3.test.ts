/**
 * The CCNA 3 lesson skeleton and its objectives as data (ARCHITECTURE-P3 §7 W1 course, §11.1, §11.3, §11.4) hold
 * together on their own: 40 lessons in 14 modules with the `ccna3-NN-slug` ids §11.1 froze at W0, no lesson over 45
 * minutes, the 21 labs of the approved plan (§8.5) each reachable from exactly one lesson, and every §11.4 objective
 * with one row whose `handsOn` is a §11.4 value. The rows that are not `'lab'` are printed as the spec §2.8
 * `coverage-gap` warning.
 *
 * The skeleton is DETACHED from `curriculum/index.ts` until the W7 course flip, so it is imported directly here. Lab
 * names are not looked up in `SCENARIOS` yet: the CCNA 3 labs join it in W5 (the automation labs in W6, §11.3). The
 * CCNA 2 labs two objective rows point at exist already and are checked.
 */
import { describe, expect, it } from 'vitest';
import type { Lesson } from '../src/contracts/curriculum.js';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import {
  CCNA3_OBJECTIVE_CLUSTERS,
  CCNA3_OBJECTIVES,
  OBJECTIVE_HANDS_ON,
  type ObjectiveHandsOn,
} from '../src/curriculum/ccna3/objectives.js';
import { SCENARIOS } from '../src/sim/scenarios.js';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Names this course never prints (§0 rule 6, §11.3: no vendor, controller product or vendor certification programme),
 * checked on every title, summary, outcome, topic and objective text (never on ids, which carry `ccna3`).
 */
const VENDORS =
  /\b(?:cisco|ios|ios-xe|nx-os|packet\s*tracer|netacad|juniper|junos|huawei|catalyst|meraki|aruba|nexus|ansible|netflow|dna\s*center|apic|sd-access|devnet|ccna|ccnp|wireshark)\b/i;

const lessons = (): Lesson[] => CCNA3_MODULES.flatMap((m) => [...m.lessons]);

/** The §11.1 lesson ids, frozen at W0 (overlay owners key on them); a reorder has to be a deliberate edit here too. */
const CCNA3_ORDER = [
  'ccna3-01-why-routers-share-routes',
  'ccna3-02-how-ospf-maps-a-network',
  'ccna3-03-neighbours-and-the-designated-router',
  'ccna3-04-switching-ospf-on',
  'ccna3-05-cost-and-the-best-path',
  'ccna3-06-default-routes-and-timers',
  'ccna3-07-fixing-ospf',
  'ccna3-08-more-than-one-area',
  'ccna3-09-ospf-for-ipv6',
  'ccna3-10-eigrp-and-its-metric',
  'ccna3-11-the-language-of-security',
  'ccna3-12-how-attacks-unfold',
  'ccna3-13-layers-of-defence',
  'ccna3-14-how-an-acl-decides',
  'ccna3-15-standard-acls',
  'ccna3-16-extended-acls',
  'ccna3-17-editing-and-reading-acls',
  'ccna3-18-translation-at-the-edge',
  'ccna3-19-locking-down-device-access',
  'ccna3-20-guarding-the-access-layer',
  'ccna3-21-joining-distant-sites',
  'ccna3-22-point-to-point-links',
  'ccna3-23-private-paths-over-public-networks',
  'ccna3-24-gre-tunnels',
  'ccna3-25-site-to-site-ipsec',
  'ccna3-26-why-traffic-needs-priority',
  'ccna3-27-marking-queuing-and-policing',
  'ccna3-28-who-is-next-door',
  'ccna3-29-time-and-logs',
  'ccna3-30-watching-the-network',
  'ccna3-31-looking-after-files-and-images',
  'ccna3-32-designing-networks-that-grow',
  'ccna3-33-a-method-for-enterprise-faults',
  'ccna3-34-finding-faults-across-layers',
  'ccna3-35-clouds-and-virtual-machines',
  'ccna3-36-software-defined-networking',
  'ccna3-37-data-a-machine-can-read',
  'ccna3-38-talking-to-devices-through-apis',
  'ccna3-39-configuration-as-code',
  'ccna3-40-scripting-the-network',
];

/** The fourteen module titles of §11.1, in order (they are also each lesson's `topic`), with their lesson numbers. */
const MODULES: readonly (readonly [title: string, lessons: readonly number[]])[] = [
  ['Routers that learn', [1, 2, 3]],
  ['One OSPF area', [4, 5, 6, 7]],
  ['Growing OSPF', [8, 9]],
  ['EIGRP', [10]],
  ['Thinking like a defender', [11, 12, 13]],
  ['Access control lists', [14, 15, 16, 17, 18]],
  ['Hardening', [19, 20]],
  ['Wide area networks', [21, 22]],
  ['Tunnels and VPNs', [23, 24, 25]],
  ['Quality of service', [26, 27]],
  ['Managing the network', [28, 29, 30, 31]],
  ['Designing and fixing', [32, 33, 34]],
  ['Virtual networks', [35, 36]],
  ['Automating the network', [37, 38, 39, 40]],
];

/** The §11.1 minutes column, lesson 01 … 40 (about 610 minutes in all). */
const MINUTES = [
  12, 16, 16, 18, 14, 14, 16, 16, 14, 18, 12, 14, 16, 14, 16, 18, 14, 10, 16, 18, 16, 16, 16, 16, 16, 14, 16, 14, 16, 16,
  16, 14, 14, 16, 14, 14, 14, 18, 16, 16,
];

/**
 * Lesson number → lab, from the §11.1 lab column with the approved plan of §8.5, and the item each lab belongs to
 * (§11.1 "Counts"). Lessons not listed have no lab.
 */
const LAB_BY_LESSON: Readonly<Record<string, readonly [lab: string, item: 'MUST' | 'S18' | 'S32' | 'C1' | 'C13']>> = {
  '03': ['ccna3-ospf-dr-election', 'MUST'],
  '04': ['ccna3-ospf-single-area', 'MUST'],
  '05': ['ccna3-ospf-cost', 'MUST'],
  '06': ['ccna3-ospf-default-route', 'MUST'],
  '07': ['ccna3-troubleshoot-ospf', 'MUST'],
  '10': ['ccna3-eigrp-feasible-successor', 'C1'],
  '15': ['ccna3-acl-standard', 'MUST'],
  '16': ['ccna3-acl-extended', 'MUST'],
  '17': ['ccna3-acl-edit-verify', 'MUST'],
  '19': ['ccna3-secure-device-access', 'MUST'],
  '20': ['ccna3-dhcp-snooping-dai', 'MUST'],
  '22': ['ccna3-serial-links', 'MUST'],
  '24': ['ccna3-gre-tunnel', 'S18'],
  '25': ['ccna3-ipsec-site-to-site', 'C13'],
  '27': ['ccna3-qos-voice-first', 'MUST'],
  '28': ['ccna3-discover-neighbours', 'MUST'],
  '29': ['ccna3-time-and-logs', 'MUST'],
  '33': ['ccna3-troubleshoot-eigrp', 'C1'],
  '34': ['ccna3-troubleshoot-enterprise', 'MUST'],
  '38': ['ccna3-restconf-change', 'MUST'],
  '40': ['ccna3-script-inventory', 'S32'],
};

/** Lessons whose lab belongs to an item that is not approved (08 S4, 09 S6, 30 S33/S34, 31 S29, 39 C22): theory only. */
const THEORY_ONLY_UNAPPROVED = ['08', '09', '30', '31', '39'];

/**
 * §11.4 transcribed: every objective, cluster by cluster, as [id, lesson, handsOn, lab]. The lesson is `ccna3-NN` or
 * `ccna2-NN` (resolved by prefix); the lab is given exactly for the `'lab'` rows.
 */
const TRACE_11_4: readonly (readonly [id: string, lesson: string, handsOn: ObjectiveHandsOn, lab?: string])[] = [
  // OSPF: single-area 04L; DR/BDR 03L; broadcast and p2p 03L; hello/dead 06L; cost 05L; passive 04L; router-id 04L;
  // LSDB and SPF 02; multi-area 08 (S4); OSPFv3 09 (S6); NBMA 03 (P5); LSA 1, 2 and 5 04L/06L; 3 and 4 08 (S4); 7 (P5);
  // authentication 07 (S5)
  ['CCNA3.ospf.1', 'ccna3-04', 'lab', 'ccna3-ospf-single-area'],
  ['CCNA3.ospf.2', 'ccna3-03', 'lab', 'ccna3-ospf-dr-election'],
  ['CCNA3.ospf.3', 'ccna3-03', 'lab', 'ccna3-ospf-dr-election'],
  ['CCNA3.ospf.4', 'ccna3-06', 'lab', 'ccna3-ospf-default-route'],
  ['CCNA3.ospf.5', 'ccna3-05', 'lab', 'ccna3-ospf-cost'],
  ['CCNA3.ospf.6', 'ccna3-04', 'lab', 'ccna3-ospf-single-area'],
  ['CCNA3.ospf.7', 'ccna3-04', 'lab', 'ccna3-ospf-single-area'],
  ['CCNA3.ospf.8', 'ccna3-02', 'theory'],
  ['CCNA3.ospf.9', 'ccna3-08', 'later:P3c'],
  ['CCNA3.ospf.10', 'ccna3-09', 'later:P3c'],
  ['CCNA3.ospf.11', 'ccna3-03', 'untaught:P5'],
  ['CCNA3.ospf.12', 'ccna3-04', 'lab', 'ccna3-ospf-single-area'],
  ['CCNA3.ospf.13', 'ccna3-06', 'lab', 'ccna3-ospf-default-route'],
  ['CCNA3.ospf.14', 'ccna3-08', 'later:P3c'],
  ['CCNA3.ospf.15', 'ccna3-08', 'untaught:P5'],
  ['CCNA3.ospf.16', 'ccna3-07', 'later:P3c'],
  // EIGRP: tables 10L; successor, FS, feasibility 10L; metric and K values 10L and 33L; adjacencies 33L; stub,
  // summarisation, unequal-cost 10 (P5, C2)
  ['CCNA3.eigrp.1', 'ccna3-10', 'lab', 'ccna3-eigrp-feasible-successor'],
  ['CCNA3.eigrp.2', 'ccna3-10', 'lab', 'ccna3-eigrp-feasible-successor'],
  ['CCNA3.eigrp.3', 'ccna3-10', 'lab', 'ccna3-eigrp-feasible-successor'],
  ['CCNA3.eigrp.4', 'ccna3-33', 'lab', 'ccna3-troubleshoot-eigrp'],
  ['CCNA3.eigrp.5', 'ccna3-10', 'untaught:P5'],
  // ACLs: standard and extended 15L/16L; numbered and named 15L; wildcard 14 (S9); established 16L; placement 15/16
  // (the advisor, S23); counters 17L; logging 17L; vty ACL 15L (S13); IPv6 17 (S11); time-based 17 (P4)
  ['CCNA3.acl.1', 'ccna3-15', 'lab', 'ccna3-acl-standard'],
  ['CCNA3.acl.2', 'ccna3-16', 'lab', 'ccna3-acl-extended'],
  ['CCNA3.acl.3', 'ccna3-15', 'lab', 'ccna3-acl-standard'],
  ['CCNA3.acl.4', 'ccna3-14', 'theory'],
  ['CCNA3.acl.5', 'ccna3-16', 'lab', 'ccna3-acl-extended'],
  ['CCNA3.acl.6', 'ccna3-15', 'later:P3c'],
  ['CCNA3.acl.7', 'ccna3-17', 'lab', 'ccna3-acl-edit-verify'],
  ['CCNA3.acl.8', 'ccna3-17', 'lab', 'ccna3-acl-edit-verify'],
  ['CCNA3.acl.9', 'ccna3-15', 'lab', 'ccna3-acl-standard'],
  ['CCNA3.acl.10', 'ccna3-17', 'later:P3c'],
  ['CCNA3.acl.11', 'ccna3-17', 'untaught:P4'],
  // Security concepts: CIA, threat, vulnerability, exploit 11; attack taxonomy 12; defence in depth 13; AAA 13 (local
  // users 19L; server AAA P4); 802.1X 13 (P4)
  ['CCNA3.security.1', 'ccna3-11', 'theory'],
  ['CCNA3.security.2', 'ccna3-12', 'theory'],
  ['CCNA3.security.3', 'ccna3-13', 'theory'],
  ['CCNA3.security.4', 'ccna3-19', 'lab', 'ccna3-secure-device-access'],
  ['CCNA3.security.5', 'ccna3-13', 'untaught:P4'],
  ['CCNA3.security.6', 'ccna3-13', 'untaught:P4'],
  // Hardening: SSH only 19L; unused ports 19L; DHCP snooping 20L; DAI 20L; IP source guard 20 (S15); storm control 20
  // (S16); BPDU guard ccna2-16; native VLAN and nonegotiate ccna2-24 (practised in the CCNA 2 port-security lab)
  ['CCNA3.hardening.1', 'ccna3-19', 'lab', 'ccna3-secure-device-access'],
  ['CCNA3.hardening.2', 'ccna3-19', 'lab', 'ccna3-secure-device-access'],
  ['CCNA3.hardening.3', 'ccna3-20', 'lab', 'ccna3-dhcp-snooping-dai'],
  ['CCNA3.hardening.4', 'ccna3-20', 'lab', 'ccna3-dhcp-snooping-dai'],
  ['CCNA3.hardening.5', 'ccna3-20', 'later:P3c'],
  ['CCNA3.hardening.6', 'ccna3-20', 'later:P3c'],
  ['CCNA3.hardening.7', 'ccna2-16', 'lab', 'ccna2-stp-guards'],
  ['CCNA3.hardening.8', 'ccna2-24', 'lab', 'ccna2-port-security'],
  // WAN: connection types 21 (the visualizer, S22); HDLC 22L; PPP LCP/NCP and CHAP 22L (S19); PAP 22 theory; VPN
  // concepts 23; GRE 24L (S18); site-to-site IPsec 25L (C13); crypto maps, IKEv1 and remote access (P4)
  ['CCNA3.wan.1', 'ccna3-21', 'later:P3c'],
  ['CCNA3.wan.2', 'ccna3-22', 'lab', 'ccna3-serial-links'],
  ['CCNA3.wan.3', 'ccna3-22', 'lab', 'ccna3-serial-links'],
  ['CCNA3.wan.4', 'ccna3-22', 'theory'],
  ['CCNA3.wan.5', 'ccna3-23', 'theory'],
  ['CCNA3.wan.6', 'ccna3-24', 'lab', 'ccna3-gre-tunnel'],
  ['CCNA3.wan.7', 'ccna3-25', 'lab', 'ccna3-ipsec-site-to-site'],
  ['CCNA3.wan.8', 'ccna3-25', 'untaught:P4'],
  // QoS: marking 27L; FIFO/WFQ/CBWFQ/LLQ 26 and 27L (S20); policing vs shaping 27L (S21); congestion animation 27L
  ['CCNA3.qos.1', 'ccna3-27', 'lab', 'ccna3-qos-voice-first'],
  ['CCNA3.qos.2', 'ccna3-26', 'lab', 'ccna3-qos-voice-first'],
  ['CCNA3.qos.3', 'ccna3-27', 'lab', 'ccna3-qos-voice-first'],
  ['CCNA3.qos.4', 'ccna3-27', 'lab', 'ccna3-qos-voice-first'],
  // Management: CDP and LLDP 28L; NTP 29L; syslog 29L (S24, S25); SNMPv2c 30 (S33); v3 (C23); flow export 30 (P4);
  // SPAN 30 (S34); RSPAN (P4); file system and image backup 31 (S29/S30); password recovery 31 (S31)
  ['CCNA3.management.1', 'ccna3-28', 'lab', 'ccna3-discover-neighbours'],
  ['CCNA3.management.2', 'ccna3-29', 'lab', 'ccna3-time-and-logs'],
  ['CCNA3.management.3', 'ccna3-29', 'lab', 'ccna3-time-and-logs'],
  ['CCNA3.management.4', 'ccna3-30', 'later:P3c'],
  ['CCNA3.management.5', 'ccna3-30', 'later:P3c'],
  ['CCNA3.management.6', 'ccna3-30', 'untaught:P4'],
  ['CCNA3.management.7', 'ccna3-30', 'later:P3c'],
  ['CCNA3.management.8', 'ccna3-30', 'untaught:P4'],
  ['CCNA3.management.9', 'ccna3-31', 'later:P3c'],
  ['CCNA3.management.10', 'ccna3-31', 'later:P3c'],
  // Automation: data formats 37 and 38L; REST 38L; RESTCONF and YANG 38L; the YANG browser (S28); NETCONF 38 (C21);
  // configuration-management tools 39 (C22); Python 40L (S32); SDN and intent-based 36 (the visualizer, C26)
  ['CCNA3.automation.1', 'ccna3-37', 'lab', 'ccna3-restconf-change'],
  ['CCNA3.automation.2', 'ccna3-38', 'lab', 'ccna3-restconf-change'],
  ['CCNA3.automation.3', 'ccna3-38', 'lab', 'ccna3-restconf-change'],
  ['CCNA3.automation.4', 'ccna3-38', 'later:P3c'],
  ['CCNA3.automation.5', 'ccna3-38', 'later:P3c'],
  ['CCNA3.automation.6', 'ccna3-39', 'later:P3c'],
  ['CCNA3.automation.7', 'ccna3-40', 'lab', 'ccna3-script-inventory'],
  ['CCNA3.automation.8', 'ccna3-36', 'later:P3c'],
  // Beyond §2.3 (course modules): NAT 18 (practised in lesson 34's lab, §11.1); design 32; troubleshooting 33L (C1)
  // and 34L; cloud and virtualisation 35
  ['CCNA3.course.1', 'ccna3-18', 'lab', 'ccna3-troubleshoot-enterprise'],
  ['CCNA3.course.2', 'ccna3-32', 'theory'],
  ['CCNA3.course.3', 'ccna3-33', 'lab', 'ccna3-troubleshoot-eigrp'],
  ['CCNA3.course.4', 'ccna3-34', 'lab', 'ccna3-troubleshoot-enterprise'],
  ['CCNA3.course.5', 'ccna3-35', 'theory'],
];

/** The one CCNA 3 lesson no objective row points at: it introduces the module and teaches no listed objective. */
const INTRODUCTION_ONLY = ['ccna3-01-why-routers-share-routes'];

const nn = (id: string): string => id.slice('ccna3-'.length, 'ccna3-'.length + 2);

describe('CCNA 3 lesson skeleton (§11.1)', () => {
  it('has 40 lessons in 14 modules, in the frozen §11.1 order', () => {
    expect(CCNA3_MODULES.map((m) => m.title)).toEqual(MODULES.map(([title]) => title));
    expect(lessons().map((l) => l.id)).toEqual(CCNA3_ORDER);
    CCNA3_MODULES.forEach((m, i) => {
      expect(m.lessons.map((l) => Number(nn(l.id))), m.id).toEqual(MODULES[i]![1]);
    });
  });

  it('numbers lessons ccna3-01 … ccna3-40 and modules ccna3-m1 … ccna3-m14, all kebab-case, unique, and new to CCNA 1 and 2', () => {
    lessons().forEach((l, i) => {
      expect(l.id, l.id).toMatch(KEBAB);
      expect(l.id.startsWith(`ccna3-${String(i + 1).padStart(2, '0')}-`), l.id).toBe(true);
    });
    CCNA3_MODULES.forEach((m, i) => {
      expect(m.id, m.id).toMatch(KEBAB);
      expect(m.id.startsWith(`ccna3-m${i + 1}-`), m.id).toBe(true);
      expect(m.summary.trim().length, `${m.id} has no summary`).toBeGreaterThan(0);
      expect(m.lessons.length, `${m.id} has no lessons`).toBeGreaterThan(0);
    });
    const ids = [...CCNA3_MODULES.map((m) => m.id), ...lessons().map((l) => l.id)];
    const earlier = [CCNA1_MODULES, CCNA2_MODULES].flatMap((mods) => [...mods.map((m) => m.id), ...mods.flatMap((m) => m.lessons.map((l) => l.id))]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => earlier.includes(id))).toEqual([]);
  });

  it('gives every lesson a title, a one-sentence outcome, its module title as topic, and the §11.1 minutes (never over 45)', () => {
    for (const m of CCNA3_MODULES) {
      for (const l of m.lessons) {
        expect(l.title.trim().length, `${l.id} has no title`).toBeGreaterThan(0);
        expect(l.outcome.trim().length, `${l.id} has no outcome`).toBeGreaterThan(0);
        expect(l.outcome.trim().endsWith('.'), `${l.id}: the outcome is one sentence ending in a full stop`).toBe(true);
        expect(l.outcome, `${l.id}: the outcome is one sentence`).not.toMatch(/[.!?]\s/);
        expect(l.topic, l.id).toBe(m.title);
        expect(Number.isInteger(l.estimatedMinutes), l.id).toBe(true);
        expect(l.estimatedMinutes, `${l.id} takes no time`).toBeGreaterThan(0);
        expect(l.estimatedMinutes, `${l.id} runs over 45 minutes`).toBeLessThanOrEqual(45);
      }
    }
    expect(lessons().map((l) => l.estimatedMinutes)).toEqual(MINUTES);
    expect(MINUTES.reduce((a, b) => a + b, 0)).toBe(610);
  });

  it('is a skeleton: no theory and no video yet (theory comes in W6 and W7)', () => {
    for (const l of lessons()) {
      expect(l.theory, l.id).toBe('');
      expect(l.video, l.id).toBeUndefined();
    }
  });

  it('attaches exactly the §11.1 lab of each lesson, for the approved plan', () => {
    for (const l of lessons()) expect(l.lab, l.id).toBe(LAB_BY_LESSON[nn(l.id)]?.[0]);
    for (const n of THEORY_ONLY_UNAPPROVED) {
      const lesson = lessons().find((l) => nn(l.id) === n);
      expect(lesson, n).toBeDefined();
      expect(lesson?.lab, `${n} belongs to an item that is not approved and names no lab`).toBeUndefined();
    }
  });

  it('reaches every lab of the approved plan from exactly one lesson: 16 MUST, S18, S32, two C1 and C13 (21 labs)', () => {
    const used = lessons()
      .map((l) => l.lab)
      .filter((name): name is string => name !== undefined);
    expect(used.length).toBe(21);
    expect(new Set(used).size, `a lab is attached twice: ${used.join(', ')}`).toBe(used.length);
    expect([...used].sort()).toEqual(Object.values(LAB_BY_LESSON).map(([lab]) => lab).sort());
    for (const name of used) {
      expect(name, name).toMatch(KEBAB);
      expect(name.startsWith('ccna3-'), name).toBe(true);
    }
    const byItem = new Map<string, number>();
    for (const [, item] of Object.values(LAB_BY_LESSON)) byItem.set(item, (byItem.get(item) ?? 0) + 1);
    expect(Object.fromEntries(byItem)).toEqual({ MUST: 16, C1: 2, S18: 1, C13: 1, S32: 1 });
  });

  it('uses original wording with no vendor, product or certification names', () => {
    const strings = CCNA3_MODULES.flatMap((m) => [m.title, m.summary, ...m.lessons.flatMap((l) => [l.title, l.outcome, l.topic])]);
    for (const s of strings) expect(s, s).not.toMatch(VENDORS);
  });
});

describe('CCNA 3 objectives as data (§11.4)', () => {
  const ccna3Lessons = new Map(lessons().map((l) => [l.id, l]));
  const ccna2Lessons = new Map(CCNA2_MODULES.flatMap((m) => m.lessons.map((l) => [l.id, l] as const)));
  const approvedLabs = new Set(Object.values(LAB_BY_LESSON).map(([lab]) => lab));
  /** `ccna3-NN` / `ccna2-NN` → the full lesson id. */
  const lessonId = (key: string): string | undefined =>
    [...ccna3Lessons.keys(), ...ccna2Lessons.keys()].find((id) => id.startsWith(`${key}-`));

  it('names the ten clusters: the nine of spec §2.3, then the course modules beyond it', () => {
    expect(CCNA3_OBJECTIVE_CLUSTERS.map((c) => c.id)).toEqual([
      'ospf',
      'eigrp',
      'acl',
      'security',
      'hardening',
      'wan',
      'qos',
      'management',
      'automation',
      'course',
    ]);
    for (const c of CCNA3_OBJECTIVE_CLUSTERS) expect(c.title.trim().length, c.id).toBeGreaterThan(0);
  });

  it('numbers the ids CCNA3.<cluster>.<n> from 1 inside each cluster, clusters in order, each id once', () => {
    const clusters = CCNA3_OBJECTIVE_CLUSTERS.map((c) => c.id);
    const ids = CCNA3_OBJECTIVES.map((o) => o.id);
    expect(new Set(ids).size, 'an id is used twice').toBe(ids.length);
    let lastCluster = -1;
    const next = new Map<string, number>();
    for (const o of CCNA3_OBJECTIVES) {
      const m = /^CCNA3\.([a-z]+)\.([1-9]\d*)$/.exec(o.id);
      expect(m, o.id).not.toBeNull();
      const [, cluster, n] = m as RegExpExecArray;
      const at = clusters.indexOf(cluster!);
      expect(at, `${o.id}: unknown cluster`).toBeGreaterThanOrEqual(0);
      expect(at, `${o.id}: clusters out of order`).toBeGreaterThanOrEqual(lastCluster);
      lastCluster = at;
      const expected = (next.get(cluster!) ?? 0) + 1;
      expect(Number(n), o.id).toBe(expected);
      next.set(cluster!, expected);
    }
    expect([...next.keys()], 'every cluster has at least one objective').toEqual(clusters);
  });

  it('gives every §11.4 objective exactly one row, and has no row for anything else', () => {
    const expected = TRACE_11_4.map(([id]) => id);
    expect(new Set(expected).size, 'the transcription lists an objective twice').toBe(expected.length);
    const rows = CCNA3_OBJECTIVES.map((o) => o.id);
    const missing = expected.filter((id) => !rows.includes(id));
    expect(missing, `objectives with no row: ${missing.join(', ')}`).toEqual([]);
    const extra = rows.filter((id) => !expected.includes(id));
    expect(extra, `rows for no §11.4 objective: ${extra.join(', ')}`).toEqual([]);
    expect(rows).toEqual(expected);
  });

  it('traces each row to the §11.4 lesson, hands-on state and lab', () => {
    const byId = new Map(CCNA3_OBJECTIVES.map((o) => [o.id, o]));
    for (const [id, key, handsOn, lab] of TRACE_11_4) {
      const row = byId.get(id);
      expect(row, id).toBeDefined();
      const want = lessonId(key);
      expect(want, `${id}: ${key} names no lesson`).toBeDefined();
      expect(row?.lesson, id).toBe(want);
      expect(row?.handsOn, id).toBe(handsOn);
      expect(row?.lab, id).toBe(lab);
    }
  });

  it('uses only §11.4 hands-on values, names a lab exactly for the lab rows, and points only at lessons and labs that exist', () => {
    expect([...OBJECTIVE_HANDS_ON]).toEqual(['lab', 'theory', 'later:P3c', 'untaught:P4', 'untaught:P5']);
    for (const o of CCNA3_OBJECTIVES) {
      expect(OBJECTIVE_HANDS_ON, o.id).toContain(o.handsOn);
      expect(ccna3Lessons.has(o.lesson) || ccna2Lessons.has(o.lesson), `${o.id}: ${o.lesson} is not a lesson`).toBe(true);
      if (o.handsOn !== 'lab') {
        expect(o.lab, `${o.id} is not hands-on in a lab and names none`).toBeUndefined();
        continue;
      }
      expect(o.lab, `${o.id} is hands-on and names its lab`).toBeDefined();
      const lab = o.lab as string;
      if (lab.startsWith('ccna3-')) {
        expect(approvedLabs.has(lab), `${o.id}: ${lab} is not a lab of the approved plan`).toBe(true);
      } else {
        // a CCNA 2 lab §11.4 traces to: it exists already
        const scenario = SCENARIOS.find((s) => s.name === lab);
        expect(scenario, `${o.id}: ${lab} is not in SCENARIOS`).toBeDefined();
        expect(scenario?.category, lab).toBe('ccna2-lab');
        expect(ccna2Lessons.has(o.lesson), `${o.id}: a CCNA 2 lab goes with its CCNA 2 lesson`).toBe(true);
      }
    }
  });

  it('writes each objective once, in original wording with no vendor names', () => {
    const texts = CCNA3_OBJECTIVES.map((o) => o.text);
    expect(new Set(texts).size, 'an objective text is used twice').toBe(texts.length);
    for (const t of texts) {
      expect(t.trim(), t).toBe(t);
      expect(t.length, t).toBeGreaterThan(0);
      expect(t.endsWith('.'), `${t}: a label, not a sentence`).toBe(false);
      expect(t, t).not.toMatch(VENDORS);
    }
  });

  it('leaves no CCNA 3 lesson without an objective except the module introduction', () => {
    const traced = new Set(CCNA3_OBJECTIVES.map((o) => o.lesson));
    const orphans = lessons()
      .map((l) => l.id)
      .filter((id) => !traced.has(id));
    expect(orphans).toEqual(INTRODUCTION_ONLY);
  });

  it('lists every objective that is not practised in a lab as the spec §2.8 coverage-gap warning', () => {
    const gaps = CCNA3_OBJECTIVES.filter((o) => o.handsOn !== 'lab');
    expect(gaps.map((o) => o.id)).toEqual(TRACE_11_4.filter(([, , handsOn]) => handsOn !== 'lab').map(([id]) => id));
    const counts = Object.fromEntries(OBJECTIVE_HANDS_ON.map((h) => [h, CCNA3_OBJECTIVES.filter((o) => o.handsOn === h).length]));
    expect(counts).toEqual({ lab: 45, theory: 9, 'later:P3c': 18, 'untaught:P4': 6, 'untaught:P5': 3 });
    console.warn(
      [
        `coverage-gap (spec §2.8): ${gaps.length} of ${CCNA3_OBJECTIVES.length} CCNA 3 objectives are not practised in a lab of the approved plan`,
        ...gaps.map((o) => `  ${o.id} [${o.handsOn}] ${o.text} (${o.lesson})`),
      ].join('\n'),
    );
  });
});
