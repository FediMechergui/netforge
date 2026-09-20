/**
 * sim/snapshot-cache.ts — snapshot assembly v2 and the per-device rendered-config cache (spec §4.8 rule 1;
 * ARCHITECTURE-P1 §3.14 "Snapshot additions"; contracts/snapshot.ts).
 *
 * `stateSnapshot()` data is the only UI truth. This module turns the live world into plain, structured-clone-safe
 * `SimSnapshot` objects:
 *
 *   PortSnapshot  P0 fields, then role, allowedRoles, encap, ordinal, virtual/linkable/configurable (ROLE_TRAITS of
 *                 the effective role), connector (spec), wiring, autoMdix, group, slot, module,
 *                 transceiver, poe, radio (LinkModelImpl.radioPortView). `phy` is included only when it differs
 *                 from a plain full-duplex P2P cable whose carrier equals operUp (`isPlainPortPhy`), and
 *                 `phySettings` only when it differs from the defaults (speed auto, duplex auto, no clock rate), so
 *                 P0 cables add nothing beyond the role/label fields.
 *   DeviceSnapshot P0 fields, then category, family, variant, icon, capabilities (effective), cli {shell, grammar},
 *                 gui, slots (models with slots), hostPorts, baseMac (ordinal 0, D8), ui, and `tables.extra` for
 *                 every declared table beyond cam/arp/rib (TABLE_DESCRIPTORS title and columns).
 *   SimSnapshot   P0 fields, plus `media` (LinkModel.media) when any segment, BSS, cell, association or noise entry
 *                 exists or the canvas scale is not the default. `devices` may be restricted to a subset (worker
 *                 deltas) while every other section stays complete.
 *
 * Rendered configs are the expensive part, so they are cached per device (`RenderCache`). An entry is reused while
 * the device's running and startup `ConfigAst` objects are the same instances it was rendered from and no
 * invalidation arrived since. Invalidation comes from:
 *   - trace events that follow every config mutation: `configChange`, `portState` (shutdown written by an admin
 *     change) and `deviceState` (power cycles rebuild running-config) for their device;
 *   - identity changes: power-off replaces `running`, `copy running-config startup-config` replaces `startup`,
 *     `erase startup-config` clears it;
 *   - explicit calls from the facade (configure, module insert/remove, rename) and `forget` on device removal.
 *
 * Secrets never leave the engine in a snapshot (§11): the secret token of every line whose config rule declares
 * `secretToken` (passphrase, peer-key, enable/username/line passwords) is replaced by CONFIG_SECRET_MASK in the
 * rendered running- and startup-config text. The device itself keeps the real value.
 *
 * Determinism: ports in canonical Map order, devices in creation order, tables in declared order.
 */
import { portMac } from '../contracts/addr.js';
import { ROLE_TRAITS, SLOT_ACCEPTS } from '../contracts/catalog.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { DeviceId } from '../contracts/ids.js';
import type { PortPhy, PortPhySettings } from '../contracts/link.js';
import type { MediaSnapshot } from '../contracts/medium.js';
import type { PortL3, PortState } from '../contracts/port.js';
import type { CliSessionView } from '../contracts/cli.js';
import type { ConfigAst } from '../contracts/config.js';
import type { DeviceSnapshot, PortSnapshot, SimSnapshot, SlotSnapshot, TableSnapshot } from '../contracts/snapshot.js';
import { TABLE_DESCRIPTORS, type TableName } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../contracts/topology.js';
import type { TraceEvent } from '../contracts/trace.js';
import { maskConfigSecrets } from '../cli/handlers/show.js';
import type { LinkModelImpl } from '../link/link.js';

/** Tables every device snapshot carries in `tables.cam/arp/rib`; any other declared table goes to `tables.extra`. */
const BASE_TABLE_NAMES: readonly TableName[] = Object.freeze(['cam', 'arp', 'rib']);

/** Trace event kinds that mark their device's rendered configs stale. */
export const CONFIG_INVALIDATING_KINDS: readonly TraceEvent['kind'][] = Object.freeze(['configChange', 'portState', 'deviceState']);

// ── rendered-config cache ────────────────────────────────────────────────────

/** Rendered (and secret-masked) configuration texts of one device. */
export interface RenderedConfigs {
  readonly running: string;
  /** Present iff the device has a startup-config. */
  readonly startup: string | undefined;
}

