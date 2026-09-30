/**
 * Device tables (spec §4.4 `tables: DeviceTables`, §9.4 table visualizers).
 *
 * Tables are owned by the DEVICE, not by processes, so several daemons can
 * share them (ipv4 reads what arp writes). Every write goes through
 * `set`/`delete` so the table can emit `tableWrite`/`tableExpire` trace events
 * — that is what makes rows flash and fade in the UI.
 *
 * Iteration order is insertion order (JS Map) and is therefore deterministic.
 *
 * P0.5/P1: the table SET is static per model (`DeviceModel.tables`, derived from its processes via
 * PROCESS_TABLES), so snapshot and inspector visibility come from table presence, never from kind.
 * Extra tables are reached with `DeviceTables.get(name)`; the snapshot exports them generically as
 * `TableSnapshot`s described by TABLE_DESCRIPTORS (column keys = row field names below).
 */
import type { DeviceId, PduId, PortId, ProcessName } from './ids.js';
import type { IpAddress, Ipv4Address, Ipv6Address, MacAddress } from './addr.js';
import type { SimTime } from './time.js';
import type { TraceSink } from './trace.js';
import type { SocketId, TcpState } from './transport.js';
import type { WifiAssocState } from './medium.js';
import type { SwitchportMode } from './port.js';
import type { HttpMethod } from './process.js';

/**
 * Tables beyond cam/arp/rib (kebab-case names are the trace `table` field).
 * P2 (@since P2, ARCHITECTURE-P2 §2.6): vlans, dtp, stp, stp-bridge, etherchannel, port-security, nat,
 * dhcpv6-bindings, capwap, capwap-aps, wlan-clients, and [SHOULD S2] hsrp. Each exists on a model only through
 * PROCESS_TABLES of a daemon the model runs, so no P1 model declares one.
 */
export type ExtraTableName =
  | 'nd'
  | 'rib6'
  | 'sockets'
  | 'dhcp-bindings'
  | 'dns-cache'
  | 'dot11-assoc'
  // ── P2 ──
  | 'vlans'
  | 'dtp'
  | 'stp'
  | 'stp-bridge'
  | 'etherchannel'
  | 'port-security'
  | 'nat'
  | 'dhcpv6-bindings'
  | 'capwap'
  | 'capwap-aps'
  | 'wlan-clients'
  // [SHOULD S2]
  | 'hsrp'
  // ── P3 (ARCHITECTURE-P3 §2.6; @since P3, appended). W0 adds the names and their TABLE_DESCRIPTORS (since 'P3'); a
  // model derives a table only through PROCESS_TABLES (or the W4 STAGED_PROCESS_TABLES) of a daemon it runs, added in
  // the change that registers that daemon, so no P1/P2 model declares one. ──
  | 'ospf-interfaces'
  | 'ospf-neighbors'
  | 'ospf-lsdb'
  | 'acl'
  | 'dhcp-snooping'
  | 'arp-inspection'
  | 'cdp-neighbours'
  | 'lldp-neighbours'
  | 'ntp-peers'
  | 'clock'
  | 'restconf-log'
  | 'flows'
  // the approved items' tables (§8.5), in the order of §2.6
  | 'vty-logins' // [S13]
  | 'tunnels' // [S18]
  | 'ppp' // [S19]
  | 'syslog-messages' // [S25]
  | 'script-runs' // [S32]
  | 'eigrp-neighbors' // [C1]
  | 'eigrp-topology' // [C1]
  | 'ipsec-sa'; // [C13]
export type TableName = 'cam' | 'arp' | 'rib' | ExtraTableName | (string & {});

export interface TableRow {
  /** Unique key within the table. */
  readonly key: string;
  /** Absolute expiry; undefined = static / never. */
  expiresAt?: SimTime;
  /** When the row was created or last refreshed. */
  updatedAt: SimTime;
}

export interface Table<R extends TableRow> {
  readonly name: TableName;
  /** Owning device; stamped as `device` on every tableWrite/tableExpire. */
  readonly device: DeviceId;
  readonly size: number;
  get(key: string): R | undefined;
  has(key: string): boolean;
  /** Rows in insertion order. Returned array is a fresh copy. */
  rows(): R[];
  /** Insert or replace. Emits `tableWrite` with `t = row.updatedAt`. Returns the previous row if any. */
  set(row: R): R | undefined;
  /** Remove. Emits `tableExpire` with `t = opts.now()`. */
  delete(key: string, reason?: 'aged' | 'cleared' | 'replaced' | 'link-down'): R | undefined;
  /** Emits one `tableExpire` per row with `t = opts.now()`. */
  clear(reason?: 'cleared' | 'link-down'): void;
  /** Delete every row with `expiresAt <= now`; returns the removed rows. Emits `tableExpire` with `t = now`, reason 'aged'. */
  expire(now: SimTime): R[];
  /** Filter helper. */
  find(pred: (r: R) => boolean): R[];
}

/**
 * Construction contract for core/table.ts (core owner), consumed by
 * device/device.ts (device owner). `createTable: TableFactory` is exported by core.
 */
export interface TableOptions {
  name: TableName;
  device: DeviceId;
  sink: TraceSink;
  /**
   * Sim clock used for `t` on events emitted by `delete`/`clear` (which take no time
   * argument). The device runtime supplies `() => this.now`, where `now` is the `at`
   * of the event it is currently dispatching — never a wall clock (rule 1).
   */
  now: () => SimTime;
}
export type TableFactory = <R extends TableRow>(opts: TableOptions) => Table<R>;

/** MAC address table entry (switches). key = `${vlan}/${mac}` */
export interface CamRow extends TableRow {
  mac: MacAddress;
  vlan: number;
  port: PortId;
  type: 'dynamic' | 'static';
  /**
   * @since P2 (optional by meaning) Port-security row (D12): secure rows have type 'static', no expiresAt, and are
   * written only by eth-switch; 'configured' and 'sticky' rows are derived from the running config and never flushed.
   */
  secure?: 'configured' | 'dynamic' | 'sticky';
}
export const camKey = (vlan: number, mac: MacAddress): string => `${vlan}/${mac}`;

/** ARP cache entry (hosts & routers). key = ip */
export interface ArpRow extends TableRow {
  ip: Ipv4Address;
  mac: MacAddress;
  /** Interface the entry was learned on / is valid for. */
  iface: PortId;
  type: 'dynamic' | 'static';
  /** Set while resolving (no `mac` yet — `mac` is MAC_ZERO): the row is shown as "Incomplete". */
  incomplete?: boolean;
}

/** IPv4 routing table entry. key = `${network}/${prefixLen}` (one INSTALLED route per prefix; ECMP is post-P1). */
export interface RouteRow extends TableRow {
  network: Ipv4Address;
  prefixLen: number;
  /**
   * C = connected, L = local (/32 of an interface address), S = static (incl. `ip default-gateway`),
   * D (@since P1) = DHCP-learned default (AD 254). ipv4 arbitrates candidates per key (lowest AD installed;
   * withdrawing the winner re-installs the next): static `ip default-gateway` beats a DHCP default.
   * 'O' @since P3 (ARCHITECTURE-P3 §2.6, D11): OSPF, AD 110, offered by `ipv4.routes`.
   * 'EIGRP' @since P3 [C1]: AD 90, rendered `D` in `show ip route` and in the provenance cause (the DHCP default keeps
   * 'D' and its `D*` rendering). Both added in W0 (ruling R1) with their `SOURCE_TITLE` stub entries in
   * apps/web/src/inspector/TablesView.tsx; nothing writes them before their W1/W2 items.
   */
  source: 'C' | 'L' | 'S' | 'D' | 'O' | 'EIGRP';
  /**
   * @since P3 (optional by meaning) The OSPF route type of an 'O' row (D11): 'E2' for an external type-2 route (MUST:
   * `default-information originate`); absent on an 'O' row = intra-area, absent on every other source (P1/P2 bytes).
   * ([S4] 'IA', [C6] 'E1' and [C4] 'N1' | 'N2' are not approved.)
   */
  routeType?: 'E2';
  nextHop?: Ipv4Address;
  iface?: PortId;
  /** Administrative distance (C/L = 0, S = 1, D = 254; P3: O = 110, [C1] EIGRP = 90). */
  ad: number;
  metric: number;
  /** True for 0.0.0.0/0. */
  isDefault?: boolean;
  /** @since P1 Process that offered the candidate (ipv4.route). Provenance renders "ip default-gateway" iff owner === 'host'. */
  owner?: import('./ids.js').ProcessName;
  /**
   * @since P2 (optional by meaning) [SHOULD S6] Equal-cost paths, present only when two or more are installed
   * (`RibArbiterOptions.maxPaths` > 1); `nextHop`/`iface` of the row stay the first path.
   */
  paths?: readonly { nextHop?: IpAddress; iface?: PortId; cause?: string }[];
}
export const routeKey = (network: Ipv4Address, prefixLen: number): string => `${network}/${prefixLen}`;

