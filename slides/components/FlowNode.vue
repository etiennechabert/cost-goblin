<script setup lang="ts">
// `icon` is an icon class, e.g. "i-lucide-database".
defineProps<{ title: string; sub?: string; icon?: string; accent?: boolean }>()
</script>

<template>
  <div class="cg-node" :class="{ 'cg-node--accent': accent }">
    <span v-if="icon" class="cg-node-icon" :class="icon" aria-hidden="true" />
    <div class="cg-node-title">{{ title }}</div>
    <div v-if="sub" class="cg-node-sub">{{ sub }}</div>
  </div>
</template>
