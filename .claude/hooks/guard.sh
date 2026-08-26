#!/usr/bin/env bash
# Blacksmith — PreToolUse guard hook, transport shim.
#
# This script is no longer where the guardrails live. It used to be 174
# lines of bash+sed+grep implementing all six guard-hook rules directly —
# and, it turns out, doing so unreliably: `extract_field` used a `\|`
# alternation inside a basic regular expression, a GNU-sed extension that
# BSD/macOS `sed` (the only `sed` on a stock Mac, no `gsed`) does not
# support. The substitution silently never matched, `tool_name` extracted as
# `''`, and every rule below fell through as an allow — on every macOS run,
# since Phase 2, with no error of any kind. `permissions.deny` in
# `.claude/settings.json` was the only guard that was ever actually live on
# this platform. That bug is exactly why the rules were moved off bash and
# onto data (factory/policies/guardrails.yml) plus tested TypeScript
# (factory/orchestrator/src/policy.ts,
# factory/orchestrator/test/policy.test.ts) — not fixed in place, ported.
#
# This file is what is left: plumbing. It reads the PreToolUse payload from
# stdin, hands it to `node dist/cli.js policy hook` unchanged, and relays
# that command's decision. The one piece of judgment still made here is
# deliberate and load-bearing: this shim tells apart three outcomes where the
# old one had two. The bug above got its blast radius from a hook that had
# exactly one failure mode — quietly allow — for every reason it could fail,
# from "a rule didn't match" (fine) all the way to "the extractor is broken"
# (not fine, and indistinguishable from the first at the call site). Here
# "the policy layer answered allow" (silent), "the policy layer answered
# deny" (relayed verbatim) and "the policy layer could not answer at all"
# (escalated to the operator — see `unavailable` below) are three separate
# code paths, and only the first is silent.
#
# Kept in plain, POSIX-portable bash on purpose, and only the constructs
# actually run and verified on this machine (bash 3.2.57 / BSD userland) — no
# `\|` inside a basic regex, no GNU-only grep/sed flags, no `realpath`. It no
# longer inspects the payload or the decision at all, which is the strongest
# version of that rule: a transport shim that cannot parse its own output
# correctly is the exact failure this rewrite exists to remove, and this one
# never parses anything.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/factory/orchestrator/dist/cli.js"

# Emits a decision envelope and exits 0 — Claude Code's PreToolUse hook
# protocol has no separate "error" outcome, only allow/deny/ask, and a
# decision is expressed on stdout, not via a nonzero exit (block() in the old
# guard.sh worked the same way).
decide() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$1" "$2"
  exit 0
}

# For the three ways the policy layer can be *unavailable* rather than
# unhappy: dist/cli.js not built, node not on PATH, or the CLI exiting
# without a decision. None of these is a rule violation — nothing has judged
# the command either way — so the honest answer is neither "allow" (which is
# F0's bug exactly: one indistinguishable silent yes for both "no rule
# matched" and "the matcher is broken") nor "deny".
#
# "deny" was what this did first, and it is wrong for a load-bearing reason.
# A fresh clone has no dist/ at all, so the very first command of INSTALL.md's
# self-install runbook — `pnpm install` — came back denied, and the runbook
# could not execute at all. The same trap closes on any `git pull` that
# touches src/ before a rebuild, because the remedy (`pnpm run build`) is
# itself a Bash call the hook has just refused. A guard whose failure mode is
# "the factory cannot start, and cannot be repaired from inside" is not safe,
# only stuck.
#
# "ask" routes to Claude Code's normal permission prompt instead, which keeps
# every property that matters: nothing is auto-allowed, a human sees each
# command for as long as the policy layer is down, and an unattended run is no
# worse off than it was under the hard deny. Rule violations decided by
# policy.ts are untouched and still hard denies — they are relayed at the
# bottom of this file and never come through here.
unavailable() {
  decide ask "$1"
}

INPUT="$(cat)"

if [ ! -f "$CLI" ]; then
  # dist/cli.js missing means "nobody has run `pnpm run build` yet" (a fresh
  # clone, or a pull that touched src/ without a rebuild) — the policy layer
  # cannot be consulted at all, so this escalates rather than guessing.
  unavailable "Blacksmith's guard hook cannot check this command: its policy layer is not built ($CLI missing). Run 'pnpm run build' to restore automatic checking; until then every command needs your approval."
fi

if ! command -v node >/dev/null 2>&1; then
  unavailable "Blacksmith's guard hook cannot check this command: node is not on PATH, so its policy layer cannot run. Until it can, every command needs your approval."
fi

OUTPUT="$(printf '%s' "$INPUT" | node "$CLI" policy hook)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  # `smith policy hook` (cli.ts) always exits 0 when it reaches a decision,
  # allow or deny — it only exits non-zero when it could not reach one at
  # all (an unparseable payload, or an unexpected error while evaluating).
  # That is precisely the case this hook must not treat as "nothing to
  # inspect, therefore fine": escalate, name the fix, and let a human or a
  # rebuild resolve it.
  unavailable "Blacksmith's guard hook cannot check this command: its policy layer exited ${STATUS} instead of returning a decision (dist/ may be stale, or the payload could not be evaluated). Run 'pnpm run build'; if that does not fix it, investigate. Until then every command needs your approval."
fi

# Relay verbatim. `smith policy hook` prints a deny envelope, or nothing at
# all when no rule fires — never an allow envelope, because Claude Code reads
# an explicit allow as "bypass the permission system", which would make this
# hook a blanket auto-approver for every command outside guardrails.yml (see
# cli.ts's `policy hook` for the full reasoning). So there is nothing to
# filter here and this shim does not second-guess the layer that owns the
# decision: a filter would only hide a regression in it. test/cli.test.ts
# asserts the silent allow directly, where breaking it fails a test instead
# of being quietly absorbed by plumbing.
if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
