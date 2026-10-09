// What a Home "Live sessions" card says (ds-spec.md §4.1 item 1a). The
// component only lays this out; wording, null guards and link targets live
// here, where the DOM-free unit suite can hold them.
import { roleLabel } from './roleLabels.js';
import { foreignStoreId, type StoreRef } from './storeKey.js';

export type LiveStatus = 'working' | 'waiting_answer' | 'waiting_operator' | 'idle' | 'unknown';

/** The part of a `/api/cli-sessions` linked epic the Kanban Now / Next marks read. */
export interface LiveLinkedEpic {
  store: StoreRef;
  epicId: string | null;
  closed: boolean;
  workingAgents: { role: string; taskId: string | null; since: string }[];
  focusParts: { nextTask: { taskId: string; taskTitle: string } | null };
}

/** The part of the `/api/cli-sessions` card this view reads. */
export interface LiveCard {
  cliSessionId: string;
  name: string | null;
  cwdLabel: string;
  status: LiveStatus;
  statusSince: string | null;
  focus: {
    store: StoreRef;
    project: string | null;
    epicId: string;
    epicTitle: string | null;
    wave: number | null;
    now: { role: string; taskId: string | null; taskTitle: string | null; since: string }[];
    next:
      | { kind: 'task'; taskId: string; taskTitle: string }
      | { kind: 'waiting_on_you' }
      | { kind: 'none' }
      | null;
  } | null;
  linked?: { epics: LiveLinkedEpic[] } | null;
}

export interface LiveSessionsResult {
  state: 'ok' | 'absent' | 'unreadable';
  formatWarning: string | null;
  hidden: { outOfScope: number; dead: number; unparsed: number; nonInteractive: number };
  sessions: LiveCard[];
}

export const NOW_LINES_DESKTOP = 2;
export const NOW_LINES_PHONE = 1;

const STATUS = {
  working: { tone: 'progress', label: 'Working' },
  waiting_answer: { tone: 'warning', label: 'Waiting for your answer' },
  waiting_operator: { tone: 'warning', label: 'Waiting for you' },
  idle: { tone: 'neutral', label: 'Idle' },
  unknown: { tone: 'neutral', label: 'Status unknown' },
} as const;

export interface LiveCardView {
  title: string;
  /** Unlinked only: the session name, shown muted after the title. */
  titleMuted: string | null;
  titleLink: { path: string; query: { epic: string } } | null;
  titleLabel: string | null;
  titleTooltip: string | null;
  status: { tone: 'progress' | 'warning' | 'neutral'; label: string };
  since: string | null;
  meta: string | null;
  now: { role: string; taskTitle: string | null; to: string | null }[];
  moreCount: number;
  next:
    | { kind: 'task'; taskTitle: string; to: string }
    | { kind: 'waiting' }
    | { kind: 'none' }
    | null;
}

function taskLink(taskId: string | null, store: StoreRef): string | null {
  if (taskId === null) return null;
  const foreign = foreignStoreId({ store });
  return `/tasks/${encodeURIComponent(taskId)}${foreign ? `?store=${encodeURIComponent(foreign)}` : ''}`;
}

export function liveCardView(
  card: LiveCard,
  opts: { phone: boolean; expanded: boolean },
): LiveCardView {
  const status = STATUS[card.status] ?? STATUS.unknown;
  const since = card.statusSince;
  const f = card.focus;
  if (f === null) {
    return {
      title: card.cwdLabel,
      titleMuted: card.name ? ` · ${card.name}` : null,
      titleLink: null,
      titleLabel: null,
      titleTooltip: null,
      status,
      since,
      meta: 'Not linked to a Blacksmith epic',
      now: [],
      moreCount: 0,
      next: null,
    };
  }
  const limit = opts.phone ? NOW_LINES_PHONE : NOW_LINES_DESKTOP;
  const shown = opts.expanded ? f.now : f.now.slice(0, limit);
  const named = f.epicTitle ?? f.epicId;
  return {
    title: [f.project, f.epicId, f.wave === null ? null : `wave ${f.wave}`]
      .filter((p): p is string => p !== null && p !== '')
      .join(' · '),
    titleMuted: null,
    titleLink: { path: '/work/kanban', query: { epic: f.epicId } },
    titleLabel: `Open epic ${named}`,
    titleTooltip: named,
    status,
    since,
    meta: null,
    now: shown.map((a) => ({
      role: roleLabel(a.role),
      taskTitle: a.taskTitle,
      to: a.taskTitle === null ? null : taskLink(a.taskId, f.store),
    })),
    moreCount: f.now.length - shown.length,
    next:
      f.next === null
        ? null
        : f.next.kind === 'task'
          ? {
              kind: 'task',
              taskTitle: f.next.taskTitle,
              to: taskLink(f.next.taskId, f.store) as string,
            }
          : f.next.kind === 'waiting_on_you'
            ? { kind: 'waiting' }
            : { kind: 'none' },
  };
}

export function hiddenCount(h: LiveSessionsResult['hidden']): number {
  return h.outOfScope + h.dead + h.unparsed + h.nonInteractive;
}
