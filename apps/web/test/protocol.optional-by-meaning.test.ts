/**
 * Web contract members that keep their `?` after the P2 exit gate (ARCHITECTURE-P2 §0 rule 2, §2.15 row "web
 * protocol.ts", §7 W8), and the ones the gate made required.
 *
 * Optional by meaning: `EngineApi.init` / `EngineApi.reset` without `profile` build a P1-profile world (the default,
 * D2), and an `EngineBatch` without `review` / `timelineHead` is a live batch that leaves the timeline as it was. The
 * store's `LabUiState.checking` is optional by meaning too (§9.2 item 25a: absent = no check running). Required since
 * W8: the five time-travel methods of `EngineApi` (the worker implements them since W4/W6) and `UiState.timeline`.
 *
 * Two halves. The type-level constants below compile only while each member keeps (or lacks) its `?` — apps/web's
 * tsconfig covers src/ only, so they are checked when this file is type-checked on its own. The runtime half calls the
 * members without the optional part and reads the declarations from the source, so the `?` and the
 * `@since P2 (optional by meaning)` tag are pinned on every test run as well.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DefaultsProfile, SimSnapshot } from '@netforge/engine';
import type { EngineApi, EngineBatch, InitResult } from '../src/bridge/protocol';
import { defaultTimelineUi, store } from '../src/store/store';
import type { LabUiState, UiState } from '../src/store/types';

// ── type-level half ──────────────────────────────────────────────────────────

/** True when `K` may be left out of `T`. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
type InitOptions = Parameters<EngineApi['init']>[0];

// optional by meaning (§2.15): each line stops compiling if the member loses its `?`
const INIT_PROFILE_OPTIONAL: IsOptional<InitOptions, 'profile'> = true;
const RESET_PROFILE_OPTIONAL: [seed: number] extends Parameters<EngineApi['reset']> ? true : false = true;
const REVIEW_OPTIONAL: IsOptional<EngineBatch, 'review'> = true;
const TIMELINE_HEAD_OPTIONAL: IsOptional<EngineBatch, 'timelineHead'> = true;
const CHECKING_OPTIONAL: IsOptional<LabUiState, 'checking'> = true;

// required since the W8 exit gate: each line stops compiling if the member regains a `?`
const SEEK_REQUIRED: IsOptional<EngineApi, 'seek'> = false;
const LEAVE_REVIEW_REQUIRED: IsOptional<EngineApi, 'leaveReview'> = false;
const TIMELINE_BUCKETS_REQUIRED: IsOptional<EngineApi, 'timelineBuckets'> = false;
const TIMELINE_MARKS_REQUIRED: IsOptional<EngineApi, 'timelineMarks'> = false;
const BUDGET_REQUIRED: IsOptional<EngineApi, 'setTimeTravelBudget'> = false;
const TIMELINE_SLICE_REQUIRED: IsOptional<UiState, 'timeline'> = false;

/** Both calls type-check without `profile`. */
async function callWithoutProfile(api: Pick<EngineApi, 'init' | 'reset'>): Promise<void> {
  await api.init({ seed: 7 });
  await api.reset(9);
}

/** A batch with neither `review` nor `timelineHead` type-checks. */
const LIVE_BATCH: EngineBatch = { epoch: 1, now: 0, events: [], playing: false, rate: 1, effectiveRate: 1_000_000, dropped: 0 };

// ── the source ───────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = readFileSync(join(HERE, '..', 'src', 'bridge', 'protocol.ts'), 'utf8');
const TYPES = readFileSync(join(HERE, '..', 'src', 'store', 'types.ts'), 'utf8');
const TAG = '@since P2 (optional by meaning)';

