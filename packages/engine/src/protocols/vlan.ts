/**
 * protocols/vlan.ts — the VLAN database daemon (ARCHITECTURE-P2 D5, §2.1, §2.6, §3.1, §4.3, §5.1).
 *
 * Its presence in `model.processes` is what makes eth-switch VLAN-aware (`isVlanAware`, D5). It owns the `vlans` table
 * (key = `vlanKey(vlan)`; VLAN 1 and 1002–1005 are implicit and never rows) and derives it from the running config:
 *   vlan <v>            (a section, mode config-vlan; `vlan 10,20` is stored as one section per VLAN)
 *    name <name>        (default name `VLAN<v padded to 4 digits>`, e.g. VLAN0010)
 * On every `onConfig` that touches a `vlan` section (the section line at global level, or a line inside one) the
 * daemon re-reads every section and reconciles the table: a new VLAN writes `{vlan, name, status:'active',
 * source:'config'}` and issues `l2Changed {what:'vlans', vlan}`; a renamed VLAN rewrites its row (no signal: the name
 * changes no membership); a removed VLAN deletes its row (reason 'cleared') and issues `l2Changed {what:'vlans',
 * vlan}`. The runtime fans the signal out to eth-switch (which flushes the deleted VLAN's dynamic rows), dtp,
 * etherchannel and stp, then recomputes virtual oper state (an SVI of the VLAN may come up or go down).
 *
 * The reconciliation is idempotent and keyed on the config alone, so a reload, a saved file and the boot replay give
 * the same rows. `init` reconciles once more (a defensive no-op after the boot replay).
 *
 * Silence (§4.3): the daemon never sends, never arms a timer and never draws randomness; with no `vlan` section it
 * writes no row and emits no debug line, so a P1-profile world is unchanged by its presence.
 *
 * `stateSnapshot()`: `{ process: 'vlan', state: { count, vlans: [ids ascending] } }`.
 * Debug category: 'sw-vlan' (§5.4).
 */
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { vlanKey } from '../contracts/tables.js';
import type { VlanRow } from '../contracts/tables.js';
import { isImplicitVlan } from './l2/membership.js';

/** Process name registered by the catalog for managed switches and wireless controllers. */
export const VLAN_PROCESS = 'vlan';
/** Debug category of this daemon (`debug sw-vlan`, §5.4). */
export const VLAN_DEBUG_CATEGORY = 'sw-vlan';
/** Capacity of the per-process DebugEvent ring. */
export const VLAN_DEBUG_RING = 100;
/** Lowest and highest configurable VLAN id (the contract range; core/vlan-list.ts publishes the constants). */
const VLAN_LOW = 1;
const VLAN_HIGH = 4094;

/** The default name of a VLAN without a `name` line: `VLAN` + the id padded to four digits (VLAN0010). */
export function defaultVlanName(vlan: number): string {
  return `VLAN${String(vlan).padStart(4, '0')}`;
}

/** One configured VLAN as the running config states it. */
export interface ConfiguredVlan {
  readonly vlan: number;
  readonly name: string;
}

/** A VLAN id token (1–4094), else undefined. */
function vlanIdOf(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,4}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= VLAN_LOW && v <= VLAN_HIGH ? v : undefined;
}

/**
 * The `vlan <v>` sections of `config`, ascending by id, implicit VLANs (1, 1002–1005) and unparseable sections left
 * out. A section whose id appears twice keeps the first; a `name` line's tokens are joined by one space.
 */
export function readConfiguredVlans(config: ConfigAst): readonly ConfiguredVlan[] {
  const byId = new Map<number, ConfiguredVlan>();
  for (const c of config.root.children) {
    if (c.key !== 'vlan' || c.args.length !== 1) continue;
    const vlan = vlanIdOf(c.args[0]);
    if (vlan === undefined || isImplicitVlan(vlan) || byId.has(vlan)) continue;
    let name = defaultVlanName(vlan);
    for (const child of c.children) {
      if (child.key === 'name' && child.args.length > 0) name = child.args.join(' ');
    }
    byId.set(vlan, { vlan, name });
  }
  return [...byId.values()].sort((a, b) => a.vlan - b.vlan);
}

/** True when `delta` touches a `vlan` section: the section line itself at global level, or a line inside one. */
export function isVlanDelta(delta: Pick<ConfigDelta, 'context' | 'line'>): boolean {
  if (delta.context.length === 0) return delta.line[0] === 'vlan';
  const first = delta.context[0];
  return delta.context.length === 1 && first !== undefined && first[0] === 'vlan';
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

class VlanDaemon implements Process {
  readonly name = VLAN_PROCESS;

  private readonly ring = new DebugRing(VLAN_DEBUG_RING);
  /** Ids of the VLANs currently in the table, ascending (mirrors the `vlans` rows for the snapshot). */
  private ids: number[] = [];

  init(ctx: ProcessCtx): Action[] {
    return this.reconcile(ctx);
  }

  onPdu(ctx: ProcessCtx, pdu: Parameters<Process['onPdu']>[1], port: string): Action[] {
    // The daemon has no selectors and is never a deliver target; a stray frame is dropped, never bridged.
    return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `${VLAN_PROCESS} handles no frames`, port }];
  }

  onTimer(): Action[] {
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isVlanDelta(delta)) return [];
    return this.reconcile(ctx);
  }

  stateSnapshot(): StateView {
    return { process: VLAN_PROCESS, state: { count: this.ids.length, vlans: this.ids.slice() } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  /** Reconcile the `vlans` table with the running config; one `l2Changed` per added or removed VLAN, ascending. */
  private reconcile(ctx: ProcessCtx): Action[] {
    const table = ctx.tables.get<VlanRow>('vlans');
    if (table === undefined) return [];
    const wanted = readConfiguredVlans(ctx.config);
    const actions: Action[] = [];
    const changed: number[] = [];
    const present = new Set<number>();
    for (const v of wanted) {
      present.add(v.vlan);
      const prev = table.get(vlanKey(v.vlan));
      if (prev !== undefined && prev.name === v.name && prev.status === 'active' && prev.source === 'config') continue;
      table.set({ key: vlanKey(v.vlan), vlan: v.vlan, name: v.name, status: 'active', source: 'config', updatedAt: ctx.now });
      if (prev === undefined) {
        this.emit(ctx, `VLAN ${v.vlan} (${v.name}) added`, { vlan: v.vlan, name: v.name });
        changed.push(v.vlan);
      } else {
        this.emit(ctx, `VLAN ${v.vlan} renamed from ${prev.name} to ${v.name}`, { vlan: v.vlan, from: prev.name, to: v.name });
      }
    }
    for (const row of table.rows()) {
      if (present.has(row.vlan)) continue;
      table.delete(row.key, 'cleared');
      this.emit(ctx, `VLAN ${row.vlan} (${row.name}) deleted`, { vlan: row.vlan, name: row.name });
      changed.push(row.vlan);
    }
    this.ids = [...present].sort((a, b) => a - b);
    for (const vlan of changed.sort((a, b) => a - b)) actions.push({ type: 'l2Changed', what: 'vlans', vlan });
    return actions;
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(VLAN_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: VLAN_PROCESS, category: VLAN_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: VLAN_PROCESS, category: VLAN_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the VLAN database daemon (`name: 'vlan'`, no frame selectors). One instance per managed switch or controller. */
export function createVlan(): Process {
  return new VlanDaemon();
}
