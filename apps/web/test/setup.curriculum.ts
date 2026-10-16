/**
 * Web test setup (ARCHITECTURE-P3C §7 W0h, the bundle split): load the course catalogue before every test file.
 *
 * In the app the catalogue is a lazy chunk (src/curriculum-loader.ts), loaded before anything reads a course
 * synchronously: App mounts the course layer only after `loadCurriculum`, and `initEngine` / File → New go through
 * `courseProfile`. Tests import those modules directly and call the synchronous lookups (`profileForCourse`,
 * `startupProfile`), so the catalogue is loaded here once per file, as the app has it by then.
 * `curriculum-loader.test.ts` covers the loader itself on a fresh module graph.
 */
import { loadCurriculum } from '../src/curriculum-loader';

await loadCurriculum();
