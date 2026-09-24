/**
 * protocols/wlan-ap.ts — the Wi-Fi access-point daemon (ARCHITECTURE-P1 D5, §3.6; contracts/medium.ts authority).
 *
 * Serves one BSS per access radio port (kind wlan, role wireless-bss; BSSID `bssidFor(radio MAC, 0)`) configured
 * by `ssid`, `security`, `passphrase` and `beacons` under `interface WlanN`. The daemon handles management and
 * EAPOL frames only: Ethernet data is bridged by eth-switch and rewrapped by the air medium. It is the only writer
 * of association grants (`Action medium` ops `assoc` and `authorize`).
 *
 *  • Probe request with a wildcard or matching SSID (radio carrier up, SSID set) → unicast probe response with SSID,
 *    band, channel (when fixed), security, beacon interval, capability and rates.
 *  • Open system authentication (seq 1 → seq 2 status 0) on open and wpa2-psk networks → `assoc authenticated`.
 *    wpa3-sae networks refuse algorithm 0 with status 1; SAE (algorithm 3): the station's commit (tag in
 *    `dot11.duration`) is answered with the AP's commit; the station's confirm is answered with a confirm whose
 *    status is 0 only when the station's confirm succeeded and its commit tag equals ours → `assoc authenticated`.
 *    A client that authenticates again after holding a grant is first reset with `assoc none`.
 *  • Association request from an authenticated client with the same SSID: when `maxClients` (catalog radio data)
 *    stations already hold an AID → status 17 and `assoc none`; otherwise status 0 with the lowest free AID and
 *    `assoc associated`. Open networks are authorized at once (`authorize`); secured networks run the EAPOL 4-way
 *    handshake: message 1 (802.11 from-DS data + LLC 0x888e, never rewrapped), message 2 key data compared with
 *    `passphraseTag(ssid, passphrase)` — mismatch → deauthentication reason 15 and `assoc none` — then message 3,
 *    message 4 → `authorize`. `eapol:<port>|<station>` (RF.EAPOL_TIMEOUT_NS) re-sends the last message; the third
 *    timeout → deauthentication reason 15 and `assoc none`.
 *  • Deauthentication or disassociation from a client, or MediumEvent `station-lost` → the client is forgotten
 *    (`assoc none` only when the medium still holds the grant, i.e. not after `station-lost`).
 *  • Changing ssid/security/passphrase deauthenticates every client (reason 3) with `assoc none`; carrier loss
 *    forgets every client. The `beacons` extension line arms the PERIODIC timer `beacon:<port>` (100 ms) sending
 *    broadcast beacons with `meta.background` while the radio has carrier (silence rule: nothing without it).
 *
 * AP rows of `dot11-assoc` (one per client, key dot11AssocKey(port, station)) mirror the client state
 * (authenticating / associating / handshake / associated). No randomness.
 *
 * P2 (ARCHITECTURE-P2 D17, §2.4, §2.5, §3.12 steps 4–6; W5 wireless). Association stays at the AP (local MAC, a listed
 * deviation) even when a controller manages the radio:
 *  • settings are read through the device's ONE renderer (`wlanDaemonSettings` → `ctx.radioSettings`): the local interface
 *    lines, overlaid by the controller profile capwap-wtp stored with a `radio-profile` action. A profile brings the
 *    SSID, the security and the KEY TAG (never a passphrase): EAPOL message 2 and the SAE commit are compared with the
 *    pushed key tag when there is one, else with `passphraseTag(ssid, passphrase)` as before;
 *  • a profile arrives by action, not by config line, so every handler first re-reads the settings: when the BSS
 *    members changed (SSID, security, passphrase, key tag, switching, WLAN id) the air has already restarted the BSS,
 *    and the daemon forgets every client (no deauthentication: the medium tore the associations down);
 *  • on every grant change of a CENTRAL BSS — a client authorized, or a reported client forgotten (disassociated,
 *    deauthenticated, lost or aged out, key failure, settings change, carrier loss) — the daemon sends capwap-wtp the
 *    `wlan.grant` event (§2.5), `add` BEFORE the medium `authorize` so the controller's `wlan-clients` row exists before
 *    the station's first frame can reach the controller; only when capwap-wtp runs on the device. Local BSSs never send
 *    it, so P1 wireless traces are unchanged;
 *  • an 802.11 data frame of a central BSS (handed over unchanged by the air, `frameArrival.central`) goes to
 *    capwap-wtp with `deliver`: the pipeline's demux reaches this daemon's key-less dot11 selector first until the
 *    `DemuxSelector.frame` key is honoured, so the hand-over is explicit here (a local BSS never sees such a frame).
 *
 * `stateSnapshot()`:
 *   { process: 'wlan-ap', state: { radios: [{ port, security, up, beacons, clients: [{ station, state, aid? }], ssid?,
 *     switching?: 'central', wlanId? }], probesAnswered, beaconsSent } }   (never the passphrase or the key tag;
 *   `switching`/`wlanId` only on a central radio)
 *
 * Debug category: 'wireless'. Wording is original.
 */
