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
 */
import { networkOf, type Ipv4Address } from '../contracts/addr.js';
import type { PortRole } from '../contracts/catalog.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import { OSPF_ALL_DROUTERS, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { routeKey } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { OSPF_PACKET, ospfPacketText } from '../pdu/codecs/ospf.js';
import { ipRoutingSwitchedOff } from './ipv4.js';
import {
  isOspfPassive,
  ospfEnabledInterfaces,
  ospfIfacePriority,
  ospfIfaceTimers,
  ospfNetworkType,
  readOspfConfig,
  selectOspfRouterId,
  type OspfConfig,
} from './ospf/config.js';
import { ospfInterfaceCost, routingBandwidthKbps } from './ospf/cost.js';
import { createOspfEngine, num, OSPF_DEBUG, OSPF_PROCESS, str, type IfaceWant, type Out } from './ospf/engine.js';
import { sortedLsdb } from './ospf/lsdb.js';

// The daemon's public constants live with the engine since P3c W1a (zero-diff refactor) and are re-exported here.
export {
  OSPF_DEBUG,
  OSPF_DSCP,
  OSPF_MAXAGE_SWEEP_NS,
  OSPF_PROCESS,
  OSPF_SELF_WAR_MAX_COPIES,
  OSPF_SELF_WAR_WINDOW_NS,
  OSPF_SPF_DELAY_NS,
  OSPF_SPF_HOLD_NS,
} from './ospf/engine.js';

/** @since P3 Port roles OSPF can run on (D7). */
export const OSPF_PORT_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'svi', 'virtual', 'subif', 'tunnel'] as PortRole[]);

const NAME = OSPF_PROCESS;
const ALL_DROUTERS: Ipv4Address = OSPF_ALL_DROUTERS;

