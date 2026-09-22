/**
 * protocols/etherchannel/static.ts — mode `on`, the static EtherChannel (ARCHITECTURE-P2 §3.7 step 8 misconfiguration
 * A, §4.3, D10), and the `channel-group` line reader.
 *
 * A static member exchanges nothing: it is `bundled` at link-up as long as it is compatible with its bundle
 * (compat.ts), `suspended` otherwise, and `down` while its link is down. It ignores every LACP and PAgP frame it
 * receives (the frame is dropped with the detail below, never bridged) and never sends one, so a `mode on` bundle
 * is silent in every profile (§4.3). The line reader and the mode → protocol mapping live here because they are what
 * makes a member static rather than negotiated.
 *
 * Pure: no state, no I/O, no clock, no randomness.
 */
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { ChannelMemberState, EtherchannelRow } from '../../contracts/tables.js';
import type { Compatibility } from './compat.js';

/** `channel-group <n> mode <mode>` modes (§5.1). */
export type ChannelMode = EtherchannelRow['mode'];
/** Protocol a mode implies: `on` static, `active`/`passive` LACP, `desirable`/`auto` PAgP [S3]. */
export type ChannelProtocol = EtherchannelRow['protocol'];
/** Every mode, in §5.1 order. */
export const CHANNEL_GROUP_MODES: readonly ChannelMode[] = Object.freeze(['on', 'active', 'passive', 'desirable', 'auto']);
/** Lowest and highest channel group (`interface Port-channel1`–`48`, D10). */
export const CHANNEL_GROUP_LOWEST = 1;
export const CHANNEL_GROUP_HIGHEST = 48;
/** Long family name of a bundle (the letters of `Port-channel1`). */
export const PORT_CHANNEL_FAMILY_NAME = 'Port-channel';

/** Protocol of a mode. */
export function protocolOfMode(mode: ChannelMode): ChannelProtocol {
  if (mode === 'on') return 'static';
  if (mode === 'active' || mode === 'passive') return 'lacp';
  return 'pagp';
}

/** True for a mode that sends without being spoken to first (`active`, `desirable`); `passive`/`auto` answer only, `on` never sends. */
export function modeInitiates(mode: ChannelMode): boolean {
  return mode === 'active' || mode === 'desirable';
}

/** Canonical name of the bundle of group `n`: `Port-channel<n>`. */
export function bundleNameOf(group: number): PortId {
  return `${PORT_CHANNEL_FAMILY_NAME}${group}`;
}

/** Group of a bundle name (`Port-channel1` → 1), else undefined. */
export function groupOfBundleName(port: PortId): number | undefined {
  const m = /^Port-channel(\d{1,2})$/.exec(port);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n >= CHANNEL_GROUP_LOWEST && n <= CHANNEL_GROUP_HIGHEST ? n : undefined;
}

/** A parsed `channel-group` line. */
export interface ChannelGroupLine {
  readonly port: PortId;
  readonly group: number;
  readonly bundle: PortId;
  readonly mode: ChannelMode;
  readonly protocol: ChannelProtocol;
}

/** The mode named by a token, else undefined. */
export function parseChannelMode(token: string | undefined): ChannelMode | undefined {
  return token !== undefined && (CHANNEL_GROUP_MODES as readonly string[]).includes(token) ? (token as ChannelMode) : undefined;
}

/** The group named by a token (1–48), else undefined. */
export function parseChannelGroup(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,2}$/.test(token)) return undefined;
  const n = Number(token);
  return n >= CHANNEL_GROUP_LOWEST && n <= CHANNEL_GROUP_HIGHEST ? n : undefined;
}

/**
 * The `channel-group <n> mode <m>` line of every interface section of `config` (storage: key `channel-group`, args
 * `[n, 'mode', m]`), in section order. A line whose group or mode does not parse is left out (the default stands: no
 * channel group); a Port-channel section itself never carries one.
 */
export function readChannelGroups(config: ConfigAst): readonly ChannelGroupLine[] {
  const out: ChannelGroupLine[] = [];
  const seen = new Set<PortId>();
  for (const c of config.root.children) {
    if (c.key !== 'interface' || c.args.length !== 1) continue;
    const port = c.args[0] as PortId;
    if (seen.has(port) || groupOfBundleName(port) !== undefined) continue;
    for (const line of c.children) {
      if (line.key !== 'channel-group' || line.args[1] !== 'mode' || line.args.length !== 3) continue;
      const group = parseChannelGroup(line.args[0]);
      const mode = parseChannelMode(line.args[2]);
      if (group === undefined || mode === undefined) continue;
      seen.add(port);
      out.push({ port, group, bundle: bundleNameOf(group), mode, protocol: protocolOfMode(mode) });
      break;
    }
  }
  return out;
}

/** True when `line` (tokens, without `no`) is a `channel-group` line. */
export function isChannelGroupLine(line: readonly string[]): boolean {
  return line[0] === 'channel-group';
}

/** The state of a static member whose link is up: bundled when compatible, else suspended with the reason. */
export function staticMemberState(compat: Compatibility): { readonly state: ChannelMemberState; readonly reason?: string } {
  return compat.ok ? { state: 'bundled' } : { state: 'suspended', reason: compat.reason };
}

/** Drop detail of a negotiation frame on a `mode on` member: `<port> is in mode on and ignores <LACP|PAgP>`. */
export function staticIgnoresDetail(port: PortId, protocol: 'LACP' | 'PAgP'): string {
  return `${port} is in mode on and ignores ${protocol}`;
}
