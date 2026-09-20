/**
 * GUI settings forms: form models, snapshot readers, client-side validation and the mapping of headless
 * configure results back onto form fields (ARCHITECTURE-P1 D9, §3.12, §6, §7 "AP / home router / radio /
 * tower settings", §8.1 W2 web-inspector).
 *
 * Panels (WirelessPanel, HomeRouterPanel, RadioLinkPanel, CellTowerPanel, the Desktop IP configuration and
 * Wi-Fi apps; W6) never write configuration themselves:
 *  1. `…FormFrom(device)` reads the current values from the DeviceSnapshot (port state plus the rendered
 *     running-config, which is the source of truth for configured lines);
 *  2. `validate…Form` catches typing mistakes before anything is sent (original wording);
 *  3. gui/commands.ts turns the edited form and its baseline into canonical config lines;
 *  4. `EngineApi.configure` runs them through the device's CLI grammar (the same validator as the console);
 *  5. `mapConfigureResult` puts per-line errors (with caret columns) next to the form field that produced them.
 *
 * Form values are the strings the inputs hold, so a half-typed value never has to be coerced. Field keys are
 * the property names of the form interfaces; nested forms use dotted keys (`radios.0.ssid`). Passphrases and
 * peer keys never appear in snapshots: forms carry `hasPassphrase` / `hasPeerKey` from the config line's
 * presence, and an empty input means "keep the stored secret". All wording is original (§1.6).
 */
import { CHANNELS, isIpv4Multicast, maskToPrefixLen, parseIpv4, prefixLenToMask, prefixLenToMaskU32, walkConfigText } from '@netforge/engine';
import type { CliGrammar, ConfigureResult, DeviceSnapshot, PortId, PortSnapshot, RadioPortSpec, RfBand, WifiSecurity } from '@netforge/engine';
import type { CommandPlan } from './commands.js';

// ── form models ──────────────────────────────────────────────────────────────

/** Field key → message. Empty when the form is valid. */
export type FormErrors = Record<string, string>;

/** IP configuration of one adapter (Desktop IP configuration app; management address of switches and APs). */
export interface IpConfigForm {
  adapter: PortId;
  address: string;
  /** Dotted mask, `/24` or `24`. */
  mask: string;
  gateway: string;
}

/** Address of one routed or virtual interface. */
export interface InterfaceAddressForm {
  port: PortId;
  address: string;
  mask: string;
}

/** One access-point radio (`interface WlanN` on an AP or a home router). */
export interface WirelessApForm {
  port: PortId;
  /** `no shutdown` when true. */
  enabled: boolean;
  /** Empty = radio idle (`no ssid`). */
  ssid: string;
  security: WifiSecurity;
  /** Empty = keep the stored passphrase. */
  passphrase: string;
  /** A passphrase line is configured. */
  hasPassphrase: boolean;
  /** '2.4' | '5' | '6' | '60'. */
  band: string;
  /** 'auto' or a channel number. */
  channel: string;
  /** '20' | '40' | '80' | '160' (ignored on 60 GHz). */
  widthMhz: string;
  txPowerDbm: string;
}

/** A station radio joining a network (Desktop Wi-Fi app). */
export interface WifiClientForm {
  port: PortId;
  /** Empty = disconnected. */
  ssid: string;
  security: WifiSecurity;
  passphrase: string;
  hasPassphrase: boolean;
}

/** A point-to-point radio (`interface RadioN`). */
export interface RadioLinkForm {
  port: PortId;
  enabled: boolean;
  band: string;
  channel: string;
  txPowerDbm: string;
  /** Empty = keep the stored key. */
  peerKey: string;
  hasPeerKey: boolean;
}

/** A mobile network tower radio (`interface CellularN`). */
export interface CellTowerForm {
  port: PortId;
  enabled: boolean;
  txPowerDbm: string;
}

