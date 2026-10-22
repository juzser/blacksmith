// bs-optimize epic criterion 1 (AC1): a lesson carries one taxonomy error
// class from raise through store, compile and parse.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuild } from '../src/db/projector.js';
import { lessonsPage } from '../src/db/queries.js';
import { appendEvent, readEvents } from '../src/events.js';
import { compileLessons, raiseLessonCandidate } from '../src/lessons.js';
import { parseLessons } from '../src/severity.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DRIZZLE_DIR = path.join(REPO_ROOT, 'factory/orchestrator/drizzle');

let stateDir: string;
let seq = 0;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lesson-class-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function seedSession(): Promise<{ sessionId: string; tip: string }> {
  seq += 1;
  const sessionId = `sess-class-${seq}`;
  const root = await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir },
  );
  return { sessionId, tip: root.event_id };
}

async function raise(errorClass: string | undefined, statement: string) {
  const { sessionId, tip } = await seedSession();
  const result = await raiseLessonCandidate(
    {
      statement,
      lessonType: 'rule',
      lessonScope: 'stack-wide',
      findingCategory: 'correctness',
      provenanceEventIds: [tip],
      ...(errorClass === undefined ? {} : { errorClass }),
    },
    { sessionId, planVersion: 1, causalParent: tip },
    { stateDir },
  );
  await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'lesson-status-changed',
      plan_version: 1,
      causal_parent: result.event_id,
      payload: { lesson_id: result.lessonId, from_status: 'candidate', to_status: 'approved' },
    },
    { stateDir },
  );
  return { sessionId, lessonId: result.lessonId };
}

async function storeRow(lessonId: string) {
  const dbPath = path.join(stateDir, 'smith.db');
  await rebuild(dbPath, 'all', { stateDir });
  const handle = openDb(dbPath);
  try {
    const row = lessonsPage(handle.db).approved.find((l) => l.lessonId === lessonId);
    if (!row) throw new Error(`no approved row for ${lessonId}`);
    return row;
  } finally {
    handle.sqlite.close();
  }
}

function toCompileInput(row: Awaited<ReturnType<typeof storeRow>>) {
  return {
    lessonId: row.lessonId,
    lessonScope: row.lessonScope,
    statement: row.statement,
    findingCategory: row.findingCategory,
    claimPath: row.claimPath,
    agentRole: row.agentRole,
    caseType: row.caseType,
    errorClass: row.errorClass,
  };
}

describe('lesson error_class round trip', () => {
  it.each([
    ['execution.flaky-test', 'A retry that hides a flaky test hides the next regression too.'],
    [
      'other.unclassified',
      'A fallback class exists so no lesson has to invent a class of its own.',
    ],
  ])(
    'carries %s from raise to store row to lessons.md bullet to parseLessons',
    async (cls, statement) => {
      const { sessionId, lessonId } = await raise(cls, statement);

      const raised = (await readEvents(sessionId, { stateDir })).find(
        (e) => e.record.event_type === 'lesson-candidate-raised',
      );
      expect(raised?.record.payload).toMatchObject({ error_class: cls });

      const row = await storeRow(lessonId);
      expect(row.errorClass).toBe(cls);

      const markdown = compileLessons([toCompileInput(row)]);
      expect(markdown).toContain(`- error_class: ${cls}`);

      const parsed = parseLessons(markdown).find((r) => r.lessonId === lessonId);
      expect(parsed?.errorClass).toBe(cls);
    },
  );

  it('refuses an unknown class and names it, writing nothing', async () => {
    const { sessionId, tip } = await seedSession();
    await expect(
      raiseLessonCandidate(
        {
          statement: 'A class nobody declared is a class nobody can count.',
          lessonType: 'rule',
          lessonScope: 'stack-wide',
          provenanceEventIds: [tip],
          errorClass: 'execution.no-such-class',
        },
        { sessionId, planVersion: 1, causalParent: tip },
        { stateDir },
      ),
    ).rejects.toThrow(/execution\.no-such-class/);
    const logged = await readEvents(sessionId, { stateDir });
    expect(logged.filter((e) => e.record.event_type === 'lesson-candidate-raised')).toHaveLength(0);
  });

  it('leaves a lesson without a class exactly as before', async () => {
    const { lessonId } = await raise(
      undefined,
      'A lesson with no class still compiles as it always did.',
    );
    const row = await storeRow(lessonId);
    expect(row.errorClass).toBeNull();
    const markdown = compileLessons([toCompileInput(row)]);
    expect(markdown).not.toContain('- error_class:');
    expect(parseLessons(markdown).find((r) => r.lessonId === lessonId)?.errorClass).toBeUndefined();
  });

  it('keeps a class present only in the file when the store row has none', async () => {
    const { lessonId } = await raise(
      undefined,
      'A file-only class survives the next recompile intact.',
    );
    const row = await storeRow(lessonId);
    const first = compileLessons([toCompileInput(row)]);
    const edited = first.replace(
      `- lesson_id: ${lessonId}\n`,
      `- lesson_id: ${lessonId}\n- error_class: judgment.same-mistake\n`,
    );
    expect(edited).not.toBe(first);

    const second = compileLessons([toCompileInput(row)], edited);
    expect(second).toContain('- error_class: judgment.same-mistake');
    expect(parseLessons(second).find((r) => r.lessonId === lessonId)?.errorClass).toBe(
      'judgment.same-mistake',
    );
  });

  it('prefers the store row class over the file when both exist', async () => {
    const { lessonId } = await raise(
      'execution.flaky-test',
      'The store stays the source of truth for a tracked lesson.',
    );
    const row = await storeRow(lessonId);
    const stale = compileLessons([{ ...toCompileInput(row), errorClass: 'execution.env-failure' }]);
    const next = compileLessons([toCompileInput(row)], stale);
    expect(next).toContain('- error_class: execution.flaky-test');
    expect(next).not.toContain('execution.env-failure');
  });
});

