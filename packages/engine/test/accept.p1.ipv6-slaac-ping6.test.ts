/**
 * P1 acceptance — IPv6 autoconfiguration and ping across a router (ARCHITECTURE-P1 §10.2
 * `accept.p1.ipv6-slaac-ping6`; §4.6 SLAAC, DAD, NDP and ping -6).
 *
 * PC1 – R1 – PC2, where R1 routes IPv6 and advertises the prefix of each side. PC1 is told only
 * `ipv6 autoconfig`; everything it ends up with — its link-local, the advertised prefix, the default route and the
 * neighbour entry for the router — is what the nd and ipv6 daemons produced, read back from the trace, the port
 * addresses and the IPv6 routing table.
 *
 * ponytail: the duplicate-address case builds its own two-host segment, which is all a collision needs.
 */
import { describe, expect, it } from 'vitest';
import type { Ipv6PortAddress } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { NdRow, Route6Row } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { eui64Address, linkLocalFromMac } from '../src/core/addr6.js';
import { createSimulation } from '../src/sim/simulation.js';
import { cable, device, topology } from './accept.p05.harness.js';
import { ofKind, ping } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const BOOT = 60 * SEC;
const LEFT_PREFIX = '2001:db8:1::';
const PC2_ADDRESS = '2001:db8:2::5';

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** PC1 (autoconfig) – R1 (routes IPv6, 2001:db8:1::1 and 2001:db8:2::1) – PC2 (2001:db8:2::5), booted. */
function lab(seed = 21): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [device('pc1', 'pc.nfpc', 'PC1', 100, 300), device('r1', 'router.nf2911', 'R1', 320, 160), device('pc2', 'pc.nfpc', 'PC2', 540, 300)],
      [cable('l_pc1_r1', 'pc1', PC_PORT, 'r1', G0), cable('l_r1_pc2', 'r1', G1, 'pc2', PC_PORT)],
    ),
  );
  sim.runFor(BOOT);
  configured(sim, 'r1', [
    'ipv6 unicast-routing',
    'interface GigabitEthernet0/0',
    `ipv6 address ${LEFT_PREFIX}1/64`,
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    'ipv6 address 2001:db8:2::1/64',
    'no shutdown',
    'exit',
  ]);
  // PC2 answers on a typed address and, like any host, listens for the router advertisement that gives it a
  // way back to the other side (the ND default route follows the autoconfig line, §4.6).
  configured(sim, 'pc2', [`ipv6 address ${PC2_ADDRESS}/64`, 'ipv6 autoconfig']);
  sim.runFor(5 * SEC);
  return sim;
}

const addresses = (sim: Simulation, dev: string, port = PC_PORT): readonly Ipv6PortAddress[] => sim.device(dev)!.port(port)!.l3.ipv6 ?? [];
const rib6 = (sim: Simulation, dev: string): Route6Row[] => sim.device(dev)!.tables.get<Route6Row>('rib6')?.rows() ?? [];
const neighbours = (sim: Simulation, dev: string): NdRow[] => sim.device(dev)!.tables.get<NdRow>('nd')?.rows() ?? [];

