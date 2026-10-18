/**
 * [S22] The WAN and VPN explorer (ARCHITECTURE-P3C §7 W1b web-concept (a), §10.2).
 *
 * Under test: the label-stack algebra (push/swap/pop with the bottom-of-stack and TTL rules, refusals, the 32-bit
 * entry encoding, the walk across a provider core with and without penultimate-hop popping), the VPN byte accounting
 * (ESP padding to the block, the largest inner packet on a 1500-byte link, GRE's 1476 of lesson 24), the WAN kind
 * comparison, the seeded quiz and its scoring; and the tool's panes rendered with labelled controls only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ESP_BLOCK,
  VPN_KINDS,
  WAN_KINDS,
  WAN_QUIZ_KINDS,
  applyLabelOp,
  applyLabelOps,
  compareWanKinds,
  decodeLabelEntry,
  encapsulate,
  encodeLabelEntry,
  espPadding,
  maxInnerPacket,
  scoreWanQuiz,
  stackHex,
  stackText,
  walkLsp,
  wanQuiz,
  type LabelOp,
  type LabelState,
} from '../src/concept/wan/model';
import { LabelSandbox, LabelsPane, VpnPane, WAN_PANES, WanExplorer, WanKindsPane, WanQuizPane } from '../src/concept/wan/WanExplorer';

const EMPTY: LabelState = { stack: [], ipTtl: 64 };

function run(ops: readonly LabelOp[], from: LabelState = EMPTY): LabelState {
  const r = applyLabelOps(from, ops);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

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

/** Every input and select in `html` is named by a `<label for>` or an aria-label. */
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

describe('label-stack algebra', () => {
  it('push builds the stack top first, with the bottom bit on the last entry only', () => {
    const s = run([{ op: 'push', label: 30 }, { op: 'push', label: 1001 }, { op: 'push', label: 500, tc: 5 }]);
    expect(s.stack.map((e) => e.label)).toEqual([500, 1001, 30]);
    expect(s.stack.map((e) => e.bottom)).toEqual([false, false, true]);
    expect(s.stack.map((e) => e.tc)).toEqual([5, 0, 0]);
    expect(stackText(s.stack)).toBe('[500, 1001, 30]');
    expect(stackText([])).toBe('no labels');
  });

  it('a push copies the TTL from below (the IP header when empty) and the traffic class when none is given', () => {
    const one = run([{ op: 'push', label: 30, tc: 3 }], { stack: [], ipTtl: 17 });
    expect(one.stack[0]).toEqual({ label: 30, tc: 3, bottom: true, ttl: 17 });
    const two = run([{ op: 'push', label: 40 }], one);
    expect(two.stack[0]).toEqual({ label: 40, tc: 3, bottom: false, ttl: 17 });
  });

  it('push then pop is the identity', () => {
    const base = run([{ op: 'push', label: 30 }, { op: 'push', label: 1001 }]);
    for (const label of [16, 999, 0xfffff]) expect(run([{ op: 'push', label }, { op: 'pop' }], base)).toEqual(base);
    expect(run([{ op: 'push', label: 77 }, { op: 'pop' }])).toEqual(EMPTY);
  });

  it('swap keeps the depth, changes only the top label and spends one TTL', () => {
    const base = run([{ op: 'push', label: 30 }, { op: 'push', label: 1001 }]);
    const s = run([{ op: 'swap', label: 2002 }], base);
    expect(s.stack.length).toBe(base.stack.length);
    expect(s.stack.map((e) => e.label)).toEqual([2002, 30]);
    expect(s.stack[0]!.ttl).toBe(63);
    expect(s.stack[1]).toEqual(base.stack[1]);
    // two swaps compose into one swap to the last label, two hops later
    expect(run([{ op: 'swap', label: 7000 }, { op: 'swap', label: 2002 }], base).stack.map((e) => e.label)).toEqual([2002, 30]);
  });

  it('a pop copies the lower TTL down, so the hops inside the core still count', () => {
    const s = run([{ op: 'push', label: 30 }, { op: 'push', label: 1001 }, { op: 'swap', label: 2002 }, { op: 'swap', label: 3003 }]);
    expect(s.stack.map((e) => e.ttl)).toEqual([62, 64]);
    const popped = run([{ op: 'pop' }], s);
    expect(popped.stack).toEqual([{ label: 30, tc: 0, bottom: true, ttl: 62 }]);
    const ip = run([{ op: 'pop' }], popped);
    expect(ip).toEqual({ stack: [], ipTtl: 62 });
  });

  it('depth is pushes minus pops for any valid sequence', () => {
    const ops: LabelOp[] = [{ op: 'push', label: 20 }, { op: 'push', label: 21 }, { op: 'swap', label: 22 }, { op: 'pop' }, { op: 'push', label: 23 }, { op: 'push', label: 24 }];
    expect(run(ops).stack.length).toBe(ops.filter((o) => o.op === 'push').length - ops.filter((o) => o.op === 'pop').length);
  });

  it('refuses what a router cannot do, and says which step refused', () => {
    expect(applyLabelOp(EMPTY, { op: 'pop' })).toEqual({ ok: false, error: 'There is no label to pop: the stack is empty.' });
    expect(applyLabelOp(EMPTY, { op: 'swap', label: 100 }).ok).toBe(false);
    for (const bad of [0, 3, 15]) expect(applyLabelOp(EMPTY, { op: 'push', label: bad })).toEqual({ ok: false, error: 'Labels 0 to 15 are reserved for special meanings.' });
    for (const bad of [-1, 0x100000, 1.5]) expect(applyLabelOp(EMPTY, { op: 'push', label: bad }).ok).toBe(false);
    expect(applyLabelOp(EMPTY, { op: 'push', label: 16, tc: 8 }).ok).toBe(false);
    const dying = run([{ op: 'push', label: 30 }], { stack: [], ipTtl: 1 });
    expect(applyLabelOp(dying, { op: 'swap', label: 31 })).toEqual({ ok: false, error: 'The TTL runs out here, so the packet expires instead of being forwarded.' });
    const r = applyLabelOps(EMPTY, [{ op: 'push', label: 30 }, { op: 'pop' }, { op: 'pop' }]);
    expect(r.ok === false && r.error).toBe('Step 3: There is no label to pop: the stack is empty.');
  });

  it('encodes an entry as label 20 bits, traffic class 3, bottom 1, TTL 8, and decodes it back', () => {
    expect(encodeLabelEntry({ label: 1001, tc: 0, bottom: true, ttl: 64 })).toBe(0x003e9140);
    expect(encodeLabelEntry({ label: 0xfffff, tc: 7, bottom: true, ttl: 255 })).toBe(0xffffffff);
    for (const e of [
      { label: 16, tc: 0, bottom: false, ttl: 1 },
      { label: 524288, tc: 5, bottom: true, ttl: 200 },
      { label: 0xfffff, tc: 7, bottom: false, ttl: 0 },
    ]) {
      expect(decodeLabelEntry(encodeLabelEntry(e))).toEqual(e);
    }
    const s = run([{ op: 'push', label: 30 }, { op: 'push', label: 1001 }]);
    expect(stackHex(s.stack)).toBe('00 3e 90 40 | 00 01 e1 40');
  });
});

