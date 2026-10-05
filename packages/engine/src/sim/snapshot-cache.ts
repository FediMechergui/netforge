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
 * P2 (ARCHITECTURE-P2 §2.8, D6; W2 sim). Three port members, all optional by meaning so P1 snapshots keep their
 * bytes: `parent` (PortSpec.parent, subinterfaces), `dot1q` (PortState.dot1q, subinterfaces), and `l2`, the
 * `PortL2View` of a BRIDGED port of a VLAN-aware device (`isVlanAware(model)`), derived here at snapshot time from the
 * running config and the tables — never stored: `config` is `readSwitchport(running, port, model)`; `oper` is
 * `operOf(config, dtp row)` (a Port-channel: `channelOperOf` over its bundled members' dtp rows); `active` (trunks)
 * the VLANs allowed AND existing (VLAN 1, the `vlans` rows and the implicit 1002–1005 of `vlanExistsIn`), canonical;
 * `forwarding` the VLANs whose `stp` row for this port is `forwarding` (canonical; absent when the port has no stp
 * row at all); `channel` from the port's `etherchannel` row; `security` from its `port-security` row. The view is
 * written only when it differs from the default (config ≠ DEFAULT_SWITCHPORT, oper 'trunk', channel or security
 * present). `SimSnapshot.profile` is the world's profile for a P2 or P3 world and absent for a P1 one (P3 §9.2 item 16).
 *
 * P3 (ARCHITECTURE-P3 §2.8, D16, D19, D21; W2 sim). Every member is optional by meaning and appended after the P2 ones,
 * so no P1 or P2 snapshot changes:
 *   PortSnapshot.qos       the port's QoS view from `DeviceRuntime.qosCounters(port)` (M13 marking counters, with the
 *                          R26 policer counts, ruling R35), copied; [S20] (ruling R32) its `queue` from the link model's
 *                          `egressQueues` (a scheduler port); present only when either has something (a port with a
 *                          policy, or with interface `fair-queue`).
 *   PortSnapshot.txBacklog the virtual FIFO of the egress port (D16): `LinkModelImpl.queued(port, now)` — the frames
 *                          committed with `txStart > now` — as `{depth, frames}` with at most TX_BACKLOG_FRAMES (8) of
 *                          them, oldest first, each `{pdu, summary, txStart, bytes, dscp?}` (`dscp` recorded by the medium
 *                          at enqueue, ruling R15). Written in every profile, only while the depth is ≥ 1, so an
 *                          uncongested world never gains it; display only, never in the trace, removed by both digest
 *                          normalisers (§4.6). Built only when the caller gives the snapshot instant.
 *   DeviceSnapshot.clock   the device clock (D19) of a BOOTED device, in a P3 world or when its source is `user`, `ntp`
 *                          or `master` (a typed `clock set` or a sync, so no P1/P2 golden gains it). Read from
 *                          `clockView(now)` and written as the line it lies on: `baseAt` is the first SimTime (0 … 999 999
 *                          ns) at which the clock reads a whole millisecond and `baseUnixMs` that millisecond, so
 *                          `baseUnixMs + (t − baseAt) / 10⁶` is the clock at any t exactly and the member changes only
 *                          when the clock is set or synchronised (never per tick; the web extrapolates from `now`).
 *                          Its `tzName` (ruling R42, W4 web-shell) is the `clock timezone` line's zone name, written only
 *                          when the zone is not the default UTC +0 (`CLOCK_DEFAULT_ZONE`), so it changes with that line.
 *   DeviceSnapshot.storage [S32] the host's `files:` store as `[{fs: 'files', files}]` (path order), present only when
 *                          it holds at least one file (a host with user files).
 * Dirtying (D16): the worker refreshes a device from the drained trace; a backlog shrinks at each `txComplete`, which
 * emits no trace event. `createTxBacklogWatch` turns the drained `frameTx` events into the devices to refresh: a frame
 * committed behind a busy transmitter (`txStart > t`, an enqueue that leaves a backlog) keeps its sender due at every
 * drain until its port's last committed frame has ended (each `txComplete` of a port that has a backlog), and once more
 * after, so the member's disappearance reaches the web too. Ruling R43 (P3 worlds) moves queued frames later without a
 * trace event, so the announced `txEnd` can pass while a frame still waits: `drain(now, busy)` keeps a sender due while
 * the caller's probe (`deviceTxBusy`: a port whose transmitter is still busy) says so, whatever the announced end.
 *
 * Determinism: ports in canonical Map order, devices in creation order, tables in declared order.
 */
