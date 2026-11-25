# Codaset Tweak

Codaset Tweak lets a developer point at part of a running web page and ask the Claude Code session working on that app to change it, then follow and undo the result from the page.

## Language

**Tweak**:
A request to change something on the page, attached to the element(s), text or area it points at, carrying its conversation, status and result.
_Avoid_: note, comment, annotation, request, feedback

**Change**:
The edits Claude makes to the code for one tweak; the thing Undo reverses.
_Avoid_: edit, fix, patch (for the concept as a whole)

**Claim**:
A session's exclusive ownership of the pages matching a URL pattern, so their tweaks go to that session.
_Avoid_: subscription, binding, registration

**Lapsed claim**:
A claim that ended because its session stopped responding. The session gets it back if it returns before another session claims those pages.
_Avoid_: expired claim, stale claim

**Session**:
One agent conversation (in v1, a Claude Code session) that can claim pages and receive their tweaks. It ends when the conversation does, including when it is cleared, and its claims end with it.
_Avoid_: client, worker, listener

**Watcher**:
What a session runs to hear about new tweaks and replies on its claimed pages, one event at a time.
_Avoid_: listener, poller, subscriber

**Inbox**:
The events waiting for a session, held until the session has taken each one up, so none is lost while its watcher is away.
_Avoid_: mailbox, backlog

**Done**:
A tweak whose change Claude has finished and reported.
_Avoid_: complete, fixed

**Resolved**:
A tweak you have finished with, whatever its outcome; its pin leaves the page.
_Avoid_: closed, dismissed, archived

**Withdrawn**:
A tweak you took back before Claude finished it. It is resolved, and any edits already made stay undoable.
_Avoid_: cancelled, aborted, deleted

**Brief**:
Everything Claude receives about a tweak: the request, what it points at, where that lives in the source, and how it looks and is built.
_Avoid_: context, payload, prompt

**Mapper**:
A way of finding where an element lives in the source from one kind of clue the page carries.
_Avoid_: resolver, locator, detector

**Search clue**:
A distinctive string from an element (visible text, an unusual class, a label) that Claude can search the project for when no mapper gives an exact location.
_Avoid_: hint, keyword

**Pin**:
The marker on the page showing where a tweak points and what state it is in.
_Avoid_: bubble, badge, marker

**Card**:
The panel beside a pin showing a tweak's status, conversation and result.
_Avoid_: popup, note box, composer (the composer is where a tweak is written before it is sent)
