#!/usr/bin/env bash
# Dependency-free checks for the plugin: bash, git, and node built-ins only.
# Run from anywhere: bash plugin/test/run.sh
set -u
P="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
T="$(mktemp -d)"
trap '[ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
# the operator may have these set; the tests must never reach a real provider
unset DEEPSEEK_API_KEY CROSSCHECK_PROVIDERS CROSSCHECK_DEEPSEEK_URL CROSSCHECK_DEEPSEEK_MODEL
export no_proxy=127.0.0.1 NO_PROXY=127.0.0.1

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
check "cross-check doc states code is sent only when invoked" grep -qi "only when" "$P/../docs/cross-check.md"
check "compact doc has CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" grep -q CLAUDE_AUTOCOMPACT_PCT_OVERRIDE "$P/../docs/compact.md"

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
env > "$FAKE_DIR/codexenv"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
[ -n "${FAKE_FAIL:-}" ] && { echo "boom: not logged in" >&2; exit 3; }
case "${FAKE_MODE:-}" in
  ctl) printf 'A\033]52;c;ZXZpbA==\007B\033[2JC\033]8;;http://x\033\\D\ttab\n' > "$out"; exit 0 ;;
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
check "cross-check doc mentions git add -N" grep -q "git add -N" "$P/../docs/cross-check.md"

