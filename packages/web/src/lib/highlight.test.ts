import { describe, expect, it } from "vitest";
import { highlightRanges, resolveLanguage } from "./highlight";
import { splitRun, type Decoration } from "./decorate";
import type { TextRun } from "@syuire/core";

describe("resolveLanguage", () => {
  it("maps fence info strings and aliases", () => {
    expect(resolveLanguage("js")).toBe("javascript");
    expect(resolveLanguage("TypeScript")).toBe("typescript");
    expect(resolveLanguage("py {1,2}")).toBe("python");
    expect(resolveLanguage("sh")).toBe("bash");
    expect(resolveLanguage("html")).toBe("markup");
    expect(resolveLanguage("yml")).toBe("yaml");
  });

  it("returns null for plain text and unknown languages", () => {
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage("text")).toBeNull();
    expect(resolveLanguage("mermaid")).toBeNull();
    expect(resolveLanguage("no-such-language-xyz")).toBeNull();
  });
});

describe("highlightRanges", () => {
  it("returns non-overlapping ranges that cover the tokens exactly", () => {
    const code = 'const x = "a"; // done';
    const ranges = highlightRanges(code, "js");
    expect(ranges.length).toBeGreaterThan(0);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end);
    }
    const byType = new Map(ranges.map((r) => [r.type, code.slice(r.start, r.end)]));
    expect(byType.get("keyword")).toBe("const");
    expect(byType.get("string")).toBe('"a"');
    expect(byType.get("comment")).toBe("// done");
  });

  it("handles nested tokens (template strings) without shifting offsets", () => {
    const code = "const s = `a ${b} c`;";
    const ranges = highlightRanges(code, "ts");
    const last = ranges[ranges.length - 1];
    expect(last).toBeDefined();
    expect(last!.end).toBeLessThanOrEqual(code.length);
    const interp = ranges.find((r) => code.slice(r.start, r.end) === "b");
    expect(interp).toBeDefined();
  });

  it("returns nothing for unknown languages or empty code", () => {
    expect(highlightRanges("x", "nope")).toEqual([]);
    expect(highlightRanges("", "js")).toEqual([]);
  });
});

function run(displayStart: number, displayEnd: number, sourceStart: number, atomic = false): TextRun {
  return {
    kind: "code",
    displayStart,
    displayEnd,
    sourceStart,
    sourceEnd: atomic ? sourceStart + 5 : sourceStart + (displayEnd - displayStart),
    atomic,
  };
}

describe("splitRun", () => {
  it("returns the run whole when nothing overlaps", () => {
    const pieces = splitRun(run(0, 10, 100), [{ start: 20, end: 30, className: "x" }]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ displayStart: 0, displayEnd: 10, sourceStart: 100, sourceEnd: 110, classes: [] });
  });

  it("cuts a run at decoration boundaries and keeps the source mapping exact", () => {
    const decorations: Decoration[] = [
      { start: 2, end: 5, className: "tok-keyword" },
      { start: 4, end: 8, className: "anno", attrs: { "data-comment": "c1" } },
    ];
    const pieces = splitRun(run(0, 10, 100), decorations);
    expect(pieces.map((p) => [p.displayStart, p.displayEnd])).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
      [5, 8],
      [8, 10],
    ]);
    for (const p of pieces) {
      expect(p.sourceStart).toBe(100 + p.displayStart);
      expect(p.sourceEnd).toBe(100 + p.displayEnd);
    }
    expect(pieces[2]?.classes).toEqual(["tok-keyword", "anno"]);
    expect(pieces[2]?.attrs).toEqual({ "data-comment": "c1" });
    expect(pieces[3]?.classes).toEqual(["anno"]);
    expect(pieces[4]?.classes).toEqual([]);
  });

  it("never cuts an atomic run", () => {
    const pieces = splitRun(run(3, 4, 100, true), [{ start: 0, end: 4, className: "anno" }]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ sourceStart: 100, sourceEnd: 105, atomic: true, classes: ["anno"] });
  });

  it("handles decorations that start or end exactly at the run edges", () => {
    const pieces = splitRun(run(10, 20, 0), [{ start: 10, end: 20, className: "a" }]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.classes).toEqual(["a"]);
  });
});
