import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'SessionsPage.vue'),
  'utf8',
);

describe('SessionsPage.vue', () => {
  it('imports no VueFlow and no retired ds/* components', () => {
    expect(PAGE).not.toMatch(/from '@vue-flow\/core'/);
    expect(PAGE).not.toMatch(/from ['"]\.\.\/components\/ds\//);
  });

  it('is built only on kit components', () => {
    expect(PAGE).toMatch(/from '\.\.\/components\/kit\/AgentBlock\.vue'/);
    expect(PAGE).toMatch(/from '\.\.\/components\/kit\/SessionRow\.vue'/);
    expect(PAGE).toMatch(/from '\.\.\/components\/kit\/PageHeader\.vue'/);
  });

  it('keeps the project context, unscoped from useSessionContext', () => {
    expect(PAGE).toMatch(/useProjectContext/);
    expect(PAGE).not.toMatch(/from '\.\.\/composables\/useSessionContext\.js'/);
    expect(PAGE).toMatch(/fetchSessions\(undefined, project\.value\)/);
  });

  it('separates running and finished runs behind a toggle', () => {
    expect(PAGE).toMatch(/showFinished/);
    expect(PAGE).toMatch(/s\.liveAgentCount > 0/);
    expect(PAGE).toMatch(/s\.liveAgentCount === 0/);
  });

  it('loads one run of agents through fetchSessionAgents and renders one AgentBlock per role', () => {
    expect(PAGE).toMatch(/fetchSessionAgents\(id, project\.value\)/);
    expect(PAGE).toMatch(/v-for="r in agents\.roles"/);
  });

  it('polls only while the selected run still has a live agent', () => {
    expect(PAGE).toMatch(/function hasLiveAgents\(\)/);
    expect(PAGE).toMatch(/if \(hasLiveAgents\(\)\) void loadAgents\(\);/);
  });

  it('resolves the deep link through the page-local selection helper, not sessionScope', () => {
    expect(PAGE).toMatch(/selectedSessionFromQuery/);
    expect(PAGE).toMatch(/router\.replace\(\{ query: \{ \.\.\.route\.query, session: id \} \}\)/);
  });

  it('drops a stale loadAgents response instead of overwriting a later selection', () => {
    expect(PAGE).toMatch(/from '\.\.\/lib\/sessionsSelection\.js'/);
    expect(PAGE).toMatch(/if \(isStaleResponse\(id, selectedId\.value\)\) return;/g);
  });

  it('marks the open run selected in both the running and finished lists', () => {
    const matches = PAGE.match(/:selected="selectedId === s\.sessionId"/g);
    expect(matches?.length).toBe(2);
  });
});
