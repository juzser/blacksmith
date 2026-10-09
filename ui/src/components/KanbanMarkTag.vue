<script setup lang="ts">
// The Now / Next tag of a Kanban card or follow-up group: Now carries the Bot
// icon and the agent's role, Next is plain text.
import { Bot } from '@lucide/vue';
import type { TaskMark } from '../lib/liveFocus.js';
import Icon from './kit/Icon.vue';
import Tag from './kit/Tag.vue';

defineProps<{ mark: TaskMark; text: string }>();
</script>

<template>
  <Tag
    class="bs-agent-chip bs-kanban-card__mark"
    :tone="mark.kind === 'now' ? 'progress' : 'todo'"
    variant="subtle"
    size="sm"
    :title="text"
  >
    <Icon v-if="mark.kind === 'now'" :icon="Bot" :size="14" />
    <span class="bs-agent-chip__text">{{ text }}</span>
  </Tag>
</template>
