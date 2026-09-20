/**
 * GUI command builders: pure functions that turn settings forms into the canonical configuration lines of
 * ARCHITECTURE-P1 §6, ready for `EngineApi.configure` (D9: GUI panels never bypass validation; §3.12
 * "GUI panels → pure line builders").
 *
 * A builder compares the edited form with the baseline the panel loaded (`previous`) and emits only the lines
 * that change something, in an order that keeps every intermediate state valid (shut a radio before retuning,
 * bring it up last; band before channel; remove an old route before adding the new one). Without a baseline it
 * emits every non-empty value.
 *
 * Plans carry, for every line, which form field each token came from, so forms.ts `mapConfigureResult` can put a
 * caret error next to the right input. nfos plans use pasted-config indentation (`interface X` at depth 0, its
 * lines one space deeper) and run atomically; host-shell plans are flat and also atomic.
 *
 * Lines written here (all from the rule table in cli/config-rules.ts):
 *   interface <port> / shutdown / no shutdown / ip address A M / no ip address
 *   ssid <rest> / no ssid / security <mode> / passphrase <rest> / no passphrase / band <b> / channel <n>|auto /
 *   channel-width <mhz> / tx-power <dbm> / peer-key <rest>
 *   ip default-gateway <gw> / no ip default-gateway / ip route 0.0.0.0 0.0.0.0 <gw> / no ip route …
 *   host shell: ip address A M [GW] / no ip address / adapter <if> up|down / wifi connect <ssid> [key <pass>] /
 *   wifi disconnect
 */
import type { CliGrammar, ConfigureOptions, PortId } from '@netforge/engine';
import { normalizeIpv4, normalizeMask } from './forms.js';
import type { CellTowerForm, HomeRouterForm, InterfaceAddressForm, IpConfigForm, RadioLinkForm, WifiClientForm, WirelessApForm } from './forms.js';

// ── plans ────────────────────────────────────────────────────────────────────

/** The form field a run of characters of a plan line came from. */
export interface FieldSpan {
  /** 0-based start column in the sent line text (indentation included). */
  readonly start: number;
  /** Exclusive end column. */
  readonly end: number;
  /** Field key, or null for tokens that belong to no field. */
  readonly field: string | null;
}

/** One sent line with its field spans. */
export interface PlanLine {
  readonly text: string;
  /** Leading spaces (pasted-config depth). */
  readonly indent: number;
  readonly spans: readonly FieldSpan[];
}

/** Lines for one `configure` call. */
export interface CommandPlan {
  readonly grammar: CliGrammar;
  /** `EngineApi.configure` commands (= `lines[i].text`). */
  readonly commands: readonly string[];
  readonly lines: readonly PlanLine[];
  readonly options: ConfigureOptions;
}

/** Configure options panels use per grammar: nfos pastes indented sections, both grammars apply all or nothing. */
export const PANEL_CONFIGURE_OPTIONS: Readonly<Record<CliGrammar, Readonly<ConfigureOptions>>> = Object.freeze({
  nfos: Object.freeze({ indentation: true, stopOnError: true, atomic: true }),
  host: Object.freeze({ stopOnError: true, atomic: true }),
});

/** One token of a line and the field it belongs to. */
export type Token = readonly [text: string, field: string | null];

function makeLine(tokens: readonly Token[], indent: number): PlanLine {
  const spans: FieldSpan[] = [];
  let text = ' '.repeat(indent);
  tokens.forEach(([t, f], i) => {
    if (i > 0) text += ' ';
    const start = text.length;
    text += t;
    spans.push(Object.freeze({ start, end: text.length, field: f }));
  });
  return Object.freeze({ text, indent, spans: Object.freeze(spans) });
}

function plan(grammar: CliGrammar, lines: readonly PlanLine[]): CommandPlan {
  return Object.freeze({
    grammar,
    commands: Object.freeze(lines.map((l) => l.text)),
    lines: Object.freeze([...lines]),
    options: PANEL_CONFIGURE_OPTIONS[grammar],
  });
}

