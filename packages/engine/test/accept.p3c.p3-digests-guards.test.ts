/**
 * P3c acceptance — the P3-profile golden, shard 5 of 5: the P3 sandbox and the two guard worlds (ARCHITECTURE-P3C §0
 * rules 5 and 9, D3, §9.5, §10.1 row `accept.p3c.p3-digests-guards`; recorded in W0 from the unchanged engine at
 * cad4ac9).
 *
 *   • `p3-sandbox-add-device` — the P2 sandbox's seven models placed through `addDevice` / `addLink` in
 *     `createSimulation({profile: 'P3'})`: pins the new-world `profileConfig` path of P3 (CDP, `service timestamps`,
 *     extended logging); the show is `show cdp neighbors`.
 *   • `guard-udp-69-161/P3` (guard world 1) — an NF-C2960 whose Vlan1 is addressed and up, an NF-2911 and a server:
 *     at 90 s the server sends a TFTP read request to UDP 69 and an SNMP v2c GetRequest to UDP 161, at the switch SVI
 *     and at the router. Its digest entries move once, at W1b, when these datagrams start decoding as `tftp` / `snmp`
 *     (§9.5: decode only; the architect re-records exactly this world in the W1b fix run). Its PASS CONDITION is
 *     asserted below from the live world on every run and is never re-recorded: the dormant switch answers protocol
 *     unreachable and its udp handles nothing, the router answers port unreachable, and neither holds a `sockets` row.
 *   • `guard-ipv6-static/P3` (guard world 2) — a dual-stack router pair with IPv4 and IPv6 static routes and a PC on
 *     each LAN, pinging over both families: no OSPF PDU of either version (no next header 89), no ff02::5 / ff02::6 in
 *     any event or in the end snapshot (no join), and the rib6 rows byte-identical through the snapshot hashes.
 *
 * Every world must equal test/goldens/p3-profile-digests.json exactly (test/profile-digests.harness.ts). Only the
 * architect re-records, entry by entry, as §9.5 lists:
 * `NF_RECORD_P3_DIGESTS=<world id> npx vitest run --root packages/engine test/accept.p3c.p3-digests-guards.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { P3_GUARD_WORLDS, describeProfileDigestShard, p3GuardIpv6Problems, p3GuardUdpProblems, profileFreshRun, profileShardWorlds } from './profile-digests.harness.js';

describeProfileDigestShard('P3', 'guards', 'accept P3c: the P3-profile digests of the P3 sandbox and the guard worlds');

describe('accept P3c: the guard worlds put the P3c daemons at risk and meet the cad4ac9 answer (never re-recorded)', () => {
  const world = (name: string) => {
    const w = profileShardWorlds('P3', 'guards').find((x) => x.name === name);
    if (w === undefined) throw new Error(`the P3 golden's guards shard has no world ${name}`);
    return w;
  };

  it(`${P3_GUARD_WORLDS.udp}: UDP 69 and 161 reach a dormant switch (protocol unreachable) and a router (port unreachable), no sockets row`, () => {
    expect(p3GuardUdpProblems(profileFreshRun('P3', world(P3_GUARD_WORLDS.udp)))).toEqual([]);
  }, 180_000);

  it(`${P3_GUARD_WORLDS.ipv6}: IPv6 static routing pings with no OSPF PDU of either version and no ff02::5/6 join`, () => {
    expect(p3GuardIpv6Problems(profileFreshRun('P3', world(P3_GUARD_WORLDS.ipv6)))).toEqual([]);
  }, 180_000);
});
