/**
 * protocols/ike/config.ts — the [C13] crypto sections as the ike daemon reads them (ARCHITECTURE-P3 D27, §2.17, §5.7;
 * §7 W3 wan). Pure: the stored lines in, plain data out (no module state, no rng, no clock).
 *
 * The stored lines (cli/config-rules.ts, the [C13] block; cli/handlers/crypto.ts):
 *
 *   crypto ikev2 keyring <k>
 *    peer <n>
 *     address <a>
 *     pre-shared-key <key>                     (a secret, stored as typed; it never travels in a packet)
 *   crypto ikev2 profile <p>
 *    match identity remote address <a> <mask>
 *    authentication local pre-share
 *    authentication remote pre-share
 *    keyring local <k>
 *   crypto ipsec profile <v>
 *    set ikev2-profile <p>
 *
 * The key of a protected tunnel (`ikeKeyFor`): the tunnel's `tunnel protection ipsec profile <v>` names the IPsec
 * profile; its `set ikev2-profile` names the IKEv2 profile; that profile's `match identity remote address` lines (when
 * it has any) must cover the peer; its `keyring local` names the keyring, whose peer with `address` = the tunnel peer
 * holds the pre-shared key. The first broken link names the outcome; only a missing IPsec profile keeps the tunnel
 * waiting (`ipsecProfileMissing`: the tunnel stays down `ike-negotiating` until the profile exists); every other gap
 * means there is no key, so the exchange fails `ike-no-proposal` (D27).
 */
import { ipv4ToU32, isIpv4, type Ipv4Address } from '../../contracts/addr.js';
import type { ConfigNode } from '../../contracts/config.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { decodeReversibleSecret, SECRET_REVERSIBLE_TAG } from '../../cli/secrets.js';

/** One `peer <n>` of a keyring. */
export interface IkeKeyringPeer {
  readonly name: string;
  readonly address?: Ipv4Address;
  /** The pre-shared key (never sent, never in a row, a view or the trace). */
  readonly key?: string;
}

/** One `crypto ikev2 keyring <k>` section. */
export interface IkeKeyring {
  readonly name: string;
  /** Peers in stored order. */
  readonly peers: readonly IkeKeyringPeer[];
}

/** One `match identity remote address <a> <mask>` line. */
export interface IkeIdentityMatch {
  readonly address: Ipv4Address;
  readonly mask: Ipv4Address;
}

/** One `crypto ikev2 profile <p>` section. */
export interface Ikev2Profile {
  readonly name: string;
  readonly identities: readonly IkeIdentityMatch[];
  /** `keyring local <k>`. */
  readonly keyring?: string;
  /** `authentication local pre-share` / `authentication remote pre-share` (the one method simulated). */
  readonly authLocal?: string;
  readonly authRemote?: string;
}

/** One `crypto ipsec profile <v>` section. */
export interface IpsecProfile {
  readonly name: string;
  /** `set ikev2-profile <p>`. */
  readonly ikev2Profile?: string;
}

/** Every crypto section of one configuration. */
export interface IkeConfig {
  readonly keyrings: ReadonlyMap<string, IkeKeyring>;
  readonly ikev2Profiles: ReadonlyMap<string, Ikev2Profile>;
  readonly ipsecProfiles: ReadonlyMap<string, IpsecProfile>;
}

/** Why a tunnel has no key, or the key. */
export type IkeKeyLookup =
  | { readonly status: 'ok'; readonly key: string }
  /** The IPsec profile does not exist: the tunnel waits (it stays down `ike-negotiating`). */
  | { readonly status: 'no-ipsec-profile' }
  /** The IPsec profile names no IKEv2 profile, or one that does not exist. */
  | { readonly status: 'no-ikev2-profile' }
  /** The IKEv2 profile's identity lines do not cover the peer. */
  | { readonly status: 'identity-mismatch' }
  /** The IKEv2 profile names no keyring, or one that does not exist. */
  | { readonly status: 'no-keyring' }
  /** The keyring has no peer with this address, or that peer has no key. */
  | { readonly status: 'no-peer' };

/**
 * The key a stored `pre-shared-key` value names: as typed, or the plain text of a reversibly encoded value (`nf7
 * <hex>` / `nf7$<hex>`, the form `service password-encryption` writes elsewhere), so both ends compare plain keys.
 */
export function ikeKeyText(tokens: readonly string[]): string {
  if (tokens.length === 2 && tokens[0] === SECRET_REVERSIBLE_TAG) return decodeReversibleSecret(`${SECRET_REVERSIBLE_TAG}$${tokens[1]!}`) ?? tokens.join(' ');
  const joined = tokens.join(' ');
  if (new RegExp(`^${SECRET_REVERSIBLE_TAG}\\$[0-9a-fA-F]+$`).test(joined)) return decodeReversibleSecret(joined) ?? joined;
  return joined;
}

const isCtx = (ctx: readonly (readonly string[])[], i: number, head: readonly string[]): boolean => {
  const e = ctx[i];
  return e !== undefined && head.every((t, k) => e[k] === t);
};

