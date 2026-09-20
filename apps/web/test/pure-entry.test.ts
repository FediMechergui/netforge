// `@netforge/engine/pure` resolution smoke test (ARCHITECTURE-P1 §8.2 W2 stack, §12 item 14). Importing the
// subpath here makes both web checks prove it resolves: `tsc` through the tsconfig `paths` entry and vitest
// through the ordered vite alias (a wrong order would resolve '/pure' to 'index.ts/pure' and fail to load).
import { describe, expect, it } from 'vitest';
import {
  compileDisplayFilter,
  completeDisplayFilter,
  eui64Address,
  fmtBps,
  formatSimTime,
  ipv4Class,
  linkLocalFromMac,
  lookupDisplayField,
  normalizeIpv6,
  parseCidr6,
  parseDisplayFilter,
  usableHostRange,
  type DisplayFilterFrame,
  type Ipv6Address,
} from '@netforge/engine/pure';
import * as main from '@netforge/engine';
import * as pure from '@netforge/engine/pure';

describe('@netforge/engine/pure', () => {
  it('resolves the address helpers (subnetting workbench and IPv6 explorer vectors)', () => {
    const canonical: Ipv6Address | null = normalizeIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329');
    expect(canonical).toBe('2001:db8::ff00:42:8329');
    expect(usableHostRange('192.168.1.130', 26)).toEqual({
      network: '192.168.1.128', broadcast: '192.168.1.191', first: '192.168.1.129', last: '192.168.1.190', count: 62,
    });
    expect(ipv4Class('192.168.1.130')).toBe('C');
    expect(linkLocalFromMac('02:4e:59:e8:af:01')).toBe('fe80::4e:59ff:fee8:af01');
    expect(eui64Address('2001:db8:1::', 64, '02:4e:59:e8:af:01')).toBe('2001:db8:1:0:4e:59ff:fee8:af01');
    expect(parseCidr6('2001:db8:1::5/48')).toEqual({ network: '2001:db8:1::', prefixLen: 48 });
  });

  it('resolves the display filter parser, registry, evaluator and completion', () => {
    expect(parseDisplayFilter('ip.src == 10.0.0.1').ok).toBe(true);
    const bad = parseDisplayFilter('ip.src ==');
    expect(bad.ok).toBe(false);
    expect(lookupDisplayField('frame.number')).toBeDefined();
    const frame: DisplayFilterFrame = { number: 1, len: 60, timeRelativeNs: 0, iface: 0, layers: [] };
    expect(compileDisplayFilter('frame.number == 1').test(frame)).toBe(true);
    expect(compileDisplayFilter('frame.number == 2').test(frame)).toBe(false);
    expect(completeDisplayFilter('fra').items.some((i) => i.label.startsWith('frame'))).toBe(true);
  });

  it('resolves the formatters', () => {
    expect(formatSimTime(61_000_000_000)).toBe('00:01:01.000000');
    expect(fmtBps(1_000_000_000)).toBe('1 Gb/s');
  });

  it('is a separate module from the main entry, which exports the same helpers', () => {
    expect(main.normalizeIpv6).toBe(normalizeIpv6);
    expect(main.compileDisplayFilter).toBe(compileDisplayFilter);
    // Engine-only modules come from the main entry, never from the pure one.
    expect(typeof main.createRibArbiter).toBe('function');
    expect('createRibArbiter' in pure).toBe(false);
  });
});
