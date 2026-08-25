// The lint P9-37 left open: `event_type` is a free string at write time, on
// purpose (events.ts:24, projector.ts:23 — a closed enum would reject an
// unknown event and lose the record, which is worse than logging one nobody
// reads). The cost of that choice is that a typo in an emit() call writes
// cleanly and lands in the log as a type no dimension declares, no reader
// folds, and the operator's timeline filters out. Nothing caught it.
//
// This is that catch, and it runs where the cost is cheap: source text, at
// lint time, over literal event types only. Anything computed at runtime is
// still free — that is the design, not an oversight.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREE_TIMELINE_EVENT_TYPES } from '../src/db/queries.js';
import { PAYLOAD_TAGGED_EVENT_TYPES } from '../src/events.js';
import { REPO_ROOT } from '../src/paths.js';
import { loadTaxonomy } from '../src/taxonomy.js';
import {
  FREE_EVENT_TYPES,
  OFF_TIMELINE_EVENT_TYPES,
  scanEventTypeLiterals,
  UNEMITTED_EVENT_TYPES,
} from './helpers/eventTypeScan.js';

const SRC_DIR = path.join(REPO_ROOT, 'factory', 'orchestrator', 'src');

function declaredEventTypes(): Set<string> {
  const taxonomy = loadTaxonomy();
  return new Set([
    ...(taxonomy.dimensions.gate_event ?? []),
    ...(taxonomy.dimensions.graph_event ?? []),
    ...FREE_EVENT_TYPES.map((entry) => entry.eventType),
  ]);
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'event-type-lint-'));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

