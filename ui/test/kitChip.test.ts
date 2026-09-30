// Chip (ds-spec.md §2.1 line 370: `variant: assignee|identity`, `color?`
// (identity tone index 1-6), `avatarInitial?`; states "default, hover
// (assignee chip is a link to a role/agent)"). A primitive stays dumb: the
// hash(id) -> chart-slot lookup lives in lib/identityColor.ts for a future
// IdentityChip composite (§2.2, out of DS0 scope) to call — Chip only paints
// whichever 1-6 slot it's given. Border + dot carry the identity colour; the
// label text never does, so contrast can't regress with a new id (mirrors
// the old kit's IdentityChip.vue).
//
// Deviation: the spec's props/variants column has no navigation prop, but its
// states column requires "hover (assignee chip is a link to a role/agent)" —
// an interactive state a <span> can't have. This adds an undocumented
// `href?: string`: present -> renders <a>, absent -> <span>. Flagged for the
// PR report, not a silent addition.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const CHIP = readFileSync(join(KIT, 'Chip.vue'), 'utf8');

describe('kit/Chip.vue', () => {
  it('requires variant assignee|identity', () => {
    expect(CHIP).toMatch(/variant:\s*'assignee'\s*\|\s*'identity';/);
  });

  it('declares optional color as a 1-6 identity tone index', () => {
    expect(CHIP).toMatch(/color\?:\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|\s*6;/);
  });

  it('declares optional avatarInitial and href', () => {
    expect(CHIP).toMatch(/avatarInitial\?:\s*string;/);
    expect(CHIP).toMatch(/href\?:\s*string;/);
  });

  it('renders as an anchor when href is set, a span otherwise', () => {
    expect(CHIP).toMatch(/<component\s+:is="href \? 'a' : 'span'"/);
  });

  it('binds the static bs-chip class and a dynamic bs-chip--<variant> modifier', () => {
    expect(CHIP).toMatch(/class="bs-chip"/);
    expect(CHIP).toMatch(/:class="\[`bs-chip--\$\{variant\}`\]"/);
  });

  it('renders an avatar initial when given, otherwise a decorative dot', () => {
    expect(CHIP).toMatch(/bs-chip__avatar/);
    expect(CHIP).toMatch(/bs-chip__dot/);
    expect(CHIP).toMatch(/aria-hidden="true"/);
  });

  it('paints the identity colour from the chart token slot, never a hardcoded hex', () => {
    expect(CHIP).toMatch(/var\(--bs-chart-\$\{props\.color\}\)/);
    expect(CHIP).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
