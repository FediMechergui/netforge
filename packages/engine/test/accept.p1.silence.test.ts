/**
 * P1 acceptance — the silence rule (ARCHITECTURE-P1 §10.2 `accept.p1.silence`; §5.3, §1.6).
 *
 * The guard for the whole rule: no P1 daemon sends anything without configuration or a request. Every P0/P0.5
 * template of sim/scenarios.ts is loaded into a fresh simulation and run for 600 s of simulated time with nothing
 * typed and nothing asked for. Not one PDU in that window may have been created by a P1 daemon (ipv6, nd, icmpv6,
 * udp, tcp, dhcp-client, dhcp-server, dns-client, dns-server, http-client, http-server, traceroute), even though
 * every model boots with them registered.
 *
 * The check reads `pduCreated.process`, the name of the process that built the PDU, so a P0/P0.5 daemon that
 * happens to carry a P1 protocol (an ARP request, a switch flood) can never be mistaken for a P1 daemon waking up,
 * and a failure names the device, the process and the tag that broke the silence.
 *
 * ponytail: one 600 s window per template rather than a matrix of shorter runs — the longest P1 maintenance timer
 * (a DHCP renewal at half of a lease) is far inside it, so a daemon that arms a timer at boot is caught here.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import { SEC } from '../src/contracts/time.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind } from './sim.harness.js';

/** How long each template is watched (§10.2). */
const WINDOW_NS = 600 * SEC;

/**
 * The daemons P1 added (ARCHITECTURE-P1 §8.2). None of them may create a PDU on a template that configures no
 * address family, no service and no client beyond what P0/P0.5 already used.
 */
const P1_DAEMONS: readonly ProcessName[] = [
  'ipv6',
  'nd',
  'icmpv6',
  'udp',
  'tcp',
  'dhcp-client',
  'dhcp-server',
  'dns-client',
  'dns-server',
  'http-client',
  'http-server',
  'traceroute',
];

/**
 * The P0/P0.5 "New from template" worlds. The P1 labs of the same list configure services on purpose and are graded
 * elsewhere (§10.2 `accept.p1.labs`); the silence rule is about a world nobody has touched.
 */
const TEMPLATE_WORLDS = SCENARIOS.filter((s) => s.category === 'template');

/** `<device>/<process> <tag>` of every PDU a P1 daemon created, so a failure says who broke the silence. */
function p1Pdus(template: (typeof SCENARIOS)[number], seed: number): string[] {
  const sim = createSimulation({ seed });
  sim.loadTopology(template.build());
  sim.runFor(WINDOW_NS);
  const created = ofKind(sim.trace(0).events, 'pduCreated');
  // Every template must actually have run: a world that emitted nothing would pass vacuously.
  expect(created.length, `${template.name}: nothing happened at all`).toBeGreaterThan(0);
  expect(sim.now).toBe(WINDOW_NS);
  return created
    .filter((e) => P1_DAEMONS.includes(e.process))
    .map((e) => `${e.device}/${e.process} ${e.pdu.tag ?? e.pdu.proto} at ${String(e.t)}`);
}

describe('accept P1: the P1 daemons stay silent on every P0 and P0.5 template', () => {
  for (const template of TEMPLATE_WORLDS) {
    it(`${template.name}: 600 s with nobody typing produces no P1 daemon traffic`, () => {
      expect(p1Pdus(template, 1)).toEqual([]);
    });
  }

  it('covers every template the UI offers, and the daemons really are installed on those devices', () => {
    expect(TEMPLATE_WORLDS.map((t) => t.name)).toEqual([
      'two-pcs-and-switch',
      'pc-router-pc',
      'three-routers',
      'home-wifi',
      'hub-collision',
      'serial-pair',
      'multilayer-routed-port',
      'radio-bridge',
      'cellular-phones',
    ]);
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(TEMPLATE_WORLDS[0]!.build());
    sim.runFor(60 * SEC);
    // PC1 boots with the P1 host daemons: the silence above is a decision of theirs, not an empty process list.
    const running = [...sim.device('pc1')!.processes.keys()];
    for (const daemon of ['ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'http-client'] as const) {
      expect(running, daemon).toContain(daemon);
    }
  });

  it('is the same silence under a different seed', () => {
    for (const template of TEMPLATE_WORLDS) expect(p1Pdus(template, 9), template.name).toEqual([]);
  });
});
