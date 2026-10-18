/**
 * app.tftp — [S29] the tftp daemon (ARCHITECTURE-P3C D10, §2.4 `tftp.transfer`, §2.5 `tftp.result`, §3.4, §4.1–§4.3;
 * §7 W2a svc; ruling RC6 (b)), on real worlds of `staged.world` at stage 'P3c' with the tftp factory (rule 13: the
 * factory joins the registry at the W4b flip), plus a few cases driven on the daemon alone.
 *
 * The `copy` grammar is the W3a2 cli item's, so the jobs are sent as `tftp.transfer` requests (`applyActions`), and
 * the server lines (`service tftp on`, `tftp-server flash:<f>`) are stored through `startupConfig` or
 * `applyConfigLine`. The storage members the runtime does not declare on `DeviceRuntime` yet (`files`, RC5 (f): W2b
 * device) are read as `device.storage.flash` reads them.
 *
 *  • backup (WRQ, lock-step DATA, `n = ⌊len/512⌋ + 1`, the transfer ids), the CLI's text and `cliDone`;
 *  • restore merges through the configure seam (`origin {via: 'tftp'}`); a 1024-byte file ends with an empty block;
 *  • a lost DATA is retransmitted after exactly 2 s and stored once; a lost ACK draws a re-acknowledgement;
 *  • a dead server ends the job 12 s after its first packet with `tftpTimeout`; a closed port ends it at once;
 *  • `copy tftp: flash:` asks `tsize 0`; an image that does not fit is refused at the OACK with ERROR 3 and
 *    `flashFull`, no DATA moved; one that fits moves 81 blocks (80 full, an empty last) and keeps its nominal size;
 *  • a router's `tftp-server flash:<f>` serves that file only, refuses a WRQ (ERROR 2) and an unknown file (ERROR 1);
 *  • a switch job wakes the dormant transport and the switch is dormant again after it; `tftp-server` wakes it (§4.3);
 *  • the daemon alone: ERROR 5 for a stray port, a server that ignores `tsize` checked block by block, ERROR 0 for a
 *    mode other than octet and for a ninth session;
 *  • silence: no server line and no job, no socket, no timer, no packet.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { DeviceId, LinkId } from '../src/contracts/ids.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { IMAGE_TRANSFER_SCALE, type FileSystemId, type StoredFile, type StoredFileMeta } from '../src/contracts/storage.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ProcessEvent, TftpResultEvent } from '../src/contracts/transport.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { imageHeader } from '../src/io/schema.js';
import { TFTP_ERROR, TFTP_OPCODE, tftpCodec } from '../src/pdu/codecs/tftp.js';
import { transportWakeLine } from '../src/protocols/ip-upper.js';
import {
  TFTP_BLOCK_BYTES,
  TFTP_DALLY_NS,
  TFTP_ERROR_TEXT,
  TFTP_LISTEN_SOCKET,
  TFTP_RETRANSMIT_NS,
  TFTP_RETRIES,
  TFTP_SERVER_SESSIONS,
  createTftp,
  tftpServerConfigOf,
  tftpTimerKey,
} from '../src/protocols/tftp.js';
import { createStagedSimulation, P3C_STORAGE } from './staged.world.js';

const FACTORIES = { tftp: createTftp };
const MIB = 1024 * 1024;
const SRV = '10.0.0.100';
type TransferRequest = Extract<ProcessRequest, { kind: 'tftp.transfer' }>;

/** The storage members of the runtime the contract does not declare yet (RC5 (f)). */
interface StoreRuntime {
  files(fs: FileSystemId): readonly StoredFileMeta[];
  readFile(fs: FileSystemId, path: string): StoredFile | undefined;
}
const store = (sim: Simulation, dev: DeviceId): StoreRuntime => sim.device(dev) as unknown as DeviceRuntime & StoreRuntime;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface WorldOpts {
  readonly srvLines?: readonly string[];
  readonly r1Lines?: readonly (readonly string[])[];
  readonly sw1Lines?: readonly string[];
}

const LINKS = new WeakMap<Simulation, { readonly srv: LinkId; readonly r1: LinkId }>();

