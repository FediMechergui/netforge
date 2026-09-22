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
import type { DeviceId, PortId, ProcessName } from './ids.js';
import type { IpAddress, Ipv4Address, Ipv6Address, MacAddress } from './addr.js';
import type { SimTime } from './time.js';
import type { TraceSink } from './trace.js';
import type { SocketId, TcpState } from './transport.js';
import type { WifiAssocState } from './medium.js';
import type { SwitchportMode } from './port.js';

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
  | 'hsrp';
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
   */
  source: 'C' | 'L' | 'S' | 'D';
  nextHop?: Ipv4Address;
  iface?: PortId;
  /** Administrative distance (C/L = 0, S = 1, D = 254). */
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
  /** 'P2' @since P2. */
  readonly since: 'P0' | 'P0.5' | 'P1' | 'P2';
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
