/**
 * cli/grammar/qos-queueing.ts — [S20]/[S21] the queueing actions of a policy-map class and interface WFQ
 * (ARCHITECTURE-P3 §5.4, D16; §7 W2 cli, approved items). The MQC sections themselves (`class-map`, `policy-map`,
 * `class`, `set`, `service-policy`) are the MUST QoS fragment (`cli/grammar/qos.ts`).
 *
 * Inside `policy-map <p>` / `class <c>` (mode `config-pmap-c`):
 *   [S20] `priority <kbps>` | `priority percent <1-100>`        LLQ: the strict-priority queue with its policer
 *   [S20] `bandwidth <kbps>` | `bandwidth percent <1-100>` | `bandwidth remaining percent <1-100>`   CBWFQ share
 *   [S20] `queue-limit <packets>`                               the class queue's depth
 *   [S21] `fair-queue`                                          WFQ inside class-default only
 *   [S21] `police <bps> [<bc>] [conform-action <a> [exceed-action <a>]]`   a = transmit | drop | set-dscp-transmit <v>
 *   [S21] `shape average <bps> [<bc>]`                          the shaper
 * Interface ([S21]): `fair-queue` (WFQ on the whole port) on routed physical ports and serial lines.
 *
 * A class holds one of `priority` and `bandwidth`; the 75 % admission check and the direction rules
 * (`qosQueueingOutputOnly`, `qosQueueingPhysicalOnly`) belong to `service-policy`, where the port is known (W3 cli).
 * Scope: the `routing` capability, like the MQC sections. Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec } from '../../contracts/cli.js';
import type { PortRole } from '../../contracts/catalog.js';
import { intArg, NFOS_ONLY } from './core-exec.js';

/** @since P3 [S20]/[S21] Handler ids of the queueing fragment. Never rename. */
export const QOS_QUEUEING_HANDLERS = {
  pmapClassPriority: 'pmap-c.priority',
  pmapClassBandwidth: 'pmap-c.bandwidth',
  pmapClassQueueLimit: 'pmap-c.queue-limit',
  pmapClassFairQueue: 'pmap-c.fair-queue',
  pmapClassPolice: 'pmap-c.police',
  pmapClassShape: 'pmap-c.shape',
  ifFairQueue: 'if.fair-queue',
} as const;

/** @since P3 [S20] The mode of a class under a policy-map (contracts/cli.ts MODES). */
export const QUEUEING_CLASS_MODE = 'config-pmap-c';

/** @since P3 [S20] Arg name (`fixedArgs`) naming the form of a `priority` / `bandwidth` line. */
export const RATE_FORM_ARG = 'form';
/** @since P3 [S20] Values of RATE_FORM_ARG. */
export const RATE_FORM_KBPS = 'kbps';
export const RATE_FORM_PERCENT = 'percent';
export const RATE_FORM_REMAINING = 'remaining';

/** @since P3 [S20] Bounds of a rate in kb/s (`priority`, `bandwidth`). */
export const QOS_KBPS_MIN = 8;
export const QOS_KBPS_MAX = 10_000_000;
/** @since P3 [S20] Bounds of a class queue in packets. */
export const QUEUE_LIMIT_MIN = 1;
export const QUEUE_LIMIT_MAX = 8192;
/** @since P3 [S21] Bounds of a policer or shaper rate in bits per second, and of a burst in bytes. */
export const QOS_BPS_MIN = 8000;
export const QOS_BPS_MAX = 10_000_000_000;
export const QOS_BURST_MIN = 1000;
export const QOS_BURST_MAX = 512_000_000;

/** @since P3 [S21] Roles whose ports take interface `fair-queue`: routed physical ports and serial lines. */
export const FAIR_QUEUE_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan'] as PortRole[]);
/** @since P3 [S21] Mismatch of interface `fair-queue` typed on another port. */
export const MSG_FAIR_QUEUE_PORT = '% Fair queueing runs on routed physical interfaces and serial lines only.';

const H = QOS_QUEUEING_HANDLERS;

const CLASS_LINE = {
  mode: QUEUEING_CLASS_MODE,
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  requiresAny: ['routing'],
  since: 'P3',
} as const;

