/**
 * sim/lab-checks/routing.ts — the P2 routing, translation and standby-group checkers (ARCHITECTURE-P2 §2.10;
 * ARCHITECTURE-P3 D5, §7 W1 sim: moved VERBATIM from sim/lab-checks.ts, proved by `accept.p3.lab-status`). Devices and
 * ports by NAME; a port name resolves like the 'port' kind (long or short form).
 *
 *   route        → the longest-prefix winner for `destination` in `rib` (family 4, default) or `rib6` (family 6),
 *                  `core/lpm*.ts` order; `none: true` passes only when there is no winner, `none: false` only when
 *                  there is one. `network` is `a.b.c.d/len` (or the network address alone); `nextHop` and `iface`
 *                  also match any equal-cost path [S6]; `iface` (a port name) is the EXIT interface: the row's own,
 *                  else the one its next hop is reached through (the next hop's longest match, followed recursively
 *                  at most 8 deep, as forwarding does), so a next-hop static and an exit-interface static both
 *                  answer; `source`, `ad` compare the row. Addresses may be written in any valid form.
 *   nat          → the `nat` rows matching every given field (`kindOf` is the row's `kind`); `minCount` → at least
 *                  that many; otherwise `exists` (default true) → some row matches (or none, when false).
 *   fhrp [S2]    → the `hsrp` row of (iface, group): `state`, `virtualIp`, `priority`, `preempt`.
 *
 * P3 (ARCHITECTURE-P3 §2.10, ruling R18; W2 sim): the widened `route` members, each optional by meaning (absent = the
 * P2 check and detail, byte for byte), each one more expected item of the winner:
 *   metric    → the winner's `metric` equals it;
 *   routeType → 'E2' (the only approved value): the winner is an OSPF external type-2 route (`RouteRow.routeType`);
 *               an IPv6 row has no route type, so it never matches;
 *   minPaths  → the winner has at least that many installed paths (`paths.length` of a multipath row, else 1).
 * A failing one names what was expected and what the winner has, after the P2 items.
 */
import { parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortId } from '../../contracts/ids.js';
import type { LabAssertion } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { HsrpRow, NatRow, Route6Row, RouteRow } from '../../contracts/tables.js';
import { normalizeIpv6 } from '../../core/addr6.js';
import { lpm } from '../../core/lpm.js';
import { lpm6Rows } from '../../core/lpm6.js';
import { PASS, deviceNamed, fail, noDevice, noPort, portNamed, verdict, type Check } from './core.js';

// ── P2: routing, translation, standby groups ─────────────────────────────────

/** Canonical text of an address or `address/len` of `family`, or undefined when it does not parse. */
function canonicalAddr(family: 4 | 6, text: string): string | undefined {
  const slash = text.indexOf('/');
  const addr = slash < 0 ? text.trim() : text.slice(0, slash).trim();
  let canon: string | undefined;
  if (family === 4) {
    const v = parseIpv4(addr);
    canon = v === null ? undefined : u32ToIpv4(v);
  } else {
    canon = normalizeIpv6(addr) ?? undefined;
  }
  if (canon === undefined) return undefined;
  if (slash < 0) return canon;
  const len = text.slice(slash + 1).trim();
  return /^\d{1,3}$/.test(len) ? `${canon}/${Number(len)}` : undefined;
}

/** An IPv4 address an author wrote, in canonical text (kept as written when it does not parse, so it matches nothing). */
function v4Text(text: string | undefined): string | undefined {
  return text === undefined ? undefined : (canonicalAddr(4, text) ?? text);
}

type AnyRoute = RouteRow | Route6Row;

/** Recursion bound of an exit-interface lookup through next hops (the D13 static-route bound). */
const ROUTE_RECURSION_LIMIT = 8;