describe('a walk across the provider core', () => {
  it('with penultimate-hop popping: push 30 and 1001, swap to 2002, pop, pop', () => {
    const w = walkLsp('l3vpn', true);
    expect(w.error).toBeUndefined();
    expect(w.hops.map((h) => h.router)).toEqual(['CE-A', 'PE-1', 'P-1', 'P-2', 'PE-2', 'CE-B']);
    expect(w.hops.map((h) => stackText(h.state.stack))).toEqual(['no labels', '[1001, 30]', '[2002, 30]', '[30]', 'no labels', 'no labels']);
    expect(w.hops[5]!.state.ipTtl).toBe(63); // one swap in the core
    expect(w.hops[3]!.text).toContain('penultimate-hop popping');
  });

  it('without it, P-2 swaps to the far edge\'s label and PE-2 pops both', () => {
    const w = walkLsp('l3vpn', false);
    expect(w.hops.map((h) => stackText(h.state.stack))).toEqual(['no labels', '[1001, 30]', '[2002, 30]', '[3003, 30]', 'no labels', 'no labels']);
    expect(w.hops[4]!.ops).toEqual([{ op: 'pop' }, { op: 'pop' }]);
    expect(w.hops[5]!.state.ipTtl).toBe(62);
  });

  it('a transport-only path carries one label', () => {
    expect(walkLsp('transport', true).hops.map((h) => h.state.stack.length)).toEqual([0, 1, 1, 0, 0, 0]);
    expect(walkLsp('transport', false).hops.map((h) => h.state.stack.length)).toEqual([0, 1, 1, 1, 0, 0]);
  });

  it('a TTL too small for the core stops the walk at the router where it expires', () => {
    const w = walkLsp('l3vpn', true, 1);
    expect(w.error).toBe('P-1: Step 1: The TTL runs out here, so the packet expires instead of being forwarded.');
    expect(w.hops.map((h) => h.router)).toEqual(['CE-A', 'PE-1']);
  });
});

