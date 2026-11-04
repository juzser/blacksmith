#!/usr/bin/env bash
# Blacksmith gate: plugin tests, JSON, marketplace paths, shell syntax, markdown
# links, and (when `claude` is on PATH) the plugin validators. CI runs this file.
# A step that cannot run prints SKIP, not OK: read the tail, not the exit code.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
ok()   { echo "OK   $1"; }
bad()  { echo "FAIL $1"; FAIL=1; }
skip() { echo "SKIP $1"; }

echo "== Blacksmith check =="

echo
echo "-- plugin tests --"
bash plugin/test/run.sh || FAIL=1

echo
echo "-- JSON parses --"
while IFS= read -r f; do
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null; then ok "$f"; else bad "$f"; fi
done < <(git ls-files '.claude-plugin/*.json' 'plugin/*.json' 'mods/pr-mod/*.json' '.claude/*.json')

echo
echo "-- marketplace sources --"
node - <<'JS' || FAIL=1
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'));
let bad = false;
for (const p of m.plugins) {
  const ok = fs.existsSync(p.source);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${p.name} -> ${p.source}`);
  if (!ok) bad = true;
}
const main = m.plugins.find((p) => p.name === 'blacksmith');
if (!main || main.source !== './plugin') { console.log('FAIL blacksmith entry must have source ./plugin'); bad = true; }
process.exit(bad ? 1 : 0);
JS

echo
echo "-- sh -n on plugin scripts --"
while IFS= read -r f; do
  if sh -n "$f" 2>/dev/null; then ok "$f"; else bad "$f"; fi
done < <(git ls-files 'plugin/*.sh')

echo
echo "-- markdown links --"
bash scripts/test-md-links.sh || FAIL=1
node scripts/check-md-links.mjs . || FAIL=1

echo
echo "-- claude plugin validate / test --"
if command -v claude >/dev/null 2>&1; then
  claude plugin validate plugin >/dev/null 2>&1 && ok "validate plugin" || bad "validate plugin"
  claude plugin validate mods/pr-mod >/dev/null 2>&1 && ok "validate mods/pr-mod" || bad "validate mods/pr-mod"
  claude plugin test mods/pr-mod >/dev/null 2>&1 && ok "test mods/pr-mod" || bad "test mods/pr-mod"
else
  skip "claude not on PATH: plugin validate and pr-mod tests did not run"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "== PASS =="
  exit 0
else
  echo "== FAIL =="
  exit 1
fi
