// Tests for shoot_mock.mjs (ui/docs/DESIGN.md "Reference"). Node's built-in
// test runner (stdlib, no new dependency), same rung check_tokens.py and
// lint_icon_only.py's own tests run on — just the JS side of it.
//
// Run: node --test scripts/design/test_shoot_mock.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shootFrame } from './shoot_mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = path.join(here, '..', '..', 'ui', 'docs', 'ds-review.html');

test('renders p-home desktop light to a non-empty PNG', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-mock-'));
  try {
    const outPath = await shootFrame({
      mockPath: MOCK_PATH,
      frame: 'p-home',
      viewport: 'desktop',
      theme: 'light',
    }, outDir);

    assert.equal(outPath, path.join(outDir, 'mock-home-desktop-light.png'));
    const stat = fs.statSync(outPath);
    assert.ok(stat.size > 0, 'PNG file should not be empty');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rejects an unknown viewport', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-mock-'));
  try {
    await assert.rejects(
      shootFrame({ mockPath: MOCK_PATH, frame: 'p-home', viewport: 'tablet', theme: 'light' }, outDir),
      /unknown viewport/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rejects a frame id that does not exist in the mock', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-mock-'));
  try {
    await assert.rejects(
      shootFrame({ mockPath: MOCK_PATH, frame: 'p-nope', viewport: 'desktop', theme: 'light' }, outDir),
      /not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rejects an unknown theme', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-mock-'));
  try {
    await assert.rejects(
      shootFrame({ mockPath: MOCK_PATH, frame: 'p-home', viewport: 'desktop', theme: 'sepia' }, outDir),
      /unknown theme/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rejects a frame id that is not a plain p-<page> slug', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-mock-'));
  try {
    await assert.rejects(
      shootFrame({ mockPath: MOCK_PATH, frame: 'p-../../escape', viewport: 'desktop', theme: 'light' }, outDir),
      /invalid frame id/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
