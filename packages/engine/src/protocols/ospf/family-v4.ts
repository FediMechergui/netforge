/**
 * protocols/ospf/family-v4.ts — the OSPFv2 family of the shared OSPF engine (ARCHITECTURE-P3C D7 [S6], §7 W1c: the
 * zero-diff refactor, part 2 of 2). Everything the engine (protocols/ospf/engine.ts) does not know about IPv4 and
 * version 2, moved here unchanged from the v2 daemon and the engine of part 1:
 *
 *   • packets: `[ipv4 {src, dst, ttl 1, protocol 89, dscp 48, id}, ospf {version 2, type, routerId, area, …}]`, sent
 *     with `ipv4.send {iface, nextHop: dst}`; the IP identification counter is per daemon instance;
 *   • the hello body (mask, intervals, options E, priority, DR/BDR addresses, neighbours) and its checks
 *     (protocols/ospf/hello-check.ts, mask and subnet on broadcast networks);
 *   • the groups 224.0.0.5/6 (`ipv4.group`), the LSA forms of protocols/ospf/lsdb.ts (types 1, 2, 5; scope = the area
 *     or 'as'), the self-originated bodies of protocols/ospf/originate.ts and the routes of protocols/ospf/routes.ts
 *     in ONE `ipv4.routes` batch per SPF;
 *   • the `ospf-interfaces`, `ospf-neighbors` and `ospf-lsdb` rows;
 *   • the daemon half: `router ospf <pid>`, the router id choice, which interfaces run (`IfaceWant`), the RIB watch of
 *     `default-information originate` and of DHCP/APIPA-learned subnets (`ipv4.ribWatch`, `ipv4.ribChanged`).
 *
 * The behaviour is protocols/ospf.ts's module header.
 */
import { ipv4ToU32, networkOf, prefixLenToMask, type Ipv4Address } from '../../contracts/addr.js';
import type { PortRole } from '../../contracts/catalog.js';
import { CLI_MESSAGES } from '../../contracts/cli.js';
import type { ConfigDelta } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import { IPPROTO_OSPF, OSPF_ALL_DROUTERS, OSPF_ALL_ROUTERS, type FieldValue, type LayerSpec, type Pdu } from '../../contracts/pdu.js';
import type { Action, ProcessCtx } from '../../contracts/process.js';
import { ospfNbrKey, routeKey, type OspfInterfaceRow, type OspfLsaRow, type OspfNeighborRow, type RouteRow } from '../../contracts/tables.js';
import type { ProcessEvent } from '../../contracts/transport.js';
import { lsaChecksumAndLength } from '../../core/ospf-lsa.js';
import { ospfPacketText } from '../../pdu/codecs/ospf.js';
import { ipRoutingSwitchedOff } from '../ipv4.js';
import { OSPF_AUTH_NONE, ospfAuthCheck, ospfAuthOf, ospfAuthType, ospfSealLayers, type OspfAuth } from './auth.js';
import {
  isOspfPassive,
  ospfEnabledInterfaces,
  ospfIfacePriority,
  ospfIfaceTimers,
  ospfNetworkType,
  readOspfConfig,
  selectOspfRouterId,
  type OspfConfig,
} from './config.js';
import { ospfInterfaceCost, routingBandwidthKbps } from './cost.js';
import { OSPF_NO_DR } from './dr.js';
import { num, OSPF_DEBUG, OSPF_PROCESS, str, type Iface, type IfaceWant, type Nbr, type OspfAdmit, type OspfEngine, type OspfFamily, type OspfLsaOps, type OspfOriginView, type OspfPacketIn, type Out, type Proc } from './engine.js';
import { checkOspfHello, OSPF_OPTION_E } from './hello-check.js';
import {
  isOspfLsaType,
  lsaBodyEqual,
  lsaHeaderLayerOf,
  lsaKeyOf,
  lsaLayerOf,
  lsaRowOf,
  lsaScopeOf,
  lsaText,
  lsaWireOf,
  lsdbForArea,
  lsrEntryOf,
  OSPF_OPTIONS,
  parseLsrEntries,
  sortedLsdb,
  wireHeaderLayerOf,
  type OspfLsaBody,
} from './lsdb.js';
import { ospfNeighborRole } from './nsm.js';
import { defaultExternalBody, networkLsaBody, routerLsaBody, type OriginIface } from './originate.js';
import { computeOspfRoutes, ospfRouteText } from './routes.js';

/** @since P3 The DSCP of every OSPF packet (D7: the classic TOS 0xc0). */
export const OSPF_DSCP = 48;

/** @since P3 Port roles OSPF can run on (D7). */
export const OSPF_PORT_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'svi', 'virtual', 'subif', 'tunnel'] as PortRole[]);

