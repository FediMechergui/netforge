/**
 * The CCNA 2 lesson skeleton (ARCHITECTURE-P2 §7 W1 course, §11) holds together on its own: 34 lessons in 11 modules
 * with stable `ccna2-NN-slug` ids, no lesson over 45 minutes, the labs of the approved scope each reachable from
 * exactly one lesson, and every spec §2.2 objective traced to a lesson (§11.4).
 *
 * The skeleton is imported directly: it stays detached from `curriculum/index.ts` until W7, so the planned-course pins
 * of `curriculum.test.ts` keep holding. Since W5 every lesson's lab name exists in `SCENARIOS` (§11.3), except the
 * wireless lab `ccna2-wlc-wlan`, which lands in W7.
 */
import { describe, expect, it } from 'vitest';
import type { Lesson } from '../src/contracts/curriculum.js';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { SCENARIOS } from '../src/sim/scenarios.js';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Names this course never prints (§0 rule 6: original wording, no vendors). */
const VENDORS = /\b(?:cisco|ios|packet\s*tracer|netacad|juniper|huawei|catalyst|meraki|aruba)\b/i;

const lessons = (): Lesson[] => CCNA2_MODULES.flatMap((m) => [...m.lessons]);

/** The lesson order the UI and later deep links depend on; a reorder has to be a deliberate edit here too. */
const CCNA2_ORDER = [
  'ccna2-01-how-a-switch-forwards',
  'ccna2-02-managing-a-switch',
  'ccna2-03-speed-duplex-and-cabling',
  'ccna2-04-why-split-a-lan',
  'ccna2-05-access-ports-and-the-vlan-list',
  'ccna2-06-trunks-and-tags',
  'ccna2-07-trunk-negotiation',
  'ccna2-08-voice-vlans',
  'ccna2-09-router-on-a-stick',
  'ccna2-10-multilayer-switching',
  'ccna2-11-fixing-inter-vlan-routing',
  'ccna2-12-what-a-loop-does',
  'ccna2-13-electing-a-root',
  'ccna2-14-port-roles-states-and-timers',
  'ccna2-15-rapid-spanning-tree',
  'ccna2-16-edge-ports-and-guards',
  'ccna2-17-bundling-links',
  'ccna2-18-dhcp-across-vlans',
  'ccna2-19-slaac-and-dhcpv6',
  'ccna2-20-one-gateway-one-point-of-failure',
  'ccna2-21-hot-standby-gateways',
  'ccna2-22-threats-at-layer-2',
  'ccna2-23-port-security',
  'ccna2-24-hardening-switch-ports',
  'ccna2-25-controllers-and-lightweight-aps',
  'ccna2-26-channels-and-overlap',
  'ccna2-27-wlans-on-a-controller',
  'ccna2-28-securing-a-wlan',
  'ccna2-29-how-a-router-chooses',
  'ccna2-30-static-route-forms',
  'ccna2-31-default-and-floating-routes',
  'ccna2-32-ipv6-static-routes',
  'ccna2-33-address-translation',
  'ccna2-34-finding-faults',
];

/** The eleven module titles of §11.1, in order (they are also each lesson's `topic`). */
const MODULE_TITLES = [
  'Switches, revisited',
  'VLANs',
  'Routing between VLANs',
  'Spanning tree',
  'EtherChannel',
  'Addressing services',
  'Gateway redundancy',
  'Access-layer security',
  'Wireless at scale',
  'Static routing',
  'Translation and fault finding',
];

/**
 * Lesson number → lab, from §11.1 with the approved SHOULD set of §8.5 (S2 yes; S11 and S12 not built, so lessons 28
 * and 26 have none; S4 has no lab of its own). Lessons not listed have no lab.
 */
