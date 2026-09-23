/**
 * Catalog vocabulary — P0.5 (docs/CATALOG.md; spec §4.4, §5; ARCHITECTURE-P1 D2, D3, D7, D13).
 *
 * Behaviour is CAPABILITY- and PORT-ROLE-driven (D2/D3). `DeviceModel.kind` only picks the icon
 * family and palette group; no engine or web code may branch behaviour on it. This file is the
 * shared vocabulary: capabilities, categories, icon ids, port roles and their traits, port
 * families, connectors, encapsulations, slots and modules, virtual interface families, CLI/GUI
 * descriptors, IP defaults and the canonical daemon order. Pure data plus a few tiny pure helpers
 * whose exact output is part of the contract. Structured-clone safe and deterministic (rule 1).
 * All labels and messages are ORIGINAL wording (§1.6).
 */
import type { ProcessName } from './ids.js';
import type { DeviceModel } from './device.js';
import type { PortKind, PortSpec } from './port.js';
import type { PrivilegeLevel } from './cli.js';
import type { SimTime } from './time.js';
import { HOUR, MIN, SEC } from './time.js';

// ── build stages ─────────────────────────────────────────────────────────────

/** Delivery stage of a feature (D1). `since` tags in contracts and catalog derivations use it. 'P2' @since P2. */
export type BuildStage = 'P0' | 'P0.5' | 'P1' | 'P2';

/** Stages in delivery order. */
export const BUILD_STAGES: readonly BuildStage[] = ['P0', 'P0.5', 'P1', 'P2'];

/** True when something delivered in stage `since` exists in a build of stage `current`. */
export function stageIncluded(since: BuildStage, current: BuildStage): boolean {
  return BUILD_STAGES.indexOf(since) <= BUILD_STAGES.indexOf(current);
}

// ── defaults profiles (ARCHITECTURE-P2 D2) ───────────────────────────────────

/**
 * @since P2 Which stage's DEFAULT behaviours a world uses (D2). Absent in a topology = 'P1'. Never gates a feature:
 * every P2 command works in a P1 world when typed. Visible defaults are config lines replayed at every boot
 * (`DeviceModel.profileConfig`); invisible defaults are read from `ProcessCtx.profile` (P2: proxy ARP only).
 */
export type DefaultsProfile = 'P1' | 'P2';
/** @since P2 Profiles in delivery order. */
export const DEFAULTS_PROFILES: readonly DefaultsProfile[] = ['P1', 'P2'];
/** @since P2 True when the defaults introduced by `since` apply in a world whose profile is `profile`. */
export function profileIncludes(profile: DefaultsProfile, since: DefaultsProfile): boolean {
  return DEFAULTS_PROFILES.indexOf(since) <= DEFAULTS_PROFILES.indexOf(profile);
}

// ── capabilities ─────────────────────────────────────────────────────────────

