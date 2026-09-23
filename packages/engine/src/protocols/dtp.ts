/**
 * protocols/dtp.ts — the trunk negotiation daemon (ARCHITECTURE-P2 D3, D6, D7, D8, §2.6 DtpRow, §3.3, §4.2, §4.3,
 * §5.1, §5.4). The CCNA name "DTP" is used as a name only; the frame is NetForge's own format (pdu/codecs/dtp.ts).
 *
 * It owns the `dtp` table (key = physical port) and derives every port's negotiated operational mode from the
 * running configuration (`readSwitchport`, the one reader, D6) and the messages it hears. eth-switch reads the rows
 * per frame (`operOf` / `channelOperOf`, protocols/l2/membership.ts): a dynamic port is `access` until its row says
 * `trunk`. Frames reach the daemon through eth-switch's physical control dispatch (`deliver`, §3.0 step 2); the
 * daemon declares no `handles`.
 *
 * Who speaks (§3.3 rule 1, the D3 deviation):
 *  - `switchport mode trunk` (negotiating) and `dynamic desirable` ports send a message at link-up and every 30 s
 *    (`dtp-hello:<port>`, periodic);
 *  - a `dynamic auto` port NEVER initiates: it stays silent until it hears a speaking neighbour (trunk or desirable);
 *    from then on it answers at once and sends every 30 s like the others, and it falls silent again when the
 *    neighbour turns out to be access or auto, ages out, or the link goes down;
 *  - an `access` port (negotiating) ONLY answers: every message it receives from a neighbour that is not itself an
 *    access port is answered at once with one message advertising access (an access neighbour's message is consumed
 *    and recorded but never answered — it is static, and two access ports answering each other would never stop),
 *    and when a port becomes access while its row shows a neighbour it sends one such message at once (so a
 *    negotiated trunk drops back immediately, §13 #22). It never sends on a timer;
 *  - `switchport nonegotiate` ports send nothing, keep no row and drop received messages `not-for-me`;
 *  - more generally, a port whose mode changes while its row shows a neighbour announces the new mode with one
 *    message (rule 1(b) generalised: "a neighbour reconfigured says so at once"), so no stale trunk waits for ageing.
 *  Every port defaults to `dynamic auto`, so an untouched switch sends nothing and has no `dtp` row in either
 *  profile (§4.3). The daemon draws no randomness.
 *
 * Rows (§2.6): `{port, admin, oper, status, neighbor?, neighborMode?}`. A `trunk` or `desirable` row exists from
 * link-up; an `auto` or `access` row only once a message was received on the port. `status` is `static` for access
 * and trunk, `waiting` for a dynamic port that has heard nothing, `negotiated` after a message.
 *
 * Decision on every received message (§3.3 rule 3; `negotiateOper`, this port × neighbour's administrative mode):
 *   trunk → trunk always; access → access always;
 *   desirable → access facing access, trunk facing trunk/desirable/auto;
 *   auto → access facing access or auto, trunk facing trunk/desirable.
 * When `oper` changes: tableWrite, `ctx.transition('dtp', …, {machine:'dtp', subject:<port>, from, to})` and
 * `l2Changed {what:'trunk', port}` (eth-switch flushes the port, stp re-derives its instances).
 *
 * Ageing (§3.3 rule 4): `dtp-age:<port>` (periodic flag, re-armed per received message, 300 s). On expiry a dynamic
 * port returns to access (`waiting`, auto falls silent), a trunk row forgets its neighbour, an access row is
 * deleted. Link down: a trunk row goes back to `static`, a desirable row to `waiting` (oper access), an auto or
 * access row is deleted (nothing has been received on the new link yet); timers are cancelled.
 *
 * Port-channels (§3.3 rule 5): negotiation runs on the physical members only (a `channel` port never gets a row);
 * eth-switch derives the bundle's oper mode from its bundled members' rows and etherchannel suspends a member that
 * negotiated differently.
 *
 * Message: `[ethernet {dst NF_L2_CONTROL_MAC, src port MAC, type 0 → 802.3 length}, llc {SNAP, oui NF_OUI, type
 * NF_PID_DTP}, dtp {version 1, domain '', adminMode, operTrunk, trunkType 1, neighbor: port MAC}]`,
 * `meta {tag:'dtp', background:true}` (`triggeredBy` set on an answer).
 *
 * `stateSnapshot()`: `{ process: 'dtp', state: { speaking: [ports ascending], sent, received } }`.
 * Debug category: 'dtp' (§5.4).
 */
