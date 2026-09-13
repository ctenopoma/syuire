import { describe, expect, it } from "vitest";
import { buildTextMap, markerStatuses } from "@syuire/core";
import type { VNode } from "preact";
import {
  MarkdownRenderer,
  headingSlug,
  imageMimeType,
  isRepositoryImage,
  outlineOf,
  safeHref,
  type RendererContext,
} from "./MarkdownRenderer";
import { buildAnnotations } from "../lib/annotations";

function makeContext(source: string, extra: Partial<RendererContext> = {}): RendererContext {
  const tm = buildTextMap(source);
  const numbers = new Map<number, number>();
  const ids = new Map<number, string>();
  const gutter = new Map<number, number[]>();
  const changed = new Set<string>();
  const statuses = markerStatuses(source);
  statuses.forEach((status, index) => {
    numbers.set(status.occurrence.start, index + 1);
    ids.set(status.occurrence.start, status.occurrence.comment.id);
    if (status.block) {
      const key = status.block.flowRange.start;
      const list = gutter.get(key);
      if (list) list.push(index + 1);
      else gutter.set(key, [index + 1]);
    }
  });
  return {
    tm,
    markerNumbers: numbers,
    markerIds: ids,
    gutter,
    changed,
    annotations: buildAnnotations(tm, statuses),
    activeCommentId: null,
    highlightCode: true,
    autoImages: false,
    onMarkerClick: () => undefined,
    onOpenLink: () => undefined,
    loadImage: async () => "blob:none",
    ...extra,
  };
}

interface Walked {
  spans: Array<{ start: number; end: number; atomic: boolean; text: string; cls: string }>;
  types: string[];
  text: string;
  props: Array<{ type: string; props: Record<string, unknown> }>;
}

