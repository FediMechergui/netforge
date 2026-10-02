/**
 * acl.daemon — the access-list daemon, protocols/acl.ts (ARCHITECTURE-P3 D12, §2.4 `acl.filter` / `acl.clear`, §2.6
 * `AclRow`, §3.3, §4.2, §4.3, §4.5; [S13] `acl.check` / `acl.verdict`, §3.14; §7 W2 acl):
 *  • rows only for lists applied as filters (`ip access-group`, [S13] `access-class … in` on the vty lines of a device
 *    that runs vty), one per entry plus the implicit row, `applied` naming every binding, rewritten only when a column
 *    changes; NAT-only lists never get rows;
 *  • counts: one tableWrite per hit carrying `matches`, `lastPdu`, `lastAt`, `lastIface`, `lastDir`;
 *  • the verdict: `[onPermit]`, or a drop {acl-deny, port, detail, rule} plus ICMP 3/13 (inPort: the input interface,
 *    or the request's inPort on an outbound deny), at most one per 500 ms, none for a `natted` packet;
 *  • first-packet log at once (severity 6, facility ACL) and one aggregated line per flow every 5 minutes;
 *  • `acl.clear`; an undefined list permits everything; silence without a binding;
 *  • [S13] `acl.check` → `acl.verdict`, counted on the vty rows with `lastIface 'vty'`.
 * Unit cases run on the ip.fake-ctx router with an `acl` table; the last block runs real worlds (`test/staged.world.ts`,
 * stage P3, the real acl factory laid over the registry) with the configuration in `startupConfig` (rule 13).
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Action, DropRule, Process, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { aclKey, type AclRow, type DeviceTables, type Table, type TableName, type TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { createTable } from '../src/core/table.js';
import {
  ACL_DEBUG_CATEGORY,
  ACL_LOG_FACILITY,
  ACL_LOG_INTERVAL_NS,
  ACL_LOG_SEVERITY,
  ACL_LOG_TIMER,
  ACL_UNREACH_RATE_NS,
  aclListName,
  createAcl,
  readAccessGroups,
  readVtyAccessClasses,
} from '../src/protocols/acl.js';
import { echoRequest, framed, makeFake, type Fake } from './ip.fake-ctx.js';
import { createStagedSimulation } from './staged.world.js';
import { ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const PC1 = '192.168.10.10';
const PC2 = '192.168.10.11';
const SRV = '192.168.20.100';
const LIST = 'NO-WEB-PC1';
const SECTION = ['ip', 'access-list', 'extended', LIST];
const ENTRY_10 = 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log';
const ENTRY_20 = 'permit icmp 192.168.10.0 0.0.0.255 any';
const ENTRY_30 = 'permit ip any any';
const MS = 1_000_000;

type FilterReq = Extract<ProcessRequest, { kind: 'acl.filter' }>;

interface AclRig {
  fake: Fake;
  ctx: ProcessCtx;
  acl: Process;
  table: Table<AclRow>;
  /** Store a line (context = mode path) and hand the delta to acl. */
  line(context: readonly (readonly string[])[], text: string, negate?: boolean): Action[];
  /** `acl.filter` for `pdu` (onPermit = a marker request to ipv4). */
  filter(pdu: Pdu, dir: 'in' | 'out', iface: string, extra?: Partial<Pick<FilterReq, 'inPort' | 'natted'>>): { actions: Action[]; onPermit: Action };
  at(ns: number): void;
  writes(): Extract<TraceEvent, { kind: 'tableWrite' }>[];
  aclDebug(): string[];
}

/** The fake router (Gi0/0 192.168.10.1, Gi0/1 192.168.20.1) with an `acl` table; the model runs acl (and `extra`). */
function rig(extra: readonly ProcessName[] = []): AclRig {
  const fake = makeFake({
    kind: 'router',
    ports: [
      { id: GI0, mac: MAC_R0, ipv4: { address: '192.168.10.1', prefixLen: 24 } },
      { id: GI1, mac: MAC_R1, ipv4: { address: '192.168.20.1', prefixLen: 24 } },
    ],
  });
  const base = fake.ctx;
  const sink = { emit: (ev: TraceEvent) => void fake.trace.push(ev) };
  const table = createTable<AclRow>({ name: 'acl', device: base.deviceId, sink, now: () => base.now });
  const tables: DeviceTables = {
    cam: base.tables.cam,
    arp: base.tables.arp,
    rib: base.tables.rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => (name === 'acl' ? (table as unknown as Table<R>) : base.tables.get<R>(name)),
    names: () => [...base.tables.names(), 'acl'],
  };
  const model = { ...base.model, processes: [...base.model.processes, 'acl' as ProcessName, ...extra], tables: [...base.model.tables, 'acl' as TableName] };
  const ctx = Object.create(base, { model: { value: model, enumerable: true }, tables: { value: tables, enumerable: true } }) as ProcessCtx;
  const acl = createAcl();
  return {
    fake,
    ctx,
    acl,
    table,
    line(context, text, negate = false) {
      const tokens = text.split(' ');
      const delta: ConfigDelta | undefined = negate ? ctx.config.unset(context, tokens) : ctx.config.set(context, tokens);
      return delta === undefined ? [] : acl.onConfig(ctx, delta);
    },
    filter(pdu, dir, iface, more = {}) {
      const onPermit: Action = { type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: iface, after: 'acl-in' } };
      const req: FilterReq = { kind: 'acl.filter', family: 4, dir, iface, pdu, onPermit, ...more };
      return { actions: acl.onRequest!(ctx, req), onPermit };
    },
    at: (ns) => fake.setNow(ns),
    writes: () => fake.trace.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.table === 'acl'),
    aclDebug: () => fake.debug.filter((d) => d.category === ACL_DEBUG_CATEGORY).map((d) => d.message),
  };
}

