/**
 * Visual registry (ARCHITECTURE-P1 §7 Icons): DeviceIconId → IconDef, the labelled generic
 * fallback, the per-kind default icon, and badges derived from capabilities.
 *
 * Built once at module load from the per-category artwork files in `src/icons/`; a missing,
 * duplicated or unknown id throws so a broken registry can never ship silently. `DeviceModel.kind`
 * only picks the icon family here (D2); nothing in this file drives behaviour.
 */
import {
  DEVICE_CATEGORIES,
  DEVICE_ICONS,
  hasCapability,
  type Capability,
  type DeviceCategory,
  type DeviceIconId,
  type DeviceKind,
} from '@netforge/engine';
import type { IconDef } from './icon-types.js';
import { ICON_GENERIC } from '../icons/generic.js';
import { ICONS_ROUTERS } from '../icons/routers.js';
import { ICONS_SWITCHES } from '../icons/switches.js';
import { ICONS_MULTILAYER } from '../icons/multilayer.js';
import { ICONS_DATACENTRE } from '../icons/datacentre.js';
import { ICONS_LEGACY } from '../icons/legacy.js';
import { ICONS_SECURITY } from '../icons/security.js';
import { ICONS_WIRELESS } from '../icons/wireless.js';
import { ICONS_HOME } from '../icons/home.js';
import { ICONS_RADIOS } from '../icons/radios.js';
import { ICONS_WAN } from '../icons/wan.js';
import { ICONS_COMPUTERS } from '../icons/computers.js';
import { ICONS_SERVERS } from '../icons/servers.js';
import { ICONS_MOBILE } from '../icons/mobile.js';
import { ICONS_VOICE } from '../icons/voice.js';
import { ICONS_PERIPHERALS } from '../icons/peripherals.js';
import { ICONS_IOT } from '../icons/iot.js';

/** One artwork file's icons, labelled with its palette category. */
export interface IconGroup {
  /** Palette category the artwork file belongs to. */
  readonly id: DeviceCategory;
  /** Original category label (DEVICE_CATEGORIES). */
  readonly label: string;
  /** Icons in the file, in file order. */
  readonly icons: readonly IconDef[];
}

/** Artwork per palette category (TypeScript enforces one entry per DeviceCategory). */
const ICONS_BY_CATEGORY: Readonly<Record<DeviceCategory, readonly IconDef[]>> = {
  routers: ICONS_ROUTERS,
  switches: ICONS_SWITCHES,
  'multilayer-switches': ICONS_MULTILAYER,
  'data-centre': ICONS_DATACENTRE,
  legacy: ICONS_LEGACY,
  security: ICONS_SECURITY,
  wireless: ICONS_WIRELESS,
  'home-soho': ICONS_HOME,
  radios: ICONS_RADIOS,
  'wan-isp': ICONS_WAN,
  computers: ICONS_COMPUTERS,
  servers: ICONS_SERVERS,
  mobile: ICONS_MOBILE,
  voice: ICONS_VOICE,
  peripherals: ICONS_PERIPHERALS,
  iot: ICONS_IOT,
};

/** The artwork groups in DEVICE_CATEGORIES (palette) order; used by the registry and the gallery. */
export const ICON_GROUPS: readonly IconGroup[] = Object.freeze(
  DEVICE_CATEGORIES.map((c): IconGroup => Object.freeze({ id: c.id, label: c.label, icons: ICONS_BY_CATEGORY[c.id] })),
);

/** Builds the registry from icon lists; throws on unknown, duplicated or missing ids. */
export function buildVisualRegistry(lists: readonly (readonly IconDef[])[]): Readonly<Record<DeviceIconId, IconDef>> {
  const known = new Set<string>(DEVICE_ICONS);
  const map = new Map<DeviceIconId, IconDef>();
  for (const list of lists) {
    for (const def of list) {
      if (def.id === 'generic' || !known.has(def.id)) throw new Error(`icon registry: unknown icon id '${def.id}'`);
      if (map.has(def.id)) throw new Error(`icon registry: duplicated icon id '${def.id}'`);
      map.set(def.id, def);
    }
  }
  const missing = DEVICE_ICONS.filter((id) => !map.has(id));
  if (missing.length > 0) throw new Error(`icon registry: missing icon ids ${missing.join(', ')}`);
  return Object.freeze(Object.fromEntries(map)) as Readonly<Record<DeviceIconId, IconDef>>;
}

/** Original artwork for every DEVICE_ICONS id. */
export const DEVICE_VISUALS: Readonly<Record<DeviceIconId, IconDef>> = buildVisualRegistry(ICON_GROUPS.map((g) => g.icons));

/** Labelled neutral fallback for a model whose icon and kind are both unknown (stale or foreign data). */
export const GENERIC_VISUAL: IconDef = ICON_GENERIC;

