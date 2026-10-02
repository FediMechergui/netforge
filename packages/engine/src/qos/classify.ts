/**
 * qos/classify.ts — the MQC classifier (ARCHITECTURE-P3 D16, §3.0 (a) step 9 and (b) step 10c, §3.5 step 3; §7 W2 qos).
 *
 * The runtime classifies a frame against a compiled policy (`qos/config.ts`) at step 10c (input, on a `deliver` or
 * `subif` verdict, before the tag pop) and at the egress marking points (output). It first reads the frame's
 * facts once (`qosPacketFacts`), then tries the policy's classes in order; the first whose class-map matches wins,
 * and a frame no class matches falls in class-default (the last class).
 *
 * Facts: the first IP layer's DSCP (IPv4 `dscp`, IPv6 `trafficClass ≫ 2`), the first 802.1Q tag's PCP, the IPv4
 * 5-tuple (`core/acl.ts` `tupleOf`, the D12 matcher's input) and the input interface the caller names.
 *
 * Match semantics (§5.4): `match dscp` (IPv4 and IPv6), `match ip precedence` (IPv4: DSCP ≫ 3), `match cos` (a
 * tagged frame; an untagged frame never matches), `match access-group` (permit = match, through `evaluateAcl` over the
 * list compiled with the policy; a deny, the implicit deny, a list that does not exist or a frame without IPv4 do not
 * match; nothing is counted on `acl` rows, §3.5 step 1), `match protocol ip|icmp|tcp|udp` (IPv4), `match
 * input-interface` (the port the frame arrived on; unknown on output without one), `match any`. The values of one
 * line are OR-ed; `match-all` needs every line, `match-any` one. A class-map without lines matches nothing.
 *
 * Pure: no state; never changes the PDU.
 */
import type { PduView } from '../contracts/pdu.js';
import type { PacketTuple } from '../contracts/process.js';
import { evaluateAcl, tupleOf, type AclList } from '../core/acl.js';
import type { QosClassMap, QosMatch, QosPolicy } from './config.js';

/** @since P3 What the classifier reads from a frame (`qosPacketFacts`). */
export interface QosPacketFacts {
  /** The first IP layer: its version, DSCP and (IPv6) whole traffic class. Absent without IP. */
  readonly ip?: { readonly version: 4 | 6; readonly dscp: number; readonly trafficClass?: number };
  /** The PCP of the first 802.1Q tag (absent on an untagged frame). */
  readonly cos?: number;
  /** The IPv4 fields an access list matches (absent unless the first IP layer is IPv4). */
  readonly tuple?: PacketTuple;
  /** The port the frame arrived on (`match input-interface`). */
  readonly inputInterface?: string;
}

function uint(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
}

/** @since P3 Read a frame's QoS facts once; `inputInterface` is the port it arrived on, when known. */
export function qosPacketFacts(pdu: Pick<PduView, 'layers'>, inputInterface?: string): QosPacketFacts {
  let cos: number | undefined;
  let ip: QosPacketFacts['ip'];
  for (const l of pdu.layers) {
    if (cos === undefined && l.proto === 'dot1q') cos = uint(l.fields['pcp'], 7);
    if (l.proto === 'ipv4') {
      ip = { version: 4, dscp: uint(l.fields['dscp'], 63) ?? 0 };
      break;
    }
    if (l.proto === 'ipv6') {
      const tc = uint(l.fields['trafficClass'], 255) ?? 0;
      ip = { version: 6, dscp: tc >> 2, trafficClass: tc };
      break;
    }
  }
  const tuple = ip?.version === 4 ? tupleOf(pdu) : undefined;
  return {
    ...(ip === undefined ? {} : { ip }),
    ...(cos === undefined ? {} : { cos }),
    ...(tuple === undefined ? {} : { tuple }),
    ...(inputInterface === undefined ? {} : { inputInterface }),
  };
}

const IP_PROTOCOL: Readonly<Record<'icmp' | 'tcp' | 'udp', number>> = Object.freeze({ icmp: 1, tcp: 6, udp: 17 });

/**
 * @since P3 True when one `match` line hits the frame. `acls` are the lists compiled with the policy
 * (`QosPolicy.acls`); a list missing from it does not exist (no match).
 */
export function qosMatchHits(m: QosMatch, facts: QosPacketFacts, acls: ReadonlyMap<string, AclList>): boolean {
  switch (m.kind) {
    case 'any':
      return true;
    case 'dscp':
      return facts.ip !== undefined && m.values.includes(facts.ip.dscp);
    case 'precedence':
      return facts.ip?.version === 4 && m.values.includes(facts.ip.dscp >> 3);
    case 'cos':
      return facts.cos !== undefined && m.values.includes(facts.cos);
    case 'protocol':
      if (facts.ip?.version !== 4) return false;
      return m.protocol === 'ip' || facts.tuple?.proto === IP_PROTOCOL[m.protocol];
    case 'input-interface':
      return facts.inputInterface !== undefined && facts.inputInterface === m.port;
    case 'access-group': {
      const list = acls.get(m.list);
      return list !== undefined && facts.tuple !== undefined && evaluateAcl(list, facts.tuple).action === 'permit';
    }
  }
}

/** @since P3 True when a class-map matches the frame (`match-all`: every line; `match-any`: one; no line: never). */
export function qosClassMapMatches(cm: QosClassMap, facts: QosPacketFacts, acls: ReadonlyMap<string, AclList>): boolean {
  if (cm.matches.length === 0) return false;
  return cm.mode === 'match-any' ? cm.matches.some((m) => qosMatchHits(m, facts, acls)) : cm.matches.every((m) => qosMatchHits(m, facts, acls));
}

/** @since P3 The class a frame falls in: its index in `QosPolicy.classes` (the `qosClass` of a scheduler port) and name. */
export interface QosClassification {
  readonly index: number;
  readonly name: string;
}

/** @since P3 Classify a frame: the first class whose class-map matches, else class-default (the last class). */
export function classifyQos(policy: Pick<QosPolicy, 'classes' | 'acls'>, facts: QosPacketFacts): QosClassification {
  const last = policy.classes.length - 1;
  for (let i = 0; i < last; i++) {
    const c = policy.classes[i]!;
    if (c.classMap !== undefined && qosClassMapMatches(c.classMap, facts, policy.acls)) return { index: i, name: c.name };
  }
  return { index: last, name: policy.classes[last]!.name };
}
