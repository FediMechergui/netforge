/**
 * link/cabling.ts — cable validation with explanations, v2 (spec §4.6, §5.3, §8.3; ARCHITECTURE-P1 §3.4 step 4).
 *
 * Invalid combinations are rejected WITH an original explanation, never a bare red X. Checks, in order:
 *   1. `unknown-media`   the media must be a known `MediaType`;
 *   2. `bad-length`      a finite, non-negative number of metres;
 *   3. `same-device`     both ends on one device;
 *   4. `not-a-cable-port` an end that cannot terminate a link (Wi-Fi/cellular radios, virtual interfaces,
 *                        any role whose `linkable` trait is false);
 *   5. `radio-needs-radio-port` a point-to-point radio link (media 'radio' or link kind 'radio') whose end is
 *                        not a radio port;
 *   6. `media-mismatch`  link kind vs media; port kinds vs `MEDIA[media].portKinds` ('auto': compatible
 *                        kinds); copper wiring: a straight-through cable joins MDI↔MDI-X, a crossover joins
 *                        equal wirings, and an auto-MDIX end accepts either; console-class cables join exactly
 *                        one device console line to a computer (rollover: its ethernet port; USB console: its
 *                        USB port);
 *   7. `connector-mismatch` copper needs RJ-45 sockets, fibre needs a cage or fibre socket, media with
 *                        `connectors` pairings need a mating pair;
 *   8. `no-transceiver`  a fibre cable into an empty SFP cage;
 *   9. `sfp-mismatch`    a transceiver whose fibre mode differs from the cable, or two transceivers on
 *                        different wavelengths;
 *  10. `too-long`        longer than the media limit for the (expected) negotiated speed
 *                        (`maxLengthBySpeed`), than a thin-coax BNC segment (`THIN_COAX_SEGMENT_M`), or than an
 *                        installed transceiver's reach.
 *
 * Per-port data (D3): wiring comes from the port (`PortSpec.wiring`, else the default role's wiring trait) and
 * "is a computer" from the owning device's host shell (`hostTerminal`); no rule reads the device kind. Connector
 * rules apply only when the end declares a connector (every PortSpec does since the P0.5 exit gate), except for
 * media with explicit connector pairings, which use `KIND_CONNECTOR` defaults.
 *
 * `'auto'` resolves to the correct concrete cable by port kind and connector. The functions here are pure;
 * `link/link.ts` feeds them port data looked up through its deps.
 */
import type { CableProblem, CableValidation, LinkKind, MediaType } from '../contracts/link.js';
import { MEDIA, linkKindOf } from '../contracts/link.js';
import type { Connector, PortRole, TransceiverSpec, Wiring } from '../contracts/catalog.js';
import { KIND_CONNECTOR, ROLE_TRAITS } from '../contracts/catalog.js';
import { ETH_PHY_OVERHEAD } from '../contracts/pdu.js';
import type { PortKind, PortSpec } from '../contracts/port.js';
import { formatBps } from './negotiation.js';

export type { CableProblem, Wiring };

/** A concrete (non-auto) media type. */
export type ResolvedMedia = Exclude<MediaType, 'auto'>;

/** What the validator needs to know about one end of a cable. */
export interface PortSpecLike {
  kind: PortKind;
  /** Ethernet only: the port swaps its transmit/receive pairs, so either copper cable works. */
  autoMdix?: boolean;
  /** Copper wiring of a non-auto-MDIX port (`PortSpec.wiring`). */
  wiring?: Wiring;
  /** Effective role: decides whether the port can take a cable; its wiring trait is the wiring fallback. */
  role?: PortRole;
  /** Physical connector (`PortSpec.connector`); absent = no connector data (connector rules skipped). */
  connector?: Connector;
  /** Optics installed in an SFP cage. */
  transceiver?: TransceiverSpec;
  /** Port maximum speed; used for the expected negotiated speed of length limits. */
  speedBps?: number;
  /** Human label used in explanations (e.g. `"PC1 GigabitEthernet0"`). Defaults to `end A` / `end B`. */
  label?: string;
  /** Owning device id; when both ends carry the same id the cable is flagged. */
  device?: string;
  /**
   * The owning device has a host shell (a computer): its ethernet port can take the terminal end of a console
   * (rollover) cable and its USB port the terminal end of a USB console cable.
   */
  hostTerminal?: boolean;
}

