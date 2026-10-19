import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertExited, runProcess } from './helpers/process.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

describe('bs doctor', () => {
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(path.join(tmpdir(), 'bs-doctor-'));
    // A stand-in `claude`, so no test ever runs the real one.
    const fake = path.join(bin, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho "  blacksmith@blacksmith"\n');
    chmodSync(fake, 0o755);
  });

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  // Only the stand-in on PATH: git and pnpm cannot be found, so doctor must fail.
  const run = (...args: string[]) =>
    runProcess(process.execPath, [CLI_PATH, 'doctor', ...args], { env: { PATH: bin } });

  it('--json prints {checks:[{id,status,detail,fix}], ok} and exits 1 on a missing check', () => {
    const res = run('--json');
    assertExited(res, 'bs doctor --json');
    const out = JSON.parse(res.stdout) as {
      checks: { id: string; status: string; detail: string; fix: string }[];
      ok: boolean;
    };
    expect(Object.keys(out).sort()).toEqual(['checks', 'ok']);
    for (const c of out.checks) {
      expect(Object.keys(c).sort()).toEqual(['detail', 'fix', 'id', 'status']);
      expect(['ok', 'missing', 'unknown']).toContain(c.status);
    }
    expect(out.checks.find((c) => c.id === 'git')?.status).toBe('missing');
    expect(out.checks.find((c) => c.id === 'plugin')?.status).toBe('ok');
    expect(out.ok).toBe(false);
    expect(res.status).toBe(1);
  });

  it('plain words print one line per check', () => {
    const res = run();
    assertExited(res, 'bs doctor');
    const lines = res.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(7);
    expect(lines.some((l) => l.startsWith('missing') && l.includes('git'))).toBe(true);
    expect(res.status).toBe(1);
  });
});
