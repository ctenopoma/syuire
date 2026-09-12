import { describe, expect, it } from "vitest";
import type { Comment } from "./types.js";
import {
  escapeJsonForHtmlComment,
  findMarkerEnd,
  parseMarkerAt,
  parseMarkerJson,
  serializeComment,
} from "./marker.js";

function baseComment(overrides: Partial<Comment> = {}): Comment {
  return {
    schemaVersion: 1,
    id: "a3407a0e-86b6-4b0d-968b-1c734d723a55",
    anchor: "この表現",
    prefix: "本文の ",
    suffix: "を見直す。",
    text: "具体例を加えてほしい",
    author: "naoki",
    timestamp: "2026-09-07T09:12:00+09:00",
    state: "open",
    replies: [],
    ...overrides,
  };
}

function roundTrip(marker: string, expectStart = 0): ReturnType<typeof parseMarkerJson> {
  const at = parseMarkerAt(marker, expectStart);
  expect(at.ok).toBe(true);
  if (!at.ok) throw new Error("unreachable");
  return parseMarkerJson(at.json);
}

describe("serializeComment / DESIGN 5.1 round trip", () => {
  it("matches the DESIGN.md 5.1 example exactly", () => {
    const c = baseComment();
    const marker = serializeComment(c);
    const expected =
      '<!-- @comment{"schemaVersion":1,"id":"a3407a0e-86b6-4b0d-968b-1c734d723a55","anchor":"この表現","prefix":"本文の ","suffix":"を見直す。","text":"具体例を加えてほしい","author":"naoki","timestamp":"2026-09-07T09:12:00+09:00","state":"open","replies":[]} -->';
    expect(marker).toBe(expected);
  });

  it("round trips through parseMarkerAt + parseMarkerJson", () => {
    const c = baseComment();
    const marker = serializeComment(c);
    const result = roundTrip(marker);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comment).toEqual(c);
    }
  });

  it("embeds inside surrounding Markdown as in the example", () => {
    const c = baseComment();
    const marker = serializeComment(c);
    const doc = `本文の ${marker}この表現を見直す。`;
    expect(doc).toContain(marker);
    const start = doc.indexOf("<!-- @comment");
    const at = parseMarkerAt(doc, start);
    expect(at.ok).toBe(true);
  });
});

describe("escaping", () => {
  const dangerousTexts = [
    "<script>alert(1)</script>",
    "a & b",
    "close the comment --> right here",
    "dash run --",
    "dash run ---",
    "dash run ----",
    "literal backslash-u002d: \\u002d in text",
    'quotes " and \' and backslash \\',
    "line1\nline2\ttab",
    "日本語のコメントです、絵文字も 🎉🚀 入れます",
    "mixed <<>>&&--> chaos --- string",
  ];

  for (const text of dangerousTexts) {
    it(`round trips and stays comment-safe for: ${JSON.stringify(text).slice(0, 40)}...`, () => {
      const c = baseComment({ text });
      const marker = serializeComment(c);

      // The marker must not contain characters/sequences that would break
      // out of the HTML comment or introduce raw markup.
      const inner = marker.slice("<!-- @comment".length, marker.length - " -->".length);
      expect(inner.includes("-->")).toBe(false);
      expect(inner.includes("--")).toBe(false);
      expect(inner.includes("<")).toBe(false);
      expect(inner.includes(">")).toBe(false);
      expect(inner.includes("&")).toBe(false);

      const result = roundTrip(marker);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.comment.text).toBe(text);
      }
    });
  }

  it("collapses runs of dashes per the documented example", () => {
    expect(escapeJsonForHtmlComment('"--"')).toBe('"-\\u002d"');
    expect(escapeJsonForHtmlComment('"---"')).toBe('"-\\u002d\\u002d"');
    expect(escapeJsonForHtmlComment('"----"')).toBe('"-\\u002d\\u002d\\u002d"');
  });

  it("escapes <, >, & individually", () => {
    expect(escapeJsonForHtmlComment("<")).toBe("\\u003c");
    expect(escapeJsonForHtmlComment(">")).toBe("\\u003e");
    expect(escapeJsonForHtmlComment("&")).toBe("\\u0026");
  });

  it("does not mangle a literal backslash-u002d already present as text", () => {
    // JSON.stringify turns the 6-char string - (backslash,u,0,0,2,d)
    // into the 7-char JSON source \\u002d; our dash pass must not touch it
    // because it contains no literal '-' character.
    const c = baseComment({ text: "prefix\\u002dsuffix" });
    const marker = serializeComment(c);
    const result = roundTrip(marker);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comment.text).toBe("prefix\\u002dsuffix");
    }
  });
});

