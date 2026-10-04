/**
 * sim.log-branch — [S25] the `log` branch of the Simulation's trace sink (ARCHITECTURE-P3 D20, §7 W3 sim, approved
 * items): every `log` TraceEvent reaches the CLI's `onLogEvent` exactly as `debug` reaches `onDebugEvent`, and the CLI
 * prints it on the device's consoles (in a P3 world, or after a typed `logging console`) and on its `terminal monitor`
 * sessions.
 *
 * The proof that P1/P2 typed transcripts are unchanged compares two identical worlds driven by the same typed lines:
 * one as built, one whose facade `cli` has its `onLogEvent` member removed — which is exactly the sink without the
 * branch (it calls `cli.onLogEvent?.(ev)`). Their whole traces are byte-identical in a P1 and a P2 world, although
 * both worlds log; in a P3 world they differ by exactly the printed log lines, one per console or monitor session.
 */
import { describe, expect, it } from 'vitest';
import { renderLogLine, storedTimestampFormat } from '../src/cli/log-render.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createStagedSimulation } from './staged.world.js';

type Log = Extract<TraceEvent, { kind: 'log' }>;
type Out = Extract<TraceEvent, { kind: 'cliOutput' }>;

const GI0 = 'GigabitEthernet0/0';
const SEED = 23;

/** R1 (NF-2911) Gi0/0 cabled to PC1, booted; a P1 world from the plain facade, P2/P3 from staged.world. */
function world(profile: DefaultsProfile, branch: boolean): Simulation {
  const sim = profile === 'P1' ? createSimulation({ seed: SEED }) : createStagedSimulation({ seed: SEED, stage: profile === 'P2' ? 'P2' : 'P3' });
  // the sink without the branch: it calls `cli.onLogEvent?.(ev)`, so removing the member removes the branch
  if (!branch) delete (sim.cli as { onLogEvent?: unknown }).onLogEvent;
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: ['hostname R1', '!', `interface ${GI0}`, ' no shutdown', '!', 'end', ''].join('\n') });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  return sim;
}

/** Type `lines` on `session`, one after another, letting the world run a second after each. */
function type(sim: Simulation, session: string, lines: readonly string[]): void {
  for (const line of lines) {
    sim.cli.exec(session, line);
    sim.runFor(1 * SEC);
  }
}

/** A console session typing a shutdown and a no shutdown of Gi0/0 (both log), then waiting for the port to come up. */
function transcript(sim: Simulation): { console: string } {
  const con = sim.cli.open('r1', 'console');
  type(sim, con, ['enable', 'configure terminal', `interface ${GI0}`, 'shutdown', 'no shutdown', 'end']);
  sim.runFor(10 * SEC);
  return { console: con };
}

const logsOf = (evs: readonly TraceEvent[]): Log[] => evs.filter((e): e is Log => e.kind === 'log');
const outputsOf = (evs: readonly TraceEvent[], session: string): Out[] => evs.filter((e): e is Out => e.kind === 'cliOutput' && e.session === session);
/** A printed log line: the renderer's `<stamp>: %FAC-SEV…: text` form. */
const isLogLine = (text: string): boolean => /^\*?[^%]*: %[A-Z0-9_]+-[0-7]/.test(text);

describe('sim.log-branch: P1 and P2 typed transcripts are unchanged', () => {
  for (const profile of ['P1', 'P2'] as const) {
    it(`a ${profile} world: the whole trace equals the trace without the branch, and no log line is printed`, () => {
      const a = world(profile, true);
      const b = world(profile, false);
      const sa = transcript(a);
      const sb = transcript(b);
      const ta = a.trace(0).events;
      const tb = b.trace(0).events;
      // not vacuous: the world logged while the console was open (the P1 admin-state log of the shutdown)
      const cursorOpen = ta.findIndex((e) => e.kind === 'cliPrompt' && e.session === sa.console);
      expect(logsOf(ta.slice(cursorOpen)).length).toBeGreaterThan(0);
      expect(logsOf(ta.slice(cursorOpen)).some((l) => l.facility === 'LINK' && l.message.includes('administratively down'))).toBe(true);
      expect(JSON.stringify(ta)).toBe(JSON.stringify(tb));
      expect(sa).toEqual(sb);
      expect(outputsOf(ta, sa.console).some((o) => isLogLine(o.text))).toBe(false);
    });
  }

  it('a typed `logging console` prints in a P2 world too (the CLI gates by profile, not the branch)', () => {
    const sim = world('P2', true);
    const con = sim.cli.open('r1', 'console');
    type(sim, con, ['enable', 'configure terminal', 'logging console', `interface ${GI0}`]);
    const cursor = sim.trace(0).next;
    type(sim, con, ['shutdown']);
    const evs = sim.trace(cursor).events;
    const admin = logsOf(evs).filter((l) => l.facility === 'LINK');
    expect(admin).toHaveLength(1);
    const printed = outputsOf(evs, con).filter((o) => isLogLine(o.text));
    expect(printed.map((o) => o.t)).toEqual([admin[0]!.t]);
    expect(printed[0]!.text).toContain(admin[0]!.message);
  });
});

