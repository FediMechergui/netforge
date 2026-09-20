/**
 * The workspace cell of the application grid (ARCHITECTURE-P1 §4.13, §7 "Shell"): the topology canvas, or a
 * concept tool shown over it.
 *
 * §4.13 is explicit that the canvas STAYS MOUNTED and hidden while a concept tool is open, so the Pixi scene,
 * the camera and the floating desktop windows are all still there when the student goes back; canvas/Canvas.tsx
 * reads the same `view` and stops drawing while it is hidden.
 *
 * ponytail: its own module rather than a block inside App.tsx, so this one rule can be rendered on its own —
 * App drags the whole application (inspector, dock, terminal) into any test that imports it.
 */
import { Canvas } from '../canvas/Canvas';
import { ConceptView } from '../concept/ConceptView';
import { WindowLayer } from '../desktop/WindowLayer';
import type { WorkspaceView } from '../store/types';

export function Workspace({ view }: { view: WorkspaceView }) {
  const concept = view === 'concept';
  return (
    <>
      <main className="app-canvas" aria-label="Topology" hidden={concept}>
        <Canvas />
        <WindowLayer />
      </main>
      {concept && (
        <main className="app-concept" aria-label="Concept tools">
          <ConceptView />
        </main>
      )}
    </>
  );
}
