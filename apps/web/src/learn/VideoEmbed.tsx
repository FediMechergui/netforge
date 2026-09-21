/**
 * learn/VideoEmbed.tsx — the video of a lesson (P2 course layer), played from the no-cookie host.
 *
 * The frame is built from the id alone and the id is checked against the character set the host uses, so a
 * catalogue entry can never steer the URL somewhere else: an id that does not match is not embedded at all and
 * the lesson keeps only the plain link. The player is `loading="lazy"`, so a lesson you scroll past costs
 * nothing, and a lesson with no video renders NOTHING from a third party — `LessonView` simply omits the
 * section rather than mounting an empty player.
 *
 * The caption credits the channel in text (a black rectangle credits nobody) and the link is there for anyone
 * whose browser blocks frames.
 *
 * ponytail: no player API, no autoplay, no start time, no thumbnail preload — one iframe, one caption, one link.
 */
import type { LessonVideo } from '@netforge/engine';

/** The host that serves the player without setting tracking cookies until the learner presses play. */
export const VIDEO_EMBED_HOST = 'https://www.youtube-nocookie.com/embed/';
const WATCH_HOST = 'https://www.youtube.com/watch?v=';

/** Ids are letters, digits, '-' and '_'; anything else is not an id and must never reach a URL. */
const VIDEO_ID = /^[A-Za-z0-9_-]{6,24}$/;
const HTTPS_URL = /^https:\/\/[^\s<>"'`\\]+$/i;

/** The player URL for an id, or null when the id is not one. */
export function videoEmbedUrl(id: string): string | null {
  return VIDEO_ID.test(id) ? `${VIDEO_EMBED_HOST}${id}` : null;
}

/** The page to open in a new tab: the catalogue's own https link, else one built from the id, else nothing. */
export function videoWatchUrl(video: LessonVideo): string | null {
  const url = (video.url ?? '').trim();
  if (HTTPS_URL.test(url)) return url;
  return VIDEO_ID.test(video.youtubeId) ? `${WATCH_HOST}${video.youtubeId}` : null;
}

export function VideoEmbed({ video }: { readonly video: LessonVideo }) {
  const embed = videoEmbedUrl(video.youtubeId);
  const watch = videoWatchUrl(video);
  const credit = (
    <figcaption className="learn-video-caption">
      <span>{video.title}</span>
      <span className="dim"> · from the channel {video.channel}</span>
      {watch !== null && (
        <>
          {' · '}
          <a href={watch} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">
            Open the video in a new tab
          </a>
        </>
      )}
    </figcaption>
  );

  if (embed === null) {
    if (watch === null) return null;
    return (
      <figure className="learn-video">
        <p className="insp-note">This video cannot be played here; the link opens it at the source.</p>
        {credit}
      </figure>
    );
  }

  return (
    <figure className="learn-video">
      <div className="learn-video-frame">
        <iframe
          src={embed}
          title={video.title}
          loading="lazy"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
        />
      </div>
      {credit}
    </figure>
  );
}
