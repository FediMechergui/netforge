/**
 * W6 fix: what the CCNA 2 lessons promise is what NetForge does (review findings #0-#5 on the W6 course text).
 *
 *   #0 lesson 21 (and the HSRP lab text): a power cut loses every unsaved line, so the See-it step saves R1's
 *      configuration before powering it off — and following the lesson in its own lab keeps full marks: R1 comes back
 *      with its standby lines and takes the active role back. Without the save it would come back with none.
 *   #1 lesson 15: a port that fell back to the classic protocol returns to the rapid one by itself (802.1D-2004
 *      §17.24); the clear command is for a neighbour that never sends a rapid BPDU.
 *   #2 lesson 21: routers that disagree on the virtual address still elect an active router (never "alone").
 *   #3 lesson 24: a one-sided native VLAN change blocks the two native VLANs, not the whole trunk (as lesson 06 says).
 *   #4 lesson 08: the capture step comes after a step that makes the phone and the computer send something, and says
 *      whose tagged frames are the switch's.
 *   #5 lesson minutes cover reading and watching: for the lessons whose video length was measured (the W6 course
 *      review, from each video's watch page), minutes ≥ video + the theory read at 238 words a minute.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { HsrpRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { CCNA2_THEORY } from '../src/curriculum/ccna2/theory.js';
import { CCNA2_VIDEOS } from '../src/curriculum/ccna2/videos.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { HSRP_USER_GROUP, ccna2HsrpGateway } from '../src/sim/scenarios/ccna2/fhrp.js';
import { createSimulation } from '../src/sim/simulation.js';

const L03 = 'ccna2-03-speed-duplex-and-cabling';
const L08 = 'ccna2-08-voice-vlans';
const L15 = 'ccna2-15-rapid-spanning-tree';
const L20 = 'ccna2-20-one-gateway-one-point-of-failure';
const L21 = 'ccna2-21-hot-standby-gateways';
const L22 = 'ccna2-22-threats-at-layer-2';
const L24 = 'ccna2-24-hardening-switch-ports';
const L29 = 'ccna2-29-how-a-router-chooses';

const theory = (id: string): string => {
  const body = CCNA2_THEORY[id];
  if (body === undefined) throw new Error(`lesson ${id} has no theory`);
  return body;
};

/** The bullet lines of a body's "See it in NetForge" section. */
function seeIt(id: string): string[] {
  const body = theory(id);
  const at = body.indexOf('## See it in NetForge');
  expect(at, `${id} has a See-it section`).toBeGreaterThanOrEqual(0);
  const rest = body.slice(at).split('\n').slice(1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- '));
}

describe('#0 lesson 21: save before the power cut, and the lab agrees', () => {
  it('the See-it bullet and the lab text save R1 before powering it off', () => {
    const bullet = seeIt(L21).find((l) => l.includes('Power off'));
    expect(bullet).toBeDefined();
    expect(bullet!.indexOf('copy running-config startup-config')).toBeGreaterThanOrEqual(0);
    expect(bullet!.indexOf('copy running-config startup-config')).toBeLessThan(bullet!.indexOf('Power off'));
    const lab = ccna2HsrpGateway.instructions ?? '';
    expect(lab.indexOf('copy running-config startup-config')).toBeGreaterThanOrEqual(0);
    expect(lab.indexOf('copy running-config startup-config')).toBeLessThan(lab.indexOf('switch R1 off'));
  });

  const idOf = (sim: Simulation, name: string): DeviceId => {
    for (const d of sim.devices()) if (d.spec.name === name) return d.id;
    throw new Error(`no device called ${name}`);
  };

  /** The lab solved as the lesson says, then R1 power-cycled (saved first or not). */
  function powerCycled(lab: ScenarioInfo, save: boolean): Simulation {
    const sim = createSimulation({ seed: lab.seed ?? 1 });
    sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
    for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
    sim.runFor(90 * SEC);
    sim.runToIdle();
    for (const [name, lines] of Object.entries(lab.solution ?? {})) expect(sim.configure(idOf(sim, name), lines).ok, name).toBe(true);
    sim.runFor(30 * SEC);
    expect(evaluateLab(sim, lab).score).toBe(evaluateLab(sim, lab).total);
    const r1 = idOf(sim, 'R1');
    if (save) {
      const s = sim.cli.open(r1, 'console');
      sim.cli.exec(s, 'enable');
      expect(sim.cli.exec(s, 'copy running-config startup-config').output).toContain('startup-config');
    }
    sim.setPower(r1, false);
    sim.runFor(30 * SEC);
    sim.setPower(r1, true);
    sim.runFor(120 * SEC);
    return sim;
  }

  const userGroupState = (sim: Simulation, name: string): string | undefined =>
    sim.device(idOf(sim, name))!.tables.get<HsrpRow>('hsrp')!.rows().find((r) => r.group === HSRP_USER_GROUP)?.state;

  it('following the lesson (save, power off, power on) R1 takes the active role back and the lab keeps full marks', () => {
    const sim = powerCycled(ccna2HsrpGateway, true);
    expect(userGroupState(sim, 'R1')).toBe('active');
    expect(userGroupState(sim, 'R2')).toBe('standby');
    const status = evaluateLab(sim, ccna2HsrpGateway);
    expect(status.score).toBe(status.total);
  });

  it('without the save R1 comes back with no standby group 10 (why the lesson saves first)', () => {
    const sim = powerCycled(ccna2HsrpGateway, false);
    expect(userGroupState(sim, 'R1')).toBeUndefined();
    expect(userGroupState(sim, 'R2')).toBe('active');
  });
});

describe('#1-#4 the trap and See-it bullets match NetForge', () => {
  it('#1 lesson 15: a fallen-back port returns to rapid by itself; the clear command is for a neighbour that never answers', () => {
    const body = theory(L15);
    expect(body).not.toMatch(/stays on the classic protocol after its neighbour is upgraded/);
    expect(body).toMatch(/returns to the rapid protocol by itself/);
    expect(body).toContain('`clear spanning-tree detected-protocols`');
  });

  it('#2 lesson 21: a virtual-address mismatch still elects an active router', () => {
    const body = theory(L21);
    expect(body).not.toMatch(/virtual address and version must match on every member, or each router believes it is alone/);
    expect(body).toMatch(/disagree on it still elect an active router/);
  });

  it('#3 lesson 24: a one-sided native VLAN blocks the two native VLANs, the others keep crossing', () => {
    const body = theory(L24);
    expect(body).not.toMatch(/spanning tree blocks the trunk as inconsistent/);
    expect(body).toMatch(/blocks the two native VLANs on that trunk/);
    expect(body).toMatch(/other VLANs keep crossing/);
  });

  it('#4 lesson 08: the hosts are made to talk before the capture, and the tagged BPDUs are named as the switch\'s', () => {
    const bullets = seeIt(L08);
    const capture = bullets.findIndex((l) => l.includes('NetScope'));
    const talk = bullets.findIndex((l) => /ping/.test(l) && /IP configuration/.test(l));
    expect(capture).toBeGreaterThan(0);
    expect(talk).toBeGreaterThanOrEqual(0);
    expect(talk).toBeLessThan(capture);
    expect(bullets[capture]).toMatch(/come from the switch/);
  });
});

describe('#5 lesson minutes cover reading and watching', () => {
  /** Video lengths measured from each video's watch page (lengthSeconds) in the W6 course review, by lesson. */
  const MEASURED: Readonly<Record<string, { readonly youtubeId: string; readonly seconds: number }>> = {
    [L03]: { youtubeId: 'mwVX62wx6jo', seconds: 512 },
    [L08]: { youtubeId: 'MlKL5JuQ2uE', seconds: 529 },
    [L20]: { youtubeId: 'diULMkbm1tQ', seconds: 470 },
    [L22]: { youtubeId: 'jYpxJPUQJDQ', seconds: 624 },
    [L29]: { youtubeId: 'PDcwijVC4XE', seconds: 900 },
  };
  /** A generous adult reading speed for instructional text. */
  const WPM = 238;
  const lessons = CCNA2_MODULES.flatMap((m) => m.lessons);

  for (const [id, video] of Object.entries(MEASURED)) {
    it(`${id}: ${video.seconds} s of video plus the theory fit its minutes`, () => {
      expect(CCNA2_VIDEOS[id]?.youtubeId, `${id} still shows the measured video`).toBe(video.youtubeId);
      const lesson = lessons.find((l) => l.id === id)!;
      const words = theory(id).split(/\s+/).filter((w) => w.length > 0).length;
      const needed = video.seconds / 60 + words / WPM;
      expect(lesson.estimatedMinutes, `${id}: ${needed.toFixed(1)} min needed`).toBeGreaterThanOrEqual(needed);
      expect(lesson.estimatedMinutes).toBeLessThanOrEqual(45);
    });
  }
});
