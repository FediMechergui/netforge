// Drop markers read the policy rule behind a drop (ARCHITECTURE-P3 §6 "Drop markers read `rule` when present", §3.3
// step 6; W3 web-canvas): the detail line names the rule in short form (`ACL NO-WEB-PC1 #10`), a drop without a rule
// keeps the engine's detail exactly as before, and the layer keeps the rules of the drop events it ingests (keyed by PDU
// and sim time, the newest MAX_DROP_RULES).
import { describe, expect, it } from 'vitest';
import type { DropRule, PduSummary, TraceEvent } from '@netforge/engine';
import {
  MAX_DROP_RULES,
  collectDropRules,
  dropMarkerText,
  dropReasonText,
  dropRuleKey,
  dropRuleLabel,
  ruleOfMarker,
} from '../src/canvas/markers.js';

const ACL_10: DropRule = {
  kind: 'acl',
  text: 'denied by access list NO-WEB-PC1 line 10 (deny tcp host 192.168.10.10 host 192.168.20.100 eq www), inbound on GigabitEthernet0/0',
  table: 'acl',
  key: '4|NO-WEB-PC1|10',
  iface: 'GigabitEthernet0/0',
  dir: 'in',
  list: 'NO-WEB-PC1',
  seq: 10,
  family: 4,
};

function pdu(id: number): PduSummary {
  return { id, proto: 'tcp', size: 58, summary: `TCP 192.168.10.10:49152 > 192.168.20.100:80 [SYN] #${id}` };
}

function drop(id: number, t: number, rule?: DropRule): TraceEvent {
  return { t, kind: 'drop', pdu: pdu(id), device: 'r1', port: 'GigabitEthernet0/0', reason: 'acl-deny', detail: 'denied by NO-WEB-PC1', ...(rule === undefined ? {} : { rule }) };
}

describe('the short form of a rule', () => {
  it('names an access list entry by list and sequence, and the implicit deny in words', () => {
    expect(dropRuleLabel(ACL_10)).toBe('ACL NO-WEB-PC1 #10');
    expect(dropRuleLabel({ kind: 'acl', list: '10', seq: 'implicit' })).toBe('ACL 10 implicit deny');
    expect(dropRuleLabel({ kind: 'acl', list: '101' })).toBe('ACL 101');
    expect(dropRuleLabel({ kind: 'acl' })).toBe('ACL');
  });

  it('names DHCP snooping and ARP inspection with the port when the rule has one', () => {
    expect(dropRuleLabel({ kind: 'dhcp-snooping', iface: 'FastEthernet0/24' })).toBe('DHCP snooping on FastEthernet0/24');
    expect(dropRuleLabel({ kind: 'dhcp-snooping' })).toBe('DHCP snooping');
    expect(dropRuleLabel({ kind: 'arp-inspection', iface: 'FastEthernet0/5' })).toBe('ARP inspection on FastEthernet0/5');
    expect(dropRuleLabel({ kind: 'arp-inspection' })).toBe('ARP inspection');
  });
});

describe('the marker text', () => {
  it('reads the rule as its detail line when the drop has one', () => {
    expect(dropMarkerText('acl-deny', 'a long engine sentence', ACL_10)).toEqual({ title: dropReasonText('acl-deny').title, detail: 'ACL NO-WEB-PC1 #10' });
    expect(dropMarkerText('acl-deny', undefined, ACL_10).detail).toBe('ACL NO-WEB-PC1 #10');
  });

  it('keeps the engine detail exactly as before when the drop has no rule (every P1/P2 drop)', () => {
    for (const [reason, detail] of [
      ['ttl-exceeded', 'TTL reached 0'],
      ['queue-full', 'class class-default is full (64 packets)'],
      ['other', 'a reason in the detail'],
      ['no-route', undefined],
    ] as const) {
      expect(dropMarkerText(reason, detail, undefined)).toEqual(dropReasonText(reason, detail));
    }
  });
});

describe('the rules the layer keeps', () => {
  it('keys a rule by the dropped PDU and the instant', () => {
    expect(dropRuleKey(7, 1_000)).toBe('7|1000');
  });

  it('collects the rules of drop events from an index on, and nothing else', () => {
    const snoop: DropRule = { kind: 'dhcp-snooping', text: 'DHCP server message (OFFER) on untrusted port', iface: 'FastEthernet0/24' };
    const events: TraceEvent[] = [
      drop(1, 10, ACL_10),
      drop(2, 20),
      { t: 25, kind: 'linkState', link: 'l1', up: true },
      drop(3, 30, snoop),
    ];
    const all = new Map<string, DropRule>();
    collectDropRules(all, events);
    expect([...all.keys()]).toEqual(['1|10', '3|30']);
    expect(all.get('3|30')).toBe(snoop);
    const tail = new Map<string, DropRule>();
    collectDropRules(tail, events, 2);
    expect([...tail.keys()]).toEqual(['3|30']);
  });

  it('keeps the newest MAX_DROP_RULES', () => {
    const rules = new Map<string, DropRule>();
    const events = Array.from({ length: MAX_DROP_RULES + 5 }, (_, i) => drop(i + 1, i, ACL_10));
    collectDropRules(rules, events);
    expect(rules.size).toBe(MAX_DROP_RULES);
    expect(rules.has(dropRuleKey(1, 0))).toBe(false);
    expect(rules.has(dropRuleKey(5, 4))).toBe(false);
    expect(rules.has(dropRuleKey(6, 5))).toBe(true);
    expect(rules.has(dropRuleKey(MAX_DROP_RULES + 5, MAX_DROP_RULES + 4))).toBe(true);
  });

  it('finds a marker’s rule: its own first, else the kept one for its PDU and instant', () => {
    const kept = new Map<string, DropRule>([[dropRuleKey(4, 99), ACL_10]]);
    expect(ruleOfMarker({ pdu: 4, simTime: 99 }, kept)).toBe(ACL_10);
    expect(ruleOfMarker({ pdu: 4, simTime: 98 }, kept)).toBeUndefined();
    const own: DropRule = { kind: 'acl', text: 'own', list: 'OWN', seq: 20 };
    expect(ruleOfMarker({ pdu: 4, simTime: 99, rule: own }, kept)).toBe(own);
  });
});
