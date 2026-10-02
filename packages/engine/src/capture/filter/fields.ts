/**
 * capture/filter/fields.ts — the NetScope display-filter field registry (contracts/capture.ts `DisplayFieldDef`): the
 * index file of `capture/filter/fields/<proto>.ts` (ARCHITECTURE-P3 §0 rule 18, §7 W2 capture).
 *
 * Pure and DOM-free (also exported by the `pure` entry). The registry is assembled here, in this order:
 *  • `frame` and its `frame.*` fields (record metadata: number, lengths, relative time, interface, direction);
 *  • every PROTO_FIELDS table, in table order: a protocol entry (`tcp`, type 'protocol', with the help text its
 *    protocol file gives) and one entry per canonical field (`tcp.srcPort`, `ipv4.src`, …) typed from its FieldType
 *    (uint/int → number, bytes → string), so a protocol without a file still filters;
 *  • then, file by file in PROTOCOL_FILES order: the familiar protocol names (`eth`, `ip`, …), then the familiar field
 *    names over canonical paths (`ip.addr`, `tcp.port`, `ospf.msg`, …), then the derived fields (flag letters, list
 *    entries, message kinds).
 * The P0–P2 files keep the historical order, so every P1/P2 entry keeps its relative place; the P3 files follow in
 * ProtoName order. A protocol owner edits only its own file (plus its one import and list line here).
 *
 * Accessors return every value of a field in the frame, outermost layer first, so a quoted datagram inside an ICMP
 * error contributes its addresses too (multi-valued fields; `==` means any, `!=` means none).
 */
import type { DisplayFieldDef } from '../../contracts/capture.js';
import { PROTO_FIELDS } from '../../contracts/fields.js';
import {
  canonicalAccessor,
  def,
  mapFieldType,
  protocolAccessor,
  splitPath,
  valuesAccessor,
  type DisplayFieldAccessor,
  type DisplayFieldType,
  type ProtoDisplayFields,
} from './fields/kit.js';
import { FRAME_FIELD_VALUES, frameAccessors } from './fields/frame.js';
import { ETHERNET_DISPLAY_FIELDS } from './fields/ethernet.js';
import { ARP_DISPLAY_FIELDS } from './fields/arp.js';
import { IPV4_DISPLAY_FIELDS } from './fields/ipv4.js';
import { IPV6_DISPLAY_FIELDS } from './fields/ipv6.js';
import { ICMPV4_DISPLAY_FIELDS } from './fields/icmpv4.js';
import { ICMPV6_DISPLAY_FIELDS } from './fields/icmpv6.js';
import { TCP_DISPLAY_FIELDS } from './fields/tcp.js';
import { UDP_DISPLAY_FIELDS } from './fields/udp.js';
import { DNS_DISPLAY_FIELDS } from './fields/dns.js';
import { DHCP_DISPLAY_FIELDS } from './fields/dhcp.js';
import { DOT11_MGMT_DISPLAY_FIELDS } from './fields/dot11-mgmt.js';
import { DOT11_DISPLAY_FIELDS } from './fields/dot11.js';
import { HTTP_DISPLAY_FIELDS } from './fields/http.js';
import { PAYLOAD_DISPLAY_FIELDS } from './fields/payload.js';
import { HDLC_DISPLAY_FIELDS } from './fields/hdlc.js';
import { LLC_DISPLAY_FIELDS } from './fields/llc.js';
import { EAPOL_DISPLAY_FIELDS } from './fields/eapol.js';
import { IPV6_EXT_DISPLAY_FIELDS } from './fields/ipv6-ext.js';
import { OSPF_DISPLAY_FIELDS } from './fields/ospf.js';
import { OSPF_LSA_DISPLAY_FIELDS } from './fields/ospf-lsa.js';
import { CDP_DISPLAY_FIELDS } from './fields/cdp.js';
import { LLDP_DISPLAY_FIELDS } from './fields/lldp.js';
import { NTP_DISPLAY_FIELDS } from './fields/ntp.js';
import { TELNET_DISPLAY_FIELDS } from './fields/telnet.js';
import { SSH_DISPLAY_FIELDS } from './fields/ssh.js';
import { GRE_DISPLAY_FIELDS } from './fields/gre.js';
import { PPP_DISPLAY_FIELDS } from './fields/ppp.js';
import { LCP_DISPLAY_FIELDS } from './fields/lcp.js';
import { PAP_DISPLAY_FIELDS } from './fields/pap.js';
import { CHAP_DISPLAY_FIELDS } from './fields/chap.js';
import { IPCP_DISPLAY_FIELDS } from './fields/ipcp.js';
import { IPV6CP_DISPLAY_FIELDS } from './fields/ipv6cp.js';
import { SYSLOG_DISPLAY_FIELDS } from './fields/syslog.js';
import { EIGRP_DISPLAY_FIELDS } from './fields/eigrp.js';
import { ESP_DISPLAY_FIELDS } from './fields/esp.js';
import { IKEV2_DISPLAY_FIELDS } from './fields/ikev2.js';

