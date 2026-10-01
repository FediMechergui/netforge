/**
 * Process model — protocol daemons as cooperative state machines (spec §4.8).
 *
 * Two rules make the product work:
 *  1. `stateSnapshot()` is the ONLY way the UI learns a process's state.
 *  2. EVERY state-machine transition emits a DebugEvent via `ctx.debug`.
 *
 * Processes are pure with respect to side effects: handlers RETURN `Action[]`
 * and the device runtime applies them. This keeps every daemon unit-testable
 * ("given this PDU, expect these actions") and deterministic.
 *
 * Intra-device dispatch:
 *  • On `frameArrival` the runtime validates the frame (encap validator, size, port state, role) and
 *    hands it to the process whose `handles` selector matches best for the ingress port's EFFECTIVE
 *    ROLE and the frame's outer layer (ARCHITECTURE-P1 §3.1). A bridge registers
 *    `{layer:'ethernet', roles: BRIDGED_ROLES}`; a host/router registers `arp` for ethertype 0x0806
 *    and `ipv4` for 0x0800 on L3_ROLES (plus `{layer:'hdlc', ethertype:0x0800, roles:['wan']}` for serial);
 *    from P1, `ipv6` for 0x86dd on L3_ROLES plus `{layer:'hdlc', ethertype:0x86dd, roles:['wan']}`.
 *  • A process passes a PDU to another daemon with a `deliver` action, asks it to do something with a
 *    `request` action, and notifies it with an `event` action (sockets, resolver answers, probe results).
 *  • L3 → L4 delivery uses the static IP upper-layer table (protocols/ip-upper.ts), not selectors.
 *
 * Timer semantics: `{type:'timer', key, delay}` ARMS OR RE-ARMS the timer `key`
 * for this process. Re-arming cancels the previously scheduled event (the
 * runtime keeps a `(process,key) → seq` map and ignores a fired event whose seq
 * no longer matches). `cancelTimer` removes it. Keys are process-local.
 * `periodic: true` (D10) marks maintenance timers that re-arm indefinitely (sweeps, RA interval,
 * beacons, keepalives, rescans, DHCP lease T1/T2/expiry, DHCP restart pause `dhcp-restart:*`): `runToIdle`
 * does not wait for them. Protocol-progress one-shots (retransmissions incl. `dhcp:*`, DAD, TIME_WAIT, job
 * timeouts, offer hold, `arp-probe:*`, capped `persist:*`) are NOT periodic.
 *
 * Silence rule (P0.5/P1): no daemon emits unsolicited traffic without configuration (IPv6 needs an
 * interface ipv6 line, DHCP needs `ip address dhcp`, RA needs `ipv6 unicast-routing`, keepalives need a
 * clocked serial carrier, beacons need the `beacons` extension line), so adding daemons to P0 models
 * never changes P0 scenario traces.
 */
