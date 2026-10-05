// HomePage.vue (ds-spec.md §4.1). Numbers and sentences are tested on
// lib/homeView.ts; this pins the page's layout and data wiring by source
// text, the same style as the other page tests (no DOM harness here).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'HomePage.vue'),
  'utf8',
);
const TEMPLATE = SRC.slice(SRC.indexOf('<template>'));

describe('HomePage.vue', () => {
  it('lays out the §4.1 sections in order, inbox first', () => {
    const order = [
      '<NeedsYouInbox',
      '>Recent activity</h2>',
      '>Running now</h2>',
      '>What the factory decided recently</h2>',
      '>Budget</h2>',
    ].map((marker) => TEMPLATE.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders Recent activity directly under the inbox (DS6 PR4, §4.1 point 1b)', () => {
    expect(SRC).toMatch(/fetchTimelinePage\(\{[\s\S]*?limit: RECENT_ACTIVITY_SHOWN/);
    expect(TEMPLATE).toMatch(/<TimelineRow[\s\S]*?variant="compact"/);
    expect(TEMPLATE).not.toContain('Expand all');
    expect(TEMPLATE).toMatch(/<RouterLink to="\/activity"[^>]*>View all activity<\/RouterLink>/);
  });

  it('reuses the existing endpoints with the page scope', () => {
    expect(SRC).toMatch(/fetchOverview\(sessionScope\.value, project\.value\)/);
    expect(SRC).toMatch(/fetchInbox\(sessionScope\.value\)/);
    expect(SRC).toMatch(/<NeedsYouInbox :rows="inbox" :failed="inboxFailed" :project="project"/);
  });

  it('clears each error on success, not on attempt (D-226)', () => {
    expect(SRC).toMatch(/overview\.value = o;[\s\S]*?overviewFailed\.value = false;/);
    expect(SRC).toMatch(/inbox\.value = \(await fetchInbox[\s\S]*?inboxFailed\.value = false;/);
  });

  it('shows the §3 error banner with a retry', () => {
    expect(TEMPLATE).toMatch(
      /<Banner v-if="overviewFailed" show-retry @retry="loadOverview">Could not load Home\.<\/Banner>/,
    );
  });

  it('builds Running now and Just finished from lib/homeView.ts', () => {
    expect(SRC).toMatch(/runningNowCards\(overview\.value, project\.value\)/);
    expect(SRC).toMatch(/trackJustFinished\(seenInFlight, o\)/);
    expect(TEMPLATE).toContain('Just finished');
  });

  it('remembers in-flight epics at module scope, so navigating away and back keeps them', () => {
    const plainScript = SRC.slice(0, SRC.indexOf('<script setup'));
    expect(plainScript).toMatch(/const seenInFlight = new Set<string>\(\)/);
  });

  it('links each project card to Work filtered by that project, not /flow', () => {
    expect(SRC).toMatch(/path: '\/work\/kanban', query: \{ project: p \}/);
    expect(TEMPLATE).not.toContain('/flow');
  });

  it('words each decision through decisionLine (roleLabels)', () => {
    expect(TEMPLATE).toMatch(/\{\{ decisionLine\(d\) \}\}/);
  });

  it('flags budget outliers with a Details link', () => {
    expect(TEMPLATE).toMatch(
      /outlierSentence\(budget\.outliers\.length\)[\s\S]*?<RouterLink to="\/analytics">Details<\/RouterLink>/,
    );
  });

  it('is built on the BS kit only', () => {
    expect(SRC).not.toMatch(/components\/ds\//);
  });

  it('links each running card to its project Sessions history (DS8 PR3 item 5)', () => {
    expect(SRC).toMatch(/path: '\/sessions', query: \{ project: p \}/);
    expect(TEMPLATE).toMatch(/:to="sessionsLink\(c\.project\)"[\s\S]*?Sessions/);
  });
});