/** The §3.3 list on R1 (three entries), bound inbound on Gi0/0 when `bind`. */
function section33(r: AclRig, bind = true): void {
  r.line([], SECTION.join(' '));
  r.line([SECTION], ENTRY_10);
  r.line([SECTION], ENTRY_20);
  r.line([SECTION], ENTRY_30);
  if (bind) r.line([['interface', GI0]], `ip access-group ${LIST} in`);
}

const tcpSyn = (src: string, sport: number, dst: string, dport: number): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst, protocol: 6, ttl: 128, id: 1 } },
  { proto: 'tcp', fields: { srcPort: sport, dstPort: dport, seq: 100, ack: 0, flags: 'S', window: 8192 } },
];

function pkt(r: AclRig, layers: LayerSpec[]): Pdu {
  return r.fake.build(framed(MAC_R0, MAC_PC, layers));
}

const drops = (actions: readonly Action[]) => actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');
const icmpErrors = (actions: readonly Action[]) =>
  actions.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request' && a.to === 'icmpv4').map((a) => a.req);
const logs = (actions: readonly Action[]) => actions.filter((a): a is Extract<Action, { type: 'log' }> => a.type === 'log');

describe('acl.daemon: rows only for applied lists (D12, §2.6)', () => {
  it('a list that is only configured (or used by NAT) has no row; binding it writes its rows in evaluation order', () => {
    const r = rig();
    r.line([], 'access-list 1 permit 192.168.10.0 0.0.0.255');
    r.line([], 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    section33(r, false);
    expect(r.table.rows()).toEqual([]);
    expect(r.writes()).toEqual([]);
    expect(r.aclDebug()).toEqual([]);
    const t0 = r.ctx.now;
    r.line([['interface', GI0]], `ip access-group ${LIST} in`);
    const applied = `${GI0} in`;
    expect(r.table.rows()).toEqual([
      { key: aclKey(4, LIST, 10), family: 4, list: LIST, type: 'extended', seq: 10, entry: ENTRY_10, action: 'deny', matches: 0, applied, updatedAt: t0 },
      { key: aclKey(4, LIST, 20), family: 4, list: LIST, type: 'extended', seq: 20, entry: ENTRY_20, action: 'permit', matches: 0, applied, updatedAt: t0 },
      { key: aclKey(4, LIST, 30), family: 4, list: LIST, type: 'extended', seq: 30, entry: ENTRY_30, action: 'permit', matches: 0, applied, updatedAt: t0 },
      { key: aclKey(4, LIST, 'implicit'), family: 4, list: LIST, type: 'extended', seq: null, implicit: 'deny', entry: 'deny ip any any', action: 'deny', matches: 0, applied, updatedAt: t0 },
    ]);
    expect(r.writes().map((w) => w.key)).toEqual(['4|NO-WEB-PC1|10', '4|NO-WEB-PC1|20', '4|NO-WEB-PC1|30', '4|NO-WEB-PC1|implicit']);
    // the NAT list stays without rows; an unrelated or repeated delta rewrites nothing (rule 20)
    r.line([], 'access-list 1 permit 192.168.30.0 0.0.0.255');
    r.line([['interface', GI0]], 'description users');
    expect(r.writes()).toHaveLength(4);
    expect(r.table.rows().every((row) => row.list === LIST)).toBe(true);
  });

  it('a second binding rewrites applied; a new entry writes only its row; a changed entry restarts its counter; unbinding deletes', () => {
    const r = rig();
    section33(r);
    r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'in', GI0);
    expect(r.table.get(aclKey(4, LIST, 20))!.matches).toBe(1);
    const n = r.writes().length;
    r.line([['interface', GI1]], `ip access-group ${LIST} out`);
    expect(r.writes().slice(n).map((w) => w.key)).toEqual(['4|NO-WEB-PC1|10', '4|NO-WEB-PC1|20', '4|NO-WEB-PC1|30', '4|NO-WEB-PC1|implicit']);
    expect(r.table.rows().map((x) => x.applied)).toEqual(Array(4).fill(`${GI0} in, ${GI1} out`));
    // counters survive a binding change
    expect(r.table.get(aclKey(4, LIST, 20))).toMatchObject({ matches: 1, lastIface: GI0, lastDir: 'in' });
    const m = r.writes().length;
    r.line([SECTION], '25 deny udp any any');
    expect(r.writes().slice(m).map((w) => w.key)).toEqual(['4|NO-WEB-PC1|25']);
    // `no 20` then a different line 20: the new entry starts from zero
    r.line([SECTION], '20 permit icmp 192.168.10.0 0.0.0.255 any', true);
    expect(r.table.has(aclKey(4, LIST, 20))).toBe(false);
    r.line([SECTION], '20 permit icmp any any');
    expect(r.table.get(aclKey(4, LIST, 20))).toMatchObject({ entry: 'permit icmp any any', matches: 0 });
    expect(r.table.get(aclKey(4, LIST, 20))).not.toHaveProperty('lastPdu');
    r.line([['interface', GI0]], `ip access-group ${LIST} in`, true);
    r.line([['interface', GI1]], `ip access-group ${LIST} out`, true);
    expect(r.table.rows()).toEqual([]);
    const expired = r.fake.trace.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'acl');
    // (deleted in table order: the re-added line 20 was inserted last)
    expect(expired.slice(-5).map((e) => [e.key, e.reason])).toEqual([
      ['4|NO-WEB-PC1|10', 'cleared'], ['4|NO-WEB-PC1|30', 'cleared'], ['4|NO-WEB-PC1|implicit', 'cleared'], ['4|NO-WEB-PC1|25', 'cleared'], ['4|NO-WEB-PC1|20', 'cleared'],
    ]);
  });

  it('numbered lists: global lines and a numbered section are one list, numbered 10, 20, … (standard rows and implicit `deny any`)', () => {
    const r = rig();
    r.line([], 'access-list 10 permit host 192.168.10.10');
    r.line([], 'ip access-list standard 10');
    r.line([['ip', 'access-list', 'standard', '10']], 'deny 192.168.10.0 0.0.0.255');
    r.line([['interface', GI1]], 'ip access-group 010 out');
    expect(r.table.rows().map((x) => [x.key, x.type, x.entry, x.action, x.applied])).toEqual([
      ['4|10|10', 'standard', 'permit 192.168.10.10', 'permit', `${GI1} out`],
      ['4|10|20', 'standard', 'deny 192.168.10.0 0.0.0.255', 'deny', `${GI1} out`],
      ['4|10|implicit', 'standard', 'deny any', 'deny', `${GI1} out`],
    ]);
    expect(aclListName('010')).toBe('10');
    expect(aclListName('NO-WEB')).toBe('NO-WEB');
  });

  it('the bindings readers (shared with ipv4): access-group per interface and direction, vty access-class lists', () => {
    const r = rig();
    r.line([['interface', GI0]], 'ip access-group 101 in');
    r.line([['interface', GI0]], 'ip access-group EDGE out');
    r.line([['interface', GI1]], 'ip access-group 7 in');
    r.line([['line', 'vty', '0', '4']], 'access-class 10 in');
    r.line([['line', 'vty', '5', '15']], 'access-class 10 in');
    r.line([['line', 'vty', '5', '15']], 'login');
    expect(readAccessGroups(r.ctx.config)).toEqual(new Map([[GI0, { in: '101', out: 'EDGE' }], [GI1, { in: '7' }]]));
    expect(readVtyAccessClasses(r.ctx.config)).toEqual(['10']);
  });

  it('an undefined list bound to an interface permits everything and counts nothing', () => {
    const r = rig();
    r.line([['interface', GI0]], 'ip access-group NOPE in');
    expect(r.table.rows()).toEqual([]);
    const pdu = pkt(r, tcpSyn(PC1, 49152, SRV, 80));
    const { actions, onPermit } = r.filter(pdu, 'in', GI0);
    expect(actions).toEqual([onPermit]);
    expect(r.writes()).toEqual([]);
    expect(r.aclDebug().at(-1)).toBe(`list NOPE is not defined: permitted tcp ${PC1}(49152) -> ${SRV}(80) inbound on ${GI0}`);
    // a list without an entry (the section just entered, or remarks only) still permits everything, without rows
    r.line([], 'ip access-list extended NOPE');
    r.line([['ip', 'access-list', 'extended', 'NOPE']], 'remark nothing here yet');
    expect(r.table.rows()).toEqual([]);
    expect(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80)), 'in', GI0).actions).toHaveLength(1);
    expect(r.writes()).toEqual([]);
    // its first entry applies it at once (line 20: the remark took 10)
    r.line([['ip', 'access-list', 'extended', 'NOPE']], 'deny tcp any any');
    expect(r.table.rows().map((x) => x.key)).toEqual(['4|NOPE|20', '4|NOPE|implicit']);
    expect(r.filter(pkt(r, tcpSyn(PC1, 49153, SRV, 80)), 'in', GI0).actions[0]).toMatchObject({ type: 'drop', reason: 'acl-deny' });
  });
});

