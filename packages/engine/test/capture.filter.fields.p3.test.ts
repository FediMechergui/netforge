/**
 * W2 capture (ARCHITECTURE-P3 §7 W2 "capture" and its approved part; §0 rule 18): the display fields of the P3
 * protocols, split per protocol into `capture/filter/fields/<proto>.ts` with `capture/filter/fields.ts` kept as the
 * index. Run end to end: frames built by the real PDU factory, recorded by the capture hub on an Ethernet point,
 * decoded by the codec registry and filtered by the capture store — the path NetScope's filter bar takes. The brief's
 * named cases: `ospf.type == 1`, `ip.dsfield.dscp == 46`, `esp.spi`, `eigrp.opcode == 5`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortRef } from '../src/contracts/ids.js';
import {
  ETHERTYPE_IPV4,
  ETHERTYPE_LLDP,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  IPPROTO_UDP,
  LLDP_NEAREST_BRIDGE_MAC,
  NF_L2_CONTROL_MAC,
  OSPF_ALL_ROUTERS,
  UDP_PORT_IKE,
  UDP_PORT_NTP,
  UDP_PORT_SYSLOG,
} from '../src/contracts/pdu.js';
import type { LayerSpec, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { OSPF_DD_FLAG, OSPF_PACKET } from '../src/pdu/codecs/ospf.js';
import { EIGRP_FLAG, EIGRP_OPCODE } from '../src/pdu/codecs/eigrp.js';
import { IKEV2_EXCHANGE, IKEV2_FLAG } from '../src/pdu/codecs/ikev2.js';
import { LLDP_CAPABILITY } from '../src/pdu/codecs/lldp.js';
import { NTP_MODE } from '../src/pdu/codecs/ntp.js';
import { captureLinkForEncap, createCaptureHub } from '../src/capture/tap.js';
import type { CaptureStoreImpl } from '../src/capture/store.js';
import { DISPLAY_FIELDS, DISPLAY_FIELD_VALUES, lookupDisplayField } from '../src/capture/filter/fields.js';
import { completeDisplayFilter } from '../src/capture/filter/complete.js';
import { findBannedWords } from '../src/device/catalog/validate.js';

const FIELDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/capture/filter/fields');

/** The P3 protocols (§2.3 ProtoName order: the MUST five, then the approved [S13] [S18] [S19] [S25] [C1] [C13]). */
const P3_PROTOCOLS = [
  'ospf', 'ospf-lsa', 'cdp', 'lldp', 'ntp',
  'telnet', 'ssh', 'gre', 'ppp', 'lcp', 'pap', 'chap', 'ipcp', 'ipv6cp', 'syslog', 'eigrp', 'esp', 'ikev2',
] as const;

const R1: PortRef = { device: 'd_r1', port: 'GigabitEthernet0/0' };
const R1_MAC = '02:00:00:00:01:01';
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

const eth = (type: number, dst = '01:00:5e:00:00:05'): LayerSpec => ({ proto: 'ethernet', fields: { dst, src: R1_MAC, type } });
const ip = (src: string, dst: string, protocol: number, extra: Record<string, number> = {}): LayerSpec => ({ proto: 'ipv4', fields: { src, dst, protocol, ...extra } });
const udp = (srcPort: number, dstPort: number): LayerSpec => ({ proto: 'udp', fields: { srcPort, dstPort } });
const echo = (src: string, dst: string): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst, ttl: 127, protocol: IPPROTO_ICMP } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
];
const ospf = (fields: Record<string, string | number>): LayerSpec[] => [
  eth(ETHERTYPE_IPV4),
  ip('10.0.123.1', OSPF_ALL_ROUTERS, 89, { ttl: 1, dscp: 48 }),
  { proto: 'ospf', fields: { routerId: '1.1.1.1', area: '0.0.0.0', ...fields } },
];
const eigrp = (fields: Record<string, string | number>): LayerSpec[] => [
  eth(ETHERTYPE_IPV4, '01:00:5e:00:00:0a'),
  ip('10.0.12.1', '224.0.0.10', 88, { ttl: 2, dscp: 48 }),
  { proto: 'eigrp', fields: { as: 100, ...fields } },
];
const routerHeader: LayerSpec = { proto: 'ospf-lsa', fields: { age: 1, lsType: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000002, checksum: 0xb47e, length: 36 } };
const networkHeader: LayerSpec = { proto: 'ospf-lsa', fields: { age: 1, lsType: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000001, checksum: 0xd6e7, length: 32 } };
const routerLsa: LayerSpec = { proto: 'ospf-lsa', fields: { age: 1, lsType: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000002, flags: 0, links: 'transit,10.0.123.2,10.0.123.2,1' } };
const networkLsa: LayerSpec = { proto: 'ospf-lsa', fields: { age: 1, lsType: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000001, mask: '255.255.255.0', attached: '2.2.2.2,1.1.1.1' } };