/** Behaviour flags (docs/CATALOG.md). The tuple order is the canonical storage order of `DeviceModel.capabilities`. */
export const CAPABILITIES = [
  'host',
  'server',
  'switching',
  'routing',
  'layer3-switch',
  'repeater',
  'wifi-ap',
  'wifi-client',
  'radio-bridge',
  'cellular-cell',
  'cellular-client',
  'modem',
  'cloud',
  'firewall',
  'nat-gateway',
  'dhcp-server',
  'poe-source',
  'poe-powered',
  'modular',
  // ── P2 (appended: tuple order = storage order, so every existing list is unchanged) ──
  /** @since P2 VLAN-aware bridge with VLAN database, DTP, spanning tree, EtherChannel, port security (D5). */
  'managed-switch',
  /** @since P2 Access point managed by a controller over CAPWAP (D17). */
  'lightweight-ap',
  /** @since P2 Controller appliance: CAPWAP controller + VLAN-aware bridge, no spanning tree (D17). */
  'wireless-controller',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Implications applied transitively by `expandCapabilities`. P2 adds the rows of its own three capabilities; no
 * existing implication changes (D5: `layer3-switch` does NOT imply `managed-switch`, because `expandCapabilities`
 * has no stage — the multilayer and data-centre models list `managed-switch` explicitly in their W4 data).
 */
export const CAPABILITY_IMPLIES: Readonly<Partial<Record<Capability, readonly Capability[]>>> = {
  server: ['host'],
  'layer3-switch': ['switching', 'routing'],
  firewall: ['routing'],
  'nat-gateway': ['routing'],
  'managed-switch': ['switching'],
  'lightweight-ap': ['wifi-ap'],
  'wireless-controller': ['switching'],
};

/** Pairs that may not coexist on one model (catalog validation error). */
export const CAPABILITY_EXCLUDES: Readonly<Partial<Record<Capability, readonly Capability[]>>> = {
  repeater: ['host', 'switching', 'routing', 'wifi-ap', 'wifi-client', 'modem', 'cloud'],
  'cellular-cell': ['cellular-client'],
};

/** Transitive closure of `caps` under CAPABILITY_IMPLIES, in CAPABILITIES order, without duplicates. */
export function expandCapabilities(caps: readonly Capability[]): readonly Capability[] {
  const on = new Set<Capability>();
  const stack: Capability[] = [...caps];
  while (stack.length > 0) {
    const c = stack.pop() as Capability;
    if (on.has(c)) continue;
    on.add(c);
    for (const d of CAPABILITY_IMPLIES[c] ?? []) stack.push(d);
  }
  return CAPABILITIES.filter((c) => on.has(c));
}

/**
 * Capability test on an EXPANDED list (`DeviceModel.capabilities` or the effective
 * `DeviceRuntime.capabilities`, which adds module capabilities). `undefined` (a P0 literal
 * fixture without v2 fields) has no capabilities.
 */
export function hasCapability(caps: readonly Capability[] | undefined, cap: Capability): boolean {
  return caps !== undefined && caps.includes(cap);
}

// ── categories and icons ─────────────────────────────────────────────────────

export type CategoryGroup = 'network' | 'end-devices';

/** Palette categories in display order (labels original). */
export const DEVICE_CATEGORIES = [
  { id: 'routers', label: 'Routers', group: 'network' },
  { id: 'switches', label: 'Switches', group: 'network' },
  { id: 'multilayer-switches', label: 'Multilayer switches', group: 'network' },
  { id: 'data-centre', label: 'Data centre', group: 'network' },
  { id: 'legacy', label: 'Legacy', group: 'network' },
  { id: 'security', label: 'Security', group: 'network' },
  { id: 'wireless', label: 'Wireless', group: 'network' },
  { id: 'home-soho', label: 'Home & SOHO', group: 'network' },
  { id: 'radios', label: 'Radios', group: 'network' },
  { id: 'wan-isp', label: 'WAN & ISP', group: 'network' },
  { id: 'computers', label: 'Computers', group: 'end-devices' },
  { id: 'servers', label: 'Servers', group: 'end-devices' },
  { id: 'mobile', label: 'Mobile', group: 'end-devices' },
  { id: 'voice', label: 'Voice', group: 'end-devices' },
  { id: 'peripherals', label: 'Peripherals', group: 'end-devices' },
  { id: 'iot', label: 'IoT', group: 'end-devices' },
] as const satisfies readonly { readonly id: string; readonly label: string; readonly group: CategoryGroup }[];
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number]['id'];

/**
 * Icon registry keys. The web visual registry (apps/web/src/catalog/visuals.ts) must provide an
 * original artwork for EVERY id plus a labelled generic fallback; every catalog model uses one.
 */
export const DEVICE_ICONS = [
  'router',
  'router-modular',
  'router-chassis',
  'switch',
  'switch-poe',
  'mlswitch',
  'dc-leaf',
  'dc-spine',
  'hub',
  'coax-tap',
  'repeater',
  'bridge',
  'firewall',
  'ids',
  'ap',
  'ap-outdoor',
  'wlc',
  'home-router',
  'radio-ptp',
  'cell-tower',
  'modem-dsl',
  'modem-cable',
  'ont',
  'csu',
  'cloud',
  'pc',
  'pc-wifi',
  'laptop',
  'server',
  'server-rack',
  'smartphone',
  'tablet',
  'ip-phone',
  'printer',
  'smart-tv',
  'iot-sensor',
  'ip-camera',
  'thermostat',
  'smart-plug',
  'iot-gateway',
] as const;
export type DeviceIconId = (typeof DEVICE_ICONS)[number];

// ── port roles (D3) ──────────────────────────────────────────────────────────

/**
 * Per-port role. The list is fixed by D3. `svi` = switch virtual interface (VlanN), `virtual` =
 * loopback-like interface. A cell tower's radio port uses `wireless-bss` (a multipoint access
 * radio serving clients); `cellular` is the client (UE) side. Host NICs use `routed`.
 */
export const PORT_ROLES = [
  'switched',
  'routed',
  'repeater',
  'wireless-bss',
  'wireless-client',
  'radio-ptp',
  'cellular',
  'wan',
  'mgmt',
  'access-line',
  'console',
  'svi',
  'virtual',
  // ── P2 (appended) ──
  /** @since P2 `interface Port-channelN`: bridged, virtual, egress owned by `etherchannel` (D10). */
  'channel',
  /** @since P2 Router subinterface `<parent>.<n>`: l3, virtual, egress through `PortSpec.parent` (D11). */
  'subif',
  /** @since P2 The controller's CAPWAP tunnel port (`Capwap0`): bridged, hairpin, egress owned by `capwap-ac` (D17). */
  'wlan-tunnel',
] as const;
export type PortRole = (typeof PORT_ROLES)[number];

/** Outermost encapsulation a port carries on its medium. `ppp` is RESERVED (P3). */
export type PortEncap = 'ethernet' | 'hdlc' | 'ppp' | 'dot11' | 'none';

/** Outer framing of a PDU as seen by the device frame pipeline (validator, MAC filter, demux layer). */
export type FramingProto = 'ethernet' | 'hdlc' | 'dot11';

