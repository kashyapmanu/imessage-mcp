import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { all, openReadOnly } from "./db.js";

/**
 * Read-only lookup of macOS Contacts names, used to label handles in Messages output.
 *
 * Reads every AddressBook-v22.abcddb under the AddressBook base directory (the root
 * database plus each Sources/<id>/ database), once per process, lazily on first use.
 * If a source is unreadable it is skipped with a single stderr line; lookups then
 * return no names rather than failing the tool call.
 */

const DB_FILE = "AddressBook-v22.abcddb";

interface Entry {
  name: string;
  phoneKeys: string[];
  emails: string[];
}

interface Directory {
  entries: Entry[];
  /** phone key -> display name (first record wins) */
  phoneNames: Map<string, string>;
  /** lower-cased email -> display name (first record wins) */
  emailNames: Map<string, string>;
  sourcesFound: number;
  sourcesUnreadable: number;
}

let directory: Directory | null = null;

/**
 * Normalise a phone number to a comparison key: the last 10 digits, which ignores
 * a leading country code and punctuation such as "(415) 555-1234". Numbers shorter
 * than 10 digits are kept whole and only match exactly.
 */
export function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

type HandleKey = { kind: "email" | "phone"; key: string };

/** Classify a chat.db handle id (phone or email) into a normalised lookup key. */
function handleKey(handle: string): HandleKey | null {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return { kind: "email", key: trimmed.toLowerCase() };
  const key = phoneKey(trimmed);
  return key === null ? null : { kind: "phone", key };
}

function contactsBaseDir(): string {
  const override = process.env.CONTACTS_DB_DIR?.trim();
  if (override) {
    if (override === "~") return homedir();
    if (override.startsWith("~/")) return join(homedir(), override.slice(2));
    return resolve(override);
  }
  return join(homedir(), "Library", "Application Support", "AddressBook");
}

/** The root database plus every Sources/<id>/ database that exists. */
function databaseFiles(base: string): string[] {
  const files: string[] = [];
  const direct = join(base, DB_FILE);
  if (existsSync(direct)) files.push(direct);
  const sources = join(base, "Sources");
  try {
    for (const dirent of readdirSync(sources, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(sources, dirent.name, DB_FILE);
      if (existsSync(candidate)) files.push(candidate);
    }
  } catch {
    // No Sources directory: the root database alone is fine.
  }
  return files;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** "First Last", falling back to nickname, then organization. */
function displayName(first: unknown, last: unknown, nickname: unknown, organization: unknown): string | null {
  const full = [text(first), text(last)].filter((p): p is string => p !== null).join(" ");
  return full || text(nickname) || text(organization);
}

function readSource(path: string): Entry[] {
  const db = openReadOnly(path);
  try {
    const query = (sql: string) => {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      return stmt.all() as unknown as Record<string, unknown>[];
    };

    const phonesByOwner = new Map<string, string[]>();
    for (const row of query("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZOWNER IS NOT NULL")) {
      const number = text(row.ZFULLNUMBER);
      const key = number ? phoneKey(number) : null;
      if (!key) continue;
      const owner = String(row.ZOWNER);
      const list = phonesByOwner.get(owner) ?? [];
      list.push(key);
      phonesByOwner.set(owner, list);
    }

    const emailsByOwner = new Map<string, string[]>();
    for (const row of query("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZOWNER IS NOT NULL")) {
      const address = text(row.ZADDRESS);
      if (!address) continue;
      const owner = String(row.ZOWNER);
      const list = emailsByOwner.get(owner) ?? [];
      list.push(address.toLowerCase());
      emailsByOwner.set(owner, list);
    }

    const entries: Entry[] = [];
    for (const row of query("SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION FROM ZABCDRECORD")) {
      const name = displayName(row.ZFIRSTNAME, row.ZLASTNAME, row.ZNICKNAME, row.ZORGANIZATION);
      if (!name) continue;
      const owner = String(row.Z_PK);
      entries.push({
        name,
        phoneKeys: phonesByOwner.get(owner) ?? [],
        emails: emailsByOwner.get(owner) ?? [],
      });
    }
    return entries;
  } finally {
    db.close();
  }
}

function warn(message: string): void {
  console.error(`[imessage-mcp] ${message}`);
}

function load(): Directory {
  if (directory) return directory;

  const files = databaseFiles(contactsBaseDir());
  const entries: Entry[] = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      entries.push(...readSource(file));
    } catch {
      unreadable++;
    }
  }
  if (files.length === 0) {
    warn("Contacts: no AddressBook database found; contact names are unavailable.");
  } else if (unreadable > 0) {
    warn(
      `Contacts: ${unreadable} of ${files.length} database(s) unreadable; names from them are unavailable. ` +
        "Grant Full Disk Access to the host app to read Contacts.",
    );
  }

  const phoneNames = new Map<string, string>();
  const emailNames = new Map<string, string>();
  for (const entry of entries) {
    for (const key of entry.phoneKeys) if (!phoneNames.has(key)) phoneNames.set(key, entry.name);
    for (const email of entry.emails) if (!emailNames.has(email)) emailNames.set(email, entry.name);
  }

  directory = {
    entries,
    phoneNames,
    emailNames,
    sourcesFound: files.length,
    sourcesUnreadable: unreadable,
  };
  return directory;
}

