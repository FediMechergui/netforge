/**
 * cli/handlers/serial.ts — serial WAN interface handlers (ARCHITECTURE-P1 D6, §3.9, §6).
 *
 *   if.clock-rate     `clock rate <bps>` / `no clock rate` — a standard rate; on a DTE cable end the line is stored
 *                     with an informational note (only the DCE end clocks the line)
 *   if.encapsulation  `encapsulation hdlc` / `no encapsulation`; `encapsulation ppp` is refused (reserved, P3)
 *   if.bandwidth      `bandwidth <kbps>` / `no bandwidth`
 *   if.keepalive      `keepalive [<s>]`, `keepalive 0`, `no keepalive` (stored negation read by the hdlc daemon)
 *
 * Every handler writes the canonical line through `ctx.config`; the runtime renders `phySettings` and `encap` from
 * the running-config and notifies the link model. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortView } from '../../contracts/port.js';
import { HANDLERS, MSG_NOT_SERIAL } from '../grammar/index.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedPort } from './common.js';

/** Clock rates a serial DCE end accepts, in bits per second (ascending). */
export const STANDARD_CLOCK_RATES: readonly number[] = Object.freeze([
  1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 56000, 57600, 64000, 72000, 115200, 125000, 128000, 148000,
  250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000, 8000000,
]);

/** Refusal of `encapsulation ppp` (reserved framing). */
export const MSG_PPP_NOT_AVAILABLE = '% PPP framing is not available in this release. Serial interfaces use HDLC.';
/** Note printed when `clock rate` is set on the DTE end of a serial cable. */
export const NOTE_CLOCK_ON_DTE = 'Note: this interface is the DTE end of its cable, so the clock rate is stored but not used. Set it on the DCE end.';

/** The selected serial port, or an error outcome. */
function serialPort(ctx: CommandCtx): PortView | { error: string } {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (port.spec.kind !== 'serial') return { error: MSG_NOT_SERIAL };
  return port;
}

function isError(v: PortView | { error: string }): v is { error: string } {
  return 'error' in v;
}

/** `clock rate <bps>` / `no clock rate`. */
const clockRate: CommandHandler = (ctx, args, negate) => {
  const port = serialPort(ctx);
  if (isError(port)) return port;
  if (negate) return outcomeOf(ctx.config(['clock', 'rate'], true));
  const bps = Number(args['bps'] ?? '');
  if (!STANDARD_CLOCK_RATES.includes(bps)) {
    return { error: `% ${args['bps'] ?? ''} is not a supported clock rate. Choose one of: ${STANDARD_CLOCK_RATES.join(', ')}.` };
  }
  const error = ctx.config(['clock', 'rate', String(bps)], false);
  if (error !== undefined) return { error };
  return port.phy?.dce === false ? { output: NOTE_CLOCK_ON_DTE } : {};
};

/** `encapsulation hdlc|ppp` / `no encapsulation`. */
const encapsulation: CommandHandler = (ctx, args, negate) => {
  const port = serialPort(ctx);
  if (isError(port)) return port;
  if (negate) return outcomeOf(ctx.config(['encapsulation'], true));
  const framing = args['framing'] ?? '';
  if (framing === 'ppp') return { error: MSG_PPP_NOT_AVAILABLE };
  if (framing !== 'hdlc') return { error: '% Expected hdlc as the framing.' };
  return outcomeOf(ctx.config(['encapsulation', 'hdlc'], false));
};

/** `bandwidth <kbps>` / `no bandwidth`. */
const bandwidth: CommandHandler = (ctx, args, negate) => {
  const port = serialPort(ctx);
  if (isError(port)) return port;
  if (negate) return outcomeOf(ctx.config(['bandwidth'], true));
  const kbps = args['kbps'];
  if (kbps === undefined || kbps === '') return { error: '% A bandwidth in kilobits per second is required.' };
  return outcomeOf(ctx.config(['bandwidth', kbps], false));
};

/** `keepalive [<seconds>]` / `no keepalive`. */
const keepalive: CommandHandler = (ctx, args, negate) => {
  const port = serialPort(ctx);
  if (isError(port)) return port;
  if (negate) return outcomeOf(ctx.config(['keepalive'], true));
  const seconds = args['seconds'];
  return outcomeOf(ctx.config(seconds === undefined ? ['keepalive'] : ['keepalive', seconds], false));
};

/** Registry fragment for the CLI runtime: serial handler id → handler. */
export const serialHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifClockRate]: clockRate,
  [HANDLERS.ifEncapsulation]: encapsulation,
  [HANDLERS.ifBandwidth]: bandwidth,
  [HANDLERS.ifKeepalive]: keepalive,
};
