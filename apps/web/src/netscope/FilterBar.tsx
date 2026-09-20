/**
 * FilterBar — the display-filter box (ARCHITECTURE-P1 §4.12; §10.2 accept.p1.netscope-filter).
 *
 * Completion and error reporting come from the engine's PURE parser (`@netforge/engine/pure`), so the box
 * says what is wrong while it is typed, before anything is applied: the message, the column (counted from 1)
 * and a caret row under the offending span — never a silently empty list. The filter the engine could not
 * compile is reported the same way when it comes back with the rows.
 *
 * Keyboard: Down/Up walk the suggestions, Enter or Tab takes the highlighted one, Enter with none highlighted
 * applies the filter, Escape closes the list (a second Escape clears the box).
 *
 * ponytail: the list is a plain listbox driven by aria-activedescendant instead of a focus-moving menu, so the
 * caret never leaves the text box.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { completeDisplayFilter, parseDisplayFilter } from '@netforge/engine/pure';
import type { DisplayFilterCompletion, DisplayFilterError } from '@netforge/engine';
import { applyCompletion, caretLine, describeFilterError } from './netscope-client';
import './netscope.css';

export interface FilterBarProps {
  text: string;
  onText(next: string): void;
  /** Run this filter over the capture. */
  onApply(text: string): void;
  /** Error the engine reported for the applied filter. */
  engineError?: DisplayFilterError;
  /** Right-hand summary ("38 matched of 1 200 scanned"). */
  status?: string;
  busy?: boolean;
  /** Id prefix, so two bars on one page keep distinct element ids. */
  idPrefix?: string;
}

/** Move the highlight, wrapping at both ends; -1 means "nothing highlighted". */
export function nextHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Suggestions for `text` with the caret at `cursor`, or null when there is nothing to offer. */
export function suggestionsFor(text: string, cursor: number): DisplayFilterCompletion | null {
  const c = completeDisplayFilter(text, cursor);
  return c.items.length > 0 ? c : null;
}

/** Parse error of the text being typed (undefined while it is still valid). */
export function typingError(text: string): DisplayFilterError | undefined {
  if (text.trim() === '') return undefined;
  const res = parseDisplayFilter(text);
  return res.ok ? undefined : res.error;
}

export function FilterBar({ text, onText, onApply, engineError, status, busy, idPrefix = 'ns' }: FilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [cursor, setCursor] = useState(text.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const completion = useMemo(() => (open ? suggestionsFor(text, cursor) : null), [open, text, cursor]);
  const items = completion?.items ?? [];
  const typed = typingError(text);
  const error = typed ?? engineError;
  const listId = `${idPrefix}-filter-list`;

  useEffect(() => {
    const at = caretRef.current;
    if (at === null) return;
    caretRef.current = null;
    const el = inputRef.current;
    if (el) el.setSelectionRange(at, at);
  }, [text]);

  const take = (label: string): void => {
    if (!completion) return;
    const next = applyCompletion(text, completion, label);
    caretRef.current = next.cursor;
    setCursor(next.cursor);
    setActive(-1);
    setOpen(false);
    onText(next.text);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const at = e.currentTarget.selectionStart ?? text.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setCursor(at);
        setOpen(true);
        setActive(0);
        return;
      }
      setActive(nextHighlight(active, e.key === 'ArrowDown' ? 1 : -1, items.length));
      return;
    }
    if (e.key === 'Tab' && open && items.length > 0) {
      e.preventDefault();
      take((items[active >= 0 ? active : 0] as { label: string }).label);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && items[active]) take(items[active].label);
      else {
        setOpen(false);
        onApply(text);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (open) setOpen(false);
      else if (text !== '') {
        onText('');
        onApply('');
      }
    }
  };

  return (
    <div className="ns-bar">
      <div className="ns-filter">
        <input
          ref={inputRef}
          className={`input${error ? ' is-bad' : ''}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-label="Display filter"
          aria-describedby={error ? `${idPrefix}-filter-error` : undefined}
          aria-invalid={error !== undefined}
          placeholder="Display filter, for example  ip.addr == 192.168.1.80 && tcp.flags.syn == 1"
          value={text}
          onChange={(e) => {
            setCursor(e.target.selectionStart ?? e.target.value.length);
            setActive(-1);
            setOpen(true);
            onText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        {open && items.length > 0 && (
          <ul className="ns-complete" id={listId} role="listbox" aria-label="Filter suggestions">
            {items.map((item, i) => (
              <li
                key={`${item.kind}:${item.label}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'is-active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(item.label);
                }}
              >
                <span className="label">{item.label}</span>
                <span className="kind">{item.kind}</span>
                <span className="help">{item.help}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="btn" onClick={() => onApply(text)} disabled={busy === true}>
        Apply filter
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          onText('');
          onApply('');
        }}
        disabled={text === '' || busy === true}
      >
        Clear
      </button>
      {status !== undefined && (
        <span className="ns-status" aria-live="polite">
          {status}
        </span>
      )}
      {error && (
        <div className="ns-err" id={`${idPrefix}-filter-error`} role="status">
          <span>
            ⚠ {describeFilterError(error)}
            {typed === undefined ? ' (from the engine)' : ''}
          </span>
          <span className="caret" aria-hidden="true">{`${text}\n${caretLine(error)}`}</span>
        </div>
      )}
    </div>
  );
}
