import { describe, expect, it } from 'vitest';
import {
  addrHelpersV6,
  bytesToIpv6,
  cidr6,
  commonPrefixLen6,
  eui64Address,
  eui64InterfaceId,
  expandIpv6,
  flowKey,
  formatEndpoint,
  inSubnet6,
  ipFamily,
  ipv6MulticastMac,
  ipv6NetworkOf,
  ipv6Scope,
  ipv6ToBytes,
  isIpv6,
  linkLocalFromMac,
  normalizeIp,
  normalizeIpv6,
  parseCidr6,
  parseIpv6,
  solicitedNodeMulticast,
} from '../src/core/addr6.js';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';

describe('RFC 5952 canonical text', () => {
  const vectors: [string, string][] = [
    // §4.1 leading zeros suppressed
    ['2001:0db8::0001', '2001:db8::1'],
    ['2001:db8:0000:0000:0000:0000:0002:0001', '2001:db8::2:1'],
    // §4.2.1 shorten as much as possible
    ['2001:db8:0:0:0:0:2:1', '2001:db8::2:1'],
    ['2001:db8::0:1', '2001:db8::1'],
    // §4.2.2 a single 16-bit zero field is not shortened
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    // §4.2.3 longest run wins; first run on ties
    ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    // §4.3 lowercase
    ['2001:DB8::AAAA', '2001:db8::aaaa'],
    ['2001:db8::1:0:0:1', '2001:db8::1:0:0:1'],
    // edges
    ['0:0:0:0:0:0:0:0', '::'],
    ['::', '::'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['1:0:0:0:0:0:0:0', '1::'],
    ['1::', '1::'],
    ['fe80:0:0:0:0:0:0:1', 'fe80::1'],
    ['ff02:0:0:0:0:1:ff00:1', 'ff02::1:ff00:1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'],
    ['::2:3:4:5:6:7:8', '0:2:3:4:5:6:7:8'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['1:0:0:0:2:0:0:0', '1::2:0:0:0'],
    ['  2001:db8::1  ', '2001:db8::1'],
    // explorer acceptance vector (§10.2)
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
    // §5 embedded IPv4 is accepted on input but never produced on output
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
    ['::192.0.2.1', '::c000:201'],
    ['64:ff9b::192.0.2.33', '64:ff9b::c000:221'],
    ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:102:304'],
  ];
  for (const [input, canonical] of vectors) {
    it(`${input.trim()} → ${canonical}`, () => {
      expect(normalizeIpv6(input)).toBe(canonical);
      expect(isIpv6(input)).toBe(true);
      // idempotent
      expect(normalizeIpv6(canonical)).toBe(canonical);
    });
  }

  const invalid = [
    '',
    ':',
    ':::',
    '1:::2',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '::1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7',
    '12345::',
    'g::1',
    ':1::',
    '1::2:',
    ':1:2:3:4:5:6:7:8',
    'fe80::1%eth0',
    'fe80::1%1',
    '1:2:3:4:5:6:7:1.2.3.4',
    '::1.2.3.4:5',
    '::1.2.3',
    '::256.1.1.1',
    '1.2.3.4::',
    '2001:db8:: 1',
    '10.0.0.1',
    '2001:db8::/64',
  ];
  for (const s of invalid) {
    it(`rejects ${JSON.stringify(s)}`, () => {
      expect(parseIpv6(s)).toBeNull();
      expect(normalizeIpv6(s)).toBeNull();
      expect(isIpv6(s)).toBe(false);
    });
  }
});

describe('bytes and expansion', () => {
  it('round-trips through bytes', () => {
    const b = ipv6ToBytes('2001:db8::ff00:42:8329');
    expect(Array.from(b)).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0x42, 0x83, 0x29]);
    expect(bytesToIpv6(b)).toBe('2001:db8::ff00:42:8329');
  });

  it('reads at an offset and rejects short buffers', () => {
    const buf = new Uint8Array(20);
    buf.set(ipv6ToBytes('fe80::1'), 4);
    expect(bytesToIpv6(buf, 4)).toBe('fe80::1');
    expect(() => bytesToIpv6(buf, 5)).toThrow(RangeError);
  });

  it('throws on invalid text', () => {
    expect(() => ipv6ToBytes('nope')).toThrow();
    expect(() => expandIpv6('1::2::3')).toThrow();
  });

  it('expands to 8 × 4 hex digits', () => {
    expect(expandIpv6('2001:db8::ff00:42:8329')).toBe('2001:0db8:0000:0000:0000:ff00:0042:8329');
    expect(expandIpv6('::')).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    expect(expandIpv6('FE80::1')).toBe('fe80:0000:0000:0000:0000:0000:0000:0001');
  });
});

describe('family detection', () => {
  it('ipFamily and normalizeIp', () => {
    expect(ipFamily('10.0.0.1')).toBe(4);
    expect(ipFamily('2001:DB8::1')).toBe(6);
    expect(ipFamily('::ffff:10.0.0.1')).toBe(6);
    expect(ipFamily('www.lab.nf')).toBeNull();
    expect(ipFamily('')).toBeNull();
    expect(normalizeIp('010.000.000.001')).toBe('10.0.0.1');
    expect(normalizeIp('2001:0DB8::0001')).toBe('2001:db8::1');
    expect(normalizeIp('300.1.1.1')).toBeNull();
  });
});

