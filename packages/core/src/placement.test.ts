import { describe, expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { buildTextMap, mdastDisplayText } from "./textmap.js";
import { computePlacement, findAnchor, insertMarker, prepareSelection } from "./placement.js";

const M = '<!-- @comment{"schemaVersion":1,"id":"t"} -->';

/** Structure of a Markdown document, ignoring akaire markers and positions. */
function shape(src: string): string {
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const walk = (n: any): string => {
    if (n.type === "html" && n.value.startsWith("<!-- @comment")) return "";
    // Drop markers, then merge text nodes that were split by a marker.
    const merged: any[] = [];
    for (const c of n.children ?? []) {
      if (c.type === "html" && c.value.startsWith("<!-- @comment")) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.type === "text" && c.type === "text") prev.value += c.value;
      else merged.push({ ...c });
    }
    const kids = merged.map(walk).filter((s: string) => s !== "");
    const extra =
      n.type === "list" ? `(ordered=${n.ordered},spread=${n.spread},start=${n.start})` : n.type === "listItem" ? `(checked=${n.checked})` : "";
    const val = "value" in n && n.type !== "html" ? `=${JSON.stringify(n.value)}` : "";
    return `${n.type}${extra}${val}${kids.length ? "[" + kids.join(",") + "]" : ""}`;
  };
  return walk(tree);
}

function place(src: string, at: string | number, occurrence = 0): { out: string; placement: string } {
  const tm = buildTextMap(src);
  let offset: number;
  if (typeof at === "number") offset = at;
  else {
    let k = -1;
    for (let i = 0; i <= occurrence; i++) k = src.indexOf(at, k + 1);
    offset = k;
  }
  const r = prepareSelection(tm, { start: offset, end: offset + 1 });
  if (!r.ok) throw new Error(r.reason);
  const out = insertMarker(src, r.placement, M);
  return { out, placement: r.placement.placement };
}

/** Insertion must keep the document structure and the display text identical. */
function expectNonBreaking(src: string, at: string | number, occurrence = 0): { out: string; placement: string } {
  const r = place(src, at, occurrence);
  expect(shape(r.out), r.out).toBe(shape(src));
  const before = buildTextMap(src).blocks.map((b) => b.displayText);
  const after = buildTextMap(r.out).blocks.map((b) => b.displayText);
  expect(after).toEqual(before);
  return r;
}

describe("computePlacement / insertMarker", () => {
  it("inserts inline before the selection in a paragraph", () => {
    const r = expectNonBreaking("本文の この表現を見直す。", "この");
    expect(r.placement).toBe("inline");
    expect(r.out).toBe(`本文の ${M}この表現を見直す。`);
  });

  it("moves before the opening delimiter when the selection starts inside emphasis", () => {
    const r = expectNonBreaking("これは**重要**です", "重");
    expect(r.out).toBe(`これは${M}**重要**です`);
    const r2 = expectNonBreaking("a ***x*** b", "x");
    expect(r2.out).toBe(`a ${M}***x*** b`);
    const r3 = expectNonBreaking("見よ[リンク](u)を", "リ");
    expect(r3.out).toBe(`見よ${M}[リンク](u)を`);
    const r4 = expectNonBreaking("見よ **[リンク](u)** を", "リ");
    expect(r4.out).toBe(`見よ ${M}**[リンク](u)** を`);
  });

  it("stays inline in the middle of emphasis", () => {
    const r = expectNonBreaking("これは**重要な点**です", "な");
    expect(r.out).toBe(`これは**重要${M}な点**です`);
    expect(r.placement).toBe("inline");
  });

  it("places before the block when the selection is at line start", () => {
    const r = expectNonBreaking("段落一\n\n段落二です", "段落二");
    expect(r.placement).toBe("block");
    expect(r.out).toBe(`段落一\n\n${M}\n段落二です`);
    const c = expectNonBreaking("一行目\n二行目", "二");
    expect(c.out).toBe(`${M}\n一行目\n二行目`);
  });

  it("keeps CRLF line endings for block placement", () => {
    const r = expectNonBreaking("一\r\n\r\n二です", "二");
    expect(r.out).toBe(`一\r\n\r\n${M}\r\n二です`);
  });

  it("inherits list and blockquote prefixes", () => {
    const list = expectNonBreaking("- item1\n- item2\n- item3", "item2");
    expect(list.out).toBe(`- item1\n- ${M}\n  item2\n- item3`);
    const ordered = expectNonBreaking("1. one\n2. two\n3. three", "two");
    expect(ordered.out).toBe(`1. one\n2. ${M}\n   two\n3. three`);
    const bq = expectNonBreaking("> quoted\n> more\n\nafter", "quoted");
    expect(bq.out).toBe(`> ${M}\n> quoted\n> more\n\nafter`);
    const nested = expectNonBreaking("> - a\n>   b\n> - c", "c");
    expect(nested.out).toBe(`> - a\n>   b\n> - ${M}\n>   c`);
    const second = expectNonBreaking("- a\n\n  second para\n- b", "second");
    expect(second.out).toBe(`- a\n\n  ${M}\n  second para\n- b`);
  });

  it("handles task list items", () => {
    const r = expectNonBreaking("- [ ] todo\n- [x] done", "done");
    expect(r.out).toBe(`- [ ] todo\n- [x] ${M}done`);
    const inline = expectNonBreaking("- [ ] todo item", "item");
    expect(inline.out).toBe(`- [ ] todo ${M}item`);
  });

  it("uses block placement for headings, tables and code", () => {
    const h = expectNonBreaking("# 見出し\n\n本文", "見出");
    expect(h.out).toBe(`${M}\n# 見出し\n\n本文`);
    const setext = expectNonBreaking("見出し\n===\n\n本文", "見出");
    expect(setext.out).toBe(`${M}\n見出し\n===\n\n本文`);
    const table = expectNonBreaking("前\n\n| a | b |\n|---|---|\n| c | d |", "d");
    expect(table.out).toBe(`前\n\n${M}\n| a | b |\n|---|---|\n| c | d |`);
    const code = expectNonBreaking("前\n\n```js\nlet x\n```", "let");
    expect(code.out).toBe(`前\n\n${M}\n\`\`\`js\nlet x\n\`\`\``);
    const listCode = expectNonBreaking("- item\n\n  ```\n  code\n  ```", "code");
    expect(listCode.out).toBe(`- item\n\n  ${M}\n  \`\`\`\n  code\n  \`\`\``);
  });

  it("falls back to block placement inside inline code, autolinks and raw html", () => {
    const code = expectNonBreaking("call `foo()` now", "oo");
    expect(code.placement).toBe("block");
    const codeStart = expectNonBreaking("call `foo()` now", "foo");
    expect(codeStart.placement).toBe("inline");
    expect(codeStart.out).toBe(`call ${M}\`foo()\` now`);
    const auto = expectNonBreaking("see https://example.com/x now", "example");
    expect(auto.placement).toBe("block");
    const html = expectNonBreaking("a <span>b</span> c", "span");
    expect(html.placement).toBe("block");
  });

  it("keeps escapes and entities intact when inserting before them", () => {
    const esc = expectNonBreaking("価格は\\*印付き", "*");
    expect(esc.out).toBe(`価格は${M}\\*印付き`);
    const ent = expectNonBreaking("A &amp; B", "&");
    expect(ent.out).toBe(`A ${M}&amp; B`);
  });

  it("does not add whitespace around an inline marker", () => {
    const r = expectNonBreaking("日本語の文章です", "文章");
    expect(r.out).toBe(`日本語の${M}文章です`);
  });

  it("works with BOM and front matter", () => {
    const src = "﻿---\ntitle: t\n---\n\n本文の文章";
    const r = expectNonBreaking(src, "文章");
    expect(r.out).toBe(`﻿---\ntitle: t\n---\n\n本文の${M}文章`);
    const tm = buildTextMap(src);
    expect(prepareSelection(tm, { start: 5, end: 7 })).toEqual({ ok: false, reason: "front-matter" });
  });
});

