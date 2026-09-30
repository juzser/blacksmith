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
     a single icon component and nothing else, no visible text — must carry
     `aria-label` or `:aria-label`. A `<button>`/`<a>` wrapping an icon plus
     visible text is not icon-only and is not flagged (the text is already
     the accessible name). "Icon component" means `<Icon .../>` (the wrapper
     every other kit component uses) or a @lucide/vue component used
     directly — derived per file from its own
     `import { X, Y } from '@lucide/vue'` line, so a bare `<X />` is
     caught even though it never goes through Icon.vue. Self-closing
     (`<Icon .../>`) and empty non-self-closing (`<Icon ...></Icon>`) both
     count as icon-only; either can appear in hand-written or
     compiler-normalised markup.

Attribute scanning is quote-aware: a bound attribute's value can itself
contain `>` (e.g. `:aria-label="x > 3 ? a : b"`), and a naive "everything up
to the next `>`" match would cut the tag short there and miss the very
attribute this gate exists to find.

Usage: python3 scripts/design/lint_icon_only.py ui/src
Exit 0 = clean, 1 = violations found or an argument is not a real path.
"""
import re
import sys
from pathlib import Path

# Any run of non-quote, non-`>` characters, or a whole quoted string (which
# may itself contain `>`) — used everywhere a tag's attribute soup needs to
# be consumed without stopping at a `>` inside a quoted value.
ATTRS = r'(?:[^>"\']|"[^"]*"|\'[^\']*\')*'

ICONBUTTON_TAG = re.compile(rf"<IconButton\b({ATTRS})/?>", re.MULTILINE)
BUTTON_OR_A = re.compile(rf"<(button|a)\b({ATTRS})>(.*?)</\1>", re.DOTALL | re.IGNORECASE)
LABEL_ATTR = re.compile(r"(?<![:\w-])(?::)?label\s*=")
ARIA_LABEL_ATTR = re.compile(r"(?<![:\w-])(?::)?aria-label\s*=")
LUCIDE_IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*['\"]@lucide/vue['\"]")
# Deliberately no ds-allow-* escape hatch here (unlike lint_hardcodes.py /
# check_tokens.py): a missing accessible name on an icon-only control is
# never a justified exception, only a missing label.


def lucide_component_names(text):
    """Local (possibly aliased) names a file's own @lucide/vue import
    binds — e.g. `import { ChevronDown, X as Close } from '@lucide/vue'`
    yields {'ChevronDown', 'Close'}, matching what the template actually
    renders."""
    names = set()
    for m in LUCIDE_IMPORT.finditer(text):
        for part in m.group(1).split(","):
            name = part.strip()
            if not name:
                continue
            names.add(name.split(" as ")[-1].strip())
    return names


def icon_only_content_re(icon_names):
    names = sorted({"Icon", *icon_names})
    alt = "|".join(re.escape(n) for n in names)
    return re.compile(rf"^\s*<({alt})\b{ATTRS}(?:/>|>\s*</\1>)\s*$")


def find_violations(text, path):
    violations = []
    for m in ICONBUTTON_TAG.finditer(text):
        attrs = m.group(1)
        if not LABEL_ATTR.search(attrs):
            line = text.count("\n", 0, m.start()) + 1
            violations.append(f"{path}:{line}: <IconButton> without a label/:label attribute")

    icon_only_re = icon_only_content_re(lucide_component_names(text))
    for m in BUTTON_OR_A.finditer(text):
        tag, attrs, content = m.group(1), m.group(2), m.group(3)
        if not icon_only_re.match(content):
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
    bad_args = []
    for arg in argv:
        p = Path(arg)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.vue")))
        elif p.is_file():
            files.append(p)
        else:
            bad_args.append(arg)

    if bad_args:
        for arg in bad_args:
            print(f"ERROR: path does not exist: {arg}")
        return 1

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
