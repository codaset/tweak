<script setup>
defineProps({ label: String });
</script>

<template>
  <button type="button" class="export-button">{{ label }}</button>
</template>
