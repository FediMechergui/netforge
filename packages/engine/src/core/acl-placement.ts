/**
 * core/acl-placement.ts — the ACL placement advisor and the impact preview (ARCHITECTURE-P3C §7 W1a core, §8.2 [S23]).
 *
 * Pure helpers for the ACL workbench's lint badges (W3b web-inspector) and `accept.p3c.acl-advisor`. The caller (the
 * worker or a test) describes one binding of a list on one router and the traffic around it; nothing here reads a
 * simulation:
 *   • `sources`: hosts whose traffic reaches the router, each with the router interface it arrives on (`ingress`);
 *   • `destinations`: the places the router forwards to, each with the interface it leaves by (`egress`, from the
 *     router's RIB; `core/lpm` `lpmRows` is the usual way to find it).
 * A source's packets to a destination cross the router when the two interfaces differ.
 *
 * Findings (original wording; the classic CCNA placement rules, spec §2.3 "placement guidance"):
 *   • 'standard-near-source' (warning): a standard list applied inbound where sources it denies arrive. A standard
 *     list reads the source address only, so those sources lose every destination behind the router, not just the one
 *     the list was written for; the finding names the destinations they also cut. Standard lists belong near the
 *     destination (outbound on the interface toward it).
 *   • 'extended-near-destination' (info): an extended list applied outbound that denies traffic arriving from other
 *     interfaces: the denied packets have already crossed the network. Extended lists belong near the source (inbound
 *     on the interface the traffic arrives on).
 * `aclImpact` compares two versions of a list (a draft edit) over a set of flows and lists the flows whose decision
 * changes. An absent list (undefined) permits everything, as an undefined list bound to an interface does.
 *
 * Pure: no module state; outputs keep the input order.
 */
import type { Ipv4Address } from '../contracts/addr.js';
import type { PacketTuple } from '../contracts/process.js';
import { evaluateAcl, wildcardMatches, type AclAction, type AclList } from './acl.js';

/** @since P3c [S23] A host whose traffic reaches the router, and the router interface it arrives on. */
export interface AclPlacementSource {
  readonly label: string;
  readonly address: Ipv4Address;
  readonly ingress: string;
}

/** @since P3c [S23] A destination the router forwards to, and the router interface it leaves by. */
export interface AclPlacementDestination {
  readonly label: string;
  readonly address: Ipv4Address;
  readonly egress: string;
}

/** @since P3c [S23] One binding of a list on a router, and the traffic around it. */
export interface AclPlacementInput {
  readonly list: Pick<AclList, 'name' | 'type' | 'entries'>;
  readonly iface: string;
  readonly dir: 'in' | 'out';
  readonly sources: readonly AclPlacementSource[];
  readonly destinations: readonly AclPlacementDestination[];
}

/** @since P3c [S23] The advisor's finding codes. */
export type AclPlacementCode = 'standard-near-source' | 'extended-near-destination';

/** @since P3c [S23] One finding of `aclPlacementFindings`. */
export interface AclPlacementFinding {
  readonly code: AclPlacementCode;
  readonly severity: 'warning' | 'info';
  readonly list: string;
  readonly iface: string;
  readonly dir: 'in' | 'out';
  /** The labels of the sources the list denies at this binding, in input order. */
  readonly sources: readonly string[];
  /**
   * 'standard-near-source': every destination those sources lose through the router (input order);
   * 'extended-near-destination': the destinations behind `iface` the denied traffic was going to.
   */
  readonly destinations: readonly string[];
  readonly text: string;
}

const IPPROTO_IP_PROBE = 0;

