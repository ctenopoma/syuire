import { describe, expect, it } from "vitest";
import { buildTextMap, markerStatuses, parseDocument } from "@syuire/core";
import type { VNode } from "preact";
import {
  MarkdownRenderer,
  imageMimeType,
  isRepositoryImage,
  safeHref,
  type RendererContext,
} from "./MarkdownRenderer";

function makeContext(source: string): RendererContext {
  const tm = buildTextMap(source);
  const numbers = new Map<number, number>();
  const ids = new Map<number, string>();
  const gutter = new Map<number, number[]>();
  const changed = new Set<string>();
  markerStatuses(source).forEach((status, index) => {
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
    onMarkerClick: () => undefined,
    loadImage: async () => "blob:none",
  };
}

interface Walked {
  spans: Array<{ start: number; end: number; atomic: boolean; text: string }>;
  types: string[];
  text: string;
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
  const rawStart = props["data-s"];
  if (typeof rawStart === "string") {
    const childText: Walked = { spans: [], types: [], text: "" };
    walk(props["children"], childText);
    out.spans.push({
      start: Number(rawStart),
      end: Number(props["data-e"]),
      atomic: props["data-atomic"] === "1",
      text: childText.text,
    });
  }
  walk(props["children"], out);
}

function render(source: string): Walked {
  const out: Walked = { spans: [], types: [], text: "" };
  walk(MarkdownRenderer({ ctx: makeContext(source) }), out);
  return out;
}

describe("MarkdownRenderer", () => {
  it("emits one span per run and never uses the node value", () => {
    const source = "本文の**強調**と`code`と&amp;と\\*escape\\*。\n";
    const result = render(source);
    expect(result.types).toContain("p");
    expect(result.types).toContain("strong");
    expect(result.types).toContain("code");

    // Every span maps back to the source it came from.
    for (const span of result.spans) {
      expect(span.end).toBeGreaterThanOrEqual(span.start);
      if (!span.atomic) {
        expect(source.slice(span.start, span.end)).toBe(span.text);
      }
    }

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
    const marker =
      '<!-- @comment{"schemaVersion":1,"id":"11111111-2222-3333-4444-555555555555","anchor":"表現","prefix":"この","suffix":"を見直す","text":"具体例を","author":"naoki","timestamp":"2026-09-07T09:12:00+09:00","state":"open","replies":[]} -->';
    const source = `この${marker}表現を見直す\n`;
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
      "- 二つ目",
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
    for (const tag of ["h1", "blockquote", "ul", "li", "table", "th", "td", "pre", "hr"]) {
      expect(result.types).toContain(tag);
    }
    expect(result.text).toContain("const x = 1;");
  });

  it("shows a placeholder for images instead of loading them", () => {
    const result = render("![代替テキスト](./img/a.png)\n");
    expect(result.types).not.toContain("img");
    expect(result.types).toContain("p");
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
