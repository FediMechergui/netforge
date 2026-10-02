/**
 * cli/grammar/qos.ts — QoS lite: MQC marking and the traffic generator (ARCHITECTURE-P3 §5.4, §5.8, D16, M13; §7 W2
 * cli part 1).
 *
 * Configuration:
 *   global          `class-map [match-all|match-any] <name>` (mode `config-cmap`; stored with its type, match-all
 *                   when omitted) and `policy-map <name>` (mode `config-pmap`)
 *   config-cmap     `match dscp <v…>` (up to 8), `match ip precedence <v…>` (up to 4), `match cos <v…>` (up to 4),
 *                   `match access-group <n>` / `match access-group name <n>`, `match protocol ip|icmp|tcp|udp`,
 *                   `match input-interface <if>`, `match any`
 *   config-pmap     `class <name>|class-default` (mode `config-pmap-c`; a class-map that does not exist is refused,
 *                   `qosClassMissing`)
 *   config-pmap-c   `set dscp <v>`, `set ip precedence <v>`, `set cos <v>` (the [S20]/[S21] queueing actions are the
 *                   approved items' fragment, cli/grammar/qos-queueing.ts)
 *   interface       `service-policy input|output <name>` (one per direction; on routed ports, serial ports and
 *                   subinterfaces; refused on SVIs and switched ports with `qosPortUnsupported`, by the handler so the
 *                   message names the port)
 * Verification: `show class-map [<name>]`, `show policy-map [<name>]`, `show policy-map interface <if>
 * [input|output]`.
 * Host shell (M13, original syntax): `flow start <dst> (rate <kbps>|pps <n>) size <bytes> [dscp <v>] [port <p>]
 * [count <n>|for <s>]`, `flow voice <dst> [g711] [dscp <v>]`, `flow stop <id>` — short jobs: `traffic.start` /
 * `traffic.stop` to the traffic daemon, which prints one line and ends the job — and `flow show`. The optional keywords are separate literal paths in a fixed order, so `?`
 * guides every step and no two complete matches tie.
 *
 * Scope: the marking lines on `routing` models (a managed L2 switch attaches no policy, D16); the flow commands on
 * hosts. DSCP values are numbers 0-63 or the standard per-hop names. Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability, PortRole } from '../../contracts/catalog.js';
import { choiceArg, HOST_ONLY, ifaceArg, intArg, ipArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the QoS fragment. Never rename. */
export const QOS_HANDLERS = {
  configClassMap: 'config.class-map',
  cmapMatch: 'cmap.match',
  configPolicyMap: 'config.policy-map',
  pmapClass: 'pmap.class',
  pmapcSet: 'pmap-c.set',
  ifServicePolicy: 'if.service-policy',
  showClassMap: 'show.class-map',
  showPolicyMap: 'show.policy-map',
  showPolicyMapInterface: 'show.policy-map-interface',
  hostFlowStart: 'host.flow-start',
  hostFlowVoice: 'host.flow-voice',
  hostFlowStop: 'host.flow-stop',
  hostFlowShow: 'host.flow-show',
} as const;

/** @since P3 Capabilities offered the marking lines (D16: routed ports and subinterfaces). */
export const QOS_CAPABILITIES: readonly Capability[] = Object.freeze(['routing']);
/** @since P3 Capabilities offered the host-shell `flow` commands (the traffic daemon runs on hosts, §2.1). */
export const FLOW_CAPABILITIES: readonly Capability[] = Object.freeze(['host']);

/** @since P3 `fixedArgs` key naming the sub-form of a `match`, `set` or `flow` line. */
export const QOS_FORM_ARG = 'form';
/** @since P3 The class every policy ends with. */
export const QOS_CLI_CLASS_DEFAULT = 'class-default';

/**
 * @since P3 The standard DSCP names (`match dscp`, `set dscp`), with their values. A copy of the data the qos reader
 * keeps (qos/config.ts, a W2 module this W2 fragment may not import, rule 1); `cs0` reads as `default`.
 */
export const QOS_CLI_DSCP_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['default', 0], ['cs1', 8], ['af11', 10], ['af12', 12], ['af13', 14], ['cs2', 16], ['af21', 18], ['af22', 20],
  ['af23', 22], ['cs3', 24], ['af31', 26], ['af32', 28], ['af33', 30], ['cs4', 32], ['af41', 34], ['af42', 36],
  ['af43', 38], ['cs5', 40], ['ef', 46], ['cs6', 48], ['cs7', 56],
]);
/** @since P3 The IP precedence names, with their values. */
export const QOS_CLI_PRECEDENCE_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['routine', 0], ['priority', 1], ['immediate', 2], ['flash', 3], ['flash-override', 4], ['critical', 5], ['internet', 6], ['network', 7],
]);

