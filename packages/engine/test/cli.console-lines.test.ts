/**
 * cli.console-lines — ruling R63 (ARCHITECTURE-P3 §9.2, W8 decisions, "R63. Gate G finding: console lines that run
 * together"; §9.2 W8 item 47h): a line a P3 producer prints never runs into the next output, and the far end of a remote
 * session is printed exactly as it was sent, with no line and no blank line added.
 *
 * The web terminal writes a busy session's `cliOutput` exactly as it arrives (a ping's `!` marks share a line), and
 * adds a missing line end only at the prompt. `renderTerminal` replays one console session's `cliOutput` / `cliPrompt`
 * trace events the same way, as text, so a transcript here is what the learner sees. It mirrors `ConsoleController` of
 * apps/web/src/terminal/TerminalTab.tsx — `boot`, `handleKey` ('submit'), `runLine`, `awaitDelimiter`, `drainNow`,
 * `printAboveLine`, `newPrompt`, `restorePrompt`, `ensureNewline`, `writeText` / `emit`, `applyInput`, `promptText`,
 * `jobLabel`, `relaying` and `onKey`'s busy ^C — with `busyStatusLine` and `relaysRemote` (remote-session.ts) and
 * `jobStatusLine`, `submitLine`, `redrawAll` and `eraseForOutput` (line-editor.ts) reduced to their text: a line end is
 * `\n`, an erased prompt row is cut off, a masked answer echoes nothing.
 *
 * Pinned exactly, in lab `ccna3-secure-device-access` (lab 19, a P3 world: console logging on, `service timestamps
 * debug datetime msec` stored), each case on its own world (unsolved, or with the reference solution):
 *   • the gate G transcripts: SW1's `interface range FastEthernet0/3 - 24` + `shutdown` (each `%LINK-3` line on its
 *     own line, then the prompt; `CliRuntime.onLogEvent`), PC2's `ssh` refused by `access-class 10`, PC1's `ssh` that
 *     logs in (`R1>` on the line right after `Connecting …`, no blank line) and its `exit` (the vty client's lines);
 *   • a telnet login (the `Connected to …` line), a remote ping over telnet (its marks on one line, nothing added
 *     although TCP coalesced them) and a remote `show running-config` longer than one segment (exactly R1's own text):
 *     the relay's framing, protocols/vty.ts `vtyTermOutput` and `createVtyTermReader`;
 *   • `terminal monitor`: log lines coalesced into one telnet segment, one per line with no blank line; a refused
 *     login's log on an SSH session at its prompt, and a nested telnet's lines through the relay;
 *   • the further producers: the [S24] stamped debug lines of a ping on R1's console (`onDebugEvent`; a debug line can
 *     still follow a `!` mark, R63 (d)), the SSH DISCONNECT reason after three wrong passwords, the server's own message
 *     after three wrong telnet passwords, and `^C` while an ssh connects.
 */
import { describe, expect, it } from 'vitest';
import type { CliInputRequest } from '../src/contracts/cli.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { VTY_CLIENT_PROCESS } from '../src/cli/grammar/remote.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  SECURE_ACCESS_ADDRESSES as A,
  SECURE_ACCESS_OLD_LINE_PASSWORD,
  SECURE_ACCESS_SECRET,
  SECURE_ACCESS_USER,
  ccna3SecureDeviceAccess,
} from '../src/sim/scenarios/ccna3/hardening.js';

/** Long enough for every model of the lab to boot (a router takes 45 s); `runToIdle` then settles the world. */
const BOOT_NS = 90 * SEC;
/** World time after each typed line (a login asks for the password, then connects). */
const LINE_NS = 3 * SEC;
/** Wall-clock budget of one case (a lab world, a solution and a few consoles). */
const CASE_TIMEOUT_MS = 120_000;
/** R1's enable secret in the telnet cases (the lab's R1 has none, and a vty asks for one). */
const ENABLE_SECRET = 'Lab-Enable63';

type SessionEvent = Extract<TraceEvent, { kind: 'cliOutput' } | { kind: 'cliPrompt' }>;

/** remote-session.ts `REMOTE_CLIENT_PROCESS` is the engine's `VTY_CLIENT_PROCESS`. */
const REMOTE_CLIENT_PROCESS = VTY_CLIENT_PROCESS;

/** line-editor.ts `jobStatusLine`. */
function jobStatusLine(label: string): string {
  const name = label.trim() === '' ? 'The command' : label.trim();
  return `${name} is running — press Ctrl+C to stop it.`;
}

