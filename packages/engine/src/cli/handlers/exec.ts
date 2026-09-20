/**
 * cli/handlers/exec.ts — EXEC-level command handlers (spec §7.1, §7.3, §7.5; ARCHITECTURE "P0 CLI surface",
 * "Ping flow"; ARCHITECTURE-P1 §3.13 Modes).
 *
 * Mode navigation (`enable`, `disable`, `configure terminal`, `end`, `exit`, `logout`), the ping job launcher,
 * configuration persistence (`copy running-config startup-config`, `write`, `erase startup-config`, `reload`), table
 * clearing and the diagnostic-trace switches (`debug …`, `undebug all`, `no debug all`).
 *
 * Mode changes follow the mode registry (cli/modes.ts): `exit` pops a configuration-class mode to its parent with the
 * context truncated, and closes the session from an EXEC-class mode; `end` returns to privileged EXEC. Handlers use
 * `CommandCtx.enterMode` when the runtime offers it and the P0 `setMode` otherwise.
 *
 * Handlers are pure functions of `CommandCtx`; anything asynchronous goes through `ctx.request` (the ping job lives in
 * the icmpv4 daemon and unblocks the session with `cliDone`). The three handlers that need the CLI runtime itself —
 * `debug`, `undebug all` and `do` — are produced by `createRuntimeHandlers(services)`.
 *
 * Every user-facing string here is original wording (spec §1.6).
 */
