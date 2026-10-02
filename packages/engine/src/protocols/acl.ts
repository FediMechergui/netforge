/**
 * protocols/acl.ts — the access-list daemon (ARCHITECTURE-P3 D12, §2.4 `acl.filter` / `acl.clear`, §2.6 `AclRow`,
 * §3.0 (a) steps 2, 6 and 7, §3.3, §4.2, §4.3, §4.5; [S13] `acl.check` / `acl.verdict`, §3.14).
 *
 * The daemon owns the `acl` table (single writer), the compiled lists, the log aggregation, the ICMP rate limit and
 * `clear access-list counters`. It has no wire selector and never originates a packet except ICMP 3/13 for a packet it
 * denies; it is reached only through requests:
 *  • `acl.filter {family 4, dir, iface, inPort?, natted?, pdu, onPermit}` — from ipv4 (inbound right after the header
 *    checksum; outbound after routing and the TTL decrement) and from nat on its `filterOut` path (outbound, after the
 *    translation). The list is the one bound by `ip access-group <list> in|out` on `iface`. The answer is EXACTLY ONE
 *    of: `[onPermit]`; or a drop `{reason 'acl-deny', port: iface, detail, rule}` plus, when the rate gate is open and
 *    the packet is neither `natted` nor ineligible (below), a request icmpv4 `icmp.error {3, 13, inPort: dir 'in' ?
 *    iface : inPort}`. A `log` entry adds its log line (and arms `acl-log`) after the answer.
 *  • `acl.clear {list?}` — `clear access-list counters [<list>]`: every row of the list (or every row) back to 0
 *    matches, without its last-match columns.
 *  • [S13] `acl.check {family 4, list, tuple, token, owner}` — the vty `access-class` check of a login: answered with
 *    ProcessEvent `acl.verdict {token, action, seq}` to `owner`, counted on the matched row with `lastIface 'vty'`.
 *
 * Semantics (D12): entries in sequence order, the first match decides, an implicit deny at the end (`evaluateAcl`,
 * core/acl.ts). A list bound to an interface but not defined permits everything (and counts nothing); so does a list
 * without any permit or deny entry (a section just entered, or remarks only), as on real devices, where the implicit
 * deny exists only below a first entry — which also keeps a boot replay from writing a lone implicit row. NAT's use of a
 * list is never counted. The lists are read with `readAcls` (numbered and named, standard and extended, a numbered
 * section joining the global lines of its number) and re-read on every configuration delta that can change a list or a
 * binding (the compiled-list cache).
 *
 * Rows (`acl` table, key `aclKey(4, list, seq | 'implicit')`): one per entry plus the implicit row, ONLY for lists
 * applied as filters — `ip access-group` on an interface, and [S13] `access-class <list> in` under `line vty` when the
 * device runs the vty daemon (the one that enforces it). `applied` lists every binding: the interfaces in canonical
 * port order (`in` before `out`), then `vty in` (e.g. 'GigabitEthernet0/0 in, vty in'). A row is rewritten only when
 * a column changes (rule 20): a configuration change that leaves an entry's text and action alone keeps its counters;
 * each hit is one tableWrite carrying `matches + 1`, `lastPdu` (absent for a vty check), `lastAt`, `lastIface` and
 * `lastDir`. Rows are written in evaluation order (lists in configuration order, entries by sequence, the implicit row
 * last); rows of lists no longer applied are deleted ('cleared').
 *
 * Logging (`log` entries): the first packet of a flow (list, line, action, protocol, addresses, ports or ICMP type and
 * code) is logged at once, severity 6, facility `ACL`; further packets of the flow are counted, and the periodic
 * `acl-log` timer (300 s, armed when the first flow is logged and only while flows are pending) logs one aggregated
 * line per flow with packets in first-seen order, then forgets the flows that saw none.
 *
 * ICMP (D12): at most one 3/13 per `ACL_UNREACH_RATE_NS` (500 ms) per device, a SimTime comparison (no randomness);
 * none for a `natted` packet (its source is now the router's own address — a listed deviation), and none for a packet
 * icmpv4 would refuse to answer (a broadcast, multicast or 0.0.0.0 address, an ICMP message other than an echo), so
 * such a packet never closes the gate. `no ip unreachables` is [S12], not approved, so it is not read.
 *
 * Silence (§4.3): with no binding the daemon writes no row, arms no timer and emits no debug line or log; a P1/P2
 * world (NAT lists included) never binds a list. Determinism: no randomness; flows and rows in fixed orders (§4.5).
 * Debug category `ip access-list` (§5.8). No module-level mutable state (§4.5): every registry here is built per call.
 *
 * stateSnapshot(): `{ process: 'acl', state: { applied: [{ list, applied }], permitted, denied, unreachablesSent,
 *   unreachablesLimited, logFlows } }` (display only; the counters a lab grades are the rows).
 */