describe('error_class migration', () => {
  interface JournalEntry {
    idx: number;
    tag: string;
  }

  async function addingMigration(): Promise<{ entries: JournalEntry[]; creator: JournalEntry }> {
    const journal = JSON.parse(
      await readFile(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };
    const creators: JournalEntry[] = [];
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), 'utf8');
      if (/ALTER TABLE `lessons` ADD `error_class`/.test(sql)) creators.push(entry);
    }
    expect(creators).toHaveLength(1);
    return { entries: journal.entries, creator: creators[0] as JournalEntry };
  }

  it('applies on a fresh store and on a store at the previous migration', async () => {
    const { entries, creator } = await addingMigration();

    // Fresh store.
    const fresh = openDb(path.join(stateDir, 'fresh.db'));
    const freshCols = fresh.sqlite.prepare('PRAGMA table_info(lessons)').all() as {
      name: string;
    }[];
    fresh.sqlite.close();
    expect(freshCols.map((c) => c.name)).toContain('error_class');

    // A store one migration behind, holding a row, upgraded in place.
    const preDir = path.join(stateDir, 'pre');
    await mkdir(path.join(preDir, 'meta'), { recursive: true });
    const kept = entries.filter((e) => e.idx < creator.idx);
    await writeFile(
      path.join(preDir, 'meta/_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: kept }),
    );
    for (const e of kept) {
      await copyFile(path.join(DRIZZLE_DIR, `${e.tag}.sql`), path.join(preDir, `${e.tag}.sql`));
    }

    const dbPath = path.join(stateDir, 'old.db');
    const old = openDb(dbPath, { migrationsDir: preDir });
    old.sqlite
      .prepare(
        "INSERT INTO lessons (lesson_id, session_id, lesson_type, lesson_level, lesson_status, lesson_scope, statement, valid_from) VALUES ('l1','s','rule','principle','approved','stack-wide','x','2026-01-01')",
      )
      .run();
    old.sqlite.close();

    const upgraded = openDb(dbPath);
    const row = upgraded.sqlite
      .prepare('SELECT error_class FROM lessons WHERE lesson_id = ?')
      .get('l1') as { error_class: string | null };
    upgraded.sqlite.close();
    expect(row.error_class).toBeNull();
  });
});

describe('error_class edge cases', () => {
  it.each([
    ['execution', 'no dot'],
    ['', 'empty'],
    ['nogroup.flaky-test', 'unknown group'],
    ['execution.flaky-test.extra', 'three parts'],
    ['other.', 'empty class'],
  ])('refuses malformed or unknown class %j (%s) and writes nothing', async (bad) => {
    const { sessionId, tip } = await seedSession();
    await expect(
      raiseLessonCandidate(
        {
          statement: 'A malformed class is refused before anything is logged.',
          lessonType: 'rule',
          lessonScope: 'stack-wide',
          provenanceEventIds: [tip],
          errorClass: bad,
        },
        { sessionId, planVersion: 1, causalParent: tip },
        { stateDir },
      ),
    ).rejects.toThrow();
    const logged = await readEvents(sessionId, { stateDir });
    expect(logged.filter((e) => e.record.event_type === 'lesson-candidate-raised')).toHaveLength(0);
  });

  it('keeps the schema free of an inlined error_class enum and a taxonomy annotation', async () => {
    const schema = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'factory/specs/schema/lesson.schema.json'), 'utf8'),
    ) as { properties: Record<string, Record<string, unknown>> };
    const prop = schema.properties.error_class;
    expect(prop).toBeDefined();
    expect(prop?.type).toBe('string');
    expect(prop?.enum).toBeUndefined();
  });

  it('recompiling twice is a fixed point for a classed entry', async () => {
    const { lessonId } = await raise(
      'execution.flaky-test',
      'Recompiling an unchanged store must not move a classed entry.',
    );
    const row = await storeRow(lessonId);
    const first = compileLessons([toCompileInput(row)]);
    expect(compileLessons([toCompileInput(row)], first)).toBe(first);
  });
});
