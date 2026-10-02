/**
 * W2 l2 (ARCHITECTURE-P3 D13, §3.0 (b), §3.4 steps 1–5, §4.2, §4.3, §5.3; §7 W2 l2): eth-switch step 7b, DHCP snooping,
 * on real worlds (`staged.world` at stage P3, every P3 daemon removed, the W1 injector for the rogue server and the
 * bursts). The switch is configured through `startupConfig` and `applyConfigLine` (rule 13), the router and the PC
 * through their P1 grammar.
 *  - §3.4 steps 1–3: the client's DISCOVER on an untrusted port goes on; a rogue OFFER on an untrusted port is dropped
 *    `dhcp-snooping` with the exact detail, its rule (the `ip dhcp snooping vlan 10` line) and a debug line, and PC1
 *    never sees it; the real server's OFFER and ACK on the trusted trunk are forwarded and the ACK writes the binding
 *    (the client port from the CAM row, the lease from option 51);
 *  - the MAC check and its stored negation; an ACK on a trusted port for a client with no CAM row writes nothing (and
 *    says why); a NAK removes a learned binding; the lease ends in the `cam-sweep`; link-down removes the learned
 *    bindings of the port, never a static one; RELEASE from the binding's port removes it;
 *  - static bindings (`ip source binding …`) derived idempotently: added, rewritten on change, removed with the line;
 *  - step 5: eleven DHCP messages in one sim-time second on a port limited to ten err-disable it (`dhcp-rate-limit`),
 *    ten do not; `errdisable recovery cause dhcp-rate-limit` brings it back after the interval, and without it the port
 *    stays down; `show errdisable recovery` lists the cause;
 *  - the SVI-egress binding: an ACK the multilayer switch's own SVI sends binds its client;
 *  - without the snooping lines the rogue OFFER is flooded as in P2, and two identical runs are byte-identical;
 *  - on the fake ctx of `l2.eth-switch.p2.harness.ts` (with the two tables laid over it): a frame that only learns
 *    (spanning tree `learning`) skips 7b, so it is not counted; an `errdisable recovery cause` line typed after the
 *    err-disable arms and cancels the timer of the new causes, whose expiry recovers the cause the port holds; turning
 *    port security off keeps the timer of a port err-disabled by snooping.
 */