/** Builder of one plan. Sections exist only in the nfos grammar. */
class PlanBuilder {
  private readonly lines: PlanLine[] = [];
  constructor(private readonly grammar: CliGrammar) {}

  /** A top-level line. */
  global(tokens: readonly Token[]): this {
    this.lines.push(makeLine(tokens, 0));
    return this;
  }

  /** `interface <port>` followed by its lines one level deeper; nothing when there are no child lines. */
  section(port: PortId, children: readonly (readonly Token[])[]): this {
    if (children.length === 0) return this;
    if (this.grammar !== 'nfos') throw new RangeError('Interface sections exist only in the nfos grammar.');
    this.lines.push(makeLine([['interface', null], [port, null]], 0));
    for (const c of children) this.lines.push(makeLine(c, 1));
    return this;
  }

  build(): CommandPlan {
    return plan(this.grammar, this.lines);
  }
}

/** A plan without lines. */
export function emptyPlan(grammar: CliGrammar): CommandPlan {
  return plan(grammar, []);
}

/** True when the plan sends nothing (the panel can skip `configure`). */
export function isEmptyPlan(p: CommandPlan): boolean {
  return p.lines.length === 0;
}

/** Concatenate plans of one grammar into a single `configure` call. */
export function mergePlans(grammar: CliGrammar, plans: readonly CommandPlan[]): CommandPlan {
  const lines: PlanLine[] = [];
  for (const p of plans) {
    if (p.grammar !== grammar) throw new RangeError(`Cannot merge a ${p.grammar} plan into a ${grammar} plan.`);
    lines.push(...p.lines);
  }
  return plan(grammar, lines);
}

/** Tokens of a free-text value (`ssid My home`), all attributed to `field`. */
function words(text: string, field: string): Token[] {
  return text.split(' ').filter((w) => w !== '').map((w) => [w, field] as const);
}

/** A literal keyword line with every token attributed to `field` (`band 5`). */
function kv(keyword: string, value: string, field: string): Token[] {
  return [[keyword, field], ...words(value, field)];
}

