/**
 * Marker placement rules (DESIGN.md section 5.2) and selection preparation.
 */
import type { Nodes, Parent } from "mdast";
import {
  blockAt,
  displayIndexAt,
  displayIndexEnd,
  headCodePoints,
  sourceOffsetAt,
  tailCodePoints,
  type LeafBlock,
  type TextMap,
} from "./textmap.js";
import { CONTEXT_MAX_CODE_POINTS, type SourceRange } from "./types.js";

export interface Placement {
  placement: "inline" | "block";
  /** Source offset at which the marker text is inserted. */
  insertAt: number;
  /** Text appended after the marker (block placement: line ending + container prefix). */
  after: string;
  /** Flow-level block the marker is attached to. */
  flowType: string;
  flowRange: SourceRange;
  /** Why an inline placement was not possible. */
  reason?: string;
}

export type SelectionFailure =
  | "no-block"
  | "multi-block"
  | "empty-selection"
  | "front-matter";

export interface PreparedSelection {
  ok: true;
  block: LeafBlock;
  anchor: string;
  prefix: string;
  suffix: string;
  /** Source offset of the first selected display unit (before placement adjustment). */
  sourceOffset: number;
  placement: Placement;
  blockOnly: boolean;
}

export type PrepareResult = PreparedSelection | { ok: false; reason: SelectionFailure };

interface InlineNode {
  node: Nodes;
  start: number;
  end: number;
  depth: number;
}

function absRange(tm: TextMap, node: Nodes): SourceRange | null {
  const p = node.position;
  if (!p || p.start.offset === undefined || p.end.offset === undefined) return null;
  return { start: p.start.offset + tm.bodyStart, end: p.end.offset + tm.bodyStart };
}