import type { CliMode, CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import type { DeviceId, SessionId } from '../../contracts/ids.js';
import { isIpv4Broadcast, isIpv4Multicast, parseIpv4 } from '../../contracts/addr.js';
import { SEC } from '../../contracts/time.js';
import { DEBUG_CATEGORIES, DEBUG_CATEGORY_ARG, HANDLERS } from '../grammar/index.js';
import { exitTarget, isConfigClassMode } from '../modes.js';
import { PASSWORD_PROMPT } from '../secrets.js';
import { enterMode, sessionContext } from './common.js';
import { enableSecretOf } from './line-auth.js';

/** Echo requests sent by a plain `ping <target>` (ARCHITECTURE "P0 CLI surface"). */
export const PING_COUNT = 5;
/** Per-echo timeout of a plain `ping`. */
export const PING_TIMEOUT_NS = 2 * SEC;
/** IPv4 datagram total length of a plain `ping` echo. */
export const PING_SIZE_BYTES = 100;

/** Message for `ping` on a device that runs no IPv4 stack (P0 switches). */
export const MSG_NO_IP_STACK = '% This device has no IPv4 stack to send echo requests from.';
/** Message for an address that can never be a ping target. */
export const MSG_BAD_PING_TARGET = '% That address cannot be the target of an echo request.';

/** Name of the daemon that owns the ping job (ARCHITECTURE "Ping flow"). */
const ICMP_PROCESS = 'icmpv4';

/**
 * What the runtime-bound handlers need from `cli/runtime.ts`. Defined here (not in the contracts) so the dependency
 * points handlers → runtime services only at call time.
 */
export interface CliRuntimeServices {
  /** Enable a debug category (or `'all'`) for every session on `device`. */
  debugEnable(device: DeviceId, category: string): void;
  /** Disable one category on `device` (`no debug <cat>`). */
  debugDisable(device: DeviceId, category: string): void;
  /** Disable every category on `device` (`undebug all`, `no debug all`). */
  debugDisableAll(device: DeviceId): void;
  /** Currently enabled categories on `device`, in enable order. */
  debugEnabled(device: DeviceId): string[];
  /** Run `line` on `session` as if typed in `mode` (backs the `do` fallback handler). */
  exec(session: SessionId, line: string, mode: CliMode): CommandOutcome;
}

/** Grant privilege 15 and move to privileged EXEC. */
function grantEnable(ctx: CommandCtx): CommandOutcome {
  ctx.setPrivilege(15);
  enterMode(ctx, 'priv-exec', []);
  return {};
}

/**
 * `enable`: privilege 15, privileged EXEC. With an `enable secret` (or `enable password`) stored, the command asks
 * for it first (ARCHITECTURE-P1 §4.10): the answer is verified in `resume`, a wrong one asks the SAME question
 * again, and the runtime ends the command with its denial after MAX_INPUT_ATTEMPTS wrong answers.
 */
const enable: CommandHandler = (ctx) => {
  const stored = enableSecretOf(ctx.running);
  if (stored === undefined) return grantEnable(ctx);
  const resume = (rctx: CommandCtx, answer: string): CommandOutcome =>
    (rctx.secrets.verify(stored, answer) ? grantEnable(rctx) : { ask: { request: { ...PASSWORD_PROMPT }, resume } });
  return { ask: { request: { ...PASSWORD_PROMPT }, resume } };
};

/** `disable`: back to user EXEC at privilege 1. */
const disable: CommandHandler = (ctx) => {
  ctx.setPrivilege(1);
  enterMode(ctx, 'user-exec', []);
  return {};
};

/** `exit`: one level up within configuration modes; from an EXEC mode the session closes. */
const exit: CommandHandler = (ctx) => {
  const mode = ctx.session.mode;
  if (!isConfigClassMode(mode)) {
    ctx.closeSession();
    return {};
  }
  const target = exitTarget(mode, sessionContext(ctx));
  if (target.close) {
    ctx.closeSession();
    return {};
  }
  enterMode(ctx, target.mode, target.context);
  return {};
};

/** `logout`: close the session from any EXEC mode. */
const logout: CommandHandler = (ctx) => {
  ctx.closeSession();
  return {};
};

/** `end`: straight back to privileged EXEC from any configuration mode. */
const end: CommandHandler = (ctx) => {
  enterMode(ctx, 'priv-exec', []);
  return {};
};

/** `configure terminal`: enter global configuration. */
const configure: CommandHandler = (ctx) => {
  enterMode(ctx, 'config', []);
  return {};
};

/** Start the icmpv4 echo job for `target` (an address or, from the name form, a name) and block until `cliDone`. */
function startPing(ctx: CommandCtx, target: string): CommandOutcome {
  if (ctx.processState(ICMP_PROCESS) === undefined) return { error: MSG_NO_IP_STACK };
  // Block BEFORE the request: a job that finishes synchronously (no route) sends `cliDone`
  // during the request, which must clear the flag rather than be overwritten by it.
  ctx.block();
  ctx.request(ICMP_PROCESS, {
    kind: 'icmp.ping',
    session: ctx.session.id,
    target,
    count: PING_COUNT,
    timeoutNs: PING_TIMEOUT_NS,
    sizeBytes: PING_SIZE_BYTES,
  });
  // No header here: the icmpv4 job prints the single "Sending N echo requests …" line itself.
  return {};
}

/** `ping <target>`: start the icmpv4 echo job and block the session until `cliDone`. */
const ping: CommandHandler = (ctx, args) => {
  const target = args['target'] ?? '';
  const v = parseIpv4(target);
  if (v === null) return { error: '% Expected an IPv4 address in dotted-decimal form (A.B.C.D).' };
  if (v === 0 || isIpv4Broadcast(target) || isIpv4Multicast(target)) return { error: MSG_BAD_PING_TARGET };
  return startPing(ctx, target);
};

/** `ping <name>`: the same job, with the name resolved by icmpv4 through dns-client (§4.7, §4.8). */
const pingName: CommandHandler = (ctx, args) => {
  const name = (args['name'] ?? '').trim();
  if (name === '') return { error: '% Give the name of the host to reach.' };
  return startPing(ctx, name);
};

/** `copy running-config startup-config` / `write [memory]`. */
const saveConfig: CommandHandler = (ctx) => {
  ctx.device.saveConfig();
  return { output: 'Configuration saved to startup-config.' };
};

/** `erase startup-config`. */
const eraseStartup: CommandHandler = (ctx) => {
  ctx.device.eraseStartup();
  return { output: 'Startup configuration erased. The device will start with an empty configuration next time.' };
};

/** `reload`: restart the device; the console session ends with it. */
const reload: CommandHandler = (ctx) => {
  ctx.device.reload();
  ctx.closeSession();
  return { output: 'Restarting the device now. This session is closed; open the console again once it is back up.' };
};

/** `clear arp-cache`. */
const clearArp: CommandHandler = (ctx) => {
  ctx.device.clearTable('arp');
  return {};
};

/** `clear mac address-table dynamic`. */
const clearMac: CommandHandler = (ctx) => {
  ctx.device.clearTable('cam');
  return {};
};

/**
 * EXEC handlers that need nothing beyond `CommandCtx`, keyed by the grammar's handler ids. `exec.debug`,
 * `exec.undebug-all` and `exec.do` are NOT here — see `createRuntimeHandlers`.
 */
export const execHandlers: Record<string, CommandHandler> = {
  [HANDLERS.execEnable]: enable,
  [HANDLERS.execDisable]: disable,
  [HANDLERS.execExit]: exit,
  [HANDLERS.execLogout]: logout,
  [HANDLERS.execEnd]: end,
  [HANDLERS.execConfigure]: configure,
  [HANDLERS.execPing]: ping,
  [HANDLERS.execPingName]: pingName,
  [HANDLERS.execCopyRunStart]: saveConfig,
  [HANDLERS.execWrite]: saveConfig,
  [HANDLERS.execEraseStartup]: eraseStartup,
  [HANDLERS.execReload]: reload,
  [HANDLERS.execClearArp]: clearArp,
  [HANDLERS.execClearMac]: clearMac,
};

/** Human label for a debug category in confirmation lines. */
function categoryLabel(category: string): string {
  return category === 'all' ? 'all categories' : category;
}

/**
 * Build the handlers that talk to the CLI runtime: `debug <category>` / `no debug <category>` (`exec.debug`),
 * `undebug all` (`exec.undebug-all`) and the `do <command>` fallback (`exec.do`, normally shadowed by the parser's
 * `do` prefix). The runtime merges the result over the registry it was given.
 */
export function createRuntimeHandlers(services: CliRuntimeServices): Record<string, CommandHandler> {
  const debug: CommandHandler = (ctx: CommandCtx, args, negate) => {
    const category = args[DEBUG_CATEGORY_ARG] ?? '';
    if (category !== 'all' && !DEBUG_CATEGORIES.includes(category)) {
      return { error: `% Unknown debug category. Choose one of: ${DEBUG_CATEGORIES.join(', ')}, all.` };
    }
    if (negate) {
      if (category === 'all') {
        services.debugDisableAll(ctx.deviceId);
        return { output: 'All diagnostic tracing has been turned off.' };
      }
      services.debugDisable(ctx.deviceId, category);
      return { output: `Debugging disabled for ${categoryLabel(category)}.` };
    }
    services.debugEnable(ctx.deviceId, category);
    return { output: `Debugging enabled for ${categoryLabel(category)}.` };
  };

  const undebugAll: CommandHandler = (ctx) => {
    services.debugDisableAll(ctx.deviceId);
    return { output: 'All diagnostic tracing has been turned off.' };
  };

  const doCommand: CommandHandler = (ctx, args) => {
    const line = (args['command'] ?? '').trim();
    if (line === '') return { error: '% Give the privileged command to run after "do".' };
    return services.exec(ctx.session.id, line, 'priv-exec');
  };

  return {
    [HANDLERS.execDebug]: debug,
    [HANDLERS.execUndebugAll]: undebugAll,
    [HANDLERS.execDo]: doCommand,
  };
}