/** SRV1 10.0.0.100 (NF-SERVER), R1 Gi0/0 10.0.0.1 (NF-2911), SW1 Vlan1 10.0.0.2 (NF-C2960, the switch between them). */
function world(seed: number, opts: WorldOpts = {}): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3c', factories: FACTORIES });
  sim.addDevice({
    id: 'srv1', type: 'server.nfserver', name: 'SRV1',
    startupConfig: startup([['hostname SRV1'], ['interface GigabitEthernet0', ` ip address ${SRV} 255.255.255.0`], ['ip default-gateway 10.0.0.1'], ...(opts.srvLines ?? []).map((l) => [l])]),
  });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' description uplink to the server switch', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'],
      ...(opts.r1Lines ?? []),
    ]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0', ' no shutdown'], ['ip default-gateway 10.0.0.1'], ...(opts.sw1Lines ?? []).map((l) => [l])]),
  });
  const srv = sim.addLink({ a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  const r1 = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  LINKS.set(sim, { srv, r1 });
  // boot, then spanning tree's listening and learning on SW1's ports
  sim.runFor(100 * SEC);
  return sim;
}

/** R1 with enough configuration for a multi-block backup (descriptions on many subinterfaces). */
const R1_BULK: readonly (readonly string[])[] = Array.from({ length: 12 }, (_, i) => [
  `interface GigabitEthernet0/1.${10 + i}`,
  ` description subinterface ${10 + i} for the backup test, long enough to fill the blocks`,
  ` encapsulation dot1Q ${10 + i}`,
  ` ip address 10.${i + 1}.0.1 255.255.255.0`,
]);

/** Start one job on `dev` now. */
function job(sim: Simulation, dev: DeviceId, req: Omit<TransferRequest, 'kind'>): void {
  const d = sim.device(dev)!;
  d.applyActions('sim', [{ type: 'request', to: 'tftp', req: { kind: 'tftp.transfer', ...req } }], sim.now);
}

/** Store a file on `dev` through the storage action (as a 1.4 load or a script would). */
function putFile(sim: Simulation, dev: DeviceId, fs: FileSystemId, path: string, content: string): void {
  sim.device(dev)!.applyActions('sim', [{ type: 'storage', op: 'write', fs, path, file: { content } }], sim.now);
}

interface TftpState {
  readonly listening: boolean;
  readonly transfers: readonly Record<string, unknown>[];
  readonly results: readonly TftpResultEvent[];
  readonly served: number;
  readonly stored: number;
}
const tftpState = (sim: Simulation, dev: DeviceId): TftpState => sim.device(dev)!.processes.get('tftp')!.stateSnapshot().state as unknown as TftpState;
const result = (sim: Simulation, dev: DeviceId, token: string): TftpResultEvent | undefined => tftpState(sim, dev).results.find((r) => r.token === token);

interface Sent {
  readonly t: SimTime;
  readonly device: DeviceId;
  readonly opcode: number;
  readonly block?: number;
  readonly len?: number;
  readonly tsize?: number;
  readonly errorCode?: number;
  readonly srcPort: number;
  readonly dstPort: number;
}

/**
 * The TFTP fields of a UDP datagram to or from a TFTP socket, decoded from its UDP payload (RC6 (b): DATA and ACK
 * between two ephemeral ports are not port-dispatched, so the PDU itself shows them as `payload`).
 */
function tftpOf(p: PduView): Record<string, unknown> | undefined {
  const udp = p.layer('udp');
  if (udp === undefined) return undefined;
  const start = udp.offset + udp.headerLength;
  const end = udp.offset + udp.length - (udp.trailerLength ?? 0);
  if (end - start < 2) return undefined;
  const layer = tftpCodec.decode(p.bytes, start, end - start);
  return layer.error === undefined ? layer.fields : undefined;
}

/**
 * Every TFTP packet built since `cursor`, in order: a request to port 69 names the client's transfer id, a packet to
 * a known transfer id names the server's, and every packet from or to a known id (or port 69) is TFTP.
 */
function tftpPackets(sim: Simulation, cursor = 0): Sent[] {
  const out: Sent[] = [];
  const ids = new Set<number>([69]);
  for (const e of sim.trace(cursor).events) {
    if (e.kind !== 'pduCreated' || e.process !== 'udp') continue;
    const p = sim.pdu(e.pdu.id);
    if (p === undefined) continue;
    const srcPort = p.get('udp.srcPort') as number;
    const dstPort = p.get('udp.dstPort') as number;
    if (!ids.has(srcPort) && !ids.has(dstPort)) continue;
    const f = tftpOf(p);
    if (f === undefined || typeof f.opcode !== 'number') continue;
    ids.add(srcPort);
    ids.add(dstPort);
    const s: Record<string, unknown> = { t: e.t, device: e.device, opcode: f.opcode, srcPort, dstPort };
    for (const k of ['block', 'tsize', 'errorCode'] as const) if (typeof f[k] === 'number') s[k] = f[k];
    if (f.data instanceof Uint8Array) s.len = f.data.length;
    out.push(s as unknown as Sent);
  }
  return out;
}

const blocksFor = (n: number): number => Math.floor(n / TFTP_BLOCK_BYTES) + 1;
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

// ── backup and restore ───────────────────────────────────────────────────────

describe('app.tftp: backup to a server (§3.4 step 1)', () => {
  it('R1 writes its running configuration to SRV1 in lock-step blocks between two locked ephemeral ports', () => {
    const sim = world(1, { srvLines: ['service tftp on'], r1Lines: R1_BULK });
    expect(tftpState(sim, 'srv1').listening).toBe(true);
    const text = sim.device('r1')!.running.render();
    const bytes = utf8Length(text);
    expect(bytes).toBeGreaterThan(2 * TFTP_BLOCK_BYTES);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'b1', op: 'put', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(10 * SEC);

    expect(result(sim, 'r1', 'b1')).toEqual({ kind: 'tftp.result', token: 'b1', ok: true, bytes, blocks: blocksFor(bytes) });
    expect(store(sim, 'srv1').readFile('files', 'r1-confg')?.content).toBe(text);

    const pk = tftpPackets(sim, cursor);
    const [wrq, ack0] = pk;
    expect(wrq).toMatchObject({ device: 'r1', opcode: TFTP_OPCODE.wrq, dstPort: 69 });
    expect(wrq!.srcPort).toBeGreaterThanOrEqual(49152);
    expect(ack0).toMatchObject({ device: 'srv1', opcode: TFTP_OPCODE.ack, block: 0, dstPort: wrq!.srcPort });
    expect(ack0!.srcPort).toBeGreaterThanOrEqual(49152);
    expect(ack0!.srcPort).not.toBe(69);
    // the rest alternates DATA n (R1) and ACK n (SRV1) on the locked pair
    const n = blocksFor(bytes);
    const rest = pk.slice(2);
    expect(rest).toHaveLength(2 * n);
    for (let i = 1; i <= n; i++) {
      const d = rest[2 * (i - 1)]!;
      const a = rest[2 * (i - 1) + 1]!;
      expect(d).toMatchObject({ device: 'r1', opcode: TFTP_OPCODE.data, block: i, srcPort: wrq!.srcPort, dstPort: ack0!.srcPort });
      expect(d.len).toBe(i < n ? TFTP_BLOCK_BYTES : bytes % TFTP_BLOCK_BYTES);
      expect(a).toMatchObject({ device: 'srv1', opcode: TFTP_OPCODE.ack, block: i, srcPort: ack0!.srcPort, dstPort: wrq!.srcPort });
    }
    // both sides are done: no transfer left on the sender; the server dallies, then closes
    expect(tftpState(sim, 'r1').transfers).toEqual([]);
    sim.runFor(TFTP_DALLY_NS);
    expect(tftpState(sim, 'srv1').transfers).toEqual([]);
    expect(tftpState(sim, 'srv1').stored).toBe(1);
  });

  it('the CLI job prints one ! per block and the byte count, then frees the session', () => {
    const sim = world(2, { srvLines: ['service tftp on'], r1Lines: R1_BULK });
    const session = sim.cli.open('r1', 'console');
    const bytes = utf8Length(sim.device('r1')!.running.render());
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', session, token: 'c1', op: 'put', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(10 * SEC);
    const out = sim
      .trace(cursor)
      .events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === session)
      .map((e) => e.text)
      .join('');
    const n = blocksFor(bytes);
    expect(out).toMatch(new RegExp(`^Copying to tftp://${SRV.replace(/\./g, '\\.')}/r1-confg ${'!'.repeat(n)}\\n${bytes} bytes copied in ${n} blocks, \\d+\\.\\d{3} s\\n$`));
    expect(sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === session)).toBe(true);
  });
});

