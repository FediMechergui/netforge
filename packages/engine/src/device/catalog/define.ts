/**
 * device/catalog/define.ts — `defineModel`: catalog input → frozen DeviceModel v2 (ARCHITECTURE-P1 D2, D3, D7;
 * docs/CATALOG.md).
 *
 * Catalog data files author a `ModelInput` (identity, category, icon, capabilities, ports, slots). Everything
 * behaviour-relevant is DERIVED here from the contract vocabulary so that no engine or web code ever branches on
 * `kind`:
 *   kind            = type-id prefix ('router.nf2911' → 'router')
 *   capabilities    = expandCapabilities (CAPABILITY_IMPLIES closure, CAPABILITIES order)
 *   processes       = union of CAPABILITY_PROCESSES for the build stage, in PROCESS_ORDER
 *   tables          = cam, arp, rib, then PROCESS_TABLES extras in process order
 *   ipDefaults      = ipDefaultsFor(capabilities)
 *   ipForwarding    = has routing
 *   portsDefaultUp  = not (routing without switching)   (routers and firewalls down; hosts and switches up)
 *   hostnamePrefix  = KIND_HOSTNAME_PREFIX[kind]
 *   bootNs          = CATEGORY_BOOT_NS[category]
 *   cli, gui, virtualFamilies, hostPorts, portOwners (rules on each derive* helper)
 *   per port        : short, role, allowedRoles, encap, ordinal, connector, wiring, group
 * Input values win over derivations where the input type allows them. `defineModel` never throws: the output is
 * checked by `validateCatalog` (validate.ts). Output objects are deeply frozen and structured-clone safe.
 *
 * P2 derivations (ARCHITECTURE-P2 D2, D10, D11, §7 W1 catalog), made ONLY at build stage P2 so that a model or fixture
 * defined at stage P0.5 or P1 is byte-for-byte what it was (no new key, no changed family):
 *   subinterfaces   = {roles: ['routed'], max: 65535} for a model with `routing` (`deriveSubinterfaces`);
 *   virtualFamilies = with `managed-switch`: the Vlan family widened to VLANs 1–4094 (added when absent) and the
 *                     Port-channel family (1–48) after it (`withManagedSwitchFamilies`);
 *   stpDefaultMode  = input, else 'pvst', for a model with `managed-switch`;
 *   profileConfig   = input, else `deriveProfileConfig`: P2 lines `spanning-tree mode <stpDefaultMode>` and
 *                     `spanning-tree extend system-id` for `managed-switch` (plus `no ip routing` with
 *                     `layer3-switch`), `capwap enable` and `interface Vlan1` / ` ip address dhcp` / ` no shutdown`
 *                     for `lightweight-ap`;
 *   portOwners      : ROLE_EGRESS_OWNER also names `etherchannel` for `channel` and `capwap-ac` for `wlan-tunnel`.
 */
import type { DeviceKind, DeviceModel } from '../../contracts/device.js';
import type { PortId, ProcessName } from '../../contracts/ids.js';
import type { PortKind, PortSpec } from '../../contracts/port.js';
import { PROCESS_TABLES, type TableName } from '../../contracts/tables.js';
import { SEC, type SimTime } from '../../contracts/time.js';
import {
  CAPABILITY_PROCESSES,
  DEFAULTS_PROFILES,
  GUI_PANELS,
  KIND_CONNECTOR,
  KIND_ENCAP,
  PORT_ROLES,
  PROCESS_ORDER,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  defaultRoleFor,
  expandCapabilities,
  ipDefaultsFor,
  moduleOrdinal,
  stageIncluded,
  type BuildStage,
  type Capability,
  type CliSpec,
  type DefaultsProfile,
  type DeviceCategory,
  type DeviceIconId,
  type GuiPanelId,
  type ModuleModel,
  type ModulePortTemplate,
  type PortRole,
  type SlotSpec,
  type SubinterfaceSpec,
  type VirtualFamilySpec,
  type PortSpecDerived,
} from '../../contracts/catalog.js';
import { deepFreeze } from './module-define.js';
import { MODULE_MODELS } from './modules.js';
import { modulePortName, portFamilyByLong, shortPortName, virtualPortName } from './names.js';

export { deepFreeze, defineModule } from './module-define.js';

