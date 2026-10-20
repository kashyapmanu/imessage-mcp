import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Messages stores dates as nanoseconds since 2001-01-01 UTC. */
export const APPLE_EPOCH_MS = 978307200000n; // 2001-01-01T00:00:00Z in unix ms
const NS_PER_MS = 1000000n;

export type Param = string | number | bigint | null;

export const FULL_DISK_ACCESS_HINT =
  "The host app running this server (e.g. Claude) cannot read the Messages database. " +
  "Grant it Full Disk Access in System Settings > Privacy & Security > Full Disk Access, " +
  "then fully quit and restart the app.";

/** Thrown when the database cannot be opened or read, with a user-facing message. */
export class DbAccessError extends Error {
  readonly kind: "permission" | "other";
  constructor(message: string, kind: "permission" | "other") {
    super(message);
    this.name = "DbAccessError";
    this.kind = kind;
  }
}

export function getDbPath(): string {
  const override = process.env.IMESSAGE_DB_PATH?.trim();
  if (override) return resolve(expandHome(override));
  return join(homedir(), "Library", "Messages", "chat.db");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

let cached: DatabaseSync | null = null;

/** Open any SQLite file read-only, with query_only enforced. Shared with contacts.ts. */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

/**
 * Open the Messages database read-only, lazily, on first use. Failed opens are
 * not cached, so a later call can succeed once permissions are fixed.
 */
export function getDb(): DatabaseSync {
  if (cached) return cached;
  const path = getDbPath();
  try {
    const db = openReadOnly(path);
    cached = db;
    return db;
  } catch (err) {
    throw classifyError(err, path);
  }
}

/**
 * Run a parameterised SELECT and return all rows.
 * Integers are read as BigInt so Apple nanosecond dates (~7e17) do not overflow
 * JavaScript numbers; values that fit safely are normalised back to numbers.
 */
export function all<T>(sql: string, params: Param[] = []): T[] {
  const db = getDb();
  try {
    const stmt = db.prepare(sql);
    stmt.setReadBigInts(true);
    const rows = stmt.all(...params) as unknown as Record<string, unknown>[];
    return rows.map(normaliseRow) as unknown as T[];
  } catch (err) {
    throw classifyError(err, getDbPath());
  }
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value;
  }
  return out;
}

function classifyError(err: unknown, path: string): DbAccessError {
  const e = err as { errcode?: number; errstr?: string; message?: string };
  const message = e?.message ?? String(err);
  // SQLITE_CANTOPEN = 14, SQLITE_AUTH = 23 (also what macOS TCC denial looks like).
  const isPermission =
    e?.errcode === 14 ||
    e?.errcode === 23 ||
    /unable to open|authorization denied|not authorized|operation not permitted|EPERM|EACCES/i.test(message);
  if (isPermission) {
    return new DbAccessError(
      `Cannot open Messages database at ${path}. ${FULL_DISK_ACCESS_HINT} ` +
        `(If the file does not exist, set IMESSAGE_DB_PATH to the correct location.)`,
      "permission",
    );
  }
  return new DbAccessError(`Database error: ${message}`, "other");
}

/** Convert an Apple nanosecond timestamp (or legacy seconds) to unix ms. */
export function appleToUnixMs(value: number | bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  // Modern macOS: nanoseconds. Older databases stored seconds.
  const apple = Math.abs(n) > 1e12 ? n / 1e6 : n * 1000;
  return Math.round(apple) + Number(APPLE_EPOCH_MS);
}

export function appleToIso(value: number | bigint | null | undefined): string | null {
  const ms = appleToUnixMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Parse an ISO date string into an Apple nanosecond bigint for SQL binding. */
export function isoToApple(iso: string): bigint {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${iso}`);
  return (BigInt(ms) - APPLE_EPOCH_MS) * NS_PER_MS;
}

/** Escape LIKE wildcards so user input is matched literally (use with ESCAPE '\'). */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * SQL predicate for a contact substring. Matches incoming messages whose sender
 * handle contains the needle, and outgoing messages in a chat that includes such
 * a handle. Appends its two parameters to `params`.
 */
export function contactPredicate(messageAlias: string, needle: string, params: Param[]): string {
  const pattern = likePattern(needle.trim());
  params.push(pattern, pattern);
  return `((${messageAlias}.is_from_me = 0 AND EXISTS (
      SELECT 1 FROM handle h3
      WHERE h3.ROWID = ${messageAlias}.handle_id AND h3.id LIKE ? ESCAPE '\\'))
    OR (${messageAlias}.is_from_me = 1 AND EXISTS (
      SELECT 1 FROM chat_message_join cmj
      JOIN chat_handle_join chj ON chj.chat_id = cmj.chat_id
      JOIN handle hh ON hh.ROWID = chj.handle_id
      WHERE cmj.message_id = ${messageAlias}.ROWID AND hh.id LIKE ? ESCAPE '\\')))`;
}

/** SQL predicate restricting a message to a chat id. */
export function chatPredicate(messageAlias: string, chatId: number, params: Param[]): string {
  params.push(chatId);
  return `EXISTS (SELECT 1 FROM chat_message_join cmj
    WHERE cmj.message_id = ${messageAlias}.ROWID AND cmj.chat_id = ?)`;
}
