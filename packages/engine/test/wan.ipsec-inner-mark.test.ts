/**
 * wan.ipsec-inner-mark [C13] — W8 item 47 and rulings R36, R58(a), R61(a) (ARCHITECTURE-P3 §9.2 W8): the ESP mark is
 * set and cleared through the additive `ProcessCtx.protect(pdu, by | null)` (device/process-ctx.ts, `withProtection`),
 * which replaced gre's `setEspProtection` cast, and a TLS or SSH segment carried through an IPsec VTI keeps its own
 * mark in `PduMeta.innerProtectedBy`: ESP on the provider legs, TLS / SSH again on both LANs (the head saves it, the
 * tail restores it). No provenance record and no trace event of its own. The P3 `ext.*` requests stay in the contract's
 * slot, recorded as its sanctioned users (`SANCTIONED_EXT_REQUESTS`, R61(a)).
 *
 * The world is lab 25's (`ccna3-ipsec-site-to-site`, its reference solution typed after boot) with one change on LAN 2:
 * a host can serve neither HTTPS nor SSH, so the server is a switch, SW2 (NF-C2960, Vlan1 192.168.2.2, RESTCONF over
 * 443 and SSH-only vty lines), placed between R2 and PC2. PC1's `rest GET` and `ssh -l admin` to SW2 then cross LAN 1,
 * the VTI through the provider, and LAN 2. Each leg's mark is read at the instant its `frameTx` is emitted (a synchronous
 * trace listener), which is what the leg carried.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { PduMeta } from '../src/contracts/pdu.js';
import { SANCTIONED_EXT_REQUESTS } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DeviceTables, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ConfigAst } from '../src/contracts/config.js';
import { LOGGING_CLEAR_REQUEST } from '../src/cli/handlers/logging.js';
import { createRng } from '../src/core/prng.js';
import { NF_2911 } from '../src/device/catalog.js';
import { createProcessCtx, withProtection, type ProcessHost } from '../src/device/process-ctx.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { greTunnelCause } from '../src/protocols/gre.js';
import { TRANSPORT_HOLD_REQUEST } from '../src/protocols/ip-upper.js';
import { LOGGER_CLEAR_REQUEST } from '../src/protocols/logger.js';
import { TCP_PROTECT_REQUEST } from '../src/protocols/tcp.js';
import { VTY_SSH_VERSION } from '../src/protocols/vty.js';
import { ccna3IpsecSiteToSite, VPN_PC1, VPN_TUNNEL } from '../src/sim/scenarios/ccna3/vpn.js';
import { createSimulation } from '../src/sim/simulation.js';

const SW2 = '192.168.2.2';
const PASSWORD = 'Lab-Pass1';
/** Wall-clock budget of a test that boots the lab world. */
const WORLD_TEST_TIMEOUT_MS = 60_000;

// ── ProcessCtx.protect and withProtection, alone ────────────────────────────────────────────────────────────────────

const BASE: PduMeta = { born: 5, origin: 'r1', triggeredBy: 3, flow: 'ipv4:10.0.0.1>10.0.0.2:tcp', tag: 'seg' };

