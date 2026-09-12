/**
 * Credential redaction for anything captured from a Git child process.
 *
 * DESIGN.md 8: the app never stores or forwards Git credentials. Git happily
 * echoes a remote URL back in its stderr, and a URL can carry
 * `https://<user>:<token>@host/...`, so every stdout/stderr string that reaches
 * an `AdapterError` message, its `details`, or the HTTP error body is passed
 * through here first. Long output is capped so an error response cannot carry a
 * whole diff or a whole log.
 */

/** Maximum length of one redacted string. */
export const MAX_DETAIL_CHARS = 2000;

const CREDENTIAL_IN_URL = /:\/\/[^/@\s]+@/g;

/** Replace `scheme://user:secret@host` with `scheme://***@host` and cap the length. */
export function redactText(text: string): string {
  const redacted = text.replace(CREDENTIAL_IN_URL, "://***@");
  if (redacted.length <= MAX_DETAIL_CHARS) return redacted;
  return `${redacted.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/**
 * Redact every string inside an `AdapterError.details` payload. Arrays and
 * plain objects are walked; anything else is returned as-is.
 */
export function redactDetails(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth >= 8) return value;
  if (Array.isArray(value)) return value.map((v) => redactDetails(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDetails(entry, depth + 1);
    }
    return out;
  }
  return value;
}