import type { MacAddress } from '../contracts/addr.js';
import { ROLE_TRAITS, defaultRoleFor } from '../contracts/catalog.js';
import type { PortRole } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_DTP } from '../contracts/pdu.js';
import type { LayerSpec, Pdu } from '../contracts/pdu.js';
import type { PortView, SwitchportConfig, SwitchportMode } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { DtpRow, Table } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { DTP_MODE_ACCESS, DTP_MODE_AUTO, DTP_MODE_DESIRABLE, DTP_MODE_TRUNK, DTP_TRUNK_DOT1Q, dtpModeText } from '../pdu/codecs/dtp.js';
import { interfaceOfContext, readSwitchport, switchportModeText } from './l2/switchport-config.js';

/** Process name registered by the catalog for managed switches. */
export const DTP_PROCESS = 'dtp';
/** Debug category of this daemon (`debug dtp`, §5.4). */
export const DTP_DEBUG_CATEGORY = 'dtp';
/** Capacity of the per-process DebugEvent ring. */
export const DTP_DEBUG_RING = 100;
/** `meta.tag` of every message the daemon sends. */
export const DTP_TAG = 'dtp';
/** Interval of the periodic message of a speaking port (§3.3 rule 1). */
export const DTP_HELLO_NS: SimTime = 30 * SEC;
/** Silence after which a neighbour is forgotten (§3.3 rule 4). */
export const DTP_AGE_NS: SimTime = 300 * SEC;
/** Timer key prefixes (§4.2): both periodic, so `runToIdle` never waits for them. */
export const DTP_HELLO_TIMER_PREFIX = 'dtp-hello:';
export const DTP_AGE_TIMER_PREFIX = 'dtp-age:';
/** `dtp-hello:<port>`. */
export const dtpHelloTimer = (port: PortId): string => `${DTP_HELLO_TIMER_PREFIX}${port}`;
/** `dtp-age:<port>`. */
export const dtpAgeTimer = (port: PortId): string => `${DTP_AGE_TIMER_PREFIX}${port}`;

/** Drop detail of a message received on a port that does not negotiate (`switchport nonegotiate`, or not a switched port). */
export function dtpNotNegotiatingDetail(port: PortId): string {
  return `${port} does not take part in trunk negotiation`;
}
/** Drop detail of a frame handed over that is not a decodable trunk negotiation message. */
export const DTP_DETAIL_NOT_A_MESSAGE = 'not a trunk negotiation message';
/** Transition cause when the neighbour aged out. */
export const DTP_CAUSE_AGED = `no trunk negotiation message for ${DTP_AGE_NS / SEC} s`;
/** Transition cause when the link went down. */
export const DTP_CAUSE_LINK_DOWN = 'link down';

/** Operational trunking state of a port. */
export type DtpOper = DtpRow['oper'];

/** The administrative mode carried on the wire (`dtp.adminMode`) of a switchport mode. */
export function dtpAdminModeOf(mode: SwitchportMode): number {
  switch (mode) {
    case 'access':
      return DTP_MODE_ACCESS;
    case 'trunk':
      return DTP_MODE_TRUNK;
    case 'dynamic-desirable':
      return DTP_MODE_DESIRABLE;
    case 'dynamic-auto':
      return DTP_MODE_AUTO;
  }
}

/** The switchport mode named by a wire `adminMode` value, or undefined for an unknown value. */
export function dtpModeOf(adminMode: unknown): SwitchportMode | undefined {
  switch (adminMode) {
    case DTP_MODE_ACCESS:
      return 'access';
    case DTP_MODE_TRUNK:
      return 'trunk';
    case DTP_MODE_DESIRABLE:
      return 'dynamic-desirable';
    case DTP_MODE_AUTO:
      return 'dynamic-auto';
    default:
      return undefined;
  }
}

/** True for a mode that initiates negotiation on its own (§3.3 rule 1): trunk (negotiating) and dynamic desirable. */
export function isDtpInitiator(mode: SwitchportMode): boolean {
  return mode === 'trunk' || mode === 'dynamic-desirable';
}

/** True for a dynamic mode (its oper mode comes from the row). */
export function isDynamicMode(mode: SwitchportMode): boolean {
  return mode === 'dynamic-auto' || mode === 'dynamic-desirable';
}

