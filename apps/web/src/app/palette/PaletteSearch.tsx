/**
 * Palette v2 search box (ARCHITECTURE-P1 §7 "Palette v2"). The query itself lives in the store
 * (`PaletteUiState.query`); matching is done by palette-query.ts. `/` focuses the box from anywhere outside a
 * text field, Escape clears it, ArrowDown moves into the result list. The match count is announced politely.
 */
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/** True when a key event comes from a text field, an editable element or a console. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
  return target.closest('.xterm') !== null;
}

/** Sentence under the search box. */
export function searchSummary(searching: boolean, matched: number, total: number): string {
  if (!searching) return total === 1 ? '1 device' : `${total} devices`;
  if (matched === 0) return 'No device matches';
  return matched === 1 ? `1 of ${total} devices matches` : `${matched} of ${total} devices match`;
}

export interface PaletteSearchProps {
  query: string;
  searching: boolean;
  matched: number;
  total: number;
  onChange: (query: string) => void;
  /** ArrowDown in the box: move focus to the first result. */
  onEnterList: () => void;
}

export function PaletteSearch({ query, searching, matched, total, onChange, onEnterList }: PaletteSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const countId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      if (query !== '') {
        e.preventDefault();
        e.stopPropagation();
        onChange('');
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      onEnterList();
    }
  };

  return (
    <div className="pv2-search" role="search">
      <label htmlFor={inputId} className="pv2-sr-only">
        Search devices
      </label>
      <div className="pv2-search-box">
        <svg className="pv2-search-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="14" y2="14" />
        </svg>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          className="input pv2-search-input"
          placeholder="Search devices (press /)"
          autoComplete="off"
          spellCheck={false}
          value={query}
          aria-describedby={countId}
          aria-keyshortcuts="/"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query !== '' && (
          <button type="button" className="btn btn-ghost btn-icon pv2-search-clear" aria-label="Clear the search" title="Clear the search (Escape)" onClick={() => onChange('')}>
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <div id={countId} className="pv2-search-count" aria-live="polite">
        {searchSummary(searching, matched, total)}
      </div>
    </div>
  );
}
