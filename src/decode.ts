/**
 * Decoder for `message.attributedBody`, the NSKeyedArchiver / typedstream blob
 * that modern macOS Messages uses when `message.text` is NULL.
 *
 * We do not parse the full typedstream format. We locate the first NSString
 * record, skip to its '+' (0x2B) type marker, read the length prefix and
 * return the UTF-8 bytes that follow. Every read is bounds-checked and any
 * malformed input yields `null` rather than throwing.
 */

const NSSTRING_MARKER = Buffer.from("NSString", "utf8");
const PLUS = 0x2b;
/** How far past "NSString" we will look for the '+' marker. */
const PLUS_SEARCH_WINDOW = 64;
/** U+FFFC OBJECT REPLACEMENT CHARACTER: placeholder for inline attachments. */
const OBJECT_REPLACEMENT = /￼/g;

/**
 * Normalise the value SQLite hands back for a BLOB column (a Uint8Array) into
 * a Buffer view without copying.
 */
export function toBuffer(blob: unknown): Buffer | null {
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof Uint8Array) {
    return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  }
  return null;
}

/** Read the typedstream length prefix starting at `pos`. */
function readLength(buf: Buffer, pos: number): { length: number; next: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first < 0x81) {
    return { length: first, next: pos + 1 };
  }
  if (first === 0x81) {
    if (pos + 3 > buf.length) return null;
    return { length: buf.readUInt16LE(pos + 1), next: pos + 3 };
  }
  if (first === 0x82) {
    if (pos + 5 > buf.length) return null;
    return { length: buf.readUInt32LE(pos + 1), next: pos + 5 };
  }
  return null;
}

/**
 * Extract the plain text of the first NSString in an attributedBody blob.
 * Returns `null` when there is no decodable text.
 */
export function decodeAttributedBody(blob: unknown): string | null {
  const buf = toBuffer(blob);
  if (!buf || buf.length === 0) return null;

  const marker = buf.indexOf(NSSTRING_MARKER);
  if (marker === -1) return null;

  const searchStart = marker + NSSTRING_MARKER.length;
  const searchEnd = Math.min(buf.length, searchStart + PLUS_SEARCH_WINDOW);
  let plusAt = -1;
  for (let i = searchStart; i < searchEnd; i++) {
    if (buf[i] === PLUS) {
      plusAt = i;
      break;
    }
  }
  if (plusAt === -1) return null;

  const prefix = readLength(buf, plusAt + 1);
  if (!prefix) return null;
  const { length, next } = prefix;
  if (length === 0 || next + length > buf.length) return null;

  const text = buf.toString("utf8", next, next + length);
  const cleaned = text.replace(OBJECT_REPLACEMENT, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}