/** One capture, frame name → layer specs, recorded in this order. */
const FRAMES: readonly (readonly [string, LayerSpec[]])[] = [
  ['ospf-hello', ospf({ type: OSPF_PACKET.hello, mask: '255.255.255.0', dr: '10.0.123.2', bdr: '10.0.123.1', neighbors: '2.2.2.2' })],
  ['ospf-dbd', [...ospf({ type: OSPF_PACKET.dbd, mtu: 1500, flags: OSPF_DD_FLAG.I | OSPF_DD_FLAG.M | OSPF_DD_FLAG.MS, ddSeq: 0x101 }), routerHeader, networkHeader]],
  ['ospf-lsu', [...ospf({ type: OSPF_PACKET.lsu }), routerLsa, networkLsa]],
  ['voice', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('192.168.10.10', '192.168.20.10', IPPROTO_UDP, { dscp: 46 }), udp(16384, 16384), { proto: 'payload', fields: { data: new Uint8Array(160) } }]],
  ['best-effort', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('192.168.10.10', '192.168.20.10', IPPROTO_UDP), udp(49152, 9), { proto: 'payload', fields: { data: new Uint8Array(32) } }]],
  ['cdp', [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: R1_MAC, type: 0 } },
    { proto: 'llc', fields: {} },
    { proto: 'cdp', fields: { deviceId: 'R1', portId: 'GigabitEthernet0/0', addresses: '10.0.12.1', capabilities: 'R', platform: 'NF-2911', software: 'NetForge router software 1.0', duplex: 'full' } },
  ]],
  ['lldp', [
    { proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: R1_MAC, type: ETHERTYPE_LLDP } },
    { proto: 'lldp', fields: { chassisId: '02:e7:63:29:c8:00', portId: 'GigabitEthernet0/1', systemName: 'SW1', capabilities: LLDP_CAPABILITY.bridge, enabledCapabilities: LLDP_CAPABILITY.bridge, mgmtAddress: '10.0.0.2' } },
  ]],
  ['ntp-reply', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('10.0.0.10', '10.0.0.1', IPPROTO_UDP), udp(UDP_PORT_NTP, UDP_PORT_NTP), {
    proto: 'ntp', fields: { mode: NTP_MODE.server, stratum: 1, refId: 'LOCL', precision: -20, refTimestamp: '3945139200.000000000', originTimestamp: '3786825612.500000000', receiveTimestamp: '3945139257.123456789', transmitTimestamp: '3945139257.123500000' },
  }]],
  ['ntp-unsync', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('10.0.0.10', '10.0.0.1', IPPROTO_UDP), udp(UDP_PORT_NTP, UDP_PORT_NTP), {
    proto: 'ntp', fields: { leap: 3, mode: NTP_MODE.server, stratum: 16, refId: 'INIT', originTimestamp: '3786825612.500000000', receiveTimestamp: '3945139300.000000005', transmitTimestamp: '3945139300.000000009' },
  }]],
  ['eigrp-hello', eigrp({ opcode: EIGRP_OPCODE.hello, kValues: '1,0,1,0,0', holdS: 15 })],
  ['eigrp-update', eigrp({ opcode: EIGRP_OPCODE.update, flags: EIGRP_FLAG.eot, seq: 2, ack: 1, routes: '10.4.0.0/24,20,1000000,1500,1,255,1,0.0.0.0;10.0.24.0/24,10,1000000,1500,0,255,1,0.0.0.0' })],
  ['eigrp-query', eigrp({ opcode: EIGRP_OPCODE.query, seq: 3, routes: '10.4.0.0/24,inf,1000000,1500,1,255,1,0.0.0.0' })],
  ['eigrp-ack', eigrp({ opcode: EIGRP_OPCODE.hello, ack: 3 })],
  ['esp', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('209.165.200.225', '209.165.200.230', 50, { ttl: 255 }), { proto: 'esp', fields: { spi: 0x5a1f2e3d, seq: 1 } }, ...echo('192.168.1.10', '192.168.2.10')]],
  ['ike-init', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('209.165.200.225', '209.165.200.230', IPPROTO_UDP), udp(UDP_PORT_IKE, UDP_PORT_IKE), {
    proto: 'ikev2', fields: { spiI: '1a2b3c4d5e6f7081', exchange: IKEV2_EXCHANGE.ikeSaInit, flags: IKEV2_FLAG.initiator, sa: 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14', ke: '01'.repeat(32), nonce: '03'.repeat(32) },
  }]],
  ['telnet', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('10.0.0.1', '192.168.1.10', IPPROTO_TCP), { proto: 'tcp', fields: { srcPort: 23, dstPort: 49152, flags: 'PA', seq: 1, ack: 1 } }, { proto: 'telnet', fields: { iac: 'WILL ECHO;WILL SUPPRESS-GO-AHEAD', data: 'Password: ' } }]],
  ['ssh', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('10.0.0.1', '192.168.1.10', IPPROTO_TCP), { proto: 'tcp', fields: { srcPort: 22, dstPort: 49153, flags: 'PA', seq: 1, ack: 1 } }, { proto: 'ssh', fields: { phase: 'version', version: 'SSH-2.0-NF_1.0' } }]],
  ['gre', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), { proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', ttl: 255 } }, { proto: 'gre', fields: {} }, ...echo('172.16.1.10', '172.16.2.10')]],
  ['syslog', [eth(ETHERTYPE_IPV4, '02:00:00:00:02:02'), ip('10.0.0.1', '10.0.0.10', IPPROTO_UDP), udp(UDP_PORT_SYSLOG, UDP_PORT_SYSLOG), {
    proto: 'syslog', fields: { pri: 187, timestamp: 'Jan  6 08:10:03.123', hostname: 'R1', message: '%LINK-3-UPDOWN: Interface GigabitEthernet0/2 link state is now down' },
  }]],
];

