/**
 * protocols/hdlc.ts — the serial HDLC keepalive daemon (ARCHITECTURE-P1 D6, §3.9; spec §2.1 WAN serial links).
 *
 * The daemon owns the keepalive exchange of every serial port whose effective encapsulation is `hdlc` and whose
 * role is `wan` (router serial interfaces) or `access-line`. IP over the link is not its business: ipv4 declares
 * `{layer:'hdlc', ethertype:0x0800, roles:['wan']}` and `arp.sendVia` frames packets in HDLC without resolution.
 *
 * Behaviour
 *  • CARRIER — at `init` the daemon reads `phy.carrier` of each serial port; afterwards it learns carrier changes
 *    only from MediumEvent `{kind:'carrier', up}` (never from `onLinkChange`, which reports operUp and cannot show
 *    "carrier up, line protocol down"). A carrier change clears this end's reported state (the link model clears
 *    the keepalive latches on loss of carrier).
 *  • TIMER — the periodic timer `ka:<port>` (every `keepalive` seconds, default 10) is armed iff carrier is up and
 *    keepalives are enabled, and cancelled otherwise. Silence rule: without a serial carrier nothing is sent.
 *  • TICK — each firing closes an interval: no keepalive heard since the previous firing → one more miss; a
 *    keepalive heard → misses reset. `HDLC_KEEPALIVE_MISSES` (3) consecutive misses → `Action medium
 *    {op:'line-protocol', up:false, reason:'keepalive-missed'}` once, which latches THIS end down in the link
 *    model. Then a keepalive is sent: `[hdlc {address 0x8f, control 0, protocol 0x8035}, payload 12 B (myseq u32,
 *    yourseq u32, reliability u16, reserved u16)]` with `meta {tag 'keepalive', background true}`. A line that is
 *    not clocked (`no-clock`, `encapsulation-mismatch`) sends nothing and counts nothing: keepalives need a
 *    clocked carrier.
 *  • RECEIVE — a keepalive refreshes `yourseq` and marks the interval as heard; while this end is reported down it
 *    sends `line-protocol up:true` (the link model exempts keepalives from the link-down gate for an end that is
 *    down only by its latch, in both directions, so the line can recover). The frame is consumed.
 *  • CONFIG — under `interface <serial>`: `keepalive <s>` (0 disables), `keepalive` (default 10 s), `no keepalive`
 *    (stored negation: disabled). With keepalives disabled the daemon neither sends nor counts misses nor reports;
 *    disabling while this end is reported down reports `line-protocol up:true` once (the latch it set is its own).
 *    A new period re-arms the timer at once.
 *
 * Example (acceptance): R2 `keepalive 0` stays up/up; R1 misses three intervals and alone reports
 * `keepalive-missed` after 30 s; `keepalive 10` on R2 again → R1 recovers on the next keepalive it receives.
 *
 * Timer keys: `ka:<port>` (periodic). No randomness.
 *
 * stateSnapshot():
 *   { process: 'hdlc', state: { lines: [{ port, intervalNs, carrier, armed, misses, lineProtocolDown, mySeq,
 *     yourSeq, sent, received }], sent, received } }  — lines in first-seen order.
 *
 * Debug category: 'serial'.
 */
import { KIND_ENCAP, defaultRoleFor } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { MediumEvent } from '../contracts/medium.js';
import { HDLC_ADDRESS_BROADCAST, HDLC_PROTO_KEEPALIVE } from '../contracts/pdu.js';
import type { Pdu } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { HDLC_KEEPALIVE_DEFAULT_NS, HDLC_KEEPALIVE_MISSES } from '../contracts/services.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';

/** Process name, as registered in the protocol registry. */
export const HDLC_PROCESS = 'hdlc';
/** Debug category (`debug serial`). */
export const HDLC_DEBUG_CATEGORY = 'serial';
/** Prefix of the per-port periodic keepalive timer key. */
export const HDLC_KEEPALIVE_TIMER_PREFIX = 'ka:';
/** Keepalive body size: myseq u32, yourseq u32, reliability u16, reserved u16. */
export const HDLC_KEEPALIVE_PAYLOAD_BYTES = 12;
/** Reliability value written into every keepalive. */
export const HDLC_KEEPALIVE_RELIABILITY = 0xffff;
/** Largest `keepalive <seconds>` value accepted. */
export const HDLC_KEEPALIVE_MAX_SECONDS = 32767;
/** `PduMeta.tag` of keepalive frames. */
export const HDLC_KEEPALIVE_TAG = 'keepalive';
/** Roles whose serial ports run keepalives. */
export const HDLC_DAEMON_ROLES: readonly PortRole[] = Object.freeze(['wan', 'access-line'] as PortRole[]);
/** Wire selector: HDLC keepalives on serial WAN and access-line ports. */
export const HDLC_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'hdlc', ethertype: HDLC_PROTO_KEEPALIVE, roles: HDLC_DAEMON_ROLES }),
]) as readonly DemuxSelector[];
/** DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** u32 wrap. */
const U32 = 0x1_0000_0000;

