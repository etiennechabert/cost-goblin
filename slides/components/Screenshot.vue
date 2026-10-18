<script setup lang="ts">
import { computed } from 'vue'

// The website's app screenshots (docs/screenshots), in a window frame.
// `name` is the file name without .png, e.g. "hero-final-service".
const shots = import.meta.glob<string>('@site/screenshots/*.png', { eager: true, import: 'default' })

const props = defineProps<{ name: string }>()

const src = computed(() => Object.entries(shots).find(([path]) => path.endsWith(`/${props.name}.png`))?.[1])
</script>

<template>
  <figure class="cg-shot">
    <div class="cg-shot-bar" aria-hidden="true">
      <span /><span /><span />
    </div>
    <img v-if="src" :src="src" alt="">
  </figure>
</template>

<style scoped>
.cg-shot {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--cg-border-strong);
  border-radius: 12px;
  background: var(--cg-bg-raised);
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.4),
    0 24px 80px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(16, 185, 129, 0.06);
}

.cg-shot-bar {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--cg-border);
}

.cg-shot-bar span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cg-border-strong);
}

.cg-shot img {
  display: block;
  width: 100%;
  height: auto;
}
</style>