const LAB_BY_LESSON: Readonly<Record<string, string>> = {
  '02': 'ccna2-switch-management',
  '05': 'ccna2-vlan-access-ports',
  '06': 'ccna2-trunk-native-allowed',
  '07': 'ccna2-dtp-modes',
  '09': 'ccna2-router-on-a-stick',
  '10': 'ccna2-l3-switch-svis',
  '11': 'ccna2-troubleshoot-vlans',
  '13': 'ccna2-stp-root-placement',
  '15': 'ccna2-rapid-stp',
  '16': 'ccna2-stp-guards',
  '17': 'ccna2-etherchannel-lacp',
  '19': 'ccna2-dhcpv6',
  '21': 'ccna2-hsrp-gateway',
  '23': 'ccna2-port-security',
  '27': 'ccna2-wlc-wlan',
  '30': 'ccna2-static-routes',
  '31': 'ccna2-floating-static',
  '32': 'ccna2-ipv6-static',
  '33': 'ccna2-nat-pat',
  '34': 'ccna2-troubleshoot-routing',
};

/** Labs of items that are not in the approved scope (§8.5): no lesson may point at them. */
const UNAPPROVED_LABS = ['ccna2-channel-plan', 'ccna2-wlan-enterprise'];

/**
 * Spec §2.2 (CCNA 2 engine requirements), transcribed cluster by cluster: one entry per requirement a learner is
 * taught. §11.4 requires a traceability row for each of them.
 */
const SPEC_2_2: readonly (readonly [cluster: string, objectives: readonly string[]])[] = [
  ['Switch config', [
    'Port security with static, sticky and dynamic addresses',
    'Port security violation modes shutdown, restrict and protect',
    'Err-disable and recovery',
    'Speed, duplex and auto-negotiation',
    'Automatic crossover (MDIX)',
  ]],
  ['VLANs', ['802.1Q tagging', 'Native VLAN', 'Access ports', 'Trunk and dynamic port modes', 'DTP', 'Allowed-VLAN lists', 'Voice VLAN', 'VLAN database', 'VTP v1/2/3']],
  ['Inter-VLAN routing', [
    'Legacy inter-VLAN routing (one router port per VLAN)',
    'Router-on-a-stick subinterfaces',
    'Layer 3 switch SVIs',
    'Layer 3 switch routed ports',
  ]],
  ['STP', [
    '802.1D',
    'PVST+',
    'Rapid PVST+',
    'MST',
    'Port roles root, designated, alternate and backup',
    'Root guard',
    'BPDU guard',
    'PortFast',
    'Loop guard',
    'Topology change events',
    'Per-VLAN root election',
  ]],
  ['EtherChannel', ['PAgP', 'LACP', 'Static bundles', 'Load-balancing algorithms', 'Misconfiguration detection']],
  ['Wireless', [
    'Wireless LAN controller',
    'Lightweight access points',
    'Autonomous access points',
    'CAPWAP tunnels',
    'SSID and WLAN profiles',
    'RF channels and overlap',
    '2.4, 5 and 6 GHz bands',
    'WPA2/WPA3 personal',
    'WPA2/WPA3 enterprise',
    'Roaming',
    'Client association state machine',
  ]],
  ['Routing concepts', [
    'Directly connected routes',
    'Static routes: next hop, exit interface and fully specified',
    'Default routes',
    'Floating static routes',
    'Host routes',
    'Recursive lookup',
    'Longest prefix match',
    'Administrative distance',
    'Load balancing',
  ]],
  ['IPv6 routing', ['Static IPv6 routes', 'Link-local next hops', 'Dual stack']],
  ['DHCP', ['DHCP server', 'DHCP client', 'DHCP relay', 'Excluded addresses', 'DHCP bindings', 'DHCPv6']],
  ['NAT', ['Static NAT', 'Dynamic NAT pool', 'PAT with an interface and with a pool', 'Inside, outside, local and global terms', 'Port forwarding']],
  ['Redundancy', ['HSRPv1/v2']],
];

/**
 * §11.4 objective traceability as data: objective → the lesson that teaches it (hands-on or theory), or
 * `untaught:<stage>` with the stage that will. A CCNA 1 lesson may stand for an objective that course already teaches.
 */
