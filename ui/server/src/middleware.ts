// Origin/CSRF guard for the dashboard's write routes. A same-origin browser
// request never carries a foreign Origin, a rebound Host, or a cross-site
// Sec-Fetch-Site, so any one of those refuses the request before it reaches
// the handler. Exactly four rules — nothing here grows a fifth without the
// spec naming it. Mounted ONCE, in app.ts, via `app.on('POST', '/api/*', ...)`
// — no individual route handler restates any of these rules.
import type { Context, Next } from 'hono';

// The WHATWG URL parser always returns an IPv6 hostname in bracketed form
// (`[::1]`, never bare `::1`), so that is the form this set must carry.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `host:port` normalized through the WHATWG URL parser, which strips a port
 * that is the default for the given scheme -- so `http://x:80` and `https://
 * x:443` both come back as `x`, making the comparison below scheme-
 * insensitive. `value` may already carry a scheme (an Origin) or be a bare
 * `host:port` (a Host header); the latter is parsed against `assumedScheme`
 * only to satisfy the URL constructor, never compared across schemes.
 */
function parsedHost(value: string, assumedScheme: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `${assumedScheme}://${value}`).host;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostPort: string): boolean {
  try {
    const url = new URL(hostPort.includes('://') ? hostPort : `http://${hostPort}`);
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Applied once, method-wide, to every POST under `/api/*` (see app.ts).
 * Rules run in order and each returns on its own failure, so a request can
 * be refused for exactly one reason at a time:
 *
 * 1. Content-Type must be `application/json` — a missing header fails this
 *    same rule, not a fifth one.
 * 2. When present, Origin's parsed host (scheme-insensitive host and port)
 *    must equal the Host header's parsed host; `Origin: null` is always
 *    foreign.
 * 3. The Host header itself must name a loopback address — catches DNS
 *    rebinding, where an attacker's hostname resolves to 127.0.0.1 and the
 *    browser is willing to set Origin to that same hostname.
 * 4. `Sec-Fetch-Site: cross-site` is refused.
 */
export function writeGuard() {
  return async (c: Context, next: Next) => {
    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return c.json(
        {
          error: {
            code: 'ui.unsupported-media-type',
            message: 'Content-Type must be "application/json".',
          },
        },
        415,
      );
    }

    const host = c.req.header('host') ?? new URL(c.req.url).host;

    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const originHost = origin === 'null' ? null : parsedHost(origin, 'http');
      const requestHost = parsedHost(host, 'http');
      if (originHost === null || requestHost === null || originHost !== requestHost) {
        return c.json(
          { error: { code: 'ui.forbidden-origin', message: 'Origin is not allowed.' } },
          403,
        );
      }
    }

    if (!isLoopbackHost(host)) {
      return c.json({ error: { code: 'ui.forbidden-host', message: 'Host is not allowed.' } }, 403);
    }

    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json(
        {
          error: {
            code: 'ui.forbidden-fetch-site',
            message: 'Cross-site requests are not allowed.',
          },
        },
        403,
      );
    }

    return next();
  };
}

/**
 * Refuses a request whose Host header does not name a loopback address, so a
 * rebound hostname that resolves to 127.0.0.1 cannot read the route from a
 * foreign page. Mounted per route on `GET /api/cli-sessions`, which carries
 * operator prompt text; writeGuard() covers POST only, and extending this to
 * the other read routes is a separate change.
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
