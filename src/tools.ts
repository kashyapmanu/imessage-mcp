import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeAttributedBody } from "./decode.js";
import {
  all,
  appleToIso,
  chatPredicate,
  contactPredicate,
  DbAccessError,
  isoToApple,
  likePattern,
  type Param,
} from "./db.js";

/** Per-message text cap and total response cap, to keep tool output bounded. */
const MAX_TEXT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 100_000;
/** search_messages stops scanning after this many rows, reporting the cap. */
const SEARCH_SCAN_CAP = 100_000;
const SEARCH_BATCH = 1000;

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Maximum number of items to return (1-500, default 50).");

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Must be a parseable ISO 8601 date, e.g. 2025-01-31 or 2025-01-31T09:00:00Z")
  .describe("ISO 8601 date or datetime, e.g. 2025-01-31 or 2025-01-31T09:00:00Z.");

const contactSchema = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Substring of a phone number, email or handle id (e.g. '+1555' or 'alice@'). Matches messages from that handle, and your replies in chats that include it.",
  );

const chatIdSchema = z.number().int().positive().describe("Chat id as returned by list_chats.");

/** Columns shared by all message queries. Aliased to the `m` message table. */
const MESSAGE_COLUMNS = `
  m.ROWID AS id,
  m.text AS text,
  m.attributedBody AS attributedBody,
  m.date AS date,
  m.is_from_me AS is_from_me,
  (SELECT h.id FROM handle h WHERE h.ROWID = m.handle_id) AS sender_handle,
  (SELECT cmj.chat_id FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID LIMIT 1) AS chat_id,
  (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS attachment_count`;

/** Exclude tapbacks/reactions and group-membership or rename events. */
const REAL_MESSAGE = `COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0`;

interface MessageRow {
  id: number;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: number | bigint | null;
  is_from_me: number;
  sender_handle: string | null;
  chat_id: number | null;
  attachment_count: number;
}

interface ChatRow {
  id: number;
  chat_identifier: string | null;
  display_name: string | null;
  service_name: string | null;
  participants: string | null;
  last_date: number | bigint | null;
  message_count: number;
}

interface HandleRow {
  id: number;
  handle: string;
  service: string | null;
  message_count: number;
  last_date: number | bigint | null;
}

/** Resolve a message's text: prefer message.text, fall back to attributedBody. */
function resolveText(row: MessageRow): string | null {
  const plain = row.text?.trim();
  if (plain) return plain;
  return decodeAttributedBody(row.attributedBody);
}

function capText(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}...[truncated]` : text;
}

function formatMessage(row: MessageRow) {
  return {
    id: row.id,
    time: appleToIso(row.date),
    from: row.is_from_me ? "me" : (row.sender_handle ?? "unknown"),
    is_from_me: row.is_from_me === 1,
    text: capText(resolveText(row)),
    attachments: row.attachment_count,
    chat_id: row.chat_id,
  };
}

/** Build a tool result, dropping trailing items until the output fits the cap. */
function jsonResult(payload: Record<string, unknown>, itemsKey?: string) {
  let text = JSON.stringify(payload, null, 1);
  if (itemsKey && text.length > MAX_OUTPUT_CHARS) {
    const items = [...(payload[itemsKey] as unknown[])];
    while (items.length > 0 && text.length > MAX_OUTPUT_CHARS) {
      items.pop();
      text = JSON.stringify({ ...payload, [itemsKey]: items, truncated: true }, null, 1);
    }
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n...[output truncated]";
  }
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Wrap a handler so DB and input errors become clean isError results. */
function guarded<A>(fn: (args: A) => ReturnType<typeof jsonResult>) {
  return (args: A) => {
    try {
      return fn(args);
    } catch (err) {
      if (err instanceof DbAccessError) return errorResult(err.message);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[imessage-mcp] tool error: ${message}`);
      return errorResult(`Error: ${message}`);
    }
  };
}

