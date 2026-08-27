// The operator's stack answers (architecture §14 "Unified stack standard"),
// read from factory/policies/stack.yml.
//
// This used to be prose. `docs/standards/stack.md` carried one operator's
// 2026-08-03 interview answers — Vue, Cloudflare Workers, Drizzle, a private
// design system — phrased as a mandate ("Every project Blacksmith scaffolds
// uses this stack"), which is a fine sentence in a private repo and a false
// one in a public clone: the design system it required is not obtainable, and
// nobody else answered those questions. So the answers moved here, where they
// are data an operator sets at install time and the scaffolder can act on.
//
// Two rules keep that honest, and both are enforced below rather than
// described:
//
//   1. An answer the shipped templates cannot implement makes `smith new`
//      REFUSE. The failure mode this exists to prevent is the quiet one —
//      answering `frontend: react` and receiving a Vue project, which reads as
//      the factory ignoring the interview it just ran.
//   2. `smith stack check` reports, per answer, whether the templates honour
//      it or merely record it for the agents to read. Most answers are
//      recorded: Blacksmith scaffolds a TypeScript library and optionally a
//      Vue front end, and says so, instead of implying it can scaffold every
//      row of the file.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { REPO_ROOT, STACK_POLICY_PATH } from './paths.js';

export class StackError extends SmithError {}

// ---------------------------------------------------------------------------
// stack.yml — parsed shape
// ---------------------------------------------------------------------------

export interface StackAnswers {
  language: string;
  frontend: string;
  designSystem: string;
  designSystemSource: string;
  styling: string;
  backend: string;
  database: string;
  orm: string;
  packageManager: string;
  repoShape: string;
  lint: string;
  testUnit: string;
  testE2e: string;
  ci: string;
  hosting: string;
}

/**
 * The closed vocabularies, and the defaults.
 *
 * Every list carries the value that assumes least — `none`, or the one thing
 * the templates actually build — as its default, and most carry an `other`
 * escape so an unlisted stack is representable rather than unspeakable. The
 * lists are closed anyway, because these are answers code branches on: a
 * `frontend: veu` that parses as free text scaffolds nothing and explains
 * nothing, while a closed vocabulary can name the typo back at the operator.
 */
const VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  language: ['typescript', 'javascript', 'python', 'go', 'rust', 'other'],
  frontend: ['none', 'vue', 'react', 'svelte', 'solid', 'vite-vanilla', 'other'],
  styling: ['plain-css', 'tailwind', 'css-modules', 'vanilla-extract', 'other'],
  backend: ['none', 'node', 'deno', 'bun', 'cloudflare-workers', 'other'],
  database: ['none', 'sqlite', 'postgres', 'mysql', 'd1', 'other'],
  orm: ['none', 'drizzle', 'prisma', 'kysely', 'other'],
  package_manager: ['pnpm', 'npm', 'yarn', 'bun'],
  repo_shape: ['single', 'monorepo'],
  lint: ['biome', 'eslint-prettier', 'none'],
  test_unit: ['vitest', 'jest', 'node-test', 'none'],
  test_e2e: ['playwright', 'cypress', 'none'],
  ci: ['github-actions', 'gitlab-ci', 'circleci', 'none'],
};

const DEFAULTS: Readonly<Record<string, string>> = {
  language: 'typescript',
  frontend: 'none',
  design_system: 'none',
  design_system_source: '',
  styling: 'plain-css',
  backend: 'none',
  database: 'none',
  orm: 'none',
  package_manager: 'pnpm',
  repo_shape: 'single',
  lint: 'biome',
  test_unit: 'vitest',
  test_e2e: 'playwright',
  ci: 'github-actions',
  hosting: 'unspecified',
};

/**
 * A closed-vocabulary answer, checked rather than trusted (D-203).
 *
 * The YAML 1.2 core schema is the reason this cannot lean on TypeScript's
 * declared types: `frontend: no` parses as the string `'no'`, `hosting: on`
 * as `'on'`, and an unquoted version number as a number. A field read as
 * anything but a listed string is a field whose branch below picks a
 * direction the operator did not choose, so it stops here with the list in
 * the message — a stack file is hand-edited, and a refusal that does not name
 * the alternatives just sends the operator back to the docs.
 */
function choice(field: string, value: unknown): string {
  const allowed = VOCABULARY[field];
  if (allowed === undefined)
    throw new StackError('stack.unknown-field', `No vocabulary for ${field}.`);
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new StackError(
      'stack.invalid-policy',
      `stack.yml ${field} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(value)}.`,
      { field, value, allowed },
    );
  }
  return value;
}

/** A free-text answer: a name, a path, a place. Still has to be a string. */
function text(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new StackError(
      'stack.invalid-policy',
      `stack.yml ${field} must be a string; got ${JSON.stringify(value)}. Quote it if YAML is reading it as something else.`,
      { field, value },
    );
  }
  return value.trim();
}

