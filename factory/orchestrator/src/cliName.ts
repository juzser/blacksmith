/**
 * bs-rename, operator decision 3: `smith`/`smith-run` keep working as
 * deprecated aliases of `bs`/`bs-run` for a transition period, each printing
 * one deprecation line to stderr (never stdout -- stdout is parsed as JSON by
 * playbooks) when invoked under the old name.
 *
 * Detection is argv[1]'s basename. `npm`/`pnpm`'s `bin` field creates one
 * shim per key, and each is an unextended file (a symlink on POSIX) literally
 * named after that key, sharing the same target script with its non-
 * deprecated sibling -- so this reads back exactly what the operator typed to
 * reach the running process, never the shared script file underneath it.
 */
import path from 'node:path';

export function invokedName(argv1: string | undefined): string | undefined {
  return argv1 === undefined ? undefined : path.basename(argv1);
}

/**
 * Writes the deprecation line when the current process was invoked as
 * `legacyName`; a no-op for every other invocation, `currentName` included.
 */
export function warnIfLegacyName(
  argv1: string | undefined,
  legacyName: string,
  currentName: string,
  writeStderr: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  if (invokedName(argv1) !== legacyName) return;
  writeStderr(
    `${legacyName}: deprecated, use "${currentName}" instead -- ${legacyName} will be removed in a future release.\n`,
  );
}
