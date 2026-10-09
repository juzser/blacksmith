import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { templateFileFor } from '../src/agentNames.js';
import { JUDGE_ROLES } from '../src/dispatchLint.js';
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
//
// The marketplace lists two more plugins, bs-mod (the live HUD) and pr-mod (the
// open PRs). Each is a plugin module, not skills and agents, so it lives in
// `mods/<name>/` rather than `.claude/`: a module's entry point is `hooks/hooks.json`, the one file the
// blacksmith payload must not ship.
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
  type Entry = { name: string; source: string };
  const entries = (): Entry[] => readJson(MARKETPLACE_REL).plugins as Entry[];
  const entryNamed = (name: string): Entry | undefined => entries().find((e) => e.name === name);

  it('lists the blacksmith plugin at a source that is itself a plugin', () => {
    // A relative `source` is resolved against the marketplace's own repo, so
    // this is the one claim that makes `/plugin install` work at all: the
    // directory named has to hold `.claude-plugin/plugin.json`.
    const entry = entryNamed('blacksmith');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.source.startsWith('./')).toBe(true);

    const root = path.join(REPO_ROOT, entry.source);
    expect(existsSync(path.join(root, '.claude-plugin/plugin.json'))).toBe(true);
    expect(path.relative(REPO_ROOT, root)).toBe(PLUGIN_ROOT_REL);
  });

  it('lists every plugin at a source whose manifest carries the same name', () => {
    // `/plugin install <name>@blacksmith` finds the entry by name, then loads
    // whatever manifest its source holds. An entry and a manifest that
    // disagree install one plugin under another's name.
    const listed = entries();
    expect(new Set(listed.map((e) => e.name)).size).toBe(listed.length);
    for (const entry of listed) {
      expect(entry.source.startsWith('./'), `${entry.name}: source is not relative`).toBe(true);
      const manifest = path.join(entry.source, '.claude-plugin/plugin.json');
      expect(existsSync(path.join(REPO_ROOT, manifest)), `${manifest} is absent`).toBe(true);
      expect(readJson(manifest).name, `${manifest} names another plugin`).toBe(entry.name);
    }
  });

  it('releases every plugin it lists at the package version', () => {
    // An installed plugin stays on its cached copy until its manifest's
    // `version` string changes, so a plugin a release forgot to bump never
    // updates on anyone's machine. Holding every listed plugin to the
    // package's version makes the release commit that bumps package.json fail
    // here until each manifest moves with it: nothing to remember.
    const pkg = readJson('package.json');
    for (const entry of entries()) {
      const manifest = path.join(entry.source, '.claude-plugin/plugin.json');
      expect(readJson(manifest).version, manifest).toBe(pkg.version);
    }
  });

  it('lists every plugin whose manifest names a types contract at a file that exists', () => {
    // A plugin module's `types` is the contract `claude plugin validate`
    // holds its `$.state` keys to. Pointed at a file the repo does not ship,
    // the plugin validates here, where an engine-generated folder may sit
    // beside it, and fails on an operator's fresh install.
    const typed = entries().filter((e) => {
      const manifest = path.join(e.source, '.claude-plugin/plugin.json');
      return typeof readJson(manifest).types === 'string';
    });
    expect(typed.map((e) => e.name)).toContain('bs-mod');
    expect(typed.map((e) => e.name)).toContain('pr-mod');
    for (const entry of typed) {
      const manifest = path.join(entry.source, '.claude-plugin/plugin.json');
      const types = path.join(entry.source, readJson(manifest).types as string);
      expect(existsSync(path.join(REPO_ROOT, types)), `${types} is named but absent`).toBe(true);
    }
  });

  it.each(['bs-mod', 'pr-mod'])(
    'lists %s at a source whose hooks.json names modules that exist',
    (name) => {
      // A plugin module: the engine loads only what `hooks/hooks.json` names,
      // so a renamed entry file installs a plugin that draws nothing.
      const entry = entryNamed(name);
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.source).toBe(`./mods/${name}`);

      const hooksDir = path.join(REPO_ROOT, entry.source, 'hooks');
      const hooks = JSON.parse(readFileSync(path.join(hooksDir, 'hooks.json'), 'utf8')) as {
        modules?: unknown;
      };
      expect(Array.isArray(hooks.modules)).toBe(true);
      const modules = hooks.modules as string[];
      expect(modules.length).toBeGreaterThan(0);
      for (const mod of modules) {
        expect(existsSync(path.join(hooksDir, mod)), `${mod} is named but absent`).toBe(true);
      }
    },
  );
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

  describe('hooks/hooks.json', () => {
    type Group = {
      matcher?: string;
      hooks: { type: string; command: string; timeout?: number; async?: boolean }[];
    };
    const registered = (): Record<string, Group[]> =>
      (
        JSON.parse(readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')) as {
          hooks: Record<string, Group[]>;
        }
      ).hooks;

    it('registers exactly one UserPromptSubmit and one PostToolUse on AskUserQuestion, both the capture wrapper', () => {
      // The one hook the plugin ships: a non-blocking recorder. The policy hook
      // (guard.sh) stays clone-shaped and is never registered here, because a
      // guard that cannot find its binary degrades to `ask` in front of every
      // command (plugin-port-scope Fork 4).
      const hooks = registered();
      expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'UserPromptSubmit']);
      const submit = hooks.UserPromptSubmit as Group[];
      expect(submit).toHaveLength(1);
      expect(submit[0]?.hooks).toHaveLength(1);
      expect(submit[0]?.hooks[0]?.command).toMatch(/prompt-capture\.sh"?$/);
      const post = hooks.PostToolUse as Group[];
      expect(post).toHaveLength(1);
      expect(post[0]?.matcher).toBe('AskUserQuestion');
      expect(post[0]?.hooks).toHaveLength(1);
      expect(post[0]?.hooks[0]?.command).toMatch(/prompt-capture\.sh" answer$/);
    });

    it('is synchronous with a timeout of at most 5 s, and names neither guard.sh nor judge-stop.sh', () => {
      const text = readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8');
      expect(text).not.toMatch(/guard\.sh|judge-stop\.sh/);
      for (const group of Object.values(registered()).flat()) {
        for (const h of group.hooks) {
          expect(h.type).toBe('command');
          expect(h.timeout).toBeLessThanOrEqual(5);
          expect(h).not.toHaveProperty('async');
        }
      }
    });

    it('ships a wrapper that is inert with an empty PATH and a project dir holding no dist', () => {
      const emptyProjectDir = mkdtempSync(path.join(tmpdir(), 'smith-capture-inert-'));
      try {
        for (const args of [[], ['answer']]) {
          const run = runProcess(
            '/bin/bash',
            [path.join(root, 'hooks/prompt-capture.sh'), ...args],
            {
              input: JSON.stringify({ session_id: 'sess-1', prompt: 'hi', cwd: emptyProjectDir }),
              env: { PATH: '', CLAUDE_PROJECT_DIR: emptyProjectDir, CLAUDE_PLUGIN_ROOT: root },
            },
          );
          expect(run.status).toBe(0);
          expect(run.stdout).toBe('');
          expect(run.stderr).toBe('');
        }
        expect(readdirSync(emptyProjectDir)).toEqual([]);
      } finally {
        rmSync(emptyProjectDir, { recursive: true, force: true });
      }
    });
  });

  it('every judge agent template declares judge-stop.sh as its Stop hook', () => {
    // Registered in each judge-class template's own frontmatter as a `Stop`
    // hook (Claude Code converts that to `SubagentStop` for a subagent), not
    // via settings.json or a plugin hooks.json -- pins the reference against
    // a future rename of the hook script.
    for (const role of JUDGE_ROLES) {
      const body = readFileSync(path.join(root, 'agents', templateFileFor(role)), 'utf8');
      expect(
        body,
        `${templateFileFor(role)} frontmatter is missing the judge-stop.sh Stop hook`,
      ).toMatch(
        /hooks:\s*\n\s*Stop:\s*\n[\s\S]*?\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/judge-stop\.sh/,
      );
    }
  });

  it('no non-judge template declares the judge-stop.sh Stop hook -- exactly JUDGE_ROLES, never a superset', () => {
    // The positive assertion above only ever reads the six JUDGE_ROLES
    // templates, so a stray copy of the hook block pasted onto a seventh
    // template (a coder, say) would pass it silently. Sweep every OTHER
    // shipped template and assert none of them mention judge-stop.sh at all.
    const judgeRoleSet: ReadonlySet<string> = new Set(JUDGE_ROLES);
    const allTemplates = readdirSync(path.join(root, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/^bs-/, '').replace(/\.md$/, ''));
    const nonJudgeTemplates = allTemplates.filter((role) => !judgeRoleSet.has(role));
    expect(nonJudgeTemplates.length).toBeGreaterThan(0);
    for (const role of nonJudgeTemplates) {
      const body = readFileSync(path.join(root, 'agents', templateFileFor(role)), 'utf8');
      expect(
        body,
        `${templateFileFor(role)} should not declare the judge-stop.sh hook`,
      ).not.toMatch(/judge-stop\.sh/);
    }
  });

  // The invariant this file actually needs is wider than "ships no top-level
  // hooks.json" above: a plugin install must activate no hook that ACTS
  // outside a clone. The judge templates above still carry a frontmatter Stop
  // hook when shipped through the plugin -- that payload has no
  // `hooks/hooks.json`, but a template's own frontmatter hook is read
  // regardless of install method, so it must be inert wherever the built
  // `dist/judgeStopHook.js` and `.claude/hooks/judge-stop.sh` do not exist.
  // Regex-matching the frontmatter text (above) only proves the hook is
  // *declared*; it proves nothing about what running it actually does. This
  // extracts each judge template's real frontmatter hook command and spawns
  // it for real, so a command that forgets its own existence guard is caught
  // here instead of in an operator's plugin install.
  function extractHookCommand(role: string): string {
    const body = readFileSync(path.join(root, 'agents', templateFileFor(role)), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    const frontmatterText = match?.[1];
    if (frontmatterText === undefined)
      throw new Error(`${templateFileFor(role)} has no frontmatter block`);
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

    for (const role of JUDGE_ROLES) {
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