const NAME = OSPF_PROCESS;

/** @since P3c The OSPFv2 LSA forms (protocols/ospf/lsdb.ts): types 1, 2 and 5; scope = the area, or 'as' for type 5. */
export const OSPF_V4_LSA: OspfLsaOps = Object.freeze({
  proto: 'ospf-lsa',
  wireOf: lsaWireOf,
  isKnownType: isOspfLsaType,
  scopeOf: (type: number, area: string) => lsaScopeOf(type, area),
  forIface: (rows: Iterable<OspfLsaRow>, i: Iface) => lsdbForArea(rows, i.area),
  floodsOn: (scope: string, i: Iface) => scope === 'as' || scope === i.area,
  sorted: (rows: Iterable<OspfLsaRow>) => sortedLsdb(rows),
  layerOf: lsaLayerOf,
  headerLayerOf: lsaHeaderLayerOf,
  wireHeaderLayerOf,
  rowOf: lsaRowOf,
  selfRowOf(key: string, scope: string, body: OspfLsaBody, seq: number, now: number): OspfLsaRow {
    const content = { ...body, seq };
    const { checksum, length } = lsaChecksumAndLength(content);
    const row: OspfLsaRow = {
      key,
      scope,
      type: body.type,
      lsid: body.lsid,
      advRouter: body.advRouter,
      seq,
      ageAtInstall: 0,
      installedAt: now,
      checksum,
      length,
      options: body.options,
      self: true,
      updatedAt: now,
    };
    if (body.flags !== undefined) row.flags = { ...body.flags };
    if (body.links !== undefined) row.links = body.links.map((l) => ({ ...l }));
    if (body.mask !== undefined) row.mask = body.mask;
    if (body.attached !== undefined) row.attached = [...body.attached];
    if (body.metric !== undefined) row.metric = body.metric;
    if (body.external !== undefined) row.external = { ...body.external };
    return row;
  },
  bodyEqual: lsaBodyEqual,
  text: lsaText,
  requestEntryOf: lsrEntryOf,
  parseRequests: parseLsrEntries,
  routerType: 1,
});

