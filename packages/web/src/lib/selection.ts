/**
 * DOM selection -> Markdown source offsets (DESIGN.md 6).
 *
 * The renderer emits one `<span data-s data-e [data-atomic]>` per TextRun, so a
 * selection point only needs the nearest ancestor span plus the number of
 * display code units before the point inside that span. Atomic spans (entities,
 * escapes, line endings) map wholly to `data-s` / `data-e`.
 *
 * The functions take a structural `DomNodeLike` so they can be tested without a
 * DOM implementation; `asDomNode` adapts a real `Node`.
 */

export interface DomNodeLike {
  nodeType: number;
  parentNode: DomNodeLike | null;
  childNodes: ArrayLike<DomNodeLike>;
  nodeValue: string | null;
  getAttribute?: ((name: string) => string | null) | undefined;
}

export const NODE_ELEMENT = 1;
export const NODE_TEXT = 3;

export interface SourceRange {
  start: number;
  end: number;
}

/** Source offsets a single selection point maps to, depending on which side it is. */
export interface PointOffsets {
  /** Offset to use when this point is the start of the range. */
  start: number;
  /** Offset to use when this point is the end of the range. */
  end: number;
}

export function asDomNode(node: unknown): DomNodeLike {
  return node as DomNodeLike;
}

function attr(node: DomNodeLike, name: string): string | null {
  if (node.nodeType !== NODE_ELEMENT) return null;
  const get = node.getAttribute;
  if (typeof get !== "function") return null;
  return get.call(node, name);
}

/** Nearest self-or-ancestor element carrying `data-s`. */
export function nearestRunSpan(node: DomNodeLike | null): DomNodeLike | null {
  let current: DomNodeLike | null = node;
  while (current) {
    if (attr(current, "data-s") !== null) return current;
    current = current.parentNode;
  }
  return null;
}

function textLength(node: DomNodeLike): number {
  if (node.nodeType === NODE_TEXT) return (node.nodeValue ?? "").length;
  let total = 0;
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child) total += textLength(child);
  }
  return total;
}

function childPrefixLength(node: DomNodeLike, childIndex: number): number {
  let total = 0;
  const limit = Math.min(childIndex, node.childNodes.length);
  for (let i = 0; i < limit; i++) {
    const child = node.childNodes[i];
    if (child) total += textLength(child);
  }
  return total;
}

/**
 * Number of display code units inside `span` before the point (`node`,`offset`).
 * Returns null when the point is not inside the span.
 */
export function offsetWithinSpan(
  span: DomNodeLike,
  node: DomNodeLike,
  offset: number,
): number | null {
  let accumulated = 0;
  let found = false;

  const walk = (current: DomNodeLike): void => {
    if (found) return;
    if (current === node) {
      accumulated +=
        current.nodeType === NODE_TEXT
          ? Math.max(0, Math.min(offset, (current.nodeValue ?? "").length))
          : childPrefixLength(current, offset);
      found = true;
      return;
    }
    if (current.nodeType === NODE_TEXT) {
      accumulated += (current.nodeValue ?? "").length;
      return;
    }
    for (let i = 0; i < current.childNodes.length; i++) {
      const child = current.childNodes[i];
      if (child) walk(child);
      if (found) return;
    }
  };

  walk(span);
  return found ? accumulated : null;
}

/** Map one selection point to the source offsets usable at each side of a range. */
export function pointToSourceOffsets(node: DomNodeLike, offset: number): PointOffsets | null {
  const span = nearestRunSpan(node);
  if (!span) return null;

  const rawStart = attr(span, "data-s");
  const rawEnd = attr(span, "data-e");
  const spanStart = rawStart === null ? Number.NaN : Number(rawStart);
  if (!Number.isFinite(spanStart)) return null;
  const spanEnd = rawEnd === null ? Number.NaN : Number(rawEnd);

  if (attr(span, "data-atomic") === "1") {
    return { start: spanStart, end: Number.isFinite(spanEnd) ? spanEnd : spanStart };
  }

  const within = offsetWithinSpan(span, node, offset);
  if (within === null) return null;
  let value = spanStart + within;
  if (Number.isFinite(spanEnd) && value > spanEnd) value = spanEnd;
  return { start: value, end: value };
}

/**
 * Normalise anchor/focus (either direction) into a source range.
 * Returns null when the selection is collapsed or lands outside the rendered
 * document.
 */
export function selectionToSourceRange(
  anchorNode: DomNodeLike | null,
  anchorOffset: number,
  focusNode: DomNodeLike | null,
  focusOffset: number,
): SourceRange | null {
  if (!anchorNode || !focusNode) return null;
  const anchor = pointToSourceOffsets(anchorNode, anchorOffset);
  const focus = pointToSourceOffsets(focusNode, focusOffset);
  if (!anchor || !focus) return null;

  const forward = anchor.start <= focus.start;
  const start = forward ? anchor.start : focus.start;
  const end = forward ? focus.end : anchor.end;
  if (!(end > start)) return null;
  return { start, end };
}
