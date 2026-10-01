/**
 * W1 l2 (ARCHITECTURE-P3 D13, §3.4 steps 1–5, §4.3, §4.5, §5.3): the pure DHCP snooping decision of eth-switch step 7b.
 *  - the configuration reader (global switch, VLAN lines with their tokens, the MAC check and its stored negation,
 *    trust, the rate limit, static bindings), independent of how the rules store the lines;
 *  - the message extractor over real encoded frames;
 *  - the decision: skip / forward (bind, unbind) / drop / err-disable, in the §3.4 order — the rate limit first, then
 *    untrusted server messages, then the MAC check, then ACK/NAK/RELEASE bookkeeping;
 *  - the binding row helpers (lease expiry integer-safe, static rows, link-down keys).
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson, createConfigAst } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import type { FieldValue, LayerSpec, LayerView } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { DhcpSnoopingRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  DHCP_SNOOPING_DEBUG_CATEGORY,
  DHCP_SNOOPING_ERR_DISABLE_CAUSE,
  ackBinding,
  bindingsOnPort,
  decideDhcpSnooping,
  dhcpSnoopMessageOf,
  dhcpSnoopingActive,
  dhcpSnoopingKey,
  dhcpSnoopingPort,
  readDhcpSnooping,
  snoopingUntrustedServerDetail,
  staticBindingRows,
  vlanLineFor,
} from '../src/protocols/l2/dhcp-snooping.js';
import type { DhcpSnoopMessage, DhcpSnoopingCheck, DhcpSnoopingConfig } from '../src/protocols/l2/dhcp-snooping.js';

const FA1 = 'FastEthernet0/1';
const FA5 = 'FastEthernet0/5';
const FA24 = 'FastEthernet0/24';
const GI1 = 'GigabitEthernet0/1';
const PC1 = '00:50:79:66:68:00';
const ROGUE = '02:4e:77:00:00:24';
const R1 = '02:4e:11:00:00:01';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return { key: t[0] as string, args: t.slice(1), children: [] };
}
/** A tree with full-token nodes (the reader must not depend on the storage the rules choose). */
function cfg(globals: readonly string[], sections: Readonly<Record<string, readonly string[]>> = {}): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: [] };
  for (const g of globals) root.children.push(g.startsWith('no ') ? { key: 'no', args: g.split(' ').slice(1), children: [] } : lineNode(g));
  for (const [port, lines] of Object.entries(sections)) root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  return configAstFromJson(root);
}

/** SW1 of §3.4. */
const SW1_LINES: readonly string[] = ['ip dhcp snooping', 'ip dhcp snooping vlan 10'];
const SW1_PORTS = { [GI1]: ['switchport mode trunk', 'ip dhcp snooping trust'], [FA24]: ['switchport access vlan 10', 'ip dhcp snooping limit rate 10'] };
const SW1 = (): DhcpSnoopingConfig => readDhcpSnooping(cfg(SW1_LINES, SW1_PORTS));

function msg(type: string, over: Partial<DhcpSnoopMessage> = {}): DhcpSnoopMessage {
  const server = type === 'OFFER' || type === 'ACK' || type === 'NAK';
  return {
    type,
    server,
    chaddr: PC1,
    srcMac: server ? R1 : PC1,
    ...(server ? { srcIp: '192.168.10.1' } : {}),
    yiaddr: type === 'ACK' || type === 'OFFER' ? '192.168.10.11' : '0.0.0.0',
    ciaddr: '0.0.0.0',
    ...(type === 'ACK' || type === 'OFFER' ? { leaseS: 86400 } : {}),
    ...over,
  };
}
const check = (over: Partial<DhcpSnoopingCheck> & Pick<DhcpSnoopingCheck, 'msg' | 'port'>): DhcpSnoopingCheck => ({
  config: SW1(),
  vlan: 10,
  now: 60 * SEC,
  ...over,
});

