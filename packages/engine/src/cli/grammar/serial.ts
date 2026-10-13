/**
 * cli/grammar/serial.ts — serial WAN interface lines and diagnostics (ARCHITECTURE-P1 D6, §3.9, §6): `clock rate`,
 * `encapsulation hdlc|ppp`, `bandwidth`, `keepalive [<s>]` / `no keepalive`, `show controllers serial [<if>]` and
 * the `serial` debug category.
 *
 * Every interface line requires the selected interface to be a serial port. `show controllers serial` and
 * `debug serial` are executable everywhere the network OS runs but are not listed by `?` in P0.5, so the P0 help
 * lists of the P0 router stay identical (ARCHITECTURE-P1 §9.2). Help strings are original wording (spec §1.6).
 *
 * P3 (ARCHITECTURE-P3 §9.2 ruling R56; W6 cli): `show controllers [<iface>]` also accepts the bare `show controllers`
 * (every serial port) and the slot form `show controllers serial 0/0/0` (the interface typed as its family word and
 * number, which the parser joins as it does for `interface serial 0/0/0`). Both run the accepted form's handler with
 * the same arguments, so their output is that of `show controllers serial [<iface>]` byte for byte. As R56 says ("the
 * help golden gains them as additions"; W6a integration, §9.2 item 40h), this form is listed by `?`, and `show
 * controllers ` offers the serial ports. The accepted P0.5 form and `debug serial` stay hidden, so every other listing
 * is unchanged.
 *
 * P3 (ARCHITECTURE-P3 §9.2 ruling R58 (d); W6b cli): the visible form is offered only where a line controller can
 * exist — "models with the routing capability or a serial port or slot". Capabilities are the only scope gate a spec
 * has, so the listing follows `CONTROLLERS_LISTED_ON`: `routing` (routers, layer-3 switches, firewalls, home routers:
 * every model with a serial module slot, and the serial-port routers) and `cloud` (the Internet cloud, the one `cloud`
 * model, whose serial ports the ruling's "serial port" clause covers; it has no console, so only `?` sees it). The
 * CSU/DSU, the one other serial-port model, declares only `modem`, the capability of the modems the ruling names among
 * those no longer listing it, so no capability gate can list it without listing them: it stays unlisted until the
 * architect rules on it (W6b review). Elsewhere (layer-2 switches, hubs, access points, modems, bridges) a hidden twin
 * of the same path keeps the R56 lines executable exactly as before, as the accepted form is there: it prints the same
 * refusal, but `?` no longer lists it. The two specs never share a scope (`requiresAny` / `excludesAny` on the same
 * capabilities), so no line is ever ambiguous between them.
 */
import type { Capability } from '../../contracts/catalog.js';
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

/** @since P3 (W6 cli, R56: exported; the text is P0.5's) Mismatch of `show controllers` naming a port that is not serial. */
export const MSG_NO_LINE_CONTROLLER = '% Only serial interfaces have line controllers.';
/** The interface argument of both `show controllers` forms: an existing serial port, optional (absent = every one). */
const CONTROLLER_IFACE = ifaceArg('Limit the output to one serial interface', {
  optional: true,
  portFilter: kindsPort(['serial'], MSG_NO_LINE_CONTROLLER),
});

/**
 * @since P3 (ARCHITECTURE-P3 §9.2 ruling R58 (d); W6b cli) The capabilities that offer the visible `show controllers
 * [<iface>]` form in `?` listings (`requiresAny`): `routing`, and `cloud` for the Internet cloud's serial ports (file
 * header); models with neither keep the form as a hidden twin (`excludesAny`).
 */
export const CONTROLLERS_LISTED_ON: readonly Capability[] = Object.freeze<Capability[]>(['routing', 'cloud']);

/** The R56 form `show controllers [<iface>]` (path, help, args, handler); R58 (d) splits its scope in two specs. */
const R56_CONTROLLERS: CommandSpec = {
  path: ['show', 'controllers', '<iface>'],
  mode: '@exec',
  privilege: 1,
  help: 'Cable end, clock and framing of serial interfaces',
  args: { iface: CONTROLLER_IFACE },
  handler: H.showControllers,
  filterable: true,
  grammars: NFOS_ONLY,
  since: 'P3',
  objectives: ['CCNA2.7.1', 'CCNA3.wan.2'],
};

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
    // the accepted form (P0.5): `show controllers serial` (every serial port) or `show controllers serial <name>`
    path: ['show', 'controllers', 'serial', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'Cable end, clock and framing of serial interfaces',
    args: { iface: CONTROLLER_IFACE },
    handler: H.showControllers,
    filterable: true,
    hidden: true,
    grammars: NFOS_ONLY,
    since: 'P0.5',
    objectives: ['CCNA2.7.1'],
  },
  {
    // P3 ruling R56 (W6 cli; file header), closing the P0.5 fidelity gap recorded in W5: the bare `show controllers`
    // and the slot form `show controllers serial 0/0/0`. Never ambiguous with the accepted form: a line both complete
    // matches the accepted form on one more keyword (`serial`), so `show controllers serial` stays its; a slot number
    // after `serial` is no interface name, so `show controllers serial 0/0/0` is this one's alone. Listed by `?` (R56,
    // §9.2 item 40h) where R58 (d) offers it: on models with the routing capability, and the Internet cloud.
    ...R56_CONTROLLERS,
    requiresAny: CONTROLLERS_LISTED_ON,
  },
  {
    // R58 (d): the same form on every other network-OS model, executable as R56 made it but no longer listed by `?`
    ...R56_CONTROLLERS,
    excludesAny: CONTROLLERS_LISTED_ON,
    hidden: true,
  },
  ...debugSpecs(SERIAL_DEBUG_CATEGORIES, { serial: ['CCNA2.7.1'] }),
]);
