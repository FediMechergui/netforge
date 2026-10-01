/**
 * canvas/overlays/wan-model.ts — [S18]/[S19] (and [C13]) the pure model behind the WAN overlay (ARCHITECTURE-P3 §6,
 * §3.9, §3.10, §3.13; spec §9.1 "Pulse: payload is encrypted", §9.5 "PPP LCP/NCP").
 *
 * From the `ppp`, `tunnels` and `ipsec-sa` rows only (§2.6, §2.17; D24):
 *
 * - a **PPP phase rail** `D·E·A·N` (Dead, Establish, Authenticate, Network; RFC 1661 §3.2) at each serial cable end
 *   with a `ppp` row: the steps before the current phase are done, the current one is lit; once IPCP is open the last
 *   step reads `N ✓ 10.1.1.2` (the peer's address); a failed authentication crosses the `A`; with no authentication
 *   configured at either end the `A` is skipped. A Terminate phase lights `D` (the link is going down);
 * - a **tunnel tube** between the two routers of a `tunnels` row (drawn as a hollow tube on `airArc` by the W3 layer):
 *   labelled `Tu0 GRE 172.16.0.0/30` (the tunnel interface, the mode and the tunnel's own subnet); [C13] an ipsec-mode
 *   tunnel reads `Tu0 IPsec` with a lock glyph and the security association's state word from its `ipsec-sa` row. Two
 *   routers whose tunnels point at each other share ONE tube; a destination that belongs to no device leaves the far
 *   end open;
 * - the **legs** that cross a tunnel (`PduSummary.tunnel`): a `G` badge on a GRE leg; an IPsec leg carries the lock and
 *   pulses (spec §9.1: pulse = the payload is encrypted), static under reduced motion (`tunnelLegStyle`,
 *   `encryptedPulseAlpha`).
 *
 * Every encoding keeps a non-colour channel (letters, ✓ and ✗, the padlock, words); nothing is a dash pattern.
 * Pure: no Pixi, no store. `deriveDeviceWan` depends on one device object only, so the W3 registry entry memoises it.
 */
import { cidr } from '@netforge/engine';
import type {
  DeviceId,
  DeviceSnapshot,
  Ipv4Address,
  IpsecSaRow,
  LinkId,
  PduSummary,
  PortId,
  PppPhase,
  PppRow,
  SimSnapshot,
  TunnelDownReason,
  TunnelRow,
} from '@netforge/engine';

// ── the PPP rail ─────────────────────────────────────────────────────────────

/** The four steps of the rail, in order (Terminate is not a step: it lights `D`). */
export const PPP_RAIL_STEPS: readonly { readonly phase: Exclude<PppPhase, 'terminate'>; readonly letter: string }[] = Object.freeze([
  Object.freeze({ phase: 'dead', letter: 'D' }),
  Object.freeze({ phase: 'establish', letter: 'E' }),
  Object.freeze({ phase: 'authenticate', letter: 'A' }),
  Object.freeze({ phase: 'network', letter: 'N' }),
] as const);

/** Separator between the rail letters (`D·E·A·N`). */
export const PPP_RAIL_SEPARATOR = '·';
/** Mark of a finished step (the open network phase). */
export const PPP_DONE_GLYPH = '✓';
/** Mark of a failed authentication (the crossed `A`). */
export const PPP_FAILED_GLYPH = '✗';

/** How one rail step is drawn. */
export type PppStepState = 'done' | 'current' | 'todo' | 'failed' | 'skipped';

/** One step of a rail. */
export interface PppRailStep {
  readonly letter: string;
  readonly state: PppStepState;
}

/** The rail of one serial end. */
export interface PppRailMark {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  readonly phase: PppPhase;
  readonly steps: readonly PppRailStep[];
  /** `N ✓ 10.1.1.2` once IPCP is open; '' otherwise. */
  readonly label: string;
  /** Authentication failed at this end (either direction). */
  readonly authFailed: boolean;
  /** IPCP is open: the link carries IPv4. */
  readonly open: boolean;
  /** The rail as one sentence (keyboard outline, tooltip). */
  readonly words: string;
  readonly lastFailure?: string;
}

const PHASE_INDEX: Readonly<Record<PppPhase, number>> = Object.freeze({ dead: 0, establish: 1, authenticate: 2, network: 3, terminate: 0 });

