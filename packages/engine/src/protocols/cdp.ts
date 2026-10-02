/**
 * protocols/cdp.ts — the NF discovery daemon, "CDP" as a name only (ARCHITECTURE-P3 D2, D18, §2.6 CdpNeighbourRow,
 * §3.6, §4.1, §4.2, §4.3, §5.5, §5.8; P2 D8 for the original wire format, pdu/codecs/cdp.ts).
 *
 * Who runs it (D2, §4.3). `cdpRunning`: a stored `cdp run` turns it on and a stored `no cdp run` turns it off in every
 * profile (both forms are stored, `bothForms`); with neither line it runs only in a P3 world on a `cdpDefault` model
 * (routers and managed switches with a CLI, the controller). The profile never gates the feature: `cdp run` typed in a
 * P1 or P2 world works. A port takes part (`cdpPortEligible`) when it is a physical Ethernet port in the `switched` or
 * `routed` role (CDP runs on Ethernet only, a listed deviation; never on an SVI, a subinterface or a Port-channel — the
 * members of a bundle speak for themselves) and has no `no cdp enable` line (`cdpPortEnabled`).
 *
 * Sending (§3.6 steps 1–2, §4.2). Nothing at boot, nothing while every port is down: no frame, no row, no debug line.
 * At link-up of a taking-part port one frame is sent at once and the device-level periodic `cdp-tx` timer (`cdp timer`,
 * 60 s) is armed if it is not yet; each `cdp-tx` sends one frame on every taking-part up port in canonical port order
 * and re-arms itself, or stops when no such port is up. Turning CDP on (`cdp run`, or `no cdp run` removed) sends at
 * once on every taking-part up port; `cdp enable` on an up port sends on it at once. A frame is
 * `[ethernet {dst NF_L2_CONTROL_MAC, src port MAC, type 0 → 802.3 length}, llc {SNAP, oui NF_OUI, type NF_PID_CDP},
 * cdp {version 2 (1 with no cdp advertise-v2), ttl = cdp holdtime (180), deviceId = hostname, addresses, portId,
 * capabilities, platform = model name, software, duplex, nativeVlan on an operational trunk}]`,
 * `meta {tag: 'cdp', background: true}`, always untagged (`cdpFrameSpecs`, `cdpAdvertisement`).
 *
 * Receiving (§3.6 step 3). Frames arrive by `deliver` on the physical port: eth-switch step 2 on a bridged port of a
 * VLAN-aware switch, the pipeline's control check (device/pipeline.ts `routedControlVerdict`) on a routed port; the
 * daemon declares no `handles`. A frame is consumed into the `cdp-neighbours` row `${localPort}|${deviceId}`
 * (`cdpNeighbourRow`; `expiresAt` = now + the advertised holdtime). While CDP is off the frame is dropped `not-for-me`,
 * detail `CDP is off on this device` (D18); on a port with `no cdp enable` (or a port that does not take part),
 * `CDP is off on <port>`; a frame without a decodable discovery layer is dropped `unsupported-protocol`.
 *
 * Rows (§2.6, §3.6 steps 4 and 6; rule 20). A refresh that changes no displayed column rewrites the row with only its
 * volatile `expiresAt`/`updatedAt` moved. `cdp-age` (periodic) is armed at the earliest `expiresAt`; at expiry the
 * table's `expire(now)` deletes the rows that reached it (reason `aged`). Link-down of a port deletes its rows (reason
 * `link-down`); `no cdp enable` deletes them (reason `cleared`); turning CDP off stops both timers and clears the table
 * (reason `cleared`).
 *
 * Debug categories (§5.8): `cdp packets` (one line per frame sent or received; §3.6 step 4's wording) and
 * `cdp events` (CDP on or off, a port turned off or on, a new neighbour, a neighbour removed). The daemon draws no
 * randomness (§4.1): fixed periods, canonical port order.
 *
 * `stateSnapshot()` (display only, rule 20; read by the W3 `show cdp`, `show cdp interface`, `show cdp traffic`):
 * `{ process: 'cdp', state: { running, timerS, holdtimeS, advertiseV2, disabled: [ports with no cdp enable,
 * ascending], nextTxAt?, sent, received, errors } }`.
 */
