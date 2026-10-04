/**
 * protocols/syslog-server.ts — [S25] the syslog receiver of servers (ARCHITECTURE-P3 D20, §2.6 `syslog-messages`,
 * §3.7 step 8, §4.2, §4.3, §5.7, §5.8; §7 W3 svc). RFC 3164-style messages over UDP 514, as the logger sends them.
 *
 * Configuration: the extension line `syslog-server enable`, stored at the top level by the host shell's `service syslog
 * on` (and removed by `service syslog off`). Silence (§4.3): without it the daemon opens no socket, writes no row and
 * emits nothing, so a datagram to UDP 514 keeps udp's "port closed" path. With it, it owns socket `syslog-server#514`
 * (0.0.0.0:514) and only listens: it never sends.
 *
 * Every datagram on that socket is one `syslog-messages` row (rule 20; key = String(seq), seq from 1 for the life of
 * the daemon), written at once (no timer, §4.2): `from` (the sender's address), `facility` and `severity` (from the
 * priority), `hostname` (when the header names one), `stamp` (the sender's own timestamp text, as it arrived), the
 * `message`, and `receivedStamp` — this server's clock at receipt (`Jan  6 08:10:03.123`, UTC, with a leading `*`
 * while the clock was never set; the logger's renderer, D20). A message without a valid priority is kept with
 * RFC 3164 §4.3.3's default priority 13 (user, notifications) and its whole text as the message. The table is
 * bounded to 500 rows: the oldest row is deleted ('replaced') before a new one is written.
 *
 * Debug category (§5.8): `syslog` — the socket opened and closed, and one line per message received.
 *
 * stateSnapshot (kind 'syslog-server'): { listening, received, malformed } — `received` counts every message kept,
 *   `malformed` those kept with the default priority.
 *
 * ponytail: no relay, no filtering by facility or severity, no TCP or TLS transport, no RFC 5424 parsing (D20).
 */
import type { ConfigNode } from '../contracts/config.js';
import type { ProcessName } from '../contracts/ids.js';
import { UDP_PORT_SYSLOG, type FieldValue } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { SyslogMessageRow, Table } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { SYSLOG_FACILITY_NAMES, SYSLOG_SEVERITY_NAMES } from '../pdu/codecs/syslog.js';
import { formatLogTimestamp, type TimestampFormat } from './logger.js';

const NAME: ProcessName = 'syslog-server';
/** @since P3 [S25] Debug category (§5.8). */
export const SYSLOG_DEBUG = 'syslog';
/** @since P3 [S25] The daemon's one socket: 0.0.0.0:514. */
export const SYSLOG_SERVER_SOCKET = 'syslog-server#514';
/** @since P3 [S25] Rows kept in the `syslog-messages` table (§2.6). */
export const SYSLOG_MESSAGES_LIMIT = 500;
/** @since P3 [S25] The priority of a message that carries none (RFC 3164 §4.3.3: user, notifications). */
export const SYSLOG_DEFAULT_PRI = 13;
/** @since P3 [S25] How the received stamp is rendered: the server clock, UTC, with milliseconds. */
export const SYSLOG_RECEIVED_FORMAT: TimestampFormat = Object.freeze({ kind: 'datetime', msec: true, localtime: false, showTimezone: false });
const DEBUG_RING = 256;

/** @since P3 [S25] Is the receiver switched on: a top-level `syslog-server enable` (the host's `service syslog on`)? */
export function syslogServerEnabled(root: ConfigNode): boolean {
  let on = false;
  for (const l of configTextLinesOf(root)) {
    if (l.context.length !== 0 || l.tokens[0] !== 'syslog-server' || l.tokens[1] !== 'enable') continue;
    on = !l.negate;
  }
  return on;
}

/** @since P3 [S25] The parts of one received message, from the decoded `syslog` layer (or its absence). */
export interface ReceivedSyslog {
  readonly facility: number;
  readonly severity: number;
  readonly hostname?: string;
  readonly stamp: string;
  readonly message: string;
  /** True when the message carried no valid priority (kept with SYSLOG_DEFAULT_PRI). */
  readonly malformed: boolean;
}