const PHASE_WORDS: Readonly<Record<PppPhase, string>> = Object.freeze({
  dead: 'link dead',
  establish: 'establishing the link',
  authenticate: 'authenticating',
  network: 'setting up the network protocols',
  terminate: 'closing the link',
});

/** The rail of one `ppp` row (see the header). */
export function pppRail(row: Pick<PppRow, 'phase' | 'authLocal' | 'authPeer' | 'authLocalState' | 'authPeerState' | 'ipcp' | 'peerAddress'>): Pick<
  PppRailMark,
  'steps' | 'label' | 'authFailed' | 'open' | 'words'
> {
  const idx = PHASE_INDEX[row.phase] ?? 0;
  const noAuth = row.authLocal === 'none' && row.authPeer === 'none';
  const authFailed = row.authLocalState === 'failed' || row.authPeerState === 'failed';
  const open = row.phase === 'network' && row.ipcp === 'opened';
  const steps: PppRailStep[] = PPP_RAIL_STEPS.map((s, i) => {
    let state: PppStepState = i < idx ? 'done' : i === idx ? 'current' : 'todo';
    if (s.phase === 'authenticate') {
      if (authFailed) state = 'failed';
      else if (noAuth) state = 'skipped';
    }
    if (s.phase === 'network' && open) state = 'done';
    return { letter: s.letter, state };
  });
  const label = open ? (row.peerAddress === undefined ? `N ${PPP_DONE_GLYPH}` : `N ${PPP_DONE_GLYPH} ${row.peerAddress}`) : '';
  let words: string;
  if (open) words = row.peerAddress === undefined ? 'PPP open' : `PPP open, peer ${row.peerAddress}`;
  else if (authFailed) words = `PPP authentication failed, ${PHASE_WORDS[row.phase]}`;
  else words = `PPP ${PHASE_WORDS[row.phase] ?? row.phase}`;
  return { steps, label, authFailed, open, words };
}

// ── tunnels ──────────────────────────────────────────────────────────────────

/** The badge of a GRE leg. (An IPsec tube or leg carries `lock: true`: the W3 layer draws the padlock shape the
 *  controller overlay already draws, canvas/capwap.ts `drawPadlock`, so no glyph depends on an emoji font.) */
export const GRE_LEG_BADGE = 'G';

/** Words of the tunnel down reasons (`TunnelRow.reason`). */
export const TUNNEL_REASON_TEXT: Readonly<Record<TunnelDownReason, string>> = Object.freeze({
  'no-source': 'no usable tunnel source',
  'no-destination': 'no tunnel destination',
  'no-route': 'no route to the tunnel destination',
  'recursive-routing': 'the destination is reached through the tunnel itself',
  'ike-negotiating': 'negotiating keys',
  'ike-failed': 'key negotiation failed',
  'ike-no-proposal': 'the peers share no proposal',
  'ike-no-response': 'the peer does not answer',
});

/** Words of a tunnel down reason (the raw value when unknown, '' when absent). */
export function tunnelReasonText(reason: string | undefined): string {
  if (reason === undefined) return '';
  return Object.prototype.hasOwnProperty.call(TUNNEL_REASON_TEXT, reason) ? TUNNEL_REASON_TEXT[reason as TunnelDownReason] : reason;
}

/** One end of a tube: one router's tunnel interface. */
export interface TunnelEnd {
  readonly device: DeviceId;
  readonly port: PortId;
  /** `Tu0`. */
  readonly short: string;
  readonly mode: TunnelRow['mode'];
  readonly state: TunnelRow['state'];
  readonly reason?: TunnelDownReason;
  readonly source?: Ipv4Address;
  readonly destination?: Ipv4Address;
  readonly ipMtu: number;
  /** The tunnel interface's own subnet, `172.16.0.0/30`, when it is addressed. */
  readonly subnet?: string;
  /** [C13] The IKE/IPsec security association of an ipsec-mode tunnel. */
  readonly sa?: IpsecSaRow['state'];
  readonly saReason?: IpsecSaRow['reason'];
}

