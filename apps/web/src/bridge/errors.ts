/**
 * Shared Comlink 'throw' handler (imported for its side effect by engine.worker.ts and client.ts before
 * `Comlink.expose` / `Comlink.wrap`).
 *
 * Comlink's default handler serializes a thrown Error as {message, name, stack} only, which would drop
 * `TopologyLoadError.problems` (D11 atomic load). This handler keeps rejections as real Errors and carries
 * `problems` across the worker boundary, so `reportError`/`toastError`/`messageOf` keep working unchanged.
 */
import * as Comlink from 'comlink';
import type { TopologyLoadProblem } from '@netforge/engine';

/** A rejection from the engine bridge. `name === 'TopologyLoadError'` carries `problems`. */
export type EngineError = Error & { problems?: readonly TopologyLoadProblem[] };

interface SerializedThrown {
  isError: boolean;
  value: unknown;
}

function install(): void {
  // Tests may mock 'comlink' without transferHandlers; accessing a missing mock export throws.
  let handlers: typeof Comlink.transferHandlers | undefined;
  try {
    handlers = Comlink.transferHandlers;
  } catch {
    return;
  }
  const base = handlers?.get('throw');
  if (handlers === undefined || base === undefined) return;
  handlers.set('throw', {
    canHandle: base.canHandle,
    serialize(v: unknown) {
      const e = (v as { value?: unknown }).value;
      if (e instanceof Error) {
        const problems = (e as EngineError).problems;
        const value = { message: e.message, name: e.name, stack: e.stack, problems: problems === undefined ? undefined : [...problems] };
        return [{ isError: true, value }, []];
      }
      return base.serialize(v);
    },
    deserialize(s: unknown) {
      const ser = s as SerializedThrown;
      if (ser.isError) {
        const value = ser.value as { message: string; name?: string; stack?: string; problems?: TopologyLoadProblem[] };
        throw Object.assign(new Error(value.message), value);
      }
      throw ser.value;
    },
  });
}

install();
