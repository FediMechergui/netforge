/**
 * Port model v2 (spec §4.4 "Port model"; ARCHITECTURE-P1 D3, D6, D7, D8).
 *
 * Counters are REAL — derived only from simulated frames. `show interfaces` renders these; it is
 * never faked.
 *
 * FIELD OWNERSHIP on `PortState`:
 *   link model ONLY : tx, operUp (of non-virtual ports), speedBps, duplex, link, lastChange, phy
 *   device runtime  : everything else — role, encap, ordinal, adminUp, errDisabled, counters, l3, mtu,
 *                     module, transceiver, and operUp/lastChange of VIRTUAL ports (svi/virtual roles).
 *
 * TRANSITION RULE (applies to every member tagged `@since P0.5` or `@since P1` anywhere in
 * contracts/): the member is optional in the TYPE only so P0 code and hand-written test fixtures keep
 * compiling. The build-wave item that implements it (docs/ARCHITECTURE-P1.md §8) removes the `?` in
 * the same change and migrates fixtures; code written in later waves may rely on it being present.
 *
 * P2 (docs/ARCHITECTURE-P2.md §0 rule 2, §2.15): the same rule holds for every member tagged `@since P2`. Members
 * tagged `@since P2 (optional by meaning)` keep their `?` for ever: absent means P1 behaviour and P1 bytes.
 */
import type { LinkId, PortId, ProcessName } from './ids.js';
import type { Ipv4Address, Ipv6Address, MacAddress } from './addr.js';
import type { SimTime } from './time.js';
import type { Connector, ModuleInstall, ModuleType, PoeSpec, PortEncap, PortRole, SlotId, Wiring } from './catalog.js';
import type { PortPhy } from './link.js';
import type { RadioPortSpec } from './rf.js';

/** Physical/logical port kind (CATALOG.md families). `virtual` = SVI or loopback (not in the link model). */
export type PortKind =
  | 'ethernet'
  | 'serial'
  | 'console'
  | 'usb'
  | 'coax'
  | 'phone'
  | 'fiber-pon'
  | 'wlan'
  | 'radio'
  | 'cellular'
  | 'virtual';

export type Duplex = 'full' | 'half' | 'auto';

export interface PortCounters {
  inPackets: number;
  outPackets: number;
  inBytes: number;
  outBytes: number;
  inErrors: number;
  crcErrors: number;
  runts: number;
  giants: number;
  /** Collisions seen while transmitting (segment media; D4). */
  collisions: number;
  inDrops: number;
  outDrops: number;
  /** Frames flooded/broadcast received. */
  inBroadcasts: number;
  /** @since P0.5 Collisions detected after the slot time (no retry). */
  lateCollisions?: number;
  /** @since P0.5 Transmissions that waited for carrier (counted once per frame). */
  deferred?: number;
  /** @since P0.5 Frames dropped after 16 collisions. */
  excessiveCollisions?: number;
  /** @since P0.5 802.11 retransmission attempts. */
  txRetries?: number;
}

/** P0 counter set (the P0.5 optional counters start absent and are created on first increment). */
export function emptyCounters(): PortCounters {
  return {
    inPackets: 0, outPackets: 0, inBytes: 0, outBytes: 0, inErrors: 0, crcErrors: 0,
    runts: 0, giants: 0, collisions: 0, inDrops: 0, outDrops: 0, inBroadcasts: 0,
  };
}

/** Static description of a port (catalog model, module template instance or virtual family instance). */
export interface PortSpec {
  /** Canonical long name, e.g. 'GigabitEthernet0/1', 'Wlan0', 'Internet', 'Vlan1'. */
  name: PortId;
  /** Short name accepted at the CLI, e.g. 'Gi0/1', 'Wl0', 'Inet', 'Vl1'. */
  short: string;
  kind: PortKind;
  /** Max negotiable speed. */
  speedBps: number;
  /** Supported speeds for autonegotiation (descending, includes speedBps). */
  speeds?: number[];
  /** Ethernet: the port swaps pairs automatically, so either copper cable works. */
  autoMdix?: boolean;
  /** @deprecated D6: the DCE end is chosen by the cable (serial-dce/serial-dte media or dce_end). Legacy 'serial' media only. */
  serial?: { dce?: boolean };

