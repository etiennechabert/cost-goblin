<!-- The footer on every slide but the cover and the outro: brand, deck title
     and slide number. Slidev draws slide-top.vue above each slide's layout. -->
<script setup lang="ts">
import { useSlideContext } from '@slidev/client'
import { computed } from 'vue'
import goblin from '@site/goblin.png'

const { $slidev, $nav, $page, $frontmatter } = useSlideContext()

const hidden = computed(() => $frontmatter.layout === 'cover' || $frontmatter.layout === 'end')
const page = computed(() => String($page.value).padStart(2, '0'))
</script>

<template>
  <div v-if="!hidden" class="cg-footer">
    <span class="cg-footer-brand">
      <img :src="goblin" alt="">
      <b>CostGoblin</b>
      <span>· {{ $slidev.configs.title }}</span>
    </span>
    <span>{{ page }} / {{ $nav.total }}</span>
  </div>
</template>

<style scoped>
.cg-footer {
  position: absolute;
  right: 56px;
  bottom: 14px;
  left: 56px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--cg-border);
  font-family: var(--cg-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--cg-text-muted);
  pointer-events: none;
}

.cg-footer-brand {
  display: flex;
  align-items: center;
  gap: 7px;
}

.cg-footer-brand img {
  width: 18px;
  height: auto;
}

.cg-footer-brand b {
  font-weight: 500;
  color: var(--cg-emerald);
}
</style>
