/**
 * Play / pause / step / rate controls plus the simulated clock (spec §8.1 top bar).
 * The clock is extrapolated between batches with `effectiveRate` so it ticks
 * smoothly; a "slow-motion ×N" chip appears while the clock policy clamps the
 * rate below the requested one.
 */
import { useEffect, useState } from 'react';
import { MS } from '@netforge/engine';
import { engine, fmtSimTime } from '../bridge/client';
import { RATE_PRESETS } from '../bridge/protocol';
import { extrapolatedNow } from '../store/selectors';
import { store, useStore } from '../store/store';

export function reportError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  store.getState().toast(msg, 'error');
}

export async function togglePlay(): Promise<void> {
  const { playing, ready } = store.getState();
  if (!ready) return;
  try {
    if (playing) await engine.pause();
    else await engine.play();
  } catch (err) {
    reportError(err);
  }
}

export async function stepEvent(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    await engine.stepEvent();
  } catch (err) {
    reportError(err);
  }
}

export async function stepOneMs(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    await engine.stepTime(1 * MS);
  } catch (err) {
    reportError(err);
  }
}

export async function runToIdle(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    const snap = await engine.runToIdle(200_000);
    if (snap.pendingEvents > 0) {
      store.getState().toast('Stopped after 200 000 events; the queue is still busy.', 'warn');
    }
  } catch (err) {
    reportError(err);
  }
}

function fmtRate(r: number): string {
  if (r >= 1) return `${r}×`;
  return `${r}×`.replace(/^0\./, '.');
}

function useSimClock(): number {
  const [t, setT] = useState(() => store.getState().now);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = (): void => {
      const s = store.getState();
      const now = s.playing ? extrapolatedNow(s, performance.now()) : s.now;
      if (now !== last) {
        last = now;
        setT(now);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

export function PlaybackControls() {
  const playing = useStore((s) => s.playing);
  const rate = useStore((s) => s.rate);
  const effectiveRate = useStore((s) => s.effectiveRate);
  const ready = useStore((s) => s.ready);
  const pending = useStore((s) => s.snapshot?.pendingEvents ?? 0);
  const now = useSimClock();

  const slowFactor = playing && effectiveRate > 0 ? (rate * MS) / effectiveRate : 1;
  const slow = playing && slowFactor >= 1.05;

  return (
    <div className="playback" role="group" aria-label="Playback">
      <button
        type="button"
        className={`btn btn-icon ${playing ? 'is-active' : 'btn-primary'}`}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={!ready}
        onClick={() => void togglePlay()}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        type="button"
        className="btn btn-icon"
        title="Step one event ( . )"
        aria-label="Step one event"
        disabled={!ready || pending === 0}
        onClick={() => void stepEvent()}
      >
        ⏭
      </button>
      <button
        type="button"
        className="btn"
        title="Advance the clock by exactly 1 ms of simulated time"
        disabled={!ready}
        onClick={() => void stepOneMs()}
      >
        +1 ms
      </button>
      <button
        type="button"
        className="btn"
        title="Run until no events remain (or 200 000 events)"
        disabled={!ready || pending === 0}
        onClick={() => void runToIdle()}
      >
        Run to idle
      </button>
      <label className="sr-only" htmlFor="rate-select" style={{ position: 'absolute', left: -9999 }}>
        Playback rate
      </label>
      <select
        id="rate-select"
        className="select"
        title="Simulated seconds per wall second"
        value={String(rate)}
        disabled={!ready}
        onChange={(e) => {
          const r = Number(e.target.value);
          engine.setRate(r).catch(reportError);
        }}
      >
        {RATE_PRESETS.map((r) => (
          <option key={r} value={String(r)}>
            {fmtRate(r)}
          </option>
        ))}
        {!RATE_PRESETS.some((r) => r === rate) && <option value={String(rate)}>{fmtRate(rate)}</option>}
      </select>
      {slow && (
        <span className="slowmo" title="Frames are on a cable: the clock is clamped so each transit stays visible">
          slow-motion ×{slowFactor >= 100 ? Math.round(slowFactor) : slowFactor.toFixed(1)}
        </span>
      )}
      <span className="clock" title="Simulated time (hh:mm:ss.ms µs)">
        {fmtSimTime(now)}
      </span>
    </div>
  );
}
