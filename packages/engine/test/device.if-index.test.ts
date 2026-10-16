/**
 * device.if-index — the shared interface index (ARCHITECTURE-P3C §3.5; §7 W1a device; used by [S6] and [S33]):
 * physical ports 1…n in the model's port order, virtual interfaces from n + 1 in the order of their first creation since
 * boot. The pure helper (`ifIndexOf`, `ifIndexTable`, `portOfIfIndex`) and the runtime's two lists (`ifIndexSource`).
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { ifIndexOf, ifIndexTable, portOfIfIndex, type IfIndexSource } from '../src/device/if-index.js';
import { boot, harness, type Harness } from './device.harness.js';

const source = (h: Harness): IfIndexSource => (h.device as unknown as { ifIndexSource(): IfIndexSource }).ifIndexSource();

describe('the pure rule', () => {
  const src: IfIndexSource = { physical: ['Gi0/0', 'Gi0/1', 'Se0/0/0'], virtual: ['Loopback1', 'Vlan10', 'Gi0/0.10'] };

  it('numbers the physical ports 1…n, then the virtual interfaces in creation order', () => {
    expect([...ifIndexTable(src)]).toEqual([
      ['Gi0/0', 1],
      ['Gi0/1', 2],
      ['Se0/0/0', 3],
      ['Loopback1', 4],
      ['Vlan10', 5],
      ['Gi0/0.10', 6],
    ]);
    for (const [name, i] of ifIndexTable(src)) {
      expect(ifIndexOf(src, name)).toBe(i);
      expect(portOfIfIndex(src, i)).toBe(name);
    }
  });

  it('unknown names and indexes are undefined; a duplicate counts at its first place', () => {
    expect(ifIndexOf(src, 'Loopback9')).toBeUndefined();
    for (const bad of [0, -1, 7, 1.5]) expect(portOfIfIndex(src, bad), String(bad)).toBeUndefined();
    const dup: IfIndexSource = { physical: ['a', 'b', 'a'], virtual: ['b', 'v', 'v'] };
    expect([...ifIndexTable(dup)]).toEqual([['a', 1], ['b', 2], ['v', 3]]);
    expect(ifIndexOf(dup, 'v')).toBe(3);
    expect(ifIndexOf({ physical: [], virtual: [] }, 'a')).toBeUndefined();
  });

  it('is pure: the same input gives the same table and the input is not changed', () => {
    const before = JSON.stringify(src);
    expect([...ifIndexTable(src)]).toEqual([...ifIndexTable(src)]);
    expect(JSON.stringify(src)).toBe(before);
  });
});

describe('the runtime lists (device/device.ts ifIndexSource)', () => {
  it('a router: its physical ports in port order (no console or aux line); virtual ones in first-creation order', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: {} });
    boot(h);
    const first = source(h);
    expect(first.physical.slice(0, 4)).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1']);
    expect(first.physical).not.toContain('Console');
    expect(first.physical).toEqual([...h.device.ports.values()].filter((p) => !['virtual', 'console', 'usb'].includes(p.spec.kind)).map((p) => p.id));
    expect(first.virtual).toEqual([]);
    const n = first.physical.length;
    const t = 5 * SEC;
    expect(h.device.ensureVirtualPort('Loopback1', t).ok).toBe(true);
    expect(h.device.ensureVirtualPort('Loopback0', t).ok).toBe(true);
    expect(h.device.ensureVirtualPort('GigabitEthernet0/0.10', t).ok).toBe(true);
    expect(source(h).virtual).toEqual(['Loopback1', 'Loopback0', 'GigabitEthernet0/0.10']);
    expect(ifIndexOf(source(h), 'Loopback1')).toBe(n + 1);
    expect(ifIndexOf(source(h), 'GigabitEthernet0/0.10')).toBe(n + 3);
    // removed and re-created: the old place, and no other index moves
    expect(h.device.removeVirtualPort('Loopback1', t + 1).ok).toBe(true);
    expect(source(h).virtual).toEqual(['Loopback1', 'Loopback0', 'GigabitEthernet0/0.10']);
    expect(h.device.ensureVirtualPort('Loopback1', t + 2).ok).toBe(true);
    expect(ifIndexOf(source(h), 'Loopback1')).toBe(n + 1);
    expect(ifIndexOf(source(h), 'Loopback0')).toBe(n + 2);
    // the order is RAM: power-off forgets it (the created interfaces are lost with the running configuration)
    h.device.setPower(false, t + 3);
    expect(source(h).virtual).toEqual([]);
    expect(source(h).physical).toEqual(first.physical);
  });

  it('a switch: the auto interface (Vlan1) is first and keeps its place across power-off', () => {
    const h = harness({ type: 'switch.nfc2960', name: 'SW1', processes: {} });
    boot(h);
    expect(source(h).virtual).toEqual(['Vlan1']);
    expect(h.device.ensureVirtualPort('Vlan10', 5 * SEC).ok).toBe(true);
    expect(source(h).virtual).toEqual(['Vlan1', 'Vlan10']);
    const n = source(h).physical.length;
    expect(ifIndexOf(source(h), 'Vlan1')).toBe(n + 1);
    h.device.setPower(false, 6 * SEC);
    expect(source(h).virtual).toEqual(['Vlan1']);
  });
});
