# P3a exit gate (W8): scope audit

Audit of the scope list the product owner approved in ARCHITECTURE-P3 §8.5 P13: M1–M19, S1, S2, S3, S9, S13, S18,
S19, S20, S21, S24, S25, S32, S37, C1 and C13 each shipped, and every other SHOULD and COULD item recorded with its
stage from §12.1. Checked on 2026-10-13 against branch `p3` at the W7 commit 0596930 plus the W8 working tree (stage 1
of W8: the docs only; the W8 contract items 45–47 run beside or after this audit and are not part of the evidence).

**Method.** For each approved row: the source files that carry it (read in the tree, not taken from the brief), the
acceptance files §10.1 names for it (each checked to exist under `packages/engine/test/`), the web tests §10.2 names,
and the lab or lesson §11 gives it (each lab name checked in `sim/scenarios/ccna3/*.ts` and `CCNA3_LAB_ORDER`). For
each item that is not approved: its stage from §12.1, and a search of `packages/engine/src` and `apps/web/src` for its
command words, daemon, table, kind, overlay or app id, so that no unapproved feature was built. Running the six checks,
the slow project, the digest goldens and gate G is the lead's part of the gate (§7 W8) and is not recorded here.

## Result

- **34 of 34 approved rows SHIPPED.** Nothing approved is missing.
- **No unapproved item was built.** Two partial overlaps are explained below (`show cdp traffic` / `show cdp
  interface`, which §5.8 lists as MUST lines, and the GRE `recursive-routing` down reason, which belongs to [S18]'s
  tunnel row); neither builds the unapproved item.
- §10.1: all 55 required `accept.p3.*.test.ts` files exist (55 files in the directory, every one listed); none of the
  11 files of unapproved items exists (`ospf-multiarea`, `ospf-auth`, `ospfv3`, `acl-ipv6`, `storm-control`,
  `fragmentation`, `gre-recursion`, `tftp`, `password-recovery`, `snmp`, `span`).
- §10.2: every named web test exists, one under another name (gap 1).
- Course: 40 lessons (40 theory bodies over `theory-a` 10, `-b` 12, `-c` 14, `-d` 4; 40 entries in `CCNA3_VIDEOS`),
  21 labs (16 MUST + 24 [S18], 40 [S32], 10 and 33 [C1], 25 [C13]), CCNA 3 `available` with `profile: 'P3'`, the
  planned security-track card (`profile: 'P3'`, §8.5 P11), 81 objectives in `curriculum/ccna3/objectives.ts` (45
  `lab`, 9 `theory`, 18 `later:P3c`, 6 `untaught:P4`, 3 `untaught:P5`, matching §11.4).
- Gaps and open items for the lead: see the last section (none blocks the scope list).

Paths below are relative to `packages/engine/src/` unless they start with `apps/web/`; acceptance files are under
`packages/engine/test/` and drop their `accept.p3.` prefix and `.test.ts` suffix where marked "accept:".

## MUST (M1–M19)

