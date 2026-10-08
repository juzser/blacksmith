import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { runProcess } from './helpers/process.js';

// The wrapper runs only an entry the operator names. Every tree here is a
// temp dir, every entry a stub that writes a marker; the real promptHook.js
// is never run, and no env is inherited from the real process.
const WRAPPER = path.join(REPO_ROOT, '.claude', 'hooks', 'prompt-capture.sh');
const NODE_DIR = path.dirname(process.execPath);
const GIT_DIR = path.dirname(execFileSync('which', ['git']).toString().trim());

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-wrapper-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A node stub entry: argv and stdin to `marker`, one line to stdout, then `exit`. */
function stubEntry(file: string, marker: string, opts: { exit?: number; noisy?: boolean } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));
${opts.noisy ? "process.stderr.write('boom\\n');" : ''}
process.stdout.write('stub line\\n');
process.exitCode = ${opts.exit ?? 0};
`,
  );
}

/** A shell stub named `bs-prompt-hook` in `dir`. */
function pathStub(dir: string, marker: string) {
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'bs-prompt-hook');
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(marker)}\ncat > /dev/null\necho path line\n`,
  );
  chmodSync(bin, 0o755);
}

const wrap = (env: NodeJS.ProcessEnv, args: string[] = [], cwd?: string) =>
  runProcess('/bin/bash', [WRAPPER, ...args], {
    input: '{"prompt":"hi"}',
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });

const read = (marker: string): { argv: string[]; stdin: string } =>
  JSON.parse(readFileSync(marker, 'utf8'));

describe('prompt-capture.sh entry order', () => {
  it('runs the entry BS_PROMPT_HOOK names, with stdin, and relays its stdout', () => {
    const entry = path.join(base, 'entry.js');
    const marker = path.join(base, 'marker.json');
    stubEntry(entry, marker);
    const run = wrap({ PATH: NODE_DIR, BS_PROMPT_HOOK: entry });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('stub line\n');
    expect(read(marker)).toEqual({ argv: [], stdin: '{"prompt":"hi"}' });
  });

  it('passes the answer argument through, and no argument without it', () => {
    const entry = path.join(base, 'entry.js');
    const marker = path.join(base, 'marker.json');
    stubEntry(entry, marker);
    wrap({ PATH: NODE_DIR, BS_PROMPT_HOOK: entry }, ['answer']);
    expect(read(marker).argv).toEqual(['answer']);
    wrap({ PATH: NODE_DIR, BS_PROMPT_HOOK: entry });
    expect(read(marker).argv).toEqual([]);
  });

  it('exits 0 with an empty stderr when the entry fails noisily', () => {
    const entry = path.join(base, 'entry.js');
    stubEntry(entry, path.join(base, 'marker.json'), { exit: 3, noisy: true });
    const run = wrap({ PATH: NODE_DIR, BS_PROMPT_HOOK: entry });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('ignores a dist/promptHook.js in the project dir, unset BS_PROMPT_HOOK, no PATH binary', () => {
    const project = path.join(base, 'acme');
    const marker = path.join(base, 'marker.json');
    stubEntry(path.join(project, 'factory/orchestrator/dist/promptHook.js'), marker);
    const run = wrap({ PATH: NODE_DIR, CLAUDE_PROJECT_DIR: project }, [], project);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('ignores the main clone dist when run from a linked worktree of it', () => {
    const repo = path.join(base, 'beta-app');
    const marker = path.join(base, 'marker.json');
    stubEntry(path.join(repo, 'factory/orchestrator/dist/promptHook.js'), marker);
    const git = (cwd: string, ...a: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a],
        { cwd, stdio: 'ignore' },
      );
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const tree = path.join(base, 'beta-app-wt');
    git(repo, 'worktree', 'add', '-q', tree);
    rmSync(path.join(tree, 'factory'), { recursive: true, force: true });
    const run = wrap({ PATH: `${NODE_DIR}:${GIT_DIR}`, CLAUDE_PROJECT_DIR: tree }, [], tree);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run a relative BS_PROMPT_HOOK', () => {
    const marker = path.join(base, 'marker.json');
    stubEntry(path.join(base, 'factory/orchestrator/dist/promptHook.js'), marker);
    const run = wrap(
      { PATH: NODE_DIR, BS_PROMPT_HOOK: 'factory/orchestrator/dist/promptHook.js' },
      [],
      base,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('falls back to bs-prompt-hook on PATH when BS_PROMPT_HOOK names a missing file', () => {
    const marker = path.join(base, 'path-marker');
    const bin = path.join(base, 'bin');
    pathStub(bin, marker);
    const env = { PATH: `${bin}:/usr/bin:/bin`, BS_PROMPT_HOOK: path.join(base, 'gone.js') };
    const run = wrap(env, ['answer']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('path line\n');
    expect(readFileSync(marker, 'utf8')).toBe('answer');
  });

  it('works with a space in the BS_PROMPT_HOOK path', () => {
    const entry = path.join(base, 'my dir', 'entry.js');
    const marker = path.join(base, 'marker.json');
    stubEntry(entry, marker);
    const run = wrap({ PATH: NODE_DIR, BS_PROMPT_HOOK: entry });
    expect(run.stdout).toBe('stub line\n');
    expect(existsSync(marker)).toBe(true);
  });

  it('is inert with an empty PATH and nothing set', () => {
    for (const args of [[], ['answer']]) {
      const run = wrap({ PATH: '' }, args, base);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
  });
});
