/**
 * P3 acceptance [S13] — SSH-only access with a vty ACL, over the network (ARCHITECTURE-P3 §10.1 row `accept.p3.vty`;
 * §3.14, D14, D22, §2.4, §2.7; rulings R27, R38, R43; §7 W4 qa).
 *
 * Built on `staged.world` at stage P3 with the registry the W4 flip writes (`accept.p3.flip-factories.ts`), so the
 * world runs what a flipped P3 world runs. The §3.14 world: PC1 192.168.10.10 and PC2 192.168.10.11 on SW1 (NF-C2960,
 * Vlan1 192.168.10.2) → R1 Gi0/0 192.168.10.1; the routers and the switch are configured through the grammar
 * (`Simulation.configure`) after boot, and every client line is typed on a PC's console. Each typed line is followed by
 * a run that dispatches the scheduler ONE EVENT AT A TIME (`stepped`), so the test sees in which dispatch each remote
 * session appears and ends. The row, clause by clause:
 *   • telnet with a line password (masked prompt, `R1>`, a `success` row); SSH with `login local` and a key;
 *   • `transport input ssh` refuses telnet: tcp answers the SYN with a RST, no `vty-logins` row;
 *   • `access-class 10` refuses PC2 after the handshake (the RST follows the SYN-ACK and the version exchange), counted
 *     on the implicit row with `lastIface 'vty'`, logged at severity 5, a `refused` row; it admits PC1 (row 10 counted, a
 *     `success` row, the `R1 via SSH` chip);
 *   • telnet bytes carry the password in clear, one character per segment; no SSH byte carries it (the protected
 *     segments decode only with the keystream of their endpoints);
 *   • every remote session goes through the `remoteCli` SimEvent: the via-'vty' session count changes only in the
 *     dispatch of a `remoteCli` event (open +1, the `exit` line −1), and `DeviceRuntimeDeps` has no remote member;
 *   • nesting stops at depth 4 (`MSG_REMOTE_DEPTH`, nothing reaches the fifth router);
 *   • on a switch, `line vty` with P1 lines alone leaves the transport dormant ("protocol unreachable", the P2 drop);
 *     `transport input ssh` (a P3 line) wakes it and SW1 answers as R1 does (PC1 logs in, PC2 is refused, telnet RST);
 *   • replay-exact with remote sessions: the journal (client lines only — the server side is a consequence) replays to
 *     byte-identical trace and snapshot JSON, entry by entry;
 *   • ruling R43: the vty connection entries carry `since`, so `show users` prints its "Connected for" column;
 *   • labs 15 and 19, live: `table vty-logins` (ssh success, refused) and `acl` (list 10 bound to the vty lines, the
 *     implicit entry matched) pass. (The `service` kind is W5's.)
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRuntimeDeps } from '../src/contracts/device.js';
import type { SimEvent } from '../src/contracts/events.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { REMOTE_DEPTH_CAP } from '../src/cli/grammar/remote.js';
import { SHOW_USERS_CONNECTED_FOR } from '../src/cli/handlers/remote.js';
import { MSG_REMOTE_DEPTH, REMOTE_SESSION_PREFIX } from '../src/cli/runtime.js';
import { VTY_PROMPT_PASSWORD, VTY_SSH_VERSION, vtySshCrypt, vtySshKey } from '../src/protocols/vty.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createReplay } from '../src/sim/replay.js';
import { P3_FLIP_FACTORIES } from './accept.p3.flip-factories.js';
import { createStagedSimulation } from './staged.world.js';

const R1 = '192.168.10.1';
const SW1 = '192.168.10.2';
const PC1 = '192.168.10.10';
const PC2 = '192.168.10.11';
const MASK = '255.255.255.0';
/** The lab values of §3.14 (a user secret and, for the telnet case, a line password). */
const ADMIN_PASSWORD = 'Lab-Pass1';
const LINE_PASSWORD = 'Vty-Pass';
const BOOT_NS: SimTime = 100 * SEC;