/** Keepalive state of one serial port. */
interface SerialLine {
  readonly port: PortId;
  /** Keepalive period; 0 = keepalives disabled. */
  intervalNs: SimTime;
  /** Last carrier state learned (init or MediumEvent). */
  carrier: boolean;
  /** `ka:<port>` is scheduled. */
  armed: boolean;
  /** A keepalive arrived since the previous tick. */
  heard: boolean;
  /** Consecutive intervals without a keepalive. */
  misses: number;
  /** This end reported `line-protocol up:false` and has not reported recovery yet. */
  down: boolean;
  mySeq: number;
  yourSeq: number;
  sent: number;
  received: number;
}

/** Decoded keepalive body. */
export interface KeepaliveBody {
  mySeq: number;
  yourSeq: number;
  reliability: number;
}

/** Timer key of a port's keepalive timer: `ka:<port>`. */
export function keepaliveTimerKey(port: PortId): string {
  return `${HDLC_KEEPALIVE_TIMER_PREFIX}${port}`;
}

/** `keepalive <seconds>` token → seconds (0..HDLC_KEEPALIVE_MAX_SECONDS), undefined when not a plain integer in range. */
export function parseKeepaliveSeconds(token: string | undefined): number | undefined {
  if (token === undefined || !/^[0-9]+$/.test(token)) return undefined;
  const n = Number(token);
  return n <= HDLC_KEEPALIVE_MAX_SECONDS ? n : undefined;
}

/** Keepalive body bytes (big-endian). */
export function encodeKeepalivePayload(mySeq: number, yourSeq: number): Uint8Array {
  const out = new Uint8Array(HDLC_KEEPALIVE_PAYLOAD_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, mySeq >>> 0);
  view.setUint32(4, yourSeq >>> 0);
  view.setUint16(8, HDLC_KEEPALIVE_RELIABILITY);
  view.setUint16(10, 0);
  return out;
}

/** Parse a keepalive body; undefined when shorter than 12 bytes. */
export function decodeKeepalivePayload(data: Uint8Array): KeepaliveBody | undefined {
  if (data.length < HDLC_KEEPALIVE_PAYLOAD_BYTES) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { mySeq: view.getUint32(0), yourSeq: view.getUint32(4), reliability: view.getUint16(8) };
}

/** Keepalive period configured for `port` in a running config (default 10 s; `no keepalive` / `keepalive 0` → 0). */
export function keepaliveIntervalFromConfig(config: ConfigAst, port: PortId): SimTime {
  for (const section of config.root.children) {
    if (section.key !== 'interface' || section.args[0] !== port) continue;
    let interval = HDLC_KEEPALIVE_DEFAULT_NS;
    for (const child of section.children) {
      if (child.key === 'keepalive') {
        const seconds = child.args.length === 0 ? undefined : parseKeepaliveSeconds(child.args[0]);
        interval = child.args.length === 0 || seconds === undefined ? HDLC_KEEPALIVE_DEFAULT_NS : seconds * SEC;
      } else if (child.key === 'no' && child.args[0] === 'keepalive' && child.args.length === 1) {
        interval = 0;
      }
    }
    return interval;
  }
  return HDLC_KEEPALIVE_DEFAULT_NS;
}

/**
 * Keepalive period implied by an interface config delta, or undefined when the delta is not a keepalive line (or
 * carries an invalid value): set `keepalive` → default; set `keepalive N` → N s; unset `keepalive` (stored
 * negation) → 0; unset `keepalive N` → default; set `no keepalive` → 0; unset `no keepalive` → default.
 */
export function keepaliveIntervalFromDelta(delta: Pick<ConfigDelta, 'op' | 'line'>): SimTime | undefined {
  const line = delta.line;
  if (line[0] === 'keepalive') {
    if (delta.op === 'unset') return line.length === 1 ? 0 : HDLC_KEEPALIVE_DEFAULT_NS;
    if (line.length === 1) return HDLC_KEEPALIVE_DEFAULT_NS;
    const seconds = parseKeepaliveSeconds(line[1]);
    return seconds === undefined ? undefined : seconds * SEC;
  }
  if (line[0] === 'no' && line[1] === 'keepalive' && line.length === 2) {
    return delta.op === 'set' ? 0 : HDLC_KEEPALIVE_DEFAULT_NS;
  }
  return undefined;
}

