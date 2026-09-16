<script setup lang="ts">
import { withBase } from 'vitepress'

/**
 * A screenshot taken in both themes. `name` is the file stem under
 * public/screens; `<name>-light.webp` and `<name>-dark.webp` must both exist,
 * and the one matching the page's current theme is shown.
 */
defineProps<{ name: string; alt: string }>()
</script>

<template>
  <figure class="screenshot">
    <img class="screenshot-light" :src="withBase(`/screens/${name}-light.webp`)" :alt="alt" width="2400" height="1500" loading="lazy" />
    <img class="screenshot-dark" :src="withBase(`/screens/${name}-dark.webp`)" :alt="alt" width="2400" height="1500" loading="lazy" />
  </figure>
</template>