echo "-- cross-check.sh: deepseek --"
KEY="sk-TESTKEY-9f3a1c77"
export CROSSCHECK_PROVIDERS="codex deepseek"
cat > "$T/server.js" <<'SRVJS'
const http = require("http"), fs = require("fs");
const d = process.env.FAKE_DIR;
const srv = http.createServer((q, s) => {
  const ch = []; q.on("data", c => ch.push(c));
  q.on("end", () => {
    const body = Buffer.concat(ch);
    fs.writeFileSync(d + "/ds.auth", String(q.headers.authorization || ""));
    fs.writeFileSync(d + "/ds.req", body);
    fs.writeFileSync(d + "/ds.url", q.url);
    try { const j = JSON.parse(body); fs.writeFileSync(d + "/ds.prompt", j.messages[0].content); fs.writeFileSync(d + "/ds.model", j.model); } catch (e) {}
    fs.writeFileSync(d + "/ds.hit", "");
    const m = q.url.split("/")[1];
    if (m === "stall") return;
    if (m === "401" || m === "500") { s.statusCode = +m; return s.end("SECRET-BODY-TEXT"); }
    if (m === "malformed") return s.end("{not json SECRET-BODY-TEXT");
    if (m === "ctl") return s.end(JSON.stringify({ choices: [{ message: { content: "A\u001b]52;c;ZXZpbA==\u0007B\u001b[2JC\u001b]8;;http://x\u001b\\D\ttab" } }] }));
    if (m === "empty") return s.end(JSON.stringify({ choices: [] }));
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ choices: [{ message: { content: "DS-FINDING: none é \"q\"" } }] }));
  });
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(d + "/port", String(srv.address().port)));
SRVJS
node "$T/server.js" & SRV=$!
i=0; while [ ! -s "$T/port" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
URL="http://127.0.0.1:$(cat "$T/port")"
dsrun() { # dsrun <path> [env assignments...]: run the script with a key, default providers
  pth="$1"; shift
  rm -f "$T/ds.hit"
  (cd "$R" && env PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/$pth" "$@" sh "$X" main "Must add c" 2>&1)
}
mklinks() { # mklinks <dir>: basic tools only, no codex, node or python3
  mkdir -p "$1"
  for b in git sh cat sed awk grep tr wc head tail mktemp rm mkdir dirname date cut sort ps sleep curl env cmp; do p="$(command -v "$b")"; [ -n "$p" ] && ln -s "$p" "$1/$b" 2>/dev/null; done
  return 0
}
# the hostile prompt: quotes, backslashes, newlines, non-ASCII, a tab, shell syntax
printf 'q"uote \\ back\\slash\\n tab\t $(x) `y` caf\303\251 \342\202\254 \360\237\230\200\n' > "$R/test/hostile.test.js"
git -C "$R" add -N test/hostile.test.js
r="$(dsrun ok)"; rc=$?
[ "$rc" -eq 0 ] && ok "both providers: exits 0" || bad "both providers: exit $rc"
case "$r" in *"## codex"*FAKE-FINDING*"## deepseek"*DS-FINDING*) ok "both groups appear, in order, with findings";; *) bad "both groups: $r";; esac
case "$r" in *"cannot read the repo"*) ok "deepseek group says it sees only the prompt";; *) bad "no only-the-prompt note: $r";; esac
cmp -s "$T/stdin" "$T/ds.prompt" && ok "prompt reaches the server byte for byte (quotes, backslashes, newlines, non-ASCII)" || bad "prompt differs on the server side"
grep -q 'caf.*€' "$T/ds.prompt" && grep -qF 'q"uote \ back' "$T/ds.prompt" && ok "hostile bytes are in what the server received" || bad "hostile bytes missing"
[ "$(cat "$T/ds.url")" = "/ok" ] && [ "$(cat "$T/ds.model")" = "deepseek-v4-pro" ] && ok "default model deepseek-v4-pro" || bad "default model: $(cat "$T/ds.model")"
[ "$(cat "$T/ds.auth")" = "Bearer $KEY" ] && ok "the server got the bearer key" || bad "auth header: $(cat "$T/ds.auth")"
case "$r" in *"$KEY"*) bad "the key is in the output";; *) ok "the key is not in the output";; esac
grep -qF "$KEY" "$T/stdin" "$T/args" "$T/ds.prompt" && bad "the key is in the prompt or codex args" || ok "the key is not in the prompt or codex args"
r="$(dsrun ok CROSSCHECK_DEEPSEEK_MODEL=other-model)"; [ "$(cat "$T/ds.model")" = "other-model" ] && ok "CROSSCHECK_DEEPSEEK_MODEL overrides the model" || bad "model override"
# one provider available
r="$(cd "$R" && PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
case "$r" in *"## codex"*FAKE-FINDING*"## deepseek"*"skipped: "*DEEPSEEK_API_KEY*) ok "no key: deepseek skipped, codex findings kept";; *) bad "no key: $r";; esac
case "$r" in "cross-check: skipped"*) bad "one provider ran but the output says skipped";; *) ok "one provider ran: output is not a skip";; esac
mklinks "$T/nocx"; ln -s "$(command -v node)" "$T/nocx/node"
rm -f "$T/ds.hit"
r="$(cd "$R" && PATH="$T/nocx" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" /bin/sh "$X" main 2>&1)"
case "$r" in *"## codex"*"skipped: "*codex*"## deepseek"*DS-FINDING*) ok "no codex: codex skipped, deepseek findings kept";; *) bad "no codex: $r";; esac
# CROSSCHECK_PROVIDERS
rm -f "$T/args"
r="$(dsrun ok CROSSCHECK_PROVIDERS=deepseek)"
case "$r" in *"## codex"*) bad "providers=deepseek still shows codex";; *"## deepseek"*DS-FINDING*) ok "CROSSCHECK_PROVIDERS=deepseek runs only deepseek";; *) bad "providers=deepseek: $r";; esac
[ ! -e "$T/args" ] && ok "codex not called when not listed" || bad "codex called when not listed"
r="$(dsrun ok CROSSCHECK_PROVIDERS=codex)"; [ ! -e "$T/ds.hit" ] && ok "deepseek not called when not listed" || bad "deepseek called when not listed"
r="$(dsrun ok CROSSCHECK_PROVIDERS=bogus)"; case "$r" in "cross-check: skipped"*bogus*) ok "unknown provider name is skipped with the name";; *) bad "unknown provider: $r";; esac
# HTTP errors and malformed answers: skipped, code only, never the body
for c in 401 500; do
  r="$(dsrun $c CROSSCHECK_PROVIDERS=deepseek)"; rc=$?
  [ "$rc" -eq 0 ] && ok "HTTP $c exits 0" || bad "HTTP $c exit $rc"
  case "$r" in *"skipped: "*"HTTP $c"*) ok "HTTP $c skipped with the code";; *) bad "HTTP $c: $r";; esac
  case "$r" in *SECRET-BODY-TEXT*|*"$KEY"*) bad "HTTP $c echoed the body or key";; *) ok "HTTP $c does not echo the body";; esac