export function parseStackAnswers(yamlText: string): StackAnswers {
  const doc = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  const pick = (field: string): unknown => doc[field] ?? DEFAULTS[field];
  const answers: StackAnswers = {
    language: choice('language', pick('language')),
    frontend: choice('frontend', pick('frontend')),
    designSystem: text('design_system', pick('design_system')) || 'none',
    designSystemSource: text('design_system_source', pick('design_system_source')),
    styling: choice('styling', pick('styling')),
    backend: choice('backend', pick('backend')),
    database: choice('database', pick('database')),
    orm: choice('orm', pick('orm')),
    packageManager: choice('package_manager', pick('package_manager')),
    repoShape: choice('repo_shape', pick('repo_shape')),
    lint: choice('lint', pick('lint')),
    testUnit: choice('test_unit', pick('test_unit')),
    testE2e: choice('test_e2e', pick('test_e2e')),
    ci: choice('ci', pick('ci')),
    hosting: text('hosting', pick('hosting')) || 'unspecified',
  };
  // A source with nothing to vendor into is the one cross-field mistake worth
  // catching at parse time: `design_system: none` plus a path reads as a kit
  // that will be copied, and it never is.
  if (answers.designSystem === 'none' && answers.designSystemSource !== '') {
    throw new StackError(
      'stack.invalid-policy',
      'stack.yml sets design_system_source while design_system is none — name the design system, or clear the source.',
      { source: answers.designSystemSource },
    );
  }
  return answers;
}

