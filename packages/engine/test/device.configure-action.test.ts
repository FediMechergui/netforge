/**
 * device.configure-action — the configure seam on the runtime side (ARCHITECTURE-P3 D21, §2.4, §2.7, §2.9; §7 W1
 * device): the `configure` action only schedules SimEvent `deviceConfigure` at now through `deps.scheduler` (zero
 * delay, non-periodic, a copy of the lines and options), never applies anything inline; `applyConfigLine(…, origin)`
 * stamps the origin on the line's `configChange` events (every event of a `no interface` removal included), and a
 * line without an origin keeps the P2 event bytes.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/contracts/events.js';
import type { Action, ConfigOrigin } from '../src/contracts/process.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { SEC } from '../src/contracts/time.js';
import { boot, harness } from './device.harness.js';

const ORIGIN: ConfigOrigin = { via: 'restconf', user: 'admin', address: '10.0.99.10' };

type ConfigChange = Extract<TraceEvent, { kind: 'configChange' }>;

describe('the configure action (D21)', () => {
  it('schedules deviceConfigure at now, non-periodic, with copies; nothing is applied inline', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const now = 70 * SEC;
    const lines = ['hostname R9', 'interface Loopback0', ' ip address 1.1.1.1 255.255.255.255'];
    const origin = { via: 'restconf' as const, user: 'admin', address: '10.0.99.10' };
    const traced = h.events.length;
    const pending = h.scheduler.size;
    const action: Action = { type: 'configure', token: 'rc-1', lines, atomic: true, indentation: true, origin };
    h.device.applyActions('restconf', [action], now);
    // nothing inline: no trace event, the running configuration and the hostname unchanged
    expect(h.events.length).toBe(traced);
    expect(h.device.hostname).toBe('R1');
    expect(h.device.running.render()).not.toContain('R9');
    expect(h.scheduler.size).toBe(pending + 1);
    // the caller's objects may change afterwards: the event holds copies
    lines.push('hostname EVIL');
    origin.user = 'mallory';
    expect(h.scheduler.peekTime()).toBe(now);
    const ev = h.scheduler.next() as SimEvent;
    expect(ev).toEqual({
      at: now,
      seq: ev.seq,
      kind: 'deviceConfigure',
      device: 'd_1',
      from: 'restconf',
      token: 'rc-1',
      lines: ['hostname R9', 'interface Loopback0', ' ip address 1.1.1.1 255.255.255.255'],
      opts: { atomic: true, indentation: true, origin: ORIGIN },
    });
    expect(ev).not.toHaveProperty('periodic');
  });

  it('options that are not given are left out; two actions keep their order', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const now = 80 * SEC;
    h.device.applyActions('restconf', [
      { type: 'configure', token: 'a', lines: ['hostname A'], origin: { via: 'restconf' } },
      { type: 'configure', token: 'b', lines: [], origin: { via: 'restconf', user: 'u' } },
    ], now);
    const a = h.scheduler.next() as Extract<SimEvent, { kind: 'deviceConfigure' }>;
    const b = h.scheduler.next() as Extract<SimEvent, { kind: 'deviceConfigure' }>;
    expect([a.token, b.token]).toEqual(['a', 'b']);
    expect(a.at).toBe(now);
    expect(b.at).toBe(now);
    expect(a.opts).toEqual({ origin: { via: 'restconf' } });
    expect(Object.keys(a.opts)).toEqual(['origin']);
    expect(b.opts).toEqual({ origin: { via: 'restconf', user: 'u' } });
    expect(h.device.hostname).toBe('R1');
  });
});

describe('applyConfigLine with an origin (D21)', () => {
  it('stamps the origin on the configChange of the line; without one the P2 key set is unchanged', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const from = h.events.length;
    expect(h.device.applyConfigLine([], ['hostname', 'Edge'], false, ORIGIN)).toEqual({ ok: true });
    expect(h.device.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['description', 'uplink'], false)).toEqual({ ok: true });
    const changes = h.events.slice(from).filter((e): e is ConfigChange => e.kind === 'configChange');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({ t: changes[0]!.t, kind: 'configChange', device: 'd_1', line: 'hostname Edge', negate: false, context: [], origin: ORIGIN });
    expect(Object.keys(changes[0]!)).toEqual(['t', 'kind', 'device', 'line', 'negate', 'context', 'origin']);
    expect(Object.keys(changes[1]!)).toEqual(['t', 'kind', 'device', 'line', 'negate', 'context']);
    expect(h.device.hostname).toBe('Edge');
  });

  it('every configChange of a `no interface` removal carries the origin', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    expect(h.device.applyConfigLine([], ['interface', 'Loopback0'], false).ok).toBe(true);
    expect(h.device.applyConfigLine([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255'], false).ok).toBe(true);
    expect(h.device.applyConfigLine([['interface', 'Loopback0']], ['description', 'loop'], false).ok).toBe(true);
    const from = h.events.length;
    expect(h.device.applyConfigLine([], ['interface', 'Loopback0'], true, ORIGIN)).toEqual({ ok: true });
    const changes = h.events.slice(from).filter((e): e is ConfigChange => e.kind === 'configChange');
    expect(changes.map((c) => [c.line, c.negate])).toEqual([
      ['ip address 1.1.1.1 255.255.255.255', true],
      ['description loop', true],
      ['interface Loopback0', true],
    ]);
    for (const c of changes) expect(c.origin, c.line).toEqual(ORIGIN);
    expect(h.device.port('Loopback0')).toBeUndefined();
  });

  it('the origin is a copy, and a typed-style removal without origin carries none', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const origin = { via: 'restconf' as const, user: 'admin' };
    h.device.applyConfigLine([], ['hostname', 'X1'], false, origin);
    origin.user = 'changed';
    const [c] = h.kinds('configChange') as ConfigChange[];
    expect(c!.origin).toEqual({ via: 'restconf', user: 'admin' });
    h.device.applyConfigLine([], ['interface', 'Loopback3'], false);
    const from = h.events.length;
    h.device.applyConfigLine([], ['interface', 'Loopback3'], true);
    for (const e of h.events.slice(from)) if (e.kind === 'configChange') expect(e).not.toHaveProperty('origin');
  });
});