done
for m in malformed empty; do
  r="$(dsrun $m CROSSCHECK_PROVIDERS=deepseek)"; rc=$?
  [ "$rc" -eq 0 ] && case "$r" in *"skipped: "*malformed*) true;; *) false;; esac && ok "$m response skipped as malformed" || bad "$m response: $r"
  case "$r" in *SECRET-BODY-TEXT*) bad "$m response echoed the body";; *) ok "$m response does not echo the body";; esac
done
# the key never appears on a command line while the call is in flight
mkdir -p "$T/tmp3"; rm -f "$T/ds.hit"
(cd "$R" && TMPDIR="$T/tmp3" PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/stall" CROSSCHECK_PROVIDERS=deepseek CROSSCHECK_TIMEOUT=4 CROSSCHECK_GRACE=1 sh "$X" main > "$T/stall.out" 2>&1) &
SP=$!
i=0; while [ ! -e "$T/ds.hit" ] && [ "$i" -lt 60 ]; do sleep 0.1; i=$((i + 1)); done
[ -e "$T/ds.hit" ] && ok "the call is in flight (server stalled)" || bad "the call never reached the server"
if ps -ax -o args= | grep -F -- "$KEY" | grep -qv "grep -F"; then bad "the key is visible in ps"; else ok "the key is not on any command line during the call"; fi
[ -n "$(ls -A "$T"/tmp3/*/ 2>/dev/null)" ] && ok "the run's temp dir exists mid-call" || bad "no temp dir mid-call"
if grep -rlF "$KEY" "$T/tmp3" 2>/dev/null | grep -q .; then bad "the key is on disk mid-call"; else ok "no file holds the key mid-call"; fi
wait "$SP"
case "$(cat "$T/stall.out")" in *"skipped: "*"timed out"*) ok "timeout stops a stalled deepseek call";; *) bad "stall: $(cat "$T/stall.out")";; esac
if ps -ax -o args= | grep -F "$URL/stall" | grep -v grep | grep -q .; then bad "curl survived the timeout"; else ok "no curl left after the timeout"; fi
grep -qF "$KEY" "$T/stall.out" && bad "the key is in the timeout output" || ok "the key is not in the timeout output"
[ -z "$(ls -A "$T/tmp3")" ] && ok "temp dir and header file removed after the run" || bad "temp dir left: $(ls -A "$T/tmp3")"
mkdir -p "$T/tmp4"
(cd "$R" && TMPDIR="$T/tmp4" PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/401" sh "$X" main >/dev/null 2>&1)
[ -z "$(ls -A "$T/tmp4")" ] && ok "header file removed after an HTTP error" || bad "temp dir left after an error"
# both providers timing out are each reported
r="$(dsrun stall FAKE_MODE=child CROSSCHECK_TIMEOUT=2 CROSSCHECK_GRACE=1)"
case "$r" in *"## codex"*"skipped: "*"timed out"*"## deepseek"*"skipped: "*"timed out"*) ok "both providers timing out are each reported";; *) bad "double timeout: $r";; esac
# the cap applies before either call
rm -f "$T/ds.hit" "$T/args"
r="$(dsrun ok CROSSCHECK_MAX_BYTES=10)"
[ ! -e "$T/ds.hit" ] && [ ! -e "$T/args" ] && case "$r" in *skipped*) true;; *) false;; esac && ok "cap applied before any call" || bad "a provider was called over the cap"
# no JSON tool: skipped with the reason, no hand-built JSON
mklinks "$T/nojson"
rm -f "$T/ds.hit"
r="$(cd "$R" && PATH="$T/nojson" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" CROSSCHECK_PROVIDERS=deepseek /bin/sh "$X" main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && case "$r" in *"skipped: needs node or python3"*) true;; *) false;; esac && [ ! -e "$T/ds.hit" ] && ok "no node and no python3: skipped, no call" || bad "no json tool: $r"
# python3 alone is enough
if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then
  mklinks "$T/pyonly"; ln -s "$(command -v python3)" "$T/pyonly/python3"
  rm -f "$T/ds.hit" "$T/ds.prompt"
  r="$(cd "$R" && PATH="$T/pyonly" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" CROSSCHECK_PROVIDERS=deepseek /bin/sh "$X" main 2>&1)"
  case "$r" in *DS-FINDING*) ok "python3 alone: deepseek findings returned";; *) bad "python3 only: $r";; esac
  grep -qF 'q"uote \ back' "$T/ds.prompt" && grep -q '€' "$T/ds.prompt" && ok "python3 path keeps hostile bytes intact" || bad "python3 path mangled the prompt"
