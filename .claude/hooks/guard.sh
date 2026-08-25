#!/usr/bin/env bash
# Black Smith — PreToolUse guard hook (guardrails.md, S1 unless stated
# otherwise). Reads a Claude Code PreToolUse hook payload from stdin,
# inspects Bash tool calls, and denies anything guardrails.md forbids.
#
# Deliberately pure/portable bash + sed/grep — no external JSON parser
# dependency, so it runs the same everywhere the hook itself runs.

set -u
set -o pipefail

INPUT="$(cat)"

# --- minimal JSON string-field extractor (no jq/python dependency) --------
# Pulls the first `"field":"value"` occurrence, unescaping \" -> " and
# \\ -> \. Good enough for the flat fields this hook reads; it is not a
# general JSON parser.
extract_field() {
  local field="$1"
  printf '%s' "$INPUT" \
    | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\(\(\\\\.\|[^\"\\\\]\)*\)\".*/\1/p" \
    | head -n1 \
    | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

TOOL_NAME="$(extract_field tool_name)"

# Only Bash tool calls are in scope for this hook.
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND="$(extract_field command)"

if [ -z "$COMMAND" ]; then
  exit 0
fi

block() {
  reason="BLOCKED: $1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || printf ''
}

# Chain-aware subcommand detector. Global flags (including value-taking ones
# like `-C <path>`) sit between `git` and the subcommand, so we don't try to
# match position — we require `git` and the subcommand word to appear in the
# same chain segment (no `;`, `&`, `|` between them). This is intentionally
# loose (same trade-off as the rm -rf detector below): it can over-match a
# subcommand word appearing elsewhere in the same segment (e.g. a commit
# message), but it never under-matches on global-flag placement, which is
# the security-relevant direction for a deny gate.
is_git_subcmd() {
  # $1: subcommand regex (e.g. push, merge, rebase)
  printf '%s' "$COMMAND" | grep -Eiq "\bgit\b[^;&|]*\b$1\b"
}

# Chain segment containing `git ... <word>`, used to inspect the destination
# ref precisely instead of loose substring matching.
git_segment_for() {
  printf '%s' "$COMMAND" | tr ';&|' '\n\n\n' | grep -Ei "\bgit\b.*\b$1\b" | head -n1
}

# Last whitespace-separated token of a command segment, quotes stripped —
# used to read the destination ref/refspec of a push precisely (last token,
# or the right-hand side of a <local>:<remote> refspec) rather than a loose
# substring match that would false-block e.g. `git push origin fix-main-config`.
last_token() {
  printf '%s' "$1" | sed -E 's/[[:space:]]+$//' | awk '{print $NF}' | sed -E "s/^[\"']//; s/[\"']\$//"
}

is_main_or_master_ref() {
  case "$1" in
    main|master) return 0 ;;
    *:main|*:master|*:refs/heads/main|*:refs/heads/master) return 0 ;;
    *) return 1 ;;
  esac
}

# 1. Push to main/master — destination ref, checked precisely.
if is_git_subcmd 'push'; then
  push_seg="$(git_segment_for push)"
  dest="$(last_token "$push_seg")"
  if is_main_or_master_ref "$dest"; then
    block "push to main/master is never allowed from an agent session. Push a side branch and open a PR."
  fi
  branch="$(current_branch)"
  if { [ "$branch" = "main" ] || [ "$branch" = "master" ]; } \
     && printf '%s' "$push_seg" | grep -Eq 'push([[:space:]]+(origin|upstream))?[[:space:]]*$'; then
    block "push to main/master is never allowed from an agent session (checked out on $branch)."
  fi
fi

# 2. Force push (--force / --force-with-lease / -f).
if is_git_subcmd 'push' && printf '%s' "$COMMAND" | grep -Eq -- '(--force(-with-lease)?\b|(^|[[:space:]])-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$))'; then
  block "force-push (--force/-f/--force-with-lease) is never allowed from an agent session."
fi

# 3. Merge into main/master.
if is_git_subcmd 'merge'; then
  if printf '%s' "$COMMAND" | grep -Eiq '\bmerge\b.*\b(main|master)\b'; then
    block "merging into main/master is never allowed from an agent session; the operator merges integration PRs."
  fi
  branch="$(current_branch)"
  if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
    block "git merge while checked out on $branch is never allowed from an agent session."
  fi
fi

# 4. Deploy commands (wrangler deploy/publish, pages publish).
if printf '%s' "$COMMAND" | grep -Eiq '\bwrangler\b.*\b(deploy|publish)\b' \
   || printf '%s' "$COMMAND" | grep -Eiq '\bpages\b.*\bpublish\b'; then
  block "deploy/publish commands require explicit operator approval; never autonomous."
fi

# 5. History rewrite on a protected branch: main/master, or a shared
#    smith/<epic>/integration branch (task branches smith/<epic>/<task-id>
#    with task-id != "integration" are exempt — rebase/amend there is the
#    sanctioned pre-merge-queue flow, worktree.yml). Branch shape is
#    smith/<epic>/integration, not bare smith/<epic>: a leaf ref
#    "smith/<epic>" cannot coexist with "smith/<epic>/<task-id>" refs in
#    real git (D/F ref conflict) — worktree.yml integration_branch.pattern.
branch="$(current_branch)"
if printf '%s' "$branch" | grep -Eq '^smith/[^/]+/integration$|^(main|master)$'; then
  if is_git_subcmd 'rebase' \
     || printf '%s' "$COMMAND" | grep -Eiq '\bcommit\b.*--amend\b' \
     || printf '%s' "$COMMAND" | grep -Eiq '\bfilter-(branch|repo)\b'; then
    block "history rewrite (rebase/amend/filter-branch) on protected branch '$branch' is never allowed."
  fi
fi

# 6. rm -rf (and equivalents) outside workspaces/ or state/ (guardrails.md).
#    Paths are normalized (repo-root-relative, symlink/`..`-resolved via
#    `realpath -m` when available) before the prefix check, so both
#    `rm -rf workspaces/x` and `rm -rf <repo-root>/workspaces/x` pass.
if printf '%s' "$COMMAND" | grep -Eq '(^|[;&|]|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive[[:space:]]+--force|--force[[:space:]]+--recursive)\b'; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '')"

  normalize_path() {
    local p="$1"
    if command -v realpath >/dev/null 2>&1; then
      p="$(realpath -m -- "$p" 2>/dev/null || printf '%s' "$p")"
    fi
    if [ -n "$REPO_ROOT" ]; then
      case "$p" in
        "$REPO_ROOT"/*) p="${p#"$REPO_ROOT"/}" ;;
        "$REPO_ROOT") p="." ;;
      esac
    fi
    printf '%s' "${p#./}"
  }

  out_of_bounds=0
  rm_args="$(printf '%s' "$COMMAND" | grep -Eo 'rm[[:space:]]+[^;&|]*' | head -n1 | sed -E 's/^rm[[:space:]]+//')"
  for tok in $rm_args; do
    case "$tok" in
      -*) continue ;;
    esac
    path="$(normalize_path "$tok")"
    case "$path" in
      workspaces/*|workspaces|state/*|state) ;;
      *) out_of_bounds=1 ;;
    esac
  done
  if [ "$out_of_bounds" -eq 1 ]; then
    block "rm -rf is only allowed inside workspaces/ or state/."
  fi
fi

exit 0