function probe(src: Ipv4Address, dst: Ipv4Address): PacketTuple {
  return { family: 4, proto: IPPROTO_IP_PROBE, src, dst };
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** True when an explicit deny entry of an extended list names the pair's addresses (whatever its protocol or ports). */
function deniesPair(list: Pick<AclList, 'entries'>, src: Ipv4Address, dst: Ipv4Address): boolean {
  return list.entries.some(({ entry: e }) =>
    e.kind === 'extended' && e.action === 'deny'
    && wildcardMatches(src, e.source.address, e.source.wildcard)
    && wildcardMatches(dst, e.destination.address, e.destination.wildcard));
}

/**
 * @since P3c [S23] The placement findings for one binding (see the module header). A standard list is evaluated on
 * the source address alone; an extended list "denies a pair" when one of its explicit deny entries names both
 * addresses (whatever protocol or ports it names; the implicit deny is not a finding).
 */
export function aclPlacementFindings(input: AclPlacementInput): AclPlacementFinding[] {
  const { list, iface, dir } = input;
  const out: AclPlacementFinding[] = [];
  if (list.type === 'standard' && dir === 'in') {
    const denied = input.sources.filter((s) => s.ingress === iface && evaluateAcl(list, probe(s.address, s.address)).action === 'deny');
    const cut = input.destinations.filter((d) => d.egress !== iface);
    if (denied.length > 0 && cut.length > 0) {
      const sources = denied.map((s) => s.label);
      const destinations = cut.map((d) => d.label);
      out.push({
        code: 'standard-near-source',
        severity: 'warning',
        list: list.name,
        iface,
        dir,
        sources,
        destinations,
        text: `Standard list ${list.name} is applied inbound on ${iface}, next to the sources it denies. A standard list reads only the source address, so ${listWords(sources)} also ${sources.length === 1 ? 'loses' : 'lose'} ${listWords(destinations)}. Apply it outbound on the interface toward the destination you want to protect.`,
      });
    }
  } else if (list.type === 'extended' && dir === 'out') {
    const sources: string[] = [];
    const destinations: string[] = [];
    for (const d of input.destinations) {
      if (d.egress !== iface) continue;
      for (const s of input.sources) {
        if (s.ingress === iface) continue;
        if (!deniesPair(list, s.address, d.address)) continue;
        if (!sources.includes(s.label)) sources.push(s.label);
        if (!destinations.includes(d.label)) destinations.push(d.label);
      }
    }
    if (sources.length > 0) {
      const ordered = input.sources.filter((s) => sources.includes(s.label)).map((s) => s.label);
      out.push({
        code: 'extended-near-destination',
        severity: 'info',
        list: list.name,
        iface,
        dir,
        sources: ordered,
        destinations,
        text: `Extended list ${list.name} is applied outbound on ${iface}, so the traffic it denies from ${listWords(ordered)} crosses the network before it is dropped. Apply it inbound on the interface where that traffic arrives.`,
      });
    }
  }
  return out;
}

/** @since P3c [S23] A flow the impact preview evaluates. */
export interface AclImpactFlow {
  readonly id: string;
  readonly tuple: PacketTuple;
}

/** @since P3c [S23] A list's verdict on one flow (`seq` null = the implicit deny, or no list: permitted). */
export interface AclImpactVerdict {
  readonly action: AclAction;
  readonly seq: number | null;
}

/** @since P3c [S23] A flow whose verdict changes between two versions of a list. */
export interface AclImpactChange {
  readonly id: string;
  readonly before: AclImpactVerdict;
  readonly after: AclImpactVerdict;
}

function verdict(list: Pick<AclList, 'type' | 'entries'> | undefined, t: PacketTuple): AclImpactVerdict {
  if (list === undefined) return { action: 'permit', seq: null };
  const d = evaluateAcl(list, t);
  return { action: d.action, seq: d.seq };
}

/**
 * @since P3c [S23] The impact preview of a draft edit: the flows (input order) whose action differs between `before`
 * and `after`. A flow decided by another entry with the same action is not a change. An undefined version permits
 * everything (an undefined list bound to an interface).
 */
export function aclImpact(
  before: Pick<AclList, 'type' | 'entries'> | undefined,
  after: Pick<AclList, 'type' | 'entries'> | undefined,
  flows: readonly AclImpactFlow[],
): AclImpactChange[] {
  const out: AclImpactChange[] = [];
  for (const f of flows) {
    const b = verdict(before, f.tuple);
    const a = verdict(after, f.tuple);
    if (a.action !== b.action) out.push({ id: f.id, before: b, after: a });
  }
  return out;
}
