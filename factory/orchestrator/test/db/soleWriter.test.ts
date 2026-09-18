import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuild } from '../../src/db/projector.js';
import * as schema from '../../src/db/schema.js';
import { buildFixture } from './fixtures.js';

// ---------------------------------------------------------------------------
// Load-bearing rule 1 (architecture §18): events are the source of truth and
// `state/smith.db` is a cache of them. db/projector.ts says so in its own
// header — "this module is the ONLY writer of the tables in db/schema.ts" —
// and until now that was a sentence rather than a check.
//
// The property is worth a guard because violating it is cheap and silent. A
// module that already holds a `SmithDb` to read from can write to it in one
// line, the write survives every query, and nothing fails until someone runs
// `smith db rebuild` — at which point the row is gone and whatever depended
// on it starts answering differently. Between those two moments the factory
// is reporting a fact with no provenance: no event produced it, so no replay
// can confirm or refute it.
//
// Two tests, because the rule has two halves that fail differently:
//
//   - the source scan catches the write at the line that introduces it,
//     naming the file, which is the cheap failure;
//   - the rebuild test states the consequence the scan exists to prevent, so
//     a reader who wonders why the scan is worth its false-positive risk can
//     read the second test instead of the comment.
// ---------------------------------------------------------------------------

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Every table db/schema.ts declares, by its exported binding name. */
const TABLE_NAMES: string[] = Object.entries(schema)
  .filter(([, value]) => typeof value === 'object' && value !== null)
  .map(([name]) => name)
  .sort();

/** Relative to src/. The one module the rule exempts. */
const SOLE_WRITER = path.join('db', 'projector.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Drizzle writes name a table: `db.insert(schema.tasks)`, `.delete(tasks)`,
 * `.update(schema.findings)`. Requiring the table argument is what keeps
 * `map.delete(key)` and `createHash().update(text)` — both common here — out
 * of the results, so the scan can run over every module rather than over a
 * hand-kept list of the ones that touch the db.
 */
const DRIZZLE_WRITE = new RegExp(
  String.raw`\.(insert|update|delete)\(\s*(?:schema\.)?(${TABLE_NAMES.join('|')})\b`,
);

/** A raw statement reaches the same tables without going through drizzle. */
const RAW_SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;

describe('load-bearing rule 1: db/projector.ts is the only writer', () => {
  it('finds the tables to look for, so an empty pattern cannot pass vacuously', () => {
    expect(TABLE_NAMES).toContain('tasks');
    expect(TABLE_NAMES).toContain('findings');
    expect(TABLE_NAMES.length).toBeGreaterThan(8);
  });

  it('is the only module under src/ that writes a projection table', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const relative = path.relative(SRC_DIR, file);
      if (relative === SOLE_WRITER) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (DRIZZLE_WRITE.test(line) || RAW_SQL_WRITE.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('would catch a write that bypassed the projector', () => {
    // The scan is only a guard if it actually matches the idiom the projector
    // itself uses. Assert against that idiom rather than a hand-written
    // example, so a drizzle upgrade that changes the call shape fails here —
    // loudly — instead of quietly making the guard above match nothing.
    const projector = readFileSync(path.join(SRC_DIR, SOLE_WRITER), 'utf8');
    const written = projector.split('\n').filter((line) => DRIZZLE_WRITE.test(line));
    expect(written.length).toBeGreaterThan(10);
  });
});

describe('load-bearing rule 1: a row no event produced does not survive a rebuild', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-sole-writer-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-sole-writer-db-'));
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('discards it, and restores exactly the rows the log produces', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });

    const before = openDb(dbPath);
    const projected = before.db.select().from(schema.tasks).all();
    before.sqlite.close();

    // A plausible out-of-band write: a task that is real to every reader of
    // the db and unknown to every reader of the log.
    const seed = projected[0];
    // A throw rather than `expect(...).toBeDefined()`: under
    // noUncheckedIndexedAccess the row is `Task | undefined`, and an
    // expectation is a runtime check the compiler does not read. The rest of
    // the test spreads this row into an insert, so it has to narrow here.
    if (!seed) throw new Error('fixture: the projection holds no tasks to copy');
    const smuggled = openDb(dbPath);
    smuggled.db
      .insert(schema.tasks)
      .values({ ...seed, taskId: `${seed.taskId}-smuggled`, taskStatus: 'done' })
      .run();
    const withSmuggled = smuggled.db.select().from(schema.tasks).all();
    smuggled.sqlite.close();
    expect(withSmuggled).toHaveLength(projected.length + 1);

    await rebuild(dbPath, 'all', { stateDir });

    const after = openDb(dbPath);
    const rebuilt = after.db.select().from(schema.tasks).all();
    after.sqlite.close();

    expect(rebuilt.map((row) => row.taskId)).not.toContain(`${seed.taskId}-smuggled`);
    expect(rebuilt).toEqual(projected);
  });

  it('applies to a status too: a hand-set task_status is replaced, not merged', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });

    const before = openDb(dbPath);
    const target = before.db.select().from(schema.tasks).all()[0];
    before.sqlite.close();
    if (!target) throw new Error('fixture: the projection holds no task to edit');

    const edited = openDb(dbPath);
    edited.db
      .update(schema.tasks)
      .set({ taskStatus: 'blocked-by-hand' })
      .where(eq(schema.tasks.taskId, target.taskId))
      .run();
    edited.sqlite.close();

    await rebuild(dbPath, 'all', { stateDir });

    const after = openDb(dbPath);
    const row = after.db
      .select()
      .from(schema.tasks)
      .all()
      .find((r) => r.taskId === target.taskId);
    after.sqlite.close();

    expect(row?.taskStatus).toBe(target.taskStatus);
    expect(row?.taskStatus).not.toBe('blocked-by-hand');
  });
});
