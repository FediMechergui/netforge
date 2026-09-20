/**
 * cli/handlers/switchport.ts — `switchport` / `no switchport` (ARCHITECTURE-P1 D3, §3.10, §6).
 *
 * `no switchport` asks for the routed role and `switchport` for the switched role. A port whose `allowedRoles` lack
 * the target answers `CLI_MESSAGES.roleLocked` before anything is written (an NF-C2960 port, a routed router port).
 * Otherwise the line goes through `ctx.config`: the device runtime special-cases it before the AST mutation and runs
 * `setPortRole` (address withdrawal, link bounce, `portsVersion`, `portState` with reason `role-change`); the AST
 * keeps `no switchport` as a stored negation so the role survives save and reload.
 */
import { CLI_MESSAGES, type CommandHandler } from '../../contracts/cli.js';
import type { PortRole } from '../../contracts/catalog.js';
import { HANDLERS } from '../grammar/index.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';

/** `switchport` / `no switchport`. */
const switchport: CommandHandler = (ctx, _args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const target: PortRole = negate ? 'routed' : 'switched';
  const allowed = port.spec.allowedRoles ?? [port.spec.role ?? roleOf(ctx, port)];
  if (!allowed.includes(target)) return { error: CLI_MESSAGES.roleLocked };
  return outcomeOf(ctx.config(['switchport'], negate));
};

/** Registry fragment for the CLI runtime: switchport handler id → handler. */
export const switchportHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifSwitchport]: switchport,
};
