/**
 * @netforge/engine — public entry point.
 *
 * Contracts are always exported. Implementation modules are grouped by area below; the line order is module
 * evaluation order, so a line moves only with a reason.
 *
 * Name clashes between modules are resolved here with explicit re-exports, which take precedence over the
 * `export *` lines: the canvas default scale is the contract constant, and the medium-specific helpers that share
 * a name with another module are published under a medium-qualified alias.
 *
 * P2 (docs/ARCHITECTURE-P2.md §0 rule 1): this file is architect-owned; the W8 exit gate reconciled it. Every public
 * P2 module is exported exactly once: the P2 contracts (including contracts/journal.ts and contracts/timeline.ts,
 * [S1]) through contracts/index.js; each P2 codec, daemon and daemon helper by its own line; the P2 CLI grammar
 * through cli/grammar.js; the CCNA 2 labs through sim/scenarios.js (`CCNA2_LABS`, `SCENARIOS`); the CCNA 2 course
 * through curriculum/index.js (`COURSES`); the time machine through sim/journal.js, sim/replay.js and
 * timeline/lanes.js. Per-lab files, lesson data and command handlers stay internal (reached through `SCENARIOS`,
 * `COURSES` and the handler registry), and nothing test-only is exported. A module must not redeclare a name a
 * contract exports (`DefaultSlots`, `schemaIdFor`, …): two `export *` lines that export different declarations under
 * one name do not compile.
 *
 * P3a (docs/ARCHITECTURE-P3.md §0 rule 1): this file stays architect-owned; each wave item added only its own
 * `export * from …` lines, and the W8 exit gate reconciled it. Every public P3 module is exported exactly once: the P3
 * contracts (including contracts/clock.ts, contracts/storage.ts [S32] and contracts/lab-document.ts [S37]) through
 * contracts/index.js; each P3 codec, daemon and daemon helper by its own line; the P3 CLI grammar through
 * cli/grammar.js (the approved items' fragments through `GRAMMAR_FRAGMENTS` and `HANDLERS`); the CCNA 3 labs through
 * sim/scenarios.js (`CCNA3_LABS`, `SCENARIOS`); the CCNA 3 course through curriculum/index.js (`COURSES`); the grader
 * through sim/lab-checks.js and the headless grading of a lab document through sim/grade.js. The gate added the six
 * lines the waves had left out, each module already evaluated by an earlier line, so the evaluation order is unchanged:
 * `protocols/restconf.js` (the MUST daemon), `link/control-frame.js` (the QoS control-frame rule, ruling R33),
 * `automation/py/compiler.js`, `automation/py/vm.js` and `automation/py/lib.js` (the [S32] NF-Py machine the script
 * host drives) and `cli/log-render.js` ([S24]/[S25] console log lines). Internal, as in P2: per-lab files
 * (`sim/scenarios/ccna3/<area>.ts`), lesson data (`curriculum/ccna3/*`, its `CourseObjective` types included, ruling
 * R61 (b)), command handlers and their `CommandCtx` view (`cli/command-ctx-p3.ts`), the grader's checker registry and
 * area adapters (`sim/lab-checks/<area>.ts`, reached through `evaluateLab`) and the per-protocol display-field tables
 * (`capture/filter/fields/<proto>.ts`, reached through `PROTO_FIELDS`); nothing test-only is exported.
 */
export * from './contracts/index.js';
export { DEFAULT_METRES_PER_UNIT } from './contracts/topology.js';

// core
export * from './core/acl.js';
export * from './core/addr6.js';
export * from './core/lpm.js';
export * from './core/lpm6.js';
export * from './core/prng.js';
export * from './core/rib-arbiter.js';
export * from './core/scheduler.js';
export * from './core/table.js';
export * from './core/vlan-list.js';
// core — P3 W1 core (ARCHITECTURE-P3 D10, D12, D16)
export * from './core/ospf-lsa.js';
export * from './core/ospf-spf.js';
export * from './core/queueing.js';
// core — P3 W1 wan [S19]: MD5 for CHAP (ARCHITECTURE-P3 D17)
export * from './core/md5.js';

