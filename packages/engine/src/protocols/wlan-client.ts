/**
 * protocols/wlan-client.ts — the Wi-Fi station daemon (ARCHITECTURE-P1 D5, §3.6; contracts/medium.ts authority rules).
 *
 * One state machine per station radio port (kind wlan, role wireless-client), driven by the interface lines
 * `ssid`, `security open|wpa2-psk|wpa3-sae` and `passphrase` under `interface WlanN`:
 *
 *   idle ──(carrier up, ssid set)──▶ scanning ──(dwell: best BSS)──▶ authenticating ──▶ associating
 *        ──(open: AP authorizes → link up)──────────────────────────────────────────────▶ associated
 *        ──(wpa2-psk / wpa3-sae: assoc-resp 0)──▶ handshake ──(EAPOL 1-4, AP authorizes → link up)──▶ associated
 *   any failure ──▶ failed (reason) ──▶ periodic rescan every RF.RESCAN_NS (except the final wrong-key state)
 *
 *  • Scan: `sta-state scanning`, broadcast probe request carrying the SSID, non-periodic dwell timer `scan:<port>`
 *    (RF.SCAN_DWELL_NS). Probe responses and beacons are recorded as candidates. At the end of the dwell the best
 *    BSS is picked: same SSID, same security, `canAssociate` from `ctx.air.visibleBss(port)` (without an RF view:
 *    the received-signal annotation at or above the connect threshold), RSSI descending, then BSSID ordinal.
 *    No candidate → `failed` with reason `no-bss` (or `out-of-range` after a beacon loss) and the PERIODIC timer
 *    `rescan:<port>`.
 *  • Authentication: open (wpa2-psk too) = auth algorithm 0, seq 1 → AP seq 2 status 0. wpa3-sae = algorithm 3:
 *    commit (seq 1, the simulated commit tag in `dot11.duration`) both ways, then confirm (seq 2) both ways; a
 *    confirm has status 1 when the peer's commit tag differs from ours (wrong passphrase). Every step times out
 *    after RF.STEP_TIMEOUT_NS (`step:<port>`, the last frame is re-sent); the third timeout → `failed timeout`.
 *  • Association: assoc request with the SSID and rates; status 0 → open networks wait for the AP's authorization
 *    (the medium brings the port up → onLinkChange up → `associated`); secured networks enter `handshake`.
 *    Status 17 → `failed ap-full`; other statuses → `failed rejected`.
 *  • Handshake (EAPOL-Key in 802.11 data frames, never rewrapped): message 1 → message 2 whose key data is
 *    `passphraseTag(ssid, passphrase)` (never the passphrase); message 3 → message 4. `eapol:<port>` waits
 *    RF.EAPOL_TIMEOUT_NS and re-sends the last message; the third timeout → deauthentication reason 15 and
 *    `failed handshake-timeout`.
 *  • Wrong key: a deauthentication with reason 15 (or an SAE confirm with status 1) → `failed wrong-key`. The station
 *    retries from a fresh scan until KEY_ATTEMPTS failures, then stays failed until the Wlan configuration changes.
 *  • Teardown: changing or removing ssid/security/passphrase sends a disassociation (reason 8) when associated or
 *    associating, then `sta-state idle` (and a new scan when an SSID remains). `beacon-loss` / `bss-down` from the
 *    medium restart the scan with reason `out-of-range` / `bss-down`; `bss-in-range` restarts it at once while
 *    scanning or failed with reason out-of-range | no-bss. Carrier loss → idle.
 *
 * No randomness. Timers: `scan:*`, `step:*`, `eapol:*` one-shot; `rescan:*` periodic (D10).
 * Station rows of `dot11-assoc` (key dot11AssocKey(port, station MAC)) follow the state; idle removes the row.
 *
 * `stateSnapshot()`:
 *   { process: 'wlan-client', state: { ports: [{ port, state, reason?, ssid?, security, bssid?, aid?, keyFailures,
 *     scans, candidates: [{ bssid, ssid, security, band?, channel?, rssiDbm? }] }] } }   (never the passphrase)
 *
 * Also exports the Wlan interface-config readers shared with wlan-ap and usable by the device runtime
 * (`readWlanConfig`, `readRadioSettings`). Debug category: 'wireless'. Wording is original.
 */
import type { MacAddress } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { MediumEvent, WifiAssocState } from '../contracts/medium.js';
import type { FieldValue, LayerSpec, Pdu, PduMeta } from '../contracts/pdu.js';
import { ETHERTYPE_EAPOL } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { ChannelWidthMhz, RadioMode, RadioPortSpec, RadioSettings, RfBand, WifiSecurity } from '../contracts/rf.js';
import { CHANNELS, RF, radioModeOf } from '../contracts/rf.js';
import type { Dot11AssocRow } from '../contracts/tables.js';
import { dot11AssocKey } from '../contracts/tables.js';
import {
  RATES_24,
  RATES_OFDM,
  classifyAirFrame,
  eapolFrame,
  mgmtFrame,
  mgmtSubtype,
  passphraseTag,
  probeRequestFrame,
  saeCommitTag,
  tagBytes,
} from '../link/rewrap80211.js';