/** Home router setup: local network, internet side and the radios. */
export interface HomeRouterForm {
  lan: InterfaceAddressForm;
  wan: InterfaceAddressForm & { gateway: string };
  radios: WirelessApForm[];
}

/** Wi-Fi security modes in display order. */
export const WIFI_SECURITY_MODES: readonly WifiSecurity[] = Object.freeze(['open', 'wpa2-psk', 'wpa3-sae']);

/** Display names of the Wi-Fi security modes. */
export const WIFI_SECURITY_LABELS: Readonly<Record<WifiSecurity, string>> = Object.freeze({
  open: 'Open (no password)',
  'wpa2-psk': 'WPA2 personal',
  'wpa3-sae': 'WPA3 personal',
});

/** Bands a Wi-Fi or point-to-point radio can be set to (the `band` line). */
export const RADIO_BANDS: readonly Exclude<RfBand, 'cell'>[] = Object.freeze(['2.4', '5', '6', '60']);

/** Display names of the bands. */
export const BAND_LABELS: Readonly<Record<Exclude<RfBand, 'cell'>, string>> = Object.freeze({
  '2.4': '2.4 GHz',
  '5': '5 GHz',
  '6': '6 GHz',
  '60': '60 GHz',
});

/** Channel widths the `channel-width` line accepts. */
export const CHANNEL_WIDTHS: readonly number[] = Object.freeze([20, 40, 80, 160]);

/** Transmit power ceiling when the port's radio spec is unknown (dBm). */
export const DEFAULT_MAX_TX_POWER_DBM = 30;

/** SSID length limit (characters). */
export const SSID_MAX = 32;
/** Shortest passphrase (characters). */
export const PASSPHRASE_MIN = 8;
/** Longest passphrase (characters). */
export const PASSPHRASE_MAX = 63;
/** Peer key length limit (characters). */
export const PEER_KEY_MAX = 63;

// ── snapshot readers ─────────────────────────────────────────────────────────

/** One configuration line of a running-config section: its tokens and whether it is a `no …` line. */
export interface ConfigLineView {
  readonly tokens: readonly string[];
  readonly negate: boolean;
}

/** Lines directly inside `interface <port>` of a rendered config, in text order. */
export function interfaceConfigLines(runningConfig: string, port: PortId): readonly ConfigLineView[] {
  const out: ConfigLineView[] = [];
  for (const l of walkConfigText(runningConfig)) {
    const ctx = l.context;
    if (ctx.length !== 1) continue;
    const head = ctx[0] as readonly string[];
    if (head[0] !== 'interface' || head.slice(1).join(' ') !== port) continue;
    out.push(Object.freeze({ tokens: Object.freeze([...l.tokens]), negate: l.negate }));
  }
  return Object.freeze(out);
}

/** Top-level lines of a rendered config, in text order. */
export function globalConfigLines(runningConfig: string): readonly ConfigLineView[] {
  const out: ConfigLineView[] = [];
  for (const l of walkConfigText(runningConfig)) {
    if (l.context.length === 0) out.push(Object.freeze({ tokens: Object.freeze([...l.tokens]), negate: l.negate }));
  }
  return Object.freeze(out);
}

function startsWith(tokens: readonly string[], key: readonly string[]): boolean {
  return key.every((k, i) => tokens[i] === k);
}

/** Arguments (joined by one space) of the first positive line starting with `key`; undefined when absent. */
export function configValue(lines: readonly ConfigLineView[], key: readonly string[]): string | undefined {
  const hit = lines.find((l) => !l.negate && l.tokens.length >= key.length && startsWith(l.tokens, key));
  return hit === undefined ? undefined : hit.tokens.slice(key.length).join(' ');
}

/** Whether a positive line starting with `key` exists. */
export function hasConfigLine(lines: readonly ConfigLineView[], key: readonly string[]): boolean {
  return configValue(lines, key) !== undefined;
}

function portOf(device: DeviceSnapshot, port: PortId): PortSnapshot | undefined {
  return device.ports.find((p) => p.id === port);
}

