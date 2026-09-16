<script setup lang="ts">
import Screenshot from './Screenshot.vue'

/** One home-page section: a short pitch on one side, a screenshot on the other. */
defineProps<{ shot: string; alt: string; title: string; flip?: boolean }>()
</script>

<template>
  <section class="feature-row" :class="{ flip }">
    <div class="feature-text">
      <h2>{{ title }}</h2>
      <slot />
    </div>
    <Screenshot class="feature-shot" :name="shot" :alt="alt" />
  </section>
</template>
