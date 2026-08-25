// The e2e screenshot corpus under ui/e2e/__screenshots__ is committed
// evidence, and evidence has to be reproducible: two runs of the suite on one
// commit have to produce the same PNGs. They did not — 29 of 48 changed on a
// no-op re-run, because the fixture builders go through the real event writer
// and it stamps the wall clock (D-235).
//
// ui/e2e/fixtureClock.ts re-stamps the fixture's logs onto a fixed timeline
// after they are written. This is the test that keeps it honest, and it is
// deliberately here rather than in the Playwright suite: a screenshot diff
// would only tell us that something moved, whereas a failure here names the
// JSON path that moved.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixture } from '../../factory/orchestrator/test/db/fixtures.js';
import { FIXTURE_BASE_ISO, FIXTURE_NOW_ISO, normalizeFixtureClock } from '../e2e/fixtureClock.js';
import { buildMultiProjectFixture } from '../e2e/multiProjectFixture.js';
import { AGENT_STALE_AFTER_MS, SESSION_ACTIVE_WITHIN_MS } from '../src/lib/liveness.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Everything global-setup.ts seeds, through the same normalizer, into a scratch dir. */
async function buildNormalizedFixture(): Promise<Map<string, string[]>> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-fixture-determinism-'));
  tempDirs.push(stateDir);
  await buildFixture({ stateDir });
  await buildMultiProjectFixture({ stateDir });
  await normalizeFixtureClock(stateDir);

  const logs = new Map<string, string[]>();
  for (const file of (await readdir(stateDir)).sort()) {
    const raw = await readFile(path.join(stateDir, file), 'utf8');
    logs.set(
      file,
      raw.split('\n').filter((line) => line !== ''),
    );
  }
  return logs;
}

/** Flattens a record to `a.b[0].c` -> primitive, so a diff can name what moved. */
function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      for (const [k, v] of flatten(item, `${prefix}[${i}]`)) out.set(k, v);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      for (const [k, v] of flatten(item, prefix === '' ? key : `${prefix}.${key}`)) out.set(k, v);
    }
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

/**
 * Every way the two builds disagree, as `file#line path` strings. Reported
 * rather than counted: the first time this fails it will be because some new
 * event kind stamped a clock somewhere the normalizer does not reach, and the
 * path is the whole answer.
 */
function drift(a: Map<string, string[]>, b: Map<string, string[]>): string[] {
  const found: string[] = [];
  for (const file of new Set([...a.keys(), ...b.keys()]).values()) {
    const left = a.get(file);
    const right = b.get(file);
    if (!left || !right) {
      found.push(`${file} present in only one build`);
      continue;
    }
    if (left.length !== right.length) {
      found.push(`${file} has ${left.length} lines vs ${right.length}`);
      continue;
    }
    left.forEach((line, i) => {
      const flatLeft = flatten(JSON.parse(line));
      const flatRight = flatten(JSON.parse(right[i] as string));
      for (const key of new Set([...flatLeft.keys(), ...flatRight.keys()]).values()) {
        if (flatLeft.get(key) !== flatRight.get(key)) found.push(`${file}#${i} ${key}`);
      }
    });
  }
  return found;
}

describe('e2e fixture clock', () => {
  it('builds the same event logs twice', async () => {
    const first = await buildNormalizedFixture();
    const second = await buildNormalizedFixture();

    expect(drift(first, second)).toEqual([]);
    // Guards the guard: an empty diff over two empty builds proves nothing.
    expect([...first.values()].flat().length).toBeGreaterThan(0);
  }, 60_000);

  it('starts at the fixed base instant', async () => {
    const logs = await buildNormalizedFixture();
    const firstFile = [...logs.keys()][0] as string;
    const firstEvent = JSON.parse((logs.get(firstFile) as string[])[0] as string) as { ts: string };
    expect(firstEvent.ts).toBe(FIXTURE_BASE_ISO);
  }, 60_000);

  it('leaves the fixture live as of FIXTURE_NOW_ISO', async () => {
    // The pinned clock is only useful if it renders the states the screenshots
    // are of. Past SESSION_ACTIVE_WITHIN_MS every session reads idle and past
    // AGENT_STALE_AFTER_MS every agent reads stale — silently, and only in a
    // PNG. Asserted here so growing the fixture fails a test instead.
    const logs = await buildNormalizedFixture();
    const timestamps = [...logs.values()]
      .flat()
      .map((line) => Date.parse((JSON.parse(line) as { ts: string }).ts));
    const now = Date.parse(FIXTURE_NOW_ISO);
    const newest = Math.max(...timestamps);
    const oldest = Math.min(...timestamps);

    expect(newest).toBeLessThan(now);
    expect(now - newest).toBeLessThan(SESSION_ACTIVE_WITHIN_MS);
    expect(now - oldest).toBeLessThan(AGENT_STALE_AFTER_MS);
  }, 60_000);
});