import { describe, expect, it } from 'vitest';
import type { LayerSpec } from '../src/contracts/pdu.js';
import type { ProcessCtx, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { stpKey, vlanKey } from '../src/contracts/tables.js';
import type { DeviceTables, DhcpSnoopingRow, StpBridgeRow, StpPortRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createTable } from '../src/core/table.js';
import { createEthSwitch } from '../src/protocols/eth-switch.js';
import { DHCP_SNOOPING_DEBUG_CATEGORY } from '../src/protocols/l2/dhcp-snooping.js';
import { errdisableTimerKey } from '../src/protocols/l2/port-security.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, dhcpServerFrame, injectFrames, withInjector } from './inject.js';
import { DEVICE, FA3, p2SwitchHarness } from './l2.eth-switch.p2.harness.js';
import { console, ofKind } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA24 = 'FastEthernet0/24';
const GI1 = 'GigabitEthernet0/1';
const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
const ROGUE_MAC = '02:4e:77:00:00:24';
const STRANGER_MAC = '02:4e:99:00:00:99';
/** Every model booted, the trunk and the access ports through spanning tree. */
const BOOT = 120 * SEC;

/** No P3 daemon at all (before and after the W4 flip), so only the switch's own steps and the injector act. */
function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

/** A startup configuration from sections of lines (the saved-file shape). */
function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** SW1 of §3.4: PC1 on Fa0/1, PC2 on Fa0/2, ROGUE on Fa0/24 (VLAN 10), the trunk Gi0/1 to R1. */
function sw1Config(extra: readonly (readonly string[])[] = [], snooping = true, fa24: readonly string[] = []): string {
  const access = (port: string, more: readonly string[] = []): string[] => [
    `interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast', ...more.map((l) => ` ${l}`),
  ];
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1),
    access(FA2),
    access(FA24, fa24),
    [`interface ${GI1}`, ' switchport mode trunk', ...(snooping ? [' ip dhcp snooping trust'] : [])],
    ...(snooping ? [['ip dhcp snooping', 'ip dhcp snooping vlan 10']] : []),
    ...extra,
  ]);
}

/** R1 serves 192.168.10.0/24 on its VLAN 10 subinterface (router on a stick), .1–.10 kept back. */
const R1_LINES: readonly string[] = [
  'interface GigabitEthernet0/0',
  'no shutdown',
  'exit',
  'interface GigabitEthernet0/0.10',
  'encapsulation dot1q 10',
  'ip address 192.168.10.1 255.255.255.0',
  'exit',
  'ip dhcp excluded-address 192.168.10.1 192.168.10.10',
  'ip dhcp pool V10',
  'network 192.168.10.0 255.255.255.0',
  'default-router 192.168.10.1',
  'exit',
];

/** Apply `lines` through the device's own grammar; a failing line is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** The §3.4 world, booted, R1 serving the pool; PC1 not yet asking. */
function world(o: { seed?: number; sw?: string; withPc2?: boolean } = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 5, stage: 'P3', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: o.sw ?? sw1Config() });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'rogue', type: INJECTOR_HOST_TYPE, name: 'ROGUE' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_rogue', a: { device: 'rogue', port: INJ_PORT }, b: { device: 'sw1', port: FA24 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  if (o.withPc2 === true) {
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 192.168.10.50 255.255.255.0']]) });
    sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: FA2 } });
  }
  sim.runFor(BOOT);
  configured(sim, 'r1', R1_LINES);
  sim.runToIdle();
  return sim;
}

const macOf = (sim: Simulation, dev: string, port = PC_PORT): string => sim.device(dev)!.port(port)!.mac;
const bindings = (sim: Simulation, dev = 'sw1'): DhcpSnoopingRow[] => sim.device(dev)!.tables.get<DhcpSnoopingRow>('dhcp-snooping')!.rows();
const drops = (evs: readonly TraceEvent[], reason: string): Extract<TraceEvent, { kind: 'drop' }>[] =>
  ofKind(evs, 'drop').filter((e) => e.reason === reason);
const snoopDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === DHCP_SNOOPING_DEBUG_CATEGORY).map((e) => e.event.message);
const snoopWrites = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'tableWrite' }>[] =>
  ofKind(evs, 'tableWrite').filter((e) => e.table === 'dhcp-snooping');
const snoopExpires = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'tableExpire' }>[] =>
  ofKind(evs, 'tableExpire').filter((e) => e.table === 'dhcp-snooping');
const injectedAt = (evs: readonly TraceEvent[], dev: string): number =>
  ofKind(evs, 'frameRx').filter((e) => e.device === dev && e.pdu.tag === INJECTED_TAG).length;
/** The delay that puts the next instant on a sim-time second boundary (rate windows are aligned to seconds). */
const toNextSecond = (sim: Simulation): number => SEC - (sim.now % SEC);

/** PC1 asks for an address and gets it; returns the events of the exchange. */
function dora(sim: Simulation): TraceEvent[] {
  const from = sim.trace(0).next;
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim.trace(from).events;
}

describe('step 7b: a rogue server on an untrusted port (§3.4 steps 1–3)', () => {
  it('drops the rogue OFFER with its detail, rule and debug line; the real exchange binds PC1 on Fa0/1', () => {
    const sim = world();
    const pc1 = macOf(sim, 'pc1');
    const from = sim.trace(0).next;
    injectFrames(sim, {
      from: 'rogue', port: INJ_PORT, spacingNs: 0,
      frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: pc1, yiaddr: '10.66.0.20' })],
    });
    const evs = [...dora(sim)];
    const all = sim.trace(from).events;
    expect(evs.length).toBeGreaterThan(0);

    // step 2: the rogue OFFER dies at SW1 with the §3.4 detail and its rule
    const dropped = drops(all, 'dhcp-snooping');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ device: 'sw1', port: FA24, detail: 'DHCP server message (OFFER) from 10.66.0.1 on untrusted port FastEthernet0/24 (vlan 10)' });
    expect(dropped[0]!.pdu.tag).toBe(INJECTED_TAG);
    expect(dropped[0]!.rule).toEqual({
      kind: 'dhcp-snooping',
      text: 'DHCP snooping on vlan 10 accepts server messages only on trusted ports; if a legitimate server is reached through FastEthernet0/24, mark the port with "ip dhcp snooping trust"',
      config: { context: [], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] },
      iface: FA24,
    });
    expect(snoopDebug(all)[0]).toBe('dropped OFFER from 10.66.0.1 on untrusted FastEthernet0/24 (vlan 10)');
    expect(injectedAt(all, 'pc1')).toBe(0);
    expect(injectedAt(all, 'r1')).toBe(0);

    // steps 1 and 3: DISCOVER, REQUEST (untrusted Fa0/1), OFFER and ACK (trusted Gi0/1) all go through
    expect(ofKind(all, 'drop').filter((e) => e.device === 'sw1' && e.pdu.proto === 'dhcp' && e.pdu.tag !== INJECTED_TAG)).toEqual([]);
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.10.11', prefixLen: 24, origin: 'dhcp' });
    const writes = snoopWrites(all);
    expect(writes).toHaveLength(1);
    const ackAt = writes[0]!.t;
    const row = bindings(sim);
    expect(row).toEqual([{
      key: `10|${pc1}`, mac: pc1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400,
      updatedAt: ackAt, expiresAt: ackAt + 86400 * SEC,
    }]);
    expect(snoopDebug(all)).toContain(`binding ${pc1} 192.168.10.11 on ${FA1} (vlan 10), lease 86400 s`);
  });

  it('without the snooping lines the same rogue OFFER is flooded to PC1 and R1, and nothing is written (the P2 path)', () => {
    const sim = world({ sw: sw1Config([], false) });
    const from = sim.trace(0).next;
    injectFrames(sim, {
      from: 'rogue', port: INJ_PORT, spacingNs: 0,
      frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: macOf(sim, 'pc1'), yiaddr: '10.66.0.20' })],
    });
    dora(sim);
    const all = sim.trace(from).events;
    expect(drops(all, 'dhcp-snooping')).toEqual([]);
    expect(injectedAt(all, 'pc1')).toBe(1);
    expect(injectedAt(all, 'r1')).toBe(1);
    expect(snoopWrites(all)).toEqual([]);
    expect(snoopDebug(all)).toEqual([]);
    expect(bindings(sim)).toEqual([]);
  });

  it('is deterministic: two runs with one seed are byte-identical', () => {
    const run = (): string => {
      const sim = world({ seed: 11 });
      injectFrames(sim, {
        from: 'rogue', port: INJ_PORT, spacingNs: 5 * MS, count: 3,
        frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: macOf(sim, 'pc1'), yiaddr: '10.66.0.20' })],
      });
      dora(sim);
      return JSON.stringify(sim.trace(0).events) + JSON.stringify(bindings(sim));
    };
    expect(run()).toBe(run());
  });
});

describe('step 7b: the MAC check, trusted-port bookkeeping, and the binding lifetime', () => {
  /** A client message (DISCOVER or RELEASE) from `src`, naming `chaddr`, as a host would broadcast it. */
  function clientFrame(src: string, chaddr: string, type: 'DISCOVER' | 'RELEASE' = 'DISCOVER'): LayerSpec[] {
    return [
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '0.0.0.0', dst: '255.255.255.255', protocol: 17, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: 68, dstPort: 67 } },
      { proto: 'dhcp', fields: { op: 1, xid: 7, broadcastFlag: true, chaddr, messageType: type } },
    ];
  }

  it('drops a client message whose chaddr is not its source; "no ip dhcp snooping verify mac-address" lets it through', () => {
    const sim = world();
    const from = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, spacingNs: 0, frames: [clientFrame(ROGUE_MAC, STRANGER_MAC)] });
    sim.runToIdle();
    const first = sim.trace(from).events;
    const d = drops(first, 'dhcp-snooping');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      port: FA24,
      detail: `DHCP client message (DISCOVER) on ${FA24} (vlan 10) names client ${STRANGER_MAC} but comes from ${ROGUE_MAC}`,
    });
    expect(d[0]!.rule).toMatchObject({ kind: 'dhcp-snooping', config: { context: [], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] }, iface: FA24 });
    expect(injectedAt(first, 'r1')).toBe(0);

    expect(sim.device('sw1')!.applyConfigLine([], ['ip', 'dhcp', 'snooping', 'verify', 'mac-address'], true).ok).toBe(true);
    const again = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, spacingNs: 0, frames: [clientFrame(ROGUE_MAC, STRANGER_MAC)] });
    sim.runToIdle();
    const second = sim.trace(again).events;
    expect(drops(second, 'dhcp-snooping')).toEqual([]);
    expect(injectedAt(second, 'r1')).toBe(1);
  });

  it('a trusted ACK for a client with no CAM row binds nothing and says why; a NAK removes the binding; the lease ends in the cam-sweep', () => {
    // the injector stands in for a server on a trusted port (Fa0/24 trusted), so ACKs and NAKs can be shaped freely
    const sim = world({ sw: sw1Config([], true, ['ip dhcp snooping trust']), withPc2: true });
    const pc2 = macOf(sim, 'pc2');
    // PC2 talks once so SW1 learns its MAC on Fa0/2
    const s = sim.cli.open('pc2', 'console');
    sim.cli.exec(s, 'ping 192.168.10.1');
    sim.runToIdle();
    expect(sim.device('sw1')!.tables.cam.get(`10/${pc2}`)?.port).toBe(FA2);

    const t0 = sim.trace(0).next;
    injectFrames(sim, {
      from: 'rogue', port: INJ_PORT, spacingNs: 0,
      frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '192.168.10.2', chaddr: STRANGER_MAC, yiaddr: '192.168.10.70', type: 'ACK' })],
    });
    sim.runToIdle();
    const noCam = sim.trace(t0).events;
    expect(snoopWrites(noCam)).toEqual([]);
    expect(snoopDebug(noCam)).toEqual([`ACK for ${STRANGER_MAC} (vlan 10) records no binding for 192.168.10.70: the MAC address table has no entry for the client`]);
    expect(drops(noCam, 'dhcp-snooping')).toEqual([]);

    // an ACK with a 60 s lease binds PC2 on Fa0/2 (the CAM row's port)
    const t1 = sim.trace(0).next;
    injectFrames(sim, {
      from: 'rogue', port: INJ_PORT, spacingNs: 0,
      frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '192.168.10.2', chaddr: pc2, yiaddr: '192.168.10.50', type: 'ACK', leaseS: 60 })],
    });
    sim.runToIdle();
    const bound = snoopWrites(sim.trace(t1).events);
    expect(bound).toHaveLength(1);
    const at = bound[0]!.t;
    expect(bindings(sim)).toEqual([{ key: `10|${pc2}`, mac: pc2, ip: '192.168.10.50', vlan: 10, port: FA2, kind: 'learned', leaseS: 60, updatedAt: at, expiresAt: at + 60 * SEC }]);

    // a NAK removes it (reason 'cleared')
    const t2 = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, spacingNs: 0, frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '192.168.10.2', chaddr: pc2, type: 'NAK' })] });
    sim.runToIdle();
    const nak = sim.trace(t2).events;
    expect(snoopExpires(nak).map((e) => [e.key, e.reason])).toEqual([[`10|${pc2}`, 'cleared']]);
    expect(snoopDebug(nak)).toEqual([`binding ${pc2} 192.168.10.50 (vlan 10) removed: NAK`]);
    expect(bindings(sim)).toEqual([]);

    // bound again for 60 s: the first cam-sweep at or after the lease end removes it (reason 'aged')
    injectFrames(sim, {
      from: 'rogue', port: INJ_PORT, spacingNs: 0,
      frames: [dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '192.168.10.2', chaddr: pc2, yiaddr: '192.168.10.50', type: 'ACK', leaseS: 60 })],
    });
    sim.runToIdle();
    const end = bindings(sim)[0]!.expiresAt!;
    const t3 = sim.trace(0).next;
    sim.runUntil(end - 1);
    expect(bindings(sim)).toHaveLength(1);
    sim.runFor(16 * SEC);
    const aged = snoopExpires(sim.trace(t3).events);
    expect(aged.map((e) => [e.key, e.reason])).toEqual([[`10|${pc2}`, 'aged']]);
    expect(aged[0]!.t).toBeGreaterThanOrEqual(end);
    expect(aged[0]!.t).toBeLessThan(end + 15 * SEC);
    expect(snoopDebug(sim.trace(t3).events)).toEqual([`binding ${pc2} 192.168.10.50 on ${FA2} (vlan 10) removed: its lease ended`]);
  });

  it('link-down of the port removes its learned binding (static ones stay); a RELEASE from the binding\'s port removes it', () => {
    const sim = world({ sw: sw1Config([['ip source binding 02:4e:66:00:00:05 vlan 10 192.168.10.12 interface FastEthernet0/1']]) });
    const pc1 = macOf(sim, 'pc1');
    dora(sim);
    expect(bindings(sim).map((r) => [r.key, r.kind, r.port])).toEqual([
      ['10|02:4e:66:00:00:05', 'static', FA1],
      [`10|${pc1}`, 'learned', FA1],
    ]);
    const t0 = sim.trace(0).next;
    sim.removeLink('l_pc1');
    sim.runFor(SEC);
    const down = sim.trace(t0).events;
    expect(snoopExpires(down).map((e) => [e.key, e.reason])).toEqual([[`10|${pc1}`, 'link-down']]);
    expect(snoopDebug(down)).toEqual([`binding ${pc1} 192.168.10.11 on ${FA1} (vlan 10) removed: link down`]);
    expect(bindings(sim).map((r) => r.kind)).toEqual(['static']);

    // cabled again, PC1 renews its lease and is bound again; `no ip address dhcp` sends a RELEASE from Fa0/1
    sim.addLink({ id: 'l_pc1b', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
    sim.runFor(5 * SEC);
    configured(sim, 'pc1', ['no ip address dhcp']);
    sim.runToIdle();
    configured(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();
    expect(bindings(sim).find((r) => r.kind === 'learned')?.port).toBe(FA1);
    const t1 = sim.trace(0).next;
    configured(sim, 'pc1', ['no ip address dhcp']);
    sim.runToIdle();
    const rel = sim.trace(t1).events;
    expect(snoopExpires(rel).map((e) => [e.key, e.reason])).toEqual([[`10|${pc1}`, 'cleared']]);
    expect(snoopDebug(rel)).toEqual([`binding ${pc1} 192.168.10.11 (vlan 10) removed: RELEASE on ${FA1}`]);
    expect(bindings(sim).map((r) => r.kind)).toEqual(['static']);
  });
});

describe('static bindings (ip source binding)', () => {
  it('are derived idempotently: installed at boot, unchanged by a repeated line, rewritten on change, removed with the line', () => {
    const line = (ip: string): string[] => ['ip', 'source', 'binding', '02:4e:66:00:00:05', 'vlan', '10', ip, 'interface', FA2];
    const sim = world({ sw: sw1Config([[line('192.168.10.12').join(' '), 'ip source binding 02:4e:66:00:00:06 vlan 10 192.168.10.13 interface GigabitEthernet9/9']]) });
    // the line naming no port of SW1 is ignored
    expect(bindings(sim)).toEqual([{ key: '10|02:4e:66:00:00:05', mac: '02:4e:66:00:00:05', ip: '192.168.10.12', vlan: 10, port: FA2, kind: 'static', updatedAt: expect.any(Number) }]);
    const dev = sim.device('sw1')!;
    const t0 = sim.trace(0).next;
    expect(dev.applyConfigLine([], line('192.168.10.12'), false).ok).toBe(true);
    expect(snoopWrites(sim.trace(t0).events)).toEqual([]);

    expect(dev.applyConfigLine([], line('192.168.10.14'), false).ok).toBe(true);
    const changed = sim.trace(t0).events;
    expect(snoopWrites(changed).map((e) => e.row.ip)).toEqual(['192.168.10.14']);
    expect(bindings(sim).map((r) => r.ip)).toEqual(['192.168.10.14']);

    const t1 = sim.trace(0).next;
    expect(dev.applyConfigLine([], line('192.168.10.14'), true).ok).toBe(true);
    const gone = sim.trace(t1).events;
    expect(snoopExpires(gone).map((e) => [e.key, e.reason])).toEqual([['10|02:4e:66:00:00:05', 'cleared']]);
    expect(snoopDebug(gone)).toEqual([`static binding 02:4e:66:00:00:05 192.168.10.14 on ${FA2} (vlan 10) removed: its line is gone`]);
    expect(bindings(sim)).toEqual([]);
  });
});

describe('step 7b rate limit → err-disable dhcp-rate-limit (§3.4 step 5)', () => {
  const offer = (sim: Simulation) => dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: macOf(sim, 'pc1'), yiaddr: '10.66.0.20' });
  const limited = (recovery: boolean): string => sw1Config(
    recovery ? [['errdisable recovery cause dhcp-rate-limit', 'errdisable recovery interval 30']] : [],
    true,
    ['ip dhcp snooping limit rate 10'],
  );

  it('ten messages in one second pass the limit; eleven err-disable the port with the exact drop, log and portState', () => {
    const sim = world({ sw: limited(false) });
    const t0 = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, frames: [offer(sim)], count: 10, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    const ten = sim.trace(t0).events;
    expect(drops(ten, 'dhcp-snooping').map((e) => e.detail)).toEqual(Array(10).fill(`DHCP server message (OFFER) from 10.66.0.1 on untrusted port ${FA24} (vlan 10)`));
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();

    const t1 = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, frames: [offer(sim)], count: 11, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    const eleven = sim.trace(t1).events;
    const d = drops(eleven, 'dhcp-snooping');
    expect(d).toHaveLength(11);
    expect(d[10]).toMatchObject({ device: 'sw1', port: FA24, detail: `DHCP rate limit exceeded on ${FA24}: 11 packets in one second, the limit is 10` });
    expect(d[10]!.rule).toEqual({
      kind: 'dhcp-snooping',
      text: `${FA24} accepts at most 10 DHCP packets per second; more than that shuts the port down (error-disabled) until it is recovered`,
      config: { context: [['interface', FA24]], line: ['ip', 'dhcp', 'snooping', 'limit', 'rate', '10'] },
      iface: FA24,
    });
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
    expect(ofKind(eleven, 'log').filter((e) => e.device === 'sw1').map((e) => [e.severity, e.message])).toContainEqual([
      4, `Interface ${FA24} is error-disabled by the DHCP snooping rate limit: 11 DHCP packets in one second, the limit is 10.`,
    ]);
    expect(ofKind(eleven, 'portState').filter((e) => e.device === 'sw1' && e.port === FA24).map((e) => e.reason)).toContain('err-disabled');
    expect(snoopDebug(eleven).at(-1)).toBe(`${FA24} (vlan 10): 11 DHCP packets in this second exceed the limit of 10; error-disabling the port`);
    // without `errdisable recovery cause dhcp-rate-limit` the port stays down
    sim.runFor(400 * SEC);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
  });

  it('eleven messages split over two seconds do not err-disable the port', () => {
    const sim = world({ sw: limited(false) });
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, frames: [offer(sim)], count: 11, spacingNs: 100 * MS, startNs: toNextSecond(sim) + 500 * MS });
    sim.runToIdle();
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();
  });

  it('errdisable recovery cause dhcp-rate-limit recovers the port after the interval; show errdisable recovery lists the cause', () => {
    const sim = world({ sw: limited(true) });
    const t0 = sim.trace(0).next;
    injectFrames(sim, { from: 'rogue', port: INJ_PORT, frames: [offer(sim)], count: 11, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runUntil(sim.now + 2 * SEC);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
    const disabledAt = ofKind(sim.trace(t0).events, 'portState').find((e) => e.port === FA24 && e.reason === 'err-disabled')!.t;
    expect(snoopDebug(sim.trace(t0).events)).toContain(`${FA24} recovers from err-disable in 30 s`);

    const { session } = console(sim, 'sw1', ['enable']);
    const shown = sim.cli.exec(session, 'show errdisable recovery').output.split('\n');
    expect(shown.slice(0, 6).map((l) => l.trimEnd())).toEqual([
      expect.stringMatching(/^Cause\s+Automatic recovery$/),
      expect.stringMatching(/^psecure-violation\s+off$/),
      expect.stringMatching(/^bpduguard\s+off$/),
      expect.stringMatching(/^channel-misconfig\s+off$/),
      expect.stringMatching(/^dhcp-rate-limit\s+on$/),
      expect.stringMatching(/^arp-inspection\s+off$/),
    ]);
    expect(shown.find((l) => l.startsWith(FA24))).toMatch(/by itself, within 30 s$/);

    const t1 = sim.trace(0).next;
    sim.runFor(40 * SEC);
    const rec = sim.trace(t1).events;
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();
    const recovered = ofKind(rec, 'portState').find((e) => e.port === FA24 && e.reason === 'err-recovered')!;
    expect(recovered.t).toBe(disabledAt + 30 * SEC);
    expect(ofKind(rec, 'log').filter((e) => e.device === 'sw1').map((e) => e.message)).toContain(
      `Interface ${FA24} leaves the error-disabled state (the DHCP snooping rate limit) and may come up again.`,
    );
    expect(snoopDebug(rec)).toContain(`recovering ${FA24} from err-disable`);
  });
});

describe('the SVI-egress binding (D13): an ACK the switch\'s own SVI sends binds its client', () => {
  it('a multilayer switch serving the pool on Vlan10 binds PC1 on its access port', () => {
    const sim = createStagedSimulation({ seed: 3, stage: 'P3', factories: noP3() });
    const ACC = 'GigabitEthernet1/0/1';
    sim.addDevice({
      id: 'mls1', type: 'mlswitch.nfc3650-24', name: 'MLS1', startupConfig: configText([
        ['hostname MLS1'],
        ['vlan 10'],
        [`interface ${ACC}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast'],
        ['interface Vlan10', ' ip address 192.168.10.1 255.255.255.0', ' no shutdown'],
        ['ip dhcp snooping', 'ip dhcp snooping vlan 10'],
      ]),
    });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    sim.addLink({ id: 'l1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'mls1', port: ACC } });
    sim.runFor(BOOT);
    configured(sim, 'mls1', ['ip dhcp excluded-address 192.168.10.1 192.168.10.10', 'ip dhcp pool V10', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'exit']);
    const from = sim.trace(0).next;
    configured(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();
    const evs = sim.trace(from).events;
    const pc1 = macOf(sim, 'pc1');
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.10.11', prefixLen: 24, origin: 'dhcp' });
    expect(drops(evs, 'dhcp-snooping')).toEqual([]);
    const w = snoopWrites(evs);
    expect(w).toHaveLength(1);
    expect(bindings(sim, 'mls1')).toEqual([{
      key: `10|${pc1}`, mac: pc1, ip: '192.168.10.11', vlan: 10, port: ACC, kind: 'learned', leaseS: 86400,
      updatedAt: w[0]!.t, expiresAt: w[0]!.t + 86400 * SEC,
    }]);
    expect(snoopDebug(evs)).toEqual([`binding ${pc1} 192.168.10.11 on ${ACC} (vlan 10), lease 86400 s`]);
  });
});