describe('app.tftp: restore merges; the empty final block (§3.4 step 3)', () => {
  it('copy tftp: running-config applies the file through the configure seam as a merge', () => {
    const sim = world(3, { srvLines: ['service tftp on'] });
    putFile(sim, 'srv1', 'files', 'r1-confg', ['hostname R1-RESTORED', '!', 'interface GigabitEthernet0/1', ' description restored from the backup', '!', 'end', ''].join('\n'));
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'r1', op: 'get', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(10 * SEC);
    expect(result(sim, 'r1', 'r1')).toMatchObject({ ok: true, blocks: 1 });
    const text = sim.device('r1')!.running.render();
    expect(text).toContain('hostname R1-RESTORED');
    expect(text).toContain(' description restored from the backup');
    // a merge: the lines the file does not name stay
    expect(text).toContain(' ip address 10.0.0.1 255.255.255.0');
    expect(text).toContain(' description uplink to the server switch');
    const changes = sim.trace(cursor).events.filter((e) => e.kind === 'configChange' && e.device === 'r1');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    // the get asked no option (only a copy into flash does)
    expect(tftpPackets(sim, cursor)[0]).toMatchObject({ device: 'r1', opcode: TFTP_OPCODE.rrq });
    expect(tftpPackets(sim, cursor)[0]!.tsize).toBeUndefined();
  });

  it('a file of exactly 1024 bytes moves in 3 blocks, the last one empty', () => {
    const sim = world(4, { srvLines: ['service tftp on'] });
    const content = `${'x'.repeat(1023)}\n`;
    putFile(sim, 'srv1', 'files', 'notes.txt', content);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'k', op: 'get', server: SRV, remote: 'notes.txt', local: { fs: 'flash', path: 'notes.txt' } });
    sim.runFor(10 * SEC);
    expect(result(sim, 'r1', 'k')).toEqual({ kind: 'tftp.result', token: 'k', ok: true, bytes: 1024, blocks: 3 });
    const data = tftpPackets(sim, cursor).filter((p) => p.opcode === TFTP_OPCODE.data);
    expect(data.map((p) => [p.block, p.len])).toEqual([[1, 512], [2, 512], [3, 0]]);
    expect(store(sim, 'r1').readFile('flash', 'notes.txt')?.content).toBe(content);
  });
});

// ── losses and dead servers ──────────────────────────────────────────────────

