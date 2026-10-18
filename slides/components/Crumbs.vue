<script setup lang="ts">
import { computed } from 'vue'

// A console path, written with ">" between the steps:
// <Crumbs to="Billing and Cost Management > Data Exports > Create export" />
const props = defineProps<{ to: string }>()

const parts = computed(() => props.to.split('>').map(part => part.trim()).filter(part => part.length > 0))
</script>

<template>
  <span class="cg-crumbs">
    <template v-for="(part, i) in parts" :key="i">
      <span v-if="i > 0" class="i-lucide-chevron-right cg-crumbs-sep" aria-hidden="true" />
      <span class="cg-crumbs-part">{{ part }}</span>
    </template>
  </span>
</template>

<style scoped>
.cg-crumbs {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
  font-family: var(--cg-font-mono);
  font-size: 0.78em;
  color: var(--cg-text-dim);
}

.cg-crumbs-part:last-child {
  color: var(--cg-text);
}

.cg-crumbs-sep {
  color: var(--cg-emerald);
}
</style>