/** Process name of the station daemon. */
export const WLAN_CLIENT_PROCESS = 'wlan-client';
/** Debug category of both wlan daemons (`debug wireless`). */
export const WIRELESS_DEBUG_CATEGORY = 'wireless';
/** Capacity of the per-process DebugEvent ring. */
export const WLAN_DEBUG_RING = 200;
/** Step timeouts tolerated per authentication / association step. */
export const STEP_ATTEMPTS = 3;
/** EAPOL timeouts tolerated per handshake. */
export const EAPOL_ATTEMPTS = 3;
/** Wrong-key failures after which the station stays failed until its configuration changes. */
export const KEY_ATTEMPTS = 3;
/** Authentication algorithm numbers. */
export const AUTH_OPEN = 0;
export const AUTH_SAE = 3;
/** 802.11 status and reason codes used by the simulation. */
export const STATUS_SUCCESS = 0;
export const STATUS_FAILURE = 1;
export const STATUS_AP_FULL = 17;
export const REASON_LEAVING = 8;
export const REASON_HANDSHAKE = 15;
export const REASON_CONFIG_CHANGED = 3;

/** Wlan interface lines that change an association (§6). */
export const WLAN_ASSOC_KEYS: readonly string[] = Object.freeze(['ssid', 'security', 'passphrase']);

// ── shared config readers ────────────────────────────────────────────────────

/** The Wi-Fi lines of one `interface WlanN` section. */
export interface WlanPortConfig {
  ssid?: string;
  security: WifiSecurity;
  passphrase?: string;
  band?: RfBand;
  channel?: number | 'auto';
  widthMhz?: ChannelWidthMhz;
  txPowerDbm?: number;
  beacons: boolean;
  shutdown: boolean;
}

const SECURITIES: readonly WifiSecurity[] = ['open', 'wpa2-psk', 'wpa3-sae'];
const BANDS: readonly RfBand[] = ['2.4', '5', '6', '60'];
const WIDTHS: readonly ChannelWidthMhz[] = [20, 40, 80, 160, 2160];

/** The `interface <port>` section node of a config tree, if present. */
export function interfaceSection(config: ConfigAst, port: PortId): ConfigNode | undefined {
  return config.root.children.find((n) => n.key === 'interface' && n.args[0] === port);
}

