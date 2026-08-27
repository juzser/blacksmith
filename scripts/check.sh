#!/usr/bin/env bash
# Blacksmith — Phase-2 sanity gate.
# Validates: every policy YAML parses; every schema JSON parses and its
# x-taxonomy annotations reference real taxonomy.yml dimensions; every
# agent template has valid frontmatter; every hook passes `bash -n`.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

echo "== Blacksmith Phase-2 check =="

# Three of the checks below are python + PyYAML. Without it they each die on
# the same ModuleNotFoundError traceback and the run ends in a FAIL whose
# cause is four sections further up — a policy/schema/template regression and
# a missing dependency look identical from the summary. Name it once, up
# front, with the fix. ci.yml pins the same version.
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  echo "FAIL PyYAML not importable by $(command -v python3 || echo python3) — the policy,"
  echo "     x-taxonomy and agent-template checks below cannot run. Install it with"
  echo "     'pip3 install --user pyyaml==6.0.2' (add --break-system-packages on a"
  echo "     Homebrew/PEP-668 python), matching .github/workflows/ci.yml."
  FAIL=1
fi

echo
echo "-- YAML: factory/policies/*.yml --"
python3 - "$REPO_ROOT" <<'PY'
import sys, glob, os
import yaml

root = sys.argv[1]
fail = False
files = sorted(glob.glob(os.path.join(root, "factory", "policies", "*.yml")))
if not files:
    print("FAIL: no YAML files found under factory/policies/")
    sys.exit(1)
for f in files:
    try:
        with open(f) as fh:
            yaml.safe_load(fh)
        print(f"OK   {os.path.relpath(f, root)}")
    except Exception as e:
        print(f"FAIL {os.path.relpath(f, root)}: {e}")
        fail = True
sys.exit(1 if fail else 0)
PY
[ $? -eq 0 ] || FAIL=1

echo
echo "-- JSON Schema: factory/specs/schema/*.json --"
python3 - "$REPO_ROOT" <<'PY'
import sys, glob, os, json

root = sys.argv[1]
fail = False
files = sorted(glob.glob(os.path.join(root, "factory", "specs", "schema", "*.json")))
if not files:
    print("FAIL: no JSON schema files found under factory/specs/schema/")
    sys.exit(1)
for f in files:
    try:
        with open(f) as fh:
            json.load(fh)
        print(f"OK   {os.path.relpath(f, root)}")
    except Exception as e:
        print(f"FAIL {os.path.relpath(f, root)}: {e}")
        fail = True
sys.exit(1 if fail else 0)
PY
[ $? -eq 0 ] || FAIL=1

echo
echo "-- x-taxonomy dimensions referenced in schemas exist in taxonomy.yml --"
python3 - "$REPO_ROOT" <<'PY'
import sys, glob, os, json
import yaml

root = sys.argv[1]
fail = False

taxonomy_path = os.path.join(root, "factory", "policies", "taxonomy.yml")
with open(taxonomy_path) as fh:
    taxonomy = yaml.safe_load(fh)

dimensions = {k for k in taxonomy.keys() if k not in ("version", "rules")}

def walk(node, found):
    if isinstance(node, dict):
        if "x-taxonomy" in node:
            found.add(node["x-taxonomy"])
        for v in node.values():
            walk(v, found)
    elif isinstance(node, list):
        for v in node:
            walk(v, found)

schema_files = sorted(glob.glob(os.path.join(root, "factory", "specs", "schema", "*.json")))
for f in schema_files:
    with open(f) as fh:
        schema = json.load(fh)
    found = set()
    walk(schema, found)
    unknown = found - dimensions
    if unknown:
        print(f"FAIL {os.path.relpath(f, root)}: unknown taxonomy dimension(s) {sorted(unknown)}")
        fail = True
    else:
        print(f"OK   {os.path.relpath(f, root)}: {sorted(found) if found else '(no x-taxonomy fields)'}")

sys.exit(1 if fail else 0)
PY
[ $? -eq 0 ] || FAIL=1

echo
echo "-- Agent templates: frontmatter --"
python3 - "$REPO_ROOT" <<'PY'
import sys, glob, os
import yaml

root = sys.argv[1]
fail = False
required = ["name", "description", "model", "tools"]

files = sorted(glob.glob(os.path.join(root, ".claude", "agents", "*.md")))
with open(os.path.join(root, "factory", "policies", "taxonomy.yml")) as fh:
    tax_agents = set(yaml.safe_load(fh)["agent"])
template_names = {os.path.splitext(os.path.basename(f))[0] for f in files}
if template_names != tax_agents:
    missing = tax_agents - template_names
    extra = template_names - tax_agents
    print(f"FAIL: templates != taxonomy agent dimension"
          f"{' — missing template for: ' + ', '.join(sorted(missing)) if missing else ''}"
          f"{' — template without taxonomy value: ' + ', '.join(sorted(extra)) if extra else ''}")
    fail = True

