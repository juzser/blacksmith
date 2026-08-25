import { SmithError } from './errors.js';

export class UnsupportedRuntimeError extends SmithError {}

/**
 * The Node major the repo is pinned to. Kept in lockstep with `.nvmrc` and
 * the root package.json `engines` field — `runtime.test.ts` asserts all three
 * agree, so this constant cannot drift away from the pin silently.
 */
export const MIN_NODE_MAJOR = 22;

/**
 * The N-API version the native dependencies are built against.
 * `better-sqlite3` ships one prebuilt binary per platform, compiled for
 * N-API 10 (Node 22+). Node 20 is N-API 9: the binding still *loads*, and
 * then the process dies at `new Database()` with SIGSEGV — no ABI error, no
 * message, both streams empty. That silence is why this guard exists (D-47).
 */
export const MIN_NAPI = 10;

export interface RuntimeInfo {
  /** A Node version string, with or without the leading `v`. */
  version: string;
  /** `process.versions.napi`. Absent on a build without N-API. */
  napi?: string;
}

export interface RuntimeCheck {
  supported: boolean;
  /** An actionable sentence when unsupported; null when fine. */
  reason: string | null;
}

export function currentRuntime(): RuntimeInfo {
  return { version: process.version, napi: process.versions.napi };
}

export function nodeMajor(version: string): number | null {
  // Tolerates a bare major so the same parser reads `.nvmrc` ("22") and
  // `process.version` ("v22.23.1") — one definition of "the pinned major".
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

const REMEDY =
  'Run `nvm use` (the repo pins the major in .nvmrc) or install Node ' +
  `${MIN_NODE_MAJOR}+, then reinstall dependencies.`;

const WHY =
  'The prebuilt better-sqlite3 native binding is built for N-API ' +
  `${MIN_NAPI}; on an older runtime it loads and then segfaults at the first ` +
  'database open, so you get a crash with empty output instead of an error.';

/**
 * Decide whether this runtime can actually run the orchestrator. Unknown is
 * treated as unsupported: the failure mode being guarded against is a silent
 * crash, so guessing in favour of "probably fine" reintroduces exactly the
 * bug (D-47).
 */
export function checkRuntime(info: RuntimeInfo = currentRuntime()): RuntimeCheck {
  const major = nodeMajor(info.version);
  if (major === null) {
    return {
      supported: false,
      reason:
        `Could not parse a Node major version out of "${info.version}", so this runtime ` +
        `cannot be verified against the required Node >=${MIN_NODE_MAJOR}. ${WHY} ${REMEDY}`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    const napi = info.napi === undefined ? 'unknown' : info.napi;
    return {
      supported: false,
      reason:
        `Node ${info.version} (N-API ${napi}) is too old: black-smith requires Node ` +
        `>=${MIN_NODE_MAJOR} (N-API >=${MIN_NAPI}). ${WHY} ${REMEDY}`,
    };
  }
  if (info.napi === undefined) {
    return {
      supported: false,
      reason:
        `Node ${info.version} reports no N-API version, so the native bindings cannot be ` +
        `matched against the required N-API >=${MIN_NAPI}. ${WHY} ${REMEDY}`,
    };
  }
  const napi = Number(info.napi);
  if (!Number.isFinite(napi) || napi < MIN_NAPI) {
    return {
      supported: false,
      reason:
        `Node ${info.version} provides N-API ${info.napi}, below the required N-API ` +
        `>=${MIN_NAPI}. ${WHY} ${REMEDY}`,
    };
  }
  return { supported: true, reason: null };
}

/** `checkRuntime`, but fatal — for the CLI entrypoint. */
export function assertRuntimeSupported(info: RuntimeInfo = currentRuntime()): void {
  const result = checkRuntime(info);
  if (result.supported) return;
  throw new UnsupportedRuntimeError('unsupported-runtime', result.reason ?? 'unsupported runtime', {
    version: info.version,
    napi: info.napi ?? null,
    minNodeMajor: MIN_NODE_MAJOR,
    minNapi: MIN_NAPI,
  });
}
