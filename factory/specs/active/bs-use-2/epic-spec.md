# Epic spec — `bs-use-2`

- **Epic id:** `bs-use-2`
- **Plan:** `factory/specs/active/bs-use-2/plan-draft.json`, plan version 1,
  status `draft`. Nothing dispatches until the operator signs it off.
- **Effort tier:** `small` (`factory/policies/effort.yml`; epic cap 4,000,000
  tokens, alarm at 70%). Single-pass spec review, no pre-code research.
- **Project:** `blacksmith` (this clone). Base `0e845840`.
- **Follows:** epic `bs-use` (`factory/specs/active/bs-use/`). Everything that
  epic fixed still holds.

## Goal

`/bs use <name>` and `/bs use <path>` bind a Claude Code session to a project
the factory manages, including a project declared only in **its own overlay
roadmap** (`<checkout>/.blacksmith/factory/specs/roadmap.md`) and not in the
factory clone's `factory/specs/roadmap.md`.

Today both forms answer `that name is not a project this factory knows`:
`knownProjectNames` (`sessionBinding.ts`) reads only the hook context's
roadmap, which in a clone is always the clone's own. The overlay fallback
already exists as rule M4 in `promptCapture.ts` (`overlayRoadmapAt`,
`declaredAs`), but it is module-private and serves store resolution only.

## Decisions taken by the operator (fixed)

1. Both forms bind: a bare name, and a path to the checkout (relative such as
   `../<dir>`, absolute, or `~/…`).
2. The fix is generic. No real project name in code, tests, docs, fixtures or
   this spec: placeholders only (`project-a`, `project-b`, `<project>`,
  `nothing-here`; `dir-x` only as a directory name or resolver argument). The
   factory's own name and its legacy spelling are imported from
   `projectName.ts`, never typed.
3. The project is not added to the clone's roadmap; the fix reads the
   project's own overlay roadmap.
4. `bs-use` still holds: nothing blocks, the hook alone writes
   `session-bound`, a binding records a project **name**.
5. Tier `small`, built through `/bs plan` then `/bs run`.

## Design this plan commits to

- **Known projects** = today's `factoryProjects` list for the context roadmap
  **plus**, for each directory directly under the same two roots
  (`resolveProjectsDir(...)`, `<workRoot>/workspaces`), the name its own
  overlay roadmap gives that directory by the M4 dir-match rule
  (`declaredAs(dir, overlayRoadmapAt(dir), roots)`: a declared name counts only
  when its checkout under the roots realpaths to that same directory). Other
  `- project:` bullets in a foreign overlay are never added. Entries are read
  `readdirSync(root).sort()`, roots in their fixed order, so the known list
  and the kept entry are the same on macOS and Linux.
