# Undo capture: the edit hook records, git only checks

A change is recorded by the agent's edit hook alone. Before Claude's edit tools touch a file during a tweak, the hook saves that file's contents, labelled with the tweak. Undo reverts exactly those files. Git plays a second, narrower role. When a tweak enters `working`, the bridge records the working tree into a temporary git index, and at `done` it compares that tree with the files on disk. Files that changed without passing through the hook are listed on the card as "also changed while Claude worked, not recorded", and Undo never touches them. We chose this because Undo must never revert something Claude may not have written, and the card must never claim an undo is complete when it isn't.

## Considered Options

- **Hook only.** Attribution is exact, but edits made with shell commands (`sed`) are missed silently, so Undo looks complete when it isn't.
- **Git tree only.** It works with any agent and catches shell edits. But it attributes your own edits from the same window, and any other session's edits in the same repo, to the tweak, so Undo would revert them. It also needs a git repo.
- **Hook records, git fills gaps.** Undo would also revert shell edits, but it could wipe out an edit you made yourself to a file during the tweak.

## Consequences

- Outside a git repo, the check is skipped: changes are recorded and undone the same way, but nothing reports edits the hook didn't see.
- The check is cheap because the temporary index is seeded from the repo's own index: about 0.05 s on 5,000-file repos, against about 0.5 s from scratch.
- Supporting another agent (Codex) needs that agent's own edit hook to record changes. Git alone isn't enough.
