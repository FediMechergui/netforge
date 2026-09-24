/**
 * protocols/capwap-ac.ts — the wireless controller's side of CAPWAP (RFC 5415 AC state machine per access point, the
 * RFC 5416 IEEE 802.11 binding) and central switching (ARCHITECTURE-P2 D8, D17, §2.3–§2.6, §3.0, §3.12 steps 3–9,
 * §4.1–§4.3, §5.3; W5 wireless). The NF-WLC-9800 controller appliance runs it (`wireless-controller`).
 *
 * Silence (§4.3): it answers only. It opens its sockets — `capwap-ac#ctl` (UDP 5246) and `capwap-ac#data` (UDP 5247, a
 * TUNNEL socket, §2.4), both wildcard binds — only when its MANAGEMENT INTERFACE has an address: the
 * `wlc-interface management` section names a VLAN and an address, and the device owns that address (the controller's
 * CLI handler maintains `interface Vlan<v>` / `ip address …` for it). Only datagrams to the management address (or a
 * discovery broadcast received on the management SVI) are answered. No management interface → no socket, no row, no
 * debug line.
 *
 * Configuration (§5.3, read from the running config at call time; the cli owns the grammar):
 *   wlc-interface <name>   vlan <v> · address <a> <mask> · gateway <a> · dhcp-server <a> (stored, shown, gradeable —
 *                          client DHCP is bridged into the VLAN, not proxied: deviation (15))
 *   wlan <id> <profile> <ssid>   security open|wpa2-psk|wpa3-sae (default open) · passphrase <rest> · interface <name>
 *                          (default `management`) · radio 2.4|5|all (default all; a stored `radio 6` is read too) ·
 *                          shutdown (absent = enabled)
 * A WLAN is PUSHED when it is enabled, its interface exists with a VLAN, and its SSID is printable ASCII. It travels as
 * `wlans = '<id>:<ssid>:<security>:<vlan>:<keyTag>'` with `keyTag = passphraseTag(ssid, passphrase)` (the P0.5 tag,
 * 0 for an open WLAN) — never the passphrase — and the radio selection in the header `radioId` (0 all, 1 2.4 GHz,
 * 2 5 GHz, 3 6 GHz); a removed or shut WLAN is pushed as `<id>::open:0:0` (an empty SSID = remove, see capwap-wtp).
 *
 * Per access point (the AP's session is keyed by its address; its `capwap-aps` row by its MAC, the Ethernet source of
 * its Join Request; every change is one `ctx.transition('capwap', …)` of machine 'capwap-ac', subject
 * `access point <mac>`), in RFC 5415 order:
 *   Discovery Request (1) → Discovery Response (2) {acName, result 0} (stateless, not protected);
 *   Join Request (3) → the simulated DTLS step (idle → dtls, cause 'secure session established (simulated)') → join →
 *     Join Response (4, result 0); from here every message carries `meta.protected`; `ap-age:<mac>` armed;
 *   Configuration Status Request (5) → configure, Response (6);
 *   Change State Event Request (11) → data-check, Response (12) → run; then one IEEE 802.11 WLAN Configuration
 *     Request (3398913) per pushed WLAN (answered by 3398914), and again for every later WLAN change;
 *   WTP Event Request (9): each station report writes (`add`: ssid, VLAN and interface NAME from the WLAN, state
 *     'associated') or deletes (`del`, reason 'cleared', only when the row still names this AP) the `wlan-clients` row —
 *     this daemon is its ONLY writer — then Response (10); the AP row's `clients` follows;
 *   Echo Request (13) → Echo Response (14, `meta.background`) and `ap-age:<mac>` re-armed (90 s, PERIODIC). When it
 *     fires the AP is gone: its station rows and its row are deleted (an AP leaving run deletes its stations' rows).
 * A repeated request (the WTP re-sent it) is answered again without a new transition.
 *
 * Central switching (§3.0, §3.12 steps 7–9):
 *   • uplink — a datagram on the tunnel socket is NOT consumed by udp. The frame
 *     `[ethernet, ipv4, udp, capwap {tbit}, dot11 to-DS, llc, …]` is rewrapped in place
 *     `{strip: 6, push: [ethernet {dst: addr3, src: addr2, type 0x8100}, dot1q {vid: the station's WLAN VLAN}]}`,
 *     cause 'controller bridging', and handed to eth-switch with `Action ingress {port: 'Capwap0'}` (the auto
 *     `wlan-tunnel` port, which carries every VLAN tagged): one PduId from the station to the gateway;
 *   • downlink — eth-switch sends a frame for a wireless station to Capwap0; this daemon owns that port's egress
 *     (`onEgress`): the VLAN from the tag, the station → AP from its `wlan-clients` row in that VLAN (no row, or the
 *     station's row names another VLAN → drop 'other', `no access point serves <station>`), then `{strip: 2, push:
 *     [ipv4 {controller → AP}, udp {5247 → 5247}, capwap
 *     {tbit, radioId}, dot11 from-DS {addr1 station, addr2 BSSID, addr3 source}, llc]}`, cause 'controller bridging',
 *     and `ipv4.send`. A group frame is cloned (all clones allocated first) once per (AP, BSSID) that serves a station
 *     of its VLAN other than the source, APs in device-id order (§4.5; the id of the device that sent the AP's Join
 *     Request, its `PduMeta.origin` — the one handle the simulation gives the controller on an AP's device), then
 *     BSSIDs in order; with no such station it is not sent (as the air does with a group frame and no station);
 *   • MSS — a TCP SYN crossing Capwap0 (both ways) whose MSS option exceeds 1360 is clamped to 1360
 *     (`mutate('tcp.mss', 1360, 'Other', 'controller MSS adjustment')`); a tunnelled frame still larger than the
 *     management interface's MTU is dropped 'giant', detail 'too large for the controller tunnel' (no fragmentation).
 * The downlink `radioId` is the one the AP last used for that BSSID in an uplink frame (0 before any).
 *
 * No randomness (§4.1). Debug category 'capwap' (§5.4).
 *
 * stateSnapshot():
 *   { process: 'capwap-ac', state: { active, management?: { vlan, address, port }, aps: [{ apMac, apIp, name, state,
 *     clients }], wlans: [{ id, profile, ssid, security, interface, vlan?, radio, enabled }], tunnelledUp,
 *     tunnelledDown } }   (never a passphrase or a key tag)
 *
 * ponytail: association stays at the AP (local MAC, deviation (14)); no DHCP proxy (deviation (15)); no AP groups,
 * no FlexConnect, no roaming hand-off; an AP joining through a router is recorded under the router-facing MAC. Two
 * APs behind one router therefore share that MAC: while one of them is joined, the other one's Discovery and Join
 * Requests are answered with result 1 and a debug line naming the conflict, so the joined AP stays up instead of the
 * two evicting each other for ever (W5 fix). The same AP re-joining from a new address (the same device, told by the
 * request's `PduMeta.origin`) still replaces its old session. Giving each AP its own identity needs an AP MAC element
 * in the requests (a contract change left to the architect).
 */
