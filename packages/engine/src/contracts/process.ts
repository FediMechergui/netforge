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
import type { Ipv6PortAddress, PortIpv4Address, PortView } from './port.js';
import type { Rng } from './rng.js';
import type { DeviceTables, Lpm6Result, LpmResult, RouteRow } from './tables.js';
import type { SimTime } from './time.js';
import type { Capability, PortRole } from './catalog.js';
import type { AirView, MediumEvent, MediumOp } from './medium.js';
import type { AppPayload, ProcessEvent, SocketId } from './transport.js';

/**
 * Demux layer = the frame's outer framing (`ethernet` | `hdlc` | `dot11`) or, for the `ingress` action on
 * loopback-style ports, the IP layer (`ipv4` | `ipv6`).
 */
export type DemuxLayer = 'ethernet' | 'hdlc' | 'dot11' | 'ipv4' | 'ipv6';

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
}

export type Severity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // syslog: 0 emerg … 7 debug

export interface DebugEvent {
  readonly at: SimTime;
  readonly device: DeviceId;
  readonly process: ProcessName;
  /** Debug category, matches `debug <category>` at the CLI: `'arp'`, `'ip icmp'`, `'ip packet'`, `'ip routing'`, `'ethernet switching'`, … */
  readonly category: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
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
  /** anyone → arp: send a gratuitous ARP for an interface address (after `ip address` on an up port). */
  | { kind: 'arp.gratuitous'; iface: PortId }
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
  /** ipv4/udp → icmpv4: generate an error (ttl-exceeded, unreachable) quoting `original`. */
  | { kind: 'icmp.error'; original: Pdu; type: number; code: number; inPort?: PortId }

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
  | { kind: 'udp.open'; owner: ProcessName; socket: SocketId; family: IpFamily; localAddr?: IpAddress; localPort?: number; iface?: PortId }
  | ({ kind: 'udp.send'; socket: SocketId; dst: IpAddress; dstPort: number; src?: IpAddress; iface?: PortId; ttl?: number; cause?: string; tag?: string; triggeredBy?: PduId } & AppPayload)
  | { kind: 'udp.close'; socket: SocketId }

  // ── P1: sockets (tcp) ──
  | { kind: 'tcp.listen'; owner: ProcessName; socket: SocketId; family: IpFamily; localPort: number; localAddr?: IpAddress; backlog?: number }
  | { kind: 'tcp.connect'; owner: ProcessName; socket: SocketId; dst: IpAddress; dstPort: number; src?: IpAddress; timeoutNs?: SimTime }
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
  /** Extension slot: non-built-in requests must be namespaced `ext.<name>` so built-in kinds still narrow. */
  | { kind: `ext.${string}`; [k: string]: unknown };

export type Action =
  /** Enqueue `pdu` for transmission on `port`. Applied per ROLE_TRAITS[role].egress (link / owner / loop). */
  | { type: 'send'; port: PortId; pdu: Pdu }
  /** Hand `pdu` to another daemon on this device (e.g. ethernet demux → ipv4 → icmpv4). */
  | { type: 'deliver'; to: ProcessName; pdu: Pdu; port: PortId }
  /** Ask another daemon to do something. */
  | { type: 'request'; to: ProcessName; req: ProcessRequest }
  /** Discard `pdu`; produces a `drop` trace event with a clickable reason (spec §9.1). */
  | { type: 'drop'; pdu: Pdu; reason: DropReason; detail?: string; port?: PortId }
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
  | { type: 'setPortL3'; port: PortId; ipv4?: PortIpv4Address | null; ipv6?: readonly Ipv6PortAddress[] | null; ipv6Enabled?: boolean | null; groups6?: readonly Ipv6Address[] | null }
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
  | { type: 'medium'; port: PortId; op: MediumOp };

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