/** Ethernet copper wiring side: MDI (hosts, routers) transmits on pins 1-2, MDI-X (switch ports) on 3-6. */
export type Wiring = 'MDI' | 'MDI-X';

/** Physical connector of a port (or of a transceiver/cable end). */
export type Connector =
  | 'rj45'
  | 'rj45-console'
  | 'usb'
  | 'usb-mini'
  | 'usb-c'
  | 'sfp'
  | 'sfp+'
  | 'qsfp'
  | 'lc'
  | 'sc'
  | 'smart-serial'
  | 'db60'
  | 'bnc'
  | 'f-type'
  | 'rj11'
  | 'antenna'
  | 'none';

/** Everything behaviour needs to know about a role. Code reads these; it never compares role literals ad hoc. */
export interface PortRoleTraits {
  /** Frames delivered to the port enter the device frame pipeline. False: console (out-of-band) and repeater (the link layer's collision domain repeats bits, D4). */
  readonly frames: boolean;
  /** Member of the device's transparent bridge: eth-switch learns, floods and forwards among bridged ports. */
  readonly bridged: boolean;
  /** The bridge may send a frame back out the port it arrived on (one radio, many stations); the medium suppresses the copy to the originator. */
  readonly hairpin: boolean;
  /** May own L3 addresses; IPv4/IPv6 daemons act only on l3 ports; the MAC not-for-me filter applies (see `macFilterApplies`). */
  readonly l3: boolean;
  /** May terminate a TopologyLink in the link model: a cable, or a PtP radio link for `radio-ptp`. Drives port-picker eligibility. */
  readonly linkable: boolean;
  /** Rendered as an `interface` section in running-config; `shutdown` is allowed. */
  readonly configurable: boolean;
  /** Unknown to the link model; the device runtime derives oper state (svi, virtual). */
  readonly virtual: boolean;
  /**
   * How a `send` action on the port is applied by the device runtime:
   *  'link'  → DeviceRuntimeDeps.transmit (cable, segment, PtP radio, air or cell medium; the link model routes);
   *  'owner' → `model.portOwners[role]`'s `Process.onEgress` when another process sends; the owner's own send on a
   *            virtual port is dropped 'other' detail 'virtual-transmit';
   *  'loop'  → counted, then immediately re-enters the frame pipeline on the same port (Action 'ingress');
   *  'parent' (@since P2) → count out on the subinterface, push its 802.1Q tag unless native, then transmit on
   *            `PortSpec.parent` exactly like a 'link' send on that port (ARCHITECTURE-P2 §3.4).
   */
  readonly egress: 'link' | 'owner' | 'loop' | 'parent';
  /** Default copper wiring for non-auto-MDIX ethernet ports whose DEFAULT role is this one (never changed by a role flip); null = not applicable. */
  readonly wiring: Wiring | null;
  /** Original UI label. The UI labels a `routed` port 'Network adapter' when the device has `host` but not `routing`. */
  readonly label: string;
}

export const ROLE_TRAITS: Readonly<Record<PortRole, PortRoleTraits>> = Object.freeze({
  switched: { frames: true, bridged: true, hairpin: false, l3: false, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: 'MDI-X', label: 'Switched port' },
  routed: { frames: true, bridged: false, hairpin: false, l3: true, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: 'MDI', label: 'Routed interface' },
  repeater: { frames: false, bridged: false, hairpin: false, l3: false, linkable: true, configurable: false, virtual: false, egress: 'link', wiring: 'MDI-X', label: 'Repeater port' },
  'wireless-bss': { frames: true, bridged: true, hairpin: true, l3: false, linkable: false, configurable: true, virtual: false, egress: 'link', wiring: null, label: 'Access radio' },
  'wireless-client': { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: false, egress: 'link', wiring: null, label: 'Wireless adapter' },
  'radio-ptp': { frames: true, bridged: true, hairpin: false, l3: false, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: null, label: 'Point-to-point radio' },
  cellular: { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: false, egress: 'link', wiring: null, label: 'Cellular adapter' },
  wan: { frames: true, bridged: false, hairpin: false, l3: true, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: 'MDI', label: 'WAN interface' },
  mgmt: { frames: true, bridged: false, hairpin: false, l3: true, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: 'MDI', label: 'Management port' },
  'access-line': { frames: true, bridged: true, hairpin: false, l3: false, linkable: true, configurable: true, virtual: false, egress: 'link', wiring: null, label: 'Access line' },
  console: { frames: false, bridged: false, hairpin: false, l3: false, linkable: true, configurable: false, virtual: false, egress: 'link', wiring: null, label: 'Console port' },
  svi: { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: true, egress: 'owner', wiring: null, label: 'Switch virtual interface' },
  virtual: { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: true, egress: 'loop', wiring: null, label: 'Virtual interface' },
  // ── P2 ──
  channel: { frames: true, bridged: true, hairpin: false, l3: false, linkable: false, configurable: true, virtual: true, egress: 'owner', wiring: null, label: 'Port channel' },
  subif: { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: true, egress: 'parent', wiring: null, label: 'Subinterface' },
  'wlan-tunnel': { frames: true, bridged: true, hairpin: true, l3: false, linkable: false, configurable: false, virtual: true, egress: 'owner', wiring: null, label: 'Controller tunnel' },
});

