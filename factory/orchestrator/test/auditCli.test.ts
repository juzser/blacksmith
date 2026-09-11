import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_AXES,
  type AuditAxis,
  type AuditEvidenceItem,
  auditManifestPath,
  auditStorePath,
  auditWorktreeDir,
  closeAudit,
  consolidateAudit,
  cutAudit,
  decideAudit,
  foldAuditStore,
  openAudit,
  readAuditStore,
  recordAudit,
  resolveAudit,
} from '../src/audit.js';
import { type EventRecord, readEvents, startSession } from '../src/events.js';
import type { EventContext } from '../src/findings.js';
import { assertExited, git, runProcess } from './helpers/process.js';

// ---------------------------------------------------------------------------
// `audit.test.ts` pins the store: fold, suppression, clustering, ranking. This
// file pins the seven verbs an operator runs on top of it
// (docs/specs/audit-command-scope.md §6), each driven against a real git
// repository in a temp dir and a real event log in a temp state dir -- the
// manifest, the detached worktree, the fingerprint `close` verifies, and the
// epic id `cut` stamps are all things only the verbs write. The last block
// runs the whole life of one audit through the built binary, because the
// playbook's agent never calls these functions: it types the commands.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
const SESSION = 'sess-audit-1';

function evidence(overrides: Partial<AuditEvidenceItem> = {}): AuditEvidenceItem {
  return {
    file_path: 'src/foo.ts',
    severity: 'S2-major',
    summary: 'the gate admits any self-signed certificate',
    failure_scenario: { inputs: 'i', expected: 'e', actual: 'a' },
    confidence: 0.9,
    ...overrides,
  };
}

