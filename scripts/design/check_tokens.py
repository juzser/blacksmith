#!/usr/bin/env python3
"""Fail if any `var(--bs-...)` reference in ui/src points at a token that is
never actually declared — the "same mistake twice" bug class (Phase 6b round 4's
milestone-block padding, round 6's Roadmap SectionHeading gap: both referenced
`--ds-space-5`, which did not exist in the old kit's 4/6/8 spacing scale — an
invalid custom property silently computes to the CSS property's initial value,
NOT a build error, so both shipped as "the padding/gap is just... gone" instead
of a loud failure).

Repo-specific, small, and vendored the same way scripts/design/lint_hardcodes.py
and check_no_emoji.py are (this repo's own gate scripts, not a
knowledge/design-system runtime reference) — there is no generic version of
this check in the design-system pack to copy from; it is authored directly
against this repo's own token layout.

Usage:
  python3 scripts/design/check_tokens.py [ui/src]   # defaults to ui/src

Definitions come from two places, BOTH count as "defined" (component-scoped
definitions are not second-class):
  1. Any `--bs-<name>: <value>;` CSS declaration anywhere in
     ui/src/styles/bs-tokens.css or ui/src/styles/bs-primitives.css — not
     just `:root` blocks, so a token declared inside a specific class rule
     still counts.
  2. Any `'--bs-<name>':` / `"--bs-<name>":` quoted object key in a .vue
     file's <script> — a component setting a custom property at runtime via
     an inline `:style` object. This is a real, intentional definition —
     just not a CSS one — so it is NOT an exception needing an escape
     comment; it is scanned into the same `defined` set as the CSS
     declarations, same as design-spec.md's "component-scoped token"
     language already covers.

References are every `var(--bs-<name>...)` found in ui/src/**/*.vue and
ui/src/**/*.css (nested var() fallbacks, e.g. `var(--bs-a, var(--bs-b))`,
are two separate references, each checked independently). A reference whose
token name is built dynamically (a template-literal interpolation, e.g.
`` `var(--bs-tint-${tint})` `` — StatCard.vue's tint prop picks one of
several REAL, concretely-declared tint tokens at runtime) can't be resolved
by a static text scan; these are detected (the captured name is cut short
by the `${`) and skipped, not flagged — this script only catches
STATICALLY-WRITTEN wrong/missing token names, the actual bug class it
exists for.

A reference to a token that is genuinely never assigned a value ANYWHERE
(not in CSS, not via a component's runtime `:style` object either) needs an
explicit `ds-allow-undefined-token` comment on the same line, or a
`ds-allow-undefined-token:start` / `ds-allow-undefined-token:end` block
around it — same escape-hatch shape as lint_hardcodes.py's own
`ds-allow-hardcode` (name kept as `ds-` for both escape hatches, a gate-
authoring convention rather than a token prefix — see DESIGN.md's "Gates
wired" table). None of this repo's current code needs it.

Exit 0 = every var(--bs-...) reference resolves to a real declaration.
Exit 1 otherwise (prints file:line for each undefined reference).
"""
import re
import sys
from pathlib import Path

SCAN_EXTS = {".vue", ".css"}
# DS9 part B dropped the old HDS-derived kit (ds-tokens.css/ds-components.css);
# the BS kit's token files are the only ones left to scan.
TOKEN_FILES = ("bs-tokens.css", "bs-primitives.css")

DEFINE_RE = re.compile(r"(--(?:ds|bs)-[\w-]+)\s*:")
JS_DEFINE_RE = re.compile(r"""['"](--(?:ds|bs)-[\w-]+)['"]\s*:""")
REF_RE = re.compile(r"var\(\s*(--(?:ds|bs)-[\w-]+)")
DYNAMIC_SUFFIX = "$"  # a template-literal interpolation continues the token name
ALLOW = "ds-allow-undefined-token"


def collect_defined_tokens(root: Path, styles_dir: Path) -> set[str]:
    defined: set[str] = set()
    for name in TOKEN_FILES:
        f = styles_dir / name
        if not f.is_file():
            continue
        defined.update(DEFINE_RE.findall(f.read_text()))
    # Component-scoped: a .vue <script> setting a custom property at
    # runtime via a quoted object key (e.g. Highlight.vue's `:style`
    # object) is just as real a definition as a CSS declaration.
    for f in root.rglob("*.vue"):
        if "node_modules" in f.relative_to(root).parts:
            continue
        defined.update(JS_DEFINE_RE.findall(f.read_text()))
    return defined


def iter_scan_files(root: Path):
    for f in sorted(root.rglob("*")):
        if f.suffix not in SCAN_EXTS:
            continue
        if "node_modules" in f.relative_to(root).parts:
            continue
        yield f


def main(argv: list[str]) -> int:
    root = Path(argv[0]) if argv else Path("ui/src")
    if not root.is_dir():
        print(f"FAIL: {root} is not a directory")
        return 1

    styles_dir = root / "styles"
    defined = collect_defined_tokens(root, styles_dir)
    if not defined:
        print(f"FAIL: no --ds-*/--bs-* token declarations found under {styles_dir} "
              f"(expected {', '.join(TOKEN_FILES)})")
        return 1

    files = list(iter_scan_files(root))
    violations = 0
    scanned_refs = 0
    skipped_dynamic = 0
    for f in files:
        try:
            text = f.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        in_allow = False
        for n, line in enumerate(text.splitlines(), 1):
            if f"{ALLOW}:start" in line:
                in_allow = True
                continue
            if f"{ALLOW}:end" in line:
                in_allow = False
                continue
            for m in REF_RE.finditer(line):
                token = m.group(1)
                # A template-literal interpolation right after the matched
                # identifier chars (`` `var(--ds-tint-${tint})` ``) means the
                # real token name is built at runtime — nothing to statically
                # verify, and not the "typo'd a fixed name" bug this exists for.
                if line[m.end():m.end() + 1] == DYNAMIC_SUFFIX:
                    skipped_dynamic += 1
                    continue
                scanned_refs += 1
                if token in defined:
                    continue
                if in_allow or ALLOW in line:
                    continue
                print(f"{f}:{n}: undefined token '{token}' referenced via var() "
                      f"— not declared in {' or '.join(TOKEN_FILES)}, and no "
                      f"component sets it at runtime either")
                violations += 1

    dynamic_note = f", {skipped_dynamic} dynamic (skipped)" if skipped_dynamic else ""
    print(f"\nScanned {len(files)} file(s), {scanned_refs} var(--ds-.../--bs-...) reference(s){dynamic_note}, "
          f"{len(defined)} declared token(s).")
    if violations:
        print(f"FAIL: {violations} undefined token reference(s). Fix the token name, "
              f"declare it, or add a '{ALLOW}' comment for a justified exception.")
        return 1
    print("OK: every var(--ds-.../--bs-...) reference resolves to a declared token.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