/** @since P3 Bounds of a generated flow (§2.4 `TrafficFlowSpec`: ≤ 2 Mb/s, ≤ 1000 pps, 60-1500 bytes). */
export const FLOW_RATE_MAX_KBPS = 2000;
export const FLOW_PPS_MAX = 1000;
export const FLOW_SIZE_MIN = 60;
export const FLOW_SIZE_MAX = 1500;
/**
 * @since P3 Largest count and duration the grammar reads; anything beyond the 300 s cap (`TRAFFIC_MAX_DURATION_MS`) is
 * refused by the handler with `trafficFlowCap`, not by the parser.
 */
export const FLOW_COUNT_MAX = 10_000_000;
export const FLOW_SECONDS_MAX = 86_400;

const H = QOS_HANDLERS;
const OBJ_MARK = ['CCNA3.qos.1'];
const OBJ_FLOW = ['CCNA3.qos.4'];

const DSCP_NAMES_ONLY: readonly string[] = Object.freeze([...QOS_CLI_DSCP_NAMES.map(([n]) => n), 'cs0'].sort());
const PRECEDENCE_NAMES_ONLY: readonly string[] = Object.freeze(QOS_CLI_PRECEDENCE_NAMES.map(([n]) => n).sort());

function dscpArg(help: string, optional = false): ArgSpec {
  const a: ArgSpec = { type: 'int', help, min: 0, max: 63, choices: DSCP_NAMES_ONLY };
  return optional ? { ...a, optional: true } : a;
}
function precedenceArg(help: string, optional = false): ArgSpec {
  const a: ArgSpec = { type: 'int', help, min: 0, max: 7, choices: PRECEDENCE_NAMES_ONLY };
  return optional ? { ...a, optional: true } : a;
}

const GLOBAL = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: QOS_CAPABILITIES,
  since: 'P3',
} as const;

const CMAP = { ...GLOBAL, mode: 'config-cmap' } as const;
const PMAP = { ...GLOBAL, mode: 'config-pmap' } as const;
const PMAPC = { ...GLOBAL, mode: 'config-pmap-c' } as const;

const NAME_ARG = wordArg('Name', { maxLength: 40 });

/**
 * @since P3 Ports `service-policy` is offered on: routed ports, serial ports and subinterfaces, plus SVIs, switched ports
 * and channels so that the handler refuses those by name (`qosPortUnsupported`, D16). Other roles never list it.
 */
export const SERVICE_POLICY_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'subif', 'svi', 'switched', 'channel']);
/** @since P3 Mismatch of `service-policy` on another port. */
export const MSG_SERVICE_POLICY_PORT = '% Service policies attach to routed interfaces and subinterfaces.';
const SERVICE_POLICY_PORT: PortRequirement = Object.freeze<PortRequirement>({ roles: SERVICE_POLICY_ROLES, mismatch: MSG_SERVICE_POLICY_PORT });

/** `match dscp <v1> … <v8>`: the first value required, the others optional (trailing). */
function valueList(prefix: string, count: number, arg: (help: string, optional?: boolean) => ArgSpec, help: string): { path: string[]; args: Record<string, ArgSpec> } {
  const path: string[] = [];
  const args: Record<string, ArgSpec> = {};
  for (let i = 1; i <= count; i++) {
    path.push(`<${prefix}${i}>`);
    args[`${prefix}${i}`] = arg(i === 1 ? help : 'Another value (any one of them matches)', i > 1);
  }
  return { path, args };
}

const DSCP_VALUES = valueList('v', 8, dscpArg, 'DSCP value: 0-63 or a name such as ef or af41');
const PREC_VALUES = valueList('v', 4, precedenceArg, 'IP precedence: 0-7 or a name such as critical');
const COS_VALUES = valueList('v', 4, (help, optional) => intArg(help, 0, 7, optional), 'Class of service (802.1Q priority): 0-7');