import { portMac } from '../contracts/addr.js';
import { ROLE_TRAITS, SLOT_ACCEPTS, isVlanAware, profileIncludes, type DefaultsProfile } from '../contracts/catalog.js';
import type { ClockSource } from '../contracts/clock.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { DeviceId } from '../contracts/ids.js';
import type { PortPhy, PortPhySettings } from '../contracts/link.js';
import type { MediaSnapshot } from '../contracts/medium.js';
import type { PortL3, PortState } from '../contracts/port.js';
import type { CliSessionView } from '../contracts/cli.js';
import type { ConfigAst } from '../contracts/config.js';
import type {
  DeviceClockSnapshot,
  DeviceSnapshot,
  PortL2View,
  PortQosView,
  PortSnapshot,
  PortTxQueueView,
  SimSnapshot,
  SlotSnapshot,
  TableSnapshot,
} from '../contracts/snapshot.js';
import type { DeviceStorageView, FileSystemId, StoredFileMeta } from '../contracts/storage.js';
import {
  TABLE_DESCRIPTORS,
  type DtpRow,
  type EtherchannelRow,
  type PortSecurityRow,
  type StpPortRow,
  type TableName,
  type VlanRow,
} from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../contracts/topology.js';
import type { TraceEvent } from '../contracts/trace.js';
import { maskConfigSecrets } from '../cli/handlers/show.js';
import { formatVlanList, vlanListIntersect } from '../core/vlan-list.js';
import type { LinkModelImpl } from '../link/link.js';
import type { QueuedFrame } from '../link/media/types.js';
import { channelOperOf, isImplicitVlan, operOf } from '../protocols/l2/membership.js';
import { isDefaultSwitchport, readSwitchport } from '../protocols/l2/switchport-config.js';

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
  /** P3 (D16): `queued` is the source of `PortSnapshot.txBacklog`. */
  readonly links: Pick<LinkModelImpl, 'radioPortView' | 'list' | 'inflight' | 'media' | 'queued'> & Partial<Pick<LinkModelImpl, 'egressQueues'>>;
  readonly cache: RenderCache;
}

// ── P3: the QoS view and the virtual FIFO of a port (§2.8, D16) ─────────────

/** @since P3 The most frames a `PortSnapshot.txBacklog` lists (its depth counts every waiting frame). */
export const TX_BACKLOG_FRAMES = 8;

/**
 * @since P3 (D16, §2.8, ruling R15) The `txBacklog` of a port from its `queued` frames (oldest first): undefined when
 * none waits; otherwise the depth and the first TX_BACKLOG_FRAMES of them as `{pdu, summary, txStart, bytes, dscp?}`.
 */
export function txBacklogOf(queued: readonly QueuedFrame[]): PortTxQueueView | undefined {
  if (queued.length === 0) return undefined;
  const frames: PortTxQueueView['frames'][number][] = [];
  for (const f of queued.slice(0, TX_BACKLOG_FRAMES)) {
    const entry: PortTxQueueView['frames'][number] = { pdu: f.pdu.id, summary: { ...f.pdu }, txStart: f.txStart, bytes: f.pdu.size };
    if (f.dscp !== undefined) entry.dscp = f.dscp;
    frames.push(entry);
  }
  return { depth: queued.length, frames };
}

/**
 * @since P3 (D16) Which devices' `txBacklog` may have changed, from the drained trace (file header, "Dirtying"). The
 * worker feeds it every drained event and merges `drain(now)` into its dirty set before it builds a delta.
 */
