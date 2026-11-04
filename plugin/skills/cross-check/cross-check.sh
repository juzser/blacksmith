#!/bin/sh
# cross-check.sh [base] [criteria]
# Sends the diff base...HEAD, the changed test files and the criteria to codex
# for one read-only review, and prints what it answered. POSIX sh + git + codex.
#
# Env (all optional):
#   CROSSCHECK_MODEL      codex model          (default gpt-6-sol)
#   CROSSCHECK_EFFORT     reasoning effort     (default medium)
#   CROSSCHECK_MAX_BYTES  size cap, diff + tests (default 120000). Over it the
#                         check is skipped: half a diff yields confident
#                         findings about code that is not there.
#
# Always exits 0. When it cannot run it prints "cross-check: skipped (<reason>)".

model="${CROSSCHECK_MODEL:-gpt-6-sol}"
effort="${CROSSCHECK_EFFORT:-medium}"
max="${CROSSCHECK_MAX_BYTES:-120000}"
base="$1"
criteria="${2:-}"

skip() { printf 'cross-check: skipped (%s)\n' "$1"; exit 0; }

command -v codex >/dev/null 2>&1 || skip "codex is not installed or not on PATH"
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || skip "not inside a git repository"

if [ -z "$base" ]; then
  for b in "$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master main master; do
    [ -n "$b" ] && git rev-parse -q --verify "$b" >/dev/null 2>&1 && { base="$(git merge-base "$b" HEAD 2>/dev/null)"; break; }
  done
  [ -n "$base" ] || skip "no base given and no default branch found"
fi
git rev-parse -q --verify "$base" >/dev/null 2>&1 || skip "base '$base' is not a known revision"

work="$(mktemp -d 2>/dev/null)" || skip "cannot create a temp directory"
trap 'rm -rf "$work"' EXIT

git -C "$repo" diff "$base"...HEAD > "$work/diff" 2>/dev/null || skip "git diff failed"
[ -s "$work/diff" ] || skip "no changes between $base and HEAD"

# Changed test files, whole, so the reviewer sees what is already covered.
: > "$work/tests"
git -C "$repo" diff --name-only "$base"...HEAD 2>/dev/null |
  grep -E '(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.|_test\.' |
  while IFS= read -r f; do
    [ -f "$repo/$f" ] && { printf '### %s\n' "$f"; cat "$repo/$f"; printf '\n'; }
  done >> "$work/tests"

size=$(( $(wc -c < "$work/diff") + $(wc -c < "$work/tests") ))
[ "$size" -le "$max" ] || skip "diff and tests are $size bytes, over the cap of $max (set CROSSCHECK_MAX_BYTES to raise it)"

{
  printf 'You are reviewing a change you did not write. Answer exactly two questions.\n\n'
  printf '1. List the real defects in the diff. For each one give the file and line, a concrete input, and the output it produces versus the output it should produce. Skip style and speculation you cannot back with an input.\n'
  printf '2. List the acceptance criteria that no test would catch if the code implementing them were removed.\n\n'
  printf 'If a question has no findings, say "none" for it.\n\n'
  printf '## Acceptance criteria\n\n%s\n\n' "${criteria:-(none given: judge against what the diff evidently sets out to do)}"
  printf '## Diff\n\n'; cat "$work/diff"
  printf '\n## Changed test files\n\n'
  if [ -s "$work/tests" ]; then cat "$work/tests"; else printf '(none changed)\n'; fi
} > "$work/prompt"

# The answer comes from the -o file only: plain exec echoes the whole prompt to stderr.
if ! codex exec -s read-only -C "$repo" --color never -o "$work/out" \
     -m "$model" -c "model_reasoning_effort=\"$effort\"" - < "$work/prompt" > /dev/null 2> "$work/err"; then
  skip "codex call failed: $(tail -n 3 "$work/err" | tr '\n' ' ' | cut -c1-300)"
fi
[ -s "$work/out" ] || skip "codex returned no answer"

printf 'cross-check: findings from %s (effort %s), advisory until reproduced\n\n' "$model" "$effort"
cat "$work/out"
exit 0