export const AD_CONNECTED = 0;
export const AD_STATIC = 1;
/** @since P1 Default route learned from a DHCP lease. */
export const AD_DHCP = 254;
/** @since P1 IPv6 default learned from a Router Advertisement. */
export const AD_ND = 2;
/** @since P3 OSPF (D8). */
export const AD_OSPF = 110;
/** @since P3 [C1] EIGRP internal routes (D8, D26; external 170 and summary 5 wait for redistribution, P5). */
export const AD_EIGRP = 90;

/** @since P1 IPv6 neighbour cache. key = ndKey(iface, ip) (link-local addresses repeat across interfaces). Written only by `nd`. */
export interface NdRow extends TableRow {
  ip: Ipv6Address;
  /** MAC_ZERO while INCOMPLETE. */
  mac: MacAddress;
  iface: PortId;
  state: 'INCOMPLETE' | 'REACHABLE' | 'STALE' | 'DELAY' | 'PROBE';
  isRouter: boolean;
  type: 'dynamic' | 'static';
}
export const ndKey = (iface: PortId, ip: Ipv6Address): string => `${iface}|${ip}`;

/** @since P1 IPv6 RIB. key = route6Key(network, prefixLen). C/L/S as IPv4; ND = default from RA via router LLA (AD 2). Written only by `ipv6`. */
export interface Route6Row extends TableRow {
  network: Ipv6Address;
  prefixLen: number;
  source: 'C' | 'L' | 'S' | 'ND';
  nextHop?: Ipv6Address;
  iface?: PortId;
  ad: number;
  metric: number;
  isDefault?: boolean;
  /** @since P2 (optional by meaning) [SHOULD S6] Equal-cost paths, present only when two or more are installed. */
  paths?: readonly { nextHop?: IpAddress; iface?: PortId; cause?: string }[];
}
export const route6Key = (network: Ipv6Address, prefixLen: number): string => `${network}/${prefixLen}`;

/** @since P1 One socket (netstat). key = socketKey(proto, id). Written ONLY by the udp/tcp processes. */
export interface SocketRow extends TableRow {
  id: SocketId;
  proto: 'udp' | 'tcp';
  family: 4 | 6;
  /** '0.0.0.0' / '::' for wildcard binds. */
  localAddr: IpAddress;
  localPort: number;
  remoteAddr?: IpAddress;
  remotePort?: number;
  /** TCP state, or 'BOUND' for UDP. TIME_WAIT rows carry expiresAt. */
  state: TcpState | 'BOUND';
  owner: ProcessName;
  /** Restricts receive to one port (DHCP client sockets). */
  iface?: PortId;
}
export const socketKey = (proto: 'udp' | 'tcp', id: SocketId): string => `${proto}|${id}`;

/** @since P1 DHCP server binding. key = dhcpBindingKey(pool, ip). expiresAt = lease end (state offered: offer-hold end). Written only by `dhcp-server`. */
export interface DhcpBindingRow extends TableRow {
  ip: Ipv4Address;
  mac: MacAddress;
  clientId?: string;
  hostname?: string;
  pool: string;
  state: 'offered' | 'bound';
  /** giaddr when the request was relayed. */
  relay?: Ipv4Address;
}
export const dhcpBindingKey = (pool: string, ip: Ipv4Address): string => `${pool}|${ip}`;

/** @since P1 DNS resolver cache and static hosts. key = dnsCacheKey(name, type). expiresAt from TTL; undefined for `ip host`. Written by dns-client (and dns-server when forwarding). */
export interface DnsCacheRow extends TableRow {
  /** Lowercase, no trailing dot. */
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'PTR' | 'NS' | 'NXDOMAIN';
  /** ';'-joined data values in answer order (FIELDS form). */
  data: string;
  ttl: number;
  source: 'static' | 'answer' | 'negative';
  server?: IpAddress;
}
export const dnsCacheKey = (name: string, type: string): string => `${name}|${type}`;

/** @since P0.5 Wi-Fi association rows: AP side (one row per client) written by wlan-ap; station side (its BSS) by wlan-client. key = dot11AssocKey(port, station). */
export interface Dot11AssocRow extends TableRow {
  port: PortId;
  station: MacAddress;
  bssid: MacAddress;
  ssid: string;
  state: WifiAssocState;
  aid?: number;
  rssiDbm?: number;
  rateBps?: number;
}
export const dot11AssocKey = (port: PortId, station: MacAddress): string => `${port}|${station}`;

// ── P2 rows (ARCHITECTURE-P2 §2.6, D6: one writer per table) ──────────────────

/** @since P2 key = vlanKey(vlan). Writer: vlan. VLAN 1 and 1002–1005 are implicit and never rows. */
export interface VlanRow extends TableRow {
  vlan: number;
  name: string;
  status: 'active' | 'suspended';
  source: 'config' | 'vtp';
}
/** @since P2 */
export const vlanKey = (vlan: number): string => String(vlan);

/**
 * @since P2 key = port. Writer: dtp. Rows exist from link-up for trunk (negotiate on) and dynamic-desirable ports, and
 * for a dynamic-auto (or access) port only after DTP was received on it (§4.3).
 */
export interface DtpRow extends TableRow {
  port: PortId;
  admin: SwitchportMode;
  oper: 'access' | 'trunk';
  /** waiting = auto port that has heard nothing. */
  status: 'waiting' | 'negotiated' | 'static';
  neighbor?: MacAddress;
  neighborMode?: SwitchportMode;
}

/** @since P2 Spanning-tree port role. */
export type StpRole = 'root' | 'designated' | 'alternate' | 'backup' | 'disabled';
/** @since P2 Spanning-tree port state (802.1D states plus the 802.1w 'discarding'). */
export type StpState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'discarding' | 'disabled';
/** @since P2 'type' = an access (non-trunking) port received a BPDU carrying the pvid TLV, i.e. it faces a trunk (§3.6). */
export type StpInconsistency = 'root' | 'loop' | 'pvid' | 'type';
/** @since P2 Bridge id text: `${priority}/${mac}` e.g. '32778/00:1f:00:0a:00:00' (priority includes the VLAN, D9). */
export type BridgeIdText = string;

/** @since P2 key = stpKey(vlan, port). Writer: stp. One row per (instance, STP port); bundled members have none. */
export interface StpPortRow extends TableRow {
  vlan: number;
  port: PortId;
  role: StpRole;
  state: StpState;
  /** Protocol spoken on this port: 'rstp' or 'stp' (a rapid port that migrated to 802.1D, §3.6 Mixed modes). */
  protocol: 'stp' | 'rstp';
  cost: number;
  /** '128.1' */
  portId: string;
  designatedBridge: BridgeIdText;
  designatedPort: string;
  edge: boolean;
  inconsistent?: StpInconsistency;
  bpduGuard?: boolean;
  stateSince: SimTime;
  /** Next timer-driven state change (forward delay), for the draining bar; absent when none is pending. */
  nextTransitionAt?: SimTime;
}
/** @since P2 */
export const stpKey = (vlan: number, port: PortId): string => `${vlan}|${port}`;

/** @since P2 key = vlanKey(vlan). Writer: stp. One row per instance. */
export interface StpBridgeRow extends TableRow {
  vlan: number;
  mode: 'pvst' | 'rapid-pvst' | 'mst';
  bridgeId: BridgeIdText;
  rootId: BridgeIdText;
  isRoot: boolean;
  rootPort?: PortId;
  rootCost: number;
  helloS: number;
  maxAgeS: number;
  forwardDelayS: number;
  topologyChanges: number;
  lastChangeAt?: SimTime;
  lastChangePort?: PortId;
}

