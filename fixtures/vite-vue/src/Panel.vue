<!-- Its slot content is written in App, so it belongs to App, not Panel. -->
<script setup>
defineProps({ title: String });
</script>

<template>
  <section class="panel">
    <h2 class="panel-title">{{ title }}</h2>
    <slot />
  </section>
</template>
