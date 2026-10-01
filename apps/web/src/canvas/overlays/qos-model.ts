/**
 * canvas/overlays/qos-model.ts — the pure model behind the QoS overlay (ARCHITECTURE-P3 §6, D16, §3.5 step 5; spec §9.6
 * "QoS": links coloured by utilisation, queues drawn as stacked bars at egress ports).
 *
 * Two things, both from snapshot data only (D24):
 *
 * - a FIFO **stack** at every egress port whose `PortSnapshot.txBacklog` is present (D16, §2.8: the frames the link
 *   model has committed with a future `txStart`, the depth and up to 8 of them, oldest first; named `txBacklog` by the
 *   W0 ruling R6). The stack shows at most `QOS_STACK_MAX` (8) capsules in `txStart` order, then `+k` for the frames
 *   the depth counts beyond them. Each capsule carries a DSCP letter (`EF`, `AF`, `CS`, `BE`) as its non-colour channel.
 *   A port without `txBacklog` draws nothing, so an uncongested world shows no stack at all;
 * - a **load sleeve** per cable direction from `PortCounters.outBytes` deltas between two samples, against the sending
 *   port's `speedBps`: thickness proportional to utilisation, a `%` label (drawn when zoomed), and an ok/warn/err ramp as
 *   the redundant channel. Utilisation is a display-only float computed here, never in the engine.
 *
 * The web never reconstructs the queue from in-flight legs (`store.ts`'s `reconcileInflight` deletes future frames on
 * every snapshot and delta, and `visible(now)` hides them): `txBacklog` is the only queue source (D16, D24).
 *
 * DSCP: a capsule's letter comes from the `txBacklog` frame entry's optional-by-meaning `dscp` (the W1 contract fix;
 * the snapshot cache writes it for a frame with an IP header), or from a reader the caller passes
 * (`QosOverlayOptions.dscpOf`), which takes precedence; with neither a capsule has no DSCP letter (`letter: ''`).
 *
 * Pure: no Pixi, no store, no wall clock. `deriveDeviceQos` depends on one device object only, so the W3 registry entry
 * memoises it per device object (registry.ts `memoPerDevice`).
 */
import type { DeviceId, DeviceSnapshot, LinkId, LinkSnapshot, PduId, PortId, PortSnapshot, PortTxQueueView, ProtoName, SimSnapshot, SimTime } from '@netforge/engine';

// ── DSCP letters ─────────────────────────────────────────────────────────────

/** Most capsules a FIFO stack draws (the snapshot carries at most 8 frame summaries, §2.8). */
export const QOS_STACK_MAX = 8;

/** Expedited forwarding (voice), RFC 3246. */
export const DSCP_EF = 46;

/** The DSCP families a capsule is lettered with. */
export type DscpFamily = 'EF' | 'AF' | 'CS' | 'BE' | 'other';

/** True for an assured-forwarding code point AFxy (RFC 2597: class x 1–4, drop precedence y 1–3). */
function isAf(dscp: number): boolean {
  const cls = dscp >> 3;
  const drop = (dscp >> 1) & 3;
  return (dscp & 1) === 0 && cls >= 1 && cls <= 4 && drop >= 1 && drop <= 3;
}

function validDscp(dscp: number | undefined): dscp is number {
  return dscp !== undefined && Number.isInteger(dscp) && dscp >= 0 && dscp <= 63;
}

/** The family of a code point: EF (46), AF (AF11…AF43), CS (CS1…CS7), BE (0), other (any other valid value). */
export function dscpFamily(dscp: number): DscpFamily {
  if (dscp === DSCP_EF) return 'EF';
  if (dscp === 0) return 'BE';
  if (isAf(dscp)) return 'AF';
  if (dscp % 8 === 0) return 'CS';
  return 'other';
}

/**
 * The capsule letter of a code point: `EF`, `AF`, `CS`, `BE`, the decimal value for any other code point, and '' when
 * the DSCP is unknown (no reader, or a frame that carries no IP header).
 */
