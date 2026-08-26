import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { SANDBOX_LEASE_DIR } from './paths.js';

/**
 * The judge sandbox: what turns "judges are read-only" from a sentence an
 * agent reads into a rule the machine applies while the judge is running.
 *
 * Before this module the guarantee was `immutability.ts` — fingerprint the
 * worktree, run the judge, compare after. That check is real and it stays
 * (see `checkWorktreeImmutable`), but it is a *detector*, not a guard: by the
 * time it fires the write has happened, the judge's verdict is already
 * untrustworthy, and the task has to go round again. Worse, it can only see
 * what git can see — a judge that curls an endpoint, installs a package, or
 * writes outside the worktree leaves no fingerprint at all, and the six judge
 * roles hold `Bash` in fact even though they are read-only in prose
 * (agent-interviews.md N-10).
 *
 * A lease closes that gap at the only moment where refusing is free: before
 * the command runs. The orchestrator opens one against the worktree it is
 * about to hand a judge; `smith policy hook` resolves the lease from the
 * PreToolUse payload's `cwd` and, while one is open, evaluates the judge
 * rules in guardrails.yml on top of the six that always apply. Closing the
 * lease is the orchestrator's move, not the judge's — `judge-sandbox-escape`
 * exists precisely because `smith sandbox close` is itself a Bash command.
 *
 * Why a file rather than an environment variable: the hook does not run in
 * the judge's process, or even necessarily on the same side of a subagent
 * boundary. `cwd` is the one thing the PreToolUse payload is guaranteed to
 * carry that identifies *where* the command will run, and a worktree path is
 * what a judge dispatch is scoped to. So the lease is keyed by worktree and
 * kept in the main clone, which is also the answer to "could the judge just
 * delete it": that path is outside its worktree, and reaching it is a write
 * the same rule set denies.
 *
 * What this deliberately is NOT: a container, a seccomp filter, or a
 * read-only mount. Those are the real thing and this is not them — a judge
 * that never issues a Bash tool call cannot be watched here at all, and a
 * sufficiently creative command line will get past a matcher, exactly as
 * documented for the six branch/deploy rules. This raises the floor from
 * "detected afterwards" to "refused up front" on every path a judge actually
 * has, and `checkWorktreeImmutable` still runs behind it. Both are stated
 * plainly in docs/standards/guardrails.md rather than sold as a sandbox.
 */
export class SandboxError extends SmithError {}

export interface SandboxLease {
  /** Absolute path of the worktree the judge was handed. Commands are matched against this prefix. */
  readonly worktreeDir: string;
  /** The judge role the lease was opened for — recorded so a denial can name who was refused. */
  readonly role: string;
  readonly taskId: string;
  readonly sessionId: string;
  /**
   * ISO-8601, supplied by the caller rather than read from the clock here, so
   * the module has no ambient time dependency and a test can pin it. It is a
   * record, not an expiry: a lease ends when someone closes it, because a
   * lease that expired on its own would hand a judge a way to wait out its
   * own guard.
   */
  readonly openedAt: string;
}

export interface OpenSandboxInput {
  readonly worktreeDir: string;
  readonly role: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly openedAt: string;
}

/**
 * One file per lease, named by a hash of the worktree path.
 *
 * Per-file rather than one shared JSON document because judges for different
 * tasks run at the same time by design: two waves in flight means two opens
 * and two closes racing, and a read-modify-write of a shared file loses one
 * of them. A hash rather than the path itself because a worktree path is not
 * a legal filename on any platform this runs on.
 */
export function leasePathFor(worktreeDir: string, dir: string = SANDBOX_LEASE_DIR): string {
  const key = createHash('sha256').update(path.resolve(worktreeDir)).digest('hex').slice(0, 32);
  return path.join(dir, `${key}.json`);
}

function assertLease(value: unknown, file: string): SandboxLease {
  const lease = value as Partial<SandboxLease> | null;
  if (
    lease === null ||
    typeof lease !== 'object' ||
    typeof lease.worktreeDir !== 'string' ||
    typeof lease.role !== 'string' ||
    typeof lease.taskId !== 'string' ||
    typeof lease.sessionId !== 'string' ||
    typeof lease.openedAt !== 'string'
  ) {
    throw new SandboxError(
      'sandbox.invalid-lease',
      `${file} is not a sandbox lease ({ worktreeDir, role, taskId, sessionId, openedAt }).`,
      { file },
    );
  }
  return lease as SandboxLease;
}

/**
 * Open a lease over `worktreeDir`.
 *
 * Refuses when one is already open, and that refusal is the point rather than
 * bookkeeping tidiness: two judges sharing a worktree means the second one's
 * writes are attributed to the first one's lease and neither verdict can be
 * trusted. The orchestrator's answer is a second worktree, not a second
 * judge in the same tree.
 */
export function openSandbox(
  input: OpenSandboxInput,
  dir: string = SANDBOX_LEASE_DIR,
): SandboxLease {
  const worktreeDir = path.resolve(input.worktreeDir);
  const file = leasePathFor(worktreeDir, dir);
  const existing = readSandbox(worktreeDir, dir);
  if (existing) {
    throw new SandboxError(
      'sandbox.already-open',
      `A ${existing.role} sandbox is already open on ${worktreeDir} (task ${existing.taskId}, since ${existing.openedAt}). Close it, or give this judge its own worktree.`,
      { worktreeDir, role: existing.role, taskId: existing.taskId },
    );
  }
  const lease: SandboxLease = {
    worktreeDir,
    role: input.role,
    taskId: input.taskId,
    sessionId: input.sessionId,
    openedAt: input.openedAt,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
  return lease;
}

/** The lease on exactly this worktree, or null. Does not walk up — see `activeSandboxFor`. */
export function readSandbox(
  worktreeDir: string,
  dir: string = SANDBOX_LEASE_DIR,
): SandboxLease | null {
  const file = leasePathFor(worktreeDir, dir);
  if (!existsSync(file)) return null;
  return assertLease(JSON.parse(readFileSync(file, 'utf8')), file);
}

/** Close the lease on `worktreeDir`. Returns false when there was none — closing twice is not an error. */
export function closeSandbox(worktreeDir: string, dir: string = SANDBOX_LEASE_DIR): boolean {
  const file = leasePathFor(worktreeDir, dir);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** Every open lease, for `smith sandbox status` and for the resolver below. */
export function listSandboxes(dir: string = SANDBOX_LEASE_DIR): SandboxLease[] {
  if (!existsSync(dir)) return [];
  const leases: SandboxLease[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    leases.push(assertLease(JSON.parse(readFileSync(file, 'utf8')), file));
  }
  return leases;
}

/**
 * The lease covering a command about to run in `cwd`, or null.
 *
 * Matches on containment, not equality: a judge running `pnpm -C ui test`
 * from `<worktree>/ui` is inside the same sandbox as one standing at the
 * root, and a rule that only fired at the exact worktree path would be a
 * `cd` away from being off. When leases nest (they should not, but a
 * worktree inside a worktree is not forbidden by anything) the longest
 * matching path wins, which is the innermost and therefore the most specific
 * claim on the command.
 */
export function activeSandboxFor(
  cwd: string,
  dir: string = SANDBOX_LEASE_DIR,
): SandboxLease | null {
  const here = path.resolve(cwd);
  let best: SandboxLease | null = null;
  for (const lease of listSandboxes(dir)) {
    const relative = path.relative(lease.worktreeDir, here);
    const contained =
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    if (!contained) continue;
    if (best === null || lease.worktreeDir.length > best.worktreeDir.length) best = lease;
  }
  return best;
}
