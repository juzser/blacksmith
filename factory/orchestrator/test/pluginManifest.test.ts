import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

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
});