export function dscpLetter(dscp: number | undefined): string {
  if (!validDscp(dscp)) return '';
  const family = dscpFamily(dscp);
  return family === 'other' ? String(dscp) : family;
}

/** The full name of a code point for tooltips: `EF (46)`, `AF41 (34)`, `CS6 (48)`, `BE (0)`, `DSCP 5`; '' when unknown. */
export function dscpName(dscp: number | undefined): string {
  if (!validDscp(dscp)) return '';
  switch (dscpFamily(dscp)) {
    case 'EF':
      return `EF (${dscp})`;
    case 'BE':
      return 'BE (0)';
    case 'AF':
      return `AF${dscp >> 3}${(dscp >> 1) & 3} (${dscp})`;
    case 'CS':
      return `CS${dscp >> 3} (${dscp})`;
    case 'other':
      return `DSCP ${dscp}`;
  }
}

// ── the FIFO stack ───────────────────────────────────────────────────────────

/** One frame entry of a `txBacklog`. */
export type TxBacklogFrame = PortTxQueueView['frames'][number];

/** Reads the DSCP of a waiting frame (the caller's source; see the header). */
export type DscpReader = (frame: TxBacklogFrame, where: { readonly device: DeviceId; readonly port: PortId }) => number | undefined;

/** One capsule of a stack, oldest (first to leave) first. */
export interface QosCapsule {
  readonly pdu: PduId;
  readonly proto: ProtoName;
  /** The frame's one-line summary (tooltip). */
  readonly summary: string;
  readonly bytes: number;
  readonly txStart: SimTime;
  readonly dscp?: number;
  /** DSCP letter (the non-colour channel); '' when the DSCP is unknown. */
  readonly letter: string;
  /** `AF41 (34)` and so on, for the tooltip; '' when unknown. */
  readonly dscpName: string;
}

/** The FIFO stack of one egress port. */
export interface QosStackMark {
  readonly device: DeviceId;
  readonly port: PortId;
  /** The cable the port sends on and which end the port is, when it is cabled. */
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  /** Frames waiting behind the transmitter (`txBacklog.depth`). */
  readonly depth: number;
  /** At most `QOS_STACK_MAX` capsules, in `txStart` order. */
  readonly capsules: readonly QosCapsule[];
  /** Frames the depth counts beyond the capsules (the `+k` counter). */
  readonly more: number;
  /** `+4`, or '' when every waiting frame has a capsule. */
  readonly moreLabel: string;
}

/** The capsules of a backlog: `txStart` order (stable), at most `QOS_STACK_MAX`, with the `+k` counter. */
export function stackOf(
  backlog: PortTxQueueView,
  where: { readonly device: DeviceId; readonly port: PortId },
  dscpOf?: DscpReader,
): Pick<QosStackMark, 'depth' | 'capsules' | 'more' | 'moreLabel'> {
  const ordered = backlog.frames
    .map((frame, i) => ({ frame, i }))
    .sort((x, y) => x.frame.txStart - y.frame.txStart || x.i - y.i)
    .slice(0, QOS_STACK_MAX);
  const capsules: QosCapsule[] = ordered.map(({ frame }) => {
    const raw = dscpOf !== undefined ? dscpOf(frame, where) : frame.dscp;
    const dscp = validDscp(raw) ? raw : undefined;
    return {
      pdu: frame.pdu,
      proto: frame.summary.proto,
      summary: frame.summary.summary,
      bytes: frame.bytes,
      txStart: frame.txStart,
      ...(dscp === undefined ? {} : { dscp }),
      letter: dscpLetter(dscp),
      dscpName: dscpName(dscp),
    };
  });
  const depth = Math.max(backlog.depth, capsules.length);
  const more = depth - capsules.length;
  return { depth, capsules, more, moreLabel: more > 0 ? `+${more}` : '' };
}

// ── load sleeves ─────────────────────────────────────────────────────────────