/** Lose the first frame for which `pick` holds on the R1–SW1 link (loss on, then off at its drop). */
function loseOnce(sim: Simulation, pick: (p: Sent) => boolean): { lost: () => boolean } {
  const link = LINKS.get(sim)!.r1;
  let armed = true;
  let lost = false;
  sim.onTrace((e) => {
    if (armed && e.kind === 'pduCreated') {
      const p = e.process === 'udp' ? sim.pdu(e.pdu.id) : undefined;
      const f = p === undefined ? undefined : tftpOf(p);
      if (f !== undefined && typeof f.opcode === 'number') {
        const s = { t: e.t, device: e.device, opcode: f.opcode, block: f.block } as unknown as Sent;
        if (pick(s)) {
          armed = false;
          sim.setImpairments(link, { lossPct: 100 });
        }
      }
    } else if (!armed && !lost && e.kind === 'drop' && e.reason === 'link-loss') {
      lost = true;
      sim.setImpairments(link, { lossPct: 0 });
    }
  });
  return { lost: () => lost };
}

describe('app.tftp: losses (§3.4 step 2) and dead servers (§3.4 timers)', () => {
  it('a lost DATA block is retransmitted exactly 2 s later and stored once', () => {
    const sim = world(5, { srvLines: ['service tftp on'], r1Lines: R1_BULK });
    const text = sim.device('r1')!.running.render();
    const loss = loseOnce(sim, (p) => p.device === 'r1' && p.opcode === TFTP_OPCODE.data && p.block === 2);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'l1', op: 'put', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(20 * SEC);
    expect(loss.lost()).toBe(true);
    const d2 = tftpPackets(sim, cursor).filter((p) => p.device === 'r1' && p.opcode === TFTP_OPCODE.data && p.block === 2);
    expect(d2).toHaveLength(2);
    expect(d2[1]!.t - d2[0]!.t).toBe(TFTP_RETRANSMIT_NS);
    expect(result(sim, 'r1', 'l1')).toMatchObject({ ok: true, bytes: utf8Length(text), blocks: blocksFor(utf8Length(text)) });
    expect(store(sim, 'srv1').readFile('files', 'r1-confg')?.content).toBe(text);
    expect(tftpState(sim, 'srv1').stored).toBe(1);
  });

  it('a lost ACK: the sender retransmits, the receiver re-acknowledges the duplicate and never stores it twice', () => {
    const sim = world(6, { srvLines: ['service tftp on'], r1Lines: R1_BULK });
    const text = sim.device('r1')!.running.render();
    const loss = loseOnce(sim, (p) => p.device === 'srv1' && p.opcode === TFTP_OPCODE.ack && p.block === 1);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'l2', op: 'put', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(20 * SEC);
    expect(loss.lost()).toBe(true);
    const pk = tftpPackets(sim, cursor);
    expect(pk.filter((p) => p.device === 'r1' && p.opcode === TFTP_OPCODE.data && p.block === 1)).toHaveLength(2);
    expect(pk.filter((p) => p.device === 'srv1' && p.opcode === TFTP_OPCODE.ack && p.block === 1)).toHaveLength(2);
    expect(result(sim, 'r1', 'l2')).toMatchObject({ ok: true });
    expect(store(sim, 'srv1').readFile('files', 'r1-confg')?.content).toBe(text);
    expect(tftpState(sim, 'srv1').stored).toBe(1);
  });

  it('a server that never answers ends the job 12 s after its first packet with tftpTimeout; runToIdle returns', () => {
    const sim = world(7, { srvLines: ['service tftp on'] });
    // SRV1 still answers ARP and ICMP, but its TFTP packets are lost: its port to the switch drops everything it sends
    const link = LINKS.get(sim)!.srv;
    // a first copy fills the ARP caches, so the lost requests leave R1
    putFile(sim, 'srv1', 'files', 'r1-confg', 'hostname R1\n');
    job(sim, 'r1', { owner: 'cli', token: 'd0', op: 'get', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(5 * SEC);
    expect(result(sim, 'r1', 'd0')).toMatchObject({ ok: true });
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    sim.setImpairments(link, { lossPct: 100 });
    job(sim, 'r1', { owner: 'cli', token: 'd1', op: 'get', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    const idle = sim.runToIdle(200_000);
    expect(idle.events).toBeLessThan(200_000);
    const rrq = tftpPackets(sim, cursor).filter((p) => p.device === 'r1' && p.opcode === TFTP_OPCODE.rrq);
    expect(rrq).toHaveLength(TFTP_RETRIES + 1);
    rrq.forEach((p, i) => expect(p.t - rrq[0]!.t).toBe(i * TFTP_RETRANSMIT_NS));
    expect(rrq[0]!.t).toBe(t0);
    expect(result(sim, 'r1', 'd1')).toEqual({
      kind: 'tftp.result', token: 'd1', ok: false, bytes: 0, blocks: 0, error: `% The TFTP server ${SRV} did not answer; the copy was abandoned.`,
    });
    const done = sim.trace(cursor).events.find((e) => e.kind === 'debug' && e.event.process === 'tftp' && e.event.message.includes('job d1 failed'));
    expect(done!.t - t0).toBe((TFTP_RETRIES + 1) * TFTP_RETRANSMIT_NS);
    expect(tftpState(sim, 'r1').transfers).toEqual([]);
  });

  it('a server without TFTP answers port unreachable and the job ends at once', () => {
    const sim = world(8);
    expect(tftpState(sim, 'srv1').listening).toBe(false);
    job(sim, 'r1', { owner: 'cli', token: 'p1', op: 'put', server: SRV, remote: 'r1-confg', local: { config: 'running' } });
    sim.runFor(SEC);
    expect(result(sim, 'r1', 'p1')).toMatchObject({ ok: false, error: `% The TFTP server ${SRV} cannot be reached: port unreachable (no TFTP server there).` });
  });
});

// ── flash and the tsize option ───────────────────────────────────────────────

describe('app.tftp: copy tftp: flash: and tsize (§3.4 step 5, [S30] step 7)', () => {
  const r1Storage = P3C_STORAGE['router.nf2911']!;
  const image = (nominal: number): string => {
    const wire = Math.ceil(nominal / IMAGE_TRANSFER_SCALE);
    return imageHeader(nominal) + 'F'.repeat(wire - 16);
  };

  it('an image that does not fit is refused at the OACK with ERROR 3 and flashFull; no DATA moves', () => {
    const sim = world(9, { srvLines: ['service tftp on'] });
    const nominal = 300 * MIB;
    const content = image(nominal);
    putFile(sim, 'srv1', 'files', 'nf2900-16.1.bin', content);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'f1', op: 'get', server: SRV, remote: 'nf2900-16.1.bin', local: { fs: 'flash', path: 'nf2900-16.1.bin' }, image: true });
    sim.runFor(10 * SEC);
    const pk = tftpPackets(sim, cursor);
    expect(pk.map((p) => [p.device, p.opcode])).toEqual([['r1', TFTP_OPCODE.rrq], ['srv1', TFTP_OPCODE.oack], ['r1', TFTP_OPCODE.error]]);
    expect(pk[0]!.tsize).toBe(0);
    expect(pk[1]!.tsize).toBe(content.length);
    expect(pk[2]!.errorCode).toBe(TFTP_ERROR.diskFull);
    const free = r1Storage.flashBytes - r1Storage.image.nominalBytes;
    expect(result(sim, 'r1', 'f1')).toEqual({
      kind: 'tftp.result', token: 'f1', ok: false, bytes: 0, blocks: 0,
      error: `% Not enough room in flash: the file needs ${content.length * IMAGE_TRANSFER_SCALE} bytes and ${free} are free.`,
    });
    expect(store(sim, 'r1').files('flash')).toEqual([]);
    // the server's session ended at the ERROR (no retransmission of the OACK)
    expect(tftpState(sim, 'srv1').transfers).toEqual([]);
  });

  it('an image that fits moves in 81 blocks (80 full, an empty last) and keeps its nominal size', () => {
    const sim = world(10, { srvLines: ['service tftp on'] });
    const nominal = 40 * MIB;
    const content = image(nominal);
    expect(content.length).toBe(40960);
    putFile(sim, 'srv1', 'files', 'nf2900-15.9.bin', content);
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'f2', op: 'get', server: SRV, remote: 'nf2900-15.9.bin', local: { fs: 'flash', path: 'nf2900-15.9.bin' }, image: true });
    sim.runFor(20 * SEC);
    const blocks = Math.floor(content.length / TFTP_BLOCK_BYTES) + 1;
    expect(blocks).toBe(81);
    expect(result(sim, 'r1', 'f2')).toEqual({ kind: 'tftp.result', token: 'f2', ok: true, bytes: content.length, blocks });
    const data = tftpPackets(sim, cursor).filter((p) => p.opcode === TFTP_OPCODE.data);
    expect(data).toHaveLength(81);
    expect(data.at(-1)!.len).toBe(0);
    expect(store(sim, 'r1').files('flash')).toEqual([expect.objectContaining({ fs: 'flash', path: 'nf2900-15.9.bin', size: content.length, nominalBytes: nominal })]);
  });

  it('a copy into flash onto the running image name is refused before any DATA', () => {
    const sim = world(11, { srvLines: ['service tftp on'] });
    putFile(sim, 'srv1', 'files', 'x.bin', image(MIB));
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'f3', op: 'get', server: SRV, remote: 'x.bin', local: { fs: 'flash', path: r1Storage.image.file } });
    sim.runFor(10 * SEC);
    expect(tftpPackets(sim, cursor).filter((p) => p.opcode === TFTP_OPCODE.data)).toEqual([]);
    expect(result(sim, 'r1', 'f3')).toMatchObject({ ok: false, error: `% The copy cannot be stored: ${r1Storage.image.file} is the running image.` });
  });

  it('a put of a flash file that does not exist answers fileNotFound and sends nothing', () => {
    const sim = world(12, { srvLines: ['service tftp on'] });
    const cursor = sim.trace(0).next;
    job(sim, 'r1', { owner: 'cli', token: 'n1', op: 'put', server: SRV, remote: 'gone', local: { fs: 'flash', path: 'gone' } });
    sim.runFor(SEC);
    expect(tftpPackets(sim, cursor)).toEqual([]);
    expect(result(sim, 'r1', 'n1')).toMatchObject({ ok: false, error: '% There is no file named flash:gone.' });
  });
});