describe('readDhcpSnooping (§5.3)', () => {
  it('nothing is on in an empty configuration; the MAC check defaults on', () => {
    const c = readDhcpSnooping(cfg([]));
    expect(c).toEqual({ enabled: false, vlanLines: [], verifyMac: true, ports: [], staticBindings: [] });
    expect(dhcpSnoopingActive(c, 10)).toBe(false);
  });

  it('reads the §3.4 setup', () => {
    const c = SW1();
    expect(c.enabled).toBe(true);
    expect(c.vlanLines).toEqual([{ ranges: [[10, 10]], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] }]);
    expect(c.ports).toEqual([
      { port: GI1, trusted: true },
      { port: FA24, trusted: false, limitPps: 10, limitLine: ['ip', 'dhcp', 'snooping', 'limit', 'rate', '10'] },
    ]);
    expect(dhcpSnoopingPort(c, GI1).trusted).toBe(true);
    expect(dhcpSnoopingPort(c, FA1)).toEqual({ port: FA1, trusted: false });
    expect(dhcpSnoopingActive(c, 10)).toBe(true);
    expect(dhcpSnoopingActive(c, 20)).toBe(false);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.ports)).toBe(true);
  });

  it('snooping runs only with the global line AND a VLAN line (§4.3)', () => {
    expect(dhcpSnoopingActive(readDhcpSnooping(cfg(['ip dhcp snooping vlan 10'])), 10)).toBe(false);
    expect(dhcpSnoopingActive(readDhcpSnooping(cfg(['ip dhcp snooping'])), 10)).toBe(false);
    expect(dhcpSnoopingActive(readDhcpSnooping(cfg(['ip dhcp snooping', 'ip dhcp snooping vlan 10'])), 10)).toBe(true);
  });

  it('VLAN lists: ranges, several lines (first line naming a VLAN wins for the rule), invalid lists ignored', () => {
    const c = readDhcpSnooping(cfg(['ip dhcp snooping', 'ip dhcp snooping vlan 10,20-22', 'ip dhcp snooping vlan 30', 'ip dhcp snooping vlan 21', 'ip dhcp snooping vlan 5000', 'ip dhcp snooping vlan x']));
    expect(c.vlanLines.map((l) => l.line.join(' '))).toEqual(['ip dhcp snooping vlan 10,20-22', 'ip dhcp snooping vlan 30', 'ip dhcp snooping vlan 21']);
    for (const v of [10, 20, 21, 22, 30]) expect([v, dhcpSnoopingActive(c, v)]).toEqual([v, true]);
    for (const v of [1, 11, 19, 23, 29]) expect([v, dhcpSnoopingActive(c, v)]).toEqual([v, false]);
    expect(vlanLineFor(c.vlanLines, 21)).toEqual(['ip', 'dhcp', 'snooping', 'vlan', '10,20-22']);
    expect(vlanLineFor(c.vlanLines, 30)).toEqual(['ip', 'dhcp', 'snooping', 'vlan', '30']);
    expect(vlanLineFor(c.vlanLines, 99)).toBeUndefined();
    // a list split over tokens
    expect(dhcpSnoopingActive(readDhcpSnooping(cfg(['ip dhcp snooping', 'ip dhcp snooping vlan 10 20'])), 20)).toBe(true);
  });

  it('the MAC check is off only with the stored negation; option 82 lines have no effect', () => {
    expect(readDhcpSnooping(cfg(['ip dhcp snooping', 'no ip dhcp snooping verify mac-address'])).verifyMac).toBe(false);
    expect(readDhcpSnooping(cfg(['ip dhcp snooping', 'ip dhcp snooping verify mac-address'])).verifyMac).toBe(true);
    const withOpt82 = readDhcpSnooping(cfg([...SW1_LINES, 'no ip dhcp snooping information option'], SW1_PORTS));
    expect(withOpt82).toEqual(SW1());
    // a stored negation of another snooping line configures nothing
    expect(readDhcpSnooping(cfg(['no ip dhcp snooping'])).enabled).toBe(false);
  });

  it('trust and limit: per interface; negations, bad rates and lines outside an interface ignored', () => {
    const c = readDhcpSnooping(cfg(['ip dhcp snooping trust'], {
      [FA1]: ['ip dhcp snooping limit rate 0'],
      [FA5]: ['ip dhcp snooping limit rate 2049', 'ip dhcp snooping limit rate 15', 'ip dhcp snooping limit rate 2048'],
      [GI1]: ['ip dhcp snooping trust extra'],
    }));
    expect(c.ports).toEqual([{ port: FA5, trusted: false, limitPps: 2048, limitLine: ['ip', 'dhcp', 'snooping', 'limit', 'rate', '2048'] }]);
    const negated = configAstFromJson({ key: '', args: [], children: [{ key: 'interface', args: [GI1], children: [{ key: 'no', args: ['ip', 'dhcp', 'snooping', 'trust'], children: [] }] }] });
    expect(readDhcpSnooping(negated).ports).toEqual([]);
  });

  it('static bindings: MAC canonicalised, later line for the same (VLAN, MAC) wins, bad lines ignored', () => {
    const c = readDhcpSnooping(cfg([
      'ip source binding 0050.7966.6801 vlan 10 192.168.10.50 interface FastEthernet0/3',
      'ip source binding 00:50:79:66:68:02 vlan 10 192.168.10.51 interface FastEthernet0/4',
      'ip source binding 0050.7966.6801 vlan 10 192.168.10.60 interface FastEthernet0/3',
      'ip source binding zz vlan 10 192.168.10.52 interface FastEthernet0/5',
      'ip source binding 0050.7966.6803 vlan 0 192.168.10.53 interface FastEthernet0/5',
      'ip source binding 0050.7966.6804 vlan 10 300.1.1.1 interface FastEthernet0/5',
      'ip source binding 0050.7966.6805 vlan 10 192.168.10.55 FastEthernet0/5',
    ]));
    expect(c.staticBindings).toEqual([
      { mac: '00:50:79:66:68:02', vlan: 10, ip: '192.168.10.51', port: 'FastEthernet0/4' },
      { mac: '00:50:79:66:68:01', vlan: 10, ip: '192.168.10.60', port: 'FastEthernet0/3' },
    ]);
    expect(staticBindingRows(c, 5 * SEC)).toEqual([
      { key: '10|00:50:79:66:68:02', mac: '00:50:79:66:68:02', ip: '192.168.10.51', vlan: 10, port: 'FastEthernet0/4', kind: 'static', updatedAt: 5 * SEC },
      { key: '10|00:50:79:66:68:01', mac: '00:50:79:66:68:01', ip: '192.168.10.60', vlan: 10, port: 'FastEthernet0/3', kind: 'static', updatedAt: 5 * SEC },
    ]);
  });

  it('reads the same configuration however the rules store the lines (group nodes, a real ConfigAst)', () => {
    const grouped = configAstFromJson({
      key: '', args: [], children: [
        { key: 'ip', args: [], children: [{ key: 'dhcp', args: ['snooping'], children: [] }, { key: 'dhcp', args: ['snooping', 'vlan', '10'], children: [] }] },
        { key: 'interface', args: [GI1], children: [{ key: 'ip', args: [], children: [{ key: 'dhcp', args: ['snooping', 'trust'], children: [] }] }] },
        { key: 'interface', args: [FA24], children: [{ key: 'ip', args: [], children: [{ key: 'dhcp', args: ['snooping', 'limit', 'rate', '10'], children: [] }] }] },
      ],
    });
    expect(readDhcpSnooping(grouped)).toEqual(SW1());
    const ast = createConfigAst();
    ast.set([], ['ip', 'dhcp', 'snooping']);
    ast.set([], ['ip', 'dhcp', 'snooping', 'vlan', '10']);
    ast.set([['interface', GI1]], ['ip', 'dhcp', 'snooping', 'trust']);
    ast.set([['interface', FA24]], ['ip', 'dhcp', 'snooping', 'limit', 'rate', '10']);
    expect(readDhcpSnooping(ast)).toEqual(SW1());
  });
});