// ── defaults tables ──────────────────────────────────────────────────────────

/**
 * Default hostname prefix per icon family (original wording). The key set is also the runtime list of valid
 * `DeviceKind` values used by validation.
 */
export const KIND_HOSTNAME_PREFIX: Readonly<Record<DeviceKind, string>> = Object.freeze({
  pc: 'PC',
  switch: 'Switch',
  router: 'Router',
  hub: 'Hub',
  laptop: 'Laptop',
  server: 'Server',
  phone: 'Phone',
  tablet: 'Tablet',
  ipphone: 'IPPhone',
  printer: 'Printer',
  tv: 'TV',
  iot: 'IoT',
  mlswitch: 'MLSwitch',
  dcswitch: 'DCSwitch',
  repeater: 'Repeater',
  bridge: 'Bridge',
  firewall: 'Firewall',
  ids: 'Sensor',
  ap: 'AP',
  wlc: 'WLC',
  wrouter: 'HomeRouter',
  radio: 'Radio',
  cell: 'Tower',
  modem: 'Modem',
  csu: 'CSU',
  cloud: 'Cloud',
});

/** Every valid `DeviceKind`, in KIND_HOSTNAME_PREFIX order. */
export const DEVICE_KINDS: readonly DeviceKind[] = Object.freeze(Object.keys(KIND_HOSTNAME_PREFIX) as DeviceKind[]);

/** Default power-on-to-forwarding time per palette category (P0 values for computers, switches and routers). */
export const CATEGORY_BOOT_NS: Readonly<Record<DeviceCategory, SimTime>> = Object.freeze({
  routers: 45 * SEC,
  switches: 30 * SEC,
  'multilayer-switches': 40 * SEC,
  'data-centre': 60 * SEC,
  legacy: 2 * SEC,
  security: 50 * SEC,
  wireless: 20 * SEC,
  'home-soho': 15 * SEC,
  radios: 10 * SEC,
  'wan-isp': 5 * SEC,
  computers: 2 * SEC,
  servers: 5 * SEC,
  mobile: 3 * SEC,
  voice: 5 * SEC,
  peripherals: 3 * SEC,
  iot: 2 * SEC,
});

/** First build stage in which each GUI panel exists (GUI_PANELS doc: browser and services arrive in P1). */
export const GUI_PANEL_SINCE: Readonly<Record<GuiPanelId, BuildStage>> = Object.freeze({
  physical: 'P0',
  'desktop.ip-config': 'P0.5',
  'desktop.wifi': 'P0.5',
  'desktop.cellular': 'P0.5',
  'desktop.command-prompt': 'P0.5',
  'desktop.web-browser': 'P1',
  services: 'P1',
  'wireless.ap': 'P0.5',
  'home-router.setup': 'P0.5',
  'radio.link': 'P0.5',
  'cell.tower': 'P0.5',
  'modem.status': 'P0.5',
  // P2 (ARCHITECTURE-P2 §2.1, D17): the wireless controller appliance's panel.
  'wlc.controller': 'P2',
});

/** Loopback family derived for routing devices (except home routers). */
export const LOOPBACK_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Loopback',
  short: 'Lo',
  role: 'virtual',
  min: 0,
  max: 2147483647,
  defaultAdminUp: true,
});

/** SVI family derived for multilayer switches: auto management Vlan1, administratively down (IOS-like default). */
export const L3_SWITCH_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 4094,
  defaultAdminUp: false,
  auto: Object.freeze([1]),
});

/**
 * Management SVI family of a device that bridges but does not route (L2 access switch, learning bridge, AP): the
 * auto `Vlan1` carries the management address and is administratively down until `no shutdown`, so a freshly placed
 * device still sends nothing of its own (silence rule, §9.2 "P1 W5 (catalog)").
 */
export const MANAGEMENT_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 1,
  defaultAdminUp: false,
  auto: Object.freeze([1]),
});

/** SVI family derived for home routers: the auto LAN Vlan1 routes towards the WAN and starts up (D3). */
export const HOME_ROUTER_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 1,
  defaultAdminUp: true,
  auto: Object.freeze([1]),
});

/**
 * SVI family derived for routers whose slots accept a switch module (D3, D7): Vlan1 only, no auto instance (the
 * chassis without the module keeps its port list), administratively down. Creating it needs `switching` at run
 * time, i.e. the module installed (device.ts `ensureVirtualPort`).
 */
