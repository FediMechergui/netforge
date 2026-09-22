/**
 * Device presentation vocabulary: palette categories and their groups, capability names and search words,
 * GUI panel names, port role and port kind labels (ARCHITECTURE-P1 §7, D2, D3; replaces the raw
 * `device.kind` text the P0 inspector showed, §9.3).
 *
 * Category labels and order come from the engine's `DEVICE_CATEGORIES`, so the palette and the catalog can
 * never disagree; this file only adds hints. Tables are exhaustive over the engine unions. All wording is
 * original (§1.6).
 */
import { CAPABILITIES, DEVICE_CATEGORIES, GUI_PANELS, ROLE_TRAITS } from '@netforge/engine';
import type { Capability, CategoryGroup, DeviceCategory, GuiPanelId, PortKind, PortRole } from '@netforge/engine';

/** Presentation data for one palette category. */
export interface CategoryVocab {
  readonly id: DeviceCategory;
  readonly label: string;
  readonly group: CategoryGroup;
  /** Position in palette order. */
  readonly order: number;
  /** Tooltip sentence. */
  readonly hint: string;
}

const CATEGORY_HINTS: Readonly<Record<DeviceCategory, string>> = Object.freeze({
  routers: 'Forward packets between networks; some take extra interface modules.',
  switches: 'Connect many wired devices inside one network.',
  'multilayer-switches': 'Switches whose ports can also route between networks.',
  'data-centre': 'High-speed leaf and spine switches for server racks.',
  legacy: 'Hubs, repeaters, coax taps and bridges from earlier Ethernet.',
  security: 'Firewalls and traffic sensors.',
  wireless: 'Access points and wireless controllers.',
  'home-soho': 'All-in-one routers and devices for homes and small offices.',
  radios: 'Point-to-point radio bridges and mobile network towers.',
  'wan-isp': 'Modems, line units and the provider network.',
  computers: 'Desktop and laptop computers.',
  servers: 'Machines that offer network services.',
  mobile: 'Phones and tablets.',
  voice: 'Telephones that run over the network.',
  peripherals: 'Printers and other shared devices.',
  iot: 'Sensors, cameras and other small connected things.',
});

/** Every category in palette order, exhaustive over `DeviceCategory`. */
export const CATEGORY_VOCAB: Readonly<Record<DeviceCategory, CategoryVocab>> = Object.freeze(
  Object.fromEntries(
    DEVICE_CATEGORIES.map((c, order) => [c.id, Object.freeze({ id: c.id, label: c.label, group: c.group, order, hint: CATEGORY_HINTS[c.id] })]),
  ) as Record<DeviceCategory, CategoryVocab>,
);

/** Categories in palette order. */
export const CATEGORY_ORDER: readonly DeviceCategory[] = Object.freeze(DEVICE_CATEGORIES.map((c) => c.id));

/** Presentation data for a category group. */
export interface CategoryGroupVocab {
  readonly id: CategoryGroup;
  readonly label: string;
  readonly order: number;
}

/** Category groups, exhaustive over `CategoryGroup`. */
export const CATEGORY_GROUP_VOCAB: Readonly<Record<CategoryGroup, CategoryGroupVocab>> = Object.freeze({
  network: Object.freeze({ id: 'network', label: 'Network devices', order: 0 }),
  'end-devices': Object.freeze({ id: 'end-devices', label: 'End devices', order: 1 }),
});

/** Label used for devices without a category (hand-built fixtures, unknown ids). */
export const UNCATEGORISED_LABEL = 'Uncategorised';

/** True when `id` names a palette category. */
export function isDeviceCategory(id: string): id is DeviceCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_VOCAB, id);
}

/** Display label of a category (UNCATEGORISED_LABEL when absent or unknown). */
export function categoryLabel(id: string | undefined): string {
  return id !== undefined && isDeviceCategory(id) ? CATEGORY_VOCAB[id].label : UNCATEGORISED_LABEL;
}

/** Categories of one group in palette order. */
export function categoriesInGroup(group: CategoryGroup): readonly DeviceCategory[] {
  return CATEGORY_ORDER.filter((c) => CATEGORY_VOCAB[c].group === group);
}

