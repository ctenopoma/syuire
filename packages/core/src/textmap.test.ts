import { describe, expect, it } from "vitest";
import {
  blockAt,
  buildTextMap,
  displayIndexAt,
  mdastDisplayText,
  runsInRange,
  sourceOffsetAt,
} from "./textmap.js";

/** Every leaf block's display text must equal what mdast would render as text. */
function expectConsistent(source: string): ReturnType<typeof buildTextMap> {
  const tm = buildTextMap(source);
  for (const b of tm.blocks) {
    expect(b.displayText, `block ${b.type} @${b.range.start}`).toBe(mdastDisplayText(b.node));
    // Units are monotonic in source and each linear unit maps to the identical source char.
    let prev = -1;
    for (const u of b.units) {
      expect(u.src).toBeGreaterThanOrEqual(prev);
      prev = u.src;
      if (!u.atomic) expect(source[u.src]).toBe(u.ch);
    }
  }
  return tm;
}

describe("buildTextMap", () => {
  it("maps plain paragraphs 1:1", () => {
    const tm = expectConsistent("これは本文です。\n\n二つ目の段落。");
    expect(tm.blocks).toHaveLength(2);
    const b = tm.blocks[0]!;
    expect(b.displayText).toBe("これは本文です。");
    expect(b.runs).toHaveLength(1);
    expect(sourceOffsetAt(b, 3)).toBe(3);
    expect(displayIndexAt(b, 3)).toBe(3);
  });

  it("handles escapes, entities, soft and hard breaks", () => {
    const src = "foo &amp; \\*bar*  \nbaz\nqux `a\nb` end";
    const tm = expectConsistent(src);
    const b = tm.blocks[0]!;
    expect(b.displayText).toBe("foo & *bar*\nbaz\nqux a\nb end");
    // '&' comes from &amp; at offset 4..9
    const amp = b.units[4]!;
    expect(amp.ch).toBe("&");
    expect(amp.src).toBe(4);
    expect(amp.end).toBe(9);
    expect(amp.atomic).toBe(true);
    // '*' from "\*" maps to the backslash offset
    const star = b.units[6]!;
    expect(star.ch).toBe("*");
    expect(star.src).toBe(10);
    expect(star.end).toBe(12);
    // hard break "  \n" -> one "\n" unit spanning [16,19)
    const hb = b.units[11]!;
    expect(hb.ch).toBe("\n");
    expect(hb.kind).toBe("hardbreak");
    expect(hb.src).toBe(16);
    expect(hb.end).toBe(19);
    // soft break
    const sb = b.units[15]!;
    expect(sb.ch).toBe("\n");
    expect(sb.kind).toBe("softbreak");
    // inline code units are kind "code"
    expect(b.units[20]!.kind).toBe("code");
  });

  it("maps emphasis, strong, strikethrough and links (text only)", () => {
    const src = "a **太字** と *強調* と ~~取消~~ と [リンク](https://x.y \"t\") と ![img](p.png) end";
    const tm = expectConsistent(src);
    const b = tm.blocks[0]!;
    expect(b.displayText).toBe("a 太字 と 強調 と 取消 と リンク と  end");
    const idx = b.displayText.indexOf("太");
    expect(sourceOffsetAt(b, idx)).toBe(src.indexOf("太"));
    const l = b.displayText.indexOf("リ");
    expect(sourceOffsetAt(b, l)).toBe(src.indexOf("リ"));
  });

  it("does not include numeric/hex references raw", () => {
    const tm = expectConsistent("x &#x1F600; y &#65; z &bogus; w");
    expect(tm.blocks[0]!.displayText).toBe("x 😀 y A z &bogus; w");
    const smile = tm.blocks[0]!.units[2]!;
    expect(smile.atomic).toBe(true);
    expect(tm.blocks[0]!.units[3]!.src).toBe(smile.src);
  });

  it("maps headings, code blocks, html blocks and tables", () => {
    const src = [
      "# 見出し &amp; x",
      "",
      "Setext",
      "続き",
      "===",
      "",
      "```js",
      "line1",
      "",
      "line3",
      "```",
      "",
      "    indented",
      "",
      "<div>",
      " raw",
      "</div>",
      "",
      "| a | b |",
      "|---|---|",
      "| c &amp; | **d** |",
    ].join("\n");
    const tm = expectConsistent(src);
    const types = tm.blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "heading",
      "code",
      "code",
      "html",
      "tableCell",
      "tableCell",
      "tableCell",
      "tableCell",
    ]);
    expect(tm.blocks[0]!.displayText).toBe("見出し & x");
    expect(tm.blocks[1]!.displayText).toBe("Setext\n続き");
    expect(tm.blocks[2]!.displayText).toBe("line1\n\nline3");
    expect(tm.blocks[3]!.displayText).toBe("indented");
    expect(tm.blocks[4]!.displayText).toBe("<div>\n raw\n</div>");
    expect(tm.blocks[7]!.displayText).toBe("c &");
    expect(tm.blocks[8]!.displayText).toBe("d");
    for (const cell of tm.blocks.slice(5)) expect(cell.flowType).toBe("table");
  });

  it("handles lists, blockquotes and task items", () => {
    const src = "> - item\n>   cont\n\n- [ ] todo\n- [x] done\n\n1. one";
    const tm = expectConsistent(src);
    expect(tm.blocks.map((b) => b.displayText)).toEqual(["item\ncont", "todo", "done", "one"]);
    const todo = tm.blocks[1]!;
    expect(sourceOffsetAt(todo, 0)).toBe(src.indexOf("todo"));
  });

  it("excludes syuire markers from display text but keeps other html", () => {
    const src =
      'foo <!-- @comment{"schemaVersion":1,"id":"x"} -->bar <!-- note --> baz\n\n<!-- @comment{"schemaVersion":1,"id":"y"} -->\npara';
    const tm = expectConsistent(src);
    expect(tm.blocks[0]!.displayText).toBe("foo bar <!-- note --> baz");
    // Second block: the block-level marker is not a leaf; only the paragraph.
    expect(tm.blocks).toHaveLength(2);
    expect(tm.blocks[1]!.displayText).toBe("para");
    expect(tm.blocks[1]!.range.start).toBe(src.indexOf("para"));
  });

  it("keeps offsets correct with CRLF, BOM and front matter", () => {
    const src = "﻿---\r\ntitle: x\r\n---\r\n\r\n段落 &amp; 一\r\n二\r\n";
    const tm = expectConsistent(src);
    expect(tm.lineEnding).toBe("\r\n");
    expect(tm.frontMatter).toEqual({ start: 1, end: src.indexOf("\r\n\r\n") + 2 });
    expect(tm.blocks).toHaveLength(1);
    const b = tm.blocks[0]!;
    expect(b.displayText).toBe("段落 & 一\n二");
    expect(sourceOffsetAt(b, 0)).toBe(src.indexOf("段落"));
    const nl = b.units[b.displayText.indexOf("\n")]!;
    expect(nl.src).toBe(src.indexOf("一") + 1);
    expect(nl.end).toBe(nl.src + 2);
  });

  it("autolinks are kind autolink", () => {
    const tm = expectConsistent("see https://example.com and <https://x.y> ok");
    const b = tm.blocks[0]!;
    expect(b.displayText).toBe("see https://example.com and https://x.y ok");
    expect(b.units[4]!.kind).toBe("autolink");
    expect(b.units[b.displayText.indexOf("x.y")]!.kind).toBe("autolink");
  });

  it("blockAt and runsInRange", () => {
    const src = "one\n\ntwo **b** three";
    const tm = buildTextMap(src);
    expect(blockAt(tm, 0)!.displayText).toBe("one");
    expect(blockAt(tm, 3)).toBeUndefined();
    expect(blockAt(tm, 3, true)!.displayText).toBe("one");
    expect(blockAt(tm, 6)!.displayText).toBe("two b three");
    const runs = runsInRange(tm, 5, 14);
    expect(runs.map((r) => r.run.sourceStart)).toEqual([5, 11]);
    expect(runs.every((r) => r.block === tm.blocks[1])).toBe(true);
  });

  it("footnotes and definitions contribute no stray text", () => {
    const tm = expectConsistent("text[^1] and [ref][r]\n\n[^1]: note\n\n[r]: https://x.y");
    expect(tm.blocks.map((b) => b.displayText)).toEqual(["text and ref", "note"]);
  });
});