describe('VPN bytes', () => {
  it('GRE adds 24 bytes, leaving 1476 for the inner packet (lesson 24)', () => {
    const e = encapsulate('gre', 1000);
    expect(e.layers.map((l) => [l.name, l.bytes])).toEqual([
      ['Outer IPv4 header', 20],
      ['GRE header', 4],
      ['Inner IPv4 packet', 1000],
    ]);
    expect(e.overhead).toBe(24);
    expect(maxInnerPacket('gre')).toBe(1476);
  });

  it('ESP pads the encrypted part to whole cipher blocks', () => {
    for (let n = 0; n < 64; n++) expect((n + espPadding(n) + 2) % ESP_BLOCK).toBe(0);
    const e = encapsulate('ipsec-site', 1000);
    expect(e.total).toBe(20 + 8 + 16 + 1000 + 6 + 2 + 16);
    expect(e.layers.filter((l) => l.encrypted === true).map((l) => l.name)).toEqual(['Inner IPv4 packet', 'ESP padding', 'ESP trailer']);
  });

  it('gives the largest whole inner packet per kind on a 1500-byte link, and it is the largest', () => {
    const fits = Object.fromEntries(VPN_KINDS.map((k) => [k.id, maxInnerPacket(k.id)]));
    expect(fits).toEqual({
      gre: 1476,
      'ipsec-site': 1438,
      'gre-over-ipsec': 1434,
      'remote-ipsec': 1422,
      'remote-tls': 1439,
      'mpls-l3vpn': 1492,
      'mpls-l2vpn': 1474,
    });
    for (const k of VPN_KINDS) {
      expect(encapsulate(k.id, fits[k.id]!).total, k.id).toBeLessThanOrEqual(1500);
      expect(encapsulate(k.id, fits[k.id]! + 1).total, k.id).toBeGreaterThan(1500);
    }
  });

  it('every kind has exactly one inner layer, and only encrypting kinds hide it', () => {
    for (const k of VPN_KINDS) {
      const e = encapsulate(k.id, 500);
      expect(e.layers.filter((l) => l.inner === true).length, k.id).toBe(1);
      expect(e.layers.find((l) => l.inner === true)!.encrypted === true, k.id).toBe(k.encrypts);
      expect(e.total, k.id).toBe(e.layers.reduce((n, l) => n + l.bytes, 0));
    }
  });
});

describe('WAN kinds', () => {
  it('compares kinds row by row and marks the rows that differ', () => {
    const rows = compareWanKinds(['mpls', 'dsl']);
    const row = (p: string) => rows.find((r) => r.property === p)!;
    expect(row('Family').values).toEqual(['private WAN service', 'internet access']);
    expect(row('Bandwidth promised in a contract')).toEqual({ property: 'Bandwidth promised in a contract', values: ['yes', 'no'], differs: true });
    expect(row('Cost').differs).toBe(true);
    expect(compareWanKinds(['dsl', 'dsl']).every((r) => !r.differs)).toBe(true);
    expect(WAN_KINDS.filter((k) => k.family === 'private').map((k) => k.id)).toEqual(['leased-line', 'mpls', 'metro-ethernet']);
  });
});

