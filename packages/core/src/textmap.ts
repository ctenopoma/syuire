/**
 * Display text <-> source offset mapping (DESIGN.md section 6).
 *
 * The map is built from micromark's token events, not from mdast node
 * positions, so that backslash escapes, character references, soft/hard
 * breaks and container prefixes are mapped character by character.
 * mdast is used only for block structure.
 */
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import type { Event, Token } from "micromark-util-types";
import type { Root, Nodes, Parent, RootContent } from "mdast";
import { MARKER_PREFIX, type SourceRange } from "./types.js";

export type UnitKind =
  | "text"
  | "softbreak"
  | "hardbreak"
  | "code"
  | "codeblock"
  | "html"
  | "autolink";

/** One UTF-16 code unit of display text and where it came from. */
export interface TextUnit {
  ch: string;
  /** Source offset where this unit starts. */
  src: number;
  /** Source offset just after the source construct that produced this unit. */
  end: number;
  kind: UnitKind;
  /** True when several units share the same source construct (entity, line ending, ...). */
  atomic: boolean;
}

/** A maximal run of display text whose mapping to source is contiguous. */
export interface TextRun {
  kind: UnitKind;
  displayStart: number;
  displayEnd: number;
  sourceStart: number;
  sourceEnd: number;
  /** Atomic runs map every display unit to sourceStart (e.g. `&amp;` -> `&`). */
  atomic: boolean;
}

export type LeafType = "paragraph" | "heading" | "tableCell" | "code" | "html";

export interface LeafBlock {
  type: LeafType;
  /** Source range of the leaf node itself. */
  range: SourceRange;
  /** Type of the flow-level block a block marker would be placed before. */
  flowType: string;
  /** Source range of that flow-level block (table for cells, otherwise the leaf). */
  flowRange: SourceRange;
  /** Index into TextMap.blocks of the first leaf of the same flow block. */
  displayText: string;
  units: TextUnit[];
  runs: TextRun[];
  /** mdast node for structural queries. */
  node: Nodes;
  /** Ancestor chain from root (exclusive) to the leaf (exclusive). */
  ancestors: Parent[];
}

export interface TextMap {
  source: string;
  /** Offset where Markdown parsing starts (after BOM and front matter). */
  bodyStart: number;
  frontMatter: SourceRange | null;
  lineEnding: "\n" | "\r\n";
  root: Root;
  blocks: LeafBlock[];
}

const SKIP_TOKENS = new Set([
  "resource",
  "reference",
  "definition",
  "image",
  "codeFencedFence",
  "gfmFootnoteCall",
  "gfmFootnoteDefinitionLabel",
  "gfmFootnoteDefinitionLabelString",
  "gfmFootnoteDefinitionMarker",
  "tableDelimiterRow",
  "taskListCheck",
  "labelImage",
  "labelImageMarker",
]);

export function detectLineEnding(source: string): "\n" | "\r\n" {
  const i = source.indexOf("\n");
  if (i > 0 && source[i - 1] === "\r") return "\r\n";
  return "\n";
}

/** Detect a YAML front matter block at the start of the body. */
export function detectFrontMatter(source: string, start: number): SourceRange | null {
  const rest = source.slice(start);
  const m = /^---[ \t]*\r?\n/.exec(rest);
  if (!m) return null;
  const closeRe = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const after = rest.slice(m[0].length);
  const c = closeRe.exec(after);
  if (!c) return null;
  const end = start + m[0].length + c.index + c[0].length;
  return { start, end };
}

function parseEvents(body: string): Event[] {
  const tokenizer = parse({ extensions: [gfm()] }).document();
  return postprocess(tokenizer.write(preprocess()(body, undefined, true)));
}

interface Piece {
  token: Token;
  isLineEnding: boolean;
}