/** Per-device cache of rendered configs (file header for the invalidation rules). */
export interface RenderCache {
  /** Rendered configs of `dev`, from the cache when still valid. */
  configs(dev: Pick<DeviceRuntime, 'id' | 'running' | 'startup'>): RenderedConfigs;
  /** Mark one device's entry stale. */
  invalidate(device: DeviceId): void;
  /** Feed a trace event; config-changing kinds invalidate their device. */
  observe(ev: TraceEvent): void;
  /** Drop a removed device's entry. */
  forget(device: DeviceId): void;
  /** Drop every entry (world replaced). */
  clear(): void;
  /** Number of render passes performed so far (a pass renders one device's running and startup text). */
  readonly renders: number;
}

interface CacheEntry {
  runningAst: ConfigAst;
  startupAst: ConfigAst | undefined;
  value: RenderedConfigs;
  stale: boolean;
}

/** Create an empty render cache. */
export function createRenderCache(): RenderCache {
  const entries = new Map<DeviceId, CacheEntry>();
  let renders = 0;
  return {
    configs(dev) {
      const hit = entries.get(dev.id);
      if (hit !== undefined && !hit.stale && hit.runningAst === dev.running && hit.startupAst === dev.startup) return hit.value;
      renders++;
      const value: RenderedConfigs = {
        running: maskConfigSecrets(dev.running.render()),
        startup: dev.startup === undefined ? undefined : maskConfigSecrets(dev.startup.render()),
      };
      entries.set(dev.id, { runningAst: dev.running, startupAst: dev.startup, value, stale: false });
      return value;
    },
    invalidate(device) {
      const e = entries.get(device);
      if (e !== undefined) e.stale = true;
    },
    observe(ev) {
      if (ev.kind === 'configChange' || ev.kind === 'portState' || ev.kind === 'deviceState') {
        const e = entries.get(ev.device);
        if (e !== undefined) e.stale = true;
      }
    },
    forget(device) {
      entries.delete(device);
    },
    clear() {
      entries.clear();
    },
    get renders(): number {
      return renders;
    },
  };
}

// ── ports ────────────────────────────────────────────────────────────────────

/**
 * True when a port's link-model PHY detail adds nothing to the P0 fields: a cable end (or no medium) whose carrier
 * equals operUp and line protocol, with no negotiation detail beyond autonegotiated full duplex, no duplex mismatch,
 * no segment, no DCE flag and no line-protocol reason.
 */
export function isPlainPortPhy(port: Pick<PortState, 'operUp' | 'phy'>): boolean {
  const phy = port.phy;
  if (phy === undefined) return true;
  if (phy.medium !== undefined && phy.medium !== 'cable') return false;
  if (phy.carrier !== port.operUp || phy.lineProtocol !== phy.carrier) return false;
  if (phy.lineProtocolReason !== undefined || phy.duplexMismatch === true || phy.segment !== undefined || phy.dce === true) return false;
  const end = phy.end;
  return end === undefined || (end.autoneg && end.via === 'autoneg' && end.duplex === 'full');
}

/** True when PHY settings are the defaults (auto speed, auto duplex, no clock rate). */
export function isDefaultPhySettings(s: PortPhySettings): boolean {
  return s.speed === 'auto' && s.duplex === 'auto' && s.clockRateBps === undefined;
}

/** Plain copy of a port's L3 state (IPv4 with origin/lease, the IPv6 list, groups). */
function copyL3(l3: PortL3): PortL3 {
  const out: PortL3 = {};
  if (l3.ipv4 !== undefined) {
    const v4: NonNullable<PortL3['ipv4']> = { address: l3.ipv4.address, prefixLen: l3.ipv4.prefixLen };
    if (l3.ipv4.origin !== undefined) v4.origin = l3.ipv4.origin;
    if (l3.ipv4.leaseExpiresAt !== undefined) v4.leaseExpiresAt = l3.ipv4.leaseExpiresAt;
    out.ipv4 = v4;
  }
  if (l3.ipv6 !== undefined) out.ipv6 = l3.ipv6.map((a) => ({ ...a }));
  if (l3.ipv6Enabled !== undefined) out.ipv6Enabled = l3.ipv6Enabled;
  if (l3.groups6 !== undefined) out.groups6 = [...l3.groups6];
  return out;
}

/** Plain copy of a PortPhy. */
function copyPhy(phy: PortPhy): PortPhy {
  const out: PortPhy = { ...phy };
  if (phy.end !== undefined) out.end = { ...phy.end };
  return out;
}