export interface TxBacklogWatch {
  /** One drained trace event: a `frameTx` committed behind a busy transmitter keeps its sender due until its `txEnd`. */
  observe(ev: TraceEvent): void;
  /**
   * The devices that had a waiting frame at any time since the last drain, in the order they were first seen; those
   * whose last committed frame has ended by `now` are reported this once more and then forgotten. With `busy` (ruling
   * R43: the control path moves queued frames without a trace event), a device whose announced end has passed is kept
   * while `busy(device)` is true, and forgotten at the first drain that finds it idle (reported that once more).
   */
  drain(now: SimTime, busy?: (device: DeviceId) => boolean): DeviceId[];
  /** Forget everything (a new world). */
  clear(): void;
}

/** @since P3 (D16) A fresh `TxBacklogWatch` (no module state, rule 12). */
export function createTxBacklogWatch(): TxBacklogWatch {
  /** device → the latest txEnd of a frame it committed behind its transmitter (insertion ordered). */
  const until = new Map<DeviceId, SimTime>();
  return {
    observe(ev) {
      // [S20] (ruling R32): a frame held by a scheduler port changes its queue view; the device is due at the next drain
      // (each later dequeue writes a `frameTx` and each scheduler drop a `drop`, which the worker's dirty set reads)
      if (ev.kind === 'frameQueued') {
        const prev = until.get(ev.device);
        if (prev === undefined || ev.t > prev) until.set(ev.device, ev.t);
        return;
      }
      if (ev.kind !== 'frameTx' || ev.txStart <= ev.t) return;
      const device = ev.from.device;
      const prev = until.get(device);
      if (prev === undefined || ev.txEnd > prev) until.set(device, ev.txEnd);
    },
    drain(now, busy) {
      const out: DeviceId[] = [];
      for (const [device, end] of [...until]) {
        out.push(device);
        if (end <= now && busy?.(device) !== true) until.delete(device);
      }
      return out;
    },
    clear() {
      until.clear();
    },
  };
}

/**
 * @since P3 (ruling R43) Whether a port of `dev` still has its transmitter busy at `now` (`tx.busyUntil > now`: a frame
 * on the wire or committed behind it, at its real, possibly moved, times). The probe of `TxBacklogWatch.drain`; false for
 * an absent device.
 */
export function deviceTxBusy(dev: Pick<DeviceRuntime, 'ports'> | undefined, now: SimTime): boolean {
  if (dev === undefined) return false;
  for (const p of dev.ports.values()) if (p.tx.busyUntil > now) return true;
  return false;
}

/** @since P3 (M13) A structured-clone-safe copy of a port's QoS view (`DeviceRuntime.qosCounters`). */
export function copyQosView(view: PortQosView): PortQosView {
  const out: PortQosView = {
    ...(view.input !== undefined ? { input: view.input } : {}),
    ...(view.output !== undefined ? { output: view.output } : {}),
    // ruling R35: a class's policer counts (R26) are copied after the M13 members, only when present
    classes: view.classes.map((c) => ({
      name: c.name,
      matched: c.matched,
      matchedBytes: c.matchedBytes,
      marked: c.marked,
      ...(c.police !== undefined ? { police: { ...c.police } } : {}),
    })),
  };
  if (view.queue !== undefined) out.queue = structuredClone(view.queue);
  return out;
}

/**
 * Structured-clone-safe snapshot of one port of `dev` (§3.14 port additions). P3: `qos` from the runtime, and, when
 * `now` is given and the sources can list it, `txBacklog` (file header).
 */
export function buildPortSnapshot(dev: DeviceRuntime, p: PortState, sources: Pick<SnapshotSources, 'links'>, now?: SimTime): PortSnapshot {
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
  // P2 (§2.8, optional by meaning): absent on every P1 port, so P1 snapshots keep their bytes
  if (traits.bridged) {
    const l2 = buildPortL2View(dev, p);
    if (l2 !== undefined) s.l2 = l2;
  }
  if (spec.parent !== undefined) s.parent = spec.parent;
  if (p.dot1q !== undefined) s.dot1q = { vid: p.dot1q.vid, native: p.dot1q.native };
  // P3 (§2.8, optional by meaning): appended after every P2 member, absent unless there is something to show
  const qos = dev.qosCounters?.(p.id);
  // [S20] (ruling R32): a scheduler port's held queues come from the link model (`egressQueues`)
  const queue = typeof sources.links.egressQueues === 'function' ? sources.links.egressQueues({ device: dev.id, port: p.id }) : undefined;
  if (qos !== undefined || queue !== undefined) {
    const view = copyQosView(qos ?? { classes: [] });
    if (view.queue === undefined && queue !== undefined) view.queue = structuredClone(queue);
    s.qos = view;
  }
  if (now !== undefined && typeof sources.links.queued === 'function') {
    const backlog = txBacklogOf(sources.links.queued({ device: dev.id, port: p.id }, now));
    if (backlog !== undefined) s.txBacklog = backlog;
  }
  return s;
}