- **Plain segment.** An overlay-derived name counts only when it is one plain
  path segment (no `/` or `\`, not `.` or `..`) equal to the root entry's
  name (the directory name under the root, before realpath). A foreign
  overlay is text somebody else wrote, so nothing path-like from it reaches
  the known list, the reminder line or a recorded binding.
- **Dedupe:** an overlay-derived name whose `normalizeProjectName` equals a
  name already known is dropped; the clone's spelling and directory win.
- **Excluded:** the context `repoRoot` (realpath) and any `isFactoryCheckout`
  directory are not scanned for an overlay.
- **Path argument:** an argument that contains `/` or starts with `.` or `~`
  is a path. `~` and `~/…` resolve against `env.HOME` of the hook context
  only when HOME is a non-empty absolute path (absent, empty or relative
  HOME: no match; never `os.homedir()`), anything else against the
  hook's cwd; the result is realpath'd (raw on failure) and matched against
  the realpath of each known project's directory, including the clone itself
  (its name is the factory's). The binding records the matched **name**. No
  match gives the unknown lines. `~user/…` and paths with spaces are not
  supported (`parseUseCommand` reads one `\S+` token).
- **One resolver.** `sessionBinding.ts` gains
  `resolveUseProject(arg: string | null, input) -> { known: string[]; matched: string | undefined }`
  over a `knownProjectRefs(input)` list of `{ name, dir }`;
  `knownProjectNames(input)` keeps its signature and returns those names. The
  binding write in `promptCapture.ts` and the reply in `bindingReminder.ts`
  both call `resolveUseProject` and nothing else to decide, so they cannot
  disagree.
- **Where the helpers go.** `overlayRoadmapAt`, `declaredAs` (and the
  `realOr` they need) move from `promptCapture.ts` into `sessionBinding.ts`
  as exports; rule M4 imports them from there. Why not `projects.ts` or a new
  module: `promptCapture.ts` already imports `sessionBinding.js`, and
  `sessionBinding.ts` imports neither `promptCapture.js` nor
  `bindingReminder.js`, so no cycle is added; `projects.ts` would push the
  claim set past `size.small`'s 10 paths; a new module would have to join the
  names scan's `ADDED` list before it exists. `sessionBinding.ts` stays
  hook-light (no db, cli or usage imports).
- **Cost.** The scan (one `readdirSync` per root, one `existsSync` per entry,
  one roadmap read per overlay found) runs only when the prompt is a
  `/bs use` command. Both call sites already call `knownProjectNames` only
  after `parseUseCommand` returned non-null (`promptCapture.ts` ~330,
  `bindingReminder.ts` ~93); the plan keeps it so. Rule M4's per-prompt cost
  is unchanged.
- **Names scan.** `sessionBindingNames.test.ts` reads `/bs use` arguments
  with `[A-Za-z0-9<>_.-]+`, so `/bs use ../project-a` reads as `..` and fails.
  The reader widens to path characters (`/`, `~`); a path argument passes when
  every segment before the last is `.`, `..` or `~` and the last is in the
  allowed set. Any other path, including `/abs/…`, a trailing slash and
  `../<dir>`, is flagged. The allowed sets do not grow: `project-c` is not
  used (a foreign bullet names `project-a` inside `project-b`'s overlay
  instead). Every source and test file this epic edits is already in `ADDED`
  or `EDITED`; `CHANGELOG.md` joins `EDITED`.
- **Scan order across tasks (shape b).** task-1 runs beside task-3, so every
  literal in task-1's files passes the scan as it stands at the base sha: no
  `/bs use` text followed by a path (its tests call `resolveUseProject` with
  the bare argument), no new `/bs use` argument or quoted `project:` value,
  fixture bullets written through an interpolated `- project: ${name}`
  template, which the scan skips. Only task-2, after task-3, types
  `/bs use ../project-b`. Folding the widening into task-1 instead (shape a)
  would push task-1 past its 350-line cap.

## Acceptance criteria

Each criterion names its task. "Before" is what the failing test observes at
the base sha; "after" is what it observes with the fix.

1. **Overlay name known** (task-1). Temp tree: clone `base/clone` whose
   roadmap declares no other project, and
   `base/project-b/.blacksmith/factory/specs/roadmap.md` declaring
   `project-b` and `project-a` (`base/project-a` exists, with no overlay of
   its own). Before: `knownProjectNames` lacks `project-b`. After: it holds
   every name it held before plus `project-b`, and still not `project-a`.
2. **Dedupe, exclusions, plain segment, order** (task-1). A name declared in
   both the clone roadmap and its checkout's own overlay appears once, in the
   clone's spelling; an overlay directory named by the imported legacy
   factory spelling and declaring that spelling adds nothing (the factory
   name appears exactly once, the legacy spelling never); the context
   `repoRoot` carrying an overlay roadmap adds nothing; a missing root, a
   plain file under a root, a directory with no overlay, and an overlay that
   is unparseable or declares only other projects add nothing and never
   throw. A symlink under a root pointing at an overlay checkout elsewhere
   makes its name known once. `base/project-b` whose overlay declares only
   path-like spellings of its name (`./project-b`, `project-b/../project-b`,
   `project-b/`) adds nothing and does not resolve as a path. Out of scope,
   pinned: `base/dir-x` whose overlay declares only `project-a` (with
   `base/project-a` absent, and again with it present and overlay-less) adds
   neither name, and stays unmatched by name (`dir-x`) and by path
   (`../dir-x`). Overlay checkouts created as `project-b` then `project-a`
   list `project-a` first.
3. **Path resolves to a name** (task-1). `resolveUseProject` returns
   `matched: 'project-b'` for `../project-b` (cwd `base/clone`), for the
   absolute path, for `~/project-b` with `env.HOME = base`, for a trailing
   slash, and for both the symlink and its target; `matched` is the factory
   name for the absolute path of the imported `REPO_ROOT` (the self entry's
   directory); `matched` is `undefined` for a path to an existing directory
   that is not known, for a non-existent path, for `~/project-b` with HOME
   absent, for `~/../project-b` with HOME empty, and for `~/project-b` with
   HOME `..` (cwd `base/clone`: a cwd-anchored fallback would match
   `project-b` on the last two, so they fail on that bug). A bare name resolves exactly as
   `matchProject(name, known)` does today, and `known` equals
   `knownProjectNames(input)`.
4. **Capture writes the binding** (task-2). `capturePrompt` in a temp store
   on `/bs use project-b`, `/bs use ../project-b`, the absolute path (built
   with `path.join`) and `/bs use ~/project-b` each appends exactly one
   `session-bound` event whose `payload.project` is `project-b`. Before: none
   is appended. `/bs use ../nothing-here` and the overlay's foreign bullet
   name (`/bs use project-a`) append none.
5. **Reply agrees** (task-2). `bindingReminder` on the same prompts, after
   the capture, returns no unknown-name line and returns the standing lines
   naming `project-b` (before: the unknown lines whose known list omits
   `project-b`). On an unknown name or path it returns the unknown lines and
   their known list includes `project-b`. One table-driven test asserts, per
   prompt, that a `session-bound` event was written exactly when the reply has
   no unknown-name line.
6. **One resolver, hook-light, M4 unchanged** (task-1 moves the helpers and
   pins the imports, task-2 wires the sites and pins them). Outside tests,
   `resolveUseProject` has exactly two call sites, each reached only when
   `parseUseCommand` returned non-null; neither site calls
   `knownProjectNames` or `matchProject` for `/bs use` any more.
   `sessionBinding.ts` imports no db, cli, usage, `promptCapture` or
   `bindingReminder` module. Rule M4 imports `declaredAs` and
   `overlayRoadmapAt` from `sessionBinding.js`, and the existing M4 tests pass
   unchanged. Both halves are source-scan tests that can fail:
   `sessionBinding.test.ts` (task-1) fails naming any such import specifier;
   `bindingReminder.test.ts` (task-2) fails naming the file if
   `resolveUseProject(` is called anywhere but once in each call site, or if a
   call site still calls `knownProjectNames(` or `matchProject(`. Each is
   proven by mutation in its hand-back. (`promptHookEntry.test.ts` checks
   only the built hook for drizzle/sqlite specifiers, so it covers neither.)
7. **Names scan reads paths** (task-3). The scan's inline samples prove
   `/bs use ../project-a`, `/bs use ~/project-b`, `/bs use ./<project>`,
   `/bs use ~/<project>` and `/bs use ../nothing-here` pass, and
   `/bs use ../bad-one`, `/bs use /abs/bad-two` and `/bs use ../<dir>` are
   flagged by value; the allowed sets are unchanged; `CHANGELOG.md` is in
   `EDITED`; the scan passes over every listed file at the task's tree.
8. **Documented** (task-3). `.claude/skills/bs/use.md` says a path to the
   checkout binds the same way as its name (written `/bs use ../<project>` or
   `/bs use ~/<project>`; an absolute path named in words, never as a
   literal), and that a project declared only in its own overlay roadmap is
   known; `CHANGELOG.md` `## Unreleased` `### Fixed` records the fix under the
   same wording rule. Placeholders only.
9. **Gates** (every task). From the repo root: `pnpm run test` (full suite),
   `pnpm run typecheck`, `pnpm run typecheck:test`, `pnpm biome check .`, all
   green on the task's own tree, in either merge order inside wave 1.

## Out of scope

- Adding the project to the clone's roadmap, or any write to an overlay.
- A checkout whose directory name differs from its declared name. M4's
  dir-match rule finds a checkout by name under the roots, so such a
  checkout stays unknown here exactly as it is unbound by M4 today.
- Checkouts deeper than one level under the roots, or outside them.
- `~user/…` and paths with spaces.
- Any change to M1/M2/M3 store resolution, the reminder text, the bypass flow
  or the dashboard.

## Claims map and round shape

| Task | Claims | Depends on |
| --- | --- | --- |
| task-1 resolver | `sessionBinding.ts`, `promptCapture.ts`, `test/sessionBinding.test.ts` | — |
| task-3 scan + docs | `test/sessionBindingNames.test.ts`, `.claude/skills/bs/use.md`, `CHANGELOG.md` | — |
| task-2 call sites | `promptCapture.ts`, `bindingReminder.ts`, `test/promptCaptureBinding.test.ts`, `test/bindingReminder.test.ts` | task-1, task-3 |

Nine distinct paths, three tasks: inside `size.small`. Wave 1 runs task-1 and
task-3 together; wave 2 runs task-2. Task-2 waits on task-1 for the new
exports and the moved helpers (both touch `promptCapture.ts`), and on task-3
because its tests type `/bs use ../project-b`, which the scan at the base sha
flags. task-1 types no such literal (shape b above), so wave 1 is green in
either merge order.

## Open questions

None blocking. The directory-name-differs case above is a deliberate
non-goal; if the operator's checkout is named differently from its declared
name, this epic does not bind it and a follow-up would need a different match
rule for M4 and `/bs use` together.
