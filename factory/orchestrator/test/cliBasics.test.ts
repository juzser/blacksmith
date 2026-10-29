import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_PATH, runCli } from './helpers/cliHarness.js';
import { assertExited, runProcess } from './helpers/process.js';

// Part of the former cli.test.ts, split along its describe blocks so vitest runs
// the parts on separate workers. cli.ts is thin argv->module wiring (excluded from
// the coverage floor, like UI glue per stack.md); it is verified end-to-end here
// as a built binary, the way it actually runs (`smith <ns> <action> ...`).
// Shared harness: helpers/cliHarness.ts.

describe('cli.ts (built binary)', () => {
  let scratchDir: string;

  // dist/ is built once for the whole run by test/globalSetup.ts, not here:
  // guardHook.test.ts execs the same binary, and two parallel vitest workers
  // emitting into one dist/ while a third reads it is a race. Each file of the
  // old single cli.test.ts now owns its scratch directory, so none depends on
  // another having run first.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it('plan validate: exits 0 and reports valid:true for a good plan', async () => {
    const planPath = path.join(scratchDir, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [
          {
            task_id: 'epic-1/task-1',
            epic_id: 'epic-1',
            plan_version: 1,
            objective: 'Do the thing.',
            output_schema_ref: 'result.schema.json',
            acceptance_criteria: ['it works'],
            claims: ['src/foo/**'],
            budget: { tokens: 1000, diff_lines: 100 },
            contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
          },
        ],
        edges: [],
      }),
    );

    const { stdout, status } = runCli(['plan', 'validate', planPath]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ valid: true });
  });

  it('plan validate: exits 1 and reports errors for a bad plan', async () => {
    const planPath = path.join(scratchDir, 'bad-plan.json');
    await writeFile(
      planPath,
      JSON.stringify({ epic_id: 'epic-1', version: 1, status: 'active', tasks: [{}], edges: [] }),
    );

    const { stdout, status } = runCli(['plan', 'validate', planPath]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('unknown command exits 1 with an error envelope', () => {
    const { stdout, status } = runCli(['not', 'a-command']);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain('Unknown command');
  });

  // P9-21: `smith` and `smith --help` both answered `{"error":{"message":
  // "Unknown command: "}}`, so every command's argument shape had to be read
  // out of cli.ts or SKILL.md.
  describe('usage', () => {
    it('--help exits 0 and prints the command list on stdout', () => {
      const { stdout, status } = runCli(['--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('bs plan validate <plan.json>');
      expect(stdout).toContain('gate run');
      expect(stdout).toContain('stats providers');
    });

    it('bare `smith` exits 1 with the same text, on stderr', () => {
      const help = runCli(['--help']);
      const bare = runCli([]);
      expect(bare.status).toBe(1);
      expect(bare.stderr).toBe(help.stdout);
    });

    it('an unknown command prints usage on stderr and keeps the JSON envelope on stdout', () => {
      // Prose on stderr so a human sees it; stdout stays parseable for the
      // callers that already read the error envelope.
      const { stdout, stderr, status } = runCli(['not', 'a-command']);
      expect(status).toBe(1);
      expect(stderr).toContain('bs plan validate <plan.json>');
      expect(JSON.parse(stdout).error.message).toContain('Unknown command: not a-command');
    });

    it('an unknown action under a real namespace names that namespace', () => {
      const { stdout, stderr, status } = runCli(['plan', 'teleport']);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.message).toContain('Unknown command: plan teleport');
      expect(stderr).toContain('plan validate');
      expect(stderr).not.toContain('gate run');
    });

    it('`smith <ns> --help` lists only that namespace, exit 0', () => {
      const { stdout, status } = runCli(['plan', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('plan quorum');
      expect(stdout).not.toContain('gate run');
    });

    it('`smith help` is the same as `smith --help`', () => {
      expect(runCli(['help']).stdout).toBe(runCli(['--help']).stdout);
    });

    it('--help on a real command shows that command, not the whole list', () => {
      const { stdout, status } = runCli(['gate', 'run', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('bs gate run');
      expect(stdout).not.toContain('plan validate');
    });

    it('a missing positional names the argument and prints the line that would have worked', () => {
      const { stdout, status } = runCli(['plan', 'validate']);
      expect(status).toBe(1);
      const err = JSON.parse(stdout).error;
      expect(err.code).toBe('cli.missing-positional');
      expect(err.message).toContain('<plan.json>');
      expect(err.message).toContain('bs plan validate <plan.json>');
    });
  });

  // bs-rename, operator decision 3: `smith` keeps working as a deprecated
  // alias of `bs`, both pointing at this same built cli.js -- npm/pnpm's
  // `bin` field makes each an unextended symlink literally named after the
  // key, which is what these recreate directly rather than trusting a real
  // `pnpm install` to have run.
  describe('smith/bs alias (bs-rename)', () => {
    it('invoked as `smith` behaves identically but adds one deprecation line on stderr', async () => {
      const legacyPath = path.join(scratchDir, 'smith');
      await symlink(CLI_PATH, legacyPath);
      const viaBs = runCli(['--help']);
      const viaSmith = runProcess('node', [legacyPath, '--help']);
      assertExited(viaSmith, 'smith --help (legacy alias)');
      expect(viaSmith.status).toBe(viaBs.status);
      // stdout is parsed as JSON by playbooks in other commands, so the
      // deprecation notice must never land there, only on stderr.
      expect(viaSmith.stdout).toBe(viaBs.stdout);
      const lines = viaSmith.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('smith');
      expect(lines[0]).toContain('bs');
      expect(lines[0]?.toLowerCase()).toContain('deprecat');
    });

    it('invoked as `bs` prints no deprecation line', async () => {
      const currentPath = path.join(scratchDir, 'bs');
      await symlink(CLI_PATH, currentPath);
      const run = runProcess('node', [currentPath, '--help']);
      assertExited(run, 'bs --help');
      expect(run.stderr).toBe('');
    });
  });

  it('plan quorum: rejects an unparseable --confidence instead of failing open', () => {
    // NaN < threshold is false, so a typo'd confidence would silently disable
    // plan_quorum's third trigger rather than firing it (planQuorum.ts).
    const { stdout, status } = runCli([
      'plan',
      'quorum',
      '--epic',
      'epic-1',
      '--plan-version',
      '1',
      '--confidence',
      '0,7',
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain('--confidence must be a number');
  });

  it('plan quorum: critiques the plan version it logs, not a second reading of the flag', () => {
    // D-211. `plan quorum` read --plan-version twice with two parsers that
    // disagree: Number.parseInt chose the plan FILE, boundedIntFlag (via
    // eventContextFromFlags) chose the plan_version stamped on every event the
    // command appends. D-210's rule for the same notation is asserted below in
    // the --round block -- "1e2 is an unambiguous numeric literal for 100" --
    // so `--plan-version 1e2` critiqued v1 while the log said v100, and nothing
    // errored. The file it goes looking for is the observable half.
    const { stdout, status } = runCli([
      'plan',
      'quorum',
      '--epic',
      'epic-no-such-plan',
      '--plan-version',
      '1e2',
      '--session',
      'cli-plan-quorum-version',
      '--causal-parent',
      'root',
    ]);
    expect(status).toBe(1);
    const err = JSON.parse(stdout).error;
    expect(err.code).toBe('plan.not-found');
    expect(err.details.version).toBe(100);
    expect(err.message).toContain('plan-v100.json');
  });

  // FD-45 / FD-49. plan.md step 4 critiques the plan
  // before step 6 files it as plan-v1.json, so the verb has to take the draft
  // by path; and its output -- three rationales of several kB each -- is read
  // back from a file more often than from a terminal.
  describe('plan quorum: a draft by path, an outcome to a file (FD-45, FD-49)', () => {
    function draftPlan(epicId: string, version = 1) {
      return {
        epic_id: epicId,
        version,
        status: 'draft',
        tasks: [
          {
            task_id: `${epicId}/task-1`,
            epic_id: epicId,
            plan_version: version,
            objective: 'Do the thing.',
            output_schema_ref: 'result.schema.json',
            acceptance_criteria: ['it works'],
            claims: ['src/foo/**'],
            budget: { tokens: 100, diff_lines: 10, max_turns: 5 },
            contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
          },
        ],
        edges: [],
      };
    }

    async function quorumFixture(name: string) {
      const dir = path.join(scratchDir, `plan-quorum-${name}`);
      const eventsDir = path.join(dir, 'events');
      const specsDir = path.join(dir, 'specs');
      await mkdir(specsDir, { recursive: true });
      const draft = path.join(dir, 'draft.json');
      await writeFile(draft, JSON.stringify(draftPlan('epic-fd45'), null, 2));
      const sessionId = `cli-plan-quorum-${name}`;
      expect(runCli(['session', 'start', sessionId, '--state-dir', eventsDir]).status).toBe(0);
      const envelope = [
        '--plan-version',
        '1',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
        '--specs-dir',
        specsDir,
      ];
      return { dir, eventsDir, specsDir, draft, sessionId, envelope };
    }

    it('--plan <path> critiques the named draft when no plan-v<n>.json exists, and files nothing', async () => {
      const f = await quorumFixture('draft');
      const { stdout, status } = runCli(['plan', 'quorum', '--plan', f.draft, ...f.envelope]);
      expect(status).toBe(0);
      const outcome = JSON.parse(stdout);
      expect(outcome).toMatchObject({ outcome: 'endorsed', epicId: 'epic-fd45', version: 1 });
      // The record names the draft's epic, read from the file, not from a flag
      // the operator had to repeat.
      const tail = runCli(['event', 'tail', f.sessionId, '--state-dir', f.eventsDir, '--n', '10']);
      const decisions = (
        JSON.parse(tail.stdout) as Array<{
          record: { event_type: string; payload: { task_id?: string } };
        }>
      )
        .map((e) => e.record)
        .filter((r) => r.event_type === 'quorum-decision');
      expect(decisions.map((r) => r.payload.task_id)).toEqual(['epic-fd45/plan-v1']);
      expect(existsSync(path.join(f.specsDir, 'epic-fd45'))).toBe(false);
    });

    it('--plan <path> refuses a draft whose epic_id or version is not the one the envelope names', async () => {
      const f = await quorumFixture('mismatch');
      const wrongEpic = runCli([
        'plan',
        'quorum',
        '--plan',
        f.draft,
        '--epic',
        'epic-other',
        ...f.envelope,
      ]);
      expect(wrongEpic.status).toBe(1);
      expect(JSON.parse(wrongEpic.stdout).error.code).toBe('plan.identity-mismatch');

      const v2 = path.join(f.dir, 'draft-v2.json');
      await writeFile(v2, JSON.stringify(draftPlan('epic-fd45', 2), null, 2));
      const wrongVersion = runCli(['plan', 'quorum', '--plan', v2, ...f.envelope]);
      expect(wrongVersion.status).toBe(1);
      const err = JSON.parse(wrongVersion.stdout).error;
      expect(err.code).toBe('plan.identity-mismatch');
      expect(err.message).toContain('version 2');
      expect(err.message).toContain('--plan-version 1');
    });

    it('--out <file> writes the outcome it prints, creating the directory, and still prints it', async () => {
      const f = await quorumFixture('out');
      const out = path.join(f.dir, 'nested', 'quorum-1.json');
      const { stdout, status } = runCli([
        'plan',
        'quorum',
        '--plan',
        f.draft,
        '--out',
        out,
        ...f.envelope,
      ]);
      expect(status).toBe(0);
      const printed = JSON.parse(stdout);
      expect(printed.outcome).toBe('endorsed');
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(printed);
    });

    it('without --plan, --epic is still required', () => {
      const { stdout, status } = runCli(['plan', 'quorum', '--plan-version', '1']);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('cli.missing-flag');
    });

    it("--project: reads the project overlay's provider, same as `epic verdict`/`judge preflight` (D-42)", async () => {
      // `plan quorum` has no --policy override at all (unlike judge preflight):
      // it always reads the shipped factory/policies/crosscheck.yml, so this
      // test can't swap in a throwaway policy file the way the crossfind test
      // above does -- the overlay has to override an existing provider's
      // fields instead of inventing a new one. A brand-new provider name
      // parses fine at parseCrosscheckPolicy() (the merge is a union of
      // policy/env/overlay provider NAMES), but every attempted provider --
      // success or failure -- flows through runQuorumCase's recordJudgeRun,
      // which emits a `dispatch_decision` event whose `provider` field is
      // validated against factory/policies/taxonomy.yml's closed enum
      // `[claude, codex, deepseek]`. An unrecognised name fails that
      // validation and the CLI exits 1, so the overlay below reuses
      // `deepseek` (already `transport: api` in the shipped policy) and
      // overrides its endpoint/model/key fields, the same trick the
      // judge-preflight --project test above plays with `ds`.
      //
      // --confidence below plan_quorum.confidence_threshold (0.8 in the
      // shipped policy) fires trigger 3, so providers.length is actually
      // evaluated instead of short-circuiting at triggers.length === 0.
      //
      // test/setup.ts sets SMITH_CROSSCHECK_OFFLINE for the whole suite, but
      // the offline switch forces EVERY non-native provider off regardless of
      // configSource (crosscheck.ts's merge loop) -- including an
      // overlay-added one -- so it has to come off here, same as the
      // crossfind --project test above. With it off, this box's shipped
      // policy would otherwise reach real providers: codex is `enabled: auto`
      // and genuinely on PATH on a dev box with `codex login` run, and
      // deepseek is `enabled: auto` gated on a real DEEPSEEK_API_KEY. Both
      // are neutralized below by their own preconditions (PATH stripped of
      // codex's directory, DEEPSEEK_API_KEY blanked) rather than by policy
      // edits, and OPENROUTER_API_KEY is blanked too so neither silently
      // substitutes via OpenRouter instead (crosscheck.ts's
      // shouldSubstituteViaOpenrouter) -- so this stays exactly as offline as
      // the blanket switch, but only for the shipped policy's own providers,
      // not for the one the overlay adds.
      const pathWithoutCodex = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir.length > 0 && !existsSync(path.join(dir, 'codex')))
        .join(path.delimiter);
      const neutralizeRealProviders = {
        SMITH_CROSSCHECK_OFFLINE: '',
        PATH: pathWithoutCodex,
        DEEPSEEK_API_KEY: '',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODELS: '',
      };

      const baseline = await quorumFixture('project-baseline');
      const withoutProject = runCli(
        ['plan', 'quorum', '--plan', baseline.draft, '--confidence', '0.5', ...baseline.envelope],
        neutralizeRealProviders,
      );
      expect(withoutProject.status).toBe(0);
      const withoutProjectOutcome = JSON.parse(withoutProject.stdout);
      expect(withoutProjectOutcome.triggers.length).toBeGreaterThan(0);
      expect(withoutProjectOutcome.endorsedBy).toBe('default-no-provider');
      // Every shipped provider is neutralized above, so nothing runs and no
      // quorum is ever computed -- the baseline this test's --project half
      // has to differ from.
      expect(withoutProjectOutcome.quorum).toBeUndefined();

      const projectDir = path.join(scratchDir, 'plan-quorum-project-overlay');
      await mkdir(path.join(projectDir, '.blacksmith'), { recursive: true });
      await writeFile(
        path.join(projectDir, '.blacksmith', 'crosscheck.yml'),
        [
          'providers:',
          '  deepseek:',
          '    enabled: true',
          '    mode: shadow',
          '    base_url: https://example.invalid',
          '    model: test-model',
          '    api_key_env: SMITH_TEST_KEY_THAT_IS_NEVER_SET',
          '',
        ].join('\n'),
      );

      const overlay = await quorumFixture('project-overlay');
      const withProject = runCli(
        [
          'plan',
          'quorum',
          '--plan',
          overlay.draft,
          '--confidence',
          '0.5',
          '--project',
          projectDir,
          ...overlay.envelope,
        ],
        neutralizeRealProviders,
      );
      expect(withProject.status).toBe(0);
      const withProjectOutcome = JSON.parse(withProject.stdout);
      // Still no ACTIVE judge (the overlay drives deepseek into shadow mode
      // and its call fails before it ever reaches the network -- see below),
      // so the gating decision is unchanged. What proves the CLI actually
      // threaded --project through to runPlanQuorum() is that a quorum ran at
      // all: without --project, deepseek stays disabled (its shipped
      // `enabled: auto` can't satisfy DEEPSEEK_API_KEY, blanked above) and no
      // quorum is computed at all (see withoutProjectOutcome above); with it,
      // the overlay's `enabled: true` overrides that regardless of
      // precondition (crosscheck.ts's parseProvider only gates 'auto').
      expect(withProjectOutcome.endorsedBy).toBe('default-no-provider');
      expect(withProjectOutcome.quorum).toBeDefined();
      const overlayParticipant = withProjectOutcome.quorum.participants.find(
        (p: { provider: string }) => p.provider === 'deepseek',
      );
      expect(overlayParticipant).toBeDefined();
      // resolveApiKey() throws before any fetch when the env var is unset
      // (providers/api-transport.ts), so this proves the overlay provider was
      // actually attempted, offline and deterministically.
      expect(overlayParticipant).toMatchObject({ mode: 'shadow', ok: false, verdict: null });
      expect(overlayParticipant.rationale).toContain('SMITH_TEST_KEY_THAT_IS_NEVER_SET');
    });
  });

  // P9-28: `cli.ts` validated flags with requireFlag and positionals not at
  // all — `positional[0] as string` is a cast, not a check. The worst of it was
  // `event tail` with no session id: it printed `[]` and exited 0, so *you
  // forgot the argument*, *no such session* and *the session is empty* were one
  // observable state, and it was the success one. The verb an operator reaches
  // for when unsure what the log holds answered "your log is empty".
  describe('a missing argument must fail, not succeed empty (P9-28)', () => {
    it('event tail with no session id names the argument instead of printing []', () => {
      const { stdout, status } = runCli(['event', 'tail']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('session-id');
      expect(parsed.error.message).toContain('bs event tail');
    });

    it('event tail on a session that has no log is an error, not an empty array', () => {
      const eventsDir = path.join(scratchDir, 'events');
      const { stdout, status } = runCli([
        'event',
        'tail',
        'no-such-session-p9-28',
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('events.unknown-session');
      expect(parsed.error.message).toContain('no-such-session-p9-28');
    });

    it('plan validate with no plan file reports the usage, not a filesystem error', () => {
      const { stdout, status } = runCli(['plan', 'validate']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('plan.json');
    });

    it('worktree stale names the one positional that is missing, not both', () => {
      const { stdout, status } = runCli(['worktree', 'stale', '/tmp/some-project']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      // The usage line names both, as it should; what must name only the
      // missing one is the error itself.
      expect(parsed.error.details.missing).toEqual(['epic']);
      expect(parsed.error.message).toContain('bs worktree stale <project-dir> <epic>');
    });

    it('findings transition reports the missing positional before the missing flag', () => {
      // Argument order is the reading order: a usage error should name the
      // first thing wrong on the line, and the positionals come first.
      const { stdout, status } = runCli(['findings', 'transition', 'F-1']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('status');
      expect(parsed.error.details.missing).toEqual(['status']);
      // --session is missing too, and since P9-21 the usage line names it —
      // which is the point of printing the flags. What must not happen is
      // reporting the flag as THE error while a positional is still absent.
      expect(parsed.error.message).not.toContain('Missing required flag');
    });

    // D-136. Both amendment edges need an argument the command line has no way
    // to carry — `amendsTaskIds` for one, `amendsSatisfiedBy` for the other —
    // so every invocation naming them failed five guards deep, with a message
    // about task ids the operator was never offered a way to name. It read as
    // a bug in the command rather than as a command that cannot do this.
    describe('findings transition: the amendment edges are not typeable (D-136)', () => {
      it('refuses amend-pending by naming the command that can take it', () => {
        const { stdout, status } = runCli(['findings', 'transition', 'F-1', 'amend-pending']);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('cli.amendment-edge-unreachable');
        expect(parsed.error.message).toContain('bs plan amend');
        expect(parsed.error.details.status).toBe('amend-pending');
      });

      it('refuses amended by naming the command that can take it', () => {
        const { stdout, status } = runCli(['findings', 'transition', 'F-1', 'amended']);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('cli.amendment-edge-unreachable');
        expect(parsed.error.message).toContain('bs epic close');
      });

      it('refuses before it reads the log, and writes nothing', () => {
        // A full, well-formed command line against a real session. The refusal
        // is about the command, not about the finding — which is why it fires
        // for a finding id no log contains, and why the log is untouched after.
        const sessionId = `cli-d136-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-d136');
        const start = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'user',
            event_type: 'session-start',
            plan_version: 1,
            causal_parent: null,
            payload: {},
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(start.status).toBe(0);
        const parent = JSON.parse(start.stdout).event_id as string;

        const { stdout, status } = runCli([
          'findings',
          'transition',
          'no-such-finding',
          'amend-pending',
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('cli.amendment-edge-unreachable');

        const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
        expect(JSON.parse(tail.stdout)).toHaveLength(1);
      });

      it('still moves a finding along an edge the command line CAN carry', () => {
        // The refusal is scoped to the two amendment edges; the rest of the
        // transition table stays reachable, or this fix would be a regression
        // dressed as a correction.
        const sessionId = `cli-d136-ok-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-d136-ok');
        const append = (event: Record<string, unknown>): string => {
          const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
          expect(run.status, run.stdout).toBe(0);
          return JSON.parse(run.stdout).event_id as string;
        };
        const parent = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: parent,
          payload: {
            finding_id: 'f-d136',
            fingerprint: 'fp-d136',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            summary: 'a finding on the ordinary path',
            failure_scenario: {
              inputs: 'foo("")',
              expected: 'a parse error',
              actual: 'undefined',
            },
            found_by: 'reviewer',
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'transition',
          'f-d136',
          'confirmed',
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          eventsDir,
        ]);
        expect(status, stdout).toBe(0);
        const printed = JSON.parse(stdout);
        expect(printed.finding_status).toBe('confirmed');
        // #286: the printed record carries the event_id of the
        // finding-transitioned event it just appended, so a chained
        // transition can pass it straight to `--causal-parent`.
        const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
        const transitioned = JSON.parse(tail.stdout).find(
          (e: { record: { event_type: string } }) => e.record.event_type === 'finding-transitioned',
        );
        expect(printed.event_id).toBe(transitioned.event_id);
      });
    });

    // D-21 Part 4: the CLI wiring for repairObligation -- a fresh session
    // built the same way the D-136 fixture above is, so this exercises the
    // real dispatch (namespace/action, flag parsing) rather than the library
    // function directly.
    describe('task reinstate', () => {
      it('puts a merged, superseded task back to completed and refuses a never-merged one', () => {
        const sessionId = `cli-reinstate-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-reinstate');
        const append = (event: Record<string, unknown>): string => {
          const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
          expect(run.status, run.stdout).toBe(0);
          return JSON.parse(run.stdout).event_id as string;
        };
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        for (const id of ['epic-1/task-1', 'epic-1/task-2']) {
          append({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-added',
            task_id: id,
            plan_version: 1,
            causal_parent: root,
            payload: { epic_id: 'epic-1', task_id: id, task_status: 'todo' },
          });
        }
        append({
          session_id: sessionId,
          actor: 'system',
          event_type: 'wave-merged',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: { task_ids: ['epic-1/task-1'] },
        });
        for (const id of ['epic-1/task-1', 'epic-1/task-2']) {
          append({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-superseded',
            task_id: id,
            plan_version: 1,
            causal_parent: root,
            payload: { epic_id: 'epic-1', task_id: id },
          });
        }
        const flags = ['--session', sessionId, '--causal-parent', root, '--state-dir', eventsDir];

        const ok = runCli(['task', 'reinstate', 'epic-1/task-1', '--reason', 'dropped', ...flags]);
        expect(ok.status, ok.stdout + ok.stderr).toBe(0);
        expect(JSON.parse(ok.stdout)).toMatchObject({ taskId: 'epic-1/task-1' });

        const refused = runCli(['task', 'reinstate', 'epic-1/task-2', '--reason', 'x', ...flags]);
        expect(refused.status).not.toBe(0);
        expect(refused.stdout + refused.stderr).toContain('task.reinstate-never-merged');
      });
    });

    describe('findings repair-obligation (D-21 Part 4)', () => {
      function appendVia(eventsDir: string) {
        return (event: Record<string, unknown>): string => {
          const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
          expect(run.status, run.stdout).toBe(0);
          return JSON.parse(run.stdout).event_id as string;
        };
      }

      it('repairs a malformed obligation and prints the corrected finding', () => {
        const sessionId = `cli-repair-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-ok');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-cli',
            fingerprint: 'fp-repair-cli',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-cli',
            fingerprint: 'fp-repair-cli',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-cli',
          '--replace-with',
          'epic-1/task-2',
          '--reason',
          'dropped the null entry a malformed plan amend wrote',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status, stdout).toBe(0);
        const finding = JSON.parse(stdout);
        expect(finding.amends_task_ids).toEqual(['epic-1/task-2']);
        expect(finding.obligation_repair_reason).toBe(
          'dropped the null entry a malformed plan amend wrote',
        );
      });

      it('reports a guard refusal (repair-would-empty) rather than a raw stack', () => {
        const sessionId = `cli-repair-empty-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-empty');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-empty',
            fingerprint: 'fp-repair-empty',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-empty',
            fingerprint: 'fp-repair-empty',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-empty',
          '--replace-with',
          '',
          '--reason',
          'valid reason',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('findings.repair-would-empty');
      });

      // D-21 Part 4 review finding (S4 behavioral-drift): the CLI's
      // --replace-with parser used to comma-split, trim, AND filter out
      // empty tokens before ever calling repairObligation -- so guard 6
      // ("every replacement id is a non-empty string") was implemented and
      // unit-tested but unreachable through the shipped interface. An
      // operator typing "a,,b" (a stray double comma) got silent filtering
      // to ['a', 'b'] instead of the named refusal. This goes through the
      // real CLI dispatch, not repairObligation directly -- a function-level
      // test is exactly what already existed and exactly what missed this.
      it('lets guard 6 see a stray empty entry from a double comma, rather than silently filtering it', () => {
        const sessionId = `cli-repair-doublecomma-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-doublecomma');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-doublecomma',
            fingerprint: 'fp-repair-doublecomma',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-doublecomma',
            fingerprint: 'fp-repair-doublecomma',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-doublecomma',
          '--replace-with',
          'epic-1/task-2,,',
          '--reason',
          'valid reason',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('findings.repair-replacement-not-string');
      });
    });

    it('an empty argument is missing, not present — an unset shell variable is a typo too', () => {
      const { stdout, status } = runCli(['gate', 'run', '']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['task-id']);
    });

    it('smith new with no project name reports a missing argument, not a missing flag', () => {
      const { stdout, status } = runCli(['new']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['project']);
    });

    it('smith mcp init with no project name reports a missing argument', () => {
      const { stdout, status } = runCli(['mcp', 'init']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['project']);
    });

    // "Your surface is broken" and "you have no surface" are different answers.
    // Reporting the second as a red would let `smith mcp init` be skipped and
    // then waived away as just another violation.
    it('smith mcp check on a project with no surface refuses rather than reporting a red', () => {
      const targetDir = path.join(scratchDir, 'wt', 'cli-mcp-unscaffolded');
      const { stdout, status } = runCli([
        'mcp',
        'check',
        'cli-mcp-unscaffolded',
        '--target-dir',
        targetDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('mcp.no-surface');
    });

    it('db rebuild --session on a session with no log refuses instead of building an empty db', () => {
      const { stdout, status } = runCli([
        'db',
        'rebuild',
        '--db',
        path.join(scratchDir, 'p9-28-rebuild.sqlite'),
        '--session',
        'no-such-session-p9-28',
        '--state-dir',
        path.join(scratchDir, 'events'),
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('events.unknown-session');
    });

    it('queue run without --project refuses instead of running git in an undefined directory', () => {
      const { stdout, status } = runCli(['queue', 'run', 'epic-1']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--project');
    });
  });
});