describe('withProtection: the meta after ProcessCtx.protect (W8 item 47)', () => {
  it('an unmarked PDU takes the mark and loses it again: exactly the W3 ESP mark, nothing inner', () => {
    const esp = withProtection(BASE, 'esp');
    expect(esp).toEqual({ ...BASE, protected: true, protectedBy: 'esp' });
    expect(esp.innerProtectedBy).toBeUndefined();
    expect(withProtection(esp, null)).toEqual(BASE);
    expect(Object.keys(withProtection(esp, null))).toEqual(Object.keys(BASE));
    // clearing an unmarked PDU changes nothing
    expect(withProtection(BASE, null)).toEqual(BASE);
  });

  it('a marked PDU keeps its mark inside (R58(a)): TLS and SSH under ESP, restored by null', () => {
    for (const by of ['tls', 'ssh', 'ike'] as const) {
      const own: PduMeta = { ...BASE, protected: true, protectedBy: by };
      const inside = withProtection(own, 'esp');
      expect(inside).toEqual({ ...BASE, protected: true, protectedBy: 'esp', innerProtectedBy: by });
      expect(withProtection(inside, null)).toEqual(own);
    }
  });

  it("P2's DTLS mark (protected without protectedBy) is kept as 'dtls' and restored in its P2 form", () => {
    const dtls: PduMeta = { ...BASE, protected: true };
    const inside = withProtection(dtls, 'esp');
    expect(inside).toEqual({ ...BASE, protected: true, protectedBy: 'esp', innerProtectedBy: 'dtls' });
    const back = withProtection(inside, null);
    expect(back).toEqual(dtls);
    expect('protectedBy' in back).toBe(false);
  });

  it('one level: a second tunnel keeps the mark the first one set; the input is never written', () => {
    const tls: PduMeta = { ...BASE, protected: true, protectedBy: 'tls' };
    const once = withProtection(tls, 'esp');
    const twice = withProtection(once, 'esp');
    expect(twice).toEqual({ ...BASE, protected: true, protectedBy: 'esp', innerProtectedBy: 'esp' });
    expect(withProtection(twice, null)).toEqual({ ...BASE, protected: true, protectedBy: 'esp' });
    expect(once).toEqual({ ...BASE, protected: true, protectedBy: 'esp', innerProtectedBy: 'tls' });
    expect(tls).toEqual({ ...BASE, protected: true, protectedBy: 'tls' });
  });
});

describe('ProcessCtx.protect on the runtime ctx (W8 item 47)', () => {
  it('same PDU, same id and bytes; the meta replaced; no provenance record and no trace event of its own', () => {
    const events: TraceEvent[] = [];
    const host: ProcessHost = {
      id: 'r1',
      hostname: 'R1',
      model: NF_2911 as DeviceModel,
      now: 7 * SEC,
      ports: new Map(),
      tables: {} as DeviceTables,
      running: {} as ConfigAst,
      trace: { emit: (ev: TraceEvent) => void events.push(ev) },
      pdus: createPduFactory(),
      capabilities: [],
      air: undefined,
      recordDebug: () => undefined,
    };
    const ctx = createProcessCtx(host, 'gre', createRng(1));
    const pdu = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.2', protocol: 6, ttl: 128 } },
        { proto: 'tcp', fields: { srcPort: 49152, dstPort: 443, seq: 1, ack: 1, flags: 'PA' } },
        { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } },
      ],
      { protected: true, protectedBy: 'tls', tag: 'seg' },
    );
    expect(events.map((e) => e.kind)).toEqual(['pduCreated']);
    const id = pdu.id;
    const bytes = pdu.bytes;
    expect(typeof ctx.protect).toBe('function');
    ctx.protect!(pdu, 'esp');
    expect(pdu.meta).toMatchObject({ born: 7 * SEC, origin: 'r1', tag: 'seg', protected: true, protectedBy: 'esp', innerProtectedBy: 'tls' });
    ctx.protect!(pdu, null);
    expect(pdu.meta).toEqual({ born: 7 * SEC, origin: 'r1', tag: 'seg', protected: true, protectedBy: 'tls' });
    expect(pdu.id).toBe(id);
    expect(pdu.bytes).toEqual(bytes);
    expect(pdu.provenance).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(['pduCreated']);
  });
});

describe('the ext.* slot: its sanctioned P3 users (ruling R61(a))', () => {
  it('the list names exactly the three P3 requests, spelled as their users send them', () => {
    expect(SANCTIONED_EXT_REQUESTS).toEqual(['ext.tcp.protect', 'ext.ipv4.transportHold', 'ext.logging.clear']);
    expect(SANCTIONED_EXT_REQUESTS).toEqual([TCP_PROTECT_REQUEST, TRANSPORT_HOLD_REQUEST, LOGGER_CLEAR_REQUEST]);
    expect(LOGGING_CLEAR_REQUEST).toBe(LOGGER_CLEAR_REQUEST);
    expect(Object.isFrozen(SANCTIONED_EXT_REQUESTS)).toBe(true);
    for (const kind of SANCTIONED_EXT_REQUESTS) expect(kind.startsWith('ext.')).toBe(true);
  });
});

