// Mirrors factory/orchestrator/src/paths.ts's self-location pattern (REPO_ROOT
// derived from this compiled file's own location) — kept local to ui/server
// rather than imported, because a copy compiled into a different directory
// nesting would compute the wrong REPO_ROOT (see the ui/server/src/app.ts
// header comment for why ui/server imports factory/orchestrator's BUILT
// dist/, never its src/, for exactly this reason).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ui/server/src/paths.ts -> repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

export const UI_DIST_DIR = path.join(REPO_ROOT, 'ui', 'dist');
export const ORCHESTRATOR_DIST_DIR = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist');
