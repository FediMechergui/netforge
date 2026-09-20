/**
 * cli/secrets.ts — password hashing, reversible encoding and the questions the CLI asks for one
 * (ARCHITECTURE-P1 §4.10).
 *
 * A leaf module: it imports only contracts, so both the CLI runtime (login stage, `CommandCtx.secrets`) and the
 * command handlers (`enable secret`, `service password-encryption`, line passwords) can use it without a cycle.
 *
 *   nf1  one-way hash: `nf1$<16 hex>` = FNV-1a-64 over the UTF-8 bytes of the device id (the salt) followed by the
 *        plain text. Stored as the two tokens `nf1 <hex>`, so the config renders `enable secret nf1 <hash>`.
 *   nf7  reversible encoding: `nf7$<hex>` = the UTF-8 bytes XORed with a fixed key stream. Obfuscation only (that is
 *        exactly what `service password-encryption` offers), never protection.
 *
 * `verifySecret` accepts either tag with `$` or a space between tag and value, and compares an untagged value
 * literally, so a config written by hand keeps working. Everything here is pure and deterministic.
 */
import type { CliInputRequest } from '../contracts/cli.js';

/** Tag of a one-way secret hash (`nf1$<16 hex>`; config text renders it as `nf1 <16 hex>`). */
export const SECRET_HASH_TAG = 'nf1';
/** Tag of a reversibly encoded password (`nf7$<hex>`; rendered `password nf7 <hex>` under `service password-encryption`). */
export const SECRET_REVERSIBLE_TAG = 'nf7';

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
/** Key stream of the reversible encoding (original, fixed; obfuscation only, not protection). */
const REVERSIBLE_KEY = new TextEncoder().encode('NetForge line password obfuscation key');
const UTF8 = new TextEncoder();

/** The secret question of `enable` and of the login stage. */
export const PASSWORD_PROMPT: CliInputRequest = Object.freeze({ kind: 'secret', prompt: 'Password: ' });
/** The user-name question of `login local`. */
export const USERNAME_PROMPT: CliInputRequest = Object.freeze({ kind: 'text', prompt: 'Username: ' });

/** FNV-1a 64-bit over `bytes`, as 16 lower-case hex digits. */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let h = FNV64_OFFSET;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * FNV64_PRIME);
  return h.toString(16).padStart(16, '0');
}

/** One-way hash of a secret: `nf1$` + FNV-1a-64 over the UTF-8 bytes of `salt` (the device id) followed by `plain`. */
export function hashSecret(salt: string, plain: string): string {
  return `${SECRET_HASH_TAG}$${fnv1a64Hex(UTF8.encode(salt + plain))}`;
}

/** Reversible encoding of a password: `nf7$` + hex of its UTF-8 bytes XORed with a fixed key stream. */
export function encodeReversibleSecret(plain: string): string {
  const bytes = UTF8.encode(plain);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ((bytes[i] as number) ^ (REVERSIBLE_KEY[i % REVERSIBLE_KEY.length] as number)).toString(16).padStart(2, '0');
  }
  return `${SECRET_REVERSIBLE_TAG}$${hex}`;
}

/** Inverse of `encodeReversibleSecret` (accepts `nf7$<hex>`, `nf7 <hex>` or bare hex); null when malformed. */
export function decodeReversibleSecret(stored: string): string | null {
  const parts = splitTaggedSecret(stored);
  const hex = parts !== undefined && parts.tag === SECRET_REVERSIBLE_TAG ? parts.value : stored;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) ^ (REVERSIBLE_KEY[i % REVERSIBLE_KEY.length] as number);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `nf1$v`, `nf1 v`, `nf7$v`, `nf7 v` → tag and value; undefined for any other text (a plain value). */
function splitTaggedSecret(stored: string): { tag: string; value: string } | undefined {
  const m = /^(nf1|nf7)[$ ]([0-9a-fA-F]+)$/.exec(stored);
  return m === null ? undefined : { tag: m[1] as string, value: m[2] as string };
}

/** True when `stored` already carries a `nf1` or `nf7` tag (hashing it again would hash the hash). */
export function isTaggedSecret(stored: string): boolean {
  return splitTaggedSecret(stored) !== undefined;
}

/** The two config tokens of a tagged secret: `nf1$abc` → `['nf1', 'abc']`; an untagged value stays one token. */
export function secretTokens(stored: string): string[] {
  const parts = splitTaggedSecret(stored);
  return parts === undefined ? [stored] : [parts.tag, parts.value];
}

/**
 * Whether `plain` matches a stored secret: a `nf1` hash (salted with `salt`), a `nf7` reversible encoding, or plain
 * text (compared exactly). The stored value may use `$` or a space between tag and value.
 */
export function verifySecret(salt: string, stored: string, plain: string): boolean {
  const parts = splitTaggedSecret(stored);
  if (parts === undefined) return stored === plain;
  if (parts.tag === SECRET_HASH_TAG) return hashSecret(salt, plain) === `${SECRET_HASH_TAG}$${parts.value.toLowerCase()}`;
  return decodeReversibleSecret(parts.value) === plain;
}

/** The `CommandCtx.secrets` service of a device (`salt` = the device id). Deterministic. */
export function secretsFor(salt: string): { hash(plain: string): string; verify(stored: string, plain: string): boolean } {
  return {
    hash: (plain) => hashSecret(salt, plain),
    verify: (stored, plain) => verifySecret(salt, stored, plain),
  };
}