/** @since P3 The OSPFv2 daemon (the module header). */
export function createOspf(): Process {
  const eng = createOspfEngine({ resync: (ctx, out) => resync(ctx, out) });

  // ── process lifecycle and resync ──────────────────────────────────────────

  function hasRouterOspf(ctx: ProcessCtx): boolean {
    return ctx.config.root.children.some((c) => c.key === 'router' && c.args[0] === 'ospf');
  }

  function wants(ctx: ProcessCtx, c: OspfConfig): IfaceWant[] {
    const p = c.process;
    if (p === undefined) return [];
    const cands: { port: PortId; address?: Ipv4Address }[] = [];
    for (const [id, view] of ctx.ports) {
      if (!OSPF_PORT_ROLES.includes(view.role)) continue;
      const a = view.l3.ipv4;
      cands.push(a !== undefined ? { port: id, address: a.address } : { port: id });
    }
    const out: IfaceWant[] = [];
    for (const e of ospfEnabledInterfaces(c, cands)) {
      const view = ctx.ports.get(e.port)!;
      const icfg = c.interfaces.get(e.port);
      const role = view.role;
      const parent = view.spec.parent !== undefined ? ctx.ports.get(view.spec.parent) : undefined;
      const speedBps = role === 'subif' ? (parent?.speedBps ?? parent?.spec.speedBps) : (view.speedBps ?? view.spec.speedBps);
      const bw = routingBandwidthKbps({ role, ...(speedBps !== undefined ? { speedBps } : {}), ...(icfg?.bandwidthKbps !== undefined ? { configuredKbps: icfg.bandwidthKbps } : {}) });
      const { cost, costSource } = ospfInterfaceCost({ ...(icfg?.cost !== undefined ? { configuredCost: icfg.cost } : {}), referenceMbps: p.referenceBandwidthMbps, bandwidthKbps: bw });
      const timers = ospfIfaceTimers(icfg);
      const passive = isOspfPassive(p, e.port);
      const a = view.l3.ipv4;
      const w: IfaceWant = {
        port: e.port,
        area: e.area,
        role,
        networkType: ospfNetworkType(role, icfg?.networkType),
        cost,
        costSource,
        priority: ospfIfacePriority(icfg),
        helloS: timers.helloS,
        deadS: timers.deadS,
        passive,
        silent: passive || role === 'virtual',
        up: view.operUp && a !== undefined,
        ...(a !== undefined ? { address: a.address, prefixLen: a.prefixLen } : {}),
      };
      out.push(w);
    }
    return out;
  }

  function resync(ctx: ProcessCtx, out: Out): void {
    const c = readOspfConfig(ctx.config);
    const prevMaximumPaths = eng.cfg?.process?.maximumPaths;
    eng.cfg = c;
    const p = c.process;
    if (p === undefined || ipRoutingSwitchedOff(ctx)) {
      eng.stop(ctx, out, p === undefined ? 'no router ospf' : 'ip routing is switched off');
      eng.noRidLogged = false;
      return;
    }
    if (eng.proc !== undefined && eng.proc.pid !== p.pid) eng.stop(ctx, out, `process ${eng.proc.pid} replaced by ${p.pid}`);
    if (eng.proc === undefined) {
      const ports: { role: PortRole; operUp: boolean; address?: Ipv4Address }[] = [];
      let anyAddress = false;
      for (const view of ctx.ports.values()) {
        const a = view.l3.ipv4?.address;
        if (a !== undefined) anyAddress = true;
        ports.push(a !== undefined ? { role: view.role, operUp: view.operUp, address: a } : { role: view.role, operUp: view.operUp });
      }
      const pick = selectOspfRouterId(p.routerId, ports);
      if (pick === undefined) {
        if (!anyAddress && !eng.noRidLogged) {
          eng.noRidLogged = true;
          const message = CLI_MESSAGES.ospfNoRouterId.replace('{pid}', String(p.pid));
          eng.debug(ctx, OSPF_DEBUG.adj, message, { pid: p.pid });
          out.actions.push({ type: 'log', severity: 4, facility: 'OSPF', message });
        }
        return;
      }
      eng.start(ctx, p, pick.routerId, pick.source);
    } else if (eng.lastSpfAt !== undefined && prevMaximumPaths !== undefined && p.maximumPaths !== prevMaximumPaths) {
      // `maximum-paths` changes no LSA, only how many equal-cost paths each route keeps: recompute (the SPF throttle)
      eng.scheduleSpf(ctx, out, `maximum-paths changed to ${p.maximumPaths}`);
    }
    // interfaces
    eng.reconcile(ctx, out, wants(ctx, c));
    syncWatch(ctx, out);
  }

  function syncWatch(ctx: ProcessCtx, out: Out): void {
    const keys: string[] = [];
    if (eng.proc !== undefined && eng.cfg?.process?.defaultOriginate !== undefined) keys.push('0.0.0.0/0');
    if (eng.proc !== undefined) {
      for (const i of eng.ordered(ctx)) {
        const a = ctx.ports.get(i.port)?.l3.ipv4;
        if (a !== undefined && (a.origin === 'dhcp' || a.origin === 'apipa')) keys.push(routeKey(networkOf(a.address, a.prefixLen), a.prefixLen));
      }
    }
    if (keys.length === eng.watchKeys.length && keys.every((k, n) => k === eng.watchKeys[n])) return;
    eng.watchKeys = keys;
    if (!keys.includes('0.0.0.0/0')) eng.haveDefault = false;
    out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, keys } });
  }

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return hasRouterOspf(ctx) ? eng.armResync() : [];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return eng.run(ctx, (out) => {
        const ip = pdu.layer('ipv4');
        const o = pdu.layer('ospf');
        if (ip === undefined || o === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: 'not an OSPF packet', port });
          return;
        }
        if (o.fields.checksumValid === false) {
          out.actions.push({ type: 'drop', pdu, reason: 'bad-checksum', detail: o.error ?? 'OSPF checksum mismatch', port });
          return;
        }
        const i = eng.ifaces.get(port);
        if (eng.proc === undefined || i === undefined || i.state === 'down' || i.silent || i.state === 'loopback') {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF does not run on ${port}${i?.silent === true ? ' (passive)' : ''}`, port });
          return;
        }
        const src = str(ip.fields.src);
        const dst = str(ip.fields.dst);
        const type = num(o.fields.type);
        if (src === i.address) {
          out.actions.push({ type: 'consume', pdu });
          return;
        }
        if (num(o.fields.version) !== 2) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF version ${num(o.fields.version)} is not spoken here`, port });
          return;
        }
        if (dst === ALL_DROUTERS && i.state !== 'dr' && i.state !== 'backup') {
          out.actions.push({ type: 'drop', pdu, reason: 'not-for-me', detail: `${port} is neither DR nor BDR (AllDRouters)`, port });
          return;
        }
        const lsas = pdu.layers.filter((l) => l.proto === 'ospf-lsa');
        eng.debug(ctx, OSPF_DEBUG.packet, `${port}: received ${ospfPacketText(type)} from ${str(o.fields.routerId)} (${src})${lsas.length > 0 ? `, ${lsas.length} LSAs` : ''} (pdu ${pdu.id})`, { port, from: src, type, pdu: pdu.id });
        if (type === OSPF_PACKET.hello) {
          eng.rxHello(ctx, out, i, pdu, src, o.fields);
          return;
        }
        if (str(o.fields.area) !== i.area) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF area ${str(o.fields.area)} does not match ${port}'s area ${i.area}`, port });
          return;
        }
        const n = i.nbrs.get(str(o.fields.routerId));
        if (n === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `no OSPF neighbour ${str(o.fields.routerId)} on ${port}`, port });
          return;
        }
        switch (type) {
          case OSPF_PACKET.dbd:
            eng.rxDbd(ctx, out, i, n, pdu, o.fields, lsas);
            return;
          case OSPF_PACKET.lsr:
            eng.rxLsr(ctx, out, i, n, pdu, o.fields);
            return;
          case OSPF_PACKET.lsu:
            eng.rxLsu(ctx, out, i, n, pdu, lsas);
            return;
          case OSPF_PACKET.lsack:
            eng.rxAck(ctx, out, i, n, pdu, lsas);
            return;
          default:
            out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `unknown OSPF packet type ${type}`, port });
        }
      });
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      return eng.run(ctx, (out) => eng.onTimerKey(ctx, out, key));
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      // `no router ospf <pid>` destroys the running process at once (D7: the router id is chosen at process start), so a
      // section removed and re-created in one instant starts a NEW process that picks its id again, never inheriting the
      // deleted process's id; the coalesced resync then reconciles as usual (W5 fix, exposed by lab 07). Only the running
      // process's own section counts: removing another `router ospf` section leaves the running process alone.
      if (
        eng.proc !== undefined &&
        delta.op === 'unset' &&
        delta.context.length === 0 &&
        delta.line[0] === 'router' &&
        delta.line[1] === 'ospf' &&
        Number(delta.line[2]) === eng.proc.pid
      ) {
        return [...eng.run(ctx, (out) => eng.stop(ctx, out, 'no router ospf')), ...eng.armResync()];
      }
      if (eng.proc === undefined && !hasRouterOspf(ctx)) return [];
      return eng.armResync();
    },

    onLinkChange(ctx: ProcessCtx): Action[] {
      if (eng.proc === undefined && !hasRouterOspf(ctx)) return [];
      return eng.armResync();
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind !== 'ospf.clear') return [];
      return eng.run(ctx, (out) => {
        if (eng.proc === undefined) {
          resync(ctx, out);
          return;
        }
        const configured = eng.cfg?.process?.routerId;
        if (configured !== undefined && configured !== eng.proc.routerId) {
          // the router id changes: flush this router's LSAs first, while its adjacencies still carry them
          for (const row of sortedLsdb(eng.lsdb.values())) if (row.advRouter === eng.proc.routerId && row.maxAge !== true) eng.flushSelf(ctx, out, row, 'router ID changes');
          eng.finish(ctx, out);
        }
        eng.stop(ctx, out, 'clear ip ospf process');
        resync(ctx, out);
      });
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'ipv4.ribChanged' || eng.proc === undefined) return [];
      return eng.run(ctx, (out) => {
        if (ev.key === '0.0.0.0/0') {
          const has = ev.row !== undefined && ev.row.source !== 'O';
          if (has !== eng.haveDefault) {
            eng.haveDefault = has;
            eng.debug(ctx, OSPF_DEBUG.spf, `default route ${has ? 'present' : 'gone'}: ${eng.cfg?.process?.defaultOriginate === undefined ? 'not advertised' : has || eng.cfg.process.defaultOriginate === 'always' ? 'advertised' : 'no longer advertised'}`, { has });
            out.originate = true;
          }
        } else if (ev.key !== undefined) {
          out.actions.push(...eng.armResync());
        }
      });
    },

    onShutdown(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return eng.stateSnapshot();
    },

    debugEvents(): readonly DebugEvent[] {
      return eng.debugEvents();
    },
  };
}
