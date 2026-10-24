<script setup lang="ts">
import { computed } from 'vue'

// `warn` is the website's gold step-callout; `tip` the emerald accent.
const props = withDefaults(defineProps<{
  type?: 'warn' | 'tip' | 'danger' | 'info'
  title?: string
}>(), { type: 'warn' })

const icon = computed(() => ({
  warn: 'i-lucide-triangle-alert',
  tip: 'i-lucide-lightbulb',
  danger: 'i-lucide-octagon-x',
  info: 'i-lucide-info',
})[props.type])
</script>

<template>
  <div class="cg-callout" :class="`cg-callout--${props.type}`">
    <span class="cg-callout-icon" :class="icon" aria-hidden="true" />
    <div class="cg-callout-body">
      <strong v-if="title" class="cg-callout-title">{{ title }}</strong>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.cg-callout {
  --tone: var(--cg-gold);
  --tone-bg: rgba(212, 168, 67, 0.08);
  display: flex;
  gap: 12px;
  margin: 12px 0;
  padding: 12px 16px;
  border: 1px solid var(--tone);
  border-radius: 10px;
  background: var(--tone-bg);
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--cg-text-dim);
}

.cg-callout--tip {
  --tone: rgba(16, 185, 129, 0.55);
  --tone-bg: rgba(16, 185, 129, 0.07);
}

.cg-callout--danger {
  --tone: rgba(248, 113, 113, 0.7);
  --tone-bg: rgba(248, 113, 113, 0.07);
}

.cg-callout--info {
  --tone: var(--cg-border-strong);
  --tone-bg: var(--cg-bg-card);
}

.cg-callout-icon {
  flex-shrink: 0;
  margin-top: 2px;
  font-size: 17px;
  color: var(--tone);
}

.cg-callout--tip .cg-callout-icon {
  color: var(--cg-emerald);
}

.cg-callout--info .cg-callout-icon {
  color: var(--cg-text-muted);
}

.cg-callout-title {
  display: block;
  margin-bottom: 2px;
  color: var(--cg-text);
}

.cg-callout--warn .cg-callout-title {
  color: var(--cg-gold);
}

.cg-callout-body :deep(p) {
  margin: 0;
  font-size: inherit;
}

.cg-callout-body :deep(p + p) {
  margin-top: 6px;
}
</style>
