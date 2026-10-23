import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// One description sentence, four places. A package page, a plugin listing and
// the README that opens the repo must say the same thing about the product, and
// none of them may call it by a word the product does not claim.

const TAGLINE = 'From feature request to reviewable PR — with an AI engineering workflow.';

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

interface MarketplaceEntry {
  readonly name: string;
  readonly description: string;
}

const pkg = JSON.parse(read('package.json')) as {
  description: string;
  keywords: readonly string[];
};
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as {
  description: string;
  plugins: readonly MarketplaceEntry[];
};
const plugin = JSON.parse(read('.claude/.claude-plugin/plugin.json')) as { description: string };
const readme = read('README.md');
const lines = readme.split('\n');

/** The README text above its first `##` heading. */
const firstScreen = readme.split(/^## /m)[0] as string;

function entry(name: string): MarketplaceEntry {
  const found = marketplace.plugins.find((one) => one.name === name);
  expect(found, `marketplace entry ${name}`).toBeDefined();
  return found as MarketplaceEntry;
}

/** The first non-blank line after the one that carries the tagline. */
function lineBelowTagline(): string {
  const at = lines.findIndex((line) => line.includes(TAGLINE));
  expect(at, 'the tagline line').toBeGreaterThan(-1);
  return (lines.slice(at + 1).find((line) => line.trim() !== '') ?? '').trim();
}

describe('one description', () => {
  it('opens the README with the tagline as the first text line under the heading', () => {
    const at = lines.findIndex((line) => line === '# Blacksmith');
    expect(at).toBeGreaterThan(-1);
    const first = (lines.slice(at + 1).find((line) => line.trim() !== '') ?? '').trim();
    expect(first.replaceAll('*', '').replaceAll('_', '')).toBe(TAGLINE);
  });

  it('is the same sentence in package.json, the marketplace, the plugin and the README', () => {
    const sentence = pkg.description;
    expect(sentence.length).toBeGreaterThan(20);
    expect(entry('blacksmith').description).toBe(sentence);
    expect(plugin.description).toBe(sentence);
    expect(lineBelowTagline()).toBe(sentence);
  });

  it('uses the word autonomous in no description, keyword or first screen', () => {
    const texts = [
      pkg.description,
      ...pkg.keywords,
      plugin.description,
      marketplace.description,
      ...marketplace.plugins.map((one) => one.description),
      firstScreen,
    ];
    for (const text of texts) expect(text).not.toMatch(/autonom/i);
  });

  it('keeps bs-mod and pr-mod on their own subject', () => {
    const mod = entry('bs-mod').description;
    const pr = entry('pr-mod').description;
    expect(mod).not.toBe(pkg.description);
    expect(pr).not.toBe(pkg.description);
    expect(mod).toMatch(/HUD|band/);
    expect(pr).toMatch(/pull request|PR/i);
  });
});

describe('the README first screen', () => {
  const table = firstScreen.split('\n').filter((line) => line.trim().startsWith('|'));

  it('carries a comparison table with a row per workflow step', () => {
    const text = table.join('\n').toLowerCase();
    for (const step of ['spec', 'plan', 'review', 'verification', 'merge'])
      expect(text, step).toContain(step);
  });

  it('puts no number in the comparison table', () => {
    expect(table.length).toBeGreaterThan(2);
    for (const line of table) expect(line).not.toMatch(/\d/);
  });

  it('shows either a labelled single-run demo with its run id or a NOT MEASURED placeholder', () => {
    const labelled = /single-run[^\n]*run id:?\s*`?[\w./-]+/i.test(firstScreen);
    const placeholder = firstScreen.includes('NOT MEASURED');
    expect(labelled || placeholder).toBe(true);
  });
});

describe('the quickstart', () => {
  const quickstart = read('docs/guide/quickstart.md');
  const fenced = [...quickstart.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const cli = read('factory/orchestrator/src/cli.ts');

  it('links INSTALL.md for detail and runs bs doctor', () => {
    expect(quickstart).toMatch(/\]\(\.\.\/\.\.\/INSTALL\.md\)/);
    expect(fenced.join('\n')).toMatch(/^bs doctor$/m);
  });

  it('names only bs verbs the CLI dispatches', () => {
    const verbs = fenced
      .join('\n')
      .split('\n')
      .map((line) => /^bs\s+([a-z-]+)/.exec(line.trim())?.[1])
      .filter((verb): verb is string => verb !== undefined);
    expect(verbs.length).toBeGreaterThan(1);
    for (const verb of verbs) expect(cli, verb).toContain(`namespace === '${verb}'`);
  });
});

describe('the positioning proposal', () => {
  const proposal = read('docs/positioning-proposal.md');

  it('says it is a proposal and that nothing was applied', () => {
    expect(proposal).toMatch(/proposal/i);
    expect(proposal).toMatch(/Nothing in this file has been applied/);
  });

  it('holds no shell command that would change a GitHub setting', () => {
    expect(proposal).not.toMatch(/^\s*(\$\s*)?gh\s+(repo|api)\b/m);
  });
});

describe('the README below the first screen', () => {
  it('keeps its sections and the one limit sentence that uses the word', () => {
    for (const heading of ['Features', 'Install', 'Using it', 'Safety', 'Status', 'Docs'])
      expect(readme, heading).toContain(`\n## ${heading}\n`);
    expect(readme).toContain('No autonomous deploy or outbound sends');
  });

  it('keeps the logo and badges on the first screen', () => {
    expect(firstScreen).toContain('black-smith.png');
    expect(firstScreen).toContain('badge.svg');
  });
});