// ── P2: the L2 view of a bridged port (§2.8, D6) ────────────────────────────

/**
 * Canonical list of the VLANs that exist on `dev`: the implicit ones (`isImplicitVlan`: 1 and 1002–1005, read at call
 * time — rule 12) plus its `vlans` rows.
 */
function existingVlanList(dev: Pick<DeviceRuntime, 'tables'>): string {
  const ids = [1, 1002, 1003, 1004, 1005].filter(isImplicitVlan);
  const vlans = dev.tables.get<VlanRow>('vlans');
  if (vlans !== undefined) for (const r of vlans.rows()) if (!ids.includes(r.vlan)) ids.push(r.vlan);
  return formatVlanList(ids);
}

/**
 * @since P2 The `PortL2View` of port `p` of `dev` (file header for the derivation), or undefined when the device is
 * not VLAN-aware or the view is the default one (config = DEFAULT_SWITCHPORT, oper 'access', no channel, no security).
 */
export function buildPortL2View(dev: Pick<DeviceRuntime, 'model' | 'running' | 'tables'>, p: Pick<PortState, 'id' | 'role'>): PortL2View | undefined {
  if (!isVlanAware(dev.model)) return undefined;
  const config = readSwitchport(dev.running, p.id, dev.model);
  const dtp = dev.tables.get<DtpRow>('dtp');
  const channels = dev.tables.get<EtherchannelRow>('etherchannel');
  let oper: PortL2View['oper'];
  if (p.role === 'channel') {
    const members = channels === undefined ? [] : channels.find((r) => r.bundle === p.id && r.state === 'bundled');
    oper = channelOperOf(
      config,
      members.map((m) => dtp?.get(m.port)),
    );
  } else {
    oper = operOf(config, dtp?.get(p.id));
  }
  const channel = channels?.get(p.id);
  const security = dev.tables.get<PortSecurityRow>('port-security')?.get(p.id);
  if (isDefaultSwitchport(config) && oper !== 'trunk' && channel === undefined && security === undefined) return undefined;

  const view: PortL2View = { config: { ...config }, oper };
  if (oper === 'trunk') view.active = vlanListIntersect(config.allowed, existingVlanList(dev));
  const stpRows = dev.tables.get<StpPortRow>('stp')?.find((r) => r.port === p.id);
  if (stpRows !== undefined && stpRows.length > 0) {
    view.forwarding = formatVlanList(stpRows.filter((r) => r.state === 'forwarding').map((r) => r.vlan));
  }
  if (channel !== undefined) view.channel = { group: channel.group, bundle: channel.bundle, state: channel.state };
  if (security !== undefined) {
    view.security = { status: security.status, count: security.count, max: security.max, violations: security.violations };
  }
  return view;
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

// ── P3: the device clock and the hosts' file store (§2.8, D19, D21) ────────

/** @since P3 (D19) The clock sources a P1 or P2 world shows: set by a typed `clock set` or by a synchronisation. */
export const CLOCK_SNAPSHOT_SOURCES: readonly ClockSource[] = Object.freeze(['user', 'ntp', 'master']);

/** Nanoseconds per millisecond (integer clock arithmetic). */
const NS_PER_MS = 1_000_000;

/**
 * @since P3 (ruling R42) The zone of a device without a `clock timezone` line (device/process-ctx.ts `DEVICE_CLOCK_UTC`,
 * restated here so this module imports nothing new): a clock in it carries no `tzName`.
 */
const CLOCK_DEFAULT_ZONE: Readonly<{ name: string; offsetMin: number }> = Object.freeze({ name: 'UTC', offsetMin: 0 });

/**
 * @since P3 (D19, §2.8) `DeviceSnapshot.clock` of `dev` at `now` (file header), or undefined: a device that is off or
 * still booting shows none, and outside a P3 world only a clock set by a user or a synchronisation is shown. The line
 * is written from its first whole-millisecond instant, so it is the same object value at every `now` until the clock
 * is set or synchronised again.
 */
export function deviceClockSnapshot(dev: Pick<DeviceRuntime, 'bootedAt' | 'profile' | 'clockView'>, now: SimTime): DeviceClockSnapshot | undefined {
  if (dev.bootedAt === undefined) return undefined;
  const view = dev.clockView(now);
  if (!profileIncludes(dev.profile, 'P3') && !CLOCK_SNAPSHOT_SOURCES.includes(view.source)) return undefined;
  // the clock reads view.unixMs ms + view.subMsNs ns at `now`; it reads a whole millisecond every 10⁶ ns from
  // baseAt = (now − subMsNs) mod 10⁶, where it reads baseUnixMs (integers only: no product beyond 2⁵³)
  const baseAt = (((now - view.subMsNs) % NS_PER_MS) + NS_PER_MS) % NS_PER_MS;
  const baseUnixMs = view.unixMs - (now - view.subMsNs - baseAt) / NS_PER_MS;
  const out: DeviceClockSnapshot = { source: view.source, baseUnixMs, baseAt, tzOffsetMin: view.tz.offsetMin };
  if (view.stratum !== undefined) out.stratum = view.stratum;
  if (view.reference !== undefined) out.reference = view.reference;
  // ruling R42: the zone name `show clock` prints, only when a `clock timezone` line set another zone than UTC +0
  if (view.tz.name !== CLOCK_DEFAULT_ZONE.name || view.tz.offsetMin !== CLOCK_DEFAULT_ZONE.offsetMin) out.tzName = view.tz.name;
  return out;
}

/** @since P3 [S32] The file system the hosts' store lists in a snapshot (D21; [S29] would add flash: and nvram:). */
const STORAGE_FS: FileSystemId = 'files';

/**
 * @since P3 [S32] The reader of a runtime's `files:` store (`DeviceRuntime.files`, optional by meaning since the W2 fix):
 * read when present; an absent reader means an empty store.
 */
type FileStoreReader = Pick<DeviceRuntime, 'files'>;

/** @since P3 [S32] The files of `dev`'s `files:` store, in path order (none without a store or a reader). */
export function storedFilesOf(dev: object): readonly StoredFileMeta[] {
  const reader = (dev as FileStoreReader).files;
  return typeof reader === 'function' ? reader.call(dev, STORAGE_FS) : [];
}

/**
 * @since P3 [S32] `DeviceSnapshot.storage` of `dev` (D21): `[{fs: 'files', files}]` in the store's path order, copied;
 * undefined when the device keeps no file (a host without user files, or a device without a store).
 */
export function deviceStorageOf(dev: object): DeviceStorageView[] | undefined {
  const files = storedFilesOf(dev);
  if (files.length === 0) return undefined;
  return [{ fs: STORAGE_FS, files: files.map((f) => ({ fs: f.fs, path: f.path, size: f.size, modifiedAt: f.modifiedAt })) }];
}

/** Structured-clone-safe snapshot of one device (§3.14 device additions). */
export function buildDeviceSnapshot(dev: DeviceRuntime, now: SimTime, sources: SnapshotSources): DeviceSnapshot {
  const ports: PortSnapshot[] = [];
  for (const p of dev.ports.values()) ports.push(buildPortSnapshot(dev, p, sources, now));
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
  // P3 (§2.8, optional by meaning): appended last, absent in every P1/P2 golden world
  const clock = deviceClockSnapshot(dev, now);
  if (clock !== undefined) s.clock = clock;
  const storage = deviceStorageOf(dev);
  if (storage !== undefined) s.storage = storage;
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
  /** @since P2 The world's defaults profile (D2); absent = 'P1'. Written to the snapshot only when P2 or later (P3). */
  readonly profile?: DefaultsProfile;
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
  // P2 (§2.8, optional by meaning): only a world of profile P2 or later carries it (P3 §9.2 item 16), so P1 snapshots
  // keep their bytes
  if (input.profile !== undefined && input.profile !== 'P1') snap.profile = input.profile;
  return snap;
}