/** Read the Wi-Fi lines of `interface <port>` (defaults: open, no SSID, no beacons). */
export function readWlanConfig(config: ConfigAst, port: PortId): WlanPortConfig {
  const out: WlanPortConfig = { security: 'open', beacons: false, shutdown: false };
  const section = interfaceSection(config, port);
  if (section === undefined) return out;
  for (const node of section.children) {
    const arg = node.args[0];
    switch (node.key) {
      case 'ssid':
        if (arg !== undefined && arg !== '') out.ssid = node.args.join(' ');
        break;
      case 'security':
        if (arg !== undefined && (SECURITIES as readonly string[]).includes(arg)) out.security = arg as WifiSecurity;
        break;
      case 'passphrase':
        if (arg !== undefined) out.passphrase = node.args.join(' ');
        break;
      case 'band':
        if (arg !== undefined && (BANDS as readonly string[]).includes(arg)) out.band = arg as RfBand;
        break;
      case 'channel':
        if (arg === 'auto') out.channel = 'auto';
        else if (arg !== undefined && /^\d+$/.test(arg)) out.channel = Number(arg);
        break;
      case 'channel-width':
        if (arg !== undefined && (WIDTHS as readonly number[]).includes(Number(arg))) out.widthMhz = Number(arg) as ChannelWidthMhz;
        break;
      case 'tx-power':
        if (arg !== undefined && /^-?\d+$/.test(arg)) out.txPowerDbm = Number(arg);
        break;
      case 'beacons':
        out.beacons = true;
        break;
      case 'shutdown':
        out.shutdown = true;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Radio settings of a Wlan port from its config section and catalog radio data: band (when the radio supports
 * it, else the default band), channel (configured, else the default channel on the default band, else the band's
 * first channel), width (configured, else 20 MHz; 60 GHz 2160), transmit power (capped at the radio maximum),
 * SSID, security, passphrase and beacons (interval 100 ms).
 */
export function readRadioSettings(config: ConfigAst, port: PortId, spec: RadioPortSpec): RadioSettings {
  const cfg = readWlanConfig(config, port);
  const band = cfg.band !== undefined && spec.bands.includes(cfg.band) ? cfg.band : spec.defaultBand;
  const firstChannel = band === 'cell' ? 0 : (CHANNELS[band][0] ?? 0);
  const out: RadioSettings = {
    band,
    channel: cfg.channel ?? (band === spec.defaultBand ? spec.defaultChannel : firstChannel),
    widthMhz: cfg.widthMhz ?? (band === '60' ? 2160 : 20),
    txPowerDbm: cfg.txPowerDbm === undefined ? spec.maxTxPowerDbm : Math.min(cfg.txPowerDbm, spec.maxTxPowerDbm),
    security: cfg.security,
    beaconIntervalMs: 100,
  };
  if (cfg.ssid !== undefined) out.ssid = cfg.ssid;
  if (cfg.passphrase !== undefined) out.passphrase = cfg.passphrase;
  if (cfg.beacons) out.emitBeacons = true;
  return out;
}

/** Radio mode of a port view (from its effective role), or undefined for non-radio ports. */
export function portRadioMode(view: Pick<PortView, 'spec' | 'role'>): RadioMode | undefined {
  const role = view.role ?? view.spec.role;
  return role === undefined ? undefined : radioModeOf(view.spec.kind, role);
}

/** Supported-rates text for a band. */
export function ratesFor(band: RfBand | undefined): string {
  return band === '2.4' || band === undefined ? RATES_24 : RATES_OFDM;
}

/** Bounded ring of DebugEvents, newest last (shared by both wlan daemons). */
export class WlanDebugRing {
  private readonly buf: DebugEvent[] = [];
  private start = 0;

  /** @param capacity maximum number of events kept */
  constructor(private readonly capacity: number) {}

  /** Append an event, overwriting the oldest when full. */
  push(ev: DebugEvent): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(ev);
      return;
    }
    this.buf[this.start] = ev;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest → newest, fresh array. */
  toArray(): DebugEvent[] {
    if (this.buf.length < this.capacity) return this.buf.slice();
    const out = new Array<DebugEvent>(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[(this.start + i) % this.capacity]!;
    return out;
  }
}

/** Numeric field or undefined. */
export function numOf(v: FieldValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** String field or undefined. */
export function strOf(v: FieldValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ── station daemon ───────────────────────────────────────────────────────────

interface Candidate {
  bssid: MacAddress;
  ssid: string;
  security: WifiSecurity;
  band?: RfBand;
  channel?: number;
  rssiDbm?: number;
}

interface StaPort {
  readonly port: PortId;
  state: WifiAssocState;
  reason?: string;
  ssid?: string;
  security: WifiSecurity;
  passphrase?: string;
  bssid?: MacAddress;
  band?: RfBand;
  aid?: number;
  carrier: boolean;
  readonly candidates: Map<MacAddress, Candidate>;
  /** Failure reason used when the current scan finds nothing. */
  scanFailReason: string;
  stepTimeouts: number;
  eapolTimeouts: number;
  keyFailures: number;
  scans: number;
  rescanArmed: boolean;
  /** Last frame of the running step (re-sent on a step or EAPOL timeout). */
  last?: { layers: LayerSpec[]; tag: string };
}

const timerKey = (kind: 'scan' | 'rescan' | 'step' | 'eapol', port: PortId): string => `${kind}:${port}`;

function parseTimer(key: string): { kind: string; port: PortId } | undefined {
  const i = key.indexOf(':');
  return i <= 0 ? undefined : { kind: key.slice(0, i), port: key.slice(i + 1) };
}

class WlanClient implements Process {
  readonly name = WLAN_CLIENT_PROCESS;
  readonly handles = [
    { layer: 'dot11', ethertype: ETHERTYPE_EAPOL, roles: ['wireless-client'] },
    { layer: 'dot11', roles: ['wireless-client'] },
  ] as const;

  private readonly ring = new WlanDebugRing(WLAN_DEBUG_RING);
  private readonly ports = new Map<PortId, StaPort>();

  init(ctx: ProcessCtx): Action[] {
    const actions: Action[] = [];
    for (const view of ctx.ports.values()) {
      if (portRadioMode(view) !== 'station') continue;
      const sp = this.ensure(ctx, view.id);
      sp.carrier = view.phy?.carrier === true;
      if (sp.carrier && sp.ssid !== undefined) actions.push(...this.startScan(ctx, sp, 'no-bss'));
    }
    return actions;
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const view = ctx.ports.get(port);
    if (view === undefined || portRadioMode(view) !== 'station') return [];
    const sp = this.ensure(ctx, port);
    const header = pdu.layer('dot11');
    if (header === undefined) return [];
    const cls = classifyAirFrame(pdu);
    if (cls === 'eapol') return this.onEapol(ctx, sp, pdu);
    if (cls !== 'mgmt') return [];
    const body = pdu.layer('dot11-mgmt')?.fields ?? {};
    const from = strOf(header.fields.addr2);
    switch (mgmtSubtype(pdu)) {
      case 'probe-resp':
      case 'beacon':
        this.record(ctx, sp, header.fields, body);
        return [];
      case 'auth':
        return from === sp.bssid && sp.state === 'authenticating' ? this.onAuth(ctx, sp, header.fields, body) : [];
      case 'assoc-resp':
      case 'reassoc-resp':
        if (from === sp.bssid && sp.state === 'associated') return this.lateAssocResp(ctx, sp, body);
        return from === sp.bssid && sp.state === 'associating' ? this.onAssocResp(ctx, sp, body) : [];
      case 'deauth':
        if (from !== sp.bssid || !this.inProgress(sp)) return [];
        this.emit(ctx, `${port}: deauthenticated by ${from} (reason ${String(numOf(body.reasonCode) ?? '?')})`, { port, bssid: from });
        if (numOf(body.reasonCode) === REASON_HANDSHAKE) return this.wrongKey(ctx, sp);
        return this.startScan(ctx, sp, 'no-bss', 'deauthenticated');
      case 'disassoc':
        if (from !== sp.bssid || !this.inProgress(sp)) return [];
        this.emit(ctx, `${port}: disassociated by ${from} (reason ${String(numOf(body.reasonCode) ?? '?')})`, { port, bssid: from });
        return this.startScan(ctx, sp, 'no-bss', 'disassociated');
      default:
        return [];
    }
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    const t = parseTimer(key);
    if (t === undefined) return [];
    const sp = this.ports.get(t.port);
    if (sp === undefined) return [];
    switch (t.kind) {
      case 'scan':
        return sp.state === 'scanning' ? this.finishScan(ctx, sp) : [];
      case 'rescan': {
        const retry = sp.state === 'scanning' || (sp.state === 'failed' && !this.finalFailure(sp));
        if (!retry || !sp.carrier || sp.ssid === undefined) {
          sp.rescanArmed = false;
          return [];
        }
        return [{ type: 'timer', key: timerKey('rescan', sp.port), delay: RF.RESCAN_NS, periodic: true }, ...this.startScan(ctx, sp, sp.scanFailReason)];
      }
      case 'step': {
        if (sp.state !== 'authenticating' && sp.state !== 'associating') return [];
        sp.stepTimeouts++;
        if (sp.stepTimeouts >= STEP_ATTEMPTS) {
          this.emit(ctx, `${sp.port}: no answer from ${sp.bssid ?? '?'} after ${STEP_ATTEMPTS} tries`, { port: sp.port });
          return this.fail(ctx, sp, 'timeout', true);
        }
        return [...this.resend(ctx, sp), { type: 'timer', key: timerKey('step', sp.port), delay: RF.STEP_TIMEOUT_NS }];
      }
      case 'eapol': {
        if (sp.state !== 'handshake') return [];
        sp.eapolTimeouts++;
        if (sp.eapolTimeouts >= EAPOL_ATTEMPTS) {
          const actions: Action[] = [];
          if (sp.bssid !== undefined) actions.push(this.sendMgmt(ctx, sp, 'deauth', sp.bssid, { reasonCode: REASON_HANDSHAKE }, 'deauth'));
          this.emit(ctx, `${sp.port}: key handshake with ${sp.bssid ?? '?'} timed out`, { port: sp.port });
          return [...actions, ...this.fail(ctx, sp, 'handshake-timeout', true)];
        }
        return [...this.resend(ctx, sp), { type: 'timer', key: timerKey('eapol', sp.port), delay: RF.EAPOL_TIMEOUT_NS }];
      }
      default:
        return [];
    }
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    const ctxLine = delta.context[0];
    if (delta.context.length !== 1 || ctxLine === undefined || ctxLine[0] !== 'interface') return [];
    const port = ctxLine[1];
    if (port === undefined) return [];
    const view = ctx.ports.get(port);
    if (view === undefined || portRadioMode(view) !== 'station') return [];
    const key = delta.line[0];
    const sp = this.ensure(ctx, port);
    if (key === 'shutdown' && delta.op === 'set') {
      return this.inProgress(sp) && sp.bssid !== undefined ? [this.sendMgmt(ctx, sp, 'disassoc', sp.bssid, { reasonCode: REASON_LEAVING }, 'disassoc')] : [];
    }
    if (key === undefined || !WLAN_ASSOC_KEYS.includes(key)) return [];
    const before = `${sp.ssid ?? ''}|${sp.security}|${sp.passphrase ?? ''}`;
    this.loadConfig(ctx, sp);
    if (`${sp.ssid ?? ''}|${sp.security}|${sp.passphrase ?? ''}` === before) return [];
    const actions: Action[] = [];
    if (this.inProgress(sp) && sp.bssid !== undefined) {
      actions.push(this.sendMgmt(ctx, sp, 'disassoc', sp.bssid, { reasonCode: REASON_LEAVING }, 'disassoc'));
    }
    actions.push(...this.cancelAll(sp));
    sp.keyFailures = 0;
    this.emit(ctx, `${port}: wireless settings changed (network ${sp.ssid === undefined ? 'none' : `"${sp.ssid}"`}, ${sp.security})`, { port });
    actions.push(this.setState(ctx, sp, 'idle'));
    if (sp.ssid !== undefined && sp.carrier) actions.push(...this.startScan(ctx, sp, 'no-bss'));
    return actions;
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const sp = this.ports.get(port);
    if (sp === undefined || !up) return [];
    if (sp.state !== 'authenticating' && sp.state !== 'associating' && sp.state !== 'handshake') return [];
    const actions = this.cancelTimers(sp, ['step', 'eapol']);
    sp.keyFailures = 0;
    delete sp.last;
    this.emit(ctx, `${port}: associated with ${sp.bssid ?? '?'} on "${sp.ssid ?? ''}" and authorized`, { port, bssid: sp.bssid });
    actions.push(this.setState(ctx, sp, 'associated'));
    return actions;
  }

  onMediumEvent(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[] {
    const view = ctx.ports.get(port);
    if (view === undefined || portRadioMode(view) !== 'station') return [];
    const sp = this.ensure(ctx, port);
    switch (ev.kind) {
      case 'carrier': {
        sp.carrier = ev.up;
        if (ev.up) return sp.state === 'idle' && sp.ssid !== undefined ? this.startScan(ctx, sp, 'no-bss') : [];
        const actions = this.cancelAll(sp);
        if (sp.state !== 'idle') actions.push(this.setState(ctx, sp, 'idle', 'radio-down'));
        return actions;
      }
      case 'beacon-loss':
        if (sp.bssid !== ev.bssid) return [];
        this.emit(ctx, `${port}: lost the signal of ${ev.bssid}`, { port, bssid: ev.bssid });
        return this.startScan(ctx, sp, 'out-of-range', 'out-of-range');
      case 'bss-down':
        if (sp.bssid !== ev.bssid) return [];
        this.emit(ctx, `${port}: access point ${ev.bssid} stopped serving the network`, { port, bssid: ev.bssid });
        return this.startScan(ctx, sp, 'no-bss', 'bss-down');
      case 'bss-in-range': {
        const retry = sp.state === 'scanning' || (sp.state === 'failed' && (sp.reason === 'out-of-range' || sp.reason === 'no-bss'));
        if (!retry || sp.ssid === undefined) return [];
        this.emit(ctx, `${port}: ${ev.bssid} is in range again, scanning now`, { port, bssid: ev.bssid });
        return this.startScan(ctx, sp, sp.scanFailReason, sp.reason);
      }
      default:
        return [];
    }
  }

  onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    if (req.kind !== 'wlan.scan') return [];
    const view = ctx.ports.get(req.port);
    if (view === undefined || portRadioMode(view) !== 'station') return [];
    const sp = this.ensure(ctx, req.port);
    if (!sp.carrier) return [];
    this.emit(ctx, `${req.port}: refreshing the list of networks`, { port: req.port });
    return [{ type: 'send', port: sp.port, pdu: ctx.newPdu(probeRequestFrame(ctx.macOf(sp.port), ''), { tag: 'probe-req' }) }];
  }

  stateSnapshot(): StateView {
    const ports: Record<string, unknown>[] = [];
    for (const sp of this.ports.values()) {
      const entry: Record<string, unknown> = { port: sp.port, state: sp.state, security: sp.security, keyFailures: sp.keyFailures, scans: sp.scans };
      if (sp.reason !== undefined) entry.reason = sp.reason;
      if (sp.ssid !== undefined) entry.ssid = sp.ssid;
      if (sp.bssid !== undefined) entry.bssid = sp.bssid;
      if (sp.aid !== undefined) entry.aid = sp.aid;
      entry.candidates = [...sp.candidates.values()]
        .sort((a, b) => (b.rssiDbm ?? -1000) - (a.rssiDbm ?? -1000) || (a.bssid < b.bssid ? -1 : a.bssid > b.bssid ? 1 : 0))
        .map((c) => ({ ...c }));
      ports.push(entry);
    }
    return { process: WLAN_CLIENT_PROCESS, state: { ports } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── internals ──

  private ensure(ctx: ProcessCtx, port: PortId): StaPort {
    let sp = this.ports.get(port);
    if (sp === undefined) {
      sp = {
        port, state: 'idle', security: 'open', carrier: false, candidates: new Map(), scanFailReason: 'no-bss',
        stepTimeouts: 0, eapolTimeouts: 0, keyFailures: 0, scans: 0, rescanArmed: false,
      };
      this.ports.set(port, sp);
      this.loadConfig(ctx, sp);
    }
    return sp;
  }

  private loadConfig(ctx: ProcessCtx, sp: StaPort): void {
    const cfg = readWlanConfig(ctx.config, sp.port);
    if (cfg.ssid === undefined) delete sp.ssid;
    else sp.ssid = cfg.ssid;
    sp.security = cfg.security;
    if (cfg.passphrase === undefined) delete sp.passphrase;
    else sp.passphrase = cfg.passphrase;
  }

  private inProgress(sp: StaPort): boolean {
    return sp.state === 'authenticating' || sp.state === 'associating' || sp.state === 'handshake' || sp.state === 'associated';
  }

  private finalFailure(sp: StaPort): boolean {
    return sp.reason === 'wrong-key' && sp.keyFailures >= KEY_ATTEMPTS;
  }

  private tag(sp: StaPort): number {
    return passphraseTag(sp.ssid ?? '', sp.passphrase ?? '');
  }

  private setState(ctx: ProcessCtx, sp: StaPort, state: WifiAssocState, reason?: string): Action {
    const prev = sp.state;
    sp.state = state;
    if (reason === undefined) delete sp.reason;
    else sp.reason = reason;
    if (state === 'idle' || state === 'scanning' || state === 'failed') {
      delete sp.bssid;
      delete sp.aid;
    }
    const op: Extract<Action, { type: 'medium' }>['op'] = { op: 'sta-state', state };
    if (sp.ssid !== undefined && state !== 'idle') op.ssid = sp.ssid;
    if (sp.bssid !== undefined) op.bssid = sp.bssid;
    if (reason !== undefined) op.reason = reason;
    if (prev !== state) {
      this.emit(ctx, `${sp.port}: ${prev} -> ${state}${reason === undefined ? '' : ` (${reason})`}`, { port: sp.port, from: prev, to: state, reason });
    }
    this.writeRow(ctx, sp);
    return { type: 'medium', port: sp.port, op };
  }

  private writeRow(ctx: ProcessCtx, sp: StaPort): void {
    const table = ctx.tables.get?.<Dot11AssocRow>('dot11-assoc');
    const view = ctx.ports.get(sp.port);
    if (table === undefined || view === undefined) return;
    const key = dot11AssocKey(sp.port, view.mac);
    if (sp.state === 'idle' || sp.bssid === undefined) {
      if (table.has(key)) table.delete(key, 'cleared');
      return;
    }
    const row: Dot11AssocRow = { key, port: sp.port, station: view.mac, bssid: sp.bssid, ssid: sp.ssid ?? '', state: sp.state, updatedAt: ctx.now };
    if (sp.aid !== undefined) row.aid = sp.aid;
    const link = ctx.air?.link(sp.port, sp.bssid);
    if (link !== undefined) {
      row.rssiDbm = link.rssiDbm;
      row.rateBps = link.rateBps;
    }
    table.set(row);
  }

  private cancelTimers(sp: StaPort, kinds: readonly ('scan' | 'rescan' | 'step' | 'eapol')[]): Action[] {
    const out: Action[] = [];
    for (const k of kinds) {
      if (k === 'rescan') {
        if (!sp.rescanArmed) continue;
        sp.rescanArmed = false;
      }
      out.push({ type: 'cancelTimer', key: timerKey(k, sp.port) });
    }
    return out;
  }

  private cancelAll(sp: StaPort): Action[] {
    delete sp.last;
    return this.cancelTimers(sp, ['scan', 'step', 'eapol', 'rescan']);
  }

  private startScan(ctx: ProcessCtx, sp: StaPort, failReason: string, reason?: string): Action[] {
    if (sp.ssid === undefined || !sp.carrier) return [];
    const actions = this.cancelTimers(sp, ['scan', 'step', 'eapol']);
    delete sp.last;
    sp.candidates.clear();
    sp.stepTimeouts = 0;
    sp.eapolTimeouts = 0;
    sp.scanFailReason = failReason;
    sp.scans++;
    actions.push(this.setState(ctx, sp, 'scanning', reason));
    this.emit(ctx, `${sp.port}: probing for "${sp.ssid}"`, { port: sp.port, ssid: sp.ssid });
    actions.push({ type: 'send', port: sp.port, pdu: ctx.newPdu(probeRequestFrame(ctx.macOf(sp.port), sp.ssid), { tag: 'probe-req' }) });
    actions.push({ type: 'timer', key: timerKey('scan', sp.port), delay: RF.SCAN_DWELL_NS });
    return actions;
  }

  private record(ctx: ProcessCtx, sp: StaPort, header: Readonly<Record<string, FieldValue>>, body: Readonly<Record<string, FieldValue>>): void {
    const bssid = strOf(body.bssid) ?? strOf(header.addr3) ?? strOf(header.addr2);
    const ssid = strOf(body.ssid);
    if (bssid === undefined || ssid === undefined) return;
    const security = strOf(body.security);
    const cand: Candidate = { bssid, ssid, security: security !== undefined && (SECURITIES as readonly string[]).includes(security) ? (security as WifiSecurity) : 'open' };
    const band = strOf(body.band);
    if (band !== undefined && (BANDS as readonly string[]).includes(band)) cand.band = band as RfBand;
    const channel = numOf(body.channel);
    if (channel !== undefined) cand.channel = channel;
    const rssi = numOf(body.rssiDbm);
    if (rssi !== undefined) cand.rssiDbm = rssi;
    const known = sp.candidates.has(bssid);
    sp.candidates.set(bssid, cand);
    if (!known) this.emit(ctx, `${sp.port}: heard "${ssid}" from ${bssid}${rssi === undefined ? '' : ` at ${rssi} dBm`}`, { port: sp.port, bssid, ssid, rssiDbm: rssi });
  }

  private finishScan(ctx: ProcessCtx, sp: StaPort): Action[] {
    const air = ctx.air?.visibleBss(sp.port);
    const scored: { cand: Candidate; rssi: number }[] = [];
    for (const cand of sp.candidates.values()) {
      if (cand.ssid !== sp.ssid || cand.security !== sp.security) continue;
      if (air !== undefined) {
        const seen = air.find((b) => b.bssid === cand.bssid);
        if (seen === undefined || !seen.canAssociate) continue;
        scored.push({ cand, rssi: seen.rssiDbm });
      } else {
        if (cand.rssiDbm !== undefined && cand.rssiDbm * 1000 < RF.WIFI_CONNECT_RSSI_MDB) continue;
        scored.push({ cand, rssi: cand.rssiDbm ?? 0 });
      }
    }
    scored.sort((a, b) => b.rssi - a.rssi || (a.cand.bssid < b.cand.bssid ? -1 : a.cand.bssid > b.cand.bssid ? 1 : 0));
    const best = scored[0];
    if (best === undefined) {
      this.emit(ctx, `${sp.port}: no usable access point for "${sp.ssid ?? ''}"`, { port: sp.port, heard: sp.candidates.size });
      return this.fail(ctx, sp, sp.scanFailReason, true);
    }
    return this.authenticate(ctx, sp, best.cand);
  }

  private fail(ctx: ProcessCtx, sp: StaPort, reason: string, rescan: boolean): Action[] {
    const actions = this.cancelTimers(sp, ['scan', 'step', 'eapol']);
    delete sp.last;
    actions.push(this.setState(ctx, sp, 'failed', reason));
    if (rescan && !sp.rescanArmed && sp.carrier && sp.ssid !== undefined) {
      sp.rescanArmed = true;
      actions.push({ type: 'timer', key: timerKey('rescan', sp.port), delay: RF.RESCAN_NS, periodic: true });
    }
    return actions;
  }

  private sendMgmt(ctx: ProcessCtx, sp: StaPort, subtype: string, bssid: MacAddress, body: Record<string, FieldValue>, tag: string, duration?: number): Action {
    const layers = mgmtFrame(subtype, { addr1: bssid, addr2: ctx.macOf(sp.port), addr3: bssid, ...(duration !== undefined ? { duration } : {}) }, body);
    return { type: 'send', port: sp.port, pdu: ctx.newPdu(layers, { tag }) };
  }

  /** Send a step frame and remember it for retransmission. */
  private sendStep(ctx: ProcessCtx, sp: StaPort, layers: LayerSpec[], tag: string): Action {
    sp.last = { layers, tag };
    const meta: Partial<PduMeta> = { tag };
    return { type: 'send', port: sp.port, pdu: ctx.newPdu(layers, meta) };
  }

  private resend(ctx: ProcessCtx, sp: StaPort): Action[] {
    if (sp.last === undefined) return [];
    this.emit(ctx, `${sp.port}: re-sending ${sp.last.tag}`, { port: sp.port, tag: sp.last.tag });
    return [{ type: 'send', port: sp.port, pdu: ctx.newPdu(sp.last.layers, { tag: sp.last.tag }) }];
  }

  private authenticate(ctx: ProcessCtx, sp: StaPort, cand: Candidate): Action[] {
    const actions = this.cancelTimers(sp, ['rescan', 'scan']);
    sp.bssid = cand.bssid;
    if (cand.band !== undefined) sp.band = cand.band;
    else delete sp.band;
    sp.stepTimeouts = 0;
    actions.push(this.setState(ctx, sp, 'authenticating'));
    const mac = ctx.macOf(sp.port);
    const addrs = { addr1: cand.bssid, addr2: mac, addr3: cand.bssid };
    if (sp.security === 'wpa3-sae') {
      this.emit(ctx, `${sp.port}: sending SAE commit to ${cand.bssid}`, { port: sp.port, bssid: cand.bssid });
      actions.push(this.sendStep(ctx, sp, mgmtFrame('auth', { ...addrs, duration: saeCommitTag(this.tag(sp)) }, { authAlgorithm: AUTH_SAE, authSeq: 1, statusCode: STATUS_SUCCESS }), 'sae-commit'));
    } else {
      this.emit(ctx, `${sp.port}: authenticating with ${cand.bssid} (open system)`, { port: sp.port, bssid: cand.bssid });
      actions.push(this.sendStep(ctx, sp, mgmtFrame('auth', addrs, { authAlgorithm: AUTH_OPEN, authSeq: 1, statusCode: STATUS_SUCCESS }), 'auth'));
    }
    actions.push({ type: 'timer', key: timerKey('step', sp.port), delay: RF.STEP_TIMEOUT_NS });
    return actions;
  }

  private associate(ctx: ProcessCtx, sp: StaPort): Action[] {
    const bssid = sp.bssid!;
    sp.stepTimeouts = 0;
    const actions: Action[] = [this.setState(ctx, sp, 'associating')];
    const layers = mgmtFrame('assoc-req', { addr1: bssid, addr2: ctx.macOf(sp.port), addr3: bssid }, { ssid: sp.ssid ?? '', capability: 1, rates: ratesFor(sp.band) });
    this.emit(ctx, `${sp.port}: requesting association with ${bssid}`, { port: sp.port, bssid });
    actions.push(this.sendStep(ctx, sp, layers, 'assoc-req'));
    actions.push({ type: 'timer', key: timerKey('step', sp.port), delay: RF.STEP_TIMEOUT_NS });
    return actions;
  }

  private onAuth(ctx: ProcessCtx, sp: StaPort, header: Readonly<Record<string, FieldValue>>, body: Readonly<Record<string, FieldValue>>): Action[] {
    const alg = numOf(body.authAlgorithm);
    const seq = numOf(body.authSeq);
    const status = numOf(body.statusCode) ?? STATUS_FAILURE;
    const bssid = sp.bssid!;
    if (alg === AUTH_OPEN && sp.security !== 'wpa3-sae' && seq === 2) {
      if (status !== STATUS_SUCCESS) {
        this.emit(ctx, `${sp.port}: ${bssid} refused authentication (status ${status})`, { port: sp.port, status });
        return this.fail(ctx, sp, 'auth-rejected', true);
      }
      return [{ type: 'cancelTimer', key: timerKey('step', sp.port) }, ...this.associate(ctx, sp)];
    }
    if (alg === AUTH_SAE && sp.security === 'wpa3-sae') {
      if (seq === 1) {
        if (status !== STATUS_SUCCESS) return this.fail(ctx, sp, 'auth-rejected', true);
        const peer = numOf(header.duration);
        const ok = peer === saeCommitTag(this.tag(sp));
        this.emit(ctx, `${sp.port}: SAE commit from ${bssid} ${ok ? 'matches' : 'does not match'} our password element`, { port: sp.port, ok });
        const layers = mgmtFrame('auth', { addr1: bssid, addr2: ctx.macOf(sp.port), addr3: bssid }, { authAlgorithm: AUTH_SAE, authSeq: 2, statusCode: ok ? STATUS_SUCCESS : STATUS_FAILURE });
        sp.stepTimeouts = 0;
        return [this.sendStep(ctx, sp, layers, 'sae-confirm'), { type: 'timer', key: timerKey('step', sp.port), delay: RF.STEP_TIMEOUT_NS }];
      }
      if (seq === 2) {
        if (status !== STATUS_SUCCESS) {
          this.emit(ctx, `${sp.port}: SAE confirm from ${bssid} failed`, { port: sp.port });
          return this.wrongKey(ctx, sp);
        }
        return [{ type: 'cancelTimer', key: timerKey('step', sp.port) }, ...this.associate(ctx, sp)];
      }
    }
    return [];
  }

  private onAssocResp(ctx: ProcessCtx, sp: StaPort, body: Readonly<Record<string, FieldValue>>): Action[] {
    const status = numOf(body.statusCode) ?? STATUS_FAILURE;
    const actions: Action[] = [{ type: 'cancelTimer', key: timerKey('step', sp.port) }];
    delete sp.last;
    if (status === STATUS_AP_FULL) {
      this.emit(ctx, `${sp.port}: ${sp.bssid ?? '?'} has no room for another station`, { port: sp.port });
      return [...actions, ...this.fail(ctx, sp, 'ap-full', true)];
    }
    if (status !== STATUS_SUCCESS) {
      this.emit(ctx, `${sp.port}: ${sp.bssid ?? '?'} refused the association (status ${status})`, { port: sp.port, status });
      return [...actions, ...this.fail(ctx, sp, 'rejected', true)];
    }
    const aid = numOf(body.aid);
    if (aid !== undefined) sp.aid = aid;
    if (sp.security === 'open') {
      this.emit(ctx, `${sp.port}: association accepted (aid ${aid ?? '?'}), waiting for the network to open`, { port: sp.port, aid });
      this.writeRow(ctx, sp);
      return actions;
    }
    sp.eapolTimeouts = 0;
    this.emit(ctx, `${sp.port}: association accepted (aid ${aid ?? '?'}), starting the key handshake`, { port: sp.port, aid });
    actions.push(this.setState(ctx, sp, 'handshake'));
    actions.push({ type: 'timer', key: timerKey('eapol', sp.port), delay: RF.EAPOL_TIMEOUT_NS });
    return actions;
  }

  /** A successful association response that arrives after the network already opened (open networks): keep the AID. */
  private lateAssocResp(ctx: ProcessCtx, sp: StaPort, body: Readonly<Record<string, FieldValue>>): Action[] {
    const aid = numOf(body.aid);
    if (numOf(body.statusCode) !== STATUS_SUCCESS || aid === undefined || sp.aid === aid) return [];
    sp.aid = aid;
    this.writeRow(ctx, sp);
    return [];
  }

  private onEapol(ctx: ProcessCtx, sp: StaPort, pdu: Pdu): Action[] {
    const header = pdu.layer('dot11')!.fields;
    if (sp.state !== 'handshake' || strOf(header.addr2) !== sp.bssid) return [];
    const key = pdu.layer('eapol')?.fields;
    if (key === undefined) return [];
    const step = numOf(key.handshakeStep);
    const replayCounter = numOf(key.replayCounter) ?? 0;
    const bssid = sp.bssid!;
    const mac = ctx.macOf(sp.port);
    if (step === 1) {
      this.emit(ctx, `${sp.port}: key message 1 of 4 from ${bssid}, answering with message 2`, { port: sp.port });
      sp.eapolTimeouts = 0;
      return [
        this.sendStep(ctx, sp, eapolFrame('to-ds', mac, bssid, { step: 2, replayCounter, keyData: tagBytes(this.tag(sp)) }), 'eapol-2'),
        { type: 'timer', key: timerKey('eapol', sp.port), delay: RF.EAPOL_TIMEOUT_NS },
      ];
    }
    if (step === 3) {
      this.emit(ctx, `${sp.port}: key message 3 of 4 from ${bssid}, answering with message 4`, { port: sp.port });
      sp.eapolTimeouts = 0;
      return [
        this.sendStep(ctx, sp, eapolFrame('to-ds', mac, bssid, { step: 4, replayCounter }), 'eapol-4'),
        { type: 'timer', key: timerKey('eapol', sp.port), delay: RF.EAPOL_TIMEOUT_NS },
      ];
    }
    return [];
  }

  private wrongKey(ctx: ProcessCtx, sp: StaPort): Action[] {
    sp.keyFailures++;
    const actions = this.cancelAll(sp);
    this.emit(ctx, `${sp.port}: the passphrase for "${sp.ssid ?? ''}" was not accepted (attempt ${sp.keyFailures} of ${KEY_ATTEMPTS})`, {
      port: sp.port, attempts: sp.keyFailures,
    });
    actions.push(this.setState(ctx, sp, 'failed', 'wrong-key'));
    if (sp.keyFailures < KEY_ATTEMPTS) actions.push(...this.startScan(ctx, sp, 'no-bss'));
    return actions;
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(WIRELESS_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: WLAN_CLIENT_PROCESS, category: WIRELESS_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: WLAN_CLIENT_PROCESS, category: WIRELESS_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the Wi-Fi station daemon (`name: 'wlan-client'`). One instance per device, created at boot. */
export function createWlanClient(): Process {
  return new WlanClient();
}