import type { MacAddress } from '../contracts/addr.js';
import { ROLE_TRAITS, defaultRoleFor, profileIncludes, type DefaultsProfile, type PortRole } from '../contracts/catalog.js';
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { DeviceModel } from '../contracts/device.js';
import type { PortId } from '../contracts/ids.js';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_CDP, type FieldValue, type LayerSpec, type Pdu } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { CdpNeighbourRow, DtpRow, Table, TableRow } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import { operOf } from './l2/membership.js';
import { readSwitchport } from './l2/switchport-config.js';

// ── names and constants ────────────────────────────────────────────────────────────────────────────────────────

/** Process name (ARCHITECTURE-P3 §2.1; registered by the W4 catalog flip). */
export const CDP_PROCESS = 'cdp';
/** Table written by this daemon (§2.6). */
export const CDP_TABLE = 'cdp-neighbours';
/** Debug category of every frame sent or received (`debug cdp packets`, §5.8). */
export const CDP_DEBUG_PACKETS = 'cdp packets';
/** Debug category of state changes and neighbour arrivals and departures (`debug cdp events`, §5.8). */
export const CDP_DEBUG_EVENTS = 'cdp events';
/** `meta.tag` of every frame. */
export const CDP_TAG = 'cdp';
/** Capacity of the per-process debug ring. */
export const CDP_DEBUG_RING = 100;
/** `cdp timer` default and bounds, seconds (§5.5). */
export const CDP_DEFAULT_TIMER_S = 60;
export const CDP_TIMER_MIN_S = 5;
export const CDP_TIMER_MAX_S = 254;
/** `cdp holdtime` default and bounds, seconds (§5.5). */
export const CDP_DEFAULT_HOLDTIME_S = 180;
export const CDP_HOLDTIME_MIN_S = 10;
export const CDP_HOLDTIME_MAX_S = 255;
/** The device-level transmit timer (periodic, §4.2). */
export const CDP_TX_TIMER = 'cdp-tx';
/** The ageing timer, armed at the earliest row expiry (periodic, §4.2). */
export const CDP_AGE_TIMER = 'cdp-age';
/** Drop detail of a frame received while CDP is off (D18). */
export const CDP_DETAIL_OFF = 'CDP is off on this device';
/** Drop detail of a frame that carries no decodable discovery layer. */
export const CDP_DETAIL_NOT_A_MESSAGE = 'not a CDP message';
/** Drop detail of a frame received on a port where CDP does not run (`no cdp enable`, or not an Ethernet port). */
export function cdpPortOffDetail(port: PortId): string {
  return `CDP is off on ${port}`;
}

/** The software text a NetForge device advertises (CDP `software`, LLDP `systemDescription`; original wording). */
export function discoverySoftwareText(model: Pick<DeviceModel, 'model'>): string {
  return `NetForge NF-OS, release 3, ${model.model}`;
}

// ── configuration readers (pure; also read by the W3 shows and the lab facts `cdp.enabled`) ─────────────────────

/** The global child of `config` whose key and args are exactly `tokens`, if stored. */
function globalLine(config: ConfigAst, tokens: readonly string[]): ConfigNode | undefined {
  const [key, ...args] = tokens;
  return config.root.children.find((n) => n.key === key && n.args.length === args.length && n.args.every((a, i) => a === args[i]));
}