/** Display name for a chat.db handle id (phone or email), or null if unknown. */
export function nameForHandle(handleId: string): string | null {
  const key = handleKey(handleId);
  if (!key) return null;
  const dir = load();
  return (key.kind === "email" ? dir.emailNames : dir.phoneNames).get(key.key) ?? null;
}

/**
 * chat.db handle ids belonging to contacts whose display name contains `query`
 * (case-insensitive). Handles are matched by normalised digits or lower-cased email.
 */
export function handlesForName(query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const dir = load();

  const phoneKeys = new Set<string>();
  const emails = new Set<string>();
  for (const entry of dir.entries) {
    if (!entry.name.toLowerCase().includes(needle)) continue;
    for (const key of entry.phoneKeys) phoneKeys.add(key);
    for (const email of entry.emails) emails.add(email);
  }
  if (phoneKeys.size === 0 && emails.size === 0) return [];

  const rows = all<{ id: string }>("SELECT id FROM handle WHERE id IS NOT NULL");
  const matched = new Set<string>();
  for (const row of rows) {
    const key = handleKey(String(row.id));
    if (!key) continue;
    if (key.kind === "email" ? emails.has(key.key) : phoneKeys.has(key.key)) matched.add(String(row.id));
  }
  return [...matched];
}

/**
 * chat.db phone handles whose digits contain the digits of `query`, so a formatted
 * number such as "(415) 555-1234" matches "+14155551234". Needs at least 7 digits
 * and no letters; shorter input is left to the plain substring match.
 */
export function handlesForNumber(query: string): string[] {
  const digits = query.replace(/\D/g, "");
  if (digits.length < 7 || /[a-z@]/i.test(query)) return [];
  const rows = all<{ id: string }>("SELECT id FROM handle WHERE id IS NOT NULL AND id NOT LIKE '%@%'");
  const matched = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    if (id.replace(/\D/g, "").includes(digits)) matched.add(id);
  }
  return [...matched];
}

/** Union of handles matched by contact name and by normalised phone digits. */
export function handlesMatching(query: string): string[] {
  return [...new Set([...handlesForName(query), ...handlesForNumber(query)])];
}

/** Counts only, for diagnostics. Never includes names or numbers. */
export function directoryStats(): {
  sourcesFound: number;
  sourcesUnreadable: number;
  contacts: number;
  phoneKeys: number;
  emails: number;
} {
  const dir = load();
  return {
    sourcesFound: dir.sourcesFound,
    sourcesUnreadable: dir.sourcesUnreadable,
    contacts: dir.entries.length,
    phoneKeys: dir.phoneNames.size,
    emails: dir.emailNames.size,
  };
}
