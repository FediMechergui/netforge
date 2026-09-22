/**
 * W2 device (ARCHITECTURE-P2 D2 "Completeness rule", §5, §2.9): the runtime computes the device's default slots from
 * its default lines D (`defaultConfig` + the profile lines) and passes them to EVERY config apply — the boot replay of
 * D itself, the saved lines, typed lines, `setPortAdmin` — and to the parse of a saved configuration text. Reversing
 * each default line therefore leaves an explicit line in the running configuration (`ip routing`, `no capwap enable`,
 * `no ip address`, `shutdown`; `no spanning-tree mode` restores the model default), and a reload, a device booted from
 * that text as its startup configuration and one restored with it as its running configuration all replay to the same
 * running configuration and port state. A P1 world has no default slots, so every apply there is exactly today's.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { DebugEvent, Process, StateView } from '../src/contracts/process.js';
import { slotKeyOf } from '../src/cli/config-ast.js';
import { NF_C2960 } from '../src/device/catalog.js';
import { deviceDefaultLines, deviceDefaultSlots } from '../src/device/device.js';
import { p2Harness, type P2Harness } from './device.p2.harness.js';

const P2_LINES = [
  'spanning-tree mode pvst',
  'spanning-tree extend system-id',
  'no ip routing',
  'capwap enable',
  'interface Vlan1',
  ' ip address dhcp',
  ' no shutdown',
];

/** A switch whose P2 profile carries every kind of default line the catalog uses (managed switch, MLS and AP lines). */
const MODEL: DeviceModel = { ...NF_C2960, processes: ['eth-switch'], profileConfig: { P2: P2_LINES } };

function ethSwitch(): Process {
  return {
    name: 'eth-switch',
    init: () => [],
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: (): StateView => ({ process: 'eth-switch', state: {} }),
    debugEvents: (): readonly DebugEvent[] => [],
  };
}

function boot(profile: DefaultsProfile, opts: { startupConfig?: string; runningConfig?: string } = {}): P2Harness {
  const h = p2Harness({ model: MODEL, processes: { 'eth-switch': ethSwitch }, profile, ...opts });
  h.run();
  return h;
}

const cfg = (h: P2Harness, context: string[][], line: string, negate = false) => h.device.applyConfigLine(context, line.split(' '), negate);
const VLAN1 = [['interface', 'Vlan1']];
const render = (h: P2Harness) => h.device.running.render();
const replayed = (h: P2Harness) => h.kinds('configChange').map((e) => `${e.negate ? 'no ' : ''}${e.line}@${e.context.map((c) => c.join(' ')).join('/')}`);

describe('deviceDefaultSlots', () => {
  it('records one slot per default line (sections excluded), keyed like the AST keys them', () => {
    const slots = deviceDefaultSlots(MODEL, 'P2');
    expect(deviceDefaultLines(MODEL, 'P2')).toEqual([...(NF_C2960.defaultConfig ?? []), ...P2_LINES]);
    expect(slots.get(slotKeyOf([], ['spanning-tree', 'mode', 'pvst']))).toEqual(['spanning-tree', 'mode', 'pvst']);
    expect(slots.get(slotKeyOf([], ['spanning-tree', 'mode', 'rapid-pvst']))).toEqual(['spanning-tree', 'mode', 'pvst']);
    expect(slots.get(slotKeyOf([], ['spanning-tree', 'extend', 'system-id']))).toEqual(['spanning-tree', 'extend', 'system-id']);
    expect(slots.get(slotKeyOf([], ['ip', 'routing']))).toEqual(['no', 'ip', 'routing']);
    expect(slots.get(slotKeyOf([], ['capwap', 'enable']))).toEqual(['capwap', 'enable']);
    expect(slots.get(slotKeyOf(VLAN1, ['ip', 'address', '10.0.0.1', '255.255.255.0']))).toEqual(['ip', 'address', 'dhcp']);
    expect(slots.has(slotKeyOf([], ['interface', 'Vlan1']))).toBe(false);
    // `no shutdown` is the default state of the slot, not a line of D
    expect(slots.has(slotKeyOf(VLAN1, ['shutdown']))).toBe(false);
    // a P1 world replays none of these lines
    const p1 = deviceDefaultSlots(MODEL, 'P1');
    expect([...p1.keys()].some((k) => k.includes('spanning-tree') || k.includes('capwap') || k.includes('routing'))).toBe(false);
    expect(deviceDefaultSlots({}, 'P2').size).toBe(0);
  });
});

