#!/usr/bin/env python3
"""Icon-only-control lint (ds-spec.md §2.5, verbatim): "A lint check in DS0
flags an <IconButton> without label and any icon-only <button>/<a> without
aria-label."

Two independent checks over .vue file text — no compiler, same style as the
other scripts/design/ gates:

  1. Every `<IconButton ...>` call site must carry a `label` or `:label`
     attribute. IconButton.vue's own `label: string` prop (no `?`, no
     default) already makes a missing label a TypeScript error at any real
     call site; this gives the same rule a plain-text signal that needs no
     typecheck to run, and is the one of the two spec sentences a type
     system already enforces on its own.
  2. Every icon-only `<button>`/`<a>` — one whose entire rendered content is
     a single `<Icon .../>` and nothing else, no visible text — must carry
     `aria-label` or `:aria-label`. A `<button>`/`<a>` wrapping an `<Icon>`
     plus visible text is not icon-only and is not flagged (the text is
     already the accessible name).

Usage: python3 scripts/design/lint_icon_only.py ui/src
Exit 0 = clean, 1 = violations found.
"""
import re
import sys
from pathlib import Path

ICONBUTTON_TAG = re.compile(r"<IconButton\b((?:[^>]|\n)*?)/?>", re.MULTILINE)
BUTTON_OR_A = re.compile(r"<(button|a)\b((?:[^>]|\n)*?)>(.*?)</\1>", re.DOTALL | re.IGNORECASE)
ICON_ONLY_CONTENT = re.compile(r"^\s*<Icon\b(?:[^>]|\n)*?/>\s*$")
LABEL_ATTR = re.compile(r"(?<![:\w-])(?::)?label\s*=")
ARIA_LABEL_ATTR = re.compile(r"(?<![:\w-])(?::)?aria-label\s*=")
# Deliberately no ds-allow-* escape hatch here (unlike lint_hardcodes.py /
# check_tokens.py): a missing accessible name on an icon-only control is
# never a justified exception, only a missing label.


def find_violations(text, path):
    violations = []
    for m in ICONBUTTON_TAG.finditer(text):
        attrs = m.group(1)
        if not LABEL_ATTR.search(attrs):
            line = text.count("\n", 0, m.start()) + 1
            violations.append(f"{path}:{line}: <IconButton> without a label/:label attribute")

    for m in BUTTON_OR_A.finditer(text):
        tag, attrs, content = m.group(1), m.group(2), m.group(3)
        if not ICON_ONLY_CONTENT.match(content):
            continue
        if ARIA_LABEL_ATTR.search(attrs):
            continue
        line = text.count("\n", 0, m.start()) + 1
        violations.append(
            f"{path}:{line}: icon-only <{tag}> without an aria-label/:aria-label attribute"
        )
    return violations


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    files = []
    for arg in argv:
        p = Path(arg)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.vue")))
        elif p.is_file():
            files.append(p)

    violations = []
    for f in files:
        try:
            text = f.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        violations.extend(find_violations(text, f))

    for v in violations:
        print(v)

    print(f"\nScanned {len(files)} file(s).")
    if violations:
        print(f"FAIL: {len(violations)} icon-only control(s) missing their accessible name.")
        return 1
    print("OK: every IconButton has a label, every icon-only button/link has an aria-label.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