export type { DisplayFieldAccessor, DisplayFieldType, DisplayFilterFrame, DisplayScalar } from './fields/kit.js';

/**
 * Every per-protocol file, in registry order: P0–P2 first (the order their familiar names had before the W2 split),
 * then the P3 protocols in ProtoName order (§2.3: the MUST five, then the approved [S13] [S18] [S19] [S25] [C1] [C13]).
 */
const PROTOCOL_FILES: readonly ProtoDisplayFields[] = Object.freeze([
  ETHERNET_DISPLAY_FIELDS,
  ARP_DISPLAY_FIELDS,
  IPV4_DISPLAY_FIELDS,
  IPV6_DISPLAY_FIELDS,
  ICMPV4_DISPLAY_FIELDS,
  ICMPV6_DISPLAY_FIELDS,
  TCP_DISPLAY_FIELDS,
  UDP_DISPLAY_FIELDS,
  DNS_DISPLAY_FIELDS,
  DHCP_DISPLAY_FIELDS,
  DOT11_MGMT_DISPLAY_FIELDS,
  DOT11_DISPLAY_FIELDS,
  HTTP_DISPLAY_FIELDS,
  PAYLOAD_DISPLAY_FIELDS,
  HDLC_DISPLAY_FIELDS,
  LLC_DISPLAY_FIELDS,
  EAPOL_DISPLAY_FIELDS,
  IPV6_EXT_DISPLAY_FIELDS,
  // ── P3 ──
  OSPF_DISPLAY_FIELDS,
  OSPF_LSA_DISPLAY_FIELDS,
  CDP_DISPLAY_FIELDS,
  LLDP_DISPLAY_FIELDS,
  NTP_DISPLAY_FIELDS,
  TELNET_DISPLAY_FIELDS, // [S13]
  SSH_DISPLAY_FIELDS, // [S13]
  GRE_DISPLAY_FIELDS, // [S18]
  PPP_DISPLAY_FIELDS, // [S19]
  LCP_DISPLAY_FIELDS, // [S19]
  PAP_DISPLAY_FIELDS, // [S19]
  CHAP_DISPLAY_FIELDS, // [S19]
  IPCP_DISPLAY_FIELDS, // [S19]
  IPV6CP_DISPLAY_FIELDS, // [S19]
  SYSLOG_DISPLAY_FIELDS, // [S25]
  EIGRP_DISPLAY_FIELDS, // [C1]
  ESP_DISPLAY_FIELDS, // [C13]
  IKEV2_DISPLAY_FIELDS, // [C13]
]);

/** Display type of a canonical path; throws for a path PROTO_FIELDS does not define. */
function canonicalFieldType(path: string): DisplayFieldType {
  const [proto, field] = splitPath(path);
  const spec = PROTO_FIELDS[proto]?.fields.find((f) => f.name === field);
  if (spec === undefined) throw new Error(`display filter alias reads an unknown field ${path}`);
  return mapFieldType(spec.type);
}

function knownProto(proto: string, what: string): void {
  if (PROTO_FIELDS[proto] === undefined) throw new Error(`display filter ${what} names an unknown protocol ${proto}`);
}

/** Protocol help text by canonical protocol name, merged from the protocol files (each protocol in one file only). */
function buildProtocolHelp(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of PROTOCOL_FILES) {
    for (const [proto, help] of Object.entries(file.help ?? {})) {
      knownProto(proto, 'help');
      if (out[proto] !== undefined) throw new Error(`display filter help for ${proto} is given twice`);
      out[proto] = help;
    }
  }
  return Object.freeze(out);
}

const PROTOCOL_HELP: Readonly<Record<string, string>> = buildProtocolHelp();

