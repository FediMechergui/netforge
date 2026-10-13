/**
 * The course context of a new world (ARCHITECTURE-P2 D2, §2.14, §10.2; W2 web-shell): `profileForCourse` picks the
 * classic defaults after a CCNA 1 lesson and the current ones otherwise; `sandboxEntryProfile` rebuilds an EMPTY
 * world only; LearnShell's `enterSandbox` calls the engine with exactly that, and `sandboxEntryCourse` names the
 * course the learner is in. The app-start choice (`startupProfile`) reads the persisted `learn.lastCourse`.
 *
 * P3 W7, the course and profile flip (ARCHITECTURE-P3 D2, §8.5 P15, §9.2 item 41, §10.2): `profileForCourse(id) =
 * courseById(id)?.profile ?? LATEST_DEFAULTS_PROFILE`, now 'P3': CCNA 1 → P1, CCNA 2 → P2, CCNA 3 → P3, no course or an
 * unknown one → P3. The pins of the P2 rule moved exactly as item 41 lists (the no-lesson pin of "app start and File →
 * New" with them: it is the same null case); the last describe block holds the flip's added cases.
 *
 * Pure throughout: the engine client is a recorder, the store a plain object.
 */
import { describe, expect, it, vi } from 'vitest';
import { COURSES, LATEST_DEFAULTS_PROFILE, courseById, lessonsOf } from '@netforge/engine';
import type { Course, DefaultsProfile, Lesson, SimSnapshot } from '@netforge/engine';

