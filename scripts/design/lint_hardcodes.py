#!/usr/bin/env python3
"""Lint generated component code for hardcoded values that should be design tokens.

The kit's rule is "zero hardcoded values" — every color/size/radius/duration must come
from a token (CSS var, theme key, asset). Point this at YOUR component source.

Usage:
  python3 scripts/lint_hardcodes.py src/components            # a dir
  python3 scripts/lint_hardcodes.py Button.tsx Card.vue       # files
  python3 scripts/lint_hardcodes.py --ext .tsx,.vue src/
  python3 scripts/lint_hardcodes.py --include-tests src/      # lint test files too

Flags a line with a raw hex color, px length, or ms/s duration UNLESS it:
  - is inside a CSS var / token reference (var(--…), {token…}, theme(…)),
  - is a token-definition file (tokens/*.json),
  - carries an inline allow comment containing 'ds-allow-hardcode'.

Test files are skipped by default. A test asserting that 5 seconds formats as
'5s', or that a component renders '16px', is stating a fact about the code under
test — it is not drift, and there is no token to replace it with. Pass
--include-tests to lint them anyway. The skipped count is always printed, so a
skip can never read as a clean scan.
Exit 0 = clean, 1 = violations found.

--- black-smith vendoring note (Phase 6b fix-round, 2026-08-04) ---
Copied verbatim from the design-system pack this repo ported its kit from
(ui/docs/DESIGN.md, "Provenance") so scripts/check.sh reaches outside this
repo at neither build nor run time. One repo-
specific addition: EXCLUDE_FILES below, for files this generic scanner
can't classify correctly:
  - ui/src/styles/ds-tokens.css   — the vendored TOKEN DEFINITION file
    itself (this repo's naming for what the docstring above calls
    "tokens/*.json" — same exception, different filename convention).
  - ui/src/styles/ds-components.css — the vendored kit's component CSS
    (ui/docs/
    DESIGN.md's "Tokens copy"/primitive-inventory declarations), not
    hand-authored app code; auditing its pre-existing token-purity is
    tracked as a separate, larger gap in DESIGN.md, not this gate.
  - ui/src/icons.ts — raw lucide SVG `d` path strings (e.g. an "S" path
    command directly after a coordinate literally reads as "...1s...").
    The px/ms/time regexes below have no way to distinguish SVG path
    syntax from a CSS value; this is vector data, not styling.
Every other file in ui/src is scanned normally — the two apps this repo
actually authors (ui/src/pages, ui/src/components minus ds/, composables,
lib) have zero violations as of this commit; new ones fail the gate.
"""
import re
import sys
from pathlib import Path

CODE_EXT = {".css", ".scss", ".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte",
            ".swift", ".kt", ".dart", ".html"}

EXCLUDE_FILES = {
    "ds-tokens.css",
    "ds-components.css",
    "icons.ts",
}

HEX = re.compile(r"(?<![\w&])#[0-9a-fA-F]{3,8}\b")
PX = re.compile(r"(?<![\w.])\d+(?:\.\d+)?px\b")
MS = re.compile(r"(?<![\w.])\d+(?:\.\d+)?m?s\b")
# raw Tailwind palette utilities (bg-gray-500, text-blue-600, border-red-400 …) that
# bypass semantic tokens — the #1 real-world drift (527 of these in one audited project).
_TW_PREFIX = r"(?:bg|text|border|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow)"
_TW_COLOR = r"(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)"
TW = re.compile(rf"(?<![\w-]){_TW_PREFIX}-{_TW_COLOR}-(?:50|100|200|300|400|500|600|700|800|900|950)\b")
# hardcoded font-family not coming from a token/var
FONT = re.compile(r"font-family\s*:\s*(?!.*var\()")
# contexts that mean "this is a token, not a hardcode"
TOKEN_CTX = re.compile(r"var\(--|theme\(|tokens?[./]|\{[\w.\-]+\}|--[\w\-]+\s*:")
ALLOW = "ds-allow-hardcode"
# px values that are conventionally fine (hairlines, zero, 1px borders) — still reported as info? keep strict but allow 0/1px
PX_OK = {"0px", "1px"}
# test files: Button.test.tsx, time-ago.spec.ts, anything under __tests__/ or tests/
TEST_NAME = re.compile(r"\.(test|spec)\.[^.]+$")
TEST_DIRS = {"__tests__", "tests", "test"}