function buildRegistry(): DisplayFieldAccessor[] {
  const out: DisplayFieldAccessor[] = frameAccessors();
  for (const table of Object.values(PROTO_FIELDS)) {
    const proto = table.proto;
    out.push(protocolAccessor(def(proto, [proto], 'protocol', PROTOCOL_HELP[proto] ?? `The ${proto} protocol.`), proto));
    for (const spec of table.fields) {
      const path = `${proto}.${spec.name}`;
      out.push(canonicalAccessor(def(path, [path], mapFieldType(spec.type), spec.doc)));
    }
  }
  for (const file of PROTOCOL_FILES) {
    for (const a of file.protocolAliases ?? []) {
      knownProto(a.proto, `name ${a.name}`);
      out.push(protocolAccessor(def(a.name, [a.proto], 'protocol', `${PROTOCOL_HELP[a.proto] ?? a.proto} Same as '${a.proto}'.`), a.proto));
    }
  }
  for (const file of PROTOCOL_FILES) {
    for (const a of file.aliases ?? []) {
      const type = canonicalFieldType(a.reads[0] as string);
      for (const path of a.reads.slice(1)) canonicalFieldType(path);
      out.push(canonicalAccessor(def(a.name, a.reads, type, a.help)));
    }
  }
  for (const file of PROTOCOL_FILES) {
    for (const d of file.derived ?? []) out.push(valuesAccessor(def(d.name, d.reads, d.type, d.help), d.values));
  }
  const seen = new Set<string>();
  for (const acc of out) {
    if (seen.has(acc.def.name)) throw new Error(`duplicate display filter field ${acc.def.name}`);
    seen.add(acc.def.name);
  }
  return out;
}

const REGISTRY: readonly DisplayFieldAccessor[] = Object.freeze(buildRegistry());
const BY_NAME: ReadonlyMap<string, DisplayFieldAccessor> = new Map(REGISTRY.map((a) => [a.def.name, a]));

/** Every display filter field, in registry order: frame.*, then each protocol with its canonical fields, then aliases. */
export const DISPLAY_FIELDS: readonly DisplayFieldDef[] = Object.freeze(REGISTRY.map((a) => a.def));

/** Definition of a display field by the name the user types, or undefined. Names are case-sensitive. */
export function lookupDisplayField(name: string): DisplayFieldDef | undefined {
  return BY_NAME.get(name)?.def;
}

/** Resolved accessor (definition + extractors) for a display field, or undefined. */
export function displayFieldAccessor(name: string): DisplayFieldAccessor | undefined {
  return BY_NAME.get(name);
}

function buildFieldValues(): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const values of [FRAME_FIELD_VALUES, ...PROTOCOL_FILES.map((f) => f.values ?? {})]) {
    for (const [name, list] of Object.entries(values)) {
      if (!BY_NAME.has(name)) throw new Error(`display filter values name an unknown field ${name}`);
      if (out[name] !== undefined) throw new Error(`display filter values for ${name} are given twice`);
      out[name] = Object.freeze([...list]);
    }
  }
  return Object.freeze(out);
}

/**
 * Suggested values of the enumerated text fields by field name (canonical and familiar spellings), offered by
 * completion after a relation (`dhcp.type == "DISCOVER"`); gathered from the protocol files.
 */
export const DISPLAY_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = buildFieldValues();

// ── literal helpers shared by the parser and the evaluator ────────────────────

function parseHexGroup(g: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  return parseInt(g, 16);
}

/**
 * 16 bytes of an IPv6 address written in text (`::` compression, any case, dotted IPv4 tail), or null. Zone ids
 * and more than eight groups are rejected. Local to the filter so the pure entry needs no other module.
 */
export function parseFilterIpv6(text: string): Uint8Array | null {
  let s = text;
  if (s.length === 0 || s.includes('%')) return null;
  const words: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  if (s.slice(lastColon + 1).includes('.')) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.slice(lastColon + 1));
    if (!m) return null;
    const o = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
    if (o.some((x) => x > 255)) return null;
    const hi = (((o[0] as number) << 8) | (o[1] as number)).toString(16);
    const lo = (((o[2] as number) << 8) | (o[3] as number)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  const parseList = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      const v = parseHexGroup(g);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  if (dbl >= 0) {
    const head = parseList(s.slice(0, dbl));
    const rest = parseList(s.slice(dbl + 2));
    if (head === null || rest === null) return null;
    const used = head.length + rest.length;
    if (used > 7) return null;
    words.push(...head, ...new Array<number>(8 - used).fill(0), ...rest);
  } else {
    const all = parseList(s);
    if (all === null) return null;
    words.push(...all);
  }
  if (words.length !== 8) return null;
  const b = new Uint8Array(16);
  words.forEach((w, i) => {
    b[i * 2] = w >> 8;
    b[i * 2 + 1] = w & 0xff;
  });
  return b;
}

/** RFC 5952 text of 16 IPv6 bytes (lowercase, longest zero run of two or more groups compressed, first on ties). */
export function formatFilterIpv6(b: Uint8Array): string {
  const words: number[] = [];
  for (let i = 0; i < 8; i++) words.push(((b[i * 2] ?? 0) << 8) | (b[i * 2 + 1] ?? 0));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (ws: number[]): string => ws.map((w) => w.toString(16)).join(':');
  if (bestStart < 0) return hex(words);
  return `${hex(words.slice(0, bestStart))}::${hex(words.slice(bestStart + bestLen))}`;
}
