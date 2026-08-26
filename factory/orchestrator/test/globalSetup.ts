// Builds dist/ once, before the first test file, for the whole run.
//
// Two things put this here rather than in a `beforeAll`.
//
// The first is correctness under parallelism. `cli.test.ts` used to run
// `pnpm build` in its own `beforeAll`, which was fine while it was the only
// file that needed a built CLI. It is not any more (`guardHook.test.ts` execs
// the same `dist/cli.js` through the hook), and vitest runs files in parallel
// workers — so a second `beforeAll` build would mean two `tsc` processes
// emitting into the same `dist/` while a third process is spawning `node
// dist/cli.js` out of it. Nothing in that arrangement is ordered, and the
// failure it produces is intermittent and blames the wrong file.
//
// The second is how a build failure should be reported, which is the argument
// setup.ts already makes about a wrong Node: a `beforeAll` that throws turns
// its file into a *failed suite* and marks every test in it skipped. That is
// how a missing `pnpm` came back as "2 failed, 182 skipped" — a headline that
// reads like a couple of broken tests when in fact none of the CLI surface was
// exercised at all. A stale or absent `dist/` makes every CLI assertion
// meaningless, so it fails the run, once, before anything green can be
// printed next to it.
import path from 'node:path';
import { assertRuntimeSupported } from '../src/runtime.js';
import { runOrThrow } from './helpers/process.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export function setup(): void {
  // Same refusal as setup.ts, one layer earlier: this process spawns a build
  // before any worker exists to check its own runtime.
  assertRuntimeSupported();
  runOrThrow('pnpm', ['build'], { cwd: REPO_ROOT });
}