// ── a router's server ────────────────────────────────────────────────────────

describe('app.tftp: tftp-server flash:<f> on a router', () => {
  it('serves the listed flash file only; a WRQ is refused with ERROR 2, another file with ERROR 1', () => {
    const sim = world(13, { r1Lines: [['tftp-server flash:r1-confg']] });
    const content = 'hostname R1\n!\nend\n';
    putFile(sim, 'r1', 'flash', 'r1-confg', content);
    putFile(sim, 'r1', 'flash', 'secret.txt', 'not served');
    expect(tftpState(sim, 'r1').listening).toBe(true);
    // SW1 reads the served file into its own flash (its job holds its dormant transport)
    job(sim, 'sw1', { owner: 'cli', token: 'g1', op: 'get', server: '10.0.0.1', remote: 'r1-confg', local: { fs: 'flash', path: 'r1-confg' } });
    job(sim, 'sw1', { owner: 'cli', token: 'g2', op: 'get', server: '10.0.0.1', remote: 'secret.txt', local: { fs: 'flash', path: 'secret.txt' } });
    job(sim, 'sw1', { owner: 'cli', token: 'g3', op: 'put', server: '10.0.0.1', remote: 'sw1-confg', local: { config: 'running' } });
    sim.runFor(10 * SEC);
    expect(result(sim, 'sw1', 'g1')).toMatchObject({ ok: true, bytes: utf8Length(content), blocks: 1 });
    expect(store(sim, 'sw1').readFile('flash', 'r1-confg')?.content).toBe(content);
    expect(result(sim, 'sw1', 'g2')).toMatchObject({ ok: false, error: `% The TFTP server 10.0.0.1 refused the transfer: ${TFTP_ERROR_TEXT.notFound}` });
    expect(result(sim, 'sw1', 'g3')).toMatchObject({ ok: false, error: `% The TFTP server 10.0.0.1 refused the transfer: ${TFTP_ERROR_TEXT.noWrite}` });
    expect(tftpState(sim, 'r1').served).toBe(1);
  });

  it('reads service tftp and tftp-server lines', () => {
    const ast = createConfigAst();
    ast.set([], ['tftp-server', 'flash:a.cfg']);
    ast.set([], ['tftp-server', 'b.cfg']);
    ast.set([], ['tftp-server', 'nvram:startup-config']);
    expect(tftpServerConfigOf(ast.root)).toEqual({ service: false, flash: ['a.cfg', 'b.cfg'] });
    ast.set([], ['service', 'tftp', 'on']);
    expect(tftpServerConfigOf(ast.root).service).toBe(true);
    ast.set([], ['service', 'tftp', 'off']);
    expect(tftpServerConfigOf(ast.root).service).toBe(false);
  });
});

