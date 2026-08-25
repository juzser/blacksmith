// Entry point built to ui/server/dist/index.js and loaded at runtime by
// `smith ui serve` (factory/orchestrator/src/cli.ts) via a dynamic import —
// keeps ui/server out of factory/orchestrator's own tsconfig.json/bin
// contract (see app.ts's header comment for why).
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from './app.js';
import { UI_DIST_DIR } from './paths.js';

export interface ServeOptions {
  port?: number;
  dbPath: string;
  stateDir?: string;
  roadmapPath?: string;
  specsDir?: string;
}

export interface ServerHandle {
  close: () => void;
}

const DEFAULT_PORT = 4680;

/** Starts the dashboard API + static UI server, bound to 127.0.0.1 only (local-first, no auth — architecture §10). */
export function serve(opts: ServeOptions): ServerHandle {
  const { app, handle } = createApp({
    dbPath: opts.dbPath,
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    ...(opts.roadmapPath ? { roadmapPath: opts.roadmapPath } : {}),
    ...(opts.specsDir ? { specsDir: opts.specsDir } : {}),
    uiDistDir: UI_DIST_DIR,
  });
  const port = opts.port ?? DEFAULT_PORT;
  const server = nodeServe({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  process.stdout.write(`smith ui listening on http://127.0.0.1:${port}\n`);

  return {
    close: () => {
      server.close();
      handle.sqlite.close();
    },
  };
}
