/**
 * Drag handle for resizable panels (inspector width, dock height). Pointer
 * capture keeps the drag alive over the canvas / iframes; the body gets
 * `is-resizing` so those surfaces stop eating pointer events.
 */
import { useEffect, useRef, useState } from 'react';

export interface ResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  /** Receives the pointer's client X (vertical handle) or client Y (horizontal handle). */
  onDrag: (clientPos: number) => void;
  onEnd?: () => void;
  label: string;
}

export function ResizeHandle({ orientation, onDrag, onEnd, label }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const onDragRef = useRef(onDrag);
  const onEndRef = useRef(onEnd);
  onDragRef.current = onDrag;
  onEndRef.current = onEnd;

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('is-resizing');
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    return () => {
      document.body.classList.remove('is-resizing');
      document.body.style.cursor = '';
    };
  }, [dragging, orientation]);

  return (
    <div
      className={`resize-handle ${orientation} ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onDragRef.current(orientation === 'vertical' ? e.clientX : e.clientY);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        onEndRef.current?.();
      }}
      onPointerCancel={() => {
        if (!dragging) return;
        setDragging(false);
        onEndRef.current?.();
      }}
    />
  );
}