/**
 * The §3.3 decision matrix: the oper mode of a port in `mode` facing a neighbour whose last message advertised
 * `neighbour` (undefined = nothing heard, or a silent nonegotiate neighbour). Static modes never move.
 */
export function negotiateOper(mode: SwitchportMode, neighbour: SwitchportMode | undefined): DtpOper {
  if (mode === 'trunk') return 'trunk';
  if (mode === 'access') return 'access';
  if (neighbour === undefined || neighbour === 'access') return 'access';
  if (neighbour === 'trunk' || neighbour === 'dynamic-desirable') return 'trunk';
  // neighbour dynamic-auto: only a desirable port pulls it up
  return mode === 'dynamic-desirable' ? 'trunk' : 'access';
}

/** The row status of a port in `mode` that has (`heard`) or has not heard a neighbour. */
export function dtpStatusOf(mode: SwitchportMode, heard: boolean): DtpRow['status'] {
  if (!isDynamicMode(mode)) return 'static';
  return heard ? 'negotiated' : 'waiting';
}

/** Layer specs of one message from port MAC `mac` advertising `mode` and whether the sender is trunking. */
export function dtpFrameSpecs(mac: MacAddress, mode: SwitchportMode, operTrunk: boolean): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: mac, type: 0 } },
    { proto: 'llc', fields: { oui: NF_OUI, type: NF_PID_DTP } },
    { proto: 'dtp', fields: { version: 1, domain: '', adminMode: dtpAdminModeOf(mode), operTrunk, trunkType: DTP_TRUNK_DOT1Q, neighbor: mac } },
  ];
}

/** True when `delta` is a `switchport mode …` or `switchport nonegotiate` line of an interface section (§5.1, the lines dtp consumes). */
export function isDtpDelta(delta: Pick<ConfigDelta, 'context' | 'line'>): boolean {
  if (interfaceOfContext(delta.context) === undefined) return false;
  const [a, b] = delta.line;
  return a === 'switchport' && (b === 'mode' || b === 'nonegotiate');
}