  // ── P0.5 ──
  /** @since P0.5 Default role. `defineModel` always fills it; hand-built fixtures fall back to `defaultRoleFor(kind, capabilities)`. */
  role: PortRole;
  /** @since P0.5 Roles config may switch to (e.g. ['switched','routed'] on multilayer switch ports). Default [role]. */
  allowedRoles: readonly PortRole[];
  /** @since P0.5 Copper wiring when not auto-MDIX (default ROLE_TRAITS[role].wiring; a role flip never changes it). */
  wiring?: Wiring;
  /** @since P0.5 Default KIND_CONNECTOR[kind]. SFP cages use 'sfp'/'sfp+' and need a transceiver for fibre. */
  connector: Connector;
  /** @since P0.5 Default KIND_ENCAP[kind]. */
  encap: PortEncap;
  poe?: PoeSpec;
  /** @since P0.5 Stable MAC/port ordinal: fixed ports 1..127 (default index+1); module ports stamped by `modulePortSpecs`. */
  ordinal: number;
  /** @since P0.5 Set on module-generated ports and SFP cages. */
  slot?: SlotId;
  /** @since P0.5 Set on module-generated ports. */
  module?: ModuleType;
  /** @since P0.5 wlan/radio/cellular ports. */
  radio?: RadioPortSpec;
  /** @since P0.5 Receive every frame (IDS monitor ports): skips the MAC filter. */
  promiscuous?: boolean;
  /** @since P0.5 Port-picker grouping hint: 'front' | 'uplink' | 'console' | `slot:${id}` | 'radio'. */
  group?: string;
  /** @since P0.5 Overrides `model.portsDefaultUp` for this port. */
  defaultAdminUp?: boolean;
  /** @since P0.5 Default MTU (1500; data-centre ports may declare 9216). */
  mtu?: number;
  /** @since P1 Duplex modes the PHY supports (default ['full','half'] on copper ≤ 1 Gb, ['full'] above). Repeater ports: ['half']. */
  duplexModes?: readonly ('full' | 'half')[];
  /** @since P1 Autonegotiation capable (default true on copper ethernet). */
  autoneg?: boolean;
  /** @since P0.5 Serial port generates line clock itself (CSU/DSU, provider serial): satisfies the DCE clock rule without `clock rate`. */
  clockSource?: boolean;
  /** @since P2 (optional by meaning) Subinterfaces only: the physical port that carries it (D11). */
  parent?: PortId;
}

/** IPv4 address on a port. Written only by the ipv4 process via `setPortL3`. */
export interface PortIpv4Address {
  address: Ipv4Address;
  prefixLen: number;
  /** @since P1 How it was obtained (show ip interface brief Method column). Absent = manual. */
  origin?: 'manual' | 'dhcp' | 'apipa';
  /** @since P1 DHCP lease end (absolute). */
  leaseExpiresAt?: SimTime;
}

/** One IPv6 address on a port (RFC 5952 canonical text). Written only by the ipv6 process. */
export interface Ipv6PortAddress {
  address: Ipv6Address;
  prefixLen: number;
  scope: 'link-local' | 'unique-local' | 'global';
  origin: 'manual' | 'eui64' | 'auto-link-local' | 'slaac' | 'dhcpv6';
  /** DAD state. Only 'preferred' addresses are used as a source or answer NS. */
  state: 'tentative' | 'preferred' | 'deprecated' | 'duplicate';
  /** SLAAC lifetimes (absolute); undefined = infinite. */
  preferredUntil?: SimTime;
  validUntil?: SimTime;
}

/** Derived L3 state placed on a port by ipv4/ipv6. Config remains the source of truth. */
export interface PortL3 {
  ipv4?: PortIpv4Address;
  /** @since P1 Ordered: link-local first, then configuration/learning order. */
  ipv6?: readonly Ipv6PortAddress[];
  /** @since P1 IPv6 processing active on this port (any ipv6 interface line present). */
  ipv6Enabled?: boolean;
  /** @since P1 Joined IPv6 multicast groups (all-nodes, solicited-node per address, all-routers on routers). Canonical. */
  groups6?: readonly Ipv6Address[];
  /**
   * @since P2 (optional by meaning) Virtual IPv4 addresses answered on this port (nat pool / static inside-global
   * addresses; hsrp virtual IPs), ordered by (owner, address). Written ONLY by ipv4 (setPortL3, per-member merge) on
   * `ipv4.virtual` requests (D15).
   */
  virtual4?: readonly VirtualIpv4[];
  /**
   * @since P2 (optional by meaning) [SHOULD S2] Joined IPv4 multicast groups (hsrp). Written ONLY by ipv4 on
   * `ipv4.group` requests (D15); read by the pipeline's multicast-group filter (step 10b) and `isLocalDestination`.
   */
  groups4?: readonly Ipv4Address[];
}

/** Live port state (snapshotable). */
export interface PortState {
  readonly id: PortId;
  readonly spec: PortSpec;
  /** D8: `portMac(deviceMacBase(id, salt), ordinal)`; virtual ports use ordinal 0. */
  readonly mac: MacAddress;
  /** `no shutdown` → true. Hosts default true; router ports default false (a classic lab). */
  adminUp: boolean;
  /** Line protocol up: carrier && line protocol (serial clocking/keepalive) && not err-disabled; virtual ports per ARCHITECTURE-P1 §3.10. */
  operUp: boolean;
  /** Negotiated values (undefined until link up). */
  speedBps?: number;
  duplex?: Duplex;
  mtu: number;
  link?: LinkId;
  /** Why the port is err-disabled. Keeps its type `string`; P2 writers store an `ErrDisableCause`. */
  errDisabled?: string;
  counters: PortCounters;
  l3: PortL3;
  /** Egress serialization state (link model). */
  tx: { busyUntil: SimTime; queue: number /* frames waiting */ };
  /** Last state change, for `show interfaces` "last input/output". */
  lastInput?: SimTime;
  lastOutput?: SimTime;
  lastChange?: SimTime;

