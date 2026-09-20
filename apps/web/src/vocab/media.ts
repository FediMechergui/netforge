/**
 * Media vocabulary: cable names, picker labels, stroke styles, dash patterns, media badges and the wording
 * for link-down and line-protocol reasons (ARCHITECTURE-P1 §7; merges the P0 `cables.MEDIA_NAMES`,
 * `cables.downReasonText` and `LinkInspector.explainDownReason` vocabularies).
 *
 * Non-colour channel (§7): each media has a unique line style (stroke kind + dash pattern + DCE end glyph)
 * and a unique badge. Dash patterns are in world units, alternating dash and gap lengths; an empty pattern
 * is a solid line. A link that is down is additionally marked by the canvas (crossed badge, reduced alpha),
 * so the media pattern never has to encode link state.
 *
 * All wording is original (§1.6). Command names inside quotes ("clock rate", "no shutdown") are syntax.
 */
import { MEDIA } from '@netforge/engine';
import type { CableProblem, LinkDownCode, MediaClass, MediaType } from '@netforge/engine';
import type { ColorToken } from './protocols.js';

/** How the canvas strokes a cable. */
export type MediaStroke = 'single' | 'double' | 'thick' | 'thin' | 'beam';

/** Presentation data for one media type. */
export interface MediaVocab {
  readonly media: MediaType;
  /** Lower-case running-text name ("straight-through copper"). */
  readonly name: string;
  /** Short picker label. */
  readonly short: string;
  /** Badge drawn mid-cable at high zoom and in the picker; unique across media. */
  readonly badge: string;
  readonly stroke: MediaStroke;
  /** Dash/gap lengths in world units; empty = solid. */
  readonly dash: readonly number[];
  readonly color: ColorToken;
  /** Offered by the cable picker. */
  readonly picker: boolean;
  /** Picker description. */
  readonly description: string;
  /** Explains which end becomes DCE (serial media only). */
  readonly dceHint?: string;
}

function media(
  type: MediaType,
  name: string,
  short: string,
  badge: string,
  stroke: MediaStroke,
  dash: readonly number[],
  color: ColorToken,
  picker: boolean,
  description: string,
  dceHint?: string,
): MediaVocab {
  const base = { media: type, name, short, badge, stroke, dash: Object.freeze([...dash]), color, picker, description };
  return Object.freeze(dceHint === undefined ? base : { ...base, dceHint });
}

/** Every media type, exhaustive over `MediaType`. */
export const MEDIA_VOCAB: Readonly<Record<MediaType, MediaVocab>> = Object.freeze({
  auto: media('auto', 'automatic choice', 'Automatic', 'A', 'single', [1, 4], 'textDim', true,
    'Picks the correct cable for the two ports. Turn it off to practise choosing cables yourself.'),
  'copper-straight': media('copper-straight', 'straight-through copper', 'Straight-through', 'ST', 'single', [], 'accent', true,
    'Copper Ethernet cable joining a host or router to a switch or hub.'),
  'copper-crossover': media('copper-crossover', 'crossover copper', 'Crossover', 'CO', 'single', [10, 3, 2, 3], 'purple', true,
    'Copper Ethernet cable joining two devices of the same side, such as switch to switch.'),
  console: media('console', 'console cable', 'Console (rollover)', 'RO', 'thin', [2, 3], 'blueDeep', true,
    'Rollover cable from a computer to a device console port. It carries a terminal session, not network traffic.'),
  'usb-console': media('usb-console', 'USB console cable', 'USB console', 'USB', 'thin', [6, 3], 'blueDeep', true,
    'USB cable to a console port. It carries a terminal session, not network traffic.'),
  serial: media('serial', 'serial', 'Serial (legacy)', 'SE', 'single', [12, 3, 2, 3, 2, 3], 'err', false,
    'Serial cable from older project files; the DCE end is decided by the port.',
    'The DCE end is set by the port; that end needs a clock rate.'),
  'serial-dce': media('serial-dce', 'serial cable, DCE end first', 'Serial, DCE first', 'DCE', 'single', [12, 3, 2, 3, 2, 3], 'err', true,
    'Serial cable between routers. The first port you click receives the clock-supplying end.',
    'The first port you click becomes the DCE end and needs "clock rate".'),
  'serial-dte': media('serial-dte', 'serial cable, DTE end first', 'Serial, DTE first', 'DTE', 'single', [12, 3, 2, 3, 2, 3], 'err', true,
    'Serial cable between routers. The second port you click receives the clock-supplying end.',
    'The second port you click becomes the DCE end and needs "clock rate".'),
  'fiber-mm': media('fiber-mm', 'multimode fibre', 'Multimode fibre', 'MM', 'double', [], 'yellow', true,
    'Short-reach optical cable between ports fitted with multimode transceivers.'),
  'fiber-sm': media('fiber-sm', 'single-mode fibre', 'Single-mode fibre', 'SM', 'double', [12, 4], 'yellow', true,
    'Long-reach optical cable between ports fitted with single-mode transceivers.'),
  'fiber-pon': media('fiber-pon', 'passive optical fibre', 'Optical access fibre', 'PON', 'double', [4, 4], 'yellow', true,
    'Access fibre from an optical network terminal to the provider.'),
  coax: media('coax', 'coaxial cable', 'Coaxial', 'CX', 'thick', [], 'warn', true,
    'Coaxial cable for thin-coax segments and cable modems.'),
  phone: media('phone', 'phone line', 'Phone line', 'PH', 'single', [3, 3], 'ok', true,
    'Telephone pair from a DSL modem to the provider.'),
  radio: media('radio', 'point-to-point radio link', 'Radio link', 'RF', 'beam', [16, 6], 'accent', true,
    'Pairs the radio ports of two radio bridges; the signal depends on distance, band and channel.'),
});