for f in files:
    rel = os.path.relpath(f, root)
    with open(f) as fh:
        text = fh.read()
    if not text.startswith("---"):
        print(f"FAIL {rel}: missing frontmatter delimiter")
        fail = True
        continue
    parts = text.split("---", 2)
    if len(parts) < 3:
        print(f"FAIL {rel}: malformed frontmatter block")
        fail = True
        continue
    try:
        fm = yaml.safe_load(parts[1])
    except Exception as e:
        print(f"FAIL {rel}: frontmatter is not valid YAML: {e}")
        fail = True
        continue
    if not isinstance(fm, dict):
        print(f"FAIL {rel}: frontmatter did not parse to a mapping")
        fail = True
        continue
    missing = [k for k in required if not fm.get(k)]
    if missing:
        print(f"FAIL {rel}: missing frontmatter field(s) {missing}")
        fail = True
    else:
        print(f"OK   {rel}: name={fm['name']} model={fm['model']}")

sys.exit(1 if fail else 0)
PY
[ $? -eq 0 ] || FAIL=1

echo
echo "-- bash -n on hooks --"
shopt -s nullglob
hook_files=(.claude/hooks/*.sh)
if [ "${#hook_files[@]}" -eq 0 ]; then
  echo "FAIL: no hook scripts found under .claude/hooks/"
  FAIL=1
else
  for h in "${hook_files[@]}"; do
    if bash -n "$h"; then
      echo "OK   $h"
    else
      echo "FAIL $h: bash -n reported a syntax error"
      FAIL=1
    fi
  done
fi

echo
echo "-- Secret scan: gitleaks --"
# The rule set is .gitleaks.toml, and it is deliberately narrow: exactly one
# allowlisted literal (the fake credential the envkit-mcp acceptance criteria
# quote by name) rather than a path-allowlist over factory/specs, so the
# generic-api-key rule stays armed everywhere else. .env.example is NOT
# allowlisted — it holds variable names, and a value appearing there is
# precisely the mistake worth catching.
if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks dir . --no-banner --redact --exit-code 1; then
    echo "OK   gitleaks dir ."
  else
    echo "FAIL gitleaks dir . — a credential-shaped string reached the tree."
    echo "     If it is a fixture, allowlist the literal in .gitleaks.toml; do not"
    echo "     allowlist the path."
    FAIL=1
  fi
elif [ -n "${CI:-}" ]; then
  # Same reasoning as the pnpm branch below: locally, no gitleaks means you
  # have not installed it. In CI it means the install step failed, and a run
  # that never scanned must not be able to report PASS.
  echo "FAIL gitleaks not found on PATH — in CI a missing scanner is a failure, not a skip."
  FAIL=1
else
  echo "SKIP gitleaks not found on PATH — secret scan not run (brew install gitleaks)."
fi

echo
echo "-- Phase-3 orchestrator package (only if pnpm is on PATH) --"
if command -v pnpm >/dev/null 2>&1; then
  if pnpm exec biome check .; then
    echo "OK   pnpm biome check"
  else
    echo "FAIL pnpm biome check"
    FAIL=1
  fi

  if pnpm tsc --noEmit; then
    echo "OK   pnpm tsc --noEmit"
  else
    echo "FAIL pnpm tsc --noEmit"
    FAIL=1
  fi

  if pnpm run typecheck:test; then
    echo "OK   pnpm typecheck:test"
  else
    echo "FAIL pnpm typecheck:test"
    FAIL=1
  fi

  # --coverage, not a bare run: the thresholds in each vitest config are
  # only a gate if the gate is what runs them. Each config's floors sit under
  # today's numbers on purpose — they catch a regression, not a refactor.
  if pnpm run test:coverage; then
    echo "OK   pnpm test:coverage"
  else
    echo "FAIL pnpm test:coverage"
    FAIL=1
  fi

  echo
  echo "-- Phase-6a dashboard (ui/, ui/server/) --"

  if pnpm run typecheck:server; then
    echo "OK   pnpm typecheck:server"
  else
    echo "FAIL pnpm typecheck:server"
    FAIL=1
  fi

  if pnpm run typecheck:ui; then
    echo "OK   pnpm typecheck:ui"
  else
    echo "FAIL pnpm typecheck:ui"
    FAIL=1
  fi

  if pnpm run typecheck:ui:test; then
    echo "OK   pnpm typecheck:ui:test"
  else
    echo "FAIL pnpm typecheck:ui:test"
    FAIL=1
  fi

  if pnpm run test:server:coverage; then
    echo "OK   pnpm test:server:coverage"
  else
    echo "FAIL pnpm test:server:coverage"
    FAIL=1
  fi

  if pnpm run test:ui:coverage; then
    echo "OK   pnpm test:ui:coverage"
  else
    echo "FAIL pnpm test:ui:coverage"
    FAIL=1
  fi

  if pnpm run build:ui; then
    echo "OK   pnpm build:ui"
  else
    echo "FAIL pnpm build:ui"
    FAIL=1
  fi

  echo
  echo "-- Design-system gates (Phase 6b fix-round; vendored under scripts/design/,"
  echo "   reaching outside this repo at neither build nor run time —"
  echo "   ui/docs/DESIGN.md's 'Gates wired' table) --"

  if python3 scripts/design/lint_hardcodes.py ui/src; then
    echo "OK   scripts/design/lint_hardcodes.py ui/src"
  else
    echo "FAIL scripts/design/lint_hardcodes.py ui/src"
    FAIL=1
  fi

  if python3 scripts/design/check_no_emoji.py ui/src; then
    echo "OK   scripts/design/check_no_emoji.py ui/src"
  else
    echo "FAIL scripts/design/check_no_emoji.py ui/src"
    FAIL=1
  fi

  if node scripts/design/contrast_check.mjs; then
    echo "OK   node scripts/design/contrast_check.mjs"
  else
    echo "FAIL node scripts/design/contrast_check.mjs"
    FAIL=1
  fi

  if python3 scripts/design/check_tokens.py ui/src; then
    echo "OK   scripts/design/check_tokens.py ui/src"
  else
    echo "FAIL scripts/design/check_tokens.py ui/src"
    FAIL=1
  fi

  # Where Chromium lives depends on who installed it. The dev container pins
  # it at $PLAYWRIGHT_BROWSERS_PATH/chromium — the same path
  # ui/playwright.config.ts hands to launchOptions. Everywhere else (macOS,
  # WSL, a CI runner) `playwright install chromium` writes a revision-stamped
  # directory into the per-user cache, which this probe used to miss: a
  # machine with a perfectly good browser reported SKIP, so a full local run
  # could print PASS having never opened a page. Ask Playwright where it
  # thinks its own binary is before concluding there isn't one.
  #
  # .github/workflows/ci.yml still runs e2e in its own job (it installs
  # Chromium first), so a SKIP there is coverage moved, not coverage lost.
  CHROMIUM_BIN="${PLAYWRIGHT_CHROMIUM_PATH:-${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium}"
  if [ ! -x "$CHROMIUM_BIN" ]; then
    CHROMIUM_BIN="$(node -e 'try { process.stdout.write(require("@playwright/test").chromium.executablePath()) } catch { /* not installed */ }' 2>/dev/null)"
  fi
  if [ -n "$CHROMIUM_BIN" ] && [ -x "$CHROMIUM_BIN" ]; then
    if pnpm run test:e2e; then
      echo "OK   pnpm test:e2e"
    else
      echo "FAIL pnpm test:e2e"
      FAIL=1
    fi
    # The specs call page.screenshot({path}) straight into a committed
    # directory, so a green e2e run still rewrites all 40 PNGs — and now that
    # the gate actually runs e2e, it dirties them on every local invocation.
    # Say so. Silent churn is how a rendering diff from an unrelated branch
    # ends up committed by someone who only ran the gate. Never a failure:
    # regenerating an artifact is what the run is for.
    if command -v git >/dev/null 2>&1; then
      shot_churn="$(git status --porcelain -- ui/e2e/__screenshots__/ 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
      if [ "${shot_churn:-0}" -gt 0 ]; then
        echo "NOTE e2e regenerated $shot_churn screenshot(s) under ui/e2e/__screenshots__/."
        echo "     They are artifacts, not assertions. Commit them only if this branch"
        echo "     meant to change the UI; otherwise 'git checkout -- ui/e2e/__screenshots__/'."
      fi
    fi
  else
    echo "SKIP pnpm test:e2e — no Chromium at \$PLAYWRIGHT_BROWSERS_PATH/chromium and none in Playwright's own cache (run 'pnpm exec playwright install chromium')."
  fi
elif [ -n "${CI:-}" ]; then
  # Locally a missing pnpm means "you only wanted the Phase-2 half". In CI it
  # means the toolchain step failed, and a run that skipped lint, every
  # typecheck set, all three suites and every design gate must not be able to
  # report PASS.
  echo "FAIL pnpm not found on PATH — in CI a missing toolchain is a failure, not a skip."
  FAIL=1
else
  echo "SKIP pnpm not found on PATH — orchestrator package checks not run."
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "== PASS =="
  exit 0
else
  echo "== FAIL =="
  exit 1
fi