/** Shared WHERE fragments for message queries. */
function messageFilters(opts: {
  contact?: string;
  since?: string;
  until?: string;
  chatId?: number;
}): { where: string[]; params: Param[] } {
  const where: string[] = [REAL_MESSAGE];
  const params: Param[] = [];
  if (opts.chatId !== undefined) where.push(chatPredicate("m", opts.chatId, params));
  if (opts.contact) where.push(contactPredicate("m", opts.contact, params));
  if (opts.since) {
    where.push("m.date >= ?");
    params.push(isoToApple(opts.since));
  }
  if (opts.until) {
    where.push("m.date <= ?");
    params.push(isoToApple(opts.until));
  }
  return { where, params };
}

function selectMessages(where: string[], tail: string, params: Param[]): MessageRow[] {
  const sql = `SELECT ${MESSAGE_COLUMNS}
    FROM message m
    WHERE ${where.join(" AND ")}
    ${tail}`;
  return all<MessageRow>(sql, params);
}

export function registerTools(server: McpServer): void {
  const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };

  server.registerTool(
    "list_chats",
    {
      title: "List iMessage chats",
      description:
        "List recent iMessage/SMS conversations, newest activity first. Returns chat id, display name or participant handles, last message time and message count. Use the chat id with read_messages, get_conversation.",
      inputSchema: {
        limit: limitSchema,
        offset: z.number().int().min(0).max(100000).default(0).describe("Number of chats to skip (pagination)."),
      },
      annotations: readOnly,
    },
    guarded(({ limit, offset }) => {
      const rows = all<ChatRow>(
        `SELECT c.ROWID AS id,
            c.chat_identifier AS chat_identifier,
            c.display_name AS display_name,
            c.service_name AS service_name,
            (SELECT group_concat(h.id, ', ') FROM chat_handle_join chj
               JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID) AS participants,
            (SELECT MAX(m.date) FROM chat_message_join cmj
               JOIN message m ON m.ROWID = cmj.message_id WHERE cmj.chat_id = c.ROWID) AS last_date,
            (SELECT COUNT(*) FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID) AS message_count
         FROM chat c
         ORDER BY last_date DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      const chats = rows.map((r) => ({
        chat_id: r.id,
        name: r.display_name || r.participants || r.chat_identifier,
        participants: r.participants && r.participants.length > 300 ? `${r.participants.slice(0, 300)}...` : r.participants,
        service: r.service_name,
        last_message_time: appleToIso(r.last_date),
        message_count: r.message_count,
      }));
      return jsonResult({ count: chats.length, offset, chats }, "chats");
    }),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read iMessage messages",
      description:
        "Read messages newest-first, optionally filtered by chat id, contact substring and date range. Returns timestamp, sender (me or handle), text, is_from_me and attachment count. Tapbacks and group events are excluded.",
      inputSchema: {
        chat_id: chatIdSchema.optional(),
        contact: contactSchema,
        since: isoDate.optional(),
        until: isoDate.optional(),
        limit: limitSchema,
        offset: z.number().int().min(0).max(100000).default(0).describe("Number of messages to skip (pagination)."),
      },
      annotations: readOnly,
    },
    guarded(({ chat_id, contact, since, until, limit, offset }) => {
      const { where, params } = messageFilters({ contact, since, until, chatId: chat_id });
      const rows = selectMessages(where, "ORDER BY m.date DESC, m.ROWID DESC LIMIT ? OFFSET ?", [
        ...params,
        limit,
        offset,
      ]);
      const messages = rows.map(formatMessage);
      return jsonResult({ count: messages.length, offset, messages }, "messages");
    }),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search iMessage text",
      description:
        "Case-insensitive substring search over message text, newest first. Also decodes attributedBody for messages whose plain text is empty. Optional contact and date filters are applied in SQL. The scan is capped; the result says if the cap was hit, meaning the search was not exhaustive.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Text to look for (case-insensitive substring)."),
        contact: contactSchema,
        since: isoDate.optional(),
        until: isoDate.optional(),
        limit: limitSchema,
      },
      annotations: readOnly,
    },
    guarded(({ query, contact, since, until, limit }) => {
      const needle = query.toLowerCase();
      const { where, params } = messageFilters({ contact, since, until });
      const matches: ReturnType<typeof formatMessage>[] = [];
      let cursor = Number.MAX_SAFE_INTEGER;
      let scanned = 0;
      let capHit = false;

      while (matches.length < limit) {
        if (scanned >= SEARCH_SCAN_CAP) {
          capHit = true;
          break;
        }
        const rows = selectMessages(
          [...where, "m.ROWID < ?"],
          "ORDER BY m.ROWID DESC LIMIT ?",
          [...params, cursor, SEARCH_BATCH],
        );
        if (rows.length === 0) break;
        scanned += rows.length;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
          const text = resolveText(row);
          if (text && text.toLowerCase().includes(needle)) {
            matches.push(formatMessage(row));
            if (matches.length >= limit) break;
          }
        }
        if (rows.length < SEARCH_BATCH) break;
      }

      return jsonResult(
        {
          query,
          count: matches.length,
          scanned_rows: scanned,
          scan_cap_hit: capHit,
          note: capHit ? `Stopped after scanning ${SEARCH_SCAN_CAP} rows; narrow with contact or since/until.` : undefined,
          messages: matches,
        },
        "messages",
      );
    }),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation context",
      description:
        "Return the most recent messages of one chat in chronological order (oldest first). Use 'before' (ISO date) to page back into older context.",
      inputSchema: {
        chat_id: chatIdSchema,
        limit: limitSchema,
        before: isoDate.optional().describe("Only return messages sent before this ISO date/time."),
      },
      annotations: readOnly,
    },
    guarded(({ chat_id, limit, before }) => {
      const { where, params } = messageFilters({ chatId: chat_id });
      if (before) {
        where.push("m.date < ?");
        params.push(isoToApple(before));
      }
      const newest = selectMessages(where, "ORDER BY m.date DESC, m.ROWID DESC LIMIT ?", [...params, limit]);
      const messages = newest.map(formatMessage).reverse();
      return jsonResult({ chat_id, count: messages.length, messages }, "messages");
    }),
  );

  server.registerTool(
    "get_unread",
    {
      title: "Get unread incoming messages",
      description:
        "List incoming messages that Messages marks as unread, newest first. The unread flag comes from chat.db and may not match the Messages app exactly.",
      inputSchema: {
        limit: limitSchema,
      },
      annotations: readOnly,
    },
    guarded(({ limit }) => {
      const rows = selectMessages(
        [REAL_MESSAGE, "m.is_from_me = 0", "m.is_read = 0"],
        "ORDER BY m.date DESC, m.ROWID DESC LIMIT ?",
        [limit],
      );
      const messages = rows.map(formatMessage);
      return jsonResult({ count: messages.length, messages }, "messages");
    }),
  );

  server.registerTool(
    "list_contacts_handles",
    {
      title: "List handles with message counts",
      description:
        "List phone numbers, emails and other Messages handles with how many messages each has, most active first. Optional query filters by substring of the handle id.",
      inputSchema: {
        limit: limitSchema,
        query: z.string().min(1).max(200).optional().describe("Substring of a handle id to filter by."),
      },
      annotations: readOnly,
    },
    guarded(({ limit, query }) => {
      const params: Param[] = [];
      let filter = "";
      if (query) {
        filter = "WHERE h.id LIKE ? ESCAPE '\\'";
        params.push(likePattern(query.trim()));
      }
      params.push(limit);
      const rows = all<HandleRow>(
        `SELECT h.ROWID AS id,
            h.id AS handle,
            h.service AS service,
            COUNT(m.ROWID) AS message_count,
            MAX(m.date) AS last_date
         FROM handle h
         LEFT JOIN message m ON m.handle_id = h.ROWID
         ${filter}
         GROUP BY h.ROWID
         ORDER BY message_count DESC, last_date DESC
         LIMIT ?`,
        params,
      );
      const handles = rows.map((r) => ({
        handle_id: r.id,
        handle: r.handle,
        service: r.service,
        message_count: r.message_count,
        last_message_time: appleToIso(r.last_date),
      }));
      return jsonResult({ count: handles.length, handles }, "handles");
    }),
  );
}
