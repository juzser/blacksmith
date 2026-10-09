import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentNameFor,
  roleOfAgentType,
  roleOfTemplateFile,
  templateFileFor,
} from '../src/agentNames.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const AGENTS = path.join(REPO_ROOT, '.claude', 'agents');
const SKILLS = path.join(REPO_ROOT, '.claude', 'skills', 'bs');

const ROLES = [
  'auditor',
  'coder',
  'grader',
  'merger',
  'planner',
  'researcher',
  'reviewer',
  'scribe',
  'security-reviewer',
  'spec-reviewer',
  'tester',
  'uiux',
  'verifier',
  'wave-runner',
];

describe('agent name mapping', () => {
  it('maps a role to its agent name and template file', () => {
    expect(agentNameFor('reviewer')).toBe('bs-reviewer');
    expect(templateFileFor('security-reviewer')).toBe('bs-security-reviewer.md');
  });

  it('maps an agent type back to the role, namespaced or not', () => {
    expect(roleOfAgentType('bs-reviewer')).toBe('reviewer');
    expect(roleOfAgentType('blacksmith:bs-reviewer')).toBe('reviewer');
    expect(roleOfAgentType('other-ns:bs-spec-reviewer')).toBe('spec-reviewer');
  });

  it('still accepts the bare pre-prefix name for the transition', () => {
    expect(roleOfAgentType('reviewer')).toBe('reviewer');
    expect(roleOfAgentType('blacksmith:reviewer')).toBe('reviewer');
  });

  it('returns null when nothing maps', () => {
    expect(roleOfAgentType('bs-')).toBeNull();
    expect(roleOfAgentType('blacksmith:')).toBeNull();
    expect(roleOfAgentType('')).toBeNull();
  });

  it('maps a template file back to its role, and refuses a bare file', () => {
    expect(roleOfTemplateFile('bs-coder.md')).toBe('coder');
    expect(roleOfTemplateFile('coder.md')).toBeNull();
    expect(roleOfTemplateFile('bs-coder.json')).toBeNull();
  });
});

describe('shipped agent templates', () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith('.md'));

  it('are exactly the 14 bs-<role>.md files, each named bs-<role>', () => {
    expect(files.sort()).toEqual(ROLES.map(templateFileFor).sort());
    for (const file of files) {
      const role = roleOfTemplateFile(file) as string;
      const text = readFileSync(path.join(AGENTS, file), 'utf8');
      expect(text).toMatch(new RegExp(`^name: ${agentNameFor(role)}$`, 'm'));
    }
  });

  it('cover every agent a playbook dispatches or points at', () => {
    const names = new Set<string>();
    for (const file of readdirSync(SKILLS).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(path.join(SKILLS, file), 'utf8');
      for (const m of text.matchAll(/\.claude\/agents\/([a-z][a-z-]*)\.md/g))
        names.add(m[1] as string);
      for (const m of text.matchAll(/[Dd]ispatch(?:ed)?,? (?:a |as the )?\*\*`([a-z-]+)`\*\*/g))
        names.add(m[1] as string);
    }
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) {
      expect(name.startsWith('bs-'), `${name} is not a bs- name`).toBe(true);
      expect(existsSync(path.join(AGENTS, `${name}.md`)), `${name} has no template`).toBe(true);
    }
  });
});
