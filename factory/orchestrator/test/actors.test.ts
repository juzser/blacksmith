// D-164. Two readers asked "did a person decide this?" by comparing `actor` to
// a string literal, and picked different literals: the Decisions lens took
// 'user', the plan sign-off checkpoint took 'operator'. Neither was wrong on
// its own terms and both were wrong about the log — across the 668 events the
// factory has recorded, 'user' never appears and 'operator' covers one plan
// version in seven. The behavioural fix is in isOperatorActor; the lint below
// is what stops the third reader from inventing a third answer.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOperatorActor, operatorActors } from '../src/actors.js';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

describe('isOperatorActor', () => {
  it('accepts every spelling of the operator the factory actually writes', () => {
    // 'user' is the UI's default, 'operator' is what the operator guide and the
    // /bs skill hand out, 'operator-skill' is what the console passes.
    expect(['user', 'operator', 'operator-skill'].map(isOperatorActor)).toEqual([true, true, true]);
    expect(operatorActors()).toEqual(['user', 'operator', 'operator-skill']);
  });

  it('rejects the factory itself, so a lens does not report traffic as decisions', () => {
    for (const actor of ['system', 'planner', 'scribe', 'coder', 'grader', 'reviewer']) {
      expect(isOperatorActor(actor)).toBe(false);
    }
  });

  it('rejects a missing actor rather than guessing', () => {
    expect(isOperatorActor(null)).toBe(false);
    expect(isOperatorActor(undefined)).toBe(false);
    expect(isOperatorActor('')).toBe(false);
  });
});

describe('no reader answers the operator question on its own (D-164)', () => {
  it('nothing in src compares an actor against a string literal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (rel === 'actors.ts') continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Comments are where this rule gets explained, so read code only:
          // skip the body lines of a doc block and drop any `//` tail.
          if (/^\s*[*/]/.test(line)) return;
          const code = line.split('//')[0] ?? '';
          if (/\bactor\s*[!=]==\s*['"`]/.test(code)) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
