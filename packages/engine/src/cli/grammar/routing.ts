/**
 * cli/grammar/routing.ts — the P2 routing switches (ARCHITECTURE-P2 §5.2, D2, §3.5; §7 W2 cli): `ip routing` /
 * `no ip routing` (one `bothForms` slot: each form is stored as typed, so a multilayer switch whose P2 profile
 * replayed `no ip routing` keeps `ip routing` across export and reload) and [S7] `ip proxy-arp` / `no ip proxy-arp`
 * on a routed interface (a stored negation: only `no ip proxy-arp` is stored; with no line the arp daemon takes the
 * profile default — on in a P2 world, off in P1).
 *
 * The static-route forms of §5.2 (`ip route <net> <mask> <nh>|<if> [<nh>] [<ad>] [permanent]`, `ipv6 route <p/len>
 * <nh>|<if> [<nh>] [<ad>]`) extend the P1 specs in config-global.ts and ipv6.ts under their existing handler ids.
 * Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { L3_ROLES } from '../../contracts/catalog.js';
import { NFOS_ONLY } from './core-exec.js';

/** Handler ids of the routing fragment. Never rename. */
export const ROUTING_HANDLERS = {
  configIpRouting: 'config.ip-routing',
  ifIpProxyArp: 'if.ip-proxy-arp', // [S7]
} as const;

const H = ROUTING_HANDLERS;

/** The routing command table. */
export const ROUTING_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'routing'],
    mode: 'config',
    privilege: 15,
    help: 'Forward IPv4 packets between interfaces (no ip routing switches forwarding off)',
    handler: H.configIpRouting,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P2',
    objectives: ['CCNA2.1.1'],
  },
  // [S7] ── proxy ARP ──────────────────────────────────────────────────────────────────────────────────────────
  {
    path: ['ip', 'proxy-arp'],
    mode: 'config-if',
    privilege: 15,
    help: 'Answer ARP requests for hosts this device can route to (no ip proxy-arp switches it off)',
    handler: H.ifIpProxyArp,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    portRequires: { roles: L3_ROLES },
    since: 'P2',
    objectives: ['CCNA2.1.1'],
  },
  // [S7] ── end ────────────────────────────────────────────────────────────────────────────────────────────────
]);
