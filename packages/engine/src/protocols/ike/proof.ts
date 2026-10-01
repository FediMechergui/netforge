/**
 * protocols/ike/proof.ts — the simulated IKEv2 values [C13] (ARCHITECTURE-P3 D27, §2.17, §4.1, §4.5; §7 W1 wan).
 *
 * IPsec's crypto is simulated, its headers are real (D27). Every value that real IKE draws or computes is derived
 * here with FNV-1a, so a world replays byte for byte and no randomness stream is added (§4.1):
 *   - IKE SPIs (8 bytes, 16 hex digits, never zero), nonces and KE values (32 bytes, 64 hex digits) and ESP SPIs
 *     (u32, at least 256: RFC 4303 reserves 0–255) are derived from (device id, tunnel port, per-process counter) and a
 *     role, so both ends of one tunnel, two tunnels of one router and two attempts of one tunnel all differ;
 *   - the IKE_AUTH proof (16 bytes, 32 hex digits) is derived from the pre-shared key, both IKE SPIs, both nonces and
 *     the sender's role ('I' or 'R'): the peer recomputes it with its own key, so a wrong key fails exactly where real
 *     authentication would, and the key itself never appears in a PDU byte, the snapshot or the trace;
 *   - the SA key id (u32), carried by `tunnel.sa` to the tunnel owner, which chains it into each ESP ICV, is derived
 *     from the same inputs without the role, so both ends compute the same id.
 *
 * The chain: the label (its UTF-16 code units, low byte then high byte) is hashed with the contract FNV-1a
 * (`macHash32`, contracts/addr.ts: the `fnv1a32` of §4.1); each further 32-bit word continues the running FNV-1a state
 * over a two-byte counter (word i absorbs i & 0xff, then i >>> 8), and the words are written big-endian. Values are
 * lower-case hex.
 *
 * Pure: no module state, no randomness, no I/O.
 */
import { macHash32 } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';

const FNV_PRIME = 0x01000193;

/** Bytes of an IKE SPI (16 hex digits). */
export const IKE_SPI_BYTES = 8;
/** Bytes of a nonce and of a KE value (64 hex digits). */
export const IKE_NONCE_BYTES = 32;
export const IKE_KE_BYTES = 32;
/** Bytes of the IKE_AUTH proof (32 hex digits). */
export const IKE_AUTH_BYTES = 16;
/** The lowest ESP SPI a router assigns (RFC 4303: 1–255 are reserved, 0 is never sent). */
export const ESP_SPI_MIN = 0x100;

/** The IKE role whose values or proof are derived: the original initiator or the responder. */
export type IkeRole = 'I' | 'R';

function fnvStep(h: number, byte: number): number {
  return Math.imul((h ^ (byte & 0xff)) >>> 0, FNV_PRIME) >>> 0;
}

/** `bytes` bytes (a multiple of 4) chained from `label`, as lower-case hex. */
export function fnvChainHex(label: string, bytes: number): string {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes % 4 !== 0) throw new RangeError(`fnvChainHex: byte count must be a positive multiple of 4, got ${bytes}`);
  let h = macHash32(label);
  let out = '';
  for (let i = 0; i < bytes / 4; i++) {
    h = fnvStep(fnvStep(h, i & 0xff), (i >>> 8) & 0xff);
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const isZeroHex = (hex: string): boolean => /^0*$/.test(hex);

/** An IKE SPI: 16 hex digits, never all zeros (zero is the responder SPI of a first request). */
export function ikeSpiOf(device: string, port: PortId, counter: number, role: IkeRole): string {
  const hex = fnvChainHex(`ike-spi|${role}|${device}|${port}|${counter}`, IKE_SPI_BYTES);
  return isZeroHex(hex) ? `${hex.slice(0, -1)}1` : hex;
}

/** A nonce: 32 bytes as 64 hex digits. */
export function ikeNonceOf(device: string, port: PortId, counter: number, role: IkeRole): string {
  return fnvChainHex(`ike-nonce|${role}|${device}|${port}|${counter}`, IKE_NONCE_BYTES);
}

/** A key-exchange value (simulated; no group is computed): 32 bytes as 64 hex digits. */
export function ikeKeOf(device: string, port: PortId, counter: number, role: IkeRole): string {
  return fnvChainHex(`ike-ke|${role}|${device}|${port}|${counter}`, IKE_KE_BYTES);
}

/** The inbound ESP SPI this router assigns to a tunnel's SA: a u32 of at least `ESP_SPI_MIN`. */
export function espSpiOf(device: string, port: PortId, counter: number): number {
  const v = macHash32(`esp-spi|${device}|${port}|${counter}`);
  return v < ESP_SPI_MIN ? v + ESP_SPI_MIN : v;
}

/** What the proof and the key id are computed from (both ends know every member). */
export interface IkeProofInputs {
  /** The pre-shared key of the keyring peer (never sent, never stored in a row or a view). */
  readonly key: string;
  readonly spiI: string;
  readonly spiR: string;
  readonly nonceI: string;
  readonly nonceR: string;
}

/** The IKE_AUTH proof of `role` (its `auth` payload): 16 bytes as 32 hex digits. */
export function ikeAuthProof(inputs: IkeProofInputs, role: IkeRole): string {
  return fnvChainHex(`ike-auth|${role}|${inputs.spiI}|${inputs.spiR}|${inputs.nonceI}|${inputs.nonceR}|${inputs.key}`, IKE_AUTH_BYTES);
}

/** The SA key id both ends derive once IKE_AUTH succeeds (`tunnel.sa.keyId`; chained into every ESP ICV). */
export function ipsecKeyIdOf(inputs: IkeProofInputs): number {
  return macHash32(`ipsec-key|${inputs.spiI}|${inputs.spiR}|${inputs.nonceI}|${inputs.nonceR}|${inputs.key}`);
}
