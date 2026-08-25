#!/usr/bin/env python3
"""Fail if any emoji / decorative pictograph appears in UI output, the taste doctrine,
or the agent's own instruction surface.

The kit forbids emoji in product UI (taste/design-taste.md) — this enforces it so it
can't drift back. It also scans the files the AGENT reads on every run (CLAUDE.md,
the skills, component/workflow/content/accessibility specs): if those contain emoji,
the model imitates them and emits emoji-laden output. Keeping the instruction surface
emoji-free is what actually stops emoji in generated design systems.

Usage:
  python3 scripts/check_no_emoji.py                      # this repo's default (ui/src)
  python3 scripts/check_no_emoji.py path/to/src ...
Exit 0 = clean, 1 = an emoji/pictograph was found.

--- black-smith vendoring note (Phase 6b fix-round, 2026-08-04) ---
Copied from knowledge/design-system/pack/scripts/check_no_emoji.py so
scripts/check.sh doesn't reach outside this repo at runtime. Two repo-
specific adaptations:
  1. DEFAULT points at ui/src (this repo's UI source root), not the design-
     system pack's own examples/taste/agent-surface directories, which
     don't exist here.
  2. The em/en-dash "AI-pattern tell" check now skips comment lines (JS
     `//`-leading lines and HTML `<!-- -->` blocks) instead of scanning an
     entire .vue/.tsx file line-for-line. Verified against this repo: every
     one of this file's original 30+ hits on ui/src was a `—` inside a
     source-code doc comment (this whole codebase's established comment
     style, going back to Phase 6a — not this fix-round's introduction),
     not rendered UI copy. The check's own stated intent ("AI-pattern tell
     in UI copy") is about copy, not code comments; the emoji check is
     UNCHANGED (still scans every line, comments included — an emoji in a
     comment is still an instruction-surface imitation risk).
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # scripts/design/ -> repo root
DEFAULT = [ROOT / "ui" / "src"]
EXTS = {".md", ".mdx", ".html", ".htm", ".tsx", ".jsx", ".ts", ".js",
        ".vue", ".svelte", ".css", ".scss", ".astro", ".json"}

# Emoji + dingbat pictographs (check marks, stars, etc.). Deliberately EXCLUDES
# arrows (U+2190-21FF) and box-drawing, which are legitimate typographic notation.
# Ranges are referenced by codepoint only (this file stays emoji-free itself).
EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF"   # symbols & pictographs, emoticons, transport, supplemental
    "\U00002600-\U000026FF"    # misc symbols
    "\U00002700-\U000027BF"    # dingbats (check marks, stars, scissors, ...)
    "\U00002B00-\U00002BFF"    # misc symbols & arrow pictographs (star, ...)
    "\U0001FA70-\U0001FAFF"
    "\U0000FE0F\U000020E3]"    # variation selector + combining keycap
)


def iter_files(paths):
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            for f in pp.rglob("*"):
                if f.suffix in EXTS and "node_modules" not in f.parts:
                    yield f
        elif pp.is_file():
            yield pp


UI_EXTS = {".html", ".htm", ".tsx", ".jsx", ".vue", ".svelte"}
DASH = re.compile("[—–]")  # em-dash / en-dash — an AI-pattern tell in UI copy


def is_comment_line(stripped, in_html_comment):
    """True if `stripped` (already .strip()'d) is fully a comment line, given
    whether an unclosed HTML comment carried in from a previous line."""
    if in_html_comment:
        return True
    return stripped.startswith(("//", "/*", "*", "<!--"))


def main(argv):
    paths = [Path(a) for a in argv] or DEFAULT
    hits = []
    files = list(iter_files(paths))
    for f in files:
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        ui = f.suffix in UI_EXTS
        in_html_comment = False
        for n, line in enumerate(text.splitlines(), 1):
            for m in EMOJI.finditer(line):
                hits.append(f"{f}:{n}: emoji/pictograph {m.group(0)!r} - use lucide / plain text")
            stripped = line.strip()
            comment = is_comment_line(stripped, in_html_comment)
            # Update HTML-comment state for the NEXT line, based on this line's content.
            if "<!--" in line and "-->" not in line.split("<!--", 1)[1]:
                in_html_comment = True
            elif "-->" in line:
                in_html_comment = False
            if ui and not comment:
                for m in DASH.finditer(line):
                    hits.append(f"{f}:{n}: em/en-dash {m.group(0)!r} - AI-pattern tell; use a period, comma, or hyphen")
    print(f"Scanned {len(files)} file(s).")
    if hits:
        print(f"\nFAIL: {len(hits)} emoji/pictograph(s) found:")
        for h in hits:
            print("  x " + h)
        return 1
    print("OK: no emoji in UI output or taste files.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
