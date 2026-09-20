/**
 * Single transient notification. Kind is encoded by glyph AND colour.
 */
import { useEffect } from 'react';
import { useStore } from '../store/store';

const AUTO_DISMISS_MS: Record<'info' | 'warn' | 'error', number> = { info: 3500, warn: 6000, error: 9000 };
const GLYPH: Record<'info' | 'warn' | 'error', string> = { info: 'i', warn: '!', error: '×' };

export function Toast() {
  const toast = useStore((s) => s.toastMessage);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismiss, AUTO_DISMISS_MS[toast.kind]);
    return () => clearTimeout(id);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} onClick={dismiss}>
      <span className="glyph" aria-hidden="true">
        {GLYPH[toast.kind]}
      </span>
      <span className="text">{toast.text}</span>
    </div>
  );
}
