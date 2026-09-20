/**
 * cli/handlers/host.ts — host shell Wi-Fi and adapter handlers (ARCHITECTURE-P1 §3.13, §6 "Host shell expansions").
 *
 *   host.wifi-list        `wifi list` — the Wi-Fi adapter's configured network and association, then the networks
 *                         the station daemon last saw (it is asked to refresh its scan list, `wlan.scan`)
 *   host.wifi-connect     `wifi connect <ssid> [key <pass>]` → under `interface <Wi-Fi adapter>`:
 *                         `security open|wpa2-psk|wpa3-sae`, `passphrase <pass>` (or `no passphrase`), then
 *                         `ssid <ssid>`. With a key the security mode is the one the network advertises (what the
 *                         adapter hears now, else the station daemon's last scan): WPA3 personal when the strongest
 *                         BSS of that name runs wpa3-sae, otherwise WPA2 personal.
 *   host.wifi-disconnect  `wifi disconnect` → `no ssid`
 *   host.adapter          `adapter <if> up|down` → interface `no shutdown` / `shutdown`
 *
 * Expansions write exactly the canonical lines of §6 through `ctx.config` with an explicit interface context, so the
 * running-config looks like a network OS's. The SSID is written last: the station starts scanning when it appears.
 * Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { Dot11AssocRow } from '../../contracts/tables.js';
import type { VisibleBss } from '../../contracts/medium.js';
import { HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { interfaceLine, isPrintableAscii, roleOf } from './common.js';
import { hostAdapters } from './pc.js';
import { PASSPHRASE_MAX, PASSPHRASE_MIN } from './wireless.js';

/** Error when the host has no Wi-Fi adapter. */
export const MSG_NO_WIFI_ADAPTER = '% This device has no Wi-Fi adapter.';
/** Daemon that owns station association (scan list in its StateView). */
export const WLAN_CLIENT_PROCESS = 'wlan-client';

/** One station port's entry in the `wlan-client` StateView (`state.ports[]`); the passphrase is never in it. */
export interface StationStateEntry {
  port: PortId;
  state?: string;
  reason?: string;
  ssid?: string;
  security?: string;
  bssid?: string;
  keyFailures?: number;
  candidates: { bssid: string; ssid: string; security: string; band?: string; channel?: number; rssiDbm?: number }[];
}

/** The `wlan-client` daemon's entry for `port`, or undefined when the daemon is absent or has not seen the port. */
export function stationState(ctx: CommandCtx, port: PortId): StationStateEntry | undefined {
  const ports = ctx.processState(WLAN_CLIENT_PROCESS)?.state?.['ports'];
  if (!Array.isArray(ports)) return undefined;
  for (const e of ports) {
    if (e === null || typeof e !== 'object' || (e as Record<string, unknown>)['port'] !== port) continue;
    const o = e as Record<string, unknown>;
    const out: StationStateEntry = { port, candidates: [] };
    for (const k of ['state', 'reason', 'ssid', 'security', 'bssid'] as const) {
      if (typeof o[k] === 'string') out[k] = o[k] as string;
    }
    if (typeof o['keyFailures'] === 'number') out.keyFailures = o['keyFailures'];
    if (Array.isArray(o['candidates'])) {
      for (const c of o['candidates'] as unknown[]) {
        if (c === null || typeof c !== 'object') continue;
        const r = c as Record<string, unknown>;
        if (typeof r['bssid'] !== 'string' || typeof r['ssid'] !== 'string') continue;
        const cand: StationStateEntry['candidates'][number] = { bssid: r['bssid'], ssid: r['ssid'], security: typeof r['security'] === 'string' ? r['security'] : 'open' };
        if (typeof r['band'] === 'string') cand.band = r['band'];
        if (typeof r['channel'] === 'number') cand.channel = r['channel'];
        if (typeof r['rssiDbm'] === 'number') cand.rssiDbm = r['rssiDbm'];
        out.candidates.push(cand);
      }
    }
    return out;
  }
  return undefined;
}