describe('quiz', () => {
  it('is a pure function of the seed, cycling through the four kinds', () => {
    expect(wanQuiz(7)).toEqual(wanQuiz(7));
    expect(wanQuiz(7)).not.toEqual(wanQuiz(8));
    expect(wanQuiz(3, 8).map((q) => q.kind)).toEqual([...WAN_QUIZ_KINDS, ...WAN_QUIZ_KINDS]);
    // question i does not depend on how many are asked
    expect(wanQuiz(5, 3)).toEqual(wanQuiz(5, 8).slice(0, 3));
  });

  it('every question has distinct options and its answer among them', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const q of wanQuiz(seed)) {
        expect(new Set(q.options).size, q.id).toBe(q.options.length);
        expect(q.options.length, q.id).toBeGreaterThanOrEqual(2);
        expect(q.options.length, q.id).toBeLessThanOrEqual(4);
        expect(q.answer >= 0 && q.answer < q.options.length, q.id).toBe(true);
        expect(q.explanation.length, q.id).toBeGreaterThan(0);
      }
    }
  });

  it('the label and overhead answers are the model\'s own figures', () => {
    for (let seed = 0; seed < 20; seed++) {
      for (const q of wanQuiz(seed)) {
        if (q.kind === 'overhead') {
          const kind = VPN_KINDS.find((k) => q.prompt.includes(`a ${k.label} can`))!;
          expect(q.options[q.answer]).toBe(String(maxInnerPacket(kind.id)));
        }
        if (q.kind === 'label') {
          const stack = /stack \[([\d, ]+)\]/.exec(q.prompt)![1]!.split(', ').map(Number);
          const opText = /does "([^"]+)"/.exec(q.prompt)![1]!;
          const [name, arg] = opText.split(' ');
          const start = run([...stack].reverse().map((label) => ({ op: 'push' as const, label })));
          const op: LabelOp = name === 'pop' ? { op: 'pop' } : { op: name as 'push' | 'swap', label: Number(arg) };
          const r = applyLabelOp(start, op);
          expect(r.ok && q.options[q.answer]).toBe(r.ok && stackText(r.state.stack));
        }
      }
    }
  });

  it('scores right, wrong and skipped answers', () => {
    const quiz = wanQuiz(11, 4);
    const right = quiz.map((q) => q.answer);
    const all = scoreWanQuiz(quiz, right);
    expect([all.correct, all.answered, all.total, all.percent]).toEqual([4, 4, 4, 100]);
    expect(all.summary).toBe('4 of 4 right (100 %).');

    const wrong = (i: number) => (quiz[i]!.answer + 1) % quiz[i]!.options.length;
    const mixed = scoreWanQuiz(quiz, [right[0]!, wrong(1), null]);
    expect(mixed.results.map((r) => r.correct)).toEqual([true, false, false, false]);
    expect(mixed.results.map((r) => r.given)).toEqual([right[0], wrong(1), null, null]);
    expect([mixed.correct, mixed.answered, mixed.percent]).toEqual([1, 2, 25]);
    expect(mixed.summary).toBe('1 of 4 right (25 %), 2 skipped.');
    expect(mixed.results[1]!.text).toContain(`the answer is ${quiz[1]!.options[quiz[1]!.answer]}`);
    expect(mixed.results[2]!.text.startsWith('Skipped.')).toBe(true);

    // an index outside the options is wrong, not an error; one third rounds to a whole percent
    const three = wanQuiz(11, 3);
    expect(scoreWanQuiz(three, [99, three[1]!.answer, -1]).percent).toBe(33);
    expect(scoreWanQuiz([], []).summary).toBe('There are no questions.');
  });
});

describe('the tool', () => {
  it('offers four panes as a labelled toggle group, opening on the WAN kinds', () => {
    const html = renderToStaticMarkup(createElement(WanExplorer));
    expect(WAN_PANES.map((p) => p.id)).toEqual(['kinds', 'vpn', 'labels', 'quiz']);
    expect(html).toContain('role="group" aria-label="WAN explorer panes"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(text(html)).toContain('Bandwidth promised in a contract');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('draws each pane from the model, with every control labelled', () => {
    const kinds = text(renderToStaticMarkup(createElement(WanKindsPane)));
    expect(kinds).toContain('≠ Family');
    const vpn = text(renderToStaticMarkup(createElement(VpnPane)));
    expect(vpn).toContain('1434 bytes'); // GRE over IPsec on 1500
    expect(vpn).toContain('encrypted');
    const labels = text(renderToStaticMarkup(createElement(LabelsPane)));
    expect(labels).toContain('[1001, 30]');
    expect(labels).toContain('00 3e 90 40 | 00 01 e1 40');
    expect(text(renderToStaticMarkup(createElement(LabelSandbox)))).toContain('The stack is empty');
    const quiz = renderToStaticMarkup(createElement(WanQuizPane));
    expect(text(quiz)).toContain(wanQuiz(1)[0]!.prompt);
    expect(quiz).toContain('aria-live="polite"');
    for (const pane of [WanKindsPane, VpnPane, LabelsPane, WanQuizPane]) expect(unlabelledControls(renderToStaticMarkup(createElement(pane))), pane.name).toEqual([]);
  });

  it('names no vendor or product in what a learner reads', () => {
    const quizText = [1, 2, 3].flatMap((s) => wanQuiz(s)).map((q) => [q.prompt, ...q.options, q.explanation].join(' '));
    const all = [WanKindsPane, VpnPane, LabelsPane].map((p) => text(renderToStaticMarkup(createElement(p)))).concat(quizText, VPN_KINDS.map((k) => k.summary + k.routing), WAN_KINDS.map((k) => k.bestFor + k.watchOut));
    expect(all.join(' ')).not.toMatch(/cisco|juniper|anyconnect|dmvpn|getvpn|easy ?vpn|ansible/i);
  });
});
