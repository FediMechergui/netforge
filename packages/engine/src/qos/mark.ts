/**
 * qos/mark.ts — the marking plan (ARCHITECTURE-P3 D16, §3.0 (a) step 9 and (b) step 10c, §3.5 step 3, §3.11 step 6;
 * §7 W2 qos).
 *
 * Given a compiled policy, the class a frame fell in (`qos/classify.ts`) and the frame's facts, the plan lists the
 * field rewrites the runtime applies with `Pdu.mutate(ctx, field, value, 'QosMark', cause)` (each followed by the
 * derived `ChecksumRecompute` and `FcsRecompute` records the PDU writes itself), in this order:
 *   • `set dscp <v>`         → `ipv4.dscp` = v, or on IPv6 `ipv6.trafficClass` = v ≪ 2 | ECN (the ECN bits kept);
 *   • `set ip precedence <v>` → `ipv4.dscp` = v ≪ 3 (IPv4 only; the low DSCP bits cleared, as a class selector);
 *   • `set cos <v>`          → `dot1q.pcp` = v (only on a tagged frame: at input before the tag pop, at a
 *                              subinterface's output after `vlanPush`, D16).
 * Several `set` lines on one field: the last one wins (one rewrite, its cause). A rewrite that would not change the
 * value is left out (no provenance record), but the frame still counts as marked (the display counter), as long as
 * one `set` line applies to it. The cause reads `policy-map MARK class VOIP set dscp ef` (§3.5 step 3).
 *
 * [S21] A policer's `set-dscp-transmit` (`planQosPoliceMarkdown`) rewrites the DSCP the same way after the marking
 * (step 10c: policing runs after marking), with the cause `policy-map P class C police exceed-action set-dscp-transmit
 * af11`.
 *
 * Pure: plans only; the PDU is never touched here.
 */
import type { QosPacketFacts } from './classify.js';
import { qosDscpText, type QosPolicy, type QosPoliceAction, type QosPolicyClass } from './config.js';
import type { QosPolicerResult } from '../link/qos/scheduler.js';

/** @since P3 A field the marking rewrites (the paths `Pdu.mutate` takes). */
export type QosMarkField = 'ipv4.dscp' | 'ipv6.trafficClass' | 'dot1q.pcp';

/** @since P3 One rewrite: `Pdu.mutate(ctx, field, value, 'QosMark', cause)`. */
export interface QosMarkMutation {
  readonly field: QosMarkField;
  readonly before: number;
  readonly value: number;
  readonly cause: string;
}

/** @since P3 The marking of one frame in one class. */
export interface QosMarkPlan {
  readonly cls: number;
  readonly className: string;
  /** A `set` line of the class applies to the frame (the per-class `marked` counter). */
  readonly marked: boolean;
  /** The rewrites that change a value, in field order dscp, then cos. */
  readonly mutations: readonly QosMarkMutation[];
}

/** @since P3 The `QosMark` cause of an action of a class: `policy-map MARK class VOIP set dscp ef`. */
export function qosMarkCause(policy: string, className: string, actionText: string): string {
  return `policy-map ${policy} class ${className} ${actionText}`;
}

/** The DSCP rewrite of the first IP layer to `dscp`, or undefined when it would not change it. */
function dscpRewrite(facts: QosPacketFacts, dscp: number, cause: string): QosMarkMutation | undefined {
  const ip = facts.ip;
  if (ip === undefined || ip.dscp === dscp) return undefined;
  if (ip.version === 4) return { field: 'ipv4.dscp', before: ip.dscp, value: dscp, cause };
  const tc = ip.trafficClass ?? ip.dscp << 2;
  return { field: 'ipv6.trafficClass', before: tc, value: (dscp << 2) | (tc & 3), cause };
}

/** @since P3 The marking plan of a frame in class `cls` of `policy` (see the module header). */
export function planQosMarking(policy: Pick<QosPolicy, 'name' | 'classes'>, cls: number, facts: QosPacketFacts): QosMarkPlan {
  const c: QosPolicyClass | undefined = policy.classes[cls];
  if (c === undefined) throw new RangeError(`class ${cls} is not one of the ${policy.classes.length} classes of policy-map ${policy.name}`);
  let marked = false;
  let dscp: { value: number; text: string } | undefined;
  let cos: { value: number; text: string } | undefined;
  for (const s of c.sets) {
    if (s.kind === 'cos') {
      if (facts.cos === undefined) continue;
      cos = { value: s.value, text: s.text };
    } else if (s.kind === 'precedence') {
      if (facts.ip?.version !== 4) continue;
      dscp = { value: s.value << 3, text: s.text };
    } else {
      if (facts.ip === undefined) continue;
      dscp = { value: s.value, text: s.text };
    }
    marked = true;
  }
  const mutations: QosMarkMutation[] = [];
  if (dscp !== undefined) {
    const m = dscpRewrite(facts, dscp.value, qosMarkCause(policy.name, c.name, dscp.text));
    if (m !== undefined) mutations.push(m);
  }
  if (cos !== undefined && facts.cos !== cos.value) {
    mutations.push({ field: 'dot1q.pcp', before: facts.cos!, value: cos.value, cause: qosMarkCause(policy.name, c.name, cos.text) });
  }
  return { cls, className: c.name, marked, mutations };
}

/** @since P3 The facts after a plan's rewrites (for a later step on the same frame: the policer's markdown). */
export function qosFactsAfter(facts: QosPacketFacts, mutations: readonly QosMarkMutation[]): QosPacketFacts {
  let out = facts;
  for (const m of mutations) {
    if (m.field === 'dot1q.pcp') out = { ...out, cos: m.value };
    else if (m.field === 'ipv4.dscp' && out.ip !== undefined) out = { ...out, ip: { ...out.ip, dscp: m.value } };
    else if (m.field === 'ipv6.trafficClass' && out.ip !== undefined) out = { ...out, ip: { version: 6, dscp: m.value >> 2, trafficClass: m.value } };
  }
  return out;
}

/** @since P3 [S21] What a policer verdict does to a frame: send it or not, and the markdown rewrites. */
export interface QosPolicePlan {
  readonly transmit: boolean;
  readonly action: QosPoliceAction;
  readonly mutations: readonly QosMarkMutation[];
}

/**
 * @since P3 [S21] The plan of a `police` verdict for a frame in class `cls` (the class must police): `transmit` sends it
 * unchanged, `drop` drops it (`policed`), `set-dscp-transmit <v>` rewrites the DSCP of an IP frame and sends it.
 */
export function planQosPoliceMarkdown(
  policy: Pick<QosPolicy, 'name' | 'classes'>,
  cls: number,
  result: QosPolicerResult,
  facts: QosPacketFacts,
): QosPolicePlan {
  const c = policy.classes[cls];
  if (c?.police === undefined) throw new RangeError(`class ${cls} of policy-map ${policy.name} has no police action`);
  const action = result === 'conform' ? c.police.conform : c.police.exceed;
  if (action.kind !== 'set-dscp-transmit') return { transmit: action.kind === 'transmit', action, mutations: [] };
  const m = dscpRewrite(facts, action.dscp, qosMarkCause(policy.name, c.name, `police ${result}-action set-dscp-transmit ${qosDscpText(action.dscp)}`));
  return { transmit: true, action, mutations: m === undefined ? [] : [m] };
}
