import { describe, expect, it } from "vitest";
import type { Comment } from "./types.js";
import { serializeComment } from "./marker.js";
import { isReadOnly, markersById, parseDocument, removeMarkerRange } from "./document.js";

function baseComment(overrides: Partial<Comment> = {}): Comment {
  return {
    schemaVersion: 1,
    id: "11111111-1111-1111-1111-111111111111",
    anchor: "anchor",
    prefix: "",
    suffix: "",
    text: "some comment",
    author: "naoki",
    timestamp: "2026-09-07T09:12:00+09:00",
    state: "open",
    replies: [],
    ...overrides,
  };
}

describe("parseDocument: happy paths", () => {
  it("finds an inline marker inside a paragraph", () => {
    const marker = serializeComment(baseComment());
    const src = `text before ${marker}text after`;
    const doc = parseDocument(src);
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(occ.blockLevel).toBe(false);
    expect(src.slice(occ.start, occ.end)).toBe(marker);
    expect(occ.raw).toBe(marker);
    expect(occ.comment.id).toBe(baseComment().id);
  });

  it("finds a block-level marker sitting alone on its own line", () => {
    const marker = serializeComment(baseComment());
    const src = `para one\n\n${marker}\n\npara two`;
    const doc = parseDocument(src);
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(occ.blockLevel).toBe(true);
    expect(src.slice(occ.start, occ.end)).toBe(marker);
  });

  it("detects block-level markers inside a blockquote, preserving the '> ' prefix in offsets", () => {
    const marker = serializeComment(baseComment());
    const src = `> ${marker}\n> quoted text`;
    const doc = parseDocument(src);
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(occ.blockLevel).toBe(true);
    expect(src.slice(occ.start, occ.end)).toBe(marker);
    expect(occ.start).toBe(2); // right after "> "
  });

  it("detects block-level markers inside an indented list item", () => {
    const marker = serializeComment(baseComment());
    const src = `- item one\n  ${marker}\n- item two`;
    const doc = parseDocument(src);
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(occ.blockLevel).toBe(true);
    expect(src.slice(occ.start, occ.end)).toBe(marker);
  });

  it("ignores marker-like text inside a fenced code block", () => {
    const marker = serializeComment(baseComment());
    const src = `before\n\n\`\`\`\n${marker}\n\`\`\`\n\nafter`;
    const doc = parseDocument(src);
    expect(doc.markers).toHaveLength(0);
    expect(doc.errors).toHaveLength(0);
  });

  it("ignores marker-like text inside inline code", () => {
    const marker = serializeComment(baseComment());
    const src = `text \`${marker}\` more text`;
    const doc = parseDocument(src);
    expect(doc.markers).toHaveLength(0);
    expect(doc.errors).toHaveLength(0);
  });

  it("ignores marker-like text inside an indented code block", () => {
    const marker = serializeComment(baseComment());
    const src = `para\n\n    ${marker}\n\npara2`;
    const doc = parseDocument(src);
    expect(doc.markers).toHaveLength(0);
    expect(doc.errors).toHaveLength(0);
  });
});

describe("parseDocument: CRLF and BOM offsets", () => {
  it("computes correct offsets for a CRLF source", () => {
    const marker = serializeComment(baseComment());
    const src = `para one\r\n\r\n${marker}\r\n\r\npara two`;
    const doc = parseDocument(src);
    expect(doc.lineEnding).toBe("\r\n");
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(src.slice(occ.start, occ.end)).toBe(marker);
  });

  it("computes correct offsets for a source with a BOM", () => {
    const marker = serializeComment(baseComment());
    const src = `﻿para one\n\n${marker}\n\npara two`;
    const doc = parseDocument(src);
    expect(doc.hasBom).toBe(true);
    expect(doc.errors).toEqual([]);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(src.slice(occ.start, occ.end)).toBe(marker);
    expect(occ.raw).toBe(marker);
  });

  it("computes correct offsets for an inline marker in a BOM + CRLF source", () => {
    const marker = serializeComment(baseComment());
    const src = `﻿hello ${marker}world\r\nsecond line`;
    const doc = parseDocument(src);
    expect(doc.hasBom).toBe(true);
    expect(doc.markers).toHaveLength(1);
    const occ = doc.markers[0]!;
    expect(src.slice(occ.start, occ.end)).toBe(marker);
  });
});

describe("parseDocument: errors", () => {
  it("reports unknown-schema-version", () => {
    const src = 'x <!-- @comment{"schemaVersion":2,"id":"a","anchor":"","prefix":"","suffix":"","text":"","author":"","timestamp":"","state":"open","replies":[]} -->y';
    const doc = parseDocument(src);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0]!.kind).toBe("unknown-schema-version");
    expect(isReadOnly(doc)).toBe(true);
  });

  it("reports missing-field", () => {
    const src = 'x <!-- @comment{"schemaVersion":1,"id":"a","anchor":"","prefix":"","suffix":"","author":"","timestamp":"","state":"open","replies":[]} -->y';
    const doc = parseDocument(src);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0]!.kind).toBe("missing-field");
  });

  it("reports invalid-json", () => {
    const src = "x <!-- @comment{not json} -->y";
    const doc = parseDocument(src);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0]!.kind).toBe("invalid-json");
  });

  it("reports broken-marker for an unterminated marker", () => {
    const src = "para one\n\n<!-- @comment{\"a\":1} still going, no close\n\npara two";
    const doc = parseDocument(src);
    expect(doc.errors.some((e) => e.kind === "broken-marker")).toBe(true);
  });

  it("reports duplicate-id on the second (and later) occurrence, but lists all in markers", () => {
    const c1 = baseComment({ id: "dupe-id", text: "first" });
    const c2 = baseComment({ id: "dupe-id", text: "second" });
    const m1 = serializeComment(c1);
    const m2 = serializeComment(c2);
    const src = `first ${m1} then\n\nsecond ${m2} end`;
    const doc = parseDocument(src);

    expect(doc.markers).toHaveLength(2);
    expect(doc.markers[0]!.comment.text).toBe("first");
    expect(doc.markers[1]!.comment.text).toBe("second");

    const dupErrors = doc.errors.filter((e) => e.kind === "duplicate-id");
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0]!.id).toBe("dupe-id");
    expect(isReadOnly(doc)).toBe(true);
  });
});

describe("markersById", () => {
  it("keeps the first occurrence when ids collide", () => {
    const c1 = baseComment({ id: "dupe", text: "first" });
    const c2 = baseComment({ id: "dupe", text: "second" });
    const src = `${serializeComment(c1)} mid ${serializeComment(c2)}`;
    const doc = parseDocument(src);
    const map = markersById(doc);
    expect(map.get("dupe")!.comment.text).toBe("first");
  });
});

describe("removeMarkerRange", () => {
  it("returns exactly [start,end) for an inline marker", () => {
    const marker = serializeComment(baseComment());
    const src = `text before ${marker}text after`;
    const doc = parseDocument(src);
    const occ = doc.markers[0]!;
    const range = removeMarkerRange(src, occ);
    expect(range).toEqual({ start: occ.start, end: occ.end });
  });

  it("removes the whole line (with '> ' prefix) for a block-level marker in a blockquote", () => {
    const marker = serializeComment(baseComment());
    const src = `> ${marker}\n> quoted text`;
    const doc = parseDocument(src);
    const occ = doc.markers[0]!;
    const range = removeMarkerRange(src, occ);
    const result = src.slice(0, range.start) + src.slice(range.end);
    expect(result).toBe("> quoted text");
  });
});