else
  echo "SKIP python3 path (python3 not usable here)"
fi
# a key with a control character is refused, not sent
r="$(dsrun ok DEEPSEEK_API_KEY="$(printf 'bad\nX-Evil: 1')" CROSSCHECK_PROVIDERS=deepseek)"
[ ! -e "$T/ds.hit" ] && ok "a key with a newline is not sent" || bad "a key with a newline was sent"
# the same dual-provider run under dash
if command -v dash >/dev/null 2>&1; then
  r="$(cd "$R" && PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" dash "$X" main 2>&1)"
  case "$r" in *"## codex"*FAKE-FINDING*"## deepseek"*DS-FINDING*) ok "dash: both groups appear";; *) bad "dash: $r";; esac
  cmp -s "$T/stdin" "$T/ds.prompt" && ok "dash: prompt intact on the server" || bad "dash: prompt differs"
fi
echo "-- cross-check.sh: review fixes --"
# opt-in: deepseek does not run unless named, whatever the environment holds
rm -f "$T/ds.hit"
r="$(cd "$R" && env -u CROSSCHECK_PROVIDERS PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" sh "$X" main 2>&1)"
[ ! -e "$T/ds.hit" ] && ok "default providers: deepseek is not called" || bad "deepseek ran without being listed"
case "$r" in *"## deepseek"*) bad "default output has a deepseek group";; *) ok "default output has no deepseek group";; esac
case "$r" in *"## codex"*FAKE-FINDING*) ok "default still runs codex";; *) bad "default codex: $r";; esac
case "$r" in *"DEEPSEEK_API_KEY is set"*CROSSCHECK_PROVIDERS*) ok "hint says how to enable deepseek";; *) bad "no hint: $r";; esac
r="$(cd "$R" && env -u CROSSCHECK_PROVIDERS -u DEEPSEEK_API_KEY PATH="$T/bin:$PATH" sh "$X" main 2>&1)"
case "$r" in *"DEEPSEEK_API_KEY is set"*) bad "hint shown with no key";; *) ok "no hint when no key is set";; esac
r="$(dsrun ok CROSSCHECK_PROVIDERS=codex)"
case "$r" in *"DEEPSEEK_API_KEY is set"*) ok "hint also when only codex is listed";; *) bad "no hint for codex-only: $r";; esac
# codex never sees the key
dsrun ok >/dev/null
grep -qF "$KEY" "$T/codexenv" && bad "codex's environment holds the key" || ok "codex's environment does not hold the key"
grep -q '^DEEPSEEK_API_KEY=' "$T/codexenv" && bad "codex inherits DEEPSEEK_API_KEY" || ok "codex does not inherit DEEPSEEK_API_KEY"
# control bytes in model output are stripped, newline and tab kept
r="$(dsrun ok FAKE_MODE=ctl)"
if printf '%s' "$r" | LC_ALL=C grep -q "$(printf '\033\|\007')"; then bad "ESC or BEL reached the output"; else ok "ESC and BEL are stripped from both providers' output"; fi
r="$(dsrun ctl FAKE_MODE=ctl)"
if printf '%s' "$r" | LC_ALL=C grep -q "$(printf '\033\|\007')"; then bad "ESC or BEL reached the output (deepseek ctl)"; else ok "control bytes stripped (deepseek ctl payload)"; fi
case "$r" in *"A]52"*"tab"*) ok "the text around the control bytes is kept";; *) bad "stripping removed text: $r";; esac
printf '%s' "$r" | LC_ALL=C grep -q "$(printf 'D\ttab')" && ok "tab survives" || bad "tab lost"
# the curl command line: -q first, -g, https-only proto, no -L, no key
mkdir -p "$T/fakecurl"; REALCURL="$(command -v curl)"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "$FAKE_DIR/curlargs"\nexec "%s" "$@"\n' "$REALCURL" > "$T/fakecurl/curl"; chmod +x "$T/fakecurl/curl"
rm -f "$T/curlargs"
(cd "$R" && env PATH="$T/fakecurl:$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/ok" CROSSCHECK_PROVIDERS=deepseek sh "$X" main >/dev/null 2>&1)
[ "$(head -1 "$T/curlargs")" = "-q" ] && ok "curl gets -q first" || bad "curl does not start with -q"
grep -qxF -- '-g' "$T/curlargs" && ok "curl gets -g" || bad "curl lacks -g"
grep -qxF -- '--proto' "$T/curlargs" && grep -qxF -- '=http' "$T/curlargs" && ok "curl gets --proto (=http for localhost)" || bad "curl lacks --proto"
grep -qxF -- '--url' "$T/curlargs" && ok "curl gets the URL through --url" || bad "curl lacks --url"
if grep -Eqx -- '-L|--location|--location-trusted|-[a-zA-Z]*L[a-zA-Z]*' "$T/curlargs"; then bad "curl follows redirects"; else ok "curl never follows redirects"; fi
grep -qF "$KEY" "$T/curlargs" && bad "the key is on curl's command line" || ok "the key is not on curl's command line"
grep -qxF -- '@-' "$T/curlargs" && ok "the header is read from stdin (-H @-)" || bad "header not from stdin"
# URL validation
for u in 'https://a.example/{x,y}/chat' 'https://a.example/[1-3]/chat' '-o/tmp/pwn' '--url=https://evil.example' 'http://example.com/chat' 'ftp://a.example/x' 'http://127.0.0.1@evil.example/x' 'http://127.0.0.1:80@evil.example/x' 'https://a.example/a b'; do
  rm -f "$T/ds.hit"
  r="$(cd "$R" && env PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$u" CROSSCHECK_PROVIDERS=deepseek sh "$X" main 2>&1)"
  case "$r" in *"skipped: bad deepseek URL"*) ok "refused URL: $u";; *) bad "accepted URL: $u -> $r";; esac
