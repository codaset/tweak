<script setup>
import Panel from "./Panel.vue";
import Toolbar from "./Toolbar.vue";
</script>

<template>
  <main>
    <h1 id="title">Settings</h1>
    <Toolbar />
    <Panel title="Profile">
      <button type="button" data-testid="save">Save</button>
    </Panel>
  </main>
</template>