/** The first element, or a loud failure: a test that reads an empty result should say so. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected at least one item, got none');
  return item;
}

describe('the audit verbs', () => {
  let root: string;
  let project: string;
  let stateDir: string;
  let ctx: EventContext;
  const opts = (): { stateDir: string } => ({ stateDir });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-audit-cli-'));
    project = path.join(root, 'project');
    stateDir = path.join(root, 'state');
    mkdirSync(project);
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['config', 'user.email', 'test@example.com']);
    git(project, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(project, 'README.md'), '# project\n');
    git(project, ['add', '.']);
    git(project, ['commit', '-q', '-m', 'init']);
    const rootEvent = await startSession(SESSION, { stateDir });
    ctx = { sessionId: SESSION, planVersion: 1, causalParent: rootEvent.event_id };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The stored records of this session, unwrapped from their ids. */
  async function records(): Promise<EventRecord[]> {
    return (await readEvents(SESSION, opts())).map((event) => event.record);
  }

  async function eventTypes(): Promise<string[]> {
    return (await records()).map((record) => record.event_type);
  }

  /** The one record of a type, or a loud failure. */
  async function recordOf(eventType: string): Promise<EventRecord> {
    return only((await records()).filter((record) => record.event_type === eventType));
  }

  /** Open, record one security finding, return its fingerprint. */
  async function raiseOne(axis: AuditAxis = 'security'): Promise<string> {
    await openAudit(project, ctx, opts());
    const recorded = await recordAudit(project, axis, [evidence()], ctx, opts());
    return only(recorded.appended);
  }

  describe('audit open', () => {
    it('refuses a directory that does not exist', async () => {
      await expect(openAudit(path.join(root, 'missing'), ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.project-missing' }),
      );
    });

    it('refuses a directory that is not a git repository', async () => {
      const plain = path.join(root, 'plain');
      mkdirSync(plain);
      await expect(openAudit(plain, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.not-a-git-repository' }),
      );
    });

    it('cuts a detached worktree beside the clone, writes the manifest, logs the open', async () => {
      const opened = await openAudit(project, ctx, opts());

      expect(opened.audit_id).toMatch(/^\d{8}-[0-9a-f]{8}$/);
      expect(opened.axes).toEqual(AUDIT_AXES);
      expect(opened.live).toEqual([]);
      // Beside the project, never inside it (AGENTS.md "Worktrees").
      expect(opened.worktree).toBe(path.join(root, '.wt', 'project', 'audit'));
      expect(existsSync(opened.worktree)).toBe(true);
      expect(opened.head).toBe(git(project, ['rev-parse', 'HEAD']).trim());
      expect(git(opened.worktree, ['rev-parse', 'HEAD']).trim()).toBe(opened.head);
      // Detached: a judge that commits cannot move a branch of the project.
      expect(git(opened.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');

      const manifest = JSON.parse(readFileSync(auditManifestPath(project), 'utf8'));
      expect(manifest).toMatchObject({
        audit_id: opened.audit_id,
        project,
        worktree: opened.worktree,
        head: opened.head,
        session_id: SESSION,
        event_id: opened.event_id,
      });
      expect(manifest.fingerprint.head).toBe(opened.head);

      const open = await recordOf('audit-opened');
      expect(open.project).toBe('project');
      expect(open.actor).toBe('operator');
      expect(open.payload).toMatchObject({ audit_id: opened.audit_id, axes: [...AUDIT_AXES] });
    });

    it('refuses a second open while the first is still open', async () => {
      const first = await openAudit(project, ctx, opts());
      await expect(openAudit(project, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({
          code: 'audit.already-open',
          details: expect.objectContaining({ audit_id: first.audit_id }),
        }),
      );
    });

    it('refuses a worktree left behind by an audit that never closed', async () => {
      mkdirSync(auditWorktreeDir(project), { recursive: true });
      await expect(openAudit(project, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.worktree-exists' }),
      );
      expect(existsSync(auditManifestPath(project))).toBe(false);
    });

    it('lists what the store still suppresses, so the axes know what not to re-raise', async () => {
      const fingerprint = await raiseOne();
      await closeAudit(project, {}, ctx, opts());

      const reopened = await openAudit(project, ctx, opts());
      expect(reopened.live.map((finding) => finding.fingerprint)).toEqual([fingerprint]);
      expect(only(reopened.live)).not.toHaveProperty('history');
    });
  });

  describe('audit record', () => {
    it('refuses to record when no audit is open', async () => {
      await expect(
        recordAudit(project, 'security', [evidence()], ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.not-open' }));
    });

    it('refuses evidence that is not a list', async () => {
      await openAudit(project, ctx, opts());
      await expect(
        recordAudit(project, 'security', { findings: [] }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.evidence-not-a-list' }));
      expect(existsSync(auditStorePath(project))).toBe(false);
    });

    it('appends raised lines that carry the audit, the session and the event', async () => {
      const opened = await openAudit(project, ctx, opts());
      const recorded = await recordAudit(
        project,
        'performance',
        [evidence(), evidence({ file_path: 'src/bar.ts', summary: 'n+1 query per row' })],
        ctx,
        opts(),
      );

      expect(recorded.audit_id).toBe(opened.audit_id);
      expect(recorded.appended).toHaveLength(2);
      expect(recorded.suppressed).toEqual([]);

      const lines = readAuditStore(project);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatchObject({
          status: 'raised',
          axis: 'performance',
          audit_id: opened.audit_id,
          session_id: SESSION,
          event_id: recorded.event_id,
        });
      }
      const raised = await recordOf('audit-finding-raised');
      expect(raised.payload).toMatchObject({
        audit_id: opened.audit_id,
        axis: 'performance',
        appended: 2,
        suppressed: 0,
        fingerprints: recorded.appended,
      });
    });

    it('writes one line for two items in one file that share a fingerprint', async () => {
      await openAudit(project, ctx, opts());
      const recorded = await recordAudit(
        project,
        'security',
        [evidence(), evidence({ confidence: 0.4 })],
        ctx,
        opts(),
      );
      expect(recorded.appended).toHaveLength(1);
      expect(recorded.suppressed).toEqual(recorded.appended);
      expect(readAuditStore(project)).toHaveLength(1);
    });

    it('drops a fingerprint the store already suppresses instead of raising it twice', async () => {
      const fingerprint = await raiseOne();
      await closeAudit(project, {}, ctx, opts());
      await openAudit(project, ctx, opts());

      const again = await recordAudit(project, 'security', [evidence()], ctx, opts());
      expect(again.appended).toEqual([]);
      expect(again.suppressed).toEqual([fingerprint]);
      expect(readAuditStore(project)).toHaveLength(1);
    });
  });

  describe('audit consolidate', () => {
    it('counts every status and ranks only the raised', async () => {
      await openAudit(project, ctx, opts());
      const recorded = await recordAudit(
        project,
        'security',
        [
          evidence(),
          evidence({ file_path: 'src/bar.ts', summary: 'token logged', severity: 'S4-nit' }),
        ],
        ctx,
        opts(),
      );
      const [foo, bar] = recorded.appended as [string, string];
      await decideAudit(project, { fingerprint: bar, decision: 'decline' }, ctx, opts());

      const consolidated = consolidateAudit(project);
      expect(consolidated.project).toBe(project);
      expect(consolidated.store).toBe(auditStorePath(project));
      expect(consolidated.counts).toEqual({
        raised: 1,
        merged: 0,
        accepted: 0,
        declined: 1,
        fixed: 0,
      });
      expect(consolidated.clusters.map((cluster) => cluster.filePath)).toEqual(['src/foo.ts']);
      expect(only(only(consolidated.clusters).members).fingerprint).toBe(foo);
      expect(only(only(consolidated.clusters).members)).not.toHaveProperty('history');
    });

    it('reads an empty store as no clusters rather than refusing', () => {
      expect(consolidateAudit(project).clusters).toEqual([]);
    });
  });

  describe('audit decide', () => {
    it('refuses a decision outside accept, decline, merge', async () => {
      const fingerprint = await raiseOne();
      await expect(
        decideAudit(project, { fingerprint, decision: 'drop' as unknown as 'accept' }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.unknown-decision' }));
    });

    it('refuses a fingerprint the store does not know', async () => {
      await raiseOne();
      await expect(
        decideAudit(project, { fingerprint: 'nope', decision: 'accept' }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.unknown-finding' }));
    });

    it('refuses a merge with no survivor, into itself, or into a stranger', async () => {
      const fingerprint = await raiseOne();
      await expect(
        decideAudit(project, { fingerprint, decision: 'merge' }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.merge-without-survivor' }));
      await expect(
        decideAudit(project, { fingerprint, decision: 'merge', sameAs: fingerprint }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.merge-into-self' }));
      await expect(
        decideAudit(project, { fingerprint, decision: 'merge', sameAs: 'nope' }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.unknown-survivor' }));
      expect(readAuditStore(project)).toHaveLength(1);
    });

    it('refuses --same-as on a decision that names no other finding', async () => {
      const fingerprint = await raiseOne();
      await expect(
        decideAudit(project, { fingerprint, decision: 'accept', sameAs: 'x' }, ctx, opts()),
      ).rejects.toThrowError(expect.objectContaining({ code: 'audit.same-as-refused' }));
    });

    it('appends the answer as a line and logs it, and needs no open audit to do so', async () => {
      const fingerprint = await raiseOne();
      await closeAudit(project, {}, ctx, opts());

      const decided = await decideAudit(
        project,
        { fingerprint, decision: 'accept', note: 'real, and cheap' },
        ctx,
        opts(),
      );
      expect(decided).toMatchObject({ fingerprint, decision: 'accept', status: 'accepted' });
      expect(decided).not.toHaveProperty('same_as');

      const folded = only(foldAuditStore(readAuditStore(project)));
      expect(folded.status).toBe('accepted');
      expect(folded.history.at(-1)).toMatchObject({
        status: 'accepted',
        note: 'real, and cheap',
        event_id: decided.event_id,
      });
      const decision = await recordOf('audit-decision');
      expect(decision.payload).toMatchObject({
        fingerprint,
        decision: 'accept',
        status: 'accepted',
        note: 'real, and cheap',
      });
    });

    it('carries the survivor through a merge and drops the duplicate from the ranking', async () => {
      await openAudit(project, ctx, opts());
      const recorded = await recordAudit(
        project,
        'security',
        [evidence(), evidence({ summary: 'self-signed certificates pass the gate' })],
        ctx,
        opts(),
      );
      const [survivor, duplicate] = recorded.appended as [string, string];

      const merged = await decideAudit(
        project,
        { fingerprint: duplicate, decision: 'merge', sameAs: survivor },
        ctx,
        opts(),
      );
      expect(merged).toMatchObject({ status: 'merged', same_as: survivor });

      const cluster = only(consolidateAudit(project).clusters);
      expect(cluster.members.map((member) => member.fingerprint)).toEqual([survivor]);
    });
  });

  describe('audit cut', () => {
    const input = { epicId: 'proj-audit-1', title: 'Close the audit findings' };

    it('refuses when nothing accepted is free to cut', async () => {
      await raiseOne();
      await expect(cutAudit(project, input, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.nothing-accepted' }),
      );
    });

    it('renders the milestone and the spec from the accepted findings and stamps the epic', async () => {
      const fingerprint = await raiseOne();
      await decideAudit(project, { fingerprint, decision: 'accept' }, ctx, opts());
      const before = readAuditStore(project).length;

      const cut = await cutAudit(project, input, ctx, opts());

      expect(cut.epic).toBe(input.epicId);
      expect(cut.findings.map((finding) => finding.fingerprint)).toEqual([fingerprint]);
      // A roadmap block, in the shape `factory/specs/roadmap.md` parses.
      expect(cut.milestone).toContain(`## ${input.title}\n- id: ${input.epicId}\n`);
      expect(cut.milestone).toContain('- project: project\n- kind: product\n');
      expect(cut.milestone).toContain(`**${fingerprint.slice(0, 8)} (S2-major, security)**`);
      expect(cut.milestone.endsWith('\n')).toBe(true);
      // An epic spec with one acceptance row per finding.
      expect(cut.spec.startsWith(`# Epic spec — \`${input.epicId}\``)).toBe(true);
      expect(cut.spec).toContain('## Acceptance criteria');
      expect(cut.spec).toContain(`| 1 | \`${fingerprint.slice(0, 8)}\` | S2-major | security |`);
      expect(cut.spec).toContain(`- **Fingerprint** — \`${fingerprint}\``);

      const lines = readAuditStore(project);
      expect(lines).toHaveLength(before + 1);
      expect(lines.at(-1)).toMatchObject({
        fingerprint,
        status: 'accepted',
        epic: input.epicId,
        event_id: cut.event_id,
      });
      expect(only(foldAuditStore(lines)).epic).toBe(input.epicId);
      expect(await eventTypes()).toContain('audit-cut');
    });

    it('offers the same epic its findings again without a second stamp', async () => {
      const fingerprint = await raiseOne();
      await decideAudit(project, { fingerprint, decision: 'accept' }, ctx, opts());
      await cutAudit(project, input, ctx, opts());
      const before = readAuditStore(project).length;

      const again = await cutAudit(project, input, ctx, opts());
      expect(again.findings.map((finding) => finding.fingerprint)).toEqual([fingerprint]);
      expect(readAuditStore(project)).toHaveLength(before);
    });

    it('never offers a finding that already belongs to another epic', async () => {
      await openAudit(project, ctx, opts());
      const recorded = await recordAudit(
        project,
        'architecture',
        [evidence(), evidence({ file_path: 'src/bar.ts', summary: 'layer inverted' })],
        ctx,
        opts(),
      );
      const [foo, bar] = recorded.appended as [string, string];
      await decideAudit(project, { fingerprint: foo, decision: 'accept' }, ctx, opts());
      await cutAudit(project, { epicId: 'other-epic', title: 'Elsewhere' }, ctx, opts());
      // `foo` is spoken for; `bar` is accepted only now, so the second cut gets it alone.
      await decideAudit(project, { fingerprint: bar, decision: 'accept' }, ctx, opts());

      const cut = await cutAudit(project, input, ctx, opts());
      expect(cut.findings.map((finding) => finding.fingerprint)).toEqual([bar]);
      const folded = foldAuditStore(readAuditStore(project));
      expect(folded.find((finding) => finding.fingerprint === foo)?.epic).toBe('other-epic');
      expect(folded.find((finding) => finding.fingerprint === bar)?.epic).toBe(input.epicId);
    });
  });

  describe('audit resolve', () => {
    const input = { epicId: 'proj-audit-1', title: 'Close the audit findings' };

    it('refuses an epic no finding was cut into', async () => {
      await raiseOne();
      await expect(resolveAudit(project, 'nope', ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.unknown-epic' }),
      );
    });

    it("marks the epic's findings fixed once, and says so the second time", async () => {
      const fingerprint = await raiseOne();
      await decideAudit(project, { fingerprint, decision: 'accept' }, ctx, opts());
      await cutAudit(project, input, ctx, opts());

      const resolved = await resolveAudit(project, input.epicId, ctx, opts());
      expect(resolved).toMatchObject({ epic: input.epicId, fixed: [fingerprint], already: [] });
      const folded = only(foldAuditStore(readAuditStore(project)));
      expect(folded.status).toBe('fixed');
      expect(folded.epic).toBe(input.epicId);
      expect(await eventTypes()).toContain('audit-resolved');

      const before = readAuditStore(project).length;
      const again = await resolveAudit(project, input.epicId, ctx, opts());
      expect(again).toMatchObject({ fixed: [], already: [fingerprint] });
      expect(readAuditStore(project)).toHaveLength(before);
    });

    it('lets a fixed finding come back as a regression rather than swallowing it', async () => {
      const fingerprint = await raiseOne();
      await decideAudit(project, { fingerprint, decision: 'accept' }, ctx, opts());
      await cutAudit(project, input, ctx, opts());
      await resolveAudit(project, input.epicId, ctx, opts());
      await closeAudit(project, {}, ctx, opts());

      const reopened = await openAudit(project, ctx, opts());
      expect(reopened.live).toEqual([]);
      const again = await recordAudit(project, 'security', [evidence()], ctx, opts());
      expect(again.appended).toEqual([fingerprint]);
      expect(again.suppressed).toEqual([]);
      expect(only(foldAuditStore(readAuditStore(project))).status).toBe('raised');
    });
  });

  describe('audit close', () => {
    it('refuses to close when no audit is open', async () => {
      await expect(closeAudit(project, {}, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({ code: 'audit.not-open' }),
      );
    });

    it('removes an untouched worktree and the manifest, and logs what it verified', async () => {
      const opened = await openAudit(project, ctx, opts());

      const closed = await closeAudit(project, {}, ctx, opts());
      expect(closed).toMatchObject({
        audit_id: opened.audit_id,
        worktree: opened.worktree,
        verified: true,
        unchanged: true,
        drift: [],
      });
      expect(existsSync(opened.worktree)).toBe(false);
      expect(existsSync(auditManifestPath(project))).toBe(false);
      expect(git(project, ['worktree', 'list', '--porcelain'])).not.toContain(opened.worktree);

      const event = await recordOf('audit-closed');
      expect(event.payload).toMatchObject({
        audit_id: opened.audit_id,
        verified: true,
        unchanged: true,
        forced: false,
      });
    });

    it('refuses to close over a worktree an axis wrote into, and keeps the audit open', async () => {
      const opened = await openAudit(project, ctx, opts());
      writeFileSync(path.join(opened.worktree, 'edited.txt'), 'a judge wrote this\n');

      await expect(closeAudit(project, {}, ctx, opts())).rejects.toThrowError(
        expect.objectContaining({
          code: 'audit.worktree-moved',
          details: expect.objectContaining({
            audit_id: opened.audit_id,
            drift: [expect.objectContaining({ kind: 'dirtied' })],
          }),
        }),
      );
      expect(existsSync(opened.worktree)).toBe(true);
      expect(existsSync(auditManifestPath(project))).toBe(true);
      expect(await eventTypes()).not.toContain('audit-closed');
    });

    it('closes over drift only when forced, and says the tree was not clean', async () => {
      const opened = await openAudit(project, ctx, opts());
      writeFileSync(path.join(opened.worktree, 'edited.txt'), 'a judge wrote this\n');

      const closed = await closeAudit(project, { force: true }, ctx, opts());
      expect(closed.verified).toBe(true);
      expect(closed.unchanged).toBe(false);
      expect(closed.drift.map((drift) => drift.kind)).toEqual(['dirtied']);
      expect(existsSync(opened.worktree)).toBe(false);
      expect(existsSync(auditManifestPath(project))).toBe(false);

      const event = await recordOf('audit-closed');
      expect(event.payload).toMatchObject({ unchanged: false, forced: true });
    });

    it('still closes when the worktree is already gone, and says it could not verify', async () => {
      const opened = await openAudit(project, ctx, opts());
      git(project, ['worktree', 'remove', '--force', opened.worktree]);

      const closed = await closeAudit(project, {}, ctx, opts());
      expect(closed).toMatchObject({ verified: false, unchanged: true, drift: [] });
      expect(existsSync(auditManifestPath(project))).toBe(false);
    });
  });
});

describe('the audit verbs through the built binary', () => {
  let root: string;
  let project: string;
  let stateDir: string;
  let envelope: string[];

  function smith(...args: string[]): { status: number | null; json: unknown; stderr: string } {
    const run = runProcess('node', [CLI_PATH, ...args]);
    assertExited(run, `smith ${args.slice(0, 2).join(' ')}`);
    let json: unknown;
    try {
      json = JSON.parse(run.status === 0 ? run.stdout : run.stderr || run.stdout);
    } catch {
      throw new Error(
        `smith ${args.join(' ')} did not print JSON (status ${run.status}):\n${run.stdout}\n${run.stderr}`,
      );
    }
    return { status: run.status, json, stderr: run.stderr };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-audit-bin-'));
    project = path.join(root, 'project');
    stateDir = path.join(root, 'state');
    mkdirSync(project);
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['config', 'user.email', 'test@example.com']);
    git(project, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(project, 'README.md'), '# project\n');
    git(project, ['add', '.']);
    git(project, ['commit', '-q', '-m', 'init']);
    const started = smith('session', 'start', 'sess-bin', '--state-dir', stateDir);
    expect(started.status).toBe(0);
    const rootEvent = (started.json as { event_id: string }).event_id;
    envelope = ['--session', 'sess-bin', '--causal-parent', rootEvent, '--state-dir', stateDir];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs one audit from open to close on the command line', () => {
    const opened = smith('audit', 'open', project, ...envelope);
    expect(opened.status).toBe(0);
    const { audit_id: auditId, worktree } = opened.json as { audit_id: string; worktree: string };
    expect(existsSync(worktree)).toBe(true);

    const evidencePath = path.join(root, 'security.json');
    writeFileSync(evidencePath, `${JSON.stringify([evidence()])}\n`);
    const recorded = smith(
      'audit',
      'record',
      project,
      '--axis',
      'security',
      '--evidence',
      evidencePath,
      ...envelope,
    );
    expect(recorded.status).toBe(0);
    const fingerprint = only((recorded.json as { appended: string[] }).appended);

    const consolidated = smith('audit', 'consolidate', project);
    expect(consolidated.status).toBe(0);
    expect((consolidated.json as { counts: { raised: number } }).counts.raised).toBe(1);

    // A decision the vocabulary does not know is refused by code, the way the
    // playbook's hard stop expects to read it.
    const refused = smith(
      'audit',
      'decide',
      project,
      '--fingerprint',
      fingerprint,
      '--decision',
      'drop',
      ...envelope,
    );
    expect(refused.status).toBe(1);
    expect((refused.json as { error: { code: string } }).error.code).toBe('audit.unknown-decision');

    const decided = smith(
      'audit',
      'decide',
      project,
      '--fingerprint',
      fingerprint,
      '--decision',
      'accept',
      '--note',
      'cheap and real',
      ...envelope,
    );
    expect(decided.status).toBe(0);
    expect((decided.json as { status: string }).status).toBe('accepted');

    const cut = smith(
      'audit',
      'cut',
      project,
      '--epic',
      'proj-audit-1',
      '--title',
      'Close the audit findings',
      ...envelope,
    );
    expect(cut.status).toBe(0);
    const cutJson = cut.json as { milestone: string; spec: string };
    expect(cutJson.milestone).toContain('- id: proj-audit-1');
    expect(cutJson.spec).toContain('# Epic spec — `proj-audit-1`');

    const resolved = smith('audit', 'resolve', project, '--epic', 'proj-audit-1', ...envelope);
    expect(resolved.status).toBe(0);
    expect((resolved.json as { fixed: string[] }).fixed).toEqual([fingerprint]);

    // The axis dirtied the tree: a bare close refuses, `--force` closes and says so.
    writeFileSync(path.join(worktree, 'scratch.txt'), 'left behind\n');
    const blocked = smith('audit', 'close', project, ...envelope);
    expect(blocked.status).toBe(1);
    expect((blocked.json as { error: { code: string } }).error.code).toBe('audit.worktree-moved');

    const closed = smith('audit', 'close', project, '--force', ...envelope);
    expect(closed.status).toBe(0);
    expect(closed.json).toMatchObject({ audit_id: auditId, verified: true, unchanged: false });
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(auditManifestPath(project))).toBe(false);

    const events = smith('event', 'tail', 'sess-bin', '--n', '50', '--state-dir', stateDir);
    expect(events.status).toBe(0);
    expect(
      (events.json as { record: { event_type: string } }[]).map((event) => event.record.event_type),
    ).toEqual([
      'session-start',
      'audit-opened',
      'audit-finding-raised',
      'audit-decision',
      'audit-cut',
      'audit-resolved',
      'audit-closed',
    ]);
  });
});
