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
 *
 * @since P3 [S20] (W3 web-canvas) **Per-class queue lanes** at a scheduler port (`PortSnapshot.qos.queue`, the
 * `EgressQueueView` of a port whose output policy queues): one lane per class, the priority (LLQ) lanes nearest the
 * cable with a `P` badge, then the other classes in policy order; each lane fills to `depth / limit` and reads
 * `VOICE 1/64`. A lane whose class dropped frames since the base sample carries a **drop tag**: `queue full ·
 * class-default` for tail drops, `policed` for frames its policer dropped ([S21], and the LLQ's conditional policer of
 * [S20]). The drop counters ride in the same `LoadSample` as the sleeves' `outBytes` (`classDrops`), so a tag says
 * "dropped within the last window" and disappears once the class stops dropping. `buildQosOverlay`'s output is
 * unchanged; `buildQosLayerModel` adds the lanes (`queues`) for the layer and the outline.
 */
import type {
  DeviceId,
  DeviceSnapshot,
  EgressQueueView,
  LinkId,
  LinkSnapshot,
  PduId,
  PortId,
  PortSnapshot,
  PortTxQueueView,
  ProtoName,
  SimSnapshot,
  SimTime,
} from '@netforge/engine';

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
  /**
   * @since P3 [S20] The drop counters of every class of every scheduler port at the same instant, keyed by
   * `classKey(device, port, class)` (the lanes' drop tags compare against them). Absent in a sample taken before any
   * port queued.
   */
  readonly classDrops?: ReadonlyMap<string, ClassDropCounts>;
}

/** @since P3 [S20] The two drop counters of one class queue. */
export interface ClassDropCounts {
  readonly tailDrops: number;
  readonly policed: number;
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
  /** @since P3 [S20] Scheduler ports (`PortSnapshot.qos.queue` present), in port order. */
  readonly queues?: readonly { readonly port: PortId; readonly queue: EgressQueueView }[];
}

/** Derive a device's QoS data. Pure in the device object. */
export function deriveDeviceQos(d: DeviceSnapshot): DeviceQos {
  const backlogs: { port: PortId; backlog: PortTxQueueView }[] = [];
  const ports = new Map<PortId, { outBytes: number; speedBps?: number }>();
  const queues: { port: PortId; queue: EgressQueueView }[] = [];
  for (const p of d.ports as readonly PortSnapshot[]) {
    if (p.txBacklog !== undefined && p.txBacklog.depth > 0) backlogs.push({ port: p.id, backlog: p.txBacklog });
    ports.set(p.id, p.speedBps === undefined ? { outBytes: p.counters.outBytes } : { outBytes: p.counters.outBytes, speedBps: p.speedBps });
    const queue = p.qos?.queue;
    if (queue !== undefined && queue.classes.length > 0) queues.push({ port: p.id, queue });
  }
  return { backlogs, ports, queues };
}

