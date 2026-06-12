# MCP server — let agents come to your notes

GoldFishy stays a notepad (see [motivations.md](motivations.md), non-goal #6).
When notes need heavier work, you hand them *out* to a stronger tool rather than
growing that machinery inside the app. The **MCP server** (`mcp-server/`) is how:
it exposes your notes to a local agent — Claude Code, or any
[Model Context Protocol](https://modelcontextprotocol.io) client — over stdio.

The agent reaches *into* the same `nexusnote.db` the app uses; nothing is copied
or synced. The database stays the source of truth.

## What it exposes

Five tools, read-mostly:

| Tool | What it does |
|---|---|
| `search_notes` | Full-text keyword search (bm25-ranked, trashed notes excluded). Returns snippet, folder, tags. |
| `get_note` | One note's full Markdown by id. Records a **read**. |
| `list_notes` | Newest-first list, optionally filtered to a folder path. |
| `list_folders` | The folder tree as slash-joined paths. |
| `mark_note_actioned` | Records that the agent acted on a note's contents, with a summary. **Does not modify the note.** |

The only writes are append-only rows in an `agent_activity` audit table. Note
content is never mutated by the server.

## The audit trail — "actioned by agent xyz"

Every read and every action an agent takes is logged with the agent's identity
(captured from the MCP handshake — e.g. `Claude Code`). The app shows this on the
note: a line at the top of the editor reads e.g.

> 🤖 **Claude Code** actioned this — Turned the meeting note into a PRD · 2h ago

Click it to expand the full history (reads and actions). So when an agent works
with your notes, you can always see what it touched and what it did.

## Privacy scope

`GOLDFISHY_MCP_EXCLUDE` hides whole folder subtrees from *every* tool — search,
list, read, and actions. Comma-separated folder names, case-insensitive,
descendants included:

```
GOLDFISHY_MCP_EXCLUDE="Journal, Private"
```

A note in (or under) an excluded folder is invisible to the agent and cannot be
read or actioned.

## Building

```bash
cd mcp-server
cargo build --release
# binary: mcp-server/target/release/goldfishy-mcp
```

It's an independent crate (no Tauri / GUI dependencies), so it builds fast and
runs headless — the GoldFishy app does **not** need to be open.

## Connecting Claude Code

Add it as an MCP server. Either run:

```bash
claude mcp add goldfishy /absolute/path/to/mcp-server/target/release/goldfishy-mcp
```

…or add a `.mcp.json` (project) / entry in your Claude Code settings:

```json
{
  "mcpServers": {
    "goldfishy": {
      "command": "/absolute/path/to/mcp-server/target/release/goldfishy-mcp",
      "env": {
        "GOLDFISHY_MCP_EXCLUDE": "Journal"
      }
    }
  }
}
```

Then ask Claude Code things like *"search my notes for the Q3 planning thread and
turn it into a design doc"* — it will `search_notes`, `get_note`, do the work, and
`mark_note_actioned` so you see what happened.

## Locating the database

The server finds `nexusnote.db` automatically from the platform app-data dir for
identifier `com.nexusnote.app` (matching Tauri's `app_data_dir`):

- **macOS**: `~/Library/Application Support/com.nexusnote.app/nexusnote.db`
- **Linux**: `$XDG_DATA_HOME/com.nexusnote.app/` or `~/.local/share/com.nexusnote.app/`
- **Windows**: `%APPDATA%\com.nexusnote.app\nexusnote.db`

Override with `--db /path/to/nexusnote.db` or `GOLDFISHY_DB=/path/...`. Open the
GoldFishy app at least once first so the database exists.

## Security notes (why it's built this way)

These follow the project's own threat model (`docs/improvements.md` AI-9/10/12):

- **Read-mostly, audited.** The only writes are the audit log. Any future
  content-writing capability is gated behind the app's existing *proposed*-state
  pattern, never silent edits.
- **Trash invariant.** Every query filters `deleted_at IS NULL`; trashed notes
  are never exposed.
- **Untrusted content.** A note can contain pasted text that *looks* like
  instructions. The server's tool descriptions tell the agent to treat all note
  content as data, not commands (OWASP LLM01 / prompt injection). Still, only
  expose folders you're comfortable an agent reading.

## Configuration reference

| Variable / flag | Effect |
|---|---|
| `--db <path>` / `GOLDFISHY_DB` | Path to `nexusnote.db`. Default: platform app-data dir. |
| `GOLDFISHY_MCP_EXCLUDE` | Comma-separated folder names to hide (subtrees included). |
| `GOLDFISHY_AGENT` | Override the agent label in the audit trail. Default: the MCP client's name. |
