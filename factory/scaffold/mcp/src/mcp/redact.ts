/**
 * Output redaction for the MCP surface — docs/standards/mcp.md MCP-S1, and
 * guardrails.md's "No secrets in outputs". Everything leaving a tool passes
 * through here: results, error text, stderr diagnostics. The cheapest way to
 * leak a token is to put a config object into an error message, so redaction
 * lives on the way OUT rather than at each call site that might forget.
 *
 * Two independent nets, because either alone has a blind spot:
 *   - by key   — anything under a secret-looking key is dropped regardless of
 *                its value, which catches short or unusual credentials.
 *   - by shape — recognisable token formats are scrubbed wherever they appear,
 *                including inside free text where no key exists.
 */

export const REDACTED = '[redacted]';

/** Object keys whose value is never safe to emit, whatever it looks like. */
const SECRET_KEY =
  /(?:pass(?:word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|private[-_]?key|session[-_]?id)/i;

/** Credential shapes recognisable without a key to hang them on. */
const SECRET_SHAPED: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\bAKIA[0-9A-Z]{16}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Deep structures are truncated rather than walked forever. */
const MAX_DEPTH = 8;

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_SHAPED) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Recursively redact a value. Cycles are broken by a seen-set rather than by
 * throwing: a tool that accidentally returns a cyclic object should degrade to
 * a marker, not crash the surface mid-response.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return out;
}

/** Error text safe to hand back to a client or write to stderr. */
export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message);
}
