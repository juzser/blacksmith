#!/bin/sh
# cross-check.sh [base] [criteria|-]
# Sends the diff of the working tree against base (so uncommitted changes count),
# the changed test files and the criteria to each available provider for one review,
# and prints what each answered, one group per provider. POSIX sh + git, plus codex
# for the codex provider, curl and node (or python3) for the deepseek provider.
#
# Arguments: base defaults to the merge-base with the default branch. The second
# argument is the criteria text, or "-" to read them from stdin (use a quoted
# heredoc so the shell never expands them).
#
# Env (all optional):
#   CROSSCHECK_PROVIDERS  providers to run, space or comma separated (default
#                         "codex"). DeepSeek is opt-in: it runs only when named,
#                         e.g. "codex deepseek". A listed provider that is not
#                         available (no codex, no DEEPSEEK_API_KEY) is skipped.
#   CROSSCHECK_MODEL      codex model          (default gpt-6-sol)
#   CROSSCHECK_EFFORT     codex reasoning effort (default medium)
#   CROSSCHECK_DEEPSEEK_MODEL  deepseek model  (default deepseek-v4-pro; pinned,
#                         because a retired id is silently answered by another model)
#   CROSSCHECK_DEEPSEEK_URL    chat completions endpoint (default
#                         https://api.deepseek.com/chat/completions). https only;
#                         http is accepted for 127.0.0.1 and localhost (tests).
#   CROSSCHECK_MAX_BYTES  size cap, diff + tests (default 120000). Over it the
#                         check is skipped: half a diff yields confident
#                         findings about code that is not there.
#   CROSSCHECK_TIMEOUT    seconds before the calls are stopped (default 540);
#                         each call and its child processes get TERM, then KILL after
#   CROSSCHECK_GRACE      seconds between the two (default 5)
#
# DEEPSEEK_API_KEY is read from the environment only, then removed from it, so codex
# and every other child never see it. It reaches curl on stdin (-H @-): no file, no
# command line, and it is never printed.
#
# Always exits 0. When it cannot run it prints "cross-check: skipped (<reason>)".

set -f
key="${DEEPSEEK_API_KEY:-}"; unset DEEPSEEK_API_KEY
model="${CROSSCHECK_MODEL:-gpt-6-sol}"
effort="${CROSSCHECK_EFFORT:-medium}"
dsmodel="${CROSSCHECK_DEEPSEEK_MODEL:-deepseek-v4-pro}"
dsurl="${CROSSCHECK_DEEPSEEK_URL:-https://api.deepseek.com/chat/completions}"
max="${CROSSCHECK_MAX_BYTES:-120000}"
tmo="${CROSSCHECK_TIMEOUT:-540}"
grace="${CROSSCHECK_GRACE:-5}"
base="$1"
criteria="${2:-}"

skip() { printf 'cross-check: skipped (%s)\n' "$1"; exit 0; }

provs=""
for p in $(printf '%s' "${CROSSCHECK_PROVIDERS:-codex}" | tr ',' ' '); do
  case "$p" in codex|deepseek) ;; *) skip "unknown provider '$p' in CROSSCHECK_PROVIDERS (use codex, deepseek)" ;; esac
  case " $provs " in *" $p "*) ;; *) provs="$provs $p" ;; esac
done
[ -n "$provs" ] || skip "CROSSCHECK_PROVIDERS names no provider"
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

# An explicit template: macOS mktemp ignores TMPDIR when it has none.
work="$(mktemp -d "${TMPDIR:-/tmp}/crosscheck.XXXXXX" 2>/dev/null)" || skip "cannot create a temp directory"
trap 'rm -rf "$work"' EXIT
# From here a signal must clean up too (dash skips the EXIT trap on a signal).
trap 'printf "cross-check: skipped (cancelled)\n"; exit 0' INT TERM HUP

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

# Each provider runs as a background job that leaves its answer in $work/<p>.out, or a
# reason in $work/<p>.skip, and $work/<p>.done when it ends by itself. One watchdog
# covers all of them, since macOS has no timeout(1). Shell job control and process
# groups are not reliable without a terminal (dash refuses `set -m`), so on timeout the
# watchdog walks each running job's process tree with ps, sends TERM to every member,
# and after the grace period KILL to every member, children included. The braces keep
# the shell's job notices off the output.
tree() { # tree <pid>: the pid and all its descendants, one per line
  echo "$1"
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" '
    { par[$1] = $2; id[NR] = $1 }
    END { seen[root] = 1; do { ch = 0
            for (i = 1; i <= NR; i++) if (!(id[i] in seen) && (par[id[i]] in seen)) { seen[id[i]] = 1; print id[i]; ch = 1 }
          } while (ch) }'
}
alive() { for q in $1; do kill -0 "$q" 2>/dev/null && return 0; done; return 1; }

