import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { COMMANDS, flagSpecFor, usageFor, usageLine, usageText } from '../src/usage.js';

const CLI_SOURCE = readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');

/**
 * A nested `if (action === '…') {` under a bare namespace guard, at either
 * indentation the dispatcher uses. Shared by both extractors below so they
 * cannot disagree about what a nested action looks like.
 */
const NESTED_ACTION_RE = /^ {4,6}if \(action === '([\w-]+)'\) \{/gm;

/**
 * Read the command set back out of the dispatcher itself.
 *
 * A hand-maintained help table is a second register of the same fact, and the
 * failure mode of a second register is that it drifts — silently, and in the
 * direction that hurts, because the command that goes undocumented is always
 * the new one. cli.ts rejects undocumented commands before dispatch, which
 * makes "documented ⊇ reachable" structural; this closes the other direction
 * so a command can't be dispatched without a line describing it.
 */
function dispatchedCommands(source: string): Set<string> {
  const commands = new Set<string>();
  const arms: Array<{ namespace: string; bare: boolean; index: number }> = [];
  const nested: Array<{ action: string; index: number }> = [];

  // `namespace === 'x' && action === 'y'`, plus the `(action === 'a' || action === 'b')` form.
  const pairRe =
    /namespace === '([\w-]+)' && \(?action === '([\w-]+)'(?: \|\| action === '([\w-]+)')?/g;
  for (const m of source.matchAll(pairRe)) {
    commands.add(`${m[1]} ${m[2]}`);
    if (m[3]) commands.add(`${m[1]} ${m[3]}`);
  }

  // Every top-level dispatch arm, in source order and in both shapes: a bare
  // `if (namespace === 'x') {` is either action-less (`new`, `dream`) or
  // dispatches its actions from a nested `if (action === ...)`, while a
  // pair-form arm names its action in the guard and was already recorded
  // above. Both kinds are collected because a nested action belongs to the arm
  // directly above it and only a bare arm may own one: a pair-form arm that
  // branches on `action` again inside it (`stack show` vs `stack check`) would
  // otherwise hand that branch to whichever bare namespace happened to sit
  // further up the file — inventing a command and swallowing a real one.
  for (const m of source.matchAll(/^ {2}if \(namespace === '([\w-]+)'(\) \{| &&)/gm)) {
    arms.push({ namespace: m[1] as string, bare: m[2] === ') {', index: m.index });
  }
  // The nested arm is matched at either depth because the depth is incidental:
  // `stats` opens a `try` around its actions and lands at six spaces,
  // `crossfind` does not and lands at four. Pinning one of them would have let
  // the other dispatch a command this guard never saw.
  for (const m of source.matchAll(NESTED_ACTION_RE)) {
    nested.push({ action: m[1] as string, index: m.index });
  }

  const hasNested = new Set<string>();
  for (const n of nested) {
    const owner = arms.filter((a) => a.index < n.index).pop();
    if (!owner?.bare) continue;
    commands.add(`${owner.namespace} ${n.action}`);
    hasNested.add(owner.namespace);
  }
  for (const a of arms) {
    if (a.bare && !hasNested.has(a.namespace)) commands.add(a.namespace);
  }

  return commands;
}

describe('the drift guard itself', () => {
  // A regex over source can fail open: rewrite the dispatcher and the
  // extractor quietly finds nothing, at which point set-equality is a
  // comparison between two empty ideas. These are the shapes it must keep
  // finding for the guard below to mean anything.
  const dispatched = dispatchedCommands(CLI_SOURCE);

  it('still finds the dispatcher after any refactor', () => {
    expect(dispatched.size).toBeGreaterThan(40);
  });

  it.each([
    ['a plain namespace/action pair', 'plan validate'],
    ['an action-less namespace', 'new'],
    ['the second arm of an || dispatch', 'lessons reject'],
    ['a nested action under a bare namespace', 'stats providers'],
    ['a nested action one indent shallower', 'crossfind run'],
  ])('finds %s (%s)', (_shape, command) => {
    expect(dispatched.has(command)).toBe(true);
  });

  it('does not mistake a namespace with nested actions for a command of its own', () => {
    expect(dispatched.has('stats')).toBe(false);
  });

  it("does not hand a pair-form arm's inner action branch to an earlier namespace", () => {
    // `stack` guards on `(action === 'show' || action === 'check')` and then
    // branches on `action` again inside. That inner branch belongs to nobody:
    // attributing it to the last bare namespace above it once produced a
    // phantom `new show` and lost the real `new`.
    expect(dispatched.has('new show')).toBe(false);
    expect(dispatched.has('new')).toBe(true);
  });
});

describe('COMMANDS', () => {
  it('documents exactly the commands cli.ts dispatches — no more, no fewer', () => {
    const documented = COMMANDS.map((c) => c.command);
    expect([...new Set(documented)].sort()).toEqual([...dispatchedCommands(CLI_SOURCE)].sort());
  });

  it('gives every command a summary', () => {
    for (const doc of COMMANDS) {
      expect(doc.summary.trim(), `${doc.command} has no summary`).not.toBe('');
    }
  });

  it('keeps flags out of the positional field', () => {
    // requirePositionals counts the <placeholders> in `positionals` and
    // demands one argument each. A flag placeholder living there would make
    // it demand a positional that does not exist.
    for (const doc of COMMANDS) {
      expect(doc.positionals, `${doc.command} has a flag in its positionals`).not.toContain('--');
    }
  });

  it('has a unique key per documented form', () => {
    const keys = COMMANDS.map((c) => (c.form ? `${c.command} ${c.form}` : c.command));
    expect(keys.length).toBe(new Set(keys).size);
  });
});

/**
 * D-139, and the reason D-132's allowlist can be derived rather than typed a
 * second time.
 *
 * `epic spec-review`'s handler called `requireFlag(flags, 'reviewed-by')` while
 * its usage line documented neither `--reviewed-by` nor
 * `--reviewed-by-provider`, so the documented invocation failed with
 * `cli.missing-flag` and the operator learned the real shape one refusal at a
 * time. That is survivable on its own. It stops being survivable once the flag
 * table is what the parser validates against: an undocumented flag a handler
 * reads would now be *rejected* rather than merely unmentioned.
 *
 * So this reads the flag names back out of each dispatcher branch and demands
 * the table contain them. It is deliberately source-scraping rather than
 * runtime: a flag read is not observable without running the command that
 * reads it, which is exactly the property that let four of these drift.
 */
describe('COMMANDS ⊇ the flags each handler reads', () => {
  /** The dispatcher branch bodies, keyed by the command each one serves. */
  function handlerBodies(source: string): Array<{ command: string; body: string }> {
    const branchRe =
      /^ {2}if \(namespace === '([\w-]+)'(?: && \(?action === '([\w-]+)'(?: \|\| action === '([\w-]+)')?\)?)?\) \{/gm;
    const marks = [...source.matchAll(branchRe)].map((m) => ({
      ns: m[1] as string,
      actions: [m[2], m[3]].filter((a): a is string => a !== undefined),
      index: m.index,
    }));
    const nested = [...source.matchAll(NESTED_ACTION_RE)].map((m) => ({
      action: m[1] as string,
      index: m.index,
    }));

    const out: Array<{ command: string; body: string }> = [];
    for (const [i, mark] of marks.entries()) {
      const end = marks[i + 1]?.index ?? source.length;
      const inner = nested.filter((n) => n.index > mark.index && n.index < end);
      if (mark.actions.length === 0 && inner.length > 0) {
        for (const [j, n] of inner.entries()) {
          out.push({
            command: `${mark.ns} ${n.action}`,
            body: source.slice(n.index, inner[j + 1]?.index ?? end),
          });
        }
        continue;
      }
      const body = source.slice(mark.index, end);
      if (mark.actions.length === 0) out.push({ command: mark.ns, body });
      else for (const a of mark.actions) out.push({ command: `${mark.ns} ${a}`, body });
    }
    return out;
  }

  /**
   * The flags read one level down, inside a shared `…FromFlags(flags)` helper.
   *
   * Scraping the branch body alone misses these entirely, and they are the
   * flags most likely to be undocumented precisely because they are shared: a
   * new verb calls `eventContextFromFlags(flags)` and inherits four flags
   * without typing any of their names, so nothing about writing the handler
   * prompts anyone to write the usage line. `dispatch check`, `findings
   * reverify` and `plan amend` each lost a flag exactly this way.
   */
  const HELPER_FLAGS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['eventContextFromFlags', ['session', 'plan-version', 'causal-parent', 'actor']],
    ['eventOptsFromFlags', ['state-dir']],
    ['planOptsFromFlags', ['specs-dir']],
    ['dbOptsFromFlags', ['state-dir', 'roadmap-path']],
  ];

  /** Every flag name a branch body reaches for, whichever accessor it uses. */
  function flagsRead(body: string): string[] {
    const names = new Set<string>();
    // boundedIntFlag joins the requireFlag family here, and not as an
    // afterthought: it is the accessor D-210 introduced, so every flag moved
    // onto it -- `--n`, `--port`, `--round` -- dropped out of this audit on the
    // way. The scrape is the only thing standing between a flag and an
    // undocumented one, and it fails open.
    for (const m of body.matchAll(
      /(?:require(?:Int)?Flag|boundedIntFlag)\((?:flags|args\.flags), '([a-z0-9-]+)'/g,
    ))
      names.add(m[1] as string);
    for (const m of body.matchAll(/\b(?:flags|repeated)\['([a-z0-9-]+)'\]/g))
      names.add(m[1] as string);
    for (const m of body.matchAll(/\b(?:flags|repeated)\.([a-zA-Z][a-zA-Z0-9]*)\b/g))
      names.add(m[1] as string);
    for (const [helper, flags] of HELPER_FLAGS)
      if (body.includes(`${helper}(`)) for (const f of flags) names.add(f);
    return [...names];
  }

  const bodies = handlerBodies(CLI_SOURCE);

  it('still finds the handler bodies after any refactor', () => {
    // Same fail-open hazard as the dispatcher guard above: an extractor that
    // finds nothing turns every assertion below into a vacuous truth.
    expect(bodies.length).toBeGreaterThan(40);
    expect(flagsRead(bodies.find((b) => b.command === 'gate run')?.body ?? '')).toContain(
      'worktree',
    );
  });

  it.each(
    // One case per command, so a failure names the verb rather than a list.
    [...new Set(bodies.map((b) => b.command))].sort(),
  )('%s declares every flag its handler reads', (command) => {
    const spec = flagSpecFor(...(command.split(' ') as [string, string?]));
    const body = bodies
      .filter((b) => b.command === command)
      .map((b) => b.body)
      .join('\n');
    const undeclared = flagsRead(body).filter((name) => !spec?.has(name));
    expect(
      undeclared,
      `${command}: usage.ts does not mention --${undeclared.join(', --')}`,
    ).toEqual([]);
  });
});

describe('flagSpecFor', () => {
  it('knows which flags carry a value and which are bare', () => {
    const spec = flagSpecFor('gate', 'run');
    expect(spec?.get('worktree')).toBe(true);
    expect(spec?.get('run-all')).toBe(false);
  });

  it('allows --help everywhere, because every command answers it', () => {
    expect(flagSpecFor('plan', 'validate')?.get('help')).toBe(false);
  });

  it('unions the forms of a command documented twice', () => {
    // `claims check` has two argument shapes and the operator has not chosen one
    // by the time the flags are parsed, so neither form's flags can be treated
    // as unknown. Only the `--roots` form declares any today, which is exactly
    // the case a single lookup would get wrong: the flagless `spec` form is a
    // match for the same key, and picking it would reject the documented
    // `smith claims check --roots <glob>` outright.
    const spec = flagSpecFor('claims', 'check');
    expect(spec?.has('roots')).toBe(true);
    expect(spec?.has('since')).toBe(true);
  });

  it('resolves an action-less verb from its namespace alone', () => {
    expect(flagSpecFor('new', 'my-project')?.has('ui')).toBe(true);
  });

  it('returns undefined for a command it does not document, rather than an empty allowlist', () => {
    // An empty map would mean "this command accepts no flags", which would
    // turn an unknown command into a pile of unknown-flag errors.
    expect(flagSpecFor('plan', 'teleport')).toBeUndefined();
  });
});

describe('usageLine', () => {
  it('reads as the line that would have worked', () => {
    expect(usageLine(usageFor('plan validate'))).toBe('smith plan validate <plan.json>');
  });

  it('shows the flag shape alongside the positionals', () => {
    const line = usageLine(usageFor('gate run'));
    expect(line.startsWith('smith gate run ')).toBe(true);
    expect(line).toContain('--session');
  });

  it('never leaves a double space where a part is empty', () => {
    for (const doc of COMMANDS) {
      expect(usageLine(doc), `${doc.command}`).not.toContain('  ');
    }
  });
});

describe('usageFor', () => {
  it('finds a command by its dispatch key', () => {
    expect(usageFor('event tail').command).toBe('event tail');
  });

  it('distinguishes the two shapes of a command that has two', () => {
    // Both take one positional, and they are different arguments: the
    // write-root form checks a directory against --roots globs, the spec form
    // diffs a worktree against a task's claims file.
    expect(usageFor('claims check --roots').positionals).toBe('<root-dir>');
    expect(usageFor('claims check --roots').flags).toContain('--roots');
    expect(usageFor('claims check spec').positionals).toContain('<worktree-dir>');
  });

  it('throws rather than returning a placeholder for a command it does not know', () => {
    expect(() => usageFor('plan teleport')).toThrow(/plan teleport/);
  });
});

describe('usageText', () => {
  it('lists every command when asked for all of them', () => {
    const text = usageText();
    for (const doc of COMMANDS) {
      expect(text, `${doc.command} missing from usage`).toContain(doc.command);
    }
  });

  it('narrows to one namespace when given one', () => {
    const text = usageText('plan');
    expect(text).toContain('plan validate');
    expect(text).toContain('plan ingest');
    expect(text).not.toContain('gate run');
  });

  it('names the namespaces so an operator can ask for a narrower listing', () => {
    const text = usageText();
    expect(text).toContain('smith <namespace> --help');
  });

  it('refuses a namespace that does not exist rather than printing nothing', () => {
    expect(() => usageText('teleport')).toThrow(/teleport/);
  });
});

/**
 * The other half of the drift guard above, and the half nothing checked: that
 * half asks whether the table NAMES every flag a handler reads, this one asks
 * whether the SHAPE it names can survive the parser.
 *
 * They are different questions. `integration check` documented `[--run-all
 * false]` and read `flags['run-all'] !== 'false'`, so the name matched and the
 * command passed every guard — but `flagsOf` only recognises a value written
 * as `<placeholder>`, so `--run-all` was declared valueless, `false` became a
 * stray positional, and the one documented way to make the epic gate
 * short-circuit did nothing at all (D-192).
 */
describe('COMMANDS: the flag shapes it documents are shapes the parser can read', () => {
  /**
   * The command line a doc entry promises, as argv, beside what each flag
   * should be holding once it has been parsed.
   *
   * Brackets and the variadic ellipsis are notation for the reader, so they
   * come off first. What is left is a flag, a `<placeholder>` standing for a
   * value the caller supplies, or a literal value the doc chose itself.
   */
  function documentedForm(flagsText: string): {
    argv: string[];
    expected: Record<string, string>;
  } {
    const tokens = flagsText
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.replace(/^\[+|\]+$/g, '').replace(/\.\.\.$/, ''));
    const argv: string[] = [];
    const expected: Record<string, string> = {};
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string;
      if (!token.startsWith('--')) continue;
      const name = token.slice(2);
      const next = tokens[i + 1];
      if (next?.startsWith('<')) {
        // A placeholder stands for whatever the caller types; the sentinel is
        // only distinctive enough that a flag which ate the wrong token shows.
        expected[name] = `value-of-${name}`;
        argv.push(token, `value-of-${name}`);
        i++;
      } else if (next !== undefined && !next.startsWith('--')) {
        expected[name] = next;
        argv.push(token, next);
        i++;
      } else {
        // parseArgs renders a flag that carries nothing as the string 'true'.
        expected[name] = 'true';
        argv.push(token);
      }
    }
    return { argv, expected };
  }

  const documented = COMMANDS.filter((doc) => doc.flags !== '');

  it('still builds a form for the commands that have one', () => {
    // Same fail-open hazard as the two guards above: a builder that produces
    // empty argv turns every case below into a vacuous truth.
    expect(documented.length).toBeGreaterThan(40);
    const gate = documentedForm(usageFor('gate run').flags);
    expect(gate.argv).toContain('--worktree');
    expect(gate.expected.worktree).toBe('value-of-worktree');
    expect(gate.expected['run-all']).toBe('true');
  });

  it.each(documented.map((doc) => [doc.form ? `${doc.command} ${doc.form}` : doc.command, doc]))(
    '%s: every flag it documents arrives with the value it documents',
    (_label, doc) => {
      const [namespace, action] = doc.command.split(' ') as [string, string?];
      const { argv, expected } = documentedForm(doc.flags);
      const parsed = parseArgs(argv, flagSpecFor(namespace, action));
      expect(parsed.flags, `${doc.command}: ${usageLine(doc)}`).toMatchObject(expected);
      // Nothing the flag string wrote may land somewhere else: a value the
      // parser did not know to consume becomes a positional, which is how
      // `--run-all false` turned into an argument to a command that takes none.
      expect(parsed.positional, `${doc.command}: leaked out of its flag`).toEqual([]);
      expect(parsed.unknown, `${doc.command}: undeclared by its own entry`).toEqual([]);
    },
  );
});