/** @since P2 'individual' = runs as a separate spanning-tree port (no LACP partner, §3.7); 'suspended' = incompatible, no traffic. */
export type ChannelMemberState = 'bundled' | 'waiting' | 'suspended' | 'individual' | 'down';

/** @since P2 key = member port. Writer: etherchannel. */
export interface EtherchannelRow extends TableRow {
  port: PortId;
  group: number;
  /** 'Port-channel1' */
  bundle: PortId;
  protocol: 'lacp' | 'pagp' | 'static';
  mode: 'on' | 'active' | 'passive' | 'desirable' | 'auto';
  state: ChannelMemberState;
  /** Original wording when suspended or individual. */
  reason?: string;
  partnerSystem?: MacAddress;
  partnerKey?: number;
  partnerPort?: number;
}

/** @since P2 key = port. Writer: eth-switch. Rows exist only for ports with `switchport port-security`. */
export interface PortSecurityRow extends TableRow {
  port: PortId;
  max: number;
  count: number;
  violation: 'protect' | 'restrict' | 'shutdown';
  sticky: boolean;
  violations: number;
  status: 'secure-up' | 'secure-down' | 'secure-shutdown';
  lastViolationMac?: MacAddress;
}

/** @since P2 key = natKey(proto, insideGlobal, insideGlobalPort). Writer: nat. Address-only rows use proto 'any'. */
export interface NatRow extends TableRow {
  proto: 'icmp' | 'udp' | 'tcp' | 'any';
  insideLocal: Ipv4Address;
  insideLocalPort?: number;
  insideGlobal: Ipv4Address;
  insideGlobalPort?: number;
  outsideLocal?: Ipv4Address;
  outsideLocalPort?: number;
  outsideGlobal?: Ipv4Address;
  outsideGlobalPort?: number;
  kind: 'static' | 'dynamic' | 'overload';
  /** The config line that created it (provenance cause). */
  rule: string;
}
/**
 * @since P2 The key finds the candidate row; the INBOUND MATCH RULE of §3.9 decides whether an inbound packet may use
 * it (an overload row also requires src = outsideGlobal, and an ICMP query row matches replies only).
 */
export const natKey = (proto: NatRow['proto'], insideGlobal: Ipv4Address, port?: number): string => `${proto}|${insideGlobal}|${port ?? '*'}`;

/** @since P2 key = `${pool}|${address}`. Writer: dhcpv6-server. expiresAt = valid lifetime end. */
export interface Dhcpv6BindingRow extends TableRow {
  address: Ipv6Address;
  duid: string;
  iaid: number;
  pool: string;
  preferredUntil?: SimTime;
}

/** @since P2 (wireless) RFC 5415 WTP states; 'dtls' is simulated (a state with no records on the wire, D8). */
export type CapwapState = 'discovery' | 'dtls' | 'join' | 'configure' | 'data-check' | 'run' | 'idle';
/** @since P2 (wireless) AP side, key = controller address. Writer: capwap-wtp. */
export interface CapwapRow extends TableRow {
  controller: Ipv4Address;
  state: CapwapState;
  since: SimTime;
  wlans: number;
}
/** @since P2 (wireless) WLC side, key = AP MAC. Writer: capwap-ac. */
export interface CapwapApRow extends TableRow {
  apMac: MacAddress;
  apIp: Ipv4Address;
  name: string;
  state: CapwapState;
  clients: number;
}
/**
 * @since P2 (wireless) WLC side, key = station MAC. Writer: capwap-ac, ONLY from WTP Event Request station reports
 * (§3.12 step 5): 'add' writes or updates the row, 'del' deletes it (reason `cleared`); an AP leaving run deletes its
 * stations' rows. `state` is the AP's association state reported with the station ('associated' or 'authorized').
 */
export interface WlanClientRow extends TableRow {
  station: MacAddress;
  ap: MacAddress;
  bssid: MacAddress;
  wlanId: number;
  ssid: string;
  vlan: number;
  /** Controller interface NAME (`wlc-interface <name>`), not a port id. */
  iface: string;
  state: WifiAssocState;
}

/** @since P2 [SHOULD S2] key = `${iface}|${group}`. Writer: hsrp. */
export interface HsrpRow extends TableRow {
  iface: PortId;
  group: number;
  version: 1 | 2;
  state: 'initial' | 'learn' | 'listen' | 'speak' | 'standby' | 'active';
  priority: number;
  preempt: boolean;
  virtualIp?: Ipv4Address;
  virtualMac: MacAddress;
  active?: Ipv4Address | 'local';
  standby?: Ipv4Address | 'local';
}

// ── P3 rows (ARCHITECTURE-P3 §2.6, §2.16, §2.17; every row @since P3). Gradeable state lives in tables (rule 20):
//    a row is rewritten only when a displayed column changes. ──

/** @since P3 OSPF area id, dotted ('0.0.0.0'). */
export type OspfAreaId = string;
/** @since P3 ([C3] 'non-broadcast' | 'point-to-multipoint' are not approved.) */
export type OspfNetworkType = 'broadcast' | 'point-to-point' | 'loopback';
/** @since P3 RFC 2328 interface states. */
export type OspfIsmState = 'down' | 'loopback' | 'waiting' | 'point-to-point' | 'drother' | 'backup' | 'dr';
/** @since P3 RFC 2328 neighbour states. */
export type OspfNsmState = 'down' | 'attempt' | 'init' | '2way' | 'exstart' | 'exchange' | 'loading' | 'full';

/** @since P3 key = port. Writer: ospf. Exists while the interface is enabled for OSPF. Rewritten only when a column changes (rule 20). */
export interface OspfInterfaceRow extends TableRow {
  port: PortId;
  process: number;
  /** The router id in use (fact ospf.routerId), not a configured one waiting for `clear ip ospf process`. */
  routerId: Ipv4Address;
  area: OspfAreaId;
  networkType: OspfNetworkType;
  state: OspfIsmState;
  address?: Ipv4Address;
  prefixLen?: number;
  cost: number;
  costSource: 'bandwidth' | 'configured';
  priority: number;
  helloS: number;
  deadS: number;
  passive: boolean;
  dr?: Ipv4Address;
  drAddress?: Ipv4Address;
  bdr?: Ipv4Address;
  bdrAddress?: Ipv4Address;
  neighbors: number;
  adjacent: number;
  stateSince: SimTime;
  /** The draining bar while Waiting. */
  waitUntil?: SimTime;
  /** The last refused hello. */
  rejected?: { from: Ipv4Address; routerId: Ipv4Address; reason: string; at: SimTime };
}

/** @since P3 key = ospfNbrKey(port, routerId). Writer: ospf. Written only on state, role, DR/BDR or priority change. */
export interface OspfNeighborRow extends TableRow {
  port: PortId;
  routerId: Ipv4Address;
  address: Ipv4Address;
  priority: number;
  state: OspfNsmState;
  role: 'dr' | 'bdr' | 'drother' | 'none';
  dr: Ipv4Address;
  bdr: Ipv4Address;
  stateSince: SimTime;
  master?: boolean;
}
export const ospfNbrKey = (port: PortId, routerId: Ipv4Address): string => `${port}|${routerId}`;

/** @since P3 MUST: 1 router, 2 network, 5 external. ([S4] 3, 4 and [C4] 7 are not approved.) */
export type OspfLsaType = 1 | 2 | 5;
/** @since P3 One link of a router LSA (virtual links: P5). */
export interface OspfRouterLink {
  kind: 'p2p' | 'transit' | 'stub';
  id: Ipv4Address;
  data: Ipv4Address;
  metric: number;
}

/**
 * @since P3 key = ospfLsaKey(scope, type, lsid, adv); scope = area or 'as'. Writer: ospf. No expiresAt (Table.expire
 * would delete it): the live age is ageAtInstall + (now − installedAt) / 1 s, capped at 3600.
 */
