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
 * P3 (ARCHITECTURE-P3 D2, §6, §7 W1 web-shell): a snapshot may say 'P3' (`profileOfSnapshot`); File → "Use current
 * defaults" is offered whenever the world's profile is below `LATEST_DEFAULTS_PROFILE` (still 'P2' until the W7 course
 * flip, so for P1 worlds only, as before), and its hint lists what the move switches on from the `PROFILE_NOTES` data
 * record (`currentDefaultsItem`). `profileForCourse` keeps its P2 rule until the course flip (D2, §9.2 item 41).
 *
 * Pure: no store, no engine call. The store keeps `learn.lastCourse` (persisted) and hands it in. Engine constants are
 * read at call time (§0 rule 12).
 */
import { DEFAULTS_PROFILES, LATEST_DEFAULTS_PROFILE } from '@netforge/engine';
import type { DefaultsProfile, SimSnapshot } from '@netforge/engine';

/** The one course whose lessons open worlds with the classic defaults (the CCNA 1 course id, `COURSES[0].id`). */
export const CLASSIC_COURSE_ID = 'ccna1';

/** The profile a new world takes from the course context: 'P1' for CCNA 1, 'P2' for any other course or none. */
export function profileForCourse(courseId: string | null | undefined): DefaultsProfile {
  return courseId === CLASSIC_COURSE_ID ? 'P1' : 'P2';
}

/** The profile a snapshot reports ('P2' and 'P3' are written, 'P1' is the absent default). */
export function profileOfSnapshot(snapshot: Pick<SimSnapshot, 'profile'> | null | undefined): DefaultsProfile {
  const p = snapshot?.profile;
  return p === 'P2' || p === 'P3' ? p : 'P1';
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

// ── "Use current defaults" (P3 W1) ───────────────────────────────────────────

/**
 * @since P3 What each profile's defaults switch on over the one before it (ARCHITECTURE-P2 D2, ARCHITECTURE-P3 D2), in
 * original words, as short phrases the File menu's hint and the move's toast list. 'P1' is the base: it adds nothing.
 * 'P3' lists the MUST default (CDP) and the defaults of the approved [S24] and [S25] items; no hint shows it before the
 * W7 flip makes 'P3' the latest profile.
 */
export const PROFILE_NOTES: Readonly<Record<DefaultsProfile, readonly string[]>> = Object.freeze({
  P1: Object.freeze([]),
  P2: Object.freeze(['spanning tree on the switches', 'proxy ARP on router interfaces', 'controller discovery on lightweight access points']),
  P3: Object.freeze([
    'CDP on routers, managed switches and the wireless controller',
    'timestamps on log and debug messages',
    'logs of interface, restart and configuration changes, shown on the console',
  ]),
});

/** True when `profile` comes before `latest` (the newest profile a world is moved to). */
export function isBelowLatest(profile: DefaultsProfile, latest: DefaultsProfile = LATEST_DEFAULTS_PROFILE): boolean {
  return DEFAULTS_PROFILES.indexOf(profile) < DEFAULTS_PROFILES.indexOf(latest);
}

/** The notes of every profile after `from`, up to and including `to`, in profile order. */
export function profileNotesBetween(from: DefaultsProfile, to: DefaultsProfile = LATEST_DEFAULTS_PROFILE): string[] {
  const lo = DEFAULTS_PROFILES.indexOf(from);
  const hi = DEFAULTS_PROFILES.indexOf(to);
  const out: string[] = [];
  for (const p of DEFAULTS_PROFILES.slice(lo + 1, hi + 1)) out.push(...PROFILE_NOTES[p]);
  return out;
}

/** The File menu's "Use current defaults" entry for a world of this profile. */
export interface CurrentDefaultsItem {
  readonly enabled: boolean;
  /** The entry's second line. */
  readonly hint: string;
}

/** The hint when the world already has the latest defaults. */
export const CURRENT_DEFAULTS_IN_USE = 'Already in use in this world.';
/** The hint when the world has defaults newer than the latest this build moves worlds to (a later build's file). */
export const CURRENT_DEFAULTS_NEWER = 'This world already has newer defaults.';

/**
 * "Use current defaults" for a world of `profile`: enabled whenever the profile is below `latest`, with a hint that
 * lists what the move switches on (`PROFILE_NOTES`); disabled with a reason otherwise.
 */
export function currentDefaultsItem(profile: DefaultsProfile, latest: DefaultsProfile = LATEST_DEFAULTS_PROFILE): CurrentDefaultsItem {
  if (!isBelowLatest(profile, latest)) return { enabled: false, hint: profile === latest ? CURRENT_DEFAULTS_IN_USE : CURRENT_DEFAULTS_NEWER };
  const notes = profileNotesBetween(profile, latest);
  return { enabled: true, hint: notes.length === 0 ? 'Keeps every device and setting.' : `Keeps every device and setting. Adds: ${notes.join('; ')}.` };
}

/** The toast after the move from `before` to `after` (`devices` kept their configuration). */
export function currentDefaultsToast(devices: number, before: DefaultsProfile, after: DefaultsProfile): string {
  const kept = `Current defaults in use: ${devices} ${devices === 1 ? 'device' : 'devices'} kept ${devices === 1 ? 'its' : 'their'} configuration.`;
  const notes = profileNotesBetween(before, after);
  return notes.length === 0 ? kept : `${kept} Added: ${notes.join('; ')}.`;
}
