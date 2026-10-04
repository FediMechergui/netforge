/**
 * app.vty — [S13] the remote terminal over the network (ARCHITECTURE-P3 D14, D22, §3.14; §7 W3 svc; rulings R17, R27).
 *
 * On `staged.world` at stage P3 (rule 13). The `vty`, `vty-client` and `acl` daemons are not registered before the W4
 * flip, so they are passed through `factories`; every device is configured through `startupConfig` (the config rules).
 * The §3.14 world: PC1 192.168.10.10 and PC2 192.168.10.11 on SW1 (NF-C2960, Vlan1 192.168.10.2) → R1 Gi0/0
 * 192.168.10.1. Lines are typed on the PCs' consoles (`sim.cli`), exactly as a learner would.
 *
 * Pinned (§3.14): a hidden SSH listener only (no row, not in the tcp StateView), so telnet is refused by tcp with no
 * login row; the access-class refusal of PC2 after the handshake — the implicit row counted with `lastIface 'vty'`, a
 * severity-5 log and a `refused` row naming the user; the SSH login of a privilege-15 `login local` user (clear version
 * strings, then `protectedBy 'ssh'` segments that never show the password; the `R1 via SSH` chip, R1#, `exit`); a telnet
 * login with a line password (masked prompt, the password in clear one character per segment, a `failed` row for a
 * wrong one); nested sessions to the depth cap of 4; and the switch rule: P1 lines leave SW1 dormant (protocol
 * unreachable), an outbound session from SW1 itself works (R27), `transport input` wakes it.
 */
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/contracts/ids.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MSG_REMOTE_DEPTH, REMOTE_SESSION_PREFIX } from '../src/cli/runtime.js';
import { createAcl } from '../src/protocols/acl.js';
import { createVtyClient, VTY_CLIENT_DENIED } from '../src/protocols/vty-client.js';
import {
  createVty,
  createVtyTermReader,
  readVtyConfig,
  VTY_MSG_LOGIN_FAILED,
  VTY_PROMPT_PASSWORD,
  VTY_SSH_VERSION,
  vtySshCrypt,
  vtySshKey,
  vtySshPacket,
  vtySshUnpack,
  vtyTermLine,
  vtyTermOutput,
} from '../src/protocols/vty.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createStagedSimulation } from './staged.world.js';

const R1 = '192.168.10.1';
const SW1 = '192.168.10.2';
const PC1 = '192.168.10.10';
const PC2 = '192.168.10.11';
const ADMIN_PASSWORD = 'Lab-Pass1';
const LINE_PASSWORD = 'Vty-Pass';
/** Boot, links up and spanning tree forwarding on SW1's ports (listening + learning) before anything is typed. */
const BOOT_NS = 100 * SEC;
const FACTORIES = { vty: createVty, 'vty-client': createVtyClient, acl: createAcl } as const;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** R1's §3.14 lines: SSH only, `login local` with a privilege-15 user, access-class 10 (PC1 only). */
const SSH_ONLY: readonly (readonly string[])[] = [
  ['ip domain-name lab.nf'],
  ['crypto key generate rsa modulus 1024'],
  ['ip ssh version 2'],
  [`username admin privilege 15 secret ${ADMIN_PASSWORD}`],
  [`access-list 10 permit host ${PC1}`],
  ['line vty 0 4', ' login local', ' transport input ssh', ' access-class 10 in'],
];

/** A telnet line with a line password (the transport is the default `telnet ssh`; no key, so no SSH listener). */
const TELNET_PASSWORD: readonly (readonly string[])[] = [['line vty 0 4', ` password ${LINE_PASSWORD}`, ' login']];

