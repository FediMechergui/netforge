import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const engine = (file: string): string => fileURLToPath(new URL(`../../packages/engine/src/${file}`, import.meta.url));

/** The vendor chunks of the main thread (ARCHITECTURE-P3C §7 W0h web-shell, the bundle split): package dir → chunk. */
const VENDOR_CHUNKS: readonly (readonly [RegExp, string])[] = [
  [/[\\/]node_modules[\\/](?:pixi\.js|@pixi[\\/][^\\/]+|@xmldom[\\/]xmldom|earcut|eventemitter3|gifuct-js|js-binary-schema-parser|ismobilejs|parse-svg-path|tiny-lru)[\\/]/, 'vendor-pixi'],
  [/[\\/]node_modules[\\/]@xterm[\\/]/, 'vendor-xterm'],
  [/[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, 'vendor-react'],
];

interface ModuleInfoLike {
  readonly isEntry: boolean;
  readonly importers: readonly string[];
  readonly importedIds: readonly string[];
  readonly dynamicImporters: readonly string[];
  readonly moduleSideEffects: boolean | 'no-treeshake';
}
type InfoOf = (id: string) => ModuleInfoLike | null;

/** A package's re-export barrel (pixi's `lib/index.mjs`): its edges say nothing about what is really used. */
const isBarrel = (id: string): boolean => /[\\/]node_modules[\\/].*[\\/]index\.m?js$/.test(id);

/** True when the main entry reaches `id` through static imports. */
function staticallyReachable(id: string, info: InfoOf, memo: Map<string, boolean>): boolean {
  const known = memo.get(id);
  if (known !== undefined) return known;
  memo.set(id, false); // a cycle back to `id` proves nothing
  const m = info(id);
  const ok = m !== null && (m.isEntry || m.importers.some((i) => staticallyReachable(i, info, memo)));
  memo.set(id, ok);
  return ok;
}

/**
 * Every module statically reachable from a dynamic `import()` target (pixi's renderers and its `browserAll` /
 * `webworkerAll` extension bundles, a lazy tool), not walking into barrels. A vendor module in this set is left to
 * Rollup: a manual chunk is evaluated as a whole when it loads, so moving, say, `WebGLRenderer` (which registers its
 * systems at module scope) into the start-up vendor chunk would change when that code runs, not just where its bytes
 * are. Modules that the start-up code also uses still land in the main or vendor chunks through their importers.
 */
function lazyClosure(ids: Iterable<string>, info: InfoOf): Set<string> {
  const seen = new Set<string>();
  const queue = [...ids].filter((id) => (info(id)?.dynamicImporters.length ?? 0) > 0);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id) || isBarrel(id)) continue;
    seen.add(id);
    for (const dep of info(id)?.importedIds ?? []) queue.push(dep);
  }
  return seen;
}

/**
 * Every module statically reachable from the entry, following only the side-effectful imports of a barrel (what the
 * start-up code really evaluates).
 */
function entryClosure(ids: Iterable<string>, info: InfoOf): Set<string> {
  const seen = new Set<string>();
  const queue = [...ids].filter((id) => info(id)?.isEntry === true);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    // a barrel's side-effect imports (pixi's `import './rendering/init.mjs'`) always run; its re-exports may not
    for (const dep of info(id)?.importedIds ?? []) if (!isBarrel(id) || info(dep)?.moduleSideEffects !== false) queue.push(dep);
  }
  return seen;
}

/** Per build: `lazyOnly` (computed on the first manualChunks call). */
let lazyModules: Set<string> | undefined;

/**
 * The modules a vendor chunk must not take: the lazy-only ones, and every module that imports one, directly or not.
 * Rollup moves a manual chunk's static dependencies into it with it, so assigning, say, pixi's `ExternalSource` would
 * drag the WebGPU texture system (which registers its uploaders at module scope) into the start-up chunk.
 */
function lazyOnly(ids: readonly string[], info: InfoOf): Set<string> {
  const start = entryClosure(ids, info);
  const tainted = new Set<string>();
  const queue = [...lazyClosure(ids, info)].filter((id) => !start.has(id));
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (tainted.has(id)) continue;
    tainted.add(id);
    for (const importer of info(id)?.importers ?? []) queue.push(importer);
  }
  return tainted;
}

export default defineConfig({
  plugins: [
    react(),
    // a fresh lazy-module set for every build (the set is computed once per build, on the first manualChunks call)
    { name: 'netforge-vendor-chunks', buildStart: () => void (lazyModules = undefined) },
  ],
  resolve: {
    alias: {
      // Order matters: Vite tries aliases in key order and a string alias also matches `find + '/'`, so every
      // subpath entry must come before '@netforge/engine' or '/pure' would resolve to 'index.ts/pure'.
      // The subpaths mirror packages/engine/package.json `exports`; the main thread imports only these (W0h; the lint
      // test bundle.engine-imports.lint.test.ts), the engine worker the full entry.
      '@netforge/engine/pure': engine('pure.ts'),
      '@netforge/engine/contracts': engine('contracts/index.ts'),
      '@netforge/engine/curriculum': engine('curriculum-entry.ts'),
      '@netforge/engine/web': engine('web.ts'),
      '@netforge/engine': engine('index.ts'),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    fs: {
      // allow importing engine sources from the monorepo root
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The vendor split (W0h): pixi, xterm and react each in a chunk of their own, cached apart from the app. The
        // worker is a separate build and is not affected.
        // Only modules the start-up code reaches statically, never a barrel, never one of a lazy chunk's modules.
        manualChunks(id, { getModuleIds, getModuleInfo }) {
          const vendor = VENDOR_CHUNKS.find(([re]) => re.test(id));
          if (vendor === undefined || isBarrel(id)) return undefined;
          const info: InfoOf = (m) => getModuleInfo(m);
          lazyModules ??= lazyOnly([...getModuleIds()], info);
          if (lazyModules.has(id)) return undefined;
          return staticallyReachable(id, info, new Map()) ? vendor[1] : undefined;
        },
      },
    },
  },
});
