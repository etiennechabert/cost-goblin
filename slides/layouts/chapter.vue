<!-- Opens a chapter of the video (and a YouTube chapter): a big step number,
     "Step N of M" (or `kicker`), the title, and one of the app's goblins. -->
<script setup lang="ts">
import { computed } from 'vue'
import Goblin from '../components/Goblin.vue'

// `goblin` names one of the splash goblins listed in Goblin.vue.
const props = defineProps<{ step?: number; of?: number; kicker?: string; goblin?: string }>()

const number = computed(() => props.step === undefined ? '' : String(props.step).padStart(2, '0'))
const label = computed(() => {
  if (props.kicker !== undefined)
    return props.kicker
  if (props.step === undefined)
    return ''
  return props.of === undefined ? `Step ${props.step}` : `Step ${props.step} of ${props.of}`
})
</script>

<template>
  <div class="slidev-layout chapter">
    <div class="chapter-text">
      <div v-if="number" class="chapter-number" aria-hidden="true">{{ number }}</div>
      <div v-if="label" class="cg-kicker">{{ label }}</div>
      <slot />
    </div>
    <div class="chapter-art">
      <Goblin v-if="goblin" :name="goblin" />
    </div>
  </div>
</template>

<style scoped>
.chapter {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  align-items: center;
  gap: 32px;
}

.chapter-number {
  margin-bottom: 4px;
  font-size: 112px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.04em;
  color: transparent;
  -webkit-text-stroke: 1.5px rgba(16, 185, 129, 0.55);
}

.chapter :deep(h1) {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.chapter :deep(h1 + p) {
  max-width: 470px;
}

.chapter-art {
  display: flex;
  justify-content: center;
  height: 340px;
}
</style>
