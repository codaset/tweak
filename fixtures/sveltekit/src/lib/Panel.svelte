<!-- Its children are written in the page, so they belong to the page, not Panel. -->
<script>
  let { title, children } = $props();
</script>

<section class="panel">
  <h2 class="panel-title">{title}</h2>
  {@render children()}
</section>