// ── capabilities ─────────────────────────────────────────────────────────────

/** Presentation data for one capability. */
export interface CapabilityVocab {
  readonly capability: Capability;
  readonly label: string;
  /** Lower-case words palette search matches against. */
  readonly words: readonly string[];
}

function cap(capability: Capability, label: string, words: readonly string[]): CapabilityVocab {
  return Object.freeze({ capability, label, words: Object.freeze([...words]) });
}

/** Every capability, exhaustive over `Capability` (search words drive palette search). */
export const CAPABILITY_VOCAB: Readonly<Record<Capability, CapabilityVocab>> = Object.freeze({
  host: cap('host', 'End system', ['host', 'end device', 'computer', 'client', 'ip stack']),
  server: cap('server', 'Server', ['server', 'services', 'hosting']),
  switching: cap('switching', 'Switching', ['switch', 'switching', 'bridge', 'layer 2', 'mac table']),
  routing: cap('routing', 'Routing', ['router', 'routing', 'gateway', 'layer 3', 'forwarding']),
  'layer3-switch': cap('layer3-switch', 'Multilayer switching', ['multilayer', 'layer 3 switch', 'routed port', 'svi']),
  repeater: cap('repeater', 'Repeating', ['hub', 'repeater', 'collision', 'shared medium']),
  'wifi-ap': cap('wifi-ap', 'Wireless access point', ['wireless', 'wi-fi', 'wifi', 'access point', 'ssid']),
  'wifi-client': cap('wifi-client', 'Wireless client', ['wireless', 'wi-fi', 'wifi', 'wireless adapter']),
  'radio-bridge': cap('radio-bridge', 'Radio bridge', ['radio', 'point-to-point', 'microwave link', 'bridge']),
  'cellular-cell': cap('cellular-cell', 'Mobile network tower', ['cellular', 'mobile network', 'tower', 'lte', '5g']),
  'cellular-client': cap('cellular-client', 'Mobile data', ['cellular', 'mobile data', 'lte', 'sim']),
  modem: cap('modem', 'Modem', ['modem', 'dsl', 'cable', 'fibre', 'ont', 'access line']),
  cloud: cap('cloud', 'Provider network', ['internet', 'cloud', 'provider', 'isp', 'wan']),
  firewall: cap('firewall', 'Firewall', ['firewall', 'security', 'filter']),
  'nat-gateway': cap('nat-gateway', 'Address translation', ['nat', 'address translation', 'home router']),
  'dhcp-server': cap('dhcp-server', 'Address service', ['dhcp', 'address pool', 'lease']),
  'poe-source': cap('poe-source', 'Power over Ethernet source', ['poe', 'power over ethernet', 'powered switch']),
  'poe-powered': cap('poe-powered', 'Powered over Ethernet', ['poe', 'power over ethernet', 'powered device']),
  modular: cap('modular', 'Modular chassis', ['modular', 'slots', 'modules', 'expansion']),
  // ── P2 (W1 web-inspector; no model carries these before the W4/W6 catalog flips) ──
  'managed-switch': cap('managed-switch', 'Managed switching', [
    'managed switch',
    'vlan',
    'trunk',
    'spanning tree',
    'etherchannel',
    'port channel',
    'port security',
  ]),
  'lightweight-ap': cap('lightweight-ap', 'Controller-managed access point', ['lightweight', 'controller', 'capwap', 'access point']),
  'wireless-controller': cap('wireless-controller', 'Wireless controller', ['wireless controller', 'wlc', 'capwap', 'wlan', 'controller']),
});

/** Capabilities in canonical order (engine `CAPABILITIES`). */
export const CAPABILITY_ORDER: readonly Capability[] = CAPABILITIES;

/** Search words of a capability list, deduplicated, in capability order. */
export function capabilityWords(caps: readonly Capability[]): readonly string[] {
  const out: string[] = [];
  for (const c of CAPABILITY_ORDER) {
    if (!caps.includes(c)) continue;
    for (const w of CAPABILITY_VOCAB[c].words) if (!out.includes(w)) out.push(w);
  }
  return out;
}

