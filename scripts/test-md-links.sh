#!/usr/bin/env bash
# Test for scripts/check-md-links.mjs: a fixture repo with one broken link must
# fail the check, and a fixture with only good links must pass it.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAIL=0

mk() { # mk <dir>: a git repo with a tracked docs/b.md
  mkdir -p "$1/docs"
  git -C "$1" init -q
  printf 'target\n' > "$1/docs/b.md"
}

mk "$T/good"
printf '[ok](b.md) [up](../docs/b.md#anchor) [dir](../docs) [web](https://example.com)\n```\n[code](nope.md)\n```\n' > "$T/good/docs/a.md"
git -C "$T/good" add -A
if node "$HERE/check-md-links.mjs" "$T/good" >/dev/null 2>&1; then echo "OK   good links pass"; else echo "FAIL good links rejected"; FAIL=1; fi

mk "$T/bad"
printf '[broken](missing.md)\n' > "$T/bad/docs/a.md"
git -C "$T/bad" add -A
if out="$(node "$HERE/check-md-links.mjs" "$T/bad" 2>&1)"; then echo "FAIL broken link passed"; FAIL=1; else echo "OK   broken link fails"; fi
if printf '%s' "$out" | grep -q 'docs/a.md'; then echo "OK   names the file"; else echo "FAIL output does not name the file"; FAIL=1; fi

mk "$T/untracked"
printf '[x](c.md)\n' > "$T/untracked/docs/a.md"
printf 'x\n' > "$T/untracked/docs/c.md"
git -C "$T/untracked" add docs/a.md docs/b.md
if node "$HERE/check-md-links.mjs" "$T/untracked" >/dev/null 2>&1; then echo "FAIL link to an untracked file passed"; FAIL=1; else echo "OK   untracked target fails"; fi

exit "$FAIL"
