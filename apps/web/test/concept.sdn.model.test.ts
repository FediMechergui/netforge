/**
 * [C26] The controller explorer (ARCHITECTURE-P3C §7 W1b web-concept (a), §10.2; lesson 36, CCNA3.automation.8).
 *
 * Under test: the plane sorting and its score, the interface directions, the overlay that lives only while its underlay
 * joins its ends (with the path it takes), an intent compiled per device role, assurance naming every drifted device
 * and the repair, the effort count, the seeded quiz and its scoring; and the tool's panes with labelled controls only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONTROLLER_INTERFACES,
  PLANES,
  PLANE_TASKS,
  SDN_FABRIC,
  SDN_INTENTS,
  SDN_QUIZ_KINDS,
  assureIntent,
  changeEffort,
  compileIntent,
  driftConfig,
  interfaceDirection,
  overlayStatus,
  scorePlanes,
  scoreSdnQuiz,
  sdnQuiz,
  underlayPath,
  type Plane,
} from '../src/concept/sdn/model';
import { ControllerPane, FabricPane, IntentPane, PlanesPane, SDN_PANES, SdnExplorer, SdnQuizPane } from '../src/concept/sdn/SdnExplorer';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

describe('planes', () => {
  it('has the three planes and jobs in each', () => {
    expect(PLANES.map((p) => p.id)).toEqual(['data', 'control', 'management']);
    for (const p of PLANES) expect(PLANE_TASKS.filter((t) => t.plane === p.id).length, p.id).toBe(4);
    expect(new Set(PLANE_TASKS.map((t) => t.id)).size).toBe(PLANE_TASKS.length);
    expect(PLANE_TASKS.find((t) => t.id === 'ospf-hello')!.plane).toBe('control');
    expect(PLANE_TASKS.find((t) => t.id === 'acl-match')!.plane).toBe('data');
    expect(PLANE_TASKS.find((t) => t.id === 'ssh')!.plane).toBe('management');
  });

  it('scores a sorting: right, wrong and unsorted', () => {
    const all = Object.fromEntries(PLANE_TASKS.map((t) => [t.id, t.plane])) as Record<string, Plane>;
    expect(scorePlanes(all).correct).toBe(PLANE_TASKS.length);
    expect(scorePlanes(all).summary).toBe(`${PLANE_TASKS.length} of ${PLANE_TASKS.length} jobs in the right plane.`);
    const s = scorePlanes({ ...all, 'ospf-hello': 'data', ssh: undefined });
    expect(s.correct).toBe(PLANE_TASKS.length - 2);
    const hello = s.results.find((r) => r.id === 'ospf-hello')!;
    expect([hello.given, hello.expected, hello.correct]).toEqual(['data', 'control', false]);
    expect(hello.text).toContain('is control plane, not data plane');
    expect(s.results.find((r) => r.id === 'ssh')!.text.startsWith('Not sorted')).toBe(true);
    expect(scorePlanes({}).correct).toBe(0);
  });
});

describe('controller interfaces', () => {
  it('faces applications northbound and devices southbound', () => {
    expect(interfaceDirection('REST API with JSON')).toBe('northbound');
    for (const s of ['OpenFlow', 'NETCONF', 'RESTCONF', 'Command line over SSH']) expect(interfaceDirection(s), s).toBe('southbound');
    expect(interfaceDirection('carrier pigeon')).toBeNull();
    expect(CONTROLLER_INTERFACES.filter((i) => i.direction === 'northbound').length).toBe(1);
  });
});

describe('underlay and overlay', () => {
  it('a spine-and-leaf fabric: every leaf linked to both spines', () => {
    expect(SDN_FABRIC.links.map((l) => l.id)).toEqual(['B1-S1', 'B1-S2', 'E1-S1', 'E1-S2', 'E2-S1', 'E2-S2', 'E3-S1', 'E3-S2']);
    expect(SDN_FABRIC.tunnels.map((t) => t.id)).toEqual(['E1~B1', 'E2~B1', 'E3~B1', 'E1~E2']);
  });

  it('with every link up, each tunnel is up over one spine (the first in link order)', () => {
    const s = overlayStatus(SDN_FABRIC, []);
    expect(s.every((t) => t.up)).toBe(true);
    expect(s.map((t) => t.path)).toEqual([
      ['E1', 'S1', 'B1'],
      ['E2', 'S1', 'B1'],
      ['E3', 'S1', 'B1'],
      ['E1', 'S1', 'E2'],
    ]);
    expect(s[0]!.text).toBe('Tunnel E1–B1 is up, carried by the underlay along E1 → S1 → B1.');
  });

  it('one failed link moves the tunnel to the other spine; losing both takes the overlay down', () => {
    const one = overlayStatus(SDN_FABRIC, ['E3-S1']);
    expect(one.find((t) => t.id === 'E3~B1')).toMatchObject({ up: true, path: ['E3', 'S2', 'B1'] });
    const both = overlayStatus(SDN_FABRIC, ['E3-S1', 'E3-S2']);
    expect(both.map((t) => [t.id, t.up])).toEqual([
      ['E1~B1', true],
      ['E2~B1', true],
      ['E3~B1', false],
      ['E1~E2', true],
    ]);
    expect(both[2]).toMatchObject({ path: null, text: 'Tunnel E3–B1 is down: the underlay no longer joins E3 and B1.' });
    // a spine lost entirely: everything rides the other spine
    expect(overlayStatus(SDN_FABRIC, ['B1-S1', 'E1-S1', 'E2-S1', 'E3-S1']).map((t) => t.path?.[1])).toEqual(['S2', 'S2', 'S2', 'S2']);
    expect(underlayPath(SDN_FABRIC, new Set(), 'E1', 'E1')).toEqual(['E1']);
  });
});

describe('intent', () => {
  it('compiles one outcome into the lines each touched role needs', () => {
    const guest = compileIntent('guest-internet');
    expect(guest.map((c) => c.device)).toEqual(['B1', 'E1', 'E2', 'E3']);
    expect(guest.find((c) => c.device === 'E1')!.lines.slice(0, 2)).toEqual(['vlan 40', ' name GUESTS']);
    expect(guest.find((c) => c.device === 'B1')!.lines.at(-1)).toBe(' permit ip 10.40.0.0 0.0.255.255 any');
    expect(compileIntent('voice-first').map((c) => c.device)).toEqual(['S1', 'S2', 'B1', 'E1', 'E2', 'E3']);
    expect(compileIntent('isolate-cameras').map((c) => c.device)).toEqual(['E1', 'E2', 'E3']);
    expect(SDN_INTENTS.map((i) => i.id)).toEqual(['guest-internet', 'voice-first', 'isolate-cameras']);
  });

  it('assurance passes when every device holds the lines, names each drifted device, and a re-push repairs it', () => {
    const intended = Object.fromEntries(compileIntent('isolate-cameras').map((c) => [c.device, c.lines]));
    const ok = assureIntent('isolate-cameras', intended);
    expect(ok.compliant).toBe(true);
    expect(ok.text).toBe('Delivered: every device holds what "Cameras talk only to the video recorder" needs.');

    const drifted = { ...intended, E2: driftConfig(intended.E2!) };
    const bad = assureIntent('isolate-cameras', drifted);
    expect(bad.compliant).toBe(false);
    expect(bad.devices.map((d) => [d.device, d.delivered])).toEqual([
      ['E1', true],
      ['E2', false],
      ['E3', true],
    ]);
    expect(bad.devices[1]!.missing).toEqual([' deny ip any any']);
    expect(bad.text).toContain('E2 has drifted');

    const two = assureIntent('isolate-cameras', { E1: [] , E3: intended.E3! });
    expect(two.text).toContain('E1, E2 have drifted');
    // extra lines a device also holds do not break delivery
    expect(assureIntent('isolate-cameras', Object.fromEntries(Object.entries(intended).map(([d, l]) => [d, [...l, 'hostname X']]))).compliant).toBe(true);
    expect(assureIntent('isolate-cameras', intended).devices.every((d) => d.missing.length === 0)).toBe(true);
  });

  it('counts one change box by box against one intent', () => {
    expect(changeEffort(120, 6)).toMatchObject({ boxByBox: { sessions: 120, lines: 720 }, controller: { intents: 1, pushes: 120 } });
    expect(changeEffort(1, 1).text).toBe(
      'Box by box: 1 login and 1 typed line, each a chance to slip. With a controller: one intent, which it pushes to 1 device and then keeps checking.',
    );
    expect(changeEffort(0, 5)).toMatchObject({ boxByBox: { sessions: 0, lines: 0 }, controller: { intents: 0, pushes: 0 }, text: 'No device needs the change.' });
    expect(changeEffort(-3, 2.7).boxByBox).toEqual({ sessions: 0, lines: 0 });
  });
});

describe('quiz', () => {
  it('is a pure function of the seed and cycles plane, interface, concept', () => {
    expect(sdnQuiz(4)).toEqual(sdnQuiz(4));
    expect(sdnQuiz(4, 6).map((q) => q.kind)).toEqual([...SDN_QUIZ_KINDS, ...SDN_QUIZ_KINDS]);
    expect(sdnQuiz(9, 2)).toEqual(sdnQuiz(9, 6).slice(0, 2));
    const seen = new Set<string>();
    for (let seed = 0; seed < 30; seed++) for (const q of sdnQuiz(seed)) seen.add(q.id);
    expect(seen.size).toBeGreaterThan(10);
  });

  it('every answer is the model\'s own: the task\'s plane, the interface\'s direction', () => {
    for (let seed = 0; seed < 30; seed++) {
      for (const q of sdnQuiz(seed)) {
        expect(new Set(q.options).size, q.id).toBe(q.options.length);
        expect(q.answer >= 0 && q.answer < q.options.length, q.id).toBe(true);
        if (q.kind === 'plane') {
          const task = PLANE_TASKS.find((t) => q.prompt.includes(t.text))!;
          expect(q.options).toEqual(['Data plane', 'Control plane', 'Management plane']);
          expect(q.options[q.answer]).toBe(PLANES.find((p) => p.id === task.plane)!.label);
        }
        if (q.kind === 'interface') {
          const f = CONTROLLER_INTERFACES.find((i) => q.prompt.includes(`does ${i.name} face`))!;
          expect(q.options[q.answer]!.toLowerCase().startsWith(f.direction)).toBe(true);
        }
      }
    }
  });

  it('scores right, wrong and skipped answers', () => {
    const quiz = sdnQuiz(2, 3);
    const right = quiz.map((q) => q.answer);
    expect(scoreSdnQuiz(quiz, right)).toMatchObject({ correct: 3, answered: 3, total: 3, percent: 100, summary: '3 of 3 right (100 %).' });
    const wrong = (quiz[0]!.answer + 1) % quiz[0]!.options.length;
    const s = scoreSdnQuiz(quiz, [wrong, null, right[2]!]);
    expect(s.results.map((r) => r.correct)).toEqual([false, false, true]);
    expect([s.correct, s.answered, s.percent]).toEqual([1, 2, 33]);
    expect(s.summary).toBe('1 of 3 right (33 %), 1 skipped.');
    expect(scoreSdnQuiz(quiz, [7, 1.5]).correct).toBe(0);
  });
});

describe('the tool', () => {
  it('offers five panes as a labelled toggle group, opening on the planes', () => {
    const html = renderToStaticMarkup(createElement(SdnExplorer));
    expect(SDN_PANES.map((p) => p.id)).toEqual(['planes', 'controller', 'fabric', 'intent', 'quiz']);
    expect(html).toContain('role="group" aria-label="Controller explorer panes"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(text(html)).toContain('Management plane');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('draws each pane from the model, with every control labelled', () => {
    expect(text(renderToStaticMarkup(createElement(ControllerPane)))).toContain('120 logins, 720 lines');
    const fabric = text(renderToStaticMarkup(createElement(FabricPane)));
    expect(fabric).toContain('E1 → S1 → B1');
    expect(fabric).toContain('▲ up');
    const intent = text(renderToStaticMarkup(createElement(IntentPane)));
    expect(intent).toContain('Delivered: every device holds what "Guests reach the internet and nothing else" needs.');
    expect(intent).toContain('ip access-list extended GUESTS-OUT');
    expect(text(renderToStaticMarkup(createElement(SdnQuizPane)))).toContain(sdnQuiz(1)[0]!.prompt);
    for (const pane of [PlanesPane, ControllerPane, FabricPane, IntentPane, SdnQuizPane]) {
      expect(unlabelledControls(renderToStaticMarkup(createElement(pane))), pane.name).toEqual([]);
    }
  });

  it('names no vendor or product in what a learner reads', () => {
    const all = [PlanesPane, ControllerPane, FabricPane, IntentPane, SdnQuizPane].map((p) => text(renderToStaticMarkup(createElement(p)))).join(' ');
    expect(all).not.toMatch(/cisco|juniper|arista|vmware|ansible|dna center|\baci\b/i);
  });
});