function record(): CaptureStoreImpl {
  const f = createPduFactory();
  const hub = createCaptureHub();
  const store = hub.start({ includeBackground: true }, [{ ref: R1, name: 'R1 Gi0/0', ...captureLinkForEncap('ethernet') }]);
  FRAMES.forEach(([, layers], i) => hub.record({ t: i * 1_000_000, dir: 'tx', port: R1, pdu: f.build(layers, meta()), linkType: 'ethernet' }));
  return store;
}

const STORE = record();

/** Names of the frames the filter keeps, in capture order. */
function kept(filter: string): string[] {
  const r = STORE.query({ filter, from: 0, limit: 1000 });
  expect(r.filterError, filter).toBeUndefined();
  return r.rows.map((row) => FRAMES[row.index]![0]);
}

describe('the recorded frames decode as the P3 protocols', () => {
  it('every frame decodes without errors to its protocol stack', () => {
    const rows = STORE.query({ from: 0, limit: 1000 }).rows;
    expect(rows.map((r) => [FRAMES[r.index]![0], r.proto])).toEqual([
      ['ospf-hello', 'ospf'], ['ospf-dbd', 'ospf'], ['ospf-lsu', 'ospf'], ['voice', 'udp'], ['best-effort', 'udp'],
      ['cdp', 'cdp'], ['lldp', 'lldp'], ['ntp-reply', 'ntp'], ['ntp-unsync', 'ntp'],
      ['eigrp-hello', 'eigrp'], ['eigrp-update', 'eigrp'], ['eigrp-query', 'eigrp'], ['eigrp-ack', 'eigrp'],
      ['esp', 'icmpv4'], ['ike-init', 'ikev2'], ['telnet', 'telnet'], ['ssh', 'ssh'], ['gre', 'icmpv4'], ['syslog', 'syslog'],
    ]);
    expect(rows[1]!.layers).toEqual(['ethernet', 'ipv4', 'ospf', 'ospf-lsa', 'ospf-lsa']);
    expect(rows[13]!.layers).toEqual(['ethernet', 'ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']); // the echo carries no data
    for (const r of rows) expect(STORE.record(r.index)!.layers.filter((l) => l.error !== undefined).map((l) => l.proto), FRAMES[r.index]![0]).toEqual([]);
  });
});

