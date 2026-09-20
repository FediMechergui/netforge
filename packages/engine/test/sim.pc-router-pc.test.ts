/**
 * P0 acceptance: PC → router → PC. TTL decrements once with the matched route as the cause.
 */
import { describe, expect, it } from 'vitest';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { booted, console, createdId, ofKind, ping } from './sim.harness.js';

describe('sim/PC, router, PC', () => {
  it('forwards a ping 5/5 through the router with a single TTL decrement', () => {
    const sim = booted(pcRouterPc(), 3);
    const { text, evs, result } = ping(sim, 'pc1', '10.0.1.1');
    expect(result.busy).toBe(true);
    expect(text).toContain('!!!!!');
    expect(text).toContain('Sent 5, received 5, lost 0');

    const echoId = createdId(evs, 'pc1', 'ping#1');
    const echo = sim.pdu(echoId)!;
    const ttl = echo.provenance.filter((m) => m.reason === 'TtlDecrement');
    expect(ttl).toHaveLength(1);
    expect(ttl[0]!.device).toBe('r1');
    expect(ttl[0]!.field).toBe('ipv4.ttl');
    expect(ttl[0]!.before).toBe(128);
    expect(ttl[0]!.after).toBe(127);
    expect(ttl[0]!.cause).toContain('connected via GigabitEthernet0/1');
    expect(echo.get('ipv4.ttl')).toBe(127);

    const rewrites = echo.provenance.filter((m) => m.reason === 'MacRewrite');
    expect(rewrites.length).toBeGreaterThanOrEqual(2);
    expect(rewrites.every((m) => m.device === 'r1')).toBe(true);
    expect(rewrites.map((m) => m.field).sort()).toEqual(['ethernet.dst', 'ethernet.src']);
    const r1 = sim.device('r1')!;
    expect(echo.get('ethernet.src')).toBe(r1.port('GigabitEthernet0/1')!.mac);
    expect(echo.get('ethernet.dst')).toBe(sim.device('pc2')!.port('GigabitEthernet0')!.mac);

    // the TTL mutation is mirrored in the trace
    expect(ofKind(evs, 'mutation').some((e) => e.pdu === echoId && e.mutation.reason === 'TtlDecrement')).toBe(true);

    // router CLI
    const { results } = console(sim, 'r1', ['show ip route', 'show ip interface brief']);
    const routes = results[0]!.output.split('\n');
    expect(routes.filter((l) => /^C\s+\d/.test(l))).toHaveLength(2);
    expect(routes.filter((l) => /^L\s+\d/.test(l))).toHaveLength(2);
    const brief = results[1]!.output;
    expect(brief).toMatch(/GigabitEthernet0\/0\s+10\.0\.0\.254\s+up\s+up/);
    expect(brief).toMatch(/GigabitEthernet0\/1\s+10\.0\.1\.254\s+up\s+up/);

    // ARP tables
    expect(sim.device('pc1')!.tables.arp.rows().map((r) => r.ip)).toEqual(['10.0.0.254']);
    expect(r1.tables.arp.rows().map((r) => r.ip).sort()).toEqual(['10.0.0.1', '10.0.1.1']);
  });
});
