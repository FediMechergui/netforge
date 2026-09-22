/**
 * cli/handlers/subif.ts — `interface range <ranges>` and `encapsulation dot1Q <vid> [native]` (ARCHITECTURE-P2 §2.11,
 * §3.4, §5.1, §5.2, D11; §7 W2 cli).
 *
 * `interface range`: the parser already resolved the ranges to canonical, existing port ids; the handler checks that
 * every port is configurable, makes each `interface <p>` section exist (as `interface <p>` alone does) and enters
 * `config-if-range` with the context entry `['interface', 'range', <ports…>]`. The runtime holds that list and
 * applies every later line to each port (cli/runtime.ts).
 *
 * `encapsulation dot1Q <vid> [native]`: accepted only on a subinterface (`CLI_MESSAGES.encapNotHere` on the
 * physical port it is offered on, so the learner is told where it belongs); a VID already carried by another
 * subinterface of the same parent is refused (`CLI_MESSAGES.duplicateVid`). The canonical line `encapsulation dot1Q
 * <vid> [native]` goes through `ctx.config`; the device runtime turns it into `PortState.dot1q` (W2 device).
 * `no encapsulation dot1Q` removes the line. Every string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandHandler } from '../../contracts/cli.js';
import { INTERFACE_RANGE_KEYWORD } from '../modes.js';
import { DOT1Q_KEYWORD, DOT1Q_NATIVE_ARG, HANDLERS, MSG_INTERFACE_NOT_CONFIGURABLE, P2_HANDLERS } from '../grammar/index.js';
import { splitInterfaceRange } from '../parser.js';
import { fillTemplate, isConfigurablePort, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';
import { MSG_UNKNOWN_INTERFACE, configHandlers } from './config.js';

/** `interface range` whose value names no port at all. */
export const MSG_RANGE_EMPTY = '% Give at least one interface or range, e.g. fa0/1 - 12, gi0/1.';

/** `interface range <ranges>`: select several existing, configurable ports at once. */
const interfaceRange: CommandHandler = (ctx, args) => {
  const ports = splitInterfaceRange(args['range'] ?? '');
  if (ports.length === 0) return { error: MSG_RANGE_EMPTY };
  for (const id of ports) {
    const view = ctx.ports.get(id);
    if (view === undefined) return { error: MSG_UNKNOWN_INTERFACE };
    if (!isConfigurablePort(ctx, view)) return { error: MSG_INTERFACE_NOT_CONFIGURABLE };
  }
  for (const id of ports) {
    const error = ctx.config(['interface', id], false, []);
    if (error !== undefined) return { error };
  }
  ctx.enterMode('config-if-range', { context: [['interface', INTERFACE_RANGE_KEYWORD, ...ports]] });
  return {};
};

/** `encapsulation dot1Q <vid> [native]` / `no encapsulation dot1Q` on a subinterface. */
const encapsulationDot1q: CommandHandler = (ctx, args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (roleOf(ctx, port) !== 'subif') return { error: fillTemplate(CLI_MESSAGES.encapNotHere, { port: port.id }) };
  if (negate) return outcomeOf(ctx.config(['encapsulation'], true));
  const vid = Number(args['vid']);
  if (!Number.isInteger(vid) || vid < 1 || vid > 4094) return { error: '% Give a VLAN number between 1 and 4094.' };
  const parent = port.spec.parent;
  for (const other of ctx.ports.values()) {
    if (other.id === port.id || parent === undefined || other.spec.parent !== parent) continue;
    if (other.dot1q?.vid === vid) return { error: fillTemplate(CLI_MESSAGES.duplicateVid, { vlan: vid, other: other.id }) };
  }
  const native = args[DOT1Q_NATIVE_ARG] === 'native' ? ['native'] : [];
  return outcomeOf(ctx.config(['encapsulation', DOT1Q_KEYWORD, String(vid), ...native], false));
};

/** @since P2 Registry fragment: interface ranges and subinterface encapsulation. */
export const subifHandlers: Readonly<Record<string, CommandHandler>> = {
  // `interface <parent>.<n>` is the P1 `interface` handler (it creates the subinterface and enters config-subif;
  // `no` removes it) under a P2 id, so the P2 fragment rule (every P2 spec has a P2 handler id) holds.
  [P2_HANDLERS.configSubinterface]: configHandlers[HANDLERS.configInterface]!,
  [P2_HANDLERS.configInterfaceRange]: interfaceRange,
  [P2_HANDLERS.ifEncapsulationDot1q]: encapsulationDot1q,
};