/** The adapter the host shell and IP configuration app use by default: `hostPorts[0]`, else the first port. */
export function defaultAdapter(device: Pick<DeviceSnapshot, 'hostPorts' | 'ports'>): PortId | undefined {
  return device.hostPorts?.[0] ?? device.ports[0]?.id;
}

/** Grammar the device's configure session uses (nfos when the snapshot predates the P0.5 fields). */
export function deviceGrammar(device: Pick<DeviceSnapshot, 'cli'>): CliGrammar {
  return device.cli?.grammar ?? 'nfos';
}

/** Current address and mask of an interface: the live PortL3 value, else its `ip address` config line. */
export function interfaceAddressFrom(device: DeviceSnapshot, port: PortId): InterfaceAddressForm {
  const live = portOf(device, port)?.l3.ipv4;
  if (live !== undefined) return { port, address: live.address, mask: prefixLenToMask(live.prefixLen) };
  const value = configValue(interfaceConfigLines(device.runningConfig, port), ['ip', 'address']);
  const [address, mask] = (value ?? '').split(' ');
  return { port, address: address !== undefined && parseIpv4(address) !== null ? address : '', mask: mask !== undefined && parseIpv4(mask) !== null ? mask : '' };
}

/** IP configuration form of an adapter (default: `defaultAdapter`). */
export function ipConfigFormFrom(device: DeviceSnapshot, adapter?: PortId): IpConfigForm {
  const port = adapter ?? defaultAdapter(device) ?? '';
  const addr = interfaceAddressFrom(device, port);
  const gateway = configValue(globalConfigLines(device.runningConfig), ['ip', 'default-gateway']) ?? '';
  return { adapter: port, address: addr.address, mask: addr.mask, gateway };
}

function radioValues(device: DeviceSnapshot, port: PortId): { lines: readonly ConfigLineView[]; view: PortSnapshot | undefined } {
  return { lines: interfaceConfigLines(device.runningConfig, port), view: portOf(device, port) };
}

/** Access-point radio form of a Wlan port. Configured lines win; the live radio view fills the rest. */
export function wirelessApFormFrom(device: DeviceSnapshot, port: PortId): WirelessApForm {
  const { lines, view } = radioValues(device, port);
  const radio = view?.radio;
  return {
    port,
    enabled: view?.adminUp ?? !hasConfigLine(lines, ['shutdown']),
    ssid: configValue(lines, ['ssid']) ?? radio?.ssid ?? '',
    security: toSecurity(configValue(lines, ['security']) ?? radio?.security),
    passphrase: '',
    hasPassphrase: hasConfigLine(lines, ['passphrase']),
    band: configValue(lines, ['band']) ?? radio?.band ?? '',
    channel: configValue(lines, ['channel']) ?? (radio !== undefined ? String(radio.channel) : ''),
    widthMhz: configValue(lines, ['channel-width']) ?? (radio !== undefined ? String(radio.widthMhz) : ''),
    txPowerDbm: configValue(lines, ['tx-power']) ?? (radio !== undefined ? String(radio.txPowerDbm) : ''),
  };
}

/** Station form of a Wlan port (the Desktop Wi-Fi app). */
export function wifiClientFormFrom(device: DeviceSnapshot, port: PortId): WifiClientForm {
  const { lines, view } = radioValues(device, port);
  const radio = view?.radio;
  return {
    port,
    ssid: configValue(lines, ['ssid']) ?? radio?.ssid ?? '',
    security: toSecurity(configValue(lines, ['security']) ?? radio?.security),
    passphrase: '',
    hasPassphrase: hasConfigLine(lines, ['passphrase']),
  };
}

