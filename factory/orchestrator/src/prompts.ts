import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';

/**
 * The writer for `user_prompt` — the operator's own words on the timeline.
 *
 * D-142: this type had five readers and no writer. The `prompts` table
 * (db/schema.ts), the projector's fold (db/projector.ts), the Decisions lens
 * (db/queries.ts isDecisionEntry), the escalation window (escalation.ts) and
 * the UI's Prompts filter all consume it; nothing in this repo produced one,
 * so the factory's own log held 668 events and zero prompts. Every one of
 * those five sites read as tested behaviour while answering nothing.
 *
 * The fork the finding poses — write it or retire it — is settled by
 * docs/specs/black-smith-architecture.md, which calls the interleaved
 * user_prompt/dispatch_decision timeline "a hard requirement" and defines
 * this event as the operator's message stored *verbatim*. Retiring the type
 * would contradict the spec, so it gets a writer.
 *
 * Deliberately thin, on the taskEvents.ts pattern: this module owns the
 * payload shape and the one refusal, and nothing else. It makes no decision —
 * the decision is the operator's, and it was made before the text got here.
 */
export class PromptError extends SmithError {}

/**
 * Append one `user_prompt`, returning the stored event.
 *
 * The event id is the return value that matters: `dispatch_decision` carries
 * `parent_prompt_id`, and that is the edge which makes "this work happened
 * because a person asked for it" a fact the timeline can draw rather than an
 * ordering the reader infers from timestamps.
 *
 * `actor` defaults to `'user'`, which is what this repo means by the operator
 * — waivers.ts and ui/server's lesson routes default to it, queries.ts's
 * Decisions lens selects on it, and event.schema.json names it first. A
 * caller with a different word for the same person can pass their own.
 */
export async function recordUserPrompt(
  text: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  // Only the check trims. What gets stored is what the operator typed, down
  // to the trailing newline a heredoc leaves behind — "verbatim" is the
  // spec's word, and a writer that tidied the text would be the first thing
  // between the operator and their own record.
  if (text.trim() === '') {
    throw new PromptError(
      'prompts.empty-prompt',
      'A user prompt needs text: nothing but whitespace was given, so no event was written.',
      { session_id: ctx.sessionId },
    );
  }

  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: 'user_prompt',
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      // `prompt` and not `text`: the projector accepts both, but this is the
      // one it reads first and the one every fixture and query already uses.
      // A writer that picked the fallback would make the fallback load-bearing.
      payload: { prompt: text },
    },
    opts,
  );
}