/** Build the ordered list of display units for the whole body. */
function buildUnits(source: string, body: string, shift: number): TextUnit[] {
  const events = parseEvents(body);
  const units: TextUnit[] = [];
  const stack: string[] = [];
  let skipDepth = 0;
  let inCodeText = 0;
  let inHtmlFlow = 0;
  let inHtmlText = 0;
  let inCodeFenced = 0;
  let inCodeIndented = 0;
  let skipHtml = false;
  let atHardBreak = false;
  let codePieces: Piece[] | null = null;
  let refStart = -1;
  let refType: "named" | "decimal" | "hex" = "named";
  let autolinkStart = -1;
  let unitsAtAutolinkStart = 0;

  const slice = (t: Token): string => body.slice(t.start.offset, t.end.offset);
  const pushLinear = (t: Token, kind: UnitKind): void => {
    const s = slice(t);
    for (let i = 0; i < s.length; i++) {
      const off = shift + t.start.offset + i;
      units.push({ ch: s[i] as string, src: off, end: off + 1, kind, atomic: false });
    }
  };
  const pushAtomic = (text: string, start: number, end: number, kind: UnitKind): void => {
    for (let i = 0; i < text.length; i++) {
      units.push({ ch: text[i] as string, src: shift + start, end: shift + end, kind, atomic: true });
    }
  };
  const inTextContext = (): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const t = stack[i] as string;
      if (
        t === "paragraph" ||
        t === "atxHeadingText" ||
        t === "setextHeadingText" ||
        t === "tableContent" ||
        t === "emphasis" ||
        t === "strong" ||
        t === "strikethrough" ||
        t === "labelText" ||
        t === "label" ||
        t === "link"
      ) {
        return true;
      }
    }
    return false;
  };

  const flushCodePieces = (kind: UnitKind, fenced: boolean): void => {
    if (!codePieces) return;
    let pieces = codePieces;
    if (fenced) {
      // Drop the line ending right after the opening fence and the one right before the closing fence.
      if (pieces.length > 0 && pieces[0]!.isLineEnding) pieces = pieces.slice(1);
      if (pieces.length > 0 && pieces[pieces.length - 1]!.isLineEnding) pieces = pieces.slice(0, -1);
    }
    for (const p of pieces) {
      if (p.isLineEnding) pushAtomic("\n", p.token.start.offset, p.token.end.offset, kind);
      else pushLinear(p.token, kind);
    }
    codePieces = null;
  };

  for (const [kind, token] of events) {
    const type = token.type as string;
    if (kind === "enter") {
      stack.push(type);
      if (SKIP_TOKENS.has(type)) skipDepth++;
      else if (type === "codeText") inCodeText++;
      else if (type === "htmlFlow") {
        inHtmlFlow++;
        skipHtml = slice(token).startsWith(MARKER_PREFIX);
      } else if (type === "htmlText") {
        inHtmlText++;
        skipHtml = slice(token).startsWith(MARKER_PREFIX);
      } else if (type === "codeFenced") {
        inCodeFenced++;
        codePieces = [];
      } else if (type === "codeIndented") {
        inCodeIndented++;
        codePieces = [];
      } else if (type === "characterReference") {
        refStart = token.start.offset;
        refType = "named";
      } else if (type === "literalAutolink") {
        autolinkStart = token.start.offset;
        unitsAtAutolinkStart = units.length;
      }
      continue;
    }

    // exit
    stack.pop();
    if (SKIP_TOKENS.has(type)) {
      skipDepth--;
      continue;
    }
    if (skipDepth > 0) {
      if (type === "codeText") inCodeText--;
      continue;
    }

    switch (type) {
      case "codeFenced":
        inCodeFenced--;
        flushCodePieces("codeblock", true);
        break;
      case "codeIndented":
        inCodeIndented--;
        flushCodePieces("codeblock", false);
        break;
      case "codeFlowValue":
        if (codePieces) codePieces.push({ token, isLineEnding: false });
        break;
      case "htmlFlow":
        inHtmlFlow--;
        skipHtml = false;
        break;
      case "htmlText":
        inHtmlText--;
        skipHtml = false;
        break;
      case "htmlFlowData":
      case "htmlTextData":
        if (!skipHtml) pushLinear(token, "html");
        break;
      case "codeText":
        inCodeText--;
        break;
      case "codeTextData":
        pushLinear(token, "code");
        break;
      case "data":
        if (inCodeText > 0) pushLinear(token, "code");
        else if (autolinkStart >= 0) pushLinear(token, "autolink");
        else if (inTextContext()) pushLinear(token, "text");
        break;
      case "characterEscapeValue":
        if (inTextContext()) {
          pushAtomic(slice(token), token.start.offset - 1, token.end.offset, "text");
        }
        break;
      case "characterReferenceMarkerNumeric":
        refType = "decimal";
        break;
      case "characterReferenceMarkerHexadecimal":
        refType = "hex";
        break;
      case "characterReferenceValue": {
        if (!inTextContext()) break;
        const raw = slice(token);
        const decoded =
          refType === "named"
            ? decodeNamedCharacterReference(raw)
            : decodeNumericCharacterReference(raw, refType === "hex" ? 16 : 10);
        // `characterReference` covers `&...;` so the atomic range is [refStart, value.end + 1).
        pushAtomic(decoded === false ? `&${raw};` : decoded, refStart, token.end.offset + 1, "text");
        break;
      }
      case "hardBreakTrailing":
      case "hardBreakEscape":
        atHardBreak = true;
        // The following lineEnding completes the break; emit on it.
        units.push({
          ch: "\n",
          src: shift + token.start.offset,
          end: shift + token.end.offset,
          kind: "hardbreak",
          atomic: true,
        });
        break;
      case "lineEnding": {
        if (atHardBreak) {
          atHardBreak = false;
          const last = units[units.length - 1];
          if (last && last.kind === "hardbreak") last.end = shift + token.end.offset;
          break;
        }
        if (codePieces && (inCodeFenced > 0 || inCodeIndented > 0)) {
          codePieces.push({ token, isLineEnding: true });
        } else if (inCodeText > 0) {
          pushAtomic("\n", token.start.offset, token.end.offset, "code");
        } else if (inHtmlFlow > 0 || inHtmlText > 0) {
          if (!skipHtml) pushAtomic("\n", token.start.offset, token.end.offset, "html");
        } else if (inTextContext()) {
          pushAtomic("\n", token.start.offset, token.end.offset, "softbreak");
        }
        break;
      }
      case "autolinkProtocol":
      case "autolinkEmail":
        pushLinear(token, "autolink");
        break;
      case "literalAutolink":
        if (units.length === unitsAtAutolinkStart) pushLinear(token, "autolink");
        autolinkStart = -1;
        break;
      default:
        break;
    }
  }
  return units;
}