describe('event type lint (P9-37)', () => {
  it('reports a literal written into an event_type property, with its call site', () => {
    const dir = fixtureDir({
      'a.ts': [
        'export async function record(ctx: Ctx) {',
        '  await appendEvent({',
        '    session_id: ctx.sessionId,',
        "    event_type: 'gate-outome',",
        '    payload: {},',
        '  });',
        '}',
        '',
      ].join('\n'),
    });

    const uses = scanEventTypeLiterals(dir);

    expect(uses).toEqual([{ eventType: 'gate-outome', file: 'a.ts', line: 4, via: 'event_type' }]);
  });

  /**
   * gate.ts's emit() and taskEvents.ts's envelope() take the event type as a
   * positional argument, so a rule that only knows `event_type:` would report
   * "no violations" over files full of them. The writer list is derived from
   * the source being scanned — any helper with an `eventType` parameter is
   * picked up — rather than hand-listed here, because a hand-listed set of
   * writers is the same drift P9-37 is about, one level down.
   */
  it('follows a helper whose parameter is named eventType, at that parameter position', () => {
    const dir = fixtureDir({
      'emit.ts': [
        'async function emit(eventType: string, payload: Record<string, unknown>) {',
        '  await appendEvent({ event_type: eventType, payload });',
        '}',
        '',
        'export async function run() {',
        "  await emit('gate-outcome', { ok: true });",
        "  await emit('not-a-real-gate-event', { ok: false });",
        '}',
        '',
      ].join('\n'),
    });

    const uses = scanEventTypeLiterals(dir);

    expect(uses.map((use) => use.eventType)).toEqual(['gate-outcome', 'not-a-real-gate-event']);
    expect(uses.every((use) => use.via === 'emit')).toBe(true);
  });

  it('reads the literal out of a fallback expression, not just a bare literal', () => {
    const dir = fixtureDir({
      'fallback.ts': [
        'export function envelopeFor(input: EventInput) {',
        "  return { ...input, event_type: input.event_type ?? 'edge-recorded' };",
        '}',
        '',
      ].join('\n'),
    });

    expect(scanEventTypeLiterals(dir).map((use) => use.eventType)).toEqual(['edge-recorded']);
  });

  it('leaves a runtime event type alone — free strings are the design', () => {
    const dir = fixtureDir({
      'runtime.ts': [
        'export async function passthrough(flags: Record<string, string>) {',
        '  await appendEvent({ event_type: flags.type ?? readType(), payload: {} });',
        '}',
        '',
      ].join('\n'),
    });

    expect(scanEventTypeLiterals(dir)).toEqual([]);
  });

  /**
   * The assertion that matters. Every literal event type this orchestrator
   * writes is either a taxonomy value or one of the free types named in
   * FREE_EVENT_TYPES with a reason.
   */
  it('every literal event type in src is declared somewhere', () => {
    const declared = declaredEventTypes();
    const undeclared = scanEventTypeLiterals(SRC_DIR).filter((use) => !declared.has(use.eventType));

    expect(undeclared.map((use) => `${use.file}:${use.line} emits '${use.eventType}'`)).toEqual([]);
  });

  /**
   * P9-22's rule, applied to this file: a check that only speaks up when it
   * has something to say is indistinguishable, later, from a check that never
   * ran. If a refactor moves every write behind a shape these rules do not
   * recognise, the test above starts passing over nothing. These two fail
   * instead.
   */
  it('actually sees the writes it claims to lint', () => {
    const uses = scanEventTypeLiterals(SRC_DIR);

    expect(new Set(uses.map((use) => use.eventType)).size).toBeGreaterThanOrEqual(25);
    expect(uses.some((use) => use.via === 'event_type')).toBe(true);
    expect(uses.some((use) => use.via !== 'event_type')).toBe(true);
  });

  /**
   * queries.ts keeps its own four-value list of non-taxonomy types to show on
   * the operator's timeline. Two hand-kept lists of event types that never
   * check each other is exactly how P9-37 started, so they check each other
   * here: a typo in either one names a type the other has never heard of.
   */
  it('the timeline free list names types this lint knows', () => {
    const known = declaredEventTypes();
    expect(FREE_TIMELINE_EVENT_TYPES.filter((eventType) => !known.has(eventType))).toEqual([]);
  });

  /**
   * events.ts's payload maps are the third hand-kept list, and the one with
   * the quietest failure: a rule keyed on an event type nobody writes never
   * fires, so the payload it was meant to validate goes unchecked and the
   * suite stays green about it.
   */
  it('every payload-tagged event type is one this orchestrator writes', () => {
    const known = declaredEventTypes();
    const written = new Set(scanEventTypeLiterals(SRC_DIR).map((use) => use.eventType));

    expect(PAYLOAD_TAGGED_EVENT_TYPES.filter((eventType) => !known.has(eventType))).toEqual([]);
    expect(PAYLOAD_TAGGED_EVENT_TYPES.filter((eventType) => !written.has(eventType))).toEqual([]);
  });

  /**
   * The free list is an allowlist, and an allowlist nobody prunes is how a
   * lint stops meaning anything: an entry for a type that was deleted years
   * ago reads as a considered decision. Each entry says where its type is
   * written, and both halves of that claim are checked.
   */
  it('no free-list entry has outlived the code it describes', () => {
    const written = new Set(scanEventTypeLiterals(SRC_DIR).map((use) => use.eventType));

    expect(
      FREE_EVENT_TYPES.filter(
        (entry) => entry.writtenBy === 'src' && !written.has(entry.eventType),
      ).map((entry) => `${entry.eventType} is listed as written in src, and is not`),
    ).toEqual([]);
    expect(
      FREE_EVENT_TYPES.filter(
        (entry) => entry.writtenBy === 'cli' && written.has(entry.eventType),
      ).map((entry) => `${entry.eventType} is listed as written outside src, and is written in it`),
    ).toEqual([]);
    for (const entry of FREE_EVENT_TYPES) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  /**
   * The same check, run backwards. Everything above asks "is this literal
   * declared?"; a vocabulary also rots the other way, and more quietly: a value
   * sits in the taxonomy that nothing has ever emitted. Readers branch on it,
   * docs describe it, agents are told it exists — and the branch is dead. The
   * two the factory has today are both half-built features rather than dead
   * values, which is exactly why neither was noticeable: `plan-version-created`
   * is emitted and `plan-version-superseded` is not, so the old version is
   * never marked; `task-added` and `task-superseded` are both emitted and
   * folded while `task-split`, the third verb of the same sentence in the
   * architecture, is neither.
   */
  it('every taxonomy event value is emitted, or says why it is not', () => {
    const taxonomy = loadTaxonomy();
    const declared = [
      ...(taxonomy.dimensions.graph_event ?? []),
      ...(taxonomy.dimensions.gate_event ?? []),
    ];
    const written = new Set(scanEventTypeLiterals(SRC_DIR).map((use) => use.eventType));
    const excused = new Set(UNEMITTED_EVENT_TYPES.map((entry) => entry.eventType));

    expect(
      declared
        .filter((eventType) => !written.has(eventType) && !excused.has(eventType))
        .map((eventType) => `taxonomy declares '${eventType}' and nothing emits it`),
    ).toEqual([]);
  });

  /**
   * And the allowlist for it, pruned by the same rule as FREE_EVENT_TYPES: an
   * excuse for a value that is now emitted is worse than no excuse, because it
   * reads as "still unbuilt" about something that shipped.
   */
  it('no unemitted-list entry has outlived the gap it describes', () => {
    const taxonomy = loadTaxonomy();
    const declared = new Set([
      ...(taxonomy.dimensions.graph_event ?? []),
      ...(taxonomy.dimensions.gate_event ?? []),
    ]);
    const written = new Set(scanEventTypeLiterals(SRC_DIR).map((use) => use.eventType));

    expect(
      UNEMITTED_EVENT_TYPES.filter((entry) => written.has(entry.eventType)).map(
        (entry) => `${entry.eventType} is listed as unemitted, and src emits it`,
      ),
    ).toEqual([]);
    expect(
      UNEMITTED_EVENT_TYPES.filter((entry) => !declared.has(entry.eventType)).map(
        (entry) =>
          `${entry.eventType} is listed as unemitted, and the taxonomy no longer declares it`,
      ),
    ).toEqual([]);
    for (const entry of UNEMITTED_EVENT_TYPES) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  /**
   * The third direction, and the one with a person on the other end. Declared
   * and emitted still leaves "seen": timeline() filters on the taxonomy plus
   * FREE_TIMELINE_EVENT_TYPES, so a free type absent from that list is written
   * correctly, folded correctly, and never rendered. Taxonomy values are safe
   * by construction — timelineEventTypes() spreads both dimensions — which is
   * why only the free list needs a guard.
   */
  it('every free event type reaches the operator timeline, or says why it does not', () => {
    const shown = new Set(FREE_TIMELINE_EVENT_TYPES);
    const excused = new Set(OFF_TIMELINE_EVENT_TYPES.map((entry) => entry.eventType));

    expect(
      FREE_EVENT_TYPES.filter(
        (entry) => !shown.has(entry.eventType) && !excused.has(entry.eventType),
      ).map(
        (entry) =>
          `'${entry.eventType}' is written and never shown: add it to FREE_TIMELINE_EVENT_TYPES or excuse it`,
      ),
    ).toEqual([]);
  });

  /**
   * Pruned by the same rule as the other two allowlists. An excuse that
   * outlives its gap is the worse failure here: it reads as a deliberate
   * decision to hide something the operator can, in fact, already see.
   */
  it('no off-timeline entry has outlived the gap it describes', () => {
    const shown = new Set(FREE_TIMELINE_EVENT_TYPES);
    const free = new Set(FREE_EVENT_TYPES.map((entry) => entry.eventType));

    expect(
      OFF_TIMELINE_EVENT_TYPES.filter((entry) => shown.has(entry.eventType)).map(
        (entry) => `${entry.eventType} is excused from the timeline, and the timeline shows it`,
      ),
    ).toEqual([]);
    expect(
      OFF_TIMELINE_EVENT_TYPES.filter((entry) => !free.has(entry.eventType)).map(
        (entry) => `${entry.eventType} is excused from the timeline, and nothing writes it`,
      ),
    ).toEqual([]);
    for (const entry of OFF_TIMELINE_EVENT_TYPES) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});
