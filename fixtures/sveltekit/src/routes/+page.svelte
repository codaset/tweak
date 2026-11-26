<script>
  import Panel from "../lib/Panel.svelte";
  import Toolbar from "../lib/Toolbar.svelte";
</script>

<main>
  <h1 id="title">Settings</h1>
  <Toolbar />
  <Panel title="Profile">
    <button type="button" data-testid="save">Save</button>
  </Panel>
</main>