/** Bounded ring of DebugEvents, newest last. */
class DebugRing {
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

/** Effective role of a port: live role, else the spec default for the model capabilities. */
function roleOf(ctx: ProcessCtx, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** A row with the optional members present only when set (rows are compared with `toEqual` in tests and snapshots). */
function makeRow(port: PortId, admin: SwitchportMode, oper: DtpOper, status: DtpRow['status'], now: SimTime, neighbor?: MacAddress, neighborMode?: SwitchportMode): DtpRow {
  const row: DtpRow = { key: port, port, admin, oper, status, updatedAt: now };
  if (neighbor !== undefined) row.neighbor = neighbor;
  if (neighborMode !== undefined) row.neighborMode = neighborMode;
  return row;
}

function sameRow(a: DtpRow | undefined, b: DtpRow): boolean {
  return a !== undefined && a.admin === b.admin && a.oper === b.oper && a.status === b.status && a.neighbor === b.neighbor && a.neighborMode === b.neighborMode;
}

class DtpDaemon implements Process {
  readonly name = DTP_PROCESS;

  private readonly ring = new DebugRing(DTP_DEBUG_RING);
  /** Ports whose `dtp-hello:<port>` timer is armed. */
  private readonly speaking = new Set<PortId>();
  /** Ports whose `dtp-age:<port>` timer is armed. */
  private readonly ageing = new Set<PortId>();
  private sent = 0;
  private received = 0;

  init(ctx: ProcessCtx): Action[] {
    // Physical ports come up after boot (link recompute → onLinkChange); a port that is already up is started here.
    const actions: Action[] = [];
    for (const view of ctx.ports.values()) {
      if (view.operUp && this.eligible(ctx, view)) actions.push(...this.linkUp(ctx, view.id));
    }
    return actions;
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const layer = pdu.layer('dtp');
    if (layer === undefined || layer.error !== undefined) {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: DTP_DETAIL_NOT_A_MESSAGE, port }];
    }
    const table = this.table(ctx);
    const view = ctx.ports.get(port);
    const config = readSwitchport(ctx.config, port, ctx.model);
    if (table === undefined || view === undefined || !this.eligible(ctx, view) || !config.negotiate) {
      // a nonegotiate port ignores negotiation: dropped without a word, no row (§3.3 rule 1)
      return [{ type: 'drop', pdu, reason: 'not-for-me', detail: dtpNotNegotiatingDetail(port), port }];
    }
    const neighbourMode = dtpModeOf(layer.fields.adminMode);
    if (neighbourMode === undefined) {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `unknown administrative mode ${String(layer.fields.adminMode)}`, port }];
    }
    const neighbor = (typeof layer.fields.neighbor === 'string' ? layer.fields.neighbor : String(pdu.get('ethernet.src') ?? '')) as MacAddress;
    const trunking = layer.fields.operTrunk === true;
    this.received++;
    this.emit(ctx, `received trunk negotiation on ${port} from ${neighbor}: ${dtpModeText(dtpAdminModeOf(neighbourMode))}, ${trunking ? 'trunking' : 'not trunking'}`, {
      port, neighbor, neighborMode: neighbourMode, trunking, pdu: pdu.id,
    });

    const actions: Action[] = [{ type: 'consume', pdu }];
    const prev = table.get(port);
    const oper = negotiateOper(config.mode, neighbourMode);
    const row = makeRow(port, config.mode, oper, dtpStatusOf(config.mode, true), ctx.now, neighbor, neighbourMode);
    const wasSpeaking = this.speaking.has(port);
    this.write(ctx, table, prev, row, `neighbour ${neighbor} advertises ${switchportModeText(neighbourMode)}`, actions, pdu);
    actions.push({ type: 'timer', key: dtpAgeTimer(port), delay: DTP_AGE_NS, periodic: true });
    this.ageing.add(port);

    if (config.mode === 'access') {
      // answers only, at once, never on a timer — and only a neighbour that can still change its mind: an access
      // neighbour is static (its oper mode never moves), so answering it carries no information, and two access
      // ports answering each other would never stop (§3.3 rule 1a). Its message is still consumed and recorded.
      if (neighbourMode !== 'access') actions.push(this.message(ctx, port, config.mode, oper, pdu));
    } else if (config.mode === 'dynamic-auto') {
      if (isDtpInitiator(neighbourMode)) {
        if (!wasSpeaking) {
          actions.push(this.message(ctx, port, config.mode, oper, pdu));
          actions.push(...this.armHello(port));
        }
      } else if (wasSpeaking) {
        actions.push(...this.disarmHello(port));
      }
    }
    return actions;
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key.startsWith(DTP_HELLO_TIMER_PREFIX)) return this.onHello(ctx, key.slice(DTP_HELLO_TIMER_PREFIX.length));
    if (key.startsWith(DTP_AGE_TIMER_PREFIX)) return this.onAge(ctx, key.slice(DTP_AGE_TIMER_PREFIX.length));
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isDtpDelta(delta)) return [];
    const port = interfaceOfContext(delta.context);
    if (port === undefined) return [];
    return this.reconcile(ctx, port, `${delta.op === 'unset' ? 'no ' : ''}${delta.line.join(' ')}`);
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const view = ctx.ports.get(port);
    if (view === undefined || !this.eligible(ctx, view)) return [];
    return up ? this.linkUp(ctx, port) : this.linkDown(ctx, port);
  }

  onEvent(_ctx: ProcessCtx, _ev: ProcessEvent): Action[] {
    // `l2.changed` from vlan, etherchannel, stp or eth-switch changes nothing here: the row follows the port's own
    // configuration and neighbour; a bundle's oper mode is derived by eth-switch from the members' rows.
    return [];
  }

  stateSnapshot(): StateView {
    return { process: DTP_PROCESS, state: { speaking: [...this.speaking].sort(), sent: this.sent, received: this.received } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── link and configuration ──

  /** A port takes part when it is a physical bridged port (never a Port-channel, SVI, routed or radio port). */
  private eligible(ctx: ProcessCtx, view: PortView): boolean {
    const traits = ROLE_TRAITS[roleOf(ctx, view)];
    return traits.bridged && !traits.virtual && traits.linkable;
  }

  private table(ctx: ProcessCtx): Table<DtpRow> | undefined {
    return ctx.tables.get<DtpRow>('dtp');
  }

  /** Link-up: an initiator writes its row and speaks at once; auto and access ports wait (§3.3 rule 1). */
  private linkUp(ctx: ProcessCtx, port: PortId): Action[] {
    const table = this.table(ctx);
    if (table === undefined) return [];
    const config = readSwitchport(ctx.config, port, ctx.model);
    if (!config.negotiate || !isDtpInitiator(config.mode)) return [];
    const actions: Action[] = [];
    const prev = table.get(port);
    const oper = negotiateOper(config.mode, undefined);
    this.write(ctx, table, prev, makeRow(port, config.mode, oper, dtpStatusOf(config.mode, false), ctx.now), 'link up', actions);
    actions.push(this.message(ctx, port, config.mode, oper));
    actions.push(...this.armHello(port));
    return actions;
  }

  /** Link-down: timers off; a trunk row back to static, a desirable row to waiting, an auto or access row deleted. */
  private linkDown(ctx: ProcessCtx, port: PortId): Action[] {
    const actions: Action[] = [];
    actions.push(...this.disarmHello(port), ...this.disarmAge(port));
    const table = this.table(ctx);
    const prev = table?.get(port);
    if (table === undefined || prev === undefined) return actions;
    if (isDtpInitiator(prev.admin)) {
      const oper = negotiateOper(prev.admin, undefined);
      this.write(ctx, table, prev, makeRow(port, prev.admin, oper, dtpStatusOf(prev.admin, false), ctx.now), DTP_CAUSE_LINK_DOWN, actions);
    } else {
      this.remove(ctx, table, prev, 'link-down', DTP_CAUSE_LINK_DOWN, 'access', actions);
    }
    return actions;
  }

  /** A `switchport mode` or `switchport nonegotiate` line changed on `port` (`cause` = the line, for the transition). */
  private reconcile(ctx: ProcessCtx, port: PortId, cause: string): Action[] {
    const table = this.table(ctx);
    const view = ctx.ports.get(port);
    if (table === undefined || view === undefined) return [];
    const actions: Action[] = [];
    const prev = table.get(port);
    const config = readSwitchport(ctx.config, port, ctx.model);
    if (!this.eligible(ctx, view) || !config.negotiate) {
      // no negotiation on this port: nothing is sent, no row is kept
      actions.push(...this.disarmHello(port), ...this.disarmAge(port));
      if (prev !== undefined) this.remove(ctx, table, prev, 'cleared', cause, negotiateOper(config.mode, undefined), actions);
      return actions;
    }
    const heard = prev?.neighbor !== undefined;
    const neighbourMode = prev?.neighborMode;
    if (!view.operUp) {
      // rows exist from link-up: only an existing row follows the new mode while the port is down
      if (prev === undefined) return actions;
      if (isDtpInitiator(config.mode)) {
        this.write(ctx, table, prev, makeRow(port, config.mode, negotiateOper(config.mode, undefined), dtpStatusOf(config.mode, false), ctx.now), cause, actions);
      } else {
        this.remove(ctx, table, prev, 'cleared', cause, 'access', actions);
      }
      return actions;
    }
    const oper = negotiateOper(config.mode, neighbourMode);
    if (isDtpInitiator(config.mode) || heard) {
      const row = heard
        ? makeRow(port, config.mode, oper, dtpStatusOf(config.mode, true), ctx.now, prev?.neighbor, neighbourMode)
        : makeRow(port, config.mode, oper, dtpStatusOf(config.mode, false), ctx.now);
      this.write(ctx, table, prev, row, cause, actions);
    } else if (prev !== undefined) {
      this.remove(ctx, table, prev, 'cleared', cause, 'access', actions);
    }
    // who speaks now (§3.3 rule 1): initiators always; an auto port only facing a speaking neighbour; access never
    const speaks = isDtpInitiator(config.mode) || (config.mode === 'dynamic-auto' && heard && neighbourMode !== undefined && isDtpInitiator(neighbourMode));
    if (isDtpInitiator(config.mode) || heard) actions.push(this.message(ctx, port, config.mode, oper));
    if (speaks) actions.push(...this.armHello(port));
    else actions.push(...this.disarmHello(port));
    return actions;
  }

  // ── timers ──

  private onHello(ctx: ProcessCtx, port: PortId): Action[] {
    if (!this.speaking.has(port)) return [];
    const view = ctx.ports.get(port);
    const table = this.table(ctx);
    if (view === undefined || !view.operUp || table === undefined) return this.disarmHello(port);
    const config = readSwitchport(ctx.config, port, ctx.model);
    const row = table.get(port);
    const oper = row?.oper ?? negotiateOper(config.mode, undefined);
    return [this.message(ctx, port, config.mode, oper), ...this.armHello(port)];
  }

  /** The neighbour of `port` was silent for `DTP_AGE_NS` (§3.3 rule 4). */
  private onAge(ctx: ProcessCtx, port: PortId): Action[] {
    this.ageing.delete(port);
    const table = this.table(ctx);
    const prev = table?.get(port);
    if (table === undefined || prev === undefined) return [];
    const actions: Action[] = [];
    this.emit(ctx, `neighbour of ${port} aged out after ${DTP_AGE_NS / SEC} s of silence`, { port, neighbor: prev.neighbor });
    if (prev.admin === 'access') {
      this.remove(ctx, table, prev, 'aged', DTP_CAUSE_AGED, 'access', actions);
      return actions;
    }
    const oper = negotiateOper(prev.admin, undefined);
    this.write(ctx, table, prev, makeRow(port, prev.admin, oper, dtpStatusOf(prev.admin, false), ctx.now), DTP_CAUSE_AGED, actions);
    if (prev.admin === 'dynamic-auto') actions.push(...this.disarmHello(port));
    return actions;
  }

  private armHello(port: PortId): Action[] {
    this.speaking.add(port);
    return [{ type: 'timer', key: dtpHelloTimer(port), delay: DTP_HELLO_NS, periodic: true }];
  }

  private disarmHello(port: PortId): Action[] {
    if (!this.speaking.delete(port)) return [];
    return [{ type: 'cancelTimer', key: dtpHelloTimer(port) }];
  }

  private disarmAge(port: PortId): Action[] {
    if (!this.ageing.delete(port)) return [];
    return [{ type: 'cancelTimer', key: dtpAgeTimer(port) }];
  }

  // ── rows, messages, transitions ──

  /** One message out `port` (`answering` = the received message it answers). */
  private message(ctx: ProcessCtx, port: PortId, mode: SwitchportMode, oper: DtpOper, answering?: Pdu): Action {
    const mac = ctx.macOf(port);
    const meta = answering === undefined ? { tag: DTP_TAG, background: true } : { tag: DTP_TAG, background: true, triggeredBy: answering.id };
    const pdu = ctx.newPdu(dtpFrameSpecs(mac, mode, oper === 'trunk'), meta);
    this.sent++;
    this.emit(ctx, `sent trunk negotiation on ${port}: ${switchportModeText(mode)}, ${oper === 'trunk' ? 'trunking' : 'not trunking'}`, {
      port, mode, oper, pdu: pdu.id,
    });
    return { type: 'send', port, pdu };
  }

  /** Write `row` when it differs from `prev`; report an oper change (transition + l2Changed). */
  private write(ctx: ProcessCtx, table: Table<DtpRow>, prev: DtpRow | undefined, row: DtpRow, cause: string, actions: Action[], pdu?: Pdu): void {
    if (sameRow(prev, row)) return;
    table.set(row);
    const from = prev?.oper ?? 'access';
    if (from !== row.oper) this.changed(ctx, row.port, from, row.oper, cause, actions, pdu);
  }

  /** Delete the row of `prev`; report an oper change when the port's mode without a row (`oper`) differs. */
  private remove(ctx: ProcessCtx, table: Table<DtpRow>, prev: DtpRow, reason: 'aged' | 'cleared' | 'link-down', cause: string, oper: DtpOper, actions: Action[]): void {
    table.delete(prev.key, reason);
    if (prev.oper !== oper) this.changed(ctx, prev.port, prev.oper, oper, cause, actions);
  }

  /** The oper mode of `port` moved: exactly one transition debug event and the L2 change signal (§3.3 rule 3). */
  private changed(ctx: ProcessCtx, port: PortId, from: DtpOper, to: DtpOper, cause: string, actions: Action[], pdu?: Pdu): void {
    const fsm = pdu === undefined
      ? { machine: 'dtp' as const, subject: port, port, from, to, cause }
      : { machine: 'dtp' as const, subject: port, port, from, to, cause, pdu: pdu.id };
    const message = `${port} is now ${to === 'trunk' ? 'trunking' : 'not trunking'} (${cause})`;
    ctx.transition(DTP_DEBUG_CATEGORY, message, fsm, { port, from, to });
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: DTP_PROCESS, category: DTP_DEBUG_CATEGORY, message, data: { port, from, to }, fsm });
    actions.push({ type: 'l2Changed', what: 'trunk', port });
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(DTP_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: DTP_PROCESS, category: DTP_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: DTP_PROCESS, category: DTP_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the trunk negotiation daemon (`name: 'dtp'`, no frame selectors). One instance per managed switch. */
export function createDtp(): Process {
  return new DtpDaemon();
}