describe('acl.daemon: verdicts and counts (§3.3 steps 2 and 3)', () => {
  it('a permit answers [onPermit] and counts its row with the last match (one tableWrite)', () => {
    const r = rig();
    section33(r);
    r.at(2_000 * MS);
    const pdu = pkt(r, echoRequest(PC1, SRV, 1, 1));
    const n = r.writes().length;
    const { actions, onPermit } = r.filter(pdu, 'in', GI0);
    expect(actions).toEqual([onPermit]);
    expect(r.writes().length - n).toBe(1);
    expect(r.table.get(aclKey(4, LIST, 20))).toEqual({
      key: aclKey(4, LIST, 20), family: 4, list: LIST, type: 'extended', seq: 20, entry: ENTRY_20, action: 'permit', matches: 1,
      lastPdu: pdu.id, lastAt: 2_000 * MS, lastIface: GI0, lastDir: 'in', applied: `${GI0} in`, updatedAt: 2_000 * MS,
    });
    expect(r.aclDebug().at(-1)).toBe(`list ${LIST} line 20 permitted icmp ${PC1} -> ${SRV} (8/0) inbound on ${GI0}`);
    // PC2's HTTP matches line 30
    r.filter(pkt(r, tcpSyn(PC2, 49152, SRV, 80)), 'in', GI0);
    expect(r.table.get(aclKey(4, LIST, 30))!.matches).toBe(1);
    expect(r.table.get(aclKey(4, LIST, 10))!.matches).toBe(0);
  });

  it('a deny answers a drop with the structured rule and ICMP 3/13 from the input interface', () => {
    const r = rig();
    section33(r);
    const pdu = pkt(r, tcpSyn(PC1, 49152, SRV, 80));
    const { actions } = r.filter(pdu, 'in', GI0);
    const rule: DropRule = {
      kind: 'acl',
      text: `denied by access list ${LIST} line 10 (${ENTRY_10}), inbound on ${GI0}`,
      table: 'acl',
      key: aclKey(4, LIST, 10),
      iface: GI0,
      dir: 'in',
      list: LIST,
      seq: 10,
      family: 4,
      config: { context: [SECTION], line: ENTRY_10.split(' ') },
    };
    expect(drops(actions)).toEqual([{ type: 'drop', pdu, reason: 'acl-deny', detail: `ACL ${LIST} #10`, port: GI0, rule }]);
    expect(icmpErrors(actions)).toEqual([{ kind: 'icmp.error', original: pdu, type: 3, code: 13, inPort: GI0 }]);
    expect(actions[0]).toMatchObject({ type: 'drop' });
    expect(r.table.get(aclKey(4, LIST, 10))).toMatchObject({ matches: 1, lastPdu: pdu.id, lastIface: GI0, lastDir: 'in' });
    // the implicit deny: its own rule, the binding line as its configuration, never an entry
    const r2 = rig();
    r2.line([], 'access-list 5 permit host 10.9.9.9');
    r2.line([['interface', GI1]], 'ip access-group 5 out');
    const other = pkt(r2, echoRequest(PC1, SRV, 1, 1));
    const out = r2.filter(other, 'out', GI1, { inPort: GI0 }).actions;
    expect(drops(out)[0]).toEqual({
      type: 'drop', pdu: other, reason: 'acl-deny', detail: 'ACL 5 implicit deny', port: GI1,
      rule: {
        kind: 'acl', text: `denied by the implicit deny at the end of access list 5, outbound on ${GI1}`, table: 'acl', key: '4|5|implicit',
        config: { context: [['interface', GI1]], line: ['ip', 'access-group', '5', 'out'] }, iface: GI1, dir: 'out', list: '5', seq: 'implicit', family: 4,
      },
    });
    // a global numbered entry is located on its global line
    r2.line([], 'access-list 5 deny host 192.168.10.11');
    const third = r2.filter(pkt(r2, echoRequest(PC2, SRV, 1, 2)), 'out', GI1, { inPort: GI0 }).actions;
    // (the stored line, as typed: where the rule lives)
    expect(drops(third)[0]!.rule).toMatchObject({ seq: 20, config: { context: [], line: ['access-list', '5', 'deny', 'host', '192.168.10.11'] } });
  });
});

