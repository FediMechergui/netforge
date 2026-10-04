/**
 * protocols/ppp/config.ts — what the ppp daemon reads from the running configuration, and the FNV-derived values it
 * sends [S19] (ARCHITECTURE-P3 D17, §3.9, §4.1, §5.7; §7 W3 wan).
 *
 * Configuration (§5.7), read at call time from the stored lines (`configTextLinesOf`, so a group key or a stored
 * negation reads the same as typed text):
 *   - under `interface <serial>`: `ppp authentication chap|pap [chap|pap]` (the order of preference this end asks of
 *     its peer); `ppp pap sent-username <n> password <pw>` (what this end sends when the peer asks for PAP);
 *     `keepalive [<s>]` / `no keepalive` (the LCP echo period, read with the hdlc reader: default 10 s, 0 = off);
 *     `peer neighbor-route` (the default) / `no peer neighbor-route`; `ip address <a> <m>` (IPCP runs while the port
 *     has a primary IPv4 address); `ipv6 enable` / `ipv6 address …` (IPv6CP runs while either is stored), with
 *     `ipv6 address <fe80::…> link-local` giving the interface identifier;
 *   - globally: `username <n> password <pw>` — the password CHAP hashes and PAP compares. A password is stored in the
 *     clear or as `nf7 <hex>` (under `service password-encryption`); a `secret` entry is a one-way hash and cannot be
 *     used by CHAP or PAP, exactly as on real devices (D17).
 *
 * Derived values (§4.1, no rng draw): the magic number of an LCP negotiation and the 16 bytes of a CHAP challenge are
 * FNV-1a (`macHash32`, the `fnv1a32` of contracts/addr.ts) over the device id, the port and a per-process counter.
 *
 * Pure: no module state, no randomness, no clock.
 */
