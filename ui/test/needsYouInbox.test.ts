// NeedsYouInbox.vue (ds-spec.md §2.2, §4.1 point 1). The grouping and
// per-kind rules are tested on lib/inbox.ts; this file pins the template's
// side of the contract with source-text reads, same style as
// overviewPage.test.ts: no DOM harness exists in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'NeedsYouInbox.vue'),
  'utf8',
);

describe('NeedsYouInbox.vue', () => {
  it('is built on the BS kit, not the old ds kit', () => {
    expect(SRC).toMatch(/from '\.\/kit\/Tag\.vue'/);
    expect(SRC).not.toMatch(/from '\.\/ds\//);
  });

  it('groups through lib/inbox.ts groupInbox with the selected project', () => {
    expect(SRC).toMatch(/groupInbox\([^)]*props\.project\)/);
  });

  it('renders the group header as "name · count"', () => {
    expect(SRC).toMatch(/\{\{ g\.label \}\} · \{\{ g\.rows\.length \}\}/);
  });

  it('renders the description only when present, never a placeholder', () => {
    expect(SRC).toMatch(/v-if="r\.description"/);
    expect(SRC).not.toMatch(/r\.description \?\?/);
    expect(SRC).not.toMatch(/r\.description \|\|/);
  });

  it('links each row to the page for its kind', () => {
    expect(SRC).toMatch(/<RouterLink[\s\S]*?:to="inboxActionTarget\(r\)"/);
    expect(SRC).toMatch(/INBOX_KIND\[r\.kind\]\.action/);
  });

  it('shows the spec empty state', () => {
    expect(SRC).toContain('title="Nothing needs you right now."');
    expect(SRC).toMatch(/<EmptyState[\s\S]*?body="[^"]+"/);
  });

  it('shows a skeleton before the first response and a retry banner on failure (§3)', () => {
    expect(SRC).toMatch(/v-if="rows === null && !failed"[\s\S]*?<Skeleton/);
    expect(SRC).toMatch(/<Banner v-if="failed" show-retry @retry="emit\('retry'\)">Could not load/);
  });

  it('drops the filter chips on phone and folds groups into details, first one open (§3.1)', () => {
    expect(SRC).toMatch(/v-if="!isPhoneWidth" class="bs-inbox__filters"/);
    expect(SRC).toMatch(/:is="isPhoneWidth \? 'details' : 'div'"/);
    expect(SRC).toMatch(/:open="isPhoneWidth && gi === 0/);
  });

  it('marks the pressed filter chip for assistive tech', () => {
    expect(SRC).toMatch(/:aria-pressed="filter === f\.id/);
  });

  it('labels each action link with its verb and the row title, not just "Open"/"Review" (F5)', () => {
    expect(SRC).toMatch(
      /<RouterLink[\s\S]*?:aria-label="`\$\{INBOX_KIND\[r\.kind\]\.action\}: \$\{r\.title\}`"[\s\S]*?:to="inboxActionTarget\(r\)"/,
    );
  });

  // Visual-pass item 1 (§3.1): on phone, the single most urgent row (first
  // group, first row) gets a full-width 44px "Decide" button instead of the
  // inline per-kind label; every other row keeps the small inline link.
  it('gives only the most urgent row on phone a full-width 44px "Decide" button, not the per-kind label', () => {
    expect(SRC).toMatch(
      /<RouterLink\s+v-if="isPhoneWidth && gi === 0 && ri === 0"[\s\S]*?class="bs-btn bs-btn--primary bs-btn--touch bs-btn--block bs-inbox__decide"[\s\S]*?:aria-label="`Decide: \$\{r\.title\}`"[\s\S]*?:to="inboxActionTarget\(r\)"[\s\S]*?>\s*Decide\s*<\/RouterLink>/,
    );
  });

  it('keeps the small secondary link for every row that is not the single most urgent one', () => {
    expect(SRC).toMatch(
      /<RouterLink\s+v-else[\s\S]*?class="bs-btn bs-btn--sm bs-btn--secondary"[\s\S]*?:aria-label="`\$\{INBOX_KIND\[r\.kind\]\.action\}: \$\{r\.title\}`"/,
    );
  });

  it('marks the decide row so it can wrap the button onto its own full-width line', () => {
    expect(SRC).toMatch(
      /:class="\{ 'bs-inbox__row--decide': isPhoneWidth && gi === 0 && ri === 0 \}"/,
    );
  });
});