import type { MacAddress } from '../contracts/addr.js';
import { MAC_BROADCAST, bssidFor } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { MediumEvent, WifiAssocState } from '../contracts/medium.js';
import type { FieldValue, LayerSpec, Pdu } from '../contracts/pdu.js';
import { ETHERTYPE_EAPOL } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { WifiSecurity } from '../contracts/rf.js';
import { RF } from '../contracts/rf.js';
import { MS } from '../contracts/time.js';
import type { Dot11AssocRow } from '../contracts/tables.js';
import { dot11AssocKey } from '../contracts/tables.js';
import type { WlanGrantEvent } from '../contracts/transport.js';
import { classifyAirFrame, eapolFrame, mgmtFrame, mgmtSubtype, passphraseTag, saeCommitTag, tagFromBytes } from '../link/rewrap80211.js';
import {
  AUTH_OPEN,
  AUTH_SAE,
  EAPOL_ATTEMPTS,
  REASON_CONFIG_CHANGED,
  REASON_HANDSHAKE,
  STATUS_AP_FULL,
  STATUS_FAILURE,
  STATUS_SUCCESS,
  WIRELESS_DEBUG_CATEGORY,
  WLAN_ASSOC_KEYS,
  WLAN_DEBUG_RING,
  WlanDebugRing,
  numOf,
  portRadioMode,
  ratesFor,
  strOf,
  wlanDaemonSettings,
} from './wlan-client.js';

/** Process name of the access-point daemon. */
export const WLAN_AP_PROCESS = 'wlan-ap';
/** Beacon interval of the `beacons` extension line. */
export const BEACON_INTERVAL_MS = 100;
/** Highest association id (802.11). */
export const MAX_AID = 2007;
/** @since P2 (wireless) The daemon that tunnels a central BSS's frames and reports its grants (§2.5, §3.12). */
export const CAPWAP_WTP_PROCESS: ProcessName = 'capwap-wtp';

type ClientState = 'authenticating' | 'authenticated' | 'handshake' | 'authorized';

interface ApClient {
  readonly mac: MacAddress;
  state: ClientState;
  /** The medium holds a grant for this client (assoc authenticated / associated). */
  granted: boolean;
  aid?: number;
  saeTag?: number;
  eapolStep: number;
  eapolTimeouts: number;
  replay: number;
  last?: { layers: LayerSpec[]; tag: string };
  /** @since P2 (wireless) An `add` grant was reported to capwap-wtp (a central BSS): forgetting it reports `del`. */
  reported?: { bssid: MacAddress; wlanId: number };
}

interface ApPort {
  readonly port: PortId;
  carrier: boolean;
  ssid?: string;
  security: WifiSecurity;
  passphrase?: string;
  beacons: boolean;
  beaconArmed: boolean;
  readonly clients: Map<MacAddress, ApClient>;
  /** @since P2 (wireless) The key tag a controller pushed with the BSS (compared instead of the passphrase's tag). */
  keyTag?: number;
  /** @since P2 (wireless) BSS index 0 is centrally switched (a controller profile). */
  central: boolean;
  /** @since P2 (wireless) Controller WLAN id of a central BSS (reported with every grant). */
  wlanId?: number;
}

/** @since P2 (wireless) The members whose change restarts a BSS (the medium tears its associations down). */
function bssSignature(ap: Pick<ApPort, 'ssid' | 'security' | 'passphrase' | 'keyTag' | 'central' | 'wlanId'>): string {
  return `${ap.ssid ?? ''}|${ap.security}|${ap.passphrase ?? ''}|${ap.keyTag ?? ''}|${ap.central ? 'central' : 'local'}|${ap.wlanId ?? ''}`;
}

const ROW_STATE: Readonly<Record<ClientState, WifiAssocState>> = Object.freeze({
  authenticating: 'authenticating',
  authenticated: 'associating',
  handshake: 'handshake',
  authorized: 'associated',
});

const eapolKey = (port: PortId, mac: MacAddress): string => `eapol:${port}|${mac}`;
const beaconKey = (port: PortId): string => `beacon:${port}`;

class WlanAp implements Process {
  readonly name = WLAN_AP_PROCESS;
  readonly handles = [
    { layer: 'dot11', ethertype: ETHERTYPE_EAPOL, roles: ['wireless-bss'] },
    { layer: 'dot11', roles: ['wireless-bss'] },
  ] as const;