/** The §3.14 world: PC1, PC2 and R1 on SW1. Boot BOOT_NS. */
function world(r1Lines: readonly (readonly string[])[], swLines: readonly (readonly string[])[] = [], seed = 14): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: FACTORIES });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ` ip address ${R1} 255.255.255.0`, ' no shutdown'], ...r1Lines]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface Vlan1', ` ip address ${SW1} 255.255.255.0`, ' no shutdown'], [`ip default-gateway ${R1}`], ...swLines]),
  });
  for (const [id, name, ip] of [['pc1', 'PC1', PC1], ['pc2', 'PC2', PC2]] as const) {
    sim.addDevice({ id, type: 'pc.nfpc', name, startupConfig: startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${R1}`]]) });
  }
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runFor(BOOT_NS);
  return sim;
}

type PromptEvent = Extract<TraceEvent, { kind: 'cliPrompt' }>;

/** One line typed on a console session, and what the session showed in the `runNs` after it. */
interface Typed {
  readonly text: string[];
  readonly prompts: PromptEvent[];
  readonly events: TraceEvent[];
}

function type(sim: Simulation, s: SessionId, line: string, runNs: SimTime = 3 * SEC): Typed {
  const cursor = sim.trace(0).next;
  sim.cli.exec(s, line);
  sim.runFor(runNs);
  const events = sim.trace(cursor).events;
  return {
    text: events.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : [])),
    prompts: events.filter((e): e is PromptEvent => e.kind === 'cliPrompt' && e.session === s),
    events,
  };
}

const lastPrompt = (t: Typed): PromptEvent | undefined => t.prompts.at(-1);

/** What `device`'s own console prints for `line` (in privileged EXEC when `enable`), on a session opened and closed here. */
function localOutput(sim: Simulation, device: string, line: string, enable: boolean): string {
  const c = sim.cli.open(device, 'console');
  if (enable) sim.cli.exec(c, 'enable');
  const out = sim.cli.exec(c, line).output;
  sim.cli.close(c);
  return out;
}
const logins = (sim: Simulation, device: string): VtyLoginRow[] => (sim.device(device)!.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => ({ ...r }));
const loginShape = (r: VtyLoginRow) => ({ seq: r.seq, proto: r.proto, peer: r.peer, user: r.user, result: r.result, reason: r.reason });

/** The TCP segments `device` created (as PDUs) among `events`, with their tcp fields. */
function segments(sim: Simulation, events: readonly TraceEvent[], device: string): PduView[] {
  return events.flatMap((e) => {
    if (e.kind !== 'pduCreated' || e.device !== device || e.process !== 'tcp') return [];
    const p = sim.pdu(e.pdu.id);
    return p !== undefined && p.layer('tcp') !== undefined ? [p] : [];
  });
}
const tcpField = (p: PduView, f: string): unknown => p.layer('tcp')?.fields[f];
const hasData = (p: PduView): boolean => p.layers.some((l) => l.proto === 'ssh' || l.proto === 'telnet');

describe('app.vty: the terminal stream and the SSH framing', () => {
  it('round-trips output, masked and plain prompts through a reader fed one byte at a time', () => {
    const echo = { masked: false };
    const bytes = [
      ...vtyTermOutput({ text: 'line one\nline two' }, echo),
      ...vtyTermOutput({ text: '', prompt: 'Password: ', secret: true }, echo),
      ...vtyTermOutput({ text: '', prompt: 'Password: ', secret: true }, echo),
      ...vtyTermOutput({ text: 'ok\n', prompt: 'R1>' }, echo),
    ];
    expect(echo.masked).toBe(false);
    const reader = createVtyTermReader();
    const events = bytes.flatMap((b) => reader.feed(Uint8Array.of(b)));
    expect(events).toEqual([
      { kind: 'line', text: 'line one' },
      { kind: 'line', text: 'line two' },
      { kind: 'prompt', text: 'Password: ', masked: true },
      { kind: 'prompt', text: 'Password: ', masked: true },
      { kind: 'line', text: 'ok' },
      { kind: 'line', text: '' },
      { kind: 'prompt', text: 'R1>', masked: false },
    ]);
    // a doubled IAC is data, ^C and IAC IP are interrupts, other commands are skipped
    expect(createVtyTermReader().feed(Uint8Array.of(0x61, 0xff, 0xfd, 0x03, 0x03, 0xff, 0xf4, 0x62, 0x0d, 0x0a))).toEqual([
      { kind: 'interrupt' },
      { kind: 'interrupt' },
      { kind: 'line', text: 'ab' },
    ]);
    expect(vtyTermLine('show version')).toEqual(new TextEncoder().encode('show version\r\n'));
  });

  it('frames protected packets with a keystream that is its own inverse and differs per direction', () => {
    const c2s = vtySshKey(PC1, 50000, R1, 22);
    const s2c = vtySshKey(R1, 22, PC1, 50000);
    expect(c2s).not.toBe(s2c);
    const body = new TextEncoder().encode(`admin\0${ADMIN_PASSWORD}`);
    expect(vtySshCrypt(c2s, vtySshCrypt(c2s, body))).toEqual(body);
    expect(vtySshCrypt(c2s, body)).not.toEqual(body);
    const a = vtySshPacket(c2s, 50, body);
    const b = vtySshPacket(c2s, 94, vtyTermLine('exit'));
    const wire = Uint8Array.from([...a, ...b]);
    // split anywhere: complete packets come out, the rest waits
    const first = vtySshUnpack(c2s, wire.subarray(0, a.length + 3));
    expect(first.packets.map((p) => [p[0], new TextDecoder().decode(p.subarray(1))])).toEqual([[50, `admin\0${ADMIN_PASSWORD}`]]);
    expect(first.rest.length).toBe(3);
    const second = vtySshUnpack(c2s, Uint8Array.from([...first.rest, ...wire.subarray(a.length + 3)]));
    expect(second.packets.map((p) => [p[0], new TextDecoder().decode(p.subarray(1))])).toEqual([[94, 'exit\r\n']]);
    expect(second.rest.length).toBe(0);
  });
});

describe('app.vty: the server reads its configuration', () => {
  it('derives the transport (default telnet ssh), the login method, the access-class and the key', () => {
    const ast = createConfigAst();
    const vty = [['line', 'vty', '0', '4']];
    expect(readVtyConfig(ast.root)).toEqual({ lines: [], rsaKey: false, sshRetries: 3, sshTimeoutS: 120 });
    ast.set([], ['line', 'vty', '0', '4']);
    ast.set(vty, ['password', 'nf']);
    expect(readVtyConfig(ast.root).lines).toEqual([{ name: 'vty 0 4', transport: ['telnet', 'ssh'], login: 'line', password: 'nf' }]);
    ast.set(vty, ['login', 'local']);
    ast.set(vty, ['transport', 'input', 'ssh']);
    ast.set(vty, ['access-class', '10', 'in']);
    ast.set([], ['crypto', 'key', 'generate', 'rsa', 'modulus', '1024']);
    ast.set([], ['ip', 'ssh', 'authentication-retries', '2']);
    ast.set([], ['ip', 'ssh', 'time-out', '60']);
    expect(readVtyConfig(ast.root)).toEqual({
      lines: [{ name: 'vty 0 4', transport: ['ssh'], accessClass: '10', login: 'local', password: 'nf' }],
      rsaKey: true, sshRetries: 2, sshTimeoutS: 60,
    });
    ast.set(vty, ['transport', 'input', 'none']);
    ast.set([], ['line', 'vty', '5', '15']);
    expect(readVtyConfig(ast.root).lines.map((l) => [l.name, l.transport, l.login])).toEqual([['vty 0 4', [], 'local'], ['vty 5 15', ['telnet', 'ssh'], 'none']]);
  });
});

describe('app.vty: SSH-only access with a vty ACL (§3.14)', () => {
  it('opens a hidden listener on 22 only: no row, not in the tcp StateView; telnet is refused by tcp, no login row', () => {
    const sim = world(SSH_ONLY);
    const boot = sim.trace(0).events;
    // silent: no debug, log or table write of the vty daemons at boot
    expect(boot.filter((e) => e.kind === 'debug' && (e.event.process === 'vty' || e.event.process === 'vty-client'))).toEqual([]);
    expect(boot.filter((e) => e.kind === 'tableWrite' && e.table === 'vty-logins')).toEqual([]);
    const r1 = sim.device('r1')!;
    expect(r1.processes.get('vty')!.stateSnapshot().state['listening']).toEqual(['ssh']);
    expect(r1.processes.get('tcp')!.stateSnapshot().state['listeners']).toEqual([]);
    expect(r1.tables.get('sockets')!.rows()).toEqual([]);
    // the acl rows of list 10 carry the vty binding
    expect((r1.tables.get<AclRow>('acl')?.rows() ?? []).map((r) => [r.key, r.applied])).toEqual([['4|10|10', 'vty in'], ['4|10|implicit', 'vty in']]);

    const s = sim.cli.open('pc1', 'console');
    const t = type(sim, s, `telnet ${R1}`);
    expect(t.text).toEqual([`Connecting to ${R1} port 23 ...`, `% Connection refused by ${R1}`]);
    expect(lastPrompt(t)).toMatchObject({ prompt: 'PC1>', busy: false });
    expect(sim.cli.session(s)?.remote).toBeUndefined();
    // tcp answered the SYN with a RST: no login row
    expect(t.events.some((e) => e.kind === 'drop' && e.device === 'r1' && e.detail === 'tcp port 23 closed')).toBe(true);
    expect(logins(sim, 'r1')).toEqual([]);
  });

  it('access-class refuses PC2 after the handshake: the implicit row counted (vty), a severity-5 log, a refused row', () => {
    const sim = world(SSH_ONLY);
    const s = sim.cli.open('pc2', 'console');
    // the password is asked locally, before the connection
    const ask = type(sim, s, `ssh -l admin ${R1}`, 1 * SEC);
    expect(lastPrompt(ask)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, busy: false, input: { kind: 'secret', prompt: VTY_PROMPT_PASSWORD } });
    expect(ask.events.some((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.process === 'tcp')).toBe(false);
    const t = type(sim, s, ADMIN_PASSWORD);
    expect(t.text).toEqual([`Connecting to ${R1} port 22 ...`, `% Connection refused by ${R1}`]);
    expect(lastPrompt(t)).toMatchObject({ prompt: 'PC2>', busy: false });
    // the RST comes after the handshake and the SSH version exchange
    const r1Segs = segments(sim, t.events, 'r1');
    expect(r1Segs.map((p) => tcpField(p, 'flags'))).toContain('SA');
    expect(String(tcpField(r1Segs.at(-1)!, 'flags'))).toContain('R');
    // counted on the implicit row of list 10, as a vty check
    const implicit = sim.device('r1')!.tables.get<AclRow>('acl')!.get('4|10|implicit')!;
    expect(implicit).toMatchObject({ matches: 1, lastIface: 'vty', lastDir: 'in', applied: 'vty in' });
    expect(implicit.lastPdu).toBeUndefined();
    expect(sim.device('r1')!.tables.get<AclRow>('acl')!.get('4|10|10')!.matches).toBe(0);
    const logs = t.events.filter((e): e is Extract<TraceEvent, { kind: 'log' }> => e.kind === 'log' && e.device === 'r1' && e.facility === 'VTY');
    expect(logs.map((l) => [l.severity, l.message])).toEqual([[5, `Remote SSH login for user admin from ${PC2} refused by access-class 10`]]);
    expect(logins(sim, 'r1').map(loginShape)).toEqual([{ seq: 1, proto: 'ssh', peer: PC2, user: 'admin', result: 'refused', reason: 'access-class 10' }]);
    expect(sim.cli.sessions().filter((v) => v.via === 'vty')).toEqual([]);
    expect(sim.device('pc2')!.processes.get('vty-client')!.stateSnapshot().state['results']).toMatchObject([{ session: s, proto: 'ssh', target: R1, outcome: 'refused' }]);
  });

  it('logs PC1 in over SSH (privilege 15): clear version strings, protected segments, the chip and R1#; exit closes it', () => {
    const sim = world(SSH_ONLY);
    const s = sim.cli.open('pc1', 'console');
    type(sim, s, `ssh -l admin ${R1}`, 1 * SEC);
    const t = type(sim, s, ADMIN_PASSWORD);
    expect(t.text).toEqual([`Connecting to ${R1} port 22 ...`]);
    expect(lastPrompt(t)).toMatchObject({ prompt: 'R1#', busy: false });
    expect(lastPrompt(t)?.input).toBeUndefined();
    expect(sim.cli.session(s)).toMatchObject({ prompt: 'R1#', remote: 'R1 via SSH', busy: false });
    // the permit is counted on row 10 (vty); a success row; a via-vty session at privileged EXEC on R1
    expect(sim.device('r1')!.tables.get<AclRow>('acl')!.get('4|10|10')!).toMatchObject({ matches: 1, lastIface: 'vty' });
    expect(logins(sim, 'r1').map(loginShape)).toEqual([{ seq: 1, proto: 'ssh', peer: PC1, user: 'admin', result: 'success', reason: undefined }]);
    const remote = sim.cli.sessions().filter((v) => v.via === 'vty');
    expect(remote.map((v) => [v.device, v.id, v.mode, v.privilege])).toEqual([['r1', `${REMOTE_SESSION_PREFIX}1`, 'priv-exec', 15]]);
    // capture: the version strings in clear, every later data segment protected by 'ssh'; the password never in clear
    const segs = [...segments(sim, t.events, 'pc1'), ...segments(sim, t.events, 'r1')].filter(hasData);
    const versions = segs.filter((p) => p.layer('ssh')?.fields['phase'] === 'version');
    expect(versions.map((p) => p.layer('ssh')!.fields['version'])).toEqual([VTY_SSH_VERSION, VTY_SSH_VERSION]);
    for (const p of versions) expect(p.meta.protected).toBeUndefined();
    const isSealed = (p: PduView): boolean => p.layer('ssh')?.fields['phase'] === 'protected';
    const sealed = segs.filter(isSealed);
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    for (const p of sealed) expect(p.meta).toMatchObject({ protected: true, protectedBy: 'ssh' });
    const needle = Buffer.from(ADMIN_PASSWORD, 'utf8').toString('hex');
    for (const p of segs) expect(Buffer.from(p.bytes).toString('hex')).not.toContain(needle);
    // ... while the keystream of the segment's endpoints reveals the user and password (the inspector's decoding)
    const auth = segments(sim, t.events, 'pc1').filter(isSealed)[0]!;
    const ip = auth.layer('ipv4')!.fields;
    const key = vtySshKey(String(ip['src']), Number(tcpField(auth, 'srcPort')), String(ip['dst']), Number(tcpField(auth, 'dstPort')));
    const plain = Buffer.from(vtySshCrypt(key, auth.layer('ssh')!.fields['payload'] as Uint8Array));
    expect(plain[0]).toBe(50);
    expect(plain.subarray(1).toString('utf8')).toBe(`admin\0${ADMIN_PASSWORD}`);

    // a command runs on R1; its output comes back over the connection
    const show = type(sim, s, 'show running-config | include hostname');
    // exactly what R1's own console prints for the line
    expect(show.text).toEqual(['hostname R1\n']);
    expect(show.text).toEqual([localOutput(sim, 'r1', 'show running-config | include hostname', true)]);
    expect(lastPrompt(show)).toMatchObject({ prompt: 'R1#' });
    expect(show.events.filter((e) => e.kind === 'cliOutput' && e.session !== s)).toEqual([]);
    // exit: the remote session ends, the console is PC1's again
    const bye = type(sim, s, 'exit');
    expect(bye.text).toEqual([`% Connection to ${R1} closed by the remote device.`]);
    expect(lastPrompt(bye)).toMatchObject({ prompt: 'PC1>', busy: false });
    expect(sim.cli.session(s)?.remote).toBeUndefined();
    expect(sim.cli.sessions().filter((v) => v.via === 'vty')).toEqual([]);
    expect(sim.device('r1')!.processes.get('vty')!.stateSnapshot().state['connections']).toEqual([]);
  });

  it('a wrong SSH password is a failed row and asks again; the right one logs in', () => {
    const sim = world(SSH_ONLY);
    const s = sim.cli.open('pc1', 'console');
    type(sim, s, `ssh -l admin ${R1}`, 1 * SEC);
    const bad = type(sim, s, 'wrong');
    expect(bad.text).toEqual([`Connecting to ${R1} port 22 ...`, VTY_CLIENT_DENIED]);
    expect(lastPrompt(bad)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
    expect(logins(sim, 'r1').map(loginShape)).toEqual([{ seq: 1, proto: 'ssh', peer: PC1, user: 'admin', result: 'failed', reason: 'bad password' }]);
    const good = type(sim, s, ADMIN_PASSWORD);
    expect(lastPrompt(good)).toMatchObject({ prompt: 'R1#' });
    expect(logins(sim, 'r1').map((r) => r.result)).toEqual(['failed', 'success']);
  });
});

describe('app.vty: telnet with a line password', () => {
  it('masks the prompt, carries the password in clear one character per segment, and logs in at user EXEC', () => {
    const sim = world(TELNET_PASSWORD);
    expect(sim.device('r1')!.processes.get('vty')!.stateSnapshot().state['listening']).toEqual(['telnet']);
    const s = sim.cli.open('pc1', 'console');
    const open = type(sim, s, `telnet ${R1}`);
    expect(open.text).toEqual([`Connecting to ${R1} port 23 ...`, `Connected to ${R1}.`]);
    expect(lastPrompt(open)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, busy: false, input: { kind: 'secret' } });
    // the server announced WILL ECHO before the prompt
    expect(segments(sim, open.events, 'r1').filter(hasData).map((p) => p.layer('telnet')!.fields['iac'])).toContain('WILL ECHO;GA');
    // a wrong password: a failed row, the message, the masked prompt again
    const bad = type(sim, s, 'nope', 5 * SEC);
    expect(bad.text).toEqual([VTY_MSG_LOGIN_FAILED]);
    expect(lastPrompt(bad)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
    expect(logins(sim, 'r1').map(loginShape)).toEqual([{ seq: 1, proto: 'telnet', peer: PC1, user: undefined, result: 'failed', reason: 'bad password' }]);
    const good = type(sim, s, LINE_PASSWORD, 5 * SEC);
    expect(lastPrompt(good)).toMatchObject({ prompt: 'R1>', busy: false });
    expect(lastPrompt(good)?.input).toBeUndefined();
    expect(sim.cli.session(s)?.remote).toBe('R1 via Telnet');
    // "telnet sends the password in the clear": one character per segment, then the line end
    const typed = segments(sim, good.events, 'pc1').filter(hasData).map((p) => p.layer('telnet')!.fields['data']);
    expect(typed).toEqual([...LINE_PASSWORD.split(''), '\r\n']);
    for (const p of segments(sim, good.events, 'pc1')) expect(p.meta.protected).toBeUndefined();
    expect(logins(sim, 'r1').map(loginShape)).toEqual([
      { seq: 1, proto: 'telnet', peer: PC1, user: undefined, result: 'failed', reason: 'bad password' },
      { seq: 2, proto: 'telnet', peer: PC1, user: undefined, result: 'success', reason: undefined },
    ]);
    expect(sim.cli.sessions().filter((v) => v.via === 'vty').map((v) => [v.device, v.mode])).toEqual([['r1', 'user-exec']]);
    // an ordinary line goes in one segment
    const show = type(sim, s, 'show running-config | include hostname');
    expect(show.text).toEqual([localOutput(sim, 'r1', 'show running-config | include hostname', false)]);
    expect(segments(sim, show.events, 'pc1').filter(hasData).map((p) => p.layer('telnet')!.fields['data'])).toEqual(['show running-config | include hostname\r\n']);
    const bye = type(sim, s, 'exit');
    expect(bye.text).toEqual([`% Connection to ${R1} closed by the remote device.`]);
    expect(lastPrompt(bye)).toMatchObject({ prompt: 'PC1>' });
  });

  it('^C ends a client session; a vty line without a password refuses the login', () => {
    const sim = world(TELNET_PASSWORD);
    const s = sim.cli.open('pc1', 'console');
    type(sim, s, `telnet ${R1}`);
    const cursor = sim.trace(0).next;
    sim.cli.interrupt(s);
    sim.runFor(2 * SEC);
    const evs = sim.trace(cursor).events;
    expect(evs.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : []))).toEqual([`% Connection to ${R1} closed.`]);
    expect(sim.cli.session(s)).toMatchObject({ prompt: 'PC1>', busy: false });
    expect(sim.device('r1')!.processes.get('vty')!.stateSnapshot().state['connections']).toEqual([]);
    expect(logins(sim, 'r1')).toEqual([]);

    const bare = world([['line vty 0 4']]);
    const b = bare.cli.open('pc1', 'console');
    const t = type(bare, b, `telnet ${R1}`);
    expect(t.text).toEqual([
      `Connecting to ${R1} port 23 ...`,
      `Connected to ${R1}.`,
      '% Remote login needs a password, but none is set on the vty lines.',
      `% Connection to ${R1} closed by the remote device.`,
    ]);
    expect(logins(bare, 'r1').map(loginShape)).toEqual([{ seq: 1, proto: 'telnet', peer: PC1, user: undefined, result: 'failed', reason: 'no password set' }]);
  });
});

describe('app.vty: nested sessions', () => {
  it(`nest through R1 … R4 and stop at the depth cap of 4`, () => {
    const sim = createStagedSimulation({ seed: 44, stage: 'P3', factories: FACTORIES });
    const routers = [1, 2, 3, 4, 5];
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.10.100 255.255.255.0']]) });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    for (const n of routers) {
      sim.addDevice({
        id: `r${n}`, type: 'router.nf2911', name: `R${n}`,
        startupConfig: startup([[`hostname R${n}`], ['interface GigabitEthernet0/0', ` ip address 192.168.10.${n} 255.255.255.0`, ' no shutdown'], ['line vty 0 4', ' password nf', ' login']]),
      });
      sim.addLink({ a: { device: `r${n}`, port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: `FastEthernet0/${n + 1}` } });
    }
    sim.runFor(BOOT_NS);
    const s = sim.cli.open('pc1', 'console');
    for (const n of [1, 2, 3, 4]) {
      const ask = type(sim, s, `telnet 192.168.10.${n}`, 5 * SEC);
      expect(lastPrompt(ask)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
      const t = type(sim, s, 'nf', 10 * SEC);
      expect(lastPrompt(t)).toMatchObject({ prompt: `R${n}>`, busy: false });
      expect(logins(sim, `r${n}`).map((r) => r.result)).toEqual(['success']);
    }
    // the chip names the first hop
    expect(sim.cli.session(s)?.remote).toBe('R1 via Telnet');
    expect(sim.cli.sessions().filter((v) => v.via === 'vty').map((v) => v.device)).toEqual(['r1', 'r2', 'r3', 'r4']);
    // the fourth remote session may not open a fifth
    const deep = type(sim, s, 'telnet 192.168.10.5', 10 * SEC);
    expect(deep.text).toEqual([MSG_REMOTE_DEPTH]);
    expect(lastPrompt(deep)).toMatchObject({ prompt: 'R4>', busy: false });
    expect(logins(sim, 'r5')).toEqual([]);
    expect(JSON.stringify(sim.device('r4')!.processes.get('vty-client')!.stateSnapshot().state['results'])).not.toContain('192.168.10.5');
    // logging out of R4 returns to R3
    const back = type(sim, s, 'exit', 5 * SEC);
    expect(back.text).toEqual(['% Connection to 192.168.10.4 closed by the remote device.']);
    expect(lastPrompt(back)).toMatchObject({ prompt: 'R3>' });
    expect(sim.cli.sessions().filter((v) => v.via === 'vty').map((v) => v.device)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('app.vty: a managed switch (D22, R17/R27)', () => {
  /** SW1's P1 lines: a vty section with `login local` and a user — they never wake the transport. */
  const P1_LINES: readonly (readonly string[])[] = [[`username admin secret ${ADMIN_PASSWORD}`], ['line vty 0 4', ' login local']];

  it('P1 lines leave SW1 dormant (protocol unreachable); an outbound session from SW1 itself works; dormant again after', () => {
    const sim = world(TELNET_PASSWORD, P1_LINES);
    const pc = sim.cli.open('pc1', 'console');
    const before = type(sim, pc, `telnet ${SW1}`);
    expect(before.text).toEqual([`Connecting to ${SW1} port 23 ...`, `% Cannot reach ${SW1}: protocol unreachable.`]);
    expect(before.events.some((e) => e.kind === 'drop' && e.device === 'sw1' && e.detail === 'ip protocol 6 has no listener')).toBe(true);
    expect(logins(sim, 'sw1')).toEqual([]);
    // SW1's own console opens a session to R1 (R27: the outbound session wakes the transport for its own life)
    const sw = sim.cli.open('sw1', 'console');
    const ask = type(sim, sw, `telnet ${R1}`);
    expect(ask.text).toEqual([`Connecting to ${R1} port 23 ...`, `Connected to ${R1}.`]);
    expect(lastPrompt(ask)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
    const t = type(sim, sw, LINE_PASSWORD, 5 * SEC);
    expect(lastPrompt(t)).toMatchObject({ prompt: 'R1>' });
    expect(sim.cli.session(sw)?.remote).toBe('R1 via Telnet');
    expect(logins(sim, 'r1').map((r) => [r.peer, r.result])).toEqual([[SW1, 'success']]);
    expect(t.events.some((e) => e.kind === 'drop' && e.device === 'sw1' && e.detail === 'ip protocol 6 has no listener')).toBe(false);
    const bye = type(sim, sw, 'exit');
    expect(bye.text).toEqual([`% Connection to ${R1} closed by the remote device.`]);
    expect(lastPrompt(bye)).toMatchObject({ prompt: 'SW1>' });
    // the session is gone, and so is the wake-up
    const after = type(sim, pc, `telnet ${SW1}`);
    expect(after.text).toEqual([`Connecting to ${SW1} port 23 ...`, `% Cannot reach ${SW1}: protocol unreachable.`]);
  });

  it('a transport input line (a P3 line) wakes SW1: telnet then reaches its vty and logs in with login local', () => {
    const sim = world([], [...P1_LINES, ['line vty 0 4', ' transport input telnet']]);
    const pc = sim.cli.open('pc1', 'console');
    const user = type(sim, pc, `telnet ${SW1}`);
    expect(lastPrompt(user)).toMatchObject({ prompt: 'Username: ' });
    expect(lastPrompt(user)?.input).toBeUndefined();
    const pw = type(sim, pc, 'admin', 5 * SEC);
    expect(lastPrompt(pw)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
    const t = type(sim, pc, ADMIN_PASSWORD, 10 * SEC);
    expect(lastPrompt(t)).toMatchObject({ prompt: 'SW1>' });
    expect(sim.cli.session(pc)?.remote).toBe('SW1 via Telnet');
    expect(logins(sim, 'sw1').map(loginShape)).toEqual([{ seq: 1, proto: 'telnet', peer: PC1, user: 'admin', result: 'success', reason: undefined }]);
  });
});