describe('acl.daemon: ICMP 3/13 (D12)', () => {
  it('at most one per 500 ms per device; an outbound deny sources it from the request inPort', () => {
    const r = rig();
    r.line([], 'access-list 120 deny ip any any');
    r.line([['interface', GI1]], 'ip access-group 120 out');
    r.line([['interface', GI0]], 'ip access-group 120 in');
    const t0 = 10 * SEC;
    r.at(t0);
    const a = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'out', GI1, { inPort: GI0 }).actions;
    expect(icmpErrors(a)).toEqual([{ kind: 'icmp.error', original: (a[0] as Extract<Action, { type: 'drop' }>).pdu, type: 3, code: 13, inPort: GI0 }]);
    r.at(t0 + ACL_UNREACH_RATE_NS - 1);
    const b = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 2)), 'in', GI0).actions;
    expect(drops(b)).toHaveLength(1);
    expect(icmpErrors(b)).toEqual([]);
    expect(r.aclDebug().at(-1)).toMatch(/^no unreachable for icmp 192\.168\.10\.10 -> 192\.168\.20\.100 \(8\/0\): one was sent less than 500 ms ago$/);
    r.at(t0 + ACL_UNREACH_RATE_NS);
    const c = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 3)), 'in', GI0).actions;
    expect(icmpErrors(c)).toHaveLength(1);
    expect(icmpErrors(c)[0]).toMatchObject({ inPort: GI0 });
    // an outbound deny without inPort lets icmpv4 choose the source (no inPort member)
    r.at(t0 + 2 * ACL_UNREACH_RATE_NS);
    const d = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 4)), 'out', GI1).actions;
    expect(icmpErrors(d)).toEqual([{ kind: 'icmp.error', original: drops(d)[0]!.pdu, type: 3, code: 13 }]);
    expect(r.acl.stateSnapshot().state).toMatchObject({ denied: 4, unreachablesSent: 3, unreachablesLimited: 1 });
  });

  it('none for a natted packet, a multicast or broadcast destination, or an ICMP message other than an echo — and those leave the gate open', () => {
    const r = rig();
    r.line([], 'access-list 120 deny ip any any');
    r.line([['interface', GI1]], 'ip access-group 120 out');
    r.line([['interface', GI0]], 'ip access-group 120 in');
    r.at(20 * SEC);
    const natted = r.filter(pkt(r, echoRequest('203.0.113.1', SRV, 1, 1)), 'out', GI1, { inPort: GI0, natted: true }).actions;
    expect(drops(natted)).toHaveLength(1);
    expect(icmpErrors(natted)).toEqual([]);
    const hello = r.filter(pkt(r, [{ proto: 'ipv4', fields: { src: '192.168.10.2', dst: '224.0.0.5', protocol: 89, ttl: 1, id: 3 } }, { proto: 'payload', fields: { data: new Uint8Array(8) } }]), 'in', GI0).actions;
    expect(drops(hello)).toHaveLength(1);
    expect(icmpErrors(hello)).toEqual([]);
    const timeExceeded = r.filter(pkt(r, [
      { proto: 'ipv4', fields: { src: '192.168.10.2', dst: SRV, protocol: 1, ttl: 64, id: 4 } },
      { proto: 'icmpv4', fields: { type: 11, code: 0, unused: 0 } },
      { proto: 'payload', fields: { data: new Uint8Array(28) } },
    ]), 'in', GI0).actions;
    expect(icmpErrors(timeExceeded)).toEqual([]);
    // the gate is still open: the next eligible deny at the same instant is answered
    const echo = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 2)), 'in', GI0).actions;
    expect(icmpErrors(echo)).toHaveLength(1);
    expect(r.acl.stateSnapshot().state).toMatchObject({ unreachablesSent: 1, unreachablesLimited: 0 });
  });
});

