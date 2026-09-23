import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeFilePath } from '../../src/findings.js';

/**
 * Reconstructs the pre-#178 (pre-3e7a8a8) fingerprint algorithm byte for
 * byte, from the version of computeFingerprint that shipped before this PR's
 * normalizer widening (git rev 1fcf554, factory/orchestrator/src/findings.ts
 * lines 360-408). `normalizeFilePath` is untouched by that widening — only
 * `stripPathLineRef` (no line-*span* pattern, just a trailing `:digits`
 * anchor) and `normalizeSummary` (no LINE_SPAN_RE/LINE_COUNT_RE/
 * GITHUB_LINE_RANGE_RE stripping) changed — so those two are the only
 * functions reimplemented here. Shared by any test that needs a fingerprint
 * a pre-widening `raiseFinding()` would actually have written, to prove a
 * fresh (post-widening) comparison still recognizes it.
 */
function legacyEscapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyStripPathLineRef(summary: string, filePath: string): string {
  const forwardSlashPath = filePath.replace(/\\/g, '/');
  const candidates = new Set([filePath, forwardSlashPath, path.posix.basename(forwardSlashPath)]);
  let result = summary;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const pattern = new RegExp(`${legacyEscapeRegExp(candidate)}:\\d+(?::\\d+)?`, 'g');
    result = result.replace(pattern, candidate);
  }
  return result;
}

function legacyNormalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function legacyComputeFingerprint(input: {
  filePath: string;
  category: string;
  summary: string;
}): string {
  const summaryWithoutLineRef = legacyStripPathLineRef(input.summary, input.filePath);
  const material = [
    normalizeFilePath(input.filePath),
    input.category,
    legacyNormalizeSummary(summaryWithoutLineRef),
  ].join(' ');
  return createHash('sha256').update(material).digest('hex');
}
