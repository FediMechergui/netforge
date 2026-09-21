/**
 * The videos are only worth having if every one of them can actually be reached: a key that is not a lesson id
 * hides the video forever, an id of the wrong shape cannot be a YouTube id at all, and a url that disagrees with
 * the id sends the "open on YouTube" link somewhere else than the embed.
 *
 * That each id is a live, embeddable video was proved with the oEmbed call written in the header of videos.ts, by
 * hand, before the entries were committed. This file deliberately does not re-run it: a test that needs the
 * network would fail on a train and would make the suite depend on YouTube staying up.
 */
import { describe, expect, it } from 'vitest';
import { lessonsOf } from '../src/contracts/curriculum.js';
import { courseById } from '../src/curriculum/index.js';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { CCNA1_VIDEOS } from '../src/curriculum/ccna1/videos.js';

/** A YouTube video id: eleven characters of the URL-safe alphabet, nothing else. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The same vendor guard the theory files are held to (curriculum.theory-a.test.ts). */
const VENDORS = /\b(?:cisco|ios|packet\s*tracer|netacad|juniper|huawei|mikrotik)\b/i;

const LESSON_IDS = CCNA1_MODULES.flatMap((m) => m.lessons.map((l) => l.id));
const ENTRIES = Object.entries(CCNA1_VIDEOS);

describe('ccna1 videos', () => {
  it('keys every video by a lesson that exists', () => {
    const known = new Set(LESSON_IDS);
    const orphans = ENTRIES.map(([id]) => id).filter((id) => !known.has(id));
    expect(orphans, `video keyed by a lesson that does not exist: ${orphans.join(', ')}`).toEqual([]);
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
      expect(video.url.endsWith(video.youtubeId), `${lessonId} watch url does not end with its id`).toBe(true);
    }
  });

  // The lesson view shows `title` as the caption and hands it to the player as its accessible name, and credits
  // `channel` beside it — so both are product text and the no-vendor rule reaches them. A borrowed title cannot
  // be edited to comply (it is a verbatim oEmbed value, and this file exists to diff it), so a video whose title
  // names a vendor is simply not usable here and the lesson runs theory-only.
  it('puts no vendor name on screen, the rule the theory already follows', () => {
    const named = ENTRIES.filter(([, v]) => VENDORS.test(v.title) || VENDORS.test(v.channel)).map(
      ([lessonId, v]) => `${lessonId} :: ${v.title} :: ${v.channel}`,
    );
    expect(named, `video text naming a vendor:\n${named.join('\n')}`).toEqual([]);
  });

  it('never shows the same video on two lessons', () => {
    const ids = ENTRIES.map(([, video]) => video.youtubeId);
    expect(new Set(ids).size, `a video is used twice: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('covers most of the course, so a lesson keeping its theory alone stays the exception', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(Math.ceil((LESSON_IDS.length * 2) / 3));
    expect(ENTRIES.length).toBeLessThanOrEqual(LESSON_IDS.length);
  });

  it('reaches the assembled course, so the merge key is right', () => {
    const course = courseById('ccna1');
    if (course === undefined) throw new Error('no ccna1 course in COURSES');
    for (const lesson of lessonsOf(course)) {
      const video = CCNA1_VIDEOS[lesson.id];
      if (video === undefined) {
        expect(lesson.video, `${lesson.id} has a video from nowhere`).toBeUndefined();
      } else {
        expect(lesson.video, `${lesson.id} lost its video in the merge`).toEqual(video);
      }
    }
  });
});