describe("unknown fields", () => {
  it("preserves unknown comment-level fields and their insertion order", () => {
    const c = baseComment();
    // Insert in a specific (non-alphabetical) order.
    (c as unknown as Record<string, unknown>).zzz = "last-ish";
    (c as unknown as Record<string, unknown>).aaa = "first-ish";

    const marker = serializeComment(c);
    const at = parseMarkerAt(marker, 0);
    expect(at.ok).toBe(true);
    if (!at.ok) throw new Error("unreachable");

    // Order in the raw JSON text: known fields first, then zzz, then aaa.
    const zzzIdx = at.json.indexOf('"zzz"');
    const aaaIdx = at.json.indexOf('"aaa"');
    const repliesIdx = at.json.indexOf('"replies"');
    expect(zzzIdx).toBeGreaterThan(repliesIdx);
    expect(aaaIdx).toBeGreaterThan(zzzIdx);

    const parsed = parseMarkerJson(at.json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.comment as unknown as Record<string, unknown>).zzz).toBe("last-ish");
      expect((parsed.comment as unknown as Record<string, unknown>).aaa).toBe("first-ish");

      // Re-serializing preserves the same order.
      const reserialized = serializeComment(parsed.comment);
      const at2 = parseMarkerAt(reserialized, 0);
      expect(at2.ok).toBe(true);
      if (at2.ok) {
        expect(at2.json.indexOf('"zzz"')).toBeLessThan(at2.json.indexOf('"aaa"'));
      }
    }
  });

  it("preserves unknown reply-level fields and their insertion order", () => {
    const reply = {
      id: "r1",
      author: "bob",
      timestamp: "2026-09-07T10:00:00+09:00",
      text: "reply text",
      later: "L",
      earlier: "E",
    };
    const c = baseComment({ replies: [reply] });
    const marker = serializeComment(c);
    const result = roundTrip(marker);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.comment.replies[0] as unknown as Record<string, unknown>;
      expect(r.later).toBe("L");
      expect(r.earlier).toBe("E");
    }

    const at = parseMarkerAt(marker, 0);
    if (at.ok) {
      const laterIdx = at.json.indexOf('"later"');
      const earlierIdx = at.json.indexOf('"earlier"');
      const textIdx = at.json.lastIndexOf('"text"'); // reply's text field
      expect(laterIdx).toBeGreaterThan(textIdx);
      expect(earlierIdx).toBeGreaterThan(laterIdx);
    }
  });
});

describe("errors", () => {
  it("reports unknown-schema-version for schemaVersion 2", () => {
    const json = '{"schemaVersion":2,"id":"x","anchor":"","prefix":"","suffix":"","text":"","author":"","timestamp":"","state":"open","replies":[]}';
    const result = parseMarkerJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown-schema-version");
    }
  });

  it("reports missing-field when schemaVersion is absent", () => {
    const json = '{"id":"x","anchor":"","prefix":"","suffix":"","text":"","author":"","timestamp":"","state":"open","replies":[]}';
    const result = parseMarkerJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-field");
      expect(result.message).toContain("schemaVersion");
    }
  });

  it("reports missing-field for a missing required string field", () => {
    const json = '{"schemaVersion":1,"id":"x","anchor":"","prefix":"","suffix":"","author":"","timestamp":"","state":"open","replies":[]}';
    const result = parseMarkerJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-field");
      expect(result.message).toContain("text");
    }
  });

  it("reports missing-field for an invalid state value", () => {
    const json = '{"schemaVersion":1,"id":"x","anchor":"","prefix":"","suffix":"","text":"","author":"","timestamp":"","state":"pending","replies":[]}';
    const result = parseMarkerJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-field");
    }
  });

  it("reports invalid-json for malformed JSON", () => {
    const result = parseMarkerJson("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid-json");
    }
  });
});

describe("findMarkerEnd / parseMarkerAt", () => {
  it("finds the end just after the first -->", () => {
    const src = "xx<!-- @comment{} -->yy";
    const start = src.indexOf("<!--");
    const end = findMarkerEnd(src, start);
    expect(end).toBe(src.indexOf("-->") + 3);
  });

  it("returns -1 when unterminated", () => {
    const src = "xx<!-- @comment{} still going";
    const start = src.indexOf("<!--");
    expect(findMarkerEnd(src, start)).toBe(-1);
  });

  it("parseMarkerAt reports broken-marker for an unterminated marker", () => {
    const src = "xx<!-- @comment{\"a\":1}";
    const start = src.indexOf("<!--");
    const at = parseMarkerAt(src, start);
    expect(at.ok).toBe(false);
    if (!at.ok) {
      expect(at.error).toBe("broken-marker");
    }
  });

  it("tolerates extra whitespace before -->", () => {
    const src = '<!-- @comment{"a":1}   -->';
    const at = parseMarkerAt(src, 0);
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.json).toBe('{"a":1}');
    }
  });
});
