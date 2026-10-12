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
  it('is display-only: no Needs-you region above the sections, nothing to act on', () => {
    expect(SRC).not.toMatch(/NeedsYouInbox|fetchInbox|InboxRow|loadInbox/);
    expect(TEMPLATE).not.toMatch(/needs you/i);
    // Only the fact strip sits between the page header and Live sessions.
    const header = TEMPLATE.indexOf('<PageHeader');
    const firstSection = TEMPLATE.indexOf('<section', header);
    expect(TEMPLATE.slice(firstSection)).toMatch(/^<section[^>]*aria-labelledby="home-facts-h"/);
    const between = TEMPLATE.slice(header, firstSection).replace(/<!--[\s\S]*?-->/g, '');
    expect(between.match(/</g)).toHaveLength(1);
    const afterFacts = TEMPLATE.indexOf('</section>', firstSection) + '</section>'.length;
    const next = TEMPLATE.indexOf('<section', afterFacts);
    expect(TEMPLATE.slice(next)).toMatch(/^<section[^>]*aria-labelledby="live-sessions-heading"/);
    const gap = TEMPLATE.slice(afterFacts, next).replace(/<!--[\s\S]*?-->/g, '');
    expect(gap.trim()).toBe('');
  });

  it('says in its header what the page holds now', () => {
    expect(TEMPLATE).toMatch(
      /<PageHeader title="Home" description="What is running and what it costs\." \/>/,
    );
  });

  it('lays out the §4.1 sections in order, the fact strip first', () => {
    const order = [
      '>Right now</h2>',
      '>Live sessions</h2>',
      '>Recent activity</h2>',
      '>Running now</h2>',
      '>What the factory decided recently</h2>',
      '>Budget</h2>',
    ].map((marker) => TEMPLATE.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('opens with four read-only fact tiles over the active scope (§4.1 item 1)', () => {
    expect(SRC).toMatch(/import StatTile from '\.\.\/components\/kit\/StatTile\.vue';/);
    expect(SRC).toMatch(/factStrip\(liveScope\.value, project\.value\)/);
    expect(SRC).toMatch(/factStripNote\(liveScope\.value\)/);
    const strip = TEMPLATE.slice(
      TEMPLATE.indexOf('aria-labelledby="home-facts-h"'),
      TEMPLATE.indexOf('</section>', TEMPLATE.indexOf('aria-labelledby="home-facts-h"')),
    );
    expect(strip).toMatch(/<h2 id="home-facts-h" class="sr-only">Right now<\/h2>/);
    expect(strip).toMatch(/<dl class="bs-stat-grid">\s*<StatTile\s+v-for="f in facts"/);
    for (const prop of [
      ':label="f.label"',
      ':value="f.value"',
      ':helper="f.helper"',
      ':not-known="f.notKnown"',
      ':floor="f.floor"',
    ]) {
      expect(strip).toContain(prop);
    }
    // Tiles are not links: nothing in the strip can be clicked.
    expect(strip).not.toMatch(/RouterLink|<a\b|<button|@click/);
  });

  it('holds a skeleton in each tile and marks the strip busy while the first answer loads', () => {
    expect(TEMPLATE).toMatch(
      /aria-labelledby="home-facts-h"\s+:aria-busy="liveScope === null \? 'true' : undefined"/,
    );
    expect(TEMPLATE).toMatch(/<StatTile[^>]*:loading="liveScope === null"/);
  });

  it('reads Not known with one footnote on error, and counts unread stores under the strip', () => {
    // factStrip() turns a failed or unmeasured scope into "Not known" tiles,
    // and the page keeps the last good answer (useActiveScope); the note is
    // factStripNote()'s one muted line, on error or for an unread store.
    expect(SRC).toMatch(
      /activeScope\.value \?\? \(activeScopeSettled\.value \? UNMEASURED : null\)/,
    );
    expect(TEMPLATE).toMatch(
      /<p v-if="factsNote" class="bs-home__quiet">\{\{ factsNote \}\}<\/p>\s*<\/section>/,
    );
    expect(TEMPLATE).not.toMatch(/aria-live/);
  });

  it('renders Recent activity directly under Live sessions (DS6 PR4, §4.1 point 1b)', () => {
    expect(SRC).toMatch(/fetchTimelinePage\(\{[\s\S]*?limit: RECENT_ACTIVITY_SHOWN/);
    expect(TEMPLATE).toMatch(/<TimelineRow[\s\S]*?variant="compact"/);
    expect(TEMPLATE).not.toContain('Expand all');
    expect(TEMPLATE).toMatch(/<RouterLink to="\/activity"[^>]*>View all activity<\/RouterLink>/);
  });

  it('lists live CLI sessions at the top from one poll, with every state (§4.1 item 1a)', () => {
    expect(SRC).toMatch(/fetchCliSessions\(\)/);
    expect(SRC.match(/fetchCliSessions/g)?.length).toBe(2);
    expect(TEMPLATE).toMatch(/<RouterLink to="\/sessions"[^>]*>All sessions<\/RouterLink>/);
    expect(TEMPLATE).toContain('Could not load live sessions');
    expect(TEMPLATE).toContain('Could not read the live sessions');
    expect(TEMPLATE).toContain('Session tracking is not set up on this machine.');
    expect(TEMPLATE).toContain('No live Blacksmith sessions');
    expect(TEMPLATE).toMatch(/hidden`/);
    expect(TEMPLATE).toMatch(
      /<ul v-else class="bs-live-list" aria-labelledby="live-sessions-heading"/,
    );
    expect(TEMPLATE).not.toMatch(/aria-live/);
    expect(TEMPLATE).toMatch(/storeKey\(s\.focus \?\? \{\}, s\.cliSessionId\)/);
  });

  it('reuses the existing endpoints with the page scope', () => {
    expect(SRC).toMatch(/fetchOverview\(sessionScope\.value, project\.value\)/);
  });

  it('clears each error on success, not on attempt (D-226)', () => {
    expect(SRC).toMatch(/overview\.value = o;[\s\S]*?overviewFailed\.value = false;/);
  });

  it('shows the §3 error banner with a retry', () => {
    expect(TEMPLATE).toMatch(
      /<Banner v-if="overviewFailed" show-retry @retry="loadOverview">Could not load Home\.<\/Banner>/,
    );
  });

  it('builds Running now and Just finished from lib/homeView.ts', () => {
    expect(SRC).toMatch(
      /runningNowCards\(\s*overview\.value,\s*liveScope\.value,\s*mode\.value,\s*project\.value/,
    );
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

  it('words each decision through decisionLine and shows the full line in title', () => {
    expect(TEMPLATE).toMatch(/\{\{ decisionLine\(d\) \}\}/);
    expect(TEMPLATE).not.toMatch(/:title="decisionLine\(d\)"/);
    expect(TEMPLATE.match(/:title="decisionTitle\(d, decisionsNameProject\)"/g)).toHaveLength(2);
    expect(TEMPLATE).toMatch(/class="bs-home__decision-project"\s+:title="d\.store\.label"/);
  });

  it('flags budget outliers with a Details link', () => {
    expect(TEMPLATE).toMatch(
      /budget\.outlierSentence[\s\S]*?<RouterLink to="\/analytics">Details<\/RouterLink>/,
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