export interface OspfLsaRow extends TableRow {
  scope: OspfAreaId | 'as';
  type: OspfLsaType;
  lsid: Ipv4Address;
  advRouter: Ipv4Address;
  seq: number;
  ageAtInstall: number;
  installedAt: SimTime;
  checksum: number;
  length: number;
  options: number;
  self: boolean;
  /** Type 1. */
  flags?: { b: boolean; e: boolean; v: boolean };
  links?: readonly OspfRouterLink[];
  /** Type 2 (mask also type 5). */
  mask?: Ipv4Address;
  attached?: readonly Ipv4Address[];
  /** Type 5. */
  metric?: number;
  external?: { e2: boolean; forward: Ipv4Address; tag: number };
  /** Being flushed. */
  maxAge?: true;
}
export const ospfLsaKey = (scope: string, type: number, lsid: string, adv: string): string => `${scope}|${type}|${lsid}|${adv}`;

/** @since P3 key = aclKey(family, list, seq). Writer: acl. Rows exist ONLY for lists applied as filters (D12). */
export interface AclRow extends TableRow {
  /** ([S11] would add 6.) */
  family: 4;
  list: string;
  /** ([S11] would add 'ipv6'.) */
  type: 'standard' | 'extended';
  seq: number | null;
  /** ([S11] would add 'nd-na' | 'nd-ns'.) */
  implicit?: 'deny';
  /** Canonical aclEntryText, no sequence number. */
  entry: string;
  action: 'permit' | 'deny';
  matches: number;
  lastPdu?: PduId;
  lastAt?: SimTime;
  /** 'vty' [S13]: the last match was a vty `access-class` check. */
  lastIface?: PortId | 'vty';
  lastDir?: 'in' | 'out';
  /** 'GigabitEthernet0/0 in' ([S13] adds ', vty in'). */
  applied: string;
}
/** @since P3 ([S11] would widen the family.) */
export const aclKey = (f: 4, list: string, seq: number | 'implicit'): string => `${f}|${list}|${seq}`;

/** @since P3 key = `${vlan}|${mac}`. Writer: eth-switch. expiresAt = lease end (none for static bindings). */
export interface DhcpSnoopingRow extends TableRow {
  mac: MacAddress;
  ip: Ipv4Address;
  vlan: number;
  port: PortId;
  kind: 'learned' | 'static';
  leaseS?: number;
}
/** @since P3 key = vlanKey(vlan). Writer: eth-switch. One write per inspected ARP on an untrusted port. */
export interface ArpInspectionRow extends TableRow {
  vlan: number;
  forwarded: number;
  dropped: number;
  droppedNoBinding: number;
  droppedAcl: number;
}

/** @since P3 key = `${localPort}|${deviceId}`. Writer: cdp. expiresAt = last update + holdtime. */
export interface CdpNeighbourRow extends TableRow {
  localPort: PortId;
  deviceId: string;
  remotePort: string;
  platform: string;
  /** 'R S I'. */
  capabilities: string;
  addresses: string;
  version: string;
  holdtimeS: number;
  cdpVersion: number;
  nativeVlan?: number;
  duplex?: 'full' | 'half';
}
/** @since P3 key = `${localPort}|${chassisId}|${portId}`. Writer: lldp. expiresAt = last update + TTL. */
export interface LldpNeighbourRow extends TableRow {
  localPort: PortId;
  chassisId: string;
  portId: string;
  ttlS: number;
  systemName?: string;
  portDescription?: string;
  systemDescription?: string;
  capabilities?: string;
  enabled?: string;
  mgmtAddress?: Ipv4Address;
}

/** @since P3 key = configured address. Writer: ntp. Rewritten on a poll result that changes a column. */
export interface NtpPeerRow extends TableRow {
  address: IpAddress;
  configured: boolean;
  refId: string;
  stratum: number;
  lastRxAt?: SimTime;
  pollS: number;
  /** u8 shift register. */
  reach: number;
  /** One round trip: always far below 2^53 ns. */
  delayNs?: number;
  /**
   * θ = offsetMs ms + offsetSubMsNs ns (floor toward −∞, 0 ≤ offsetSubMsNs < 1 000 000): a first sync of an unset clock
   * (2020-01-01) against true time (2025-01-06) is ≈ 1.6 × 10¹⁷ ns, beyond 2^53 ns (≈ 104 days).
   */
  offsetMs?: number;
  offsetSubMsNs?: number;
  selected: 'sys-peer' | 'candidate' | 'reject' | 'unreached';
}
/**
 * @since P3 key = 'clock', one row per device. Writer: ntp. Written only when source, stratum, reference or offset
 * changes (a synchronisation, `ntp master`, `clock set`); absent while the clock was never set (source 'unset'). The
 * gradeable device clock (rule 20); the runtime keeps the clock itself.
 */
export interface ClockRow extends TableRow {
  source: 'user' | 'ntp' | 'master';
  stratum?: number;
  reference?: string;
  /** Displayed clock − true time, split as in NtpPeerRow. */
  offsetMs: number;
  offsetSubMsNs: number;
  since: SimTime;
}

/** @since P3 key = String(seq). Writer: restconf. Bounded to 50 rows; the oldest is deleted with reason 'replaced'. */
export interface RestconfLogRow extends TableRow {
  seq: number;
  method: HttpMethod;
  path: string;
  status: number;
  client: IpAddress;
  user?: string;
  at: SimTime;
}

/**
 * @since P3 key = `${src}|${flow}`, on the RECEIVING host. Writer: traffic. Rewritten at most once per received second,
 * plus one final write by `flow-flush:<key>` 1 s after the last datagram the receiver saw.
 */
export interface FlowRow extends TableRow {
  flow: string;
  src: IpAddress;
  dst: IpAddress;
  dstPort: number;
  /** DSCP of the last datagram received (so marking on the path is visible). */
  dscp: number;
  received: number;
  /**
   * (highest sequence seen + 1) − received; datagrams lost after the highest one received are counted only when the
   * flow's final datagram (flags bit 0) arrives.
   */
  lost: number;
  delayMinNs: number;
  delayMaxNs: number;
  delayAvgNs: number;
  /** RFC 3550 integer jitter. */
  jitterNs: number;
  firstAt: SimTime;
  lastAt: SimTime;
  /** The final datagram arrived. */
  ended: boolean;
}

/**
 * @since P3 [S13] key = String(seq). Writer: vty. Bounded to 50 rows (the restconf-log rule). One row per login attempt
 * that reached vty; a transport refusal is a TCP RST and writes none.
 */
export interface VtyLoginRow extends TableRow {
  seq: number;
  proto: 'telnet' | 'ssh';
  peer: IpAddress;
  user?: string;
  /** failed: wrong credentials; refused: access-class. */
  result: 'success' | 'failed' | 'refused';
  /** 'access-class 10', 'bad password', … */
  reason?: string;
  at: SimTime;
}

/** @since P3 [S18] Why a tunnel is down ([C13] adds the four IKE reasons). */
export type TunnelDownReason =
  | 'no-source'
  | 'no-destination'
  | 'no-route'
  | 'recursive-routing'
  | 'ike-negotiating'
  | 'ike-failed'
  | 'ike-no-proposal'
  | 'ike-no-response';
/**
 * @since P3 [S18] key = tunnel port. Writer: gre (the tunnel owner, D17; [C13] in both modes). The runtime derives the
 * tunnel's line protocol from `state` (`virtualChanged`). `ipMtu` is 1476 in GRE mode, [C13] 1456 in ipsec mode.
 */
export interface TunnelRow extends TableRow {
  port: PortId;
  mode: 'gre' | 'ipsec';
  source?: Ipv4Address;
  sourceIface?: PortId;
  destination?: Ipv4Address;
  state: 'up' | 'down';
  reason?: TunnelDownReason;
  transportMtu: number;
  ipMtu: number;
  since: SimTime;
}

/** @since P3 [S19] RFC 1661 automaton states (LCP and the NCPs). */
export type PppFsmState = 'initial' | 'starting' | 'closed' | 'stopped' | 'closing' | 'stopping' | 'req-sent' | 'ack-rcvd' | 'ack-sent' | 'opened';
/** @since P3 [S19] RFC 1661 link phases (the D·E·A·N rail). */
export type PppPhase = 'dead' | 'establish' | 'authenticate' | 'network' | 'terminate';
/**
 * @since P3 [S19] key = serial port. Writer: ppp. `authLocal` is what this end requires of its peer (`ppp
 * authentication`), `authPeer` what the peer requires of this end; each state is absent until authentication starts.
 */