describe('acl.daemon: logging (D12, §3.3 step 3)', () => {
  it('the first packet of a flow is logged at once; the others are aggregated every 5 minutes; an idle flow is forgotten', () => {
    const r = rig();
    section33(r);
    const t0 = 100 * SEC;
    const syn = (at: number): Action[] => {
      r.at(at);
      return r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80)), 'in', GI0).actions;
    };
    const line1 = `list ${LIST} line 10 denied tcp ${PC1}(49152) -> ${SRV}(80)`;
    const first = syn(t0);
    expect(logs(first)).toEqual([{ type: 'log', severity: ACL_LOG_SEVERITY, facility: ACL_LOG_FACILITY, message: `${line1}, 1 packet` }]);
    expect(first.filter((a) => a.type === 'timer')).toEqual([{ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true }]);
    expect(ACL_LOG_SEVERITY).toBe(6);
    expect(ACL_LOG_FACILITY).toBe('ACL');
    // the SYN retransmissions (1, 3 and 7 s later): counted, not logged, the timer not re-armed
    for (const dt of [1, 3, 7]) {
      const more = syn(t0 + dt * SEC);
      expect(logs(more)).toEqual([]);
      expect(more.filter((a) => a.type === 'timer')).toEqual([]);
    }
    expect(r.table.get(aclKey(4, LIST, 10))!.matches).toBe(4);
    // a second flow (another source port) is its own first packet; the timer stays armed
    const other = (() => {
      r.at(t0 + 8 * SEC);
      return r.filter(pkt(r, tcpSyn(PC1, 49153, SRV, 80)), 'in', GI0).actions;
    })();
    expect(logs(other).map((l) => l.message)).toEqual([`list ${LIST} line 10 denied tcp ${PC1}(49153) -> ${SRV}(80), 1 packet`]);
    expect(other.filter((a) => a.type === 'timer')).toEqual([]);
    // the aggregation tick: one line for the flow with packets; the flow without any is kept until the next tick
    r.at(t0 + ACL_LOG_INTERVAL_NS);
    const tick = r.acl.onTimer(r.ctx, ACL_LOG_TIMER);
    expect(tick).toEqual([
      { type: 'log', severity: 6, facility: 'ACL', message: `${line1}, 3 packets` },
      { type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true },
    ]);
    // the next tick: nothing new, both flows forgotten, the timer lapses
    r.at(t0 + 2 * ACL_LOG_INTERVAL_NS);
    expect(r.acl.onTimer(r.ctx, ACL_LOG_TIMER)).toEqual([]);
    expect(r.acl.stateSnapshot().state).toMatchObject({ logFlows: 0 });
    // a later packet of the same flow is logged at once again and re-arms the timer
    const again = syn(t0 + 2 * ACL_LOG_INTERVAL_NS + SEC);
    expect(logs(again).map((l) => l.message)).toEqual([`${line1}, 1 packet`]);
    expect(again.filter((a) => a.type === 'timer')).toHaveLength(1);
    // other timer keys are ignored; a permitted packet on an entry without `log` logs nothing
    expect(r.acl.onTimer(r.ctx, 'x')).toEqual([]);
    expect(logs(r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'in', GI0).actions)).toEqual([]);
  });

  it('a permit entry with log logs `permitted`; a standard list logs the source only; the verdict comes first', () => {
    const r = rig();
    r.line([], 'access-list 20 permit 192.168.10.0 0.0.0.255 log');
    r.line([['interface', GI0]], 'ip access-group 20 in');
    const pdu = pkt(r, echoRequest(PC1, SRV, 1, 1));
    const { actions, onPermit } = r.filter(pdu, 'in', GI0);
    expect(actions[0]).toEqual(onPermit);
    expect(logs(actions).map((l) => l.message)).toEqual([`list 20 line 10 permitted ${PC1}, 1 packet`]);
    expect(r.table.get('4|20|10')!.entry).toBe('permit 192.168.10.0 0.0.0.255 log');
  });
});

