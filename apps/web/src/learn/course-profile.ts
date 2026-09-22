/**
 * learn/course-profile.ts — the course context of a new world (ARCHITECTURE-P2 D2, §2.14; W2 web-shell).
 *
 * A world made by the web app (`EngineApi.init` at app start, `reset` for File → New) takes the profile of the course
 * the learner is in: the classic ('P1') defaults when the lesson they last opened belongs to CCNA 1, the current
 * ('P2') defaults otherwise — a CCNA 2 lesson, or no lesson yet. So a CCNA 1 lesson that says "drag two PCs and a
 * switch and ping" still pings at once, and its text never changes.
 *
 * Entering the sandbox from a lesson while the world holds no device re-initialises it with that lesson's profile;
 * a world with devices in it is never touched (`sandboxEntryProfile`).
 *
 * Pure: no store, no engine call. The store keeps `learn.lastCourse` (persisted) and hands it in.
 */
import type { DefaultsProfile, SimSnapshot } from '@netforge/engine';

/** The one course whose lessons open worlds with the classic defaults (the CCNA 1 course id, `COURSES[0].id`). */
export const CLASSIC_COURSE_ID = 'ccna1';

/** The profile a new world takes from the course context: 'P1' for CCNA 1, 'P2' for any other course or none. */
export function profileForCourse(courseId: string | null | undefined): DefaultsProfile {
  return courseId === CLASSIC_COURSE_ID ? 'P1' : 'P2';
}

/** The profile a snapshot reports ('P2' is written, 'P1' is the absent default). */
export function profileOfSnapshot(snapshot: Pick<SimSnapshot, 'profile'> | null | undefined): DefaultsProfile {
  return snapshot?.profile === 'P2' ? 'P2' : 'P1';
}

export interface SandboxEntry {
  /** The course of the lesson the sandbox is entered from; null when not coming from a lesson. */
  readonly courseId: string | null | undefined;
  /** The world as the store mirrors it; null before the first snapshot. */
  readonly snapshot: Pick<SimSnapshot, 'devices' | 'profile'> | null | undefined;
}

/**
 * The profile to re-initialise the world with when the sandbox is entered from a lesson, or null when the world is
 * left alone: not coming from a lesson, no snapshot yet, devices already placed, or the profile already right.
 */
export function sandboxEntryProfile(entry: SandboxEntry): DefaultsProfile | null {
  if (entry.courseId === null || entry.courseId === undefined) return null;
  const snapshot = entry.snapshot;
  if (snapshot === null || snapshot === undefined) return null;
  if (snapshot.devices.length > 0) return null;
  const wanted = profileForCourse(entry.courseId);
  return profileOfSnapshot(snapshot) === wanted ? null : wanted;
}
