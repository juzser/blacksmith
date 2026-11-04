#!/usr/bin/env bash
# Dependency-free checks for the plugin: bash, git, and node built-ins only.
# Run from anywhere: bash plugin/test/run.sh
set -u
P="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

ok()  { echo "OK   $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
check() { # check <name> <command...>
  n="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi
}
jsonok() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1"; }

echo "-- JSON files parse --"
for f in .claude-plugin/plugin.json hooks/hooks.json; do check "$f parses" jsonok "$P/$f"; done
check "plugin.json names blacksmith" node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));if(j.name!=="blacksmith"||!j.version||!j.description)process.exit(1)' "$P/.claude-plugin/plugin.json"
check "hooks.json registers SessionStart for startup|resume|clear|compact" node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1]));
const s=j.hooks.SessionStart; const m=s.map(e=>e.matcher||"").join("|");
for (const w of ["startup","resume","clear","compact"]) if(!m.includes(w)) process.exit(1);
if(!JSON.stringify(s).includes("session-rules.sh")) process.exit(1)' "$P/hooks/hooks.json"

echo "-- rules.md and README --"
n=$(wc -l < "$P/rules.md" | tr -d ' ')
[ "$n" -le 80 ] && ok "rules.md is $n lines (<= 80)" || bad "rules.md is $n lines (> 80)"
for h in "Talking to a person" "Confidence" "Model and effort" "Cross-check" "Compact"; do
  grep -qi "^#.*$h" "$P/rules.md" && ok "rules.md has heading: $h" || bad "rules.md lacks heading: $h"
done
check "README <= 60 lines" test "$(wc -l < "$P/README.md" | tr -d ' ')" -le 60
check "README states diff is sent only when invoked" grep -qi "only when" "$P/README.md"
check "README has CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" grep -q CLAUDE_AUTOCOMPACT_PCT_OVERRIDE "$P/README.md"

echo "-- agent frontmatter --"
for a in planner coder reviewer researcher scout; do
  f="$P/agents/$a.md"
  fm="$(awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1{print}' "$f" 2>/dev/null)"
  get() { printf '%s\n' "$fm" | sed -n "s/^$1:[[:space:]]*//p" | head -1; }
  [ "$(get name)" = "$a" ] && ok "$a name" || bad "$a name"
  [ -n "$(get description)" ] && ok "$a description" || bad "$a description"
  case "$(get model)" in sonnet|opus|haiku|fable|inherit) ok "$a model $(get model)";; *) bad "$a model";; esac
  case "$(get effort)" in low|medium|high|xhigh|max) ok "$a effort $(get effort)";; *) bad "$a effort";; esac
  l=$(wc -l < "$f" | tr -d ' ')
  [ "$l" -le 40 ] && ok "$a is $l lines" || bad "$a is $l lines"
done
for a in reviewer scout; do
  t="$(sed -n 's/^tools:[[:space:]]*//p' "$P/agents/$a.md" | head -1)"
  case "$t" in *Write*|*Edit*|"") bad "$a is read-only via tools ($t)";; *) ok "$a is read-only via tools";; esac
done
t="$(sed -n 's/^tools:[[:space:]]*//p' "$P/agents/planner.md" | head -1)"
case "$t" in *Write*) case "$t" in *Edit*) bad "planner tools ($t)";; *) ok "planner can write its plan, not edit";; esac;; *) bad "planner tools ($t)";; esac

echo "-- session-rules.sh (plain stdout) --"
CLAUDE_PLUGIN_ROOT="$P" sh "$P/hooks/session-rules.sh" > "$T/hook.out"; rc=$?
[ "$rc" -eq 0 ] && ok "exits 0" || bad "exit code $rc"
cmp -s "$T/hook.out" "$P/rules.md" && ok "stdout equals rules.md byte for byte" || bad "stdout differs from rules.md"
# Hostile bytes pass through unchanged: quotes, backslashes, tab, CR, a control byte, UTF-8.
mkdir -p "$T/fake/hooks"; cp "$P/hooks/session-rules.sh" "$T/fake/hooks/"
printf 'say "hi" \\ back\\slash\\n\ttab\r\nline2 \001 end \303\251 \342\202\254 $(x) `y`\n' > "$T/fake/rules.md"
for loc in C en_US.UTF-8; do
  LC_ALL=$loc CLAUDE_PLUGIN_ROOT="$T/fake" sh "$T/fake/hooks/session-rules.sh" > "$T/esc.out"; rc=$?
  [ "$rc" -eq 0 ] && cmp -s "$T/esc.out" "$T/fake/rules.md" && ok "hostile bytes unchanged under $loc" || bad "hostile bytes under $loc (rc $rc)"