// pdu
export * from './pdu/pdu.js';
export * from './pdu/factory.js';
export * from './pdu/checksum.js';
export * from './pdu/codecs/registry.js';
export * from './pdu/codecs/dispatch.js';
export * from './pdu/codecs/arp.js';
export * from './pdu/codecs/dot11.js';
export * from './pdu/codecs/dot11-mgmt.js';
export * from './pdu/codecs/eapol.js';
export * from './pdu/codecs/ethernet.js';
export * from './pdu/codecs/hdlc.js';
export * from './pdu/codecs/icmpv4.js';
export * from './pdu/codecs/ipv4.js';
export * from './pdu/codecs/llc.js';
export * from './pdu/codecs/payload.js';
export * from './pdu/codecs/ipv6.js';
export * from './pdu/codecs/ipv6-ext.js';
export * from './pdu/codecs/icmpv6.js';
export * from './pdu/codecs/udp.js';
export * from './pdu/codecs/tcp.js';
export * from './pdu/codecs/dhcp.js';
export * from './pdu/codecs/dns.js';
export * from './pdu/codecs/http.js';
export * from './pdu/codecs/dot1q.js';
export * from './pdu/codecs/stp.js';
export * from './pdu/codecs/lacp.js';
export * from './pdu/codecs/dtp.js';
export * from './pdu/codecs/dhcpv6.js';
export * from './pdu/codecs/capwap.js';
export * from './pdu/codecs/hsrp.js';
export * from './pdu/codecs/pagp.js';
export * from './pdu/codecs/ospf.js';
export * from './pdu/codecs/cdp.js';
export * from './pdu/codecs/lldp.js';
export * from './pdu/codecs/ntp.js';
export * from './pdu/codecs/telnet.js';
export * from './pdu/codecs/ssh.js';
export * from './pdu/codecs/gre.js';
export * from './pdu/codecs/ppp.js';
export * from './pdu/codecs/lcp.js';
export * from './pdu/codecs/pap.js';
export * from './pdu/codecs/chap.js';
export * from './pdu/codecs/ipcp.js';
export * from './pdu/codecs/ipv6cp.js';
export * from './pdu/codecs/syslog.js';
export * from './pdu/codecs/eigrp.js';
export * from './pdu/codecs/esp.js';
export * from './pdu/codecs/ikev2.js';
export * from './pdu/vlan.js';

// device + link
export * from './device/catalog.js';
export * from './device/catalog/computers.js';
export * from './device/catalog/datacentre.js';
export * from './device/catalog/define.js';
export * from './device/catalog/home.js';
export * from './device/catalog/iot.js';
export * from './device/catalog/legacy.js';
export * from './device/catalog/mobile.js';
export * from './device/catalog/modules.js';
export * from './device/catalog/multilayer.js';
export * from './device/catalog/names.js';
export * from './device/catalog/peripherals.js';
export * from './device/catalog/radios.js';
export * from './device/catalog/routers.js';
export * from './device/catalog/security.js';
export * from './device/catalog/servers.js';
export * from './device/catalog/switches.js';
export * from './device/catalog/validate.js';
export * from './device/catalog/voice.js';
export * from './device/catalog/wan.js';
export * from './device/catalog/wireless.js';
export * from './device/device.js';
export * from './device/pipeline.js';
export * from './device/ports.js';
export * from './device/process-ctx.js';
export * from './link/cabling.js';
export * from './link/inflight.js';
export * from './link/link.js';
export * from './link/media/air.js';
export { defaultRadioSettings as defaultAirRadioSettings } from './link/media/air.js';
export * from './link/media/cell.js';
export * from './link/media/p2p.js';
export * from './link/media/radio.js';
export { defaultRadioSettings } from './link/media/radio.js';
export * from './link/media/segment.js';
export * from './link/media/types.js';
export * from './link/negotiation.js';
export * from './link/rewrap80211.js';
export * from './link/rf/channels.js';
export * from './link/rf/log.js';
export * from './link/rf/mcs.js';
export * from './link/rf/pathloss.js';
export * from './link/serial.js';
// link — P3 W3 fix step (ruling R33): what counts as control traffic for QoS (reconciled at W8)
export * from './link/control-frame.js';