  // ── P0.5 ──
  /** @since P0.5 Effective role (runtime-owned; `no switchport` flips it; reset to spec role at power-off). */
  role: PortRole;
  /** @since P0.5 Stable ordinal (see PortSpec.ordinal). */
  ordinal: number;
  /** @since P0.5 Effective encapsulation (runtime-owned; `encapsulation ppp` is P3). */
  encap: PortEncap;
  /** @since P0.5 Link-model-owned physical detail (carrier vs line protocol, negotiation, segment, DCE). */
  phy?: PortPhy;
  /** @since P0.5 Module that generated this port. */
  module?: ModuleInstall;
  /** @since P0.5 SFP cage: installed transceiver module type. */
  transceiver?: ModuleType;
  /**
   * @since P2 (optional by meaning) Subinterfaces only; runtime-owned, from `encapsulation dot1Q <vid> [native]`
   * (D11). Absent = no encapsulation yet (the subinterface stays down, reason `no-encapsulation`).
   */
  dot1q?: { vid: number; native: boolean };
}

/** Read-only view exposed to processes and snapshots. */
export type PortView = Readonly<Omit<PortState, 'counters' | 'l3' | 'tx'>> & {
  readonly counters: Readonly<PortCounters>;
  readonly l3: Readonly<PortL3>;
  readonly tx: Readonly<PortState['tx']>;
};

// ── P2: switchports, err-disable, virtual addresses (ARCHITECTURE-P2 §2.2) ──

/** @since P2 Admin mode of a switched (or Port-channel) port. Default 'dynamic-auto' (D3). */
export type SwitchportMode = 'access' | 'trunk' | 'dynamic-auto' | 'dynamic-desirable';

/**
 * @since P2 The switchport lines of one port, parsed. The ONLY reader is `readSwitchport(config, port)`
 * (protocols/l2/switchport-config.ts); every consumer (eth-switch, dtp, stp, etherchannel, runtime SVI autostate,
 * snapshot, show, lab checks) calls it on the running config. Never stored in PortState.
 */
export interface SwitchportConfig {
  readonly mode: SwitchportMode;
  /** false with `switchport nonegotiate` (accepted only in access or trunk mode). */
  readonly negotiate: boolean;
  readonly accessVlan: number;
  /** `switchport voice vlan <v>`; absent = none. */
  readonly voiceVlan?: number;
  readonly nativeVlan: number;
  /** Canonical VLAN list (core/vlan-list.ts format: ascending ranges, '1-4094' = all, '' = none). */
  readonly allowed: string;
}

/** @since P2 What `readSwitchport` returns for a port with no switchport lines (D3). */
export const DEFAULT_SWITCHPORT: SwitchportConfig = Object.freeze({
  mode: 'dynamic-auto', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094',
});

/**
 * @since P2 The fixed L2 view of a wireless-controller distribution port (D17): readSwitchport returns it for every
 * port of a `wireless-controller` model; the grammar accepts no switchport line there.
 */
export const CONTROLLER_PORT_SWITCHPORT: SwitchportConfig = Object.freeze({
  mode: 'trunk', negotiate: false, accessVlan: 1, nativeVlan: 1, allowed: '1-4094',
});

/** @since P2 Why a port is err-disabled (PortState.errDisabled holds one of these). */
export type ErrDisableCause = 'psecure-violation' | 'bpduguard' | 'channel-misconfig' | 'fault';
/** @since P2 Every err-disable cause, in the order `show errdisable recovery` lists them. */
export const ERR_DISABLE_CAUSES: readonly ErrDisableCause[] = Object.freeze(['psecure-violation', 'bpduguard', 'channel-misconfig', 'fault']);

/** @since P2 A virtual IPv4 address answered on a port (HSRP virtual IP, NAT pool / static inside-global address). */
export interface VirtualIpv4 {
  readonly address: Ipv4Address;
  /** MAC used in ARP replies (and as Ethernet source when the owner sends from it). */
  readonly mac: MacAddress;
  readonly owner: ProcessName;
  /** true = a packet to `address` is for this device (HSRP active); false = ARP answers only (NAT pool). */
  readonly local: boolean;
}

/** Well-known speeds. */
export const SPEED_10M = 10_000_000;
export const SPEED_100M = 100_000_000;
export const SPEED_1G = 1_000_000_000;
export const SPEED_10G = 10_000_000_000;
export const SPEED_40G = 40_000_000_000;
export const DEFAULT_MTU = 1500;
/** Data-centre jumbo MTU. */
export const JUMBO_MTU = 9216;
