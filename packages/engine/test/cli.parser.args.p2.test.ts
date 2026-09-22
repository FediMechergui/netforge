/**
 * cli/parser.ts P2 arg types (ARCHITECTURE-P2 §2.11; §7 W1 cli): `vlan-list`, `mac-any` and `if-range`, with their
 * canonical values, placeholders, error columns and completion behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ArgSpec, CommandSpec } from '../src/contracts/cli.js';
import type { PortResolution } from '../src/contracts/device.js';
import {
  complete,
  formatVlanListArg,
  help,
  IF_RANGE_SEPARATOR,
  matchCommand,
  MSG_BAD_IF_RANGE,
  MSG_BAD_MAC_ANY,
  MSG_IF_RANGE_MISSING,
  MSG_IF_RANGE_REVERSED,
  MSG_INTERFACE_NOT_CREATED,
  MSG_UNKNOWN_INTERFACE,
  normalizeMacAny,
  placeholderFor,
  resolveInterfaceRange,
  splitInterfaceRange,
  validateArg,
  type MatchContext,
  type MatchResult,
} from '../src/cli/parser.js';

const arg = (type: ArgSpec['type'], extra: Partial<ArgSpec> = {}): ArgSpec => ({ type, help: `A ${type} value`, ...extra });

const SPECS: CommandSpec[] = [
  { path: ['vlans', '<v>'], mode: 'priv-exec', privilege: 1, help: 'VLAN list', args: { v: arg('vlan-list') }, handler: 'h' },
  { path: ['few', '<v>'], mode: 'priv-exec', privilege: 1, help: 'Narrow VLAN list', args: { v: arg('vlan-list', { min: 2, max: 20 }) }, handler: 'h' },
  { path: ['secure', '<m>'], mode: 'priv-exec', privilege: 1, help: 'MAC', args: { m: arg('mac-any') }, handler: 'h' },
  { path: ['range', '<r>'], mode: 'priv-exec', privilege: 1, help: 'Interface range', args: { r: arg('if-range') }, handler: 'h' },
];

/** FastEthernet0/1-12, GigabitEthernet0/1-2, Port-channel1-2, Vlan1 and one subinterface. */
const PORTS: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `FastEthernet0/${i + 1}`),
  'GigabitEthernet0/1',
  'GigabitEthernet0/2',
  'GigabitEthernet0/1.10',
  'Port-channel1',
  'Port-channel2',
  'Vlan1',
];

const SHORT: readonly [string, string][] = [
  ['fastethernet', 'FastEthernet'],
  ['fa', 'FastEthernet'],
  ['f', 'FastEthernet'],
  ['gigabitethernet', 'GigabitEthernet'],
  ['gi', 'GigabitEthernet'],
  ['g', 'GigabitEthernet'],
  ['port-channel', 'Port-channel'],
  ['po', 'Port-channel'],
  ['vlan', 'Vlan'],
];

/** Canonical id of a typed port name, or undefined when this device has no such port. */
function resolveInterface(text: string): string | undefined {
  const m = /^([A-Za-z-]+)(.*)$/.exec(text);
  if (m === null) return undefined;
  const family = SHORT.find(([s]) => s === (m[1] as string).toLowerCase())?.[1];
  if (family === undefined) return undefined;
  const id = `${family}${m[2] as string}`;
  return PORTS.includes(id) ? id : undefined;
}

const CTX: MatchContext = { mode: 'priv-exec', privilege: 15, resolveInterface };

/** The same device through `resolvePort`, where a creatable SVI answers `virtual`. */
const CTX_VIRTUAL: MatchContext = {
  ...CTX,
  resolvePort(text: string): PortResolution {
    const id = resolveInterface(text);
    if (id !== undefined) return { kind: 'existing', port: id };
    return /^vlan\d+$/i.test(text) ? { kind: 'virtual', port: `Vlan${text.replace(/\D/g, '')}`, family: 'Vlan' } : { kind: 'unknown' };
  },
};

