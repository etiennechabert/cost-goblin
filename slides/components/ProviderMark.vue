<script setup lang="ts">
// The vendors' marks as the website's integration cards draw them (AWS:
// Apache-2.0 artwork; Google Cloud: PD-textlogo on Commons), naming whose
// billing data a deck connects: nominative use, not an endorsement claim.
defineProps<{ provider: 'aws' | 'gcp' }>()
</script>

<template>
  <svg v-if="provider === 'aws'" class="cg-mark cg-mark--aws" viewBox="0 116 304 66" aria-label="AWS" role="img">
    <path fill="#FF9900" d="M273.5,143.7c-32.9,24.3-80.7,37.2-121.8,37.2c-57.6,0-109.5-21.3-148.7-56.7c-3.1-2.8-0.3-6.6,3.4-4.4c42.4,24.6,94.7,39.5,148.8,39.5c36.5,0,76.6-7.6,113.5-23.2C274.2,133.6,278.9,139.7,273.5,143.7z" />
    <path fill="#FF9900" d="M287.2,128.1c-4.2-5.4-27.8-2.6-38.5-1.3c-3.2,0.4-3.7-2.4-0.8-4.5c18.8-13.2,49.7-9.4,53.3-5c3.6,4.5-1,35.4-18.6,50.2c-2.7,2.3-5.3,1.1-4.1-1.9C282.5,155.7,291.4,133.4,287.2,128.1z" />
  </svg>
  <svg v-else class="cg-mark cg-mark--gcp" viewBox="0 0 34 30" aria-label="Google Cloud" role="img">
    <path fill="#EA4335" d="M21.85,7.41l1,0,2.85-2.85.14-1.21A12.81,12.81,0,0,0,5,9.6a1.55,1.55,0,0,1,1-.06l5.7-.94s.29-.48.44-.45a7.11,7.11,0,0,1,9.73-.74Z" />
    <path fill="#4285F4" d="M29.76,9.6a12.84,12.84,0,0,0-3.87-6.24l-4,4A7.11,7.11,0,0,1,24.5,13v.71a3.56,3.56,0,1,1,0,7.12H17.38l-.71.72v4.27l.71.71H24.5A9.26,9.26,0,0,0,29.76,9.6Z" />
    <path fill="#34A853" d="M10.25,26.49h7.12v-5.7H10.25a3.54,3.54,0,0,1-1.47-.32l-1,.31L4.91,23.63l-.25,1A9.21,9.21,0,0,0,10.25,26.49Z" />
    <path fill="#FBBC05" d="M10.25,8A9.26,9.26,0,0,0,4.66,24.6l4.13-4.13a3.56,3.56,0,1,1,4.71-4.71l4.13-4.13A9.25,9.25,0,0,0,10.25,8Z" />
  </svg>
</template>

<style scoped>
.cg-mark {
  display: inline-block;
  flex-shrink: 0;
  overflow: visible;
}

/* The AWS smile is a wide swoosh: matched on width, as on the website. */
.cg-mark--aws {
  width: 1.75em;
  height: 1em;
}

.cg-mark--gcp {
  width: 1.3em;
  height: 1.15em;
}
</style>