describe('acl.daemon: clear, StateView, silence', () => {
  it('acl.clear resets the counters of one list or of every list, without their last match', () => {
    const r = rig();
    section33(r);
    r.line([], 'access-list 5 permit any');
    r.line([['interface', GI1]], 'ip access-group 5 out');
    r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'in', GI0);
    r.filter(pkt(r, echoRequest(PC1, SRV, 1, 2)), 'out', GI1, { inPort: GI0 });
    const n = r.writes().length;
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.clear', list: '5' })).toEqual([]);
    expect(r.writes().slice(n).map((w) => w.key)).toEqual(['4|5|10']);
    expect(r.table.get('4|5|10')).toEqual({ key: '4|5|10', family: 4, list: '5', type: 'standard', seq: 10, entry: 'permit any', action: 'permit', matches: 0, applied: `${GI1} out`, updatedAt: r.ctx.now });
    expect(r.table.get(aclKey(4, LIST, 20))!.matches).toBe(1);
    expect(r.aclDebug().at(-1)).toBe('counters cleared on access list 5');
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear' });
    expect(r.table.rows().every((x) => x.matches === 0 && x.lastPdu === undefined)).toBe(true);
    expect(r.aclDebug().at(-1)).toBe('counters cleared on every access list');
    // clearing again rewrites nothing
    const m = r.writes().length;
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear' });
    expect(r.writes()).toHaveLength(m);
  });

  it('the StateView, the process shape, and silence at boot without a binding', () => {
    const r = rig();
    expect(r.acl.name).toBe('acl');
    expect(r.acl.handles).toBeUndefined();
    r.line([], 'access-list 1 permit 192.168.10.0 0.0.0.255');
    expect(r.acl.init!(r.ctx)).toEqual([]);
    expect(r.writes()).toEqual([]);
    expect(r.fake.debug).toEqual([]);
    expect(r.acl.stateSnapshot()).toEqual({ process: 'acl', state: { applied: [], permitted: 0, denied: 0, unreachablesSent: 0, unreachablesLimited: 0, logFlows: 0 } });
    expect(() => structuredClone(r.acl.stateSnapshot())).not.toThrow();
    section33(r);
    expect(r.acl.stateSnapshot().state).toMatchObject({ applied: [{ list: LIST, applied: `${GI0} in` }] });
    const pdu = pkt(r, echoRequest(PC1, SRV, 1, 1));
    expect(r.acl.onPdu(r.ctx, pdu, GI0)).toEqual([{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'acl handles no frames', port: GI0 }]);
    expect(r.acl.debugEvents().every((e) => e.process === 'acl' && e.category === ACL_DEBUG_CATEGORY)).toBe(true);
  });
});