import { MAC_BROADCAST, broadcastOf, isIpv4, isIpv4Broadcast, isMulticastMac, type Ipv4Address, type MacAddress } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { DeviceId, PduId, PortId } from '../contracts/ids.js';
import { CAPWAP_MSG, ETHERTYPE_VLAN, IPPROTO_UDP, UDP_PORT_CAPWAP_CONTROL, UDP_PORT_CAPWAP_DATA, type FieldValue, type LayerSpec, type LayerView, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { WifiSecurity } from '../contracts/rf.js';
import type { CapwapApRow, CapwapState, Table, WlanClientRow } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { CAUSE_CONTROLLER_BRIDGING, fromDsDataHeaders, passphraseTag } from '../link/rewrap80211.js';
import {
  CAPWAP_AP_AGE_NS,
  CAPWAP_DEBUG_CATEGORY,
  CAPWAP_DTLS_CAUSE,
  CAPWAP_RESULT_FAILURE,
  CAPWAP_RESULT_SUCCESS,
  CAPWAP_TOO_LARGE_DETAIL,
  capwapControlAction,
  capwapLayerIndex,
  capwapText,
  capwapTransitionText,
  formatCapwapWlan,
  formatCapwapWlanRemoval,
  parseCapwapStationReports,
  type CapwapStationReport,
} from './capwap-wtp.js';

/** Process name of the controller's CAPWAP daemon. */
export const CAPWAP_AC_NAME = 'capwap-ac';
/** Control and data socket ids of the controller. */
export const AC_CONTROL_SOCKET = 'capwap-ac#ctl';
export const AC_DATA_SOCKET = 'capwap-ac#data';
/** The TCP MSS the controller clamps SYNs to (§3.12 step 9). */
export const CAPWAP_TUNNEL_MSS = 1360;
/** Provenance cause of the MSS clamp. */
export const CAPWAP_MSS_CAUSE = 'controller MSS adjustment';
/** The predefined management interface (§5.3). */
export const CAPWAP_AC_MANAGEMENT_IFACE = 'management';

const DEBUG_RING = 256;
const AGE_PREFIX = 'ap-age:';
const SECURITIES: readonly WifiSecurity[] = Object.freeze(['open', 'wpa2-psk', 'wpa3-sae']);

/** One `wlc-interface <name>` section. */
export interface CapwapAcInterface {
  readonly name: string;
  readonly vlan?: number;
  readonly address?: Ipv4Address;
  readonly mask?: string;
  readonly gateway?: Ipv4Address;
  readonly dhcpServer?: Ipv4Address;
}

/** One `wlan <id> <profile> <ssid>` section. */
export interface CapwapAcWlan {
  readonly id: number;
  readonly profile: string;
  readonly ssid: string;
  readonly security: WifiSecurity;
  readonly passphrase?: string;
  /** Controller interface NAME (default `management`). */
  readonly iface: string;
  readonly radio: 'all' | '2.4' | '5' | '6';
  readonly enabled: boolean;
}

/** The controller interfaces of the running config, by name (config order). */
export function readCapwapAcInterfaces(config: ConfigAst): Map<string, CapwapAcInterface> {
  const out = new Map<string, CapwapAcInterface>();
  for (const n of config.root.children) {
    if (n.key !== 'wlc-interface' || n.args.length !== 1 || out.has(n.args[0]!)) continue;
    const name = n.args[0]!;
    let vlan: number | undefined;
    let address: Ipv4Address | undefined;
    let mask: string | undefined;
    let gateway: Ipv4Address | undefined;
    let dhcpServer: Ipv4Address | undefined;
    for (const c of n.children) {
      const a = c.args[0];
      if (c.key === 'vlan' && a !== undefined && /^\d{1,4}$/.test(a) && Number(a) >= 1 && Number(a) <= 4094) vlan = Number(a);
      else if (c.key === 'address' && a !== undefined && isIpv4(a)) {
        address = a;
        mask = c.args[1];
      } else if (c.key === 'gateway' && a !== undefined && isIpv4(a)) gateway = a;
      else if (c.key === 'dhcp-server' && a !== undefined && isIpv4(a)) dhcpServer = a;
    }
    out.set(name, {
      name,
      ...(vlan !== undefined ? { vlan } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(mask !== undefined ? { mask } : {}),
      ...(gateway !== undefined ? { gateway } : {}),
      ...(dhcpServer !== undefined ? { dhcpServer } : {}),
    });
  }
  return out;
}

/** The WLANs of the running config, ascending by id (a repeated id keeps the first section). */
export function readCapwapAcWlans(config: ConfigAst): CapwapAcWlan[] {
  const byId = new Map<number, CapwapAcWlan>();
  for (const n of config.root.children) {
    if (n.key !== 'wlan' || n.args.length !== 3 || !/^\d{1,4}$/.test(n.args[0]!)) continue;
    const id = Number(n.args[0]);
    if (id < 1 || byId.has(id)) continue;
    let security: WifiSecurity = 'open';
    let passphrase: string | undefined;
    let iface = CAPWAP_AC_MANAGEMENT_IFACE;
    let radio: CapwapAcWlan['radio'] = 'all';
    let enabled = true;
    for (const c of n.children) {
      const a = c.args[0];
      if (c.key === 'security' && a !== undefined && (SECURITIES as readonly string[]).includes(a)) security = a as WifiSecurity;
      else if (c.key === 'passphrase' && c.args.length > 0) passphrase = c.args.join(' ');
      else if (c.key === 'interface' && a !== undefined) iface = a;
      else if (c.key === 'radio' && (a === 'all' || a === '2.4' || a === '5' || a === '6')) radio = a;
      else if (c.key === 'shutdown') enabled = false;
    }
    byId.set(id, { id, profile: n.args[1]!, ssid: n.args[2]!, security, iface, radio, enabled, ...(passphrase !== undefined ? { passphrase } : {}) });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Header radio id of a WLAN's radio selection (0 = every radio; see capwap-wtp `CAPWAP_RADIO_IDS`). */
export function capwapWlanRadioSelector(radio: CapwapAcWlan['radio']): number {
  return radio === '2.4' ? 1 : radio === '5' ? 2 : radio === '6' ? 3 : 0;
}

/** Ordinal string order (device ids, MACs). */
function ordinal(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when every character is printable ASCII (the codec's element text). */
function printable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** The StateView of the configured WLANs (every WLAN, pushed or not; never the passphrase). */
export function capwapAcWlanView(config: ConfigAst): Record<string, unknown>[] {
  const ifaces = readCapwapAcInterfaces(config);
  return readCapwapAcWlans(config).map((w) => {
    const vlan = ifaces.get(w.iface)?.vlan;
    const v: Record<string, unknown> = { id: w.id, profile: w.profile, ssid: w.ssid, security: w.security, interface: w.iface };
    if (vlan !== undefined) v.vlan = vlan;
    v.radio = w.radio;
    v.enabled = w.enabled;
    return v;
  });
}

/** A WLAN as pushed: its wire entry, radio selector, VLAN and interface. */
interface PushedWlan {
  readonly id: number;
  readonly text: string;
  readonly radio: number;
  readonly ssid: string;
  readonly vlan: number;
  readonly iface: string;
}

/** The WLANs the controller pushes now (enabled, interface with a VLAN, printable SSID), ascending by id. */
export function capwapPushableWlans(config: ConfigAst): PushedWlan[] {
  const ifaces = readCapwapAcInterfaces(config);
  const out: PushedWlan[] = [];
  for (const w of readCapwapAcWlans(config)) {
    const vlan = ifaces.get(w.iface)?.vlan;
    if (!w.enabled || vlan === undefined || !printable(w.ssid)) continue;
    const keyTag = w.security === 'open' ? 0 : passphraseTag(w.ssid, w.passphrase ?? '');
    out.push({ id: w.id, text: formatCapwapWlan({ id: w.id, ssid: w.ssid, security: w.security, vlan, keyTag }), radio: capwapWlanRadioSelector(w.radio), ssid: w.ssid, vlan, iface: w.iface });
  }
  return out;
}

/** The controller's management interface when it is usable: VLAN, address and the port that owns the address. */
export interface CapwapAcManagement {
  readonly vlan: number;
  readonly address: Ipv4Address;
  readonly port: PortId;
}

/** The management interface now, or undefined (no section, no VLAN or address, or the device does not own it). */
export function capwapAcManagementOf(ctx: Pick<ProcessCtx, 'config' | 'ownAddress'>): CapwapAcManagement | undefined {
  const m = readCapwapAcInterfaces(ctx.config).get(CAPWAP_AC_MANAGEMENT_IFACE);
  if (m === undefined || m.vlan === undefined || m.address === undefined) return undefined;
  const port = ctx.ownAddress(m.address);
  return port === undefined ? undefined : { vlan: m.vlan, address: m.address, port };
}

/** One joined (or joining) access point. */
interface Session {
  readonly apIp: Ipv4Address;
  readonly apMac: MacAddress;
  /** The AP's device (the origin of its Join Request): the fan-out order of group frames (§4.5). */
  readonly deviceId: DeviceId;
  readonly name: string;
  /** The AP's control port (the source port of its requests). */
  readonly port: number;
  state: CapwapState;
  /** Station rows naming this AP (kept equal to the `capwap-aps` row's `clients`). */
  clients: number;
  /** The controller's own request sequence towards this AP. */
  seq: number;
  /** Pushed WLAN id → its wire signature. */
  readonly pushed: Map<number, string>;
}

/** Create the controller's CAPWAP daemon (`name: 'capwap-ac'`). One instance per device, created at boot. */
export function createCapwapAc(): Process {
  const ring: DebugEvent[] = [];
  let active = false;
  let mgmt: CapwapAcManagement | undefined;
  /** Sessions by AP address (insertion order; every list is sorted where order matters). */
  const sessions = new Map<Ipv4Address, Session>();
  /** Radio id the AP last used per BSSID (uplink frames), reused on the downlink. */
  const radioByBssid = new Map<MacAddress, number>();
  /** The WLAN list as last read (StateView; no passphrase). */
  let wlanView: Record<string, unknown>[] = [];
  let tunnelledUp = 0;
  let tunnelledDown = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAPWAP_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: CAPWAP_AC_NAME, category: CAPWAP_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: CAPWAP_AC_NAME, category: CAPWAP_DEBUG_CATEGORY, message, data };
    remember(ev);
  }

  function remember(ev: DebugEvent): void {
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function transition(ctx: ProcessCtx, s: Session, to: CapwapState, cause?: string, pdu?: PduId): void {
    const from = s.state;
    s.state = to;
    const subject = `access point ${s.apMac}`;
    const fsm: FsmTransition = {
      machine: 'capwap-ac',
      subject,
      from,
      to,
      ...(cause !== undefined ? { cause } : {}),
      ...(pdu !== undefined ? { pdu } : {}),
    };
    const message = capwapTransitionText(subject, from, to, cause);
    ctx.transition(CAPWAP_DEBUG_CATEGORY, message, fsm, { ap: s.apMac, address: s.apIp, from, to });
    remember({ at: ctx.now, device: ctx.deviceId, process: CAPWAP_AC_NAME, category: CAPWAP_DEBUG_CATEGORY, message, fsm });
  }

  function apTable(ctx: ProcessCtx): Table<CapwapApRow> | undefined {
    return ctx.tables.get<CapwapApRow>('capwap-aps');
  }

  function clientTable(ctx: ProcessCtx): Table<WlanClientRow> | undefined {
    return ctx.tables.get<WlanClientRow>('wlan-clients');
  }

  function clientsOf(ctx: ProcessCtx, apMac: MacAddress): number {
    return clientTable(ctx)?.find((r) => r.ap === apMac).length ?? 0;
  }

  function writeApRow(ctx: ProcessCtx, s: Session): void {
    s.clients = clientsOf(ctx, s.apMac);
    apTable(ctx)?.set({ key: s.apMac, apMac: s.apMac, apIp: s.apIp, name: s.name, state: s.state, clients: s.clients, updatedAt: ctx.now });
  }

  /** Refresh the AP row's client count after a station row changed. */
  function touchApRow(ctx: ProcessCtx, s: Session): void {
    const t = apTable(ctx);
    const row = t?.get(s.apMac);
    s.clients = clientsOf(ctx, s.apMac);
    if (t === undefined || row === undefined) return;
    if (row.clients !== s.clients) t.set({ ...row, clients: s.clients, updatedAt: ctx.now });
  }

  function sessionByMac(apMac: MacAddress): Session | undefined {
    for (const s of sessions.values()) if (s.apMac === apMac) return s;
    return undefined;
  }

  /** The identity a request's AP is recorded under: the Ethernet source of the frame (file header). */
  function sourceMacOf(pdu: Pdu): MacAddress {
    const eth = pdu.layers[0];
    return eth !== undefined && eth.proto === 'ethernet' && typeof eth.fields.src === 'string' ? eth.fields.src : MAC_BROADCAST;
  }

  /**
   * The joined session of ANOTHER access point that the request's identity already stands for: the same MAC, another
   * address and another device — two APs behind one router (file header). Undefined when the identity is free, or
   * when it is this AP's own older session (the same device at a new address), which the request replaces.
   */
  function identityTakenBy(pdu: Pdu, from: Ipv4Address): Session | undefined {
    const s = sessionByMac(sourceMacOf(pdu));
    return s !== undefined && s.apIp !== from && s.deviceId !== pdu.meta.origin ? s : undefined;
  }

  function openSockets(): Action[] {
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: CAPWAP_AC_NAME, socket: AC_CONTROL_SOCKET, family: 4, localPort: UDP_PORT_CAPWAP_CONTROL } },
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: CAPWAP_AC_NAME, socket: AC_DATA_SOCKET, family: 4, localPort: UDP_PORT_CAPWAP_DATA, tunnel: true } },
    ];
  }

  function closeSockets(): Action[] {
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: AC_CONTROL_SOCKET } },
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: AC_DATA_SOCKET } },
    ];
  }

  /** A control message to an access point (its control port) from the management address. */
  function reply(
    ctx: ProcessCtx,
    to: { readonly apIp: Ipv4Address; readonly port: number },
    messageType: number,
    seq: number,
    fields: Readonly<Record<string, FieldValue>>,
    o: { protect: boolean; background?: boolean; triggeredBy?: PduId },
  ): Action[] {
    if (mgmt === undefined) return [];
    return [capwapControlAction(ctx, {
      src: mgmt.address,
      dst: to.apIp,
      dstPort: to.port,
      messageType,
      seq,
      fields,
      protected: o.protect,
      ...(o.background === true ? { background: true } : {}),
      ...(o.triggeredBy !== undefined ? { triggeredBy: o.triggeredBy } : {}),
    })];
  }

  /** Forget an access point: its station rows, its row, its age timer (an AP leaving run deletes its stations' rows). */
  function dropSession(ctx: ProcessCtx, s: Session, cause: string): Action[] {
    const clients = clientTable(ctx);
    for (const row of clients?.find((r) => r.ap === s.apMac) ?? []) clients?.delete(row.key, 'cleared');
    if (apTable(ctx)?.has(s.apMac) === true) apTable(ctx)?.delete(s.apMac, 'cleared');
    transition(ctx, s, 'idle', cause);
    sessions.delete(s.apIp);
    debug(ctx, `access point ${s.name} (${s.apIp}) left: ${cause}`, { ap: s.apMac, address: s.apIp });
    return [{ type: 'cancelTimer', key: `${AGE_PREFIX}${s.apMac}` }];
  }

  /** Push every WLAN change to one AP in run (additions and changes, then removals, ascending ids). */
  function pushWlans(ctx: ProcessCtx, s: Session, triggeredBy?: PduId): Action[] {
    const out: Action[] = [];
    const current = capwapPushableWlans(ctx.config);
    const ids = new Set<number>();
    for (const w of current) {
      ids.add(w.id);
      const signature = `${w.text}|${w.radio}`;
      if (s.pushed.get(w.id) === signature) continue;
      s.pushed.set(w.id, signature);
      s.seq = (s.seq + 1) & 0xff;
      debug(ctx, `offering WLAN ${w.id} "${w.ssid}" (VLAN ${w.vlan}) to ${s.name}`, { ap: s.apMac, wlanId: w.id });
      out.push(...reply(ctx, s, CAPWAP_MSG.wlanConfigReq, s.seq, { wlans: w.text, radioId: w.radio }, { protect: true, ...(triggeredBy !== undefined ? { triggeredBy } : {}) }));
    }
    for (const id of [...s.pushed.keys()].sort((a, b) => a - b)) {
      if (ids.has(id)) continue;
      s.pushed.delete(id);
      s.seq = (s.seq + 1) & 0xff;
      debug(ctx, `withdrawing WLAN ${id} from ${s.name}`, { ap: s.apMac, wlanId: id });
      out.push(...reply(ctx, s, CAPWAP_MSG.wlanConfigReq, s.seq, { wlans: formatCapwapWlanRemoval(id), radioId: 0 }, { protect: true }));
    }
    return out;
  }

  /** After a WLAN change: rows follow their WLAN (or go with it), and every AP in run gets the change. */
  function reconcileWlans(ctx: ProcessCtx): Action[] {
    const current = new Map(capwapPushableWlans(ctx.config).map((w) => [w.id, w] as const));
    const clients = clientTable(ctx);
    const touched = new Set<MacAddress>();
    for (const row of clients?.rows() ?? []) {
      const w = current.get(row.wlanId);
      if (w === undefined) {
        clients?.delete(row.key, 'cleared');
        touched.add(row.ap);
      } else if (w.ssid !== row.ssid || w.vlan !== row.vlan || w.iface !== row.iface) {
        clients?.set({ ...row, ssid: w.ssid, vlan: w.vlan, iface: w.iface, updatedAt: ctx.now });
      }
    }
    for (const mac of touched) {
      const s = sessionByMac(mac);
      if (s !== undefined) touchApRow(ctx, s);
    }
    const out: Action[] = [];
    for (const s of [...sessions.values()].sort((a, b) => ordinal(a.deviceId, b.deviceId))) {
      if (s.state === 'run') out.push(...pushWlans(ctx, s));
    }
    return out;
  }

  /** Re-read the management interface; open or close the sockets; follow WLAN changes (§4.3). */
  function evaluate(ctx: ProcessCtx): Action[] {
    const m = capwapAcManagementOf(ctx);
    const out: Action[] = [];
    if (m !== undefined && !active) {
      active = true;
      mgmt = m;
      debug(ctx, `controller ready: management interface ${m.address} on ${m.port} (VLAN ${m.vlan})`, { address: m.address, port: m.port, vlan: m.vlan });
      out.push(...openSockets());
    } else if (m === undefined && active) {
      for (const s of [...sessions.values()]) out.push(...dropSession(ctx, s, 'the management interface lost its address'));
      active = false;
      mgmt = undefined;
      debug(ctx, 'controller stopped: the management interface has no address', {});
      out.push(...closeSockets());
      return out;
    } else if (m !== undefined) {
      mgmt = m;
    }
    wlanView = capwapAcWlanView(ctx.config);
    if (active) out.push(...reconcileWlans(ctx));
    return out;
  }

  /**
   * Answer only CAPWAP sent to the management address, or (control only) a discovery broadcast — limited or of the
   * management subnet — received on the management interface.
   */
  function accepted(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>, broadcastOk: boolean): boolean {
    if (mgmt === undefined) return false;
    if (ev.to === mgmt.address) return true;
    return broadcastOk && ev.iface === mgmt.port && (isIpv4Broadcast(ev.to) || ev.to === directedBroadcast(ctx));
  }

  // ── control channel ──

  function onControl(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    if (!accepted(ctx, ev, true)) return [];
    const pdu = ev.pdu;
    const i = capwapLayerIndex(pdu);
    const cap: LayerView | undefined = i < 0 ? undefined : pdu.layers[i];
    const type = cap?.fields.messageType;
    if (cap === undefined || typeof type !== 'number' || cap.error !== undefined) return [];
    const rseq = typeof cap.fields.seq === 'number' ? cap.fields.seq : 0;
    const at = { apIp: ev.from, port: ev.fromPort };
    if (type === CAPWAP_MSG.discoveryReq) {
      const name = typeof cap.fields.wtpName === 'string' ? cap.fields.wtpName : ev.from;
      const taken = identityTakenBy(pdu, ev.from);
      if (taken !== undefined) {
        debug(ctx, `discovery request from ${name} (${ev.from}) refused: ${taken.apMac} already identifies ${taken.name} (${taken.apIp})`, { address: ev.from, ap: taken.apMac });
        return reply(ctx, at, CAPWAP_MSG.discoveryResp, rseq, { acName: capwapText(ctx.hostname), resultCode: CAPWAP_RESULT_FAILURE }, { protect: false, triggeredBy: pdu.id });
      }
      debug(ctx, `discovery request from ${name} (${ev.from})`, { address: ev.from });
      return reply(ctx, at, CAPWAP_MSG.discoveryResp, rseq, { acName: capwapText(ctx.hostname), resultCode: CAPWAP_RESULT_SUCCESS }, { protect: false, triggeredBy: pdu.id });
    }
    if (type === CAPWAP_MSG.joinReq) return onJoin(ctx, ev, cap, rseq);
    const s = sessions.get(ev.from);
    if (s === undefined) {
      debug(ctx, `ignoring message ${type} from ${ev.from}: that access point has not joined`, { address: ev.from, type });
      return [];
    }
    switch (type) {
      case CAPWAP_MSG.configStatusReq: {
        if (s.state === 'join') {
          transition(ctx, s, 'configure', 'configuration status received', pdu.id);
          writeApRow(ctx, s);
        } else if (s.state !== 'configure') return [];
        return reply(ctx, s, CAPWAP_MSG.configStatusResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS }, { protect: true, triggeredBy: pdu.id });
      }
      case CAPWAP_MSG.changeStateReq: {
        if (s.state === 'configure') {
          transition(ctx, s, 'data-check', 'change state event received', pdu.id);
          writeApRow(ctx, s);
          const out = reply(ctx, s, CAPWAP_MSG.changeStateResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS }, { protect: true, triggeredBy: pdu.id });
          transition(ctx, s, 'run', 'access point joined');
          writeApRow(ctx, s);
          debug(ctx, `access point ${s.name} (${s.apIp}) is running`, { ap: s.apMac, address: s.apIp });
          out.push(...pushWlans(ctx, s, pdu.id));
          return out;
        }
        if (s.state !== 'run') return [];
        return reply(ctx, s, CAPWAP_MSG.changeStateResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS }, { protect: true, triggeredBy: pdu.id });
      }
      case CAPWAP_MSG.wtpEventReq: {
        if (s.state !== 'run') return [];
        const text = typeof cap.fields.stations === 'string' ? cap.fields.stations : '';
        for (const r of parseCapwapStationReports(text)) applyReport(ctx, s, r);
        return reply(ctx, s, CAPWAP_MSG.wtpEventResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS }, { protect: true, triggeredBy: pdu.id });
      }
      case CAPWAP_MSG.echoReq:
        return [
          ...reply(ctx, s, CAPWAP_MSG.echoResp, rseq, {}, { protect: true, background: true, triggeredBy: pdu.id }),
          { type: 'timer', key: `${AGE_PREFIX}${s.apMac}`, delay: CAPWAP_AP_AGE_NS, periodic: true },
        ];
      case CAPWAP_MSG.wlanConfigResp: {
        const result = cap.fields.resultCode;
        if (typeof result === 'number' && result !== CAPWAP_RESULT_SUCCESS) debug(ctx, `${s.name} refused a WLAN configuration (result ${result})`, { ap: s.apMac, result });
        return [];
      }
      default:
        debug(ctx, `ignoring control message ${type} from ${s.name}`, { type });
        return [];
    }
  }

  /** The directed broadcast of the management subnet (discovery sent to the subnet). */
  function directedBroadcast(ctx: ProcessCtx): Ipv4Address | undefined {
    if (mgmt === undefined) return undefined;
    const l3 = ctx.ports.get(mgmt.port)?.l3.ipv4;
    return l3 === undefined ? undefined : broadcastOf(l3.address, l3.prefixLen);
  }

  /** Join Request: a new session (the simulated DTLS step first), or the same answer again for a repeated request. */
  function onJoin(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>, cap: LayerView, rseq: number): Action[] {
    const pdu = ev.pdu;
    const out: Action[] = [];
    const existing = sessions.get(ev.from);
    if (existing !== undefined && existing.state === 'join') {
      return reply(ctx, existing, CAPWAP_MSG.joinResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS, acName: capwapText(ctx.hostname) }, { protect: true, triggeredBy: pdu.id });
    }
    const apMac = sourceMacOf(pdu);
    const name = typeof cap.fields.wtpName === 'string' && cap.fields.wtpName !== '' ? cap.fields.wtpName : ev.from;
    const taken = identityTakenBy(pdu, ev.from);
    if (taken !== undefined) {
      // another AP is joined under this identity: refuse the newcomer rather than evict the joined one (file header)
      debug(ctx, `join request from ${name} (${ev.from}) refused: ${apMac} already identifies ${taken.name} (${taken.apIp})`, { address: ev.from, ap: apMac });
      return reply(ctx, { apIp: ev.from, port: ev.fromPort }, CAPWAP_MSG.joinResp, rseq, { resultCode: CAPWAP_RESULT_FAILURE, acName: capwapText(ctx.hostname) }, { protect: true, triggeredBy: pdu.id });
    }
    if (existing !== undefined) out.push(...dropSession(ctx, existing, 'it joined again'));
    const sameMac = sessionByMac(apMac);
    if (sameMac !== undefined) out.push(...dropSession(ctx, sameMac, `it joined again from ${ev.from}`));
    const s: Session = { apIp: ev.from, apMac, deviceId: pdu.meta.origin, name, port: ev.fromPort, state: 'idle', clients: 0, seq: 0, pushed: new Map() };
    sessions.set(s.apIp, s);
    transition(ctx, s, 'dtls', CAPWAP_DTLS_CAUSE, pdu.id);
    writeApRow(ctx, s);
    transition(ctx, s, 'join', 'join request accepted');
    writeApRow(ctx, s);
    debug(ctx, `access point ${name} (${s.apIp}, ${apMac}) is joining`, { ap: apMac, address: s.apIp });
    out.push(...reply(ctx, s, CAPWAP_MSG.joinResp, rseq, { resultCode: CAPWAP_RESULT_SUCCESS, acName: capwapText(ctx.hostname) }, { protect: true, triggeredBy: pdu.id }));
    out.push({ type: 'timer', key: `${AGE_PREFIX}${apMac}`, delay: CAPWAP_AP_AGE_NS, periodic: true });
    return out;
  }

  /** One station report: `add` writes or updates the station's row from its WLAN, `del` deletes it (§3.12 step 5). */
  function applyReport(ctx: ProcessCtx, s: Session, r: CapwapStationReport): void {
    const clients = clientTable(ctx);
    if (clients === undefined) return;
    if (r.op === 'del') {
      const row = clients.get(r.station);
      if (row === undefined || row.ap !== s.apMac) return;
      clients.delete(r.station, 'cleared');
      debug(ctx, `station ${r.station} left ${s.name}`, { station: r.station, ap: s.apMac });
      touchApRow(ctx, s);
      return;
    }
    const w = capwapPushableWlans(ctx.config).find((x) => x.id === r.wlanId);
    if (w === undefined) {
      debug(ctx, `station ${r.station} reported on WLAN ${r.wlanId}, which this controller does not offer`, { station: r.station, wlanId: r.wlanId });
      return;
    }
    const before = clients.get(r.station);
    clients.set({ key: r.station, station: r.station, ap: s.apMac, bssid: r.bssid, wlanId: w.id, ssid: w.ssid, vlan: w.vlan, iface: w.iface, state: 'associated', updatedAt: ctx.now });
    debug(ctx, `station ${r.station} joined "${w.ssid}" on ${s.name} (VLAN ${w.vlan})`, { station: r.station, ap: s.apMac, vlan: w.vlan });
    touchApRow(ctx, s);
    if (before !== undefined && before.ap !== s.apMac) {
      const old = sessionByMac(before.ap);
      if (old !== undefined) touchApRow(ctx, old);
    }
  }

  // ── central switching ──

  /** The controller's tunnel port (`Capwap0`, role wlan-tunnel). */
  function tunnelPortOf(ctx: ProcessCtx): PortId | undefined {
    for (const view of ctx.ports.values()) if ((view.role ?? view.spec.role) === 'wlan-tunnel') return view.id;
    return undefined;
  }

  /** §3.12 step 9: a TCP SYN whose MSS option is above the tunnel's MSS is clamped (both directions). */
  function clampMss(ctx: ProcessCtx, pdu: Pdu): void {
    const tcp = pdu.layer('tcp');
    const flags = tcp?.fields.flags;
    const mss = tcp?.fields.mss;
    if (typeof flags !== 'string' || !flags.includes('S') || typeof mss !== 'number' || mss <= CAPWAP_TUNNEL_MSS) return;
    ctx.mutate(pdu, 'tcp.mss', CAPWAP_TUNNEL_MSS, 'Other', CAPWAP_MSS_CAUSE);
  }

  /** Uplink (§3.12 step 7): the tunnel datagram becomes a tagged frame of the station's VLAN on Capwap0. */
  function onData(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const pdu = ev.pdu;
    const i = capwapLayerIndex(pdu);
    const cap = i < 0 ? undefined : pdu.layers[i];
    if (cap === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: 'not a CAPWAP data message', port: ev.iface }];
    if (cap.fields.keepAlive === true) return [{ type: 'consume', pdu }];
    const s = sessions.get(ev.from);
    if (!accepted(ctx, ev, false) || s === undefined || s.state !== 'run') {
      return [{ type: 'drop', pdu, reason: 'other', detail: `no access point has joined from ${ev.from}`, port: ev.iface }];
    }
    const d = pdu.layers[i + 1];
    const llc = pdu.layers[i + 2];
    if (d === undefined || d.proto !== 'dot11' || d.fields.frameType !== 'data' || d.fields.toDs !== true || llc === undefined || llc.proto !== 'llc'
      || typeof d.fields.addr2 !== 'string' || typeof d.fields.addr3 !== 'string' || typeof llc.fields.type !== 'number') {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'the tunnel carried no 802.11 data frame for the distribution system', port: ev.iface }];
    }
    const station = d.fields.addr2;
    const row = clientTable(ctx)?.get(station);
    if (row === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: `no WLAN is known for ${station}`, port: ev.iface }];
    const tunnel = tunnelPortOf(ctx);
    if (tunnel === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: 'this controller has no tunnel port', port: ev.iface }];
    if (typeof d.fields.addr1 === 'string' && typeof cap.fields.radioId === 'number') radioByBssid.set(d.fields.addr1, cap.fields.radioId);
    const push: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst: d.fields.addr3, src: station, type: ETHERTYPE_VLAN } },
      { proto: 'dot1q', fields: { vid: row.vlan, type: llc.fields.type } },
    ];
    ctx.rewrap(pdu, { strip: i + 3, push }, CAUSE_CONTROLLER_BRIDGING);
    clampMss(ctx, pdu);
    tunnelledUp++;
    return [{ type: 'ingress', port: tunnel, pdu, layer: 'ethernet' }];
  }

  /** Downlink (§3.12 step 8): a frame eth-switch sent to Capwap0, tunnelled to the AP(s) that serve its destination. */
  function onTunnelEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const eth = pdu.layers[0];
    const tag = pdu.layers[1];
    if (eth === undefined || eth.proto !== 'ethernet' || tag === undefined || tag.proto !== 'dot1q' || typeof tag.fields.vid !== 'number' || typeof tag.fields.type !== 'number') {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'only tagged frames cross the controller tunnel', port }];
    }
    const dst = eth.fields.dst;
    const src = eth.fields.src;
    if (typeof dst !== 'string' || typeof src !== 'string') return [{ type: 'drop', pdu, reason: 'other', detail: 'no Ethernet addresses', port }];
    const vlan = tag.fields.vid;
    const type = tag.fields.type;
    const rows = clientTable(ctx)?.rows() ?? [];
    const targets: { s: Session; bssid: MacAddress }[] = [];
    if (isMulticastMac(dst)) {
      const seen = new Set<string>();
      const candidates: { s: Session; bssid: MacAddress }[] = [];
      for (const r of rows) {
        if (r.vlan !== vlan || r.station === src) continue;
        const s = sessionByMac(r.ap);
        if (s === undefined || s.state !== 'run' || seen.has(`${r.ap}|${r.bssid}`)) continue;
        seen.add(`${r.ap}|${r.bssid}`);
        candidates.push({ s, bssid: r.bssid });
      }
      candidates.sort((a, b) => ordinal(a.s.deviceId, b.s.deviceId) || ordinal(a.bssid, b.bssid));
      targets.push(...candidates);
      if (targets.length === 0) return [];
    } else {
      // the station's row IN THE FRAME'S VLAN: a frame of another VLAN (flooded to Capwap0, which carries every VLAN)
      // never reaches a station of this one
      const row = rows.find((r) => r.station === dst);
      const s = row === undefined || row.vlan !== vlan ? undefined : sessionByMac(row.ap);
      if (row === undefined || s === undefined || s.state !== 'run') return [{ type: 'drop', pdu, reason: 'other', detail: `no access point serves ${dst}`, port }];
      targets.push({ s, bssid: row.bssid });
    }
    if (mgmt === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: 'the controller has no management address', port }];
    // every clone first (copies of the frame as eth-switch sent it), then each one tunnelled (§4.5 fixed orders)
    const copies: Pdu[] = targets.map((_, k) => (k === 0 ? pdu : ctx.clone(pdu)));
    const out: Action[] = [];
    const mtu = ctx.ports.get(mgmt.port)?.mtu ?? 1500;
    targets.forEach((t, k) => {
      const copy = copies[k]!;
      clampMss(ctx, copy);
      const push: LayerSpec[] = [
        { proto: 'ipv4', fields: { src: mgmt!.address, dst: t.s.apIp, protocol: IPPROTO_UDP, ttl: ctx.model.ipDefaults.ttl } },
        { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_DATA, dstPort: UDP_PORT_CAPWAP_DATA } },
        { proto: 'capwap', fields: { tbit: true, radioId: radioByBssid.get(t.bssid) ?? 0 } },
        ...fromDsDataHeaders(dst, t.bssid, src, type),
      ];
      ctx.rewrap(copy, { strip: 2, push }, CAUSE_CONTROLLER_BRIDGING);
      if (copy.size > mtu) {
        out.push({ type: 'drop', pdu: copy, reason: 'giant', detail: CAPWAP_TOO_LARGE_DETAIL, port });
        return;
      }
      tunnelledDown++;
      out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu: copy, cause: CAUSE_CONTROLLER_BRIDGING } });
    });
    return out;
  }

  const isRelevant = (delta: ConfigDelta): boolean => {
    const head = delta.context[0]?.[0];
    if (head === 'wlc-interface' || head === 'wlan' || head === 'interface') return true;
    const key = delta.line[0];
    return delta.context.length === 0 && (key === 'wlc-interface' || key === 'wlan' || key === 'interface' || key === 'ip');
  };

  return {
    name: CAPWAP_AC_NAME,

    init(ctx: ProcessCtx): Action[] {
      return evaluate(ctx);
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'the controller takes CAPWAP through its sockets only', port }];
    },

    onEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return onTunnelEgress(ctx, pdu, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (!key.startsWith(AGE_PREFIX)) return [];
      const s = sessionByMac(key.slice(AGE_PREFIX.length));
      if (s === undefined) return [];
      return dropSession(ctx, s, 'no echo request for 90 s');
    },

    onConfig(_ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      // ipv4 writes an interface address when every daemon's onConfig actions are applied (capwap-ac is the last
      // daemon, so this event runs after that write): look again then
      return isRelevant(delta) ? [{ type: 'event', to: CAPWAP_AC_NAME, ev: { kind: 'ext.capwap-ac.config' } }] : [];
    },

    onLinkChange(ctx: ProcessCtx, port: PortId): Action[] {
      const view = ctx.ports.get(port);
      if (view === undefined || (view.role ?? view.spec.role) !== 'svi') return [];
      return evaluate(ctx);
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'sock.datagram':
          if (ev.socket === AC_CONTROL_SOCKET) return onControl(ctx, ev);
          if (ev.socket === AC_DATA_SOCKET) return onData(ctx, ev);
          return [];
        case 'sock.error':
          if (ev.socket === AC_CONTROL_SOCKET || ev.socket === AC_DATA_SOCKET) debug(ctx, `socket ${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
          return [];
        case 'ext.capwap-ac.config':
          return evaluate(ctx);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const s: Record<string, unknown> = { active };
      if (mgmt !== undefined) s.management = { vlan: mgmt.vlan, address: mgmt.address, port: mgmt.port };
      s.aps = [...sessions.values()]
        .sort((a, b) => (a.apMac < b.apMac ? -1 : a.apMac > b.apMac ? 1 : 0))
        .map((x) => ({ apMac: x.apMac, apIp: x.apIp, name: x.name, state: x.state, clients: x.clients }));
      s.wlans = wlanView.map((w) => ({ ...w }));
      s.tunnelledUp = tunnelledUp;
      s.tunnelledDown = tunnelledDown;
      return { process: CAPWAP_AC_NAME, state: s };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