# The answer comes from the -o file only: plain exec echoes the whole prompt to stderr.
run_codex() {
  codex exec -s read-only -C "$repo" --color never -o "$work/codex.out" \
    -m "$model" -c "model_reasoning_effort=\"$effort\"" - < "$work/prompt" > /dev/null 2> "$work/codex.err"
  rc=$?
  [ "$rc" -eq 0 ] || { printf 'codex call failed: %s\n' "$(tail -n 3 "$work/codex.err" | tr '\n' ' ' | cut -c1-300)" > "$work/codex.skip"; return; }
  [ -s "$work/codex.out" ] || printf 'codex returned no answer\n' > "$work/codex.skip"
}

# The request body is built and the answer parsed by node or python3, never by hand in sh.
# json_body <prompt file> <model>: the request body on stdout.
json_body() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({model:process.argv[2],messages:[{role:"user",content:fs.readFileSync(process.argv[1],"utf8")}],stream:false}))' "$1" "$2"
  else
    python3 -c 'import sys,json
p=open(sys.argv[1],encoding="utf-8",errors="replace").read()
sys.stdout.write(json.dumps({"model":sys.argv[2],"messages":[{"role":"user","content":p}],"stream":False}))' "$1" "$2"
  fi
}
# json_answer <response file>: choices[0].message.content on stdout; exit 1 if absent.
json_answer() {
  if command -v node >/dev/null 2>&1; then
    node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).choices[0].message.content;if(typeof c!=="string"||!c.trim())process.exit(1);process.stdout.write(c)}catch(e){process.exit(1)}' "$1"
  else
    python3 -c 'import sys,json
try:
    c=json.load(open(sys.argv[1],encoding="utf-8",errors="replace"))["choices"][0]["message"]["content"]
    assert isinstance(c,str) and c.strip()
except Exception:
    sys.exit(1)
sys.stdout.buffer.write(c.encode("utf-8"))' "$1"
  fi
}

run_deepseek() {
  json_body "$work/prompt" "$dsmodel" > "$work/ds.body" 2>/dev/null || { echo "could not build the request" > "$work/deepseek.skip"; return; }
  # The header comes on stdin from the printf builtin: no file, no argv. -q skips any
  # .curlrc, -g stops {a,b} and [1-3] expanding into several requests, and there is no
  # -L, so a redirect is never followed with the key.
  code="$(printf 'Authorization: Bearer %s\n' "$key" | curl -q -sS -g --proto "$dsproto" -o "$work/ds.resp" -w '%{http_code}' \
    --max-time "$tmo" -H @- -H 'Content-Type: application/json' --data-binary "@$work/ds.body" --url "$dsurl" 2>/dev/null)"
  crc=$?
  [ "$crc" -eq 28 ] && { : > "$work/deepseek.timedout"; return; }
  [ "$crc" -eq 0 ] || { echo "deepseek call failed (curl exit $crc)" > "$work/deepseek.skip"; return; }
  case "$code" in 2??) ;; *) echo "deepseek HTTP $code" > "$work/deepseek.skip"; return ;; esac
  json_answer "$work/ds.resp" > "$work/deepseek.out" 2>/dev/null || echo "deepseek returned a malformed response" > "$work/deepseek.skip"
}

pids=""
wd=""
cancel() {
  trap '' INT TERM HUP
  procs=""
  for p in $pids; do eval "r=\${pid_$p:-}"; [ -n "$r" ] && procs="$procs $(tree "$r")"; done
  [ -n "$wd" ] && procs="$procs $(tree "$wd")"
  kill -KILL $procs 2>/dev/null
  rm -rf "$work"
  printf 'cross-check: skipped (cancelled)\n'
  exit 0
}
trap cancel INT TERM HUP
for p in $provs; do
  case "$p" in
    codex)
      command -v codex >/dev/null 2>&1 || { echo "codex is not installed or not on PATH" > "$work/codex.skip"; continue; } ;;
    deepseek)
      [ -n "$key" ] || { echo "DEEPSEEK_API_KEY is not set" > "$work/deepseek.skip"; continue; }
      case "$dsurl" in
        *[[:space:]]*|*"{"*|*"}"*|*"["*|*"]"*|*"@"*|*'\'*) echo "bad deepseek URL" > "$work/deepseek.skip"; continue ;;
        https://*) dsproto="=https" ;;
        http://127.0.0.1|http://127.0.0.1[:/]*|http://localhost|http://localhost[:/]*) dsproto="=http" ;;
        *) echo "bad deepseek URL" > "$work/deepseek.skip"; continue ;;
      esac
      case "$key" in *[![:graph:]]*) echo "DEEPSEEK_API_KEY contains spaces or control characters" > "$work/deepseek.skip"; continue ;; esac
      command -v curl >/dev/null 2>&1 || { echo "curl is not installed" > "$work/deepseek.skip"; continue; }
      command -v node >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || { echo "needs node or python3" > "$work/deepseek.skip"; continue; } ;;
  esac
  pids="$pids $p"