/** One generated `flow start` spec: the rate form, then the optional dscp, port and count/for keywords. */
function flowStartSpec(by: 'rate' | 'pps', dscp: boolean, port: boolean, end: 'none' | 'count' | 'for'): CommandSpec {
  const path = ['flow', 'start', '<dst>', by, by === 'rate' ? '<kbps>' : '<pps>', 'size', '<bytes>'];
  const args: Record<string, ArgSpec> = {
    dst: ipArg('Destination host address'),
    bytes: intArg('IP datagram size in bytes', FLOW_SIZE_MIN, FLOW_SIZE_MAX),
  };
  if (by === 'rate') args['kbps'] = intArg('Rate in kilobits per second', 1, FLOW_RATE_MAX_KBPS);
  else args['pps'] = intArg('Packets per second', 1, FLOW_PPS_MAX);
  if (dscp) {
    path.push('dscp', '<dscp>');
    args['dscp'] = dscpArg('DSCP the datagrams carry: 0-63 or a name such as ef');
  }
  if (port) {
    path.push('port', '<port>');
    args['port'] = intArg('Destination UDP port (default 9, discard)', 1, 65535);
  }
  if (end === 'count') {
    path.push('count', '<count>');
    args['count'] = intArg('Number of datagrams to send', 1, FLOW_COUNT_MAX);
  } else if (end === 'for') {
    path.push('for', '<seconds>');
    args['seconds'] = intArg('Seconds to send for (at most 300)', 1, FLOW_SECONDS_MAX);
  }
  const last = path.filter((e) => !e.startsWith('<')).at(-1);
  const help =
    last === 'dscp' ? 'Mark the datagrams with a DSCP value'
      : last === 'port' ? 'Send to this UDP port'
        : last === 'count' ? 'Stop after this many datagrams'
          : last === 'for' ? 'Stop after this many seconds'
            : 'Datagram size; without count or for the flow runs until "flow stop" (5 minutes at most)';
  return {
    path,
    mode: 'user-exec',
    privilege: 15,
    help,
    args,
    handler: H.hostFlowStart,
    fixedArgs: { [QOS_FORM_ARG]: by },
    job: true,
    grammars: HOST_ONLY,
    requiresAny: FLOW_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_FLOW,
  };
}

function flowStartSpecs(): CommandSpec[] {
  const out: CommandSpec[] = [];
  for (const by of ['rate', 'pps'] as const) {
    for (const dscp of [false, true]) {
      for (const port of [false, true]) {
        for (const end of ['none', 'count', 'for'] as const) out.push(flowStartSpec(by, dscp, port, end));
      }
    }
  }
  return out;
}

function flowVoiceSpec(g711: boolean, dscp: boolean): CommandSpec {
  const path = ['flow', 'voice', '<dst>', ...(g711 ? ['g711'] : []), ...(dscp ? ['dscp', '<dscp>'] : [])];
  const args: Record<string, ArgSpec> = { dst: ipArg('Destination host address') };
  if (dscp) args['dscp'] = dscpArg('DSCP the voice datagrams carry (default ef, 46)');
  return {
    path,
    mode: 'user-exec',
    privilege: 15,
    help: dscp ? 'Mark the voice datagrams with another DSCP value' : g711 ? 'Larger voice datagrams (200 bytes)' : 'A voice call: 50 small datagrams per second marked ef, until "flow stop"',
    args,
    handler: H.hostFlowVoice,
    fixedArgs: { [QOS_FORM_ARG]: g711 ? 'voice-g711' : 'voice-g729' },
    job: true,
    grammars: HOST_ONLY,
    requiresAny: FLOW_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_FLOW,
  };
}