// ── lab 25's VTI carries an HTTPS GET and an SSH login ─────────────────────────────────────────────────────────────

/** A leg's mark: [protectedBy (P2's DTLS as 'dtls'), innerProtectedBy] when protected, else null. */
type Mark = readonly [string, string | null] | null;
const markOf = (m: PduMeta): Mark => (m.protected === true ? [m.protectedBy ?? 'dtls', m.innerProtectedBy ?? null] : null);

/** One leg of a PDU as the trace saw it: its ends, its tunnel tag, and the PDU's mark when the leg left. */
interface Leg {
  readonly hop: string;
  readonly tunnel: string | null;
  readonly mark: Mark;
}

interface Recorded {
  readonly evs: TraceEvent[];
  /** Every PDU created during the run: its device, process and mark at birth. */
  readonly births: Map<number, { device: string; process: string; mark: Mark }>;
  readonly legs: Map<number, Leg[]>;
}

/** Run `fn` with a synchronous listener that reads each new PDU's mark at birth and each leg's mark as it leaves. */
function recorded(sim: Simulation, fn: () => void): Recorded {
  const evs: TraceEvent[] = [];
  const births = new Map<number, { device: string; process: string; mark: Mark }>();
  const legs = new Map<number, Leg[]>();
  const off = sim.onTrace((e) => {
    evs.push(e);
    if (e.kind === 'pduCreated') {
      births.set(e.pdu.id, { device: e.device, process: e.process, mark: markOf(sim.pdu(e.pdu.id)!.meta) });
    } else if (e.kind === 'frameTx' && e.background !== true && births.has(e.pdu.id)) {
      const list = legs.get(e.pdu.id) ?? [];
      list.push({ hop: `${e.from.device}>${e.to.device}`, tunnel: e.pdu.tunnel ?? null, mark: markOf(sim.pdu(e.pdu.id)!.meta) });
      legs.set(e.pdu.id, list);
    }
  });
  try {
    fn();
  } finally {
    off();
  }
  return { evs, births, legs };
}

/** Type `lines` on `device`; every line must be accepted. */
function typed(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), device).toEqual([]);
}

/** SW2: the LAN 2 server — Vlan1, RESTCONF over 443 and SSH-only vty lines with a local user (§3.8, §3.14 lines). */
const SW2_LINES: readonly string[] = [
  'hostname SW2',
  'interface Vlan1',
  `ip address ${SW2} 255.255.255.0`,
  'no shutdown',
  'exit',
  'ip default-gateway 192.168.2.1',
  `username admin privilege 15 secret ${PASSWORD}`,
  'ip http secure-server',
  'ip http authentication local',
  'restconf',
  'ip domain-name lab.nf',
  'crypto key generate rsa modulus 1024',
  'line vty 0 4',
  'login local',
  'transport input ssh',
  'exit',
];

/** Lab 25 with SW2 between R2 and PC2, booted, SW2 configured, the reference solution typed, the SA up. */
function vtiWorld(): Simulation {
  const lab = ccna3IpsecSiteToSite;
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology(lab.build());
  expect(sim.link('l_r2_pc2')).toBeDefined();
  sim.removeLink('l_r2_pc2');
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2' });
  sim.addLink({ a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'sw2', port: 'FastEthernet0/1' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  typed(sim, 'sw2', SW2_LINES);
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typed(sim, name === 'R1' ? 'r1' : 'r2', lines);
  expect(sim.runToIdle().stopped).toBeUndefined();
  expect([sim.device('r1')!.port(VPN_TUNNEL)!.operUp, sim.device('r2')!.port(VPN_TUNNEL)!.operUp]).toEqual([true, true]);
  return sim;
}

/** Type `line` on a PC1 console session and run until its job ends (the prompt is no longer busy); what it printed. */
function job(sim: Simulation, s: SessionId, line: string): string {
  const cursor = sim.trace(0).next;
  const started = sim.cli.exec(s, line);
  expect(started.error, line).toBeUndefined();
  let done = !started.busy;
  for (let i = 0; i < 400 && !done; i++) {
    sim.runFor(SEC / 20);
    done = sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy);
  }
  expect(done, `the job of "${line.slice(0, 50)}" ended`).toBe(true);
  return sim
    .trace(cursor)
    .events.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : []))
    .join('');
}

