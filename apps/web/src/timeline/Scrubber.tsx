/**
 * timeline/Scrubber.tsx — the position slider of the timeline strip [SHOULD S1] (ARCHITECTURE-P2 §3.13 steps 3–4, §6).
 *
 * One `role="slider"` track spanning the strip's window. Dragging it (pointer capture: every move while the button is
 * held) or pressing a key turns into a `ScrubAction` through timeline-client (`scrubAction`, `keyAction`), which the
 * strip hands to its seek queue — so a drag sends one seek per completed seek, never one per pixel. Reaching the live
 * edge, or End, is "return to now". Escape is handled one level up, by the strip (`handleStripKey`), so it works from
 * any control of the strip.
 *
 * Hook-free on purpose: the strip owns every piece of state (the window, the handle's preview while a seek is in
 * flight, the disabled reason), so the component is a plain function of its props and the tests call it directly.
 *
 * Accessibility: the slider's value spans the whole run in milliseconds (Home = the start, End = now), its value
 * text says where the handle is and how far behind now; every visual on the track (ticks, the played part, the part
 * not shown yet in review, the "now" edge) is `aria-hidden` because the value text and the strip's banner say the same
 * in words. Positions are percentages of the track, so nothing is measured to draw.
 */
import type { KeyboardEvent, PointerEvent, Ref } from 'react';
import { formatSimTime } from '@netforge/engine';
import type { SimTime } from '@netforge/engine';
import type { ReviewInfo } from '../bridge/protocol';
import { formatDurationNs } from '../vocab/fields';
import {
  cursorTime,
  isReviewing,
  isTimelineKey,
  keyAction,
  scrubAction,
  timeToX,
  timelineTicks,
  type ScrubAction,
  type TimelineWindow,
} from './timeline-client';

const MS = 1_000_000;

/** Keys the slider answers (Escape comes from the strip). */
export const SCRUBBER_KEYS = 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End Escape';

/** How the keys work, in words (the slider's description while it is usable). */
export const SCRUBBER_HINT =
  'Arrow keys step through time (a bigger step with Shift), Page Up and Page Down jump half the view, Home goes to the start, End or Escape return to now.';

export interface ScrubberProps {
  /** The stretch of sim time the track shows. */
  window: TimelineWindow;
  /** The live head (the right end of the run). */
  headT: SimTime;
  /** The reviewed instant, or null while the canvas shows the live world. */
  review: ReviewInfo | null;
  /** A seek asked for and not landed yet: the handle shows it at once. */
  previewT: SimTime | null;
  /** Track width in pixels (tick density only; positions are percentages). */
  widthPx: number;
  /** Nothing can be sought (no timeline yet, or history is off). */
  disabled: boolean;
  /** Id of the text that explains the slider (the keys, or why it is disabled). */
  describedBy?: string;
  /** The track element, measured by the strip for its bucket queries. */
  trackRef?: Ref<HTMLDivElement>;
  onAction(action: ScrubAction): void;
}

/**
 * The review the actions start from: the store's, or — while a seek is still in flight — one at the preview time, so a
 * held arrow key or a drag moves on from where the handle already is instead of re-asking for the same instant.
 */
export function effectiveReview(review: ReviewInfo | null, previewT: SimTime | null, headT: SimTime): ReviewInfo | null {
  if (previewT === null) return review;
  const live = review?.live ?? { dispatched: 0, now: headT };
  return { at: review?.at ?? live, t: previewT, live, atLive: false };
}

/** Where the handle sits: the preview, the reviewed instant, or the live head. */
export function handleTime(review: ReviewInfo | null, previewT: SimTime | null, headT: SimTime): SimTime {
  return previewT ?? cursorTime(review, headT);
}

/** The slider's value text: where the handle is, in words. */
export function scrubberValueText(t: SimTime, headT: SimTime, past: boolean): string {
  if (!past) return `${formatSimTime(t)}, now (live)`;
  return `${formatSimTime(t)}, ${formatDurationNs(Math.max(0, headT - t))} before now`;
}

const pct = (t: SimTime, w: TimelineWindow): string => `${timeToX(t, w, 100).toFixed(3)}%`;

/** The time under a pointer event on the track. */
function pointerAction(
  e: PointerEvent<HTMLDivElement>,
  p: Pick<ScrubberProps, 'window' | 'headT'>,
  review: ReviewInfo | null,
): ScrubAction {
  const rect = e.currentTarget.getBoundingClientRect();
  return scrubAction(e.clientX - rect.left, p.window, rect.width, p.headT, review);
}

export function Scrubber(props: ScrubberProps) {
  const { window: w, headT, review, previewT, widthPx, disabled, describedBy, trackRef, onAction } = props;
  const eff = effectiveReview(review, previewT, headT);
  const past = isReviewing(eff);
  const at = handleTime(review, previewT, headT);
  const ticks = timelineTicks(w, Math.max(1, widthPx));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus?.();
    onAction(pointerAction(e, props, eff));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    // only a drag: the button went down on the track, which captured the pointer
    if (disabled || e.currentTarget.hasPointerCapture?.(e.pointerId) !== true) return;
    onAction(pointerAction(e, props, eff));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId) === true) e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || !isTimelineKey(e.key)) return;
    e.preventDefault();
    if (disabled) return;
    onAction(keyAction(e.key, { window: w, headT, review: eff, shift: e.shiftKey }));
  };

  return (
    <div className="tl-row tl-scrub-row">
      <span className="tl-row-label" aria-hidden="true">
        {past ? 'Viewing' : 'Now'}
      </span>
      <div
        ref={trackRef}
        className={`tl-track${past ? ' is-past' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Timeline position"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(headT / MS))}
        aria-valuenow={Math.max(0, Math.min(Math.round(at / MS), Math.round(headT / MS)))}
        aria-valuetext={scrubberValueText(at, headT, past)}
        aria-disabled={disabled ? 'true' : undefined}
        aria-describedby={describedBy}
        aria-keyshortcuts={SCRUBBER_KEYS}
        title={disabled ? undefined : SCRUBBER_HINT}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="tl-played" style={{ width: pct(at, w) }} aria-hidden="true" />
        {past && <div className="tl-ahead" style={{ left: pct(at, w), right: `calc(100% - ${pct(headT, w)})` }} aria-hidden="true" />}
        {ticks.map((tick) => (
          <span key={tick.t} className="tl-tick" style={{ left: pct(tick.t, w) }} aria-hidden="true">
            <span className="tl-tick-label">{tick.label}</span>
          </span>
        ))}
        <span className="tl-now" style={{ left: pct(headT, w) }} aria-hidden="true">
          <span className="tl-now-label">now</span>
        </span>
        <span className={`tl-handle${past ? ' is-past' : ''}`} style={{ left: pct(at, w) }} aria-hidden="true" />
      </div>
    </div>
  );
}
