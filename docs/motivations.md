# Motivations & use cases

Why GoldFishy exists, who it's for, and the bar every new feature has to clear. This is a living document — when the product philosophy shifts, change it here first.

## The problem

1. **Organizing notes is toil.** Folders, tags, and titles are upkeep that most people abandon, and then their notes become a write-only pile. The tools that promise to fix this (PKM systems, Notion-style workspaces) fix it by demanding *more* structure, not less.
2. **Notes capture is lossy.** Thoughts arrive mid-task and mid-meeting. If capture takes more than a keystroke, the thought is gone; if rough notes are never revisited, their meaning evaporates within days (hence the goldfish).
3. **The AI that could help lives in the cloud.** Notes are among the most personal data people have. Shipping them to a third party to get tagging and summarization is a trade many people reasonably refuse.

## The thesis

**A supercharged notepad — not a documentation platform.** GoldFishy stays as simple as a notepad to *use* (open, type, done) while a local AI quietly does the librarian work nobody wants: titling, tagging, filing suggestions, surfacing related notes, extracting the todos, remembering what things meant.

Principles, in priority order:

1. **Local-first, private by default.** All data and all automatic AI inference stay on the machine. Cloud-model calls, if they ever exist, are explicit, per-action, and user-invoked — never part of the background pipeline.
2. **The user's text is sacred.** AI never destructively edits without a snapshot and a way back; AI-derived things (tags, suggestions) are visually distinct (sage) and individually dismissible; nothing moves, schedules, or deletes without user consent.
3. **Zero-friction capture beats perfect structure.** Speed of getting a thought in (⌘⇧N, autosave, no Save button) outranks any organizational feature.
4. **Search over filing.** The app should be good enough at retrieval (keyword + semantic) that organizing is optional. Folders and tags exist for people who like them, not because the app needs them.
5. **The AI is a quiet assistant, not the show.** It works after you stop typing, fades results in, never blocks with modals, and is individually switch-off-able. Battery and attention are respected.
6. **Stays a notepad.** No collaboration, no publishing, no plugin platform, no agent host. When notes need heavier work, hand them *out* to stronger tools (planned: MCP server so agents like Claude Code can come to the notes) rather than growing that machinery inside the app.

## Primary use cases

- **Fleeting capture** — a thought, a link, a phone number, mid-anything: ⌘⇧N, type, Enter. The AI titles and tags it later; semantic search finds it forever.
- **Meeting notes** — rough, fragmentary, half-words typed while listening. Action items get extracted into reminders; (planned) a "Clarify" action infers what the fragments actually meant while keeping the original distinguishable.
- **Personal task spillover** — todos hide inside prose ("send the report by Friday"); the app proposes them as scheduled reminders instead of making you maintain a separate todo app.
- **The unfiled pile** — most notes never get organized, and that's fine: semantic search ("flight stuff" → the airline booking note), related-notes, and tidy-up-similar keep the pile useful.
- **Reference scraps** — code snippets, commands, recipes, addresses; code blocks with highlighting, instant keyword search.
- **Journaling / thinking out loud** — brain-dumps that auto-bullet into something readable.

## Non-goals (for now, deliberate)

- Multi-user collaboration or real-time sync.
- A documentation/wiki platform — long-form structured docs belong elsewhere.
- A full PKM system (backlinks graphs, daily-note rituals, plugin ecosystems).
- Hosting agents inside the app — agents integrate from outside via standard interfaces.
- Mobile (until the desktop core is finished).

## The bar for new features

Before building something, it should pass these questions:

1. Does it keep the *use* of the app as simple as a notepad?
2. Does it work fully offline, or is it an explicit user-invoked action?
3. Does it preserve the user's text and consent (snapshot, preview, dismissible)?
4. Is it the app's job — or should an external tool do it through the notes?
5. Would someone who never organizes anything still benefit?