describe('dhcpSnoopMessageOf (real encoded frames)', () => {
  const pdus = createPduFactory();
  const meta = { born: 0, origin: 'd_test' };
  function dhcpFrame(src: string, ipSrc: string, sport: number, dport: number, fields: Record<string, FieldValue>): LayerSpec[] {
    return [
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: ipSrc, dst: '255.255.255.255', protocol: IPPROTO_UDP, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: sport, dstPort: dport } },
      { proto: 'dhcp', fields: { xid: 7, ...fields } },
    ];
  }

  it('a rogue OFFER is a server message with its IPv4 source and lease', () => {
    const pdu = pdus.build(dhcpFrame(ROGUE, '10.66.0.1', 67, 68, { op: 2, chaddr: PC1, yiaddr: '10.66.0.20', messageType: 'OFFER', serverId: '10.66.0.1', leaseTimeS: 3600 }), meta);
    expect(dhcpSnoopMessageOf(pdu)).toEqual({ type: 'OFFER', server: true, chaddr: PC1, srcMac: ROGUE, srcIp: '10.66.0.1', yiaddr: '10.66.0.20', ciaddr: '0.0.0.0', leaseS: 3600 });
  });

  it('a DISCOVER is a client message', () => {
    const pdu = pdus.build(dhcpFrame(PC1, '0.0.0.0', 68, 67, { op: 1, chaddr: PC1, messageType: 'DISCOVER' }), meta);
    expect(dhcpSnoopMessageOf(pdu)).toEqual({ type: 'DISCOVER', server: false, chaddr: PC1, srcMac: PC1, srcIp: '0.0.0.0', yiaddr: '0.0.0.0', ciaddr: '0.0.0.0' });
  });

  it('ACK and NAK are server messages; the other client types are not', () => {
    const view = (type: string, op: number): DhcpSnoopMessage | undefined => dhcpSnoopMessageOf({ layers: [
      lv('ethernet', { dst: 'ff:ff:ff:ff:ff:ff', src: R1, type: ETHERTYPE_IPV4 }), lv('dhcp', { op, chaddr: PC1, messageType: type }),
    ] });
    for (const t of ['OFFER', 'ACK', 'NAK']) expect([t, view(t, 2)?.server]).toEqual([t, true]);
    for (const t of ['DISCOVER', 'REQUEST', 'DECLINE', 'RELEASE', 'INFORM']) expect([t, view(t, 1)?.server]).toEqual([t, false]);
    // a relayed client message keeps op 1 (client); an unknown type falls back to BOOTP op
    expect(view('REQUEST', 1)?.server).toBe(false);
    expect(view('LEASEQUERY', 2)?.server).toBe(true);
    expect(view('LEASEQUERY', 1)?.server).toBe(false);
    expect(view('ack', 2)?.type).toBe('ACK');
  });

  it('frames that are not Ethernet-carried DHCP give undefined', () => {
    expect(dhcpSnoopMessageOf({ layers: [] })).toBeUndefined();
    expect(dhcpSnoopMessageOf({ layers: [lv('ethernet', { dst: 'ff:ff:ff:ff:ff:ff', src: PC1, type: 0x0806 }), lv('arp', { op: 1 })] })).toBeUndefined();
    expect(dhcpSnoopMessageOf({ layers: [lv('ipv4', { src: '1.1.1.1' }), lv('dhcp', { op: 1, chaddr: PC1, messageType: 'DISCOVER' })] })).toBeUndefined();
    expect(dhcpSnoopMessageOf({ layers: [lv('ethernet', { src: PC1 }), lv('dhcp', { op: 1, messageType: 'DISCOVER' })] })).toBeUndefined();
  });
});

