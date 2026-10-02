/**
 * protocols/lldp.ts — the IEEE 802.1AB LLDP daemon (ARCHITECTURE-P3 D2, D18, §2.6 LldpNeighbourRow, §3.6 step 7, §4.1,
 * §4.2, §4.3, §5.5, §5.8; the IEEE wire format of pdu/codecs/lldp.ts).
 *
 * Who runs it (D2, §4.3): only a stored `lldp run`, in every profile — LLDP is off by default everywhere, as on real
 * devices. A port takes part as for CDP (`discoveryPortEligible`, protocols/cdp.ts: a physical Ethernet port in the
 * `switched` or `routed` role). Transmit and receive are per port and asymmetric (§3.6 step 7): `no lldp transmit`
 * stops sending on the port (`lldpPortTransmits`), `no lldp receive` stops accepting there and deletes its rows
 * (`lldpPortReceives`).
 *
 * Sending (§4.2). Nothing at boot, nothing while every port is down. At link-up of a transmitting port one frame is
 * sent at once and the device-level periodic `lldp-tx` timer (`lldp timer`, 30 s) is armed if it is not yet; each
 * `lldp-tx` sends one frame on every transmitting up port in canonical port order and re-arms itself, or stops when no
 * such port is up. `lldp run` sends at once on every transmitting up port; `lldp transmit` restored on an up port sends
 * on it at once. A frame is `[ethernet {dst 01:80:c2:00:00:0e, src port MAC, type 0x88cc}, lldp {chassis subtype 4 =
 * the device's chassis MAC, port subtype 5 = the interface name, ttl = lldp holdtime (120), port description = the
 * interface's `description`, system name = hostname, system description, capabilities and enabled capabilities (IEEE
 * bits), management address}]`, `meta {tag: 'lldp', background: true}` (`lldpFrameSpecs`). `lldp reinit` is stored and
 * shown, and changes nothing in this model.
 *
 * Receiving. Frames arrive by `deliver` on the physical port (eth-switch step 2 on a bridged port, the pipeline's control
 * check on a routed port); no `handles`. A frame is consumed into the `lldp-neighbours` row
 * `${localPort}|${chassisId}|${portId}` (`lldpNeighbourRow`; `expiresAt` = now + TTL); a TTL of 0 (an IEEE shutdown
 * advertisement) deletes that row instead (reason `cleared`). While LLDP is off the frame drops `not-for-me`, detail
 * `LLDP is off on this device`; on a port with `no lldp receive` (or a port that does not take part), `LLDP receive is
 * off on <port>`; a frame without a decodable LLDP layer drops `unsupported-protocol`.
 *
 * Rows age exactly as CDP's (`lldp-age`, periodic, at the earliest `expiresAt`; reason `aged`); link-down deletes a
 * port's rows (`link-down`); `no lldp run` stops both timers and clears the table (`cleared`).
 *
 * Debug category (§5.8): `lldp packets` (frames sent and received, LLDP on or off, neighbours added and removed).
 * The daemon draws no randomness (§4.1).
 *
 * `stateSnapshot()` (display only; read by the W3 `show lldp`, `show lldp interface`, `show lldp traffic`):
 * `{ process: 'lldp', state: { running, timerS, holdtimeS, reinitS, noTransmit: [ports], noReceive: [ports],
 * nextTxAt?, sent, received, errors } }`.
 */
