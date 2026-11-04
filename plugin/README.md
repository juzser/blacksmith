# Blacksmith plugin

Small things for Claude Code: plain explanations, a confidence % on options, `/cross-check`, `/audit`, four agents with their own model and effort, and a compact rule.

- Overview and install: the [root README](../README.md).
- Rules text: [rules.md](rules.md), loaded by a SessionStart hook ([how](../docs/rules.md)).
- Agents: [agents/](agents/) ([routing and overrides](../docs/agents.md)).
- Audit: [docs/audit.md](../docs/audit.md).
- Cross-check, including what leaves your machine: [docs/cross-check.md](../docs/cross-check.md).
- Compact: [docs/compact.md](../docs/compact.md).
- Tests: `bash plugin/test/run.sh` (bash, git, node; uses a fake `codex` and a fake DeepSeek server on 127.0.0.1; needs curl and ps).
