/**
 * cli/handlers/index.ts — the command handler registry (spec §7.2; ARCHITECTURE "cli/handlers/*", ARCHITECTURE-P1
 * §8.1 W3 cli, §8.2 W5 cli).
 *
 * Maps every handler id of `cli/grammar/index.ts` (`HANDLERS`) to its implementation: EXEC (`exec.ts`), global and
 * shared interface configuration (`config.ts`), every `show` output template (`show.ts`), the host shell (`pc.ts`,
 * `host.ts`, `host-net.ts`), serial lines (`serial.ts`), switchport (`switchport.ts`), radio lines (`wireless.ts`)
 * and the P1 features: IPv6 (`ipv6.ts`), DHCP (`dhcp.ts`), DNS (`dns.ts`), web services (`services.ts`), the socket
 * listing (`transport.ts`), path traces (`traceroute.ts`) and passwords and lines (`line-auth.ts`). The CLI runtime
 * looks handlers up here by `CommandSpec.handler`.
 *
 * `exec.debug`, `exec.undebug-all` and `exec.do` are bound to the runtime at construction time
 * (`createRuntimeHandlers` in `exec.ts`) and are merged over this registry by `createCliRuntime`, so they are
 * intentionally absent here.
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { configHandlers } from './config.js';
import { dhcpHandlers } from './dhcp.js';
import { dnsHandlers } from './dns.js';
import { execHandlers } from './exec.js';
import { hostHandlers } from './host.js';
import { hostNetHandlers } from './host-net.js';
import { ipv6Handlers } from './ipv6.js';
import { lineAuthHandlers } from './line-auth.js';
import { pcHandlers } from './pc.js';
import { routingHandlers } from './routing.js';
import { serialHandlers } from './serial.js';
import { servicesHandlers } from './services.js';
import { showHandlers } from './show.js';
import { subifHandlers } from './subif.js';
import { switchportHandlers, switchportP2Handlers } from './switchport.js';
import { tracerouteHandlers } from './traceroute.js';
import { transportHandlers } from './transport.js';
import { vlanHandlers } from './vlan.js';
import { wirelessHandlers } from './wireless.js';
import { spanningTreeHandlers } from './spanning-tree.js';
import { etherchannelHandlers } from './etherchannel.js';
import { portSecurityHandlers } from './port-security.js';
import { errdisableHandlers } from './errdisable.js';
import { natHandlers } from './nat.js';
import { aclHandlers } from './acl.js';
import { dhcpv6Handlers } from './dhcpv6.js';
import { hsrpHandlers } from './hsrp.js';
import { wlcHandlers } from './wlc.js';

/**
 * @since P2 (ARCHITECTURE-P2 §7 W2, W3 and W5 cli) The handlers of the P2 fragments (`P2_HANDLERS` ids): VLANs, the
 * P2 switchport lines and switching show commands, subinterfaces and ranges, the routing switches (W2); spanning tree,
 * EtherChannel, port security, err-disable recovery, NAT, access lists, DHCPv6 and [S2] HSRP (W3); the wireless
 * controller and lightweight access point lines and `show capwap` (W5).
 */
export const P2_HANDLER_REGISTRY: Record<string, CommandHandler> = {
  ...vlanHandlers,
  ...switchportP2Handlers,
  ...subifHandlers,
  ...routingHandlers,
  ...spanningTreeHandlers,
  ...etherchannelHandlers,
  ...portSecurityHandlers,
  ...errdisableHandlers,
  ...natHandlers,
  ...aclHandlers,
  ...dhcpv6Handlers,
  ...hsrpHandlers,
  ...wlcHandlers,
};

/** Handler id → handler, for every command in the grammar that needs no runtime binding. */
export const HANDLER_REGISTRY: Record<string, CommandHandler> = {
  ...execHandlers,
  ...configHandlers,
  ...showHandlers,
  ...pcHandlers,
  ...hostHandlers,
  ...hostNetHandlers,
  ...serialHandlers,
  ...switchportHandlers,
  ...wirelessHandlers,
  ...ipv6Handlers,
  ...dhcpHandlers,
  ...dnsHandlers,
  ...servicesHandlers,
  ...transportHandlers,
  ...tracerouteHandlers,
  ...lineAuthHandlers,
  ...P2_HANDLER_REGISTRY,
};
