/**
 * protocols/capwap-wtp.ts — the lightweight access point's side of CAPWAP (RFC 5415 WTP state machine with the RFC 5416
 * IEEE 802.11 binding; ARCHITECTURE-P2 D8, D17, §2.3–§2.6, §3.12 steps 2–8, §4.1–§4.3, §5.3; W5 wireless).
 *
 * Silence (§4.3): nothing at all — no socket, no timer, no row, no debug line — unless `capwap enable` is in the running
 * config (replayed by the P2 profile on NF-AP-1832, or typed). An autonomous NF-AP-1832 of a P1 file therefore stays
 * silent even with a static address. With `capwap enable` the daemon waits for its MANAGEMENT INTERFACE — the first
 * oper-up port with an L3 role and an IPv4 address (the AP's `Vlan1`, addressed by DHCP or by hand) — before it sends.
 *
 * States (the `capwap` row, key = controller address; every change is one `ctx.transition('capwap', …)` of machine
 * 'capwap-wtp' with subject `controller <address>`), in RFC 5415 order:
 *   idle        capwap enabled, no management address yet (the periodic `discovery` timer polls; a DHCP lease of the
 *               management interface arrives as the `dhcp.lease` event from dhcp-client and starts discovery at once,
 *               so a leased AP joins during `runToIdle` too — W5 fix; `lost` goes back to idle);
 *   discovery   sockets `capwap-wtp#ctl` (UDP 5246) and `capwap-wtp#data` (UDP 5247, a TUNNEL socket, §2.4) open; a
 *               Discovery Request (1) {wtpName} to every `capwap controller <ip>` line, else to the management subnet's
 *               broadcast, every 10 s (`discovery`, PERIODIC, so an unanswered AP never holds runToIdle); one row and
 *               one lane (transition subject) per target. A changed target list (a `capwap controller` line, a new
 *               management subnet) ends the lanes of the targets that left and starts the new ones; a tick that finds
 *               no management address goes back to idle. The first Discovery Response (2) with result 0 picks the
 *               controller;
 *   dtls        simulated (D8, deviation (16)): one transition with cause 'secure session established (simulated)', no
 *               record on the wire; every later control message in both directions carries `meta.protected`;
 *   join        Join Request (3) → Join Response (4, result 0);
 *   configure   Configuration Status Request (5) → Response (6);
 *   data-check  Change State Event Request (11) → Response (12);
 *   run         Echo Request (13) every 30 s (`echo`, PERIODIC, `meta.background`); three unanswered echoes → back to
 *               discovery. The requests of join, configure and data-check are re-sent by the NON-periodic `join` timer
 *               (3 s, 3 tries in all), after which the AP goes back to discovery.
 * Leaving run (echo loss, a failed join, `no capwap enable`) clears every radio profile this daemon pushed.
 *
 * Run (§3.12 steps 4–8):
 *   • IEEE 802.11 WLAN Configuration Request (3398913) `wlans = '<id>:<ssid>:<security>:<vlan>:<keyTag>'` (an empty SSID
 *     removes WLAN <id>; the header `radioId` selects the radios: 0 every radio, 1 the 2.4 GHz radio, 2 the 5 GHz radio,
 *     3 the 6 GHz radio) → Response (3398914, result 0, or 1 for an entry that does not parse). Each radio (a
 *     `wireless-bss` wlan port, in port order) serves the lowest-numbered WLAN that selects its band — one WLAN per radio
 *     (several WLANs per radio are not built) — through `Action radio-profile {port, bss: [{index: 0, ssid, security,
 *     keyTag, vlan, switching: 'central', wlanId}], controller: <controller name>}` (an empty list when no WLAN selects
 *     it), issued only when a radio's assignment changes;
 *   • `wlan.grant` events from wlan-ap (§2.5) → one WTP Event Request (9) each, `stations = '<add|del>:<station>:<bssid>:
 *     <wlanId>'` (the NF vendor element), answered by 10;
 *   • uplink: an 802.11 to-DS data frame of a central BSS (handed over by wlan-ap, or by the demux selector
 *     `{layer: 'dot11', frame: 'data'}`) is rewrapped IN PLACE — `{strip: 1, push: [ipv4 {AP → controller, protocol 17},
 *     udp {5247 → 5247}, capwap {tbit, radioId}, dot11 {the same header, no FCS}]}`, cause 'controller tunnel' — and
 *     handed to ipv4 (`ipv4.send`; arp adds Ethernet): the station's PduId continues to the controller;
 *   • downlink: a datagram on the data (tunnel) socket from the joined controller is NOT consumed by udp: its 802.11
 *     from-DS frame is restored as the outer layer (`{strip: 5, push: [dot11 {same header}]}`, the FCS derived again,
 *     cause 'controller tunnel') and sent on the radio whose BSSID is the frame's addr2; the air delivers it;
 *   • a tunnelled uplink frame larger than the management interface's MTU is dropped 'giant', detail 'too large for the
 *     controller tunnel' (there is no IPv4 fragmentation; the controller clamps the TCP MSS, §3.12 step 9).
 *
 * No randomness (§4.1): fixed ports, sequence numbers from a counter. Debug category 'capwap' (§5.4).
 *
 * Shared with capwap-ac (both files are the W5 wireless item's): the control-PDU builder, the WLAN and station-report
 * encodings, the radio ids and the timing constants below. Everything is read at call time (rule 12).
 *
 * stateSnapshot():
 *   { process: 'capwap-wtp', state: { enabled, state, controller?, acName?, management?: { port, address },
 *     targets: [address], wlans: [{ id, ssid, security, vlan, radio }], radios: [{ port, wlanId? }], discoveries,
 *     joins, reports, echoesMissed, tunnelledUp, tunnelledDown } }   (never a passphrase or a key tag)
 *
 * ponytail: the WTP joins the first controller that answers (no AC preference lists, no primary/secondary); no image
 * download, no reset, no data-channel keep-alives; the WTP's radios and MAC are not described in the Join Request
 * (the controller takes the AP's MAC from the Ethernet source, so an AP is expected on the management subnet).
 */
