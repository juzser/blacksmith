// The factory's own project name, and the one place its old spelling
// becomes the current one.
//
// Renamed from `black-smith` to `blacksmith` (operator decision, CHANGELOG
// "rename the factory's own project"). History is immutable: already-logged
// events, committed plan files and old roadmap.md bullets may still carry
// the old name verbatim, so every reader of a project value normalizes it
// through `normalizeProjectName` rather than comparing against two literals.
//
// A tiny module with no dependency of its own, so both `db/queries.ts`
// (which reaches drizzle) and `roadmap.ts` (which `test/cliBoot.test.ts`
// pins never does) can import the same constant and the same mapping.

/** The factory's own project name, everywhere a reader needs the current spelling. */
export const FACTORY_PROJECT_NAME = 'blacksmith';

/** The name `blacksmith` replaced — still present verbatim in old events, plans and roadmap bullets. */
export const LEGACY_FACTORY_PROJECT = 'black-smith';

/**
 * Maps the legacy project name to the current one; every other value passes
 * through unchanged. The one place old data's project value becomes the
 * current one, so a reader never has to compare against `'black-smith'`
 * itself.
 */
export function normalizeProjectName(value: string): string {
  return value === LEGACY_FACTORY_PROJECT ? FACTORY_PROJECT_NAME : value;
}