function collectInlineNodes(tm: TextMap, root: Nodes): InlineNode[] {
  const out: InlineNode[] = [];
  const visit = (n: Nodes, depth: number): void => {
    if (n !== root && n.type !== "text") {
      const r = absRange(tm, n);
      if (r) out.push({ node: n, start: r.start, end: r.end, depth });
    }
    if ("children" in n) {
      for (const c of (n as Parent).children) visit(c as Nodes, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function isTaskItemParagraph(block: LeafBlock): boolean {
  const parent = block.ancestors[block.ancestors.length - 1] as Nodes | undefined;
  return !!parent && parent.type === "listItem" && parent.checked != null;
}

/** True when the offset sits at the start of a line's content (after container prefixes). */
export function isAtLineContentStart(tm: TextMap, block: LeafBlock, offset: number): boolean {
  if (offset === block.range.start) {
    // A task list paragraph starts after `[ ] `, so its start is not the line start.
    if (isTaskItemParagraph(block)) return false;
    return true;
  }
  const src = tm.source;
  let i = offset;
  while (i > block.range.start) {
    const c = src[i - 1];
    if (c === " " || c === "\t" || c === ">") {
      i--;
      continue;
    }
    return c === "\n";
  }
  return true;
}

function lineStartOf(source: string, offset: number): number {
  const i = source.lastIndexOf("\n", offset - 1);
  return i < 0 ? 0 : i + 1;
}

/** Prefix a continuation line needs to stay inside the containers of a block starting at `start`. */
export function continuationPrefix(tm: TextMap, block: LeafBlock, flowStart: number): string {
  const src = tm.source;
  let raw = src.slice(lineStartOf(src, flowStart), flowStart);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (isTaskItemParagraph(block)) raw = raw.replace(/\[[ xX]\][ \t]+$/, "");
  return raw.replace(/[^>\t]/g, " ");
}

/**
 * Decide where a marker for a selection starting at `offset` goes.
 * Implements: inline before the selection unless at line start / inside
 * non-text inline syntax / in a non-paragraph block, else before the flow block
 * with the container prefix inherited.
 */
export function computePlacement(tm: TextMap, block: LeafBlock, offset: number): Placement {
  const flowRange = block.flowRange;
  const blockPlacement = (reason: string): Placement => ({
    placement: "block",
    insertAt: flowRange.start,
    after: tm.lineEnding + continuationPrefix(tm, block, flowRange.start),
    flowType: block.flowType,
    flowRange,
    reason,
  });

  if (block.type !== "paragraph") return blockPlacement(`block type ${block.type}`);

  let cur = offset;
  const inlineNodes = collectInlineNodes(tm, block.node);
  // Move before opening delimiters when the offset is the first display unit of an inline node.
  for (let guard = 0; guard < 32; guard++) {
    const containing = inlineNodes.filter((n) => n.start < cur && cur < n.end);
    if (containing.length === 0) break;
    const deepest = containing.reduce((a, b) => (b.depth > a.depth ? b : a));
    const firstUnit = block.units.find((u) => u.src >= deepest.start && u.src < deepest.end);
    if (!firstUnit || firstUnit.src >= cur) {
      cur = deepest.start;
      continue;
    }
    const t = deepest.node.type;
    if (t === "inlineCode" || t === "html" || t === "image" || t === "imageReference" || t === "footnoteReference") {
      return blockPlacement(`inside ${t}`);
    }
    const unit = block.units.find((u) => u.src === cur) ?? block.units.find((u) => u.src >= cur);
    if (unit && (unit.kind === "autolink" || unit.kind === "code" || unit.kind === "html")) {
      return blockPlacement(`inside ${unit.kind}`);
    }
    break;
  }

  if (isAtLineContentStart(tm, block, cur)) return blockPlacement("line start");
  return {
    placement: "inline",
    insertAt: cur,
    after: "",
    flowType: block.flowType,
    flowRange,
  };
}

/** Apply a placement: returns the new source with `marker` inserted. */
export function insertMarker(source: string, placement: Placement, marker: string): string {
  return source.slice(0, placement.insertAt) + marker + placement.after + source.slice(placement.insertAt);
}

/** Validate a selection (source offsets) and compute anchor/context/placement. */
export function prepareSelection(tm: TextMap, sel: SourceRange): PrepareResult {
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  if (tm.frontMatter && start < tm.frontMatter.end) return { ok: false, reason: "front-matter" };
  const b1 = blockAt(tm, start, true);
  if (!b1) return { ok: false, reason: "no-block" };
  const b2 = blockAt(tm, end, true);
  if (!b2) return { ok: false, reason: "no-block" };
  if (b1 !== b2) {
    // Allow the end to sit exactly at the start of the next block's range only if nothing selected there.
    return { ok: false, reason: "multi-block" };
  }
  const i = displayIndexAt(b1, start);
  const j = Math.max(i, displayIndexEnd(b1, end));
  const anchor = b1.displayText.slice(i, j);
  if (anchor.length === 0) return { ok: false, reason: "empty-selection" };
  const prefix = tailCodePoints(b1.displayText.slice(0, i), CONTEXT_MAX_CODE_POINTS);
  const suffix = headCodePoints(b1.displayText.slice(j), CONTEXT_MAX_CODE_POINTS);
  const sourceOffset = sourceOffsetAt(b1, i);
  const placement = computePlacement(tm, b1, sourceOffset);
  return {
    ok: true,
    block: b1,
    anchor,
    prefix,
    suffix,
    sourceOffset,
    placement,
    blockOnly: placement.placement === "block",
  };
}

export interface AnchorMatch {
  block: LeafBlock;
  /** Display index of the anchor start within the block. */
  displayIndex: number;
  sourceOffset: number;
}

/** Find every place where prefix+anchor+suffix occurs in the display text. */
export function findAnchor(tm: TextMap, prefix: string, anchor: string, suffix: string): AnchorMatch[] {
  const needle = prefix + anchor + suffix;
  const out: AnchorMatch[] = [];
  if (anchor.length === 0) return out;
  for (const block of tm.blocks) {
    const text = block.displayText;
    let from = 0;
    while (from <= text.length) {
      const k = text.indexOf(needle, from);
      if (k < 0) break;
      const displayIndex = k + prefix.length;
      out.push({ block, displayIndex, sourceOffset: sourceOffsetAt(block, displayIndex) });
      from = k + 1;
    }
  }
  return out;
}