/** Natural icon for each device kind (used when a model has no explicit, known `icon`). */
export const KIND_DEFAULT_ICON: Readonly<Record<DeviceKind, DeviceIconId>> = Object.freeze({
  pc: 'pc',
  switch: 'switch',
  router: 'router',
  hub: 'hub',
  laptop: 'laptop',
  server: 'server',
  phone: 'smartphone',
  tablet: 'tablet',
  ipphone: 'ip-phone',
  printer: 'printer',
  tv: 'smart-tv',
  iot: 'iot-sensor',
  mlswitch: 'mlswitch',
  dcswitch: 'dc-leaf',
  repeater: 'repeater',
  bridge: 'bridge',
  firewall: 'firewall',
  ids: 'ids',
  ap: 'ap',
  wlc: 'wlc',
  wrouter: 'home-router',
  radio: 'radio-ptp',
  cell: 'cell-tower',
  modem: 'modem-dsl',
  csu: 'csu',
  cloud: 'cloud',
});

/** A capability that earns a text badge on badge-ready icons. */
export interface CapabilityBadge {
  readonly capability: Capability;
  /** Original badge text (≤ 4 characters). */
  readonly text: string;
}

/** Capability badges in priority order: the first capability the model has wins. */
export const CAPABILITY_BADGES: readonly CapabilityBadge[] = Object.freeze([
  Object.freeze({ capability: 'layer3-switch', text: 'L3' }),
  Object.freeze({ capability: 'poe-source', text: 'PoE' }),
] satisfies CapabilityBadge[]);

/**
 * Icons whose reviewed artwork reserves a badge corner for a capability badge (switch family
 * layout with a short port row). A capability badge replaces the artwork badge only when its text
 * is no longer than the artwork badge, so the pill never grows over the artwork. Other icons only
 * ever show their own artwork badge ('DSL' and 'PON' name the access medium, not a capability);
 * the plain 'switch' icon has a full port row under that corner and takes no badge.
 */
export const BADGE_READY_ICONS: readonly DeviceIconId[] = Object.freeze(['switch-poe', 'mlswitch']);

/** What the resolver needs from a model: the icon family, the optional icon key and capabilities. */
export interface VisualModel {
  readonly kind: DeviceKind;
  readonly icon?: DeviceIconId;
  readonly capabilities?: readonly Capability[];
}

/** Where a resolved visual came from: the model's icon, its kind's default, or the generic fallback. */
export type VisualSource = 'model' | 'kind' | 'generic';

/** Result of `resolveVisual`. */
export interface ResolvedVisual {
  /** Artwork to draw, with the badge already derived. */
  readonly def: IconDef;
  readonly source: VisualSource;
}

const own = (o: object, key: string | undefined): boolean => key !== undefined && Object.prototype.hasOwnProperty.call(o, key);

const lookup = (id: string | undefined): IconDef | undefined => (own(DEVICE_VISUALS, id) ? DEVICE_VISUALS[id as DeviceIconId] : undefined);

/**
 * Badge text for `def` on a model with `capabilities`: on a badge-ready icon the first matching
 * CAPABILITY_BADGES entry that fits the artwork's reserved badge, otherwise (or when nothing
 * matches) the artwork's own badge.
 */
export function badgeFor(def: IconDef, capabilities: readonly Capability[] | undefined): string | undefined {
  const reserved = def.badge;
  if (reserved !== undefined && def.id !== 'generic' && BADGE_READY_ICONS.includes(def.id)) {
    for (const b of CAPABILITY_BADGES) {
      if (hasCapability(capabilities, b.capability) && b.text.length <= reserved.length) return b.text;
    }
  }
  return reserved;
}

/** Badged variants, created once per (icon, badge) so repeated lookups return the same object. */
const variants = new Map<string, IconDef>();

function withBadge(def: IconDef, text: string | undefined): IconDef {
  if (text === undefined || def.badge === text) return def;
  const key = `${def.id}|${text}`;
  let v = variants.get(key);
  if (v === undefined) {
    v = Object.freeze({ ...def, badge: text });
    variants.set(key, v);
  }
  return v;
}

/**
 * Resolves a model's artwork: `model.icon` in the registry, else the kind's default icon, else the
 * generic fallback. Unknown strings (stale snapshots, foreign files) never throw. The badge is
 * derived from `model.capabilities` (see `badgeFor`). Deterministic and identity-stable.
 */
export function resolveVisual(model: VisualModel): ResolvedVisual {
  const explicit = lookup(model.icon);
  if (explicit !== undefined) return { def: withBadge(explicit, badgeFor(explicit, model.capabilities)), source: 'model' };
  const kindIcon = own(KIND_DEFAULT_ICON, model.kind) ? KIND_DEFAULT_ICON[model.kind] : undefined;
  const byKind = lookup(kindIcon);
  if (byKind !== undefined) return { def: withBadge(byKind, badgeFor(byKind, model.capabilities)), source: 'kind' };
  return { def: GENERIC_VISUAL, source: 'generic' };
}

/** model.icon → registry; else the kind's default icon; else the generic fallback (badge derived from capabilities). */
export function visualForModel(model: VisualModel): IconDef {
  return resolveVisual(model).def;
}