function field(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

// ── port admin state ─────────────────────────────────────────────────────────

/**
 * Shut or enable a port (PortInspector toggle; ARCHITECTURE-P1 §3.12): nfos `interface X` + `[no] shutdown`, host
 * shell `adapter X up|down`. Field `enabled`.
 */
export function portAdminCommands(grammar: CliGrammar, port: PortId, up: boolean): CommandPlan {
  const b = new PlanBuilder(grammar);
  if (grammar === 'host') b.global([['adapter', 'enabled'], [port, 'enabled'], [up ? 'up' : 'down', 'enabled']]);
  else b.section(port, [up ? [['no', 'enabled'], ['shutdown', 'enabled']] : [['shutdown', 'enabled']]]);
  return b.build();
}

// ── addresses ────────────────────────────────────────────────────────────────

interface AddressValue {
  address: string;
  mask: string;
}

function addressValue(form: Pick<InterfaceAddressForm, 'address' | 'mask'> | undefined): AddressValue | undefined {
  if (form === undefined) return undefined;
  const address = normalizeIpv4(form.address) ?? form.address.trim();
  const mask = normalizeMask(form.mask) ?? form.mask.trim();
  return address === '' && mask === '' ? { address: '', mask: '' } : { address, mask };
}

function sameAddress(a: AddressValue | undefined, b: AddressValue | undefined): boolean {
  return a !== undefined && b !== undefined && a.address === b.address && a.mask === b.mask;
}

function gatewayValue(text: string | undefined): string {
  if (text === undefined) return '';
  return normalizeIpv4(text) ?? text.trim();
}

/** Interface lines for an address change (`ip address A M` or `no ip address`), field keys under `prefix`. */
function addressLines(next: AddressValue, previous: AddressValue | undefined, prefix: string): Token[][] {
  if (sameAddress(next, previous)) return [];
  if (next.address === '') {
    return previous !== undefined && previous.address !== '' ? [[['no', field(prefix, 'address')], ['ip', field(prefix, 'address')], ['address', field(prefix, 'address')]]] : [];
  }
  const a = field(prefix, 'address');
  return [[['ip', a], ['address', a], [next.address, a], [next.mask, field(prefix, 'mask')]]];
}

/**
 * IP configuration of an adapter.
 *  - nfos: `interface <adapter>` + `ip address A M` / `no ip address`, then global `ip default-gateway GW` /
 *    `no ip default-gateway` (switch and AP management addresses, §6).
 *  - host: `ip address A M [GW]` on the default adapter; clearing the address or only the gateway sends
 *    `no ip address` first (the host line never removes a gateway on its own).
 * `defaultAdapter` is required for the host grammar; a different adapter throws (validate the form first).
 */
export function ipConfigCommands(grammar: CliGrammar, next: IpConfigForm, previous?: IpConfigForm, defaultAdapter?: PortId): CommandPlan {
  const b = new PlanBuilder(grammar);
  const nextAddr = addressValue(next) as AddressValue;
  const prevAddr = addressValue(previous);
  const nextGw = gatewayValue(next.gateway);
  const prevGw = previous === undefined ? undefined : gatewayValue(previous.gateway);

  if (grammar === 'host') {
    if (defaultAdapter === undefined || next.adapter !== defaultAdapter) {
      throw new RangeError(`The host shell sets only the default adapter${defaultAdapter === undefined ? '' : ` (${defaultAdapter})`}.`);
    }
    const unchanged = sameAddress(nextAddr, prevAddr) && nextGw === prevGw;
    if (unchanged) return b.build();
    const hadSomething = previous !== undefined && (prevAddr?.address !== '' || prevGw !== '');
    if (nextAddr.address === '') {
      if (hadSomething) b.global([['no', 'address'], ['ip', 'address'], ['address', 'address']]);
      return b.build();
    }
    const gatewayRemoved = prevGw !== undefined && prevGw !== '' && nextGw === '';
    if (gatewayRemoved) b.global([['no', 'gateway'], ['ip', 'gateway'], ['address', 'gateway']]);
    const tokens: Token[] = [['ip', 'address'], ['address', 'address'], [nextAddr.address, 'address'], [nextAddr.mask, 'mask']];
    if (nextGw !== '') tokens.push([nextGw, 'gateway']);
    b.global(tokens);
    return b.build();
  }

  b.section(next.adapter, addressLines(nextAddr, prevAddr, ''));
  if (nextGw !== (prevGw ?? '')) {
    if (nextGw === '') b.global([['no', 'gateway'], ['ip', 'gateway'], ['default-gateway', 'gateway']]);
    else b.global([['ip', 'gateway'], ['default-gateway', 'gateway'], [nextGw, 'gateway']]);
  }
  return b.build();
}

/** Address of one nfos interface (`ip address A M` / `no ip address`), field keys under `prefix`. */
export function interfaceAddressCommands(next: InterfaceAddressForm, previous?: InterfaceAddressForm, prefix = ''): CommandPlan {
  return new PlanBuilder('nfos').section(next.port, addressLines(addressValue(next) as AddressValue, addressValue(previous), prefix)).build();
}

// ── radios ───────────────────────────────────────────────────────────────────

function changed(next: string, previous: string | undefined): boolean {
  return previous === undefined ? next.trim() !== '' : next.trim() !== previous.trim();
}

/** `shutdown` first when disabling; `no shutdown` is added by the caller last when enabling. */
function adminChange(next: boolean, previous: boolean | undefined): 'down' | 'up' | undefined {
  if (previous === undefined) return next ? 'up' : 'down';
  if (next === previous) return undefined;
  return next ? 'up' : 'down';
}

/**
 * Access-point radio lines inside `interface <port>` (nfos grammar: APs and home routers). Order: `shutdown` when
 * disabling, band, channel, channel-width (not on 60 GHz), tx-power, ssid, security, passphrase, `no shutdown`
 * when enabling. Choosing open security removes a stored passphrase. Field keys under `prefix`.
 */
export function wirelessApLines(next: WirelessApForm, previous?: WirelessApForm, prefix = ''): Token[][] {
  const out: Token[][] = [];
  const admin = adminChange(next.enabled, previous?.enabled);
  const en = field(prefix, 'enabled');
  if (admin === 'down') out.push([['shutdown', en]]);
  if (changed(next.band, previous?.band)) out.push(kv('band', next.band.trim(), field(prefix, 'band')));
  if (changed(next.channel, previous?.channel) || (previous !== undefined && next.band.trim() !== previous.band.trim() && next.channel.trim() !== '')) {
    out.push(kv('channel', next.channel.trim(), field(prefix, 'channel')));
  }
  if (next.band.trim() !== '60' && changed(next.widthMhz, previous?.widthMhz)) out.push(kv('channel-width', next.widthMhz.trim(), field(prefix, 'widthMhz')));
  if (changed(next.txPowerDbm, previous?.txPowerDbm)) out.push(kv('tx-power', next.txPowerDbm.trim(), field(prefix, 'txPowerDbm')));
  const ssid = field(prefix, 'ssid');
  if (next.ssid === '') {
    if (previous !== undefined && previous.ssid !== '') out.push([['no', ssid], ['ssid', ssid]]);
  } else if (previous === undefined || previous.ssid !== next.ssid) {
    out.push([['ssid', ssid], ...words(next.ssid, ssid)]);
  }
  const sec = field(prefix, 'security');
  if (previous === undefined || previous.security !== next.security) out.push([['security', sec], [next.security, sec]]);
  const pass = field(prefix, 'passphrase');
  if (next.security === 'open') {
    if (previous?.security !== 'open' && (next.hasPassphrase || (previous?.hasPassphrase ?? false))) out.push([['no', pass], ['passphrase', pass]]);
  } else if (next.passphrase !== '') {
    out.push([['passphrase', pass], ...words(next.passphrase, pass)]);
  }
  if (admin === 'up') out.push([['no', en], ['shutdown', en]]);
  return out;
}

/** Plan for one access-point radio. */
export function wirelessApCommands(next: WirelessApForm, previous?: WirelessApForm, prefix = ''): CommandPlan {
  return new PlanBuilder('nfos').section(next.port, wirelessApLines(next, previous, prefix)).build();
}

/**
 * Station radio (Desktop Wi-Fi app).
 *  - host: `wifi connect <ssid> [key <pass>]` (key sent for any secured mode; the shell picks WPA3 or WPA2 from
 *    the security the network advertises) or
 *    `wifi disconnect`. A secured network without a typed password throws (validate the form first).
 *  - nfos: `interface <port>` with ssid / security / passphrase lines.
 */
export function wifiClientCommands(grammar: CliGrammar, next: WifiClientForm, previous?: WifiClientForm): CommandPlan {
  const b = new PlanBuilder(grammar);
  if (grammar === 'host') {
    if (next.ssid === '') {
      if (previous !== undefined && previous.ssid !== '') b.global([['wifi', 'ssid'], ['disconnect', 'ssid']]);
      return b.build();
    }
    const same = previous !== undefined && previous.ssid === next.ssid && previous.security === next.security && next.passphrase === '';
    if (same) return b.build();
    const tokens: Token[] = [['wifi', 'ssid'], ['connect', 'ssid'], [next.ssid, 'ssid']];
    if (next.security !== 'open') {
      if (next.passphrase === '') throw new RangeError('Joining a secured network from the host shell needs the password.');
      tokens.push(['key', 'passphrase'], [next.passphrase, 'passphrase']);
    }
    return b.global(tokens).build();
  }
  const lines: Token[][] = [];
  if (next.ssid === '') {
    if (previous !== undefined && previous.ssid !== '') lines.push([['no', 'ssid'], ['ssid', 'ssid']]);
  } else if (previous === undefined || previous.ssid !== next.ssid) {
    lines.push([['ssid', 'ssid'], ...words(next.ssid, 'ssid')]);
  }
  if (next.ssid !== '' && (previous === undefined || previous.security !== next.security)) lines.push([['security', 'security'], [next.security, 'security']]);
  if (next.ssid !== '') {
    if (next.security === 'open') {
      if (previous?.security !== 'open' && (next.hasPassphrase || (previous?.hasPassphrase ?? false))) lines.push([['no', 'passphrase'], ['passphrase', 'passphrase']]);
    } else if (next.passphrase !== '') {
      lines.push([['passphrase', 'passphrase'], ...words(next.passphrase, 'passphrase')]);
    }
  }
  return b.section(next.port, lines).build();
}

/**
 * Point-to-point radio lines inside `interface <port>`: `shutdown` when disabling, band, channel, tx-power,
 * peer-key (only when typed), `no shutdown` when enabling.
 */
export function radioLinkCommands(next: RadioLinkForm, previous?: RadioLinkForm): CommandPlan {
  const lines: Token[][] = [];
  const admin = adminChange(next.enabled, previous?.enabled);
  if (admin === 'down') lines.push([['shutdown', 'enabled']]);
  if (changed(next.band, previous?.band)) lines.push(kv('band', next.band.trim(), 'band'));
  if (changed(next.channel, previous?.channel) || (previous !== undefined && next.band.trim() !== previous.band.trim() && next.channel.trim() !== '')) {
    lines.push(kv('channel', next.channel.trim(), 'channel'));
  }
  if (changed(next.txPowerDbm, previous?.txPowerDbm)) lines.push(kv('tx-power', next.txPowerDbm.trim(), 'txPowerDbm'));
  if (next.peerKey !== '') lines.push([['peer-key', 'peerKey'], ...words(next.peerKey, 'peerKey')]);
  if (admin === 'up') lines.push([['no', 'enabled'], ['shutdown', 'enabled']]);
  return new PlanBuilder('nfos').section(next.port, lines).build();
}

/** Tower radio lines inside `interface <port>`: `shutdown` when disabling, tx-power, `no shutdown` when enabling. */
export function cellTowerCommands(next: CellTowerForm, previous?: CellTowerForm): CommandPlan {
  const lines: Token[][] = [];
  const admin = adminChange(next.enabled, previous?.enabled);
  if (admin === 'down') lines.push([['shutdown', 'enabled']]);
  if (changed(next.txPowerDbm, previous?.txPowerDbm)) lines.push(kv('tx-power', next.txPowerDbm.trim(), 'txPowerDbm'));
  if (admin === 'up') lines.push([['no', 'enabled'], ['shutdown', 'enabled']]);
  return new PlanBuilder('nfos').section(next.port, lines).build();
}

// ── home router ──────────────────────────────────────────────────────────────

/**
 * Home router setup (nfos grammar, GUI-only device): local network address (field keys `lan.*`), internet address
 * (`wan.*`), the default route towards the internet gateway (`wan.gateway`; the old route is removed first), then
 * each radio (`radios.<i>.*`, paired with the baseline by port).
 */
export function homeRouterCommands(next: HomeRouterForm, previous?: HomeRouterForm): CommandPlan {
  const b = new PlanBuilder('nfos');
  b.section(next.lan.port, addressLines(addressValue(next.lan) as AddressValue, addressValue(previous?.lan), 'lan.'));
  if (next.wan.port !== '') b.section(next.wan.port, addressLines(addressValue(next.wan) as AddressValue, addressValue(previous?.wan), 'wan.'));
  const nextGw = gatewayValue(next.wan.gateway);
  const prevGw = gatewayValue(previous?.wan.gateway);
  if (nextGw !== prevGw) {
    const g = 'wan.gateway';
    if (prevGw !== '') b.global([['no', g], ['ip', g], ['route', g], ['0.0.0.0', g], ['0.0.0.0', g], [prevGw, g]]);
    if (nextGw !== '') b.global([['ip', g], ['route', g], ['0.0.0.0', g], ['0.0.0.0', g], [nextGw, g]]);
  }
  next.radios.forEach((radio, i) => {
    const before = previous?.radios.find((r) => r.port === radio.port);
    b.section(radio.port, wirelessApLines(radio, before, `radios.${i}.`));
  });
  return b.build();
}
