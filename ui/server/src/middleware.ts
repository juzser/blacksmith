// Origin/CSRF guard for the dashboard's write routes. A same-origin browser
// request never carries a foreign Origin, a rebound Host, or a cross-site
// Sec-Fetch-Site, so any one of those refuses the request before it reaches
// the handler. Exactly four rules — nothing here grows a fifth without the
// spec naming it.
import type { Context, Next } from 'hono';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** The hostname portion of a `host:port` value or a full URL/Origin string. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function isLoopback(value: string | undefined | null): boolean {
  if (!value) return false;
  const hostname = hostnameOf(value);
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Applied to POST write routes only (see app.ts). Rules run in order and
 * each returns on its own failure, so a request can be refused for exactly
 * one reason at a time:
 *
 * 1. Content-Type must be `application/json` — a missing header fails this
 *    same rule, not a fifth one.
 * 2. A foreign or `null` Origin is refused.
 * 3. A non-loopback Host is refused — catches DNS-rebinding, where the
 *    Origin looks local but the Host the request actually arrived on does
 *    not.
 * 4. `Sec-Fetch-Site: cross-site` is refused.
 */
export function writeOriginGuard() {
  return async (c: Context, next: Next) => {
    const contentType = (c.req.header('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return c.json(
        {
          error: {
            code: 'write.unsupported-media-type',
            message: 'Content-Type must be "application/json".',
          },
        },
        415,
      );
    }

    const origin = c.req.header('origin');
    if (origin !== undefined && (origin === 'null' || !isLoopback(origin))) {
      return c.json(
        { error: { code: 'write.forbidden-origin', message: 'Origin is not allowed.' } },
        403,
      );
    }

    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!isLoopback(host)) {
      return c.json(
        { error: { code: 'write.forbidden-host', message: 'Host is not allowed.' } },
        403,
      );
    }

    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json(
        {
          error: {
            code: 'write.forbidden-fetch-site',
            message: 'Cross-site requests are not allowed.',
          },
        },
        403,
      );
    }

    return next();
  };
}