/** The first argument of the global line `key sub <n>` as an integer in [min, max], or `fallback`. */
function globalNumber(config: ConfigAst, key: string, sub: string, min: number, max: number, fallback: number): number {
  const node = config.root.children.find((n) => n.key === key && n.args[0] === sub && n.args.length === 2);
  const text = node?.args[1];
  if (text === undefined || !/^[0-9]+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

/** The `interface <port>` section of `config`, if any. */
export function discoveryInterfaceSection(config: ConfigAst, port: PortId): ConfigNode | undefined {
  return config.root.children.find((n) => n.key === 'interface' && n.args[0] === port);
}

/** True when the interface section of `port` holds the stored negation `no <tokens…>`. */
export function discoveryInterfaceNegates(config: ConfigAst, port: PortId, tokens: readonly string[]): boolean {
  const section = discoveryInterfaceSection(config, port);
  if (section === undefined) return false;
  return section.children.some((c) => c.key === 'no' && c.args.length === tokens.length && c.args.every((a, i) => a === tokens[i]));
}

/**
 * Does CDP run on this device (D2)? A stored `cdp run` → yes and a stored `no cdp run` → no, in every profile; with
 * neither line, only in a P3 world on a `cdpDefault` model.
 */
export function cdpRunning(config: ConfigAst, profile: DefaultsProfile, model: Pick<DeviceModel, 'cdpDefault'>): boolean {
  if (globalLine(config, ['no', 'cdp', 'run']) !== undefined) return false;
  if (globalLine(config, ['cdp', 'run']) !== undefined) return true;
  return profileIncludes(profile, 'P3') && model.cdpDefault === true;
}

/** `cdp timer <5-254>` (seconds; 60 without the line). */
export function cdpTimerS(config: ConfigAst): number {
  return globalNumber(config, 'cdp', 'timer', CDP_TIMER_MIN_S, CDP_TIMER_MAX_S, CDP_DEFAULT_TIMER_S);
}

/** `cdp holdtime <10-255>` (seconds; 180 without the line). */
export function cdpHoldtimeS(config: ConfigAst): number {
  return globalNumber(config, 'cdp', 'holdtime', CDP_HOLDTIME_MIN_S, CDP_HOLDTIME_MAX_S, CDP_DEFAULT_HOLDTIME_S);
}

/** False with the stored `no cdp advertise-v2` (version 1 frames), true otherwise. */
export function cdpAdvertisesV2(config: ConfigAst): boolean {
  return globalLine(config, ['no', 'cdp', 'advertise-v2']) === undefined;
}

/** False when the interface section of `port` stores `no cdp enable`; true otherwise (the default). */
export function cdpPortEnabled(config: ConfigAst, port: PortId): boolean {
  return !discoveryInterfaceNegates(config, port, ['cdp', 'enable']);
}

/** True when `delta` is a CDP configuration line (global `cdp …`, interface `cdp enable`, either form). */
export function isCdpDelta(delta: Pick<ConfigDelta, 'line'>): boolean {
  return delta.line[0] === 'cdp' || (delta.line[0] === 'no' && delta.line[1] === 'cdp');
}

// ── ports, frames and rows (pure) ──────────────────────────────────────────────────────────────────────────────

/** Effective role of a port: live role, else the spec default for the model capabilities. */
export function discoveryRoleOf(model: Pick<DeviceModel, 'capabilities'>, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, model.capabilities ?? []);
}

/**
 * Does a port take part in discovery (CDP and LLDP alike, D18)? A physical Ethernet port in the `switched` or `routed`
 * role: never a virtual port (SVI, loopback, subinterface, Port-channel, tunnel), a serial port or a radio.
 */
export function discoveryPortEligible(model: Pick<DeviceModel, 'capabilities'>, view: PortView): boolean {
  if (view.spec.kind !== 'ethernet') return false;
  const role = discoveryRoleOf(model, view);
  return !ROLE_TRAITS[role].virtual && (role === 'switched' || role === 'routed');
}

/** The ports that take part, in canonical port order (the order of `ctx.ports`). */
export function discoveryPorts(ctx: Pick<ProcessCtx, 'model' | 'ports'>): PortView[] {
  const out: PortView[] = [];
  for (const view of ctx.ports.values()) if (discoveryPortEligible(ctx.model, view)) out.push(view);
  return out;
}

/**
 * The management address a port advertises: the port's own IPv4 address, else the IPv4 address of the first up
 * virtual port (SVI or loopback, canonical order) — a switch's management VLAN; undefined when there is none.
 */
export function discoveryManagementAddress(ctx: Pick<ProcessCtx, 'model' | 'ports'>, port: PortId): string | undefined {
  const own = ctx.ports.get(port)?.l3.ipv4?.address;
  if (own !== undefined) return own;
  for (const view of ctx.ports.values()) {
    const address = view.l3.ipv4?.address;
    if (address === undefined || !view.operUp) continue;
    if (ROLE_TRAITS[discoveryRoleOf(ctx.model, view)].virtual) return address;
  }
  return undefined;
}

/** The duplex a port advertises: the negotiated end's, else the configured one ('half' or 'full'). */
export function discoveryDuplexOf(view: PortView): 'full' | 'half' {
  const negotiated = view.phy?.end?.duplex;
  if (negotiated !== undefined) return negotiated;
  return view.duplex === 'half' ? 'half' : 'full';
}

/** The CDP capability letters of a model (R routing, S switching, I a managed switch's IGMP snooping; else H host). */
export function cdpCapabilitiesOf(model: Pick<DeviceModel, 'capabilities'>): string {
  const caps = model.capabilities ?? [];
  const out: string[] = [];
  if (caps.includes('routing')) out.push('R');
  if (caps.includes('switching')) out.push('S');
  if (caps.includes('managed-switch')) out.push('I');
  if (out.length === 0) out.push('H');
  return out.join(' ');
}

/** The fields of one CDP advertisement out `port` (the `cdp` layer of `cdpFrameSpecs`). */
export interface CdpAdvertisement {
  readonly version: number;
  readonly ttl: number;
  readonly deviceId: string;
  readonly portId: PortId;
  readonly addresses?: string;
  readonly capabilities: string;
  readonly platform: string;
  readonly software: string;
  readonly duplex: 'full' | 'half';
  readonly nativeVlan?: number;
}

/** Layer specs of one frame from port MAC `mac` carrying `adv` (§3.6 step 2). */
export function cdpFrameSpecs(mac: MacAddress, adv: CdpAdvertisement): LayerSpec[] {
  const cdp: Record<string, FieldValue> = {
    version: adv.version,
    ttl: adv.ttl,
    deviceId: adv.deviceId,
    portId: adv.portId,
    capabilities: adv.capabilities,
    platform: adv.platform,
    software: adv.software,
    duplex: adv.duplex,
  };
  if (adv.addresses !== undefined) cdp.addresses = adv.addresses;
  if (adv.nativeVlan !== undefined) cdp.nativeVlan = adv.nativeVlan;
  return [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: mac, type: 0 } },
    { proto: 'llc', fields: { oui: NF_OUI, type: NF_PID_CDP } },
    { proto: 'cdp', fields: cdp },
  ];
}

