// Concept models (ARCHITECTURE-P1 §4.13, §8.2 W2 web-learn, §10.2): subnetting workbench maths, VLSM carving,
// seeded practice generator, IPv6 compression/expansion walks (RFC 5952), modified EUI-64 (RFC 4291 §2.5.1,
// Appendix A) and the address-type classifier (RFC 4291 §2.4, §2.7; RFC 4193; RFC 3849; RFC 7346).
import { describe, expect, it } from 'vitest';
import { eui64Address, linkLocalFromMac, normalizeIpv6 } from '@netforge/engine/pure';
import {
  PRACTICE_KINDS,
  bitCells,
  carveVlsm,
  checkPracticeAnswer,
  classfulContext,
  formatBits,
  freeBlocks,
  ipv4ToBits,
  maskBoundary,
  neighbourSubnet,
  parsePrefixOrMask,
  parseSubnetInput,
  practiceProblem,
  prefixForHosts,
  subnetInfo,
} from '../src/concept/subnetting/model.js';
import {
  classifyIpv6,
  eui64Steps,
  findZeroRuns,
  ipv6CompressionSteps,
  ipv6ExpansionSteps,
  ipv6PrefixView,
  longestRun,
  multicastScopeName,
} from '../src/concept/ipv6/model.js';

describe('subnetting workbench model', () => {
  it('192.168.1.130/26 gives network .128, broadcast .191, usable .129–.190, wildcard 0.0.0.63 (§10.2)', () => {
    const s = subnetInfo('192.168.1.130', 26);
    expect(s.network).toBe('192.168.1.128');
    expect(s.broadcast).toBe('192.168.1.191');
    expect(s.firstUsable).toBe('192.168.1.129');
    expect(s.lastUsable).toBe('192.168.1.190');
    expect(s.wildcard).toBe('0.0.0.63');
    expect(s.mask).toBe('255.255.255.192');
    expect(s.usableHosts).toBe(62);
    expect(s.totalAddresses).toBe(64);
    expect(s.hostOffset).toBe(2);
    expect(s.reserved).toBeNull();
    expect(s.isPrivate).toBe(true);
    expect(s.classful).toEqual({ addressClass: 'C', defaultPrefixLen: 24, borrowedBits: 2, subnetCount: 4 });
    expect(s.boundary).toEqual({ prefixLen: 26, octetIndex: 3, networkBitsInOctet: 2, maskOctet: 192, blockSize: 64, onOctetEdge: false });
    expect(formatBits(s.bits.address)).toBe('11000000.10101000.00000001.10000010');
    expect(formatBits(s.bits.mask, 26)).toBe('11111111.11111111.11111111.11|000000');
    expect(formatBits(s.bits.network)).toBe('11000000.10101000.00000001.10000000');
    expect(formatBits(s.bits.broadcast)).toBe('11000000.10101000.00000001.10111111');
    expect(formatBits(s.bits.wildcard)).toBe('00000000.00000000.00000000.00111111');
  });

  it('reads the three input spellings and rejects bad ones', () => {
    expect(parseSubnetInput('192.168.1.130/26')).toEqual({ ok: true, value: { address: '192.168.1.130', prefixLen: 26 } });
    expect(parseSubnetInput(' 192.168.1.130 255.255.255.192 ')).toEqual({ ok: true, value: { address: '192.168.1.130', prefixLen: 26 } });
    expect(parseSubnetInput('192.168.1.130/255.255.255.192')).toEqual({ ok: true, value: { address: '192.168.1.130', prefixLen: 26 } });
    expect(parseSubnetInput('192.168.1.130').ok).toBe(false);
    expect(parseSubnetInput('192.168.1.300/24').ok).toBe(false);
    expect(parseSubnetInput('10.0.0.1/33').ok).toBe(false);
    expect(parseSubnetInput('10.0.0.1 255.0.255.0').ok).toBe(false); // non-contiguous
    expect(parseSubnetInput('').ok).toBe(false);
    expect(parsePrefixOrMask('/0')).toBe(0);
    expect(parsePrefixOrMask('255.255.255.255')).toBe(32);
  });

  it('mask boundary on and off octet edges, /0 and /32', () => {
    expect(maskBoundary(24)).toEqual({ prefixLen: 24, octetIndex: 3, networkBitsInOctet: 0, maskOctet: 0, blockSize: 256, onOctetEdge: true });
    expect(maskBoundary(20)).toMatchObject({ octetIndex: 2, networkBitsInOctet: 4, maskOctet: 240, blockSize: 16 });
    expect(maskBoundary(0)).toMatchObject({ octetIndex: 0, maskOctet: 0, blockSize: 256 });
    expect(maskBoundary(32)).toMatchObject({ octetIndex: 3, networkBitsInOctet: 8, maskOctet: 255, blockSize: 1 });
    expect(formatBits(ipv4ToBits('255.255.255.0'), 24)).toBe('11111111.11111111.11111111|00000000');
    expect(() => maskBoundary(33)).toThrow(RangeError);
  });

  it('bit cells split network and host bits at the prefix', () => {
    const cells = bitCells('172.16.5.4', 20);
    expect(cells).toHaveLength(32);
    expect(cells.filter((c) => c.part === 'network')).toHaveLength(20);
    expect(cells[19]).toEqual({ index: 19, bit: 0, octet: 2, part: 'network' }); // octet 3 is 0000|0101: bit 19 is the 4th 0
    expect(cells[20]!.part).toBe('host');
    expect(cells[21]!.bit).toBe(1);
    expect(cells.map((c) => c.bit).join('')).toBe(ipv4ToBits('172.16.5.4'));
  });

  it('/31 follows RFC 3021 and /32 is one host; reserved addresses are flagged', () => {
    const p2p = subnetInfo('10.0.0.1', 31);
    expect([p2p.network, p2p.broadcast, p2p.firstUsable, p2p.lastUsable, p2p.usableHosts]).toEqual(['10.0.0.0', '10.0.0.1', '10.0.0.0', '10.0.0.1', 2]);
    expect(p2p.reserved).toBeNull();
    const host = subnetInfo('10.0.0.7', 32);
    expect([host.network, host.firstUsable, host.lastUsable, host.usableHosts, host.wildcard]).toEqual(['10.0.0.7', '10.0.0.7', '10.0.0.7', 1, '0.0.0.0']);
    expect(subnetInfo('10.1.2.0', 24).reserved).toBe('network');
    expect(subnetInfo('10.1.2.255', 24).reserved).toBe('broadcast');
    expect(subnetInfo('10.1.2.3', 8).classful).toEqual({ addressClass: 'A', defaultPrefixLen: 8, borrowedBits: 0, subnetCount: 1 });
    expect(classfulContext('224.0.0.5', 24)).toEqual({ addressClass: 'D', defaultPrefixLen: null, borrowedBits: null, subnetCount: null });
    expect(subnetInfo('0.0.0.0', 0).usableHosts).toBe(2 ** 32 - 2);
  });

  it('neighbour subnets step by the block size and stop at the ends of the space', () => {
    expect(neighbourSubnet('192.168.1.130', 26, 1)).toBe('192.168.1.192');
    expect(neighbourSubnet('192.168.1.130', 26, -2)).toBe('192.168.1.0');
    expect(neighbourSubnet('255.255.255.200', 26, 1)).toBeNull();
    expect(neighbourSubnet('0.0.0.1', 24, -1)).toBeNull();
  });
});

