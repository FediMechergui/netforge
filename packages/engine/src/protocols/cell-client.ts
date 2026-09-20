/**
 * protocols/cell-client.ts — the UE-side cellular daemon (ARCHITECTURE-P1 D5, §3.8, §5.2).
 *
 * It manages every port of kind `cellular` whose effective role is `cellular` (a phone's or tablet's cellular
 * adapter). The CellularCell medium (link/media/cell.ts) does the tower choice, the 300 ms attach and the RF hold;
 * this daemon is the only one that ASKS for attachment:
 *
 *  • boot (`init`) with the port admin up          → `Action medium {op:'cell-attach'}`, phase `searching`;
 *  • `no shutdown` on the port (config unset)       → `cell-attach`, phase `searching`;
 *  • `shutdown` on the port (config set)            → `cell-detach` reason 'admin-down', `re-search` cancelled,
 *                                                     phase `disabled`;
 *  • MediumEvent `cell-attached`                    → phase `attached`, `re-search` cancelled;
 *  • MediumEvent `cell-detached`                    → phase `detached`; when the port is admin up the PERIODIC timer
 *                                                     `re-search:<port>` is armed every `CELL_RESEARCH_NS`;
 *  • timer `re-search:<port>` while `detached`      → `cell-attach` again and the timer re-armed (periodic).
 *
 * Silence (§5.3): attachment is behavioural; the daemon never builds a PDU. Randomness: none.
 * The IP stack (arp/ipv4) receives the port's `onLinkChange` from the runtime when the medium reports operUp.
 *
 * StateView: `{ process: 'cell-client', state: { ports: CellClientPortView[] } }` (ports in model order).
 * Debug category: `wireless`.
 */
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId, PortRef } from '../contracts/ids.js';
import { portKey } from '../contracts/ids.js';
import type { MediumEvent } from '../contracts/medium.js';
import type { Pdu } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { SimTime } from '../contracts/time.js';

/** Process name of the UE cellular daemon. */
export const CELL_CLIENT = 'cell-client';

/** Debug category used by the daemon. */
export const CELL_CLIENT_DEBUG_CATEGORY = 'wireless';

/** Interval of the periodic re-search while detached. */
export const CELL_RESEARCH_NS: SimTime = 5_000_000_000;

/** Prefix of the periodic re-search timer key (`re-search:<port>`). */
export const CELL_RESEARCH_TIMER_PREFIX = 're-search:';

/** Reason the daemon gives the medium when the adapter is shut down. */
export const CELL_ADMIN_DOWN_REASON = 'admin-down';

const DEBUG_RING = 64;

/** Daemon phase of one cellular adapter. */
export type CellClientPhase = 'disabled' | 'searching' | 'attached' | 'detached';

/** StateView row of one cellular adapter (structured-clone safe). */
export interface CellClientPortView {
  port: PortId;
  phase: CellClientPhase;
  /** Serving tower as `device/port`, while attached. */
  tower: string | null;
  /** Last detach reason. */
  reason: string | null;
  /** Attach requests issued so far. */
  requests: number;
  /** Last oper state reported through onLinkChange. */
  operUp: boolean;
  since: SimTime;
}

/** Timer key of the periodic re-search of `port`. */
export function cellResearchTimerKey(port: PortId): string {
  return `${CELL_RESEARCH_TIMER_PREFIX}${port}`;
}

/** True when `view` is a UE cellular adapter this daemon manages. */
export function isCellularAdapter(view: PortView): boolean {
  if (view.spec.kind !== 'cellular') return false;
  const role = view.role ?? view.spec.role ?? 'cellular';
  return role === 'cellular';
}

interface PortRecord {
  port: PortId;
  phase: CellClientPhase;
  tower: PortRef | null;
  reason: string | null;
  requests: number;
  operUp: boolean;
  since: SimTime;
}