/** `checkCable` result: a `CableValidation` whose `code` is present iff `ok` is false. */
export interface CableCheck extends CableValidation {
  code?: CableProblem;
}

/** Optional context for `checkCable`. */
export interface CableCheckOptions {
  /** Link kind requested by the caller (`LinkSpec.kind`); must agree with `linkKindOf(resolved media)`. */
  kind?: LinkKind;
  /** Negotiated speed for the length limit; default = the lowest known speed of the two ends. */
  negotiatedBps?: number;
}

/** Copper wiring of one cable end: explicit wiring, else the role's wiring trait, else MDI. */
export function wiringOfEnd(end: PortSpecLike): Wiring {
  if (end.wiring !== undefined) return end.wiring;
  if (end.role !== undefined) {
    const w = ROLE_TRAITS[end.role].wiring;
    if (w !== null) return w;
  }
  return 'MDI';
}

/**
 * Cable-validator view of a port spec. `role` is the effective role (default `spec.role`); the wiring is
 * `spec.wiring`, else the wiring trait of the DEFAULT role (a role flip never changes wiring).
 */
export function cableEndOf(
  spec: PortSpec,
  opts: { role?: PortRole; transceiver?: TransceiverSpec; label?: string; device?: string; hostTerminal?: boolean } = {},
): PortSpecLike {
  const end: PortSpecLike = { kind: spec.kind, speedBps: spec.speedBps };
  if (spec.autoMdix !== undefined) end.autoMdix = spec.autoMdix;
  const wiring = spec.wiring ?? ROLE_TRAITS[spec.role].wiring ?? undefined;
  if (wiring !== undefined) end.wiring = wiring;
  end.role = opts.role ?? spec.role;
  end.connector = spec.connector;
  if (opts.transceiver !== undefined) end.transceiver = opts.transceiver;
  if (opts.label !== undefined) end.label = opts.label;
  if (opts.device !== undefined) end.device = opts.device;
  if (opts.hostTerminal === true) end.hostTerminal = true;
  return end;
}

// ── wording (original) ──────────────────────────────────────────────────────

const MEDIA_LABELS: Readonly<Record<MediaType, string>> = Object.freeze({
  'copper-straight': 'straight-through copper cable',
  'copper-crossover': 'crossover copper cable',
  'fiber-mm': 'multimode fibre cable',
  'fiber-sm': 'single-mode fibre cable',
  serial: 'serial cable',
  console: 'console cable',
  auto: 'auto-selected cable',
  'usb-console': 'USB console cable',
  'fiber-pon': 'passive optical fibre cable',
  'serial-dce': 'serial cable with the DCE connector on the first end',
  'serial-dte': 'serial cable with the DTE connector on the first end',
  coax: 'coaxial cable',
  phone: 'telephone line cable',
  radio: 'point-to-point radio pairing',
});

/** Human name of a media type for explanations. */
export function mediaLabel(media: MediaType): string {
  return Object.prototype.hasOwnProperty.call(MEDIA_LABELS, media) ? MEDIA_LABELS[media] : `${String(media)} cable`;
}

const KIND_SINGULAR: Readonly<Record<PortKind, string>> = Object.freeze({
  ethernet: 'an ethernet port',
  serial: 'a serial port',
  console: 'a console port',
  usb: 'a USB port',
  coax: 'a coax port',
  phone: 'a phone line port',
  'fiber-pon': 'a fibre PON port',
  wlan: 'a Wi-Fi radio',
  radio: 'a point-to-point radio port',
  cellular: 'a cellular radio',
  virtual: 'a virtual interface',
});