/** The declaration line of `name` inside `export interface <iface> {…}`, and the JSDoc block right above it. */
function declaration(source: string, iface: string, name: string): { line: string; doc: string } {
  const open = source.indexOf(`export interface ${iface} {`);
  expect(open, `interface ${iface}`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(open, source.indexOf('\n}', open)).split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*${name}\\??[(:]`).test(l));
  expect(at, `${iface}.${name}`).toBeGreaterThan(0);
  let first = at;
  if (lines[at - 1]?.trim().endsWith('*/')) {
    first = at - 1;
    while (first > 0 && !lines[first]!.trim().startsWith('/**')) first--;
  }
  return { line: lines[at]!, doc: lines.slice(first, at).join('\n') };
}

// ── runtime half ─────────────────────────────────────────────────────────────

describe('web members that stay optional (optional by meaning, §2.15)', () => {
  it('the type-level checks hold', () => {
    expect([INIT_PROFILE_OPTIONAL, RESET_PROFILE_OPTIONAL, REVIEW_OPTIONAL, TIMELINE_HEAD_OPTIONAL, CHECKING_OPTIONAL]).toEqual([true, true, true, true, true]);
  });

  it('EngineApi.init and EngineApi.reset are called without a profile', async () => {
    const init = vi.fn(async (_opts: InitOptions): Promise<InitResult> => ({ catalog: [], modules: [], media: [], engineVersion: 'test' }));
    const reset = vi.fn(async (_seed: number, _profile?: DefaultsProfile) => ({}) as SimSnapshot);
    await callWithoutProfile({ init, reset });
    expect(init).toHaveBeenCalledWith({ seed: 7 });
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('profile');
    expect(reset.mock.calls).toEqual([[9]]);
  });

  it('an EngineBatch without review and timelineHead is a live batch that leaves the timeline head alone', () => {
    expect(Object.keys(LIVE_BATCH)).not.toContain('review');
    expect(Object.keys(LIVE_BATCH)).not.toContain('timelineHead');
    const head = { t: 5, at: { dispatched: 3, now: 5 }, lanesRevision: 2 };
    store.getState().applyBatch({ ...LIVE_BATCH, timelineHead: head });
    store.getState().applyBatch({ ...LIVE_BATCH, now: 6 });
    expect(store.getState().timeline.head).toEqual(head);
    expect(store.getState().timeline.review).toBeNull();
    expect(store.getState().timeline.reviewEvents).toEqual([]);
  });

  it.each([
    ['EngineApi', 'init', /\bprofile\?: DefaultsProfile\b/],
    ['EngineApi', 'reset', /\bprofile\?: DefaultsProfile\b/],
    ['EngineBatch', 'review', /^\s*review\?: /],
    ['EngineBatch', 'timelineHead', /^\s*timelineHead\?: /],
  ] as const)('%s.%s keeps its ? and its JSDoc says "optional by meaning"', (iface, name, optional) => {
    const { line, doc } = declaration(PROTOCOL, iface, name);
    expect(line).toMatch(optional);
    expect(doc).toContain(TAG);
  });

  it('LabUiState.checking keeps its ? and its JSDoc says "optional by meaning" (§9.2 item 25a)', () => {
    const { line, doc } = declaration(TYPES, 'LabUiState', 'checking');
    expect(line).toMatch(/^\s*checking\?: boolean;/);
    expect(doc).toContain(TAG);
  });
});

describe('web members the W8 exit gate made required', () => {
  it('the type-level checks hold', () => {
    expect([SEEK_REQUIRED, LEAVE_REVIEW_REQUIRED, TIMELINE_BUCKETS_REQUIRED, TIMELINE_MARKS_REQUIRED, BUDGET_REQUIRED, TIMELINE_SLICE_REQUIRED]).toEqual([false, false, false, false, false, false]);
  });

  it.each(['seek', 'leaveReview', 'timelineBuckets', 'timelineMarks', 'setTimeTravelBudget'])('EngineApi.%s has no ?', (name) => {
    const { line } = declaration(PROTOCOL, 'EngineApi', name);
    expect(line).toMatch(new RegExp(`^\\s*${name}\\(`));
  });

  it('UiState.timeline has no ? and the store holds the slice', () => {
    expect(declaration(TYPES, 'UiState', 'timeline').line).toMatch(/^\s*timeline: TimelineUiState;/);
    expect(Object.keys(store.getState())).toContain('timeline');
    expect(defaultTimelineUi()).toEqual({ review: null, head: null, lanes: expect.any(Array), seeking: false, reviewEvents: [] });
  });
});