describe('acl.daemon [S13]: acl.check and the vty rows (D14, §3.14)', () => {
  it('access-class lists get rows applied "vty in" only on a device that runs vty, after the interface bindings', () => {
    const without = rig();
    without.line([], 'access-list 10 permit host 192.168.10.10');
    without.line([['line', 'vty', '0', '4']], 'access-class 10 in');
    expect(without.table.rows()).toEqual([]);
    const r = rig(['vty']);
    r.line([], 'access-list 10 permit host 192.168.10.10');
    r.line([['line', 'vty', '0', '4']], 'access-class 10 in');
    expect(r.table.rows().map((x) => [x.key, x.applied])).toEqual([['4|10|10', 'vty in'], ['4|10|implicit', 'vty in']]);
    r.line([['interface', GI0]], 'ip access-group 10 in');
    expect(r.table.rows().map((x) => x.applied)).toEqual([`${GI0} in, vty in`, `${GI0} in, vty in`]);
    // an `out` access-class is not a filter of incoming logins
    r.line([['line', 'vty', '0', '4']], 'access-class 10 in', true);
    r.line([['line', 'vty', '0', '4']], 'access-class 10 out');
    expect(r.table.rows().map((x) => x.applied)).toEqual([`${GI0} in`, `${GI0} in`]);
  });

  it('acl.check answers acl.verdict to the owner and counts the row with lastIface vty (no lastPdu)', () => {
    const r = rig(['vty']);
    r.line([], 'access-list 10 permit host 192.168.10.10');
    r.line([['line', 'vty', '0', '4']], 'access-class 10 in');
    r.at(5 * SEC);
    const tuple = { family: 4 as const, proto: 6, src: PC2, dst: '192.168.10.1', srcPort: 49152, dstPort: 22, tcpFlags: 0x02 };
    const denied = r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 4, list: '10', tuple, token: 'login-1', owner: 'vty' });
    expect(denied).toEqual([{ type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'login-1', action: 'deny', seq: 'implicit' } }]);
    expect(r.table.get('4|10|implicit')).toEqual({
      key: '4|10|implicit', family: 4, list: '10', type: 'standard', seq: null, implicit: 'deny', entry: 'deny any', action: 'deny', matches: 1,
      lastAt: 5 * SEC, lastIface: 'vty', lastDir: 'in', applied: 'vty in', updatedAt: 5 * SEC,
    });
    const permitted = r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 4, list: '10', tuple: { ...tuple, src: PC1 }, token: 'login-2', owner: 'vty' });
    expect(permitted).toEqual([{ type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'login-2', action: 'permit', seq: 10 } }]);
    expect(r.table.get('4|10|10')).toMatchObject({ matches: 1, lastIface: 'vty', lastDir: 'in' });
    // a packet match after a vty match carries its PduId again; a vty match after a packet one drops it
    r.line([['interface', GI0]], 'ip access-group 10 in');
    const pdu = pkt(r, echoRequest(PC1, SRV, 1, 1));
    r.filter(pdu, 'in', GI0);
    expect(r.table.get('4|10|10')).toMatchObject({ matches: 2, lastPdu: pdu.id, lastIface: GI0 });
    r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 4, list: '10', tuple: { ...tuple, src: PC1 }, token: 'login-3', owner: 'vty' });
    expect(r.table.get('4|10|10')).not.toHaveProperty('lastPdu');
    // an undefined list admits the login and counts nothing
    const n = r.writes().length;
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 4, list: '99', tuple, token: 'login-4', owner: 'vty' })).toEqual([
      { type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'login-4', action: 'permit', seq: 'implicit' } },
    ]);
    expect(r.writes()).toHaveLength(n);
  });
});

// ── real worlds (staged.world, stage P3, the real acl daemon) ──────────────────────────────────────────────────────

const host = (name: string, address: string, gateway: string): string =>
  [`hostname ${name}`, '!', 'interface GigabitEthernet0', ` ip address ${address} 255.255.255.0`, '!', `ip default-gateway ${gateway}`, '!', 'end', ''].join('\n');

/** PC1 — R1 Gi0/0 (192.168.10.1); R1 Gi0/1 (192.168.20.1) — SRV, R1 with `r1Lines` appended (sections as text lines). */
function world(r1Lines: readonly string[], seed = 41): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { acl: createAcl } });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: host('PC1', PC1, '192.168.10.1') });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: host('SRV', SRV, '192.168.20.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: [
      'hostname R1', '!',
      `interface ${GI0}`, ' ip address 192.168.10.1 255.255.255.0', ' no shutdown', '!',
      `interface ${GI1}`, ' ip address 192.168.20.1 255.255.255.0', ' no shutdown', '!',
      ...r1Lines, '!', 'end', '',
    ].join('\n'),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  return sim;
}