describe('prefix maths', () => {
  it('network of an address', () => {
    expect(ipv6NetworkOf('2001:db8:1:2:3:4:5:6', 64)).toBe('2001:db8:1:2::');
    expect(ipv6NetworkOf('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1::');
    expect(ipv6NetworkOf('2001:db8:1:2:3:4:5:6', 0)).toBe('::');
    expect(ipv6NetworkOf('2001:db8:1:2:3:4:5:6', 128)).toBe('2001:db8:1:2:3:4:5:6');
    expect(ipv6NetworkOf('fe80::21a:2bff:fe3c:4d5e', 10)).toBe('fe80::');
    expect(ipv6NetworkOf('2001:db8:ffff::', 35)).toBe('2001:db8:e000::');
    expect(() => ipv6NetworkOf('::1', 129)).toThrow(RangeError);
    expect(() => ipv6NetworkOf('::1', -1)).toThrow(RangeError);
  });

  it('subnet membership', () => {
    expect(inSubnet6('2001:db8:1::5', '2001:db8:1::', 64)).toBe(true);
    expect(inSubnet6('2001:db8:2::5', '2001:db8:1::', 64)).toBe(false);
    expect(inSubnet6('2001:db8:1:0:ffff::', '2001:DB8:1::', 64)).toBe(true);
    expect(inSubnet6('fe80::1', 'fe80::', 10)).toBe(true);
    expect(inSubnet6('febf::1', 'fe80::', 10)).toBe(true);
    expect(inSubnet6('fec0::1', 'fe80::', 10)).toBe(false);
    expect(inSubnet6('::1', '::', 0)).toBe(true);
    expect(inSubnet6('::1', '::2', 128)).toBe(false);
  });

  it('parses and formats CIDR', () => {
    expect(parseCidr6('2001:db8:1::1/64')).toEqual({ network: '2001:db8:1::', prefixLen: 64 });
    expect(parseCidr6(' 2001:DB8::/32 ')).toEqual({ network: '2001:db8::', prefixLen: 32 });
    expect(parseCidr6('::/0')).toEqual({ network: '::', prefixLen: 0 });
    expect(parseCidr6('::1/128')).toEqual({ network: '::1', prefixLen: 128 });
    expect(parseCidr6('::1/129')).toBeNull();
    expect(parseCidr6('::1')).toBeNull();
    expect(parseCidr6('::1/')).toBeNull();
    expect(parseCidr6('fe80::1%eth0/64')).toBeNull();
    expect(parseCidr6('10.0.0.0/8')).toBeNull();
    expect(cidr6('2001:db8:1::1', 64)).toBe('2001:db8:1::/64');
    expect(cidr6('::', 0)).toBe('::/0');
  });

  it('common prefix length', () => {
    expect(commonPrefixLen6('2001:db8::1', '2001:db8::1')).toBe(128);
    expect(commonPrefixLen6('2001:db8::1', '2001:db8::')).toBe(127);
    expect(commonPrefixLen6('2001:db8:1::', '2001:db8:2::')).toBe(46);
    expect(commonPrefixLen6('8000::', '::')).toBe(0);
    expect(commonPrefixLen6('fe80::1', 'fe80::2')).toBe(126);
    expect(commonPrefixLen6('2001:db8:1::1', '2001:db8:1:0:8000::')).toBe(64);
  });
});

describe('scopes', () => {
  const cases: [string, string][] = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['febf:ffff::1', 'link-local'],
    ['fec0::1', 'global'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['ff05::1:3', 'multicast'],
    ['::ffff:192.0.2.1', 'ipv4-mapped'],
    ['2001:db8::1', 'documentation'],
    ['2001:db8:ffff::', 'documentation'],
    ['2001:db9::1', 'global'],
    ['2001:4860::8888', 'global'],
    ['::2', 'global'],
  ];
  for (const [a, scope] of cases) {
    it(`${a} is ${scope}`, () => expect(ipv6Scope(a)).toBe(scope));
  }
});

describe('modified EUI-64 (RFC 4291 appendix A)', () => {
  it('inserts ff:fe and flips the U/L bit', () => {
    expect(Array.from(eui64InterfaceId('00:1a:2b:3c:4d:5e'))).toEqual([0x02, 0x1a, 0x2b, 0xff, 0xfe, 0x3c, 0x4d, 0x5e]);
    // a locally administered MAC has the bit cleared
    expect(Array.from(eui64InterfaceId('02:00:00:00:00:01'))).toEqual([0, 0, 0, 0xff, 0xfe, 0, 0, 1]);
    // dotted and dashed input forms are accepted
    expect(Array.from(eui64InterfaceId('0060.3E47.1530'))).toEqual([0x02, 0x60, 0x3e, 0xff, 0xfe, 0x47, 0x15, 0x30]);
    expect(Array.from(eui64InterfaceId('00-60-3e-47-15-30'))).toEqual([0x02, 0x60, 0x3e, 0xff, 0xfe, 0x47, 0x15, 0x30]);
    expect(() => eui64InterfaceId('nope')).toThrow();
  });

  it('derives link-local addresses', () => {
    expect(linkLocalFromMac('00:1a:2b:3c:4d:5e')).toBe('fe80::21a:2bff:fe3c:4d5e');
    expect(linkLocalFromMac('0060.3e47.1530')).toBe('fe80::260:3eff:fe47:1530');
    expect(linkLocalFromMac('02:00:00:00:00:01')).toBe('fe80::ff:fe00:1');
    // a D8 NetForge port MAC (vector from contracts/addr.ts)
    const mac = portMac(deviceMacBase('d_0001'), 1);
    expect(mac).toBe('02:4e:59:e8:af:01');
    expect(linkLocalFromMac(mac)).toBe('fe80::4e:59ff:fee8:af01');
  });

  it('builds /64 EUI-64 addresses', () => {
    expect(eui64Address('2001:db8:1::', 64, '00:1a:2b:3c:4d:5e')).toBe('2001:db8:1:0:21a:2bff:fe3c:4d5e');
    // host bits of the prefix are replaced
    expect(eui64Address('2001:db8:1:2:aaaa::1', 64, '00:1a:2b:3c:4d:5e')).toBe('2001:db8:1:2:21a:2bff:fe3c:4d5e');
    expect(eui64Address('2001:db8:1::', 48, '00:1a:2b:3c:4d:5e')).toBeNull();
    expect(eui64Address('2001:db8:1::', 128, '00:1a:2b:3c:4d:5e')).toBeNull();
  });
});

describe('multicast derivations', () => {
  it('solicited-node multicast (RFC 4291 §2.7.1)', () => {
    expect(solicitedNodeMulticast('2001:db8:1::1')).toBe('ff02::1:ff00:1');
    expect(solicitedNodeMulticast('fe80::21a:2bff:fe3c:4d5e')).toBe('ff02::1:ff3c:4d5e');
    expect(solicitedNodeMulticast('4037::01:800:200e:8c6c')).toBe('ff02::1:ff0e:8c6c');
    expect(solicitedNodeMulticast('::')).toBe('ff02::1:ff00:0');
  });

  it('IPv6 multicast MAC (RFC 2464 §7)', () => {
    expect(ipv6MulticastMac('ff02::1')).toBe('33:33:00:00:00:01');
    expect(ipv6MulticastMac('ff02::2')).toBe('33:33:00:00:00:02');
    expect(ipv6MulticastMac('ff02::1:ff3c:4d5e')).toBe('33:33:ff:3c:4d:5e');
    expect(ipv6MulticastMac('ff02::1:2')).toBe('33:33:00:01:00:02');
  });
});

describe('endpoints and flow keys', () => {
  it('formats endpoints', () => {
    expect(formatEndpoint('10.0.0.1', 80)).toBe('10.0.0.1:80');
    expect(formatEndpoint('2001:db8::1', 80)).toBe('[2001:db8::1]:80');
    expect(formatEndpoint('2001:0db8::0001', 443)).toBe('[2001:db8::1]:443');
    expect(formatEndpoint('10.0.0.1')).toBe('10.0.0.1');
    expect(formatEndpoint('2001:db8::1')).toBe('2001:db8::1');
    expect(formatEndpoint('2001:db8::1', 0)).toBe('[2001:db8::1]:0');
  });

  it('matches the contract flow-key formats', () => {
    expect(flowKey(4, '10.0.0.1', '10.0.0.2', 'icmp')).toBe('ipv4:10.0.0.1>10.0.0.2:icmp');
    expect(flowKey(6, '2001:db8::1', '2001:db8::2', 'icmpv6')).toBe('ipv6:[2001:db8::1]>[2001:db8::2]:icmpv6');
    expect(flowKey(4, '10.0.0.1', '10.0.0.2', 'tcp', 49152, 80)).toBe('ipv4:10.0.0.1:49152>10.0.0.2:80:tcp');
    expect(flowKey(6, 'fe80::1', 'ff02::1:2', 'udp', 546, 547)).toBe('ipv6:[fe80::1]:546>[ff02::1:2]:547:udp');
    // non-canonical ingress normalises so keys match
    expect(flowKey(6, 'FE80:0::1', 'ff02:0:0:0:0:0:1:2', 'udp', 546, 547)).toBe('ipv6:[fe80::1]:546>[ff02::1:2]:547:udp');
  });

  it('is identical to the P0 icmpv4 key format', () => {
    const p0 = (src: string, dst: string): string => `ipv4:${src}>${dst}:icmp`;
    expect(flowKey(4, '192.168.1.10', '192.168.1.1', 'icmp')).toBe(p0('192.168.1.10', '192.168.1.1'));
  });
});

describe('contract object', () => {
  it('exposes every helper', () => {
    expect(Object.keys(addrHelpersV6)).toHaveLength(27);
    for (const v of Object.values(addrHelpersV6)) expect(typeof v).toBe('function');
  });
});