/**
 * Roles whose ports are bridge members (eth-switch selectors declare `roles: BRIDGED_ROLES`). BRIDGED_ROLES, L3_ROLES
 * and FRAME_ROLES are derived, so the P2 roles join them with no selector edit (no port carries a P2 role before the
 * wave items that create them).
 */
export const BRIDGED_ROLES: readonly PortRole[] = PORT_ROLES.filter((r) => ROLE_TRAITS[r].bridged);
/** Roles that may hold L3 addresses (arp/ipv4/ipv6/nd selectors declare `roles: L3_ROLES`). */
export const L3_ROLES: readonly PortRole[] = PORT_ROLES.filter((r) => ROLE_TRAITS[r].l3);
/** Roles whose frames enter the device pipeline (the match set of a selector without `roles`). */
export const FRAME_ROLES: readonly PortRole[] = PORT_ROLES.filter((r) => ROLE_TRAITS[r].frames);

/** Port kinds each role may take (catalog validation and `DeviceRuntime.setPortRole`). */
export const ROLE_KINDS: Readonly<Record<PortRole, readonly PortKind[]>> = Object.freeze({
  switched: ['ethernet'],
  routed: ['ethernet'],
  repeater: ['ethernet', 'coax'],
  'wireless-bss': ['wlan', 'cellular'],
  'wireless-client': ['wlan'],
  'radio-ptp': ['radio'],
  cellular: ['cellular'],
  wan: ['ethernet', 'serial'],
  mgmt: ['ethernet'],
  'access-line': ['serial', 'coax', 'phone', 'fiber-pon'],
  console: ['console', 'usb'],
  svi: ['virtual'],
  virtual: ['virtual'],
  // ── P2 ──
  channel: ['virtual'],
  subif: ['virtual'],
  'wlan-tunnel': ['virtual'],
});

/**
 * Default encapsulation per port kind (D6: serial → hdlc). Radio PtP, coax, phone and fibre PON
 * carry Ethernet unchanged; the cellular air carries Ethernet frames between UE and tower (the
 * tower bridges them to its backhaul). Loopback families use 'none' (VirtualFamilySpec decides).
 */
export const KIND_ENCAP: Readonly<Record<PortKind, PortEncap>> = Object.freeze({
  ethernet: 'ethernet',
  serial: 'hdlc',
  console: 'none',
  usb: 'none',
  coax: 'ethernet',
  phone: 'ethernet',
  'fiber-pon': 'ethernet',
  wlan: 'dot11',
  radio: 'ethernet',
  cellular: 'ethernet',
  virtual: 'ethernet',
});

/** Default connector per port kind when `PortSpec.connector` is absent. */
export const KIND_CONNECTOR: Readonly<Record<PortKind, Connector>> = Object.freeze({
  ethernet: 'rj45',
  serial: 'smart-serial',
  console: 'rj45-console',
  usb: 'usb-mini',
  coax: 'bnc',
  phone: 'rj11',
  'fiber-pon': 'sc',
  wlan: 'antenna',
  radio: 'antenna',
  cellular: 'antenna',
  virtual: 'none',
});

/**
 * Default role of a port when catalog input omits it. `caps` must be EXPANDED.
 *  console/usb → console; wlan → wifi-ap ? wireless-bss : wireless-client; radio → radio-ptp;
 *  cellular → cellular-cell ? wireless-bss : cellular; coax → repeater ? repeater : access-line;
 *  phone/fiber-pon → access-line; serial → routing ? wan : access-line; virtual → svi;
 *  ethernet → repeater ? repeater : (switching|wifi-ap|radio-bridge|cellular-cell|modem|cloud) ? switched : routed.
 * Home-router WAN ports, IDS mgmt/monitor ports etc. are set explicitly in catalog data.
 */
export function defaultRoleFor(kind: PortKind, caps: readonly Capability[]): PortRole {
  const has = (c: Capability): boolean => caps.includes(c);
  switch (kind) {
    case 'console':
    case 'usb':
      return 'console';
    case 'wlan':
      return has('wifi-ap') ? 'wireless-bss' : 'wireless-client';
    case 'radio':
      return 'radio-ptp';
    case 'cellular':
      return has('cellular-cell') ? 'wireless-bss' : 'cellular';
    case 'coax':
      return has('repeater') ? 'repeater' : 'access-line';
    case 'phone':
    case 'fiber-pon':
      return 'access-line';
    case 'serial':
      return has('routing') ? 'wan' : 'access-line';
    case 'virtual':
      return 'svi';
    case 'ethernet':
      if (has('repeater')) return 'repeater';
      if (has('switching') || has('wifi-ap') || has('radio-bridge') || has('cellular-cell') || has('modem') || has('cloud')) return 'switched';
      return 'routed';
  }
}

