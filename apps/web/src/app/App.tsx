/**
 * Application frame (spec §8.1): CSS grid with top bar, palette (Palette v2, resizable), canvas, inspector
 * (resizable width), bottom dock (resizable height) and status bar.
 *
 * The middle cell is `Workspace`: the canvas with the floating Desktop windows (`WindowLayer`) over it, or a
 * concept tool in their place (§4.13). The keyboard canvas (`CanvasOutline`) is mounted by canvas/Canvas.tsx
 * inside its own container.
 *
 * @since course A learn surface (`LearnShell`: the landing page, a course, a lesson) covers the whole window when
 * `view` is one of them; the grid is hidden behind it rather than unmounted, so the sandbox is untouched.
 *
 * Also owns the wall-clock ticker that expires drop markers / table flashes, the global hotkeys and the
 * preference persistence (store/persist.ts).
 */
import { useEffect, type CSSProperties } from 'react';
import { DOCK_MIN_HEIGHT } from '../dock/registry';
import { Inspector } from '../inspector/Inspector';
import { LearnShell } from '../learn/LearnShell';
import { applyThemeAttribute, startPersistence, store, useStore } from '../store/store';
import { isLearnView } from '../store/types';
import { Dock } from './Dock';
import { useHotkeys } from './hotkeys';
import { PaletteV2 } from './palette/Palette';
import { ResizeHandle } from './ResizeHandle';
import { StatusBar } from './StatusBar';
import { Toast } from './Toast';
import { TopBar } from './TopBar';
import { Workspace } from './Workspace';

const WALL_TICK_MS = 100;
const INSPECTOR_MIN = 0;
const INSPECTOR_MAX_FRACTION = 0.6;

function useWallTicker(): void {
  useEffect(() => {
    const id = setInterval(() => store.getState().tickWall(performance.now()), WALL_TICK_MS);
    return () => clearInterval(id);
  }, []);
}

function useThemeAttribute(): void {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);
}

function usePersistence(): void {
  useEffect(() => startPersistence(), []);
}

export function App() {
  useHotkeys();
  useWallTicker();
  useThemeAttribute();
  usePersistence();

  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const setInspectorWidth = useStore((s) => s.setInspectorWidth);
  const dockHeight = useStore((s) => s.dockHeight);
  const view = useStore((s) => s.view);

  const style = {
    '--inspector-w': `${inspectorWidth}px`,
    '--dock-h': `${Math.max(DOCK_MIN_HEIGHT, dockHeight)}px`,
  } as CSSProperties;

  const onInspectorDrag = (clientX: number): void => {
    const max = Math.round(window.innerWidth * INSPECTOR_MAX_FRACTION);
    setInspectorWidth(Math.min(max, Math.max(INSPECTOR_MIN, window.innerWidth - clientX)));
  };

  // P2: a learn surface covers the window. The grid is hidden, NOT unmounted (§4.13's rule for concept tools):
  // `hidden` takes it out of the tab order and the accessibility tree while the canvas scene, the open consoles
  // and the dock all survive, so coming back from a lesson lands on the workspace exactly as it was left.
  const learning = isLearnView(view);

  return (
    <>
      <div className={`app ${dockHeight <= DOCK_MIN_HEIGHT ? 'dock-collapsed' : ''}`} style={style} hidden={learning}>
        <TopBar />
        <aside className="app-palette" aria-label="Device palette">
          <PaletteV2 />
        </aside>
        <Workspace view={view} />
        <aside className="app-inspector" aria-label="Inspector">
          <ResizeHandle orientation="vertical" onDrag={onInspectorDrag} label="Resize the inspector" />
          <Inspector />
        </aside>
        <section className="app-dock" aria-label="Bottom dock">
          <Dock />
        </section>
        <StatusBar />
      </div>
      {learning && <LearnShell />}
      {/* Fixed to the viewport, so it is outside the grid and a notification is seen from either side. */}
      <Toast />
    </>
  );
}