const TRACEABILITY: Readonly<Record<string, string>> = {
  'Port security with static, sticky and dynamic addresses': 'ccna2-23-port-security',
  'Port security violation modes shutdown, restrict and protect': 'ccna2-23-port-security',
  'Err-disable and recovery': 'ccna2-23-port-security',
  'Speed, duplex and auto-negotiation': 'ccna2-03-speed-duplex-and-cabling',
  'Automatic crossover (MDIX)': 'ccna2-03-speed-duplex-and-cabling',
  '802.1Q tagging': 'ccna2-06-trunks-and-tags',
  'Native VLAN': 'ccna2-06-trunks-and-tags',
  'Access ports': 'ccna2-05-access-ports-and-the-vlan-list',
  'Trunk and dynamic port modes': 'ccna2-07-trunk-negotiation',
  DTP: 'ccna2-07-trunk-negotiation',
  'Allowed-VLAN lists': 'ccna2-06-trunks-and-tags',
  'Voice VLAN': 'ccna2-08-voice-vlans',
  'VLAN database': 'ccna2-05-access-ports-and-the-vlan-list',
  'VTP v1/2/3': 'ccna2-05-access-ports-and-the-vlan-list',
  'Legacy inter-VLAN routing (one router port per VLAN)': 'ccna2-09-router-on-a-stick',
  'Router-on-a-stick subinterfaces': 'ccna2-09-router-on-a-stick',
  'Layer 3 switch SVIs': 'ccna2-10-multilayer-switching',
  'Layer 3 switch routed ports': 'ccna2-10-multilayer-switching',
  '802.1D': 'ccna2-14-port-roles-states-and-timers',
  'PVST+': 'ccna2-13-electing-a-root',
  'Rapid PVST+': 'ccna2-15-rapid-spanning-tree',
  MST: 'ccna2-15-rapid-spanning-tree',
  'Port roles root, designated, alternate and backup': 'ccna2-14-port-roles-states-and-timers',
  'Root guard': 'ccna2-16-edge-ports-and-guards',
  'BPDU guard': 'ccna2-16-edge-ports-and-guards',
  PortFast: 'ccna2-16-edge-ports-and-guards',
  'Loop guard': 'ccna2-16-edge-ports-and-guards',
  'Topology change events': 'ccna2-14-port-roles-states-and-timers',
  'Per-VLAN root election': 'ccna2-13-electing-a-root',
  PAgP: 'ccna2-17-bundling-links',
  LACP: 'ccna2-17-bundling-links',
  'Static bundles': 'ccna2-17-bundling-links',
  'Load-balancing algorithms': 'ccna2-17-bundling-links',
  'Misconfiguration detection': 'ccna2-17-bundling-links',
  'Wireless LAN controller': 'ccna2-27-wlans-on-a-controller',
  'Lightweight access points': 'ccna2-25-controllers-and-lightweight-aps',
  'Autonomous access points': 'ccna2-25-controllers-and-lightweight-aps',
  'CAPWAP tunnels': 'ccna2-25-controllers-and-lightweight-aps',
  'SSID and WLAN profiles': 'ccna2-27-wlans-on-a-controller',
  'RF channels and overlap': 'ccna2-26-channels-and-overlap',
  '2.4, 5 and 6 GHz bands': 'ccna2-26-channels-and-overlap',
  'WPA2/WPA3 personal': 'ccna2-28-securing-a-wlan',
  'WPA2/WPA3 enterprise': 'ccna2-28-securing-a-wlan',
  Roaming: 'ccna2-25-controllers-and-lightweight-aps',
  'Client association state machine': 'ccna2-27-wlans-on-a-controller',
  'Directly connected routes': 'ccna2-29-how-a-router-chooses',
  'Static routes: next hop, exit interface and fully specified': 'ccna2-30-static-route-forms',
  'Default routes': 'ccna2-31-default-and-floating-routes',
  'Floating static routes': 'ccna2-31-default-and-floating-routes',
  'Host routes': 'ccna2-30-static-route-forms',
  'Recursive lookup': 'ccna2-29-how-a-router-chooses',
  'Longest prefix match': 'ccna2-29-how-a-router-chooses',
  'Administrative distance': 'ccna2-29-how-a-router-chooses',
  'Load balancing': 'ccna2-29-how-a-router-chooses',
  'Static IPv6 routes': 'ccna2-32-ipv6-static-routes',
  'Link-local next hops': 'ccna2-32-ipv6-static-routes',
  'Dual stack': 'ccna2-32-ipv6-static-routes',
  'DHCP server': 'ccna1-19-dhcp',
  'DHCP client': 'ccna1-19-dhcp',
  'DHCP relay': 'ccna2-18-dhcp-across-vlans',
  'Excluded addresses': 'ccna1-19-dhcp',
  'DHCP bindings': 'ccna1-19-dhcp',
  DHCPv6: 'ccna2-19-slaac-and-dhcpv6',
  'Static NAT': 'ccna2-33-address-translation',
  'Dynamic NAT pool': 'ccna2-33-address-translation',
  'PAT with an interface and with a pool': 'ccna2-33-address-translation',
  'Inside, outside, local and global terms': 'ccna2-33-address-translation',
  'Port forwarding': 'ccna2-33-address-translation',
  'HSRPv1/v2': 'ccna2-21-hot-standby-gateways',
};