/** What port and device snapshots read beyond the runtime itself. */
export interface SnapshotSources {
  readonly links: Pick<LinkModelImpl, 'radioPortView' | 'list' | 'inflight' | 'media'>;
  readonly cache: RenderCache;
}

/** Structured-clone-safe snapshot of one port of `dev` (§3.14 port additions). */
export function buildPortSnapshot(dev: DeviceRuntime, p: PortState, sources: Pick<SnapshotSources, 'links'>): PortSnapshot {
  const role = p.role;
  const traits = ROLE_TRAITS[role];
  const spec = p.spec;
  const s: PortSnapshot = {
    id: p.id,
    short: spec.short,
    kind: spec.kind,
    mac: p.mac,
    adminUp: p.adminUp,
    operUp: p.operUp,
    mtu: p.mtu,
    counters: { ...p.counters },
    l3: copyL3(p.l3),
    txQueue: p.tx.queue,
    // key order kept from P0 (optional P0 fields first) so snapshot JSON stays byte-identical
    ...(p.speedBps !== undefined ? { speedBps: p.speedBps } : {}),
    ...(p.duplex !== undefined ? { duplex: p.duplex } : {}),
    ...(p.link !== undefined ? { link: p.link } : {}),
    ...(p.errDisabled !== undefined ? { errDisabled: p.errDisabled } : {}),
    role,
    allowedRoles: [...spec.allowedRoles],
    encap: p.encap,
    ordinal: p.ordinal,
    virtual: traits.virtual,
    linkable: traits.linkable,
    configurable: traits.configurable,
    connector: spec.connector,
  };

  if (spec.wiring !== undefined) s.wiring = spec.wiring;
  if (spec.autoMdix !== undefined) s.autoMdix = spec.autoMdix;
  if (spec.group !== undefined) s.group = spec.group;
  if (spec.slot !== undefined) s.slot = spec.slot;
  if (p.module !== undefined) s.module = { slot: p.module.slot, module: p.module.module };
  if (p.transceiver !== undefined) s.transceiver = p.transceiver;
  if (spec.poe !== undefined) {
    const poe: NonNullable<PortSnapshot['poe']> = {
      ...(spec.poe.pse !== undefined ? { pse: { ...spec.poe.pse } } : {}),
      ...(spec.poe.pd !== undefined ? { pd: { ...spec.poe.pd } } : {}),
    };
    s.poe = poe;
  }
  if (p.phy !== undefined && !isPlainPortPhy(p)) s.phy = copyPhy(p.phy);
  if (!traits.virtual) {
    const settings = dev.phySettings(p.id);
    if (!isDefaultPhySettings(settings)) s.phySettings = { ...settings };
  }
  if (spec.radio !== undefined) {
    const radio = sources.links.radioPortView({ device: dev.id, port: p.id });
    if (radio !== undefined) s.radio = radio.peer !== undefined ? { ...radio, peer: { ...radio.peer } } : { ...radio };
  }
  return s;
}

// ── devices ──────────────────────────────────────────────────────────────────