import { broadcastOf, isIpv4, type Ipv4Address, type MacAddress, bssidFor } from '../contracts/addr.js';
import { ROLE_TRAITS } from '../contracts/catalog.js';
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import {
  CAPWAP_MSG,
  IPPROTO_UDP,
  UDP_PORT_CAPWAP_CONTROL,
  UDP_PORT_CAPWAP_DATA,
  type FieldValue,
  type LayerSpec,
  type LayerView,
  type Pdu,
  type PduMeta,
} from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { BssSettings, RfBand, WifiSecurity } from '../contracts/rf.js';
import type { CapwapRow, CapwapState, Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent, WlanGrantEvent } from '../contracts/transport.js';
import { flowKey } from '../core/addr6.js';
import { CAUSE_CAPWAP_TUNNEL, dot11HeaderSpec } from '../link/rewrap80211.js';
import { portRadioMode, wlanDaemonSettings } from './wlan-client.js';

// ── shared CAPWAP constants and encodings (used by capwap-ac too) ────────────────────────────────────────────────────

/** Process name of the access point's CAPWAP daemon. */
export const CAPWAP_WTP_NAME = 'capwap-wtp';
/** Debug category of both CAPWAP daemons (`debug capwap`, §5.4). */
export const CAPWAP_DEBUG_CATEGORY = 'capwap';
/** Retry interval of the discovery phase (§3.12 step 2, §4.2: periodic). */
export const CAPWAP_DISCOVERY_INTERVAL_NS: SimTime = 10 * SEC;
/** Echo interval in run (§3.12 step 3, §4.2: periodic). */
export const CAPWAP_ECHO_INTERVAL_NS: SimTime = 30 * SEC;
/** Echoes that may go unanswered before the WTP goes back to discovery. */
export const CAPWAP_ECHO_MISSES = 3;
/** Re-send interval of a join-phase request (RFC 5415 RetransmitInterval; §4.2 `join`, non-periodic). */
export const CAPWAP_RETRANSMIT_NS: SimTime = 3 * SEC;
/** Sends of one join-phase request before the WTP gives up (§3.12 step 3: 3 tries). */
export const CAPWAP_JOIN_TRIES = 3;
/** How long the controller keeps an access point without an echo (§4.2 `ap-age:<mac>`, re-armed per echo). */
export const CAPWAP_AP_AGE_NS: SimTime = 90 * SEC;
/** Cause of the simulated DTLS step (§3.12 step 3; deviation (16)). */
export const CAPWAP_DTLS_CAUSE = 'secure session established (simulated)';
/** Drop detail of a tunnelled frame larger than the tunnel's path MTU (§3.12 step 9). */
export const CAPWAP_TOO_LARGE_DETAIL = 'too large for the controller tunnel';
/** Result code of a successful response (RFC 5415 §4.6.35). */
export const CAPWAP_RESULT_SUCCESS = 0;
/** Result code of a refused request (RFC 5415 §4.6.35 "Failure"). */
export const CAPWAP_RESULT_FAILURE = 1;

/** Trace tags of the CAPWAP control messages, by message type. */
export const CAPWAP_TAGS: Readonly<Record<number, string>> = Object.freeze({
  [CAPWAP_MSG.discoveryReq]: 'capwap-discovery',
  [CAPWAP_MSG.discoveryResp]: 'capwap-discovery-resp',
  [CAPWAP_MSG.joinReq]: 'capwap-join',
  [CAPWAP_MSG.joinResp]: 'capwap-join-resp',
  [CAPWAP_MSG.configStatusReq]: 'capwap-config-status',
  [CAPWAP_MSG.configStatusResp]: 'capwap-config-status-resp',
  [CAPWAP_MSG.wtpEventReq]: 'capwap-wtp-event',
  [CAPWAP_MSG.wtpEventResp]: 'capwap-wtp-event-resp',
  [CAPWAP_MSG.changeStateReq]: 'capwap-change-state',
  [CAPWAP_MSG.changeStateResp]: 'capwap-change-state-resp',
  [CAPWAP_MSG.echoReq]: 'capwap-echo',
  [CAPWAP_MSG.echoResp]: 'capwap-echo-resp',
  [CAPWAP_MSG.wlanConfigReq]: 'capwap-wlan-config',
  [CAPWAP_MSG.wlanConfigResp]: 'capwap-wlan-config-resp',
});

/**
 * Radio id of a band in CAPWAP headers (an NF convention for NF lightweight APs, which carry at most one radio per
 * band): 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz. In a WLAN Configuration Request the header radio id selects the radios
 * the WLAN is offered on, 0 meaning every radio.
 */
export const CAPWAP_RADIO_IDS: Readonly<Partial<Record<RfBand, number>>> = Object.freeze({ '2.4': 1, '5': 2, '6': 3 });

/** Radio id of `band` (0 when the band has none: cellular, 60 GHz). */
export function capwapRadioId(band: RfBand | undefined): number {
  return band === undefined ? 0 : CAPWAP_RADIO_IDS[band] ?? 0;
}

/** Options of one control message. */
export interface CapwapControlOptions {
  readonly src: Ipv4Address;
  readonly dst: Ipv4Address;
  readonly dstPort: number;
  readonly messageType: number;
  readonly seq: number;
  /** Message elements (`wtpName`, `acName`, `resultCode`, `wlans`, `stations`) and header fields (`radioId`). */
  readonly fields?: Readonly<Record<string, FieldValue>>;
  /** After the simulated DTLS step (every message but discovery). */
  readonly protected?: boolean;
  /** Maintenance traffic (echoes). */
  readonly background?: boolean;
  readonly triggeredBy?: PduId;
}

/**
 * A CAPWAP control message `[ipv4, udp 5246 → dstPort, capwap]` built with `ctx.newPdu` (so it carries `meta.protected`
 * and `meta.background`, which `udp.send` cannot set) and handed to ipv4 with `ipv4.send` (arp adds the Ethernet
 * header). The receiving side reads it from its `capwap-*#ctl` socket.
 */
export function capwapControlAction(ctx: ProcessCtx, o: CapwapControlOptions): Action {
  const layers: LayerSpec[] = [
    { proto: 'ipv4', fields: { src: o.src, dst: o.dst, protocol: IPPROTO_UDP, ttl: ctx.model.ipDefaults.ttl } },
    { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_CONTROL, dstPort: o.dstPort } },
    { proto: 'capwap', fields: { ...(o.fields ?? {}), messageType: o.messageType, seq: o.seq & 0xff } },
  ];
  const meta: Partial<PduMeta> = {
    tag: CAPWAP_TAGS[o.messageType] ?? 'capwap',
    flow: flowKey(4, o.src, o.dst, 'udp', UDP_PORT_CAPWAP_CONTROL, o.dstPort),
    ...(o.background === true ? { background: true } : {}),
    ...(o.protected === true ? { protected: true as const } : {}),
    ...(o.triggeredBy !== undefined ? { triggeredBy: o.triggeredBy } : {}),
  };
  const pdu = ctx.newPdu(layers, meta);
  return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu } };
}

