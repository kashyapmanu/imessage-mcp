# imessage-mcp

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets an MCP client (such as Claude Desktop) search and read your macOS Messages history from `~/Library/Messages/chat.db`.

It runs on your Mac over stdio, opens the database read-only, and never sends data anywhere. It cannot send, edit or delete messages.

## Requirements

- macOS with Messages signed in and in use
- Node.js 22.13 or newer (uses the built-in `node:sqlite` module, so no native compilation is needed)

## Install and build

```sh
npm install
npm run build
```

Output goes to `dist/`. The entry point is `dist/index.js`.

## Full Disk Access

macOS protects `~/Library/Messages`. The app that launches this server (for example Claude Desktop, or your terminal if you run it manually) needs Full Disk Access:

1. Open **System Settings > Privacy & Security > Full Disk Access**.
2. Enable the app that runs the server (e.g. Claude).
3. Fully quit and restart that app.

If access is missing, every tool returns an error that explains this.

## Configuration

| Variable           | Default                             | Purpose                                   |
| ------------------ | ----------------------------------- | ----------------------------------------- |
| `IMESSAGE_DB_PATH` | `~/Library/Messages/chat.db`        | Override the database file to read.       |

## Tools

All tools are annotated `readOnlyHint: true` and `openWorldHint: false`. Results are JSON-style text. Limits default to 50 and max at 500. Each message's text is capped at 2000 characters, and total output at 100 KB.

| Tool                      | Purpose                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list_chats`             | Recent conversations with chat id, name or participants, last message time and message count.            |
| `read_messages`          | Messages newest-first, filtered by `chat_id`, `contact`, `since` / `until` (ISO dates). Shows sender, text, `is_from_me` and attachment count. |
| `search_messages`        | Case-insensitive text search with optional `contact` and date filters. Reports if the scan cap was reached. |
| `get_conversation`       | The most recent messages of one chat, oldest first. Use `before` to page back.                           |
| `get_unread`             | Incoming messages that Messages marks unread. The flag is read from `chat.db` and may not match the app exactly. |
| `list_contacts_handles`  | Phone numbers and emails with message counts, optionally filtered by `query`.                            |

Notes:

- Tapbacks (reactions) and group events are excluded from message results.
- Message text is read from `message.text`. When that is empty, the server decodes the NSString from `message.attributedBody`.
- `contact` matches messages from that handle, plus your replies in chats that include it.

## Claude Desktop configuration

Add this to `claude_desktop_config.json` (Claude > Settings > Developer > Edit Config), using the absolute path to your build:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/manu/Projects/iMessage-mcp/dist/index.js"]
    }
  }
}
```

Use the output of `command -v node` for `command`, since Claude Desktop does not inherit your shell `PATH`. Restart Claude Desktop afterwards.

## Security and privacy

- Runs entirely on your machine. There are no network calls and no third-party services.
- The database is opened with `readOnly: true` and `PRAGMA query_only`. All SQL is parameterised, and the server issues only `SELECT` statements.
- Message content is returned to whichever MCP client you connect. Only connect clients you trust, because they will see your message history.
- Logs go to stderr only, since stdout carries the protocol.

## Smoke test

```sh
npm run build
npm run smoke
```

`scripts/smoke.mjs` starts the built server, lists the tools and calls `list_chats` with a limit of 3. It prints only counts and field names, never message contents.
