import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from './helpers/process.js';

// `.claude/hooks/guard.sh` runs on every Bash/Write/Edit/MultiEdit/NotebookEdit
// call an agent session makes, so whatever it execs is the single hottest path
// in this factory — it runs more often than any other code here, by orders of
// magnitude. It used to exec `dist/cli.js policy hook`, and cli.ts imports the
// whole orchestrator at module scope: 64 top-level imports, `db/projector.js`
// among them, which pulls in drizzle-orm. Measured on the machine this was
// written on, that cost 1.38s per tool call to perform ~39ms of policy work —
// the other 1.3s was a database layer the hook never touches, loaded and
// discarded on every single guarded action.
//
// `dist/policyHook.js` is that path with nothing else attached. These tests pin
// the two properties that make it worth having: it must decide *exactly* what
// the CLI decided (a faster hook that answers differently is a broken hook),
// and its import graph must stay free of the database layer, or it silently
// becomes the thing it replaced.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DIST = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist');
const HOOK_PATH = path.join(DIST, 'policyHook.js');
const CLI_PATH = path.join(DIST, 'cli.js');

function payload(command: string, cwd: string = REPO_ROOT): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
}

function runHook(input: string): { stdout: string; status: number } {
  const run = runProcess('node', [HOOK_PATH], { input });
  return { stdout: run.stdout.trim(), status: run.status as number };
}

function runCli(input: string): { stdout: string; status: number } {
  const run = runProcess('node', [CLI_PATH, 'policy', 'hook'], { input });
  return { stdout: run.stdout.trim(), status: run.status as number };
}

/**
 * Walks the built ESM graph from `entry`, following relative specifiers only,
 * and returns every bare (package) specifier reachable from it.
 *
 * Static rather than timed on purpose. The property under test is "the hook
 * does not load the database layer", and a wall-clock assertion would express
 * that as "the hook is fast", which is a different claim that a loaded CI box
 * can falsify without anything being wrong. Reading the graph answers the
 * actual question and cannot flake.
 */
function bareSpecifiersFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    // Matches `from '…'` in both static imports and re-exports, which is every
    // form tsc emits for this codebase.
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), spec));
      } else if (!spec.startsWith('node:')) {
        bare.add(spec);
      }
    }
  }
  return bare;
}

describe('dist/policyHook.js — the guard hook entry point', () => {
  it('is built', () => {
    // A missing entry point would make every parity assertion below vacuous,
    // so it is stated once, first, rather than inferred from a confusing
    // downstream failure.
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  // The reason this entry point exists. `db/projector.js` and drizzle-orm are
  // named explicitly because they are what was actually costing the 1.3s, but
  // the assertion is the general one: no package outside the handful the
  // policy layer genuinely needs.
  it('does not reach the database layer', () => {
    const bare = bareSpecifiersFrom(HOOK_PATH);
    expect([...bare].filter((s) => s.includes('drizzle'))).toEqual([]);
    expect([...bare].filter((s) => s.includes('sqlite'))).toEqual([]);
  });

  // Parity, case by case, against the command it replaces. Each of these is a
  // path guard.sh distinguishes, so a divergence in any one of them changes
  // what an agent is allowed to do.
  const cases: Array<{ name: string; input: string }> = [
    {
      name: 'a rule violation (unbounded rm) — deny envelope, exit 0',
      input: payload('rm -rf factory/orchestrator/src'),
    },
    {
      name: 'the same violation spelled with separate flags',
      input: payload('rm -r -f factory/orchestrator/src'),
    },
    {
      name: 'an allowed command — silence, exit 0',
      input: payload('echo hello'),
    },
    {
      name: 'a removal under an allowed root — silence, exit 0',
      input: payload('rm -rf workspaces/scratch'),
    },
    {
      name: 'a Write payload, which carries file_path and no command',
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(REPO_ROOT, 'AGENTS.md') },
        cwd: REPO_ROOT,
      }),
    },
  ];

  for (const c of cases) {
    it(`decides identically to \`cli.js policy hook\`: ${c.name}`, () => {
      const hook = runHook(c.input);
      const cli = runCli(c.input);
      expect(hook.stdout).toBe(cli.stdout);
      expect(hook.status).toBe(cli.status);
    });
  }

  // The malformed case is the one with history behind it: guard.sh's bash
  // predecessor turned "cannot parse this" into a silent allow, invisibly, for
  // eight phases. The contract is a non-zero exit and no decision envelope, so
  // the shim escalates to `ask` rather than inventing a verdict. A faster
  // entry point that got this wrong would reintroduce exactly that bug.
  it('exits non-zero on an unparseable payload, printing no decision', () => {
    const hook = runHook('this is not json');
    expect(hook.status).not.toBe(0);
    expect(hook.stdout).not.toContain('permissionDecision');
  });

  it('never emits an allow envelope, on any path', () => {
    for (const c of cases) {
      expect(runHook(c.input).stdout).not.toContain('"permissionDecision":"allow"');
    }
  });
});
