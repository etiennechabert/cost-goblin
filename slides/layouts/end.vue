<!-- The outro: a goblin, the slot (a closing title and what to watch next), and
     where to find CostGoblin. -->
<script setup lang="ts">
import Goblin from '../components/Goblin.vue'

defineProps<{ goblin?: string }>()
</script>

<template>
  <div class="slidev-layout end">
    <div class="end-art">
      <Goblin :name="goblin ?? 'dive'" />
    </div>
    <div class="end-text">
      <slot />
      <div class="end-links">
        <span><span class="i-lucide-globe" aria-hidden="true" />costgoblin.com</span>
        <span><span class="i-lucide-github" aria-hidden="true" />github.com/etiennechabert/cost-goblin</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.end {
  display: grid;
  grid-template-columns: 0.9fr 1.3fr;
  align-items: center;
  gap: 36px;
  padding-bottom: 38px;
}

.end-art {
  display: flex;
  justify-content: center;
  height: 330px;
}

.end :deep(h1) {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.end-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 24px;
  font-family: var(--cg-font-mono);
  font-size: 14px;
  color: var(--cg-text);
}

.end-links > span {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.end-links [class^='i-'] {
  font-size: 16px;
  color: var(--cg-emerald);
}
</style>