/** The longest-prefix winner for `dst` on `dev` (`rib` or `rib6`). */
function lpmWinner(dev: DeviceRuntime, family: 4 | 6, dst: string): AnyRoute | undefined {
  if (family === 4) return lpm(dev.tables.rib, dst).winner;
  const rib6 = dev.tables.get<Route6Row>('rib6');
  return rib6 === undefined ? undefined : lpm6Rows(rib6.rows(), dst).winner;
}

/**
 * The exit interfaces of `route`: each path's own interface, else the one its next hop is reached through (the
 * next hop's own longest match, followed recursively as forwarding does, at most ROUTE_RECURSION_LIMIT deep).
 */
function exitInterfaces(dev: DeviceRuntime, family: 4 | 6, route: AnyRoute): PortId[] {
  const out: PortId[] = [];
  const paths = [{ nextHop: route.nextHop, iface: route.iface }, ...(route.paths ?? [])];
  for (const path of paths) {
    let iface = path.iface;
    let hop = path.nextHop;
    let via: AnyRoute = route;
    for (let depth = 0; iface === undefined && hop !== undefined && depth < ROUTE_RECURSION_LIMIT; depth++) {
      const next = lpmWinner(dev, family, hop);
      if (next === undefined || next === via) break;
      iface = next.iface;
      hop = next.nextHop;
      via = next;
    }
    if (iface !== undefined && !out.includes(iface)) out.push(iface);
  }
  return out;
}

/** @since P3 (R18) The installed paths of a route: its multipath `paths` (two or more), else the one it is. */
function pathCount(route: AnyRoute): number {
  const n = route.paths?.length ?? 0;
  return n > 0 ? n : 1;
}

/** `10.3.1.0/24 (S, distance 1, via 10.8.0.2, out GigabitEthernet0/1)` for a detail. */
function routeText(r: AnyRoute, exits: readonly PortId[]): string {
  const via = [r.nextHop === undefined ? '' : `via ${r.nextHop}`, exits.length === 0 ? '' : `out ${exits.join(', ')}`].filter((s) => s !== '').join(', ');
  return `${r.network}/${r.prefixLen} (${r.source}, distance ${r.ad}${via === '' ? '' : `, ${via}`})`;
}