describe('VLSM carving', () => {
  it('prefixForHosts: smallest block with enough usable addresses', () => {
    expect(prefixForHosts(1)).toBe(30);
    expect(prefixForHosts(2)).toBe(30);
    expect(prefixForHosts(3)).toBe(29);
    expect(prefixForHosts(62)).toBe(26);
    expect(prefixForHosts(63)).toBe(25);
    expect(prefixForHosts(254)).toBe(24);
    expect(prefixForHosts(0)).toBeNull();
    expect(prefixForHosts(2.5)).toBeNull();
  });

  it('carves largest first, keeps blocks aligned and lists the leftover space', () => {
    const r = carveVlsm('192.168.10.0/24', [
      { name: 'WAN', hosts: 2 },
      { name: 'LAN-A', hosts: 100 },
      { name: 'LAN-C', hosts: 20 },
      { name: 'LAN-B', hosts: 50 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parent).toBe('192.168.10.0/24');
    expect(r.allocations.map((a) => [a.name, a.cidr, a.firstUsable, a.lastUsable, a.broadcast, a.usableHosts, a.spareHosts, a.inputIndex])).toEqual([
      ['LAN-A', '192.168.10.0/25', '192.168.10.1', '192.168.10.126', '192.168.10.127', 126, 26, 1],
      ['LAN-B', '192.168.10.128/26', '192.168.10.129', '192.168.10.190', '192.168.10.191', 62, 12, 3],
      ['LAN-C', '192.168.10.192/27', '192.168.10.193', '192.168.10.222', '192.168.10.223', 30, 10, 2],
      ['WAN', '192.168.10.224/30', '192.168.10.225', '192.168.10.226', '192.168.10.227', 2, 0, 0],
    ]);
    expect(r.allocations[1]!.mask).toBe('255.255.255.192');
    expect(r.free).toEqual(['192.168.10.228/30', '192.168.10.232/29', '192.168.10.240/28']);
    expect(r.usedAddresses).toBe(228);
    expect(r.totalAddresses).toBe(256);
  });

  it('equal host counts keep input order; a parent written off-boundary is masked', () => {
    const r = carveVlsm('10.0.0.77/28', [{ name: 'x', hosts: 2 }, { name: 'y', hosts: 2 }]);
    expect(r.ok && r.parent).toBe('10.0.0.64/28');
    expect(r.ok && r.allocations.map((a) => a.cidr)).toEqual(['10.0.0.64/30', '10.0.0.68/30']);
    expect(r.ok && r.free).toEqual(['10.0.0.72/29']);
  });

  it('reports the requirement that does not fit, with the subnets placed so far', () => {
    const r = carveVlsm('192.168.1.0/26', [{ name: 'Big', hosts: 70 }, { name: 'Small', hosts: 10 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Big');
    expect(r.error).toContain('/25');
    expect(r.allocations).toEqual([]);
    const r2 = carveVlsm('192.168.1.0/26', [{ name: 'A', hosts: 30 }, { name: 'B', hosts: 30 }, { name: 'C', hosts: 2 }]);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.allocations.map((a) => a.cidr)).toEqual(['192.168.1.0/27', '192.168.1.32/27']);
    expect(r2.error).toContain('C needs a /30');
    expect(carveVlsm('nope', []).ok).toBe(false);
    expect(carveVlsm('10.0.0.0/24', [{ name: '', hosts: 0 }]).ok).toBe(false);
  });

  it('freeBlocks covers a range with the fewest aligned blocks', () => {
    expect(freeBlocks(0, 2 ** 32)).toEqual(['0.0.0.0/0']);
    expect(freeBlocks(1, 8)).toEqual(['0.0.0.1/32', '0.0.0.2/31', '0.0.0.4/30']);
    expect(freeBlocks(5, 5)).toEqual([]);
  });
});

describe('practice generator', () => {
  it('is a pure function of (seed, index): same seed, same series', () => {
    const a = Array.from({ length: 40 }, (_, i) => practiceProblem(1234, i));
    const b = Array.from({ length: 40 }, (_, i) => practiceProblem(1234, i));
    expect(b).toEqual(a);
    const c = Array.from({ length: 40 }, (_, i) => practiceProblem(1235, i));
    expect(c.map((p) => p.prompt)).not.toEqual(a.map((p) => p.prompt));
    // every kind shows up in a long enough series
    const kinds = new Set(Array.from({ length: 200 }, (_, i) => practiceProblem(7, i).kind));
    expect([...kinds].sort()).toEqual([...PRACTICE_KINDS].sort());
  });

  it('pins the first questions of seed 42 so the series never drifts', () => {
    expect([0, 1, 2, 3].map((i) => practiceProblem(42, i)).map((p) => [p.kind, p.address, p.prefixLen, p.hosts, p.answer])).toEqual([
      ['usable-hosts', '188.104.59.86', 17, undefined, '32766'],
      ['prefix-for-hosts', '211.191.232.0', 25, 18, '/27'],
      ['first-usable', '31.160.23.140', 8, undefined, '31.0.0.1'],
      ['usable-hosts', '130.80.180.168', 21, undefined, '2046'],
    ]);
    expect(practiceProblem(42, 2).prompt).toBe('What is the first usable host address in the subnet of 31.160.23.140/8?');
  });

  it('answers agree with subnetInfo / prefixForHosts and addresses are unicast', () => {
    for (let i = 0; i < 300; i++) {
      const p = practiceProblem(99, i);
      const first = Number(p.address.split('.')[0]);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(223);
      expect(first).not.toBe(127);
      if (p.kind === 'prefix-for-hosts') {
        expect(p.answer).toBe(`/${prefixForHosts(p.hosts!)}`);
        expect(Number(p.answer.slice(1))).toBeGreaterThan(p.prefixLen);
        continue;
      }
      expect(p.prefixLen).toBeGreaterThanOrEqual(8);
      expect(p.prefixLen).toBeLessThanOrEqual(30);
      const s = subnetInfo(p.address, p.prefixLen);
      const expected: Record<string, string> = {
        network: s.network,
        broadcast: s.broadcast,
        'first-usable': s.firstUsable,
        'last-usable': s.lastUsable,
        'usable-hosts': String(s.usableHosts),
        mask: s.mask,
        wildcard: s.wildcard,
      };
      expect(p.answer).toBe(expected[p.kind]);
      expect(checkPracticeAnswer(p, p.answer).correct).toBe(true);
    }
  });

  it('kinds can be narrowed and answers are read leniently', () => {
    for (let i = 0; i < 20; i++) expect(practiceProblem(5, i, ['mask']).kind).toBe('mask');
    const mask = practiceProblem(5, 0, ['mask']);
    expect(checkPracticeAnswer(mask, `/${mask.prefixLen}`).correct).toBe(true);
    expect(checkPracticeAnswer(mask, ` ${mask.answer} `).correct).toBe(true);
    const hosts = practiceProblem(5, 0, ['usable-hosts']);
    const withComma = Number(hosts.answer).toLocaleString('en-US');
    expect(checkPracticeAnswer(hosts, withComma).correct).toBe(true);
    const pfx = practiceProblem(5, 0, ['prefix-for-hosts']);
    expect(checkPracticeAnswer(pfx, pfx.answer.slice(1)).correct).toBe(true);
    const wrong = checkPracticeAnswer(practiceProblem(5, 0, ['network']), 'banana');
    expect(wrong).toMatchObject({ correct: false, given: null });
    expect(wrong.explanation.length).toBeGreaterThan(0);
    expect(() => practiceProblem(5, -1)).toThrow(RangeError);
    expect(() => practiceProblem(5, 0, [])).toThrow(RangeError);
  });
});

describe('IPv6 explorer model', () => {
  it('compresses 2001:0db8:0000:0000:0000:ff00:0042:8329 stepwise to 2001:db8::ff00:42:8329 (§10.2)', () => {
    const r = ipv6CompressionSteps('2001:0db8:0000:0000:0000:ff00:0042:8329');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => [s.rule, s.after, s.changed])).toEqual([
      ['expand', '2001:0db8:0000:0000:0000:ff00:0042:8329', false],
      ['drop-leading-zeros', '2001:db8:0:0:0:ff00:42:8329', true],
      ['compress-zero-run', '2001:db8::ff00:42:8329', true],
    ]);
    expect(r.steps[1]!.groups).toEqual([1, 2, 3, 4, 6]);
    expect(r.steps[2]!.groups).toEqual([2, 3, 4]);
    expect(r.compressed).toEqual({ start: 2, length: 3 });
    expect(r.canonical).toBe('2001:db8::ff00:42:8329');
    expect(r.canonical).toBe(normalizeIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329'));
  });

  it('follows RFC 5952 §4: single zero group, longest run, first on a tie, lowercase', () => {
    const one = ipv6CompressionSteps('2001:db8:0:1:1:1:1:1');
    expect(one.ok && one.canonical).toBe('2001:db8:0:1:1:1:1:1');
    expect(one.ok && one.compressed).toBeNull();
    const longest = ipv6CompressionSteps('2001:0:0:1:0:0:0:1');
    expect(longest.ok && longest.canonical).toBe('2001:0:0:1::1');
    const tie = ipv6CompressionSteps('2001:db8:0:0:1:0:0:1');
    expect(tie.ok && tie.canonical).toBe('2001:db8::1:0:0:1');
    expect(tie.ok && tie.steps[2]!.detail).toContain('first one wins');
    const upper = ipv6CompressionSteps('2001:DB8::AB');
    expect(upper.ok && upper.steps[0]!.after).toBe('2001:0db8:0000:0000:0000:0000:0000:00ab');
    expect(upper.ok && upper.canonical).toBe('2001:db8::ab');
    const all = ipv6CompressionSteps('0:0:0:0:0:0:0:0');
    expect(all.ok && all.canonical).toBe('::');
    const noZero = ipv6CompressionSteps('1:2:3:4:5:6:7:8');
    expect(noZero.ok && noZero.steps.map((s) => s.changed)).toEqual([true, true, false]); // 0001 → 1 is a change; no zero run
  });

  it('expansion walks restore :: and pad groups; dotted tails become hex', () => {
    const r = ipv6ExpansionSteps('2001:db8::1');
    expect(r.ok && r.steps.map((s) => [s.rule, s.after])).toEqual([
      ['restore-zero-run', '2001:db8:0:0:0:0:0:1'],
      ['pad-groups', '2001:0db8:0000:0000:0000:0000:0000:0001'],
    ]);
    expect(r.ok && r.steps[0]!.detail).toContain('stands for 5 zero groups');
    const mapped = ipv6ExpansionSteps('::FFFF:192.0.2.1');
    expect(mapped.ok && mapped.steps.map((s) => s.rule)).toEqual(['lowercase', 'ipv4-tail', 'restore-zero-run', 'pad-groups']);
    expect(mapped.ok && mapped.steps[1]!.after).toBe('::ffff:c000:201');
    expect(mapped.ok && mapped.expanded).toBe('0000:0000:0000:0000:0000:ffff:c000:0201');
    expect(mapped.ok && mapped.canonical).toBe('::ffff:c000:201');
  });

  it('rejects invalid text with an explanation', () => {
    for (const bad of ['', '2001:db8::1::2', 'fe80::1%eth0', '2001:db8:g::1', '1:2:3:4:5:6:7:8:9']) {
      const r = ipv6CompressionSteps(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
    expect(ipv6ExpansionSteps('12345::').ok).toBe(false);
  });

  it('zero-run helpers', () => {
    const runs = findZeroRuns([1, 0, 0, 1, 0, 0, 0, 1]);
    expect(runs).toEqual([{ start: 1, length: 2 }, { start: 4, length: 3 }]);
    expect(longestRun(runs)).toEqual({ start: 4, length: 3 });
    expect(longestRun([{ start: 3, length: 1 }])).toBeNull();
  });

  it('EUI-64 steps: split, insert ff:fe, flip the U/L bit, join to the prefix (RFC 4291 App. A)', () => {
    const r = eui64Steps('02:4e:59:e8:af:01');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => [s.rule, s.value])).toEqual([
      ['split-mac', '02:4e:59 | e8:af:01'],
      ['insert-fffe', '02:4e:59:ff:fe:e8:af:01'],
      ['flip-ul-bit', '00:4e:59:ff:fe:e8:af:01'],
      ['interface-id', '4e:59ff:fee8:af01'],
      ['combine', 'fe80::4e:59ff:fee8:af01'],
    ]);
    expect(r.flip).toEqual({ byteBefore: '02', byteAfter: '00', bitsBefore: '00000010', bitsAfter: '00000000', macLocallyAdministered: true });
    expect(r.address).toBe(linkLocalFromMac('02:4e:59:e8:af:01'));

    const g = eui64Steps('00-1A-2B-3C-4D-5E', '2001:db8:acad:1::', 64);
    expect(g.ok && g.address).toBe('2001:db8:acad:1:21a:2bff:fe3c:4d5e');
    expect(g.ok && g.address).toBe(eui64Address('2001:db8:acad:1::', 64, '00:1a:2b:3c:4d:5e'));
    expect(g.ok && g.interfaceIdBytes).toBe('02:1a:2b:ff:fe:3c:4d:5e');
    expect(g.ok && g.flip.macLocallyAdministered).toBe(false);
    // the prefix is cut to its /64 even when host bits are written
    const h = eui64Steps('aabb.ccdd.eeff', '2001:db8:1:2:ffff::9');
    expect(h.ok && h.address).toBe('2001:db8:1:2:a8bb:ccff:fedd:eeff');
    expect(h.ok && h.prefix).toBe('2001:db8:1:2::');

    expect(eui64Steps('zz:00:00:00:00:00').ok).toBe(false);
    expect(eui64Steps('00:1a:2b:3c:4d:5e', '2001:db8::', 48).ok).toBe(false);
    expect(eui64Steps('00:1a:2b:3c:4d:5e', 'not-an-address').ok).toBe(false);
  });

  it('classifies address types (RFC 4291 §2.4, RFC 4193, RFC 3849)', () => {
    const t = (a: string): string => {
      const r = classifyIpv6(a);
      if (!r.ok) throw new Error(r.error);
      return r.value.type;
    };
    expect(t('::')).toBe('unspecified');
    expect(t('::1')).toBe('loopback');
    expect(t('fe80::4e:59ff:fee8:af01')).toBe('link-local');
    expect(t('febf::1')).toBe('link-local');
    expect(t('fec0::1')).toBe('reserved');
    expect(t('fd12:3456:789a:1::1')).toBe('unique-local');
    expect(t('fc00::1')).toBe('unique-local');
    expect(t('::ffff:192.0.2.1')).toBe('ipv4-mapped');
    expect(t('2001:db8:acad::1')).toBe('documentation');
    expect(t('2001:4860::8888')).toBe('global-unicast');
    expect(t('3fff::1')).toBe('global-unicast');
    expect(t('4000::1')).toBe('reserved');
    expect(t('ff02::1')).toBe('multicast');

    const ll = classifyIpv6('FE80::4E:59FF:FEE8:AF01');
    expect(ll.ok && ll.value).toMatchObject({
      address: 'fe80::4e:59ff:fee8:af01',
      expanded: 'fe80:0000:0000:0000:004e:59ff:fee8:af01',
      scope: 'link-local',
      range: 'fe80::/10',
      interfaceId: '4e:59ff:fee8:af01',
      eui64Like: true,
      multicast: null,
    });
    const mapped = classifyIpv6('::ffff:c000:201');
    expect(mapped.ok && mapped.value.description).toContain('192.0.2.1');
    const res = classifyIpv6('4000::1');
    expect(res.ok && res.value.range).toBe('4000::/3');
    expect(classifyIpv6('nope').ok).toBe(false);
  });

  it('multicast: scope, flags, well-known and solicited-node groups (RFC 4291 §2.7, RFC 7346)', () => {
    const all = classifyIpv6('ff02::1');
    expect(all.ok && all.value.multicast).toEqual({
      scopeValue: 2,
      scope: 'link-local',
      flags: { transient: false, prefixBased: false, rendezvous: false },
      wellKnown: 'all nodes on the link',
      solicitedNodeSuffix: null,
    });
    const sn = classifyIpv6('ff02::1:ffe8:af01');
    expect(sn.ok && sn.value.multicast!.solicitedNodeSuffix).toBe('e8af01');
    expect(sn.ok && sn.value.range).toBe('ff02::1:ff00:0/104');
    const site = classifyIpv6('ff05::1:3');
    expect(site.ok && site.value.multicast!.scope).toBe('site-local');
    const tr = classifyIpv6('ff3e:30:2001:db8::1');
    expect(tr.ok && tr.value.multicast).toMatchObject({ scope: 'global', flags: { transient: true, prefixBased: true, rendezvous: false }, wellKnown: null });
    expect(multicastScopeName(1)).toBe('interface-local');
    expect(multicastScopeName(8)).toBe('organization-local');
    expect(multicastScopeName(0xf)).toBe('reserved');
    expect(multicastScopeName(6)).toBe('unassigned');
  });

  it('prefix view splits an address at its prefix length', () => {
    expect(ipv6PrefixView('2001:db8:acad:1::a/64'.split('/')[0]!, 64)).toEqual({
      address: '2001:db8:acad:1::a',
      prefixLen: 64,
      network: '2001:db8:acad:1::',
      cidr: '2001:db8:acad:1::/64',
      expandedNetwork: '2001:0db8:acad:0001:0000:0000:0000:0000',
      prefixNibbles: 16,
      splitsNibble: false,
      hostBits: 64,
    });
    expect(ipv6PrefixView('2001:db8:abcd::', 50)).toMatchObject({ network: '2001:db8:abcd::', prefixNibbles: 12, splitsNibble: true });
    expect(ipv6PrefixView('2001:db8:ffff::', 36).network).toBe('2001:db8:f000::');
    expect(() => ipv6PrefixView('::1', 129)).toThrow(RangeError);
  });
});