/**
 * True when the MAC not-for-me filter applies to a frame received on a port: the role holds L3
 * addresses, the outer framing carries a destination MAC (ethernet.dst / dot11.addr1) and the port
 * is not promiscuous (IDS monitor ports). P0 outcomes are preserved: host/router ports are
 * `routed` (filter), switch ports are `switched` (no filter).
 */
export function macFilterApplies(role: PortRole, outer: FramingProto, promiscuous: boolean | undefined): boolean {
  return ROLE_TRAITS[role].l3 && outer !== 'hdlc' && promiscuous !== true;
}

// ── port families (naming, CATALOG.md) ───────────────────────────────────────

export interface PortFamily {
  /** Canonical long family, e.g. 'GigabitEthernet'. */
  readonly long: string;
  /** CLI short family, e.g. 'Gi'. */
  readonly short: string;
  readonly kind: PortKind;
}

/** Every canonical port family. Port names are `${long}${number}` / `${short}${number}`. */
export const PORT_FAMILIES: readonly PortFamily[] = Object.freeze([
  { long: 'Ethernet', short: 'Et', kind: 'ethernet' },
  { long: 'FastEthernet', short: 'Fa', kind: 'ethernet' },
  { long: 'GigabitEthernet', short: 'Gi', kind: 'ethernet' },
  { long: 'TenGigabitEthernet', short: 'Te', kind: 'ethernet' },
  { long: 'FortyGigabitEthernet', short: 'Fo', kind: 'ethernet' },
  { long: 'Internet', short: 'Inet', kind: 'ethernet' },
  { long: 'Serial', short: 'Se', kind: 'serial' },
  { long: 'Console', short: 'Con', kind: 'console' },
  { long: 'Aux', short: 'Aux', kind: 'console' },
  { long: 'Usb', short: 'Usb', kind: 'usb' },
  { long: 'Coax', short: 'Cx', kind: 'coax' },
  { long: 'Phone', short: 'Ph', kind: 'phone' },
  { long: 'Fiber', short: 'Fb', kind: 'fiber-pon' },
  { long: 'Wlan', short: 'Wl', kind: 'wlan' },
  { long: 'Radio', short: 'Rd', kind: 'radio' },
  { long: 'Cellular', short: 'Ce', kind: 'cellular' },
  { long: 'Vlan', short: 'Vl', kind: 'virtual' },
  { long: 'Loopback', short: 'Lo', kind: 'virtual' },
]);

// ── PoE (data now, behaviour P2+) ────────────────────────────────────────────

export type PoeStandard = 'af' | 'at' | 'bt';

/** `pse` sources power (switch port); `pd` draws it (AP, IP phone, camera). */
export interface PoeSpec {
  readonly pse?: { readonly standard: PoeStandard; readonly maxW: number };
  readonly pd?: { readonly standard: PoeStandard; readonly drawW: number };
}

// ── slots and modules (D7) ───────────────────────────────────────────────────

/** Slot id within a model, e.g. '0/0', '0/1', 'exp0'. */
export type SlotId = string;
/** Module catalog id, e.g. 'mod.ehwic-2t'. */
export type ModuleType = string;
export type SlotType = 'ehwic' | 'nim' | 'sfp' | 'sfp+' | 'generic' | 'host-expansion';
export type ModuleFit = 'ehwic' | 'nim' | 'sfp' | 'sfp+' | 'host-expansion';

/** Module fits each slot type accepts. */
export const SLOT_ACCEPTS: Readonly<Record<SlotType, readonly ModuleFit[]>> = Object.freeze({
  ehwic: ['ehwic'],
  nim: ['nim'],
  sfp: ['sfp'],
  'sfp+': ['sfp+', 'sfp'],
  generic: ['ehwic', 'nim'],
  'host-expansion': ['host-expansion'],
});

export const MAX_SLOTS = 8;
/** Fixed ports use MAC/port ordinals 1..127 (ordinal 0 is the device base MAC). */
export const MAX_FIXED_PORT_ORDINAL = 127;
export const MODULE_ORDINAL_BASE = 128;
export const MODULE_PORTS_PER_SLOT = 16;

/** Ordinal of port `portIndex` (0-based within the module) of the module in slot `slotIndex`: 128 + slot×16 + i (≤ 255). */
export function moduleOrdinal(slotIndex: number, portIndex: number): number {
  return MODULE_ORDINAL_BASE + slotIndex * MODULE_PORTS_PER_SLOT + portIndex;
}

export interface SlotSpec {
  readonly id: SlotId;
  /** Original label shown in the Physical panel, e.g. 'EHWIC slot 0'. */
  readonly label: string;
  readonly type: SlotType;
  /** Numbering prefix for generated port names: `${family}${numbering}/${index}` (e.g. '0/1' → Serial0/1/0). */
  readonly numbering: string;
  /** Index among `model.slots` (0..7). */
  readonly slotIndex: number;
  /** SFP/SFP+ cages bind to an existing fixed port; the module becomes that port's `transceiver`. */
  readonly cage?: string;
  /** Installed on a freshly placed device when `AddDeviceSpec.modules` is undefined. */
  readonly defaultModule?: ModuleType;
}

