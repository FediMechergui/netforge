/**
 * Application-layer and neighbour-discovery constants and shared value types (P1; DHCPv4, DNS, HTTP,
 * traceroute, IPv6 ND/SLAAC). Original wording only. Fractions are expressed in permille so lease maths
 * stays integer: t1 = floor(leaseNs × 500 / 1000).
 *
 * FTP/TFTP/SMTP/POP3/IMAP/NTP/SNMP/Syslog/Telnet/SSH are RESERVED (D1): their ports are in
 * contracts/fields.ts DISPATCH_TABLE with `reserved`, and decode as payload; no daemons.
 */
import type { IpAddress, Ipv4Address, MacAddress } from './addr.js';
import type { SimTime } from './time.js';
import { MIN, SEC } from './time.js';

// ── DHCPv4 ───────────────────────────────────────────────────────────────────

export type DhcpMessageType = 'DISCOVER' | 'OFFER' | 'REQUEST' | 'DECLINE' | 'ACK' | 'NAK' | 'RELEASE' | 'INFORM';
export type DhcpClientState = 'DISABLED' | 'INIT' | 'SELECTING' | 'REQUESTING' | 'BOUND' | 'RENEWING' | 'REBINDING' | 'INIT-REBOOT' | 'APIPA';

export const DHCP_DEFAULT_LEASE_S = 86_400;
export const DHCP_T1_PERMILLE = 500;
export const DHCP_T2_PERMILLE = 875;
/** Retransmit 4, 8, 16, 32, 64 s with ±1 s jitter drawn from `ctx.stream('dhcp-jitter:<iface>')` (cached; one draw per retransmit). */
export const DHCP_RETRANSMIT_INITIAL_NS: SimTime = 4 * SEC;
export const DHCP_RETRANSMIT_MAX_NS: SimTime = 64 * SEC;
/** DISCOVER attempts per cycle before falling back to APIPA and pausing. */
export const DHCP_DISCOVER_RETRIES = 4;
/** Pause before a new DISCOVER cycle after APIPA. Timer key 'dhcp-restart:<iface>', periodic: true (D10). */
export const DHCP_RESTART_PAUSE_NS: SimTime = 60 * SEC;
/**
 * Timer keys: per-cycle DISCOVER/REQUEST retransmit 'dhcp:<iface>' (not periodic); pause after APIPA before the
 * next cycle 'dhcp-restart:<iface>' (periodic: true, so runToIdle returns once APIPA is bound).
 */
export const DHCP_RETRANSMIT_TIMER_PREFIX = 'dhcp:';
export const DHCP_RESTART_TIMER_PREFIX = 'dhcp-restart:';
/** Server holds an offered address for this long awaiting REQUEST. */
export const DHCP_OFFER_HOLD_NS: SimTime = 60 * SEC;
/** Server ping-before-offer: RESERVED (off). */
export const DHCP_PING_CHECK = false;
/** Relay hop limit (loop guard). */
export const DHCP_MAX_HOPS = 16;
/**
 * APIPA fallback (169.254/16): address = 169.254.[1..254].[0..255] from `ctx.stream('apipa:<iface>')` (cached;
 * a conflict draws the next candidate); ARP probe 3 × 1 s via `arp.probe`, then announce.
 */
export const APIPA_PROBES = 3;
export const APIPA_PROBE_INTERVAL_NS: SimTime = 1 * SEC;

export interface DhcpPoolView {
  name: string;
  network: Ipv4Address;
  prefixLen: number;
  router?: Ipv4Address;
  dns: IpAddress[];
  domain?: string;
  leaseS: number;
  excluded: string[];
  free: number;
  bound: number;
}

export type DhcpClientIdentity = { chaddr: MacAddress; clientId?: string };

// ── DNS ──────────────────────────────────────────────────────────────────────

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'PTR' | 'NS' | 'SOA';
export const DNS_TYPE_CODE: Readonly<Record<DnsType, number>> = Object.freeze({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, AAAA: 28 });

/** One resource record. `data` for MX is 'pref host'. Names lowercase, no trailing dot. */
export interface DnsRecord {
  name: string;
  type: DnsType;
  ttl: number;
  data: string;
}

export const DNS_CLIENT_TIMEOUT_NS: SimTime = 2 * SEC;
export const DNS_CLIENT_RETRIES = 2;
export const DNS_NEGATIVE_TTL_S = 60;
export const DNS_DEFAULT_TTL_S = 300;
export const DNS_MAX_CNAME_CHAIN = 8;
/** Responses are capped at 512 bytes by dropping additionals; tc is never set in P1. */
export const DNS_UDP_MAX = 512;

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const HTTP_CLIENT_TIMEOUT_NS: SimTime = 10 * SEC;
/** @since P1 How long an accepted connection may stay open without completing a request head (408 then close). */
export const HTTP_REQUEST_TIMEOUT_NS: SimTime = 30 * SEC;
export const HTTP_MAX_BODY_BYTES = 1_000_000;
export const HTTP_BROWSER_USER_AGENT = 'NetForge-Browser/1';
export const HTTP_SERVER_HEADER = 'NetForge-HTTP';

export interface HttpResponseView {
  status: number;
  reason: string;
  headers: string;
  body: string;
}

/** Phases of an http-client tab (StateView `tabs[]`, read by the Desktop browser). */
export type HttpTabPhase = 'resolving' | 'connecting' | 'waiting' | 'receiving' | 'done' | 'error';

// ── traceroute ───────────────────────────────────────────────────────────────

export const TRACEROUTE_MAX_HOPS = 30;
export const TRACEROUTE_PROBES = 3;
export const TRACEROUTE_TIMEOUT_NS: SimTime = 3 * SEC;

// ── IPv6 neighbour discovery / SLAAC ─────────────────────────────────────────

export const ND_REACHABLE_NS: SimTime = 30 * SEC;
export const ND_DELAY_NS: SimTime = 5 * SEC;
export const ND_RETRANS_NS: SimTime = 1 * SEC;
export const ND_MAX_MULTICAST_SOLICIT = 3;
export const ND_MAX_UNICAST_SOLICIT = 3;
export const ND_DAD_TRANSMITS = 1;
export const ND_DAD_TIMEOUT_NS: SimTime = 1 * SEC;
export const ND_RS_MAX = 3;
export const ND_RS_INTERVAL_NS: SimTime = 4 * SEC;
export const ND_RS_MAX_DELAY_NS: SimTime = 1 * SEC;
export const ND_RA_INTERVAL_NS: SimTime = 200 * SEC;
export const ND_RA_RESPONSE_MAX_DELAY_NS: SimTime = SEC / 2;
export const ND_RA_VALID_LIFETIME_S = 2_592_000;
export const ND_RA_PREFERRED_LIFETIME_S = 604_800;
/** Queue per unresolved neighbour (mirrors ARP). */
export const ND_QUEUE_MAX = 5;

// ── serial keepalive ─────────────────────────────────────────────────────────

/** HDLC keepalive period default (`keepalive 0` disables); line protocol drops after 3 missed. */
export const HDLC_KEEPALIVE_DEFAULT_NS: SimTime = 10 * SEC;
export const HDLC_KEEPALIVE_MISSES = 3;

/** Passive DNS cache sweep while non-empty (periodic). */
export const DNS_SWEEP_NS: SimTime = 1 * MIN;
