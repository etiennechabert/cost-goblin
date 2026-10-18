<!-- The content slide. `kicker` is the small emerald label above the title, as
     the website's section labels. -->
<script setup lang="ts">
defineProps<{ kicker?: string }>()
</script>

<template>
  <div class="slidev-layout default">
    <div v-if="kicker" class="cg-kicker">{{ kicker }}</div>
    <slot />
  </div>
</template>