/** @since P3 [S25] Read one message from the fields of a decoded `syslog` layer; `text` is the payload as text. */
export function receivedSyslogOf(fields: Readonly<Record<string, FieldValue>> | undefined, text: string): ReceivedSyslog {
  const pri = fields?.pri;
  if (fields === undefined || typeof pri !== 'number') {
    const message = typeof fields?.message === 'string' ? fields.message : text;
    return { facility: SYSLOG_DEFAULT_PRI >>> 3, severity: SYSLOG_DEFAULT_PRI & 7, stamp: '', message, malformed: true };
  }
  const hostname = typeof fields.hostname === 'string' ? fields.hostname : '';
  const out = {
    facility: pri >>> 3,
    severity: pri & 7,
    stamp: typeof fields.timestamp === 'string' ? fields.timestamp : '',
    message: typeof fields.message === 'string' ? fields.message : '',
    malformed: false,
  };
  return hostname === '' ? out : { ...out, hostname };
}

/** `local7.errors` for debug lines. */
function priorityWords(facility: number, severity: number): string {
  return `${SYSLOG_FACILITY_NAMES[facility] ?? String(facility)}.${SYSLOG_SEVERITY_NAMES[severity] ?? String(severity)}`;
}

/** Create the syslog-server daemon ([S25]; silent until `syslog-server enable`). */
export function createSyslogServer(): Process {
  let listening = false;
  let seq = 0;
  let received = 0;
  let malformed = 0;
  const ring: DebugEvent[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(SYSLOG_DEBUG, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: SYSLOG_DEBUG, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: SYSLOG_DEBUG, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  /** Converge the socket with the configuration (open while enabled, closed otherwise). */
  function sync(ctx: ProcessCtx): Action[] {
    const want = syslogServerEnabled(ctx.config.root);
    if (want === listening) return [];
    listening = want;
    if (want) {
      debug(ctx, `listening for syslog messages on UDP ${UDP_PORT_SYSLOG}`, { socket: SYSLOG_SERVER_SOCKET });
      return [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: SYSLOG_SERVER_SOCKET, family: 4, localAddr: '0.0.0.0', localPort: UDP_PORT_SYSLOG } }];
    }
    debug(ctx, 'stopped listening for syslog messages', { socket: SYSLOG_SERVER_SOCKET });
    return [{ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: SYSLOG_SERVER_SOCKET } }];
  }

  /** One message: one row, the oldest deleted first when the table is full. */
  function receive(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): void {
    const layer = ev.pdu.layers.find((l) => l.proto === 'syslog');
    const msg = receivedSyslogOf(layer?.fields, decoder.decode(ev.data));
    seq++;
    received++;
    if (msg.malformed) malformed++;
    const receivedStamp = formatLogTimestamp(ctx.now, ctx.clock(), SYSLOG_RECEIVED_FORMAT);
    debug(ctx, `${priorityWords(msg.facility, msg.severity)} from ${ev.from}${msg.hostname !== undefined ? ` (${msg.hostname})` : ''}: ${msg.message}`, {
      pdu: ev.pdu.id,
      seq,
      from: ev.from,
      ...(msg.malformed ? { malformed: true } : {}),
    });
    const table: Table<SyslogMessageRow> | undefined = ctx.tables.get<SyslogMessageRow>('syslog-messages');
    if (table === undefined) return;
    while (table.size >= SYSLOG_MESSAGES_LIMIT) {
      const oldest = table.rows()[0];
      if (oldest === undefined) break;
      table.delete(oldest.key, 'replaced');
    }
    const row: SyslogMessageRow = {
      key: String(seq),
      seq,
      from: ev.from,
      facility: msg.facility,
      severity: msg.severity,
      stamp: msg.stamp,
      message: msg.message,
      receivedStamp,
      updatedAt: ctx.now,
    };
    if (msg.hostname !== undefined) row.hostname = msg.hostname;
    table.set(row);
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'the syslog server takes datagrams from its udp socket', port }];
    },

    onConfig(ctx, delta): Action[] {
      return delta.context.length === 0 && delta.line[0] === 'syslog-server' ? sync(ctx) : [];
    },

    onTimer(): Action[] {
      return [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'sock.datagram' && ev.socket === SYSLOG_SERVER_SOCKET) receive(ctx, ev);
      else if (ev.kind === 'sock.error' && ev.socket === SYSLOG_SERVER_SOCKET) {
        debug(ctx, `socket error ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { code: ev.code });
      }
      return [];
    },

    stateSnapshot(): StateView {
      return { process: NAME, state: { listening, received, malformed } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
