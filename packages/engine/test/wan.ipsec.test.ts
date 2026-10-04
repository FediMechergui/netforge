/**
 * wan.ipsec [C13] — a site-to-site IPsec VTI on `staged.world` (ARCHITECTURE-P3 D27, §2.17, §3.13, §4.2, §4.3; §7 W3
 * wan): the ike daemon (IKEv2-lite over UDP 500, `protocols/ike.ts`) and the ipsec mode of the tunnel owner
 * (`protocols/gre.ts`), at their seam (`ike.connect` / `tunnel.sa`): the SA comes up (crossing initiations resolved by
 * the lower address, whichever request arrives first), the protected ping (ESP head and tail, one PduId), only ESP
 * between the peers, the failures §3.13 step 10 names (a wrong key and its periodic retry; with an unknown peer and a
 * silent peer, §4.2), the IPsec MTU fallback (step 11), the protection lifecycle and silence (§4.3).
 *
 * §3.13's world: PC1 — R1 Gi0/0; R1 Se0/0/0 209.165.200.225/30 — ISP — R2 Se0/0/0 209.165.200.230/30; R2 Gi0/0 — PC2.
 * The ISP has no private routes; each router's default route points at the ISP; Tunnel0 is a VTI protected by
 * `crypto ipsec profile VPN` → `crypto ikev2 profile PROF` → `crypto ikev2 keyring KR`. A test-only frame injector
 * (test/inject.ts) on R1 Gi0/1 supplies the DF datagrams no host shell sends (sourced from PC1's address, so PC1
 * receives the ICMP 3/4).
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRow } from '../src/contracts/capture.js';
import { ETHERTYPE_IPV4, IPPROTO_ESP, IPPROTO_ICMP, IPPROTO_UDP, type LayerSpec } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { IpsecSaRow, SocketRow, TunnelRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createGre, greMtuDetail, ipsecNoSaDetail } from '../src/protocols/gre.js';
import { createIke, IKE_SOCKET, ikeAuthFailureMessage } from '../src/protocols/ike.js';
import {
  IKE_AUTH,
  IKE_FLAG_INITIATOR,
  IKE_FLAG_RESPONSE,
  IKE_PROPOSAL,
  IKE_PROPOSAL_LABEL,
  IKE_SA_INIT,
  IKE_SPI_ZERO,
  IKE_TRAFFIC_SELECTOR,
  ikeChildSpiOf,
} from '../src/protocols/ike/exchange.js';
import { ikeKeyFor, ikeKeyText, readIkeConfig } from '../src/protocols/ike/config.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import { encodeReversibleSecret } from '../src/cli/secrets.js';
import { INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { ping } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const TU0 = 'Tunnel0';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MASK30 = '255.255.255.252';
const MASK24 = '255.255.255.0';
const R1_ADDR = '209.165.200.225';
const R2_ADDR = '209.165.200.230';
const PUBLIC = new Set([R1_ADDR, '209.165.200.226', '209.165.200.229', R2_ADDR]);
const KEY = 'Nf-Site-Key-25';
const WRONG_KEY = 'Nf-Other-Key-99';
const KEYRING_CTX = (peer: string): string[][] => [['crypto', 'ikev2', 'keyring', 'KR'], ['peer', peer]];

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** The three crypto sections of one end (§3.13 setup). */
const cryptoSections = (peerName: string, peer: string, key: string, keyringAddress = peer): string[][] => [
  ['crypto ikev2 keyring KR', ` peer ${peerName}`, `  address ${keyringAddress}`, `  pre-shared-key ${key}`],
  ['crypto ikev2 profile PROF', ` match identity remote address ${peer} 255.255.255.255`, ' authentication remote pre-share', ' authentication local pre-share', ' keyring local KR'],
  ['crypto ipsec profile VPN', ' set ikev2-profile PROF'],
];

const tunnelLines = (address: string, destination: string, protection: string | undefined): string[] => [
  ` ip address ${address} ${MASK30}`,
  ` tunnel source ${SE0}`,
  ` tunnel destination ${destination}`,
  ' tunnel mode ipsec ipv4',
  ...(protection === undefined ? [] : [` tunnel protection ipsec profile ${protection}`]),
];

interface IpsecWorldOptions {
  /** R2's pre-shared key (default KEY). */
  readonly r2Key?: string;
  /** The address of R2's keyring peer (default R1's address). */
  readonly r2KeyringPeer?: string;
  /** R1's / R2's `tunnel protection` profile (default 'VPN'; null = no protection line). */
  readonly r1Protection?: string | null;
  readonly r2Protection?: string | null;
  /** R2 without crypto sections and without Tunnel0 (a silent peer). */
  readonly r2Silent?: boolean;
}

