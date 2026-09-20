/**
 * cli/handlers/wireless.ts — radio interface handlers (ARCHITECTURE-P1 D5, §3.6, §3.7, §6; contracts/rf.ts
 * `RadioSettings`).
 *
 *   if.ssid           `ssid <name>` / `no ssid` (Wi-Fi radios; up to 32 characters)
 *   if.security       `security open|wpa2-psk|wpa3-sae` / `no security`
 *   if.passphrase     `passphrase <text>` / `no passphrase` (8–63 printable characters; a secret token)
 *   if.band           `band 2.4|5|6|60` / `no band` — must be a band of the port's `RadioPortSpec`; a stored channel
 *                     that does not exist on the new band is cleared with a note
 *   if.channel        `channel <n>|auto` / `no channel` — a channel of `CHANNELS[band]`; `auto` on Wi-Fi radios only
 *   if.channel-width  `channel-width 20|40|80|160` — at most the radio's maximum; fixed on 60 GHz
 *   if.tx-power       `tx-power <dBm>` — at most the radio's maximum transmit power
 *   if.peer-key       `peer-key <key>` / `no peer-key` (point-to-point radios; 4–64 printable characters; secret)
 *   if.beacons        `beacons` / `no beacons` (access radios; NetForge extension)
 *
 * Handlers only validate and write the canonical lines; the runtime renders `radioSettings` and the link model
 * applies them. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import type { PortView } from '../../contracts/port.js';
import { CHANNELS, radioModeOf, type RfBand } from '../../contracts/rf.js';
import { HANDLERS, MSG_NOT_ACCESS_RADIO, MSG_NOT_PTP, MSG_NOT_RADIO, MSG_NOT_WLAN } from '../grammar/index.js';
import { interfaceLine, isPrintableAscii, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';

/** Wi-Fi passphrase length limits (WPA personal). */
export const PASSPHRASE_MIN = 8;
/** Longest accepted Wi-Fi passphrase. */
export const PASSPHRASE_MAX = 63;
/** Point-to-point pairing key length limits. */
export const PEER_KEY_MIN = 4;
/** Longest accepted pairing key. */
export const PEER_KEY_MAX = 64;
/** Error for `channel auto` on a point-to-point radio. */
export const MSG_AUTO_CHANNEL_PTP = '% Both ends of a point-to-point link need the same fixed channel; auto is not available here.';
/** Error for `channel-width` on the 60 GHz band. */
export const MSG_WIDTH_FIXED_60 = '% The 60 GHz band always uses its full 2160 MHz channel.';

type PortOrError = PortView | CommandOutcome;

function isPort(v: PortOrError): v is PortView {
  return 'spec' in v;
}

/** The selected port when its kind is one of `kinds`, else an error outcome. */
function radioPort(ctx: CommandCtx, kinds: readonly PortView['spec']['kind'][], mismatch: string): PortOrError {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (!kinds.includes(port.spec.kind)) return { error: mismatch };
  return port;
}

/** Band currently in effect on a radio port: the stored `band` line, else the radio's default. */
export function effectiveBand(ctx: CommandCtx, port: PortView): RfBand {
  const stored = interfaceLine(ctx, port.id, ['band'])?.[0];
  return (stored as RfBand | undefined) ?? port.spec.radio?.defaultBand ?? '2.4';
}

/** Valid channels of a band (`cell` has none). */
function channelsOf(band: RfBand): readonly number[] {
  return band === 'cell' ? [] : CHANNELS[band];
}

/** `ssid <name>` / `no ssid`. */
const ssid: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan'], MSG_NOT_WLAN);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['ssid'], true));
  const name = (args['name'] ?? '').trim();
  if (name === '') return { error: '% A network name is required.' };
  if (!isPrintableAscii(name)) return { error: '% Network names use printable characters only.' };
  return outcomeOf(ctx.config(['ssid', name], false));
};

/** `security <mode>` / `no security`. */
const security: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan'], MSG_NOT_WLAN);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['security'], true));
  const mode = args['mode'] ?? '';
  if (mode !== 'open' && mode !== 'wpa2-psk' && mode !== 'wpa3-sae') return { error: '% Expected open, wpa2-psk or wpa3-sae.' };
  return outcomeOf(ctx.config(['security', mode], false));
};

/** `passphrase <text>` / `no passphrase`. */
const passphrase: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan'], MSG_NOT_WLAN);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['passphrase'], true));
  const text = (args['text'] ?? '').trim();
  if (text.length < PASSPHRASE_MIN || text.length > PASSPHRASE_MAX || !isPrintableAscii(text)) {
    return { error: `% A passphrase has ${PASSPHRASE_MIN} to ${PASSPHRASE_MAX} printable characters.` };
  }
  return outcomeOf(ctx.config(['passphrase', text], false));
};