function walk(node: unknown, out: Walked): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === "string") {
    out.text += node;
    return;
  }
  if (typeof node === "number") {
    out.text += String(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  const vnode = node as VNode<Record<string, unknown>>;
  const type = vnode.type;
  if (typeof type === "string") out.types.push(type);
  const props = (vnode.props ?? {}) as Record<string, unknown>;
  if (typeof type === "string") out.props.push({ type, props });
  const rawStart = props["data-s"];
  if (typeof rawStart === "string") {
    const childText: Walked = { spans: [], types: [], text: "", props: [] };
    walk(props["children"], childText);
    out.spans.push({
      start: Number(rawStart),
      end: Number(props["data-e"]),
      atomic: props["data-atomic"] === "1",
      text: childText.text,
      cls: typeof props["class"] === "string" ? props["class"] : "",
    });
  }
  walk(props["children"], out);
}

function render(source: string, extra: Partial<RendererContext> = {}): Walked {
  const out: Walked = { spans: [], types: [], text: "", props: [] };
  walk(MarkdownRenderer({ ctx: makeContext(source, extra) }), out);
  return out;
}

/** Every non-atomic span must show exactly the source it claims to come from. */
function expectExactMapping(source: string, result: Walked): void {
  for (const span of result.spans) {
    expect(span.end).toBeGreaterThanOrEqual(span.start);
    if (!span.atomic) expect(source.slice(span.start, span.end)).toBe(span.text);
  }
}

const COMMENT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function marker(anchor: string, prefix: string, suffix: string, state = "open"): string {
  const json = JSON.stringify({
    schemaVersion: 1,
    id: COMMENT_ID,
    anchor,
    prefix,
    suffix,
    text: "直す",
    author: "naoki",
    timestamp: "2026-09-07T09:12:00+09:00",
    state,
    replies: [],
  });
  return `<!-- @comment${json} -->`;
}

describe("MarkdownRenderer", () => {
  it("emits one span per run and never uses the node value", () => {
    const source = "本文の**強調**と`code`と&amp;と\\*escape\\*。\n";
    const result = render(source);
    expect(result.types).toContain("p");
    expect(result.types).toContain("strong");
    expect(result.types).toContain("code");
    expectExactMapping(source, result);

    // The entity and the escape are atomic and show the decoded character.
    const atomic = result.spans.filter((s) => s.atomic);
    expect(atomic.map((s) => s.text)).toContain("&");
    expect(atomic.map((s) => s.text)).toContain("*");
  });

  it("shows raw HTML as literal text instead of injecting it", () => {
    const result = render("前<b>強調</b>後\n");
    expect(result.types).not.toContain("b");
    expect(result.text).toContain("<b>");
    expect(result.text).toContain("</b>");
  });

  it("renders a marker as a numbered badge and never as text", () => {
    const source = `この${marker("表現", "この", "を見直す")}表現を見直す\n`;
    const result = render(source);
    expect(result.types).toContain("button");
    expect(result.text).not.toContain("@comment");
    // Body text is intact; the "1"s are the gutter number and the badge.
    expect(result.text).toContain("この");
    expect(result.text).toContain("表現を見直す");
    expect(result.spans.map((s) => s.text).join("")).toBe("この表現を見直す");
    expect(result.types.filter((t) => t === "button")).toHaveLength(1);
  });

  it("renders tables, lists, quotes and code blocks", () => {
    const source = [
      "# 見出し",
      "",
      "> 引用",
      "",
      "- 一つ目",
      "- [x] 二つ目",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "---",
      "",
    ].join("\n");
    const result = render(source);
    for (const tag of ["h1", "blockquote", "ul", "li", "table", "th", "td", "pre", "hr", "input"]) {
      expect(result.types).toContain(tag);
    }
    expect(result.text).toContain("const x = 1;");
    expect(result.props.some((p) => p.type === "ul" && p.props["class"] === "task-list")).toBe(true);
  });

  it("shows a placeholder for images instead of loading them", () => {
    const result = render("![代替テキスト](./img/a.png)\n");
    expect(result.types).not.toContain("img");
    expect(result.types).toContain("p");
  });
});

describe("MarkdownRenderer decorations", () => {
  it("highlights the anchored text of a comment and keeps the mapping exact", () => {
    const source = `この${marker("表現", "この", "を見直す")}表現を見直す\n`;
    const result = render(source);
    expectExactMapping(source, result);
    const annotated = result.spans.filter((s) => s.cls.includes("anno"));
    expect(annotated.map((s) => s.text).join("")).toBe("表現");
    expect(annotated.every((s) => s.cls.includes("anno-open"))).toBe(true);
    expect(result.spans.filter((s) => !s.cls.includes("anno")).map((s) => s.text).join("")).toBe("このを見直す");
  });

  it("marks resolved and active anchors differently", () => {
    const source = `この${marker("表現", "この", "を見直す", "resolved")}表現を見直す\n`;
    const resolved = render(source);
    expect(resolved.spans.some((s) => s.cls.includes("anno-resolved"))).toBe(true);
    const active = render(source, { activeCommentId: COMMENT_ID });
    expect(active.spans.some((s) => s.cls.includes("anno-active"))).toBe(true);
    expect(
      active.props.some((p) => p.type === "button" && String(p.props["class"]).includes("marker-active")),
    ).toBe(true);
  });

  it("colours fenced code by token without moving a single boundary", () => {
    const source = '```js\nconst x = "a"; // c\n```\n';
    const result = render(source);
    expectExactMapping(source, result);
    expect(result.spans.find((s) => s.cls.includes("tok-keyword"))?.text).toBe("const");
    expect(result.spans.find((s) => s.cls.includes("tok-string"))?.text).toBe('"a"');
    expect(result.spans.find((s) => s.cls.includes("tok-comment"))?.text).toBe("// c");
    expect(result.spans.map((s) => s.text).join("")).toBe('const x = "a"; // c');
    expect(result.props.some((p) => p.type === "span" && p.props["class"] === "code-lang")).toBe(true);
  });

  it("leaves code untouched when highlighting is off or the language is unknown", () => {
    const off = render("```js\nconst x = 1;\n```\n", { highlightCode: false });
    expect(off.spans.every((s) => !s.cls.includes("tok-"))).toBe(true);
    const unknown = render("```whatever\nconst x = 1;\n```\n");
    expect(unknown.spans.every((s) => !s.cls.includes("tok-"))).toBe(true);
  });

  it("renders footnotes as numbered references with a footnote section", () => {
    const source = "本文[^a]と[^b]。\n\n[^b]: 二つ目\n\n[^a]: 一つ目\n";
    const result = render(source);
    expectExactMapping(source, result);
    expect(result.types).toContain("sup");
    expect(result.types).toContain("section");
    expect(result.text).toContain("[1]");
    expect(result.text).toContain("[2]");
    const items = result.props.filter((p) => p.type === "li");
    expect(items.map((p) => p.props["id"])).toEqual(["fn-a", "fn-b"]);
    expect(items.map((p) => p.props["value"])).toEqual([1, 2]);
  });

  it("resolves reference-style links and images", () => {
    const source = '[docs][d] と ![pic][p]\n\n[d]: https://example.com/x "Title"\n[p]: ./img/a.png\n';
    const result = render(source);
    const link = result.props.find((p) => p.type === "a");
    expect(link?.props["href"]).toBe("https://example.com/x");
    expect(link?.props["title"]).toBe("Title");
    expect(result.text).toContain("docs");
  });

  it("gives headings stable ids and hands relative links to the app", () => {
    const source = "# はじめに\n\n## 使い方 (A)\n\n## 使い方 (A)\n\n[次へ](./next.md) [上へ](#はじめに)\n";
    const opened: string[] = [];
    const result = render(source, { onOpenLink: (href) => void opened.push(href) });
    const ids = result.props.filter((p) => p.type === "h1" || p.type === "h2").map((p) => p.props["id"]);
    expect(ids).toEqual(["はじめに", "使い方-a", "使い方-a-1"]);
    const links = result.props.filter((p) => p.type === "a");
    expect(links.map((l) => l.props["class"])).toEqual(["link-file", "link-heading"]);
    const outline = outlineOf(makeContext(source).tm);
    expect(outline.map((o) => [o.depth, o.text, o.id])).toEqual([
      [1, "はじめに", "はじめに"],
      [2, "使い方 (A)", "使い方-a"],
      [2, "使い方 (A)", "使い方-a-1"],
    ]);
    const onClick = links[0]?.props["onClick"] as ((e: { preventDefault: () => void }) => void) | undefined;
    onClick?.({ preventDefault: () => undefined });
    expect(opened).toEqual(["./next.md"]);
  });

  it("keeps the front matter outside the mapped text", () => {
    const source = "---\ntitle: x\n---\n\n本文\n";
    const result = render(source);
    expect(result.spans.map((s) => s.text).join("")).toBe("本文");
  });
});

describe("headingSlug", () => {
  it("follows the GitHub convention", () => {
    expect(headingSlug("Hello World")).toBe("hello-world");
    expect(headingSlug("使い方 (A) / B")).toBe("使い方-a--b");
    expect(headingSlug("  a_b-c  ")).toBe("a_b-c");
  });
});

describe("safeHref", () => {
  it("allows http, https, mailto and relative URLs", () => {
    expect(safeHref("https://example.com")).toEqual({ href: "https://example.com", external: true });
    expect(safeHref("http://example.com")?.external).toBe(true);
    expect(safeHref("mailto:a@example.com")?.external).toBe(true);
    expect(safeHref("./other.md")).toEqual({ href: "./other.md", external: false });
    expect(safeHref("#section")).toEqual({ href: "#section", external: false });
  });

  it("blocks every other scheme", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("//example.com")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});

describe("isRepositoryImage", () => {
  it("accepts relative paths only", () => {
    expect(isRepositoryImage("./img/a.png")).toBe(true);
    expect(isRepositoryImage("/img/a.png")).toBe(true);
    expect(isRepositoryImage("https://example.com/a.png")).toBe(false);
    expect(isRepositoryImage("data:image/png;base64,AAA")).toBe(false);
    expect(isRepositoryImage("//cdn/a.png")).toBe(false);
  });
});

describe("imageMimeType", () => {
  it("maps the image extensions we render", () => {
    expect(imageMimeType("img/a.png")).toBe("image/png");
    expect(imageMimeType("img/a.PNG")).toBe("image/png");
    expect(imageMimeType("img/a.jpg")).toBe("image/jpeg");
    expect(imageMimeType("img/a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("img/a.gif")).toBe("image/gif");
    expect(imageMimeType("img/a.webp")).toBe("image/webp");
    expect(imageMimeType("img/a.svg")).toBe("image/svg+xml");
    expect(imageMimeType("img/a.avif")).toBe("image/avif");
    expect(imageMimeType("img/a.bmp")).toBe("image/bmp");
  });

  it("returns null for anything else", () => {
    expect(imageMimeType("docs/a.md")).toBeNull();
    expect(imageMimeType("noextension")).toBeNull();
    expect(imageMimeType("archive.png.zip")).toBeNull();
  });
});