/** Sleeve width at 100 % utilisation, in world units (the layer scales it with the camera like a cable). */
export const LOAD_SLEEVE_MAX_WIDTH = 10;
/** Below this utilisation the ramp says ok. */
export const LOAD_WARN_AT = 0.5;
/** From this utilisation the ramp says err (the link is close to saturated). */
export const LOAD_ERR_AT = 0.85;
/** The default sampling window of the load sleeves: one second of simulated time. */
export const LOAD_WINDOW_NS = 1_000_000_000;

/** The redundant (non-colour) ramp of a sleeve. */
export type LoadLevel = 'ok' | 'warn' | 'err';

/** `outBytes` of every port at one instant. */
export interface LoadSample {
  readonly at: SimTime;
  /** Keyed by `portKey(device, port)`. */
  readonly outBytes: ReadonlyMap<string, number>;
}

/** Key of one port in a `LoadSample`. */
export function portKey(device: DeviceId, port: PortId): string {
  return `${device}|${port}`;
}

/**
 * Utilisation of a sender over a window: bits sent / (rate × seconds), clamped to [0, 1]. Undefined when the window is
 * empty, the rate is unknown, or the counter went backwards (a device reloaded between the samples).
 */
export function utilisation(bytesDelta: number, windowNs: number, speedBps: number | undefined): number | undefined {
  if (!(windowNs > 0) || speedBps === undefined || !(speedBps > 0) || !(bytesDelta >= 0)) return undefined;
  const f = (bytesDelta * 8 * 1_000_000_000) / (speedBps * windowNs);
  return f >= 1 ? 1 : f;
}

/** The ramp of a utilisation. */
export function loadLevel(fraction: number): LoadLevel {
  if (fraction < LOAD_WARN_AT) return 'ok';
  return fraction < LOAD_ERR_AT ? 'warn' : 'err';
}

