/**
 * protocols/index.ts — the process registry (spec §4.8, ARCHITECTURE module map, ARCHITECTURE-P1 §8.1 W4, §8.2 W5).
 *
 * Maps every daemon name a `DeviceModel.processes` list can carry to its factory, so `device/catalog` can
 * resolve the list to live `Process` instances at boot:
 *  - P0 daemons: `eth-switch`, `arp`, `ipv4`, `icmpv4`, `host`;
 *  - P0.5 daemons: `hdlc` (serial framing and keepalives), `wlan-ap` and `wlan-client` (802.11 association and
 *    authorization), `cell-client` (cellular attach);
 *  - P1 daemons: `ipv6`, `nd`, `icmpv6` (SLAAC/DAD/NDP), `udp` and `tcp` (the socket layer), and the
 *    applications `dhcp-client`, `dhcp-server`, `dns-client`, `dns-server`, `http-client`, `http-server`,
 *    `traceroute`.
 * Keys follow the canonical daemon order (`PROCESS_ORDER` in contracts/catalog.ts), so this object lists every
 * name that order does. Every factory is re-exported for direct use. Each daemon is silent without configuration
 * or a request (ARCHITECTURE-P1 §5.3), so registering them never changes P0 scenario traffic.
 */
import type { ProcessName } from '../contracts/ids.js';
import type { ProcessFactory } from '../contracts/process.js';
import { createWlanAp } from './wlan-ap.js';
import { createWlanClient } from './wlan-client.js';
import { createCellClient } from './cell-client.js';
import { createHdlc } from './hdlc.js';
import { createEthSwitch } from './eth-switch.js';
import { createArp } from './arp.js';
import { createIpv4 } from './ipv4.js';
import { createIcmpv4 } from './icmpv4.js';
import { createHost } from './host.js';
import { createIpv6 } from './ipv6.js';
import { createNd } from './nd.js';
import { createIcmpv6 } from './icmpv6.js';
import { createUdp } from './udp.js';
import { createTcp } from './tcp.js';
import { createDhcpClient } from './dhcp-client.js';
import { createDhcpServer } from './dhcp-server.js';
import { createDnsClient } from './dns-client.js';
import { createDnsServer } from './dns-server.js';
import { createHttpClient } from './http-client.js';
import { createHttpServer } from './http-server.js';
import { createTraceroute } from './traceroute.js';

export { createWlanAp } from './wlan-ap.js';
export { createWlanClient } from './wlan-client.js';
export { createCellClient } from './cell-client.js';
export { createHdlc } from './hdlc.js';
export { createEthSwitch } from './eth-switch.js';
export { createArp } from './arp.js';
export { createIpv4 } from './ipv4.js';
export { createIcmpv4 } from './icmpv4.js';
export { createHost } from './host.js';
export { createIpv6 } from './ipv6.js';
export { createNd } from './nd.js';
export { createIcmpv6 } from './icmpv6.js';
export { createUdp } from './udp.js';
export { createTcp } from './tcp.js';
export { createDhcpClient } from './dhcp-client.js';
export { createDhcpServer } from './dhcp-server.js';
export { createDnsClient } from './dns-client.js';
export { createDnsServer } from './dns-server.js';
export { createHttpClient } from './http-client.js';
export { createHttpServer } from './http-server.js';
export { createTraceroute } from './traceroute.js';

/** Daemon name → factory, in canonical daemon order (`PROCESS_ORDER`). Frozen: the registry is static data. */
export const PROCESS_FACTORIES: Readonly<Record<ProcessName, ProcessFactory>> = Object.freeze({
  'wlan-ap': createWlanAp,
  'wlan-client': createWlanClient,
  'cell-client': createCellClient,
  hdlc: createHdlc,
  'eth-switch': createEthSwitch,
  arp: createArp,
  ipv4: createIpv4,
  icmpv4: createIcmpv4,
  host: createHost,
  ipv6: createIpv6,
  nd: createNd,
  icmpv6: createIcmpv6,
  udp: createUdp,
  tcp: createTcp,
  'dhcp-client': createDhcpClient,
  'dhcp-server': createDhcpServer,
  'dns-client': createDnsClient,
  'dns-server': createDnsServer,
  'http-client': createHttpClient,
  'http-server': createHttpServer,
  traceroute: createTraceroute,
});

/** Registered daemon names, in registry (canonical daemon) order. */
export const REGISTERED_PROCESSES: readonly ProcessName[] = Object.freeze(Object.keys(PROCESS_FACTORIES));

/** Resolve a daemon name to its factory (undefined for unknown names). */
export function processFactory(name: ProcessName): ProcessFactory | undefined {
  return Object.prototype.hasOwnProperty.call(PROCESS_FACTORIES, name) ? PROCESS_FACTORIES[name] : undefined;
}