export function loadStackAnswers(filePath: string = STACK_POLICY_PATH): StackAnswers {
  return parseStackAnswers(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// What the shipped templates actually do with each answer
// ---------------------------------------------------------------------------

/**
 * - `honoured` — the templates implement this answer.
 * - `refused`  — they cannot, and `smith new` stops rather than substituting.
 * - `recorded` — nothing in `factory/scaffold/` reads it; the agents do.
 */
export type StackSupport = 'honoured' | 'refused' | 'recorded';

export interface StackAnswerReport {
  field: string;
  value: string;
  support: StackSupport;
  note: string;
}

export interface StackCheckReport {
  /** True when nothing is `refused` — i.e. `smith new` can serve these answers. */
  ok: boolean;
  answers: StackAnswerReport[];
}

/** Values `factory/scaffold/` can build. Everything else is a refusal, not a substitution. */
export const SCAFFOLDABLE = {
  language: ['typescript'],
  frontend: ['none', 'vue'],
  styling: ['plain-css', 'tailwind'],
} as const;

/**
 * What the template tree hardcodes for answers no code branches on.
 *
 * These are not unsupported — they are supported at exactly one value. Saying
 * which one turns "we ignore this answer" into "we ship pnpm; yours says npm;
 * the agents will read npm and the scaffold will not", which is a thing an
 * operator can act on.
 */
const HARDCODED: Readonly<Record<string, { value: string; where: string }>> = {
  package_manager: {
    value: 'pnpm',
    where: 'the scaffold toolchain run, ci.yml and pnpm-workspace.yaml',
  },
  repo_shape: { value: 'single', where: "pnpm-workspace.yaml's single-package list" },
  lint: { value: 'biome', where: 'biome.json and the `lint` script' },
  test_unit: { value: 'vitest', where: 'vitest.config.ts and the `test` scripts' },
  ci: { value: 'github-actions', where: '.github/workflows/ci.yml' },
};

/** Answers the templates scaffold nothing for, and the agent that reads each one instead. */
const READ_BY: Readonly<Record<string, string>> = {
  backend: 'the planner and coder, when a task needs a server',
  database: 'the planner and coder, when a task needs storage',
  orm: 'the coder, when a task touches the database',
  test_e2e: 'the tester, which sets the harness up on the first e2e task',
  hosting: 'the planner, when an epic reaches a deploy runbook',
};

function reportFor(field: string, value: string, source: string | null): StackAnswerReport {
  if (field === 'language') {
    return SCAFFOLDABLE.language.includes(value as 'typescript')
      ? { field, value, support: 'honoured', note: 'The base template scaffolds TypeScript.' }
      : {
          field,
          value,
          support: 'refused',
          note: `\`smith new\` refuses: factory/scaffold/base is TypeScript, and scaffolding it under a ${value} answer would hand you a project you did not ask for.`,
        };
  }
  if (field === 'frontend') {
    if (value === 'none') {
      return {
        field,
        value,
        support: 'honoured',
        note: '`smith new --ui` refuses until this names a framework.',
      };
    }
    return value === 'vue'
      ? { field, value, support: 'honoured', note: 'factory/scaffold/ui scaffolds Vue 3 + Vite.' }
      : {
          field,
          value,
          support: 'refused',
          note: `\`smith new --ui\` refuses: the UI template is Vue, and there is no ${value} template to layer instead.`,
        };
  }
  if (field === 'styling') {
    return SCAFFOLDABLE.styling.includes(value as 'plain-css')
      ? {
          field,
          value,
          support: 'honoured',
          note:
            value === 'tailwind'
              ? 'factory/scaffold/ui-tailwind layers the Vite plugin and the dependency.'
              : 'The UI template ships no utility layer.',
        }
      : {
          field,
          value,
          support: 'refused',
          note: `\`smith new --ui\` refuses: the UI template wires plain CSS or Tailwind, not ${value}.`,
        };
  }
  if (field === 'design_system') {
    if (value === 'none') {
      return {
        field,
        value,
        support: 'honoured',
        note: "The uiux agent specs against the project's own components, and nothing is vendored.",
      };
    }
    if (source === null || source === '') {
      return {
        field,
        value,
        support: 'recorded',
        note: `The uiux agent is told to ground its specs in ${value}; with design_system_source empty, no kit is copied into scaffolded projects.`,
      };
    }
    const resolved = path.isAbsolute(source) ? source : path.join(REPO_ROOT, source);
    return existsSync(resolved)
      ? {
          field,
          value,
          support: 'honoured',
          note: `Vendored from ${source} into <project>/design/.`,
        }
      : {
          field,
          value,
          support: 'refused',
          note: `design_system_source ${source} does not exist, so \`smith new --ui\` would vendor nothing while claiming ${value}.`,
        };
  }
  const hardcoded = HARDCODED[field];
  if (hardcoded !== undefined) {
    return value === hardcoded.value
      ? {
          field,
          value,
          support: 'honoured',
          note: `Matches what the templates ship in ${hardcoded.where}.`,
        }
      : {
          field,
          value,
          support: 'recorded',
          note: `The templates hardcode ${hardcoded.value} in ${hardcoded.where}. The agents read ${value}; \`smith new\` still scaffolds ${hardcoded.value}.`,
        };
  }
  return {
    field,
    value,
    support: 'recorded',
    note: `Nothing in factory/scaffold reads this. Read by ${READ_BY[field] ?? 'the agents'}.`,
  };
}

/**
 * The per-answer support report behind `smith stack check`.
 *
 * `ok` is false only for `refused` — a `recorded` mismatch is information, not
 * a fault, and failing on it would make the check red for every operator whose
 * stack is merely wider than the template tree. A `refused` answer, by
 * contrast, is a scaffold that will not run, and the install is the right time
 * to learn that rather than the first `smith new`.
 */
export function checkStack(answers: StackAnswers): StackCheckReport {
  const fields: [string, string][] = [
    ['language', answers.language],
    ['frontend', answers.frontend],
    ['design_system', answers.designSystem],
    ['design_system_source', answers.designSystemSource],
    ['styling', answers.styling],
    ['backend', answers.backend],
    ['database', answers.database],
    ['orm', answers.orm],
    ['package_manager', answers.packageManager],
    ['repo_shape', answers.repoShape],
    ['lint', answers.lint],
    ['test_unit', answers.testUnit],
    ['test_e2e', answers.testE2e],
    ['ci', answers.ci],
    ['hosting', answers.hosting],
  ];
  const report = fields
    // design_system_source has no verdict of its own: it is half of the
    // design_system answer, and reporting it twice would let one row say
    // `honoured` while the other said `refused` about the same fact.
    .filter(([field]) => field !== 'design_system_source')
    .map(([field, value]) => reportFor(field, value, answers.designSystemSource));
  return { ok: report.every((entry) => entry.support !== 'refused'), answers: report };
}

/**
 * The gate `smith new` calls before it writes a single file.
 *
 * Throws on the answers this scaffold cannot serve, and says which file to
 * edit. `ui` is separate because a library project has no opinion about
 * frontend or styling, and refusing a plain `smith new` over a `frontend:
 * react` answer would block work the templates can do perfectly well.
 */
export function requireScaffoldable(answers: StackAnswers, opts: { ui: boolean }): void {
  const refuse = (
    field: string,
    value: string,
    allowed: readonly string[],
    what: string,
  ): never => {
    throw new StackError(
      'stack.unsupported-answer',
      `${what} — factory/policies/stack.yml answers ${field}: ${value}, and factory/scaffold/ ships ${allowed.join(' or ')}. Change the answer, or scaffold this project by hand.`,
      { field, value, allowed },
    );
  };
  if (!SCAFFOLDABLE.language.includes(answers.language as 'typescript')) {
    refuse('language', answers.language, SCAFFOLDABLE.language, 'Cannot scaffold this project');
  }
  if (!opts.ui) return;
  if (answers.frontend === 'none') {
    throw new StackError(
      'stack.unsupported-answer',
      '--ui needs a frontend: factory/policies/stack.yml answers frontend: none. Set it to vue, or drop --ui.',
      { field: 'frontend', value: answers.frontend },
    );
  }
  if (!SCAFFOLDABLE.frontend.includes(answers.frontend as 'vue')) {
    refuse('frontend', answers.frontend, ['vue'], 'Cannot scaffold this UI');
  }
  if (!SCAFFOLDABLE.styling.includes(answers.styling as 'plain-css')) {
    refuse('styling', answers.styling, SCAFFOLDABLE.styling, 'Cannot scaffold this UI');
  }
}
