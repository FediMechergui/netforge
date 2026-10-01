/**
 * device.drop-rule — the drop `rule` passthrough and `PortCounters.aclDenies` (ARCHITECTURE-P3 D12, D13, §2.2, §2.4,
 * §2.7; §7 W1 device): a `drop` action's `rule` reaches the trace `drop` event (last key, after `background`), every
 * `acl-deny` drop that names a port counts on that port, and a drop without a rule or of another reason keeps the P2
 * event bytes and adds no counter key.
 */
import { describe, expect, it } from 'vitest';
import type { DropRule } from '../src/contracts/process.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { boot, echoFrame, harness } from './device.harness.js';

const RULE: DropRule = {
  kind: 'acl',
  text: 'denied by access list 101 line 20 (deny tcp host 10.1.1.10 any eq www), inbound on GigabitEthernet0/0',
  table: 'acl',
  key: '4|101|20',
  config: { context: [['ip', 'access-list', 'extended', '101']], line: ['20', 'deny', 'tcp', 'host', '10.1.1.10', 'any', 'eq', 'www'] },
  iface: 'GigabitEthernet0/0',
  dir: 'in',
  list: '101',
  seq: 20,
  family: 4,
};

describe('drop rule passthrough and aclDenies (D12)', () => {
  it('a drop action with a rule puts it on the trace event, last, and counts acl-deny on the named port', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const port = 'GigabitEthernet0/0';
    const plain = echoFrame(h, 'ff:ff:ff:ff:ff:ff');
    const pdu = h.pdus.build(plain.layers.map((l) => ({ proto: l.proto, fields: { ...l.fields } })), { born: 0, origin: 'd_peer', background: true });
    h.device.applyActions('acl', [{ type: 'drop', pdu, reason: 'acl-deny', detail: 'list 101', port, rule: RULE }], 100);
    const drops = h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(drops).toHaveLength(1);
    const ev = drops[0]!;
    expect(ev.rule).toEqual(RULE);
    expect(Object.keys(ev)).toEqual(['t', 'kind', 'pdu', 'device', 'reason', 'port', 'detail', 'background', 'rule']);
    expect(h.device.port(port)!.counters.aclDenies).toBe(1);
    h.device.applyActions('acl', [{ type: 'drop', pdu: echoFrame(h, 'ff:ff:ff:ff:ff:ff'), reason: 'acl-deny', port }], 200);
    expect(h.device.port(port)!.counters.aclDenies).toBe(2);
    // the other ports never gain the key
    expect(h.device.port('GigabitEthernet0/1')!.counters).not.toHaveProperty('aclDenies');
  });

  it('an acl-deny without a port counts nowhere; other reasons never count; no rule keeps the P2 key set', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    h.device.applyActions('acl', [{ type: 'drop', pdu: echoFrame(h, 'ff:ff:ff:ff:ff:ff'), reason: 'acl-deny', detail: 'no port' }], 10);
    h.device.applyActions('ipv4', [{ type: 'drop', pdu: echoFrame(h, 'ff:ff:ff:ff:ff:ff'), reason: 'no-route', port: 'GigabitEthernet0/0' }], 20);
    h.device.applyActions('acl', [{ type: 'drop', pdu: echoFrame(h, 'ff:ff:ff:ff:ff:ff'), reason: 'acl-deny', port: 'NoSuchPort0' }], 30);
    for (const p of h.device.ports.values()) expect(p.counters, p.id).not.toHaveProperty('aclDenies');
    const drops = h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(drops.map((e) => Object.keys(e))).toEqual([
      ['t', 'kind', 'pdu', 'device', 'reason', 'detail'],
      ['t', 'kind', 'pdu', 'device', 'reason', 'port'],
      ['t', 'kind', 'pdu', 'device', 'reason', 'port'],
    ]);
    for (const e of drops) expect(e).not.toHaveProperty('rule');
  });

  it("the runtime's own drops (unknown port, budget) are unchanged", () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    h.device.applyActions('ipv4', [{ type: 'send', port: 'NoSuchPort0', pdu: echoFrame(h, 'ff:ff:ff:ff:ff:ff') }], 5);
    const [ev] = h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(ev).toMatchObject({ kind: 'drop', reason: 'other', detail: 'unknown-port:NoSuchPort0' });
    expect(Object.keys(ev!)).toEqual(['t', 'kind', 'pdu', 'device', 'reason', 'detail']);
  });
});