export function checkRoute(sim: Simulation, a: Extract<LabAssertion, { kind: 'route' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const family = a.family ?? 4;
  const dst = canonicalAddr(family, a.destination);
  if (dst === undefined || dst.includes('/')) return fail(`${a.destination} is not an IPv${family} address.`);
  if (family === 6 && dev.tables.get<Route6Row>('rib6') === undefined) return fail(`${a.device} keeps no IPv6 routing table.`);
  const winner = lpmWinner(dev, family, dst);
  if (a.none === true) return winner === undefined ? PASS : fail(`${a.device} still routes ${dst} through ${routeText(winner, exitInterfaces(dev, family, winner))}.`);
  if (winner === undefined) return fail(`${a.device} has no route to ${dst}.`);
  const exits = exitInterfaces(dev, family, winner);
  const problems: string[] = [];
  if (a.source !== undefined && winner.source !== a.source) problems.push(`source ${a.source}`);
  if (a.network !== undefined) {
    const want = canonicalAddr(family, a.network);
    const have = want !== undefined && want.includes('/') ? `${winner.network}/${winner.prefixLen}` : winner.network;
    if (want === undefined || have !== want) problems.push(`network ${a.network}`);
  }
  if (a.nextHop !== undefined) {
    const want = canonicalAddr(family, a.nextHop);
    const hops = [winner.nextHop, ...(winner.paths ?? []).map((p) => p.nextHop)];
    if (want === undefined || !hops.includes(want)) problems.push(`next hop ${a.nextHop}`);
  }
  if (a.iface !== undefined) {
    const port = portNamed(dev, a.iface);
    if (port === undefined) return noPort(a.device, a.iface);
    if (!exits.includes(port.id)) problems.push(`interface ${a.iface}`);
  }
  if (a.ad !== undefined && winner.ad !== a.ad) problems.push(`distance ${a.ad}`);
  // P3 (R18): the widened members, after the P2 ones
  if (a.metric !== undefined && winner.metric !== a.metric) problems.push(`metric ${a.metric} (it has ${winner.metric})`);
  if (a.routeType !== undefined) {
    const type = (winner as Partial<RouteRow>).routeType;
    if (type !== a.routeType) problems.push(`route type ${a.routeType} (it is ${type === undefined ? 'not an external route' : type})`);
  }
  if (a.minPaths !== undefined) {
    const paths = pathCount(winner);
    if (paths < a.minPaths) problems.push(`at least ${a.minPaths} equal-cost paths (it has ${paths})`);
  }
  if (problems.length === 0) return PASS;
  return fail(`${a.device} reaches ${dst} through ${routeText(winner, exits)}; expected ${problems.join(', ')}.`);
}

export function checkNat(sim: Simulation, a: Extract<LabAssertion, { kind: 'nat' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const table = dev.tables.get<NatRow>('nat');
  if (table === undefined) return fail(`${a.device} does not translate addresses.`);
  const insideLocal = v4Text(a.insideLocal);
  const insideGlobal = v4Text(a.insideGlobal);
  const outsideGlobal = v4Text(a.outsideGlobal);
  const matching = table.find(
    (r) =>
      (insideLocal === undefined || r.insideLocal === insideLocal) &&
      (insideGlobal === undefined || r.insideGlobal === insideGlobal) &&
      (outsideGlobal === undefined || r.outsideGlobal === outsideGlobal) &&
      (a.proto === undefined || r.proto === a.proto) &&
      (a.kindOf === undefined || r.kind === a.kindOf),
  );
  const fields = [
    a.proto === undefined ? '' : `proto ${a.proto}`,
    a.kindOf === undefined ? '' : `kind ${a.kindOf}`,
    a.insideLocal === undefined ? '' : `inside local ${a.insideLocal}`,
    a.insideGlobal === undefined ? '' : `inside global ${a.insideGlobal}`,
    a.outsideGlobal === undefined ? '' : `outside global ${a.outsideGlobal}`,
  ].filter((s) => s !== '');
  const what = fields.length === 0 ? 'translations' : `translations with ${fields.join(', ')}`;
  const n = matching.length;
  if (a.minCount !== undefined) {
    return n >= a.minCount ? PASS : fail(`${a.device} holds ${n} ${what}, expected at least ${a.minCount}.`);
  }
  if (n > 0 === (a.exists ?? true)) return PASS;
  return fail(n > 0 ? `${a.device} still holds ${n} ${what}.` : `${a.device} holds no ${what} (${table.size} row${table.size === 1 ? '' : 's'} in all).`);
}

export function checkFhrp(sim: Simulation, a: Extract<LabAssertion, { kind: 'fhrp' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.iface);
  if (port === undefined) return noPort(a.device, a.iface);
  const table = dev.tables.get<HsrpRow>('hsrp');
  if (table === undefined) return fail(`${a.device} runs no standby groups.`);
  const row = table.find((r) => r.iface === port.id && r.group === a.group)[0];
  if (row === undefined) return fail(`${a.device} ${a.iface} has no standby group ${a.group}.`);
  const problems: string[] = [];
  if (a.state !== undefined && row.state !== a.state) problems.push(`is ${row.state}, expected ${a.state}`);
  if (a.virtualIp !== undefined && row.virtualIp !== v4Text(a.virtualIp)) {
    problems.push(`${row.virtualIp === undefined ? 'has no virtual address' : `answers for ${row.virtualIp}`}, expected ${a.virtualIp}`);
  }
  if (a.priority !== undefined && row.priority !== a.priority) problems.push(`has priority ${row.priority}, expected ${a.priority}`);
  if (a.preempt !== undefined && row.preempt !== a.preempt) problems.push(a.preempt ? 'does not preempt' : 'preempts');
  return verdict(`Standby group ${a.group} on ${a.device} ${a.iface}`, problems);
}
