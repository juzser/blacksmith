// What has to be true on THIS box before a judge call can leave it, asked
// locally and answered without spending anything.
//
// There are exactly two questions — is the binary runnable, is the key set —
// and they are asked from two places that must never disagree:
// judgePreflight, which reports what the policy would cost, and crosscheck's
// parser, which resolves `enabled: auto` into the boolean every consumer
// reads. Two copies of "is codex installed" that drift apart would produce a
// preflight report about a configuration the parser did not build.
//
// Deliberately not a liveness check. `codex` on PATH does not mean `codex
// login` was run, and DEEPSEEK_API_KEY being set does not mean it is valid;
// only a real call knows that, and a check that spends a call to find out
// costs what it is trying to save. These answer the half that is free.
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Is `command` runnable — an absolute path that exists, or a name on PATH? */
export function commandOnPath(command: string): boolean {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // A command with a slash in it is a location, not a name, so PATH must not
  // be allowed to rescue it: a missing `./tools/judge` is missing even on a
  // box with some other `judge` installed.
  if (command.includes('/')) return executable(isAbsolute(command) ? command : join('.', command));
  const path = process.env.PATH ?? '';
  return path
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => executable(join(dir, command)));
}

/**
 * Is `name` set to something non-empty? Reads emptiness only, and never
 * returns or logs what it found — an exported-but-empty variable is the shape
 * a half-finished `.envrc` leaves behind, and it buys exactly as many API
 * calls as no variable at all.
 */
export function apiKeyPresent(name: string): boolean {
  return (process.env[name] ?? '').length > 0;
}