done

{
  for p in $pids; do
    ( "run_$p"; : > "$work/$p.done" ) > /dev/null 2>&1 &
    eval "pid_$p=$!"
  done
  if [ -n "$pids" ]; then
    (
      i=0
      while :; do
        sleep 1; i=$((i + 1))
        if ! kill -0 "$$" 2>/dev/null; then   # the script was killed: take its jobs down, then stop
          procs=""
          for p in $pids; do
            [ -e "$work/$p.done" ] && continue
            eval "r=\$pid_$p"
            procs="$procs $(tree "$r")"
          done
          kill -KILL $procs 2>/dev/null
          rm -rf "$work"
          exit 0
        fi
        live=""
        for p in $pids; do [ -e "$work/$p.done" ] || live="$live $p"; done
        [ -n "$live" ] || break
        if [ "$i" -ge "$tmo" ]; then
          procs=""
          for p in $live; do
            : > "$work/$p.timedout"
            eval "r=\$pid_$p"
            procs="$procs $(tree "$r")"
          done
          kill -TERM $procs 2>/dev/null
          g=0
          while alive "$procs" && [ "$g" -lt "$grace" ]; do sleep 1; g=$((g + 1)); done
          # a process a job spawned meanwhile is still under a live parent: add it
          again=""
          for p in $live; do eval "r=\$pid_$p"; again="$again $(tree "$r")"; done
          kill -KILL $procs $again 2>/dev/null
          break
        fi
      done
    ) > /dev/null 2>&1 &
    wd=$!
  fi
  wait
} 2>/dev/null
# The jobs are over: a late signal must not kill pids that may have been reused, nor
# add a cancel line after the findings. Only the EXIT cleanup is left.
trap 'exit 0' INT TERM HUP

for p in $pids; do
  if [ -e "$work/$p.timedout" ] && [ ! -s "$work/$p.out" ]; then
    echo "$p timed out after ${tmo}s (set CROSSCHECK_TIMEOUT to change)" > "$work/$p.skip"
  elif [ ! -s "$work/$p.out" ] && [ ! -s "$work/$p.skip" ]; then
    echo "$p returned no answer" > "$work/$p.skip"
  fi
done

any=0
for p in $provs; do [ -s "$work/$p.out" ] && [ ! -s "$work/$p.skip" ] && any=1; done

untracked="$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
if [ "$any" -eq 1 ]; then
  printf 'cross-check: findings on %s vs the working tree, uncommitted changes included. Advisory until reproduced; a point both providers name counts once.\n\n' "$base"
else
  printf 'cross-check: skipped (no provider returned findings)\n\n'
fi
if [ -n "$key" ]; then case " $provs " in *" deepseek "*) ;; *) printf 'Note: DEEPSEEK_API_KEY is set but deepseek is not enabled, so nothing was sent to it. To include it: CROSSCHECK_PROVIDERS="codex deepseek".\n\n' ;; esac; fi
[ "${untracked:-0}" -gt 0 ] && printf 'Warning: %s untracked file(s) are not in the diff and were not reviewed. Run `git add -N <file>` to include them.\n\n' "$untracked"
# Model output is data: control bytes (ESC, BEL, CR...) are dropped, newline and tab kept,
# so it cannot drive the terminal (clear screen, OSC 52 clipboard, OSC 8 links).
for p in $provs; do
  case "$p" in
    codex) printf '## codex (%s, effort %s)\n\n' "$model" "$effort" ;;
    deepseek) printf '## deepseek (%s; sees only the diff, changed tests and criteria in the prompt, and cannot read the repo)\n\n' "$dsmodel" ;;
  esac
  if [ -s "$work/$p.skip" ]; then printf 'skipped: %s\n\n' "$(cat "$work/$p.skip")"
  else cat "$work/$p.out"; printf '\n\n'; fi
done | LC_ALL=C tr -d '\000-\010\013-\037\177' |
  LC_ALL=C sed "s/$(printf '\302')[$(printf '\200')-$(printf '\237')]//g"   # UTF-8 C1 controls U+0080-U+009F
exit 0
