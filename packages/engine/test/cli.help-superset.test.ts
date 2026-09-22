/**
 * The P1 help lists are a floor, not a target (ARCHITECTURE-P2 §7 W1 cli, §9 W1 item 8).
 *
 * `goldens/cli-help.p1.json` is a frozen copy of the P0.5/P1 `goldens/cli-help.p05.json`, taken before any P2 grammar
 * change. Every later regeneration of `cli-help.p05.json` (W2 and W3 add router lines, W4 the managed-switch grammar,
 * W6 the wireless controller) must be a SUPERSET of that copy: no model, no mode listing and no token a learner could
 * type in P1 may disappear, and the order of the frozen tokens must be kept, so a new keyword is only ever inserted.
 *
 * The only accepted removals are the ones the migration list (§9) names; `ALLOWED_REMOVALS` is empty because §9 names
 * none. An entry is added here only together with the §9 line that allows it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type HelpGolden = Record<string, Record<string, string[]>>;

function read(name: string): HelpGolden {
  return JSON.parse(readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')) as HelpGolden;
}

const FROZEN = read('cli-help.p1.json');
const CURRENT = read('cli-help.p05.json');

/** Tokens §9 allows a later wave to drop, per model and mode listing. */
const ALLOWED_REMOVALS: readonly { model: string; mode: string; tokens: readonly string[] }[] = [];

function allowedRemovals(model: string, mode: string): readonly string[] {
  return ALLOWED_REMOVALS.find((e) => e.model === model && e.mode === mode)?.tokens ?? [];
}

/** Tokens of `frozen` that `current` does not carry, in frozen order. */
function missing(frozen: readonly string[], current: readonly string[]): string[] {
  return frozen.filter((t) => !current.includes(t));
}

/** True when `frozen` appears inside `current` in the same order (insertions allowed). */
function isSubsequence(frozen: readonly string[], current: readonly string[]): boolean {
  let i = 0;
  for (const t of current) if (i < frozen.length && t === frozen[i]) i++;
  return i === frozen.length;
}

describe('cli help goldens stay a superset of the frozen P1 copy', () => {
  it('the frozen copy carries every P1 model with non-empty listings', () => {
    const models = Object.keys(FROZEN);
    expect(models.length).toBeGreaterThan(0);
    for (const [model, modes] of Object.entries(FROZEN)) {
      expect(Object.keys(modes).length, model).toBeGreaterThan(0);
      for (const [mode, list] of Object.entries(modes)) expect(list.length, `${model} ${mode}`).toBeGreaterThan(0);
    }
  });

  it('every frozen model and mode listing still exists', () => {
    for (const [model, modes] of Object.entries(FROZEN)) {
      expect(Object.keys(CURRENT), `model ${model} disappeared from cli-help.p05.json`).toContain(model);
      for (const mode of Object.keys(modes)) {
        expect(Object.keys(CURRENT[model] ?? {}), `${model} lost its "${mode}" listing`).toContain(mode);
      }
    }
  });

  it('every frozen token is still offered, in the same order', () => {
    for (const [model, modes] of Object.entries(FROZEN)) {
      for (const [mode, frozen] of Object.entries(modes)) {
        const current = CURRENT[model]?.[mode] ?? [];
        const allowed = allowedRemovals(model, mode);
        const kept = frozen.filter((t) => !allowed.includes(t));
        expect(missing(kept, current), `${model} ${mode} lost tokens`).toEqual([]);
        expect(isSubsequence(kept, current), `${model} ${mode} reordered the P1 tokens`).toBe(true);
      }
    }
  });
});
