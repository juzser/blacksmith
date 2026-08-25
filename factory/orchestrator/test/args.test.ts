import { describe, expect, it } from 'vitest';
import { type FlagSpec, parseArgs } from '../src/args.js';

/**
 * D-131/D-132. `parseArgs` used to live in cli.ts, where cli.ts calls `main()`
 * at import time — so the only way to test it was to build the binary and read
 * a subcommand's output back, which is why two years of `--flag=value` being
 * dropped on the floor never showed up in a test.
 */
describe('parseArgs without a declared flag set', () => {
  it('reads the space-separated form', () => {
    const { flags } = parseArgs(['--target-dir', '/some/path']);
    expect(flags['target-dir']).toBe('/some/path');
  });

  // D-131: `--target-dir=/some/path` stored a flag literally named
  // `target-dir=/some/path`, `flags['target-dir']` stayed undefined, and the
  // caller silently took its default branch — exit 0, well-formed JSON, and a
  // different file checked than the operator named.
  it('splits the =-joined form on the first =', () => {
    const { flags } = parseArgs(['--target-dir=/some/path']);
    expect(flags['target-dir']).toBe('/some/path');
    expect(flags['target-dir=/some/path']).toBeUndefined();
  });

  it('keeps a = inside the value', () => {
    const { flags } = parseArgs(['--rationale=a=b']);
    expect(flags.rationale).toBe('a=b');
  });

  it('reads --flag= as the empty string, not as true', () => {
    // An operator who wrote `--note=` meant "no note", and `true` is a
    // sentence. The distinction matters because the value is recorded.
    const { flags } = parseArgs(['--note=']);
    expect(flags.note).toBe('');
  });

  it('still records =-joined occurrences in repeated and ordered', () => {
    const { repeated, ordered } = parseArgs(['--roots=a/**', '--roots', 'b/**']);
    expect(repeated.roots).toEqual(['a/**', 'b/**']);
    expect(ordered).toEqual([
      { key: 'roots', value: 'a/**' },
      { key: 'roots', value: 'b/**' },
    ]);
  });

  it('reports nothing unknown when it was given no set to check against', () => {
    expect(parseArgs(['--anything', 'x']).unknown).toEqual([]);
  });
});

describe('parseArgs against a declared flag set', () => {
  // name -> does the documented shape give it a value placeholder
  const spec: FlagSpec = new Map([
    ['target-dir', true],
    ['run-all', false],
    ['help', false],
  ]);

  // D-131, second consequence: `smith mcp check --verbose envkit` failed with
  // `Missing required argument <project>` because `envkit` was eaten as the
  // value of a boolean flag — an error that accuses the caller of omitting an
  // argument they did supply.
  it('does not let a valueless flag swallow the positional behind it', () => {
    const { positional, flags } = parseArgs(['--run-all', 'task-1'], spec);
    expect(positional).toEqual(['task-1']);
    expect(flags['run-all']).toBe('true');
  });

  it('still lets a value-taking flag consume the token behind it', () => {
    const { positional, flags } = parseArgs(['--target-dir', '/wt', 'task-1'], spec);
    expect(positional).toEqual(['task-1']);
    expect(flags['target-dir']).toBe('/wt');
  });

  // D-132: there was no allowlist. A typo, a flag from a different subcommand
  // and a correct flag were indistinguishable in the output.
  it('names a flag the command does not declare', () => {
    const { unknown } = parseArgs(['--totally-bogus', 'xyz'], spec);
    expect(unknown).toEqual(['totally-bogus']);
  });

  it('names the flag, not the flag-plus-value, when an unknown one is =-joined', () => {
    // The two defects compound: without the split, `--targetdir=/p` would be
    // reported as an unknown flag called `targetdir=/p`, which reads like a
    // parser bug rather than a typo the operator can see.
    const { unknown } = parseArgs(['--targetdir=/p'], spec);
    expect(unknown).toEqual(['targetdir']);
  });

  it('treats an unknown flag as valueless, so its neighbour stays a positional', () => {
    const { positional, unknown } = parseArgs(['--bogus', 'task-1'], spec);
    expect(unknown).toEqual(['bogus']);
    expect(positional).toEqual(['task-1']);
  });

  it('accepts a declared flag without complaint', () => {
    expect(parseArgs(['--target-dir=/wt'], spec).unknown).toEqual([]);
  });
});

/**
 * A flag the spec declares as value-taking, written without its value.
 *
 * The parser answered `'true'`, which is a legal value for every flag whose
 * value is a bare string -- so `--actor` landed in the append-only event log as
 * the actor named "true", `--session` filed a session's records under
 * `true.jsonl`, and `--task` filtered a timeline down to a task nobody named
 * and reported the empty list as the answer. Exit 0 in all three.
 *
 * Collected rather than thrown, exactly like `unknown`: the help path and the
 * unknown-command path both parse before anyone knows what the command is, and
 * a throw here would take them down with it. cli.ts refuses before dispatch.
 */
describe('parseArgs on a value-taking flag written without its value', () => {
  const spec: FlagSpec = new Map([
    ['target-dir', true],
    ['session', true],
    ['run-all', false],
    ['help', false],
  ]);

  it('names a flag whose value another flag took the place of', () => {
    const { missingValue } = parseArgs(['--target-dir', '--run-all'], spec);
    expect(missingValue).toEqual(['target-dir']);
  });

  it('names one left at the end of the command line', () => {
    expect(parseArgs(['--target-dir'], spec).missingValue).toEqual(['target-dir']);
  });

  it('names them in the order written, once each', () => {
    const { missingValue } = parseArgs(['--session', '--target-dir', '--session'], spec);
    expect(missingValue).toEqual(['session', 'target-dir']);
  });

  it('says nothing about a flag documented as taking nothing', () => {
    expect(parseArgs(['--run-all'], spec).missingValue).toEqual([]);
  });

  it('says nothing when the value is there', () => {
    expect(parseArgs(['--target-dir', '/wt'], spec).missingValue).toEqual([]);
  });

  // Same distinction the `--note=` test draws: an explicit empty value is a
  // thing the operator wrote, and a missing one is a thing they lost.
  it('counts an explicitly empty value as a value', () => {
    const { flags, missingValue } = parseArgs(['--target-dir='], spec);
    expect(flags['target-dir']).toBe('');
    expect(missingValue).toEqual([]);
  });

  // Disjoint by construction, and it has to stay that way: an unknown flag is
  // already being refused, and naming it twice reads as two separate mistakes.
  it('does not also report an undeclared flag as missing a value', () => {
    const { unknown, missingValue } = parseArgs(['--bogus'], spec);
    expect(unknown).toEqual(['bogus']);
    expect(missingValue).toEqual([]);
  });

  // "This command declares nothing" and "nobody asked what this command
  // declares" must not produce the same answer -- the reason `unknown` is
  // empty without a spec applies unchanged here.
  it('reports nothing when it was given no set to check against', () => {
    expect(parseArgs(['--target-dir']).missingValue).toEqual([]);
  });

  it('still records the flag, so a caller that ignores the report is unchanged', () => {
    const { flags, repeated, ordered } = parseArgs(['--target-dir'], spec);
    expect(flags['target-dir']).toBe('true');
    expect(repeated['target-dir']).toEqual(['true']);
    expect(ordered).toEqual([{ key: 'target-dir', value: 'true' }]);
  });
});
