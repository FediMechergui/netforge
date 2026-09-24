/**
 * Socket layer (P1; ARCHITECTURE-P1 §4.2, §4.5) shared by the 'udp' and 'tcp' processes and the
 * application daemons (dhcp-client, dhcp-server, dns-client, dns-server, http-server, http-client,
 * traceroute).
 *
 * Applications talk to transport ONLY with ProcessRequests (contracts/process.ts: udp.open/udp.send/
 * udp.close, tcp.listen/tcp.connect/tcp.send/tcp.close/tcp.abort) and receive ProcessEvents through
 * `Action {type:'event'}` → `Process.onEvent`. Socket ids are chosen by the OWNER ('<owner>#<n>'), so no
 * round trip is needed before sending; a duplicate id gets a 'sock.error' addr-in-use. Accepted TCP
 * children are '<listenId>/<n>' allocated by tcp. Transport writes `tables.sockets` (netstat = table rows).
 *
 * Port conflict key = (proto, family, localAddr, localPort, iface ?? '*'). A bind conflicts only when proto, family
 * and port match, the addresses are equal (or either is the wildcard), and the ifaces are equal (or either is
 * unrestricted); so 'dhcp-client#Gi0/0' and 'dhcp-client#Gi0/1' (0.0.0.0:68, different ifaces) and
 * 'http-server#80' / 'http-server#80v6' (different families) coexist. Receive match order: exact addr+iface,
 * exact addr, wildcard+iface, wildcard.
 *
 * Determinism: ephemeral ports = 49152 + rng.nextInt(0, 16383) once per process lifetime (then sequential
 * with wrap, skipping ports in use); TCP ISNs = `ctx.stream('isn').nextU32()`, one draw per connection from the
 * cached child stream (never `ctx.rng.split('isn')` per use: split is pure and would repeat the same ISN). All TCP
 * arithmetic (SRTT/RTTVAR shifts, cwnd bytes) is integer.
 */
import type { IpAddress, IpFamily, Ipv4Address, Ipv6Address, MacAddress } from './addr.js';
import type { PortId, ProcessName } from './ids.js';
import type { LayerSpec, Pdu } from './pdu.js';
import type { L2ChangeKind } from './process.js';
import type { WifiAssocState } from './medium.js';
import type { SimTime } from './time.js';
import { MS, SEC } from './time.js';

/** '<owner>#<n>' chosen by the owner; accepted TCP children are '<listenId>/<n>'. Unique per device and proto. */
export type SocketId = string;

export type TcpState =
  | 'CLOSED'
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RECEIVED'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT';

export type SocketErrorCode =
  | 'addr-in-use'
  | 'bad-socket'
  | 'no-address'
  | 'no-route'
  | 'refused'
  | 'reset'
  | 'timeout'
  | 'host-unreachable'
  | 'net-unreachable'
  | 'port-unreachable'
  | 'proto-unreachable'
  | 'ttl-exceeded';

