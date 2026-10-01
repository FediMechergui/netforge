/**
 * protocols/ospf/hello-check.ts — whether a received hello may create or refresh a neighbour (ARCHITECTURE-P3 §3.1
 * step 2; RFC 2328 §8.2, §10.5; §7 W1 ospf). Pure; no module state.
 *
 * The checks, in this order; the first that fails refuses the hello (no neighbour is created or refreshed; the daemon
 * sets the interface row's `rejected` and writes an `ip ospf hello` debug line with the reason text):
 *   1. area         the packet's area id equals the interface's area;
 *   2. mask         broadcast networks only: the hello's network mask equals the interface's;
 *   3. subnet       broadcast networks only: the source address is on the interface's subnet;
 *   4. hello        the hello interval equals the interface's;
 *   5. dead         the dead interval equals the interface's;
 *   6. auth         the authentication type equals the interface's (0, none: [S5] authentication is not approved);
 *   7. e-bit        the E bit of the options agrees (every P3a area carries external routes: E set);
 *   8. router-id    the hello does not carry this router's own router id (a duplicate router id).
 * Every text is original wording.
 */
import { ipv4ToU32, prefixLenToMaskU32, type Ipv4Address } from '../../contracts/addr.js';
import type { OspfAreaId, OspfNetworkType } from '../../contracts/tables.js';

/** @since P3 The OSPF options E bit (external routing capability). */
export const OSPF_OPTION_E = 0x02;

/** @since P3 Why a hello was refused. */
export type OspfHelloReject = 'area' | 'mask' | 'subnet' | 'hello' | 'dead' | 'auth' | 'e-bit' | 'router-id';

/** @since P3 The fields of a received hello the checks read (from the ospf layer and the IPv4 source). */
export interface OspfHelloSeen {
  readonly routerId: Ipv4Address;
  readonly area: OspfAreaId;
  /** The IPv4 source address. */
  readonly src: Ipv4Address;
  readonly mask: Ipv4Address;
  readonly helloS: number;
  readonly deadS: number;
  readonly options: number;
  /** The OSPF authentication type (0 = none). */
  readonly authType: number;
}

/** @since P3 The receiving interface as the checks see it. */
export interface OspfHelloIface {
  readonly routerId: Ipv4Address;
  readonly area: OspfAreaId;
  readonly networkType: OspfNetworkType;
  readonly address: Ipv4Address;
  readonly prefixLen: number;
  readonly helloS: number;
  readonly deadS: number;
  /** Options this router sends (default E set). */
  readonly options?: number;
  /** Default 0 (none). */
  readonly authType?: number;
}

/** @since P3 The outcome of `checkOspfHello`. */
export type OspfHelloCheck = { readonly ok: true } | { readonly ok: false; readonly reason: OspfHelloReject; readonly text: string };

function prefixLenOfMask(mask: Ipv4Address): number | undefined {
  const v = ipv4ToU32(mask);
  const inv = ~v >>> 0;
  if (((inv & (inv + 1)) >>> 0) !== 0) return undefined;
  let n = 0;
  for (let bit = 0x80000000; bit !== 0 && (v & bit) !== 0; bit = bit >>> 1) n++;
  return n;
}

function maskText(mask: Ipv4Address): string {
  const len = prefixLenOfMask(mask);
  return len === undefined ? mask : `/${len}`;
}

/** @since P3 Check a received hello against the receiving interface (the order of the module header). */
export function checkOspfHello(iface: OspfHelloIface, hello: OspfHelloSeen): OspfHelloCheck {
  const refuse = (reason: OspfHelloReject, text: string): OspfHelloCheck => ({ ok: false, reason, text });
  if (hello.area !== iface.area) return refuse('area', `area ${hello.area} does not match this interface's area ${iface.area}`);
  if (iface.networkType === 'broadcast') {
    const own = prefixLenToMaskU32(iface.prefixLen);
    if (ipv4ToU32(hello.mask) !== own) return refuse('mask', `network mask ${maskText(hello.mask)} does not match this interface's /${iface.prefixLen}`);
    if (((ipv4ToU32(hello.src) ^ ipv4ToU32(iface.address)) & own) >>> 0 !== 0) {
      return refuse('subnet', `source ${hello.src} is not on this interface's subnet`);
    }
  }
  if (hello.helloS !== iface.helloS) return refuse('hello', `hello interval ${hello.helloS} s does not match this interface's ${iface.helloS} s`);
  if (hello.deadS !== iface.deadS) return refuse('dead', `dead interval ${hello.deadS} s does not match this interface's ${iface.deadS} s`);
  const auth = iface.authType ?? 0;
  if (hello.authType !== auth) return refuse('auth', `authentication type ${hello.authType} does not match this interface's type ${auth}`);
  const e = (iface.options ?? OSPF_OPTION_E) & OSPF_OPTION_E;
  if ((hello.options & OSPF_OPTION_E) !== e) {
    return refuse('e-bit', `external routing capability (E bit) ${e === 0 ? 'set' : 'clear'}, this interface has it ${e === 0 ? 'clear' : 'set'}`);
  }
  if (hello.routerId === iface.routerId) return refuse('router-id', `the neighbour uses this router's own router ID ${iface.routerId}`);
  return { ok: true };
}
