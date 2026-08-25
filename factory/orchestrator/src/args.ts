/**
 * argv → flags, positionals, and the flags nobody declared (D-131/D-132).
 *
 * This lived in cli.ts until D-131, which is most of why D-131 lived as long as
 * it did: cli.ts calls `main()` at import time, so nothing here could be
 * exercised except by building the binary and inferring the parse from a
 * subcommand's output. `--flag=value` was therefore dropped on the floor by
 * every command, and for a flag with a default the whole symptom was that the
 * default won — exit 0, well-formed JSON, the wrong target read.
 *
 * usage.ts is the register of what each command accepts; this module is the
 * only thing that reads a command line against it.
 */

export interface FlagOccurrence {
  key: string;
  value: string;
}

/**
 * Flag name → whether the documented shape gives it a value placeholder.
 *
 * The value half is not decoration. `if (next !== undefined &&
 * !next.startsWith('--'))` — the old rule — makes a valueless flag eat the
 * token behind it, so `smith mcp check --verbose envkit` failed with
 * `Missing required argument <project>`: an error accusing the caller of
 * omitting an argument they had supplied. Knowing that `--verbose` takes
 * nothing is what keeps `envkit` a positional.
 */
export type FlagSpec = ReadonlyMap<string, boolean>;

export interface ParsedArgs {
  positional: string[];
  /** Last occurrence wins — what every single-valued flag reads. */
  flags: Record<string, string>;
  /**
   * Every occurrence, in order, for the flags that legitimately repeat
   * (`--roots <glob> --roots <glob>`, P9-3). Kept beside `flags` rather than
   * replacing it so the ~40 existing single-valued readers are untouched.
   *
   * Repetition, not comma-splitting: a glob may contain a comma
   * (`src/{a,b}/**`), so splitting the value would corrupt the pattern it was
   * asked to match.
   */
  repeated: Record<string, string[]>;
  /**
   * Every occurrence of every flag, in the order the command line wrote them
   * (D-32/P9-13).
   *
   * `flags` and `repeated` are both keyed by flag name, so neither can answer
   * "which `--found-by` followed *this* `--evidence`" — the question a gate run
   * with two judges has to answer, and the reason a second judge's findings
   * used to be filed under the first judge's name.
   */
  ordered: FlagOccurrence[];
  /**
   * The flag names `spec` does not contain, in the order they were written.
   *
   * Always empty when no `spec` was given: "this command declares nothing" and
   * "nobody asked what this command declares" must not produce the same answer,
   * because the second is what the help path and an unknown command both hit.
   */
  unknown: string[];
  /**
   * The flags `spec` declares as value-taking that were written without one,
   * in the order they appear, once each.
   *
   * A flag with a value placeholder and nothing behind it used to parse as the
   * string `'true'`, which is a legal value for every flag whose value is a
   * bare string. So `--actor` reached the append-only event log as the actor
   * named "true", `--session` filed a session's records under `true.jsonl`,
   * and `--task` narrowed a timeline to a task nobody named and printed the
   * empty result as the answer. Eighty flags across sixty-seven commands take
   * a value; one of them, `--no-findings`, had a hand-written guard in cli.ts
   * against exactly this, which is the whole argument for doing it here.
   *
   * Reported rather than thrown, for the same reason `unknown` is: the help
   * path and the unknown-command path both parse before anyone has established
   * what the command is, and a throw here would take them down with it. Empty
   * without a `spec`, also for the same reason — nobody asked.
   */
  missingValue: string[];
}

/**
 * Split `--name=value` at the FIRST `=`, so a value may contain one.
 * Returns null for a token that is not a flag.
 */
function splitToken(arg: string): { key: string; inlineValue: string | undefined } | null {
  if (!arg.startsWith('--') || arg === '--') return null;
  const body = arg.slice(2);
  const eq = body.indexOf('=');
  if (eq < 0) return { key: body, inlineValue: undefined };
  // `--=x` names no flag; leave it to the unknown-flag path rather than
  // inventing an empty-named one.
  return { key: body.slice(0, eq), inlineValue: body.slice(eq + 1) };
}

export function parseArgs(argv: string[], spec?: FlagSpec): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const ordered: FlagOccurrence[] = [];
  const unknown: string[] = [];
  const missingValue: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const token = splitToken(arg);
    if (token === null) {
      positional.push(arg);
      continue;
    }

    const { key, inlineValue } = token;
    const declared = spec === undefined ? undefined : spec.get(key);
    if (spec !== undefined && declared === undefined && !unknown.includes(key)) unknown.push(key);

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (declared === false) {
      // Documented as taking nothing: whatever follows belongs to someone else.
      value = 'true';
    } else if (spec !== undefined && declared === undefined) {
      // An unknown flag is about to be refused. Consuming the token behind it
      // would turn one clear "no such flag" into that plus a missing positional.
      value = 'true';
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        // Declared to take a value and handed none. `'true'` is still stored,
        // so a caller that ignores the report parses exactly as it did before
        // and cli.ts is the one place that has to refuse. `declared === true`
        // is load-bearing: `undefined` here means no spec was given, and there
        // `'true'` is the only answer available.
        if (declared === true && !missingValue.includes(key)) missingValue.push(key);
        value = 'true';
      }
    }

    flags[key] = value;
    const seen = repeated[key] ?? [];
    seen.push(value);
    repeated[key] = seen;
    ordered.push({ key, value });
  }

  return { positional, flags, repeated, ordered, unknown, missingValue };
}
