/**
 * protocols/ospf.ts — the OSPFv2 daemon, single area (ARCHITECTURE-P3 D7–D10, §2.4–§2.6, §3.1, §3.2, §4.1–§4.5, §5.1,
 * §5.8; RFC 2328; §7 W2 ospf). One process per device (`router ospf <pid>`), over the pure modules of protocols/ospf/
 * (config, cost, ism, dr, hello-check, nsm, flood, lsdb, originate, routes) and core/ (ospf-lsa, ospf-spf).
 *
 * Silent unless configured (§4.3): nothing is sent, no table row is written and no timer is armed until `router ospf`
 * is stored; hellos leave only on an enabled, up, non-passive interface with an address.
 *
 * Process. Started at the first resync where a router id can be chosen (D7, `selectOspfRouterId`: `router-id` > the
 * highest up loopback > the highest up interface address); a later `router-id` change is shown as `configuredRouterId`
 * and applied by `clear ip ospf process` (`ospf.clear`) or a reload. With no `router-id` and no interface address at
 * all, the `ospfNoRouterId` log is written once. `no router ospf`, or a stored `no ip routing` (D7), stops the process:
 * neighbours and rows go, the LSDB is cleared and an empty `ipv4.routes` batch withdraws every route. `no router ospf`
 * stops it inside the configuration dispatch itself (not at the coalesced resync), so a section removed and re-created
 * in one instant restarts with a freshly chosen router id.
 *
 * Resync (`resync`, 0 ns, coalesced, after `init`, `onConfig` and `onLinkChange`): the daemon reads the port views after
 * the whole dispatch applied its actions (the stale-view lag of ipv4.ts) and reconciles the process, the enabled
 * interfaces (network lines and `ip ospf <pid> area <a>`, D7) and their parameters (area, network type by role, cost
 * from the routing bandwidth, priority, hello and dead intervals, passive) with what runs.
 *
 * Interfaces (ISM, protocols/ospf/ism.ts). InterfaceUp on an up interface with an address: point-to-point networks go
 * Point-to-point, a loopback Loopback (a /32 host stub), a broadcast interface Waiting (`wait:<if>`, the dead interval,
 * non-periodic) or DROther with priority 0. Every non-passive interface that leaves Down joins 224.0.0.5 and sends a
 * hello at once, then every hello interval (`hello:<if>`, periodic); DR and Backup also join 224.0.0.6. A passive
 * interface (and a loopback) sends nothing, joins nothing and ignores OSPF packets; a passive broadcast interface elects
 * itself at once (no wait: it can have no neighbour; listed in the wave report). The election is
 * protocols/ospf/dr.ts; when an interface's (DR, BDR) pair changes, `dr-hello:<if>` (0 ns, coalesced) sends one hello
 * unless one already left after the change (D9).
 *
 * Neighbours (NSM, protocols/ospf/nsm.ts; key `ospfNbrKey(port, router id)`). A hello that passes the checks
 * (protocols/ospf/hello-check.ts; a refusal sets the interface row's `rejected`, writes an `ip ospf hello` line and
 * drops the packet) creates the neighbour in Init (`dead:<if>:<rid>`, the dead interval, periodic, re-armed by every
 * hello) and arms `hello-reply:<if>` (1 s, non-periodic, coalesced, D9). A hello that lists this router is
 * 2-WayReceived; BackupSeen and NeighborChange follow RFC 2328 §10.5 (`drEventsFromHello`; the election runs at most
 * once per hello). AdjOK? (RFC §10.4) moves 2-Way neighbours to ExStart: the DD sequence of D9, an empty I|M|MS DBD and
 * `rxmt:<if>:<rid>` (5 s, periodic: DBD, LSR, unacknowledged LSAs; ExStart restarts with attempt + 1 after 10
 * retransmissions). The higher router id is master; the exchange, Loading (LSR / LSU) and Full follow RFC §10.6–§10.9;
 * a DBD received from a neighbour in Init is 2-WayReceived first (§3.1 step 7). A neighbour that goes Down (dead,
 * link down, interface removed) loses its row.
 *
 * Packets: `[ipv4 {src, dst, ttl 1, protocol 89, dscp 48}, ospf …]`, sent with `ipv4.send {iface, nextHop: dst}` (D7).
 * Hellos go to 224.0.0.5 (`meta.tag 'ospf-hello'`, background). On a broadcast network DBD, LSR, acknowledgements and
 * retransmissions are unicast to the neighbour; on a point-to-point network every packet goes to 224.0.0.5 (RFC §8.1).
 * Flooding follows protocols/ospf/flood.ts (a non-DR floods to 224.0.0.6, the DR re-floods to 224.0.0.5, the BDR
 * re-floods nothing it received on the segment). Updates are bundled per interface and destination per handler call,
 * LSAs in database order (§4.5); acknowledgements are direct and immediate (D9).
 *
 * LSDB (`ospf-lsdb` rows, protocols/ospf/lsdb.ts). RFC 2328 §13: MinLSArrival (1 s), the newer-instance rules
 * (core/ospf-lsa.ts), install, flood, acknowledge, and an older copy answered with the database copy. A newer copy of a
 * self-originated LSA is installed, then re-originated above it (or flushed when no longer wanted); when such copies
 * keep arriving (another router with the same router id) the re-origination moves to the periodic `self-war:<lsa>` and
 * a log names the conflict once; after OSPF_SELF_WAR_MAX_COPIES such copies within the war window the router stops
 * re-originating that LSA (the other copy stands), so the war's flooding and SPF work drain and `runToIdle` returns
 * (rule 19) even between two routers that are not neighbours. MaxAge LSAs are removed once no retransmission list
 * holds them and no neighbour is exchanging; `maxage` (60 s, periodic, only while LSAs of other routers exist) ages
 * them out; `refresh` (periodic) re-originates every self LSA at 1800 s.
 *
 * Origination (protocols/ospf/originate.ts): the router-LSA of each area, the network-LSA of each segment where this
 * router is DR with a Full neighbour, and the AS-external default of `default-information originate` (D8: while the
 * routing table holds a default route from another source — watched with `ipv4.ribWatch {keys: ['0.0.0.0/0']}` — or
 * always with `always`). MinLSInterval: a first origination is immediate, later ones wait for `lsa-gen:<lsa>` (5 s
 * after the previous one, non-periodic).
 *
 * SPF (D9, D10): `spf` (non-periodic) 5 s after the first change, and not before the last run + 10 s. At expiry it first
 * performs every `lsa-gen` due at or before now, then computes (protocols/ospf/routes.ts over core/ospf-spf.ts) and
 * sends ONE `ipv4.routes {owner: 'ospf', rows}` batch (D8); the trees go to the StateView. Paths through an interface
 * that goes down are withdrawn by ipv4 at link-down, before this SPF (D8).
 *
 * Debug categories (§5.8): 'ip ospf adj' (ISM and NSM transitions through `ctx.transition`, machines 'ospf-if' and
 * 'ospf-nbr', elections), 'ip ospf hello' (hellos and refusals), 'ip ospf flood' (updates, requests, acknowledgements,
 * install, flush), 'ip ospf spf' (runs, reasons, route changes), 'ip ospf packet' (one line per packet sent or
 * received).
 *
 * Tables (rule 20): `ospf-interfaces` (key port; rewritten only when a column changes), `ospf-neighbors` (key
 * port|router id; written on a change of state, role, DR/BDR, priority, address or master), `ospf-lsdb` (one row per
 * LSA instance installed). stateSnapshot(): the `OspfStateView` of contracts/tables.ts (kind 'ospf').
 *
 * Deviations (listed): the hello reply and the DR-change hello (D9); immediate direct acknowledgements; a passive
 * broadcast interface elects itself at once; a deterministic DD sequence number; one process; full SPF only.
 *
 * Code (ARCHITECTURE-P3C D7 [S6], P3c W1a and W1c, zero-diff): this file is the factory only. The adjacency engine and
 * the daemon shell are protocols/ospf/engine.ts (`createOspfProcess`); everything IPv4 and version 2 is the family
 * adapter protocols/ospf/family-v4.ts (`createOspfFamilyV4`), which OSPFv3 mirrors in family-v6.ts.
 */
import type { Process } from '../contracts/process.js';
import { createOspfProcess } from './ospf/engine.js';
import { createOspfFamilyV4 } from './ospf/family-v4.js';

// The daemon's public constants live with the engine and the v2 family since P3c W1a/W1c (zero-diff refactor) and are
// re-exported here.
export {
  OSPF_DEBUG,
  OSPF_MAXAGE_SWEEP_NS,
  OSPF_PROCESS,
  OSPF_SELF_WAR_MAX_COPIES,
  OSPF_SELF_WAR_WINDOW_NS,
  OSPF_SPF_DELAY_NS,
  OSPF_SPF_HOLD_NS,
} from './ospf/engine.js';
export { OSPF_DSCP, OSPF_PORT_ROLES } from './ospf/family-v4.js';

/** @since P3 The OSPFv2 daemon (the module header): the shared engine with the v2 family. */
export function createOspf(): Process {
  return createOspfProcess(createOspfFamilyV4());
}