export interface PppRow extends TableRow {
  port: PortId;
  phase: PppPhase;
  lcp: PppFsmState;
  authLocal: 'none' | 'pap' | 'chap';
  authLocalState?: 'pending' | 'success' | 'failed';
  authPeer: 'none' | 'pap' | 'chap';
  authPeerState?: 'pending' | 'success' | 'failed';
  peerName?: string;
  ipcp: PppFsmState;
  peerAddress?: Ipv4Address;
  ipv6cp?: PppFsmState;
  magic: number;
  peerMagic?: number;
  failures: number;
  lastFailure?: string;
  since: SimTime;
}

/** @since P3 [S25] key = String(seq). Writer: syslog-server. Bounded to 500 rows. */
export interface SyslogMessageRow extends TableRow {
  seq: number;
  from: IpAddress;
  /** RFC 3164 facility number (0–23). */
  facility: number;
  /** 0 emergencies … 7 debugging. */
  severity: number;
  hostname?: string;
  /** The message's own timestamp text. */
  stamp: string;
  message: string;
  /** The server's clock when it received the message. */
  receivedStamp: string;
}

/**
 * @since P3 [S32] key = run id ('r1', 'r2', …). Writer: script-host. Bounded to 20 rows. Written when a run starts and
 * when it ends — never per output line or per request (rule 20).
 */
export interface ScriptRunRow extends TableRow {
  run: string;
  file: string;
  state: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: SimTime;
  endedAt?: SimTime;
  /** HTTP requests the run made (final count at the end). */
  requests: number;
  /** The traceback's last line on 'failed'. */
  error?: string;
}

/** @since P3 [C1] */
export type EigrpNbrState = 'pending' | 'up';
/**
 * @since P3 [C1] key = `${iface}|${address}`. Writer: eigrp. Written when the state changes and once when SRTT and RTO
 * are first measured; the hold countdown and the queue live in the StateView (rule 20).
 */
export interface EigrpNeighborRow extends TableRow {
  iface: PortId;
  address: Ipv4Address;
  as: number;
  state: EigrpNbrState;
  /** The hold time the neighbour advertises. */
  holdS: number;
  upSince?: SimTime;
  srttMs: number;
  rtoMs: number;
}
/** @since P3 [C1] One path of a topology entry. */
export interface EigrpPath {
  nextHop: Ipv4Address;
  iface: PortId;
  /** The distance through this neighbour (what the FD would be). */
  metric: number;
  /** The neighbour's reported distance. */
  rd: number;
}
/** @since P3 [C1] key = prefix ('10.4.0.0/24'). Writer: eigrp. Written when the state, the FD or a path list changes. */
export interface EigrpTopologyRow extends TableRow {
  prefix: string;
  state: 'passive' | 'active';
  fd: number;
  /** Equal-cost minimum, up to maximum-paths, in path order. */
  successors: readonly EigrpPath[];
  /** RD < FD, not successors (`show ip eigrp topology`). */
  feasible: readonly EigrpPath[];
  /** RD ≥ FD (`show ip eigrp topology all-links`). */
  others: readonly EigrpPath[];
  /** A directly connected network of this router. */
  connected?: PortId;
  /** While active. */
  pendingReplies?: number;
}

/** @since P3 [C13] key = tunnel port. Writer: ike. Written on a state change only (rule 20). */
export interface IpsecSaRow extends TableRow {
  port: PortId;
  local: Ipv4Address;
  peer: Ipv4Address;
  profile: string;
  role: 'initiator' | 'responder';
  state: 'negotiating' | 'established' | 'failed';
  reason?: 'ike-failed' | 'ike-no-proposal' | 'ike-no-response';
  /** 16 hex digits each. */
  ikeSpiI?: string;
  ikeSpiR?: string;
  espSpiIn?: number;
  espSpiOut?: number;
  /** 'aes-cbc-256 sha256 group14' once chosen. */
  proposal?: string;
  since: SimTime;
}

// ── P3 StateViews the shows read (display only, rule 20; the W3 cli tests are written against these shapes) ──

/**
 * @since P3 One vertex of an OSPF shortest-path tree (D10; `core/ospf-spf.ts` builds it, the ospf StateView carries the
 * final tree per area and the [S3] stepper's last frame equals it). `key` is `R:<router id>` or `N:<DR interface
 * address>`; `parent` is the parent's key (absent at the root).
 */
export interface SpfVertex {
  readonly key: string;
  readonly kind: 'router' | 'network';
  readonly id: Ipv4Address;
  readonly cost: number;
  readonly parent?: string;
  readonly nextHops: readonly { readonly iface: PortId; readonly nextHop?: Ipv4Address }[];
}
/** @since P3 The final SPF tree of one area, vertices in settle order (D10). */
export interface SpfTree {
  readonly root: Ipv4Address;
  readonly vertices: readonly SpfVertex[];
}
/** @since P3 StateView kind 'ospf' (display only). */
export interface OspfStateView {
  process?: {
    pid: number;
    routerId: Ipv4Address;
    /** Applied at clear or reload. */
    configuredRouterId?: Ipv4Address;
    startedAt: SimTime;
    referenceBandwidthMbps: number;
    maximumPaths: number;
    defaultOriginate?: 'on' | 'always';
  };
  spf: { runs: number; lastAt?: SimTime; nextAt?: SimTime; holdUntil?: SimTime; lastReason?: string };
  /** "Hello due in". */
  interfaces: readonly { port: PortId; helloDueAt?: SimTime; waitUntil?: SimTime }[];
  /** "Dead in". */
  neighbors: readonly { port: PortId; routerId: Ipv4Address; deadAt: SimTime; retransmitQueue: number }[];
  /** D10: the final SPF tree per area ([S3] parity). */
  trees: readonly { area: OspfAreaId; tree: SpfTree }[];
}
/** @since P3 StateView kind 'ntp' (display only). */
export interface NtpStateView {
  peers: readonly { address: IpAddress; nextPollAt?: SimTime; retriesLeft: number; lastSentAt?: SimTime; lastReject?: string }[];
  master?: { stratum: number };
  /** Requests answered. */
  served: number;
}
/**
 * @since P3 (optional by meaning) The `probes` member of the tcp and udp StateViews: present only after a probe, which
 * runs only in grader clones; at most 16, newest last.
 */
export interface TransportProbeView {
  session: string;
  dst: IpAddress;
  port: number;
  outcome: 'pending' | 'open' | 'refused' | 'unreachable' | 'timeout' | 'sent';
  icmp?: { type: number; code: number };
  at: SimTime;
}
/** @since P3 [C1] StateView kind 'eigrp' (display only). */
export interface EigrpStateView {
  process?: { as: number; routerId: Ipv4Address; kValues: readonly number[]; maximumPaths: number };
  neighbors: readonly { iface: PortId; address: Ipv4Address; holdUntil: SimTime; queue: number; lastSeq: number }[];
  active: readonly { prefix: string; since: SimTime; waitingFor: readonly Ipv4Address[] }[];
}
/** @since P3 [C13] The gre StateView's entry per ipsec-mode tunnel (display only). */
export interface IpsecTunnelCounters {
  encaps: number;
  decaps: number;
  seqOut: number;
  lastSeqIn: number;
  noSa: number;
}
/** @since P3 [C13] StateView kind 'ike' (display only). */
export interface IkeStateView {
  exchanges: readonly { port: PortId; messageId: number; retriesLeft: number; nextAt?: SimTime }[];
}

export interface DeviceTables {
  readonly cam: Table<CamRow>;
  readonly arp: Table<ArpRow>;
  readonly rib: Table<RouteRow>;
  /** @since P0.5 Any table the model declares (typed rows above); undefined when the model has none of that name. */
  get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined;
  /** @since P0.5 Declared table names in `model.tables` order (cam, arp, rib first). Power-off clears each, in this order. */
  names(): readonly TableName[];
}