/** The key of a `cdp-neighbours` row (§2.6). */
export function cdpNeighbourKey(localPort: PortId, deviceId: string): string {
  return `${localPort}|${deviceId}`;
}

const str = (v: FieldValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: FieldValue | undefined): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/**
 * The `cdp-neighbours` row a received discovery layer (`fields`) makes on `localPort` at `now`, or undefined when the
 * layer lacks its device id or port id. Optional members are present only when the frame carried them.
 */
export function cdpNeighbourRow(localPort: PortId, fields: Readonly<Record<string, FieldValue>>, now: SimTime): CdpNeighbourRow | undefined {
  const deviceId = str(fields.deviceId);
  const remotePort = str(fields.portId);
  if (deviceId === undefined || remotePort === undefined) return undefined;
  const holdtimeS = int(fields.ttl) ?? CDP_DEFAULT_HOLDTIME_S;
  const row: CdpNeighbourRow = {
    key: cdpNeighbourKey(localPort, deviceId),
    localPort,
    deviceId,
    remotePort,
    platform: str(fields.platform) ?? '',
    capabilities: str(fields.capabilities) ?? '',
    addresses: str(fields.addresses) ?? '',
    version: str(fields.software) ?? '',
    holdtimeS,
    cdpVersion: int(fields.version) ?? 0,
    expiresAt: now + holdtimeS * SEC,
    updatedAt: now,
  };
  const vlan = int(fields.nativeVlan);
  if (vlan !== undefined) row.nativeVlan = vlan;
  const duplex = fields.duplex;
  if (duplex === 'full' || duplex === 'half') row.duplex = duplex;
  return row;
}

/** Number of addresses in a comma-joined address list. */
export function discoveryAddressCount(addresses: string): number {
  return addresses.split(',').filter((a) => a.trim() !== '').length;
}

/** True when two rows differ in a column a learner reads (anything but the volatile `expiresAt` and `updatedAt`). */
export function discoveryRowChanged<R extends TableRow>(a: R | undefined, b: R): boolean {
  if (a === undefined) return true;
  const ka = Object.keys(a).filter((k) => k !== 'expiresAt' && k !== 'updatedAt');
  const kb = Object.keys(b).filter((k) => k !== 'expiresAt' && k !== 'updatedAt');
  if (ka.length !== kb.length) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return kb.some((k) => ra[k] !== rb[k]);
}

/** The earliest `expiresAt` of `rows`, or undefined. */
export function discoveryEarliestExpiry(rows: readonly TableRow[]): SimTime | undefined {
  let at: SimTime | undefined;
  for (const r of rows) if (r.expiresAt !== undefined && (at === undefined || r.expiresAt < at)) at = r.expiresAt;
  return at;
}

