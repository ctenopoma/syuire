/**
 * Marker (HTML comment) serialization and parsing. See DESIGN.md 5.1, 5.2.
 */
import {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  SCHEMA_VERSION,
  type Comment,
  type MarkerErrorKind,
  type Reply,
} from "./types.js";

const KNOWN_COMMENT_KEYS = [
  "schemaVersion",
  "id",
  "anchor",
  "prefix",
  "suffix",
  "text",
  "author",
  "timestamp",
  "state",
  "replies",
] as const;

const KNOWN_REPLY_KEYS = ["id", "author", "timestamp", "text"] as const;

function orderReply(r: Reply): Reply {
  const source = r as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_REPLY_KEYS) {
    ordered[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (!(KNOWN_REPLY_KEYS as readonly string[]).includes(key)) {
      ordered[key] = source[key];
    }
  }
  return ordered as unknown as Reply;
}

function orderComment(c: Comment): Record<string, unknown> {
  const source = c as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_COMMENT_KEYS) {
    if (key === "replies") {
      ordered[key] = c.replies.map(orderReply);
    } else {
      ordered[key] = source[key];
    }
  }
  for (const key of Object.keys(source)) {
    if (!(KNOWN_COMMENT_KEYS as readonly string[]).includes(key)) {
      ordered[key] = source[key];
    }
  }
  return ordered;
}

/**
 * Escapes `<`, `>`, `&` and runs of 2+ consecutive `-` in a JSON text so it
 * can be embedded inside an HTML comment without ending it early. See
 * DESIGN.md 5.2.
 */
export function escapeJsonForHtmlComment(json: string): string {
  let out = json.replace(/[<>&]/g, (ch) => {
    switch (ch) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      default:
        return ch;
    }
  });
  out = out.replace(/-{2,}/g, (run) => run[0] + "\\u002d".repeat(run.length - 1));
  return out;
}

/** Serializes a comment into the full `<!-- @comment{...} -->` marker text. */
export function serializeComment(c: Comment): string {
  const ordered = orderComment(c);
  const json = JSON.stringify(ordered);
  const escaped = escapeJsonForHtmlComment(json);
  return MARKER_PREFIX + escaped + MARKER_SUFFIX;
}

export type ParseMarkerJsonResult =
  | { ok: true; comment: Comment }
  | { ok: false; error: MarkerErrorKind; message: string };

function fail(kind: MarkerErrorKind, message: string): ParseMarkerJsonResult {
  return { ok: false, error: kind, message };
}

function missingField(field: string): ParseMarkerJsonResult {
  return fail("missing-field", `missing or invalid field: ${field}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReplies(value: unknown): { ok: true; replies: Reply[] } | { ok: false; result: ParseMarkerJsonResult } {
  if (!Array.isArray(value)) {
    return { ok: false, result: missingField("replies") };
  }
  const replies: Reply[] = [];
  for (let i = 0; i < value.length; i++) {
    const r: unknown = value[i];
    if (!isPlainObject(r)) {
      return { ok: false, result: missingField(`replies[${i}]`) };
    }
    for (const field of ["id", "author", "timestamp", "text"] as const) {
      if (typeof r[field] !== "string") {
        return { ok: false, result: missingField(`replies[${i}].${field}`) };
      }
    }
    replies.push(r as unknown as Reply);
  }
  return { ok: true, replies };
}

/** Validates a parsed JSON value against the Comment shape. See DESIGN.md 5.1. */
export function validateCommentShape(parsed: unknown): ParseMarkerJsonResult {
  if (!isPlainObject(parsed)) {
    return missingField("(root)");
  }

  if (!("schemaVersion" in parsed)) {
    return missingField("schemaVersion");
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return fail("unknown-schema-version", `unknown schemaVersion: ${String(parsed.schemaVersion)}`);
  }

  for (const field of ["id", "anchor", "prefix", "suffix", "text", "author", "timestamp"] as const) {
    if (typeof parsed[field] !== "string") {
      return missingField(field);
    }
  }

  if (parsed.state !== "open" && parsed.state !== "resolved") {
    return missingField("state");
  }

  const repliesResult = validateReplies(parsed.replies);
  if (!repliesResult.ok) {
    return repliesResult.result;
  }

  const comment: Comment = {
    ...parsed,
    schemaVersion: SCHEMA_VERSION,
    id: parsed.id as string,
    anchor: parsed.anchor as string,
    prefix: parsed.prefix as string,
    suffix: parsed.suffix as string,
    text: parsed.text as string,
    author: parsed.author as string,
    timestamp: parsed.timestamp as string,
    state: parsed.state,
    replies: repliesResult.replies,
  } as Comment;

  return { ok: true, comment };
}

/** Parses the JSON payload of a marker (without the `<!-- @comment` / ` -->` wrapper). */
export function parseMarkerJson(json: string): ParseMarkerJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return fail("invalid-json", e instanceof Error ? e.message : "invalid JSON");
  }
  return validateCommentShape(parsed);
}

/**
 * Given the offset of `<!-- @comment` in `source`, returns the offset just
 * after the first `-->` found at or after `start`, or -1 if none exists.
 */
export function findMarkerEnd(source: string, start: number): number {
  const idx = source.indexOf("-->", start);
  if (idx === -1) {
    return -1;
  }
  return idx + 3;
}

export type MarkerAtResult =
  | { ok: true; json: string; start: number; end: number }
  | { ok: false; error: "broken-marker"; message: string; start: number };

/**
 * Extracts the JSON payload between `<!-- @comment` and the closing ` -->`
 * starting at `start` (the offset of `<!-- @comment` in `source`). Tolerates
 * extra/missing whitespace before `-->`.
 */
export function parseMarkerAt(source: string, start: number): MarkerAtResult {
  const end = findMarkerEnd(source, start);
  if (end === -1) {
    return {
      ok: false,
      error: "broken-marker",
      message: "unterminated marker: no closing --> found",
      start,
    };
  }
  const inner = source.slice(start + MARKER_PREFIX.length, end - 3);
  const json = inner.replace(/\s+$/, "");
  return { ok: true, json, start, end };
}
