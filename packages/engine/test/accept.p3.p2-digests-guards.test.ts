/**
 * P3 acceptance — the P2-profile golden, shard 4 of 4: the two synthetic D22 guard worlds (ARCHITECTURE-P3 §0 rule 5,
 * D3, D22, §9.3 (a), §9.4 (a), §10.1 row `accept.p3.p2-digests-guards`; recorded in W0 from the unchanged engine at
 * 5263f16).
 *
 * `guard-switch-svi/P1` and `guard-switch-svi/P2`: the same world in profile P1 (schema 1.1) and profile P2 (schema
 * 1.2) — an NF-C2960 whose Vlan1 is 192.168.1.2/24 and up, an NF-2911 serving DHCP on that VLAN, two PCs that take a
 * lease at 60 s (their DISCOVER and REQUEST broadcasts reach the SVI), a `traceroute` from the router to the SVI and a
 * browser fetch of `http://192.168.1.2/` from PC1 at 90 s. No shipped world addresses a switch SVI in a VLAN that
 * carries UDP or TCP, so without these two the dormant-transport rule (D22) would be guarded by nothing.
 *
 * Both worlds must equal their recorded digests exactly (test/p2-digests.harness.ts). The guard facts are asserted as
 * well, so the golden can never have been recorded from a world that misses the path: every DISCOVER and REQUEST
 * still dies in ipv4 as `unsupported-protocol`, the switch delivers nothing to udp or tcp and answers with ICMP
 * protocol unreachable, the traceroute stops on `!2` (the flag of ICMP code 2), and the fetch fails the P2 way
 * (an error tab: "The connection failed (proto-unreachable).").
 */
import { describe, expect, it } from 'vitest';
import { describeP2DigestShard, freshRun, guardProblems, shardWorlds } from './p2-digests.harness.js';

describeP2DigestShard('guards', 'accept P3: the P2-profile digests of the D22 guard worlds');

describe('accept P3: the D22 guard worlds exercise the dormant switch transport', () => {
  for (const w of shardWorlds('guards')) {
    it(`${w.name}: DHCP broadcasts, the traceroute and the fetch reach the switch SVI and meet the P2 answer`, () => {
      expect(guardProblems(freshRun(w)), w.name).toEqual([]);
    });
  }
});