const api = vi.hoisted(() => ({ reset: vi.fn(), listScenarios: vi.fn(), loadScenario: vi.fn(), checkLab: vi.fn() }));
vi.mock('../src/bridge/client', () => ({ engine: api, defaultSeed: () => 4242 }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { snapshot: null, learn: { courseId: null, lessonId: null, lastCourse: null } };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import {
  CLASSIC_COURSE_ID,
  CURRENT_DEFAULTS_IN_USE,
  currentDefaultsItem,
  profileForCourse,
  profileOfSnapshot,
  sandboxEntryProfile,
} from '../src/learn/course-profile';
import { classicDefaultsChip } from '../src/app/StatusBar';
import { enterSandbox, sandboxEntryCourse, type SandboxEntryDeps } from '../src/learn/LearnShell';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

const CCNA1 = COURSES[0]!;
const CCNA2 = COURSES.find((c) => c.id === 'ccna2')!;

function world(devices: number, profile?: 'P2' | 'P3'): Pick<SimSnapshot, 'devices' | 'profile'> {
  const list = Array.from({ length: devices }, (_, i) => ({ id: `d${i}` })) as unknown as SimSnapshot['devices'];
  return profile === undefined ? { devices: list } : { devices: list, profile };
}

describe('the profile of the course context (D2)', () => {
  it('is the profile each course names (classic for CCNA 1) and the latest one for no course or an unknown one', () => {
    expect(profileForCourse('ccna1')).toBe('P1');
    expect(profileForCourse('ccna2')).toBe('P2');
    expect(profileForCourse('ccna3')).toBe('P3');
    expect(profileForCourse(null)).toBe('P3');
    expect(profileForCourse(undefined)).toBe('P3');
    expect(profileForCourse('')).toBe('P3');
    expect(profileForCourse('a-course-nobody-wrote')).toBe('P3');
  });

  it('names the first course of the catalogue as the classic one, and no other', () => {
    expect(CLASSIC_COURSE_ID).toBe(CCNA1.id);
    expect(COURSES.filter((c) => profileForCourse(c.id) === 'P1').map((c) => c.id)).toEqual([CCNA1.id]);
    expect(COURSES.length).toBeGreaterThanOrEqual(2);
  });

  it('reads a snapshot profile as written: P2 when present, P1 when absent', () => {
    expect(profileOfSnapshot(world(0, 'P2'))).toBe('P2');
    expect(profileOfSnapshot(world(0))).toBe('P1');
    expect(profileOfSnapshot(null)).toBe('P1');
    expect(profileOfSnapshot(undefined)).toBe('P1');
  });
});

describe('app start and File → New', () => {
  it('take the classic profile after a CCNA 1 lesson, P2 after a CCNA 2 lesson and the latest with no lesson', () => {
    // §10.2: the last lesson opened decides; the store's persisted `learn.lastCourse` is that course.
    const after = (lastCourse: string | null): DefaultsProfile => profileForCourse(lastCourse);
    expect(after(null)).toBe('P3');
    expect(after(CCNA1.id)).toBe('P1');
    expect(after(CCNA2.id)).toBe('P2');
  });

  // `startupProfile` (bridge/client.ts) applies the same rule to the store's persisted `learn.lastCourse`; it is
  // asserted against the real store in worker.profile.test.ts, where the client module is not mocked.
});

describe('entering the sandbox from a lesson (sandboxEntryProfile)', () => {
  it('rebuilds an empty world with the classic profile from a CCNA 1 lesson', () => {
    expect(sandboxEntryProfile({ courseId: CCNA1.id, snapshot: world(0, 'P2') })).toBe('P1');
  });

  it('rebuilds an empty classic world with the current profile from a CCNA 2 lesson', () => {
    expect(sandboxEntryProfile({ courseId: CCNA2.id, snapshot: world(0) })).toBe('P2');
  });

  it('leaves a world with devices placed unchanged, whatever its profile', () => {
    expect(sandboxEntryProfile({ courseId: CCNA1.id, snapshot: world(3, 'P2') })).toBeNull();
    expect(sandboxEntryProfile({ courseId: CCNA2.id, snapshot: world(1) })).toBeNull();
  });

  it('leaves a world whose profile already matches, one without a snapshot, and an entry without a course alone', () => {
    expect(sandboxEntryProfile({ courseId: CCNA1.id, snapshot: world(0) })).toBeNull();
    expect(sandboxEntryProfile({ courseId: CCNA2.id, snapshot: world(0, 'P2') })).toBeNull();
    expect(sandboxEntryProfile({ courseId: CCNA1.id, snapshot: null })).toBeNull();
    expect(sandboxEntryProfile({ courseId: CCNA1.id, snapshot: undefined })).toBeNull();
    expect(sandboxEntryProfile({ courseId: null, snapshot: world(0, 'P2') })).toBeNull();
    expect(sandboxEntryProfile({ courseId: undefined, snapshot: world(0) })).toBeNull();
  });
});

describe("LearnShell's sandbox door", () => {
  const lesson1: Lesson | undefined = lessonsOf(CCNA1)[0];

  it('names the course of the lesson being read, or of the course page, and nothing from the landing page', () => {
    expect(sandboxEntryCourse('lesson', CCNA1, lesson1)).toBe(CCNA1.id);
    expect(sandboxEntryCourse('course', CCNA2, undefined)).toBe(CCNA2.id);
    expect(sandboxEntryCourse('landing', CCNA1, undefined)).toBeNull();
    expect(sandboxEntryCourse('lesson', undefined, undefined)).toBeNull();
    expect(sandboxEntryCourse('lesson', CCNA1, undefined)).toBeNull();
    expect(sandboxEntryCourse('course', undefined, undefined)).toBeNull();
    expect(sandboxEntryCourse('topology', CCNA1, lesson1)).toBeNull();
    expect(sandboxEntryCourse(undefined, CCNA1, lesson1)).toBeNull();
  });

  function deps(snapshot: Pick<SimSnapshot, 'devices' | 'profile'> | null): SandboxEntryDeps & { calls: [number, DefaultsProfile][] } {
    const calls: [number, DefaultsProfile][] = [];
    return {
      calls,
      snapshot: () => snapshot,
      seed: () => 99,
      reset: async (seed, profile) => {
        calls.push([seed, profile]);
      },
    };
  }

  it('resets an empty current-defaults world to the classic profile when coming from a CCNA 1 lesson', async () => {
    const d = deps(world(0, 'P2'));
    await expect(enterSandbox(CCNA1.id, d)).resolves.toBe('P1');
    expect(d.calls).toEqual([[99, 'P1']]);
  });

  it('resets an empty classic world to the current profile when coming from a CCNA 2 lesson', async () => {
    const d = deps(world(0));
    await expect(enterSandbox(CCNA2.id, d)).resolves.toBe('P2');
    expect(d.calls).toEqual([[99, 'P2']]);
  });

  it('never touches a world with devices placed, a matching world, or an entry without a course', async () => {
    for (const [courseId, snap] of [
      [CCNA1.id, world(2, 'P2')],
      [CCNA1.id, world(0)],
      [null, world(0, 'P2')],
      [CCNA1.id, null],
    ] as const) {
      const d = deps(snap);
      await expect(enterSandbox(courseId, d)).resolves.toBeNull();
      expect(d.calls).toEqual([]);
    }
  });

  it('by default reads the store snapshot, takes a fresh seed and calls the engine reset with the profile', async () => {
    api.reset.mockReset();
    api.reset.mockResolvedValue(world(0));
    setState({ snapshot: world(0, 'P2') });
    await expect(enterSandbox(CCNA1.id)).resolves.toBe('P1');
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(api.reset).toHaveBeenCalledWith(4242, 'P1');

    // A world with devices: the engine is not asked anything.
    api.reset.mockReset();
    setState({ snapshot: world(1, 'P2') });
    await expect(enterSandbox(CCNA1.id)).resolves.toBeNull();
    expect(api.reset).not.toHaveBeenCalled();
    setState({ snapshot: null });
  });

  it('lets an engine refusal through to the caller (the shell then opens the sandbox as it was)', async () => {
    const failing: SandboxEntryDeps = { snapshot: () => world(0, 'P2'), seed: () => 1, reset: async () => Promise.reject(new Error('busy')) };
    await expect(enterSandbox(CCNA1.id, failing)).rejects.toThrow('busy');
  });

  it('covers every course of the catalogue with a profile', () => {
    for (const c of COURSES as readonly Course[]) expect(['P1', 'P2', 'P3']).toContain(profileForCourse(c.id));
  });
});

/**
 * P3 W7, the course and profile flip (ARCHITECTURE-P3 D2, §7 W7 web-shell, §8.5 P11 and P15, §10.2): the profile is
 * read from the course, and the defaults a world with no course takes are the latest, 'P3'.
 */
describe('the course and profile flip (P3 W7)', () => {
  const CCNA3 = courseById('ccna3') as Course;

  it('makes P3 the latest defaults, and reads every course of the catalogue from its own profile', () => {
    expect(LATEST_DEFAULTS_PROFILE).toBe('P3');
    for (const c of COURSES as readonly Course[]) expect(profileForCourse(c.id), c.id).toBe(c.profile ?? LATEST_DEFAULTS_PROFILE);
    expect(COURSES.map((c) => [c.id, profileForCourse(c.id)])).toEqual([
      ['ccna1', 'P1'],
      ['ccna2', 'P2'],
      ['ccna3', 'P3'],
      ['security', 'P3'],
    ]);
  });

  it('opens a CCNA 3 lesson world with the P3 defaults, and leaves a placed P2 world alone', () => {
    expect(CCNA3.status).toBe('available');
    expect(sandboxEntryProfile({ courseId: CCNA3.id, snapshot: world(0, 'P2') })).toBe('P3');
    expect(sandboxEntryProfile({ courseId: CCNA3.id, snapshot: world(0) })).toBe('P3');
    expect(sandboxEntryProfile({ courseId: CCNA3.id, snapshot: world(0, 'P3') })).toBeNull();
    expect(sandboxEntryProfile({ courseId: CCNA3.id, snapshot: world(2, 'P2') })).toBeNull();
    // a CCNA 2 lesson still rebuilds an empty P3 world with the P2 defaults its text is written against
    expect(sandboxEntryProfile({ courseId: CCNA2.id, snapshot: world(0, 'P3') })).toBe('P2');
  });

  it('resets an empty P2 world to P3 when the sandbox is entered from a CCNA 3 lesson', async () => {
    const calls: [number, DefaultsProfile][] = [];
    const d: SandboxEntryDeps = {
      snapshot: () => world(0, 'P2'),
      seed: () => 5,
      reset: async (seed, profile) => {
        calls.push([seed, profile]);
      },
    };
    await expect(enterSandbox(CCNA3.id, d)).resolves.toBe('P3');
    expect(calls).toEqual([[5, 'P3']]);
  });

  // W7 fix (review finding #3): Simulate → "Reset with a new seed" builds an empty world like File → New, so it takes
  // the course context's profile too (D2, §8.5 P15); it used to pass none, which the worker reads as the classic P1.
  it('builds the "Reset with a new seed" world with the course context profile, as File → New does', async () => {
    const { resetWithNewSeed } = await import('../src/app/TopBar');
    const toast = vi.fn();
    setState({ select: vi.fn(), toast });
    try {
      for (const [lastCourse, profile] of [
        [null, 'P3'],
        ['ccna1', 'P1'],
        ['ccna2', 'P2'],
        ['ccna3', 'P3'],
      ] as const) {
        api.reset.mockReset();
        api.reset.mockResolvedValue(world(0, 'P3'));
        setState({ learn: { courseId: null, lessonId: null, lastCourse } });
        await resetWithNewSeed();
        expect(api.reset, String(lastCourse)).toHaveBeenCalledTimes(1);
        expect(api.reset, String(lastCourse)).toHaveBeenCalledWith(4242, profile);
      }
      expect(toast).not.toHaveBeenCalledWith(expect.anything(), 'error');
    } finally {
      setState({ learn: { courseId: null, lessonId: null, lastCourse: null }, select: undefined, toast: undefined });
    }
  });

  it('keeps a P2 file a P2 world with "Use current defaults" offered, and a template a classic world with its chip', () => {
    // a saved P2 file: no chip, the move to P3 enabled
    expect(classicDefaultsChip({ profile: 'P2' } as SimSnapshot)).toBeNull();
    expect(currentDefaultsItem(profileOfSnapshot(world(3, 'P2'))).enabled).toBe(true);
    // a P1 template: the "Classic defaults" chip, the move enabled too
    expect(classicDefaultsChip({} as SimSnapshot)?.label).toBe('Classic defaults');
    expect(currentDefaultsItem(profileOfSnapshot(world(3))).enabled).toBe(true);
    // a P3 world already has the current defaults
    expect(classicDefaultsChip({ profile: 'P3' } as SimSnapshot)).toBeNull();
    expect(currentDefaultsItem(profileOfSnapshot(world(3, 'P3')))).toEqual({ enabled: false, hint: CURRENT_DEFAULTS_IN_USE });
  });
});