describe('CCNA 2 lesson skeleton', () => {
  it('has 34 lessons in 11 modules, in a stable order', () => {
    expect(CCNA2_MODULES.map((m) => m.title)).toEqual(MODULE_TITLES);
    expect(lessons().map((l) => l.id)).toEqual(CCNA2_ORDER);
  });

  it('numbers lessons ccna2-01 … ccna2-34 and modules ccna2-m1 … ccna2-m11, all kebab-case and unique', () => {
    lessons().forEach((l, i) => {
      expect(l.id, l.id).toMatch(KEBAB);
      expect(l.id.startsWith(`ccna2-${String(i + 1).padStart(2, '0')}-`), l.id).toBe(true);
    });
    CCNA2_MODULES.forEach((m, i) => {
      expect(m.id, m.id).toMatch(KEBAB);
      expect(m.id.startsWith(`ccna2-m${i + 1}-`), m.id).toBe(true);
      expect(m.summary.trim().length, `${m.id} has no summary`).toBeGreaterThan(0);
      expect(m.lessons.length, `${m.id} has no lessons`).toBeGreaterThan(0);
    });
    const ids = [...CCNA2_MODULES.map((m) => m.id), ...lessons().map((l) => l.id)];
    const ccna1 = [...CCNA1_MODULES.map((m) => m.id), ...CCNA1_MODULES.flatMap((m) => m.lessons.map((l) => l.id))];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => ccna1.includes(id))).toEqual([]);
  });

  it('gives every lesson a title, an outcome, its module title as topic, and at most 45 minutes', () => {
    for (const m of CCNA2_MODULES) {
      for (const l of m.lessons) {
        expect(l.title.trim().length, `${l.id} has no title`).toBeGreaterThan(0);
        expect(l.outcome.trim().length, `${l.id} has no outcome`).toBeGreaterThan(0);
        expect(l.outcome.trim().endsWith('.'), `${l.id}: the outcome is one sentence ending in a full stop`).toBe(true);
        expect(l.topic, l.id).toBe(m.title);
        expect(l.estimatedMinutes, `${l.id} takes no time`).toBeGreaterThan(0);
        expect(l.estimatedMinutes, `${l.id} runs over 45 minutes`).toBeLessThanOrEqual(45);
        expect(Number.isInteger(l.estimatedMinutes)).toBe(true);
      }
    }
  });

  it('is a skeleton: no theory and no video yet', () => {
    for (const l of lessons()) {
      expect(l.theory, l.id).toBe('');
      expect(l.video, l.id).toBeUndefined();
    }
  });

  it('attaches exactly the §11.1 lab of each lesson, for the approved scope', () => {
    for (const l of lessons()) {
      const nn = l.id.slice('ccna2-'.length, 'ccna2-'.length + 2);
      expect(l.lab, l.id).toBe(LAB_BY_LESSON[nn]);
    }
  });

  it('reaches every lab of the approved scope from exactly one lesson (19 MUST labs plus the S2 lab)', () => {
    const used = lessons()
      .map((l) => l.lab)
      .filter((name): name is string => name !== undefined);
    expect(used.length).toBe(20);
    expect(new Set(used).size, `a lab is attached twice: ${used.join(', ')}`).toBe(used.length);
    expect([...used].sort()).toEqual(Object.values(LAB_BY_LESSON).sort());
    for (const name of used) {
      expect(name, name).toMatch(KEBAB);
      expect(name.startsWith('ccna2-'), name).toBe(true);
    }
    for (const name of UNAPPROVED_LABS) expect(used, name).not.toContain(name);
  });

  it('names only labs that exist in SCENARIOS as CCNA 2 labs, except the wireless lab of W7 (§11.3)', () => {
    const wireless = 'ccna2-wlc-wlan';
    const named = lessons()
      .map((l) => l.lab)
      .filter((name): name is string => name !== undefined && name !== wireless);
    expect(named.length).toBe(19);
    for (const name of named) {
      const lab = SCENARIOS.find((s) => s.name === name);
      expect(lab, `${name} is not in SCENARIOS`).toBeDefined();
      expect(lab?.category, name).toBe('ccna2-lab');
    }
  });

  it('uses original wording with no vendor names', () => {
    const strings = CCNA2_MODULES.flatMap((m) => [m.title, m.summary, ...m.lessons.flatMap((l) => [l.title, l.outcome, l.topic])]);
    for (const s of strings) expect(s, s).not.toMatch(VENDORS);
  });
});