/** The `outBytes` sample of a snapshot (and, @since P3 [S20], the drop counters of every class queue). */
export function loadSampleOf(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceQos = deriveDeviceQos): LoadSample {
  const outBytes = new Map<string, number>();
  let classDrops: Map<string, ClassDropCounts> | undefined;
  for (const d of snapshot.devices) {
    const qos = perDevice(d);
    for (const [port, v] of qos.ports) outBytes.set(portKey(d.id, port), v.outBytes);
    for (const { port, queue } of qos.queues ?? []) {
      classDrops ??= new Map();
      for (const c of queue.classes) classDrops.set(classKey(d.id, port, c.name), { tailDrops: c.tailDrops, policed: c.policed });
    }
  }
  return classDrops === undefined ? { at: snapshot.now, outBytes } : { at: snapshot.now, outBytes, classDrops };
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

// ── [S20] per-class queue lanes ──────────────────────────────────────────────

/** Badge of a priority (LLQ) lane. */
export const QOS_PRIORITY_BADGE = 'P';

/** One class row of an `EgressQueueView`. */
export type EgressClassView = EgressQueueView['classes'][number];

/** Key of one class queue in `LoadSample.classDrops`. */
export function classKey(device: DeviceId, port: PortId, cls: string): string {
  return `${device}|${port}|${cls}`;
}

/** Why a lane dropped frames since the base sample. */
export type QosDropKind = 'queue-full' | 'policed';

/** A drop tag on a lane: its text (the non-colour channel) and how many frames it stands for. */
export interface QosDropTag {
  readonly kind: QosDropKind;
  /** `queue full · class-default` or `policed`. */
  readonly text: string;
  /** Frames dropped this way since the base sample (every drop the counter holds when there is no base). */
  readonly count: number;
}

/** The text of a drop tag. */
export function dropTagText(kind: QosDropKind, cls: string): string {
  return kind === 'queue-full' ? `queue full · ${cls}` : 'policed';
}

/** One class queue of a scheduler port, as a lane. */
export interface QosLaneMark {
  readonly name: string;
  readonly kind: EgressClassView['kind'];
  /** True for an LLQ class: its lane is nearest the cable and carries the `P` badge. */
  readonly priority: boolean;
  /** `P` or ''. */
  readonly badge: string;
  readonly depth: number;
  readonly limit: number;
  /** `depth / limit`, clamped to [0, 1] (0 when the limit is unknown). */
  readonly fill: number;
  /** `VOICE 1/64`. */
  readonly label: string;
  /** Totals since the policy was attached. */
  readonly tailDrops: number;
  readonly policed: number;
  /** Fair-queue flows in the class ([S21] `fair-queue`), when the view carries them. */
  readonly flows?: number;
  /** Drop tags, tail drops first. */
  readonly tags: readonly QosDropTag[];
}

/** The lanes of one scheduler port. */
export interface QosQueueMark {
  readonly device: DeviceId;
  readonly port: PortId;
  /** The cable the port sends on and which end the port is, when it is cabled. */
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  readonly policy?: string;
  readonly strategy: EgressQueueView['strategy'];
  /** Nearest the cable first: the priority lanes, then the other classes in policy order. */
  readonly lanes: readonly QosLaneMark[];
}

/** Drops since the base: the difference, or the whole count when there is no base or the counter went back (a reload). */
function recent(now: number, before: number | undefined): number {
  if (before === undefined || now < before) return now;
  return now - before;
}

/**
 * The lanes of a scheduler port, nearest the cable first. `base` holds the drop counters of an earlier sample (null:
 * no earlier sample, so every counted drop tags its lane).
 */
export function lanesOf(
  view: EgressQueueView,
  where: { readonly device: DeviceId; readonly port: PortId },
  base: ReadonlyMap<string, ClassDropCounts> | null = null,
): QosLaneMark[] {
  const ordered = view.classes.map((c, i) => ({ c, i })).sort((x, y) => Number(y.c.kind === 'priority') - Number(x.c.kind === 'priority') || x.i - y.i);
  return ordered.map(({ c }) => {
    const before = base?.get(classKey(where.device, where.port, c.name));
    const tags: QosDropTag[] = [];
    const tail = recent(c.tailDrops, before?.tailDrops);
    if (tail > 0) tags.push({ kind: 'queue-full', text: dropTagText('queue-full', c.name), count: tail });
    const policed = recent(c.policed, before?.policed);
    if (policed > 0) tags.push({ kind: 'policed', text: dropTagText('policed', c.name), count: policed });
    const priority = c.kind === 'priority';
    const fill = c.limit > 0 ? Math.min(1, Math.max(0, c.depth / c.limit)) : 0;
    return {
      name: c.name,
      kind: c.kind,
      priority,
      badge: priority ? QOS_PRIORITY_BADGE : '',
      depth: c.depth,
      limit: c.limit,
      fill,
      label: `${c.name} ${c.depth}/${c.limit}`,
      tailDrops: c.tailDrops,
      policed: c.policed,
      ...(c.flows === undefined ? {} : { flows: c.flows }),
      tags,
    };
  });
}

/** Options of `buildQosQueues` / `buildQosLayerModel`. */
export type QosLayerOptions = QosOverlayOptions;

/** The lanes of every scheduler port: devices in snapshot order, ports in port order. */
export function buildQosQueues(
  snapshot: SimSnapshot,
  opts: QosLayerOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceQos = deriveDeviceQos,
): QosQueueMark[] {
  const base = opts.base ?? null;
  const drops = base !== null && base.at < snapshot.now ? (base.classDrops ?? new Map<string, ClassDropCounts>()) : null;
  let ends: Map<string, { link: LinkId; end: 'a' | 'b' }> | undefined;
  const out: QosQueueMark[] = [];
  for (const d of snapshot.devices) {
    for (const { port, queue } of perDevice(d).queues ?? []) {
      ends ??= linkEnds(snapshot.links);
      const at = ends.get(portKey(d.id, port));
      out.push({
        device: d.id,
        port,
        ...(at === undefined ? {} : { link: at.link, end: at.end }),
        ...(queue.policy === undefined ? {} : { policy: queue.policy }),
        strategy: queue.strategy,
        lanes: lanesOf(queue, { device: d.id, port }, drops),
      });
    }
  }
  return out;
}

/** What the QoS layer and the keyboard outline draw: the stacks and sleeves, and @since P3 [S20] the class lanes. */
export interface QosLayerModel extends QosOverlayModel {
  readonly queues: readonly QosQueueMark[];
}

/** The QoS layer's model: `buildQosOverlay` plus the class lanes. */
export function buildQosLayerModel(
  snapshot: SimSnapshot,
  opts: QosLayerOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceQos = deriveDeviceQos,
): QosLayerModel {
  return { ...buildQosOverlay(snapshot, opts, perDevice), queues: buildQosQueues(snapshot, opts, perDevice) };
}
