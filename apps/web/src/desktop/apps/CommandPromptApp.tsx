/**
 * Desktop "Command prompt" app (ARCHITECTURE-P1 §7: the Command Prompt reuses the terminal). Opens a console
 * session on the device when the window opens, renders it with the dock's `TerminalTab` (same line editor,
 * completion, help, paste and job handling), and closes the session when the window closes. When the session
 * ends (`exit`), the window offers a new one. Wording is original (§1.6).
 */
import { useEffect, useRef, useState } from 'react';
import type { SessionId } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { useStore } from '../../store/store';
import { TerminalTab } from '../../terminal/TerminalTab';
import { DeviceGone, errorText, useDeviceById } from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

/** Lifecycle of the window's console session. */
export type PromptSession =
  | { readonly phase: 'opening' }
  | { readonly phase: 'open'; readonly session: SessionId }
  | { readonly phase: 'ended' }
  | { readonly phase: 'refused'; readonly reason: string };

/**
 * Open a console for the window: refused shells report their reason instead of throwing. `cancelled` is polled
 * after each await; a session opened for a window that closed meanwhile is closed again at once.
 */
export async function openPromptSession(deviceId: string, cancelled: () => boolean): Promise<PromptSession | undefined> {
  try {
    const can = await engine.cliCanOpen(deviceId, 'console');
    if (!can.ok) return { phase: 'refused', reason: can.reason };
  } catch {
    /* an engine without the check still answers cliOpen below */
  }
  if (cancelled()) return undefined;
  try {
    const view = await engine.cliOpen(deviceId, 'console');
    if (cancelled()) {
      void engine.cliClose(view.id).catch(() => undefined);
      return undefined;
    }
    return { phase: 'open', session: view.id };
  } catch (err) {
    return { phase: 'refused', reason: errorText(err) };
  }
}

export function CommandPromptApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  const [state, setState] = useState<PromptSession>({ phase: 'opening' });
  const [generation, setGeneration] = useState(0);
  const session = state.phase === 'open' ? state.session : null;
  const live = useStore((s) => (session === null ? false : s.snapshot?.sessions.some((v) => v.id === session) === true));
  const seen = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let opened: SessionId | null = null;
    setState({ phase: 'opening' });
    seen.current = false;
    void openPromptSession(deviceId, () => cancelled).then((result) => {
      if (result === undefined || cancelled) return;
      if (result.phase === 'open') opened = result.session;
      setState(result);
    });
    return () => {
      cancelled = true;
      if (opened !== null) {
        const id = opened;
        opened = null;
        void engine.cliClose(id).catch(() => undefined);
      }
    };
  }, [deviceId, generation]);

  // The session list arrives with batches: once the session has been listed, its disappearance means it ended.
  useEffect(() => {
    if (session === null) return;
    if (live) seen.current = true;
    else if (seen.current) setState({ phase: 'ended' });
  }, [session, live]);

  if (device === undefined) return <DeviceGone />;
  const title = device.name;

  return (
    <div className="desk-prompt">
      {state.phase === 'opening' && <p className="desk-empty">Opening a command prompt…</p>}
      {state.phase === 'refused' && (
        <div className="desk-empty" role="alert">
          <p>
            <span aria-hidden="true">⚠ </span>
            {state.reason}
          </p>
          <button type="button" className="btn" onClick={() => setGeneration((g) => g + 1)}>
            Try again
          </button>
        </div>
      )}
      {state.phase === 'ended' && (
        <div className="desk-empty" role="status">
          <p>The command prompt session has ended.</p>
          <button type="button" className="btn btn-primary" onClick={() => setGeneration((g) => g + 1)}>
            Open a new session
          </button>
        </div>
      )}
      {state.phase === 'open' && (
        <div className="desk-prompt-host">
          <TerminalTab tab={{ session: state.session, device: device.id, title }} active />
        </div>
      )}
    </div>
  );
}