/** Point-to-point radio form of a Radio port. */
export function radioLinkFormFrom(device: DeviceSnapshot, port: PortId): RadioLinkForm {
  const { lines, view } = radioValues(device, port);
  const radio = view?.radio;
  return {
    port,
    enabled: view?.adminUp ?? !hasConfigLine(lines, ['shutdown']),
    band: configValue(lines, ['band']) ?? radio?.band ?? '',
    channel: configValue(lines, ['channel']) ?? (radio !== undefined ? String(radio.channel) : ''),
    txPowerDbm: configValue(lines, ['tx-power']) ?? (radio !== undefined ? String(radio.txPowerDbm) : ''),
    peerKey: '',
    hasPeerKey: hasConfigLine(lines, ['peer-key']),
  };
}

/** Tower form of a Cellular port. */
export function cellTowerFormFrom(device: DeviceSnapshot, port: PortId): CellTowerForm {
  const { lines, view } = radioValues(device, port);
  return {
    port,
    enabled: view?.adminUp ?? !hasConfigLine(lines, ['shutdown']),
    txPowerDbm: configValue(lines, ['tx-power']) ?? (view?.radio !== undefined ? String(view.radio.txPowerDbm) : ''),
  };
}

/** Ports of a device whose effective role is `role`, in port order. */
export function portsWithRole(device: Pick<DeviceSnapshot, 'ports'>, role: NonNullable<PortSnapshot['role']>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.role === role);
}

/**
 * Home router form: the local network is the first switch virtual interface (else `defaultAdapter`), the
 * internet side the first `wan` port, the radios every access radio on a Wi-Fi port. The internet gateway is
 * the next hop of the configured `ip route 0.0.0.0 0.0.0.0 <gateway>` line.
 */
export function homeRouterFormFrom(device: DeviceSnapshot): HomeRouterForm {
  const lanPort = portsWithRole(device, 'svi')[0]?.id ?? defaultAdapter(device) ?? '';
  const wanPort = portsWithRole(device, 'wan')[0]?.id ?? '';
  const route = globalConfigLines(device.runningConfig).find(
    (l) => !l.negate && startsWith(l.tokens, ['ip', 'route', '0.0.0.0', '0.0.0.0']) && l.tokens.length >= 5,
  );
  const radios = device.ports.filter((p) => p.kind === 'wlan' && p.role === 'wireless-bss').map((p) => wirelessApFormFrom(device, p.id));
  return {
    lan: interfaceAddressFrom(device, lanPort),
    wan: { ...(wanPort === '' ? { port: '', address: '', mask: '' } : interfaceAddressFrom(device, wanPort)), gateway: (route?.tokens[4] as string | undefined) ?? '' },
    radios,
  };
}

function toSecurity(v: string | undefined): WifiSecurity {
  return v === 'wpa2-psk' || v === 'wpa3-sae' ? v : 'open';
}

// ── value normalisation ──────────────────────────────────────────────────────

/** Dotted mask for `255.255.255.0`, `/24` or `24` input; undefined when not a contiguous mask of length 1..32. */
export function normalizeMask(text: string): string | undefined {
  const t = text.trim();
  const prefix = /^\/?(\d{1,2})$/.exec(t);
  if (prefix !== null) {
    const len = Number(prefix[1]);
    return len >= 1 && len <= 32 ? prefixLenToMask(len) : undefined;
  }
  const len = maskToPrefixLen(t);
  return len !== null && len >= 1 && parseIpv4(t) !== null ? prefixLenToMask(len) : undefined;
}

