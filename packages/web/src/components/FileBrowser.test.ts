import { describe, expect, it } from "vitest";
import { isMarkdownPath, matchesFilter } from "./FileBrowser";

describe("isMarkdownPath", () => {
  it("accepts md, markdown and mdx regardless of case", () => {
    expect(isMarkdownPath("docs/a.md")).toBe(true);
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("a.mdx")).toBe(true);
    expect(isMarkdownPath("a.md.bak")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("matches every term case-insensitively anywhere in the path", () => {
    expect(matchesFilter("docs/Guide/intro.md", "guide intro")).toBe(true);
    expect(matchesFilter("docs/Guide/intro.md", "GUIDE")).toBe(true);
    expect(matchesFilter("docs/Guide/intro.md", "guide other")).toBe(false);
    expect(matchesFilter("docs/Guide/intro.md", "   ")).toBe(true);
  });
});