/** Longest-prefix-match result, including the candidates considered (for the LPM explainer §9.4). */
export interface LpmResult {
  winner?: RouteRow;
  /** All matching routes, ordered by (prefixLen desc, ad asc, metric asc). */
  candidates: RouteRow[];
}

/** @since P1 IPv6 LPM result (4×u32 compare; ties: prefixLen desc, ad, metric, insertion). */
export interface Lpm6Result {
  winner?: Route6Row;
  candidates: Route6Row[];
}

/** Column of a generic table rendering. `key` must be a field of the row interface. */
export interface TableColumn {
  readonly key: string;
  /** Original column title. */
  readonly title: string;
  readonly format: 'text' | 'mac' | 'ipv4' | 'ipv6' | 'ip' | 'port' | 'time' | 'duration' | 'number' | 'state' | 'bool';
}

export interface TableDescriptor {
  readonly name: TableName;
  /** Original title shown by the generic inspector renderer. */
  readonly title: string;
  readonly columns: readonly TableColumn[];
  /** 'P2' @since P2. 'P3' @since P3. */
  readonly since: 'P0' | 'P0.5' | 'P1' | 'P2' | 'P3';
}

/** Descriptors for every built-in table; the snapshot and TablesView use these. */
export const TABLE_DESCRIPTORS: Readonly<Record<'cam' | 'arp' | 'rib' | ExtraTableName, TableDescriptor>> = Object.freeze({
  cam: {
    name: 'cam', title: 'MAC address table', since: 'P0',
    columns: [
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'mac', title: 'MAC', format: 'mac' },
      { key: 'port', title: 'Port', format: 'port' }, { key: 'type', title: 'Type', format: 'text' },
      { key: 'expiresAt', title: 'Ages out', format: 'time' },
    ],
  },
  arp: {
    name: 'arp', title: 'ARP cache', since: 'P0',
    columns: [
      { key: 'ip', title: 'Address', format: 'ipv4' }, { key: 'mac', title: 'MAC', format: 'mac' },
      { key: 'iface', title: 'Interface', format: 'port' }, { key: 'type', title: 'Type', format: 'text' },
      { key: 'expiresAt', title: 'Expires', format: 'time' },
    ],
  },
  rib: {
    name: 'rib', title: 'IPv4 routes', since: 'P0',
    columns: [
      { key: 'source', title: 'Source', format: 'text' }, { key: 'network', title: 'Network', format: 'ipv4' },
      { key: 'prefixLen', title: 'Prefix', format: 'number' }, { key: 'nextHop', title: 'Next hop', format: 'ipv4' },
      { key: 'iface', title: 'Interface', format: 'port' }, { key: 'ad', title: 'Distance', format: 'number' },
      { key: 'metric', title: 'Metric', format: 'number' },
    ],
  },
  nd: {
    name: 'nd', title: 'IPv6 neighbours', since: 'P1',
    columns: [
      { key: 'ip', title: 'Address', format: 'ipv6' }, { key: 'mac', title: 'MAC', format: 'mac' },
      { key: 'iface', title: 'Interface', format: 'port' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'isRouter', title: 'Router', format: 'bool' },
    ],
  },
  rib6: {
    name: 'rib6', title: 'IPv6 routes', since: 'P1',
    columns: [
      { key: 'source', title: 'Source', format: 'text' }, { key: 'network', title: 'Prefix', format: 'ipv6' },
      { key: 'prefixLen', title: 'Length', format: 'number' }, { key: 'nextHop', title: 'Next hop', format: 'ipv6' },
      { key: 'iface', title: 'Interface', format: 'port' }, { key: 'ad', title: 'Distance', format: 'number' },
    ],
  },
  sockets: {
    name: 'sockets', title: 'Sockets', since: 'P1',
    columns: [
      { key: 'proto', title: 'Proto', format: 'text' }, { key: 'localAddr', title: 'Local address', format: 'ip' },
      { key: 'localPort', title: 'Local port', format: 'number' }, { key: 'remoteAddr', title: 'Remote address', format: 'ip' },
      { key: 'remotePort', title: 'Remote port', format: 'number' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'owner', title: 'Owner', format: 'text' },
    ],
  },
  'dhcp-bindings': {
    name: 'dhcp-bindings', title: 'DHCP leases', since: 'P1',
    columns: [
      { key: 'ip', title: 'Address', format: 'ipv4' }, { key: 'mac', title: 'Client', format: 'mac' },
      { key: 'pool', title: 'Pool', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'expiresAt', title: 'Lease ends', format: 'time' },
    ],
  },
  'dns-cache': {
    name: 'dns-cache', title: 'DNS cache', since: 'P1',
    columns: [
      { key: 'name', title: 'Name', format: 'text' }, { key: 'type', title: 'Type', format: 'text' },
      { key: 'data', title: 'Data', format: 'text' }, { key: 'source', title: 'Source', format: 'text' },
      { key: 'expiresAt', title: 'Expires', format: 'time' },
    ],
  },
  'dot11-assoc': {
    name: 'dot11-assoc', title: 'Wireless associations', since: 'P0.5',
    columns: [
      { key: 'port', title: 'Radio', format: 'port' }, { key: 'station', title: 'Station', format: 'mac' },
      { key: 'bssid', title: 'BSSID', format: 'mac' }, { key: 'ssid', title: 'SSID', format: 'text' },
      { key: 'state', title: 'State', format: 'state' }, { key: 'rssiDbm', title: 'Signal (dBm)', format: 'number' },
    ],
  },
  // ── P2 ──
  vlans: {
    name: 'vlans', title: 'VLANs', since: 'P2',
    columns: [
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'name', title: 'Name', format: 'text' },
      { key: 'status', title: 'Status', format: 'state' }, { key: 'source', title: 'Source', format: 'text' },
    ],
  },
  dtp: {
    name: 'dtp', title: 'Trunk negotiation', since: 'P2',
    columns: [
      { key: 'port', title: 'Port', format: 'port' }, { key: 'admin', title: 'Mode', format: 'text' },
      { key: 'oper', title: 'Operating as', format: 'state' }, { key: 'status', title: 'Negotiation', format: 'state' },
      { key: 'neighborMode', title: 'Neighbour mode', format: 'text' }, { key: 'neighbor', title: 'Neighbour', format: 'mac' },
    ],
  },
  stp: {
    name: 'stp', title: 'Spanning tree ports', since: 'P2',
    columns: [
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'port', title: 'Port', format: 'port' },
      { key: 'role', title: 'Role', format: 'state' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'protocol', title: 'Protocol', format: 'text' }, { key: 'cost', title: 'Cost', format: 'number' },
      { key: 'portId', title: 'Port id', format: 'text' }, { key: 'designatedBridge', title: 'Designated bridge', format: 'text' },
      { key: 'edge', title: 'Edge', format: 'bool' }, { key: 'inconsistent', title: 'Inconsistent', format: 'state' },
      { key: 'nextTransitionAt', title: 'Next change', format: 'time' },
    ],
  },
  'stp-bridge': {
    name: 'stp-bridge', title: 'Spanning tree', since: 'P2',
    columns: [
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'mode', title: 'Mode', format: 'text' },
      { key: 'bridgeId', title: 'Bridge id', format: 'text' }, { key: 'rootId', title: 'Root id', format: 'text' },
      { key: 'isRoot', title: 'Root bridge', format: 'bool' }, { key: 'rootPort', title: 'Root port', format: 'port' },
      { key: 'rootCost', title: 'Root cost', format: 'number' }, { key: 'topologyChanges', title: 'Topology changes', format: 'number' },
      { key: 'lastChangePort', title: 'Last change on', format: 'port' },
    ],
  },
  etherchannel: {
    name: 'etherchannel', title: 'EtherChannel members', since: 'P2',
    columns: [
      { key: 'port', title: 'Member', format: 'port' }, { key: 'group', title: 'Group', format: 'number' },
      { key: 'bundle', title: 'Bundle', format: 'port' }, { key: 'protocol', title: 'Protocol', format: 'text' },
      { key: 'mode', title: 'Mode', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'reason', title: 'Reason', format: 'text' },
    ],
  },
  'port-security': {
    name: 'port-security', title: 'Port security', since: 'P2',
    columns: [
      { key: 'port', title: 'Port', format: 'port' }, { key: 'status', title: 'Status', format: 'state' },
      { key: 'count', title: 'Addresses', format: 'number' }, { key: 'max', title: 'Maximum', format: 'number' },
      { key: 'violation', title: 'On violation', format: 'text' }, { key: 'sticky', title: 'Sticky', format: 'bool' },
      { key: 'violations', title: 'Violations', format: 'number' }, { key: 'lastViolationMac', title: 'Last violator', format: 'mac' },
    ],
  },
  nat: {
    name: 'nat', title: 'NAT translations', since: 'P2',
    columns: [
      { key: 'proto', title: 'Proto', format: 'text' }, { key: 'insideGlobal', title: 'Inside global', format: 'ipv4' },
      { key: 'insideGlobalPort', title: 'Port', format: 'number' }, { key: 'insideLocal', title: 'Inside local', format: 'ipv4' },
      { key: 'insideLocalPort', title: 'Port', format: 'number' }, { key: 'outsideLocal', title: 'Outside local', format: 'ipv4' },
      { key: 'outsideGlobal', title: 'Outside global', format: 'ipv4' }, { key: 'kind', title: 'Kind', format: 'text' },
      { key: 'expiresAt', title: 'Expires', format: 'time' },
    ],
  },
  'dhcpv6-bindings': {
    name: 'dhcpv6-bindings', title: 'DHCPv6 leases', since: 'P2',
    columns: [
      { key: 'address', title: 'Address', format: 'ipv6' }, { key: 'duid', title: 'Client id', format: 'text' },
      { key: 'iaid', title: 'IAID', format: 'number' }, { key: 'pool', title: 'Pool', format: 'text' },
      { key: 'expiresAt', title: 'Lease ends', format: 'time' },
    ],
  },
  capwap: {
    name: 'capwap', title: 'Controller link', since: 'P2',
    columns: [
      { key: 'controller', title: 'Controller', format: 'ipv4' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'wlans', title: 'WLANs', format: 'number' },
    ],
  },
  'capwap-aps': {
    name: 'capwap-aps', title: 'Access points', since: 'P2',
    columns: [
      { key: 'name', title: 'Name', format: 'text' }, { key: 'apMac', title: 'MAC', format: 'mac' },
      { key: 'apIp', title: 'Address', format: 'ipv4' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'clients', title: 'Clients', format: 'number' },
    ],
  },
  'wlan-clients': {
    name: 'wlan-clients', title: 'Wireless clients', since: 'P2',
    columns: [
      { key: 'station', title: 'Station', format: 'mac' }, { key: 'ap', title: 'Access point', format: 'mac' },
      { key: 'ssid', title: 'SSID', format: 'text' }, { key: 'vlan', title: 'VLAN', format: 'number' },
      { key: 'iface', title: 'Interface', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
    ],
  },
  // [SHOULD S2]
  hsrp: {
    name: 'hsrp', title: 'Standby groups', since: 'P2',
    columns: [
      { key: 'iface', title: 'Interface', format: 'port' }, { key: 'group', title: 'Group', format: 'number' },
      { key: 'state', title: 'State', format: 'state' }, { key: 'priority', title: 'Priority', format: 'number' },
      { key: 'preempt', title: 'Preempt', format: 'bool' }, { key: 'virtualIp', title: 'Virtual address', format: 'ipv4' },
      { key: 'virtualMac', title: 'Virtual MAC', format: 'mac' }, { key: 'active', title: 'Active', format: 'text' },
      { key: 'standby', title: 'Standby', format: 'text' },
    ],
  },
  // ── P3 (ARCHITECTURE-P3 §2.6, §9.2 W0 item 1: compile stubs with their final values). A descriptor makes no model
  // derive its table (PROCESS_TABLES does, in the change that registers the daemon). ──
  'ospf-interfaces': {
    name: 'ospf-interfaces', title: 'OSPF interfaces', since: 'P3',
    columns: [
      { key: 'port', title: 'Interface', format: 'port' }, { key: 'area', title: 'Area', format: 'text' },
      { key: 'networkType', title: 'Network type', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'cost', title: 'Cost', format: 'number' }, { key: 'priority', title: 'Priority', format: 'number' },
      { key: 'dr', title: 'DR', format: 'ipv4' }, { key: 'bdr', title: 'BDR', format: 'ipv4' },
      { key: 'neighbors', title: 'Neighbours', format: 'number' }, { key: 'adjacent', title: 'Adjacent', format: 'number' },
      { key: 'passive', title: 'Passive', format: 'bool' }, { key: 'routerId', title: 'Router id', format: 'ipv4' },
    ],
  },
  'ospf-neighbors': {
    name: 'ospf-neighbors', title: 'OSPF neighbours', since: 'P3',
    columns: [
      { key: 'routerId', title: 'Neighbour id', format: 'ipv4' }, { key: 'priority', title: 'Priority', format: 'number' },
      { key: 'state', title: 'State', format: 'state' }, { key: 'role', title: 'Role', format: 'state' },
      { key: 'address', title: 'Address', format: 'ipv4' }, { key: 'port', title: 'Interface', format: 'port' },
    ],
  },
  'ospf-lsdb': {
    name: 'ospf-lsdb', title: 'Link-state database', since: 'P3',
    columns: [
      { key: 'scope', title: 'Area', format: 'text' }, { key: 'type', title: 'Type', format: 'number' },
      { key: 'lsid', title: 'Link state id', format: 'ipv4' }, { key: 'advRouter', title: 'Advertising router', format: 'ipv4' },
      { key: 'seq', title: 'Sequence', format: 'number' }, { key: 'checksum', title: 'Checksum', format: 'number' },
      { key: 'self', title: 'Own', format: 'bool' },
    ],
  },
  acl: {
    name: 'acl', title: 'Access list hits', since: 'P3',
    columns: [
      { key: 'list', title: 'List', format: 'text' }, { key: 'seq', title: 'Line', format: 'number' },
      { key: 'action', title: 'Action', format: 'state' }, { key: 'entry', title: 'Entry', format: 'text' },
      { key: 'matches', title: 'Matches', format: 'number' }, { key: 'applied', title: 'Applied on', format: 'text' },
    ],
  },
  'dhcp-snooping': {
    name: 'dhcp-snooping', title: 'DHCP snooping bindings', since: 'P3',
    columns: [
      { key: 'mac', title: 'MAC', format: 'mac' }, { key: 'ip', title: 'Address', format: 'ipv4' },
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'port', title: 'Port', format: 'port' },
      { key: 'kind', title: 'Kind', format: 'text' }, { key: 'expiresAt', title: 'Lease ends', format: 'time' },
    ],
  },
  'arp-inspection': {
    name: 'arp-inspection', title: 'ARP inspection', since: 'P3',
    columns: [
      { key: 'vlan', title: 'VLAN', format: 'number' }, { key: 'forwarded', title: 'Forwarded', format: 'number' },
      { key: 'dropped', title: 'Dropped', format: 'number' }, { key: 'droppedNoBinding', title: 'No binding', format: 'number' },
      { key: 'droppedAcl', title: 'Denied by list', format: 'number' },
    ],
  },
  'cdp-neighbours': {
    name: 'cdp-neighbours', title: 'CDP neighbours', since: 'P3',
    columns: [
      { key: 'deviceId', title: 'Device', format: 'text' }, { key: 'localPort', title: 'Local port', format: 'port' },
      { key: 'remotePort', title: 'Remote port', format: 'text' }, { key: 'platform', title: 'Platform', format: 'text' },
      { key: 'capabilities', title: 'Capabilities', format: 'text' }, { key: 'addresses', title: 'Addresses', format: 'text' },
      { key: 'expiresAt', title: 'Holdtime', format: 'time' },
    ],
  },
  'lldp-neighbours': {
    name: 'lldp-neighbours', title: 'LLDP neighbours', since: 'P3',
    columns: [
      { key: 'systemName', title: 'System', format: 'text' }, { key: 'localPort', title: 'Local port', format: 'port' },
      { key: 'portId', title: 'Remote port', format: 'text' }, { key: 'chassisId', title: 'Chassis id', format: 'text' },
      { key: 'capabilities', title: 'Capabilities', format: 'text' }, { key: 'mgmtAddress', title: 'Management address', format: 'ipv4' },
      { key: 'expiresAt', title: 'Time to live', format: 'time' },
    ],
  },
  'ntp-peers': {
    name: 'ntp-peers', title: 'Time servers', since: 'P3',
    columns: [
      { key: 'address', title: 'Server', format: 'ip' }, { key: 'selected', title: 'Selection', format: 'state' },
      { key: 'stratum', title: 'Stratum', format: 'number' }, { key: 'refId', title: 'Reference', format: 'text' },
      { key: 'reach', title: 'Reach', format: 'number' }, { key: 'pollS', title: 'Poll (s)', format: 'number' },
    ],
  },
  clock: {
    name: 'clock', title: 'Device clock', since: 'P3',
    columns: [
      { key: 'source', title: 'Source', format: 'state' }, { key: 'stratum', title: 'Stratum', format: 'number' },
      { key: 'reference', title: 'Reference', format: 'text' }, { key: 'offsetMs', title: 'Offset (ms)', format: 'number' },
    ],
  },
  'restconf-log': {
    name: 'restconf-log', title: 'API requests', since: 'P3',
    columns: [
      { key: 'seq', title: 'No.', format: 'number' }, { key: 'method', title: 'Method', format: 'text' },
      { key: 'path', title: 'Path', format: 'text' }, { key: 'status', title: 'Status', format: 'number' },
      { key: 'client', title: 'Client', format: 'ip' }, { key: 'user', title: 'User', format: 'text' },
    ],
  },
  flows: {
    name: 'flows', title: 'Traffic flows', since: 'P3',
    columns: [
      { key: 'flow', title: 'Flow', format: 'text' }, { key: 'src', title: 'From', format: 'ip' },
      { key: 'dscp', title: 'DSCP', format: 'number' }, { key: 'received', title: 'Received', format: 'number' },
      { key: 'lost', title: 'Lost', format: 'number' }, { key: 'delayAvgNs', title: 'Average delay', format: 'duration' },
      { key: 'jitterNs', title: 'Jitter', format: 'duration' }, { key: 'ended', title: 'Ended', format: 'bool' },
    ],
  },
  // the approved items' tables (§8.5)
  'vty-logins': {
    name: 'vty-logins', title: 'Remote logins', since: 'P3',
    columns: [
      { key: 'seq', title: 'No.', format: 'number' }, { key: 'proto', title: 'Protocol', format: 'text' },
      { key: 'peer', title: 'From', format: 'ip' }, { key: 'user', title: 'User', format: 'text' },
      { key: 'result', title: 'Result', format: 'state' }, { key: 'reason', title: 'Reason', format: 'text' },
    ],
  },
  tunnels: {
    name: 'tunnels', title: 'Tunnels', since: 'P3',
    columns: [
      { key: 'port', title: 'Tunnel', format: 'port' }, { key: 'mode', title: 'Mode', format: 'text' },
      { key: 'source', title: 'Source', format: 'ipv4' }, { key: 'destination', title: 'Destination', format: 'ipv4' },
      { key: 'state', title: 'State', format: 'state' }, { key: 'reason', title: 'Reason', format: 'text' },
      { key: 'ipMtu', title: 'IP MTU', format: 'number' },
    ],
  },
  ppp: {
    name: 'ppp', title: 'PPP links', since: 'P3',
    columns: [
      { key: 'port', title: 'Interface', format: 'port' }, { key: 'phase', title: 'Phase', format: 'state' },
      { key: 'lcp', title: 'LCP', format: 'state' }, { key: 'authLocal', title: 'Authentication', format: 'text' },
      { key: 'authLocalState', title: 'Result', format: 'state' }, { key: 'peerName', title: 'Peer', format: 'text' },
      { key: 'ipcp', title: 'IPCP', format: 'state' }, { key: 'peerAddress', title: 'Peer address', format: 'ipv4' },
      { key: 'failures', title: 'Failures', format: 'number' },
    ],
  },
  'syslog-messages': {
    name: 'syslog-messages', title: 'Syslog messages', since: 'P3',
    columns: [
      { key: 'seq', title: 'No.', format: 'number' }, { key: 'from', title: 'From', format: 'ip' },
      { key: 'severity', title: 'Severity', format: 'number' }, { key: 'hostname', title: 'Host', format: 'text' },
      { key: 'stamp', title: 'Sent', format: 'text' }, { key: 'message', title: 'Message', format: 'text' },
      { key: 'receivedStamp', title: 'Received', format: 'text' },
    ],
  },
  'script-runs': {
    name: 'script-runs', title: 'Script runs', since: 'P3',
    columns: [
      { key: 'run', title: 'Run', format: 'text' }, { key: 'file', title: 'File', format: 'text' },
      { key: 'state', title: 'State', format: 'state' }, { key: 'requests', title: 'Requests', format: 'number' },
      { key: 'error', title: 'Error', format: 'text' },
    ],
  },
  'eigrp-neighbors': {
    name: 'eigrp-neighbors', title: 'EIGRP neighbours', since: 'P3',
    columns: [
      { key: 'address', title: 'Address', format: 'ipv4' }, { key: 'iface', title: 'Interface', format: 'port' },
      { key: 'as', title: 'AS', format: 'number' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'holdS', title: 'Hold (s)', format: 'number' }, { key: 'srttMs', title: 'SRTT (ms)', format: 'number' },
      { key: 'rtoMs', title: 'RTO (ms)', format: 'number' },
    ],
  },
  'eigrp-topology': {
    name: 'eigrp-topology', title: 'EIGRP topology', since: 'P3',
    columns: [
      { key: 'prefix', title: 'Destination', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'fd', title: 'Feasible distance', format: 'number' }, { key: 'connected', title: 'Connected on', format: 'port' },
      { key: 'pendingReplies', title: 'Replies awaited', format: 'number' },
    ],
  },
  'ipsec-sa': {
    name: 'ipsec-sa', title: 'IPsec SAs', since: 'P3',
    columns: [
      { key: 'port', title: 'Tunnel', format: 'port' }, { key: 'peer', title: 'Peer', format: 'ipv4' },
      { key: 'role', title: 'Role', format: 'text' }, { key: 'state', title: 'State', format: 'state' },
      { key: 'reason', title: 'Reason', format: 'text' }, { key: 'proposal', title: 'Proposal', format: 'text' },
    ],
  },
});

