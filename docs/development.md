# Development

## Layout

```
plugin/               the Blacksmith plugin: rules.md, hooks/, agents/, skills/, test/
.claude-plugin/       marketplace.json: lists the plugin
scripts/check.sh      the gate
scripts/check-md-links.mjs, test-md-links.sh   the markdown link check and its test
docs/                 these docs
```

## The gate

```bash
bash scripts/check.sh
```

It runs `plugin/test/run.sh`, checks that the JSON parses and that every marketplace `source` exists (the main entry must be `./plugin`), runs `sh -n` on the plugin's scripts, checks that every relative link in a tracked `.md` file resolves to a tracked path, and, when `claude` is on PATH, runs `claude plugin validate plugin`. Without `claude` that prints `SKIP`: read the tail, not the exit code. It must end in `== PASS ==`. CI runs the same file as the job `gate (scripts/check.sh)`.

Needs bash, git and node. Try the plugin from a checkout with `claude --plugin-dir ./plugin`.

## Who owns what

Pull requests are open to anyone. Releases, tags, npm publishing, repository rulesets and policy belong to the maintainer, not to a contributor or an agent. The operating rules are in [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