const KIND_PLURAL: Readonly<Record<PortKind, string>> = Object.freeze({
  ethernet: 'ethernet',
  serial: 'serial',
  console: 'console',
  usb: 'USB',
  coax: 'coax',
  phone: 'phone line',
  'fiber-pon': 'fibre PON',
  wlan: 'Wi-Fi radio',
  radio: 'point-to-point radio',
  cellular: 'cellular radio',
  virtual: 'virtual',
});

/** `an ethernet port`, `a serial port`, `a Wi-Fi radio`. */
export function portKindLabel(kind: PortKind): string {
  return KIND_SINGULAR[kind];
}

/** `console ports`, `USB or console ports`. */
function kindsLabel(kinds: readonly PortKind[]): string {
  const names = kinds.map((k) => KIND_PLURAL[k]);
  if (names.length === 1) return `${names[0]} ports`;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]} ports`;
}

const CONNECTOR_LABELS: Readonly<Record<Connector, string>> = Object.freeze({
  rj45: 'an RJ-45 socket',
  'rj45-console': 'an RJ-45 console socket',
  usb: 'a USB-A socket',
  'usb-mini': 'a mini-USB socket',
  'usb-c': 'a USB-C socket',
  sfp: 'an SFP cage',
  'sfp+': 'an SFP+ cage',
  qsfp: 'a QSFP cage',
  lc: 'an LC fibre socket',
  sc: 'an SC fibre socket',
  'smart-serial': 'a smart-serial socket',
  db60: 'a DB-60 socket',
  bnc: 'a BNC connector',
  'f-type': 'an F-type connector',
  rj11: 'an RJ-11 socket',
  antenna: 'an antenna',
  none: 'no physical connector',
});

/** `an RJ-45 socket`, `an SFP cage`. */
export function connectorLabel(c: Connector): string {
  return CONNECTOR_LABELS[c];
}

const MODE_LABELS: Readonly<Record<'mm' | 'sm' | 'pon', string>> = Object.freeze({ mm: 'multimode', sm: 'single-mode', pon: 'passive optical' });

// ── media helpers ───────────────────────────────────────────────────────────

/** Whether `media` names a known entry of the MEDIA table. */
export function isMediaType(media: string): media is MediaType {
  return Object.prototype.hasOwnProperty.call(MEDIA, media);
}

/** Bytes added to every frame for serialization timing on this media (`phyOverheadBytes`, default ETH_PHY_OVERHEAD). */
export function phyOverheadBytes(media: ResolvedMedia): number {
  return MEDIA[media].phyOverheadBytes ?? ETH_PHY_OVERHEAD;
}

/**
 * Length limit of `media` at `bps`: the first `maxLengthBySpeed` entry with `bps ≤ maxBps` (the last entry
 * beyond the table); `maxLengthM` when the speed is unknown or the media has no per-speed table.
 */
export function maxLengthFor(media: ResolvedMedia, bps?: number): number {
  const spec = MEDIA[media];
  const table = spec.maxLengthBySpeed;
  if (bps === undefined || table === undefined || table.length === 0) return spec.maxLengthM;
  for (const entry of table) if (bps <= entry.maxBps) return entry.maxLengthM;
  return (table[table.length - 1] as { maxLengthM: number }).maxLengthM;
}

const CAGES: readonly Connector[] = ['sfp', 'sfp+', 'qsfp'];

/** An SFP-class cage that holds a transceiver module. */
export function isCageConnector(c: Connector | undefined): boolean {
  return c !== undefined && CAGES.includes(c);
}

/** A port that takes a fibre cable: a cage (with or without a module) or a fixed fibre socket. */
function isFibreEnd(end: PortSpecLike): boolean {
  return isCageConnector(end.connector) || end.connector === 'lc' || end.connector === 'sc';
}

/** Connector a media pairing sees: the transceiver's, else the port's, else the kind default. */
function matingConnector(end: PortSpecLike): Connector {
  return end.transceiver?.connector ?? end.connector ?? KIND_CONNECTOR[end.kind];
}

const USB_CONNECTORS: readonly Connector[] = ['usb', 'usb-mini', 'usb-c'];

/** Length limit of a thin-coax (10BASE2, BNC-to-BNC) segment; F-type cable plant keeps `MEDIA.coax.maxLengthM`. */
export const THIN_COAX_SEGMENT_M = 185;

/** The end sits on a computer (a device with a host shell, `hostTerminal`). */
function onHostTerminal(end: PortSpecLike): boolean {
  return end.hostTerminal === true;
}

/**
 * A device console line: a console/aux port, or a device-side USB console socket (a USB port that is not on a
 * computer and whose effective connector is mini-USB, the USB console default).
 */
function isConsoleLine(end: PortSpecLike): boolean {
  if (end.kind === 'console') return true;
  return end.kind === 'usb' && !onHostTerminal(end) && matingConnector(end) === 'usb-mini';
}

/**
 * The terminal end of a console-class cable: a computer's ethernet port for the rollover cable, a USB port that
 * is not a device console socket for the USB console cable.
 */
function isTerminalEnd(end: PortSpecLike, media: ResolvedMedia): boolean {
  if (isConsoleLine(end)) return false;
  if (media === 'console') return end.kind === 'ethernet' && onHostTerminal(end);
  return end.kind === 'usb' || (end.connector !== undefined && USB_CONNECTORS.includes(end.connector));
}

/** A console port and a computer's ethernet port: the pair a rollover cable joins. */
function isRolloverPair(a: PortSpecLike, b: PortSpecLike): boolean {
  return (a.kind === 'console' && b.kind === 'ethernet' && onHostTerminal(b)) || (b.kind === 'console' && a.kind === 'ethernet' && onHostTerminal(a));
}

/** Kinds `'auto'` can join into one cable. */
function kindsCompatible(a: PortKind, b: PortKind): boolean {
  if (a === b) return true;
  const consoleLike = (k: PortKind): boolean => k === 'console' || k === 'usb';
  return consoleLike(a) && consoleLike(b);
}

/** Whether the end can terminate a link at all. */
function canTakeLink(end: PortSpecLike): boolean {
  if (end.kind === 'wlan' || end.kind === 'cellular' || end.kind === 'virtual') return false;
  return end.role === undefined || ROLE_TRAITS[end.role].linkable;
}

function notACablePortReason(end: PortSpecLike, label: string): string {
  switch (end.kind) {
    case 'wlan':
      return `${label} is a Wi-Fi radio: it joins a network by associating with an access point, not through a cable.`;
    case 'cellular':
      return `${label} is a cellular radio: it attaches to a cell tower over the air, not through a cable.`;
    case 'virtual':
      return `${label} is a virtual interface inside the device, so there is nothing to plug a cable into.`;
    default:
      return `${label} has the ${end.role ?? 'unknown'} role, which cannot take a cable.`;
  }
}

/**
 * The copper cable that joins two Ethernet ports: straight-through when the wirings differ (or either side
 * is auto-MDIX), crossover when they are the same.
 */
export function copperFor(a: PortSpecLike, b: PortSpecLike): 'copper-straight' | 'copper-crossover' {
  if (a.autoMdix || b.autoMdix) return 'copper-straight';
  return wiringOfEnd(a) === wiringOfEnd(b) ? 'copper-crossover' : 'copper-straight';
}

/**
 * The concrete cable `'auto'` picks for a port kind (Ethernet is refined by `resolveMedia`). Kinds that take
 * no cable (Wi-Fi, cellular, virtual) map to copper; the validator reports them as `not-a-cable-port`.
 */
export function autoMediaForKind(kind: PortKind): ResolvedMedia {
  switch (kind) {
    case 'serial':
      return 'serial';
    case 'console':
      return 'console';
    case 'usb':
      return 'usb-console';
    case 'coax':
      return 'coax';
    case 'phone':
      return 'phone';
    case 'fiber-pon':
      return 'fiber-pon';
    case 'radio':
      return 'radio';
    case 'ethernet':
    case 'wlan':
    case 'cellular':
    case 'virtual':
      return 'copper-straight';
  }
}

/**
 * Resolve `'auto'` to a concrete cable for these two ends (any other media is returned unchanged):
 *   radio ↔ radio → radio; ethernet ↔ ethernet → fibre when both ends are fibre ports (single-mode when a
 *   transceiver is single-mode, else multimode), otherwise straight/crossover from the wirings;
 *   console ↔ a computer's ethernet port → console (rollover);
 *   console/USB pairs → the USB console cable when a USB port or USB connectors are involved, else console;
 *   everything else → `autoMediaForKind(a.kind)`.
 */
export function resolveMedia(a: PortSpecLike, b: PortSpecLike, media: MediaType): ResolvedMedia {
  if (media !== 'auto') return media;
  if (a.kind === 'radio' && b.kind === 'radio') return 'radio';
  if (isRolloverPair(a, b)) return 'console';
  if (a.kind === 'ethernet' && b.kind === 'ethernet') {
    if (isFibreEnd(a) && isFibreEnd(b)) {
      const mode = a.transceiver?.mode ?? b.transceiver?.mode ?? 'mm';
      return mode === 'sm' ? 'fiber-sm' : 'fiber-mm';
    }
    return copperFor(a, b);
  }
  if (kindsCompatible(a.kind, b.kind) && (a.kind === 'console' || a.kind === 'usb')) {
    const usbEnd = (e: PortSpecLike): boolean => e.kind === 'usb' || (e.connector !== undefined && USB_CONNECTORS.includes(e.connector));
    return usbEnd(a) || usbEnd(b) ? 'usb-console' : 'console';
  }
  return autoMediaForKind(a.kind);
}

/** Expected negotiated speed for length limits: the lowest known port or transceiver speed of both ends. */
function expectedBps(a: PortSpecLike, b: PortSpecLike): number | undefined {
  let bps: number | undefined;
  for (const v of [a.speedBps, b.speedBps, a.transceiver?.speedBps, b.transceiver?.speedBps]) {
    if (v !== undefined && (bps === undefined || v < bps)) bps = v;
  }
  return bps;
}

/**
 * Full validation with a problem code (see the file header for the check order). `validateCable` is the
 * contract-shaped view of this. Never throws: every bad input becomes `ok:false` with an explanation.
 */
export function checkCable(a: PortSpecLike, b: PortSpecLike, media: MediaType, lengthM: number, opts: CableCheckOptions = {}): CableCheck {
  const labelA = a.label ?? 'end A';
  const labelB = b.label ?? 'end B';
  const ends = [[a, labelA], [b, labelB]] as const;

  if (!isMediaType(media)) {
    return { ok: false, code: 'unknown-media', reason: `"${String(media)}" is not a cable type this workbench knows.` };
  }
  if (typeof lengthM !== 'number' || !Number.isFinite(lengthM) || lengthM < 0) {
    return { ok: false, code: 'bad-length', reason: 'Cable length must be a non-negative number of metres.' };
  }
  const resolved = resolveMedia(a, b, media);
  const fail = (code: CableProblem, reason: string, resolvedMedia: ResolvedMedia = resolved): CableCheck => ({
    ok: false,
    code,
    reason,
    resolvedMedia,
  });

  if (a.device !== undefined && a.device === b.device) {
    return fail('same-device', `A cable cannot link ${labelA} to ${labelB}: both ends are on the same device.`);
  }

  for (const [end, label] of ends) {
    if (!canTakeLink(end)) return fail('not-a-cable-port', notACablePortReason(end, label));
  }

  if (resolved === 'radio' || opts.kind === 'radio') {
    for (const [end, label] of ends) {
      if (end.kind !== 'radio' || (end.role !== undefined && end.role !== 'radio-ptp')) {
        return fail(
          'radio-needs-radio-port',
          `A point-to-point radio link joins two radio bridge ports, but ${label} is ${portKindLabel(end.kind)}.`,
          'radio',
        );
      }
    }
  }

  // ── media-mismatch: link kind, port kinds, copper wiring ──
  if (opts.kind !== undefined && opts.kind !== linkKindOf(resolved)) {
    return fail(
      'media-mismatch',
      opts.kind === 'radio'
        ? `A radio link must use a ${mediaLabel('radio')}, not a ${mediaLabel(resolved)}.`
        : `A ${mediaLabel('radio')} is not a cable; create it as a radio link between two radio ports.`,
    );
  }
  const spec = MEDIA[media];
  if (media === 'auto') {
    if (!kindsCompatible(a.kind, b.kind) && !isRolloverPair(a, b)) {
      return fail(
        'media-mismatch',
        `No cable joins ${portKindLabel(a.kind)} (${labelA}) to ${portKindLabel(b.kind)} (${labelB}).`,
        autoMediaForKind(a.kind),
      );
    }
  } else {
    for (const [end, label] of ends) {
      if (!spec.portKinds.includes(end.kind)) {
        return fail('media-mismatch', `A ${mediaLabel(media)} only fits ${kindsLabel(spec.portKinds)}, but ${label} is ${portKindLabel(end.kind)}.`, media);
      }
    }
  }
  if (MEDIA[resolved].class === 'console') {
    // Exactly one device console line, and a computer at the other end.
    const lineA = isConsoleLine(a);
    const lineB = isConsoleLine(b);
    if (lineA && lineB) {
      return fail(
        'media-mismatch',
        `A ${mediaLabel(resolved)} cannot link ${labelA} to ${labelB}: both ends are device console lines; connect one end to a computer.`,
      );
    }
    const terminalWord = resolved === 'console' ? "a computer's ethernet port" : "a computer's USB port";
    if (!lineA && !lineB) {
      return fail(
        'media-mismatch',
        `A ${mediaLabel(resolved)} only fits a device console line at one end and ${terminalWord} at the other, but neither ${labelA} nor ${labelB} is a console line.`,
      );
    }
    const [other, otherLabel] = lineA ? [b, labelB] : [a, labelA];
    if (!isTerminalEnd(other, resolved)) {
      const where = other.kind === 'ethernet' && !onHostTerminal(other) ? ' on a device that is not a computer' : '';
      return fail(
        'media-mismatch',
        `A ${mediaLabel(resolved)} only fits a device console line and ${terminalWord}, but ${otherLabel} is ${portKindLabel(other.kind)}${where}.`,
      );
    }
  }
  if ((resolved === 'copper-straight' || resolved === 'copper-crossover') && !a.autoMdix && !b.autoMdix) {
    const wanted = copperFor(a, b);
    if (wanted !== resolved) {
      const wa = wiringOfEnd(a);
      const wb = wiringOfEnd(b);
      const pairing = wa === wb ? `both ends are ${wa} ports` : `${labelA} is ${wa} and ${labelB} is ${wb}`;
      return fail(
        'media-mismatch',
        `A ${mediaLabel(resolved)} cannot link ${labelA} to ${labelB}: ${pairing}, so use a ${mediaLabel(wanted)} instead.`,
      );
    }
  }

  // ── connector-mismatch ──
  const cls = MEDIA[resolved].class;
  const fiberMode = MEDIA[resolved].fiberMode;
  if (cls === 'copper') {
    for (const [end, label] of ends) {
      if (end.connector !== undefined && end.connector !== 'rj45') {
        const what = isCageConnector(end.connector) ? ', which holds a transceiver module rather than a copper plug' : ', not an RJ-45 socket';
        return fail('connector-mismatch', `A ${mediaLabel(resolved)} needs RJ-45 sockets, but ${label} has ${connectorLabel(end.connector)}${what}.`);
      }
    }
  }
  if (fiberMode === 'mm' || fiberMode === 'sm') {
    for (const [end, label] of ends) {
      if (end.connector !== undefined && !isFibreEnd(end)) {
        return fail(
          'connector-mismatch',
          `A ${mediaLabel(resolved)} needs an SFP cage with a transceiver or a fibre socket, but ${label} has ${connectorLabel(end.connector)}.`,
        );
      }
    }
  }
  const pairs = MEDIA[resolved].connectors;
  if (pairs !== undefined && pairs.length > 0) {
    const ca = matingConnector(a);
    const cb = matingConnector(b);
    for (const [label, c] of [[labelA, ca], [labelB, cb]] as const) {
      if (!pairs.some((p) => p.a.includes(c) || p.b.includes(c))) {
        const wanted: Connector[] = [];
        for (const p of pairs) for (const x of [...p.a, ...p.b]) if (!wanted.includes(x)) wanted.push(x);
        return fail(
          'connector-mismatch',
          `A ${mediaLabel(resolved)} ends in ${wanted.map(connectorLabel).join(' or ')}, but ${label} has ${connectorLabel(c)}.`,
        );
      }
    }
    if (!pairs.some((p) => (p.a.includes(ca) && p.b.includes(cb)) || (p.a.includes(cb) && p.b.includes(ca)))) {
      return fail(
        'connector-mismatch',
        `A ${mediaLabel(resolved)} cannot join ${labelA} (${connectorLabel(ca)}) to ${labelB} (${connectorLabel(cb)}): the connectors do not mate.`,
      );
    }
  }

  // ── optics: no-transceiver, sfp-mismatch ──
  if (fiberMode === 'mm' || fiberMode === 'sm') {
    for (const [end, label] of ends) {
      if (isCageConnector(end.connector) && end.transceiver === undefined) {
        return fail('no-transceiver', `${label} is an empty ${end.connector === 'qsfp' ? 'QSFP' : 'SFP'} cage: insert a fibre transceiver module before connecting a fibre cable.`);
      }
    }
    for (const [end, label] of ends) {
      const t = end.transceiver;
      if (t !== undefined && t.mode !== fiberMode) {
        return fail(
          'sfp-mismatch',
          `${label} holds a ${MODE_LABELS[t.mode]} transceiver, but a ${mediaLabel(resolved)} carries ${MODE_LABELS[fiberMode]} light: use a matching cable or module.`,
        );
      }
    }
    const ta = a.transceiver;
    const tb = b.transceiver;
    if (ta !== undefined && tb !== undefined && ta.wavelengthNm !== tb.wavelengthNm) {
      return fail(
        'sfp-mismatch',
        `The transceivers in ${labelA} (${ta.wavelengthNm} nm) and ${labelB} (${tb.wavelengthNm} nm) use different wavelengths, so they cannot hear each other.`,
      );
    }
  }

  // ── too-long ──
  const bps = opts.negotiatedBps ?? expectedBps(a, b);
  const limit = maxLengthFor(resolved, bps);
  if (resolved === 'coax' && matingConnector(a) === 'bnc' && matingConnector(b) === 'bnc' && lengthM > THIN_COAX_SEGMENT_M) {
    return fail('too-long', `A cable of ${lengthM} m exceeds the ${THIN_COAX_SEGMENT_M} m limit of a thin-coax (BNC) segment.`);
  }
  if (lengthM > limit) {
    const atSpeed = bps !== undefined && limit < MEDIA[resolved].maxLengthM ? ` at ${formatBps(bps)}` : '';
    return fail('too-long', `A cable of ${lengthM} m exceeds the ${limit} m limit for ${resolved}${atSpeed} (${mediaLabel(resolved)}).`);
  }
  for (const [end, label] of ends) {
    const t = end.transceiver;
    if (t !== undefined && lengthM > t.maxLengthM) {
      return fail('too-long', `A cable of ${lengthM} m exceeds the ${t.maxLengthM} m reach of the transceiver in ${label}.`);
    }
  }

  return { ok: true, resolvedMedia: resolved };
}

/**
 * Validate a cable between two ports (spec §8.3). Pure; never throws. `ok:false` carries an original
 * explanation naming what is wrong and which cable to use; `resolvedMedia` is the concrete cable (for
 * `'auto'`, the one that would be correct). The problem code is stripped (see `checkCable`).
 */
export function validateCable(a: PortSpecLike, b: PortSpecLike, media: MediaType, lengthM: number, opts: CableCheckOptions = {}): CableValidation {
  const check = checkCable(a, b, media, lengthM, opts);
  const out: CableValidation = { ok: check.ok };
  if (check.reason !== undefined) out.reason = check.reason;
  if (check.resolvedMedia !== undefined) out.resolvedMedia = check.resolvedMedia;
  return out;
}