/** Events for application processes. `socket` is always the id the owner used (or the accepted child id). */
export type SocketEvent =
  | { kind: 'sock.opened'; socket: SocketId; proto: 'udp' | 'tcp'; family: IpFamily; localAddr: IpAddress; localPort: number }
  /** One UDP datagram. `pdu` is the received PDU (already consumed by udp); `data` its UDP payload bytes. */
  | { kind: 'sock.datagram'; socket: SocketId; from: IpAddress; fromPort: number; to: IpAddress; iface: PortId; data: Uint8Array; pdu: Pdu }
  | { kind: 'sock.connected'; socket: SocketId; localAddr: IpAddress; localPort: number; remoteAddr: IpAddress; remotePort: number }
  | { kind: 'sock.accepted'; socket: SocketId; listener: SocketId; remoteAddr: IpAddress; remotePort: number; localAddr: IpAddress; localPort: number }
  /** In-order stream bytes (TCP). `pdu` = the segment that completed this data (for triggeredBy). */
  | { kind: 'sock.data'; socket: SocketId; data: Uint8Array; pdu: Pdu }
  /** Everything given to tcp.send has been acknowledged. */
  | { kind: 'sock.drained'; socket: SocketId }
  /** The peer sent FIN (CLOSE_WAIT); the owner finishes writing and calls tcp.close. */
  | { kind: 'sock.peerClosed'; socket: SocketId }
  /** Fully closed (CLOSED or TIME_WAIT reached). The id may be reused after this. */
  | { kind: 'sock.closed'; socket: SocketId }
  /**
   * Failure. UDP: a sock.error never closes the socket (ICMP-derived errors, and send-time no-route/no-address,
   * included); only udp.close closes it and emits sock.closed. TCP: the connection is closed (a sock.closed is not
   * also emitted). code === 'addr-in-use' on udp.open/tcp.listen/tcp.connect means the socket never opened.
   * ICMP-derived errors carry `from` (the reporting router) and the quoted detail (traceroute reads quotedDstPort).
   */
  | {
      kind: 'sock.error';
      socket: SocketId;
      code: SocketErrorCode;
      detail?: string;
      from?: IpAddress;
      icmp?: { type: number; code: number; quotedDstPort?: number; quotedTtl?: number; pdu: Pdu };
    };

/**
 * Result of an icmp.probe / icmp6.probe (traceroute ICMP mode). `timeout` (@since P1 W3, additive): no answer
 * within the probe's `timeoutNs` (the `probe:<token>` timer fired).
 */
export interface ProbeResultEvent {
  kind: 'icmp.result';
  token: string;
  outcome: 'reply' | 'ttl-exceeded' | 'unreachable' | 'no-route' | 'timeout';
  from?: IpAddress;
  type?: number;
  code?: number;
  sentAt: SimTime;
  pdu?: Pdu;
}

/** DNS resolver answer for dns.resolve. */
export interface ResolveEvent {
  kind: 'dns.result';
  token: string;
  name: string;
  qtype: 'A' | 'AAAA';
  /** Canonical addresses in answer order after CNAME chasing; empty on failure. */
  addresses: IpAddress[];
  rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'TIMEOUT' | 'NO-SERVER';
  server?: IpAddress;
  fromCache: boolean;
  cname?: string;
}

/**
 * DHCP client lease changes, delivered to interested daemons (dns-client; since P2 W5 also capwap-wtp, and only on a
 * model that runs it, so a lightweight AP starts controller discovery the moment its management address is leased).
 * `family` @since P2 (optional by meaning): absent = IPv4 (dhcp-client); dhcpv6-client sends
 * {kind:'dhcp.lease', family: 6, iface, op, dnsServers, domainName}. Consumer rule (dns-client, W3 svc): learned
 * servers are keyed by (iface, family); a lease replaces only its own family's list and 'lost' removes only that
 * family's list; the resolver order is the IPv4 list, then the IPv6 list. A v4-only world never sets family, so
 * dns-client's behaviour and debug text there are unchanged.
 */
export interface LeaseEvent {
  kind: 'dhcp.lease';
  iface: PortId;
  op: 'bound' | 'renewed' | 'lost';
  dnsServers: IpAddress[];
  domainName?: string;
  family?: 6;
}

/** @since P1 arp → owner: outcome of an `arp.probe` request (APIPA conflict detection). */
export interface ArpProbeResultEvent {
  kind: 'arp.probeResult';
  token: string;
  iface: PortId;
  address: Ipv4Address;
  conflict: boolean;
  /** Sender hardware address of the conflicting ARP. */
  mac?: MacAddress;
}

// ── P2 events (ARCHITECTURE-P2 §2.5) ──

/** @since P2 runtime → every other L2 daemon, after an `l2Changed` action (D6). */
export interface L2ChangedEvent {
  kind: 'l2.changed';
  what: L2ChangeKind;
  port?: PortId;
  vlan?: number;
  /** The daemon that issued the `l2Changed` action. */
  from: ProcessName;
}