import type { MacAddress } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { DeviceModel } from '../contracts/device.js';
import type { PortId } from '../contracts/ids.js';
import { ETHERTYPE_LLDP, LLDP_NEAREST_BRIDGE_MAC, type FieldValue, type LayerSpec, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { LldpNeighbourRow, Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import { LLDP_CAPABILITY } from '../pdu/codecs/lldp.js';
import {
  DiscoveryDebugRing,
  discoveryInterfaceSection,
  discoveryManagementAddress,
  discoveryPortEligible,
  discoveryPorts,
  discoveryRowChanged,
  discoverySoftwareText,
  discoveryEarliestExpiry,
  discoveryInterfaceNegates,
} from './cdp.js';

// ── names and constants ────────────────────────────────────────────────────────────────────────────────────────

/** Process name (ARCHITECTURE-P3 §2.1; registered by the W4 catalog flip). */
export const LLDP_PROCESS = 'lldp';
/** Table written by this daemon (§2.6). */
export const LLDP_TABLE = 'lldp-neighbours';
/** Debug category (`debug lldp packets`, §5.8). */
export const LLDP_DEBUG_PACKETS = 'lldp packets';
/** `meta.tag` of every frame. */
export const LLDP_TAG = 'lldp';
/** Capacity of the per-process debug ring. */
export const LLDP_DEBUG_RING = 100;
/** `lldp timer` default and bounds, seconds (§5.5). */
export const LLDP_DEFAULT_TIMER_S = 30;
export const LLDP_TIMER_MIN_S = 5;
export const LLDP_TIMER_MAX_S = 65534;
/** `lldp holdtime` default and bounds, seconds (§5.5; the advertised TTL). */
export const LLDP_DEFAULT_HOLDTIME_S = 120;
export const LLDP_HOLDTIME_MAX_S = 65535;
/** `lldp reinit` default and bounds, seconds (§5.5). */
export const LLDP_DEFAULT_REINIT_S = 2;
export const LLDP_REINIT_MIN_S = 2;
export const LLDP_REINIT_MAX_S = 5;
/** The device-level transmit timer (periodic, §4.2). */
export const LLDP_TX_TIMER = 'lldp-tx';
/** The ageing timer, armed at the earliest row expiry (periodic, §4.2). */
export const LLDP_AGE_TIMER = 'lldp-age';
/** Drop detail of a frame received while LLDP is off. */
export const LLDP_DETAIL_OFF = 'LLDP is off on this device';
/** Drop detail of a frame that carries no decodable LLDP layer. */
export const LLDP_DETAIL_NOT_A_FRAME = 'not an LLDP frame';
/** Drop detail of a frame received on a port with `no lldp receive` (or a port that does not take part). */
export function lldpReceiveOffDetail(port: PortId): string {
  return `LLDP receive is off on ${port}`;
}

/** IEEE capability letters by bit, in bit order (other, repeater, bridge, WLAN access point, router, telephone, DOCSIS, station). */
export const LLDP_CAPABILITY_LETTERS: readonly (readonly [number, string])[] = Object.freeze([
  [LLDP_CAPABILITY.other, 'O'],
  [LLDP_CAPABILITY.repeater, 'P'],
  [LLDP_CAPABILITY.bridge, 'B'],
  [LLDP_CAPABILITY.wlanAp, 'W'],
  [LLDP_CAPABILITY.router, 'R'],
  [LLDP_CAPABILITY.telephone, 'T'],
  [LLDP_CAPABILITY.docsis, 'C'],
  [LLDP_CAPABILITY.station, 'S'],
] as const);

// ── configuration readers (pure; also read by the W3 shows and the lab fact `lldp.enabled`) ──────────────────────

/** Does LLDP run on this device? Only with a stored `lldp run` (off by default in every profile, D2). */
export function lldpRunning(config: ConfigAst): boolean {
  return config.root.children.some((n) => n.key === 'lldp' && n.args.length === 1 && n.args[0] === 'run');
}

function lldpNumber(config: ConfigAst, sub: string, min: number, max: number, fallback: number): number {
  const node = config.root.children.find((n) => n.key === 'lldp' && n.args[0] === sub && n.args.length === 2);
  const text = node?.args[1];
  if (text === undefined || !/^[0-9]+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

/** `lldp timer <5-65534>` (seconds; 30 without the line). */
export function lldpTimerS(config: ConfigAst): number {
  return lldpNumber(config, 'timer', LLDP_TIMER_MIN_S, LLDP_TIMER_MAX_S, LLDP_DEFAULT_TIMER_S);
}

/** `lldp holdtime <0-65535>` (seconds; 120 without the line). */
export function lldpHoldtimeS(config: ConfigAst): number {
  return lldpNumber(config, 'holdtime', 0, LLDP_HOLDTIME_MAX_S, LLDP_DEFAULT_HOLDTIME_S);
}

/** `lldp reinit <2-5>` (seconds; 2 without the line). */
export function lldpReinitS(config: ConfigAst): number {
  return lldpNumber(config, 'reinit', LLDP_REINIT_MIN_S, LLDP_REINIT_MAX_S, LLDP_DEFAULT_REINIT_S);
}

/** False when the interface section of `port` stores `no lldp transmit`. */
export function lldpPortTransmits(config: ConfigAst, port: PortId): boolean {
  return !discoveryInterfaceNegates(config, port, ['lldp', 'transmit']);
}

/** False when the interface section of `port` stores `no lldp receive`. */
export function lldpPortReceives(config: ConfigAst, port: PortId): boolean {
  return !discoveryInterfaceNegates(config, port, ['lldp', 'receive']);
}

/** True when `delta` is an LLDP configuration line (global `lldp …`, interface `lldp transmit|receive`, either form). */
export function isLldpDelta(delta: Pick<ConfigDelta, 'line'>): boolean {
  return delta.line[0] === 'lldp' || (delta.line[0] === 'no' && delta.line[1] === 'lldp');
}

/** The `description` text of the interface section of `port`, if any. */
export function lldpInterfaceDescription(config: ConfigAst, port: PortId): string | undefined {
  const node = discoveryInterfaceSection(config, port)?.children.find((c) => c.key === 'description');
  if (node === undefined || node.args.length === 0) return undefined;
  return node.args.join(' ');
}

// ── frames and rows (pure) ─────────────────────────────────────────────────────────────────────────────────────

/** The IEEE system capability bits of a model: bridge (switching), router (routing); a station when neither. */
export function lldpCapabilityBits(model: Pick<DeviceModel, 'capabilities'>): number {
  const caps = model.capabilities ?? [];
  let bits = 0;
  if (caps.includes('switching')) bits |= LLDP_CAPABILITY.bridge;
  if (caps.includes('routing')) bits |= LLDP_CAPABILITY.router;
  return bits === 0 ? LLDP_CAPABILITY.station : bits;
}

/** The capability letters of a bit map, in bit order, joined by ',' (e.g. 'B,R'); '' for 0. */
export function lldpCapabilityText(bits: number): string {
  return LLDP_CAPABILITY_LETTERS.filter(([bit]) => (bits & bit) !== 0).map(([, letter]) => letter).join(',');
}

/** The chassis id a device advertises: the MAC of its first port in canonical order. */
export function lldpChassisId(ctx: Pick<ProcessCtx, 'ports' | 'macOf'>): MacAddress | undefined {
  for (const id of ctx.ports.keys()) return ctx.macOf(id);
  return undefined;
}

/** The fields of one LLDP advertisement out a port (the `lldp` layer of `lldpFrameSpecs`). */
export interface LldpAdvertisement {
  readonly chassisId: MacAddress;
  readonly portId: PortId;
  readonly ttl: number;
  readonly portDescription?: string;
  readonly systemName: string;
  readonly systemDescription: string;
  readonly capabilities: number;
  readonly enabledCapabilities: number;
  readonly mgmtAddress?: string;
}

/** Layer specs of one frame from port MAC `mac` carrying `adv` (chassis subtype 4, port subtype 5). */
export function lldpFrameSpecs(mac: MacAddress, adv: LldpAdvertisement): LayerSpec[] {
  const lldp: Record<string, FieldValue> = {
    chassisSubtype: 4,
    chassisId: adv.chassisId,
    portSubtype: 5,
    portId: adv.portId,
    ttl: adv.ttl,
    systemName: adv.systemName,
    systemDescription: adv.systemDescription,
    capabilities: adv.capabilities,
    enabledCapabilities: adv.enabledCapabilities,
  };
  if (adv.portDescription !== undefined) lldp.portDescription = adv.portDescription;
  if (adv.mgmtAddress !== undefined) lldp.mgmtAddress = adv.mgmtAddress;
  return [
    { proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: mac, type: ETHERTYPE_LLDP } },
    { proto: 'lldp', fields: lldp },
  ];
}

/** The key of an `lldp-neighbours` row (§2.6). */
export function lldpNeighbourKey(localPort: PortId, chassisId: string, portId: string): string {
  return `${localPort}|${chassisId}|${portId}`;
}

const str = (v: FieldValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: FieldValue | undefined): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/**
 * The `lldp-neighbours` row a received LLDP layer (`fields`) makes on `localPort` at `now`, or undefined when it lacks
 * its chassis id, port id or TTL. Optional members are present only when the frame carried them; capability bit maps
 * are rendered as letters (`lldpCapabilityText`).
 */
export function lldpNeighbourRow(localPort: PortId, fields: Readonly<Record<string, FieldValue>>, now: SimTime): LldpNeighbourRow | undefined {
  const chassisId = str(fields.chassisId);
  const portId = str(fields.portId);
  const ttlS = int(fields.ttl);
  if (chassisId === undefined || portId === undefined || ttlS === undefined) return undefined;
  const row: LldpNeighbourRow = {
    key: lldpNeighbourKey(localPort, chassisId, portId),
    localPort,
    chassisId,
    portId,
    ttlS,
    expiresAt: now + ttlS * SEC,
    updatedAt: now,
  };
  const systemName = str(fields.systemName);
  if (systemName !== undefined) row.systemName = systemName;
  const portDescription = str(fields.portDescription);
  if (portDescription !== undefined) row.portDescription = portDescription;
  const systemDescription = str(fields.systemDescription);
  if (systemDescription !== undefined) row.systemDescription = systemDescription;
  const caps = int(fields.capabilities);
  if (caps !== undefined) row.capabilities = lldpCapabilityText(caps);
  const enabled = int(fields.enabledCapabilities);
  if (enabled !== undefined) row.enabled = lldpCapabilityText(enabled);
  const mgmt = str(fields.mgmtAddress);
  if (mgmt !== undefined) row.mgmtAddress = mgmt;
  return row;
}

// ── the daemon ─────────────────────────────────────────────────────────────────────────────────────────────────

class LldpDaemon implements Process {
  readonly name = LLDP_PROCESS;

  private readonly ring = new DiscoveryDebugRing(LLDP_DEBUG_RING);
  private running = false;
  private timerS = LLDP_DEFAULT_TIMER_S;
  private holdtimeS = LLDP_DEFAULT_HOLDTIME_S;
  private reinitS = LLDP_DEFAULT_REINIT_S;
  /** Taking-part ports with `no lldp transmit` / `no lldp receive`, as last read. */
  private noTransmit = new Set<PortId>();
  private noReceive = new Set<PortId>();
  private nextTxAt: SimTime | undefined;
  private ageAt: SimTime | undefined;
  private sent = 0;
  private received = 0;
  private errors = 0;

  init(ctx: ProcessCtx): Action[] {
    this.readConfig(ctx);
    if (!this.running) return [];
    const actions: Action[] = [];
    for (const view of discoveryPorts(ctx)) if (view.operUp && !this.noTransmit.has(view.id)) actions.push(this.advertise(ctx, view.id));
    if (actions.length > 0) actions.push(...this.armTx(ctx));
    return actions;
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const layer = pdu.layer('lldp');
    if (layer === undefined || layer.error !== undefined) {
      this.errors++;
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: LLDP_DETAIL_NOT_A_FRAME, port }];
    }
    if (!this.running) return [{ type: 'drop', pdu, reason: 'not-for-me', detail: LLDP_DETAIL_OFF, port }];
    const view = ctx.ports.get(port);
    if (view === undefined || !discoveryPortEligible(ctx.model, view) || this.noReceive.has(port)) {
      return [{ type: 'drop', pdu, reason: 'not-for-me', detail: lldpReceiveOffDetail(port), port }];
    }
    const table = this.table(ctx);
    const row = lldpNeighbourRow(port, layer.fields, ctx.now);
    if (table === undefined || row === undefined) {
      this.errors++;
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: LLDP_DETAIL_NOT_A_FRAME, port }];
    }
    this.received++;
    const who = row.systemName ?? row.chassisId;
    this.emit(ctx, `received LLDP from ${who} on ${port}, ttl ${row.ttlS} s`, { port, from: who, pdu: pdu.id });
    const prev = table.get(row.key);
    if (row.ttlS === 0) {
      // an IEEE shutdown advertisement: the neighbour leaves at once
      if (prev !== undefined) {
        table.delete(row.key, 'cleared');
        this.emit(ctx, `neighbour ${who} on ${port} removed: it stopped advertising`, { port, neighbour: who, reason: 'cleared' });
      }
      return [{ type: 'consume', pdu }, ...this.armAge(ctx, table)];
    }
    table.set(row);
    if (prev === undefined) this.emit(ctx, `new neighbour ${who} on ${port} (its ${row.portId})`, { port, neighbour: who });
    else if (discoveryRowChanged(prev, row)) this.emit(ctx, `neighbour ${who} on ${port} changed its advertisement`, { port, neighbour: who });
    return [{ type: 'consume', pdu }, ...this.armAge(ctx, table)];
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key === LLDP_TX_TIMER) return this.onTx(ctx);
    if (key === LLDP_AGE_TIMER) return this.onAge(ctx);
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isLldpDelta(delta)) return [];
    const wasRunning = this.running;
    const wasNoTransmit = this.noTransmit;
    const wasNoReceive = this.noReceive;
    const wasTimer = this.timerS;
    this.readConfig(ctx);
    const cause = `${delta.op === 'unset' ? 'no ' : ''}${delta.line.join(' ')}`;
    const actions: Action[] = [];
    if (!this.running) {
      if (wasRunning) this.stop(ctx, cause, actions);
      return actions;
    }
    if (!wasRunning) {
      this.emit(ctx, `LLDP is now running (${cause})`, { cause });
      for (const view of discoveryPorts(ctx)) if (view.operUp && !this.noTransmit.has(view.id)) actions.push(this.advertise(ctx, view.id));
      if (actions.length > 0) actions.push(...this.armTx(ctx));
      return actions;
    }
    const table = this.table(ctx);
    let sentNow = false;
    for (const view of discoveryPorts(ctx)) {
      const rxOff = this.noReceive.has(view.id);
      if (rxOff !== wasNoReceive.has(view.id)) {
        this.emit(ctx, `LLDP receive is ${rxOff ? 'off' : 'on again'} on ${view.id}`, { port: view.id });
        if (rxOff && table !== undefined) this.removePortRows(ctx, table, view.id, 'cleared');
      }
      const txOff = this.noTransmit.has(view.id);
      if (txOff !== wasNoTransmit.has(view.id)) {
        this.emit(ctx, `LLDP transmit is ${txOff ? 'off' : 'on again'} on ${view.id}`, { port: view.id });
        if (!txOff && view.operUp) {
          actions.push(this.advertise(ctx, view.id));
          sentNow = true;
        }
      }
    }
    if (table !== undefined) actions.push(...this.armAge(ctx, table));
    if (this.nextTxAt === undefined) {
      if (sentNow) actions.push(...this.armTx(ctx));
    } else if (this.timerS !== wasTimer) {
      actions.push(...this.armTx(ctx));
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
    if (this.noTransmit.has(port)) return [];
    const actions: Action[] = [this.advertise(ctx, port)];
    if (this.nextTxAt === undefined) actions.push(...this.armTx(ctx));
    return actions;
  }

  stateSnapshot(): StateView {
    const state: Record<string, unknown> = {
      running: this.running,
      timerS: this.timerS,
      holdtimeS: this.holdtimeS,
      reinitS: this.reinitS,
      noTransmit: [...this.noTransmit].sort(),
      noReceive: [...this.noReceive].sort(),
      sent: this.sent,
      received: this.received,
      errors: this.errors,
    };
    if (this.nextTxAt !== undefined) state.nextTxAt = this.nextTxAt;
    return { process: LLDP_PROCESS, state };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── configuration and timers ──

  private readConfig(ctx: ProcessCtx): void {
    this.running = lldpRunning(ctx.config);
    this.timerS = lldpTimerS(ctx.config);
    this.holdtimeS = lldpHoldtimeS(ctx.config);
    this.reinitS = lldpReinitS(ctx.config);
    const noTransmit = new Set<PortId>();
    const noReceive = new Set<PortId>();
    for (const view of discoveryPorts(ctx)) {
      if (!lldpPortTransmits(ctx.config, view.id)) noTransmit.add(view.id);
      if (!lldpPortReceives(ctx.config, view.id)) noReceive.add(view.id);
    }
    this.noTransmit = noTransmit;
    this.noReceive = noReceive;
  }

  private table(ctx: ProcessCtx): Table<LldpNeighbourRow> | undefined {
    return ctx.tables.get<LldpNeighbourRow>(LLDP_TABLE);
  }

  private stop(ctx: ProcessCtx, cause: string, actions: Action[]): void {
    const table = this.table(ctx);
    const rows = table?.size ?? 0;
    table?.clear('cleared');
    this.emit(ctx, `LLDP is now off (${cause}); ${rows} neighbour${rows === 1 ? '' : 's'} cleared`, { cause, rows });
    if (this.nextTxAt !== undefined) actions.push({ type: 'cancelTimer', key: LLDP_TX_TIMER });
    if (this.ageAt !== undefined) actions.push({ type: 'cancelTimer', key: LLDP_AGE_TIMER });
    this.nextTxAt = undefined;
    this.ageAt = undefined;
  }

  private armTx(ctx: ProcessCtx): Action[] {
    const delay = this.timerS * SEC;
    this.nextTxAt = ctx.now + delay;
    return [{ type: 'timer', key: LLDP_TX_TIMER, delay, periodic: true }];
  }

  private onTx(ctx: ProcessCtx): Action[] {
    this.nextTxAt = undefined;
    if (!this.running) return [];
    const actions: Action[] = [];
    for (const view of discoveryPorts(ctx)) if (view.operUp && !this.noTransmit.has(view.id)) actions.push(this.advertise(ctx, view.id));
    if (actions.length > 0) actions.push(...this.armTx(ctx));
    return actions;
  }

  private onAge(ctx: ProcessCtx): Action[] {
    this.ageAt = undefined;
    const table = this.table(ctx);
    if (table === undefined) return [];
    for (const row of table.expire(ctx.now)) {
      const who = row.systemName ?? row.chassisId;
      this.emit(ctx, `neighbour ${who} on ${row.localPort} removed: time to live expired`, { port: row.localPort, neighbour: who, reason: 'aged' });
    }
    return this.armAge(ctx, table);
  }

  private armAge(ctx: ProcessCtx, table: Table<LldpNeighbourRow>): Action[] {
    const at = discoveryEarliestExpiry(table.rows());
    if (at === undefined) {
      if (this.ageAt === undefined) return [];
      this.ageAt = undefined;
      return [{ type: 'cancelTimer', key: LLDP_AGE_TIMER }];
    }
    if (at === this.ageAt) return [];
    this.ageAt = at;
    return [{ type: 'timer', key: LLDP_AGE_TIMER, delay: Math.max(0, at - ctx.now), periodic: true }];
  }

  private removePortRows(ctx: ProcessCtx, table: Table<LldpNeighbourRow>, port: PortId, reason: 'link-down' | 'cleared'): void {
    for (const row of table.find((r) => r.localPort === port)) {
      table.delete(row.key, reason);
      const who = row.systemName ?? row.chassisId;
      this.emit(ctx, `neighbour ${who} on ${port} removed: ${reason === 'link-down' ? 'link down' : 'LLDP receive turned off on the port'}`, {
        port, neighbour: who, reason,
      });
    }
  }

  // ── frames ──

  private advertise(ctx: ProcessCtx, port: PortId): Action {
    const bits = lldpCapabilityBits(ctx.model);
    const mac = ctx.macOf(port);
    const adv: { -readonly [K in keyof LldpAdvertisement]: LldpAdvertisement[K] } = {
      chassisId: lldpChassisId(ctx) ?? mac,
      portId: port,
      ttl: this.holdtimeS,
      systemName: ctx.hostname,
      systemDescription: discoverySoftwareText(ctx.model),
      capabilities: bits,
      enabledCapabilities: bits,
    };
    const description = lldpInterfaceDescription(ctx.config, port);
    if (description !== undefined) adv.portDescription = description;
    const address = discoveryManagementAddress(ctx, port);
    if (address !== undefined) adv.mgmtAddress = address;
    const pdu = ctx.newPdu(lldpFrameSpecs(mac, adv), { tag: LLDP_TAG, background: true });
    this.sent++;
    this.emit(ctx, `sent LLDP on ${port}, ttl ${adv.ttl} s`, { port, pdu: pdu.id });
    return { type: 'send', port, pdu };
  }

  private emit(ctx: ProcessCtx, message: string, data: Record<string, unknown>): void {
    ctx.debug(LLDP_DEBUG_PACKETS, message, data);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: LLDP_PROCESS, category: LLDP_DEBUG_PACKETS, message, data });
  }
}

/** Create the LLDP daemon (`name: 'lldp'`, no frame selectors). One instance per device that runs it. */
export function createLldp(): Process {
  return new LldpDaemon();
}
