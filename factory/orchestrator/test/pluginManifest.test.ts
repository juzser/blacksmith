import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from '../src/paths.js';
import { runProcess } from './helpers/process.js';

// ---------------------------------------------------------------------------
// `/bs` is a Claude Code skill, and Claude Code loads skills from a project's
// `.claude/`, the user's `~/.claude/`, or a plugin -- never from
// `node_modules`. So the npm package alone could never give an operator the
// verb; the plugin is how it arrives, and this repository is its marketplace.
//
// The layout that makes that work without a second copy is the point of these
// tests: the plugin root *is* `.claude/`, so `skills/` and `agents/` are the
// same files the clone dogfoods, and there is no export step to forget. What
// can still break is the wiring around them -- a marketplace naming a source
// directory that isn't a plugin, a `plugin.json` version left behind by a
// release, a plugin quietly starting to load the clone-shaped policy hook.
// None of those fail loudly at install time; they fail in an operator's
// session, which is too late. They fail here instead.
// ---------------------------------------------------------------------------

const MARKETPLACE_REL = '.claude-plugin/marketplace.json';
const PLUGIN_ROOT_REL = '.claude';
const PLUGIN_MANIFEST_REL = path.join(PLUGIN_ROOT_REL, '.claude-plugin/plugin.json');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;
}

describe('plugin manifest', () => {
  it('declares the same version the package publishes', () => {
    // The two halves install separately -- plugin from git, CLI from npm --
    // and an operator reads `claude plugin details` to know which they have.
    // A stale version there reports the wrong one with total confidence.
    const plugin = readJson(PLUGIN_MANIFEST_REL);
    const pkg = readJson('package.json');
    expect(plugin.version).toBe(pkg.version);
  });

  it('is named the same as the package half it drives', () => {
    const plugin = readJson(PLUGIN_MANIFEST_REL);
    expect(plugin.name).toBe('blacksmith');
  });
});

describe('marketplace', () => {
  it('lists the plugin at a source that is itself a plugin', () => {
    // A relative `source` is resolved against the marketplace's own repo, so
    // this is the one claim that makes `/plugin install` work at all: the
    // directory named has to hold `.claude-plugin/plugin.json`.
    const market = readJson(MARKETPLACE_REL);
    const plugins = market.plugins as { name: string; source: string }[];
    expect(plugins).toHaveLength(1);
    const [entry] = plugins as [{ name: string; source: string }];
    expect(entry.name).toBe('blacksmith');
    expect(entry.source.startsWith('./')).toBe(true);

    const root = path.join(REPO_ROOT, entry.source);
    expect(existsSync(path.join(root, '.claude-plugin/plugin.json'))).toBe(true);
    expect(path.relative(REPO_ROOT, root)).toBe(PLUGIN_ROOT_REL);
  });
});

