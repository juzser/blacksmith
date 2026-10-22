import { describe, expect, it } from 'vitest';
import { formatBriefMarker, parseBriefMarker } from '../src/briefMarker.js';

// Epic bs-optimize criterion 6: the marker is one definition, written by
// brief compose and read by the hook.
const base = { role: 'coder', taskId: 'bs-optimize/task-5-diet-guards', sessionId: 'sess-1' };

describe('briefMarker', () => {
  it('formats the first-line comment', () => {
    expect(formatBriefMarker(base)).toBe(
      '<!-- bs-brief role=coder task=bs-optimize/task-5-diet-guards session=sess-1 -->',
    );
  });

  it('round-trips through parse', () => {
    expect(parseBriefMarker(`${formatBriefMarker(base)}\nbody`)).toEqual(base);
    expect(parseBriefMarker(formatBriefMarker(base))).toEqual(base);
  });

  it('reads a marker after one leading BOM and before CRLF', () => {
    expect(parseBriefMarker(`﻿${formatBriefMarker(base)}\r\nbody`)).toEqual(base);
  });

  it('does not read a second BOM', () => {
    expect(parseBriefMarker(`﻿﻿${formatBriefMarker(base)}\nbody`)).toBeNull();
  });

  it('counts only the whole first line', () => {
    expect(parseBriefMarker(`intro\n${formatBriefMarker(base)}`)).toBeNull();
    expect(parseBriefMarker(`\n${formatBriefMarker(base)}`)).toBeNull();
    expect(parseBriefMarker(`${formatBriefMarker(base)} trailing`)).toBeNull();
    expect(parseBriefMarker(` ${formatBriefMarker(base)}`)).toBeNull();
    expect(parseBriefMarker(`\`\`\`\n${formatBriefMarker(base)}\n\`\`\``)).toBeNull();
  });

  it('refuses an unknown role', () => {
    expect(parseBriefMarker(formatBriefMarker({ ...base, role: 'wizard' }))).toBeNull();
  });

  it('knows the shipped agent roles', () => {
    for (const role of ['coder', 'spec-reviewer', 'security-reviewer', 'uiux', 'wave-runner']) {
      expect(parseBriefMarker(formatBriefMarker({ ...base, role }))?.role).toBe(role);
    }
  });

  it('returns null for non-markers and huge first lines', () => {
    expect(parseBriefMarker('')).toBeNull();
    expect(parseBriefMarker('hello')).toBeNull();
    expect(parseBriefMarker(`<!-- bs-brief role=coder ${'x'.repeat(1_000_000)}`)).toBeNull();
  });
});