describe('sim.log-branch: a P3 world prints logs on consoles and terminal-monitor sessions', () => {
  it('the trace with the branch is the trace without it plus one printed line per console log', () => {
    const a = world('P3', true);
    const b = world('P3', false);
    const sa = transcript(a);
    transcript(b);
    const ta = a.trace(0).events;
    const tb = b.trace(0).events;
    const printed = outputsOf(ta, sa.console).filter((o) => isLogLine(o.text));
    expect(printed.length).toBeGreaterThan(0);
    // removing exactly the printed lines gives the trace without the branch, byte for byte
    expect(JSON.stringify(ta.filter((e) => !(e.kind === 'cliOutput' && isLogLine(e.text))))).toBe(JSON.stringify(tb));
    // each printed line follows its log in the same instant and carries its text
    const open = ta.findIndex((e) => e.kind === 'cliPrompt' && e.session === sa.console);
    const logs = logsOf(ta.slice(open)).filter((l) => l.device === 'r1');
    expect(printed.map((o) => o.t)).toEqual(logs.map((l) => l.t));
    // each is the CLI's rendering of its log (the logger's renderer, the device clock then, `service timestamps log`)
    const r1 = a.device('r1')!;
    const fmt = storedTimestampFormat(r1.running.root, 'log');
    expect(printed.map((o) => o.text)).toEqual(logs.map((l) => renderLogLine(l, r1.clockView(l.t), r1.uptime(l.t), fmt)));
    printed.forEach((o, i) => expect(o.text).toContain(logs[i]!.message));
    for (const o of printed) {
      const at = ta.indexOf(o);
      expect(ta[at - 1]?.kind).toBe('log');
    }
    expect(logs.some((l) => l.facility === 'LINK' && l.message.includes('administratively down'))).toBe(true);
  });

  it('a terminal-monitor session prints the same line; a vty session without it prints nothing', () => {
    const sim = world('P3', true);
    const con = sim.cli.open('r1', 'console');
    const mon = sim.cli.open('r1', 'vty');
    const quiet = sim.cli.open('r1', 'vty');
    type(sim, mon, ['enable', 'terminal monitor']);
    expect(sim.cli.session(mon)?.monitor).toBe(true);
    type(sim, con, ['enable', 'configure terminal', `interface ${GI0}`]);
    const cursor = sim.trace(0).next;
    type(sim, con, ['shutdown']);
    const evs = sim.trace(cursor).events;
    const admin = logsOf(evs).filter((l) => l.device === 'r1' && l.facility === 'LINK');
    expect(admin).toHaveLength(1);
    const onCon = outputsOf(evs, con).filter((o) => isLogLine(o.text) && o.text.includes(admin[0]!.message));
    const onMon = outputsOf(evs, mon).filter((o) => isLogLine(o.text) && o.text.includes(admin[0]!.message));
    expect(onCon).toHaveLength(1);
    expect(onMon).toHaveLength(1);
    expect(onMon[0]!.text).toBe(onCon[0]!.text);
    expect(onMon[0]!.t).toBe(admin[0]!.t);
    expect(outputsOf(evs, quiet)).toEqual([]);
    // the other device's console never prints R1's logs
    const pc = sim.cli.open('pc1', 'console');
    const before = sim.trace(0).next;
    type(sim, con, ['no shutdown']);
    sim.runFor(5 * SEC);
    expect(outputsOf(sim.trace(before).events, pc)).toEqual([]);
  });
});
