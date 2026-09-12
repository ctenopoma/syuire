/**
 * Content fingerprints used by the operation queue to detect conflicting
 * external edits. See DESIGN.md 7.3.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { removalRange } from "./document.js";
import type { Comment, MarkerOccurrence, SourceRange } from "./types.js";

/** Hex-encoded SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Normalises line endings to LF (CRLF and lone CR both become LF). */
export function normalizeForFingerprint(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * The "本文の指紋" (block fingerprint): the source range with every marker
 * occurrence inside it removed, newlines normalised to LF, then hashed. See
 * DESIGN.md 7.3.
 */
export function blockFingerprint(source: string, range: SourceRange, markers: MarkerOccurrence[]): string {
  let fragment = source.slice(range.start, range.end);

  const relevant = markers
    .filter((m) => m.start >= range.start && m.end <= range.end)
    .map((m) => ({ start: m.start - range.start, end: m.end - range.start, blockLevel: m.blockLevel }))
    .sort((a, b) => b.start - a.start);

  for (const occ of relevant) {
    const r = removalRange(fragment, occ.start, occ.end, occ.blockLevel);
    fragment = fragment.slice(0, r.start) + fragment.slice(r.end);
  }

  return sha256Hex(normalizeForFingerprint(fragment));
}

/** The thread fingerprint: hash of the comment's text, state, and replies. */
export function threadFingerprint(c: Comment): string {
  const payload = {
    text: c.text,
    state: c.state,
    replies: c.replies.map((r) => ({ id: r.id, author: r.author, timestamp: r.timestamp, text: r.text })),
  };
  return sha256Hex(JSON.stringify(payload));
}