function buildRuns(units: TextUnit[]): TextRun[] {
  const runs: TextRun[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i]!;
    if (u.atomic) {
      let j = i + 1;
      while (j < units.length && units[j]!.atomic && units[j]!.src === u.src && units[j]!.end === u.end) j++;
      runs.push({
        kind: u.kind,
        displayStart: i,
        displayEnd: j,
        sourceStart: u.src,
        sourceEnd: u.end,
        atomic: true,
      });
      i = j;
      continue;
    }
    let j = i + 1;
    while (
      j < units.length &&
      !units[j]!.atomic &&
      units[j]!.kind === u.kind &&
      units[j]!.src === units[j - 1]!.src + 1
    ) {
      j++;
    }
    runs.push({
      kind: u.kind,
      displayStart: i,
      displayEnd: j,
      sourceStart: u.src,
      sourceEnd: units[j - 1]!.end,
      atomic: false,
    });
    i = j;
  }
  return runs;
}

function isMarkerHtml(node: Nodes): boolean {
  return node.type === "html" && node.value.startsWith(MARKER_PREFIX);
}

function collectLeaves(root: Root, shift: number, units: TextUnit[], source: string): LeafBlock[] {
  const leaves: LeafBlock[] = [];
  let cursor = 0;
  const sourceOf = (_units: TextUnit[], range: SourceRange): string => source.slice(range.start, range.end);
  const visit = (node: Nodes, ancestors: Parent[]): void => {
    const pos = node.position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) return;
    let leafType: LeafType | null = null;
    if (node.type === "paragraph") leafType = "paragraph";
    else if (node.type === "heading") leafType = "heading";
    else if (node.type === "tableCell") leafType = "tableCell";
    else if (node.type === "code") leafType = "code";
    else if (node.type === "html" && !isMarkerHtml(node)) leafType = "html";

    if (leafType) {
      const range = { start: pos.start.offset + shift, end: pos.end.offset + shift };
      // A task list paragraph may start at the checkbox; skip `[x] ` so the display text is stable.
      const parent = ancestors[ancestors.length - 1] as Nodes | undefined;
      if (leafType === "paragraph" && parent && parent.type === "listItem" && parent.checked != null) {
        const m = /^\[[ xX]\][ \t]*/.exec(units.length ? sourceOf(units, range) : "");
        if (m) range.start += m[0].length;
      }
      // Units are ordered by source offset; advance the cursor to the range.
      while (cursor < units.length && units[cursor]!.src < range.start) cursor++;
      const startIdx = cursor;
      while (cursor < units.length && units[cursor]!.src < range.end) cursor++;
      const blockUnits = units.slice(startIdx, cursor);
      let flowNode: Nodes = node;
      const flowAncestors = ancestors;
      if (leafType === "tableCell") {
        const table = ancestors[ancestors.length - 2] as Nodes | undefined;
        if (table && table.type === "table") flowNode = table;
      }
      const fpos = flowNode.position!;
      leaves.push({
        type: leafType,
        range,
        flowType: flowNode.type,
        flowRange: { start: fpos.start.offset! + shift, end: fpos.end.offset! + shift },
        displayText: blockUnits.map((u) => u.ch).join(""),
        units: blockUnits,
        runs: buildRuns(blockUnits),
        node,
        ancestors: flowAncestors,
      });
      if (leafType !== "tableCell") return;
    }
    if ("children" in node) {
      for (const child of (node as Parent).children as RootContent[]) {
        visit(child, [...ancestors, node as unknown as Parent]);
      }
    }
  };
  for (const child of root.children) visit(child, [root]);
  return leaves;
}