/** Bounded ring of DebugEvents, newest last (shared by the discovery daemons). */
export class DiscoveryDebugRing {
  private readonly buf: DebugEvent[] = [];
  private start = 0;

  constructor(private readonly capacity: number) {}

  push(ev: DebugEvent): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(ev);
      return;
    }
    this.buf[this.start] = ev;
    this.start = (this.start + 1) % this.capacity;
  }

  toArray(): DebugEvent[] {
    if (this.buf.length < this.capacity) return this.buf.slice();
    const out = new Array<DebugEvent>(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[(this.start + i) % this.capacity]!;
    return out;
  }
}

// ── the daemon ─────────────────────────────────────────────────────────────────────────────────────────────────

class CdpDaemon implements Process {
  readonly name = CDP_PROCESS;

  private readonly ring = new DiscoveryDebugRing(CDP_DEBUG_RING);
  /** The configuration as last read (`readConfig`). */
  private running = false;
  private timerS = CDP_DEFAULT_TIMER_S;
  private holdtimeS = CDP_DEFAULT_HOLDTIME_S;
  private advertiseV2 = true;
  /** Taking-part ports with `no cdp enable`, as last read. */
  private disabled = new Set<PortId>();
  /** When `cdp-tx` fires next (undefined: not armed). */
  private nextTxAt: SimTime | undefined;
  /** When `cdp-age` fires next (undefined: not armed). */
  private ageAt: SimTime | undefined;
  private sent = 0;
  private received = 0;
  private errors = 0;