describe('reversing every default line in a P2 world (D2)', () => {
  it('stores each reversal explicitly and restores the model default for no spanning-tree mode', () => {
    const h = boot('P2');
    const before = render(h);
    expect(before).toContain('spanning-tree mode pvst');
    expect(before).toContain('no ip routing');
    expect(before).toContain('capwap enable');
    expect(before).toContain('interface Vlan1\n ip address dhcp');
    expect(before).not.toContain('interface Vlan1\n ip address dhcp\n shutdown');
    expect(h.device.port('Vlan1')?.adminUp).toBe(true);

    expect(cfg(h, [], 'ip routing')).toEqual({ ok: true });
    expect(cfg(h, [], 'spanning-tree mode rapid-pvst')).toEqual({ ok: true });
    expect(render(h)).toContain('spanning-tree mode rapid-pvst');
    expect(cfg(h, [], 'spanning-tree mode', true)).toEqual({ ok: true });
    expect(cfg(h, [], 'capwap enable', true)).toEqual({ ok: true });
    expect(cfg(h, VLAN1, 'ip address', true)).toEqual({ ok: true });
    expect(cfg(h, VLAN1, 'shutdown')).toEqual({ ok: true });

    const text = render(h);
    expect(text).toContain('ip routing');
    expect(text).not.toContain('no ip routing');
    expect(text).toContain('spanning-tree mode pvst');
    expect(text).not.toContain('rapid-pvst');
    expect(text).toContain('no capwap enable');
    expect(text).not.toContain('\ncapwap enable');
    expect(text).toContain('interface Vlan1\n no ip address\n shutdown');
    expect(text).not.toContain('ip address dhcp');
    expect(h.device.port('Vlan1')?.adminUp).toBe(false);
    // a slot with no default keeps today's storage: the negation of an ordinary line stores nothing
    cfg(h, [['interface', 'FastEthernet0/1']], 'description uplink');
    cfg(h, [['interface', 'FastEthernet0/1']], 'description', true);
    expect(render(h)).not.toContain('no description');
  });

  it('a reload replays D and then the saved reversals to the same configuration and state', () => {
    const h = boot('P2');
    cfg(h, [], 'ip routing');
    cfg(h, [], 'spanning-tree mode', true);
    cfg(h, [], 'capwap enable', true);
    cfg(h, VLAN1, 'ip address', true);
    cfg(h, VLAN1, 'shutdown');
    const text = render(h);
    h.device.saveConfig();
    h.events.length = 0;
    h.device.reload(5_000_000);
    h.run();
    expect(render(h)).toBe(text);
    expect(h.device.port('Vlan1')?.adminUp).toBe(false);
    expect(h.device.port('Vlan1')?.l3).toEqual({});
    // D first (every profile line, in order), then the saved lines (stored order); the explicit negations replay as
    // `no` lines and `no spanning-tree mode` stored nothing (the slot already holds the default)
    const lines = replayed(h);
    // (the `interface Vlan1` section line itself changes nothing: the auto SVI's section already exists)
    const d = P2_LINES.filter((l) => l !== 'interface Vlan1').map((l) => (l.startsWith(' ') ? `${l.trim()}@interface Vlan1` : `${l}@`));
    expect(lines.slice(0, d.length)).toEqual(d);
    expect(lines.slice(d.length).sort()).toEqual(['ip routing@', 'no capwap enable@', 'no ip address@interface Vlan1', 'shutdown@interface Vlan1']);
  });

  it('a device booted from that text as startup or as a restored running configuration replays to the same state', () => {
    const h = boot('P2');
    cfg(h, [], 'ip routing');
    cfg(h, [], 'spanning-tree mode', true);
    cfg(h, [], 'capwap enable', true);
    cfg(h, VLAN1, 'ip address', true);
    cfg(h, VLAN1, 'shutdown');
    const text = render(h);

    const fromStartup = boot('P2', { startupConfig: text });
    expect(render(fromStartup)).toBe(text);
    expect(fromStartup.device.port('Vlan1')?.adminUp).toBe(false);
    expect(fromStartup.device.startup?.render()).toBe(text); // the parse kept the explicit negations

    const fromRunning = boot('P2', { runningConfig: text });
    expect(render(fromRunning)).toBe(text);
    expect(fromRunning.device.port('Vlan1')?.adminUp).toBe(false);

    // the plain P2 device differs from all three only by the reversals
    const plain = boot('P2');
    expect(render(plain)).not.toBe(text);
    expect(plain.device.port('Vlan1')?.adminUp).toBe(true);
  });

  it('typing a default line again cancels its explicit reversal', () => {
    const h = boot('P2');
    cfg(h, [], 'capwap enable', true);
    cfg(h, VLAN1, 'ip address', true);
    expect(render(h)).toContain('no capwap enable');
    cfg(h, [], 'capwap enable');
    cfg(h, VLAN1, 'ip address dhcp');
    const text = render(h);
    expect(text).not.toContain('no capwap enable');
    expect(text).toContain('\ncapwap enable');
    expect(text).toContain('interface Vlan1\n ip address dhcp');
    expect(text).not.toContain('no ip address');
  });
});

describe('a P1 world has no default slots (D2)', () => {
  it('replays nothing new, and no spanning-tree mode simply clears the line', () => {
    const h = boot('P1');
    const text = render(h);
    expect(text).not.toContain('spanning-tree');
    expect(text).not.toContain('ip routing');
    expect(text).not.toContain('capwap');
    cfg(h, [], 'spanning-tree mode pvst');
    expect(render(h)).toContain('spanning-tree mode pvst');
    cfg(h, [], 'spanning-tree mode', true);
    expect(render(h)).not.toContain('spanning-tree');
    // `ip routing` and `no ip routing` are stored as typed in every world (bothForms)
    cfg(h, [], 'no ip routing'.slice(3), true);
    expect(render(h)).toContain('no ip routing');
    cfg(h, [], 'ip routing');
    expect(render(h)).toContain('\nip routing');
    expect(render(h)).not.toContain('no ip routing');
    // an ordinary negation stores nothing, exactly as today
    cfg(h, VLAN1, 'ip address 10.0.0.1 255.255.255.0');
    cfg(h, VLAN1, 'ip address', true);
    expect(render(h)).not.toContain('no ip address');
    h.device.saveConfig();
    const saved = render(h);
    h.device.reload(5_000_000);
    h.run();
    expect(render(h)).toBe(saved);
  });
});