/** The host's Wi-Fi station adapter: the first adapter that is a wlan port in the wireless-client role. */
export function wifiAdapter(ctx: CommandCtx): PortView | undefined {
  for (const p of hostAdapters(ctx)) if (p.spec.kind === 'wlan' && roleOf(ctx, p) === 'wireless-client') return p;
  for (const p of ctx.ports.values()) if (p.spec.kind === 'wlan' && roleOf(ctx, p) === 'wireless-client') return p;
  return undefined;
}

/** Whether a value has the shape of a `VisibleBss` (medium.ts). */
function isVisibleBss(v: unknown): v is VisibleBss {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['ssid'] === 'string' && typeof o['bssid'] === 'string' && typeof o['rssiDbm'] === 'number';
}

/** Read `obj[k1][k2]…` through plain objects. */
function dig(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Networks the station daemon reports for `port`, read from its StateView. Accepted shapes (first array found):
 * `state.ports[port].visible`, `state.ports[port].scan`, `state.scan[port]`, `state.visible`. Entries that do not
 * have the `VisibleBss` shape are ignored; the result keeps the daemon's order (RSSI descending).
 */
export function visibleNetworks(state: Record<string, unknown> | undefined, port: PortId): VisibleBss[] {
  if (state === undefined) return [];
  const candidates = [dig(state, 'ports', port, 'visible'), dig(state, 'ports', port, 'scan'), dig(state, 'scan', port), dig(state, 'visible')];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter(isVisibleBss);
  }
  return [];
}

/** `wifi list`. */
const wifiList: CommandHandler = (ctx) => {
  const port = wifiAdapter(ctx);
  if (port === undefined) return { error: MSG_NO_WIFI_ADAPTER };
  const lines: string[] = [];
  const ssid = interfaceLine(ctx, port.id, ['ssid'])?.join(' ');
  const assoc = ctx.tables.get?.<Dot11AssocRow>('dot11-assoc')?.rows().find((r) => r.port === port.id);
  if (ssid === undefined) {
    lines.push(`${port.id}: not connected to a wireless network.`);
  } else if (assoc !== undefined) {
    const signal = assoc.rssiDbm === undefined ? '' : `, signal ${assoc.rssiDbm} dBm`;
    lines.push(`${port.id}: network "${ssid}", ${assoc.state}${signal}.`);
  } else {
    lines.push(`${port.id}: network "${ssid}", ${port.operUp ? 'connected' : 'not connected yet'}.`);
  }
  if (ctx.processState(WLAN_CLIENT_PROCESS) !== undefined) ctx.request(WLAN_CLIENT_PROCESS, { kind: 'wlan.scan', port: port.id });
  const seen = visibleNetworks(ctx.processState(WLAN_CLIENT_PROCESS)?.state, port.id);
  lines.push('');
  if (seen.length === 0) {
    lines.push('No wireless networks have been seen yet. Run the command again in a moment.');
  } else {
    const rows: string[][] = [['Network', 'Security', 'Band', 'Channel', 'Signal']];
    for (const b of seen) rows.push([b.ssid === '' ? '(hidden)' : b.ssid, b.security, `${b.band} GHz`, String(b.channel), `${b.rssiDbm} dBm`]);
    lines.push(table(rows));
  }
  return { output: lines.join('\n') };
};

/**
 * Security a keyed `wifi connect` uses for `ssid`: the mode of the strongest BSS with that name the adapter hears
 * (`ctx.air`), else of the station daemon's scan results (a refresh is requested when there is no RF view);
 * wpa3-sae only when that BSS runs
 * it, wpa2-psk otherwise (also when nothing has been heard).
 */