/**
 * Extra tables implied by processes (defineModel derives `DeviceModel.tables` from these). The P2 rows (@since P2)
 * name daemons that no model runs before their factories are registered, so no P1 model gains a table; port-security
 * rows are written by eth-switch but hang off `vlan`, so only managed switches declare the table.
 */
export const PROCESS_TABLES: Readonly<Partial<Record<ProcessName, readonly ExtraTableName[]>>> = Object.freeze({
  'wlan-ap': ['dot11-assoc'],
  'wlan-client': ['dot11-assoc'],
  ipv6: ['rib6'],
  nd: ['nd'],
  udp: ['sockets'],
  tcp: ['sockets'],
  'dhcp-server': ['dhcp-bindings'],
  'dns-client': ['dns-cache'],
  'dns-server': ['dns-cache'],
  // ── P2 ──
  vlan: ['vlans', 'port-security'],
  dtp: ['dtp'],
  stp: ['stp', 'stp-bridge'],
  etherchannel: ['etherchannel'],
  nat: ['nat'],
  'dhcpv6-server': ['dhcpv6-bindings'],
  'capwap-wtp': ['capwap'],
  'capwap-ac': ['capwap-aps', 'wlan-clients'],
  hsrp: ['hsrp'], // [SHOULD S2]
});

/** Default ageing timers. */
export const CAM_AGEING_NS = 300 * 1_000_000_000; // 300 s
export const ARP_TIMEOUT_NS = 4 * 60 * 60 * 1_000_000_000; // 4 h on routers
export const ARP_HOST_TIMEOUT_NS = 20 * 60 * 1_000_000_000; // 20 min on hosts (varies by OS; fixed here)
export const ARP_REQUEST_RETRY_NS = 1 * 1_000_000_000; // 1 s between retries
export const ARP_REQUEST_RETRIES = 3;
