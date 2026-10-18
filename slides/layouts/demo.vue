<!-- The cue before a screen-share segment: what is about to happen on screen
     (the slot: a title and the on-screen steps), which window it happens in
     (`screen`) and where in it (`where`, steps separated by ">"). -->
<script setup lang="ts">
import Crumbs from '../components/Crumbs.vue'

defineProps<{ screen?: string; where?: string }>()
</script>

<template>
  <div class="slidev-layout demo">
    <div class="demo-text">
      <div class="demo-live">
        <span class="demo-dot" />Live demo
      </div>
      <slot />
    </div>
    <div class="demo-side">
      <div class="demo-window">
        <div class="demo-bar">
          <span /><span /><span />
          <em v-if="screen">{{ screen }}</em>
        </div>
        <div class="demo-body">
          <span class="i-lucide-monitor-play demo-icon" aria-hidden="true" />
          <span class="demo-switch">Switching to the screen</span>
        </div>
      </div>
      <div v-if="where" class="demo-where">
        <Crumbs :to="where" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.demo {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  align-items: center;
  gap: 40px;
}

.demo-live {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 14px;
  padding: 4px 12px;
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: 100px;
  font-family: var(--cg-font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cg-emerald);
}

.demo-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cg-emerald);
  animation: demo-pulse 2s ease infinite;
}

@keyframes demo-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
}

@media (prefers-reduced-motion: reduce) {
  .demo-dot {
    animation: none;
  }
}

.demo :deep(h1) {
  font-size: 32px;
}

.demo-window {
  overflow: hidden;
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: 14px;
  background: var(--cg-bg-raised);
  box-shadow: 0 0 40px rgba(16, 185, 129, 0.1), 0 24px 60px rgba(0, 0, 0, 0.5);
}

.demo-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--cg-border);
}

.demo-bar span {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--cg-border-strong);
}

.demo-bar em {
  margin-left: 8px;
  font-family: var(--cg-font-mono);
  font-size: 11px;
  font-style: normal;
  color: var(--cg-text-dim);
}

.demo-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 44px 16px 40px;
}

.demo-icon {
  font-size: 46px;
  color: var(--cg-emerald);
  filter: drop-shadow(0 0 16px rgba(16, 185, 129, 0.5));
}

.demo-switch {
  font-family: var(--cg-font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cg-text-muted);
}

.demo-where {
  margin-top: 14px;
  padding: 0 4px;
  font-size: 15px;
}
</style>