const PC1_TO_SW2 = ['pc1>r1', 'r1>isp', 'isp>r2', 'r2>sw2'];
const SW2_TO_PC1 = ['sw2>r2', 'r2>isp', 'isp>r1', 'r1>pc1'];
const TUNNEL_TAGS = [null, 'ipsec', 'ipsec', null];

/** The TCP segments of a conversation between PC1 and SW2 that crossed the whole path, with their legs. */
function segmentsAcross(sim: Simulation, rec: Recorded, port: number): { id: number; from: string; birth: Mark; legs: Leg[] }[] {
  const out: { id: number; from: string; birth: Mark; legs: Leg[] }[] = [];
  for (const [id, b] of rec.births) {
    if (b.process !== 'tcp' || (b.device !== 'pc1' && b.device !== 'sw2')) continue;
    const tcp = sim.pdu(id)?.layer('tcp');
    if (tcp === undefined || (tcp.fields.dstPort !== port && tcp.fields.srcPort !== port)) continue;
    const legs = rec.legs.get(id) ?? [];
    if (!rec.evs.some((e) => e.kind === 'frameRx' && e.pdu.id === id && e.device === (b.device === 'pc1' ? 'sw2' : 'pc1'))) continue;
    out.push({ id, from: b.device, birth: b.mark, legs });
  }
  return out;
}

/** Every leg of `seg` carries `own` on both LANs and ESP (with `own` inside) between the routers; `own` again at the end. */
function expectMarksAcross(sim: Simulation, seg: { id: number; from: string; legs: Leg[] }, own: string | null): void {
  const hops = seg.from === 'pc1' ? PC1_TO_SW2 : SW2_TO_PC1;
  const lan: Mark = own === null ? null : [own, null];
  expect(seg.legs, `#${seg.id}`).toEqual(hops.map((hop, i) => ({ hop, tunnel: TUNNEL_TAGS[i], mark: i === 0 || i === 3 ? lan : ['esp', own] })));
  // the packet as delivered: its own mark again, nothing inside
  const meta = sim.pdu(seg.id)!.meta;
  expect(markOf(meta), `#${seg.id} delivered`).toEqual(lan);
  expect(meta.innerProtectedBy).toBeUndefined();
}

/** The provenance of one tunnelled segment at the head and the tail: exactly the ping's records, nothing for the mark. */
function expectTunnelRecords(sim: Simulation, seg: { id: number; from: string }): void {
  const [head, tail] = seg.from === 'pc1' ? ['r1', 'r2'] : ['r2', 'r1'];
  const muts = sim.pdu(seg.id)!.provenance;
  const at = (d: string): string[] => muts.filter((m) => m.device === d && m.cause === greTunnelCause(VPN_TUNNEL)).map((m) => `${m.reason} ${m.field}`);
  expect(at(head)).toEqual(['Decapsulate ethernet', 'Encapsulate esp', 'Encrypt esp.keyId', 'Encapsulate ipv4', 'Encapsulate hdlc']);
  expect(at(tail)).toEqual(['Decrypt esp.keyId', 'Decapsulate hdlc', 'Decapsulate ipv4', 'Decapsulate esp']);
}

