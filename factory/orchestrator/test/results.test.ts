import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_OWNED_RESULT_FIELDS,
  ResultError,
  stampResultEnvelope,
} from '../src/results.js';
import { compileSchemas, validateRecord } from '../src/schemas.js';
import { loadTaxonomy } from '../src/taxonomy.js';

const ENVELOPE = {
  taskId: 'epic-1/task-1',
  agent: 'coder',
  provider: 'claude',
  modelTier: 'frontier',
  inputTokens: 19_264,
  outputTokens: 4_118,
};

/** What a worker is allowed to write, per interview N-1 as P9-17 leaves it. */
function agentHalf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_status: 'done',
    structured_output: { summary: 'parsed the quotes' },
    artifacts: [{ type: 'log', path: 'state/logs/task-1.log' }],
    ...extra,
  };
}

describe('stampResultEnvelope', () => {
  it('merges the dispatcher-owned fields onto the agent’s half', () => {
    const stamped = stampResultEnvelope(agentHalf(), ENVELOPE);
    expect(stamped).toMatchObject({
      task_id: 'epic-1/task-1',
      run_status: 'done',
      agent: 'coder',
      provider: 'claude',
      model_tier: 'frontier',
    });
  });

  // The whole point of the item: an agent cannot read its own token meter, so
  // the only honest source is the harness, and the harness talks to the
  // dispatcher (D-18/P9-17).
  it('computes total_tokens rather than accepting a third number', () => {
    const stamped = stampResultEnvelope(agentHalf(), ENVELOPE);
    expect(stamped.token_usage).toEqual({
      input_tokens: 19_264,
      output_tokens: 4_118,
      total_tokens: 23_382,
    });
  });

  it('produces a document that satisfies result.schema.json', () => {
    const taxonomy = loadTaxonomy();
    const schemas = compileSchemas(taxonomy);
    const stamped = stampResultEnvelope(agentHalf({ diff_lines_changed: 42 }), ENVELOPE);
    expect(validateRecord(schemas, taxonomy, 'result', stamped)).toEqual({ valid: true });
  });

  // The result-side equivalent of ORCHESTRATOR_OWNED_FINDING_FIELDS. Wave 2
  // wrote {0,0,0}; wave 3 wrote round numbers that were not measurements. Both
  // pass the schema, because a schema validates shape and never provenance.
  describe('an orchestrator-owned field written by the agent is a breach', () => {
    for (const field of ORCHESTRATOR_OWNED_RESULT_FIELDS) {
      it(`rejects an agent-written ${field}`, () => {
        const value =
          field === 'token_usage'
            ? { input_tokens: 55_000, output_tokens: 12_000, total_tokens: 67_000 }
            : 'whatever-the-agent-said';
        expect(() => stampResultEnvelope(agentHalf({ [field]: value }), ENVELOPE)).toThrow(
          ResultError,
        );
        try {
          stampResultEnvelope(agentHalf({ [field]: value }), ENVELOPE);
        } catch (err) {
          expect((err as ResultError).code).toBe('results.agent-wrote-owned-field');
          expect((err as ResultError).message).toContain(field);
        }
      });
    }

    it('names every offending field at once, not just the first', () => {
      const breach = agentHalf({ task_id: 'epic-1/task-1', model_tier: 'high' });
      expect(() => stampResultEnvelope(breach, ENVELOPE)).toThrow(/task_id.*model_tier/);
    });

    // A `token_usage` of zeros is the wave-2 shape. It is not "empty, so
    // harmless" — it is a measurement the agent could not take, and it lands
    // in the only per-task cost signal the epic has.
    it('rejects a zeroed token_usage as firmly as a fabricated one', () => {
      const zeros = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      expect(() => stampResultEnvelope(agentHalf({ token_usage: zeros }), ENVELOPE)).toThrow(
        /token_usage/,
      );
    });
  });

  describe('the dispatcher’s own numbers are checked too', () => {
    it('refuses a token count that is not a non-negative integer', () => {
      for (const bad of [Number.NaN, -1, 1.5]) {
        expect(() => stampResultEnvelope(agentHalf(), { ...ENVELOPE, inputTokens: bad })).toThrow(
          /input_tokens/,
        );
      }
    });

    it('accepts zero from the dispatcher — a run really can spend nothing', () => {
      const stamped = stampResultEnvelope(agentHalf(), {
        ...ENVELOPE,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(stamped.token_usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  it('refuses a result file that is not a JSON object', () => {
    expect(() => stampResultEnvelope([1, 2, 3], ENVELOPE)).toThrow(ResultError);
    expect(() => stampResultEnvelope(null, ENVELOPE)).toThrow(/object/);
  });

  it('does not mutate the agent’s document', () => {
    const half = agentHalf();
    stampResultEnvelope(half, ENVELOPE);
    expect(Object.keys(half).sort()).toEqual(['artifacts', 'run_status', 'structured_output']);
  });
});