/** The §3.13 world plus the injector on R1 Gi0/1, run to idle (which must return). */
function ipsecWorld(opts: IpsecWorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: 25, stage: 'P3', factories: withInjector({ gre: createGre, ike: createIke }) });
  const r1p = opts.r1Protection === null ? undefined : (opts.r1Protection ?? 'VPN');
  const r2p = opts.r2Protection === null ? undefined : (opts.r2Protection ?? 'VPN');
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      [`interface ${GI0}`, ` ip address 192.168.1.1 ${MASK24}`, ' no shutdown'],
      [`interface ${GI1}`, ` ip address 192.168.3.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address ${R1_ADDR} ${MASK30}`, ' no shutdown'],
      ...cryptoSections('R2', R2_ADDR, KEY),
      [`interface ${TU0}`, ...tunnelLines('172.16.0.1', R2_ADDR, r1p)],
      ['ip route 0.0.0.0 0.0.0.0 209.165.200.226', `ip route 192.168.2.0 ${MASK24} ${TU0}`],
    ]),
  });
  sim.addDevice({
    id: 'isp', type: 'router.nf2911', name: 'ISP',
    startupConfig: startup([
      ['hostname ISP'],
      [`interface ${SE0}`, ' ip address 209.165.200.226 255.255.255.252', ' clock rate 2000000', ' no shutdown'],
      [`interface ${SE1}`, ' ip address 209.165.200.229 255.255.255.252', ' clock rate 2000000', ' no shutdown'],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      [`interface ${GI0}`, ` ip address 192.168.2.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address ${R2_ADDR} ${MASK30}`, ' no shutdown'],
      ...(opts.r2Silent === true
        ? [['ip route 0.0.0.0 0.0.0.0 209.165.200.229']]
        : [
            ...cryptoSections('R1', R1_ADDR, opts.r2Key ?? KEY, opts.r2KeyringPeer ?? R1_ADDR),
            [`interface ${TU0}`, ...tunnelLines('172.16.0.2', R1_ADDR, r2p)],
            ['ip route 0.0.0.0 0.0.0.0 209.165.200.229', `ip route 192.168.1.0 ${MASK24} ${TU0}`, `ip route 192.168.3.0 ${MASK24} ${TU0}`],
          ]),
    ]),
  });
  const pc = (name: string, addr: string, gw: string): string =>
    startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${addr} ${MASK24}`], [`ip default-gateway ${gw}`]]);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', '192.168.1.10', '192.168.1.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', '192.168.2.10', '192.168.2.1') });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI1 } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'isp', port: SE0 }, dceEnd: 'b' });
  sim.addLink({ a: { device: 'isp', port: SE1 }, b: { device: 'r2', port: SE0 }, dceEnd: 'a' });
  sim.addLink({ a: { device: 'r2', port: GI0 }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

// ── readers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const saRow = (sim: Simulation, device: string): IpsecSaRow | undefined => sim.device(device)!.tables.get<IpsecSaRow>('ipsec-sa')?.get(TU0);
const tunnelRow = (sim: Simulation, device: string): TunnelRow | undefined => sim.device(device)!.tables.get<TunnelRow>('tunnels')?.get(TU0);
const tunnelUp = (sim: Simulation, device: string): boolean => sim.device(device)!.port(TU0)!.operUp;
const ikeSocket = (sim: Simulation, device: string): SocketRow | undefined =>
  sim.device(device)!.tables.get<SocketRow>('sockets')?.rows().find((r) => r.id === IKE_SOCKET);
const greView = (sim: Simulation, device: string): Record<string, unknown> =>
  (sim.device(device)!.stateSnapshots().find((v) => v.process === 'gre')!.state as { tunnels: Record<string, unknown>[] }).tunnels[0]!;

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Mut = { device: string; reason: string; field: string; before: unknown; after: unknown; cause?: string };

/** The IKE messages created by the ike daemons in `evs`, as [device, fields, meta] in creation order. */
function ikeMessages(sim: Simulation, evs: readonly TraceEvent[]): { device: string; f: Record<string, unknown>; protectedBy?: string; outer: Record<string, unknown>; udp: Record<string, unknown> }[] {
  return evs
    .filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike')
    .map((e) => {
      const p = sim.pdu(e.pdu.id)!;
      const m: { device: string; f: Record<string, unknown>; protectedBy?: string; outer: Record<string, unknown>; udp: Record<string, unknown> } = {
        device: e.device,
        f: { ...p.layer('ikev2')!.fields },
        outer: { ...p.layer('ipv4')!.fields },
        udp: { ...p.layer('udp')!.fields },
      };
      if (p.meta.protected === true) m.protectedBy = p.meta.protectedBy ?? 'dtls';
      return m;
    });
}

/** [device, from, to, cause] of every `ike` FSM transition in `evs`. */
const ikeTransitions = (evs: readonly TraceEvent[]): [string, string, string, string][] =>
  evs.flatMap((e) => (e.kind === 'debug' && e.event.fsm?.machine === 'ike' ? [[e.event.device, e.event.fsm.from, e.event.fsm.to, e.event.fsm.cause ?? '']] : []));

/** Apply one stored line on `device` at `sim.now` (the device clock synced first, as the facade does). */
function apply(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): void {
  const d = sim.device(device)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, tokens, negate)).toEqual({ ok: true });
}

/** Apply one stored line, then run to idle (which must return); the events of both. */
function line(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): TraceEvent[] {
  const cursor = sim.trace(0).next;
  apply(sim, device, context, tokens, negate);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim.trace(cursor).events;
}

const containsAscii = (bytes: Uint8Array, text: string): boolean => {
  const needle = Array.from(text, (ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
};

// ── the key lookup ───────────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: the key of a protected tunnel (protocols/ike/config.ts)', () => {
  it('IPsec profile → IKEv2 profile (identity) → keyring peer; the first broken link names the outcome', () => {
    const lookup = (sections: readonly (readonly string[])[], profile = 'VPN', peer = R2_ADDR): string => {
      const sim = createStagedSimulation({ seed: 1, stage: 'P3', factories: { gre: createGre, ike: createIke } });
      sim.addDevice({ id: 'r', type: 'router.nf2911', name: 'R', startupConfig: startup([['hostname R'], ...sections]) });
      expect(sim.runToIdle().stopped).toBeUndefined();
      const look = ikeKeyFor(readIkeConfig(sim.device('r')!.running.root), profile, peer);
      return look.status === 'ok' ? `ok:${look.key}` : look.status;
    };
    const [keyring, prof, ipsec] = cryptoSections('R2', R2_ADDR, KEY);
    expect(lookup([keyring!, prof!, ipsec!])).toBe(`ok:${KEY}`);
    expect(lookup([keyring!, prof!, ipsec!], 'OTHER')).toBe('no-ipsec-profile');
    expect(lookup([keyring!, prof!, ['crypto ipsec profile VPN']])).toBe('no-ikev2-profile');
    expect(lookup([keyring!, ipsec!])).toBe('no-ikev2-profile');
    expect(lookup([keyring!, prof!, ipsec!], 'VPN', '209.165.200.99')).toBe('identity-mismatch');
    expect(lookup([keyring!, ['crypto ikev2 profile PROF', ' match identity remote address 209.165.200.0 255.255.255.0'], ipsec!], 'VPN', '209.165.200.99')).toBe('no-keyring');
    expect(lookup([keyring!, ['crypto ikev2 profile PROF', ' keyring local KR'], ipsec!], 'VPN', '209.165.200.99')).toBe('no-peer');
    expect(lookup([['crypto ikev2 keyring KR', ' peer R2', `  address ${R2_ADDR}`], prof!, ipsec!])).toBe('no-peer');
    // a reversibly encoded value is compared as its plain text
    expect(ikeKeyText(['nf7', encodeReversibleSecret(KEY).slice(4)])).toBe(KEY);
    expect(ikeKeyText([encodeReversibleSecret(KEY)])).toBe(KEY);
    expect(ikeKeyText([KEY])).toBe(KEY);
  });
});

// ── the SA comes up ──────────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: the SA comes up (§3.13 steps 1–6)', () => {
  it('the underlay asks ike for an SA; both ends initiate; the lower address keeps its exchange; four messages establish the SA; Tunnel0 comes up after it', () => {
    const sim = ipsecWorld();
    const evs = sim.trace(0).events;
    // step 1: the underlay is ready → tunnels {ipsec, down ike-negotiating, 1500 / 1456}, then ipsec-sa negotiating
    const writes = (device: string, table: string): Record<string, unknown>[] =>
      evs.flatMap((e) => (e.kind === 'tableWrite' && e.device === device && e.table === table ? [e.row] : []));
    const r1Tunnels = writes('r1', 'tunnels');
    const negotiating = r1Tunnels.findIndex((r) => r.reason === 'ike-negotiating');
    expect(r1Tunnels[negotiating]).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-negotiating', transportMtu: 1500, ipMtu: 1456, source: R1_ADDR, destination: R2_ADDR });
    expect(writes('r1', 'ipsec-sa')[0]).toEqual({
      key: TU0, port: TU0, local: R1_ADDR, peer: R2_ADDR, profile: 'VPN', role: 'initiator', state: 'negotiating', since: expect.any(Number), updatedAt: expect.any(Number),
    });
    // steps 2–5: both ends initiate in the same instant; R2 abandons its own exchange and answers R1's
    const msgs = ikeMessages(sim, evs);
    expect(msgs.map((m) => [m.device, m.f.exchange, m.f.flags, m.f.messageId, m.protectedBy ?? null])).toEqual([
      ['r1', IKE_SA_INIT, IKE_FLAG_INITIATOR, 0, null],
      ['r2', IKE_SA_INIT, IKE_FLAG_INITIATOR, 0, null],
      ['r2', IKE_SA_INIT, IKE_FLAG_RESPONSE, 0, null],
      ['r1', IKE_AUTH, IKE_FLAG_INITIATOR, 1, 'ike'],
      ['r2', IKE_AUTH, IKE_FLAG_RESPONSE, 1, 'ike'],
    ]);
    for (const m of msgs) {
      expect(m.udp).toMatchObject({ srcPort: 500, dstPort: 500 });
      expect(m.outer).toMatchObject({ protocol: IPPROTO_UDP, src: m.device === 'r1' ? R1_ADDR : R2_ADDR, dst: m.device === 'r1' ? R2_ADDR : R1_ADDR });
    }
    const [init, crossing, initResp, auth, authResp] = msgs.map((m) => m.f);
    expect(init).toMatchObject({ spiR: IKE_SPI_ZERO, sa: IKE_PROPOSAL, version: 0x20 });
    expect(init!.spiI).toMatch(/^[0-9a-f]{16}$/);
    expect(init!.ke).toMatch(/^[0-9a-f]{64}$/);
    expect(init!.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(crossing!.spiI).not.toBe(init!.spiI);
    expect(initResp).toMatchObject({ spiI: init!.spiI, sa: IKE_PROPOSAL });
    expect(initResp!.spiR).toMatch(/^[0-9a-f]{16}$/);
    expect(initResp!.spiR).not.toBe(IKE_SPI_ZERO);
    expect(auth).toMatchObject({ spiI: init!.spiI, spiR: initResp!.spiR, idi: R1_ADDR, tsi: IKE_TRAFFIC_SELECTOR, tsr: IKE_TRAFFIC_SELECTOR });
    expect(auth!.auth).toMatch(/^[0-9a-f]{32}$/);
    expect(authResp).toMatchObject({ spiI: init!.spiI, spiR: initResp!.spiR, idr: R2_ADDR, tsi: IKE_TRAFFIC_SELECTOR, tsr: IKE_TRAFFIC_SELECTOR });
    expect(authResp!.auth).not.toBe(auth!.auth);
    // the crossing rule (D27): R1 (the lower address) discards R2's request with a crypto ikev2 line; R2 answers R1's
    const r1Debug = evs.flatMap((e) => (e.kind === 'debug' && e.event.device === 'r1' && e.event.process === 'ike' ? [[e.event.category, e.event.message]] : []));
    expect(r1Debug).toContainEqual(['crypto ikev2', `${TU0}: crossing IKE_SA_INIT from ${R2_ADDR} discarded: the lower address ${R1_ADDR} keeps its own exchange`]);
    expect(ikeTransitions(evs)).toEqual([
      ['r1', 'idle', 'init-sent', 'exchange started'],
      ['r2', 'idle', 'init-sent', 'exchange started'],
      ['r2', 'init-sent', 'init-answered', `crossing request from the lower address ${R1_ADDR}`],
      ['r1', 'init-sent', 'auth-sent', 'IKE_SA_INIT answered'],
      ['r2', 'init-answered', 'established', 'initiator authenticated'],
      ['r1', 'auth-sent', 'established', 'responder authenticated'],
    ]);
    // the rows: one IKE SA (same SPIs), crosswise ESP SPIs, the fixed proposal
    const r1 = saRow(sim, 'r1')!;
    const r2 = saRow(sim, 'r2')!;
    expect(r1).toMatchObject({ local: R1_ADDR, peer: R2_ADDR, profile: 'VPN', role: 'initiator', state: 'established', ikeSpiI: init!.spiI, ikeSpiR: initResp!.spiR, proposal: IKE_PROPOSAL_LABEL });
    expect(r2).toMatchObject({ local: R2_ADDR, peer: R1_ADDR, profile: 'VPN', role: 'responder', state: 'established', ikeSpiI: init!.spiI, ikeSpiR: initResp!.spiR, proposal: IKE_PROPOSAL_LABEL });
    expect(r1.reason).toBeUndefined();
    expect(r1.espSpiIn).toBe(ikeChildSpiOf(auth!.sa as string));
    expect(r2.espSpiIn).toBe(ikeChildSpiOf(authResp!.sa as string));
    expect([r1.espSpiOut, r2.espSpiOut]).toEqual([r2.espSpiIn, r1.espSpiIn]);
    expect(Math.min(r1.espSpiIn!, r2.espSpiIn!)).toBeGreaterThanOrEqual(0x100);
    // step 6: each Tunnel0 comes up in the dispatch of its own SA; C and the static through the tunnel follow
    for (const d of ['r1', 'r2']) {
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'up', transportMtu: 1500, ipMtu: 1456 });
      expect(tunnelRow(sim, d)!.reason).toBeUndefined();
      expect(tunnelRow(sim, d)!.since).toBe(saRow(sim, d)!.since);
      expect(tunnelUp(sim, d)).toBe(true);
      expect(ikeSocket(sim, d)).toMatchObject({ proto: 'udp', localPort: 500, owner: 'ike' });
      expect(sim.device(d)!.stateSnapshots().find((v) => v.process === 'ike')!.state).toEqual({ exchanges: [] });
    }
    expect(r2.since).toBeLessThan(r1.since);
    const rib = sim.device('r1')!.tables.rib;
    expect(rib.get('172.16.0.0/30')).toMatchObject({ source: 'C', iface: TU0 });
    expect(rib.get('192.168.2.0/24')).toMatchObject({ source: 'S', iface: TU0 });
    expect(sim.device('isp')!.tables.rib.rows().filter((r) => r.network.startsWith('192.168.') || r.network.startsWith('172.16.'))).toEqual([]);
  });

  it('whichever request arrives first, the outcome is the same: R1 (the lower address) initiates, R2 answers (D27)', () => {
    const outcome = (first: 'r1' | 'r2'): unknown => {
      const sim = ipsecWorld({ r1Protection: null, r2Protection: null });
      expect([tunnelRow(sim, 'r1')!.reason, tunnelRow(sim, 'r2')!.reason]).toEqual(['ike-negotiating', 'ike-negotiating']);
      const cursor = sim.trace(0).next;
      const second = first === 'r1' ? 'r2' : 'r1';
      apply(sim, first, [['interface', TU0]], ['tunnel', 'protection', 'ipsec', 'profile', 'VPN']);
      sim.runFor(500 * MS);
      apply(sim, second, [['interface', TU0]], ['tunnel', 'protection', 'ipsec', 'profile', 'VPN']);
      expect(sim.runToIdle().stopped).toBeUndefined();
      const evs = sim.trace(cursor).events;
      // the first request found no listener at the other end (its port 500 was not open yet) and was sent again
      const requests = ikeMessages(sim, evs).filter((m) => m.f.exchange === IKE_SA_INIT && m.f.flags === IKE_FLAG_INITIATOR);
      expect(requests[0]!.device).toBe(first);
      expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!!!');
      return ['r1', 'r2'].map((d) => [saRow(sim, d)!.role, saRow(sim, d)!.state, tunnelRow(sim, d)!.state]);
    };
    const expected = [['initiator', 'established', 'up'], ['responder', 'established', 'up']];
    expect(outcome('r1')).toEqual(expected);
    expect(outcome('r2')).toEqual(expected);
  });
});

// ── the protected ping ───────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: the protected ping (§3.13 steps 7–9)', () => {
  it('PC1 pings PC2 5/5: one PduId end to end, ESP head at R1 (Encrypt), routed by the ISP on the outer header, ESP tail at R2 (Decrypt)', () => {
    const sim = ipsecWorld();
    const r = ping(sim, 'pc1', '192.168.2.10');
    expect(r.text).toContain('!!!!!');
    expect(r.text).toContain('received 5');
    const echo = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.includes('echo request'))!;
    const id = echo.pdu.id;
    const pdu = sim.pdu(id)!;
    const muts = pdu.provenance as readonly Mut[];
    const at = (d: string) => muts.filter((m) => m.device === d && m.reason !== 'ChecksumRecompute' && m.reason !== 'FcsRecompute').map((m) => [m.reason, m.field, m.cause ?? '']);
    const cause = `interface ${TU0}`;
    // R1: the inner TTL by the static through Tunnel0; then the head: Decapsulate ethernet, Encapsulate esp, Encrypt,
    // Encapsulate ipv4 (cause interface Tunnel0), and the serial framing
    expect(at('r1')).toEqual([
      ['TtlDecrement', 'ipv4.ttl', `ip route 192.168.2.0 ${MASK24} ${TU0}`],
      ['Decapsulate', 'ethernet', cause],
      ['Encapsulate', 'esp', cause],
      ['Encrypt', 'esp.keyId', cause],
      ['Encapsulate', 'ipv4', cause],
      ['Encapsulate', 'hdlc', cause],
    ]);
    // the ISP routes the OUTER header (255 → 254); R2: Decrypt, then ONE strip-only rewrap (hdlc, ipv4, esp)
    expect(at('r2').slice(0, 4)).toEqual([
      ['Decrypt', 'esp.keyId', cause],
      ['Decapsulate', 'hdlc', cause],
      ['Decapsulate', 'ipv4', cause],
      ['Decapsulate', 'esp', cause],
    ]);
    expect(muts.filter((m) => m.reason === 'TtlDecrement').map((m) => [m.device, m.before, m.after])).toEqual([
      ['r1', 128, 127],
      ['isp', 255, 254],
      ['r2', 127, 126],
    ]);
    // the Encrypt and Decrypt records name the SA's key id (both ends derived the same one), never the key
    const enc = muts.find((m) => m.reason === 'Encrypt')!;
    const dec = muts.find((m) => m.reason === 'Decrypt')!;
    expect(typeof enc.after).toBe('number');
    expect(dec.after).toBe(enc.after);
    // the legs: on the LANs 100 bytes in Ethernet (+ 18); between R1 and R2 the same PduId in IPv4 + ESP (+ 44: 20 + 8 +
    // 2 padding + 2 trailer + 12 ICV) inside HDLC (+ 6)
    const legs = r.evs.filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.pdu.id === id);
    expect(legs.map((l) => [l.from.device, l.to.device, l.pdu.size])).toEqual([
      ['pc1', 'r1', 100 + 18],
      ['r1', 'isp', 100 + 44 + 6],
      ['isp', 'r2', 100 + 44 + 6],
      ['r2', 'pc2', 100 + 18],
    ]);
    expect(r.evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === id)).toBe(true);
    // the tail cleared the protected mark
    expect(pdu.meta.protected).toBeUndefined();
    expect(pdu.meta.protectedBy).toBeUndefined();
    // the counters: five out and five in at each end, on each end's own SA from sequence 1
    for (const d of ['r1', 'r2']) {
      expect(greView(sim, d)).toEqual({ port: TU0, mode: 'ipsec', state: 'up', encaps: 5, decaps: 5, mtuDrops: 0, mssClamped: 0, seqOut: 5, lastSeqIn: 5, noSa: 0 });
    }
    expect(sim.device('r1')!.port(TU0)!.counters.outPackets).toBeGreaterThanOrEqual(5);
    expect(sim.device('r2')!.port(TU0)!.counters.inPackets).toBeGreaterThanOrEqual(5);
  });

  it('the provider sees only ESP (step 8): every frame at the ISP is IPv4 protocol 50 between the public addresses; the replies run on R2\'s SA from sequence 1', () => {
    const sim = ipsecWorld();
    const cap = sim.startCapture!({ ports: [{ device: 'isp', port: SE0 }, { device: 'isp', port: SE1 }], name: 'ISP' });
    expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!!!');
    const head = sim.captures!().find((c) => c.id === cap)!.head;
    const all: CaptureRow[] = sim.queryCapture!(cap, { from: 0, limit: 1000 }).rows;
    expect(all).toHaveLength(head);
    expect(all).toHaveLength(20); // 5 requests and 5 replies, each seen arriving at one ISP port and leaving the other
    const r1 = saRow(sim, 'r1')!;
    const r2 = saRow(sim, 'r2')!;
    const fromR2: { spi: number; seq: number }[] = [];
    for (const row of all) {
      const rec = sim.captureRecord!(cap, row.index)!;
      expect(rec.layers.slice(0, 4).map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4']);
      const outer = rec.layers[1]!.fields;
      expect(outer.protocol).toBe(IPPROTO_ESP);
      expect(PUBLIC.has(String(outer.src)) && PUBLIC.has(String(outer.dst))).toBe(true);
      const esp = rec.layers[2]!.fields;
      expect(esp.spi).toBe(outer.src === R1_ADDR ? r1.espSpiOut : r2.espSpiOut);
      expect(esp.icvValid).toBe(true);
      if (outer.src === R2_ADDR && row.dir === 'rx') fromR2.push({ spi: Number(esp.spi), seq: Number(esp.seq) });
    }
    expect(fromR2).toEqual([1, 2, 3, 4, 5].map((seq) => ({ spi: r1.espSpiIn, seq })));
    // the display filter `esp` matches every record
    expect(sim.queryCapture!(cap, { filter: 'esp', from: 0, limit: 1000 }).matched).toBe(20);
  });

  it('inside the provider the packet is marked protected by ESP: a ping dropped at the ISP keeps the mark', () => {
    const sim = ipsecWorld();
    // the ISP loses its link to R2: R1 still holds its SA (no dead-peer detection) and encrypts; the ISP has no route
    line(sim, 'isp', [['interface', SE1]], ['shutdown']);
    expect(tunnelUp(sim, 'r1')).toBe(true);
    const r = ping(sim, 'pc1', '192.168.2.10');
    const echo = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.includes('echo request'))!;
    const drop = r.evs.find((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.pdu.id === echo.pdu.id)!;
    expect([drop.device, drop.reason]).toEqual(['isp', 'no-route']);
    const pdu = sim.pdu(echo.pdu.id)!;
    expect(pdu.meta).toMatchObject({ protected: true, protectedBy: 'esp' });
    expect(pdu.layers.map((l) => l.proto).slice(0, 3)).toEqual(['hdlc', 'ipv4', 'esp']);
  });
});

// ── failures ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: the ESP legs are tagged (ruling R36, W3 fix step)', () => {
  it('every leg of the protected ping inside the provider carries tunnel ipsec in its frameTx summary; the LAN legs none', () => {
    const sim = ipsecWorld();
    const r = ping(sim, 'pc1', '192.168.2.10');
    expect(r.text).toContain('!!!!!');
    const echo = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.includes('echo request'))!;
    const legs = r.evs.filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.pdu.id === echo.pdu.id);
    const inProvider = (e: Extract<TraceEvent, { kind: 'frameTx' }>): boolean => e.from.device === 'isp' || e.to.device === 'isp';
    expect(legs.filter(inProvider).length).toBeGreaterThanOrEqual(2);
    for (const l of legs.filter(inProvider)) expect(l.pdu.tunnel).toBe('ipsec');
    const lan = legs.filter((l) => !inProvider(l));
    expect(lan.length).toBeGreaterThan(0);
    for (const l of lan) expect(l.pdu.tunnel).toBeUndefined();
  });
});

describe('wan.ipsec [C13]: failures (§3.13 step 10; §4.2)', () => {
  it('a wrong key: AUTHENTICATION_FAILED, failed rows, a severity-4 log on both ends, Tunnel0 down ike-failed; the ping falls back to the default route and the ISP answers unreachable', () => {
    const sim = ipsecWorld({ r2Key: WRONG_KEY });
    const evs = sim.trace(0).events;
    const msgs = ikeMessages(sim, evs);
    const refusal = msgs.find((m) => m.device === 'r2' && m.f.exchange === IKE_AUTH)!;
    expect(refusal.f).toMatchObject({ flags: IKE_FLAG_RESPONSE, messageId: 1, notify: 'AUTHENTICATION_FAILED' });
    expect(refusal.f.auth).toBeUndefined();
    expect(saRow(sim, 'r1')).toMatchObject({ role: 'initiator', state: 'failed', reason: 'ike-failed' });
    expect(saRow(sim, 'r2')).toMatchObject({ role: 'responder', state: 'failed', reason: 'ike-failed' });
    expect(saRow(sim, 'r1')!.espSpiOut).toBeUndefined();
    for (const [d, peer] of [['r1', R2_ADDR], ['r2', R1_ADDR]] as const) {
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-failed', ipMtu: 1456 });
      expect(tunnelUp(sim, d)).toBe(false);
      expect(evs.filter((e) => e.kind === 'log' && e.device === d && e.facility === 'IKE').map((e) => (e as { severity: number; message: string }))).toEqual([
        expect.objectContaining({ severity: 4, message: ikeAuthFailureMessage(TU0, peer) }),
      ]);
    }
    expect(ikeTransitions(evs).filter(([, , to]) => to === 'failed').map(([d, from]) => [d, from])).toEqual([
      ['r2', 'init-answered'],
      ['r1', 'auth-sent'],
    ]);
    // the route through the down tunnel is gone, so PC1's ping follows R1's default route, in clear, to the ISP
    expect(sim.device('r1')!.tables.rib.get('192.168.2.0/24')).toBeUndefined();
    const r = ping(sim, 'pc1', '192.168.2.10');
    expect(r.text).not.toContain('!');
    const echo = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.includes('echo request'))!;
    const drop = r.evs.find((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.pdu.id === echo.pdu.id)!;
    expect([drop.device, drop.reason]).toEqual(['isp', 'no-route']);
    expect((sim.pdu(echo.pdu.id)!.provenance as readonly Mut[]).some((m) => m.reason === 'Encrypt')).toBe(false);
    const unreach = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'isp' && e.process === 'icmpv4')!;
    expect(sim.pdu(unreach.pdu.id)!.layer('icmpv4')!.fields).toMatchObject({ type: 3 });
    expect(sim.pdu(unreach.pdu.id)!.layer('ipv4')!.fields).toMatchObject({ dst: '192.168.1.10' });
  });

  it('the periodic retry repeats the exchange every 10 s without holding runToIdle; the corrected key comes up at the next retry; the key is in no PDU byte, row or view', () => {
    const sim = ipsecWorld({ r2Key: WRONG_KEY });
    const t0 = sim.now;
    const cursor = sim.trace(0).next;
    sim.runFor(60 * SEC);
    const evs = sim.trace(cursor).events;
    // Both ends failed within one serial transit of each other (R2 when it refused, R1 when the refusal arrived), so
    // their periodic retries fire 10 s later in the same order, each before the other's request arrives: every cycle
    // is a crossing that R1 (the lower address) keeps, refused again. A cycle lasts 10 s plus the exchange, so 60 s
    // hold five cycles: ten IKE_SA_INIT requests and five refusals.
    const sent = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike').map((e) => ({ t: e.t, device: e.device, f: sim.pdu(e.pdu.id)!.layer('ikev2')!.fields }));
    const requests = sent.filter((m) => m.f.exchange === IKE_SA_INIT && m.f.flags === IKE_FLAG_INITIATOR);
    expect(requests.map((m) => m.device)).toEqual(['r2', 'r1', 'r2', 'r1', 'r2', 'r1', 'r2', 'r1', 'r2', 'r1']);
    expect(requests[1]!.t - t0).toBe(10 * SEC);
    for (let k = 0; k < requests.length; k += 2) {
      expect(requests[k + 1]!.t - requests[k]!.t).toBeLessThan(2 * MS);
      if (k + 2 < requests.length) expect(requests[k + 2]!.t - requests[k]!.t).toBeGreaterThan(10 * SEC);
    }
    expect(sent.filter((m) => m.f.notify === 'AUTHENTICATION_FAILED').map((m) => m.device)).toEqual(['r2', 'r2', 'r2', 'r2', 'r2']);
    expect(ikeTransitions(evs).filter(([, , to]) => to === 'auth-sent').map(([d]) => d)).toEqual(['r1', 'r1', 'r1', 'r1', 'r1']);
    expect(saRow(sim, 'r1')!.state).toBe('failed');
    expect(sim.runToIdle().stopped).toBeUndefined();
    // the corrected key: nothing happens before the next periodic retry, which succeeds
    apply(sim, 'r2', KEYRING_CTX('R1'), ['pre-shared-key', KEY]);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(saRow(sim, 'r2')!.state).toBe('failed');
    sim.runFor(10 * SEC);
    expect([saRow(sim, 'r1')!.state, saRow(sim, 'r2')!.state]).toEqual(['established', 'established']);
    expect([tunnelUp(sim, 'r1'), tunnelUp(sim, 'r2')]).toEqual([true, true]);
    expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!!!');
    // the keys: in no PDU byte, no table row and no process view of any device
    for (const e of sim.trace(0).events) {
      if (e.kind !== 'pduCreated') continue;
      const bytes = sim.pdu(e.pdu.id)!.bytes;
      expect(containsAscii(bytes, KEY) || containsAscii(bytes, WRONG_KEY)).toBe(false);
    }
    for (const d of ['r1', 'isp', 'r2']) {
      const dev = sim.device(d)!;
      const text = JSON.stringify([dev.tables.names().map((n) => dev.tables.get(n)?.rows()), dev.stateSnapshots()]);
      expect(text.includes(KEY) || text.includes(WRONG_KEY)).toBe(false);
    }
    // ruling R36 (W3 fix step): no trace event carries a key; the `configChange` of a `pre-shared-key` line carries the
    // masked line (`maskSecretTokens`), and no debug line, log, table write or PDU summary of the ike or gre daemons does
    const carriers = sim.trace(0).events.filter((e) => {
      const text = JSON.stringify(e, (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
      return text.includes(KEY) || text.includes(WRONG_KEY);
    });
    expect(carriers).toEqual([]);
    const keyLines = sim.trace(0).events.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange' && e.line.startsWith('pre-shared-key'));
    expect(keyLines.length).toBeGreaterThan(0);
    for (const e of keyLines) expect(e.line).toBe(`pre-shared-key ${CONFIG_SECRET_MASK}`);
    expect([keyLines.at(-1)!.device, keyLines.at(-1)!.context]).toEqual(['r2', KEYRING_CTX('R1')]);
  });

  it('an unknown peer is refused with NO_PROPOSAL_CHOSEN; a silent peer leaves three retransmissions (1, 2, 4 s) and then ike-no-response', () => {
    const unknown = ipsecWorld({ r2KeyringPeer: '209.165.200.99' });
    const refusal = ikeMessages(unknown, unknown.trace(0).events).find((m) => m.device === 'r2' && m.f.flags === IKE_FLAG_RESPONSE)!;
    expect(refusal.f).toMatchObject({ exchange: IKE_SA_INIT, notify: 'NO_PROPOSAL_CHOSEN' });
    expect(saRow(unknown, 'r1')).toMatchObject({ state: 'failed', reason: 'ike-no-proposal' });
    expect(saRow(unknown, 'r2')).toMatchObject({ state: 'failed', reason: 'ike-no-proposal' });
    expect(tunnelRow(unknown, 'r1')).toMatchObject({ state: 'down', reason: 'ike-no-proposal' });

    const silent = ipsecWorld({ r2Silent: true });
    const evs = silent.trace(0).events;
    const sent = ikeMessages(silent, evs);
    expect(sent.map((m) => [m.device, m.f.exchange, m.f.flags])).toEqual(Array.from({ length: 4 }, () => ['r1', IKE_SA_INIT, IKE_FLAG_INITIATOR]));
    const times = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike').map((e) => e.t);
    expect(times.map((t) => t - times[0]!)).toEqual([0, 1 * SEC, 3 * SEC, 7 * SEC]);
    const failed = evs.find((e) => e.kind === 'debug' && e.event.fsm?.machine === 'ike' && e.event.fsm.to === 'failed')!;
    expect(failed.t - times[0]!).toBe(15 * SEC);
    expect(saRow(silent, 'r1')).toMatchObject({ role: 'initiator', state: 'failed', reason: 'ike-no-response' });
    expect(tunnelRow(silent, 'r1')).toMatchObject({ state: 'down', reason: 'ike-no-response' });
    // the periodic retry 10 s later starts a fresh exchange (a new SPI) with a fresh retransmission schedule, and never
    // holds runToIdle
    const failedAt = silent.now;
    expect(failedAt).toBe(failed.t);
    const cursor = silent.trace(0).next;
    silent.runFor(11 * SEC);
    const retry = silent.trace(cursor).events.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike');
    expect(retry.map((e) => e.t - failedAt)).toEqual([10 * SEC, 11 * SEC]);
    const spis = retry.map((e) => silent.pdu(e.pdu.id)!.layer('ikev2')!.fields.spiI);
    expect(spis[0]).toBe(spis[1]);
    expect(spis[0]).not.toBe(sent[0]!.f.spiI);
    expect(silent.runToIdle().stopped).toBeUndefined();
  });
});

// ── the MTU fallback ─────────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: the IPsec MTU fallback (§3.13 step 11, D15)', () => {
  it('1500 bytes with DF drop mtu-exceeded at R1 (1456) and PC1 receives ICMP 3/4 with next-hop MTU 1456; 1456 bytes cross; 1457 without DF drop alone', () => {
    const sim = ipsecWorld();
    const r1Mac = sim.device('r1')!.port(GI1)!.mac;
    const injMac = sim.device('inj')!.port('GigabitEthernet0')!.mac;
    const datagram = (size: number, df: boolean): LayerSpec[] => [
      { proto: 'ethernet', fields: { dst: r1Mac, src: injMac, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', protocol: IPPROTO_ICMP, ttl: 64, flags: df ? 2 : 0, id: size } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 9, seq: size } },
      { proto: 'payload', fields: { data: new Uint8Array(size - 28) } },
    ];
    const cursor = sim.trace(0).next;
    injectFrames(sim, { from: 'inj', port: 'GigabitEthernet0', frames: [datagram(1500, true), datagram(1457, false), datagram(1456, true)], spacingNs: 10 * MS });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const injected = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.pdu.id);
    expect(injected).toHaveLength(3);
    const drops = evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.reason === 'mtu-exceeded');
    expect(drops.map((d) => [d.device, d.port, d.pdu.id, d.detail])).toEqual([
      ['r1', TU0, injected[0], greMtuDetail(1456)],
      ['r1', TU0, injected[1], greMtuDetail(1456)],
    ]);
    expect(greMtuDetail(1456)).toBe('larger than the tunnel can carry (1456 bytes); fragmentation is not simulated');
    const errors = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && e.process === 'icmpv4');
    expect(errors).toHaveLength(1);
    const icmp = sim.pdu(errors[0]!.pdu.id)!;
    expect(icmp.layer('icmpv4')!.fields).toMatchObject({ type: 3, code: 4, unused: 1456 });
    expect(icmp.layer('ipv4')!.fields).toMatchObject({ dst: '192.168.1.10' });
    expect(icmp.meta.triggeredBy).toBe(injected[0]);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc1' && e.pdu.id === errors[0]!.pdu.id)).toBe(true);
    // exactly the IP MTU crosses: 1456 + 44 = 1500 bytes on the provider's links
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === injected[2])).toBe(true);
    const leg = evs.find((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.pdu.id === injected[2] && e.from.device === 'r1' && e.to.device === 'isp')!;
    expect(leg.pdu.size).toBe(1500 + 6);
    expect(greView(sim, 'r1')).toMatchObject({ mtuDrops: 2, encaps: 1 });
  });
});

// ── lifecycle and silence ────────────────────────────────────────────────────────────────────────────────────────

describe('wan.ipsec [C13]: protection lifecycle and silence (§2.17, §4.3, D27)', () => {
  it('silence: ike opens no socket, writes no row and sends nothing without a protected tunnel; an ipsec tunnel without protection stays down ike-negotiating', () => {
    const sim = ipsecWorld({ r1Protection: null, r2Protection: null });
    const all = sim.trace(0).events;
    for (const d of ['r1', 'isp', 'r2']) {
      expect(sim.device(d)!.processes.has('ike')).toBe(true);
      expect(sim.device(d)!.tables.get('ipsec-sa')!.size).toBe(0);
      expect(ikeSocket(sim, d)).toBeUndefined();
      expect(all.filter((e) => e.kind === 'tableWrite' && e.device === d && e.table === 'ipsec-sa')).toEqual([]);
      expect(all.filter((e) => e.kind === 'debug' && e.event.device === d && e.event.process === 'ike')).toEqual([]);
    }
    expect(all.filter((e) => e.kind === 'pduCreated' && e.process === 'ike')).toEqual([]);
    for (const d of ['r1', 'r2']) {
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-negotiating', ipMtu: 1456 });
      expect(tunnelUp(sim, d)).toBe(false);
    }
    // the ISP, in the protected world too
    const prot = ipsecWorld();
    const evs = prot.trace(0).events;
    expect(prot.device('isp')!.tables.get('ipsec-sa')!.size).toBe(0);
    expect(ikeSocket(prot, 'isp')).toBeUndefined();
    expect(evs.filter((e) => (e.kind === 'debug' && e.event.device === 'isp' && e.event.process === 'ike') || (e.kind === 'pduCreated' && e.device === 'isp' && e.process === 'ike'))).toEqual([]);
  });

  it('a missing IPsec profile: the tunnel waits (negotiating, nothing sent) until the profile exists', () => {
    const sim = ipsecWorld({ r1Protection: 'SITE', r2Silent: true });
    expect(saRow(sim, 'r1')).toMatchObject({ role: 'initiator', state: 'negotiating' });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'ike-negotiating' });
    expect(ikeSocket(sim, 'r1')).toMatchObject({ localPort: 500 });
    expect(sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.process === 'ike')).toEqual([]);
    const cursor = sim.trace(0).next;
    apply(sim, 'r1', [], ['crypto', 'ipsec', 'profile', 'SITE']);
    apply(sim, 'r1', [['crypto', 'ipsec', 'profile', 'SITE']], ['set', 'ikev2-profile', 'PROF']);
    sim.runFor(1);
    const evs = sim.trace(cursor).events;
    const sent = ikeMessages(sim, evs);
    expect(sent.map((m) => [m.device, m.f.exchange, m.f.flags])).toEqual([['r1', IKE_SA_INIT, IKE_FLAG_INITIATOR]]);
    expect(saRow(sim, 'r1')).toMatchObject({ state: 'negotiating' });
    // the ike StateView: the request waiting for its answer, three retransmissions left, the first due in 1 s
    const sentAt = evs.find((e) => e.kind === 'pduCreated' && e.process === 'ike')!.t;
    expect(sim.device('r1')!.stateSnapshots().find((v) => v.process === 'ike')!.state).toEqual({ exchanges: [{ port: TU0, messageId: 0, retriesLeft: 3, nextAt: sentAt + 1 * SEC }] });
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it('a peer that lost its SA drops ESP ipsec-no-sa; protecting again replaces the established SA of the other end (D27)', () => {
    const sim = ipsecWorld();
    const before = saRow(sim, 'r1')!;
    // R2 releases its protection: its row and socket go, Tunnel0 is down negotiating; R1 keeps its SA (no DPD)
    line(sim, 'r2', [['interface', TU0]], ['tunnel', 'protection'], true);
    expect(saRow(sim, 'r2')).toBeUndefined();
    expect(ikeSocket(sim, 'r2')).toBeUndefined();
    expect(tunnelRow(sim, 'r2')).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-negotiating' });
    expect(tunnelUp(sim, 'r2')).toBe(false);
    expect(saRow(sim, 'r1')).toEqual(before);
    expect(tunnelUp(sim, 'r1')).toBe(true);
    // R1 still encrypts on its SA; R2 knows no SA with that SPI
    const r = ping(sim, 'pc1', '192.168.2.10');
    expect(r.text).not.toContain('!');
    const noSa = r.evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.reason === 'ipsec-no-sa');
    expect(noSa.map((d) => [d.device, d.detail])).toEqual(Array.from({ length: 5 }, () => ['r2', ipsecNoSaDetail(before.espSpiOut!, R1_ADDR)]));
    expect(greView(sim, 'r2')).toMatchObject({ mode: 'ipsec', state: 'down', noSa: 5, decaps: 0 });
    // R2 protects again: its new IKE_SA_INIT replaces R1's established SA; R2 initiates, R1 answers
    const evs = line(sim, 'r2', [['interface', TU0]], ['tunnel', 'protection', 'ipsec', 'profile', 'VPN']);
    expect(ikeTransitions(evs).filter(([d]) => d === 'r1').map(([, from, to]) => [from, to])).toEqual([
      ['established', 'init-answered'],
      ['init-answered', 'established'],
    ]);
    const r1 = saRow(sim, 'r1')!;
    expect(r1).toMatchObject({ role: 'responder', state: 'established' });
    expect(saRow(sim, 'r2')).toMatchObject({ role: 'initiator', state: 'established', espSpiOut: r1.espSpiIn, espSpiIn: r1.espSpiOut });
    expect(r1.ikeSpiI).not.toBe(before.ikeSpiI);
    // R1's tunnel went down while the new exchange ran, and came back
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => (e as { operUp: boolean }).operUp)).toEqual([false, true]);
    expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!!!');
    expect(greView(sim, 'r1')).toMatchObject({ seqOut: 5, lastSeqIn: 5 });
  });

  it('determinism: one seed replays the exchange and a protected ping byte for byte (§4.1: no stream is drawn)', () => {
    const run = (): string => {
      const sim = ipsecWorld();
      ping(sim, 'pc1', '192.168.2.10');
      return JSON.stringify(sim.trace(0).events, (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
    };
    expect(run()).toBe(run());
  });

  it('no interface Tunnel0: both rows go, the SA is released and port 500 closes', () => {
    const sim = ipsecWorld();
    line(sim, 'r1', [], ['interface', TU0], true);
    expect(sim.device('r1')!.port(TU0)).toBeUndefined();
    expect(tunnelRow(sim, 'r1')).toBeUndefined();
    expect(saRow(sim, 'r1')).toBeUndefined();
    expect(ikeSocket(sim, 'r1')).toBeUndefined();
    expect(sim.device('r1')!.stateSnapshots().find((v) => v.process === 'gre')!.state).toEqual({ tunnels: [] });
  });
});