/** Effective role of a port: live role, else the spec default for the model capabilities. */
function roleOf(ctx: ProcessCtx, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** Effective encapsulation of a port. */
function encapOf(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** Does this daemon run keepalives on `view`? */
function isKeepalivePort(ctx: ProcessCtx, view: PortView | undefined): view is PortView {
  return view !== undefined && encapOf(view) === 'hdlc' && HDLC_DAEMON_ROLES.includes(roleOf(ctx, view));
}

/** Seconds text for debug lines. */
function seconds(ns: SimTime): string {
  const s = ns / SEC;
  return Number.isInteger(s) ? String(s) : s.toFixed(3);
}

/** Create the HDLC keepalive daemon (`name: 'hdlc'`, `handles: HDLC_HANDLES`). One instance per routing device. */
export function createHdlc(): Process {
  const lines = new Map<PortId, SerialLine>();
  const ring: DebugEvent[] = [];
  let started = false;
  let sentTotal = 0;
  let receivedTotal = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(HDLC_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: HDLC_PROCESS, category: HDLC_DEBUG_CATEGORY, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: HDLC_PROCESS, category: HDLC_DEBUG_CATEGORY, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function lineFor(port: PortId): SerialLine {
    let line = lines.get(port);
    if (line === undefined) {
      line = {
        port, intervalNs: HDLC_KEEPALIVE_DEFAULT_NS, carrier: false, armed: false, heard: false, misses: 0, down: false,
        mySeq: 0, yourSeq: 0, sent: 0, received: 0,
      };
      lines.set(port, line);
    }
    return line;
  }

  function arm(ctx: ProcessCtx, line: SerialLine, out: Action[]): void {
    line.armed = true;
    line.heard = false;
    line.misses = 0;
    out.push({ type: 'timer', key: keepaliveTimerKey(line.port), delay: line.intervalNs, periodic: true });
    debug(ctx, `keepalives on ${line.port} every ${seconds(line.intervalNs)} s`, { port: line.port, intervalNs: line.intervalNs });
  }

  function disarm(ctx: ProcessCtx, line: SerialLine, why: string, out: Action[]): void {
    line.heard = false;
    line.misses = 0;
    if (!line.armed) return;
    line.armed = false;
    out.push({ type: 'cancelTimer', key: keepaliveTimerKey(line.port) });
    debug(ctx, `keepalives on ${line.port} stopped: ${why}`, { port: line.port });
  }

  function reportUp(ctx: ProcessCtx, line: SerialLine, why: string, out: Action[]): void {
    if (!line.down) return;
    line.down = false;
    out.push({ type: 'medium', port: line.port, op: { op: 'line-protocol', up: true } });
    debug(ctx, `line protocol on ${line.port} is up again: ${why}`, { port: line.port });
  }

  function tick(ctx: ProcessCtx, line: SerialLine): Action[] {
    const out: Action[] = [];
    const view = ctx.ports.get(line.port);
    const reason = view?.phy?.lineProtocolReason;
    if (view === undefined || reason === 'no-clock' || reason === 'encapsulation-mismatch') {
      line.heard = false;
      line.misses = 0;
      debug(ctx, `no keepalive on ${line.port}: the line is not clocked${reason === undefined ? '' : ` (${reason})`}`, { port: line.port, reason: reason ?? null });
      out.push({ type: 'timer', key: keepaliveTimerKey(line.port), delay: line.intervalNs, periodic: true });
      return out;
    }
    if (line.heard) line.misses = 0;
    else line.misses++;
    line.heard = false;
    if (line.misses >= HDLC_KEEPALIVE_MISSES && !line.down) {
      line.down = true;
      out.push({ type: 'medium', port: line.port, op: { op: 'line-protocol', up: false, reason: 'keepalive-missed' } });
      debug(ctx, `line protocol on ${line.port} is down: ${line.misses} keepalives missed`, { port: line.port, misses: line.misses });
    }
    line.mySeq = (line.mySeq + 1) % U32;
    const pdu = ctx.newPdu(
      [
        { proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE } },
        { proto: 'payload', fields: { data: encodeKeepalivePayload(line.mySeq, line.yourSeq) } },
      ],
      { tag: HDLC_KEEPALIVE_TAG, background: true },
    );
    line.sent++;
    sentTotal++;
    out.push({ type: 'send', port: line.port, pdu });
    debug(ctx, `keepalive out ${line.port} myseq ${line.mySeq} yourseq ${line.yourSeq}`, { port: line.port, pdu: pdu.id, mySeq: line.mySeq, yourSeq: line.yourSeq });
    out.push({ type: 'timer', key: keepaliveTimerKey(line.port), delay: line.intervalNs, periodic: true });
    return out;
  }

  function receive(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const hdlc = pdu.layers[0];
    if (hdlc === undefined || hdlc.proto !== 'hdlc' || hdlc.fields.protocol !== HDLC_PROTO_KEEPALIVE) {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'not an HDLC keepalive', port }];
    }
    const payload = pdu.layers[1];
    const data = payload !== undefined && payload.fields.data instanceof Uint8Array
      ? payload.fields.data
      : pdu.bytes.subarray(hdlc.offset + hdlc.headerLength, hdlc.offset + hdlc.length - (hdlc.trailerLength ?? 0));
    const body = decodeKeepalivePayload(data);
    if (body === undefined) {
      debug(ctx, `malformed keepalive on ${port}: ${data.length} bytes`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: 'malformed keepalive', port }];
    }
    const view = ctx.ports.get(port);
    if (!isKeepalivePort(ctx, view)) {
      debug(ctx, `keepalive on ${port} ignored: not a serial HDLC port`, { port, pdu: pdu.id });
      return [{ type: 'consume', pdu }];
    }
    const line = lineFor(port);
    line.received++;
    receivedTotal++;
    line.yourSeq = body.mySeq;
    const out: Action[] = [{ type: 'consume', pdu }];
    if (line.intervalNs === 0) {
      debug(ctx, `keepalive in ${port} myseq ${body.mySeq}: keepalives are disabled here`, { port, pdu: pdu.id });
      return out;
    }
    line.heard = true;
    line.misses = 0;
    debug(ctx, `keepalive in ${port} myseq ${body.mySeq} yourseq ${body.yourSeq}`, { port, pdu: pdu.id, mySeq: body.mySeq, yourSeq: body.yourSeq });
    reportUp(ctx, line, 'keepalive received', out);
    return out;
  }

  return {
    name: HDLC_PROCESS,
    handles: HDLC_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      started = true;
      const out: Action[] = [];
      for (const view of ctx.ports.values()) {
        if (!isKeepalivePort(ctx, view)) continue;
        const line = lineFor(view.id);
        line.intervalNs = keepaliveIntervalFromConfig(ctx.config, view.id);
        line.carrier = view.phy?.carrier === true;
        if (line.carrier && line.intervalNs > 0) arm(ctx, line, out);
      }
      return out;
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return receive(ctx, pdu, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (!key.startsWith(HDLC_KEEPALIVE_TIMER_PREFIX)) return [];
      const line = lines.get(key.slice(HDLC_KEEPALIVE_TIMER_PREFIX.length));
      if (line === undefined || !line.armed) return [];
      return tick(ctx, line);
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const head = delta.context[0];
      if (delta.context.length !== 1 || head === undefined || head[0] !== 'interface' || head[1] === undefined) return [];
      const port = head[1];
      const interval = keepaliveIntervalFromDelta(delta);
      if (interval === undefined) {
        if (delta.line[0] === 'keepalive' && delta.op === 'set') {
          debug(ctx, `ignored keepalive ${delta.line.slice(1).join(' ')} on ${port}: expected 0 to ${HDLC_KEEPALIVE_MAX_SECONDS} seconds`, { port });
        }
        return [];
      }
      if (!isKeepalivePort(ctx, ctx.ports.get(port))) return [];
      const line = lineFor(port);
      if (line.intervalNs === interval) return [];
      line.intervalNs = interval;
      const out: Action[] = [];
      if (!started) return out;
      if (interval === 0) {
        disarm(ctx, line, 'keepalives disabled', out);
        reportUp(ctx, line, 'keepalives disabled', out);
        return out;
      }
      if (line.carrier) arm(ctx, line, out);
      else debug(ctx, `keepalive period on ${port} is ${seconds(interval)} s; waiting for carrier`, { port, intervalNs: interval });
      return out;
    },

    onMediumEvent(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[] {
      if (ev.kind !== 'carrier') return [];
      if (!isKeepalivePort(ctx, ctx.ports.get(port))) return [];
      const line = lineFor(port);
      line.carrier = ev.up;
      line.down = false;
      const out: Action[] = [];
      debug(ctx, `carrier ${ev.up ? 'up' : 'down'} on ${port}`, { port, up: ev.up });
      if (ev.up && line.intervalNs > 0) arm(ctx, line, out);
      else disarm(ctx, line, ev.up ? 'keepalives disabled' : 'carrier lost', out);
      return out;
    },

    stateSnapshot(): StateView {
      const list: Record<string, unknown>[] = [];
      for (const l of lines.values()) {
        list.push({
          port: l.port, intervalNs: l.intervalNs, carrier: l.carrier, armed: l.armed, misses: l.misses,
          lineProtocolDown: l.down, mySeq: l.mySeq, yourSeq: l.yourSeq, sent: l.sent, received: l.received,
        });
      }
      return { process: HDLC_PROCESS, state: { lines: list, sent: sentTotal, received: receivedTotal } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