done
rm "$T/fake/rules.md"
CLAUDE_PLUGIN_ROOT="$T/fake" sh "$T/fake/hooks/session-rules.sh" >/dev/null 2>&1; [ $? -eq 0 ] && ok "exits 0 when rules.md is missing" || bad "missing rules.md exit"

echo "-- rules.md routing table matches the agents --"
for a in planner coder reviewer researcher scout; do
  row="$(grep -F "\`$a\`" "$P/rules.md" | grep '^|' | head -1)"
  rm_="$(printf '%s' "$row" | awk -F'|' '{gsub(/ /,"",$4); print $4}')"
  re_="$(printf '%s' "$row" | awk -F'|' '{gsub(/ /,"",$5); print $5}')"
  am="$(sed -n 's/^model:[[:space:]]*//p' "$P/agents/$a.md" | head -1)"
  ae="$(sed -n 's/^effort:[[:space:]]*//p' "$P/agents/$a.md" | head -1)"
  [ -n "$am" ] && [ "$rm_" = "$am" ] && [ "$re_" = "$ae" ] && ok "$a row matches ($am, $ae)" || bad "$a row ($rm_,$re_) vs frontmatter ($am,$ae)"
done
check "rules.md rule 4: the person runs /cross-check" grep -qi "the person runs it" "$P/rules.md"
check "SKILL.md disables model invocation" grep -q '^disable-model-invocation: true' "$P/skills/cross-check/SKILL.md"
check "SKILL.md shows a quoted heredoc for criteria" grep -q "<<'CROSSCHECK_CRITERIA_END'" "$P/skills/cross-check/SKILL.md"
check "SKILL.md asks for a 600000 Bash timeout" grep -q 600000 "$P/skills/cross-check/SKILL.md"
for a in reviewer scout; do check "$a says read-only by instruction" grep -qi "by instruction" "$P/agents/$a.md"; done

echo "-- cross-check.sh --"
X="$P/skills/cross-check/cross-check.sh"
check "cross-check SKILL.md has name and description" sh -c "grep -q '^name: cross-check' '$P/skills/cross-check/SKILL.md' && grep -q '^description:' '$P/skills/cross-check/SKILL.md'"
# scratch repo with a 2-line change on a branch
R="$T/repo"; mkdir -p "$R/test"; git -C "$R" init -q -b main
git -C "$R" config user.email t@t; git -C "$R" config user.name t
printf 'a\n' > "$R/f.txt"; printf 't\n' > "$R/test/f.test.js"; git -C "$R" add .; git -C "$R" commit -qm base
git -C "$R" checkout -qb work
printf 'a\nb\nc\n' > "$R/f.txt"; printf 't\nt2\n' > "$R/test/f.test.js"; git -C "$R" commit -qam change
# fake codex: records argv and stdin, writes the answer only to the -o file, echoes the prompt to stderr like the real one
mkdir -p "$T/bin"
cat > "$T/bin/codex" <<'FAKE'
#!/bin/sh
printf '%s\n' "$@" > "$FAKE_DIR/args"
cat > "$FAKE_DIR/stdin"
cat "$FAKE_DIR/stdin" >&2
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
[ -n "${FAKE_FAIL:-}" ] && { echo "boom: not logged in" >&2; exit 3; }
case "${FAKE_MODE:-}" in
  child) sleep 31 & echo $! > "$FAKE_DIR/child"; echo $$ > "$FAKE_DIR/parent"; wait ;;
  stubborn) trap '' TERM; sleep 32 & echo $! > "$FAKE_DIR/child"; echo $$ > "$FAKE_DIR/parent"; while :; do sleep 1; done ;;
esac
printf 'FAKE-FINDING: none\n' > "$out"
echo 'STDOUT-NOISE []'
FAKE
chmod +x "$T/bin/codex"
export FAKE_DIR="$T"
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main "Must add c" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "exits 0 on success" || bad "exit $rc on success"
case "$r" in *FAKE-FINDING*) ok "returns the -o file content";; *) bad "no -o content: $r";; esac
case "$r" in *STDOUT-NOISE*) bad "leaked stdout noise";; *) ok "ignores stdout and stderr noise";; esac
a="$(cat "$T/args")"
for w in exec -s read-only -C --color never -o -m gpt-6-sol 'model_reasoning_effort="medium"'; do
  printf '%s\n' "$a" | grep -qxF -- "$w" && ok "codex arg $w" || bad "codex arg $w missing"
done
tail -1 "$T/args" | grep -qx -- '-' && ok "prompt read from stdin (-)" || bad "last arg is not -"
for w in "+c" "Must add c" "t2" "real defects" "no test would catch"; do
  grep -qF -- "$w" "$T/stdin" && ok "prompt has: $w" || bad "prompt lacks: $w"
done
if grep -Eqi '(unit|e2e|lint|typecheck|pre-merge|gate) *\(|check label' "$T/stdin"; then bad "prompt carries a check label"; else ok "prompt carries no check labels"; fi
# env overrides
(cd "$R" && PATH="$T/bin:$PATH" CROSSCHECK_MODEL=other-m CROSSCHECK_EFFORT=high sh "$X" main >/dev/null 2>&1)
grep -qxF other-m "$T/args" && grep -qxF 'model_reasoning_effort="high"' "$T/args" && ok "env overrides model and effort" || bad "env overrides"
# default base = merge-base with the default branch
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" 2>&1)"; case "$r" in *FAKE-FINDING*) ok "default base works";; *) bad "default base: $r";; esac
# oversize
r="$(cd "$R" && PATH="$T/bin:$PATH" CROSSCHECK_MAX_BYTES=10 sh "$X" main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "oversize exits 0" || bad "oversize exit $rc"
case "$r" in *skipped*) ok "oversize diff skipped";; *) bad "oversize: $r";; esac
# the call fails
r="$(cd "$R" && PATH="$T/bin:$PATH" FAKE_FAIL=1 sh "$X" main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "failed call exits 0" || bad "failed call exit $rc"
case "$r" in *skipped*"not logged in"*) ok "failed call skipped with reason";; *) bad "failed call: $r";; esac
# codex missing: a PATH of symlinks to the basic tools, no codex
mkdir -p "$T/nocodex"
for b in git sh cat sed awk grep tr wc head tail mktemp rm mkdir dirname date cut sort; do p="$(command -v "$b")"; [ -n "$p" ] && ln -sf "$p" "$T/nocodex/$b"; done
r="$(cd "$R" && PATH="$T/nocodex" /bin/sh "$X" main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "missing codex exits 0" || bad "missing codex exit $rc"
case "$r" in *skipped*codex*) ok "missing codex skipped with reason";; *) bad "missing codex: $r";; esac
# not a git repo
r="$(cd "$T" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "non-repo exits 0" || bad "non-repo exit $rc"
case "$r" in *skipped*) ok "non-repo skipped";; *) bad "non-repo: $r";; esac

echo "-- cross-check.sh: hardening --"
# no bypass or widened sandbox flags next to -s read-only
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
a="$(cat "$T/args")"
if printf '%s\n' "$a" | grep -Eq 'bypass|full-auto|yolo|danger|workspace-write|--add-dir|-s=|--sandbox'; then bad "codex got a bypass or sandbox flag"; else ok "no bypass or extra sandbox flags"; fi
[ "$(printf '%s\n' "$a" | grep -cx -- '-s')" -eq 1 ] && ok "exactly one -s" || bad "-s count"
# symlinked test file, non-ASCII and quoted names, uncommitted change
printf 'SECRET-OUTSIDE-REPO\n' > "$T/outside.txt"
ln -s "$T/outside.txt" "$R/test/link.test.js"
printf 'NAIVE-MARKER\n' > "$R/test/naïve.test.js"
printf 'QUOTE-MARKER\n' > "$R/test/q\"x.test.js"
git -C "$R" add .; git -C "$R" commit -qm more
printf 'a\nb\nc\nUNCOMMITTED-LINE\n' > "$R/f.txt"
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
grep -q SECRET-OUTSIDE-REPO "$T/stdin" && bad "symlinked test file leaked" || ok "symlinked test file skipped"
grep -qxF "### test/naïve.test.js" "$T/stdin" && ok "non-ASCII test file name included" || bad "non-ASCII name dropped"
grep -qxF "### test/q\"x.test.js" "$T/stdin" && ok "quoted test file name included" || bad "quoted name dropped"
grep -q UNCOMMITTED-LINE "$T/stdin" && ok "uncommitted change included" || bad "uncommitted change missing"
case "$r" in *"working tree"*) ok "output says it used the working tree";; *) bad "output does not say which diff";; esac
# criteria from stdin, shell-unsafe text is not executed
(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main - <<'EOF' >/dev/null 2>&1
must $(touch "$FAKE_DIR/pwned") `touch "$FAKE_DIR/pwned2"` "quoted"
EOF
)
grep -qF 'must $(touch' "$T/stdin" && [ ! -e "$T/pwned" ] && [ ! -e "$T/pwned2" ] && ok "criteria on stdin kept verbatim" || bad "criteria on stdin"
# size cap applies before codex is called
rm -f "$T/args"
(cd "$R" && PATH="$T/bin:$PATH" CROSSCHECK_MAX_BYTES=10 sh "$X" main >/dev/null 2>&1)
[ ! -e "$T/args" ] && ok "cap applied before the codex call" || bad "codex was called over the cap"
# temp dir cleaned up (also after a failure)
mkdir -p "$T/tmp"
(cd "$R" && TMPDIR="$T/tmp" PATH="$T/bin:$PATH" sh "$X" main >/dev/null 2>&1)
(cd "$R" && TMPDIR="$T/tmp" PATH="$T/bin:$PATH" FAKE_FAIL=1 sh "$X" main >/dev/null 2>&1)
[ -z "$(ls -A "$T/tmp")" ] && ok "temp dir removed" || bad "temp dir left behind"
# timeout: the whole process group must die, also when codex ignores TERM
for mode in child stubborn; do
  rm -f "$T/child" "$T/parent"; mkdir -p "$T/tmp2"
  r="$(cd "$R" && TMPDIR="$T/tmp2" PATH="$T/bin:$PATH" FAKE_MODE=$mode CROSSCHECK_TIMEOUT=2 CROSSCHECK_GRACE=1 sh "$X" main 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] && ok "timeout ($mode) exits 0" || bad "timeout ($mode) exit $rc"
  case "$r" in skipped*|"cross-check: skipped"*"timed out"*) ok "timeout ($mode) output starts with skipped and a reason";; *) bad "timeout ($mode): $r";; esac
  case "$r" in *Terminated*|*Killed*) bad "timeout ($mode) leaked a shell job notice: $r";; *) ok "timeout ($mode) no job notice";; esac
  alive=0
  for f in child parent; do [ -s "$T/$f" ] && kill -0 "$(cat "$T/$f")" 2>/dev/null && alive=1; done
  [ -s "$T/child" ] && [ "$alive" -eq 0 ] && ok "timeout ($mode) leaves no surviving processes" || bad "timeout ($mode) survivors (alive=$alive)"
  [ -z "$(ls -A "$T/tmp2")" ] && ok "timeout ($mode) temp dir removed" || bad "timeout ($mode) temp dir left"
done
# untracked files are not in the diff: warn, with the hint
printf 'x\n' > "$R/new-untracked.txt"
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
case "$r" in *"1 untracked"*"git add -N"*) ok "untracked files warned about with the hint";; *) bad "no untracked warning: $r";; esac
rm -f "$R/new-untracked.txt"
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
case "$r" in *untracked*) bad "untracked warning with no untracked files";; *) ok "no warning when nothing is untracked";; esac
check "SKILL.md uses a rare heredoc delimiter" grep -q "<<'CROSSCHECK_CRITERIA_END'" "$P/skills/cross-check/SKILL.md"
check "SKILL.md mentions git add -N" grep -q "git add -N" "$P/skills/cross-check/SKILL.md"
check "README mentions git add -N" grep -q "git add -N" "$P/README.md"

echo
if [ "$FAIL" -eq 0 ]; then echo "== PASS =="; exit 0; else echo "== FAIL =="; exit 1; fi