/** @since P3c The OSPFv2 family (the module header): one instance per daemon instance. */
export function createOspfFamilyV4(): OspfFamily {
  let ipId = 0;
  /** [S5] The authentication of every running interface, resolved at each resync (protocols/ospf/auth.ts). */
  const auths = new Map<PortId, OspfAuth>();
  const authOf = (port: PortId): OspfAuth => auths.get(port) ?? OSPF_AUTH_NONE;

  // ── the daemon half: configuration, interfaces, RIB watch ───────────────────

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
        // [C7] a tunnel keeps announcing its port MTU (a listed fidelity gap, ARCHITECTURE-P3C D7)
        ...(icfg?.ipMtu !== undefined && role !== 'tunnel' ? { ipMtu: icfg.ipMtu } : {}),
        ...(icfg?.mtuIgnore === true ? { mtuIgnore: true } : {}),
      };
      out.push(w);
    }
    return out;
  }

  function resync(eng: OspfEngine, ctx: ProcessCtx, out: Out): void {
    const c = readOspfConfig(ctx.config);
    const prevMaximumPaths = eng.cfg?.process?.maximumPaths;
    eng.cfg = c;
    const p = c.process;
    if (p === undefined || ipRoutingSwitchedOff(ctx)) {
      eng.stop(ctx, out, p === undefined ? 'no router ospf' : 'ip routing is switched off');
      eng.noRidLogged = false;
      auths.clear();
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
    // interfaces (their authentication first: reconcile may send hellos)
    const wanted = wants(ctx, c);
    auths.clear();
    for (const w of wanted) {
      const auth = ospfAuthOf(c, w.port, w.area);
      if (auth.mode !== 'none') auths.set(w.port, auth);
    }
    eng.reconcile(ctx, out, wanted);
    syncWatch(eng, ctx, out);
  }

  function syncWatch(eng: OspfEngine, ctx: ProcessCtx, out: Out): void {
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
    out.actions.push(watchAction(keys));
  }

  function watchAction(keys: readonly string[]): Action {
    return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, keys } };
  }

  // ── origination ───────────────────────────────────────────────────────────

  /** The OSPF interfaces as the router-LSA sees them. */
  function originIfaces(ifaces: readonly Iface[]): OriginIface[] {
    return ifaces.map((i) => {
      const full = [...i.nbrs.values()].filter((n) => n.state === 'full').sort(byRid).map((n) => ({ routerId: n.routerId, address: n.address }));
      const o: OriginIface = { port: i.port, area: i.area, networkType: i.networkType, state: i.state, cost: i.cost, dr: i.dr, fullNeighbors: full };
      return i.address !== undefined && i.prefixLen !== undefined ? { ...o, address: i.address, prefixLen: i.prefixLen } : o;
    });
  }

  function desiredSelf(v: OspfOriginView): Map<string, OspfLsaBody> {
    const out = new Map<string, OspfLsaBody>();
    const rid = v.proc.routerId;
    const oifs = originIfaces(v.ifaces);
    const areas = v.areas;
    const cfg = v.cfg;
    const external = cfg?.process?.defaultOriginate !== undefined && (cfg.process.defaultOriginate === 'always' || v.haveDefault);
    for (const area of areas) {
      const body = routerLsaBody(rid, area, oifs, { areaBorder: areas.length > 1, asbr: external });
      const key = lsaKeyOf(area, 1, rid, rid);
      const had = v.lsdb.get(key);
      if (body.links.length > 0 || (had !== undefined && had.maxAge !== true)) out.set(key, body);
    }
    for (const o of oifs) {
      const body = networkLsaBody(rid, o);
      if (body !== undefined) out.set(lsaKeyOf(o.area, 2, body.lsid, rid), body);
    }
    if (external) out.set(lsaKeyOf('as', 5, '0.0.0.0', rid), defaultExternalBody(rid));
    return out;
  }

  // ── the family ────────────────────────────────────────────────────────────

  return {
    name: NAME,
    version: 2,
    machines: { iface: 'ospf-if', nbr: 'ospf-nbr' },
    tables: { interfaces: 'ospf-interfaces', neighbors: 'ospf-neighbors', lsdb: 'ospf-lsdb' },
    allRouters: OSPF_ALL_ROUTERS,
    allDRouters: OSPF_ALL_DROUTERS,
    dbdOptions: OSPF_OPTIONS,
    lsa: OSPF_V4_LSA,

    packetLayers(proc: Proc, i: Iface, dst: string, type: number, fields: Record<string, FieldValue>): LayerSpec[] {
      ipId = (ipId + 1) & 0xffff;
      return [
        { proto: 'ipv4', fields: { src: i.address!, dst, ttl: 1, protocol: IPPROTO_OSPF, dscp: OSPF_DSCP, id: ipId } },
        { proto: 'ospf', fields: { version: 2, type, routerId: proc.routerId, area: i.area, ...fields } },
      ];
    },

    seal(ctx: ProcessCtx, _proc: Proc, i: Iface, layers: readonly LayerSpec[]): readonly LayerSpec[] {
      const auth = auths.get(i.port);
      return auth === undefined ? layers : ospfSealLayers(layers, auth, ctx.now);
    },

    authenticate(_ctx: ProcessCtx, i: Iface, pdu: Pdu, p: OspfPacketIn, lastSeq: number | undefined): OspfAdmit {
      const auth = authOf(i.port);
      const o = pdu.layer('ospf');
      if (auth.mode === 'none' && num(p.fields.auType) === 0) return { ok: true };
      const v = ospfAuthCheck(auth, p.fields, o === undefined ? new Uint8Array(0) : pdu.bytes.subarray(o.offset, o.offset + o.length), lastSeq);
      return v.ok ? (v.seq === undefined ? { ok: true } : { ok: true, seq: v.seq }) : { ok: false, text: v.text };
    },

    flowOf(i: Iface, dst: string): string {
      return `ipv4:${i.address}>${dst}:ospf`;
    },

    sendAction(proc: Proc, i: Iface, dst: string, type: number, pdu: Pdu): Action {
      return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, iface: i.port, nextHop: dst, cause: `ospf ${proc.pid} ${ospfPacketText(type)} on ${i.port}` } };
    },

    helloFields(i: Iface, heard: readonly Ipv4Address[]): Record<string, FieldValue> | undefined {
      if (i.address === undefined || i.prefixLen === undefined) return undefined;
      return {
        mask: prefixLenToMask(i.prefixLen),
        helloInterval: i.helloS,
        options: OSPF_OPTIONS,
        priority: i.priority,
        deadInterval: i.deadS,
        dr: i.dr,
        bdr: i.bdr,
        neighbors: heard.join(','),
      };
    },

    checkHello(proc: Proc, i: Iface, f: Readonly<Record<string, FieldValue>>, src: string) {
      if (i.address === undefined || i.prefixLen === undefined) return undefined;
      const hello = {
        routerId: str(f.routerId),
        area: str(f.area),
        src,
        mask: str(f.mask),
        helloS: num(f.helloInterval),
        deadS: num(f.deadInterval),
        options: num(f.options),
        authType: num(f.auType),
      };
      return checkOspfHello(
        { routerId: proc.routerId, area: i.area, networkType: i.networkType, address: i.address, prefixLen: i.prefixLen, helloS: i.helloS, deadS: i.deadS, options: OSPF_OPTION_E, authType: ospfAuthType(authOf(i.port)) },
        hello,
      );
    },

    groupAction(op: 'join' | 'leave', port: PortId, group: string): Action {
      return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op, iface: port, group, owner: NAME } };
    },

    decode(pdu: Pdu) {
      const ip = pdu.layer('ipv4');
      const o = pdu.layer('ospf');
      if (ip === undefined || o === undefined) return undefined;
      return {
        src: str(ip.fields.src),
        dst: str(ip.fields.dst),
        version: num(o.fields.version),
        type: num(o.fields.type),
        routerId: str(o.fields.routerId),
        area: str(o.fields.area),
        checksumValid: o.fields.checksumValid,
        ...(o.error !== undefined ? { error: o.error } : {}),
        fields: o.fields,
        lsas: pdu.layers.filter((l) => l.proto === 'ospf-lsa'),
      };
    },

    desiredSelf,

    isSelf(ctx: ProcessCtx, proc: Proc, ifaces: ReadonlyMap<PortId, Iface>, w): boolean {
      if (w.advRouter === proc.routerId) return true;
      if (w.type !== 2) return false;
      for (const i of ifaces.values()) if (i.address === w.lsid) return true;
      return ctx.ownAddress(w.lsid) !== undefined;
    },

    computeRoutes: computeOspfRoutes,

    routesAction(rows): Action {
      return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: NAME, rows: rows as readonly RouteRow[] } };
    },

    routeText: (r) => ospfRouteText(r as RouteRow),

    watchAction,

    ifRow(ctx: ProcessCtx, proc: Proc, i: Iface): OspfInterfaceRow {
      const row: OspfInterfaceRow = {
        key: i.port,
        port: i.port,
        process: proc.pid,
        routerId: proc.routerId,
        area: i.area,
        networkType: i.networkType,
        state: i.state,
        cost: i.cost,
        costSource: i.costSource,
        priority: i.priority,
        helloS: i.helloS,
        deadS: i.deadS,
        passive: i.passive,
        neighbors: i.nbrs.size,
        adjacent: [...i.nbrs.values()].filter((n) => n.state === 'full').length,
        stateSince: i.stateSince,
        updatedAt: ctx.now,
      };
      if (i.address !== undefined) row.address = i.address;
      if (i.prefixLen !== undefined) row.prefixLen = i.prefixLen;
      if (i.dr !== OSPF_NO_DR) {
        row.drAddress = i.dr;
        if (i.drRid !== undefined) row.dr = i.drRid;
      }
      if (i.bdr !== OSPF_NO_DR) {
        row.bdrAddress = i.bdr;
        if (i.bdrRid !== undefined) row.bdr = i.bdrRid;
      }
      if (i.waitUntil !== undefined) row.waitUntil = i.waitUntil;
      if (i.rejected !== undefined) row.rejected = { ...i.rejected };
      const auth = authOf(i.port);
      if (auth.mode !== 'none') row.auth = auth.mode;
      if (auth.mode === 'md5') row.authKeyId = auth.youngest.id;
      return row;
    },

    nbrRow(ctx: ProcessCtx, i: Iface, n: Nbr): OspfNeighborRow {
      const row: OspfNeighborRow = {
        key: ospfNbrKey(n.port, n.routerId),
        port: n.port,
        routerId: n.routerId,
        address: n.address,
        priority: n.priority,
        state: n.state,
        role: ospfNeighborRole(i.networkType, n.address, i.dr, i.bdr),
        dr: n.declared?.dr ?? OSPF_NO_DR,
        bdr: n.declared?.bdr ?? OSPF_NO_DR,
        stateSince: n.stateSince,
        updatedAt: ctx.now,
      };
      if (n.nbrMaster !== undefined) row.master = n.nbrMaster;
      return row;
    },

    lsdbRow: (row: OspfLsaRow) => row,

    hasSection: hasRouterOspf,

    removesOwnSection(delta: ConfigDelta, pid: number): boolean {
      // `no router ospf <pid>` of the running process (protocols/ospf.ts's module header)
      return delta.op === 'unset' && delta.context.length === 0 && delta.line[0] === 'router' && delta.line[1] === 'ospf' && Number(delta.line[2]) === pid;
    },

    clearKind: 'ospf.clear',

    resync,

    onEvent(eng: OspfEngine, ctx: ProcessCtx, ev: ProcessEvent): Action[] {
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
  };
}

const byRid = (a: { routerId: Ipv4Address }, b: { routerId: Ipv4Address }): number => ipv4ToU32(a.routerId) - ipv4ToU32(b.routerId);