export function buildTextMap(source: string): TextMap {
  const hasBom = source.charCodeAt(0) === 0xfeff;
  let bodyStart = hasBom ? 1 : 0;
  const frontMatter = detectFrontMatter(source, bodyStart);
  if (frontMatter) bodyStart = frontMatter.end;
  const body = source.slice(bodyStart);
  const root = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const units = buildUnits(source, body, bodyStart);
  const blocks = collectLeaves(root, bodyStart, units, source);
  return {
    source,
    bodyStart,
    frontMatter,
    lineEnding: detectLineEnding(source),
    root,
    blocks,
  };
}

/** Leaf block containing the source offset. `offset === range.end` matches when `inclusiveEnd`. */
export function blockAt(tm: TextMap, offset: number, inclusiveEnd = false): LeafBlock | undefined {
  for (const b of tm.blocks) {
    if (offset >= b.range.start && (offset < b.range.end || (inclusiveEnd && offset === b.range.end))) {
      return b;
    }
  }
  return undefined;
}

/** Display index (in code units) of the first unit that starts at or after the offset. */
export function displayIndexAt(block: LeafBlock, offset: number): number {
  const units = block.units;
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Display index just after the last unit that starts before the offset (for selection ends). */
export function displayIndexEnd(block: LeafBlock, offset: number): number {
  const units = block.units;
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.src < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Source offset of the display unit at index (or the end of the last unit). */
export function sourceOffsetAt(block: LeafBlock, displayIndex: number): number {
  const units = block.units;
  if (displayIndex < units.length) return units[displayIndex]!.src;
  const last = units[units.length - 1];
  return last ? last.end : block.range.start;
}

/** Runs of any block overlapping the source range, in document order. */
export function runsInRange(tm: TextMap, start: number, end: number): Array<{ block: LeafBlock; run: TextRun }> {
  const out: Array<{ block: LeafBlock; run: TextRun }> = [];
  for (const block of tm.blocks) {
    if (block.range.end <= start || block.range.start >= end) continue;
    for (const run of block.runs) {
      if (run.sourceEnd <= start || run.sourceStart >= end) continue;
      out.push({ block, run });
    }
  }
  return out;
}

/** Take up to `max` code points from the end of `s`. */
export function tailCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.slice(Math.max(0, cps.length - max)).join("");
}

/** Take up to `max` code points from the start of `s`. */
export function headCodePoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

/**
 * Plain-text extraction from an mdast node, matching the display text rules.
 * Line endings inside values are normalised to "\n" like the text map does.
 */
export function mdastDisplayText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value.replace(/\r\n?/g, "\n");
    case "html":
      return isMarkerHtml(node) ? "" : node.value.replace(/\r\n?/g, "\n");
    case "break":
      return "\n";
    case "image":
    case "imageReference":
    case "footnoteReference":
    case "definition":
      return "";
    default:
      if ("children" in node) {
        return (node.children as Nodes[]).map(mdastDisplayText).join("");
      }
      return "";
  }
}