/** Cable picker order ('auto' first). */
export const MEDIA_PICKER_ORDER: readonly MediaType[] = Object.freeze([
  'auto',
  'copper-straight',
  'copper-crossover',
  'console',
  'usb-console',
  'serial-dce',
  'serial-dte',
  'fiber-mm',
  'fiber-sm',
  'fiber-pon',
  'coax',
  'phone',
  'radio',
]);

/** Running-text name of a media type. */
export function mediaName(type: MediaType): string {
  return MEDIA_VOCAB[type].name;
}

/** Badge of a media type. */
export function mediaBadge(type: MediaType): string {
  return MEDIA_VOCAB[type].badge;
}

/** Media class from the engine table. */
export function mediaClass(type: MediaType): MediaClass | undefined {
  return MEDIA[type].class;
}

/** End of a cable that carries the DCE connector by media alone (undefined for non-serial media). */
export function mediaDceEnd(type: MediaType): 'a' | 'b' | undefined {
  return MEDIA[type].dceEnd;
}

/**
 * Identity of the non-colour line style: stroke kind, dash pattern and DCE end glyph. Unique per media type
 * (the legacy serial cable draws its clock glyph from the link state instead of the media).
 */
export function mediaLineStyleKey(type: MediaType): string {
  const v = MEDIA_VOCAB[type];
  return `${v.stroke}|${v.dash.join(',')}|${mediaDceEnd(type) ?? (type === 'serial' ? 'port' : '-')}`;
}

// ── link down reasons ────────────────────────────────────────────────────────

/** Codes that name an end with an `:a` / `:b` suffix in `LinkState.downReason`. */
export type EndDownCode = 'power-off' | 'admin-down' | 'err-disabled';

/** Every code a `LinkState.downReason` can start with. */
export type LinkDownKey = CableProblem | LinkDownCode | EndDownCode;

/**
 * Wording of one down reason. Placeholders: `{device}` the device at the named end, `{end}` the port label
 * at the named end ("Gi0/1 on SW1"), `{length}` the cable length in metres. Without a named end both fall
 * back to "one end".
 */
export interface LinkDownVocab {
  /** Short phrase for canvas tooltips. */
  readonly short: string;
  /** Full explanation for the link inspector. */
  readonly explain: string;
}

function down(short: string, explain: string): LinkDownVocab {
  return Object.freeze({ short, explain });
}

/** Every link down reason, exhaustive over `LinkDownKey`. */
export const LINK_DOWN_VOCAB: Readonly<Record<LinkDownKey, LinkDownVocab>> = Object.freeze({
  'power-off': down('{device} is powered off or still starting', '{device} is powered off or still booting, so {end} has no carrier.'),
  'admin-down': down('the port on {device} is shut down',
    '{end} is administratively shut down. Enter "no shutdown" on that interface (or use the port panel) to bring it up.'),
  'err-disabled': down('the port on {device} is error-disabled', '{end} was error-disabled by a protection feature and stays down until it is reset.'),
  'unknown-media': down('unknown cable type', 'The cable type is not recognised.'),
  'bad-length': down('invalid cable length', 'The cable length is not a valid number of metres.'),
  'same-device': down('both ends are on the same device', 'Both ends of the cable are on the same device, which creates a loop the device refuses.'),
  'media-mismatch': down('this cable type does not suit these ports',
    'This cable type does not suit these two ports (for example a straight cable between two hosts, or copper on a serial port). Delete it and reconnect with the matching cable, or choose automatic cable selection.'),
  'too-long': down('the cable is longer than this medium allows',
    'The cable is {length} m long, beyond what this medium can carry at this speed. Shorten it or use fibre.'),
  'connector-mismatch': down('the plugs do not fit these ports',
    'The cable ends do not match the sockets on these ports (for example fibre on a copper socket). Pick a cable whose plugs fit both ports.'),
  'no-transceiver': down('an optical port has no transceiver',
    'An optical cage on this cable is empty. Switch the device off and insert a transceiver module from the Physical tab.'),
  'sfp-mismatch': down('the transceiver does not suit this fibre',
    'The installed transceiver expects a different fibre type or a shorter run. Use the fibre the transceiver was made for.'),
  'not-a-cable-port': down('one port does not take cables',
    'One of these ports cannot hold a cable, for example a wireless radio or a virtual interface.'),
  'radio-needs-radio-port': down('radio links need a radio port at both ends',
    'A point-to-point radio link can only join two radio ports. Connect the radio interfaces of two radio bridges.'),
  cut: down('the cable has been cut', 'The cable has been cut by an injected fault.'),
  removed: down('the cable was removed', 'The cable was disconnected from its ports.'),
  'speed-mismatch': down('the ends share no speed',
    'The two ports have no speed in common, so the link cannot come up. Set matching speeds or let both ends negotiate.'),
  'radio-band-mismatch': down('the radios use different bands', 'The two radios are set to different frequency bands. Choose the same band on both.'),
  'radio-channel-mismatch': down('the radios use different channels', 'The two radios are tuned to different channels. Choose the same channel on both.'),
  'radio-key-mismatch': down('the radio pairing keys differ', 'The pairing keys of the two radios do not match. Enter the same peer key on both.'),
  'out-of-range': down('the radios are out of range',
    'The radios are too far apart for a usable signal. Move them closer, raise the transmit power or shorten the distance.'),
  'no-clock': down('no clock from the DCE end',
    'The line has carrier but no clock. Enter "clock rate" on the DCE end of the serial cable, the end marked with the clock glyph.'),
  'encapsulation-mismatch': down('the serial encapsulations differ',
    'The two serial ports use different encapsulations. Set the same encapsulation on both ends.'),
  'keepalive-missed': down('keepalives stopped arriving',
    '{end} stopped hearing keepalives from its peer and took the line protocol down. Check that keepalives are enabled on both ends.'),
});

