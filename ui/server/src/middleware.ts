// The dashboard server's two guards. The dashboard only reads: every operator
// decision goes through the CLI (`/bs waivers`, `/bs lessons`), so
// readOnlyGuard() refuses any `/api` method that could write, and
// loopbackGuard() keeps the routes that carry prompt text or other projects'
// data on this machine. Both are mounted once, in app.ts.
import type { Context, Next } from 'hono';

// The WHATWG URL parser always returns an IPv6 hostname in bracketed form
// (`[::1]`, never bare `::1`), so that is the form this set must carry.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(hostPort: string): boolean {
  try {
    const url = new URL(hostPort.includes('://') ? hostPort : `http://${hostPort}`);
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Answers 405 to any `/api` request whose method is not GET or HEAD. The
 * server has no write route, so this refuses what would otherwise be a 404
 * and says where the decision goes instead. Mounted app-wide on `/api/*`,
 * ahead of the refresh middleware, so a refused request costs no fold.
 */
export function readOnlyGuard() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD') return next();
    c.header('Allow', 'GET, HEAD');
    return c.json(
      {
        error: {
          code: 'ui.method-not-allowed',
          message:
            'The dashboard only reads. Decide waivers with /bs waivers and lessons with /bs lessons.',
        },
      },
      405,
    );
  };
}

/**
 * Refuses a request whose Host header does not name a loopback address, so a
 * rebound hostname that resolves to 127.0.0.1 cannot read the route from a
 * foreign page. Mounted app-level (app.ts), ahead of the `/api/*` refresh
 * middleware so a refused request triggers no refresh, on the routes that
 * carry operator prompt text or other projects' data: `/api/cli-sessions`,
 * `/api/overview`, `/api/kanban`, `/api/projects` and `/api/tasks/*`.
 * The remaining read routes stay unguarded.
 */
export function loopbackGuard() {
  return async (c: Context, next: Next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!isLoopbackHost(host)) {
      return c.json({ error: { code: 'ui.forbidden-host', message: 'Host is not allowed.' } }, 403);
    }
    return next();
  };
}
