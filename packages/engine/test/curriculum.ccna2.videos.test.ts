/**
 * The CCNA 2 twin of curriculum.videos.test.ts (ARCHITECTURE-P2 §11.3): every video must be reachable — keyed by a
 * CCNA 2 lesson that exists, with an id of YouTube's shape and a watch url that agrees with it — must put no vendor
 * name on screen, and must not repeat a video either course already shows.
 *
 * That each id is a live, embeddable video with no sponsor read was proved by hand with the calls written in the
 * header of ccna2/videos.ts before the entries were written. This file deliberately does not re-run them: a test
 * that needs the network would fail offline and would make the suite depend on YouTube staying up.
 *
 * No minimum coverage is asserted: §11.3 lets a lesson with no verified video run theory-only.
 */
import { describe, expect, it } from 'vitest';
import { lessonsOf } from '../src/contracts/curriculum.js';
import { courseById, withContent } from '../src/curriculum/index.js';
import { CCNA1_VIDEOS } from '../src/curriculum/ccna1/videos.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { CCNA2_VIDEOS } from '../src/curriculum/ccna2/videos.js';

/** A YouTube video id: eleven characters of the URL-safe alphabet, nothing else. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The same vendor guard the CCNA 1 videos and the theory files are held to. */
const VENDORS = /\b(?:cisco|ios|packet\s*tracer|netacad|juniper|huawei|mikrotik)\b/i;

const LESSON_IDS = CCNA2_MODULES.flatMap((m) => m.lessons.map((l) => l.id));
const ENTRIES = Object.entries(CCNA2_VIDEOS);

describe('ccna2 videos', () => {
  it('keys every video by a CCNA 2 lesson that exists', () => {
    const known = new Set(LESSON_IDS);
    const orphans = ENTRIES.map(([id]) => id).filter((id) => !known.has(id));
    expect(orphans, `video keyed by a lesson that does not exist: ${orphans.join(', ')}`).toEqual([]);
    expect(ENTRIES.length).toBeLessThanOrEqual(LESSON_IDS.length);
  });

  it('gives every entry a well-formed id, title and channel', () => {
    for (const [lessonId, video] of ENTRIES) {
      expect(video.youtubeId, `${lessonId} has a malformed video id`).toMatch(YOUTUBE_ID);
      expect(video.title.trim().length, `${lessonId} has no video title`).toBeGreaterThan(0);
      expect(video.channel.trim().length, `${lessonId} has no channel`).toBeGreaterThan(0);
    }
  });

  it('points the watch url at the embedded id', () => {
    for (const [lessonId, video] of ENTRIES) {
      expect(video.url, `${lessonId} watch url disagrees with its id`).toBe(
        `https://www.youtube.com/watch?v=${video.youtubeId}`,
      );
    }
  });

  // `title` is the caption and the player's accessible name, and `channel` is credited beside it, so both are
  // product text. They are verbatim oEmbed values and cannot be edited to comply: a video whose title or channel
  // names a vendor is not usable, and its lesson runs theory-only.
  it('puts no vendor name on screen', () => {
    const named = ENTRIES.filter(([, v]) => VENDORS.test(v.title) || VENDORS.test(v.channel)).map(
      ([lessonId, v]) => `${lessonId} :: ${v.title} :: ${v.channel}`,
    );
    expect(named, `video text naming a vendor:\n${named.join('\n')}`).toEqual([]);
  });

  it('never shows the same video twice, within CCNA 2 or across CCNA 1 and CCNA 2', () => {
    const owners = new Map<string, string[]>();
    for (const [lessonId, video] of [...Object.entries(CCNA1_VIDEOS), ...ENTRIES]) {
      owners.set(video.youtubeId, [...(owners.get(video.youtubeId) ?? []), lessonId]);
    }
    const repeated = [...owners].filter(([, lessons]) => lessons.length > 1).map(([id, l]) => `${id}: ${l.join(', ')}`);
    expect(repeated, `a video is used twice:\n${repeated.join('\n')}`).toEqual([]);
  });

  it('merges onto the skeleton by lesson id', () => {
    const merged = withContent(CCNA2_MODULES, {}, CCNA2_VIDEOS).flatMap((m) => m.lessons);
    expect(merged.map((l) => l.id)).toEqual(LESSON_IDS);
    for (const lesson of merged) {
      expect(lesson.video, `${lesson.id} lost or gained a video in the merge`).toEqual(CCNA2_VIDEOS[lesson.id]);
    }
  });

  // The CCNA 2 skeleton is detached until W7 (§11.3), so today the course has no lessons and this loop is empty.
  // Once it is attached, a lesson whose video went missing in the join fails here.
  it('reaches the assembled course once the skeleton is attached', () => {
    const course = courseById('ccna2');
    if (course === undefined) throw new Error('no ccna2 course in COURSES');
    for (const lesson of lessonsOf(course)) {
      expect(lesson.video, `${lesson.id} does not carry the video recorded for it`).toEqual(CCNA2_VIDEOS[lesson.id]);
    }
  });
});
