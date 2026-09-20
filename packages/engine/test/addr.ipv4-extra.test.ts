import { describe, expect, it } from 'vitest';
import {
  ipv4Class,
  ipv4MulticastMac,
  isIpv4LinkLocal,
  isIpv4Private,
  isIpv4Unspecified,
  usableHostRange,
} from '../src/core/addr6.js';
import { prefixLenToWildcard } from '../src/contracts/addr.js';

describe('IPv4 multicast MAC (RFC 1112 §6.4)', () => {
  it('maps the low 23 bits under 01:00:5e', () => {
    expect(ipv4MulticastMac('224.0.0.5')).toBe('01:00:5e:00:00:05');
    expect(ipv4MulticastMac('224.0.0.251')).toBe('01:00:5e:00:00:fb');
    expect(ipv4MulticastMac('239.255.255.250')).toBe('01:00:5e:7f:ff:fa');
    // the 24th bit is dropped: 224.128.1.1 and 224.0.1.1 share a MAC
    expect(ipv4MulticastMac('224.128.1.1')).toBe('01:00:5e:00:01:01');
    expect(ipv4MulticastMac('224.0.1.1')).toBe('01:00:5e:00:01:01');
    expect(() => ipv4MulticastMac('224.0.0')).toThrow();
  });
});

describe('special IPv4 ranges', () => {
  it('unspecified', () => {
    expect(isIpv4Unspecified('0.0.0.0')).toBe(true);
    expect(isIpv4Unspecified('0.0.0.1')).toBe(false);
    expect(isIpv4Unspecified('garbage')).toBe(false);
  });

  it('link-local 169.254.0.0/16 (APIPA)', () => {
    expect(isIpv4LinkLocal('169.254.0.1')).toBe(true);
    expect(isIpv4LinkLocal('169.254.255.254')).toBe(true);
    expect(isIpv4LinkLocal('169.253.255.255')).toBe(false);
    expect(isIpv4LinkLocal('169.255.0.0')).toBe(false);
    expect(isIpv4LinkLocal('x')).toBe(false);
  });

  it('RFC 1918 private blocks', () => {
    for (const a of ['10.0.0.0', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255']) {
      expect(isIpv4Private(a), a).toBe(true);
    }
    for (const a of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '8.8.8.8', 'bad']) {
      expect(isIpv4Private(a), a).toBe(false);
    }
  });

  it('classful classes', () => {
    expect(ipv4Class('0.0.0.0')).toBe('A');
    expect(ipv4Class('10.1.2.3')).toBe('A');
    expect(ipv4Class('127.255.255.255')).toBe('A');
    expect(ipv4Class('128.0.0.0')).toBe('B');
    expect(ipv4Class('191.255.0.1')).toBe('B');
    expect(ipv4Class('192.0.0.0')).toBe('C');
    expect(ipv4Class('223.255.255.255')).toBe('C');
    expect(ipv4Class('224.0.0.5')).toBe('D');
    expect(ipv4Class('239.1.1.1')).toBe('D');
    expect(ipv4Class('240.0.0.1')).toBe('E');
    expect(ipv4Class('255.255.255.255')).toBe('E');
    expect(() => ipv4Class('1.2.3')).toThrow();
  });
});

describe('usable host range', () => {
  it('192.168.1.130/26 (workbench acceptance vector)', () => {
    expect(usableHostRange('192.168.1.130', 26)).toEqual({
      network: '192.168.1.128',
      broadcast: '192.168.1.191',
      first: '192.168.1.129',
      last: '192.168.1.190',
      count: 62,
    });
    expect(prefixLenToWildcard(26)).toBe('0.0.0.63');
  });

  it('common prefix lengths', () => {
    expect(usableHostRange('10.1.2.3', 8)).toEqual({
      network: '10.0.0.0', broadcast: '10.255.255.255', first: '10.0.0.1', last: '10.255.255.254', count: 16777214,
    });
    expect(usableHostRange('172.16.5.9', 30)).toEqual({
      network: '172.16.5.8', broadcast: '172.16.5.11', first: '172.16.5.9', last: '172.16.5.10', count: 2,
    });
    expect(usableHostRange('203.0.113.77', 24)?.count).toBe(254);
  });

  it('/31 point-to-point (RFC 3021) and /32 host routes', () => {
    expect(usableHostRange('10.0.0.1', 31)).toEqual({
      network: '10.0.0.0', broadcast: '10.0.0.1', first: '10.0.0.0', last: '10.0.0.1', count: 2,
    });
    expect(usableHostRange('10.0.0.7', 32)).toEqual({
      network: '10.0.0.7', broadcast: '10.0.0.7', first: '10.0.0.7', last: '10.0.0.7', count: 1,
    });
  });

  it('/0 covers the whole space', () => {
    expect(usableHostRange('1.2.3.4', 0)).toEqual({
      network: '0.0.0.0', broadcast: '255.255.255.255', first: '0.0.0.1', last: '255.255.255.254', count: 4294967294,
    });
  });

  it('rejects invalid input', () => {
    expect(usableHostRange('10.0.0.256', 24)).toBeNull();
    expect(usableHostRange('10.0.0.1', 33)).toBeNull();
    expect(usableHostRange('10.0.0.1', -1)).toBeNull();
    expect(usableHostRange('10.0.0.1', 24.5)).toBeNull();
  });
});
