// The Kanban card's measured two-line title fit, shared by KanbanTaskCard and
// KanbanFollowupGroup. A CSS line clamp would cut an inline copy icon along
// with the text, so the title is fitted by measurement instead: when it renders
// taller than TITLE_LINES lines, binary-search the longest prefix that still
// fits with a trailing "…". Trial strings are written straight to the head and
// tail text nodes, so only the final result is set on a ref.
//
// The element must render `{{ head }}<span class="bs-kanban-card__title-tail">{{ tail }}…</span>`.

import { computed, nextTick, onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { fitTitleText } from '../lib/kanban.js';

const TITLE_LINES = 2;
const WORD_CUT_SLACK = 8;
// The last word travels with the copy icon in one nowrap span, so the icon can
// never wrap onto a line of its own: it always sits right after the last word.
// A token too long to keep unbroken (it would overflow the card) is not glued.
const GLUE_MAX = 24;

function splitTitle(text: string): { head: string; tail: string } {
  const m = /^(.*?)(\S+)$/s.exec(text);
  return m && m[2].length <= GLUE_MAX ? { head: m[1], tail: m[2] } : { head: text, tail: '' };
}

export function useFittedTitle(titleEl: Ref<HTMLElement | null>, title: Ref<string>) {
  const fitted = ref<string | null>(null);
  const shownTitle = computed(() => fitted.value ?? title.value);
  const titleSplit = computed(() => splitTitle(shownTitle.value));
  const titleHead = computed(() => titleSplit.value.head);
  const titleTail = computed(() => titleSplit.value.tail);

  let titleObserver: ResizeObserver | null = null;
  let lastWidth = 0;
  function fitTitle() {
    const el = titleEl.value;
    const headNode = el?.firstChild;
    const tailNode = el?.querySelector('.bs-kanban-card__title-tail')?.firstChild;
    if (!el || !headNode || !tailNode) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    if (el.clientWidth === 0 || !Number.isFinite(lineHeight)) return;
    const full = title.value;
    // `current` is what the DOM shows now: the full title unless a cut is applied.
    // Writing only on change keeps the first measurement free of layout thrash.
    let current = fitted.value ?? full;
    const show = (text: string) => {
      if (text === current) return;
      current = text;
      const { head, tail } = splitTitle(text);
      headNode.textContent = head;
      tailNode.textContent = tail;
    };
    const result = fitTitleText(
      full,
      (text) => {
        show(text);
        return el.getBoundingClientRect().height <= TITLE_LINES * lineHeight + 1;
      },
      WORD_CUT_SLACK,
    );
    show(result ?? full);
    fitted.value = result;
  }
  function onTitleResize() {
    const width = titleEl.value?.clientWidth ?? 0;
    if (width === lastWidth) return;
    lastWidth = width;
    fitTitle();
  }
  onMounted(() => {
    const el = titleEl.value;
    if (!el) return;
    lastWidth = el.clientWidth;
    fitTitle();
    if (typeof ResizeObserver === 'undefined') return;
    titleObserver = new ResizeObserver(onTitleResize);
    titleObserver.observe(el);
  });
  onBeforeUnmount(() => titleObserver?.disconnect());
  watch(title, async () => {
    fitted.value = null;
    await nextTick();
    fitTitle();
  });

  return { fitted, titleHead, titleTail };
}
