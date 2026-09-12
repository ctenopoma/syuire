import { describe, expect, it } from "vitest";
import type { Comment } from "./types.js";
import { serializeComment } from "./marker.js";
import { parseDocument } from "./document.js";
import { renderReviewLog, reviewLogPath, stripBlockers, stripMarkers } from "./strip.js";

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
    state: "resolved",
    replies: [],
    ...overrides,
  };
}

describe("stripMarkers", () => {
  it("removes an inline marker, leaving surrounding text byte-identical", () => {
    const marker = serializeComment(baseComment());
    const src = `before text ${marker}after text`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result).toBe("before text after text");
  });

  it("removes a block-level marker's whole line, including blockquote prefix and its line ending", () => {
    const marker = serializeComment(baseComment());
    const src = `> line one\n> ${marker}\n> line two\n`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result).toBe("> line one\n> line two\n");
  });

  it("removes a block-level marker's line including leading indentation in a list item", () => {
    const marker = serializeComment(baseComment());
    const src = `- item one\n  ${marker}\n- item two\n`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result).toBe("- item one\n- item two\n");
  });

  it("preserves CRLF line endings elsewhere in the document", () => {
    const marker = serializeComment(baseComment());
    const src = `para one\r\n\r\n${marker}\r\npara two\r\n`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result).toBe("para one\r\n\r\npara two\r\n");
    expect(result.includes("\r\n")).toBe(true);
  });

  it("preserves a leading BOM", () => {
    const marker = serializeComment(baseComment());
    const src = `﻿para one\n\n${marker}\npara two`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result.charCodeAt(0)).toBe(0xfeff);
    expect(result).toBe("﻿para one\n\npara two");
  });

  it("removes a block marker that is the last line without a trailing newline without leaving a dangling blank line", () => {
    const marker = serializeComment(baseComment());
    const src = `para one\n\n${marker}`;
    const doc = parseDocument(src);
    const result = stripMarkers(doc);
    expect(result).toBe("para one\n");
  });
});

describe("stripBlockers", () => {
  it("blocks when there are format errors", () => {
    const src = "x <!-- @comment{not json} -->y";
    const doc = parseDocument(src);
    const blockers = stripBlockers(doc);
    expect(blockers.length).toBeGreaterThan(0);
  });

  it("blocks when a comment is still open", () => {
    const marker = serializeComment(baseComment({ state: "open" }));
    const doc = parseDocument(`text ${marker}more`);
    const blockers = stripBlockers(doc);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.some((b) => b.includes("11111111-1111-1111-1111-111111111111"))).toBe(true);
  });

  it("is empty when there are no errors and every comment is resolved", () => {
    const marker = serializeComment(baseComment({ state: "resolved" }));
    const doc = parseDocument(`text ${marker}more`);
    expect(stripBlockers(doc)).toEqual([]);
  });
});

describe("reviewLogPath", () => {
  it("matches the DESIGN.md 5.4 example", () => {
    const path = reviewLogPath("docs/foo.md", new Date("2026-09-07T00:12:00Z"), "some-batch-id");
    expect(path).toBe("reviews/docs/foo/20260907T001200Z-some-batch-id.md");
  });

  it("normalizes backslashes and strips a leading ./", () => {
    const path = reviewLogPath(".\\docs\\bar.md", new Date("2026-01-02T03:04:05Z"), "b1");
    expect(path).toBe("reviews/docs/bar/20260102T030405Z-b1.md");
  });

  it("handles a path without a .md extension", () => {
    const path = reviewLogPath("docs/readme", new Date("2026-01-02T03:04:05Z"), "b1");
    expect(path).toBe("reviews/docs/readme/20260102T030405Z-b1.md");
  });
});

describe("renderReviewLog", () => {
  it("contains a readable list and a JSON block with all comments", () => {
    const c1 = baseComment({ id: "c1", text: "first comment", anchor: "foo" });
    const c2 = baseComment({
      id: "c2",
      text: "second comment",
      anchor: "bar",
      replies: [{ id: "r1", author: "alice", timestamp: "2026-09-07T10:00:00+09:00", text: "a reply" }],
    });
    const m1 = serializeComment(c1);
    const m2 = serializeComment(c2);
    const src = `${m1}x\n\n${m2}y`;
    const doc = parseDocument(src);

    const log = renderReviewLog({
      originalPath: "docs/foo.md",
      baseCommitId: "abc123",
      batchId: "batch-1",
      strippedAt: new Date("2026-09-07T00:12:00Z"),
      markers: doc.markers,
    });

    expect(log).toContain("docs/foo.md");
    expect(log).toContain("abc123");
    expect(log).toContain("batch-1");
    expect(log).toContain("first comment");
    expect(log).toContain("second comment");
    expect(log).toContain("a reply");
    expect(log).toContain("## マーカー JSON");
    expect(log).toContain("```json");
    expect(log.includes("\r")).toBe(false);

    const jsonStart = log.indexOf("```json") + "```json".length;
    const jsonEnd = log.indexOf("```", jsonStart);
    const jsonText = log.slice(jsonStart, jsonEnd).trim();
    const parsedArray = JSON.parse(jsonText) as unknown[];
    expect(parsedArray).toHaveLength(2);
    expect((parsedArray[0] as Comment).id).toBe("c1");
    expect((parsedArray[1] as Comment).id).toBe("c2");
  });
});