/** A minimal decoded layer (fields only). */
function lv(proto: string, fields: Record<string, FieldValue>): LayerView {
  return { proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} };
}

describe('decideDhcpSnooping (§3.4 steps 1–5)', () => {
  it('skip: snooping off for the VLAN (or globally) — nothing counted', () => {
    expect(decideDhcpSnooping(check({ port: FA24, msg: msg('OFFER'), vlan: 20 }))).toEqual({ kind: 'skip' });
    const off = readDhcpSnooping(cfg(['ip dhcp snooping vlan 10'], SW1_PORTS));
    expect(decideDhcpSnooping(check({ config: off, port: FA24, msg: msg('OFFER') }))).toEqual({ kind: 'skip' });
  });

  it('step 1: a DISCOVER on an untrusted port without a limit goes on, nothing counted', () => {
    expect(decideDhcpSnooping(check({ port: FA1, msg: msg('DISCOVER') }))).toEqual({ kind: 'forward' });
  });

  it('step 2: a server message on an untrusted port drops dhcp-snooping with the exact detail and the vlan line as rule', () => {
    const v = decideDhcpSnooping(check({ port: FA24, msg: msg('OFFER', { srcMac: ROGUE, srcIp: '10.66.0.1', yiaddr: '10.66.0.20' }) }));
    expect(v).toMatchObject({
      kind: 'drop',
      reason: 'dhcp-snooping',
      detail: 'DHCP server message (OFFER) from 10.66.0.1 on untrusted port FastEthernet0/24 (vlan 10)',
      window: { start: 60 * SEC, count: 1 },
    });
    if (v.kind !== 'drop') throw new Error('drop expected');
    expect(v.rule).toMatchObject({ kind: 'dhcp-snooping', config: { context: [], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] }, iface: FA24 });
    expect(v.rule.text).toContain('ip dhcp snooping trust');
    expect(v.debug).toBe('dropped OFFER from 10.66.0.1 on untrusted FastEthernet0/24 (vlan 10)');
    expect(snoopingUntrustedServerDetail('ACK', ROGUE, FA5, 10)).toBe(`DHCP server message (ACK) from ${ROGUE} on untrusted port FastEthernet0/5 (vlan 10)`);
    // ACK and NAK too; without an IPv4 source the MAC names the sender
    for (const t of ['ACK', 'NAK']) expect(decideDhcpSnooping(check({ port: FA1, msg: msg(t, { srcMac: ROGUE, srcIp: undefined }) }))).toMatchObject({ kind: 'drop', detail: `DHCP server message (${t}) from ${ROGUE} on untrusted port FastEthernet0/1 (vlan 10)` });
  });

  it('step 3: an ACK on the trusted port binds (vlan, chaddr) → yiaddr on the client port of the CAM row', () => {
    const now = 61 * SEC + 5 * MS;
    const v = decideDhcpSnooping(check({ port: GI1, msg: msg('ACK'), clientPort: FA1, now }));
    const row: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400, expiresAt: now + 86400 * SEC, updatedAt: now };
    expect(v).toEqual({ kind: 'forward', bind: row, debug: `binding ${PC1} 192.168.10.11 on ${FA1} (vlan 10), lease 86400 s` });
    expect(dhcpSnoopingKey(10, PC1)).toBe(`10|${PC1}`);
    // a missing CAM row writes no binding, and a debug line says why
    const noCam = decideDhcpSnooping(check({ port: GI1, msg: msg('ACK') }));
    expect(noCam).toEqual({ kind: 'forward', debug: `ACK for ${PC1} (vlan 10) records no binding for 192.168.10.11: the MAC address table has no entry for the client` });
    // OFFER and REQUEST on the trusted port only go on
    expect(decideDhcpSnooping(check({ port: GI1, msg: msg('OFFER'), clientPort: FA1 }))).toEqual({ kind: 'forward' });
    // an ACK to INFORM (no offered address) binds nothing
    expect(decideDhcpSnooping(check({ port: GI1, msg: msg('ACK', { yiaddr: '0.0.0.0', ciaddr: '192.168.10.40' }), clientPort: FA1 }))).toEqual({ kind: 'forward' });
  });

  it('an ACK never replaces a static binding; a renewed ACK rewrites a learned one', () => {
    const stat: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.50', vlan: 10, port: FA1, kind: 'static', updatedAt: 0 };
    const v = decideDhcpSnooping(check({ port: GI1, msg: msg('ACK'), clientPort: FA1, binding: stat }));
    expect(v.kind).toBe('forward');
    expect(v).not.toHaveProperty('bind');
    const learned: DhcpSnoopingRow = { ...stat, ip: '192.168.10.11', kind: 'learned', leaseS: 86400, expiresAt: 86400 * SEC };
    const renew = decideDhcpSnooping(check({ port: GI1, msg: msg('ACK'), clientPort: FA1, binding: learned }));
    expect(renew).toMatchObject({ kind: 'forward', bind: { kind: 'learned', expiresAt: 60 * SEC + 86400 * SEC } });
  });

  it('step 4: NAK removes the learned binding; RELEASE removes it only from the binding port; static bindings stay', () => {
    const learned: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400, updatedAt: 0 };
    expect(decideDhcpSnooping(check({ port: GI1, msg: msg('NAK'), binding: learned }))).toEqual({
      kind: 'forward', unbind: `10|${PC1}`, debug: `binding ${PC1} 192.168.10.11 (vlan 10) removed: NAK`,
    });
    expect(decideDhcpSnooping(check({ port: GI1, msg: msg('NAK') }))).toEqual({ kind: 'forward' });
    expect(decideDhcpSnooping(check({ port: FA1, msg: msg('RELEASE', { ciaddr: '192.168.10.11' }), binding: learned }))).toEqual({
      kind: 'forward', unbind: `10|${PC1}`, debug: `binding ${PC1} 192.168.10.11 (vlan 10) removed: RELEASE on ${FA1}`,
    });
    // a RELEASE for that client from another port leaves the binding
    const spoofed = decideDhcpSnooping(check({ port: FA5, msg: msg('RELEASE', { srcMac: PC1 }), binding: learned }));
    expect(spoofed).toEqual({ kind: 'forward', debug: `RELEASE for ${PC1} on ${FA5} (vlan 10) keeps the binding on ${FA1}` });
    const stat: DhcpSnoopingRow = { ...learned, kind: 'static' };
    delete stat.leaseS;
    expect(decideDhcpSnooping(check({ port: GI1, msg: msg('NAK'), binding: stat }))).toEqual({ kind: 'forward' });
    expect(decideDhcpSnooping(check({ port: FA1, msg: msg('RELEASE'), binding: stat }))).toEqual({ kind: 'forward' });
  });

  it('the MAC check: on untrusted ports only, and off with the stored negation', () => {
    const spoof = msg('DISCOVER', { chaddr: '00:50:79:66:68:99' });
    const v = decideDhcpSnooping(check({ port: FA1, msg: spoof }));
    expect(v).toMatchObject({
      kind: 'drop',
      reason: 'dhcp-snooping',
      detail: `DHCP client message (DISCOVER) on ${FA1} (vlan 10) names client 00:50:79:66:68:99 but comes from ${PC1}`,
      rule: { kind: 'dhcp-snooping', config: { context: [], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] }, iface: FA1 },
    });
    expect(decideDhcpSnooping(check({ port: GI1, msg: spoof }))).toEqual({ kind: 'forward' });
    const noVerify = readDhcpSnooping(cfg([...SW1_LINES, 'no ip dhcp snooping verify mac-address'], SW1_PORTS));
    expect(decideDhcpSnooping(check({ config: noVerify, port: FA1, msg: spoof }))).toEqual({ kind: 'forward' });
  });

  it('step 5: the 11th DHCP message in one sim-time second err-disables the port (the rate check comes first)', () => {
    let window: DhcpSnoopingCheck['window'];
    const base = 100 * SEC;
    const offer = msg('OFFER', { srcMac: ROGUE, srcIp: '10.66.0.1' });
    for (let i = 0; i < 10; i++) {
      const v = decideDhcpSnooping(check({ port: FA24, msg: offer, window, now: base + i * 50 * MS }));
      expect([i, v.kind]).toEqual([i, 'drop']);
      window = (v as { window?: DhcpSnoopingCheck['window'] }).window;
      expect(window).toEqual({ start: base, count: i + 1 });
    }
    const v = decideDhcpSnooping(check({ port: FA24, msg: offer, window, now: base + 999 * MS }));
    expect(v).toEqual({
      kind: 'err-disable',
      window: { start: base, count: 11 },
      reason: 'dhcp-snooping',
      detail: 'DHCP rate limit exceeded on FastEthernet0/24: 11 packets in one second, the limit is 10',
      rule: {
        kind: 'dhcp-snooping',
        text: 'FastEthernet0/24 accepts at most 10 DHCP packets per second; more than that shuts the port down (error-disabled) until it is recovered',
        config: { context: [['interface', FA24]], line: ['ip', 'dhcp', 'snooping', 'limit', 'rate', '10'] },
        iface: FA24,
      },
      errDisable: { cause: 'dhcp-rate-limit', detail: '11 DHCP packets in one second, the limit is 10' },
      debug: 'FastEthernet0/24 (vlan 10): 11 DHCP packets in this second exceed the limit of 10; error-disabling the port',
    });
    expect(DHCP_SNOOPING_ERR_DISABLE_CAUSE).toBe('dhcp-rate-limit');
  });

  it('windows are aligned to sim-time seconds, not to the first packet', () => {
    const offer = msg('OFFER');
    // 10 at 0.5–0.95 s and 10 at 1.0–1.45 s: 20 packets within one rolling second, but two aligned windows → no err-disable
    let window: DhcpSnoopingCheck['window'];
    for (let i = 0; i < 20; i++) {
      const v = decideDhcpSnooping(check({ port: FA24, msg: offer, window, now: 500 * MS + i * 50 * MS }));
      expect([i, v.kind]).toEqual([i, 'drop']);
      window = (v as { window?: DhcpSnoopingCheck['window'] }).window;
    }
    expect(window).toEqual({ start: SEC, count: 10 });
  });

  it('a limit on a trusted port counts client and server messages alike', () => {
    const c = readDhcpSnooping(cfg(SW1_LINES, { [GI1]: ['ip dhcp snooping trust', 'ip dhcp snooping limit rate 2'] }));
    let window: DhcpSnoopingCheck['window'];
    const kinds: string[] = [];
    for (const m of [msg('OFFER'), msg('REQUEST'), msg('ACK')]) {
      const v = decideDhcpSnooping(check({ config: c, port: GI1, msg: m, window, clientPort: FA1 }));
      kinds.push(v.kind);
      window = (v as { window?: DhcpSnoopingCheck['window'] }).window;
    }
    expect(kinds).toEqual(['forward', 'forward', 'err-disable']);
  });

  it('debug lines use the ip dhcp snooping category', () => {
    expect(DHCP_SNOOPING_DEBUG_CATEGORY).toBe('ip dhcp snooping');
  });
});