describe('the fake-ctx cases (the P2 harness with the two tables laid over it)', () => {
  /** The P2 harness, plus a ctx whose tables also hold `dhcp-snooping` and `arp-inspection` (a P3-stage switch). */
  function staged() {
    const h = p2SwitchHarness();
    const sink = { emit: (ev: TraceEvent) => { h.trace.push(ev); } };
    const extra = new Map<TableName, Table<TableRow>>();
    for (const name of ['dhcp-snooping', 'arp-inspection'] as const) extra.set(name, createTable<TableRow>({ name, device: DEVICE, sink, now: () => h.ctx.now }));
    const tables = new Proxy(h.tables, {
      get(t, p, r) {
        if (p === 'get') return <R extends TableRow>(name: TableName): Table<R> | undefined => (extra.get(name) as Table<R> | undefined) ?? t.get<R>(name);
        return Reflect.get(t, p, r) as unknown;
      },
    }) as DeviceTables;
    const ctx = new Proxy(h.ctx, { get: (t, p, r) => (p === 'tables' ? tables : (Reflect.get(t, p, r) as unknown)) }) as ProcessCtx;
    return { h, ctx };
  }
  const offer = (h: ReturnType<typeof p2SwitchHarness>) => h.ctx.newPdu(dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: STRANGER_MAC, yiaddr: '10.66.0.20' }));

  it('a frame that only learns (spanning tree learning) skips step 7b: dropped by spanning tree and not counted', () => {
    const { h, ctx } = staged();
    const sw = createEthSwitch();
    sw.init!(ctx);
    h.config.set([], ['ip', 'dhcp', 'snooping']);
    h.config.set([], ['ip', 'dhcp', 'snooping', 'vlan', '1']);
    h.config.set([['interface', FA1]], ['ip', 'dhcp', 'snooping', 'limit', 'rate', '1']);
    h.tables.get<StpBridgeRow>('stp-bridge')!.set({ key: vlanKey(1), vlan: 1, updatedAt: 0 } as unknown as StpBridgeRow);
    const stp = h.tables.get<StpPortRow>('stp')!;
    stp.set({ key: stpKey(1, FA1), vlan: 1, port: FA1, state: 'learning', updatedAt: 0 } as unknown as StpPortRow);
    h.setNow(10 * SEC);
    const learning = sw.onPdu(ctx, offer(h), FA1);
    expect(learning).toEqual([expect.objectContaining({ type: 'drop', reason: 'stp-discarding', detail: 'learning' })]);
    // forwarding now: one more message in the same second is the first one counted (limit 1: no err-disable)
    stp.set({ key: stpKey(1, FA1), vlan: 1, port: FA1, state: 'forwarding', updatedAt: 0 } as unknown as StpPortRow);
    const counted = sw.onPdu(ctx, offer(h), FA1);
    expect(counted).toEqual([expect.objectContaining({
      type: 'drop', reason: 'dhcp-snooping', port: FA1,
      detail: `DHCP server message (OFFER) from 10.66.0.1 on untrusted port ${FA1} (vlan 1)`,
    })]);
    expect(sw.onPdu(ctx, offer(h), FA1).map((a) => a.type)).toEqual(['drop', 'errDisable']);
  });

  it('a recovery line typed after the err-disable arms (and its removal cancels) the timer of the new causes; expiry recovers the held cause', () => {
    const { h, ctx } = staged();
    const sw = createEthSwitch();
    sw.init!(ctx);
    h.setErrDisabled(FA1, 'arp-inspection');
    h.setErrDisabled(FA2, 'dhcp-rate-limit');
    h.configure(sw, [], ['errdisable', 'recovery', 'interval', '30']);
    const before = h.debug.length;
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'arp-inspection'])).toEqual([
      { type: 'timer', key: errdisableTimerKey(FA1), delay: 30 * SEC, periodic: true },
    ]);
    expect(h.debug.slice(before).map((d) => [d.category, d.message])).toEqual([['ip arp inspection', `${FA1} recovers from err-disable in 30 s`]]);
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'dhcp-rate-limit'])).toEqual([
      { type: 'timer', key: errdisableTimerKey(FA2), delay: 30 * SEC, periodic: true },
    ]);
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'arp-inspection'], true)).toEqual([{ type: 'cancelTimer', key: errdisableTimerKey(FA1) }]);
    h.setNow(30 * SEC);
    expect(sw.onTimer(ctx, errdisableTimerKey(FA2))).toEqual([{ type: 'errRecover', port: FA2, cause: 'dhcp-rate-limit' }]);
    expect(h.debug.at(-1)).toMatchObject({ category: DHCP_SNOOPING_DEBUG_CATEGORY, message: `recovering ${FA2} from err-disable` });
    // a port err-disabled by a cause this daemon does not own is never recovered by its timer
    h.setErrDisabled(FA3, 'bpduguard');
    expect(sw.onTimer(ctx, errdisableTimerKey(FA3))).toEqual([]);
  });

  it('turning port security off keeps the recovery timer of a port err-disabled by snooping', () => {
    const { h, ctx } = staged();
    const sw = createEthSwitch();
    sw.init!(ctx);
    h.configure(sw, [], ['errdisable', 'recovery', 'interval', '60']);
    h.lines(sw, FA1, ['switchport mode access', 'switchport port-security']);
    h.setErrDisabled(FA1, 'dhcp-rate-limit');
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'dhcp-rate-limit'])).toEqual([
      { type: 'timer', key: errdisableTimerKey(FA1), delay: 60 * SEC, periodic: true },
    ]);
    expect(h.lines(sw, FA1, ['no switchport port-security'])).toEqual([]);
    h.setNow(60 * SEC);
    expect(sw.onTimer(ctx, errdisableTimerKey(FA1))).toEqual([{ type: 'errRecover', port: FA1, cause: 'dhcp-rate-limit' }]);
  });
});