/** Names used to fill link-down wording. */
export interface LinkEndNames {
  /** Device name at end a. */
  readonly deviceA?: string;
  /** Device name at end b. */
  readonly deviceB?: string;
  /** Port label at end a ("Gi0/1 on SW1"). */
  readonly endA?: string;
  /** Port label at end b. */
  readonly endB?: string;
  readonly lengthM?: number;
}

/** Resolved wording of a `LinkState.downReason`. */
export interface LinkDownText {
  readonly code: string;
  readonly side?: 'a' | 'b';
  readonly short: string;
  readonly explain: string;
  /** False when the code is not in the vocabulary (the raw reason is shown). */
  readonly known: boolean;
}

const ONE_END = 'one end';

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

function isLinkDownKey(code: string): code is LinkDownKey {
  return Object.prototype.hasOwnProperty.call(LINK_DOWN_VOCAB, code);
}

/** Wording for a `LinkState.downReason` such as `'admin-down:b'` or `'no-clock'`. */
export function linkDownText(reason: string | undefined, names: LinkEndNames = {}): LinkDownText {
  if (reason === undefined || reason === '') {
    return { code: '', short: 'no signal', explain: 'The link is down.', known: false };
  }
  const colon = reason.lastIndexOf(':');
  const suffix = colon >= 0 ? reason.slice(colon + 1) : '';
  const side = suffix === 'a' || suffix === 'b' ? suffix : undefined;
  const code = side ? reason.slice(0, colon) : reason;
  if (!isLinkDownKey(code)) {
    return side
      ? { code, side, short: reason, explain: `The link is down (${reason}).`, known: false }
      : { code, short: reason, explain: `The link is down (${reason}).`, known: false };
  }
  const device = side === 'a' ? names.deviceA : side === 'b' ? names.deviceB : undefined;
  const end = side === 'a' ? names.endA : side === 'b' ? names.endB : undefined;
  const values = {
    device: device ?? ONE_END,
    end: end ?? device ?? ONE_END,
    length: names.lengthM === undefined ? '?' : String(names.lengthM),
  };
  const v = LINK_DOWN_VOCAB[code];
  const short = fill(v.short, values);
  const explain = capitalise(fill(v.explain, values));
  return side ? { code, side, short, explain, known: true } : { code, short, explain, known: true };
}

function capitalise(s: string): string {
  return s.length > 0 ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

// ── line protocol reasons ────────────────────────────────────────────────────

/** Reasons a port can have carrier while its line protocol is down (`PortPhy.lineProtocolReason`). */
export type LineProtocolReason = 'no-clock' | 'encapsulation-mismatch' | 'keepalive-missed' | 'not-associated';

/** Short wording for "up, line protocol down" states. */
export const LINE_PROTOCOL_TEXT: Readonly<Record<LineProtocolReason, string>> = Object.freeze({
  'no-clock': 'waiting for a clock from the DCE end',
  'encapsulation-mismatch': 'the two ends use different encapsulations',
  'keepalive-missed': 'keepalives from the peer stopped',
  'not-associated': 'not joined to a wireless network yet',
});

/** Wording of a line protocol reason (the raw reason when unknown, empty when absent). */
export function lineProtocolText(reason: string | undefined): string {
  if (reason === undefined) return '';
  return (LINE_PROTOCOL_TEXT as Readonly<Record<string, string>>)[reason] ?? reason;
}
