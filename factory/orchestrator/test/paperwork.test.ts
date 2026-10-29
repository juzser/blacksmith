import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.js';
import { runGate } from '../src/gate.js';
import {
  artifactMissing,
  clean,
  createWorld,
  type FixtureBuilder,
  graderOutsideStructured,
  screenshotMisnamed,
  uncommitted,
  unstamped,
  type World,
} from './helpers/paperworkFixtures.js';

describe('gate characterization: the lineage runGate writes (pinned before the refactor)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  /** The gate's own events after the fixture setup, with machine-specific strings made stable. */
  async function lineageOf(build: FixtureBuilder) {
    const input = await build(w);
    const before = (await readEvents(w.sessionId, w.opts())).length;
    const outcome = await runGate(input, w.ctx(), w.opts());
    const events = (await readEvents(w.sessionId, w.opts())).slice(before);
    const stable = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value)
          .replace(/\/[^"]*?bs-paperwork-(state|wt|art|else)-[A-Za-z0-9]+/g, '<$1>')
          .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
          .replace(/"(duration_ms|elapsed_ms)":\d+/g, '"$1":0'),
      );
    return {
      outcome: outcome.outcome,
      reason: outcome.outcome === 'blocked' ? outcome.reason : null,
      events: events.map((e) => ({
        event_type: e.record.event_type,
        payload: stable(e.record.payload),
      })),
    };
  }

  it('clean fixture', async () => {
    expect(await lineageOf(clean)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "budget-check-result",
            "payload": {
              "overruns": [],
              "status": "not-declared",
              "tokensUsed": 150,
            },
          },
          {
            "event_type": "testgate-result",
            "payload": {
              "pass": true,
              "results": [
                {
                  "exitCode": 0,
                  "lock_wait_ms": 0,
                  "name": "noop",
                  "pass": true,
                  "tail": "",
                },
              ],
            },
          },
          {
            "event_type": "severity-decisions",
            "payload": {
              "decisions": [],
              "lesson_ids_escalating": [],
              "lessons_escalating": 0,
              "lessons_loaded": 0,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "pass",
              "reason": null,
            },
          },
        ],
        "outcome": "pass",
        "reason": null,
      }
    `);
  });

  it('schema-invalid fixture', async () => {
    expect(await lineageOf(unstamped)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [
                {
                  "message": "must have required property 'task_id'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'token_usage'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'agent'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'provider'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'model_tier'",
                  "path": "/",
                },
              ],
              "valid": false,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "schema-invalid",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "schema-invalid",
      }
    `);
  });

  it('artifacts-missing fixture', async () => {
    expect(await lineageOf(artifactMissing)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [
                {
                  "path": "never-written.txt",
                  "type": "log",
                },
              ],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 1,
              "home": "<art>/epic-1/task-1",
              "issues": [
                {
                  "declared": "never-written.txt",
                  "problem": "missing",
                  "resolved": "<art>/epic-1/task-1/never-written.txt",
                },
              ],
              "ok": false,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "artifacts-missing",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "artifacts-missing",
      }
    `);
  });

  it('not-committed fixture', async () => {
    expect(await lineageOf(uncommitted)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": null,
              "branch": "smith/epic-1/task-1",
              "certified": false,
              "commits_ahead": null,
              "dirty": [
                "src.ts",
              ],
              "head": "<sha>",
              "reason": "uncommitted-work",
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "not-committed",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "not-committed",
      }
    `);
  });

  it('grader-invalid fixture', async () => {
    expect(await lineageOf(graderOutsideStructured)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "grader-verdict",
            "payload": {
              "errors": [
                {
                  "message": "grader verdict must be at .structured_output (round, criteria, overall), per the grader Output contract",
                  "path": "/structured_output",
                },
              ],
              "failed_criteria": [],
              "overall": null,
              "round": null,
              "run_status": null,
              "verdict": "invalid",
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "grader-invalid",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "grader-invalid",
      }
    `);
  });

  it('screenshots-missing fixture', async () => {
    expect(await lineageOf(screenshotMisnamed)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "screenshots-missing",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "screenshots-missing",
      }
    `);
  });
});
