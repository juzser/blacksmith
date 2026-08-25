// Who counts as the operator.
//
// `actor` is a free string by schema (factory/specs/schema/event.schema.json:
// "Who emitted the event: 'user', 'system', an agent role, or a concrete
// agent_id"). Nothing validates it at write time and nothing enumerated it at
// read time, so every reader that needed to ask "did a person decide this?"
// answered it with a literal of its own. Two did, and they disagreed:
// `db/queries.ts`'s Decisions lens accepted only `'user'`, `lessons.ts`'s plan
// sign-off accepted only `'operator'`. Over the 668 events in the factory's own
// store, `'user'` appears zero times — so the lens was empty on every session
// ever recorded, while its sibling reader worked. This module is the one list
// both of them now read.
//
// Each entry says why it is here, because the set is a judgement about people
// and not a fact about the code:
//
// - 'user' — what waivers.ts, lessons.ts and prompts.ts default to when no
//   actor is supplied, which is how every decision made through the UI is
//   attributed (ui/server never passes one).
// - 'operator' — what docs/guide/operator-guide.md and .claude/skills/bs/
//   SKILL.md hand the operator, in all six of their `--actor` examples,
//   including the `smith waivers apply` line that writes waiver-granted.
// - 'operator-skill' — what the operator's own console passes; 467 of the 668
//   recorded events carry it. It is a skill rather than a person, and it is
//   here anyway: it acts only on a turn the operator took, and the decision
//   events it writes (11 waivers, 15 lesson transitions) are that person's.
//
// What stays out is the point of the guard: 'system' and the agent roles
// (planner, scribe, coder, …) keep writing events of decision-shaped types,
// and a lens that showed those would be reporting the factory's own traffic
// back to the operator as their own choices.
const OPERATOR_ACTORS = new Set(['user', 'operator', 'operator-skill']);

/**
 * Was this event authored by the operator rather than by the factory?
 *
 * Ask this instead of comparing `actor` to a string. A new spelling belongs in
 * OPERATOR_ACTORS above with its reason, where every reader picks it up at
 * once — which is the whole difference between this and what it replaced.
 */
export function isOperatorActor(actor: string | null | undefined): boolean {
  return actor !== null && actor !== undefined && OPERATOR_ACTORS.has(actor);
}

/** The vocabulary itself, for tests and for anything that needs to show it. */
export function operatorActors(): string[] {
  return [...OPERATOR_ACTORS];
}