/** The crypto sections of `root` (negated lines ignored; the last line of a single slot wins). */
export function readIkeConfig(root: ConfigNode): IkeConfig {
  const keyrings = new Map<string, { name: string; peers: Map<string, { name: string; address?: Ipv4Address; key?: string }> }>();
  const profiles = new Map<string, { name: string; identities: IkeIdentityMatch[]; keyring?: string; authLocal?: string; authRemote?: string }>();
  const ipsec = new Map<string, { name: string; ikev2Profile?: string }>();
  for (const l of configTextLinesOf(root)) {
    if (l.negate) continue;
    const t = l.tokens;
    const c = l.context;
    if (c.length === 0) {
      if (t[0] !== 'crypto' || t[3] === undefined) continue;
      if (t[1] === 'ikev2' && t[2] === 'keyring' && !keyrings.has(t[3])) keyrings.set(t[3], { name: t[3], peers: new Map() });
      else if (t[1] === 'ikev2' && t[2] === 'profile' && !profiles.has(t[3])) profiles.set(t[3], { name: t[3], identities: [] });
      else if (t[1] === 'ipsec' && t[2] === 'profile' && !ipsec.has(t[3])) ipsec.set(t[3], { name: t[3] });
      continue;
    }
    if (isCtx(c, 0, ['crypto', 'ikev2', 'keyring'])) {
      const kr = keyrings.get(c[0]![3] ?? '');
      if (kr === undefined) continue;
      if (c.length === 1 && t[0] === 'peer' && t[1] !== undefined) {
        if (!kr.peers.has(t[1])) kr.peers.set(t[1], { name: t[1] });
      } else if (c.length === 2 && isCtx(c, 1, ['peer'])) {
        const p = kr.peers.get(c[1]![1] ?? '');
        if (p === undefined) continue;
        if (t[0] === 'address' && t[1] !== undefined && isIpv4(t[1])) p.address = t[1];
        else if (t[0] === 'pre-shared-key' && t.length > 1) p.key = ikeKeyText(t.slice(1));
      }
      continue;
    }
    if (c.length === 1 && isCtx(c, 0, ['crypto', 'ikev2', 'profile'])) {
      const p = profiles.get(c[0]![3] ?? '');
      if (p === undefined) continue;
      if (t[0] === 'match' && t[1] === 'identity' && t[2] === 'remote' && t[3] === 'address' && t[4] !== undefined && isIpv4(t[4])) {
        const mask = t[5] !== undefined && isIpv4(t[5]) ? t[5] : '255.255.255.255';
        p.identities.push({ address: t[4], mask });
      } else if (t[0] === 'keyring' && t[1] === 'local' && t[2] !== undefined) p.keyring = t[2];
      else if (t[0] === 'authentication' && t[1] === 'local' && t[2] !== undefined) p.authLocal = t[2];
      else if (t[0] === 'authentication' && t[1] === 'remote' && t[2] !== undefined) p.authRemote = t[2];
      continue;
    }
    if (c.length === 1 && isCtx(c, 0, ['crypto', 'ipsec', 'profile'])) {
      const p = ipsec.get(c[0]![3] ?? '');
      if (p !== undefined && t[0] === 'set' && t[1] === 'ikev2-profile' && t[2] !== undefined) p.ikev2Profile = t[2];
    }
  }
  return {
    keyrings: new Map([...keyrings].map(([k, v]) => [k, { name: v.name, peers: [...v.peers.values()].map((p) => ({ ...p })) }])),
    ikev2Profiles: new Map([...profiles].map(([k, v]) => [k, { ...v, identities: v.identities.slice() }])),
    ipsecProfiles: new Map([...ipsec].map(([k, v]) => [k, { ...v }])),
  };
}

/** True when `peer` is covered by `m` (address and peer equal under the mask, compared as u32). */
export function ikeIdentityCovers(m: IkeIdentityMatch, peer: Ipv4Address): boolean {
  const mask = ipv4ToU32(m.mask);
  return ((ipv4ToU32(m.address) & mask) >>> 0) === ((ipv4ToU32(peer) & mask) >>> 0);
}

/** The pre-shared key a tunnel protected by IPsec profile `ipsecProfile` uses with `peer`, or why there is none. */
export function ikeKeyFor(cfg: IkeConfig, ipsecProfile: string, peer: Ipv4Address): IkeKeyLookup {
  const v = cfg.ipsecProfiles.get(ipsecProfile);
  if (v === undefined) return { status: 'no-ipsec-profile' };
  const p = v.ikev2Profile === undefined ? undefined : cfg.ikev2Profiles.get(v.ikev2Profile);
  if (p === undefined) return { status: 'no-ikev2-profile' };
  if (p.identities.length > 0 && !p.identities.some((m) => ikeIdentityCovers(m, peer))) return { status: 'identity-mismatch' };
  const kr = p.keyring === undefined ? undefined : cfg.keyrings.get(p.keyring);
  if (kr === undefined) return { status: 'no-keyring' };
  const entry = kr.peers.find((e) => e.address === peer && e.key !== undefined);
  if (entry === undefined || entry.key === undefined) return { status: 'no-peer' };
  return { status: 'ok', key: entry.key };
}