// protocols
export * from './protocols/index.js';
export * from './protocols/arp.js';
export * from './protocols/cell-client.js';
export * from './protocols/dhcp-client.js';
export * from './protocols/dhcp-server.js';
export * from './protocols/dhcpv6-client.js';
export * from './protocols/dhcpv6-server.js';
export * from './protocols/hsrp.js';
export * from './protocols/dns-client.js';
export * from './protocols/dns-server.js';
export * from './protocols/eth-switch.js';
export * from './protocols/hdlc.js';
export * from './protocols/host.js';
export * from './protocols/icmpv4.js';
export * from './protocols/icmpv6.js';
export * from './protocols/ipv4.js';
export * from './protocols/ip-upper.js';
export * from './protocols/ipv6.js';
export * from './protocols/nd.js';
export * from './protocols/wlan-ap.js';
export * from './protocols/wlan-client.js';
export * from './protocols/udp.js';
export * from './protocols/tcp.js';
export * from './protocols/traceroute.js';
export * from './protocols/vlan.js';
export * from './protocols/etherchannel.js';
export * from './protocols/etherchannel/compat.js';
export * from './protocols/etherchannel/lacp.js';
export * from './protocols/etherchannel/pagp.js';
export * from './protocols/etherchannel/static.js';
export * from './protocols/nat.js';
// protocols — P3 W2 acl (ARCHITECTURE-P3 D12): the access-list daemon
export * from './protocols/acl.js';
export * from './protocols/dtp.js';
export * from './protocols/l2/control.js';
export * from './protocols/l2/lag-hash.js';
export * from './protocols/l2/membership.js';
export * from './protocols/l2/port-security.js';
export * from './protocols/l2/switchport-config.js';
// P3 W1 l2 (ARCHITECTURE-P3 D13): the pure snooping, DAI and rate-window decisions
export * from './protocols/l2/rate-window.js';
export * from './protocols/l2/dhcp-snooping.js';
export * from './protocols/l2/arp-inspection.js';
export * from './protocols/stp/cost.js';
export * from './protocols/stp/ids.js';
export * from './protocols/stp/vector.js';
export * from './protocols/stp.js';
export * from './protocols/stp/guards.js';
export * from './protocols/stp/mixed.js';
export * from './protocols/stp/pvst.js';
export * from './protocols/stp/rstp.js';
// protocols — wireless controller and lightweight access point
export * from './protocols/capwap-wtp.js';
export * from './protocols/capwap-ac.js';
// protocols — OSPF pure modules (P3 W1 ospf)
export * from './protocols/ospf/config.js';
export * from './protocols/ospf/cost.js';
export * from './protocols/ospf/dr.js';
export * from './protocols/ospf/hello-check.js';
export * from './protocols/ospf/ism.js';
// protocols — the OSPF daemon and its modules (P3 W2 ospf)
export * from './protocols/ospf.js';
export * from './protocols/ospf/nsm.js';
export * from './protocols/ospf/flood.js';
export * from './protocols/ospf/lsdb.js';
export * from './protocols/ospf/originate.js';
export * from './protocols/ospf/routes.js';
// protocols — P3 W1 wan [S19] [C13]: the RFC 1661 automaton; IKEv2-lite exchange and derived values (pure)
export * from './protocols/ppp/fsm.js';
export * from './protocols/ike/proof.js';
export * from './protocols/ike/exchange.js';
// protocols — P3 W1 eigrp [C1]: configuration reader, integer metric, DUAL per destination (pure)
export * from './protocols/eigrp/config.js';
export * from './protocols/eigrp/metric.js';
export * from './protocols/eigrp/dual.js';
// protocols — P3 W2 disc: the discovery daemons (CDP in its NF format, LLDP)
export * from './protocols/cdp.js';
export * from './protocols/lldp.js';
// protocols — P3 W2 eigrp [C1]: the daemon; W2 wan [S18]: the tunnel owner (GRE mode)
export * from './protocols/eigrp.js';
export * from './protocols/gre.js';
// protocols — P3 W2 svc (ARCHITECTURE-P3 D16, D19, D20): NTP, the traffic generator, [S24] the logger
export * from './protocols/ntp.js';
export * from './protocols/traffic.js';
export * from './protocols/logger.js';
// protocols — P3 W3 svc [S25]: the syslog receiver of servers
export * from './protocols/syslog-server.js';
// protocols — P3 W3 svc [S13]: the remote terminal server and client (telnet, simulated SSH)
export * from './protocols/vty.js';
export * from './protocols/vty-client.js';
// protocols — P3 W2 http (ARCHITECTURE-P3 D21): the RESTCONF device API daemon (reconciled at W8)
export * from './protocols/restconf.js';