describe('OSPF and LSA display fields', () => {
  it('ospf.type == 1 selects exactly the hello', () => {
    expect(kept('ospf.type == 1')).toEqual(['ospf-hello']);
    expect(kept('ospf.msg == 1')).toEqual(['ospf-hello']);
    expect(kept('ospf')).toEqual(['ospf-hello', 'ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.type in {2 4}')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.type != 1')).toEqual(FRAMES.map(([n]) => n).filter((n) => n !== 'ospf-hello'));
  });

  it('reads the hello parameters, the neighbours it lists and the database description bits', () => {
    expect(kept('ospf.srcrouter == 1.1.1.1 && ospf.area_id == 0.0.0.0')).toEqual(['ospf-hello', 'ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.hello.designated_router == 10.0.123.2')).toEqual(['ospf-hello']);
    expect(kept('ospf.hello.backup_designated_router == 10.0.123.1')).toEqual(['ospf-hello']);
    expect(kept('ospf.hello.hello_interval == 10 && ospf.hello.router_dead_interval == 40')).toEqual(['ospf-hello']);
    expect(kept('ospf.hello.active_neighbor == 2.2.2.2')).toEqual(['ospf-hello']);
    expect(kept('ospf.hello.active_neighbor == 3.3.3.3')).toEqual([]);
    expect(kept('ospf.dbd.i == 1 && ospf.dbd.m == 1 && ospf.dbd.ms == 1')).toEqual(['ospf-dbd']);
    expect(kept('ospf.dbd.ms == 0')).toEqual([]);
    expect(kept('ospf.db.interface_mtu == 1500')).toEqual(['ospf-dbd']);
  });

  it('matches every LSA or LSA header copy of a packet', () => {
    expect(kept('ospf-lsa')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf-lsa.lsType == 2')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.lsa == 1')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf-lsa.headerOnly == 1')).toEqual(['ospf-dbd']);
    expect(kept('ospf.advrouter == 2.2.2.2 && ospf.lsa.id == 10.0.123.2')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.lsa.seqnum == 0x80000002')).toEqual(['ospf-dbd', 'ospf-lsu']);
    expect(kept('ospf.lsa.router.linkid == 10.0.123.2')).toEqual(['ospf-lsu']);
    expect(kept('ospf.lsa.network.attachrtr == 1.1.1.1')).toEqual(['ospf-lsu']);
  });
});

describe('the DSCP of the differentiated services field', () => {
  it('ip.dsfield.dscp == 46 selects exactly the expedited-forwarding packet', () => {
    expect(kept('ip.dsfield.dscp == 46')).toEqual(['voice']);
    expect(kept('ipv4.dscp == 46')).toEqual(['voice']);
    expect(kept('ip.dsfield.dscp == 48')).toEqual(['ospf-hello', 'ospf-dbd', 'ospf-lsu', 'eigrp-hello', 'eigrp-update', 'eigrp-query', 'eigrp-ack']);
    expect(kept('ip.dsfield.dscp == 0 && udp.port == 9')).toEqual(['best-effort']);
    expect(lookupDisplayField('ip.dsfield.dscp')).toMatchObject({ reads: ['ipv4.dscp'], type: 'number' });
  });
});

describe('IPsec display fields [C13]', () => {
  it('esp.spi names the security association; the inner packet decodes in the clear (simulated)', () => {
    expect(kept('esp.spi')).toEqual(['esp']);
    expect(kept('esp.spi == 0x5a1f2e3d')).toEqual(['esp']);
    expect(kept('esp.spi == 1511992893')).toEqual(['esp']);
    expect(kept('esp.spi == 1')).toEqual([]);
    expect(kept('esp.sequence == 1 && esp.protocol == 4 && esp.pad_len == 2')).toEqual(['esp']);
    expect(kept('esp.icvValid == 1')).toEqual(['esp']);
    expect(kept('esp && ip.addr == 192.168.2.10')).toEqual(['esp']);
    expect(kept('esp && icmp')).toEqual(['esp']);
  });

  it('isakmp is a familiar name for IKEv2', () => {
    expect(kept('isakmp')).toEqual(['ike-init']);
    expect(kept('ikev2')).toEqual(['ike-init']);
    expect(kept('isakmp.exchtype == 34 && isakmp.messageid == 0')).toEqual(['ike-init']);
    expect(kept('isakmp.ispi == "1a2b3c4d5e6f7081"')).toEqual(['ike-init']);
    expect(kept('isakmp.rspi == "0000000000000000"')).toEqual(['ike-init']);
    expect(kept('ikev2.sa contains "dh=14"')).toEqual(['ike-init']);
  });
});

describe('EIGRP display fields [C1]', () => {
  it('eigrp.opcode == 5 selects the hellos, acknowledgements included', () => {
    expect(kept('eigrp.opcode == 5')).toEqual(['eigrp-hello', 'eigrp-ack']);
    expect(kept('eigrp.opcode == 5 && eigrp.ack != 0')).toEqual(['eigrp-ack']);
    expect(kept('eigrp.opcode == 1')).toEqual(['eigrp-update']);
    expect(kept('eigrp.opcode == 3')).toEqual(['eigrp-query']);
    expect(kept('eigrp')).toEqual(['eigrp-hello', 'eigrp-update', 'eigrp-query', 'eigrp-ack']);
    expect(kept('eigrp.as == 100 && eigrp.par.holdtime == 15')).toEqual(['eigrp-hello']);
  });

  it('eigrp.ipv4.destination gives each route entry, an unreachable one included', () => {
    expect(kept('eigrp.ipv4.destination == 10.4.0.0')).toEqual(['eigrp-update', 'eigrp-query']);
    expect(kept('eigrp.ipv4.destination == 10.0.24.0/24')).toEqual(['eigrp-update']);
    expect(kept('eigrp.routes contains ",inf,"')).toEqual(['eigrp-query']);
  });
});

describe('discovery and time display fields', () => {
  it('CDP (NF format) and LLDP', () => {
    expect(kept('cdp')).toEqual(['cdp']);
    expect(kept('cdp.deviceid == "R1" && cdp.portid == "GigabitEthernet0/0"')).toEqual(['cdp']);
    expect(kept('cdp.address == 10.0.12.1')).toEqual(['cdp']);
    expect(kept('cdp.platform contains "NF-" && cdp.software_version contains "router"')).toEqual(['cdp']);
    expect(kept('lldp')).toEqual(['lldp']);
    expect(kept('lldp.tlv.system.name == "SW1" && lldp.port.id == "GigabitEthernet0/1"')).toEqual(['lldp']);
    expect(kept('lldp.mgn.addr.ip4 == 10.0.0.2 && lldp.time_to_live == 120')).toEqual(['lldp']);
    expect(kept('lldp.chassis.id == "02:e7:63:29:c8:00"')).toEqual(['lldp']);
  });

  it('NTP', () => {
    expect(kept('ntp')).toEqual(['ntp-reply', 'ntp-unsync']);
    expect(kept('ntp.flags.mode == 4')).toEqual(['ntp-reply', 'ntp-unsync']);
    expect(kept('ntp.stratum == 16 && ntp.flags.li == 3')).toEqual(['ntp-unsync']);
    expect(kept('ntp.refid == "LOCL"')).toEqual(['ntp-reply']);
    expect(kept('ntp.org == "3786825612.500000000"')).toEqual(['ntp-reply', 'ntp-unsync']);
    expect(kept('ntp.flags.vn == 4 && ntp.ppoll == 6')).toEqual(['ntp-reply', 'ntp-unsync']);
  });
});

describe('remote access, tunnel and logging display fields [S13] [S18] [S25]', () => {
  it('telnet shows its text in the clear; ssh only its version exchange', () => {
    expect(kept('telnet.data contains "Password"')).toEqual(['telnet']);
    expect(kept('telnet.iac contains "WILL ECHO"')).toEqual(['telnet']);
    expect(kept('ssh.protocol contains "SSH-2.0"')).toEqual(['ssh']);
    expect(kept('ssh.phase == "version"')).toEqual(['ssh']);
  });

  it('gre names the carried protocol; syslog its severity', () => {
    expect(kept('gre')).toEqual(['gre']);
    expect(kept('gre.proto == 0x0800 && gre.flags.key == 0')).toEqual(['gre']);
    expect(kept('gre && ip.addr == 172.16.2.10')).toEqual(['gre']);
    expect(kept('syslog.level == 3 && syslog.facility == 23')).toEqual(['syslog']);
    expect(kept('syslog.msg contains "UPDOWN"')).toEqual(['syslog']);
  });
});

describe('the per-protocol split (rule 18)', () => {
  it('has one display-field file per P3 protocol next to the index', () => {
    for (const proto of P3_PROTOCOLS) expect(existsSync(resolve(FIELDS_DIR, `${proto}.ts`)), proto).toBe(true);
    expect(existsSync(resolve(FIELDS_DIR, '../fields.ts'))).toBe(true);
  });

  it('gives every P3 protocol its own original help text', () => {
    for (const proto of P3_PROTOCOLS) {
      expect(PROTO_FIELDS[proto]?.since, proto).toBe('P3');
      const d = lookupDisplayField(proto);
      expect(d?.type, proto).toBe('protocol');
      expect(d?.help, proto).not.toBe(`The ${proto} protocol.`);
      expect(findBannedWords(d!.help), proto).toEqual([]);
    }
    expect(lookupDisplayField('isakmp')).toMatchObject({ reads: ['ikev2'], type: 'protocol' });
  });

  it('types the familiar names like the canonical fields they read', () => {
    const cases: [string, readonly string[], string][] = [
      ['ospf.msg', ['ospf.type'], 'number'],
      ['ospf.srcrouter', ['ospf.routerId'], 'ipv4'],
      ['ospf.hello.active_neighbor', ['ospf.neighbors'], 'ipv4'],
      ['ospf.dbd.ms', ['ospf.flags'], 'bool'],
      ['ospf.advrouter', ['ospf-lsa.advRouter'], 'ipv4'],
      ['cdp.deviceid', ['cdp.deviceId'], 'string'],
      ['lldp.mgn.addr.ip4', ['lldp.mgmtAddress'], 'ipv4'],
      ['ntp.flags.mode', ['ntp.mode'], 'number'],
      ['esp.sequence', ['esp.seq'], 'number'],
      ['isakmp.exchtype', ['ikev2.exchange'], 'number'],
      ['eigrp.ipv4.destination', ['eigrp.routes'], 'ipv4'],
      ['gre.flags.key', ['gre.keyPresent'], 'bool'],
      ['pap.peer_id', ['pap.peerId'], 'string'],
      ['lcp.opt.magic_number', ['lcp.magic'], 'number'],
    ];
    for (const [name, reads, type] of cases) expect(lookupDisplayField(name), name).toMatchObject({ reads, type });
    const names = DISPLAY_FIELDS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers the enumerated values of the P3 text fields after ==, and the P3 fields by prefix', () => {
    const labels = (text: string): string[] => completeDisplayFilter(text).items.map((i) => i.label);
    expect(labels('ssh.phase == "')).toEqual(['"version"', '"protected"']);
    expect(labels('lcp.opt.auth_protocol == "')).toEqual(['"chap-md5"', '"pap"']);
    expect(labels('ikev2.notify == "N')).toEqual(['"NO_PROPOSAL_CHOSEN"']);
    expect(labels('ospf.hello.')).toEqual([
      'ospf.hello.active_neighbor', 'ospf.hello.backup_designated_router', 'ospf.hello.designated_router',
      'ospf.hello.hello_interval', 'ospf.hello.network_mask', 'ospf.hello.router_dead_interval', 'ospf.hello.router_priority',
    ]);
    expect(DISPLAY_FIELD_VALUES['dhcp.type']).toEqual(['DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM']);
    for (const name of Object.keys(DISPLAY_FIELD_VALUES)) expect(lookupDisplayField(name)?.type, name).toBe('string');
  });
});