import { isIpv4Broadcast, isIpv4Multicast } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST, ICMP_UNREACH_ADMIN, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from '../contracts/pdu.js';
import type { Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, DropRule, PacketTuple, Process, ProcessCtx, ProcessRequest, Severity, StateView } from '../contracts/process.js';
import { aclKey, type AclRow, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { AclVerdictEvent } from '../contracts/transport.js';
import {
  ACL_PROTOCOL_NAMES,
  aclEntryText,
  aclImplicitText,
  aclTypeOfNumber,
  evaluateAcl,
  parseAclEntry,
  readAcls,
  tupleOf,
  type AclDecision,
  type AclList,
} from '../core/acl.js';

/** @since P3 Process name (`PROCESS_ORDER`: after `nat`, before `gre`, §2.1). */
export const ACL_PROCESS: ProcessName = 'acl';
/** @since P3 Debug category (`debug ip access-list`, §5.8). */
export const ACL_DEBUG_CATEGORY = 'ip access-list';
/** @since P3 Facility of the ACL log lines (D12). */
export const ACL_LOG_FACILITY = 'ACL';
/** @since P3 Severity of the ACL log lines (6, informational; D12). */
export const ACL_LOG_SEVERITY: Severity = 6;
/** @since P3 The periodic aggregation timer (§4.2). */
export const ACL_LOG_TIMER = 'acl-log';
/** @since P3 Aggregation period: one line per flow every 5 minutes (D12). */
export const ACL_LOG_INTERVAL_NS: SimTime = 300 * SEC;
/** @since P3 At most one ICMP 3/13 per device per this interval (D12, §4.1: an integer SimTime comparison). */
export const ACL_UNREACH_RATE_NS: SimTime = 500_000_000;
/** @since P3 [S13] The `lastIface` of a row counted by a vty `access-class` check. */
export const ACL_VTY_IFACE = 'vty';
/** Capacity of the per-process DebugEvent ring. */
const DEBUG_RING = 256;

/** @since P3 The lists one interface binds with `ip access-group` (D12: one per direction). */
export interface AclInterfaceGroups {
  readonly in?: string;
  readonly out?: string;
}

/**
 * @since P3 The name a list is known by in `readAcls`: a number of one of the four list ranges as plain decimal text
 * (`'010'` → `'10'`), any other name unchanged.
 */
export function aclListName(raw: string): string {
  return aclTypeOfNumber(raw) !== undefined ? String(Number(raw)) : raw;
}

/** The interface lines of an `interface` section as token lists (an `ip` group node unfolded). */
function interfaceIpLines(section: ConfigNode): string[][] {
  const out: string[][] = [];
  for (const child of section.children) {
    if (child.key !== 'ip') continue;
    if (child.args.length === 0) for (const leaf of child.children) out.push([leaf.key, ...leaf.args]);
    else out.push(child.args.slice());
  }
  return out;
}

/**
 * @since P3 The `ip access-group <list> in|out` lines of a running configuration (D12): interface name as stored →
 * the list per direction (normalised by `aclListName`). The CLI keeps one line per direction; if two were stored, the
 * later one in the tree wins. Interfaces without a binding are absent. Pure.
 */
export function readAccessGroups(config: Pick<ConfigAst, 'root'>): Map<string, AclInterfaceGroups> {
  const out = new Map<string, AclInterfaceGroups>();
  for (const section of config.root.children) {
    if (section.key !== 'interface') continue;
    const name = section.args[0];
    if (name === undefined) continue;
    let groups: { in?: string; out?: string } | undefined;
    for (const l of interfaceIpLines(section)) {
      if (l[0] !== 'access-group' || l[1] === undefined || (l[2] !== 'in' && l[2] !== 'out') || l.length !== 3) continue;
      groups ??= {};
      groups[l[2]] = aclListName(l[1]);
    }
    if (groups !== undefined) out.set(name, groups);
  }
  return out;
}

// ── [S13] the vty access-class bindings (D14) ──

/**
 * @since P3 [S13] The lists bound by `access-class <list> in` under the `line vty …` sections, in first-seen order,
 * each once (normalised by `aclListName`). Pure.
 */
export function readVtyAccessClasses(config: Pick<ConfigAst, 'root'>): string[] {
  const out: string[] = [];
  for (const section of config.root.children) {
    if (section.key !== 'line' || section.args[0] !== 'vty') continue;
    for (const c of section.children) {
      if (c.key !== 'access-class' || c.args.length !== 2 || c.args[1] !== 'in' || c.args[0] === undefined) continue;
      const name = aclListName(c.args[0]);
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

// ── end [S13] ──

/** Does a configuration delta concern a list, a binding, or a section a binding lives in? */
function isAclDelta(delta: Pick<ConfigDelta, 'op' | 'context' | 'line'>): boolean {
  const { context, line } = delta;
  if (context.length === 0) {
    if (line[0] === 'access-list') return true;
    if (line[0] === 'ip' && line[1] === 'access-list') return true;
    // the removal of an interface or a `line` section takes its bindings with it
    return delta.op === 'unset' && (line[0] === 'interface' || line[0] === 'line');
  }
  const head = context[0];
  if (head === undefined) return false;
  if (head[0] === 'ip' && head[1] === 'access-list') return true;
  if (head[0] === 'interface') return line[0] === 'ip' && line[1] === 'access-group';
  if (head[0] === 'line') return line[0] === 'access-class';
  return false;
}

/** Protocol name of a number as an extended entry shows it (`tcp`, `ospf`, else the number). */
function protocolName(proto: number): string {
  for (const [n, v] of ACL_PROTOCOL_NAMES) if (v === proto) return n;
  return String(proto);
}

/** `tcp 192.168.10.10(49152) -> 192.168.20.100(80)`, `icmp 10.0.0.1 -> 10.0.0.2 (8/0)`, `ospf 10.0.0.1 -> 224.0.0.5`. */
function packetText(t: PacketTuple): string {
  const name = protocolName(t.proto);
  if ((t.proto === IPPROTO_TCP || t.proto === IPPROTO_UDP) && t.srcPort !== undefined && t.dstPort !== undefined) {
    return `${name} ${t.src}(${t.srcPort}) -> ${t.dst}(${t.dstPort})`;
  }
  if (t.proto === IPPROTO_ICMP && t.icmpType !== undefined) return `${name} ${t.src} -> ${t.dst} (${t.icmpType}/${t.icmpCode ?? 0})`;
  return `${name} ${t.src} -> ${t.dst}`;
}

/** `list 101 line 10` or `list 101 implicit deny`. */
function lineText(list: string, d: Pick<AclDecision, 'seq'>): string {
  return d.seq === null ? `list ${list} implicit deny` : `list ${list} line ${d.seq}`;
}

/** One logged flow (D12): the line it was first logged with, and the packets counted since the last line. */
interface LogFlow {
  /** `list X line N denied <packet>` (the part before the packet count). */
  readonly text: string;
  pending: number;
}

/** A row's displayed columns, for the "rewrite only when a column changes" test (rule 20). */
function sameRow(a: AclRow, b: AclRow): boolean {
  return (
    a.family === b.family && a.list === b.list && a.type === b.type && a.seq === b.seq && a.implicit === b.implicit && a.entry === b.entry
    && a.action === b.action && a.matches === b.matches && a.lastPdu === b.lastPdu && a.lastAt === b.lastAt && a.lastIface === b.lastIface
    && a.lastDir === b.lastDir && a.applied === b.applied
  );
}

/** `row` without the last-match columns (a fresh or cleared counter). */
function withoutLast(row: AclRow): AclRow {
  const out: AclRow = { ...row };
  delete out.lastPdu;
  delete out.lastAt;
  delete out.lastIface;
  delete out.lastDir;
  return out;
}

class AclDaemon implements Process {
  readonly name = ACL_PROCESS;

  private readonly ring: DebugEvent[] = [];
  /** The compiled lists (`readAcls`), re-read on every list or binding delta. */
  private lists: ReadonlyMap<string, AclList> = new Map();
  /** `ip access-group` bindings by port id (resolved against the device's ports). */
  private groups: ReadonlyMap<PortId, AclInterfaceGroups> = new Map();
  /** [S13] Lists enforced by `access-class … in` on the vty lines (only when the device runs vty). */
  private vtyLists: readonly string[] = [];
  /** Applied lists → their `applied` text, in configuration order (the StateView). */
  private applied: ReadonlyMap<string, string> = new Map();
  /** Logged flows in first-seen order (D12, §4.5). */
  private readonly flows = new Map<string, LogFlow>();
  private logArmed = false;
  /** When the last ICMP 3/13 was requested (the rate gate). */
  private lastUnreachAt: SimTime | undefined;
  private permitted = 0;
  private denied = 0;
  private unreachablesSent = 0;
  private unreachablesLimited = 0;

  // ── Process ──────────────────────────────────────────────────────────────

  init(ctx: ProcessCtx): Action[] {
    this.reconcile(ctx);
    return [];
  }

  onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    // acl has no selectors and is never a deliver target: it works only through requests.
    return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `${ACL_PROCESS} handles no frames`, port }];
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key !== ACL_LOG_TIMER) return [];
    const out: Action[] = [];
    for (const [k, flow] of this.flows) {
      if (flow.pending === 0) {
        this.flows.delete(k);
        continue;
      }
      out.push(this.logLine(flow.text, flow.pending));
      flow.pending = 0;
    }
    if (this.flows.size === 0) {
      this.logArmed = false;
      return out;
    }
    out.push({ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true });
    return out;
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isAclDelta(delta)) return [];
    this.reconcile(ctx);
    return [];
  }

  onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    switch (req.kind) {
      case 'acl.filter':
        return this.filter(ctx, req);
      case 'acl.clear':
        return this.clear(ctx, req.list);
      // ── [S13] the vty access-class check (D14) ──
      case 'acl.check':
        return this.check(ctx, req);
      // ── end [S13] ──
      default:
        return [];
    }
  }

  stateSnapshot(): StateView {
    return {
      process: ACL_PROCESS,
      state: {
        applied: Array.from(this.applied, ([list, applied]) => ({ list, applied })),
        permitted: this.permitted,
        denied: this.denied,
        unreachablesSent: this.unreachablesSent,
        unreachablesLimited: this.unreachablesLimited,
        logFlows: this.flows.size,
      },
    };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring;
  }

  // ── configuration and rows ───────────────────────────────────────────────

  private table(ctx: ProcessCtx): Table<AclRow> | undefined {
    return ctx.tables.get<AclRow>('acl');
  }

  /** The port a configured interface name designates (canonical id first, then case-insensitively). */
  private findPort(ctx: ProcessCtx, name: string): PortId | undefined {
    if (ctx.ports.has(name)) return name;
    const lower = name.toLowerCase();
    for (const id of ctx.ports.keys()) if (id.toLowerCase() === lower) return id;
    return undefined;
  }

  /**
   * Re-read the lists and the bindings, then bring the rows in line: one row per entry plus the implicit row for every
   * applied list that is defined, in evaluation order; a row is written only when a column changes; rows of anything
   * else are deleted. Idempotent; nothing is written in a world without a binding.
   */
  private reconcile(ctx: ProcessCtx): void {
    this.lists = readAcls(ctx.config);
    const groups = new Map<PortId, AclInterfaceGroups>();
    for (const [name, g] of readAccessGroups(ctx.config)) {
      const port = this.findPort(ctx, name);
      if (port !== undefined) groups.set(port, g);
    }
    this.groups = groups;
    // [S13] the access-class lists are filters only where the vty daemon enforces them
    this.vtyLists = ctx.model.processes.includes('vty') ? readVtyAccessClasses(ctx.config) : [];

    // bindings per list: interfaces in canonical port order (in before out), then the vty lines
    const bindings = new Map<string, string[]>();
    const bind = (list: string, where: string): void => {
      const have = bindings.get(list);
      if (have === undefined) bindings.set(list, [where]);
      else have.push(where);
    };
    for (const port of ctx.ports.keys()) {
      const g = groups.get(port);
      if (g?.in !== undefined) bind(g.in, `${port} in`);
      if (g?.out !== undefined) bind(g.out, `${port} out`);
    }
    for (const list of this.vtyLists) bind(list, `${ACL_VTY_IFACE} in`); // [S13]

    const applied = new Map<string, string>();
    for (const name of this.lists.keys()) {
      const where = bindings.get(name);
      if (where !== undefined && this.definedList(name) !== undefined) applied.set(name, where.join(', '));
    }
    this.applied = applied;

    const table = this.table(ctx);
    if (table === undefined) return;
    const wanted = new Set<string>();
    for (const [name, text] of applied) {
      const list = this.lists.get(name)!;
      const rows: AclRow[] = list.entries.map((e) => ({
        key: aclKey(4, name, e.seq), family: 4, list: name, type: list.type, seq: e.seq, entry: e.text, action: e.entry.action,
        matches: 0, applied: text, updatedAt: ctx.now,
      }));
      rows.push({
        key: aclKey(4, name, 'implicit'), family: 4, list: name, type: list.type, seq: null, implicit: 'deny', entry: aclImplicitText(list.type),
        action: 'deny', matches: 0, applied: text, updatedAt: ctx.now,
      });
      for (const fresh of rows) {
        wanted.add(fresh.key);
        const old = table.get(fresh.key);
        // an unchanged entry keeps its counters and last match; a changed one starts again from 0
        const next: AclRow =
          old !== undefined && old.entry === fresh.entry && old.action === fresh.action && old.type === fresh.type
            ? { ...old, applied: fresh.applied, updatedAt: ctx.now }
            : fresh;
        if (old !== undefined && sameRow(old, next)) continue;
        table.set(next);
      }
    }
    for (const row of table.rows()) if (!wanted.has(row.key)) table.delete(row.key, 'cleared');
  }

  /** The list `name` when it filters: defined, with at least one entry (else it permits everything, D12). */
  private definedList(name: string): AclList | undefined {
    const list = this.lists.get(name);
    return list !== undefined && list.entries.length > 0 ? list : undefined;
  }

  /** The list bound on `iface` for `dir`, if any. */
  private boundList(iface: PortId, dir: 'in' | 'out'): string | undefined {
    return this.groups.get(iface)?.[dir];
  }

  /** Count a decision on its row (when the list is applied): one tableWrite carrying the last match. */
  private count(ctx: ProcessCtx, list: string, d: AclDecision, iface: PortId | typeof ACL_VTY_IFACE, dir: 'in' | 'out', pduId: number | undefined): void {
    const table = this.table(ctx);
    if (table === undefined) return;
    const row = table.get(aclKey(4, list, d.seq ?? 'implicit'));
    if (row === undefined) return;
    const next: AclRow = { ...withoutLast(row), matches: row.matches + 1, lastAt: ctx.now, lastIface: iface, lastDir: dir, updatedAt: ctx.now };
    if (pduId !== undefined) next.lastPdu = pduId;
    table.set(next);
  }

  // ── acl.filter ───────────────────────────────────────────────────────────

  private filter(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>): Action[] {
    const name = this.boundList(req.iface, req.dir);
    // no binding (ipv4 and acl read the same lines, so only a fixture gets here): the packet goes on untouched
    if (name === undefined) return [req.onPermit];
    const dirWord = req.dir === 'in' ? 'inbound' : 'outbound';
    const tuple = tupleOf(req.pdu);
    // a PDU without an IPv4 header cannot be matched (ipv4 never hands one over)
    if (tuple === undefined) return [req.onPermit];
    const list = this.definedList(name);
    if (list === undefined) {
      // D12: a list bound to an interface but not defined (or without an entry) permits everything (nothing to count)
      this.permitted++;
      this.debug(ctx, `list ${name} is not defined: permitted ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
        pdu: req.pdu.id, list: name, iface: req.iface, dir: req.dir, action: 'permit',
      });
      return [req.onPermit];
    }
    const d = evaluateAcl(list, tuple);
    this.count(ctx, name, d, req.iface, req.dir, req.pdu.id);
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    this.debug(ctx, `${lineText(name, d)} ${verb} ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
      pdu: req.pdu.id, list: name, seq: d.seq ?? 'implicit', action: d.action, iface: req.iface, dir: req.dir,
    });
    const logs = this.logActions(name, list, d, tuple);
    if (d.action === 'permit') {
      this.permitted++;
      return [req.onPermit, ...logs];
    }
    this.denied++;
    const out: Action[] = [
      { type: 'drop', pdu: req.pdu, reason: 'acl-deny', detail: d.seq === null ? `ACL ${name} implicit deny` : `ACL ${name} #${d.seq}`, port: req.iface, rule: this.dropRule(ctx, name, list, d, req.iface, req.dir) },
    ];
    const icmp = this.unreachable(ctx, req, tuple);
    if (icmp !== undefined) out.push(icmp);
    return [...out, ...logs];
  }

  /**
   * The ICMP 3/13 for a denied packet, when it is due: not for a `natted` packet, not for a packet icmpv4 refuses to
   * answer (which then leaves the gate open), and at most one per `ACL_UNREACH_RATE_NS` per device.
   */
  private unreachable(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>, t: PacketTuple): Action | undefined {
    if (req.natted === true) return undefined;
    if (isIpv4Broadcast(t.dst) || isIpv4Multicast(t.dst) || isIpv4Broadcast(t.src) || isIpv4Multicast(t.src) || t.src === '0.0.0.0') return undefined;
    if (t.proto === IPPROTO_ICMP && t.icmpType !== ICMP_ECHO_REQUEST && t.icmpType !== ICMP_ECHO_REPLY) return undefined;
    if (this.lastUnreachAt !== undefined && ctx.now - this.lastUnreachAt < ACL_UNREACH_RATE_NS) {
      this.unreachablesLimited++;
      this.debug(ctx, `no unreachable for ${packetText(t)}: one was sent less than ${ACL_UNREACH_RATE_NS / 1_000_000} ms ago`, { pdu: req.pdu.id });
      return undefined;
    }
    this.lastUnreachAt = ctx.now;
    this.unreachablesSent++;
    const inPort = req.dir === 'in' ? req.iface : req.inPort;
    return {
      type: 'request',
      to: 'icmpv4',
      req: inPort === undefined
        ? { kind: 'icmp.error', original: req.pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_ADMIN }
        : { kind: 'icmp.error', original: req.pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_ADMIN, inPort },
    };
  }

  /**
   * Where entry `seq` (canonical text `text`) of `list` lives in the running configuration: a global `access-list N …`
   * line or a child of an `ip access-list standard|extended <name>` section, found by its `ConfigNode.seq`, else by its
   * text. Undefined when neither finds it.
   */
  private entryLocation(ctx: ProcessCtx, list: string, type: AclList['type'], seq: number, text: string): DropRule['config'] {
    const candidates: { context: string[][]; line: string[]; seq: number | undefined; tokens: readonly string[] }[] = [];
    for (const node of ctx.config.root.children) {
      if (node.key === 'access-list' && node.args[0] !== undefined && aclTypeOfNumber(node.args[0]) === type && aclListName(node.args[0]) === list) {
        candidates.push({ context: [], line: [node.key, ...node.args], seq: node.seq, tokens: node.args.slice(1) });
      } else if (node.key === 'ip' && node.args[0] === 'access-list' && node.args[1] === type && node.args[2] !== undefined && aclListName(node.args[2]) === list) {
        for (const c of node.children) {
          const tokens = /^\d{1,10}$/.test(c.key) ? c.args : [c.key, ...c.args];
          candidates.push({ context: [[node.key, ...node.args]], line: [c.key, ...c.args], seq: c.seq, tokens });
        }
      }
    }
    const hit = candidates.find((c) => c.seq === seq) ?? candidates.find((c) => {
      const e = parseAclEntry(type, c.tokens);
      return e !== undefined && aclEntryText(e) === text;
    });
    return hit === undefined ? undefined : { context: hit.context, line: hit.line };
  }

  /** The structured "why was this dropped" of a deny (D12, §2.4 DropRule). */
  private dropRule(ctx: ProcessCtx, name: string, list: AclList, d: AclDecision, iface: PortId, dir: 'in' | 'out'): DropRule {
    const dirWord = dir === 'in' ? 'inbound' : 'outbound';
    const seq = d.seq ?? 'implicit';
    const key = aclKey(4, name, seq);
    if (d.seq === null) {
      return {
        kind: 'acl', text: `denied by the implicit deny at the end of access list ${name}, ${dirWord} on ${iface}`, table: 'acl', key,
        config: { context: [['interface', iface]], line: ['ip', 'access-group', name, dir] }, iface, dir, list: name, seq, family: 4,
      };
    }
    const entry = d.index === undefined ? undefined : list.entries[d.index];
    const config = this.entryLocation(ctx, name, list.type, d.seq, entry?.text ?? '');
    const rule: DropRule = {
      kind: 'acl', text: `denied by access list ${name} line ${d.seq} (${entry?.text ?? ''}), ${dirWord} on ${iface}`, table: 'acl', key,
      iface, dir, list: name, seq, family: 4,
    };
    return config === undefined ? rule : { ...rule, config };
  }

  // ── logging ──────────────────────────────────────────────────────────────

  private logLine(text: string, packets: number): Action {
    return { type: 'log', severity: ACL_LOG_SEVERITY, facility: ACL_LOG_FACILITY, message: `${text}, ${packets} packet${packets === 1 ? '' : 's'}` };
  }

  /**
   * A `log` entry's actions for one packet (D12): the first packet of a flow is logged at once and arms `acl-log`
   * when it is not armed; a later packet of a known flow is only counted for the next aggregated line.
   */
  private logActions(name: string, list: AclList, d: AclDecision, t: PacketTuple): Action[] {
    if (d.index === undefined || list.entries[d.index]?.entry.log !== true || d.seq === null) return [];
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    const what = list.type === 'standard' ? t.src : packetText(t);
    const key = list.type === 'standard'
      ? `${name}|${d.seq}|${d.action}|${t.src}`
      : `${name}|${d.seq}|${d.action}|${t.proto}|${t.src}|${t.srcPort ?? ''}|${t.dst}|${t.dstPort ?? ''}|${t.icmpType ?? ''}|${t.icmpCode ?? ''}`;
    const known = this.flows.get(key);
    if (known !== undefined) {
      known.pending++;
      return [];
    }
    const text = `list ${name} line ${d.seq} ${verb} ${what}`;
    this.flows.set(key, { text, pending: 0 });
    const out: Action[] = [this.logLine(text, 1)];
    if (!this.logArmed) {
      this.logArmed = true;
      out.push({ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true });
    }
    return out;
  }

  // ── acl.clear ────────────────────────────────────────────────────────────

  private clear(ctx: ProcessCtx, raw: string | undefined): Action[] {
    const list = raw === undefined ? undefined : aclListName(raw);
    const table = this.table(ctx);
    if (table === undefined) return [];
    for (const row of table.rows()) {
      if (list !== undefined && row.list !== list) continue;
      const next: AclRow = { ...withoutLast(row), matches: 0, updatedAt: ctx.now };
      if (sameRow(row, next)) continue;
      table.set(next);
    }
    this.debug(ctx, list === undefined ? 'counters cleared on every access list' : `counters cleared on access list ${list}`, list === undefined ? {} : { list });
    return [];
  }

  // ── [S13] acl.check (the vty access-class, D14) ──────────────────────────

  private check(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.check' }>): Action[] {
    const name = aclListName(req.list);
    const list = this.definedList(name);
    const verdict = (action: 'permit' | 'deny', seq: number | 'implicit'): Action => {
      const ev: AclVerdictEvent = { kind: 'acl.verdict', token: req.token, action, seq };
      return { type: 'event', to: req.owner, ev };
    };
    if (list === undefined) {
      // an undefined list admits every login (as an undefined list bound to an interface); no entry decided
      this.permitted++;
      this.debug(ctx, `list ${name} is not defined: permitted ${packetText(req.tuple)} inbound on the vty lines`, { list: name, token: req.token, action: 'permit' });
      return [verdict('permit', 'implicit')];
    }
    const d = evaluateAcl(list, req.tuple);
    this.count(ctx, name, d, ACL_VTY_IFACE, 'in', undefined);
    if (d.action === 'permit') this.permitted++;
    else this.denied++;
    this.debug(ctx, `${lineText(name, d)} ${d.action === 'permit' ? 'permitted' : 'denied'} ${packetText(req.tuple)} inbound on the vty lines`, {
      list: name, seq: d.seq ?? 'implicit', action: d.action, token: req.token,
    });
    return [verdict(d.action, d.seq ?? 'implicit'), ...this.logActions(name, list, d, req.tuple)];
  }
  // ── end [S13] ──

  // ── debug ────────────────────────────────────────────────────────────────

  private debug(ctx: ProcessCtx, message: string, data: Record<string, unknown>): void {
    ctx.debug(ACL_DEBUG_CATEGORY, message, data);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: ACL_PROCESS, category: ACL_DEBUG_CATEGORY, message, data });
    if (this.ring.length > DEBUG_RING) this.ring.splice(0, this.ring.length - DEBUG_RING);
  }
}

/** @since P3 Create the access-list daemon (`name: 'acl'`, no frame selectors; D12). One instance per device. */
export function createAcl(): Process {
  return new AclDaemon();
}