describe('plugin payload', () => {
  const root = path.join(REPO_ROOT, PLUGIN_ROOT_REL);

  it('carries the /bs skill and every playbook it routes to', () => {
    // SKILL.md is a router: each verb's playbook is a sibling file it reads
    // when that verb runs. A payload with the router and not the playbooks
    // installs cleanly and then dead-ends on the first `/bs plan`.
    const skill = path.join(root, 'skills/bs');
    const body = readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    const routed = [...body.matchAll(/\]\((?!https?:)([a-z-]+\.md)\)/g)].map((m) => m[1] as string);
    expect(routed.length).toBeGreaterThan(0);
    for (const file of new Set(routed)) {
      expect(existsSync(path.join(skill, file)), `${file} is routed to but absent`).toBe(true);
    }
  });

  it('carries every agent role a playbook can dispatch', () => {
    const agents = readdirSync(path.join(root, 'agents')).filter((f) => f.endsWith('.md'));
    expect(agents.length).toBeGreaterThanOrEqual(14);
  });

  it('activates no hooks, because the policy hook is clone-shaped', () => {
    // `.claude/hooks/guard.sh` resolves its policy binary relative to a
    // checkout and degrades to `ask` when it cannot find one -- which in an
    // install means a confirmation prompt in front of every command. A plugin
    // loads hooks only from `hooks/hooks.json`, so the absence of that file is
    // what keeps the payload inert. It is a decision, not an oversight.
    expect(existsSync(path.join(root, 'hooks/hooks.json'))).toBe(false);
  });

  it('every judge agent template declares judge-stop.sh as its Stop hook', () => {
    // Registered in each judge-class template's own frontmatter as a `Stop`
    // hook (Claude Code converts that to `SubagentStop` for a subagent), not
    // via settings.json or a plugin hooks.json -- pins the reference against
    // a future rename of the hook script.
    const judgeTemplates = ['reviewer', 'verifier', 'grader', 'spec-reviewer', 'security-reviewer', 'auditor'];
    for (const role of judgeTemplates) {
      const body = readFileSync(path.join(root, 'agents', `${role}.md`), 'utf8');
      expect(body, `${role}.md frontmatter is missing the judge-stop.sh Stop hook`).toMatch(
        /hooks:\s*\n\s*Stop:\s*\n[\s\S]*?\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/judge-stop\.sh/,
      );
    }
  });

  // Widened invariant (was "activates no hooks"): a plugin install activates
  // no hook that ACTS outside a clone. The judge templates above still carry
  // a frontmatter Stop hook when shipped through the plugin -- that payload
  // has no `hooks/hooks.json`, but a template's own frontmatter hook is read
  // regardless of install method, so it must be inert wherever the built
  // `dist/judgeStopHook.js` and `.claude/hooks/judge-stop.sh` do not exist.
  // Regex-matching the frontmatter text (above) only proves the hook is
  // *declared*; it proves nothing about what running it actually does. This
  // extracts each judge template's real frontmatter hook command and spawns
  // it for real, so a command that forgets its own existence guard is caught
  // here instead of in an operator's plugin install.
  function extractHookCommand(role: string): string {
    const body = readFileSync(path.join(root, 'agents', `${role}.md`), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    const frontmatterText = match?.[1];
    if (frontmatterText === undefined) throw new Error(`${role}.md has no frontmatter block`);
    const frontmatter = parseYaml(frontmatterText) as {
      hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
    };
    const command = frontmatter.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (typeof command !== 'string') {
      throw new Error(`${role}.md frontmatter has no Stop hook command to run`);
    }
    return command;
  }

  const subagentStopFixture = JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/does-not-matter.jsonl',
    hook_event_name: 'SubagentStop',
    agent_type: 'reviewer',
  });

  describe('judge templates are inert outside a clone (executed, not just matched)', () => {
    let emptyProjectDir: string;
    const judgeTemplates = ['reviewer', 'verifier', 'grader', 'spec-reviewer', 'security-reviewer', 'auditor'];

    for (const role of judgeTemplates) {
      it(`${role}.md's frontmatter hook command exits 0 with empty stdout under an empty CLAUDE_PROJECT_DIR`, () => {
        emptyProjectDir = mkdtempSync(path.join(tmpdir(), 'smith-plugin-inert-'));
        try {
          const command = extractHookCommand(role);
          const run = runProcess('sh', ['-c', command], {
            input: subagentStopFixture,
            env: { ...process.env, CLAUDE_PROJECT_DIR: emptyProjectDir },
          });
          // `.claude/hooks/judge-stop.sh` does not exist under this fresh,
          // otherwise-empty temp dir -- exactly a plugin install with no
          // blacksmith checkout backing it. The command's own existence
          // guard (`[ -f ... ] && ... || exit 0`) is what makes that a
          // silent no-op instead of a shell trying to exec a missing file.
          expect(run.status).toBe(0);
          expect(run.stdout).toBe('');
        } finally {
          rmSync(emptyProjectDir, { recursive: true, force: true });
        }
      });
    }

    it('the null case: a command with no existence guard fails this same assertion', () => {
      // Recorded verbatim, as the acceptance criterion requires: dropping the
      // guard and unconditionally exec'ing the (here, absent) script gives a
      // shell "No such file or directory" and a non-zero exit -- proving the
      // assertion above is not vacuously true for any command string.
      const unconditional = '"$CLAUDE_PROJECT_DIR/.claude/hooks/judge-stop.sh"';
      const nullDir = mkdtempSync(path.join(tmpdir(), 'smith-plugin-inert-null-'));
      try {
        const run = runProcess('sh', ['-c', unconditional], {
          input: subagentStopFixture,
          env: { ...process.env, CLAUDE_PROJECT_DIR: nullDir },
        });
        expect(run.status).not.toBe(0);
        // Verbatim, observed: `run.status` is 127 and `run.stderr` reads
        // `sh: <nullDir>/.claude/hooks/judge-stop.sh: No such file or
        // directory` -- a real, not simulated, execution failure.
      } finally {
        rmSync(nullDir, { recursive: true, force: true });
      }
    });
  });
});