function pingFrom(sim: Simulation, device: string, target: string): { text: string; evs: TraceEvent[] } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  sim.cli.exec(session, `ping ${target}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { text: output(evs, session), evs };
}

describe('acl.daemon in a real world (ipv4 hooks + acl)', () => {
  it('an inbound deny with log: every echo dropped at R1 with its rule, aclDenies, ICMP 3/13 rate-limited, the log lines', () => {
    const sim = world([
      `interface ${GI0}`, ' ip access-group BLOCK in', '!',
      'ip access-list extended BLOCK', ' deny icmp host 192.168.10.10 any log', ' permit ip any any',
    ]);
    const r1 = sim.device('r1')!;
    const rows = (): AclRow[] => r1.tables.get<AclRow>('acl')!.rows();
    // written at boot as the entries were replayed (the implicit row with the first entry), so sorted by key here
    expect(rows().map((x) => [x.key, x.matches, x.applied]).sort()).toEqual([
      ['4|BLOCK|10', 0, `${GI0} in`], ['4|BLOCK|20', 0, `${GI0} in`], ['4|BLOCK|implicit', 0, `${GI0} in`],
    ]);
    const t0 = sim.now;
    const { text, evs } = pingFrom(sim, 'pc1', SRV);
    expect(text).toContain(`Sent ${PING_COUNT}, received 0`);
    const denies = ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'acl-deny');
    expect(denies).toHaveLength(PING_COUNT);
    expect(denies.every((d) => d.port === GI0 && d.rule?.list === 'BLOCK' && d.rule.seq === 10 && d.rule.key === '4|BLOCK|10')).toBe(true);
    expect(r1.port(GI0)!.counters.aclDenies).toBe(PING_COUNT);
    expect(r1.tables.get<AclRow>('acl')!.get('4|BLOCK|10')).toMatchObject({ matches: PING_COUNT, lastIface: GI0, lastDir: 'in', lastPdu: denies.at(-1)!.pdu.id });
    // ICMP 3/13 from R1's Gi0/0 address, never two within 500 ms
    const errors = ofKind(evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'unreachable');
    expect(errors.length).toBeGreaterThan(0);
    for (let i = 1; i < errors.length; i++) expect(errors[i]!.t - errors[i - 1]!.t).toBeGreaterThanOrEqual(ACL_UNREACH_RATE_NS);
    for (const e of errors) expect(sim.pdu(e.pdu.id)!.get('ipv4.src')).toBe('192.168.10.1');
    expect(errors.length + (r1.processes.get('acl')!.stateSnapshot().state as { unreachablesLimited: number }).unreachablesLimited).toBe(PING_COUNT);
    // the first packet logged at once, the others aggregated 300 s after it
    const logLines = (from: readonly TraceEvent[]) => ofKind(from, 'log').filter((l) => l.device === 'r1' && l.facility === 'ACL');
    expect(logLines(evs).map((l) => [l.severity, l.message])).toEqual([[6, `list BLOCK line 10 denied icmp ${PC1} -> ${SRV} (8/0), 1 packet`]]);
    const cursor = sim.trace(0).next;
    sim.runFor(t0 + ACL_LOG_INTERVAL_NS + 10 * SEC - sim.now);
    expect(logLines(sim.trace(cursor).events).map((l) => l.message)).toEqual([`list BLOCK line 10 denied icmp ${PC1} -> ${SRV} (8/0), ${PING_COUNT - 1} packets`]);
  });

  it('an outbound deny: the ICMP is sourced from the ingress interface; locally originated packets pass; replies are not filtered', () => {
    const sim = world([
      `interface ${GI1}`, ' ip access-group TO-SRV out', '!',
      'ip access-list extended TO-SRV', ' deny icmp host 192.168.10.10 any', ' permit ip any any',
    ], 43);
    const { text, evs } = pingFrom(sim, 'pc1', SRV);
    expect(text).toContain(`Sent ${PING_COUNT}, received 0`);
    const denies = ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'acl-deny');
    expect(denies).toHaveLength(PING_COUNT);
    expect(denies.every((d) => d.port === GI1 && d.rule?.dir === 'out')).toBe(true);
    const errors = ofKind(evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'unreachable');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(sim.pdu(e.pdu.id)!.get('ipv4.src')).toBe('192.168.10.1');
    // R1's own ping out Gi0/1 is not filtered (locally originated), and SRV's replies come in unfiltered
    const own = pingFrom(sim, 'r1', SRV);
    expect(own.text).toMatch(/!!!!!/);
    expect(ofKind(own.evs, 'drop').filter((d) => d.reason === 'acl-deny')).toEqual([]);
    expect(sim.device('r1')!.tables.get<AclRow>('acl')!.get('4|TO-SRV|10')!.matches).toBe(PING_COUNT);
  });
});
