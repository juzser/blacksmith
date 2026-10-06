// A foreign store's Kanban card must open its own task: the store id travels
// from the card to the peek panel and the task page, and reaches the API.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTaskDetail, fetchTaskRuns } from '../src/lib/api.js';
import { findGroupMember, groupFollowups } from '../src/lib/kanban.js';
import { foreignStoreId } from '../src/lib/storeKey.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]) => readFileSync(join(here, '..', 'src', ...p), 'utf8');

describe('foreignStoreId', () => {
  it('is undefined for the served store and for a row with no store', () => {
    expect(foreignStoreId({})).toBeUndefined();
    expect(foreignStoreId({ store: { id: 'home', label: 'home' } })).toBeUndefined();
  });
  it('is the store id of a foreign row', () => {
    expect(foreignStoreId({ store: { id: 'ab12cd34', label: 'project-b' } })).toBe('ab12cd34');
  });
});

describe('task reads carry the store id', () => {
  const calls: string[] = [];
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });
  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }
  it('adds ?store= for a foreign task and nothing for the served one', async () => {
    stubFetch();
    await fetchTaskDetail('e1/t1', 'ab12cd34');
    await fetchTaskRuns('e1/t1', 'ab12cd34');
    await fetchTaskDetail('e1/t1');
    expect(calls).toEqual([
      '/api/tasks/e1%2Ft1?store=ab12cd34',
      '/api/tasks/e1%2Ft1/runs?store=ab12cd34',
      '/api/tasks/e1%2Ft1',
    ]);
  });
});

describe('findGroupMember across stores', () => {
  const task = (store: string, taskId: string) => ({
    taskId,
    store: { id: store, label: store },
    parentTaskId: 'e1/t1',
    parentTitle: null,
    updatedAt: '2026-01-01T00:00:00Z',
  });
  it('matches the member of the named store only', () => {
    const items = groupFollowups(
      [
        task('home', 'e1/f1'),
        task('home', 'e1/f2'),
        task('ab12cd34', 'e1/f1'),
        task('ab12cd34', 'e1/f3'),
      ] as never[],
      'done',
    );
    const home = findGroupMember(items, 'e1/f1');
    const foreign = findGroupMember(items, 'e1/f1', 'ab12cd34');
    expect(home).not.toBeNull();
    expect(foreign).not.toBeNull();
    expect(home?.key).not.toBe(foreign?.key);
  });
});

describe('the store id reaches the peek panel and the task page', () => {
  it('the board hands the peek its store and re-emits it on open-full', () => {
    const board = src('components', 'KanbanBoard.vue');
    expect(board).toMatch(/:store-id="peekStoreId"/);
    expect(board).toMatch(/emit\('select', id, peekStoreId\)/);
  });
  it('the Kanban page puts the store in the task URL and the router passes it on', () => {
    expect(src('pages', 'KanbanPage.vue')).toMatch(/query: storeId \? \{ store: storeId \}/);
    expect(src('router.ts')).toMatch(/r\.query\.store/);
  });
  it('the task page keeps served-store-only reads empty for a foreign task', () => {
    const page = src('pages', 'TaskDetailPage.vue');
    expect(page).toMatch(/fetchTaskDetail\(props\.taskId, props\.storeId\)/);
    expect(page).toMatch(/if \(foreign\.value\) \{\s*historyLoading\.value = false;/);
    expect(page).toMatch(/!foreign\.value && isWaivable/);
  });
});