done
case "$(cd "$R" && env PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="http://localhost:1/x" CROSSCHECK_PROVIDERS=deepseek CROSSCHECK_TIMEOUT=5 sh "$X" main 2>&1)" in *"bad deepseek URL"*) bad "localhost URL refused";; *) ok "http://localhost is allowed";; esac
# a TERM mid-call: no temp files, no live children, no watchdog, under sh and dash
for sh_ in sh dash; do
  command -v "$sh_" >/dev/null 2>&1 || continue
  mkdir -p "$T/tmp5"; rm -f "$T/ds.hit" "$T/child" "$T/parent" "$T/term.out"
  (cd "$R" && exec env TMPDIR="$T/tmp5" PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/stall" FAKE_MODE=child CROSSCHECK_GRACE=1 "$sh_" "$X" main > "$T/term.out" 2>&1) &
  TP=$!
  i=0; while { [ ! -e "$T/ds.hit" ] || [ ! -s "$T/child" ]; } && [ "$i" -lt 80 ]; do sleep 0.1; i=$((i + 1)); done
  kill -TERM "$TP" 2>/dev/null; wait "$TP" 2>/dev/null; rc=$?
  [ "$rc" -eq 0 ] && ok "TERM ($sh_) exits 0" || bad "TERM ($sh_) exit $rc"
  case "$(cat "$T/term.out")" in *"skipped (cancelled)"*) ok "TERM ($sh_) says cancelled";; *) bad "TERM ($sh_): $(cat "$T/term.out")";; esac
  [ -z "$(ls -A "$T/tmp5")" ] && ok "TERM ($sh_) leaves no temp file" || bad "TERM ($sh_) left $(ls -A "$T/tmp5")"
  c="$(cat "$T/child" 2>/dev/null)"
  if [ -n "$c" ] && kill -0 "$c" 2>/dev/null; then bad "TERM ($sh_) left codex's child running"; else ok "TERM ($sh_) stops codex's child"; fi
  if ps -ax -o args= | grep -F "$URL/stall" | grep -v grep | grep -q .; then bad "TERM ($sh_) left curl running"; else ok "TERM ($sh_) stops curl"; fi
  i=0; while ps -ax -o args= | grep -F "$X" | grep -v grep | grep -q . && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
  ps -ax -o args= | grep -F "$X" | grep -v grep | grep -q . && bad "TERM ($sh_) left the watchdog running" || ok "TERM ($sh_) stops the watchdog"
