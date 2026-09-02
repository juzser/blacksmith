import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileSchemas, SchemaError, validateRecord } from '../src/schemas.js';
import { loadTaxonomy } from '../src/taxonomy.js';

describe('compileSchemas + validateRecord', () => {
  const taxonomy = loadTaxonomy();
  const schemas = compileSchemas(taxonomy);

  it('compiles all five committed schemas', () => {
    for (const name of ['event', 'task-spec', 'finding', 'lesson', 'result']) {
      expect(schemas.has(name), `missing compiled schema "${name}"`).toBe(true);
    }
  });

  it('throws SchemaError for an unknown schema name', () => {
    expect(() => validateRecord(schemas, taxonomy, 'not-a-schema', {})).toThrow(SchemaError);
  });

  it('accepts a schema-valid, taxonomy-valid event record', () => {
    const result = validateRecord(schemas, taxonomy, 'event', {
      ts: new Date().toISOString(),
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a schema-invalid event (missing required field)', () => {
    const result = validateRecord(schemas, taxonomy, 'event', {
      ts: new Date().toISOString(),
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'session-start',
      // plan_version missing
      causal_parent: null,
      payload: {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a schema-valid event whose x-taxonomy edge fields are unknown values', () => {
    const result = validateRecord(schemas, taxonomy, 'event', {
      ts: new Date().toISOString(),
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'edge-recorded',
      plan_version: 1,
      causal_parent: 'sess-1#0',
      payload: {},
      edge: {
        edge_type: 'not-a-real-edge-type',
        edge_provenance: 'observed',
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.message.includes('edge_type'))).toBe(true);
    }
  });

  it('accepts a schema-valid event with a valid edge', () => {
    const result = validateRecord(schemas, taxonomy, 'event', {
      ts: new Date().toISOString(),
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'edge-recorded',
      plan_version: 1,
      causal_parent: 'sess-1#0',
      payload: {},
      edge: {
        edge_type: 'artifact',
        edge_provenance: 'observed',
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a schema-valid task-spec with an unknown taxonomy value (case)', () => {
    const result = validateRecord(schemas, taxonomy, 'task-spec', {
      task_id: 'epic-1/task-1',
      epic_id: 'epic-1',
      plan_version: 1,
      objective: 'Do the thing.',
      output_schema_ref: 'result.schema.json',
      acceptance_criteria: ['it works'],
      claims: ['src/foo/**'],
      budget: { tokens: 1000, diff_lines: 100, max_turns: 10 },
      contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
      case: 'not-a-real-case',
      origin: 'user',
      task_status: 'todo',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === '/case')).toBe(true);
    }
  });

  it('accepts a fully valid task-spec', () => {
    const result = validateRecord(schemas, taxonomy, 'task-spec', {
      task_id: 'epic-1/task-1',
      epic_id: 'epic-1',
      plan_version: 1,
      objective: 'Do the thing.',
      output_schema_ref: 'result.schema.json',
      acceptance_criteria: ['it works'],
      claims: ['src/foo/**'],
      budget: { tokens: 1000, diff_lines: 100, max_turns: 10 },
      contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
      case: 'feature',
      origin: 'user',
      task_status: 'todo',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a lesson with an invalid date-time (ajv-formats)', () => {
    const result = validateRecord(schemas, taxonomy, 'lesson', {
      lesson_id: 'lesson-1',
      lesson_type: 'fact',
      lesson_level: 'principle',
      lesson_status: 'candidate',
      lesson_scope: 'stack-wide',
      statement: 'Never edit lockfiles in workers.',
      valid_from: 'not-a-date',
      superseded_by: null,
      provenance_event_ids: ['evt-1'],
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a lesson with the optional Phase-7 finding_category/claim_path fields', () => {
    const result = validateRecord(schemas, taxonomy, 'lesson', {
      lesson_id: 'lesson-2026-08-01-003',
      lesson_type: 'rule',
      lesson_level: 'principle',
      lesson_status: 'approved',
      lesson_scope: 'claim-path',
      statement: 'Never hand-edit a lockfile in a worker.',
      valid_from: '2026-08-01T00:00:00.000Z',
      superseded_by: null,
      provenance_event_ids: ['evt-1'],
      finding_category: 'maintainability',
      claim_path: '**/pnpm-lock.yaml',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a lesson whose finding_category is not a real taxonomy value', () => {
    const result = validateRecord(schemas, taxonomy, 'lesson', {
      lesson_id: 'lesson-1',
      lesson_type: 'rule',
      lesson_level: 'principle',
      lesson_status: 'approved',
      lesson_scope: 'claim-path',
      statement: 'Never hand-edit a lockfile in a worker.',
      valid_from: '2026-08-01T00:00:00.000Z',
      superseded_by: null,
      provenance_event_ids: ['evt-1'],
      finding_category: 'not-a-real-category',
    });
    expect(result.valid).toBe(false);
  });
});

describe('x-taxonomy under an array', () => {
  // The committed schemas put no `x-taxonomy` under an array today, so this
  // needs its own schema dir. That absence is why the hole is quiet, not why
  // it is safe: `findings` is an array of records that carry a severity in
  // every other place the factory writes one.
  const taxonomy = loadTaxonomy();
  let dir: string;
  let schemas: ReturnType<typeof compileSchemas>;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-schemas-'));
    writeFileSync(
      path.join(dir, 'report.schema.json'),
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          top_severity: { type: 'string', 'x-taxonomy': 'severity' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { severity: { type: 'string', 'x-taxonomy': 'severity' } },
            },
          },
          seen: { type: 'array', items: { type: 'string', 'x-taxonomy': 'severity' } },
        },
      }),
    );
    schemas = compileSchemas(taxonomy, dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks the tag on a record inside an array, not only one at the top', () => {
    // Same bogus value in both places. The one at the top is caught, and the
    // one inside the array is the whole reason the annotation was written.
    const result = validateRecord(schemas, taxonomy, 'report', {
      top_severity: 'S2-major',
      findings: [{ severity: 'S1-stop-the-line' }, { severity: 'not-a-severity' }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe('/findings/1/severity');
  });

  it('names which element, the way ajv does', () => {
    // `/findings/[]/severity` would say a severity is wrong without saying
    // which one — unactionable on a list of twenty, and inconsistent with the
    // instancePath the schema half of this same result already reports.
    const result = validateRecord(schemas, taxonomy, 'report', {
      findings: [{ severity: 'nope' }, { severity: 'S3-minor' }, { severity: 'also-nope' }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.path)).toEqual([
      '/findings/0/severity',
      '/findings/2/severity',
    ]);
  });

  it('checks a tag annotated on the array items themselves', () => {
    // An array of tag strings annotates `items` directly — there is no
    // property under it to hang the annotation on.
    const result = validateRecord(schemas, taxonomy, 'report', {
      seen: ['S3-minor', 'S9-imaginary'],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe('/seen/1');
  });

  it('accepts valid tags in all three positions', () => {
    const result = validateRecord(schemas, taxonomy, 'report', {
      top_severity: 'S4-nit',
      findings: [{ severity: 'S1-stop-the-line' }, { severity: 'S3-minor' }],
      seen: ['S2-major'],
    });
    expect(result).toEqual({ valid: true });
  });

  it('stays quiet when the array is absent or empty', () => {
    // Absence is still the schema's job. A pointer that resolves to nothing
    // must not become an error just because it now knows how to descend.
    expect(validateRecord(schemas, taxonomy, 'report', { top_severity: 'S4-nit' })).toEqual({
      valid: true,
    });
    expect(validateRecord(schemas, taxonomy, 'report', { findings: [], seen: [] })).toEqual({
      valid: true,
    });
  });
});

describe('an x-taxonomy annotation the walker cannot reach', () => {
  // collectTaxonomyPointers reads `properties` and `items`. Every other place
  // a subschema can live -- `$defs` behind a `$ref`, a `oneOf` branch, an
  // `allOf` fragment, `patternProperties` -- it walks straight past, and an
  // annotation there was simply never checked. Nothing said so: the record
  // validated, the unknown tag went in, and the only symptom was a taxonomy
  // that stopped being enforced on one field.
  //
  // mcp-manifest.schema.json already uses `$defs`, `$ref`, `oneOf` and
  // `allOf`, so the committed set is one annotation away from that. Compile
  // now refuses rather than resolving references: resolution is a second
  // schema engine to own, and an error at startup tells the schema author the
  // one thing they need to know, at the moment they need it.
  const taxonomy = loadTaxonomy();
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-schemas-reach-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSchema(schema: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'report.schema.json'), JSON.stringify(schema));
  }

  it('refuses to compile one hidden behind a $ref into $defs', () => {
    writeSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { finding: { $ref: '#/$defs/finding' } },
      $defs: {
        finding: {
          type: 'object',
          properties: { severity: { type: 'string', 'x-taxonomy': 'severity' } },
        },
      },
    });

    let thrown: unknown;
    try {
      compileSchemas(taxonomy, dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaError);
    const err = thrown as SchemaError;
    expect(err.code).toBe('schema.unreachable-taxonomy');
    // Says which annotation, not just that there is one: on a schema with
    // thirty of them the operator cannot act on the count alone.
    expect(err.details.paths).toEqual(['/$defs/finding/properties/severity']);
    expect(err.details.schema).toBe('report');
  });

  it('refuses one inside a oneOf branch', () => {
    writeSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      oneOf: [
        { properties: { severity: { type: 'string', 'x-taxonomy': 'severity' } } },
        { properties: { note: { type: 'string' } } },
      ],
    });

    expect(() => compileSchemas(taxonomy, dir)).toThrow(SchemaError);
  });

  it('still compiles one it does reach, under properties and under items', () => {
    // The guard has to name what the walker missed, not what it found --
    // otherwise it fires on every schema that annotates anything at all.
    writeSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        severity: { type: 'string', 'x-taxonomy': 'severity' },
        seen: { type: 'array', items: { type: 'string', 'x-taxonomy': 'severity' } },
      },
    });

    const schemas = compileSchemas(taxonomy, dir);
    expect(schemas.get('report')?.taxonomyPointers).toHaveLength(2);
  });

  it('compiles the committed schemas, which annotate nothing out of reach', () => {
    expect(() => compileSchemas(taxonomy)).not.toThrow();
  });
});

// D-197. `requireSessionIdShape` (events.ts) has guarded the shape at `logPath`
// since 2026-08-19, so it is on every read and every write -- but the schema
// still typed `session_id` as a bare string, and a hand-written event was the
// one door that skipped the check. Writing the same structural rule down here
// costs nothing on the way past: an id the reader can already open satisfies it
// by construction, so no record on disk can be rejected by adding it.
describe('event.session_id names one log file', () => {
  const taxonomy = loadTaxonomy();
  const schemas = compileSchemas(taxonomy);

  const event = (sessionId: unknown) => ({
    ts: new Date().toISOString(),
    session_id: sessionId,
    actor: 'system',
    event_type: 'session-start',
    plan_version: 1,
    causal_parent: null,
    payload: {},
  });

  it.each([
    ['a path separator', '../escape'],
    ['a nested segment', 'a/b'],
    ['a trailing separator', 'sess-1/'],
    ['the empty string', ''],
    ['a lone dot', '.'],
    ['a lone dot-dot', '..'],
  ])('rejects %s', (_label, sessionId) => {
    expect(validateRecord(schemas, taxonomy, 'event', event(sessionId)).valid).toBe(false);
  });

  // Structural, not a charset -- the same non-over-reach events.ts pins. `#` is
  // legal because parseEventId splits on the LAST one deliberately, and a `#`
  // cannot move a file.
  it.each([
    ['a plain id', 'sess-1'],
    ['one containing a hash', 'sess#1'],
    ['one containing a dot', 'dogfood-4.1'],
    ['one containing spaces', 'my session'],
  ])('accepts %s', (_label, sessionId) => {
    expect(validateRecord(schemas, taxonomy, 'event', event(sessionId)).valid).toBe(true);
  });
});

// D-193. The gate refuses an empty artifact path, which is the right layer for
// the containment half -- JSON Schema cannot express "inside this directory".
// The empty string is the half it *can* express, and a worker deserves a
// validation error at the envelope rather than a gate block one step later.
describe('result.artifacts[].path is a path, not the empty string', () => {
  const taxonomy = loadTaxonomy();
  const schemas = compileSchemas(taxonomy);

  const result = (artifactPath: string) => ({
    task_id: 'epic-1/task-1',
    run_status: 'done',
    structured_output: {},
    artifacts: [{ type: 'diff', path: artifactPath }],
    token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    agent: 'coder',
    provider: 'claude',
    model_tier: 'mid',
  });

  it('rejects an empty path', () => {
    expect(validateRecord(schemas, taxonomy, 'result', result('')).valid).toBe(false);
  });

  it('accepts a relative path under the artifact home', () => {
    expect(validateRecord(schemas, taxonomy, 'result', result('diff.patch')).valid).toBe(true);
  });
});