/** A console on `device` as the web terminal draws it (the module header names what it mirrors). */
interface RenderedTerminal {
  readonly session: SessionId;
  /** Type `line` and press Enter, then let the world run `runNs`. */
  type(line: string, runNs?: SimTime): void;
  /** ^C while a job or a relayed line holds the console (`onKey`: `cliInterrupt` at once), then run `runNs`. */
  interrupt(runNs?: SimTime): void;
  /** Render what arrived meanwhile (`scheduleDrain` → `drainNow`). */
  drain(): void;
  /** The screen, one entry per row; the last is the row the cursor is on. */
  lines(): string[];
}

function renderTerminal(sim: Simulation, device: DeviceId): RenderedTerminal {
  let cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const hostname = sim.device(device)?.hostname ?? device;
  let screen = '';
  let atLineStart = true;
  let lineVisible = false;
  let state: 'idle' | 'busy' | 'closed' = 'idle';
  let prompt = '';
  let input: CliInputRequest | undefined;
  const pending: SessionEvent[] = [];

  /** `SessionCursor.take`: this session's events since the last take. */
  const take = (): SessionEvent[] => {
    const t = sim.trace(cursor);
    cursor = t.next;
    return t.events.filter((e): e is SessionEvent => (e.kind === 'cliOutput' || e.kind === 'cliPrompt') && e.session === session);
  };
  const emit = (data: string): void => {
    if (data === '') return;
    screen += data;
    atLineStart = data.endsWith('\n');
  };
  const writeText = (text: string): void => emit(text);
  const applyInput = (next: CliInputRequest | undefined): void => {
    input = next === undefined ? undefined : { ...next };
  };
  const promptText = (): string => (input === undefined ? prompt : input.prompt);
  const ensureNewline = (): void => {
    if (lineVisible) {
      lineVisible = false;
      atLineStart = false;
    }
    if (!atLineStart) emit('\n');
  };
  const newPrompt = (): void => {
    ensureNewline();
    emit(promptText());
    lineVisible = true;
  };
  const restorePrompt = newPrompt;
  const printAboveLine = (text: string): void => {
    if (lineVisible) {
      // eraseForOutput: the prompt row is cleared and the output written in its place
      screen = screen.slice(0, screen.lastIndexOf('\n') + 1);
      atLineStart = true;
      lineVisible = false;
      writeText(text);
      restorePrompt();
    } else writeText(text);
  };
  const view = () => sim.cli.session(session);
  const relaying = (): boolean => {
    const v = view();
    return v !== undefined && (v.remote !== undefined || v.job?.process === REMOTE_CLIENT_PROCESS);
  };
  const jobLabel = (): string => view()?.job?.label ?? '';

  const drainNow = (): void => {
    pending.push(...take());
    let idleText = '';
    const flushIdleText = (): void => {
      if (idleText !== '') {
        printAboveLine(idleText);
        idleText = '';
      }
    };
    while (pending.length > 0) {
      const ev = pending.shift()!;
      if (state === 'closed') continue;
      if (state === 'busy') {
        if (ev.kind === 'cliOutput') writeText(ev.text);
        else {
          if (ev.prompt !== '') prompt = ev.prompt;
          applyInput(ev.input);
          if (!ev.busy) {
            state = 'idle';
            newPrompt();
          }
        }
        continue;
      }
      if (ev.kind === 'cliOutput') {
        idleText += ev.text.endsWith('\n') ? ev.text : `${ev.text}\n`;
        continue;
      }
      flushIdleText();
      if (ev.prompt !== '') prompt = ev.prompt;
      applyInput(ev.input);
    }
    flushIdleText();
  };

  /** The events up to the `cliPrompt` that closes the exec, written in order; its busy flag (else `fallback`). */
  const awaitDelimiter = (fallback: boolean): boolean => {
    pending.push(...take());
    while (pending.length > 0) {
      const ev = pending.shift()!;
      if (ev.kind === 'cliOutput') {
        writeText(ev.text);
        continue;
      }
      if (ev.prompt !== '') prompt = ev.prompt;
      applyInput(ev.input);
      return ev.busy;
    }
    return fallback;
  };

  const runLine = (line: string): void => {
    if (line.trim() === '' && input === undefined) {
      newPrompt();
      return;
    }
    drainNow();
    const relayed = relaying();
    const result = sim.cli.exec(session, line);
    if (result.prompt !== '') prompt = result.prompt;
    applyInput(result.input);
    if (result.output !== '') writeText(result.output);
    if (result.closed) {
      state = 'closed';
      ensureNewline();
      writeText('Session closed.\n');
      return;
    }
    const busy = awaitDelimiter(result.busy);
    if (busy) {
      state = 'busy';
      const status = relayed ? undefined : jobStatusLine(jobLabel());
      if (status !== undefined) {
        ensureNewline();
        writeText(`${status}\n`);
      }
    } else newPrompt();
    drainNow();
  };

  // boot: the greeting, what the session printed before the terminal existed, then its prompt
  writeText(`Console connected to ${hostname}.\n`);
  for (const ev of take()) {
    if (ev.kind === 'cliOutput') writeText(ev.text);
    else {
      if (ev.prompt !== '') prompt = ev.prompt;
      applyInput(ev.input);
    }
  }
  const v = view();
  if (v !== undefined) {
    if (prompt === '') prompt = v.prompt;
    if (input === undefined) applyInput(v.input);
  }
  newPrompt();

  return {
    session,
    type(line, runNs = LINE_NS) {
      if (state !== 'idle') throw new Error(`typed "${line}" while the console is ${state}`);
      // the typed characters (none for a masked answer), then submitLine's line end
      emit(`${input?.kind === 'secret' ? '' : line}\n`);
      atLineStart = true;
      lineVisible = false;
      runLine(line);
      sim.runFor(runNs);
      drainNow();
    },
    interrupt(runNs = LINE_NS) {
      if (state !== 'busy') throw new Error('^C only interrupts a busy console here');
      sim.cli.interrupt(session);
      sim.runFor(runNs);
      drainNow();
    },
    drain() {
      drainNow();
    },
    lines() {
      return screen.split('\n');
    },
  };
}

