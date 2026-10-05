/**
 * test/accept.p3.ppp.harness.ts — the shared world of the W4 PPP acceptance rows [S19] (ARCHITECTURE-P3 §10.1
 * `accept.p3.ppp-chap`, `accept.p3.ppp-pap`, `accept.p3.ppp-mismatch`, `accept.p3.ppp-keepalive`; §3.9, §4.2, §4.3,
 * §5.7; §7 W4 qa). Not a test file.
 *
 * The world is §3.9's, built on `staged.world` at stage P3 (rule 13; the catalog flip is a later, separate step):
 *
 *   R1 (NF-2911) Se0/0/0 10.1.1.1/30, DCE `clock rate 64000` ──serial-dce── Se0/0/0 10.1.1.2/30 R2 (NF-2911)
 *
 * R1 holds `username R2 password NetF0rge`, R2 `username R1 password NetF0rge`; each serial interface holds
 * `encapsulation ppp` and `ppp authentication chap` unless the case replaces the PPP lines (`EndOptions.ppp`). The
 * routers boot for 45 s (P0.5), so the serial line becomes ready at boot; every case reads its times from the trace.
 *
 * The daemon registry is `PROCESS_FACTORIES` plus every approved P3 daemon's factory (`PPP_ACCEPT_FACTORIES`: the seven
 * MUST daemons and the eight of the approved items, exactly the names the W4 flip registers), so the world is the one
 * the flipped catalog builds (a P3-profile world: CDP and the extended logging run, silent on these serial-only
 * worlds). After the flip the overlay is a no-op (the same factories), so these files run unchanged against the real
 * catalog (rule 14).
 *
 * `wireFrames` reads every frame put on the serial cable (the `frameTx` events) with its decoded PPP layers, so a row
 * can pin the exact message order, sizes and times on the wire.
 */
import { MEDIA } from '../src/contracts/link.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { PppRow } from '../src/contracts/tables.js';
import { serializationNs, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { pppCpCodeText } from '../src/pdu/codecs/ppp.js';
import { createAcl } from '../src/protocols/acl.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp } from '../src/protocols/lldp.js';
import { createLogger } from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { createSyslogServer } from '../src/protocols/syslog-server.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createVty } from '../src/protocols/vty.js';
import { ofKind } from './sim.harness.js';
import { createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

/** Every approved P3 daemon the W4 flip registers (§7 W4 catalog: the MUST seven and the approved eight). */
export const PPP_ACCEPT_FACTORIES: StagedFactoryOverlay = Object.freeze({
  ospf: createOspf,
  acl: createAcl,
  cdp: createCdp,
  lldp: createLldp,
  ntp: createNtp,
  restconf: createRestconf,
  traffic: createTraffic,
  ppp: createPpp,
  gre: createGre,
  vty: createVty,
  'vty-client': createVtyClient,
  logger: createLogger,
  'syslog-server': createSyslogServer,
  eigrp: createEigrp,
  ike: createIke,
});

/** The serial interface of both routers. */
export const SE0 = 'Serial0/0/0';
/** The /30 of the serial link. */
export const MASK30 = '255.255.255.252';
/** The shared CHAP secret of §3.9. */
export const SECRET = 'NetF0rge';
/** The DCE clock rate of §3.9 (b/s). */
export const CLOCK_BPS = 64_000;
/** The serial cable's per-frame line overhead (bytes), from the media table. */
export const SERIAL_OVERHEAD = MEDIA['serial-dce'].phyOverheadBytes ?? 0;
/** §3.9's PPP interface lines. */
export const PPP_CHAP: readonly string[] = Object.freeze([' encapsulation ppp', ' ppp authentication chap']);

/** One end of the world. */
export interface EndOptions {
  /** Interface lines replacing §3.9's PPP lines (`PPP_CHAP`); `[]` leaves the port on HDLC. */
  readonly ppp?: readonly string[];
  /** The `username <peer> password <pw>` password (default `SECRET`; null = no username line). */
  readonly password?: string | null;
  /** Extra interface lines (after the PPP lines). */
  readonly extra?: readonly string[];
  /** Extra global lines (after the username line). */
  readonly global?: readonly string[];
}

/** The world's options. */
export interface WorldOptions {
  readonly r1?: EndOptions;
  readonly r2?: EndOptions;
  readonly seed?: number;
  /** Run to idle after building (default true). */
  readonly settle?: boolean;
}

/** The startup configuration of one router of §3.9. */
export function pppStartup(name: string, peer: string, address: string, dce: boolean, o: EndOptions = {}): string {
  const lines = [`hostname ${name}`, '!'];
  const pw = o.password === undefined ? SECRET : o.password;
  if (pw !== null) lines.push(`username ${peer} password ${pw}`, '!');
  for (const g of o.global ?? []) lines.push(g, '!');
  lines.push(`interface ${SE0}`, ` ip address ${address} ${MASK30}`, ...(o.ppp ?? PPP_CHAP), ...(dce ? [` clock rate ${CLOCK_BPS}`] : []), ...(o.extra ?? []), ' no shutdown', '!');
  lines.push('end', '');
  return lines.join('\n');
}

/** The §3.9 world on `staged.world` at stage P3 (run to idle unless `settle` is false). */
export function pppWorld(o: WorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 19, stage: 'P3', factories: PPP_ACCEPT_FACTORIES });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: pppStartup('R1', 'R2', '10.1.1.1', true, o.r1) });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: pppStartup('R2', 'R1', '10.1.1.2', false, o.r2) });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  if (o.settle !== false) sim.runToIdle();
  return sim;
}

