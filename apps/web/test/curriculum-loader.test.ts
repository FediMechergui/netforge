/**
 * The lazy course catalogue (ARCHITECTURE-P3C §7 W0h, the bundle split): src/curriculum-loader.ts loads
 * `@netforge/engine/curriculum` once and keeps it; `profileForCourse` reads it synchronously and refuses to guess before
 * it is loaded; `courseProfile` loads it first. The setup file preloads the catalogue for every test file, so this one
 * starts from a fresh module graph (`vi.resetModules`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COURSES, LATEST_DEFAULTS_PROFILE } from '@netforge/engine';

type Loader = typeof import('../src/curriculum-loader');
type Profiles = typeof import('../src/learn/course-profile');

let loader: Loader;
let profiles: Profiles;

beforeEach(async () => {
  vi.resetModules();
  loader = await import('../src/curriculum-loader');
  profiles = await import('../src/learn/course-profile');
});

describe('curriculum-loader (W0h)', () => {
  it('holds nothing until asked', () => {
    expect(loader.loadedCurriculum()).toBeUndefined();
  });

  it('a course id needs the catalogue: the synchronous lookup refuses before the load, the async one loads it', async () => {
    expect(profiles.profileForCourse(null)).toBe(LATEST_DEFAULTS_PROFILE);
    expect(profiles.profileForCourse(undefined)).toBe(LATEST_DEFAULTS_PROFILE);
    expect(() => profiles.profileForCourse('ccna1')).toThrow(/not loaded/);
    expect(await profiles.courseProfile(null)).toBe(LATEST_DEFAULTS_PROFILE);
    expect(loader.loadedCurriculum()).toBeUndefined();
    expect(await profiles.courseProfile('ccna1')).toBe('P1');
    expect(profiles.profileForCourse('ccna2')).toBe('P2');
    expect(profiles.profileForCourse('ccna3')).toBe('P3');
    expect(profiles.profileForCourse('no-such-course')).toBe(LATEST_DEFAULTS_PROFILE);
  });

  it('loads once and hands out the same module; it is the catalogue the full entry exports', async () => {
    const [a, b] = await Promise.all([loader.loadCurriculum(), loader.loadCurriculum()]);
    expect(a).toBe(b);
    expect(loader.loadedCurriculum()).toBe(a);
    expect(await loader.loadCurriculum()).toBe(a);
    expect(a.COURSES.map((c) => [c.id, c.profile])).toEqual(COURSES.map((c) => [c.id, c.profile]));
    expect(a.courseById('ccna3')?.title).toBe(COURSES.find((c) => c.id === 'ccna3')?.title);
  });
});
