/**
 * sim/scenarios/ccna1/index.ts — the CCNA 1 lab catalogue in course order (ARCHITECTURE-P1 §4.13, §8.2 W6).
 *
 * The arc runs from one switched LAN to a small routed network with services, then IPv6, wireless and
 * fault-finding: build a LAN, address a host and its gateway, split a block into subnets, route between subnets
 * and across a chain of routers, lease addresses, resolve names, publish a page, let hosts build IPv6 addresses,
 * set up a wireless network, harden a device, and repair three worlds that boot broken.
 *
 * Every entry is a `ScenarioInfo` with `category: 'ccna1-lab'`, paraphrased objectives (never a line copied from
 * an official course blueprint, §1.6), tasks whose assertions read structured state, and a reference `solution`
 * that `Simulation.configure` accepts as written (proved by test/labs.solutions.test.ts).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { ccna1DefaultGateway, ccna1DeviceHardening, ccna1SwitchedLan } from './foundations.js';
import { ccna1StaticRoutes, ccna1SubnettingPlan, ccna1TraceroutePath, ccna1TwoSubnets } from './routing.js';
import { ccna1DhcpRelay, ccna1DhcpServer, ccna1DnsRecords, ccna1WebServer } from './services.js';
import { ccna1Ipv6Slaac } from './ipv6.js';
import { ccna1HomeWifi } from './wireless.js';
import { ccna1TroubleshootAddressing, ccna1TroubleshootPorts } from './troubleshooting.js';

export * from './foundations.js';
export * from './routing.js';
export * from './services.js';
export * from './ipv6.js';
export * from './wireless.js';
export * from './troubleshooting.js';

/** The CCNA 1 labs, in the order the course meets them. */
export const CCNA1_LABS: readonly ScenarioInfo[] = [
  ccna1SwitchedLan,
  ccna1DefaultGateway,
  ccna1DeviceHardening,
  ccna1SubnettingPlan,
  ccna1TwoSubnets,
  ccna1StaticRoutes,
  ccna1TraceroutePath,
  ccna1DhcpServer,
  ccna1DhcpRelay,
  ccna1DnsRecords,
  ccna1WebServer,
  ccna1Ipv6Slaac,
  ccna1HomeWifi,
  ccna1TroubleshootAddressing,
  ccna1TroubleshootPorts,
];