describe('binding helpers', () => {
  it('ackBinding: finite lease → expiresAt; infinite or unsafe lease → none; no lease option → no leaseS', () => {
    const now = 7 * SEC;
    expect(ackBinding(msg('ACK', { leaseS: 3600 }), 10, FA1, now)).toMatchObject({ leaseS: 3600, expiresAt: now + 3600 * SEC });
    const inf = ackBinding(msg('ACK', { leaseS: 0xffffffff }), 10, FA1, now)!;
    expect(inf.leaseS).toBe(0xffffffff);
    expect(inf).not.toHaveProperty('expiresAt');
    const huge = ackBinding(msg('ACK', { leaseS: 200 * 86400 }), 10, FA1, now)!;
    expect(huge).not.toHaveProperty('expiresAt');
    expect(Number.isSafeInteger(ackBinding(msg('ACK', { leaseS: 100 * 86400 }), 10, FA1, now)!.expiresAt)).toBe(true);
    const noLease = ackBinding(msg('ACK', { leaseS: undefined }), 10, FA1, now)!;
    expect(noLease).not.toHaveProperty('leaseS');
    expect(noLease).not.toHaveProperty('expiresAt');
    expect(ackBinding(msg('ACK'), 10, undefined, now)).toBeUndefined();
    expect(ackBinding(msg('ACK', { yiaddr: '0.0.0.0' }), 10, FA1, now)).toBeUndefined();
  });

  it('bindingsOnPort: the learned rows of a port (link-down), never static ones', () => {
    const rows: DhcpSnoopingRow[] = [
      { key: '10|a', mac: 'a', ip: '1.1.1.1', vlan: 10, port: FA1, kind: 'learned', updatedAt: 0 },
      { key: '10|b', mac: 'b', ip: '1.1.1.2', vlan: 10, port: FA1, kind: 'static', updatedAt: 0 },
      { key: '20|c', mac: 'c', ip: '1.1.1.3', vlan: 20, port: FA1, kind: 'learned', updatedAt: 0 },
      { key: '10|d', mac: 'd', ip: '1.1.1.4', vlan: 10, port: FA5, kind: 'learned', updatedAt: 0 },
    ];
    expect(bindingsOnPort(rows, FA1)).toEqual(['10|a', '20|c']);
    expect(bindingsOnPort(rows, GI1)).toEqual([]);
  });
});
