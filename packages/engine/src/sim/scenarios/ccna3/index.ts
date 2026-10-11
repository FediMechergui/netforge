/**
 * sim/scenarios/ccna3/index.ts — the CCNA 3 lab catalogue in course order (ARCHITECTURE-P3 §7 W5, §11.1, §11.2).
 *
 * The arc follows the CCNA 3 lessons: elect a designated router, switch OSPF on in one area, steer it by cost, hand
 * out a default route and fix a broken OSPF network; read EIGRP's successor and feasible successor; filter with
 * standard, extended and edited access lists; lock down device access and guard the access layer; join two sites
 * over a serial link with HDLC and PPP; build a GRE tunnel and protect it with IPsec; put voice first on a congested
 * link; discover the neighbours; set the clocks and collect the logs; apply a fault-finding method to EIGRP and then
 * across a whole enterprise; and, last, drive devices through their API and from a script.
 *
 * Eleven files hold the labs, each exporting one array under a fixed name and owned by the area that knows the feature
 * (§11.2, rule 18): ospf, eigrp ([C1]), acl, hardening, wan ([S19]'s PPP tasks), vpn ([S18], [C13]), qos ([S20],
 * [S21]), discovery, time ([S24], [S25]), troubleshooting and — from W6 — automation (lab 38 and [S32] lab 40).
 * `CCNA3_LAB_ORDER` is the course order of the lab NAMES — the `ScenarioInfo.name` the lesson skeleton
 * (curriculum/ccna3/lessons.ts) points at — and already lists the two automation labs, so W6 adds only the import
 * of `./automation.js` and its array. `CCNA3_LABS` is every lab of the arrays sorted by it: a name whose lab has not
 * landed yet is simply absent, and a lab whose name the order does not know sorts last (the solutions test refuses
 * that), exactly as ccna2/index.ts does.
 *
 * Every entry is a `ScenarioInfo` with `category: 'ccna3-lab'`, `course: 'CCNA 3'`, `topic` = the title of the
 * module that holds its lesson, a fixed seed, a P3-profile topology (`topology(…, { profile: 'P3' })`, schema 1.3),
 * tasks whose assertions read structured state with the §2.10 kinds and a reference `solution` that
 * `Simulation.configure` accepts as written (test/labs.ccna3.solutions.test.ts).
 *
 * ponytail: the arrays are read at module scope, as ccna2/index.ts does; that is safe because the lab files import
 * only the contracts, `../kit.js` and `../templates.js` — none imports this module, `../index.js` or the engine
 * barrel — so the scenario tree stays acyclic (the rule-12 hazard is a cycle).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { CCNA3_ACL_LABS } from './acl.js';
import { CCNA3_DISCOVERY_LABS } from './discovery.js';
import { CCNA3_EIGRP_LABS } from './eigrp.js';
import { CCNA3_HARDENING_LABS } from './hardening.js';
import { CCNA3_OSPF_LABS } from './ospf.js';
import { CCNA3_QOS_LABS } from './qos.js';
import { CCNA3_TIME_LABS } from './time.js';
import { CCNA3_TROUBLESHOOTING_LABS } from './troubleshooting.js';
import { CCNA3_VPN_LABS } from './vpn.js';
import { CCNA3_WAN_LABS } from './wan.js';

export * from './ospf.js';
export * from './eigrp.js';
export * from './acl.js';
export * from './hardening.js';
export * from './wan.js';
export * from './vpn.js';
export * from './qos.js';
export * from './discovery.js';
export * from './time.js';
export * from './troubleshooting.js';

/**
 * The CCNA 3 lab names in the order the course meets them (§11.1; the lesson number in each comment). The 21 labs of
 * the approved plan (§8.4, §8.5), the two automation labs of W6 included.
 */
export const CCNA3_LAB_ORDER: readonly string[] = Object.freeze([
  'ccna3-ospf-dr-election', // 03
  'ccna3-ospf-single-area', // 04
  'ccna3-ospf-cost', // 05
  'ccna3-ospf-default-route', // 06
  'ccna3-troubleshoot-ospf', // 07
  'ccna3-eigrp-feasible-successor', // 10 [C1]
  'ccna3-acl-standard', // 15 ([S13] vty-ACL login tasks)
  'ccna3-acl-extended', // 16
  'ccna3-acl-edit-verify', // 17
  'ccna3-secure-device-access', // 19 ([S13] login tasks)
  'ccna3-dhcp-snooping-dai', // 20
  'ccna3-serial-links', // 22 ([S19] PPP tasks)
  'ccna3-gre-tunnel', // 24 [S18]
  'ccna3-ipsec-site-to-site', // 25 [C13]
  'ccna3-qos-voice-first', // 27 ([S20] LLQ and [S21] policing tasks)
  'ccna3-discover-neighbours', // 28
  'ccna3-time-and-logs', // 29 ([S24]/[S25] logging tasks)
  'ccna3-troubleshoot-eigrp', // 33 [C1]
  'ccna3-troubleshoot-enterprise', // 34
  'ccna3-restconf-change', // 38 (W6, automation.ts)
  'ccna3-script-inventory', // 40 [S32] (W6, automation.ts)
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

/** The CCNA 3 labs, in the order the course meets them (`CCNA3_LAB_ORDER`). */
export const CCNA3_LABS: readonly ScenarioInfo[] = inCourseOrder(
  [
    CCNA3_OSPF_LABS,
    CCNA3_EIGRP_LABS,
    CCNA3_ACL_LABS,
    CCNA3_HARDENING_LABS,
    CCNA3_WAN_LABS,
    CCNA3_VPN_LABS,
    CCNA3_QOS_LABS,
    CCNA3_DISCOVERY_LABS,
    CCNA3_TIME_LABS,
    CCNA3_TROUBLESHOOTING_LABS,
  ],
  CCNA3_LAB_ORDER,
);