const KBPS_ARG = intArg('Rate in kilobits per second', QOS_KBPS_MIN, QOS_KBPS_MAX);
const PERCENT_ARG = intArg('Share of the interface bandwidth, in percent', 1, 100);
/** The optional tail of `police <bps>`: burst and actions, read by the handler. */
const POLICE_TAIL: ArgSpec = {
  type: 'rest',
  help: '[<burst bytes>] [conform-action transmit|drop|set-dscp-transmit <v> [exceed-action transmit|drop|set-dscp-transmit <v>]]',
  optional: true,
};

/** @since P3 [S20]/[S21] The queueing command table. */
export const QOS_QUEUEING_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  // the keyword forms first, so `percent` and `remaining` are never read as a rate
  {
    ...CLASS_LINE,
    path: ['priority', 'percent', '<percent>'],
    help: 'Serve this class first, up to this share of the interface (low-latency queueing)',
    args: { percent: PERCENT_ARG },
    handler: H.pmapClassPriority,
    fixedArgs: { [RATE_FORM_ARG]: RATE_FORM_PERCENT },
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['priority', '<kbps>'],
    help: 'Serve this class first, up to this rate (low-latency queueing)',
    args: { kbps: KBPS_ARG },
    handler: H.pmapClassPriority,
    fixedArgs: { [RATE_FORM_ARG]: RATE_FORM_KBPS },
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['bandwidth', 'remaining', 'percent', '<percent>'],
    help: 'Guarantee this class a share of what the priority class leaves',
    args: { percent: PERCENT_ARG },
    handler: H.pmapClassBandwidth,
    fixedArgs: { [RATE_FORM_ARG]: RATE_FORM_REMAINING },
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['bandwidth', 'percent', '<percent>'],
    help: 'Guarantee this class a share of the interface bandwidth',
    args: { percent: PERCENT_ARG },
    handler: H.pmapClassBandwidth,
    fixedArgs: { [RATE_FORM_ARG]: RATE_FORM_PERCENT },
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['bandwidth', '<kbps>'],
    help: 'Guarantee this class a rate when the interface is congested',
    args: { kbps: KBPS_ARG },
    handler: H.pmapClassBandwidth,
    fixedArgs: { [RATE_FORM_ARG]: RATE_FORM_KBPS },
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['queue-limit', '<packets>'],
    help: 'Most packets this class may hold waiting before new ones are dropped',
    args: { packets: intArg('Queue depth in packets', QUEUE_LIMIT_MIN, QUEUE_LIMIT_MAX) },
    handler: H.pmapClassQueueLimit,
    objectives: ['CCNA3.qos.4'],
  },
  {
    ...CLASS_LINE,
    path: ['fair-queue'],
    help: 'Share what class-default receives fairly among its flows',
    handler: H.pmapClassFairQueue,
    objectives: ['CCNA3.qos.2'],
  },
  {
    ...CLASS_LINE,
    path: ['police', '<bps>', '<actions>'],
    help: 'Limit this class to a rate: packets above it are dropped or re-marked',
    args: { bps: intArg('Rate in bits per second', QOS_BPS_MIN, QOS_BPS_MAX), actions: POLICE_TAIL },
    handler: H.pmapClassPolice,
    objectives: ['CCNA3.qos.3'],
  },
  {
    ...CLASS_LINE,
    path: ['shape', 'average', '<bps>', '<burst>'],
    help: 'Delay this class\'s packets so they leave at no more than this average rate',
    args: {
      bps: intArg('Rate in bits per second', QOS_BPS_MIN, QOS_BPS_MAX),
      burst: intArg('Burst in bytes (one tenth of a second of the rate when left out)', QOS_BURST_MIN, QOS_BURST_MAX, true),
    },
    handler: H.pmapClassShape,
    objectives: ['CCNA3.qos.3'],
  },
  {
    path: ['fair-queue'],
    mode: 'config-if',
    privilege: 15,
    help: 'Share this interface fairly among its flows (weighted fair queueing)',
    handler: H.ifFairQueue,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    portRequires: { roles: FAIR_QUEUE_ROLES, mismatch: MSG_FAIR_QUEUE_PORT },
    since: 'P3',
    objectives: ['CCNA3.qos.2'],
  },
]);

/** @since P3 [S20]/[S21] Help of the intermediate queueing keywords (merged into `LITERAL_HELP` by the fold). */
export const QOS_QUEUEING_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  priority: 'Low-latency queue settings',
  bandwidth: 'Guaranteed bandwidth settings',
  remaining: 'Share of the bandwidth left over',
  shape: 'Shaping settings',
});
