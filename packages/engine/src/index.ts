/**
 * @netforge/engine — public entry point.
 *
 * Contracts are always exported. Implementation modules append their exports
 * below as they land (keep this list alphabetical by module).
 *
 * Name clashes between modules are resolved here with explicit re-exports, which take precedence over the
 * `export *` lines: the canvas default scale is the contract constant, and the medium-specific helpers that share
 * a name with another module are published under a medium-qualified alias.
 *
 * P2 (docs/ARCHITECTURE-P2.md §0 rule 1): this file is architect-owned and append-only. A wave item adds only its own
 * `export * from './<its files>.js'` lines, in the change that creates those files; the architect reconciles the list
 * at the exit gate (W8). The P2 contracts (including contracts/journal.ts and contracts/timeline.ts, [S1]) are
 * exported through contracts/index.js. A module must not redeclare a name a contract exports (`DefaultSlots`,
 * `schemaIdFor`, …): two `export *` lines that export different declarations under one name do not compile.
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
export * from './protocols/dtp.js';
export * from './protocols/l2/control.js';
export * from './protocols/l2/lag-hash.js';
export * from './protocols/l2/membership.js';
export * from './protocols/l2/port-security.js';
export * from './protocols/l2/switchport-config.js';
export * from './protocols/stp/cost.js';
export * from './protocols/stp/ids.js';
export * from './protocols/stp/vector.js';
export * from './protocols/stp.js';
export * from './protocols/stp/guards.js';
export * from './protocols/stp/mixed.js';
export * from './protocols/stp/pvst.js';
export * from './protocols/stp/rstp.js';

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

// trace
export * from './trace/filter.js';
export * from './trace/ring.js';

// io
export * from './io/migrate.js';
export * from './io/netforge-file.js';
export * from './io/pcap.js';
export * from './io/schema.js';

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
// sim — P2 [SHOULD S1] (W2 sim [S1])
export * from './sim/journal.js';
export * from './sim/replay.js';

// curriculum
export * from './contracts/curriculum.js';
export * from './curriculum/index.js';

// timeline — P2 [SHOULD S1] (W1 timeline)
export * from './timeline/lanes.js';