import type { DeviceId, PduId, PortId, ProcessName, SessionId } from './ids.js';
import type { IpAddress, IpFamily, Ipv4Address, Ipv6Address, MacAddress } from './addr.js';
import type { ConfigAst, ConfigDelta } from './config.js';
import type { DeviceModel } from './device.js';
import type { DropReason } from './link.js';
import type { LayerSpec, Pdu, PduMeta, FieldValue, MutationReason, RewrapOp } from './pdu.js';
import type { ErrDisableCause, Ipv6PortAddress, PortIpv4Address, PortView, VirtualIpv4 } from './port.js';
import type { Rng } from './rng.js';
import type { DeviceTables, Lpm6Result, LpmResult, RouteRow, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { Capability, DefaultsProfile, PortRole } from './catalog.js';
import type { AirView, MediumEvent, MediumOp } from './medium.js';
import type { BssSettings, RadioSettings } from './rf.js';
import type { AppPayload, ProcessEvent, SocketId } from './transport.js';
import type { DeviceClockView } from './clock.js';
import type { FileSystemId, StoredFile, StoredFileInput, StoredFileMeta } from './storage.js';

/**
 * Demux layer = the frame's outer framing (`ethernet` | `hdlc` | `dot11`) or, for the `ingress` action on
 * loopback-style ports, the IP layer (`ipv4` | `ipv6`). 'ppp' @since P3 [S19] (a PPP-framed serial port).
 */
export type DemuxLayer = 'ethernet' | 'hdlc' | 'dot11' | 'ipv4' | 'ipv6' | 'ppp';

/**
 * Which frames a process wants first-look at. A selector is a candidate iff `layer` matches the frame's
 * outer layer, the ingress port's effective role ∈ (`roles` ?? FRAME_ROLES), and every given key matches.
 * Score = 1 + number of defined keys (`ethertype`); highest wins; ties → `model.processes` order.
 * Keys per layer: ethernet → ethernet.type; hdlc → hdlc.protocol; dot11 → llc.type of data frames (EAPOL
 * 0x888e) — management frames match only key-less dot11 selectors; ipv4/ipv6 → key-less.
 * From P0.5 every built-in daemon declares `roles` explicitly (eth-switch BRIDGED_ROLES, arp/ipv4/ipv6
 * L3_ROLES, wlan daemons their radio role, hdlc ['wan','access-line']); `roles` is required since the P0.5 exit
 * gate (FRAME_ROLES = every frame-carrying role).
 */
export interface DemuxSelector {
  layer: DemuxLayer;
  ethertype?: number;
  /** @since P0.5 */
  roles: readonly PortRole[];
  /**
   * @since P2 (optional by meaning; wireless) dot11 only: matches 802.11 data frames (+1 score). EAPOL still reaches
   * wlan-ap via the PROCESS_ORDER tie (both score 2).
   */
  frame?: 'data';
}

export type Severity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // syslog: 0 emerg … 7 debug

/** @since P2 State machines that report transitions through `ctx.transition` (ARCHITECTURE-P2 D19). 'hsrp' [S2], 'pagp' [S3]. */
export type FsmMachine =
  | 'stp-port'
  | 'stp-bridge'
  | 'dtp'
  | 'lacp'
  | 'channel'
  | 'port-security'
  | 'err-disable'
  | 'nat'
  | 'dhcpv6'
  | 'capwap-wtp'
  | 'capwap-ac'
  // [SHOULD S2]
  | 'hsrp'
  // [SHOULD S3]
  | 'pagp'
  // ── P3 (ARCHITECTURE-P3 §2.4; appended, so every existing order is unchanged) ──
  /** @since P3 subject: the interface ('GigabitEthernet0/0'). */
  | 'ospf-if'
  /** @since P3 subject: interface and neighbour router id ('GigabitEthernet0/0 2.2.2.2'). */
  | 'ospf-nbr'
  /** @since P3 subject: the server address ('10.0.0.10'). */
  | 'ntp'
  /** @since P3 [S18] subject: the tunnel interface ('Tunnel0'). */
  | 'tunnel'
  /** @since P3 [S19] subject: the serial interface ('Serial0/0/0'). */
  | 'ppp-lcp'
  /** @since P3 [S19] subject: the serial interface. */
  | 'ppp-auth'
  /** @since P3 [S19] subject: interface and NCP ('Serial0/0/0 IPCP'). */
  | 'ppp-ncp'
  /** @since P3 [C1] subject: interface and neighbour address ('GigabitEthernet0/0 10.0.12.2'); states pending, up, down. */
  | 'eigrp-nbr'
  /** @since P3 [C1] subject: the prefix ('10.4.0.0/24'); states passive, active (§2.16). */
  | 'eigrp-route'
  /**
   * @since P3 [C13] subject: the tunnel interface ('Tunnel0'); states idle, init-sent, init-answered, auth-sent,
   * established, failed (§2.17).
   */
  | 'ike';

/**
 * @since P2 One state-machine transition. `subject` is stable and canonical-PortId based — never an abbreviation:
 * 'VLAN0010 GigabitEthernet0/1', 'Port-channel1 GigabitEthernet0/2', 'GigabitEthernet0/1' (dtp), 'controller
 * 192.168.99.5' (capwap-wtp). The history strip and the timeline lanes key on it.
 */
export interface FsmTransition {
  readonly machine: FsmMachine;
  readonly subject: string;
  readonly port?: PortId;
  /** VLAN, channel group, HSRP group or MST instance. */
  readonly instance?: number;
  readonly from: string;
  readonly to: string;
  /** Original-wording reason ('superior BPDU received', 'forward delay expired'). */
  readonly cause?: string;
  /** The PDU that triggered the transition, when one did. */
  readonly pdu?: PduId;
}

/** @since P2 What changed in an L2 change signal (D6). */
export type L2ChangeKind = 'vlans' | 'trunk' | 'channel' | 'stp' | 'security';

export interface DebugEvent {
  readonly at: SimTime;
  readonly device: DeviceId;
  readonly process: ProcessName;
  /** Debug category, matches `debug <category>` at the CLI: `'arp'`, `'ip icmp'`, `'ip packet'`, `'ip routing'`, `'ethernet switching'`, … */
  readonly category: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  /**
   * @since P2 (optional by meaning) Set only through `ctx.transition` (D19); P0/P1 daemons never set it, so their
   * debug bytes are unchanged.
   */
  readonly fsm?: FsmTransition;
}

/** JSON-serializable state for the UI (state-machine diagrams, tables, inspector "Processes" tab). */
export interface StateView {
  process: ProcessName;
  /** Free-form but stable per process; documented in each daemon's file header. Must be structured-clone safe (no Map/Set/class instances). */
  state: Record<string, unknown>;
}

/**
 * Requests one process can make of another (typed union; extend per protocol).
 * Built-in kinds are literal so `req.kind === '...'` narrows. Plugin/extension
 * requests MUST use a namespaced `ext.<name>` kind so they never swallow the
 * built-in discriminants.
 */
export type ProcessRequest =
  /**
   * ipv4 → arp: frame `pdu` (an IPv4 packet) for `nextHop` and send it out `iface`; resolve first if needed.
   * P0: no ethernet layer → `ctx.encapsulate(ethernet)`; ethernet outer → MacRewrite mutations.
   * P0.5: egress port encap 'hdlc' → no resolution; encapsulate/rewrap to `hdlc {address 0x0f, control 0,
   * protocol 0x0800}`; a non-ethernet outer leaving an ethernet port → `ctx.rewrap(strip 1, push ethernet)`.
   * The PduId never changes across L3→L2.
   */
  | { kind: 'arp.sendVia'; pdu: Pdu; nextHop: Ipv4Address; iface: PortId; cause?: string }
  /**
   * anyone → arp: send a gratuitous ARP for an interface address (after `ip address` on an up port).
   * @since P2 (optional by meaning) `address`/`mac` announce another address with another MAC (a virtual4 entry:
   * ipv4 on an `ipv4.virtual` add with local true); absent = today's behaviour (the interface address and MAC).
   */
  | { kind: 'arp.gratuitous'; iface: PortId; address?: Ipv4Address; mac?: MacAddress }
  /**
   * @since P1 dhcp-client → arp. Send `count` (default APIPA_PROBES) ARP requests out `iface`, `intervalNs`
   * (default APIPA_PROBE_INTERVAL_NS) apart: spa 0.0.0.0, sha = macOf(iface), tha 0, tpa = address, broadcast.
   * No port address is needed. Arms non-periodic timer `arp-probe:<token>`. When the last interval ends, or on
   * the first conflict, arp sends ProcessEvent `arp.probeResult` to `owner`. While a probe is active on `iface`,
   * a received ARP is a conflict iff spa === address, or it is a request with spa 0.0.0.0, tpa === address and
   * sha ≠ own MAC; on a conflict arp cancels the timer, reports `{conflict:true, mac: sha}` and does not touch
   * the ARP cache.
   */
  | { kind: 'arp.probe'; owner: ProcessName; token: string; iface: PortId; address: Ipv4Address; count?: number; intervalNs?: SimTime }
  /**
   * cli → icmpv4: start an echo job for a CLI session. `sizeBytes` is the IPv4 datagram TOTAL length
   * (default 100). `timeoutNs` per echo (default 2 s). `source` overrides source selection. `ttl` @since P1.
   * @since P1 `target` may also be a NAME: icmpv4 resolves it through dns-client and pings the first address (§4.8).
   */
  | { kind: 'icmp.ping'; session: SessionId; target: Ipv4Address; count: number; timeoutNs: SimTime; sizeBytes: number; source?: Ipv4Address; ttl?: number }
  /** cli → icmpv4: abort a running ping job (^Shift+6 / ^C). */
  | { kind: 'icmp.abort'; session: SessionId }
  /**
   * icmpv4/host/udp/tcp → ipv4: send an IPv4 packet (ipv4 routes it; `ipv4.src` already set).
   * @since P1 `iface` forces egress and skips LPM (required for 255.255.255.255 / DHCP); `nextHop` overrides the
   * route's next hop. `src` '0.0.0.0' is allowed only with `iface`. Limited broadcast without `iface` → drop
   * 'no-route' detail 'limited broadcast needs an egress interface'.
   */
  | { kind: 'ipv4.send'; pdu: Pdu; cause?: string; iface?: PortId; nextHop?: Ipv4Address }
  /**
   * ipv4/udp → icmpv4: generate an error (ttl-exceeded, unreachable) quoting `original`.
   * `param` @since P3 (optional by meaning) [S18]: the next-hop MTU, written into the low 16 bits of icmpv4 `unused`
   * (RFC 1191) for type 3 code 4 — the D15 fallback of every tunnel (GRE and [C13] IPsec). Absent = P1 bytes.
   */
  | { kind: 'icmp.error'; original: Pdu; type: number; code: number; inPort?: PortId; param?: number }

  // ── P1: RIB arbitration and DHCP-learned addressing (ipv4 owns PortL3.ipv4 and the rib) ──
  /** @since P1 host (ip default-gateway, S AD 1) / dhcp-client (D AD 254) → ipv4: offer or withdraw a candidate route; ipv4 installs the lowest AD per key. */
  | { kind: 'ipv4.route'; op: 'offer' | 'withdraw'; row: RouteRow; owner: ProcessName }
  /** @since P1 dhcp-client → ipv4: bind/unbind a leased address (setPortL3 origin 'dhcp', C/L routes, D default offer, gratuitous ARP). */
  | { kind: 'ipv4.lease'; op: 'bind' | 'unbind'; iface: PortId; address?: Ipv4Address; prefixLen?: number; router?: Ipv4Address; leaseExpiresAt?: SimTime; server?: Ipv4Address; origin?: 'dhcp' | 'apipa' }

  // ── P1: IPv6 ──
  /** @since P1 Send an IPv6 packet. Link-local/multicast destinations require `iface`. */
  | { kind: 'ipv6.send'; pdu: Pdu; cause?: string; iface?: PortId; nextHop?: Ipv6Address }
  /** @since P1 ipv6 → nd: frame for `nextHop` out `iface` (33:33 multicast or resolved MAC; hdlc protocol 0x86dd on serial). */
  | { kind: 'nd.sendVia'; pdu: Pdu; nextHop: Ipv6Address; iface: PortId; cause?: string }
  /** @since P1 ipv6 → nd: run DAD for a tentative address (result: ipv6.dadResult). */
  | { kind: 'nd.dad'; iface: PortId; address: Ipv6Address }
  /** @since P1 nd → ipv6. */
  | { kind: 'ipv6.dadResult'; iface: PortId; address: Ipv6Address; ok: boolean }
  /**
   * @since P1 nd → ipv6: an RA was learned (SLAAC prefix and/or default router). `routerLifetimeS` (@since P1, additive)
   * is the RA router lifetime: 0 = the sender is not a default router (RFC 4861 §4.2); absent = no expiry.
   */
  | { kind: 'ipv6.raLearned'; iface: PortId; router: Ipv6Address; prefix?: Ipv6Address; prefixLen?: number; validLifetimeS?: number; preferredLifetimeS?: number; managed: boolean; other: boolean; routerLifetimeS?: number }
  /** @since P1 cli → icmpv6: echo job. */
  | { kind: 'icmp6.ping'; session: SessionId; target: Ipv6Address; count: number; timeoutNs: SimTime; sizeBytes: number; source?: Ipv6Address; hopLimit?: number }
  /** @since P1 ipv6/udp → icmpv6: generate an error (`param` = pointer or MTU). */
  | { kind: 'icmp6.error'; original: Pdu; type: number; code: number; param?: number; inPort?: PortId }

  // ── P1: probes (traceroute ICMP mode); result = ProcessEvent 'icmp.result' to owner ──
  | { kind: 'icmp.probe'; owner: ProcessName; token: string; target: Ipv4Address; ttl: number; timeoutNs: SimTime; sizeBytes?: number }
  | { kind: 'icmp6.probe'; owner: ProcessName; token: string; target: Ipv6Address; hopLimit: number; timeoutNs: SimTime; sizeBytes?: number }

  // ── P1: sockets (udp) — ids chosen by the owner ('<owner>#<n>') ──
  /**
   * `tunnel` @since P2 (optional by meaning; wireless): a datagram matching a tunnel socket is delivered as
   * `sock.datagram` WITHOUT udp's `consume` action — the owner takes over the PDU's lifecycle (it rewraps and forwards
   * the same PduId, or consumes/drops it itself). Used only by capwap-ac and capwap-wtp for the data channel (5247),
   * so a tunnelled frame shows one PduId end to end and no `pduConsumed` before the station or the gateway (§3.12).
   */
  | { kind: 'udp.open'; owner: ProcessName; socket: SocketId; family: IpFamily; localAddr?: IpAddress; localPort?: number; iface?: PortId; tunnel?: true }
  | ({ kind: 'udp.send'; socket: SocketId; dst: IpAddress; dstPort: number; src?: IpAddress; iface?: PortId; ttl?: number; cause?: string; tag?: string; triggeredBy?: PduId } & AppPayload)
  | { kind: 'udp.close'; socket: SocketId }

  // ── P1: sockets (tcp) ──
  /**
   * `tls` @since P3 (optional by meaning): data segments of the connections accepted on this listener carry
   * `meta.protected` with `protectedBy: 'tls'` (RESTCONF, D21; no handshake bytes). `service` @since P3 (optional by
   * meaning) [S13]: a hidden listener (vty) — no `sockets` row, no debug line, no `sock.opened`, not in the tcp
   * StateView, so a P1/P2 router whose configuration holds `line vty` keeps its bytes (D14).
   */
  | { kind: 'tcp.listen'; owner: ProcessName; socket: SocketId; family: IpFamily; localPort: number; localAddr?: IpAddress; backlog?: number; tls?: true; service?: true }
  /** `tls` @since P3 (optional by meaning): the connection's data segments carry `meta.protected` + `protectedBy 'tls'`. */
  | { kind: 'tcp.connect'; owner: ProcessName; socket: SocketId; dst: IpAddress; dstPort: number; src?: IpAddress; timeoutNs?: SimTime; tls?: true }
  | { kind: 'tcp.send'; socket: SocketId; data: Uint8Array }
  /** Graceful: FIN after pending data. */
  | { kind: 'tcp.close'; socket: SocketId }
  /** RST now. */
  | { kind: 'tcp.abort'; socket: SocketId }

  // ── P1: applications and jobs ──
  /** @since P1 cli/GUI → dhcp-client: `ipconfig /renew|/release`. With `session`, progress prints to it and ends with cliDone. */
  | { kind: 'dhcp.client'; iface: PortId; op: 'renew' | 'release'; session?: SessionId }
  /** @since P1 any → dns-client: resolve; answer = ProcessEvent 'dns.result' to owner. */
  | { kind: 'dns.resolve'; owner: ProcessName; token: string; name: string; qtype: 'A' | 'AAAA'; server?: IpAddress }
  /** @since P1 cli → dns-client: nslookup job (original-wording output, then cliDone). */
  | { kind: 'dns.lookup'; session: SessionId; name: string; server?: IpAddress; qtype?: 'A' | 'AAAA' }
  /** @since P1 GUI/cli → http-client: fetch a URL; progress in the http-client StateView tab `token`. */
  | { kind: 'http.fetch'; owner: ProcessName; token: string; url: string; session?: SessionId }
  | { kind: 'http.cancel'; token: string }
  /** @since P1 cli → traceroute: router `traceroute` = mode 'udp', host `tracert` = mode 'icmp'. */
  | { kind: 'trace.start'; session: SessionId; target: string; family?: IpFamily; mode: 'udp' | 'icmp'; maxHops?: number; probes?: number; timeoutNs?: SimTime; source?: IpAddress }
  /** @since P1 Generic abort for CLI jobs (traceroute, nslookup, ping6, dhcp renew, http with session). `icmp.abort` stays for icmpv4 pings. */
  | { kind: 'job.abort'; session: SessionId }
  /** @since P0.5 GUI → wlan-client: refresh the scan list in its StateView. */
  | { kind: 'wlan.scan'; port: PortId }

  // ── P2: NAT hooks, virtual addresses, DHCPv6 leases (ARCHITECTURE-P2 §2.4, D14, D15, D16) ──
  /**
   * @since P2 ipv4 → nat: a packet arrived on an `ip nat outside` port, BEFORE the for-me test. nat answers with
   * exactly one of: request ipv4 'ipv4.resume' (translated or not), or a drop.
   */
  | { kind: 'nat.inbound'; pdu: Pdu; inPort: PortId }
  /**
   * @since P2 ipv4 → nat: routed, TTL already decremented, inPort inside, iface outside. nat answers with exactly one
   * of: request arp 'arp.sendVia' {pdu, nextHop, iface, cause}, or a drop ('nat-exhausted' | other).
   */
  /**
   * `filterOut` @since P3 (optional by meaning; D12): set by ipv4 when the egress interface has an outbound access
   * list; after translating, nat hands the packet to acl `acl.filter` {dir 'out', natted: true} with onPermit = the
   * `arp.sendVia` request it would have sent. Absent = the P2 seam.
   */
  | { kind: 'nat.outbound'; pdu: Pdu; inPort: PortId; iface: PortId; nextHop: Ipv4Address; cause?: string; filterOut?: true }
  /**
   * @since P2 nat → ipv4: continue receive processing at the for-me test; never handed to nat again.
   * `after` @since P3 (optional by meaning; D12): 'acl-in' = acl → ipv4, continue at the NAT inbound hook (the packet
   * passed the inbound list). Absent = the P2 meaning.
   */
  | { kind: 'ipv4.resume'; pdu: Pdu; inPort: PortId; after?: 'acl-in' }
  /** @since P2 cli → nat: `clear ip nat translation *` (dynamic rows only). */
  | { kind: 'nat.clear'; session?: SessionId }
  /**
   * @since P2 nat (and hsrp with S2) → ipv4: ipv4 merges by (owner, address), writes setPortL3 virtual4, and for an
   * add with `local` true sends arp.gratuitous {iface, address, mac}.
   */
  | { kind: 'ipv4.virtual'; op: 'add' | 'remove'; iface: PortId; address: Ipv4Address; mac: MacAddress; local: boolean; owner: ProcessName }
  /** @since P2 [SHOULD S2] hsrp → ipv4: merges by (owner, group) and writes setPortL3 groups4. */
  | { kind: 'ipv4.group'; op: 'join' | 'leave'; iface: PortId; group: Ipv4Address; owner: ProcessName }
  /**
   * @since P2 dhcpv6-client → ipv6: add/remove an Ipv6PortAddress with origin 'dhcpv6' (prefixLen 128), tentative →
   * DAD.
   */
  | {
      kind: 'ipv6.lease';
      op: 'bind' | 'unbind';
      iface: PortId;
      address?: Ipv6Address;
      prefixLen?: number;
      preferredUntil?: SimTime;
      validUntil?: SimTime;
      server?: Ipv6Address;
    }

  // ── P3 (ARCHITECTURE-P3 §2.4; every kind @since P3) ──
  /**
   * @since P3 A routing daemon (ospf; [C1] eigrp) → ipv4: REPLACE the owner's whole candidate set (D8). Rows sharing a
   * key are equal-cost paths in path order. ipv4 applies the batch in ascending (network u32, prefixLen) order —
   * re-offer changed slots, offer new ones, withdraw vanished ones — with arbiter owner `${owner}|${slot}`, runs
   * settleStatics once, sends no decision event, and emits one `ip routing` debug line per installed-row change.
   */
  | { kind: 'ipv4.routes'; owner: ProcessName; rows: readonly RouteRow[] }
  /**
   * @since P3 any → ipv4: register (replace) the owner's RIB watch (D8); answered at once and on every change by
   * ProcessEvent `ipv4.ribChanged` to the owner only. `keys` = exact RIB keys ('0.0.0.0/0'); `lpm` = addresses whose
   * longest-match result is watched (an unsynchronised NTP client's servers, D19; [S18] a tunnel destination). Both
   * empty or absent = stop the watch.
   */
  | { kind: 'ipv4.ribWatch'; owner: ProcessName; keys?: readonly string[]; lpm?: readonly Ipv4Address[] }
  /** @since P3 cli → ospf: `clear ip ospf process`, after the interactive confirm (refused headless). */
  | { kind: 'ospf.clear'; session?: SessionId }
  /**
   * @since P3 ipv4 (and nat on the `filterOut` path) → acl (D12). `inPort` (optional by meaning; dir 'out' only) = the
   * packet's ingress interface, used as the ICMP error's source interface. `natted` (optional by meaning) = set by
   * nat on the filterOut path (the packet is already translated). acl answers with EXACTLY ONE of: [onPermit]; or a
   * drop {reason 'acl-deny', port: iface, detail, rule} plus, when the rate gate is open, `no ip unreachables` is absent
   * and `natted` is not set, request icmpv4 icmp.error {3, 13, inPort: dir 'in' ? iface : inPort}. Counts on the
   * matched row. ([S11], not approved, would widen `family` with 6.)
   */
  | { kind: 'acl.filter'; family: 4; dir: 'in' | 'out'; iface: PortId; inPort?: PortId; natted?: true; pdu: Pdu; onPermit: Action }
  /** @since P3 cli → acl: `clear access-list counters [<list>]`. */
  | { kind: 'acl.clear'; list?: string }
  /**
   * @since P3 a process or the CLI (the host-shell `rest` job, owner 'cli') → http-client: resolve (dns-client for
   * names), tcp.connect {tls: url is https}, send the head and a Content-Length body, parse the response; answer
   * `http.result` to a process owner, or text to the CLI `session`. `http.fetch` is unchanged.
   */
  | { kind: 'http.request'; owner: ProcessName | 'cli'; token: string; method: HttpMethod; url: string; headers?: readonly (readonly [string, string])[]; body?: Uint8Array; timeoutNs?: SimTime; session?: SessionId }
  /** @since P3 host shell (`flow`) / GUI (the Traffic generator app) → traffic: start one generated flow (M13, D16). */
  | { kind: 'traffic.start'; flow: TrafficFlowSpec; session?: SessionId }
  /** @since P3 host shell / GUI → traffic: stop the flow `id`. */
  | { kind: 'traffic.stop'; id: string; session?: SessionId }
  /**
   * @since P3 cli `clock set` → ntp (D19): ntp returns the `clock {op: 'set', source: 'user'}` action and writes its
   * `clock` row (rule 20).
   */
  | { kind: 'ntp.clockSet'; unixMs: number; session?: SessionId }
  /**
   * @since P3 grader clone → tcp, applied exactly as icmp.ping is (§2.10): one SYN from an ephemeral port. The outcome
   * lands in the tcp StateView `probes`, keyed by session: 'open' on SYN-ACK (answered with a RST), 'refused' on RST,
   * 'unreachable' on an ICMP destination unreachable (type and code kept), 'timeout' after timeoutNs (3 s).
   */
  | { kind: 'tcp.probe'; session: string; dst: IpAddress; port: number; src?: IpAddress; timeoutNs: SimTime }
  /**
   * @since P3 grader clone → udp: one datagram (payload: the marker 'NFPR' and the session) from an ephemeral port;
   * the udp StateView records 'unreachable' on an ICMP error, else 'sent'.
   */
  | { kind: 'udp.probe'; session: string; dst: IpAddress; port: number; src?: IpAddress; timeoutNs: SimTime }
  // ── P3 [S13] remote terminal (D14) ──
  /**
   * @since P3 [S13] vty → acl: check `tuple` against the vty `access-class` list (answered by ProcessEvent
   * `acl.verdict` to `owner`, counted on the matched row with `lastIface 'vty'`). ([S11] would widen `family`.)
   */
  | { kind: 'acl.check'; family: 4; list: string; tuple: PacketTuple; token: string; owner: ProcessName }
  /** @since P3 [S13] cli (`telnet`, `ssh -l`) → vty-client: open a remote session from this device. */
  | { kind: 'vty.connect'; session: SessionId; target: IpAddress; proto: 'telnet' | 'ssh'; user?: string; password?: string; port?: number }
  /** @since P3 [S13] cli → vty-client: one line typed in a remote session. */
  | { kind: 'vty.input'; session: SessionId; line: string }
  /** @since P3 [S13] cli → vty-client: the escape / interrupt sequence of a remote session. */
  | { kind: 'vty.interrupt'; session: SessionId }
  // ── P3 [S32] NF-Py (D21) ──
  /** @since P3 [S32] host shell (`python`) / GUI (the automation workspace) → script-host: run a script of `files:`. */
  | { kind: 'script.run'; token: string; file: string; argv?: readonly string[]; session?: SessionId }
  /** @since P3 [S32] host shell / GUI → script-host: stop the run `token`. */
  | { kind: 'script.stop'; token: string }
  /** @since P3 [S32] GUI (the automation workspace) → script-host: write a file of `files:` (a `storage` action). */
  | { kind: 'file.write'; path: string; content: string }
  /** @since P3 [S32] GUI → script-host: delete a file of `files:`. */
  | { kind: 'file.delete'; path: string }
  // ── P3 [C1] EIGRP (§2.16) ──
  /** @since P3 [C1] cli → eigrp: `clear ip eigrp neighbors [<address>]` resets every neighbour (or one); not interactive. */
  | { kind: 'eigrp.clear'; neighbor?: IpAddress; session?: SessionId }
  // ── P3 [C13] site-to-site IPsec (§2.17) ──
  /**
   * @since P3 [C13] gre → ike: an ipsec-mode tunnel's underlay became ready or its protection profile changed; ike
   * opens `ike#500` if needed and arms `ike-kick:<port>` (0 ns).
   */
  | { kind: 'ike.connect'; port: PortId; local: Ipv4Address; peer: Ipv4Address; profile: string }
  /** @since P3 [C13] gre → ike: the underlay went, the mode left ipsec, or the tunnel was removed; ike drops the SA and its row. */
  | { kind: 'ike.disconnect'; port: PortId }
  /**
   * @since P3 [C13] ike → gre: the tunnel's SA. gre keeps the SPIs, the key id and its ESP sequence counter, writes
   * the `tunnels` row (up only while the SA is up) and issues `virtualChanged`.
   */
  | { kind: 'tunnel.sa'; port: PortId; op: 'up' | 'down'; spiIn?: number; spiOut?: number; keyId?: number; reason?: 'ike-negotiating' | 'ike-failed' | 'ike-no-proposal' | 'ike-no-response' }
  /** Extension slot: non-built-in requests must be namespaced `ext.<name>` so built-in kinds still narrow. */
  | { kind: `ext.${string}`; [k: string]: unknown };

// ── P3 request and action payloads (ARCHITECTURE-P3 §2.4) ──

/** @since P3 HTTP methods of `http.request` (D21). */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * @since P3 One generated flow (M13, D16). Caps: ≤ 8 flows per device; per flow ≤ 2 Mb/s and ≤ 1000 pps; every flow
 * stops at most TRAFFIC_MAX_DURATION_MS after it starts (a count or duration beyond it is refused).
 */
export interface TrafficFlowSpec {
  /** Default: the lowest free 'f<n>'. */
  readonly id?: string;
  readonly dst: IpAddress;
  /** Default 9 (discard). */
  readonly dstPort?: number;
  /** IP datagram size, 60–1500. */
  readonly sizeBytes: number;
  /** Exactly one of rateKbps and pps; pacing = floor(size·8·1e9 / rate) ns. */
  readonly rateKbps?: number;
  readonly pps?: number;
  /** 0–63, default 0. */
  readonly dscp?: number;
  /**
   * Bounded: a non-periodic pacing timer, so runToIdle waits for its end. Neither = continuous: a periodic pacing timer
   * that stops at `flow stop` or the cap; used only under runFor, because its datagrams commit non-periodic link
   * events and a congested link would hold runToIdle until the cap (rule 19).
   */
  readonly count?: number;
  readonly durationMs?: number;
  /** 50 pps × 60 B / × 200 B, dscp 46. */
  readonly preset?: 'voice-g729' | 'voice-g711';
}

/** @since P3 The hard cap of every generated flow: 5 minutes of sim time (D16). */
export const TRAFFIC_MAX_DURATION_MS = 300_000;

/**
 * @since P3 [S13] The packet fields an access list matches, as `core/acl`'s `tupleOf` builds them (D12): the IPv4
 * protocol number, the addresses, the ports of TCP/UDP, the ICMP type and code, and the TCP flags (`established`
 * matches ACK or RST). Used by `acl.check` (a vty login has no packet in hand: the tuple is the accepted SYN's).
 */
export interface PacketTuple {
  readonly family: 4;
  readonly proto: number;
  readonly src: Ipv4Address;
  readonly dst: Ipv4Address;
  readonly srcPort?: number;
  readonly dstPort?: number;
  readonly icmpType?: number;
  readonly icmpCode?: number;
  readonly tcpFlags?: number;
}

/** @since P3 Why a policy dropped a packet (D12, D13): the sentence, and where the rule lives. */
export interface DropRule {
  /** ([S15] 'ip-source-guard' and [S16] 'storm-control' are not approved.) */
  readonly kind: 'acl' | 'dhcp-snooping' | 'arp-inspection';
  /** Original wording, e.g. 'denied by access list 101 line 20 (deny tcp host 10.1.1.10 any eq www), inbound on GigabitEthernet0/0'. */
  readonly text: string;
  readonly table?: TableName;
  readonly key?: string;
  readonly config?: { readonly context: readonly (readonly string[])[]; readonly line: readonly string[] };
  readonly iface?: PortId;
  readonly dir?: 'in' | 'out';
  readonly list?: string;
  /** ([S11] would add 'nd-na' | 'nd-ns'.) */
  readonly seq?: number | 'implicit';
  /** ([S11] would add 6.) */
  readonly family?: 4;
}

/** @since P3 Who changed the configuration through the configure seam (D21). ([S33] snmp, [S29] tftp, [C21] netconf are not approved.) */
export interface ConfigOrigin {
  readonly via: 'restconf';
  readonly user?: string;
  readonly address?: IpAddress;
}

/**
 * @since P3 The `clock` action (D19): ntp only — a step after a valid reply, or a set on behalf of `clock set` (which
 * the CLI sends as `ntp.clockSet`). `offsetNs` is a decimal string and may be negative. The runtime rebases the device
 * clock and emits ONE ctx.transition-style debug event {machine: 'ntp', subject: reference, from, to} when the
 * synchronised state changes (category 'ntp events'); ntp writes its `clock` row.
 */
export interface ClockAction {
  type: 'clock';
  op: 'step' | 'set';
  offsetNs?: string;
  unixMs?: number;
  source: 'ntp' | 'master' | 'user';
  stratum?: number;
  reference?: string;
}

/**
 * @since P3 [S13] vty → runtime (D14): a server-side remote session event. The runtime schedules SimEvent
 * {kind: 'remoteCli', device, from, act} at now through deps.scheduler (zero delay, non-periodic); in THAT dispatch the
 * Simulation calls CliRuntime.openRemote / execRemote / closeRemote. No DeviceRuntimeDeps member.
 */
export interface RemoteCliAction {
  type: 'remoteCli';
  op: 'open' | 'line' | 'close';
  conn: string;
  peer?: IpAddress;
  proto?: 'telnet' | 'ssh';
  user?: string;
  text?: string;
}

/**
 * @since P3 [S13] vty-client → runtime (D14): the client-side state of a console session running a remote session
 * (the prompt, masked input, the "R1 via SSH" chip). Scheduled like `remoteCli`; the Simulation calls
 * CliRuntime.setRemote.
 */
export interface CliRemoteAction {
  type: 'cliRemote';
  session: SessionId;
  prompt?: string;
  input?: 'plain' | 'secret';
  remote?: string;
}

export type Action =
  /** Enqueue `pdu` for transmission on `port`. Applied per ROLE_TRAITS[role].egress (link / owner / loop). */
  | { type: 'send'; port: PortId; pdu: Pdu }
  /** Hand `pdu` to another daemon on this device (e.g. ethernet demux → ipv4 → icmpv4). */
  | { type: 'deliver'; to: ProcessName; pdu: Pdu; port: PortId }
  /** Ask another daemon to do something. */
  | { type: 'request'; to: ProcessName; req: ProcessRequest }
  /**
   * Discard `pdu`; produces a `drop` trace event with a clickable reason (spec §9.1).
   * `rule` @since P3 (optional by meaning; D12, D13): why a policy dropped it, passed through to the trace `drop` event.
   */
  | { type: 'drop'; pdu: Pdu; reason: DropReason; detail?: string; port?: PortId; rule?: DropRule }
  /** The PDU reached its final consumer (echo reply matched by the ping job). Emits `pduConsumed`. */
  | { type: 'consume'; pdu: Pdu }
  /** Arm (or re-arm) a timer identified by `key`. Fires `onTimer(ctx, key)` after `delay`. `periodic` (D10): see file header. */
  | { type: 'timer'; key: string; delay: SimTime; periodic?: boolean }
  | { type: 'cancelTimer'; key: string }
  /** Text for a CLI session (asynchronous command output such as ping replies). */
  | { type: 'cliOutput'; session: SessionId; text: string }
  /** Unblock a CLI session that was waiting on a job. */
  | { type: 'cliDone'; session: SessionId }
  /**
   * Update derived L3 state on a port (ipv4 writes `ipv4`; ipv6 writes `ipv6`, `ipv6Enabled`, `groups6`).
   * MERGE semantics per member: undefined = unchanged, null = clear, value = replace that member.
   * TRANSITION: the runtime treats an action carrying none of the members as "clear ipv4" until the P1 exit
   * gate. P1 W2 device adds merge and keeps this fallback. P1 W3 ipv4 switches to `ipv4: null` and updates
   * ip.ipv4.test. W8 deletes the fallback.
   */
  | {
      type: 'setPortL3';
      port: PortId;
      ipv4?: PortIpv4Address | null;
      ipv6?: readonly Ipv6PortAddress[] | null;
      ipv6Enabled?: boolean | null;
      groups6?: readonly Ipv6Address[] | null;
      /** @since P2 (optional by meaning) Same merge rules (absent = unchanged); written only by ipv4 (D15). */
      virtual4?: readonly VirtualIpv4[] | null;
      /** @since P2 (optional by meaning) [SHOULD S2] Same merge rules (absent = unchanged); written only by ipv4 (D15). */
      groups4?: readonly Ipv4Address[] | null;
    }
  /** Syslog line (original wording). */
  | { type: 'log'; severity: Severity; facility: string; message: string }
  /** @since P1 Deliver a ProcessEvent to `to`'s `onEvent` (sockets, resolver, probes, leases). Depth-first like request; missing target → runtime debug only. */
  | { type: 'event'; to: ProcessName; ev: ProcessEvent }
  /**
   * @since P0.5 Re-enter the frame pipeline on `port` at the MAC-filter/demux step, starting at `layer`
   * (default: the outer layer of `pdu`). Used by eth-switch for frames addressed to an SVI (clone per
   * receiver) and by 'loop' egress. Counts inPackets/inBytes on virtual ports only.
   */
  | { type: 'ingress'; port: PortId; pdu: Pdu; layer?: DemuxLayer }
  /** @since P0.5 Daemon → medium request (wlan-client/wlan-ap association authority, hdlc line protocol, cell attach). */
  | { type: 'medium'; port: PortId; op: MediumOp }

  // ── P2 (ARCHITECTURE-P2 §2.4; runtime semantics W1 device, `radio-profile` W4 device) ──
  /**
   * @since P2 Runtime: no-op if already err-disabled; else errDisabled = cause, portState reason 'err-disabled', log
   * severity 4 (original wording, includes `detail`), deps.onPortAdmin → link recompute (down).
   */
  | { type: 'errDisable'; port: PortId; cause: ErrDisableCause; detail?: string }
  /**
   * @since P2 Runtime: no-op unless errDisabled === cause; else clear it, portState reason 'err-recovered', log
   * severity 5, deps.onPortAdmin → link recompute (up if admin up and cabled).
   */
  | { type: 'errRecover'; port: PortId; cause: ErrDisableCause }
  /**
   * @since P2 Runtime: (1) for each p in L2_PROCESSES ∩ model.processes, p ≠ issuer, in L2_PROCESSES order:
   * applyActions(p, p.onEvent(ctx, {kind:'l2.changed', what, port, vlan, from: issuer})) depth-first;
   * (2) recomputeVirtual(now).
   */
  | { type: 'l2Changed'; what: L2ChangeKind; port?: PortId; vlan?: number }
  /**
   * @since P2 Runtime: applyConfigLine(context, line, negate) — configChange trace and onConfig fan-out as for a typed
   * line (the issuer receives its own onConfig too; eth-switch's handling of the sticky line is idempotent, §3.8).
   * Used by eth-switch for sticky secure MACs. Counts against ACTION_BUDGET like any action.
   */
  | { type: 'configLine'; context: readonly (readonly string[])[]; line: readonly string[]; negate: boolean }
  /**
   * @since P2 (wireless; W4 device) capwap-wtp → runtime: store (null = clear) the controller profile of radio `port`,
   * then onPortPhyConfig(port). `controller` (@since P2, optional by meaning: absent = no name to show) names the
   * controller that pushed the profile; the runtime stores it with the profile and `radioSettings(port)` reports it
   * as `RadioSettings.controller` (§2.12, display only).
   */
  | { type: 'radio-profile'; port: PortId; bss: readonly BssSettings[] | null; controller?: string }

  // ── P3 (ARCHITECTURE-P3 §2.4; every type @since P3) ──
  /**
   * @since P3 A daemon changes its device's configuration (D21): the runtime schedules SimEvent {kind:
   * 'deviceConfigure'} at now through deps.scheduler (zero delay, non-periodic). In THAT dispatch the Simulation — the
   * one caller — runs cliCore.configure(device, lines, {atomic, indentation, origin}) with its own ACTION_BUDGET; the
   * headless session hands `origin` to applyConfigLine for each line; then it delivers ProcessEvent
   * {kind: 'config.result', token, result} to the issuer. Never nested, never journaled.
   */
  | { type: 'configure'; token: string; lines: readonly string[]; atomic?: boolean; indentation?: boolean; origin: ConfigOrigin }
  /** @since P3 ntp → runtime: rebase the device clock (D19; see ClockAction). */
  | ClockAction
  /** @since P3 [S18] gre → runtime: recomputeVirtual(now) (a tunnel's line protocol from its `tunnels` row, D17). */
  | { type: 'virtualChanged' }
  /** @since P3 [S13] vty → runtime (see RemoteCliAction). */
  | RemoteCliAction
  /** @since P3 [S13] vty-client → runtime (see CliRemoteAction). */
  | CliRemoteAction
  /**
   * @since P3 [S32] script-host → runtime: write or delete a file of the host's `files:` store (D21; [S29], not
   * approved, would add flash: and nvram:).
   */
  | { type: 'storage'; op: 'write' | 'delete'; fs: FileSystemId; path: string; file?: StoredFileInput };

/** Everything a process may read/do synchronously. Passed fresh into every handler. */
export interface ProcessCtx {
  readonly now: SimTime;
  readonly deviceId: DeviceId;
  readonly hostname: string;
  /**
   * Catalog model of this device. Daemons key behaviour on DATA, never on `kind`:
   *   ipv4  : forward only when `model.ipForwarding`; act only on ports whose role trait is l3
   *   arp   : cache timeout = `model.ipDefaults.arpTimeoutNs` (P0 fallback: kind === 'router')
   *   icmpv4: originated TTL = `model.ipDefaults.ttl` (P0 fallback: kind === 'router')
   */
  readonly model: Readonly<DeviceModel>;
  readonly ports: ReadonlyMap<PortId, PortView>;
  readonly tables: DeviceTables;
  readonly config: ConfigAst;
  /**
   * This process's private rng sub-stream. Do not re-split per use (`split` is pure in (origin, label) and
   * returns identical values every time); use `ctx.stream(label)` for per-concern draws.
   */
  readonly rng: Rng;
  /**
   * @since P1 Cached child stream `label` of `rng`: created with `rng.split(label)` on first call, then the SAME
   * object is returned for the life of this process ctx (one ctx per process instance, rebuilt at boot), so
   * successive draws advance it. Never call `rng.split(label)` per use: split is pure and returns identical values.
   */
  stream(label: string): Rng;
  /** Emit a DebugEvent (rule 2). Cheap; the runtime filters. */
  debug(category: string, message: string, data?: Record<string, unknown>): void;
  /** Build a new PDU stamped with this device/time. Emits `pduCreated`. */
  newPdu(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu;
  /** Mutate a PDU field with provenance stamped as this device/time. Emits `mutation`. */
  mutate(pdu: Pdu, field: string, after: FieldValue, reason: MutationReason, cause?: string): void;
  /** Wrap `pdu` in `outer` in place (same id), provenance stamped as this device/time. See `Pdu.encapsulate`. */
  encapsulate(pdu: Pdu, outer: LayerSpec, cause?: string): void;
  /** Clone a PDU (fan-out) with a fresh id. Runtime implements this as `factory.clone(pdu, now)`. */
  clone(pdu: Pdu): Pdu;
  /** Longest-prefix match over `tables.rib`. */
  lpm(dst: Ipv4Address): LpmResult;
  /** Is `ip` one of this device's own interface addresses? Returns the port if so. */
  ownAddress(ip: Ipv4Address): PortId | undefined;
  /**
   * For-me test for a received packet: own unicast address, limited broadcast
   * 255.255.255.255, or the directed broadcast of the subnet configured on `inPort`.
   */
  isLocalDestination(ip: Ipv4Address, inPort?: PortId): boolean;
  /** Port whose subnet contains `ip` (directly connected), if any. */
  connectedPortFor(ip: Ipv4Address): PortId | undefined;
  /**
   * Source-address selection for locally-originated packets: the address of the egress
   * port chosen by `lpm(dst)` (connected or via next-hop), or undefined when there is no
   * route / the egress port has no address (→ the caller drops `no-route` / `no-l3-address`).
   */
  sourceFor(dst: Ipv4Address): { address: Ipv4Address; iface: PortId } | undefined;
  /** MAC of a port. */
  macOf(port: PortId): MacAddress;

  // ── P0.5 / P1 (always provided by device/process-ctx.ts) ──
  /** @since P0.5 Structural rewrap in place (same id), provenance stamped and mirrored as `mutation` trace events. See `Pdu.rewrap`. */
  rewrap(pdu: Pdu, op: RewrapOp, cause?: string): void;
  /** @since P0.5 Effective capability test (model + installed modules). */
  hasCapability(cap: Capability): boolean;
  /** @since P0.5 RF view for wlan/cell daemons (undefined on devices without radios). */
  readonly air?: AirView;
  /** @since P1 Longest-prefix match over `tables.get('rib6')`. */
  lpm6(dst: Ipv6Address): Lpm6Result;
  /** @since P1 Port owning `ip` (any DAD state). */
  ownAddress6(ip: Ipv6Address): PortId | undefined;
  /** @since P1 Own PREFERRED unicast on an oper-up port, or a multicast group joined on `inPort` (any port when omitted). */
  isLocalDestination6(ip: Ipv6Address, inPort?: PortId): boolean;
  /** @since P1 Port with an on-link prefix containing `ip` (link-local needs `hint`). */
  connectedPortFor6(ip: Ipv6Address, hint?: PortId): PortId | undefined;
  /** @since P1 RFC 6724-lite source selection (ARCHITECTURE-P1 §4.8); `iface` forces egress (link-local / multicast destinations). */
  sourceFor6(dst: Ipv6Address, iface?: PortId): { address: Ipv6Address; iface: PortId } | undefined;

  // ── P2 (ARCHITECTURE-P2 §2.4) ──
  /**
   * @since P2 The world's defaults profile (D2). Read ONLY for invisible defaults (P2: proxy ARP). Required since W1
   * device (transition rule; hand-built typed fakes spread `P2_CTX` from test/port.fixtures.ts).
   */
  readonly profile: DefaultsProfile;
  /**
   * @since P2 Emits exactly ONE debug event (as ctx.debug) whose DebugEvent.fsm = fsm (D19). `category` is the
   * daemon's §5.4 debug category, character for character, so `debug <category>` prints it. Required since W1 device.
   */
  transition(category: string, message: string, fsm: FsmTransition, data?: Record<string, unknown>): void;
  /**
   * @since P2 (optional by meaning; wireless; W4 device, device/process-ctx.ts) The ONE radio settings renderer:
   * local interface lines overlaid by a controller profile (`radio-profile` action). wlan-ap switches from its private
   * renderer to this; for a radio with no controller profile the result is byte-identical to today's renderer.
   */
  radioSettings?(port: PortId): RadioSettings | undefined;

  // ── P3 (ARCHITECTURE-P3 §2.4; required since W1 device — hand-built typed fakes spread `P3_CTX` from
  //    test/port.fixtures.ts, §0 rule 2, §9.2 item 19) ──
  /** @since P3 The device clock (D19, contracts/clock.ts). Required since W1 device. */
  clock(): DeviceClockView;
  /** @since P3 [S32] The files of a host's store (hosts' `files:` only in P3a; D21). Required since W1 device. */
  files(fs: FileSystemId): readonly StoredFileMeta[];
  /** @since P3 [S32] One file of a host's store, or undefined. Required since W1 device. */
  readFile(fs: FileSystemId, path: string): StoredFile | undefined;
}

export interface Process {
  readonly name: ProcessName;
  /** Frames this process wants directly from the wire. Omit for processes only reached via deliver/request/event. */
  readonly handles?: readonly DemuxSelector[];
  /** Called once at device boot (after config is loaded). */
  init?(ctx: ProcessCtx): Action[];
  /** A frame/packet reached this process (from the wire or via `deliver`). */
  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[];
  onTimer(ctx: ProcessCtx, key: string): Action[];
  /** A config line relevant to anyone changed. Processes ignore what they don't own. */
  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[];
  /** A port's oper state changed. During a role-change bounce, trust `up`, not the port view. */
  onLinkChange?(ctx: ProcessCtx, port: PortId, up: boolean): Action[];
  onRequest?(ctx: ProcessCtx, req: ProcessRequest): Action[];
  stateSnapshot(): StateView;
  /** Recent DebugEvents (ring, newest last). The runtime also receives them via ctx.debug. */
  debugEvents(): readonly DebugEvent[];
  /** @since P1 A ProcessEvent arrived (Action 'event'). */
  onEvent?(ctx: ProcessCtx, ev: ProcessEvent): Action[];
  /** @since P1 Called before RAM is cleared at power-off/reload; actions are applied (traces only; links go down right after). */
  onShutdown?(ctx: ProcessCtx): Action[];
  /**
   * @since P0.5 Egress hook for ports whose role trait egress is 'owner' and whose owner (`model.portOwners[role]`)
   * is this process: called when ANOTHER process sends on such a port (eth-switch bridges SVI traffic).
   */
  onEgress?(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[];
  /** @since P0.5 Medium notification for one of this device's radio/serial ports. */
  onMediumEvent?(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[];
}

/** Constructor signature for the process registry (the catalog maps model → process factories). */
export type ProcessFactory = () => Process;