// ── GUI panels ───────────────────────────────────────────────────────────────

/** Where a GUI panel is rendered. */
export type GuiPanelPlacement = 'inspector-tab' | 'desktop-app';

/** Presentation data for one GUI panel. */
export interface GuiPanelVocab {
  readonly id: GuiPanelId;
  readonly label: string;
  readonly placement: GuiPanelPlacement;
  readonly hint: string;
}

function panel(id: GuiPanelId, label: string, placement: GuiPanelPlacement, hint: string): GuiPanelVocab {
  return Object.freeze({ id, label, placement, hint });
}

/** Every GUI panel, exhaustive over `GuiPanelId`. */
export const GUI_PANEL_VOCAB: Readonly<Record<GuiPanelId, GuiPanelVocab>> = Object.freeze({
  physical: panel('physical', 'Physical', 'inspector-tab', 'Chassis slots and installed modules.'),
  'desktop.ip-config': panel('desktop.ip-config', 'IP configuration', 'desktop-app', 'Set the address, mask and gateway of a network adapter.'),
  'desktop.wifi': panel('desktop.wifi', 'Wi-Fi', 'desktop-app', 'Find wireless networks and join one.'),
  'desktop.cellular': panel('desktop.cellular', 'Mobile data', 'desktop-app', 'See the connection to the nearest tower.'),
  'desktop.command-prompt': panel('desktop.command-prompt', 'Command prompt', 'desktop-app', 'Type network commands on this device.'),
  'desktop.web-browser': panel('desktop.web-browser', 'Web browser', 'desktop-app', 'Open web pages served inside the lab.'),
  services: panel('services', 'Services', 'inspector-tab', 'Turn network services on this device on or off.'),
  'wireless.ap': panel('wireless.ap', 'Wireless', 'inspector-tab', 'Network name, security, band and channel of the radios.'),
  'home-router.setup': panel('home-router.setup', 'Router setup', 'inspector-tab', 'Internet, local network and wireless settings in one place.'),
  'radio.link': panel('radio.link', 'Radio link', 'inspector-tab', 'Band, channel and pairing key of a point-to-point radio.'),
  'cell.tower': panel('cell.tower', 'Tower', 'inspector-tab', 'Coverage and attached phones of a mobile network tower.'),
  'modem.status': panel('modem.status', 'Modem', 'inspector-tab', 'Line and local network status of a modem.'),
  // P2 (the panel itself arrives with the W6 web-inspector item, inspector/WlcPanel.tsx)
  'wlc.controller': panel('wlc.controller', 'Controller', 'inspector-tab', 'Access points, interfaces, WLANs and clients of a wireless controller.'),
});

/** GUI panels in engine display order. */
export const GUI_PANEL_ORDER: readonly GuiPanelId[] = GUI_PANELS;

// ── ports ────────────────────────────────────────────────────────────────────

/** Label the UI shows for a routed port of a host without routing. */
export const NETWORK_ADAPTER_LABEL = 'Network adapter';

/** Display label of a port role on a device with `caps` (routed ports of pure hosts are "Network adapter"). */
export function portRoleLabel(role: PortRole, caps: readonly Capability[] | undefined): string {
  if (role === 'routed' && caps !== undefined && caps.includes('host') && !caps.includes('routing')) return NETWORK_ADAPTER_LABEL;
  return ROLE_TRAITS[role].label;
}

/** Display names of port kinds, exhaustive over `PortKind`. */
export const PORT_KIND_LABELS: Readonly<Record<PortKind, string>> = Object.freeze({
  ethernet: 'Ethernet',
  serial: 'Serial',
  console: 'Console',
  usb: 'USB',
  coax: 'Coaxial',
  phone: 'Phone line',
  'fiber-pon': 'Optical access',
  wlan: 'Wi-Fi radio',
  radio: 'Point-to-point radio',
  cellular: 'Mobile radio',
  virtual: 'Virtual',
});

/** Display name of a port kind (the raw value when unknown). */
export function portKindLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(PORT_KIND_LABELS, kind) ? (PORT_KIND_LABELS as Readonly<Record<string, string>>)[kind] as string : kind;
}