/** The `ppp` row of a router's Se0/0/0. */
export const pppRow = (sim: Simulation, d: string): PppRow | undefined => sim.device(d)!.tables.get<PppRow>('ppp')?.get(SE0);
/** A router's Se0/0/0. */
export const serial = (sim: Simulation, d: string) => sim.device(d)!.port(SE0)!;

/** Apply one stored line on `device` at `sim.now` (the device clock synced first, as the facade does). */
export function applyLine(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): void {
  const d = sim.device(device)!;
  d.applyActions('sim', [], sim.now);
  const r = d.applyConfigLine(context, tokens, negate);
  if (!r.ok) throw new Error(`${device}: ${tokens.join(' ')} refused: ${r.error ?? ''}`);
}

/** Open an enabled console on `device` and run one exec command; returns its output. */
export function exec(sim: Simulation, device: string, line: string): string {
  const s = sim.cli.open(device, 'console');
  sim.cli.exec(s, 'enable');
  return sim.cli.exec(s, line).output;
}

/** One frame on the serial cable, decoded. */
export interface WireFrame {
  readonly pdu: number;
  /** The sending router's id ('r1' | 'r2'). */
  readonly from: string;
  readonly txStart: SimTime;
  readonly txEnd: SimTime;
  readonly arrive: SimTime;
  /** The layer after the framing ('lcp', 'chap', 'ipcp', 'ipv4', …; the framing's own name when it carries none). */
  readonly proto: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** The framing layer ('ppp' or 'hdlc'). */
  readonly framing: string;
  /** The framing layer's protocol field. */
  readonly protocol: unknown;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly background: boolean;
  readonly tag?: string;
}

/** Every frame transmitted on the serial cable among `evs`, in trace order. */
export function wireFrames(sim: Simulation, evs: readonly TraceEvent[]): WireFrame[] {
  const out: WireFrame[] = [];
  for (const e of ofKind(evs, 'frameTx')) {
    const v = sim.pdu(e.pdu.id);
    if (v === undefined) throw new Error(`pdu ${e.pdu.id} is no longer retained`);
    const outer = v.layers[0]!;
    const inner = v.layers[1];
    const f: WireFrame = {
      pdu: e.pdu.id,
      from: e.from.device,
      txStart: e.txStart,
      txEnd: e.txEnd,
      arrive: e.arrive,
      proto: inner?.proto ?? outer.proto,
      fields: (inner?.fields ?? {}) as Record<string, unknown>,
      framing: outer.proto,
      protocol: outer.fields.protocol,
      size: v.size,
      bytes: v.bytes,
      background: e.background === true,
      ...(e.pdu.tag !== undefined ? { tag: e.pdu.tag } : {}),
    };
    out.push(f);
  }
  return out;
}

const CHAP_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'challenge', 2: 'response', 3: 'success', 4: 'failure' });
const PAP_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'authenticate-request', 2: 'authenticate-ack', 3: 'authenticate-nak' });

/** `R1 LCP configure-request id 1` — the sender, the protocol and its packet. */
export function frameLabel(f: WireFrame): string {
  const who = f.from.toUpperCase();
  const code = typeof f.fields.code === 'number' ? f.fields.code : -1;
  const id = String(f.fields.id);
  switch (f.proto) {
    case 'lcp':
      return `${who} LCP ${pppCpCodeText(code)} id ${id}`;
    case 'ipcp':
      return `${who} IPCP ${pppCpCodeText(code)} id ${id}`;
    case 'ipv6cp':
      return `${who} IPv6CP ${pppCpCodeText(code)} id ${id}`;
    case 'chap':
      return `${who} CHAP ${CHAP_TEXT[code] ?? `code ${code}`} id ${id}`;
    case 'pap':
      return `${who} PAP ${PAP_TEXT[code] ?? `code ${code}`} id ${id}`;
    default:
      return `${who} ${f.framing}/${f.proto}`;
  }
}

/**
 * Frames in canonical order: by transmit start, then sender. Both ends act at the same instants in §3.9 ("both ends
 * at once"), so the order of two frames that start together is the sender's name, never the scheduler's tie-break.
 */
export function canonical(frames: readonly WireFrame[]): WireFrame[] {
  return [...frames].sort((a, b) => a.txStart - b.txStart || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** The wire time of a frame of `size` bytes at the §3.9 clock rate (the line overhead included). */
export const wireNs = (size: number): SimTime => serializationNs(size + SERIAL_OVERHEAD, CLOCK_BPS);

/** The FSM moves of `machine` on `device` among `evs`, as `subject: from->to`. */
export function fsmMoves(evs: readonly TraceEvent[], device: string, machine: string): string[] {
  return ofKind(evs, 'debug')
    .filter((e) => e.event.device === device && e.event.fsm?.machine === machine)
    .map((e) => `${e.event.fsm!.subject}: ${e.event.fsm!.from}->${e.event.fsm!.to}`);
}

/** The times of the FSM moves of `machine` on `device` into `to`. */
export function fsmTimes(evs: readonly TraceEvent[], device: string, machine: string, to: string): SimTime[] {
  return ofKind(evs, 'debug')
    .filter((e) => e.event.device === device && e.event.fsm?.machine === machine && e.event.fsm.to === to)
    .map((e) => e.t);
}

/** The UTF-8 bytes of `s`. */
export const asciiOf = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** The first offset of `needle` in `hay`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** JSON of a value with byte arrays written as number lists (trace and snapshot text). */
export function jsonOf(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? Array.from(x) : x));
}
