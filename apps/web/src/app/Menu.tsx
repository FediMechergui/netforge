/**
 * Minimal dropdown menu used by the top bar (file / view / simulate / help) and the dock.
 * Closes on outside click, Escape, or when an item is chosen.
 *
 * The popup is `position: fixed` and placed from the button's viewport rectangle, so it is never
 * clipped by a panel with `overflow: hidden` (top bar, dock, inspector). It opens downward, or upward
 * when there is clearly more room above (menus at the bottom of the dock), and its height is capped
 * to the room available so long menus scroll instead of leaving the window.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Gap between the button and the popup, and between the popup and the window edge (px). */
const POPUP_GAP = 4;
const EDGE_MARGIN = 8;
/** Below this much room underneath the button, a menu with more room above opens upward (px). */
const MIN_ROOM_BELOW = 220;

/** Viewport placement for a popup anchored to `anchor` (pure; exported for tests). */
export function placePopup(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right',
): CSSProperties {
  const roomBelow = viewport.height - anchor.bottom - POPUP_GAP - EDGE_MARGIN;
  const roomAbove = anchor.top - POPUP_GAP - EDGE_MARGIN;
  const upward = roomBelow < MIN_ROOM_BELOW && roomAbove > roomBelow;
  const style: CSSProperties = {
    maxHeight: Math.max(120, upward ? roomAbove : roomBelow),
  };
  if (upward) style.bottom = viewport.height - anchor.top + POPUP_GAP;
  else style.top = anchor.bottom + POPUP_GAP;
  if (align === 'right') style.right = Math.max(EDGE_MARGIN, viewport.width - anchor.right);
  else style.left = Math.max(EDGE_MARGIN, Math.min(anchor.left, viewport.width - EDGE_MARGIN - 220));
  return style;
}

export interface MenuProps {
  label: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  /** Called each time the menu opens (e.g. to refresh async content). */
  onOpen?: () => void;
  className?: string;
  title?: string;
}

export function Menu({ label, children, align = 'left', onOpen, className, title }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  // Place the fixed popup before paint, and again whenever the window changes size.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const place = (): void => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPlacement(placePopup(r, { width: window.innerWidth, height: window.innerHeight }, align));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (): void => {
    setOpen((v) => {
      if (!v) onOpen?.();
      return !v;
    });
  };

  return (
    <div className={`menu ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        className={`btn btn-ghost ${open ? 'is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={title}
        onClick={toggle}
      >
        {label}
      </button>
      {open && placement && (
        <div id={id} role="menu" className="menu-popup" style={placement}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
  sub?: string;
}

export function MenuItem({ onSelect, children, hint, disabled, sub }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${sub ? 'two-line' : ''}`}
      disabled={disabled}
      onClick={onSelect}
    >
      {sub ? (
        <>
          <span>{children}</span>
          <span className="sub">{sub}</span>
        </>
      ) : (
        <>
          <span>{children}</span>
          {hint && <span className="hint">{hint}</span>}
        </>
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="menu-heading">{children}</div>;
}
