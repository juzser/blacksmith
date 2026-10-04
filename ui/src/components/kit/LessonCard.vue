<script setup lang="ts">
// LessonCard — ds-spec.md §4.5: "Each lesson is a card: 'Applies to all
// projects - learned from csb-audit-1 on 7 Sep - hasn't prevented a repeat
// yet'." Replaces the raw lessonType/lessonScope/timesPrevented table cells
// with the same three sentences everywhere this card is used: the list
// (LessonsPage.vue) and the review Dialog's body (same card, read-only).
//
// `clickable` switches the root between a `<button>` (the list, one per
// row) and a plain `<div>` (the Dialog body) rather than two components,
// since both render identical content — only whether the whole card is
// itself the row's click target differs.
import type { LessonRecord } from '../../lib/api.js';
import { learnedFromLabel, lessonScopeLabel, preventedLabel } from '../../lib/lessonLabels.js';
import Card from './Card.vue';
import Tag from './Tag.vue';

const props = defineProps<{
  lesson: LessonRecord;
  /** One-line phone row (ds-spec.md shell table: Lessons -> "one-line lesson rows"). */
  compact?: boolean;
  /** Renders the card as the row's own click target (the list). */
  clickable?: boolean;
}>();

const emit = defineEmits<{ click: [] }>();

function onClick() {
  if (props.clickable) emit('click');
}
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    class="bs-lessoncard"
    :class="{ 'bs-lessoncard--compact': compact, 'bs-lessoncard--clickable': clickable }"
    @click="onClick"
  >
    <template v-if="compact">
      <span class="bs-lessoncard__statement">{{ lesson.statement }}</span>
      <Tag size="sm" variant="outline">{{
        lessonScopeLabel(lesson.lessonScope, {
          agentRole: lesson.agentRole,
          claimPath: lesson.claimPath,
          caseType: lesson.caseType,
        })
      }}</Tag>
      <span class="bs-lessoncard__meta">
        {{ learnedFromLabel(lesson.sessionId, lesson.validFrom) }} · {{ preventedLabel(lesson.timesPrevented) }}
      </span>
    </template>
    <Card v-else padding="sm">
      <p class="bs-lessoncard__statement">{{ lesson.statement }}</p>
      <Tag size="sm" variant="outline">{{
        lessonScopeLabel(lesson.lessonScope, {
          agentRole: lesson.agentRole,
          claimPath: lesson.claimPath,
          caseType: lesson.caseType,
        })
      }}</Tag>
      <p class="bs-lessoncard__meta">{{ learnedFromLabel(lesson.sessionId, lesson.validFrom) }}</p>
      <p class="bs-lessoncard__meta">{{ preventedLabel(lesson.timesPrevented) }}</p>
    </Card>
  </component>
</template>
