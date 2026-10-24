import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initGuidance, uiNotBuiltMessage } from '../src/installGuidance.js';
import { assertExited, runProcess } from './helpers/process.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

interface Fence {
  info: string;
  lines: string[];
}

// A fence opens on a column-0 line of exactly three backticks plus an optional
// info string and closes on the next column-0 line of exactly three backticks.
function fences(doc: string): Fence[] {
  const found: Fence[] = [];
  let open: Fence | null = null;
  for (const line of doc.split('\n')) {
    if (open === null) {
      const m = /^```([^`]*)$/.exec(line);
      if (m) open = { info: (m[1] ?? '').trim(), lines: [] };
    } else if (line === '```') {
      found.push(open);
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  return found;
}

const installDoc = readFileSync(path.join(REPO_ROOT, 'INSTALL.md'), 'utf8');
const nonEmpty = (lines: string[]) => lines.filter((l) => l.trim() !== '');

function pluginLines(): string[] {
  const block = fences(installDoc).find((f) => f.info === '');
  expect(block, 'INSTALL.md has an untagged fenced block').toBeDefined();
  const lines = nonEmpty(block?.lines ?? []);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l.startsWith('/plugin ')).toBe(true);
  return lines;
}

function installCommand(): string {
  const block = fences(installDoc).find((f) => f.info === 'bash');
  expect(block, 'INSTALL.md has a bash fenced block').toBeDefined();
  const lines = nonEmpty(block?.lines ?? []);
  expect(lines).toHaveLength(1);
  return lines[0] as string;
}

describe('installGuidance', () => {
  it('names bs doctor for a clone and for an installed package', () => {
    expect(initGuidance(true)).toContain('bs doctor');
    expect(initGuidance(false)).toContain('bs doctor');
  });

  it('gives the installed package the plugin lines INSTALL.md gives, consecutive and in order', () => {
    const lines = pluginLines();
    expect(initGuidance(false).split('\n')).toEqual(expect.arrayContaining(lines));
    const out = initGuidance(false).split('\n');
    const at = out.indexOf(lines[0] as string);
    expect(out.slice(at, at + lines.length)).toEqual(lines);
  });

  it('keeps pnpm build:server for a clone', () => {
    const msg = uiNotBuiltMessage('/example/ui/server/dist/index.js', true);
    expect(msg).toContain('pnpm build:server');
    expect(msg).toContain('/example/ui/server/dist/index.js');
  });

  it('gives an installed package the install command from INSTALL.md and no pnpm script', () => {
    const msg = uiNotBuiltMessage('/example/ui/server/dist/index.js', false);
    expect(msg).toContain(installCommand());
    expect(msg).not.toContain('pnpm');
    expect(msg).toContain('/example/ui/server/dist/index.js');
  });
});

describe('installGuidance edge cases', () => {
  it('names the next command, bs new, for a clone and an installed package', () => {
    expect(initGuidance(true)).toContain('bs new');
    expect(initGuidance(false)).toContain('bs new');
  });

  it('gives a clone no plugin step, since the clone ships the plugin', () => {
    expect(initGuidance(true)).not.toContain('/plugin ');
  });

  it('ends the guidance with one newline so stderr stays line-terminated', () => {
    for (const isClone of [true, false]) {
      const out = initGuidance(isClone);
      expect(out.endsWith('\n')).toBe(true);
      expect(out.endsWith('\n\n')).toBe(false);
    }
  });

  it('keeps the plugin lines before the bs doctor step for an installed package', () => {
    const out = initGuidance(false);
    expect(out.indexOf('/plugin install')).toBeLessThan(out.indexOf('bs doctor'));
  });

  it('names no build script in the installed-package message and no install command in the clone one', () => {
    const entry = '/example/ui/server/dist/index.js';
    expect(uiNotBuiltMessage(entry, false)).not.toContain('build:server');
    expect(uiNotBuiltMessage(entry, true)).not.toContain(installCommand());
  });

  it('extracts fences by column-0 position: an indented fence does not open a block', () => {
    const doc = ['  ```bash', '  x', '  ```', '```', '/plugin a', '```'].join('\n');
    const found = fences(doc);
    expect(found).toHaveLength(1);
    expect(found[0]?.lines).toEqual(['/plugin a']);
  });
});

describe('installGuidance stack interview', () => {
  function stackCommands(): string[] {
    const block = fences(installDoc).find((f) => nonEmpty(f.lines).includes('bs stack show'));
    expect(block, 'INSTALL.md has an install-path bs stack fence').toBeDefined();
    return nonEmpty(block?.lines ?? []);
  }

  it('gives an installed package the bs stack commands INSTALL.md gives, between bs doctor and bs new', () => {
    const out = initGuidance(false);
    const cmds = stackCommands();
    expect(cmds).toEqual(['bs stack show', 'bs stack check']);
    for (const c of cmds) expect(out).toContain(c);
    expect(out).toContain('stack.yml');
    expect(out.indexOf('bs doctor')).toBeLessThan(out.indexOf('bs stack show'));
    expect(out.indexOf('bs stack check')).toBeLessThan(out.indexOf('bs new'));
  });

  it('qualifies the installed stack file path with BS_HOME when it prints the directory', () => {
    const out = initGuidance(false);
    if (out.includes('.blacksmith/')) expect(out).toContain('$BS_HOME');
  });
});

describe('installGuidance stack interview placement', () => {
  it('places the stack commands after the plugin install lines for an installed package', () => {
    const out = initGuidance(false);
    expect(out.indexOf('/plugin install')).toBeLessThan(out.indexOf('bs stack show'));
  });

  it('names each stack command once and in show-then-check order', () => {
    const out = initGuidance(false);
    expect(out.split('bs stack show')).toHaveLength(2);
    expect(out.split('bs stack check')).toHaveLength(2);
    expect(out.indexOf('bs stack show')).toBeLessThan(out.indexOf('bs stack check'));
  });

  it('gives a clone no stack step, since a clone follows INSTALL.md in order', () => {
    const out = initGuidance(true);
    expect(out).not.toContain('bs stack');
    expect(out).not.toContain('stack.yml');
  });

  it('numbers the steps consecutively with bs new last in both modes', () => {
    for (const isClone of [true, false]) {
      const nums = [...initGuidance(isClone).matchAll(/^ {2}(\d+)\. /gm)].map((m) => Number(m[1]));
      expect(nums).toEqual(nums.map((_, i) => i + 1));
      const last = initGuidance(isClone).trimEnd().split('\n').pop() ?? '';
      expect(last).toContain('bs new');
    }
  });
});

describe('bs init output streams', () => {
  let workRoot: string;
  beforeAll(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'smith-guidance-'));
  });
  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('keeps stdout to the JSON report and puts the guidance on stderr', () => {
    const run = runProcess('node', [CLI_PATH, 'init', '--work-root', workRoot]);
    assertExited(run, 'bs init');
    const report = JSON.parse(run.stdout) as {
      files: { personal: string; status: string }[];
    };
    expect(run.stdout).toBe(`${JSON.stringify(report)}\n`);
    expect(run.status).toBe(report.files.some((f) => f.status === 'missing-default') ? 1 : 0);
    for (const f of report.files) expect(existsSync(f.personal)).toBe(true);
    expect(run.stderr).toContain('bs doctor');
    expect(run.stderr).toContain(initGuidance(true).trimEnd());
  });
});
