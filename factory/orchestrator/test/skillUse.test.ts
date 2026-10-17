import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { BYPASS_HEADER, BYPASS_YES } from '../src/sessionBinding.js';

const SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'bs');
const skill = () => readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const useDoc = () => readFileSync(path.join(SKILL_DIR, 'use.md'), 'utf8');
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

describe('`/bs use` routing and playbook', () => {
  it('has a subcommand table row for /bs use <project> linking use.md', () => {
    const row = skill()
      .split('\n')
      .find((l) => l.startsWith('| `/bs use <project>`'));
    expect(row).toBeDefined();
    expect(row).toContain('[`use.md`](use.md)');
  });

  it('names use among the subcommands in the description', () => {
    const description = /^description: (.*)$/m.exec(skill())?.[1] ?? '';
    expect(description).toMatch(/\(new, [^)]*\buse\b[^)]*\)/);
  });

  it('names the hook-only types and the policy file, and keeps the bypass wording out', () => {
    const doc = useDoc();
    expect(doc).toContain('session-bound');
    expect(doc).toContain('pipeline-bypass-approved');
    expect(doc).toContain('factory/policies/session-binding.yml');
    expect(doc).not.toContain(BYPASS_HEADER);
    expect(doc).not.toContain(BYPASS_YES);
  });

  it('says what the question names and that one yes covers one change', () => {
    const text = flat(useDoc());
    const phrase = 'names every file the change will touch and its estimated changed lines';
    expect(text.split(phrase).length - 1).toBe(1);
    expect(text).toContain('one yes covers one change');
  });
});
