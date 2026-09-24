/**
 * sim/scenarios/ccna2/index.ts — the CCNA 2 lab catalogue in course order (ARCHITECTURE-P2 §7 W5, §11.1, §11.2).
 *
 * The arc follows the CCNA 2 lessons: manage a switch, split it into VLANs, carry them over trunks and negotiate
 * those, route between VLANs on a stick and on a multilayer switch, repair a broken VLAN design, elect and tune the
 * spanning tree, bundle links, hand out IPv6 addresses, share a gateway, lock down access ports, route statically
 * (forms, floating routes, IPv6), translate addresses and, last, find faults in a routed network.
 *
 * Eleven files hold the labs, each exporting one array under a fixed name (vlans, trunks, intervlan, stp, etherchannel,
 * dhcpv6, [S2] fhrp, security, routing, nat, troubleshooting). `CCNA2_LAB_ORDER` is the course order of the lab
 * NAMES — the `ScenarioInfo.name` the lesson skeleton (curriculum/ccna2/lessons.ts) points at — and `CCNA2_LABS` is
 * every lab of the eleven arrays sorted by it: a name whose lab has not landed yet is simply absent, and a lab whose
 * name the order does not know sorts last (test/labs.ccna2.solutions.test.ts refuses that). The wireless lab
 * `ccna2-wlc-wlan` (lesson 27) arrives with W7 (`ccna2/wireless.ts`), which adds its name here at its lesson position.
 *
 * Every entry is a `ScenarioInfo` with `category: 'ccna2-lab'`, `course: 'CCNA 2'`, `topic` = the title of the
 * module that holds its lesson, a fixed seed, a P2-profile topology (`topology(…, { profile: 'P2' })`, schema 1.2),
 * tasks whose assertions read structured state (sim/lab-checks.ts) and a reference `solution` that
 * `Simulation.configure` accepts as written (test/labs.ccna2.solutions.test.ts).
 *
 * ponytail: the arrays are read at module scope, as ccna1/index.ts does; that is safe because the lab files import
 * only the contracts, `../kit.js` and `../templates.js` — none imports this module, `../index.js` or the engine
 * barrel — so the scenario tree stays acyclic (the rule-12 hazard is a cycle, f4f883e).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { CCNA2_DHCPV6_LABS } from './dhcpv6.js';
import { CCNA2_ETHERCHANNEL_LABS } from './etherchannel.js';
import { CCNA2_FHRP_LABS } from './fhrp.js';
import { CCNA2_INTERVLAN_LABS } from './intervlan.js';
import { CCNA2_NAT_LABS } from './nat.js';
import { CCNA2_ROUTING_LABS } from './routing.js';
import { CCNA2_SECURITY_LABS } from './security.js';
import { CCNA2_STP_LABS } from './stp.js';
import { CCNA2_TROUBLESHOOTING_LABS } from './troubleshooting.js';
import { CCNA2_TRUNK_LABS } from './trunks.js';
import { CCNA2_VLAN_LABS } from './vlans.js';

export * from './vlans.js';
export * from './trunks.js';
export * from './intervlan.js';
export * from './stp.js';
export * from './etherchannel.js';
export * from './dhcpv6.js';
export * from './fhrp.js';
export * from './security.js';
export * from './routing.js';
export * from './nat.js';
export * from './troubleshooting.js';

/** The CCNA 2 lab names in the order the course meets them (§11.1; the lesson number in each comment). */
export const CCNA2_LAB_ORDER: readonly string[] = Object.freeze([
  'ccna2-switch-management', // 02
  'ccna2-vlan-access-ports', // 05
  'ccna2-trunk-native-allowed', // 06
  'ccna2-dtp-modes', // 07
  'ccna2-router-on-a-stick', // 09
  'ccna2-l3-switch-svis', // 10
  'ccna2-troubleshoot-vlans', // 11
  'ccna2-stp-root-placement', // 13
  'ccna2-rapid-stp', // 15
  'ccna2-stp-guards', // 16
  'ccna2-etherchannel-lacp', // 17
  'ccna2-dhcpv6', // 19
  'ccna2-hsrp-gateway', // 21 [S2]
  'ccna2-port-security', // 23 (with the lesson 24 hardening tasks)
  'ccna2-static-routes', // 30
  'ccna2-floating-static', // 31
  'ccna2-ipv6-static', // 32
  'ccna2-nat-pat', // 33 ([S9] port-forward task)
  'ccna2-troubleshoot-routing', // 34
]);

/** The labs of `files` sorted by `order` (stable; a name `order` does not list sorts last, in file order). */
function inCourseOrder(files: readonly (readonly ScenarioInfo[])[], order: readonly string[]): readonly ScenarioInfo[] {
  const rank = (name: string): number => {
    const at = order.indexOf(name);
    return at < 0 ? order.length : at;
  };
  return Object.freeze(
    files
      .flat()
      .map((lab, i) => ({ lab, i }))
      .sort((x, y) => rank(x.lab.name) - rank(y.lab.name) || x.i - y.i)
      .map((e) => e.lab),
  );
}

/** The CCNA 2 labs, in the order the course meets them (`CCNA2_LAB_ORDER`). */
export const CCNA2_LABS: readonly ScenarioInfo[] = inCourseOrder(
  [
    CCNA2_VLAN_LABS,
    CCNA2_TRUNK_LABS,
    CCNA2_INTERVLAN_LABS,
    CCNA2_STP_LABS,
    CCNA2_ETHERCHANNEL_LABS,
    CCNA2_DHCPV6_LABS,
    CCNA2_FHRP_LABS,
    CCNA2_SECURITY_LABS,
    CCNA2_ROUTING_LABS,
    CCNA2_NAT_LABS,
    CCNA2_TROUBLESHOOTING_LABS,
  ],
  CCNA2_LAB_ORDER,
);
