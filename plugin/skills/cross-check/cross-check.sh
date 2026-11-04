#!/bin/sh
# cross-check.sh [base] [criteria|-]
# Sends the diff of the working tree against base (so uncommitted changes count),
# the changed test files and the criteria to codex for one read-only review, and
# prints what it answered. POSIX sh + git + codex.
#
# Arguments: base defaults to the merge-base with the default branch. The second
# argument is the criteria text, or "-" to read them from stdin (use a quoted
# heredoc so the shell never expands them).
#
# Env (all optional):
#   CROSSCHECK_MODEL      codex model          (default gpt-6-sol)
#   CROSSCHECK_EFFORT     reasoning effort     (default medium)
#   CROSSCHECK_MAX_BYTES  size cap, diff + tests (default 120000). Over it the
#                         check is skipped: half a diff yields confident
#                         findings about code that is not there.
#   CROSSCHECK_TIMEOUT    seconds before the codex call is stopped (default 540);
#                         codex and its child processes get TERM, then KILL after
#   CROSSCHECK_GRACE      seconds between the two (default 5)
#
# Always exits 0. When it cannot run it prints "cross-check: skipped (<reason>)".

model="${CROSSCHECK_MODEL:-gpt-6-sol}"
effort="${CROSSCHECK_EFFORT:-medium}"
max="${CROSSCHECK_MAX_BYTES:-120000}"
tmo="${CROSSCHECK_TIMEOUT:-540}"
grace="${CROSSCHECK_GRACE:-5}"
base="$1"
criteria="${2:-}"

skip() { printf 'cross-check: skipped (%s)\n' "$1"; exit 0; }

command -v codex >/dev/null 2>&1 || skip "codex is not installed or not on PATH"
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || skip "not inside a git repository"
real="$(cd "$repo" && pwd -P)"

if [ -z "$base" ]; then
  for b in "$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master main master; do
    [ -n "$b" ] && git rev-parse -q --verify "$b" >/dev/null 2>&1 && { base="$(git merge-base "$b" HEAD 2>/dev/null)"; break; }
  done
  [ -n "$base" ] || skip "no base given and no default branch found"
fi
git rev-parse -q --verify "$base" >/dev/null 2>&1 || skip "base '$base' is not a known revision"

[ "$criteria" = "-" ] && criteria="$(cat)"

work="$(mktemp -d 2>/dev/null)" || skip "cannot create a temp directory"
trap 'rm -rf "$work"' EXIT

git -C "$repo" diff "$base" > "$work/diff" 2>/dev/null || skip "git diff failed"
[ -s "$work/diff" ] || skip "no changes between $base and the working tree"

# Changed test files, whole, so the reviewer sees what is already covered. Symlinks
# and anything whose real path is outside the repository are never read.
: > "$work/tests"
git -C "$repo" diff --name-only -z "$base" 2>/dev/null | tr '\0' '\n' |
  grep -E '(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.|_test\.' |
  while IFS= read -r f; do
    p="$repo/$f"
    [ -f "$p" ] && [ ! -L "$p" ] || continue
    d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || continue
    case "$d" in "$real"|"$real"/*) ;; *) continue ;; esac
    printf '### %s\n' "$f"; cat "$p"; printf '\n'
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
# Run it in the background with a watchdog, since macOS has no timeout(1). Shell job
# control and process groups are not reliable without a terminal (dash refuses `set -m`),
# so on timeout the watchdog walks codex's process tree with ps, sends TERM to every
# member, and after the grace period KILL to every member, children included. The braces
# keep the shell's job notices off the output.
tree() { # tree <pid>: the pid and all its descendants, one per line
  echo "$1"
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" '
    { par[$1] = $2; id[NR] = $1 }
    END { seen[root] = 1; do { ch = 0
            for (i = 1; i <= NR; i++) if (!(id[i] in seen) && (par[id[i]] in seen)) { seen[id[i]] = 1; print id[i]; ch = 1 }
          } while (ch) }'
}
alive() { for q in $1; do kill -0 "$q" 2>/dev/null && return 0; done; return 1; }
{
  codex exec -s read-only -C "$repo" --color never -o "$work/out" \
    -m "$model" -c "model_reasoning_effort=\"$effort\"" - < "$work/prompt" > /dev/null 2> "$work/err" &
  pid=$!
  (
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      sleep 1; i=$((i + 1))
      if [ "$i" -ge "$tmo" ]; then
        : > "$work/timedout"
        procs="$(tree "$pid")"
        kill -TERM $procs 2>/dev/null
        g=0
        while alive "$procs" && [ "$g" -lt "$grace" ]; do sleep 1; g=$((g + 1)); done
        # a process the group spawned meanwhile is still under a live parent: add it
        kill -KILL $procs $(tree "$pid") 2>/dev/null
        break
      fi
    done
  ) > /dev/null 2>&1 &
  wd=$!
  wait "$pid"; rc=$?
  wait "$wd"
} 2>/dev/null
[ -e "$work/timedout" ] && skip "codex timed out after ${tmo}s (set CROSSCHECK_TIMEOUT to change)"
[ "$rc" -eq 0 ] || skip "codex call failed: $(tail -n 3 "$work/err" | tr '\n' ' ' | cut -c1-300)"
[ -s "$work/out" ] || skip "codex returned no answer"

untracked="$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
printf 'cross-check: findings from %s (effort %s) on %s vs the working tree, uncommitted changes included. Advisory until reproduced.\n\n' "$model" "$effort" "$base"
[ "${untracked:-0}" -gt 0 ] && printf 'Warning: %s untracked file(s) are not in the diff and were not reviewed. Run `git add -N <file>` to include them.\n\n' "$untracked"
cat "$work/out"
exit 0