| # | Feature | Shipped evidence | Acceptance (§10.1) and other proof | Lab / lesson | Verdict |
|---|---|---|---|---|---|
| M1 | P3 profile, schema 1.3, defaults ladder, P2-profile goldens, `Course.profile`, `ConceptToolId` | `contracts/catalog.ts` (`'P3'` profile, `LATEST_DEFAULTS_PROFILE = 'P3'` since W7), `contracts/topology.ts` (`TOPOLOGY_SCHEMA_ID_1_3`), `io/schema.ts`, `io/migrate.ts`, `sim/defaults-upgrade.ts`, `protocols/arp.ts` (`proxyArpEnabled`, the `arp.ts:178` trap), `device/catalog/define.ts` (`deriveCdpDefault`), `curriculum/index.ts` (`Course.profile`), `contracts/scenario.ts` (`ConceptToolId`); web `apps/web/src/learn/course-profile.ts`, `app/StatusBar.tsx` (the "Classic defaults" chip), `app/FileMenu.tsx` ("Use current defaults") | accept: `profile`, `silence`, `p2-digests-templates`, `p2-digests-labs-a`, `p2-digests-labs-b`, `p2-digests-guards`, `p2-exports`, `lab-status`; goldens `test/goldens/p2-profile-digests.json`, `p2-lab-exports.json`, `lab-status.p2.json`; web `learn.course-profile.test.ts`, `worker.profile.test.ts` | every CCNA 3 lab is a P3 world (`topology(…, {profile: 'P3'})`) | SHIPPED |
| M2 | Engineering health | `apps/web/tsconfig.test.json` (check 3b), `packages/engine/vitest.workspace.ts` (`fast` / `slow` projects, `SLOW_TESTS`), `test/staged.world.ts` (W8 thins it, item of builder staged-thin), `test/inject.ts` (the injector) | `staged.world.p3-parity.test.ts`; web `worker.delta.test.ts` | — | SHIPPED |
| M3 | Grader v3 | `sim/lab-checks.ts`, `sim/lab-checks/` (`registry`, `core`, `facts`, `routing`, `ospf`, `acl`, `hardening`, `discovery`, `time`, `automation`, `qos`, `traffic`, `service`, `path`, `eigrp`, `wan`, `switching`), `contracts/scenario.ts` (`neighbor`, `fact`, `acl`, `aclDecision`, the widened `connectivity`, `route`, `table`, `cut`, `LabFault`), the `tcp.probe` / `udp.probe` requests (`contracts/process.ts`, `protocols/tcp.ts`, `protocols/udp.ts`) | accept: `grader-bounded`, `lab-status`, `labs`; `sim.lab-checks.registry`, `sim.lab-checks.p3*.test.ts`, `sim.lab-checks.clone.p3.test.ts` | every CCNA 3 lab | SHIPPED (`ScenarioInfo.customChecks` is removed by W8 item 46, in flight) |
| M4 | OSPF wire and L3 plumbing | `pdu/codecs/ospf.ts`, `core/ospf-lsa.ts` and `pdu/checksum.ts` (both checksums), `protocols/ip-upper.ts` (`IPV4_UPPER` 89), `protocols/ipv4.ts` (`ipv4.routes`, `ipv4.ribWatch` with keys and lpm), `core/rib-arbiter.ts` (multipath for `O`), `contracts/tables.ts` (`RouteRow.source 'O'`, `routeType`) | accept: `ospf-p2p`, `ospf-ecmp`, `ospf-convergence` | 03–07 | SHIPPED |
| M5 | OSPFv2 daemon | `protocols/ospf.ts`, `protocols/ospf/` (`config`, `cost`, `dr`, `flood`, `hello-check`, `ism`, `lsdb`, `nsm`, `originate`, `routes`), `core/ospf-spf.ts` (the pure SPF), `sim/lab-checks/ospf.ts` (fact and neighbour adapters) | accept: `ospf-p2p`, `ospf-dr-election`, `ospf-convergence`, `ospf-mismatch`, `ospf-default-originate`, `ospf-config`, `ospf-ecmp`, `ospf-scale`, `ospf-acl` | labs 03 `ccna3-ospf-dr-election`, 04 `ccna3-ospf-single-area`, 05 `ccna3-ospf-cost`, 06 `ccna3-ospf-default-route`, 07 `ccna3-troubleshoot-ospf` | SHIPPED |
| M6 | OSPF CLI and verification | `cli/grammar/ospf.ts`, `cli/handlers/ospf.ts` (`show ip ospf …`, `show ip protocols`, `show ip route ospf`, `clear ip ospf process`), the debug categories | accept: `ospf-config`, `ospf-mismatch`, `ospf-convergence` (exact `show ip route`); `cli.ospf.test.ts`; help golden `test/goldens/cli-help.p05.json` | 03–07 | SHIPPED |
| M7 | ACL core | `core/acl.ts` (extended matcher, port and ICMP names, `established`, `log`, remarks), `contracts/config.ts` (`ConfigNode.seq`, `ConfigLineRule.sequenced`), `cli/grammar/acl.ts` | accept: `acl-extended`, `acl-edit` | 15–17 | SHIPPED |
| M8 | `acl` daemon and hooks | `protocols/acl.ts`, the ipv4 and nat hooks (`protocols/ipv4.ts`, `protocols/nat.ts`), `contracts/port.ts` (`aclDenies`), `protocols/tcp.ts` (`admin-prohibited`), `sim/lab-checks/acl.ts` | accept: `acl-standard`, `acl-extended`, `acl-order`, `ospf-acl` | 15 `ccna3-acl-standard`, 16 `ccna3-acl-extended`, 17 `ccna3-acl-edit-verify` | SHIPPED |
| M9 | ACL CLI | `cli/grammar/acl.ts`, `cli/handlers/acl.ts` (`config-ext-nacl`, sequence edits, `ip access-group`, `show access-lists` with matches, `show ip interface`, `clear access-list counters`) | accept: `acl-edit`; help golden | 17 | SHIPPED |
| M10 | SSH-only device access (configuration) | `cli/grammar/ssh.ts`, `cli/grammar/hardening.ts`, `cli/grammar/line-auth.ts`, `cli/grammar/transport.ts` and their handlers (`crypto key generate rsa`, `ip ssh`, `username … secret` with `privilege`, `login local`, `transport input`, `access-class`, `show ip ssh` / `show ssh` / `show users`), `sim/lab-checks/hardening.ts` (`ssh.*`, `vty.*` facts) | accept: `device-access` | 19 `ccna3-secure-device-access` | SHIPPED |
| M11 | DHCP snooping | `protocols/l2/dhcp-snooping.ts`, `protocols/l2/rate-window.ts`, `cli/grammar/hardening.ts`, `cli/grammar/errdisable.ts` | accept: `dhcp-snooping` (with `test/inject.ts`) | 20 `ccna3-dhcp-snooping-dai` | SHIPPED |
| M12 | Dynamic ARP inspection | `protocols/l2/arp-inspection.ts` (the `arp-inspection` table), `cli/grammar/hardening.ts` | accept: `dai` | 20 | SHIPPED |
| M13 | QoS lite | `qos/` (`classify`, `config`, `mark`), `protocols/traffic.ts` (generator, discard sink, `flows`), `core/queueing.ts`, `cli/grammar/qos.ts`, `cli/grammar/host-shell.ts` (`flow`), `sim/lab-checks/qos.ts`; web `apps/web/src/canvas/qos.ts`, `canvas/overlays/qos-model.ts`, `desktop/apps/TrafficApp.tsx`, `concept/queueing/` | accept: `qos-marking`, `traffic-bounded`, `serial-control-priority`; web `overlays.qos-model`, `concept.queueing`, `desktop.traffic` | 26 (`concept:queueing`), 27 `ccna3-qos-voice-first` | SHIPPED |
| M14 | Discovery and the dormant switch transport | `protocols/cdp.ts`, `protocols/lldp.ts`, `pdu/codecs/cdp.ts`, `pdu/codecs/lldp.ts`, `protocols/ip-upper.ts` (`DORMANT_TRANSPORT_OWNERS`, D22), `protocols/l2/control.ts`, `cli/grammar/discovery.ts`, `sim/lab-checks/discovery.ts` | accept: `cdp`, `lldp`, `switch-transport`, `mgmt-scale`, `silence` | 28 `ccna3-discover-neighbours` | SHIPPED |
| M15 | Device clock and NTP | `contracts/clock.ts`, `protocols/ntp.ts`, `pdu/codecs/ntp.ts`, `cli/grammar/time.ts`, `cli/handlers/time.ts`, `sim/lab-checks/time.ts`; web `inspector/DeviceInspector.tsx` (clock) | accept: `clock-ntp` | 29 `ccna3-time-and-logs` | SHIPPED |
| M16 | Device API | `sim/configure.ts` (the configure seam, `config.result`, the origin), `protocols/http-client.ts` (`http.request`), `protocols/tcp.ts` (`tls`), `protocols/restconf.ts`, `automation/yang/` (`model`, `path`), `cli/grammar/api.ts` (`restconf`, the host-shell `rest`), `sim/lab-checks/automation.ts` | accept: `restconf`, `switch-transport` | 38 `ccna3-restconf-change` | SHIPPED |
| M17 | Data-formats playground | `automation/data/` (`json`, `yaml`, `xml`); web `apps/web/src/concept/data-formats/` | web `concept.data-formats`; `curriculum.ccna3.commands.test.ts` (the `json`/`yaml`/`xml` fences) | 37 (`concept:data-formats`) | SHIPPED |
| M18 | CCNA 3 course | `curriculum/ccna3/` (`lessons`, `objectives`, `theory-a`…`theory-d`, `theory`, `videos`), `curriculum/index.ts` (`available`, profile P3), `sim/scenarios/ccna3/` (11 lab files and `index.ts`, `CCNA3_LAB_ORDER`) | accept: `labs`, `replay-exact-ccna3`, `determinism`; `curriculum.ccna3.test.ts`, `curriculum.ccna3.commands.test.ts`, `curriculum.ccna3.videos.test.ts`, `labs.ccna3.*.test.ts` | 40 lessons, the 16 MUST labs (03–07, 15–17, 19, 20, 22, 27–29, 34, 38) | SHIPPED |
| M19 | Acceptance suite | the 55 files of §10.1, the web tests of §10.2 | accept: `coverage` (reads §10.1 and the directory) | — | SHIPPED |