// cli
export * from './cli/runtime.js';
export * from './cli/config-ast.js';
export * from './cli/config-rules.js';
export * from './cli/config-text.js';
export { padLeft, padRight, table, fmtUptime, fmtDuration, fmtSince, fmtBps, fmtBytes, minutesBetween, type TableOptions as TextTableOptions } from './cli/format.js';
export * from './cli/grammar.js';
export * from './cli/handlers/index.js';
export * from './cli/modes.js';
export * from './cli/parser.js';
export * from './cli/scope.js';
// cli — P3 W2 cli [S24]/[S25] (ARCHITECTURE-P3 D20): the console's log and debug lines (reconciled at W8)
export * from './cli/log-render.js';

// trace
export * from './trace/filter.js';
export * from './trace/ring.js';

// io
export * from './io/migrate.js';
export * from './io/netforge-file.js';
export * from './io/pcap.js';
export * from './io/schema.js';
// io — P3 W5 io [S37]: the lab-document schema (ARCHITECTURE-P3 D6)
export * from './io/lab-schema.js';

// capture
export * from './capture/filter/complete.js';
export * from './capture/filter/eval.js';
export * from './capture/filter/fields.js';
export * from './capture/filter/lexer.js';
export * from './capture/filter/parser.js';
export * from './capture/decode-row.js';
export * from './capture/stats.js';
export * from './capture/store.js';
export * from './capture/stream.js';
export * from './capture/tap.js';

// sim
export * from './sim/configure.js';
export * from './sim/ids.js';
export * from './sim/media-wiring.js';
export * from './sim/run-control.js';
export * from './sim/lab-checks.js';
export * from './sim/simulation.js';
export * from './sim/scenarios.js';
export * from './sim/snapshot-cache.js';
// sim — time travel [S1]: the input journal and replays
export * from './sim/journal.js';
export * from './sim/replay.js';
// sim — P3 W1: the defaults ladder (D2)
export * from './sim/defaults-upgrade.js';
// sim — P3 W6 sim [S37]: headless grading of a lab document (ARCHITECTURE-P3 D6)
export * from './sim/grade.js';

// curriculum
export * from './contracts/curriculum.js';
export * from './curriculum/index.js';

// timeline — time travel [S1]: lanes
export * from './timeline/lanes.js';

// automation — P3 W1 auto (ARCHITECTURE-P3 D21): data formats, the YANG model, the RESTCONF path parser; [S32] NF-Py
export * from './automation/data/json.js';
export * from './automation/data/yaml.js';
export * from './automation/data/xml.js';
export * from './automation/yang/path.js';
export * from './automation/yang/model.js';
export * from './automation/py/lexer.js';
export * from './automation/py/parser.js';
// automation — P3 W2 auto [S32] (ARCHITECTURE-P3 D21, §4.1): the NF-Py compiler, machine and library (reconciled at W8)
export * from './automation/py/compiler.js';
export * from './automation/py/vm.js';
export * from './automation/py/lib.js';

// qos — P3 W2 qos (ARCHITECTURE-P3 D16): the MQC reader, the classifier, the marking plan; [S20]/[S21] the port scheduler
export * from './qos/config.js';
export * from './qos/classify.js';
export * from './qos/mark.js';
export * from './link/qos/scheduler.js';

// wan — P3 W3 wan [S19] (ARCHITECTURE-P3 D17, §3.9): the ppp daemon and what it reads from the configuration
export * from './protocols/ppp/config.js';
export * from './protocols/ppp.js';
// wan — P3 W3 wan [C13] (ARCHITECTURE-P3 D27, §3.13; ruling R36): the ike daemon and the crypto sections it reads
export * from './protocols/ike/config.js';
export * from './protocols/ike.js';

// automation — P3 W5 auto [S32] (ARCHITECTURE-P3 D21, §3.8 step 8): the NF-Py script host (registered by the W6 flip)
export * from './protocols/script-host.js';