/** One tube between two routers (or from one router toward an address no device holds). */
export interface TunnelTubeMark {
  /** Stable identity: the sorted `device|port` pairs of its ends. */
  readonly key: string;
  readonly a: TunnelEnd;
  /** The far end's own tunnel, when its row points back at `a`. */
  readonly b?: TunnelEnd;
  /** The device that holds the destination address (null: none in the world). */
  readonly toward: DeviceId | null;
  readonly mode: TunnelRow['mode'];
  /** Every end's tunnel is up. */
  readonly up: boolean;
  /** `Tu0 GRE 172.16.0.0/30` or `Tu0 IPsec`. */
  readonly label: string;
  /** [C13] An ipsec-mode tunnel: draw the padlock. */
  readonly lock: boolean;
  /** [C13] The SA state word (`negotiating`, `established`, `failed`); '' for GRE. */
  readonly saWord: string;
  /** Why it is down, in words ('' when up). */
  readonly downText: string;
}

/** The tube label of one end (see the header). */
export function tunnelLabel(end: Pick<TunnelEnd, 'short' | 'mode' | 'subnet'>): string {
  if (end.mode === 'ipsec') return `${end.short} IPsec`;
  return end.subnet === undefined ? `${end.short} GRE` : `${end.short} GRE ${end.subnet}`;
}

// ── per device ───────────────────────────────────────────────────────────────

/** What the WAN overlay reads from one device. */
export interface DeviceWan {
  /** `ppp` rows, in row order. */
  readonly ppp: readonly PppRow[];
  /** Tunnel ends of this device, in row order. */
  readonly tunnels: readonly TunnelEnd[];
  /** Every IPv4 address of the device's ports (to resolve a tunnel destination). */
  readonly addresses: readonly Ipv4Address[];
}

const EMPTY_WAN: DeviceWan = Object.freeze({ ppp: [], tunnels: [], addresses: [] });

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows ?? [];
}

/** Derive a device's WAN rows. Pure in the device object. */
export function deriveDeviceWan(d: DeviceSnapshot): DeviceWan {
  const pppRows = rowsOf(d, 'ppp').filter((r) => typeof r.port === 'string' && typeof r.phase === 'string') as unknown as PppRow[];
  const tunnelRows = rowsOf(d, 'tunnels').filter((r) => typeof r.port === 'string' && typeof r.state === 'string') as unknown as TunnelRow[];
  const addresses: Ipv4Address[] = [];
  for (const p of d.ports) if (p.l3.ipv4 !== undefined) addresses.push(p.l3.ipv4.address);
  if (pppRows.length === 0 && tunnelRows.length === 0) return addresses.length === 0 ? EMPTY_WAN : { ppp: [], tunnels: [], addresses };
  const sa = new Map<PortId, IpsecSaRow>();
  for (const r of rowsOf(d, 'ipsec-sa')) if (typeof r.port === 'string' && typeof r.state === 'string') sa.set(r.port, r as unknown as IpsecSaRow);
  const tunnels: TunnelEnd[] = tunnelRows.map((row) => {
    const p = d.ports.find((x) => x.id === row.port);
    const v4 = p?.l3.ipv4;
    const saRow = row.mode === 'ipsec' ? sa.get(row.port) : undefined;
    return {
      device: d.id,
      port: row.port,
      short: p?.short ?? row.port,
      mode: row.mode,
      state: row.state,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.destination === undefined ? {} : { destination: row.destination }),
      ipMtu: row.ipMtu,
      ...(v4 === undefined ? {} : { subnet: cidr(v4.address, v4.prefixLen) }),
      ...(saRow === undefined ? {} : { sa: saRow.state }),
      ...(saRow?.reason === undefined ? {} : { saReason: saRow.reason }),
    };
  });
  return { ppp: pppRows, tunnels, addresses };
}

// ── legs ─────────────────────────────────────────────────────────────────────

/** How a leg that crosses a tunnel is drawn. */
export interface TunnelLegStyle {
  /** `G` on a GRE leg, '' otherwise. */
  readonly badge: string;
  /** An IPsec leg: the padlock. */
  readonly lock: boolean;
  /** An IPsec leg pulses (the payload is encrypted), unless reduced motion is on. */
  readonly pulse: boolean;
}

const PLAIN_LEG: TunnelLegStyle = Object.freeze({ badge: '', lock: false, pulse: false });