/** One family of ports a module adds. `spec` carries everything except naming/ordinal/slot stamps. */
export interface ModulePortTemplate {
  /** Long family (must exist in PORT_FAMILIES), e.g. 'Serial', 'GigabitEthernet', 'Wlan'. */
  readonly family: string;
  readonly count: number;
  /** First index (default 0). */
  readonly firstIndex?: number;
  /** host-expansion modules: absolute names (`Wlan0`) instead of slot numbering. */
  readonly absolute?: boolean;
  /** Port data; the derived members (role, allowedRoles, connector, encap) default as in `resolvePortSpec`. */
  readonly spec: Omit<PortSpec, 'name' | 'short' | 'ordinal' | 'slot' | 'module' | PortSpecDerived> & Partial<Pick<PortSpec, PortSpecDerived>>;
}

/** PortSpec members `defineModel` / `modulePortSpecs` derive when catalog data leaves them out. */
export type PortSpecDerived = 'role' | 'allowedRoles' | 'connector' | 'encap' | 'ordinal';

/** Optics of an SFP-class module (the link model checks fibre media against it). */
export interface TransceiverSpec {
  readonly connector: 'lc' | 'sc';
  readonly mode: 'mm' | 'sm';
  readonly speedBps: number;
  readonly maxLengthM: number;
  readonly wavelengthNm: number;
}

export interface ModuleModel {
  readonly type: ModuleType;
  /** Display name, e.g. 'NF-EHWIC-2T' (validated /^NF-/). */
  readonly model: string;
  readonly description: string;
  readonly fits: ModuleFit;
  /** Ports added (empty for transceivers). */
  readonly ports: readonly ModulePortTemplate[];
  /** SFP-class modules only. */
  readonly transceiver?: TransceiverSpec;
  /** Capabilities contributed while installed (NF-WLAN-CARD → wifi-client). */
  readonly capabilitiesAdded?: readonly Capability[];
}

/** An installed module (topology + DeviceSpec). */
export interface ModuleInstall {
  readonly slot: SlotId;
  readonly module: ModuleType;
}

/** A family of creatable virtual interfaces (`interface Vlan10`, `interface Loopback0`). */
export interface VirtualFamilySpec {
  /** Long family: 'Vlan' | 'Loopback' (P2 adds 'Port-channel' and the controller's tunnel family). */
  readonly family: string;
  readonly short: string;
  /** 'channel' and 'wlan-tunnel' @since P2. */
  readonly role: 'svi' | 'virtual' | 'channel' | 'wlan-tunnel';
  readonly min: number;
  readonly max: number;
  /** Admin state of a new instance. L2/L3 switch SVIs start down (IOS default, including auto management Vlan1); home-router Vlan1 and loopbacks start up. */
  readonly defaultAdminUp: boolean;
  /** Instances created at construction; they cannot be removed (`no interface Vlan1` → error). */
  readonly auto?: readonly number[];
}

/**
 * @since P2 Subinterface support of a model (routers, multilayer switches): `<parent>.<n>` on ports whose effective
 * role is in `roles` (D11). `defineModel` derives it (W1 catalog).
 */
export interface SubinterfaceSpec {
  /** Derived: ['routed'] when the model has 'routing'. */
  readonly roles: readonly PortRole[];
  /** Highest n (65535). */
  readonly max: number;
}

// ── CLI and GUI descriptors ──────────────────────────────────────────────────

/** What a console shows. 'none' = no console/vty: `cli.open` is refused with CLI_MESSAGES.noShell. */
export type CliShell = 'nfos' | 'host' | 'none';
/** Grammar used by consoles AND by the headless `Simulation.configure` session (D9). */
export type CliGrammar = 'nfos' | 'host';

export interface CliSpec {
  readonly shell: CliShell;
  readonly grammar: CliGrammar;
  /** Privilege at console open (host 15, nfos 1). Headless configure always uses 15. */
  readonly initialPrivilege: PrivilegeLevel;
  /** Access paths offered (empty when shell is 'none'). */
  readonly consoleVia: readonly ('console' | 'vty')[];
}

/**
 * Device GUI panels in display order (the web renders them; ids are data). `desktop.*` panels are
 * Desktop apps of end devices; the others are inspector settings panels. `desktop.web-browser` and
 * `services` arrive in P1; `wlc.controller` (the wireless controller appliance, ARCHITECTURE-P2 D17) @since P2.
 */
export const GUI_PANELS = [
  'physical',
  'desktop.ip-config',
  'desktop.wifi',
  'desktop.cellular',
  'desktop.command-prompt',
  'desktop.web-browser',
  'services',
  'wireless.ap',
  'home-router.setup',
  'radio.link',
  'cell.tower',
  'modem.status',
  // ── P2 (appended) ──
  'wlc.controller',
] as const;
export type GuiPanelId = (typeof GUI_PANELS)[number];

// ── IP defaults ──────────────────────────────────────────────────────────────