/** Create the `cell-client` daemon (one instance per device with a cellular adapter). */
export function createCellClient(): Process {
  const debugRing: DebugEvent[] = [];
  const records = new Map<PortId, PortRecord>();

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: CELL_CLIENT, category: CELL_CLIENT_DEBUG_CATEGORY, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: CELL_CLIENT, category: CELL_CLIENT_DEBUG_CATEGORY, message };
    debugRing.push(ev);
    if (debugRing.length > DEBUG_RING) debugRing.splice(0, debugRing.length - DEBUG_RING);
    ctx.debug(CELL_CLIENT_DEBUG_CATEGORY, message, data);
  }

  /** The adapter view when `port` is a managed cellular adapter. */
  function adapter(ctx: ProcessCtx, port: PortId): PortView | undefined {
    const view = ctx.ports.get(port);
    return view !== undefined && isCellularAdapter(view) ? view : undefined;
  }

  function recordOf(ctx: ProcessCtx, port: PortId): PortRecord {
    let rec = records.get(port);
    if (!rec) {
      rec = { port, phase: 'disabled', tower: null, reason: null, requests: 0, operUp: false, since: ctx.now };
      records.set(port, rec);
    }
    return rec;
  }

  function setPhase(ctx: ProcessCtx, rec: PortRecord, phase: CellClientPhase, message: string, data?: Record<string, unknown>): void {
    const from = rec.phase;
    rec.phase = phase;
    rec.since = ctx.now;
    debug(ctx, message, { port: rec.port, from, to: phase, ...(data ?? {}) });
  }

  function requestAttach(ctx: ProcessCtx, rec: PortRecord, why: string): Action[] {
    rec.requests++;
    rec.tower = null;
    setPhase(ctx, rec, 'searching', `${rec.port}: searching for a cell (${why})`, { request: rec.requests });
    return [{ type: 'medium', port: rec.port, op: { op: 'cell-attach' } }];
  }

  /** `shutdown` / `no shutdown` directly under `interface <port>`. */
  function shutdownDelta(delta: ConfigDelta): PortId | undefined {
    if (delta.context.length !== 1) return undefined;
    const ctxNode = delta.context[0];
    if (ctxNode === undefined || ctxNode[0] !== 'interface' || ctxNode[1] === undefined) return undefined;
    if (delta.line.length !== 1 || delta.line[0] !== 'shutdown') return undefined;
    return ctxNode[1];
  }

  return {
    name: CELL_CLIENT,

    init(ctx: ProcessCtx): Action[] {
      records.clear();
      const actions: Action[] = [];
      for (const view of ctx.ports.values()) {
        if (!isCellularAdapter(view)) continue;
        const rec = recordOf(ctx, view.id);
        rec.operUp = view.operUp;
        if (view.adminUp) actions.push(...requestAttach(ctx, rec, 'boot'));
        else debug(ctx, `${view.id}: adapter is shut down, not searching`, { port: view.id });
      }
      return actions;
    },

    onPdu(_ctx: ProcessCtx, _pdu: Pdu, _port: PortId): Action[] {
      return [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (!key.startsWith(CELL_RESEARCH_TIMER_PREFIX)) return [];
      const port = key.slice(CELL_RESEARCH_TIMER_PREFIX.length);
      const view = adapter(ctx, port);
      const rec = records.get(port);
      if (!view || !rec || !view.adminUp || rec.phase === 'attached' || rec.phase === 'disabled') return [];
      return [...requestAttach(ctx, rec, 're-search'), { type: 'timer', key, delay: CELL_RESEARCH_NS, periodic: true }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const port = shutdownDelta(delta);
      if (port === undefined || !adapter(ctx, port)) return [];
      const rec = recordOf(ctx, port);
      if (delta.op === 'set') {
        rec.tower = null;
        setPhase(ctx, rec, 'disabled', `${port}: adapter shut down, leaving the cell`);
        return [
          { type: 'cancelTimer', key: cellResearchTimerKey(port) },
          { type: 'medium', port, op: { op: 'cell-detach', reason: CELL_ADMIN_DOWN_REASON } },
        ];
      }
      if (rec.phase === 'attached' || rec.phase === 'searching') return [];
      return requestAttach(ctx, rec, 'adapter enabled');
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      if (!adapter(ctx, port)) return [];
      const rec = recordOf(ctx, port);
      rec.operUp = up;
      debug(ctx, `${port}: data path ${up ? 'up' : 'down'}`, { port, up });
      return [];
    },

    onMediumEvent(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[] {
      if (!adapter(ctx, port)) return [];
      const rec = recordOf(ctx, port);
      if (ev.kind === 'cell-attached') {
        rec.tower = { device: ev.tower.device, port: ev.tower.port };
        rec.reason = null;
        setPhase(ctx, rec, 'attached', `${port}: attached to cell ${portKey(ev.tower)}`, { tower: portKey(ev.tower) });
        return [{ type: 'cancelTimer', key: cellResearchTimerKey(port) }];
      }
      if (ev.kind === 'cell-detached') {
        rec.tower = null;
        rec.reason = ev.reason;
        setPhase(ctx, rec, 'detached', `${port}: detached (${ev.reason})`, { reason: ev.reason });
        const view = adapter(ctx, port);
        if (!view?.adminUp) return [];
        return [{ type: 'timer', key: cellResearchTimerKey(port), delay: CELL_RESEARCH_NS, periodic: true }];
      }
      return [];
    },

    stateSnapshot(): StateView {
      const ports: CellClientPortView[] = [];
      for (const rec of records.values()) {
        ports.push({
          port: rec.port,
          phase: rec.phase,
          tower: rec.tower ? portKey(rec.tower) : null,
          reason: rec.reason,
          requests: rec.requests,
          operUp: rec.operUp,
          since: rec.since,
        });
      }
      return { process: CELL_CLIENT, state: { ports } };
    },

    debugEvents(): readonly DebugEvent[] {
      return debugRing;
    },
  };
}