import { isIpv4, macHash32, type Ipv4Address, type MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { DeviceId, PortId } from '../../contracts/ids.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { decodeReversibleSecret, SECRET_HASH_TAG, SECRET_REVERSIBLE_TAG } from '../../cli/secrets.js';
import { eui64InterfaceId, ipv6ToBytes, isIpv6 } from '../../core/addr6.js';
import { keepaliveIntervalFromConfig } from '../hdlc.js';

/** An authentication protocol of `ppp authentication`. */
export type PppAuthProtocol = 'chap' | 'pap';

/** The PPP lines of one serial interface, parsed. */
export interface PppPortConfig {
  /** `ppp authentication …`: what this end asks of its peer, in order of preference; empty = no authentication. */
  readonly auth: readonly PppAuthProtocol[];
  /** `ppp pap sent-username <n> password <pw>`: the name this end sends to a PAP authenticator. */
  readonly papUser?: string;
  /** The password of `ppp pap sent-username` (decoded from `nf7` when stored that way). */
  readonly papPassword?: string;
  /** The LCP echo period (`keepalive`; 0 = no echoes). */
  readonly keepaliveNs: SimTime;
  /** `peer neighbor-route` (default true; `no peer neighbor-route` stores false). */
  readonly neighborRoute: boolean;
  /** The primary IPv4 address of the port (`ip address <a> <m>`); IPCP runs only while it is set. */
  readonly ipv4?: Ipv4Address;
  /** IPv6 is configured on the port (`ipv6 enable` or any `ipv6 address`); IPv6CP runs only while it is. */
  readonly ipv6: boolean;
  /** A manual link-local address (`ipv6 address <fe80::…> link-local`): its low 64 bits are the interface id. */
  readonly linkLocal?: string;
}

/** The stored lines of `interface <port>` (non-negated and negated), in stored order. */
function interfaceLines(config: ConfigAst, port: PortId): { tokens: string[]; negate: boolean }[] {
  const out: { tokens: string[]; negate: boolean }[] = [];
  for (const l of configTextLinesOf(config.root)) {
    const head = l.context[0];
    if (l.context.length !== 1 || head?.[0] !== 'interface' || head[1] !== port) continue;
    out.push({ tokens: l.tokens, negate: l.negate });
  }
  return out;
}

/** The plain text of a stored password (the tokens after `password`): clear text, or `nf7 <hex>`; undefined for a hash. */
export function pppStoredPassword(tokens: readonly string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  const first = tokens[0] as string;
  if (tokens.length === 2 && first === SECRET_REVERSIBLE_TAG) return decodeReversibleSecret(`${SECRET_REVERSIBLE_TAG}$${tokens[1] as string}`) ?? undefined;
  if (tokens.length === 2 && first === SECRET_HASH_TAG) return undefined;
  const joined = tokens.join(' ');
  if (/^(nf1|nf7)\$[0-9a-fA-F]+$/.test(joined)) return joined.startsWith(SECRET_REVERSIBLE_TAG) ? (decodeReversibleSecret(joined) ?? undefined) : undefined;
  return joined;
}

/** Parse the PPP lines of `interface <port>` (see the file header). */
export function readPppPortConfig(config: ConfigAst, port: PortId): PppPortConfig {
  let auth: PppAuthProtocol[] = [];
  let papUser: string | undefined;
  let papPassword: string | undefined;
  let neighborRoute = true;
  let ipv4: Ipv4Address | undefined;
  let ipv6 = false;
  let linkLocal: string | undefined;
  for (const { tokens: t, negate } of interfaceLines(config, port)) {
    if (t[0] === 'peer' && t[1] === 'neighbor-route') {
      neighborRoute = !negate;
      continue;
    }
    if (negate) continue;
    if (t[0] === 'ppp' && t[1] === 'authentication') {
      auth = [];
      for (const p of t.slice(2)) if ((p === 'chap' || p === 'pap') && !auth.includes(p)) auth.push(p);
    } else if (t[0] === 'ppp' && t[1] === 'pap' && t[2] === 'sent-username' && t[3] !== undefined && t[4] === 'password') {
      papUser = t[3];
      papPassword = pppStoredPassword(t.slice(5));
    } else if (t[0] === 'ip' && t[1] === 'address' && t[2] !== undefined && isIpv4(t[2]) && t[3] !== undefined && t[4] === undefined) {
      ipv4 = t[2];
    } else if (t[0] === 'ip' && t[1] === 'address' && t[2] === 'dhcp') {
      ipv4 = undefined;
    } else if (t[0] === 'ipv6' && (t[1] === 'enable' || t[1] === 'address')) {
      ipv6 = true;
      if (t[1] === 'address' && t[3] === 'link-local' && t[2] !== undefined && isIpv6(t[2])) linkLocal = t[2];
    }
  }
  const out: { -readonly [K in keyof PppPortConfig]: PppPortConfig[K] } = { auth, keepaliveNs: keepaliveIntervalFromConfig(config, port), neighborRoute, ipv6 };
  if (papUser !== undefined) out.papUser = papUser;
  if (papPassword !== undefined) out.papPassword = papPassword;
  if (ipv4 !== undefined) out.ipv4 = ipv4;
  if (linkLocal !== undefined) out.linkLocal = linkLocal;
  return out;
}

/** Equality of two parsed port configurations (every member). */
export function samePppPortConfig(a: PppPortConfig, b: PppPortConfig): boolean {
  return (
    a.auth.join(' ') === b.auth.join(' ') && a.papUser === b.papUser && a.papPassword === b.papPassword && a.keepaliveNs === b.keepaliveNs &&
    a.neighborRoute === b.neighborRoute && a.ipv4 === b.ipv4 && a.ipv6 === b.ipv6 && a.linkLocal === b.linkLocal
  );
}

/**
 * The password of `username <user> password <pw>` (global), the shared secret of CHAP and the password PAP compares;
 * undefined when the user has no entry or only a `secret` (one-way hash) entry. The last entry for a user wins.
 */
export function pppUserPassword(config: ConfigAst, user: string): string | undefined {
  let out: string | undefined;
  for (const n of config.root.children) {
    if (n.key !== 'username' || n.args[0] !== user) continue;
    const at = n.args.indexOf('password', 1);
    out = at < 0 ? undefined : pppStoredPassword(n.args.slice(at + 1));
  }
  return out;
}

/** Sixteen lower-case hex digits of an 8-byte interface identifier. */
function hex8(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * The IPv6CP interface identifier of a port (16 hex digits): the low 64 bits of the configured link-local address, else
 * the modified EUI-64 of the port MAC (the identifier the automatic link-local address uses).
 */
export function pppInterfaceId(mac: MacAddress, linkLocal?: string): string {
  if (linkLocal !== undefined && isIpv6(linkLocal)) return hex8(ipv6ToBytes(linkLocal).subarray(8, 16));
  return hex8(eui64InterfaceId(mac));
}

/** The FNV-1a word of (device, port, purpose, counter, word index): the §4.1 derivation. */
function fnvWord(device: DeviceId, port: PortId, purpose: string, counter: number, word: number): number {
  return macHash32(`${device}\u0000${port}\u0000${purpose}\u0000${counter}\u0000${word}`);
}

/** The LCP magic number of one negotiation (never 0, RFC 1661 §6.4). */
export function pppMagicNumber(device: DeviceId, port: PortId, counter: number): number {
  const m = fnvWord(device, port, 'magic', counter, 0);
  return m === 0 ? 1 : m;
}

/** The 16 bytes of one CHAP challenge (four FNV-1a words, big-endian). */
export function pppChallengeValue(device: DeviceId, port: PortId, counter: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let w = 0; w < 4; w++) {
    const v = fnvWord(device, port, 'chap', counter, w);
    out[w * 4] = (v >>> 24) & 0xff;
    out[w * 4 + 1] = (v >>> 16) & 0xff;
    out[w * 4 + 2] = (v >>> 8) & 0xff;
    out[w * 4 + 3] = v & 0xff;
  }
  return out;
}