## Approved SHOULD and COULD items

| # | Feature | Shipped evidence | Acceptance (§10.1 / §10.2) | Lab / lesson | Verdict |
|---|---|---|---|---|---|
| S1 | OSPF overlay and the port inspector's OSPF section | `apps/web/src/canvas/ospf.ts`, `canvas/overlays/ospf-model.ts`, `inspector/OspfSection.tsx`, `canvas/overlays/registry.ts` (`ROUTING_OVERLAY_MODULES`) | web `overlays.ospf-model` | 03–07 | SHIPPED |
| S2 | LSDB browser (dock tab `routing`) | `apps/web/src/routing/` (`LinkStatePanel`, `LsaList`, `LsaDetail`, `LsdbGraph`, `lsdb-model`), `dock/registry.ts` (`routing`, stage P3) | web `routing.lsdb-model`, `dock.routing` | 02 | SHIPPED |
| S3 | SPF stepper and canvas SPF layer | `apps/web/src/routing/SpfStepper.tsx`, `canvas/spf.ts`, `canvas/overlays/spf-model.ts` | web `routing.spf-parity` | 02 | SHIPPED |
| S9 | Wildcard visualizer | `apps/web/src/concept/wildcard/` (`WildcardTool.tsx`, `model.ts`), `ConceptToolId 'wildcard'` | web `concept.wildcard` | 14 (`concept:wildcard`) | SHIPPED |
| S13 | Remote terminal | `protocols/vty.ts`, `protocols/vty-client.ts`, `pdu/codecs/telnet.ts`, `pdu/codecs/ssh.ts`, `cli/grammar/remote.ts`, `cli/handlers/remote.ts`, the `remoteOutput` SimEvent (`contracts/events.ts`), `access-class` enforced through `acl.check` (`protocols/acl.ts`), `sim/lab-checks/service.ts` (the `service` kind); web `apps/web/src/terminal/remote-session.ts`, `terminal/line-editor.ts` | accept: `vty`; `sim.lab-checks.approved-kinds.test.ts`; web `terminal.remote-session.test.ts`, `line-editor.secret.test.ts` (gap 1) | 15 and 19 (login tasks graded live) | SHIPPED |
| S18 | GRE tunnels | `protocols/gre.ts` (the tunnel owner), `pdu/codecs/gre.ts`, `device/catalog/define.ts` (`TUNNEL_FAMILY`, `withTunnelFamily`), `cli/grammar/wan.ts`, `sim/lab-checks/path.ts` (the `path` kind); web `canvas/wan.ts`, `canvas/overlays/wan-model.ts`, `inspector/TunnelSection.tsx` | accept: `gre`; `sim.lab-checks.approved-kinds`; web `overlays.wan-model` | 24 `ccna3-gre-tunnel` | SHIPPED |
| S19 | PPP | `protocols/ppp.ts`, `protocols/ppp/` (`fsm`, `config`), `pdu/codecs/` (`ppp`, `lcp`, `pap`, `chap`, `ipcp`, `ipv6cp`), `core/md5.ts`, `cli/grammar/serial.ts`; web `inspector/PppSection.tsx`, `canvas/overlays/wan-model.ts` | accept: `ppp-chap`, `ppp-pap`, `ppp-mismatch`, `ppp-keepalive`; web `overlays.wan-model` | 22 `ccna3-serial-links` (PPP and CHAP tasks) | SHIPPED |
| S20 | Full QoS scheduler | `link/qos/scheduler.ts` (held queues, LLQ, CBWFQ by DRR, queue limits), `cli/grammar/qos-queueing.ts`, the 75 % admission and the `show interfaces` queue lines, `sim/media-wiring.ts` (`egressPolicy`, R32), `sim/lab-checks/traffic.ts` (the `traffic` kind); web `inspector/PolicySection.tsx` | accept: `qos-llq`, `qos-cbwfq`, `qos-bounded`; web `inspector.policy-section` | 27 (LLQ tasks) | SHIPPED |
| S21 | WFQ in class-default, policing, shaping | `link/qos/scheduler.ts` (`fair-queue`, police with conform/exceed actions R26, shape), `cli/grammar/qos-queueing.ts` | accept: `qos-police-shape` | 27 (policing task) | SHIPPED |
| S24 | Local logging | `protocols/logger.ts`, the `emitLog` seam (`device/device.ts`), `cli/grammar/logging.ts`, `cli/handlers/logging.ts`, the P3 `service timestamps` profile lines (`device/catalog/define.ts` `TIMESTAMPS_PROFILE_LINES`) | accept: `syslog` | 29 (logging tasks) | SHIPPED |
| S25 | Syslog and extended logging | `protocols/syslog-server.ts`, `pdu/codecs/syslog.ts`, `logging host` / `trap` (`cli/grammar/logging.ts`), the `configSession` seam (R53); web `inspector/ServicesPanel.tsx` (the viewer) | accept: `syslog` | 29 (syslog-server task) | SHIPPED |
| S32 | NF-Py, the automation workspace, NF-DEVHOST, lab 40 | `automation/py/` (`lexer`, `parser`, `compiler`, `vm`, `lib`), `protocols/script-host.ts`, `cli/grammar/devhost.ts`, `device/catalog/computers.ts` (`pc.nfdevhost`), the hosts' `files:` store (`contracts/topology.ts` `TopologyDevice.files`, `io/schema.ts`); web `apps/web/src/automation/` (`AutomationWorkspace`, `CodeEditor`, `py-highlight`, `workspace-model`) | accept: `script`; web `desktop.automation.test.tsx` (editor highlight and error marker), `desktop.automation.world.test.tsx` | 40 `ccna3-script-inventory` | SHIPPED |
| S37 | P3b seams | `contracts/lab-document.ts` (`LabDocument`, `labDocumentOf`), `io/lab-schema.ts` (schema, `labDocumentToJson` / `labDocumentFromJson`), `sim/grade.ts` (`gradeTopology`), the lab-version golden `test/goldens/lab-versions.json`, web `apps/web/src/bridge/worker/labs.ts` (`resolveLab`) | accept: `lab-document`; `sim.grade.parity.test.ts`, `sim.grade.test.ts`, `io.lab-schema.test.ts` | every lab | SHIPPED |
| C1 | EIGRP classic core | `protocols/eigrp.ts`, `protocols/eigrp/` (`config`, `dual`, `metric`), `pdu/codecs/eigrp.ts`, `cli/grammar/eigrp.ts`, `sim/lab-checks/eigrp.ts`, `RouteRow.source 'EIGRP'` (D11); web `canvas/eigrp.ts`, `canvas/overlays/eigrp-model.ts` | accept: `eigrp`, `eigrp-dual`; web `overlays.eigrp-model` | 10 `ccna3-eigrp-feasible-successor`, 33 `ccna3-troubleshoot-eigrp`; lesson 10 theory | SHIPPED |
| C13 | Site-to-site IPsec | `protocols/ike.ts`, `protocols/ike/` (`config`, `exchange`, `proof`), `pdu/codecs/esp.ts`, `pdu/codecs/ikev2.ts`, the ipsec mode of `protocols/gre.ts`, `cli/grammar/crypto.ts`, the `path.tunnelAt` member; web the ESP and IKE banners (`inspector/PacketInspector.tsx`, `netscope/DetailTree.tsx`) | accept: `ipsec`, `ipsec-failure`; web `inspector.packet-protected`, `overlays.wan-model` | 25 `ccna3-ipsec-site-to-site`; lesson 25 theory | SHIPPED |