describe('CCNA 2 objective traceability (§11.4)', () => {
  const known = new Set([...lessons().map((l) => l.id), ...CCNA1_MODULES.flatMap((m) => m.lessons.map((l) => l.id))]);
  const objectives = SPEC_2_2.flatMap(([, list]) => [...list]);

  it('gives every spec §2.2 objective a row, and has no row for anything else', () => {
    expect(SPEC_2_2.map(([c]) => c)).toEqual([
      'Switch config',
      'VLANs',
      'Inter-VLAN routing',
      'STP',
      'EtherChannel',
      'Wireless',
      'Routing concepts',
      'IPv6 routing',
      'DHCP',
      'NAT',
      'Redundancy',
    ]);
    expect(new Set(objectives).size, 'an objective is listed twice').toBe(objectives.length);
    const missing = objectives.filter((o) => !Object.prototype.hasOwnProperty.call(TRACEABILITY, o));
    expect(missing, `objectives with no row: ${missing.join(', ')}`).toEqual([]);
    const extra = Object.keys(TRACEABILITY).filter((o) => !objectives.includes(o));
    expect(extra, `rows for no objective: ${extra.join(', ')}`).toEqual([]);
  });

  it('points every row at a lesson that exists, or at a later stage', () => {
    const wrong = Object.entries(TRACEABILITY)
      .filter(([, where]) => !known.has(where) && !/^untaught:P\d$/.test(where))
      .map(([o, w]) => `${o} -> ${w}`);
    expect(wrong, `rows that point nowhere:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('leaves no CCNA 2 lesson without an objective unless it teaches a named concept of its own', () => {
    const traced = new Set(Object.values(TRACEABILITY));
    const conceptOnly = new Set([
      'ccna2-01-how-a-switch-forwards',
      'ccna2-02-managing-a-switch',
      'ccna2-04-why-split-a-lan',
      'ccna2-11-fixing-inter-vlan-routing',
      'ccna2-12-what-a-loop-does',
      'ccna2-20-one-gateway-one-point-of-failure',
      'ccna2-22-threats-at-layer-2',
      'ccna2-24-hardening-switch-ports',
      'ccna2-34-finding-faults',
    ]);
    const orphans = lessons()
      .map((l) => l.id)
      .filter((id) => !traced.has(id) && !conceptOnly.has(id));
    expect(orphans).toEqual([]);
    for (const id of conceptOnly) expect(known.has(id), id).toBe(true);
  });
});
