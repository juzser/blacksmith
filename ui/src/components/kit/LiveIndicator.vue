<script setup lang="ts">
// The app shell's single liveness readout + control cluster (ds-spec.md
// §2.2 `LiveIndicator`), replacing the old two-clock App.vue (a pulse <span>
// plus a separate LiveStatus.vue) and its separately-placed theme toggle.
// One dot/text pair, one Refresh, one Pause (stops usePoll.ts's shared
// interval/stream triggers app-wide), one theme toggle, one disabled
// Settings placeholder (no settings surface exists yet — §5 DS1 scope).
import { Moon, Pause, Play, RefreshCw, Settings, Sun } from '@lucide/vue';
import { computed, ref } from 'vue';
import IconButton from './IconButton.vue';
import RelativeTime from './RelativeTime.vue';

const props = defineProps<{
  lastEventAt: string | null;
  now: string;
  live: boolean;
  theme: 'light' | 'dark';
}>();
const emit = defineEmits<{ refresh: []; togglePause: []; toggleTheme: [] }>();

const statusLabel = computed(() => (props.live ? 'Live' : 'Paused'));

// Refresh is aria-disabled while a refresh request it triggered is still in
// flight — a brief debounce so a second click cannot queue a second refetch
// on top of one already running. Reset on a short timer rather than an actual
// promise: triggerGlobalRefresh() (usePoll.ts) is fire-and-forget by design,
// it has no completion to await. It is also aria-disabled while live is on
// (ds-spec.md §2.2): the shared poll/stream already keeps data current, so a
// manual refresh only makes sense once updates are paused.
const pending = ref(false);
function onRefresh() {
  if (pending.value || props.live) return;
  pending.value = true;
  emit('refresh');
  setTimeout(() => {
    pending.value = false;
  }, 800);
}
</script>

<template>
  <div class="bs-live" role="status" aria-live="polite">
    <span class="bs-live__dot" :data-live="live" aria-hidden="true"></span>
    <!-- Item 7 of the mock-conformance brief: the mock reads
         "Live · updated 8 s ago", a middle dot (fine — only em/en-dash is
         banned by check_no_emoji.py as an AI-pattern tell). This value is
         `lastEventAt`, the last recorded event, not a poll timestamp — no
         separate last-poll time exists in usePoll.ts to swap in, so the
         wording stays "last activity" rather than the mock's "updated" to
         keep it honest about what it actually measures; only the separator
         changes to match. -->
    <span class="bs-live__text"
      >{{ lastEventAt ? `${statusLabel} · last activity ` : statusLabel }}<RelativeTime
        v-if="lastEventAt"
        :iso="lastEventAt"
        :now="now"
    /></span>
    <IconButton
      :icon="live ? Pause : Play"
      :label="live ? 'Pause updates' : 'Resume updates'"
      size="sm"
      @click="emit('togglePause')"
    />
    <IconButton
      :icon="RefreshCw"
      label="Refresh now"
      size="sm"
      :disabled="pending || live"
      @click="onRefresh"
    />
    <IconButton
      :icon="theme === 'dark' ? Sun : Moon"
      :label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
      size="sm"
      @click="emit('toggleTheme')"
    />
    <IconButton :icon="Settings" label="Settings" size="sm" disabled />
  </div>
</template>