export const MODULE_SWITCH_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 1,
  defaultAdminUp: false,
});

/**
 * Process that owns egress of each role whose trait egress is 'owner' (P0.5: SVIs belong to the bridge; P2: a
 * Port-channel belongs to `etherchannel` (D10), the controller tunnel `Capwap0` to `capwap-ac` (D17)).
 */
export const ROLE_EGRESS_OWNER: Readonly<Partial<Record<PortRole, ProcessName>>> = Object.freeze({
  svi: 'eth-switch',
  channel: 'etherchannel',
  'wlan-tunnel': 'capwap-ac',
});

/**
 * @since P2 SVI family of a managed (VLAN-aware) switch (§9.2 W4 item 15): VLANs 1–4094, auto management Vlan1,
 * administratively down. `withManagedSwitchFamilies` widens a narrower Vlan family to this range.
 */
export const MANAGED_SWITCH_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 4094,
  defaultAdminUp: false,
  auto: Object.freeze([1]),
});

/**
 * @since P2 EtherChannel bundles of a managed switch (D10): `interface Port-channelN`, short `Po`, 1–48, role
 * `channel`, created up (a bundle is up while one of its bundled members is).
 */
export const PORT_CHANNEL_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Port-channel',
  short: 'Po',
  role: 'channel',
  min: 1,
  max: 48,
  defaultAdminUp: true,
});

/** @since P2 Highest subinterface number (`<parent>.<n>`, D11). */
export const SUBINTERFACE_MAX = 65535;

/** @since P2 Default spanning-tree mode of a managed switch when its data names none (D3). */
export const DEFAULT_STP_MODE: NonNullable<DeviceModel['stpDefaultMode']> = 'pvst';

// ── input types ──────────────────────────────────────────────────────────────

/**
 * A port as authored in catalog data: a PortSpec whose short name (PORT_FAMILIES) and derived members (role,
 * allowedRoles, connector, encap, ordinal; see `resolvePortSpec`) may be omitted.
 */
export type PortInput = Omit<PortSpec, 'short' | PortSpecDerived> & { short?: string } & Partial<Pick<PortSpec, PortSpecDerived>>;

/** A slot as authored in catalog data: `slotIndex` defaults to the slot's position in the list. */
export type SlotInput = Omit<SlotSpec, 'slotIndex'> & { slotIndex?: number };

