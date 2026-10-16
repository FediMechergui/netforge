/**
 * @netforge/engine/curriculum — the course catalogue on its own (ARCHITECTURE-P3C §7 W0h web-shell, the bundle split).
 *
 * The same two lines as the main entry's "curriculum" group, in the same order: the curriculum contract (`lessonsOf`
 * and the types) and the catalogue (`COURSES`, `courseById`, `lessonById`). The web app imports it lazily
 * (apps/web/src/curriculum-loader.ts and the learn surfaces), so the lesson text is a chunk of its own and never part
 * of the main chunk. Re-exports only; nothing here changes an engine byte.
 */
export * from './contracts/curriculum.js';
export * from './curriculum/index.js';
