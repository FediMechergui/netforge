/**
 * cli/grammar/serial.ts — serial WAN interface lines and diagnostics (ARCHITECTURE-P1 D6, §3.9, §6): `clock rate`,
 * `encapsulation hdlc|ppp`, `bandwidth`, `keepalive [<s>]` / `no keepalive`, `show controllers serial [<if>]` and
 * the `serial` debug category.
 *
 * Every interface line requires the selected interface to be a serial port. `show controllers serial` and
 * `debug serial` are executable everywhere the network OS runs but are not listed by `?` in P0.5, so the P0 help
 * lists of the P0 router stay identical (ARCHITECTURE-P1 §9.2). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec, PortRequirement } from '../../contracts/cli.js';
import {
  choiceArg,
  debugSpecs,
  ifaceArg,
  intArg,
  kindsPort,
  NFOS_ONLY,
  type GrammarDebugCategory,
} from './core-exec.js';

/** Handler ids of the serial fragment. */
export const SERIAL_HANDLERS = {
  ifClockRate: 'if.clock-rate',
  ifEncapsulation: 'if.encapsulation',
  ifBandwidth: 'if.bandwidth',
  ifKeepalive: 'if.keepalive',
  showControllers: 'show.controllers',
} as const;

/** Debug categories of the serial fragment. */
export const SERIAL_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'serial', help: 'Trace HDLC keepalives and line protocol changes', since: 'P0.5', hidden: true },
]);

/** Mismatch text for serial lines typed on a port that is not serial. */
export const MSG_NOT_SERIAL = '% This setting applies to serial interfaces only.';

const H = SERIAL_HANDLERS;
const SERIAL_PORT = kindsPort(['serial'], MSG_NOT_SERIAL);

/** @since P3 Mismatch of `bandwidth` on a port that takes none. */
export const MSG_BANDWIDTH_PORT = '% Bandwidth applies to serial interfaces, routed Ethernet interfaces, subinterfaces and tunnels.';
/**
 * @since P3 (ARCHITECTURE-P3 §5.1, §9.2 W2; W2 cli) Ports `bandwidth` takes: the serial ports it always took (roles
 * `wan` and `access-line`) and, widened so the OSPF cost lesson can set it, routed Ethernet ports (the Ethernet `wan`
 * port of a home router included), subinterfaces and [S18] tunnels. One spec, so a port that takes none still reports
 * the mismatch.
 */
export const BANDWIDTH_PORT: PortRequirement = Object.freeze<PortRequirement>({
  kinds: Object.freeze(['serial', 'ethernet', 'virtual'] as const),
  roles: Object.freeze(['wan', 'access-line', 'routed', 'subif', 'tunnel'] as const),
  mismatch: MSG_BANDWIDTH_PORT,
});

/** The serial command table. */
export const SERIAL_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['clock', 'rate', '<bps>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Line clock the DCE end of the cable supplies, in bits per second',
    args: { bps: intArg('Clock rate in bits per second', 1200, 8_000_000) },
    handler: H.ifClockRate,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: SERIAL_PORT,
    since: 'P0.5',
    objectives: ['CCNA2.7.1'],
  },
  {
    path: ['encapsulation', '<framing>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Layer 2 framing used on this serial line',
    args: { framing: choiceArg('Framing (hdlc, or ppp in a later release)', ['hdlc', 'ppp']) },
    handler: H.ifEncapsulation,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: SERIAL_PORT,
    since: 'P0.5',
    objectives: ['CCNA2.7.1'],
  },
  {
    // P3 (ARCHITECTURE-P3 §5.1, §9.2 W2; W2 cli): widened from serial ports to routed Ethernet ports, subinterfaces and
    // [S18] tunnels (`BANDWIDTH_PORT`)
    path: ['bandwidth', '<kbps>'],
    mode: ['config-if', 'config-subif'],
    privilege: 15,
    help: 'Nominal line capacity in kilobits per second, for display and metrics',
    args: { kbps: intArg('Bandwidth in kilobits per second', 1, 10_000_000) },
    handler: H.ifBandwidth,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: BANDWIDTH_PORT,
    since: 'P0.5',
    objectives: ['CCNA2.7.1', 'CCNA3.ospf.5'],
  },
  {
    path: ['keepalive', '<seconds>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Seconds between line keepalives (0 stops them; no keepalive disables them)',
    args: { seconds: intArg('Keepalive interval in seconds', 0, 32_767, true) },
    handler: H.ifKeepalive,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: SERIAL_PORT,
    since: 'P0.5',
    objectives: ['CCNA2.7.1'],
  },
  {
    path: ['show', 'controllers', 'serial', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'Cable end, clock and framing of serial interfaces',
    args: {
      iface: ifaceArg('Limit the output to one serial interface', {
        optional: true,
        portFilter: kindsPort(['serial'], '% Only serial interfaces have line controllers.'),
      }),
    },
    handler: H.showControllers,
    filterable: true,
    hidden: true,
    grammars: NFOS_ONLY,
    since: 'P0.5',
    objectives: ['CCNA2.7.1'],
  },
  ...debugSpecs(SERIAL_DEBUG_CATEGORIES, { serial: ['CCNA2.7.1'] }),
]);