/** Canonical dotted address (leading zeros and spaces removed); undefined when invalid. */
export function normalizeIpv4(text: string): string | undefined {
  const v = parseIpv4(text.trim());
  return v === null ? undefined : `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

// ── validators ───────────────────────────────────────────────────────────────

const PRINTABLE = /^[\x20-\x7e]*$/;

/** Error for an IPv4 address input, undefined when valid. */
export function checkIpv4(text: string): string | undefined {
  return normalizeIpv4(text) === undefined ? 'Enter an IPv4 address in dotted form, for example 192.168.1.10.' : undefined;
}

/** Error for a subnet mask input, undefined when valid. */
export function checkMask(text: string): string | undefined {
  if (text.trim() === '') return 'Enter a subnet mask, for example 255.255.255.0 or /24.';
  return normalizeMask(text) === undefined ? 'This is not a valid subnet mask. Use a form such as 255.255.255.0 or /24.' : undefined;
}

/** Error when `address` cannot be given to an interface in the subnet `mask`, undefined when usable. */
export function checkInterfaceAddress(address: string, mask: string): string | undefined {
  const a = normalizeIpv4(address);
  if (a === undefined) return checkIpv4(address);
  const v = parseIpv4(a) as number;
  if (v === 0 || v === 0xffffffff) return 'This address is reserved and cannot be given to an interface.';
  if (v >>> 24 === 127) return 'Addresses starting with 127 are for loopback use only.';
  if (isIpv4Multicast(a) || v >>> 28 === 0xf) return 'This address belongs to a multicast or reserved range; pick a unicast address.';
  const m = normalizeMask(mask);
  if (m === undefined) return undefined;
  const len = maskToPrefixLen(m) as number;
  if (len <= 30) {
    const maskU = prefixLenToMaskU32(len);
    if (((v & ~maskU) >>> 0) === 0) return 'This is the network address of the subnet; pick a host address.';
    if (((v | maskU) >>> 0) === 0xffffffff) return 'This is the broadcast address of the subnet; pick a host address.';
  }
  return undefined;
}

/** Error when `gateway` is not a usable next hop for `address`/`mask`, undefined when valid. */
export function checkGateway(gateway: string, address: string, mask: string): string | undefined {
  const g = normalizeIpv4(gateway);
  if (g === undefined) return checkIpv4(gateway);
  const a = normalizeIpv4(address);
  const m = normalizeMask(mask);
  if (a === undefined || m === undefined) return undefined;
  if (g === a) return 'The gateway must be another device, not this address.';
  const maskU = prefixLenToMaskU32(maskToPrefixLen(m) as number);
  if (((parseIpv4(g) as number) & maskU) >>> 0 !== ((parseIpv4(a) as number) & maskU) >>> 0) {
    return 'The gateway must be in the same subnet as the address.';
  }
  return undefined;
}

/**
 * Whitespace rules shared by free-text values sent as one config line: printable characters, no leading or
 * trailing space and no double spaces (config text folds runs of spaces). `singleToken` also forbids spaces
 * (host shell arguments).
 */
function checkFreeText(text: string, what: string, singleToken: boolean): string | undefined {
  if (!PRINTABLE.test(text)) return `The ${what} may only use plain letters, digits, spaces and punctuation.`;
  if (singleToken && /\s/.test(text)) return `The ${what} cannot contain spaces here.`;
  if (text !== text.trim()) return `The ${what} cannot start or end with a space.`;
  if (/ {2}/.test(text)) return `The ${what} cannot contain two spaces in a row.`;
  return undefined;
}

/** Error for a network name; empty is allowed (the radio stays idle). */
export function checkSsid(ssid: string, singleToken = false): string | undefined {
  if (ssid === '') return undefined;
  if (ssid.length > SSID_MAX) return `A network name can have at most ${SSID_MAX} characters.`;
  return checkFreeText(ssid, 'network name', singleToken);
}

/**
 * Error for a passphrase under `security`. `required` = no stored passphrase can be kept (none configured, or the
 * security mode changes from open).
 */
export function checkPassphrase(security: WifiSecurity, passphrase: string, required: boolean, singleToken = false): string | undefined {
  if (security === 'open') return undefined;
  if (passphrase === '') return required ? 'Enter the password for this secured network.' : undefined;
  if (passphrase.length < PASSPHRASE_MIN || passphrase.length > PASSPHRASE_MAX) {
    return `The password must have between ${PASSPHRASE_MIN} and ${PASSPHRASE_MAX} characters.`;
  }
  return checkFreeText(passphrase, 'password', singleToken);
}

/** Error for a band choice (limited to the radio's bands when its spec is known). */
export function checkBand(band: string, spec?: Pick<RadioPortSpec, 'bands'>): string | undefined {
  if (!(RADIO_BANDS as readonly string[]).includes(band)) return 'Choose a frequency band.';
  if (spec !== undefined && !spec.bands.includes(band as RfBand)) return 'This radio does not support that band.';
  return undefined;
}

/** Error for a channel on `band`; `allowAuto` accepts 'auto'. */
export function checkChannel(band: string, channel: string, allowAuto: boolean): string | undefined {
  const t = channel.trim();
  if (t === 'auto') return allowAuto ? undefined : 'Pick a fixed channel; both radios of a link must use the same one.';
  if (!/^\d+$/.test(t)) return allowAuto ? 'Enter a channel number or choose automatic.' : 'Enter a channel number.';
  if (!(RADIO_BANDS as readonly string[]).includes(band)) return undefined;
  const list = CHANNELS[band as Exclude<RfBand, 'cell'>];
  if (!list.includes(Number(t))) return `Channel ${t} does not exist on the ${BAND_LABELS[band as Exclude<RfBand, 'cell'>]} band.`;
  return undefined;
}

/** Error for a channel width on `band` (60 GHz has a fixed width, so any value passes). */
export function checkWidth(band: string, width: string, spec?: Pick<RadioPortSpec, 'maxWidthMhz'>): string | undefined {
  if (band === '60') return undefined;
  const t = width.trim();
  if (!/^\d+$/.test(t) || !CHANNEL_WIDTHS.includes(Number(t))) return 'Choose a channel width of 20, 40, 80 or 160 MHz.';
  const w = Number(t);
  if (band === '2.4' && w > 40) return 'The 2.4 GHz band allows channel widths of 20 or 40 MHz.';
  if (spec !== undefined && w > spec.maxWidthMhz) return `This radio supports channels up to ${spec.maxWidthMhz} MHz wide.`;
  return undefined;
}

/** Error for a transmit power in whole dBm between 0 and the radio's maximum. */
export function checkTxPower(value: string, spec?: Pick<RadioPortSpec, 'maxTxPowerDbm'>): string | undefined {
  const max = spec?.maxTxPowerDbm ?? DEFAULT_MAX_TX_POWER_DBM;
  const t = value.trim();
  if (!/^\d+$/.test(t) || Number(t) > max) return `Enter a transmit power from 0 to ${max} dBm.`;
  return undefined;
}

/** Error for a pairing key; empty is allowed (keep the stored key). */
export function checkPeerKey(key: string): string | undefined {
  if (key === '') return undefined;
  if (key.length > PEER_KEY_MAX) return `A pairing key can have at most ${PEER_KEY_MAX} characters.`;
  return checkFreeText(key, 'pairing key', false);
}

function put(errors: FormErrors, field: string, message: string | undefined): void {
  if (message !== undefined && errors[field] === undefined) errors[field] = message;
}

/** True when `errors` holds at least one message. */
export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Validation context of an IP configuration form. */
export interface IpConfigContext {
  grammar: CliGrammar;
  /** The adapter the host shell's `ip address` line sets (`defaultAdapter`). */
  defaultAdapter?: PortId;
}

/**
 * Validate an IP configuration. All three fields empty clears the address. With the host grammar only the
 * default adapter can be set, and a gateway needs an address.
 */
export function validateIpConfigForm(form: IpConfigForm, ctx: IpConfigContext): FormErrors {
  const errors: FormErrors = {};
  const address = form.address.trim();
  const mask = form.mask.trim();
  const gateway = form.gateway.trim();
  if (ctx.grammar === 'host' && ctx.defaultAdapter !== undefined && form.adapter !== ctx.defaultAdapter) {
    put(errors, 'adapter', `Only the main adapter (${ctx.defaultAdapter}) can be set from this panel.`);
  }
  if (address === '' && mask === '' && gateway === '') return errors;
  if (address === '') {
    put(errors, 'address', ctx.grammar === 'host' && gateway !== '' && mask === '' ? 'A gateway needs an address and mask on this device.' : 'Enter an address, or clear every field to remove it.');
  } else {
    put(errors, 'address', checkInterfaceAddress(address, mask));
  }
  if (address !== '' || mask !== '') put(errors, 'mask', checkMask(mask));
  if (gateway !== '') put(errors, 'gateway', address === '' ? undefined : checkGateway(gateway, address, mask));
  return errors;
}

/** Validate an interface address; both fields empty removes the address. `prefix` is prepended to field keys. */
export function validateInterfaceAddressForm(form: InterfaceAddressForm, prefix = ''): FormErrors {
  const errors: FormErrors = {};
  const address = form.address.trim();
  const mask = form.mask.trim();
  if (address === '' && mask === '') return errors;
  put(errors, `${prefix}address`, address === '' ? 'Enter an address, or clear both fields to remove it.' : checkInterfaceAddress(address, mask));
  put(errors, `${prefix}mask`, checkMask(mask));
  return errors;
}

/**
 * Validate an access-point radio. `previous` is the baseline the panel loaded (a passphrase is required when none
 * is stored or the mode changes from open); `spec` is the port's RadioPortSpec from the catalog when known.
 */
export function validateWirelessApForm(form: WirelessApForm, previous?: WirelessApForm, spec?: RadioPortSpec, prefix = ''): FormErrors {
  const errors: FormErrors = {};
  put(errors, `${prefix}ssid`, checkSsid(form.ssid));
  const required = !form.hasPassphrase || previous === undefined || previous.security === 'open';
  put(errors, `${prefix}passphrase`, checkPassphrase(form.security, form.passphrase, required));
  put(errors, `${prefix}band`, checkBand(form.band, spec));
  put(errors, `${prefix}channel`, checkChannel(form.band, form.channel, true));
  put(errors, `${prefix}widthMhz`, checkWidth(form.band, form.widthMhz, spec));
  put(errors, `${prefix}txPowerDbm`, checkTxPower(form.txPowerDbm, spec));
  return errors;
}

/**
 * Validate a station form. On the host grammar the network name and password are single words, WPA3 cannot be
 * requested, and a secured network always needs the password re-entered (joining sends it again).
 */
export function validateWifiClientForm(form: WifiClientForm, grammar: CliGrammar, previous?: WifiClientForm): FormErrors {
  const errors: FormErrors = {};
  const host = grammar === 'host';
  put(errors, 'ssid', checkSsid(form.ssid, host));
  if (form.ssid === '') return errors;
  if (host && form.security === 'wpa3-sae') put(errors, 'security', 'This device can join open or WPA2 networks only.');
  const changed = previous === undefined || previous.ssid !== form.ssid || previous.security !== form.security;
  const required = host ? form.security !== 'open' && (changed || form.passphrase === '') : !form.hasPassphrase || previous === undefined || previous.security === 'open';
  put(errors, 'passphrase', checkPassphrase(form.security, form.passphrase, required, host));
  return errors;
}

/** Validate a point-to-point radio form. */
export function validateRadioLinkForm(form: RadioLinkForm, spec?: RadioPortSpec): FormErrors {
  const errors: FormErrors = {};
  put(errors, 'band', checkBand(form.band, spec));
  put(errors, 'channel', checkChannel(form.band, form.channel, false));
  put(errors, 'txPowerDbm', checkTxPower(form.txPowerDbm, spec));
  put(errors, 'peerKey', checkPeerKey(form.peerKey));
  return errors;
}

/** Validate a tower form. */
export function validateCellTowerForm(form: CellTowerForm, spec?: RadioPortSpec): FormErrors {
  const errors: FormErrors = {};
  put(errors, 'txPowerDbm', checkTxPower(form.txPowerDbm, spec));
  return errors;
}

/** Validate a home router form; `specs` maps radio ports to their RadioPortSpec. */
export function validateHomeRouterForm(form: HomeRouterForm, previous?: HomeRouterForm, specs: Readonly<Record<PortId, RadioPortSpec>> = {}): FormErrors {
  const errors: FormErrors = { ...validateInterfaceAddressForm(form.lan, 'lan.') };
  if (form.lan.address.trim() === '' && form.lan.mask.trim() === '') put(errors, 'lan.address', 'The local network needs an address.');
  Object.assign(errors, validateInterfaceAddressForm(form.wan, 'wan.'));
  const gateway = form.wan.gateway.trim();
  if (gateway !== '') {
    if (form.wan.address.trim() === '') put(errors, 'wan.gateway', 'Set the internet address before its gateway.');
    else put(errors, 'wan.gateway', checkGateway(gateway, form.wan.address, form.wan.mask));
  }
  form.radios.forEach((radio, i) => {
    const before = previous?.radios.find((r) => r.port === radio.port);
    for (const [k, v] of Object.entries(validateWirelessApForm(radio, before, specs[radio.port], `radios.${i}.`))) put(errors, k, v);
  });
  return errors;
}

// ── configure result mapping ─────────────────────────────────────────────────

/** What a panel shows after `configure` returned. */
export interface SubmitOutcome {
  readonly ok: boolean;
  /** Atomic run reverted every applied line. */
  readonly reverted: boolean;
  /** Messages next to the fields that produced the failing lines. */
  readonly fieldErrors: FormErrors;
  /** Messages for failing lines that belong to no single field. */
  readonly general: readonly string[];
  /** Lines not run because an earlier line failed. */
  readonly skipped: number;
}

/** Console error text without the leading `% ` marker. */
export function cleanCliMessage(message: string): string {
  return message.replace(/^%\s*/, '').trim();
}

/**
 * Field of plan line `index` for an error at `column` (0-based token start). Columns are matched against the
 * sent text first and against the text without its indentation second, so either caret convention resolves to
 * the same token. Without a column the line's first field is used. Null = the line belongs to no field.
 */
export function fieldAt(plan: CommandPlan, index: number, column?: number): string | null {
  const line = plan.lines[index];
  if (line === undefined) return null;
  const firstField = line.spans.find((s) => s.field !== null)?.field ?? null;
  if (column === undefined) return firstField;
  const raw = line.spans.find((s) => column >= s.start && column < s.end);
  if (raw !== undefined && column === raw.start) return raw.field ?? firstField;
  const trimmed = line.spans.find((s) => column === s.start - line.indent);
  if (trimmed !== undefined) return trimmed.field ?? firstField;
  if (raw !== undefined) return raw.field ?? firstField;
  const shifted = line.spans.find((s) => column + line.indent >= s.start && column + line.indent < s.end);
  if (shifted !== undefined) return shifted.field ?? firstField;
  return firstField;
}

/** Map a `ConfigureResult` of `plan` onto form fields (the first message per field wins). */
export function mapConfigureResult(plan: CommandPlan, result: ConfigureResult): SubmitOutcome {
  const fieldErrors: FormErrors = {};
  const general: string[] = [];
  let skipped = 0;
  for (const line of result.lines) {
    if (line.skipped === true) {
      skipped++;
      continue;
    }
    if (line.ok) continue;
    const message = cleanCliMessage(line.error?.message ?? line.output) || 'The device refused this setting.';
    const field = fieldAt(plan, line.index, line.error?.column);
    if (field === null) general.push(`${line.line.trim()}: ${message}`);
    else put(fieldErrors, field, message);
  }
  if (!result.ok && general.length === 0 && Object.keys(fieldErrors).length === 0) {
    general.push('The device did not accept these settings.');
  }
  return Object.freeze({ ok: result.ok, reverted: result.reverted === true, fieldErrors, general: Object.freeze(general), skipped });
}
