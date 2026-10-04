/**
 * sim/lab-checks/qos.ts — the qos area's checker adapter (ARCHITECTURE-P3 D5, D16, §2.10, §3.5, §3.11, §5.4; §0 rules
 * 12 and 20; §7 W3 "ospf, acl, l2, qos, disc, svc, http" and "Approved items in W3", qos). sim/lab-checks/facts.ts
 * wires these entries into FACT_READERS; nothing here is read at module scope (rule 12: the entries are plain data
 * whose `read` reads the running configuration at call time, through the W2 `qos/config.ts` reader the runtime uses).
 *
 * Facts, each with its declared type and source (rule 20); subject = an interface (long or short name):
 *   qos.inputPolicy   string   configuration: the policy-map name of the interface's `service-policy input <n>`
 *                              (not set without the line)
 *   qos.outputPolicy  string   configuration: the same for `service-policy output <n>`
 *   [S20] qos.admitted boolean configuration: the output policy passes the 75 % admission (D16) on this interface —
 *                              the reservations of its priority and bandwidth classes (`qosReservationsBps`) are at
 *                              most 75 % of the port's reference rate, which is the rate the `service-policy` handler
 *                              admits against and the runtime compiles with (ruling R34's one helper,
 *                              `qosPortReferenceRateBps`, with the port's effective role: its `bandwidth` line, else
 *                              the port's routing bandwidth, D7's order:
 *                              serial 1544 kb/s, tunnel 100 kb/s, else the negotiated speed). A policy without a
 *                              queueing action is always admitted (marking and policing attach freely, D16); a stored
 *                              line that names no policy-map is not. Not set without a `service-policy output` line.
 *                              The admission is computed again from the current configuration, so a policy-map edited
 *                              after it was attached (a larger priority rate) or a lowered `bandwidth` reads false.
 * A missing subject, or one the device does not have as an interface, fails the assertion with an original detail.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { PortState } from '../../contracts/port.js';
import type { LabFactName } from '../../contracts/scenario.js';
import { effectivePortRole } from '../../device/pipeline.js';
import { compileQosPolicy, qosPolicyAdmission, qosPortReferenceRateBps, readServicePolicy } from '../../qos/config.js';
import { noPort, portNamed } from './core.js';
import type { FactContext, FactReader, FactReading } from './facts.js';

/** The interface the subject names (file header), or the problem that fails the assertion. */
function subjectPort(ctx: FactContext, fact: LabFactName): { readonly port: PortState } | { readonly problem: string } {
  if (ctx.subject === undefined) return { problem: `${fact} needs an interface as its subject.` };
  const port = portNamed(ctx.dev, ctx.subject);
  if (port === undefined) return { problem: noPort(ctx.dev.spec.name, ctx.subject).detail ?? '' };
  return { port };
}

/** qos.inputPolicy / qos.outputPolicy (file header). */
function policyFact(fact: LabFactName, direction: 'input' | 'output'): FactReader {
  return {
    type: 'string',
    source: `configuration: interface service-policy ${direction}`,
    read(ctx) {
      const at = subjectPort(ctx, fact);
      if ('problem' in at) return at;
      return { value: readServicePolicy(ctx.dev.running, at.port.id, direction) };
    },
  };
}

/** [S20] qos.admitted (file header): the 75 % admission at ruling R34's reference rate (`qosPortReferenceRateBps`). */
function readAdmitted(ctx: FactContext): FactReading {
  const at = subjectPort(ctx, 'qos.admitted');
  if ('problem' in at) return at;
  const name = readServicePolicy(ctx.dev.running, at.port.id, 'output');
  if (name === undefined) return { value: undefined };
  const policy = compileQosPolicy(ctx.dev.running, name);
  if (policy === undefined) return { value: false };
  if (!policy.queueing) return { value: true };
  const role = effectivePortRole(at.port, ctx.dev.model.capabilities);
  const refBps = qosPortReferenceRateBps(ctx.dev.running, at.port.id, role, at.port.speedBps ?? at.port.spec.speedBps);
  return { value: qosPolicyAdmission(policy, refBps).ok };
}

/** FACT_READERS entries of the qos area. */
export const QOS_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'qos.inputPolicy': policyFact('qos.inputPolicy', 'input'),
  'qos.outputPolicy': policyFact('qos.outputPolicy', 'output'),
  'qos.admitted': { type: 'boolean', source: 'configuration: interface service-policy output, its policy-map and the port bandwidth', read: readAdmitted },
};
