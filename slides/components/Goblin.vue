<script setup lang="ts">
import { computed } from 'vue'
import goblin from '@site/goblin.png'

// The app's splash-screen goblins, by what each one is doing, so a deck can
// pick the one that fits a chapter. Any other name shows the main goblin.
const SPLASH: Record<string, string> = {
  detective: 'splash-1', // magnifying glass and key
  throne: 'splash-2', // sitting on a coin stack
  dive: 'splash-3', // jumping into the coins
  jeweler: 'splash-4', // inspecting a gem
  polish: 'splash-5', // polishing a coin
  abacus: 'splash-6', // counting on an abacus
  trap: 'splash-7', // setting a trap
  vault: 'splash-8', // inside a safe
  alchemist: 'splash-9', // brewing gold
  hauler: 'splash-10', // hauling a money bag
}

const splashes = import.meta.glob<string>('@app/splash-*.png', { eager: true, import: 'default' })

// `size` is the art's height: the layouts leave it filling their own box.
const props = withDefaults(defineProps<{ name?: string; glow?: boolean; size?: string }>(), {
  name: 'goblin',
  glow: true,
  size: '100%',
})

const src = computed(() => {
  const splash = SPLASH[props.name]
  if (splash === undefined)
    return goblin
  return Object.entries(splashes).find(([path]) => path.endsWith(`/${splash}.png`))?.[1] ?? goblin
})
</script>

<template>
  <span class="cg-goblin" :class="{ 'cg-goblin--glow': glow }" :style="{ height: size }">
    <img :src="src" alt="" draggable="false">
  </span>
</template>

<style scoped>
/* The glow is on the wrapper: a filter on the masked image would be clipped
   to the image's box. */
.cg-goblin {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 0;
}

.cg-goblin--glow {
  filter: drop-shadow(0 0 36px rgba(16, 185, 129, 0.28));
}

/* The art is cut off flat at the bottom (and the coin pile at the sides):
   fade those edges into the slide. */
.cg-goblin img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-mask-image:
    linear-gradient(to bottom, #000 74%, transparent 99%),
    linear-gradient(to right, transparent, #000 7%, #000 93%, transparent);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(to bottom, #000 74%, transparent 99%),
    linear-gradient(to right, transparent, #000 7%, #000 93%, transparent);
  mask-composite: intersect;
}
</style>