/**
 * @since P2 stp → eth-switch: flush ('flush' deletes the VLAN's dynamic rows on exactly `ports` now) or fast-age
 * ('fast-age' caps expiresAt at now + ageingNs for the VLAN's dynamic rows on exactly `ports`). stp names the ports:
 * 802.1w lists the non-edge ports it flushes (edge ports are never flushed); 802.1D lists every STP port of the VLAN.
 * Secure rows are never touched (D12).
 */
export interface L2FlushEvent {
  kind: 'l2.flush';
  vlan: number;
  mode: 'flush' | 'fast-age';
  ports: readonly PortId[];
  ageingNs?: SimTime;
}

/** @since P2 ipv6 → dhcpv6-client: the M/O flags of the router last heard on `iface` (sent only when they change and dhcpv6-client exists). */
export interface RaFlagsEvent {
  kind: 'ipv6.ra';
  iface: PortId;
  router: Ipv6Address;
  managed: boolean;
  other: boolean;
}

/**
 * @since P2 (wireless) wlan-ap → capwap-wtp: an association grant of a CENTRAL BSS changed (sent only when capwap-wtp
 * is in model.processes; local BSSs never send it, so P1 wireless traces are unchanged). capwap-wtp turns each into
 * one WTP Event Request station report (§3.12 step 5).
 */
export interface WlanGrantEvent {
  kind: 'wlan.grant';
  op: 'add' | 'del';
  port: PortId;
  station: MacAddress;
  bssid: MacAddress;
  wlanId: number;
  state: WifiAssocState;
}

/** Every event a process can receive via Action 'event'. Extension events are namespaced 'ext.*'. P2 adds the four events above. */
export type ProcessEvent =
  | SocketEvent
  | ProbeResultEvent
  | ResolveEvent
  | LeaseEvent
  | ArpProbeResultEvent
  | L2ChangedEvent
  | L2FlushEvent
  | RaFlagsEvent
  | WlanGrantEvent
  | { kind: `ext.${string}`; [k: string]: unknown };

/** Payload accepted by udp.send: raw bytes OR application layer specs encoded by the transport. */
export type AppPayload = { data: Uint8Array; app?: undefined } | { app: readonly LayerSpec[]; data?: undefined };

export const EPHEMERAL_PORT_MIN = 49152;
export const EPHEMERAL_PORT_MAX = 65535;
export const TCP_MSS_IPV4 = 1460;
export const TCP_MSS_IPV6 = 1440;
export const TCP_DEFAULT_WINDOW = 65535;
/** Initial RTO 1 s; 200 ms floor after RTT samples (short LAN retransmit demos); max 60 s. */
export const TCP_INITIAL_RTO_NS: SimTime = 1 * SEC;
export const TCP_MIN_RTO_NS: SimTime = 200 * MS;
export const TCP_MAX_RTO_NS: SimTime = 60 * SEC;
export const TCP_MAX_RETRANSMITS = 5;
export const TCP_SYN_RETRIES = 3;
export const TCP_DELAYED_ACK_NS: SimTime = 200 * MS;
/** TIME_WAIT = 2 × MSL = 60 s (real timers; the UI clock policy handles visibility). */
export const TCP_MSL_NS: SimTime = 30 * SEC;
export const TCP_DUPACK_THRESHOLD = 3;
export const TCP_PERSIST_MIN_NS: SimTime = 1 * SEC;
/** @since P1 Zero-window persist probes (RTO backoff, max 60 s; `persist:*` never periodic): after this many unanswered-window probes the connection aborts with `sock.error timeout`, so runToIdle terminates. */
export const TCP_PERSIST_MAX_PROBES = 5;
export const TCP_LISTEN_BACKLOG = 16;
export const TCP_SEND_BUFFER = 262_144;