/** R1's §3.14 lines (config mode): SSH only, `login local`, access-class 10 (PC1 only). */
const SSH_ONLY: readonly string[] = [
  'ip domain-name lab.nf',
  'crypto key generate rsa modulus 1024',
  'ip ssh version 2',
  `username admin secret ${ADMIN_PASSWORD}`,
  `access-list 10 permit host ${PC1}`,
  'line vty 0 4',
  'login local',
  'transport input ssh',
  'access-class 10 in',
  'exit',
];

function hostConfig(name: string, address: string): string {
  return [`hostname ${name}`, '!', 'interface GigabitEthernet0', ` ip address ${address} ${MASK}`, '!', `ip default-gateway ${R1}`, '!', 'end', ''].join('\n');
}

/** Type `lines` on `device` through the grammar; every line must succeed. */
function typed(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? 'skipped'}`), `lines refused on ${device}`).toEqual([]);
}

/** The §3.14 world: PC1, PC2 and R1 on SW1, booted; R1 and SW1 then get `r1Lines` / `swLines` typed. */
function world(r1Lines: readonly string[], swLines: readonly string[] = [], seed = 314): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: P3_FLIP_FACTORIES, pduRegistryLimit: 200_000 });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: hostConfig('PC2', PC2) });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runFor(60 * SEC);
  typed(sim, 'r1', ['hostname R1', 'interface GigabitEthernet0/0', `ip address ${R1} ${MASK}`, 'no shutdown', 'exit', ...r1Lines]);
  typed(sim, 'sw1', ['hostname SW1', 'interface Vlan1', `ip address ${SW1} ${MASK}`, 'no shutdown', 'exit', ...swLines]);
  sim.runUntil(BOOT_NS);
  return sim;
}

type PromptEvent = Extract<TraceEvent, { kind: 'cliPrompt' }>;

/** One dispatched event, with the number of via-'vty' sessions before and after its dispatch. */
interface Step {
  readonly ev: SimEvent;
  readonly before: number;
  readonly after: number;
}

/** Dispatch every event up to `until` one at a time, then set the clock to `until`. */
function stepped(sim: Simulation, until: SimTime): Step[] {
  const out: Step[] = [];
  const vtySessions = (): number => sim.cli.sessions().filter((v) => v.via === 'vty').length;
  for (;;) {
    const t = sim.nextEventTime();
    if (t === undefined || t > until) break;
    const before = vtySessions();
    const ev = sim.step();
    if (ev === undefined) break;
    out.push({ ev, before, after: vtySessions() });
  }
  sim.runUntil(until);
  return out;
}

/** One line typed on a console session, and what followed it in the `runNs` after. */
interface Typed {
  readonly text: string[];
  readonly prompts: PromptEvent[];
  readonly events: TraceEvent[];
  readonly steps: Step[];
}

function type(sim: Simulation, s: SessionId, line: string, runNs: SimTime = 3 * SEC): Typed {
  const cursor = sim.trace(0).next;
  sim.cli.exec(s, line);
  const steps = stepped(sim, sim.now + runNs);
  const t = sim.trace(cursor);
  expect(t.dropped).toBe(0);
  return {
    text: t.events.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : [])),
    prompts: t.events.filter((e): e is PromptEvent => e.kind === 'cliPrompt' && e.session === s),
    events: t.events,
    steps,
  };
}

const lastPrompt = (t: Typed): PromptEvent | undefined => t.prompts.at(-1);
const logins = (sim: Simulation, device: string): Omit<VtyLoginRow, 'key' | 'at' | 'updatedAt'>[] =>
  (sim.device(device)!.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => ({ seq: r.seq, proto: r.proto, peer: r.peer, user: r.user, result: r.result, reason: r.reason }));
const aclRow = (sim: Simulation, key: string): AclRow => sim.device('r1')!.tables.get<AclRow>('acl')!.get(key)!;

/** Every step that changed the via-'vty' session count. */
const sessionChanges = (steps: readonly Step[]): Step[] => steps.filter((s) => s.after !== s.before);

/** The TCP segments `device` created among `events` (as PDUs). */
function segments(sim: Simulation, events: readonly TraceEvent[], device: string): PduView[] {
  return events.flatMap((e) => {
    if (e.kind !== 'pduCreated' || e.device !== device || e.process !== 'tcp') return [];
    const p = sim.pdu(e.pdu.id);
    return p !== undefined && p.layer('tcp') !== undefined ? [p] : [];
  });
}
const flags = (p: PduView): string => String(p.layer('tcp')?.fields['flags'] ?? '');
const carriesData = (p: PduView): boolean => p.layers.some((l) => l.proto === 'ssh' || l.proto === 'telnet');
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** What `line` prints on a fresh console of `device` (privileged when `enable`), opened and closed here. */
function consoleOutput(sim: Simulation, device: string, line: string, enable = true): string {
  const c = sim.cli.open(device, 'console');
  if (enable) sim.cli.exec(c, 'enable');
  const out = sim.cli.exec(c, line).output;
  sim.cli.close(c);
  return out;
}

// D14: remote sessions need no device-runtime dependency (no second path into the CLI runtime)
type RemoteDeps = Extract<keyof DeviceRuntimeDeps, `${string}emote${string}` | `${string}vty${string}` | `${string}Vty${string}` | `${string}cli${string}Remote${string}`>;
const NO_REMOTE_DEP: [RemoteDeps] extends [never] ? true : false = true;

describe('accept.p3.vty [S13]: §3.14 SSH-only access with a vty ACL', () => {
  it('telnet refused by the transport; PC2 refused by access-class after the handshake; PC1 logs in over SSH', () => {
    const sim = world(SSH_ONLY);
    const r1 = sim.device('r1')!;
    // step 1: a hidden listener on 22 only — no sockets row, not in the tcp StateView; list 10 bound to the vty lines
    expect(r1.processes.get('vty')!.stateSnapshot().state['listening']).toEqual(['ssh']);
    expect(r1.processes.get('tcp')!.stateSnapshot().state['listeners']).toEqual([]);
    expect(r1.tables.get('sockets')!.rows()).toEqual([]);
    expect((r1.tables.get<AclRow>('acl')?.rows() ?? []).map((r) => [r.key, r.applied, r.matches])).toEqual([
      ['4|10|10', 'vty in', 0],
      ['4|10|implicit', 'vty in', 0],
    ]);

    // step 2: PC1 telnet — the SYN finds no listener: a RST, "connection refused", no login row
    const pc1 = sim.cli.open('pc1', 'console');
    const telnet = type(sim, pc1, `telnet ${R1}`);
    expect(telnet.text).toEqual([`Connecting to ${R1} port 23 ...`, `% Connection refused by ${R1}`]);
    expect(lastPrompt(telnet)).toMatchObject({ prompt: 'PC1>', busy: false });
    expect(telnet.events.some((e) => e.kind === 'drop' && e.device === 'r1' && e.detail === 'tcp port 23 closed')).toBe(true);
    expect(segments(sim, telnet.events, 'r1').map(flags).some((f) => f.includes('R'))).toBe(true);
    expect(logins(sim, 'r1')).toEqual([]);

    // step 3: PC2 ssh — the password is asked locally first, then the connection; refused after the handshake
    const pc2 = sim.cli.open('pc2', 'console');
    const ask = type(sim, pc2, `ssh -l admin ${R1}`, 1 * SEC);
    expect(lastPrompt(ask)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, busy: false, input: { kind: 'secret', prompt: VTY_PROMPT_PASSWORD } });
    expect(ask.events.some((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.process === 'tcp')).toBe(false);
    const refused = type(sim, pc2, ADMIN_PASSWORD);
    expect(refused.text).toEqual([`Connecting to ${R1} port 22 ...`, `% Connection refused by ${R1}`]);
    expect(lastPrompt(refused)).toMatchObject({ prompt: 'PC2>', busy: false });
    const r1Flags = segments(sim, refused.events, 'r1').map(flags);
    const synAck = r1Flags.findIndex((f) => f === 'SA');
    const reset = r1Flags.findIndex((f) => f.includes('R'));
    expect(synAck).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(synAck);
    expect(segments(sim, refused.events, 'r1').filter(carriesData).map((p) => p.layer('ssh')?.fields['version'])).toEqual([VTY_SSH_VERSION]);
    expect(aclRow(sim, '4|10|implicit')).toMatchObject({ matches: 1, lastIface: 'vty', lastDir: 'in', applied: 'vty in' });
    expect(aclRow(sim, '4|10|10').matches).toBe(0);
    const logs = refused.events.filter((e): e is Extract<TraceEvent, { kind: 'log' }> => e.kind === 'log' && e.device === 'r1' && e.facility === 'VTY');
    expect(logs.map((l) => [l.severity, l.message])).toEqual([[5, `Remote SSH login for user admin from ${PC2} refused by access-class 10`]]);
    expect(logins(sim, 'r1')).toEqual([{ seq: 1, proto: 'ssh', peer: PC2, user: 'admin', result: 'refused', reason: 'access-class 10' }]);
    expect(sessionChanges([...ask.steps, ...refused.steps])).toEqual([]);

    // step 4: PC1 ssh — permitted (row 10 counted), logged in at user EXEC, the chip and the prompt
    type(sim, pc1, `ssh -l admin ${R1}`, 1 * SEC);
    const login = type(sim, pc1, ADMIN_PASSWORD);
    expect(login.text).toEqual([`Connecting to ${R1} port 22 ...`]);
    expect(lastPrompt(login)).toMatchObject({ prompt: 'R1>', busy: false });
    expect(lastPrompt(login)?.input).toBeUndefined();
    expect(sim.cli.session(pc1)).toMatchObject({ prompt: 'R1>', remote: 'R1 via SSH', busy: false });
    expect(aclRow(sim, '4|10|10')).toMatchObject({ matches: 1, lastIface: 'vty', lastDir: 'in' });
    expect(logins(sim, 'r1').at(-1)).toEqual({ seq: 2, proto: 'ssh', peer: PC1, user: 'admin', result: 'success', reason: undefined });
    const remote = sim.cli.sessions().filter((v) => v.via === 'vty');
    expect(remote.map((v) => [v.device, v.id, v.mode])).toEqual([['r1', `${REMOTE_SESSION_PREFIX}1`, 'user-exec']]);
    // the session opened in the dispatch of the vty daemon's remoteCli {op: 'open'} event, and nowhere else
    expect(sessionChanges(login.steps).map((s) => [s.ev.kind, s.before, s.after])).toEqual([['remoteCli', 0, 1]]);
    expect(sessionChanges(login.steps)[0]!.ev).toMatchObject({ kind: 'remoteCli', device: 'r1', from: 'vty', act: { type: 'remoteCli', op: 'open', peer: PC1, proto: 'ssh', user: 'admin' } });
    // the client's chip and prompt came through the vty-client's cliRemote, applied in a remoteCli event on PC1
    expect(login.steps.some((s) => s.ev.kind === 'remoteCli' && s.ev.device === 'pc1' && s.ev.from === 'vty-client' && s.ev.act.type === 'cliRemote' && s.ev.act.remote === 'R1 via SSH')).toBe(true);
    expect(NO_REMOTE_DEP).toBe(true);

    // step 5: a line typed on PC1 runs on R1 (a remoteCli {op: 'line'}); R43's "Connected for" column
    const users = type(sim, pc1, 'show users');
    expect(users.steps.filter((s) => s.ev.kind === 'remoteCli' && s.ev.device === 'r1').map((s) => s.ev.kind === 'remoteCli' && s.ev.act.type === 'remoteCli' && s.ev.act.op === 'line' && s.ev.act.text)).toEqual(['show users']);
    // connected since R1 accepted the TCP connection, a little after the password line typed 3 s before `show users`
    const since = (r1.processes.get('vty')!.stateSnapshot().state['connections'] as { since: SimTime }[])[0]!.since;
    expect(since).toBeGreaterThanOrEqual(login.steps[0]!.ev.at);
    expect(since).toBeLessThan(sessionChanges(login.steps)[0]!.ev.at);
    expect(users.text).toEqual([
      [`   Line   User   Protocol  From           State         ${SHOW_USERS_CONNECTED_FOR}`, `*  vty 0  admin  ssh       ${PC1}  session open  00:00:02`].join('\n'),
    ]);
    expect(users.events.filter((e) => e.kind === 'cliOutput' && e.session !== pc1)).toEqual([]);
    sim.runFor(7 * SEC);
    expect(consoleOutput(sim, 'r1', 'show users').split('\n')).toEqual([
      `   Line   User   Protocol  From           State         ${SHOW_USERS_CONNECTED_FOR}`,
      '*  con 0  -      console   -              session open  -',
      `   vty 0  admin  ssh       ${PC1}  session open  00:00:12`,
    ]);

    // labs 15 and 19, graded live from the tables and the configuration
    const lab: ScenarioInfo = {
      name: 'accept-vty',
      title: 'Secure access',
      description: 'Graded by the acceptance row',
      category: 'ccna3-lab',
      build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
      tasks: [
        {
          id: 'logins',
          title: 'Logins',
          description: 'SSH logins and refusals',
          points: 10,
          assertions: [
            { kind: 'table', device: 'R1', table: 'vty-logins', where: { proto: 'ssh', result: 'success' }, exists: true },
            { kind: 'table', device: 'R1', table: 'vty-logins', where: { result: 'refused' }, exists: true },
            { kind: 'acl', device: 'R1', list: '10', applied: [{ vty: true, dir: 'in' }], entry: 'implicit', minMatches: 1 },
          ] satisfies LabAssertion[],
        },
      ],
    };
    expect(evaluateLab(sim, lab).results[0]!.assertions).toEqual([
      { index: 0, pass: true },
      { index: 1, pass: true },
      { index: 2, pass: true },
    ]);

    // exit: the remote session ends in the dispatch of the remoteCli {op: 'line', text: 'exit'} event
    const bye = type(sim, pc1, 'exit');
    expect(bye.text).toEqual([`% Connection to ${R1} closed by the remote device.`]);
    expect(lastPrompt(bye)).toMatchObject({ prompt: 'PC1>', busy: false });
    expect(sim.cli.session(pc1)?.remote).toBeUndefined();
    expect(sessionChanges(bye.steps).map((s) => [s.ev.kind, s.before, s.after])).toEqual([['remoteCli', 1, 0]]);
    expect(sessionChanges(bye.steps)[0]!.ev).toMatchObject({ device: 'r1', from: 'vty', act: { op: 'line', text: 'exit' } });
    expect(r1.processes.get('vty')!.stateSnapshot().state['connections']).toEqual([]);
    expect(consoleOutput(sim, 'r1', 'show users').split('\n').at(-1)).toBe('No remote session is open.');
  });

  it('telnet with a line password carries it in clear, one character per segment; SSH bytes never carry it', () => {
    // §3.14 step 6: the same lines with `transport input telnet ssh` and a line password (vty lines log in by default)
    const sim = world([
      'ip domain-name lab.nf',
      'crypto key generate rsa modulus 1024',
      'line vty 0 4',
      `password ${LINE_PASSWORD}`,
      'login',
      'transport input telnet ssh',
      'exit',
    ]);
    expect(sim.device('r1')!.processes.get('vty')!.stateSnapshot().state['listening']).toEqual(['telnet', 'ssh']);
    const pc1 = sim.cli.open('pc1', 'console');
    const open = type(sim, pc1, `telnet ${R1}`);
    expect(open.text).toEqual([`Connecting to ${R1} port 23 ...`, `Connected to ${R1}.`]);
    expect(lastPrompt(open)).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, busy: false, input: { kind: 'secret' } });
    const telnet = type(sim, pc1, LINE_PASSWORD, 5 * SEC);
    expect(lastPrompt(telnet)).toMatchObject({ prompt: 'R1>', busy: false });
    expect(sim.cli.session(pc1)?.remote).toBe('R1 via Telnet');
    // "telnet sends the password in the clear": one character per segment, then the line end, nothing protected
    const typedBytes = segments(sim, telnet.events, 'pc1').filter(carriesData);
    expect(typedBytes.map((p) => p.layer('telnet')!.fields['data'])).toEqual([...LINE_PASSWORD.split(''), '\r\n']);
    for (const p of typedBytes) expect(p.meta.protected).toBeUndefined();
    expect(sessionChanges(telnet.steps).map((s) => s.ev.kind === 'remoteCli' && s.ev.act.type === 'remoteCli' && s.ev.act.op)).toEqual(['open']);
    type(sim, pc1, 'exit');

    // the same password over SSH (a line login): version strings in clear, then protected segments only
    type(sim, pc1, `ssh -l admin ${R1}`, 1 * SEC);
    const ssh = type(sim, pc1, LINE_PASSWORD);
    expect(lastPrompt(ssh)).toMatchObject({ prompt: 'R1>' });
    expect(sim.cli.session(pc1)?.remote).toBe('R1 via SSH');
    const segs = [...segments(sim, ssh.events, 'pc1'), ...segments(sim, ssh.events, 'r1')].filter(carriesData);
    const versions = segs.filter((p) => p.layer('ssh')?.fields['phase'] === 'version');
    expect(versions.map((p) => p.layer('ssh')!.fields['version'])).toEqual([VTY_SSH_VERSION, VTY_SSH_VERSION]);
    const sealed = segs.filter((p) => p.layer('ssh')?.fields['phase'] === 'protected');
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    for (const p of sealed) expect(p.meta).toMatchObject({ protected: true, protectedBy: 'ssh' });
    const needle = hexOf(new TextEncoder().encode(LINE_PASSWORD));
    for (const p of segs) expect(hexOf(p.bytes)).not.toContain(needle);
    // the protected bytes decode only with the keystream of the segment's endpoints (what the inspector does)
    const auth = segments(sim, ssh.events, 'pc1').filter((p) => p.layer('ssh')?.fields['phase'] === 'protected')[0]!;
    const ip = auth.layer('ipv4')!.fields;
    const key = vtySshKey(String(ip['src']), Number(auth.layer('tcp')!.fields['srcPort']), String(ip['dst']), Number(auth.layer('tcp')!.fields['dstPort']));
    expect(Buffer.from(vtySshCrypt(key, auth.layer('ssh')!.fields['payload'] as Uint8Array)).subarray(1).toString('utf8')).toBe(`admin\0${LINE_PASSWORD}`);
    expect(logins(sim, 'r1')).toEqual([
      { seq: 1, proto: 'telnet', peer: PC1, user: undefined, result: 'success', reason: undefined },
      { seq: 2, proto: 'ssh', peer: PC1, user: 'admin', result: 'success', reason: undefined },
    ]);
  });

  it(`nested sessions stop at depth ${REMOTE_DEPTH_CAP}`, () => {
    const sim = createStagedSimulation({ seed: 44, stage: 'P3', factories: P3_FLIP_FACTORIES });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', '192.168.10.100') });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    const routers = [1, 2, 3, 4, 5];
    for (const n of routers) {
      sim.addDevice({ id: `r${n}`, type: 'router.nf2911', name: `R${n}` });
      sim.addLink({ a: { device: `r${n}`, port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: `FastEthernet0/${n + 1}` } });
    }
    sim.runFor(60 * SEC);
    for (const n of routers) {
      typed(sim, `r${n}`, [`hostname R${n}`, 'interface GigabitEthernet0/0', `ip address 192.168.10.${n} ${MASK}`, 'no shutdown', 'exit', 'line vty 0 4', 'password nf', 'login', 'exit']);
    }
    sim.runUntil(BOOT_NS);
    const s = sim.cli.open('pc1', 'console');
    for (const n of [1, 2, 3, 4]) {
      expect(lastPrompt(type(sim, s, `telnet 192.168.10.${n}`, 5 * SEC))).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
      const t = type(sim, s, 'nf', 10 * SEC);
      expect(lastPrompt(t)).toMatchObject({ prompt: `R${n}>`, busy: false });
      expect(sessionChanges(t.steps).map((x) => [x.ev.kind, x.ev.kind === 'remoteCli' ? x.ev.device : '', x.after - x.before])).toEqual([['remoteCli', `r${n}`, 1]]);
    }
    expect(sim.cli.session(s)?.remote).toBe('R1 via Telnet');
    expect(sim.cli.sessions().filter((v) => v.via === 'vty').map((v) => v.device)).toEqual(['r1', 'r2', 'r3', 'r4']);
    // the fourth remote session may not open a fifth: nothing is sent to R5
    const deep = type(sim, s, 'telnet 192.168.10.5', 10 * SEC);
    expect(deep.text).toEqual([MSG_REMOTE_DEPTH]);
    expect(lastPrompt(deep)).toMatchObject({ prompt: 'R4>', busy: false });
    expect(deep.events.some((e) => e.kind === 'pduCreated' && e.process === 'tcp' && (e.pdu.flow ?? '').includes('192.168.10.5'))).toBe(false);
    expect(logins(sim, 'r5')).toEqual([]);
    // logging out of R4 returns to R3
    const back = type(sim, s, 'exit', 5 * SEC);
    expect(back.text).toEqual(['% Connection to 192.168.10.4 closed by the remote device.']);
    expect(lastPrompt(back)).toMatchObject({ prompt: 'R3>' });
    expect(sim.cli.sessions().filter((v) => v.via === 'vty').map((v) => v.device)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('accept.p3.vty [S13]: on a managed switch (D22)', () => {
  it('line vty with P1 lines leaves SW1 dormant; transport input ssh wakes it and SW1 answers as R1 does', () => {
    const P1_LINES = [`username admin secret ${ADMIN_PASSWORD}`, 'line vty 0 4', 'login local', 'exit'];
    const sim = world([], P1_LINES);
    const pc1 = sim.cli.open('pc1', 'console');
    const dormant = type(sim, pc1, `telnet ${SW1}`);
    expect(dormant.text).toEqual([`Connecting to ${SW1} port 23 ...`, `% Cannot reach ${SW1}: protocol unreachable.`]);
    expect(dormant.events.some((e) => e.kind === 'drop' && e.device === 'sw1' && e.reason === 'unsupported-protocol' && e.detail === 'ip protocol 6 has no listener')).toBe(true);
    expect(logins(sim, 'sw1')).toEqual([]);
    expect(sim.device('sw1')!.tables.get('sockets')!.rows()).toEqual([]);

    // §3.14 step 7: the same lines as R1's (a P3 transport line among them) wake the transport
    typed(sim, 'sw1', SSH_ONLY);
    sim.runFor(1 * SEC);
    type(sim, pc1, `ssh -l admin ${SW1}`, 1 * SEC);
    const login = type(sim, pc1, ADMIN_PASSWORD);
    expect(login.text).toEqual([`Connecting to ${SW1} port 22 ...`]);
    expect(lastPrompt(login)).toMatchObject({ prompt: 'SW1>', busy: false });
    expect(sim.cli.session(pc1)?.remote).toBe('SW1 via SSH');
    expect(sessionChanges(login.steps).map((s) => [s.ev.kind, s.ev.kind === 'remoteCli' ? s.ev.device : '', s.after - s.before])).toEqual([['remoteCli', 'sw1', 1]]);
    type(sim, pc1, 'exit');
    // PC2 is refused by access-class 10 (a list defined on the switch), after the handshake
    const pc2 = sim.cli.open('pc2', 'console');
    type(sim, pc2, `ssh -l admin ${SW1}`, 1 * SEC);
    const refused = type(sim, pc2, ADMIN_PASSWORD);
    expect(refused.text).toEqual([`Connecting to ${SW1} port 22 ...`, `% Connection refused by ${SW1}`]);
    // and telnet, which the transport excludes, is a RST with no row
    const telnet = type(sim, pc1, `telnet ${SW1}`);
    expect(telnet.text).toEqual([`Connecting to ${SW1} port 23 ...`, `% Connection refused by ${SW1}`]);
    expect(logins(sim, 'sw1')).toEqual([
      { seq: 1, proto: 'ssh', peer: PC1, user: 'admin', result: 'success', reason: undefined },
      { seq: 2, proto: 'ssh', peer: PC2, user: 'admin', result: 'refused', reason: 'access-class 10' },
    ]);
    expect(sim.device('sw1')!.tables.get<AclRow>('acl')!.get('4|10|implicit')).toMatchObject({ matches: 1, lastIface: 'vty' });
  });
});

describe('accept.p3.vty [S13]: replay-exact with remote sessions', () => {
  it('the journal replays to byte-identical trace and snapshot JSON, to the end and entry by entry', () => {
    const sim = createStagedSimulation({ seed: 315, stage: 'P3', factories: P3_FLIP_FACTORIES, traceCapacity: 1_000_000 });
    const afterEntry: string[] = [];
    const snap = (): string => JSON.stringify(sim.snapshot());
    /** One journaled input: exactly one journal entry, the snapshot right after it recorded. */
    const input = <T>(fn: () => T): T => {
      const before = sim.journal().entries.length;
      const out = fn();
      expect(sim.journal().entries.length).toBe(before + 1);
      afterEntry.push(snap());
      return out;
    };
    input(() => sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' }));
    input(() => sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' }));
    input(() => sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1) }));
    input(() => sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: hostConfig('PC2', PC2) }));
    input(() => sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } }));
    input(() => sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } }));
    input(() => sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } }));
    sim.runFor(60 * SEC);
    input(() => sim.configure('r1', ['hostname R1', 'interface GigabitEthernet0/0', `ip address ${R1} ${MASK}`, 'no shutdown', 'exit', ...SSH_ONLY]));
    sim.runUntil(BOOT_NS);
    const pc2 = input(() => sim.cli.open('pc2', 'console'));
    input(() => sim.cli.exec(pc2, `ssh -l admin ${R1}`));
    sim.runFor(1 * SEC);
    input(() => sim.cli.exec(pc2, ADMIN_PASSWORD));
    sim.runFor(3 * SEC);
    const pc1 = input(() => sim.cli.open('pc1', 'console'));
    input(() => sim.cli.exec(pc1, `ssh -l admin ${R1}`));
    sim.runFor(1 * SEC);
    input(() => sim.cli.exec(pc1, ADMIN_PASSWORD));
    sim.runFor(3 * SEC);
    expect(sim.cli.session(pc1)?.remote).toBe('R1 via SSH');
    input(() => sim.cli.exec(pc1, 'show running-config | include hostname'));
    sim.runFor(2 * SEC);
    input(() => sim.cli.exec(pc1, 'show users'));
    sim.runFor(2 * SEC);
    input(() => sim.cli.exec(pc1, 'exit'));
    sim.runToIdle();
    sim.runFor(30 * SEC);

    const journal = sim.journal();
    const end = sim.position();
    // the server side is never journaled: no entry opens or types on R1, and two remote sessions were numbered
    expect(journal.entries.filter((e) => JSON.stringify(e.op).includes('"r1"') && e.op.op !== 'addDevice' && e.op.op !== 'configure' && e.op.op !== 'addLink')).toEqual([]);
    expect(sim.trace(0).events.some((e) => e.kind === 'cliOutput' && e.session.startsWith(REMOTE_SESSION_PREFIX))).toBe(false);
    expect(logins(sim, 'r1').map((r) => r.result)).toEqual(['refused', 'success']);

    // one replay straight to position(): byte-identical trace JSON from the origin's head, and snapshot JSON
    const whole = createReplay(journal, { catalog: sim.catalog, traceCapacity: 1_000_000 });
    expect(whole.advance(end).reached).toBe(true);
    expect(whole.position()).toEqual(end);
    const head = journal.origin.counters.traceHead;
    expect(JSON.stringify(whole.sim.trace(head).events)).toBe(JSON.stringify(sim.trace(head).events));
    expect(JSON.stringify(whole.sim.snapshot())).toBe(snap());
    expect(logins(whole.sim, 'r1')).toEqual(logins(sim, 'r1'));
    // every entry, in chunks: the replayed snapshot equals the live one recorded right after that entry
    const perEntry = createReplay(journal, { catalog: sim.catalog });
    for (let i = 0; i < journal.entries.length; i++) {
      let guard = 0;
      while (!perEntry.advanceToEntry(i, { maxEvents: 97 }).reached) if (++guard > 1_000_000) throw new Error('never reached the entry');
      expect(JSON.stringify(perEntry.sim.snapshot()), `after entry ${i} (${journal.entries[i]!.op.op})`).toBe(afterEntry[i]);
    }
    expect(perEntry.advance(end).reached).toBe(true);
    expect(JSON.stringify(perEntry.sim.snapshot())).toBe(snap());
    expect(whole.sim.journal().entries).toEqual([]);
  });
});