// ── the dormant switch transport (D22, §3.4 step 4, §4.3) ────────────────────

/** ICMP destination-unreachable words SW1 created since `cursor`. */
function switchUnreachables(sim: Simulation, cursor: number): string[] {
  return sim
    .trace(cursor)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'sw1' && e.process === 'icmpv4')
    .map((e) => e.pdu.summary);
}

describe('app.tftp: a switch job and the dormant transport', () => {
  it('a backup from SW1 wakes its transport for the job and the switch is dormant again afterwards', () => {
    const sim = world(14, { srvLines: ['service tftp on'] });
    const text = sim.device('sw1')!.running.render();
    job(sim, 'sw1', { owner: 'cli', token: 's1', op: 'put', server: SRV, remote: 'sw1-confg', local: { config: 'running' } });
    sim.runFor(10 * SEC);
    expect(result(sim, 'sw1', 's1')).toMatchObject({ ok: true, bytes: utf8Length(text) });
    expect(store(sim, 'srv1').readFile('files', 'sw1-confg')?.content).toBe(text);
    // a get also dallies before it releases the hold
    putFile(sim, 'srv1', 'files', 'small.txt', 'one line\n');
    job(sim, 'sw1', { owner: 'cli', token: 's2', op: 'get', server: SRV, remote: 'small.txt', local: { fs: 'flash', path: 'small.txt' } });
    sim.runFor(5 * SEC);
    expect(result(sim, 'sw1', 's2')).toMatchObject({ ok: true });
    sim.runFor(TFTP_DALLY_NS);
    expect(tftpState(sim, 'sw1').transfers).toEqual([]);
    // dormant again: a UDP probe to the switch draws protocol unreachable
    const cursor = sim.trace(0).next;
    const session = sim.cli.open('r1', 'console');
    sim.cli.exec(session, 'traceroute 10.0.0.2');
    sim.runFor(20 * SEC);
    const words = switchUnreachables(sim, cursor);
    expect(words.some((w) => w.includes('protocol'))).toBe(true);
    expect(words.some((w) => w.includes('(port)'))).toBe(false);
  });

  it('`tftp-server` is a DORMANT_TRANSPORT_OWNERS line (§4.3)', () => {
    const ast = createConfigAst();
    expect(transportWakeLine(ast.root)).toBeUndefined();
    ast.set([], ['tftp-server', 'flash:sw1-confg']);
    expect(transportWakeLine(ast.root)?.service).toBe('tftp');
  });
});

