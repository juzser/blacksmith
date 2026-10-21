import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// A plugin cannot ship `env`, so the published install raises Claude Code's
// two concurrency caps as a consented step in INSTALL.md. These tests pin that
// contract in the docs so it cannot drift away silently. They read the
// working tree, never a git revision.

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SUBAGENTS = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS';
const TOOLS = 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY';

describe('concurrency caps install step', () => {
  const install = read('INSTALL.md');

  it('the top block points at the caps step', () => {
    const top = install.slice(0, install.indexOf('## Part 0'));
    expect(top).toMatch(/concurrency caps/i);
    expect(top).toContain('#raise-the-concurrency-caps');
  });

  it('has a canonical subsection with both vars set to "1000" in an env block', () => {
    const start = install.indexOf('#### Raise the concurrency caps');
    expect(start).toBeGreaterThan(-1);
    const rest = install.slice(start + 1);
    const next = rest.search(/\n#{1,4} /);
    const section = rest.slice(0, next === -1 ? undefined : next);
    expect(section).toContain(`"${SUBAGENTS}": "1000"`);
    expect(section).toContain(`"${TOOLS}": "1000"`);
    expect(section).toContain('"env"');
    expect(section).toMatch(/undocumented/i);
    expect(section).toContain('2.1.217');
  });

  it('the clone runbook points at it from Step 6', () => {
    const step6 = install.slice(install.indexOf('### Step 6'), install.indexOf('### Step 7'));
    expect(step6).toContain('#raise-the-concurrency-caps');
  });
});

describe('dispatch.md concurrency statement', () => {
  const dispatch = read('.claude/skills/bs/dispatch.md');

  it('names the harness cap var and no longer claims there is no cap', () => {
    expect(dispatch).toContain(SUBAGENTS);
    expect(dispatch).not.toMatch(/no \*\*concurrency cap\*\*/);
  });
});
