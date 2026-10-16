/**
 * W1a l2 (ARCHITECTURE-P3C [S15], §3.7, §4.3): the pure IP source guard decision of eth-switch step 7d.
 *  - the reader (`ip verify source`, `ip verify source port-security`, negations, bad lines);
 *  - the frame view (IPv4, ARP, other, the DHCP client exemption) on real encoded frames;
 *  - the decision order: skip / unfiltered without snooping / exempt / forward / drop with its rule;
 *  - the `port-security` refusal and the `show ip verify source` entries.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import type { DhcpSnoopingRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  decideSourceGuard,
  ipsgNeedsPortSecurity,
  parseSourceGuardLine,
  readSourceGuard,
  sourceGuardFilters,
  sourceGuardViewOf,
} from '../src/protocols/l2/source-guard.js';
import type { SourceGuardCheck, SourceGuardView } from '../src/protocols/l2/source-guard.js';

const FA1 = 'FastEthernet0/1';
const FA5 = 'FastEthernet0/5';
const FA6 = 'FastEthernet0/6';
const PC1 = '00:50:79:66:68:00';
const ATTACKER = '00:50:79:66:68:05';
const SRV1 = '00:50:79:66:68:09';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return t[0] === 'no' ? { key: 'no', args: t.slice(1), children: [] } : { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(globals: readonly string[], sections: Readonly<Record<string, readonly string[]>> = {}): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: globals.map(lineNode) };
  for (const [port, lines] of Object.entries(sections)) root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  return configAstFromJson(root);
}

const PC1_BINDING: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400, expiresAt: 86400 * SEC, updatedAt: 0 };
const ATT_BINDING: DhcpSnoopingRow = { key: `10|${ATTACKER}`, mac: ATTACKER, ip: '192.168.10.12', vlan: 10, port: FA5, kind: 'learned', leaseS: 3600, expiresAt: 3600 * SEC, updatedAt: 0 };
const SRV1_STATIC: DhcpSnoopingRow = { key: `10|${SRV1}`, mac: SRV1, ip: '192.168.10.9', vlan: 10, port: FA6, kind: 'static', updatedAt: 0 };
const BINDINGS = [PC1_BINDING, ATT_BINDING, SRV1_STATIC];

const SW1 = readSourceGuard(cfg([], {
  [FA1]: ['ip verify source'],
  [FA5]: ['ip verify source port-security'],
  [FA6]: ['ip verify source'],
}));

const ipv4 = (srcMac: string, srcIp: string, dhcpClient = false): SourceGuardView => ({ kind: 'ipv4', srcMac, srcIp, dhcpClient });

function check(over: Partial<SourceGuardCheck>): SourceGuardCheck {
  return { config: SW1, port: FA5, vlan: 10, snooping: true, view: ipv4(ATTACKER, '192.168.10.12'), bindings: BINDINGS, now: 10 * SEC, ...over };
}

describe('readSourceGuard', () => {
  it('reads both filter types with their stored tokens; a port without the line is absent', () => {
    expect(SW1.get(FA1)).toEqual({ port: FA1, filter: 'ip', line: ['ip', 'verify', 'source'] });
    expect(SW1.get(FA5)).toEqual({ port: FA5, filter: 'ip-mac', line: ['ip', 'verify', 'source', 'port-security'] });
    expect(SW1.has('FastEthernet0/2')).toBe(false);
    expect(readSourceGuard(cfg([])).size).toBe(0);
  });
  it('ignores negations, global lines and lines that do not parse', () => {
    const c = readSourceGuard(cfg(['ip verify source'], {
      [FA1]: ['no ip verify source'],
      [FA5]: ['ip verify source vlan dhcp-snooping'],
      [FA6]: ['ip verify source port-security extra'],
    }));
    expect(c.size).toBe(0);
  });
  it('parseSourceGuardLine and the port-security refusal', () => {
    expect(parseSourceGuardLine(['ip', 'verify', 'source'])).toBe('ip');
    expect(parseSourceGuardLine(['ip', 'verify', 'source', 'port-security'])).toBe('ip-mac');
    expect(parseSourceGuardLine(['ip', 'verify', 'unicast'])).toBeUndefined();
    expect(ipsgNeedsPortSecurity(['ip', 'verify', 'source', 'port-security'], false)).toBe(true);
    expect(ipsgNeedsPortSecurity(['ip', 'verify', 'source', 'port-security'], true)).toBe(false);
    expect(ipsgNeedsPortSecurity(['ip', 'verify', 'source'], false)).toBe(false);
  });
});

describe('sourceGuardViewOf (real encoded frames)', () => {
  const pdus = createPduFactory();
  it('an ICMP datagram is ipv4 with its sources; a DHCP DISCOVER from 0.0.0.0 is a DHCP client message', () => {
    const ping = pdus.build([
      { proto: 'ethernet', fields: { dst: PC1, src: ATTACKER, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.10.99', dst: '192.168.10.11', protocol: 1, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    ], { born: 0, origin: 'd_test' });
    expect(sourceGuardViewOf(ping)).toEqual(ipv4(ATTACKER, '192.168.10.99'));
    const udp = (sp: number, dp: number) => pdus.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PC1, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '0.0.0.0', dst: '255.255.255.255', protocol: 17, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: sp, dstPort: dp } },
      { proto: 'payload', fields: { data: new Uint8Array(4) } },
    ], { born: 0, origin: 'd_test' });
    expect(sourceGuardViewOf(udp(68, 67))).toEqual(ipv4(PC1, '0.0.0.0', true));
    // a server's reply (67 → 68) and other UDP are not exempt
    expect(sourceGuardViewOf(udp(67, 68))).toEqual(ipv4(PC1, '0.0.0.0', false));
    expect(sourceGuardViewOf(udp(68, 69))).toEqual(ipv4(PC1, '0.0.0.0', false));
  });
  it('ARP is arp; an empty or non-Ethernet frame is other', () => {
    const garp = pdus.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: ATTACKER, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: ATTACKER, spa: '192.168.10.1', tha: '00:00:00:00:00:00', tpa: '192.168.10.1' } },
    ], { born: 0, origin: 'd_test' });
    expect(sourceGuardViewOf(garp)).toEqual({ kind: 'arp' });
    expect(sourceGuardViewOf({ layers: [] })).toEqual({ kind: 'other' });
    expect(sourceGuardViewOf({ layers: [{ proto: 'ethernet', fields: { src: PC1, dst: ATTACKER } }, { proto: 'ipv6', fields: {} }] } as never)).toEqual({ kind: 'other' });
  });
  it('skips an 802.1Q tag to find the IPv4 header', () => {
    const v = sourceGuardViewOf({ layers: [
      { proto: 'ethernet', fields: { src: PC1, dst: ATTACKER } },
      { proto: 'dot1q', fields: { vid: 10 } },
      { proto: 'ipv4', fields: { src: '192.168.10.11' } },
    ] } as never);
    expect(v).toEqual(ipv4(PC1, '192.168.10.11'));
  });
});

describe('decideSourceGuard (step 7d)', () => {
  it('skip: no line on the port', () => {
    expect(decideSourceGuard(check({ port: 'FastEthernet0/2' }))).toEqual({ kind: 'skip' });
  });
  it('unfiltered: snooping is off for the VLAN, with a debug line saying why', () => {
    const v = decideSourceGuard(check({ snooping: false, view: ipv4(ATTACKER, '10.9.9.9') }));
    expect(v.kind).toBe('unfiltered');
    expect(v.kind === 'unfiltered' && v.debug).toContain('DHCP snooping is off for vlan 10');
  });
  it('exempt: ARP, non-IPv4 and DHCP client messages, whatever their source', () => {
    expect(decideSourceGuard(check({ view: { kind: 'arp' } }))).toEqual({ kind: 'exempt' });
    expect(decideSourceGuard(check({ view: { kind: 'other' } }))).toEqual({ kind: 'exempt' });
    expect(decideSourceGuard(check({ view: ipv4(ATTACKER, '0.0.0.0', true) }))).toEqual({ kind: 'exempt' });
    expect(decideSourceGuard(check({ view: ipv4(ATTACKER, '192.168.10.12', true), bindings: [] }))).toEqual({ kind: 'exempt' });
  });
  it('forward: a learned binding of (VLAN, port) admits its address; a static binding admits SRV1', () => {
    expect(decideSourceGuard(check({ port: FA1, view: ipv4(PC1, '192.168.10.11') }))).toEqual({ kind: 'forward', binding: PC1_BINDING });
    // filter ip: the Ethernet source is not checked
    expect(decideSourceGuard(check({ port: FA1, view: ipv4(ATTACKER, '192.168.10.11') }))).toEqual({ kind: 'forward', binding: PC1_BINDING });
    expect(decideSourceGuard(check({ port: FA6, view: ipv4(SRV1, '192.168.10.9'), now: 10_000_000 * SEC }))).toEqual({ kind: 'forward', binding: SRV1_STATIC });
    expect(decideSourceGuard(check({ view: ipv4(ATTACKER, '192.168.10.12') }))).toEqual({ kind: 'forward', binding: ATT_BINDING });
  });
  it('drop: a hand-changed address, with the rule pointing at the interface line', () => {
    const v = decideSourceGuard(check({ view: ipv4(ATTACKER, '192.168.10.99') }));
    expect(v).toEqual({
      kind: 'drop',
      reason: 'ip-source-guard',
      detail: `IPv4 source 192.168.10.99 (MAC ${ATTACKER}) on ${FA5} (vlan 10) has no source binding on this port`,
      rule: expect.objectContaining({ kind: 'ip-source-guard', iface: FA5, config: { context: [['interface', FA5]], line: ['ip', 'verify', 'source', 'port-security'] } }),
      debug: expect.stringContaining('no binding'),
    });
    expect(v.kind === 'drop' && v.rule.table).toBeUndefined();
  });
  it('drop: an address bound on another port or VLAN, or an expired binding', () => {
    expect(decideSourceGuard(check({ view: ipv4(ATTACKER, '192.168.10.11') })).kind).toBe('drop'); // PC1's address, Fa0/1's binding
    expect(decideSourceGuard(check({ vlan: 20, view: ipv4(ATTACKER, '192.168.10.12') })).kind).toBe('drop');
    expect(decideSourceGuard(check({ now: 3600 * SEC })).kind).toBe('drop'); // expiresAt <= now
    expect(decideSourceGuard(check({ now: 3600 * SEC - 1 })).kind).toBe('forward');
  });
  it('drop with port-security: the address is bound but the Ethernet source is spoofed; the rule names the binding', () => {
    const v = decideSourceGuard(check({ view: ipv4('00:50:79:66:68:77', '192.168.10.12') }));
    expect(v.kind).toBe('drop');
    if (v.kind !== 'drop') return;
    expect(v.detail).toBe(`IPv4 source 192.168.10.12 on ${FA5} (vlan 10) is bound to another MAC address than 00:50:79:66:68:77; the port filters on address and MAC`);
    expect(v.rule).toMatchObject({ table: 'dhcp-snooping', key: `10|${ATTACKER}` });
    expect(v.rule.text).toContain('port-security');
  });
});

describe('sourceGuardFilters (show ip verify source)', () => {
  const snooping = (vlan: number): boolean => vlan === 10;
  it('one entry per binding on a guarded port; ip-mac shows the MAC; a port without bindings has one empty entry', () => {
    const sw = readSourceGuard(cfg([], { [FA1]: ['ip verify source'], [FA5]: ['ip verify source port-security'], 'FastEthernet0/7': ['ip verify source'] }));
    const out = sourceGuardFilters(sw, BINDINGS, snooping, (p) => (p === 'FastEthernet0/7' ? 20 : 10), 10 * SEC);
    expect(out).toEqual([
      { port: FA1, filter: 'ip', state: 'active', ip: '192.168.10.11', vlan: 10 },
      { port: FA5, filter: 'ip-mac', state: 'active', ip: '192.168.10.12', mac: ATTACKER, vlan: 10 },
      { port: 'FastEthernet0/7', filter: 'ip', state: 'inactive-no-snooping', vlan: 20 },
    ]);
    expect(sourceGuardFilters(sw, BINDINGS, snooping, () => 10, 10 * SEC, FA5)).toHaveLength(1);
    // the expired binding is not shown
    expect(sourceGuardFilters(sw, BINDINGS, snooping, () => undefined, 3600 * SEC, FA5)).toEqual([{ port: FA5, filter: 'ip-mac', state: 'inactive-no-snooping' }]);
  });
});
