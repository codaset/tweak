<script>
  import { onMount } from "svelte";

  let { children } = $props();

  // The page is rendered on the server, and __svelte_meta comes with
  // hydration: this says it has happened (fixture.json's `loaded`).
  onMount(() => {
    document.documentElement.dataset.hydrated = "";
  });
</script>

{@render children()}