function ok(line: string, ctx: MatchContext = CTX): Extract<MatchResult, { ok: true }> {
  const m = matchCommand(SPECS, ctx, line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return m;
}

function fail(line: string, ctx: MatchContext = CTX): Extract<MatchResult, { ok: false }> {
  const m = matchCommand(SPECS, ctx, line);
  if (m.ok) throw new Error(`${line} matched ${JSON.stringify(m.args)}`);
  return m;
}

describe('vlan-list', () => {
  it('canonicalises sorted, merged lists in the stored VLAN-list form', () => {
    expect(ok('vlans 10').args['v']).toBe('10');
    expect(ok('vlans 30-35,10,20').args['v']).toBe('10,20,30-35');
    expect(ok('vlans 1,2,3').args['v']).toBe('1-3');
    // a run of two stays two ids, as the device's running configuration shows it
    expect(ok('vlans 10-11').args['v']).toBe('10,11');
    expect(ok('vlans 1-4094').args['v']).toBe('1-4094');
    expect(ok('vlans 10,10,10').args['v']).toBe('10');
    expect(formatVlanListArg([[1, 1], [3, 5]])).toBe('1,3-5');
  });

  it('refuses ids outside the VLAN range, malformed lists and reversed ranges', () => {
    for (const bad of ['vlans 0', 'vlans 4095', 'vlans 20-10', 'vlans 10,', 'vlans 10..20', 'vlans ten', 'vlans 10-', 'vlans -10']) {
      const f = fail(bad);
      expect(f.kind, bad).toBe('invalid-arg');
      expect(f.error.message, bad).toContain('between 1 and 4094');
      expect(f.error.column, bad).toBe(6);
    }
    expect(fail('few 25').error.message).toContain('between 2 and 20');
    expect(ok('few 2-20').args['v']).toBe('2-20');
  });

  it('shows the bounded placeholder in help', () => {
    expect(placeholderFor(arg('vlan-list'))).toBe('<1-4094>[,-]');
    expect(placeholderFor(arg('vlan-list', { min: 2, max: 20 }))).toBe('<2-20>[,-]');
    expect(help(SPECS, CTX, 'vlans ').items.map((i) => i.token)).toEqual(['<1-4094>[,-]']);
  });
});

describe('mac-any', () => {
  it('accepts every common notation and normalises to the canonical form', () => {
    for (const text of ['aabb.cc00.0100', 'AABB.CC00.0100', 'aa:bb:cc:00:01:00', 'AA-BB-CC-00-01-00', 'aabbcc000100']) {
      expect(ok(`secure ${text}`).args['m'], text).toBe('aa:bb:cc:00:01:00');
    }
    expect(normalizeMacAny('ffff.ffff.ffff')).toBe('ff:ff:ff:ff:ff:ff');
  });

  it('refuses anything else', () => {
    for (const text of ['aabb.cc00', 'aabb.cc00.01000', 'gg:bb:cc:00:01:00', 'aa:bb-cc:00:01:00', 'aabbcc0001', '10.0.0.1']) {
      expect(normalizeMacAny(text), text).toBeNull();
    }
    const f = fail('secure nonsense');
    expect(f.kind).toBe('invalid-arg');
    expect(f.error.message).toBe(MSG_BAD_MAC_ANY);
    expect(f.error.column).toBe(7);
    expect(placeholderFor(arg('mac-any'))).toBe('H.H.H');
  });
});

describe('if-range', () => {
  it('expands ranges over the last number of the canonical port id', () => {
    expect(ok('range fa0/1 - 3').args['r']).toBe('FastEthernet0/1,FastEthernet0/2,FastEthernet0/3');
    expect(ok('range fa0/1-3').args['r']).toBe('FastEthernet0/1,FastEthernet0/2,FastEthernet0/3');
    expect(ok('range fa0/10 - 12, gi0/1').args['r']).toBe('FastEthernet0/10,FastEthernet0/11,FastEthernet0/12,GigabitEthernet0/1');
    expect(ok('range gi 0/1 , gi 0/2').args['r']).toBe('GigabitEthernet0/1,GigabitEthernet0/2');
    expect(ok('range fa0/1').args['r']).toBe('FastEthernet0/1');
    // a hyphenated family name is not a range, and a subinterface varies its own number
    expect(ok('range po1 - 2').args['r']).toBe('Port-channel1,Port-channel2');
    expect(ok('range Port-channel1').args['r']).toBe('Port-channel1');
    expect(ok('range gi0/1.10').args['r']).toBe('GigabitEthernet0/1.10');
    // the typed order is kept and duplicates appear once
    expect(ok('range gi0/2, fa0/1 - 2, gi0/2').args['r']).toBe('GigabitEthernet0/2,FastEthernet0/1,FastEthernet0/2');
    expect(splitInterfaceRange(ok('range fa0/1 - 2').args['r'] as string)).toEqual(['FastEthernet0/1', 'FastEthernet0/2']);
    expect(IF_RANGE_SEPARATOR).toBe(',');
  });

  it('refuses unknown ports, missing range members, reversed ranges and malformed text', () => {
    expect(fail('range fa9/9').error.message).toBe(MSG_UNKNOWN_INTERFACE);
    expect(fail('range fa0/10 - 14').error.message).toBe(MSG_IF_RANGE_MISSING('FastEthernet0/13'));
    expect(fail('range fa0/3 - 1').error.message).toBe(MSG_IF_RANGE_REVERSED);
    expect(fail('range fa0/1,,fa0/2').error.message).toBe(MSG_BAD_IF_RANGE);
    expect(fail('range fa0/1 - fa0/3').error.message).toBe(MSG_UNKNOWN_INTERFACE);
    // the caret sits at the start of the range, which is where the value begins
    expect(fail('range fa9/9').error.column).toBe(6);
    // a range never creates a virtual interface
    expect(fail('range vlan99', CTX_VIRTUAL).error.message).toBe(MSG_INTERFACE_NOT_CREATED);
    expect(ok('range vlan1', CTX_VIRTUAL).args['r']).toBe('Vlan1');
  });

  it('is resolved the same way outside the parser', () => {
    const r = resolveInterfaceRange('fa0/1 - 2, gi0/1', CTX);
    expect(r).toEqual({ ok: true, ports: ['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1'] });
    expect(validateArg(arg('if-range'), 'fa0/1 - 2', CTX)).toEqual({ ok: true, value: 'FastEthernet0/1,FastEthernet0/2' });
    expect(resolveInterfaceRange('fa0/1 - 2, nothing', CTX)).toEqual({ ok: false, message: MSG_UNKNOWN_INTERFACE });
  });

  it('offers interface names and takes the rest of the line', () => {
    const names = complete(SPECS, { ...CTX, listInterfaces: () => PORTS }, 'range ').items.map((i) => i.token);
    expect(names).toContain('FastEthernet0/1');
    expect(names).toContain('GigabitEthernet0/1');
    expect(complete(SPECS, { ...CTX, listInterfaces: () => PORTS }, 'range Fast').items.map((i) => i.token)).toContain('FastEthernet0/10');
    expect(help(SPECS, CTX, 'range ').items.map((i) => i.token)).toEqual(['INTERFACE-RANGE']);
    expect(placeholderFor(arg('if-range'))).toBe('INTERFACE-RANGE');
    // the whole tail belongs to the range: no "unrecognized input" for its spaces and commas
    expect(ok('range fa0/1 - 2 , gi0/1').args['r']).toBe('FastEthernet0/1,FastEthernet0/2,GigabitEthernet0/1');
  });
});