// ── silence (§4.3) ───────────────────────────────────────────────────────────

describe('app.tftp: silence', () => {
  it('without a server line or a job: no socket, no timer, no TFTP packet in 600 s', () => {
    const sim = world(15);
    sim.runFor(600 * SEC);
    for (const dev of ['srv1', 'r1', 'sw1']) {
      expect(sim.device(dev)!.processes.has('tftp')).toBe(true);
      expect(tftpState(sim, dev)).toMatchObject({ listening: false, transfers: [], results: [] });
      const udp = sim.device(dev)!.processes.get('udp')?.stateSnapshot().state as { sockets?: { id: string }[] } | undefined;
      expect((udp?.sockets ?? []).some((s) => s.id.startsWith('tftp'))).toBe(false);
    }
    expect(tftpPackets(sim)).toEqual([]);
    expect(sim.trace(0).events.some((e) => (e.kind === 'debug' && e.event.process === 'tftp') || (e.kind === 'pduCreated' && e.process === 'tftp'))).toBe(false);
  });
});

// ── the daemon alone ─────────────────────────────────────────────────────────

interface Fake {
  readonly ctx: ProcessCtx;
  now: SimTime;
}

/** A ProcessCtx with exactly what tftp reads; `service tftp on` and a files: store holding `files`. */
function fakeCtx(opts: { lines?: readonly (readonly string[])[]; files?: Readonly<Record<string, string>>; storage?: boolean }): Fake {
  const ast = createConfigAst();
  for (const l of opts.lines ?? []) ast.set([], [...l]);
  const files = opts.files ?? {};
  const fake: { now: SimTime; ctx?: ProcessCtx } = { now: 0 };
  const ctx = {
    get now() {
      return fake.now;
    },
    deviceId: 'd',
    hostname: 'D',
    model: { processes: ['udp', 'tftp'], capabilities: ['host'], ...(opts.storage ? { storage: P3C_STORAGE['router.nf2911'] } : {}) },
    config: ast,
    debug: () => undefined,
    hasCapability: (c: string) => c === 'host',
    files: (fs: FileSystemId) => (fs === 'files' ? Object.keys(files).map((path) => ({ fs, path, size: files[path]!.length, modifiedAt: 0 })) : []),
    readFile: (fs: FileSystemId, path: string) => (fs === 'files' && files[path] !== undefined ? { fs, path, size: files[path]!.length, modifiedAt: 0, content: files[path]! } : undefined),
    ownAddress: (ip: string) => (ip === '10.0.0.100' ? 'GigabitEthernet0' : undefined),
  } as unknown as ProcessCtx;
  fake.ctx = ctx;
  return fake as Fake;
}

const encode = (fields: Record<string, unknown>): Uint8Array => tftpCodec.encode(fields as never, new Uint8Array(0));
const datagram = (socket: string, from: string, fromPort: number, fields: Record<string, unknown>): ProcessEvent =>
  ({ kind: 'sock.datagram', socket, from, fromPort, to: '10.0.0.100', iface: 'GigabitEthernet0', data: encode(fields), pdu: {} as never }) as ProcessEvent;

/** The tftp packets in `actions`: [socket, dst, dstPort, fields]. */
function sends(actions: readonly Action[]): { socket: string; dst: string; dstPort: number; fields: Record<string, unknown> }[] {
  const out: { socket: string; dst: string; dstPort: number; fields: Record<string, unknown> }[] = [];
  for (const a of actions) {
    if (a.type !== 'request' || a.req.kind !== 'udp.send') continue;
    const r = a.req as Extract<ProcessRequest, { kind: 'udp.send' }>;
    out.push({ socket: r.socket, dst: r.dst, dstPort: r.dstPort, fields: r.app![0]!.fields as Record<string, unknown> });
  }
  return out;
}