function keyedSecurity(ctx: CommandCtx, port: PortId, ssid: string): 'wpa2-psk' | 'wpa3-sae' {
  let best: { security: string; rssiDbm: number } | undefined;
  const consider = (b: { ssid: string; security: string; rssiDbm?: number }): void => {
    if (b.ssid !== ssid) return;
    const rssiDbm = b.rssiDbm ?? -1000;
    if (best === undefined || rssiDbm > best.rssiDbm) best = { security: b.security, rssiDbm };
  };
  for (const b of ctx.air.visibleBss(port)) consider(b);
  if (best === undefined) {
    for (const b of visibleNetworks(ctx.processState(WLAN_CLIENT_PROCESS)?.state, port)) consider(b);
    for (const b of stationState(ctx, port)?.candidates ?? []) consider(b);
  }
  return best?.security === 'wpa3-sae' ? 'wpa3-sae' : 'wpa2-psk';
}

/** `wifi connect <ssid> [key <passphrase>]`. */
const wifiConnect: CommandHandler = (ctx, args) => {
  const port = wifiAdapter(ctx);
  if (port === undefined) return { error: MSG_NO_WIFI_ADAPTER };
  const ssid = args['ssid'] ?? '';
  const key = args['key'];
  if (ssid === '' || !isPrintableAscii(ssid)) return { error: '% Give the name of the network to join.' };
  if (key !== undefined && (key.length < PASSPHRASE_MIN || key.length > PASSPHRASE_MAX || !isPrintableAscii(key))) {
    return { error: `% A passphrase has ${PASSPHRASE_MIN} to ${PASSPHRASE_MAX} printable characters.` };
  }
  const security = key === undefined ? 'open' : keyedSecurity(ctx, port.id, ssid);
  const context = [['interface', port.id]];
  const steps: [string[], boolean][] = [
    [['security', security], false],
    key === undefined ? [['passphrase'], true] : [['passphrase', key], false],
    [['ssid', ssid], false],
  ];
  for (const [line, negate] of steps) {
    const error = ctx.config(line, negate, context);
    if (error !== undefined) return { error };
  }
  const how = security === 'open' ? 'as an open network' : `with ${security === 'wpa3-sae' ? 'WPA3' : 'WPA2'} personal security`;
  const disabled = port.adminUp ? '' : ` The adapter is disabled; enable it with "adapter ${port.id} up".`;
  return { output: `${port.id} is joining "${ssid}" ${how}. Use "ipconfig" to see when it is connected.${disabled}` };
};

/** `wifi disconnect`. */
const wifiDisconnect: CommandHandler = (ctx) => {
  const port = wifiAdapter(ctx);
  if (port === undefined) return { error: MSG_NO_WIFI_ADAPTER };
  const ssid = interfaceLine(ctx, port.id, ['ssid'])?.join(' ');
  if (ssid === undefined) return { output: `${port.id} is not connected to a wireless network.` };
  const error = ctx.config(['ssid'], true, [['interface', port.id]]);
  if (error !== undefined) return { error };
  return { output: `${port.id} has left "${ssid}".` };
};

/** `adapter <if> up|down`. */
const adapter: CommandHandler = (ctx, args) => {
  const raw = args['iface'] ?? '';
  const port = ctx.ports.has(raw) ? raw : ctx.resolvePort(raw);
  if (port === undefined || !ctx.ports.has(port)) return { error: '% No such network adapter on this device.' };
  const up = args['state'] === 'up';
  const error = ctx.config(['shutdown'], up, [['interface', port]]);
  if (error !== undefined) return { error };
  return { output: `${port} is now ${up ? 'enabled' : 'disabled'}.` };
};

/** Registry fragment for the CLI runtime: host shell handler id → handler. */
export const hostHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.hostWifiList]: wifiList,
  [HANDLERS.hostWifiConnect]: wifiConnect,
  [HANDLERS.hostWifiDisconnect]: wifiDisconnect,
  [HANDLERS.hostAdapter]: adapter,
};