// ── the lab world ─────────────────────────────────────────────────────────────

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** Device id of a topology name. */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Configure `name` through the configure seam; every line must be accepted. */
function configure(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`)).toEqual([]);
  sim.runToIdle();
}

/** Lab 19 solved: the reference solution as written. */
function solvedWorld(): Simulation {
  const sim = labWorld(ccna3SecureDeviceAccess);
  for (const [name, lines] of Object.entries(ccna3SecureDeviceAccess.solution ?? {})) configure(sim, name, lines);
  return sim;
}

/** The text the console of `name` prints for `line` (after `before`), on a session opened and closed here. */
function ownOutput(sim: Simulation, name: string, before: readonly string[], line: string): string {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const b of before) sim.cli.exec(s, b);
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out;
}

/** The TCP segments `device` sent among `events` whose telnet layer carries text, as that text. */
function telnetData(sim: Simulation, events: readonly TraceEvent[], device: DeviceId): string[] {
  return events.flatMap((e) => {
    if (e.kind !== 'pduCreated' || e.device !== device || e.process !== 'tcp') return [];
    const data = sim.pdu(e.pdu.id)?.layer('telnet')?.fields['data'];
    return typeof data === 'string' && data !== '' ? [data] : [];
  });
}

/** The `cliOutput` texts of `session` among `events`. */
const printed = (events: readonly TraceEvent[], session: SessionId): string[] =>
  events.flatMap((e) => (e.kind === 'cliOutput' && e.session === session ? [e.text] : []));

const CONNECTING_SSH = `Connecting to ${A.r1} port 22 ...`;
const CONNECTING_TELNET = `Connecting to ${A.r1} port 23 ...`;
const SSH_RUNNING = jobStatusLine('ssh');
const TELNET_RUNNING = jobStatusLine('telnet');

describe('cli.console-lines: the gate G transcripts of lab 19 (R63 (e))', () => {
  it('SW1: interface range FastEthernet0/3 - 24 then shutdown prints each %LINK-3 line on its own line, then the prompt', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    const sw1 = renderTerminal(sim, idOf(sim, 'SW1'));
    for (const line of ['enable', 'configure terminal', 'interface range FastEthernet0/3 - 24', 'shutdown', 'end']) sw1.type(line, 1 * SEC);
    const down = Array.from({ length: 22 }, (_, i) => `*Jan  1 00:01:03.000: %LINK-3: Interface FastEthernet0/${i + 3} administratively down`);
    expect(sw1.lines()).toEqual([
      'Console connected to SW1.',
      'SW1>enable',
      'SW1#configure terminal',
      'SW1(config)#interface range FastEthernet0/3 - 24',
      'SW1(config-if-range)#shutdown',
      ...down,
      'SW1(config-if-range)#end',
      '*Jan  1 00:01:04.000: %SYS-5-CONFIGURED: Configuration changed from the console.',
      'SW1#',
    ]);
  }, CASE_TIMEOUT_MS);

  it('PC2: an ssh refused by access-class 10 prints Connecting and the refusal on lines of their own, then PC2>', () => {
    const sim = solvedWorld();
    const pc2 = renderTerminal(sim, idOf(sim, 'PC2'));
    pc2.type(`ssh -l ${SECURE_ACCESS_USER} ${A.r1}`);
    pc2.type(SECURE_ACCESS_SECRET);
    expect(pc2.lines()).toEqual([
      'Console connected to PC2.',
      `PC2>ssh -l ${SECURE_ACCESS_USER} ${A.r1}`,
      SSH_RUNNING,
      'Password: ',
      CONNECTING_SSH,
      `% Connection refused by ${A.r1}`,
      'PC2>',
    ]);
  }, CASE_TIMEOUT_MS);

  it('PC1: an ssh that logs in shows R1> on the line right after Connecting (no blank line), and exit returns', () => {
    const sim = solvedWorld();
    const pc1 = renderTerminal(sim, idOf(sim, 'PC1'));
    pc1.type(`ssh -l ${SECURE_ACCESS_USER} ${A.r1}`);
    pc1.type(SECURE_ACCESS_SECRET);
    pc1.type('exit');
    expect(pc1.lines()).toEqual([
      'Console connected to PC1.',
      `PC1>ssh -l ${SECURE_ACCESS_USER} ${A.r1}`,
      SSH_RUNNING,
      'Password: ',
      CONNECTING_SSH,
      'R1>exit',
      `% Connection to ${A.r1} closed by the remote device.`,
      'PC1>',
    ]);
  }, CASE_TIMEOUT_MS);
});

describe('cli.console-lines: telnet and the relay (R63 (a), (b))', () => {
  it('a telnet login prints Connected on its own line; a remote ping and a remote show running-config arrive exactly as sent', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    // R1 asks a vty session for an enable secret; 120 list lines make its configuration longer than one segment
    configure(sim, 'R1', [`enable secret ${ENABLE_SECRET}`, ...Array.from({ length: 120 }, (_, i) => `access-list 20 permit 10.0.0.${i}`)]);
    const r1 = idOf(sim, 'R1');
    const pc2 = renderTerminal(sim, idOf(sim, 'PC2'));
    pc2.type(`telnet ${A.r1}`);
    pc2.type(SECURE_ACCESS_OLD_LINE_PASSWORD);
    const beforePing = sim.trace(0).next;
    pc2.type('ping 192.168.10.10', 10 * SEC);
    // not vacuous: TCP put several of the far end's marks in one segment
    expect(telnetData(sim, sim.trace(beforePing).events, r1).some((d) => d.includes('!!'))).toBe(true);
    pc2.type('enable');
    pc2.type(ENABLE_SECRET);
    const beforeShow = sim.trace(0).next;
    pc2.type('show running-config');
    const own = ownOutput(sim, 'R1', ['enable', ENABLE_SECRET], 'show running-config');
    // exactly R1's own text, although it crossed several segments and one of them ended in the middle of a line
    expect(own.endsWith('\nend\n')).toBe(true);
    const relayed = printed(sim.trace(beforeShow).events, pc2.session);
    expect(relayed.length).toBeGreaterThan(1);
    expect(relayed.join('')).toBe(own);
    expect(telnetData(sim, sim.trace(beforeShow).events, r1).slice(0, -1).some((d) => !d.endsWith('\n'))).toBe(true);
    pc2.type('exit');
    expect(pc2.lines()).toEqual([
      'Console connected to PC2.',
      `PC2>telnet ${A.r1}`,
      CONNECTING_TELNET,
      TELNET_RUNNING,
      `Connected to ${A.r1}.`,
      'Password: ',
      'R1>ping 192.168.10.10',
      'Sending 5 echo requests to 192.168.10.10, 100-byte datagrams, timeout 2 s:',
      '!!!!!',
      'Sent 5, received 5, lost 0 (0% loss), round-trip min/avg/max = 0.02/0.03/0.04 ms',
      'R1>enable',
      'Password: ',
      'R1#show running-config',
      // its own last line end, then the prompt: no blank line
      ...own.slice(0, -1).split('\n'),
      'R1#exit',
      `% Connection to ${A.r1} closed by the remote device.`,
      'PC2>',
    ]);
  }, CASE_TIMEOUT_MS);

  it('terminal monitor over telnet: log lines TCP coalesced into one segment print one per line, with no blank line', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    configure(sim, 'R1', [`enable secret ${ENABLE_SECRET}`]);
    const pc2 = renderTerminal(sim, idOf(sim, 'PC2'));
    pc2.type(`telnet ${A.r1}`);
    pc2.type(SECURE_ACCESS_OLD_LINE_PASSWORD);
    pc2.type('enable');
    pc2.type(ENABLE_SECRET);
    pc2.type('terminal monitor');
    const from = sim.trace(0).next;
    // R1's console: three loopbacks pasted at once, so their three logs leave within one instant
    const r1 = renderTerminal(sim, idOf(sim, 'R1'));
    for (const line of ['enable', ENABLE_SECRET, 'configure terminal']) r1.type(line, 1 * SEC);
    r1.type('interface Loopback0', 0);
    r1.type('interface Loopback1', 0);
    r1.type('interface Loopback2', 1 * SEC);
    pc2.drain();
    const up = (n: number): string => `*Jan  1 00:01:03.000: %LINEPROTO-5-UPDOWN: Interface Loopback${n}: line protocol is up`;
    // not vacuous: one segment carried two of the log lines
    expect(telnetData(sim, sim.trace(from).events, idOf(sim, 'R1'))).toContain(`${up(1)}\r\n${up(2)}\r\n`);
    expect(pc2.lines()).toEqual([
      'Console connected to PC2.',
      `PC2>telnet ${A.r1}`,
      CONNECTING_TELNET,
      TELNET_RUNNING,
      `Connected to ${A.r1}.`,
      'Password: ',
      'R1>enable',
      'Password: ',
      'R1#terminal monitor',
      'Logs now print on this session too.',
      up(0),
      up(1),
      up(2),
      'R1#',
    ]);
    expect(r1.lines()).toEqual([
      'Console connected to R1.',
      'R1>enable',
      'Password: ',
      'R1#configure terminal',
      'R1(config)#interface Loopback0',
      up(0),
      'R1(config-if)#interface Loopback1',
      up(1),
      'R1(config-if)#interface Loopback2',
      up(2),
      'R1(config-if)#',
    ]);
  }, CASE_TIMEOUT_MS);

  it('terminal monitor over SSH: a refused login logs above the prompt; a nested telnet prints its lines through the relay', () => {
    const sim = solvedWorld();
    // a privilege-15 admin, so the session may turn terminal monitor on
    configure(sim, 'R1', [`username ${SECURE_ACCESS_USER} privilege 15 secret ${SECURE_ACCESS_SECRET}`]);
    const pc1 = renderTerminal(sim, idOf(sim, 'PC1'));
    pc1.type(`ssh -l ${SECURE_ACCESS_USER} ${A.r1}`);
    pc1.type(SECURE_ACCESS_SECRET);
    pc1.type('terminal monitor');
    const pc2 = renderTerminal(sim, idOf(sim, 'PC2'));
    pc2.type(`ssh -l ${SECURE_ACCESS_USER} ${A.r1}`);
    pc2.type(SECURE_ACCESS_SECRET);
    pc1.drain();
    // SW1's transport is dormant (D22): R1's own telnet client fails, and PC1 shows its two lines
    pc1.type(`telnet ${A.sw1}`, 5 * SEC);
    pc1.type('exit');
    expect(pc1.lines()).toEqual([
      'Console connected to PC1.',
      `PC1>ssh -l ${SECURE_ACCESS_USER} ${A.r1}`,
      SSH_RUNNING,
      'Password: ',
      CONNECTING_SSH,
      'R1#terminal monitor',
      'Logs now print on this session too.',
      `*Jan  1 00:00:57.200: %VTY-5: Remote SSH login for user ${SECURE_ACCESS_USER} from ${A.pc2} refused by access-class 10`,
      `R1#telnet ${A.sw1}`,
      `Connecting to ${A.sw1} port 23 ...`,
      `% Cannot reach ${A.sw1}: protocol unreachable.`,
      'R1#exit',
      `% Connection to ${A.r1} closed by the remote device.`,
      'PC1>',
    ]);
  }, CASE_TIMEOUT_MS);
});