/** One WLAN as a controller pushes it (§3.12 step 3): never a passphrase, only the key tag. */
export interface CapwapWlan {
  readonly id: number;
  readonly ssid: string;
  readonly security: WifiSecurity;
  readonly vlan: number;
  readonly keyTag: number;
}

const SECURITIES: readonly WifiSecurity[] = Object.freeze(['open', 'wpa2-psk', 'wpa3-sae']);

/** `<id>:<ssid>:<security>:<vlan>:<keyTag>` (§2.3 `capwap.wlans`). */
export function formatCapwapWlan(w: CapwapWlan): string {
  return `${w.id}:${w.ssid}:${w.security}:${w.vlan}:${w.keyTag >>> 0}`;
}

/** The removal of WLAN `id`: an entry with an empty SSID (NF convention for RFC 5416 Delete WLAN). */
export function formatCapwapWlanRemoval(id: number): string {
  return `${id}::open:0:0`;
}

/**
 * Parse a `wlans` entry, reading the fixed fields from both ends so an SSID may contain ':'. `{remove: id}` for an
 * empty SSID; undefined when the entry does not parse.
 */
export function parseCapwapWlan(text: string): CapwapWlan | { readonly remove: number } | undefined {
  const parts = text.split(':');
  if (parts.length < 5) return undefined;
  const id = Number(parts[0]);
  const keyTag = Number(parts[parts.length - 1]);
  const vlan = Number(parts[parts.length - 2]);
  const security = parts[parts.length - 3] as WifiSecurity;
  const ssid = parts.slice(1, parts.length - 3).join(':');
  if (!Number.isInteger(id) || id < 1 || !/^\d+$/.test(parts[0]!)) return undefined;
  if (ssid === '') return { remove: id };
  if (!SECURITIES.includes(security)) return undefined;
  if (!Number.isInteger(vlan) || vlan < 0 || vlan > 4094 || !/^\d+$/.test(parts[parts.length - 2]!)) return undefined;
  if (!Number.isInteger(keyTag) || keyTag < 0 || keyTag > 0xffffffff || !/^\d+$/.test(parts[parts.length - 1]!)) return undefined;
  return { id, ssid, security, vlan, keyTag };
}

/** One station report of a WTP Event Request (§2.3 `capwap.stations`). */
export interface CapwapStationReport {
  readonly op: 'add' | 'del';
  readonly station: MacAddress;
  readonly bssid: MacAddress;
  readonly wlanId: number;
}

/** `<add|del>:<station mac>:<bssid>:<wlanId>`. */
export function formatCapwapStationReport(r: CapwapStationReport): string {
  return `${r.op}:${r.station}:${r.bssid}:${r.wlanId}`;
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** Parse a `stations` element: reports joined by ';', each with two six-octet MACs (fixed positions). */
export function parseCapwapStationReports(text: string): CapwapStationReport[] {
  const out: CapwapStationReport[] = [];
  for (const item of text.split(';')) {
    const p = item.split(':');
    if (p.length !== 14 || (p[0] !== 'add' && p[0] !== 'del')) continue;
    const station = p.slice(1, 7).join(':').toLowerCase();
    const bssid = p.slice(7, 13).join(':').toLowerCase();
    const wlanId = Number(p[13]);
    if (!MAC_RE.test(station) || !MAC_RE.test(bssid) || !Number.isInteger(wlanId) || wlanId < 0) continue;
    out.push({ op: p[0], station, bssid, wlanId });
  }
  return out;
}

/** Index of the (first) `capwap` layer of a received PDU, or -1. */
export function capwapLayerIndex(pdu: Pick<Pdu, 'layers'>): number {
  return pdu.layers.findIndex((l) => l.proto === 'capwap');
}

/**
 * A name as a CAPWAP text element carries it (WTP Name, AC Name): the codec takes printable ASCII only, so any other
 * character of a device's hostname becomes '?' (a hostname is free text in the GUI).
 */
export function capwapText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x20 && c <= 0x7e ? s[i] : '?';
  }
  return out;
}

/** Transition message wording shared by both daemons: `<subject>: <from> -> <to> (<cause>)`. */
export function capwapTransitionText(subject: string, from: string, to: string, cause?: string): string {
  return `${subject}: ${from} -> ${to}${cause === undefined ? '' : ` (${cause})`}`;
}

// ── the WTP ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Control and data socket ids of the WTP (§3.12 step 2). */
export const WTP_CONTROL_SOCKET = 'capwap-wtp#ctl';
export const WTP_DATA_SOCKET = 'capwap-wtp#data';

const TIMER_DISCOVERY = 'discovery';
const TIMER_JOIN = 'join';
const TIMER_ECHO = 'echo';
const DEBUG_RING = 256;

/** The `capwap` global lines (§5.3): `capwap enable`, `capwap controller <ip>` (multi). */
export interface CapwapWtpConfig {
  readonly enabled: boolean;
  readonly controllers: readonly Ipv4Address[];
}

/** Read the WTP's lines from the running config (an explicit `no capwap enable` is simply not `capwap enable`). */
export function readCapwapWtpConfig(config: ConfigAst): CapwapWtpConfig {
  let enabled = false;
  const controllers: Ipv4Address[] = [];
  for (const n of config.root.children) {
    if (n.key !== 'capwap') continue;
    if (n.args.length === 1 && n.args[0] === 'enable') enabled = true;
    else if (n.args[0] === 'controller' && n.args[1] !== undefined && isIpv4(n.args[1]) && !controllers.includes(n.args[1])) controllers.push(n.args[1]);
  }
  return { enabled, controllers };
}

/** The management interface: the first oper-up port with an L3 role and an IPv4 address (the AP's Vlan1). */
export interface CapwapWtpManagement {
  readonly port: PortId;
  readonly address: Ipv4Address;
  readonly prefixLen: number;
}