/** The style of a leg from its summary's `tunnel` member (a CAPWAP leg is the controller overlay's, not this one). */
export function tunnelLegStyle(summary: Pick<PduSummary, 'tunnel'>, reducedMotion: boolean): TunnelLegStyle {
  if (summary.tunnel === 'gre') return { badge: GRE_LEG_BADGE, lock: false, pulse: false };
  if (summary.tunnel === 'ipsec') return { badge: '', lock: true, pulse: !reducedMotion };
  return PLAIN_LEG;
}

/** Period of the encrypted-leg pulse, wall-clock milliseconds. */
export const ENCRYPTED_PULSE_MS = 1_200;

/**
 * Alpha of an encrypted leg at wall time `wallMs`: a slow breath between 0.55 and 1; always 1 under reduced motion
 * (static, spec §8.5).
 */
export function encryptedPulseAlpha(wallMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  const phase = (((wallMs % ENCRYPTED_PULSE_MS) + ENCRYPTED_PULSE_MS) % ENCRYPTED_PULSE_MS) / ENCRYPTED_PULSE_MS;
  return 0.775 + 0.225 * Math.cos(phase * 2 * Math.PI);
}

// ── the overlay model ────────────────────────────────────────────────────────

/** The WAN overlay's full render model. */
export interface WanOverlayModel {
  /** One rail per `ppp` row, devices in snapshot order. */
  readonly rails: readonly PppRailMark[];
  /** One tube per tunnel pair (or lone tunnel), in the order their first end appears. */
  readonly tubes: readonly TunnelTubeMark[];
}

function endKey(e: Pick<TunnelEnd, 'device' | 'port'>): string {
  return `${e.device}|${e.port}`;
}

/** Build the WAN overlay from a snapshot. */
export function buildWanOverlay(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceWan = deriveDeviceWan): WanOverlayModel {
  const endOf = new Map<string, { link: LinkId; end: 'a' | 'b' }>();
  for (const l of snapshot.links) {
    endOf.set(`${l.a.device}|${l.a.port}`, { link: l.id, end: 'a' });
    endOf.set(`${l.b.device}|${l.b.port}`, { link: l.id, end: 'b' });
  }

  const rails: PppRailMark[] = [];
  const owner = new Map<Ipv4Address, DeviceId>();
  const all: TunnelEnd[] = [];
  for (const d of snapshot.devices) {
    const wan = perDevice(d);
    for (const a of wan.addresses) if (!owner.has(a)) owner.set(a, d.id);
    for (const row of wan.ppp) {
      const at = endOf.get(`${d.id}|${row.port}`);
      rails.push({
        device: d.id,
        port: row.port,
        ...(at === undefined ? {} : { link: at.link, end: at.end }),
        phase: row.phase,
        ...pppRail(row),
        ...(row.lastFailure === undefined ? {} : { lastFailure: row.lastFailure }),
      });
    }
    all.push(...wan.tunnels);
  }

  const tubes: TunnelTubeMark[] = [];
  const used = new Set<string>();
  for (const a of all) {
    if (used.has(endKey(a))) continue;
    used.add(endKey(a));
    const towardId = a.destination === undefined ? undefined : owner.get(a.destination);
    const toward = towardId === undefined || towardId === a.device ? null : towardId;
    // The far end's tunnel whose destination is one of a's device's addresses (it points back at a).
    const b =
      toward === null
        ? undefined
        : all.find(
            (x) => x.device === toward && !used.has(endKey(x)) && x.destination !== undefined && owner.get(x.destination) === a.device && x.mode === a.mode,
          );
    if (b !== undefined) used.add(endKey(b));
    const ends = b === undefined ? [a] : [a, b];
    const up = ends.every((e) => e.state === 'up');
    const firstDown = ends.find((e) => e.state !== 'up');
    tubes.push({
      key: ends.map(endKey).sort().join('~'),
      a,
      ...(b === undefined ? {} : { b }),
      toward,
      mode: a.mode,
      up,
      label: tunnelLabel(a),
      lock: a.mode === 'ipsec',
      saWord: a.mode === 'ipsec' ? (a.sa ?? b?.sa ?? '') : '',
      downText: firstDown === undefined ? '' : tunnelReasonText(firstDown.reason),
    });
  }
  return { rails, tubes };
}