/** Catalog data for one device model (see the file header for every derived field). */
export interface ModelInput {
  /** `<kind>.<model>`; the prefix becomes `DeviceModel.kind`. */
  readonly type: string;
  /** Display name `NF-…`. */
  readonly model: string;
  readonly description: string;
  readonly category: DeviceCategory;
  readonly icon: DeviceIconId;
  /** Declared capabilities (the closure is derived). */
  readonly capabilities: readonly Capability[];
  /** Fixed ports in canonical order. */
  readonly ports: readonly PortInput[];
  /** Palette variant grouping key; default: the model name lowercased. */
  readonly family?: string;
  /** Variant label inside the family; default: the model name. */
  readonly variant?: string;
  /** Search tags; lowercased and de-duplicated. */
  readonly tags?: readonly string[];
  readonly slots?: readonly SlotInput[];
  /** Replaces the derived virtual families when present. */
  readonly virtualFamilies?: readonly VirtualFamilySpec[];
  readonly hostnamePrefix?: string;
  readonly bootNs?: SimTime;
  readonly portsDefaultUp?: boolean;
  readonly ipForwarding?: boolean;
  readonly defaultConfig?: readonly string[];
  /** Replaces the derived CLI spec when present. */
  readonly cli?: CliSpec;
  /** Replaces the derived GUI panel list when present. */
  readonly gui?: readonly GuiPanelId[];
  /** Replaces the derived host adapter list when present. */
  readonly hostPorts?: readonly PortId[];
  readonly poeBudgetW?: number;
  /** @since P2 Replaces the derived profile lines when present (used at stage P2 only). */
  readonly profileConfig?: Readonly<Partial<Record<DefaultsProfile, readonly string[]>>>;
  /** @since P2 Spanning-tree mode of a managed switch (NF-C9300: 'rapid-pvst'); default 'pvst' (stage P2 only). */
  readonly stpDefaultMode?: 'pvst' | 'rapid-pvst';
  /** @since P2 Replaces the derived subinterface support when present (stage P2 only). */
  readonly subinterfaces?: SubinterfaceSpec;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Icon/palette family of a type id: the text before the first dot (may be an invalid kind; validation reports it). */
export function kindOfType(type: string): DeviceKind {
  const dot = type.indexOf('.');
  return (dot < 0 ? type : type.slice(0, dot)) as DeviceKind;
}

/** Daemons of an EXPANDED capability list for a build stage, in PROCESS_ORDER. */
export function deriveProcesses(caps: readonly Capability[], stage: BuildStage): readonly ProcessName[] {
  const wanted = new Set<ProcessName>();
  for (const cap of caps) {
    for (const entry of CAPABILITY_PROCESSES[cap] ?? []) {
      if (stageIncluded(entry.since, stage)) wanted.add(entry.process);
    }
  }
  return PROCESS_ORDER.filter((p) => wanted.has(p));
}

/** Tables a device owns: cam, arp, rib, then the PROCESS_TABLES extras of `processes` in process order. */
export function deriveTables(processes: readonly ProcessName[]): readonly TableName[] {
  const out: TableName[] = ['cam', 'arp', 'rib'];
  for (const p of processes) {
    for (const t of PROCESS_TABLES[p] ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * CLI spec from EXPANDED capabilities:
 *  nat-gateway (home router)                      → shell none, grammar nfos (GUI-only appliance, headless configure works)
 *  host without routing                           → host shell, privilege 15, console
 *  routing | switching | wifi-ap                  → nfos shell, privilege 1, console + vty
 *  otherwise (repeater, modem, cloud, radio, tower)→ shell none, grammar nfos
 */
export function deriveCliSpec(caps: readonly Capability[]): CliSpec {
  const has = (c: Capability): boolean => caps.includes(c);
  if (has('nat-gateway')) return { shell: 'none', grammar: 'nfos', initialPrivilege: 1, consoleVia: [] };
  if (has('host') && !has('routing')) return { shell: 'host', grammar: 'host', initialPrivilege: 15, consoleVia: ['console'] };
  if (has('routing') || has('switching') || has('wifi-ap')) {
    return { shell: 'nfos', grammar: 'nfos', initialPrivilege: 1, consoleVia: ['console', 'vty'] };
  }
  return { shell: 'none', grammar: 'nfos', initialPrivilege: 1, consoleVia: [] };
}

/**
 * GUI panels in GUI_PANELS order, keeping only panels that exist in `stage`:
 *  physical always; desktop.ip-config and desktop.web-browser for host; desktop.wifi for wifi-client;
 *  desktop.cellular for cellular-client; desktop.command-prompt for a host shell; services for server;
 *  wireless.ap for wifi-ap without nat-gateway; home-router.setup for nat-gateway; radio.link for radio-bridge;
 *  cell.tower for cellular-cell; modem.status for modem; wlc.controller (P2) for wireless-controller.
 */
export function deriveGui(caps: readonly Capability[], cli: CliSpec, stage: BuildStage): readonly GuiPanelId[] {
  const has = (c: Capability): boolean => caps.includes(c);
  const want: Record<GuiPanelId, boolean> = {
    physical: true,
    'desktop.ip-config': has('host'),
    'desktop.wifi': has('wifi-client'),
    'desktop.cellular': has('cellular-client'),
    'desktop.command-prompt': cli.shell === 'host',
    'desktop.web-browser': has('host'),
    services: has('server'),
    'wireless.ap': has('wifi-ap') && !has('nat-gateway'),
    'home-router.setup': has('nat-gateway'),
    'radio.link': has('radio-bridge'),
    'cell.tower': has('cellular-cell'),
    'modem.status': has('modem'),
    'wlc.controller': has('wireless-controller'),
  };
  return GUI_PANELS.filter((id) => want[id] && stageIncluded(GUI_PANEL_SINCE[id], stage));
}

/**
 * Creatable virtual interface families from EXPANDED capabilities, in PORT_FAMILIES order (Vlan before Loopback):
 * multilayer switches get L3_SWITCH_VLAN_FAMILY; home routers (nat-gateway with switching) get
 * HOME_ROUTER_VLAN_FAMILY; an access point that neither routes nor NATs gets MANAGEMENT_VLAN_FAMILY, the same
 * management SVI the L2 switches carry as catalog data (P1 W5), because it boots the same host stack and its §6
 * `ip default-gateway` line is useless without an addressable interface; routing devices other than home routers
 * get LOOPBACK_FAMILY.
 */
export function deriveVirtualFamilies(caps: readonly Capability[]): readonly VirtualFamilySpec[] {
  const has = (c: Capability): boolean => caps.includes(c);
  const out: VirtualFamilySpec[] = [];
  if (has('layer3-switch')) out.push(L3_SWITCH_VLAN_FAMILY);
  else if (has('nat-gateway') && has('switching')) out.push(HOME_ROUTER_VLAN_FAMILY);
  else if (has('wifi-ap')) out.push(MANAGEMENT_VLAN_FAMILY);
  if (has('routing') && !has('nat-gateway')) out.push(LOOPBACK_FAMILY);
  return out;
}

// ── P2 derivations (stage P2 only; ARCHITECTURE-P2 D2, D10, D11) ────────────

/** @since P2 Subinterface support from EXPANDED capabilities: `{roles: ['routed'], max: 65535}` with `routing`. */
export function deriveSubinterfaces(caps: readonly Capability[]): SubinterfaceSpec | undefined {
  return caps.includes('routing') ? { roles: ['routed'], max: SUBINTERFACE_MAX } : undefined;
}

/**
 * @since P2 Virtual families of a `managed-switch` model (other models: `families` unchanged): the Vlan family widened
 * to MANAGED_SWITCH_VLAN_FAMILY's range (its other members kept; MANAGED_SWITCH_VLAN_FAMILY first when there is
 * none), then PORT_CHANNEL_FAMILY right after the Vlan family unless the list already has a Port-channel family.
 */
export function withManagedSwitchFamilies(caps: readonly Capability[], families: readonly VirtualFamilySpec[]): readonly VirtualFamilySpec[] {
  if (!caps.includes('managed-switch')) return families;
  const out: VirtualFamilySpec[] = [];
  let vlanAt = -1;
  for (const f of families) {
    if (f.family === 'Vlan' && vlanAt < 0) {
      vlanAt = out.length;
      out.push(f.max >= MANAGED_SWITCH_VLAN_FAMILY.max ? f : { ...f, max: MANAGED_SWITCH_VLAN_FAMILY.max });
    } else {
      out.push(f);
    }
  }
  if (vlanAt < 0) {
    out.unshift(MANAGED_SWITCH_VLAN_FAMILY);
    vlanAt = 0;
  }
  if (!out.some((f) => f.family === PORT_CHANNEL_FAMILY.family)) out.splice(vlanAt + 1, 0, PORT_CHANNEL_FAMILY);
  return out;
}

/** @since P2 Spanning-tree mode a `managed-switch` model boots with in a P2 world (`input` wins); undefined otherwise. */
export function deriveStpDefaultMode(caps: readonly Capability[], input?: 'pvst' | 'rapid-pvst'): 'pvst' | 'rapid-pvst' | undefined {
  return caps.includes('managed-switch') ? (input ?? DEFAULT_STP_MODE) : undefined;
}

/**
 * @since P2 Visible defaults replayed at boot in a P2 world (D2, §4.4), as config text lines (indented lines belong to
 * the section above them, like `defaultConfig`). Key 'P2':
 *  - `managed-switch`: `spanning-tree mode <mode>`, `spanning-tree extend system-id`, plus `no ip routing` with
 *    `layer3-switch` (routing is off on a multilayer switch until `ip routing`, §3.5);
 *  - `lightweight-ap`: `capwap enable`, then `interface Vlan1` / ` ip address dhcp` / ` no shutdown`.
 * Undefined when a model has none.
 */
export function deriveProfileConfig(
  caps: readonly Capability[],
  stpDefaultMode: 'pvst' | 'rapid-pvst' | undefined,
): Readonly<Partial<Record<DefaultsProfile, readonly string[]>>> | undefined {
  const p2: string[] = [];
  if (caps.includes('managed-switch')) {
    p2.push(`spanning-tree mode ${stpDefaultMode ?? DEFAULT_STP_MODE}`, 'spanning-tree extend system-id');
    if (caps.includes('layer3-switch')) p2.push('no ip routing');
  }
  if (caps.includes('lightweight-ap')) p2.push('capwap enable', 'interface Vlan1', ' ip address dhcp', ' no shutdown');
  return p2.length === 0 ? undefined : { P2: p2 };
}

/**
 * Modules that fit at least one of `slots` (SLOT_ACCEPTS), in `modules` order.
 */
export function modulesFitting(slots: readonly Pick<SlotSpec, 'type'>[], modules: readonly ModuleModel[] = MODULE_MODELS): readonly ModuleModel[] {
  return modules.filter((m) => slots.some((s) => (SLOT_ACCEPTS[s.type] ?? []).includes(m.fits)));
}

/**
 * Daemons a module fitting `slots` can add on top of the model's own (union over the fitting modules of
 * deriveProcesses(model caps + capabilitiesAdded)), in first-seen order, excluding `processes`.
 */
export function moduleReachableProcesses(
  caps: readonly Capability[],
  slots: readonly Pick<SlotSpec, 'type'>[],
  processes: readonly ProcessName[],
  stage: BuildStage,
  modules: readonly ModuleModel[] = MODULE_MODELS,
): readonly ProcessName[] {
  const out: ProcessName[] = [];
  for (const m of modulesFitting(slots, modules)) {
    if ((m.capabilitiesAdded ?? []).length === 0) continue;
    for (const p of deriveProcesses(expandCapabilities([...caps, ...(m.capabilitiesAdded ?? [])]), stage)) {
      if (!processes.includes(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Virtual families a switch module adds to a router's creatable list: MODULE_SWITCH_VLAN_FAMILY (before any
 * Loopback, PORT_FAMILIES order) when the model routes, is neither a multilayer switch nor a home router, and one of
 * its slots accepts a module whose capabilitiesAdded include `switching`. Otherwise `families` unchanged.
 */
export function withModuleSwitchFamilies(
  caps: readonly Capability[],
  slots: readonly Pick<SlotSpec, 'type'>[],
  families: readonly VirtualFamilySpec[],
  modules: readonly ModuleModel[] = MODULE_MODELS,
): readonly VirtualFamilySpec[] {
  if (!caps.includes('routing') || caps.includes('layer3-switch') || caps.includes('nat-gateway')) return families;
  if (families.some((f) => f.family === 'Vlan')) return families;
  if (!modulesFitting(slots, modules).some((m) => (m.capabilitiesAdded ?? []).includes('switching'))) return families;
  const at = families.findIndex((f) => f.family === 'Loopback');
  const out = [...families];
  out.splice(at < 0 ? out.length : at, 0, MODULE_SWITCH_VLAN_FAMILY);
  return out;
}

/**
 * Host adapters in preference order: empty unless the device has `host`; otherwise every fixed port whose role
 * holds L3 addresses (in port order), then the auto instances of the virtual families (family order, ascending).
 */
export function deriveHostPorts(caps: readonly Capability[], ports: readonly PortSpec[], families: readonly VirtualFamilySpec[]): readonly PortId[] {
  if (!caps.includes('host')) return [];
  const out: PortId[] = [];
  for (const p of ports) {
    const role = p.role ?? defaultRoleFor(p.kind, caps);
    if (ROLE_TRAITS[role].l3 && !ROLE_TRAITS[role].virtual) out.push(p.name);
  }
  for (const fam of families) {
    for (const n of [...(fam.auto ?? [])].sort((a, b) => a - b)) out.push(virtualPortName(fam, n));
  }
  return out;
}

/**
 * Egress owners: for every role with trait egress 'owner' that appears on a fixed port (role or allowed role) or a
 * virtual family, ROLE_EGRESS_OWNER[role] when that daemon is in `processes` or in `moduleProcesses` (daemons an
 * installable module adds, e.g. eth-switch from a router's switch module). Roles without an owner are left out
 * (validation reports them).
 */
export function derivePortOwners(
  ports: readonly PortSpec[],
  families: readonly VirtualFamilySpec[],
  processes: readonly ProcessName[],
  moduleProcesses: readonly ProcessName[] = [],
): Readonly<Partial<Record<PortRole, ProcessName>>> {
  const present = new Set<PortRole>();
  for (const p of ports) {
    if (p.role) present.add(p.role);
    for (const r of p.allowedRoles ?? []) present.add(r);
  }
  for (const f of families) present.add(f.role);
  const out: Partial<Record<PortRole, ProcessName>> = {};
  for (const role of PORT_ROLES) {
    if (!present.has(role) || ROLE_TRAITS[role].egress !== 'owner') continue;
    const owner = ROLE_EGRESS_OWNER[role];
    if (owner !== undefined && (processes.includes(owner) || moduleProcesses.includes(owner))) out[role] = owner;
  }
  return out;
}

/** Default port-picker group of a port kind. */
function defaultGroup(kind: PortKind): string | undefined {
  switch (kind) {
    case 'console':
    case 'usb':
      return 'console';
    case 'wlan':
    case 'radio':
    case 'cellular':
      return 'radio';
    case 'virtual':
      return undefined;
    default:
      return 'front';
  }
}

/**
 * Resolve one port against EXPANDED capabilities: short (PORT_FAMILIES), role (defaultRoleFor), allowedRoles
 * ([switched, routed] for switched ports of multilayer switches, else [role]), encap (KIND_ENCAP), ordinal,
 * connector (KIND_CONNECTOR), wiring (ROLE_TRAITS wiring for RJ45 ethernet) and group. Given values win.
 */
export function resolvePortSpec(input: PortInput, defaultOrdinal: number, caps: readonly Capability[]): PortSpec {
  const role = input.role ?? defaultRoleFor(input.kind, caps);
  const connector = input.connector ?? KIND_CONNECTOR[input.kind];
  const allowedRoles: readonly PortRole[] = input.allowedRoles ?? (role === 'switched' && caps.includes('layer3-switch') ? ['switched', 'routed'] : [role]);
  const out: PortSpec = {
    ...input,
    name: input.name,
    short: input.short ?? shortPortName(input.name) ?? input.name,
    kind: input.kind,
    speedBps: input.speedBps,
    role,
    allowedRoles: [...allowedRoles],
    encap: input.encap ?? KIND_ENCAP[input.kind],
    ordinal: input.ordinal ?? defaultOrdinal,
    connector,
  };
  const wiring = input.wiring ?? (input.kind === 'ethernet' && connector === 'rj45' ? ROLE_TRAITS[role].wiring : null);
  if (wiring) out.wiring = wiring;
  const group = input.group ?? defaultGroup(input.kind);
  if (group !== undefined) out.group = group;
  return out;
}

// ── models and modules ───────────────────────────────────────────────────────

/**
 * Build a frozen DeviceModel v2 from catalog data for build stage `stage` (the catalog index passes
 * CATALOG_STAGE). Every `@since P0.5` member is filled; `poeBudgetW` only when given. `modules` is the module list
 * the model's slots draw from (default MODULE_MODELS): a switch module there gives a router its Vlan family and SVI
 * owner. Pass the same list to `validateCatalog`.
 */
export function defineModel(input: ModelInput, stage: BuildStage, modules: readonly ModuleModel[] = MODULE_MODELS): DeviceModel {
  const kind = kindOfType(input.type);
  const capabilities = expandCapabilities(input.capabilities);
  const has = (c: Capability): boolean => capabilities.includes(c);
  const processes = deriveProcesses(capabilities, stage);
  const ports = input.ports.map((p, i) => resolvePortSpec(p, i + 1, capabilities));
  const slots: SlotSpec[] = (input.slots ?? []).map((s, i) => ({ ...s, slotIndex: s.slotIndex ?? i }));
  const p2 = stageIncluded('P2', stage);
  const baseFamilies = input.virtualFamilies ?? withModuleSwitchFamilies(capabilities, slots, deriveVirtualFamilies(capabilities), modules);
  const virtualFamilies = p2 ? withManagedSwitchFamilies(capabilities, baseFamilies) : baseFamilies;
  const moduleProcesses = moduleReachableProcesses(capabilities, slots, processes, stage, modules);
  const cli = input.cli ?? deriveCliSpec(capabilities);
  const tags: string[] = [];
  for (const t of input.tags ?? []) {
    const lower = t.trim().toLowerCase();
    if (lower !== '' && !tags.includes(lower)) tags.push(lower);
  }
  const model: DeviceModel = {
    type: input.type,
    model: input.model,
    kind,
    description: input.description,
    ports,
    processes,
    hostnamePrefix: input.hostnamePrefix ?? KIND_HOSTNAME_PREFIX[kind] ?? 'Device',
    portsDefaultUp: input.portsDefaultUp ?? !(has('routing') && !has('switching')),
    bootNs: input.bootNs ?? CATEGORY_BOOT_NS[input.category] ?? 0,
    ipForwarding: input.ipForwarding ?? has('routing'),
    processingNs: 0,
    category: input.category,
    family: input.family ?? input.model.toLowerCase(),
    variant: input.variant ?? input.model,
    icon: input.icon,
    tags,
    capabilities,
    cli: { ...cli, consoleVia: [...cli.consoleVia] },
    gui: [...(input.gui ?? deriveGui(capabilities, cli, stage))],
    slots,
    virtualFamilies: virtualFamilies.map((f) => ({ ...f, ...(f.auto ? { auto: [...f.auto] } : {}) })),
    hostPorts: [...(input.hostPorts ?? deriveHostPorts(capabilities, ports, virtualFamilies))],
    portOwners: derivePortOwners(ports, virtualFamilies, processes, moduleProcesses),
    tables: deriveTables(processes),
    ipDefaults: { ...ipDefaultsFor(capabilities) },
  };
  if (input.defaultConfig !== undefined) model.defaultConfig = [...input.defaultConfig];
  if (input.poeBudgetW !== undefined) model.poeBudgetW = input.poeBudgetW;
  if (p2) {
    // P2 members are added only when they apply, so a model they do not concern keeps exactly its P1 keys.
    const subinterfaces = input.subinterfaces ?? deriveSubinterfaces(capabilities);
    if (subinterfaces !== undefined) model.subinterfaces = { roles: [...subinterfaces.roles], max: subinterfaces.max };
    const stpDefaultMode = deriveStpDefaultMode(capabilities, input.stpDefaultMode);
    if (stpDefaultMode !== undefined) model.stpDefaultMode = stpDefaultMode;
    const profileConfig = input.profileConfig ?? deriveProfileConfig(capabilities, stpDefaultMode);
    if (profileConfig !== undefined) {
      const copy: Partial<Record<DefaultsProfile, readonly string[]>> = {};
      for (const k of DEFAULTS_PROFILES) {
        const lines = profileConfig[k];
        if (lines !== undefined) copy[k] = [...lines];
      }
      model.profileConfig = copy;
    }
  }
  return deepFreeze(model);
}

/**
 * Ports the module `module` adds when installed in `slot` of `model` (D7), in template order:
 * name `${family}${numbering}/${index}` (or absolute `${family}${index}`), short from PORT_FAMILIES, ordinal
 * `moduleOrdinal(slot.slotIndex, i)` with i counting across templates, role and the other per-port fields resolved
 * against the model capabilities plus the module's `capabilitiesAdded`, `slot`, `module` and group `slot:<id>`.
 * Transceiver modules add no ports (they become the cage port's `transceiver`).
 */
export function modulePortSpecs(model: Pick<DeviceModel, 'capabilities'>, slot: SlotSpec, module: ModuleModel): readonly PortSpec[] {
  const caps = expandCapabilities([...(model.capabilities ?? []), ...(module.capabilitiesAdded ?? [])]);
  const out: PortSpec[] = [];
  let i = 0;
  for (const template of module.ports) {
    for (let k = 0; k < template.count; k++) {
      const index = (template.firstIndex ?? 0) + k;
      out.push(modulePort(template, slot, module, index, moduleOrdinal(slot.slotIndex, i), caps));
      i++;
    }
  }
  return out;
}

function modulePort(template: ModulePortTemplate, slot: SlotSpec, module: ModuleModel, index: number, ordinal: number, caps: readonly Capability[]): PortSpec {
  const name = modulePortName(template.family, slot, index, template.absolute === true);
  const fam = portFamilyByLong(template.family);
  const input: PortInput = {
    ...template.spec,
    name,
    short: fam ? `${fam.short}${name.slice(template.family.length)}` : name,
    ordinal,
    slot: slot.id,
    module: module.type,
    group: template.spec.group ?? `slot:${slot.id}`,
  };
  return resolvePortSpec(input, ordinal, caps);
}