  private readonly ring = new WlanDebugRing(WLAN_DEBUG_RING);
  private readonly radios = new Map<PortId, ApPort>();
  private probesAnswered = 0;
  private beaconsSent = 0;

  init(ctx: ProcessCtx): Action[] {
    const actions: Action[] = [];
    for (const view of ctx.ports.values()) {
      if (portRadioMode(view) !== 'ap') continue;
      const ap = this.ensure(ctx, view.id);
      ap.carrier = view.phy?.carrier === true;
      actions.push(...this.syncBeacons(ctx, ap));
    }
    return actions;
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const view = ctx.ports.get(port);
    if (view === undefined || portRadioMode(view) !== 'ap') return [];
    const ap = this.ensure(ctx, port);
    const header = pdu.layer('dot11')?.fields;
    if (header === undefined) return [];
    const station = strOf(header.addr2);
    const receiver = strOf(header.addr1);
    if (station === undefined || receiver === undefined) return [];
    const refreshed = this.refresh(ctx, ap);
    const bssid = this.bssid(ctx, port);
    const cls = classifyAirFrame(pdu);
    if (cls === 'dot11-data') {
      // P2 (§3.12 step 6): a central BSS's data frame reached the AP unchanged; capwap-wtp tunnels it to the controller
      if (!ap.central || !this.hasWtp(ctx)) return refreshed;
      return [...refreshed, { type: 'deliver', to: CAPWAP_WTP_PROCESS, pdu, port }];
    }
    if (cls === 'eapol') return receiver === bssid ? [...refreshed, ...this.onEapol(ctx, ap, station, pdu)] : refreshed;
    if (cls !== 'mgmt') return refreshed;
    return [...refreshed, ...this.onMgmt(ctx, ap, view, pdu, station, receiver, bssid, header)];
  }

