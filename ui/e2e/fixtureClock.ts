// The screenshot corpus under __screenshots__/phase-6b is committed evidence,
// and evidence has to be reproducible: running the suite twice on the same
// commit has to produce the same PNGs. It did not — 29 of 48 changed on a
// no-op re-run (D-235).
//
// The cause is not the screenshots, it is the fixture. The builders call the
// real event writer, which stamps `ts: new Date().toISOString()`
// (factory/orchestrator/src/events.ts), so every run laid down a different
// timeline and every elapsed/relative label in the UI rendered a different
// string against it.
//
// The writer keeps its wall clock. Letting a caller dictate a recorded `ts`
// is the fabrication hazard the audit log exists to prevent, and a test
// convenience is not worth opening it. Instead the fixture's own logs are
// re-stamped after they are written and before they are projected: an event
// id is `${session_id}#${index}` and no field in the record is derived from
// `ts`, so re-stamping changes nothing else.
//
// The other half of the fix lives in ./harness.ts, which pins the browser's
// clock to FIXTURE_NOW_ISO — a fixed timeline is only half a fixed label.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** First event of the normalized timeline. Any fixed instant would do. */
export const FIXTURE_BASE_ISO = '2026-01-15T09:00:00.000Z';

/** Spacing between consecutive events of one session. */
export const FIXTURE_STEP_MS = 1000;

/**
 * What the browser believes "now" is while the suite runs (./harness.ts).
 *
 * Twelve minutes after the base, which puts it inside liveness.ts's
 * SESSION_ACTIVE_WITHIN_MS (15m) of the last event of a fixture this size —
 * so the sessions still read as running — and far inside AGENT_STALE_AFTER_MS
 * (4h), so live agents still read as working. The determinism test asserts
 * both, rather than leaving them to be discovered in a screenshot.
 */
export const FIXTURE_NOW_ISO = '2026-01-15T09:12:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Re-stamp every event log in `stateDir` onto the fixed timeline.
 *
 * Sessions in this fixture run concurrently, so they share one timeline
 * rather than being laid end to end: each file starts at the base and steps
 * by FIXTURE_STEP_MS, offset from its neighbours by a fraction of one step so
 * that no two events collide and no sort has to break a tie.
 */
export async function normalizeFixtureClock(stateDir: string): Promise<void> {
  const files = (await readdir(stateDir)).filter((f) => f.endsWith('.jsonl')).sort();
  const base = Date.parse(FIXTURE_BASE_ISO);
  const now = Date.parse(FIXTURE_NOW_ISO);
  const offsetStep = Math.floor(FIXTURE_STEP_MS / (files.length + 1));

  for (const [fileIndex, file] of files.entries()) {
    const filePath = path.join(stateDir, file);
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');

    const restamped = lines.map((line, i) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      const at = base + i * FIXTURE_STEP_MS + fileIndex * offsetStep;
      if (at >= now) {
        // Silently running past "now" would render every label as "just now"
        // and every session as idle, which is exactly the kind of quiet
        // wrongness a fixed clock is supposed to remove.
        throw new Error(
          `normalizeFixtureClock: ${file} has outgrown the fixed timeline — event ${i} lands at or after FIXTURE_NOW_ISO (${FIXTURE_NOW_ISO}). Move FIXTURE_NOW_ISO later or shorten FIXTURE_STEP_MS.`,
        );
      }
      const ts = new Date(at).toISOString();
      record.ts = ts;
      // Waiver grants stamp their own clock into the payload
      // (lessons.ts's `valid_from`), so the record's ts is not the only one.
      const payload = record.payload;
      if (isRecord(payload) && typeof payload.valid_from === 'string') payload.valid_from = ts;
      return JSON.stringify(record);
    });

    await writeFile(filePath, restamped.length > 0 ? `${restamped.join('\n')}\n` : '', 'utf8');
  }
}
