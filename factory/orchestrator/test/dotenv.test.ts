import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/dotenv.js';
import { DOTENV_PATH, REPO_ROOT } from '../src/paths.js';
import { apiKeyPresent } from '../src/preconditions.js';

// `docs/runbooks/providers.md` tells an operator to put DEEPSEEK_API_KEY in
// `.env`, and `preconditions.ts` reads `process.env` and nothing else. Both
// were true and nothing joined them, so a key placed exactly where the repo
// asked for it was invisible to the factory. These tests hold the join.
//
// The rule that shapes the loader: a file cannot beat the runner. CI and a
// daemon export secrets into the environment; `.env` is a convenience for a
// developer's box, and a convenience that silently replaces the real thing is
// how a run spends a stale key.

const dirs: string[] = [];

function envFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-dotenv-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  writeFileSync(file, contents, 'utf8');
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dotenv', () => {
  it('reads the file the runbook names, beside the code that reads it', () => {
    // Anchored on the module's own location, not on cwd: an agent runs `smith`
    // from a worktree, and the key belongs to the clone, not to the directory
    // the caller happens to be standing in.
    expect(DOTENV_PATH).toBe(path.join(REPO_ROOT, '.env'));
  });

  it('gives a name in the file to a process that has none', () => {
    const env: NodeJS.ProcessEnv = {};
    const named = loadDotEnv(envFile('SMITH_TEST_A=from-the-file\n'), env);
    expect(env.SMITH_TEST_A).toBe('from-the-file');
    expect(named).toEqual(['SMITH_TEST_A']);
  });

  it('never overrides a name the runner already set', () => {
    // The failure this prevents: a developer's months-old `.env` quietly
    // beating the fresh key CI exported, and every call billing the wrong one.
    const env: NodeJS.ProcessEnv = { SMITH_TEST_A: 'from-the-runner' };
    const named = loadDotEnv(envFile('SMITH_TEST_A=from-the-file\n'), env);
    expect(env.SMITH_TEST_A).toBe('from-the-runner');
    expect(named).toEqual([]);
  });

  it('skips blanks and comments, and the `export` a shell file carries', () => {
    const env: NodeJS.ProcessEnv = {};
    const named = loadDotEnv(
      envFile(
        [
          '# a comment',
          '',
          '   ',
          'export SMITH_TEST_A=one',
          '  SMITH_TEST_B = two  ',
          'not a key=value line',
          '=novalue',
        ].join('\n'),
      ),
      env,
    );
    expect(named).toEqual(['SMITH_TEST_A', 'SMITH_TEST_B']);
    expect(env.SMITH_TEST_A).toBe('one');
    expect(env.SMITH_TEST_B).toBe('two');
  });

  it('unwraps a quoted value and keeps every character inside it', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(
      envFile(['SMITH_TEST_A="sk-a b#c"', "SMITH_TEST_B='sk-d'", 'SMITH_TEST_C=sk-e=f'].join('\n')),
      env,
    );
    // A `#` inside quotes is part of the key, not the start of a comment, and
    // a key with `=` in it splits on the first one only.
    expect(env.SMITH_TEST_A).toBe('sk-a b#c');
    expect(env.SMITH_TEST_B).toBe('sk-d');
    expect(env.SMITH_TEST_C).toBe('sk-e=f');
  });

  it('reports the names it set and never the values', () => {
    const env: NodeJS.ProcessEnv = {};
    const secret = 'sk-do-not-print-9f2b';
    const named = loadDotEnv(envFile(`SMITH_TEST_A=${secret}\n`), env);
    expect(JSON.stringify(named)).not.toContain(secret);
  });

  it('treats a missing file as nothing to do', () => {
    const env: NodeJS.ProcessEnv = { SMITH_TEST_A: 'kept' };
    expect(loadDotEnv(path.join(tmpdir(), 'smith-dotenv-absent-6f3a1c', '.env'), env)).toEqual([]);
    expect(env.SMITH_TEST_A).toBe('kept');
  });

  it('leaves an empty value as absent, the way a precondition reads it', () => {
    // The loader sets what the file says; `apiKeyPresent` still calls an
    // empty key no key at all, so a half-finished `.env` buys no API calls.
    const name = 'SMITH_TEST_DOTENV_EMPTY';
    delete process.env[name];
    loadDotEnv(envFile(`${name}=\n`), process.env);
    expect(process.env[name]).toBe('');
    expect(apiKeyPresent(name)).toBe(false);
    delete process.env[name];
  });

  it('closes the gap: a key placed in the file answers the precondition', () => {
    // The regression itself. Before the loader existed this was false, and
    // `smith judge preflight` reported an unset key to an operator who had
    // followed `docs/runbooks/providers.md` to the letter.
    const name = 'SMITH_TEST_DOTENV_KEY';
    delete process.env[name];
    expect(apiKeyPresent(name)).toBe(false);
    loadDotEnv(envFile(`${name}=sk-present\n`), process.env);
    expect(apiKeyPresent(name)).toBe(true);
    delete process.env[name];
  });
});

// ---------------------------------------------------------------------------
// Teaching the CLI to read `.env` made that file real on operator boxes, and
// the secret scan noticed before anything else did: `gitleaks dir` walks the
// working tree, so the first key an operator placed where the runbook said to
// place it failed the gate. `.gitleaks.toml` now allowlists the one path.
//
// An allowlist is only as good as the reason for it, and the reason here is
// `.gitignore` -- a credential in this file cannot reach the tree, so a scan
// of the tree has no business reporting it. Delete the ignore and the reason
// is gone while the allowlist silently remains, which is the one way this
// becomes a hole. So the two are read back together, here, beside the loader
// that made the file worth writing to.
// ---------------------------------------------------------------------------
describe('the `.env` the loader reads is a file git refuses', () => {
  it('is ignored by git, which is what the gitleaks allowlist rests on', () => {
    // `check-ignore` asks git rather than parsing `.gitignore`: the question
    // is whether this path can be committed, and only git answers that.
    const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', '.env'], {
      cwd: REPO_ROOT,
    });
    expect(ignored.status).toBe(0);
  });

  it('allowlists that one path in the scanner, and not its siblings', () => {
    const toml = readFileSync(path.join(REPO_ROOT, '.gitleaks.toml'), 'utf8');
    // The live entries only. That file argues with itself on purpose -- it
    // carries a commented-out `.env.example` pattern to record that the one
    // committed env file is deliberately still scanned -- and a guard that
    // read comments would be held hostage by prose.
    const live = toml
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .flatMap((line) => [...line.matchAll(/'''([^']+)'''/g)].map((m) => m[1] as string));

    // Anchored and exact: `.env.local` holding a key is still a finding, and
    // an unanchored `\.env` would take `.env.example` with it.
    expect(live).toContain('^\\.env$');
    expect(live.filter((p) => p.includes('env'))).toEqual(['^\\.env$']);
  });
});