/** Per-model IP stack defaults (replace every `kind === 'router'` check in arp/icmpv4). */
export interface IpDefaults {
  /** Originated IPv4 TTL. */
  readonly ttl: number;
  /** Originated IPv6 hop limit (ND messages always use 255). */
  readonly hopLimit: number;
  readonly arpTimeoutNs: SimTime;
  readonly camAgeingNs: SimTime;
}

export const ROUTER_IP_DEFAULTS: IpDefaults = Object.freeze({ ttl: 255, hopLimit: 255, arpTimeoutNs: 4 * HOUR, camAgeingNs: 300 * SEC });
export const HOST_IP_DEFAULTS: IpDefaults = Object.freeze({ ttl: 128, hopLimit: 64, arpTimeoutNs: 20 * MIN, camAgeingNs: 300 * SEC });

/**
 * @since P0.5 The `ipDefaults` rule `defineModel` applies to EXPANDED capabilities: host without routing → HOST,
 * everything else → ROUTER (NF-PC HOST; NF-2911, NF-C2960 and APs ROUTER — the P0 values for P0 models).
 */
export function ipDefaultsFor(caps: readonly Capability[]): IpDefaults {
  return caps.includes('host') && !caps.includes('routing') ? HOST_IP_DEFAULTS : ROUTER_IP_DEFAULTS;
}

// ── daemons ──────────────────────────────────────────────────────────────────

/**
 * Canonical daemon order: demux tie-break, config fan-out order and snapshot order. Every
 * `DeviceModel.processes` list is an order-preserving subsequence (P0 lists already are).
 * Constraints relied upon: arp before ipv4 (gratuitous ARP timer idiom), ipv4 before dhcp-client,
 * udp/tcp before application daemons.
 *
 * P2 (ARCHITECTURE-P2 §2.1, §0 rule 3): a name enters this list only in the change that registers its factory. The
 * W4 catalog flip inserted `vlan`, `dtp`, `etherchannel`, `stp` (after eth-switch: the link-change fan-out flushes
 * the CAM first), `nat` (after ipv4), `hsrp` [S2] and `dhcpv6-client`, `dhcpv6-server` (after udp, which they use).
 * The W6 catalog item inserts `capwap-wtp` (after wlan-client) and `capwap-ac` (last). The relative order of every
 * earlier name is unchanged.
 */
export const PROCESS_ORDER: readonly ProcessName[] = Object.freeze([
  'wlan-ap',
  'wlan-client',
  'cell-client',
  'hdlc',
  'eth-switch',
  'vlan',
  'dtp',
  'etherchannel',
  'stp',
  'arp',
  'ipv4',
  'nat',
  'icmpv4',
  'host',
  'ipv6',
  'nd',
  'icmpv6',
  'udp',
  'tcp',
  'hsrp',
  'dhcp-client',
  'dhcp-server',
  'dhcpv6-client',
  'dhcpv6-server',
  'dns-client',
  'dns-server',
  'http-client',
  'http-server',
  'traceroute',
]);

export interface CapabilityProcess {
  readonly process: ProcessName;
  /** First build stage whose derived catalog includes this daemon for the capability. */
  readonly since: BuildStage;
}

const cp = (process: ProcessName, since: BuildStage): CapabilityProcess => Object.freeze({ process, since });

/**
 * Daemons each capability contributes. `defineModel` takes the union over the model's expanded
 * capabilities, keeps entries with `stageIncluded(since, CATALOG_STAGE)`, and orders them by
 * PROCESS_ORDER. New daemons are silent without configuration (ARCHITECTURE-P1 §4.1 and §5.3, "silence rule"), so
 * adding them never changes P0 scenario traffic.
 */
