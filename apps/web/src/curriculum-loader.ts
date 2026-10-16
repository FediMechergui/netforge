/**
 * curriculum-loader.ts — the course catalogue, loaded on demand (ARCHITECTURE-P3C §6, §7 W0h, the bundle split).
 *
 * The catalogue (`COURSES` with every lesson's theory text) is a chunk of its own, never part of the main chunk. It is
 * fetched the first time something needs it: the learn surfaces (App mounts `LearnShell` lazily, after `loadCurriculum`),
 * the app-start world when the restored `learn.lastCourse` names a course (bridge/client.ts `initEngine`), and File →
 * New after a lesson (learn/course-profile.ts `courseProfile`). Once loaded it is kept, and `loadedCurriculum()` hands it
 * out synchronously; the synchronous course lookups (`profileForCourse`) read it from there.
 *
 * A failed fetch (offline, a deploy that replaced the chunk) is not cached, so the next call tries again.
 */
export type Curriculum = typeof import('@netforge/engine/curriculum');

let loaded: Curriculum | undefined;
let pending: Promise<Curriculum> | undefined;

/** Load the course catalogue once; every caller shares the same promise and the same module. */
export function loadCurriculum(): Promise<Curriculum> {
  if (loaded !== undefined) return Promise.resolve(loaded);
  pending ??= import('@netforge/engine/curriculum').then(
    (m) => {
      loaded = m;
      return m;
    },
    (err: unknown) => {
      pending = undefined;
      throw err;
    },
  );
  return pending;
}

/** The catalogue when it has been loaded, else undefined. */
export function loadedCurriculum(): Curriculum | undefined {
  return loaded;
}
