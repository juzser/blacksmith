// The join between where the runbook tells an operator to put a key and where
// the code looks for one.
//
// `docs/runbooks/providers.md` says: set `DEEPSEEK_API_KEY` in `.env`
// (gitignored, per `docs/standards/guardrails.md`). `preconditions.ts` reads
// `process.env` and nothing else. Both were true for months and nothing joined
// them, so a key placed exactly where the repo asked for it resolved
// `enabled: auto` to off and `smith judge preflight` reported it unset. This
// module is that join and nothing more.
//
// Two decisions worth stating, because both are the kind that get "fixed"
// later by someone who did not know they were chosen:
//
// **A file never beats the runner.** CI and the daemon export secrets into the
// environment; `.env` is a convenience for a developer's box. A convenience
// that silently replaces the real thing is how a run spends a stale key and
// nobody can see why. So an already-set name is left exactly as it is, and is
// not reported as loaded.
//
// **Not `node --env-file`.** Node can do this at the flag, but the binary is
// reached by more than one road -- `smith`, `node dist/cli.js`, a daemon
// spawn, the UI server importing a module -- and a flag on one road covers one
// road. Doing it in-process at the entry covers all of them.
//
// Nothing here ever returns, throws, or logs a value: the return is the list
// of names, which is the same discipline `smith judge preflight` already
// keeps.
import { readFileSync } from 'node:fs';

/** `KEY=value`, with an optional `export` and space either side of the `=`. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Strip one layer of matching quotes, and only a matching pair. */
function unquote(raw: string): string {
  const value = raw.trim();
  const first = value.slice(0, 1);
  const quoted = value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first);
  // Inside quotes every character is the operator's: a `#` is part of the key,
  // not the start of a comment, and trailing space was typed on purpose.
  return quoted ? value.slice(1, -1) : value;
}

/**
 * Read `file` into `env`, setting only names it does not already hold.
 *
 * Returns the names it set -- never the values, and never anything about the
 * names it skipped. A missing or unreadable file is nothing to do, not an
 * error: most boxes have no `.env` and the factory runs fine on them.
 */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const named: string[] = [];
  for (const line of contents.split('\n')) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (match === null) continue;
    const name = match[1];
    const raw = match[2];
    if (name === undefined || raw === undefined) continue;
    if (env[name] !== undefined) continue;
    env[name] = unquote(raw);
    named.push(name);
  }
  return named;
}