export const CAPABILITY_PROCESSES: Readonly<Record<Capability, readonly CapabilityProcess[]>> = Object.freeze({
  host: [
    cp('arp', 'P0'), cp('ipv4', 'P0'), cp('icmpv4', 'P0'), cp('host', 'P0'),
    cp('ipv6', 'P1'), cp('nd', 'P1'), cp('icmpv6', 'P1'), cp('udp', 'P1'), cp('tcp', 'P1'),
    cp('dhcp-client', 'P1'), cp('dns-client', 'P1'), cp('http-client', 'P1'), cp('traceroute', 'P1'),
    cp('dhcpv6-client', 'P2'),
  ],
  server: [cp('dhcp-server', 'P1'), cp('dns-server', 'P1'), cp('http-server', 'P1')],
  switching: [cp('eth-switch', 'P0'), cp('arp', 'P1'), cp('ipv4', 'P1'), cp('icmpv4', 'P1'), cp('host', 'P1')],
  routing: [
    cp('hdlc', 'P0.5'), cp('arp', 'P0'), cp('ipv4', 'P0'), cp('icmpv4', 'P0'),
    cp('ipv6', 'P1'), cp('nd', 'P1'), cp('icmpv6', 'P1'), cp('udp', 'P1'), cp('tcp', 'P1'),
    cp('dhcp-client', 'P1'), cp('dhcp-server', 'P1'), cp('dns-client', 'P1'), cp('dns-server', 'P1'),
    cp('http-server', 'P1'), cp('traceroute', 'P1'),
    cp('nat', 'P2'), cp('dhcpv6-client', 'P2'), cp('dhcpv6-server', 'P2'), cp('hsrp', 'P2'),
  ],
  'layer3-switch': [],
  repeater: [],
  'wifi-ap': [cp('wlan-ap', 'P0.5'), cp('eth-switch', 'P0.5'), cp('arp', 'P0.5'), cp('ipv4', 'P0.5'), cp('icmpv4', 'P0.5'), cp('host', 'P0.5')],
  'wifi-client': [cp('wlan-client', 'P0.5')],
  'radio-bridge': [cp('eth-switch', 'P0.5')],
  'cellular-cell': [cp('eth-switch', 'P0.5')],
  'cellular-client': [cp('cell-client', 'P0.5')],
  modem: [cp('eth-switch', 'P0.5')],
  cloud: [cp('eth-switch', 'P0.5')],
  firewall: [],
  // P2: NAT on the home routers stays off until their panel writes the lines (S13); the daemon is silent without them.
  'nat-gateway': [cp('nat', 'P2')],
  'dhcp-server': [cp('udp', 'P1'), cp('dhcp-server', 'P1')],
  'poe-source': [],
  'poe-powered': [],
  modular: [],
  // ── P2 ── A daemon name enters PROCESS_ORDER, CAPABILITY_PROCESSES and the registry only in the change that
  // registers its factory (ARCHITECTURE-P2 §0 rule 3; §2.1 table). The W4 catalog flip added vlan, dtp, etherchannel,
  // stp to managed-switch (and nat, dhcpv6-client, dhcpv6-server, hsrp to routing; dhcpv6-client to host; nat to
  // nat-gateway, above). The W6 catalog item adds capwap-wtp, udp, dhcp-client to lightweight-ap and vlan, udp,
  // capwap-ac to wireless-controller; every P2 row is `since: 'P2'`, so a P0.5/P1-stage model never derives them.
  'managed-switch': [cp('vlan', 'P2'), cp('dtp', 'P2'), cp('etherchannel', 'P2'), cp('stp', 'P2')],
  'lightweight-ap': [],
  'wireless-controller': [],
});

/**
 * @since P0.5 Capabilities that run eth-switch and own a CAM (scope of `show mac address-table` / `clear mac address-table`).
 * `wireless-controller` @since P2 (no model carries it before the W6 catalog item).
 */
export const BRIDGING_CAPABILITIES: readonly Capability[] = Object.freeze(['switching', 'wifi-ap', 'radio-bridge', 'cellular-cell', 'modem', 'cloud', 'wireless-controller']);

// ── P2 L2 control plane (ARCHITECTURE-P2 D5, D6) ─────────────────────────────

/** @since P2 The daemon whose presence makes eth-switch VLAN-aware (D5). */
export const VLAN_AWARE_PROCESS: ProcessName = 'vlan';

/**
 * @since P2 eth-switch classifies VLANs, tags trunks and keys the CAM per VLAN only when this is true (D5). Keyed on
 * the STAGE-DERIVED daemon list, so P0.5/P1-stage models and fixtures are never VLAN-aware.
 */
export function isVlanAware(model: Pick<DeviceModel, 'processes'>): boolean {
  return model.processes.includes(VLAN_AWARE_PROCESS);
}

/**
 * @since P2 Daemons that take part in the L2 change signal (D6), in their final PROCESS_ORDER order. The runtime fans
 * an `l2Changed` action out to `L2_PROCESSES ∩ model.processes` (minus the issuer) in THIS order, so the fan-out never
 * depends on when a name enters PROCESS_ORDER; a name whose factory is not registered yet is on no model and is
 * skipped. 'vtp' is appended in its place only by the C1 item, in the change that registers the vtp factory (§0 rule 3).
 */
export const L2_PROCESSES: readonly ProcessName[] = Object.freeze(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp']);

// ── hardware operations (D7) ─────────────────────────────────────────────────

export type HardwareErrorCode = 'no-such-slot' | 'unknown-module' | 'does-not-fit' | 'powered-on' | 'slot-occupied' | 'slot-empty';

/** Outcome of insert/remove module (never throws for these cases). */
export type HardwareResult = { ok: true } | { ok: false; code: HardwareErrorCode; error: string };

/** Original wording (§1.6). `{model}`, `{slot}`, `{module}`, `{slotType}`, `{device}` are filled by the runtime. */
export const HARDWARE_MESSAGES: Readonly<Record<HardwareErrorCode, string>> = Object.freeze({
  'no-such-slot': '{model} has no slot {slot}.',
  'unknown-module': 'There is no module called {module} in the catalog.',
  'does-not-fit': '{module} does not fit a {slotType} slot.',
  'powered-on': 'Switch {device} off before adding or removing modules; modules are not hot-swappable.',
  'slot-occupied': 'Slot {slot} already holds {module}. Remove it first.',
  'slot-empty': 'Slot {slot} is empty.',
});
