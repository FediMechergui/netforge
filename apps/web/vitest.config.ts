/**
 * Web test configuration (ARCHITECTURE-P3 §0 rules 4 and 15; §7 W0 "architect (health, P2 §14)").
 *
 * It is `vite.config.ts` (plugins, the engine aliases, the worker format) merged with the test options, so the tests
 * resolve modules exactly as the app does. Files, environment ('node') and the 5 s default per test are vitest's
 * defaults, as before this file existed; a file that needs more time sets its own (e.g. `worker.delta.test.ts`).
 *
 * The worker count is fixed here, never by CLI flags (check 5 is the plain `npx vitest run --root apps/web`), so no
 * run depends on the machine or on its load; vitest 2.1 needs both bounds when the maximum is below its default
 * minimum. Four is the count the P2 exit gate ran the web suite with (ARCHITECTURE-P2 §9.2 item 22e, §14).
 *
 * Commands, from the repository root:
 *   npx vitest run --root apps/web                   every web test (check 5)
 *   npx vitest run --root apps/web <name filter>     one's own files (rule 9)
 *   cd apps/web && npx tsc -p tsconfig.test.json     the web tests type-checked with the sources (check 3b)
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      minWorkers: 1,
      maxWorkers: 4,
    },
  }),
);