describe("prepareSelection", () => {
  it("computes anchor, prefix and suffix from display text without markers", () => {
    const src = `本文の <!-- @comment{"schemaVersion":1,"id":"a"} -->この表現を見直す。`;
    const tm = buildTextMap(src);
    const s = src.indexOf("表現");
    const r = prepareSelection(tm, { start: s, end: s + 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchor).toBe("表現");
    expect(r.prefix).toBe("本文の この");
    expect(r.suffix).toBe("を見直す。");
    expect(r.sourceOffset).toBe(s);
  });

  it("limits context to 32 code points and accepts reversed selections", () => {
    const long = "あ".repeat(40) + "対象" + "😀".repeat(40);
    const tm = buildTextMap(long);
    const s = long.indexOf("対象");
    const r = prepareSelection(tm, { start: s + 2, end: s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchor).toBe("対象");
    expect(Array.from(r.prefix)).toHaveLength(32);
    expect(Array.from(r.suffix)).toHaveLength(32);
    expect(r.suffix).toBe("😀".repeat(32));
  });

  it("rejects multi-block and empty selections", () => {
    const src = "一つ目\n\n二つ目";
    const tm = buildTextMap(src);
    expect(prepareSelection(tm, { start: 0, end: 7 })).toEqual({ ok: false, reason: "multi-block" });
    expect(prepareSelection(tm, { start: 1, end: 1 })).toEqual({ ok: false, reason: "empty-selection" });
    expect(prepareSelection(tm, { start: 4, end: 4 })).toEqual({ ok: false, reason: "no-block" });
  });

  it("allows an entire table cell and reports blockOnly", () => {
    const src = "| a | b |\n|---|---|\n| セル | d |";
    const tm = buildTextMap(src);
    const s = src.indexOf("セル");
    const r = prepareSelection(tm, { start: s, end: s + 2 });
    expect(r.ok && r.blockOnly).toBe(true);
    expect(r.ok && r.placement.flowType).toBe("table");
  });
});

describe("findAnchor", () => {
  it("finds unique and multiple matches", () => {
    const src = "前置き 対象 後ろ\n\n別の段落 対象 後ろ";
    const tm = buildTextMap(src);
    expect(findAnchor(tm, "前置き ", "対象", " 後ろ")).toHaveLength(1);
    expect(findAnchor(tm, " ", "対象", " 後ろ")).toHaveLength(2);
    expect(findAnchor(tm, "x", "対象", "")).toHaveLength(0);
    const m = findAnchor(tm, "別の段落 ", "対象", "")[0]!;
    expect(m.sourceOffset).toBe(src.lastIndexOf("対象"));
  });

  it("matches across marker-stripped text", () => {
    const src = `本文の ${M}この表現を見直す。`;
    const tm = buildTextMap(src);
    const m = findAnchor(tm, "本文の ", "この表現", "を見直す。");
    expect(m).toHaveLength(1);
    expect(m[0]!.sourceOffset).toBe(src.indexOf("この表現"));
  });
});
