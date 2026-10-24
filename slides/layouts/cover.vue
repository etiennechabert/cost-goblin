<!-- Title slide: the website's hero (badge, gradient title, glowing goblin).
     `badge` sits above the title; `provider` and `pipeline` below it. -->
<script setup lang="ts">
import Goblin from '../components/Goblin.vue'
import ProviderMark from '../components/ProviderMark.vue'

defineProps<{ badge?: string; provider?: 'aws' | 'gcp'; pipeline?: string }>()
</script>

<template>
  <div class="slidev-layout cover">
    <div class="cover-text">
      <div v-if="badge" class="cover-badge">
        <span class="cover-dot" />{{ badge }}
      </div>
      <slot />
      <div v-if="provider || pipeline" class="cover-pipeline">
        <ProviderMark v-if="provider" :provider="provider" />
        <span v-if="pipeline">{{ pipeline }}</span>
      </div>
    </div>
    <div class="cover-art">
      <Goblin />
    </div>
  </div>
</template>

<style scoped>
.cover {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  align-items: center;
  gap: 24px;
  padding-bottom: 38px;
}

/* Behind the text: a positioned pseudo-element otherwise paints over the
   (unpositioned) text column it overlaps. */
.cover::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 8%;
  right: -4%;
  width: 62%;
  height: 90%;
  background: radial-gradient(ellipse, rgba(16, 185, 129, 0.16) 0%, transparent 68%);
  pointer-events: none;
}

.cover-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 22px;
  padding: 5px 14px;
  border: 1px solid var(--cg-emerald-dim);
  border-radius: 100px;
  background: rgba(16, 185, 129, 0.05);
  font-family: var(--cg-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--cg-emerald);
}

.cover-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cg-emerald);
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.8);
}

.cover :deep(h1) {
  margin-bottom: 16px;
  font-size: 50px;
  font-weight: 700;
  line-height: 1.04;
  letter-spacing: -0.035em;
}

.cover :deep(h1 + p) {
  max-width: 440px;
  font-size: 19px;
  line-height: 1.55;
}

.cover-pipeline {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-top: 26px;
  padding: 9px 16px;
  border: 1px solid var(--cg-border);
  border-radius: 10px;
  background: var(--cg-bg-card);
  font-family: var(--cg-font-mono);
  font-size: 13px;
  color: var(--cg-text-dim);
}

.cover-pipeline :deep(svg) {
  font-size: 20px;
}

.cover-art {
  position: relative;
  display: flex;
  justify-content: center;
  height: 380px;
}
</style>
