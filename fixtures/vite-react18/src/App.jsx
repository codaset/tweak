import { Panel } from "./Panel.jsx";
import { Toolbar } from "./Toolbar.jsx";

export function App() {
  return (
    <main>
      <h1 id="title">Settings</h1>
      <Toolbar />
      <Panel title="Profile">
        <button type="button" data-testid="save">
          Save
        </button>
      </Panel>
    </main>
  );
}