done
# KILL cannot be trapped: the watchdog still ends with its parent
mkdir -p "$T/tmp6"; rm -f "$T/ds.hit"
(cd "$R" && exec env TMPDIR="$T/tmp6" PATH="$T/bin:$PATH" DEEPSEEK_API_KEY="$KEY" CROSSCHECK_DEEPSEEK_URL="$URL/stall" CROSSCHECK_PROVIDERS=deepseek CROSSCHECK_TIMEOUT=300 sh "$X" main >/dev/null 2>&1) &
KP=$!
i=0; while [ ! -e "$T/ds.hit" ] && [ "$i" -lt 60 ]; do sleep 0.1; i=$((i + 1)); done
kill -KILL "$KP" 2>/dev/null; wait "$KP" 2>/dev/null
i=0; while ps -ax -o args= | grep -F "$X" | grep -v grep | grep -q . && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i + 1)); done
ps -ax -o args= | grep -F "$X" | grep -v grep | grep -q . && bad "the watchdog or a job outlived a killed script" || ok "the watchdog and the jobs end when the script is killed"
if ps -ax -o args= | grep -F "$URL/stall" | grep -v grep | grep -q .; then bad "curl outlived a killed script"; else ok "curl ends when the script is killed"; fi
[ -z "$(ls -A "$T/tmp6")" ] && ok "temp dir removed after a KILL" || bad "temp dir left after a KILL"
pkill -f "$URL/stall" 2>/dev/null
rm -rf "$T/tmp6"
check "cross-check doc names DEEPSEEK_API_KEY and CROSSCHECK_PROVIDERS" sh -c "grep -q DEEPSEEK_API_KEY '$P/../docs/cross-check.md' && grep -q CROSSCHECK_PROVIDERS '$P/../docs/cross-check.md'"

echo
if [ "$FAIL" -eq 0 ]; then echo "== PASS =="; exit 0; else echo "== FAIL =="; exit 1; fi