/** Clear a stored channel that the band `band` does not have; returns a note or undefined. */
function clearStaleChannel(ctx: CommandCtx, port: PortView, band: RfBand): string | undefined {
  const stored = interfaceLine(ctx, port.id, ['channel'])?.[0];
  if (stored === undefined || stored === 'auto') return undefined;
  if (channelsOf(band).includes(Number(stored))) return undefined;
  const error = ctx.config(['channel'], true);
  if (error !== undefined) return error;
  return `Channel ${stored} does not exist on the ${band} GHz band, so the channel setting was cleared.`;
}

/** `band <band>` / `no band`. */
const band: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan', 'radio'], MSG_NOT_RADIO);
  if (!isPort(port)) return port;
  const radio = port.spec.radio;
  if (negate) {
    const error = ctx.config(['band'], true);
    if (error !== undefined) return { error };
    const note = clearStaleChannel(ctx, port, radio?.defaultBand ?? '2.4');
    return note === undefined ? {} : { output: note };
  }
  const value = (args['band'] ?? '') as RfBand;
  if (radio !== undefined && !radio.bands.includes(value)) {
    return { error: `% This radio does not support the ${value} GHz band. Supported: ${radio.bands.join(', ')}.` };
  }
  const error = ctx.config(['band', value], false);
  if (error !== undefined) return { error };
  const note = clearStaleChannel(ctx, port, value);
  return note === undefined ? {} : { output: note };
};

/** `channel <n>|auto` / `no channel`. */
const channel: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan', 'radio'], MSG_NOT_RADIO);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['channel'], true));
  const value = (args['channel'] ?? '').toLowerCase();
  if (value === 'auto') {
    if (port.spec.kind === 'radio') return { error: MSG_AUTO_CHANNEL_PTP };
    return outcomeOf(ctx.config(['channel', 'auto'], false));
  }
  const n = Number(value);
  const current = effectiveBand(ctx, port);
  const valid = channelsOf(current);
  if (!Number.isInteger(n) || !valid.includes(n)) {
    return { error: `% Channel ${value} does not exist on the ${current} GHz band. Valid channels: ${valid.join(', ')}.` };
  }
  return outcomeOf(ctx.config(['channel', String(n)], false));
};

/** `channel-width <mhz>` / `no channel-width`. */
const channelWidth: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan', 'radio'], MSG_NOT_RADIO);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['channel-width'], true));
  if (effectiveBand(ctx, port) === '60') return { error: MSG_WIDTH_FIXED_60 };
  const mhz = Number(args['mhz'] ?? '');
  const max = port.spec.radio?.maxWidthMhz;
  if (max !== undefined && max !== 2160 && mhz > max) return { error: `% This radio supports channels up to ${max} MHz wide.` };
  return outcomeOf(ctx.config(['channel-width', String(mhz)], false));
};

/** `tx-power <dBm>` / `no tx-power`. */
const txPower: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['wlan', 'radio'], MSG_NOT_RADIO);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['tx-power'], true));
  const dbm = Number(args['dbm'] ?? '');
  const max = port.spec.radio?.maxTxPowerDbm;
  if (max !== undefined && dbm > max) return { error: `% This radio transmits at ${max} dBm at most.` };
  return outcomeOf(ctx.config(['tx-power', String(dbm)], false));
};

/** `peer-key <key>` / `no peer-key`. */
const peerKey: CommandHandler = (ctx, args, negate) => {
  const port = radioPort(ctx, ['radio'], MSG_NOT_PTP);
  if (!isPort(port)) return port;
  if (negate) return outcomeOf(ctx.config(['peer-key'], true));
  const key = (args['key'] ?? '').trim();
  if (key.length < PEER_KEY_MIN || key.length > PEER_KEY_MAX || !isPrintableAscii(key)) {
    return { error: `% A pairing key has ${PEER_KEY_MIN} to ${PEER_KEY_MAX} printable characters.` };
  }
  return outcomeOf(ctx.config(['peer-key', key], false));
};

/** `beacons` / `no beacons`. */
const beacons: CommandHandler = (ctx, _args, negate) => {
  const port = radioPort(ctx, ['wlan'], MSG_NOT_ACCESS_RADIO);
  if (!isPort(port)) return port;
  if (radioModeOf(port.spec.kind, roleOf(ctx, port)) !== 'ap') return { error: MSG_NOT_ACCESS_RADIO };
  return outcomeOf(ctx.config(['beacons'], negate));
};

/** Registry fragment for the CLI runtime: wireless handler id → handler. */
export const wirelessHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifSsid]: ssid,
  [HANDLERS.ifSecurity]: security,
  [HANDLERS.ifPassphrase]: passphrase,
  [HANDLERS.ifBand]: band,
  [HANDLERS.ifChannel]: channel,
  [HANDLERS.ifChannelWidth]: channelWidth,
  [HANDLERS.ifTxPower]: txPower,
  [HANDLERS.ifPeerKey]: peerKey,
  [HANDLERS.ifBeacons]: beacons,
};
