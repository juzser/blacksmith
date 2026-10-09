/**
 * The `Declared artifact: <path>` line a judge dispatch carries in its prompt.
 *
 * A leaf module with no local imports, so the PreToolUse hook (which must stay
 * free of the database layer), `judgeStopHook.ts`, and `dispatchLint.ts` all
 * read the line with one parser: what the dispatch guard accepts is exactly
 * what judge-stop later reads. `dispatchLint.ts` re-exports these.
 */

const DECLARED_ARTIFACT_LINE = /^Declared artifact:[ \t]*(\S+)[ \t]*$/m;

/** `Declared artifact: <path>` in a dispatch prompt, or null when the line is not there. */
export function parseDeclaredArtifactLine(prompt: string): string | null {
  const match = DECLARED_ARTIFACT_LINE.exec(prompt);
  return match?.[1] ?? null;
}

/** The line a dispatch is expected to carry verbatim, given the ledger's declared path. */
export function formatDeclaredArtifactLine(artifactPath: string): string {
  return `Declared artifact: ${artifactPath}`;
}
