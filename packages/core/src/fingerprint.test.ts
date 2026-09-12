import { describe, expect, it } from "vitest";
import type { Comment } from "./types.js";
import { serializeComment } from "./marker.js";
import { parseDocument } from "./document.js";
import { blockFingerprint, normalizeForFingerprint, sha256Hex, threadFingerprint } from "./fingerprint.js";

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

describe("sha256Hex", () => {
  it("matches known test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".slice(0, 64));
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".slice(0, 64));
  });

  it("is deterministic and sensitive to input", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("normalizeForFingerprint", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeForFingerprint("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves LF-only text untouched", () => {
    expect(normalizeForFingerprint("a\nb\nc")).toBe("a\nb\nc");
  });
});

describe("threadFingerprint", () => {
  it("is the same for equivalent threads regardless of unrelated fields", () => {
    const c1 = baseComment({ text: "hello", state: "open" });
    const c2 = baseComment({ text: "hello", state: "open", author: "someone-else", timestamp: "2099-01-01T00:00:00Z" });
    expect(threadFingerprint(c1)).toBe(threadFingerprint(c2));
  });

  it("changes when text, state, or replies change", () => {
    const c1 = baseComment({ text: "hello", state: "open" });
    const c2 = baseComment({ text: "goodbye", state: "open" });
    const c3 = baseComment({ text: "hello", state: "resolved" });
    const c4 = baseComment({
      text: "hello",
      state: "open",
      replies: [{ id: "r1", author: "a", timestamp: "t", text: "reply" }],
    });
    const fp1 = threadFingerprint(c1);
    expect(threadFingerprint(c2)).not.toBe(fp1);
    expect(threadFingerprint(c3)).not.toBe(fp1);
    expect(threadFingerprint(c4)).not.toBe(fp1);
  });
});

describe("blockFingerprint", () => {
  it("is unaffected by marker mutations within the range (state/replies change)", () => {
    const src1Comment = baseComment({ state: "open" });
    const src2Comment = baseComment({ state: "resolved", replies: [{ id: "r1", author: "a", timestamp: "t", text: "x" }] });

    const marker1 = serializeComment(src1Comment);
    const marker2 = serializeComment(src2Comment);

    const src1 = `paragraph text ${marker1}more text`;
    const src2 = `paragraph text ${marker2}more text`;

    const doc1 = parseDocument(src1);
    const doc2 = parseDocument(src2);

    const fp1 = blockFingerprint(src1, { start: 0, end: src1.length }, doc1.markers);
    const fp2 = blockFingerprint(src2, { start: 0, end: src2.length }, doc2.markers);

    expect(fp1).toBe(fp2);
  });

  it("changes when the surrounding text changes", () => {
    const marker = serializeComment(baseComment());
    const src1 = `paragraph text ${marker}more text`;
    const src2 = `different paragraph ${marker}more text`;
    const doc1 = parseDocument(src1);
    const doc2 = parseDocument(src2);

    const fp1 = blockFingerprint(src1, { start: 0, end: src1.length }, doc1.markers);
    const fp2 = blockFingerprint(src2, { start: 0, end: src2.length }, doc2.markers);
    expect(fp1).not.toBe(fp2);
  });

  it("normalizes CRLF before hashing so line-ending changes alone don't matter", () => {
    const marker = serializeComment(baseComment());
    const srcLf = `line one\n${marker}line two`;
    const srcCrlf = `line one\r\n${marker}line two`;
    const docLf = parseDocument(srcLf);
    const docCrlf = parseDocument(srcCrlf);

    const fpLf = blockFingerprint(srcLf, { start: 0, end: srcLf.length }, docLf.markers);
    const fpCrlf = blockFingerprint(srcCrlf, { start: 0, end: srcCrlf.length }, docCrlf.markers);
    expect(fpLf).toBe(fpCrlf);
  });

  it("removes a block-level marker's whole line (with its leading prefix) from the fingerprinted fragment", () => {
    const marker = serializeComment(baseComment());
    const src = `> line one\n> ${marker}\n> line two`;
    const doc = parseDocument(src);
    const fp = blockFingerprint(src, { start: 0, end: src.length }, doc.markers);
    const expected = sha256Hex(normalizeForFingerprint("> line one\n> line two"));
    expect(fp).toBe(expected);
  });
});