/** The WTP's management interface now, or undefined (no address yet, or the port is down). */
export function capwapWtpManagementOf(ctx: Pick<ProcessCtx, 'ports'>): CapwapWtpManagement | undefined {
  for (const view of ctx.ports.values()) {
    const role = view.role ?? view.spec.role;
    if (role === undefined || !ROLE_TRAITS[role].l3 || !view.operUp) continue;
    const a = view.l3.ipv4;
    if (a !== undefined) return { port: view.id, address: a.address, prefixLen: a.prefixLen };
  }
  return undefined;
}

/** A WLAN the WTP holds, with the radio selector it was pushed with. */
interface HeldWlan extends CapwapWlan {
  /** 0 = every radio, else a `CAPWAP_RADIO_IDS` value. */
  readonly radio: number;
}

/** A join-phase request waiting for its response. */
interface Pending {
  readonly messageType: number;
  readonly seq: number;
  tries: number;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** Create the lightweight access point's CAPWAP daemon (`name: 'capwap-wtp'`). One instance per device, created at boot. */
export function createCapwapWtp(): Process {
  const ring: DebugEvent[] = [];
  let enabled = false;
  let controllers: readonly Ipv4Address[] = [];
  let state: CapwapState = 'idle';
  let mgmt: CapwapWtpManagement | undefined;
  let targets: Ipv4Address[] = [];
  let controller: Ipv4Address | undefined;
  let acName: string | undefined;
  let seq = 0;
  let pending: Pending | undefined;
  let echoAwaiting = false;
  let echoMissed = 0;
  let socketsOpen = false;
  let discoveryArmed = false;
  let echoArmed = false;
  let joinArmed = false;
  const wlans = new Map<number, HeldWlan>();
  /** The profile pushed per radio port: its signature ('' = the empty profile). */
  const pushed = new Map<PortId, { signature: string; wlanId?: number }>();
  let discoveries = 0;
  let joins = 0;
  let reports = 0;
  let echoesMissed = 0;
  let tunnelledUp = 0;
  let tunnelledDown = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAPWAP_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: CAPWAP_WTP_NAME, category: CAPWAP_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: CAPWAP_WTP_NAME, category: CAPWAP_DEBUG_CATEGORY, message, data };
    remember(ev);
  }

  function remember(ev: DebugEvent): void {
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  /** One state-machine transition of the controller link (`ctx.transition`, D19). */
  function transition(ctx: ProcessCtx, address: Ipv4Address, from: CapwapState, to: CapwapState, cause?: string, pdu?: PduId): void {
    const subject = `controller ${address}`;
    const fsm: FsmTransition = {
      machine: 'capwap-wtp',
      subject,
      from,
      to,
      ...(cause !== undefined ? { cause } : {}),
      ...(pdu !== undefined ? { pdu } : {}),
    };
    const message = capwapTransitionText(subject, from, to, cause);
    ctx.transition(CAPWAP_DEBUG_CATEGORY, message, fsm, { controller: address, from, to });
    remember({ at: ctx.now, device: ctx.deviceId, process: CAPWAP_WTP_NAME, category: CAPWAP_DEBUG_CATEGORY, message, fsm });
  }

  function table(ctx: ProcessCtx): Table<CapwapRow> | undefined {
    return ctx.tables.get<CapwapRow>('capwap');
  }

  function setRow(ctx: ProcessCtx, address: Ipv4Address, s: CapwapState): void {
    table(ctx)?.set({ key: address, controller: address, state: s, since: ctx.now, wlans: wlans.size, updatedAt: ctx.now });
  }

  /** Rewrite the row's WLAN count without changing its state time. */
  function touchRow(ctx: ProcessCtx): void {
    const t = table(ctx);
    if (controller === undefined || t === undefined) return;
    const row = t.get(controller);
    if (row !== undefined && row.wlans !== wlans.size) t.set({ ...row, wlans: wlans.size, updatedAt: ctx.now });
  }

  function clearRows(ctx: ProcessCtx): void {
    pruneRows(ctx, []);
  }

  /** Delete every row whose controller is not in `keep` (a kept row is rewritten or left as it is by the caller). */
  function pruneRows(ctx: ProcessCtx, keep: readonly Ipv4Address[]): void {
    const t = table(ctx);
    if (t === undefined) return;
    for (const row of t.rows()) if (!keep.includes(row.key)) t.delete(row.key, 'cleared');
  }

  function nextSeq(): number {
    seq = (seq + 1) & 0xff;
    return seq;
  }

  function timer(key: string, delay: SimTime, periodic: boolean): Action {
    return periodic ? { type: 'timer', key, delay, periodic: true } : { type: 'timer', key, delay };
  }

  function armDiscovery(delay: SimTime): Action[] {
    discoveryArmed = true;
    return [timer(TIMER_DISCOVERY, delay, true)];
  }

  function cancel(key: string): Action {
    if (key === TIMER_DISCOVERY) discoveryArmed = false;
    else if (key === TIMER_ECHO) echoArmed = false;
    else if (key === TIMER_JOIN) joinArmed = false;
    return { type: 'cancelTimer', key };
  }

  function openSockets(ctx: ProcessCtx): Action[] {
    if (socketsOpen) return [];
    socketsOpen = true;
    debug(ctx, `opening the control (${UDP_PORT_CAPWAP_CONTROL}) and data (${UDP_PORT_CAPWAP_DATA}) channels`, {});
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: CAPWAP_WTP_NAME, socket: WTP_CONTROL_SOCKET, family: 4, localPort: UDP_PORT_CAPWAP_CONTROL } },
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: CAPWAP_WTP_NAME, socket: WTP_DATA_SOCKET, family: 4, localPort: UDP_PORT_CAPWAP_DATA, tunnel: true } },
    ];
  }

  function closeSockets(): Action[] {
    if (!socketsOpen) return [];
    socketsOpen = false;
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: WTP_CONTROL_SOCKET } },
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: WTP_DATA_SOCKET } },
    ];
  }

  /** A control message to the controller (or a discovery target) from the management address. */
  function control(ctx: ProcessCtx, dst: Ipv4Address, messageType: number, fields: Readonly<Record<string, FieldValue>>, o: { seq: number; protect: boolean; background?: boolean; triggeredBy?: PduId }): Action[] {
    if (mgmt === undefined) return [];
    return [capwapControlAction(ctx, {
      src: mgmt.address,
      dst,
      dstPort: UDP_PORT_CAPWAP_CONTROL,
      messageType,
      seq: o.seq,
      fields,
      protected: o.protect,
      ...(o.background === true ? { background: true } : {}),
      ...(o.triggeredBy !== undefined ? { triggeredBy: o.triggeredBy } : {}),
    })];
  }

  /** Send (and remember for the `join` re-send) a join-phase request. */
  function request(ctx: ProcessCtx, messageType: number, fields: Readonly<Record<string, FieldValue>>, triggeredBy?: PduId): Action[] {
    if (controller === undefined) return [];
    pending = { messageType, seq: nextSeq(), tries: 1, fields };
    joinArmed = true;
    return [
      ...control(ctx, controller, messageType, fields, { seq: pending.seq, protect: true, ...(triggeredBy !== undefined ? { triggeredBy } : {}) }),
      timer(TIMER_JOIN, CAPWAP_RETRANSMIT_NS, false),
    ];
  }

  /** Discovery targets now: the configured controllers, else the management subnet's broadcast. */
  function discoveryTargets(): Ipv4Address[] {
    if (controllers.length > 0) return [...controllers];
    return mgmt === undefined ? [] : [broadcastOf(mgmt.address, mgmt.prefixLen)];
  }

  function sendDiscovery(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    for (const t of targets) {
      discoveries++;
      out.push(...control(ctx, t, CAPWAP_MSG.discoveryReq, { wtpName: capwapText(ctx.hostname) }, { seq: nextSeq(), protect: false }));
    }
    if (targets.length > 0) debug(ctx, `looking for a controller at ${targets.join(', ')}`, { targets: [...targets] });
    return out;
  }

  /**
   * Enter (or, with `from` 'discovery', re-enter) discovery for the current targets; sends at once and re-tries every
   * 10 s. The lanes of subjects that are no target any more end first (the controller of a later state, or a
   * discovery target that left the list), then every NEW target starts; a target that was already discovering keeps
   * its lane and its row.
   */
  function enterDiscovery(ctx: ProcessCtx, from: CapwapState, cause: string): Action[] {
    const previous = controller;
    const open: readonly Ipv4Address[] = from === 'discovery' ? targets : previous !== undefined ? [previous] : [];
    controller = undefined;
    acName = undefined;
    pending = undefined;
    echoAwaiting = false;
    echoMissed = 0;
    targets = discoveryTargets();
    state = 'discovery';
    for (const s of open) if (!targets.includes(s)) transition(ctx, s, from, 'idle', cause);
    pruneRows(ctx, targets);
    for (const t of targets) {
      if (from === 'discovery' && open.includes(t)) continue;
      transition(ctx, t, open.includes(t) ? from : 'idle', 'discovery', cause);
      setRow(ctx, t, 'discovery');
    }
    return [...sendDiscovery(ctx), ...(discoveryArmed ? [] : armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS))];
  }

  /**
   * Discovery without a management address any more (the lease ended, the interface went down): every target's lane
   * ends, the rows go, and the periodic `discovery` timer polls for an address again (the sockets stay open).
   */
  function discoveryToIdle(ctx: ProcessCtx, cause: string): Action[] {
    for (const t of targets) transition(ctx, t, 'discovery', 'idle', cause);
    clearRows(ctx);
    targets = [];
    state = 'idle';
    mgmt = undefined;
    debug(ctx, `stopped looking for a controller: ${cause}`, { cause });
    return discoveryArmed ? [] : armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS);
  }

  /** Back to discovery (or idle when the management address is gone), clearing every radio profile. */
  function fallBack(ctx: ProcessCtx, cause: string): Action[] {
    const from = state;
    const out: Action[] = [...clearProfiles(ctx)];
    if (joinArmed) out.push(cancel(TIMER_JOIN));
    if (echoArmed) out.push(cancel(TIMER_ECHO));
    debug(ctx, `lost the controller ${controller ?? '?'}: ${cause}`, { controller, cause });
    mgmt = capwapWtpManagementOf(ctx);
    if (mgmt === undefined) {
      if (controller !== undefined) transition(ctx, controller, from, 'idle', cause);
      controller = undefined;
      acName = undefined;
      pending = undefined;
      clearRows(ctx);
      targets = [];
      state = 'idle';
      if (!discoveryArmed) out.push(...armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS));
      return out;
    }
    out.push(...enterDiscovery(ctx, from, cause));
    return out;
  }

  /**
   * Stop everything (`no capwap enable`): timers, sockets, profiles, rows. Silent when nothing visible ran — the boot
   * replay of a P2 world can arm the discovery poll with the replayed `capwap enable` and cancel it with a saved
   * `no capwap enable`, and that must leave no trace (§4.3).
   */
  function stop(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    const visible = state !== 'idle' || socketsOpen || pushed.size > 0;
    if (!visible) {
      enabled = false;
      if (discoveryArmed) out.push(cancel(TIMER_DISCOVERY));
      return out;
    }
    out.push(...clearProfiles(ctx));
    if (discoveryArmed) out.push(cancel(TIMER_DISCOVERY));
    if (joinArmed) out.push(cancel(TIMER_JOIN));
    if (echoArmed) out.push(cancel(TIMER_ECHO));
    out.push(...closeSockets());
    for (const t of state === 'discovery' ? targets : controller !== undefined ? [controller] : []) transition(ctx, t, state, 'idle', 'capwap disabled');
    clearRows(ctx);
    state = 'idle';
    enabled = false;
    controller = undefined;
    acName = undefined;
    pending = undefined;
    targets = [];
    mgmt = undefined;
    debug(ctx, 'CAPWAP disabled: the access point works on its own lines again', {});
    return out;
  }

  /** Re-read the lines and start when enabled with a management address (§3.12 step 2). */
  function evaluate(ctx: ProcessCtx): Action[] {
    const cfg = readCapwapWtpConfig(ctx.config);
    if (!cfg.enabled) return stop(ctx);
    enabled = true;
    const controllersChanged = cfg.controllers.join(',') !== controllers.join(',');
    controllers = cfg.controllers;
    const out: Action[] = [];
    if (state === 'idle') {
      const m = capwapWtpManagementOf(ctx);
      if (m === undefined) {
        if (!discoveryArmed) out.push(...armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS));
        return out;
      }
      mgmt = m;
      debug(ctx, `management interface ${m.port} has ${m.address}: starting controller discovery`, { port: m.port, address: m.address });
      out.push(...openSockets(ctx), ...enterDiscovery(ctx, 'idle', 'management address ready'));
      return out;
    }
    if (state === 'discovery' && controllersChanged) {
      const m = capwapWtpManagementOf(ctx);
      if (m === undefined) return discoveryToIdle(ctx, 'the management interface has no address');
      mgmt = m;
      out.push(...enterDiscovery(ctx, 'discovery', 'controller list changed'));
    }
    return out;
  }

  // ── radio profiles ──

  /** The AP's controller-managed radios: every `wireless-bss` wlan port, in port order. */
  function apRadios(ctx: ProcessCtx): PortId[] {
    const out: PortId[] = [];
    for (const view of ctx.ports.values()) if (view.spec.kind === 'wlan' && portRadioMode(view) === 'ap') out.push(view.id);
    return out;
  }

  /** Assign each radio the lowest-numbered WLAN that selects its band; push the radios whose assignment changed. */
  function applyWlans(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    const ordered = [...wlans.values()].sort((a, b) => a.id - b.id);
    for (const port of apRadios(ctx)) {
      const band = wlanDaemonSettings(ctx, port).band;
      const rid = capwapRadioId(band);
      const w = ordered.find((x) => x.radio === 0 || x.radio === rid);
      const bss: BssSettings[] = w === undefined
        ? []
        : [{ index: 0, ssid: w.ssid, security: w.security, keyTag: w.keyTag, vlan: w.vlan, switching: 'central', wlanId: w.id }];
      const signature = w === undefined ? '' : `${w.id}|${w.ssid}|${w.security}|${w.keyTag}|${w.vlan}`;
      const before = pushed.get(port);
      if (before !== undefined && before.signature === signature) continue;
      pushed.set(port, w === undefined ? { signature } : { signature, wlanId: w.id });
      debug(ctx, w === undefined ? `${port}: no WLAN of the controller uses this radio` : `${port}: serving WLAN ${w.id} "${w.ssid}" for the controller`, {
        port,
        wlanId: w?.id,
      });
      const action: Action = acName === undefined ? { type: 'radio-profile', port, bss } : { type: 'radio-profile', port, bss, controller: acName };
      out.push(action);
    }
    return out;
  }

  /** Clear every radio profile this daemon pushed (the radios fall back to their own lines). */
  function clearProfiles(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    for (const port of [...pushed.keys()]) {
      out.push({ type: 'radio-profile', port, bss: null });
      debug(ctx, `${port}: controller profile removed`, { port });
    }
    pushed.clear();
    wlans.clear();
    return out;
  }

  // ── received control messages ──

  function onControl(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const pdu = ev.pdu;
    const i = capwapLayerIndex(pdu);
    const cap: LayerView | undefined = i < 0 ? undefined : pdu.layers[i];
    const type = cap?.fields.messageType;
    if (cap === undefined || typeof type !== 'number' || cap.error !== undefined) {
      debug(ctx, `ignoring a malformed control message from ${ev.from}`, { pdu: pdu.id });
      return [];
    }
    const rseq = typeof cap.fields.seq === 'number' ? cap.fields.seq : 0;
    const result = typeof cap.fields.resultCode === 'number' ? cap.fields.resultCode : CAPWAP_RESULT_SUCCESS;
    if (type === CAPWAP_MSG.discoveryResp) {
      if (state !== 'discovery' || !enabled) return [];
      if (controllers.length > 0 && !controllers.includes(ev.from)) return [];
      if (result !== CAPWAP_RESULT_SUCCESS) {
        debug(ctx, `controller ${ev.from} refused discovery (result ${result})`, { controller: ev.from, result });
        return [];
      }
      return joinController(ctx, ev.from, typeof cap.fields.acName === 'string' ? cap.fields.acName : undefined, pdu.id);
    }
    if (ev.from !== controller) return [];
    switch (type) {
      case CAPWAP_MSG.joinResp:
        return advance(ctx, 'join', 'configure', 'joined', rseq, result, pdu.id, () => request(ctx, CAPWAP_MSG.configStatusReq, { wtpName: capwapText(ctx.hostname) }, pdu.id));
      case CAPWAP_MSG.configStatusResp:
        return advance(ctx, 'configure', 'data-check', 'configuration accepted', rseq, result, pdu.id, () => request(ctx, CAPWAP_MSG.changeStateReq, {}, pdu.id));
      case CAPWAP_MSG.changeStateResp:
        return advance(ctx, 'data-check', 'run', 'state change accepted', rseq, result, pdu.id, () => enterRun(ctx));
      case CAPWAP_MSG.echoResp:
        if (state === 'run') {
          echoAwaiting = false;
          echoMissed = 0;
        }
        return [];
      case CAPWAP_MSG.wtpEventResp:
        return [];
      case CAPWAP_MSG.wlanConfigReq:
        return state === 'run' ? onWlanConfig(ctx, cap, rseq, pdu.id) : [];
      default:
        debug(ctx, `ignoring control message ${type} from ${ev.from}`, { type });
        return [];
    }
  }

  /** The first Discovery Response: discovery → dtls (simulated) → join, Join Request sent. */
  function joinController(ctx: ProcessCtx, address: Ipv4Address, name: string | undefined, pdu: PduId): Action[] {
    // the other targets' lanes end and their rows go; the controller's row (its own target's, when it was one) follows
    for (const t of targets) if (t !== address) transition(ctx, t, 'discovery', 'idle', `controller ${address} answered`);
    pruneRows(ctx, [address]);
    controller = address;
    acName = name;
    targets = [];
    state = 'dtls';
    transition(ctx, address, 'discovery', 'dtls', CAPWAP_DTLS_CAUSE, pdu);
    setRow(ctx, address, 'dtls');
    state = 'join';
    joins++;
    transition(ctx, address, 'dtls', 'join', 'join request sent');
    setRow(ctx, address, 'join');
    const out: Action[] = [];
    if (discoveryArmed) out.push(cancel(TIMER_DISCOVERY));
    out.push(...request(ctx, CAPWAP_MSG.joinReq, { wtpName: capwapText(ctx.hostname) }, pdu));
    return out;
  }

  /** A join-phase response: when it answers the pending request in state `from`, move to `to` and run `next`. */
  function advance(ctx: ProcessCtx, from: CapwapState, to: CapwapState, cause: string, rseq: number, result: number, pdu: PduId, next: () => Action[]): Action[] {
    if (state !== from || pending === undefined || pending.seq !== rseq) return [];
    if (result !== CAPWAP_RESULT_SUCCESS) return fallBack(ctx, `the controller refused (result ${result})`);
    pending = undefined;
    const out: Action[] = [];
    if (joinArmed) out.push(cancel(TIMER_JOIN));
    state = to;
    transition(ctx, controller!, from, to, cause, pdu);
    setRow(ctx, controller!, to);
    out.push(...next());
    return out;
  }

  function enterRun(ctx: ProcessCtx): Action[] {
    echoAwaiting = false;
    echoMissed = 0;
    debug(ctx, `joined controller ${acName ?? controller ?? '?'}`, { controller, acName });
    echoArmed = true;
    return [timer(TIMER_ECHO, CAPWAP_ECHO_INTERVAL_NS, true)];
  }

  /** IEEE 802.11 WLAN Configuration Request: update the held WLANs, answer, re-assign the radios. */
  function onWlanConfig(ctx: ProcessCtx, cap: LayerView, rseq: number, pdu: PduId): Action[] {
    const text = typeof cap.fields.wlans === 'string' ? cap.fields.wlans : '';
    const parsed = parseCapwapWlan(text);
    const radio = typeof cap.fields.radioId === 'number' ? cap.fields.radioId : 0;
    let result = CAPWAP_RESULT_SUCCESS;
    if (parsed === undefined) {
      result = CAPWAP_RESULT_FAILURE;
      debug(ctx, `could not read the WLAN configuration "${text}"`, { wlans: text });
    } else if ('remove' in parsed) {
      wlans.delete(parsed.remove);
      debug(ctx, `controller removed WLAN ${parsed.remove}`, { wlanId: parsed.remove });
    } else {
      wlans.set(parsed.id, { ...parsed, radio });
      debug(ctx, `controller configured WLAN ${parsed.id} "${parsed.ssid}" (${parsed.security}, VLAN ${parsed.vlan})`, { wlanId: parsed.id, vlan: parsed.vlan });
    }
    const out: Action[] = controller === undefined ? [] : control(ctx, controller, CAPWAP_MSG.wlanConfigResp, { resultCode: result }, { seq: rseq, protect: true, triggeredBy: pdu });
    out.push(...applyWlans(ctx));
    touchRow(ctx);
    return out;
  }

  // ── tunnel ──

  /** Uplink: a central BSS's 802.11 data frame, rewrapped into CAPWAP in place and handed to ipv4 (§3.12 step 6). */
  function tunnelUp(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const d = pdu.layers[0];
    if (d === undefined || d.proto !== 'dot11' || d.fields.frameType !== 'data' || d.fields.toDs !== true) {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'not an 802.11 data frame for the distribution system', port }];
    }
    const settings = wlanDaemonSettings(ctx, port);
    if (!settings.central) return [{ type: 'drop', pdu, reason: 'other', detail: `${port} is not switched by a controller`, port }];
    if (state !== 'run' || controller === undefined || mgmt === undefined) {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'no controller to carry the frame', port }];
    }
    const op = {
      strip: 1,
      push: [
        { proto: 'ipv4', fields: { src: mgmt.address, dst: controller, protocol: IPPROTO_UDP, ttl: ctx.model.ipDefaults.ttl } },
        { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_DATA, dstPort: UDP_PORT_CAPWAP_DATA } },
        { proto: 'capwap', fields: { tbit: true, radioId: capwapRadioId(settings.band) } },
        dot11HeaderSpec(d),
      ] as LayerSpec[],
    };
    ctx.rewrap(pdu, op, CAUSE_CAPWAP_TUNNEL);
    const mtu = ctx.ports.get(mgmt.port)?.mtu ?? 1500;
    if (pdu.size > mtu) return [{ type: 'drop', pdu, reason: 'giant', detail: CAPWAP_TOO_LARGE_DETAIL, port }];
    tunnelledUp++;
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, cause: CAUSE_CAPWAP_TUNNEL } }];
  }

  /** Downlink: a datagram of the data (tunnel) socket; the 802.11 frame goes out the radio of its BSSID (§3.12 step 8). */
  function tunnelDown(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const pdu = ev.pdu;
    const i = capwapLayerIndex(pdu);
    const cap = i < 0 ? undefined : pdu.layers[i];
    if (cap === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: 'not a CAPWAP data message', port: ev.iface }];
    if (cap.fields.keepAlive === true) return [{ type: 'consume', pdu }];
    if (state !== 'run' || ev.from !== controller) {
      return [{ type: 'drop', pdu, reason: 'other', detail: `${ev.from} is not the controller this access point joined`, port: ev.iface }];
    }
    const d = pdu.layers[i + 1];
    if (d === undefined || d.proto !== 'dot11' || d.fields.frameType !== 'data' || d.fields.fromDs !== true || typeof d.fields.addr2 !== 'string') {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'the tunnel carried no 802.11 data frame from the distribution system', port: ev.iface }];
    }
    const bssid = d.fields.addr2;
    const radio = apRadios(ctx).find((p) => bssidFor(ctx.macOf(p), 0) === bssid && wlanDaemonSettings(ctx, p).central);
    if (radio === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: `no radio of this access point serves BSSID ${bssid}`, port: ev.iface }];
    ctx.rewrap(pdu, { strip: i + 2, push: [dot11HeaderSpec(d)] }, CAUSE_CAPWAP_TUNNEL);
    tunnelledDown++;
    return [{ type: 'send', port: radio, pdu }];
  }

  // ── management address leases ──

  /**
   * `dhcp.lease` from dhcp-client (§2.5; W5 fix). dhcp-client binds the address through ipv4 before it sends the event,
   * so the port view already holds it: `bound` / `renewed` start discovery at once when idle (the periodic tick is not
   * waited for, which `runToIdle` would never dispatch) or re-target it; `lost` leaves discovery, or the controller.
   */
  function onLease(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'dhcp.lease' }>): Action[] {
    if (ev.family === 6 || !enabled) return [];
    const m = capwapWtpManagementOf(ctx);
    if (ev.op === 'lost') {
      if (m !== undefined) return [];
      if (state === 'discovery') return discoveryToIdle(ctx, 'the management address lease ended');
      return state === 'idle' ? [] : fallBack(ctx, 'the management address lease ended');
    }
    if (state === 'idle') return evaluate(ctx);
    if (state !== 'discovery') return [];
    if (m === undefined) return discoveryToIdle(ctx, 'the management interface has no address');
    mgmt = m;
    return discoveryTargets().join(',') !== targets.join(',') ? enterDiscovery(ctx, 'discovery', 'management address changed') : [];
  }

  // ── station reports ──

  function onGrant(ctx: ProcessCtx, ev: WlanGrantEvent): Action[] {
    if (state !== 'run' || controller === undefined) return [];
    const report = formatCapwapStationReport({ op: ev.op, station: ev.station, bssid: ev.bssid, wlanId: ev.wlanId });
    reports++;
    debug(ctx, `reporting ${ev.op === 'add' ? 'a new' : 'a departed'} station ${ev.station} on ${ev.port} to the controller`, { station: ev.station, op: ev.op, port: ev.port });
    return control(ctx, controller, CAPWAP_MSG.wtpEventReq, { stations: report }, { seq: nextSeq(), protect: true });
  }

  return {
    name: CAPWAP_WTP_NAME,
    handles: [{ layer: 'dot11', frame: 'data', roles: ['wireless-bss'] }],

    init(ctx: ProcessCtx): Action[] {
      return evaluate(ctx);
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return tunnelUp(ctx, pdu, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (key === TIMER_DISCOVERY) {
        discoveryArmed = false;
        if (!enabled) return [];
        if (state === 'idle') {
          const out = evaluate(ctx);
          if (!discoveryArmed && enabled && (state === 'idle' || state === 'discovery')) out.push(...armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS));
          return out;
        }
        if (state !== 'discovery') return [];
        const m = capwapWtpManagementOf(ctx);
        if (m === undefined) return discoveryToIdle(ctx, 'the management interface has no address');
        mgmt = m;
        // a new management subnet moves the broadcast target: its lanes and rows follow (enterDiscovery re-arms)
        if (discoveryTargets().join(',') !== targets.join(',')) return enterDiscovery(ctx, 'discovery', 'management address changed');
        return [...sendDiscovery(ctx), ...armDiscovery(CAPWAP_DISCOVERY_INTERVAL_NS)];
      }
      if (key === TIMER_JOIN) {
        joinArmed = false;
        if (pending === undefined || controller === undefined || (state !== 'join' && state !== 'configure' && state !== 'data-check')) return [];
        if (pending.tries >= CAPWAP_JOIN_TRIES) return fallBack(ctx, `no answer after ${CAPWAP_JOIN_TRIES} tries`);
        pending.tries++;
        joinArmed = true;
        debug(ctx, `re-sending message ${pending.messageType} to ${controller} (try ${pending.tries} of ${CAPWAP_JOIN_TRIES})`, { type: pending.messageType, tries: pending.tries });
        return [
          ...control(ctx, controller, pending.messageType, pending.fields, { seq: pending.seq, protect: true }),
          timer(TIMER_JOIN, CAPWAP_RETRANSMIT_NS, false),
        ];
      }
      if (key === TIMER_ECHO) {
        echoArmed = false;
        if (state !== 'run' || controller === undefined) return [];
        if (echoAwaiting) {
          echoMissed++;
          echoesMissed++;
          if (echoMissed >= CAPWAP_ECHO_MISSES) return fallBack(ctx, `${CAPWAP_ECHO_MISSES} echo requests went unanswered`);
        }
        echoAwaiting = true;
        echoArmed = true;
        return [
          ...control(ctx, controller, CAPWAP_MSG.echoReq, {}, { seq: nextSeq(), protect: true, background: true }),
          timer(TIMER_ECHO, CAPWAP_ECHO_INTERVAL_NS, true),
        ];
      }
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const global = delta.context.length === 0 && delta.line[0] === 'capwap';
      const iface = delta.context.length === 1 && delta.context[0]?.[0] === 'interface' && delta.line[0] === 'ip';
      if (!global && !iface) return [];
      if (global) return evaluate(ctx);
      // an address line: ipv4 writes the port's address when every daemon's onConfig actions are applied, so look again
      // on the next discovery tick, at once (a zero delay keeps the documented `discovery` key)
      if (!enabled || state !== 'idle') return [];
      return armDiscovery(0);
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      if (!enabled || !up || state !== 'idle') return [];
      const view = ctx.ports.get(port);
      const role = view === undefined ? undefined : view.role ?? view.spec.role;
      if (role === undefined || !ROLE_TRAITS[role].l3) return [];
      // this daemon hears the link change before ipv4 installs the connected route of the port, so start on the next
      // discovery tick, at once (a fresh dispatch at the same instant, after every daemon has seen the change)
      return armDiscovery(0);
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'sock.datagram':
          if (ev.socket === WTP_CONTROL_SOCKET) return onControl(ctx, ev);
          if (ev.socket === WTP_DATA_SOCKET) return tunnelDown(ctx, ev);
          return [];
        case 'sock.error':
          if (ev.socket === WTP_CONTROL_SOCKET || ev.socket === WTP_DATA_SOCKET) debug(ctx, `socket ${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
          return [];
        case 'wlan.grant':
          return onGrant(ctx, ev);
        case 'dhcp.lease':
          return onLease(ctx, ev);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const s: Record<string, unknown> = { enabled, state };
      if (controller !== undefined) s.controller = controller;
      if (acName !== undefined) s.acName = acName;
      if (mgmt !== undefined) s.management = { port: mgmt.port, address: mgmt.address };
      s.targets = [...targets];
      s.wlans = [...wlans.values()].sort((a, b) => a.id - b.id).map((w) => ({ id: w.id, ssid: w.ssid, security: w.security, vlan: w.vlan, radio: w.radio }));
      s.radios = [...pushed.entries()].map(([port, p]) => (p.wlanId === undefined ? { port } : { port, wlanId: p.wlanId }));
      s.discoveries = discoveries;
      s.joins = joins;
      s.reports = reports;
      s.echoesMissed = echoesMissed;
      s.tunnelledUp = tunnelledUp;
      s.tunnelledDown = tunnelledDown;
      return { process: CAPWAP_WTP_NAME, state: s };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