def is_test_file(path, root=None):
    """True for a test file. Directory checks use the path RELATIVE to the scanned
    root, so a project that merely lives under a directory named 'test' is not
    silently skipped whole."""
    if TEST_NAME.search(path.name):
        return True
    parts = path.parts
    if root is not None:
        try:
            parts = path.relative_to(root).parts
        except ValueError:
            pass
    return any(part in TEST_DIRS for part in parts)


def iter_files(paths, exts, include_tests=False):
    """Yields (file, skipped_as_test) so the caller can report what it did not lint."""
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            for f in sorted(pp.rglob("*")):
                # node_modules is matched relative to the scanned root for the same
                # reason as TEST_DIRS: an absolute path can contain anything.
                rel = f.relative_to(pp).parts
                if f.name in EXCLUDE_FILES:
                    continue
                if f.suffix in exts and "node_modules" not in rel:
                    if not include_tests and is_test_file(f, pp):
                        yield f, True
                    else:
                        yield f, False
        elif pp.is_file() and pp.suffix in exts:
            # An explicitly named file is still skipped if it is a test file, so that
            # `lint *.ts` and `lint .` agree. --include-tests overrides both.
            yield pp, not include_tests and is_test_file(pp)


def lint_line(line, tailwind=True):
    if ALLOW in line or TOKEN_CTX.search(line):
        return []
    stripped = line.strip()
    if stripped.startswith(("//", "*", "/*", "#", "<!--")):
        return []
    hits = []
    # @media / @container conditions can't use var() (a CSS limitation) — breakpoint px there
    # is not drift; skip px/ms on those lines (still check hex/tailwind/font).
    media_cond = "@media" in line or "@container" in line
    for m in HEX.finditer(line):
        hits.append(("hex", m.group(0)))
    if not media_cond:
        for m in PX.finditer(line):
            if m.group(0) not in PX_OK:
                hits.append(("px", m.group(0)))
        for m in MS.finditer(line):
            hits.append(("time", m.group(0)))
    if tailwind:
        for m in TW.finditer(line):
            hits.append(("tailwind-palette", m.group(0)))
    if FONT.search(line):
        hits.append(("font-family", "literal font-family"))
    return hits


def main(argv):
    exts = CODE_EXT
    tailwind = True
    include_tests = False
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--ext" and i + 1 < len(argv):
            exts = {e if e.startswith(".") else "." + e for e in argv[i + 1].split(",")}
            i += 2
        elif argv[i] in ("--no-tw", "--no-tailwind"):
            tailwind = False
            i += 1
        elif argv[i] == "--include-tests":
            include_tests = True
            i += 1
        else:
            args.append(argv[i])
            i += 1
    if not args:
        print(__doc__)
        return 0

    found = list(iter_files(args, exts, include_tests))
    files = [f for f, skipped in found if not skipped]
    skipped_tests = sum(1 for _, skipped in found if skipped)
    violations = 0
    for f in files:
        try:
            text = f.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        in_allow = False
        for n, line in enumerate(text.splitlines(), 1):
            if "ds-allow-hardcode:start" in line:
                in_allow = True
                continue
            if "ds-allow-hardcode:end" in line:
                in_allow = False
                continue
            if in_allow:
                continue
            for kind, val in lint_line(line, tailwind):
                print(f"{f}:{n}: hardcoded {kind} '{val}' — use a token")
                violations += 1

    skipped_note = ""
    if skipped_tests:
        skipped_note = (f" Skipped {skipped_tests} test file(s) — "
                        f"pass --include-tests to lint them.")
    print(f"\nScanned {len(files)} file(s).{skipped_note}")
    if violations:
        print(f"FAIL: {violations} hardcoded value(s). Map each to a token, "
              f"or add a '{ALLOW}' comment for a justified exception.")
        return 1
    print("OK: no hardcoded values found.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
