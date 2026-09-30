/**
 * Typing for deliberately incomplete test values (ARCHITECTURE-P3 §7 W0 "architect (health, P2 §14)", §9.2 W0 item 7:
 * the web tests are type-checked by check 3b, `npx tsc -p tsconfig.test.json`).
 *
 * The web fixtures build complete snapshots (the P1 web fixture migration, ARCHITECTURE-P1 §11, finished in P3 W0). A
 * few tests pass, on purpose, a value that LACKS members its type requires — a P0-shaped port without the P0.5
 * members, a device without `gui`, a model without `category`, an API object without its methods — to pin the
 * defensive fallback a reader keeps for data that predates those members. `handBuilt` says so at the call site: the
 * value may omit (or leave undefined) any member, and the type it stands for is taken from where it is used (the
 * parameter or the declared variable), never from the value itself.
 *
 * It returns its argument unchanged: a type-level statement only, so every test runs exactly as before. When a reader
 * drops its fallback, `handBuilt(` finds every test that pins it.
 */
export type HandBuilt<T> = { [K in keyof T]?: T[K] | undefined };

export function handBuilt<T>(value: NoInfer<HandBuilt<T>>): T {
  return value as T;
}