/** The QoS command table. */
export const QOS_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL,
    path: ['class-map', '<name>'],
    help: 'Create or edit a traffic class (all of its match lines must match)',
    args: { name: NAME_ARG },
    handler: H.configClassMap,
    entersMode: 'config-cmap',
    sessionEffect: 'enter-mode',
    objectives: OBJ_MARK,
  },
  {
    ...GLOBAL,
    path: ['class-map', 'match-all', '<name>'],
    help: 'A class whose match lines must all match',
    args: { name: NAME_ARG },
    handler: H.configClassMap,
    fixedArgs: { [QOS_FORM_ARG]: 'match-all' },
    entersMode: 'config-cmap',
    sessionEffect: 'enter-mode',
    objectives: OBJ_MARK,
  },
  {
    ...GLOBAL,
    path: ['class-map', 'match-any', '<name>'],
    help: 'A class of which any one match line is enough',
    args: { name: NAME_ARG },
    handler: H.configClassMap,
    fixedArgs: { [QOS_FORM_ARG]: 'match-any' },
    entersMode: 'config-cmap',
    sessionEffect: 'enter-mode',
    objectives: OBJ_MARK,
  },
  { ...CMAP, path: ['match', 'dscp', ...DSCP_VALUES.path], help: 'Packets carrying one of these DSCP values', args: DSCP_VALUES.args, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'dscp' }, noArgsOptional: true, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'ip', 'precedence', ...PREC_VALUES.path], help: 'Packets carrying one of these precedence values', args: PREC_VALUES.args, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'precedence' }, noArgsOptional: true, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'cos', ...COS_VALUES.path], help: 'Frames whose 802.1Q priority is one of these', args: COS_VALUES.args, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'cos' }, noArgsOptional: true, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'access-group', '<number>'], help: 'Packets a numbered access list permits', args: { number: intArg('List number', 1, 2699) }, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'access-group' }, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'access-group', 'name', '<list>'], help: 'Packets a named access list permits', args: { list: wordArg('List name', { maxLength: 64 }) }, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'access-group-name' }, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'protocol', '<protocol>'], help: 'Packets of one protocol', args: { protocol: choiceArg('ip: every IPv4 packet; icmp, tcp or udp', ['ip', 'icmp', 'tcp', 'udp']) }, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'protocol' }, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'input-interface', '<iface>'], help: 'Packets that arrived on one interface', args: { iface: ifaceArg('Interface') }, handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'input-interface' }, objectives: OBJ_MARK },
  { ...CMAP, path: ['match', 'any'], help: 'Every packet', handler: H.cmapMatch, fixedArgs: { [QOS_FORM_ARG]: 'any' }, objectives: OBJ_MARK },
  {
    ...GLOBAL,
    path: ['policy-map', '<name>'],
    help: 'Create or edit a policy: what to do with each class',
    args: { name: NAME_ARG },
    handler: H.configPolicyMap,
    entersMode: 'config-pmap',
    sessionEffect: 'enter-mode',
    objectives: OBJ_MARK,
  },
  {
    ...PMAP,
    path: ['class', '<name>'],
    help: 'The actions for one class (class-default takes everything else)',
    args: { name: wordArg('Class-map name, or class-default', { maxLength: 40 }) },
    handler: H.pmapClass,
    entersMode: 'config-pmap-c',
    sessionEffect: 'enter-mode',
    objectives: OBJ_MARK,
  },
  { ...PMAPC, path: ['set', 'dscp', '<value>'], help: 'Rewrite the DSCP of the packets of this class', args: { value: dscpArg('DSCP value: 0-63 or a name such as ef') }, handler: H.pmapcSet, fixedArgs: { [QOS_FORM_ARG]: 'dscp' }, noArgsOptional: true, objectives: OBJ_MARK },
  { ...PMAPC, path: ['set', 'ip', 'precedence', '<value>'], help: 'Rewrite the IP precedence of the packets of this class', args: { value: precedenceArg('IP precedence: 0-7 or a name') }, handler: H.pmapcSet, fixedArgs: { [QOS_FORM_ARG]: 'precedence' }, noArgsOptional: true, objectives: OBJ_MARK },
  { ...PMAPC, path: ['set', 'cos', '<value>'], help: 'Rewrite the 802.1Q priority of the frames of this class', args: { value: intArg('Class of service: 0-7', 0, 7) }, handler: H.pmapcSet, fixedArgs: { [QOS_FORM_ARG]: 'cos' }, noArgsOptional: true, objectives: OBJ_MARK },
  {
    path: ['service-policy', '<direction>', '<name>'],
    mode: ['config-if', 'config-subif'],
    privilege: 15,
    help: 'Apply a policy to the packets arriving (input) or leaving (output) on this interface',
    args: {
      direction: choiceArg('input: packets arriving; output: packets leaving', ['input', 'output']),
      name: wordArg('Policy-map name', { maxLength: 40 }),
    },
    handler: H.ifServicePolicy,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: QOS_CAPABILITIES,
    portRequires: SERVICE_POLICY_PORT,
    since: 'P3',
    objectives: OBJ_MARK,
  },
  {
    path: ['show', 'class-map', '<name>'],
    mode: '@exec',
    privilege: 1,
    help: 'The traffic classes and their match lines',
    args: { name: wordArg('Limit the output to one class-map', { optional: true, maxLength: 40 }) },
    handler: H.showClassMap,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: QOS_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_MARK,
  },
  {
    path: ['show', 'policy-map', '<name>'],
    mode: '@exec',
    privilege: 1,
    help: 'The policies and the actions of each class',
    args: { name: wordArg('Limit the output to one policy-map', { optional: true, maxLength: 40 }) },
    handler: H.showPolicyMap,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: QOS_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_MARK,
  },
  {
    path: ['show', 'policy-map', 'interface', '<iface>', '<direction>'],
    mode: '@exec',
    privilege: 1,
    help: 'The policies of one interface with the packets each class matched and marked',
    args: {
      iface: ifaceArg('Interface'),
      direction: choiceArg('Limit the output to one direction', ['input', 'output'], true),
    },
    handler: H.showPolicyMapInterface,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: QOS_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_MARK,
  },
  ...flowStartSpecs(),
  flowVoiceSpec(false, false),
  flowVoiceSpec(true, false),
  flowVoiceSpec(false, true),
  flowVoiceSpec(true, true),
  {
    path: ['flow', 'stop', '<id>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Stop a flow this host sends',
    args: { id: wordArg('Flow id, as "flow show" lists it (f1, f2, …)', { maxLength: 16 }) },
    handler: H.hostFlowStop,
    job: true,
    grammars: HOST_ONLY,
    requiresAny: FLOW_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_FLOW,
  },
  {
    path: ['flow', 'show'],
    mode: 'user-exec',
    privilege: 15,
    help: 'The flows this host sends',
    handler: H.hostFlowShow,
    grammars: HOST_ONLY,
    requiresAny: FLOW_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_FLOW,
  },
]);
