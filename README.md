# imessage-mcp

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets an MCP client (such as Claude Desktop) search and read your macOS Messages history from `~/Library/Messages/chat.db`.

It runs on your Mac over stdio, opens the database read-only, and never sends data anywhere. It cannot send, edit or delete messages.

## Requirements

- macOS with Messages signed in and in use
- Node.js 22.13 or newer (uses the built-in `node:sqlite` module, so no native compilation is needed)

## Install and build

```sh
git clone https://github.com/kashyapmanu/imessage-mcp.git
cd imessage-mcp
npm install
npm run build
```

Output goes to `dist/`. The entry point is `dist/index.js`.

## Full Disk Access

macOS protects `~/Library/Messages` and `~/Library/Application Support/AddressBook` (Contacts). The app that launches this server (for example Claude Desktop, or your terminal if you run it manually) needs Full Disk Access:

1. Open **System Settings > Privacy & Security > Full Disk Access**.
2. Enable the app that runs the server (e.g. Claude).
3. Fully quit and restart that app.

If Messages access is missing, every tool returns an error that explains this. If only Contacts access is missing, message tools still work but names are omitted, and the server logs one line to stderr.

### Grant access to this server only (recommended)

Claude Desktop starts MCP servers through a helper that makes macOS check the program being run, so a plain `node` entry needs Full Disk Access granted to **node itself**, which would cover every Node script. Instead, build a tiny launcher that runs only this server and grant access to that:

```sh
scripts/build-launcher.sh   # needs Xcode Command Line Tools (cc, codesign)
```

This creates `~/.local/share/imessage-mcp/imessage-mcp-launcher`. Add that file under Full Disk Access, and use it as the `command` in the config below (no `args`). The launcher bakes in two paths: the stable Homebrew symlink `/opt/homebrew/bin/node` (so Node upgrades and `npm run build` need no action) and this repo's `dist/index.js`. Re-run the script and re-grant only if you move the repo or stop using Homebrew Node.

## Configuration

| Variable           | Default                                             | Purpose                                                                 |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `IMESSAGE_DB_PATH` | `~/Library/Messages/chat.db`                        | Override the Messages database file to read.                            |
| `CONTACTS_DB_DIR`  | `~/Library/Application Support/AddressBook`         | Override the AddressBook base directory used for Contacts name lookup.  |

## Contacts names

Handles are labelled with names from macOS Contacts. The server opens every `AddressBook-v22.abcddb` under the AddressBook directory (the root database and each `Sources/*/` database) read-only, once per process, the first time a name is needed. It normalises phone numbers to their last 10 digits, so `(415) 555-1234` matches the handle `+14155551234`, and lower-cases emails. Names are display only; nothing is written.

If a Contacts database cannot be read, the server prints one line to stderr and continues without names.

## Tools

All tools are annotated `readOnlyHint: true` and `openWorldHint: false`. Results are JSON-style text. Limits default to 50 and max at 500. Each message's text is capped at 2000 characters, and total output at 100 KB.

| Tool                      | Purpose                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list_chats`             | Recent conversations with chat id, name, participant handles and `participant_names`, last message time and message count. |
| `read_messages`          | Messages newest-first, filtered by `chat_id`, `contact`, `since` / `until` (ISO dates). Shows sender, `sender_name` for incoming messages, text, `is_from_me` and attachment count. |
| `search_messages`        | Case-insensitive text search with optional `contact` and date filters. Incoming messages include `sender_name`. Reports if the scan cap was reached. |
| `get_conversation`       | The most recent messages of one chat, oldest first. Use `before` to page back.                           |
| `get_unread`             | Incoming messages that Messages marks unread. The flag is read from `chat.db` and may not match the app exactly. |
| `list_contacts_handles`  | Phone numbers and emails with their Contacts `name` and message counts. `query` matches a handle substring or a contact name. |

Notes:

- Tapbacks (reactions) and group events are excluded from message results.
- Message text is read from `message.text`. When that is empty, the server decodes the NSString from `message.attributedBody`.
- `contact` accepts a contact name, phone number or email. It matches messages from any handle that matches the text, belongs to a contact whose name contains it, or (for 7 or more digits) has the same digits, so `(415) 555-1234` finds `+14155551234`. It also matches your replies in chats that include those handles. A name matching more than 200 handles is cut to the first 200, with a note on stderr.
- Names come from macOS Contacts. Without Contacts access, `sender_name`, `name` and `participant_names` are null or empty.

## Claude Desktop configuration

Add this to `claude_desktop_config.json` (Claude > Settings > Developer > Edit Config), using the absolute path to your build:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "/Users/YOU/.local/share/imessage-mcp/imessage-mcp-launcher"
    }
  }
}
```

Use the absolute path to the launcher. (Without the launcher, use the absolute path from `command -v node` as `command` and `["/absolute/path/to/imessage-mcp/dist/index.js"]` as `args`, and grant Full Disk Access to node.) Fully quit Claude Desktop from the menu bar and reopen it afterwards.

## Set it up with an AI agent

Paste this into Claude (Claude Code, or any agent with shell access on your Mac) to install and connect the server for you:

```text
Set up the iMessage MCP server from https://github.com/kashyapmanu/imessage-mcp on this Mac so I can use it in Claude Desktop. It is local-only and read-only.

1. Check that Node.js 22.13+ is installed (`node -v`). If not, tell me and stop.
2. Clone the repo into ~/Projects/imessage-mcp, then run `npm install` and `npm run build`. Run `npm run smoke` and report the result (it prints only counts, never message contents).
3. (The launcher build in the next step bakes in the node and dist/index.js paths, so nothing to do here.)
4. Run scripts/build-launcher.sh and use the resulting ~/.local/share/imessage-mcp/imessage-mcp-launcher as the "command" (no args). Back up ~/Library/Application Support/Claude/claude_desktop_config.json, then add an "imessage" entry under "mcpServers" with the launcher path as "command" and no "args". Keep every existing server entry unchanged and keep the JSON valid.
5. Tell me to add that launcher file (not node, not all of Node) to Full Disk Access (System Settings > Privacy & Security > Full Disk Access), then fully quit and reopen Claude Desktop. Do not change any system or security setting yourself.
6. After I restart, help me verify by asking Claude to list my 3 most recent chats. Do not print or store message contents beyond what I ask for.

Ask me before anything that is not on this list.
```

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