describe('cli.console-lines: the further producers (R63 (a), (d))', () => {
  it('[S24] the stamped debug lines of a ping each end their line (one may still follow a mark, R63 (d))', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    const r1 = renderTerminal(sim, idOf(sim, 'R1'));
    for (const line of ['enable', 'debug ip icmp']) r1.type(line, 1 * SEC);
    r1.type('ping 192.168.10.10', 10 * SEC);
    const stamp = '*Jan  1 00:00:47.000: ip icmp:';
    const request = (seq: number): string => `${stamp} echo request 192.168.10.1 > 192.168.10.10 id=1 seq=${seq}`;
    const reply = (seq: number, rtt: string): string => `${stamp} echo reply from 192.168.10.10 id=1 seq=${seq} rtt ${rtt} ms`;
    expect(r1.lines()).toEqual([
      'Console connected to R1.',
      'R1>enable',
      'R1#debug ip icmp',
      'Debugging enabled for ip icmp.',
      'R1#ping 192.168.10.10',
      `${stamp} ping 192.168.10.10 started: 5 echoes, 100 bytes, timeout 2 s`,
      request(1),
      'Sending 5 echo requests to 192.168.10.10, 100-byte datagrams, timeout 2 s:',
      jobStatusLine('ping'),
      reply(1, '0.04'),
      `!${request(2)}`,
      reply(2, '0.02'),
      `!${request(3)}`,
      reply(3, '0.02'),
      `!${request(4)}`,
      reply(4, '0.02'),
      `!${request(5)}`,
      reply(5, '0.02'),
      `${stamp} ping 192.168.10.10 finished (complete): sent 5 received 5 lost 0`,
      '!',
      'Sent 5, received 5, lost 0 (0% loss), round-trip min/avg/max = 0.02/0.03/0.04 ms',
      'R1#',
    ]);
  }, CASE_TIMEOUT_MS);

  it('SSH: each wrong password is refused on a line of its own; after the third the DISCONNECT reason, then the close', () => {
    const sim = solvedWorld();
    const pc1 = renderTerminal(sim, idOf(sim, 'PC1'));
    pc1.type(`ssh -l ${SECURE_ACCESS_USER} ${A.r1}`);
    for (const wrong of ['wrong-1', 'wrong-2', 'wrong-3']) pc1.type(wrong);
    expect(pc1.lines()).toEqual([
      'Console connected to PC1.',
      `PC1>ssh -l ${SECURE_ACCESS_USER} ${A.r1}`,
      SSH_RUNNING,
      'Password: ',
      CONNECTING_SSH,
      '% Permission denied: wrong user name or password.',
      'Password: ',
      '% Permission denied: wrong user name or password.',
      'Password: ',
      '% Too many failed logins. The connection is closed.',
      `% Connection to ${A.r1} closed by the remote device.`,
      'PC1>',
    ]);
  }, CASE_TIMEOUT_MS);

  it("telnet: after three wrong passwords the server's own message, then the close, each on its own line", () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    const pc1 = renderTerminal(sim, idOf(sim, 'PC1'));
    pc1.type(`telnet ${A.r1}`);
    for (const wrong of ['wrong-1', 'wrong-2', 'wrong-3']) pc1.type(wrong, 5 * SEC);
    expect(pc1.lines()).toEqual([
      'Console connected to PC1.',
      `PC1>telnet ${A.r1}`,
      CONNECTING_TELNET,
      TELNET_RUNNING,
      `Connected to ${A.r1}.`,
      'Password: ',
      '% Login failed: unknown user name or wrong password.',
      'Password: ',
      '% Login failed: unknown user name or wrong password.',
      'Password: ',
      '% Access denied after three failed logins. The connection is closed.',
      `% Connection to ${A.r1} closed by the remote device.`,
      'PC1>',
    ]);
  }, CASE_TIMEOUT_MS);

  it('^C while an ssh connects: the closing line on its own line, then the prompt', () => {
    const sim = solvedWorld();
    const pc1 = renderTerminal(sim, idOf(sim, 'PC1'));
    pc1.type(`ssh -l ${SECURE_ACCESS_USER} 192.168.10.99`);
    pc1.type(SECURE_ACCESS_SECRET, 1 * SEC);
    pc1.interrupt();
    expect(pc1.lines()).toEqual([
      'Console connected to PC1.',
      `PC1>ssh -l ${SECURE_ACCESS_USER} 192.168.10.99`,
      SSH_RUNNING,
      'Password: ',
      'Connecting to 192.168.10.99 port 22 ...',
      '% Connection to 192.168.10.99 closed.',
      'PC1>',
    ]);
  }, CASE_TIMEOUT_MS);
});
