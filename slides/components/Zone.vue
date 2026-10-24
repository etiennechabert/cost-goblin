<!-- Whose infrastructure a group of <FlowNode>s runs on. -->
<script setup lang="ts">
defineProps<{ label: string; accent?: boolean }>()
</script>

<template>
  <div class="cg-zone" :class="{ 'cg-zone--accent': accent }">
    <div class="cg-zone-label">{{ label }}</div>
    <div class="cg-zone-body">
      <slot />
    </div>
  </div>
</template>
