/**
 * Markdown document parsing: locates markers via the Markdown AST so that
 * marker-like text inside code (fenced/indented/inline) is never treated as
 * a marker. See DESIGN.md 5.2.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Html, Nodes } from "mdast";

import { MARKER_PREFIX, type MarkerError, type MarkerOccurrence, type ParsedDocument, type SourceRange } from "./types.js";
import { parseMarkerAt, parseMarkerJson } from "./marker.js";

/**
 * Parent node types whose children are phrasing (inline) content. An `html`
 * node found under one of these is an inline marker; otherwise it is
 * block-level (sits alone on its own line / own container line).
 */
const INLINE_PARENT_TYPES = new Set<string>([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "tableCell",
]);

interface HtmlNodeWithParent {
  node: Html;
  parent: Nodes | null;
}

function collectHtmlNodes(node: Nodes, parent: Nodes | null, out: HtmlNodeWithParent[]): void {
  if (node.type === "html") {
    out.push({ node, parent });
  }
  const children: unknown = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children as Nodes[]) {
      collectHtmlNodes(child, node, out);
    }
  }
}

function detectLineEnding(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/** Parses `source` into an AST-backed set of marker occurrences and errors. */
export function parseDocument(source: string): ParsedDocument {
  const hasBom = source.length > 0 && source.charCodeAt(0) === 0xfeff;
  const lineEnding = detectLineEnding(source);

  // micromark treats a leading U+FEFF as content and its offsets end up
  // shifted by one relative to the original (BOM-including) source, so we
  // parse the BOM-stripped text and add 1 back to every offset.
  const parseInput = hasBom ? source.slice(1) : source;
  const offsetShift = hasBom ? 1 : 0;

  const tree = fromMarkdown(parseInput, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const htmlNodes: HtmlNodeWithParent[] = [];
  collectHtmlNodes(tree, null, htmlNodes);

  const markers: MarkerOccurrence[] = [];
  const errors: MarkerError[] = [];
  const seenIds = new Map<string, MarkerOccurrence>();

  for (const { node, parent } of htmlNodes) {
    if (!node.value.startsWith(MARKER_PREFIX)) {
      continue;
    }
    const position = node.position;
    if (!position || position.start.offset === undefined || position.end.offset === undefined) {
      continue;
    }
    const start = position.start.offset + offsetShift;
    const blockLevel = parent === null || !INLINE_PARENT_TYPES.has(parent.type);

    const at = parseMarkerAt(source, start);
    if (!at.ok) {
      const end = position.end.offset + offsetShift;
      errors.push({ kind: "broken-marker", message: at.message, start, end });
      continue;
    }

    const parsed = parseMarkerJson(at.json);
    if (!parsed.ok) {
      errors.push({ kind: parsed.error, message: parsed.message, start, end: at.end });
      continue;
    }

    const occurrence: MarkerOccurrence = {
      comment: parsed.comment,
      start,
      end: at.end,
      raw: source.slice(start, at.end),
      blockLevel,
    };
    markers.push(occurrence);

    const existing = seenIds.get(parsed.comment.id);
    if (existing) {
      errors.push({
        kind: "duplicate-id",
        message: `duplicate comment id: ${parsed.comment.id}`,
        start,
        end: at.end,
        id: parsed.comment.id,
      });
    } else {
      seenIds.set(parsed.comment.id, occurrence);
    }
  }

  markers.sort((a, b) => a.start - b.start);
  errors.sort((a, b) => a.start - b.start);

  return { source, markers, errors, lineEnding, hasBom };
}

/** True when the document has any marker/format errors and should be read-only. */
export function isReadOnly(doc: ParsedDocument): boolean {
  return doc.errors.length > 0;
}

/** Maps comment id -> first occurrence in source order. */
export function markersById(doc: ParsedDocument): Map<string, MarkerOccurrence> {
  const map = new Map<string, MarkerOccurrence>();
  for (const occ of doc.markers) {
    if (!map.has(occ.comment.id)) {
      map.set(occ.comment.id, occ);
    }
  }
  return map;
}

/**
 * Range to delete from `text` to remove a marker at [start, end).
 * Inline markers delete exactly the marker text. Block-level markers undo
 * what placement inserted: the marker, its line ending, and the continuation
 * prefix of the following line. When the marker line carries a list bullet
 * (`- <!-- ... -->` + newline + indented content) only the marker, the line
 * ending and the indentation are removed so the bullet stays with the content.
 * See DESIGN.md 5.2/5.4.
 */
export function removalRange(text: string, start: number, end: number, blockLevel: boolean): SourceRange {
  if (!blockLevel) return { start, end };

  const docStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const prevNl = text.lastIndexOf("\n", start - 1);
  const lineStart = prevNl === -1 ? docStart : prevNl + 1;
  const linePrefix = text.slice(lineStart, start);

  let i = end;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  let eolEnd = -1;
  if (text.startsWith("\r\n", i)) eolEnd = i + 2;
  else if (text[i] === "\n") eolEnd = i + 1;

  if (eolEnd === -1 && i < text.length) {
    // Other content follows the marker on the same line: only remove the marker itself.
    return { start, end };
  }

  if (eolEnd === -1) {
    // Last line, no trailing newline: also consume the preceding line ending.
    if (lineStart > docStart && prevNl !== -1) {
      let sepStart = prevNl;
      if (sepStart > docStart && text[sepStart - 1] === "\r") sepStart -= 1;
      return { start: sepStart, end: text.length };
    }
    return { start: lineStart, end: text.length };
  }

  const contPrefix = linePrefix.replace(/[^>\t]/g, " ");
  if (contPrefix !== linePrefix) {
    // Bullet / ordered-list marker line: keep the bullet, drop marker + EOL + indentation.
    const keep = text.startsWith(contPrefix, eolEnd) ? contPrefix.length : 0;
    return { start, end: eolEnd + keep };
  }
  return { start: lineStart, end: eolEnd };
}

export function removeMarkerRange(source: string, occ: MarkerOccurrence): SourceRange {
  return removalRange(source, occ.start, occ.end, occ.blockLevel);
}
