/**
 * cli/grammar/time.ts — device clocks and NTP (ARCHITECTURE-P3 §5.5, §5.8, D19; §7 W2 cli part 1).
 *
 *   global     `clock timezone <name> <±hours> [<minutes>]`, `ntp server <address|name> [prefer] [source <if>]`
 *              (one line per server), `ntp master [<1-15>]` (stratum 8 when omitted), `ntp source <if>`
 *   exec       `clock set <hh:mm:ss> <day> <month> <year>` (also `<month> <day> <year>`): not stored; the CLI sends
 *              `ntp.clockSet`, and ntp sets the clock and writes its `clock` row (rule 20); `show clock [detail]`
 *   host shell `service ntp on|off` (servers): `ntp master 1` / its removal
 * The runtime keeps the clock; the ntp daemon reads the lines (W2 svc). `show ntp …` is W3's.
 *
 * Scope: the network devices that run ntp (§2.1 rows: routing, managed-switch, wireless-controller), and `service ntp`
 * on servers. Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, HOST_ONLY, hostArg, ifaceArg, intArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the time fragment. Never rename. */
export const TIME_HANDLERS = {
  configClockTimezone: 'config.clock-timezone',
  configNtpServer: 'config.ntp-server',
  configNtpMaster: 'config.ntp-master',
  configNtpSource: 'config.ntp-source',
  execClockSet: 'exec.clock-set',
  showClock: 'show.clock',
  hostServiceNtp: 'host.service-ntp',
} as const;

/** @since P3 Capabilities that run ntp on network devices (§2.1). */
export const NTP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch', 'wireless-controller']);
/** @since P3 Capabilities whose host shell offers `service ntp` (§5.5: servers). */
export const NTP_SERVER_CAPABILITIES: readonly Capability[] = Object.freeze(['server']);

/** @since P3 `fixedArgs` keys of the time specs: the `ntp server` options and the `clock set` order. */
export const TIME_FORM_ARG = 'form';
export const NTP_PREFER_ARG = 'prefer';
export const SHOW_CLOCK_DETAIL_ARG = 'detail';

/** @since P3 Month names `clock set` accepts (any unambiguous prefix, any letter case). */
export const CLOCK_MONTHS = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const);
/** @since P3 Years `clock set` accepts. */
export const CLOCK_YEAR_MIN = 1993;
export const CLOCK_YEAR_MAX = 2035;

const H = TIME_HANDLERS;
const OBJ = ['CCNA3.management.2'];

const GLOBAL = { mode: 'config', privilege: 15, allowNo: true, grammars: NFOS_ONLY, requiresAny: NTP_CAPABILITIES, since: 'P3' } as const;

const TIME_ARG: ArgSpec = Object.freeze({ type: 'word', help: 'Time of day, hh:mm:ss (24-hour)', pattern: '\\d{1,2}:\\d{2}:\\d{2}' });
const DAY_ARG: ArgSpec = intArg('Day of the month', 1, 31);
const MONTH_ARG: ArgSpec = choiceArg('Month (January to December)', CLOCK_MONTHS);
const YEAR_ARG: ArgSpec = intArg('Year', CLOCK_YEAR_MIN, CLOCK_YEAR_MAX);
const SERVER_ARG: ArgSpec = hostArg('Address or name of the time server');
const SOURCE_ARG: ArgSpec = ifaceArg('Interface whose address the requests come from');

/** One `ntp server` spec (the options in their fixed order). */
function ntpServerSpec(prefer: boolean, source: boolean): CommandSpec {
  const path = ['ntp', 'server', '<server>', ...(prefer ? ['prefer'] : []), ...(source ? ['source', '<iface>'] : [])];
  return {
    ...GLOBAL,
    path,
    help: source ? 'Send the requests from this interface\'s address' : prefer ? 'Choose this server over the others when they agree' : 'Take the time from a server',
    args: source ? { server: SERVER_ARG, iface: SOURCE_ARG } : { server: SERVER_ARG },
    handler: H.configNtpServer,
    noArgsOptional: true,
    ...(prefer ? { fixedArgs: { [NTP_PREFER_ARG]: 'prefer' } } : {}),
    objectives: OBJ,
  };
}

/** The time command table. */
export const TIME_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL,
    path: ['clock', 'timezone', '<zone>', '<hours>', '<minutes>'],
    help: 'Name and offset from UTC of the local time this device shows',
    args: {
      zone: wordArg('Zone name shown with the time, e.g. CET', { maxLength: 7 }),
      hours: intArg('Hours from UTC (-23 to 23)', -23, 23),
      minutes: intArg('Extra minutes from UTC', 0, 59, true),
    },
    handler: H.configClockTimezone,
    noArgsOptional: true,
    objectives: OBJ,
  },
  ntpServerSpec(false, false),
  ntpServerSpec(true, false),
  ntpServerSpec(false, true),
  ntpServerSpec(true, true),
  {
    ...GLOBAL,
    path: ['ntp', 'master', '<stratum>'],
    help: 'Serve this device\'s own clock to NTP clients (stratum 8 when not given)',
    args: { stratum: intArg('Stratum to announce (1-15)', 1, 15, true) },
    handler: H.configNtpMaster,
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...GLOBAL,
    path: ['ntp', 'source', '<iface>'],
    help: 'Interface whose address every NTP request comes from',
    args: { iface: SOURCE_ARG },
    handler: H.configNtpSource,
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    path: ['clock', 'set', '<time>', '<day>', '<month>', '<year>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Set the clock by hand',
    args: { time: TIME_ARG, day: DAY_ARG, month: MONTH_ARG, year: YEAR_ARG },
    handler: H.execClockSet,
    grammars: NFOS_ONLY,
    requiresAny: NTP_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
  {
    path: ['clock', 'set', '<time>', '<month>', '<day>', '<year>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Set the clock by hand',
    args: { time: TIME_ARG, month: MONTH_ARG, day: DAY_ARG, year: YEAR_ARG },
    handler: H.execClockSet,
    hidden: true,
    grammars: NFOS_ONLY,
    requiresAny: NTP_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
  {
    path: ['show', 'clock'],
    mode: '@exec',
    privilege: 1,
    help: 'The date and time of this device\'s clock',
    handler: H.showClock,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: NTP_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
  {
    path: ['show', 'clock', 'detail'],
    mode: '@exec',
    privilege: 1,
    help: 'The clock and where its time comes from',
    handler: H.showClock,
    fixedArgs: { [SHOW_CLOCK_DETAIL_ARG]: 'detail' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: NTP_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
  {
    path: ['service', 'ntp', '<state>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Serve this server\'s time to NTP clients (stratum 1), or stop',
    args: { state: choiceArg('on starts the time service, off stops it', ['on', 'off']) },
    handler: H.hostServiceNtp,
    grammars: HOST_ONLY,
    requiresAny: NTP_SERVER_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
]);
