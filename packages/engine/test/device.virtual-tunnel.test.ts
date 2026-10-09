/**
 * device.virtual-tunnel — [S18] the tunnel port on the runtime side (ARCHITECTURE-P3 D17, §2.1, §2.4, §2.7, §3.10;
 * §7 W1 device): `interface Tunnel0` on a routing model of stage P3 creates a `tunnel` port (encapsulation `tunnel`,
 * administratively up, down until its row says up); the `virtualChanged` action recomputes virtual oper state and the
 * tunnel rule reads the tunnel owner's `tunnels` row (up, or down with the row's reason); a send on the tunnel port
 * goes to the owner's `onEgress` and counts out on the tunnel; `pduSummary` tags a framed GRE leg `tunnel: 'gre'`.
 * Built on `test/staged.world.ts`'s stage-P3 catalog with a stub `gre` (the real one is W2 wan's).
 */
import { describe, expect, it } from 'vitest';
import { ICMP_ECHO_REQUEST, IPPROTO_ICMP, type Pdu } from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import type { TunnelRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { TUNNEL_FAMILY } from '../src/device/catalog/define.js';
import { TUNNEL_NO_ROW_REASON, evaluateVirtualOper, virtualPortSpec } from '../src/device/ports.js';
import { pduSummary } from '../src/device/process-ctx.js';
import { bootP3, p3Harness, stubDaemon, type P3Harness, type StubDaemon } from './device.p3.harness.js';
import { createStagedCatalog } from './staged.world.js';

const TUNNEL = 'Tunnel0';
type PortStateEvent = Extract<TraceEvent, { kind: 'portState' }>;

function world(): { h: P3Harness; gre: StubDaemon } {
  const gre = stubDaemon('gre');
  const h = p3Harness({ catalog: createStagedCatalog({ stage: 'P3', factories: { gre: gre.factory } }), type: 'router.nf2911', profile: 'P3' });
  bootP3(h);
  return { h, gre };
}

function writeRow(h: P3Harness, state: 'up' | 'down', reason?: TunnelRow['reason']): void {
  const now = h.scheduler.now;
  const row: TunnelRow = { key: TUNNEL, port: TUNNEL, mode: 'gre', state, transportMtu: 1500, ipMtu: 1476, since: now, updatedAt: now };
  if (reason !== undefined) row.reason = reason;
  h.device.tables.get<TunnelRow>('tunnels')!.set(row);
}

function portStates(h: P3Harness, from: number): PortStateEvent[] {
  return h.events.slice(from).filter((e): e is PortStateEvent => e.kind === 'portState' && e.port === TUNNEL);
}

function echo(h: P3Harness): Pdu {
  return h.pdus.build(
    [
      { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', protocol: IPPROTO_ICMP, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    ],
    { born: 0, origin: 'd_pc' },
  );
}

describe('the tunnel port and virtualChanged ([S18], D17)', () => {
  it('interface Tunnel0 creates a tunnel port: role tunnel, encapsulation tunnel, admin up, line protocol down', () => {
    const { h } = world();
    expect(h.device.model.portOwners.tunnel).toBe('gre');
    expect(h.device.model.tables).toContain('tunnels');
    const from = h.events.length;
    expect(h.device.applyConfigLine([], ['interface', TUNNEL], false)).toEqual({ ok: true });
    const port = h.device.port(TUNNEL) as PortState;
    expect(port.spec).toEqual(virtualPortSpec(TUNNEL_FAMILY, 0));
    expect([port.role, port.encap, port.spec.kind, port.adminUp, port.operUp]).toEqual(['tunnel', 'tunnel', 'virtual', true, false]);
    expect(portStates(h, from).map((e) => [e.operUp, e.reason])).toEqual([[false, 'virtual-created']]);
    // the running configuration has the section, without a shutdown line (created up)
    expect(h.device.running.render()).toContain('interface Tunnel0');
    expect(h.device.running.render()).not.toMatch(/interface Tunnel0\n shutdown/);
  });

  it('virtualChanged brings the tunnel up from its row, and down with the row reason; the row alone changes nothing', () => {
    const { h, gre } = world();
    h.device.applyConfigLine([], ['interface', TUNNEL], false);
    const t = h.scheduler.now;
    writeRow(h, 'up');
    expect(h.device.port(TUNNEL)!.operUp).toBe(false); // nothing recomputes until the owner says so
    let from = h.events.length;
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    expect(h.device.port(TUNNEL)!.operUp).toBe(true);
    const up = portStates(h, from);
    expect(up).toHaveLength(1);
    expect(up[0]).toEqual({ t, kind: 'portState', device: 'd_1', port: TUNNEL, adminUp: true, operUp: true });
    expect(gre.links.at(-1)).toEqual({ port: TUNNEL, up: true, at: t });
    // the same row again: no change, no event
    from = h.events.length;
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    expect(portStates(h, from)).toEqual([]);
    // down with the row's reason
    writeRow(h, 'down', 'no-route');
    from = h.events.length;
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    expect(portStates(h, from).map((e) => [e.operUp, e.reason])).toEqual([[false, 'no-route']]);
    expect(gre.links.at(-1)).toEqual({ port: TUNNEL, up: false, at: t });
    // up again, then the row removed: down with the no-row reason
    writeRow(h, 'up');
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    h.device.tables.get<TunnelRow>('tunnels')!.delete(TUNNEL);
    from = h.events.length;
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    expect(portStates(h, from).map((e) => [e.operUp, e.reason])).toEqual([[false, TUNNEL_NO_ROW_REASON]]);
  });

  it('shutdown takes precedence over an up row; no shutdown with the row up brings it back', () => {
    const { h } = world();
    h.device.applyConfigLine([], ['interface', TUNNEL], false);
    writeRow(h, 'up');
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], h.scheduler.now);
    const from = h.events.length;
    expect(h.device.applyConfigLine([['interface', TUNNEL]], ['shutdown'], false).ok).toBe(true);
    expect(h.device.port(TUNNEL)!.operUp).toBe(false);
    expect(h.device.applyConfigLine([['interface', TUNNEL]], ['shutdown'], true).ok).toBe(true);
    expect(h.device.port(TUNNEL)!.operUp).toBe(true);
    expect(portStates(h, from).map((e) => [e.adminUp, e.operUp, e.reason])).toEqual([
      [false, true, 'admin-down'],
      [false, false, 'admin-down'],
      [true, false, 'admin-up'],
      [true, true, undefined],
    ]);
  });

  it("a send on the tunnel port goes to the owner's onEgress and counts out on the tunnel; the owner's own send is dropped", () => {
    const { h, gre } = world();
    h.device.applyConfigLine([], ['interface', TUNNEL], false);
    writeRow(h, 'up');
    const t = h.scheduler.now;
    h.device.applyActions('gre', [{ type: 'virtualChanged' }], t);
    const pdu = echo(h);
    h.device.applyActions('ipv4', [{ type: 'send', port: TUNNEL, pdu }], t);
    expect(gre.egress).toEqual([{ pdu, port: TUNNEL }]);
    expect(h.device.port(TUNNEL)!.counters.outPackets).toBe(1);
    expect(h.transmits).toEqual([]);
    const from = h.events.length;
    h.device.applyActions('gre', [{ type: 'send', port: TUNNEL, pdu: echo(h) }], t);
    const drops = h.events.slice(from).filter((e) => e.kind === 'drop');
    expect(drops).toMatchObject([{ reason: 'other', detail: 'virtual-transmit', port: TUNNEL }]);
    expect(gre.egress).toHaveLength(1);
  });

  it('a stage-P2 router has no tunnel family: interface Tunnel0 is refused as before', () => {
    // ARCHITECTURE-P3 §9.2 W4: the real catalog was at stage P2 until the P3 catalog flip; since the flip the stage-P2
    // router is `staged.world`'s (the real input defined at stage P2)
    const h = p3Harness({ catalog: createStagedCatalog({ stage: 'P2' }), type: 'router.nf2911', name: 'R1' });
    bootP3(h);
    expect(h.device.model.virtualFamilies.map((f) => f.family)).not.toContain('Tunnel');
    expect(h.device.applyConfigLine([], ['interface', TUNNEL], false)).toEqual({ ok: false, error: 'Unknown interface Tunnel0' });
    expect(h.device.port(TUNNEL)).toBeUndefined();
  });
});

describe('the tunnel rule of evaluateVirtualOper (pure)', () => {
  const port = (over: Partial<PortState> = {}): Pick<PortState, 'id' | 'adminUp' | 'operUp' | 'role' | 'spec' | 'errDisabled' | 'dot1q'> => ({
    id: TUNNEL,
    adminUp: true,
    operUp: false,
    role: 'tunnel',
    spec: virtualPortSpec(TUNNEL_FAMILY, 0),
    ...over,
  });
  const dev = { power: true, booted: true };

  it('up only while the row says up; the row reason otherwise; no lookup or no row = no-source', () => {
    expect(evaluateVirtualOper(port(), [], dev, ['routing'])).toEqual({ up: false, reason: 'no-source' });
    expect(evaluateVirtualOper(port(), [], dev, ['routing'], { tunnelState: () => undefined })).toEqual({ up: false, reason: 'no-source' });
    expect(evaluateVirtualOper(port(), [], dev, ['routing'], { tunnelState: () => ({ state: 'up' }) })).toEqual({ up: true });
    expect(evaluateVirtualOper(port(), [], dev, ['routing'], { tunnelState: () => ({ state: 'down', reason: 'no-destination' }) })).toEqual({ up: false, reason: 'no-destination' });
    expect(evaluateVirtualOper(port(), [], dev, ['routing'], { tunnelState: () => ({ state: 'down' }) })).toEqual({ up: false, reason: 'no-source' });
    expect(evaluateVirtualOper(port(), [], dev, ['routing'], { tunnelState: (p) => (p === TUNNEL ? { state: 'down', reason: 'ike-negotiating' } : undefined) })).toEqual({ up: false, reason: 'ike-negotiating' });
    // the generic gates come first
    const upRow = { tunnelState: () => ({ state: 'up' as const }) };
    expect(evaluateVirtualOper(port({ adminUp: false }), [], dev, ['routing'], upRow)).toEqual({ up: false, reason: 'admin-down' });
    expect(evaluateVirtualOper(port(), [], { power: true, booted: false }, ['routing'], upRow)).toEqual({ up: false, reason: 'booting' });
    expect(evaluateVirtualOper(port({ errDisabled: 'fault' }), [], dev, ['routing'], upRow)).toEqual({ up: false, reason: 'err-disabled' });
  });

  it('the tunnel spec takes the family encapsulation; every family without one keeps its P2 encapsulation', () => {
    expect(virtualPortSpec(TUNNEL_FAMILY, 7)).toMatchObject({ name: 'Tunnel7', short: 'Tu7', kind: 'virtual', role: 'tunnel', allowedRoles: ['tunnel'], encap: 'tunnel', defaultAdminUp: true });
    expect(virtualPortSpec({ family: 'Loopback', short: 'Lo', role: 'virtual', min: 0, max: 9, defaultAdminUp: true }, 1).encap).toBe('none');
    expect(virtualPortSpec({ family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 9, defaultAdminUp: false }, 1).encap).toBe('ethernet');
    expect(virtualPortSpec({ family: 'Port-channel', short: 'Po', role: 'channel', min: 1, max: 9, defaultAdminUp: true }, 1).encap).toBe('ethernet');
  });
});

describe('pduSummary tags a framed GRE leg (§2.7)', () => {
  const fake = (protos: readonly string[]): Pdu => ({
    id: 'p_1',
    size: 100,
    meta: { born: 0, origin: 'd_1' },
    layers: protos.map((proto) => ({ proto, fields: {} })),
    topProto: () => protos[protos.length - 1],
    summary: () => 'x',
  }) as unknown as Pdu;

  it("gre after the frame and the outer ipv4 is 'gre'; short, unframed or other PDUs are untouched", () => {
    expect(pduSummary(fake(['hdlc', 'ipv4', 'gre', 'ipv4', 'icmpv4'])).tunnel).toBe('gre');
    expect(pduSummary(fake(['ethernet', 'ipv4', 'gre', 'ipv4', 'ospf'])).tunnel).toBe('gre');
    expect(pduSummary(fake(['ethernet', 'ipv4', 'gre', 'ipv4', 'udp', 'payload'])).tunnel).toBe('gre');
    expect(pduSummary(fake(['ipv4', 'gre', 'ipv4', 'icmpv4']))).not.toHaveProperty('tunnel');
    expect(pduSummary(fake(['ethernet', 'ipv4', 'udp', 'dns', 'payload']))).not.toHaveProperty('tunnel');
    // CAPWAP keeps its P2 rule (a station frame inside the capwap layer)
    expect(pduSummary(fake(['ethernet', 'ipv4', 'udp', 'capwap', 'dot11'])).tunnel).toBe('capwap');
    expect(pduSummary(fake(['ethernet', 'ipv4', 'udp', 'capwap', 'payload']))).not.toHaveProperty('tunnel');
    expect(Object.keys(pduSummary(fake(['ethernet', 'ipv4', 'udp', 'dns', 'payload'])))).toEqual(['id', 'proto', 'size', 'summary']);
  });
});