  init(ctx: ProcessCtx): Action[] {
    // silent at boot (§4.3): read the configuration; a port already up (none, normally: ports come up after boot) is
    // started like a link-up, without any "CDP is on" line
    this.readConfig(ctx);
    if (!this.running) return [];
    const actions: Action[] = [];
    for (const view of discoveryPorts(ctx)) if (view.operUp && !this.disabled.has(view.id)) actions.push(this.advertise(ctx, view.id));
    if (actions.length > 0) actions.push(...this.armTx(ctx));
    return actions;
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const layer = pdu.layer('cdp');
    if (layer === undefined || layer.error !== undefined) {
      this.errors++;
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: CDP_DETAIL_NOT_A_MESSAGE, port }];
    }
    if (!this.running) return [{ type: 'drop', pdu, reason: 'not-for-me', detail: CDP_DETAIL_OFF, port }];
    const view = ctx.ports.get(port);
    if (view === undefined || !discoveryPortEligible(ctx.model, view) || this.disabled.has(port)) {
      return [{ type: 'drop', pdu, reason: 'not-for-me', detail: cdpPortOffDetail(port), port }];
    }
    const table = this.table(ctx);
    const row = cdpNeighbourRow(port, layer.fields, ctx.now);
    if (table === undefined || row === undefined) {
      this.errors++;
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: CDP_DETAIL_NOT_A_MESSAGE, port }];
    }
    this.received++;
    const n = discoveryAddressCount(row.addresses);
    this.packet(ctx, `received CDP v${row.cdpVersion} from ${row.deviceId} on ${port}, ${n} address${n === 1 ? '' : 'es'}, holdtime ${row.holdtimeS} s`, {
      port, from: row.deviceId, pdu: pdu.id,
    });
    const prev = table.get(row.key);
    table.set(row);
    if (prev === undefined) {
      this.event(ctx, `new neighbour ${row.deviceId} on ${port} (its ${row.remotePort}${row.platform === '' ? '' : `, ${row.platform}`})`, { port, neighbour: row.deviceId });
    } else if (discoveryRowChanged(prev, row)) {
      this.event(ctx, `neighbour ${row.deviceId} on ${port} changed its advertisement`, { port, neighbour: row.deviceId });
    }
    return [{ type: 'consume', pdu }, ...this.armAge(ctx, table)];
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key === CDP_TX_TIMER) return this.onTx(ctx);
    if (key === CDP_AGE_TIMER) return this.onAge(ctx);
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isCdpDelta(delta)) return [];
    const wasRunning = this.running;
    const wasDisabled = this.disabled;
    const wasTimer = this.timerS;
    this.readConfig(ctx);
    const cause = `${delta.op === 'unset' ? 'no ' : ''}${delta.line.join(' ')}`;
    const actions: Action[] = [];
    if (!this.running) {
      if (wasRunning) this.stop(ctx, cause, actions);
      return actions;
    }
    if (!wasRunning) {
      this.event(ctx, `CDP is now running (${cause})`, { cause });
      for (const view of discoveryPorts(ctx)) if (view.operUp && !this.disabled.has(view.id)) actions.push(this.advertise(ctx, view.id));
      if (actions.length > 0) actions.push(...this.armTx(ctx));
      return actions;
    }
    // per port: a port turned off loses its rows; a port turned on speaks at once when it is up
    const table = this.table(ctx);
    let sentNow = false;
    for (const view of discoveryPorts(ctx)) {
      const off = this.disabled.has(view.id);
      if (off === wasDisabled.has(view.id)) continue;
      if (off) {
        this.event(ctx, `CDP is off on ${view.id}`, { port: view.id });
        if (table !== undefined) this.removePortRows(ctx, table, view.id, 'cleared');
      } else {
        this.event(ctx, `CDP is on again on ${view.id}`, { port: view.id });
        if (view.operUp) {
          actions.push(this.advertise(ctx, view.id));
          sentNow = true;
        }
      }
    }
    if (table !== undefined) actions.push(...this.armAge(ctx, table));
    if (this.nextTxAt === undefined) {
      if (sentNow) actions.push(...this.armTx(ctx));
    } else if (this.timerS !== wasTimer) {
      actions.push(...this.armTx(ctx)); // a new period starts now
    }
    return actions;
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    if (!this.running) return [];
    const view = ctx.ports.get(port);
    if (view === undefined || !discoveryPortEligible(ctx.model, view)) return [];
    if (!up) {
      const table = this.table(ctx);
      if (table === undefined) return [];
      this.removePortRows(ctx, table, port, 'link-down');
      return this.armAge(ctx, table);
    }
    if (this.disabled.has(port)) return [];
    const actions: Action[] = [this.advertise(ctx, port)];
    if (this.nextTxAt === undefined) actions.push(...this.armTx(ctx));
    return actions;
  }

  stateSnapshot(): StateView {
    const state: Record<string, unknown> = {
      running: this.running,
      timerS: this.timerS,
      holdtimeS: this.holdtimeS,
      advertiseV2: this.advertiseV2,
      disabled: [...this.disabled].sort(),
      sent: this.sent,
      received: this.received,
      errors: this.errors,
    };
    if (this.nextTxAt !== undefined) state.nextTxAt = this.nextTxAt;
    return { process: CDP_PROCESS, state };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── configuration and timers ──

  private readConfig(ctx: ProcessCtx): void {
    this.running = cdpRunning(ctx.config, ctx.profile, ctx.model);
    this.timerS = cdpTimerS(ctx.config);
    this.holdtimeS = cdpHoldtimeS(ctx.config);
    this.advertiseV2 = cdpAdvertisesV2(ctx.config);
    const disabled = new Set<PortId>();
    for (const view of discoveryPorts(ctx)) if (!cdpPortEnabled(ctx.config, view.id)) disabled.add(view.id);
    this.disabled = disabled;
  }

  private table(ctx: ProcessCtx): Table<CdpNeighbourRow> | undefined {
    return ctx.tables.get<CdpNeighbourRow>(CDP_TABLE);
  }

  /** CDP turned off: both timers stop and the table is cleared (§3.6 step 6). */
  private stop(ctx: ProcessCtx, cause: string, actions: Action[]): void {
    const table = this.table(ctx);
    const rows = table?.size ?? 0;
    table?.clear('cleared');
    this.event(ctx, `CDP is now off (${cause}); ${rows} neighbour${rows === 1 ? '' : 's'} cleared`, { cause, rows });
    if (this.nextTxAt !== undefined) actions.push({ type: 'cancelTimer', key: CDP_TX_TIMER });
    if (this.ageAt !== undefined) actions.push({ type: 'cancelTimer', key: CDP_AGE_TIMER });
    this.nextTxAt = undefined;
    this.ageAt = undefined;
  }

  private armTx(ctx: ProcessCtx): Action[] {
    const delay = this.timerS * SEC;
    this.nextTxAt = ctx.now + delay;
    return [{ type: 'timer', key: CDP_TX_TIMER, delay, periodic: true }];
  }

  /** `cdp-tx`: one frame on every taking-part up port, canonical order; re-armed while such a port is up. */
  private onTx(ctx: ProcessCtx): Action[] {
    this.nextTxAt = undefined;
    if (!this.running) return [];
    const actions: Action[] = [];
    for (const view of discoveryPorts(ctx)) if (view.operUp && !this.disabled.has(view.id)) actions.push(this.advertise(ctx, view.id));
    if (actions.length > 0) actions.push(...this.armTx(ctx));
    return actions;
  }

  /** `cdp-age`: delete the rows whose holdtime ran out, then re-arm at the next expiry. */
  private onAge(ctx: ProcessCtx): Action[] {
    this.ageAt = undefined;
    const table = this.table(ctx);
    if (table === undefined) return [];
    for (const row of table.expire(ctx.now)) {
      this.event(ctx, `neighbour ${row.deviceId} on ${row.localPort} removed: holdtime expired`, { port: row.localPort, neighbour: row.deviceId, reason: 'aged' });
    }
    return this.armAge(ctx, table);
  }

  /** (Re-)arm `cdp-age` at the earliest row expiry; cancel it when the table is empty. */
  private armAge(ctx: ProcessCtx, table: Table<CdpNeighbourRow>): Action[] {
    const at = discoveryEarliestExpiry(table.rows());
    if (at === undefined) {
      if (this.ageAt === undefined) return [];
      this.ageAt = undefined;
      return [{ type: 'cancelTimer', key: CDP_AGE_TIMER }];
    }
    if (at === this.ageAt) return [];
    this.ageAt = at;
    return [{ type: 'timer', key: CDP_AGE_TIMER, delay: Math.max(0, at - ctx.now), periodic: true }];
  }

  private removePortRows(ctx: ProcessCtx, table: Table<CdpNeighbourRow>, port: PortId, reason: 'link-down' | 'cleared'): void {
    for (const row of table.find((r) => r.localPort === port)) {
      table.delete(row.key, reason);
      this.event(ctx, `neighbour ${row.deviceId} on ${port} removed: ${reason === 'link-down' ? 'link down' : 'CDP turned off on the port'}`, {
        port, neighbour: row.deviceId, reason,
      });
    }
  }

  // ── frames ──

  /** The advertisement out `port` (§3.6 step 2). */
  private advertisementFor(ctx: ProcessCtx, port: PortId): CdpAdvertisement {
    const view = ctx.ports.get(port) as PortView;
    const address = discoveryManagementAddress(ctx, port);
    let nativeVlan: number | undefined;
    if (discoveryRoleOf(ctx.model, view) === 'switched') {
      const config = readSwitchport(ctx.config, port, ctx.model);
      const dtp = ctx.tables.get<DtpRow>('dtp')?.get(port);
      if (operOf(config, dtp) === 'trunk') nativeVlan = config.nativeVlan;
    }
    const adv: { -readonly [K in keyof CdpAdvertisement]: CdpAdvertisement[K] } = {
      version: this.advertiseV2 ? 2 : 1,
      ttl: this.holdtimeS,
      deviceId: ctx.hostname,
      portId: port,
      capabilities: cdpCapabilitiesOf(ctx.model),
      platform: ctx.model.model,
      software: discoverySoftwareText(ctx.model),
      duplex: discoveryDuplexOf(view),
    };
    if (address !== undefined) adv.addresses = address;
    if (nativeVlan !== undefined) adv.nativeVlan = nativeVlan;
    return adv;
  }

  /** One frame out `port`. */
  private advertise(ctx: ProcessCtx, port: PortId): Action {
    const adv = this.advertisementFor(ctx, port);
    const pdu = ctx.newPdu(cdpFrameSpecs(ctx.macOf(port), adv), { tag: CDP_TAG, background: true });
    this.sent++;
    this.packet(ctx, `sent CDP v${adv.version} on ${port}, holdtime ${adv.ttl} s`, { port, pdu: pdu.id });
    return { type: 'send', port, pdu };
  }

  // ── debug ──

  private packet(ctx: ProcessCtx, message: string, data: Record<string, unknown>): void {
    this.emit(ctx, CDP_DEBUG_PACKETS, message, data);
  }

  private event(ctx: ProcessCtx, message: string, data: Record<string, unknown>): void {
    this.emit(ctx, CDP_DEBUG_EVENTS, message, data);
  }

  private emit(ctx: ProcessCtx, category: string, message: string, data: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: CDP_PROCESS, category, message, data });
  }
}

/** Create the discovery daemon (`name: 'cdp'`, no frame selectors). One instance per device that runs it. */
export function createCdp(): Process {
  return new CdpDaemon();
}