describe('accept P1: IPv6 SLAAC and ping across a router', () => {
  it('runs duplicate-address detection, solicits a router and takes the advertised prefix', () => {
    const sim = lab();
    const cursor = sim.trace(0).next;
    configured(sim, 'pc1', ['ipv6 autoconfig']);
    sim.runFor(5 * SEC);

    const evs = sim.trace(cursor).events;
    const mine = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1');
    const linkLocal = linkLocalFromMac(sim.device('pc1')!.port(PC_PORT)!.mac);
    const slaac = eui64Address(LEFT_PREFIX, 64, sim.device('pc1')!.port(PC_PORT)!.mac);

    const steps = mine.filter((e) => e.pdu.tag === 'dad-ns' || e.pdu.tag === 'nd-rs').map((e) => {
      const pdu = sim.pdu(e.pdu.id)!;
      return { tag: e.pdu.tag, src: String(pdu.get('ipv6.src')), target: String(pdu.get('icmpv6.target') ?? '') };
    });
    // Link-local DAD from the unspecified address, then the solicitation, then DAD for the new prefix address.
    expect(steps[0]).toEqual({ tag: 'dad-ns', src: '::', target: linkLocal });
    expect(steps.find((s) => s.tag === 'nd-rs')).toBeDefined();
    expect(steps.some((s) => s.tag === 'dad-ns' && s.src === '::' && s.target === slaac)).toBe(true);
    expect(steps.findIndex((s) => s.tag === 'nd-rs')).toBeLessThan(steps.findIndex((s) => s.target === slaac));

    const ra = ofKind(evs, 'pduCreated').find((e) => e.device === 'r1' && e.pdu.tag === 'nd-ra')!;
    expect(ra).toBeDefined();
    const raPdu = sim.pdu(ra.pdu.id)!;
    expect(raPdu.get('icmpv6.prefix')).toBe(LEFT_PREFIX);
    expect(raPdu.get('icmpv6.prefixLen')).toBe(64);
    expect(raPdu.get('ipv6.hopLimit')).toBe(255);
    expect(raPdu.get('ipv6.dst')).toBe('ff02::1');

    // The address the prefix produced is preferred, and it is the EUI-64 one.
    const learned = addresses(sim, 'pc1').find((a) => a.address === slaac)!;
    expect(learned).toMatchObject({ origin: 'slaac', state: 'preferred', prefixLen: 64 });
    expect(addresses(sim, 'pc1').find((a) => a.address === linkLocal)).toMatchObject({ origin: 'auto-link-local', state: 'preferred' });

    // The default route points at the router's link-local address, learned from the advertisement.
    const routerLl = linkLocalFromMac(sim.device('r1')!.port(G0)!.mac);
    const fallback = rib6(sim, 'pc1').find((r) => r.prefixLen === 0)!;
    expect(fallback).toMatchObject({ network: '::', source: 'ND', nextHop: routerLl, iface: PC_PORT });
    expect(neighbours(sim, 'pc1').find((n) => n.ip === routerLl)).toMatchObject({ isRouter: true, iface: PC_PORT });
  });

  it('pings the far host through the router five times, and the router counts the hop limit down', () => {
    const sim = lab();
    configured(sim, 'pc1', ['ipv6 autoconfig']);
    sim.runFor(5 * SEC);

    const cursor = sim.trace(0).next;
    const echo = ping(sim, 'pc1', PC2_ADDRESS);
    expect(echo.text).toContain('Sent 5, received 5, lost 0');

    const requests = ofKind(sim.trace(cursor).events, 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.proto === 'icmpv6');
    expect(requests.length).toBeGreaterThanOrEqual(5);
    const first = sim.pdu(requests[0]!.pdu.id)!;
    expect(first.get('ipv6.dst')).toBe(PC2_ADDRESS);
    expect(first.get('icmpv6.type')).toBe(128);

    // The router is the only device that touched the hop limit, and it took exactly one off.
    const decrements = first.provenance.filter((m) => m.field === 'ipv6.hopLimit');
    expect(decrements).toHaveLength(1);
    expect(decrements[0]).toMatchObject({ device: 'r1', reason: 'TtlDecrement', before: 64, after: 63 });
  });

  it('marks a second claim on the same address duplicate and logs it', () => {
    const sim = createSimulation({ seed: 21 });
    sim.loadTopology(
      topology(
        [device('pca', 'pc.nfpc', 'PCA', 100, 300), device('sw1', 'switch.nfc2960', 'SW1', 300, 200), device('pcb', 'pc.nfpc', 'PCB', 500, 300)],
        [cable('l_pca_sw1', 'pca', PC_PORT, 'sw1', 'FastEthernet0/1'), cable('l_pcb_sw1', 'pcb', PC_PORT, 'sw1', 'FastEthernet0/2')],
      ),
    );
    sim.runFor(BOOT);
    configured(sim, 'pca', ['ipv6 address 2001:db8:9::7/64']);
    sim.runFor(5 * SEC);
    expect(addresses(sim, 'pca').find((a) => a.address === '2001:db8:9::7')).toMatchObject({ state: 'preferred', origin: 'manual' });

    const cursor = sim.trace(0).next;
    configured(sim, 'pcb', ['ipv6 address 2001:db8:9::7/64']);
    sim.runFor(5 * SEC);

    expect(addresses(sim, 'pcb').find((a) => a.address === '2001:db8:9::7')).toMatchObject({ state: 'duplicate', origin: 'manual' });
    const logs = ofKind(sim.trace(cursor).events, 'log').filter((e) => e.device === 'pcb');
    expect(logs.some((l) => l.severity === 4 && l.message.includes('2001:db8:9::7'))).toBe(true);
  });
});