  /** Management frames (probe, authentication, association, leaving). */
  private onMgmt(
    ctx: ProcessCtx,
    ap: ApPort,
    view: PortView,
    pdu: Pdu,
    station: MacAddress,
    receiver: MacAddress,
    bssid: MacAddress,
    header: Readonly<Record<string, FieldValue>>,
  ): Action[] {
    const port = ap.port;
    const body = pdu.layer('dot11-mgmt')?.fields ?? {};
    const subtype = mgmtSubtype(pdu);
    if (subtype === 'probe-req') return this.onProbe(ctx, ap, view, station, body);
    if (receiver !== bssid) return [];
    switch (subtype) {
      case 'auth':
        return this.onAuth(ctx, ap, station, header, body);
      case 'assoc-req':
      case 'reassoc-req':
        return this.onAssocReq(ctx, ap, view, station, body);
      case 'deauth':
      case 'disassoc': {
        if (!ap.clients.has(station)) return [];
        this.emit(ctx, `${port}: ${station} left the network (${subtype === 'deauth' ? 'deauthentication' : 'disassociation'}, reason ${String(numOf(body.reasonCode) ?? '?')})`, {
          port, station,
        });
        return this.forget(ctx, ap, station, true);
      }
      default:
        return [];
    }
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key.startsWith('beacon:')) {
      const ap = this.radios.get(key.slice('beacon:'.length));
      if (ap === undefined) return [];
      const refreshed = this.refresh(ctx, ap);
      if (!ap.carrier || !ap.beacons || ap.ssid === undefined) {
        ap.beaconArmed = false;
        return refreshed;
      }
      this.beaconsSent++;
      return [...refreshed, this.beacon(ctx, ap), { type: 'timer', key: beaconKey(ap.port), delay: BEACON_INTERVAL_MS * MS, periodic: true }];
    }
    if (key.startsWith('eapol:')) {
      const rest = key.slice('eapol:'.length);
      const bar = rest.lastIndexOf('|');
      if (bar <= 0) return [];
      const ap = this.radios.get(rest.slice(0, bar));
      if (ap === undefined) return [];
      const refreshed = this.refresh(ctx, ap);
      const client = ap.clients.get(rest.slice(bar + 1));
      if (client === undefined || client.state !== 'handshake') return refreshed;
      client.eapolTimeouts++;
      if (client.eapolTimeouts >= EAPOL_ATTEMPTS) {
        this.emit(ctx, `${ap.port}: key handshake with ${client.mac} timed out`, { port: ap.port, station: client.mac });
        return [...refreshed, this.deauth(ctx, ap, client.mac, REASON_HANDSHAKE), ...this.forget(ctx, ap, client.mac, true)];
      }
      const actions: Action[] = [...refreshed];
      if (client.last !== undefined) {
        this.emit(ctx, `${ap.port}: re-sending ${client.last.tag} to ${client.mac}`, { port: ap.port, station: client.mac });
        actions.push({ type: 'send', port: ap.port, pdu: ctx.newPdu(client.last.layers, { tag: client.last.tag }) });
      }
      actions.push({ type: 'timer', key: eapolKey(ap.port, client.mac), delay: RF.EAPOL_TIMEOUT_NS });
      return actions;
    }
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    const scope = delta.context[0];
    if (delta.context.length !== 1 || scope === undefined || scope[0] !== 'interface' || scope[1] === undefined) return [];
    const view = ctx.ports.get(scope[1]);
    if (view === undefined || portRadioMode(view) !== 'ap') return [];
    const ap = this.ensure(ctx, view.id);
    const key = delta.line[0];
    if (key === 'beacons') {
      this.load(ctx, ap);
      return this.syncBeacons(ctx, ap);
    }
    if (key === undefined || !WLAN_ASSOC_KEYS.includes(key)) return [];
    // the BSS members (P2 adds the pushed key tag, the switching and the WLAN id: always unset in a local BSS, so a
    // local radio compares exactly ssid|security|passphrase as before)
    const before = bssSignature(ap);
    this.load(ctx, ap);
    if (bssSignature(ap) === before) return [];
    this.emit(ctx, `${ap.port}: network settings changed (${ap.ssid === undefined ? 'no SSID' : `"${ap.ssid}"`}, ${ap.security}); clients must join again`, { port: ap.port });
    const actions: Action[] = [];
    for (const mac of [...ap.clients.keys()].sort()) {
      if (ap.carrier) actions.push(this.deauth(ctx, ap, mac, REASON_CONFIG_CHANGED));
      actions.push(...this.forget(ctx, ap, mac, true));
    }
    actions.push(...this.syncBeacons(ctx, ap));
    return actions;
  }

  onMediumEvent(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[] {
    const view = ctx.ports.get(port);
    if (view === undefined || portRadioMode(view) !== 'ap') return [];
    const ap = this.ensure(ctx, port);
    const refreshed = this.refresh(ctx, ap);
    if (ev.kind === 'station-lost') {
      const client = ap.clients.get(ev.station);
      if (client === undefined) return refreshed;
      client.granted = false;
      this.emit(ctx, `${port}: lost ${ev.station} (${ev.reason})`, { port, station: ev.station, reason: ev.reason });
      return [...refreshed, ...this.forget(ctx, ap, ev.station, false)];
    }
    if (ev.kind === 'carrier') {
      ap.carrier = ev.up;
      const actions: Action[] = [...refreshed];
      if (!ev.up) {
        for (const mac of [...ap.clients.keys()].sort()) {
          const client = ap.clients.get(mac)!;
          client.granted = false;
          actions.push(...this.forget(ctx, ap, mac, false));
        }
      }
      this.emit(ctx, `${port}: radio ${ev.up ? `serving "${ap.ssid ?? ''}"` : 'stopped'}`, { port, up: ev.up });
      actions.push(...this.syncBeacons(ctx, ap));
      return actions;
    }
    return refreshed;
  }

  stateSnapshot(): StateView {
    const radios: Record<string, unknown>[] = [];
    for (const ap of this.radios.values()) {
      const entry: Record<string, unknown> = {
        port: ap.port,
        security: ap.security,
        up: ap.carrier,
        beacons: ap.beacons,
        clients: [...ap.clients.values()]
          .sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0))
          .map((c) => (c.aid === undefined ? { station: c.mac, state: ROW_STATE[c.state] } : { station: c.mac, state: ROW_STATE[c.state], aid: c.aid })),
      };
      if (ap.ssid !== undefined) entry.ssid = ap.ssid;
      // P2 (wireless): only a centrally switched radio shows it (a local radio's entry keeps its P0.5 keys)
      if (ap.central) {
        entry.switching = 'central';
        if (ap.wlanId !== undefined) entry.wlanId = ap.wlanId;
      }
      radios.push(entry);
    }
    return { process: WLAN_AP_PROCESS, state: { radios, probesAnswered: this.probesAnswered, beaconsSent: this.beaconsSent } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── internals ──

  private ensure(ctx: ProcessCtx, port: PortId): ApPort {
    let ap = this.radios.get(port);
    if (ap === undefined) {
      ap = { port, carrier: false, security: 'open', beacons: false, beaconArmed: false, clients: new Map(), central: false };
      this.radios.set(port, ap);
      this.load(ctx, ap);
    }
    return ap;
  }

  /** Read the radio's settings through the device's one renderer (P2 §2.4; the local lines when it has no profile). */
  private load(ctx: ProcessCtx, ap: ApPort): void {
    const cfg = wlanDaemonSettings(ctx, ap.port);
    if (cfg.ssid === undefined) delete ap.ssid;
    else ap.ssid = cfg.ssid;
    ap.security = cfg.security;
    if (cfg.passphrase === undefined) delete ap.passphrase;
    else ap.passphrase = cfg.passphrase;
    ap.beacons = cfg.beacons;
    if (cfg.keyTag === undefined) delete ap.keyTag;
    else ap.keyTag = cfg.keyTag;
    ap.central = cfg.central;
    if (cfg.wlanId === undefined) delete ap.wlanId;
    else ap.wlanId = cfg.wlanId;
  }

  /**
   * @since P2 (wireless) Re-read the settings before handling anything: a controller profile arrives by action (no
   * config line), and the air restarts the BSS when its members change. On such a change every client is forgotten
   * without a deauthentication (the medium already tore the associations down); a reported client of a central BSS is
   * reported `del`. With local lines only nothing can change here (config changes go through `onConfig`), so this is a
   * no-op for every P0.5/P1 radio.
   */
  private refresh(ctx: ProcessCtx, ap: ApPort): Action[] {
    const before = bssSignature(ap);
    this.load(ctx, ap);
    if (bssSignature(ap) === before) return [];
    this.emit(ctx, `${ap.port}: the controller changed this radio's network (${ap.ssid === undefined ? 'no SSID' : `"${ap.ssid}"`}, ${ap.security}); clients must join again`, { port: ap.port });
    const actions: Action[] = [];
    for (const mac of [...ap.clients.keys()].sort()) {
      const client = ap.clients.get(mac)!;
      client.granted = false;
      actions.push(...this.forget(ctx, ap, mac, false));
    }
    return actions;
  }

  /** @since P2 (wireless) capwap-wtp runs on this device (the only receiver of grant events and central data frames). */
  private hasWtp(ctx: ProcessCtx): boolean {
    return ctx.model.processes.includes(CAPWAP_WTP_PROCESS);
  }

  /**
   * @since P2 (wireless, §2.5, §3.12 step 5) The `wlan.grant` event of a grant change of a CENTRAL BSS: `add` when a
   * client is authorized, `del` when a reported client is forgotten. Nothing for a local BSS, for a client that was
   * never reported, or when capwap-wtp does not run here.
   */
  private grant(ctx: ProcessCtx, ap: ApPort, client: ApClient, op: 'add' | 'del'): Action[] {
    if (!this.hasWtp(ctx)) return [];
    if (op === 'add') {
      if (!ap.central) return [];
      const reported = { bssid: this.bssid(ctx, ap.port), wlanId: ap.wlanId ?? 0 };
      client.reported = reported;
      const ev: WlanGrantEvent = { kind: 'wlan.grant', op: 'add', port: ap.port, station: client.mac, bssid: reported.bssid, wlanId: reported.wlanId, state: 'associated' };
      return [{ type: 'event', to: CAPWAP_WTP_PROCESS, ev }];
    }
    // `reported` is set only for a client of a central BSS, so the del follows the add even when the BSS has just
    // stopped being central (a profile cleared or replaced)
    const reported = client.reported;
    if (reported === undefined) return [];
    delete client.reported;
    const ev: WlanGrantEvent = { kind: 'wlan.grant', op: 'del', port: ap.port, station: client.mac, bssid: reported.bssid, wlanId: reported.wlanId, state: 'idle' };
    return [{ type: 'event', to: CAPWAP_WTP_PROCESS, ev }];
  }

  private bssid(ctx: ProcessCtx, port: PortId): MacAddress {
    return bssidFor(ctx.macOf(port), 0);
  }

  /** The tag EAPOL message 2 and the SAE commit are compared with: the controller's key tag, else the passphrase's. */
  private tag(ap: ApPort): number {
    return ap.keyTag ?? passphraseTag(ap.ssid ?? '', ap.passphrase ?? '');
  }

  /** Management body describing the BSS (probe responses and beacons). */
  private bssBody(ctx: ProcessCtx, ap: ApPort): Record<string, FieldValue> {
    const view = ctx.ports.get(ap.port);
    const body: Record<string, FieldValue> = {
      ssid: ap.ssid ?? '', security: ap.security, beaconIntervalMs: BEACON_INTERVAL_MS, capability: 1,
    };
    const spec = view?.spec.radio;
    if (spec !== undefined) {
      const settings = wlanDaemonSettings(ctx, ap.port);
      body.band = settings.band ?? spec.defaultBand;
      body.rates = ratesFor(settings.band ?? spec.defaultBand);
      if (typeof settings.channel === 'number') body.channel = settings.channel;
    } else {
      body.rates = ratesFor(undefined);
    }
    return body;
  }

  private writeRow(ctx: ProcessCtx, ap: ApPort, client: ApClient | undefined, mac: MacAddress): void {
    const table = ctx.tables.get?.<Dot11AssocRow>('dot11-assoc');
    if (table === undefined) return;
    const key = dot11AssocKey(ap.port, mac);
    if (client === undefined) {
      if (table.has(key)) table.delete(key, 'cleared');
      return;
    }
    const row: Dot11AssocRow = {
      key, port: ap.port, station: mac, bssid: this.bssid(ctx, ap.port), ssid: ap.ssid ?? '', state: ROW_STATE[client.state], updatedAt: ctx.now,
    };
    if (client.aid !== undefined) row.aid = client.aid;
    const link = ctx.air?.link(ap.port, mac);
    if (link !== undefined) {
      row.rssiDbm = link.rssiDbm;
      row.rateBps = link.rateBps;
    }
    table.set(row);
  }

  private sendMgmt(ctx: ProcessCtx, ap: ApPort, subtype: string, station: MacAddress, body: Record<string, FieldValue>, tag: string, duration?: number): Action {
    const bssid = this.bssid(ctx, ap.port);
    const layers = mgmtFrame(subtype, { addr1: station, addr2: bssid, addr3: bssid, ...(duration !== undefined ? { duration } : {}) }, body);
    return { type: 'send', port: ap.port, pdu: ctx.newPdu(layers, { tag }) };
  }

  private deauth(ctx: ProcessCtx, ap: ApPort, station: MacAddress, reason: number): Action {
    return this.sendMgmt(ctx, ap, 'deauth', station, { reasonCode: reason }, 'deauth');
  }

  private medium(ap: ApPort, op: Extract<Action, { type: 'medium' }>['op']): Action {
    return { type: 'medium', port: ap.port, op };
  }

  /**
   * Forget a client: cancel its timer, drop its row and (when the medium holds a grant and `release`) issue `assoc none`.
   * P2: a client reported to the controller is reported `del` (central BSS only, `grant`).
   */
  private forget(ctx: ProcessCtx, ap: ApPort, mac: MacAddress, release: boolean): Action[] {
    const client = ap.clients.get(mac);
    if (client === undefined) return [];
    const actions: Action[] = [{ type: 'cancelTimer', key: eapolKey(ap.port, mac) }];
    if (release && client.granted) actions.push(this.medium(ap, { op: 'assoc', station: mac, state: 'none' }));
    actions.push(...this.grant(ctx, ap, client, 'del'));
    ap.clients.delete(mac);
    this.writeRow(ctx, ap, undefined, mac);
    return actions;
  }

  private syncBeacons(ctx: ProcessCtx, ap: ApPort): Action[] {
    const want = ap.carrier && ap.beacons && ap.ssid !== undefined;
    if (want && !ap.beaconArmed) {
      ap.beaconArmed = true;
      this.emit(ctx, `${ap.port}: beacons every ${BEACON_INTERVAL_MS} ms`, { port: ap.port });
      return [{ type: 'timer', key: beaconKey(ap.port), delay: BEACON_INTERVAL_MS * MS, periodic: true }];
    }
    if (!want && ap.beaconArmed) {
      ap.beaconArmed = false;
      return [{ type: 'cancelTimer', key: beaconKey(ap.port) }];
    }
    return [];
  }

  private beacon(ctx: ProcessCtx, ap: ApPort): Action {
    const bssid = this.bssid(ctx, ap.port);
    const layers = mgmtFrame('beacon', { addr1: MAC_BROADCAST, addr2: bssid, addr3: bssid }, this.bssBody(ctx, ap));
    return { type: 'send', port: ap.port, pdu: ctx.newPdu(layers, { tag: 'beacon', background: true }) };
  }

  private onProbe(ctx: ProcessCtx, ap: ApPort, view: PortView, station: MacAddress, body: Readonly<Record<string, FieldValue>>): Action[] {
    if (ap.ssid === undefined || view.phy?.carrier !== true) return [];
    const wanted = strOf(body.ssid);
    if (wanted !== undefined && wanted !== '' && wanted !== ap.ssid) return [];
    this.probesAnswered++;
    this.emit(ctx, `${ap.port}: answering the probe of ${station} for "${ap.ssid}"`, { port: ap.port, station });
    return [this.sendMgmt(ctx, ap, 'probe-resp', station, this.bssBody(ctx, ap), 'probe-resp')];
  }

  /**
   * Create (or restart) a client record; a client holding a grant is reset in the medium first. P2: a restarted client
   * that was reported to the controller is reported `del` (it is reported `add` again once authorized).
   */
  private restart(ctx: ProcessCtx, ap: ApPort, mac: MacAddress, state: ClientState, actions: Action[]): ApClient {
    const old = ap.clients.get(mac);
    if (old !== undefined && old.granted) {
      actions.push({ type: 'cancelTimer', key: eapolKey(ap.port, mac) });
      actions.push(this.medium(ap, { op: 'assoc', station: mac, state: 'none' }));
    }
    if (old !== undefined) actions.push(...this.grant(ctx, ap, old, 'del'));
    const client: ApClient = { mac, state, granted: false, eapolStep: 0, eapolTimeouts: 0, replay: old?.replay ?? 0 };
    ap.clients.set(mac, client);
    return client;
  }

  private onAuth(ctx: ProcessCtx, ap: ApPort, station: MacAddress, header: Readonly<Record<string, FieldValue>>, body: Readonly<Record<string, FieldValue>>): Action[] {
    if (ap.ssid === undefined) return [];
    const alg = numOf(body.authAlgorithm);
    const seq = numOf(body.authSeq);
    const status = numOf(body.statusCode) ?? STATUS_SUCCESS;
    const actions: Action[] = [];
    if (alg === AUTH_OPEN && seq === 1) {
      if (ap.security === 'wpa3-sae') {
        this.emit(ctx, `${ap.port}: ${station} tried open authentication on an SAE network`, { port: ap.port, station });
        return [this.sendMgmt(ctx, ap, 'auth', station, { authAlgorithm: AUTH_OPEN, authSeq: 2, statusCode: STATUS_FAILURE }, 'auth')];
      }
      const client = this.restart(ctx, ap, station, 'authenticated', actions);
      client.granted = true;
      this.emit(ctx, `${ap.port}: ${station} authenticated (open system)`, { port: ap.port, station });
      actions.push(this.sendMgmt(ctx, ap, 'auth', station, { authAlgorithm: AUTH_OPEN, authSeq: 2, statusCode: STATUS_SUCCESS }, 'auth'));
      actions.push(this.medium(ap, { op: 'assoc', station, state: 'authenticated' }));
      this.writeRow(ctx, ap, client, station);
      return actions;
    }
    if (alg !== AUTH_SAE) return [];
    if (ap.security !== 'wpa3-sae') {
      return [this.sendMgmt(ctx, ap, 'auth', station, { authAlgorithm: AUTH_SAE, authSeq: seq ?? 1, statusCode: STATUS_FAILURE }, 'sae-commit')];
    }
    const ownTag = saeCommitTag(this.tag(ap));
    if (seq === 1) {
      const client = this.restart(ctx, ap, station, 'authenticating', actions);
      const peer = numOf(header.duration);
      if (peer !== undefined) client.saeTag = peer;
      this.emit(ctx, `${ap.port}: SAE commit from ${station}, sending ours`, { port: ap.port, station });
      actions.push(this.sendMgmt(ctx, ap, 'auth', station, { authAlgorithm: AUTH_SAE, authSeq: 1, statusCode: STATUS_SUCCESS }, 'sae-commit', ownTag));
      this.writeRow(ctx, ap, client, station);
      return actions;
    }
    if (seq === 2) {
      const client = ap.clients.get(station);
      if (client === undefined || client.state !== 'authenticating') return [];
      const ok = status === STATUS_SUCCESS && client.saeTag === ownTag;
      actions.push(this.sendMgmt(ctx, ap, 'auth', station, { authAlgorithm: AUTH_SAE, authSeq: 2, statusCode: ok ? STATUS_SUCCESS : STATUS_FAILURE }, 'sae-confirm'));
      if (!ok) {
        this.emit(ctx, `${ap.port}: SAE with ${station} failed: the password elements differ`, { port: ap.port, station });
        actions.push(...this.forget(ctx, ap, station, true));
        return actions;
      }
      client.state = 'authenticated';
      client.granted = true;
      this.emit(ctx, `${ap.port}: ${station} authenticated (SAE)`, { port: ap.port, station });
      actions.push(this.medium(ap, { op: 'assoc', station, state: 'authenticated' }));
      this.writeRow(ctx, ap, client, station);
      return actions;
    }
    return [];
  }

  private onAssocReq(ctx: ProcessCtx, ap: ApPort, view: PortView, station: MacAddress, body: Readonly<Record<string, FieldValue>>): Action[] {
    const client = ap.clients.get(station);
    const reply = (statusCode: number, aid?: number): Action =>
      this.sendMgmt(ctx, ap, 'assoc-resp', station, aid === undefined ? { statusCode, capability: 1 } : { statusCode, aid, capability: 1 }, 'assoc-resp');
    if (client === undefined || client.state === 'authenticating' || ap.ssid === undefined) {
      this.emit(ctx, `${ap.port}: association request from ${station} before authentication`, { port: ap.port, station });
      return [reply(STATUS_FAILURE)];
    }
    if (strOf(body.ssid) !== ap.ssid) {
      this.emit(ctx, `${ap.port}: ${station} asked for another network`, { port: ap.port, station });
      return [reply(STATUS_FAILURE)];
    }
    const actions: Action[] = [];
    if (client.aid === undefined) {
      const used = new Set<number>();
      for (const c of ap.clients.values()) if (c.aid !== undefined) used.add(c.aid);
      const limit = Math.min(view.spec.radio?.maxClients ?? MAX_AID, MAX_AID);
      if (used.size >= limit) {
        this.emit(ctx, `${ap.port}: refusing ${station}: ${limit} stations already joined`, { port: ap.port, station, limit });
        actions.push(reply(STATUS_AP_FULL));
        actions.push(...this.forget(ctx, ap, station, true));
        return actions;
      }
      let aid = 1;
      while (used.has(aid)) aid++;
      client.aid = aid;
    }
    const aid = client.aid;
    this.emit(ctx, `${ap.port}: ${station} associated with aid ${aid}`, { port: ap.port, station, aid });
    actions.push(reply(STATUS_SUCCESS, aid));
    actions.push(this.medium(ap, { op: 'assoc', station, state: 'associated', aid }));
    client.granted = true;
    if (ap.security === 'open') {
      client.state = 'authorized';
      // P2 (§3.12 step 5): a central BSS reports the grant to the controller before the medium opens the station
      actions.push(...this.grant(ctx, ap, client, 'add'));
      actions.push(this.medium(ap, { op: 'authorize', station }));
      this.writeRow(ctx, ap, client, station);
      return actions;
    }
    client.state = 'handshake';
    client.eapolStep = 1;
    client.eapolTimeouts = 0;
    client.replay++;
    const bssid = this.bssid(ctx, ap.port);
    client.last = { layers: eapolFrame('from-ds', station, bssid, { step: 1, replayCounter: client.replay }), tag: 'eapol-1' };
    actions.push({ type: 'send', port: ap.port, pdu: ctx.newPdu(client.last.layers, { tag: client.last.tag }) });
    actions.push({ type: 'timer', key: eapolKey(ap.port, station), delay: RF.EAPOL_TIMEOUT_NS });
    this.writeRow(ctx, ap, client, station);
    return actions;
  }

  private onEapol(ctx: ProcessCtx, ap: ApPort, station: MacAddress, pdu: Pdu): Action[] {
    const client = ap.clients.get(station);
    const key = pdu.layer('eapol')?.fields;
    if (client === undefined || key === undefined || client.state !== 'handshake') return [];
    const step = numOf(key.handshakeStep);
    if (step === 2 && client.eapolStep === 1) {
      if (tagFromBytes(key.keyData) !== this.tag(ap)) {
        this.emit(ctx, `${ap.port}: ${station} answered the key handshake with the wrong passphrase`, { port: ap.port, station });
        return [this.deauth(ctx, ap, station, REASON_HANDSHAKE), ...this.forget(ctx, ap, station, true)];
      }
      client.eapolStep = 3;
      client.eapolTimeouts = 0;
      client.replay++;
      client.last = { layers: eapolFrame('from-ds', station, this.bssid(ctx, ap.port), { step: 3, replayCounter: client.replay }), tag: 'eapol-3' };
      this.emit(ctx, `${ap.port}: key message 2 of 4 from ${station} is valid, sending message 3`, { port: ap.port, station });
      return [
        { type: 'send', port: ap.port, pdu: ctx.newPdu(client.last.layers, { tag: client.last.tag }) },
        { type: 'timer', key: eapolKey(ap.port, station), delay: RF.EAPOL_TIMEOUT_NS },
      ];
    }
    if (step === 4 && client.eapolStep === 3) {
      client.state = 'authorized';
      delete client.last;
      this.emit(ctx, `${ap.port}: key handshake with ${station} complete, traffic allowed`, { port: ap.port, station });
      this.writeRow(ctx, ap, client, station);
      // P2 (§3.12 step 5): a central BSS reports the grant to the controller before the medium opens the station
      return [{ type: 'cancelTimer', key: eapolKey(ap.port, station) }, ...this.grant(ctx, ap, client, 'add'), this.medium(ap, { op: 'authorize', station })];
    }
    return [];
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(WIRELESS_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: WLAN_AP_PROCESS, category: WIRELESS_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: WLAN_AP_PROCESS, category: WIRELESS_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the Wi-Fi access-point daemon (`name: 'wlan-ap'`). One instance per device, created at boot. */
export function createWlanAp(): Process {
  return new WlanAp();
}
