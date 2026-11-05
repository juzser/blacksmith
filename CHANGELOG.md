# Changelog

What landed, newest first. The plugin's version is in `plugin/.claude-plugin/plugin.json`.

## 1.0.0: the reset to a minimal plugin

Blacksmith is now a small Claude Code plugin with these pieces: plain-explanation rules, a confidence % on options, `/cross-check` through codex (read-only), `/audit`, four agents with their own model and effort, and a compact rule. See [README.md](README.md) and [docs/history.md](docs/history.md) for why.

- **Changed:** `/cross-check` can also ask DeepSeek (`deepseek-v4-pro`, key from `DEEPSEEK_API_KEY`), in parallel with codex and with one output group per provider. It is opt-in: `CROSSCHECK_PROVIDERS` defaults to `codex`, and DeepSeek runs only when named. DeepSeek sees only the prompt. The key reaches `curl` on stdin only, codex never sees it, the endpoint must be https (http for localhost), model output is stripped of control bytes, and an interrupted run cleans up its processes and temp files. The temp dir now honors `TMPDIR` on macOS. See [docs/cross-check.md](docs/cross-check.md).
- **Added:** the plugin in `plugin/` (PR #542); a markdown link check in `scripts/check.sh`; a docs set, `INSTALL.md` and `README.md` rewritten for the plugin.
- **Added:** `/audit`, a read-only audit by axis (performance, code-quality, security), one `auditor` agent per axis in parallel.
- **Kept:** `LICENSE`, `CODE_OF_CONDUCT.md`, this changelog.
- **Removed:** the `researcher` and `scout` agents, the orchestrator (`factory/`), the dashboard (`ui/`), the `bs-mod` and `pr-mod` modules, the fourteen `bs-*` agents and the `/bs` skill, the guard hook, the trial harness (`trial/`), the old docs, the npm packaging (`package.json`, lockfile, TypeScript, lint and test configs), the e2e CI jobs and `.gitleaks.toml`. The `bs` command and the `@juzser/blacksmith` npm package are not part of 1.0.0; the last published version is 0.7.0.
- **Gate:** `scripts/check.sh` now runs the plugin tests, JSON, marketplace-path, shell-syntax and link checks, and the plugin validator when `claude` is present. The CI job keeps its name, `gate (scripts/check.sh)`; the `e2e (Playwright, Chromium)` check is gone.
- **Old version:** preserved at the git tag `factory-final`. The open PRs #535, #536, #538 and #541 were closed with their branches kept.

Earlier history (0.x, the factory) is in the `factory-final` tag.