describe('lab 25: TLS and SSH keep their mark through the VTI (R58(a))', () => {
  it('an HTTPS GET from PC1 to SW2: every data segment is TLS on both LANs and ESP (TLS inside) between the routers', () => {
    const sim = vtiWorld();
    const s = sim.cli.open('pc1', 'console');
    let out = '';
    const rec = recorded(sim, () => {
      out = job(sim, s, `rest GET https://${SW2}/restconf/data/nf-native:native/hostname -u admin:${PASSWORD}`);
    });
    expect(out.split('\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(out).toContain('"nf-native:hostname": "SW2"');
    const segs = segmentsAcross(sim, rec, 443);
    const data = segs.filter((g) => g.birth !== null);
    // both directions carried data segments, each marked TLS at birth (D21)
    expect(new Set(data.map((g) => g.from))).toEqual(new Set(['pc1', 'sw2']));
    for (const g of data) {
      expect(g.birth).toEqual(['tls', null]);
      expectMarksAcross(sim, g, 'tls');
      expectTunnelRecords(sim, g);
    }
    // the handshake and the pure ACKs carry no mark of their own: ESP inside the provider, nothing on the LANs
    const bare = segs.filter((g) => g.birth === null);
    expect(bare.length).toBeGreaterThan(0);
    for (const g of bare) {
      expectMarksAcross(sim, g, null);
      expectTunnelRecords(sim, g);
    }
    // the provider saw only ESP between the public ends, and still has no private route
    for (const g of segs) for (const leg of g.legs.slice(1, 3)) expect(leg.tunnel).toBe('ipsec');
    expect(sim.device('isp')!.tables.rib.rows().some((r) => r.network.startsWith('192.168.'))).toBe(false);
  }, WORLD_TEST_TIMEOUT_MS);

  it('an SSH login from PC1 to SW2: the version strings in clear, then every segment SSH on both LANs and ESP (SSH inside) between the routers', () => {
    const sim = vtiWorld();
    const s = sim.cli.open('pc1', 'console');
    const rec = recorded(sim, () => {
      sim.cli.exec(s, `ssh -l admin ${SW2}`);
      sim.runFor(1 * SEC);
      sim.cli.exec(s, PASSWORD);
      sim.runFor(3 * SEC);
    });
    expect(sim.cli.session(s)).toMatchObject({ prompt: 'SW2#', remote: 'SW2 via SSH', busy: false });
    const segs = segmentsAcross(sim, rec, 22);
    const ssh = segs.filter((g) => g.birth !== null);
    expect(new Set(ssh.map((g) => g.from))).toEqual(new Set(['pc1', 'sw2']));
    for (const g of ssh) {
      expect(g.birth).toEqual(['ssh', null]);
      expect(sim.pdu(g.id)!.layer('ssh')?.fields.phase).toBe('protected');
      expectMarksAcross(sim, g, 'ssh');
      expectTunnelRecords(sim, g);
    }
    // the version exchange is in clear on the LANs (D14): only ESP marks it, inside the provider
    const versions = segs.filter((g) => sim.pdu(g.id)!.layer('ssh')?.fields.phase === 'version');
    expect(versions.map((g) => g.from).sort()).toEqual(['pc1', 'sw2']);
    expect(versions.map((g) => sim.pdu(g.id)!.layer('ssh')!.fields.version)).toContain(VTY_SSH_VERSION);
    for (const g of versions) {
      expect(g.birth).toBeNull();
      expectMarksAcross(sim, g, null);
    }
    // the login itself (a privilege-15 user lands in privileged EXEC): one success row on SW2, from PC1 across the tunnel
    const rows = sim.device('sw2')!.tables.get<VtyLoginRow>('vty-logins')!.rows();
    expect(rows.map((r) => [r.proto, r.peer, r.result])).toEqual([['ssh', VPN_PC1, 'success']]);
  }, WORLD_TEST_TIMEOUT_MS);

  it('a plain ping through the VTI is unchanged: ESP inside the provider, no mark on either LAN or after the tail', () => {
    const sim = vtiWorld();
    const s = sim.cli.open('pc1', 'console');
    const rec = recorded(sim, () => {
      sim.cli.exec(s, `ping ${SW2}`);
      expect(sim.runToIdle().stopped).toBeUndefined();
    });
    const echoes = [...rec.births].filter(([, b]) => b.device === 'pc1' && b.process === 'icmpv4').map(([id]) => id);
    expect(echoes).toHaveLength(5);
    for (const id of echoes) {
      expect(rec.legs.get(id)).toEqual(PC1_TO_SW2.map((hop, i) => ({ hop, tunnel: TUNNEL_TAGS[i], mark: i === 0 || i === 3 ? null : ['esp', null] })));
      expect(sim.pdu(id)!.meta.protected).toBeUndefined();
      expect(sim.pdu(id)!.meta.innerProtectedBy).toBeUndefined();
    }
  }, WORLD_TEST_TIMEOUT_MS);
});
