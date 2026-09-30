#!/usr/bin/env python3
"""Tests for lint_icon_only.py (S2-3). No pytest in this repo's allowlist —
stdlib `unittest` only, same rung check_tokens.py/lint_hardcodes.py's own
gates run on (plain python3, no extra dependency). Fixtures are written to a
tmp dir per test rather than checked-in files: each one is a single
throwaway .vue snippet, and a tmp dir lets `main()` be exercised exactly as
`scripts/check.sh` calls it (a real directory argument), including the
nonexistent-path case.

Run: python3 scripts/design/test_lint_icon_only.py
"""
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lint_icon_only import find_violations, main  # noqa: E402


class FindViolationsTests(unittest.TestCase):
    def test_iconbutton_without_label_flagged(self):
        text = '<IconButton :icon="X" />'
        self.assertEqual(len(find_violations(text, "f.vue")), 1)

    def test_iconbutton_with_label_clean(self):
        text = '<IconButton :icon="X" label="Close" />'
        self.assertEqual(find_violations(text, "f.vue"), [])

    def test_icon_only_button_without_aria_label_flagged(self):
        text = '<button @click="x"><Icon :icon="X" /></button>'
        self.assertEqual(len(find_violations(text, "f.vue")), 1)

    def test_icon_only_button_with_aria_label_clean(self):
        text = '<button aria-label="Close" @click="x"><Icon :icon="X" /></button>'
        self.assertEqual(find_violations(text, "f.vue"), [])

    def test_button_with_icon_and_text_not_flagged(self):
        text = '<button @click="x"><Icon :icon="X" /> Close</button>'
        self.assertEqual(find_violations(text, "f.vue"), [])

    def test_gt_inside_quoted_attribute_does_not_break_tag_scan(self):
        # A bound expression containing `>` used to truncate the naive
        # "everything up to the next >" attr scan, so the real aria-label
        # a few characters further along was never seen.
        text = '<button :class="x > 3 ? \'a\' : \'b\'" aria-label="Close"><Icon /></button>'
        self.assertEqual(find_violations(text, "f.vue"), [])

    def test_gt_inside_quoted_attribute_without_aria_label_still_flagged(self):
        text = '<button :class="x > 3 ? \'a\' : \'b\'"><Icon /></button>'
        self.assertEqual(len(find_violations(text, "f.vue")), 1)

    def test_non_self_closing_icon_tag_detected(self):
        text = '<button @click="x"><Icon :icon="X"></Icon></button>'
        self.assertEqual(len(find_violations(text, "f.vue")), 1)

    def test_lucide_component_used_directly_detected(self):
        text = (
            "import { ChevronDown } from 'lucide-vue-next';\n"
            '<a href="/x"><ChevronDown /></a>'
        )
        self.assertEqual(len(find_violations(text, "f.vue")), 1)

    def test_lucide_component_used_directly_with_aria_label_clean(self):
        text = (
            "import { ChevronDown } from 'lucide-vue-next';\n"
            '<a href="/x" aria-label="Expand"><ChevronDown /></a>'
        )
        self.assertEqual(find_violations(text, "f.vue"), [])

    def test_aliased_lucide_import_detected_by_local_name(self):
        text = (
            "import { X as Close } from 'lucide-vue-next';\n" '<button @click="x"><Close /></button>'
        )
        self.assertEqual(len(find_violations(text, "f.vue")), 1)


class MainTests(unittest.TestCase):
    def _run_main(self, args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(args)
        return code, buf.getvalue()

    def test_nonexistent_path_argument_fails(self):
        code, out = self._run_main(["/no/such/path/at/all"])
        self.assertEqual(code, 1)
        self.assertIn("does not exist", out)

    def test_clean_directory_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "Clean.vue").write_text(
                '<template><IconButton :icon="X" label="Close" /></template>'
            )
            code, out = self._run_main([tmp])
        self.assertEqual(code, 0)
        self.assertIn("OK", out)

    def test_violating_directory_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "Bad.vue").write_text(
                '<template><IconButton :icon="X" /></template>'
            )
            code, out = self._run_main([tmp])
        self.assertEqual(code, 1)
        self.assertIn("FAIL", out)


if __name__ == "__main__":
    unittest.main()