/** Extra (non cam/arp/rib) tables of a device, in declared order. */
function extraTables(dev: DeviceRuntime): TableSnapshot[] | undefined {
  const names = dev.tables.names?.();
  if (names === undefined) return undefined;
  const out: TableSnapshot[] = [];
  for (const name of names) {
    if (BASE_TABLE_NAMES.includes(name)) continue;
    const table = dev.tables.get?.(name);
    if (table === undefined) continue;
    const descriptor = Object.prototype.hasOwnProperty.call(TABLE_DESCRIPTORS, name)
      ? TABLE_DESCRIPTORS[name as keyof typeof TABLE_DESCRIPTORS]
      : undefined;
    out.push({
      name,
      title: descriptor?.title ?? name,
      columns: descriptor === undefined ? [] : descriptor.columns.map((c) => ({ ...c })),
      rows: table.rows().map((r) => ({ ...r }) as Record<string, unknown>),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Slot snapshots of a modular chassis (model slot order), or undefined for a model without slots. */
function slotSnapshots(dev: DeviceRuntime): SlotSnapshot[] | undefined {
  const slots = dev.model.slots;
  if (slots === undefined || slots.length === 0) return undefined;
  return slots.map((slot) => {
    const out: SlotSnapshot = { id: slot.id, label: slot.label, type: slot.type, accepts: [...SLOT_ACCEPTS[slot.type]] };
    const installed = dev.modules.get(slot.id);
    if (installed !== undefined) out.module = installed;
    if (slot.cage !== undefined) out.cage = slot.cage;
    return out;
  });
}

/** Structured-clone-safe snapshot of one device (§3.14 device additions). */
export function buildDeviceSnapshot(dev: DeviceRuntime, now: SimTime, sources: SnapshotSources): DeviceSnapshot {
  const ports: PortSnapshot[] = [];
  for (const p of dev.ports.values()) ports.push(buildPortSnapshot(dev, p, sources));
  const configs = sources.cache.configs(dev);
  const model = dev.model;
  const s: DeviceSnapshot = {
    id: dev.id,
    type: dev.spec.type,
    model: model.model,
    kind: model.kind,
    name: dev.spec.name,
    position: { x: dev.spec.position.x, y: dev.spec.position.y },
    power: dev.power,
    booted: dev.bootedAt !== undefined,
    uptimeNs: dev.uptime(now),
    ports,
    tables: {
      cam: dev.tables.cam.rows().map((r) => ({ ...r })),
      arp: dev.tables.arp.rows().map((r) => ({ ...r })),
      rib: dev.tables.rib.rows().map((r) => ({ ...r })),
    },
    processes: dev.stateSnapshots(),
    runningConfig: configs.running,
    hasStartupConfig: dev.startup !== undefined,
    // key order kept from P0.5 (startupConfig before the model fields) so snapshot JSON stays byte-identical
    ...(configs.startup !== undefined ? { startupConfig: configs.startup } : {}),
    category: model.category,
    family: model.family,
    variant: model.variant,
    icon: model.icon,
    capabilities: [...dev.capabilities],
    cli: { shell: model.cli.shell, grammar: model.cli.grammar },
    gui: [...model.gui],
    hostPorts: [...model.hostPorts],
    baseMac: portMac(dev.macBase, 0),
  };
  const extra = extraTables(dev);
  if (extra !== undefined) s.tables.extra = extra;

  const slots = slotSnapshots(dev);
  if (slots !== undefined) s.slots = slots;
  if (dev.spec.ui !== undefined) s.ui = structuredCloneUi(dev.spec.ui);
  return s;
}

/** Deep copy of the JSON-only GUI state. */
function structuredCloneUi<T>(ui: T): T {
  return JSON.parse(JSON.stringify(ui)) as T;
}

// ── the whole simulation ─────────────────────────────────────────────────────

/** True when a media snapshot carries anything worth sending (§3.14: omitted when empty at the default scale). */
export function mediaHasContent(m: MediaSnapshot): boolean {
  return (
    m.segments.length > 0 ||
    m.bss.length > 0 ||
    m.cells.length > 0 ||
    m.associations.length > 0 ||
    (m.noise !== undefined && m.noise.length > 0) ||
    m.metresPerUnit !== DEFAULT_METRES_PER_UNIT
  );
}

/** Inputs of one simulation snapshot. */
export interface SimSnapshotInput extends SnapshotSources {
  readonly now: SimTime;
  readonly seed: number;
  readonly topologyVersion: number;
  /** Every device in creation order. */
  readonly devices: Iterable<DeviceRuntime>;
  /** When set, only these devices are snapshotted (creation order preserved; unknown ids ignored). */
  readonly subset?: readonly DeviceId[];
  readonly sessions: CliSessionView[];
  readonly pduCount: number;
  readonly pendingEvents: number;
}

/** Assemble a `SimSnapshot`. */
export function buildSimSnapshot(input: SimSnapshotInput): SimSnapshot {
  const wanted = input.subset === undefined ? undefined : new Set<DeviceId>(input.subset);
  const devices: DeviceSnapshot[] = [];
  for (const dev of input.devices) {
    if (wanted !== undefined && !wanted.has(dev.id)) continue;
    devices.push(buildDeviceSnapshot(dev, input.now, input));
  }
  const snap: SimSnapshot = {
    now: input.now,
    seed: input.seed,
    topologyVersion: input.topologyVersion,
    devices,
    links: input.links.list(),
    inflight: input.links.inflight(input.now),
    sessions: input.sessions,
    pduCount: input.pduCount,
    pendingEvents: input.pendingEvents,
  };
  const media = input.links.media(input.now);
  if (mediaHasContent(media)) snap.media = media;
  return snap;
}