## Every other item, with its stage (§12.1) and the code check

"Not built" means the search found no command line, daemon, table, assertion kind, overlay, concept tool or app of the
item; hits that are only refusals, comments saying the item is not approved, ACL port names (`eq snmp`, `eq tftp`) or
lesson text were read and are not the item.

| # | Item | Stage | Searched for | Code check |
|---|---|---|---|---|
| S4 | Multi-area OSPF | P3c | `border-routers`, `'IA'` route type, ABR | not built (`RouteRow.routeType` is `'E2'` only; lesson 08 theory) |
| S5 | OSPF authentication | P3c | `message-digest-key`, `ip ospf authentication` | not built (the hello check refuses any non-zero authentication type: `protocols/ospf/hello-check.ts`) |
| S6 | OSPFv3 | P3c | `ospfv3`, `ipv6 router ospf`, `ipv6 ospf` | not built (catalog and registry comments only) |
| S7 | Path-to-destination overlay | P3c | path overlay ids | not built (`OVERLAY_MODULES`: vlan, stp, capwap, ospf, eigrp, spf, wan, qos) |
| S8 | Convergence kind | P3c | `kind: 'convergence'` | not built (the only hit is a CCNA 2 lab's prose) |
| S10 | ACL workbench | P3c | `TraceFilter.reasons`, packet tester | not built |
| S11 | IPv6 ACLs | P3c | `ipv6 traffic-filter`, `ipv6 access-list`, `ipv6.resume`, `ipv6 access-class` | not built |
| S12 | ACL extras | P3c | `log-input`, `no ip unreachables` | not built (`protocols/acl.ts` says it does not read them) |
| S14 | ARP ACLs, DAI `validate` | P3c | `arp access-list`, `inspection validate` | not built |
| S15 | IP source guard | P3c | `ip verify source` | not built |
| S16 | Storm control | P3c | `storm-control` | not built (contract comments only) |
| S17 | Fragmentation | P3c | `FragmentSplit`, reassembly | not built (D15: tunnels drop `mtu-exceeded`) |
| S22 | WAN and VPN concept visualizer | P3c | concept tool ids | not built (`ConceptToolId`: subnetting, ipv6, queueing, data-formats, wildcard) |
| S23 | ACL lint and placement advisor | P3c | lint, advisor | not built |
| S26 | Neighbours overlay | P3c | overlay ids | not built |
| S27 | API client desktop app | P3c | `GUI_PANELS` | not built (desktop apps: ip-config, wifi, cellular, command-prompt, web-browser, traffic, automation) |
| S28 | YANG browser | P3c | concept tool ids | not built |
| S29 | Files and TFTP | P3c | `tftp` daemon, `copy … tftp`, `show flash:`, `DeviceModel.storage` | not built (the hosts' `files:` store is [S32]'s, D21; `dir`, `type`, `del` are the dev-host shell's) |
| S30 | Image management | P3c | `boot system` | not built |
| S31 | Password recovery | P3c | `config-register`, `confreg`, ROMMON, `cliBreak`, `TopologyDevice.nvram` | not built |
| S33 | SNMP v2c | P3c | `snmp-server`, `snmp-agent`, `snmp-manager` | not built |
| S34 | Local SPAN | P3c | `monitor session`, `PduMeta.mirror` | not built |
| S35 | CDP/LLDP-MED voice VLAN | P3c | voice VLAN in `cdp.ts` / `lldp.ts` | not built (`switchport voice vlan` is P2's typed VLAN) |
| S36 | GRE extras (recursion hold, IPv6 over GRE) | P3c | hold timer, IPv6 in `gre.ts` | not built: the `recursive-routing` down reason and its log are [S18]'s `TunnelRow` (§2.6); `protocols/gre.ts` states that without [S36]'s hold a tunnel down for recursive routing stays down; no IPv6 path in `gre.ts` |
| S38 | `packetSeen` | P3c | `packetSeen` | not built |
| S39 | Quiet-period settle | P3c | quiet-period settle in the grader | not built (the traffic kind's own `LAB_TRAFFIC_QUIET_NS` drain is [S20]'s) |
| S40 | Dispatch profiling | P3c | — (a process item, no code) | not done |
| S41 | CDP extras | P3c | native-VLAN and duplex mismatch logs | not built (no mismatch log in `protocols/cdp.ts`; `show cdp traffic` and `show cdp interface` are §5.8 MUST lines, see gap 2) |
| C2 | EIGRP stub, summarisation, unequal-cost | P5 | `eigrp stub`, `summary-address`, `variance` | not built (`auto-summary` is refused) |
| C3 | OSPF NBMA, point-to-multipoint | P5 | `ip ospf network non-broadcast` | not built |
| C4 | OSPF stub, NSSA, type 7 | P5 | `area … stub`, `nssa` | not built (codec constants and lesson text only) |
| C5 | OSPF area range, summary-address | P5 | `area … range` | not built |
| C6 | Redistribution | P5 | `redistribute` | not built |
| C7 | OSPF MTU-mismatch lab | P3c | DBD MTU check, `ip ospf mtu-ignore` | not built (`ip mtu` exists on tunnels only, [S18]) |
| C8 | OSPF scale (interning, partial SPF) | P3c | LSA interning | not built (R61 (d): the `compareLsdbRows` key cache is not done) |
| C9 | `timers throttle spf\|lsa` | P5 | `timers throttle` | not built |
| C10 | Time-based ACLs | P4 | `time-range` | not built |
| C11 | `exec-timeout` enforcement, `login block-for` | P4 | `block-for`, an idle timer in `protocols/vty.ts` | not built (`exec-timeout` is a stored P1 line, never enforced) |
| C12 | Local AAA | P4 | `aaa new-model` | not built |
| C14 | PPP multilink | P3c | `multilink` | not built |
| C15 | PPPoE, dialer | P3c | `pppoe`, `dialer` | not built |
| C16 | CSU/DSU and cloud lines for PPP | P3c | PPP on `csu.nfcsu` / `cloud.nfinternet` | not built (both stay HDLC, D17) |
| C17 | GRE keepalives, `tunnel key` | P3c | `tunnel key`, tunnel `keepalive` | not built (`keepalive` exists for serial HDLC/PPP only) |
| C18 | MPLS overlay | P5 | `mpls` | not built (lesson text only) |
| C19 | WRED, hierarchical QoS, AutoQoS, `hold-queue` | P5 | `random-detect`, `hold-queue`, `auto qos` | not built |
| C20 | Invisible fair-queue default on slow serial | P3c | a P3 profile `fair-queue` line | not built (`fair-queue` is [S21]'s explicit line; `profileConfig.P3` holds only the two timestamps lines) |
| C21 | NETCONF, XML for RESTCONF | P3c | `netconf` | not built (contract comment and lesson text only) |
| C22 | Playbook runner, lab 39 | P3c | playbook | not built (lesson 39 is theory) |
| C23 | SNMPv3 | P3c | `snmp` | not built |
| C24 | FTP | P3c | an FTP daemon | not built (`ftp` is an ACL port name only) |
| C25 | NTP authentication | P5 | `ntp authenticate`, `authentication-key` | not built |
| C26 | Controller-based networking visualizer | P3c | concept tool ids | not built |
| C27 | SDN controller mock | P5 | controller mock | not built |
| C28 | Configuration archive, `configure replace` | P5 | `configure replace`, `archive` | not built (hits are the `.netforge` archive format) |
| C29 | `usbflash0:` | P3c | `usbflash` | not built |
| C30 | Clock drift | never | drift in the clock | not built (hits are the scheduler's integer-maths comments) |
| C31 | Deep links `?lesson=` / `?lab=` | P3b | `URLSearchParams`, `location.search` in the web | not built |
| C32 | Demux `frame: 'data'`, trace VLAN key, TimelineStrip guard | P3c | changes to `DemuxSelector.frame` | not built (the member is P2's, unchanged) |

The remaining §12.1 rows, checked the same way: **P4** — crypto maps and IKEv1 (`crypto map`, `isakmp`: lesson text
and an ACL port name only), remote-access VPN, NetFlow/IPFIX and RSPAN (lesson text only), server AAA and 802.1X
(`radius`, `tacacs`, `dot1x`: P2 wireless members and ACL port names only), reflexive ACLs and zone-based firewalls,
DHCPv6 guard, RA guard, IPv6 source guard, option 82 (`no ip dhcp snooping information option` is stored only, a listed
deviation) and the snooping database agent: none built. **P5** — named mode, wide metrics and EIGRPv6, OSPF virtual
links, LSA filtering, SHA key chains, BGP, MPLS and metro Ethernet services, mGRE and DMVPN, port and VLAN ACLs: none
built. **Never** — BFD, graceful restart, RIP, real cryptography, switch QoS queues and trust (`mls qos`), QoS
pre-classification on tunnels: none built. **P3b** — the platform and the instructor-authored labs: only the [S37]
seams exist.

## Gaps and open items (for the lead)

1. **A §10.2 web test is shipped under another name.** §10.2 names `[S13] terminal.remote.test.ts` (the chip from
   `CliSessionView.remote`, masked input); the shipped files are `apps/web/test/terminal.remote-session.test.ts` (the
   chip, the relay, the dock strip) and `apps/web/test/line-editor.secret.test.ts` (masked input, with the masked-input
   cases also in the first file). Coverage is there; only the name differs. Either rename it in §10.2 at §14 or accept.
2. **`show cdp traffic` and `show cdp interface` sit in two places of the brief.** §5.8 lists them among the MUST shows
   of M14 (and R39 accepted `clear cdp counters`, which zeroes what `show cdp traffic` prints), while §8.2's S41 (not
   approved) names "`show cdp traffic|interface` counters". The audit reads them as shipped under §5.8/R39; S41's
   other part, the native-VLAN and duplex mismatch logs, is not built. No action unless the architect reads S41
   otherwise.
3. **Optional-by-meaning members not in §2.15 and not named by R61 (e).** The source tags these `@since P3 (optional
   by meaning)`, but §2.15 (as updated in this run, exactly by R61 (e)) does not list them, so W8 item 45 as worded
   would remove their `?`: `LabCheckResult.misconception` (`contracts/scenario.ts:426`, ruling R18; absent keeps every
   P1/P2 lab status's bytes), `LoggerStateView.syslog` (`contracts/process.ts`, the `syslog?` member, R25; present only
   with a `logging host`), the `dscp` of a `PortTxQueueView` frame entry (`contracts/snapshot.ts:174`, the W1 contract
   fix), and the P3 values `'gre'` / `'ipsec'` of the P2 member `PduSummary.tunnel` (`contracts/trace.ts:40`, like the
   `'P3'` value of `SimSnapshot.profile`). Each needs a ruling: list it in §2.15 or remove its `?`.
4. **Item 47's members, seen in the parallel working tree.** `PduMeta.innerProtectedBy?` has landed
   (`contracts/pdu.ts:203`, tagged optional by meaning, values `'dtls' | 'tls' | 'ssh' | 'esp' | 'ike'`: one more than
   R61 (a)'s "TLS/SSH mark", for P2's DTLS mark), and §2.15 now lists it. `ProcessCtx.protect` is declared
   `protect?(…)` (`contracts/process.ts:856`) and is not tagged optional by meaning, so under R61 (e) it is a
   transition `?` that W8 removes; §2.15's "become required" paragraph does not name it yet.
5. **R61 (a) asks for the `ext.*` sanctioned-users list "in `contracts/process.ts` and in §2".** The contract half
   exists in the working tree (`SANCTIONED_EXT_REQUESTS`, `contracts/process.ts:463`). This run's brief limits the
   ARCHITECTURE-P3 edit to §2.15, so the §2 list (`ext.tcp.protect`, `ext.ipv4.transportHold`, `ext.logging.clear`)
   is not written; the lead adds it (for example to §2.4) or names the builder who does.
6. **§2.15 places `FacadeCounters.remote` under "cli.ts / config.ts"**; the member is declared in
   `contracts/journal.ts:43`. Location only.
7. **Lessons that do not state a listed deviation.** §12.2 R2 asks for a lesson sentence where a learner could notice
   a deviation. No CCNA 3 lesson states R2 (15) (the UDP 9 discard sink), (27) (the PAT echo-id collision) or (28)
   (the first `line vty` section's login rule); the others a learner can notice are stated (the `docs/CATALOG.md`
   fidelity table's "Lesson" column names where; (11), the RSA key kept as a line of the configuration, is in lesson
   19's NetForge notes). Low; content for a later edit. (At the audit; the W8 integration added the sentences for
   (15) and (28): see below.)
8. **Home routers derive the routing capability's P3 daemons and tables** (`wrouter.nfhome`, `wrouter.nfhome-ax`: ospf,
   eigrp, ike, gre, acl, cdp, lldp, vty, logger, ntp, restconf and their 15 tables), although they have no CLI and no
   panel writes those lines. All stay silent (the silence tests cover them) and the tables stay empty; recorded in
   `docs/CATALOG.md` as built. Observation, not a scope gap.
9. **`docs/CATALOG.md` had no fidelity table**, although ARCHITECTURE-P2 §12.2 R2 and ARCHITECTURE-P3 §12.2 R2 both
   say each deviation is a row there. This run adds it with the P2 rows and the P3a rows (fixed here).

## Resolution at the W8 integration (rulings R62 (a)–(e))

1. §10.2 now names `terminal.remote-session.test.ts` and `line-editor.secret.test.ts` (R62 (d)).
2. `show cdp traffic` / `show cdp interface` count as MUST (§5.8, R39); S41's mismatch logs stay unbuilt (R62 (d)).
3. The four members are §2.15 rows and keep their `?` (R62 (a)); `contracts.optional-by-meaning.test.ts` pins them.
4. `ProcessCtx.protect` is required (R62 (b)) and §2.15's "become required" paragraph names it; the `'dtls'` value of
   `innerProtectedBy` is accepted.
5. §2.4 lists the sanctioned `ext.*` requests, matching `SANCTIONED_EXT_REQUESTS` (R62 (c)).
6. §2.15 files `FacadeCounters.remote` under a `journal.ts` row (R62 (c)).
7. Lesson 27 states R2 (15) and lesson 19 states R2 (28) in one plain sentence each (R62 (e)); the fidelity table's
   rows 15 and 28 name them. R2 (27) is a P2 behaviour and stays recorded in §12 and `docs/CATALOG.md` only.
8. No action (observation).
9. Fixed by this audit.

`packages/engine/test/docs.w8-scope.test.ts` checks these docs against the sources they describe.

## Docs changed in this run

- `docs/CATALOG.md`: the stage and profile note; the capabilities table by stage (with the P2 capabilities
  `managed-switch`, `lightweight-ap` and `wireless-controller`, which it lacked, and every P3 daemon); the declared
  `managed-switch` capability on the nine switch rows that declare it; NF-DEVHOST's store bounds and command scoping
  (R20, R60); the new "P3 per model" section; the new fidelity table (P2 and P3a).
- `docs/ARCHITECTURE-P3.md` §2.15: the members R61 (e) names (R23, R32, R42, R58 (b), R60, R61 (a); R24, R26, R53,
  R56 and R42's `tzName` were already rows) and a web row.
- `docs/W8-SCOPE-AUDIT.md`: this file.