/** `100 %`, `37 %`: the label a zoomed-in sleeve shows. */
export function loadPercentLabel(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** One direction of a cable's load. */
export interface QosSleeveMark {
  readonly link: LinkId;
  /** The sending end: the sleeve runs from this end towards the other. */
  readonly from: 'a' | 'b';
  readonly device: DeviceId;
  readonly port: PortId;
  /** Utilisation 0..1. */
  readonly fraction: number;
  /** `fraction × LOAD_SLEEVE_MAX_WIDTH`. */
  readonly width: number;
  readonly label: string;
  readonly level: LoadLevel;
}

// ── per device ───────────────────────────────────────────────────────────────

/** What the QoS overlay reads from one device. */
export interface DeviceQos {
  /** Ports with a backlog, in port order. */
  readonly backlogs: readonly { readonly port: PortId; readonly backlog: PortTxQueueView }[];
  /** Every port's `outBytes` and speed. */
  readonly ports: ReadonlyMap<PortId, { readonly outBytes: number; readonly speedBps?: number }>;
}

/** Derive a device's QoS data. Pure in the device object. */
export function deriveDeviceQos(d: DeviceSnapshot): DeviceQos {
  const backlogs: { port: PortId; backlog: PortTxQueueView }[] = [];
  const ports = new Map<PortId, { outBytes: number; speedBps?: number }>();
  for (const p of d.ports as readonly PortSnapshot[]) {
    if (p.txBacklog !== undefined && p.txBacklog.depth > 0) backlogs.push({ port: p.id, backlog: p.txBacklog });
    ports.set(p.id, p.speedBps === undefined ? { outBytes: p.counters.outBytes } : { outBytes: p.counters.outBytes, speedBps: p.speedBps });
  }
  return { backlogs, ports };
}

/** The `outBytes` sample of a snapshot. */
export function loadSampleOf(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceQos = deriveDeviceQos): LoadSample {
  const outBytes = new Map<string, number>();
  for (const d of snapshot.devices) for (const [port, v] of perDevice(d).ports) outBytes.set(portKey(d.id, port), v.outBytes);
  return { at: snapshot.now, outBytes };
}

/**
 * Keep a short history of samples so the sleeves always compare against a sample about `windowNs` old: `sample` is
 * appended (replacing a sample of the same instant), and the front is trimmed while the NEXT sample is still at least
 * `windowNs` old, so `history[0]` is the newest sample that is at least a window old (or the oldest one while the
 * history is younger than a window). A sample older than the newest one (a seek back in time) restarts the history.
 */
export function pushLoadSample(history: readonly LoadSample[], sample: LoadSample, windowNs: number = LOAD_WINDOW_NS): LoadSample[] {
  const last = history[history.length - 1];
  if (last !== undefined && sample.at < last.at) return [sample];
  const out = last !== undefined && last.at === sample.at ? [...history.slice(0, -1), sample] : [...history, sample];
  while (out.length > 1 && (out[1] as LoadSample).at <= sample.at - windowNs) out.shift();
  return out;
}

/** The sample the sleeves compare against: the oldest of the history, unless it is the current instant. */
export function loadBaseOf(history: readonly LoadSample[], now: SimTime): LoadSample | null {
  const first = history[0];
  return first !== undefined && first.at < now ? first : null;
}

// ── the overlay model ────────────────────────────────────────────────────────

/** Options of `buildQosOverlay`. */
export interface QosOverlayOptions {
  /** The earlier sample the load sleeves compare with; null or absent = no sleeves yet. */
  readonly base?: LoadSample | null;
  /** The DSCP of a waiting frame (see the header); absent = the frame entry's own `dscp`. */
  readonly dscpOf?: DscpReader;
}

/** The QoS overlay's full render model. */
export interface QosOverlayModel {
  /** One stack per port with a backlog, devices in snapshot order, ports in port order. */
  readonly stacks: readonly QosStackMark[];
  /** One sleeve per cable direction whose utilisation is known, links in snapshot order, a then b. */
  readonly sleeves: readonly QosSleeveMark[];
}

function linkEnds(links: readonly LinkSnapshot[]): Map<string, { link: LinkId; end: 'a' | 'b' }> {
  const out = new Map<string, { link: LinkId; end: 'a' | 'b' }>();
  for (const l of links) {
    out.set(portKey(l.a.device, l.a.port), { link: l.id, end: 'a' });
    out.set(portKey(l.b.device, l.b.port), { link: l.id, end: 'b' });
  }
  return out;
}

/** Build the QoS overlay from a snapshot (and, for the sleeves, an earlier sample). */
export function buildQosOverlay(
  snapshot: SimSnapshot,
  opts: QosOverlayOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceQos = deriveDeviceQos,
): QosOverlayModel {
  const ends = linkEnds(snapshot.links);
  const stacks: QosStackMark[] = [];
  const byId = new Map<DeviceId, DeviceQos>();
  for (const d of snapshot.devices) {
    const qos = perDevice(d);
    byId.set(d.id, qos);
    for (const { port, backlog } of qos.backlogs) {
      const where = { device: d.id, port };
      const at = ends.get(portKey(d.id, port));
      stacks.push({ device: d.id, port, ...(at === undefined ? {} : { link: at.link, end: at.end }), ...stackOf(backlog, where, opts.dscpOf) });
    }
  }

  const sleeves: QosSleeveMark[] = [];
  const base = opts.base ?? null;
  if (base !== null && base.at < snapshot.now) {
    const windowNs = snapshot.now - base.at;
    for (const l of snapshot.links) {
      if (!l.up) continue;
      for (const from of ['a', 'b'] as const) {
        const ref = l[from];
        const port = byId.get(ref.device)?.ports.get(ref.port);
        const before = base.outBytes.get(portKey(ref.device, ref.port));
        if (port === undefined || before === undefined) continue;
        const fraction = utilisation(port.outBytes - before, windowNs, port.speedBps ?? l.negotiatedBps);
        if (fraction === undefined) continue;
        sleeves.push({
          link: l.id,
          from,
          device: ref.device,
          port: ref.port,
          fraction,
          width: fraction * LOAD_SLEEVE_MAX_WIDTH,
          label: loadPercentLabel(fraction),
          level: loadLevel(fraction),
        });
      }
    }
  }
  return { stacks, sleeves };
}
