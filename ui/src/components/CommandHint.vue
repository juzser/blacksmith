<script setup lang="ts">
// Operator directive (Phase 6b round 10): "Thêm block nho nhỏ ở Overview để
// hướng dẫn dùng các command /bs, hoặc trong Projects với command /bs new để
// tạo project mới."
//
// The dashboard shows what the factory did; nothing on it starts anything.
// Every verb lives in the `/bs` skill (.claude/skills/bs/SKILL.md), which is
// discoverable only if you already know it exists. This block closes that gap
// in the one place the question comes up — and says plainly where the commands
// are typed, so the block cannot be mistaken for a control the page offers.
//
// Deliberately not a copy-to-clipboard button: these are short enough to type,
// and a button here could not be verified in this session (no browser).
// Deliberately hardcoded, not fetched: the subcommand list is a property of the
// installed skill, not of the factory's state, and there is no API for it.
export interface CommandHintItem {
  cmd: string;
  desc: string;
}

withDefaults(defineProps<{ items: CommandHintItem[]; note?: string }>(), {
  note: 'Typed in Claude Code, from the black-smith repo. This dashboard reads state, it does not drive the factory.',
});
</script>

<template>
  <div class="cmd-hint">
    <ul class="cmd-hint__list">
      <li v-for="c in items" :key="c.cmd" class="cmd-hint__item">
        <code class="cmd-hint__cmd">{{ c.cmd }}</code>
        <span class="cmd-hint__desc">{{ c.desc }}</span>
      </li>
    </ul>
    <p class="cmd-hint__note">{{ note }}</p>
  </div>
</template>