describe('app.tftp: the daemon alone', () => {
  it('a packet from a port that is not the transfer’s draws ERROR 5 and aborts nothing', () => {
    const f = fakeCtx({ lines: [['service', 'tftp', 'on']], files: { 'a.txt': 'hello\n' } });
    const p = createTftp();
    p.init!(f.ctx);
    const opened = p.onEvent!(f.ctx, datagram(TFTP_LISTEN_SOCKET, '10.0.0.1', 50000, { opcode: TFTP_OPCODE.rrq, filename: 'a.txt', mode: 'octet' }));
    const [data1] = sends(opened);
    expect(data1).toMatchObject({ dst: '10.0.0.1', dstPort: 50000, fields: { opcode: TFTP_OPCODE.data, block: 1 } });
    const session = data1!.socket;
    expect(session).not.toBe(TFTP_LISTEN_SOCKET);
    const stray = p.onEvent!(f.ctx, datagram(session, '10.0.0.1', 50001, { opcode: TFTP_OPCODE.ack, block: 1 }));
    expect(sends(stray)).toEqual([{ socket: session, dst: '10.0.0.1', dstPort: 50001, fields: { opcode: TFTP_OPCODE.error, errorCode: TFTP_ERROR.unknownTransferId, errorMsg: TFTP_ERROR_TEXT.unknownTid } }]);
    // the transfer goes on: the right port's ACK closes it (the file fit in one block)
    const done = p.onEvent!(f.ctx, datagram(session, '10.0.0.1', 50000, { opcode: TFTP_OPCODE.ack, block: 1 }));
    expect(done.some((a) => a.type === 'request' && a.req.kind === 'udp.close' && a.req.socket === session)).toBe(true);
    expect((p.stateSnapshot().state as { served: number }).served).toBe(1);
  });

  it('ERROR 0 for a mode other than octet and for a ninth session; a retransmitted request is not a new session', () => {
    const f = fakeCtx({ lines: [['service', 'tftp', 'on']], files: { 'a.txt': 'x'.repeat(2000) } });
    const p = createTftp();
    p.init!(f.ctx);
    const mode = p.onEvent!(f.ctx, datagram(TFTP_LISTEN_SOCKET, '10.0.0.9', 40000, { opcode: TFTP_OPCODE.rrq, filename: 'a.txt', mode: 'netascii' }));
    expect(sends(mode)[0]!.fields).toEqual({ opcode: TFTP_OPCODE.error, errorCode: 0, errorMsg: TFTP_ERROR_TEXT.mode });
    for (let i = 0; i < TFTP_SERVER_SESSIONS; i++) {
      const a = p.onEvent!(f.ctx, datagram(TFTP_LISTEN_SOCKET, '10.0.0.9', 40001 + i, { opcode: TFTP_OPCODE.rrq, filename: 'a.txt', mode: 'octet' }));
      expect(sends(a)[0]!.fields).toMatchObject({ opcode: TFTP_OPCODE.data, block: 1 });
    }
    const again = p.onEvent!(f.ctx, datagram(TFTP_LISTEN_SOCKET, '10.0.0.9', 40001, { opcode: TFTP_OPCODE.rrq, filename: 'a.txt', mode: 'octet' }));
    expect(sends(again)).toEqual([]);
    const ninth = p.onEvent!(f.ctx, datagram(TFTP_LISTEN_SOCKET, '10.0.0.9', 49999, { opcode: TFTP_OPCODE.rrq, filename: 'a.txt', mode: 'octet' }));
    expect(sends(ninth)[0]).toMatchObject({ socket: TFTP_LISTEN_SOCKET, fields: { opcode: TFTP_OPCODE.error, errorCode: 0, errorMsg: TFTP_ERROR_TEXT.busy } });
    expect((p.stateSnapshot().state as { transfers: unknown[] }).transfers).toHaveLength(TFTP_SERVER_SESSIONS);
  });

  it('a server that ignores tsize: the client checks flash as blocks arrive and aborts with ERROR 3', () => {
    const f = fakeCtx({ storage: true });
    const p = createTftp();
    p.init!(f.ctx);
    const req: TransferRequest = { kind: 'tftp.transfer', owner: 'cli', token: 'z', op: 'get', server: '10.0.0.7', remote: 'big.bin', local: { fs: 'flash', path: 'big.bin' }, image: true };
    const start = p.onRequest!(f.ctx, req);
    const [rrq] = sends(start);
    expect(rrq!.fields).toMatchObject({ opcode: TFTP_OPCODE.rrq, filename: 'big.bin', mode: 'octet', tsize: 0 });
    expect(start).toContainEqual({ type: 'timer', key: tftpTimerKey('z'), delay: TFTP_RETRANSMIT_NS });
    // DATA 1 straight away (no OACK), carrying an image header whose nominal size exceeds the free flash
    const header = imageHeader(300 * MIB);
    const data = new TextEncoder().encode(header + 'F'.repeat(TFTP_BLOCK_BYTES - header.length));
    const ev = { kind: 'sock.datagram', socket: rrq!.socket, from: '10.0.0.7', fromPort: 51000, to: '10.0.0.1', iface: 'Gi0/0', data: encode({ opcode: TFTP_OPCODE.data, block: 1, data }), pdu: {} } as unknown as ProcessEvent;
    const out = p.onEvent!(f.ctx, ev);
    expect(sends(out)).toEqual([{ socket: rrq!.socket, dst: '10.0.0.7', dstPort: 51000, fields: { opcode: TFTP_OPCODE.error, errorCode: TFTP_ERROR.diskFull, errorMsg: TFTP_ERROR_TEXT.diskFull } }]);
    const r = (p.stateSnapshot().state as { results: TftpResultEvent[] }).results[0]!;
    expect(r).toMatchObject({ token: 'z', ok: false, bytes: 0, blocks: 0 });
    expect(r.error).toMatch(/^% Not enough room in flash: the file needs 314572800 bytes and \d+ are free\.$/);
  });
});
